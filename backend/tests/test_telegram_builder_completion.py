"""Focused tests for the Telegram channel's builder-completion delivery.

Locks:
- Success events download the artifact bytes from Supabase and stream
  them to Telegram as an ``InputFile`` (multipart upload). The chat_id is
  reverse-looked-up from ``thread_id`` via the channel store.
- When the download fails (Supabase 404, missing filename, exception),
  the channel falls back to a plaintext message with the signed URL so
  the user still receives the deliverable.
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


def _stub_store_lookup(
    channel: TelegramChannel,
    *,
    chat_id: str | None,
    topic_id: str | None = None,
) -> None:
    """Stub the chat_id + topic_id reverse lookup."""

    def _fake_find(thread_id: str) -> tuple[str, str | None] | None:  # noqa: ARG001
        if chat_id is None:
            return None
        return chat_id, topic_id

    channel._find_chat_topic_for_thread = _fake_find  # type: ignore[assignment]


# ---- Tests -----------------------------------------------------------------


@pytest.mark.anyio
async def test_success_event_sends_document_as_input_file(channel: TelegramChannel):
    """Success path: download bytes from Supabase, stream to Telegram as
    InputFile. Production hit `Failed to get http url content` when handing
    Telegram the signed URL — the bytes path sidesteps Telegram's egress
    fetch entirely.
    """
    from telegram import InputFile

    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="987654321")
    payload = _success_payload()

    with patch("app.channels.telegram.download_artifact") as mock_download:
        mock_download.return_value = (b"# Climate Change Brief\n\nA short doc.", "text/markdown")
        await channel._on_builder_completion(payload)

    bot = channel._application.bot
    bot.send_document.assert_awaited_once()
    call_kwargs = bot.send_document.call_args.kwargs
    assert call_kwargs["chat_id"] == 987654321
    # Document is now an InputFile with the downloaded bytes — not the URL.
    assert isinstance(call_kwargs["document"], InputFile)
    assert call_kwargs["document"].filename == "climate_change_brief.md"
    assert "Climate Change Brief is ready" in call_kwargs["caption"]
    assert "focused one-page brief" in call_kwargs["caption"]
    bot.send_message.assert_not_awaited()
    # download_artifact called with thread_id + filename (not URL).
    mock_download.assert_called_once_with("thread-1", "climate_change_brief.md")


@pytest.mark.anyio
async def test_success_event_falls_back_to_text_when_download_returns_none(channel: TelegramChannel):
    """Supabase 404 / not-configured returns None — the channel must still
    deliver something. Send caption + signed URL as plaintext so the user
    can click through to the file rather than getting silence.
    """
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="55")
    payload = _success_payload()

    with patch("app.channels.telegram.download_artifact") as mock_download:
        mock_download.return_value = None
        await channel._on_builder_completion(payload)

    bot = channel._application.bot
    bot.send_document.assert_not_awaited()
    bot.send_message.assert_awaited_once()
    text = bot.send_message.call_args.kwargs["text"]
    assert "Climate Change Brief is ready" in text
    assert payload["artifact_url"] in text


@pytest.mark.anyio
async def test_success_event_falls_back_to_text_when_download_raises(channel: TelegramChannel):
    """Network/HTTP errors during download must not crash delivery — fall
    back to plaintext with the link.
    """
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="55")
    payload = _success_payload()

    with patch("app.channels.telegram.download_artifact") as mock_download:
        mock_download.side_effect = RuntimeError("supabase unreachable")
        await channel._on_builder_completion(payload)

    bot = channel._application.bot
    bot.send_document.assert_not_awaited()
    bot.send_message.assert_awaited_once()
    text = bot.send_message.call_args.kwargs["text"]
    assert payload["artifact_url"] in text


@pytest.mark.anyio
async def test_success_event_without_filename_skips_download_and_uses_plaintext(channel: TelegramChannel):
    """If the publisher omitted ``artifact_filename`` we can't key the
    Supabase fetch — go straight to plaintext fallback without a wasted
    download attempt.
    """
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="55")
    payload = _success_payload()
    payload.pop("artifact_filename")

    with patch("app.channels.telegram.download_artifact") as mock_download:
        await channel._on_builder_completion(payload)

    mock_download.assert_not_called()
    bot = channel._application.bot
    bot.send_document.assert_not_awaited()
    bot.send_message.assert_awaited_once()
    text = bot.send_message.call_args.kwargs["text"]
    assert payload["artifact_url"] in text


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
    # to this task_id so the click handler can route it. With no topic_id
    # (private chat), the callback_data omits the ``__<topic_id>`` suffix.
    markup = call_kwargs["reply_markup"]
    button_rows = markup.inline_keyboard
    assert len(button_rows) == 1
    callbacks = {btn.text: btn.callback_data for btn in button_rows[0]}
    assert callbacks["Try again"] == f"builder_retry_{payload['task_id']}"
    assert callbacks["Dismiss"] == f"builder_dismiss_{payload['task_id']}"


@pytest.mark.anyio
async def test_error_event_in_group_chat_encodes_topic_id_in_keyboard(channel: TelegramChannel):
    """Codex review (PR #87): the retry button in group / forum chats must
    carry the original topic_id so the synthesized retry message routes
    back to the same DeerFlow thread.
    """
    _bind_loop(channel)
    _stub_store_lookup(channel, chat_id="111", topic_id="42")
    payload = _error_payload()
    await channel._on_builder_completion(payload)

    bot = channel._application.bot
    call_kwargs = bot.send_message.call_args.kwargs
    callbacks = {btn.text: btn.callback_data for btn in call_kwargs["reply_markup"].inline_keyboard[0]}

    # ``builder_<action>_<task_id>__<topic_id>`` — see _encode_callback_data.
    assert callbacks["Try again"] == f"builder_retry_{payload['task_id']}__42"
    assert callbacks["Dismiss"] == f"builder_dismiss_{payload['task_id']}__42"


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
    """Clicking Try again in a private chat publishes an InboundMessage
    with the retry prompt and ``topic_id=None``.
    """
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
    # Private-chat callback has no topic_id segment: topic_id MUST be None
    # so ChannelManager._handle_chat resolves to the private-chat thread.
    assert inbound.topic_id is None


@pytest.mark.anyio
async def test_retry_button_in_group_chat_propagates_topic_id(channel: TelegramChannel):
    """Codex review (PR #87): in group / forum chats, the retry inbound
    MUST carry the original topic_id so ChannelManager._handle_chat
    routes back to the same DeerFlow thread that owned the failed task.
    Otherwise the retry would silently start a fresh thread and lose
    builder context.
    """
    _bind_loop(channel)
    channel._main_loop = asyncio.get_running_loop()
    publish_inbound_mock = AsyncMock()
    channel.bus.publish_inbound = publish_inbound_mock  # type: ignore[assignment]

    fake_query = MagicMock()
    fake_query.answer = AsyncMock()
    fake_query.edit_message_reply_markup = AsyncMock()
    fake_query.data = "builder_retry_task-2__42"  # topic_id=42 from group thread
    fake_query.message = SimpleNamespace(chat_id=-1001234567890)
    fake_query.from_user = SimpleNamespace(id=99)

    update = SimpleNamespace(callback_query=fake_query)
    await channel._on_callback_query(update, context=None)

    for _ in range(20):
        if publish_inbound_mock.await_count > 0:
            break
        await asyncio.sleep(0.01)

    publish_inbound_mock.assert_awaited_once()
    inbound = publish_inbound_mock.await_args.args[0]
    assert inbound.chat_id == "-1001234567890"
    assert inbound.topic_id == "42"
    assert inbound.text == "yes, please try that again"


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


def test_callback_data_round_trip():
    """The encode/parse helpers are inverses for both private + group cases."""
    encode = TelegramChannel._encode_callback_data
    parse = TelegramChannel._parse_callback_data

    # Private chat — no topic_id segment.
    private = encode("retry", "task-abc", None)
    assert private == "builder_retry_task-abc"
    assert parse(private) == ("retry", "task-abc", None)

    # Group / forum chat — topic_id encoded after ``__`` separator.
    group = encode("retry", "task-abc", "42")
    assert group == "builder_retry_task-abc__42"
    assert parse(group) == ("retry", "task-abc", "42")

    # Dismiss action also round-trips cleanly.
    dismiss = encode("dismiss", "task-xyz", "100")
    assert dismiss == "builder_dismiss_task-xyz__100"
    assert parse(dismiss) == ("dismiss", "task-xyz", "100")

    # Unknown / malformed prefix is rejected.
    assert parse("not_a_builder_callback") == (None, None, None)
    assert parse("") == (None, None, None)


def test_callback_data_stays_within_telegram_64_byte_limit():
    """Telegram caps callback_data at 64 bytes — our encoding must fit
    the production generators of task_id and topic_id.

    - ``task_id`` is ``str(uuid.uuid4())[:8]`` (8 hex chars) — see
      ``backend/packages/harness/deerflow/subagents/executor.py``.
    - ``topic_id`` is ``str(message_id)`` from python-telegram-bot, which
      Telegram caps well below 19 digits in practice.

    The realistic max payload is ~45 bytes — comfortably under the limit.
    PR 2 (async retrofit) needs to re-validate this when deepagents
    starts using LangGraph thread_ids (UUIDs) as the task_id source.
    """
    encode = TelegramChannel._encode_callback_data
    realistic_task = "a" * 8
    realistic_topic = "9" * 19  # Telegram's worst-case message_id length
    payload = encode("dismiss", realistic_task, realistic_topic)
    assert len(payload.encode("utf-8")) <= 64, (
        f"callback_data exceeded Telegram's 64-byte limit: {len(payload)} bytes"
    )
