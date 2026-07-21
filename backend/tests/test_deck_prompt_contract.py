from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SURFACES = [
    PROJECT_ROOT / "skills" / "public" / "ppt-generation" / "SKILL.md",
    PROJECT_ROOT / "skills" / "public" / "image-generation" / "SKILL.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "visual_composition.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "builder_obligations.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "coordination_core.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "deck_craft.md",
    PROJECT_ROOT
    / "backend"
    / "packages"
    / "harness"
    / "deerflow"
    / "agents"
    / "sophia_agent"
    / "middlewares"
    / "builder_task.py",
]


def _surface_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in SURFACES)


def test_fresh_deck_prompt_surfaces_route_to_prepare_deck_build() -> None:
    text = _surface_text()
    lower_text = text.lower()

    assert "prepare_deck_build" in text
    assert "deck_craft" in lower_text
    assert "creative_plan" in text
    assert "deck_stylesheet" in text
    assert "html_body" in text
    assert "html_source" not in text
    assert "DeckBuildService" in text
    assert "native PowerPoint" in text
    assert "mechanical gates" in lower_text
    assert "sanitization" in lower_text or "sanitizes" in lower_text
    assert "planned assets" in lower_text or "planned generated assets" in lower_text
    assert "visual_policy" in text
    assert "layout_kind" in text
    assert "<= 280" in text
    assert "retryable=true" in text
    assert "artifact_path=null" in text
    assert "screenshot-backed pptx is a failed build" in lower_text
    assert "picture is never itself the whole slide" in lower_text or "not itself a complete slide" in lower_text


def test_ppt_skill_requires_authoritative_prepare_route_and_design_adapters() -> None:
    text = (PROJECT_ROOT / "skills" / "public" / "ppt-generation" / "SKILL.md").read_text(encoding="utf-8")

    assert "authoritative fresh-deck route" in text
    assert "hands-on-deck/designing-slides" in text
    assert "deck-impeccable" in text
    assert "deck-hallmark" in text
    assert "Do not call `prepare_pptx_image_manifest`" in text


def test_compact_v2_body_limit_is_consistent_across_authoritative_prompt_surfaces() -> None:
    ppt_skill = (PROJECT_ROOT / "skills" / "public" / "ppt-generation" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    deck_craft = (PROJECT_ROOT / "skills" / "public" / "sophia" / "deck_craft.md").read_text(
        encoding="utf-8"
    )

    assert "target each `html_body` under 4 KiB" in ppt_skill
    assert "combined `html_body` bytes must stay within 4 KiB times the slide count" in ppt_skill
    assert "slides may borrow unused body budget" in ppt_skill
    assert "each slide capped at the hard 6 KiB ceiling" in ppt_skill
    assert "target each `html_body` <= 4 KiB" in deck_craft
    assert "combined `html_body` bytes <= 4 KiB times slide count" in deck_craft
    assert "slides may borrow unused body budget" in deck_craft
    assert "each slide capped at 6 KiB" in deck_craft
    assert "one slide may borrow" not in ppt_skill
    assert "one slide may borrow" not in deck_craft
    assert "3 KiB" not in ppt_skill
    assert "3 KiB" not in deck_craft


def test_authoritative_prompt_surfaces_use_parent_local_nested_coordinates() -> None:
    ppt_skill = (PROJECT_ROOT / "skills" / "public" / "ppt-generation" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    deck_craft = (PROJECT_ROOT / "skills" / "public" / "sophia" / "deck_craft.md").read_text(
        encoding="utf-8"
    )

    for text in (ppt_skill, deck_craft):
        assert "parent-local `left`/`top`" in text
        assert "never repeat the parent's slide-global offset" in text
        assert "Keep non-bleed geometry inside" in text


def test_injected_deck_contract_uses_renderer_safe_pptx_fonts() -> None:
    text = (PROJECT_ROOT / "skills" / "public" / "sophia" / "deck_craft.md").read_text(encoding="utf-8")

    assert '"typography": {"display": "Cambria", "body": "Calibri"}' in text
    assert "PPTX typography is Office-safe only" in text
    assert "Never use Aptos, Georgia" in text
    assert '"display": "Georgia"' not in text
    assert "explicit width and height" in text


def test_fresh_deck_prompt_surfaces_do_not_teach_old_workflow() -> None:
    text = _surface_text().lower()

    forbidden = [
        "call prepare_pptx_image_manifest(prompt_files",
        "then call prepare_pptx_image_manifest",
        "run generate.py --manifest",
        "run the returned manifest_path",
        "one self-contained 1920x1080 html file per slide",
        "author one self-contained html file per slide",
        "call build_deck_from_slides(",
        "then call build_deck_from_slides",
        "screenshot fallback",
        "screenshot-backed pptx fallback",
        "write one prompt json file per slide",
        "one generated image per slide",
        "one generated visual per slide",
        "visual_prompt: required for normal decks",
        "generate every slide visual",
        "slide intent only",
        "complete slide intent list",
        "deck ir repair",
        "deck_build_templates_v1",
        "deck_ir_html_raster",
    ]
    for phrase in forbidden:
        assert phrase not in text
