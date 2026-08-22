from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request
from voice.server import _voice_event_cursor
from voice.sse_broker import VoiceEventBroker, format_sse_event


class _FakeRequest:
    def __init__(self) -> None:
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


def test_format_sse_event_uses_payload_type() -> None:
    assert format_sse_event(
        {"type": "sophia.transcript", "data": {"text": "Hello"}},
        event_id=7,
    ) == (
        'id: 7\n'
        'event: sophia.transcript\n'
        'data: {"type":"sophia.transcript","data":{"text":"Hello"}}\n\n'
    )


def _request(*, last_event_id: str | None = None, query: str = "") -> Request:
    headers = []
    if last_event_id is not None:
        headers.append((b"last-event-id", last_event_id.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/events",
            "headers": headers,
            "query_string": query.encode(),
        }
    )


def test_voice_event_cursor_prefers_header_and_accepts_query_fallback() -> None:
    assert _voice_event_cursor(_request(last_event_id="8", query="last_event_id=4")) == 8
    assert _voice_event_cursor(_request(query="last_event_id=9")) == 9
    assert _voice_event_cursor(_request(query="lastEventId=10")) == 10


def test_voice_event_cursor_ignores_invalid_values() -> None:
    assert _voice_event_cursor(_request(last_event_id="invalid", query="last_event_id=11")) == 11
    assert _voice_event_cursor(_request(last_event_id="-1")) is None


@pytest.mark.anyio
async def test_stream_delivers_published_events() -> None:
    broker = VoiceEventBroker(heartbeat_interval_seconds=1.0)
    request = _FakeRequest()
    stream = broker.stream("call-1", "session-1", request)

    next_message = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    await broker.publish(
        "call-1",
        "session-1",
        {"type": "sophia.artifact", "data": {"tone_estimate": 2.5}},
    )

    assert await next_message == (
        'id: 1\n'
        'event: sophia.artifact\n'
        'data: {"type":"sophia.artifact","data":{"tone_estimate":2.5}}\n\n'
    )

    await stream.aclose()


@pytest.mark.anyio
async def test_close_session_ends_active_stream() -> None:
    broker = VoiceEventBroker(heartbeat_interval_seconds=1.0)
    request = _FakeRequest()
    stream = broker.stream("call-1", "session-1", request)

    next_message = asyncio.create_task(anext(stream))
    await asyncio.sleep(0)
    await broker.close_session("call-1", "session-1")

    with pytest.raises(StopAsyncIteration):
        await next_message


@pytest.mark.anyio
async def test_forced_reconnect_replays_only_events_after_cursor() -> None:
    broker = VoiceEventBroker(heartbeat_interval_seconds=1.0)
    request = _FakeRequest()

    await broker.publish("call-1", "session-1", {"type": "sophia.turn", "data": {"phase": "one"}})
    await broker.publish("call-1", "session-1", {"type": "sophia.turn", "data": {"phase": "two"}})

    first_stream = broker.stream("call-1", "session-1", request)
    assert (await anext(first_stream)).startswith("id: 1\n")
    assert (await anext(first_stream)).startswith("id: 2\n")
    await first_stream.aclose()

    await broker.publish("call-1", "session-1", {"type": "sophia.turn", "data": {"phase": "three"}})
    second_stream = broker.stream("call-1", "session-1", request, after_event_id=2)
    replayed = await anext(second_stream)
    assert replayed.startswith("id: 3\n")
    assert '"phase":"three"' in replayed
    await second_stream.aclose()

    await broker.publish("call-1", "session-1", {"type": "sophia.turn", "data": {"phase": "four"}})
    third_stream = broker.stream("call-1", "session-1", request, after_event_id=3)
    replayed_again = await anext(third_stream)
    assert replayed_again.startswith("id: 4\n")
    assert '"phase":"four"' in replayed_again
    await third_stream.aclose()
