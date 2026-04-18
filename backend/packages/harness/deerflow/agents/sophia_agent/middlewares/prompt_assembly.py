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
    # Number of leading blocks that are stable across turns. When >0 and
    # caching is enabled, the assembled SystemMessage uses list-content with
    # Anthropic cache_control placed exactly after this prefix.
    system_prompt_cacheable_prefix_count: NotRequired[int]


class PromptAssemblyMiddleware(AgentMiddleware[PromptAssemblyState]):
    """Assemble system_prompt_blocks into the system message.

    Uses wrap_model_call to directly manipulate the messages sent to the model,
    ensuring:
    1. All prior SystemMessages are removed (no duplicates)
    2. The assembled system message is always first
    3. At least one non-system message (HumanMessage) is preserved

    When enable_prompt_caching=True, emits a SystemMessage with list-content
    blocks so that Anthropic prompt caching caches only the stable prefix
    (soul/voice/techniques) and not the dynamic per-turn content. Requires
    FileInjectionMiddleware to set ``system_prompt_cacheable_prefix_count``.
    """

    state_schema = PromptAssemblyState

    _SYSTEM_MSG_ID = "sophia-system-prompt"

    def __init__(self, enable_prompt_caching: bool = True, cache_ttl: str = "5m"):
        super().__init__()
        self._enable_caching = enable_prompt_caching
        self._cache_ttl = cache_ttl

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

        # Decide whether to emit structured cache-aware content or a plain string.
        prefix_count = state.get("system_prompt_cacheable_prefix_count", 0) or 0
        # Summary block (if any) is appended after all blocks; it is dynamic.
        # Only emit structured content when caching is enabled AND we actually
        # have a stable prefix AND at least one dynamic block follows it.
        use_cache_blocks = (
            self._enable_caching
            and prefix_count > 0
            and prefix_count < len(blocks)
        )

        if use_cache_blocks:
            prefix_text = "\n\n---\n\n".join(blocks[:prefix_count])
            tail_text = "\n\n---\n\n".join(blocks[prefix_count:])
            if summary_block:
                tail_text += "\n\n---\n\n" + summary_block
            content_blocks = [
                {
                    "type": "text",
                    "text": prefix_text,
                    "cache_control": {"type": "ephemeral", "ttl": self._cache_ttl},
                },
                {"type": "text", "text": tail_text},
            ]
            system_message = SystemMessage(content=content_blocks, id=self._SYSTEM_MSG_ID)
            log_middleware(
                "PromptAssembly",
                f"{len(blocks)} blocks assembled ("
                f"cache_prefix={prefix_count}/{len(blocks[:prefix_count])}, "
                f"prefix_chars={len(prefix_text)}, tail_chars={len(tail_text)}), "
                f"{len(non_system)} conversation messages",
                _t0,
            )
        else:
            system_content = "\n\n---\n\n".join(blocks)
            if summary_block:
                system_content += "\n\n---\n\n" + summary_block
            system_message = SystemMessage(content=system_content, id=self._SYSTEM_MSG_ID)
            log_middleware(
                "PromptAssembly",
                f"{len(blocks)} blocks assembled ({sum(len(b) for b in blocks)} chars, no_cache), "
                f"{len(non_system)} conversation messages",
                _t0,
            )

        assembled = [system_message] + non_system
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
        _log_cache_usage(result)
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
        _log_cache_usage(result)
        log_middleware("LLM", f"model call completed ({elapsed:.0f}ms)", _t0)
        return result


def _log_cache_usage(result) -> None:
    """Log Anthropic cache usage metadata when present.

    Anthropic returns cache_read_input_tokens / cache_creation_input_tokens in
    usage_metadata.input_token_details. We surface it so the perf scripts can
    confirm cache hit rate without scraping the raw HTTP bodies.

    ModelResponse.result is a list[BaseMessage]; we look at the last AI message.
    """
    try:
        ai_msg = None
        result_list = getattr(result, "result", None)
        if isinstance(result_list, list):
            for m in reversed(result_list):
                if getattr(m, "type", None) == "ai" and getattr(m, "usage_metadata", None):
                    ai_msg = m
                    break
        if ai_msg is None and hasattr(result, "usage_metadata"):
            ai_msg = result
        if ai_msg is None:
            return
        usage = ai_msg.usage_metadata or {}
        details = usage.get("input_token_details") or {}
        cache_read = details.get("cache_read", 0) or 0
        cache_creation = details.get("cache_creation", 0) or 0
        input_tokens = usage.get("input_tokens", 0) or 0
        # Always log, even on clean MISS (cache_read=0, cache_creation=0) so we
        # can confirm caching is broken vs just cold.
        status = "HIT" if cache_read > 0 else ("WRITE" if cache_creation > 0 else "MISS")
        log_middleware(
            "PromptCache",
            f"{status} read={cache_read} write={cache_creation} input={input_tokens}",
            time.perf_counter(),
            )
    except Exception:  # noqa: BLE001 — telemetry must never break the turn
        pass
