from __future__ import annotations

import pytest

from voice.adapters.base import BackendRequest
from voice.adapters.shim import ShimBackendAdapter
from voice.tests.conftest import make_settings


@pytest.mark.anyio
async def test_shim_streams_text_then_artifact() -> None:
    adapter = ShimBackendAdapter(make_settings(shim_chunk_delay_ms=0))
    request = BackendRequest(
        text="I feel stressed.",
        user_id="user-1",
        platform="voice",
        ritual=None,
        context_mode="life",
    )

    events = [event async for event in adapter.stream_events(request)]

    assert [event.kind for event in events[:-1]] == ["text", "text"]
    assert events[-1].kind == "artifact"
    assert events[-1].artifact is not None
    assert events[-1].artifact["voice_speed"] == "gentle"


@pytest.mark.anyio
async def test_shim_can_emit_stage_error() -> None:
    adapter = ShimBackendAdapter(
        make_settings(
            shim_chunk_delay_ms=0,
            shim_failure_stage="stream",
            shim_failure_message="stream broke",
        )
    )
    request = BackendRequest(
        text="I feel stressed.",
        user_id="user-1",
        platform="voice",
        ritual=None,
        context_mode="life",
    )

    events = [event async for event in adapter.stream_events(request)]

    assert [event.kind for event in events] == ["text", "error"]
    assert events[-1].stage == "backend-stream"