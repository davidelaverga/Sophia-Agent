from __future__ import annotations

from deerflow.sophia.deck_build.models import DeckAssetPlan, DeckCompositionSpec, DeckDesignPlan, DeckSlideSpec


def resolve_compositions(slides: list[DeckSlideSpec], design_plan: DeckDesignPlan) -> None:
    for slide in slides:
        asset_plan = slide.asset_plan or DeckAssetPlan("native_html", False)
        slide.composition = resolve_slide_composition(slide, design_plan=design_plan, asset_plan=asset_plan)


def resolve_slide_composition(
    slide: DeckSlideSpec,
    *,
    design_plan: DeckDesignPlan,
    asset_plan: DeckAssetPlan,
) -> DeckCompositionSpec:
    family = _layout_family(slide, asset_plan)
    grid = design_plan.grid
    wide_visual = {
        "x": grid.margin_x_px,
        "y": 250,
        "w": grid.slide_width_px - (grid.margin_x_px * 2),
        "h": 600,
        "fit": asset_plan.fit if asset_plan.image_gen_required else "native",
    }
    split_visual = {
        "x": 1040,
        "y": 230,
        "w": 720,
        "h": 600,
        "fit": asset_plan.fit if asset_plan.image_gen_required else "native",
    }
    title = {"x": grid.margin_x_px, "y": grid.title_y_px, "w": 1320, "h": 150}
    narrative = {"x": grid.margin_x_px, "y": 820, "w": 1320, "h": 150}

    if family == "cover_hero":
        return DeckCompositionSpec(
            layout_family=family,
            title_slot={"x": 120, "y": 620, "w": 1320, "h": 190},
            narrative_slot={"x": 126, "y": 820, "w": 1160, "h": 110},
            visual_slot={"x": 0, "y": 0, "w": grid.slide_width_px, "h": grid.slide_height_px, "fit": "full_bleed"},
            support_slots=[{"kind": "rule", "x": 126, "y": 588, "w": 180, "h": 8}],
            max_words=34,
        )
    if family == "comparison_matrix":
        return DeckCompositionSpec(
            layout_family=family,
            title_slot=title,
            narrative_slot={"x": 120, "y": 850, "w": 1400, "h": 100},
            visual_slot={"x": 120, "y": 260, "w": 1680, "h": 510, "fit": "native"},
            support_slots=[{"kind": "matrix", "columns": 2}],
            max_words=64,
        )
    if family == "process_flow":
        return DeckCompositionSpec(
            layout_family=family,
            title_slot=title,
            narrative_slot=narrative,
            visual_slot=wide_visual,
            support_slots=[{"kind": "flow", "steps": 4}],
            max_words=56,
        )
    if family == "evidence_callout":
        return DeckCompositionSpec(
            layout_family=family,
            title_slot=title,
            narrative_slot={"x": 1060, "y": 300, "w": 620, "h": 330},
            visual_slot={"x": 120, "y": 270, "w": 760, "h": 500, "fit": "native"},
            support_slots=[{"kind": "callout", "x": 1040, "y": 700, "w": 540, "h": 96}],
            max_words=54,
        )
    if family == "closing_synthesis":
        return DeckCompositionSpec(
            layout_family=family,
            title_slot={"x": 180, "y": 210, "w": 1280, "h": 190},
            narrative_slot={"x": 220, "y": 540, "w": 1160, "h": 160},
            visual_slot={"x": 1160, "y": 170, "w": 560, "h": 620, "fit": "native"},
            support_slots=[{"kind": "synthesis_mark"}],
            max_words=44,
        )
    if family == "split_asset":
        return DeckCompositionSpec(
            layout_family=family,
            title_slot={"x": 120, "y": 110, "w": 820, "h": 180},
            narrative_slot={"x": 120, "y": 390, "w": 680, "h": 260},
            visual_slot=split_visual,
            support_slots=[{"kind": "label", "text": "asset"}],
            max_words=48,
        )
    return DeckCompositionSpec(
        layout_family=family,
        title_slot=title,
        narrative_slot=narrative,
        visual_slot=wide_visual,
        support_slots=[{"kind": "native_diagram"}],
        max_words=56,
    )


def _layout_family(slide: DeckSlideSpec, asset_plan: DeckAssetPlan) -> str:
    role = str(slide.role or "").lower()
    layout = str(slide.layout_kind or "").lower()
    if role == "cover" or layout == "cover_hero":
        return "cover_hero" if asset_plan.image_gen_required else "cover_statement"
    if "comparison" in role or "comparison" in layout:
        return "comparison_matrix"
    if role in {"process", "timeline"} or "timeline" in layout:
        return "process_flow"
    if role == "evidence":
        return "evidence_callout"
    if role == "closing" or "closing" in layout:
        return "closing_synthesis"
    if asset_plan.image_gen_required:
        return "split_asset"
    if role == "architecture":
        return "system_diagram"
    return "claim_native"
