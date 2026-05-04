"""Tests for the builder progress event system (Phase 2 of dual-bot spec).

Covers:
- ``ProgressEvent`` serialization
- ``ProgressEmitter`` throttle window + priority bypass
- ``ProgressTraceWriter`` JSONL semantics
- ``BUILDER_PROGRESS_EMIT=false`` rollback flag
- ``ProgressCallbackHandler`` event mapping (STARTED / COMPLETED / ERROR / FINDING / DRAFTING)
- Defense-in-depth: callback handler exceptions never propagate
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest

from deerflow.sophia.builder_progress import (
    ProgressEmitter,
    ProgressEvent,
    ProgressEventType,
    ProgressTraceWriter,
    format_completed_summary,
    format_drafting_summary,
    format_error_summary,
    format_finding_summary,
    format_started_summary,
    is_draft_tool,
    is_search_tool,
)
from deerflow.sophia.builder_progress_callback import ProgressCallbackHandler

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _ManualClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def _make_emitter(
    tmp_path: Path,
    *,
    user_id: str = "alpha",
    session_id: str = "s1",
    artifact_id: str = "task1",
    sink: Any | None = None,
    throttle_seconds: float | None = None,
    clock: _ManualClock | None = None,
) -> tuple[ProgressEmitter, list[ProgressEvent], _ManualClock]:
    delivered: list[ProgressEvent] = []

    def default_sink(event: ProgressEvent) -> None:
        delivered.append(event)

    writer = ProgressTraceWriter(traces_root=tmp_path)
    used_clock = clock or _ManualClock()
    emitter = ProgressEmitter(
        user_id=user_id,
        session_id=session_id,
        artifact_id=artifact_id,
        sink=sink or default_sink,
        trace_writer=writer,
        throttle_seconds=throttle_seconds,
        clock=used_clock,
    )
    return emitter, delivered, used_clock


def _read_trace_lines(tmp_path: Path, user_id: str, session_id: str) -> list[dict[str, Any]]:
    path = tmp_path / user_id / "traces" / f"builder_progress_{session_id}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Schema tests
# ---------------------------------------------------------------------------


class TestProgressEventSchema:
    def test_to_dict_contains_all_fields_and_serializes_timestamp(self) -> None:
        import datetime as dt

        event = ProgressEvent(
            event_type=ProgressEventType.STARTED,
            session_id="s1",
            artifact_id="a1",
            user_id="u1",
            timestamp=dt.datetime(2026, 5, 5, 12, 0, 0, tzinfo=dt.UTC),
            summary="hello",
        )
        data = event.to_dict()
        assert data["event_type"] == "started"
        assert data["timestamp"] == "2026-05-05T12:00:00+00:00"
        assert data["surface"] == "worker"
        assert data["summary"] == "hello"
        assert data["metadata"] == {}


# ---------------------------------------------------------------------------
# Summary template tests
# ---------------------------------------------------------------------------


class TestSummaryTemplates:
    def test_started_uses_subject_when_present(self) -> None:
        assert "AR glasses" in format_started_summary("AR glasses launching in 2026")

    def test_started_falls_back_when_subject_missing(self) -> None:
        assert format_started_summary(None).startswith("Looking into")

    def test_finding_includes_tool_name(self) -> None:
        assert "tavily" in format_finding_summary("tavily_search")

    def test_drafting_uses_artifact_type_when_provided(self) -> None:
        assert "brief" in format_drafting_summary("brief")

    def test_error_truncates_long_messages(self) -> None:
        long = "x" * 500
        assert len(format_error_summary(long)) < 200

    def test_error_handles_none(self) -> None:
        assert format_error_summary(None) == "Hit a snag and couldn't finish."

    def test_completed_summary_is_terse(self) -> None:
        assert format_completed_summary() == "Done."


class TestToolHeuristics:
    @pytest.mark.parametrize("name", ["tavily_search", "web_fetch", "jina_browse", "firecrawl_scrape"])
    def test_search_tool_recognized(self, name: str) -> None:
        assert is_search_tool(name)

    @pytest.mark.parametrize("name", ["emit_artifact", "emit_builder_artifact", "render_markdown_to_pdf"])
    def test_draft_tool_recognized(self, name: str) -> None:
        assert is_draft_tool(name)

    def test_unknown_tools_return_false(self) -> None:
        assert not is_search_tool("write_todos")
        assert not is_draft_tool("bash")

    def test_none_is_not_a_tool(self) -> None:
        assert not is_search_tool(None)
        assert not is_draft_tool(None)


# ---------------------------------------------------------------------------
# Emitter throttle behavior
# ---------------------------------------------------------------------------


class TestProgressEmitterThrottle:
    def test_priority_events_always_pass(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path, throttle_seconds=60.0)
        emitter.emit(ProgressEventType.STARTED, "go")
        emitter.emit(ProgressEventType.COMPLETED, "done")
        emitter.emit(ProgressEventType.ERROR, "boom")
        assert [e.event_type for e in delivered] == [
            ProgressEventType.STARTED,
            ProgressEventType.COMPLETED,
            ProgressEventType.ERROR,
        ]

    def test_non_priority_events_throttle_within_window(self, tmp_path: Path) -> None:
        clock = _ManualClock()
        emitter, delivered, _ = _make_emitter(tmp_path, throttle_seconds=60.0, clock=clock)
        first = emitter.emit(ProgressEventType.FINDING, "first")
        second = emitter.emit(ProgressEventType.FINDING, "second")
        assert first is not None
        assert second is None  # suppressed
        assert len(delivered) == 1

    def test_non_priority_events_pass_after_window(self, tmp_path: Path) -> None:
        clock = _ManualClock()
        emitter, delivered, _ = _make_emitter(tmp_path, throttle_seconds=60.0, clock=clock)
        emitter.emit(ProgressEventType.FINDING, "first")
        clock.advance(61.0)
        emitter.emit(ProgressEventType.FINDING, "second")
        assert len(delivered) == 2

    def test_priority_event_does_not_reset_throttle_for_non_priority(self, tmp_path: Path) -> None:
        # Spec §4.2.2: priority types bypass; they should not refresh the
        # throttle window for subsequent non-priority emits, otherwise a
        # noisy STARTED+FINDING+FINDING burst would over-emit.
        clock = _ManualClock()
        emitter, delivered, _ = _make_emitter(tmp_path, throttle_seconds=60.0, clock=clock)
        emitter.emit(ProgressEventType.FINDING, "f1")  # delivered, sets window
        clock.advance(10.0)
        emitter.emit(ProgressEventType.STARTED, "started")  # priority, bypasses
        clock.advance(10.0)
        # Non-priority emit at t=20s — within the 60s window of the first FINDING.
        result = emitter.emit(ProgressEventType.FINDING, "f2")
        assert result is None  # still suppressed


class TestProgressEmitterTrace:
    def test_delivered_event_writes_one_line(self, tmp_path: Path) -> None:
        emitter, _, _ = _make_emitter(tmp_path)
        emitter.emit(ProgressEventType.STARTED, "go")
        lines = _read_trace_lines(tmp_path, "alpha", "s1")
        assert len(lines) == 1
        assert lines[0]["event_type"] == "started"
        assert lines[0]["surface"] == "worker"

    def test_suppressed_event_writes_with_surface_none(self, tmp_path: Path) -> None:
        clock = _ManualClock()
        emitter, _, _ = _make_emitter(tmp_path, throttle_seconds=60.0, clock=clock)
        emitter.emit(ProgressEventType.FINDING, "f1")
        emitter.emit(ProgressEventType.FINDING, "f2")  # suppressed
        lines = _read_trace_lines(tmp_path, "alpha", "s1")
        assert len(lines) == 2
        assert lines[1]["surface"] == "none"

    def test_separate_sessions_write_separate_files(self, tmp_path: Path) -> None:
        e1, _, _ = _make_emitter(tmp_path, session_id="s1")
        e2, _, _ = _make_emitter(tmp_path, session_id="s2")
        e1.emit(ProgressEventType.STARTED, "a")
        e2.emit(ProgressEventType.STARTED, "b")
        assert _read_trace_lines(tmp_path, "alpha", "s1")[0]["session_id"] == "s1"
        assert _read_trace_lines(tmp_path, "alpha", "s2")[0]["session_id"] == "s2"


class TestProgressEmitterRollback:
    def test_emit_is_noop_when_env_flag_is_false(self, tmp_path: Path) -> None:
        with patch.dict(os.environ, {"BUILDER_PROGRESS_EMIT": "false"}):
            emitter, delivered, _ = _make_emitter(tmp_path)
            result = emitter.emit(ProgressEventType.STARTED, "go")
        assert result is None
        assert delivered == []
        assert _read_trace_lines(tmp_path, "alpha", "s1") == []

    def test_emit_active_when_env_flag_is_unset_or_true(self, tmp_path: Path) -> None:
        env_no_var = {k: v for k, v in os.environ.items() if k != "BUILDER_PROGRESS_EMIT"}
        with patch.dict(os.environ, env_no_var, clear=True):
            emitter, delivered, _ = _make_emitter(tmp_path)
            emitter.emit(ProgressEventType.STARTED, "go")
        assert len(delivered) == 1

    def test_sink_failure_does_not_propagate(self, tmp_path: Path) -> None:
        def failing_sink(_: ProgressEvent) -> None:
            raise RuntimeError("kaboom")

        emitter, _, _ = _make_emitter(tmp_path, sink=failing_sink)
        # Must not raise — calibration runs cannot crash on sink failures.
        emitter.emit(ProgressEventType.STARTED, "go")


# ---------------------------------------------------------------------------
# Callback handler tests
# ---------------------------------------------------------------------------


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestProgressCallbackHandler:
    def test_root_chain_start_emits_started(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter, task_subject="AR glasses")

        _run(handler.on_chain_start(serialized={}, inputs={}, run_id=uuid4(), parent_run_id=None))

        assert len(delivered) == 1
        assert delivered[0].event_type == ProgressEventType.STARTED
        assert "AR glasses" in delivered[0].summary

    def test_inner_chain_start_does_not_emit(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        _run(handler.on_chain_start(serialized={}, inputs={}, run_id=uuid4(), parent_run_id=uuid4()))

        assert delivered == []

    def test_started_only_emitted_once(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        async def double_start() -> None:
            await handler.on_chain_start(serialized={}, inputs={}, run_id=uuid4(), parent_run_id=None)
            await handler.on_chain_start(serialized={}, inputs={}, run_id=uuid4(), parent_run_id=None)

        _run(double_start())

        assert len(delivered) == 1

    def test_root_chain_end_emits_completed(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        _run(handler.on_chain_end(outputs={}, run_id=uuid4(), parent_run_id=None))

        assert len(delivered) == 1
        assert delivered[0].event_type == ProgressEventType.COMPLETED

    def test_root_chain_error_emits_error(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        _run(handler.on_chain_error(error=RuntimeError("disk full"), run_id=uuid4(), parent_run_id=None))

        assert len(delivered) == 1
        assert delivered[0].event_type == ProgressEventType.ERROR
        assert "disk full" in delivered[0].summary

    def test_completed_and_error_dedup_within_run(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        async def end_then_error() -> None:
            await handler.on_chain_end(outputs={}, run_id=uuid4(), parent_run_id=None)
            await handler.on_chain_error(error=RuntimeError("late"), run_id=uuid4(), parent_run_id=None)

        _run(end_then_error())

        assert len(delivered) == 1
        assert delivered[0].event_type == ProgressEventType.COMPLETED

    def test_search_tool_emits_finding(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        _run(handler.on_tool_start(serialized={"name": "tavily_search"}, input_str="display tech", run_id=uuid4()))

        assert len(delivered) == 1
        assert delivered[0].event_type == ProgressEventType.FINDING
        assert delivered[0].metadata["tool"] == "tavily_search"

    def test_draft_tool_emits_drafting_once(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        async def double_draft() -> None:
            await handler.on_tool_start(serialized={"name": "emit_builder_artifact"}, input_str="...", run_id=uuid4())
            await handler.on_tool_start(serialized={"name": "emit_builder_artifact"}, input_str="...", run_id=uuid4())

        _run(double_draft())

        assert len(delivered) == 1
        assert delivered[0].event_type == ProgressEventType.DRAFTING

    def test_unknown_tool_emits_nothing(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        _run(handler.on_tool_start(serialized={"name": "write_todos"}, input_str="...", run_id=uuid4()))

        assert delivered == []

    def test_serialized_without_name_is_safe(self, tmp_path: Path) -> None:
        emitter, delivered, _ = _make_emitter(tmp_path)
        handler = ProgressCallbackHandler(emitter)

        _run(handler.on_tool_start(serialized={}, input_str="...", run_id=uuid4()))
        _run(handler.on_tool_start(serialized=None, input_str="...", run_id=uuid4()))

        assert delivered == []
