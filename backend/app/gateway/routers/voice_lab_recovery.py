"""Private, durable, exact-run cleanup for a lost Voice Lab browser lease."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import threading
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app.gateway.voice_lab_capability import (
    VoiceLabClaims,
    assert_voice_lab_session_record,
    capability_for_voice_lab_recovery,
    sign_retention_reaper_runtime_capability,
    sign_runtime_capability,
)

router = APIRouter(prefix="/internal/voice-lab", tags=["voice-lab-recovery"])

_SESSION_MARKER_PREFIX = "sophia-voice-lab-session-v1."
_TERMINAL_COMPONENT_STATUSES = {
    "completed",
    "already_terminal",
    "not_found",
}
_HASH_64 = re.compile(r"^[a-f0-9]{64}$")
_RECOVERY_RECEIPT_ROOT = ".builder/voice_lab_evidence/recovery/v1"
_RECOVERY_PURGE_ROOT = ".builder/voice_lab_evidence/recovery-tombstones/v1"
_RETENTION_CLEANUP_HANDLE_ROOT = (
    ".builder/voice_lab_evidence/retention-cleanup-intents/v2"
)
_RECOVERY_RECEIPT_MAX_OBJECTS = 256
_RECOVERY_RECEIPT_MAX_DEPTH = 4
_RECOVERY_TOMBSTONE_MAX_BYTES = 4 * 1024
_RETENTION_CLEANUP_HANDLE_MAX_BYTES = 4 * 1024
_RETENTION_CLEANUP_HANDLE_MAX_OBJECTS = 10_000
_RETENTION_CLEANUP_HANDLE_GRACE = timedelta(hours=1)
_RETENTION_CLEANUP_HANDLE_FIELDS = {
    "schema",
    "cleanup_obligation_id",
    "cleanup_obligation_id_hmac",
    "prepared_at",
    "retention_expires_at",
    "provider_expires_at",
    "control_expires_at",
    "cleanup_mode",
    "retention_sla_missed",
    "overdue_seconds_at_preparation",
    "retention_policy",
}
_CLEANUP_OBLIGATION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_RECOVERY_PURGE_TOMBSTONE_FIELDS = {
    "schema",
    "recovery_id_hmac",
    "purged_at",
    "recovery_receipts_deleted",
    "recovery_receipts_remaining",
    "all_prior_attempts_purged",
    "raw_identity_excluded",
    "deployment_excluded",
    "content_excluded",
    "component_details_excluded",
    "object_metadata_content_free",
    "retention_policy",
}
_RECOVERY_PURGE_INTENT_FIELDS = {
    "schema",
    "recovery_id_hmac",
    "planned_at",
    "recovery_receipts_target_count",
    "raw_identity_excluded",
    "retention_policy",
}
_RECOVERY_PURGE_FENCE_FIELDS = {
    "schema",
    "recovery_id_hmac",
    "fenced_at",
    "recovery_receipts_exact_count",
    "raw_identity_excluded",
    "retention_policy",
}
_AUTH_TOMBSTONE_DOMAIN = "sophia-voice-lab-auth-tombstone-v1"
_AUTH_TOMBSTONE_KID = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
_REDACTED_SHA256 = "0" * 64
_LOCAL_RECOVERY_RECEIPT_FENCE = threading.RLock()


class CleanupAdmissionCallback(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cleanup_obligation_id: str
    resource_kind: str
    resource_id: str


class CleanupAdmissionAuthorizeCallback(CleanupAdmissionCallback):
    phase: Literal["start", "heartbeat"]


class CleanupAdmissionCompleteCallback(CleanupAdmissionCallback):
    basis: Literal["server_relay_zero"]
    trace_fault: dict[str, object] | None = None
    terminal_receipt: dict[str, object] | None = None


_TRACE_FAULT_RECEIPT_FIELDS = frozenset(
    {
        "schema",
        "fault",
        "phase",
        "principal_id",
        "test_run_id",
        "scenario_id",
        "scenario_version",
        "environment",
        "expected_deployment",
        "trace_unavailable",
        "canonical_behavior_unchanged",
        "applied_at",
        "restored_at",
    }
)


def _canonical_provider_trace_fault_restore_receipt(
    record: object | None,
    value: dict[str, object] | None,
) -> dict[str, object] | None:
    metadata = getattr(record, "metadata", None)
    synthetic = (
        metadata.get("synthetic_voice_lab")
        if isinstance(metadata, dict)
        else None
    )
    expected_scenario = (
        synthetic.get("scenario_id") if isinstance(synthetic, dict) else None
    )
    if expected_scenario != "V-L01":
        if value is not None:
            raise HTTPException(
                status_code=409,
                detail={"code": "cleanup_provider_trace_fault_unexpected"},
            )
        return None
    if not isinstance(value, dict):
        raise HTTPException(
            status_code=409,
            detail={"code": "cleanup_provider_trace_fault_required"},
        )
    applied_at = _parse_canonical_utc_millis(value.get("applied_at"))
    restored_at = _parse_canonical_utc_millis(value.get("restored_at"))
    expected_deployment = (
        metadata.get("expected_deployment")
        if isinstance(metadata, dict)
        else None
    )
    expected = {
        "schema": "sophia_voice_lab_trace_fault_v1",
        "fault": "langsmith_unavailable",
        "phase": "restored",
        "principal_id": getattr(record, "user_id", None),
        "test_run_id": synthetic.get("test_run_id"),
        "scenario_id": "V-L01",
        "scenario_version": synthetic.get("scenario_version"),
        "environment": synthetic.get("environment"),
        "expected_deployment": expected_deployment,
        "trace_unavailable": True,
        "canonical_behavior_unchanged": True,
    }
    if (
        set(value) != _TRACE_FAULT_RECEIPT_FIELDS
        or any(value.get(key) != expected_value for key, expected_value in expected.items())
        or applied_at is None
        or restored_at is None
        or restored_at < applied_at
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "cleanup_provider_trace_fault_invalid"},
        )
    return {
        **expected,
        "applied_at": _canonical_utc_millis(applied_at),
        "restored_at": _canonical_utc_millis(restored_at),
    }


def _session_has_provider_trace_fault(
    record: object | None,
    receipt: dict[str, object],
    *,
    cleanup_obligation_id: str,
    admission_id: str,
    resource_id: str,
) -> bool:
    metadata = getattr(record, "metadata", None)
    synthetic = (
        metadata.get("synthetic_voice_lab")
        if isinstance(metadata, dict)
        else None
    )
    current_envelope = (
        synthetic.get("voice_provider_trace_fault_restore_receipt")
        if isinstance(synthetic, dict)
        else None
    )
    expected = {
        "schema": "sophia_voice_lab_provider_trace_fault_terminal_v1",
        "cleanup_obligation_id": cleanup_obligation_id,
        "cleanup_provider_admission_id": admission_id,
        "provider_session_id": resource_id,
        "trace_fault": receipt,
    }
    raw_history = (
        synthetic.get("voice_provider_trace_fault_restore_receipt_history")
        if isinstance(synthetic, dict)
        else None
    )
    if raw_history is None:
        history: list[object] = []
    elif isinstance(raw_history, list) and len(raw_history) <= 16:
        history = list(raw_history)
    else:
        return False
    candidates = [
        candidate
        for candidate in [current_envelope, *history]
        if candidate is not None
    ]
    envelope_fields = {
        "schema",
        "cleanup_obligation_id",
        "cleanup_provider_admission_id",
        "provider_session_id",
        "trace_fault",
    }
    if any(
        not isinstance(candidate, dict)
        or set(candidate) != envelope_fields
        or candidate.get("schema")
        != "sophia_voice_lab_provider_trace_fault_terminal_v1"
        or candidate.get("cleanup_obligation_id") != cleanup_obligation_id
        or not isinstance(candidate.get("cleanup_provider_admission_id"), str)
        or not isinstance(candidate.get("provider_session_id"), str)
        or not isinstance(candidate.get("trace_fault"), dict)
        for candidate in candidates
    ):
        return False
    # Exact one-match semantics reject duplicated/conflicting archived facts;
    # a response-lost callback for A remains replayable after B rolls A from
    # the current pointer into bounded history.
    return sum(candidate == expected for candidate in candidates) == 1


def _require_voice_internal_callback(request: Request) -> None:
    from app.gateway.voice_lab_capability import VOICE_INTERNAL_AUTH_HEADER

    configured = (os.getenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET") or "").strip()
    supplied = request.headers.get(VOICE_INTERNAL_AUTH_HEADER)
    if (
        len(configured.encode()) < 32
        or not supplied
        or not hmac.compare_digest(supplied, configured)
    ):
        raise HTTPException(
            status_code=401,
            detail={"code": "voice_internal_auth_required"},
        )


@router.post("/cleanup-admissions/{admission_id}/authorize")
def authorize_cleanup_admission_callback(
    admission_id: str,
    body: CleanupAdmissionAuthorizeCallback,
    request: Request,
) -> dict[str, object]:
    _require_voice_internal_callback(request)
    try:
        from deerflow.sophia.cleanup_fence import (
            inspect_cleanup_admission,
            renew_cleanup_admission,
            verify_cleanup_admission_start,
        )

        if body.phase == "start":
            admission = verify_cleanup_admission_start(
                admission_id=admission_id,
                cleanup_obligation_id=body.cleanup_obligation_id,
                resource_kind=body.resource_kind,
                resource_id=body.resource_id,
            )
        else:
            admission = inspect_cleanup_admission(
                admission_id=admission_id,
                cleanup_obligation_id=body.cleanup_obligation_id,
                resource_kind=body.resource_kind,
                resource_id=body.resource_id,
            )
            if admission.status == "browser_active":
                admission = renew_cleanup_admission(
                    admission_id=admission_id,
                    cleanup_obligation_id=body.cleanup_obligation_id,
                    resource_kind=body.resource_kind,
                    resource_id=body.resource_id,
                )
    except Exception:  # noqa: BLE001 - CLOSED is a typed negative ack.
        try:
            from deerflow.sophia.cleanup_fence import cleanup_admissions

            matches = [
                item
                for item in cleanup_admissions(body.cleanup_obligation_id)
                if item.admission_id == admission_id
                and item.resource_kind == body.resource_kind
                and item.resource_id == body.resource_id
            ]
        except Exception:  # noqa: BLE001 - do not infer absence on outage.
            matches = []
            status = "unknown"
        else:
            status = matches[0].status if len(matches) == 1 else "missing"
        d02_freeze: dict[str, object] | None = None
        if len(matches) == 1 and body.resource_kind == "provider":
            try:
                from app.gateway.routers.voice_lab_d02_settlement import (
                    d02_freeze_for_provider_admission,
                )

                d02_freeze = d02_freeze_for_provider_admission(
                    cleanup_obligation_id=body.cleanup_obligation_id,
                    admission_id=admission_id,
                    provider_session_id=body.resource_id,
                )
            except Exception:  # noqa: BLE001 - never infer D02 authority.
                d02_freeze = None
        return {
            "authorized": False,
            "status": status,
            "code": (
                "voice_lab_d02_termination_frozen"
                if d02_freeze is not None
                else "cleanup_admission_closed"
            ),
            "expired": len(matches) == 1 and matches[0].expired,
            **({"d02_freeze": d02_freeze} if d02_freeze is not None else {}),
            **(
                {
                    "resource_expires_at": _canonical_utc_millis(
                        matches[0].resource_expires_at
                    )
                }
                if len(matches) == 1
                and matches[0].resource_expires_at is not None
                else {}
            ),
        }
    return {
        "authorized": True,
        "status": admission.status,
        "code": (
            "cleanup_admission_pending_bind"
            if admission.status in {"reserved", "allocating"}
            else "cleanup_admission_pending_activation"
            if admission.status == "credential_minted"
            else "cleanup_admission_browser_active"
            if admission.status == "browser_active"
            else "cleanup_admission_terminal"
        ),
        "lease_expires_at": _canonical_utc_millis(admission.lease_expires_at),
        "resource_expires_at": (
            _canonical_utc_millis(admission.resource_expires_at)
            if admission.resource_expires_at is not None
            else None
        ),
    }


@router.post("/cleanup-admissions/{admission_id}/complete")
def complete_cleanup_admission_callback(
    admission_id: str,
    body: CleanupAdmissionCompleteCallback,
    request: Request,
) -> dict[str, object]:
    _require_voice_internal_callback(request)

    if body.terminal_receipt is not None:
        if body.resource_kind != "provider" or body.trace_fault is not None:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_d02_voice_terminal_binding_mismatch"},
            )
        from app.gateway.routers.voice_lab_d02_settlement import (
            persist_d02_voice_terminal_receipt,
        )

        persist_d02_voice_terminal_receipt(
            cleanup_obligation_id=body.cleanup_obligation_id,
            admission_id=admission_id,
            provider_session_id=body.resource_id,
            receipt=body.terminal_receipt,
        )
        return {
            "completed": False,
            "already_terminal": False,
            "status": "d02_terminal_proof_persisted",
            "d02_terminal_proof_persisted": True,
        }

    if body.resource_kind == "provider":
        try:
            from app.gateway.routers.voice_lab_d02_settlement import (
                d02_freeze_for_provider_admission,
            )

            d02_freeze = d02_freeze_for_provider_admission(
                cleanup_obligation_id=body.cleanup_obligation_id,
                admission_id=admission_id,
                provider_session_id=body.resource_id,
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - never consume on authority outage.
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_d02_freeze_authority_unavailable"},
            ) from exc
        if d02_freeze is not None:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_d02_voice_terminal_receipt_required"},
            )

    from app.gateway.routers.sessions import _store
    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        complete_cleanup_admission,
        persist_cleanup_provider_terminal_receipt,
    )

    record = _store.find_session_by_cleanup_obligation_id(
        body.cleanup_obligation_id
    )
    canonical_trace_fault = _canonical_provider_trace_fault_restore_receipt(
        record,
        body.trace_fault,
    )

    matches = [
        admission
        for admission in cleanup_admissions(body.cleanup_obligation_id)
        if admission.admission_id == admission_id
        and admission.resource_kind == body.resource_kind
        and admission.resource_id == body.resource_id
    ]
    if len(matches) > 1:
        raise HTTPException(
            status_code=409,
            detail={"code": "cleanup_admission_binding_conflict"},
        )
    if not matches:
        if canonical_trace_fault is not None and not _session_has_provider_trace_fault(
            record,
            canonical_trace_fault,
            cleanup_obligation_id=body.cleanup_obligation_id,
            admission_id=admission_id,
            resource_id=body.resource_id,
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "cleanup_provider_trace_fault_replay_missing"},
            )
        return {
            "completed": True,
            "already_terminal": True,
            **(
                {"trace_fault": canonical_trace_fault}
                if canonical_trace_fault is not None
                else {}
            ),
        }
    admission = matches[0]
    if canonical_trace_fault is not None:
        if record is None:
            raise HTTPException(
                status_code=409,
                detail={"code": "cleanup_provider_trace_fault_session_missing"},
            )

        def persist_local(
            expected: dict[str, object], updates: dict[str, object]
        ) -> bool:
            current = _store.get(record.user_id, record.session_id)
            metadata = getattr(current, "metadata", None)
            synthetic = (
                metadata.get("synthetic_voice_lab")
                if isinstance(metadata, dict)
                else None
            )
            if not isinstance(synthetic, dict) or any(
                synthetic.get(key) != value for key, value in expected.items()
            ):
                return False
            next_synthetic = dict(synthetic)
            next_synthetic.update(updates)
            next_metadata = dict(metadata)
            next_metadata["synthetic_voice_lab"] = next_synthetic
            return (
                _store.update(
                    record.user_id,
                    record.session_id,
                    metadata=next_metadata,
                )
                is not None
            )

        try:
            persist_cleanup_provider_terminal_receipt(
                admission,
                user_id=record.user_id,
                session_id=record.session_id,
                receipt=canonical_trace_fault,
                local_persist=persist_local,
            )
        except Exception as exc:  # noqa: BLE001 - callback must fail closed.
            raise HTTPException(
                status_code=409,
                detail={"code": "cleanup_provider_trace_fault_persistence_failed"},
            ) from exc
    completed = complete_cleanup_admission(admission, basis=body.basis)
    return {
        "completed": completed,
        "already_terminal": False,
        "status": "completed" if completed else "pending_provider_terminal",
        **(
            {"trace_fault": canonical_trace_fault}
            if canonical_trace_fault is not None
            else {}
        ),
    }


def _component(status: str, **detail: object) -> dict[str, object]:
    return {"status": status, **detail}


def _body_is_present(request: Request) -> bool:
    content_length = request.headers.get("content-length")
    return bool(
        request.headers.get("transfer-encoding")
        or (content_length is not None and content_length.strip() != "0")
    )


def _recovery_id(claims: VoiceLabClaims) -> str:
    return _recovery_id_for_cleanup_obligation_id(claims.cleanup_obligation_id)


def _recovery_id_for_cleanup_obligation_id(cleanup_obligation_id: str) -> str:
    if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
        raise RuntimeError("cleanup obligation id is malformed")
    return hashlib.sha256(
        (
            "sophia_voice_lab_recovery_v2\0"
            f"{cleanup_obligation_id}"
        ).encode()
    ).hexdigest()


def _attempt_id(claims: VoiceLabClaims) -> str:
    """Return a stable, content-free identity for one signed recovery attempt."""
    return hashlib.sha256(
        f"{_recovery_id(claims)}\0{claims.jti}\0{claims.nonce}".encode()
    ).hexdigest()


def _recovery_secret() -> bytes:
    secret = (os.getenv("SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET") or "").strip()
    if len(secret.encode()) < 32:
        raise RuntimeError("voice lab recovery secret is unavailable")
    return secret.encode()


def _auth_tombstone_keyring() -> tuple[str, dict[str, bytes]]:
    active_kid = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID") or "v1"
    ).strip()
    if not _AUTH_TOMBSTONE_KID.fullmatch(active_kid):
        raise RuntimeError("voice lab auth tombstone active kid is invalid")
    encoded = (os.getenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS") or "").strip()
    production = bool(
        (os.getenv("RENDER") or "").strip().lower() == "true"
        or (os.getenv("RENDER_SERVICE_ID") or "").strip()
        or (os.getenv("ENVIRONMENT") or "").strip().lower() == "production"
    )
    if production and not encoded:
        raise RuntimeError("voice lab auth tombstone keyring is required")
    if encoded:
        duplicate_kids = False

        def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
            nonlocal duplicate_kids
            result: dict[str, object] = {}
            for name, value in pairs:
                if name in result:
                    duplicate_kids = True
                result[name] = value
            return result

        try:
            parsed = json.loads(encoded, object_pairs_hook=_unique_object)
        except json.JSONDecodeError as exc:
            raise RuntimeError("voice lab auth tombstone keyring is malformed") from exc
        if duplicate_kids or not isinstance(parsed, dict) or not parsed:
            raise RuntimeError("voice lab auth tombstone keyring is malformed")
        entries = list(parsed.items())
    else:
        entries = [
            (
                active_kid,
                (os.getenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_SECRET") or "").strip(),
            )
        ]
    if not 1 <= len(entries) <= 4:
        raise RuntimeError("voice lab auth tombstone keyring size is invalid")
    keys: dict[str, bytes] = {}
    for kid, secret in entries:
        if (
            not isinstance(kid, str)
            or not _AUTH_TOMBSTONE_KID.fullmatch(kid)
            or kid in keys
            or not isinstance(secret, str)
            or len(secret.strip().encode()) < 32
        ):
            raise RuntimeError("voice lab auth tombstone keyring is invalid")
        keys[kid] = secret.strip().encode()
    if active_kid not in keys or len(set(keys.values())) != len(keys):
        raise RuntimeError("voice lab auth tombstone keyring is invalid")
    protected_secrets = {
        (os.getenv(name) or "").strip().encode()
        for name in (
            "SOPHIA_VOICE_LAB_CAPABILITY_SECRET",
            "SOPHIA_VOICE_LAB_GRANT_SECRET",
            "SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET",
        )
        if (os.getenv(name) or "").strip()
    }
    if any(
        any(hmac.compare_digest(secret, other) for other in protected_secrets)
        for secret in keys.values()
    ):
        raise RuntimeError("voice lab auth tombstone secret is not distinct")
    return active_kid, keys


def _auth_tombstone_identity(
    kind: str,
    value: str,
    *,
    kid: str | None = None,
) -> str:
    active_kid, keys = _auth_tombstone_keyring()
    selected_kid = kid or active_kid
    secret = keys.get(selected_kid)
    if secret is None:
        raise RuntimeError("voice lab auth tombstone key id is unavailable")
    digest = hmac.new(
        secret,
        (
            f"{_AUTH_TOMBSTONE_DOMAIN}\0{selected_kid}\0"
            f"{kind}\0{value}"
        ).encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"hmac:{selected_kid}:{digest}"


def _auth_tombstone_candidates(kind: str, value: str) -> tuple[str, ...]:
    _active_kid, keys = _auth_tombstone_keyring()
    return tuple(
        _auth_tombstone_identity(kind, value, kid=kid)
        for kid in sorted(keys)
    )


def _assert_auth_tombstone_keyring_drain_ready_sync() -> None:
    """Refuse key removal while any unexpired ledger row still names that kid."""

    _active_kid, keys = _auth_tombstone_keyring()
    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    if not dsn:
        raise RuntimeError("voice lab auth tombstone database is unavailable")
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT DISTINCT "tombstone_kid" '
                'FROM public."sophia_voice_lab_auth_grants" '
                'WHERE "expires_at" > NOW()'
            )
            live_kids = {str(row[0]) for row in cursor.fetchall()}
    if not live_kids.issubset(keys):
        raise RuntimeError("voice lab auth tombstone key removal is not drained")


def _recovery_id_hmac(stable_recovery_id: str) -> str:
    if not _HASH_64.fullmatch(stable_recovery_id):
        raise RuntimeError("stable recovery identity is malformed")
    return hmac.new(
        _recovery_secret(),
        stable_recovery_id.encode(),
        hashlib.sha256,
    ).hexdigest()


def _canonical_utc_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
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


def _retention_cleanup_handle_path(claims: VoiceLabClaims) -> str:
    return _retention_cleanup_handle_path_for_id(claims.cleanup_obligation_id)


def _retention_cleanup_handle_path_for_id(cleanup_obligation_id: str) -> str:
    if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
        raise RuntimeError("retention cleanup obligation id is malformed")
    return (
        f"{_RETENTION_CLEANUP_HANDLE_ROOT}/"
        f"{_cleanup_obligation_id_hmac(cleanup_obligation_id)}.json"
    )


def _cleanup_obligation_id_hmac(cleanup_obligation_id: str) -> str:
    if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
        raise RuntimeError("retention cleanup obligation id is malformed")
    return hmac.new(
        _recovery_secret(),
        f"sophia-voice-lab-cleanup-obligation-v2\0{cleanup_obligation_id}".encode(),
        hashlib.sha256,
    ).hexdigest()


def _validate_retention_cleanup_intent(
    value: object,
    *,
    object_path: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _RETENTION_CLEANUP_HANDLE_FIELDS:
        raise RuntimeError("retention cleanup intent drifted")
    cleanup_obligation_id = value.get("cleanup_obligation_id")
    prepared_at = _parse_canonical_utc_millis(value.get("prepared_at"))
    retention_expires_at = _parse_canonical_utc_millis(
        value.get("retention_expires_at")
    )
    provider_expires_at = _parse_canonical_utc_millis(
        value.get("provider_expires_at")
    )
    control_expires_at = _parse_canonical_utc_millis(
        value.get("control_expires_at")
    )
    retention_sla_missed = value.get("retention_sla_missed")
    overdue_seconds = value.get("overdue_seconds_at_preparation")
    if (
        value.get("schema") != "sophia_voice_lab_retention_cleanup_intent_v2"
        or not isinstance(cleanup_obligation_id, str)
        or not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id)
        or value.get("cleanup_obligation_id_hmac")
        != _cleanup_obligation_id_hmac(cleanup_obligation_id)
        or value.get("cleanup_mode")
        not in {
            "provisional_session",
            "canonical_session",
            "orphan_finalization",
            "builder_global",
        }
        or prepared_at is None
        or retention_expires_at is None
        or provider_expires_at is None
        or provider_expires_at > retention_expires_at
        or prepared_at < retention_expires_at
        or not isinstance(retention_sla_missed, bool)
        or not isinstance(overdue_seconds, int)
        or isinstance(overdue_seconds, bool)
        or overdue_seconds < 0
        or retention_sla_missed
        != (prepared_at > retention_expires_at + _RETENTION_CLEANUP_HANDLE_GRACE)
        or overdue_seconds
        != max(0, int((prepared_at - retention_expires_at).total_seconds()))
        or control_expires_at
        != (
            prepared_at + _RETENTION_CLEANUP_HANDLE_GRACE
            if retention_sla_missed
            else retention_expires_at + _RETENTION_CLEANUP_HANDLE_GRACE
        )
        or value.get("retention_policy")
        != "opaque_prepared_cleanup_authority"
    ):
        raise RuntimeError("retention cleanup intent drifted")
    expected_path = _retention_cleanup_handle_path_for_id(cleanup_obligation_id)
    if object_path != expected_path:
        raise RuntimeError("retention cleanup intent path binding drifted")
    return dict(value)


def _open_retention_cleanup_handle(
    object_path: str,
    raw: bytes,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if len(raw) > _RETENTION_CLEANUP_HANDLE_MAX_BYTES:
        raise RuntimeError("retention cleanup handle exceeded its hard size bound")
    try:
        envelope = json.loads(raw.decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("retention cleanup intent is malformed") from exc
    intent = _validate_retention_cleanup_intent(envelope, object_path=object_path)
    return intent, intent


def _ensure_retention_cleanup_handle(
    claims: VoiceLabClaims,
    *,
    retention_expires_at: str,
    cleanup_mode: str,
    session_id: str | None,
    thread_id: str | None,
) -> str:
    """Persist an opaque PREPARED authority before deleting the final source."""

    return _ensure_retention_cleanup_handle_for_id(
        claims.cleanup_obligation_id,
        retention_expires_at=retention_expires_at,
        provider_expires_at=claims.provider_expires_at,
        cleanup_mode=cleanup_mode,
    )


def _ensure_retention_cleanup_handle_for_id(
    cleanup_obligation_id: str,
    *,
    retention_expires_at: str,
    provider_expires_at: str,
    cleanup_mode: str,
) -> str:
    """Create or retain the last content-free opaque cleanup authority."""

    from deerflow.sophia.storage import supabase_artifact_store

    if not supabase_artifact_store.is_configured():
        raise RuntimeError("durable retention cleanup handle store is unavailable")
    object_path = _retention_cleanup_handle_path_for_id(cleanup_obligation_id)
    deadline = _parse_canonical_utc_millis(retention_expires_at)
    provider_deadline = _parse_canonical_utc_millis(provider_expires_at)
    if deadline is None or provider_deadline is None or provider_deadline > deadline:
        raise RuntimeError("retention cleanup intent deadline is malformed")
    def persist(prepared_at: datetime) -> str:
        prepared_at = prepared_at.astimezone(UTC)
        if prepared_at < deadline:
            raise RuntimeError("retention cleanup intent predates its signed deadline")
        retention_sla_missed = (
            prepared_at > deadline + _RETENTION_CLEANUP_HANDLE_GRACE
        )
        control_expires_at = (
            prepared_at + _RETENTION_CLEANUP_HANDLE_GRACE
            if retention_sla_missed
            else deadline + _RETENTION_CLEANUP_HANDLE_GRACE
        )
        payload: dict[str, Any] = {
            "schema": "sophia_voice_lab_retention_cleanup_intent_v2",
            "cleanup_obligation_id": cleanup_obligation_id,
            "cleanup_obligation_id_hmac": _cleanup_obligation_id_hmac(
                cleanup_obligation_id
            ),
            "prepared_at": _canonical_utc_millis(prepared_at),
            "retention_expires_at": retention_expires_at,
            "provider_expires_at": provider_expires_at,
            "control_expires_at": _canonical_utc_millis(control_expires_at),
            "cleanup_mode": cleanup_mode,
            "retention_sla_missed": retention_sla_missed,
            "overdue_seconds_at_preparation": max(
                0,
                int((prepared_at - deadline).total_seconds()),
            ),
            "retention_policy": "opaque_prepared_cleanup_authority",
        }
        _validate_retention_cleanup_intent(payload, object_path=object_path)
        serialized = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        if len(serialized) > _RETENTION_CLEANUP_HANDLE_MAX_BYTES:
            raise RuntimeError(
                "retention cleanup handle exceeded its hard size bound"
            )
        for _attempt in range(2):
            result = supabase_artifact_store.create_artifact_object_if_absent(
                object_path,
                serialized,
                content_type="application/json",
            )
            if result != "exists":
                return object_path
            stored = supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
            )
            if (
                stored is None
                or stored[1].split(";", 1)[0].strip().lower()
                != "application/json"
            ):
                raise RuntimeError("retention cleanup handle disappeared")
            existing_payload, _existing_envelope = _open_retention_cleanup_handle(
                object_path,
                stored[0],
            )
            # ``control_expires_at`` is an SLO/degraded-readiness target,
            # never an erasure deadline for the last actionable cleanup UUID.
            immutable_keys = {
                "cleanup_obligation_id",
                "cleanup_obligation_id_hmac",
                "retention_expires_at",
                "provider_expires_at",
                "cleanup_mode",
                "retention_policy",
            }
            if any(
                existing_payload[key] != payload[key] for key in immutable_keys
            ):
                raise RuntimeError("retention cleanup intent binding conflict")
            return object_path
        raise RuntimeError("retention cleanup intent creation failed")

    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    if not dsn:
        from deerflow.sophia.cleanup_fence import local_cleanup_prepared_guard

        with local_cleanup_prepared_guard(
            cleanup_obligation_id,
            retention_expires_at,
            provider_expires_at,
        ):
            return persist(datetime.now(UTC))
    with _cleanup_obligation_database_barrier(cleanup_obligation_id) as cursor:
        from deerflow.sophia.cleanup_fence import (
            cleanup_retention_prepared_authorized_with_cursor,
        )

        prepared_at = cleanup_retention_prepared_authorized_with_cursor(
            cursor,
            cleanup_obligation_id,
            retention_expires_at,
            provider_expires_at,
        )
        if prepared_at is None:
            raise RuntimeError("retention cleanup intent predates database deadline")
        return persist(prepared_at)


def _list_retention_cleanup_handles_bounded(
    *,
    limit: int,
) -> tuple[list[tuple[str, dict[str, Any], dict[str, Any]]], int]:
    """Enumerate bounded opaque retry authorities without raw run identity."""

    from deerflow.sophia.storage import supabase_artifact_store

    if not 1 <= limit <= _RETENTION_CLEANUP_HANDLE_MAX_OBJECTS:
        raise ValueError("retention cleanup handle scan limit is invalid")
    if not supabase_artifact_store.is_configured():
        return [], 0
    paths = supabase_artifact_store.list_artifact_object_paths_bounded(
        _RETENTION_CLEANUP_HANDLE_ROOT,
        max_objects=_RETENTION_CLEANUP_HANDLE_MAX_OBJECTS,
        max_depth=1,
        page_size=100,
    )
    opened: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    invalid = 0
    for object_path in sorted(paths):
        if len(opened) >= limit:
            break
        try:
            stored = supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
            )
            if stored is None or stored[1].split(";", 1)[0].strip().lower() != "application/json":
                raise RuntimeError("retention cleanup handle is unavailable")
            payload, envelope = _open_retention_cleanup_handle(object_path, stored[0])
            opened.append((object_path, payload, envelope))
        except (OSError, RuntimeError, ValueError):
            invalid += 1
    return opened, invalid


def _delete_retention_cleanup_handle(
    claims: VoiceLabClaims,
    *,
    expected_path: str | None = None,
) -> None:
    from deerflow.sophia.storage import supabase_artifact_store

    object_path = _retention_cleanup_handle_path(claims)
    if expected_path is not None and expected_path != object_path:
        raise RuntimeError("retention cleanup handle delete binding drifted")
    supabase_artifact_store.delete_artifact_object_if_present(object_path)
    if (
        supabase_artifact_store.download_artifact_object_bounded(
            object_path,
            max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
        )
        is not None
    ):
        raise RuntimeError("retention cleanup handle deletion was not verified")


def _cleanup_obligation_product_sources_zero(
    cleanup_obligation_id: str,
) -> bool:
    """Read-verify every durable product evidence index for one opaque id."""

    from app.gateway.artifact_registry import ArtifactRegistry
    from app.gateway.routers.sessions import _store
    from app.gateway.routers.voice_lab_d02_settlement import (
        d02_cleanup_sources_zero,
    )
    from deerflow.agents.sophia_agent.paths import USERS_DIR
    from deerflow.sophia.storage import supabase_artifact_store

    if not d02_cleanup_sources_zero(cleanup_obligation_id):
        return False
    if _store.find_session_by_cleanup_obligation_id(cleanup_obligation_id) is not None:
        return False
    if ArtifactRegistry().synthetic_cleanup_obligation_records(
        cleanup_obligation_id=cleanup_obligation_id,
    ):
        return False
    durable_path = (
        ".builder/voice_lab_evidence/finalizations/v2/"
        f"{cleanup_obligation_id}.json"
    )
    if supabase_artifact_store.is_configured() and (
        supabase_artifact_store.download_artifact_object_bounded(
            durable_path,
            max_bytes=2 * 1024 * 1024,
        )
        is not None
    ):
        return False
    local_matches = list(
        Path(USERS_DIR).glob(
            "*/synthetic_voice_lab/finalizations/"
            f"{cleanup_obligation_id}.json"
        )
    )
    return not local_matches


@contextmanager
def _cleanup_obligation_database_barrier(cleanup_obligation_id: str):  # noqa: ANN201
    """Serialize final zero proof with every synthetic product-table write."""

    if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
        raise RuntimeError("cleanup obligation id is malformed")
    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    if not dsn:
        raise RuntimeError("cleanup obligation barrier database is unavailable")
    import psycopg

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 731944))",
                (cleanup_obligation_id,),
            )
            yield cursor


def _auth_cleanup_obligation_sources_zero(cursor: Any, cleanup_obligation_id: str) -> bool:
    candidates = (
        cleanup_obligation_id,
        *_auth_tombstone_candidates("cleanup", cleanup_obligation_id),
    )
    cursor.execute(
        'SELECT 1 FROM public."sophia_voice_lab_auth_grants" '
        'WHERE "cleanup_obligation_id" = ANY(%s) LIMIT 1',
        (list(candidates),),
    )
    return cursor.fetchone() is None


def _auth_cleanup_obligation_live_sources_zero(
    cursor: Any,
    cleanup_obligation_id: str,
    *,
    provider_expires_at: datetime,
) -> bool:
    """Accept only content-free revoked replay rows after auth live cleanup."""

    _active_kid, tombstone_keys = _auth_tombstone_keyring()
    cleanup_tombstones = set(
        _auth_tombstone_candidates("cleanup", cleanup_obligation_id)
    )
    cursor.execute(
        """
        SELECT cleanup_obligation_id, principal_id, test_run_id,
               tombstone_kid, provider_expires_at, jti_sha256,
               nonce_sha256, session_token_sha256, status, revoked_at
          FROM public.sophia_voice_lab_auth_grants
         WHERE cleanup_obligation_id = ANY(%s)
         FOR UPDATE
        """,
        ([cleanup_obligation_id, *sorted(cleanup_tombstones)],),
    )
    for row in cursor.fetchall():
        cleanup_tombstone = str(row[0])
        principal_tombstone = str(row[1])
        run_tombstone = str(row[2])
        tombstone_kid = str(row[3])

        def valid_tombstone(value: str) -> bool:
            parts = value.split(":")
            return (
                len(parts) == 3
                and parts[0] == "hmac"
                and parts[1] == tombstone_kid
                and _HASH_64.fullmatch(parts[2]) is not None
            )

        if (
            cleanup_tombstone not in cleanup_tombstones
            or tombstone_kid not in tombstone_keys
            or not valid_tombstone(cleanup_tombstone)
            or not valid_tombstone(principal_tombstone)
            or not valid_tombstone(run_tombstone)
            or row[4] != provider_expires_at
            or str(row[5]) != _REDACTED_SHA256
            or str(row[6]) != _REDACTED_SHA256
            or str(row[7]) != _REDACTED_SHA256
            or str(row[8]) != "revoked"
            or not isinstance(row[9], datetime)
        ):
            return False
    return True


def _cleanup_auth_obligation_sources_by_id(
    cleanup_obligation_id: str,
    *,
    retention_expires_at: str,
    provider_expires_at: str,
    live_cleanup: bool = False,
) -> bool:
    """Tombstone/delete an opaque obligation's exact auth-ledger sources.

    The first locator read is deliberately non-authoritative.  It only lets us
    preserve the frontend's principal-lock -> cleanup-lock order.  The second
    transaction re-reads every binding under both locks before it mutates any
    grant or Better Auth session.  A CLOSED obligation prevents a new active
    grant from appearing after the locator read.
    """

    cleanup_id = str(cleanup_obligation_id)
    retention_deadline = _parse_canonical_utc_millis(retention_expires_at)
    provider_deadline = _parse_canonical_utc_millis(provider_expires_at)
    if (
        not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_id)
        or retention_deadline is None
        or provider_deadline is None
        or provider_deadline > retention_deadline
        or not isinstance(live_cleanup, bool)
    ):
        raise RuntimeError("opaque auth cleanup binding is malformed")
    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    if not dsn:
        if _durable_evidence_required():
            raise RuntimeError("voice lab auth tombstone database is unavailable")
        return True
    import psycopg

    _active_kid, tombstone_keys = _auth_tombstone_keyring()
    cleanup_candidates = (
        cleanup_id,
        *_auth_tombstone_candidates("cleanup", cleanup_id),
    )
    with psycopg.connect(dsn, connect_timeout=5) as locator_connection:
        with locator_connection.cursor() as locator_cursor:
            locator_cursor.execute(
                'SELECT "principal_id" '
                'FROM public."sophia_voice_lab_auth_grants" '
                'WHERE "cleanup_obligation_id" = %s AND "status" = \'active\'',
                (cleanup_id,),
            )
            principal_rows = locator_cursor.fetchall()
    if len(principal_rows) > 1:
        raise RuntimeError("opaque auth cleanup locator is ambiguous")
    principal_locator = (
        str(principal_rows[0][0]) if principal_rows else None
    )

    with psycopg.connect(dsn, connect_timeout=5) as connection:
        with connection.cursor() as cursor:
            if principal_locator is not None:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 731941))",
                    (principal_locator,),
                )
            cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 731944))",
                (cleanup_id,),
            )
            cursor.execute(
                """
                SELECT state, lifecycle_phase, retention_expires_at,
                       provider_expires_at,
                       clock_timestamp() >= retention_expires_at
                  FROM public.sophia_voice_lab_cleanup_obligations
                 WHERE cleanup_obligation_id = %s
                 FOR UPDATE
                """,
                (cleanup_id,),
            )
            obligation_row = cursor.fetchone()
            if (
                obligation_row is None
                or str(obligation_row[0]) != "closed"
                or obligation_row[2] != retention_deadline
                or obligation_row[3] != provider_deadline
                or (
                    obligation_row[4] is not True
                    and not (
                        live_cleanup
                        and str(obligation_row[1]) == "auth_provisional"
                    )
                )
            ):
                raise RuntimeError("opaque auth cleanup fence is unavailable")
            cursor.execute(
                """
                SELECT grant_fingerprint, principal_id, test_run_id,
                       tombstone_kid, cleanup_obligation_id, issued_at,
                       expires_at, provider_expires_at, retention_hours,
                       jti_sha256, nonce_sha256, session_token_sha256, status,
                       revoked_at
                  FROM public.sophia_voice_lab_auth_grants
                 WHERE cleanup_obligation_id = ANY(%s)
                 FOR UPDATE
                """,
                (list(cleanup_candidates),),
            )
            grant_rows = cursor.fetchall()
            active_rows = [row for row in grant_rows if str(row[12]) == "active"]
            if len(active_rows) > 1:
                raise RuntimeError("opaque auth cleanup grant is ambiguous")
            if active_rows:
                row = active_rows[0]
                principal_id = str(row[1])
                test_run_id = str(row[2])
                tombstone_kid = str(row[3])
                if (
                    principal_locator is None
                    or principal_id != principal_locator
                    or str(row[4]) != cleanup_id
                    or tombstone_kid not in tombstone_keys
                    or row[7] != provider_deadline
                    or not isinstance(row[5], int)
                    or isinstance(row[5], bool)
                    or not isinstance(row[8], int)
                    or isinstance(row[8], bool)
                    or not 1 <= row[8] <= 168
                    or not _HASH_64.fullmatch(str(row[9]))
                    or not _HASH_64.fullmatch(str(row[10]))
                    or not _HASH_64.fullmatch(str(row[11]))
                ):
                    raise RuntimeError("opaque auth cleanup binding drifted")
                cursor.execute(
                    'SELECT "token", "userAgent" FROM public."session" '
                    'WHERE "userId" = %s FOR UPDATE',
                    (principal_id,),
                )
                session_rows = cursor.fetchall()
                for token, marker_value in session_rows:
                    marker = _parse_session_marker(marker_value)
                    if (
                        not isinstance(token, str)
                        or marker is None
                        or marker.get("principal_id") != principal_id
                        or marker.get("test_run_id") != test_run_id
                        or marker.get("tombstone_kid") != tombstone_kid
                        or marker.get("cleanup_obligation_id") != cleanup_id
                        or marker.get("issued_at") != row[5]
                        or not hmac.compare_digest(
                            str(marker.get("jti_sha256")), str(row[9])
                        )
                        or not hmac.compare_digest(
                            str(marker.get("nonce_sha256")), str(row[10])
                        )
                        or not hmac.compare_digest(
                            hashlib.sha256(token.encode()).hexdigest(),
                            str(row[11]),
                        )
                    ):
                        raise RuntimeError("opaque auth session binding drifted")
                cursor.execute(
                    """
                    UPDATE public.sophia_voice_lab_auth_grants
                       SET status = 'revoked',
                           revoked_at = COALESCE(revoked_at, clock_timestamp()),
                           principal_id = %s, test_run_id = %s,
                           cleanup_obligation_id = %s,
                           jti_sha256 = %s, nonce_sha256 = %s,
                           session_token_sha256 = %s
                     WHERE grant_fingerprint = %s
                       AND cleanup_obligation_id = %s
                       AND tombstone_kid = %s AND status = 'active'
                    """,
                    (
                        _auth_tombstone_identity(
                            "principal", principal_id, kid=tombstone_kid
                        ),
                        _auth_tombstone_identity(
                            "run", test_run_id, kid=tombstone_kid
                        ),
                        _auth_tombstone_identity(
                            "cleanup", cleanup_id, kid=tombstone_kid
                        ),
                        _REDACTED_SHA256,
                        _REDACTED_SHA256,
                        _REDACTED_SHA256,
                        str(row[0]),
                        cleanup_id,
                        tombstone_kid,
                    ),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("opaque auth tombstone was not committed")
                for token, _marker_value in session_rows:
                    cursor.execute(
                        'DELETE FROM public."session" '
                        'WHERE "userId" = %s AND "token" = %s',
                        (principal_id, token),
                    )
                    if cursor.rowcount != 1:
                        raise RuntimeError("opaque auth session deletion raced")

            if live_cleanup:
                if not _auth_cleanup_obligation_live_sources_zero(
                    cursor,
                    cleanup_id,
                    provider_expires_at=provider_deadline,
                ):
                    return False
            else:
                cursor.execute(
                    """
                    DELETE FROM public.sophia_voice_lab_auth_grants
                     WHERE cleanup_obligation_id = ANY(%s)
                       AND status = 'revoked'
                       AND tombstone_kid = ANY(%s)
                       AND expires_at <= clock_timestamp()
                    """,
                    (list(cleanup_candidates[1:]), list(tombstone_keys)),
                )
                cursor.execute(
                    """
                    SELECT 1 FROM public.sophia_voice_lab_auth_grants
                     WHERE cleanup_obligation_id = ANY(%s)
                     LIMIT 1
                    """,
                    (list(cleanup_candidates),),
                )
                if cursor.fetchone() is not None:
                    return False
            if principal_locator is not None:
                cursor.execute(
                    'SELECT 1 FROM public."session" '
                    'WHERE "userId" = %s LIMIT 1',
                    (principal_locator,),
                )
                if cursor.fetchone() is not None:
                    return False
    return True


def _cleanup_builder_obligation_sources_zero(
    cleanup_obligation_id: str,
    *,
    purge_artifacts: bool,
) -> bool:
    """Cancel/delete/read-zero Builder by opaque id from a worker thread.

    Retention completion is synchronous because it holds the PostgreSQL
    obligation barrier.  Every production caller invokes it through the
    reaper's fenced thread executor (the recovery endpoint does the same via
    ``asyncio.to_thread``), so a private event loop is safe and keeps the
    advisory lock held until LangGraph has returned an authoritative result.
    """

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError("Builder opaque cleanup must run off the event loop")
    from app.gateway.routers.builder_events import (
        cleanup_synthetic_builder_obligation,
    )

    result = asyncio.run(
        cleanup_synthetic_builder_obligation(
            cleanup_obligation_id,
            purge_artifacts=purge_artifacts,
        )
    )
    return bool(
        result.get("cleanup_complete")
        and result.get("discovery_complete")
        and result.get("authoritative_zero_tasks")
        and result.get("artifacts_cleanup_complete")
        and not result.get("binding_conflict")
        and int(result.get("unresolved_count") or 0) == 0
    )


def _finish_retention_cleanup_intent(
    cleanup_obligation_id: str,
    *,
    expected_path: str,
    now: datetime | None = None,
) -> dict[str, object]:
    """Finish only after exact opaque-id product indexes prove global zero."""

    from deerflow.sophia.storage import supabase_artifact_store

    object_path = _retention_cleanup_handle_path_for_id(cleanup_obligation_id)
    if object_path != expected_path:
        raise RuntimeError("retention cleanup intent finish binding drifted")
    stored = supabase_artifact_store.download_artifact_object_bounded(
        object_path,
        max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
    )
    if stored is None:
        stable_id = _recovery_id_for_cleanup_obligation_id(cleanup_obligation_id)
        tombstone = _load_recovery_purge_tombstone_for_id(stable_id)
        return {
            "status": "already_terminal" if tombstone is not None else "missing_unverified"
        }
    intent, _envelope = _open_retention_cleanup_handle(object_path, stored[0])
    observed_at = (now or datetime.now(UTC)).astimezone(UTC)
    control_expires_at = _parse_canonical_utc_millis(
        intent.get("control_expires_at")
    )

    def overdue_pending() -> dict[str, object]:
        return {
            "status": "pending",
            "control_window_overdue": bool(
                control_expires_at is not None
                and observed_at >= control_expires_at
            ),
            "raw_identity_excluded": True,
        }

    # Orphan/hard-retention recovery may never have traversed the live cleanup
    # endpoint. Commit CLOSED in a short first transaction before touching any
    # external Builder/product/auth source, so a queued producer can no longer
    # enter after this cleanup pass starts.
    with _cleanup_obligation_database_barrier(cleanup_obligation_id) as cursor:
        from deerflow.sophia.cleanup_fence import (
            cleanup_retention_due_before_close_with_cursor,
            cleanup_retention_expired_with_cursor,
            close_cleanup_obligation_with_cursor,
        )

        if not cleanup_retention_due_before_close_with_cursor(
            cursor,
            cleanup_obligation_id,
            str(intent["retention_expires_at"]),
            str(intent["provider_expires_at"]),
        ):
            return overdue_pending()
        initial_fence = close_cleanup_obligation_with_cursor(
            cursor,
            cleanup_obligation_id,
            str(intent["retention_expires_at"]),
            str(intent["provider_expires_at"]),
        )
        if initial_fence.active_admissions or initial_fence.expired_admissions:
            return overdue_pending()
        if not cleanup_retention_expired_with_cursor(
            cursor,
            cleanup_obligation_id,
            str(intent["retention_expires_at"]),
            str(intent["provider_expires_at"]),
        ):
            return overdue_pending()

    try:
        auth_zero = _cleanup_auth_obligation_sources_by_id(
            cleanup_obligation_id,
            retention_expires_at=str(intent["retention_expires_at"]),
            provider_expires_at=str(intent["provider_expires_at"]),
        )
    except Exception:  # noqa: BLE001 - CLOSED/PREPARED remains retry authority.
        auth_zero = False
    if not auth_zero:
        return overdue_pending()

    # First remove all opaque-indexed Builder resources outside the database
    # barrier. Artifact metadata DELETEs acquire that same barrier through the
    # SQL trigger, so doing this phase while holding it would self-deadlock.
    try:
        builder_zero = _cleanup_builder_obligation_sources_zero(
            cleanup_obligation_id,
            purge_artifacts=True,
        )
    except Exception:  # noqa: BLE001 - retain content-free retry authority.
        builder_zero = False
    if not builder_zero:
        # The random UUID is content-free cleanup authority.  Never erase the
        # last authority merely because its control target elapsed: a Builder
        # exception proves neither zero nor an independently enumerable source.
        return overdue_pending()
    with _cleanup_obligation_database_barrier(cleanup_obligation_id) as cursor:
        from deerflow.sophia.cleanup_fence import (
            cleanup_retention_expired_with_cursor,
            close_cleanup_obligation_with_cursor,
            mark_cleanup_live_zero_with_cursor,
            mark_cleanup_obligation_complete_with_cursor,
        )

        fence = close_cleanup_obligation_with_cursor(
            cursor,
            cleanup_obligation_id,
            str(intent["retention_expires_at"]),
            str(intent["provider_expires_at"]),
        )
        if fence.active_admissions or fence.expired_admissions:
            return overdue_pending()
        if not cleanup_retention_expired_with_cursor(
            cursor,
            cleanup_obligation_id,
            str(intent["retention_expires_at"]),
            str(intent["provider_expires_at"]),
        ):
            return overdue_pending()
        if (
            not _cleanup_builder_obligation_sources_zero(
                cleanup_obligation_id,
                purge_artifacts=False,
            )
            or not _cleanup_obligation_product_sources_zero(cleanup_obligation_id)
            or not _auth_cleanup_obligation_sources_zero(
                cursor, cleanup_obligation_id
            )
        ):
            return overdue_pending()
        stable_id = _recovery_id_for_cleanup_obligation_id(cleanup_obligation_id)
        with _recovery_receipt_fence_lock(stable_id):
            _prepare_recovery_receipt_purge_for_id(stable_id)
            # Re-read every indexed product/auth source under the same durable
            # DB barrier immediately before COMPLETE.
            if (
                not _cleanup_builder_obligation_sources_zero(
                    cleanup_obligation_id,
                    purge_artifacts=False,
                )
                or not _cleanup_obligation_product_sources_zero(
                    cleanup_obligation_id
                )
                or not _auth_cleanup_obligation_sources_zero(
                    cursor, cleanup_obligation_id
                )
            ):
                return overdue_pending()
            tombstone, receipt = _complete_recovery_receipt_purge_for_id(stable_id)
        # Delete/read-zero PREPARED before COMPLETE while the shared product
        # barrier is still held. A crash after this point leaves CLOSED as the
        # database scanner's durable retry authority; COMPLETE can therefore
        # never coexist with a surviving, later-stranded PREPARED handle.
        supabase_artifact_store.delete_artifact_object_if_present(object_path)
        if supabase_artifact_store.download_artifact_object_bounded(
            object_path,
            max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
        ) is not None:
            raise RuntimeError("retention cleanup intent deletion was not verified")
        if (
            not _cleanup_builder_obligation_sources_zero(
                cleanup_obligation_id,
                purge_artifacts=False,
            )
            or not _cleanup_obligation_product_sources_zero(cleanup_obligation_id)
            or not _auth_cleanup_obligation_sources_zero(
                cursor, cleanup_obligation_id
            )
        ):
            raise RuntimeError("cleanup sources reappeared before completion")
        if fence.state != "complete":
            mark_cleanup_live_zero_with_cursor(
                cursor,
                cleanup_obligation_id,
                str(intent["retention_expires_at"]),
                str(intent["provider_expires_at"]),
            )
            mark_cleanup_obligation_complete_with_cursor(
                cursor,
                cleanup_obligation_id,
            )
    return {
        "status": "completed",
        "recovery_receipts_deleted": int(tombstone["recovery_receipts_deleted"]),
        "purge_tombstone_receipt": receipt,
    }


def _completed_cleanup_fence_purge_eligible(
    cleanup_obligation_id: str,
) -> bool:
    """Prove PREPARED absent and the immutable receipt tombstone present."""

    from deerflow.sophia.storage import supabase_artifact_store

    if not supabase_artifact_store.is_configured():
        raise RuntimeError("cleanup COMPLETE purge authority is unavailable")
    object_path = _retention_cleanup_handle_path_for_id(cleanup_obligation_id)
    stored = supabase_artifact_store.download_artifact_object_bounded(
        object_path,
        max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
    )
    if stored is not None:
        if stored[1].split(";", 1)[0].strip().lower() != "application/json":
            raise RuntimeError("retention cleanup handle content type drifted")
        _open_retention_cleanup_handle(object_path, stored[0])
        return False
    stable_id = _recovery_id_for_cleanup_obligation_id(cleanup_obligation_id)
    return _load_recovery_purge_tombstone_for_id(stable_id) is not None


def _reconcile_database_cleanup_admissions(work: Any) -> bool:
    """Settle only opaque admissions whose external zero is independently provable."""

    from app.gateway.routers import sessions
    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        complete_cleanup_admission,
        release_cleanup_admission,
    )

    admissions = work.admissions
    if not isinstance(admissions, tuple) or any(
        not admission.expired for admission in admissions
    ):
        return False
    for admission in admissions:
        if (
            not isinstance(admission.resource_id, str)
            or not admission.resource_id
            or admission.resource_expires_at is None
        ):
            return False
        if admission.resource_kind == "provider":
            # ``reserved`` is the only durable proof that Voice allocation was
            # never dispatched. Allocating/minted/browser states still require
            # an owning Voice/browser terminal receipt and remain actionable.
            if admission.status != "reserved":
                return False
            consumed = complete_cleanup_admission(
                admission,
                basis="server_relay_zero",
            )
            if not consumed and any(
                item.admission_id == admission.admission_id
                for item in cleanup_admissions(work.cleanup_obligation_id)
            ):
                return False
            continue
        if admission.resource_kind not in {"session", "builder"}:
            return False
        if admission.status != "reserved":
            return False
        fenced = asyncio.run(
            sessions._fence_langgraph_thread_cleanup_admission(
                admission.resource_id,
                cleanup_obligation_id_hmac=_cleanup_obligation_id_hmac(
                    work.cleanup_obligation_id
                ),
                retention_expires_at=admission.resource_expires_at,
            )
        )
        if not fenced:
            return False
        if admission.resource_kind == "builder" and not (
            _cleanup_builder_obligation_sources_zero(
                work.cleanup_obligation_id,
                purge_artifacts=True,
            )
        ):
            return False
        release_cleanup_admission(admission)
        if any(
            item.admission_id == admission.admission_id
            for item in cleanup_admissions(work.cleanup_obligation_id)
        ):
            return False
    return True


def _finish_database_cleanup_fence_work(
    work: Any,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Finish a due opaque CLOSED row after all owning indexes read zero."""

    from deerflow.sophia.storage import supabase_artifact_store

    cleanup_obligation_id = str(work.cleanup_obligation_id)
    retention_text = _canonical_utc_millis(work.retention_expires_at)
    provider_text = _canonical_utc_millis(work.provider_expires_at)
    if (
        not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id)
        or work.state not in {"open", "closed"}
        or work.lifecycle_phase
        not in {
            "auth_provisional",
            "session_provisional",
            "finalizing",
            "finalized",
        }
        or not isinstance(work.retention_due, bool)
        or not isinstance(work.provider_due, bool)
        or not isinstance(work.admissions, tuple)
    ):
        return _component(
            "pending",
            code="cleanup_database_work_not_retention_due",
        )

    def pending(code: str) -> dict[str, object]:
        return _component("pending", code=code, raw_identity_excluded=True)

    try:
        from deerflow.sophia.cleanup_fence import (
            refresh_cleanup_fence_work_for_reconciliation,
        )

        work = refresh_cleanup_fence_work_for_reconciliation(
            cleanup_obligation_id,
            retention_text,
            provider_text,
        )
    except Exception:  # noqa: BLE001 - durable DB row remains retry authority.
        return pending("cleanup_database_work_reconciliation_lock_pending")
    try:
        admissions_zero = _reconcile_database_cleanup_admissions(work)
    except Exception:  # noqa: BLE001 - exact admissions remain restart authority.
        admissions_zero = False
    if not admissions_zero:
        return pending("cleanup_database_work_admissions_pending")
    if not work.retention_due:
        if work.state != "closed":
            return _component(
                "completed",
                retention_purge_pending=True,
                raw_identity_excluded=True,
            )
        if work.lifecycle_phase != "auth_provisional":
            return pending("cleanup_database_work_live_sources_pending")
        try:
            auth_zero = _cleanup_auth_obligation_sources_by_id(
                cleanup_obligation_id,
                retention_expires_at=retention_text,
                provider_expires_at=provider_text,
                live_cleanup=True,
            )
        except Exception:  # noqa: BLE001 - CLOSED remains immediate retry authority.
            auth_zero = False
        if not auth_zero:
            return pending("cleanup_database_work_auth_pending")
        try:
            builder_zero = _cleanup_builder_obligation_sources_zero(
                cleanup_obligation_id,
                purge_artifacts=True,
            )
        except Exception:  # noqa: BLE001 - CLOSED remains immediate retry authority.
            builder_zero = False
        if not builder_zero:
            return pending("cleanup_database_work_builder_pending")
        provider_deadline = _parse_canonical_utc_millis(provider_text)
        if provider_deadline is None:
            return pending("cleanup_database_work_binding_pending")
        with _cleanup_obligation_database_barrier(cleanup_obligation_id) as cursor:
            from deerflow.sophia.cleanup_fence import (
                close_cleanup_obligation_with_cursor,
                mark_cleanup_live_zero_with_cursor,
            )

            fence = close_cleanup_obligation_with_cursor(
                cursor,
                cleanup_obligation_id,
                retention_text,
                provider_text,
            )
            if fence.active_admissions or fence.expired_admissions:
                return pending("cleanup_database_work_admissions_pending")
            if (
                not _cleanup_builder_obligation_sources_zero(
                    cleanup_obligation_id,
                    purge_artifacts=False,
                )
                or not _cleanup_obligation_product_sources_zero(
                    cleanup_obligation_id
                )
                or not _auth_cleanup_obligation_live_sources_zero(
                    cursor,
                    cleanup_obligation_id,
                    provider_expires_at=provider_deadline,
                )
            ):
                return pending("cleanup_database_work_sources_pending")
            mark_cleanup_live_zero_with_cursor(
                cursor,
                cleanup_obligation_id,
                retention_text,
                provider_text,
            )
        return _component(
            "completed",
            retention_purge_pending=True,
            live_cleanup_completed=True,
            raw_identity_excluded=True,
        )
    if not supabase_artifact_store.is_configured():
        return pending("cleanup_database_work_durable_authority_unavailable")
    object_path = _retention_cleanup_handle_path_for_id(cleanup_obligation_id)
    stored = supabase_artifact_store.download_artifact_object_bounded(
        object_path,
        max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
    )
    if stored is not None:
        if stored[1].split(";", 1)[0].strip().lower() != "application/json":
            raise RuntimeError("retention cleanup handle content type drifted")
        intent, _envelope = _open_retention_cleanup_handle(object_path, stored[0])
        if (
            intent.get("retention_expires_at") != retention_text
            or intent.get("provider_expires_at") != provider_text
        ):
            raise RuntimeError("retention cleanup handle deadline conflicts")
        return _finish_retention_cleanup_intent(
            cleanup_obligation_id,
            expected_path=object_path,
            now=now,
        )

    with _cleanup_obligation_database_barrier(cleanup_obligation_id) as cursor:
        from deerflow.sophia.cleanup_fence import (
            cleanup_retention_due_before_close_with_cursor,
            cleanup_retention_expired_with_cursor,
            close_cleanup_obligation_with_cursor,
        )

        if not cleanup_retention_due_before_close_with_cursor(
            cursor,
            cleanup_obligation_id,
            retention_text,
            provider_text,
        ):
            return pending("cleanup_database_work_retention_pending")
        fence = close_cleanup_obligation_with_cursor(
            cursor,
            cleanup_obligation_id,
            retention_text,
            provider_text,
        )
        if fence.active_admissions or fence.expired_admissions:
            return pending("cleanup_database_work_admissions_pending")
        if not cleanup_retention_expired_with_cursor(
            cursor,
            cleanup_obligation_id,
            retention_text,
            provider_text,
        ):
            return pending("cleanup_database_work_retention_pending")

    try:
        auth_zero = _cleanup_auth_obligation_sources_by_id(
            cleanup_obligation_id,
            retention_expires_at=retention_text,
            provider_expires_at=provider_text,
        )
    except Exception:  # noqa: BLE001 - opaque CLOSED remains retry authority.
        auth_zero = False
    if not auth_zero:
        return pending("cleanup_database_work_auth_pending")

    try:
        builder_zero = _cleanup_builder_obligation_sources_zero(
            cleanup_obligation_id,
            purge_artifacts=True,
        )
    except Exception:  # noqa: BLE001 - opaque CLOSED remains retry authority.
        builder_zero = False
    if not builder_zero:
        return pending("cleanup_database_work_builder_pending")

    with _cleanup_obligation_database_barrier(cleanup_obligation_id) as cursor:
        from deerflow.sophia.cleanup_fence import (
            cleanup_retention_expired_with_cursor,
            close_cleanup_obligation_with_cursor,
            mark_cleanup_live_zero_with_cursor,
            mark_cleanup_obligation_complete_with_cursor,
        )

        fence = close_cleanup_obligation_with_cursor(
            cursor,
            cleanup_obligation_id,
            retention_text,
            provider_text,
        )
        if fence.active_admissions or fence.expired_admissions:
            return pending("cleanup_database_work_admissions_pending")
        if not cleanup_retention_expired_with_cursor(
            cursor,
            cleanup_obligation_id,
            retention_text,
            provider_text,
        ):
            return pending("cleanup_database_work_retention_pending")
        if (
            not _cleanup_builder_obligation_sources_zero(
                cleanup_obligation_id,
                purge_artifacts=False,
            )
            or not _cleanup_obligation_product_sources_zero(
                cleanup_obligation_id
            )
            or not _auth_cleanup_obligation_sources_zero(
                cursor,
                cleanup_obligation_id,
            )
        ):
            return pending("cleanup_database_work_sources_pending")
        # PREPARED creators now hold this same advisory barrier from the final
        # CLOSED/due authorization through object persistence. Absence here is
        # therefore stable until this transaction commits COMPLETE.
        if supabase_artifact_store.download_artifact_object_bounded(
            object_path,
            max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
        ) is not None:
            return pending("cleanup_database_work_prepared_race")
        stable_id = _recovery_id_for_cleanup_obligation_id(
            cleanup_obligation_id
        )
        with _recovery_receipt_fence_lock(stable_id):
            tombstone_result = _load_recovery_purge_tombstone_for_id(stable_id)
            if tombstone_result is None:
                _prepare_recovery_receipt_purge_for_id(stable_id)
                tombstone_result = _complete_recovery_receipt_purge_for_id(
                    stable_id
                )
        if (
            tombstone_result is None
            or supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
            )
            is not None
            or not _cleanup_builder_obligation_sources_zero(
                cleanup_obligation_id,
                purge_artifacts=False,
            )
            or not _cleanup_obligation_product_sources_zero(
                cleanup_obligation_id
            )
            or not _auth_cleanup_obligation_sources_zero(
                cursor,
                cleanup_obligation_id,
            )
        ):
            raise RuntimeError("cleanup sources reappeared before completion")
        if fence.state != "complete":
            mark_cleanup_live_zero_with_cursor(
                cursor,
                cleanup_obligation_id,
                retention_text,
                provider_text,
            )
            mark_cleanup_obligation_complete_with_cursor(
                cursor,
                cleanup_obligation_id,
            )
    tombstone, receipt = tombstone_result
    return _component(
        "completed",
        recovery_receipts_deleted=int(tombstone["recovery_receipts_deleted"]),
        purge_tombstone_receipt=receipt,
        raw_identity_excluded=True,
    )


def _recovery_receipt_prefix(claims: VoiceLabClaims) -> str:
    return _recovery_receipt_prefix_for_id(_recovery_id(claims))


def _recovery_receipt_prefix_for_id(stable_recovery_id: str) -> str:
    return f"{_RECOVERY_RECEIPT_ROOT}/{_recovery_id_hmac(stable_recovery_id)}"


def _recovery_purge_object_paths(claims: VoiceLabClaims) -> tuple[str, str]:
    return _recovery_purge_object_paths_for_id(_recovery_id(claims))


def _recovery_purge_object_paths_for_id(stable_recovery_id: str) -> tuple[str, str]:
    recovery_id_hmac = _recovery_id_hmac(stable_recovery_id)
    return (
        f"{_RECOVERY_PURGE_ROOT}/{recovery_id_hmac}.intent.json",
        f"{_RECOVERY_PURGE_ROOT}/{recovery_id_hmac}.json",
    )


def _recovery_purge_fence_path(stable_recovery_id: str) -> str:
    recovery_id_hmac = _recovery_id_hmac(stable_recovery_id)
    return f"{_RECOVERY_PURGE_ROOT}/{recovery_id_hmac}.fence.json"


def _durable_evidence_required() -> bool:
    return (
        (os.getenv("SOPHIA_VOICE_LAB_DURABLE_EVIDENCE_REQUIRED") or "")
        .strip()
        .lower()
        == "true"
        or (os.getenv("RENDER") or "").strip().lower() == "true"
        or bool((os.getenv("RENDER_SERVICE_ID") or "").strip())
    )


@contextmanager
def _recovery_receipt_fence_lock(stable_recovery_id: str):  # noqa: ANN201
    """Serialize persistence and purge planning across Gateway instances."""
    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    with _LOCAL_RECOVERY_RECEIPT_FENCE:
        if not dsn:
            if _durable_evidence_required():
                raise RuntimeError("recovery receipt fence database is unavailable")
            yield
            return
        import psycopg

        with psycopg.connect(dsn, connect_timeout=5) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 731942))",
                    (stable_recovery_id,),
                )
                yield


def _read_json_object_bounded(
    object_path: str,
    *,
    max_bytes: int,
) -> tuple[dict[str, object], bytes] | None:
    from deerflow.sophia.storage import supabase_artifact_store

    stored = supabase_artifact_store.download_artifact_object_bounded(
        object_path,
        max_bytes=max_bytes,
    )
    if stored is None:
        return None
    raw, content_type = stored
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        raise RuntimeError("recovery purge object content type drifted")
    try:
        parsed = json.loads(raw.decode())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("recovery purge object is malformed") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("recovery purge object is malformed")
    return parsed, raw


def _validate_recovery_purge_tombstone(
    value: dict[str, object],
    *,
    expected_hmac: str,
) -> dict[str, object]:
    if (
        set(value) != _RECOVERY_PURGE_TOMBSTONE_FIELDS
        or value.get("schema") != "sophia_voice_lab_recovery_purge_tombstone_v1"
        or value.get("recovery_id_hmac") != expected_hmac
        or not isinstance(value.get("purged_at"), str)
        or not isinstance(value.get("recovery_receipts_deleted"), int)
        or isinstance(value.get("recovery_receipts_deleted"), bool)
        or not 0 <= int(value["recovery_receipts_deleted"]) <= _RECOVERY_RECEIPT_MAX_OBJECTS
        or value.get("recovery_receipts_remaining") != 0
        or value.get("all_prior_attempts_purged") is not True
        or value.get("raw_identity_excluded") is not True
        or value.get("deployment_excluded") is not True
        or value.get("content_excluded") is not True
        or value.get("component_details_excluded") is not True
        or value.get("object_metadata_content_free") is not True
        or value.get("retention_policy") != "approved_redacted_purge_tombstone"
    ):
        raise RuntimeError("recovery purge tombstone contract drifted")
    try:
        datetime.fromisoformat(str(value["purged_at"]))
    except ValueError as exc:
        raise RuntimeError("recovery purge tombstone timestamp drifted") from exc
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(serialized) > _RECOVERY_TOMBSTONE_MAX_BYTES:
        raise RuntimeError("recovery purge tombstone exceeded its hard size bound")
    return value


def _validate_recovery_purge_intent(
    value: dict[str, object],
    *,
    expected_hmac: str,
) -> dict[str, object]:
    if (
        set(value) != _RECOVERY_PURGE_INTENT_FIELDS
        or value.get("schema") != "sophia_voice_lab_recovery_purge_intent_v1"
        or value.get("recovery_id_hmac") != expected_hmac
        or not isinstance(value.get("planned_at"), str)
        or not isinstance(value.get("recovery_receipts_target_count"), int)
        or isinstance(value.get("recovery_receipts_target_count"), bool)
        or not 0 <= int(value["recovery_receipts_target_count"]) <= _RECOVERY_RECEIPT_MAX_OBJECTS
        or value.get("raw_identity_excluded") is not True
        or value.get("retention_policy") != "ephemeral_redacted_purge_intent"
    ):
        raise RuntimeError("recovery purge intent contract drifted")
    try:
        datetime.fromisoformat(str(value["planned_at"]))
    except ValueError as exc:
        raise RuntimeError("recovery purge intent timestamp drifted") from exc
    return value


def _validate_recovery_purge_fence(
    value: dict[str, object],
    *,
    expected_hmac: str,
) -> dict[str, object]:
    if (
        set(value) != _RECOVERY_PURGE_FENCE_FIELDS
        or value.get("schema") != "sophia_voice_lab_recovery_purge_fence_v1"
        or value.get("recovery_id_hmac") != expected_hmac
        or not isinstance(value.get("fenced_at"), str)
        or not isinstance(value.get("recovery_receipts_exact_count"), int)
        or isinstance(value.get("recovery_receipts_exact_count"), bool)
        or not 0
        <= int(value["recovery_receipts_exact_count"])
        <= _RECOVERY_RECEIPT_MAX_OBJECTS
        or value.get("raw_identity_excluded") is not True
        or value.get("retention_policy") != "ephemeral_redacted_purge_fence"
    ):
        raise RuntimeError("recovery purge fence contract drifted")
    try:
        datetime.fromisoformat(str(value["fenced_at"]))
    except ValueError as exc:
        raise RuntimeError("recovery purge fence timestamp drifted") from exc
    return value


def _recovery_purge_storage_receipt(
    object_path: str,
    serialized: bytes,
) -> dict[str, object]:
    return {
        "storage": "supabase",
        "object_path": object_path,
        "sha256": hashlib.sha256(serialized).hexdigest(),
        "schema": "sophia_voice_lab_recovery_purge_tombstone_v1",
        "raw_identity_excluded": True,
        "retention_policy": "approved_redacted_purge_tombstone",
    }


def _validate_recovery_purge_storage_receipt(
    value: object,
    *,
    stable_recovery_id: str,
) -> dict[str, object]:
    _intent_path, expected_path = _recovery_purge_object_paths_for_id(
        stable_recovery_id
    )
    expected_keys = {
        "storage",
        "object_path",
        "sha256",
        "schema",
        "raw_identity_excluded",
        "retention_policy",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected_keys
        or value.get("storage") != "supabase"
        or value.get("object_path") != expected_path
        or not isinstance(value.get("sha256"), str)
        or not _HASH_64.fullmatch(value["sha256"])
        or value.get("schema")
        != "sophia_voice_lab_recovery_purge_tombstone_v1"
        or value.get("raw_identity_excluded") is not True
        or value.get("retention_policy")
        != "approved_redacted_purge_tombstone"
    ):
        raise RuntimeError("recovery purge storage receipt contract drifted")
    return value


def _list_recovery_receipt_objects(claims: VoiceLabClaims) -> list[str]:
    return _list_recovery_receipt_objects_for_id(_recovery_id(claims))


def _list_recovery_receipt_objects_for_id(
    stable_recovery_id: str,
) -> list[str]:
    from deerflow.sophia.storage import supabase_artifact_store

    prefix = _recovery_receipt_prefix_for_id(stable_recovery_id)
    paths = supabase_artifact_store.list_artifact_object_paths_bounded(
        prefix,
        max_objects=_RECOVERY_RECEIPT_MAX_OBJECTS,
        max_depth=_RECOVERY_RECEIPT_MAX_DEPTH,
        page_size=100,
    )
    expected_prefix = f"{prefix}/"
    if any(not isinstance(path, str) or not path.startswith(expected_prefix) for path in paths):
        raise RuntimeError("recovery receipt listing escaped its exact run prefix")
    if len(paths) != len(set(paths)):
        raise RuntimeError("recovery receipt listing contained duplicate objects")
    return sorted(paths)


def _load_recovery_purge_tombstone(
    claims: VoiceLabClaims,
) -> tuple[dict[str, object], dict[str, object]] | None:
    return _load_recovery_purge_tombstone_for_id(_recovery_id(claims))


def _load_recovery_purge_tombstone_for_id(
    stable_id: str,
) -> tuple[dict[str, object], dict[str, object]] | None:
    """Load a strict tombstone and prove that no raw attempt receipt remains."""
    from deerflow.sophia.storage import supabase_artifact_store

    intent_path, tombstone_path = _recovery_purge_object_paths_for_id(stable_id)
    fence_path = _recovery_purge_fence_path(stable_id)
    expected_hmac = _recovery_id_hmac(stable_id)
    stored = _read_json_object_bounded(
        tombstone_path,
        max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
    )
    if stored is None:
        return None
    value, raw = stored
    tombstone = _validate_recovery_purge_tombstone(
        value,
        expected_hmac=expected_hmac,
    )
    if _list_recovery_receipt_objects_for_id(stable_id):
        raise RuntimeError("raw recovery receipts remain after purge tombstone")

    # A process may have crashed after committing the immutable tombstone but
    # before removing the redacted intent. Completing that final deletion is
    # safe and idempotent; no raw binding is present in either object.
    stored_intent = _read_json_object_bounded(
        intent_path,
        max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
    )
    expected_deleted_count: int | None = None
    if stored_intent is not None:
        intent_value, _intent_raw = stored_intent
        validated_intent = _validate_recovery_purge_intent(
            intent_value,
            expected_hmac=expected_hmac,
        )
        expected_deleted_count = int(
            validated_intent["recovery_receipts_target_count"]
        )
    stored_fence = _read_json_object_bounded(
        fence_path,
        max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
    )
    if stored_fence is not None:
        fence_value, _fence_raw = stored_fence
        validated_fence = _validate_recovery_purge_fence(
            fence_value,
            expected_hmac=expected_hmac,
        )
        fenced_count = int(validated_fence["recovery_receipts_exact_count"])
        if expected_deleted_count is not None and fenced_count < expected_deleted_count:
            raise RuntimeError("recovery purge fence regressed below its intent")
        expected_deleted_count = fenced_count
    if expected_deleted_count is not None and expected_deleted_count != int(
        tombstone["recovery_receipts_deleted"]
    ):
        raise RuntimeError("recovery purge tombstone conflicts with its fenced plan")
    for plan_path in (fence_path, intent_path):
        if _read_json_object_bounded(
            plan_path,
            max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
        ) is None:
            continue
        supabase_artifact_store.delete_artifact_object_if_present(plan_path)
        if _read_json_object_bounded(
            plan_path,
            max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
        ) is not None:
            raise RuntimeError("recovery purge plan deletion was not verified")
    return tombstone, _recovery_purge_storage_receipt(tombstone_path, raw)


def _prepare_recovery_receipt_purge(claims: VoiceLabClaims) -> dict[str, object]:
    return _prepare_recovery_receipt_purge_for_id(_recovery_id(claims))


def _prepare_recovery_receipt_purge_for_id(
    stable_id: str,
) -> dict[str, object]:
    """Create an immutable, content-free intent before deleting run evidence."""
    from deerflow.sophia.storage import supabase_artifact_store

    existing_tombstone = _load_recovery_purge_tombstone_for_id(stable_id)
    if existing_tombstone is not None:
        return {
            "already_purged": True,
            "target_count": int(existing_tombstone[0]["recovery_receipts_deleted"]),
        }

    paths = _list_recovery_receipt_objects_for_id(stable_id)
    expected_hmac = _recovery_id_hmac(stable_id)
    intent_path, _tombstone_path = _recovery_purge_object_paths_for_id(stable_id)
    intent: dict[str, object] = {
        "schema": "sophia_voice_lab_recovery_purge_intent_v1",
        "recovery_id_hmac": expected_hmac,
        "planned_at": datetime.now(UTC).isoformat(),
        "recovery_receipts_target_count": len(paths),
        "raw_identity_excluded": True,
        "retention_policy": "ephemeral_redacted_purge_intent",
    }
    serialized = json.dumps(intent, sort_keys=True, separators=(",", ":")).encode()
    if len(serialized) > _RECOVERY_TOMBSTONE_MAX_BYTES:
        raise RuntimeError("recovery purge intent exceeded its hard size bound")
    result = supabase_artifact_store.create_artifact_object_if_absent(
        intent_path,
        serialized,
        content_type="application/json",
    )
    if result == "exists":
        stored = _read_json_object_bounded(
            intent_path,
            max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
        )
        if stored is None:
            raise RuntimeError("recovery purge intent disappeared")
        existing, _raw = stored
        validated = _validate_recovery_purge_intent(
            existing,
            expected_hmac=expected_hmac,
        )
        target_count = int(validated["recovery_receipts_target_count"])
        if len(paths) > target_count:
            raise RuntimeError("recovery receipts appeared after purge planning")
        return {"already_purged": False, "target_count": target_count}
    _validate_recovery_purge_intent(intent, expected_hmac=expected_hmac)
    return {"already_purged": False, "target_count": len(paths)}


def _complete_recovery_receipt_purge(
    claims: VoiceLabClaims,
) -> tuple[dict[str, object], dict[str, object]]:
    return _complete_recovery_receipt_purge_for_id(_recovery_id(claims))


def _complete_recovery_receipt_purge_for_id(
    stable_id: str,
) -> tuple[dict[str, object], dict[str, object]]:
    """Delete/verify every attempt and retain one approved redacted tombstone."""
    from deerflow.sophia.storage import supabase_artifact_store

    existing_tombstone = _load_recovery_purge_tombstone_for_id(stable_id)
    if existing_tombstone is not None:
        return existing_tombstone

    expected_hmac = _recovery_id_hmac(stable_id)
    intent_path, tombstone_path = _recovery_purge_object_paths_for_id(stable_id)
    fence_path = _recovery_purge_fence_path(stable_id)
    stored_intent = _read_json_object_bounded(
        intent_path,
        max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
    )
    if stored_intent is None:
        raise RuntimeError("recovery purge intent is unavailable")
    intent, _intent_raw = stored_intent
    validated_intent = _validate_recovery_purge_intent(
        intent,
        expected_hmac=expected_hmac,
    )
    target_count = int(validated_intent["recovery_receipts_target_count"])
    current_paths = _list_recovery_receipt_objects_for_id(stable_id)
    stored_fence = _read_json_object_bounded(
        fence_path,
        max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
    )
    if stored_fence is None:
        # The intent is already a persistence barrier. A receipt that was
        # created after the intent's initial list but before that barrier
        # committed is included in this exact immutable fence before deletion.
        target_count = max(target_count, len(current_paths))
        fence: dict[str, object] = {
            "schema": "sophia_voice_lab_recovery_purge_fence_v1",
            "recovery_id_hmac": expected_hmac,
            "fenced_at": datetime.now(UTC).isoformat(),
            "recovery_receipts_exact_count": target_count,
            "raw_identity_excluded": True,
            "retention_policy": "ephemeral_redacted_purge_fence",
        }
        _validate_recovery_purge_fence(fence, expected_hmac=expected_hmac)
        fence_raw = json.dumps(
            fence,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        fence_result = supabase_artifact_store.create_artifact_object_if_absent(
            fence_path,
            fence_raw,
            content_type="application/json",
        )
        if fence_result == "exists":
            stored_fence = _read_json_object_bounded(
                fence_path,
                max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
            )
            if stored_fence is None:
                raise RuntimeError("recovery purge fence disappeared")
        else:
            stored_fence = (fence, fence_raw)
    fence_value, _fence_raw = stored_fence
    validated_fence = _validate_recovery_purge_fence(
        fence_value,
        expected_hmac=expected_hmac,
    )
    target_count = int(validated_fence["recovery_receipts_exact_count"])
    if target_count < int(validated_intent["recovery_receipts_target_count"]):
        raise RuntimeError("recovery purge fence regressed below its intent")
    if len(current_paths) > target_count:
        raise RuntimeError("recovery receipts appeared after the purge fence")
    for object_path in current_paths:
        supabase_artifact_store.delete_artifact_object_if_present(object_path)
        if (
            supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=128 * 1024,
            )
            is not None
        ):
            raise RuntimeError("recovery receipt deletion was not verified")
    if _list_recovery_receipt_objects_for_id(stable_id):
        raise RuntimeError("recovery receipt prefix was not emptied")

    tombstone: dict[str, object] = {
        "schema": "sophia_voice_lab_recovery_purge_tombstone_v1",
        "recovery_id_hmac": expected_hmac,
        "purged_at": datetime.now(UTC).isoformat(),
        "recovery_receipts_deleted": target_count,
        "recovery_receipts_remaining": 0,
        "all_prior_attempts_purged": True,
        "raw_identity_excluded": True,
        "deployment_excluded": True,
        "content_excluded": True,
        "component_details_excluded": True,
        "object_metadata_content_free": True,
        "retention_policy": "approved_redacted_purge_tombstone",
    }
    _validate_recovery_purge_tombstone(tombstone, expected_hmac=expected_hmac)
    serialized = json.dumps(tombstone, sort_keys=True, separators=(",", ":")).encode()
    result = supabase_artifact_store.create_artifact_object_if_absent(
        tombstone_path,
        serialized,
        content_type="application/json",
    )
    if result == "exists":
        stored_tombstone = _read_json_object_bounded(
            tombstone_path,
            max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
        )
        if stored_tombstone is None:
            raise RuntimeError("recovery purge tombstone disappeared")
        existing, existing_raw = stored_tombstone
        validated = _validate_recovery_purge_tombstone(
            existing,
            expected_hmac=expected_hmac,
        )
        if int(validated["recovery_receipts_deleted"]) != target_count:
            raise RuntimeError("recovery purge tombstone conflicts with purge intent")
        tombstone = validated
        serialized = existing_raw

    for plan_path in (fence_path, intent_path):
        supabase_artifact_store.delete_artifact_object_if_present(plan_path)
        if _read_json_object_bounded(
            plan_path,
            max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
        ) is not None:
            raise RuntimeError("recovery purge plan deletion was not verified")
    return tombstone, _recovery_purge_storage_receipt(tombstone_path, serialized)


def _parse_session_marker(value: object) -> dict[str, object] | None:
    if not isinstance(value, str) or not value.startswith(_SESSION_MARKER_PREFIX):
        return None
    encoded = value[len(_SESSION_MARKER_PREFIX) :]
    if not encoded or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
        return None
    try:
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != encoded:
            return None
        marker = json.loads(decoded.decode())
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(marker, dict) or set(marker) != {
        "v",
        "principal_id",
        "test_run_id",
        "tombstone_kid",
        "cleanup_obligation_id",
        "issued_at",
        "jti_sha256",
        "nonce_sha256",
    }:
        return None
    if (
        marker.get("v") != 1
        or not isinstance(marker.get("principal_id"), str)
        or not isinstance(marker.get("test_run_id"), str)
        or not isinstance(marker.get("tombstone_kid"), str)
        or not _AUTH_TOMBSTONE_KID.fullmatch(marker["tombstone_kid"])
        or not isinstance(marker.get("cleanup_obligation_id"), str)
        or not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            marker["cleanup_obligation_id"],
        )
        or not isinstance(marker.get("issued_at"), int)
        or isinstance(marker.get("issued_at"), bool)
        or not isinstance(marker.get("jti_sha256"), str)
        or not _HASH_64.fullmatch(marker["jti_sha256"])
        or not isinstance(marker.get("nonce_sha256"), str)
        or not _HASH_64.fullmatch(marker["nonce_sha256"])
    ):
        return None
    return marker


def _provider_session_id(record: object | None) -> str | None:
    metadata = getattr(record, "metadata", None)
    synthetic = metadata.get("synthetic_voice_lab") if isinstance(metadata, dict) else None
    candidate = synthetic.get("voice_runtime_session_id") if isinstance(synthetic, dict) else None
    return candidate if isinstance(candidate, str) and candidate else None


def _provider_terminal_settlement_sha256(
    record: object,
    *,
    voice_module: Any,
) -> str | None:
    """Rebuild the exact browser settlement digest from canonical closed metadata."""

    metadata = getattr(record, "metadata", None)
    synthetic = metadata.get("synthetic_voice_lab") if isinstance(metadata, dict) else None
    if not isinstance(synthetic, dict):
        return None
    provider_session_id = _provider_session_id(record)
    close_receipts = synthetic.get("voice_provider_browser_close_receipts")
    abort_receipts = synthetic.get("voice_provider_activation_abort_receipts")
    closed_at = synthetic.get("voice_provider_closed_at")
    if (
        synthetic.get("voice_provider_resource_state") != "closed"
        or provider_session_id is None
        or synthetic.get("voice_provider_pending_connection_epoch") is not None
        or not isinstance(close_receipts, list)
        or not isinstance(abort_receipts, list)
        or not isinstance(closed_at, str)
    ):
        return None
    try:
        parsed_closed_at = datetime.fromisoformat(closed_at.replace("Z", "+00:00"))
        if (
            parsed_closed_at.tzinfo is None
            or parsed_closed_at.astimezone(UTC).isoformat(
                timespec="milliseconds"
            ).replace("+00:00", "Z")
            != closed_at
        ):
            return None
        close_models = [
            voice_module.GeminiBrowserProviderCloseReceipt.model_validate(item)
            for item in close_receipts
        ]
        abort_models = [
            voice_module.GeminiBrowserProviderActivationAbortReceipt.model_validate(
                item
            )
            for item in abort_receipts
        ]
        canonical_close, canonical_abort, settlement_sha256 = (
            voice_module._canonical_browser_provider_settlement(
                provider_session_id,
                close_models,
                abort_models,
            )
        )
    except (HTTPException, TypeError, ValueError):
        return None
    if (
        json.dumps(
            canonical_close,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        != json.dumps(
            close_receipts,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        or json.dumps(
            canonical_abort,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        != json.dumps(
            abort_receipts,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
    ):
        return None
    return settlement_sha256


def _provider_terminal_readback(
    claims: VoiceLabClaims,
    record: object,
    *,
    voice_module: Any,
) -> dict[str, object]:
    """Accept provider zero only from exact durable settlement plus admission zero."""

    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        verify_cleanup_provider_settlement_replay,
    )

    settlement_sha256 = _provider_terminal_settlement_sha256(
        record,
        voice_module=voice_module,
    )
    if settlement_sha256 is None:
        return _component(
            "pending",
            code="voice_provider_terminal_settlement_invalid",
        )
    try:
        provider_admissions = tuple(
            admission
            for admission in cleanup_admissions(claims.cleanup_obligation_id)
            if admission.resource_kind == "provider"
        )
        settlement_verified = verify_cleanup_provider_settlement_replay(
            claims.cleanup_obligation_id,
            settlement_sha256,
        )
    except Exception as exc:  # noqa: BLE001 - typed fail-closed readback.
        return _component(
            "pending",
            code="voice_provider_terminal_readback_unavailable",
            error_type=type(exc).__name__,
        )
    if provider_admissions or not settlement_verified:
        return _component(
            "pending",
            code="voice_provider_terminal_readback_unconfirmed",
        )
    return _component(
        "already_terminal",
        provider_disconnected=True,
        provider_settlement_verified=True,
        provider_admissions_remaining=0,
    )


def _close_live_cleanup_admission(
    claims: VoiceLabClaims,
    record: object | None,
) -> dict[str, object]:
    """Commit content-free CLOSED before live cleanup can report success."""

    try:
        from deerflow.sophia.cleanup_fence import close_existing_cleanup_obligation

        result = close_existing_cleanup_obligation(claims.cleanup_obligation_id)
    except Exception as exc:  # noqa: BLE001 - typed fail-closed component.
        return _component(
            "pending",
            code="cleanup_admission_fence_unavailable",
            error_type=type(exc).__name__,
        )
    admissions = result.active_admissions + result.expired_admissions
    if admissions:
        return _component(
            "pending",
            code="cleanup_admission_in_flight",
            cleanup_admissions_pending=admissions,
            cleanup_admissions_overdue=result.expired_admissions,
            admission_closed=True,
        )
    return _component(
        "completed",
        admission_closed=True,
        cleanup_admissions_pending=0,
    )


async def _reconcile_overdue_cleanup_admissions(
    claims: VoiceLabClaims,
    record: object | None,
) -> dict[str, object]:
    """Fence/delete exact overdue external locators before consuming rows."""

    from app.gateway.routers import sessions, voice
    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        complete_cleanup_admission,
        release_cleanup_admission,
    )

    try:
        admissions = await asyncio.to_thread(
            cleanup_admissions,
            claims.cleanup_obligation_id,
        )
    except Exception as exc:  # noqa: BLE001
        return _component(
            "pending",
            code="cleanup_admission_query_unavailable",
            error_type=type(exc).__name__,
        )
    if any(not item.expired for item in admissions):
        return _component("pending", code="cleanup_admission_in_flight")
    for admission in admissions:
        if not admission.resource_id:
            return _component(
                "pending",
                code="cleanup_admission_resource_unavailable",
            )
        if admission.resource_kind == "provider":
            if admission.status == "reserved":
                try:
                    consumed = await asyncio.to_thread(
                        complete_cleanup_admission,
                        admission,
                        basis="server_relay_zero",
                    )
                except Exception as exc:  # noqa: BLE001
                    return _component(
                        "pending",
                        code="cleanup_admission_reserved_consume_unavailable",
                        error_type=type(exc).__name__,
                    )
                if not consumed:
                    return _component(
                        "pending",
                        code="cleanup_admission_reserved_not_expired",
                    )
                continue
            await voice._disconnect_gemini_production_session(
                admission.resource_id,
                capability=sign_retention_reaper_runtime_capability(
                    claims,
                    provider_session_id=admission.resource_id,
                ),
            )
            # A load-balanced 404 may come from a non-owning Voice replica.
            # Only the owning replica's durable completion callback consumes
            # the bound admission after its local manager has read-zeroed.
            remaining = await asyncio.to_thread(
                cleanup_admissions,
                claims.cleanup_obligation_id,
            )
            if any(item.admission_id == admission.admission_id for item in remaining):
                return _component(
                    "pending",
                    code="cleanup_admission_provider_owner_ack_pending",
                )
            continue
        elif admission.resource_kind == "session":
            if admission.resource_expires_at is None:
                return _component(
                    "pending",
                    code="cleanup_admission_deadline_unavailable",
                )
            fenced = await sessions._fence_langgraph_thread_cleanup_admission(
                admission.resource_id,
                cleanup_obligation_id_hmac=_cleanup_obligation_id_hmac(
                    claims.cleanup_obligation_id
                ),
                retention_expires_at=admission.resource_expires_at,
            )
            if not fenced:
                return _component(
                    "pending",
                    code="cleanup_admission_thread_fence_unconfirmed",
                )
        elif admission.resource_kind == "builder":
            if admission.resource_expires_at is None:
                return _component(
                    "pending",
                    code="cleanup_admission_deadline_unavailable",
                )
            fenced = await sessions._fence_langgraph_thread_cleanup_admission(
                admission.resource_id,
                cleanup_obligation_id_hmac=_cleanup_obligation_id_hmac(
                    claims.cleanup_obligation_id
                ),
                retention_expires_at=admission.resource_expires_at,
            )
            if not fenced:
                return _component(
                    "pending",
                    code="cleanup_admission_builder_fence_unconfirmed",
                )
            from app.gateway.routers import builder_events

            builder_receipt = await builder_events.cleanup_synthetic_builder_obligation(
                claims.cleanup_obligation_id,
                purge_artifacts=True,
            )
            if not (
                builder_receipt.get("cleanup_complete") is True
                and builder_receipt.get("discovery_complete") is True
                and builder_receipt.get("authoritative_zero_tasks") is True
                and builder_receipt.get("artifacts_cleanup_complete") is True
                and not builder_receipt.get("binding_conflict")
                and int(builder_receipt.get("unresolved_count") or 0) == 0
            ):
                return _component(
                    "pending",
                    code="cleanup_admission_builder_zero_unconfirmed",
                )
        else:
            return _component("failed", code="cleanup_admission_kind_invalid")
        try:
            await asyncio.to_thread(release_cleanup_admission, admission)
        except Exception as exc:  # noqa: BLE001
            return _component(
                "pending",
                code="cleanup_admission_release_unavailable",
                error_type=type(exc).__name__,
            )
    return _component(
        "completed",
        cleanup_admissions_reconciled=len(admissions),
    )


def _lookup_canonical_session(
    claims: VoiceLabClaims,
) -> tuple[dict[str, object], object | None]:
    from app.gateway.routers.sessions import _store
    from deerflow.sophia.session_store import SessionStoreError

    try:
        by_run = _store.find_session_by_run_id(
            claims.principal_id,
            claims.test_run_id,
        )
        by_cleanup = _store.find_session_by_cleanup_obligation_id(
            claims.cleanup_obligation_id
        )
    except (OSError, RuntimeError, SessionStoreError):
        return _component("pending", code="canonical_session_query_unavailable"), None
    if by_run is not by_cleanup and (
        by_run is None
        or by_cleanup is None
        or by_run.session_id != by_cleanup.session_id
    ):
        return _component("failed", code="canonical_session_binding_mismatch"), None
    record = by_cleanup
    if record is None:
        return _component("not_found"), None
    try:
        assert_voice_lab_session_record(record, claims)
    except HTTPException:
        return _component("failed", code="canonical_session_binding_mismatch"), None
    return _component("completed", canonical_binding_verified=True), record


def _recover_canonical_session(
    claims: VoiceLabClaims,
) -> tuple[dict[str, object], object | None]:
    from app.gateway.inactivity_watcher import unregister_thread

    lookup, record = _lookup_canonical_session(claims)
    if record is None:
        return lookup, None

    was_terminal = record.status == "ended"
    # Recovery publishes CLOSED before reaching this function. It must never
    # manufacture a final transcript or extend retention after that boundary.
    # A provisional row is cleanup-only and remains available to the exact
    # provider/auth teardown until the ordinary purge step deletes it.
    status = "already_terminal" if was_terminal else "completed"
    try:
        unregister_thread(record.thread_id)
    except (OSError, RuntimeError):
        return _component("pending", code="canonical_watcher_unregister_failed"), record
    return _component(
        status,
        session_ended=was_terminal,
        provisional_cleanup_only=not was_terminal,
        watcher_unregistered=True,
    ), record


async def _recover_voice_provider(
    claims: VoiceLabClaims,
    record: object | None,
    *,
    retention_reaper: bool = False,
) -> dict[str, object]:
    from app.gateway.routers import voice

    provider_session_id = _provider_session_id(record)
    active = voice._active_voice_sessions.get(claims.principal_id)
    expected_binding = voice._voice_lab_active_binding(claims)
    if active is not None:
        if active.voice_lab_binding != expected_binding:
            return _component("failed", code="active_voice_binding_mismatch")
        if provider_session_id is not None and active.session_id != provider_session_id:
            return _component("failed", code="active_voice_session_mismatch")
        provider_session_id = active.session_id
    if record is not None:
        metadata = getattr(record, "metadata", None)
        synthetic = (
            metadata.get("synthetic_voice_lab")
            if isinstance(metadata, dict)
            else None
        )
        if (
            isinstance(synthetic, dict)
            and synthetic.get("voice_provider_resource_state") == "closed"
        ):
            terminal = _provider_terminal_readback(
                claims,
                record,
                voice_module=voice,
            )
            if terminal.get("status") in _TERMINAL_COMPONENT_STATUSES:
                if active is not None and active.session_id == provider_session_id:
                    voice._active_voice_sessions.pop(claims.principal_id, None)
            return terminal
    if provider_session_id is None:
        return _component("not_found")

    disconnected = await voice._disconnect_gemini_production_session(
        provider_session_id,
        capability=(
            sign_retention_reaper_runtime_capability(
                claims,
                provider_session_id=provider_session_id,
            )
            if retention_reaper
            else sign_runtime_capability(claims)
        ),
    )
    if not disconnected:
        return _component("pending", code="voice_provider_disconnect_unconfirmed")
    if active is not None and active.session_id == provider_session_id:
        voice._active_voice_sessions.pop(claims.principal_id, None)
    lookup, current = _lookup_canonical_session(claims)
    if current is None:
        return _component(
            "pending",
            code=(
                "voice_provider_terminal_session_unavailable"
                if lookup.get("status") == "not_found"
                else str(lookup.get("code") or "voice_provider_terminal_query_unavailable")
            ),
        )
    return _provider_terminal_readback(
        claims,
        current,
        voice_module=voice,
    )


async def _recover_builder(claims: VoiceLabClaims) -> dict[str, object]:
    try:
        from app.gateway.routers.builder_events import (
            SyntheticBuilderCleanupRequest,
            cleanup_synthetic_builder_run,
        )

        receipt = await cleanup_synthetic_builder_run(
            SyntheticBuilderCleanupRequest(
                test_principal_id=claims.principal_id,
                test_run_id=claims.test_run_id,
                cleanup_obligation_id=claims.cleanup_obligation_id,
                tasks=[],
            )
        )
    except Exception as exc:  # noqa: BLE001 - typed retry receipt, no exception text.
        return _component(
            "pending",
            code="builder_cleanup_unavailable",
            error_type=type(exc).__name__,
        )
    safe_receipt = receipt.model_dump(exclude={"test_principal_id", "test_run_id"})
    authoritative = bool(
        receipt.cleanup_complete
        and receipt.discovery_complete
        and receipt.authoritative_zero_tasks
    )
    return _component(
        "completed" if authoritative else "pending",
        **({} if authoritative else {"code": "builder_cleanup_not_authoritative"}),
        discovery_complete=bool(receipt.discovery_complete),
        authoritative_zero_tasks=bool(receipt.authoritative_zero_tasks),
        discovered_task_count=int(receipt.discovered_task_count),
        cleanup_complete=bool(receipt.cleanup_complete),
        receipt=safe_receipt,
    )


def _recover_canonical_evidence_retention(
    claims: VoiceLabClaims,
    record: object | None,
) -> dict[str, object]:
    """Verify bounded exact-run evidence, purging it only after expiry."""
    from deerflow.sophia.storage import supabase_artifact_store

    durable_required = _durable_evidence_required()
    if record is None:
        if not supabase_artifact_store.is_configured():
            return _component(
                "pending" if durable_required else "not_found",
                **(
                    {"code": "canonical_evidence_durable_purge_unavailable"}
                    if durable_required
                    else {}
                ),
            )
        try:
            cleanup_handle_path = _retention_cleanup_handle_path(claims)
            cleanup_handle = supabase_artifact_store.download_artifact_object_bounded(
                cleanup_handle_path,
                max_bytes=_RETENTION_CLEANUP_HANDLE_MAX_BYTES,
            )
            if cleanup_handle is not None:
                _open_retention_cleanup_handle(
                    cleanup_handle_path,
                    cleanup_handle[0],
                )
                prepared_result = _finish_retention_cleanup_intent(
                    claims.cleanup_obligation_id,
                    expected_path=cleanup_handle_path,
                )
                if prepared_result.get("status") not in {
                    "completed",
                    "already_terminal",
                }:
                    return _component(
                        "pending",
                        code="canonical_evidence_cleanup_prepared",
                    )
            if not _cleanup_obligation_product_sources_zero(
                claims.cleanup_obligation_id
            ):
                return _component(
                    "pending",
                    code="canonical_evidence_product_sources_still_present",
                )
            finalization_object_path = (
                ".builder/voice_lab_evidence/finalizations/v2/"
                f"{claims.cleanup_obligation_id}.json"
            )
            if (
                supabase_artifact_store.download_artifact_object_bounded(
                    finalization_object_path,
                    max_bytes=2 * 1024 * 1024,
                )
                is not None
            ):
                return _component(
                    "pending",
                    code="canonical_evidence_finalization_still_present",
                )
            from app.gateway.artifact_registry import ArtifactRegistry
            from app.gateway.routers.sophia import _synthetic_finalization_path

            if _synthetic_finalization_path(
                claims.principal_id,
                claims.cleanup_obligation_id,
            ).exists():
                return _component(
                    "pending",
                    code="canonical_evidence_local_finalization_still_present",
                )
            if ArtifactRegistry().synthetic_cleanup_obligation_records(
                cleanup_obligation_id=claims.cleanup_obligation_id,
            ):
                return _component(
                    "pending",
                    code="canonical_evidence_artifacts_still_present",
                )
            # Repeat immediately before COMPLETE so a PREPARED/expired marker
            # can never substitute for authoritative global product zero.
            if not _cleanup_obligation_product_sources_zero(
                claims.cleanup_obligation_id
            ):
                return _component(
                    "pending",
                    code="canonical_evidence_product_sources_still_present",
                )
            with _recovery_receipt_fence_lock(_recovery_id(claims)):
                tombstone_result = _load_recovery_purge_tombstone(claims)
                if tombstone_result is None:
                    intent_path, _tombstone_path = _recovery_purge_object_paths(
                        claims
                    )
                    if _read_json_object_bounded(
                        intent_path,
                        max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
                    ) is None:
                        return _component("not_found")
                    tombstone_result = _complete_recovery_receipt_purge(claims)
            tombstone, storage_receipt = tombstone_result
        except (OSError, RuntimeError):
            return _component(
                "pending",
                code="canonical_evidence_recovery_receipt_purge_unavailable",
            )
        return _component(
            "completed",
            canonical_evidence_purged=True,
            session_messages_purged=True,
            local_finalization_purged=True,
            durable_finalization_purged=True,
            recovery_receipts_purged=True,
            recovery_receipts_deleted=int(tombstone["recovery_receipts_deleted"]),
            all_prior_attempts_purged=True,
            purge_tombstone_receipt=storage_receipt,
            retention_purge_pending=False,
        )
    try:
        assert_voice_lab_session_record(record, claims)
    except HTTPException:
        return _component("failed", code="canonical_evidence_binding_mismatch")
    metadata = getattr(record, "metadata", None)
    synthetic = metadata.get("synthetic_voice_lab") if isinstance(metadata, dict) else None
    from app.gateway.routers.sophia import (
        _parse_exact_utc_millis,
        _synthetic_finalization_path,
        _synthetic_transcript_evidence,
    )
    from deerflow.sophia.session_store import (
        SessionEvidenceIntegrityError,
        SessionStoreError,
        _build_postgres_finalization_receipt,
    )

    finalization_object_path = (
        ".builder/voice_lab_evidence/finalizations/v2/"
        f"{claims.cleanup_obligation_id}.json"
    )
    if not isinstance(synthetic, dict):
        return _component("failed", code="canonical_evidence_retention_invalid")
    stored_receipt = synthetic.get("finalization_receipt")
    finalized_text = synthetic.get("finalized_at")
    retention_text = synthetic.get("retention_expires_at")
    provider_text = synthetic.get("provider_expires_at")
    finalized_at = _parse_exact_utc_millis(finalized_text)
    retention_expires_at = _parse_exact_utc_millis(retention_text)
    exact_retention = (
        isinstance(stored_receipt, dict)
        and finalized_at is not None
        and retention_expires_at is not None
        and getattr(record, "status", None) == "ended"
        and getattr(record, "ended_at", None) == finalized_text
        and synthetic.get("retention_hours") == claims.retention_hours
        and synthetic.get("retention_anchor") == "finalized_at"
        and provider_text == claims.provider_expires_at
        and retention_expires_at
        == finalized_at + timedelta(hours=claims.retention_hours)
        and metadata.get("expected_deployment") == claims.expected_deployment
    )
    if not exact_retention:
        return _component("failed", code="canonical_evidence_retention_invalid")

    from app.gateway.routers.sessions import _store

    try:
        messages = _store.read_exact_session_messages(
            claims.principal_id,
            getattr(record, "session_id"),
        )
    except SessionEvidenceIntegrityError:
        return _component("failed", code="canonical_evidence_raw_message_set_invalid")
    except (OSError, RuntimeError, SessionStoreError):
        return _component("pending", code="canonical_evidence_query_unavailable")
    expected_message_metadata = {
        **claims.synthetic_context(),
        "scenario_version": claims.scenario_version,
        "expected_deployment": dict(claims.expected_deployment),
        "memory_retrieval_excluded": True,
        "memory_learning_excluded": True,
        "offline_pipeline_excluded": True,
        "ordinary_analytics_excluded": True,
        "ordinary_projects_excluded": True,
        "shared_spaces_excluded": True,
        "retention_hours": claims.retention_hours,
        "retention_anchor": "finalized_at",
        "finalized_at": finalized_text,
        "retention_expires_at": retention_text,
    }
    message_identity_valid = all(
        message.session_id == getattr(record, "session_id", None)
        and message.thread_id == getattr(record, "thread_id", None)
        and message.metadata
        == {
            **expected_message_metadata,
            "redaction_level": message.redaction_level,
        }
        for message in messages
    )
    if not message_identity_valid:
        return _component("failed", code="canonical_evidence_message_binding_mismatch")
    try:
        reconstructed_transcript = _synthetic_transcript_evidence(
            record,
            messages,
            claims,
        )
    except HTTPException:
        return _component("failed", code="canonical_evidence_transcript_invalid")
    started_at = stored_receipt.get("started_at")
    turn_count = stored_receipt.get("turn_count")
    capability_jti_sha256 = stored_receipt.get("capability_jti_sha256")
    if (
        _parse_exact_utc_millis(started_at) is None
        or isinstance(turn_count, bool)
        or not isinstance(turn_count, int)
        or turn_count < 0
        or not isinstance(capability_jti_sha256, str)
        or _HASH_64.fullmatch(capability_jti_sha256) is None
        or int(getattr(record, "message_revision", 0)) < 1
        or int(getattr(record, "message_count", -1)) != len(messages)
    ):
        return _component("failed", code="canonical_finalization_receipt_invalid")
    expected_receipt = _build_postgres_finalization_receipt(
        user_id=claims.principal_id,
        session_id=getattr(record, "session_id"),
        thread_id=getattr(record, "thread_id"),
        expected_synthetic_binding=claims.synthetic_context(),
        expected_deployment=dict(claims.expected_deployment),
        finalized_at=str(finalized_text),
        retention_hours=claims.retention_hours,
        retention_expires_at=str(retention_text),
        provider_expires_at=claims.provider_expires_at,
        message_revision=int(getattr(record, "message_revision", 0)),
        message_count=len(messages),
        canonical_transcript_sha256=str(reconstructed_transcript["sha256"]),
        finalization_started_at=str(started_at),
        turn_count=turn_count,
        capability_jti_sha256=capability_jti_sha256,
    )
    if stored_receipt != expected_receipt:
        return _component("failed", code="canonical_finalization_receipt_mismatch")
    safe_detail = {
        "message_revision": max(0, int(getattr(record, "message_revision", 0))),
        "message_count": len(messages),
        "transcript_sha256": str(reconstructed_transcript["sha256"]),
        "retention_expires_at": retention_text,
    }
    try:
        from deerflow.sophia.cleanup_fence import cleanup_retention_expired

        retention_due = cleanup_retention_expired(
            claims.cleanup_obligation_id,
            str(retention_text),
            str(provider_text),
        )
    except Exception as exc:  # noqa: BLE001 - DB clock/fence is authoritative.
        return _component(
            "pending",
            code="canonical_evidence_retention_fence_unavailable",
            error_type=type(exc).__name__,
        )
    if not retention_due:
        return _component(
            "retention_pending",
            provider_spend_live=False,
            canonical_evidence_retained=True,
            retention_purge_pending=True,
            **safe_detail,
        )
    durable_purged = False
    cleanup_handle_path: str | None = None
    try:
        if supabase_artifact_store.is_configured():
            cleanup_handle_path = _ensure_retention_cleanup_handle(
                claims,
                retention_expires_at=retention_text,
                cleanup_mode="canonical_session",
                session_id=getattr(record, "session_id", None),
                thread_id=getattr(record, "thread_id", None),
            )
            with _recovery_receipt_fence_lock(_recovery_id(claims)):
                prepared = _prepare_recovery_receipt_purge(claims)
            if prepared.get("already_purged") is True:
                return _component(
                    "failed",
                    code="canonical_evidence_purge_state_conflict",
                )
        elif durable_required:
            return _component(
                "pending",
                code="canonical_evidence_durable_purge_unavailable",
            )
        # Delete/read-zero the canonical session first. If this fails, the
        # untouched finalization receipt remains a raw discovery authority. If
        # it succeeds and the process crashes, the finalization plus sealed
        # PREPARED handle let the reaper resume without the runner identity.
        _store.purge_synthetic_session(
            claims.principal_id,
            getattr(record, "session_id"),
            cleanup_obligation_id=claims.cleanup_obligation_id,
            retention_expires_at=str(retention_text),
            provider_expires_at=str(provider_text),
        )
        remaining = _store.find_session_by_run_id(
            claims.principal_id,
            claims.test_run_id,
        )
        if remaining is not None:
            return _component("pending", code="canonical_evidence_purge_unconfirmed")
        if supabase_artifact_store.is_configured():
            supabase_artifact_store.delete_artifact_object_if_present(
                finalization_object_path
            )
            if (
                supabase_artifact_store.download_artifact_object_bounded(
                    finalization_object_path,
                    max_bytes=2 * 1024 * 1024,
                )
                is not None
            ):
                return _component(
                    "pending",
                    code="canonical_evidence_durable_purge_unconfirmed",
                )
            durable_purged = True
        local_path = _synthetic_finalization_path(
            claims.principal_id,
            claims.cleanup_obligation_id,
        )
        try:
            local_path.unlink()
        except FileNotFoundError:
            pass
        if local_path.exists():
            return _component(
                "pending",
                code="canonical_evidence_local_purge_unconfirmed",
            )
    except (OSError, RuntimeError):
        return _component("pending", code="canonical_evidence_purge_unavailable")
    try:
        if cleanup_handle_path is not None:
            finished = _finish_retention_cleanup_intent(
                claims.cleanup_obligation_id,
                expected_path=cleanup_handle_path,
            )
            if finished.get("status") != "completed":
                return _component(
                    "pending",
                    code="canonical_evidence_global_zero_unconfirmed",
                )
            purge_storage_receipt = finished.get("purge_tombstone_receipt")
            recovery_receipts_deleted = int(
                finished.get("recovery_receipts_deleted") or 0
            )
        else:
            # Local/dev mode has no durable product-index barrier. Production
            # always takes the opaque PREPARED path above.
            with _recovery_receipt_fence_lock(_recovery_id(claims)):
                tombstone, purge_storage_receipt = _complete_recovery_receipt_purge(
                    claims
                )
            recovery_receipts_deleted = int(
                tombstone["recovery_receipts_deleted"]
            )
    except (OSError, RuntimeError):
        return _component(
            "pending",
            code="canonical_evidence_recovery_receipt_purge_unavailable",
        )
    return _component(
        "completed",
        canonical_evidence_purged=True,
        session_messages_purged=True,
        local_finalization_purged=True,
        durable_finalization_purged=durable_purged,
        recovery_receipts_purged=True,
        recovery_receipts_deleted=recovery_receipts_deleted,
        all_prior_attempts_purged=True,
        purge_tombstone_receipt=purge_storage_receipt,
        retention_purge_pending=False,
        **safe_detail,
    )


def _recover_auth_sessions_sync(claims: VoiceLabClaims) -> dict[str, object]:
    dsn = (
        os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL")
        or os.getenv("BETTER_AUTH_DATABASE_URL")
        or ""
    ).strip()
    if not dsn:
        return _component("pending", code="auth_database_configuration_missing")
    try:
        import psycopg

        _active_kid, tombstone_keys = _auth_tombstone_keyring()
        principal_candidates = (
            claims.principal_id,
            *_auth_tombstone_candidates("principal", claims.principal_id),
        )
        run_candidates = {
            claims.test_run_id,
            *_auth_tombstone_candidates("run", claims.test_run_id),
        }
        cleanup_candidates = {
            claims.cleanup_obligation_id,
            *_auth_tombstone_candidates("cleanup", claims.cleanup_obligation_id),
        }

        with psycopg.connect(dsn, connect_timeout=5) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 731941))",
                    (claims.principal_id,),
                )
                cursor.execute(
                    'SELECT "token", "userAgent" FROM public."session" '
                    'WHERE "userId" = %s FOR UPDATE',
                    (claims.principal_id,),
                )
                session_rows = cursor.fetchall()
                parsed_sessions = [
                    (token, _parse_session_marker(marker))
                    for token, marker in session_rows
                ]
                if any(marker is None for _, marker in parsed_sessions):
                    return _component("failed", code="auth_non_lab_session_conflict")
                if any(
                    marker.get("principal_id") != claims.principal_id
                    for _, marker in parsed_sessions
                    if marker is not None
                ):
                    return _component("failed", code="auth_principal_binding_mismatch")
                exact_sessions = [
                    (token, marker)
                    for token, marker in parsed_sessions
                    if marker is not None
                    and marker.get("test_run_id") == claims.test_run_id
                    and marker.get("cleanup_obligation_id")
                    == claims.cleanup_obligation_id
                ]
                if len(exact_sessions) != len(parsed_sessions):
                    return _component("failed", code="auth_active_run_conflict")

                cursor.execute(
                    'SELECT "grant_fingerprint", "test_run_id", "tombstone_kid", '
                    '"cleanup_obligation_id", "issued_at", "jti_sha256", '
                    '"nonce_sha256", "session_token_sha256", "status" '
                    'FROM public."sophia_voice_lab_auth_grants" '
                    'WHERE "principal_id" = ANY(%s) '
                    'OR "cleanup_obligation_id" = ANY(%s) FOR UPDATE',
                    (list(principal_candidates), list(cleanup_candidates)),
                )
                grant_rows = cursor.fetchall()
                exact_grants = [
                    row
                    for row in grant_rows
                    if row[1] in run_candidates
                    and row[3] in cleanup_candidates
                    and row[2] in tombstone_keys
                ]
                if any(
                    row[1] in run_candidates
                    and row[3] in cleanup_candidates
                    and row[2] not in tombstone_keys
                    for row in grant_rows
                ):
                    return _component(
                        "pending", code="auth_tombstone_key_unavailable"
                    )
                if any(
                    row[8] == "active"
                    and (
                        row[1] != claims.test_run_id
                        or row[3] != claims.cleanup_obligation_id
                    )
                    for row in grant_rows
                ):
                    return _component("failed", code="auth_active_run_conflict")

                for token, marker in exact_sessions:
                    if not isinstance(token, str) or marker is None:
                        return _component("failed", code="auth_ledger_binding_mismatch")
                    marker_kid = marker.get("tombstone_kid")
                    if marker_kid not in tombstone_keys:
                        return _component("pending", code="auth_tombstone_key_unavailable")
                    token_hash = hashlib.sha256(token.encode()).hexdigest()
                    bound = any(
                        row[8] == "active"
                        and row[2] == marker_kid
                        and row[3] == marker.get("cleanup_obligation_id")
                        and row[4] == marker.get("issued_at")
                        and hmac.compare_digest(str(row[5]), str(marker.get("jti_sha256")))
                        and hmac.compare_digest(str(row[6]), str(marker.get("nonce_sha256")))
                        and hmac.compare_digest(str(row[7]), token_hash)
                        for row in exact_grants
                    )
                    if not bound:
                        return _component("failed", code="auth_ledger_binding_mismatch")

                grants_revoked = 0
                for row in exact_grants:
                    if row[8] != "active":
                        continue
                    tombstone_kid = str(row[2])
                    cursor.execute(
                        'UPDATE public."sophia_voice_lab_auth_grants" '
                        "SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW()), "
                        "principal_id = %s, test_run_id = %s, cleanup_obligation_id = %s, "
                        "jti_sha256 = %s, nonce_sha256 = %s, session_token_sha256 = %s "
                        "WHERE grant_fingerprint = %s AND tombstone_kid = %s "
                        "AND status = 'active'",
                        (
                            _auth_tombstone_identity(
                                "principal", claims.principal_id, kid=tombstone_kid
                            ),
                            _auth_tombstone_identity(
                                "run", claims.test_run_id, kid=tombstone_kid
                            ),
                            _auth_tombstone_identity(
                                "cleanup",
                                claims.cleanup_obligation_id,
                                kid=tombstone_kid,
                            ),
                            _REDACTED_SHA256,
                            _REDACTED_SHA256,
                            _REDACTED_SHA256,
                            row[0],
                            tombstone_kid,
                        ),
                    )
                    grants_revoked += max(0, cursor.rowcount)
                sessions_revoked = 0
                for token, _marker in exact_sessions:
                    cursor.execute(
                        'DELETE FROM public."session" '
                        'WHERE "userId" = %s AND "token" = %s',
                        (claims.principal_id, token),
                    )
                    sessions_revoked += max(0, cursor.rowcount)
                # Tombstones outlive the signed grant. Expired revoked rows are
                # the only history eligible for bounded retention cleanup.
                cursor.execute(
                    'DELETE FROM public."sophia_voice_lab_auth_grants" '
                    "WHERE status = 'revoked' AND expires_at <= NOW()",
                )
        return _component(
            "completed" if grants_revoked or sessions_revoked else "already_terminal",
            sessions_revoked=sessions_revoked,
            grants_tombstoned=grants_revoked,
        )
    except Exception as exc:  # noqa: BLE001 - safe typed pending state only.
        return _component(
            "pending",
            code="auth_session_revoke_unavailable",
            error_type=type(exc).__name__,
        )


def _persist_recovery_receipt_unlocked(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, str]]:
    from deerflow.sophia.storage import supabase_artifact_store

    if not supabase_artifact_store.is_configured():
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_recovery_durable_receipt_unavailable"},
        )
    stable_recovery_id = str(payload.get("recovery_id") or "")
    intent_path, tombstone_path = _recovery_purge_object_paths_for_id(
        stable_recovery_id
    )
    fence_path = _recovery_purge_fence_path(stable_recovery_id)
    object_path = (
        f"{_RECOVERY_RECEIPT_ROOT}/{_recovery_id_hmac(stable_recovery_id)}"
        f"/attempts/{payload['attempt_id']}.json"
    )
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    try:
        if any(
            _read_json_object_bounded(
                path,
                max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
            )
            is not None
            for path in (intent_path, fence_path, tombstone_path)
        ):
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_recovery_retention_purge_started"},
            )
        result = supabase_artifact_store.create_artifact_object_if_absent(
            object_path,
            serialized,
            content_type="application/json",
        )
        if result == "exists":
            stored = supabase_artifact_store.download_artifact_object_bounded(
                object_path,
                max_bytes=128 * 1024,
            )
            if stored is None:
                raise RuntimeError("receipt unavailable")
            existing = json.loads(stored[0].decode())
            if not isinstance(existing, dict) or any(
                existing.get(key) != payload.get(key)
                for key in (
                    "schema",
                    "test_run_id",
                    "cleanup_obligation_id",
                    "recovery_id",
                    "attempt_id",
                    "environment",
                )
            ):
                raise HTTPException(
                    status_code=409,
                    detail={"code": "voice_lab_recovery_receipt_conflict"},
                )
            payload = existing
            serialized = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        # Close the create-vs-purge-intent race. If purge planning appeared
        # after our first probe, remove this raw receipt and verify absence so
        # the immutable intent's exact count remains authoritative.
        if any(
            _read_json_object_bounded(
                path,
                max_bytes=_RECOVERY_TOMBSTONE_MAX_BYTES,
            )
            is not None
            for path in (intent_path, fence_path, tombstone_path)
        ):
            supabase_artifact_store.delete_artifact_object_if_present(object_path)
            if (
                supabase_artifact_store.download_artifact_object_bounded(
                    object_path,
                    max_bytes=128 * 1024,
                )
                is not None
            ):
                raise RuntimeError("late recovery receipt deletion was not verified")
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_recovery_retention_purge_started"},
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - no provider details escape.
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_recovery_receipt_persistence_failed"},
        ) from exc
    return payload, {
        "storage": "supabase",
        "object_path": object_path,
        "sha256": hashlib.sha256(serialized).hexdigest(),
    }


def _persist_recovery_receipt(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, str]]:
    stable_recovery_id = str(payload.get("recovery_id") or "")
    try:
        with _recovery_receipt_fence_lock(stable_recovery_id):
            return _persist_recovery_receipt_unlocked(payload)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - no database details escape.
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_recovery_receipt_fence_unavailable"},
        ) from exc


@router.post("/runs/{test_run_id}/recover")
async def recover_voice_lab_run(test_run_id: str, request: Request) -> JSONResponse:
    if _body_is_present(request):
        raise HTTPException(
            status_code=400,
            detail={"code": "voice_lab_recovery_body_not_allowed"},
        )
    claims = capability_for_voice_lab_recovery(request, test_run_id)
    canonical_lookup, record = await asyncio.to_thread(
        _lookup_canonical_session,
        claims,
    )
    cleanup_admission_fence = await asyncio.to_thread(
        _close_live_cleanup_admission,
        claims,
        record,
    )
    if (
        cleanup_admission_fence.get("status") == "pending"
        and int(cleanup_admission_fence.get("cleanup_admissions_overdue") or 0) > 0
    ):
        reconciliation = await _reconcile_overdue_cleanup_admissions(claims, record)
        if reconciliation.get("status") in _TERMINAL_COMPONENT_STATUSES:
            cleanup_admission_fence = await asyncio.to_thread(
                _close_live_cleanup_admission,
                claims,
                record,
            )
    if cleanup_admission_fence.get("status") in _TERMINAL_COMPONENT_STATUSES:
        canonical, record = await asyncio.to_thread(_recover_canonical_session, claims)
        voice_provider = await _recover_voice_provider(claims, record)
        builder = await _recover_builder(claims)
        auth_sessions = await asyncio.to_thread(_recover_auth_sessions_sync, claims)
    else:
        canonical = _component(
            "pending",
            code="cleanup_admission_in_flight",
            canonical_binding_status=canonical_lookup.get("status"),
        )
        voice_provider = _component("pending", code="cleanup_admission_in_flight")
        builder = _component("pending", code="cleanup_admission_in_flight")
        auth_sessions = _component("pending", code="cleanup_admission_in_flight")
    canonical_evidence = await asyncio.to_thread(
        _recover_canonical_evidence_retention,
        claims,
        record,
    )
    components = {
        "canonical_session": canonical,
        "cleanup_admission_fence": cleanup_admission_fence,
        "voice_provider": voice_provider,
        "builder": builder,
        "auth_sessions": auth_sessions,
        "canonical_evidence": canonical_evidence,
    }
    live_resources_zero = all(
        component.get("status") in _TERMINAL_COMPONENT_STATUSES
        for name, component in components.items()
        if name != "canonical_evidence"
    )
    retention_purged = canonical_evidence.get("canonical_evidence_purged") is True
    retention_purge_due_at = canonical_evidence.get("retention_expires_at")
    if not isinstance(retention_purge_due_at, str):
        retention_purge_due_at = None
    retention_purge_pending = not retention_purged
    status = (
        "completed"
        if live_resources_zero and retention_purged
        else "live_cleanup_completed_retention_pending"
        if live_resources_zero
        else "pending"
    )
    payload: dict[str, Any] = {
        "schema": "sophia_voice_lab_recovery_v1",
        "status": status,
        # ``complete`` is the backward-compatible immediate-cleanup verdict.
        # Deferred evidence expiry is always represented separately and must
        # never be inferred from this field.
        "complete": live_resources_zero,
        "live_cleanup_complete": live_resources_zero,
        "live_resources_zero": live_resources_zero,
        "retention_maintenance_complete": retention_purged,
        "retention_purge_pending": retention_purge_pending,
        "retention_purged": retention_purged,
        "retention_purge_due_at": retention_purge_due_at,
        "test_run_id": claims.test_run_id,
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "recovery_id": _recovery_id(claims),
        "attempt_id": _attempt_id(claims),
        "attempt_issued_at": claims.issued_at,
        "recovered_at": datetime.now(UTC).isoformat(),
        "environment": claims.environment,
        "expected_deployment": dict(claims.expected_deployment),
        "components": components,
    }
    if retention_purged:
        try:
            receipt = _validate_recovery_purge_storage_receipt(
                canonical_evidence.get("purge_tombstone_receipt"),
                stable_recovery_id=str(payload["recovery_id"]),
            )
        except RuntimeError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "voice_lab_recovery_purge_tombstone_unavailable"},
            ) from exc
        stored = payload
    else:
        stored, receipt = await asyncio.to_thread(_persist_recovery_receipt, payload)
    response_payload = {
        # ``ok`` means the authenticated request was accepted and either its
        # attempt receipt or the final redacted purge tombstone was durably
        # observed. Component convergence is represented separately.
        "ok": True,
        "complete": bool(stored.get("complete")),
        "live_cleanup_complete": bool(stored.get("live_cleanup_complete")),
        "live_resources_zero": bool(stored.get("live_resources_zero")),
        "retention_maintenance_complete": bool(
            stored.get("retention_maintenance_complete")
        ),
        "retention_purge_pending": bool(stored.get("retention_purge_pending")),
        "retention_purged": bool(stored.get("retention_purged")),
        "retention_purge_due_at": stored.get("retention_purge_due_at"),
        "test_run_id": stored["test_run_id"],
        "recovery_id": stored["recovery_id"],
        "attempt_id": stored["attempt_id"],
        "attempt_issued_at": stored["attempt_issued_at"],
        "recovered_at": stored["recovered_at"],
        "components": stored["components"],
        "receipt": receipt,
    }
    return JSONResponse(
        response_payload,
        status_code=200 if response_payload["live_cleanup_complete"] else 202,
        headers={"Cache-Control": "no-store"},
    )
