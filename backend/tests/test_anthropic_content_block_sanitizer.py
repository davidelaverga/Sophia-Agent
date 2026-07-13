from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from deerflow.agents.middlewares.anthropic_content_block_sanitizer import (
    AnthropicContentBlockSanitizerMiddleware,
    sanitize_anthropic_content_blocks,
)


class _Request:
    def __init__(self, messages):
        self.messages = messages

    def override(self, **kwargs):
        return _Request(kwargs.get("messages", self.messages))


def test_sanitizer_removes_provider_private_thinking_without_mutating_original():
    original_content = [
        {"type": "thinking", "index": 0, "signature": "sig"},
        {"type": "text", "text": "Visible plan."},
        {"type": "redacted_thinking", "data": "opaque"},
    ]
    ai = AIMessage(
        content=original_content,
        id="ai-1",
        tool_calls=[{"id": "call-1", "name": "read_file", "args": {"path": "spec.md"}}],
        response_metadata={"model": "claude"},
    )

    sanitized, dropped = sanitize_anthropic_content_blocks([HumanMessage(content="go"), ai])

    assert dropped == 2
    assert sanitized is not None
    sanitized_ai = sanitized[1]
    assert sanitized_ai is not ai
    assert sanitized_ai.id == "ai-1"
    assert sanitized_ai.tool_calls == ai.tool_calls
    assert sanitized_ai.response_metadata == ai.response_metadata
    assert sanitized_ai.content == [{"type": "text", "text": "Visible plan."}]
    assert ai.content == original_content


def test_sanitizer_preserves_valid_text_and_tool_content_without_copying():
    ai = AIMessage(
        content=[
            {"type": "text", "text": "Visible."},
            {"type": "tool_use", "id": "toolu-1", "name": "read_file", "input": {"path": "x"}},
        ],
        id="ai-1",
    )

    sanitized, dropped = sanitize_anthropic_content_blocks([ai])

    assert sanitized is None
    assert dropped == 0


def test_sanitizer_preserves_private_only_assistant_when_tool_calls_remain():
    ai = AIMessage(
        content=[{"type": "thinking", "signature": "sig"}],
        tool_calls=[{"id": "call-1", "name": "read_file", "args": {"path": "spec.md"}}],
    )

    sanitized, dropped = sanitize_anthropic_content_blocks([ai])

    assert dropped == 1
    assert sanitized is not None
    assert sanitized[0].content == []
    assert sanitized[0].tool_calls == ai.tool_calls


def test_sync_wrapper_passes_sanitized_messages_to_handler():
    middleware = AnthropicContentBlockSanitizerMiddleware()
    ai = AIMessage(content=[{"type": "thinking", "signature": "sig"}])
    captured = SimpleNamespace(request=None)

    def handler(request):
        captured.request = request
        return AIMessage(content="ok")

    result = middleware.wrap_model_call(_Request([ai]), handler)

    assert result.content == "ok"
    assert captured.request.messages == []
    assert ai.content == [{"type": "thinking", "signature": "sig"}]


@pytest.mark.anyio
async def test_async_wrapper_passes_sanitized_messages_to_handler():
    middleware = AnthropicContentBlockSanitizerMiddleware()
    ai = AIMessage(content=[{"type": "thinking", "signature": "sig"}])
    captured = SimpleNamespace(request=None)

    async def handler(request):
        captured.request = request
        return AIMessage(content="ok")

    result = await middleware.awrap_model_call(_Request([ai]), handler)

    assert result.content == "ok"
    assert captured.request.messages == []
    assert ai.content == [{"type": "thinking", "signature": "sig"}]
