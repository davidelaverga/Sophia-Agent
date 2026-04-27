"""Builder completion event fan-out worker.

The worker is the gateway-side counterpart of
``deerflow.sophia.builder_events`` (which lives in the LangGraph process).
It receives a single POST per terminal task transition and fans the event
out to:

- The webapp via Server-Sent Events (subscribers per ``thread_id``)
- IM channels (Telegram, Slack, Feishu) via the channel ``MessageBus``

Late subscribers (e.g. webapp page reload after the event already fired)
can fetch the most recent event from the per-thread TTL cache via the
``GET /api/threads/{thread_id}/builder-events/last`` endpoint.

The worker is intentionally in-memory only:

- The event lifetime is short (5 minutes by default). If the gateway
  restarts mid-event, the loss is acceptable — at worst the user sees a
  stale "still working" UI until they ask Sophia for status, at which
  point the existing ``BuilderSessionMiddleware`` handoff-adoption flow
  kicks in (a fallback that already worked, just not proactively).
- No Postgres / Redis dependency. PR 2 can swap to a durable store if
  needed (the public worker contract stays the same).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

logger = logging.getLogger(__name__)


# How long to keep a published event around for late-mount recovery.
DEFAULT_CACHE_TTL_SECONDS = 5 * 60

# Per-subscriber buffer; small because the card UX deduplicates on the
# frontend and we only really need the latest terminal event.
_SUBSCRIBER_QUEUE_MAXSIZE = 8


class BuilderEventsWorker:
    """Per-thread pub/sub for builder completion events.

    Lifecycle: instantiated once during gateway lifespan, accessed via
    ``get_builder_events_worker(app)``. Thread-safe within a single asyncio
    event loop (the gateway is single-loop).
    """

    def __init__(self, *, cache_ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS) -> None:
        self._cache_ttl_seconds = cache_ttl_seconds
        self._subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._last_event: dict[str, tuple[float, dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    async def publish(self, event: dict[str, Any]) -> int:
        """Fan ``event`` out to all subscribers of ``event["thread_id"]``.

        Returns the number of subscribers the event was queued for. Also
        stores the event in the per-thread TTL cache so a webapp reloading
        within ``cache_ttl_seconds`` can recover it.
        """
        thread_id = event.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            logger.warning("Builder events: dropping event without thread_id task_id=%s", event.get("task_id"))
            return 0

        delivered = 0
        async with self._lock:
            self._last_event[thread_id] = (time.monotonic(), event)
            queues = list(self._subscribers.get(thread_id, []))

        for queue in queues:
            try:
                queue.put_nowait(event)
                delivered += 1
            except asyncio.QueueFull:
                logger.warning(
                    "Builder events: dropping event for slow subscriber thread_id=%s task_id=%s",
                    thread_id,
                    event.get("task_id"),
                )

        logger.info(
            "Builder events: published thread_id=%s task_id=%s status=%s subscribers=%d",
            thread_id,
            event.get("task_id"),
            event.get("status"),
            delivered,
        )
        return delivered

    @asynccontextmanager
    async def subscribe(self, thread_id: str) -> AsyncIterator[asyncio.Queue]:
        """Async context manager yielding a queue of events for ``thread_id``.

        Usage::

            async with worker.subscribe("thread-1") as queue:
                while True:
                    event = await queue.get()
                    yield event
        """
        queue: asyncio.Queue = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_MAXSIZE)
        async with self._lock:
            self._subscribers[thread_id].append(queue)
        try:
            yield queue
        finally:
            async with self._lock:
                if queue in self._subscribers[thread_id]:
                    self._subscribers[thread_id].remove(queue)
                if not self._subscribers[thread_id]:
                    self._subscribers.pop(thread_id, None)

    async def get_last(self, thread_id: str) -> dict[str, Any] | None:
        """Return the most recent event for ``thread_id`` if still in cache."""
        async with self._lock:
            entry = self._last_event.get(thread_id)
            if entry is None:
                return None
            published_at, event = entry
            if time.monotonic() - published_at > self._cache_ttl_seconds:
                # Stale — drop it lazily.
                self._last_event.pop(thread_id, None)
                return None
            return dict(event)

    async def subscriber_count(self, thread_id: str) -> int:
        """Test/observability helper. Returns 0 when no subscribers."""
        async with self._lock:
            return len(self._subscribers.get(thread_id, []))


# ---- Lifespan helpers ------------------------------------------------------


_WORKER_ATTR = "_builder_events_worker"


def install_builder_events_worker(app, *, cache_ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS) -> BuilderEventsWorker:
    """Attach a worker to ``app.state`` (called from the gateway lifespan)."""
    worker = BuilderEventsWorker(cache_ttl_seconds=cache_ttl_seconds)
    setattr(app.state, _WORKER_ATTR, worker)
    return worker


def get_builder_events_worker(app) -> BuilderEventsWorker:
    """Retrieve the worker from ``app.state``. Raises if not installed."""
    worker = getattr(app.state, _WORKER_ATTR, None)
    if worker is None:
        raise RuntimeError(
            "BuilderEventsWorker is not installed on app.state. "
            "Did the gateway lifespan run? Did the test fixture forget to install it?"
        )
    return worker
