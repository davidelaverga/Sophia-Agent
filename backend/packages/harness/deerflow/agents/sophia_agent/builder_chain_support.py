"""Support pieces for the builder middleware chain.

Bridge module: ``builder_middlewares.py`` assembles the canonical chain and
sits right at sentrux's god-file fan-out threshold; the observability /
runtime-guard middlewares and the always-on Todo factory live behind this
single crossing point so the assembler's import fan-out stays under it.
"""

from __future__ import annotations

from deerflow.agents.middlewares.loop_detection_middleware import LoopDetectionMiddleware
from deerflow.agents.middlewares.todo_middleware import TodoMiddleware
from deerflow.agents.sophia_agent.middlewares.build_deadline import BuildDeadlineMiddleware
from deerflow.agents.sophia_agent.middlewares.build_safe_boundary import BuildSafeBoundaryMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_budget import BuilderBudgetMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_progress import BuilderProgressMiddleware
from deerflow.sophia.observability import (
    builder_trace_metadata,
    builder_trace_tags,
    enable_langsmith_tracing_for_builder_runnable,
    langsmith_builder_tracing_context,
    log_builder_tracing_startup_status,
)

__all__ = [
    "BuilderBudgetMiddleware",
    "BuildDeadlineMiddleware",
    "BuildSafeBoundaryMiddleware",
    "BuilderProgressMiddleware",
    "LoopDetectionMiddleware",
    "create_builder_todo_middleware",
    "builder_distributed_trace_context",
    "log_builder_tracing_startup_status",
    "wrap_builder_agent_for_observability",
]

_BUILDER_TODO_SYSTEM_PROMPT = """
<builder_todo_system>
You are the Sophia builder. Keep a live todo list while executing delegated build tasks.
- Use `write_todos` only for genuinely multi-step work.
- Create the initial todo list once near the start, then keep working.
- Do NOT rewrite the todo list after every small tool call.
- Update todos only when the plan materially changes, a major milestone finishes, or right before the final handoff.
- Keep at least one item in progress until the task is finished.
- Mark items completed as soon as a meaningful step is done.
</builder_todo_system>
"""

_BUILDER_TODO_TOOL_DESCRIPTION = (
    "Use this tool to maintain your execution todo list while building. "
    "Create it once for multi-step work, then update it only at meaningful milestones."
)

_BUILDER_TODO_REMINDER = (
    "Only call `write_todos` again if the plan materially changed, a major milestone finished, "
    "or you are preparing the final handoff."
)


def create_builder_todo_middleware() -> TodoMiddleware:
    """Always-on Todo middleware tuned for delegated build execution."""
    return TodoMiddleware(
        system_prompt=_BUILDER_TODO_SYSTEM_PROMPT,
        tool_description=_BUILDER_TODO_TOOL_DESCRIPTION,
        reminder_instruction=_BUILDER_TODO_REMINDER,
    )


def builder_distributed_trace_context(
    *,
    config: dict,
    parent: object,
    model_name: str | None,
    model_source: str | None,
    project_name: str | None = None,
    inherited_metadata: dict | None = None,
    inherited_tags: list[str] | tuple[str, ...] | None = None,
):
    """Restore the caller's LangSmith parent around one builder graph run."""

    metadata = dict(inherited_metadata or {})
    metadata.update(
        builder_trace_metadata(
            model_name=model_name,
            model_source=model_source,
            config=config,
        )
    )
    tags = [
        *(str(tag) for tag in (inherited_tags or ()) if isinstance(tag, str)),
        *builder_trace_tags(
            model_name=model_name,
            model_source=model_source,
        ),
    ]
    return langsmith_builder_tracing_context(
        parent=parent,
        project_name=project_name,
        metadata=metadata,
        tags=tags,
    )


def wrap_builder_agent_for_observability(
    agent,
    *,
    model_name: str | None = None,
    model_source: str | None = None,
    trace_config: dict | None = None,
):
    """Apply builder-only observability wrappers without expanding builder_agent fan-out."""

    return enable_langsmith_tracing_for_builder_runnable(
        agent,
        metadata=builder_trace_metadata(
            model_name=model_name,
            model_source=model_source,
            config=trace_config,
        ),
        tags=builder_trace_tags(
            model_name=model_name,
            model_source=model_source,
        ),
    )
