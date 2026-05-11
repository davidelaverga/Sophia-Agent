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
async def test_two_streams_dedup_drops_second() -> None:
    """Two stream-source terminals on the same thread: second dropped.

    (Webhook-overrides-stream semantics is tested separately —
    ``test_webhook_overrides_synthetic_stream_terminal_within_ttl``.)"""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="A", event_type="completed", source="stream"))
    await fanout.publish(_evt(thread_id="A", event_type="completed", source="stream"))

    completed = [e for e in sink.calls if e.event_type == "completed"]
    assert len(completed) == 1


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


@pytest.mark.anyio
async def test_started_event_resets_terminal_flag_for_consecutive_run() -> None:
    """Same thread_id, two builds: TelegramWorkChannel reuses one
    thread per chat. The second build's ``started`` must clear the
    prior run's terminal flag so its events fire normally."""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    # Build 1: terminal fires.
    await fanout.publish(_evt(thread_id="chat-A", event_type="started"))
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed"))
    # Build 2 on the same thread.
    await fanout.publish(_evt(thread_id="chat-A", event_type="started"))
    await fanout.publish(_evt(thread_id="chat-A", event_type="phase"))
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed"))

    types = [e.event_type for e in sink.calls]
    # Both builds' terminals are present.
    assert types.count("completed") == 2
    # Build 2's phase event fires (not dropped by stale terminal).
    assert "phase" in types
    # Sequence resets per run.
    sequences = [(e.event_type, e.sequence) for e in sink.calls]
    assert sequences[0] == ("started", 1)
    assert sequences[2] == ("started", 1)  # second started resets seq


@pytest.mark.anyio
async def test_terminal_flag_ttl_expires_for_webhook_only_consecutive_builds(
    monkeypatch,
) -> None:
    """Stage 1A: no streaming, only webhooks. Two webhook-only builds
    on the same Work bot chat thread_id, separated by > TTL, must both
    publish their terminals."""
    import app.gateway.builder_events.fanout as fanout_mod

    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    base = 1000.0
    current = [base]

    def fake_monotonic() -> float:
        return current[0]

    monkeypatch.setattr(fanout_mod.time, "monotonic", fake_monotonic)

    # Build 1 terminal lands.
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="webhook"))
    assert sink.calls[-1].event_type == "completed"

    # Advance time past the TTL.
    current[0] = base + fanout_mod._TERMINAL_FLAG_TTL_SECONDS + 1.0

    # Build 2's webhook (no ``started`` ever fired). With TTL the flag
    # has self-cleared and the second terminal publishes cleanly.
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="webhook"))
    completed = [e for e in sink.calls if e.event_type == "completed"]
    assert len(completed) == 2


@pytest.mark.anyio
async def test_webhook_overrides_synthetic_stream_terminal_within_ttl() -> None:
    """A stream-source synthetic terminal is provisional. When the
    real webhook arrives within the TTL window with the rich payload
    (artifact metadata), it must override the synthetic so sinks can
    deliver the artifact. Without this, Work bot users would see the
    fallback text but never receive the artifact file."""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="stream"))
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="webhook"))

    completed = [e for e in sink.calls if e.event_type == "completed"]
    assert len(completed) == 2
    # Stream-source synthetic fired first (provisional fallback);
    # webhook fired second with the real payload.
    assert [e.source for e in completed] == ["stream", "webhook"]


@pytest.mark.anyio
async def test_two_webhooks_dedup_drops_second() -> None:
    """Webhook retries (true duplicates from the LangGraph process)
    are deduped: first webhook wins, second drops."""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="webhook"))
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="webhook"))

    completed = [e for e in sink.calls if e.event_type == "completed"]
    assert len(completed) == 1


@pytest.mark.anyio
async def test_stream_after_webhook_is_dropped() -> None:
    """The webhook is canonical. If a stream-source synthetic somehow
    arrives after the webhook has already fired (clock skew, multiple
    consumers, retry path), it must NOT override the richer webhook
    terminal."""
    fanout = BuilderEventFanout()
    sink = _RecordingSink()
    fanout.register(sink)

    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="webhook"))
    await fanout.publish(_evt(thread_id="chat-A", event_type="completed", source="stream"))

    completed = [e for e in sink.calls if e.event_type == "completed"]
    assert len(completed) == 1
    assert completed[0].source == "webhook"
