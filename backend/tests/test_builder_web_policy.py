"""Unit tests for the builder's autonomous-research capability gate."""

from __future__ import annotations

import pytest

from deerflow.sophia.builder_web_policy import should_allow_builder_web_research


class TestBuilderResearchDefaults:
    def test_builder_research_default_on_for_documents(self):
        """Document builds keep research available even without explicit cues."""
        assert should_allow_builder_web_research(
            "document",
            "Write a 3-page brief on our Q3 product roadmap.",
        ) is True
        # Variations: trailing whitespace, uppercase — still on.
        assert should_allow_builder_web_research(
            " DOCUMENT ",
            "Draft internal memo — no external refs needed.",
        ) is True

    def test_builder_research_default_on_for_code(self):
        """Frontend builds can still need external facts or explicit URLs."""
        assert should_allow_builder_web_research(
            "frontend",
            "Build a dark-mode toggle component.",
        ) is True
        assert should_allow_builder_web_research(
            "frontend",
            "Build a latest-trend component with current pricing widget.",
        ) is True

    def test_builder_research_research_task_type_still_on(self):
        """Regression: ``research`` task type must remain unconditionally on."""
        assert should_allow_builder_web_research("research", "") is True
        assert should_allow_builder_web_research("research", "anything") is True

    def test_builder_research_presentation_default_on(self):
        """Presentation builds also keep research available by default."""
        assert should_allow_builder_web_research(
            "presentation",
            "Build a 5-slide deck summarising our internal brand guidelines.",
        ) is True
        assert should_allow_builder_web_research(
            "presentation",
            "Build a deck on the latest competitor pricing.",
        ) is True
        # Explicit URL flips it on.
        assert should_allow_builder_web_research(
            "presentation",
            "Build a deck using the data at https://example.com/dataset.",
        ) is True

    @pytest.mark.parametrize(
        "task_type",
        ["", "unknown", "audio", "widget"],
    )
    def test_builder_research_unknown_task_type_defaults_off(self, task_type: str):
        """Unknown task types still receive the browsing capability."""
        assert should_allow_builder_web_research(task_type, "") is True
