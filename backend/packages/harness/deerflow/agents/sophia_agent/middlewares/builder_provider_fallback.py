"""Builder provider-fallback middleware (Anthropic primary → OpenAI retry).

Wraps ONLY the Builder's model invocation via ``wrap_model_call`` /
``awrap_model_call``. Everything else in the Builder pipeline — briefing,
research policy, progress events, todo, artifact capture + validation,
prompt assembly, dangling-tool-call patching, the terminal artifact handoff
contract — is untouched and applies identically to fallback turns, because
the retry re-enters the SAME handler with the SAME ``request.tools`` (the
agent's model node binds the tool set to whatever model the request
carries, so ``emit_builder_artifact`` and the sandbox/web tools remain
available verbatim on the OpenAI path).

Decision table on a primary-model exception:

1. Not a provider-availability error (see
   ``builder_provider_fallback.classify_provider_error``) → re-raise
   unchanged. emit rejections, artifact-missing, prompt validation, tool
   bugs, safety refusals, and cancellations can never trigger fallback —
   the first never even pass through the model call as exceptions, and
   ``CancelledError`` is a ``BaseException`` this middleware doesn't catch.
2. Classified but fallback disabled (default) → one structured log line
   (``fallback_result=fallback_disabled``), re-raise unchanged. Behavior is
   byte-identical to today.
3. Classified, enabled, but ``OPENAI_API_KEY`` or the fallback model name
   missing → log ``fallback_result=fallback_not_configured``, re-raise.
   OpenAI is never called.
4. Classified + enabled + configured → retry ONCE with
   ``request.override(model=ChatOpenAI(...))``. On success, the response is
   returned wrapped in an ``ExtendedModelResponse`` whose ``Command`` writes
   a sanitized ``builder_provider_fallback`` snapshot into state (merged
   into ``builder_failure_diagnostics`` if the build later fails for other
   reasons). On fallback failure, the fallback exception propagates
   (chained to the primary) and the run fails as it would today.

No API keys, raw provider payloads, prompts, or file contents are ever
logged or stored — the snapshot is built exclusively from the fixed
allowlisted fields in ``provider_fallback_snapshot``.
"""

from __future__ import annotations

import logging
import time
from typing import Any, NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse
from langgraph.types import Command

from deerflow.sophia.builder_provider_fallback import (
    build_fallback_chat_model,
    classify_provider_error,
    fallback_enabled,
    fallback_model_name,
    openai_api_key_present,
    primary_cooldown_seconds,
    provider_fallback_failure_diagnostic,
    provider_fallback_snapshot,
)

logger = logging.getLogger(__name__)

_primary_cooldown: dict[str, Any] = {"until": 0.0, "error_class": None}
_CACHE_CONTROL_KEY = "cache_control"


def _set_primary_cooldown(error_class: str) -> None:
    ttl = primary_cooldown_seconds()
    if ttl <= 0:
        return
    _primary_cooldown["until"] = time.monotonic() + ttl
    _primary_cooldown["error_class"] = error_class


def _clear_primary_cooldown() -> None:
    _primary_cooldown["until"] = 0.0
    _primary_cooldown["error_class"] = None


def _active_primary_cooldown_error_class() -> str | None:
    if time.monotonic() >= _primary_cooldown["until"]:
        return None
    error_class = _primary_cooldown.get("error_class")
    return error_class if isinstance(error_class, str) and error_class else None


def reset_builder_primary_cooldown_for_tests() -> None:
    _clear_primary_cooldown()


def _bypass_reason(error_class: str) -> str:
    return (
        "provider_credit_depleted"
        if error_class == "permission_or_payment_error"
        else "provider_unavailable"
    )


def _strip_anthropic_cache_control(value: Any) -> Any:
    """Remove Anthropic prompt-cache metadata before OpenAI fallback calls.

    ``AnthropicPromptCachingMiddleware`` can attach ``cache_control`` fields to
    message content blocks, system blocks, tool schemas, or model settings.
    Those fields are provider-specific and OpenAI rejects them. Keep this
    sanitizer narrow: it preserves all other structure and only removes the
    exact Anthropic key.
    """
    if isinstance(value, dict):
        return {
            key: _strip_anthropic_cache_control(item)
            for key, item in value.items()
            if key != _CACHE_CONTROL_KEY
        }
    if isinstance(value, list):
        return [_strip_anthropic_cache_control(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_strip_anthropic_cache_control(item) for item in value)
    return value


def _strip_cache_control_from_message(message: Any) -> Any:
    updates: dict[str, Any] = {}
    for attr in ("content", "additional_kwargs", "response_metadata"):
        if not hasattr(message, attr):
            continue
        original = getattr(message, attr)
        stripped = _strip_anthropic_cache_control(original)
        if stripped != original:
            updates[attr] = stripped
    if not updates:
        return message
    if hasattr(message, "model_copy"):
        return message.model_copy(update=updates)
    copied = message
    for attr, value in updates.items():
        try:
            setattr(copied, attr, value)
        except Exception:  # noqa: BLE001 - best-effort for non-message test doubles
            pass
    return copied


def _openai_fallback_request(request: Any, fallback_model: Any) -> Any:
    overrides: dict[str, Any] = {"model": fallback_model}
    if hasattr(request, "messages"):
        messages = getattr(request, "messages")
        if isinstance(messages, list):
            overrides["messages"] = [_strip_cache_control_from_message(message) for message in messages]
    if hasattr(request, "system_message"):
        system_message = getattr(request, "system_message")
        if system_message is not None:
            overrides["system_message"] = _strip_cache_control_from_message(system_message)
    if hasattr(request, "tools"):
        tools = getattr(request, "tools")
        if isinstance(tools, list):
            overrides["tools"] = _strip_anthropic_cache_control(tools)
    if hasattr(request, "model_settings"):
        settings = getattr(request, "model_settings")
        if isinstance(settings, dict):
            overrides["model_settings"] = _strip_anthropic_cache_control(settings)
    return request.override(**overrides)


class BuilderProviderFallbackState(AgentState):
    builder_provider_fallback: NotRequired[dict]


class BuilderProviderFallbackMiddleware(AgentMiddleware[BuilderProviderFallbackState]):
    """Retry the Builder model call once through OpenAI on provider outages."""

    state_schema = BuilderProviderFallbackState

    # ------------------------------------------------------------------
    # Shared decision logic (no instance state — concurrency-safe)
    # ------------------------------------------------------------------

    @staticmethod
    def _fallback_model_or_none(error_class: str) -> Any | None:
        """Return the configured fallback model, or None when fallback must
        not run (disabled / not configured). Logs the safe reason either way.
        """
        if not fallback_enabled():
            logger.warning(
                "[BuilderProviderFallback] primary provider error "
                "provider_error_class=%s fallback_attempted=false "
                "fallback_result=fallback_disabled — propagating original error "
                "(set SOPHIA_BUILDER_OPENAI_FALLBACK_ENABLED=true to enable).",
                error_class,
            )
            return None
        if not (openai_api_key_present() and fallback_model_name()):
            logger.warning(
                "[BuilderProviderFallback] primary provider error "
                "provider_error_class=%s fallback_attempted=false "
                "fallback_result=fallback_not_configured — fallback is enabled but "
                "OPENAI_API_KEY and/or SOPHIA_BUILDER_OPENAI_FALLBACK_MODEL is missing.",
                error_class,
            )
            return None
        try:
            return build_fallback_chat_model()
        except Exception:
            logger.warning(
                "[BuilderProviderFallback] could not construct the OpenAI fallback model "
                "provider_error_class=%s fallback_result=fallback_not_configured",
                error_class,
                exc_info=True,
            )
            return None

    @staticmethod
    def _success_response(
        response: Any,
        error_class: str,
        *,
        primary_bypassed: bool = False,
    ) -> ExtendedModelResponse:
        bypass_reason = _bypass_reason(error_class) if primary_bypassed else None
        snapshot = provider_fallback_snapshot(
            error_class=error_class,
            fallback_attempted=True,
            fallback_result="success",
            primary_bypassed=primary_bypassed,
            bypass_reason=bypass_reason,
        )
        logger.warning(
            "[BuilderProviderFallback] OpenAI fallback succeeded "
            "provider_error_class=%s fallback_attempted=true fallback_result=success "
            "primary_provider_bypassed=%s fallback_bypass_reason=%s final_provider=openai",
            error_class,
            "true" if primary_bypassed else "false",
            bypass_reason or "none",
        )
        return ExtendedModelResponse(
            model_response=response,
            command=Command(update={"builder_provider_fallback": snapshot}),
        )

    @staticmethod
    def _log_fallback_failed(error_class: str, fallback_exc: BaseException | None = None) -> None:
        diagnostic = (
            provider_fallback_failure_diagnostic(fallback_exc)
            if fallback_exc is not None
            else {}
        )
        logger.warning(
            "[BuilderProviderFallback] OpenAI fallback also failed "
            "provider_error_class=%s fallback_attempted=true fallback_result=fallback_failed "
            "builderFailureDiagnosticAvailable=%s builderFailureStage=%s builderFailureCode=%s "
            "builderProviderErrorClass=%s builderFallbackAttempted=true "
            "builderFallbackResult=fallback_failed rawProviderPayloadExcluded=true "
            "providerSecretsExcluded=true",
            error_class,
            "true" if diagnostic else "false",
            diagnostic.get("builder_failure_stage", "provider_fallback"),
            diagnostic.get("builder_failure_code", "builder_provider_fallback_failed"),
            diagnostic.get("builder_provider_error_class", "provider_fallback_failed"),
        )

    # ------------------------------------------------------------------
    # Sync + async model-call wrappers
    # ------------------------------------------------------------------

    @staticmethod
    def _forced_provider_request(request):
        """VQ-9 eval hook: SOPHIA_BUILDER_FORCE_PROVIDER=openai routes every
        model call through the fallback model so the provider matrix can test
        the OpenAI path deterministically. Absent/other values = no-op; never
        set in production."""
        import os as _os

        forced = _os.environ.get("SOPHIA_BUILDER_FORCE_PROVIDER", "").strip().lower()
        if forced != "openai":
            return request
        fallback_model = BuilderProviderFallbackMiddleware._fallback_model_or_none("forced_for_eval")
        if fallback_model is None:
            logger.warning(
                "[BuilderProviderFallback] SOPHIA_BUILDER_FORCE_PROVIDER=openai set "
                "but no fallback model is configured — running primary provider"
            )
            return request
        logger.info("[BuilderProviderFallback] forced_provider=openai (eval hook)")
        return _openai_fallback_request(request, fallback_model)

    @staticmethod
    def _cooldown_fallback_model_or_none() -> tuple[str, Any] | None:
        error_class = _active_primary_cooldown_error_class()
        if error_class is None:
            return None
        fallback_model = BuilderProviderFallbackMiddleware._fallback_model_or_none(error_class)
        if fallback_model is None:
            return None
        logger.warning(
            "[BuilderProviderFallback] bypassing primary provider during cooldown "
            "provider_error_class=%s fallback_attempted=true primary_provider_bypassed=true "
            "fallback_bypass_reason=%s",
            error_class,
            _bypass_reason(error_class),
        )
        return error_class, fallback_model

    def wrap_model_call(self, request, handler):  # type: ignore[override]
        request = self._forced_provider_request(request)
        cooldown = self._cooldown_fallback_model_or_none()
        if cooldown is not None:
            error_class, fallback_model = cooldown
            try:
                response = handler(_openai_fallback_request(request, fallback_model))
            except Exception as fallback_exc:
                _clear_primary_cooldown()
                self._log_fallback_failed(error_class, fallback_exc)
                raise
            return self._success_response(response, error_class, primary_bypassed=True)
        try:
            response = handler(request)
            _clear_primary_cooldown()
            return response
        except Exception as primary_exc:
            error_class = classify_provider_error(primary_exc)
            if error_class is None:
                raise
            fallback_model = self._fallback_model_or_none(error_class)
            if fallback_model is None:
                raise
            _set_primary_cooldown(error_class)
            logger.warning(
                "[BuilderProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                response = handler(_openai_fallback_request(request, fallback_model))
            except Exception as fallback_exc:
                _clear_primary_cooldown()
                self._log_fallback_failed(error_class, fallback_exc)
                raise fallback_exc from primary_exc
            return self._success_response(response, error_class)

    async def awrap_model_call(self, request, handler):  # type: ignore[override]
        request = self._forced_provider_request(request)
        cooldown = self._cooldown_fallback_model_or_none()
        if cooldown is not None:
            error_class, fallback_model = cooldown
            try:
                response = await handler(_openai_fallback_request(request, fallback_model))
            except Exception as fallback_exc:
                _clear_primary_cooldown()
                self._log_fallback_failed(error_class, fallback_exc)
                raise
            return self._success_response(response, error_class, primary_bypassed=True)
        try:
            response = await handler(request)
            _clear_primary_cooldown()
            return response
        except Exception as primary_exc:
            error_class = classify_provider_error(primary_exc)
            if error_class is None:
                raise
            fallback_model = self._fallback_model_or_none(error_class)
            if fallback_model is None:
                raise
            _set_primary_cooldown(error_class)
            logger.warning(
                "[BuilderProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                response = await handler(_openai_fallback_request(request, fallback_model))
            except Exception as fallback_exc:
                _clear_primary_cooldown()
                self._log_fallback_failed(error_class, fallback_exc)
                raise fallback_exc from primary_exc
            return self._success_response(response, error_class)
