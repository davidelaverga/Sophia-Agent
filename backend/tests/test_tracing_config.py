"""Tests for deerflow.config.tracing_config."""

from __future__ import annotations

from pathlib import Path

import pytest

from deerflow.config import tracing_config as tracing_module


def _reset_tracing_cache() -> None:
    tracing_module._tracing_config = None


@pytest.fixture(autouse=True)
def _isolate_tracing_config():
    _reset_tracing_cache()
    yield
    _reset_tracing_cache()


def test_prefers_langsmith_env_names(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "smith-project")
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://smith.example.com")
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", "workspace-1")
    monkeypatch.setenv("LANGSMITH_PROJECT_UUID", "project-uuid-1")

    _reset_tracing_cache()
    cfg = tracing_module.get_tracing_config()

    assert cfg.enabled is True
    assert cfg.api_key == "lsv2_key"
    assert cfg.project == "smith-project"
    assert cfg.endpoint == "https://smith.example.com"
    assert cfg.workspace_id == "workspace-1"
    assert cfg.project_uuid == "project-uuid-1"
    assert tracing_module.is_tracing_enabled() is True


def test_strips_shell_style_quotes_from_langsmith_env_values(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "'lsv2_key'")
    monkeypatch.setenv("LANGSMITH_PROJECT", '"Sophia"')
    monkeypatch.setenv("LANGSMITH_ENDPOINT", '"https://eu.api.smith.langchain.com"')

    _reset_tracing_cache()
    cfg = tracing_module.get_tracing_config()

    assert cfg.api_key == "lsv2_key"
    assert cfg.project == "Sophia"
    assert cfg.endpoint == "https://eu.api.smith.langchain.com"


def test_falls_back_to_langchain_env_names(monkeypatch):
    monkeypatch.delenv("LANGSMITH_TRACING", raising=False)
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.delenv("LANGSMITH_PROJECT", raising=False)
    monkeypatch.delenv("LANGSMITH_ENDPOINT", raising=False)

    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    monkeypatch.setenv("LANGCHAIN_API_KEY", "legacy-key")
    monkeypatch.setenv("LANGCHAIN_PROJECT", "legacy-project")
    monkeypatch.setenv("LANGCHAIN_ENDPOINT", "https://legacy.example.com")

    _reset_tracing_cache()
    cfg = tracing_module.get_tracing_config()

    assert cfg.enabled is True
    assert cfg.api_key == "legacy-key"
    assert cfg.project == "legacy-project"
    assert cfg.endpoint == "https://legacy.example.com"
    assert tracing_module.is_tracing_enabled() is True


def test_langsmith_tracing_false_overrides_langchain_tracing_v2_true(monkeypatch):
    """LANGSMITH_TRACING=false must win over LANGCHAIN_TRACING_V2=true."""
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "some-key")

    _reset_tracing_cache()
    cfg = tracing_module.get_tracing_config()

    assert cfg.enabled is False
    assert tracing_module.is_tracing_enabled() is False


def test_defaults_when_project_not_set(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "yes")
    monkeypatch.setenv("LANGSMITH_API_KEY", "key")
    monkeypatch.delenv("LANGSMITH_PROJECT", raising=False)
    monkeypatch.delenv("LANGCHAIN_PROJECT", raising=False)

    _reset_tracing_cache()
    cfg = tracing_module.get_tracing_config()

    assert cfg.project == "deer-flow"


def test_optional_langsmith_workspace_and_project_uuid_default_to_none(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "yes")
    monkeypatch.setenv("LANGSMITH_API_KEY", "key")
    monkeypatch.delenv("LANGSMITH_WORKSPACE_ID", raising=False)
    monkeypatch.delenv("LANGSMITH_PROJECT_UUID", raising=False)

    _reset_tracing_cache()
    cfg = tracing_module.get_tracing_config()

    assert cfg.workspace_id is None
    assert cfg.project_uuid is None


def test_compose_allows_env_file_to_disable_langsmith_tracing() -> None:
    compose = Path(__file__).resolve().parents[2] / "docker/docker-compose.yaml"
    text = compose.read_text(encoding="utf-8")

    assert "- LANGSMITH_TRACING=" not in text
    assert "- SOPHIA_BUILDER_LANGSMITH_TRACING=" not in text
    assert "SOPHIA_BUILDER_LANGSMITH_TRACING, and LANGSMITH_API_KEY are read from ../.env" in text


def test_render_keeps_global_langsmith_tracing_disabled_for_builder_scope() -> None:
    render = Path(__file__).resolve().parents[2] / "render.yaml"
    text = render.read_text(encoding="utf-8")

    assert "key: LANGSMITH_TRACING\n        value: \"false\"" in text
    assert "key: SOPHIA_BUILDER_LANGSMITH_TRACING\n        value: \"true\"" in text
