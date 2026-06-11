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


def test_builder_obligations_require_verified_visuals_when_requested() -> None:
    contract = _sophia_prompt("builder_obligations.md")

    assert "When the user requests charts, diagrams, visuals" in contract
    assert "/mnt/user-data/outputs/visuals/" in contract
    assert "Remote chart URLs" in contract


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
    # Visuals must be wired into the plan BEFORE composing (prod 2026-06-10:
    # the "compose a no-image deck first" instruction shipped text-only decks).
    assert "BEFORE composing the deck" in card
    assert "The plan must reference" in card
    # Enrichment policy: generated imagery is reserved for visual/polished
    # deck mode or explicit generated-image requests, not every deck.
    assert "Visual/polished deck mode" in card
    assert "HARD CAP" in card
    assert "plain/text-only/minimal" in card
    assert "PPTX" in card
    assert "passes structural validation" in card
    assert "No Silent Format Swaps" in card
    assert "artifact_is_fallback=true" in card


def test_pdf_workflow_card_uses_pdf_report_skill_not_default_imagegen() -> None:
    card = _sophia_prompt("builder_workflows/pdf.md")

    assert "/mnt/skills/public/pdf-report/SKILL.md" in card
    assert "render_markdown_to_pdf" in card
    assert "Do not use image-generation for normal charts/diagrams" in card
    assert "ON BY DEFAULT" not in card
    assert "artifact_is_fallback=true" in card


def test_pdf_report_skill_is_source_first_and_renderer_backed() -> None:
    skill = Path(__file__).resolve().parents[2] / "skills/public/pdf-report/SKILL.md"
    text = skill.read_text()

    assert "Do not use `create_pdf_artifact` for normal reports" in text
    assert "render_markdown_to_pdf" in text
    assert "generate_visual_asset" in text
    assert "artifact_is_fallback=true" in text


def test_visuals_workflow_card_requires_design_skill_and_local_assets() -> None:
    card = _sophia_prompt("builder_workflows/visuals.md")

    assert "/mnt/skills/public/visual-design/SKILL.md" in card
    assert "generate_visual_asset" in card
    assert "/mnt/user-data/outputs/visuals/" in card
    assert "remote chart URLs" in card
