"""File-based session persistence for Sophia multi-session.

Stores one JSON file per session under ``users/{user_id}/sessions/{session_id}.json``.
Designed for low-to-medium volume (tens to hundreds of sessions per user).
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

SessionStatus = Literal["open", "ended"]


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

_DEFAULT_BASE_PATH = Path("users")


class SessionStore:
    """CRUD for session records stored as JSON files.

    File layout::

        {base_path}/{user_id}/sessions/{session_id}.json
    """

    def __init__(self, base_path: Path | None = None) -> None:
        self._base = base_path or _DEFAULT_BASE_PATH

    # -- helpers -------------------------------------------------------------

    def _user_dir(self, user_id: str) -> Path:
        return self._base / user_id / "sessions"

    def _session_path(self, user_id: str, session_id: str) -> Path:
        return self._user_dir(user_id) / f"{session_id}.json"

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
        return self._read(self._session_path(user_id, session_id))

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

    def delete(self, user_id: str, session_id: str) -> bool:
        """Delete a session record from disk."""
        path = self._session_path(user_id, session_id)
        if not path.is_file():
            return False
        path.unlink()
        return True

    def list_open(self, user_id: str) -> list[SessionRecord]:
        """Return all open sessions for a user, newest first."""
        return [
            r for r in self._list_all(user_id) if r.status == "open"
        ]

    def list_recent(self, user_id: str, limit: int = 30) -> list[SessionRecord]:
        """Return the most recent sessions (any status), newest first."""
        all_sessions = self._list_all(user_id)
        return all_sessions[:limit]

    def _list_all(self, user_id: str) -> list[SessionRecord]:
        """Load all sessions for a user, sorted by updated_at descending."""
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
