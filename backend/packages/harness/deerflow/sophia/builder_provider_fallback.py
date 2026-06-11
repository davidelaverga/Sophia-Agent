"""Builder OpenAI provider-fallback policy (config + classification).

Anthropic remains the Builder's default and only primary provider. When the
primary model call fails with a *provider-availability* class of error
(auth / payment / quota / rate-limit / unreachable / 5xx), the Builder may
retry ONCE through an OpenAI model — but only when the operator explicitly
enabled the fallback AND configured both the fallback model name and
``OPENAI_API_KEY``. With the flag off (the default) behavior is exactly
today's: the original exception propagates unchanged, plus one structured
log line explaining why no fallback ran.

This module is pure policy: env readers, error classification, the
sanitized diagnostics snapshot, and the lazy ``ChatOpenAI`` factory. The
agent-side wiring lives in
``deerflow.agents.sophia_agent.middlewares.builder_provider_fallback``.

Safety invariants:

- API keys are never read into diagnostics, never logged, never returned —
  only boolean presence checks.
- ``provider_error_safe_message`` is always a fixed template string keyed by
  the classified error class; raw provider response bodies never enter the
  snapshot.
- Classification is a strict positive match on Anthropic SDK exception types
  (with a generic ``status_code`` fallback for test doubles). Anything not
  positively matched — prompt validation, tool bugs, LangGraph control-flow
  exceptions, safety refusals (which are responses, not exceptions),
  cancellations (``BaseException``) — is NOT fallback-eligible.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "FALLBACK_ENABLED_ENV",
    "FALLBACK_MAX_RETRIES_ENV",
    "FALLBACK_MODEL_ENV",
    "FALLBACK_TIMEOUT_ENV",
    "PRIMARY_PROVIDER",
    "FALLBACK_PROVIDER",
    "build_fallback_chat_model",
    "classify_provider_error",
    "fallback_enabled",
    "fallback_max_retries",
    "fallback_model_name",
    "fallback_timeout_seconds",
    "is_openai_chat_model",
    "model_provider_label",
    "normalize_tool_choice_for_model",
    "openai_api_key_present",
    "provider_fallback_failure_diagnostic",
    "provider_fallback_snapshot",
    "safe_provider_error_message",
]

PRIMARY_PROVIDER = "anthropic"
FALLBACK_PROVIDER = "openai"

FALLBACK_ENABLED_ENV = "SOPHIA_BUILDER_OPENAI_FALLBACK_ENABLED"
FALLBACK_MODEL_ENV = "SOPHIA_BUILDER_OPENAI_FALLBACK_MODEL"
FALLBACK_TIMEOUT_ENV = "SOPHIA_BUILDER_OPENAI_FALLBACK_TIMEOUT_SECONDS"
FALLBACK_MAX_RETRIES_ENV = "SOPHIA_BUILDER_OPENAI_FALLBACK_MAX_RETRIES"
_OPENAI_KEY_ENV = "OPENAI_API_KEY"

_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Anthropic returns "Your credit balance is too low ..." as a 400
# BadRequestError (invalid_request_error), NOT a 402/403/429. This is a
# billing/quota outage masquerading as a validation error. These tokens are
# Anthropic *billing-system* strings (never user prompt content); they are
# read ONLY to decide fallback eligibility and never enter the diagnostics
# snapshot (a fixed safe template is used instead).
_BILLING_SIGNAL_TOKENS = (
    "credit balance",
    "plans & billing",
    "purchase credits",
    "billing",
    "payment required",
)

# Classified error class → fixed, safe message template. NEVER interpolate
# raw exception text here — provider bodies can echo prompts or headers.
_SAFE_MESSAGES: dict[str, str] = {
    "auth_error": "Primary model provider rejected the API key (authentication failure).",
    "permission_or_payment_error": "Primary model provider denied access (permission, billing, or payment issue).",
    "rate_limit_or_quota": "Primary model provider rate limit or quota was exceeded.",
    "provider_unreachable": "Primary model provider could not be reached (connection failure).",
    "provider_unavailable": "Primary model provider returned a server error or is overloaded.",
}


def fallback_enabled() -> bool:
    """True only when the operator explicitly enabled the OpenAI fallback."""
    return os.environ.get(FALLBACK_ENABLED_ENV, "").strip().lower() in _TRUTHY


def fallback_model_name() -> str | None:
    """The configured OpenAI fallback model name, or None when unset."""
    value = os.environ.get(FALLBACK_MODEL_ENV, "").strip()
    return value or None


def fallback_timeout_seconds() -> float:
    raw = os.environ.get(FALLBACK_TIMEOUT_ENV, "").strip()
    try:
        value = float(raw)
    except ValueError:
        return 120.0
    return value if value > 0 else 120.0


def fallback_max_retries() -> int:
    raw = os.environ.get(FALLBACK_MAX_RETRIES_ENV, "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 1
    return value if value >= 0 else 1


def openai_api_key_present() -> bool:
    """Boolean presence check only — the value is never read out of env."""
    return bool(os.environ.get(_OPENAI_KEY_ENV, "").strip())


def _has_billing_signal(exc: BaseException) -> bool:
    """True when the exception carries an Anthropic billing/credit signal.

    Used solely to classify Anthropic's "credit balance is too low" 400 (a
    billing outage delivered as ``BadRequestError``) as fallback-eligible.
    Both the exception message and the structured ``.body`` error message
    are inspected ONLY for this decision — neither is stored, logged, or
    placed in the diagnostics snapshot. Generic 400s (real prompt/validation
    failures) carry none of these billing-system tokens and stay
    non-eligible.
    """
    fragments: list[str] = []

    message = getattr(exc, "message", None)
    fragments.append(message if isinstance(message, str) else str(exc))

    # Anthropic SDK errors expose the parsed JSON body; the billing text lives
    # under body["error"]["message"]. Read the structured field directly
    # rather than relying on string formatting of the exception.
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            err_message = error.get("message")
            if isinstance(err_message, str):
                fragments.append(err_message)
        elif isinstance(error, str):
            fragments.append(error)

    text = " ".join(fragments).lower()
    return any(token in text for token in _BILLING_SIGNAL_TOKENS)


def classify_provider_error(exc: BaseException) -> str | None:
    """Return a provider-availability error class, or None if not eligible.

    Positive-match only. Returning None means "this is not a provider
    availability problem — do NOT fall back, re-raise unchanged". That
    automatically excludes prompt/validation errors (400 without a billing
    signal), tool execution bugs, LangGraph interrupts, safety refusals
    (normal responses, not exceptions), and cancellations (``BaseException``,
    not ``Exception``).
    """
    if not isinstance(exc, Exception):
        return None

    try:
        import anthropic
    except Exception:  # pragma: no cover — anthropic ships with langchain-anthropic
        anthropic = None  # type: ignore[assignment]

    if anthropic is not None:
        anthropic_class = _classify_anthropic_error(anthropic, exc)
        if anthropic_class is not _UNMATCHED:
            return anthropic_class

    return _classify_by_status_code(getattr(exc, "status_code", None))


# Sentinel distinguishing "Anthropic branch decided None (do not fall back)"
# from "not an Anthropic exception — try the generic status-code shape".
_UNMATCHED = object()

_STATUS_CODE_CLASSES: tuple[tuple[tuple[int, ...], str], ...] = (
    ((401,), "auth_error"),
    ((402, 403), "permission_or_payment_error"),
    ((429,), "rate_limit_or_quota"),
)


def _classify_anthropic_error(anthropic: Any, exc: Exception) -> Any:
    """Classify Anthropic SDK exceptions; ``_UNMATCHED`` when not one."""
    # Order matters: RateLimitError etc. subclass APIStatusError.
    typed: tuple[tuple[type, str], ...] = (
        (anthropic.AuthenticationError, "auth_error"),
        (anthropic.PermissionDeniedError, "permission_or_payment_error"),
        (anthropic.RateLimitError, "rate_limit_or_quota"),
        (anthropic.APIConnectionError, "provider_unreachable"),
    )
    for exc_type, error_class in typed:
        if isinstance(exc, exc_type):
            return error_class
    # Narrow billing-400: Anthropic delivers "credit balance is too low"
    # as a BadRequestError (400). Treat ONLY the billing variant as a
    # payment outage; generic 400s still fall through to None below.
    if isinstance(exc, anthropic.BadRequestError) and _has_billing_signal(exc):
        return "permission_or_payment_error"
    if isinstance(exc, anthropic.APIStatusError):
        status = getattr(exc, "status_code", None)
        if isinstance(status, int) and status >= 500:
            return "provider_unavailable"
        return None
    return _UNMATCHED


def _classify_by_status_code(status: Any) -> str | None:
    """Generic shape match (test doubles, httpx-style errors) — never message-text sniffing."""
    if not isinstance(status, int):
        return None
    for codes, error_class in _STATUS_CODE_CLASSES:
        if status in codes:
            return error_class
    if status >= 500:
        return "provider_unavailable"
    return None


def safe_provider_error_message(error_class: str | None) -> str:
    return _SAFE_MESSAGES.get(
        error_class or "",
        "Primary model provider call failed before a response was produced.",
    )


def is_openai_chat_model(model: Any) -> bool:
    """True when ``model`` is an OpenAI(-compatible) LangChain chat model.

    Detection walks the class MRO and matches ``ChatOpenAI`` (and subclasses
    such as ``AzureChatOpenAI``, which use the identical OpenAI
    ``/chat/completions`` ``tool_choice`` schema) without importing
    ``langchain_openai`` eagerly. Anthropic and every other provider return
    ``False`` so their native ``tool_choice`` shape is preserved untouched.

    Only the class identity is inspected — never any client/key attribute —
    so no secret material is read.
    """
    try:
        mro = type(model).__mro__
    except Exception:  # pragma: no cover - exotic/mock objects without a real type
        return False
    for klass in mro:
        name = getattr(klass, "__name__", "")
        module = getattr(klass, "__module__", "") or ""
        if name == "ChatOpenAI" or module.startswith("langchain_openai"):
            return True
    return False


def model_provider_label(model: Any) -> str:
    """Coarse provider label for safe logging only (no payloads/keys)."""
    return FALLBACK_PROVIDER if is_openai_chat_model(model) else PRIMARY_PROVIDER


# Fixed token used ONLY to classify the OpenAI "missing tool_choice.function"
# 400 into a stable, safe failure code. Like ``_BILLING_SIGNAL_TOKENS`` this is
# a provider *schema* marker (never user prompt content); it is read for the
# classification decision only and never logged or stored.
_TOOL_CHOICE_FUNCTION_PARAM = "tool_choice.function"


def _is_tool_choice_function_error(exc: BaseException) -> bool:
    """True when an OpenAI fallback 400 is the missing ``tool_choice.function``
    schema error (Anthropic-shaped forced tool choice reaching OpenAI).

    Inspects only the structured ``.param`` attribute and the SDK ``.body``
    error param — never raw bodies, prompts, or headers — mirroring the
    decision-only inspection used by ``_has_billing_signal``.
    """
    param = getattr(exc, "param", None)
    if isinstance(param, str) and param == _TOOL_CHOICE_FUNCTION_PARAM:
        return True
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and error.get("param") == _TOOL_CHOICE_FUNCTION_PARAM:
            return True
    return False


def provider_fallback_failure_diagnostic(exc: BaseException) -> dict[str, str]:
    """Sanitized, allowlisted diagnostic fields for a failed OpenAI fallback.

    Returns ONLY fixed strings + booleans for safe structured logging. No raw
    provider payload, exception body, prompt text, key material, or signed URL
    is ever read into the result. The ``tool_choice.function`` schema error is
    classified into a stable code so dashboards can distinguish it from a
    generic fallback failure.
    """
    if _is_tool_choice_function_error(exc):
        failure_code = "builder_openai_tool_choice_invalid"
        error_class = "bad_request_tool_choice"
    else:
        failure_code = "builder_provider_fallback_failed"
        error_class = "provider_fallback_failed"
    return {
        "builder_failure_stage": "provider_fallback",
        "builder_failure_code": failure_code,
        "builder_provider_error_class": error_class,
        "builder_fallback_attempted": "true",
        "builder_fallback_result": "fallback_failed",
        "raw_provider_payload_excluded": "true",
        "provider_secrets_excluded": "true",
    }


def normalize_tool_choice_for_model(model: Any, tool_choice: Any) -> Any:
    """Translate a forced ``tool_choice`` payload to the model provider's shape.

    The Builder authors its forced tool choices in Anthropic's native shape
    ``{"type": "tool", "name": <tool>}``. ``langchain-anthropic`` accepts that
    verbatim. When the provider fallback swaps the bound model to
    ``ChatOpenAI`` mid-run, that SAME payload reaches OpenAI's
    ``/chat/completions``, which requires
    ``{"type": "function", "function": {"name": <tool>}}`` and rejects the
    Anthropic shape with ``Missing required parameter: 'tool_choice.function'``.

    This is a pure, provider-keyed *shape* translation: it never changes WHICH
    tool is forced (research stays forced, ``builder_web_search`` stays
    ``builder_web_search``), only the provider-specific envelope. Inputs that
    are not an Anthropic forced-tool dict — string sentinels like ``"auto"`` /
    ``"required"`` / ``"none"``, OpenAI-shaped dicts, or anything unrecognized —
    are returned unchanged, as is any payload when the model is not OpenAI.
    """
    if not isinstance(tool_choice, dict):
        return tool_choice
    if tool_choice.get("type") != "tool":
        return tool_choice
    name = tool_choice.get("name")
    if not isinstance(name, str) or not name:
        return tool_choice
    if not is_openai_chat_model(model):
        return tool_choice
    return {"type": "function", "function": {"name": name}}


def provider_fallback_snapshot(
    *,
    error_class: str,
    fallback_attempted: bool,
    fallback_result: str,
) -> dict[str, Any]:
    """Sanitized snapshot for state + diagnostics. Allowlisted fields only.

    ``fallback_result`` is one of ``success`` / ``fallback_failed`` /
    ``fallback_disabled`` / ``fallback_not_configured``. No key material,
    raw payloads, model URLs, or exception text ever enter this dict.
    """
    return {
        "primary_provider": PRIMARY_PROVIDER,
        "fallback_provider": FALLBACK_PROVIDER,
        "fallback_enabled": fallback_enabled(),
        "fallback_attempted": bool(fallback_attempted),
        "fallback_reason": error_class,
        "fallback_result": fallback_result,
        "fallback_model_configured": fallback_model_name() is not None,
        "provider_error_class": error_class,
        "provider_error_safe_message": safe_provider_error_message(error_class),
        "raw_provider_payload_excluded": True,
        "provider_secrets_excluded": True,
    }


def build_fallback_chat_model():
    """Construct the OpenAI fallback chat model (lazy import).

    Mirrors the Anthropic builder model's streaming/timeout/retry settings:
    streaming keeps the connection alive during long generations (same
    read-timeout rationale documented in ``builder_agent.py``).
    """
    from langchain_openai import ChatOpenAI

    model_name = fallback_model_name()
    if not model_name:
        raise RuntimeError(
            "Builder OpenAI fallback model is not configured "
            f"(set {FALLBACK_MODEL_ENV})."
        )
    return ChatOpenAI(
        model=model_name,
        streaming=True,
        timeout=fallback_timeout_seconds(),
        max_retries=fallback_max_retries(),
    )
