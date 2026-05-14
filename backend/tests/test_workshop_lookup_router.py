"""Unit tests for the workshop-lookup internal router (spec §11.3)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import workshop_lookup


@pytest.fixture
def app_with_router() -> FastAPI:
    app = FastAPI()
    workshop_lookup.install_task_resolution_cache(app)
    app.include_router(workshop_lookup.router)
    return app


def test_register_then_resolve(app_with_router: FastAPI) -> None:
    client = TestClient(app_with_router)
    r = client.post(
        "/internal/workshop/resolve",
        json={"chat_id": 1, "message_id": 42, "task_id": "tx", "user_id": "ua"},
    )
    assert r.status_code == 201

    r = client.get("/internal/workshop/resolve", params={"chat_id": 1, "message_id": 42})
    assert r.status_code == 200
    body = r.json()
    assert body == {"task_id": "tx", "user_id": "ua"}


def test_unknown_resolution_returns_404(app_with_router: FastAPI) -> None:
    client = TestClient(app_with_router)
    r = client.get("/internal/workshop/resolve", params={"chat_id": 1, "message_id": 99})
    assert r.status_code == 404


def test_register_empty_task_returns_400(app_with_router: FastAPI) -> None:
    client = TestClient(app_with_router)
    r = client.post(
        "/internal/workshop/resolve",
        json={"chat_id": 1, "message_id": 2, "task_id": "", "user_id": "u"},
    )
    assert r.status_code == 400
