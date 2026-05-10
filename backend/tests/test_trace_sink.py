"""Unit tests for ``TraceSink``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.gateway.builder_events.sinks.trace import TraceSink
from app.gateway.builder_events.types import BuilderEvent


def _evt(
    *,
    user_id: str = "u1",
    thread_id: str = "tid-1",
    event_type: str = "completed",
    parent_thread_id: str | None = "ptid-1",
) -> BuilderEvent:
    return BuilderEvent(
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        user_id=user_id,
        trace_id="trace-1",
        event_type=event_type,  # type: ignore[arg-type]
        payload={"k": "v"},
        sequence=1,
    )


@pytest.mark.anyio
async def test_appends_one_jsonl_line(tmp_path: Path) -> None:
    sink = TraceSink(users_dir=tmp_path)

    await sink.handle(_evt(thread_id="tid-A"))
    await sink.handle(_evt(thread_id="tid-A", event_type="phase"))

    target = tmp_path / "u1" / "traces" / "builder_events_tid-A.jsonl"
    assert target.exists()
    lines = target.read_text().strip().split("\n")
    assert len(lines) == 2

    first = json.loads(lines[0])
    second = json.loads(lines[1])
    assert first["thread_id"] == "tid-A"
    assert first["event_type"] == "completed"
    assert first["payload"] == {"k": "v"}
    assert first["sequence"] == 1
    assert second["event_type"] == "phase"


@pytest.mark.anyio
async def test_separate_files_per_thread_id(tmp_path: Path) -> None:
    sink = TraceSink(users_dir=tmp_path)

    await sink.handle(_evt(thread_id="tid-A"))
    await sink.handle(_evt(thread_id="tid-B"))

    a = tmp_path / "u1" / "traces" / "builder_events_tid-A.jsonl"
    b = tmp_path / "u1" / "traces" / "builder_events_tid-B.jsonl"
    assert a.exists()
    assert b.exists()


@pytest.mark.anyio
async def test_rejects_event_without_user_id() -> None:
    sink = TraceSink()
    assert sink.accepts(_evt(user_id="")) is False


@pytest.mark.anyio
async def test_rejects_event_without_thread_id() -> None:
    sink = TraceSink()
    assert sink.accepts(_evt(thread_id="")) is False


@pytest.mark.anyio
async def test_rejects_unsafe_thread_id_for_filename(
    tmp_path: Path,
) -> None:
    sink = TraceSink(users_dir=tmp_path)
    # Slashes would let an attacker write outside the user's traces dir
    await sink.handle(_evt(thread_id="../escape"))

    # Nothing was created
    assert list(tmp_path.glob("**/*.jsonl")) == []
