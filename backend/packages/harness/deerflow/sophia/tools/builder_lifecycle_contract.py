"""Dependency-safe contracts for Sophia builder lifecycle tools.

The realtime voice dogfood path imports this module to declare and validate the
existing builder/lifecycle tool surface without importing LangChain-decorated
tool implementations or deepagents middleware modules.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Literal, NamedTuple

from pydantic import BaseModel, Field

ASYNC_BUILDER_AGENT_NAME = "sophia_builder"

START_BUILDER_TASK_TOOL_NAME = "start_builder_task"
EDIT_BUILDER_ARTIFACT_TOOL_NAME = "edit_builder_artifact"
CHECK_ASYNC_TASK_TOOL_NAME = "check_async_task"
UPDATE_ASYNC_TASK_TOOL_NAME = "update_async_task"
CANCEL_ASYNC_TASK_TOOL_NAME = "cancel_async_task"
LIST_ASYNC_TASKS_TOOL_NAME = "list_async_tasks"

BUILDER_LIFECYCLE_TOOL_ORDER = (
    START_BUILDER_TASK_TOOL_NAME,
    EDIT_BUILDER_ARTIFACT_TOOL_NAME,
    CHECK_ASYNC_TASK_TOOL_NAME,
    UPDATE_ASYNC_TASK_TOOL_NAME,
    CANCEL_ASYNC_TASK_TOOL_NAME,
    LIST_ASYNC_TASKS_TOOL_NAME,
)

BUILDER_TASK_TYPE_VALUES = (
    "document",
    "research",
    "presentation",
    "frontend",
    "visual_report",
)

TERMINAL_TASK_STATUSES = frozenset(
    {
        "success",
        "completed",
        "error",
        "failed",
        "cancelled",
        "timeout",
        "timed_out",
    }
)

TASK_TYPE_PREFIXES: dict[str, str] = {
    "document": "[document]",
    "research": "[research]",
    "presentation": "[presentation]",
    "frontend": "[frontend]",
    "visual_report": "[visual_report]",
}

BuilderTaskType = Literal[
    "document",
    "research",
    "presentation",
    "frontend",
    "visual_report",
]
AsyncTaskStatusFilter = Literal["running", "success", "error", "cancelled", "all"]


class StartBuilderTaskInput(BaseModel):
    description: str = Field(
        min_length=1,
        description=(
            "Complete, self-contained brief for Sophia's builder. Include all "
            "specs gathered from the user; the builder cannot ask follow-up questions."
        ),
    )
    task_type: BuilderTaskType = Field(
        description="Type of deliverable: document, research, presentation, frontend, or visual_report."
    )
    user_id: str | None = Field(
        default=None,
        description=(
            "Diagnostic-only hint. Never overrides the trusted runtime user; "
            "leave null in normal operation."
        ),
    )


class EditBuilderArtifactInput(BaseModel):
    message: str = Field(
        min_length=1,
        description=(
            "Targeted edit request for a completed builder artifact. Preserve unrelated content."
        ),
    )
    artifact_path: str | None = Field(
        default=None,
        description="Optional exact /mnt/user-data/outputs/... path for the completed artifact to edit.",
    )
    task_id: str | None = Field(
        default=None,
        description="Optional completed builder task_id whose delivered artifact should be revised.",
    )
    user_id: str | None = Field(
        default=None,
        description=(
            "Diagnostic-only hint. Never overrides the trusted runtime user; "
            "leave null in normal operation."
        ),
    )


class CheckAsyncTaskInput(BaseModel):
    task_id: str = Field(
        min_length=1,
        description=(
            "The exact task_id string previously returned by start_builder_task or "
            "list_async_tasks in this trusted session. Pass it verbatim; never invent task ids."
        ),
    )


class UpdateAsyncTaskInput(BaseModel):
    task_id: str = Field(
        min_length=1,
        description=(
            "The exact task_id string for a tracked running builder task in this trusted session. "
            "Pass it verbatim; never invent task ids."
        ),
    )
    message: str = Field(
        min_length=1,
        description="Follow-up instructions or context to send to the running builder task.",
    )


class CancelAsyncTaskInput(BaseModel):
    task_id: str = Field(
        min_length=1,
        description=(
            "The exact task_id string for a tracked running builder task in this trusted session. "
            "Pass it verbatim; never invent task ids."
        ),
    )


class ListAsyncTasksInput(BaseModel):
    status_filter: AsyncTaskStatusFilter | None = Field(
        default=None,
        description=(
            "Filter tasks by cached status. One of: running, success, error, "
            "cancelled, all. Defaults to all."
        ),
    )


TOOL_DESCRIPTIONS: dict[str, str] = {
    START_BUILDER_TASK_TOOL_NAME: (
        "Delegate an async user-facing deliverable to Sophia's existing builder graph. "
        "Use this only for requests that need external execution or a downloadable/user-facing "
        "document, file, report, presentation, visual_report, frontend, or research deliverable. "
        "Do NOT use Builder for lightweight Sophia companion/session artifacts, short reflection "
        "artifacts, session takeaways, internal orientation, or Presence artifact UI state; those "
        "belong to emit_artifact. If artifact vs document is ambiguous, ask one clarifying question "
        "instead of starting Builder. This is the FIRST builder tool for an explicit fresh builder "
        "request. Returns the real task_id to use later; keep talking to the user."
    ),
    EDIT_BUILDER_ARTIFACT_TOOL_NAME: (
        "Edit a completed Sophia builder artifact. Use only after a build is terminal and "
        "the user asks to change, refine, add, remove, or adjust the delivered artifact. "
        "Pass a real artifact_path or task_id when available; otherwise the tool resolves "
        "the latest successful builder artifact from trusted session state. Do not use for "
        "active builds; use update_async_task while a builder task is still running."
    ),
    CHECK_ASYNC_TASK_TOOL_NAME: (
        "Check the status of an existing async builder task. Use ONLY with a real task_id "
        "previously returned by start_builder_task or list_async_tasks in the current trusted session. "
        "Never invent a task id and never call this before a task exists. Returns current status "
        "and, if complete, the result. Treat status=success as ready only when an accepted artifact_path "
        "is present. If status=error, report the build failure and never tell the user the artifact is ready."
    ),
    UPDATE_ASYNC_TASK_TOOL_NAME: (
        "Send updated instructions to a tracked running builder task. Use ONLY with a real task_id "
        "from start_builder_task or list_async_tasks in the current trusted session. Never invent task ids. "
        "The task_id/thread_id stays the same while the builder receives the new message."
    ),
    CANCEL_ASYNC_TASK_TOOL_NAME: (
        "Cancel a tracked running builder task at the user's request. Use ONLY with a real task_id "
        "from start_builder_task or list_async_tasks in the current trusted session. Never invent task ids."
    ),
    LIST_ASYNC_TASKS_TOOL_NAME: (
        "List tracked async builder tasks for the current runtime/session scope. Use when recalling "
        "active/completed tasks or recovering identifiers, not as a substitute for starting a new build. "
        "The returned status is artifact-authoritative: success means an accepted artifact exists, while "
        "error means the build failed and must never be announced as ready. "
        "For an explicit fresh document/file/report/build request, call start_builder_task first. "
        "For a short reflection or companion/session artifact request, use emit_artifact instead."
    ),
}

TOOL_INPUT_MODELS: dict[str, type[BaseModel]] = {
    START_BUILDER_TASK_TOOL_NAME: StartBuilderTaskInput,
    EDIT_BUILDER_ARTIFACT_TOOL_NAME: EditBuilderArtifactInput,
    CHECK_ASYNC_TASK_TOOL_NAME: CheckAsyncTaskInput,
    UPDATE_ASYNC_TASK_TOOL_NAME: UpdateAsyncTaskInput,
    CANCEL_ASYNC_TASK_TOOL_NAME: CancelAsyncTaskInput,
    LIST_ASYNC_TASKS_TOOL_NAME: ListAsyncTasksInput,
}


def validate_builder_lifecycle_tool_args(tool_name: str, args: Mapping[str, Any]) -> dict[str, Any]:
    model = TOOL_INPUT_MODELS.get(tool_name)
    if model is None:
        allowed = ", ".join(BUILDER_LIFECYCLE_TOOL_ORDER)
        raise ValueError(f"Unsupported builder lifecycle tool {tool_name!r}. Allowed tools: {allowed}.")
    return model.model_validate(dict(args)).model_dump()


def is_builder_task(task: Mapping[str, Any]) -> bool:
    return str(task.get("agent_name") or "") == ASYNC_BUILDER_AGENT_NAME


def authoritative_builder_result(
    task: Mapping[str, Any],
    thread_values: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    cached = task.get("builder_result")
    if isinstance(cached, dict):
        return dict(cached)
    child = (thread_values or {}).get("builder_result")
    return dict(child) if isinstance(child, dict) else None


class _BuilderResolution(NamedTuple):
    public_status: str
    internal_status: str
    terminal_reason: str
    result: dict[str, Any] | None


def _resolve_builder_status(
    result: dict[str, Any] | None,
    *,
    native_status: str,
    native_error: Any,
) -> _BuilderResolution:
    current = result or {}
    terminal = _resolved_terminal_status(current, result)
    if terminal is not None:
        return terminal
    if native_status == "success":
        return _missing_terminal_result(current)
    if native_status in {"error", "failed"}:
        return _native_error_result(current, native_error)
    return _BuilderResolution(native_status or "running", native_status or "running", "", result)


def _resolved_terminal_status(
    current: dict[str, Any],
    result: dict[str, Any] | None,
) -> _BuilderResolution | None:
    terminal_status = str(current.get("terminal_status") or current.get("status") or "").strip().lower()
    delivery_failure = _required_delivery_failure(current)
    if terminal_status == "completed" and delivery_failure is not None:
        failure_code, failure_summary = delivery_failure
        failed_result = {
            **current,
            "status": "failed",
            "terminal_status": "failed",
            "terminal_reason": failure_code,
            "failure_code": failure_code,
            "root_failure_code": current.get("root_failure_code") or failure_code,
            "root_failure_summary": current.get("root_failure_summary") or failure_summary,
            "summary": failure_summary,
            "artifact_acceptance_status": "failed",
            "unverified_artifact_path": current.get("artifact_path"),
            "artifact_path": None,
        }
        return _BuilderResolution("error", "failed", failure_code, failed_result)
    if terminal_status == "completed" and _builder_result_has_artifact(current):
        reason = str(current.get("terminal_reason") or "artifact_emitted")
        return _BuilderResolution("success", "completed", reason, result)
    if terminal_status in {"failed", "error"}:
        reason = str(current.get("terminal_reason") or current.get("failure_code") or "builder_failed")
        return _BuilderResolution("error", "failed", reason, result)
    if terminal_status in {"timed_out", "timeout"}:
        reason = str(current.get("terminal_reason") or "builder_timed_out")
        return _BuilderResolution("timeout", "timed_out", reason, result)
    return None


def _required_delivery_failure(result: dict[str, Any]) -> tuple[str, str] | None:
    diagnostics = result.get("builder_failure_diagnostics")
    diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
    failure_code = str(diagnostics.get("failure_code") or "").strip()
    mirror_result = str(diagnostics.get("supabase_mirror_result") or "").strip()
    if failure_code != "durable_storage_unavailable" and not mirror_result.startswith("required_"):
        return None
    summary = str(
        diagnostics.get("failure_reason")
        or "Builder artifact storage could not be verified for durable production delivery."
    ).strip()
    return failure_code or "durable_storage_unavailable", summary


def _builder_result_has_artifact(result: dict[str, Any]) -> bool:
    return bool(str(result.get("artifact_path") or result.get("artifact_url") or "").strip())


def _missing_terminal_result(current: dict[str, Any]) -> _BuilderResolution:
    reason = "builder_terminal_result_missing"
    result = {
        **current,
        "status": "failed",
        "terminal_status": "failed",
        "terminal_reason": reason,
        "failure_code": reason,
        "root_failure_code": current.get("root_failure_code") or reason,
        "summary": "The builder graph stopped without an accepted artifact result.",
        "artifact_path": None,
    }
    return _BuilderResolution("error", "incomplete", reason, result)


def _native_error_result(current: dict[str, Any], native_error: Any) -> _BuilderResolution:
    reason = str(current.get("terminal_reason") or "builder_graph_error")
    result = {
        **current,
        "status": "failed",
        "terminal_status": "failed",
        "terminal_reason": reason,
        "failure_code": current.get("failure_code") or reason,
        "summary": str(current.get("summary") or native_error or "The builder graph encountered an error."),
        "artifact_path": None,
    }
    return _BuilderResolution("error", "failed", reason, result)


def reconcile_builder_task(
    task: Mapping[str, Any],
    *,
    native_status: str | None = None,
    thread_values: Mapping[str, Any] | None = None,
    native_error: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve builder status without treating clean graph exit as artifact success."""

    merged = dict(task)
    result = authoritative_builder_result(task, thread_values)
    native = str(native_status or task.get("status") or "running").strip().lower()
    resolution = _resolve_builder_status(result, native_status=native, native_error=native_error)
    public_status, internal_status, terminal_reason, result = resolution

    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    previous_status = str(task.get("status") or "")
    merged["status"] = public_status
    merged["builder_internal_status"] = internal_status
    merged["last_checked_at"] = now
    if public_status != previous_status:
        merged["last_updated_at"] = now
    _apply_builder_result_metadata(merged, result)
    response = _builder_status_response(
        task,
        result=result,
        public_status=public_status,
        internal_status=internal_status,
        terminal_reason=terminal_reason,
    )
    return merged, response


def _apply_builder_result_metadata(merged: dict[str, Any], result: dict[str, Any] | None) -> None:
    if result is None:
        return
    merged["builder_result"] = result
    for key in (
        "artifact_path",
        "terminal_status",
        "terminal_reason",
        "failure_code",
        "root_failure_code",
        "root_failure_summary",
    ):
        # Preserve an explicit null artifact path on terminal failures. Its
        # presence is authoritative evidence for voice/UI readiness gates and
        # prevents stale paths from surviving a failed reconciliation.
        if key == "artifact_path" and key in result:
            merged[key] = result.get(key)
        elif result.get(key) is not None:
            merged[key] = result.get(key)


def _builder_status_response(
    task: Mapping[str, Any],
    *,
    result: dict[str, Any] | None,
    public_status: str,
    internal_status: str,
    terminal_reason: str,
) -> dict[str, Any]:
    response: dict[str, Any] = {
        "status": public_status,
        "thread_id": str(task.get("thread_id") or task.get("task_id") or ""),
        "terminal_status": internal_status if internal_status in {"completed", "failed", "timed_out", "incomplete"} else None,
        "terminal_reason": terminal_reason or None,
    }
    if result is not None:
        response.update(
            {
                key: result.get(key)
                for key in (
                    "artifact_path",
                    "artifact_url",
                    "artifact_type",
                    "summary",
                    "failure_code",
                    "root_failure_code",
                    "root_failure_summary",
                )
                if result.get(key) is not None
            }
        )
    return response
