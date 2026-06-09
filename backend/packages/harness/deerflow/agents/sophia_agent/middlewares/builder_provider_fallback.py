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
    provider_fallback_snapshot,
)

logger = logging.getLogger(__name__)


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
    def _success_response(response: Any, error_class: str) -> ExtendedModelResponse:
        snapshot = provider_fallback_snapshot(
            error_class=error_class,
            fallback_attempted=True,
            fallback_result="success",
        )
        logger.warning(
            "[BuilderProviderFallback] OpenAI fallback succeeded "
            "provider_error_class=%s fallback_attempted=true fallback_result=success",
            error_class,
        )
        return ExtendedModelResponse(
            model_response=response,
            command=Command(update={"builder_provider_fallback": snapshot}),
        )

    @staticmethod
    def _log_fallback_failed(error_class: str) -> None:
        logger.warning(
            "[BuilderProviderFallback] OpenAI fallback also failed "
            "provider_error_class=%s fallback_attempted=true fallback_result=fallback_failed",
            error_class,
        )

    # ------------------------------------------------------------------
    # Sync + async model-call wrappers
    # ------------------------------------------------------------------

    def wrap_model_call(self, request, handler):  # type: ignore[override]
        try:
            return handler(request)
        except Exception as primary_exc:
            error_class = classify_provider_error(primary_exc)
            if error_class is None:
                raise
            fallback_model = self._fallback_model_or_none(error_class)
            if fallback_model is None:
                raise
            logger.warning(
                "[BuilderProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                response = handler(request.override(model=fallback_model))
            except Exception as fallback_exc:
                self._log_fallback_failed(error_class)
                raise fallback_exc from primary_exc
            return self._success_response(response, error_class)

    async def awrap_model_call(self, request, handler):  # type: ignore[override]
        try:
            return await handler(request)
        except Exception as primary_exc:
            error_class = classify_provider_error(primary_exc)
            if error_class is None:
                raise
            fallback_model = self._fallback_model_or_none(error_class)
            if fallback_model is None:
                raise
            logger.warning(
                "[BuilderProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                response = await handler(request.override(model=fallback_model))
            except Exception as fallback_exc:
                self._log_fallback_failed(error_class)
                raise fallback_exc from primary_exc
            return self._success_response(response, error_class)
