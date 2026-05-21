"""Terminal-thread guard for the deepagents-native ``update_async_task``.

Phase 2B of the post-PR-#129 follow-up. The model-side fix in PR #129
correctly teaches the companion to call ``update_async_task`` on
modification cues mid-build — but when the user's update arrives AFTER
the builder has already reached terminal status (success / completed /
error / cancelled / etc.), the native ``update_async_task`` still
creates a new run on the just-finished builder thread.

The new run inherits a message history that already contains the
completed ``tool_use`` → ``tool_result`` → ``emit_builder_artifact``
sequence. The builder model then loops in ``DanglingToolCallMiddleware``
for minutes (~3.5 min in the 2026-05-20 19:53–19:57 incident),
locking the single worker (or, post-2A, one of the 10 workers) and
producing no useful output for the user.

This wrapper:

- Pre-screens the target ``task_id`` against
  ``async_tasks[task_id]["status"]`` (the cached status maintained by
  ``BuildAwarenessMiddleware``).
- If the cache says terminal — redirect with the directive ToolMessage,
  no SDK dispatch.
- If the cache says non-terminal — perform a **live** SDK re-check
  against the run before delegating. The cache can be up to
  ``BuildAwarenessMiddleware._REFRESH_TTL_SECONDS`` (~10s) stale, plus
  the model's own 2-3s decision latency on top, so a run that finished
  during the window can still appear running here. The live check
  closes this race. SDK failures fall back to the cache and delegate
  (fail-open — we never block on SDK transport issues).
- Otherwise delegates to the deepagents-native ``update_async_task``
  implementation (the wrapper holds a reference to it).

Registration mirrors the ``start_builder_task`` pattern in
``deerflow.agents.sophia_agent.agent``: the native tool is filtered out
of ``AsyncSubAgentMiddleware.tools`` and the wrapper is registered in
its place. The wrapped name is identical (``update_async_task``) so the
model's tool-selection from PR #129 remains valid.
"""

import logging
from typing import Any

from langchain.tools import ToolRuntime
from langchain_core.tools import StructuredTool
from langchain_core.tools.base import ToolException

from deerflow.sophia.tools.start_builder_task import _TERMINAL_TASK_STATUSES

# NOTE: this module deliberately does NOT use `from __future__ import
# annotations`. LangChain's tool-runtime injection introspects parameter
# annotations to identify ToolRuntime-typed args (the marker for "inject
# this from the execution context, not from the model's tool_call"). With
# `from __future__ import annotations`, every annotation becomes a forward-
# reference STRING and the introspection comparison `annotation is
# ToolRuntime` fails — LangChain then calls the wrapper with only the
# args_schema fields and Python raises `TypeError: ... missing 1 required
# positional argument: 'runtime'`. This was the production failure at
# 2026-05-21 19:28 UTC. Keep annotations evaluated at runtime here.

logger = logging.getLogger(__name__)


async def _fetch_live_status(tracked: dict[str, Any]) -> str | None:
    """Fetch live run status from the LangGraph SDK to defeat cache staleness.

    Returns the live status string on success, or ``None`` on any failure
    (SDK transport error, missing identifiers, non-dict response). Caller
    treats ``None`` as "no live signal — fall back to cached status",
    NEVER as "terminal". This is fail-open by design: an unreachable SDK
    must not block a legitimate update_async_task dispatch.

    Mirrors ``BuildAwarenessMiddleware._refresh_task_status`` — same
    in-process ASGI client (``url=None``), same exception-swallow
    semantics, same dict-shape tolerance.
    """
    thread_id = tracked.get("thread_id") or tracked.get("task_id")
    run_id = tracked.get("run_id")
    if not thread_id or not run_id:
        return None
    try:
        from langgraph_sdk import get_client  # local import: avoids hard dep at module load

        client = get_client(url=None)  # ASGI in-process
        run = await client.runs.get(thread_id=thread_id, run_id=run_id)
    except Exception:  # noqa: BLE001 — never let SDK errors raise out of the wrapper
        logger.debug(
            "update_async_task_wrapper: live status check failed for task_id=%s",
            tracked.get("task_id"),
            exc_info=True,
        )
        return None
    if isinstance(run, dict):
        status = run.get("status")
        if isinstance(status, str):
            return status
    return None


def _terminal_redirect_message(task_id: str, tracked: dict[str, Any]) -> str:
    """Build the directive ToolMessage returned to the model when the target
    builder has already reached terminal status."""
    status = tracked.get("status", "unknown")
    task_type = tracked.get("task_type") or "build"
    return (
        f"The builder task (task_id={task_id}) has already reached terminal "
        f"status (status={status}). update_async_task CANNOT modify a finished "
        f"build — its dispatch would create a new run on a thread whose "
        f"message history is already complete, looping the builder on dangling "
        f"tool calls.\n"
        f"\n"
        f"The previous {task_type} artifact has already been delivered to the "
        f"user (Telegram / web). The user has it.\n"
        f"\n"
        f"If the user wants the change incorporated, your NEXT tool call MUST "
        f"be start_builder_task(description=..., task_type=\"{task_type}\") "
        f"with a complete brief that references the prior artifact's contents "
        f"inline (e.g. \"Building on the prior recursive_llms_research.md "
        f"artifact, add a section on <X>...\"). emit_artifact ONCE on the same "
        f"turn with takeaway like \"Got it — kicking off a fresh build that "
        f"adds X to the previous version.\"\n"
        f"\n"
        f"Do NOT call update_async_task again on this task_id — it is terminal."
    )


def _resolve_tracked(state: dict | None, task_id: str) -> dict | None:
    """Look up the tracked task entry from ``state["async_tasks"]``.

    Returns the entry dict on success, ``None`` if the state shape is
    unexpected or the task is not tracked. Tolerates both the exact
    ``task_id`` and a stripped variant (matches the deepagents-native
    ``_resolve_tracked_task`` lookup semantics).
    """
    if not isinstance(state, dict):
        return None
    tasks = state.get("async_tasks") or {}
    if not isinstance(tasks, dict):
        return None
    key = task_id.strip() if isinstance(task_id, str) else task_id
    tracked = tasks.get(task_id) or tasks.get(key)
    return tracked if isinstance(tracked, dict) else None


def _cache_redirect_if_terminal(task_id: str, state: dict | None) -> str | None:
    """If the cached status is terminal, log + return the redirect string.
    Otherwise return ``None`` so the caller delegates to the native dispatch.
    Used by both sync and async paths.
    """
    tracked = _resolve_tracked(state, task_id)
    if tracked is None or tracked.get("status") not in _TERMINAL_TASK_STATUSES:
        return None
    logger.info(
        "[Builder] update_async_task redirected: task_id=%s "
        "status=%s (terminal — directing model to start_builder_task)",
        task_id,
        tracked.get("status"),
    )
    return _terminal_redirect_message(task_id, tracked)


async def _cache_or_live_redirect_if_terminal(
    task_id: str, state: dict | None
) -> str | None:
    """Async path: check cache first; if non-terminal, re-check live SDK to
    defeat cache staleness (BuildAwarenessMiddleware TTL ~10s + model
    decision latency ~3s). On live-terminal, log + return redirect. On
    SDK failure or live-running, return ``None`` so the caller delegates.
    """
    # Cache-terminal branch (no live check needed).
    cache_redirect = _cache_redirect_if_terminal(task_id, state)
    if cache_redirect is not None:
        return cache_redirect

    # Cache says non-terminal (or unknown). For the known-but-non-terminal
    # case, re-check live SDK to close the stale-cache window.
    tracked = _resolve_tracked(state, task_id)
    if tracked is None:
        return None  # Unknown task — let native return its own error.
    live_status = await _fetch_live_status(tracked)
    if live_status not in _TERMINAL_TASK_STATUSES:
        return None  # Still running or SDK failed — delegate.

    tracked_now = {**tracked, "status": live_status}
    logger.info(
        "[Builder] update_async_task redirected (live-check caught "
        "stale cache): task_id=%s cached_status=%s live_status=%s",
        task_id,
        tracked.get("status"),
        live_status,
    )
    return _terminal_redirect_message(task_id, tracked_now)


def make_update_async_task_wrapper(native_tool: StructuredTool) -> StructuredTool:
    """Build a terminal-thread-guarded wrapper around the deepagents-native
    ``update_async_task`` tool.

    The wrapper holds a reference to the native tool's underlying ``func`` /
    ``coroutine`` so it can delegate on the non-terminal path without
    re-implementing the SDK dispatch logic that lives in
    ``deepagents.middleware.async_subagents``.
    """
    if native_tool is None:
        raise ValueError(
            "make_update_async_task_wrapper requires the native "
            "update_async_task StructuredTool — pass the instance from "
            "AsyncSubAgentMiddleware.tools before filtering it out."
        )
    if native_tool.name != "update_async_task":
        raise ValueError(
            f"Expected native tool named 'update_async_task', got "
            f"{native_tool.name!r}."
        )

    native_func = native_tool.func
    native_coroutine = native_tool.coroutine

    def update_async_task(
        task_id: str,
        message: str,
        runtime: ToolRuntime,
    ):
        # Sync path: cache-only check. The live SDK call is async-only;
        # production langgraph always uses the async coroutine below. Sync
        # is exercised by tests only. Mirrors BuildAwareness's sync/async
        # asymmetry (sync `before_agent` is cache-only; async refreshes).
        state = runtime.state if runtime is not None else {}
        redirect = _cache_redirect_if_terminal(task_id, state)
        if redirect is not None:
            return redirect
        if native_func is None:
            raise ToolException(
                "Native update_async_task sync func is unavailable; call this "
                "tool from the async path or upgrade deepagents."
            )
        return native_func(task_id=task_id, message=message, runtime=runtime)

    async def aupdate_async_task(
        task_id: str,
        message: str,
        runtime: ToolRuntime,
    ):
        state = runtime.state if runtime is not None else {}
        redirect = await _cache_or_live_redirect_if_terminal(task_id, state)
        if redirect is not None:
            return redirect
        if native_coroutine is None:
            raise ToolException(
                "Native update_async_task coroutine is unavailable."
            )
        return await native_coroutine(
            task_id=task_id, message=message, runtime=runtime
        )

    return StructuredTool.from_function(
        name=native_tool.name,
        func=update_async_task,
        coroutine=aupdate_async_task,
        description=native_tool.description,
        infer_schema=False,
        args_schema=native_tool.args_schema,
    )
