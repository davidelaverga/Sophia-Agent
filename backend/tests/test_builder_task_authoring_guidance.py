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

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware


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
        assert "write_todos for planning" in briefing
        assert "builder_web_search or builder_web_fetch at least once" in briefing
        assert "write_file, str_replace, artifact-generating bash" in briefing

    def test_briefing_does_not_disable_research_for_frontend(self) -> None:
        state = _make_state("frontend")
        state["delegation_context"]["allow_web_research"] = False

        result = BuilderTaskMiddleware().before_agent(state, _make_runtime())
        briefing = _briefing(result)

        assert "Web research is available for every builder task type" in briefing
        assert "External browsing is disabled" not in briefing
