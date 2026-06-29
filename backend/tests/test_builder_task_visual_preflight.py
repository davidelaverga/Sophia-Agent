"""Visual capability prompt tests.

Image generation is mandatory for PPTX decks and opt-in for other builder
tasks. Presentation and visual report tasks should not hard-stop when
``OPENAI_API_KEY`` is missing, but PPTX prompts must still describe the
image-forward contract instead of switching to native text layouts.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware


def _make_runtime() -> MagicMock:
    runtime = MagicMock()
    runtime.context = {}
    return runtime


def _make_state(task_type: str) -> dict:
    return {
        "system_prompt_blocks": [],
        "delegation_context": {
            "companion_artifact": {"tone_estimate": 2.5, "active_tone_band": "engagement"},
            "task_type": task_type,
            "relevant_memories": [],
            "active_ritual": None,
            "ritual_phase": None,
        },
    }


def _briefing(result: dict) -> str:
    return result["system_prompt_blocks"][-1]


class TestVisualCapabilityPrompt:
    def test_presentation_without_openai_key_does_not_inject_missing_capability(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        result = BuilderTaskMiddleware().before_agent(_make_state("presentation"), _make_runtime())
        assert result is not None
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing
        assert "OPENAI_API_KEY is not set" not in briefing
        assert "STOP IMMEDIATELY" not in briefing

    def test_visual_report_without_openai_key_does_not_inject_missing_capability(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        result = BuilderTaskMiddleware().before_agent(_make_state("visual_report"), _make_runtime())
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_presentation_with_openai_key_does_not_inject(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        result = BuilderTaskMiddleware().before_agent(_make_state("presentation"), _make_runtime())
        assert result is not None
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_research_task_does_not_check_visual_capability(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Text-only research deliverables don't need OPENAI_API_KEY for image
        # generation. Even when the key is missing, the gate must not fire
        # for non-visual task types — otherwise we'd block legitimate text
        # deliverables that work fine without OpenAI.
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        result = BuilderTaskMiddleware().before_agent(_make_state("research"), _make_runtime())
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_document_task_does_not_check_visual_capability(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        result = BuilderTaskMiddleware().before_agent(_make_state("document"), _make_runtime())
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_unknown_task_type_does_not_check_visual_capability(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        result = BuilderTaskMiddleware().before_agent(_make_state("frontend"), _make_runtime())
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_empty_string_key_treated_as_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Empty Render env vars should not block presentation builds because
        # a valid chart/text PPTX can still be delivered.
        monkeypatch.setenv("OPENAI_API_KEY", "")
        result = BuilderTaskMiddleware().before_agent(_make_state("presentation"), _make_runtime())
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_whitespace_only_key_treated_as_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "   ")
        result = BuilderTaskMiddleware().before_agent(_make_state("presentation"), _make_runtime())
        briefing = _briefing(result)
        assert "<missing_capability>" not in briefing

    def test_plain_presentation_prompt_keeps_image_forward_contract(self) -> None:
        state = _make_state("presentation")
        state["delegation_context"]["task"] = "Build a plain text-only deck about the roadmap with no images"

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())

        briefing = _briefing(result)
        skill_names = _available_skills_section(briefing)
        assert "image-generation" in skill_names
        assert "Image generation is disabled for this run" not in briefing
        assert "do not run the image-generation script" not in briefing
        assert "pure image-forward PPTX builds" in briefing
        assert "full-slide image" in briefing
        assert "deck_plan.json" in briefing
        assert "ppt-generation/scripts/generate.py" in briefing


def _available_skills_section(briefing: str) -> str:
    start = briefing.find("<available_skills>")
    end = briefing.find("</available_skills>")
    if start == -1 or end == -1:
        return ""
    return briefing[start:end]
