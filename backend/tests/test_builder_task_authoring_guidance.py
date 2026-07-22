"""Regression-locking tests for BuilderTaskMiddleware's text-authoring guidance.

Phase 4M (2026-05-19): the production builder regression on long-form
markdown deep dives was caused by the prompt forbidding repeat
``write_file_tool`` calls to the same path. With no documented
alternative for extending a long document, the model fell back to
``bash`` + python heredocs (``cat > file << 'EOF'``, ``python -c
"with open(...).write(...)"``) — a fragile pattern that regenerates
the whole document each turn and burns the wall-clock + turn budget
in a 110-second-per-turn rewrite loop. Production logs at task_id
``019e423f-9d26-71e3-8fce-4cd8cc5de0a1`` show:

    turn 10: write_file (model wrote opening chunk)
    turn 11: bash         (verify via ls/cat — 2s LLM)
    turn 12: bash         (109s LLM — full heredoc rewrite)
    turn 13: bash         (verify — 2s)
    turn 14: bash         (114s LLM — full heredoc rewrite)
    ... continues every turn with bash

These tests lock the corrective guidance: the builder system prompt
MUST teach the model that (a) ``write_file_tool(append=True)`` is
the right primitive for extending a long document, and (b) bash
heredocs / ``python -c "with open(...)"`` for authoring are
FORBIDDEN.

Companion fix: the ``write_file_tool`` docstring at
``backend/packages/harness/deerflow/sandbox/tools.py`` now documents
the ``append`` parameter — without it, the model couldn't discover
the alternative even with the prompt nudge.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from deerflow.agents.sophia_agent.middlewares.builder_task import (
    BuilderTaskMiddleware,
    _pptx_visual_guidance,
)


def _make_runtime() -> MagicMock:
    runtime = MagicMock()
    runtime.context = {}
    return runtime


def _make_state(task_type: str = "document") -> dict:
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


class TestWriteFileAppendGuidance:
    """The completion_instruction must teach append-mode as the
    correct primitive for extending a long document."""

    def test_briefing_mentions_append_true_for_long_documents(self) -> None:
        result = BuilderTaskMiddleware().before_agent(_make_state(), _make_runtime())
        briefing = _briefing(result)
        # Acceptance: any of these phrasings signals the guidance is present.
        assert "append=True" in briefing, (
            "completion_instruction must explicitly mention write_file_tool's "
            "append=True parameter — without this guidance the model falls "
            "back to bash heredocs for long documents"
        )

    def test_briefing_uses_actual_write_file_schema(self) -> None:
        result = BuilderTaskMiddleware().before_agent(_make_state(), _make_runtime())
        briefing = _briefing(result)

        assert "write_file(description=" in briefing
        assert "path='/mnt/user-data/outputs/name.ext'" in briefing
        assert "content='...'" in briefing
        assert "write_file_tool(path, content)" not in briefing

    def test_briefing_permits_multiple_write_file_calls(self) -> None:
        """The previous (broken) version said: "Do NOT split the same file
        across multiple write_file_tool calls". This test locks that we
        no longer carry that prohibition (it was the root cause of the
        bash-heredoc loop).
        """
        result = BuilderTaskMiddleware().before_agent(_make_state(), _make_runtime())
        briefing = _briefing(result)
        forbidden_phrases = [
            "Do NOT split the same file across multiple write_file_tool calls",
            "do NOT call write_file_tool repeatedly to the same path",
        ]
        for phrase in forbidden_phrases:
            assert phrase not in briefing, (
                f"completion_instruction must not contain the trap phrase "
                f"{phrase!r} — it caused the production bash-heredoc loop. "
                f"The replacement guidance teaches append=True instead."
            )


class TestBashAuthoringProhibition:
    """The completion_instruction must explicitly prohibit using bash
    to write file content. This closes the bash-heredoc trap."""

    def test_briefing_forbids_bash_for_text_authoring(self) -> None:
        result = BuilderTaskMiddleware().before_agent(_make_state(), _make_runtime())
        briefing = _briefing(result)
        # Acceptance: explicit prohibition language MUST be present.
        prohibition_signals = [
            "NEVER use bash_tool to author text file content",
        ]
        for signal in prohibition_signals:
            assert signal in briefing, (
                f"completion_instruction must contain prohibition signal "
                f"{signal!r} so the model knows bash is for execution, not authoring"
            )

    def test_briefing_calls_out_specific_forbidden_patterns(self) -> None:
        """Listing the exact bash patterns the model was reaching for
        (heredoc, ``python -c``, ``echo >``) gives the model a clear
        match-to-pattern signal at decision time. Generic 'don't use
        bash' guidance is weaker than concrete pattern matches."""
        result = BuilderTaskMiddleware().before_agent(_make_state(), _make_runtime())
        briefing = _briefing(result)
        forbidden_patterns = [
            "cat > file.md << 'EOF'",
            "python -c",
            "python - << 'PYEOF'",
            "echo '...' > file.md",
        ]
        missing = [p for p in forbidden_patterns if p not in briefing]
        assert not missing, (
            f"completion_instruction is missing concrete forbidden-pattern "
            f"signals for: {missing}. The model picked exactly these "
            f"patterns in production on 2026-05-19; listing them by example "
            f"is a stronger nudge than abstract 'don't use bash' advice"
        )

    def test_briefing_still_permits_bash_for_execution(self) -> None:
        """We must NOT throw the baby out with the bathwater: bash is
        legitimately the right tool for running generator scripts that
        produce binary deliverables (chart-visualization,
        ppt-generation, etc.). The prohibition is scoped to authoring
        text, not all bash use.
        """
        result = BuilderTaskMiddleware().before_agent(_make_state(), _make_runtime())
        briefing = _briefing(result)
        # Existing PDF / pptx / image guidance still tells the model to
        # bash-run skill generators. We're only forbidding bash for
        # AUTHORING TEXT CONTENT. The "for EXECUTION" carve-out signal
        # must be present so the model doesn't infer a blanket bash ban.
        assert "bash_tool is for EXECUTION" in briefing
        # Sanity: the generator-script section (which uses bash legitimately)
        # is unchanged downstream.
        assert "generator script" in briefing


class TestBuilderResearchGuidance:
    def test_briefing_requires_research_before_substantive_write(self) -> None:
        result = BuilderTaskMiddleware().before_agent(_make_state("frontend"), _make_runtime())
        briefing = _briefing(result)

        assert "Web research is available for every builder task type" in briefing
        assert "`write_todos` for planning" in briefing
        assert "`builder_web_search` or `builder_web_fetch` at least once" in briefing
        assert "write_file, str_replace, artifact-generating bash" in briefing

    def test_briefing_honors_disabled_research_for_frontend(self) -> None:
        state = _make_state("frontend")
        state["delegation_context"]["allow_web_research"] = False

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "Web research is available for every builder task type" not in briefing
        assert "`builder_web_search` or `builder_web_fetch` at least once" not in briefing


def test_fresh_pptx_guidance_requires_typed_repair_anchor_ids() -> None:
    guidance = _pptx_visual_guidance(
        deck_service_enabled=True,
        image_generation_enabled=True,
    )

    assert "exactly two repair_anchor_ids" in guidance
    assert "omit slide_css or pass an empty string" in guidance


class TestBuilderWorkflowCards:
    # Artifact Visual System Phase 5b: the per-type composition cards
    # (pptx/pdf/html/visuals) are retired — composition guidance now lives in
    # the always-injected <visual_composition> directives + the per-type
    # skills. Only the orthogonal research card may still be injected.

    def test_pptx_task_injects_directives_not_retired_pptx_card(self) -> None:
        state = _make_state("presentation")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "<visual_composition>" in briefing
        assert "ppt-generation" in briefing  # directives §5 name the deck skill
        assert '<builder_workflow_card name="pptx"' not in briefing
        assert '<builder_workflow_card name="pdf"' not in briefing

    def test_html_task_injects_directives_not_retired_html_card(self) -> None:
        state = _make_state("document")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/report.html"

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "<visual_composition>" in briefing
        assert "hallmark" in briefing  # directives §5 name the HTML design system
        assert '<builder_workflow_card name="html"' not in briefing
        assert '<builder_workflow_card name="pptx"' not in briefing

    def test_visual_request_injects_directives_not_retired_visuals_card(self) -> None:
        state = _make_state("document")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/report.pdf"
        state["delegation_context"]["description"] = "Build a PDF report with charts and diagrams"

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "<visual_composition>" in briefing
        assert "pdf-report" in briefing  # directives §5 name the report skill
        assert '<builder_workflow_card name="visuals"' not in briefing

    def test_pdf_targeted_presentation_keeps_deck_guidance(self, monkeypatch) -> None:
        monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)
        state = _make_state("presentation")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/deck.pdf"
        state["delegation_context"]["task"] = "Make a 10-slide deck in PDF format for the roadmap review."

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "<pptx_slide_count_target>" in briefing
        assert "Requested PPTX length: exactly 10 total slides" in briefing
        assert "PDF slide-deck delivery target" in briefing
        assert "build_deck_from_slides" in briefing
        assert "Call prepare_deck_build" not in briefing
        assert "This is a PDF target: author ONE self-contained HTML file" not in briefing
        assert "then render the real .pdf" not in briefing

    def test_pptx_guidance_uses_legacy_tools_when_deck_service_disabled(self, monkeypatch) -> None:
        monkeypatch.setenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", "false")
        monkeypatch.setenv("SOPHIA_DECK_LEGACY_SCREENSHOT_DEBUG", "true")
        state = _make_state("presentation")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
        state["delegation_context"]["task"] = "Make a 6-slide technical presentation."

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "Decks are built by prepare_deck_build" not in briefing
        assert "explicit non-production legacy/debug route" in briefing
        assert "prepare_pptx_image_manifest" in briefing
        assert "build_deck_from_slides" in briefing

    def test_pptx_guidance_uses_deck_service_by_default(self, monkeypatch) -> None:
        monkeypatch.delenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED", raising=False)
        state = _make_state("presentation")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
        state["delegation_context"]["task"] = "Make a 6-slide technical presentation."

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "Decks are built by prepare_deck_build" in briefing
        assert "For fresh decks, call prepare_deck_build once" in briefing
        assert "one repair retry when retryable=true" in briefing
        assert "Do NOT call prepare_pptx_image_manifest" in briefing

    def test_pptx_slide_target_clamps_to_supported_limit(self) -> None:
        state = _make_state("presentation")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
        state["delegation_context"]["task"] = "Create a 50-slide technical presentation."

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "Requested PPTX length: exactly 30 total slides" in briefing
        assert "exactly 50 total slides" not in briefing
        assert result["builder_pptx_requested_slide_count"] == 30

    def test_pptx_slide_target_clamps_three_digit_requests(self) -> None:
        state = _make_state("presentation")
        state["delegation_context"]["artifact_target_path"] = "/mnt/user-data/outputs/deck.pptx"
        state["delegation_context"]["task"] = "Create a 100-slide technical presentation."

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "Requested PPTX length: exactly 30 total slides" in briefing
        assert "exactly 100 total slides" not in briefing
        assert result["builder_pptx_requested_slide_count"] == 30
