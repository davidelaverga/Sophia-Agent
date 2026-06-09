"""Regression tests for the Builder terminal artifact handoff contract.

Context: a Builder smoke run for an explicit artifact-creation task
finished/finalized WITHOUT producing a deliverable and WITHOUT calling
``emit_builder_artifact``. Telemetry showed:

    builderFailureStage=completion_reconciliation
    builderFailureCode=builder_completed_without_deliverable
    builderEmitAttempted=false
    builderOutputsSummaryCount=0

Research is NOT the bug — the Builder is allowed to research. The bug is
that an explicit artifact task with a known target path was allowed to
end on research/planning/summary text alone.

These tests lock two halves of the fix:

1. The Builder-injected prompt (``BuilderTaskMiddleware``) carries a
   ``<terminal_artifact_handoff>`` contract whenever the task has an
   explicit ``artifact_target_path`` — research allowed but never the
   deliverable, write+verify+emit required, final action MUST be
   emit_builder_artifact, with HTML/Markdown specific shape rules.
2. The completion-reconciliation + sanitized diagnostics still mark a
   no-deliverable terminal as failed with the right code, preserve
   ``emit_attempted=false``, report outputs summary + target existence,
   and never leak raw content / blame Supabase.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.sophia.builder_failure_diagnostics import build_builder_failure_diagnostics


def _runtime() -> MagicMock:
    runtime = MagicMock()
    runtime.context = {}
    return runtime


def _state_with_target(target_path: str, task_type: str = "document") -> dict:
    return {
        "system_prompt_blocks": [],
        "builder_artifact_target_path": target_path,
        "delegation_context": {
            "companion_artifact": {"tone_estimate": 2.5, "active_tone_band": "engagement"},
            "task_type": task_type,
            "relevant_memories": [],
            "active_ritual": None,
            "ritual_phase": None,
            "artifact_target_path": target_path,
        },
    }


def _briefing(result: dict) -> str:
    return result["system_prompt_blocks"][-1]


class TestTerminalArtifactContractPresent:
    """An explicit artifact target forces the terminal emit obligation."""

    def test_handoff_block_present_for_explicit_target(self) -> None:
        result = BuilderTaskMiddleware().before_agent(
            _state_with_target("/mnt/user-data/outputs/report.md"), _runtime()
        )
        briefing = _briefing(result)
        assert "<terminal_artifact_handoff>" in briefing
        assert "/mnt/user-data/outputs/report.md" in briefing

    def test_research_allowed_but_not_the_deliverable(self) -> None:
        briefing = _briefing(
            BuilderTaskMiddleware().before_agent(
                _state_with_target("/mnt/user-data/outputs/report.md"), _runtime()
            )
        )
        # Research is explicitly permitted ...
        assert "You MAY research first" in briefing
        # ... but is explicitly not, on its own, the deliverable.
        assert "are NOT the deliverable" in briefing

    def test_requires_write_then_emit_terminal_sequence(self) -> None:
        briefing = _briefing(
            BuilderTaskMiddleware().before_agent(
                _state_with_target("/mnt/user-data/outputs/report.md"), _runtime()
            )
        )
        assert "INCOMPLETE until the target file" in briefing
        assert "verify the file exists" in briefing
        assert "Your FINAL action MUST be emit_builder_artifact" in briefing
        assert "never a plain-text response" in briefing

    def test_structured_failure_instead_of_pretending_success(self) -> None:
        briefing = _briefing(
            BuilderTaskMiddleware().before_agent(
                _state_with_target("/mnt/user-data/outputs/report.md"), _runtime()
            )
        )
        assert "do NOT pretend success" in briefing
        assert "fallback_reason" in briefing

    def test_no_handoff_block_without_explicit_target(self) -> None:
        state = {
            "system_prompt_blocks": [],
            "delegation_context": {
                "companion_artifact": {"tone_estimate": 2.5, "active_tone_band": "engagement"},
                "task_type": "research",
                "relevant_memories": [],
                "active_ritual": None,
                "ritual_phase": None,
            },
        }
        briefing = _briefing(BuilderTaskMiddleware().before_agent(state, _runtime()))
        assert "<terminal_artifact_handoff>" not in briefing


class TestHtmlArtifactContract:
    def test_html_target_requires_standalone_html(self) -> None:
        briefing = _briefing(
            BuilderTaskMiddleware().before_agent(
                _state_with_target("/mnt/user-data/outputs/page.html"), _runtime()
            )
        )
        assert "STANDALONE .html" in briefing
        # Markdown fences explicitly forbidden.
        assert "Do NOT wrap the HTML in Markdown code fences" in briefing
        assert "Do NOT write a .md file and call it HTML" in briefing
        # Final emit required with html/webpage type.
        assert 'artifact_type="html"' in briefing
        assert "emit_builder_artifact" in briefing


class TestMarkdownArtifactContract:
    def test_markdown_target_requires_md_file_and_emit(self) -> None:
        briefing = _briefing(
            BuilderTaskMiddleware().before_agent(
                _state_with_target("/mnt/user-data/outputs/notes.md"), _runtime()
            )
        )
        assert "write a real .md file" in briefing
        assert 'artifact_type="document"' in briefing
        assert "Your FINAL action MUST be emit_builder_artifact" in briefing


class TestNoDeliverableCompletionDiagnostics:
    """No-deliverable terminal stays failed; diagnostics stay honest."""

    def test_no_deliverable_diagnostic_shape(self, tmp_path: Path) -> None:
        outputs = tmp_path / "outputs"
        outputs.mkdir()  # empty — builder researched but wrote nothing
        state = {
            "thread_data": {"outputs_path": str(outputs)},
            "builder_artifact_target_path": "/mnt/user-data/outputs/report.md",
            "delegation_context": {
                "task_type": "document",
                "artifact_target_path": "/mnt/user-data/outputs/report.md",
            },
        }
        diagnostic = build_builder_failure_diagnostics(
            state=state,
            runtime=SimpleNamespace(context={"thread_id": "builder-thread"}),
            failure_stage="completion_reconciliation",
            failure_reason="Builder finished without a deliverable artifact.",
            failure_code="builder_completed_without_deliverable",
            emit_attempted=False,
            emit_tool_call_seen=False,
            canvas_reconciliation_action="coerced_success_to_failed_no_deliverable",
            supabase_mirror_result="skipped",
        )

        assert diagnostic["failure_stage"] == "completion_reconciliation"
        assert diagnostic["failure_code"] == "builder_completed_without_deliverable"
        # emit_attempted=false must be preserved (not coerced to True).
        assert diagnostic["emit_attempted"] is False
        # Supabase skipped/not_configured must not be blamed as the failure.
        assert diagnostic["supabase_mirror_result"] == "skipped"
        assert diagnostic["failure_stage"] != "storage_mirror"
        # Expected target existence is reported (False — nothing written).
        assert diagnostic["artifact_target_exists"] is False
        # Outputs summary present + bounded (empty here → count 0).
        assert diagnostic["outputs_summary"] == []

    def test_outputs_summary_reports_existence_without_raw_content(self, tmp_path: Path) -> None:
        outputs = tmp_path / "outputs"
        outputs.mkdir()
        secret_html = "<!doctype html><html><body>TOP_SECRET_PAYLOAD</body></html>"
        (outputs / "report.html").write_text(secret_html, encoding="utf-8")
        state = {
            "thread_data": {"outputs_path": str(outputs)},
            "builder_artifact_target_path": "/mnt/user-data/outputs/report.html",
            "delegation_context": {
                "task_type": "document",
                "artifact_target_path": "/mnt/user-data/outputs/report.html",
            },
        }
        diagnostic = build_builder_failure_diagnostics(
            state=state,
            runtime=SimpleNamespace(context={"thread_id": "builder-thread"}),
            failure_stage="completion_reconciliation",
            failure_reason="Builder finished without a deliverable artifact.",
            failure_code="builder_completed_without_deliverable",
            emit_attempted=False,
            emit_tool_call_seen=False,
        )

        summary = diagnostic["outputs_summary"]
        assert isinstance(summary, list)
        assert len(summary) == 1
        entry = summary[0]
        assert entry["relative_path"] == "report.html"
        assert entry["extension"] == "html"
        assert entry["exists"] is True
        # The known target path existence is reported.
        assert diagnostic["artifact_target_exists"] is True
        # No raw artifact content/HTML leaks anywhere in the payload.
        assert "TOP_SECRET_PAYLOAD" not in repr(diagnostic)
        assert diagnostic["raw_content_excluded"] is True
        assert diagnostic["raw_artifact_text_excluded"] is True
