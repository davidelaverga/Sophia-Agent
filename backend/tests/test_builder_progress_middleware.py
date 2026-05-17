"""Tests for BuilderProgressMiddleware (Phase 4H — webhook relay).

The middleware POSTs phase / tool-call events to the gateway's
``/internal/builder-progress`` endpoint. Fire-and-forget — failures
are logged and swallowed. Replaces the Phase 4G ``get_stream_writer``
approach which didn't work cross-process against
``langgraph_runtime_inmem``.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_progress import (
    BuilderProgressMiddleware,
    _classify_tool,
    _pick_strongest_phase,
)


def _runtime(thread_id: str = "task-1", run_id: str = "run-1") -> SimpleNamespace:
    """Minimal Runtime stub with execution_info.thread_id / run_id."""
    return SimpleNamespace(
        execution_info=SimpleNamespace(thread_id=thread_id, run_id=run_id),
        context={},
        config={"configurable": {}},
    )


def _ai_message(*, tool_calls: list[dict] | None = None) -> SimpleNamespace:
    return SimpleNamespace(type="ai", tool_calls=tool_calls or [])


@pytest.fixture
def captured_posts(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Replace ``_schedule_post`` with a capturing stub.

    Each call is recorded as the kwargs dict so tests can assert on
    ``task_id`` / ``run_id`` / ``event_name`` / ``data`` shape.
    """
    captured: list[dict] = []

    def _capture(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_progress._schedule_post",
        _capture,
    )
    return captured


# ---- pure classifier tests (no middleware instance needed) ----------------


class TestClassifier:
    def test_research_tools_classify_as_researching(self) -> None:
        assert _classify_tool("builder_web_search") == "researching"
        assert _classify_tool("web_fetch") == "researching"
        assert _classify_tool("tavily_search") == "researching"
        assert _classify_tool("jina_fetch") == "researching"

    def test_draft_tools_classify_as_drafting(self) -> None:
        assert _classify_tool("write_file") == "drafting"
        assert _classify_tool("str_replace") == "drafting"

    def test_finalize_tools_classify_as_finalizing(self) -> None:
        assert _classify_tool("emit_builder_artifact") == "finalizing"
        assert _classify_tool("emit_artifact") == "finalizing"

    def test_unknown_tools_return_none(self) -> None:
        assert _classify_tool("ls") is None
        assert _classify_tool("todo_write") is None
        assert _classify_tool("") is None

    def test_classifier_is_case_insensitive(self) -> None:
        assert _classify_tool("WebSearch") == "researching"
        assert _classify_tool("Write_File") == "drafting"

    def test_strongest_phase_picks_finalizing_over_researching(self) -> None:
        result = _pick_strongest_phase([
            {"name": "builder_web_search"},
            {"name": "emit_builder_artifact"},
        ])
        assert result == "finalizing"

    def test_strongest_phase_picks_drafting_over_researching(self) -> None:
        result = _pick_strongest_phase([
            {"name": "builder_web_fetch"},
            {"name": "write_file"},
        ])
        assert result == "drafting"


# ---- middleware hooks ------------------------------------------------------


class TestAbeforeAgent:
    @pytest.mark.anyio
    async def test_emits_starting_when_runtime_has_ids(
        self, captured_posts: list[dict]
    ) -> None:
        mw = BuilderProgressMiddleware()
        update = await mw.abefore_agent({}, _runtime("task-A", "run-A"))
        assert captured_posts == [{
            "task_id": "task-A",
            "run_id": "run-A",
            "event_name": "custom",
            "data": {"name": "phase", "phase": "starting"},
        }]
        assert update == {"builder_progress_last_phase": "starting"}

    @pytest.mark.anyio
    async def test_idempotent_when_already_started(
        self, captured_posts: list[dict]
    ) -> None:
        mw = BuilderProgressMiddleware()
        update = await mw.abefore_agent(
            {"builder_progress_last_phase": "starting"}, _runtime()
        )
        assert update is None
        assert captured_posts == []

    @pytest.mark.anyio
    async def test_skips_post_when_runtime_missing_ids(
        self, captured_posts: list[dict]
    ) -> None:
        """Defensive: if execution_info doesn't yet have thread_id/run_id
        (e.g. before the run is fully initialised), the middleware
        records the phase transition for idempotency but doesn't POST."""
        mw = BuilderProgressMiddleware()
        runtime = SimpleNamespace(execution_info=SimpleNamespace(thread_id=None, run_id=None))
        update = await mw.abefore_agent({}, runtime)
        assert update == {"builder_progress_last_phase": "starting"}
        assert captured_posts == []


class TestAafterModel:
    @pytest.mark.anyio
    async def test_emits_updates_and_phase_on_search_tool(
        self, captured_posts: list[dict]
    ) -> None:
        mw = BuilderProgressMiddleware()
        state = {
            "messages": [
                _ai_message(tool_calls=[
                    {"name": "builder_web_search", "args": {"query": "FST"}},
                ])
            ],
        }
        update = await mw.aafter_model(state, _runtime())
        # Two POSTs: one with the tool_calls (updates mode for activity
        # lines), one with the phase transition (custom mode).
        event_names = [p["event_name"] for p in captured_posts]
        assert "updates" in event_names
        assert "custom" in event_names
        phase_post = next(p for p in captured_posts if p["event_name"] == "custom")
        assert phase_post["data"] == {"name": "phase", "phase": "researching"}
        updates_post = next(p for p in captured_posts if p["event_name"] == "updates")
        tcs = updates_post["data"]["agent"]["messages"][0]["tool_calls"]
        assert tcs[0]["name"] == "builder_web_search"
        assert update == {"builder_progress_last_phase": "researching"}

    @pytest.mark.anyio
    async def test_finalizing_wins_in_same_batch(
        self, captured_posts: list[dict]
    ) -> None:
        mw = BuilderProgressMiddleware()
        state = {
            "messages": [
                _ai_message(tool_calls=[
                    {"name": "builder_web_search", "args": {"query": "x"}},
                    {"name": "emit_builder_artifact", "args": {}},
                ])
            ],
        }
        update = await mw.aafter_model(state, _runtime())
        phase_posts = [p for p in captured_posts if p["event_name"] == "custom"]
        assert len(phase_posts) == 1
        assert phase_posts[0]["data"]["phase"] == "finalizing"
        assert update == {"builder_progress_last_phase": "finalizing"}

    @pytest.mark.anyio
    async def test_skips_phase_emit_when_unchanged_but_still_emits_updates(
        self, captured_posts: list[dict]
    ) -> None:
        """Multi-search batches don't re-emit ``researching`` (already
        the current phase) but DO emit the tool_calls so users see
        the second search appear as a new activity line."""
        mw = BuilderProgressMiddleware()
        state = {
            "builder_progress_last_phase": "researching",
            "messages": [
                _ai_message(tool_calls=[
                    {"name": "builder_web_fetch", "args": {"url": "https://x"}},
                ])
            ],
        }
        update = await mw.aafter_model(state, _runtime())
        # No phase post.
        phase_posts = [p for p in captured_posts if p["event_name"] == "custom"]
        assert phase_posts == []
        # But updates post fires (activity line).
        updates_posts = [p for p in captured_posts if p["event_name"] == "updates"]
        assert len(updates_posts) == 1
        assert update is None

    @pytest.mark.anyio
    async def test_skips_when_no_tool_calls(
        self, captured_posts: list[dict]
    ) -> None:
        mw = BuilderProgressMiddleware()
        state = {"messages": [_ai_message(tool_calls=[])]}
        update = await mw.aafter_model(state, _runtime())
        assert update is None
        assert captured_posts == []

    @pytest.mark.anyio
    async def test_skips_post_when_runtime_missing_ids(
        self, captured_posts: list[dict]
    ) -> None:
        mw = BuilderProgressMiddleware()
        state = {
            "messages": [
                _ai_message(tool_calls=[{"name": "builder_web_search"}])
            ],
        }
        runtime = SimpleNamespace(execution_info=SimpleNamespace(thread_id=None, run_id=None))
        update = await mw.aafter_model(state, runtime)
        assert update is None
        assert captured_posts == []


class TestAafterAgent:
    @pytest.mark.anyio
    async def test_emits_done(self, captured_posts: list[dict]) -> None:
        mw = BuilderProgressMiddleware()
        update = await mw.aafter_agent(
            {"builder_progress_last_phase": "finalizing"}, _runtime()
        )
        assert captured_posts == [{
            "task_id": "task-1",
            "run_id": "run-1",
            "event_name": "custom",
            "data": {"name": "phase", "phase": "done"},
        }]
        assert update == {"builder_progress_last_phase": "done"}

    @pytest.mark.anyio
    async def test_idempotent_after_done(self, captured_posts: list[dict]) -> None:
        mw = BuilderProgressMiddleware()
        update = await mw.aafter_agent(
            {"builder_progress_last_phase": "done"}, _runtime()
        )
        assert update is None
        assert captured_posts == []


class TestScheduling:
    @pytest.mark.anyio
    async def test_schedule_post_silently_skips_when_no_running_loop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If called from a sync context with no running loop,
        ``_schedule_post`` must log + return without crashing."""
        from deerflow.agents.sophia_agent.middlewares import builder_progress

        # Simulate "no running loop"
        def _raise(*_a, **_kw):
            raise RuntimeError("no running event loop")

        monkeypatch.setattr(asyncio, "get_running_loop", _raise)
        # Must not raise.
        builder_progress._schedule_post(
            task_id="t-1",
            run_id="r-1",
            event_name="custom",
            data={"name": "phase", "phase": "starting"},
        )
