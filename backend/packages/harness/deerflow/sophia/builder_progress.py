"""Builder progress event schema, emitter, and trace writer.

Phase 2 of the Sophia V2 Telegram dual-bot architecture spec.

This module provides the data shape and emission mechanics for progress
events fired during long builder runs. Phase 2 is intentionally log-only:
events are written to per-user JSONL trace files but NOT delivered to any
chat surface. Phase 3 wires the emitter to a sink that posts in groups
as ``@Sophia_Work_bot``.

Spec adaptation from §4.2.2: the spec described a multi-node DeerFlow
graph (planner → researcher → coder → reporter). The actual ``lead_agent``
in this codebase is a single-loop ReAct agent built via
``langchain.agents.create_agent`` — there are no discrete phase nodes to
map onto. Progress is therefore inferred from tool-call boundaries:
search/fetch tools surface as ``FINDING`` events, artifact-emission tools
surface as ``DRAFTING``, and chain-start / chain-end produce ``STARTED`` /
``COMPLETED`` / ``ERROR``. ``PHASE`` is not currently emitted; if the
calibration step (spec §4.2.3) shows we need coarser progress, a heuristic
based on iteration count or tool diversity can be added in a follow-up.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Backend root → repo root → ``users/`` directory. Mirrors the existing
# ``_BACKGROUND_TASKS_DIR`` resolution in ``deerflow.subagents.executor``.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent.parent
_TRACES_ROOT = _PROJECT_ROOT / "users"

# Filename pattern: per-session JSONL alongside the existing emit_artifact trace.
_TRACE_FILENAME_TEMPLATE = "builder_progress_{session_id}.jsonl"

# Env flag for rollback. When set to "false" (case-insensitive), every
# ``ProgressEmitter.emit`` call becomes a no-op. Anything else (including
# unset) keeps emission on. Spec §4.2.5.
_EMIT_ENV_VAR = "BUILDER_PROGRESS_EMIT"


class ProgressEventType(StrEnum):
    """Builder progress event taxonomy. See spec §4.2.1."""

    STARTED = "started"
    PHASE = "phase"
    FINDING = "finding"
    DRAFTING = "drafting"
    COMPLETED = "completed"
    ERROR = "error"


class Surface(StrEnum):
    """Where an event should surface.

    Phase 2 only writes to trace files; ``WORKER`` and ``BOTH`` are reserved
    labels for the Phase 3 Telegram routing pass.
    """

    WORKER = "worker"
    BOTH = "both"
    NONE = "none"


@dataclass(frozen=True)
class ProgressEvent:
    """A single builder progress event.

    The ``summary`` field is the most important: it is what a user would
    see in chat (Phase 3) and what the calibration step (§4.2.3) reviews.
    Templates intentionally lead with content, not structure ("Reading the
    Schott waveguide paper" — not "Step 3 of 7").
    """

    event_type: ProgressEventType
    session_id: str
    artifact_id: str
    user_id: str
    timestamp: _dt.datetime
    summary: str
    detail: str | None = None
    surface: Surface = Surface.WORKER
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """JSON-serializable dict for trace writing."""
        return {
            "event_type": self.event_type.value,
            "session_id": self.session_id,
            "artifact_id": self.artifact_id,
            "user_id": self.user_id,
            "timestamp": self.timestamp.isoformat(),
            "summary": self.summary,
            "detail": self.detail,
            "surface": self.surface.value,
            "metadata": dict(self.metadata),
        }


# ---------------------------------------------------------------------------
# Templated summary helpers
# ---------------------------------------------------------------------------
#
# Kept inline (not in ``sophia/prompts/``) because that directory is reserved
# for LLM-input pipeline prompts and is enforced by the sentrux boundary
# rule in ``.sentrux/rules.toml``. These are Python format strings, not
# prompts.

_DEFAULT_TASK_SUBJECT = "the task"

# Tool-name heuristics. Any tool whose name contains a token from these sets
# is mapped to a progress event type.
_SEARCH_TOOL_TOKENS = ("search", "fetch", "browse", "scrape", "tavily", "jina", "firecrawl")
_DRAFT_TOOL_TOKENS = ("emit_artifact", "emit_builder_artifact", "render_markdown_to_pdf")


def is_search_tool(tool_name: str | None) -> bool:
    if not isinstance(tool_name, str):
        return False
    lowered = tool_name.lower()
    return any(token in lowered for token in _SEARCH_TOOL_TOKENS)


def is_draft_tool(tool_name: str | None) -> bool:
    if not isinstance(tool_name, str):
        return False
    lowered = tool_name.lower()
    return any(token in lowered for token in _DRAFT_TOOL_TOKENS)


def format_started_summary(task_subject: str | None) -> str:
    subject = (task_subject or _DEFAULT_TASK_SUBJECT).strip() or _DEFAULT_TASK_SUBJECT
    return f"Looking into {subject}."


def format_finding_summary(tool_name: str | None) -> str:
    if isinstance(tool_name, str) and tool_name:
        return f"Pulling sources via {tool_name}."
    return "Pulling sources."


def format_drafting_summary(artifact_type: str | None = None) -> str:
    if isinstance(artifact_type, str) and artifact_type.strip():
        return f"Putting the {artifact_type.strip()} together now."
    return "Putting the deliverable together now."


def format_completed_summary() -> str:
    return "Done."


def format_error_summary(error_message: str | None) -> str:
    if isinstance(error_message, str) and error_message.strip():
        truncated = error_message.strip().splitlines()[0][:160]
        return f"Hit a snag: {truncated}"
    return "Hit a snag and couldn't finish."


# ---------------------------------------------------------------------------
# Trace writer
# ---------------------------------------------------------------------------


class ProgressTraceWriter:
    """Append progress events to a per-session JSONL file under ``users/``.

    Each event is one JSON object per line. Suppressed (throttled) events
    are also written but with ``surface=NONE`` so the calibration review
    can see what was filtered out.
    """

    def __init__(self, traces_root: Path | None = None):
        self._traces_root = traces_root or _TRACES_ROOT
        self._lock = threading.Lock()

    def path_for(self, user_id: str, session_id: str) -> Path:
        return self._traces_root / user_id / "traces" / _TRACE_FILENAME_TEMPLATE.format(session_id=session_id)

    def write(self, event: ProgressEvent) -> None:
        path = self.path_for(event.user_id, event.session_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(event.to_dict(), ensure_ascii=False)
            with self._lock, path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:  # pragma: no cover - persistence is best-effort
            logger.warning("Failed to write builder progress trace for user_id=%s session_id=%s", event.user_id, event.session_id, exc_info=True)


# ---------------------------------------------------------------------------
# Emitter
# ---------------------------------------------------------------------------


_PRIORITY_TYPES = frozenset(
    {
        ProgressEventType.STARTED,
        ProgressEventType.COMPLETED,
        ProgressEventType.ERROR,
    }
)


SinkCallable = Callable[[ProgressEvent], None]


def _noop_sink(_: ProgressEvent) -> None:
    """Default sink — does nothing. Phase 3 replaces this with Telegram delivery."""
    return None


class ProgressEmitter:
    """Emits ``ProgressEvent``s, applying throttle and surface decisions.

    Throttle: non-priority events are dropped if emitted within
    ``throttle_seconds`` of the last delivered event. STARTED, COMPLETED,
    and ERROR always pass.

    Sink: a caller-provided callable that takes a ``ProgressEvent``. The
    default is a no-op so Phase 2 only writes to trace files. Phase 3
    injects a Telegram-posting sink.

    Trace: every emit (delivered or suppressed) writes one line to the
    per-session JSONL file. Suppressed events get ``surface=NONE``.
    """

    DEFAULT_THROTTLE_SECONDS = 60.0

    def __init__(
        self,
        *,
        user_id: str,
        session_id: str,
        artifact_id: str,
        sink: SinkCallable | None = None,
        trace_writer: ProgressTraceWriter | None = None,
        throttle_seconds: float | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.user_id = user_id
        self.session_id = session_id
        self.artifact_id = artifact_id
        self._sink = sink or _noop_sink
        self._trace_writer = trace_writer or ProgressTraceWriter()
        self._throttle_seconds = throttle_seconds if throttle_seconds is not None else self.DEFAULT_THROTTLE_SECONDS
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._last_delivered_ts: float = 0.0

    @property
    def throttle_seconds(self) -> float:
        return self._throttle_seconds

    def emit(
        self,
        event_type: ProgressEventType,
        summary: str,
        *,
        detail: str | None = None,
        surface: Surface = Surface.WORKER,
        metadata: dict[str, Any] | None = None,
    ) -> ProgressEvent | None:
        """Emit a progress event.

        Returns the event if delivered to the sink, ``None`` if suppressed
        by the throttle. Suppressed events are still written to trace.
        """
        if not _emission_enabled():
            return None

        now_wall = _dt.datetime.now(_dt.UTC)
        now_mono = self._clock()

        is_priority = event_type in _PRIORITY_TYPES

        with self._lock:
            should_deliver = is_priority or (now_mono - self._last_delivered_ts) >= self._throttle_seconds
            if should_deliver:
                self._last_delivered_ts = now_mono

        delivered_event = ProgressEvent(
            event_type=event_type,
            session_id=self.session_id,
            artifact_id=self.artifact_id,
            user_id=self.user_id,
            timestamp=now_wall,
            summary=summary,
            detail=detail,
            surface=surface if should_deliver else Surface.NONE,
            metadata=dict(metadata or {}),
        )

        # Always write to trace, regardless of throttle, so calibration can
        # inspect everything that was suppressed.
        self._trace_writer.write(delivered_event)

        if not should_deliver:
            return None

        try:
            self._sink(delivered_event)
        except Exception:  # pragma: no cover - sink failures must not crash the builder
            logger.warning("ProgressEmitter sink raised; continuing", exc_info=True)

        return delivered_event


def _emission_enabled() -> bool:
    raw = os.environ.get(_EMIT_ENV_VAR)
    if raw is None:
        return True
    return raw.strip().lower() != "false"


__all__ = [
    "ProgressEvent",
    "ProgressEventType",
    "Surface",
    "ProgressEmitter",
    "ProgressTraceWriter",
    "format_completed_summary",
    "format_drafting_summary",
    "format_error_summary",
    "format_finding_summary",
    "format_started_summary",
    "is_draft_tool",
    "is_search_tool",
]
