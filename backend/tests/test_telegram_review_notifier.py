"""Unit tests for ``app.channels.telegram_review_notifier``.

The notifier orchestrates: feature-flag gating, env-driven URL
construction, channel resolution, LoginUrl vs plain-token fallback, and
error swallowing. We mock the channel and verify the right shape of
arguments hits ``TelegramChannel.send_review_notification``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.channels import telegram_review_notifier as notifier


@pytest.fixture
def fake_telegram_channel():
    channel = MagicMock()
    channel.send_review_notification = AsyncMock(return_value=True)
    return channel


@pytest.fixture
def fake_service(fake_telegram_channel, monkeypatch):
    service = MagicMock()
    service.get_channel = MagicMock(
        side_effect=lambda name: fake_telegram_channel if name == "telegram" else None
    )
    monkeypatch.setattr(
        "app.channels.service.get_channel_service", lambda: service
    )
    return service


@pytest.fixture(autouse=True)
def _reset_telegram_link_store():
    """The fallback path issues a token in-memory; clear between tests."""
    from app.gateway import telegram_link_store

    telegram_link_store.clear_all()
    yield
    telegram_link_store.clear_all()


@pytest.mark.anyio
class TestEnqueueReviewNotification:
    async def test_disabled_by_feature_flag(self, monkeypatch, fake_service):
        monkeypatch.setenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", "false")
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False
        # Channel was never invoked.
        fake_service.get_channel.assert_not_called()

    async def test_skips_when_base_url_unset(self, monkeypatch, fake_service):
        monkeypatch.delenv("SOPHIA_WEB_BASE_URL", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False

    async def test_skips_when_channel_service_unavailable(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.setattr(
            "app.channels.service.get_channel_service", lambda: None
        )

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False

    async def test_skips_when_no_telegram_channel(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        service = MagicMock()
        service.get_channel = MagicMock(return_value=None)
        monkeypatch.setattr(
            "app.channels.service.get_channel_service", lambda: service
        )

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False

    async def test_login_url_path_builds_correct_url(
        self, monkeypatch, fake_service, fake_telegram_channel
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-abc")
        assert ok is True

        fake_telegram_channel.send_review_notification.assert_awaited_once()
        kwargs = fake_telegram_channel.send_review_notification.call_args.kwargs
        assert kwargs["chat_id"] == "100"
        assert kwargs["session_id"] == "sess-abc"
        assert kwargs["use_login_url"] is True
        assert kwargs["review_url"] == (
            "https://app.example.com/api/auth/telegram-login?session=sess-abc"
        )

    async def test_login_url_handles_trailing_slash_on_base(
        self, monkeypatch, fake_service, fake_telegram_channel
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com/")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.delenv("TELEGRAM_REVIEW_USE_LOGIN_URL", raising=False)

        await notifier.enqueue_review_notification("100", "user-1", "sess-abc")

        kwargs = fake_telegram_channel.send_review_notification.call_args.kwargs
        # No double slash before /api/...
        assert "//api" not in kwargs["review_url"].replace("https://", "")

    async def test_fallback_path_mints_token_and_uses_plain_url(
        self, monkeypatch, fake_service, fake_telegram_channel
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.delenv("TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED", raising=False)
        monkeypatch.setenv("TELEGRAM_REVIEW_USE_LOGIN_URL", "false")

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-abc")
        assert ok is True

        kwargs = fake_telegram_channel.send_review_notification.call_args.kwargs
        assert kwargs["use_login_url"] is False
        # URL contains both ``token=`` and ``session=`` params, in that order
        # (urlencode preserves dict insertion order under py3.7+).
        assert "/api/auth/telegram-token?" in kwargs["review_url"]
        assert "token=" in kwargs["review_url"]
        assert "session=sess-abc" in kwargs["review_url"]

    async def test_fallback_path_skips_on_invalid_user_id(
        self, monkeypatch, fake_service, fake_telegram_channel
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        monkeypatch.setenv("TELEGRAM_REVIEW_USE_LOGIN_URL", "false")

        ok = await notifier.enqueue_review_notification("100", "user..bad", "sess-1")
        assert ok is False
        fake_telegram_channel.send_review_notification.assert_not_awaited()

    async def test_swallows_send_exception(
        self, monkeypatch, fake_service, fake_telegram_channel
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")
        fake_telegram_channel.send_review_notification = AsyncMock(
            side_effect=RuntimeError("transport down")
        )

        ok = await notifier.enqueue_review_notification("100", "user-1", "sess-1")
        assert ok is False

    async def test_invalid_chat_or_session_returns_false(
        self, monkeypatch, fake_service, fake_telegram_channel
    ):
        monkeypatch.setenv("SOPHIA_WEB_BASE_URL", "https://app.example.com")

        assert (
            await notifier.enqueue_review_notification("", "user-1", "sess-1") is False
        )
        assert (
            await notifier.enqueue_review_notification("100", "user-1", "") is False
        )
        fake_telegram_channel.send_review_notification.assert_not_awaited()
