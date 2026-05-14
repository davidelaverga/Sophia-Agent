"""CompanionAwarenessSink — feed builder events to companion's next turn.

Writes to ``CompanionContextStore`` so the companion's
``BuildAwarenessMiddleware`` can render an awareness block on the next
turn without invoking ``check_async_task``. Always-active across all
channel origins.

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.3.
"""

from __future__ import annotations

import logging

from app.gateway.builder_events.companion_context_store import CompanionContextStore
from app.gateway.builder_events.sinks.base import BuilderEventSink
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


class CompanionAwarenessSink(BuilderEventSink):
    """Forward events to the in-memory companion-context store."""

    name = "companion_awareness"

    def __init__(self, store: CompanionContextStore) -> None:
        self._store = store

    async def accepts(self, event: BuilderEvent) -> bool:  # noqa: ARG002 — always accept
        return True

    async def handle(self, event: BuilderEvent) -> None:
        try:
            await self._store.append_event(event)
        except Exception:
            logger.warning(
                "CompanionAwarenessSink: failed to append event task_id=%s type=%s",
                event.task_id,
                event.type,
                exc_info=True,
            )


__all__ = ["CompanionAwarenessSink"]
