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
from langchain_core.messages import SystemMessage

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

        # Access system_prompt_blocks from the current state
        state = request.state
        blocks = state.get("system_prompt_blocks", [])
        if not blocks:
            log_middleware("PromptAssembly", "skipped (no blocks)", _t0)
            return None

        system_content = "\n\n---\n\n".join(blocks)

        # Filter out any existing SystemMessages from the request messages
        non_system = [m for m in request.messages if not isinstance(m, SystemMessage)]

        if not non_system:
            log_middleware("PromptAssembly", "ERROR: no non-system messages found", _t0)
            return None

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
