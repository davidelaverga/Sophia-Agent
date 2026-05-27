from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from voice.realtime.contracts import RealtimeProviderSession
from voice.realtime.events import ProviderEvent
from voice.realtime.gemini_live import (
    DEFAULT_GEMINI_LIVE_MODEL,
    GeminiLiveProviderSession,
)
from voice.realtime.legacy_cascade import LegacyCascadeProviderSession
from voice.realtime.normalizer import ArtifactValidator, SophiaEventNormalizer
from voice.realtime.openai_realtime import (
    DEFAULT_OPENAI_REALTIME_MODEL,
    OpenAIRealtimeProviderSession,
)
from voice.realtime.runtime import SophiaRealtimeTurnRuntime
from voice.realtime.runtime_selection import (
    VoiceRuntimeMode,
    VoiceRuntimeSelection,
    build_voice_runtime_selection,
)


RealtimeSender = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class RealtimeRuntimeFactoryConfig:
    mode: str | VoiceRuntimeMode | None = VoiceRuntimeMode.LEGACY_CASCADE
    shadow_parity_enabled: bool = False
    experimental_runtime_enabled: bool = False
    openai_realtime_adapter_enabled: bool = False
    openai_realtime_model: str = DEFAULT_OPENAI_REALTIME_MODEL
    gemini_live_adapter_enabled: bool = False
    gemini_live_model: str = DEFAULT_GEMINI_LIVE_MODEL
    session_id: str | None = None

    @classmethod
    def from_settings(cls, settings: object) -> "RealtimeRuntimeFactoryConfig":
        return cls(
            mode=getattr(settings, "voice_runtime_mode", VoiceRuntimeMode.LEGACY_CASCADE),
            shadow_parity_enabled=bool(
                getattr(settings, "realtime_shadow_parity_enabled", False)
            ),
            experimental_runtime_enabled=bool(
                getattr(settings, "experimental_realtime_runtime_enabled", False)
            ),
            openai_realtime_adapter_enabled=bool(
                getattr(settings, "openai_realtime_adapter_enabled", False)
            ),
            openai_realtime_model=str(
                getattr(settings, "openai_realtime_model", DEFAULT_OPENAI_REALTIME_MODEL)
            ),
            gemini_live_adapter_enabled=bool(
                getattr(settings, "gemini_live_adapter_enabled", False)
            ),
            gemini_live_model=str(
                getattr(settings, "gemini_live_model", DEFAULT_GEMINI_LIVE_MODEL)
            ),
        )


@dataclass(frozen=True)
class RealtimeRuntimeBundle:
    selection: VoiceRuntimeSelection
    provider_session: RealtimeProviderSession
    runtime: SophiaRealtimeTurnRuntime


def resolve_voice_runtime_selection(
    config: RealtimeRuntimeFactoryConfig,
) -> VoiceRuntimeSelection:
    return build_voice_runtime_selection(
        mode=config.mode,
        shadow_parity_enabled=config.shadow_parity_enabled,
        experimental_runtime_enabled=config.experimental_runtime_enabled,
        openai_realtime_adapter_enabled=config.openai_realtime_adapter_enabled,
        gemini_live_adapter_enabled=config.gemini_live_adapter_enabled,
    )


def build_realtime_provider_session(
    config: RealtimeRuntimeFactoryConfig,
    *,
    raw_events: Any = None,
    provider_events: Iterable[ProviderEvent] | None = None,
    sender: RealtimeSender | None = None,
) -> RealtimeProviderSession:
    selection = resolve_voice_runtime_selection(config)

    if selection.mode == VoiceRuntimeMode.LEGACY_CASCADE:
        return LegacyCascadeProviderSession(list(provider_events or ()))

    if selection.mode == VoiceRuntimeMode.OPENAI_REALTIME:
        return OpenAIRealtimeProviderSession(
            raw_events,
            sender=sender,
            session_id=config.session_id,
            model=config.openai_realtime_model,
            feature_enabled=config.openai_realtime_adapter_enabled,
        )

    if selection.mode == VoiceRuntimeMode.GEMINI_LIVE:
        return GeminiLiveProviderSession(
            raw_events,
            sender=sender,
            session_id=config.session_id,
            model=config.gemini_live_model,
            feature_enabled=config.gemini_live_adapter_enabled,
        )

    raise ValueError(f"Unsupported voice runtime mode: {selection.mode!r}")


def build_realtime_runtime_bundle(
    config: RealtimeRuntimeFactoryConfig,
    *,
    raw_events: Any = None,
    provider_events: Iterable[ProviderEvent] | None = None,
    sender: RealtimeSender | None = None,
    artifact_validator: ArtifactValidator | None = None,
) -> RealtimeRuntimeBundle:
    selection = resolve_voice_runtime_selection(config)
    provider_session = build_realtime_provider_session(
        config,
        raw_events=raw_events,
        provider_events=provider_events,
        sender=sender,
    )
    runtime = SophiaRealtimeTurnRuntime(
        provider_session=provider_session,
        normalizer=SophiaEventNormalizer(artifact_validator=artifact_validator),
    )
    return RealtimeRuntimeBundle(
        selection=selection,
        provider_session=provider_session,
        runtime=runtime,
    )


def build_realtime_runtime_bundle_from_settings(
    settings: object,
    *,
    raw_events: Any = None,
    provider_events: Iterable[ProviderEvent] | None = None,
    sender: RealtimeSender | None = None,
    artifact_validator: ArtifactValidator | None = None,
) -> RealtimeRuntimeBundle:
    return build_realtime_runtime_bundle(
        RealtimeRuntimeFactoryConfig.from_settings(settings),
        raw_events=raw_events,
        provider_events=provider_events,
        sender=sender,
        artifact_validator=artifact_validator,
    )