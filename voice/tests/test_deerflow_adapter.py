from __future__ import annotations

import json

import httpx
import pytest

from voice.adapters.base import BackendRequest
from voice.adapters.deerflow import DeerFlowBackendAdapter
from voice.tests.conftest import make_settings


def _valid_artifact() -> dict[str, object]:
    return {
        "session_goal": "Week 1 voice proof",
        "active_goal": "Keep the user in a short, grounded loop.",
        "next_step": "Listen for the next user turn.",
        "takeaway": "The adapter exercised streaming text and artifact delivery.",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "free_conversation.opening",
        "voice_emotion_primary": "calm",
        "voice_emotion_secondary": "sympathetic",
        "voice_speed": "gentle",
    }


def _sse_response(*lines: str) -> httpx.Response:
    body = "\n\n".join(lines) + "\n\n"
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=body,
    )


def _make_request() -> BackendRequest:
    return BackendRequest(
        text="hello",
        user_id="user-1",
        platform="voice",
        ritual="prepare",
        context_mode="work",
    )


# ---- Probe tests ----


@pytest.mark.anyio
async def test_probe_accepts_assistant_search_endpoint() -> None:
    request_paths: list[str] = []
    request_payloads: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request_paths.append(request.url.path)
        if request.url.path == "/assistants/search":
            request_payloads.append(json.loads(request.content))
            return httpx.Response(200, json=[{"graph_id": "sophia_companion"}])
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        await adapter.probe()

    assert request_paths == ["/assistants/search"]
    assert request_payloads == [{"graph_id": "sophia_companion", "limit": 1}]


@pytest.mark.anyio
async def test_probe_reports_missing_assistant_from_search_endpoint() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/assistants/search":
            return httpx.Response(200, json=[])
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        with pytest.raises(Exception, match="sophia_companion"):
            await adapter.probe()


# ---- Stream events tests ----


@pytest.mark.anyio
async def test_stream_events_text_and_artifact_via_content_blocks() -> None:
    """Happy path: text from content blocks, artifact from tool_use + input_json_delta."""
    artifact = _valid_artifact()
    run_payloads: list[dict[str, object]] = []
    request_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request_paths.append(request.url.path)
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            run_payloads.append(json.loads(request.content))
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {"type": "AIMessageChunk", "content": [{"text": "Hello ", "type": "text", "index": 0}]},
                    {"id": "meta-1"},
                ]),
                "data: " + json.dumps([
                    {"type": "AIMessageChunk", "content": [{"text": "there", "type": "text", "index": 0}]},
                    {"id": "meta-2"},
                ]),
                "data: " + json.dumps([
                    {"type": "AIMessageChunk", "content": [{"id": "tool-1", "type": "tool_use", "name": "emit_artifact"}]},
                    {"id": "meta-3"},
                ]),
                "data: " + json.dumps([
                    {"type": "AIMessageChunk", "content": [{"type": "input_json_delta", "partial_json": json.dumps(artifact), "index": 1}]},
                    {"id": "meta-4"},
                ]),
                "data: " + json.dumps([
                    {"type": "tool", "name": "emit_artifact", "content": "Artifact recorded."},
                    {"id": "meta-5"},
                ]),
                "data: [DONE]",
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)
    settings = make_settings(
        backend_mode="deerflow",
        context_mode="work",
        ritual="prepare",
    )

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(settings, client=client)
        events = [event async for event in adapter.stream_events(_make_request())]

    assert request_paths == ["/threads", "/threads/thread-123/runs/stream"]
    assert [event.kind for event in events] == ["text", "text", "artifact"]
    assert [event.text for event in events[:2]] == ["Hello ", "there"]
    assert events[2].artifact == artifact
    assert run_payloads == [
        {
            "assistant_id": "sophia_companion",
            "input": {"messages": [{"role": "user", "content": "hello"}]},
            "config": {
                "configurable": {
                    "user_id": "user-1",
                    "platform": "voice",
                    "ritual": "prepare",
                    "context_mode": "work",
                    "thread_id": "thread-123",
                }
            },
            "stream_mode": ["messages-tuple"],
        }
    ]


@pytest.mark.anyio
async def test_stream_events_report_invalid_json_as_backend_contract_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response("data: not-json")
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert len(events) == 1
    assert events[0].kind == "error"
    assert events[0].stage == "backend-contract"
    assert events[0].recoverable is False
    assert "invalid JSON" in (events[0].message or "")


@pytest.mark.anyio
async def test_stream_events_report_data_level_error() -> None:
    """Data-level error (type=run_error) detected without event: error line."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "data: " + json.dumps({"type": "run_error", "data": "boom"})
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert len(events) == 1
    assert events[0].kind == "error"
    assert events[0].stage == "backend-stream"
    assert "boom" in (events[0].message or "")


@pytest.mark.anyio
async def test_stream_events_sse_error_event() -> None:
    """SSE event: error line with message payload."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: error",
                "data: " + json.dumps({"message": "Internal error"}),
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert len(events) == 1
    assert events[0].kind == "error"
    assert events[0].stage == "backend-stream"
    assert "Internal error" in (events[0].message or "")


@pytest.mark.anyio
async def test_stream_events_report_malformed_emit_artifact_payloads() -> None:
    """Tool_use start with no input_json_delta results in unparseable artifact."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {"type": "AIMessageChunk", "content": [{"text": "Hello there", "type": "text", "index": 0}]},
                    {"id": "meta-1"},
                ]),
                "data: " + json.dumps([
                    {"type": "AIMessageChunk", "content": [{"id": "tool-1", "type": "tool_use", "name": "emit_artifact"}]},
                    {"id": "meta-2"},
                ]),
                "data: " + json.dumps([
                    {"type": "tool", "name": "emit_artifact", "content": ""},
                    {"id": "meta-3"},
                ]),
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert [event.kind for event in events] == ["text", "error"]
    assert events[1].stage == "backend-contract"
    assert events[1].recoverable is False
    assert "emit_artifact" in (events[1].message or "")


@pytest.mark.anyio
async def test_stream_events_accept_complete_ai_message_with_string_content() -> None:
    """Complete AI message (type=ai) with string content and tool_calls array."""
    artifact = _valid_artifact()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {
                        "type": "ai",
                        "content": "Hello there",
                        "tool_calls": [
                            {"name": "emit_artifact", "args": artifact, "id": "call-1", "type": "tool_call"},
                        ],
                    },
                    {"id": "meta-1"},
                ]),
                "data: " + json.dumps([
                    {"type": "tool", "name": "emit_artifact", "content": "Artifact recorded."},
                    {"id": "meta-2"},
                ]),
                "data: [DONE]",
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert [event.kind for event in events] == ["text", "artifact"]
    assert events[0].text == "Hello there"
    assert events[1].artifact == artifact


@pytest.mark.anyio
async def test_stream_events_artifact_from_tool_calls_array() -> None:
    """AIMessageChunk with content blocks and tool_calls array for artifact."""
    artifact = _valid_artifact()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {
                        "type": "AIMessageChunk",
                        "content": [{"text": "I", "type": "text", "index": 0}],
                        "tool_calls": [],
                    },
                    {"id": "meta-1"},
                ]),
                "data: " + json.dumps([
                    {
                        "type": "AIMessageChunk",
                        "content": [{"text": "'m here.", "type": "text", "index": 0}],
                        "tool_calls": [
                            {"name": "emit_artifact", "args": artifact, "id": "call-1", "type": "tool_call"},
                        ],
                    },
                    {"id": "meta-2"},
                ]),
                "data: [DONE]",
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert [event.kind for event in events] == ["text", "text", "artifact"]
    assert [event.text for event in events[:2]] == ["I", "'m here."]
    assert events[2].artifact == artifact


@pytest.mark.anyio
async def test_stream_events_ignore_partial_emit_artifact_args() -> None:
    """Empty tool_calls args are skipped; complete args are emitted."""
    artifact = _valid_artifact()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {
                        "type": "AIMessageChunk",
                        "content": [],
                        "tool_calls": [
                            {"name": "emit_artifact", "args": {}, "id": "call-1", "type": "tool_call"},
                        ],
                    },
                    {"id": "meta-1"},
                ]),
                "data: " + json.dumps([
                    {
                        "type": "AIMessageChunk",
                        "content": [{"text": "Hello", "type": "text", "index": 0}],
                        "tool_calls": [
                            {"name": "emit_artifact", "args": artifact, "id": "call-1", "type": "tool_call"},
                        ],
                    },
                    {"id": "meta-2"},
                ]),
                "data: [DONE]",
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert [event.kind for event in events] == ["text", "artifact"]
    assert events[0].text == "Hello"
    assert events[1].artifact == artifact


@pytest.mark.anyio
async def test_stream_events_emit_artifact_only_once() -> None:
    """Artifact from tool_calls array wins; subsequent tool message does not duplicate."""
    artifact = _valid_artifact()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {
                        "type": "AIMessageChunk",
                        "content": [{"text": "Hi", "type": "text", "index": 0}],
                        "tool_calls": [
                            {"name": "emit_artifact", "args": artifact, "id": "call-1", "type": "tool_call"},
                        ],
                    },
                    {"id": "meta-1"},
                ]),
                "data: " + json.dumps([
                    {"type": "tool", "name": "emit_artifact", "content": "Artifact recorded."},
                    {"id": "meta-2"},
                ]),
                "data: [DONE]",
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert [event.kind for event in events] == ["text", "artifact"]
    assert events[0].text == "Hi"
    assert events[1].artifact == artifact


@pytest.mark.anyio
async def test_stream_events_text_before_artifact_in_same_chunk() -> None:
    """When text and tool_calls appear in the same chunk, text yields first."""
    artifact = _valid_artifact()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/threads":
            return httpx.Response(200, json={"thread_id": "thread-123"})
        if request.url.path == "/threads/thread-123/runs/stream":
            return _sse_response(
                "event: messages",
                "data: " + json.dumps([
                    {
                        "type": "AIMessageChunk",
                        "content": [{"text": "Hello", "type": "text", "index": 0}],
                        "tool_calls": [
                            {"name": "emit_artifact", "args": artifact, "id": "call-1", "type": "tool_call"},
                        ],
                    },
                    {"id": "meta-1"},
                ]),
                "data: [DONE]",
            )
        raise AssertionError(f"Unexpected request path: {request.url.path}")

    transport = httpx.MockTransport(handler)

    async with httpx.AsyncClient(
        base_url="http://testserver",
        transport=transport,
    ) as client:
        adapter = DeerFlowBackendAdapter(
            make_settings(backend_mode="deerflow"),
            client=client,
        )
        events = [event async for event in adapter.stream_events(_make_request())]

    assert [event.kind for event in events] == ["text", "artifact"]
    assert events[0].text == "Hello"
    assert events[1].artifact == artifact
