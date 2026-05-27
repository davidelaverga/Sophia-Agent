from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from voice.realtime.contracts import RealtimeProviderSession
from voice.realtime.events import SophiaEvent
from voice.realtime.normalizer import SophiaEventNormalizer

@dataclass
class SophiaRealtimeTurnRuntime:
    """Sophia-side orchestration boundary for realtime provider sessions.

    The current cascade is not wired through this in Phase 1. This class exists
    as the future owner of provider event normalization, artifact validation,
    builder routing, diagnostics, and lifecycle flow.
    """

    provider_session: RealtimeProviderSession
    normalizer: SophiaEventNormalizer

    async def public_events(self) -> AsyncIterator[SophiaEvent]:
        async for provider_event in self.provider_session.events():
            for public_event in self.normalizer.normalize_event(provider_event):
                yield public_event

    async def close(self) -> None:
        await self.provider_session.close()