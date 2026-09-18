"""Actual review route must reach receipt-first ledger RPC on lost responses."""

import json
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import sophia
from deerflow.sophia.memory_governance.service import CanonicalMemoryService, MemoryProviderContract
from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore




@pytest.fixture
def declare_memory_owners(monkeypatch):
    from test_mem00_owner_authority_foundation import store as authority_store
    from deerflow.sophia.memory_governance import owner_authority

    def declare(owners):
        monkeypatch.setattr(owner_authority, "configured_memory_store",
            lambda: authority_store(owners["review-owner"], owner="review-owner"))
    return declare


@pytest.mark.parametrize("case", ["committed", "tombstoned", "missing", "wrong_owner", "wrong_key", "outage", "duplicate", "extra_plaintext"])
def test_command_lookup_is_owner_scoped_content_free_and_never_reissues(monkeypatch, declare_memory_owners, case):
    declare_memory_owners({"review-owner":"governed"})
    event_id, memory_id = str(uuid4()), str(uuid4())
    row={"event_id":event_id, "operation_id":"synthetic-original-operation",
        "candidate_id":str(uuid4()),"memory_id":memory_id,"event_type":"candidate_approved","resulting_lifecycle":"active",
        "content_revision":1,"memory_governance_revision":1,"user_catalog_generation":7,"user_revocation_epoch":3,"idempotent_replay":True}
    calls=[]
    def transport(request):
        name=request.url.path.rsplit("/",1)[1];calls.append(name)
        if name=="sophia_memory_contract":
            return httpx.Response(200,json=[{"contract_epoch":1,"schema_version":"mem00.v1","mode":"enforced","updated_at":"2026-09-08T00:00:00Z"}])
        assert name=="sophia_memory_lookup_command_receipt" and request.method=="POST"
        assert json.loads(request.content)=={"p_user_id":"review-owner","p_idempotency_key":"original-stable-command"}
        if case=="outage":return httpx.Response(503,json={"message":"PRIVATE_DATABASE_BODY"})
        value={"schema":"mem00.command-status.v1","owner_id":"review-owner","command_key":"original-stable-command",
            "status":"committed","historical_result_only":True,"receipt":row}
        if case=="missing":value.update(status="not_found",receipt=None)
        if case=="wrong_owner":value["owner_id"]="other-owner"
        if case=="wrong_key":value["command_key"]="different-stable-command"
        if case=="extra_plaintext":row["canonical_content"]="PRIVATE_OLD_EDIT"
        if case=="tombstoned":row.update(event_type="memory_tombstoned",resulting_lifecycle="tombstoned",
            status="accepted_and_fenced",tombstone_id=str(uuid4()),provider_purge="purge_pending")
        return httpx.Response(200,json=[value,value] if case=="duplicate" else value)
    with httpx.Client(transport=httpx.MockTransport(transport)) as http:
        store=SupabaseMemoryGovernanceStore(url="https://synthetic.invalid",service_role_key="synthetic",client=http)
        service=CanonicalMemoryService(owner_id="review-owner",store=store,provider=MemoryProviderContract("mem0","synthetic","existing-project"))
        monkeypatch.setattr(sophia,"_canonical_memory_service",lambda _:service)
        app=FastAPI();app.include_router(sophia.router)
        app.dependency_overrides[sophia.require_authorized_user_scope]=lambda:"review-owner"
        with TestClient(app) as client:
            response=client.get("/api/sophia/review-owner/memories/commands/original-stable-command")
        if case in {"committed","tombstoned","missing"}:
            assert response.status_code==200
            assert response.headers["Cache-Control"]=="no-store"
            assert response.json()["historical_result_only"] is True
            assert response.json()["status"]==("not_found" if case=="missing" else "committed")
            if case!="missing":
                assert response.json()["receipt"]["memory_id"]==memory_id
                assert response.json()["receipt"]["operation_id"]=="synthetic-original-operation"
            if case=="tombstoned":
                assert response.json()["receipt"]["tombstone_id"]==row["tombstone_id"]
                assert response.json()["receipt"]["provider_purge"]=="purge_pending"
        else:assert response.status_code==503
        assert response.headers["Cache-Control"]=="no-store"
        assert "PRIVATE_" not in response.text and "other-owner" not in response.text
        assert calls==["sophia_memory_contract","sophia_memory_lookup_command_receipt"]
