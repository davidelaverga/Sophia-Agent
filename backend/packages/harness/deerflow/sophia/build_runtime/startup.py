from __future__ import annotations

import hmac
import logging
import os
from collections.abc import Iterable
from typing import Any

import httpx

from deerflow.config.app_config import AppConfig
from deerflow.sophia.build_runtime.events import configure_default_event_sink_once
from deerflow.sophia.builder_event_auth import (
    BuilderEventAuthenticationError,
    builder_event_canary_scope_proof,
    encode_builder_event_body,
    probe_builder_event_auth,
    signed_builder_event_headers,
    verify_builder_event_probe_ack,
)
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.build_foundation_store import BuildFoundationStoreConfig, configured_build_foundation_store
from deerflow.sophia.supabase_project import validate_expected_supabase_project

logger = logging.getLogger(__name__)


class BuildFoundationStartupError(RuntimeError):
    pass


_DEFAULT_GATEWAY_URL = "http://localhost:8001"
_PRODUCER_FAILURE_SIGNAL_PATH = "/internal/deck-quality-producer-failures"
_FAILURE_SIGNAL_AUTH_PROBE_TIMEOUT_SECONDS = 0.75


def probe_deck_quality_failure_signal_gateway_auth(
    *,
    canary_user_ids: Iterable[str],
) -> None:
    """Prove shared HMAC authority and exact canary-set equality."""

    from deerflow.sophia.deck_quality.producer_failure_signal import (
        producer_failure_hmac_probe_signal,
    )

    signal = producer_failure_hmac_probe_signal(
        canary_scope_proof=builder_event_canary_scope_proof(
            canary_user_ids
        )
    )
    body = encode_builder_event_body(signal.model_dump(mode="json"))
    headers = signed_builder_event_headers(body)
    gateway_url = os.getenv(
        "SOPHIA_GATEWAY_URL",
        _DEFAULT_GATEWAY_URL,
    ).strip().rstrip("/")
    if not gateway_url:
        raise BuilderEventAuthenticationError(
            "builder_event_gateway_auth_unavailable"
        )
    try:
        with httpx.Client(
            timeout=httpx.Timeout(
                _FAILURE_SIGNAL_AUTH_PROBE_TIMEOUT_SECONDS
            )
        ) as client:
            response = client.post(
                f"{gateway_url}{_PRODUCER_FAILURE_SIGNAL_PATH}",
                content=body,
                headers=headers,
            )
    except (httpx.HTTPError, OSError, RuntimeError, ValueError):
        raise BuilderEventAuthenticationError(
            "builder_event_gateway_auth_unavailable"
        ) from None
    if response.status_code == 403:
        verify_builder_event_probe_ack(
            body,
            getattr(response, "headers", {}),
        )
        return
    if response.status_code == 401:
        raise BuilderEventAuthenticationError(
            "builder_event_gateway_auth_mismatch"
        )
    if response.status_code == 409:
        raise BuilderEventAuthenticationError(
            "builder_event_gateway_canary_scope_mismatch"
        )
    if response.status_code == 503:
        raise BuilderEventAuthenticationError(
            "builder_event_gateway_auth_unavailable"
        )
    raise BuilderEventAuthenticationError(
        "builder_event_gateway_auth_protocol_invalid"
    )


def audit_deck_quality_builder_service_startup(*, config: AppConfig) -> None:
    """Fail LangGraph startup closed on invalid DQ producer authority.

    This audit belongs to the service lifecycle, not a per-run builder graph
    factory. It may compile locked static inputs, inspect credential presence,
    validate storage configuration, and probe the authenticated gateway.
    """

    deck_quality = getattr(config, "deck_quality", None)
    if deck_quality is None or not deck_quality.enabled:
        return

    validate_expected_supabase_project()
    # The builder process owns the pre-delivery producer. Invalid locked
    # routes/prompts/instrument identities are a static service-startup error,
    # not a per-build shadow failure discovered after upload.
    from deerflow.sophia.deck_quality.instrument import (
        compile_runtime_instrument,
    )

    compile_runtime_instrument(config)
    try:
        probe_builder_event_auth()
    except BuilderEventAuthenticationError:
        raise BuildFoundationStartupError(
            "enabled deck quality producer requires builder-event authentication"
        ) from None
    try:
        probe_deck_quality_failure_signal_gateway_auth(
            canary_user_ids=deck_quality.canary_user_ids,
        )
    except BuilderEventAuthenticationError as exc:
        if exc.code == "builder_event_gateway_auth_mismatch":
            message = (
                "enabled deck quality producer and gateway builder-event "
                "authentication secrets do not match"
            )
        elif exc.code == "builder_event_gateway_canary_scope_mismatch":
            message = (
                "enabled deck quality producer and gateway exact canary "
                "scopes do not match"
            )
        else:
            message = (
                "enabled deck quality producer requires an available "
                "authenticated gateway failure-signal endpoint"
            )
        raise BuildFoundationStartupError(message) from None
    if not supabase_artifact_store.is_configured():
        raise BuildFoundationStartupError(
            "enabled deck quality producer requires durable object storage"
        )
    dq_provider_key = os.getenv(
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "",
    ).strip()
    if not dq_provider_key:
        raise BuildFoundationStartupError(
            "enabled deck quality judge requires its isolated provider credential"
        )
    baseline_provider_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not baseline_provider_key:
        raise BuildFoundationStartupError(
            "enabled deck quality judge requires the baseline builder provider credential"
        )
    credentials_match = hmac.compare_digest(
        dq_provider_key.encode("utf-8"),
        baseline_provider_key.encode("utf-8"),
    )
    allow_shared_provider_credential = bool(
        getattr(deck_quality, "allow_shared_provider_credential", False)
    )
    if credentials_match and not allow_shared_provider_credential:
        raise BuildFoundationStartupError(
            "deck quality and baseline builder provider credentials must be distinct"
        )
    if credentials_match:
        logger.warning(
            "Deck quality provider credential is operator-authorized for shared "
            "billing authority; DQ route and exact-canary isolation remain enabled "
            "credentialValueExcluded=true"
        )


def audit_build_foundation(*, tools: Iterable[Any], config: AppConfig) -> None:
    """Preserve the baseline per-factory build-foundation invariants."""

    validate_expected_supabase_project()
    foundation = config.build_foundation
    if not foundation.enabled:
        return
    prepare = next((tool for tool in tools if getattr(tool, "name", None) == "prepare_deck_build"), None)
    if prepare is not None:
        injected = set(getattr(prepare, "_injected_args_keys", frozenset()))
        if injected != {"runtime"}:
            raise BuildFoundationStartupError(
                f"prepare_deck_build runtime injection invariant failed: {sorted(injected)}"
            )
        schema = prepare.get_input_schema().model_json_schema()
        if "runtime" in (schema.get("properties") or {}):
            raise BuildFoundationStartupError("prepare_deck_build exposes runtime in model-facing schema")
    if foundation.manifest_mode == "enforce":
        if BuildFoundationStoreConfig.from_env() is None:
            raise BuildFoundationStartupError("manifest enforcement requires Supabase Postgres RPC configuration")
        if not supabase_artifact_store.is_configured():
            raise BuildFoundationStartupError("manifest enforcement requires durable object storage")
    if foundation.persist_event_journal:
        sink = configure_default_event_sink_once(configured_build_foundation_store)
        probe = getattr(sink, "probe", None)
        if callable(probe) and not probe():
            logger.error(
                "Build foundation startup readiness degraded: durable event table/RPC unavailable payloadExcluded=true"
            )
    enabled_routes = {
        name: route
        for name, route in config.model_routes.items()
        if name in {"deck.judge.visual", "deck.finding.localizer", "deck.repair.executor", "deck.repair.advisor"}
    }
    for route_name, route in enabled_routes.items():
        if config.get_model_deployment(route.primary) is None:
            raise BuildFoundationStartupError(f"model route {route_name} references missing deployment {route.primary}")
        if route.profile not in config.harness_profiles:
            raise BuildFoundationStartupError(f"model route {route_name} references missing profile {route.profile}")
