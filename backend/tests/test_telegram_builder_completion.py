"""Focused tests for the Telegram channel's builder-completion delivery.

Locks:
- Success events trigger ``send_document`` with the signed artifact URL +
  caption. The chat_id is reverse-looked-up from ``thread_id`` via the
  channel store.
- Error / timeout events send the apology copy + an inline keyboard with
  Try again / Dismiss buttons.
- Cancelled events send neutral copy without buttons.
- Clicking ``Try again`` translates into an InboundMessage with the
  retry prompt — Sophia's prompt then carries the original task brief
  via the memory-fix block, so the retry naturally re-runs the same task.
- Reverse lookup short-circuits when the thread doesn't belong to the
  Telegram channel.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.channels.message_bus import InboundMessageType, MessageBus
from app.channels.telegram import TelegramChannel


# ---- Fixtures --------------------------------------------------------------


@pytest.fixture
def fake_bus() -> MessageBus:
    return MessageBus()


@pytest.fixture
def channel(fake_bus: MessageBus) -> TelegramChannel:
    """Build a TelegramChannel without actually starting polling.

    The ``_tg_loop`` is bound inside each test function (which runs under
    pytest-anyio so a running loop exists) — see ``_bind_loop`` helper.
    """
    ch = TelegramChannel(bus=fake_bus, config={"bot_token": "test-token"})
    fake_bot = MagicMock()
    fake_bot.send_document = AsyncMock()
    fake_bot.send_message = AsyncMock(return_value=SimpleNamespace(message_id=123))
    fake_bot.send_document.return_value = SimpleNamespace(message_id=456)
    ch._application = MagicMock()
    ch._application.bot = fake_bot
    return ch


def _bind_loop(channel: TelegramChannel) -> None:
    """Bind ``_tg_loop`` to the currently running loop so cross-loop dispatch
    is a no-op. Must be called from inside an async test."""
    channel._tg_loop = asyncio.get_running_loop()


def _success_payload(thread_id: str = "thread-1", task_id: str = "task-1") -> dict:
    return {
        "thread_id": thread_id,
        "task_id": task_id,
        "status": "success",
        "agent_name": "sophia_builder",
        "task_type": "document",
        "task_brief": "Write a one-pager about climate change.",
        "artifact_url": "https://example.com/signed/file.md",
        "artifact_title": "Climate Change Brief",
        "artifact_filename": "climate_change_brief.md",
        "summary": "A focused one-page brief.",
    }


def _error_payload(thread_id: str = "thread-1", task_id: str = "task-2") -> dict:
    return {
        "thread_id": thread_id,
        "task_id": task_id,
        "status": "error",
        "agent_name": "sophia_builder",
        "task_brief": "Build a 5-slide investor deck.",
        "error_message": "Anthropic API error",
    }


def _cancelled_payload(thread_id: str = "thread-1", task_id: str = "task-3") -> dict:
    return {
        "thread_id": thread_id,
        "task_id": task_id,
        "status": "cancelled",
        "agent_name": "sophia_builder",
        "task_brief": "Generate a meeting agenda.",
    }


def _stub_store_lookup(channel: TelegramChannel, *, chat_id: str | None) -> None:
    """Stub the chat_id reverse lookup."""

    def _fake_find(thread_id: str) -> str | None:  # noqa: ARG001
        return chat_id

    channel._find_chat_id_for_thread = _fake_find  # type: ignore[assignment]


# ---- Tests -----------------------------------------------------------------


@pytest.mark.anyio
async def test_success_event_sends_document_with_signed_url(channel: TelegramChannel):
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="987654321")
    payload = _success_payload()
    await channel._on_builder_completion(payload)

    bot = channel._application.bot
    bot.send_document.assert_awaited_once()
    call_kwargs = bot.send_document.call_args.kwargs
    assert call_kwargs["chat_id"] == 987654321
    assert call_kwargs["document"] == payload["artifact_url"]
    assert "Climate Change Brief is ready" in call_kwargs["caption"]
    assert "focused one-page brief" in call_kwargs["caption"]
    bot.send_message.assert_not_awaited()


@pytest.mark.anyio
async def test_error_event_sends_text_with_retry_keyboard(channel: TelegramChannel):
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="111")
    payload = _error_payload()
    await channel._on_builder_completion(payload)

    bot = channel._application.bot
    bot.send_message.assert_awaited_once()
    call_kwargs = bot.send_message.call_args.kwargs
    assert call_kwargs["chat_id"] == 111
    assert "didn’t complete" in call_kwargs["text"]
    # Memory-fix: the original task brief is included so the user can confirm.
    assert "Build a 5-slide investor deck" in call_kwargs["text"]

    # The inline keyboard MUST carry the retry + dismiss callbacks bound
    # to this task_id so the click handler can route it.
    markup = call_kwargs["reply_markup"]
    button_rows = markup.inline_keyboard
    assert len(button_rows) == 1
    callbacks = {btn.text: btn.callback_data for btn in button_rows[0]}
    assert callbacks["Try again"] == f"builder_retry_{payload['task_id']}"
    assert callbacks["Dismiss"] == f"builder_dismiss_{payload['task_id']}"


@pytest.mark.anyio
async def test_cancelled_event_sends_text_without_buttons(channel: TelegramChannel):
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="222")
    payload = _cancelled_payload()
    await channel._on_builder_completion(payload)

    bot = channel._application.bot
    bot.send_message.assert_awaited_once()
    kwargs = bot.send_message.call_args.kwargs
    assert kwargs["chat_id"] == 222
    assert "Build was cancelled" in kwargs["text"]
    assert "reply_markup" not in kwargs


@pytest.mark.anyio
async def test_unknown_thread_id_drops_silently(channel: TelegramChannel):
    """If the thread isn't bound to a Telegram chat, nothing fires."""
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id=None)
    await channel._on_builder_completion(_success_payload(thread_id="unknown-thread"))

    bot = channel._application.bot
    bot.send_document.assert_not_awaited()
    bot.send_message.assert_not_awaited()


@pytest.mark.anyio
async def test_retry_button_publishes_inbound_message(channel: TelegramChannel):
    """Clicking Try again fires an InboundMessage with the retry prompt."""
    _bind_loop(channel)
    channel._main_loop = asyncio.get_running_loop()
    publish_inbound_mock = AsyncMock()
    channel.bus.publish_inbound = publish_inbound_mock  # type: ignore[assignment]

    fake_query = MagicMock()
    fake_query.answer = AsyncMock()
    fake_query.edit_message_reply_markup = AsyncMock()
    fake_query.data = "builder_retry_task-2"
    fake_query.message = SimpleNamespace(chat_id=42)
    fake_query.from_user = SimpleNamespace(id=99)

    update = SimpleNamespace(callback_query=fake_query)

    await channel._on_callback_query(update, context=None)

    fake_query.answer.assert_awaited_once()
    fake_query.edit_message_reply_markup.assert_awaited_once_with(reply_markup=None)
    # Wait for the run_coroutine_threadsafe future to settle
    for _ in range(20):
        if publish_inbound_mock.await_count > 0:
            break
        await asyncio.sleep(0.01)

    publish_inbound_mock.assert_awaited_once()
    inbound = publish_inbound_mock.await_args.args[0]
    assert inbound.channel_name == "telegram"
    assert inbound.chat_id == "42"
    assert inbound.user_id == "99"
    assert inbound.text == "yes, please try that again"
    assert inbound.msg_type == InboundMessageType.CHAT


@pytest.mark.anyio
async def test_dismiss_button_clears_keyboard_only(channel: TelegramChannel):
    """Dismiss removes buttons; no inbound message is published."""
    _bind_loop(channel)
    channel._main_loop = asyncio.get_running_loop()
    publish_inbound_mock = AsyncMock()
    channel.bus.publish_inbound = publish_inbound_mock  # type: ignore[assignment]

    fake_query = MagicMock()
    fake_query.answer = AsyncMock()
    fake_query.edit_message_reply_markup = AsyncMock()
    fake_query.data = "builder_dismiss_task-2"
    fake_query.message = SimpleNamespace(chat_id=42)
    fake_query.from_user = SimpleNamespace(id=99)
    update = SimpleNamespace(callback_query=fake_query)

    await channel._on_callback_query(update, context=None)

    fake_query.edit_message_reply_markup.assert_awaited_once_with(reply_markup=None)
    publish_inbound_mock.assert_not_awaited()
