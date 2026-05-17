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
from typing import Any, NotRequired, override

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


async def _post_progress_event(
    *,
    task_id: str,
    run_id: str,
    event_name: str,
    data: Any,
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
        )
    )
    _POST_TASKS.add(task)
    task.add_done_callback(_POST_TASKS.discard)


def _emit_phase(task_id: str, run_id: str, phase: str) -> None:
    """Send a ``{name: "phase", phase: <phase>}`` custom event."""
    _schedule_post(
        task_id=task_id,
        run_id=run_id,
        event_name="custom",
        data={"name": "phase", "phase": phase},
    )


def _emit_updates(task_id: str, run_id: str, tool_calls: list) -> None:
    """Send an ``updates`` event carrying the latest tool_calls.

    The renderer's ``_on_updates`` extracts tool_calls from the
    ``{node_name: {messages: [{tool_calls: [...]}]}}`` envelope so we
    rebuild that shape from a list of tool_call dicts. The agent-node
    name is irrelevant to the renderer — it iterates all nodes — so
    we use a stable placeholder.
    """
    # Tool-call dicts are JSON-serializable as-is (name/args structure).
    # If callers pass non-dict tool_calls (SimpleNamespace etc), they
    # won't serialize cleanly. We dict-coerce defensively.
    serializable: list[dict] = []
    for call in tool_calls:
        if isinstance(call, dict):
            serializable.append({"name": call.get("name"), "args": call.get("args") or {}})
        else:
            name = getattr(call, "name", None)
            args = getattr(call, "args", None) or {}
            if name:
                serializable.append({"name": name, "args": args if isinstance(args, dict) else {}})
    if not serializable:
        return
    _schedule_post(
        task_id=task_id,
        run_id=run_id,
        event_name="updates",
        data={"agent": {"messages": [{"tool_calls": serializable}]}},
    )


class BuilderProgressState(AgentState):
    builder_progress_last_phase: NotRequired[str]


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
        _emit_phase(task_id, run_id, _PHASE_STARTING)
        log_middleware(
            "BuilderProgress",
            f"abefore_agent emit phase={_PHASE_STARTING} task_id={task_id}",
            _t0,
        )
        return {"builder_progress_last_phase": _PHASE_STARTING}

    @override
    async def aafter_model(
        self, state: BuilderProgressState, runtime: Runtime
    ) -> dict[str, Any] | None:
        _t0 = time.perf_counter()
        messages = state.get("messages", []) or []
        tool_calls: list = []
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue
            raw = getattr(msg, "tool_calls", []) or []
            tool_calls = list(raw)
            break
        if not tool_calls:
            log_middleware("BuilderProgress", "no tool_calls in latest AI msg", _t0)
            return None
        new_phase = _pick_strongest_phase(tool_calls)
        task_id, run_id = _resolve_task_id_and_run_id(runtime)
        if task_id is None or run_id is None:
            log_middleware("BuilderProgress", "no task_id/run_id; skip POST", _t0)
            return None
        # Always emit the tool_calls (activity lines like 🔍 Searching).
        _emit_updates(task_id, run_id, tool_calls)
        if new_phase is None:
            log_middleware("BuilderProgress", "tool_calls emitted, no phase change", _t0)
            return None
        last_phase = state.get("builder_progress_last_phase")
        if new_phase == last_phase:
            log_middleware(
                "BuilderProgress",
                f"phase unchanged ({new_phase}); tool_calls emitted only",
                _t0,
            )
            return None
        _emit_phase(task_id, run_id, new_phase)
        log_middleware(
            "BuilderProgress",
            f"aafter_model emit phase={new_phase} task_id={task_id}",
            _t0,
        )
        return {"builder_progress_last_phase": new_phase}

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
        _emit_phase(task_id, run_id, _PHASE_DONE)
        log_middleware(
            "BuilderProgress",
            f"aafter_agent emit phase={_PHASE_DONE} task_id={task_id}",
            _t0,
        )
        return {"builder_progress_last_phase": _PHASE_DONE}


__all__ = ["BuilderProgressMiddleware"]
