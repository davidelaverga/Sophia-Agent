from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from deerflow.agents.middlewares.llm_error_handling_middleware import LLMErrorHandlingMiddleware


class ProviderError(RuntimeError):
    pass


def _request():
    request = MagicMock()
    request.messages = []
    return request


def test_quota_error_returns_controlled_fallback_message() -> None:
    middleware = LLMErrorHandlingMiddleware(retry_max_attempts=1)

    def handler(_request):
        raise ProviderError("Your credit balance is too low to access the API")

    result = middleware.wrap_model_call(_request(), handler)

    assert isinstance(result, AIMessage)
    assert result.additional_kwargs["deerflow_error_fallback"] is True
    assert result.additional_kwargs["error_reason"] == "quota"
    assert "out of quota" in result.content


@pytest.mark.anyio
async def test_async_transient_error_retries_then_succeeds() -> None:
    middleware = LLMErrorHandlingMiddleware(retry_max_attempts=2, retry_base_delay_ms=0)
    calls = 0

    async def handler(_request):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ProviderError("server busy")
        return AIMessage(content="ok")

    result = await middleware.awrap_model_call(_request(), handler)

    assert isinstance(result, AIMessage)
    assert result.content == "ok"
    assert calls == 2

