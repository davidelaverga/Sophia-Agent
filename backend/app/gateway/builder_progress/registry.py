"""Per-process registry mapping builder task_id → placeholder anchor + renderer.

The flow (PR #126 Phase 4H — webhook relay):

1. Manager publishes a "Working on it…" placeholder with metadata
   ``{"builder_progress": {"task_id", "run_id", "user_id"}}``.
2. ``TelegramChannel.send`` sends the placeholder, captures the
   resulting ``message_id``, and calls
   ``registry.register_task(task_id, chat_id, message_id, channel)``.
3. The builder's ``BuilderProgressMiddleware`` (runs in the langgraph
   service process) POSTs phase events to
   ``/internal/builder-progress``.
4. The endpoint calls ``registry.apply_event(task_id, ...)``.
5. The registry's per-task ``ProgressRenderer`` consumes the event
   and produces a new placeholder body.
6. If the body changed, the registry invokes the channel's edit
   callback to push the new body via ``bot.edit_message_text``.
7. On terminal (``_on_builder_completion`` artifact delivery), the
   channel calls ``registry.unregister_task(task_id)``.

The architecture deliberately doesn't use ``runs.join_stream``:
``langgraph dev``'s in-mem runtime doesn't deliver buffered events
to late-joining HTTP subscribers across processes (verified in
production smoke tests 2026-05-16/17). The webhook is fired
synchronously from inside the builder's run, so the gateway sees
events as they happen — no replay needed.

Channels register an async edit callback at start-up via
``register_channel_callback(channel_name, callback)``. The callback
signature is ``(chat_id, message_id, body) -> None`` (async). On each
state change the registry invokes the callback. Telegram's callback
hops to ``_tg_loop`` to keep PTB bot calls loop-affine (learning
#14 in the v3 migration plan).
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from itertools import islice
from typing import Any

from app.channels.telegram_progress_renderer import ProgressRenderer

logger = logging.getLogger(__name__)


# Bound the registry so a leak (terminal webhook never fires for a
# task) can't consume unbounded memory. The trim path drops the
# OLDEST entries (FIFO via dict iteration order) when we exceed the
# cap. 1024 active builds is way beyond realistic concurrent load.
_CAP = 1024
_TRIM_TARGET = 768  # keep ~75% on overflow


# Type alias for the per-channel edit callback. Channels register one
# of these for their channel_name; the registry invokes it on every
# placeholder-body change.
EditCallback = Callable[[int, int, str], Awaitable[None]]


@dataclass
class BuilderProgressEntry:
    """Per-task placeholder anchor + renderer."""

    chat_id: int
    message_id: int
    channel_name: str
    renderer: ProgressRenderer = field(default_factory=ProgressRenderer)
    # Last-pushed body so we can avoid no-op edits.
    last_pushed_body: str = ""


class BuilderProgressRegistry:
    """In-memory registry of active builder-progress placeholders.

    Singleton-per-process. Access via :func:`get_progress_registry`.
    """

    def __init__(self) -> None:
        # Insertion order matters for FIFO trim — use ``dict`` not
        # ``set`` (CPython 3.7+ language spec guarantees insertion
        # order for dict iteration).
        self._entries: dict[str, BuilderProgressEntry] = {}
        self._callbacks: dict[str, EditCallback] = {}
        # Protect registration / lookup against concurrent access
        # from the HTTP endpoint coroutine + channel send coroutine.
        # All operations are short (dict ops + a callback await
        # outside the lock), so a single threading.Lock is fine.
        self._lock = threading.Lock()

    # -- channel-side wiring ------------------------------------------------

    def register_channel_callback(
        self, channel_name: str, callback: EditCallback
    ) -> None:
        """Register an async function that edits a placeholder body.

        Signature: ``async def cb(chat_id, message_id, body)``.

        Each channel calls this once on start. The registry invokes
        the callback on every placeholder-body change for tasks
        registered with that ``channel_name``.
        """
        with self._lock:
            self._callbacks[channel_name] = callback
        logger.info(
            "[BuilderProgress] channel callback registered channel=%s",
            channel_name,
        )

    def unregister_channel_callback(self, channel_name: str) -> None:
        with self._lock:
            self._callbacks.pop(channel_name, None)

    # -- task-side wiring ---------------------------------------------------

    def register_task(
        self,
        *,
        task_id: str,
        chat_id: int,
        message_id: int,
        channel_name: str,
    ) -> None:
        """Bind a task_id to its placeholder anchor.

        Called from ``TelegramChannel.send`` after the placeholder
        message lands and we have its ``message_id``. The renderer
        starts at the ``starting`` phase by default (matches the
        placeholder text "Working on it…").
        """
        with self._lock:
            self._entries[str(task_id)] = BuilderProgressEntry(
                chat_id=chat_id,
                message_id=message_id,
                channel_name=channel_name,
            )
            self._trim_locked()
        logger.info(
            "[BuilderProgress] task registered task_id=%s chat_id=%s message_id=%s channel=%s",
            task_id,
            chat_id,
            message_id,
            channel_name,
        )

    def unregister_task(self, task_id: str) -> None:
        """Drop a task's entry. Called from ``_on_builder_completion``."""
        with self._lock:
            popped = self._entries.pop(str(task_id), None)
        if popped is not None:
            logger.info(
                "[BuilderProgress] task unregistered task_id=%s", task_id
            )

    def has_task(self, task_id: str) -> bool:
        with self._lock:
            return str(task_id) in self._entries

    # -- event dispatch -----------------------------------------------------

    async def apply_event(
        self,
        *,
        task_id: str,
        event_name: str,
        data: Any,
    ) -> bool:
        """Apply one progress event to the per-task renderer + push edit.

        ``event_name`` matches the renderer's ``apply`` API:
        ``"messages"``, ``"updates"``, ``"custom"``. ``data`` is the
        payload for that mode.

        Returns ``True`` when an edit was attempted (state changed
        AND a channel callback is registered AND the body actually
        differs from the last pushed body). Returns ``False`` for
        any short-circuit (unknown task / unchanged state /
        unregistered channel) so the endpoint can report visibility.
        """
        task_key = str(task_id)
        with self._lock:
            entry = self._entries.get(task_key)
            callback = self._callbacks.get(entry.channel_name) if entry else None
        if entry is None:
            # Common case: middleware fired ``starting`` before the
            # channel registered. We drop silently — the placeholder
            # text already says "Working on it…" which IS the
            # starting state.
            logger.debug(
                "[BuilderProgress] apply_event dropped — no entry for task_id=%s event=%s",
                task_id,
                event_name,
            )
            return False
        result = entry.renderer.apply(event_name, data)
        if not result.state_changed:
            return False
        body = entry.renderer.render()
        if not body or body == entry.last_pushed_body:
            return False
        if callback is None:
            logger.warning(
                "[BuilderProgress] no edit callback for channel=%s task_id=%s — dropping update",
                entry.channel_name,
                task_id,
            )
            return False
        # Cache the body BEFORE we invoke the callback so a slow /
        # failing callback can't cause us to retry the same edit on
        # back-to-back events.
        entry.last_pushed_body = body
        try:
            await callback(entry.chat_id, entry.message_id, body)
        except Exception:
            logger.warning(
                "[BuilderProgress] edit callback raised channel=%s task_id=%s",
                entry.channel_name,
                task_id,
                exc_info=True,
            )
            return False
        return True

    async def mark_done(self, *, task_id: str, summary: str = "") -> bool:
        """Finalize the placeholder as ``[ Done ]`` and unregister.

        Called from ``_on_builder_completion`` when the artifact
        delivery webhook fires. The placeholder body transforms to
        the done header + optional summary; the entry is then
        dropped so future webhooks for the same task_id are no-ops.
        """
        task_key = str(task_id)
        with self._lock:
            entry = self._entries.get(task_key)
            callback = self._callbacks.get(entry.channel_name) if entry else None
        if entry is None:
            return False
        entry.renderer.mark_done(summary=summary)
        body = entry.renderer.render()
        if callback is not None and body and body != entry.last_pushed_body:
            entry.last_pushed_body = body
            try:
                await callback(entry.chat_id, entry.message_id, body)
            except Exception:
                logger.warning(
                    "[BuilderProgress] mark_done edit raised channel=%s task_id=%s",
                    entry.channel_name,
                    task_id,
                    exc_info=True,
                )
        self.unregister_task(task_id)
        return True

    # -- internals ----------------------------------------------------------

    def _trim_locked(self) -> None:
        """Drop the oldest entries when we exceed the cap. Caller holds lock."""
        if len(self._entries) <= _CAP:
            return
        to_drop = len(self._entries) - _TRIM_TARGET
        stale_keys = list(islice(self._entries, to_drop))
        for k in stale_keys:
            self._entries.pop(k, None)
        logger.warning(
            "[BuilderProgress] trimmed registry — evicted %d oldest entries (size=%d → %d)",
            to_drop,
            _CAP,
            len(self._entries),
        )


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------


_registry: BuilderProgressRegistry | None = None


def get_progress_registry() -> BuilderProgressRegistry:
    """Return the process-wide registry (lazy-init)."""
    global _registry
    if _registry is None:
        _registry = BuilderProgressRegistry()
    return _registry


def reset_for_tests() -> None:
    """Drop the singleton — test-only helper."""
    global _registry
    _registry = None


# Suppress unused-import warning for asyncio (referenced in callback
# typing & docstrings, kept available for downstream consumers).
_ = asyncio
