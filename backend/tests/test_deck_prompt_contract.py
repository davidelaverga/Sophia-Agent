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


def test_authoritative_prompt_surfaces_require_repair_addressable_anchors() -> None:
    ppt_skill = (PROJECT_ROOT / "skills" / "public" / "ppt-generation" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    deck_craft = (PROJECT_ROOT / "skills" / "public" / "sophia" / "deck_craft.md").read_text(
        encoding="utf-8"
    )

    for text in (ppt_skill, deck_craft):
        assert "`repair_anchor_ids`" in text
        assert "exactly two distinct short HTML ids" in text
        assert "both independent repair-addressable layout anchors" in text or "both named independent repair-addressable layout anchors" in text
        assert "direct children of the service-owned `main`" in text
        assert "HTML `id` unique within its slide" in text
        assert "same two short anchor IDs may be reused in separate slide fragments" in text
        assert "shared `#id` rules scale" in text
        assert "`[a-z][a-z0-9_-]{0,31}`" in text
        assert "lowercase ASCII letter followed by at most 31 lowercase ASCII letters" in text
        assert "maximum of 32 characters" in text
        assert "`data-deck-id` must be unique within its slide" in text
        assert "`data-deck-role` must be nonempty" in text
        assert "`data-deck-required=\"true\"`" in text
        assert "`position:absolute`" in text
        assert "`box-sizing:border-box`" in text
        assert "`margin:0`" in text
        assert "48x24px" in text
        assert "anchor geometry out of `slide_css` and inline styles" in text
        assert "No other CSS selector matching an anchor may declare a nonzero margin" in text
        assert "logical or vendor margin property" in text
        assert "reset margins on anchor descendants with separate descendant selectors" in text
        assert "Flex and grid" in text
        assert '`repair_anchor_ids=["hero","proof"]`' in text
        assert "omit `slide_css` or pass an empty string" in text.lower()
        assert "full 1 kib channel" in text.lower()


def test_fresh_compact_v2_prompt_surfaces_reserve_slide_css_for_repair() -> None:
    paths = (
        PROJECT_ROOT
        / "backend"
        / "packages"
        / "harness"
        / "deerflow"
        / "agents"
        / "sophia_agent"
        / "middlewares"
        / "builder_task.py",
        PROJECT_ROOT / "skills" / "public" / "sophia" / "builder_obligations.md",
        PROJECT_ROOT
        / "backend"
        / "packages"
        / "harness"
        / "deerflow"
        / "sophia"
        / "tools"
        / "prepare_deck_build.py",
    )

    for path in paths:
        text = " ".join(path.read_text(encoding="utf-8").lower().split())
        assert "omit slide_css or pass an empty string" in text or "omit `slide_css` or pass an empty string" in text
        assert "authenticated repair overlay retains its full" in text
        assert "optional slide_css" not in text
        assert "use slide_css only for a small" not in text


def test_outer_fresh_deck_surfaces_require_repair_anchor_ids() -> None:
    paths = (
        PROJECT_ROOT / "skills" / "public" / "sophia" / "builder_obligations.md",
        PROJECT_ROOT / "skills" / "public" / "sophia" / "coordination_core.md",
        PROJECT_ROOT / "skills" / "public" / "sophia" / "visual_composition.md",
        PROJECT_ROOT / "skills" / "public" / "visual-design" / "SKILL.md",
    )

    for path in paths:
        assert "repair_anchor_ids" in path.read_text(encoding="utf-8")


def test_outer_deck_prompt_surfaces_require_slide_local_anchor_semantics() -> None:
    paths = (
        PROJECT_ROOT
        / "backend"
        / "packages"
        / "harness"
        / "deerflow"
        / "agents"
        / "sophia_agent"
        / "middlewares"
        / "builder_task.py",
        PROJECT_ROOT / "skills" / "public" / "sophia" / "builder_obligations.md",
    )

    for path in paths:
        text = " ".join(path.read_text(encoding="utf-8").lower().split())
        assert "data-deck-id" in text
        assert "unique within its slide" in text
        assert "data-deck-role must be nonempty" in text or "`data-deck-role` must be nonempty" in text
        assert "data-deck-required" in text
        assert "true" in text


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
