from __future__ import annotations

from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _sophia_prompt(name: str) -> str:
    return (_repo_root() / "skills/public/sophia" / name).read_text(encoding="utf-8")


def _skill(name: str) -> str:
    return (_repo_root() / "skills/public" / name / "SKILL.md").read_text(encoding="utf-8")


def test_retired_sophia_prompt_files_are_deleted() -> None:
    sophia_dir = _repo_root() / "skills/public/sophia"

    assert not (sophia_dir / "anti_slop.md").exists()
    assert not (sophia_dir / "artifact_instructions.md").exists()


def test_builder_obligations_are_trimmed_to_artifact_contract() -> None:
    contract = _sophia_prompt("builder_obligations.md")

    assert "Finish with `emit_builder_artifact`" in contract
    assert "requested primary artifact" in contract
    assert "Generate one full-slide image per slide" in contract
    assert "render_markdown_to_pdf" in contract
    assert "Markdown source and generated assets are supporting files" in contract
    assert "generate_visual_asset" not in contract
    assert "generate_report_chart" not in contract


def test_visual_composition_routes_pptx_and_pdf_to_separate_pipelines() -> None:
    directives = _sophia_prompt("visual_composition.md")

    assert "Presentations (`.pptx`) are pure image-forward decks" in directives
    assert "PDF reports are deterministic reports" in directives
    assert "There is no alternate plain deck mode" in directives
    # Custom excalidraw tool removed; PDFs route all charts AND structural
    # diagrams through the upstream generate_chart engine.
    assert "generate_excalidraw_diagram" not in directives
    assert "generate_chart" in directives
    assert "generate_visual_asset" not in directives
    assert "generate_report_chart" not in directives


def test_ppt_generation_skill_is_pure_image_forward() -> None:
    text = _skill("ppt-generation")

    assert "Every slide is a single 16:9 image" in text
    assert "top 14% title band" in text
    assert "bottom 16% narrative band" in text
    assert "image_path" in text
    assert "Zero compiler-side text boxes" in text
    assert "generate_visual_asset" not in text
    assert "generate_report_chart" not in text
    assert "text-only" not in text
    assert "title_strategy" not in text


def test_pdf_report_skill_uses_generate_chart_and_bounded_conceptual_images() -> None:
    text = _skill("pdf-report")

    assert "render_markdown_to_pdf" in text
    # Charts AND structural diagrams go through the upstream chart engine; the
    # custom excalidraw tool is gone.
    assert "generate_excalidraw_diagram" not in text
    assert "generate_chart" in text
    assert "chart-visualization renderer" in text
    # No full-slide deck images in a report, but bounded conceptual images are allowed.
    assert "Do not use full-slide deck images" in text
    assert "conceptual" in text.lower()
    assert "generate_report_chart" not in text
    assert "generate_visual_asset" not in text


def test_image_generation_skill_allows_bounded_pdf_conceptual_images() -> None:
    text = _skill("image-generation")

    assert "--slide-visual" in text
    # Image-gen is now a bounded PDF path for conceptual/editorial figures only;
    # data + structure still go through generate_chart.
    assert "3 conceptual/editorial" in text
    assert "generate_chart" in text
    assert "generate_visual_asset" not in text
    assert "anti_slop.md" not in text


def test_forbidden_double_path_prompt_tokens_are_absent() -> None:
    files = [
        _repo_root() / "skills/public/ppt-generation/SKILL.md",
        _repo_root() / "skills/public/pdf-report/SKILL.md",
        _repo_root() / "skills/public/image-generation/SKILL.md",
        _repo_root() / "skills/public/chart-visualization/SKILL.md",
        _repo_root() / "skills/public/sophia/visual_composition.md",
        _repo_root() / "skills/public/sophia/builder_obligations.md",
        _repo_root() / "skills/public/sophia/companion_delegation.md",
    ]
    forbidden = (
        "generate_visual_asset",
        "generate_report_chart",
        "title_strategy",
        "native",
        "fallback",
        "text-only",
        "opt-out",
        "deterministic chart",
        "section-divider",
    )

    offenders = [
        (path.name, token)
        for path in files
        for token in forbidden
        if token in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


def test_brand_tokens_resolve_the_georgia_conflict() -> None:
    tokens = _sophia_prompt("brand/tokens.md")
    assert "Never Aptos or Georgia" in tokens
    assert "Cambria" in tokens
    assert "graphviz" in tokens
