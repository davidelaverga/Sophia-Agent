import asyncio

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.gateway.routers.langgraph_auth import router


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SOPHIA_AUTH_BYPASS", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-test")
    async def bridge(token):
        if token == "valid-test-token":
            return {"id": "owner-a", "email": "not-returned@example.invalid"}
        if token == "voice-test-token":
            return {"id": "voice-lab-test"}
        if token == "invalid-subject":
            return {"id": "../invalid"}
        raise HTTPException(401, "Invalid auth token")
    monkeypatch.setattr("app.gateway.auth._get_authenticated_user", bridge)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def test_current_subject_only_and_no_cache(client):
    response = client.get("/api/sophia-auth/subject", headers={"Authorization": "Bearer valid-test-token"})
    assert response.status_code == 200
    assert response.json() == {"id": "owner-a"}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("state", ["legacy", "governed", "unknown", "wrong-owner", "outage"])
def test_memory_authority_observation_is_exact_and_owner_bound(client, monkeypatch, state):
    from types import SimpleNamespace
    def resolve(owner):
        assert owner == "owner-a"
        if state == "outage":
            raise RuntimeError("PRIVATE")
        return SimpleNamespace(user_id="wrong" if state == "wrong-owner" else owner, authority_state=state)
    monkeypatch.setattr("deerflow.sophia.memory_governance.owner_authority.resolve_owner_authority", resolve)
    response = client.get("/api/sophia-auth/memory-authority", headers={"Authorization": "Bearer valid-test-token"})
    assert response.headers["cache-control"] == "no-store"
    if state in {"legacy", "governed"}:
        assert response.json() == {"schema": "mem00.chat-authority.v1", "owner_id": "owner-a", "authority": state, "observation_only": True}
    else:
        assert response.status_code == 503
        assert "PRIVATE" not in response.text


@pytest.mark.parametrize("token,status", [("invalid", 401), ("voice-test-token", 403)])
def test_memory_authority_does_not_bypass_auth(client, token, status):
    assert client.get("/api/sophia-auth/memory-authority", headers={"Authorization": f"Bearer {token}"}).status_code == status


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Basic token"}, {"Authorization": "Bearer invalid"}])
def test_subject_bridge_never_honors_dev_bypass(client, headers):
    assert client.get("/api/sophia-auth/subject", headers=headers).status_code == 401


def test_reserved_voice_principal_cannot_use_bridge(client):
    assert client.get("/api/sophia-auth/subject", headers={"Authorization": "Bearer voice-test-token"}).status_code == 403


def test_invalid_subject_fails_closed(client):
    assert client.get("/api/sophia-auth/subject", headers={"Authorization": "Bearer invalid-subject"}).status_code == 503


def test_broker_requires_existing_internal_credential(client, monkeypatch):
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", "synthetic-internal-key-" * 3)
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-signing-key-" * 3)
    body = {"owner_id": "owner-a", "method": "POST", "path": "/threads"}
    assert client.post("/api/sophia-auth/langgraph-service-token", json=body).status_code == 401
    assert client.post("/api/sophia-auth/langgraph-service-token", json=body, headers={"Authorization": "Bearer valid-test-token"}).status_code == 401
    response = client.post("/api/sophia-auth/langgraph-service-token", json=body, headers={"X-Sophia-Voice-Internal-Auth": "synthetic-internal-key-" * 3})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    from deerflow.sophia.langgraph_service_auth import verify_service_authorization
    claims = verify_service_authorization(response.json()["authorization"], method="POST", path="/threads")
    assert claims["sub"] == "owner-a"
    assert "synthetic-signing-key" not in response.text


@pytest.mark.parametrize("owner,path", [("voice-lab-test", "/threads"), ("owner-a", "/store/items"), ("owner-a", "/assistants")])
def test_broker_scope_is_not_general_admin(client, monkeypatch, owner, path):
    monkeypatch.setenv("SOPHIA_VOICE_INTERNAL_AUTH_SECRET", "synthetic-internal-key-" * 3)
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "synthetic-signing-key-" * 3)
    response = client.post("/api/sophia-auth/langgraph-service-token", json={"owner_id": owner, "method": "POST", "path": path}, headers={"X-Sophia-Voice-Internal-Auth": "synthetic-internal-key-" * 3})
    assert response.status_code == 403
