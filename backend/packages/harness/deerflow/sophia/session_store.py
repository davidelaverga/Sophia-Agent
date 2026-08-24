"""Session metadata and transcript persistence for Sophia.

Local development uses JSON files under ``users/{user_id}``. Production can
select the Supabase Postgres-backed implementation with
``SOPHIA_SESSION_STORE=supabase`` so Render's ephemeral filesystem is never the
hot-path source of truth for conversation history.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

SessionStatus = Literal[
    "open",
    "paused",
    "ended",
    "abandoned",
    "interrupted",
    "resumable",
    "active",
]
SessionMode = Literal["text", "voice", "mixed"]
SessionMessageRole = Literal["user", "assistant", "system", "tool", "artifact"]


class SessionRecord(BaseModel):
    """Persistent session metadata.

    The legacy API still exposes ``open`` / ``paused`` / ``ended``. The
    Supabase schema stores the product-facing equivalents ``active`` /
    ``resumable`` / ``ended`` and maps them back here for compatibility.
    """

    session_id: str
    thread_id: str
    user_id: str
    status: SessionStatus = "open"
    title: str | None = None
    preset_type: str = "open"
    context_mode: str = "life"
    platform: str = "text"
    mode: SessionMode | None = None
    run_id: str | None = None
    message_count: int = 0
    last_message_preview: str | None = None
    created_at: str = Field(default_factory=lambda: _now_iso())
    updated_at: str = Field(default_factory=lambda: _now_iso())
    last_message_at: str | None = None
    ended_at: str | None = None
    recap_status: str | None = None
    checkpointer_available: bool | None = None
    transcript_available: bool = False
    memory_processed_until_sequence: int = 0
    recap_processed_until_sequence: int = 0
    last_memory_extraction_at: str | None = None
    last_recap_extraction_at: str | None = None
    last_memory_extraction_run_id: str | None = None
    memory_extraction_status: str | None = None
    memory_extraction_error_code: str | None = None
    memory_extraction_range_start: int | None = None
    memory_extraction_range_end: int | None = None
    active_segment_started_at: str | None = None
    segment_count: int = 1
    continuation_count: int = 0
    message_revision: int = 0
    intention: str | None = None
    focus_cue: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionMessageRecord(BaseModel):
    """Persistent ordered transcript message for a Sophia session."""

    message_id: str
    session_id: str
    thread_id: str
    role: SessionMessageRole
    content: str
    created_at: str = Field(default_factory=lambda: _now_iso())
    source: str = "text"
    final: bool = True
    approximate: bool = False
    turn_id: str | None = None
    provider_event_id: str | None = None
    sequence: int = 0
    redaction_level: str = "none"
    metadata: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class SessionMessageSnapshotResult:
    """Revision receipt for a browser snapshot admission."""

    messages: list[SessionMessageRecord]
    previous_revision: int
    current_revision: int
    accepted: bool
    duplicate: bool = False
    conflict: bool = False
    deleted_count: int = 0
    rejection_reason: str | None = None


@dataclass(frozen=True)
class SyntheticSessionFinalizationResult:
    """One atomic synthetic transcript/lifecycle/fence finalization receipt."""

    record: SessionRecord
    messages: list[SessionMessageRecord]
    finalized_at: str
    retention_expires_at: str
    evidence_receipt: dict[str, str]
    duplicate: bool = False


class SessionTranscriptStore(Protocol):
    """Storage contract for session metadata and ordered transcript messages."""

    allow_legacy_dev_user_fallback: bool

    def upsert_session(self, metadata: SessionRecord) -> SessionRecord: ...

    def get_session(self, user_id: str, session_id: str) -> SessionRecord | None: ...

    def find_session_by_thread_id(self, user_id: str, thread_id: str) -> SessionRecord | None: ...

    def find_session_by_run_id(self, user_id: str, run_id: str) -> SessionRecord | None: ...

    def find_session_by_cleanup_obligation_id(
        self,
        cleanup_obligation_id: str,
    ) -> SessionRecord | None: ...

    def find_any_session_by_thread_id(self, thread_id: str) -> SessionRecord | None: ...

    def list_sessions(self, user_id: str) -> list[SessionRecord]: ...

    def expired_synthetic_sessions(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> list[SessionRecord]: ...

    def append_or_upsert_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]: ...

    def replace_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]: ...

    def replace_messages_revisioned(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
        *,
        expected_revision: int,
    ) -> SessionMessageSnapshotResult: ...

    def finalize_synthetic_session(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
        *,
        expected_revision: int,
        cleanup_obligation_id: str,
        provider_expires_at: str,
        retention_hours: int,
        expected_synthetic_binding: dict[str, object],
        expected_deployment: dict[str, str],
        message_metadata_base: dict[str, object],
        canonical_transcript_sha256: str,
        canonical_transcript_json: str,
        finalization_started_at: str,
        turn_count: int,
        capability_jti_sha256: str,
    ) -> SyntheticSessionFinalizationResult: ...

    def list_messages(self, user_id: str, session_id: str) -> list[SessionMessageRecord]: ...

    def read_exact_session_messages(
        self,
        user_id: str,
        session_id: str,
    ) -> list[SessionMessageRecord]: ...

    def purge_synthetic_session(
        self,
        user_id: str,
        session_id: str,
        *,
        cleanup_obligation_id: str,
        retention_expires_at: str,
        provider_expires_at: str,
    ) -> bool: ...

    def mark_session_ended(self, user_id: str, session_id: str) -> SessionRecord | None: ...

    def mark_session_abandoned(self, user_id: str, session_id: str) -> SessionRecord | None: ...


class SessionStoreConfigurationError(RuntimeError):
    """Raised when the requested session store cannot be safely configured."""


class SessionStoreError(RuntimeError):
    """Raised when the configured session store rejects a backend operation."""


class SessionEvidenceIntegrityError(SessionStoreError):
    """Raised when raw finalization evidence exists but violates its exact shape."""


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_DEFAULT_BASE_PATH = Path("users")
_MESSAGE_ID_NAMESPACE = uuid.UUID("6e6291e3-f564-42a1-94bb-50d1145cb184")
_AUTHORITATIVE_WRITE_RETRIES = 4
_CLEANUP_OBLIGATION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_POSTGRES_FINALIZATION_RECEIPT_SCHEMA = (
    "sophia_voice_lab_postgres_finalization_receipt_v1"
)

_DB_STATUS_BY_RECORD_STATUS: dict[str, str] = {
    "open": "active",
    "active": "active",
    "paused": "resumable",
    "resumable": "resumable",
    "ended": "ended",
    "abandoned": "abandoned",
    "interrupted": "interrupted",
}
_RECORD_STATUS_BY_DB_STATUS: dict[str, SessionStatus] = {
    "active": "open",
    "resumable": "paused",
    "ended": "ended",
    "abandoned": "abandoned",
    "interrupted": "interrupted",
    "open": "open",
    "paused": "paused",
}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


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


def _normalize_database_timestamp(value: object) -> str | None:
    """Normalize trusted TIMESTAMPTZ projections to the signed UTC format."""

    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return _canonical_utc_millis(parsed)


def _finalization_receipt_object_path(session_id: str) -> str:
    return (
        "public.sophia_sessions/"
        f"{session_id}/metadata/synthetic_voice_lab/finalization_receipt"
    )


def _length_prefixed_receipt_basis(values: list[str]) -> bytes:
    encoded: list[bytes] = []
    for value in values:
        raw = value.encode("utf-8")
        encoded.extend((str(len(raw)).encode("ascii"), b":", raw, b";"))
    return b"".join(encoded)


def _build_postgres_finalization_receipt(
    *,
    user_id: str,
    session_id: str,
    thread_id: str,
    expected_synthetic_binding: dict[str, object],
    expected_deployment: dict[str, str],
    finalized_at: str,
    retention_hours: int,
    retention_expires_at: str,
    provider_expires_at: str,
    message_revision: int,
    message_count: int,
    canonical_transcript_sha256: str,
    finalization_started_at: str,
    turn_count: int,
    capability_jti_sha256: str,
) -> dict[str, object]:
    cleanup_id = expected_synthetic_binding.get("cleanup_obligation_id")
    object_path = _finalization_receipt_object_path(session_id)
    values = [
        _POSTGRES_FINALIZATION_RECEIPT_SCHEMA,
        str(cleanup_id or ""),
        user_id,
        session_id,
        thread_id,
        str(expected_synthetic_binding.get("principal_id") or ""),
        str(expected_synthetic_binding.get("test_run_id") or ""),
        str(expected_synthetic_binding.get("scenario_id") or ""),
        str(expected_synthetic_binding.get("scenario_version") or ""),
        str(expected_synthetic_binding.get("environment") or ""),
        str(expected_deployment.get("frontend") or ""),
        str(expected_deployment.get("backend") or ""),
        str(expected_deployment.get("voice") or ""),
        finalized_at,
        str(retention_hours),
        retention_expires_at,
        provider_expires_at,
        str(message_revision),
        str(message_count),
        canonical_transcript_sha256,
        finalization_started_at,
        str(turn_count),
        capability_jti_sha256,
        object_path,
    ]
    receipt_sha256 = hashlib.sha256(
        _length_prefixed_receipt_basis(values)
    ).hexdigest()
    return {
        "schema": _POSTGRES_FINALIZATION_RECEIPT_SCHEMA,
        "storage": "postgres_session",
        "object_path": object_path,
        "sha256": receipt_sha256,
        "cleanup_obligation_id": cleanup_id,
        "transcript_sha256": canonical_transcript_sha256,
        "finalized_at": finalized_at,
        "retention_expires_at": retention_expires_at,
        "provider_expires_at": provider_expires_at,
        "message_revision": message_revision,
        "message_count": message_count,
        "started_at": finalization_started_at,
        "turn_count": turn_count,
        "capability_jti_sha256": capability_jti_sha256,
    }


def _synthetic_retention_deadline(record: SessionRecord) -> datetime | None:
    synthetic = record.metadata.get("synthetic_voice_lab")
    if not isinstance(synthetic, dict) or synthetic.get("synthetic") is not True:
        return None
    if synthetic.get("principal_id") != record.user_id:
        return None
    if synthetic.get("test_run_id") != record.run_id:
        return None
    cleanup_obligation_id = synthetic.get("cleanup_obligation_id")
    if (
        not isinstance(cleanup_obligation_id, str)
        or not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id)
    ):
        return None
    retention_hours = synthetic.get("retention_hours")
    if (
        not isinstance(retention_hours, int)
        or isinstance(retention_hours, bool)
        or not 1 <= retention_hours <= 168
    ):
        return None
    expiry = _parse_canonical_utc_millis(synthetic.get("retention_expires_at"))
    if expiry is None:
        return None
    anchor = synthetic.get("retention_anchor")
    if anchor == "session_created_at_provisional":
        anchor_at = _parse_canonical_utc_millis(record.created_at)
        if anchor_at is None:
            try:
                parsed_created = datetime.fromisoformat(record.created_at.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed_created.tzinfo is None:
                return None
            anchor_at = parsed_created.astimezone(UTC)
        if synthetic.get("finalized_at") is not None:
            return None
    elif anchor == "finalized_at":
        anchor_at = _parse_canonical_utc_millis(synthetic.get("finalized_at"))
        if (
            anchor_at is None
            or record.status != "ended"
            or record.ended_at != synthetic.get("finalized_at")
        ):
            return None
    else:
        return None
    expected = _canonical_utc_millis(anchor_at + timedelta(hours=retention_hours))
    return expiry if synthetic.get("retention_expires_at") == expected else None


def _validate_synthetic_scan_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10_000:
        raise ValueError("synthetic session scan limit must be between 1 and 10000")
    return limit


def _message_sort_key(message: SessionMessageRecord) -> tuple[int, str, str]:
    return (message.sequence, message.created_at or "", message.message_id)


def _normalize_message_content(content: str | None) -> str:
    return " ".join((content or "").split()).strip()


def _message_content_hash(content: str | None) -> str:
    normalized = _normalize_message_content(content).lower()
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def _message_dedupe_key(message: SessionMessageRecord) -> tuple[str, str]:
    if message.provider_event_id:
        return ("provider_event_id", message.provider_event_id)
    if message.turn_id:
        return ("turn", f"{message.turn_id}:{message.role}:{message.sequence}")
    return ("message_id", message.message_id)


def derive_message_id(
    *,
    session_id: str,
    role: str,
    sequence: int,
    message_id: str | None = None,
    turn_id: str | None = None,
    provider_event_id: str | None = None,
    content: str | None = None,
) -> str:
    """Return a stable id for transcript retry/idempotency.

    Client/provider ids are preserved when present. If absent, a deterministic
    UUIDv5 is derived from session + role plus stable provider/turn and content
    information. Sequence remains an ordering hint, never the sole identity
    source when visible content is available.
    """

    candidate = (message_id or "").strip()
    if candidate:
        return candidate

    content_hash = _message_content_hash(content)
    stable_anchor = provider_event_id or turn_id
    if stable_anchor and content_hash:
        stable_basis = f"{stable_anchor}:{content_hash}"
    elif stable_anchor:
        stable_basis = stable_anchor
    elif content_hash:
        stable_basis = f"{sequence}:{content_hash}"
    else:
        stable_basis = f"{sequence}:{role}"
    return str(uuid.uuid5(_MESSAGE_ID_NAMESPACE, f"{session_id}:{role}:{stable_basis}"))


def _storage_message_row_id(message: SessionMessageRecord) -> str:
    stable_basis = message.provider_event_id or message.turn_id or message.message_id or f"{message.sequence}:{message.role}"
    return str(uuid.uuid5(_MESSAGE_ID_NAMESPACE, f"{message.session_id}:{message.role}:{stable_basis}"))


def _validate_exact_finalization_messages(
    messages: list[SessionMessageRecord],
    *,
    session_id: str,
) -> list[SessionMessageRecord]:
    """Reject any raw transcript shape the finalization RPC could not attest."""

    ordered = sorted(messages, key=_message_sort_key)
    if len(ordered) > 512:
        raise SessionEvidenceIntegrityError(
            "Synthetic finalization transcript has too many rows."
        )
    if [message.sequence for message in ordered] != list(range(1, len(ordered) + 1)):
        raise SessionEvidenceIntegrityError(
            "Synthetic finalization transcript sequence set drifted."
        )
    message_ids: set[str] = set()
    storage_ids: set[str] = set()
    total_content_bytes = 0
    for message in ordered:
        content_bytes = len(message.content.encode("utf-8"))
        total_content_bytes += content_bytes
        storage_id = _storage_message_row_id(message)
        if (
            message.session_id != session_id
            or message.role not in {"user", "assistant"}
            or message.final is not True
            or not message.message_id
            or message.message_id in message_ids
            or storage_id in storage_ids
            or not message.thread_id
            or not message.content.strip()
            or content_bytes > 32 * 1024
            or _parse_canonical_utc_millis(message.created_at) is None
            or not isinstance(message.metadata, dict)
        ):
            raise SessionEvidenceIntegrityError(
                "Synthetic finalization transcript row drifted."
            )
        message_ids.add(message.message_id)
        storage_ids.add(storage_id)
    if total_content_bytes > 1024 * 1024:
        raise SessionEvidenceIntegrityError(
            "Synthetic finalization transcript content is too large."
        )
    return ordered


def _message_identity_keys(message: SessionMessageRecord) -> list[tuple[str, str]]:
    keys: list[tuple[str, str]] = []
    if message.provider_event_id:
        keys.append(("provider_event_id", message.provider_event_id))
    if message.message_id:
        keys.append(("message_id", message.message_id))
    if message.turn_id:
        keys.append(("turn", f"{message.turn_id}:{message.role}"))

    content_hash = _message_content_hash(message.content)
    if content_hash and message.created_at:
        keys.append(("content_at", f"{message.role}:{message.created_at}:{content_hash}"))
    if content_hash:
        keys.append(("content_order", f"{message.role}:{message.sequence}:{content_hash}"))

    if not keys:
        keys.append(("row", _storage_message_row_id(message)))
    return keys


def _prefer_message(left: SessionMessageRecord, right: SessionMessageRecord) -> SessionMessageRecord:
    def timestamp_score(value: str | None) -> tuple[int, float, str]:
        if not value:
            return (0, float("-inf"), "")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return (0, float("-inf"), value)
        if parsed.tzinfo is None:
            return (0, float("-inf"), value)
        # Equivalent offset/Z spellings describe one instant. Keep no textual
        # tiebreaker so the right-hand retry wins the intentional >= tie.
        return (1, parsed.astimezone(UTC).timestamp(), "")

    left_score = (
        1 if left.final else 0,
        0 if left.approximate else 1,
        len(_normalize_message_content(left.content)),
        timestamp_score(left.created_at),
    )
    right_score = (
        1 if right.final else 0,
        0 if right.approximate else 1,
        len(_normalize_message_content(right.content)),
        timestamp_score(right.created_at),
    )
    return right if right_score >= left_score else left


def _merge_messages_without_deletion(
    left: list[SessionMessageRecord],
    right: list[SessionMessageRecord],
) -> list[SessionMessageRecord]:
    """Merge append-style records without granting deletion authority."""
    merged: dict[tuple[str, str], SessionMessageRecord] = {}
    for message in [*left, *right]:
        key = _message_dedupe_key(message)
        previous = merged.get(key)
        merged[key] = message if previous is None else _prefer_message(previous, message)
    return sorted(merged.values(), key=_message_sort_key)


def canonical_visible_messages(messages: list[SessionMessageRecord]) -> list[SessionMessageRecord]:
    """Return final, visible transcript messages in deterministic order.

    This is intentionally defensive: production may already contain duplicate
    rows written by older snapshot/end-session paths with different ids. We keep
    the most complete copy for matching message ids/provider ids/turn ids and
    for exact role+timestamp+content collisions.
    """

    deduped: list[SessionMessageRecord] = []
    index_by_key: dict[tuple[str, str], int] = {}

    for message in sorted(messages, key=_message_sort_key):
        if message.role not in {"user", "assistant"}:
            continue
        if not message.final:
            continue
        if not _normalize_message_content(message.content):
            continue

        keys = _message_identity_keys(message)
        existing_index = next((index_by_key[key] for key in keys if key in index_by_key), None)
        if existing_index is None:
            index_by_key.update({key: len(deduped) for key in keys})
            deduped.append(message)
            continue

        preferred = _prefer_message(deduped[existing_index], message)
        deduped[existing_index] = preferred
        for key in _message_identity_keys(preferred):
            index_by_key[key] = existing_index

    return sorted(deduped, key=_message_sort_key)


def _coerce_mode(record: SessionRecord) -> SessionMode:
    if record.mode in {"text", "voice", "mixed"}:
        return record.mode
    if record.platform in {"voice", "ios_voice"}:
        return "voice"
    return "text"


def _to_db_status(status: str) -> str:
    return _DB_STATUS_BY_RECORD_STATUS.get(status, status)


def _from_db_status(status: object) -> SessionStatus:
    if isinstance(status, str):
        return _RECORD_STATUS_BY_DB_STATUS.get(status, "open")
    return "open"


def _truthy_env(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _is_production_runtime() -> bool:
    if os.getenv("RENDER") or os.getenv("RENDER_SERVICE_ID") or os.getenv("RENDER_SERVICE_NAME"):
        return True
    for key in ("SOPHIA_ENV", "APP_ENV", "ENVIRONMENT"):
        if (os.getenv(key) or "").strip().lower() == "production":
            return True
    return False


# ---------------------------------------------------------------------------
# Filesystem implementation
# ---------------------------------------------------------------------------


class FilesystemSessionTranscriptStore:
    """JSON-file implementation used by local/dev and tests."""

    allow_legacy_dev_user_fallback = True

    def __init__(self, base_path: Path | str | None = None) -> None:
        self._base = Path(base_path) if base_path is not None else _DEFAULT_BASE_PATH
        self._revision_lock = threading.RLock()

    # -- helpers -------------------------------------------------------------

    def _user_dir(self, user_id: str) -> Path:
        return self._base / user_id / "sessions"

    def _session_path(self, user_id: str, session_id: str) -> Path:
        return self._user_dir(user_id) / f"{session_id}.json"

    def _transcript_dir(self, user_id: str) -> Path:
        return self._base / user_id / "transcripts"

    def _transcript_path(self, user_id: str, session_id: str) -> Path:
        return self._transcript_dir(user_id) / f"{session_id}.json"

    def _write(self, record: SessionRecord) -> None:
        path = self._session_path(record.user_id, record.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(record.model_dump_json(indent=2), encoding="utf-8")

    def _read(self, path: Path) -> SessionRecord | None:
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return SessionRecord.model_validate(data)
        except (json.JSONDecodeError, Exception):
            logger.warning("Corrupt session file: %s", path)
            return None

    def _write_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> None:
        ordered = sorted(messages, key=_message_sort_key)
        path = self._transcript_path(user_id, session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "session_id": session_id,
            "updated_at": _now_iso(),
            "messages": [message.model_dump() for message in ordered],
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        self._mark_transcript_available(user_id, session_id, ordered)

    def _read_messages(self, user_id: str, session_id: str) -> list[SessionMessageRecord]:
        path = self._transcript_path(user_id, session_id)
        if not path.is_file():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            raw_messages = data.get("messages", []) if isinstance(data, dict) else data
            if not isinstance(raw_messages, list):
                return []
            messages: list[SessionMessageRecord] = []
            for item in raw_messages:
                if not isinstance(item, dict):
                    continue
                message = SessionMessageRecord.model_validate(item)
                if message.session_id == session_id:
                    messages.append(message)
            return sorted(messages, key=_message_sort_key)
        except (json.JSONDecodeError, Exception):
            logger.warning("Corrupt session transcript file: %s", path)
            return []

    def _mark_transcript_available(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> None:
        record = self.get(user_id, session_id)
        if record is None or not messages:
            return
        last_message_at = max((message.created_at for message in messages if message.created_at), default=None)
        updates: dict[str, object] = {"transcript_available": True}
        if last_message_at:
            updates["last_message_at"] = last_message_at
        self.update(user_id, session_id, **updates)

    # -- required abstraction API -------------------------------------------

    def upsert_session(self, metadata: SessionRecord) -> SessionRecord:
        return self.create(metadata)

    def get_session(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.get(user_id, session_id)

    def find_session_by_thread_id(self, user_id: str, thread_id: str) -> SessionRecord | None:
        for record in self._list_all(user_id):
            if record.thread_id == thread_id:
                return record
        return None

    def find_session_by_run_id(self, user_id: str, run_id: str) -> SessionRecord | None:
        matches = [record for record in self._list_all(user_id) if record.run_id == run_id]
        if len(matches) > 1:
            raise SessionStoreError("Multiple sessions matched one Voice Lab run id.")
        return matches[0] if matches else None

    def find_session_by_cleanup_obligation_id(
        self,
        cleanup_obligation_id: str,
    ) -> SessionRecord | None:
        if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
            raise ValueError("cleanup obligation id must be a canonical UUIDv4")
        if not self._base.is_dir():
            return None
        matches: list[SessionRecord] = []
        for session_path in self._base.glob("*/sessions/*.json"):
            record = self._read(session_path)
            synthetic = (
                record.metadata.get("synthetic_voice_lab")
                if record is not None and isinstance(record.metadata, dict)
                else None
            )
            if (
                isinstance(synthetic, dict)
                and synthetic.get("synthetic") is True
                and synthetic.get("cleanup_obligation_id")
                == cleanup_obligation_id
            ):
                matches.append(record)
        if len(matches) > 1:
            raise SessionStoreError(
                "Multiple sessions matched one Voice Lab cleanup obligation id."
            )
        return matches[0] if matches else None

    def find_any_session_by_thread_id(self, thread_id: str) -> SessionRecord | None:
        if not self._base.is_dir():
            return None
        for session_path in self._base.glob("*/sessions/*.json"):
            record = self._read(session_path)
            if record is not None and record.thread_id == thread_id:
                return record
        return None

    def list_sessions(self, user_id: str) -> list[SessionRecord]:
        return self._list_all(user_id)

    def expired_synthetic_sessions(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> list[SessionRecord]:
        """Return a bounded cross-principal scan of exact expired lab rows."""

        bounded_limit = _validate_synthetic_scan_limit(limit)
        current = now.astimezone(UTC)
        if not self._base.is_dir():
            return []
        due: list[tuple[datetime, SessionRecord]] = []
        for session_path in self._base.glob("*/sessions/*.json"):
            record = self._read(session_path)
            if record is None:
                continue
            deadline = _synthetic_retention_deadline(record)
            if deadline is not None and deadline <= current:
                due.append((deadline, record))
        due.sort(key=lambda item: (item[0], item[1].session_id))
        return [record for _deadline, record in due[:bounded_limit]]

    def append_or_upsert_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        with self._revision_lock:
            record = self.get(user_id, session_id)
            if record is None:
                raise SessionStoreError("Session not found while appending messages.")
            incoming = [message for message in messages if message.session_id == session_id]
            merged = _merge_messages_without_deletion(
                self._read_messages(user_id, session_id),
                incoming,
            )
            return self.replace_messages_revisioned(
                user_id,
                session_id,
                merged,
                expected_revision=max(0, int(record.message_revision)),
            ).messages

    def mark_session_ended(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.end(user_id, session_id)

    def mark_session_abandoned(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="abandoned")

    # -- compatibility API ---------------------------------------------------

    def create(self, record: SessionRecord) -> SessionRecord:
        self._write(record)
        return record

    def get(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self._read(self._session_path(user_id, session_id))

    def update(self, user_id: str, session_id: str, **updates: object) -> SessionRecord | None:
        record = self.get(user_id, session_id)
        if record is None:
            return None
        changes = {k: v for k, v in updates.items() if k in SessionRecord.model_fields}
        if not changes:
            return record
        changes["updated_at"] = _now_iso()
        updated = record.model_copy(update=changes)
        self._write(updated)
        return updated

    def end(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="ended", ended_at=_now_iso())

    def pause(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="paused", ended_at=None)

    def resume(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="open", ended_at=None)

    def delete(self, user_id: str, session_id: str) -> bool:
        path = self._session_path(user_id, session_id)
        if not path.is_file():
            return False
        path.unlink()
        transcript_path = self._transcript_path(user_id, session_id)
        try:
            transcript_path.unlink()
        except FileNotFoundError:
            pass
        return True

    def purge_synthetic_session(
        self,
        user_id: str,
        session_id: str,
        *,
        cleanup_obligation_id: str,
        retention_expires_at: str,
        provider_expires_at: str,
    ) -> bool:
        """Delete a finalized local session while holding its exact fence."""

        from deerflow.sophia.cleanup_fence import local_cleanup_retention_guard

        with self._revision_lock:
            record = self.get_session(user_id, session_id)
            transcript_path = self._transcript_path(user_id, session_id)
            if record is None:
                if transcript_path.exists():
                    raise SessionEvidenceIntegrityError(
                        "Synthetic retention purge found orphan transcript rows."
                    )
                return True
            synthetic = (
                record.metadata.get("synthetic_voice_lab")
                if isinstance(record.metadata, dict)
                else None
            )
            receipt = (
                synthetic.get("finalization_receipt")
                if isinstance(synthetic, dict)
                else None
            )
            finalized_binding = (
                record.status == "ended"
                and isinstance(synthetic, dict)
                and synthetic.get("retention_anchor") == "finalized_at"
                and isinstance(synthetic.get("finalized_at"), str)
                and record.ended_at == synthetic.get("finalized_at")
                and isinstance(receipt, dict)
                and receipt.get("storage") == "postgres_session"
                and receipt.get("cleanup_obligation_id")
                == cleanup_obligation_id
            )
            provisional_binding = (
                record.status in {"active", "open", "paused", "resumable"}
                and isinstance(synthetic, dict)
                and synthetic.get("retention_anchor")
                == "session_created_at_provisional"
                and synthetic.get("finalized_at") is None
                and receipt is None
                and record.ended_at is None
            )
            if (
                record.user_id != user_id
                or not isinstance(synthetic, dict)
                or synthetic.get("synthetic") is not True
                or synthetic.get("cleanup_obligation_id")
                != cleanup_obligation_id
                or synthetic.get("retention_expires_at")
                != retention_expires_at
                or synthetic.get("provider_expires_at") != provider_expires_at
                or not (finalized_binding or provisional_binding)
            ):
                raise SessionEvidenceIntegrityError(
                    "Synthetic retention purge session binding conflicts."
                )
            with local_cleanup_retention_guard(
                cleanup_obligation_id,
                retention_expires_at,
                provider_expires_at,
                expected_lifecycle_phase=(
                    "finalized" if finalized_binding else "session_provisional"
                ),
            ):
                if not self.delete(user_id, session_id):
                    raise SessionStoreError(
                        "Synthetic retention purge lost its canonical session."
                    )
                if self.get_session(user_id, session_id) is not None:
                    raise SessionStoreError(
                        "Synthetic retention purge session read-zero failed."
                    )
                if transcript_path.exists():
                    raise SessionStoreError(
                        "Synthetic retention purge transcript read-zero failed."
                    )
            return True

    def delete_all(self, user_id: str) -> list[SessionRecord]:
        user_dir = self._user_dir(user_id)
        if not user_dir.is_dir():
            return []

        deleted_records: list[SessionRecord] = []
        for path in user_dir.glob("*.json"):
            record = self._read(path)
            if record is not None:
                deleted_records.append(record)
            try:
                path.unlink()
            except FileNotFoundError:
                continue

        transcript_dir = self._transcript_dir(user_id)
        if transcript_dir.is_dir():
            for path in transcript_dir.glob("*.json"):
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue

        deleted_records.sort(key=lambda record: record.updated_at, reverse=True)
        return deleted_records

    def list_messages(self, user_id: str, session_id: str) -> list[SessionMessageRecord]:
        return self._read_messages(user_id, session_id)

    def read_exact_session_messages(
        self,
        user_id: str,
        session_id: str,
    ) -> list[SessionMessageRecord]:
        path = self._transcript_path(user_id, session_id)
        if not path.is_file():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise SessionStoreError(
                "Synthetic finalization transcript file is unreadable."
            ) from exc
        except json.JSONDecodeError as exc:
            raise SessionEvidenceIntegrityError(
                "Synthetic finalization transcript file is malformed."
            ) from exc
        if (
            not isinstance(data, dict)
            or set(data) != {"session_id", "updated_at", "messages"}
            or data.get("session_id") != session_id
            or not isinstance(data.get("updated_at"), str)
            or not isinstance(data.get("messages"), list)
        ):
            raise SessionEvidenceIntegrityError(
                "Synthetic finalization transcript file drifted."
            )
        expected_fields = set(SessionMessageRecord.model_fields)
        messages: list[SessionMessageRecord] = []
        for item in data["messages"]:
            if (
                not isinstance(item, dict)
                or set(item) != expected_fields
                or type(item.get("final")) is not bool
                or type(item.get("approximate")) is not bool
                or type(item.get("sequence")) is not int
                or not isinstance(item.get("metadata"), dict)
            ):
                raise SessionEvidenceIntegrityError(
                    "Synthetic finalization transcript raw row drifted."
                )
            try:
                messages.append(SessionMessageRecord.model_validate(item))
            except Exception as exc:  # noqa: BLE001 - fail closed on any row drift.
                raise SessionEvidenceIntegrityError(
                    "Synthetic finalization transcript raw row is invalid."
                ) from exc
        return _validate_exact_finalization_messages(
            messages,
            session_id=session_id,
        )

    def replace_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        with self._revision_lock:
            record = self.get(user_id, session_id)
            if record is None:
                raise SessionStoreError("Session not found while replacing messages.")
            return self.replace_messages_revisioned(
                user_id,
                session_id,
                messages,
                expected_revision=max(0, int(record.message_revision)),
            ).messages

    def replace_messages_revisioned(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
        *,
        expected_revision: int,
    ) -> SessionMessageSnapshotResult:
        with self._revision_lock:
            record = self.get(user_id, session_id)
            if record is None:
                raise SessionStoreError("Session not found while admitting message snapshot.")
            existing = self._read_messages(user_id, session_id)
            current_revision = max(0, int(record.message_revision))
            filtered = [message for message in messages if message.session_id == session_id]
            canonical_incoming = _merge_messages_without_deletion([], filtered)

            if expected_revision != current_revision:
                return SessionMessageSnapshotResult(
                    messages=existing,
                    previous_revision=current_revision,
                    current_revision=current_revision,
                    accepted=False,
                    duplicate=canonical_incoming == existing,
                    conflict=True,
                    deleted_count=0,
                    rejection_reason="revision_conflict",
                )

            if canonical_incoming == existing:
                return SessionMessageSnapshotResult(
                    messages=existing,
                    previous_revision=current_revision,
                    current_revision=current_revision,
                    accepted=True,
                    duplicate=True,
                )
            deleted_count = max(0, len(existing) - len(canonical_incoming))
            next_revision = current_revision + 1
            self._write_messages(user_id, session_id, canonical_incoming)
            self.update(
                user_id,
                session_id,
                message_revision=next_revision,
                transcript_available=bool(canonical_incoming),
            )
            return SessionMessageSnapshotResult(
                messages=canonical_incoming,
                previous_revision=current_revision,
                current_revision=next_revision,
                accepted=True,
                deleted_count=deleted_count,
            )

    def finalize_synthetic_session(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
        *,
        expected_revision: int,
        cleanup_obligation_id: str,
        provider_expires_at: str,
        retention_hours: int,
        expected_synthetic_binding: dict[str, object],
        expected_deployment: dict[str, str],
        message_metadata_base: dict[str, object],
        canonical_transcript_sha256: str,
        canonical_transcript_json: str,
        finalization_started_at: str,
        turn_count: int,
        capability_jti_sha256: str,
    ) -> SyntheticSessionFinalizationResult:
        """Local-dev equivalent of the production atomic finalization RPC."""

        from deerflow.sophia.cleanup_fence import local_cleanup_finalization_guard

        with self._revision_lock:
            record = self.get(user_id, session_id)
            if record is None:
                raise SessionStoreError("Synthetic finalization session was not found.")
            synthetic = (
                record.metadata.get("synthetic_voice_lab")
                if isinstance(record.metadata, dict)
                else None
            )
            if (
                not isinstance(synthetic, dict)
                or any(
                    synthetic.get(key) != value
                    for key, value in expected_synthetic_binding.items()
                )
                or record.metadata.get("expected_deployment")
                != expected_deployment
                or synthetic.get("cleanup_obligation_id")
                != cleanup_obligation_id
                or synthetic.get("provider_expires_at") != provider_expires_at
            ):
                raise SessionStoreError("Synthetic finalization binding conflicts.")
            existing_messages = canonical_visible_messages(
                self._read_messages(user_id, session_id)
            )
            existing_finalized_at = _parse_canonical_utc_millis(
                synthetic.get("finalized_at")
            )
            if record.status == "ended" and existing_finalized_at is not None:
                stored_receipt = synthetic.get("finalization_receipt")
                if (
                    not isinstance(stored_receipt, dict)
                    or stored_receipt.get("transcript_sha256")
                    != canonical_transcript_sha256
                    or not isinstance(stored_receipt.get("started_at"), str)
                    or not isinstance(stored_receipt.get("turn_count"), int)
                    or not isinstance(
                        stored_receipt.get("capability_jti_sha256"), str
                    )
                ):
                    raise SessionStoreError(
                        "Synthetic finalization receipt conflicts."
                    )
                expected_receipt = _build_postgres_finalization_receipt(
                    user_id=user_id,
                    session_id=session_id,
                    thread_id=record.thread_id,
                    expected_synthetic_binding=expected_synthetic_binding,
                    expected_deployment=expected_deployment,
                    finalized_at=_canonical_utc_millis(existing_finalized_at),
                    retention_hours=retention_hours,
                    retention_expires_at=str(synthetic["retention_expires_at"]),
                    provider_expires_at=provider_expires_at,
                    message_revision=int(record.message_revision),
                    message_count=len(existing_messages),
                    canonical_transcript_sha256=canonical_transcript_sha256,
                    finalization_started_at=str(stored_receipt["started_at"]),
                    turn_count=int(stored_receipt["turn_count"]),
                    capability_jti_sha256=str(
                        stored_receipt["capability_jti_sha256"]
                    ),
                )
                if stored_receipt != expected_receipt:
                    raise SessionStoreError(
                        "Synthetic finalization receipt conflicts."
                    )
                return SyntheticSessionFinalizationResult(
                    record=record,
                    messages=existing_messages,
                    finalized_at=_canonical_utc_millis(existing_finalized_at),
                    retention_expires_at=str(synthetic["retention_expires_at"]),
                    evidence_receipt={
                        "storage": "postgres_session",
                        "object_path": str(stored_receipt["object_path"]),
                        "sha256": str(stored_receipt["sha256"]),
                    },
                    duplicate=True,
                )
            provisional_deadline = _parse_canonical_utc_millis(
                synthetic.get("retention_expires_at")
            )
            database_now = datetime.now(UTC)
            if (
                synthetic.get("retention_anchor")
                != "session_created_at_provisional"
                or synthetic.get("finalized_at") is not None
                or provisional_deadline is None
                or database_now >= provisional_deadline
            ):
                raise SessionStoreError(
                    "Synthetic provisional finalization deadline expired."
                )
            if int(record.message_revision) != expected_revision:
                raise SessionStoreError("Synthetic finalization revision conflicts.")
            if (
                _SHA256.fullmatch(canonical_transcript_sha256) is None
                or hashlib.sha256(
                    canonical_transcript_json.encode("utf-8")
                ).hexdigest()
                != canonical_transcript_sha256
                or _parse_canonical_utc_millis(finalization_started_at) is None
                or isinstance(turn_count, bool)
                or not isinstance(turn_count, int)
                or turn_count < 0
                or _SHA256.fullmatch(capability_jti_sha256) is None
            ):
                raise SessionStoreError("Synthetic finalization receipt is invalid.")
            finalized_at = database_now.replace(microsecond=(database_now.microsecond // 1000) * 1000)
            retention_expires_at = finalized_at + timedelta(hours=retention_hours)
            finalized_text = _canonical_utc_millis(finalized_at)
            retention_text = _canonical_utc_millis(retention_expires_at)
            final_message_metadata = {
                **message_metadata_base,
                "retention_hours": retention_hours,
                "retention_anchor": "finalized_at",
                "finalized_at": finalized_text,
                "retention_expires_at": retention_text,
            }
            incoming = canonical_visible_messages(
                [
                    message.model_copy(
                        update={
                            "metadata": {
                                **final_message_metadata,
                                "redaction_level": message.redaction_level,
                            }
                        }
                    )
                    for message in messages
                    if message.session_id == session_id
                ]
            )
            next_synthetic = dict(synthetic)
            next_synthetic.update(
                {
                    "retention_anchor": "finalized_at",
                    "finalized_at": finalized_text,
                    "retention_expires_at": retention_text,
                }
            )
            next_metadata = dict(record.metadata)
            next_revision = int(record.message_revision) + 1
            finalization_receipt = _build_postgres_finalization_receipt(
                user_id=user_id,
                session_id=session_id,
                thread_id=record.thread_id,
                expected_synthetic_binding=expected_synthetic_binding,
                expected_deployment=expected_deployment,
                finalized_at=finalized_text,
                retention_hours=retention_hours,
                retention_expires_at=retention_text,
                provider_expires_at=provider_expires_at,
                message_revision=next_revision,
                message_count=len(incoming),
                canonical_transcript_sha256=canonical_transcript_sha256,
                finalization_started_at=finalization_started_at,
                turn_count=turn_count,
                capability_jti_sha256=capability_jti_sha256,
            )
            next_synthetic["finalization_receipt"] = finalization_receipt
            next_metadata["synthetic_voice_lab"] = next_synthetic
            updated = record.model_copy(
                update={
                    "status": "ended",
                    "ended_at": finalized_text,
                    "message_revision": next_revision,
                    "message_count": len(incoming),
                    "transcript_available": bool(incoming),
                    "last_message_preview": None,
                    "metadata": next_metadata,
                    "updated_at": finalized_text,
                }
            )
            # Filesystem mode is forbidden in production. Keep its ordering
            # cleanup-safe nonetheless: no authoritative product write occurs
            # after CLOSED. An in-process close failure restores both files.
            previous_messages = self._read_messages(user_id, session_id)
            with local_cleanup_finalization_guard(
                cleanup_obligation_id,
                provisional_deadline,
                provider_expires_at,
                retention_expires_at,
            ):
                try:
                    self._write_messages(user_id, session_id, incoming)
                    self._write(updated)
                except Exception:
                    self._write_messages(user_id, session_id, previous_messages)
                    self._write(record)
                    raise
            return SyntheticSessionFinalizationResult(
                record=updated,
                messages=incoming,
                finalized_at=finalized_text,
                retention_expires_at=retention_text,
                evidence_receipt={
                    "storage": "postgres_session",
                    "object_path": str(finalization_receipt["object_path"]),
                    "sha256": str(finalization_receipt["sha256"]),
                },
            )

    def append_message(
        self,
        user_id: str,
        session_id: str,
        message: SessionMessageRecord,
    ) -> list[SessionMessageRecord]:
        return self.append_or_upsert_messages(user_id, session_id, [message])

    def list_open(self, user_id: str) -> list[SessionRecord]:
        return [r for r in self._list_all(user_id) if r.status in {"open", "paused", "active", "resumable"}]

    def list_recent(self, user_id: str, limit: int = 30) -> list[SessionRecord]:
        return self._list_all(user_id)[:limit]

    def _list_all(self, user_id: str) -> list[SessionRecord]:
        user_dir = self._user_dir(user_id)
        if not user_dir.is_dir():
            return []
        records: list[SessionRecord] = []
        for path in user_dir.glob("*.json"):
            record = self._read(path)
            if record is not None:
                records.append(record)
        records.sort(key=lambda r: r.updated_at, reverse=True)
        return records


# ---------------------------------------------------------------------------
# Supabase Postgres implementation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SupabaseSessionStoreConfig:
    url: str
    service_role_key: str
    sessions_table: str = "sophia_sessions"
    messages_table: str = "sophia_session_messages"


def _load_supabase_session_config() -> SupabaseSessionStoreConfig:
    url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", url),
            ("SUPABASE_SERVICE_ROLE_KEY", service_role_key),
        )
        if not value
    ]
    if missing:
        raise SessionStoreConfigurationError("SOPHIA_SESSION_STORE=supabase requires backend env vars: " + ", ".join(missing))
    return SupabaseSessionStoreConfig(
        url=url,
        service_role_key=service_role_key,
        sessions_table=os.getenv("SOPHIA_SESSIONS_TABLE", "sophia_sessions").strip() or "sophia_sessions",
        messages_table=(os.getenv("SOPHIA_SESSION_MESSAGES_TABLE", "sophia_session_messages").strip() or "sophia_session_messages"),
    )


class SupabaseSessionTranscriptStore:
    """Supabase Postgres-backed store using the PostgREST API."""

    allow_legacy_dev_user_fallback = False

    def __init__(
        self,
        config: SupabaseSessionStoreConfig | None = None,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self._config = config or _load_supabase_session_config()
        self._client = client or httpx.Client(timeout=10.0)

    # -- HTTP helpers --------------------------------------------------------

    def _headers(self, *, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
        }
        if prefer:
            headers["Prefer"] = prefer
            headers["Content-Type"] = "application/json"
        return headers

    def _table_url(self, table: str) -> str:
        return f"{self._config.url}/rest/v1/{table}"

    def _text_in_filter(self, values: list[str]) -> str:
        escaped = [value.replace("\\", "\\\\").replace('"', '\\"') for value in values]
        quoted = [f'"{value}"' for value in escaped]
        return f"({','.join(quoted)})"

    def _request(
        self,
        method: str,
        table: str,
        *,
        params: dict[str, str] | None = None,
        json_body: object | None = None,
        prefer: str | None = None,
    ) -> object:
        try:
            response = self._client.request(
                method,
                self._table_url(table),
                headers=self._headers(prefer=prefer),
                params=params,
                json=json_body,
            )
        except httpx.HTTPError as exc:
            raise SessionStoreError(f"Supabase session store request failed: {exc}") from exc

        if response.status_code >= 400:
            raise SessionStoreError(f"Supabase session store request failed status={response.status_code} body={response.text[:200]!r}")

        if not response.text:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise SessionStoreError("Supabase session store returned invalid JSON") from exc

    # -- row mapping ---------------------------------------------------------

    def _session_row_from_record(self, record: SessionRecord) -> dict[str, object]:
        metadata = dict(record.metadata)
        metadata.update(
            {
                "preset_type": record.preset_type,
                "context_mode": record.context_mode,
                "platform": record.platform,
                "intention": record.intention,
                "focus_cue": record.focus_cue,
            }
        )
        return {
            "id": record.session_id,
            "user_id": record.user_id,
            "thread_id": record.thread_id,
            "run_id": record.run_id,
            "mode": _coerce_mode(record),
            "status": _to_db_status(record.status),
            "title": record.title,
            "preview": record.last_message_preview,
            "message_count": record.message_count,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "last_message_at": record.last_message_at,
            "ended_at": record.ended_at,
            "recap_status": record.recap_status,
            "checkpointer_available": record.checkpointer_available,
            "transcript_available": record.transcript_available,
            "memory_processed_until_sequence": record.memory_processed_until_sequence,
            "recap_processed_until_sequence": record.recap_processed_until_sequence,
            "last_memory_extraction_at": record.last_memory_extraction_at,
            "last_recap_extraction_at": record.last_recap_extraction_at,
            "last_memory_extraction_run_id": record.last_memory_extraction_run_id,
            "memory_extraction_status": record.memory_extraction_status,
            "memory_extraction_error_code": record.memory_extraction_error_code,
            "memory_extraction_range_start": record.memory_extraction_range_start,
            "memory_extraction_range_end": record.memory_extraction_range_end,
            "active_segment_started_at": record.active_segment_started_at,
            "segment_count": record.segment_count,
            "continuation_count": record.continuation_count,
            "message_revision": record.message_revision,
            "metadata": metadata,
        }

    def _record_from_session_row(self, row: object) -> SessionRecord | None:
        if not isinstance(row, dict):
            return None
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        session_id = row.get("id")
        thread_id = row.get("thread_id")
        user_id = row.get("user_id")
        if not all(isinstance(value, str) and value for value in (session_id, thread_id, user_id)):
            return None
        return SessionRecord(
            session_id=session_id,
            thread_id=thread_id,
            user_id=user_id,
            status=_from_db_status(row.get("status")),
            title=row.get("title") if isinstance(row.get("title"), str) else None,
            preset_type=str(metadata.get("preset_type") or "open"),
            context_mode=str(metadata.get("context_mode") or "life"),
            platform=str(metadata.get("platform") or row.get("mode") or "text"),
            mode=row.get("mode") if row.get("mode") in {"text", "voice", "mixed"} else None,
            run_id=row.get("run_id") if isinstance(row.get("run_id"), str) else None,
            message_count=int(row.get("message_count") or 0),
            last_message_preview=row.get("preview") if isinstance(row.get("preview"), str) else None,
            created_at=_normalize_database_timestamp(row.get("created_at"))
            or _canonical_utc_millis(datetime.now(UTC)),
            updated_at=_normalize_database_timestamp(row.get("updated_at"))
            or _canonical_utc_millis(datetime.now(UTC)),
            last_message_at=_normalize_database_timestamp(
                row.get("last_message_at")
            ),
            ended_at=_normalize_database_timestamp(row.get("ended_at")),
            recap_status=row.get("recap_status") if isinstance(row.get("recap_status"), str) else None,
            checkpointer_available=(bool(row.get("checkpointer_available")) if row.get("checkpointer_available") is not None else None),
            transcript_available=bool(row.get("transcript_available")),
            memory_processed_until_sequence=int(row.get("memory_processed_until_sequence") or 0),
            recap_processed_until_sequence=int(row.get("recap_processed_until_sequence") or 0),
            last_memory_extraction_at=(row.get("last_memory_extraction_at") if isinstance(row.get("last_memory_extraction_at"), str) else None),
            last_recap_extraction_at=(row.get("last_recap_extraction_at") if isinstance(row.get("last_recap_extraction_at"), str) else None),
            last_memory_extraction_run_id=(row.get("last_memory_extraction_run_id") if isinstance(row.get("last_memory_extraction_run_id"), str) else None),
            memory_extraction_status=(row.get("memory_extraction_status") if isinstance(row.get("memory_extraction_status"), str) else None),
            memory_extraction_error_code=(row.get("memory_extraction_error_code") if isinstance(row.get("memory_extraction_error_code"), str) else None),
            memory_extraction_range_start=(int(row.get("memory_extraction_range_start")) if row.get("memory_extraction_range_start") is not None else None),
            memory_extraction_range_end=(int(row.get("memory_extraction_range_end")) if row.get("memory_extraction_range_end") is not None else None),
            active_segment_started_at=(row.get("active_segment_started_at") if isinstance(row.get("active_segment_started_at"), str) else None),
            segment_count=int(row.get("segment_count") or 1),
            continuation_count=int(row.get("continuation_count") or 0),
            message_revision=int(row.get("message_revision") or 0),
            intention=metadata.get("intention") if isinstance(metadata.get("intention"), str) else None,
            focus_cue=metadata.get("focus_cue") if isinstance(metadata.get("focus_cue"), str) else None,
            metadata=dict(metadata),
        )

    def _message_row_from_record(self, user_id: str, message: SessionMessageRecord) -> dict[str, object]:
        metadata = dict(message.metadata)
        metadata["redaction_level"] = message.redaction_level
        return {
            "id": _storage_message_row_id(message),
            "message_id": message.message_id,
            "session_id": message.session_id,
            "user_id": user_id,
            "thread_id": message.thread_id,
            "role": message.role,
            "content": message.content,
            "source": message.source,
            "final": message.final,
            "approximate": message.approximate,
            "turn_id": message.turn_id,
            "provider_event_id": message.provider_event_id,
            "sequence": int(message.sequence),
            "created_at": message.created_at,
            "metadata": metadata,
        }

    def _message_from_row(self, row: object) -> SessionMessageRecord | None:
        if not isinstance(row, dict):
            return None
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        message_id = row.get("message_id") or row.get("id")
        session_id = row.get("session_id")
        thread_id = row.get("thread_id")
        role = row.get("role")
        content = row.get("content")
        if role == "sophia":
            role = "assistant"
        if not isinstance(message_id, str) or not isinstance(session_id, str) or not isinstance(thread_id, str) or role not in {"user", "assistant", "system", "tool", "artifact"} or not isinstance(content, str):
            return None
        return SessionMessageRecord(
            message_id=message_id,
            session_id=session_id,
            thread_id=thread_id,
            role=role,
            content=content,
            created_at=_normalize_database_timestamp(row.get("created_at"))
            or _canonical_utc_millis(datetime.now(UTC)),
            source=str(row.get("source") or "text"),
            final=bool(row.get("final", True)),
            approximate=bool(row.get("approximate", False)),
            turn_id=row.get("turn_id") if isinstance(row.get("turn_id"), str) else None,
            provider_event_id=(row.get("provider_event_id") if isinstance(row.get("provider_event_id"), str) else None),
            sequence=int(row.get("sequence") or 0),
            redaction_level=str(metadata.get("redaction_level") or "none"),
            metadata=dict(metadata),
        )

    # -- required abstraction API -------------------------------------------

    def upsert_session(self, metadata: SessionRecord) -> SessionRecord:
        rows = [self._session_row_from_record(metadata)]
        result = self._request(
            "POST",
            self._config.sessions_table,
            params={"on_conflict": "id"},
            json_body=rows,
            prefer="resolution=merge-duplicates,return=representation",
        )
        if isinstance(result, list) and result:
            record = self._record_from_session_row(result[0])
            if record is not None:
                return record
        return metadata

    def get_session(self, user_id: str, session_id: str) -> SessionRecord | None:
        result = self._request(
            "GET",
            self._config.sessions_table,
            params={
                "select": "*",
                "id": f"eq.{session_id}",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        rows = result if isinstance(result, list) else []
        if not rows:
            return None
        return self._record_from_session_row(rows[0])

    def find_session_by_thread_id(self, user_id: str, thread_id: str) -> SessionRecord | None:
        result = self._request(
            "GET",
            self._config.sessions_table,
            params={
                "select": "*",
                "thread_id": f"eq.{thread_id}",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        rows = result if isinstance(result, list) else []
        if not rows:
            return None
        return self._record_from_session_row(rows[0])

    def find_session_by_run_id(self, user_id: str, run_id: str) -> SessionRecord | None:
        result = self._request(
            "GET",
            self._config.sessions_table,
            params={
                "select": "*",
                "run_id": f"eq.{run_id}",
                "user_id": f"eq.{user_id}",
                "limit": "2",
            },
        )
        rows = result if isinstance(result, list) else []
        if len(rows) > 1:
            raise SessionStoreError("Multiple sessions matched one Voice Lab run id.")
        return self._record_from_session_row(rows[0]) if rows else None

    def find_session_by_cleanup_obligation_id(
        self,
        cleanup_obligation_id: str,
    ) -> SessionRecord | None:
        if not _CLEANUP_OBLIGATION_ID.fullmatch(cleanup_obligation_id):
            raise ValueError("cleanup obligation id must be a canonical UUIDv4")
        result = self._request(
            "GET",
            self._config.sessions_table,
            params={
                "select": "*",
                "metadata->synthetic_voice_lab->>synthetic": "eq.true",
                "metadata->synthetic_voice_lab->>cleanup_obligation_id": (
                    f"eq.{cleanup_obligation_id}"
                ),
                "limit": "2",
            },
        )
        rows = result if isinstance(result, list) else []
        if len(rows) > 1:
            raise SessionStoreError(
                "Multiple sessions matched one Voice Lab cleanup obligation id."
            )
        if not rows:
            return None
        record = self._record_from_session_row(rows[0])
        if record is None:
            raise SessionStoreError(
                "Voice Lab cleanup obligation matched an invalid session row."
            )
        return record

    def find_any_session_by_thread_id(self, thread_id: str) -> SessionRecord | None:
        result = self._request(
            "GET",
            self._config.sessions_table,
            params={
                "select": "*",
                "thread_id": f"eq.{thread_id}",
                "limit": "1",
            },
        )
        rows = result if isinstance(result, list) else []
        if not rows:
            return None
        return self._record_from_session_row(rows[0])

    def list_sessions(self, user_id: str) -> list[SessionRecord]:
        result = self._request(
            "GET",
            self._config.sessions_table,
            params={
                "select": "*",
                "user_id": f"eq.{user_id}",
                "order": "updated_at.desc",
            },
        )
        rows = result if isinstance(result, list) else []
        records = [record for record in (self._record_from_session_row(row) for row in rows) if record]
        records.sort(key=lambda record: record.updated_at, reverse=True)
        return records

    def expired_synthetic_sessions(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> list[SessionRecord]:
        """Return only expired exact synthetic rows from the durable store."""

        bounded_limit = _validate_synthetic_scan_limit(limit)
        current = now.astimezone(UTC)
        due: list[tuple[datetime, SessionRecord]] = []
        page_size = 100
        offset = 0
        max_scanned = 10_000
        while len(due) < bounded_limit and offset < max_scanned:
            result = self._request(
                "GET",
                self._config.sessions_table,
                params={
                    "select": "*",
                    "metadata->synthetic_voice_lab->>synthetic": "eq.true",
                    "metadata->synthetic_voice_lab->>retention_expires_at": (
                        f"lte.{_canonical_utc_millis(current)}"
                    ),
                    "order": "metadata->synthetic_voice_lab->>retention_expires_at.asc,id.asc",
                    "limit": str(page_size),
                    "offset": str(offset),
                },
            )
            rows = result if isinstance(result, list) else []
            for row in rows:
                record = self._record_from_session_row(row)
                if record is None:
                    continue
                deadline = _synthetic_retention_deadline(record)
                if deadline is not None and deadline <= current:
                    due.append((deadline, record))
                    if len(due) >= bounded_limit:
                        break
            offset += len(rows)
            if len(rows) < page_size:
                break
        if len(due) < bounded_limit and offset >= max_scanned and len(rows) == page_size:
            raise SessionStoreError(
                "Synthetic session reaper scan exceeded its bounded poison-page budget."
            )
        due.sort(key=lambda item: (item[0], item[1].session_id))
        return [record for _deadline, record in due[:bounded_limit]]

    def append_or_upsert_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        incoming = [message for message in messages if message.session_id == session_id]
        for _attempt in range(_AUTHORITATIVE_WRITE_RETRIES):
            record = self.get_session(user_id, session_id)
            if record is None:
                raise SessionStoreError("Session not found while appending messages.")
            merged = _merge_messages_without_deletion(
                self.list_messages(user_id, session_id),
                incoming,
            )
            result = self.replace_messages_revisioned(
                user_id,
                session_id,
                merged,
                expected_revision=max(0, int(record.message_revision)),
            )
            if not result.conflict:
                return result.messages
        raise SessionStoreError("Concurrent transcript updates prevented an authoritative append.")

    def replace_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        records = [message for message in messages if message.session_id == session_id]
        for _attempt in range(_AUTHORITATIVE_WRITE_RETRIES):
            record = self.get_session(user_id, session_id)
            if record is None:
                raise SessionStoreError("Session not found while replacing messages.")
            result = self.replace_messages_revisioned(
                user_id,
                session_id,
                records,
                expected_revision=max(0, int(record.message_revision)),
            )
            if not result.conflict:
                return result.messages
        raise SessionStoreError("Concurrent transcript updates prevented an authoritative replace.")

    def replace_messages_revisioned(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
        *,
        expected_revision: int,
    ) -> SessionMessageSnapshotResult:
        records = [message for message in messages if message.session_id == session_id]
        result = self._request(
            "POST",
            "rpc/sophia_replace_session_messages",
            json_body={
                "p_user_id": user_id,
                "p_session_id": session_id,
                "p_expected_revision": expected_revision,
                "p_messages": [self._message_row_from_record(user_id, message) for message in records],
            },
            prefer="return=representation",
        )
        receipt = result[0] if isinstance(result, list) and result and isinstance(result[0], dict) else result
        if not isinstance(receipt, dict):
            raise SessionStoreError("Supabase revisioned message RPC returned an invalid receipt.")
        current_revision = int(receipt.get("current_revision") or expected_revision)
        previous_revision = int(receipt.get("previous_revision") or expected_revision)
        return SessionMessageSnapshotResult(
            messages=self.list_messages(user_id, session_id),
            previous_revision=previous_revision,
            current_revision=current_revision,
            accepted=bool(receipt.get("accepted")),
            duplicate=bool(receipt.get("duplicate")),
            conflict=bool(receipt.get("conflict")),
            deleted_count=int(receipt.get("deleted_count") or 0),
            rejection_reason=(str(receipt["rejection_reason"]) if receipt.get("rejection_reason") else None),
        )

    def finalize_synthetic_session(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
        *,
        expected_revision: int,
        cleanup_obligation_id: str,
        provider_expires_at: str,
        retention_hours: int,
        expected_synthetic_binding: dict[str, object],
        expected_deployment: dict[str, str],
        message_metadata_base: dict[str, object],
        canonical_transcript_sha256: str,
        canonical_transcript_json: str,
        finalization_started_at: str,
        turn_count: int,
        capability_jti_sha256: str,
    ) -> SyntheticSessionFinalizationResult:
        """Finalize transcript, lifecycle, and cleanup fence in one DB RPC."""

        records = [
            message for message in messages if message.session_id == session_id
        ]
        result = self._request(
            "POST",
            "rpc/sophia_finalize_voice_lab_session",
            json_body={
                "p_user_id": user_id,
                "p_session_id": session_id,
                "p_expected_revision": expected_revision,
                "p_cleanup_obligation_id": cleanup_obligation_id,
                "p_provider_expires_at": provider_expires_at,
                "p_retention_hours": retention_hours,
                "p_expected_synthetic_binding": expected_synthetic_binding,
                "p_expected_deployment": expected_deployment,
                "p_message_metadata_base": message_metadata_base,
                "p_canonical_transcript_sha256": canonical_transcript_sha256,
                "p_canonical_transcript_json": canonical_transcript_json,
                "p_finalization_started_at": finalization_started_at,
                "p_turn_count": turn_count,
                "p_capability_jti_sha256": capability_jti_sha256,
                "p_messages": [
                    self._message_row_from_record(user_id, message)
                    for message in records
                ],
            },
            prefer="return=representation",
        )
        receipt = (
            result[0]
            if isinstance(result, list)
            and result
            and isinstance(result[0], dict)
            else result
        )
        if not isinstance(receipt, dict):
            raise SessionStoreError(
                "Supabase synthetic finalization RPC returned an invalid receipt."
            )
        finalized_at = receipt.get("finalized_at")
        retention_expires_at = receipt.get("retention_expires_at")
        if (
            _parse_canonical_utc_millis(finalized_at) is None
            or _parse_canonical_utc_millis(retention_expires_at) is None
        ):
            raise SessionStoreError(
                "Supabase synthetic finalization RPC returned invalid retention."
            )
        record = self.get_session(user_id, session_id)
        if record is None:
            raise SessionStoreError(
                "Synthetic finalization session disappeared after commit."
            )
        synthetic = record.metadata.get("synthetic_voice_lab")
        stored_receipt = (
            synthetic.get("finalization_receipt")
            if isinstance(synthetic, dict)
            else None
        )
        raw_message_result = self._request(
            "GET",
            self._config.messages_table,
            params={
                "select": "*",
                "session_id": f"eq.{session_id}",
                "order": "sequence.asc,created_at.asc",
            },
        )
        raw_message_rows = (
            raw_message_result if isinstance(raw_message_result, list) else []
        )
        final_message_metadata = {
            **message_metadata_base,
            "retention_hours": retention_hours,
            "retention_anchor": "finalized_at",
            "finalized_at": str(finalized_at),
            "retention_expires_at": str(retention_expires_at),
        }
        expected_messages = sorted(
            [
                message.model_copy(
                    update={
                        "metadata": {
                            **final_message_metadata,
                            "redaction_level": message.redaction_level,
                        }
                    }
                )
                for message in records
            ],
            key=_message_sort_key,
        )
        expected_rows = {
            _storage_message_row_id(message): message
            for message in expected_messages
        }
        readback_messages: list[SessionMessageRecord] = []
        raw_rows_valid = len(raw_message_rows) == len(expected_rows)
        for raw_row in raw_message_rows:
            if not isinstance(raw_row, dict):
                raw_rows_valid = False
                continue
            expected_message = expected_rows.get(str(raw_row.get("id") or ""))
            mapped_message = self._message_from_row(raw_row)
            if expected_message is None or mapped_message is None:
                raw_rows_valid = False
                continue
            expected_metadata = dict(expected_message.metadata)
            if (
                raw_row.get("message_id") != expected_message.message_id
                or raw_row.get("session_id") != session_id
                or raw_row.get("user_id") != user_id
                or raw_row.get("thread_id") != expected_message.thread_id
                or raw_row.get("role") != expected_message.role
                or raw_row.get("content") != expected_message.content
                or raw_row.get("source") != expected_message.source
                or raw_row.get("final") is not True
                or raw_row.get("approximate")
                is not expected_message.approximate
                or raw_row.get("turn_id") != expected_message.turn_id
                or raw_row.get("provider_event_id")
                != expected_message.provider_event_id
                or raw_row.get("sequence") != expected_message.sequence
                or _normalize_database_timestamp(raw_row.get("created_at"))
                != expected_message.created_at
                or raw_row.get("metadata") != expected_metadata
            ):
                raw_rows_valid = False
            readback_messages.append(mapped_message)
        readback_messages.sort(key=_message_sort_key)
        duplicate = bool(receipt.get("duplicate"))
        if duplicate:
            if (
                not isinstance(stored_receipt, dict)
                or _parse_canonical_utc_millis(stored_receipt.get("started_at"))
                is None
                or isinstance(stored_receipt.get("turn_count"), bool)
                or not isinstance(stored_receipt.get("turn_count"), int)
                or int(stored_receipt["turn_count"]) < 0
                or _SHA256.fullmatch(
                    str(stored_receipt.get("capability_jti_sha256") or "")
                )
                is None
            ):
                raise SessionStoreError(
                    "Supabase synthetic finalization replay receipt is invalid."
                )
            expected_started_at = str(stored_receipt["started_at"])
            expected_turn_count = int(stored_receipt["turn_count"])
            expected_jti_sha256 = str(
                stored_receipt["capability_jti_sha256"]
            )
        else:
            expected_started_at = finalization_started_at
            expected_turn_count = turn_count
            expected_jti_sha256 = capability_jti_sha256
        expected_receipt = _build_postgres_finalization_receipt(
            user_id=user_id,
            session_id=session_id,
            thread_id=record.thread_id,
            expected_synthetic_binding=expected_synthetic_binding,
            expected_deployment=expected_deployment,
            finalized_at=str(finalized_at),
            retention_hours=retention_hours,
            retention_expires_at=str(retention_expires_at),
            provider_expires_at=provider_expires_at,
            message_revision=int(record.message_revision),
            message_count=len(readback_messages),
            canonical_transcript_sha256=canonical_transcript_sha256,
            finalization_started_at=expected_started_at,
            turn_count=expected_turn_count,
            capability_jti_sha256=expected_jti_sha256,
        )
        if (
            not isinstance(synthetic, dict)
            or receipt.get("cleanup_state") != "closed"
            or not raw_rows_valid
            or record.status != "ended"
            or record.ended_at != finalized_at
            or synthetic.get("retention_anchor") != "finalized_at"
            or synthetic.get("finalized_at") != finalized_at
            or synthetic.get("retention_expires_at")
            != retention_expires_at
            or int(record.message_count) != len(expected_messages)
            or any(
                synthetic.get(key) != value
                for key, value in expected_synthetic_binding.items()
            )
            or record.metadata.get("expected_deployment") != expected_deployment
            or stored_receipt != expected_receipt
            or receipt.get("object_path") != expected_receipt["object_path"]
            or receipt.get("sha256") != expected_receipt["sha256"]
        ):
            raise SessionStoreError(
                "Supabase synthetic finalization receipt read-back conflicts."
            )
        return SyntheticSessionFinalizationResult(
            record=record,
            messages=readback_messages,
            finalized_at=str(finalized_at),
            retention_expires_at=str(retention_expires_at),
            evidence_receipt={
                "storage": "postgres_session",
                "object_path": str(stored_receipt["object_path"]),
                "sha256": str(stored_receipt["sha256"]),
            },
            duplicate=duplicate,
        )

    def list_messages(self, user_id: str, session_id: str) -> list[SessionMessageRecord]:
        result = self._request(
            "GET",
            self._config.messages_table,
            params={
                "select": "*",
                "session_id": f"eq.{session_id}",
                "user_id": f"eq.{user_id}",
                "order": "sequence.asc,created_at.asc",
            },
        )
        rows = result if isinstance(result, list) else []
        messages = [message for message in (self._message_from_row(row) for row in rows) if message]
        messages.sort(key=_message_sort_key)
        return messages

    def read_exact_session_messages(
        self,
        user_id: str,
        session_id: str,
    ) -> list[SessionMessageRecord]:
        result = self._request(
            "GET",
            self._config.messages_table,
            params={
                "select": "*",
                "session_id": f"eq.{session_id}",
                "order": "sequence.asc,created_at.asc",
            },
        )
        if not isinstance(result, list):
            raise SessionEvidenceIntegrityError(
                "Synthetic finalization transcript query returned an invalid result."
            )
        expected_fields = {
            "id",
            "message_id",
            "session_id",
            "user_id",
            "thread_id",
            "role",
            "content",
            "source",
            "final",
            "approximate",
            "turn_id",
            "provider_event_id",
            "sequence",
            "created_at",
            "metadata",
        }
        messages: list[SessionMessageRecord] = []
        storage_ids: set[str] = set()
        for row in result:
            if (
                not isinstance(row, dict)
                or set(row) != expected_fields
                or not isinstance(row.get("id"), str)
                or not isinstance(row.get("message_id"), str)
                or row.get("session_id") != session_id
                or row.get("user_id") != user_id
                or not isinstance(row.get("thread_id"), str)
                or row.get("role") not in {"user", "assistant"}
                or not isinstance(row.get("content"), str)
                or not isinstance(row.get("source"), str)
                or row.get("final") is not True
                or type(row.get("approximate")) is not bool
                or type(row.get("sequence")) is not int
                or not isinstance(row.get("metadata"), dict)
                or _normalize_database_timestamp(row.get("created_at")) is None
            ):
                raise SessionEvidenceIntegrityError(
                    "Synthetic finalization transcript raw row drifted."
                )
            mapped = self._message_from_row(row)
            storage_id = str(row["id"])
            if (
                mapped is None
                or storage_id != _storage_message_row_id(mapped)
                or storage_id in storage_ids
            ):
                raise SessionEvidenceIntegrityError(
                    "Synthetic finalization transcript row identity drifted."
                )
            storage_ids.add(storage_id)
            messages.append(mapped)
        return _validate_exact_finalization_messages(
            messages,
            session_id=session_id,
        )

    def mark_session_ended(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="ended", ended_at=_now_iso())

    def mark_session_abandoned(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="abandoned")

    # -- compatibility API ---------------------------------------------------

    def create(self, record: SessionRecord) -> SessionRecord:
        return self.upsert_session(record)

    def get(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.get_session(user_id, session_id)

    def update(self, user_id: str, session_id: str, **updates: object) -> SessionRecord | None:
        record = self.get_session(user_id, session_id)
        if record is None:
            return None
        changes = {key: value for key, value in updates.items() if key in SessionRecord.model_fields}
        if not changes:
            return record
        changes["updated_at"] = _now_iso()
        return self.upsert_session(record.model_copy(update=changes))

    def end(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.mark_session_ended(user_id, session_id)

    def pause(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="paused", ended_at=None)

    def resume(self, user_id: str, session_id: str) -> SessionRecord | None:
        return self.update(user_id, session_id, status="open", ended_at=None)

    def delete(self, user_id: str, session_id: str) -> bool:
        record = self.get_session(user_id, session_id)
        if record is None:
            return False
        self._request(
            "DELETE",
            self._config.sessions_table,
            params={"id": f"eq.{session_id}", "user_id": f"eq.{user_id}"},
            prefer="return=minimal",
        )
        return True

    def purge_synthetic_session(
        self,
        user_id: str,
        session_id: str,
        *,
        cleanup_obligation_id: str,
        retention_expires_at: str,
        provider_expires_at: str,
    ) -> bool:
        """Atomically delete a governed parent and its exact child row set."""

        result = self._request(
            "POST",
            "rpc/sophia_purge_voice_lab_session",
            json_body={
                "p_user_id": user_id,
                "p_session_id": session_id,
                "p_cleanup_obligation_id": cleanup_obligation_id,
                "p_retention_expires_at": retention_expires_at,
                "p_provider_expires_at": provider_expires_at,
            },
            prefer="return=representation",
        )
        acknowledged = result is True or result == [True]
        if not acknowledged:
            raise SessionStoreError(
                "Supabase synthetic retention purge RPC returned an invalid result."
            )
        remaining_sessions = self._request(
            "GET",
            self._config.sessions_table,
            params={"select": "id", "id": f"eq.{session_id}"},
        )
        remaining_messages = self._request(
            "GET",
            self._config.messages_table,
            params={"select": "id", "session_id": f"eq.{session_id}"},
        )
        if remaining_sessions != [] or remaining_messages != []:
            raise SessionStoreError(
                "Supabase synthetic retention purge read-zero failed."
            )
        return True

    def delete_all(self, user_id: str) -> list[SessionRecord]:
        records = self.list_sessions(user_id)
        if not records:
            return []
        self._request(
            "DELETE",
            self._config.sessions_table,
            params={"user_id": f"eq.{user_id}"},
            prefer="return=minimal",
        )
        return records

    def append_message(
        self,
        user_id: str,
        session_id: str,
        message: SessionMessageRecord,
    ) -> list[SessionMessageRecord]:
        return self.append_or_upsert_messages(user_id, session_id, [message])

    def list_open(self, user_id: str) -> list[SessionRecord]:
        return [record for record in self.list_sessions(user_id) if record.status in {"open", "paused", "active", "resumable"}]

    def list_recent(self, user_id: str, limit: int = 30) -> list[SessionRecord]:
        return self.list_sessions(user_id)[:limit]


# ---------------------------------------------------------------------------
# Store factory
# ---------------------------------------------------------------------------


def SessionStore(
    base_path: Path | str | None = None,
    *,
    backend: Literal["filesystem", "supabase"] | None = None,
    client: httpx.Client | None = None,
) -> SessionTranscriptStore:
    """Return the configured session transcript store.

    Passing ``base_path`` forces the filesystem implementation for tests and
    local callers. Without ``base_path``, ``SOPHIA_SESSION_STORE`` chooses the
    backend. Render/production defaults to Supabase and fails clearly when
    required backend-only env vars are missing.
    """

    if base_path is not None:
        return FilesystemSessionTranscriptStore(base_path)

    selected = (backend or os.getenv("SOPHIA_SESSION_STORE") or "").strip().lower()
    if not selected:
        selected = "supabase" if _is_production_runtime() else "filesystem"

    if selected == "filesystem":
        if _is_production_runtime() and not _truthy_env(os.getenv("SOPHIA_ALLOW_FILESYSTEM_SESSION_STORE_IN_PRODUCTION")):
            raise SessionStoreConfigurationError("Production runtime requires SOPHIA_SESSION_STORE=supabase; filesystem session transcripts are not durable on Render.")
        return FilesystemSessionTranscriptStore()

    if selected == "supabase":
        return SupabaseSessionTranscriptStore(client=client)

    raise SessionStoreConfigurationError("SOPHIA_SESSION_STORE must be one of: filesystem, supabase")
