"""Gateway-side event router for Builder runs.

One ``BuilderEventFanout`` per gateway process. It holds an ordered
list of ``BuilderEventSink`` instances and dispatches each published
event to every sink that ``accepts`` it. Two dispatch modes:

- **Sequential** for terminal events (``completed``, ``failed``,
  ``cancelled``, ``timed_out``) — sinks fire one at a time in
  registration order. This guarantees ordering invariants that
  downstream consumers rely on (e.g. trace persistence lands before
  chat surfaces are updated).
- **Concurrent** for mid-flight events (``phase``, ``tool_*``,
  ``ai_message_chunk``, ``todo_updated``, ``artifact_emitted``,
  ``started``) — sinks fire via ``asyncio.gather``. Latency wins over
  strict ordering because no one downstream reads cross-sink state
  mid-flight.

Per-thread terminal flag prevents the stream-subscription / webhook
race from double-firing chat sinks. Per-thread sequence counters give
SSE consumers a monotonic id for replay.

``await_terminal_dispatch(thread_id, timeout)`` lets
``CompanionWakeup.wake`` block briefly so the chat surface is updated
before the synthetic companion turn fires (see plan §Stage 2B race
mitigation).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from collections import OrderedDict
from dataclasses import replace
from threading import Lock

from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


# Cap the bookkeeping LRUs so a misbehaving caller can't grow memory
# unbounded. 10k threads ≈ enough for any single gateway process worth
# of in-flight + recently-completed Builder runs.
_SEQUENCE_CACHE_MAX = 10_000
_TERMINAL_FLAG_CACHE_MAX = 10_000
_TERMINAL_EVENT_CACHE_MAX = 10_000


class BuilderEventFanout:
    """Single-process Builder event router."""

    def __init__(self) -> None:
        self._sinks: list[BuilderEventSink] = []
        self._sequence_lock = Lock()
        self._sequence_counters: OrderedDict[str, int] = OrderedDict()
        self._terminal_lock = Lock()
        self._terminal_flags: OrderedDict[str, str] = OrderedDict()
        # Cross-loop-safe terminal signalling. Stage 2A's stream consumer
        # runs on the gateway loop; Stage 2B's CompanionWakeup also runs
        # on the gateway loop; the Work bot dispatch runs on its own
        # PTB polling loop. concurrent.futures.Future can be set from
        # any thread/loop and awaited from any loop via asyncio.wrap_future.
        self._terminal_futures_lock = Lock()
        self._terminal_futures: OrderedDict[str, concurrent.futures.Future] = OrderedDict()

    # ---- Registration -----------------------------------------------------

    def register(self, sink: BuilderEventSink) -> None:
        """Register a sink. Registration order is terminal-dispatch order."""
        self._sinks.append(sink)
        logger.info("fanout.sink_registered name=%s", sink.name)

    def sinks(self) -> list[BuilderEventSink]:
        """Test/observability helper."""
        return list(self._sinks)

    # ---- Publish ----------------------------------------------------------

    async def publish(self, event: BuilderEvent) -> None:
        """Stamp sequence, dedup, and dispatch to sinks."""
        thread_id = event.thread_id

        if not thread_id:
            logger.warning(
                "fanout.dropped_missing_thread_id event_type=%s source=%s",
                event.event_type,
                event.source,
            )
            return

        # Drop late mid-flight events for threads already terminal.
        if not event.is_terminal and self._is_terminal(thread_id):
            logger.debug(
                "fanout.late_event_dropped thread_id=%s event_type=%s",
                thread_id,
                event.event_type,
            )
            return

        # Stamp per-thread monotonic sequence.
        seq = self._next_sequence(thread_id)
        event = replace(event, sequence=seq)

        # Dedup terminal-vs-terminal races (stream and webhook both
        # arriving). First to register wins; second is dropped.
        if event.is_terminal:
            first_terminal = self._mark_terminal(thread_id, event.event_type)
            if first_terminal is not None:
                logger.info(
                    "fanout.duplicate_terminal_dropped thread_id=%s first_terminal=%s incoming=%s source=%s",
                    thread_id,
                    first_terminal,
                    event.event_type,
                    event.source,
                )
                return

        if event.is_terminal:
            await self._dispatch_sequential(event)
            self._mark_terminal_dispatched(thread_id)
        else:
            await self._dispatch_concurrent(event)

    # ---- Coordination with companion wakeup -------------------------------

    async def await_terminal_dispatch(
        self,
        thread_id: str,
        *,
        timeout: float,
    ) -> bool:
        """Block until terminal dispatch completes for ``thread_id``.

        Returns ``True`` if the event fired within ``timeout`` seconds,
        ``False`` on timeout. Used by ``CompanionWakeup.wake`` (Stage 2B)
        to order the synthetic companion turn after the chat surface has
        been updated. Cross-loop safe — caller can be on any loop, the
        future can be completed from any loop.
        """
        future = self._get_or_create_terminal_future(thread_id)
        try:
            await asyncio.wait_for(asyncio.wrap_future(future), timeout=timeout)
            return True
        except (TimeoutError, asyncio.CancelledError):
            return False

    # ---- Internals --------------------------------------------------------

    async def _dispatch_sequential(self, event: BuilderEvent) -> None:
        for sink in self._sinks:
            if not sink.accepts(event):
                continue
            try:
                await sink.handle(event)
            except Exception:
                logger.warning(
                    "fanout.sink_failed sink=%s event=%s thread_id=%s",
                    sink.name,
                    event.event_type,
                    event.thread_id,
                    exc_info=True,
                )

    async def _dispatch_concurrent(self, event: BuilderEvent) -> None:
        coros = [self._safe_handle(sink, event) for sink in self._sinks if sink.accepts(event)]
        if not coros:
            return
        await asyncio.gather(*coros, return_exceptions=True)

    async def _safe_handle(self, sink: BuilderEventSink, event: BuilderEvent) -> None:
        try:
            await sink.handle(event)
        except Exception:
            logger.warning(
                "fanout.sink_failed sink=%s event=%s thread_id=%s",
                sink.name,
                event.event_type,
                event.thread_id,
                exc_info=True,
            )

    def _next_sequence(self, thread_id: str) -> int:
        with self._sequence_lock:
            current = self._sequence_counters.get(thread_id, 0) + 1
            self._sequence_counters[thread_id] = current
            self._sequence_counters.move_to_end(thread_id)
            while len(self._sequence_counters) > _SEQUENCE_CACHE_MAX:
                self._sequence_counters.popitem(last=False)
            return current

    def _is_terminal(self, thread_id: str) -> bool:
        with self._terminal_lock:
            return thread_id in self._terminal_flags

    def _mark_terminal(self, thread_id: str, event_type: str) -> str | None:
        """Return the previously-recorded terminal type, or ``None`` if
        this is the first terminal for ``thread_id``."""
        with self._terminal_lock:
            if thread_id in self._terminal_flags:
                return self._terminal_flags[thread_id]
            self._terminal_flags[thread_id] = event_type
            self._terminal_flags.move_to_end(thread_id)
            while len(self._terminal_flags) > _TERMINAL_FLAG_CACHE_MAX:
                self._terminal_flags.popitem(last=False)
            return None

    def _get_or_create_terminal_future(self, thread_id: str) -> concurrent.futures.Future:
        with self._terminal_futures_lock:
            existing = self._terminal_futures.get(thread_id)
            if existing is not None:
                self._terminal_futures.move_to_end(thread_id)
                return existing
            new_future: concurrent.futures.Future = concurrent.futures.Future()
            self._terminal_futures[thread_id] = new_future
            self._terminal_futures.move_to_end(thread_id)
            while len(self._terminal_futures) > _TERMINAL_EVENT_CACHE_MAX:
                _, evicted = self._terminal_futures.popitem(last=False)
                # Don't leave anybody waiting on an evicted future.
                if not evicted.done():
                    evicted.set_result(False)
            return new_future

    def _mark_terminal_dispatched(self, thread_id: str) -> None:
        future = self._get_or_create_terminal_future(thread_id)
        if not future.done():
            future.set_result(True)

    # ---- Test helpers -----------------------------------------------------

    def reset_for_tests(self) -> None:
        """Clear all in-memory state. Tests only."""
        with self._sequence_lock:
            self._sequence_counters.clear()
        with self._terminal_lock:
            self._terminal_flags.clear()
        with self._terminal_futures_lock:
            for fut in self._terminal_futures.values():
                if not fut.done():
                    fut.cancel()
            self._terminal_futures.clear()
        self._sinks.clear()
