"""Unit tests for ``app.channels.telegram_session_tracker``.

Covers session-id minting, timer reset, idle-firing, failure isolation,
and the in-module review-notification publish path (both LoginUrl and
plain-token fallback). Notification publishing is asserted at the
``publish_review_notification`` boundary because the tracker now owns
the URL construction directly.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.channels import message_bus
from app.channels import telegram_session_tracker as tracker
from deerflow.sophia.session_store import SessionStore


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    fresh_store = SessionStore(base_path=tmp_path)
    monkeypatch.setattr(tracker, "_store", fresh_store)
    tracker.reset_watcher()
    yield
    tracker.reset_watcher()


@pytest.fixture(autouse=True)
def _reset_telegram_link_store():
    from app.gateway import telegram_link_store

    telegram_link_store.clear_all()
    yield
    telegram_link_store.clear_all()


class TestRegisterActivity:
    def test_first_call_mints_session_id(self):
        sid = tracker.register_activity(
            chat_id="100", user_id="user-1", thread_id="thread-1"
        )
        assert sid
        assert tracker.get_session_id("100") == sid
        assert tracker.get_active_chat_count() == 1

    def test_second_call_within_window_reuses_session_id(self):
        sid1 = tracker.register_activity(
            chat_id="100", user_id="user-1", thread_id="thread-1"
        )
        sid2 = tracker.register_activity(
            chat_id="100", user_id="user-1", thread_id="thread-1"
        )
        assert sid1 == sid2
        assert tracker.get_active_chat_count() == 1

    def test_rebind_to_different_user_mints_new_session_id(self):
        """If the same chat is reused under a different canonical user
        (e.g. /start with a different webapp account), the tracker must
        mint a fresh session — old user data must not bleed into the new
        user's trace."""
        sid_a = tracker.register_activity(
            chat_id="100", user_id="user-a", thread_id="thread-1"
        )
        sid_b = tracker.register_activity(
            chat_id="100", user_id="user-b", thread_id="thread-1"
        )
        assert sid_a != sid_b
        assert tracker.get_session_id("100") == sid_b

    def test_concurrent_chats_independent(self):
        a = tracker.register_activity(chat_id="100", user_id="u1", thread_id="t1")
        b = tracker.register_activity(chat_id="200", user_id="u2", thread_id="t2")
        assert a != b
        assert tracker.get_active_chat_count() == 2

    def test_missing_inputs_are_noop(self):
        assert tracker.register_activity("", "u", "t") == ""
        assert tracker.register_activity("c", "", "t") == ""
        assert tracker.register_activity("c", "u", "") == ""
        assert tracker.get_active_chat_count() == 0

    def test_session_record_is_persisted_on_first_activity(self):
        sid = tracker.register_activity(
            chat_id="100", user_id="user-1", thread_id="thread-1"
        )
        record = tracker._store.get("user-1", sid)
        assert record is not None
        assert record.thread_id == "thread-1"
        assert record.status == "open"


class TestUnregister:
    def test_unregister_removes_from_active(self):
        tracker.register_activity(chat_id="100", user_id="u", thread_id="t")
        assert tracker.get_active_chat_count() == 1
        tracker.unregister_chat("100")
        assert tracker.get_active_chat_count() == 0


@pytest.mark.anyio
class TestEnqueueReviewNotification:
    async def test_disabled_by_feature_flag(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", "false")
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        spy = AsyncMock()
        monkeypatch.setattr(tracker, "publish_review_notification", spy)

        ok = await tracker.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False
        spy.assert_not_awaited()

    async def test_skips_when_base_url_unset(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_WEB_BASE_URL", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        spy = AsyncMock()
        monkeypatch.setattr(tracker, "publish_review_notification", spy)

        ok = await tracker.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False
        spy.assert_not_awaited()

    async def test_login_url_payload_shape(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)
        spy = AsyncMock()
        monkeypatch.setattr(tracker, "publish_review_notification", spy)

        ok = await tracker.enqueue_review_notification("100", "user-1", "sess-abc")
        assert ok is True
        spy.assert_awaited_once()
        (payload,) = spy.call_args.args
        assert payload["channel"] == "telegram"
        assert payload["chat_id"] == "100"
        assert payload["user_id"] == "user-1"
        assert payload["session_id"] == "sess-abc"
        assert payload["use_login_url"] is True
        assert payload["review_url"] == (
            "https://app.example.com/api/auth/telegram-login?session=sess-abc"
        )

    async def test_handles_trailing_slash_on_base(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com/")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)
        spy = AsyncMock()
        monkeypatch.setattr(tracker, "publish_review_notification", spy)

        await tracker.enqueue_review_notification("100", "user-1", "sess-abc")
        (payload,) = spy.call_args.args
        assert "//api" not in payload["review_url"].replace("https://", "")

    async def test_swallows_publish_exception(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        spy = AsyncMock(side_effect=RuntimeError("bus down"))
        monkeypatch.setattr(tracker, "publish_review_notification", spy)

        ok = await tracker.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False

    async def test_invalid_chat_or_session_returns_false(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        spy = AsyncMock()
        monkeypatch.setattr(tracker, "publish_review_notification", spy)

        assert (
            await tracker.enqueue_review_notification("", "user-1", "sess-1") is False
        )
        assert (
            await tracker.enqueue_review_notification("100", "user-1", "") is False
        )
        spy.assert_not_awaited()

    async def test_payload_reaches_real_bus_subscriber(self, monkeypatch):
        """Integration: end-to-end across the real bus."""
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)

        bus = message_bus.MessageBus()
        message_bus.set_global_bus(bus)
        try:
            received: list[dict] = []

            async def listener(payload):
                received.append(payload)

            bus.subscribe_review_notification(listener)
            ok = await tracker.enqueue_review_notification(
                "100", "user-1", "sess-abc"
            )
            assert ok is True
            assert len(received) == 1
            assert received[0]["session_id"] == "sess-abc"
            assert received[0]["use_login_url"] is True
        finally:
            message_bus.set_global_bus(None)


@pytest.mark.anyio
class TestInactivityFiring:
    async def test_idle_chat_fires_pipeline(self, monkeypatch):
        called: dict = {}

        def fake_pipeline(user_id, session_id, thread_id, thread_state):
            called["user_id"] = user_id
            called["session_id"] = session_id
            called["thread_id"] = thread_id

        # Suppress the publish so this test only asserts the pipeline call.
        monkeypatch.setattr(tracker, "publish_review_notification", AsyncMock())

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            sid = tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        assert called == {
            "user_id": "user-1",
            "session_id": sid,
            "thread_id": "thread-1",
        }
        assert tracker.get_active_chat_count() == 0

    async def test_active_chat_does_not_fire(self, monkeypatch):
        calls: list = []

        def fake_pipeline(*a, **kw):
            calls.append(a)

        monkeypatch.setattr(tracker, "publish_review_notification", AsyncMock())

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            await tracker._check_inactive_chats()

        assert calls == []
        assert tracker.get_active_chat_count() == 1

    async def test_pipeline_failure_does_not_block_cleanup(self, monkeypatch):
        def boom(*a, **kw):
            raise RuntimeError("pipeline broken")

        monkeypatch.setattr(tracker, "publish_review_notification", AsyncMock())

        with patch("deerflow.sophia.offline_pipeline.run_offline_pipeline", boom):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        assert tracker.get_active_chat_count() == 0

    async def test_notify_runs_after_pipeline(self, monkeypatch):
        order: list[str] = []

        def fake_pipeline(*a, **kw):
            order.append("pipeline")

        async def fake_publish(payload):
            order.append("notify")

        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)
        monkeypatch.setattr(tracker, "publish_review_notification", fake_publish)

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        assert order == ["pipeline", "notify"]

    async def test_notify_failure_is_swallowed(self, monkeypatch):
        async def boom(payload):
            raise RuntimeError("bus down")

        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.setattr(tracker, "publish_review_notification", boom)

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline",
            lambda *a, **kw: None,
        ):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        assert tracker.get_active_chat_count() == 0
