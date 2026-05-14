"""TraceSink — write builder events as JSONL under users/{user_id}/builder_runs/.

Phase 1 runs alongside the existing ``ProgressTraceWriter`` (in
``deerflow.sophia.builder_progress``). After a two-week parity window
(Phase 3 cleanup PR), the legacy writer is deprecated.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.3,
§Q5 (migration plan).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


_DEFAULT_BASE_PATH = Path(os.environ.get("SOPHIA_USERS_PATH", "users"))


class TraceSink(BuilderEventSink):
    """Append builder events as JSONL.

    Path: ``{base_path}/{user_id}/builder_runs/{thread_id}.jsonl``.

    File I/O is serialised per-thread via :class:`asyncio.Lock`. Writes
    are buffered + flushed; we do not fsync per event (deemed
    unnecessary for diagnostic traces).
    """

    name = "trace"

    def __init__(self, *, base_path: Path | None = None) -> None:
        self._base_path = base_path or _DEFAULT_BASE_PATH
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    async def accepts(self, event: BuilderEvent) -> bool:  # noqa: ARG002 — always accept
        return True

    async def handle(self, event: BuilderEvent) -> None:
        user_id = event.user_id or "unknown"
        thread_id = event.thread_id or "unknown_thread"
        path = self._base_path / user_id / "builder_runs" / f"{thread_id}.jsonl"
        lock = await self._get_lock(thread_id)
        try:
            async with lock:
                await asyncio.to_thread(self._append, path, event)
        except Exception:
            logger.warning(
                "TraceSink: failed to append event task_id=%s type=%s path=%s",
                event.task_id,
                event.type,
                path,
                exc_info=True,
            )

    async def _get_lock(self, thread_id: str) -> asyncio.Lock:
        async with self._locks_guard:
            lock = self._locks.get(thread_id)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[thread_id] = lock
            return lock

    @staticmethod
    def _append(path: Path, event: BuilderEvent) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event.model_dump(), ensure_ascii=False)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.write("\n")


__all__ = ["TraceSink"]
