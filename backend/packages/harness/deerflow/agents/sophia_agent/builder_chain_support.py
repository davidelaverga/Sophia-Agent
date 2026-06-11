"""Support pieces for the builder middleware chain.

Bridge module: ``builder_middlewares.py`` assembles the canonical chain and
sits right at sentrux's god-file fan-out threshold; the observability /
runtime-guard middlewares and the always-on Todo factory live behind this
single crossing point so the assembler's import fan-out stays under it.
"""

from __future__ import annotations

from deerflow.agents.middlewares.loop_detection_middleware import LoopDetectionMiddleware
from deerflow.agents.middlewares.todo_middleware import TodoMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_budget import BuilderBudgetMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_progress import BuilderProgressMiddleware

__all__ = [
    "BuilderBudgetMiddleware",
    "BuilderProgressMiddleware",
    "LoopDetectionMiddleware",
    "create_builder_todo_middleware",
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
