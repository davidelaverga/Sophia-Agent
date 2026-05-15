"""Regression tests for the WorkshopTelegramSink terminal-event cache.

Codex P2: a fast builder run can complete before the placeholder is
sent and the receiver is registered. Without caching, the terminal
event is dropped at the sink (no receiver at publish time) and the
placeholder stays stuck on "Working on it…" — the existing
``_on_builder_completion`` path still delivers the artifact but the
streaming UX visibly fails.

Post-fix the sink:
- ``accepts()`` admits terminal events even without a receiver
- ``handle()`` caches terminal events when no receiver is registered
- ``register_workshop()`` replays the cached terminal to the
  late-registering receiver
- ``unregister_workshop()`` clears the cache as part of normal cleanup
"""

from __future__ import annotations

import asyncio

import pytest

from app.gateway.builder_events.sinks.workshop_telegram import WorkshopTelegramSink
from app.gateway.builder_events.types import (
    CompletedEvent,
    MessageDeltaEvent,
)


def _completed(task_id: str = "t", status: str = "completed") -> CompletedEvent:
    return CompletedEvent(
        task_id=task_id,
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        timestamp_ms=1,
        sequence=99,
        status=status,  # type: ignore[arg-type]
        companion_summary="all done",
    )


def _msg_delta(task_id: str = "t") -> MessageDeltaEvent:
    return MessageDeltaEvent(
        task_id=task_id,
        thread_id="th",
        user_id="u",
        channel_origin="telegram",
        timestamp_ms=1,
        sequence=1,
        delta="hi",
    )


class _RecordingReceiver:
    def __init__(self) -> None:
        self.events: list = []
        self.raise_on_event = False

    async def on_event(self, event) -> None:  # type: ignore[no-untyped-def]
        if self.raise_on_event:
            raise RuntimeError("boom")
        self.events.append(event)


@pytest.mark.anyio
async def test_terminal_cached_when_no_receiver() -> None:
    """Codex P2 core regression: terminal arrives before registration."""
    sink = WorkshopTelegramSink()
    evt = _completed(task_id="task-fast")

    # No receiver registered → accepts must still admit terminal events
    # so handle can cache them.
    assert await sink.accepts(evt) is True
    await sink.handle(evt)

    # Cache contains the terminal event for this task.
    assert "task-fast" in sink._terminal_cache


@pytest.mark.anyio
async def test_replay_fires_on_late_registration() -> None:
    """Late-registering receiver gets the cached terminal replayed."""
    sink = WorkshopTelegramSink()
    evt = _completed(task_id="task-fast")
    await sink.handle(evt)  # cache it
    assert "task-fast" in sink._terminal_cache

    receiver = _RecordingReceiver()
    sink.register_workshop("task-fast", receiver)

    # Replay is scheduled — give it one event-loop tick to run.
    for _ in range(10):
        await asyncio.sleep(0)
        if receiver.events:
            break

    assert len(receiver.events) == 1
    assert isinstance(receiver.events[0], CompletedEvent)
    assert receiver.events[0].task_id == "task-fast"
    # Cache cleared once delivered to the late receiver.
    assert "task-fast" not in sink._terminal_cache


@pytest.mark.anyio
async def test_mid_flight_events_still_dropped_without_receiver() -> None:
    """Cache holds ONLY terminal events — mid-flight chunks without a
    receiver are still dropped (would explode memory otherwise).
    """
    sink = WorkshopTelegramSink()
    delta = _msg_delta(task_id="task-x")

    # accepts gates on receiver presence for non-terminal events.
    assert await sink.accepts(delta) is False
    # Cache stays empty for non-terminal events.
    assert "task-x" not in sink._terminal_cache


@pytest.mark.anyio
async def test_terminal_event_with_registered_receiver_delivered_inline() -> None:
    """Normal happy path: receiver was registered before the terminal."""
    sink = WorkshopTelegramSink()
    receiver = _RecordingReceiver()
    sink.register_workshop("task-y", receiver)

    evt = _completed(task_id="task-y")
    assert await sink.accepts(evt) is True
    await sink.handle(evt)

    assert len(receiver.events) == 1
    # No cache entry — receiver consumed it inline.
    assert "task-y" not in sink._terminal_cache


@pytest.mark.anyio
async def test_unregister_clears_cache() -> None:
    """Defensive cleanup: unregister drops any cached terminal too."""
    sink = WorkshopTelegramSink()
    await sink.handle(_completed(task_id="task-z"))
    assert "task-z" in sink._terminal_cache

    sink.unregister_workshop("task-z")
    assert "task-z" not in sink._terminal_cache


@pytest.mark.anyio
async def test_replay_failure_does_not_crash_sink() -> None:
    """A failing replay must not break the sink for future tasks."""
    sink = WorkshopTelegramSink()
    await sink.handle(_completed(task_id="task-a"))

    failing = _RecordingReceiver()
    failing.raise_on_event = True
    sink.register_workshop("task-a", failing)

    # Give the replay a chance to fire (and raise internally).
    for _ in range(5):
        await asyncio.sleep(0)

    # A subsequent register for a different task still works.
    await sink.handle(_completed(task_id="task-b"))
    good = _RecordingReceiver()
    sink.register_workshop("task-b", good)
    for _ in range(10):
        await asyncio.sleep(0)
        if good.events:
            break
    assert len(good.events) == 1


@pytest.mark.anyio
async def test_has_receiver_reflects_registration_state() -> None:
    """Public ``has_receiver`` API replaces the manager-side dedup set."""
    sink = WorkshopTelegramSink()
    assert sink.has_receiver("task-1") is False

    receiver = _RecordingReceiver()
    sink.register_workshop("task-1", receiver)
    assert sink.has_receiver("task-1") is True

    sink.unregister_workshop("task-1")
    assert sink.has_receiver("task-1") is False


@pytest.mark.anyio
async def test_terminal_cache_lru_bounded() -> None:
    """Cache stays bounded under heavy register-less terminal traffic."""
    from app.gateway.builder_events.sinks import workshop_telegram

    sink = WorkshopTelegramSink()
    # Force a small cap for the test
    workshop_telegram._TERMINAL_CACHE_MAX = 4
    try:
        for i in range(10):
            await sink.handle(_completed(task_id=f"task-{i}"))
        assert len(sink._terminal_cache) <= 4
        # Most recent entries are still present
        assert "task-9" in sink._terminal_cache
        # Oldest evicted
        assert "task-0" not in sink._terminal_cache
    finally:
        workshop_telegram._TERMINAL_CACHE_MAX = 256
