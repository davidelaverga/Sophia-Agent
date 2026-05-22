from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class VoiceRuntimeMode(StrEnum):
    LEGACY_CASCADE = "legacy_cascade"
    OPENAI_REALTIME = "openai_realtime"
    GEMINI_LIVE = "gemini_live"


EXPERIMENTAL_RUNTIME_FEATURE_FLAG = "SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED"
OPENAI_REALTIME_ADAPTER_FEATURE_FLAG = "SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED"
GEMINI_LIVE_ADAPTER_FEATURE_FLAG = "SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED"
GEMINI_PRODUCTION_ROUTE_FEATURE_FLAG = "SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED"

DEFAULT_ACTIVE_RUNTIME_MODES = frozenset({VoiceRuntimeMode.LEGACY_CASCADE})
EXPERIMENTAL_ACTIVE_RUNTIME_MODES = frozenset(
    {
        VoiceRuntimeMode.OPENAI_REALTIME,
        VoiceRuntimeMode.GEMINI_LIVE,
    }
)
IMPLEMENTED_ACTIVE_RUNTIME_MODES = frozenset(
    DEFAULT_ACTIVE_RUNTIME_MODES | EXPERIMENTAL_ACTIVE_RUNTIME_MODES
)
IMPLEMENTED_PROVIDER_ADAPTER_MODES = frozenset(
    {
        VoiceRuntimeMode.LEGACY_CASCADE,
        VoiceRuntimeMode.OPENAI_REALTIME,
        VoiceRuntimeMode.GEMINI_LIVE,
    }
)


@dataclass(frozen=True)
class VoiceRuntimeSelection:
    mode: VoiceRuntimeMode
    shadow_parity_enabled: bool = False
    experimental_runtime_enabled: bool = False
    openai_realtime_adapter_enabled: bool = False
    gemini_live_adapter_enabled: bool = False

    @property
    def is_experimental_runtime(self) -> bool:
        return self.mode in EXPERIMENTAL_ACTIVE_RUNTIME_MODES

    @property
    def is_implemented_active_runtime(self) -> bool:
        return self.mode in IMPLEMENTED_ACTIVE_RUNTIME_MODES


def parse_voice_runtime_mode(value: str | VoiceRuntimeMode | None) -> VoiceRuntimeMode:
    if value is None:
        return VoiceRuntimeMode.LEGACY_CASCADE
    if isinstance(value, VoiceRuntimeMode):
        return value

    normalized = value.strip().lower().replace("-", "_")
    try:
        return VoiceRuntimeMode(normalized)
    except ValueError as exc:
        supported = ", ".join(mode.value for mode in VoiceRuntimeMode)
        raise ValueError(
            f"Unsupported SOPHIA_VOICE_RUNTIME_MODE={value!r}. "
            f"Use one of: {supported}."
        ) from exc


def validate_active_voice_runtime_mode(
    value: str | VoiceRuntimeMode | None,
    *,
    experimental_runtime_enabled: bool = False,
    openai_realtime_adapter_enabled: bool = False,
    gemini_live_adapter_enabled: bool = False,
    shadow_parity_enabled: bool = False,
) -> VoiceRuntimeMode:
    mode = parse_voice_runtime_mode(value)
    if mode in DEFAULT_ACTIVE_RUNTIME_MODES:
        return mode

    if mode not in EXPERIMENTAL_ACTIVE_RUNTIME_MODES:
        implemented = ", ".join(mode.value for mode in IMPLEMENTED_ACTIVE_RUNTIME_MODES)
        raise ValueError(
            f"SOPHIA_VOICE_RUNTIME_MODE={mode.value!r} is not implemented as "
            f"an active voice runtime. Use one of: {implemented}."
        )

    if shadow_parity_enabled:
        raise ValueError(
            "SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED is only supported "
            "with SOPHIA_VOICE_RUNTIME_MODE='legacy_cascade'."
        )

    if not experimental_runtime_enabled:
        raise ValueError(
            f"SOPHIA_VOICE_RUNTIME_MODE={mode.value!r} is experimental. Set "
            f"{EXPERIMENTAL_RUNTIME_FEATURE_FLAG}=true and the provider "
            "adapter flag before activating it."
        )

    required_adapter_flag = {
        VoiceRuntimeMode.OPENAI_REALTIME: (
            OPENAI_REALTIME_ADAPTER_FEATURE_FLAG,
            openai_realtime_adapter_enabled,
        ),
        VoiceRuntimeMode.GEMINI_LIVE: (
            GEMINI_LIVE_ADAPTER_FEATURE_FLAG,
            gemini_live_adapter_enabled,
        ),
    }[mode]
    flag_name, flag_enabled = required_adapter_flag
    if not flag_enabled:
        raise ValueError(
            f"SOPHIA_VOICE_RUNTIME_MODE={mode.value!r} requires "
            f"{flag_name}=true. The adapter flag is separate from the "
            "experimental runtime activation flag."
        )

    return mode


def build_voice_runtime_selection(
    *,
    mode: str | VoiceRuntimeMode | None,
    shadow_parity_enabled: bool = False,
    experimental_runtime_enabled: bool = False,
    openai_realtime_adapter_enabled: bool = False,
    gemini_live_adapter_enabled: bool = False,
) -> VoiceRuntimeSelection:
    selected_mode = validate_active_voice_runtime_mode(
        mode,
        experimental_runtime_enabled=experimental_runtime_enabled,
        openai_realtime_adapter_enabled=openai_realtime_adapter_enabled,
        gemini_live_adapter_enabled=gemini_live_adapter_enabled,
        shadow_parity_enabled=shadow_parity_enabled,
    )
    return VoiceRuntimeSelection(
        mode=selected_mode,
        shadow_parity_enabled=shadow_parity_enabled,
        experimental_runtime_enabled=experimental_runtime_enabled,
        openai_realtime_adapter_enabled=openai_realtime_adapter_enabled,
        gemini_live_adapter_enabled=gemini_live_adapter_enabled,
    )