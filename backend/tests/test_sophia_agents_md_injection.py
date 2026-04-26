"""Tests for the AGENTS.md shared contract.

The AGENTS.md file is the single source of truth for the
companion <-> builder building contract. It must be injected into both the
companion and the builder via ``FileInjectionMiddleware`` with
``skip_on_crisis=False`` so both agents share the same understanding of
delegation, status taxonomy, and crash posture.

The contract MUST describe runtime reality, not aspirational future
features. The codex bot review on PR #81 caught the prior version
documenting fields and statuses that don't exist anywhere in the codebase
(``retry_attempt``, ``resume_from_task_id``, ``continuation_task_id``,
``partial`` / ``failed_retryable`` / ``failed_terminal`` statuses). The
``test_does_not_document_unimplemented_*`` guards below make sure we
cannot silently re-introduce that prompt/runtime split.
"""

from __future__ import annotations

from pathlib import Path

AGENTS_MD_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "skills"
    / "public"
    / "sophia"
    / "AGENTS.md"
)


# ---------------------------------------------------------------------------
# File shape
# ---------------------------------------------------------------------------


class TestAgentsMdFile:
    def test_file_exists(self):
        assert AGENTS_MD_PATH.is_file(), f"missing: {AGENTS_MD_PATH}"

    def test_file_is_not_empty(self):
        assert AGENTS_MD_PATH.stat().st_size > 0

    def test_contains_required_section_headings(self):
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        # The scope approved by the user is narrow; these are the only
        # sections we expect, and they MUST all be present.
        assert "## Roles" in content
        assert "## Data Contract" in content
        assert "## Communication Protocol" in content
        assert "## Builder Obligations" in content
        assert "## Crash" in content  # matches "Crash / Timeout Posture"

    def test_does_not_reference_harness_enforced_topics(self):
        """User directive: do NOT include memories, crisis, identity,
        artifacts (already harness-enforced). Light sanity guard against
        scope creep on this contract."""
        content = AGENTS_MD_PATH.read_text(encoding="utf-8").lower()
        forbidden_headings = [
            "## memories",
            "## crisis",
            "## identity",
            "## artifacts",
        ]
        for heading in forbidden_headings:
            assert heading not in content, (
                f"AGENTS.md should not include {heading!r} per approved scope"
            )

    def test_names_actual_runtime_status_values(self):
        """The status values that ``BuilderSessionMiddleware`` actually emits
        on ``state["builder_task"]["status"]``. Anything else would teach the
        model to branch on values that never arrive."""
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        for status in ("queued", "running", "completed", "failed"):
            assert status in content, (
                f"status {status!r} missing from AGENTS.md — the model has "
                "no documentation for a state the runtime actually emits."
            )

    def test_names_actual_switch_to_builder_input_fields(self):
        """The exact fields ``SwitchToBuilderInput`` accepts today."""
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        for field in ("task", "task_type", "user_id"):
            assert field in content, (
                f"field {field!r} missing from AGENTS.md — the model has no "
                "documentation for an arg the schema actually accepts."
            )

    def test_does_not_document_unimplemented_switch_to_builder_args(self):
        """Codex bot review (PR #81): AGENTS.md cannot document args that
        ``SwitchToBuilderInput`` does not accept. The model would call
        ``switch_to_builder(retry_attempt=1, ...)`` and the args would be
        silently dropped, treating retries as fresh builds."""
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        # Allow the explicit *denial* sentence (``There is no separate ...
        # taxonomy``) which teaches the model NOT to expect these. Forbid the
        # *prescriptive* uses (declaring them as args, telling the model to
        # branch on them).
        forbidden_in_prescriptive_form = [
            # Args that don't exist in SwitchToBuilderInput
            "retry_attempt:",
            "retry_attempt=",
            "resume_from_task_id:",
            "resume_from_task_id=",
            # Fields that don't exist in BuilderArtifactInput / builder_result
            "continuation_task_id",
            "completed_files",
            "summary_of_done",
        ]
        for symbol in forbidden_in_prescriptive_form:
            assert symbol not in content, (
                f"AGENTS.md mentions unimplemented symbol {symbol!r} in a "
                "prescriptive form. Either remove it or implement it in the "
                "same commit (SwitchToBuilderInput, BuilderArtifactInput, "
                "BuilderSessionMiddleware)."
            )

    def test_does_not_document_unimplemented_status_taxonomy(self):
        """Codex bot review (PR #81): ``BuilderArtifactInput`` has no
        ``status`` field on any branch (verified against
        ``feat/voice-transport-migration-telegram``,
        ``fix/builder-reliability-pr-h-async-switch-to-builder``,
        ``fix/sophia-builder-artifact-finalization``, and ``main``). The
        runtime only emits ``completed`` and ``failed`` on
        ``builder_task.status``. Documenting other values would tell the
        model to branch on unreachable states."""
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        # The denial sentence is allowed — it teaches the model these don't
        # exist. Forbid all other contexts: any status appearing in a `: `
        # explanation line, a status value, or a backtick literal that isn't
        # the denial.
        denial_marker = "There is no separate"
        for status in ("failed_retryable", "failed_terminal"):
            # Permitted: appearing only inside the denial sentence.
            occurrences = content.count(status)
            in_denial = content.count(f"`{status}`") if denial_marker in content else 0
            # The denial sentence references these in backticks once each.
            # Anything more would be prescriptive use.
            assert occurrences <= in_denial, (
                f"AGENTS.md uses {status!r} in a prescriptive form. The "
                f"runtime only emits 'completed' or 'failed' on "
                f"builder_task.status — the model would branch on a state it "
                "never sees."
            )
        # `partial` is a common English word, so check only that we don't
        # describe it as a builder_task.status value.
        assert "`partial`" not in content or denial_marker in content, (
            "AGENTS.md presents `partial` as a builder_task.status value, "
            "but the runtime never emits it. Drop the reference or implement "
            "the partial-build resume contract first."
        )


# ---------------------------------------------------------------------------
# File is wired into both agents
# ---------------------------------------------------------------------------


def _read_source(relative: str) -> str:
    backend_root = Path(__file__).resolve().parent.parent
    path = backend_root / relative
    return path.read_text(encoding="utf-8")


class TestAgentsMdInjection:
    def test_companion_agent_includes_agents_md(self):
        src = _read_source("packages/harness/deerflow/agents/sophia_agent/agent.py")
        # Loosely match the tuple form so a reformat does not break the test
        # but also guarantees skip_on_crisis=False.
        assert "AGENTS.md" in src
        assert "SKILLS_PATH / \"AGENTS.md\", False" in src

    def test_builder_agent_includes_agents_md(self):
        src = _read_source(
            "packages/harness/deerflow/agents/sophia_agent/builder_agent.py"
        )
        assert "AGENTS.md" in src
        assert "SKILLS_PATH / \"AGENTS.md\", False" in src
