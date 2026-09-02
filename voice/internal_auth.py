"""Internal service authentication and synthetic capability enforcement."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping

from fastapi import HTTPException, Request

VOICE_INTERNAL_AUTH_HEADER = "X-Sophia-Voice-Internal-Auth"
VOICE_LAB_CAPABILITY_HEADER = "X-Sophia-Voice-Lab-Capability"

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SHA = re.compile(r"^[a-f0-9]{40}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_CLEANUP_OBLIGATION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_MAX_TTL_SECONDS = 300
_CLOCK_SKEW_SECONDS = 10
_MIN_RETENTION_HOURS = 1
_MAX_RETENTION_HOURS = 168


@dataclass(frozen=True)
class VoiceLabRuntimeClaims:
    principal_id: str
    test_run_id: str
    scenario_id: str | None
    scenario_version: str | None
    environment: str
    retention_hours: int
    cleanup_obligation_id: str
    provider_expires_at: str
    allowed_ops: tuple[str, ...]
    expected_deployment: dict[str, str]
    expires_at: int
    provider_session_id: str | None = None
    voice_lab_run_id_sha256: str | None = None
    browser_worker_id_sha256: str | None = None
    browser_lease_epoch: int | None = None
    browser_context_id_sha256: str | None = None

    def synthetic_context(self) -> dict[str, str | bool | int]:
        context: dict[str, str | bool | int] = {
            "synthetic": True,
            "principal_id": self.principal_id,
            "test_run_id": self.test_run_id,
            "environment": self.environment,
            "retention_hours": self.retention_hours,
            "cleanup_obligation_id": self.cleanup_obligation_id,
            "provider_expires_at": self.provider_expires_at,
        }
        if self.scenario_id:
            context["scenario_id"] = self.scenario_id
        if self.scenario_version:
            context["scenario_version"] = self.scenario_version
        if (
            self.voice_lab_run_id_sha256 is not None
            and self.browser_worker_id_sha256 is not None
            and self.browser_lease_epoch is not None
            and self.browser_context_id_sha256 is not None
        ):
            context.update(
                {
                    "voice_lab_run_id_sha256": self.voice_lab_run_id_sha256,
                    "browser_worker_id_sha256": self.browser_worker_id_sha256,
                    "browser_lease_epoch": self.browser_lease_epoch,
                    "browser_context_id_sha256": self.browser_context_id_sha256,
                }
            )
        return context


def _failure(code: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code})


def _is_true(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"


def _is_production_runtime() -> bool:
    return (
        _is_true(os.getenv("RENDER"))
        or bool(os.getenv("RENDER_SERVICE_ID"))
        or bool(os.getenv("RENDER_GIT_COMMIT"))
        or (os.getenv("ENVIRONMENT") or "").strip().lower() == "production"
    )


def require_voice_internal_auth(request: Request) -> None:
    configured_secret = (os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET") or "").strip()
    required = _is_production_runtime() or _is_true(os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_REQUIRED"))
    if not configured_secret:
        if required:
            raise _failure("voice_internal_auth_configuration_missing", 503)
        return
    if len(configured_secret.encode("utf-8")) < 32:
        raise _failure("voice_internal_auth_configuration_invalid", 503)
    supplied_secret = request.headers.get(VOICE_INTERNAL_AUTH_HEADER)
    if not supplied_secret or not hmac.compare_digest(supplied_secret, configured_secret):
        raise _failure("voice_internal_auth_required", 401)


def _required_config(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise _failure("voice_lab_configuration_missing", 503)
    return value


def _required_secret(name: str) -> str:
    value = _required_config(name)
    if len(value.encode("utf-8")) < 32:
        raise _failure("voice_lab_configuration_invalid", 503)
    return value


def _b64url_decode(value: str) -> bytes:
    if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise _failure("voice_lab_capability_malformed", 401)
    try:
        decoded = base64.urlsafe_b64decode((value + "=" * (-len(value) % 4)).encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise _failure("voice_lab_capability_malformed", 401) from exc
    if not decoded or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value:
        raise _failure("voice_lab_capability_malformed", 401)
    return decoded


def _parse_payload(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("v") != 1 or value.get("synthetic") is not True:
        raise _failure("voice_lab_capability_malformed", 401)
    required_ids = ("iss", "aud", "sub", "principal_id", "test_run_id", "environment", "jti", "nonce")
    allowed_keys = {
        "v", "iss", "aud", "sub", "principal_id", "test_run_id",
        "scenario_id", "scenario_version", "synthetic", "environment",
        "retention_hours", "cleanup_obligation_id", "provider_expires_at", "allowed_ops", "expected_deployment", "iat", "nbf", "exp", "jti", "nonce",
        "provider_session_id",
        "voice_lab_run_id_sha256", "browser_worker_id_sha256",
        "browser_lease_epoch", "browser_context_id_sha256",
    }
    if set(value) - allowed_keys:
        raise _failure("voice_lab_capability_malformed", 401)
    if any(not isinstance(value.get(key), str) or not _SAFE_ID.fullmatch(value[key]) for key in required_ids):
        raise _failure("voice_lab_capability_malformed", 401)
    for key in ("scenario_id", "scenario_version"):
        candidate = value.get(key)
        if candidate is not None and (not isinstance(candidate, str) or not _SAFE_ID.fullmatch(candidate)):
            raise _failure("voice_lab_capability_malformed", 401)
    provider_session_id = value.get("provider_session_id")
    if provider_session_id is not None and (
        not isinstance(provider_session_id, str)
        or not _SAFE_ID.fullmatch(provider_session_id)
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    ownership_keys = (
        "voice_lab_run_id_sha256",
        "browser_worker_id_sha256",
        "browser_lease_epoch",
        "browser_context_id_sha256",
    )
    ownership_present = tuple(value.get(key) is not None for key in ownership_keys)
    if any(ownership_present) != all(ownership_present):
        raise _failure("voice_lab_capability_malformed", 401)
    if value.get("scenario_id") == "V-D02":
        if not all(ownership_present):
            raise _failure("voice_lab_capability_malformed", 401)
    elif any(ownership_present):
        raise _failure("voice_lab_capability_malformed", 401)
    if all(ownership_present):
        if any(
            not isinstance(value.get(key), str)
            or not _SHA256.fullmatch(str(value[key]))
            for key in (
                "voice_lab_run_id_sha256",
                "browser_worker_id_sha256",
                "browser_context_id_sha256",
            )
        ):
            raise _failure("voice_lab_capability_malformed", 401)
        lease_epoch = value.get("browser_lease_epoch")
        if (
            not isinstance(lease_epoch, int)
            or isinstance(lease_epoch, bool)
            or lease_epoch <= 0
        ):
            raise _failure("voice_lab_capability_malformed", 401)
    retention_hours = value.get("retention_hours")
    if (
        not isinstance(retention_hours, int)
        or isinstance(retention_hours, bool)
        or not _MIN_RETENTION_HOURS <= retention_hours <= _MAX_RETENTION_HOURS
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    provider_expires_at = value.get("provider_expires_at")
    try:
        parsed_provider_expiry = datetime.fromisoformat(
            str(provider_expires_at).replace("Z", "+00:00")
        ).astimezone(UTC)
    except (TypeError, ValueError):
        raise _failure("voice_lab_capability_malformed", 401) from None
    if (
        parsed_provider_expiry.isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        != provider_expires_at
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    cleanup_obligation_id = value.get("cleanup_obligation_id")
    if (
        not isinstance(cleanup_obligation_id, str)
        or not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id)
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    operations = value.get("allowed_ops")
    if (
        not isinstance(operations, list)
        or not 1 <= len(operations) <= 16
        or any(not isinstance(operation, str) or not _SAFE_ID.fullmatch(operation) for operation in operations)
        or len(set(operations)) != len(operations)
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    deployment = value.get("expected_deployment")
    if (
        not isinstance(deployment, dict)
        or set(deployment) != {"frontend", "backend", "voice"}
        or any(not isinstance(deployment.get(key), str) or not _SHA.fullmatch(deployment[key]) for key in ("frontend", "backend", "voice"))
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    if any(not isinstance(value.get(key), int) or isinstance(value.get(key), bool) for key in ("iat", "nbf", "exp")):
        raise _failure("voice_lab_capability_malformed", 401)
    return value


def _verify_runtime_capability(
    token: str | None,
    *,
    principal_id: str,
    environment: str,
    required_operation: str,
) -> VoiceLabRuntimeClaims:
    if not token:
        raise _failure("voice_lab_capability_missing", 401)
    parts = token.split(".")
    if len(parts) != 2:
        raise _failure("voice_lab_capability_malformed", 401)
    encoded_payload, encoded_signature = parts
    signature = _b64url_decode(encoded_signature)
    expected_signature = hmac.new(
        _required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET").encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected_signature):
        raise _failure("voice_lab_capability_invalid_signature", 401)
    try:
        payload = _parse_payload(json.loads(_b64url_decode(encoded_payload).decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _failure("voice_lab_capability_malformed", 401) from exc

    now = int(time.time())
    try:
        max_ttl = int(os.getenv("SOPHIA_VOICE_LAB_MAX_TTL_SECONDS", "300"))
    except ValueError as exc:
        raise _failure("voice_lab_configuration_invalid", 503) from exc
    if not 1 <= max_ttl <= _MAX_TTL_SECONDS:
        raise _failure("voice_lab_configuration_invalid", 503)
    if (
        payload["exp"] <= payload["iat"]
        or payload["nbf"] >= payload["exp"]
        or payload["iat"] > now + _CLOCK_SKEW_SECONDS
        or payload["exp"] - payload["iat"] > max_ttl
        or payload["nbf"] < payload["iat"] - _CLOCK_SKEW_SECONDS
    ):
        raise _failure("voice_lab_capability_invalid_lifetime", 401)
    if payload["exp"] <= now or payload["nbf"] > now + _CLOCK_SKEW_SECONDS:
        raise _failure("voice_lab_capability_expired_or_not_yet_valid", 401)
    if payload["iss"] != "sophia-gateway" or payload["aud"] != "sophia-voice-runtime":
        raise _failure("voice_lab_capability_wrong_audience", 403)
    if payload["sub"] != principal_id or payload["principal_id"] != principal_id or payload["sub"] != payload["principal_id"]:
        raise _failure("voice_lab_capability_wrong_principal", 403)
    if payload["environment"] != environment:
        raise _failure("voice_lab_capability_wrong_environment", 403)
    if required_operation not in payload["allowed_ops"]:
        raise _failure("voice_lab_capability_operation_denied", 403)
    voice_build = (os.getenv("RENDER_GIT_COMMIT") or os.getenv("SOPHIA_DEPLOYMENT_SHA") or "").strip()
    if not _SHA.fullmatch(voice_build):
        raise _failure("voice_lab_deployment_identity_unavailable", 503)
    if (
        required_operation != "session:retention-reap"
        and payload["expected_deployment"]["voice"] != voice_build
    ):
        raise _failure("voice_lab_capability_deployment_mismatch", 409)

    return VoiceLabRuntimeClaims(
        principal_id=payload["principal_id"],
        test_run_id=payload["test_run_id"],
        scenario_id=payload.get("scenario_id"),
        scenario_version=payload.get("scenario_version"),
        environment=payload["environment"],
        retention_hours=payload["retention_hours"],
        cleanup_obligation_id=payload["cleanup_obligation_id"],
        provider_expires_at=payload["provider_expires_at"],
        allowed_ops=tuple(payload["allowed_ops"]),
        expected_deployment=dict(payload["expected_deployment"]),
        expires_at=payload["exp"],
        provider_session_id=payload.get("provider_session_id"),
        voice_lab_run_id_sha256=payload.get("voice_lab_run_id_sha256"),
        browser_worker_id_sha256=payload.get("browser_worker_id_sha256"),
        browser_lease_epoch=payload.get("browser_lease_epoch"),
        browser_context_id_sha256=payload.get("browser_context_id_sha256"),
    )


def capability_for_production_action(
    request: Request,
    *,
    user_id: str,
    synthetic_context: Mapping[str, object] | None,
    required_operation: str,
    allow_kill_switch: bool = False,
) -> VoiceLabRuntimeClaims | None:
    token = request.headers.get(VOICE_LAB_CAPABILITY_HEADER)
    configured_principal = (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip()
    if not token and (not configured_principal or user_id != configured_principal):
        if synthetic_context:
            raise _failure("voice_lab_synthetic_context_without_capability", 403)
        return None
    cleanup_operation = required_operation in {
        "session:finalize",
        "session:recover",
        "session:retention-reap",
    }
    if not _is_true(os.getenv("SOPHIA_VOICE_LAB_ENABLED")) and not cleanup_operation:
        raise _failure("voice_lab_disabled", 404)
    if (
        not allow_kill_switch
        and (os.getenv("SOPHIA_VOICE_LAB_KILL_SWITCH") or "true").strip().lower()
        != "false"
    ):
        raise _failure("voice_lab_kill_switch_active", 403)
    principal_id = _required_config("SOPHIA_VOICE_LAB_TEST_PRINCIPAL")
    environment = _required_config("SOPHIA_VOICE_LAB_ENVIRONMENT")
    if user_id != principal_id:
        raise _failure("voice_lab_capability_wrong_principal", 403)
    claims = _verify_runtime_capability(
        token,
        principal_id=principal_id,
        environment=environment,
        required_operation=required_operation,
    )
    expected_context = claims.synthetic_context()
    if not isinstance(synthetic_context, Mapping) or dict(synthetic_context) != expected_context:
        raise _failure("voice_lab_synthetic_context_mismatch", 403)
    return claims


def capability_for_retention_reap(
    request: Request,
    *,
    provider_session_id: str,
    synthetic_context: Mapping[str, object] | None,
) -> VoiceLabRuntimeClaims:
    """Authenticate cleanup after a deploy or loss of Voice in-memory state."""

    principal_id = _required_config("SOPHIA_VOICE_LAB_TEST_PRINCIPAL")
    environment = _required_config("SOPHIA_VOICE_LAB_ENVIRONMENT")
    claims = _verify_runtime_capability(
        request.headers.get(VOICE_LAB_CAPABILITY_HEADER),
        principal_id=principal_id,
        environment=environment,
        required_operation="session:retention-reap",
    )
    if claims.provider_session_id != provider_session_id:
        raise _failure("voice_lab_provider_session_binding_mismatch", 409)
    if synthetic_context is not None and dict(synthetic_context) != claims.synthetic_context():
        raise _failure("voice_lab_synthetic_context_mismatch", 403)
    return claims


def capability_for_production_start(
    request: Request,
    *,
    user_id: str,
    synthetic_context: Mapping[str, object] | None,
) -> VoiceLabRuntimeClaims | None:
    return capability_for_production_action(
        request,
        user_id=user_id,
        synthetic_context=synthetic_context,
        required_operation="voice:start",
    )


def voice_service_identity() -> dict[str, str | int | None]:
    build_id = (os.getenv("RENDER_GIT_COMMIT") or os.getenv("SOPHIA_DEPLOYMENT_SHA") or "unknown").strip()
    return {
        "service": "sophia-voice",
        "build_id": build_id,
        "deployment_id": (os.getenv("RENDER_DEPLOY_ID") or "").strip() or None,
        "service_id": (os.getenv("RENDER_SERVICE_ID") or "").strip() or None,
        "memory_contract_schema": "mem00.v1",
        "memory_supported_contract_epoch": 1,
    }


def voice_security_readiness() -> dict[str, bool | str | None]:
    """Validate deployment and protected-route configuration without provider work."""
    identity = voice_service_identity()
    build_id = str(identity["build_id"] or "")
    if _is_production_runtime() and not _SHA.fullmatch(build_id):
        raise _failure("voice_deployment_identity_unavailable", 503)

    internal_secret = (os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET") or "").strip()
    internal_required = _is_production_runtime() or _is_true(
        os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_REQUIRED")
    )
    if internal_required and not internal_secret:
        raise _failure("voice_internal_auth_configuration_missing", 503)
    if internal_secret and len(internal_secret.encode()) < 32:
        raise _failure("voice_internal_auth_configuration_invalid", 503)

    lab_enabled = _is_true(os.getenv("SOPHIA_VOICE_LAB_ENABLED"))
    lab_kill_switch_engaged = (
        (os.getenv("SOPHIA_VOICE_LAB_KILL_SWITCH") or "true").strip().lower()
        != "false"
    )
    if lab_enabled:
        _required_config("SOPHIA_VOICE_LAB_TEST_PRINCIPAL")
        _required_config("SOPHIA_VOICE_LAB_ENVIRONMENT")
        capability_secret = _required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET")
        gateway_url = _required_config("SOPHIA_GATEWAY_URL")
        if not gateway_url.startswith(("https://", "http://")):
            raise _failure("voice_lab_configuration_invalid", 503)
        if internal_secret and hmac.compare_digest(capability_secret, internal_secret):
            raise _failure("voice_lab_secret_not_distinct", 503)
        try:
            max_ttl = int(os.getenv("SOPHIA_VOICE_LAB_MAX_TTL_SECONDS", "300"))
        except ValueError as exc:
            raise _failure("voice_lab_configuration_invalid", 503) from exc
        if not 1 <= max_ttl <= _MAX_TTL_SECONDS:
            raise _failure("voice_lab_configuration_invalid", 503)
    return {
        "security_configured": True,
        "internal_auth_required": internal_required,
        "voice_lab_enabled": lab_enabled,
        "voice_lab_kill_switch_engaged": lab_kill_switch_engaged,
        "voice_lab_mutation_ready": bool(
            lab_enabled and not lab_kill_switch_engaged
        ),
        "build_id": identity["build_id"],
        "deployment_id": identity["deployment_id"],
        "service_id": identity["service_id"],
    }
