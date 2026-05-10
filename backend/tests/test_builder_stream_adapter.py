"""Unit tests for ``stream_part_to_events``."""

from __future__ import annotations

from app.gateway.builder_events.adapters import (
    StreamAdapterState,
    stream_part_to_events,
)


def _ctx() -> dict:
    return {
        "thread_id": "tid-1",
        "parent_thread_id": None,
        "user_id": "u1",
        "trace_id": "trace-1",
    }


def test_values_snapshot_emits_tool_started_for_new_call() -> None:
    state = StreamAdapterState()
    part = (
        "values",
        {
            "messages": [
                {"type": "human", "content": "do it"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_abc",
                            "name": "builder_web_search",
                            "args": {"query": "sophia memory"},
                        }
                    ],
                },
            ]
        },
    )
    events = stream_part_to_events(part, adapter_state=state, **_ctx())
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "tool_started"
    assert e.payload["tool_name"] == "builder_web_search"
    assert e.payload["tool_call_id"] == "call_abc"
    assert "sophia memory" in e.payload["args_preview"]


def test_values_snapshot_dedups_repeated_tool_started() -> None:
    state = StreamAdapterState()
    snapshot = (
        "values",
        {
            "messages": [
                {
                    "type": "ai",
                    "tool_calls": [{"id": "call_abc", "name": "bash", "args": {"cmd": "ls"}}],
                }
            ]
        },
    )
    first = stream_part_to_events(snapshot, adapter_state=state, **_ctx())
    second = stream_part_to_events(snapshot, adapter_state=state, **_ctx())
    assert len(first) == 1
    assert second == []


def test_values_snapshot_emits_tool_completed_for_new_tool_msg() -> None:
    state = StreamAdapterState()
    part = (
        "values",
        {
            "messages": [
                {
                    "type": "ai",
                    "tool_calls": [{"id": "call_abc", "name": "bash", "args": {"cmd": "ls"}}],
                },
                {
                    "type": "tool",
                    "tool_call_id": "call_abc",
                    "name": "bash",
                    "content": "file1.txt\nfile2.txt",
                    "status": "success",
                },
            ]
        },
    )
    events = stream_part_to_events(part, adapter_state=state, **_ctx())
    types = [e.event_type for e in events]
    assert "tool_started" in types
    assert "tool_completed" in types
    completed = [e for e in events if e.event_type == "tool_completed"][0]
    assert completed.payload["success"] is True
    assert "file1.txt" in completed.payload["summary"]


def test_values_snapshot_emits_todo_updated_on_change() -> None:
    state = StreamAdapterState()
    part = (
        "values",
        {
            "messages": [],
            "todos": [
                {"id": "1", "title": "research", "status": "in_progress"},
                {"id": "2", "title": "draft", "status": "pending"},
            ],
        },
    )
    events = stream_part_to_events(part, adapter_state=state, **_ctx())
    todo_evts = [e for e in events if e.event_type == "todo_updated"]
    assert len(todo_evts) == 1
    assert len(todo_evts[0].payload["todos"]) == 2

    # Repeated identical snapshot does not re-emit.
    events_again = stream_part_to_events(part, adapter_state=state, **_ctx())
    assert [e for e in events_again if e.event_type == "todo_updated"] == []


def test_messages_partial_emits_ai_message_chunk() -> None:
    state = StreamAdapterState()
    part = (
        "messages/partial",
        [
            {"type": "ai", "id": "msg-1", "content": "Hello"},
        ],
    )
    events = stream_part_to_events(part, adapter_state=state, **_ctx())
    assert len(events) == 1
    e = events[0]
    assert e.event_type == "ai_message_chunk"
    assert e.payload["message_id"] == "msg-1"
    assert e.payload["chunk_index"] == 0
    assert e.payload["text_delta"] == "Hello"

    events2 = stream_part_to_events(
        ("messages/partial", [{"type": "ai", "id": "msg-1", "content": " world"}]),
        adapter_state=state,
        **_ctx(),
    )
    assert events2[0].payload["chunk_index"] == 1


def test_custom_phase_event_emits_phase() -> None:
    part = ("custom", {"type": "phase", "name": "researching", "index": 1, "total": 4})
    events = stream_part_to_events(part, adapter_state=StreamAdapterState(), **_ctx())
    assert len(events) == 1
    assert events[0].event_type == "phase"
    assert events[0].payload["phase_name"] == "researching"
    assert events[0].payload["phase_index"] == 1


def test_metadata_and_end_events_are_skipped() -> None:
    state = StreamAdapterState()
    assert stream_part_to_events(("metadata", {"run_id": "r1"}), adapter_state=state, **_ctx()) == []
    assert stream_part_to_events(("end", None), adapter_state=state, **_ctx()) == []
    assert stream_part_to_events(("updates", {"node": "x"}), adapter_state=state, **_ctx()) == []


def test_non_tuple_chunk_returns_empty() -> None:
    state = StreamAdapterState()
    assert stream_part_to_events({"event": "values"}, adapter_state=state, **_ctx()) == []
    assert stream_part_to_events(None, adapter_state=state, **_ctx()) == []
