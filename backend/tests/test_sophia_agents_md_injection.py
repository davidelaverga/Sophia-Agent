"""Tests for PR G Commit 3: AGENTS.md shared contract.

The AGENTS.md file is the single source of truth for the
companion <-> builder building contract. It must be injected into both the
companion and the builder via ``FileInjectionMiddleware`` with
``skip_on_crisis=False`` so both agents share the same understanding of
delegation, status taxonomy, resume, and crash posture.
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

    def test_names_all_four_status_values(self):
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        for status in ("completed", "partial", "failed_retryable", "failed_terminal"):
            assert status in content, f"status {status!r} missing from AGENTS.md"

    def test_names_switch_to_builder_input_fields(self):
        content = AGENTS_MD_PATH.read_text(encoding="utf-8")
        for field in ("task", "task_type", "retry_attempt", "resume_from_task_id"):
            assert field in content, f"field {field!r} missing from AGENTS.md"


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
