"""BuilderProgressMiddleware — POST phase events to the gateway via webhook.

Phase 4H of the v3 streaming migration. Replaces the
``get_stream_writer`` approach (Phase 4G Stage 2, which depended on
``runs.join_stream`` HTTP delivery that doesn't work cross-process
against ``langgraph_runtime_inmem``) with a direct HTTP POST from
this middleware to the gateway's ``/internal/builder-progress``
endpoint.

The endpoint dispatches each event through a per-task
``ProgressRenderer`` (gateway-side ``BuilderProgressRegistry``) and
the channel's edit callback updates the Telegram placeholder via
``bot.edit_message_text``. See:

- ``backend/app/gateway/builder_progress/registry.py`` — the registry.
- ``backend/app/gateway/routers/builder_events.py::receive_builder_progress``
  — the webhook endpoint.
- ``backend/app/channels/telegram.py::_register_progress_entry`` and
  ``_edit_progress_placeholder`` — the channel wiring.

Why webhook instead of ``get_stream_writer``: the production
LangGraph service runs ``langgraph dev`` (in-mem runtime). Events
written via ``get_stream_writer`` go into that run's stream queue,
but cross-process HTTP ``runs.join_stream`` consumers don't receive
them reliably. We confirmed this in production smoke tests
2026-05-16/17 with chunks=0 for the full 120 s subscriber lifetime.

The webhook bypasses the SDK stream entirely — each phase event is
one HTTP POST that lands on the gateway in real time, while the
subscriber is connected. No replay buffer, no runtime contracts to
satisfy beyond "HTTP works between containers" (which we already
rely on for the terminal completion webhook).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import UTC, datetime
from typing import Any, NotRequired, TypedDict, override

import httpx
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


# Priority for same-turn arbitration (finalizing > drafting > researching).
_PHASE_PRIORITY: dict[str, int] = {
    _PHASE_FINALIZING: 3,
    _PHASE_DRAFTING: 2,
    _PHASE_RESEARCHING: 1,
}


# Gateway webhook configuration. Mirrors the existing builder-events
# completion webhook (``deerflow.sophia.builder_events._gateway_url``).
# Operators set ``SOPHIA_GATEWAY_URL`` on the LangGraph service to
# the Gateway's reachable URL (Render-internal or public).
_DEFAULT_GATEWAY_URL = "http://localhost:8001"
_WEBHOOK_PATH = "/internal/builder-progress"
_WEBHOOK_TIMEOUT_SECONDS = 2.0


def _gateway_url() -> str:
    return os.environ.get("SOPHIA_GATEWAY_URL", _DEFAULT_GATEWAY_URL).rstrip("/")


# Strong refs for fire-and-forget POST tasks. Without this set the
# tasks can be GC'd before they complete (v3-migration learning #4).
# Bounded — entries removed via add_done_callback(discard) on
# completion.
_POST_TASKS: set[asyncio.Task] = set()


class _ProgressPost(TypedDict, total=False):
    task_id: str
    run_id: str
    event_name: str
    data: Any
    parent_thread_id: str | None
    sequence: int | None
    occurred_at: str | None


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


def _pick_strongest_phase(tool_calls: list) -> str | None:
    """Return the highest-priority phase among the given tool_calls."""
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


def _resolve_task_id_and_run_id(runtime: Runtime) -> tuple[str | None, str | None]:
    """Extract ``(task_id, run_id)`` from runtime.execution_info.

    Per langgraph >= 1.0, ``runtime.execution_info`` is populated on
    every task with the running graph's identity. ``task_id`` is the
    builder's own thread_id; ``run_id`` is the LangGraph run id. Both
    are required to register/dispatch with the gateway registry.
    """
    info = getattr(runtime, "execution_info", None)
    if info is None:
        return None, None
    task_id = getattr(info, "thread_id", None)
    run_id = getattr(info, "run_id", None)
    if not isinstance(task_id, str) or not task_id:
        task_id = None
    if not isinstance(run_id, str) or not run_id:
        run_id = None
    return task_id, run_id


def _resolve_parent_thread_id(state: dict[str, Any]) -> str | None:
    delegation_context = state.get("delegation_context")
    if not isinstance(delegation_context, dict):
        return None
    parent_thread_id = delegation_context.get("parent_thread_id")
    return parent_thread_id if isinstance(parent_thread_id, str) and parent_thread_id else None


def _web_event_context(
    state: dict[str, Any],
    *,
    offset: int = 1,
) -> tuple[dict[str, Any], int | None]:
    """Build browser-stream metadata only for native delegated builder runs."""
    parent_thread_id = _resolve_parent_thread_id(state)
    if parent_thread_id is None:
        return {}, None
    last_sequence = state.get("builder_progress_sequence", 0)
    if not isinstance(last_sequence, int):
        last_sequence = 0
    sequence = last_sequence + offset
    return {
        "parent_thread_id": parent_thread_id,
        "sequence": sequence,
        "occurred_at": datetime.now(UTC).isoformat(),
    }, sequence


async def _post_progress_event(
    *,
    task_id: str,
    run_id: str,
    event_name: str,
    data: Any,
    parent_thread_id: str | None = None,
    sequence: int | None = None,
    occurred_at: str | None = None,
) -> None:
    """Fire one progress event at the gateway.

    Fire-and-forget — failures are logged and swallowed so a slow or
    failing gateway never blocks or crashes the builder. The artifact-
    delivery path remains independent and is the durability backstop.
    """
    url = f"{_gateway_url()}{_WEBHOOK_PATH}"
    payload = {
        "task_id": task_id,
        "run_id": run_id,
        "event_name": event_name,
        "data": data,
    }
    if parent_thread_id:
        payload["parent_thread_id"] = parent_thread_id
    if sequence is not None:
        payload["sequence"] = sequence
    if occurred_at:
        payload["occurred_at"] = occurred_at
    try:
        async with httpx.AsyncClient(timeout=_WEBHOOK_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload)
            if response.status_code >= 400:
                logger.warning(
                    "BuilderProgress: webhook rejected status=%s task_id=%s event=%s body=%s",
                    response.status_code,
                    task_id,
                    event_name,
                    response.text[:200],
                )
    except Exception:
        logger.debug(
            "BuilderProgress: webhook delivery failed task_id=%s event=%s",
            task_id,
            event_name,
            exc_info=True,
        )


def _schedule_post(
    *,
    task_id: str,
    run_id: str,
    event_name: str,
    data: Any,
    parent_thread_id: str | None = None,
    sequence: int | None = None,
    occurred_at: str | None = None,
) -> None:
    """Schedule a webhook POST without awaiting it.

    Builder-side fire-and-forget: the middleware hooks return as soon
    as the POST is scheduled so the langgraph graph doesn't wait on
    the gateway. Strong-ref tracking via ``_POST_TASKS`` (with
    discard-on-done) prevents GC of in-flight tasks (v3-migration
    learning #4).
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No active loop — middleware was invoked from a sync context
        # we don't expect. Log at debug and skip (the artifact path
        # is still the durability backstop).
        logger.debug(
            "BuilderProgress: no running loop; skipping webhook task_id=%s",
            task_id,
        )
        return
    task = loop.create_task(
        _post_progress_event(
            task_id=task_id,
            run_id=run_id,
            event_name=event_name,
            data=data,
            parent_thread_id=parent_thread_id,
            sequence=sequence,
            occurred_at=occurred_at,
        )
    )
    _POST_TASKS.add(task)
    task.add_done_callback(_POST_TASKS.discard)


async def _post_progress_events_in_order(events: list[_ProgressPost]) -> None:
    for event in events:
        await _post_progress_event(**event)


def _schedule_ordered_posts(events: list[_ProgressPost]) -> None:
    """Schedule multiple webhook POSTs in the order provided."""
    if not events:
        return
    if len(events) == 1:
        _schedule_post(**events[0])
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug(
            "BuilderProgress: no running loop; skipping ordered webhook batch task_id=%s",
            events[0].get("task_id"),
        )
        return
    task = loop.create_task(_post_progress_events_in_order(events))
    _POST_TASKS.add(task)
    task.add_done_callback(_POST_TASKS.discard)


def _phase_post(
    task_id: str,
    run_id: str,
    phase: str,
    event_context: dict[str, Any] | None = None,
) -> _ProgressPost:
    return {
        "task_id": task_id,
        "run_id": run_id,
        "event_name": "custom",
        "data": {"name": "phase", "phase": phase},
        **(event_context or {}),
    }


def _emit_phase(
    task_id: str,
    run_id: str,
    phase: str,
    event_context: dict[str, Any] | None = None,
) -> None:
    """Send a ``{name: "phase", phase: <phase>}`` custom event."""
    _schedule_post(**_phase_post(task_id, run_id, phase, event_context))


# Codex P1 (post-Phase-4I review): per-tool argument allow-list. The
# renderer's ``_format_tool_detail`` (in
# ``app/channels/telegram_progress_renderer.py``) only reads a small
# subset of fields from each tool's args:
#
#   - search/tavily_search/web_search → args["query"]
#   - web_fetch/jina_fetch/builder_web_fetch → args["url"]
#   - write_file/str_replace → args["path"] or args["file_path"]
#   - bash → args["command"]
#
# Forwarding the full args dict — which for ``write_file`` includes the
# ENTIRE document body in ``args["content"]`` — would balloon every
# progress webhook to hundreds of kilobytes for a long-form build,
# risking proxy/body-limit drops AND wasting bandwidth between the
# langgraph service and the gateway. We strip down to a known-safe
# minimal projection per tool here, in the langgraph process, BEFORE
# the POST goes out.
_ARG_ALLOWLIST_BY_TOOL: dict[str, tuple[str, ...]] = {
    # Research / web tools — renderer reads query / url.
    "builder_web_search": ("query",),
    "web_search": ("query",),
    "tavily_search": ("query",),
    "builder_web_fetch": ("url",),
    "web_fetch": ("url",),
    "jina_fetch": ("url",),
    # Draft tools — renderer reads path / file_path.
    "write_file": ("path", "file_path"),
    "str_replace": ("path", "file_path"),
    "edit_file": ("path", "file_path"),
    # Bash — renderer reads command (and only the first 60 chars).
    "bash": ("command",),
    # Finalize tools — renderer doesn't read any args at all.
    "emit_builder_artifact": (),
    "emit_artifact": (),
    "render_markdown_to_pdf": (),
}

# Hard upper bound on per-arg string length we'll ship to the gateway.
# The renderer truncates at 60-80 chars anyway; carrying anything
# longer is dead weight on the wire. Larger than the rendered max so
# we don't accidentally clip mid-word; small enough that even a worst
# case ~10-tool batch stays well under any sane proxy body limit.
_MAX_ARG_VALUE_CHARS = 240


def _trim_tool_args(name: str, args: dict) -> dict:
    """Return a renderer-safe projection of ``args``.

    Looks up the tool's allow-list in ``_ARG_ALLOWLIST_BY_TOOL`` and
    keeps only those keys. Falls back to an empty dict for unknown
    tools (the renderer renders them with a generic 🔧 prefix and
    only the tool name — no args read). String values are clipped
    to ``_MAX_ARG_VALUE_CHARS``.
    """
    allow = _ARG_ALLOWLIST_BY_TOOL.get(name.lower() if isinstance(name, str) else "")
    if allow is None:
        # Unknown tool — renderer doesn't read args for these.
        return {}
    if not allow:
        return {}
    out: dict = {}
    for key in allow:
        if not isinstance(args, dict):
            continue
        if key not in args:
            continue
        value = args[key]
        if isinstance(value, str) and len(value) > _MAX_ARG_VALUE_CHARS:
            value = value[: _MAX_ARG_VALUE_CHARS - 1] + "…"
        out[key] = value
    return out


def _updates_post(
    task_id: str,
    run_id: str,
    tool_calls: list,
    event_context: dict[str, Any] | None = None,
) -> _ProgressPost | None:
    """Build an ``updates`` event carrying the latest tool_calls.

    The renderer's ``_on_updates`` extracts tool_calls from the
    ``{node_name: {messages: [{tool_calls: [...]}]}}`` envelope so we
    rebuild that shape from a list of tool_call dicts. The agent-node
    name is irrelevant to the renderer — it iterates all nodes — so
    we use a stable placeholder.

    Codex P1 (post-Phase-4I review): each call's ``args`` is trimmed
    to a renderer-safe projection via ``_trim_tool_args`` before
    serialization. This prevents huge fields like ``write_file.content``
    (entire markdown deliverables) from being shipped to the gateway
    on every model turn.
    """
    # Tool-call dicts are JSON-serializable as-is (name/args structure).
    # If callers pass non-dict tool_calls (SimpleNamespace etc), they
    # won't serialize cleanly. We dict-coerce defensively.
    serializable: list[dict] = []
    for call in tool_calls:
        if isinstance(call, dict):
            name = call.get("name")
            raw_args = call.get("args") or {}
        else:
            name = getattr(call, "name", None)
            raw_args = getattr(call, "args", None) or {}
        if not name:
            continue
        trimmed_args = _trim_tool_args(str(name), raw_args if isinstance(raw_args, dict) else {})
        serializable.append({"name": name, "args": trimmed_args})
    if not serializable:
        return None
    return {
        "task_id": task_id,
        "run_id": run_id,
        "event_name": "updates",
        "data": {"agent": {"messages": [{"tool_calls": serializable}]}},
        **(event_context or {}),
    }


def _emit_updates(
    task_id: str,
    run_id: str,
    tool_calls: list,
    event_context: dict[str, Any] | None = None,
) -> None:
    """Send an ``updates`` event carrying the latest tool_calls."""
    post = _updates_post(task_id, run_id, tool_calls, event_context)
    if post is not None:
        _schedule_post(**post)


def _latest_ai_tool_calls(messages: list) -> list:
    for msg in reversed(messages):
        if getattr(msg, "type", None) == "ai":
            return list(getattr(msg, "tool_calls", []) or [])
    return []


def _sequence_update(sequence: int | None) -> dict[str, Any] | None:
    return {"builder_progress_sequence": sequence} if sequence is not None else None


class BuilderProgressState(AgentState):
    builder_progress_last_phase: NotRequired[str]
    builder_progress_sequence: NotRequired[int]


class BuilderProgressMiddleware(AgentMiddleware[BuilderProgressState]):
    """POST ``custom``/``updates`` progress events to the gateway.

    Hooks (async variants — langgraph runs async):

    - ``abefore_agent`` — emits ``starting`` phase.
    - ``aafter_model`` — inspects the latest AI message's tool_calls;
      classifies via lowercase-substring match (same-turn arbitration
      via ``_PHASE_PRIORITY``); emits the strongest phase + the raw
      tool_calls (so the renderer's ``updates`` handler can build
      activity lines like "🔍 Searching: best EVs").
    - ``aafter_agent`` — emits ``done``.

    State field ``builder_progress_last_phase`` tracks the last-emitted
    phase to skip redundant transitions on multi-tool-call batches
    sharing the same phase.

    Defensive: missing task_id/run_id (execution_info not populated)
    short-circuits to a debug log. Webhook failures are logged at
    debug and swallowed.
    """

    state_schema = BuilderProgressState

    @override
    async def abefore_agent(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        last_phase = state.get("builder_progress_last_phase")
        if last_phase == _PHASE_STARTING:
            log_middleware("BuilderProgress", "already started, skipping", _t0)
            return None
        task_id, run_id = _resolve_task_id_and_run_id(runtime)
        if task_id is None or run_id is None:
            log_middleware("BuilderProgress", "no task_id/run_id in runtime", _t0)
            return {"builder_progress_last_phase": _PHASE_STARTING}
        web_context, sequence = _web_event_context(state)
        _emit_phase(task_id, run_id, _PHASE_STARTING, web_context)
        log_middleware(
            "BuilderProgress",
            f"abefore_agent emit phase={_PHASE_STARTING} task_id={task_id}",
            _t0,
        )
        update = {"builder_progress_last_phase": _PHASE_STARTING}
        if sequence is not None:
            update["builder_progress_sequence"] = sequence
        return update

    @override
    async def aafter_model(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        messages = state.get("messages", []) or []
        tool_calls = _latest_ai_tool_calls(messages)
        if not tool_calls:
            log_middleware("BuilderProgress", "no tool_calls in latest AI msg", _t0)
            return None
        new_phase = _pick_strongest_phase(tool_calls)
        task_id, run_id = _resolve_task_id_and_run_id(runtime)
        if task_id is None or run_id is None:
            log_middleware("BuilderProgress", "no task_id/run_id; skip POST", _t0)
            return None
        # Always emit the tool_calls (activity lines like searching/drafting).
        updates_context, updates_sequence = _web_event_context(state)
        updates_post = _updates_post(task_id, run_id, tool_calls, updates_context)
        if updates_post is None:
            log_middleware("BuilderProgress", "no serializable tool_calls", _t0)
            return None
        if new_phase is None:
            _schedule_ordered_posts([updates_post])
            log_middleware("BuilderProgress", "tool_calls emitted, no phase change", _t0)
            return _sequence_update(updates_sequence)
        last_phase = state.get("builder_progress_last_phase")
        if new_phase == last_phase:
            _schedule_ordered_posts([updates_post])
            log_middleware(
                "BuilderProgress",
                f"phase unchanged ({new_phase}); tool_calls emitted only",
                _t0,
            )
            return _sequence_update(updates_sequence)
        phase_context, phase_sequence = _web_event_context(state, offset=2)
        _schedule_ordered_posts([
            updates_post,
            _phase_post(task_id, run_id, new_phase, phase_context),
        ])
        log_middleware(
            "BuilderProgress",
            f"aafter_model emit phase={new_phase} task_id={task_id}",
            _t0,
        )
        update = {"builder_progress_last_phase": new_phase}
        if phase_sequence is not None:
            update["builder_progress_sequence"] = phase_sequence
        return update

    @override
    async def aafter_agent(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        last_phase = state.get("builder_progress_last_phase")
        if last_phase == _PHASE_DONE:
            log_middleware("BuilderProgress", "already done, skipping", _t0)
            return None
        task_id, run_id = _resolve_task_id_and_run_id(runtime)
        if task_id is None or run_id is None:
            log_middleware("BuilderProgress", "no task_id/run_id; skip POST", _t0)
            return {"builder_progress_last_phase": _PHASE_DONE}
        web_context, sequence = _web_event_context(state)
        _emit_phase(task_id, run_id, _PHASE_DONE, web_context)
        log_middleware(
            "BuilderProgress",
            f"aafter_agent emit phase={_PHASE_DONE} task_id={task_id}",
            _t0,
        )
        update = {"builder_progress_last_phase": _PHASE_DONE}
        if sequence is not None:
            update["builder_progress_sequence"] = sequence
        return update


__all__ = ["BuilderProgressMiddleware"]
