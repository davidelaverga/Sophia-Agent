from __future__ import annotations

from deerflow.sophia.subprocess_env import trusted_subprocess_env


def test_native_renderer_subprocess_gets_no_service_authority(monkeypatch) -> None:
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("OPENAI_API_KEY", "baseline-image")
    monkeypatch.setenv("LANGSMITH_API_KEY", "trace-key")
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "dq-key")
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_CANARY_USER_IDS", "canary")
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "hmac")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "storage")
    monkeypatch.setenv("DATABASE_URL", "postgresql://private")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "companion")
    monkeypatch.setenv("LC_ALL", "C.UTF-8")
    monkeypatch.setenv("LC_FUTURE_AUTHORITY", "must-not-cross")

    env = trusted_subprocess_env()

    assert env["PATH"] == "/usr/bin:/bin"
    assert "OPENAI_API_KEY" not in env
    assert "LANGSMITH_API_KEY" not in env
    assert "SOPHIA_DECK_QUALITY_OPENAI_API_KEY" not in env
    assert "SOPHIA_DECK_QUALITY_CANARY_USER_IDS" not in env
    assert "SOPHIA_BUILDER_EVENTS_HMAC_SECRET" not in env
    assert "SUPABASE_SERVICE_ROLE_KEY" not in env
    assert "DATABASE_URL" not in env
    assert "ANTHROPIC_API_KEY" not in env
    assert env["LC_ALL"] == "C.UTF-8"
    assert "LC_FUTURE_AUTHORITY" not in env


def test_fixed_image_subprocess_gets_only_its_provider_and_trace_authority(
    monkeypatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "baseline-image")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.example/v1")
    monkeypatch.setenv("LANGSMITH_API_KEY", "trace-key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
    monkeypatch.setenv("SOPHIA_IMAGE_GEN_CONCURRENCY", "2")
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "dq-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "storage")
    monkeypatch.setenv("STREAM_API_SECRET", "stream")

    env = trusted_subprocess_env(allow_openai=True, allow_langsmith=True)

    assert env["OPENAI_API_KEY"] == "baseline-image"
    assert env["OPENAI_BASE_URL"] == "https://api.openai.example/v1"
    assert env["LANGSMITH_API_KEY"] == "trace-key"
    assert env["LANGSMITH_PROJECT"] == "Sophia"
    assert env["SOPHIA_BUILDER_LANGSMITH_TRACING"] == "true"
    assert env["SOPHIA_IMAGE_GEN_CONCURRENCY"] == "2"
    assert "SOPHIA_DECK_QUALITY_OPENAI_API_KEY" not in env
    assert "SUPABASE_SERVICE_ROLE_KEY" not in env
    assert "STREAM_API_SECRET" not in env
