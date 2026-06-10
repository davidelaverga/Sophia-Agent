"""BuildAwarenessMiddleware — keeps Sophia narratively aware of in-flight
or recently-completed builder tasks.

The Phase-1 async migration moved builder lifecycle from
``BuilderSessionMiddleware`` (which polled ``SubagentExecutor`` and injected
task-brief / status blocks) to deepagents' native ``async_tasks`` channel.
The native middleware does NOT update task status from the LangGraph SDK on
companion turns — the companion only learns about completion when the model
explicitly calls ``check_async_task``. That left two regressions:

1. Sophia answered "how's the build going?" with stale or absent status.
2. After the build finished, Sophia kept reciting the original brief instead
   of acknowledging the artifact.

This middleware closes both gaps:

- ``abefore_agent`` refreshes any non-terminal builder entry in
  ``state["async_tasks"]`` via a LangGraph SDK ``runs.get`` call, with a
  short TTL cache so we don't spam SDK on every turn.
- It then renders one of three system-prompt blocks (active / recently
  completed / errored) and appends to ``system_prompt_blocks``.
- The block uses spec-mandated "do not bring up unprompted unless directly
  relevant" framing so Sophia stays a companion, not a status reporter.

The sync ``before_agent`` falls back to rendering from local state without
SDK refresh — used in tests and any sync-only graph context.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


_BUILDER_AGENT_NAME = "sophia_builder"

# Aligned with start_builder_task._TERMINAL_TASK_STATUSES (terminal-blacklist
# semantics: anything NOT in this set is treated as still active).
_TERMINAL_STATUSES = frozenset({
    "success",
    "completed",
    "error",
    "failed",
    "cancelled",
    "timeout",
    "timed_out",
})

# How long to cache "I just refreshed this task from the SDK" before
# refreshing again. Short enough that the user sees a fresh status within
# a couple of seconds; long enough that rapid back-to-back companion turns
# (e.g. a user sending two messages quickly) don't double-fetch.
_REFRESH_TTL_SECONDS = 10.0

# How long after a task reaches terminal status we still surface a
# "just completed" prompt block. After this window, the build fades out
# of Sophia's awareness so it doesn't crowd later conversations.
_RECENTLY_COMPLETED_WINDOW_SECONDS = 30 * 60  # 30 min


class BuildAwarenessState(AgentState):
    async_tasks: NotRequired[dict[str, dict] | None]
    system_prompt_blocks: NotRequired[list[str]]


class BuildAwarenessMiddleware(AgentMiddleware[BuildAwarenessState]):
    """Inject build-status guidance into the companion's prompt assembly."""

    state_schema = BuildAwarenessState

    def __init__(self) -> None:
        super().__init__()
        # Per-task last-refresh timestamps, keyed by task_id. Process-local;
        # rebuilt on graph restart. Bounded by the natural turnover in
        # async_tasks (terminal tasks aren't refreshed).
        self._last_refresh_at: dict[str, float] = {}

    # --- sync path: render from local state only -----------------------------

    @override
    def before_agent(
        self, state: BuildAwarenessState, runtime: Runtime
    ) -> dict | None:
        return self._render_from_state(state)

    # --- async path: refresh from SDK then render ---------------------------

    @override
    async def abefore_agent(
        self, state: BuildAwarenessState, runtime: Runtime
    ) -> dict | None:
        _t0 = time.perf_counter()
        async_tasks = state.get("async_tasks") or {}
        if not async_tasks:
            log_middleware("BuildAwareness", "no async_tasks", _t0)
            return None

        # Keep the per-process refresh cache bounded to tasks still present in
        # state. Without this, long-lived companion processes can accumulate
        # stale task_ids indefinitely across unrelated conversations.
        known_task_ids = set(async_tasks.keys())
        if self._last_refresh_at:
            self._last_refresh_at = {
                task_id: last
                for task_id, last in self._last_refresh_at.items()
                if task_id in known_task_ids
            }

        # Pre-collect builder entries that need a refresh (non-terminal +
        # outside the TTL window). Skip everything else.
        refresh_targets: list[tuple[str, dict]] = []
        now = time.monotonic()
        for task_id, task in async_tasks.items():
            if not isinstance(task, dict):
                continue
            if task.get("agent_name") != _BUILDER_AGENT_NAME:
                continue
            status = task.get("status")
            if status in _TERMINAL_STATUSES:
                continue
            last = self._last_refresh_at.get(task_id, 0.0)
            if now - last < _REFRESH_TTL_SECONDS:
                continue
            refresh_targets.append((task_id, task))

        updated_tasks: dict[str, dict] | None = None
        if refresh_targets:
            updated_tasks = dict(async_tasks)
            for task_id, task in refresh_targets:
                refreshed = await self._refresh_task_status(task)
                if refreshed is not None:
                    updated_tasks[task_id] = refreshed
                self._last_refresh_at[task_id] = now

        # Render using whichever dict is freshest.
        effective_tasks = updated_tasks if updated_tasks is not None else async_tasks
        block = self._build_prompt_block(effective_tasks)
        result: dict[str, Any] = {}
        if updated_tasks is not None and updated_tasks != async_tasks:
            result["async_tasks"] = updated_tasks
        if block is not None:
            blocks = list(state.get("system_prompt_blocks", []) or [])
            blocks.append(block)
            result["system_prompt_blocks"] = blocks

        log_middleware(
            "BuildAwareness",
            f"refreshed={len(refresh_targets)} block={'yes' if block else 'no'}",
            _t0,
        )
        return result or None

    # --- helpers ------------------------------------------------------------

    def _render_from_state(self, state: BuildAwarenessState) -> dict | None:
        async_tasks = state.get("async_tasks") or {}
        if not async_tasks:
            return None
        block = self._build_prompt_block(async_tasks)
        if block is None:
            return None
        blocks = list(state.get("system_prompt_blocks", []) or [])
        blocks.append(block)
        return {"system_prompt_blocks": blocks}

    async def _refresh_task_status(self, task: dict) -> dict | None:
        """Fetch live run status via LangGraph SDK and return a merged task dict.

        Returns ``None`` on any SDK failure so the caller falls back to the
        existing (possibly stale) entry — never raises out of this hook.
        """
        thread_id = task.get("thread_id") or task.get("task_id")
        run_id = task.get("run_id")
        if not thread_id or not run_id:
            return None
        try:
            from langgraph_sdk import get_client

            client = get_client(url=None)  # ASGI in-process
            run = await client.runs.get(thread_id=thread_id, run_id=run_id)
        except Exception:  # noqa: BLE001 — never let this raise into the hook
            logger.debug(
                "BuildAwareness: SDK refresh failed for task_id=%s",
                task.get("task_id"),
                exc_info=True,
            )
            return None

        new_status = run.get("status") if isinstance(run, dict) else None
        if not new_status or new_status == task.get("status"):
            return None  # no change; preserve existing entry as-is

        merged = dict(task)
        merged["status"] = new_status
        merged["last_checked_at"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        merged["last_updated_at"] = merged["last_checked_at"]
        return merged

    def _build_prompt_block(self, async_tasks: dict[str, dict]) -> str | None:
        """Pick the most relevant builder task (active first; recently-finished
        otherwise) and render the appropriate prompt block. Returns None when
        no builder task is worth surfacing right now.
        """
        active: dict | None = None
        latest_terminal: dict | None = None
        for task in async_tasks.values():
            if not isinstance(task, dict):
                continue
            if task.get("agent_name") != _BUILDER_AGENT_NAME:
                continue
            status = task.get("status")
            if status not in _TERMINAL_STATUSES:
                # Active wins over any terminal task.
                if active is None or _newer(task, active):
                    active = task
            else:
                if latest_terminal is None or _newer(task, latest_terminal):
                    latest_terminal = task

        if active is not None:
            return _render_active_block(active)
        if latest_terminal is not None and _within_recent_window(latest_terminal):
            return _render_terminal_block(latest_terminal)
        return None


# --- block rendering --------------------------------------------------------


def _render_active_block(task: dict) -> str:
    runtime_min = _minutes_since(task.get("created_at"))
    summary = task.get("task_type") or "build"
    task_id = task.get("task_id") or ""
    return (
        "<build_status>\n"
        f"A builder task is in flight (running for {runtime_min} min, type: {summary}, task_id: {task_id}).\n"
        "\n"
        "Tool selection AND acknowledgement rules (apply when the user references this build):\n"
        "\n"
        "- Modification cues — \"add\", \"also include\", \"make it shorter/longer\", "
        "\"change to N\", \"wait, do Y instead\":\n"
        f"    1. Call update_async_task(task_id=\"{task_id}\", message=<delta as builder instructions>).\n"
        "    2. emit_artifact with takeaway like \"Got it, updating the build to add X.\"\n"
        "    3. End the turn. DO NOT call start_builder_task — duplicate-rejected.\n"
        "\n"
        "- Status cues — \"how's it going?\", \"status?\", \"any update?\", \"is it done?\":\n"
        f"    1. Call check_async_task(task_id=\"{task_id}\"). Statuses cached in conversation "
        "history are ALWAYS stale; always call this rather than quoting an earlier reply.\n"
        "    2. emit_artifact with takeaway like \"Checking on it now — still running.\"\n"
        "    3. End the turn.\n"
        "\n"
        "- Stop cues — \"stop\", \"cancel\", \"abort\", \"terminate\", \"end\", "
        "\"kill\", \"delete/delate the build\", \"nevermind\", \"don't bother\":\n"
        f"    1. Call cancel_async_task(task_id=\"{task_id}\"). Only on EXPLICIT stop — never on "
        "weak hedges like \"hmm\" or \"actually\".\n"
        "    2. emit_artifact with takeaway like \"Got it, cancelling the build now.\"\n"
        "    3. End the turn.\n"
        "\n"
        "- Recall cues — \"that doc we started\", \"what's running?\", \"all my builds\":\n"
        "    1. Call list_async_tasks() with NO filter argument. pending and\n"
        "       interrupted statuses are non-terminal too, so a running-only\n"
        "       filter would miss them.\n"
        "    2. emit_artifact with takeaway like \"Pulling up your in-flight builds.\"\n"
        "    3. End the turn.\n"
        "\n"
        "Always use the FULL task_id; never truncate. After any lifecycle tool, emit_artifact "
        "ONCE on the same turn, then end — never chain a second lifecycle call.\n"
        "\n"
        "If the user did NOT reference this build, do NOT bring this up unprompted unless "
        "directly relevant to what they just said.\n"
        "</build_status>"
    )


def _render_terminal_block(task: dict) -> str:
    minutes_ago = _minutes_since(task.get("last_updated_at") or task.get("last_checked_at") or task.get("created_at"))
    status = task.get("status") or "unknown"
    if status in {"error", "failed", "timeout", "timed_out"}:
        return (
            "<build_status>\n"
            f"The most recent builder task ended in {status} state ({minutes_ago} min ago). "
            "If the user is upset or confused, address that first — don't try to fix the "
            "technical issue yourself. If they ask for a retry, confirm scope and re-issue. "
            "Don't bring this up unprompted unless the user references the failed build.\n"
            "</build_status>"
        )
    if status == "cancelled":
        return (
            "<build_status>\n"
            f"The most recent builder task was cancelled ({minutes_ago} min ago). "
            "If the user asks, acknowledge it briefly. Don't bring it up unprompted.\n"
            "</build_status>"
        )
    # success / completed
    task_id = task.get("task_id") or ""
    task_type = task.get("task_type") or "build"
    return (
        "<build_status>\n"
        f"The builder just finished a task ({minutes_ago} min ago, task_id: {task_id}, "
        f"type: {task_type}). The artifact has been delivered separately to the user "
        "(Telegram chat / web view). If the user asks about it, reference the delivered "
        "artifact naturally — don't recite a file path or claim the file is unreachable.\n"
        "\n"
        "MODIFY cues on this TERMINAL build (\"add X\", \"also include\", \"make it longer\", "
        "\"change to N\"):\n"
        f"    1. DO NOT call update_async_task(task_id=\"{task_id}\", ...) — the build is "
        "terminal, the wrapper rejects this, and the underlying SDK call would create a "
        "new run on a thread whose history is already complete (looping on dangling tool "
        "calls).\n"
        f"    2. Call edit_builder_artifact(message=<the user's targeted edit>, task_id=\"{task_id}\") "
        "so the prior artifact is materialized into a new builder sandbox and revised in place.\n"
        "    3. emit_artifact with takeaway like \"Got it — revising the delivered artifact now.\"\n"
        "    4. End the turn.\n"
        "If the user explicitly asks for a completely new deliverable inspired by this one, "
        "then use start_builder_task instead.\n"
        "\n"
        "RECALL cues (\"that doc we started\", \"the research from earlier\", \"all my builds\"):\n"
        "    1. Call list_async_tasks() (no filter — pending and interrupted are also "
        "non-terminal).\n"
        "    2. emit_artifact with a short summary of what's listed.\n"
        "    3. If they then ask for details on a specific build, call "
        "check_async_task(task_id) on the NEXT turn — one lifecycle tool per turn, never "
        "chain two on the same turn.\n"
        "\n"
        "Don't bring this up unprompted unless directly relevant.\n"
        "</build_status>"
    )


def _newer(a: dict, b: dict) -> bool:
    """Compare two task dicts by ``last_updated_at`` (or ``created_at``)."""
    return _ts(a) > _ts(b)


def _ts(task: dict) -> str:
    return str(task.get("last_updated_at") or task.get("created_at") or "")


def _minutes_since(timestamp_iso: str | None) -> int:
    if not isinstance(timestamp_iso, str):
        return 0
    try:
        # Tolerate the trailing "Z" form used by deepagents AsyncTask.
        normalized = timestamp_iso.replace("Z", "+00:00")
        ts = datetime.fromisoformat(normalized)
    except ValueError:
        return 0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    delta = datetime.now(UTC) - ts
    return max(0, int(delta.total_seconds() // 60))


def _within_recent_window(task: dict) -> bool:
    minutes_ago = _minutes_since(
        task.get("last_updated_at") or task.get("last_checked_at") or task.get("created_at")
    )
    return minutes_ago * 60 <= _RECENTLY_COMPLETED_WINDOW_SECONDS
