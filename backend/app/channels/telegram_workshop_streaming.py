"""StreamingTextClient — Telegram streaming-text wrapper for workshop.

Phase 1 ships an ``editMessageText``-with-batching shim. The Telegram
"native streaming text" Bot API method names from the 2026-05-07 release
are intentionally unverified here (spec §22 Q1) — the shim doubles as
the spec §15.6 degraded fallback. When the streaming method is pinned
at Phase 2 kickoff, swap the ``_push_update`` implementation; the rest
of the public surface stays.

The client owns rate limiting (one update per ``update_interval_ms`` by
default) and bookkeeping for the most-recent rendered body. Callers
hand it new bodies via :meth:`set_body`; the client decides when to
issue an ``editMessageText``.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §11.5,
§13.4, §15.6.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


_DEFAULT_UPDATE_INTERVAL_MS = 750


def _resolved_interval_ms() -> int:
    try:
        return int(os.environ.get("WORKSHOP_STREAMING_UPDATE_INTERVAL_MS", _DEFAULT_UPDATE_INTERVAL_MS))
    except (TypeError, ValueError):
        return _DEFAULT_UPDATE_INTERVAL_MS


class StreamingTextClient:
    """One streaming reply lifecycle. Not thread-safe — one client per task."""

    def __init__(
        self,
        *,
        bot: Any,
        chat_id: int,
        update_interval_ms: int | None = None,
    ) -> None:
        self._bot = bot
        self._chat_id = chat_id
        self._update_interval_ms = update_interval_ms if update_interval_ms is not None else _resolved_interval_ms()
        self._message_id: int | None = None
        self._latest_body: str = ""
        self._last_pushed_body: str = ""
        self._last_push_ts: float = 0.0
        self._lock = asyncio.Lock()
        self._degraded_failures = 0
        self._max_consecutive_failures = 3
        self._degraded = False

    @property
    def message_id(self) -> int | None:
        return self._message_id

    @property
    def is_degraded(self) -> bool:
        return self._degraded

    async def open(self, initial_body: str) -> int:
        """Send the first message and return its message_id."""
        async with self._lock:
            self._latest_body = initial_body or " "
            try:
                sent = await self._send_message(self._latest_body)
                self._message_id = self._extract_message_id(sent)
                self._last_pushed_body = self._latest_body
                self._last_push_ts = asyncio.get_event_loop().time()
                logger.info(
                    "StreamingTextClient.open chat_id=%s message_id=%s",
                    self._chat_id,
                    self._message_id,
                )
            except Exception:
                logger.warning(
                    "StreamingTextClient.open failed chat_id=%s",
                    self._chat_id,
                    exc_info=True,
                )
                raise
        return self._message_id  # type: ignore[return-value]

    async def set_body(self, body: str, *, flush: bool = False) -> bool:
        """Stage a new body. Returns True if a Telegram update was pushed."""
        if not body:
            return False
        async with self._lock:
            self._latest_body = body
            now = asyncio.get_event_loop().time()
            elapsed_ms = (now - self._last_push_ts) * 1000.0
            if not flush and elapsed_ms < self._update_interval_ms:
                return False
            if self._latest_body == self._last_pushed_body:
                return False
            return await self._push_locked(now)

    async def finalize(self, final_body: str) -> bool:
        """Push the final body unconditionally and stop accepting updates."""
        async with self._lock:
            self._latest_body = final_body
            self._last_pushed_body = ""  # force the edit even if identical
            return await self._push_locked(asyncio.get_event_loop().time())

    # -- internals -----------------------------------------------------------

    async def _push_locked(self, now: float) -> bool:
        if self._message_id is None:
            return False
        body = self._latest_body
        try:
            await self._push_update(body)
            self._last_pushed_body = body
            self._last_push_ts = now
            self._degraded_failures = 0
            return True
        except Exception:
            self._degraded_failures += 1
            if self._degraded_failures >= self._max_consecutive_failures:
                self._degraded = True
                logger.warning(
                    "StreamingTextClient: switching to degraded mode (consecutive failures=%d)",
                    self._degraded_failures,
                )
            logger.warning(
                "StreamingTextClient._push_update failed chat_id=%s message_id=%s degraded=%s",
                self._chat_id,
                self._message_id,
                self._degraded,
                exc_info=True,
            )
            return False

    async def _send_message(self, text: str) -> Any:
        """Send the initial message. Wraps the bot SDK to keep tests trivial.

        Sent as plain text — see the rationale in ``_push_update``.
        """
        send = getattr(self._bot, "send_message", None)
        if send is None:
            raise RuntimeError("StreamingTextClient: bot has no send_message method")
        return await send(chat_id=self._chat_id, text=text)

    async def _push_update(self, text: str) -> Any:
        """Push the latest body via editMessageText.

        Sent as **plain text** (no ``parse_mode``). The workshop renderer
        splices in unescaped user / tool-arg content — URLs, file paths,
        shell commands, search queries — that regularly contains
        Markdown metacharacters. Markdown parse mode here would have
        Telegram reject every such edit with ``can't parse entities``
        and the workshop would stop rendering. Plain text avoids this
        class of failure entirely. The renderer keeps visual hierarchy
        via emoji + bracket-decorated headers.

        When the Bot API native streaming-text method is pinned (spec
        §22 Q1), swap this implementation; keep the rate-limit +
        degraded fallback logic intact for spec §15.6.
        """
        edit = getattr(self._bot, "edit_message_text", None)
        if edit is None:
            raise RuntimeError("StreamingTextClient: bot has no edit_message_text method")
        return await edit(
            chat_id=self._chat_id,
            message_id=self._message_id,
            text=text,
        )

    @staticmethod
    def _extract_message_id(sent: Any) -> int | None:
        if sent is None:
            return None
        if isinstance(sent, dict):
            return sent.get("message_id")
        return getattr(sent, "message_id", None)


__all__ = ["StreamingTextClient"]
