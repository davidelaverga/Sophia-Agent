"""Session metadata and transcript persistence for Sophia.

Local development uses JSON files under ``users/{user_id}``. Production can
select the Supabase Postgres-backed implementation with
``SOPHIA_SESSION_STORE=supabase`` so Render's ephemeral filesystem is never the
hot-path source of truth for conversation history.
"""

from __future__ import annotations

import json
import logging
import os
import hashlib
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
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


class SessionTranscriptStore(Protocol):
    """Storage contract for session metadata and ordered transcript messages."""

    allow_legacy_dev_user_fallback: bool

    def upsert_session(self, metadata: SessionRecord) -> SessionRecord: ...

    def get_session(self, user_id: str, session_id: str) -> SessionRecord | None: ...

    def list_sessions(self, user_id: str) -> list[SessionRecord]: ...

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

    def list_messages(self, user_id: str, session_id: str) -> list[SessionMessageRecord]: ...

    def mark_session_ended(self, user_id: str, session_id: str) -> SessionRecord | None: ...

    def mark_session_abandoned(self, user_id: str, session_id: str) -> SessionRecord | None: ...


class SessionStoreConfigurationError(RuntimeError):
    """Raised when the requested session store cannot be safely configured."""


class SessionStoreError(RuntimeError):
    """Raised when the configured session store rejects a backend operation."""


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_DEFAULT_BASE_PATH = Path("users")
_MESSAGE_ID_NAMESPACE = uuid.UUID("6e6291e3-f564-42a1-94bb-50d1145cb184")

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
    stable_basis = (
        message.provider_event_id
        or message.turn_id
        or message.message_id
        or f"{message.sequence}:{message.role}"
    )
    return str(uuid.uuid5(_MESSAGE_ID_NAMESPACE, f"{message.session_id}:{message.role}:{stable_basis}"))


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
    left_score = (
        1 if left.final else 0,
        0 if left.approximate else 1,
        len(_normalize_message_content(left.content)),
        left.created_at or "",
    )
    right_score = (
        1 if right.final else 0,
        0 if right.approximate else 1,
        len(_normalize_message_content(right.content)),
        right.created_at or "",
    )
    return right if right_score >= left_score else left


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

    def list_sessions(self, user_id: str) -> list[SessionRecord]:
        return self._list_all(user_id)

    def append_or_upsert_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        existing = self._read_messages(user_id, session_id)
        by_key = {_message_dedupe_key(message): message for message in existing}
        for message in messages:
            if message.session_id == session_id:
                by_key[_message_dedupe_key(message)] = message
        merged = sorted(by_key.values(), key=_message_sort_key)
        self._write_messages(user_id, session_id, merged)
        return merged

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

    def replace_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        filtered = [message for message in messages if message.session_id == session_id]
        self._write_messages(user_id, session_id, filtered)
        return sorted(filtered, key=_message_sort_key)

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
        raise SessionStoreConfigurationError(
            "SOPHIA_SESSION_STORE=supabase requires backend env vars: "
            + ", ".join(missing)
        )
    return SupabaseSessionStoreConfig(
        url=url,
        service_role_key=service_role_key,
        sessions_table=os.getenv("SOPHIA_SESSIONS_TABLE", "sophia_sessions").strip() or "sophia_sessions",
        messages_table=(
            os.getenv("SOPHIA_SESSION_MESSAGES_TABLE", "sophia_session_messages").strip()
            or "sophia_session_messages"
        ),
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
            raise SessionStoreError(
                "Supabase session store request failed "
                f"status={response.status_code} body={response.text[:200]!r}"
            )

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
            created_at=str(row.get("created_at") or _now_iso()),
            updated_at=str(row.get("updated_at") or _now_iso()),
            last_message_at=row.get("last_message_at") if isinstance(row.get("last_message_at"), str) else None,
            ended_at=row.get("ended_at") if isinstance(row.get("ended_at"), str) else None,
            recap_status=row.get("recap_status") if isinstance(row.get("recap_status"), str) else None,
            checkpointer_available=(
                bool(row.get("checkpointer_available"))
                if row.get("checkpointer_available") is not None
                else None
            ),
            transcript_available=bool(row.get("transcript_available")),
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
        if (
            not isinstance(message_id, str)
            or not isinstance(session_id, str)
            or not isinstance(thread_id, str)
            or role not in {"user", "assistant", "system", "tool", "artifact"}
            or not isinstance(content, str)
        ):
            return None
        return SessionMessageRecord(
            message_id=message_id,
            session_id=session_id,
            thread_id=thread_id,
            role=role,
            content=content,
            created_at=str(row.get("created_at") or _now_iso()),
            source=str(row.get("source") or "text"),
            final=bool(row.get("final", True)),
            approximate=bool(row.get("approximate", False)),
            turn_id=row.get("turn_id") if isinstance(row.get("turn_id"), str) else None,
            provider_event_id=(
                row.get("provider_event_id")
                if isinstance(row.get("provider_event_id"), str)
                else None
            ),
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

    def append_or_upsert_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        records = [message for message in messages if message.session_id == session_id]
        if not records:
            return self.list_messages(user_id, session_id)
        rows = [self._message_row_from_record(user_id, message) for message in records]
        self._request(
            "POST",
            self._config.messages_table,
            params={"on_conflict": "id"},
            json_body=rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        last_message_at = max((message.created_at for message in records if message.created_at), default=None)
        patch: dict[str, object] = {
            "transcript_available": True,
            "updated_at": _now_iso(),
        }
        if last_message_at:
            patch["last_message_at"] = last_message_at
        self._request(
            "PATCH",
            self._config.sessions_table,
            params={"id": f"eq.{session_id}", "user_id": f"eq.{user_id}"},
            json_body=patch,
            prefer="return=minimal",
        )
        return self.list_messages(user_id, session_id)

    def replace_messages(
        self,
        user_id: str,
        session_id: str,
        messages: list[SessionMessageRecord],
    ) -> list[SessionMessageRecord]:
        records = [message for message in messages if message.session_id == session_id]
        if not records:
            return self.list_messages(user_id, session_id)

        rows = [self._message_row_from_record(user_id, message) for message in records]
        canonical_row_ids = [str(row["id"]) for row in rows]
        self._request(
            "POST",
            self._config.messages_table,
            params={"on_conflict": "id"},
            json_body=rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        self._request(
            "DELETE",
            self._config.messages_table,
            params={
                "session_id": f"eq.{session_id}",
                "user_id": f"eq.{user_id}",
                "id": f"not.in.{self._text_in_filter(canonical_row_ids)}",
            },
            prefer="return=minimal",
        )

        last_message_at = max((message.created_at for message in records if message.created_at), default=None)
        patch: dict[str, object] = {
            "transcript_available": True,
            "updated_at": _now_iso(),
        }
        if last_message_at:
            patch["last_message_at"] = last_message_at
        self._request(
            "PATCH",
            self._config.sessions_table,
            params={"id": f"eq.{session_id}", "user_id": f"eq.{user_id}"},
            json_body=patch,
            prefer="return=minimal",
        )
        return self.list_messages(user_id, session_id)

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
        return [
            record
            for record in self.list_sessions(user_id)
            if record.status in {"open", "paused", "active", "resumable"}
        ]

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
            raise SessionStoreConfigurationError(
                "Production runtime requires SOPHIA_SESSION_STORE=supabase; "
                "filesystem session transcripts are not durable on Render."
            )
        return FilesystemSessionTranscriptStore()

    if selected == "supabase":
        return SupabaseSessionTranscriptStore(client=client)

    raise SessionStoreConfigurationError(
        "SOPHIA_SESSION_STORE must be one of: filesystem, supabase"
    )
