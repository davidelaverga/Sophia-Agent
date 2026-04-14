"""Persistent Telegram linking and one-time deep-link token management."""

from __future__ import annotations

import hashlib
import json
import secrets
import tempfile
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from deerflow.agents.sophia_agent.utils import validate_user_id
from deerflow.config.paths import get_paths

DEFAULT_LINK_TOKEN_TTL_SECONDS = 15 * 60


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _isoformat(dt: datetime) -> str:
    return dt.isoformat()


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _clean_token(token: str) -> str:
    if not isinstance(token, str):
        return ""
    return token.strip()


class TelegramLinkStore:
    """JSON-backed store for Telegram ↔ Sophia user links and link tokens."""

    def __init__(self, path: str | Path | None = None) -> None:
        if path is None:
            path = Path(get_paths().base_dir) / "channels" / "telegram_links.json"
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._data = self._load()

    def _empty_data(self) -> dict[str, Any]:
        return {
            "tokens": {},
            "links_by_chat": {},
            "links_by_user": {},
        }

    def _load(self) -> dict[str, Any]:
        if not self._path.exists():
            return self._empty_data()
        try:
            loaded = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return self._empty_data()
        if not isinstance(loaded, dict):
            return self._empty_data()
        data = self._empty_data()
        for key in data:
            layer = loaded.get(key)
            if isinstance(layer, dict):
                data[key] = layer
        return data

    def _save(self) -> None:
        fd = tempfile.NamedTemporaryFile(
            mode="w",
            dir=self._path.parent,
            suffix=".tmp",
            delete=False,
            encoding="utf-8",
        )
        try:
            json.dump(self._data, fd, indent=2, ensure_ascii=False)
            fd.close()
            Path(fd.name).replace(self._path)
        except BaseException:
            fd.close()
            Path(fd.name).unlink(missing_ok=True)
            raise

    def _prune_expired_tokens(self, now: datetime) -> None:
        tokens = self._data["tokens"]
        expired_keys: list[str] = []
        for token_key, token_record in tokens.items():
            if not isinstance(token_record, dict):
                expired_keys.append(token_key)
                continue
            expires_at = _parse_datetime(token_record.get("expires_at"))
            if expires_at is None or expires_at <= now:
                expired_keys.append(token_key)
        for token_key in expired_keys:
            tokens.pop(token_key, None)

    def issue_link_token(
        self,
        *,
        sophia_user_id: str,
        context_mode: str = "life",
        ttl_seconds: int = DEFAULT_LINK_TOKEN_TTL_SECONDS,
    ) -> dict[str, Any]:
        user_id = validate_user_id(sophia_user_id)
        ttl = max(60, int(ttl_seconds))
        now = _utcnow()
        expires_at = now + timedelta(seconds=ttl)
        token = secrets.token_urlsafe(32)
        token_key = _token_hash(token)

        with self._lock:
            self._prune_expired_tokens(now)
            self._data["tokens"][token_key] = {
                "user_id": user_id,
                "context_mode": context_mode if isinstance(context_mode, str) else "life",
                "created_at": _isoformat(now),
                "expires_at": _isoformat(expires_at),
                "used_at": None,
            }
            self._save()

        return {
            "token": token,
            "user_id": user_id,
            "context_mode": context_mode if isinstance(context_mode, str) else "life",
            "expires_at": _isoformat(expires_at),
            "ttl_seconds": ttl,
        }

    def redeem_link_token(
        self,
        *,
        token: str,
        telegram_chat_id: str,
        telegram_user_id: str,
        telegram_username: str | None = None,
        telegram_first_name: str | None = None,
        telegram_last_name: str | None = None,
    ) -> dict[str, Any] | None:
        clean_token = _clean_token(token)
        if not clean_token:
            return None
        chat_id = str(telegram_chat_id).strip()
        tg_user_id = str(telegram_user_id).strip()
        if not chat_id or not tg_user_id:
            return None

        token_key = _token_hash(clean_token)
        now = _utcnow()

        with self._lock:
            self._prune_expired_tokens(now)
            token_record = self._data["tokens"].get(token_key)
            if not isinstance(token_record, dict):
                return None

            expires_at = _parse_datetime(token_record.get("expires_at"))
            if expires_at is None or expires_at <= now:
                self._data["tokens"].pop(token_key, None)
                self._save()
                return None

            if token_record.get("used_at"):
                return None

            user_id = token_record.get("user_id")
            if not isinstance(user_id, str) or not user_id:
                return None

            context_mode = token_record.get("context_mode")
            if not isinstance(context_mode, str) or not context_mode:
                context_mode = "life"

            existing_user_link = self._data["links_by_user"].get(user_id)
            if isinstance(existing_user_link, dict):
                previous_chat_id = existing_user_link.get("telegram_chat_id")
                if isinstance(previous_chat_id, str) and previous_chat_id:
                    self._data["links_by_chat"].pop(previous_chat_id, None)
            existing_chat_link = self._data["links_by_chat"].get(chat_id)
            if isinstance(existing_chat_link, dict):
                previous_user_id = existing_chat_link.get("user_id")
                if isinstance(previous_user_id, str) and previous_user_id and previous_user_id != user_id:
                    previous_user_link = self._data["links_by_user"].get(previous_user_id)
                    if isinstance(previous_user_link, dict) and previous_user_link.get("telegram_chat_id") == chat_id:
                        self._data["links_by_user"].pop(previous_user_id, None)

            link_record = {
                "user_id": user_id,
                "telegram_chat_id": chat_id,
                "telegram_user_id": tg_user_id,
                "telegram_username": telegram_username or None,
                "telegram_first_name": telegram_first_name or None,
                "telegram_last_name": telegram_last_name or None,
                "context_mode": context_mode,
                "linked_at": _isoformat(now),
                "last_seen_at": _isoformat(now),
            }
            self._data["links_by_chat"][chat_id] = link_record
            self._data["links_by_user"][user_id] = link_record
            token_record["used_at"] = _isoformat(now)
            self._save()

        return dict(link_record)

    def get_link_by_chat(self, telegram_chat_id: str) -> dict[str, Any] | None:
        chat_id = str(telegram_chat_id).strip()
        if not chat_id:
            return None
        with self._lock:
            link = self._data["links_by_chat"].get(chat_id)
            if isinstance(link, dict):
                return dict(link)
        return None

    def get_link_by_user(self, sophia_user_id: str) -> dict[str, Any] | None:
        user_id = validate_user_id(sophia_user_id)
        with self._lock:
            link = self._data["links_by_user"].get(user_id)
            if isinstance(link, dict):
                return dict(link)
        return None

    def touch_chat_activity(self, telegram_chat_id: str) -> None:
        chat_id = str(telegram_chat_id).strip()
        if not chat_id:
            return
        now_iso = _isoformat(_utcnow())
        with self._lock:
            chat_link = self._data["links_by_chat"].get(chat_id)
            if not isinstance(chat_link, dict):
                return
            chat_link["last_seen_at"] = now_iso
            user_id = chat_link.get("user_id")
            if isinstance(user_id, str) and user_id:
                user_link = self._data["links_by_user"].get(user_id)
                if isinstance(user_link, dict):
                    user_link["last_seen_at"] = now_iso
            self._save()

    def unlink_user(self, sophia_user_id: str) -> bool:
        user_id = validate_user_id(sophia_user_id)
        with self._lock:
            user_link = self._data["links_by_user"].pop(user_id, None)
            if not isinstance(user_link, dict):
                return False
            chat_id = user_link.get("telegram_chat_id")
            if isinstance(chat_id, str) and chat_id:
                self._data["links_by_chat"].pop(chat_id, None)
            self._save()
            return True

    def unlink_chat(self, telegram_chat_id: str) -> bool:
        chat_id = str(telegram_chat_id).strip()
        if not chat_id:
            return False
        with self._lock:
            chat_link = self._data["links_by_chat"].pop(chat_id, None)
            if not isinstance(chat_link, dict):
                return False
            user_id = chat_link.get("user_id")
            if isinstance(user_id, str) and user_id:
                self._data["links_by_user"].pop(user_id, None)
            self._save()
            return True


_telegram_link_store: TelegramLinkStore | None = None
_telegram_link_store_lock = threading.Lock()


def get_telegram_link_store() -> TelegramLinkStore:
    global _telegram_link_store
    with _telegram_link_store_lock:
        if _telegram_link_store is None:
            _telegram_link_store = TelegramLinkStore()
        return _telegram_link_store
