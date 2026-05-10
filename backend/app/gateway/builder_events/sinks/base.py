"""Sink protocol for Builder event fanout."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.gateway.builder_events.types import BuilderEvent


@runtime_checkable
class BuilderEventSink(Protocol):
    """All sinks implement this protocol.

    ``accepts`` is a cheap filter run by fanout before ``handle`` to
    short-circuit on irrelevant events. ``handle`` does the work and may
    raise — the fanout isolates failures so one sink cannot block
    another.
    """

    name: str

    def accepts(self, event: BuilderEvent) -> bool: ...

    async def handle(self, event: BuilderEvent) -> None: ...
