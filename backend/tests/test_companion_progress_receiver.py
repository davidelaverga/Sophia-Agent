"""Unit tests for CompanionProgressReceiver (Phase 3)."""

from __future__ import annotations

import asyncio

import pytest

from app.channels.companion_progress_receiver import CompanionProgressReceiver
from app.gateway.builder_events.sinks.workshop_telegram import WorkshopTelegramSink
from app.gateway.builder_events.types import (
    CompletedEvent,
    CustomEvent,
    ToolCallEvent,
)


class _FakeBot:
    """Records sent / edited messages so tests can assert on them."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.edits: list[dict] = []
        self.documents: list[dict] = []
        self._next_msg_id = 1000

    async def send_message(self, **kwargs):  # type: ignore[no-untyped-def]
        self.sent.append(kwargs)
        mid = self._next_msg_id
        self._next_msg_id += 1

        class _Msg:
            def __init__(self, m):
                self.message_id = m

        return _Msg(mid)

    async def edit_message_text(self, **kwargs):  # type: ignore[no-untyped-def]
        self.edits.append(kwargs)

    async def send_document(self, **kwargs):  # type: ignore[no-untyped-def]
        self.documents.append(kwargs)


def _tool(name: str, args: dict, *, seq: int = 1, task_id: str = "t") -> ToolCallEvent:
    return ToolCallEvent(
        task_id=task_id,
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        timestamp_ms=seq,
        sequence=seq,
        tool_call_id=f"c{seq}",
        tool_name=name,
        args=args,
        status="started",
    )


def _completed(*, task_id: str = "t", status: str = "completed") -> CompletedEvent:
    return CompletedEvent(
        task_id=task_id,
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        timestamp_ms=99,
        sequence=99,
        status=status,  # type: ignore[arg-type]
        companion_summary="Build done.",
        artifact_filename="report.pdf",
    )


@pytest.mark.anyio
async def test_receiver_edits_placeholder_on_state_change() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    sink = WorkshopTelegramSink()
    receiver = CompanionProgressReceiver(
        bot=bot, chat_id=42, message_id=999, tg_loop=loop, sink=sink, task_id="t"
    )
    sink.register_workshop("t", receiver)

    # Force the streaming client to flush every edit so the test is
    # deterministic (the 750ms batching is bypassed by flush=True on
    # state-changed events; we just need at least one edit to fire).
    await receiver.on_event(_tool("builder_web_search", {"query": "best EVs"}, seq=1))

    assert bot.edits  # at least one edit went out
    last_edit = bot.edits[-1]
    assert last_edit["chat_id"] == 42
    assert last_edit["message_id"] == 999
    # No parse_mode (Phase 2 regression — plain text only)
    assert "parse_mode" not in last_edit
    assert "🔍 Searching: best EVs" in last_edit["text"]


@pytest.mark.anyio
async def test_receiver_finalizes_on_completed_event() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    sink = WorkshopTelegramSink()
    receiver = CompanionProgressReceiver(
        bot=bot, chat_id=42, message_id=999, tg_loop=loop, sink=sink, task_id="t"
    )
    sink.register_workshop("t", receiver)
    assert "t" in sink._receivers  # noqa: SLF001 — diagnostic-only

    await receiver.on_event(_completed())

    # Final state is rendered into the placeholder.
    assert any("✓ Done" in e["text"] for e in bot.edits)
    assert any("Build done." in e["text"] for e in bot.edits)
    # Receiver unregisters from the sink so a late stream event can't
    # double-fire after completion.
    assert "t" not in sink._receivers  # noqa: SLF001


@pytest.mark.anyio
async def test_receiver_does_not_send_artifact() -> None:
    """The CompanionProgressReceiver MUST NOT call send_document.

    Production regression: artifact delivery is owned by
    ``telegram._on_builder_completion`` (subscribed to the channel bus
    on the terminal-webhook fan-out). If the receiver also tries to
    deliver, the user gets two copies. This test locks the contract.
    """
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    sink = WorkshopTelegramSink()
    receiver = CompanionProgressReceiver(
        bot=bot, chat_id=42, message_id=999, tg_loop=loop, sink=sink, task_id="t"
    )
    sink.register_workshop("t", receiver)

    await receiver.on_event(_completed())

    assert bot.documents == [], "receiver must not send the artifact document"


@pytest.mark.anyio
async def test_receiver_ignores_events_after_terminal() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    sink = WorkshopTelegramSink()
    receiver = CompanionProgressReceiver(
        bot=bot, chat_id=42, message_id=999, tg_loop=loop, sink=sink, task_id="t"
    )
    sink.register_workshop("t", receiver)

    await receiver.on_event(_completed())
    edits_after_terminal = len(bot.edits)

    # A late event arriving after terminal must be a no-op.
    await receiver.on_event(_tool("builder_web_search", {"query": "late"}, seq=100))
    assert len(bot.edits) == edits_after_terminal


@pytest.mark.anyio
async def test_receiver_handles_custom_phase_event() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    sink = WorkshopTelegramSink()
    receiver = CompanionProgressReceiver(
        bot=bot, chat_id=42, message_id=999, tg_loop=loop, sink=sink, task_id="t"
    )
    sink.register_workshop("t", receiver)

    await receiver.on_event(
        CustomEvent(
            task_id="t",
            thread_id="th",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=1,
            sequence=1,
            name="phase",
            payload={"phase": "finalizing"},
        )
    )

    assert any("Finalizing" in e["text"] for e in bot.edits)
