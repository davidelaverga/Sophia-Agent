"""Sink protocol for BuilderEventFanout — Phase 1 foundation.

A sink is a small async consumer of ``BuilderEvent``s. The fanout
fires sinks concurrently on mid-flight events and sequentially on
terminal events (so order matters: trace → awareness → workshop).

Implementations live under ``app/gateway/builder_events/sinks/``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.gateway.builder_events.types import BuilderEvent


@runtime_checkable
class BuilderEventSink(Protocol):
    """Sink contract. Sinks must be idempotent and non-blocking."""

    name: str

    async def accepts(self, event: BuilderEvent) -> bool:
        """Return True if this sink wants to receive ``event``.

        Called once per event per sink. Implementations should be
        cheap — no I/O. Use this to gate on ``channel_origin`` or
        event type.
        """
        ...

    async def handle(self, event: BuilderEvent) -> None:
        """Process the event.

        Sinks must not raise — failures should be caught and logged.
        The fanout treats sink failures as isolated: one broken sink
        does not block others.
        """
        ...


__all__ = ["BuilderEventSink"]
