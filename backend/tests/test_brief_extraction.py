"""G-DEL-3 — schema'd brief extraction: triggered deterministically, grounded
with provenance, and failure never blocks the briefing."""

from __future__ import annotations

import json

import pytest
from delegation_fixture import THREAD_ID, USER_ID, fixture_entries, materialize_ledger

from deerflow.agents.sophia_agent.middlewares.builder_task import (
    _delegation_boundary_sections,
)
from deerflow.sophia import brief_extraction

# ---- trigger ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("stats", "expected"),
    [
        ({"turns": 6, "deliverable_intent_turns": 2, "was_summarized": False}, False),
        ({"turns": 20, "deliverable_intent_turns": 0, "was_summarized": False}, True),
        ({"turns": 5, "deliverable_intent_turns": 6, "was_summarized": False}, True),
        ({"turns": 3, "deliverable_intent_turns": 0, "was_summarized": True}, True),
        (None, False),
    ],
)
def test_extraction_trigger_matrix(stats, expected):
    assert brief_extraction.extraction_triggered(stats) is expected


def test_no_model_call_below_threshold(monkeypatch):
    """A 6-turn session must trigger NO extraction call (sentinel model)."""

    def _sentinel(*_a, **_k):
        raise AssertionError("model must not be constructed below threshold")

    monkeypatch.setattr("langchain_anthropic.ChatAnthropic", _sentinel)
    stats = {"turns": 6, "deliverable_intent_turns": 2, "was_summarized": False}
    sections, updates = _delegation_boundary_sections(
        {
            "delegation_ledger": {**stats, "available": True},
            "parent_user_id": USER_ID,
            "parent_thread_id": THREAD_ID,
        },
        "presentation",
    )
    assert all("<build_brief_schema>" not in section for section in sections)
    assert "brief_schema" not in updates


# ---- extraction + validation ---------------------------------------------------


_CANNED_SCHEMA = {
    "audience": "enterprise CTOs [t3]",
    "purpose": "investor-ready launch deck [t40]",
    "format_and_length": "10 slides [t40]",
    "must_include": ["Q3 numbers: 4.2M revenue, 38% margin [t18]", "migration timeline [t31]"],
    "must_exclude": ["pricing slides [t25]"],
    "sources_and_examples": [],
    "style_preferences": ["hand-drawn, never corporate stock [t12]"],
    "decisions_made": [],
    "open_questions": [],
}


class _FakeReply:
    def __init__(self, text: str) -> None:
        self._text = text

    def text(self) -> str:
        return self._text


class _FakeModel:
    def __init__(self, reply: str) -> None:
        self._reply = reply

    def invoke(self, _messages):
        return _FakeReply(self._reply)


def _patch_model(monkeypatch, reply: str) -> None:
    monkeypatch.setattr(
        "langchain_anthropic.ChatAnthropic",
        lambda **_kwargs: _FakeModel(reply),
    )


def test_extraction_grounds_t18_and_t25_with_provenance(monkeypatch):
    _patch_model(monkeypatch, json.dumps(_CANNED_SCHEMA))
    schema = brief_extraction.extract_brief(fixture_entries(), "presentation")
    assert schema is not None
    assert any("Q3" in item and "[t18]" in item for item in schema["must_include"])
    assert any("[t25]" in item for item in schema["must_exclude"])
    assert schema["audience"] == "enterprise CTOs [t3]"


def test_fields_without_provenance_are_nulled_not_invented(monkeypatch):
    tampered = dict(_CANNED_SCHEMA)
    tampered["audience"] = "enterprise CTOs"  # no [t{n}] marker
    tampered["must_include"] = ["Q3 numbers [t18]", "made-up requirement"]
    _patch_model(monkeypatch, json.dumps(tampered))
    schema = brief_extraction.extract_brief(fixture_entries(), "presentation")
    assert schema["audience"] is None
    assert schema["must_include"] == ["Q3 numbers [t18]"]


def test_code_fences_are_stripped(monkeypatch):
    _patch_model(monkeypatch, "```json\n" + json.dumps(_CANNED_SCHEMA) + "\n```")
    schema = brief_extraction.extract_brief(fixture_entries(), "presentation")
    assert schema is not None
    assert schema["format_and_length"] == "10 slides [t40]"


@pytest.mark.parametrize("bad_reply", ["not json at all", "[1, 2, 3]", ""])
def test_invalid_reply_returns_none(monkeypatch, bad_reply):
    _patch_model(monkeypatch, bad_reply)
    assert brief_extraction.extract_brief(fixture_entries(), "presentation") is None


def test_model_exception_returns_none(monkeypatch):
    class _Boom:
        def __init__(self, **_kwargs):
            raise RuntimeError("api down")

    monkeypatch.setattr("langchain_anthropic.ChatAnthropic", _Boom)
    assert brief_extraction.extract_brief(fixture_entries(), "presentation") is None


def test_flag_off_skips_extraction(monkeypatch):
    monkeypatch.setenv("SOPHIA_DELEGATION_EXTRACTION", "0")
    monkeypatch.setattr(
        "langchain_anthropic.ChatAnthropic",
        lambda **_k: (_ for _ in ()).throw(AssertionError("must not construct")),
    )
    assert brief_extraction.extract_brief(fixture_entries(), "presentation") is None


# ---- briefing integration ------------------------------------------------------


def _triggered_context() -> dict:
    return {
        "delegation_ledger": {
            "turns": 40,
            "deliverable_intent_turns": 8,
            "was_summarized": True,
            "available": True,
        },
        "parent_user_id": USER_ID,
        "parent_thread_id": THREAD_ID,
    }


def test_briefing_renders_schema_section_when_triggered(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    _patch_model(monkeypatch, json.dumps(_CANNED_SCHEMA))
    sections, updates = _delegation_boundary_sections(_triggered_context(), "presentation")
    schema_sections = [s for s in sections if s.startswith("<build_brief_schema>")]
    assert len(schema_sections) == 1
    assert "[t18]" in schema_sections[0]
    assert updates["brief_schema"]["must_exclude"] == ["pricing slides [t25]"]


def test_extraction_failure_never_blocks_briefing(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    _patch_model(monkeypatch, "garbage")
    sections, updates = _delegation_boundary_sections(_triggered_context(), "presentation")
    # Recall line still present; no schema section; no exception.
    assert any("<session_recall>" in s for s in sections)
    assert all("<build_brief_schema>" not in s for s in sections)
    assert "brief_schema" not in updates


def test_existing_schema_skips_model_call_and_duplicate_section(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "langchain_anthropic.ChatAnthropic",
        lambda **_k: (_ for _ in ()).throw(AssertionError("resume must not re-extract")),
    )
    sections, updates = _delegation_boundary_sections(
        _triggered_context(), "presentation", existing_schema=_CANNED_SCHEMA
    )
    assert all("<build_brief_schema>" not in s for s in sections)
    assert "brief_schema" not in updates
