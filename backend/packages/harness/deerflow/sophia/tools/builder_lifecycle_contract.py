"""Dependency-safe contracts for Sophia builder lifecycle tools.

The realtime voice dogfood path imports this module to declare and validate the
existing builder/lifecycle tool surface without importing LangChain-decorated
tool implementations or deepagents middleware modules.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, Field

ASYNC_BUILDER_AGENT_NAME = "sophia_builder"

START_BUILDER_TASK_TOOL_NAME = "start_builder_task"
CHECK_ASYNC_TASK_TOOL_NAME = "check_async_task"
UPDATE_ASYNC_TASK_TOOL_NAME = "update_async_task"
CANCEL_ASYNC_TASK_TOOL_NAME = "cancel_async_task"
LIST_ASYNC_TASKS_TOOL_NAME = "list_async_tasks"

BUILDER_LIFECYCLE_TOOL_ORDER = (
    START_BUILDER_TASK_TOOL_NAME,
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
        "Delegate a build/create/generate/research/present request to Sophia's existing builder graph. "
        "This is the FIRST builder tool for a fresh user request that needs execution, including "
        "file creation, research with sources, document, presentation, visual_report, or frontend "
        "generation. Returns the real task_id to use later; keep talking to the user."
    ),
    CHECK_ASYNC_TASK_TOOL_NAME: (
        "Check the status of an existing async builder task. Use ONLY with a real task_id "
        "previously returned by start_builder_task or list_async_tasks in the current trusted session. "
        "Never invent a task id and never call this before a task exists. Returns current status "
        "and, if complete, the result."
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
        "For a fresh build/create/generate request, call start_builder_task first."
    ),
}

TOOL_INPUT_MODELS: dict[str, type[BaseModel]] = {
    START_BUILDER_TASK_TOOL_NAME: StartBuilderTaskInput,
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
