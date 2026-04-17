"""Summary absorber middleware.

Runs AFTER SummarizationMiddleware to convert its HumanMessage summary
into a system_prompt_block and remove it from the conversation messages.

Uses before_model (not before_agent) because the SummarizationMiddleware
also uses before_model.  before_agent runs BEFORE before_model, so it
would never see the summary HumanMessage.  By using before_model and
being positioned after SummarizationMiddleware in the chain, this
middleware sees the state after summarization has already injected the
HumanMessage.
"""

import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, RemoveMessage

from deerflow.agents.sophia_agent.utils import log_middleware

_SUMMARY_PREFIX = "Here is a summary of the conversation to date:"


class SummaryAbsorberState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]


class SummaryAbsorberMiddleware(AgentMiddleware[SummaryAbsorberState]):
    """Absorb the SummarizationMiddleware's HumanMessage into a system_prompt_block.

    This middleware:
    1. Scans messages for the summary HumanMessage
    2. Removes it from state via RemoveMessage (so it's not persisted)
    3. Adds the summary content as a system_prompt_block (so PromptAssembly
       includes it in the SystemMessage where the model won't echo it)

    Uses before_model to run after SummarizationMiddleware.before_model.
    """

    state_schema = SummaryAbsorberState

    @override
    def before_model(self, state: SummaryAbsorberState) -> dict | None:
        return self._absorb(state)

    @override
    async def abefore_model(self, state: SummaryAbsorberState) -> dict | None:
        return self._absorb(state)

    def _absorb(self, state: SummaryAbsorberState) -> dict | None:
        _t0 = time.perf_counter()
        messages = state.get("messages", [])

        # Find the summary HumanMessage
        summary_msg = None
        for m in messages:
            if (
                isinstance(m, HumanMessage)
                and isinstance(m.content, str)
                and m.content.startswith(_SUMMARY_PREFIX)
            ):
                summary_msg = m
                break

        if summary_msg is None:
            log_middleware("SummaryAbsorber", "no summary found", _t0)
            return None

        # Extract the summary content (strip the LangChain wrapper prefix)
        cleaned = summary_msg.content.replace(
            _SUMMARY_PREFIX + "\n\n", ""
        ).strip()

        # Build the system_prompt_block
        block = (
            "<prior_context_state>\n"
            + cleaned
            + "\n</prior_context_state>"
        )

        blocks = list(state.get("system_prompt_blocks", []))
        blocks.append(block)

        log_middleware(
            "SummaryAbsorber",
            f"absorbed summary ({len(cleaned)} chars) into system_prompt_blocks",
            _t0,
        )

        return {
            "messages": [RemoveMessage(id=summary_msg.id)],
            "system_prompt_blocks": blocks,
        }
