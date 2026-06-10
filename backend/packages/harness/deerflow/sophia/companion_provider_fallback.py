"""Companion OpenAI provider-fallback policy (config + diagnostics).

Anthropic remains the Sophia *companion's* default and only primary provider.
When the companion's primary model call fails with a *provider-availability*
class of error (auth / payment / quota / rate-limit / unreachable / 5xx, plus
Anthropic's "credit balance is too low" billing-400), the companion may retry
ONCE through an OpenAI model — but only when the operator explicitly enabled
the companion fallback AND configured both the fallback model name and
``OPENAI_API_KEY``. With the flag off (the default) behavior is exactly
today's: the original exception propagates unchanged, plus one structured log
line explaining why no fallback ran.

This is the companion sibling of ``deerflow.sophia.builder_provider_fallback``.
The two share the provider-error *classifier* and the fixed safe-message
templates (imported below) but keep **separate** env namespaces
(``SOPHIA_COMPANION_OPENAI_FALLBACK_*`` vs ``SOPHIA_BUILDER_OPENAI_FALLBACK_*``)
and a **separate** diagnostics snapshot (``companion_*`` keys) so the two
provider paths stay independent in config and telemetry.

Safety invariants (identical to the Builder module):

- API keys are never read into diagnostics, never logged, never returned —
  only boolean presence checks.
- ``companion_provider_error_safe_message`` is always a fixed template string
  keyed by the classified error class; raw provider response bodies never
  enter the snapshot.
- Classification is the shared strict positive match on Anthropic SDK
  exception types. Anything not positively matched — prompt validation, tool
  bugs, ``start_builder_task`` / ``emit_*`` product errors, LangGraph
  control-flow exceptions, safety refusals, cancellations — is NOT
  fallback-eligible.
"""

from __future__ import annotations

import logging
import os
from typing import Any

# Shared, provider-level classifier + safe-message templates. Reused as-is so
# the companion and Builder classify provider outages identically.
from deerflow.sophia.builder_provider_fallback import (
    classify_provider_error,
    safe_provider_error_message,
)

logger = logging.getLogger(__name__)

__all__ = [
    "FALLBACK_ENABLED_ENV",
    "FALLBACK_MAX_RETRIES_ENV",
    "FALLBACK_MODEL_ENV",
    "FALLBACK_TIMEOUT_ENV",
    "PRIMARY_COOLDOWN_ENV",
    "PRIMARY_PROVIDER",
    "FALLBACK_PROVIDER",
    "build_fallback_chat_model",
    "classify_provider_error",
    "companion_provider_fallback_snapshot",
    "fallback_enabled",
    "fallback_max_retries",
    "fallback_model_name",
    "fallback_timeout_seconds",
    "openai_api_key_present",
    "primary_cooldown_seconds",
    "safe_provider_error_message",
]

PRIMARY_PROVIDER = "anthropic"
FALLBACK_PROVIDER = "openai"

FALLBACK_ENABLED_ENV = "SOPHIA_COMPANION_OPENAI_FALLBACK_ENABLED"
FALLBACK_MODEL_ENV = "SOPHIA_COMPANION_OPENAI_FALLBACK_MODEL"
FALLBACK_TIMEOUT_ENV = "SOPHIA_COMPANION_OPENAI_FALLBACK_TIMEOUT_SECONDS"
FALLBACK_MAX_RETRIES_ENV = "SOPHIA_COMPANION_OPENAI_FALLBACK_MAX_RETRIES"
PRIMARY_COOLDOWN_ENV = "SOPHIA_COMPANION_PRIMARY_COOLDOWN_SECONDS"
_OPENAI_KEY_ENV = "OPENAI_API_KEY"

_PRIMARY_COOLDOWN_DEFAULT_SECONDS = 300.0

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def fallback_enabled() -> bool:
    """True only when the operator explicitly enabled the companion fallback."""
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


def primary_cooldown_seconds() -> float:
    """TTL of the temporary primary-provider-unavailable cooldown.

    After a classified Anthropic availability failure, companion turns within
    this window skip the doomed primary attempt and go straight to the OpenAI
    fallback (only while the fallback is enabled AND configured). ``0``
    disables the cooldown entirely — every turn retries Anthropic first.
    """
    raw = os.environ.get(PRIMARY_COOLDOWN_ENV, "").strip()
    try:
        value = float(raw)
    except ValueError:
        return _PRIMARY_COOLDOWN_DEFAULT_SECONDS
    return value if value >= 0 else _PRIMARY_COOLDOWN_DEFAULT_SECONDS


def companion_provider_fallback_snapshot(
    *,
    error_class: str,
    fallback_attempted: bool,
    fallback_result: str,
    conversational_turn: bool = False,
    tool_only_suppressed: bool = False,
    prose_retry_attempted: bool = False,
    prose_retry_result: str = "not_needed",
    primary_bypassed: bool = False,
    bypass_reason: str | None = None,
    conversational_light_path: bool = False,
    conversational_tools_disabled: bool = False,
) -> dict[str, Any]:
    """Sanitized snapshot for state + diagnostics. Allowlisted fields only.

    ``fallback_result`` is one of ``success`` / ``empty_response`` /
    ``fallback_failed`` / ``fallback_disabled`` / ``fallback_not_configured``.
    ``prose_retry_result`` is one of ``success`` / ``failed`` / ``not_needed``
    — set when the fallback returned an emit_artifact-only message with no
    visible text on a conversational turn and a tool-free prose retry ran.
    No key material, raw payloads, model URLs, or exception text ever enter
    this dict. The keys are ``companion_*``-prefixed so companion telemetry is
    distinct from the Builder's ``builder_provider_fallback`` snapshot.
    """
    return {
        "companion_primary_provider": PRIMARY_PROVIDER,
        "companion_fallback_provider": FALLBACK_PROVIDER,
        "companion_fallback_enabled": fallback_enabled(),
        "companion_fallback_attempted": bool(fallback_attempted),
        "companion_fallback_reason": error_class,
        "companion_fallback_result": fallback_result,
        "companion_fallback_model_configured": fallback_model_name() is not None,
        "companion_fallback_conversational_turn": bool(conversational_turn),
        "companion_fallback_tool_only_suppressed": bool(tool_only_suppressed),
        "companion_fallback_prose_retry_attempted": bool(prose_retry_attempted),
        "companion_fallback_prose_retry_result": prose_retry_result,
        "companion_fallback_primary_bypassed": bool(primary_bypassed),
        "companion_fallback_bypass_reason": bypass_reason,
        "companion_conversational_light_path": bool(conversational_light_path),
        "companion_conversational_tools_disabled": bool(conversational_tools_disabled),
        "companion_provider_error_class": error_class,
        "companion_provider_error_safe_message": safe_provider_error_message(error_class),
        "raw_provider_payload_excluded": True,
        "provider_secrets_excluded": True,
    }


def build_fallback_chat_model():
    """Construct the OpenAI fallback chat model (lazy import).

    The fallback model intentionally does NOT set ``streaming=True`` — it
    mirrors the companion *primary* ``ChatAnthropic`` (see
    ``sophia_agent/agent.py``), which also omits the flag. This is load-bearing
    for the live UI: under LangGraph 0.8's ``StreamMessagesHandlerV2`` the v1
    ``on_llm_new_token`` callback is an intentional no-op, so a model invoked
    with explicit ``streaming=True`` drives its own ``.stream()`` path and its
    tokens are dropped from the ``stream_mode="messages"`` (messages-tuple)
    output the frontend renders. A model WITHOUT the flag is steered by
    LangGraph through the v2 event path (``on_stream_event``), which forwards
    content onto the messages stream — the same way the primary Anthropic call
    surfaces text. Setting ``streaming=True`` here made successful OpenAI
    fallbacks persist to state but never appear in the live session UI.

    Timeout and retry come from the companion env namespace.
    """
    from langchain_openai import ChatOpenAI

    model_name = fallback_model_name()
    if not model_name:
        raise RuntimeError(
            "Companion OpenAI fallback model is not configured "
            f"(set {FALLBACK_MODEL_ENV})."
        )
    return ChatOpenAI(
        model=model_name,
        timeout=fallback_timeout_seconds(),
        max_retries=fallback_max_retries(),
    )
