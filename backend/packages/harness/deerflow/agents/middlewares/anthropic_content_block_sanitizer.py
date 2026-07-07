"""Sanitize Anthropic provider-private content blocks before model calls."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse

logger = logging.getLogger(__name__)

_PROVIDER_PRIVATE_BLOCK_TYPES = {"thinking", "redacted_thinking"}


def _is_ai_message(message: Any) -> bool:
    if getattr(message, "type", None) == "ai":
        return True
    if isinstance(message, dict):
        role = str(message.get("role") or message.get("type") or "").lower()
        return role in {"ai", "assistant"}
    return False


def _copy_message_with_content(message: Any, content: list[Any]) -> Any:
    if hasattr(message, "model_copy"):
        return message.model_copy(update={"content": content})
    if isinstance(message, dict):
        copied = dict(message)
        copied["content"] = content
        return copied
    return message


def sanitize_anthropic_content_blocks(messages: list[Any]) -> tuple[list[Any] | None, int]:
    """Drop provider-private Anthropic reasoning blocks from AI message history.

    Anthropic rejects historical assistant content shaped like
    ``{"type": "thinking", "signature": ...}`` when the required ``thinking``
    payload is absent. Sophia does not need provider-private reasoning
    continuity, so the safe boundary behavior is to strip those blocks before
    any model call while preserving user-visible text and tool-call state.
    """
    sanitized_messages: list[Any] | None = None
    dropped_count = 0

    for index, message in enumerate(messages):
        if not _is_ai_message(message):
            continue
        content = message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
        if not isinstance(content, list):
            continue

        sanitized_content: list[Any] = []
        changed = False
        for block in content:
            if isinstance(block, dict) and block.get("type") in _PROVIDER_PRIVATE_BLOCK_TYPES:
                changed = True
                dropped_count += 1
                continue
            sanitized_content.append(block)

        if not changed:
            continue

        if sanitized_messages is None:
            sanitized_messages = list(messages)
        sanitized_messages[index] = _copy_message_with_content(message, sanitized_content)

    return sanitized_messages, dropped_count


class AnthropicContentBlockSanitizerMiddleware(AgentMiddleware[AgentState]):
    """Strip Anthropic reasoning blocks that cannot be replayed as history."""

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        messages, dropped_count = sanitize_anthropic_content_blocks(request.messages)
        if messages is not None:
            logger.info(
                "[AnthropicContentBlockSanitizer] dropped_provider_private_blocks=%s",
                dropped_count,
            )
            request = request.override(messages=messages)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        messages, dropped_count = sanitize_anthropic_content_blocks(request.messages)
        if messages is not None:
            logger.info(
                "[AnthropicContentBlockSanitizer] dropped_provider_private_blocks=%s",
                dropped_count,
            )
            request = request.override(messages=messages)
        return await handler(request)
