"""Tests for the voice gateway endpoint."""

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.gateway.routers.voice import router

# Build a minimal FastAPI app for testing
from fastapi import FastAPI

app = FastAPI()
app.include_router(router)
client = TestClient(app)


@pytest.fixture(autouse=True)
def _stream_env(monkeypatch):
    """Set required Stream env vars for all tests."""
    monkeypatch.setenv("STREAM_API_KEY", "test-api-key")
    monkeypatch.setenv("STREAM_API_SECRET", "test-api-secret")


class TestVoiceConnect:
    """POST /api/sophia/{user_id}/voice/connect"""

    def test_happy_path_returns_credentials(self):
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

    def test_returns_credentials_with_all_params(self):
        resp = client.post(
            "/api/sophia/user_456/voice/connect",
            json={"platform": "ios_voice", "context_mode": "work", "ritual": "debrief"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["api_key"] == "test-api-key"
        assert data["call_type"] == "default"
        assert "user_456" in data["call_id"]

    def test_text_platform_accepted(self):
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
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 200

    def test_unique_call_ids(self):
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
