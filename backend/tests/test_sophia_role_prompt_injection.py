"""Tests for Sophia's role-scoped build prompt files."""

from __future__ import annotations

from pathlib import Path

SOPHIA_PROMPT_ROOT = (
    Path(__file__).resolve().parent.parent.parent
    / "skills"
    / "public"
    / "sophia"
)


def _prompt(name: str) -> str:
    return (SOPHIA_PROMPT_ROOT / name).read_text(encoding="utf-8")


def _read_source(relative: str) -> str:
    backend_root = Path(__file__).resolve().parent.parent
    return (backend_root / relative).read_text(encoding="utf-8")


class TestSophiaRolePromptFiles:
    def test_required_role_files_exist(self) -> None:
        for name in [
            "AGENTS.md",
            "coordination_core.md",
            "companion_delegation.md",
            "builder_obligations.md",
            # Artifact Visual System Phase 5: the per-type composition cards
            # (pptx/pdf/html/visuals) were retired; composition guidance moved
            # into the always-injected directives. Research card is orthogonal.
            "visual_composition.md",
            "builder_workflows/research.md",
        ]:
            path = SOPHIA_PROMPT_ROOT / name
            assert path.is_file(), f"missing: {path}"
            assert path.stat().st_size > 0

    def test_core_contract_names_runtime_statuses_and_tool_fields(self) -> None:
        content = _prompt("coordination_core.md")

        for status in ("running", "success", "error", "cancelled"):
            assert status in content
        for field in ("description", "task_type", "user_id"):
            assert field in content

    def test_role_files_do_not_reintroduce_unimplemented_contract_terms(self) -> None:
        combined = "\n".join(
            [
                _prompt("coordination_core.md"),
                _prompt("companion_delegation.md"),
                _prompt("builder_obligations.md"),
            ]
        )

        forbidden = [
            "retry_attempt:",
            "retry_attempt=",
            "resume_from_task_id:",
            "resume_from_task_id=",
            "continuation_task_id",
            "completed_files",
            "summary_of_done",
            "failed_retryable",
            "failed_terminal",
        ]
        for symbol in forbidden:
            assert symbol not in combined


class TestSophiaRolePromptInjection:
    def test_companion_agent_injects_companion_role_files(self) -> None:
        src = _read_source("packages/harness/deerflow/agents/sophia_agent/agent.py")

        assert "coordination_core.md" in src
        assert "companion_delegation.md" in src
        assert "builder_obligations.md" not in src
        assert 'SKILLS_PATH / "AGENTS.md", False' not in src

    def test_builder_agent_injects_builder_role_files(self) -> None:
        src = _read_source(
            "packages/harness/deerflow/agents/sophia_agent/builder_middlewares.py"
        )

        assert "coordination_core.md" in src
        assert "builder_obligations.md" in src
        assert "companion_delegation.md" not in src
        assert 'SKILLS_PATH / "AGENTS.md", False' not in src

        agent_src = _read_source(
            "packages/harness/deerflow/agents/sophia_agent/builder_agent.py"
        )
        assert "build_builder_middleware_chain" in agent_src
