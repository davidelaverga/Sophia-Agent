"""BuilderProgressMiddleware — emit phase events into the LangGraph stream.

Phase 4G of the v3 streaming migration. Restores the live-progress UX
that PR #120 had ("drafting", "researching", "writing file", etc.
inside the Telegram placeholder). Two parts to that UX:

1. **Subscriber side** — ``BuilderProgressSubscriber`` opens
   ``client.runs.join_stream(thread_id, run_id, stream_mode=[...])``,
   iterates ``StreamPart`` chunks, and feeds them to ``ProgressRenderer``
   which produces ``[ Researching ]`` / ``[ Drafting ]`` headers and
   emoji-prefixed activity lines for ``edit_message_text``.

2. **Emitter side** — THIS middleware. Calls
   ``langgraph.config.get_stream_writer()`` at builder lifecycle hooks
   and pushes ``{"name": "phase", "phase": "<event>"}`` payloads into
   the stream. The subscriber catches them as ``custom``-mode events
   and the renderer's ``_on_custom`` handler updates the phase header.

The native langgraph runtime ALSO emits ``messages-tuple`` (per-token
deltas) and ``updates`` (state deltas including tool_calls) — both are
subscribed to by the consumer. But ``langgraph_runtime_inmem`` (the
``langgraph dev`` runtime production runs) may not durably replay
those modes for late-joining HTTP subscribers. This middleware's
``custom`` events are emitted DURING the run while the subscriber is
already connected, so no replay-buffer reliance.

The existing ``deerflow.sophia.builder_progress.ProgressEmitter``
(added 2026-05-04 in PR-#120 commit ``36c32ac3``) classifies phase
events with throttling + trace-file persistence. We reuse its event-
type taxonomy (``ProgressEventType.STARTED`` /
``DRAFTING`` / ``COMPLETED`` / ``ERROR``) but route output to
``get_stream_writer`` instead of (or in addition to) the JSONL trace.

Position in chain: between ``BuilderResearchPolicyMiddleware`` and
``TodoMiddleware``. After research-policy because we want to emit
``started`` after the brief has been built (so the user sees the
placeholder transition once the actual work begins), before the artifact
verifier so we can emit ``finalizing`` as soon as the model emits
``emit_builder_artifact``.

Defensive: ``get_stream_writer()`` returns None when called outside an
active langgraph run (e.g. in unit tests). The middleware logs at
debug and skips emission in that case — never crashes.
"""

from __future__ import annotations

import logging
import time
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


# Phase strings shipped to the subscriber via ``custom`` events. These
# match the keys ``ProgressRenderer._PHASE_LABELS`` expects in
# ``app/channels/telegram_progress_renderer.py``.
_PHASE_STARTING = "starting"
_PHASE_RESEARCHING = "researching"
_PHASE_DRAFTING = "drafting"
_PHASE_FINALIZING = "finalizing"
_PHASE_DONE = "done"


# Tool name → phase mapping. Lowercased substring match — captures
# both ``builder_web_search`` and ``web_search``, etc.
_RESEARCH_TOOL_SUBSTRINGS = (
    "search",
    "fetch",
    "browse",
    "scrape",
    "tavily",
    "jina",
    "firecrawl",
)
_DRAFTING_TOOL_SUBSTRINGS = (
    "write_file",
    "str_replace",
    "edit_file",
)
_FINALIZING_TOOL_SUBSTRINGS = (
    "emit_builder_artifact",
    "emit_artifact",
    "render_markdown_to_pdf",
)


def _classify_tool(tool_name: str) -> str | None:
    """Return the phase a tool call should transition to, or None."""
    if not isinstance(tool_name, str) or not tool_name:
        return None
    lowered = tool_name.lower()
    if any(tok in lowered for tok in _FINALIZING_TOOL_SUBSTRINGS):
        return _PHASE_FINALIZING
    if any(tok in lowered for tok in _DRAFTING_TOOL_SUBSTRINGS):
        return _PHASE_DRAFTING
    if any(tok in lowered for tok in _RESEARCH_TOOL_SUBSTRINGS):
        return _PHASE_RESEARCHING
    return None


# Priority order for the same-turn phase-arbitration in
# ``after_model``: when an AI message has multiple tool_calls in one
# batch (e.g. a final search alongside ``emit_builder_artifact``), the
# strongest signal wins. ``finalizing`` > ``drafting`` > ``researching``.
# Out-of-band phases (``starting`` / ``done``) come from lifecycle
# hooks, not tool_call inspection, and so are not part of this table.
_PHASE_PRIORITY: dict[str, int] = {
    _PHASE_FINALIZING: 3,
    _PHASE_DRAFTING: 2,
    _PHASE_RESEARCHING: 1,
}


def _pick_strongest_phase(tool_calls: list) -> str | None:
    """Return the highest-priority phase among the given tool_calls, or None."""
    best_phase: str | None = None
    best_priority = 0
    for call in tool_calls:
        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
        phase = _classify_tool(str(name) if name else "")
        if phase is None:
            continue
        priority = _PHASE_PRIORITY.get(phase, 0)
        if priority > best_priority:
            best_phase = phase
            best_priority = priority
    return best_phase


def _get_stream_writer() -> Any | None:
    """Return a callable that pushes payloads into the current run's stream.

    Wrapped in a try/except so unit tests (no langgraph context) and
    callers running outside an active run see ``None`` and skip
    emission cleanly. LangGraph's ``get_stream_writer`` raises
    ``RuntimeError`` when called outside a run context.
    """
    try:
        from langgraph.config import get_stream_writer
    except ImportError:
        logger.debug("BuilderProgress: langgraph.config.get_stream_writer not importable")
        return None
    try:
        return get_stream_writer()
    except Exception:
        # No active run context — happens in tests or before the
        # graph node is actually executing. Not an error.
        return None


def _emit_phase(phase: str) -> None:
    """Push a ``{"name": "phase", "phase": phase}`` event into the run's stream.

    Safe to call from anywhere — silently no-ops if the stream writer
    is unavailable. The subscriber's renderer handles unknown phases
    by falling back to a capitalised version of the string in the
    header.
    """
    writer = _get_stream_writer()
    if writer is None:
        return
    try:
        writer({"name": "phase", "phase": phase})
    except Exception:
        # Never let a streaming-side issue crash the builder.
        logger.warning(
            "BuilderProgress: stream writer raised on phase=%s",
            phase,
            exc_info=True,
        )


class BuilderProgressState(AgentState):
    # Track the last-emitted phase to avoid spamming the stream with
    # redundant transitions on every tool-call batch. Reducer is
    # last-write-wins (default) which matches the "one phase at a time"
    # semantic.
    builder_progress_last_phase: NotRequired[str]


class BuilderProgressMiddleware(AgentMiddleware[BuilderProgressState]):
    """Emit ``custom``-mode phase events for the builder's progress UX.

    Hooks:

    - ``before_agent`` — emits ``starting`` so the placeholder
      transitions off the initial "Working on it…" body.
    - ``after_model`` — inspects tool_calls on the latest AI message;
      maps tool names → phase strings via ``_classify_tool``; emits
      iff the phase changed. Search/fetch tools → ``researching``,
      write/edit tools → ``drafting``, ``emit_builder_artifact`` →
      ``finalizing``.
    - ``after_agent`` — emits ``done`` so the placeholder finalizes
      with a ``[ Done ]`` header. The artifact-delivery webhook
      (``_on_builder_completion``) still fires independently for the
      document attachment.

    Single source of truth for phase classification is the lowercase-
    substring match in ``_classify_tool``. Adding a new tool to one
    of the substring tuples is the minimal change to extend coverage.
    """

    state_schema = BuilderProgressState

    @override
    def before_agent(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        last_phase = state.get("builder_progress_last_phase")
        if last_phase == _PHASE_STARTING:
            log_middleware("BuilderProgress", "already started, skipping", _t0)
            return None
        _emit_phase(_PHASE_STARTING)
        log_middleware("BuilderProgress", f"emit phase={_PHASE_STARTING}", _t0)
        return {"builder_progress_last_phase": _PHASE_STARTING}

    @override
    def after_model(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        messages = state.get("messages", []) or []
        new_phase: str | None = None
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue
            tool_calls = getattr(msg, "tool_calls", []) or []
            # Same-turn arbitration: ``emit_builder_artifact`` (finalizing)
            # alongside a sibling search call is "finalizing wins". See
            # ``_PHASE_PRIORITY`` table for the ordering rationale.
            new_phase = _pick_strongest_phase(tool_calls)
            break  # only inspect the latest AI message
        if new_phase is None:
            log_middleware("BuilderProgress", "no phase change", _t0)
            return None
        last_phase = state.get("builder_progress_last_phase")
        if new_phase == last_phase:
            log_middleware("BuilderProgress", f"phase unchanged ({new_phase})", _t0)
            return None
        _emit_phase(new_phase)
        log_middleware("BuilderProgress", f"emit phase={new_phase}", _t0)
        return {"builder_progress_last_phase": new_phase}

    @override
    def after_agent(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        last_phase = state.get("builder_progress_last_phase")
        if last_phase == _PHASE_DONE:
            log_middleware("BuilderProgress", "already done, skipping", _t0)
            return None
        _emit_phase(_PHASE_DONE)
        log_middleware("BuilderProgress", f"emit phase={_PHASE_DONE}", _t0)
        return {"builder_progress_last_phase": _PHASE_DONE}


__all__ = ["BuilderProgressMiddleware"]
