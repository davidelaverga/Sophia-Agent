"""Tests for provider-aware Builder forced-``tool_choice`` normalization.

Root cause this guards against: the Builder authors forced tool choices in
Anthropic's native shape ``{"type": "tool", "name": <tool>}``. When the
provider fallback swaps the bound model to ``ChatOpenAI`` mid-run, the inner
``BuilderArtifactMiddleware`` re-applies that Anthropic shape onto the now
OpenAI request and OpenAI rejects it with
``Missing required parameter: 'tool_choice.function'``.

No real API calls are made. Provider classes are lightweight fakes whose
class name / MRO matches the production detection. Secrets are never present
here; tests assert no raw provider payload leaks into the safe diagnostic.
"""

from __future__ import annotations

import logging

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from deerflow.agents.sophia_agent.middlewares import builder_provider_fallback as mw_module
from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
)
from deerflow.agents.sophia_agent.middlewares.builder_provider_fallback import (
    BuilderProviderFallbackMiddleware,
)
from deerflow.sophia.builder_provider_fallback import (
    FALLBACK_ENABLED_ENV,
    FALLBACK_MODEL_ENV,
    is_openai_chat_model,
    model_provider_label,
    normalize_tool_choice_for_model,
    provider_fallback_failure_diagnostic,
)

_PLACEHOLDER_KEY = "test-openai-key-placeholder-never-real"


# --- Provider class doubles -------------------------------------------------


class ChatOpenAI:  # noqa: D401 - name is the detection signal
    """Class-name double matching the production OpenAI detection."""


class _SubclassOpenAI(ChatOpenAI):
    """Subclass should still be detected as OpenAI via MRO."""


class ChatAnthropic:  # noqa: D401 - non-OpenAI provider
    """Anthropic-shaped model double (keeps native tool_choice)."""


_ANTHROPIC_TOOL_CHOICE = {"type": "tool", "name": "builder_web_search"}


# --- is_openai_chat_model ---------------------------------------------------


class TestProviderDetection:
    def test_openai_class_detected(self) -> None:
        assert is_openai_chat_model(ChatOpenAI()) is True

    def test_openai_subclass_detected(self) -> None:
        assert is_openai_chat_model(_SubclassOpenAI()) is True

    def test_anthropic_not_detected(self) -> None:
        assert is_openai_chat_model(ChatAnthropic()) is False

    def test_string_model_not_detected(self) -> None:
        assert is_openai_chat_model("primary-model") is False

    def test_provider_label(self) -> None:
        assert model_provider_label(ChatOpenAI()) == "openai"
        assert model_provider_label(ChatAnthropic()) == "anthropic"


# --- normalize_tool_choice_for_model ----------------------------------------


class TestToolChoiceNormalization:
    def test_anthropic_shape_preserved_for_anthropic_model(self) -> None:
        result = normalize_tool_choice_for_model(ChatAnthropic(), _ANTHROPIC_TOOL_CHOICE)
        assert result == {"type": "tool", "name": "builder_web_search"}
        # Identity preserved so callers can detect "no change".
        assert result is _ANTHROPIC_TOOL_CHOICE

    def test_translated_to_openai_function_shape(self) -> None:
        result = normalize_tool_choice_for_model(ChatOpenAI(), _ANTHROPIC_TOOL_CHOICE)
        assert result == {
            "type": "function",
            "function": {"name": "builder_web_search"},
        }
        # The forced tool is unchanged — only the envelope differs.
        assert result["function"]["name"] == "builder_web_search"

    def test_no_tool_choice_function_missing_param(self) -> None:
        # Regression guard for OpenAI's "Missing required parameter:
        # 'tool_choice.function'": the translated payload always carries a
        # populated ``function.name``.
        result = normalize_tool_choice_for_model(ChatOpenAI(), {"type": "tool", "name": "write_file"})
        assert result["type"] == "function"
        assert result["function"]["name"] == "write_file"

    def test_each_forced_builder_tool_translates(self) -> None:
        for tool in ("builder_web_search", "builder_web_fetch", "write_file", "emit_builder_artifact"):
            result = normalize_tool_choice_for_model(ChatOpenAI(), {"type": "tool", "name": tool})
            assert result == {"type": "function", "function": {"name": tool}}

    def test_string_sentinels_unchanged_on_openai(self) -> None:
        for sentinel in ("auto", "none", "required", "any"):
            assert normalize_tool_choice_for_model(ChatOpenAI(), sentinel) == sentinel

    def test_openai_shape_passthrough(self) -> None:
        already = {"type": "function", "function": {"name": "builder_web_search"}}
        assert normalize_tool_choice_for_model(ChatOpenAI(), already) == already

    def test_unknown_dict_unchanged(self) -> None:
        weird = {"type": "tool"}  # missing name
        assert normalize_tool_choice_for_model(ChatOpenAI(), weird) is weird


# --- BuilderArtifactMiddleware._provider_normalized_tool_choice -------------


class TestMiddlewareNormalizationHook:
    def test_anthropic_no_normalization_logged(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.INFO):
            result = BuilderArtifactMiddleware._provider_normalized_tool_choice(
                ChatAnthropic(), _ANTHROPIC_TOOL_CHOICE
            )
        assert result == _ANTHROPIC_TOOL_CHOICE
        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "builderToolChoiceNormalized=false" in joined
        assert "builderToolChoiceProvider=anthropic" in joined
        assert "builderToolChoiceName=builder_web_search" in joined
        assert "rawProviderPayloadExcluded=true" in joined
        assert "providerSecretsExcluded=true" in joined

    def test_openai_normalization_logged(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.INFO):
            result = BuilderArtifactMiddleware._provider_normalized_tool_choice(
                ChatOpenAI(), _ANTHROPIC_TOOL_CHOICE
            )
        assert result == {"type": "function", "function": {"name": "builder_web_search"}}
        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "builderToolChoiceNormalized=true" in joined
        assert "builderToolChoiceProvider=openai" in joined
        assert "builderToolChoiceName=builder_web_search" in joined


# --- Provider fallback failure diagnostic -----------------------------------


class _FakeBadRequest(Exception):
    def __init__(self, *, param: str | None = None, body: dict | None = None) -> None:
        super().__init__("bad request")
        if param is not None:
            self.param = param
        self.body = body


class TestFallbackFailureDiagnostic:
    def test_tool_choice_function_error_classified(self) -> None:
        diag = provider_fallback_failure_diagnostic(
            _FakeBadRequest(param="tool_choice.function")
        )
        assert diag["builder_failure_code"] == "builder_openai_tool_choice_invalid"
        assert diag["builder_provider_error_class"] == "bad_request_tool_choice"
        assert diag["builder_failure_stage"] == "provider_fallback"
        assert diag["builder_fallback_attempted"] == "true"
        assert diag["builder_fallback_result"] == "fallback_failed"
        assert diag["raw_provider_payload_excluded"] == "true"
        assert diag["provider_secrets_excluded"] == "true"

    def test_tool_choice_function_error_via_body(self) -> None:
        diag = provider_fallback_failure_diagnostic(
            _FakeBadRequest(body={"error": {"param": "tool_choice.function"}})
        )
        assert diag["builder_failure_code"] == "builder_openai_tool_choice_invalid"

    def test_generic_failure_classified(self) -> None:
        diag = provider_fallback_failure_diagnostic(RuntimeError("boom"))
        assert diag["builder_failure_code"] == "builder_provider_fallback_failed"
        assert diag["builder_provider_error_class"] == "provider_fallback_failed"

    def test_diagnostic_values_are_fixed_allowlist(self) -> None:
        # No raw exception text / payload ever appears in the diagnostic.
        diag = provider_fallback_failure_diagnostic(
            _FakeBadRequest(param="tool_choice.function", body={"error": {"message": "SECRET-LEAK"}})
        )
        assert "SECRET-LEAK" not in " ".join(diag.values())


# --- Middleware failure-path logging carries the safe diagnostic ------------


class _FakeRequest:
    def __init__(self, model: object = "primary-model") -> None:
        self.model = model

    def override(self, **overrides):
        return _FakeRequest(model=overrides.get("model", self.model))


class _CacheyFakeRequest:
    def __init__(
        self,
        *,
        model: object = "primary-model",
        messages: list | None = None,
        system_message: object | None = None,
        tools: list | None = None,
        model_settings: dict | None = None,
    ) -> None:
        self.model = model
        self.messages = messages or []
        self.system_message = system_message
        self.tools = tools or []
        self.model_settings = model_settings or {}

    def override(self, **overrides):
        return _CacheyFakeRequest(
            model=overrides.get("model", self.model),
            messages=overrides.get("messages", self.messages),
            system_message=overrides.get("system_message", self.system_message),
            tools=overrides.get("tools", self.tools),
            model_settings=overrides.get("model_settings", self.model_settings),
        )


class _StatusError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__("provider error")
        self.status_code = status_code


class _Handler:
    def __init__(self, primary_exc: BaseException, fallback_exc: BaseException) -> None:
        self.primary_exc = primary_exc
        self.fallback_exc = fallback_exc
        self.calls = 0

    def __call__(self, request: _FakeRequest):
        self.calls += 1
        if self.calls == 1:
            raise self.primary_exc
        raise self.fallback_exc


def _contains_cache_control(value) -> bool:
    if isinstance(value, dict):
        return any(key == "cache_control" or _contains_cache_control(item) for key, item in value.items())
    if isinstance(value, list | tuple):
        return any(_contains_cache_control(item) for item in value)
    if hasattr(value, "content") and _contains_cache_control(value.content):
        return True
    if hasattr(value, "additional_kwargs") and _contains_cache_control(value.additional_kwargs):
        return True
    if hasattr(value, "response_metadata") and _contains_cache_control(value.response_metadata):
        return True
    return False


def _enable_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
    monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", _PLACEHOLDER_KEY)
    monkeypatch.setattr(mw_module, "build_fallback_chat_model", lambda: ChatOpenAI())


class TestFallbackFailureLogging:
    def test_tool_choice_badrequest_surfaces_safe_diagnostic(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        primary = _StatusError(401)  # auth_error → fallback-eligible
        fallback_exc = _FakeBadRequest(param="tool_choice.function")
        handler = _Handler(primary, fallback_exc)
        middleware = BuilderProviderFallbackMiddleware()

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_FakeBadRequest):
                middleware.wrap_model_call(_FakeRequest(), handler)

        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "builderFailureDiagnosticAvailable=true" in joined
        assert "builderFailureStage=provider_fallback" in joined
        assert "builderFailureCode=builder_openai_tool_choice_invalid" in joined
        assert "builderProviderErrorClass=bad_request_tool_choice" in joined
        assert "rawProviderPayloadExcluded=true" in joined
        # The placeholder key must never leak into any log line.
        assert _PLACEHOLDER_KEY not in joined

    def test_generic_fallback_failure_diagnostic(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(_StatusError(429), RuntimeError("boom"))
        middleware = BuilderProviderFallbackMiddleware()

        with caplog.at_level(logging.WARNING):
            with pytest.raises(RuntimeError):
                middleware.wrap_model_call(_FakeRequest(), handler)

        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "builderFailureCode=builder_provider_fallback_failed" in joined
        assert "builderFailureDiagnosticAvailable=true" in joined


class TestFallbackStripsAnthropicCacheMetadata:
    def test_openai_retry_removes_cache_control_from_request(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        captured_fallback_request = None

        request = _CacheyFakeRequest(
            messages=[
                HumanMessage(
                    content=[
                        {
                            "type": "text",
                            "text": "cached user text",
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                    additional_kwargs={"cache_control": {"type": "ephemeral"}},
                )
            ],
            system_message=SystemMessage(
                content=[
                    {
                        "type": "text",
                        "text": "cached system text",
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                response_metadata={"cache_control": {"type": "ephemeral"}},
            ),
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "write_file",
                        "parameters": {
                            "type": "object",
                            "cache_control": {"type": "ephemeral"},
                        },
                    },
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            model_settings={"extra_body": {"cache_control": {"type": "ephemeral"}}},
        )

        def handler(next_request):
            nonlocal captured_fallback_request
            if captured_fallback_request is None:
                captured_fallback_request = next_request
                raise _StatusError(401)
            captured_fallback_request = next_request
            return "fallback-ok"

        result = BuilderProviderFallbackMiddleware().wrap_model_call(request, handler)

        assert result.model_response == "fallback-ok"
        assert isinstance(captured_fallback_request.model, ChatOpenAI)
        assert not _contains_cache_control(captured_fallback_request.messages)
        assert not _contains_cache_control(captured_fallback_request.system_message)
        assert not _contains_cache_control(captured_fallback_request.tools)
        assert not _contains_cache_control(captured_fallback_request.model_settings)
