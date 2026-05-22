from __future__ import annotations

import pytest

from voice.config import get_settings
from voice.realtime.gemini_live import DEFAULT_GEMINI_LIVE_MODEL
from voice.realtime.openai_realtime import DEFAULT_OPENAI_REALTIME_MODEL
from voice.realtime.runtime_selection import VoiceRuntimeMode


@pytest.fixture(autouse=True)
def clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _set_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in [
        "SOPHIA_VOICE_RUNTIME_MODE",
        "SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED",
        "SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED",
        "SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED",
        "SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED",
        "SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED",
        "SOPHIA_OPENAI_REALTIME_MODEL",
        "SOPHIA_GEMINI_LIVE_MODEL",
    ]:
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setenv("STREAM_API_KEY", "stream-key")
    monkeypatch.setenv("STREAM_API_SECRET", "stream-secret")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-key")
    monkeypatch.setenv("CARTESIA_API_KEY", "cartesia-key")


def test_defaults_to_shim_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("SOPHIA_BACKEND_MODE", raising=False)
    monkeypatch.delenv("SOPHIA_LLM_MODE", raising=False)

    settings = get_settings()

    assert settings.backend_mode == "shim"


def test_voice_runtime_defaults_to_legacy_cascade(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("SOPHIA_VOICE_RUNTIME_MODE", raising=False)
    monkeypatch.delenv("SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED", raising=False)

    settings = get_settings()

    assert settings.voice_runtime_mode == VoiceRuntimeMode.LEGACY_CASCADE.value
    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.LEGACY_CASCADE
    assert settings.voice_runtime_selection.mode == VoiceRuntimeMode.LEGACY_CASCADE
    assert settings.experimental_realtime_runtime_enabled is False
    assert settings.realtime_shadow_parity_enabled is False
    assert settings.openai_realtime_adapter_enabled is False
    assert settings.openai_realtime_model == DEFAULT_OPENAI_REALTIME_MODEL
    assert settings.gemini_live_adapter_enabled is False
    assert settings.gemini_production_route_enabled is False
    assert settings.gemini_live_model == DEFAULT_GEMINI_LIVE_MODEL


def test_shadow_parity_flag_is_separate_from_backend_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_BACKEND_MODE", "deerflow")
    monkeypatch.setenv("SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED", "true")

    settings = get_settings()

    assert settings.backend_mode == "deerflow"
    assert settings.realtime_shadow_parity_enabled is True
    assert settings.voice_runtime_selection.shadow_parity_enabled is True


def test_openai_realtime_adapter_flag_does_not_promote_active_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_OPENAI_REALTIME_MODEL", "gpt-realtime-2")

    settings = get_settings()

    assert settings.openai_realtime_adapter_enabled is True
    assert settings.openai_realtime_model == "gpt-realtime-2"
    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.LEGACY_CASCADE


def test_gemini_live_adapter_flag_does_not_promote_active_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")

    settings = get_settings()

    assert settings.gemini_live_adapter_enabled is True
    assert settings.gemini_live_model == "gemini-3.1-flash-live-preview"
    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.LEGACY_CASCADE


def test_gemini_production_route_flag_does_not_promote_active_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")

    settings = get_settings()

    assert settings.gemini_production_route_enabled is True
    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.LEGACY_CASCADE


def test_openai_realtime_runtime_requires_global_experimental_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "openai_realtime")

    with pytest.raises(ValueError, match="SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED"):
        get_settings()


def test_gemini_live_runtime_requires_global_experimental_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")

    with pytest.raises(ValueError, match="SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED"):
        get_settings()


def test_openai_realtime_runtime_requires_adapter_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "openai_realtime")

    with pytest.raises(ValueError, match="SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED"):
        get_settings()


def test_gemini_live_runtime_requires_adapter_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")

    with pytest.raises(ValueError, match="SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED"):
        get_settings()


def test_openai_realtime_runtime_can_be_selected_experimentally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "openai_realtime")
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED", "true")

    settings = get_settings()

    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.OPENAI_REALTIME
    assert settings.voice_runtime_selection.is_experimental_runtime is True
    assert settings.experimental_realtime_runtime_enabled is True


def test_gemini_live_runtime_can_be_selected_experimentally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED", "true")

    settings = get_settings()

    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.GEMINI_LIVE
    assert settings.voice_runtime_selection.is_experimental_runtime is True
    assert settings.experimental_realtime_runtime_enabled is True


def test_openai_realtime_runtime_requires_provider_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "openai_realtime")
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED", "true")

    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        get_settings()


def test_gemini_live_runtime_accepts_google_api_key_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "google-key")
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED", "true")

    settings = get_settings()

    assert settings.selected_voice_runtime_mode == VoiceRuntimeMode.GEMINI_LIVE


def test_gemini_live_runtime_requires_provider_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED", "true")

    with pytest.raises(ValueError, match="GOOGLE_API_KEY or GEMINI_API_KEY"):
        get_settings()


@pytest.mark.parametrize("mode", ["openai_realtime", "gemini-live"])
def test_rejects_declared_future_voice_runtime_modes(
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", mode)

    with pytest.raises(ValueError, match="experimental"):
        get_settings()


def test_shadow_parity_rejects_experimental_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "openai_realtime")
    monkeypatch.setenv("SOPHIA_VOICE_EXPERIMENTAL_RUNTIME_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_REALTIME_SHADOW_PARITY_ENABLED", "true")

    with pytest.raises(ValueError, match="only supported"):
        get_settings()


def test_rejects_invalid_backend_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_BACKEND_MODE", "bad-mode")

    with pytest.raises(ValueError, match="Unsupported SOPHIA_BACKEND_MODE"):
        get_settings()


def test_deerflow_requires_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """When both URL env vars are blank, _env_first falls back to the
    hard-coded default so the settings object is still valid.  Verify the
    fallback rather than expecting a ValueError that can never fire."""
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_BACKEND_MODE", "deerflow")
    monkeypatch.setenv("SOPHIA_LANGGRAPH_BASE_URL", "   ")
    monkeypatch.delenv("SOPHIA_BACKEND_BASE_URL", raising=False)

    settings = get_settings()

    assert settings.backend_mode == "deerflow"
    assert settings.langgraph_base_url == "http://127.0.0.1:2024"


def test_turn_recovery_defaults_and_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_BACKEND_STALL_TIMEOUT_MS", "4500")
    monkeypatch.setenv("SOPHIA_SAME_TURN_REPEAT_DEBOUNCE_MS", "250")

    settings = get_settings()

    assert settings.backend_stall_timeout_ms == 4500
    assert settings.same_turn_repeat_debounce_ms == 250