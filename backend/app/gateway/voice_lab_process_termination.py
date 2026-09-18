"""Typed browser-process death evidence from the private worker recovery boundary.

This is not a WebSocket close receipt or proof that the Voice owner has stopped.
Only the authenticated recovery worker may submit it; public app/MCP input never
supplies it. D02 retains its separate independent-owner protocol.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any

_HASH = re.compile(r"^[a-f0-9]{64}$")
_HASH_FIELDS = {
    "run_id_sha256", "test_run_id_sha256", "cleanup_obligation_id_sha256",
    "provider_session_id_sha256", "execution_ownership_sha256", "process_id_sha256",
    "browser_boot_id_sha256", "execution_epoch_sha256", "worker_id_sha256",
    "process_closed_event_sha256", "receipt_sha256",
}
_INT_FIELDS = {"provider_connection_epoch", "browser_lease_epoch", "process_acquired_seq", "runtime_acquired_seq", "process_closed_seq"}
_BOOL_FIELDS = {"one_process_per_run", "browser_process_disconnected", "browser_registry_absent"}

def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()

def _text_digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()

def parse_browser_process_termination(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _HASH_FIELDS | _INT_FIELDS | _BOOL_FIELDS | {"schema", "process_closed_at"}:
        raise ValueError("process termination fields invalid")
    if value["schema"] != "sophia_voice_lab_browser_process_termination_v1":
        raise ValueError("process termination schema invalid")
    if any(not isinstance(value[k], str) or not _HASH.fullmatch(value[k]) for k in _HASH_FIELDS):
        raise ValueError("process termination hash invalid")
    if any(type(value[k]) is not int or not 0 < value[k] <= 9007199254740991 for k in _INT_FIELDS):
        raise ValueError("process termination ordinal invalid")
    if any(value[k] is not True for k in _BOOL_FIELDS):
        raise ValueError("process termination not proven")
    stamp = value["process_closed_at"]
    if not isinstance(stamp, str):
        raise ValueError("process termination time invalid")
    parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z") != stamp:
        raise ValueError("process termination time invalid")
    if not value["process_acquired_seq"] < value["runtime_acquired_seq"] < value["process_closed_seq"]:
        raise ValueError("process termination order invalid")
    core = {k: v for k, v in value.items() if k != "receipt_sha256"}
    if _digest(core) != value["receipt_sha256"]:
        raise ValueError("process termination digest invalid")
    return dict(value)

def browser_process_settlement_digest(receipt: object) -> str:
    return _digest({"basis": "browser_process_terminated", "receipt": parse_browser_process_termination(receipt)})

def browser_process_receipt(synthetic: object) -> object | None:
    """Read the explicit process schema in the existing browser terminal union.

    Mixed process/WebSocket proofs are invalid, not an opportunity to fall back
    to WebSocket parsing. An empty object preserves that fail-closed distinction.
    """
    receipts = synthetic.get("voice_provider_browser_close_receipts") if isinstance(synthetic, dict) else None
    if not isinstance(receipts, list) or not any(isinstance(item, dict) and item.get("schema") == "sophia_voice_lab_browser_process_termination_v1" for item in receipts):
        return None
    return receipts[0] if len(receipts) == 1 else {}

def stored_browser_process_settlement(synthetic: object) -> str | None:
    if not isinstance(synthetic, dict) or synthetic.get("scenario_id") == "V-D02" or synthetic.get("voice_provider_resource_state") != "closed":
        return None
    raw = browser_process_receipt(synthetic)
    if raw is None:
        return None
    try:
        receipt = parse_browser_process_termination(raw)
        for field, metadata_field in (("test_run_id_sha256", "test_run_id"), ("cleanup_obligation_id_sha256", "cleanup_obligation_id"), ("provider_session_id_sha256", "voice_runtime_session_id")):
            identity = synthetic.get(metadata_field)
            if not isinstance(identity, str) or receipt[field] != _text_digest(identity):
                return None
        if synthetic.get("voice_provider_connection_epoch") != receipt["provider_connection_epoch"] or synthetic.get("voice_provider_pending_connection_epoch") is not None:
            return None
        if synthetic.get("voice_provider_activation_abort_receipts") != []:
            return None
        return browser_process_settlement_digest(receipt)
    except (ValueError, TypeError):
        return None

def accept_browser_process_termination(claims: Any, record: Any, raw: object) -> str:
    """Commit process-death basis, then let the existing Voice owner acknowledge zero.

    Called only after both private recovery authentications and exact session
    lookup. The atomic provider fence rejects activation races and replay drift.
    No admission is consumed here and no provider-zero result is manufactured.
    """
    from app.gateway.routers import sessions, voice
    from app.gateway.voice_lab_capability import assert_voice_lab_session_record
    from deerflow.sophia.cleanup_fence import (
        cleanup_admissions,
        close_cleanup_provider_session,
        verify_cleanup_provider_settlement_replay,
    )

    if claims.scenario_id == "V-D02" or record is None:
        raise ValueError("process termination scope unavailable")
    assert_voice_lab_session_record(record, claims)
    receipt = parse_browser_process_termination(raw)
    synthetic = dict(record.metadata.get("synthetic_voice_lab") or {})
    provider_id = synthetic.get("voice_runtime_session_id")
    if (not isinstance(provider_id, str) or not provider_id
        or receipt["test_run_id_sha256"] != _text_digest(claims.test_run_id)
        or receipt["cleanup_obligation_id_sha256"] != _text_digest(claims.cleanup_obligation_id)
        or receipt["provider_session_id_sha256"] != _text_digest(provider_id)
        or receipt["provider_connection_epoch"] != synthetic.get("voice_provider_connection_epoch")
        or synthetic.get("voice_provider_pending_connection_epoch") is not None
        or synthetic.get("voice_provider_resource_expires_at") != claims.provider_expires_at):
        raise ValueError("process termination canonical binding mismatch")
    digest = browser_process_settlement_digest(receipt)
    existing = browser_process_receipt(synthetic)
    if existing is not None:
        if existing != receipt or stored_browser_process_settlement(synthetic) != digest or not verify_cleanup_provider_settlement_replay(claims.cleanup_obligation_id, digest):
            raise ValueError("process termination replay conflict")
        return digest
    closed_at = datetime.fromisoformat(receipt["process_closed_at"].replace("Z", "+00:00"))
    activated_at = datetime.fromisoformat(str(synthetic.get("voice_provider_activated_at") or "").replace("Z", "+00:00"))
    if activated_at.tzinfo is None or closed_at < activated_at or closed_at > datetime.now(UTC):
        raise ValueError("process termination predates active provider or is future")
    matches = [item for item in cleanup_admissions(claims.cleanup_obligation_id)
        if item.resource_kind == "provider" and item.resource_id == provider_id
        and item.admission_id == synthetic.get("cleanup_provider_admission_id")]
    if len(matches) != 1 or matches[0].status != "browser_active" or synthetic.get("voice_provider_resource_state") != "active":
        raise ValueError("process termination provider admission unavailable")
    metadata = dict(record.metadata)
    next_synthetic = dict(synthetic)
    next_synthetic.update({
        "voice_provider_resource_state": "closed",
        "voice_provider_closed_at": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "voice_provider_pending_connection_epoch": None,
        "voice_provider_browser_close_receipts": [receipt],
        "voice_provider_activation_abort_receipts": [],
    })
    metadata["synthetic_voice_lab"] = next_synthetic
    close_cleanup_provider_session(
        matches[0], user_id=record.user_id, session_id=record.session_id,
        metadata=metadata, expected_provider_state="active",
        expected_activated_epoch=receipt["provider_connection_epoch"], expected_pending_epoch=None,
        expected_activation_receipt=synthetic.get("voice_provider_activation_receipt"),
        terminal_status="browser_closed", settlement_sha256=digest,
        retention_expires_at=synthetic["retention_expires_at"], provider_expires_at=claims.provider_expires_at,
        local_persist=lambda expected, updates: voice._persist_synthetic_provider_metadata_if_unchanged(
            sessions._store, user_id=record.user_id, session_id=record.session_id, expected=expected, updates=updates,
        ),
    )
    return digest
