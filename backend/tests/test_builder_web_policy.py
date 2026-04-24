"""Unit tests for the builder's autonomous-research gate.

PR-C F5 (2026-04-24) flipped ``document`` task types to default-on. These
tests lock that behaviour and confirm that adjacent task types
(``presentation``, ``visual_report``, ``frontend``, ``research``) still
follow their established rules.
"""

from __future__ import annotations

import pytest

from deerflow.sophia.builder_web_policy import should_allow_builder_web_research


class TestBuilderResearchDefaults:
    def test_builder_research_default_on_for_documents(self):
        """PR-C F5: ``task_type=document`` defaults to research-on, even without
        explicit URLs or freshness cues in the task text. This replaces the
        freshness-cue heuristic which was too restrictive for doc builds."""
        assert should_allow_builder_web_research(
            "document",
            "Write a 3-page brief on our Q3 product roadmap.",
        ) is True
        # Variations: trailing whitespace, uppercase — still on.
        assert should_allow_builder_web_research(
            " DOCUMENT ",
            "Draft internal memo — no external refs needed.",
        ) is True

    def test_builder_research_default_off_for_code(self):
        """PR-C F5: ``task_type=frontend`` (code-like) stays off — the builder
        should rely on the sandbox + delegated brief, not browse for code
        snippets at run time."""
        assert should_allow_builder_web_research(
            "frontend",
            "Build a dark-mode toggle component.",
        ) is False
        # Even with freshness cues in the text, frontend stays off.
        assert should_allow_builder_web_research(
            "frontend",
            "Build a latest-trend component with current pricing widget.",
        ) is False

    def test_builder_research_research_task_type_still_on(self):
        """Regression: ``research`` task type must remain unconditionally on."""
        assert should_allow_builder_web_research("research", "") is True
        assert should_allow_builder_web_research("research", "anything") is True

    def test_builder_research_presentation_still_requires_cue_or_url(self):
        """Regression: ``presentation`` keeps the freshness-cue heuristic — no
        cue, no URL → research-off. This is intentionally unchanged by PR-C."""
        assert should_allow_builder_web_research(
            "presentation",
            "Build a 5-slide deck summarising our internal brand guidelines.",
        ) is False
        # Freshness cue flips it on.
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
        """Unknown task types default to off — only the whitelist permits
        research. This is unchanged by PR-C."""
        assert should_allow_builder_web_research(task_type, "") is False
