"""Prompt assembly middleware.

Runs via wrap_model_call to assemble all system_prompt_blocks accumulated by
other middlewares into a single system message prepended to the conversation.

Uses wrap_model_call (not before_model) to have direct control over the
messages sent to the model — this avoids add_messages reducer edge cases
with RemoveMessage and ensures the system prompt is always the first message.
"""

import time
from collections.abc import Awaitable, Callable
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import HumanMessage, SystemMessage

from deerflow.agents.middlewares.dangling_tool_call_middleware import patch_dangling_tool_call_messages
from deerflow.agents.sophia_agent.utils import log_middleware


class PromptAssemblyState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]


class PromptAssemblyMiddleware(AgentMiddleware[PromptAssemblyState]):
    """Assemble system_prompt_blocks into the system message.

    Uses wrap_model_call to directly manipulate the messages sent to the model,
    ensuring:
    1. All prior SystemMessages are removed (no duplicates)
    2. The assembled system message is always first
    3. At least one non-system message (HumanMessage) is preserved
    """

    state_schema = PromptAssemblyState

    _SYSTEM_MSG_ID = "sophia-system-prompt"

    def _assemble_messages(self, request: ModelRequest) -> ModelRequest | None:
        """Build messages with the assembled system prompt prepended."""
        _t0 = time.perf_counter()

        patched_messages = patch_dangling_tool_call_messages(request.messages)
        if patched_messages is not None:
            request = request.override(messages=patched_messages)

        # Access system_prompt_blocks from the current state
        state = request.state
        blocks = state.get("system_prompt_blocks", [])
        if not blocks:
            if patched_messages is not None:
                log_middleware("PromptAssembly", "skipped assembly (patched dangling tool calls)", _t0)
                return request
            log_middleware("PromptAssembly", "skipped (no blocks)", _t0)
            return None

        system_content = "\n\n---\n\n".join(blocks)

        # Filter out any existing SystemMessages from the request messages.
        # Also detect and absorb the SummarizationMiddleware's HumanMessage
        # into the system prompt so the model treats it as context — not as
        # user input that it should echo back.
        non_system: list = []
        summary_block: str | None = None
        for m in request.messages:
            if isinstance(m, SystemMessage):
                continue
            if (
                summary_block is None
                and isinstance(m, HumanMessage)
                and isinstance(m.content, str)
                and m.content.startswith("Here is a summary of the conversation to date:")
            ):
                summary_block = m.content
                continue
            non_system.append(m)

        if not non_system:
            log_middleware("PromptAssembly", "ERROR: no non-system messages found", _t0)
            return None

        # Append absorbed summary to the system prompt so it's treated as
        # context rather than user speech.
        if summary_block:
            system_content += "\n\n---\n\n" + summary_block

        # Prepend the assembled system message
        assembled = [SystemMessage(content=system_content, id=self._SYSTEM_MSG_ID)] + non_system

        log_middleware(
            "PromptAssembly",
            f"{len(blocks)} blocks assembled ({sum(len(b) for b in blocks)} chars), "
            f"{len(non_system)} conversation messages",
            _t0,
        )
        return request.override(messages=assembled)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        patched = self._assemble_messages(request)
        if patched is not None:
            request = patched
        _t0 = time.perf_counter()
        result = handler(request)
        elapsed = (time.perf_counter() - _t0) * 1000
        log_middleware("LLM", f"model call completed ({elapsed:.0f}ms)", _t0)
        return result

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        patched = self._assemble_messages(request)
        if patched is not None:
            request = patched
        _t0 = time.perf_counter()
        result = await handler(request)
        elapsed = (time.perf_counter() - _t0) * 1000
        log_middleware("LLM", f"model call completed ({elapsed:.0f}ms)", _t0)
        return result
