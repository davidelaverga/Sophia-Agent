"""Tests for the voice gateway endpoint."""

import logging
import re
from unittest.mock import ANY, AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI, HTTPException
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
    monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "legacy_cascade")
    monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "false")
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
        assert data["runtime"] == "legacy_cascade"
        assert data["voice_runtime"] == "legacy_cascade"
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

    def test_legacy_preconnect_behavior_remains_unchanged(self):
        with _mock_dispatch_success() as dispatch:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice", "preconnect": True},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["runtime"] == "legacy_cascade"
        assert data["voice_runtime"] == "legacy_cascade"
        assert data["session_id"] == "test-session-id"
        dispatch.assert_awaited_once()

    def test_gemini_runtime_requires_production_promotion_flag(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")

        with patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
        ) as dispatch:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        assert resp.status_code == 409
        assert "SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED" in resp.json()["detail"]
        dispatch.assert_not_awaited()

    def test_gemini_runtime_returns_short_lived_preconnect_bootstrap(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
        monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
        realtime_context = {
            "diagnostics": {
                "schema": "sophia_realtime_context_v1",
                "mem0_status": "available",
            }
        }
        runtime_payload = {
            "runtime": "gemini_live",
            "voice_runtime": "gemini_live",
            "production_route": True,
            "session_id": "gemini-prod-preconnect-1",
            "stream_url": "/production/realtime/gemini/sessions/gemini-prod-preconnect-1/events",
            "event_stream_url": "/production/realtime/gemini/sessions/gemini-prod-preconnect-1/events",
            "provider_event_relay_url": (
                "/production/realtime/gemini/browser-sessions/"
                "gemini-prod-preconnect-1/provider-events"
            ),
            "disconnect_url": "/production/realtime/gemini/browser-sessions/gemini-prod-preconnect-1",
            "browser_audio": "gemini_live_websocket_production_candidate",
            "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
            "websocket_url": "wss://gemini.example/live",
            "websocket_auth": "ephemeral_access_token",
            "ephemeral_token": {"value": "auth_tokens/test"},
            "setup": {"model": "models/gemini-live"},
            "public_event_boundary": "SophiaEventNormalizer",
            "gemini_voice_name": "Sulafat",
            "gemini_voice_source": "env",
            "gemini_voice_configured": True,
            "gemini_voice_configured_value_valid": True,
        }

        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
            return_value=runtime_payload,
        ) as proxy_runtime, patch(
            "app.gateway.routers.voice._build_gemini_realtime_context_payload",
            new_callable=AsyncMock,
            return_value=realtime_context,
        ):
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice", "preconnect": True},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["runtime"] == "gemini_live"
        assert data["preconnect"] is True
        assert data["preconnect_ttl_ms"] == 30000
        assert data["preconnect_expires_at"].endswith("Z")
        assert data["session_id"] == "gemini-prod-preconnect-1"
        assert data["gemini_voice_name"] == "Sulafat"
        assert data["gemini_voice_source"] == "env"
        proxy_runtime.assert_awaited_once_with(
            "POST",
            "/production/realtime/gemini/browser-sessions",
            json_body={
                "user_id": "user_123",
                "session_id": ANY,
                "platform": "voice",
                "context_mode": "life",
                "ritual": None,
                "realtime_context": realtime_context,
                "preconnect": True,
                "preconnect_ttl_seconds": 65.0,
            },
        )

    def test_gemini_preconnect_skips_when_active_session_exists(self, monkeypatch):
        from app.gateway.routers.voice import ActiveVoiceSession, _active_voice_sessions

        monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
        monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
        _active_voice_sessions["user_123"] = ActiveVoiceSession(
            call_id="gemini-prod-active",
            session_id="gemini-prod-active",
            runtime="gemini_live",
        )

        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
        ) as proxy_runtime:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice", "preconnect": True},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["runtime"] == "gemini_live"
        assert data["voice_runtime"] == "gemini_live"
        assert data["preconnect"] is True
        assert data["preconnect_skipped"] is True
        assert data["preconnect_skipped_reason"] == "already_active"
        assert data["active_voice_session_exists"] is True
        assert data["session_id"] == "gemini-prod-active"
        proxy_runtime.assert_not_awaited()

    def test_gemini_runtime_returns_browser_bootstrap_when_promoted(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
        monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
        realtime_context = {
            "diagnostics": {
                "schema": "sophia_realtime_context_v1",
                "mem0_status": "available",
            }
        }

        runtime_payload = {
            "runtime": "gemini_live",
            "voice_runtime": "gemini_live",
            "production_route": True,
            "session_id": "gemini-prod-session-1",
            "stream_url": "/production/realtime/gemini/sessions/gemini-prod-session-1/events",
            "event_stream_url": "/production/realtime/gemini/sessions/gemini-prod-session-1/events",
            "provider_event_relay_url": "/production/realtime/gemini/browser-sessions/gemini-prod-session-1/provider-events",
            "disconnect_url": "/production/realtime/gemini/browser-sessions/gemini-prod-session-1",
            "browser_audio": "gemini_live_websocket_production_candidate",
            "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
            "websocket_url": "wss://gemini.example/live",
            "websocket_auth": "ephemeral_access_token",
            "ephemeral_token": {"value": "auth_tokens/test"},
            "setup": {"model": "models/gemini-live"},
            "public_event_boundary": "SophiaEventNormalizer",
            "gemini_voice_name": "Sulafat",
            "gemini_voice_source": "env",
            "gemini_voice_configured": True,
            "gemini_voice_configured_value_valid": True,
        }

        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
            return_value=runtime_payload,
        ) as proxy_runtime, patch(
            "app.gateway.routers.voice._build_gemini_realtime_context_payload",
            new_callable=AsyncMock,
            return_value=realtime_context,
        ) as context_payload, patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
        ) as dispatch:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice", "context_mode": "work", "ritual": "debrief", "thread_id": "thread-1"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["runtime"] == "gemini_live"
        assert data["voice_runtime"] == "gemini_live"
        assert data["production_route"] is True
        assert data["session_id"] == "gemini-prod-session-1"
        assert data["thread_id"] == "thread-1"
        assert data["stream_url"] == "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1"
        assert data["event_stream_url"] == "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-1"
        assert data["provider_event_relay_url"] == "/api/sophia/voice/gemini/relay"
        assert data["disconnect_url"] == "/api/sophia/voice/gemini/disconnect"
        assert data["gemini_voice_name"] == "Sulafat"
        assert data["gemini_voice_source"] == "env"
        assert data["gemini_voice_configured"] is True
        assert data["gemini_voice_configured_value_valid"] is True
        dispatch.assert_not_awaited()
        proxy_runtime.assert_awaited_once_with(
            "POST",
            "/production/realtime/gemini/browser-sessions",
            json_body={
                "user_id": "user_123",
                "session_id": ANY,
                "platform": "voice",
                "context_mode": "work",
                "ritual": "debrief",
                "realtime_context": realtime_context,
            },
        )
        context_payload.assert_awaited_once()

    def test_gemini_runtime_context_fetch_failure_degrades_safely(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "gemini_live")
        monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")

        runtime_payload = {
            "runtime": "gemini_live",
            "voice_runtime": "gemini_live",
            "production_route": True,
            "session_id": "gemini-prod-session-degraded",
            "stream_url": "/production/realtime/gemini/sessions/gemini-prod-session-degraded/events",
            "event_stream_url": "/production/realtime/gemini/sessions/gemini-prod-session-degraded/events",
            "provider_event_relay_url": (
                "/production/realtime/gemini/browser-sessions/"
                "gemini-prod-session-degraded/provider-events"
            ),
            "disconnect_url": "/production/realtime/gemini/browser-sessions/gemini-prod-session-degraded",
            "browser_audio": "gemini_live_websocket_production_candidate",
            "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
            "websocket_url": "wss://gemini.example/live",
            "websocket_auth": "ephemeral_access_token",
            "ephemeral_token": {"value": "auth_tokens/test"},
            "setup": {"model": "models/gemini-live"},
            "public_event_boundary": "SophiaEventNormalizer",
        }

        with patch(
            "app.gateway.routers.voice.build_sophia_realtime_context",
            side_effect=RuntimeError("context unavailable"),
        ), patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
            return_value=runtime_payload,
        ) as proxy_runtime:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        assert resp.status_code == 200
        json_body = proxy_runtime.await_args.kwargs["json_body"]
        diagnostics = json_body["realtime_context"]["diagnostics"]
        assert diagnostics["context_fetch_status"] == "error"
        assert diagnostics["mem0_status"] == "error"
        assert diagnostics["memory_count"] == 0

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        ("request_base_url", "expected_base_url"),
        [
            ("https://sophia-gateway.onrender.com", "https://sophia-gateway.onrender.com"),
            ("http://sophia-gateway.onrender.com", "https://sophia-gateway.onrender.com"),
            ("sophia-gateway.onrender.com", "https://sophia-gateway.onrender.com"),
            ("http://localhost", "http://localhost"),
        ],
    )
    async def test_gemini_realtime_context_canonicalizes_render_callback_url(
        self,
        monkeypatch,
        request_base_url,
        expected_base_url,
    ):
        from app.gateway.routers import voice as voice_router

        monkeypatch.setattr(
            voice_router,
            "build_sophia_realtime_context",
            lambda **_kwargs: voice_router.build_degraded_realtime_context_response(reason="test"),
        )

        payload = await voice_router._build_gemini_realtime_context_payload(
            user_id="user_123",
            body=voice_router.VoiceConnectRequest(platform="voice"),
            session_id="gemini-prod-test",
            request_base_url=request_base_url,
        )

        assert (
            payload["dynamic_memory_retrieval"]["endpoint_url"]
            == f"{expected_base_url}/internal/sophia-realtime/memories/retrieve"
        )

    def test_gemini_production_flag_routes_to_realtime_when_gateway_runtime_unset(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_VOICE_RUNTIME_MODE", raising=False)
        monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")
        monkeypatch.setattr("app.gateway.routers.voice._get_voice_env_fallback", lambda: {})
        realtime_context = {
            "diagnostics": {
                "schema": "sophia_realtime_context_v1",
                "mem0_status": "available",
            }
        }

        runtime_payload = {
            "runtime": "gemini_live",
            "voice_runtime": "gemini_live",
            "production_route": True,
            "session_id": "gemini-prod-session-2",
            "stream_url": "/production/realtime/gemini/sessions/gemini-prod-session-2/events",
            "event_stream_url": "/production/realtime/gemini/sessions/gemini-prod-session-2/events",
            "provider_event_relay_url": (
                "/production/realtime/gemini/browser-sessions/gemini-prod-session-2/provider-events"
            ),
            "disconnect_url": "/production/realtime/gemini/browser-sessions/gemini-prod-session-2",
            "browser_audio": "gemini_live_websocket_production_candidate",
            "transport": "gemini_browser_websocket_ephemeral_token_with_backend_relay",
            "websocket_url": "wss://gemini.example/live",
            "websocket_auth": "ephemeral_access_token",
            "ephemeral_token": {"value": "auth_tokens/test"},
            "setup": {"model": "models/gemini-live"},
            "public_event_boundary": "SophiaEventNormalizer",
        }

        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
            return_value=runtime_payload,
        ) as proxy_runtime, patch(
            "app.gateway.routers.voice._build_gemini_realtime_context_payload",
            new_callable=AsyncMock,
            return_value=realtime_context,
        ) as context_payload, patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
            side_effect=AssertionError("legacy /calls session route must not run in Gemini production mode"),
        ) as dispatch:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["runtime"] == "gemini_live"
        assert data["voice_runtime"] == "gemini_live"
        assert data["session_id"] == "gemini-prod-session-2"
        assert data["stream_url"] == "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-2"
        assert data["event_stream_url"] == "/api/sophia/voice/gemini/events?session_id=gemini-prod-session-2"
        assert data["provider_event_relay_url"] == "/api/sophia/voice/gemini/relay"
        assert data["disconnect_url"] == "/api/sophia/voice/gemini/disconnect"
        dispatch.assert_not_awaited()
        proxy_runtime.assert_awaited_once_with(
            "POST",
            "/production/realtime/gemini/browser-sessions",
            json_body={
                "user_id": "user_123",
                "session_id": ANY,
                "platform": "voice",
                "context_mode": "life",
                "ritual": None,
                "realtime_context": realtime_context,
            },
        )
        context_payload.assert_awaited_once()

    def test_explicit_legacy_runtime_keeps_stream_dispatch_when_promotion_flag_set(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_VOICE_RUNTIME_MODE", "legacy_cascade")
        monkeypatch.setenv("SOPHIA_VOICE_GEMINI_PRODUCTION_ROUTE_ENABLED", "true")

        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
        ) as proxy_runtime, patch(
            "app.gateway.routers.voice._dispatch_voice_agent",
            new_callable=AsyncMock,
            return_value="legacy-session-id",
        ) as dispatch:
            resp = client.post(
                "/api/sophia/user_123/voice/connect",
                json={"platform": "voice"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["runtime"] == "legacy_cascade"
        assert data["voice_runtime"] == "legacy_cascade"
        assert data["session_id"] == "legacy-session-id"
        proxy_runtime.assert_not_awaited()
        dispatch.assert_awaited_once_with(
            call_id=ANY,
            call_type="default",
            platform="voice",
            context_mode="life",
            ritual=None,
            session_id=None,
            thread_id=None,
        )

    @pytest.mark.anyio
    async def test_legacy_dispatch_posts_to_calls_session_endpoint(self):
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
                context_mode="life",
                ritual=None,
            )

        assert session_id == "test-session-id"
        mock_client.post.assert_awaited_once_with(
            f"{_get_voice_server_url()}/calls/sophia-user_123-abc12345/sessions",
            json={
                "call_type": "default",
                "platform": "voice",
                "context_mode": "life",
                "ritual": None,
                "session_id": None,
                "thread_id": None,
            },
        )


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


class TestOpenAIBrowserDogfoodGateway:
    def test_sideband_proxies_webrtc_readiness_with_sideband_timeout(self):
        readiness = {
            "ready": True,
            "reason": "connection_state_connected",
            "elapsed_ms": 42,
            "connection_state": "connected",
            "ice_connection_state": "connected",
            "data_channel_ready_state": "open",
        }

        with patch(
            "app.gateway.routers.voice._proxy_voice_dogfood_json",
            new_callable=AsyncMock,
            return_value={"attached": True, "call_id": "rtc_frontend_1"},
        ) as proxy:
            resp = client.post(
                "/api/sophia/user_123/voice/dogfood/openai/sideband",
                json={
                    "session_id": "browser-openai-1",
                    "call_id": "rtc_frontend_1",
                    "location": "https://api.openai.com/v1/realtime/calls/rtc_frontend_1",
                    "webrtc_readiness": readiness,
                },
            )

        assert resp.status_code == 202
        assert resp.json()["stream_url"] == (
            "/api/sophia/user_123/voice/dogfood/openai/events?session_id=browser-openai-1"
        )
        proxy.assert_awaited_once_with(
            "POST",
            "/dogfood/realtime/openai/browser-sessions/browser-openai-1/sideband",
            json_body={
                "call_id": "rtc_frontend_1",
                "location": "https://api.openai.com/v1/realtime/calls/rtc_frontend_1",
                "webrtc_readiness": readiness,
            },
            timeout=ANY,
        )


class TestGeminiBrowserDogfoodGateway:
    def test_browser_session_proxies_to_voice_service_and_rewrites_stream_url(self):
        with patch(
            "app.gateway.routers.voice._proxy_voice_dogfood_json",
            new_callable=AsyncMock,
            return_value={
                "session_id": "browser-gemini-1",
                "ephemeral_token": {"value": "auth_tokens/test"},
            },
        ) as proxy:
            resp = client.post(
                "/api/sophia/user_123/voice/dogfood/gemini/browser-session",
                json={"session_id": "browser-gemini-1"},
            )

        assert resp.status_code == 201
        assert resp.json()["stream_url"] == (
            "/api/sophia/user_123/voice/dogfood/gemini/events?session_id=browser-gemini-1"
        )
        proxy.assert_awaited_once_with(
            "POST",
            "/dogfood/realtime/gemini/browser-sessions",
            json_body={
                "user_id": "user_123",
                "session_id": "browser-gemini-1",
            },
        )

    def test_relay_proxies_to_voice_service_session_scoped_endpoint(self):
        with patch(
            "app.gateway.routers.voice._proxy_voice_dogfood_json",
            new_callable=AsyncMock,
            return_value={
                "accepted": True,
                "session_id": "browser-gemini-1",
                "client_actions": [
                    {
                        "type": "gemini_tool_response",
                        "payload": {
                            "toolResponse": {
                                "functionResponses": [
                                    {
                                        "id": "artifact-call-1",
                                        "name": "emit_artifact",
                                        "response": {
                                            "ok": True,
                                            "backend_tool_result": "Artifact recorded.",
                                        },
                                    }
                                ]
                            }
                        },
                    }
                ],
            },
        ) as proxy:
            resp = client.post(
                "/api/sophia/user_123/voice/dogfood/gemini/relay",
                json={
                    "session_id": "browser-gemini-1",
                    "event": {"serverContent": {"outputTranscription": {"text": "Hi."}}},
                    "provider_receive_sequence": 42,
                    "provider_relay_sequence": 7,
                    "provider_received_at": "2026-05-24T05:27:57.739Z",
                    "relay_correlation_id": "gemini-42",
                    "provider_primary_category": "outputTranscription",
                    "provider_categories": ["serverContent", "outputTranscription"],
                },
            )

        assert resp.status_code == 202
        assert resp.json()["client_actions"][0]["type"] == "gemini_tool_response"
        assert resp.json()["stream_url"] == (
            "/api/sophia/user_123/voice/dogfood/gemini/events?session_id=browser-gemini-1"
        )
        proxy.assert_awaited_once_with(
            "POST",
            "/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events",
            json_body={
                "event": {"serverContent": {"outputTranscription": {"text": "Hi."}}},
                "provider_receive_sequence": 42,
                "provider_relay_sequence": 7,
                "provider_received_at": "2026-05-24T05:27:57.739Z",
                "relay_correlation_id": "gemini-42",
                "provider_primary_category": "outputTranscription",
                "provider_categories": ["serverContent", "outputTranscription"],
            },
        )

    def test_relay_suppresses_review_only_emit_artifact_without_proxying(self):
        with patch(
            "app.gateway.routers.voice._proxy_voice_dogfood_json",
            new_callable=AsyncMock,
        ) as proxy:
            resp = client.post(
                "/api/sophia/user_123/voice/dogfood/gemini/relay",
                json={
                    "session_id": "browser-gemini-1",
                    "event": {
                        "toolCall": {
                            "functionCalls": [
                                {"id": "artifact-call-1", "name": "emit_artifact", "args": {"takeaway": "Churn"}}
                            ]
                        }
                    },
                    "provider_receive_sequence": 43,
                    "provider_relay_sequence": 8,
                    "provider_received_at": "2026-05-24T05:29:00.000Z",
                    "relay_correlation_id": "gemini-43",
                    "provider_primary_category": "toolCall",
                    "provider_categories": ["toolCall"],
                    "artifact_review_context": {
                        "active": True,
                        "artifact_id": "artifact-1",
                        "source": "coreview_still_frame",
                        "user_intent": "analysis",
                        "raw_transcript_excluded": True,
                        "raw_artifact_text_excluded": True,
                    },
                },
            )

        payload = resp.json()
        assert resp.status_code == 202
        proxy.assert_not_awaited()
        assert payload["stream_url"] == (
            "/api/sophia/user_123/voice/dogfood/gemini/events?session_id=browser-gemini-1"
        )
        assert payload["diagnostics"]["review_tool_churn_detected"] is True
        assert payload["diagnostics"]["suppressed_tool_count"] == 1
        assert payload["tool_diagnostics"][0]["execution_rejected"] is True
        assert payload["tool_diagnostics"][0]["rejection_reason"] == "artifact_review_emit_artifact_suppressed"
        function_response = (
            payload["client_actions"][0]["payload"]["toolResponse"]["functionResponses"][0]
        )
        assert function_response["id"] == "artifact-call-1"
        assert function_response["name"] == "emit_artifact"
        assert function_response["response"]["ok"] is False
        assert function_response["response"]["raw_artifact_text_excluded"] is True

    def test_relay_allows_explicit_review_create_update_intent_without_forwarding_context(self):
        with patch(
            "app.gateway.routers.voice._proxy_voice_dogfood_json",
            new_callable=AsyncMock,
            return_value={"accepted": True, "session_id": "browser-gemini-1"},
        ) as proxy:
            resp = client.post(
                "/api/sophia/user_123/voice/dogfood/gemini/relay",
                json={
                    "session_id": "browser-gemini-1",
                    "event": {
                        "toolCall": {
                            "functionCalls": [
                                {"id": "artifact-call-1", "name": "emit_artifact", "args": {"takeaway": "Update"}}
                            ]
                        }
                    },
                    "provider_receive_sequence": 44,
                    "provider_relay_sequence": 9,
                    "provider_received_at": "2026-05-24T05:29:05.000Z",
                    "relay_correlation_id": "gemini-44",
                    "provider_primary_category": "toolCall",
                    "provider_categories": ["toolCall"],
                    "artifact_review_context": {
                        "active": True,
                        "artifact_id": "artifact-1",
                        "source": "coreview_still_frame",
                        "user_intent": "create_update",
                        "raw_transcript_excluded": True,
                        "raw_artifact_text_excluded": True,
                    },
                },
            )

        assert resp.status_code == 202
        proxy.assert_awaited_once_with(
            "POST",
            "/dogfood/realtime/gemini/browser-sessions/browser-gemini-1/provider-events",
            json_body={
                "event": {
                    "toolCall": {
                        "functionCalls": [
                            {"id": "artifact-call-1", "name": "emit_artifact", "args": {"takeaway": "Update"}}
                        ]
                    }
                },
                "provider_receive_sequence": 44,
                "provider_relay_sequence": 9,
                "provider_received_at": "2026-05-24T05:29:05.000Z",
                "relay_correlation_id": "gemini-44",
                "provider_primary_category": "toolCall",
                "provider_categories": ["toolCall"],
            },
        )

    def test_production_relay_preserves_browser_source_metadata(self):
        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
            return_value={"accepted": True, "session_id": "gemini-prod-1"},
        ) as proxy:
            resp = client.post(
                "/api/sophia/user_123/voice/gemini/relay",
                json={
                    "session_id": "gemini-prod-1",
                    "event": {"serverContent": {"inputTranscription": {"text": "Wait, one more thing."}}},
                    "provider_receive_sequence": 84,
                    "provider_relay_sequence": 12,
                    "provider_received_at": "2026-05-24T05:28:01.000Z",
                    "relay_correlation_id": "gemini-84",
                    "provider_primary_category": "inputTranscription",
                    "provider_categories": ["serverContent", "inputTranscription"],
                },
            )

        assert resp.status_code == 202
        assert resp.json()["stream_url"] == "/api/sophia/voice/gemini/events?session_id=gemini-prod-1"
        proxy.assert_awaited_once_with(
            "POST",
            "/production/realtime/gemini/browser-sessions/gemini-prod-1/provider-events",
            json_body={
                "event": {"serverContent": {"inputTranscription": {"text": "Wait, one more thing."}}},
                "provider_receive_sequence": 84,
                "provider_relay_sequence": 12,
                "provider_received_at": "2026-05-24T05:28:01.000Z",
                "relay_correlation_id": "gemini-84",
                "provider_primary_category": "inputTranscription",
                "provider_categories": ["serverContent", "inputTranscription"],
            },
        )

    def test_production_relay_logs_safe_metadata_on_upstream_rejection(self, caplog):
        caplog.set_level(logging.WARNING)

        async def reject_runtime(*args, **kwargs):
            raise HTTPException(
                status_code=422,
                detail="Gemini Live toolCall omitted functionCalls.",
            )

        with patch(
            "app.gateway.routers.voice._proxy_voice_runtime_json",
            new_callable=AsyncMock,
            side_effect=reject_runtime,
        ):
            resp = client.post(
                "/api/sophia/user_123/voice/gemini/relay",
                json={
                    "session_id": "gemini-prod-sensitive",
                    "event": {"serverContent": {"inputTranscription": {"text": "private transcript"}}},
                    "provider_receive_sequence": 84,
                    "provider_relay_sequence": 12,
                    "relay_correlation_id": "gemini-84",
                    "provider_primary_category": "inputTranscription",
                    "provider_categories": ["serverContent", "inputTranscription"],
                },
            )

        assert resp.status_code == 422
        assert "voice.gemini.relay failed" in caplog.text
        assert "gemini-84" in caplog.text
        assert "inputTranscription" in caplog.text
        assert "private transcript" not in caplog.text


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

    def test_disconnect_is_cleanup_only_by_default(self):
        with patch(
            "app.gateway.routers.voice._disconnect_voice_session",
            new_callable=AsyncMock,
        ) as mock_disconnect, patch("app.gateway.routers.sophia._queue_offline_pipeline") as mock_queue:
            resp = client.post(
                "/api/sophia/user_123/voice/disconnect",
                json={"call_id": "sophia-user_123-abc12345", "session_id": "test-session-id"},
            )

        assert resp.status_code == 204
        mock_disconnect.assert_awaited_once_with("sophia-user_123-abc12345", "test-session-id")
        mock_queue.assert_not_called()

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
