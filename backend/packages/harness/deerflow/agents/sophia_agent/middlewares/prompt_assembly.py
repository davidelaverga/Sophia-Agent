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

    _SYSTEM_MSG_ID = "sophia-system-prompt"

    @override
    def before_model(self, state: PromptAssemblyState, runtime: Runtime) -> dict | None:
        blocks = state.get("system_prompt_blocks", [])
        if not blocks:
            return None

        system_content = "\n\n---\n\n".join(blocks)

        # Use a stable ID so add_messages reducer replaces rather than duplicates.
        # RemoveMessage removes any prior system message, then we add the new one.
        from langchain_core.messages import RemoveMessage

        messages = list(state.get("messages", []))
        updates = []

        # Remove existing system messages
        for m in messages:
            if isinstance(m, SystemMessage):
                updates.append(RemoveMessage(id=m.id))

        # Add the assembled system message with a stable ID
        updates.append(SystemMessage(content=system_content, id=self._SYSTEM_MSG_ID))

        return {"messages": updates}
