"""WorkshopTelegramSink — route events to the workshop bot's streaming reply.

Phase 1 ships this as a no-op placeholder: it accepts events only when
``channel_origin == "telegram"`` AND a workshop streaming-message has
been opened for the task (gated by the workshop handler registering
itself via :meth:`register_workshop`). Phase 2 wires in the real
``WorkshopMessageRenderer`` + ``StreamingTextClient`` from the channel
side.

The split exists so the gateway side stays free of ``python-telegram-bot``
imports — the workshop handler implements the actual ``on_event`` plumbing.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.3,
§11.5.
"""

from __future__ import annotations

import logging
from typing import Protocol

from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


class WorkshopEventReceiver(Protocol):
    """Channel-side hook implemented by the workshop handler.

    The workshop handler registers itself with the sink for each task it
    is actively rendering. The sink calls :meth:`on_event` for accepted
    events and unregisters on the terminal event.
    """

    async def on_event(self, event: BuilderEvent) -> None: ...


class WorkshopTelegramSink(BuilderEventSink):
    """Telegram-only sink that fans events to an open workshop reply."""

    name = "workshop_telegram"

    def __init__(self) -> None:
        self._receivers: dict[str, WorkshopEventReceiver] = {}

    def register_workshop(self, task_id: str, receiver: WorkshopEventReceiver) -> None:
        """Bind a workshop receiver for ``task_id``.

        Called from the workshop handler after it opens a streaming
        reply. Idempotent — registering twice for the same task replaces
        the prior receiver (the second one wins, useful for retries).
        """
        if not task_id:
            return
        if task_id in self._receivers:
            logger.info("WorkshopTelegramSink: replacing existing receiver for task_id=%s", task_id)
        self._receivers[task_id] = receiver

    def unregister_workshop(self, task_id: str) -> None:
        """Drop the receiver binding (workshop calls this on terminal)."""
        self._receivers.pop(task_id, None)

    async def accepts(self, event: BuilderEvent) -> bool:
        if event.channel_origin != "telegram":
            return False
        return event.task_id in self._receivers

    async def handle(self, event: BuilderEvent) -> None:
        receiver = self._receivers.get(event.task_id)
        if receiver is None:
            return
        try:
            await receiver.on_event(event)
        except Exception:
            logger.warning(
                "WorkshopTelegramSink: receiver raised for task_id=%s type=%s",
                event.task_id,
                event.type,
                exc_info=True,
            )


__all__ = ["WorkshopEventReceiver", "WorkshopTelegramSink"]
