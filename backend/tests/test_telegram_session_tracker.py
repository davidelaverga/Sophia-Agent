"""Unit tests for ``app.channels.telegram_session_tracker``.

Mirrors ``tests/test_inactivity_watcher.py`` (if any) in spirit: cover
session-id minting, timer reset, idle-firing, failure isolation, and
notification dispatch.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from app.channels import telegram_session_tracker as tracker
from deerflow.sophia.session_store import SessionStore


@pytest.fixture(autouse=True)
def _reset(tmp_path, monkeypatch):
    # Redirect SessionStore writes to a temp dir so tests don't litter
    # ``users/`` in the repo root.
    fresh_store = SessionStore(base_path=tmp_path)
    monkeypatch.setattr(tracker, "_store", fresh_store)
    tracker.reset_watcher()
    yield
    tracker.reset_watcher()


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
        (e.g. the user re-ran /start with a different webapp account),
        the tracker must mint a fresh session — old user's data must
        not bleed into the new user's trace."""
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

    def test_session_record_is_persisted_on_first_activity(self, monkeypatch):
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
class TestInactivityFiring:
    async def test_idle_chat_fires_pipeline(self, monkeypatch):
        called: dict = {}

        def fake_pipeline(user_id, session_id, thread_id, thread_state):
            called["user_id"] = user_id
            called["session_id"] = session_id
            called["thread_id"] = thread_id

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            sid = tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            # Force the entry past the timeout window.
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        assert called == {
            "user_id": "user-1",
            "session_id": sid,
            "thread_id": "thread-1",
        }
        # Entry was popped after firing.
        assert tracker.get_active_chat_count() == 0

    async def test_active_chat_does_not_fire(self, monkeypatch):
        calls: list = []

        def fake_pipeline(*a, **kw):
            calls.append(a)

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            # Don't advance time; entry is fresh.
            await tracker._check_inactive_chats()

        assert calls == []
        assert tracker.get_active_chat_count() == 1

    async def test_pipeline_failure_does_not_block_cleanup(self, monkeypatch):
        def boom(*a, **kw):
            raise RuntimeError("pipeline broken")

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", boom
        ):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        # Even on pipeline error, the entry is popped and the session paused.
        assert tracker.get_active_chat_count() == 0

    async def test_notification_is_called_after_pipeline(self, monkeypatch):
        calls: list = []

        def fake_pipeline(*a, **kw):
            calls.append(("pipeline", a))

        def fake_enqueue(chat_id, user_id, session_id):
            calls.append(("notify", chat_id, user_id, session_id))

        # Dynamically inject a fake notifier module so the lazy import
        # inside _check_inactive_chats finds it.
        import sys
        import types

        fake_module = types.ModuleType("app.channels.telegram_review_notifier")
        fake_module.enqueue_review_notification = fake_enqueue
        monkeypatch.setitem(sys.modules, "app.channels.telegram_review_notifier", fake_module)

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            sid = tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        # Notification must run AFTER the pipeline.
        assert [c[0] for c in calls] == ["pipeline", "notify"]
        notify_call = calls[1]
        assert notify_call[1] == "100"
        assert notify_call[2] == "user-1"
        assert notify_call[3] == sid

    async def test_notification_failure_is_swallowed(self, monkeypatch):
        def fake_pipeline(*a, **kw):
            return None

        def boom(*a, **kw):
            raise RuntimeError("notifier broken")

        import sys
        import types

        fake_module = types.ModuleType("app.channels.telegram_review_notifier")
        fake_module.enqueue_review_notification = boom
        monkeypatch.setitem(sys.modules, "app.channels.telegram_review_notifier", fake_module)

        with patch(
            "deerflow.sophia.offline_pipeline.run_offline_pipeline", fake_pipeline
        ):
            tracker.register_activity(
                chat_id="100", user_id="user-1", thread_id="thread-1"
            )
            tracker._active_chats["100"]["last_active"] -= tracker.INACTIVITY_TIMEOUT + 1
            await tracker._check_inactive_chats()

        # Even if the notifier errors, cleanup completes.
        assert tracker.get_active_chat_count() == 0
