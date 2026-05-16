"""Tests for BuilderProgressMiddleware (Phase 4G v3 streaming restoration).

Locks the contract that the middleware emits ``custom``-mode phase
events via ``langgraph.config.get_stream_writer`` at the right
lifecycle hooks. The subscriber-side renderer expects
``{"name": "phase", "phase": "<phase>"}`` payloads — that's the
producer side of the Phase 4D ``ProgressRenderer._on_custom`` handler.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_progress import (
    BuilderProgressMiddleware,
)


def _runtime() -> SimpleNamespace:
    """Minimal Runtime stub — middleware doesn't read anything off it."""
    return SimpleNamespace(context={}, config={"configurable": {}})


def _ai_message(*, tool_calls: list[dict] | None = None) -> SimpleNamespace:
    """AIMessage-like stub the middleware can introspect."""
    return SimpleNamespace(type="ai", tool_calls=tool_calls or [])


@pytest.fixture
def captured_writes(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Replace ``get_stream_writer`` with a capturing stub.

    Returns the list the writer pushes payloads into. Tests can assert
    on the exact sequence of ``{"name": "phase", "phase": ...}`` calls.
    """
    captured: list[dict] = []

    def _writer(payload):
        captured.append(payload)

    def _get_writer():
        return _writer

    # Patch via the middleware's helper so we cover the import shape.
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_progress._get_stream_writer",
        lambda: _writer,
    )
    return captured


def test_before_agent_emits_starting(captured_writes: list[dict]) -> None:
    mw = BuilderProgressMiddleware()
    update = mw.before_agent({}, _runtime())
    assert captured_writes == [{"name": "phase", "phase": "starting"}]
    assert update == {"builder_progress_last_phase": "starting"}


def test_before_agent_skips_when_already_started(captured_writes: list[dict]) -> None:
    """Idempotency: re-entering before_agent (e.g. on a resumed run)
    doesn't double-emit starting."""
    mw = BuilderProgressMiddleware()
    update = mw.before_agent({"builder_progress_last_phase": "starting"}, _runtime())
    assert update is None
    assert captured_writes == []


def test_after_model_emits_researching_on_search_tool(
    captured_writes: list[dict],
) -> None:
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            _ai_message(tool_calls=[
                {"name": "builder_web_search", "args": {"query": "Zep memory"}},
            ])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert captured_writes == [{"name": "phase", "phase": "researching"}]
    assert update == {"builder_progress_last_phase": "researching"}


def test_after_model_emits_drafting_on_write_file(
    captured_writes: list[dict],
) -> None:
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            _ai_message(tool_calls=[
                {"name": "write_file", "args": {"path": "/mnt/user-data/outputs/report.md"}},
            ])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert captured_writes == [{"name": "phase", "phase": "drafting"}]
    assert update == {"builder_progress_last_phase": "drafting"}


def test_after_model_emits_finalizing_on_emit_artifact(
    captured_writes: list[dict],
) -> None:
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            _ai_message(tool_calls=[
                {"name": "emit_builder_artifact", "args": {}},
            ])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert captured_writes == [{"name": "phase", "phase": "finalizing"}]
    assert update == {"builder_progress_last_phase": "finalizing"}


def test_after_model_finalizing_takes_priority_over_researching(
    captured_writes: list[dict],
) -> None:
    """``emit_builder_artifact`` MUST win over a sibling search tool —
    finalizing is the strongest phase signal in the same turn."""
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            _ai_message(tool_calls=[
                {"name": "builder_web_search", "args": {"query": "x"}},
                {"name": "emit_builder_artifact", "args": {}},
            ])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert captured_writes == [{"name": "phase", "phase": "finalizing"}]
    assert update == {"builder_progress_last_phase": "finalizing"}


def test_after_model_skips_when_phase_unchanged(
    captured_writes: list[dict],
) -> None:
    """If the latest tool_call maps to the same phase we last emitted,
    don't re-emit — keeps the stream quiet on multi-search batches."""
    mw = BuilderProgressMiddleware()
    state = {
        "builder_progress_last_phase": "researching",
        "messages": [
            _ai_message(tool_calls=[
                {"name": "builder_web_fetch", "args": {"url": "https://x"}},
            ])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert update is None
    assert captured_writes == []


def test_after_model_skips_when_no_tool_calls(
    captured_writes: list[dict],
) -> None:
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [_ai_message(tool_calls=[])],
    }
    update = mw.after_model(state, _runtime())
    assert update is None
    assert captured_writes == []


def test_after_model_skips_when_tool_doesnt_map_to_phase(
    captured_writes: list[dict],
) -> None:
    """A tool we don't know about (e.g. ``ls``, ``todo_write``) leaves
    the phase unchanged."""
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            _ai_message(tool_calls=[{"name": "ls", "args": {"path": "/"}}])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert update is None
    assert captured_writes == []


def test_after_agent_emits_done(captured_writes: list[dict]) -> None:
    mw = BuilderProgressMiddleware()
    update = mw.after_agent({"builder_progress_last_phase": "finalizing"}, _runtime())
    assert captured_writes == [{"name": "phase", "phase": "done"}]
    assert update == {"builder_progress_last_phase": "done"}


def test_after_agent_idempotent_after_done(captured_writes: list[dict]) -> None:
    mw = BuilderProgressMiddleware()
    update = mw.after_agent({"builder_progress_last_phase": "done"}, _runtime())
    assert update is None
    assert captured_writes == []


def test_emission_no_op_when_writer_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Outside an active langgraph run (e.g. unit tests sans context),
    ``get_stream_writer`` returns None — emission must silently no-op,
    NOT crash the middleware."""
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_progress._get_stream_writer",
        lambda: None,
    )
    mw = BuilderProgressMiddleware()
    # Must not raise.
    update = mw.before_agent({}, _runtime())
    # Still records the phase transition for idempotency tracking.
    assert update == {"builder_progress_last_phase": "starting"}


def test_emission_swallows_writer_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A streaming-side issue must NEVER crash the builder. The writer
    raising is logged and swallowed; state still updates."""
    def _failing_writer(_payload):
        raise RuntimeError("simulated stream backend error")

    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.middlewares.builder_progress._get_stream_writer",
        lambda: _failing_writer,
    )
    mw = BuilderProgressMiddleware()
    # Must not raise.
    update = mw.before_agent({}, _runtime())
    assert update == {"builder_progress_last_phase": "starting"}


def test_tool_call_classification_is_case_insensitive(
    captured_writes: list[dict],
) -> None:
    """Tool-name match is substring-lowercase, so middleware classes
    written via the SDK that capitalise differently still classify."""
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            _ai_message(tool_calls=[
                {"name": "WebSearch", "args": {"query": "x"}},  # mixed case
            ])
        ],
    }
    update = mw.after_model(state, _runtime())
    assert update == {"builder_progress_last_phase": "researching"}
    assert captured_writes == [{"name": "phase", "phase": "researching"}]


def test_full_lifecycle_sequence(captured_writes: list[dict]) -> None:
    """End-to-end: starting → researching → drafting → finalizing → done.

    Mirrors what a real builder run produces: brief in, search calls,
    write_file calls, emit_builder_artifact, terminal. Validates that
    each transition fires exactly once and the state updates compose
    correctly across hooks.
    """
    mw = BuilderProgressMiddleware()
    state: dict = {}

    # before_agent → starting
    state.update(mw.before_agent(state, _runtime()) or {})

    # after_model with search → researching
    state["messages"] = [
        _ai_message(tool_calls=[{"name": "builder_web_search", "args": {"query": "x"}}])
    ]
    state.update(mw.after_model(state, _runtime()) or {})

    # after_model with another search → unchanged
    state["messages"] = [
        _ai_message(tool_calls=[{"name": "builder_web_fetch", "args": {"url": "https://x"}}])
    ]
    state.update(mw.after_model(state, _runtime()) or {})

    # after_model with write_file → drafting
    state["messages"] = [
        _ai_message(tool_calls=[{"name": "write_file", "args": {"path": "report.md"}}])
    ]
    state.update(mw.after_model(state, _runtime()) or {})

    # after_model with emit_builder_artifact → finalizing
    state["messages"] = [
        _ai_message(tool_calls=[{"name": "emit_builder_artifact", "args": {}}])
    ]
    state.update(mw.after_model(state, _runtime()) or {})

    # after_agent → done
    state.update(mw.after_agent(state, _runtime()) or {})

    phases = [w["phase"] for w in captured_writes]
    assert phases == ["starting", "researching", "drafting", "finalizing", "done"]
    assert state["builder_progress_last_phase"] == "done"


def test_middleware_handles_dict_message_without_type(
    captured_writes: list[dict],
) -> None:
    """Defensive: a malformed message in state shouldn't crash the loop.
    Just skip the message and treat it as no-phase-change."""
    mw = BuilderProgressMiddleware()
    state = {
        "messages": [
            {"role": "user", "content": "hello"},  # dict, not AIMessage
        ],
    }
    update = mw.after_model(state, _runtime())
    assert update is None
    assert captured_writes == []


def test_middleware_handles_tool_call_object_with_name_attr(
    captured_writes: list[dict],
) -> None:
    """tool_calls can be either list of dicts or list of objects with
    a ``.name`` attribute. The middleware reads both shapes via
    ``getattr(call, 'name', None)``."""
    mw = BuilderProgressMiddleware()
    # ``MagicMock(name=...)`` sets the mock's identifier, NOT a
    # ``name`` attribute. Use SimpleNamespace for a clean attribute
    # holder.
    call = SimpleNamespace(name="builder_web_search")
    state = {
        "messages": [_ai_message(tool_calls=[call])],
    }
    update = mw.after_model(state, _runtime())
    assert update == {"builder_progress_last_phase": "researching"}
    assert captured_writes == [{"name": "phase", "phase": "researching"}]
