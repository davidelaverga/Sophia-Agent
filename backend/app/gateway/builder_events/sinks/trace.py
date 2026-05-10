"""TraceSink — append every Builder event to a per-Builder-thread JSONL.

Writes to ``users/{user_id}/traces/builder_events_{thread_id}.jsonl``,
one JSON line per event. Companion to (not a replacement for)
``ProgressTraceWriter`` in ``deerflow.sophia.builder_progress``: that
writer is keyed by ``session_id`` and lives inside the Builder graph;
this sink is keyed by ``thread_id`` and lives in the gateway process.

D3 in the plan keeps them separate. Different keying makes
consolidation messy; the second file is cheap.

File appends happen in a thread (via ``asyncio.to_thread``) so the
event loop is never blocked by disk I/O.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from app.gateway.builder_events.types import BuilderEvent
from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)


# Thread IDs are LangGraph-generated UUIDs in practice, but defend
# against path traversal in the filename portion regardless.
_SAFE_THREAD_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class TraceSink:
    """Append-only JSONL writer for Builder events."""

    name = "trace"

    def __init__(self, *, users_dir: Path = USERS_DIR) -> None:
        self._users_dir = users_dir

    def accepts(self, event: BuilderEvent) -> bool:
        # Drop only events that can't be safely keyed to a file.
        return bool(event.user_id) and bool(event.thread_id)

    async def handle(self, event: BuilderEvent) -> None:
        try:
            path = self._trace_path(event)
        except ValueError:
            logger.warning(
                "trace_sink.invalid_path user_id=%s thread_id=%s",
                event.user_id,
                event.thread_id,
            )
            return

        import asyncio

        await asyncio.to_thread(self._append, path, event.to_dict())

    def _trace_path(self, event: BuilderEvent) -> Path:
        if not _SAFE_THREAD_ID.match(event.thread_id):
            raise ValueError(f"unsafe thread_id for filename: {event.thread_id!r}")
        return safe_user_path(
            self._users_dir,
            event.user_id,
            "traces",
            f"builder_events_{event.thread_id}.jsonl",
        )

    @staticmethod
    def _append(path: Path, line: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
