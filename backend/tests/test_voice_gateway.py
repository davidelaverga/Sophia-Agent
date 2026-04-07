"""Tests for the voice gateway router."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers.voice import router


@pytest.fixture()
def app():
    """Create a minimal FastAPI app with the voice router."""
    _app = FastAPI()
    _app.include_router(router)
    return _app


@pytest.fixture()
def client(app):
    return TestClient(app)


class TestVoiceConnect:
    def test_invalid_user_id_returns_400(self, client):
        resp = client.post(
            "/api/sophia/invalid user!!/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 400

    @patch("app.gateway.routers.voice.httpx.AsyncClient")
    def test_connect_proxies_to_voice_server(self, mock_client_cls, client):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "call_id": "call-1",
            "session_id": "sess-1",
            "thread_id": "thread-1",
        }

        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=MagicMock(post=AsyncMock(return_value=mock_response)))
        mock_ctx.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_ctx

        with patch("app.gateway.routers.voice.register_activity", create=True):
            resp = client.post(
                "/api/sophia/jorge_test/voice/connect",
                json={"platform": "voice", "context_mode": "work"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["call_id"] == "call-1"
        assert data["session_id"] == "sess-1"
        assert data["thread_id"] == "thread-1"
        assert "stream_url" in data


class TestVoiceDisconnect:
    def test_disconnect_returns_204(self, client):
        with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_cls:
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.raise_for_status = MagicMock()

            mock_ctx = AsyncMock()
            mock_ctx.__aenter__ = AsyncMock(return_value=MagicMock(delete=AsyncMock(return_value=mock_resp)))
            mock_ctx.__aexit__ = AsyncMock(return_value=False)
            mock_cls.return_value = mock_ctx

            with patch("deerflow.sophia.offline_pipeline.run_offline_pipeline", return_value={"status": "completed"}):
                resp = client.post(
                    "/api/sophia/jorge_test/voice/disconnect",
                    json={"call_id": "call-1", "session_id": "sess-1", "thread_id": "thread-1"},
                )

        assert resp.status_code == 204

    def test_disconnect_invalid_user_returns_400(self, client):
        resp = client.post(
            "/api/sophia/bad user!!/voice/disconnect",
            json={"call_id": "c", "session_id": "s", "thread_id": "t"},
        )
        assert resp.status_code == 400

    def test_disconnect_requires_thread_id(self, client):
        resp = client.post(
            "/api/sophia/jorge_test/voice/disconnect",
            json={"call_id": "c", "session_id": "s"},
        )
        assert resp.status_code == 422  # Pydantic validation error
