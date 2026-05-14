"""Unit tests for the BuilderEventFanout (spec §10)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import pytest

from app.gateway.builder_events.fanout import BuilderEventFanout
from app.gateway.builder_events.types import (
    BuilderEvent,
    CompletedEvent,
    MessageDeltaEvent,
    ToolCallEvent,
)


@dataclass
class _RecordingSink:
    name: str = "recording"
    accept_origins: tuple[str, ...] = ("telegram", "web", "voice")
    handled: list[BuilderEvent] = field(default_factory=list)
    raise_on_handle: bool = False
    sleep_seconds: float = 0.0

    async def accepts(self, event: BuilderEvent) -> bool:
        return event.channel_origin in self.accept_origins

    async def handle(self, event: BuilderEvent) -> None:
        if self.sleep_seconds:
            await asyncio.sleep(self.sleep_seconds)
        if self.raise_on_handle:
            raise RuntimeError("boom")
        self.handled.append(event)


def _msg(seq: int, *, origin: str = "telegram", task: str = "task1") -> MessageDeltaEvent:
    return MessageDeltaEvent(
        task_id=task,
        thread_id=f"thread-{task}",
        user_id="u",
        channel_origin=origin,  # type: ignore[arg-type]
        timestamp_ms=seq,
        sequence=seq,
        delta=f"d{seq}",
    )


def _completed(*, task: str = "task1", origin: str = "telegram") -> CompletedEvent:
    return CompletedEvent(
        task_id=task,
        thread_id=f"thread-{task}",
        user_id="u",
        channel_origin=origin,  # type: ignore[arg-type]
        timestamp_ms=10_000,
        sequence=99,
        status="completed",
    )


@pytest.mark.anyio
async def test_publish_dispatches_to_all_accepting_sinks() -> None:
    fanout = BuilderEventFanout()
    a = _RecordingSink(name="a")
    b = _RecordingSink(name="b")
    fanout.register_sink(a)
    fanout.register_sink(b)

    await fanout.publish(_msg(1))
    await fanout.publish(_msg(2))

    assert [e.sequence for e in a.handled] == [1, 2]
    assert [e.sequence for e in b.handled] == [1, 2]


@pytest.mark.anyio
async def test_publish_skips_rejecting_sinks() -> None:
    fanout = BuilderEventFanout()
    telegram_only = _RecordingSink(name="telegram-only", accept_origins=("telegram",))
    voice_only = _RecordingSink(name="voice-only", accept_origins=("voice",))
    fanout.register_sink(telegram_only)
    fanout.register_sink(voice_only)

    await fanout.publish(_msg(1, origin="telegram"))
    await fanout.publish(_msg(2, origin="voice"))

    assert [e.sequence for e in telegram_only.handled] == [1]
    assert [e.sequence for e in voice_only.handled] == [2]


@pytest.mark.anyio
async def test_dedup_drops_repeated_sequence() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register_sink(sink)

    evt = _msg(1)
    await fanout.publish(evt)
    await fanout.publish(evt)
    await fanout.publish(_msg(1))

    assert len(sink.handled) == 1


@pytest.mark.anyio
async def test_terminal_event_drops_subsequent_midflight() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register_sink(sink)

    await fanout.publish(_msg(1))
    await fanout.publish(_completed())
    await fanout.publish(_msg(2))  # arrives late — should be dropped

    types = [e.type for e in sink.handled]
    assert types == ["message_delta", "completed"]


@pytest.mark.anyio
async def test_isolated_sink_failure_does_not_block_others() -> None:
    fanout = BuilderEventFanout()
    bad = _RecordingSink(name="bad", raise_on_handle=True)
    good = _RecordingSink(name="good")
    fanout.register_sink(bad)
    fanout.register_sink(good)

    await fanout.publish(_msg(1))

    assert good.handled and good.handled[0].sequence == 1
    assert bad.handled == []


@pytest.mark.anyio
async def test_terminal_event_fires_sinks_sequentially() -> None:
    fanout = BuilderEventFanout()
    order: list[str] = []

    class _Ordered(_RecordingSink):
        async def handle(self, event: BuilderEvent) -> None:  # type: ignore[override]
            order.append(self.name)

    fanout.register_sink(_Ordered(name="first"))
    fanout.register_sink(_Ordered(name="second"))
    fanout.register_sink(_Ordered(name="third"))

    await fanout.publish(_completed())

    assert order == ["first", "second", "third"]


@pytest.mark.anyio
async def test_publish_terminal_with_telegram_origin() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register_sink(sink)

    payload = {
        "task_id": "task42",
        "thread_id": "thread42",
        "status": "success",
        "user_id": "u1",
        "summary": "All done.",
        "artifact_filename": "report.pdf",
        "artifact_type": "research",
    }
    await fanout.publish_terminal(payload, channel_origin="telegram")

    assert sink.handled
    evt = sink.handled[0]
    assert isinstance(evt, CompletedEvent)
    assert evt.task_id == "task42"
    assert evt.status == "completed"
    assert evt.companion_summary == "All done."


@pytest.mark.anyio
async def test_attach_stream_no_op_when_flag_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BUILDER_LIVE_STREAM_ENABLED", raising=False)
    fanout = BuilderEventFanout()

    called: list[str] = []

    def _consumer_factory(**kwargs):  # noqa: ARG001
        called.append("constructed")

        class _C:
            async def run(self):
                called.append("ran")

        return _C()

    await fanout.attach_stream(
        task_id="t",
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        consumer_factory=_consumer_factory,
    )
    assert called == []


@pytest.mark.anyio
async def test_attach_stream_runs_when_flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BUILDER_LIVE_STREAM_ENABLED", "true")
    fanout = BuilderEventFanout()
    ran = asyncio.Event()

    def _consumer_factory(**kwargs):  # noqa: ARG001
        class _C:
            async def run(self):
                ran.set()

        return _C()

    await fanout.attach_stream(
        task_id="t",
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        consumer_factory=_consumer_factory,
    )
    await asyncio.wait_for(ran.wait(), timeout=1.0)


@pytest.mark.anyio
async def test_tool_call_event_routed_through_fanout() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register_sink(sink)

    tool_evt = ToolCallEvent(
        task_id="t",
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        timestamp_ms=1,
        sequence=1,
        tool_call_id="c1",
        tool_name="builder_web_search",
        args={"query": "x"},
        status="started",
    )
    await fanout.publish(tool_evt)
    assert sink.handled and sink.handled[0].type == "tool_call"
