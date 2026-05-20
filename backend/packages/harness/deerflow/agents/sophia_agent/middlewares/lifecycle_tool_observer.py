"""LifecycleToolObserverMiddleware — structured-log observability for the
companion's deepagents lifecycle tool selection.

Logs one structured ``lifecycle_tool_call`` line every time the model emits a
tool_call for any of:

- ``start_builder_task``
- ``update_async_task``
- ``check_async_task``
- ``cancel_async_task``
- ``list_async_tasks``

Lets us measure tool-selection health post-deploy without hooking into the
deepagents-native AsyncSubAgentMiddleware. Hooks ``aafter_model`` so the
inspection happens once per model turn, after Claude has emitted tool_calls
on the AIMessage but before the tools execute.

The middleware is purely observational — it never mutates state or raises.
Position it AFTER BuildAwarenessMiddleware (so the active-build block has
already shaped this turn's prompt) and BEFORE ArtifactMiddleware (so
emit_artifact-related logging stays adjacent to artifact handling).
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger("sophia.lifecycle_tool_observer")

_LIFECYCLE_TOOLS = frozenset({
    "start_builder_task",
    "update_async_task",
    "check_async_task",
    "cancel_async_task",
    "list_async_tasks",
})


class LifecycleToolObserverMiddleware(AgentMiddleware):
    """Emit a structured log line per lifecycle-tool call on the AIMessage."""

    async def aafter_model(
        self, state: dict[str, Any], runtime: Runtime
    ) -> dict | None:
        return self._emit(state)

    def after_model(
        self, state: dict[str, Any], runtime: Runtime
    ) -> dict | None:
        return self._emit(state)

    @staticmethod
    def _emit(state: dict[str, Any]) -> None:
        messages = state.get("messages") or []
        if not messages:
            return None
        msg = messages[-1]
        tool_calls = getattr(msg, "tool_calls", None) or []
        if not tool_calls and isinstance(msg, dict):
            tool_calls = msg.get("tool_calls") or []
        for tc in tool_calls:
            if isinstance(tc, dict):
                name = tc.get("name")
                args = tc.get("args") or {}
            else:
                name = getattr(tc, "name", None)
                args = getattr(tc, "args", None) or {}
            if name not in _LIFECYCLE_TOOLS:
                continue
            logger.info(
                "lifecycle_tool_call",
                extra={
                    "tool_name": name,
                    "task_id": args.get("task_id") if isinstance(args, dict) else None,
                    "thread_id": state.get("thread_id"),
                    "turn_count": state.get("turn_count"),
                    "user_id": state.get("user_id"),
                },
            )
        return None
