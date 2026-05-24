from __future__ import annotations

from typing import Any

import pytest

from voice.realtime.openai_sideband_probe import probe_openai_sideband_attach


class FakeProbeWebSocket:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeSuccessfulWebsockets:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.websocket = FakeProbeWebSocket()

    async def connect(
        self,
        url: str,
        *,
        additional_headers: dict[str, str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> FakeProbeWebSocket:
        self.calls.append({"url": url, "headers": additional_headers or extra_headers})
        return self.websocket


class FakeHeaders(dict[str, str]):
    pass


class FakeRejectedResponse:
    status_code = 404
    headers = FakeHeaders({"x-request-id": "req_probe_404"})


class FakeRejectedHandshake(Exception):
    response = FakeRejectedResponse()


class FakeFailingWebsockets:
    async def connect(
        self,
        url: str,
        *,
        additional_headers: dict[str, str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        _ = url, additional_headers, extra_headers
        raise FakeRejectedHandshake("server rejected WebSocket connection: HTTP 404")


@pytest.mark.anyio
async def test_sideband_probe_uses_documented_query_param_url_and_standard_key_only() -> None:
    websockets = FakeSuccessfulWebsockets()

    result = await probe_openai_sideband_attach(
        call_id="rtc_probe_1",
        api_key="standard-openai-key",
        websockets_module=websockets,
    )

    assert result.ok is True
    assert result.url == "wss://api.openai.com/v1/realtime?call_id=rtc_probe_1"
    assert websockets.calls == [
        {
            "url": "wss://api.openai.com/v1/realtime?call_id=rtc_probe_1",
            "headers": {"Authorization": "Bearer standard-openai-key"},
        }
    ]
    assert websockets.websocket.closed is True


@pytest.mark.anyio
async def test_sideband_probe_reports_handshake_404_and_request_id() -> None:
    result = await probe_openai_sideband_attach(
        call_id="rtc_probe_1",
        api_key="standard-openai-key",
        websockets_module=FakeFailingWebsockets(),
    )

    assert result.ok is False
    assert result.url == "wss://api.openai.com/v1/realtime?call_id=rtc_probe_1"
    assert result.status_code == 404
    assert result.request_id == "req_probe_404"
    assert result.error_type == "FakeRejectedHandshake"
    assert "HTTP 404" in (result.error or "")


@pytest.mark.anyio
async def test_sideband_probe_rejects_non_rtc_call_ids() -> None:
    with pytest.raises(ValueError, match="rtc_"):
        await probe_openai_sideband_attach(
            call_id="call_probe_1",
            api_key="standard-openai-key",
            websockets_module=FakeSuccessfulWebsockets(),
        )
