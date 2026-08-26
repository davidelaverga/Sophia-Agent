"""Fail-closed synthetic voice-lab capabilities for the gateway boundary."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException, Request

VOICE_LAB_CAPABILITY_HEADER = "X-Sophia-Voice-Lab-Capability"
VOICE_LAB_PROVIDER_CLEANUP_HEADER = "X-Sophia-Voice-Lab-Provider-Cleanup"
VOICE_INTERNAL_AUTH_HEADER = "X-Sophia-Voice-Internal-Auth"
VOICE_LAB_RECOVERY_INTERNAL_AUTH_HEADER = "X-Sophia-Voice-Lab-Recovery-Auth"
VOICE_LAB_GATEWAY_AUDIENCE = "sophia-voice-gateway"
VOICE_LAB_RUNTIME_AUDIENCE = "sophia-voice-runtime"
VOICE_LAB_RECOVERY_AUDIENCE = "sophia-voice-lab-recovery"
VOICE_LAB_RECOVERY_ISSUER = "sophia-voice-lab"
VOICE_LAB_FRONTEND_ISSUER = "sophia-frontend"
VOICE_LAB_GATEWAY_ISSUER = "sophia-gateway"
VOICE_LAB_PROVIDER_CLEANUP_ISSUER = "sophia-voice-gateway"
VOICE_LAB_PROVIDER_CLEANUP_AUDIENCE = "sophia-voice-lab-provider-cleanup"
VOICE_LAB_PROVIDER_CLEANUP_OPERATION = "provider:settle"

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
_PROVIDER_CLEANUP_GRACE_SECONDS = 600


@dataclass(frozen=True)
class VoiceLabClaims:
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
    issued_at: int
    not_before: int
    expires_at: int
    jti: str
    nonce: str
    raw: dict[str, Any]
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
        if self.scenario_id == "V-D02":
            context.update(
                {
                    "voice_lab_run_id_sha256": str(
                        self.voice_lab_run_id_sha256
                    ),
                    "browser_worker_id_sha256": str(
                        self.browser_worker_id_sha256
                    ),
                    "browser_lease_epoch": int(self.browser_lease_epoch or 0),
                    "browser_context_id_sha256": str(
                        self.browser_context_id_sha256
                    ),
                }
            )
        return context


@dataclass(frozen=True)
class VoiceLabProviderCleanupClaims:
    principal_id: str
    test_run_id: str
    scenario_id: str | None
    scenario_version: str | None
    environment: str
    retention_hours: int
    cleanup_obligation_id: str
    provider_expires_at: str
    retention_expires_at: str
    cleanup_expires_at: str
    expected_deployment: dict[str, str]
    provider_session_id: str
    cleanup_provider_admission_id: str
    issued_at: int
    not_before: int
    expires_at: int
    jti: str
    raw: dict[str, Any]
    voice_lab_run_id_sha256: str | None = None
    browser_worker_id_sha256: str | None = None
    browser_lease_epoch: int | None = None
    browser_context_id_sha256: str | None = None


@dataclass(frozen=True)
class VoiceLabProviderCleanupAuthority:
    token: str
    cleanup_expires_at: str


def _synthetic_session_metadata(record: object) -> dict[str, Any] | None:
    metadata = getattr(record, "metadata", None)
    if not isinstance(metadata, dict):
        return None
    synthetic = metadata.get("synthetic_voice_lab")
    return synthetic if isinstance(synthetic, dict) else None


def voice_lab_session_record_matches(
    record: object,
    claims: VoiceLabClaims,
) -> bool:
    """Return whether a canonical session belongs to this exact lab run."""
    synthetic = _synthetic_session_metadata(record)
    metadata = getattr(record, "metadata", None)
    if synthetic is None or not isinstance(metadata, dict):
        return False
    retention_expires_at = synthetic.get("retention_expires_at")
    retention_anchor = synthetic.get("retention_anchor")
    finalized_at = synthetic.get("finalized_at")
    try:
        created_at = datetime.fromisoformat(str(getattr(record, "created_at", "")))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        if retention_anchor == "session_created_at_provisional":
            anchor_at = created_at.astimezone(UTC)
            anchor_valid = finalized_at is None
        elif retention_anchor == "finalized_at":
            anchor_at = _parse_canonical_utc_millis(finalized_at)
            anchor_valid = (
                anchor_at is not None
                and getattr(record, "status", None) == "ended"
                and getattr(record, "ended_at", None) == finalized_at
            )
        else:
            anchor_at = None
            anchor_valid = False
        expected_retention = (
            _canonical_utc_millis(
                anchor_at + timedelta(hours=claims.retention_hours)
            )
            if anchor_at is not None
            else None
        )
        bounded_retention = (
            anchor_valid
            and synthetic.get("retention_hours") == claims.retention_hours
            and retention_expires_at == expected_retention
        )
    except (TypeError, ValueError):
        bounded_retention = False
    return (
        getattr(record, "user_id", None) == claims.principal_id
        and getattr(record, "run_id", None) == claims.test_run_id
        and synthetic.get("synthetic") is True
        and synthetic.get("principal_id") == claims.principal_id
        and synthetic.get("test_run_id") == claims.test_run_id
        and synthetic.get("environment") == claims.environment
        and synthetic.get("retention_hours") == claims.retention_hours
        and synthetic.get("cleanup_obligation_id") == claims.cleanup_obligation_id
        and synthetic.get("provider_expires_at") == claims.provider_expires_at
        and synthetic.get("scenario_id") == claims.scenario_id
        and synthetic.get("scenario_version") == claims.scenario_version
        and synthetic.get("voice_lab_run_id_sha256")
        == claims.voice_lab_run_id_sha256
        and synthetic.get("browser_worker_id_sha256")
        == claims.browser_worker_id_sha256
        and synthetic.get("browser_lease_epoch") == claims.browser_lease_epoch
        and synthetic.get("browser_context_id_sha256")
        == claims.browser_context_id_sha256
        and metadata.get("expected_deployment") == claims.expected_deployment
        and metadata.get("memory_retrieval_disabled") is True
        and metadata.get("inactivity_finalization_disabled") is True
        and metadata.get("offline_pipeline_disabled") is True
        and metadata.get("memory_learning_disabled") is True
        and metadata.get("ordinary_analytics_disabled") is True
        and metadata.get("ordinary_projects_disabled") is True
        and metadata.get("shared_spaces_disabled") is True
        and bounded_retention
    )


def assert_voice_lab_session_record(
    record: object,
    claims: VoiceLabClaims | None,
) -> bool:
    """Require exact capability-to-record binding for synthetic sessions."""
    synthetic = _synthetic_session_metadata(record)
    if claims is None:
        if synthetic is not None:
            raise _failure("voice_lab_capability_missing", 401)
        return False
    if not voice_lab_session_record_matches(record, claims):
        raise _failure("voice_lab_session_binding_mismatch", 409)
    return True


def _failure(code: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code})


def _canonical_utc_millis(value: datetime) -> str:
    return (
        value.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _parse_canonical_utc_millis(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(UTC)
    return normalized if _canonical_utc_millis(normalized) == value else None


def voice_lab_provisional_retention_fields(
    claims: VoiceLabClaims,
    session_created_at: datetime,
) -> dict[str, object]:
    """Return the signed run policy's non-final session safety deadline."""
    created_at = session_created_at.astimezone(UTC)
    return {
        "retention_hours": claims.retention_hours,
        "retention_anchor": "session_created_at_provisional",
        "retention_expires_at": _canonical_utc_millis(
            created_at + timedelta(hours=claims.retention_hours)
        ),
    }


def voice_lab_final_retention_fields(
    claims: VoiceLabClaims,
    finalized_at: datetime,
) -> dict[str, object]:
    """Return the exact canonical finalization-anchored retention receipt."""
    canonical_finalized_at = _canonical_utc_millis(finalized_at)
    normalized_finalized_at = _parse_canonical_utc_millis(canonical_finalized_at)
    if normalized_finalized_at is None:  # pragma: no cover - construction invariant
        raise ValueError("canonical finalization timestamp is invalid")
    return {
        "finalized_at": canonical_finalized_at,
        "retention_hours": claims.retention_hours,
        "retention_anchor": "finalized_at",
        "retention_expires_at": _canonical_utc_millis(
            normalized_finalized_at + timedelta(hours=claims.retention_hours)
        ),
    }


def _is_true(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"


def _lab_enabled() -> bool:
    return _is_true(os.getenv("SOPHIA_VOICE_LAB_ENABLED")) and (
        (os.getenv("SOPHIA_VOICE_LAB_KILL_SWITCH") or "true").strip().lower() == "false"
    )


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
    padded = value + "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise _failure("voice_lab_capability_malformed", 401) from exc
    if not decoded or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != value:
        raise _failure("voice_lab_capability_malformed", 401)
    return decoded


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _parse_claims(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
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
    if set(payload) - allowed_keys:
        raise _failure("voice_lab_capability_malformed", 401)
    if payload.get("v") != 1 or payload.get("synthetic") is not True:
        raise _failure("voice_lab_capability_malformed", 401)
    if any(not isinstance(payload.get(key), str) or not _SAFE_ID.fullmatch(payload[key]) for key in required_ids):
        raise _failure("voice_lab_capability_malformed", 401)
    for optional_key in ("scenario_id", "scenario_version"):
        value = payload.get(optional_key)
        if value is not None and (not isinstance(value, str) or not _SAFE_ID.fullmatch(value)):
            raise _failure("voice_lab_capability_malformed", 401)
    provider_session_id = payload.get("provider_session_id")
    if provider_session_id is not None and (
        not isinstance(provider_session_id, str)
        or not _SAFE_ID.fullmatch(provider_session_id)
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    d02_keys = (
        "voice_lab_run_id_sha256",
        "browser_worker_id_sha256",
        "browser_lease_epoch",
        "browser_context_id_sha256",
    )
    d02_present = tuple(key in payload for key in d02_keys)
    if payload.get("scenario_id") == "V-D02":
        if not all(d02_present):
            raise _failure("voice_lab_capability_malformed", 401)
        if (
            not _SHA256.fullmatch(str(payload["voice_lab_run_id_sha256"]))
            or not _SHA256.fullmatch(str(payload["browser_worker_id_sha256"]))
            or not _SHA256.fullmatch(str(payload["browser_context_id_sha256"]))
            or not isinstance(payload["browser_lease_epoch"], int)
            or isinstance(payload["browser_lease_epoch"], bool)
            or payload["browser_lease_epoch"] <= 0
        ):
            raise _failure("voice_lab_capability_malformed", 401)
    elif any(d02_present):
        raise _failure("voice_lab_capability_malformed", 401)
    retention_hours = payload.get("retention_hours")
    if (
        not isinstance(retention_hours, int)
        or isinstance(retention_hours, bool)
        or not _MIN_RETENTION_HOURS <= retention_hours <= _MAX_RETENTION_HOURS
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    cleanup_obligation_id = payload.get("cleanup_obligation_id")
    if (
        not isinstance(cleanup_obligation_id, str)
        or not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id)
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    provider_expires_at = _parse_canonical_utc_millis(
        payload.get("provider_expires_at")
    )
    if provider_expires_at is None:
        raise _failure("voice_lab_capability_malformed", 401)
    operations = payload.get("allowed_ops")
    if (
        not isinstance(operations, list)
        or not 1 <= len(operations) <= 16
        or any(not isinstance(operation, str) or not _SAFE_ID.fullmatch(operation) for operation in operations)
        or len(set(operations)) != len(operations)
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    deployment = payload.get("expected_deployment")
    if (
        not isinstance(deployment, dict)
        or set(deployment) != {"frontend", "backend", "voice"}
        or any(not isinstance(deployment.get(key), str) or not _SHA.fullmatch(deployment[key]) for key in ("frontend", "backend", "voice"))
    ):
        raise _failure("voice_lab_capability_malformed", 401)
    if any(not isinstance(payload.get(key), int) or isinstance(payload.get(key), bool) for key in ("iat", "nbf", "exp")):
        raise _failure("voice_lab_capability_malformed", 401)
    return payload


def verify_capability(
    token: str | None,
    *,
    secret: str,
    audience: str,
    issuer: str,
    principal_id: str,
    environment: str,
    required_operation: str,
    expected_build_key: str,
    expected_build: str,
    now_seconds: int | None = None,
) -> VoiceLabClaims:
    if not token:
        raise _failure("voice_lab_capability_missing", 401)
    parts = token.split(".")
    if len(parts) != 2:
        raise _failure("voice_lab_capability_malformed", 401)
    encoded_payload, encoded_signature = parts
    supplied_signature = _b64url_decode(encoded_signature)
    expected_signature = hmac.new(secret.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise _failure("voice_lab_capability_invalid_signature", 401)
    try:
        payload = _parse_claims(json.loads(_b64url_decode(encoded_payload).decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _failure("voice_lab_capability_malformed", 401) from exc

    now = int(time.time()) if now_seconds is None else now_seconds
    configured_max_ttl = os.getenv("SOPHIA_VOICE_LAB_MAX_TTL_SECONDS", str(_MAX_TTL_SECONDS))
    try:
        max_ttl = int(configured_max_ttl)
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
    if payload["iss"] != issuer or payload["aud"] != audience:
        raise _failure("voice_lab_capability_wrong_audience", 403)
    if payload["sub"] != principal_id or payload["principal_id"] != principal_id or payload["sub"] != payload["principal_id"]:
        raise _failure("voice_lab_capability_wrong_principal", 403)
    if payload["environment"] != environment:
        raise _failure("voice_lab_capability_wrong_environment", 403)
    if required_operation not in payload["allowed_ops"]:
        raise _failure("voice_lab_capability_operation_denied", 403)
    if payload["expected_deployment"][expected_build_key] != expected_build:
        raise _failure("voice_lab_capability_deployment_mismatch", 409)

    return VoiceLabClaims(
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
        issued_at=payload["iat"],
        not_before=payload["nbf"],
        expires_at=payload["exp"],
        jti=payload["jti"],
        nonce=payload["nonce"],
        raw=dict(payload),
        provider_session_id=payload.get("provider_session_id"),
        voice_lab_run_id_sha256=payload.get("voice_lab_run_id_sha256"),
        browser_worker_id_sha256=payload.get("browser_worker_id_sha256"),
        browser_lease_epoch=payload.get("browser_lease_epoch"),
        browser_context_id_sha256=payload.get("browser_context_id_sha256"),
    )


def _provider_cleanup_failure(code: str, status_code: int) -> HTTPException:
    return _failure(f"voice_lab_provider_cleanup_{code}", status_code)


def _provider_cleanup_b64url_decode(value: str) -> bytes:
    if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise _provider_cleanup_failure("malformed", 401)
    padded = value + "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise _provider_cleanup_failure("malformed", 401) from exc
    if (
        not decoded
        or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
        != value
    ):
        raise _provider_cleanup_failure("malformed", 401)
    return decoded


def _provider_cleanup_uuid4(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return None
    return value if parsed.version == 4 and str(parsed) == value else None


def _parse_provider_cleanup_payload(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise _provider_cleanup_failure("malformed", 401)
    allowed_keys = {
        "v",
        "iss",
        "aud",
        "sub",
        "principal_id",
        "test_run_id",
        "scenario_id",
        "scenario_version",
        "synthetic",
        "environment",
        "retention_hours",
        "cleanup_obligation_id",
        "provider_expires_at",
        "retention_expires_at",
        "cleanup_expires_at",
        "allowed_ops",
        "expected_deployment",
        "provider_session_id",
        "cleanup_provider_admission_id",
        "voice_lab_run_id_sha256",
        "browser_worker_id_sha256",
        "browser_lease_epoch",
        "browser_context_id_sha256",
        "iat",
        "nbf",
        "exp",
        "jti",
    }
    required_safe_ids = (
        "iss",
        "aud",
        "sub",
        "principal_id",
        "test_run_id",
        "environment",
        "provider_session_id",
    )
    if (
        set(payload) - allowed_keys
        or payload.get("v") != 1
        or payload.get("synthetic") is not True
        or any(
            not isinstance(payload.get(key), str)
            or not _SAFE_ID.fullmatch(payload[key])
            for key in required_safe_ids
        )
    ):
        raise _provider_cleanup_failure("malformed", 401)
    for optional_key in ("scenario_id", "scenario_version"):
        value = payload.get(optional_key)
        if value is not None and (
            not isinstance(value, str) or not _SAFE_ID.fullmatch(value)
        ):
            raise _provider_cleanup_failure("malformed", 401)
    d02_keys = (
        "voice_lab_run_id_sha256",
        "browser_worker_id_sha256",
        "browser_lease_epoch",
        "browser_context_id_sha256",
    )
    d02_present = tuple(key in payload for key in d02_keys)
    if payload.get("scenario_id") == "V-D02":
        if (
            not all(d02_present)
            or not _SHA256.fullmatch(str(payload.get("voice_lab_run_id_sha256")))
            or not _SHA256.fullmatch(str(payload.get("browser_worker_id_sha256")))
            or not _SHA256.fullmatch(str(payload.get("browser_context_id_sha256")))
            or not isinstance(payload.get("browser_lease_epoch"), int)
            or isinstance(payload.get("browser_lease_epoch"), bool)
            or payload["browser_lease_epoch"] <= 0
        ):
            raise _provider_cleanup_failure("malformed", 401)
    elif any(d02_present):
        raise _provider_cleanup_failure("malformed", 401)
    retention_hours = payload.get("retention_hours")
    if (
        not isinstance(retention_hours, int)
        or isinstance(retention_hours, bool)
        or not _MIN_RETENTION_HOURS <= retention_hours <= _MAX_RETENTION_HOURS
    ):
        raise _provider_cleanup_failure("malformed", 401)
    if (
        not isinstance(payload.get("cleanup_obligation_id"), str)
        or not _CLEANUP_OBLIGATION_ID.fullmatch(payload["cleanup_obligation_id"])
        or _provider_cleanup_uuid4(payload.get("cleanup_provider_admission_id"))
        is None
        or _provider_cleanup_uuid4(payload.get("jti")) is None
    ):
        raise _provider_cleanup_failure("malformed", 401)
    provider_deadline = _parse_canonical_utc_millis(
        payload.get("provider_expires_at")
    )
    retention_deadline = _parse_canonical_utc_millis(
        payload.get("retention_expires_at")
    )
    cleanup_deadline = _parse_canonical_utc_millis(
        payload.get("cleanup_expires_at")
    )
    if (
        provider_deadline is None
        or retention_deadline is None
        or cleanup_deadline is None
        or retention_deadline < provider_deadline
    ):
        raise _provider_cleanup_failure("malformed", 401)
    expected_cleanup_deadline = min(
        retention_deadline,
        provider_deadline + timedelta(seconds=_PROVIDER_CLEANUP_GRACE_SECONDS),
    )
    if cleanup_deadline != expected_cleanup_deadline:
        raise _provider_cleanup_failure("invalid_lifetime", 401)
    if payload.get("allowed_ops") != [VOICE_LAB_PROVIDER_CLEANUP_OPERATION]:
        raise _provider_cleanup_failure("operation_denied", 403)
    deployment = payload.get("expected_deployment")
    if (
        not isinstance(deployment, dict)
        or set(deployment) != {"frontend", "backend", "voice"}
        or any(
            not isinstance(deployment.get(key), str)
            or not _SHA.fullmatch(deployment[key])
            for key in ("frontend", "backend", "voice")
        )
    ):
        raise _provider_cleanup_failure("malformed", 401)
    if any(
        not isinstance(payload.get(key), int)
        or isinstance(payload.get(key), bool)
        for key in ("iat", "nbf", "exp")
    ):
        raise _provider_cleanup_failure("malformed", 401)
    if payload["exp"] != int(cleanup_deadline.timestamp()):
        raise _provider_cleanup_failure("invalid_lifetime", 401)
    return payload


def mint_provider_cleanup_token(
    claims: VoiceLabClaims,
    provider_session_id: str,
    cleanup_provider_admission_id: str,
    retention_expires_at: str,
    *,
    now_seconds: int | None = None,
) -> VoiceLabProviderCleanupAuthority:
    """Mint browser-carried authority for provider settlement only.

    This token deliberately outlives the 300-second interactive context but
    cannot create, relay, continue, or update a session. Its absolute expiry
    is the earlier of the signed retention deadline and ten minutes after the
    provider authority deadline.
    """

    now = int(time.time()) if now_seconds is None else now_seconds
    provider_deadline = _parse_canonical_utc_millis(claims.provider_expires_at)
    retention_deadline = _parse_canonical_utc_millis(retention_expires_at)
    if (
        provider_deadline is None
        or retention_deadline is None
        or retention_deadline < provider_deadline
        or not _SAFE_ID.fullmatch(provider_session_id)
        or _provider_cleanup_uuid4(cleanup_provider_admission_id) is None
    ):
        raise _provider_cleanup_failure("binding_mismatch", 409)
    cleanup_deadline = min(
        retention_deadline,
        provider_deadline + timedelta(seconds=_PROVIDER_CLEANUP_GRACE_SECONDS),
    )
    cleanup_expires_at = _canonical_utc_millis(cleanup_deadline)
    expires_at = int(cleanup_deadline.timestamp())
    if expires_at <= now or now > int(provider_deadline.timestamp()) + _CLOCK_SKEW_SECONDS:
        raise _provider_cleanup_failure("expired_or_not_yet_valid", 401)
    payload: dict[str, Any] = {
        "v": 1,
        "iss": VOICE_LAB_PROVIDER_CLEANUP_ISSUER,
        "aud": VOICE_LAB_PROVIDER_CLEANUP_AUDIENCE,
        "sub": claims.principal_id,
        "principal_id": claims.principal_id,
        "test_run_id": claims.test_run_id,
        "synthetic": True,
        "environment": claims.environment,
        "retention_hours": claims.retention_hours,
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "provider_expires_at": claims.provider_expires_at,
        "retention_expires_at": retention_expires_at,
        "cleanup_expires_at": cleanup_expires_at,
        "allowed_ops": [VOICE_LAB_PROVIDER_CLEANUP_OPERATION],
        "expected_deployment": dict(claims.expected_deployment),
        "provider_session_id": provider_session_id,
        "cleanup_provider_admission_id": cleanup_provider_admission_id,
        "iat": now,
        "nbf": now,
        "exp": expires_at,
        "jti": str(uuid.uuid4()),
    }
    if claims.scenario_id is not None:
        payload["scenario_id"] = claims.scenario_id
    if claims.scenario_version is not None:
        payload["scenario_version"] = claims.scenario_version
    if claims.scenario_id == "V-D02":
        payload.update(
            {
                "voice_lab_run_id_sha256": claims.voice_lab_run_id_sha256,
                "browser_worker_id_sha256": claims.browser_worker_id_sha256,
                "browser_lease_epoch": claims.browser_lease_epoch,
                "browser_context_id_sha256": claims.browser_context_id_sha256,
            }
        )
    _parse_provider_cleanup_payload(payload)
    encoded_payload = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        _required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET").encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return VoiceLabProviderCleanupAuthority(
        token=f"{encoded_payload}.{_b64url_encode(signature)}",
        cleanup_expires_at=cleanup_expires_at,
    )


def verify_provider_cleanup_token(
    token: str | None,
    *,
    secret: str,
    principal_id: str,
    environment: str,
    now_seconds: int | None = None,
) -> VoiceLabProviderCleanupClaims:
    if not token:
        raise _provider_cleanup_failure("missing", 401)
    parts = token.split(".")
    if len(parts) != 2:
        raise _provider_cleanup_failure("malformed", 401)
    encoded_payload, encoded_signature = parts
    supplied_signature = _provider_cleanup_b64url_decode(encoded_signature)
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise _provider_cleanup_failure("invalid_signature", 401)
    try:
        payload = _parse_provider_cleanup_payload(
            json.loads(
                _provider_cleanup_b64url_decode(encoded_payload).decode("utf-8")
            )
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _provider_cleanup_failure("malformed", 401) from exc

    now = int(time.time()) if now_seconds is None else now_seconds
    provider_deadline = _parse_canonical_utc_millis(payload["provider_expires_at"])
    if provider_deadline is None:  # pragma: no cover - parser invariant.
        raise _provider_cleanup_failure("malformed", 401)
    if (
        payload["nbf"] != payload["iat"]
        or payload["exp"] <= payload["iat"]
        or payload["iat"] > now + _CLOCK_SKEW_SECONDS
        or payload["iat"] > int(provider_deadline.timestamp()) + _CLOCK_SKEW_SECONDS
    ):
        raise _provider_cleanup_failure("invalid_lifetime", 401)
    if payload["exp"] <= now or payload["nbf"] > now + _CLOCK_SKEW_SECONDS:
        raise _provider_cleanup_failure("expired_or_not_yet_valid", 401)
    if (
        payload["iss"] != VOICE_LAB_PROVIDER_CLEANUP_ISSUER
        or payload["aud"] != VOICE_LAB_PROVIDER_CLEANUP_AUDIENCE
    ):
        raise _provider_cleanup_failure("wrong_audience", 403)
    if (
        payload["sub"] != principal_id
        or payload["principal_id"] != principal_id
        or payload["sub"] != payload["principal_id"]
    ):
        raise _provider_cleanup_failure("wrong_principal", 403)
    if payload["environment"] != environment:
        raise _provider_cleanup_failure("wrong_environment", 403)
    return VoiceLabProviderCleanupClaims(
        principal_id=payload["principal_id"],
        test_run_id=payload["test_run_id"],
        scenario_id=payload.get("scenario_id"),
        scenario_version=payload.get("scenario_version"),
        environment=payload["environment"],
        retention_hours=payload["retention_hours"],
        cleanup_obligation_id=payload["cleanup_obligation_id"],
        provider_expires_at=payload["provider_expires_at"],
        retention_expires_at=payload["retention_expires_at"],
        cleanup_expires_at=payload["cleanup_expires_at"],
        expected_deployment=dict(payload["expected_deployment"]),
        provider_session_id=payload["provider_session_id"],
        cleanup_provider_admission_id=payload[
            "cleanup_provider_admission_id"
        ],
        issued_at=payload["iat"],
        not_before=payload["nbf"],
        expires_at=payload["exp"],
        jti=payload["jti"],
        raw=dict(payload),
        voice_lab_run_id_sha256=payload.get("voice_lab_run_id_sha256"),
        browser_worker_id_sha256=payload.get("browser_worker_id_sha256"),
        browser_lease_epoch=payload.get("browser_lease_epoch"),
        browser_context_id_sha256=payload.get("browser_context_id_sha256"),
    )


def provider_cleanup_claims_for_gateway(
    request: Request,
    user_id: str,
) -> VoiceLabProviderCleanupClaims | None:
    token = request.headers.get(VOICE_LAB_PROVIDER_CLEANUP_HEADER)
    if not token:
        return None
    if not _is_true(os.getenv("SOPHIA_VOICE_LAB_ENABLED")):
        raise _provider_cleanup_failure("disabled", 404)
    principal_id = _required_config("SOPHIA_VOICE_LAB_TEST_PRINCIPAL")
    environment = _required_config("SOPHIA_VOICE_LAB_ENVIRONMENT")
    if user_id != principal_id:
        raise _provider_cleanup_failure("wrong_principal", 403)
    return verify_provider_cleanup_token(
        token,
        secret=_required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET"),
        principal_id=principal_id,
        environment=environment,
    )


def capability_for_gateway_action(
    request: Request,
    user_id: str,
    *,
    required_operation: str,
) -> VoiceLabClaims | None:
    token = request.headers.get(VOICE_LAB_CAPABILITY_HEADER)
    configured_principal = (os.getenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL") or "").strip()
    if not token and (not configured_principal or user_id != configured_principal):
        return None
    if not _is_true(os.getenv("SOPHIA_VOICE_LAB_ENABLED")):
        raise _failure("voice_lab_disabled", 404)
    cleanup_operation = required_operation in {
        "session:finalize",
        "session:cleanup",
        "session:read",
    }
    if not cleanup_operation and not _lab_enabled():
        raise _failure("voice_lab_kill_switch_active", 403)
    principal_id = _required_config("SOPHIA_VOICE_LAB_TEST_PRINCIPAL")
    environment = _required_config("SOPHIA_VOICE_LAB_ENVIRONMENT")
    if user_id != principal_id:
        raise _failure("voice_lab_capability_wrong_principal", 403)
    backend_build = (os.getenv("RENDER_GIT_COMMIT") or os.getenv("SOPHIA_DEPLOYMENT_SHA") or "").strip()
    if not _SHA.fullmatch(backend_build):
        raise _failure("voice_lab_deployment_identity_unavailable", 503)
    return verify_capability(
        token,
        secret=_required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET"),
        audience=VOICE_LAB_GATEWAY_AUDIENCE,
        issuer=VOICE_LAB_FRONTEND_ISSUER,
        principal_id=principal_id,
        environment=environment,
        required_operation=required_operation,
        expected_build_key="backend",
        expected_build=backend_build,
    )


def capability_for_voice_connect(request: Request, user_id: str) -> VoiceLabClaims | None:
    return capability_for_gateway_action(
        request,
        user_id,
        required_operation="voice:start",
    )


def capability_for_voice_lab_recovery(
    request: Request,
    test_run_id: str,
) -> VoiceLabClaims:
    """Authenticate the private, kill-safe out-of-band recovery boundary."""
    recovery_secret = _required_secret("SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET")
    for other_secret_name in (
        "SOPHIA_VOICE_INTERNAL_AUTH_SECRET",
        "SOPHIA_VOICE_LAB_CAPABILITY_SECRET",
        "SOPHIA_VOICE_LAB_GRANT_SECRET",
        "SOPHIA_BUILDER_EVENTS_HMAC_SECRET",
    ):
        other_secret = (os.getenv(other_secret_name) or "").strip()
        if other_secret and hmac.compare_digest(recovery_secret, other_secret):
            raise _failure("voice_lab_recovery_secret_not_distinct", 503)
    supplied = request.headers.get(VOICE_LAB_RECOVERY_INTERNAL_AUTH_HEADER)
    if not supplied or not hmac.compare_digest(supplied, recovery_secret):
        raise _failure("voice_lab_recovery_internal_auth_required", 401)
    principal_id = _required_config("SOPHIA_VOICE_LAB_TEST_PRINCIPAL")
    environment = _required_config("SOPHIA_VOICE_LAB_ENVIRONMENT")
    backend_build = (
        os.getenv("RENDER_GIT_COMMIT")
        or os.getenv("SOPHIA_DEPLOYMENT_SHA")
        or ""
    ).strip()
    if not _SHA.fullmatch(backend_build):
        raise _failure("voice_lab_deployment_identity_unavailable", 503)
    claims = verify_capability(
        request.headers.get(VOICE_LAB_CAPABILITY_HEADER),
        secret=_required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET"),
        audience=VOICE_LAB_RECOVERY_AUDIENCE,
        issuer=VOICE_LAB_RECOVERY_ISSUER,
        principal_id=principal_id,
        environment=environment,
        required_operation="session:recover",
        expected_build_key="backend",
        expected_build=backend_build,
    )
    if claims.test_run_id != test_run_id:
        raise _failure("voice_lab_recovery_run_mismatch", 409)
    return claims


def sign_runtime_capability(claims: VoiceLabClaims, *, now_seconds: int | None = None) -> str:
    now = int(time.time()) if now_seconds is None else now_seconds
    payload = dict(claims.raw)
    payload.update(
        {
            "iss": VOICE_LAB_GATEWAY_ISSUER,
            "aud": VOICE_LAB_RUNTIME_AUDIENCE,
            "iat": now,
            "nbf": now,
            "exp": min(claims.expires_at, now + _MAX_TTL_SECONDS),
            "jti": str(uuid.uuid4()),
        }
    )
    encoded_payload = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(
        _required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET").encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded_payload}.{_b64url_encode(signature)}"


def sign_retention_reaper_runtime_capability(
    claims: VoiceLabClaims,
    *,
    provider_session_id: str,
    now_seconds: int | None = None,
) -> str:
    """Mint one cleanup-only runtime capability from durable run identity.

    The original browser capability has necessarily expired by a retention
    deadline. The Gateway reaper is an independent product authority, so it
    reconstitutes only the exact persisted synthetic identity and grants only
    ``session:recover`` for a fresh bounded service-to-service lifetime.
    """

    now = int(time.time()) if now_seconds is None else now_seconds
    payload: dict[str, Any] = {
        "v": 1,
        "iss": VOICE_LAB_GATEWAY_ISSUER,
        "aud": VOICE_LAB_RUNTIME_AUDIENCE,
        "sub": claims.principal_id,
        "principal_id": claims.principal_id,
        "test_run_id": claims.test_run_id,
        "synthetic": True,
        "environment": claims.environment,
        "retention_hours": claims.retention_hours,
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "provider_expires_at": claims.provider_expires_at,
        "allowed_ops": ["session:retention-reap"],
        "expected_deployment": dict(claims.expected_deployment),
        "iat": now,
        "nbf": now,
        "exp": now + _MAX_TTL_SECONDS,
        "jti": str(uuid.uuid4()),
        "nonce": str(uuid.uuid4()),
        "provider_session_id": provider_session_id,
    }
    if claims.scenario_id is not None:
        payload["scenario_id"] = claims.scenario_id
    if claims.scenario_version is not None:
        payload["scenario_version"] = claims.scenario_version
    if claims.scenario_id == "V-D02":
        payload.update(
            {
                "voice_lab_run_id_sha256": claims.voice_lab_run_id_sha256,
                "browser_worker_id_sha256": claims.browser_worker_id_sha256,
                "browser_lease_epoch": claims.browser_lease_epoch,
                "browser_context_id_sha256": claims.browser_context_id_sha256,
            }
        )
    _parse_claims(payload)
    encoded_payload = _b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        _required_secret("SOPHIA_VOICE_LAB_CAPABILITY_SECRET").encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded_payload}.{_b64url_encode(signature)}"


def _is_production_runtime() -> bool:
    return (
        _is_true(os.getenv("RENDER"))
        or bool(os.getenv("RENDER_SERVICE_ID"))
        or bool(os.getenv("RENDER_GIT_COMMIT"))
        or (os.getenv("ENVIRONMENT") or "").strip().lower() == "production"
    )


def voice_internal_auth_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = dict(extra or {})
    secret = (os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET") or "").strip()
    required = _is_production_runtime() or _is_true(os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_REQUIRED"))
    if not secret:
        if required:
            raise _failure("voice_internal_auth_configuration_missing", 503)
        return headers
    if len(secret.encode("utf-8")) < 32:
        raise _failure("voice_internal_auth_configuration_invalid", 503)
    headers[VOICE_INTERNAL_AUTH_HEADER] = secret
    return headers
