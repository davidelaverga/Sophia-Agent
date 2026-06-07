from __future__ import annotations

from pathlib import Path


def _sophia_prompt(name: str) -> str:
    repo_root = Path(__file__).resolve().parents[2]
    return (repo_root / "skills/public/sophia" / name).read_text()


def test_builder_obligations_declares_universal_builder_web_research() -> None:
    contract = _sophia_prompt("builder_obligations.md")

    assert "Web research is available for every builder task type" in contract
    assert "including `frontend`" in contract
    assert "For fresh builds, before the first substantive write/edit/emit step" in contract
    assert "`builder_web_search` or `builder_web_fetch`" in contract
    assert "Pure local edits do not require web research" in contract


def test_builder_obligations_update_guidance_does_not_ban_research() -> None:
    contract = _sophia_prompt("builder_obligations.md")

    assert "DO NOT re-run web_search" not in contract
    assert "search or fetch that new material before editing" in contract


def test_agents_md_is_deprecated_pointer_not_active_contract() -> None:
    pointer = _sophia_prompt("AGENTS.md")

    assert "Deprecated Sophia Build Contract Pointer" in pointer
    assert "Do not inject this file" in pointer


def test_role_scoped_prompt_files_are_separated() -> None:
    companion = _sophia_prompt("companion_delegation.md")
    builder = _sophia_prompt("builder_obligations.md")

    assert "start_builder_task(description, task_type)" in companion
    assert "Finish with `emit_builder_artifact`" not in companion
    assert "Finish with `emit_builder_artifact`" in builder
    assert "Acknowledgement Matrix" not in builder


def test_pptx_workflow_card_requires_deerflow_native_sequence() -> None:
    card = _sophia_prompt("builder_workflows/pptx.md")

    assert "image-generation/scripts/generate.py" in card
    assert "ppt-generation/scripts/generate.py" in card
    assert "Compose a valid no-image deck first" in card
    assert "only when the" in card
    assert "user explicitly requests generated images" in card
    assert "no-image" in card
    assert "PPTX" in card
    assert "passes structural validation" in card
