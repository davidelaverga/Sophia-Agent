"""WorkshopTelegramSink — route events to the workshop bot's streaming reply.

The sink owns the channel-side ``WorkshopEventReceiver`` registry plus
a small **terminal-event cache** so a late-arriving receiver can still
finalize its placeholder when the builder run completes before the
receiver registers.

Why the cache: a fast builder run (e.g. demo-mode that returns
instantly) can fire its ``CompletedEvent`` BEFORE the companion turn
returns from ``runs.wait`` and the channel layer has had time to send
the placeholder + register a receiver. Without the cache the terminal
event would be dropped by the sink (no receiver at publish time) and
the placeholder would stay stuck on "Working on it…" forever — the
existing ``_on_builder_completion`` path still delivers the artifact
but the streaming UX visibly fails.

The split between gateway side and channel side stays: the gateway
side (``WorkshopTelegramSink``) is free of ``python-telegram-bot``
imports; the channel handler implements the actual ``on_event``
plumbing.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.3,
§11.5.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import OrderedDict
from typing import Protocol

from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.types import BuilderEvent, CompletedEvent

logger = logging.getLogger(__name__)


# How many uncollected terminal events to keep around. Real production
# rate is well below this (one terminal per task, infrequent), but the
# cap prevents an unbounded leak if receivers consistently fail to
# register (e.g. workshop bot disabled while builder fires terminals).
_TERMINAL_CACHE_MAX = 256


class WorkshopEventReceiver(Protocol):
    """Channel-side hook implemented by the workshop handler.

    The workshop handler registers itself with the sink for each task it
    is actively rendering. The sink calls :meth:`on_event` for accepted
    events and unregisters on the terminal event.
    """

    async def on_event(self, event: BuilderEvent) -> None: ...


class WorkshopTelegramSink(BuilderEventSink):
    """Telegram-only sink that fans events to an open workshop reply.

    Thread safety: ``_receivers`` / ``_terminal_cache`` / ``_replay_tasks``
    can be touched from multiple execution contexts — the fanout's
    ``handle()`` runs on the gateway main async loop, while
    ``register_workshop`` / ``unregister_workshop`` can be invoked from
    the workshop bot's polling-thread loop (when the workshop bot is
    re-enabled in a future spec). A ``threading.Lock`` guards every
    mutation. Critical sections never await — they only manipulate the
    dict/OrderedDict — so the lock can't deadlock against awaited I/O.
    """

    name = "workshop_telegram"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._receivers: dict[str, WorkshopEventReceiver] = {}
        self._terminal_cache: OrderedDict[str, CompletedEvent] = OrderedDict()
        self._replay_tasks: set[asyncio.Task] = set()

    def register_workshop(self, task_id: str, receiver: WorkshopEventReceiver) -> None:
        """Bind a workshop receiver for ``task_id``.

        Called from the workshop handler after it opens a streaming
        reply. Idempotent — registering twice for the same task replaces
        the prior receiver (the second one wins, useful for retries).

        If the builder run completed BEFORE the receiver was registered
        (fast builds), the cached terminal event is replayed
        asynchronously so the receiver can still finalize its
        placeholder. The replay task is held in ``_replay_tasks`` so
        the GC can't drop it mid-run.
        """
        if not task_id:
            return
        # All mutations are guarded by ``_lock`` so cross-thread access
        # from the workshop bot's polling-thread loop (when re-enabled)
        # can't race the gateway main loop's fanout handlers.
        with self._lock:
            if task_id in self._receivers:
                logger.info("WorkshopTelegramSink: replacing existing receiver for task_id=%s", task_id)
            self._receivers[task_id] = receiver
            cached = self._terminal_cache.pop(task_id, None)

        if cached is None:
            return
        # Schedule the replay OUTSIDE the lock. ``register_workshop``
        # is sync but normally runs in an async context (bus dispatch
        # on the gateway main loop). The receiver itself bridges to
        # any other loop it needs via ``run_coroutine_threadsafe``.
        try:
            task = asyncio.create_task(self._replay_terminal(task_id, receiver, cached))
        except RuntimeError:
            # No running loop in this context (e.g. unit test calling
            # register_workshop synchronously without await). Restore
            # the cached event so a future register_workshop pass can
            # try again.
            with self._lock:
                self._terminal_cache[task_id] = cached
            logger.warning(
                "WorkshopTelegramSink: no running loop to replay cached terminal task_id=%s — left in cache",
                task_id,
            )
            return
        with self._lock:
            self._replay_tasks.add(task)
        # add_done_callback runs on the same loop that created the
        # task; the callback only needs to remove the task from the
        # set, so we wrap it with the lock for thread-safe discard.
        task.add_done_callback(self._discard_replay_task)
        logger.info(
            "WorkshopTelegramSink: replaying cached terminal to late-registered receiver task_id=%s",
            task_id,
        )

    def _discard_replay_task(self, task: asyncio.Task) -> None:
        with self._lock:
            self._replay_tasks.discard(task)

    def unregister_workshop(self, task_id: str) -> None:
        """Drop the receiver binding (workshop calls this on terminal).

        Also drops any cached terminal for this task — once the
        receiver has finalized, the cache entry is no longer useful.
        """
        with self._lock:
            self._receivers.pop(task_id, None)
            self._terminal_cache.pop(task_id, None)

    def has_receiver(self, task_id: str) -> bool:
        """Public source-of-truth check: is a progress receiver live?"""
        with self._lock:
            return task_id in self._receivers

    async def accepts(self, event: BuilderEvent) -> bool:
        if event.channel_origin != "telegram":
            return False
        # Terminal events MUST flow into the sink even without a
        # registered receiver so the cache can hold them for a
        # late-arriving registration. Mid-flight events with no
        # receiver are still dropped (caching every chunk would
        # explode memory for long builds).
        if event.type == "completed":
            return True
        with self._lock:
            return event.task_id in self._receivers

    async def handle(self, event: BuilderEvent) -> None:
        with self._lock:
            receiver = self._receivers.get(event.task_id)
        if receiver is None:
            if isinstance(event, CompletedEvent):
                with self._lock:
                    self._cache_terminal_locked(event)
            return
        # ``receiver.on_event`` may await arbitrary I/O — do not hold
        # the lock across the await. Re-entry into the sink from the
        # receiver (e.g. ``unregister_workshop``) re-acquires safely.
        try:
            await receiver.on_event(event)
        except Exception:
            logger.warning(
                "WorkshopTelegramSink: receiver raised for task_id=%s type=%s",
                event.task_id,
                event.type,
                exc_info=True,
            )

    def _cache_terminal_locked(self, event: CompletedEvent) -> None:
        """Stash a terminal event for a later-registering receiver.

        Caller MUST hold ``self._lock``. LRU-bounded; the bound is a
        leak guard for the degenerate case where receivers never
        register (workshop disabled but stream still attached, etc.).
        """
        self._terminal_cache[event.task_id] = event
        self._terminal_cache.move_to_end(event.task_id)
        while len(self._terminal_cache) > _TERMINAL_CACHE_MAX:
            self._terminal_cache.popitem(last=False)
        logger.info(
            "WorkshopTelegramSink: cached terminal event for late receiver task_id=%s",
            event.task_id,
        )

    @staticmethod
    async def _replay_terminal(
        task_id: str, receiver: WorkshopEventReceiver, event: CompletedEvent
    ) -> None:
        try:
            await receiver.on_event(event)
        except Exception:
            logger.warning(
                "WorkshopTelegramSink: replay receiver raised for task_id=%s",
                task_id,
                exc_info=True,
            )


__all__ = ["WorkshopEventReceiver", "WorkshopTelegramSink"]
