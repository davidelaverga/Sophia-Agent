"""LifecycleToolObserverMiddleware — structured-log observability for the
companion's deepagents lifecycle tool selection.

Logs one structured ``lifecycle_tool_call`` line every time the model emits a
tool_call for any of:

- ``start_builder_task``
- ``edit_builder_artifact``
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
    "edit_builder_artifact",
    "update_async_task",
    "check_async_task",
    "cancel_async_task",
    "list_async_tasks",
})


def _resolve_from_runtime(
    runtime: Runtime | None, state: dict[str, Any], key: str
) -> str | None:
    """Resolve ``thread_id`` / ``user_id`` from the runtime config and context,
    with a state fallback.

    Sophia's state does NOT carry ``thread_id`` in normal companion runs —
    it lives in ``runtime.config["configurable"]`` (set by the LangGraph
    SDK on every invocation) and is mirrored into ``runtime.context`` by
    the gateway. Without this lookup, the lifecycle_tool_call log loses
    per-conversation correlation in production, which is the whole point
    of the hook. State is checked last as a defensive fallback.
    """
    if runtime is not None:
        config = getattr(runtime, "config", None) or {}
        if isinstance(config, dict):
            configurable = config.get("configurable") or {}
            if isinstance(configurable, dict):
                value = configurable.get(key)
                if value:
                    return value
        context = getattr(runtime, "context", None) or {}
        if isinstance(context, dict):
            value = context.get(key)
            if value:
                return value
    return state.get(key)


class LifecycleToolObserverMiddleware(AgentMiddleware):
    """Emit a structured log line per lifecycle-tool call on the AIMessage."""

    async def aafter_model(
        self, state: dict[str, Any], runtime: Runtime
    ) -> dict | None:
        return self._emit(state, runtime)

    def after_model(
        self, state: dict[str, Any], runtime: Runtime
    ) -> dict | None:
        return self._emit(state, runtime)

    @staticmethod
    def _emit(state: dict[str, Any], runtime: Runtime | None) -> None:
        messages = state.get("messages") or []
        if not messages:
            return None
        msg = messages[-1]
        tool_calls = getattr(msg, "tool_calls", None) or []
        if not tool_calls and isinstance(msg, dict):
            tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            return None
        thread_id = _resolve_from_runtime(runtime, state, "thread_id")
        user_id = _resolve_from_runtime(runtime, state, "user_id")
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
                    "thread_id": thread_id,
                    "turn_count": state.get("turn_count"),
                    "user_id": user_id,
                },
            )
        return None
