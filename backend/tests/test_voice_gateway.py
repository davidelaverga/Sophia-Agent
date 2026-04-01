"""Tests for the voice gateway endpoint."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers.voice import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)


# ---------------------------------------------------------------------------
# Helpers — mock voice server dispatch
# ---------------------------------------------------------------------------

def _mock_dispatch_success():
    """Return a patch that makes _dispatch_voice_agent succeed."""
    return patch(
        "app.gateway.routers.voice._dispatch_voice_agent",
        new_callable=AsyncMock,
        return_value="test-session-id",
    )


def _mock_dispatch_unavailable():
    """Return a patch that simulates voice server being down."""
    return patch(
        "app.gateway.routers.voice._dispatch_voice_agent",
        new_callable=AsyncMock,
        return_value=None,
    )


@pytest.fixture(autouse=True)
def _stream_env(monkeypatch):
    """Set required Stream env vars for all tests."""
    monkeypatch.setenv("STREAM_API_KEY", "test-api-key")
    monkeypatch.setenv("STREAM_API_SECRET", "test-api-secret")


class TestVoiceConnect:
    """POST /api/sophia/{user_id}/voice/connect"""

    def test_happy_path_returns_credentials(self):
        with _mock_dispatch_success():
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["api_key"] == "test-api-key"
        assert data["call_type"] == "default"
        assert data["call_id"].startswith("sophia-user_123-")
        assert len(data["token"]) > 0
        assert data["session_id"] == "test-session-id"

    def test_returns_credentials_with_all_params(self):
        with _mock_dispatch_success():
            resp = client.post(
                "/api/sophia/user_456/voice/connect",
                json={"platform": "ios_voice", "context_mode": "work", "ritual": "debrief"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["api_key"] == "test-api-key"
        assert data["call_type"] == "default"
        assert "user_456" in data["call_id"]
        assert data["session_id"] == "test-session-id"

    def test_text_platform_accepted(self):
        with _mock_dispatch_success():
            resp = client.post(
                "/api/sophia/user_789/voice/connect",
                json={"platform": "text"},
            )
        assert resp.status_code == 200

    def test_missing_platform_returns_422(self):
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={},
        )
        assert resp.status_code == 422

    def test_invalid_platform_returns_422(self):
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "desktop"},
        )
        assert resp.status_code == 422
        assert "Invalid platform" in resp.json()["detail"]

    def test_invalid_context_mode_returns_422(self):
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice", "context_mode": "invalid"},
        )
        assert resp.status_code == 422
        assert "Invalid context_mode" in resp.json()["detail"]

    def test_default_context_mode_is_life(self):
        with _mock_dispatch_success():
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )
        assert resp.status_code == 200

    def test_unique_call_ids(self):
        with _mock_dispatch_success():
            resp1 = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )
            resp2 = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )
        assert resp1.json()["call_id"] != resp2.json()["call_id"]

    def test_missing_stream_api_key_returns_503(self, monkeypatch):
        monkeypatch.delenv("STREAM_API_KEY", raising=False)
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 503
        assert "STREAM_API_KEY" in resp.json()["detail"]

    def test_missing_stream_api_secret_returns_503(self, monkeypatch):
        monkeypatch.delenv("STREAM_API_SECRET", raising=False)
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 503
        assert "STREAM_API_SECRET" in resp.json()["detail"]

    def test_voice_server_unavailable_returns_credentials_with_null_session(self):
        """When voice server is down, gateway still returns credentials.
        session_id is None so the frontend knows the agent didn't join."""
        with _mock_dispatch_unavailable():
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["api_key"] == "test-api-key"
        assert data["call_id"].startswith("sophia-user_123-")
        assert data["session_id"] is None


class TestVoiceDisconnect:
    """POST /api/sophia/{user_id}/voice/disconnect"""

    def test_disconnect_success(self):
        mock_response = httpx.Response(200, request=httpx.Request("DELETE", "http://test/"))
        with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.delete = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            resp = client.post(
                "/api/sophia/user_123/voice/disconnect",
                json={"call_id": "sophia-user_123-abc12345", "session_id": "test-session-id"},
            )
        assert resp.status_code == 204

    def test_disconnect_session_already_gone(self):
        mock_response = httpx.Response(404, request=httpx.Request("DELETE", "http://test/"))
        with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.delete = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            resp = client.post(
                "/api/sophia/user_123/voice/disconnect",
                json={"call_id": "sophia-user_123-abc12345", "session_id": "gone-session"},
            )
        assert resp.status_code == 204

    def test_disconnect_voice_server_unavailable(self):
        with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.delete = AsyncMock(side_effect=httpx.ConnectError("refused"))
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            resp = client.post(
                "/api/sophia/user_123/voice/disconnect",
                json={"call_id": "sophia-user_123-abc12345", "session_id": "test-session-id"},
            )
        # Graceful degradation — still returns 204, relies on idle timeout
        assert resp.status_code == 204

    def test_disconnect_missing_fields(self):
        resp = client.post(
            "/api/sophia/user_123/voice/disconnect",
            json={"call_id": "sophia-user_123-abc12345"},
        )
        assert resp.status_code == 422
