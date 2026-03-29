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

    settings = get_settings()

    assert settings.backend_mode == "shim"


def test_rejects_invalid_backend_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_BACKEND_MODE", "bad-mode")

    with pytest.raises(ValueError, match="Unsupported SOPHIA_BACKEND_MODE"):
        get_settings()


def test_deerflow_requires_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SOPHIA_BACKEND_MODE", "deerflow")
    monkeypatch.setenv("SOPHIA_LANGGRAPH_BASE_URL", "   ")

    with pytest.raises(ValueError, match="SOPHIA_LANGGRAPH_BASE_URL"):
        get_settings()