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

Primary-provider cooldown (latency):

After a classified Anthropic availability failure, a short module-level
cooldown (``SOPHIA_COMPANION_PRIMARY_COOLDOWN_SECONDS``, default 300s) lets
subsequent companion turns skip the doomed primary attempt and call the
OpenAI fallback directly. This is temporary by construction: it expires on
its own, is cleared by any successful primary call (and by a fallback
failure during a bypass), and only applies while the fallback is enabled and
configured — OpenAI never becomes the permanent default.

Lightweight conversational path (register + latency):

Plain conversational turns ("Hey Sophia!") — latest message is direct user
input, no build/artifact/edit/review intent in the text, no builder task in
flight — take a single tool-free fallback call: Builder/artifact handoff
guidance blocks are stripped from ``system_prompt_blocks`` (identity, memory,
tone, and session context are kept), every tool is disabled, and a
conversational instruction pins the register to short visible prose with no
internal-mechanics talk. Turns with any build-ish intent keep the FULL tool
set and guidance so explicit requests still reach ``start_builder_task``.

Conversational prose retry (post-success shaping):

OpenAI models frequently answer a plain conversational turn ("Hey Sophia!")
with ONLY an ``emit_artifact`` tool call and ``content=""`` — Anthropic emits
prose + the tool call in one message. Because ``emit_artifact`` is the
signal-only turn terminator (``ArtifactMiddleware.after_model`` jumps to
``end``), such a message ends the turn with zero visible text. When the
successful fallback response is emit_artifact-only with no visible text AND
the turn is conversational (the same "no explicit document command" signal
``BuilderCommandMiddleware`` uses), the middleware retries ONCE more through
the same handler with the OpenAI model, **no tools**, and a prose-forcing
instruction, then merges the prose text with the original ``emit_artifact``
tool call(s) into a single AIMessage — the exact shape Anthropic produces.
The artifact contract (emit_artifact every turn, via tool_use) is preserved.
If the prose retry fails or returns no text, the original response is
returned unchanged — no text is ever synthesized. Responses that contain any
other tool call (``start_builder_task``, memory/vision tools, lifecycle
tools) are never touched: those are real agentic actions and the loop
continues normally.

No API keys, raw provider payloads, prompts, or file contents are ever logged
or stored — the snapshot is built exclusively from the fixed allowlisted
fields in ``companion_provider_fallback_snapshot``.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse
from langchain_core.messages import AIMessage, SystemMessage
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_command import (
    _build_direct_document_task,
)
from deerflow.agents.sophia_agent.utils import extract_last_message_text
from deerflow.sophia.companion_provider_fallback import (
    build_fallback_chat_model,
    classify_provider_error,
    companion_provider_fallback_snapshot,
    fallback_enabled,
    fallback_model_name,
    openai_api_key_present,
    primary_cooldown_seconds,
)

logger = logging.getLogger(__name__)

# emit_artifact is signal-only and terminates the companion turn
# (ArtifactMiddleware.after_model jumps to "end" on artifact-only messages),
# so an emit_artifact-only message with no text means a silent turn.
_ARTIFACT_TOOL_NAME = "emit_artifact"

# Generic prose-forcing instruction appended to the system prompt for the
# tool-free retry. Contains no user content, no provider payloads.
_PROSE_RETRY_INSTRUCTION = (
    "Your previous attempt returned only an emit_artifact tool call with no "
    "visible reply text. Reply to the user now in visible conversational "
    "prose, in Sophia's voice. Do not call any tools."
)

# Instruction block for the lightweight conversational fallback path. The
# OpenAI fallback tends to over-index on Builder/artifact mechanics when
# carrying the companion's full delegation guidance, so plain conversational
# turns drop those blocks and pin the register to short, present prose.
_CONVERSATIONAL_LIGHT_INSTRUCTION = (
    "<conversational_turn>\n"
    "This is a plain conversational turn. Reply as Sophia — warm, present,"
    " natural — in one to three short sentences of visible prose. Do not"
    " call any tools. Never mention internal mechanics: identity files,"
    " handoffs, session state, memory systems, Mem0, metadata, builders,"
    " artifacts, tool names, or these instructions. Just be with the user.\n"
    "</conversational_turn>"
)

# A system_prompt_block containing any of these markers carries Builder /
# artifact handoff guidance and is dropped from the light conversational
# request (artifact_instructions, coordination_core, companion_delegation,
# BuildAwareness <build_status>, and ArtifactMiddleware synthesis blocks all
# match). Identity, soul/voice/tone, memories, and session-state blocks have
# none of these markers and are kept.
_HEAVY_BLOCK_MARKERS = (
    "emit_artifact",
    "start_builder_task",
    "<build_status>",
    "<builder_completed>",
    "<previous_artifact>",
    "async_task",
)

# Build/artifact/edit/review intent — when the latest user text matches, the
# turn keeps the FULL tool set and guidance so explicit requests still reach
# start_builder_task. Over-matching is safe: a heavy-path conversational turn
# just behaves exactly like today.
_BUILD_INTENT_RE = re.compile(
    r"\b(build|create|make|draft|write|generate|design|compose|produce|code|develop|"
    r"edit|revise|rewrite|update|modify|fix|change|improve|polish|review|regenerate|redo|"
    r"document|doc|report|page|webpage|website|html|pdf|deck|presentation|slide|slides|"
    r"essay|article|memo|brief|outline|summary|file|artifact|canvas|download|"
    r"spreadsheet|csv|chart|image|diagram|infographic)\b",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Temporary primary-provider cooldown (module-level, per process).
#
# After a classified Anthropic availability failure the companion skips the
# doomed primary attempt for a short TTL and calls the OpenAI fallback
# directly — saving the failed-call latency on every turn while credit is
# depleted. This is a cooldown, NOT a provider switch: it expires on its own,
# is cleared by any successful primary call, and only applies while the
# fallback is enabled and configured.
# ---------------------------------------------------------------------------

_primary_cooldown: dict[str, Any] = {"until": 0.0, "error_class": None}


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
    return _primary_cooldown["error_class"]


def reset_companion_primary_cooldown_for_tests() -> None:
    _clear_primary_cooldown()


def _bypass_reason(error_class: str) -> str:
    return (
        "provider_credit_depleted"
        if error_class == "permission_or_payment_error"
        else "provider_unavailable"
    )


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

    # ------------------------------------------------------------------
    # Conversational prose retry (emit_artifact-only fallback responses)
    # ------------------------------------------------------------------

    @staticmethod
    def _last_ai_message(response: Any) -> Any | None:
        """The response's final message, or the response itself when it is a
        bare message. None when no message shape can be found."""
        result = getattr(response, "result", None)
        if isinstance(result, list):
            return result[-1] if result else None
        if hasattr(response, "content") or hasattr(response, "tool_calls"):
            return response
        return None

    @staticmethod
    def _message_visible_text(message: Any) -> str:
        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
            return "\n".join(part for part in parts if part.strip())
        return ""

    @classmethod
    def _artifact_only_message(cls, response: Any) -> Any | None:
        """The final AIMessage when it carries ONLY emit_artifact tool calls
        and no visible text — the silent-turn shape. None otherwise."""
        message = cls._last_ai_message(response)
        if message is None:
            return None
        tool_calls = getattr(message, "tool_calls", None) or []
        if not tool_calls:
            return None
        names = {
            tool_call.get("name")
            for tool_call in tool_calls
            if isinstance(tool_call, dict)
        }
        if names != {_ARTIFACT_TOOL_NAME}:
            return None
        if cls._message_visible_text(message).strip():
            return None
        return message

    @staticmethod
    def _is_conversational_turn(request: Any) -> bool:
        """True when the latest user text is NOT an explicit document command
        — the same signal ``BuilderCommandMiddleware`` routes on. Direct
        document commands never reach the model call (that middleware
        short-circuits them), so this is a defensive re-check; explicit
        artifact/build requests that DO reach the model answer with
        ``start_builder_task`` and never enter the prose retry at all."""
        try:
            messages = getattr(request, "messages", None) or []
            user_text = extract_last_message_text(messages) if messages else ""
            if not user_text:
                return True
            return _build_direct_document_task(user_text) is None
        except Exception:
            return True

    @classmethod
    def _is_light_conversational_turn(cls, request: Any) -> bool:
        """True only for plain conversational turns that can take the
        lightweight tool-free fallback path:

        - the latest message is direct user input (mid-loop continuations
          after tool results keep the full tool set),
        - the user text carries no build/artifact/edit/review intent
          (explicit requests must still reach ``start_builder_task``),
        - and no builder task is in flight (``async_tasks`` non-empty means
          the user may be asking about the build — keep BuildAwareness).
        """
        try:
            messages = getattr(request, "messages", None) or []
            if not messages:
                return False
            if getattr(messages[-1], "type", None) not in {"human", "user"}:
                return False
            state = getattr(request, "state", None) or {}
            if state.get("async_tasks"):
                return False
            user_text = extract_last_message_text(messages)
            if not user_text:
                return False
            if _BUILD_INTENT_RE.search(user_text):
                return False
            return _build_direct_document_task(user_text) is None
        except Exception:
            return False

    @staticmethod
    def _light_conversational_request(request: Any, fallback_model: Any) -> Any:
        """Tool-free fallback request for a plain conversational turn.

        Strips Builder/artifact handoff guidance from ``system_prompt_blocks``
        (PromptAssemblyMiddleware reads them from ``request.state``), keeps
        identity/memory/tone context, appends the conversational instruction,
        and disables every tool for this single call.
        """
        state = getattr(request, "state", None) or {}
        blocks = list(state.get("system_prompt_blocks", []) or [])
        light_blocks = [
            block
            for block in blocks
            if isinstance(block, str)
            and not any(marker in block.lower() for marker in _HEAVY_BLOCK_MARKERS)
        ]
        light_blocks.append(_CONVERSATIONAL_LIGHT_INSTRUCTION)
        overrides: dict[str, Any] = {
            "model": fallback_model,
            "tools": [],
            "tool_choice": None,
            "system_message": SystemMessage(content=_CONVERSATIONAL_LIGHT_INSTRUCTION),
        }
        if isinstance(state, dict) and state:
            overrides["state"] = {**state, "system_prompt_blocks": light_blocks}
        return request.override(**overrides)

    @staticmethod
    def _prose_retry_request(request: Any, fallback_model: Any) -> Any:
        base_prompt = getattr(request, "system_prompt", None)
        instruction = (
            f"{base_prompt}\n\n{_PROSE_RETRY_INSTRUCTION}"
            if base_prompt
            else _PROSE_RETRY_INSTRUCTION
        )
        return request.override(
            model=fallback_model,
            tools=[],
            tool_choice=None,
            system_message=SystemMessage(content=instruction),
        )

    @classmethod
    def _merge_prose_into_response(
        cls, response: Any, original_message: Any, prose_response: Any
    ) -> bool:
        """Merge the prose retry's text with the original emit_artifact tool
        call(s) into one AIMessage (the shape Anthropic produces). Returns
        True when the response was updated; False when the retry yielded no
        usable text (response stays untouched — no synthesized text)."""
        prose_message = cls._last_ai_message(prose_response)
        if prose_message is None:
            return False
        prose_text = cls._message_visible_text(prose_message).strip()
        if not prose_text:
            return False
        merged = AIMessage(
            content=prose_text,
            tool_calls=list(getattr(original_message, "tool_calls", None) or []),
            id=getattr(original_message, "id", None),
        )
        result = getattr(response, "result", None)
        if isinstance(result, list) and result:
            result[-1] = merged
            return True
        return False

    def _run_prose_retry_sync(self, request: Any, fallback_model: Any, response: Any, original_message: Any, handler: Any, error_class: str) -> str:
        """Sync prose retry. Returns ``success`` or ``failed``."""
        try:
            prose_response = handler(self._prose_retry_request(request, fallback_model))
        except Exception:
            self._log_prose_retry(error_class, "failed")
            return "failed"
        merged = self._merge_prose_into_response(response, original_message, prose_response)
        outcome = "success" if merged else "failed"
        self._log_prose_retry(error_class, outcome)
        return outcome

    async def _run_prose_retry_async(self, request: Any, fallback_model: Any, response: Any, original_message: Any, handler: Any, error_class: str) -> str:
        """Async prose retry. Returns ``success`` or ``failed``."""
        try:
            prose_response = await handler(self._prose_retry_request(request, fallback_model))
        except Exception:
            self._log_prose_retry(error_class, "failed")
            return "failed"
        merged = self._merge_prose_into_response(response, original_message, prose_response)
        outcome = "success" if merged else "failed"
        self._log_prose_retry(error_class, outcome)
        return outcome

    @staticmethod
    def _log_prose_retry(error_class: str, outcome: str) -> None:
        logger.warning(
            "[CompanionProviderFallback] tool-free prose retry finished "
            "provider_error_class=%s "
            "companionFallbackConversationalTurn=true "
            "companionFallbackProseRetryAttempted=true "
            "companionFallbackProseRetryResult=%s "
            "companionFallbackToolOnlySuppressed=%s "
            "rawProviderPayloadExcluded=true providerSecretsExcluded=true",
            error_class,
            outcome,
            "true" if outcome == "success" else "false",
        )

    @staticmethod
    def _success_response(
        response: Any,
        error_class: str,
        *,
        conversational_turn: bool = False,
        prose_retry_attempted: bool = False,
        prose_retry_result: str = "not_needed",
        primary_bypassed: bool = False,
        conversational_light_path: bool = False,
    ) -> ExtendedModelResponse:
        is_empty = CompanionProviderFallbackMiddleware._response_is_empty(response)
        fallback_result = "empty_response" if is_empty else "success"
        snapshot = companion_provider_fallback_snapshot(
            error_class=error_class,
            fallback_attempted=True,
            fallback_result=fallback_result,
            conversational_turn=conversational_turn,
            tool_only_suppressed=prose_retry_result == "success",
            prose_retry_attempted=prose_retry_attempted,
            prose_retry_result=prose_retry_result,
            primary_bypassed=primary_bypassed,
            bypass_reason=_bypass_reason(error_class) if primary_bypassed else None,
            conversational_light_path=conversational_light_path,
            conversational_tools_disabled=conversational_light_path,
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

    def _log_primary_bypassed(self, error_class: str) -> None:
        logger.warning(
            "[CompanionProviderFallback] primary provider cooldown active — "
            "calling OpenAI fallback directly "
            "provider_error_class=%s "
            "companionFallbackPrimaryBypassed=true "
            "companionFallbackBypassReason=%s "
            "rawProviderPayloadExcluded=true providerSecretsExcluded=true",
            error_class,
            _bypass_reason(error_class),
        )

    def _log_light_path(self, error_class: str) -> None:
        logger.warning(
            "[CompanionProviderFallback] conversational turn — using the "
            "lightweight tool-free fallback path "
            "provider_error_class=%s "
            "companionConversationalLightPath=true "
            "companionConversationalToolsDisabled=true "
            "companionVisibleTextRequired=true "
            "rawProviderPayloadExcluded=true providerSecretsExcluded=true",
            error_class,
        )

    def _invoke_fallback_sync(self, request, handler, fallback_model, error_class: str, *, primary_bypassed: bool):
        """One OpenAI fallback invocation (sync). Exceptions propagate."""
        if self._is_light_conversational_turn(request):
            self._log_light_path(error_class)
            response = handler(self._light_conversational_request(request, fallback_model))
            return self._success_response(
                response,
                error_class,
                conversational_turn=True,
                primary_bypassed=primary_bypassed,
                conversational_light_path=True,
            )

        response = handler(request.override(model=fallback_model))
        conversational_turn = False
        prose_retry_attempted = False
        prose_retry_result = "not_needed"
        artifact_only = self._artifact_only_message(response)
        if artifact_only is not None and self._is_conversational_turn(request):
            conversational_turn = True
            prose_retry_attempted = True
            self._log_prose_retry_start(error_class)
            prose_retry_result = self._run_prose_retry_sync(
                request, fallback_model, response, artifact_only, handler, error_class
            )
        return self._success_response(
            response,
            error_class,
            conversational_turn=conversational_turn,
            prose_retry_attempted=prose_retry_attempted,
            prose_retry_result=prose_retry_result,
            primary_bypassed=primary_bypassed,
        )

    async def _invoke_fallback_async(self, request, handler, fallback_model, error_class: str, *, primary_bypassed: bool):
        """One OpenAI fallback invocation (async). Exceptions propagate."""
        if self._is_light_conversational_turn(request):
            self._log_light_path(error_class)
            response = await handler(self._light_conversational_request(request, fallback_model))
            return self._success_response(
                response,
                error_class,
                conversational_turn=True,
                primary_bypassed=primary_bypassed,
                conversational_light_path=True,
            )

        response = await handler(request.override(model=fallback_model))
        conversational_turn = False
        prose_retry_attempted = False
        prose_retry_result = "not_needed"
        artifact_only = self._artifact_only_message(response)
        if artifact_only is not None and self._is_conversational_turn(request):
            conversational_turn = True
            prose_retry_attempted = True
            self._log_prose_retry_start(error_class)
            prose_retry_result = await self._run_prose_retry_async(
                request, fallback_model, response, artifact_only, handler, error_class
            )
        return self._success_response(
            response,
            error_class,
            conversational_turn=conversational_turn,
            prose_retry_attempted=prose_retry_attempted,
            prose_retry_result=prose_retry_result,
            primary_bypassed=primary_bypassed,
        )

    @staticmethod
    def _log_prose_retry_start(error_class: str) -> None:
        logger.warning(
            "[CompanionProviderFallback] OpenAI fallback returned an "
            "emit_artifact-only message with no visible text on a "
            "conversational turn — retrying once without tools for prose "
            "provider_error_class=%s "
            "companionFallbackConversationalTurn=true "
            "companionFallbackProseRetryAttempted=true "
            "rawProviderPayloadExcluded=true providerSecretsExcluded=true",
            error_class,
        )

    def _cooldown_fallback_model_or_none(self) -> tuple[str, Any] | None:
        """(error_class, model) when the primary cooldown applies, else None.

        The cooldown only short-circuits the primary attempt while the
        fallback is enabled AND configured — otherwise every turn retries
        Anthropic exactly as before.
        """
        error_class = _active_primary_cooldown_error_class()
        if error_class is None:
            return None
        if not (fallback_enabled() and openai_api_key_present() and fallback_model_name()):
            return None
        try:
            return error_class, build_fallback_chat_model()
        except Exception:
            return None

    def wrap_model_call(self, request, handler):  # type: ignore[override]
        cooldown = self._cooldown_fallback_model_or_none()
        if cooldown is not None:
            cooldown_error_class, fallback_model = cooldown
            self._log_primary_bypassed(cooldown_error_class)
            try:
                return self._invoke_fallback_sync(
                    request, handler, fallback_model, cooldown_error_class, primary_bypassed=True
                )
            except Exception:
                # The fallback itself failed during the cooldown — clear it so
                # the next turn retries the primary provider normally.
                _clear_primary_cooldown()
                self._log_fallback_failed(cooldown_error_class)
                raise
        try:
            response = handler(request)
        except Exception as primary_exc:
            error_class = classify_provider_error(primary_exc)
            if error_class is None:
                raise
            fallback_model = self._fallback_model_or_none(error_class)
            if fallback_model is None:
                raise
            _set_primary_cooldown(error_class)
            logger.warning(
                "[CompanionProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                return self._invoke_fallback_sync(
                    request, handler, fallback_model, error_class, primary_bypassed=False
                )
            except Exception as fallback_exc:
                self._log_fallback_failed(error_class)
                raise fallback_exc from primary_exc
        _clear_primary_cooldown()
        return response

    async def awrap_model_call(self, request, handler):  # type: ignore[override]
        cooldown = self._cooldown_fallback_model_or_none()
        if cooldown is not None:
            cooldown_error_class, fallback_model = cooldown
            self._log_primary_bypassed(cooldown_error_class)
            try:
                return await self._invoke_fallback_async(
                    request, handler, fallback_model, cooldown_error_class, primary_bypassed=True
                )
            except Exception:
                # The fallback itself failed during the cooldown — clear it so
                # the next turn retries the primary provider normally.
                _clear_primary_cooldown()
                self._log_fallback_failed(cooldown_error_class)
                raise
        try:
            response = await handler(request)
        except Exception as primary_exc:
            error_class = classify_provider_error(primary_exc)
            if error_class is None:
                raise
            fallback_model = self._fallback_model_or_none(error_class)
            if fallback_model is None:
                raise
            _set_primary_cooldown(error_class)
            logger.warning(
                "[CompanionProviderFallback] retrying once via OpenAI "
                "provider_error_class=%s fallback_attempted=true",
                error_class,
            )
            try:
                return await self._invoke_fallback_async(
                    request, handler, fallback_model, error_class, primary_bypassed=False
                )
            except Exception as fallback_exc:
                self._log_fallback_failed(error_class)
                raise fallback_exc from primary_exc
        _clear_primary_cooldown()
        return response
