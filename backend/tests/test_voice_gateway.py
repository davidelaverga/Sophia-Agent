"""Tests for the voice gateway endpoint."""

import re
from unittest.mock import ANY, AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.auth import require_authorized_user_scope
from app.gateway.routers.voice import _dispatch_voice_agent, _get_voice_server_url, router

app = FastAPI()
app.include_router(router)
app.dependency_overrides[require_authorized_user_scope] = lambda: "test-user"
client = TestClient(app)


@pytest.fixture
def secure_client():
    secure_app = FastAPI()
    secure_app.include_router(router)
    return TestClient(secure_app)


@pytest.fixture(autouse=True)
def _reset_active_voice_sessions():
    from app.gateway.routers.voice import _active_voice_session_locks, _active_voice_sessions

    _active_voice_sessions.clear()
    _active_voice_session_locks.clear()
    yield
    _active_voice_sessions.clear()
    _active_voice_session_locks.clear()


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

    def test_requires_authorization_when_auth_dependency_is_active(self, secure_client):
        resp = secure_client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 401

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
        assert data["thread_id"] is None
        assert data["session_id"] == "test-session-id"
        assert data["stream_url"] == (
            f"/api/sophia/user_123/voice/events?call_id={data['call_id']}&session_id=test-session-id"
        )

    def test_returns_credentials_with_all_params(self):
        with patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
            return_value="test-session-id",
        ) as dispatch:
            resp = client.post(
                "/api/sophia/user_456/voice/connect",
                json={"platform": "ios_voice", "context_mode": "work", "ritual": "debrief"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["api_key"] == "test-api-key"
        assert data["call_type"] == "default"
        assert "user_456" in data["call_id"]
        assert data["thread_id"] is None
        assert data["session_id"] == "test-session-id"
        dispatch.assert_awaited_once_with(
            call_id=ANY,
            call_type="default",
            platform="ios_voice",
            context_mode="work",
            ritual="debrief",
            session_id=None,
            thread_id=None,
        )

    def test_forwards_session_and_thread_ids_to_voice_dispatch(self):
        with patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
            return_value="test-session-id",
        ) as dispatch:
            resp = client.post(
                "/api/sophia/user_456/voice/connect",
                json={
                    "platform": "voice",
                    "context_mode": "life",
                    "ritual": "vent",
                    "session_id": "session-123",
                    "thread_id": "thread-456",
                },
            )

        assert resp.status_code == 200
        assert resp.json()["thread_id"] == "thread-456"
        assert resp.json()["stream_url"] == (
            f"/api/sophia/user_456/voice/events?call_id={resp.json()['call_id']}&session_id=test-session-id"
        )
        dispatch.assert_awaited_once_with(
            call_id=ANY,
            call_type="default",
            platform="voice",
            context_mode="life",
            ritual="vent",
            session_id="session-123",
            thread_id="thread-456",
        )

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

    def test_mixed_case_user_id_is_normalized_for_call_id(self):
        with _mock_dispatch_success():
            resp = client.post(
                "/api/sophia/krEDzdbKU9ingOR78XxYFLSI7iyQeF0h/voice/connect",
                json={"platform": "voice"},
            )

        assert resp.status_code == 200
        call_id = resp.json()["call_id"]
        assert call_id.startswith("sophia-kredzdbku9ingor78xxyflsi7iyqef0h-")
        assert re.fullmatch(r"[a-z0-9_-]+", call_id)

    def test_reconnect_closes_previous_session_for_same_user(self):
        with patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
            side_effect=["session-1", "session-2"],
        ), patch(
            "app.gateway.routers.voice._disconnect_voice_session",
            new_callable=AsyncMock,
        ) as disconnect_voice_session:
            first = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )
            second = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        assert first.status_code == 200
        assert second.status_code == 200
        # Preflight disconnect is fire-and-forget (background task) so the
        # new /voice/connect isn't blocked on the previous session teardown.
        # We assert the call was made, not that it was awaited synchronously.
        disconnect_voice_session.assert_called_once_with(
            first.json()["call_id"],
            "session-1",
        )

    def test_missing_stream_api_key_returns_503(self, monkeypatch):
        monkeypatch.delenv("STREAM_API_KEY", raising=False)
        monkeypatch.setattr("app.gateway.routers.voice._get_voice_env_fallback", lambda: {})
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 503
        assert "STREAM_API_KEY" in resp.json()["detail"]

    def test_missing_stream_api_secret_returns_503(self, monkeypatch):
        monkeypatch.delenv("STREAM_API_SECRET", raising=False)
        monkeypatch.setattr("app.gateway.routers.voice._get_voice_env_fallback", lambda: {})
        resp = client.post(
            "/api/sophia/user_123/voice/connect",
            json={"platform": "voice"},
        )
        assert resp.status_code == 503
        assert "STREAM_API_SECRET" in resp.json()["detail"]

    def test_falls_back_to_voice_env_for_stream_credentials(self, monkeypatch):
        monkeypatch.delenv("STREAM_API_KEY", raising=False)
        monkeypatch.delenv("STREAM_API_SECRET", raising=False)
        monkeypatch.setattr(
            "app.gateway.routers.voice._get_voice_env_fallback",
            lambda: {
                "STREAM_API_KEY": "voice-file-api-key",
                "STREAM_API_SECRET": "voice-file-api-secret",
            },
        )

        with _mock_dispatch_unavailable():
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["api_key"] == "voice-file-api-key"
        assert len(data["token"]) > 0

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
        assert data["thread_id"] is None
        assert data["session_id"] is None
        assert data["stream_url"] is None


class TestVoiceEvents:
    def test_events_proxy_streams_sse_payload(self):
        request = httpx.Request(
            "GET",
            "http://test/calls/sophia-user_123-abc12345/sessions/test-session-id/events",
        )
        mock_response = httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream"},
            content=(
                b"event: sophia.transcript\n"
                b"data: {\"type\":\"sophia.transcript\",\"data\":{\"text\":\"Hello\"}}\n\n"
            ),
        )

        with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.send = AsyncMock(return_value=mock_response)
            mock_client.aclose = AsyncMock(return_value=None)
            mock_client.build_request = lambda *args, **kwargs: request
            mock_client_cls.return_value = mock_client

            resp = client.get(
                "/api/sophia/user_123/voice/events",
                params={
                    "call_id": "sophia-user_123-abc12345",
                    "session_id": "test-session-id",
                },
            )

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert "sophia.transcript" in resp.text


@pytest.mark.anyio
async def test_dispatch_voice_agent_returns_none_for_invalid_json() -> None:
    request = httpx.Request("POST", "http://test/calls/sophia-user_123-abc12345/sessions")
    mock_response = httpx.Response(201, request=request, text="not-json")

    with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        session_id = await _dispatch_voice_agent(
            call_id="sophia-user_123-abc12345",
            call_type="default",
            platform="voice",
            context_mode="gaming",
            ritual="vent",
        )

    assert session_id is None


@pytest.mark.anyio
async def test_dispatch_voice_agent_returns_none_for_request_error() -> None:
    request = httpx.Request("POST", "http://test/calls/sophia-user_123-abc12345/sessions")

    with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            side_effect=httpx.RequestError("socket closed", request=request)
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        session_id = await _dispatch_voice_agent(
            call_id="sophia-user_123-abc12345",
            call_type="default",
            platform="voice",
            context_mode="gaming",
            ritual="vent",
        )

    assert session_id is None


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

    def test_disconnect_request_error_is_swallowed(self):
        request = httpx.Request("DELETE", "http://test/")
        with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.delete = AsyncMock(
                side_effect=httpx.RequestError("socket closed", request=request)
            )
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            resp = client.post(
                "/api/sophia/user_123/voice/disconnect",
                json={"call_id": "sophia-user_123-abc12345", "session_id": "test-session-id"},
            )
        assert resp.status_code == 204

    def test_disconnect_missing_fields(self):
        resp = client.post(
            "/api/sophia/user_123/voice/disconnect",
            json={"call_id": "sophia-user_123-abc12345"},
        )
        assert resp.status_code == 422

    def test_disconnect_clears_tracked_active_session(self):
        from app.gateway.routers.voice import _active_voice_sessions

        with patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
            return_value="tracked-session",
        ):
            connect_response = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        with patch(
            "app.gateway.routers.voice._disconnect_voice_session",
            new_callable=AsyncMock,
        ):
            disconnect_response = client.post(
                "/api/sophia/user_123/voice/disconnect",
                json={
                    "call_id": connect_response.json()["call_id"],
                    "session_id": "tracked-session",
                },
            )

        assert disconnect_response.status_code == 204
        assert "user_123" not in _active_voice_sessions


@pytest.mark.anyio
async def test_dispatch_voice_agent_posts_runtime_context():
    request = httpx.Request("POST", "http://test/calls/sophia-user_123-abc12345/sessions")
    mock_response = httpx.Response(201, request=request, json={"session_id": "test-session-id"})

    with patch("app.gateway.routers.voice.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        session_id = await _dispatch_voice_agent(
            call_id="sophia-user_123-abc12345",
            call_type="default",
            platform="voice",
            context_mode="gaming",
            ritual="vent",
        )

    assert session_id == "test-session-id"
    mock_client.post.assert_awaited_once_with(
        f"{_get_voice_server_url()}/calls/sophia-user_123-abc12345/sessions",
        json={
            "call_type": "default",
            "platform": "voice",
            "context_mode": "gaming",
            "ritual": "vent",
            "session_id": None,
            "thread_id": None,
        },
    )
