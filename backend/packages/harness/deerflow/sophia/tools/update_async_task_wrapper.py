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
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langchain_core.tools.base import ToolException
from langgraph.types import Command

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


def _canonical_task_id(task_id: str, tracked: dict[str, Any]) -> str:
    """Return the canonical task_id for state writes and prose.

    The model may pass a task_id with leading/trailing whitespace. The
    ``async_tasks`` dict is keyed by the **canonical** (stripped) id —
    every code path that writes to ``async_tasks`` in deepagents-native
    and ``start_builder_task`` uses ``tracked["task_id"]`` as the key
    (see ``deepagents/middleware/async_subagents.py:547,586,637,669``).
    If we wrote back under the raw key, the original canonical entry
    would stay non-terminal and ``_has_active_builder_task`` would still
    see an active build → reject the follow-up ``start_builder_task``
    (codex P2 review 2026-05-21, whitespace-tolerance class).

    Prefers ``tracked["task_id"]`` (entries always carry their own id by
    convention); falls back to the stripped input as a defensive default.
    """
    canonical = tracked.get("task_id")
    if isinstance(canonical, str) and canonical:
        return canonical
    if isinstance(task_id, str):
        return task_id.strip()
    return task_id  # exotic shape — leave it alone


def _terminal_redirect_message(task_id: str, tracked: dict[str, Any]) -> str:
    """Build the directive ToolMessage returned to the model when the target
    builder has already reached terminal status.

    The interpolated task_id is normalized to the canonical form so any
    follow-up tool calls (e.g. the model copying it into a description)
    use the canonical id, not the whitespace-padded raw form.
    """
    status = tracked.get("status", "unknown")
    task_type = tracked.get("task_type") or "build"
    canonical_id = _canonical_task_id(task_id, tracked)
    return (
        f"The builder task (task_id={canonical_id}) has already reached terminal "
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


# Sentinel substring used to detect whether a message has already been
# augmented by ``_augment_update_message``. Must be stable across calls
# because we want idempotency: the model may retry or compose multi-turn
# updates and we don't want the directive duplicated.
_FILE_TARGET_HINT_MARKER = "[Sophia/post-interrupt build directive]"


def _augment_update_message(
    message: str, tracked: dict[str, Any] | None
) -> str:
    """Augment the user's update message with a file-target directive for the
    builder. The directive lands in the builder's next HumanMessage after the
    interrupt and steers the model away from creating scratch files
    (``test.md``, ``test2.md``, etc.) — the production failure mode observed
    on 2026-05-21 21:18 UTC.

    If the wrapper can see a prior ``artifact_path`` on the tracked entry,
    the directive names the specific file the builder should continue
    editing. Otherwise it gives generic ``/mnt/user-data/outputs/`` guidance.

    Idempotent: if the marker is already present in ``message``, the
    function returns ``message`` unchanged so a retry / double-dispatch
    doesn't pile up directives.
    """
    if not isinstance(message, str):
        return message
    if _FILE_TARGET_HINT_MARKER in message:
        return message

    prior_path: str | None = None
    if isinstance(tracked, dict):
        candidate = tracked.get("artifact_path")
        if isinstance(candidate, str) and candidate:
            prior_path = candidate

    if prior_path:
        directive = (
            f"\n\n{_FILE_TARGET_HINT_MARKER}\n"
            f"You are continuing a previously-interrupted build. The prior run "
            f"produced an artifact at `{prior_path}`. CONTINUE editing that "
            f"exact file (or write the updated version under "
            f"`/mnt/user-data/outputs/`) — do NOT create scratch files like "
            f"`test.md` / `test2.md`. The final artifact path MUST be under "
            f"`/mnt/user-data/outputs/` so the platform can deliver it."
        )
    else:
        directive = (
            f"\n\n{_FILE_TARGET_HINT_MARKER}\n"
            f"You are continuing a previously-interrupted build. Find the "
            f"file(s) you were targeting under `/mnt/user-data/outputs/` "
            f"and CONTINUE editing them — do NOT create scratch files like "
            f"`test.md` / `test2.md`. The final artifact path MUST be under "
            f"`/mnt/user-data/outputs/` so the platform can deliver it."
        )
    return message + directive


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


async def _live_terminal_redirect(
    task_id: str, state: dict | None
) -> tuple[str, dict[str, dict]] | None:
    """Async-only second-pass check used when the cache says non-terminal.
    Re-checks live SDK status to defeat cache staleness
    (BuildAwarenessMiddleware TTL ~10s + model decision latency ~3s).

    Returns:
        - ``(redirect_msg, async_tasks_update)`` tuple when the live status
          is terminal but the cached status was not. The caller MUST persist
          the state update — otherwise the model's follow-up
          ``start_builder_task`` call will read the stale non-terminal cache
          via ``_has_active_builder_task`` and reject the relaunch as a
          duplicate (codex P1 review, 2026-05-21).
        - ``None`` when there is nothing to redirect: no tracked task,
          cache already terminal (handled by the cache-only helper), live
          status is non-terminal, or the SDK call failed (fail-open).
    """
    tracked = _resolve_tracked(state, task_id)
    if tracked is None:
        return None  # Unknown task — let native return its own error.
    if tracked.get("status") in _TERMINAL_TASK_STATUSES:
        return None  # Already handled by the cache-only path.
    live_status = await _fetch_live_status(tracked)
    if live_status not in _TERMINAL_TASK_STATUSES:
        return None  # Still running or SDK failed — delegate.

    tracked_now = {**tracked, "status": live_status}
    canonical_id = _canonical_task_id(task_id, tracked_now)
    logger.info(
        "[Builder] update_async_task redirected (live-check caught "
        "stale cache): raw_task_id=%r canonical_task_id=%s cached_status=%s "
        "live_status=%s",
        task_id,
        canonical_id,
        tracked.get("status"),
        live_status,
    )
    redirect = _terminal_redirect_message(task_id, tracked_now)
    # Key the state update by the CANONICAL id so the reducer merges into
    # the existing entry rather than creating a phantom whitespace-keyed
    # duplicate (codex P2 review 2026-05-21).
    return redirect, {canonical_id: tracked_now}


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
        # Phase 2E.2: augment the user's message with a file-target directive
        # so the post-interrupt builder doesn't create scratch files.
        augmented = _augment_update_message(message, _resolve_tracked(state, task_id))
        return native_func(task_id=task_id, message=augmented, runtime=runtime)

    async def aupdate_async_task(
        task_id: str,
        message: str,
        runtime: ToolRuntime,
    ):
        state = runtime.state if runtime is not None else {}

        # Cache-only first: if the cached status is already terminal,
        # ``start_builder_task._has_active_builder_task`` will return None
        # on the follow-up call (because terminal statuses are filtered),
        # so the model can relaunch without us touching state here. Plain
        # string return is sufficient.
        cache_redirect = _cache_redirect_if_terminal(task_id, state)
        if cache_redirect is not None:
            return cache_redirect

        # Live SDK re-check: the cache may be ~10s stale plus model
        # decision latency. If live status is terminal but cached is not,
        # we MUST persist the fresh status into ``async_tasks`` —
        # otherwise the model's follow-up ``start_builder_task`` reads
        # the stale cache via ``_has_active_builder_task`` and rejects
        # the relaunch as a duplicate (codex P1 review 2026-05-21).
        live_result = await _live_terminal_redirect(task_id, state)
        if live_result is not None:
            redirect_msg, async_tasks_update = live_result
            tool_call_id = getattr(runtime, "tool_call_id", None) if runtime is not None else None
            if tool_call_id:
                return Command(
                    update={
                        "messages": [
                            ToolMessage(redirect_msg, tool_call_id=tool_call_id)
                        ],
                        "async_tasks": async_tasks_update,
                    }
                )
            # Degraded fallback when tool_call_id is unavailable (rare —
            # only in synthetic / test contexts). The redirect text still
            # reaches the model via the tool's normal return path, but the
            # state update is lost; the follow-up start_builder_task may
            # then reject the relaunch as a duplicate. Production always
            # provides tool_call_id (set by the LangGraph tool executor).
            logger.warning(
                "[Builder] live-terminal redirect could not persist state "
                "update (no tool_call_id on runtime); start_builder_task "
                "may reject the relaunch on stale cache."
            )
            return redirect_msg

        if native_coroutine is None:
            raise ToolException(
                "Native update_async_task coroutine is unavailable."
            )
        # Phase 2E.2: augment the user's message with a file-target directive
        # so the post-interrupt builder continues writing to the correct
        # /mnt/user-data/outputs/ path instead of inventing scratch filenames.
        # Production failure 2026-05-21 21:18 UTC: without this hint the
        # builder loops on write_file(test.md), write_file(test2.md), etc.
        augmented = _augment_update_message(message, _resolve_tracked(state, task_id))
        return await native_coroutine(
            task_id=task_id, message=augmented, runtime=runtime
        )

    return StructuredTool.from_function(
        name=native_tool.name,
        func=update_async_task,
        coroutine=aupdate_async_task,
        description=native_tool.description,
        infer_schema=False,
        args_schema=native_tool.args_schema,
    )
