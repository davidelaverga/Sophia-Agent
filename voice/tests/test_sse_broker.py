from __future__ import annotations

import asyncio

import pytest

from voice.sse_broker import VoiceEventBroker, format_sse_event


class _FakeRequest:
    def __init__(self) -> None:
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


def test_format_sse_event_uses_payload_type() -> None:
    assert format_sse_event(
        {"type": "sophia.transcript", "data": {"text": "Hello"}},
    ) == (
        'event: sophia.transcript\n'
        'data: {"type":"sophia.transcript","data":{"text":"Hello"}}\n\n'
    )


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