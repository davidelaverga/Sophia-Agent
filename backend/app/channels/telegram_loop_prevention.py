"""Telegram bot-to-bot loop prevention — Phase 1 of workshop architecture.

Telegram's docs require these safeguards before bot-to-bot communication
goes live in production. Four independent rules:

1. **Interaction-depth tracker** — per root user message, count bot-to-bot
   exchanges. Max 5.
2. **Per-source rate limiter** — token-bucket per source bot id. Default
   1 message per 2 seconds, burst 3.
3. **Content dedup** — LRU keyed on ``(chat_id, source_bot_id, sha256(text))``.
   60-second window.
4. **Per-event arrival timeout** — handled in
   ``BuilderEventFanout.attach_stream`` and the workshop handler's
   subscription loop, not here. This module covers the discrete-message
   safeguards.

Strict-mode default ON. Disable only for tests via
``TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT=false`` (the workshop handler
enforces this — this module is policy-neutral).

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §14.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from threading import Lock

logger = logging.getLogger(__name__)


# ---- Interaction-depth tracker --------------------------------------------


@dataclass(slots=True)
class _DepthEntry:
    depth: int = 0
    last_touched: float = field(default_factory=time.monotonic)


class InteractionDepthTracker:
    """Per-(chat_id, root_user_message_id) bot-to-bot exchange counter."""

    DEFAULT_MAX_DEPTH = 5
    _DEFAULT_TTL_SECONDS = 30 * 60

    def __init__(
        self,
        *,
        max_depth: int = DEFAULT_MAX_DEPTH,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
    ) -> None:
        self._max_depth = max_depth
        self._ttl_seconds = ttl_seconds
        self._entries: OrderedDict[tuple[int, int], _DepthEntry] = OrderedDict()
        self._lock = Lock()

    def increment(self, chat_id: int, root_message_id: int) -> tuple[int, bool]:
        """Increment the depth and return ``(new_depth, allowed)``.

        ``allowed`` is False when the new depth exceeds the cap.
        """
        key = (int(chat_id), int(root_message_id))
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            entry = self._entries.get(key)
            if entry is None:
                entry = _DepthEntry()
                self._entries[key] = entry
            entry.depth += 1
            entry.last_touched = now
            self._entries.move_to_end(key)
            return entry.depth, entry.depth <= self._max_depth

    def reset(self, chat_id: int, root_message_id: int) -> None:
        key = (int(chat_id), int(root_message_id))
        with self._lock:
            self._entries.pop(key, None)

    def _prune_locked(self, now: float) -> None:
        cutoff = now - self._ttl_seconds
        stale = [k for k, v in self._entries.items() if v.last_touched < cutoff]
        for key in stale:
            self._entries.pop(key, None)


# ---- Per-source rate limiter ----------------------------------------------


@dataclass(slots=True)
class _Bucket:
    tokens: float
    last_refill: float


class PerSourceRateLimiter:
    """Token-bucket rate limiter keyed on source bot id."""

    DEFAULT_RATE_PER_SECOND = 0.5
    DEFAULT_BURST = 3

    def __init__(
        self,
        *,
        rate_per_second: float = DEFAULT_RATE_PER_SECOND,
        burst: int = DEFAULT_BURST,
    ) -> None:
        self._rate = max(0.01, float(rate_per_second))
        self._burst = max(1, int(burst))
        self._buckets: dict[int, _Bucket] = {}
        self._lock = Lock()

    def allow(self, source_bot_id: int) -> bool:
        now = time.monotonic()
        key = int(source_bot_id)
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=float(self._burst), last_refill=now)
                self._buckets[key] = bucket
            elapsed = max(0.0, now - bucket.last_refill)
            bucket.tokens = min(float(self._burst), bucket.tokens + elapsed * self._rate)
            bucket.last_refill = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True
            return False


# ---- Content dedup --------------------------------------------------------


class ContentDedup:
    """60-second window LRU dedup keyed on ``(chat_id, source_bot_id, hash(text))``."""

    DEFAULT_WINDOW_SECONDS = 60
    _DEFAULT_MAX_ENTRIES = 2048

    def __init__(
        self,
        *,
        window_seconds: int = DEFAULT_WINDOW_SECONDS,
        max_entries: int = _DEFAULT_MAX_ENTRIES,
    ) -> None:
        self._window = window_seconds
        self._max_entries = max_entries
        self._entries: OrderedDict[tuple[int, int, str], float] = OrderedDict()
        self._lock = Lock()

    @staticmethod
    def _normalise(text: str) -> str:
        return " ".join((text or "").split()).strip().lower()

    def is_duplicate(self, chat_id: int, source_bot_id: int, text: str) -> bool:
        normalised = self._normalise(text)
        if not normalised:
            return False
        digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()
        key = (int(chat_id), int(source_bot_id), digest)
        now = time.monotonic()
        with self._lock:
            self._prune_locked(now)
            seen_at = self._entries.get(key)
            if seen_at is not None and now - seen_at < self._window:
                self._entries.move_to_end(key)
                return True
            self._entries[key] = now
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
            return False

    def _prune_locked(self, now: float) -> None:
        cutoff = now - self._window
        stale = [k for k, ts in self._entries.items() if ts < cutoff]
        for key in stale:
            self._entries.pop(key, None)


# ---- Composite gatekeeper -------------------------------------------------


@dataclass(slots=True)
class LoopPreventionDecision:
    """Result of running all checks. ``allow=True`` only if every check passes."""

    allow: bool
    blocked_rule: str | None = None
    blocked_value: int | float | str | None = None
    blocked_limit: int | float | str | None = None


class LoopPreventionGate:
    """Composite gatekeeper combining the three discrete-message rules."""

    def __init__(
        self,
        *,
        depth: InteractionDepthTracker | None = None,
        rate: PerSourceRateLimiter | None = None,
        dedup: ContentDedup | None = None,
    ) -> None:
        self.depth = depth or InteractionDepthTracker()
        self.rate = rate or PerSourceRateLimiter()
        self.dedup = dedup or ContentDedup()

    def check(
        self,
        *,
        chat_id: int,
        root_message_id: int,
        source_bot_id: int,
        text: str,
    ) -> LoopPreventionDecision:
        """Run all three checks. First failure short-circuits."""
        if not self.rate.allow(source_bot_id):
            return LoopPreventionDecision(
                allow=False,
                blocked_rule="rate",
                blocked_value=source_bot_id,
                blocked_limit=self.rate._rate,  # noqa: SLF001 — diagnostic only
            )
        if self.dedup.is_duplicate(chat_id, source_bot_id, text):
            return LoopPreventionDecision(
                allow=False,
                blocked_rule="dedup",
                blocked_value=len(text or ""),
                blocked_limit=self.dedup._window,  # noqa: SLF001 — diagnostic only
            )
        depth_value, allowed = self.depth.increment(chat_id, root_message_id)
        if not allowed:
            return LoopPreventionDecision(
                allow=False,
                blocked_rule="depth",
                blocked_value=depth_value,
                blocked_limit=self.depth._max_depth,  # noqa: SLF001 — diagnostic only
            )
        return LoopPreventionDecision(allow=True)


__all__ = [
    "ContentDedup",
    "InteractionDepthTracker",
    "LoopPreventionDecision",
    "LoopPreventionGate",
    "PerSourceRateLimiter",
]
