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

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import StructuredTool
from langchain_core.tools.base import ToolException

from deerflow.sophia.tools.start_builder_task import _TERMINAL_TASK_STATUSES

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

    def _is_terminal(state: dict | None, task_id: str) -> tuple[bool, dict | None]:
        if not isinstance(state, dict):
            return False, None
        tasks = state.get("async_tasks") or {}
        if not isinstance(tasks, dict):
            return False, None
        tracked = tasks.get(task_id) or tasks.get(task_id.strip() if isinstance(task_id, str) else task_id)
        if not isinstance(tracked, dict):
            return False, None
        return tracked.get("status") in _TERMINAL_TASK_STATUSES, tracked

    def update_async_task(
        task_id: str,
        message: str,
        runtime,
    ):
        state = runtime.state if runtime is not None else {}
        is_terminal, tracked = _is_terminal(state, task_id)
        if is_terminal and tracked is not None:
            logger.info(
                "[Builder] update_async_task redirected: task_id=%s "
                "status=%s (terminal — directing model to start_builder_task)",
                task_id,
                tracked.get("status"),
            )
            return _terminal_redirect_message(task_id, tracked)
        if native_func is None:
            raise ToolException(
                "Native update_async_task sync func is unavailable; call this "
                "tool from the async path or upgrade deepagents."
            )
        return native_func(task_id=task_id, message=message, runtime=runtime)

    async def aupdate_async_task(
        task_id: str,
        message: str,
        runtime,
    ):
        state = runtime.state if runtime is not None else {}
        is_terminal, tracked = _is_terminal(state, task_id)
        if is_terminal and tracked is not None:
            logger.info(
                "[Builder] update_async_task redirected: task_id=%s "
                "status=%s (terminal — directing model to start_builder_task)",
                task_id,
                tracked.get("status"),
            )
            return _terminal_redirect_message(task_id, tracked)
        # Cache says non-terminal — but the cache is maintained by
        # BuildAwarenessMiddleware with a ~10s TTL, plus the model's
        # 2-3s decision latency before this wrapper runs. A run that
        # finished during that window will still look running in cache.
        # Re-check live via SDK before delegating. On SDK failure we
        # fail-open and use the cached status (we never want to block a
        # legitimate update because of SDK transport issues).
        if tracked is not None:
            live_status = await _fetch_live_status(tracked)
            if live_status in _TERMINAL_TASK_STATUSES:
                tracked_now = {**tracked, "status": live_status}
                logger.info(
                    "[Builder] update_async_task redirected (live-check caught "
                    "stale cache): task_id=%s cached_status=%s live_status=%s",
                    task_id,
                    tracked.get("status"),
                    live_status,
                )
                return _terminal_redirect_message(task_id, tracked_now)
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
