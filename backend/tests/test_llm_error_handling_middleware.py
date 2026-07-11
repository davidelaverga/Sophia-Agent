from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from deerflow.agents.middlewares.llm_error_handling_middleware import LLMErrorHandlingMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware


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


@pytest.mark.anyio
async def test_presentation_model_error_does_not_retry() -> None:
    middleware = LLMErrorHandlingMiddleware(retry_max_attempts=2, retry_base_delay_ms=0)
    request = _request()
    request.state = {"builder_budget": {"tier": "presentation"}}
    calls = 0

    async def handler(_request):
        nonlocal calls
        calls += 1
        raise ProviderError("server busy")

    result = await middleware.awrap_model_call(request, handler)

    assert result.additional_kwargs["deerflow_error_fallback"] is True
    assert calls == 1


def test_malformed_anthropic_message_history_is_classified_separately() -> None:
    middleware = LLMErrorHandlingMiddleware(retry_max_attempts=1)

    def handler(_request):
        raise ProviderError("messages.7.content.0.thinking.thinking: Field required")

    result = middleware.wrap_model_call(_request(), handler)

    assert isinstance(result, AIMessage)
    assert result.additional_kwargs["deerflow_error_fallback"] is True
    assert result.additional_kwargs["error_reason"] == "malformed_request"
    assert "malformed" in result.content


def test_builder_artifact_diagnostics_preserve_malformed_request_reason() -> None:
    msg = AIMessage(
        content="failed",
        additional_kwargs={
            "deerflow_error_fallback": True,
            "error_reason": "malformed_request",
            "error_detail": "messages.7.content.0.thinking.thinking: Field required",
        },
    )

    diagnostic = BuilderArtifactMiddleware._model_provider_failure_from_message(msg)

    assert diagnostic == {
        "failure_stage": "model_provider",
        "failure_code": "primary_provider_malformed_request",
        "failure_reason": ("Internal model request payload was malformed before the builder produced an artifact."),
        "provider_error_reason": "malformed_request",
        "retryable": False,
    }
