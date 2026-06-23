"""Tests for the Builder OpenAI provider fallback (mocked providers only).

No real API calls are made anywhere in this file. The "OpenAI model" is a
sentinel object; the "Anthropic failure" is a shape-double exception with a
``status_code`` attribute. ``OPENAI_API_KEY`` is set to an obvious
placeholder via monkeypatch and the tests assert that placeholder never
leaks into logs or diagnostics.

Locked behavior:

1. Fallback disabled (default) → provider failure re-raises unchanged,
   OpenAI never called.
2. Enabled but key/model missing → OpenAI never called,
   ``fallback_not_configured`` is logged, no secret values logged.
3. Enabled + configured + auth/quota/rate-limit/5xx primary failure →
   exactly one OpenAI retry through the SAME handler with the SAME tools
   (only ``model`` overridden), success completes the turn normally and
   records a sanitized ``builder_provider_fallback`` state snapshot.
4. Product/tool/validation/cancellation errors never trigger fallback.
5. Diagnostics merge: the snapshot's allowlisted fields appear in
   ``builder_failure_diagnostics`` payloads; no raw payloads or keys.
6. The terminal artifact handoff contract is provider-independent — the
   fallback retry carries the identical request tools, and a
   completed-without-deliverable terminal still fails.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest

from deerflow.agents.sophia_agent.middlewares import builder_provider_fallback as mw_module
from deerflow.agents.sophia_agent.middlewares.builder_provider_fallback import (
    BuilderProviderFallbackMiddleware,
)
from deerflow.sophia.builder_provider_fallback import (
    FALLBACK_ENABLED_ENV,
    FALLBACK_MODEL_ENV,
    PRIMARY_COOLDOWN_ENV,
    classify_provider_error,
    provider_fallback_snapshot,
)

_PLACEHOLDER_KEY = "test-openai-key-placeholder-never-real"


@pytest.fixture(autouse=True)
def _reset_primary_cooldown():
    """The primary-cooldown state is module-global; without this reset, a
    test that triggers a primary error arms the cooldown and every later
    test in the file sees the primary bypassed (e.g.
    ``test_async_path_retries_once`` fails in file order but passes in
    isolation). The feature ships this hook for exactly this purpose."""
    mw_module.reset_builder_primary_cooldown_for_tests()
    yield
    mw_module.reset_builder_primary_cooldown_for_tests()


class _ProviderStatusError(Exception):
    """Shape double for provider HTTP errors (anthropic-style status_code)."""

    def __init__(self, status_code: int, message: str = "provider error") -> None:
        super().__init__(message)
        self.status_code = status_code


class _FakeRequest:
    """Minimal stand-in for langchain's ModelRequest."""

    def __init__(self, model: object = "primary-model", tools: tuple = ("tool_a", "emit_builder_artifact")) -> None:
        self.model = model
        self.tools = tools

    def override(self, **overrides):
        clone = _FakeRequest(model=overrides.get("model", self.model), tools=self.tools)
        return clone


_FALLBACK_MODEL_SENTINEL = object()


@pytest.fixture(autouse=True)
def _reset_builder_provider_cooldown():
    mw_module.reset_builder_primary_cooldown_for_tests()
    yield
    mw_module.reset_builder_primary_cooldown_for_tests()


def _enable_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
    monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", _PLACEHOLDER_KEY)
    monkeypatch.setenv(PRIMARY_COOLDOWN_ENV, "300")
    monkeypatch.setattr(mw_module, "build_fallback_chat_model", lambda: _FALLBACK_MODEL_SENTINEL)


def _disable_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(FALLBACK_ENABLED_ENV, raising=False)
    monkeypatch.delenv(FALLBACK_MODEL_ENV, raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


class _Handler:
    """Records calls; raises ``primary_exc`` on the first call, then returns."""

    def __init__(self, primary_exc: BaseException | None, response: object = "model-response", fallback_exc: BaseException | None = None) -> None:
        self.primary_exc = primary_exc
        self.fallback_exc = fallback_exc
        self.response = response
        self.calls: list[_FakeRequest] = []

    def __call__(self, request: _FakeRequest):
        self.calls.append(request)
        if len(self.calls) == 1 and self.primary_exc is not None:
            raise self.primary_exc
        if len(self.calls) == 2 and self.fallback_exc is not None:
            raise self.fallback_exc
        return self.response


class TestClassification:
    def test_provider_availability_errors_classified(self) -> None:
        assert classify_provider_error(_ProviderStatusError(401)) == "auth_error"
        assert classify_provider_error(_ProviderStatusError(402)) == "permission_or_payment_error"
        assert classify_provider_error(_ProviderStatusError(403)) == "permission_or_payment_error"
        assert classify_provider_error(_ProviderStatusError(429)) == "rate_limit_or_quota"
        assert classify_provider_error(_ProviderStatusError(500)) == "provider_unavailable"
        assert classify_provider_error(_ProviderStatusError(529)) == "provider_unavailable"

    def test_product_and_validation_errors_not_classified(self) -> None:
        # 400 = prompt/validation — would fail on any provider.
        assert classify_provider_error(_ProviderStatusError(400)) is None
        assert classify_provider_error(ValueError("emit_builder_artifact rejected")) is None
        assert classify_provider_error(RuntimeError("artifact_file_missing")) is None
        assert classify_provider_error(asyncio.CancelledError()) is None


class TestFallbackDisabled:
    def test_provider_error_reraises_and_openai_not_called(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        _disable_fallback(monkeypatch)
        primary = _ProviderStatusError(401)
        handler = _Handler(primary)
        middleware = BuilderProviderFallbackMiddleware()

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_ProviderStatusError) as excinfo:
                middleware.wrap_model_call(_FakeRequest(), handler)

        assert excinfo.value is primary  # unchanged exception, as today
        assert len(handler.calls) == 1  # no second (OpenAI) call
        assert "fallback_result=fallback_disabled" in caplog.text
        assert "provider_error_class=auth_error" in caplog.text

    def test_non_provider_error_passes_through_silently(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        _disable_fallback(monkeypatch)
        handler = _Handler(ValueError("tool execution bug"))
        with caplog.at_level(logging.WARNING):
            with pytest.raises(ValueError):
                BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        assert len(handler.calls) == 1
        assert "BuilderProviderFallback" not in caplog.text


class TestFallbackEnabledButNotConfigured:
    def test_missing_key_and_model_logs_not_configured(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.delenv(FALLBACK_MODEL_ENV, raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        primary = _ProviderStatusError(429)
        handler = _Handler(primary)

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_ProviderStatusError):
                BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert len(handler.calls) == 1  # OpenAI never called
        assert "fallback_result=fallback_not_configured" in caplog.text

    def test_model_set_but_key_missing_logs_not_configured(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        handler = _Handler(_ProviderStatusError(401))

        with caplog.at_level(logging.WARNING):
            with pytest.raises(_ProviderStatusError):
                BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert len(handler.calls) == 1
        assert "fallback_result=fallback_not_configured" in caplog.text


class TestFallbackEnabledAndConfigured:
    @staticmethod
    def _composed_builder_call(request, model_call):
        """Production shape: LLMErrorHandling wraps the builder fallback.

        The fallback is the inner model-call wrapper so provider availability
        exceptions get a first chance at OpenAI before the generic LLM handler
        converts them into a user-facing fallback message.
        """
        from deerflow.agents.middlewares.llm_error_handling_middleware import (
            LLMErrorHandlingMiddleware,
        )

        error_mw = LLMErrorHandlingMiddleware(retry_max_attempts=1)
        fallback_mw = BuilderProviderFallbackMiddleware()

        def inner_handler(req):
            return fallback_mw.wrap_model_call(req, model_call)

        return error_mw.wrap_model_call(request, inner_handler)

    def test_auth_failure_retries_once_via_openai_with_same_tools(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(_ProviderStatusError(401), response="fallback-ok")
        request = _FakeRequest()

        result = BuilderProviderFallbackMiddleware().wrap_model_call(request, handler)

        assert len(handler.calls) == 2  # exactly one retry
        retry_request = handler.calls[1]
        assert retry_request.model is _FALLBACK_MODEL_SENTINEL
        # Tool contract preserved verbatim — emit_builder_artifact included.
        assert retry_request.tools == request.tools
        assert "emit_builder_artifact" in retry_request.tools
        # Success wraps the response with a sanitized state snapshot.
        assert result.model_response == "fallback-ok"
        update = result.command.update["builder_provider_fallback"]
        assert update["fallback_attempted"] is True
        assert update["fallback_result"] == "success"
        assert update["provider_error_class"] == "auth_error"
        assert update["fallback_primary_bypassed"] is False
        assert update["final_provider"] == "openai"

    def test_anthropic_overload_reaches_fallback_before_generic_reply(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(_ProviderStatusError(529, "Overloaded"), response="fallback-ok")
        request = _FakeRequest()

        result = self._composed_builder_call(request, handler)

        assert len(handler.calls) == 2
        assert handler.calls[1].model is _FALLBACK_MODEL_SENTINEL
        assert result.model_response == "fallback-ok"
        update = result.command.update["builder_provider_fallback"]
        assert update["fallback_attempted"] is True
        assert update["fallback_result"] == "success"
        assert update["provider_error_class"] == "provider_unavailable"
        assert update["final_provider"] == "openai"

    def test_overload_without_fallback_keeps_generic_busy_message(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        from langchain_core.messages import AIMessage

        _disable_fallback(monkeypatch)
        handler = _Handler(_ProviderStatusError(529, "Overloaded"))

        with caplog.at_level(logging.WARNING):
            result = self._composed_builder_call(_FakeRequest(), handler)

        assert len(handler.calls) == 1
        assert isinstance(result, AIMessage)
        assert result.additional_kwargs.get("deerflow_error_fallback") is True
        assert result.additional_kwargs.get("error_reason") == "busy"
        assert "temporarily unavailable" in result.content
        assert "fallback_result=fallback_disabled" in caplog.text

    def test_primary_cooldown_bypasses_anthropic_on_next_turn(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        _enable_fallback(monkeypatch)
        middleware = BuilderProviderFallbackMiddleware()
        first_handler = _Handler(_ProviderStatusError(401), response="fallback-ok")
        second_handler = _Handler(primary_exc=None, response="cooldown-fallback-ok")

        middleware.wrap_model_call(_FakeRequest(), first_handler)
        with caplog.at_level(logging.WARNING):
            second = middleware.wrap_model_call(_FakeRequest(), second_handler)

        assert len(first_handler.calls) == 2
        assert len(second_handler.calls) == 1
        assert second_handler.calls[0].model is _FALLBACK_MODEL_SENTINEL
        update = second.command.update["builder_provider_fallback"]
        assert second.model_response == "cooldown-fallback-ok"
        assert update["fallback_primary_bypassed"] is True
        assert update["fallback_bypass_reason"] == "provider_unavailable"
        assert "primary_provider_bypassed=true" in caplog.text

    def test_async_path_retries_once(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        sync_handler = _Handler(_ProviderStatusError(429), response="fallback-ok")

        async def handler(request):
            return sync_handler(request)

        async def run():
            return await BuilderProviderFallbackMiddleware().awrap_model_call(_FakeRequest(), handler)

        result = asyncio.run(run())
        assert len(sync_handler.calls) == 2
        assert sync_handler.calls[1].model is _FALLBACK_MODEL_SENTINEL
        assert result.command.update["builder_provider_fallback"]["fallback_result"] == "success"

    def test_fallback_failure_reraises_chained(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        _enable_fallback(monkeypatch)
        primary = _ProviderStatusError(500)
        fallback_exc = RuntimeError("fallback also failed")
        handler = _Handler(primary, fallback_exc=fallback_exc)

        with caplog.at_level(logging.WARNING):
            with pytest.raises(RuntimeError) as excinfo:
                BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)

        assert excinfo.value is fallback_exc
        assert excinfo.value.__cause__ is primary
        assert "fallback_result=fallback_failed" in caplog.text

    def test_product_errors_still_do_not_trigger_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        for exc in (
            _ProviderStatusError(400, "validation"),
            ValueError("emit_builder_artifact rejected: artifact_file_missing"),
            RuntimeError("user cancelled"),
        ):
            handler = _Handler(exc)
            with pytest.raises(type(exc)):
                BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
            assert len(handler.calls) == 1, f"OpenAI must not be called for {exc!r}"

    def test_cancellation_is_never_caught(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(asyncio.CancelledError())
        with pytest.raises(asyncio.CancelledError):
            BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        assert len(handler.calls) == 1

    def test_no_secret_values_in_logs_or_snapshot(self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
        _enable_fallback(monkeypatch)
        handler = _Handler(_ProviderStatusError(401), response="ok")
        with caplog.at_level(logging.WARNING):
            result = BuilderProviderFallbackMiddleware().wrap_model_call(_FakeRequest(), handler)
        snapshot = result.command.update["builder_provider_fallback"]
        assert _PLACEHOLDER_KEY not in caplog.text
        assert _PLACEHOLDER_KEY not in repr(snapshot)
        assert snapshot["provider_secrets_excluded"] is True
        assert snapshot["raw_provider_payload_excluded"] is True
        # Model name is exposed as a boolean only.
        assert snapshot["fallback_model_configured"] is True
        assert "openai-model-placeholder" not in repr(snapshot)


class TestSnapshotShape:
    def test_snapshot_fields_are_allowlisted_and_safe(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(FALLBACK_ENABLED_ENV, "true")
        monkeypatch.setenv(FALLBACK_MODEL_ENV, "openai-model-placeholder")
        snapshot = provider_fallback_snapshot(
            error_class="rate_limit_or_quota",
            fallback_attempted=True,
            fallback_result="success",
        )
        assert snapshot["primary_provider"] == "anthropic"
        assert snapshot["fallback_provider"] == "openai"
        assert snapshot["fallback_enabled"] is True
        assert snapshot["fallback_reason"] == "rate_limit_or_quota"
        assert snapshot["provider_error_safe_message"].startswith("Primary model provider")
        # The safe message is a fixed template — no raw provider text.
        assert "Traceback" not in snapshot["provider_error_safe_message"]


class TestDiagnosticsMerge:
    def test_failure_diagnostics_include_provider_fields(self, tmp_path) -> None:
        from deerflow.sophia.builder_failure_diagnostics import build_builder_failure_diagnostics

        outputs = tmp_path / "outputs"
        outputs.mkdir()
        state = {
            "thread_data": {"outputs_path": str(outputs)},
            "builder_artifact_target_path": "/mnt/user-data/outputs/report.html",
            "delegation_context": {"task_type": "document", "artifact_target_path": "/mnt/user-data/outputs/report.html"},
            "builder_provider_fallback": {
                "primary_provider": "anthropic",
                "fallback_provider": "openai",
                "fallback_enabled": True,
                "fallback_attempted": True,
                "fallback_reason": "auth_error",
                "fallback_result": "success",
                "fallback_model_configured": True,
                "provider_error_class": "auth_error",
                "provider_error_safe_message": "Primary model provider rejected the API key (authentication failure).",
                "raw_provider_payload_excluded": True,
                "provider_secrets_excluded": True,
                # Hostile extra keys must NOT survive the allowlist.
                "api_key": _PLACEHOLDER_KEY,
                "raw_provider_payload": "<html>secret</html>",
            },
        }
        diagnostic = build_builder_failure_diagnostics(
            state=state,
            runtime=SimpleNamespace(context={"thread_id": "builder-thread"}),
            failure_stage="completion_reconciliation",
            failure_reason="Builder finished without a deliverable artifact.",
            failure_code="builder_completed_without_deliverable",
            emit_attempted=False,
            emit_tool_call_seen=False,
        )

        assert diagnostic["fallback_attempted"] is True
        assert diagnostic["fallback_result"] == "success"
        assert diagnostic["primary_provider"] == "anthropic"
        assert diagnostic["fallback_provider"] == "openai"
        assert diagnostic["provider_error_class"] == "auth_error"
        assert diagnostic["raw_provider_payload_excluded"] is True
        assert diagnostic["provider_secrets_excluded"] is True
        # No-deliverable terminal stays failed with the same code.
        assert diagnostic["failure_code"] == "builder_completed_without_deliverable"
        assert diagnostic["emit_attempted"] is False
        # Hostile keys excluded; no secret material anywhere.
        assert "api_key" not in diagnostic
        assert "raw_provider_payload" not in diagnostic
        assert _PLACEHOLDER_KEY not in repr(diagnostic)
        assert "<html>secret</html>" not in repr(diagnostic)

    def test_diagnostics_without_snapshot_are_unchanged(self, tmp_path) -> None:
        from deerflow.sophia.builder_failure_diagnostics import build_builder_failure_diagnostics

        outputs = tmp_path / "outputs"
        outputs.mkdir()
        diagnostic = build_builder_failure_diagnostics(
            state={"thread_data": {"outputs_path": str(outputs)}},
            runtime=SimpleNamespace(context={"thread_id": "builder-thread"}),
            failure_stage="completion_reconciliation",
            failure_reason="Builder finished without a deliverable artifact.",
            failure_code="builder_completed_without_deliverable",
            emit_attempted=False,
        )
        assert "fallback_attempted" not in diagnostic
        assert "primary_provider" not in diagnostic


class TestChainWiring:
    def test_builder_chain_includes_provider_fallback_middleware(self) -> None:
        from deerflow.agents.sophia_agent.builder_middlewares import build_builder_middleware_chain

        chain = build_builder_middleware_chain(user_id="user_test")
        names = [type(mw).__name__ for mw in chain]
        assert "BuilderProviderFallbackMiddleware" in names
        # Artifact capture (handoff contract owner) is still in the chain,
        # after the fallback wrapper.
        assert "BuilderArtifactMiddleware" in names
        assert names.index("BuilderProviderFallbackMiddleware") < names.index("BuilderArtifactMiddleware")
