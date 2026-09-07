"""A metrics read must observe the serving process, not a fresh shell import."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from deerflow.sophia.memory_governance import observability


def test_live_snapshot_observes_events_and_is_not_a_release_certificate(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_PROVIDER_ENVIRONMENT", "production")
    monkeypatch.setenv("RENDER_GIT_COMMIT", "a" * 40)
    monkeypatch.setattr(observability, "_export_langsmith", lambda *args, **kwargs: "unavailable")
    before = observability.runtime_metric_snapshot()
    observability.emit_memory_event("memory.prompt.admission", service="gateway", outcome="authorized", authorized_count=1, provider_hit_count=2)
    after = observability.runtime_metric_snapshot()
    assert after["process_ref"] == before["process_ref"]
    assert after["event_count"] == before["event_count"] + 1
    assert after["deployment_sha"] == "a" * 40
    assert after["environment"] == "production"
    assert after["scope"] == "serving_process_since_start"
    assert after["release_certified"] is False
    assert after["coverage"] == "partial"
    assert after["last_export_status"] == "unavailable"
    after["zero_tolerance_counters"]["memory_policy_escape_total"] = 99
    assert observability.runtime_metric_snapshot()["zero_tolerance_counters"]["memory_policy_escape_total"] == 0


def test_process_metric_dimensions_never_store_refs_or_arbitrary_values(monkeypatch):
    monkeypatch.setattr(observability, "_export_langsmith", lambda *args, **kwargs: "disabled")
    observability.emit_memory_event("memory.synthetic-sensitive-dimension", service="private-service-sentinel", outcome="private-outcome-sentinel", owner_ref="hmac-sha256:owner:private-ref-sentinel")
    encoded = json.dumps(observability.runtime_metric_snapshot())
    for sentinel in ("synthetic-sensitive-dimension", "private-service-sentinel", "private-outcome-sentinel", "private-ref-sentinel"):
        assert sentinel not in encoded


def test_nonzero_release_counter_is_security_hold():
    observability.increment_counter("memory_policy_escape_total")
    try:
        assert observability.runtime_metric_snapshot()["security_status"] == "SECURITY_HOLD"
    finally:
        observability.reset_counters_for_test()


@pytest.mark.parametrize("principal,enabled,status", [("synthetic-owner", True, 200), ("someone-else", True, 403), ("synthetic-owner", False, 404), ("", True, 403)])
def test_snapshot_route_is_authenticated_and_certification_scoped(monkeypatch, principal, enabled, status):
    from app.gateway.auth import require_authorized_user_scope
    from app.gateway.routers import sophia
    from deerflow.sophia.memory_governance import store
    from deerflow.sophia.memory_governance.flags import MemoryFeatureFlags

    monkeypatch.setattr(store, "configured_memory_store", lambda: None)
    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", principal)
    monkeypatch.setattr(sophia, "_memory_flags", lambda owner: MemoryFeatureFlags(canonical_pool_read=enabled))
    app = FastAPI()
    app.include_router(sophia.router)
    client = TestClient(app)
    assert client.get("/api/sophia/synthetic-owner/memory-observability").status_code in (401, 403)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "synthetic-owner"
    response = client.get("/api/sophia/synthetic-owner/memory-observability")
    assert response.status_code == status
    if status == 200:
        assert response.json()["scope"] == "serving_process_since_start"
        assert response.headers["cache-control"] == "no-store"


def test_voice_lab_principal_cannot_read_metrics(monkeypatch):
    from app.gateway.auth import require_authorized_user_scope
    from app.gateway.routers import sophia

    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "synthetic-owner")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "synthetic-owner")
    app = FastAPI()
    app.include_router(sophia.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "synthetic-owner"
    response = TestClient(app).get("/api/sophia/synthetic-owner/memory-observability")
    assert response.status_code == 403
    assert response.json() == {"detail": "Memory diagnostics scope denied"}
