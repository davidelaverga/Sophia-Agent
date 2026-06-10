"""Tests for the Sophia companion OpenAI provider fallback (mocked only).

No real API calls are made anywhere in this file. The "OpenAI model" is a
sentinel object; the "Anthropic failure" is either a shape-double exception
with a ``status_code`` attribute or a constructed ``anthropic.BadRequestError``
billing-400. ``OPENAI_API_KEY`` is set to an obvious placeholder via
monkeypatch and the tests assert that placeholder never leaks into logs or
diagnostics.

Locked behavior:

1. Fallback disabled (default) → provider failure re-raises unchanged,
   OpenAI never called.
2. Enabled but key/model missing → OpenAI never called,
   ``fallback_not_configured`` is logged, no secret values logged.
3. Enabled + configured + auth/quota/payment/rate-limit/5xx/billing-400
   primary failure → exactly one OpenAI retry through the SAME handler with
   the SAME tools (only ``model`` overridden), success completes the turn and
   records a sanitized ``companion_provider_fallback`` state snapshot. The
   tool set (incl. ``start_builder_task``) is preserved and the fallback model
   can still emit a ``start_builder_task`` tool call.
4. Product/tool/validation/cancellation errors never trigger fallback.
5. Companion env controls the companion fallback only; the Builder env does
   not enable it (and vice-versa).
6. Diagnostics never contain secrets, raw provider payloads, prompts, signed
   URLs, or artifact content.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest

from deerflow.agents.sophia_agent.middlewares import (
    companion_provider_fallback as mw_module,
)
from deerflow.agents.sophia_agent.middlewares.companion_provider_fallback import (
    CompanionProviderFallbackMiddleware,
)
from deerflow.sophia.builder_provider_fallback import (
    FALLBACK_ENABLED_ENV as BUILDER_FALLBACK_ENABLED_ENV,
)
from deerflow.sophia.builder_provider_fallback import (
    FALLBACK_MODEL_ENV as BUILDER_FALLBACK_MODEL_ENV,
)
from deerflow.sophia.companion_provider_fallback import (
    FALLBACK_ENABLED_ENV,
    FALLBACK_MODEL_ENV,
    classify_provider_error,
    companion_provider_fallback_snapshot,
)

_PLACEHOLDER_KEY = "sk-test-openai-key-placeholder-never-real"


class _ProviderStatusError(Exception):
    """Shape double for provider HTTP errors (anthropic-style status_code)."""

    def __init__(self, status_code: int, message: str = "provider error") -> None:
        super().__init__(message)
        self.status_code = status_code


def _make_anthropic_billing_400() -> Exception:
    """Construct a real ``anthropic.BadRequestError`` credit-balance 400."""
    import anthropic
    import httpx

    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(400, request=request)
    body = {
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": (
                "Your credit balance is too low to access the Anthropic API. "
                "Please go to Plans & Billing to upgrade or purchase credits."
            ),
        },
    }
    return anthropic.BadRequestError(
        "Error code: 400",
        response=response,
        body=body,
    )


class _FakeRequest:
    """Minimal stand-in for langchain's ModelRequest."""

    def __init__(
        self,
        model: object = "primary-model",
        tools: tuple = ("emit_artifact", "start_builder_task", "retrieve_memories"),
    ) -> None:
        self.model = model
        self.tools = tools

    def override(self, **overrides):
        clone = _FakeRequest(model=overrides.get("model", self.model), tools=self.tools)
        return clone


_FALLBACK_MODEL_SENTINEL = object()


def _enable_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
    monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", _PLACEHOLDER_KEY)
    monkeypatch.setattr(mw_module, "build_fallback_chat_model", lambda: _FALLBACK_MODEL_SENTINEL)


def _disable_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(FALLBACK_ENABLED_ENV, raising=False)
    monkeypatch.delenv(FALLBACK_MODEL_ENV, raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


class _Handler:
    """Records calls; raises ``primary_exc`` on the first call, then returns.

    When ``emit_start_builder_task`` is set, the second (fallback) call
    returns a response carrying a ``start_builder_task`` tool call so we can
    assert the delegation contract survives the provider swap.
    """

    def __init__(
        self,
        primary_exc: BaseException | None,
        response: object = "model-response",
        fallback_exc: BaseException | None = None,
        emit_start_builder_task: bool = False,
    ) -> None:
        self.primary_exc = primary_exc
        self.fallback_exc = fallback_exc
        self.response = response
        self.emit_start_builder_task = emit_start_builder_task
        self.calls: list[_FakeRequest] = []

    def __call__(self, request: _FakeRequest):
        self.calls.append(request)
        if len(self.calls) == 1 and self.primary_exc is not None:
            raise self.primary_exc
        if len(self.calls) == 2 and self.fallback_exc is not None:
            raise self.fallback_exc
        if self.emit_start_builder_task and len(self.calls) == 2:
            return SimpleNamespace(
                tool_calls=[{"name": "start_builder_task", "args": {"task_type": "document"}}]
            )
        return self.response


class TestClassificationSharedWithBuilder:
    def test_provider_availability_errors_classified(self) -> None:
        assert classify_provider_error(_ProviderStatusError(401)) == "auth_error"
        assert classify_provider_error(_ProviderStatusError(402)) == "permission_or_payment_error"
        assert classify_provider_error(_ProviderStatusError(403)) == "permission_or_payment_error"
        assert classify_provider_error(_ProviderStatusError(429)) == "rate_limit_or_quota"
        assert classify_provider_error(_ProviderStatusError(500)) == "provider_unavailable"
        assert classify_provider_error(_ProviderStatusError(529)) == "provider_unavailable"

    def test_anthropic_billing_400_is_classified_as_payment(self) -> None:
        # The live failure mode: "credit balance is too low" arrives as a
        # 400 BadRequestError and MUST be fallback-eligible.
        assert classify_provider_error(_make_anthropic_billing_400()) == "permission_or_payment_error"

    def test_generic_400_and_product_errors_not_classified(self) -> None:
        # Generic 400 (no billing signal) = prompt/validation — never eligible.
        assert classify_provider_error(_ProviderStatusError(400)) is None
        assert classify_provider_error(ValueError("start_builder_task rejected")) is None
        assert classify_provider_error(RuntimeError("emit_artifact missing field")) is None
        assert classify_provider_error(asyncio.CancelledError()) is None


class TestFallbackDisabled:
    def test_provider_error_reraises_and_openai_not_called(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _disable_fallback(monkeypatch)
        primary = _ProviderStatusError(401)
        handler = _Handler(primary)
        middleware = CompanionProviderFallbackMiddleware()

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_ProviderStatusError) as excinfo:
                middleware.wrap_model_call(_FakeRequest(), handler)

        assert excinfo.value is primary  # unchanged exception, as today
        assert len(handler.calls) == 1  # no second (OpenAI) call
        assert "fallback_result=fallback_disabled" in caplog.text
        assert "provider_error_class=auth_error" in caplog.text
        assert _PLACEHOLDER_KEY not in caplog.text

    def test_non_provider_error_passes_through_silently(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _disable_fallback(monkeypatch)
        handler = _Handler(ValueError("tool execution bug"))
        with caplog.at_level(logging.WARNING):
            with pytest.raises(ValueError):
                CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        assert len(handler.calls) == 1
        assert "CompanionProviderFallback" not in caplog.text


class TestFallbackEnabledButNotConfigured:
    def test_missing_key_and_model_logs_not_configured(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.delenv(FALLBACK_MODEL_ENV, raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        primary = _ProviderStatusError(429)
        handler = _Handler(primary)

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_ProviderStatusError):
                CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert len(handler.calls) == 1  # OpenAI never called
        assert "fallback_result=fallback_not_configured" in caplog.text

    def test_model_set_but_key_missing_logs_not_configured(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        handler = _Handler(_ProviderStatusError(401))

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_ProviderStatusError):
                CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert len(handler.calls) == 1
        assert "fallback_result=fallback_not_configured" in caplog.text


class TestFallbackEnabledAndConfigured:
    def test_auth_failure_retries_once_via_openai_with_same_tools(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(_ProviderStatusError(401), response="fallback-ok")
        request = _FakeRequest()

        result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        assert len(handler.calls) == 2  # exactly one retry
        retry_request = handler.calls[1]
        assert retry_request.model is _FALLBACK_MODEL_SENTINEL
        # Tool contract preserved verbatim — start_builder_task included.
        assert retry_request.tools == request.tools
        assert "start_builder_task" in retry_request.tools
        # Success wraps the response with a sanitized state snapshot.
        assert result.model_response == "fallback-ok"
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_attempted"] is True
        assert update["companion_fallback_result"] == "success"
        assert update["companion_provider_error_class"] == "auth_error"

    def test_billing_400_triggers_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # End-to-end of the live symptom: Anthropic credit-balance 400 →
        # companion retries via OpenAI and recovers.
        _enable_fallback(monkeypatch)
        handler = _Handler(_make_anthropic_billing_400(), response="recovered")
        result = CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        assert len(handler.calls) == 2
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_result"] == "success"
        assert update["companion_provider_error_class"] == "permission_or_payment_error"

    def test_fallback_model_can_emit_start_builder_task(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(
            _ProviderStatusError(401), emit_start_builder_task=True
        )
        result = CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        # The OpenAI fallback produced a start_builder_task tool call: the
        # delegation path (companion → Builder) is provider-independent.
        model_response = result.model_response
        tool_names = [tc["name"] for tc in model_response.tool_calls]
        assert "start_builder_task" in tool_names
        # The retry carried the start_builder_task tool verbatim.
        assert "start_builder_task" in handler.calls[1].tools

    def test_async_path_retries_once(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        sync_handler = _Handler(_ProviderStatusError(429), response="fallback-ok")

        async def handler(request):
            return sync_handler(request)

        async def run():
            return await CompanionProviderFallbackMiddleware().awrap_model_call(
                _FakeRequest(), handler
            )

        result = asyncio.run(run())
        assert len(sync_handler.calls) == 2
        assert sync_handler.calls[1].model is _FALLBACK_MODEL_SENTINEL
        assert (
            result.command.update["companion_provider_fallback"]["companion_fallback_result"]
            == "success"
        )

    def test_fallback_failure_reraises_chained(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        primary = _ProviderStatusError(500)
        fallback_exc = RuntimeError("fallback also failed")
        handler = _Handler(primary, fallback_exc=fallback_exc)

        with caplog.at_level(logging.WARNING):
            with pytest.raises(RuntimeError) as excinfo:
                CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert excinfo.value is fallback_exc
        assert excinfo.value.__cause__ is primary
        assert "fallback_result=fallback_failed" in caplog.text

    def test_product_errors_still_do_not_trigger_fallback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        for exc in (
            _ProviderStatusError(400, "validation"),
            ValueError("start_builder_task rejected: bad task_type"),
            RuntimeError("emit_artifact missing required field"),
        ):
            handler = _Handler(exc)
            with pytest.raises(type(exc)):
                CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
            assert len(handler.calls) == 1, f"OpenAI must not be called for {exc!r}"

    def test_cancellation_is_never_caught(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(asyncio.CancelledError())
        with pytest.raises(asyncio.CancelledError):
            CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        assert len(handler.calls) == 1

    def test_no_secret_values_in_logs_or_snapshot(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(_ProviderStatusError(401), response="ok")
        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        snapshot = result.command.update["companion_provider_fallback"]
        assert _PLACEHOLDER_KEY not in caplog.text
        assert _PLACEHOLDER_KEY not in repr(snapshot)
        assert "sk-" not in repr(snapshot)
        assert snapshot["provider_secrets_excluded"] is True
        assert snapshot["raw_provider_payload_excluded"] is True
        # Model name is exposed as a boolean only.
        assert snapshot["companion_fallback_model_configured"] is True
        assert "openai-model-placeholder" not in repr(snapshot)


class TestEnvNamespaceSeparation:
    def test_builder_env_does_not_enable_companion_fallback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Builder env set, companion env unset → companion fallback stays off.
        monkeypatch.setenv(BUILDER_FALLBACK_ENABLED_ENV, "true")
        monkeypatch.setenv(BUILDER_FALLBACK_MODEL_ENV, "openai-model-placeholder")
        monkeypatch.setenv("OPENAI_API_KEY", _PLACEHOLDER_KEY)
        monkeypatch.delenv(FALLBACK_ENABLED_ENV, raising=False)
        monkeypatch.delenv(FALLBACK_MODEL_ENV, raising=False)
        handler = _Handler(_ProviderStatusError(401))
        with pytest.raises(_ProviderStatusError):
            CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        assert len(handler.calls) == 1  # companion fallback did not fire


class TestSnapshotShape:
    def test_snapshot_fields_are_allowlisted_and_safe(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
        snapshot = companion_provider_fallback_snapshot(
            error_class="rate_limit_or_quota",
            fallback_attempted=True,
            fallback_result="success",
        )
        assert snapshot["companion_primary_provider"] == "anthropic"
        assert snapshot["companion_fallback_provider"] == "openai"
        assert snapshot["companion_fallback_enabled"] is True
        assert snapshot["companion_fallback_reason"] == "rate_limit_or_quota"
        assert snapshot["companion_provider_error_safe_message"].startswith("Primary model provider")
        assert "Traceback" not in snapshot["companion_provider_error_safe_message"]
        # No model name, no key, no raw payload anywhere.
        assert "openai-model-placeholder" not in repr(snapshot)
        assert "sk-" not in repr(snapshot)


class TestChainWiring:
    def test_companion_chain_includes_provider_fallback_first(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import importlib

        companion_module = importlib.import_module("deerflow.agents.sophia_agent.agent")

        class DummyAgent:
            recursion_limit = 0

        captured: dict = {}

        monkeypatch.setattr(
            companion_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]}
        )
        monkeypatch.setattr(
            companion_module, "_create_summarization_middleware", lambda: None
        )
        monkeypatch.setattr(
            companion_module, "make_retrieve_memories_tool", lambda user_id: {"tool": user_id}
        )
        monkeypatch.setattr(companion_module, "load_sophia_web_tools", lambda: [])

        def _capture(**kwargs):
            captured["middleware"] = kwargs["middleware"]
            return DummyAgent()

        monkeypatch.setattr(companion_module, "create_agent", _capture)
        companion_module.make_sophia_agent({"configurable": {"user_id": "user_x"}})

        names = [type(mw).__name__ for mw in captured["middleware"]]
        assert "CompanionProviderFallbackMiddleware" in names
        # Outermost wrap_model_call: must precede prompt caching + the model call.
        assert names.index("CompanionProviderFallbackMiddleware") < names.index(
            "AnthropicPromptCachingMiddleware"
        )
        # start_builder_task delegation tool stays wired on the companion.
        # (Tool list assertion done indirectly via chain membership; the tool
        # is added unconditionally in make_sophia_agent.)


class TestVisibleReplySurfacing:
    """Locks the live-UI fix: a successful OpenAI fallback must surface a
    visible reply the same way a successful Anthropic call does."""

    def test_fallback_model_does_not_set_streaming(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Regression guard for the root cause. Explicit ``streaming=True`` made
        # the fallback drive its own v1 ``.stream()`` path, whose tokens
        # LangGraph 0.8's StreamMessagesHandlerV2 drops (``on_llm_new_token``
        # is an intentional no-op) — so successful fallbacks persisted to state
        # but never reached the live ``messages``-tuple stream the UI renders.
        # The fallback must match the companion primary ChatAnthropic, which
        # omits the flag (LangGraph then streams it via the v2 event path).
        from deerflow.sophia.companion_provider_fallback import (
            build_fallback_chat_model,
        )

        monkeypatch.setenv(FALLBACK_MODEL_ENV, "gpt-4o-mini")
        monkeypatch.setenv("OPENAI_API_KEY", _PLACEHOLDER_KEY)
        model = build_fallback_chat_model()
        assert getattr(model, "streaming", False) is False

    def test_text_response_surfaces_and_is_not_flagged_empty(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from langchain_core.messages import AIMessage

        _enable_fallback(monkeypatch)
        reply = AIMessage(content="Hey, I'm right here with you.")
        response = SimpleNamespace(result=[reply])
        handler = _Handler(_ProviderStatusError(401), response=response)
        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(
                _FakeRequest(), handler
            )
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_result"] == "success"
        # The visible AIMessage is preserved verbatim for the stream.
        assert result.model_response is response
        assert "fallback_result=success" in caplog.text
        assert "companionFallbackEmptyResponse" not in caplog.text

    def test_tool_only_response_is_not_flagged_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from langchain_core.messages import AIMessage

        _enable_fallback(monkeypatch)
        tool_msg = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "start_builder_task",
                    "args": {"task_type": "document"},
                    "id": "tc-1",
                }
            ],
        )
        response = SimpleNamespace(result=[tool_msg])
        handler = _Handler(_ProviderStatusError(401), response=response)
        result = CompanionProviderFallbackMiddleware().wrap_model_call(
            _FakeRequest(), handler
        )
        update = result.command.update["companion_provider_fallback"]
        # A tool-only turn (start_builder_task) is a real, actionable reply.
        assert update["companion_fallback_result"] == "success"

    def test_empty_response_logs_diagnostic_without_crashing(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from langchain_core.messages import AIMessage

        _enable_fallback(monkeypatch)
        empty = AIMessage(content="")
        response = SimpleNamespace(result=[empty])
        handler = _Handler(_ProviderStatusError(429), response=response)
        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(
                _FakeRequest(), handler
            )
        # No crash, no fake failure: the (empty) response is still returned.
        assert result.model_response is response
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_result"] == "empty_response"
        # Exact safe-diagnostic tokens, and no raw payload / secret leakage.
        assert "companionFallbackEmptyResponse=true" in caplog.text
        assert "companionFallbackResult=empty_response" in caplog.text
        assert "rawProviderPayloadExcluded=true" in caplog.text
        assert _PLACEHOLDER_KEY not in caplog.text


class TestPromptCachingNoOpForFallback:
    """The Anthropic prompt-caching middleware must silently no-op for the
    OpenAI fallback model instead of flooding logs with a warning."""

    def test_chain_wires_caching_with_ignore_behavior(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import importlib

        companion_module = importlib.import_module(
            "deerflow.agents.sophia_agent.agent"
        )

        class DummyAgent:
            recursion_limit = 0

        captured: dict = {}
        monkeypatch.setattr(
            companion_module,
            "ChatAnthropic",
            lambda **kwargs: {"model": kwargs["model"]},
        )
        monkeypatch.setattr(
            companion_module, "_create_summarization_middleware", lambda: None
        )
        monkeypatch.setattr(
            companion_module,
            "make_retrieve_memories_tool",
            lambda user_id: {"tool": user_id},
        )
        monkeypatch.setattr(companion_module, "load_sophia_web_tools", lambda: [])

        def _capture(**kwargs):
            captured["middleware"] = kwargs["middleware"]
            return DummyAgent()

        monkeypatch.setattr(companion_module, "create_agent", _capture)
        companion_module.make_sophia_agent({"configurable": {"user_id": "user_y"}})

        caching = [
            mw
            for mw in captured["middleware"]
            if type(mw).__name__ == "AnthropicPromptCachingMiddleware"
        ]
        assert caching, "prompt caching middleware must stay wired"
        assert caching[0].unsupported_model_behavior == "ignore"

    def test_caching_is_silent_noop_on_non_anthropic_model(self) -> None:
        import warnings

        from langchain_anthropic.middleware.prompt_caching import (
            AnthropicPromptCachingMiddleware,
        )

        request = SimpleNamespace(model=object(), messages=[], system_message=None)
        sentinel = object()

        # "ignore" → no warning, response passes through untouched.
        ignore_mw = AnthropicPromptCachingMiddleware(
            ttl="5m", unsupported_model_behavior="ignore"
        )
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            out = ignore_mw.wrap_model_call(request, lambda req: sentinel)
        assert out is sentinel
        assert not any("Anthropic" in str(w.message) for w in caught)

        # Sanity check the default still warns — proving "ignore" suppressed it.
        warn_mw = AnthropicPromptCachingMiddleware(ttl="5m")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            warn_mw.wrap_model_call(request, lambda req: sentinel)
        assert any("Anthropic" in str(w.message) for w in caught)
