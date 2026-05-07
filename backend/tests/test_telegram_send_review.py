"""Unit tests for ``TelegramChannel.send_review_notification``.

Covers the bot-side message construction (LoginUrl button vs plain URL,
text truncation, error swallowing) without spinning up a real polling
loop. ``_run_bot_call_on_telegram_loop`` falls through to ``await coro``
when ``_tg_loop`` is unset, which is what we exploit here.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.channels.message_bus import MessageBus
from app.channels.telegram import TelegramChannel, _TELEGRAM_TEXT_LIMIT


@pytest.fixture
def channel() -> TelegramChannel:
    bus = MessageBus()
    ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
    return ch


def _attach_fake_application(ch: TelegramChannel) -> AsyncMock:
    """Wire a mock bot into the channel without starting polling.

    Returns the mock ``bot.send_message`` so tests can assert call args.
    The mock returns a SimpleNamespace with ``message_id`` so the channel's
    own bookkeeping (``_last_bot_message``) doesn't choke.
    """
    bot = MagicMock()
    bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=999))
    ch._application = SimpleNamespace(bot=bot)
    # _tg_loop must be truthy for the early-return guard, but we want
    # _run_bot_call_on_telegram_loop to fall through to ``await coro``
    # (no real loop). The helper uses ``loop.is_running()`` to decide;
    # a stub whose is_running() returns False satisfies both checks.
    fake_loop = MagicMock()
    fake_loop.is_running = MagicMock(return_value=False)
    ch._tg_loop = fake_loop
    return bot.send_message


@pytest.mark.anyio
class TestSendReviewNotification:
    async def test_returns_false_when_no_application(self, channel):
        # No _attach_fake_application; channel.start was never called.
        ok = await channel.send_review_notification(
            chat_id="100",
            session_id="sess-abc",
            review_url="https://app.example.com/api/auth/telegram-login?session=sess-abc",
        )
        assert ok is False

    async def test_login_url_path_uses_login_url_button(self, channel):
        send = _attach_fake_application(channel)

        ok = await channel.send_review_notification(
            chat_id="100",
            session_id="sess-abc",
            review_url="https://app.example.com/api/auth/telegram-login?session=sess-abc",
            use_login_url=True,
        )
        assert ok is True

        send.assert_awaited_once()
        kwargs = send.call_args.kwargs
        assert kwargs["chat_id"] == 100
        assert "Your memories" in kwargs["text"]
        keyboard = kwargs["reply_markup"]
        # InlineKeyboardMarkup.inline_keyboard is a tuple of rows.
        rows = keyboard.inline_keyboard
        assert len(rows) == 1 and len(rows[0]) == 1
        button = rows[0][0]
        assert button.login_url is not None
        assert button.login_url.url == (
            "https://app.example.com/api/auth/telegram-login?session=sess-abc"
        )
        # Plain url field must NOT be set when login_url is used.
        assert button.url is None

    async def test_plain_url_path_uses_url_button(self, channel):
        send = _attach_fake_application(channel)

        ok = await channel.send_review_notification(
            chat_id="100",
            session_id="sess-abc",
            review_url="https://app.example.com/api/auth/telegram-token?token=t&session=sess-abc",
            use_login_url=False,
        )
        assert ok is True

        button = send.call_args.kwargs["reply_markup"].inline_keyboard[0][0]
        assert button.url == (
            "https://app.example.com/api/auth/telegram-token?token=t&session=sess-abc"
        )
        assert button.login_url is None

    async def test_truncates_text_to_telegram_limit(self, channel):
        send = _attach_fake_application(channel)
        oversized = "x" * (_TELEGRAM_TEXT_LIMIT + 50)

        ok = await channel.send_review_notification(
            chat_id="100",
            session_id="s",
            review_url="https://app.example.com/x",
            text=oversized,
        )
        assert ok is True

        sent_text = send.call_args.kwargs["text"]
        assert len(sent_text) <= _TELEGRAM_TEXT_LIMIT
        assert sent_text.endswith("…")

    async def test_invalid_chat_id_returns_false(self, channel):
        _attach_fake_application(channel)

        ok = await channel.send_review_notification(
            chat_id="not-an-int",
            session_id="s",
            review_url="https://app.example.com/x",
        )
        assert ok is False

    async def test_send_exception_returns_false(self, channel):
        send = _attach_fake_application(channel)
        send.side_effect = RuntimeError("transport down")

        ok = await channel.send_review_notification(
            chat_id="100",
            session_id="s",
            review_url="https://app.example.com/x",
        )
        assert ok is False


@pytest.mark.anyio
class TestOnReviewNotification:
    """Bus-subscriber path: ``_on_review_notification`` filters non-Telegram
    payloads, validates required fields, and forwards to
    ``send_review_notification`` with the right kwargs.
    """

    async def test_telegram_payload_invokes_send(self, channel):
        send = _attach_fake_application(channel)

        await channel._on_review_notification(
            {
                "channel": "telegram",
                "chat_id": "100",
                "session_id": "sess-abc",
                "review_url": "https://app.example.com/api/auth/telegram-login?session=sess-abc",
                "use_login_url": True,
            }
        )

        send.assert_awaited_once()
        kwargs = send.call_args.kwargs
        assert kwargs["chat_id"] == 100
        # The button is the LoginUrl variant.
        button = kwargs["reply_markup"].inline_keyboard[0][0]
        assert button.login_url is not None

    async def test_non_telegram_payload_is_ignored(self, channel):
        send = _attach_fake_application(channel)

        await channel._on_review_notification(
            {"channel": "slack", "chat_id": "100", "session_id": "s", "review_url": "x"}
        )

        send.assert_not_awaited()

    async def test_missing_fields_are_logged_not_sent(self, channel):
        send = _attach_fake_application(channel)

        await channel._on_review_notification(
            {"channel": "telegram", "chat_id": "100"}  # missing session_id, review_url
        )

        send.assert_not_awaited()

    async def test_handler_swallows_send_exception(self, channel):
        send = _attach_fake_application(channel)
        send.side_effect = RuntimeError("transport down")

        # Must not raise — the bus must be able to keep dispatching to
        # other subscribers.
        await channel._on_review_notification(
            {
                "channel": "telegram",
                "chat_id": "100",
                "session_id": "s",
                "review_url": "https://x/y",
                "use_login_url": True,
            }
        )
