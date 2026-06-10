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


@pytest.fixture(autouse=True)
def _reset_primary_cooldown():
    """The primary-provider cooldown is module-level state — isolate tests."""
    mw_module.reset_companion_primary_cooldown_for_tests()
    yield
    mw_module.reset_companion_primary_cooldown_for_tests()


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


class TestErrorHandlingOrdering:
    """Locks the first-chance contract: the provider fallback wraps INSIDE
    LLMErrorHandlingMiddleware, so fallback-eligible provider errors reach
    the fallback before being converted into a generic user-facing reply.
    (Post-stream regression: LLMErrorHandling innermost swallowed Anthropic
    billing-400s as reason=quota and the OpenAI fallback never ran.)"""

    @staticmethod
    def _composed_call(request, model_call):
        """LLMErrorHandling (outer) wrapping CompanionProviderFallback (inner),
        matching the production companion chain ordering."""
        from deerflow.agents.middlewares.llm_error_handling_middleware import (
            LLMErrorHandlingMiddleware,
        )

        error_mw = LLMErrorHandlingMiddleware(retry_max_attempts=1)
        fallback_mw = CompanionProviderFallbackMiddleware()

        def inner_handler(req):
            return fallback_mw.wrap_model_call(req, model_call)

        return error_mw.wrap_model_call(request, inner_handler)

    def test_quota_error_reaches_fallback_before_generic_reply(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from langchain_core.messages import AIMessage

        _enable_fallback(monkeypatch)
        reply = AIMessage(content="Hey Luis. I'm here — what's on your mind?")
        model_call = _Handler(_make_anthropic_billing_400(), response=SimpleNamespace(result=[reply]))

        with caplog.at_level(logging.WARNING):
            result = self._composed_call(_FakeRequest(), model_call)

        # The fallback retried via OpenAI and produced the visible reply —
        # the generic quota message never fired.
        assert len(model_call.calls) == 2
        assert model_call.calls[1].model is _FALLBACK_MODEL_SENTINEL
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_result"] == "success"
        assert result.model_response.result[-1] is reply
        assert "retrying once via OpenAI" in caplog.text
        assert "configured model provider rejected" not in caplog.text

    def test_quota_error_with_fallback_disabled_still_gets_generic_reply(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from langchain_core.messages import AIMessage

        _disable_fallback(monkeypatch)
        model_call = _Handler(_make_anthropic_billing_400())

        with caplog.at_level(logging.WARNING):
            result = self._composed_call(_FakeRequest(), model_call)

        # Fallback re-raised (disabled) → LLMErrorHandling converted the
        # error into its safe user-facing quota message. OpenAI never called.
        assert len(model_call.calls) == 1
        assert isinstance(result, AIMessage)
        assert "out of quota" in result.content
        assert result.additional_kwargs.get("deerflow_error_fallback") is True
        assert "fallback_result=fallback_disabled" in caplog.text
        assert _PLACEHOLDER_KEY not in caplog.text

    def test_product_errors_skip_fallback_and_get_generic_handling(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from langchain_core.messages import AIMessage

        _enable_fallback(monkeypatch)
        model_call = _Handler(ValueError("emit_artifact missing required field"))

        result = self._composed_call(_FakeRequest(), model_call)

        # Not fallback-eligible → no OpenAI retry; LLMErrorHandling still
        # produces its generic message exactly as before.
        assert len(model_call.calls) == 1
        assert isinstance(result, AIMessage)
        assert result.additional_kwargs.get("deerflow_error_fallback") is True


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


class _ProseFakeRequest:
    """Fake request rich enough for the conversational prose retry: carries
    messages, tools, tool_choice, and a system prompt, and records the
    overrides each ``override`` call applied."""

    def __init__(
        self,
        messages=None,
        model: object = "primary-model",
        tools=("emit_artifact", "start_builder_task", "retrieve_memories"),
        tool_choice=None,
        system_prompt: str | None = "You are Sophia.",
        state: dict | None = None,
    ) -> None:
        self.messages = list(messages or [])
        self.model = model
        self.tools = list(tools)
        self.tool_choice = tool_choice
        self.system_prompt = system_prompt
        self.state = dict(state or {})
        self.overrides_applied: dict = {}

    def override(self, **overrides):
        clone = _ProseFakeRequest(
            messages=self.messages,
            model=overrides.get("model", self.model),
            tools=overrides.get("tools", self.tools),
            tool_choice=overrides.get("tool_choice", self.tool_choice),
            system_prompt=self.system_prompt,
            state=overrides.get("state", self.state),
        )
        system_message = overrides.get("system_message")
        if system_message is not None:
            clone.system_prompt = system_message.content
        clone.overrides_applied = dict(overrides)
        return clone


class _SequenceHandler:
    """Returns (or raises) one scripted outcome per call, in order."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls: list = []

    def __call__(self, request):
        self.calls.append(request)
        outcome = self.outcomes[len(self.calls) - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _artifact_only_response():
    from langchain_core.messages import AIMessage

    return SimpleNamespace(
        result=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "emit_artifact",
                        "args": {"tone_estimate": 2.5},
                        "id": "tc-artifact-1",
                    }
                ],
            )
        ]
    )


def _prose_response(text: str):
    from langchain_core.messages import AIMessage

    return SimpleNamespace(result=[AIMessage(content=text)])


def _conversational_request(state: dict | None = None) -> _ProseFakeRequest:
    from langchain_core.messages import HumanMessage

    return _ProseFakeRequest(messages=[HumanMessage(content="Hey Sophia!")], state=state)


def _heavy_turn_request() -> _ProseFakeRequest:
    """A build-intent turn that is NOT a direct document command: it keeps
    the full tool set (heavy path) but stays eligible for the prose retry."""
    from langchain_core.messages import HumanMessage

    return _ProseFakeRequest(
        messages=[HumanMessage(content="Can you build me an HTML dashboard for my stats?")]
    )


class TestConversationalProseRetry:
    """Locks the conversational-turn fix: OpenAI fallback answering a plain
    greeting with an emit_artifact-only message must be retried once without
    tools so the final message carries visible prose + the artifact call."""

    def test_tool_only_heavy_turn_retries_and_merges_prose(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        response = _artifact_only_response()
        handler = _SequenceHandler(
            _make_anthropic_billing_400(),
            response,
            _prose_response("Hey Luis! Good to see you."),
        )
        request = _heavy_turn_request()

        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        # Exactly one prose retry on top of the provider fallback retry.
        assert len(handler.calls) == 3
        prose_request = handler.calls[2]
        # Tools disabled and prose instruction appended for the retry only.
        assert prose_request.tools == []
        assert prose_request.tool_choice is None
        assert "Do not call any tools" in prose_request.system_prompt
        assert "You are Sophia." in prose_request.system_prompt
        # Final message: visible prose + the ORIGINAL emit_artifact tool call
        # (Anthropic's shape) — the artifact-per-turn contract is preserved.
        final_message = result.model_response.result[-1]
        assert final_message.content == "Hey Luis! Good to see you."
        assert [tc["id"] for tc in final_message.tool_calls] == ["tc-artifact-1"]
        assert [tc["name"] for tc in final_message.tool_calls] == ["emit_artifact"]
        # Snapshot telemetry.
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_result"] == "success"
        assert update["companion_fallback_conversational_turn"] is True
        assert update["companion_fallback_prose_retry_attempted"] is True
        assert update["companion_fallback_prose_retry_result"] == "success"
        assert update["companion_fallback_tool_only_suppressed"] is True
        # Log tokens (safe fields only).
        assert "companionFallbackConversationalTurn=true" in caplog.text
        assert "companionFallbackProseRetryAttempted=true" in caplog.text
        assert "companionFallbackProseRetryResult=success" in caplog.text
        assert "rawProviderPayloadExcluded=true" in caplog.text

    def test_async_tool_only_heavy_turn_retries_and_merges_prose(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        response = _artifact_only_response()
        sync_handler = _SequenceHandler(
            _ProviderStatusError(429),
            response,
            _prose_response("Right here with you."),
        )

        async def handler(request):
            return sync_handler(request)

        async def run():
            return await CompanionProviderFallbackMiddleware().awrap_model_call(
                _heavy_turn_request(), handler
            )

        result = asyncio.run(run())
        assert len(sync_handler.calls) == 3
        final_message = result.model_response.result[-1]
        assert final_message.content == "Right here with you."
        assert [tc["name"] for tc in final_message.tool_calls] == ["emit_artifact"]
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_prose_retry_result"] == "success"

    def test_start_builder_task_response_is_never_prose_retried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from langchain_core.messages import AIMessage, HumanMessage

        _enable_fallback(monkeypatch)
        builder_message = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "start_builder_task",
                    "args": {"description": "Build an HTML page", "task_type": "frontend"},
                    "id": "tc-builder-1",
                }
            ],
        )
        response = SimpleNamespace(result=[builder_message])
        handler = _SequenceHandler(_ProviderStatusError(401), response)
        request = _ProseFakeRequest(
            messages=[HumanMessage(content="Can you build me an HTML page about orcas?")]
        )

        result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        # No third call: the delegation tool call is a real action.
        assert len(handler.calls) == 2
        assert result.model_response.result[-1] is builder_message
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_prose_retry_attempted"] is False
        assert update["companion_fallback_prose_retry_result"] == "not_needed"
        assert update["companion_fallback_tool_only_suppressed"] is False

    def test_prose_retry_failure_keeps_original_without_fake_text(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        response = _artifact_only_response()
        handler = _SequenceHandler(
            _ProviderStatusError(401),
            response,
            RuntimeError("prose retry transport error"),
        )

        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(
                _heavy_turn_request(), handler
            )

        # Original tool-only response returned unchanged — no synthesized text.
        final_message = result.model_response.result[-1]
        assert final_message.content == ""
        assert [tc["name"] for tc in final_message.tool_calls] == ["emit_artifact"]
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_prose_retry_attempted"] is True
        assert update["companion_fallback_prose_retry_result"] == "failed"
        assert update["companion_fallback_tool_only_suppressed"] is False
        assert "companionFallbackProseRetryResult=failed" in caplog.text

    def test_prose_retry_empty_text_keeps_original_without_fake_text(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        response = _artifact_only_response()
        handler = _SequenceHandler(
            _ProviderStatusError(401),
            response,
            _prose_response(""),
        )

        result = CompanionProviderFallbackMiddleware().wrap_model_call(
            _heavy_turn_request(), handler
        )

        final_message = result.model_response.result[-1]
        assert final_message.content == ""
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_prose_retry_result"] == "failed"

    def test_direct_document_command_turn_is_not_prose_retried(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from langchain_core.messages import HumanMessage

        _enable_fallback(monkeypatch)
        response = _artifact_only_response()
        handler = _SequenceHandler(_ProviderStatusError(401), response)
        request = _ProseFakeRequest(
            messages=[
                HumanMessage(
                    content="Sophia create a dummy document of one page about whales."
                )
            ]
        )

        result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        # Defensive: explicit document commands are BuilderCommand territory —
        # never converted into a tool-free prose turn.
        assert len(handler.calls) == 2
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_conversational_turn"] is False
        assert update["companion_fallback_prose_retry_attempted"] is False

    def test_prose_retry_logs_contain_no_secrets_prompts_or_user_text(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _SequenceHandler(
            _ProviderStatusError(401),
            _artifact_only_response(),
            _prose_response("Hey! I'm here."),
        )

        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(
                _heavy_turn_request(), handler
            )

        assert _PLACEHOLDER_KEY not in caplog.text
        assert "HTML dashboard" not in caplog.text       # user text never logged
        assert "You are Sophia." not in caplog.text      # system prompt never logged
        assert "Hey! I'm here." not in caplog.text       # model output never logged
        snapshot = result.command.update["companion_provider_fallback"]
        assert _PLACEHOLDER_KEY not in repr(snapshot)
        assert "HTML dashboard" not in repr(snapshot)
        assert snapshot["raw_provider_payload_excluded"] is True
        assert snapshot["provider_secrets_excluded"] is True


_SOUL_BLOCK = "You are Sophia, an emotionally present companion. Stay warm and human."
_TONE_BLOCK = "<tone_guidance>engagement band: meet their energy, lift half a point.</tone_guidance>"
_ARTIFACT_BLOCK = "<artifact_instructions>Every turn you MUST call emit_artifact with 13 fields.</artifact_instructions>"
_DELEGATION_BLOCK = "Use start_builder_task(description, task_type) to delegate builds."
_BUILD_STATUS_BLOCK = "<build_status>\nNo active builds.\n</build_status>"

_LIGHT_STATE = {
    "system_prompt_blocks": [
        _SOUL_BLOCK,
        _TONE_BLOCK,
        _ARTIFACT_BLOCK,
        _DELEGATION_BLOCK,
        _BUILD_STATUS_BLOCK,
    ],
}


class TestConversationalLightPath:
    """Plain conversational turns take a single tool-free fallback call with
    Builder/artifact guidance stripped — Sophia answers as a companion."""

    def test_hey_sophia_uses_light_tool_free_path(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _SequenceHandler(
            _make_anthropic_billing_400(),
            _prose_response("Hey Luis. I'm here — what's on your mind?"),
        )
        request = _conversational_request(state=dict(_LIGHT_STATE))

        with caplog.at_level(logging.WARNING):
            result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        # One failed primary + ONE light fallback call — no extra prose retry.
        assert len(handler.calls) == 2
        light_request = handler.calls[1]
        assert light_request.model is _FALLBACK_MODEL_SENTINEL
        assert light_request.tools == []
        assert light_request.tool_choice is None
        # Builder/artifact guidance blocks dropped; companion context kept.
        light_blocks = light_request.state["system_prompt_blocks"]
        assert _SOUL_BLOCK in light_blocks
        assert _TONE_BLOCK in light_blocks
        assert _ARTIFACT_BLOCK not in light_blocks
        assert _DELEGATION_BLOCK not in light_blocks
        assert _BUILD_STATUS_BLOCK not in light_blocks
        assert any("<conversational_turn>" in block for block in light_blocks)
        # The reply is plain visible prose.
        final_message = result.model_response.result[-1]
        assert final_message.content == "Hey Luis. I'm here — what's on your mind?"
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_result"] == "success"
        assert update["companion_conversational_light_path"] is True
        assert update["companion_conversational_tools_disabled"] is True
        assert update["companion_fallback_conversational_turn"] is True
        # Safe log tokens.
        assert "companionConversationalLightPath=true" in caplog.text
        assert "companionConversationalToolsDisabled=true" in caplog.text
        assert "companionVisibleTextRequired=true" in caplog.text
        assert "rawProviderPayloadExcluded=true" in caplog.text
        assert "Hey Sophia!" not in caplog.text

    def test_light_instruction_bans_internal_mechanics_language(self) -> None:
        # The light-path instruction explicitly forbids the leakage observed
        # in production (identity files / handoffs / Mem0 / metadata talk).
        instruction = mw_module._CONVERSATIONAL_LIGHT_INSTRUCTION
        for banned in ("identity files", "handoffs", "memory systems", "Mem0", "metadata", "artifacts"):
            assert banned in instruction
        assert "Do not call any tools" in instruction

    def test_build_request_keeps_full_toolset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from langchain_core.messages import AIMessage

        _enable_fallback(monkeypatch)
        builder_response = SimpleNamespace(result=[AIMessage(
            content="",
            tool_calls=[{"name": "start_builder_task", "args": {"task_type": "frontend"}, "id": "tc-b1"}],
        )])
        handler = _SequenceHandler(_ProviderStatusError(401), builder_response)
        request = _heavy_turn_request()
        request.state = dict(_LIGHT_STATE)

        result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        # Full tool set preserved verbatim — start_builder_task reachable.
        fallback_request = handler.calls[1]
        assert fallback_request.tools == request.tools
        assert "start_builder_task" in fallback_request.tools
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_conversational_light_path"] is False
        assert update["companion_conversational_tools_disabled"] is False
        tool_names = [tc["name"] for tc in result.model_response.result[-1].tool_calls]
        assert "start_builder_task" in tool_names

    def test_active_build_keeps_heavy_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        handler = _SequenceHandler(
            _ProviderStatusError(401),
            _prose_response("The build is still running — almost there."),
        )
        state = dict(_LIGHT_STATE)
        state["async_tasks"] = {"task-1": {"status": "running"}}
        request = _conversational_request(state=state)

        result = CompanionProviderFallbackMiddleware().wrap_model_call(request, handler)

        # BuildAwareness context must survive: no light path while a build runs.
        fallback_request = handler.calls[1]
        assert fallback_request.tools == request.tools
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_conversational_light_path"] is False


class TestPrimaryProviderCooldown:
    """After a classified Anthropic failure, companion turns within the TTL
    skip the doomed primary attempt and call OpenAI directly."""

    def test_failure_sets_cooldown_and_next_turn_bypasses_primary(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        middleware = CompanionProviderFallbackMiddleware()

        first_handler = _Handler(_make_anthropic_billing_400(), response="recovered")
        middleware.wrap_model_call(_FakeRequest(), first_handler)
        assert len(first_handler.calls) == 2  # primary + fallback, as before

        second_handler = _Handler(None, response="bypassed-ok")
        with caplog.at_level(logging.WARNING):
            result = middleware.wrap_model_call(_FakeRequest(), second_handler)

        # ONE call only — straight to the fallback model, no Anthropic attempt.
        assert len(second_handler.calls) == 1
        assert second_handler.calls[0].model is _FALLBACK_MODEL_SENTINEL
        assert "companionFallbackPrimaryBypassed=true" in caplog.text
        assert "companionFallbackBypassReason=provider_credit_depleted" in caplog.text
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_primary_bypassed"] is True
        assert update["companion_fallback_bypass_reason"] == "provider_credit_depleted"

    def test_async_path_bypasses_primary_during_cooldown(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        middleware = CompanionProviderFallbackMiddleware()
        mw_module._set_primary_cooldown("provider_unavailable")

        sync_handler = _Handler(None, response="bypassed-ok")

        async def handler(request):
            return sync_handler(request)

        async def run():
            return await middleware.awrap_model_call(_FakeRequest(), handler)

        result = asyncio.run(run())
        assert len(sync_handler.calls) == 1
        assert sync_handler.calls[0].model is _FALLBACK_MODEL_SENTINEL
        update = result.command.update["companion_provider_fallback"]
        assert update["companion_fallback_primary_bypassed"] is True
        assert update["companion_fallback_bypass_reason"] == "provider_unavailable"

    def test_cooldown_not_applied_when_fallback_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _disable_fallback(monkeypatch)
        mw_module._set_primary_cooldown("permission_or_payment_error")
        handler = _Handler(None, response="primary-ok")

        result = CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        # Primary attempted normally; the cooldown never short-circuits.
        assert len(handler.calls) == 1
        assert handler.calls[0].model == "primary-model"
        assert result == "primary-ok"

    def test_cooldown_not_applied_when_openai_key_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        mw_module._set_primary_cooldown("permission_or_payment_error")
        handler = _Handler(None, response="primary-ok")

        result = CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert len(handler.calls) == 1
        assert result == "primary-ok"

    def test_successful_primary_clears_cooldown(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _disable_fallback(monkeypatch)  # bypass inactive → primary runs
        mw_module._set_primary_cooldown("provider_unavailable")
        handler = _Handler(None, response="primary-ok")

        CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert mw_module._active_primary_cooldown_error_class() is None

    def test_cooldown_ttl_zero_disables_caching(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from deerflow.sophia.companion_provider_fallback import PRIMARY_COOLDOWN_ENV

        _enable_fallback(monkeypatch)
        monkeypatch.setenv(PRIMARY_COOLDOWN_ENV, "0")
        handler = _Handler(_ProviderStatusError(429), response="recovered")

        CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert mw_module._active_primary_cooldown_error_class() is None

    def test_fallback_failure_during_bypass_clears_cooldown_and_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        mw_module._set_primary_cooldown("permission_or_payment_error")

        def failing_handler(request):
            raise RuntimeError("fallback transport error")

        with pytest.raises(RuntimeError):
            CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), failing_handler)

        # Next turn retries the primary provider normally.
        assert mw_module._active_primary_cooldown_error_class() is None

    def test_no_secrets_in_bypass_logs(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        _enable_fallback(monkeypatch)
        mw_module._set_primary_cooldown("permission_or_payment_error")
        handler = _Handler(None, response="bypassed-ok")

        with caplog.at_level(logging.WARNING):
            CompanionProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert _PLACEHOLDER_KEY not in caplog.text
        assert "openai-model-placeholder" not in caplog.text
        assert "providerSecretsExcluded=true" in caplog.text
