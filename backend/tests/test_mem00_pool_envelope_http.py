"""The ordinary Journal carries owner/snapshot/completeness from actual store pages."""

import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from test_mem00_complete_pool import pool_page

from app.gateway.routers import sophia
from deerflow.sophia.memory_governance.service import CanonicalMemoryService, MemoryProviderContract
from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore


@pytest.mark.parametrize("view", ["active", "forgotten"])
@pytest.mark.parametrize("fault", ["none", "changed", "partial", "owner", "old_version", "outage"])
def test_journal_enumerates_current_scoped_snapshot_or_denies(monkeypatch, declare_memory_owners, view, fault):  # noqa: F811 - pytest fixture request
    declare_memory_owners({"pool-owner": "governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "r" * 32)
    calls = []

    def transport(request):
        name = request.url.path.rsplit("/", 1)[1]
        if name == "sophia_memory_contract":
            return httpx.Response(200, json=[{"contract_epoch": 1, "schema_version": "mem00.v1", "mode": "enforced", "updated_at": "2026-09-09T00:00:00Z"}])
        if name == "sophia_memory_user_governance":
            return httpx.Response(200, json=[{"user_id": "pool-owner", "authority_state": "governed", "authority_epoch": 1, "authority_declared_at": "2026-09-09T00:00:00Z"}])
        assert name == "sophia_memory_inventory_snapshot"
        body = json.loads(request.content)
        start = 0 if body["p_after_key"] is None else int(body["p_after_key"][-12:])
        calls.append(start)
        if start and fault == "outage":
            return httpx.Response(503, text="PRIVATE_FAILURE")
        value = pool_page(start, view=body["p_view"], fault=fault)
        for item in value["records"]:
            item["state"] = view
        return httpx.Response(200, json=value)

    with httpx.Client(transport=httpx.MockTransport(transport)) as http:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=http)
        service = CanonicalMemoryService(owner_id="pool-owner", store=store, provider=MemoryProviderContract("mem0", "synthetic", "existing-project"))
        monkeypatch.setattr(sophia, "_canonical_memory_service", lambda _: service)
        app = FastAPI()
        app.include_router(sophia.router)
        app.dependency_overrides[sophia.require_authorized_user_scope] = lambda: "pool-owner"
        with TestClient(app) as client:
            response = client.get("/api/sophia/pool-owner/journal" + ("?status=forgotten" if view == "forgotten" else ""))
            assert response.headers.get("Cache-Control") == "no-store"
            assert response.status_code == (200 if fault == "none" else 503)
            if fault == "none":
                value = response.json()
                assert value["schema"] == "mem00.pool.v1"
                assert value["owner_id"] == "pool-owner" and value["view"] == view
                assert value["snapshot_id"] == "a" * 32 and value["snapshot_count"] == 1005
                assert value["enumeration_complete"] is True and value["next_cursor"] is None
                assert value["count"] == len(value["entries"]) == 1005
                assert value["projection_status"] == "unavailable" and value["provider_state_queried"] is False
                assert len(calls) == 6
            else:
                assert "CURRENT_SYNTHETIC_" not in response.text
                assert calls == [0, 200]
