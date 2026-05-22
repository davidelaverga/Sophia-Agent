from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from voice.realtime.capabilities import ProviderCapabilities
from voice.realtime.events import ProviderEvent


class RealtimeProviderSession(Protocol):
    """Provider-owned realtime session boundary.

    Implementations may be backed by a native realtime API, the current cascade,
    or a fixture. They emit normalized ProviderEvent values and never public
    browser-facing sophia.* envelopes directly.
    """

    @property
    def provider_name(self) -> str:
        """Stable provider label for diagnostics."""
        ...

    @property
    def capabilities(self) -> ProviderCapabilities:
        """Feature descriptor for this session."""
        ...

    async def configure(self, config: dict[str, object]) -> None:
        """Apply provider/session settings before or during a call."""
        ...

    async def send_audio(self, chunk: bytes) -> None:
        """Send audio input to the provider when the provider owns audio ingress."""
        ...

    async def send_text(self, text: str) -> None:
        """Send text input to the provider when the caller already has text."""
        ...

    async def send_tool_result(
        self,
        tool_call_id: str,
        result: dict[str, object],
    ) -> None:
        """Return a structured tool result to the provider."""
        ...

    async def cancel_response(self, reason: str | None = None) -> None:
        """Cancel or interrupt the active provider response."""
        ...

    async def events(self) -> AsyncIterator[ProviderEvent]:
        """Yield normalized realtime provider events."""
        ...

    async def close(self) -> None:
        """Close sockets, media sessions, and provider resources."""
        ...