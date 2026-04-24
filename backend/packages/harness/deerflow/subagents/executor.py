"""Subagent execution engine."""

import asyncio
import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import CancelledError as FuturesCancelledError
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from langchain.agents import create_agent
from langchain.tools import BaseTool
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig

from deerflow.agents.thread_state import SandboxState, ThreadDataState, ThreadState
from deerflow.models import create_chat_model
from deerflow.subagents.config import SubagentConfig

logger = logging.getLogger(__name__)


_EVENT_LOOP_CLOSED_MSG = "Event loop is closed"


def _is_event_loop_closed_error(exc: BaseException) -> bool:
    """Detect ``RuntimeError('Event loop is closed')`` or its wrapped forms.

    This failure is surfaced when one subagent's event loop teardown runs
    concurrently with another subagent's async work that still references
    that loop (typically shared httpx transports or pending callbacks). We
    distinguish it from generic subagent exceptions so the debug surface
    can call it out instead of burying it in a generic ``FAILED``.
    """
    if not isinstance(exc, RuntimeError):
        return False
    message = str(exc) or ""
    return _EVENT_LOOP_CLOSED_MSG in message

# Idle threshold before declaring a subagent stuck. Generous enough to cover
# long single-LLM iterations on the builder (Sonnet often spends 90–130s on a
# single generation when writing large deliverables at max_tokens=8192).
_STUCK_IDLE_MS = 150_000

# Soft cap for a single streaming iteration. Exceeding this is not a hard
# failure — we log a bounded warning and record the long-iteration count on
# the result so operators can watch for a runaway ``write_file_tool`` loop.
# Kept well below ``_STUCK_IDLE_MS`` so the signal appears before the stuck
# detector fires.
_ITERATION_SOFT_CAP_MS = 90_000

# Synthetic progress uses the turn budget as denominator; kept in sync with
# BuilderTaskMiddleware._HARD_CEILING. Capped below 100% so real completion
# (todos_progress == 100 or status == COMPLETED) remains visually distinct.
_SYNTHETIC_PROGRESS_BUDGET_TURNS = 12
_SYNTHETIC_PROGRESS_CAP = 90

# How often the heartbeat loop bumps last_update_at while the agent streams.
# Only touches heartbeat (liveness), never last_progress_at (real progress).
_HEARTBEAT_INTERVAL_SECONDS = 5.0


class SubagentStatus(Enum):
    """Status of a subagent execution."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"


class SubagentCancelledError(Exception):
    """Raised when a background subagent task is cancelled."""


@dataclass
class SubagentResult:
    """Result of a subagent execution.

    Attributes:
        task_id: Unique identifier for this execution.
        trace_id: Trace ID for distributed tracing (links parent and subagent logs).
        status: Current status of the execution.
        result: The final result message (if completed).
        error: Error message (if failed).
        started_at: When execution started.
        completed_at: When execution completed.
        ai_messages: List of complete AI messages (as dicts) generated during execution.
    """

    task_id: str
    trace_id: str
    status: SubagentStatus
    thread_id: str | None = None
    result: str | None = None
    error: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    ai_messages: list[dict[str, Any]] | None = None
    final_state: dict[str, Any] | None = None
    owner_id: str | None = None
    description: str | None = None
    cancel_requested: bool = False
    last_ai_message_summary: dict[str, Any] | None = None
    late_ai_message_summary: dict[str, Any] | None = None
    timeout_observed_during_stream: bool = False
    timed_out_at: datetime | None = None
    live_state: dict[str, Any] | None = None
    last_update_at: datetime | None = None
    last_progress_at: datetime | None = None
    _live_state_signature: str | None = None
    # Execution telemetry – accumulated during _aexecute
    error_type: str | None = None
    iteration_count: int = 0
    iteration_durations_ms: list[int] | None = None
    slowest_iteration_ms: int = 0
    total_stream_ms: int = 0
    # Count of iterations that exceeded ``_ITERATION_SOFT_CAP_MS``. Useful
    # for diagnosing ``write_file_tool`` loops that silently push an
    # individual subagent past its overall timeout without failing loudly.
    long_iteration_count: int = 0
    last_long_iteration_ms: int = 0
    last_long_iteration_tools: list[str] | None = None

    def __post_init__(self):
        """Initialize mutable defaults."""
        if self.ai_messages is None:
            self.ai_messages = []
        if self.iteration_durations_ms is None:
            self.iteration_durations_ms = []


def _normalize_todo_status(status: object) -> str:
    raw_value = getattr(status, "value", status)
    if not isinstance(raw_value, str):
        return "not-started"

    normalized = raw_value.strip().lower().replace("_", "-")
    if normalized == "completed":
        return "completed"
    if normalized == "in-progress":
        return "in-progress"
    return "not-started"


def _normalize_todos(todos: object) -> list[dict[str, Any]]:
    if not isinstance(todos, list):
        return []

    normalized: list[dict[str, Any]] = []
    for index, todo in enumerate(todos, start=1):
        if not isinstance(todo, dict):
            continue

        title = todo.get("title")
        if not isinstance(title, str) or not title.strip():
            continue

        normalized_todo: dict[str, Any] = {
            "title": title.strip(),
            "status": _normalize_todo_status(todo.get("status")),
        }

        todo_id = todo.get("id")
        if isinstance(todo_id, int):
            normalized_todo["id"] = todo_id
        else:
            normalized_todo["id"] = index

        normalized.append(normalized_todo)

    return normalized


def _extract_live_state_snapshot(state: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(state, dict):
        return None

    snapshot: dict[str, Any] = {}

    todos = _normalize_todos(state.get("todos"))
    if todos:
        snapshot["todos"] = todos

    builder_task = state.get("builder_task")
    if isinstance(builder_task, dict) and builder_task:
        snapshot["builder_task"] = {
            key: value
            for key, value in builder_task.items()
            if key in {"task_id", "status", "description", "detail", "error"}
        }

    last_shell_command = state.get("last_shell_command")
    if isinstance(last_shell_command, dict) and last_shell_command:
        snapshot["last_shell_command"] = dict(last_shell_command)

    recent_shell_commands = state.get("recent_shell_commands")
    if isinstance(recent_shell_commands, list) and recent_shell_commands:
        snapshot["recent_shell_commands"] = [
            dict(entry)
            for entry in recent_shell_commands
            if isinstance(entry, dict) and entry
        ][-3:]

    return snapshot or None


def _snapshot_signature(snapshot: dict[str, Any] | None) -> str | None:
    if not snapshot:
        return None

    try:
        return json.dumps(snapshot, sort_keys=True, default=str)
    except TypeError:
        return repr(snapshot)


def _iso_or_none(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def build_subagent_progress_payload(
    result: SubagentResult,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    current_time = now or datetime.now()
    live_state = result.live_state or {}
    todos = _normalize_todos(live_state.get("todos"))

    total_steps = len(todos)
    completed_steps = sum(1 for todo in todos if todo.get("status") == "completed")
    in_progress_steps = sum(1 for todo in todos if todo.get("status") == "in-progress")
    pending_steps = max(total_steps - completed_steps - in_progress_steps, 0)

    active_step_title = next(
        (
            str(todo.get("title"))
            for todo in todos
            if isinstance(todo, dict) and todo.get("status") == "in-progress"
        ),
        None,
    )
    if active_step_title is None:
        active_step_title = next(
            (
                str(todo.get("title"))
                for todo in todos
                if isinstance(todo, dict) and todo.get("status") != "completed"
            ),
            None,
        )

    progress_percent: int | None = None
    progress_source = "none"
    if total_steps > 0:
        progress_percent = round((completed_steps / total_steps) * 100)
        progress_source = "todos"
    elif result.status == SubagentStatus.COMPLETED:
        progress_percent = 100

    # Synthetic fallback: when no todos populate progress and the subagent is
    # still running, advance the bar based on iteration count vs the turn
    # budget. Prevents the UI from sitting on the early-stage placeholder
    # (~22%) for the entire run when the builder doesn't update write_todos.
    if (
        result.status == SubagentStatus.RUNNING
        and result.iteration_count > 0
        and (progress_percent is None or progress_percent < _SYNTHETIC_PROGRESS_CAP)
    ):
        synthetic = min(
            _SYNTHETIC_PROGRESS_CAP,
            round((result.iteration_count / _SYNTHETIC_PROGRESS_BUDGET_TURNS) * _SYNTHETIC_PROGRESS_CAP),
        )
        if progress_percent is None or synthetic > progress_percent:
            progress_percent = synthetic
            if progress_source == "none":
                progress_source = "iterations"

    heartbeat_anchor = result.last_update_at or result.started_at
    progress_anchor = result.last_progress_at or result.started_at

    heartbeat_ms = None
    if heartbeat_anchor is not None:
        heartbeat_ms = max(int((current_time - heartbeat_anchor).total_seconds() * 1000), 0)

    idle_ms = None
    if progress_anchor is not None:
        idle_ms = max(int((current_time - progress_anchor).total_seconds() * 1000), 0)

    is_stuck = (
        result.status == SubagentStatus.RUNNING
        and idle_ms is not None
        and idle_ms >= _STUCK_IDLE_MS
    )
    stuck_reason = None
    if is_stuck and idle_ms is not None:
        stuck_reason = (
            f"No visible builder progress for {round(idle_ms / 1000)}s. "
            "It may be blocked on a tool or looping without advancing the deliverable."
        )

    payload: dict[str, Any] = {
        "started_at": _iso_or_none(result.started_at),
        "completed_at": _iso_or_none(result.completed_at),
        "last_update_at": _iso_or_none(result.last_update_at),
        "last_progress_at": _iso_or_none(result.last_progress_at),
        "heartbeat_ms": heartbeat_ms,
        "idle_ms": idle_ms,
        "is_stuck": is_stuck,
        "stuck_reason": stuck_reason,
        "progress_percent": progress_percent,
        "progress_source": progress_source,
        "active_step_title": active_step_title,
    }

    if todos:
        payload["todos"] = todos
        payload["total_steps"] = total_steps
        payload["completed_steps"] = completed_steps
        payload["in_progress_steps"] = in_progress_steps
        payload["pending_steps"] = pending_steps

    return payload


_BACKGROUND_TASK_OWNER_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_BACKGROUND_TASK_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent.parent
_BACKGROUND_TASKS_DIR = _PROJECT_ROOT / "users"


def _background_task_snapshot_path(owner_id: str, task_id: str) -> Path | None:
    if not isinstance(owner_id, str) or not _BACKGROUND_TASK_OWNER_PATTERN.match(owner_id):
        logger.warning("Skipping background task snapshot for invalid owner_id=%r task_id=%s", owner_id, task_id)
        return None

    if not isinstance(task_id, str) or not _BACKGROUND_TASK_ID_PATTERN.match(task_id):
        logger.warning("Skipping background task snapshot for invalid task_id=%r", task_id)
        return None

    snapshot_path = _BACKGROUND_TASKS_DIR / owner_id / "builder_tasks" / f"{task_id}.json"
    resolved = snapshot_path.resolve()
    if not resolved.is_relative_to(_BACKGROUND_TASKS_DIR.resolve()):
        logger.warning("Skipping background task snapshot outside users dir for task_id=%s", task_id)
        return None

    return snapshot_path


def _extract_builder_result_from_task_result(result: SubagentResult) -> dict[str, Any] | None:
    final_state = result.final_state
    if isinstance(final_state, dict):
        builder_result = final_state.get("builder_result")
        if isinstance(builder_result, dict) and builder_result:
            return builder_result

    ai_messages = result.ai_messages or []
    for message in reversed(ai_messages):
        if not isinstance(message, dict):
            continue

        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue

        for tool_call in reversed(tool_calls):
            if not isinstance(tool_call, dict):
                continue
            if tool_call.get("name") != "emit_builder_artifact":
                continue

            args = tool_call.get("args")
            if isinstance(args, dict) and args:
                return args

    return None


def _task_summary_tool_names(summary: object) -> list[str]:
    if not isinstance(summary, dict):
        return []

    tool_names = summary.get("tool_names")
    if not isinstance(tool_names, list):
        return []

    return [tool_name for tool_name in tool_names if isinstance(tool_name, str) and tool_name]


def _infer_task_blocker(
    status_value: str,
    *,
    builder_result: dict[str, Any] | None,
    last_summary: object,
    late_summary: object,
    message_count: int,
) -> tuple[str | None, str | None]:
    if status_value in {"completed", "cancelled"}:
        return (None, None)

    last_tool_names = _task_summary_tool_names(last_summary)
    late_tool_names = _task_summary_tool_names(late_summary)
    last_has_emit = bool(isinstance(last_summary, dict) and last_summary.get("has_emit_builder_artifact"))
    late_has_emit = bool(isinstance(late_summary, dict) and late_summary.get("has_emit_builder_artifact"))

    if status_value == "timed_out":
        if late_has_emit:
            return (
                "final_artifact_emission",
                "Builder only reached emit_builder_artifact after the timeout window closed.",
            )
        if last_tool_names:
            return (
                "tool_call",
                f"Builder timed out after calling {', '.join(last_tool_names)} before emit_builder_artifact.",
            )
        return (
            "background_agent",
            "Builder timed out before a terminal artifact or result was captured.",
        )

    if status_value == "failed":
        if last_has_emit:
            return (
                "final_artifact_emission",
                "Builder failed after emit_builder_artifact was attempted.",
            )
        if last_tool_names:
            return (
                "tool_call",
                f"Latest captured Builder activity called {', '.join(last_tool_names)} before failing.",
            )
        return (
            "background_agent",
            "Builder failed outside a captured tool call or final artifact emission step.",
        )

    if isinstance(builder_result, dict) and builder_result:
        return (
            "final_artifact_emission",
            "Builder artifact exists, but the background task has not reported a terminal status yet.",
        )

    if late_has_emit or last_has_emit:
        return (
            "final_artifact_emission",
            "Latest captured Builder step already called emit_builder_artifact, but task closure is still pending.",
        )

    if last_tool_names:
        return (
            "tool_call",
            f"Latest captured Builder step called {', '.join(last_tool_names)} and has not reached emit_builder_artifact yet.",
        )

    if late_tool_names:
        return (
            "tool_call",
            f"Late Builder activity was observed in {', '.join(late_tool_names)} without a final artifact.",
        )

    if message_count > 0:
        return (
            "background_agent",
            "No recent Builder tool calls were captured; it may be waiting on the model loop or a hidden downstream dependency.",
        )

    return (
        "background_agent",
        "Builder task exists in memory but no AI/tool activity has been captured yet.",
    )


def build_background_task_status_payload(result: SubagentResult) -> dict[str, Any]:
    status_value = getattr(result.status, "value", str(result.status))
    progress_payload = build_subagent_progress_payload(result)
    builder_result = _extract_builder_result_from_task_result(result)

    description = result.description
    if not isinstance(description, str) or not description.strip():
        for state_name in ("live_state", "final_state"):
            state = getattr(result, state_name, None)
            if not isinstance(state, dict):
                continue

            builder_task = state.get("builder_task")
            if isinstance(builder_task, dict):
                candidate = builder_task.get("description")
                if isinstance(candidate, str) and candidate.strip():
                    description = candidate.strip()
                    break

    if (not isinstance(description, str) or not description.strip()) and isinstance(builder_result, dict):
        artifact_title = builder_result.get("artifact_title")
        if isinstance(artifact_title, str) and artifact_title.strip():
            description = artifact_title.strip()

    detail = None
    if isinstance(result.error, str) and result.error.strip():
        detail = result.error.strip()
    else:
        stuck_reason = progress_payload.get("stuck_reason")
        if isinstance(stuck_reason, str) and stuck_reason.strip():
            detail = stuck_reason.strip()
        elif isinstance(builder_result, dict):
            companion_summary = builder_result.get("companion_summary")
            if isinstance(companion_summary, str) and companion_summary.strip():
                detail = companion_summary.strip()
        if detail is None and isinstance(result.result, str) and result.result.strip():
            detail = result.result.strip()
        if detail is None and isinstance(result.live_state, dict):
            builder_task = result.live_state.get("builder_task")
            if isinstance(builder_task, dict):
                candidate = builder_task.get("detail")
                if isinstance(candidate, str) and candidate.strip():
                    detail = candidate.strip()
        if detail is None and isinstance(result.live_state, dict):
            last_shell_command = result.live_state.get("last_shell_command")
            if isinstance(last_shell_command, dict):
                shell_error = last_shell_command.get("error")
                if isinstance(shell_error, str) and shell_error.strip():
                    detail = shell_error.strip()

    last_summary = result.last_ai_message_summary
    late_summary = result.late_ai_message_summary
    message_count = len(result.ai_messages or [])
    suspected_blocker, blocker_detail = _infer_task_blocker(
        status_value,
        builder_result=builder_result,
        last_summary=last_summary,
        late_summary=late_summary,
        message_count=message_count,
    )

    return {
        "task_id": result.task_id,
        "status": status_value,
        "trace_id": result.trace_id,
        "description": description.strip() if isinstance(description, str) and description.strip() else None,
        "detail": detail,
        "result": result.result,
        "error": result.error,
        "builder_result": builder_result,
        "message_count": message_count,
        "started_at": progress_payload.get("started_at"),
        "completed_at": progress_payload.get("completed_at"),
        "last_update_at": progress_payload.get("last_update_at"),
        "last_progress_at": progress_payload.get("last_progress_at"),
        "heartbeat_ms": progress_payload.get("heartbeat_ms"),
        "idle_ms": progress_payload.get("idle_ms"),
        "is_stuck": bool(progress_payload.get("is_stuck", False)),
        "stuck_reason": progress_payload.get("stuck_reason"),
        "progress_percent": progress_payload.get("progress_percent"),
        "progress_source": progress_payload.get("progress_source"),
        "total_steps": progress_payload.get("total_steps"),
        "completed_steps": progress_payload.get("completed_steps"),
        "in_progress_steps": progress_payload.get("in_progress_steps"),
        "pending_steps": progress_payload.get("pending_steps"),
        "active_step_title": progress_payload.get("active_step_title"),
        "todos": progress_payload.get("todos") or [],
        "debug": {
            "last_tool_names": _task_summary_tool_names(last_summary),
            "last_has_emit_builder_artifact": (
                bool(last_summary.get("has_emit_builder_artifact"))
                if isinstance(last_summary, dict) and "has_emit_builder_artifact" in last_summary
                else None
            ),
            "late_tool_names": _task_summary_tool_names(late_summary),
            "late_has_emit_builder_artifact": (
                bool(late_summary.get("has_emit_builder_artifact"))
                if isinstance(late_summary, dict) and "has_emit_builder_artifact" in late_summary
                else None
            ),
            "timeout_observed_during_stream": bool(result.timeout_observed_during_stream),
            "timed_out_at": result.timed_out_at.isoformat() if result.timed_out_at is not None else None,
            "final_state_present": isinstance(result.final_state, dict),
            "builder_result_present": isinstance(builder_result, dict) and bool(builder_result),
            "suspected_blocker": suspected_blocker,
            "suspected_blocker_detail": blocker_detail,
            "last_shell_command": (
                dict(result.live_state.get("last_shell_command"))
                if isinstance(result.live_state, dict) and isinstance(result.live_state.get("last_shell_command"), dict)
                else None
            ),
            "recent_shell_commands": (
                [
                    dict(entry)
                    for entry in result.live_state.get("recent_shell_commands", [])
                    if isinstance(entry, dict)
                ]
                if isinstance(result.live_state, dict)
                else []
            ),
            # Execution telemetry
            "error_type": result.error_type,
            "iteration_count": result.iteration_count,
            "total_stream_ms": result.total_stream_ms,
            "slowest_iteration_ms": result.slowest_iteration_ms,
            "iteration_durations_ms": result.iteration_durations_ms or [],
            "long_iteration_count": result.long_iteration_count,
            "last_long_iteration_ms": result.last_long_iteration_ms,
            "last_long_iteration_tools": result.last_long_iteration_tools or [],
        },
        "owner_id": result.owner_id,
    }


_TERMINAL_SUBAGENT_STATUSES = {
    SubagentStatus.COMPLETED,
    SubagentStatus.FAILED,
    SubagentStatus.TIMED_OUT,
    SubagentStatus.CANCELLED,
}


def _maybe_notify_gateway_of_terminal(result: SubagentResult) -> None:
    """Push a terminal status snapshot to the Gateway's internal registry.

    Best-effort bridge for Render's split-process topology: the Gateway's
    channel notifier cannot see subagent results in the LangGraph process,
    so terminal transitions are mirrored over HTTP. No-op when the
    ``SOPHIA_GATEWAY_INTERNAL_URL`` / ``SOPHIA_INTERNAL_SECRET`` env vars
    are absent (single-process / local dev), and any exception is
    swallowed so subagent execution never regresses on notify failures.
    """
    if result.status not in _TERMINAL_SUBAGENT_STATUSES:
        return
    try:
        from deerflow.sophia.storage import gateway_notify

        if not gateway_notify.is_configured():
            return

        builder_result = _extract_builder_result_from_task_result(result)
        payload: dict[str, Any] = {
            "task_id": result.task_id,
            "status": result.status.value,
            "error": result.error,
            "error_type": result.error_type,
            "trace_id": result.trace_id,
            "owner_id": result.owner_id,
            "completed_at": _iso_or_none(result.completed_at),
            "started_at": _iso_or_none(result.started_at),
            "timed_out_at": _iso_or_none(result.timed_out_at),
            "builder_result": builder_result,
        }
        gateway_notify.notify_builder_task_status(result.task_id, payload)
    except Exception:  # noqa: BLE001 — must never break subagent execution
        logger.warning(
            "Gateway notify (terminal push) failed for task_id=%s",
            result.task_id,
            exc_info=True,
        )


def persist_background_task_status_payload(result: SubagentResult) -> None:
    if not result.owner_id:
        _maybe_notify_gateway_of_terminal(result)
        return

    snapshot_path = _background_task_snapshot_path(result.owner_id, result.task_id)
    if snapshot_path is None:
        _maybe_notify_gateway_of_terminal(result)
        return

    try:
        payload = build_background_task_status_payload(result)
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = snapshot_path.with_name(f"{snapshot_path.name}.tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
        temp_path.replace(snapshot_path)
    except Exception:
        logger.warning("Failed to persist background task snapshot for %s", result.task_id, exc_info=True)

    _maybe_notify_gateway_of_terminal(result)


def read_background_task_status_payload(user_id: str, task_id: str) -> dict[str, Any] | None:
    snapshot_path = _background_task_snapshot_path(user_id, task_id)
    if snapshot_path is None or not snapshot_path.exists():
        return None

    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Failed to read background task snapshot for %s", task_id, exc_info=True)
        return None

    if not isinstance(payload, dict):
        return None

    return payload


def _ensure_runtime_directories() -> None:
    """Ensure runtime directories required by the LangGraph/subagent stack
    exist at import time.

    On Render (and other containerised deploys) the LangGraph API process
    expects a writable ``.langgraph_api`` directory under the project root
    for its local persistence; when it is missing, the process emits a
    recurring ``FileNotFoundError`` that buries real failure signal in the
    logs. We also pre-create the ``users/`` directory used by
    ``_background_task_snapshot_path`` so the first snapshot write does not
    race with an on-demand mkdir during a subagent run.

    Failures here are non-fatal: logging a warning is enough. The caller
    (gateway lifespan hook, langgraph subprocess import) gets a healthy
    default even without write permission to the project root.
    """
    candidates = (
        _PROJECT_ROOT / ".langgraph_api",
        _BACKGROUND_TASKS_DIR,
    )
    override = os.environ.get("LANGGRAPH_API_DIR")
    if override:
        try:
            candidates = (Path(override), _BACKGROUND_TASKS_DIR)
        except Exception:
            logger.warning(
                "LANGGRAPH_API_DIR=%r is not a valid path; falling back to default",
                override,
            )
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except Exception:
            logger.warning(
                "Could not pre-create runtime directory %s; downstream writes may fail",
                path,
                exc_info=True,
            )


_ensure_runtime_directories()


# Global storage for background task results
_background_tasks: dict[str, SubagentResult] = {}
_background_tasks_lock = threading.Lock()
_background_task_futures: dict[str, Future[Any]] = {}
_background_task_cancel_events: dict[str, threading.Event] = {}

# Thread pool for background task scheduling and orchestration
_scheduler_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-scheduler-")

# Thread pool for actual subagent execution (with timeout support)
# Larger pool to avoid blocking when scheduler submits execution tasks
_execution_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-exec-")


def _filter_tools(
    all_tools: list[BaseTool],
    allowed: list[str] | None,
    disallowed: list[str] | None,
) -> list[BaseTool]:
    """Filter tools based on subagent configuration.

    Args:
        all_tools: List of all available tools.
        allowed: Optional allowlist of tool names. If provided, only these tools are included.
        disallowed: Optional denylist of tool names. These tools are always excluded.

    Returns:
        Filtered list of tools.
    """
    filtered = all_tools

    # Apply allowlist if specified
    if allowed is not None:
        allowed_set = set(allowed)
        filtered = [t for t in filtered if t.name in allowed_set]

    # Apply denylist
    if disallowed is not None:
        disallowed_set = set(disallowed)
        filtered = [t for t in filtered if t.name not in disallowed_set]

    return filtered


def _get_model_name(config: SubagentConfig, parent_model: str | None) -> str | None:
    """Resolve the model name for a subagent.

    Args:
        config: Subagent configuration.
        parent_model: The parent agent's model name.

    Returns:
        Model name to use, or None to use default.
    """
    if config.model == "inherit":
        return parent_model
    return config.model


class SubagentExecutor:
    """Executor for running subagents."""

    def __init__(
        self,
        config: SubagentConfig,
        tools: list[BaseTool],
        parent_model: str | None = None,
        sandbox_state: SandboxState | None = None,
        thread_data: ThreadDataState | None = None,
        thread_id: str | None = None,
        trace_id: str | None = None,
        pre_built_agent=None,
        extra_configurable: dict[str, Any] | None = None,
        stream_messages: bool = True,
    ):
        """Initialize the executor.

        Args:
            config: Subagent configuration.
            tools: List of all available tools (will be filtered).
            parent_model: The parent agent's model name for inheritance.
            sandbox_state: Sandbox state from parent agent.
            thread_data: Thread data from parent agent.
            thread_id: Thread ID for sandbox operations.
            trace_id: Trace ID from parent for distributed tracing.
            pre_built_agent: Pre-built agent instance — bypasses _create_agent().
            extra_configurable: Additional configurable dict merged into run_config.
            stream_messages: When True, execute via agent.astream() and collect AI
                messages incrementally. When False, execute via agent.ainvoke() and
                collect AI messages from the final state only.
        """
        self.config = config
        self.parent_model = parent_model
        self.sandbox_state = sandbox_state
        self.thread_data = thread_data
        self.thread_id = thread_id
        # Generate trace_id if not provided (for top-level calls)
        self.trace_id = trace_id or str(uuid.uuid4())[:8]
        self.pre_built_agent = pre_built_agent
        self.extra_configurable = extra_configurable
        self.stream_messages = stream_messages

        # Filter tools based on config
        self.tools = _filter_tools(
            tools,
            config.tools,
            config.disallowed_tools,
        )

        # Log tool count truthfully — when a pre_built_agent is provided, the
        # executor's own `tools` list is irrelevant (the agent has its tools
        # baked in). Logging "0 tools" in that case misleads debugging.
        if self.pre_built_agent is not None:
            logger.info(
                f"[trace={self.trace_id}] SubagentExecutor initialized: {config.name} "
                f"with pre-built agent (executor tools={len(self.tools)} ignored)"
            )
        else:
            logger.info(
                f"[trace={self.trace_id}] SubagentExecutor initialized: {config.name} "
                f"with {len(self.tools)} tools"
            )

    @staticmethod
    def _append_ai_message(result: SubagentResult, message: AIMessage) -> None:
        """Append a unique AI message to the result holder."""
        message_dict = message.model_dump()
        message_id = message_dict.get("id")
        if message_id:
            is_duplicate = any(msg.get("id") == message_id for msg in result.ai_messages)
        else:
            is_duplicate = message_dict in result.ai_messages

        if not is_duplicate:
            result.ai_messages.append(message_dict)
            now = datetime.now()
            result.last_update_at = now
            result.last_progress_at = now

    def _collect_ai_messages_from_state(
        self,
        state: dict[str, Any] | None,
        result: SubagentResult,
    ) -> None:
        """Collect AI messages from a state snapshot into the result holder."""
        if not state:
            return

        for message in state.get("messages", []):
            if isinstance(message, AIMessage):
                self._append_ai_message(result, message)

    def _create_agent(self):
        """Create the agent instance. Uses pre_built_agent if provided."""
        if self.pre_built_agent is not None:
            return self.pre_built_agent

        model_name = _get_model_name(self.config, self.parent_model)
        model = create_chat_model(name=model_name, thinking_enabled=False)

        from deerflow.agents.middlewares.tool_error_handling_middleware import build_subagent_runtime_middlewares

        # Reuse shared middleware composition with lead agent.
        middlewares = build_subagent_runtime_middlewares(lazy_init=True)

        return create_agent(
            model=model,
            tools=self.tools,
            middleware=middlewares,
            system_prompt=self.config.system_prompt,
            state_schema=ThreadState,
        )

    def _build_initial_state(self, task: str) -> dict[str, Any]:
        """Build the initial state for agent execution.

        Args:
            task: The task description.

        Returns:
            Initial state dictionary.
        """
        state: dict[str, Any] = {
            "messages": [HumanMessage(content=task)],
        }

        # Pass through sandbox and thread data from parent
        if self.sandbox_state is not None:
            state["sandbox"] = self.sandbox_state
        if self.thread_data is not None:
            state["thread_data"] = self.thread_data

        # Merge extra_configurable into initial state so middlewares can read it
        if self.extra_configurable:
            state.update(self.extra_configurable)

        return state

    @staticmethod
    def _summarize_content(content: Any, max_chars: int = 160) -> str | None:
        if isinstance(content, str):
            text = content.strip()
            if not text:
                return None
            return text[:max_chars]
        if isinstance(content, list):
            chunks: list[str] = []
            for block in content:
                if isinstance(block, str):
                    chunks.append(block.strip())
                elif isinstance(block, dict) and isinstance(block.get("text"), str):
                    chunks.append(block["text"].strip())
            text = " ".join(part for part in chunks if part)
            return text[:max_chars] if text else None
        return None

    def _summarize_ai_message(self, message: AIMessage) -> dict[str, Any]:
        tool_calls = getattr(message, "tool_calls", []) or []
        tool_names = [
            tc.get("name")
            for tc in tool_calls
            if isinstance(tc, dict) and isinstance(tc.get("name"), str)
        ]
        return {
            "message_id": getattr(message, "id", None),
            "tool_call_count": len(tool_names),
            "tool_names": tool_names,
            "has_emit_builder_artifact": "emit_builder_artifact" in tool_names,
            "text_preview": self._summarize_content(getattr(message, "content", None)),
        }

    async def _aexecute(
        self,
        task: str,
        result_holder: SubagentResult | None = None,
        cancel_event: threading.Event | None = None,
    ) -> SubagentResult:
        """Execute a task asynchronously.

        Args:
            task: The task description for the subagent.
            result_holder: Optional pre-created result object to update during execution.

        Returns:
            SubagentResult with the execution result.
        """
        if result_holder is not None:
            # Use the provided result holder (for async execution with real-time updates)
            result = result_holder
        else:
            # Create a new result for synchronous execution
            task_id = str(uuid.uuid4())[:8]
            result = SubagentResult(
                task_id=task_id,
                trace_id=self.trace_id,
                status=SubagentStatus.RUNNING,
                thread_id=self.thread_id,
                started_at=datetime.now(),
            )

        def _timed_out_externally() -> bool:
            return result_holder is not None and result_holder.status == SubagentStatus.TIMED_OUT

        heartbeat_stop_event = asyncio.Event()

        async def _heartbeat_loop() -> None:
            """Bump last_update_at while the agent streams so the UI sees liveness
            even when a single LLM call exceeds the chunk interval. Never touches
            last_progress_at — real progress still gates the stall detector."""
            try:
                while not heartbeat_stop_event.is_set():
                    try:
                        await asyncio.wait_for(
                            heartbeat_stop_event.wait(),
                            timeout=_HEARTBEAT_INTERVAL_SECONDS,
                        )
                        return
                    except asyncio.TimeoutError:
                        pass
                    if result.status != SubagentStatus.RUNNING:
                        return
                    result.last_update_at = datetime.now()
                    try:
                        persist_background_task_status_payload(result)
                    except Exception:  # pragma: no cover - persistence is best-effort
                        logger.debug(
                            "[trace=%s] Subagent %s heartbeat persist failed",
                            self.trace_id,
                            self.config.name,
                            exc_info=True,
                        )
            except asyncio.CancelledError:
                return

        heartbeat_task = asyncio.create_task(_heartbeat_loop())

        try:
            if cancel_event and cancel_event.is_set():
                raise SubagentCancelledError("Execution cancelled by user")

            agent = self._create_agent()
            state = self._build_initial_state(task)

            # Build config with thread_id for sandbox access and recursion limit
            run_config: RunnableConfig = {
                "recursion_limit": self.config.max_turns,
            }
            configurable: dict[str, Any] = {}
            context: dict[str, Any] = {}
            if self.thread_id:
                configurable["thread_id"] = self.thread_id
                context["thread_id"] = self.thread_id
            if self.extra_configurable:
                configurable.update(self.extra_configurable)
            if configurable:
                run_config["configurable"] = configurable

            logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} starting async execution with max_turns={self.config.max_turns}")

            final_state = None
            stream_start_perf = time.perf_counter()
            iteration_start_perf = stream_start_perf
            if self.stream_messages:
                # Use stream mode when callers need progressive AI message updates
                # (for example the generic task tool's task_running events).
                async for chunk in agent.astream(state, config=run_config, context=context, stream_mode="values"):  # type: ignore[arg-type]
                    if cancel_event and cancel_event.is_set():
                        raise SubagentCancelledError("Execution cancelled by user")

                    # Track per-iteration wall time
                    iter_now_perf = time.perf_counter()
                    iter_ms = round((iter_now_perf - iteration_start_perf) * 1000)
                    iteration_start_perf = iter_now_perf
                    result.iteration_count += 1
                    result.iteration_durations_ms.append(iter_ms)
                    if iter_ms > result.slowest_iteration_ms:
                        result.slowest_iteration_ms = iter_ms
                    if iter_ms > 30_000:
                        logger.warning(
                            f"[trace={self.trace_id}] Subagent {self.config.name} iteration "
                            f"#{result.iteration_count} took {iter_ms}ms (>30s)"
                        )
                    if iter_ms > _ITERATION_SOFT_CAP_MS:
                        # Long iteration usually means a monolithic write_file
                        # call is streaming a very large file. Record and warn
                        # so operators can see the pattern; surface the last
                        # observed tool names so a follow-up correlates tightly.
                        prior_tools = (
                            list(result.last_ai_message_summary.get("tool_names") or [])
                            if isinstance(result.last_ai_message_summary, dict)
                            else []
                        )
                        result.long_iteration_count += 1
                        result.last_long_iteration_ms = iter_ms
                        result.last_long_iteration_tools = prior_tools
                        logger.warning(
                            "[trace=%s] Subagent %s iteration #%d exceeded soft cap: %dms (cap=%dms) prior_tools=%s",
                            self.trace_id,
                            self.config.name,
                            result.iteration_count,
                            iter_ms,
                            _ITERATION_SOFT_CAP_MS,
                            prior_tools,
                        )

                    snapshot_updated_at = datetime.now()
                    result.last_update_at = snapshot_updated_at
                    live_snapshot = _extract_live_state_snapshot(chunk)
                    if live_snapshot is not None:
                        result.live_state = live_snapshot
                        live_signature = _snapshot_signature(live_snapshot)
                        if live_signature != result._live_state_signature:
                            result._live_state_signature = live_signature
                            result.last_progress_at = snapshot_updated_at

                    final_state = chunk

                    messages = chunk.get("messages", [])
                    last_message = messages[-1] if messages else None
                    tool_names: list[str] = []
                    if isinstance(last_message, AIMessage):
                        message_summary = self._summarize_ai_message(last_message)
                        tool_names = list(message_summary.get("tool_names", []))

                        if _timed_out_externally():
                            result.timeout_observed_during_stream = True
                            result.late_ai_message_summary = message_summary
                            logger.warning(
                                f"[trace={self.trace_id}] Subagent {self.config.name} observed external timeout while streaming; "
                                f"late_tools={tool_names}"
                            )
                            return result

                        result.last_ai_message_summary = message_summary
                    elif _timed_out_externally():
                        result.timeout_observed_during_stream = True
                        logger.warning(
                            f"[trace={self.trace_id}] Subagent {self.config.name} observed external timeout while streaming; aborting local updates"
                        )
                        return result

                    previous_count = len(result.ai_messages)
                    self._collect_ai_messages_from_state(chunk, result)
                    if len(result.ai_messages) > previous_count:
                        if tool_names:
                            logger.info(
                                f"[trace={self.trace_id}] Subagent {self.config.name} captured AI message "
                                f"#{len(result.ai_messages)} tools={tool_names}"
                            )
                        else:
                            logger.info(
                                f"[trace={self.trace_id}] Subagent {self.config.name} captured AI message #{len(result.ai_messages)}"
                            )
                    persist_background_task_status_payload(result)
            else:
                final_state = await agent.ainvoke(state, config=run_config, context=context)  # type: ignore[arg-type]
                snapshot_updated_at = datetime.now()
                result.last_update_at = snapshot_updated_at
                live_snapshot = _extract_live_state_snapshot(final_state)
                if live_snapshot is not None:
                    result.live_state = live_snapshot
                    live_signature = _snapshot_signature(live_snapshot)
                    if live_signature != result._live_state_signature:
                        result._live_state_signature = live_signature
                        result.last_progress_at = snapshot_updated_at
                self._collect_ai_messages_from_state(final_state, result)

                messages = final_state.get("messages", []) if isinstance(final_state, dict) else []
                for msg in reversed(messages):
                    if isinstance(msg, AIMessage):
                        result.last_ai_message_summary = self._summarize_ai_message(msg)
                        break
                persist_background_task_status_payload(result)

            result.total_stream_ms = round((time.perf_counter() - stream_start_perf) * 1000)

            if cancel_event and cancel_event.is_set():
                raise SubagentCancelledError("Execution cancelled by user")

            logger.info(
                f"[trace={self.trace_id}] Subagent {self.config.name} completed async execution "
                f"iterations={result.iteration_count} total_ms={result.total_stream_ms} "
                f"slowest_iter_ms={result.slowest_iteration_ms}"
            )
            if _timed_out_externally():
                logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} completed after timeout; ignoring completion write")
                return result

            # Store final state for callers that need structured data (e.g., builder_result)
            result.final_state = final_state
            final_snapshot = _extract_live_state_snapshot(final_state)
            if final_snapshot is not None:
                result.live_state = final_snapshot
                result._live_state_signature = _snapshot_signature(final_snapshot)

            if final_state is None:
                logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} no final state")
                result.result = "No response generated"
            else:
                # Extract the final message - find the last AIMessage
                messages = final_state.get("messages", [])
                logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} final messages count: {len(messages)}")

                # Find the last AIMessage in the conversation
                last_ai_message = None
                for msg in reversed(messages):
                    if isinstance(msg, AIMessage):
                        last_ai_message = msg
                        break

                if last_ai_message is not None:
                    content = last_ai_message.content
                    # Handle both str and list content types for the final result
                    if isinstance(content, str):
                        result.result = content
                    elif isinstance(content, list):
                        # Extract text from list of content blocks for final result only
                        text_parts = []
                        for block in content:
                            if isinstance(block, str):
                                text_parts.append(block)
                            elif isinstance(block, dict) and "text" in block:
                                text_parts.append(block["text"])
                        result.result = "\n".join(text_parts) if text_parts else "No text content in response"
                    else:
                        result.result = str(content)
                elif messages:
                    # Fallback: use the last message if no AIMessage found
                    last_message = messages[-1]
                    logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} no AIMessage found, using last message: {type(last_message)}")
                    result.result = str(last_message.content) if hasattr(last_message, "content") else str(last_message)
                else:
                    logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} no messages in final state")
                    result.result = "No response generated"

            if _timed_out_externally():
                logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} hit timeout before final status write; preserving TIMED_OUT")
                return result

            result.status = SubagentStatus.COMPLETED
            result.completed_at = datetime.now()
            result.last_update_at = result.completed_at
            result.last_progress_at = result.completed_at

        except SubagentCancelledError as e:
            logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} cancelled")
            result.status = SubagentStatus.CANCELLED
            result.error = str(e)
            result.error_type = type(e).__qualname__
            result.completed_at = datetime.now()
            result.last_update_at = result.completed_at
        except Exception as e:
            if _timed_out_externally():
                logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} raised after timeout; preserving TIMED_OUT state")
                result.error_type = type(e).__qualname__
                return result
            if _is_event_loop_closed_error(e):
                # Known cross-task contamination: one subagent's event loop
                # closed while another's async work was still in flight
                # (typically shared httpx transports or pending callbacks).
                # Use a bounded warning rather than a full traceback — the
                # stack is not actionable and the recurrent log noise from
                # logger.exception obscures the real failure surface.
                logger.warning(
                    "[trace=%s] Subagent %s hit %r during execution (task_id=%s thread_id=%s)",
                    self.trace_id,
                    self.config.name,
                    _EVENT_LOOP_CLOSED_MSG,
                    result.task_id,
                    self.thread_id,
                )
                result.status = SubagentStatus.FAILED
                result.error = f"Event loop closed during subagent execution: {e}"
                result.error_type = "EventLoopClosed"
                result.completed_at = datetime.now()
                result.last_update_at = result.completed_at
            else:
                logger.exception(
                    f"[trace={self.trace_id}] Subagent {self.config.name} async execution failed: "
                    f"{type(e).__qualname__}: {e}"
                )
                result.status = SubagentStatus.FAILED
                result.error = str(e)
                result.error_type = type(e).__qualname__
                result.completed_at = datetime.now()
                result.last_update_at = result.completed_at
        finally:
            heartbeat_stop_event.set()
            if not heartbeat_task.done():
                heartbeat_task.cancel()
            try:
                await heartbeat_task
            except (asyncio.CancelledError, Exception):  # pragma: no cover - cleanup path
                pass

        persist_background_task_status_payload(result)
        return result

    def execute(
        self,
        task: str,
        result_holder: SubagentResult | None = None,
        cancel_event: threading.Event | None = None,
    ) -> SubagentResult:
        """Execute a task synchronously (wrapper around async execution).

        This method runs the async execution in a new event loop, allowing
        asynchronous tools (like MCP tools) to be used within the thread pool.

        Args:
            task: The task description for the subagent.
            result_holder: Optional pre-created result object to update during execution.

        Returns:
            SubagentResult with the execution result.
        """
        # Run the async execution in a new event loop
        # This is necessary because:
        # 1. We may have async-only tools (like MCP tools)
        # 2. We're running inside a ThreadPoolExecutor which doesn't have an event loop
        #
        # Note: _aexecute() catches all exceptions internally, so this outer
        # try-except only handles asyncio.run() failures (e.g., if called from
        # an async context where an event loop already exists). Subagent execution
        # errors are handled within _aexecute() and returned as FAILED status.
        try:
            return asyncio.run(self._aexecute(task, result_holder, cancel_event))
        except Exception as e:
            if result_holder is not None and result_holder.status == SubagentStatus.TIMED_OUT:
                logger.warning(f"[trace={self.trace_id}] Subagent {self.config.name} execute() raised after timeout; preserving terminal TIMED_OUT")
                return result_holder
            # Classify ``RuntimeError("Event loop is closed")`` explicitly so
            # the debug surface can call it out. The loop can close here
            # when asyncio.run()'s new loop is disposed before async cleanup
            # (e.g. httpx transports) finishes. Prefer a warning without the
            # traceback — the stack is not actionable and the noise buries
            # real failure signal in the logs.
            event_loop_closed = _is_event_loop_closed_error(e)
            if event_loop_closed:
                logger.warning(
                    "[trace=%s] Subagent %s execute() hit %r (thread_id=%s)",
                    self.trace_id,
                    self.config.name,
                    _EVENT_LOOP_CLOSED_MSG,
                    self.thread_id,
                )
            else:
                logger.exception(f"[trace={self.trace_id}] Subagent {self.config.name} execution failed")
            # Create a result with error if we don't have one
            if result_holder is not None:
                result = result_holder
            else:
                result = SubagentResult(
                    task_id=str(uuid.uuid4())[:8],
                    trace_id=self.trace_id,
                    status=SubagentStatus.FAILED,
                    thread_id=self.thread_id,
                )
            result.status = SubagentStatus.FAILED
            result.error = (
                f"Event loop closed during subagent execution: {e}"
                if event_loop_closed
                else str(e)
            )
            result.error_type = "EventLoopClosed" if event_loop_closed else type(e).__qualname__
            result.completed_at = datetime.now()
            return result

    def execute_async(
        self,
        task: str,
        task_id: str | None = None,
        owner_id: str | None = None,
        description: str | None = None,
    ) -> str:
        """Start a task execution in the background.

        Args:
            task: The task description for the subagent.
            task_id: Optional task ID to use. If not provided, a random UUID will be generated.

        Returns:
            Task ID that can be used to check status later.
        """
        # Use provided task_id or generate a new one
        if task_id is None:
            task_id = str(uuid.uuid4())[:8]

        # Create initial pending result
        result = SubagentResult(
            task_id=task_id,
            trace_id=self.trace_id,
            status=SubagentStatus.PENDING,
            thread_id=self.thread_id,
            owner_id=owner_id,
            description=description,
        )
        cancel_event = threading.Event()

        logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} starting async execution, task_id={task_id}, timeout={self.config.timeout_seconds}s")

        with _background_tasks_lock:
            _background_tasks[task_id] = result
            _background_task_cancel_events[task_id] = cancel_event
        persist_background_task_status_payload(result)

        # Submit to scheduler pool
        def run_task():
            with _background_tasks_lock:
                current = _background_tasks.get(task_id)
                if current is None or current.status == SubagentStatus.CANCELLED:
                    return
                current.status = SubagentStatus.RUNNING
                current.started_at = datetime.now()
                result_holder = current
            persist_background_task_status_payload(result_holder)

            try:
                # Submit execution to execution pool with timeout
                # Pass result_holder so execute() can update it in real-time
                execution_future: Future = _execution_pool.submit(self.execute, task, result_holder, cancel_event)
                with _background_tasks_lock:
                    if task_id in _background_tasks:
                        _background_task_futures[task_id] = execution_future
                try:
                    # Wait for execution with timeout
                    exec_result = execution_future.result(timeout=self.config.timeout_seconds)
                    with _background_tasks_lock:
                        task_state = _background_tasks.get(task_id)
                        if task_state is None:
                            logger.warning(f"[trace={self.trace_id}] Task {task_id} missing at completion write; skipping late update")
                            return
                        if task_state.status == SubagentStatus.CANCELLED:
                            return
                        if task_state.status == SubagentStatus.TIMED_OUT:
                            logger.warning(
                                f"[trace={self.trace_id}] Task {task_id} already timed out; ignoring late completion write"
                            )
                            return
                        task_state.status = exec_result.status
                        task_state.result = exec_result.result
                        task_state.error = exec_result.error
                        task_state.error_type = exec_result.error_type
                        task_state.completed_at = exec_result.completed_at or datetime.now()
                        task_state.ai_messages = exec_result.ai_messages
                        task_state.final_state = exec_result.final_state
                        task_state.last_ai_message_summary = exec_result.last_ai_message_summary
                        task_state.late_ai_message_summary = exec_result.late_ai_message_summary
                        task_state.timeout_observed_during_stream = exec_result.timeout_observed_during_stream
                        task_state.timed_out_at = exec_result.timed_out_at
                        task_state.iteration_count = exec_result.iteration_count
                        task_state.iteration_durations_ms = exec_result.iteration_durations_ms
                        task_state.slowest_iteration_ms = exec_result.slowest_iteration_ms
                        task_state.total_stream_ms = exec_result.total_stream_ms
                    persist_background_task_status_payload(task_state)
                except FuturesTimeoutError:
                    logger.error(
                        f"[trace={self.trace_id}] Subagent {self.config.name} execution timed out after {self.config.timeout_seconds}s "
                        f"iterations={result_holder.iteration_count} slowest_iter_ms={result_holder.slowest_iteration_ms}"
                    )
                    with _background_tasks_lock:
                        task_state = _background_tasks.get(task_id)
                        if task_state is None or task_state.status == SubagentStatus.CANCELLED:
                            return
                        task_state.status = SubagentStatus.TIMED_OUT
                        task_state.error = f"Execution timed out after {self.config.timeout_seconds} seconds"
                        task_state.error_type = "FuturesTimeoutError"
                        task_state.completed_at = datetime.now()
                        task_state.timed_out_at = task_state.completed_at
                    persist_background_task_status_payload(task_state)
                    # Cancel the future (best effort - may not stop the actual execution)
                    cancel_event.set()
                    execution_future.cancel()
                except FuturesCancelledError:
                    logger.info(f"[trace={self.trace_id}] Subagent {self.config.name} future cancelled")
                    with _background_tasks_lock:
                        current = _background_tasks.get(task_id)
                        if current is not None and current.status != SubagentStatus.CANCELLED:
                            current.status = SubagentStatus.CANCELLED
                            current.error = "Execution cancelled by user"
                            current.completed_at = datetime.now()
                            persist_background_task_status_payload(current)
            except Exception as e:
                logger.exception(
                    f"[trace={self.trace_id}] Subagent {self.config.name} async execution failed: "
                    f"{type(e).__qualname__}: {e}"
                )
                with _background_tasks_lock:
                    task_state = _background_tasks.get(task_id)
                    if task_state is None or task_state.status in {
                        SubagentStatus.CANCELLED,
                        SubagentStatus.TIMED_OUT,
                    }:
                        return
                    task_state.status = SubagentStatus.FAILED
                    task_state.error_type = type(e).__qualname__
                    task_state.error = str(e)
                    task_state.completed_at = datetime.now()
                persist_background_task_status_payload(task_state)
            finally:
                with _background_tasks_lock:
                    _background_task_futures.pop(task_id, None)

        _scheduler_pool.submit(run_task)
        return task_id


MAX_CONCURRENT_SUBAGENTS = 3


def get_background_task_result(task_id: str) -> SubagentResult | None:
    """Get the result of a background task.

    Args:
        task_id: The task ID returned by execute_async.

    Returns:
        SubagentResult if found, None otherwise.
    """
    with _background_tasks_lock:
        return _background_tasks.get(task_id)


def list_background_tasks() -> list[SubagentResult]:
    """List all background tasks.

    Returns:
        List of all SubagentResult instances.
    """
    with _background_tasks_lock:
        return list(_background_tasks.values())


def get_latest_task_for_thread(thread_id: str) -> SubagentResult | None:
    """Return the most recently started in-memory task for a given thread.

    Searches all background tasks matching *thread_id* and returns the one
    with the latest ``started_at`` timestamp.  Returns ``None`` when no
    matching task is found.
    """
    with _background_tasks_lock:
        candidates = [
            t for t in _background_tasks.values()
            if t.thread_id == thread_id
        ]
    if not candidates:
        return None
    return max(candidates, key=lambda t: t.started_at or datetime.min)


def cleanup_background_task(task_id: str) -> None:
    """Remove a completed task from background tasks.

    Should be called by task_tool after it finishes polling and returns the result.
    This prevents memory leaks from accumulated completed tasks.

    Only removes tasks that are in a terminal state (COMPLETED/FAILED/TIMED_OUT)
    to avoid race conditions with the background executor still updating the task entry.

    Args:
        task_id: The task ID to remove.
    """
    with _background_tasks_lock:
        result = _background_tasks.get(task_id)
        if result is None:
            # Nothing to clean up; may have been removed already.
            logger.debug("Requested cleanup for unknown background task %s", task_id)
            return

        # Only clean up tasks that are in a terminal state to avoid races with
        # the background executor still updating the task entry.
        is_terminal_status = result.status in {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.TIMED_OUT,
            SubagentStatus.CANCELLED,
        }
        if is_terminal_status or result.completed_at is not None:
            del _background_tasks[task_id]
            _background_task_futures.pop(task_id, None)
            _background_task_cancel_events.pop(task_id, None)
            logger.debug("Cleaned up background task: %s", task_id)
        else:
            logger.debug(
                "Skipping cleanup for non-terminal background task %s (status=%s)",
                task_id,
                result.status.value if hasattr(result.status, "value") else result.status,
            )


def cancel_background_task(task_id: str, reason: str = "Execution cancelled by user") -> SubagentResult | None:
    """Cancel a running background task by ID.

    Marks the task as cancelled immediately so polling callers can stop,
    signals the execution loop to exit cooperatively, and attempts to cancel
    the underlying Future if it has not started yet.
    """

    execution_future: Future[Any] | None = None
    cancel_event: threading.Event | None = None

    with _background_tasks_lock:
        result = _background_tasks.get(task_id)
        if result is None:
            return None

        if result.status in {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.TIMED_OUT,
            SubagentStatus.CANCELLED,
        }:
            return result

        result.cancel_requested = True
        result.status = SubagentStatus.CANCELLED
        result.error = reason
        result.completed_at = datetime.now()
        execution_future = _background_task_futures.get(task_id)
        cancel_event = _background_task_cancel_events.get(task_id)

    persist_background_task_status_payload(result)

    if cancel_event is not None:
        cancel_event.set()

    if execution_future is not None:
        execution_future.cancel()

    logger.info("Cancelled background task: %s", task_id)
    return result
