"""Unit tests for ``app.gateway.routers.telegram_review``.

The internal redeem endpoint guards against unauthorized callers via a
shared-secret header, then validates a one-time link token via the
existing ``telegram_link_store``.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway import telegram_link_store as store
from app.gateway.routers import telegram_review


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setenv("SOPHIA_INTERNAL_TOKEN", "internal-secret")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    store.clear_all()
    app = FastAPI()
    app.include_router(telegram_review.router)
    yield TestClient(app)
    store.clear_all()


class TestRedeemTelegramReviewToken:
    def test_valid_token_returns_user_id(self, client):
        record = store.issue_link_token("user-1")

        response = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": "internal-secret"},
            json={"token": record.token},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["user_id"] == "user-1"

    def test_token_is_single_use(self, client):
        record = store.issue_link_token("user-1")

        first = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": "internal-secret"},
            json={"token": record.token},
        )
        second = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": "internal-secret"},
            json={"token": record.token},
        )

        assert first.status_code == 200 and first.json()["ok"] is True
        # Second call: ok=False, no user_id (token was consumed).
        assert second.status_code == 200
        assert second.json() == {"ok": False, "user_id": None}

    def test_unknown_token_returns_ok_false(self, client):
        response = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": "internal-secret"},
            json={"token": "x" * 32},
        )
        assert response.status_code == 200
        assert response.json() == {"ok": False, "user_id": None}

    def test_missing_secret_returns_401(self, client):
        record = store.issue_link_token("user-1")
        response = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            json={"token": record.token},
        )
        assert response.status_code == 401

    def test_wrong_secret_returns_401(self, client):
        record = store.issue_link_token("user-1")
        response = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": "not-the-secret"},
            json={"token": record.token},
        )
        assert response.status_code == 401

    def test_unset_secret_returns_503(self, monkeypatch):
        # When SOPHIA_INTERNAL_TOKEN is unset, the endpoint must reject
        # ALL callers (closed-by-default) — never accept whatever string
        # is presented as if it were valid.
        monkeypatch.delenv("SOPHIA_INTERNAL_TOKEN", raising=False)
        store.clear_all()
        app = FastAPI()
        app.include_router(telegram_review.router)
        local_client = TestClient(app)

        record = store.issue_link_token("user-1")
        response = local_client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": ""},
            json={"token": record.token},
        )
        assert response.status_code == 503

    def test_short_token_rejected_by_validation(self, client):
        response = client.post(
            "/api/sophia/internal/redeem-telegram-review-token",
            headers={"X-Sophia-Internal-Token": "internal-secret"},
            json={"token": "short"},
        )
        # Pydantic min_length=16 rejection.
        assert response.status_code == 422
