"""Unit tests for ``BuilderEventFanout``."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.gateway.builder_events.fanout import BuilderEventFanout
from app.gateway.builder_events.types import BuilderEvent


def _evt(
    *,
    thread_id: str = "tid-1",
    event_type: str = "phase",
    parent_thread_id: str | None = None,
    source: str = "stream",
    payload: dict[str, Any] | None = None,
) -> BuilderEvent:
    return BuilderEvent(
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        user_id="user-1",
        trace_id="trace-1",
        event_type=event_type,  # type: ignore[arg-type]
        payload=payload or {},
        source=source,  # type: ignore[arg-type]
    )


class _RecordingSink:
    """Test sink that records every event it handles."""

    def __init__(
        self,
        *,
        name: str = "rec",
        accept_predicate=None,
        raise_on: set[str] | None = None,
        delay_s: float = 0.0,
    ) -> None:
        self.name = name
        self.calls: list[BuilderEvent] = []
        self._accept = accept_predicate or (lambda _e: True)
        self._raise_on = raise_on or set()
        self._delay = delay_s

    def accepts(self, event: BuilderEvent) -> bool:
        return self._accept(event)

    async def handle(self, event: BuilderEvent) -> None:
        if self._delay:
            await asyncio.sleep(self._delay)
        if event.event_type in self._raise_on:
            raise RuntimeError(f"{self.name} refuses {event.event_type}")
        self.calls.append(event)


@pytest.mark.anyio
async def test_per_thread_sequence_monotonic_and_independent() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="A", event_type="phase"))
    await fanout.publish(_evt(thread_id="A", event_type="phase"))
    await fanout.publish(_evt(thread_id="B", event_type="phase"))

    a_seqs = [e.sequence for e in sink.calls if e.thread_id == "A"]
    b_seqs = [e.sequence for e in sink.calls if e.thread_id == "B"]
    assert a_seqs == [1, 2]
    assert b_seqs == [1]


@pytest.mark.anyio
async def test_terminal_flag_dedup_drops_second_terminal() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="A", event_type="completed", source="stream"))
    await fanout.publish(_evt(thread_id="A", event_type="completed", source="webhook"))

    assert [e.source for e in sink.calls] == ["stream"]


@pytest.mark.anyio
async def test_late_midflight_event_dropped_after_terminal() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="A", event_type="completed"))
    await fanout.publish(_evt(thread_id="A", event_type="phase"))

    assert [e.event_type for e in sink.calls] == ["completed"]


@pytest.mark.anyio
async def test_sequential_dispatch_runs_sinks_in_registration_order() -> None:
    fanout = BuilderEventFanout()
    order: list[str] = []

    class OrderSink:
        def __init__(self, name: str) -> None:
            self.name = name

        def accepts(self, _event: BuilderEvent) -> bool:
            return True

        async def handle(self, event: BuilderEvent) -> None:
            await asyncio.sleep(0)  # yield to event loop
            order.append(self.name)

    fanout.register(OrderSink("first"))
    fanout.register(OrderSink("second"))
    fanout.register(OrderSink("third"))

    await fanout.publish(_evt(event_type="completed"))

    assert order == ["first", "second", "third"]


@pytest.mark.anyio
async def test_concurrent_dispatch_for_midflight() -> None:
    """All sinks see the event; one slow sink doesn't delay the others."""
    fanout = BuilderEventFanout()
    fast = _RecordingSink(name="fast", delay_s=0.0)
    slow = _RecordingSink(name="slow", delay_s=0.05)
    fanout.register(fast)
    fanout.register(slow)

    await fanout.publish(_evt(event_type="phase"))

    assert len(fast.calls) == 1
    assert len(slow.calls) == 1


@pytest.mark.anyio
async def test_sink_failure_is_isolated() -> None:
    fanout = BuilderEventFanout()
    broken = _RecordingSink(name="broken", raise_on={"completed"})
    ok = _RecordingSink(name="ok")
    fanout.register(broken)
    fanout.register(ok)

    await fanout.publish(_evt(event_type="completed"))

    assert broken.calls == []
    assert len(ok.calls) == 1


@pytest.mark.anyio
async def test_accepts_filter_short_circuits_sink() -> None:
    fanout = BuilderEventFanout()
    only_subagent = _RecordingSink(
        name="subagent_only",
        accept_predicate=lambda e: e.parent_thread_id is not None,
    )
    fanout.register(only_subagent)

    await fanout.publish(_evt(parent_thread_id=None))
    await fanout.publish(_evt(parent_thread_id="parent-1"))

    assert len(only_subagent.calls) == 1
    assert only_subagent.calls[0].parent_thread_id == "parent-1"


@pytest.mark.anyio
async def test_dropped_event_with_missing_thread_id() -> None:
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="", event_type="phase"))

    assert sink.calls == []


@pytest.mark.anyio
async def test_await_terminal_dispatch_unblocks_after_terminal() -> None:
    fanout = BuilderEventFanout()
    fanout.register(_RecordingSink())

    async def waiter() -> bool:
        return await fanout.await_terminal_dispatch("A", timeout=1.0)

    task = asyncio.create_task(waiter())
    await asyncio.sleep(0.01)  # let waiter park on the event
    await fanout.publish(_evt(thread_id="A", event_type="completed"))

    assert await task is True


@pytest.mark.anyio
async def test_await_terminal_dispatch_times_out_when_no_terminal() -> None:
    fanout = BuilderEventFanout()
    fanout.register(_RecordingSink())

    result = await fanout.await_terminal_dispatch("never", timeout=0.05)
    assert result is False
