from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient


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