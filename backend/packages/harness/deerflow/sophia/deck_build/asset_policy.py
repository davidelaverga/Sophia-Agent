from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any

from deerflow.sophia.deck_build.models import DeckAssetPlan, DeckBuild, DeckDesignPlan, DeckSlideSpec

_TEXT_NATIVE_ROLES = {"architecture", "process", "comparison", "timeline", "evidence", "closing"}
_IMAGE_HELPFUL_RE = re.compile(r"\b(photo|photograph|portrait|texture|background|hero|material|scene|metaphor|illustration)\b", re.I)
_FULL_BLEED_ALLOWED_ROLES = {"cover", "section"}


def normalize_visual_policy(value: str | None) -> str:
    clean = str(value or "auto").strip().lower()
    if clean == "required":
        return "auto_with_images_allowed"
    if clean in {"auto", "text_only", "auto_with_images_allowed"}:
        return clean
    return clean


def resolve_asset_policies(
    deck: DeckBuild,
    *,
    design_plan: DeckDesignPlan,
    request_context: str,
) -> None:
    generated = native = hybrid = text_only = 0
    for slide in deck.slides:
        slide.asset_plan = resolve_slide_asset_plan(
            slide,
            deck=deck,
            design_plan=design_plan,
            request_context=request_context,
        )
        slide.visual_required = slide.asset_plan.image_gen_required
        if slide.asset_plan.visual_mode == "hybrid":
            generated += 1
            hybrid += 1
        elif slide.asset_plan.visual_mode == "generated_asset":
            generated += 1
        elif slide.asset_plan.visual_mode == "text_only":
            text_only += 1
        else:
            native += 1
    deck.generated_asset_count = generated
    deck.native_html_slide_count = native
    deck.hybrid_slide_count = hybrid
    deck.text_only_slide_count = text_only
    deck.expected_visual_count = generated


def resolve_slide_asset_plan(
    slide: DeckSlideSpec,
    *,
    deck: DeckBuild,
    design_plan: DeckDesignPlan,
    request_context: str,
) -> DeckAssetPlan:
    if deck.visual_policy == "text_only":
        return DeckAssetPlan(
            visual_mode="text_only",
            image_gen_required=False,
            reason="explicit_text_only_request",
        )

    prompt = (slide.visual_prompt or "").strip() or None
    role = str(slide.role or "").lower()
    layout = str(slide.layout_kind or "").lower()
    prompt_suggests_image = bool(prompt and _IMAGE_HELPFUL_RE.search(prompt))
    requested_visual_texture = bool(_IMAGE_HELPFUL_RE.search(request_context))
    cover_like = role == "cover" or layout == "cover_hero"

    if cover_like and (prompt or requested_visual_texture):
        return DeckAssetPlan(
            visual_mode="hybrid",
            image_gen_required=True,
            asset_role="hero_background",
            fit="full_bleed",
            aspect_ratio="16:9",
            allow_full_bleed=True,
            prompt=prompt or _fallback_asset_prompt(slide, design_plan),
            reason="cover_hero_can_benefit_from_generated_background_asset",
        )

    if role not in _TEXT_NATIVE_ROLES and prompt_suggests_image:
        fit = "cover" if role in _FULL_BLEED_ALLOWED_ROLES else "contain"
        return DeckAssetPlan(
            visual_mode="hybrid",
            image_gen_required=True,
            asset_role="inset_illustration",
            fit=fit,
            aspect_ratio="16:9",
            allow_full_bleed=fit == "cover",
            prompt=prompt,
            reason="non-technical_slide_requested_asset_image",
        )

    return DeckAssetPlan(
        visual_mode="native_html",
        image_gen_required=False,
        reason="native_html_is_best_source_of_truth_for_this_slide",
    )


def generated_asset_slides(deck: DeckBuild) -> list[DeckSlideSpec]:
    return [
        slide
        for slide in deck.slides
        if slide.asset_plan is not None and slide.asset_plan.image_gen_required
    ]


def write_asset_policy(deck: DeckBuild, host_path: Path) -> None:
    payload = {
        "build_id": deck.build_id,
        "visual_policy": deck.visual_policy,
        "source": "creative_plan" if deck.creative_plan is not None else "asset_policy",
        "creative_plan_path": deck.creative_plan_path,
        "expected_visual_count": deck.expected_visual_count,
        "generated_asset_count": deck.generated_asset_count,
        "native_html_slide_count": deck.native_html_slide_count,
        "hybrid_slide_count": deck.hybrid_slide_count,
        "text_only_slide_count": deck.text_only_slide_count,
        "slides": [
            {
                "selector": slide.selector,
                "role": slide.role,
                "layout_kind": slide.layout_kind,
                "asset_plan": asdict(slide.asset_plan) if slide.asset_plan else None,
                "composition_plan": asdict(slide.composition_plan)
                if hasattr(slide.composition_plan, "__dataclass_fields__")
                else slide.composition_plan,
                "planned_image_asset_id": slide.gate_results.get("planned_image_asset_id"),
            }
            for slide in deck.slides
        ],
    }
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _fallback_asset_prompt(slide: DeckSlideSpec, design_plan: DeckDesignPlan) -> str:
    return (
        f"Abstract asset background for {design_plan.subject}: {slide.title}. "
        "No readable text, no title, no labels, no complete slide layout."
    )
