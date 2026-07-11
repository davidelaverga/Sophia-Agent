"""No-op-by-default lifecycle boundary immediately before model assembly."""

from __future__ import annotations

from typing import Any, NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import interrupt

from deerflow.sophia.build_runtime.hooks import BuildLifecycleHooks


class BuildSafeBoundaryState(AgentState):
    builder_graph_halted: NotRequired[bool]
    builder_boundary_sequence: NotRequired[int]


def _tool_calls_settled(messages: list[Any]) -> bool:
    pending: set[str] = set()
    for message in messages:
        if isinstance(message, AIMessage):
            pending.update(str(call.get("id")) for call in (message.tool_calls or []) if call.get("id"))
        elif isinstance(message, ToolMessage) and message.tool_call_id:
            pending.discard(str(message.tool_call_id))
    return not pending


class BuildSafeBoundaryMiddleware(AgentMiddleware[BuildSafeBoundaryState]):
    state_schema = BuildSafeBoundaryState

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state: BuildSafeBoundaryState, runtime: Runtime | None = None) -> dict | None:
        if state.get("builder_graph_halted") is True:
            return None
        messages = list(state.get("messages") or [])
        if not _tool_calls_settled(messages):
            return None
        context = runtime.context if runtime is not None and isinstance(runtime.context, dict) else {}
        hooks = context.get("build_lifecycle_hooks")
        if not isinstance(hooks, BuildLifecycleHooks) or not hooks.at_safe_boundary:
            return None
        sequence = int(state.get("builder_boundary_sequence", 0) or 0) + 1
        decision = await hooks.run_safe_boundary(dict(state))
        update: dict[str, Any] = {"builder_boundary_sequence": sequence}
        if decision.action == "pause":
            resumed = interrupt(
                {
                    "schema_version": decision.resume_schema_version,
                    "reason": decision.reason,
                    "boundary_sequence": sequence,
                }
            )
            update["builder_boundary_resume"] = resumed
        elif decision.action == "terminate":
            update.update(
                {
                    "builder_graph_halted": True,
                    "builder_terminal_halt_reason": decision.reason or "safe_boundary_terminated",
                    "jump_to": "end",
                }
            )
        return update
