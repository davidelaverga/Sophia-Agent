"""CompanionContextStore — per-thread builder-event log for companion awareness.

Phase 1 storage for the ``CompanionAwarenessSink``. The companion's
``BuildAwarenessMiddleware`` reads from here so the next companion turn
knows what builder did mid-conversation (and at termination) without
having to call ``check_async_task`` from the model side.

Phase 1 is in-memory only. Phase 2 may persist to ``users/{user_id}/...``
if survival across gateway restarts becomes important; today the
existing ``BuildAwarenessMiddleware`` already polls the SDK as a
fallback, so memory-only is acceptable.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.3
``CompanionAwarenessSink``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


_DEFAULT_BUFFER_PER_THREAD = 64
_DEFAULT_TTL_SECONDS = 30 * 60  # 30 minutes — covers a long companion turn after build finishes


@dataclass(slots=True)
class _ThreadBuffer:
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=_DEFAULT_BUFFER_PER_THREAD))
    last_write: float = field(default_factory=time.monotonic)


class CompanionContextStore:
    """Per-companion-thread ring buffer of ``BuilderEvent`` summaries.

    The companion side reads via :meth:`snapshot` to render the
    awareness block. Events are stored as plain dicts (not pydantic
    models) so the read path doesn't need to import this module.
    """

    def __init__(
        self,
        *,
        buffer_per_thread: int = _DEFAULT_BUFFER_PER_THREAD,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
    ) -> None:
        self._buffer_per_thread = buffer_per_thread
        self._ttl_seconds = ttl_seconds
        self._buffers: dict[str, _ThreadBuffer] = {}
        self._lock = asyncio.Lock()

    async def append_event(self, event: BuilderEvent) -> None:
        """Persist one event for the companion thread.

        ``event.thread_id`` is the companion (parent) thread in the
        terminal-webhook path. In the v3 stream path (Phase 1.5),
        ``thread_id`` is the *builder* thread — callers translate via
        the ``delegation_context.parent_thread_id`` before calling here
        (the stream consumer handles this).
        """
        key = event.thread_id
        if not key:
            logger.warning("CompanionContextStore.append_event: missing thread_id, dropping event task_id=%s", event.task_id)
            return

        record = event.model_dump()
        record.setdefault("_recorded_at", time.time())
        async with self._lock:
            buf = self._buffers.get(key)
            if buf is None:
                buf = _ThreadBuffer(events=deque(maxlen=self._buffer_per_thread))
                self._buffers[key] = buf
            buf.events.append(record)
            buf.last_write = time.monotonic()
            self._prune_locked()

    async def snapshot(self, thread_id: str) -> list[dict[str, Any]]:
        """Return a copy of buffered events for ``thread_id`` (oldest first)."""
        if not thread_id:
            return []
        async with self._lock:
            buf = self._buffers.get(thread_id)
            if buf is None:
                return []
            return list(buf.events)

    async def clear(self, thread_id: str) -> None:
        """Drop the buffer for ``thread_id`` (e.g. after companion synthesis)."""
        async with self._lock:
            self._buffers.pop(thread_id, None)

    def _prune_locked(self) -> None:
        """Drop thread buffers that haven't been written in TTL seconds."""
        if not self._buffers:
            return
        cutoff = time.monotonic() - self._ttl_seconds
        stale = [k for k, v in self._buffers.items() if v.last_write < cutoff]
        for key in stale:
            self._buffers.pop(key, None)


__all__ = ["CompanionContextStore"]
