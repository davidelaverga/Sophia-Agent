from __future__ import annotations

from collections import Counter

from deerflow.sophia.deck_build.creative_plan import CreativePlanValidationError
from deerflow.sophia.deck_build.models import DeckAssetPlan, DeckBuild, DeckCreativePlan

_FULL_BLEED_INTEGRATIONS = {"full_bleed_background"}
_COVER_ROLES = {"hero_background", "section_texture"}


def apply_creative_asset_plan(deck: DeckBuild, plan: DeckCreativePlan) -> None:
    assets_by_slide: dict[str, list] = {}
    for asset in plan.image_assets:
        assets_by_slide.setdefault(asset.slide_selector, []).append(asset)
    duplicate_slides = [selector for selector, assets in assets_by_slide.items() if len(assets) > 1]
    if duplicate_slides:
        raise CreativePlanValidationError(
            "deck_image_asset_plan_invalid",
            "D2.1 currently supports at most one generated image asset per slide; "
            f"multiple assets were declared for {', '.join(duplicate_slides[:5])}.",
        )
    compositions = {composition.selector: composition for composition in plan.slide_compositions}
    generated = native = hybrid = text_only = 0
    for slide in deck.slides:
        slide.composition_plan = compositions.get(slide.selector)
        asset = assets_by_slide.get(slide.selector, [None])[0]
        if deck.visual_policy == "text_only":
            slide.asset_plan = DeckAssetPlan(
                visual_mode="text_only",
                image_gen_required=False,
                reason="explicit_text_only_request",
            )
            slide.visual_required = False
            slide.visual_status = "not_required"
            text_only += 1
            continue
        if asset is None:
            slide.asset_plan = DeckAssetPlan(
                visual_mode="native_html",
                image_gen_required=False,
                reason="creative_plan_selected_native_html",
            )
            slide.visual_required = False
            slide.visual_status = "not_required"
            native += 1
            continue
        fit = _fit_for_asset(asset.integration, asset.role)
        slide.asset_plan = DeckAssetPlan(
            visual_mode="hybrid",
            image_gen_required=True,
            asset_role=asset.role,
            fit=fit,
            aspect_ratio=asset.aspect_ratio or "16:9",
            allow_full_bleed=fit == "full_bleed",
            prompt=asset.prompt,
            reason=asset.reason,
        )
        slide.visual_prompt = asset.prompt
        slide.visual_required = True
        slide.visual_status = "pending"
        slide.gate_results["planned_image_asset_id"] = asset.asset_id
        slide.gate_results["planned_image_integration"] = asset.integration
        generated += 1
        hybrid += 1
    deck.generated_asset_count = generated
    deck.native_html_slide_count = native
    deck.hybrid_slide_count = hybrid
    deck.text_only_slide_count = text_only
    deck.expected_visual_count = generated
    deck.style_warnings = _creative_style_warnings(deck, plan)


def planned_asset_ref_basenames(deck: DeckBuild) -> set[str]:
    return {
        f"slide-{slide.index:02d}.png"
        for slide in deck.slides
        if slide.asset_plan is not None and slide.asset_plan.image_gen_required
    }


def normalize_planned_asset_references(deck: DeckBuild, plan: DeckCreativePlan) -> int:
    """Translate declared model-facing asset IDs to compiler-owned slide paths."""

    assets_by_slide = {asset.slide_selector: asset for asset in plan.image_assets}
    replacement_count = 0
    for slide in deck.slides:
        asset = assets_by_slide.get(slide.selector)
        if asset is None:
            continue
        canonical_ref = f"../assets/slide-{slide.index:02d}.png"
        slide_replacements = 0
        for field_name in ("html_body", "slide_css", "html_source"):
            value = getattr(slide, field_name)
            if not isinstance(value, str) or asset.asset_id not in value:
                continue
            count = value.count(asset.asset_id)
            setattr(slide, field_name, value.replace(asset.asset_id, canonical_ref))
            replacement_count += count
            slide_replacements += count
        if slide_replacements:
            slide.gate_results["planned_asset_reference_normalized"] = True
            slide.gate_results["planned_asset_reference_replacement_count"] = slide_replacements
    return replacement_count


def _fit_for_asset(integration: str, role: str) -> str:
    if integration in _FULL_BLEED_INTEGRATIONS or role in _COVER_ROLES:
        return "full_bleed"
    if integration in {"masked_panel", "inset_illustration", "subject_photo"}:
        return "contain"
    if integration == "texture_layer":
        return "cover"
    return "contain"


def _creative_style_warnings(deck: DeckBuild, plan: DeckCreativePlan) -> list[str]:
    warnings: list[str] = []
    layout_names = [
        str(getattr(slide.composition_plan, "layout_name", "") or "")
        for slide in deck.slides
        if slide.composition_plan is not None
    ]
    repeated = [layout for layout, count in Counter(layout_names).items() if layout and count >= max(3, len(deck.slides) - 1)]
    if repeated:
        warnings.append("creative_plan_reuses_layout_structure")
    commitments = " ".join(plan.anti_slop_commitments).lower()
    if "structural" not in commitments and len(deck.slides) >= 4:
        warnings.append("creative_plan_missing_structural_variety_commitment")
    return warnings
