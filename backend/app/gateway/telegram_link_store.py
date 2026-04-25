"""Token + binding store for the webapp → Telegram start-chat deep-link flow.

Two data structures, both thread-safe and TTL-bounded:

1. ``link_tokens``: short-lived (10 min), single-use tokens issued when a
   logged-in webapp user clicks "Connect Telegram". Redeemed by the bot's
   ``/start <token>`` handler after the user follows the deep link.

2. ``user_bindings``: long-lived ``(channel, chat_id) -> canonical_user_id``
   mappings. Consulted by the channel manager on every inbound Telegram
   message so memories/handoffs/traces converge across platforms.

Both are best-effort mirrored to Supabase when configured so bindings
survive gateway restarts. The in-memory layer is always authoritative
for the current process — Supabase is used only to reseed on startup
and to persist across deployments.

Design mirrors ``deerflow.sophia.storage.supabase_mirror`` (bounded LRU,
swallow-all-errors) and the PR #62 ``internal_builder_tasks`` registry
(constant-time bearer auth, TTL eviction).
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Literal

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_TOKEN_TTL_SECONDS = 10 * 60  # 10 minutes
_MAX_ACTIVE_TOKENS = 4096  # bounded LRU
_MAX_BINDINGS = 65_536  # bounded LRU
_BOT_USERNAME_FALLBACK = "Sophia_EI_bot"

# Supabase REST timeout for binding persistence (best-effort — never blocks
# the critical path beyond a short window).
_SUPABASE_TIMEOUT_SECONDS = 5.0

# Supabase table names. Set via env to allow override in tests/staging.
_BINDINGS_TABLE = os.getenv("SOPHIA_TELEGRAM_BINDINGS_TABLE", "telegram_user_bindings")

ChannelName = Literal["telegram"]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LinkTokenRecord:
    token: str
    user_id: str
    expires_at: float
    created_at: float


@dataclass(frozen=True)
class UserBinding:
    channel: ChannelName
    chat_id: str
    user_id: str
    telegram_user_id: str | None
    telegram_username: str | None
    created_at: float


# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

_lock = threading.RLock()
_tokens: dict[str, LinkTokenRecord] = {}
_bindings_by_chat: dict[tuple[ChannelName, str], UserBinding] = {}
_bindings_by_user: dict[str, set[tuple[ChannelName, str]]] = {}


# ---------------------------------------------------------------------------
# Bot username
# ---------------------------------------------------------------------------


def get_bot_username() -> str:
    """Return the Telegram bot username used to assemble deep-link URLs.

    Read from env var ``TELEGRAM_BOT_USERNAME``. Falls back to the known
    production bot (``Sophia_EI_bot``) when unset so local dev without the
    env var still produces a usable URL for manual testing. The '@' prefix
    is stripped if present.
    """
    raw = os.getenv("TELEGRAM_BOT_USERNAME", "").strip()
    if not raw:
        return _BOT_USERNAME_FALLBACK
    return raw.lstrip("@")


# ---------------------------------------------------------------------------
# Token issuance / redemption
# ---------------------------------------------------------------------------


def _now() -> float:
    return time.time()


def _evict_expired_tokens_locked(now: float) -> None:
    expired = [k for k, rec in _tokens.items() if rec.expires_at <= now]
    for key in expired:
        _tokens.pop(key, None)


def issue_link_token(user_id: str, *, ttl_seconds: int = _TOKEN_TTL_SECONDS) -> LinkTokenRecord:
    """Issue a fresh single-use deep-link token bound to ``user_id``.

    The token is 32 bytes of urlsafe entropy (Telegram /start accepts up to
    64 chars; urlsafe_b64 of 32 bytes is 43 chars). Caller is responsible
    for returning the full ``t.me/<bot>?start=<token>`` URL to the client.
    """
    if not user_id or not user_id.strip():
        raise ValueError("user_id is required")
    token = secrets.token_urlsafe(32)
    now = _now()
    record = LinkTokenRecord(
        token=token,
        user_id=user_id.strip(),
        expires_at=now + ttl_seconds,
        created_at=now,
    )
    with _lock:
        _evict_expired_tokens_locked(now)
        # Bound the active token count to prevent a leaky client from
        # OOM'ing us. Oldest token wins eviction.
        while len(_tokens) >= _MAX_ACTIVE_TOKENS:
            oldest = min(_tokens.items(), key=lambda kv: kv[1].created_at)[0]
            _tokens.pop(oldest, None)
        _tokens[token] = record
    logger.info(
        "telegram_link.issue user_id=%s token_prefix=%s expires_in=%ds",
        user_id,
        token[:6],
        ttl_seconds,
    )
    return record


def pop_link_token(token: str) -> LinkTokenRecord | None:
    """Atomically consume a deep-link token.

    Returns the record on success, ``None`` if the token is unknown or
    has expired. The token cannot be redeemed twice.
    """
    if not token:
        return None
    now = _now()
    with _lock:
        _evict_expired_tokens_locked(now)
        record = _tokens.pop(token, None)
    if record is None:
        return None
    if record.expires_at <= now:
        return None
    return record


# ---------------------------------------------------------------------------
# Binding persistence
# ---------------------------------------------------------------------------


def _supabase_config() -> tuple[str, str] | None:
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or ""
    key = key.strip()
    if not url or not key:
        return None
    return url, key


def _supabase_upsert_binding(binding: UserBinding) -> None:
    cfg = _supabase_config()
    if cfg is None:
        return
    url, key = cfg
    endpoint = f"{url}/rest/v1/{_BINDINGS_TABLE}"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    body = [
        {
            "channel": binding.channel,
            "chat_id": binding.chat_id,
            "user_id": binding.user_id,
            "telegram_user_id": binding.telegram_user_id,
            "telegram_username": binding.telegram_username,
            "created_at": binding.created_at,
        }
    ]
    try:
        with httpx.Client(timeout=_SUPABASE_TIMEOUT_SECONDS) as client:
            response = client.post(endpoint, headers=headers, json=body)
            if response.status_code >= 400:
                logger.warning(
                    "telegram_link.supabase_upsert_failed status=%d body=%r",
                    response.status_code,
                    response.text[:200],
                )
    except httpx.HTTPError as exc:
        logger.warning("telegram_link.supabase_upsert_error error=%s", exc)


def _supabase_delete_binding(channel: ChannelName, chat_id: str) -> None:
    cfg = _supabase_config()
    if cfg is None:
        return
    url, key = cfg
    endpoint = (
        f"{url}/rest/v1/{_BINDINGS_TABLE}"
        f"?channel=eq.{channel}&chat_id=eq.{chat_id}"
    )
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
    }
    try:
        with httpx.Client(timeout=_SUPABASE_TIMEOUT_SECONDS) as client:
            client.delete(endpoint, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("telegram_link.supabase_delete_error error=%s", exc)


def _supabase_delete_bindings_for_user(user_id: str) -> None:
    cfg = _supabase_config()
    if cfg is None:
        return
    url, key = cfg
    endpoint = f"{url}/rest/v1/{_BINDINGS_TABLE}?user_id=eq.{user_id}"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
    }
    try:
        with httpx.Client(timeout=_SUPABASE_TIMEOUT_SECONDS) as client:
            client.delete(endpoint, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("telegram_link.supabase_delete_user_error error=%s", exc)


# ---------------------------------------------------------------------------
# Binding API
# ---------------------------------------------------------------------------


def bind_chat(
    channel: ChannelName,
    chat_id: str,
    user_id: str,
    *,
    telegram_user_id: str | None = None,
    telegram_username: str | None = None,
) -> UserBinding:
    """Persist a ``(channel, chat_id) -> user_id`` binding.

    Overwrites any previous binding for the same chat. Best-effort mirrors
    to Supabase when configured.
    """
    if not chat_id or not user_id:
        raise ValueError("chat_id and user_id are required")
    binding = UserBinding(
        channel=channel,
        chat_id=str(chat_id),
        user_id=user_id.strip(),
        telegram_user_id=telegram_user_id,
        telegram_username=telegram_username,
        created_at=_now(),
    )
    key = (channel, binding.chat_id)
    with _lock:
        old = _bindings_by_chat.pop(key, None)
        if old is not None:
            user_keys = _bindings_by_user.get(old.user_id)
            if user_keys is not None:
                user_keys.discard(key)
                if not user_keys:
                    _bindings_by_user.pop(old.user_id, None)
        # Bound the total binding count.
        while len(_bindings_by_chat) >= _MAX_BINDINGS:
            oldest_key, oldest = min(_bindings_by_chat.items(), key=lambda kv: kv[1].created_at)
            _bindings_by_chat.pop(oldest_key, None)
            user_keys = _bindings_by_user.get(oldest.user_id)
            if user_keys is not None:
                user_keys.discard(oldest_key)
                if not user_keys:
                    _bindings_by_user.pop(oldest.user_id, None)
        _bindings_by_chat[key] = binding
        _bindings_by_user.setdefault(binding.user_id, set()).add(key)
    logger.info(
        "telegram_link.bind channel=%s chat_id=%s user_id=%s tg_username=%s",
        channel,
        binding.chat_id,
        binding.user_id,
        telegram_username,
    )
    _supabase_upsert_binding(binding)
    return binding


def resolve_user_id(channel: ChannelName, chat_id: str) -> str | None:
    """Return the canonical user_id bound to ``(channel, chat_id)``, or None."""
    if not chat_id:
        return None
    key = (channel, str(chat_id))
    with _lock:
        binding = _bindings_by_chat.get(key)
    return binding.user_id if binding else None


def get_binding_for_user(user_id: str, channel: ChannelName = "telegram") -> UserBinding | None:
    """Return the first binding for ``user_id`` on ``channel``, or None."""
    if not user_id:
        return None
    with _lock:
        keys = _bindings_by_user.get(user_id.strip(), set())
        for key in keys:
            if key[0] == channel:
                return _bindings_by_chat.get(key)
    return None


def unbind_user(user_id: str, channel: ChannelName = "telegram") -> int:
    """Remove all bindings for ``user_id`` on ``channel``. Returns count removed."""
    if not user_id:
        return 0
    removed = 0
    with _lock:
        keys = list(_bindings_by_user.get(user_id.strip(), set()))
        for key in keys:
            if key[0] != channel:
                continue
            _bindings_by_chat.pop(key, None)
            user_keys = _bindings_by_user.get(user_id.strip())
            if user_keys is not None:
                user_keys.discard(key)
                if not user_keys:
                    _bindings_by_user.pop(user_id.strip(), None)
            removed += 1
    if removed > 0:
        _supabase_delete_bindings_for_user(user_id.strip())
    return removed


def unbind_chat(channel: ChannelName, chat_id: str) -> bool:
    """Remove the binding for a specific chat. Returns True if one was removed."""
    if not chat_id:
        return False
    key = (channel, str(chat_id))
    with _lock:
        binding = _bindings_by_chat.pop(key, None)
        if binding is None:
            return False
        user_keys = _bindings_by_user.get(binding.user_id)
        if user_keys is not None:
            user_keys.discard(key)
            if not user_keys:
                _bindings_by_user.pop(binding.user_id, None)
    _supabase_delete_binding(channel, str(chat_id))
    return True


# ---------------------------------------------------------------------------
# Rehydration from Supabase
# ---------------------------------------------------------------------------


# Supabase REST paginates at 1000 rows by default — request 1000 per page and
# stop once the returned batch is smaller.
_SUPABASE_PAGE_SIZE = 1000


def _coerce_binding_from_row(row: object) -> UserBinding | None:
    if not isinstance(row, dict):
        return None
    channel = row.get("channel")
    chat_id = row.get("chat_id")
    user_id = row.get("user_id")
    if channel != "telegram" or not isinstance(chat_id, str) or not isinstance(user_id, str):
        return None
    if not chat_id.strip() or not user_id.strip():
        return None
    created_at_raw = row.get("created_at")
    try:
        created_at = float(created_at_raw) if created_at_raw is not None else _now()
    except (TypeError, ValueError):
        created_at = _now()
    telegram_user_id = row.get("telegram_user_id")
    telegram_username = row.get("telegram_username")
    return UserBinding(
        channel="telegram",
        chat_id=chat_id,
        user_id=user_id,
        telegram_user_id=telegram_user_id if isinstance(telegram_user_id, str) else None,
        telegram_username=telegram_username if isinstance(telegram_username, str) else None,
        created_at=created_at,
    )


def _install_binding_locked(binding: UserBinding) -> None:
    """Insert ``binding`` into the in-memory maps (caller holds ``_lock``)."""
    key = (binding.channel, binding.chat_id)
    # Bound the total binding count, mirroring ``bind_chat``.
    while len(_bindings_by_chat) >= _MAX_BINDINGS and key not in _bindings_by_chat:
        oldest_key, oldest = min(_bindings_by_chat.items(), key=lambda kv: kv[1].created_at)
        _bindings_by_chat.pop(oldest_key, None)
        user_keys = _bindings_by_user.get(oldest.user_id)
        if user_keys is not None:
            user_keys.discard(oldest_key)
            if not user_keys:
                _bindings_by_user.pop(oldest.user_id, None)
    _bindings_by_chat[key] = binding
    _bindings_by_user.setdefault(binding.user_id, set()).add(key)


def load_bindings_from_supabase() -> int:
    """Reseed the in-memory binding maps from Supabase.

    Best-effort: logs and swallows all errors. Called once at gateway
    startup so cross-platform identity resolution survives deploys/restarts.
    Returns the number of bindings that were loaded (0 when Supabase is
    not configured or a transport error occurs).
    """
    cfg = _supabase_config()
    if cfg is None:
        logger.info("telegram_link.rehydrate_skipped reason=supabase_not_configured")
        return 0
    url, key = cfg
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
    }
    offset = 0
    total = 0
    try:
        with httpx.Client(timeout=_SUPABASE_TIMEOUT_SECONDS) as client:
            while True:
                endpoint = (
                    f"{url}/rest/v1/{_BINDINGS_TABLE}"
                    f"?select=channel,chat_id,user_id,telegram_user_id,telegram_username,created_at"
                    f"&channel=eq.telegram"
                    f"&order=created_at.asc"
                    f"&offset={offset}&limit={_SUPABASE_PAGE_SIZE}"
                )
                response = client.get(endpoint, headers=headers)
                if response.status_code >= 400:
                    body_snippet = response.text[:200]
                    if response.status_code == 404 and "PGRST205" in body_snippet:
                        logger.warning(
                            "telegram_link.rehydrate_skipped reason=table_missing table=%s "
                            "hint=run backend/migrations/2026_04_25_telegram_user_bindings.sql",
                            _BINDINGS_TABLE,
                        )
                    else:
                        logger.warning(
                            "telegram_link.rehydrate_failed status=%d body=%r",
                            response.status_code,
                            body_snippet,
                        )
                    return total
                try:
                    rows = response.json()
                except ValueError:
                    logger.warning("telegram_link.rehydrate_invalid_json body=%r", response.text[:200])
                    return total
                if not isinstance(rows, list) or not rows:
                    return total
                installed = 0
                with _lock:
                    for row in rows:
                        binding = _coerce_binding_from_row(row)
                        if binding is None:
                            continue
                        _install_binding_locked(binding)
                        installed += 1
                total += installed
                if len(rows) < _SUPABASE_PAGE_SIZE:
                    return total
                offset += _SUPABASE_PAGE_SIZE
    except httpx.HTTPError as exc:
        logger.warning("telegram_link.rehydrate_error error=%s", exc)
        return total
    finally:
        if total:
            logger.info("telegram_link.rehydrated bindings=%d", total)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def clear_all() -> None:
    """Wipe all in-process state. For tests only."""
    with _lock:
        _tokens.clear()
        _bindings_by_chat.clear()
        _bindings_by_user.clear()
