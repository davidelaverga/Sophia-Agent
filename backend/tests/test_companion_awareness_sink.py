"""Unit tests for the CompanionAwarenessSink + CompanionContextStore."""

from __future__ import annotations

import pytest

from app.gateway.builder_events.companion_context_store import CompanionContextStore
from app.gateway.builder_events.sinks.companion_awareness import CompanionAwarenessSink
from app.gateway.builder_events.sinks.trace import TraceSink
from app.gateway.builder_events.types import CompletedEvent, MessageDeltaEvent, ToolCallEvent


def _msg(seq: int, *, thread: str = "thread-A") -> MessageDeltaEvent:
    return MessageDeltaEvent(
        task_id="t1",
        thread_id=thread,
        user_id="u",
        channel_origin="telegram",
        timestamp_ms=seq,
        sequence=seq,
        delta=f"d{seq}",
    )


@pytest.mark.anyio
async def test_sink_appends_event_in_order() -> None:
    store = CompanionContextStore()
    sink = CompanionAwarenessSink(store)

    await sink.handle(_msg(1))
    await sink.handle(_msg(2))
    await sink.handle(_msg(3))

    snapshot = await store.snapshot("thread-A")
    assert [e["sequence"] for e in snapshot] == [1, 2, 3]
    assert all(e["type"] == "message_delta" for e in snapshot)


@pytest.mark.anyio
async def test_sink_isolates_per_thread() -> None:
    store = CompanionContextStore()
    sink = CompanionAwarenessSink(store)

    await sink.handle(_msg(1, thread="thread-A"))
    await sink.handle(_msg(2, thread="thread-B"))

    a = await store.snapshot("thread-A")
    b = await store.snapshot("thread-B")
    assert len(a) == 1 and a[0]["sequence"] == 1
    assert len(b) == 1 and b[0]["sequence"] == 2


@pytest.mark.anyio
async def test_sink_accepts_all_origins() -> None:
    store = CompanionContextStore()
    sink = CompanionAwarenessSink(store)

    web_event = MessageDeltaEvent(
        task_id="t",
        thread_id="th",
        user_id="u",
        channel_origin="web",
        timestamp_ms=1,
        sequence=1,
        delta="d",
    )
    assert await sink.accepts(web_event) is True
    await sink.handle(web_event)
    assert await store.snapshot("th")


@pytest.mark.anyio
async def test_sink_handles_completion_event() -> None:
    store = CompanionContextStore()
    sink = CompanionAwarenessSink(store)

    await sink.handle(_msg(1))
    await sink.handle(
        CompletedEvent(
            task_id="t1",
            thread_id="thread-A",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=2,
            sequence=99,
            status="completed",
            companion_summary="done",
        )
    )
    snapshot = await store.snapshot("thread-A")
    assert snapshot[-1]["type"] == "completed"
    assert snapshot[-1]["companion_summary"] == "done"


@pytest.mark.anyio
async def test_trace_sink_writes_jsonl(tmp_path) -> None:
    sink = TraceSink(base_path=tmp_path)
    await sink.handle(_msg(1))
    await sink.handle(
        ToolCallEvent(
            task_id="t1",
            thread_id="thread-A",
            user_id="u",
            channel_origin="telegram",
            timestamp_ms=2,
            sequence=2,
            tool_call_id="c",
            tool_name="builder_web_search",
            args={"query": "x"},
            status="started",
        )
    )

    path = tmp_path / "u" / "builder_runs" / "thread-A.jsonl"
    assert path.exists()
    lines = path.read_text().strip().splitlines()
    assert len(lines) == 2
    import json
    parsed = [json.loads(line) for line in lines]
    assert parsed[0]["type"] == "message_delta"
    assert parsed[1]["type"] == "tool_call"


@pytest.mark.anyio
async def test_trace_sink_falls_back_to_unknown_user(tmp_path) -> None:
    sink = TraceSink(base_path=tmp_path)
    evt = MessageDeltaEvent(
        task_id="t",
        thread_id="th",
        user_id=None,
        channel_origin="telegram",
        timestamp_ms=1,
        sequence=1,
        delta="d",
    )
    await sink.handle(evt)
    assert (tmp_path / "unknown" / "builder_runs" / "th.jsonl").exists()
