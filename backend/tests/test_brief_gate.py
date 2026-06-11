"""G-DEL-5 — the brief gate: predicate matrix, briefing directive, payload
plumbing, and the honesty stamp. A derivable gap is repaired via
read_session_context (assumptions stay empty); a truly-absent field ships as
a named assumption the companion relays."""

from __future__ import annotations

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_task import (
    _delegation_boundary_sections,
)
from deerflow.sophia.build_condition import (
    brief_complete,
    brief_gate_unmet_conditions,
)
from deerflow.sophia.tools.emit_builder_artifact import BuilderArtifactInput

_COMPLETE = {
    "audience": "enterprise CTOs [t3]",
    "purpose": "launch deck [t40]",
    "format_and_length": "10 slides [t40]",
    "must_include": ["Q3 numbers [t18]"],
    "must_exclude": [],
    "sources_and_examples": [],
    "style_preferences": [],
    "decisions_made": [],
    "open_questions": [],
}


# ---- predicate matrix -----------------------------------------------------------


def test_complete_presentation_brief_passes():
    ok, missing = brief_complete("presentation", _COMPLETE)
    assert ok is True
    assert missing == []


def test_missing_audience_is_named():
    schema = {**_COMPLETE, "audience": None}
    ok, missing = brief_complete("presentation", schema)
    assert ok is False
    assert missing == ["audience"]


def test_alternative_group_satisfied_by_sources():
    schema = {**_COMPLETE, "must_include": [], "sources_and_examples": ["the Q3 memo [t18]"]}
    ok, missing = brief_complete("visual_report", schema)
    assert ok is True


def test_alternative_group_missing_both_alternatives():
    schema = {**_COMPLETE, "must_include": [], "sources_and_examples": []}
    ok, missing = brief_complete("document", schema)
    assert ok is False
    assert missing == ["must_include|sources_and_examples"]


@pytest.mark.parametrize("task_type", ["code", "frontend"])
def test_code_paths_require_purpose_format_includes(task_type):
    ok, missing = brief_complete(task_type, {"purpose": None, "format_and_length": None, "must_include": []})
    assert ok is False
    assert set(missing) == {"purpose", "format_and_length", "must_include"}


def test_no_schema_or_unknown_task_type_never_gates():
    assert brief_complete("presentation", None) == (True, [])
    assert brief_complete("research", _COMPLETE) == (True, [])


# ---- briefing directive ---------------------------------------------------------


def _context_with_stats() -> dict:
    return {
        "delegation_ledger": {
            "turns": 40,
            "deliverable_intent_turns": 8,
            "was_summarized": False,
            "available": True,
        },
        "parent_user_id": "user-gdel",
        "parent_thread_id": "thread-gdel",
    }


def test_gate_block_names_exactly_the_missing_fields(monkeypatch):
    incomplete = {**_COMPLETE, "audience": None, "format_and_length": None}
    import json as _json

    monkeypatch.setattr(
        "langchain_anthropic.ChatAnthropic",
        lambda **_k: type(
            "_M", (), {"invoke": lambda self, _m: type("_R", (), {"text": lambda s: _json.dumps(incomplete)})()}
        )(),
    )
    # Ledger read inside extraction path: reuse the canned-model route by
    # making read_ledger_with_fallback return a single deliverable entry.
    monkeypatch.setattr(
        "deerflow.sophia.delegation_ledger.read_ledger_with_fallback",
        lambda _u, _t: [{"turn_number": 40, "user_text": "build the deck", "artifact": {}, "deliverable_intent": True}],
    )
    sections, updates = _delegation_boundary_sections(_context_with_stats(), "presentation")
    gate_sections = [s for s in sections if s.startswith("<brief_gate>")]
    assert len(gate_sections) == 1
    assert "audience" in gate_sections[0]
    assert "format_and_length" in gate_sections[0]
    assert "read_session_context" in gate_sections[0]
    assert "NEVER ask the user" in gate_sections[0]
    assert updates["brief_gate_missing_fields"] == ["audience", "format_and_length"]


def test_gate_flag_off_suppresses_directive(monkeypatch):
    monkeypatch.setenv("SOPHIA_DELEGATION_BRIEF_GATE", "0")
    incomplete = {**_COMPLETE, "audience": None}
    import json as _json

    monkeypatch.setattr(
        "langchain_anthropic.ChatAnthropic",
        lambda **_k: type(
            "_M", (), {"invoke": lambda self, _m: type("_R", (), {"text": lambda s: _json.dumps(incomplete)})()}
        )(),
    )
    monkeypatch.setattr(
        "deerflow.sophia.delegation_ledger.read_ledger_with_fallback",
        lambda _u, _t: [{"turn_number": 40, "user_text": "build the deck", "artifact": {}, "deliverable_intent": True}],
    )
    sections, updates = _delegation_boundary_sections(_context_with_stats(), "presentation")
    assert all("<brief_gate>" not in s for s in sections)
    assert "brief_gate_missing_fields" not in updates


# ---- emit arg + honesty stamp ---------------------------------------------------


def test_brief_assumptions_accepted_by_emit_schema():
    payload = BuilderArtifactInput(
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        artifact_type="presentation",
        artifact_title="Launch deck",
        steps_completed=5,
        decisions_made=["used boardroom theme"],
        companion_summary="Deck is ready.",
        companion_tone_hint="upbeat",
        confidence=0.9,
        brief_assumptions=["assumed a 10-slide length"],
    )
    assert payload.brief_assumptions == ["assumed a 10-slide length"]
    # Optional with default None — old emits remain valid.
    assert BuilderArtifactInput(
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        artifact_type="presentation",
        artifact_title="Launch deck",
        steps_completed=5,
        decisions_made=["x"],
        companion_summary="s",
        companion_tone_hint="t",
        confidence=0.5,
    ).brief_assumptions is None


def test_honesty_stamp_only_when_undisclosed_and_unrecovered():
    state = {"brief_gate_missing_fields": ["audience"], "builder_session_context_reads": 0}
    # Neither recovered nor disclosed → named.
    assert brief_gate_unmet_conditions(state, {}) == ["brief_incomplete:audience"]
    # Disclosed via assumptions → clean.
    assert brief_gate_unmet_conditions(state, {"brief_assumptions": ["assumed CTO audience"]}) == []
    # Recovered via reads → clean.
    state_read = {**state, "builder_session_context_reads": 2}
    assert brief_gate_unmet_conditions(state_read, {}) == []
    # No gate flag → clean.
    assert brief_gate_unmet_conditions({}, {}) == []


def test_brief_assumptions_whitelisted_in_all_payload_sites():
    from deerflow.sophia.builder_events import _artifact_completion_fields

    fields = _artifact_completion_fields(
        {"brief_assumptions": ["assumed X"]}, None, None, None
    )
    assert fields["brief_assumptions"] == ["assumed X"]

    from app.gateway.routers.builder_events import (
        _TERMINAL_TASK_OPTIONAL_FIELDS,
        BuilderCompletionEvent,
        _durable_builder_result,
    )

    assert "brief_assumptions" in _TERMINAL_TASK_OPTIONAL_FIELDS
    assert "brief_assumptions" in BuilderCompletionEvent.model_fields
    durable = _durable_builder_result({"brief_assumptions": ["assumed X"], "status": "success"})
    assert durable["brief_assumptions"] == ["assumed X"]

    import inspect

    from app.gateway.routers import builder_canvas

    assert "brief_assumptions" in inspect.getsource(builder_canvas)


def test_companion_delegation_skill_carries_relay_rule():
    from pathlib import Path

    skill = (
        Path(__file__).resolve().parents[2]
        / "skills"
        / "public"
        / "sophia"
        / "companion_delegation.md"
    ).read_text(encoding="utf-8")
    assert "brief_assumptions" in skill
    assert "Never present an assumption as something the user said" in skill


def test_build_awareness_surfaces_assumptions():
    from deerflow.agents.sophia_agent.middlewares.build_awareness import (
        _render_terminal_block,
    )

    block = _render_terminal_block(
        {
            "status": "success",
            "task_id": "task-1",
            "task_type": "presentation",
            "builder_result": {"brief_assumptions": ["assumed a technical audience"]},
        }
    )
    assert "assumed a technical audience" in block
    assert "never present an assumption" in block.lower()
