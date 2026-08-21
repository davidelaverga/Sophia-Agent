from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from voice.realtime.dogfood_session import RealtimeDogfoodConfigurationError
from voice.realtime.gemini_browser_dogfood import (
    GeminiBrowserDogfoodSession,
    GeminiBrowserDogfoodSessionManager,
    GeminiRelaySourceMetadata,
    validate_gemini_browser_dogfood_settings,
)
from voice.realtime.runtime_selection import (
    GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG,
    VoiceRuntimeMode,
)
from voice.realtime.gemini_memory_context import (
    build_gemini_live_realtime_instructions_with_memory_context,
)


@dataclass(frozen=True)
class GeminiProductionBrowserSession:
    browser_session: GeminiBrowserDogfoodSession

    @property
    def session_id(self) -> str:
        return self.browser_session.dogfood_session.session_id

    def as_public_payload(self) -> dict[str, Any]:
        session_id = self.session_id
        payload = self.browser_session.as_public_payload()
        payload.update(
            {
                "runtime": VoiceRuntimeMode.GEMINI_LIVE.value,
                "voice_runtime": VoiceRuntimeMode.GEMINI_LIVE.value,
                "production_route": True,
                "browser_audio": "gemini_live_websocket_production_candidate",
                "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
                "stream_url": f"/production/realtime/gemini/sessions/{session_id}/events",
                "event_stream_url": f"/production/realtime/gemini/sessions/{session_id}/events",
                "provider_event_relay_url": (
                    "/production/realtime/gemini/browser-sessions/"
                    f"{session_id}/provider-events"
                ),
                "disconnect_url": f"/production/realtime/gemini/browser-sessions/{session_id}",
                "continuation_bootstrap_url": (
                    f"/production/realtime/gemini/browser-sessions/{session_id}/continuation-bootstrap"
                ),
                "public_event_boundary": "SophiaEventNormalizer",
            }
        )
        return payload


class GeminiProductionBrowserSessionManager:
    def __init__(self, browser_sessions: GeminiBrowserDogfoodSessionManager) -> None:
        self._browser_sessions = browser_sessions

    async def start_browser_session(
        self,
        settings: object,
        *,
        user_id: str,
        session_id: str | None = None,
        thread_id: str | None = None,
        platform: str = "voice",
        context_mode: str = "life",
        ritual: str | None = None,
        realtime_context: Mapping[str, Any] | None = None,
        preconnect_ttl_seconds: float | None = None,
        logical_session_id: str | None = None,
    ) -> GeminiProductionBrowserSession:
        validate_gemini_production_route_settings(settings)
        instructions, memory_context = build_gemini_live_realtime_instructions_with_memory_context(
            user_id=user_id,
            platform=platform,
            context_mode=context_mode,
            ritual=ritual,
            backend_context=realtime_context,
        )
        browser_session = await self._browser_sessions.start_browser_session(
            settings,
            user_id=user_id,
            session_id=session_id,
            instructions=instructions,
            memory_context_diagnostics=memory_context.diagnostics,
            context_mode=context_mode,
            memory_retrieval_config=_dynamic_memory_retrieval_config(realtime_context),
            preconnect_ttl_seconds=preconnect_ttl_seconds,
            thread_id=thread_id,
            logical_session_id=logical_session_id,
            continuation_bootstrap_url=None,
        )
        return GeminiProductionBrowserSession(browser_session=browser_session)

    async def ingest_browser_provider_event(
        self,
        settings: object,
        *,
        session_id: str,
        event: dict[str, Any],
        source_metadata: GeminiRelaySourceMetadata | None = None,
    ) -> dict[str, object]:
        validate_gemini_production_route_settings(settings)
        return await self._browser_sessions.ingest_browser_provider_event(
            settings,
            dogfood_session_id=session_id,
            event=event,
            source_metadata=source_metadata,
        )

    async def continue_browser_session(
        self,
        settings: object,
        *,
        session_id: str,
        expected_epoch: int,
        handle_present: bool,
        secret_generation: int,
    ) -> GeminiProductionBrowserSession:
        validate_gemini_production_route_settings(settings)
        browser_session = await self._browser_sessions.continue_browser_session(
            settings,
            dogfood_session_id=session_id,
            expected_epoch=expected_epoch,
            handle_present=handle_present,
            secret_generation=secret_generation,
            continuation_bootstrap_url=(
                f"/production/realtime/gemini/browser-sessions/{session_id}/continuation-bootstrap"
            ),
        )
        return GeminiProductionBrowserSession(browser_session=browser_session)

    async def close_session(
        self,
        session_id: str,
        *,
        conversation_audio: bytes | None = None,
        conversation_audio_mime_type: str = "audio/webm",
    ) -> bool:
        return await self._browser_sessions.close_session(
            session_id,
            conversation_audio=conversation_audio,
            conversation_audio_mime_type=conversation_audio_mime_type,
        )


def validate_gemini_production_route_settings(settings: object) -> None:
    selection = settings.voice_runtime_selection
    if selection.mode != VoiceRuntimeMode.GEMINI_LIVE:
        raise RealtimeDogfoodConfigurationError(
            "Gemini production voice route requires SOPHIA_VOICE_RUNTIME_MODE=gemini_live."
        )

    if not bool(getattr(settings, "gemini_production_route_enabled", False)):
        raise RealtimeDogfoodConfigurationError(
            "Gemini production voice route requires "
            f"{GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG}=true."
        )

    validate_gemini_browser_dogfood_settings(settings)


def _dynamic_memory_retrieval_config(
    realtime_context: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(realtime_context, Mapping):
        return None
    config = realtime_context.get("dynamic_memory_retrieval")
    if not isinstance(config, Mapping):
        return None
    return dict(config)
