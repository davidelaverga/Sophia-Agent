from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.gateway.auth import require_authorized_user_scope
from deerflow.config.app_config import AppConfig, reset_app_config, set_app_config
from deerflow.config.sandbox_config import SandboxConfig


@pytest.fixture(autouse=True)
def _gateway_test_app_config():
    set_app_config(
        AppConfig(
            models=[],
            sandbox=SandboxConfig(use="deerflow.sandbox.local:LocalSandboxProvider"),
        )
    )
    yield
    reset_app_config()


def test_gateway_app_mounts_sessions_and_bootstrap_routes():
    from app.gateway.app import create_app

    app = create_app()
    with TestClient(app) as client:
        active_response = client.get("/api/v1/sessions/active")
        opener_response = client.get("/api/v1/bootstrap/opener")

    assert active_response.status_code == 200
    assert active_response.json() == {"has_active_session": False, "session": None}

    assert opener_response.status_code == 200
    assert opener_response.json() == {
        "opener_text": "",
        "suggested_ritual": None,
        "emotional_context": None,
        "has_opener": False,
    }


def test_gateway_app_mounts_voice_connect_route(monkeypatch):
    from app.gateway.app import create_app

    monkeypatch.setenv("STREAM_API_KEY", "test-api-key")
    monkeypatch.setenv("STREAM_API_SECRET", "test-api-secret")

    app = create_app()
    app.dependency_overrides[require_authorized_user_scope] = lambda: "test_user"
    with patch(
        "app.gateway.routers.voice._dispatch_voice_agent",
        new_callable=AsyncMock,
        return_value="test-session-id",
    ):
        with TestClient(app) as client:
            response = client.post(
                "/api/sophia/test_user/voice/connect",
                json={"platform": "voice", "context_mode": "life"},
            )

    assert response.status_code == 200
    payload = response.json()
    assert payload["api_key"] == "test-api-key"
    assert payload["session_id"] == "test-session-id"
    assert payload["call_type"] == "default"