from __future__ import annotations

from dataclasses import asdict
from typing import Any

from deerflow.sophia.deck_build.models import DeckBuild, DeckDesignPlan, DeckSlideSpec


def deck_asset_prompt_payload(slide: DeckSlideSpec, deck: DeckBuild) -> dict[str, Any]:
    plan = deck.design_plan if isinstance(deck.design_plan, DeckDesignPlan) else None
    asset_plan = slide.asset_plan
    style = {
        "register": deck.register,
        "style_lane": plan.style_lane if plan else "calm_technical",
        "visual_style": "asset_only_supporting_visual",
        "aesthetic": plan.signature if plan else "restrained professional technical",
        "palette": [asdict(token) for token in plan.palette] if plan else [],
    }
    prompt = (asset_plan.prompt if asset_plan else None) or slide.visual_prompt or slide.title
    fit = (asset_plan.fit if asset_plan else "contain") or "contain"
    return {
        "prompt": prompt,
        "style": style,
        "composition": {
            "asset_role": asset_plan.asset_role if asset_plan else "inset_illustration",
            "fit": fit,
            "slide_context": {
                "title": slide.title,
                "role": slide.role,
                "layout_kind": slide.layout_kind,
                "claim": slide.claim,
            },
        },
        "constraints": [
            "Generate only a supporting asset, not a complete slide.",
            "No slide title, no narrative paragraph, no footer, no page chrome.",
            "No large readable text, labels, axes, formulas, or UI chrome inside the image.",
            "Keep the asset compatible with native PowerPoint text and shapes placed by DeckBuildService.",
        ],
        "technical": {
            "aspect_ratio": (asset_plan.aspect_ratio if asset_plan else None) or "16:9",
            "quality": "high",
            "deck_asset": True,
            "slide_visual": False,
            "slide_index": slide.index,
            "object_fit": fit,
        },
    }
