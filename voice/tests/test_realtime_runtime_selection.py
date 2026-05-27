from __future__ import annotations

import pytest

from voice.realtime.runtime_selection import (
    DEFAULT_ACTIVE_RUNTIME_MODES,
    EXPERIMENTAL_ACTIVE_RUNTIME_MODES,
    IMPLEMENTED_ACTIVE_RUNTIME_MODES,
    IMPLEMENTED_PROVIDER_ADAPTER_MODES,
    VoiceRuntimeMode,
    build_voice_runtime_selection,
    parse_voice_runtime_mode,
    validate_active_voice_runtime_mode,
)


def test_parse_voice_runtime_mode_accepts_legacy_alias_shapes() -> None:
    assert parse_voice_runtime_mode(None) == VoiceRuntimeMode.LEGACY_CASCADE
    assert parse_voice_runtime_mode("legacy-cascade") == VoiceRuntimeMode.LEGACY_CASCADE
    assert parse_voice_runtime_mode(" LEGACY_CASCADE ") == VoiceRuntimeMode.LEGACY_CASCADE


def test_declared_future_modes_parse_but_are_not_active_runtimes() -> None:
    assert parse_voice_runtime_mode("openai_realtime") == VoiceRuntimeMode.OPENAI_REALTIME
    assert parse_voice_runtime_mode("gemini-live") == VoiceRuntimeMode.GEMINI_LIVE

    with pytest.raises(ValueError, match="experimental"):
        validate_active_voice_runtime_mode(VoiceRuntimeMode.OPENAI_REALTIME)


def test_experimental_modes_require_matching_double_opt_in() -> None:
    with pytest.raises(ValueError, match="SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED"):
        validate_active_voice_runtime_mode(
            VoiceRuntimeMode.OPENAI_REALTIME,
            openai_realtime_adapter_enabled=True,
        )

    with pytest.raises(ValueError, match="SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED"):
        validate_active_voice_runtime_mode(
            VoiceRuntimeMode.OPENAI_REALTIME,
            experimental_runtime_enabled=True,
        )

    with pytest.raises(ValueError, match="SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED"):
        validate_active_voice_runtime_mode(
            VoiceRuntimeMode.GEMINI_LIVE,
            experimental_runtime_enabled=True,
        )


def test_experimental_modes_validate_with_global_and_provider_flags() -> None:
    assert (
        validate_active_voice_runtime_mode(
            VoiceRuntimeMode.OPENAI_REALTIME,
            experimental_runtime_enabled=True,
            openai_realtime_adapter_enabled=True,
        )
        == VoiceRuntimeMode.OPENAI_REALTIME
    )
    assert (
        validate_active_voice_runtime_mode(
            VoiceRuntimeMode.GEMINI_LIVE,
            experimental_runtime_enabled=True,
            gemini_live_adapter_enabled=True,
        )
        == VoiceRuntimeMode.GEMINI_LIVE
    )


def test_build_voice_runtime_selection_keeps_shadow_flag_on_legacy() -> None:
    selection = build_voice_runtime_selection(
        mode="legacy_cascade",
        shadow_parity_enabled=True,
    )

    assert selection.mode == VoiceRuntimeMode.LEGACY_CASCADE
    assert selection.shadow_parity_enabled is True
    assert selection.is_experimental_runtime is False
    assert selection.is_implemented_active_runtime is True
    assert DEFAULT_ACTIVE_RUNTIME_MODES == frozenset({VoiceRuntimeMode.LEGACY_CASCADE})
    assert EXPERIMENTAL_ACTIVE_RUNTIME_MODES == frozenset(
        {
            VoiceRuntimeMode.OPENAI_REALTIME,
            VoiceRuntimeMode.GEMINI_LIVE,
        }
    )
    assert IMPLEMENTED_ACTIVE_RUNTIME_MODES == frozenset(
        {
            VoiceRuntimeMode.LEGACY_CASCADE,
            VoiceRuntimeMode.OPENAI_REALTIME,
            VoiceRuntimeMode.GEMINI_LIVE,
        }
    )
    assert IMPLEMENTED_PROVIDER_ADAPTER_MODES == frozenset(
        {
            VoiceRuntimeMode.LEGACY_CASCADE,
            VoiceRuntimeMode.OPENAI_REALTIME,
            VoiceRuntimeMode.GEMINI_LIVE,
        }
    )


def test_build_voice_runtime_selection_accepts_experimental_runtime() -> None:
    selection = build_voice_runtime_selection(
        mode="openai_realtime",
        experimental_runtime_enabled=True,
        openai_realtime_adapter_enabled=True,
    )

    assert selection.mode == VoiceRuntimeMode.OPENAI_REALTIME
    assert selection.is_experimental_runtime is True
    assert selection.experimental_runtime_enabled is True
    assert selection.openai_realtime_adapter_enabled is True
    assert selection.is_implemented_active_runtime is True


def test_shadow_parity_is_legacy_only() -> None:
    with pytest.raises(ValueError, match="only supported"):
        build_voice_runtime_selection(
            mode="gemini_live",
            shadow_parity_enabled=True,
            experimental_runtime_enabled=True,
            gemini_live_adapter_enabled=True,
        )


def test_parse_voice_runtime_mode_rejects_unknown_values() -> None:
    with pytest.raises(ValueError, match="Unsupported SOPHIA_VOICE_RUNTIME_MODE"):
        parse_voice_runtime_mode("not-a-provider")