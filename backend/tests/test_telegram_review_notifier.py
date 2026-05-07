"""Unit tests for ``app.channels.telegram_review_notifier``.

The notifier orchestrates: feature-flag gating, env-driven URL
construction, LoginUrl vs plain-token fallback, and error swallowing.
After the post-Sentrux refactor it publishes payloads to the
process-wide ``MessageBus`` rather than calling the channel directly,
so the tests assert against ``publish_review_notification``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.channels import telegram_review_notifier as notifier
from app.channels import message_bus


@pytest.fixture
def fake_publish(monkeypatch):
    """Replace ``publish_review_notification`` (used inside the notifier)
    with an AsyncMock and return it. Patching at the call site
    ``app.channels.telegram_review_notifier.publish_review_notification``
    catches the import binding the notifier module made at load time.
    """
    spy = AsyncMock()
    monkeypatch.setattr(
        "app.channels.telegram_review_notifier.publish_review_notification",
        spy,
    )
    return spy


@pytest.fixture(autouse=True)
def _reset_telegram_link_store():
    from app.gateway import telegram_link_store

    telegram_link_store.clear_all()
    yield
    telegram_link_store.clear_all()


@pytest.mark.anyio
class TestEnqueueReviewNotification:
    async def test_disabled_by_feature_flag(self, monkeypatch, fake_publish):
        monkeypatch.setenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", "false")
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False
        fake_publish.assert_not_awaited()

    async def test_skips_when_base_url_unset(self, monkeypatch, fake_publish):
        monkeypatch.delenv("SOPHIA_WEB_BASE_URL", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False
        fake_publish.assert_not_awaited()

    async def test_login_url_payload_shape(self, monkeypatch, fake_publish):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-abc")
        assert ok is True
        fake_publish.assert_awaited_once()

        (payload,) = fake_publish.call_args.args
        assert payload["channel"] == "telegram"
        assert payload["chat_id"] == "100"
        assert payload["user_id"] == "user-1"
        assert payload["session_id"] == "sess-abc"
        assert payload["use_login_url"] is True
        assert payload["review_url"] == (
            "https://app.example.com/api/auth/telegram-login?session=sess-abc"
        )

    async def test_handles_trailing_slash_on_base(self, monkeypatch, fake_publish):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com/")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)

        await notifier.enqueue_review_notification("100", "user-1", "sess-abc")

        (payload,) = fake_publish.call_args.args
        assert "//api" not in payload["review_url"].replace("https://", "")

    async def test_fallback_path_mints_token_and_uses_plain_url(
        self, monkeypatch, fake_publish
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.setenv("TELEGRAM_REVIEW_USE_LOGIN_URL", "false")

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-abc")
        assert ok is True

        (payload,) = fake_publish.call_args.args
        assert payload["use_login_url"] is False
        assert "/api/auth/telegram-token?" in payload["review_url"]
        assert "token=" in payload["review_url"]
        assert "session=sess-abc" in payload["review_url"]

    async def test_fallback_path_skips_on_invalid_user_id(
        self, monkeypatch, fake_publish
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.setenv("TELEGRAM_REVIEW_USE_LOGIN_URL", "false")

        ok = await notifier.enqueue_review_notification("100", "user..bad", "sess-1")
        assert ok is False
        fake_publish.assert_not_awaited()

    async def test_swallows_publish_exception(self, monkeypatch, fake_publish):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        fake_publish.side_effect = RuntimeError("bus down")

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False

    async def test_invalid_chat_or_session_returns_false(
        self, monkeypatch, fake_publish
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")

        assert (
            await notifier.enqueue_review_notification("", "user-1", "sess-1") is False
        )
        assert (
            await notifier.enqueue_review_notification("100", "user-1", "") is False
        )
        fake_publish.assert_not_awaited()


@pytest.mark.anyio
class TestEndToEndOnLocalBus:
    """Integration: notifier publishes onto a real ``MessageBus`` and a
    subscriber receives the payload. Catches any drift between the
    publisher's payload shape and the subscriber-side keys.
    """

    async def test_payload_reaches_subscriber(self, monkeypatch):
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
            ok = await notifier.enqueue_review_notification(
                "100", "user-1", "sess-abc"
            )
            assert ok is True
            assert len(received) == 1
            assert received[0]["channel"] == "telegram"
            assert received[0]["session_id"] == "sess-abc"
            assert received[0]["use_login_url"] is True
        finally:
            message_bus.set_global_bus(None)

    async def test_no_op_when_no_global_bus_is_installed(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        message_bus.set_global_bus(None)

        # No bus installed → publish_review_notification logs and returns
        # silently. Notifier still reports success because the publish
        # call did not raise (matches the builder_completion semantics).
        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-abc")
        assert ok is True
