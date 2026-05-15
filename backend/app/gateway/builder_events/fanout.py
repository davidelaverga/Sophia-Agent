"""BuilderEventFanout — Phase 1 foundation.

The fanout is the gateway-side hub that receives builder events from
two ingress points and dispatches them to a registered sink chain.

Ingress:

1. **Terminal webhook** — the existing
   ``/internal/builder-events`` router calls :meth:`publish_terminal`
   with the legacy webhook payload. Adapted via
   ``adapters.adapt_terminal_webhook``.
2. **v3 stream consumer** — :meth:`attach_stream` spawns a background
   task that subscribes to ``client.threads.stream`` and publishes each
   adapted chunk via :meth:`publish`. Gated by
   ``BUILDER_LIVE_STREAM_ENABLED``.

Dispatch:

- Mid-flight events: sinks fire concurrently, isolated failures.
- Terminal events: sinks fire sequentially in registration order
  (trace → companion_awareness → workshop_telegram). After the
  terminal event for a task fires, subsequent events for that task
  are dropped (terminal flag).

Per-task dedup uses ``(task_id, type, sequence)`` keys in an LRU cache.
The existing ``BuilderEventsWorker`` (per-thread SSE pub/sub) is left
untouched — the fanout coexists with it; the
``/internal/builder-events`` router publishes to BOTH so the existing
webapp SSE flow keeps working.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections import OrderedDict
from typing import Any

from app.gateway.builder_events.adapters import adapt_terminal_webhook
from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


_DEDUP_CACHE_MAX = 4096
_TERMINAL_FLAG_MAX = 2048


def _stream_enabled() -> bool:
    """Return True if v3 stream-consumer ingress should run.

    Phase 2 default ON — mid-flight streaming is required for the
    workshop UX to show progress (tool_call / custom / message_delta).
    With the flag off the workshop receiver only ever sees the terminal
    CompletedEvent and the streaming reply collapses to a blocking
    summary. Operators can flip ``BUILDER_LIVE_STREAM_ENABLED=false``
    via env to disable without code redeploy.

    Read at attach-time so flipping the flag on a running process is a
    no-op until next dispatch.
    """
    return os.environ.get("BUILDER_LIVE_STREAM_ENABLED", "true").lower() not in {"0", "false", "no"}


class BuilderEventFanout:
    """In-process fanout of normalised builder events to sinks.

    Held on ``app.state`` via :func:`install_builder_event_fanout`.
    """

    def __init__(self) -> None:
        self._sinks: list[BuilderEventSink] = []
        self._dedup: OrderedDict[tuple[str, str, int], None] = OrderedDict()
        self._terminal_flags: OrderedDict[str, None] = OrderedDict()
        self._dedup_lock = threading.Lock()
        self._stream_tasks: dict[str, asyncio.Task[None]] = {}
        self._stream_lock = asyncio.Lock()

    # -- sink registry ----------------------------------------------------

    def register_sink(self, sink: BuilderEventSink) -> None:
        """Append ``sink`` to the dispatch chain (order = registration)."""
        self._sinks.append(sink)
        logger.info("BuilderEventFanout: registered sink %r", getattr(sink, "name", sink))

    def sink_names(self) -> list[str]:
        return [getattr(s, "name", str(s)) for s in self._sinks]

    # -- ingress ----------------------------------------------------------

    async def publish(self, event: BuilderEvent) -> None:
        """Dispatch ``event`` to all sinks that accept it.

        Drops events whose ``(task_id, type, sequence)`` was seen before
        and events that arrive after a terminal event for the task.
        """
        if not self._claim(event):
            return

        accept_results = await asyncio.gather(
            *(self._safe_accepts(sink, event) for sink in self._sinks),
            return_exceptions=False,
        )
        accepting = [sink for sink, accepted in zip(self._sinks, accept_results) if accepted]
        if not accepting:
            return

        if event.type == "completed":
            for sink in accepting:
                await self._safe_handle(sink, event)
            return

        await asyncio.gather(
            *(self._safe_handle(sink, event) for sink in accepting),
            return_exceptions=False,
        )

    async def publish_terminal(self, payload: dict[str, Any], *, channel_origin: str = "telegram") -> None:
        """Convenience wrapper for the existing ``/internal/builder-events`` router."""
        event = adapt_terminal_webhook(payload, channel_origin=channel_origin)
        if event is None:
            return
        await self.publish(event)

    async def attach_stream(
        self,
        *,
        task_id: str,
        thread_id: str,
        user_id: str,
        channel_origin: str,
        run_id: str | None = None,
        parent_thread_id: str | None = None,
        consumer_factory: Any | None = None,
    ) -> None:
        """Start a background v3-stream consumer for ``task_id``.

        ``run_id`` is the LangGraph run id returned by
        ``client.runs.create(...)`` inside ``start_builder_task``. It's
        required to tail an in-progress run via
        ``client.runs.join_stream(thread_id, run_id, …)``. When None
        (legacy callers), the consumer logs and skips — the fanout
        falls back to terminal-webhook ingress for this task.

        Gated by ``BUILDER_LIVE_STREAM_ENABLED``. The consumer instance
        is created via ``consumer_factory`` if supplied (tests inject a
        fake here); otherwise the default StreamConsumer is used.
        """
        if not _stream_enabled():
            logger.info(
                "BuilderEventFanout.attach_stream: BUILDER_LIVE_STREAM_ENABLED=false, skipping task_id=%s",
                task_id,
            )
            return

        async with self._stream_lock:
            existing = self._stream_tasks.get(task_id)
            if existing is not None and not existing.done():
                logger.info("BuilderEventFanout.attach_stream: already running for task_id=%s", task_id)
                return

            from app.gateway.builder_events.stream_consumer import StreamConsumer

            factory = consumer_factory or StreamConsumer
            consumer = factory(
                task_id=task_id,
                thread_id=thread_id,
                user_id=user_id,
                channel_origin=channel_origin,
                publish=self.publish,
                run_id=run_id,
                parent_thread_id=parent_thread_id,
            )
            task = asyncio.create_task(consumer.run())
            task.add_done_callback(lambda _t, tid=task_id: self._stream_tasks.pop(tid, None))
            self._stream_tasks[task_id] = task
            logger.info(
                "BuilderEventFanout.attach_stream: spawned consumer task_id=%s thread_id=%s run_id=%s",
                task_id,
                thread_id,
                run_id,
            )

    async def cancel_stream(self, task_id: str) -> None:
        async with self._stream_lock:
            task = self._stream_tasks.pop(task_id, None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                return

    # -- internals --------------------------------------------------------

    def _claim(self, event: BuilderEvent) -> bool:
        """Return True if this event should be dispatched.

        - False on dedup-hit (already seen ``(task_id, type, sequence)``)
        - False if a terminal event was already published for this task
          (drops late stream chunks after completion)
        - Sets terminal flag when admitting a terminal event
        """
        key = (event.task_id, event.type, event.sequence)
        with self._dedup_lock:
            if event.task_id in self._terminal_flags and event.type != "completed":
                return False
            if key in self._dedup:
                self._dedup.move_to_end(key)
                return False
            self._dedup[key] = None
            if len(self._dedup) > _DEDUP_CACHE_MAX:
                self._dedup.popitem(last=False)
            if event.type == "completed":
                self._terminal_flags[event.task_id] = None
                if len(self._terminal_flags) > _TERMINAL_FLAG_MAX:
                    self._terminal_flags.popitem(last=False)
        return True

    @staticmethod
    async def _safe_accepts(sink: BuilderEventSink, event: BuilderEvent) -> bool:
        try:
            return await sink.accepts(event)
        except Exception:
            logger.warning(
                "BuilderEventFanout: sink.accepts raised for sink=%s task_id=%s",
                getattr(sink, "name", sink),
                event.task_id,
                exc_info=True,
            )
            return False

    @staticmethod
    async def _safe_handle(sink: BuilderEventSink, event: BuilderEvent) -> None:
        try:
            await sink.handle(event)
        except Exception:
            logger.warning(
                "BuilderEventFanout: sink.handle raised for sink=%s task_id=%s type=%s",
                getattr(sink, "name", sink),
                event.task_id,
                event.type,
                exc_info=True,
            )


# ---- Lifespan helpers ------------------------------------------------------


_FANOUT_ATTR = "_builder_event_fanout"


def install_builder_event_fanout(app: Any) -> BuilderEventFanout:
    """Attach a fanout to ``app.state`` (gateway lifespan entry point)."""
    fanout = BuilderEventFanout()
    setattr(app.state, _FANOUT_ATTR, fanout)
    return fanout


def get_builder_event_fanout(app: Any) -> BuilderEventFanout:
    """Retrieve the fanout from ``app.state``. Raises if not installed."""
    fanout = getattr(app.state, _FANOUT_ATTR, None)
    if fanout is None:
        raise RuntimeError(
            "BuilderEventFanout is not installed on app.state. "
            "Did the gateway lifespan run? Did the test fixture forget to install it?"
        )
    return fanout


def get_builder_event_fanout_or_none(app: Any) -> BuilderEventFanout | None:
    """Same as :func:`get_builder_event_fanout` but returns None instead of raising."""
    return getattr(app.state, _FANOUT_ATTR, None)


__all__ = [
    "BuilderEventFanout",
    "get_builder_event_fanout",
    "get_builder_event_fanout_or_none",
    "install_builder_event_fanout",
]
