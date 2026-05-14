"""Task-id resolution cache for the workshop guest-dispatch flow.

When companion's ``start_builder_task`` tool fires in a Telegram-originated
session, the channel layer (Phase 2) posts a summoning message containing
``@Sophia_work_bot ...`` and stores ``(chat_id, message_id) → task_id``
here. When Telegram dispatches the guest update to the workshop bot, the
workshop handler reads the cache by ``(chat_id, summoning_message_id)``.

TTL is short (5 minutes) because the summoning-to-dispatch round trip is
sub-second in practice; the TTL covers retry storms only. The cache is
process-local for Phase 1 — if the gateway scales horizontally later,
this moves to Redis (the public ``register`` / ``resolve`` API stays
the same).

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §11.3.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

logger = logging.getLogger(__name__)


_DEFAULT_TTL_SECONDS = 300
_DEFAULT_MAX_ENTRIES = 1024


@dataclass(frozen=True, slots=True)
class _Entry:
    task_id: str
    user_id: str
    expires_at: float


class TaskResolutionCache:
    """Process-local LRU+TTL map of ``(chat_id, message_id) → task_id``.

    Thread-safe via ``_lock``. The fanout uses :meth:`register` from the
    channel layer (companion handler) and :meth:`resolve` from the workshop
    handler.
    """

    def __init__(
        self,
        *,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
        max_entries: int = _DEFAULT_MAX_ENTRIES,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: OrderedDict[tuple[int, int], _Entry] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def _coerce_key(chat_id: int | str, message_id: int | str) -> tuple[int, int]:
        try:
            return int(chat_id), int(message_id)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"chat_id/message_id must be int-coercible (got {chat_id!r}, {message_id!r})") from exc

    def register(
        self,
        *,
        chat_id: int | str,
        message_id: int | str,
        task_id: str,
        user_id: str,
    ) -> None:
        """Record the summoning-message → task_id mapping."""
        if not task_id or not user_id:
            raise ValueError("task_id and user_id must be non-empty strings")
        key = self._coerce_key(chat_id, message_id)
        expires_at = time.monotonic() + self._ttl_seconds
        entry = _Entry(task_id=task_id, user_id=user_id, expires_at=expires_at)
        with self._lock:
            self._entries[key] = entry
            self._entries.move_to_end(key)
            self._evict_locked()
        logger.debug(
            "TaskResolutionCache.register chat_id=%s message_id=%s task_id=%s user_id=%s",
            key[0],
            key[1],
            task_id,
            user_id,
        )

    def resolve(
        self,
        *,
        chat_id: int | str,
        message_id: int | str,
    ) -> tuple[str, str] | None:
        """Return ``(task_id, user_id)`` if known and not expired."""
        try:
            key = self._coerce_key(chat_id, message_id)
        except ValueError:
            return None
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry.expires_at < now:
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return entry.task_id, entry.user_id

    def forget(self, *, chat_id: int | str, message_id: int | str) -> None:
        """Remove a mapping (used by tests; not needed in normal operation)."""
        try:
            key = self._coerce_key(chat_id, message_id)
        except ValueError:
            return
        with self._lock:
            self._entries.pop(key, None)

    def _evict_locked(self) -> None:
        """Trim the cache to ``max_entries`` (caller holds ``_lock``)."""
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)

    # -- diagnostics ------------------------------------------------------

    def size(self) -> int:
        with self._lock:
            return len(self._entries)


__all__ = ["TaskResolutionCache"]
