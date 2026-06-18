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


def test_retired_workflow_cards_are_deleted() -> None:
    # Artifact Visual System Phase 5b: the per-type composition cards are
    # retired — their guidance moved into the always-injected directives +
    # the per-type skills. Only the orthogonal research card survives.
    repo_root = Path(__file__).resolve().parents[2]
    cards_dir = repo_root / "skills/public/sophia/builder_workflows"
    for retired in ("pptx.md", "pdf.md", "html.md", "visuals.md"):
        assert not (cards_dir / retired).exists(), f"{retired} should be deleted"
    assert (cards_dir / "research.md").exists()


def test_visual_composition_directives_carry_the_toolkit() -> None:
    # The retired cards' composition guidance now lives in the always-injected
    # visual director.
    directives = _sophia_prompt("visual_composition.md")

    assert "generate_excalidraw_diagram" in directives
    assert "graphviz" in directives
    assert "generate_visual_asset" in directives
    assert "gpt-image-2" in directives
    assert "--slide-visual" in directives
    assert "ppt-generation" in directives
    assert "pdf-report" in directives
    assert "hallmark" in directives
    assert "read the matching skill" in directives
    assert "monotony" in directives


def test_ppt_generation_skill_carries_deck_design_system() -> None:
    skill = Path(__file__).resolve().parents[2] / "skills/public/ppt-generation/SKILL.md"
    text = skill.read_text()

    assert "How slides are built (image-forward)" in text
    assert "gpt-image-2" in text
    assert "--slide-visual" in text
    assert "python /mnt/skills/public/image-generation/scripts/generate.py --slide-visual" in text
    assert "Run scripts/generate.py with `--slide-visual`" not in text
    assert "THE TEXT READS:" in text
    assert "slide_qc.py" in text
    assert "statement" in text
    assert "image_path" in text
    assert "visual_path" in text
    assert "generate_visual_asset" in text


def test_pdf_report_skill_is_source_first_and_renderer_backed() -> None:
    skill = Path(__file__).resolve().parents[2] / "skills/public/pdf-report/SKILL.md"
    text = skill.read_text()

    assert "Source-first" in text
    assert "create_pdf_artifact" in text  # the skill forbids dropping to it
    assert "deep-research" in text
    assert "academic-paper-review" in text
    assert "systematic-literature-review" in text
    assert "chart-visualization" in text
    assert "render_markdown_to_pdf" in text
    assert "generate_excalidraw_diagram" in text
    assert "Embed PNG, not SVG" in text  # xelatex embeds PNG, not SVG


def test_brand_tokens_resolve_the_georgia_conflict() -> None:
    tokens = _sophia_prompt("brand/tokens.md")
    assert "Never Aptos or Georgia" in tokens
    assert "Cambria" in tokens
    assert "graphviz" in tokens  # the diagram palette the toolkit needs
