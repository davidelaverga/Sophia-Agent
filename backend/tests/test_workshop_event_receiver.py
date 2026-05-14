"""Tests for _WorkshopEventReceiver: renderer + streaming-client coupling (Phase 2)."""

from __future__ import annotations

import asyncio

import pytest

from app.channels.telegram_workshop import _WorkshopEventReceiver
from app.channels.telegram_workshop_renderer import WorkshopMessageRenderer
from app.channels.telegram_workshop_streaming import StreamingTextClient
from app.gateway.builder_events.types import (
    CompletedEvent,
    CustomEvent,
    ToolCallEvent,
)


class _FakeBot:
    def __init__(self) -> None:
        self.sent_messages: list[dict] = []
        self.edits: list[dict] = []
        self._next_msg_id = 1000

    async def send_message(self, **kwargs):  # type: ignore[no-untyped-def]
        self.sent_messages.append(kwargs)
        msg_id = self._next_msg_id
        self._next_msg_id += 1

        class _Msg:
            def __init__(self, mid):
                self.message_id = mid

        return _Msg(msg_id)

    async def edit_message_text(self, **kwargs):  # type: ignore[no-untyped-def]
        self.edits.append(kwargs)


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
        timestamp_ms=2,
        sequence=99,
        status=status,  # type: ignore[arg-type]
        companion_summary="all done",
    )


@pytest.mark.anyio
async def test_receiver_pushes_streaming_update_on_state_change() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    streaming = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await streaming.open(initial_body="🛠 Starting work…")
    renderer = WorkshopMessageRenderer()
    completed = asyncio.Event()
    terminal_box: list[CompletedEvent | None] = [None]
    receiver = _WorkshopEventReceiver(
        streaming_client=streaming,
        renderer=renderer,
        tg_loop=loop,
        completed=completed,
        terminal_event_box=terminal_box,
    )

    await receiver.on_event(_tool("builder_web_search", {"query": "best EVs"}, seq=1))

    assert bot.edits  # streaming update issued
    last_edit_text = bot.edits[-1]["text"]
    assert "🔍 Searching: best EVs" in last_edit_text
    assert not completed.is_set()


@pytest.mark.anyio
async def test_receiver_completes_on_terminal_event() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    streaming = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await streaming.open(initial_body="…")
    renderer = WorkshopMessageRenderer()
    completed = asyncio.Event()
    terminal_box: list[CompletedEvent | None] = [None]
    receiver = _WorkshopEventReceiver(
        streaming_client=streaming,
        renderer=renderer,
        tg_loop=loop,
        completed=completed,
        terminal_event_box=terminal_box,
    )

    evt = _completed()
    await receiver.on_event(evt)

    assert completed.is_set()
    assert terminal_box[0] is evt
    assert any("✓ Done" in e["text"] for e in bot.edits)
    assert any("all done" in e["text"] for e in bot.edits)


@pytest.mark.anyio
async def test_receiver_skips_streaming_on_hidden_tool() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    streaming = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await streaming.open(initial_body="…")
    renderer = WorkshopMessageRenderer()
    completed = asyncio.Event()
    receiver = _WorkshopEventReceiver(
        streaming_client=streaming,
        renderer=renderer,
        tg_loop=loop,
        completed=completed,
        terminal_event_box=[None],
    )

    edits_before = len(bot.edits)
    await receiver.on_event(_tool("read_file", {"path": "x"}, seq=1))
    # No state change → no edit pushed.
    assert len(bot.edits) == edits_before


@pytest.mark.anyio
async def test_receiver_handles_custom_phase_event() -> None:
    loop = asyncio.get_event_loop()
    bot = _FakeBot()
    streaming = StreamingTextClient(bot=bot, chat_id=42, update_interval_ms=0)
    await streaming.open(initial_body="…")
    renderer = WorkshopMessageRenderer()
    completed = asyncio.Event()
    receiver = _WorkshopEventReceiver(
        streaming_client=streaming,
        renderer=renderer,
        tg_loop=loop,
        completed=completed,
        terminal_event_box=[None],
    )

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
