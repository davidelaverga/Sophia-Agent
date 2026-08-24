from __future__ import annotations

import asyncio
import json
import sys
import types
from collections.abc import AsyncIterator, Mapping
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import voice.realtime.openai_browser_dogfood as openai_browser_dogfood
from voice.realtime import (
    OpenAIBrowserDogfoodSessionManager,
    OpenAIRealtimeClientSecret,
    OpenAISidebandAttachError,
    OpenAISidebandAttachment,
    OpenAISidebandSessionManager,
    RealtimeDogfoodSessionManager,
    VoiceRuntimeMode,
    extract_openai_call_id_from_location,
    is_valid_openai_call_id,
)
from voice.realtime.openai_browser_dogfood import (
    build_openai_sideband_ws_urls,
    build_openai_webrtc_call_diagnostics,
    default_openai_sideband_connector,
)
from voice.tests.conftest import make_settings


def _openai_settings():  # noqa: ANN202
    return make_settings(
        voice_runtime_mode=VoiceRuntimeMode.OPENAI_REALTIME.value,
        experimental_realtime_runtime_enabled=True,
        openai_realtime_adapter_enabled=True,
    )


def _set_openai_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STREAM_API_KEY", "stream-key")
    monkeypatch.setenv("STREAM_API_SECRET", "stream-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "standard-openai-key")
    monkeypatch.setenv("SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED", "true")


class FakeClientSecretMinter:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def mint_client_secret(
        self,
        *,
        api_key: str,
        session_config: Mapping[str, Any],
        safety_identifier: str | None = None,
    ) -> OpenAIRealtimeClientSecret:
        self.requests.append(
            {
                "api_key": api_key,
                "session_config": dict(session_config),
                "safety_identifier": safety_identifier,
            }
        )
        return OpenAIRealtimeClientSecret(
            value="ek_test_ephemeral",
            expires_at=1_900_000_000,
            session={"id": "sess-openai-browser-1"},
        )


class FakeSidebandConnection:
    def __init__(self, events: list[Mapping[str, Any]]) -> None:
        self.events = events
        self.sent_events: list[dict[str, Any]] = []
        self.closed = False

    async def send_json(self, payload: Mapping[str, Any]) -> None:
        self.sent_events.append(dict(payload))

    async def close(self) -> None:
        self.closed = True

    async def messages(self) -> AsyncIterator[Mapping[str, Any]]:
        for event in self.events:
            await asyncio.sleep(0)
            yield event


class FakeSidebandConnector:
    def __init__(self, connection: FakeSidebandConnection) -> None:
        self.connection = connection
        self.calls: list[dict[str, str | None]] = []

    async def __call__(
        self,
        *,
        call_id: str,
        api_key: str,
        location: str | None = None,
    ) -> OpenAISidebandAttachment:
        self.calls.append({"call_id": call_id, "api_key": api_key, "location": location})
        return OpenAISidebandAttachment(
            connection=self.connection,
            url=f"wss://api.openai.com/v1/realtime?call_id={call_id}",
        )


class FailOnceSidebandConnector:
    def __init__(self) -> None:
        self.calls: list[dict[str, str | None]] = []
        self.connections: list[FakeSidebandConnection] = []

    async def __call__(
        self,
        *,
        call_id: str,
        api_key: str,
        location: str | None = None,
    ) -> OpenAISidebandAttachment:
        self.calls.append({"call_id": call_id, "api_key": api_key, "location": location})
        if len(self.calls) == 1:
            raise OpenAISidebandAttachError(
                "OpenAI sideband websocket attach failed: "
                f"wss://api.openai.com/v1/realtime?call_id={call_id} -> HTTP 404; "
                "attempt=4/4; retryable=false; elapsed_ms=1021; request_id=req_retry_404; "
                "error_type=InvalidStatusCode; error=server rejected WebSocket connection: HTTP 404"
            )

        connection = FakeSidebandConnection([])
        self.connections.append(connection)
        return OpenAISidebandAttachment(
            connection=connection,
            url=f"wss://api.openai.com/v1/realtime?call_id={call_id}",
        )


class HangingSidebandConnector:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = False

    async def __call__(
        self,
        *,
        call_id: str,
        api_key: str,
        location: str | None = None,
    ) -> OpenAISidebandAttachment:
        _ = call_id, api_key, location
        self.started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled = True
            raise


def test_openai_call_id_helpers_require_rtc_location_ids() -> None:
    assert is_valid_openai_call_id("rtc_u1_abc-123") is True
    assert extract_openai_call_id_from_location("https://api.openai.com/v1/realtime/calls/rtc_u1_abc-123") == "rtc_u1_abc-123"
    assert extract_openai_call_id_from_location("/v1/realtime/calls/rtc_u1_abc-123?foo=bar") == "rtc_u1_abc-123"
    assert extract_openai_call_id_from_location("https://example.com/calls/not-a-call") is None
    assert is_valid_openai_call_id("call_abc") is False
    assert is_valid_openai_call_id("rtc_bad/../id") is False


def test_openai_webrtc_call_diagnostics_preserve_raw_location_and_shape() -> None:
    documented = build_openai_webrtc_call_diagnostics(
        requested_model="gpt-realtime-2",
        sdp_status=200,
        raw_location="https://api.openai.com/v1/realtime/calls/rtc_u1_abc-123",
        extracted_call_id="rtc_u1_abc-123",
    ).as_dict()

    assert documented == {
        "requested_model": "gpt-realtime-2",
        "sdp_status": 200,
        "raw_location": "https://api.openai.com/v1/realtime/calls/rtc_u1_abc-123",
        "extracted_call_id": "rtc_u1_abc-123",
        "location_matches_documented_shape": True,
        "call_id_matches_documented_shape": True,
        "unexpected_location_variant": None,
    }

    unexpected = build_openai_webrtc_call_diagnostics(
        raw_location="/v1/realtime/calls/call_u1_abc-123",
        extracted_call_id=None,
    ).as_dict()

    assert unexpected["location_matches_documented_shape"] is False
    assert unexpected["call_id_matches_documented_shape"] is False
    assert unexpected["unexpected_location_variant"] == "unexpected_call_id_prefix:call"


@pytest.mark.anyio
async def test_browser_session_mints_ephemeral_client_secret_without_promoting_default_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_openai_env(monkeypatch)
    realtime_sessions = RealtimeDogfoodSessionManager()
    fake_minter = FakeClientSecretMinter()
    manager = OpenAIBrowserDogfoodSessionManager(
        realtime_sessions,
        client_secret_minter=fake_minter,  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _openai_settings(),
        user_id="user-1",
        session_id="browser-openai-1",
        instructions="Speak as Sophia.",
    )

    payload = browser_session.as_public_payload()
    assert payload["session_id"] == "browser-openai-1"
    assert payload["runtime"] == "openai_realtime"
    assert payload["browser_audio"] == "openai_webrtc_experimental"
    assert payload["transport"] == "openai_browser_webrtc_with_server_sideband"
    assert payload["requested_model"] == "gpt-realtime-2"
    assert payload["openai_diagnostics"] == {
        "requested_model": "gpt-realtime-2",
        "client_secret_session_model": None,
    }
    assert payload["client_secret"] == {
        "value": "ek_test_ephemeral",
        "expires_at": 1_900_000_000,
        "session": {"id": "sess-openai-browser-1"},
    }
    assert fake_minter.requests[0]["api_key"] == "standard-openai-key"
    safety_identifier = fake_minter.requests[0]["safety_identifier"]
    assert isinstance(safety_identifier, str)
    assert safety_identifier.startswith("sophia_user_")
    assert "user-1" not in safety_identifier
    assert fake_minter.requests[0]["session_config"]["type"] == "realtime"
    assert fake_minter.requests[0]["session_config"]["model"] == "gpt-realtime-2"
    assert fake_minter.requests[0]["session_config"]["audio"]["output"]["voice"] == "marin"
    assert payload["client_secret"]["value"] != "standard-openai-key"

    legacy_manager = OpenAIBrowserDogfoodSessionManager(RealtimeDogfoodSessionManager())
    with pytest.raises(Exception, match="openai_realtime"):
        await legacy_manager.start_browser_session(make_settings(), user_id="user-1")

    await manager.close_session("browser-openai-1")


@pytest.mark.anyio
async def test_close_session_is_safe_and_idempotent_without_sideband_attachment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_openai_env(monkeypatch)
    fake_minter = FakeClientSecretMinter()
    manager = OpenAIBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        client_secret_minter=fake_minter,  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _openai_settings(),
        user_id="user-1",
        session_id="browser-openai-cleanup-1",
    )

    instructions = fake_minter.requests[0]["session_config"]["instructions"]
    assert "### Voice Skill State" in instructions
    assert "session_count: unknown" in instructions
    assert "challenging_growth_allowed: false" in instructions
    assert "consult_skill" not in instructions

    assert await manager.close_session(browser_session.dogfood_session.session_id) is True
    assert await manager.close_session(browser_session.dogfood_session.session_id) is False


@pytest.mark.anyio
async def test_sideband_messages_enter_existing_adapter_and_normalizer_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_openai_env(monkeypatch)
    fake_connection = FakeSidebandConnection(
        [
            {"type": "response.created", "response": {"id": "resp-openai-1"}},
            {
                "type": "response.output_audio_transcript.delta",
                "response_id": "resp-openai-1",
                "delta": "Hello from browser WebRTC.",
            },
            {
                "type": "response.output_audio_transcript.done",
                "response_id": "resp-openai-1",
            },
            {
                "type": "response.done",
                "response": {"id": "resp-openai-1", "status": "completed", "output": []},
            },
        ]
    )
    fake_connector = FakeSidebandConnector(fake_connection)
    realtime_sessions = RealtimeDogfoodSessionManager()
    manager = OpenAIBrowserDogfoodSessionManager(
        realtime_sessions,
        client_secret_minter=FakeClientSecretMinter(),  # type: ignore[arg-type]
        sideband_sessions=OpenAISidebandSessionManager(fake_connector),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _openai_settings(),
        user_id="user-1",
        session_id="browser-openai-2",
    )

    sideband = await manager.attach_sideband(
        _openai_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        call_id="rtc_browser_1",
        location="https://api.openai.com/v1/realtime/calls/rtc_browser_1",
        call_diagnostics={
            "requested_model": "gpt-realtime-2",
            "sdp_status": 200,
            "raw_location": "https://api.openai.com/v1/realtime/calls/rtc_browser_1",
            "extracted_call_id": "rtc_browser_1",
        },
        webrtc_readiness={
            "ready": True,
            "reason": "connection_state_connected",
            "elapsed_ms": 12,
            "session_alive_ms": 2300,
            "remote_audio_active": True,
            "connection_state": "connected",
            "ice_connection_state": "connected",
            "data_channel_ready_state": "open",
            "ignored": "not forwarded",
        },
    )
    payloads = await browser_session.dogfood_session.wait_for_public_payloads(4)

    assert fake_connector.calls == [{
        "call_id": "rtc_browser_1",
        "api_key": "standard-openai-key",
        "location": "https://api.openai.com/v1/realtime/calls/rtc_browser_1",
    }]
    assert sideband.metadata()["attached"] is True
    assert sideband.metadata()["sideband_url"] == "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1"
    assert sideband.metadata()["call_diagnostics"] == {
        "requested_model": "gpt-realtime-2",
        "sdp_status": 200,
        "raw_location": "https://api.openai.com/v1/realtime/calls/rtc_browser_1",
        "extracted_call_id": "rtc_browser_1",
        "location_matches_documented_shape": True,
        "call_id_matches_documented_shape": True,
        "unexpected_location_variant": None,
    }
    assert sideband.metadata()["webrtc_readiness"] == {
        "ready": True,
        "reason": "connection_state_connected",
        "elapsed_ms": 12,
        "session_alive_ms": 2300,
        "remote_audio_active": True,
        "connection_state": "connected",
        "ice_connection_state": "connected",
        "data_channel_ready_state": "open",
    }
    assert [payload["type"] for payload in payloads] == [
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.turn",
    ]
    assert payloads[1]["data"] == {
        "text": "Hello from browser WebRTC.",
        "is_final": False,
        "assistant_transcript_source": "output_audio_transcript",
    }
    assert all(str(payload["type"]).startswith("sophia.") for payload in payloads)
    assert "response.output_audio_transcript" not in json.dumps(payloads)

    await manager.close_session("browser-openai-2")
    assert fake_connection.closed is True


@pytest.mark.anyio
async def test_close_session_cancels_in_flight_sideband_attach(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_openai_env(monkeypatch)
    hanging_connector = HangingSidebandConnector()
    realtime_sessions = RealtimeDogfoodSessionManager()
    manager = OpenAIBrowserDogfoodSessionManager(
        realtime_sessions,
        client_secret_minter=FakeClientSecretMinter(),  # type: ignore[arg-type]
        sideband_sessions=OpenAISidebandSessionManager(hanging_connector),  # type: ignore[arg-type]
    )
    browser_session = await manager.start_browser_session(
        _openai_settings(),
        user_id="user-1",
        session_id="browser-openai-cancel-1",
    )

    attach_task = asyncio.create_task(
        manager.attach_sideband(
            _openai_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            call_id="rtc_browser_1",
            webrtc_readiness={"ready": True, "reason": "connection_state_connected"},
        )
    )
    await asyncio.wait_for(hanging_connector.started.wait(), timeout=1.0)

    assert await manager.close_session("browser-openai-cancel-1") is True
    with pytest.raises(OpenAISidebandAttachError, match="dogfood session closed"):
        await attach_task
    assert hanging_connector.cancelled is True


@pytest.mark.anyio
async def test_sideband_attach_can_be_retried_after_live_failure_without_closing_browser_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_openai_env(monkeypatch)
    flaky_connector = FailOnceSidebandConnector()
    manager = OpenAIBrowserDogfoodSessionManager(
        RealtimeDogfoodSessionManager(),
        client_secret_minter=FakeClientSecretMinter(),  # type: ignore[arg-type]
        sideband_sessions=OpenAISidebandSessionManager(flaky_connector),  # type: ignore[arg-type]
    )

    browser_session = await manager.start_browser_session(
        _openai_settings(),
        user_id="user-1",
        session_id="browser-openai-retry-1",
    )

    with pytest.raises(OpenAISidebandAttachError, match="request_id=req_retry_404"):
        await manager.attach_sideband(
            _openai_settings(),
            dogfood_session_id=browser_session.dogfood_session.session_id,
            call_id="rtc_browser_1",
            location="https://api.openai.com/v1/realtime/calls/rtc_browser_1",
            webrtc_readiness={
                "ready": True,
                "reason": "connection_state_connected",
                "elapsed_ms": 18,
                "session_alive_ms": 2100,
                "remote_audio_active": False,
                "connection_state": "connected",
                "ice_connection_state": "connected",
                "data_channel_ready_state": "open",
            },
        )

    assert browser_session.dogfood_session.closed is False

    sideband = await manager.attach_sideband(
        _openai_settings(),
        dogfood_session_id=browser_session.dogfood_session.session_id,
        call_id="rtc_browser_1",
        location="https://api.openai.com/v1/realtime/calls/rtc_browser_1",
        webrtc_readiness={
            "ready": True,
            "reason": "connection_state_connected",
            "elapsed_ms": 27,
            "session_alive_ms": 4300,
            "remote_audio_active": True,
            "connection_state": "connected",
            "ice_connection_state": "connected",
            "data_channel_ready_state": "open",
        },
    )

    assert len(flaky_connector.calls) == 2
    assert sideband.metadata()["attached"] is True
    assert sideband.metadata()["call_id"] == "rtc_browser_1"
    assert sideband.metadata()["webrtc_readiness"] == {
        "ready": True,
        "reason": "connection_state_connected",
        "elapsed_ms": 27,
        "session_alive_ms": 4300,
        "remote_audio_active": True,
        "connection_state": "connected",
        "ice_connection_state": "connected",
        "data_channel_ready_state": "open",
    }

    await manager.close_session("browser-openai-retry-1")
    assert flaky_connector.connections[0].closed is True


def test_openai_browser_endpoint_fails_safely_when_runtime_is_legacy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from voice import server as voice_server

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)
    monkeypatch.setattr(voice_server, "get_settings", lambda: make_settings())

    response = TestClient(app).post(
        "/dogfood/realtime/openai/browser-sessions",
        json={"user_id": "user-1"},
    )

    assert response.status_code == 409
    assert "openai_realtime" in response.json()["detail"]


def test_openai_sideband_endpoint_rejects_missing_call_id() -> None:
    from voice import server as voice_server

    app = FastAPI()
    app.include_router(voice_server.dogfood_router)

    response = TestClient(app).post(
        "/dogfood/realtime/openai/browser-sessions/missing-session/sideband",
        json={},
    )

    assert response.status_code == 422
    assert "rtc_*" in response.json()["detail"]


def test_build_openai_sideband_ws_urls_uses_documented_query_url_only() -> None:
    assert build_openai_sideband_ws_urls(
        call_id="rtc_browser_1",
        location="https://api.openai.com/v1/realtime/calls/calls/rtc_browser_1",
    ) == (
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
    )


@pytest.mark.anyio
async def test_default_openai_sideband_connector_wraps_handshake_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempted_urls: list[str] = []
    observed_headers: list[dict[str, str]] = []

    async def fake_connect(
        url: str,
        *,
        additional_headers: dict[str, str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        attempted_urls.append(url)
        observed_headers.append(dict(additional_headers or extra_headers or {}))
        raise RuntimeError("server rejected WebSocket connection: HTTP 404")

    monkeypatch.setitem(sys.modules, "websockets", types.SimpleNamespace(connect=fake_connect))
    monkeypatch.setattr(
        openai_browser_dogfood,
        "_OPENAI_SIDEBAND_READY_RETRY_DELAYS_SECONDS",
        (0, 0, 0),
    )

    with pytest.raises(OpenAISidebandAttachError, match="OpenAI sideband websocket attach failed") as exc_info:
        await default_openai_sideband_connector(
            call_id="rtc_browser_1",
            api_key="standard-openai-key",
            location="https://api.openai.com/v1/realtime/calls/rtc_browser_1",
        )

    assert attempted_urls == [
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
    ]
    assert observed_headers == [
        {
            "Authorization": "Bearer standard-openai-key",
            "OpenAI-Beta": "realtime=v1",
        },
        {
            "Authorization": "Bearer standard-openai-key",
            "OpenAI-Beta": "realtime=v1",
        },
        {
            "Authorization": "Bearer standard-openai-key",
            "OpenAI-Beta": "realtime=v1",
        },
        {
            "Authorization": "Bearer standard-openai-key",
            "OpenAI-Beta": "realtime=v1",
        },
    ]
    assert "HTTP 404" in str(exc_info.value)
    assert "attempt=4/4" in str(exc_info.value)
    assert "retryable=false" in str(exc_info.value)


@pytest.mark.anyio
async def test_default_openai_sideband_connector_retries_readiness_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempted_urls: list[str] = []
    observed_headers: list[dict[str, str]] = []

    async def fake_connect(
        url: str,
        *,
        additional_headers: dict[str, str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> object:
        attempted_urls.append(url)
        observed_headers.append(dict(additional_headers or extra_headers or {}))
        if len(attempted_urls) < 3:
            raise RuntimeError("server rejected WebSocket connection: HTTP 404")
        return object()

    monkeypatch.setitem(sys.modules, "websockets", types.SimpleNamespace(connect=fake_connect))
    monkeypatch.setattr(
        openai_browser_dogfood,
        "_OPENAI_SIDEBAND_READY_RETRY_DELAYS_SECONDS",
        (0, 0, 0),
    )

    attachment = await default_openai_sideband_connector(
        call_id="rtc_browser_1",
        api_key="standard-openai-key",
        location="https://api.openai.com/v1/realtime/calls/rtc_browser_1",
    )

    assert attachment.url == "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1"
    assert attempted_urls == [
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
        "wss://api.openai.com/v1/realtime?call_id=rtc_browser_1",
    ]
    assert all(
        headers == {
            "Authorization": "Bearer standard-openai-key",
            "OpenAI-Beta": "realtime=v1",
        }
        for headers in observed_headers
    )


@pytest.mark.anyio
async def test_default_openai_sideband_connector_does_not_retry_auth_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempted_urls: list[str] = []

    async def fake_connect(
        url: str,
        *,
        additional_headers: dict[str, str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        _ = additional_headers, extra_headers
        attempted_urls.append(url)
        raise RuntimeError("server rejected WebSocket connection: HTTP 401")

    monkeypatch.setitem(sys.modules, "websockets", types.SimpleNamespace(connect=fake_connect))
    monkeypatch.setattr(
        openai_browser_dogfood,
        "_OPENAI_SIDEBAND_READY_RETRY_DELAYS_SECONDS",
        (0, 0, 0),
    )

    with pytest.raises(OpenAISidebandAttachError) as exc_info:
        await default_openai_sideband_connector(
            call_id="rtc_browser_1",
            api_key="standard-openai-key",
        )

    assert attempted_urls == ["wss://api.openai.com/v1/realtime?call_id=rtc_browser_1"]
    assert "HTTP 401" in str(exc_info.value)
    assert "attempt=1/4" in str(exc_info.value)
    assert "retryable=false" in str(exc_info.value)
