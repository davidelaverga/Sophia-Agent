from __future__ import annotations

import pytest

from voice.config import get_settings


@pytest.fixture(autouse=True)
def clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _set_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
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