"""File-based session persistence for Sophia multi-session.

Stores one JSON file per session under ``users/{user_id}/sessions/{session_id}.json``.
By default it writes to the repo-root ``users/`` directory and can read legacy
records from ``backend/users/`` so recap/memory/session flows stay aligned while
older local data is migrated forward.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

SessionStatus = Literal["open", "paused", "ended"]


class SessionRecord(BaseModel):
    """Persistent session metadata."""

    session_id: str
    thread_id: str
    user_id: str
    status: SessionStatus = "open"
    title: str | None = None
    preset_type: str = "open"
    context_mode: str = "life"
    platform: str = "text"
    message_count: int = 0
    last_message_preview: str | None = None
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    ended_at: str | None = None
    intention: str | None = None
    focus_cue: str | None = None


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

_PROJECT_ROOT = Path(__file__).resolve().parents[5]
_DEFAULT_BASE_PATH = _PROJECT_ROOT / "users"
_LEGACY_BASE_PATH = _PROJECT_ROOT / "backend" / "users"


class SessionStore:
    """CRUD for session records stored as JSON files.

    File layout::

        {base_path}/{user_id}/sessions/{session_id}.json
    """

    def __init__(self, base_path: Path | None = None, legacy_base_path: Path | None = None) -> None:
        self._base = base_path or _DEFAULT_BASE_PATH
        self._legacy_base = (
            legacy_base_path
            if legacy_base_path is not None
            else (_LEGACY_BASE_PATH if base_path is None and _LEGACY_BASE_PATH != self._base else None)
        )

    # -- helpers -------------------------------------------------------------

    def _user_dir(self, user_id: str) -> Path:
        return self._base / user_id / "sessions"

    def _session_path(self, user_id: str, session_id: str) -> Path:
        return self._user_dir(user_id) / f"{session_id}.json"

    def _iter_base_paths(self) -> tuple[Path, ...]:
        if self._legacy_base is None or self._legacy_base == self._base:
            return (self._base,)
        return (self._base, self._legacy_base)

    def _iter_user_dirs(self, user_id: str) -> tuple[Path, ...]:
        return tuple(base / user_id / "sessions" for base in self._iter_base_paths())

    def _iter_session_paths(self, user_id: str, session_id: str) -> tuple[Path, ...]:
        return tuple(user_dir / f"{session_id}.json" for user_dir in self._iter_user_dirs(user_id))

    def _prefer_record(self, current: SessionRecord | None, candidate: SessionRecord) -> SessionRecord:
        if current is None:
            return candidate
        return candidate if candidate.updated_at >= current.updated_at else current

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

    # -- public API ----------------------------------------------------------

    def create(self, record: SessionRecord) -> SessionRecord:
        """Persist a new session. Overwrites if session_id already exists."""
        self._write(record)
        return record

    def get(self, user_id: str, session_id: str) -> SessionRecord | None:
        """Load a single session by ID."""
        for path in self._iter_session_paths(user_id, session_id):
            record = self._read(path)
            if record is not None:
                return record
        return None

    def find_by_session_id(self, session_id: str) -> SessionRecord | None:
        """Load a session by ID across all persisted user directories."""
        if not session_id:
            return None

        for base in self._iter_base_paths():
            if not base.is_dir():
                continue

            for user_root in base.iterdir():
                if not user_root.is_dir():
                    continue

                record = self._read(user_root / "sessions" / f"{session_id}.json")
                if record is not None:
                    return record

        return None

    def find_by_thread_id(self, thread_id: str) -> SessionRecord | None:
        """Load a session by thread ID across all persisted user directories.

        Used for ownership resolution when only the thread is known (e.g. the
        builder artifact download route). Scans all session files — for
        low-to-medium user counts this is fine; revisit when we move off disk.
        """
        if not thread_id:
            return None

        for base in self._iter_base_paths():
            if not base.is_dir():
                continue

            for user_root in base.iterdir():
                if not user_root.is_dir():
                    continue
                sessions_dir = user_root / "sessions"
                if not sessions_dir.is_dir():
                    continue
                for session_path in sessions_dir.glob("*.json"):
                    record = self._read(session_path)
                    if record is not None and record.thread_id == thread_id:
                        return record

        return None

    def update(self, user_id: str, session_id: str, **updates: object) -> SessionRecord | None:
        """Patch fields on an existing session. Returns updated record or None."""
        record = self.get(user_id, session_id)
        if record is None:
            return None
        changes = {k: v for k, v in updates.items() if k in SessionRecord.model_fields}
        if not changes:
            return record
        changes["updated_at"] = datetime.now(UTC).isoformat()
        updated = record.model_copy(update=changes)
        self._write(updated)
        return updated

    def end(self, user_id: str, session_id: str) -> SessionRecord | None:
        """Mark a session as ended."""
        now = datetime.now(UTC).isoformat()
        return self.update(user_id, session_id, status="ended", ended_at=now)

    def pause(self, user_id: str, session_id: str) -> SessionRecord | None:
        """Mark a session as paused but still resumable."""
        return self.update(user_id, session_id, status="paused", ended_at=None)

    def resume(self, user_id: str, session_id: str) -> SessionRecord | None:
        """Mark a paused session as active again."""
        return self.update(user_id, session_id, status="open", ended_at=None)

    def delete(self, user_id: str, session_id: str) -> bool:
        """Delete a session record from disk."""
        deleted = False
        for path in self._iter_session_paths(user_id, session_id):
            if not path.is_file():
                continue
            path.unlink()
            deleted = True
        return deleted

    def delete_all(self, user_id: str) -> list[SessionRecord]:
        """Delete all session records for a user and return the deleted records."""
        deleted_by_id: dict[str, SessionRecord] = {}

        for user_dir in self._iter_user_dirs(user_id):
            if not user_dir.is_dir():
                continue

            for path in user_dir.glob("*.json"):
                record = self._read(path)
                if record is not None:
                    deleted_by_id[record.session_id] = self._prefer_record(
                        deleted_by_id.get(record.session_id),
                        record,
                    )
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue

        deleted_records = list(deleted_by_id.values())
        deleted_records.sort(key=lambda record: record.updated_at, reverse=True)
        return deleted_records

    def list_open(self, user_id: str) -> list[SessionRecord]:
        """Return all resumable sessions for a user, newest first."""
        return [
            r for r in self._list_all(user_id) if r.status in {"open", "paused"}
        ]

    def list_recent(self, user_id: str, limit: int = 30) -> list[SessionRecord]:
        """Return the most recent sessions (any status), newest first."""
        all_sessions = self._list_all(user_id)
        return all_sessions[:limit]

    def _list_all(self, user_id: str) -> list[SessionRecord]:
        """Load all sessions for a user, sorted by updated_at descending."""
        records_by_id: dict[str, SessionRecord] = {}

        for user_dir in self._iter_user_dirs(user_id):
            if not user_dir.is_dir():
                continue

            for path in user_dir.glob("*.json"):
                record = self._read(path)
                if record is None:
                    continue
                records_by_id[record.session_id] = self._prefer_record(
                    records_by_id.get(record.session_id),
                    record,
                )

        records = list(records_by_id.values())
        records.sort(key=lambda r: r.updated_at, reverse=True)
        return records
