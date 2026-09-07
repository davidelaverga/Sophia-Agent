"""Event identity must match the independently pinned projection environment."""

import pytest

from deerflow.sophia.memory_governance import observability


@pytest.mark.parametrize("fallback", [None, "staging", " production "])
def test_event_uses_pinned_memory_environment(monkeypatch, fallback):
    monkeypatch.setenv("SOPHIA_MEMORY_PROVIDER_ENVIRONMENT", " production ")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    if fallback is None:
        monkeypatch.delenv("SOPHIA_ENV", raising=False)
    else:
        monkeypatch.setenv("SOPHIA_ENV", fallback)
    captured = []
    monkeypatch.setattr(observability, "_export_langsmith", lambda envelope, **kwargs: captured.append(envelope) or "exported")
    observability.emit_memory_event("memory.prompt.admission", service="synthetic-service", outcome="zero_memory")
    assert captured[0]["environment"] == "production"


def test_blank_pin_uses_trimmed_fallback(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_PROVIDER_ENVIRONMENT", " ")
    monkeypatch.setenv("SOPHIA_ENV", " ")
    monkeypatch.setenv("ENVIRONMENT", " staging ")
    captured = []
    monkeypatch.setattr(observability, "_export_langsmith", lambda envelope, **kwargs: captured.append(envelope) or "exported")
    observability.emit_memory_event("memory.prompt.admission", service="synthetic-service", outcome="zero_memory")
    assert captured[0]["environment"] == "staging"
