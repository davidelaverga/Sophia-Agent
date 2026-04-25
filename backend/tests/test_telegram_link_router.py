"""Tests for the ``/api/sophia/{user_id}/telegram/link`` router.

Uses FastAPI's TestClient with ``require_authorized_user_scope`` stubbed
so we test the handler logic in isolation from the auth bridge.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway import telegram_link_store as store
from app.gateway.auth import require_authorized_user_scope
from app.gateway.routers.telegram_link import router


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "user-test"
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    store.clear_all()
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "Sophia_EI_bot")
    # Keep Supabase no-op in tests.
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    yield
    store.clear_all()


@pytest.fixture
def secure_client() -> TestClient:
    """Client without the dependency override — exercises the auth shim."""
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestCreateLink:
    def test_returns_deep_link_url(self, client):
        response = client.post("/api/sophia/user-test/telegram/link")
        assert response.status_code == 200
        body = response.json()
        assert body["bot_username"] == "Sophia_EI_bot"
        assert body["url"].startswith("https://t.me/Sophia_EI_bot?start=")
        assert body["token"] in body["url"]
        assert body["expires_at"] > 0

    def test_each_call_produces_a_fresh_token(self, client):
        r1 = client.post("/api/sophia/user-test/telegram/link").json()
        r2 = client.post("/api/sophia/user-test/telegram/link").json()
        assert r1["token"] != r2["token"]

    def test_requires_authorization_when_auth_active(self, secure_client):
        # No token → 401 from the auth shim.
        response = secure_client.post("/api/sophia/user-test/telegram/link")
        assert response.status_code == 401

    def test_rejects_invalid_user_id(self, client):
        response = client.post("/api/sophia/user..bad/telegram/link")
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid user_id format"

    def test_token_is_stored_and_redeemable(self, client):
        body = client.post("/api/sophia/user-test/telegram/link").json()
        rec = store.pop_link_token(body["token"])
        assert rec is not None
        assert rec.user_id == "user-test"


class TestGetLink:
    def test_not_linked_when_no_binding(self, client):
        response = client.get("/api/sophia/user-test/telegram/link")
        assert response.status_code == 200
        body = response.json()
        assert body["linked"] is False
        assert body["bot_username"] == "Sophia_EI_bot"
        assert body["telegram_username"] is None
        assert body["telegram_chat_id"] is None

    def test_reports_linked_after_binding(self, client):
        store.bind_chat(
            "telegram",
            "42",
            "user-test",
            telegram_user_id="101",
            telegram_username="alice",
        )
        response = client.get("/api/sophia/user-test/telegram/link")
        body = response.json()
        assert body["linked"] is True
        assert body["telegram_username"] == "alice"
        assert body["telegram_chat_id"] == "42"


class TestDeleteLink:
    def test_returns_204_even_when_nothing_to_revoke(self, client):
        response = client.delete("/api/sophia/user-test/telegram/link")
        assert response.status_code == 204

    def test_removes_binding(self, client):
        store.bind_chat("telegram", "42", "user-test")
        response = client.delete("/api/sophia/user-test/telegram/link")
        assert response.status_code == 204
        assert store.resolve_user_id("telegram", "42") is None
