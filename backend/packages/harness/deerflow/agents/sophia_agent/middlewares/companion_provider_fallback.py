"""Companion provider-fallback middleware (Anthropic primary → OpenAI retry).

Wraps ONLY the Sophia *companion's* model invocation via ``wrap_model_call`` /
``awrap_model_call``. Everything else in the companion pipeline — crisis
fast-path, tone/context/ritual/skill calibration, memory retrieval, build
awareness, artifact instructions, prompt assembly, dangling-tool-call
patching, prompt caching — is untouched and applies identically to fallback
turns, because the retry re-enters the SAME handler with the SAME
``request.tools`` (the agent's model node binds the tool set to whatever model
the request carries, so ``start_builder_task`` and every other companion tool
remain available verbatim on the OpenAI path).

This is the companion sibling of ``BuilderProviderFallbackMiddleware``; it uses
the same shared classifier but a separate env namespace
(``SOPHIA_COMPANION_OPENAI_FALLBACK_*``), a separate log prefix
(``[CompanionProviderFallback]``), and a separate state snapshot key
(``companion_provider_fallback``).

Decision table on a primary-model exception:

1. Not a provider-availability error (see
   ``classify_provider_error``) → re-raise unchanged. ``start_builder_task`` /
   ``emit_artifact`` product errors, prompt validation, tool bugs, safety
   refusals, and cancellations can never trigger fallback — the product
   events never pass through the model call as exceptions, and
   ``CancelledError`` is a ``BaseException`` this middleware doesn't catch.
2. Classified but fallback disabled (default) → one structured log line
   (``fallback_result=fallback_disabled``), re-raise unchanged. Behavior is
   byte-identical to today.
3. Classified, enabled, but ``OPENAI_API_KEY`` or the fallback model name
   missing → log ``fallback_result=fallback_not_configured``, re-raise.
   OpenAI is never called.
4. Classified + enabled + configured → retry ONCE with
   ``request.override(model=ChatOpenAI(...))``. On success the response is
   returned wrapped in an ``ExtendedModelResponse`` whose ``Command`` writes a
   sanitized ``companion_provider_fallback`` snapshot into state. On fallback
   failure, the fallback exception propagates (chained to the primary) and the
   run fails as it would today.

No API keys, raw provider payloads, prompts, or file contents are ever logged
or stored — the snapshot is built exclusively from the fixed allowlisted
fields in ``companion_provider_fallback_snapshot``.
"""

from __future__ import annotations

import logging
from typing import Any, NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse
from langgraph.types import Command

from deerflow.sophia.companion_provider_fallback import (
    build_fallback_chat_model,
    classify_provider_error,
    companion_provider_fallback_snapshot,
    fallback_enabled,
    fallback_model_name,
    openai_api_key_present,
)

logger = logging.getLogger(__name__)


class CompanionProviderFallbackState(AgentState):
    companion_provider_fallback: NotRequired[dict]


class CompanionProviderFallbackMiddleware(AgentMiddleware[CompanionProviderFallbackState]):
    """Retry the companion model call once through OpenAI on provider outages."""

    state_schema = CompanionProviderFallbackState

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
                "[CompanionProviderFallback] primary provider error "
                "provider_error_class=%s fallback_attempted=false "
                "fallback_result=fallback_disabled — propagating original error "
                "(set SOPHIA_COMPANION_OPENAI_FALLBACK_ENABLED=true to enable).",
                error_class,
            )
            return None
        if not (openai_api_key_present() and fallback_model_name()):
            logger.warning(
                "[CompanionProviderFallback] primary provider error "
                "provider_error_class=%s fallback_attempted=false "
                "fallback_result=fallback_not_configured — fallback is enabled but "
                "OPENAI_API_KEY and/or SOPHIA_COMPANION_OPENAI_FALLBACK_MODEL is missing.",
                error_class,
            )
            return None
        try:
            return build_fallback_chat_model()
        except Exception:
            logger.warning(
                "[CompanionProviderFallback] could not construct the OpenAI fallback model "
                "provider_error_class=%s fallback_result=fallback_not_configured",
                error_class,
                exc_info=True,
            )
            return None

    @staticmethod
    def _response_is_empty(response: Any) -> bool:
        """True only when the fallback produced a message with no visible
        text AND no tool calls.

        Conservative by design: when the response shape can't be inspected
        (e.g. a bare sentinel in a unit test, or an unexpected wrapper) it
        returns ``False`` so a genuine reply is never mislabeled as empty.
        Only the already-parsed LangChain ``content`` / ``tool_calls`` are
        inspected — raw provider payloads are never touched.
        """
        candidates: list[Any] = []
        result = getattr(response, "result", None)
        if isinstance(result, list):
            candidates.extend(result)
        elif hasattr(response, "content") or hasattr(response, "tool_calls"):
            candidates.append(response)
        if not candidates:
            return False
        message = candidates[-1]
        if not (hasattr(message, "content") or hasattr(message, "tool_calls")):
            return False
        if getattr(message, "tool_calls", None):
            return False
        content = getattr(message, "content", None)
        if isinstance(content, str):
            has_text = bool(content.strip())
        elif isinstance(content, list):
            has_text = any(
                (isinstance(block, str) and block.strip())
                or (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and str(block.get("text", "")).strip()
                )
                for block in content
            )
        else:
            has_text = bool(content)
        return not has_text

    @staticmethod
    def _success_response(response: Any, error_class: str) -> ExtendedModelResponse:
        is_empty = CompanionProviderFallbackMiddleware._response_is_empty(response)
        fallback_result = "empty_response" if is_empty else "success"
        snapshot = companion_provider_fallback_snapshot(
            error_class=error_class,
            fallback_attempted=True,
            fallback_result=fallback_result,
        )
        if is_empty:
            # The fallback call returned cleanly but with nothing the UI can
            # render (no visible text, no tool call). Surface a safe
            # diagnostic so this is distinguishable from a real reply — no
            # crash, no fake failure, no raw payload.
            logger.warning(
                "[CompanionProviderFallback] OpenAI fallback returned no "
                "visible content and no tool calls "
                "provider_error_class=%s fallback_attempted=true "
                "companionFallbackEmptyResponse=true "
                "companionFallbackResult=empty_response "
                "rawProviderPayloadExcluded=true",
                error_class,
            )
        else:
            logger.warning(
                "[CompanionProviderFallback] OpenAI fallback succeeded "
                "provider_error_class=%s fallback_attempted=true fallback_result=success",
                error_class,
            )
        return ExtendedModelResponse(
            model_response=response,
            command=Command(update={"companion_provider_fallback": snapshot}),
        )

    @staticmethod
    def _log_fallback_failed(error_class: str) -> None:
        logger.warning(
            "[CompanionProviderFallback] OpenAI fallback also failed "
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
                "[CompanionProviderFallback] retrying once via OpenAI "
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
                "[CompanionProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                response = await handler(request.override(model=fallback_model))
            except Exception as fallback_exc:
                self._log_fallback_failed(error_class)
                raise fallback_exc from primary_exc
            return self._success_response(response, error_class)
