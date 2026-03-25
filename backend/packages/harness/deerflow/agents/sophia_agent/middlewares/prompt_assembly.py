"""Prompt assembly middleware.

Runs in before_model to assemble all system_prompt_blocks accumulated by
other middlewares into a single system message prepended to the conversation.
"""

from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage
from langgraph.runtime import Runtime


class PromptAssemblyState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]


class PromptAssemblyMiddleware(AgentMiddleware[PromptAssemblyState]):
    """Assemble system_prompt_blocks into the system message."""

    state_schema = PromptAssemblyState

    @override
    def before_model(self, state: PromptAssemblyState, runtime: Runtime) -> dict | None:
        blocks = state.get("system_prompt_blocks", [])
        if not blocks:
            return None

        system_content = "\n\n---\n\n".join(blocks)
        system_msg = SystemMessage(content=system_content)

        # Prepend system message to messages, removing any existing system message
        messages = list(state.get("messages", []))
        filtered = [m for m in messages if not isinstance(m, SystemMessage)]
        filtered.insert(0, system_msg)

        return {"messages": filtered}
