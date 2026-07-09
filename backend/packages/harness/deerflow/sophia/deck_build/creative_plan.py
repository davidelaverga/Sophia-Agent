from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any

from deerflow.sophia.deck_build.design_plan import resolve_deck_design_plan
from deerflow.sophia.deck_build.models import (
    DeckBuild,
    DeckColorToken,
    DeckCreativePlan,
    DeckDesignPlan,
    DeckGridPlan,
    DeckImageAssetPlan,
    DeckSlideCompositionPlan,
    DeckTypographyPlan,
)

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$")
_ALLOWED_IMAGE_STRATEGIES = {"hero_only", "sparse_signature", "image_led", "diagram_native", "hybrid"}
_ALLOWED_INTEGRATIONS = {
    "full_bleed_background",
    "inset_illustration",
    "masked_panel",
    "texture_layer",
    "subject_photo",
    "none",
}


class CreativePlanValidationError(ValueError):
    def __init__(self, code: str, summary: str) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary


def normalize_creative_plan(
    raw: dict[str, Any] | None,
    *,
    deck: DeckBuild,
    request_context: str,
    source_design_plan: dict[str, Any] | None = None,
) -> DeckCreativePlan:
    if not isinstance(raw, dict) or not raw:
        raise CreativePlanValidationError(
            "deck_creative_plan_required",
            "creative_plan is required for fresh PPTX builds.",
        )
    design_plan = _coerce_design_plan(
        raw.get("design_plan"),
        deck=deck,
        request_context=request_context,
        source_design_plan=source_design_plan,
    )
    image_assets = _coerce_image_assets(raw.get("image_assets"))
    slide_compositions = _coerce_slide_compositions(raw.get("slide_compositions"))
    plan = DeckCreativePlan(
        subject=_required_text(raw, "subject", limit=160),
        audience=_required_text(raw, "audience", limit=160),
        goal=_required_text(raw, "goal", limit=220),
        story_arc=_required_text(raw, "story_arc", limit=800),
        design_plan=design_plan,
        image_strategy=_enum_text(raw.get("image_strategy"), _ALLOWED_IMAGE_STRATEGIES, "hybrid"),
        image_assets=image_assets,
        slide_compositions=slide_compositions,
        anti_slop_commitments=_text_list(raw.get("anti_slop_commitments"), limit=10, item_limit=180),
    )
    _validate_slide_links(plan, deck)
    return plan


def write_creative_plan(plan: DeckCreativePlan, host_path: Path) -> None:
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(json.dumps(asdict(plan), indent=2), encoding="utf-8")


def _coerce_design_plan(
    raw: Any,
    *,
    deck: DeckBuild,
    request_context: str,
    source_design_plan: dict[str, Any] | None,
) -> DeckDesignPlan:
    if not isinstance(raw, dict):
        return resolve_deck_design_plan(
            deck_title=deck.deck_title,
            slides=[
                {"title": slide.title, "role": slide.role, "layout_kind": slide.layout_kind}
                for slide in deck.slides
            ],
            register=deck.register,
            style_profile=deck.style_profile,
            design_plan=source_design_plan,
            request_context=request_context,
        )
    palette = raw.get("palette")
    palette_tokens = [_coerce_color_token(item) for item in palette] if isinstance(palette, list) else []
    typography = _coerce_typography(raw.get("typography"))
    grid = _coerce_grid(raw.get("grid"))
    if not palette_tokens:
        fallback = resolve_deck_design_plan(
            deck_title=deck.deck_title,
            slides=[
                {"title": slide.title, "role": slide.role, "layout_kind": slide.layout_kind}
                for slide in deck.slides
            ],
            register=deck.register,
            style_profile=deck.style_profile,
            design_plan=source_design_plan,
            request_context=request_context,
        )
        palette_tokens = fallback.palette
        if typography is None:
            typography = fallback.typography
    return DeckDesignPlan(
        source=_clean_text(raw.get("source"), limit=80) or "creative_plan",
        subject=_clean_text(raw.get("subject"), limit=160) or deck.deck_title,
        audience=_clean_text(raw.get("audience"), limit=160) or "technical stakeholders",
        goal=_clean_text(raw.get("goal"), limit=220) or "explain the system clearly",
        style_lane=_clean_text(raw.get("style_lane"), limit=80) or "custom_subject_derived",
        palette=palette_tokens,
        typography=typography or DeckTypographyPlan(display="Aptos Display", body="Aptos", utility="Aptos"),
        grid=grid,
        signature=_clean_text(raw.get("signature"), limit=240) or "subject-derived visual system",
        rhythm=_clean_text(raw.get("rhythm"), limit=240) or "varied slide structures with one idea per slide",
        anti_slop_profile=_text_list(raw.get("anti_slop_profile"), limit=12, item_limit=160),
        requested_style_terms=_text_list(raw.get("requested_style_terms"), limit=12, item_limit=80),
        normalized_from_style_profile={
            str(key): _safe_json_value(value)
            for key, value in (raw.get("normalized_from_style_profile") or {}).items()
        }
        if isinstance(raw.get("normalized_from_style_profile"), dict)
        else {},
    )


def _coerce_color_token(raw: Any) -> DeckColorToken:
    if not isinstance(raw, dict):
        return DeckColorToken("accent", "#2563EB", "fallback accent")
    name = _clean_text(raw.get("name"), limit=60) or "accent"
    hex_value = _clean_text(raw.get("hex"), limit=16) or "#2563EB"
    if not re.match(r"^#[0-9a-fA-F]{6}$", hex_value):
        hex_value = "#2563EB"
    return DeckColorToken(
        name=name,
        hex=hex_value,
        role=_clean_text(raw.get("role"), limit=120) or "deck color token",
    )


def _coerce_typography(raw: Any) -> DeckTypographyPlan | None:
    if not isinstance(raw, dict):
        return None
    return DeckTypographyPlan(
        display=_clean_text(raw.get("display"), limit=80) or "Aptos Display",
        body=_clean_text(raw.get("body"), limit=80) or "Aptos",
        utility=_clean_text(raw.get("utility"), limit=80) or "Aptos",
        display_weight=_int(raw.get("display_weight"), default=720, minimum=100, maximum=900),
        body_weight=_int(raw.get("body_weight"), default=420, minimum=100, maximum=900),
    )


def _coerce_grid(raw: Any) -> DeckGridPlan:
    if not isinstance(raw, dict):
        return DeckGridPlan()
    return DeckGridPlan(
        slide_width_px=1920,
        slide_height_px=1080,
        margin_x_px=_int(raw.get("margin_x_px"), default=120, minimum=40, maximum=260),
        margin_y_px=_int(raw.get("margin_y_px"), default=80, minimum=30, maximum=180),
        title_y_px=_int(raw.get("title_y_px"), default=82, minimum=30, maximum=220),
        footer_policy=_clean_text(raw.get("footer_policy"), limit=80) or "none",
        eyebrow_policy=_clean_text(raw.get("eyebrow_policy"), limit=80) or "only_when_meaningful",
    )


def _coerce_image_assets(raw: Any) -> list[DeckImageAssetPlan]:
    if not isinstance(raw, list):
        return []
    assets: list[DeckImageAssetPlan] = []
    seen: set[str] = set()
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            continue
        asset_id = _clean_id(item.get("asset_id")) or f"asset:{index}"
        if asset_id in seen:
            raise CreativePlanValidationError("deck_image_asset_plan_invalid", f"Duplicate image asset id: {asset_id}")
        seen.add(asset_id)
        prompt = _required_text(item, "prompt", limit=1200)
        assets.append(
            DeckImageAssetPlan(
                asset_id=asset_id,
                slide_selector=_required_text(item, "slide_selector", limit=40),
                role=_clean_text(item.get("role"), limit=60) or "inset_illustration",
                reason=_required_text(item, "reason", limit=240),
                prompt=prompt,
                aspect_ratio=_clean_text(item.get("aspect_ratio"), limit=20) or "16:9",
                integration=_enum_text(item.get("integration"), _ALLOWED_INTEGRATIONS, "inset_illustration"),
                no_baked_text=bool(item.get("no_baked_text", True)),
            )
        )
    return assets


def _coerce_slide_compositions(raw: Any) -> list[DeckSlideCompositionPlan]:
    if not isinstance(raw, list):
        return []
    compositions: list[DeckSlideCompositionPlan] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        selector = _required_text(item, "selector", limit=40)
        if selector in seen:
            raise CreativePlanValidationError("deck_creative_plan_invalid", f"Duplicate slide composition selector: {selector}")
        seen.add(selector)
        compositions.append(
            DeckSlideCompositionPlan(
                selector=selector,
                slide_role=_clean_text(item.get("slide_role"), limit=80) or "content",
                headline_intent=_required_text(item, "headline_intent", limit=220),
                layout_name=_required_text(item, "layout_name", limit=100),
                composition_rationale=_required_text(item, "composition_rationale", limit=300),
                native_elements=_text_list(item.get("native_elements"), limit=16, item_limit=80),
                image_asset_ids=[_clean_id(value) for value in _text_list(item.get("image_asset_ids"), limit=8, item_limit=80) if _clean_id(value)],
                risk_notes=_text_list(item.get("risk_notes"), limit=8, item_limit=140),
            )
        )
    return compositions


def _validate_slide_links(plan: DeckCreativePlan, deck: DeckBuild) -> None:
    selectors = {slide.selector for slide in deck.slides}
    asset_ids = {asset.asset_id for asset in plan.image_assets}
    composition_selectors = {composition.selector for composition in plan.slide_compositions}
    missing_compositions = sorted(selectors - composition_selectors)
    if missing_compositions:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"creative_plan.slide_compositions missing selectors: {', '.join(missing_compositions[:5])}",
        )
    for asset in plan.image_assets:
        if asset.slide_selector not in selectors:
            raise CreativePlanValidationError(
                "deck_image_asset_plan_invalid",
                f"image asset {asset.asset_id} references unknown slide_selector {asset.slide_selector}",
            )
        if not asset.no_baked_text:
            raise CreativePlanValidationError(
                "deck_image_asset_plan_invalid",
                f"image asset {asset.asset_id} must set no_baked_text=true",
            )
    for composition in plan.slide_compositions:
        unknown = [asset_id for asset_id in composition.image_asset_ids if asset_id not in asset_ids]
        if unknown:
            raise CreativePlanValidationError(
                "deck_image_asset_plan_invalid",
                f"slide {composition.selector} references unknown image_asset_ids: {', '.join(unknown[:5])}",
            )


def _required_text(raw: dict[str, Any], key: str, *, limit: int) -> str:
    value = _clean_text(raw.get(key), limit=limit)
    if not value:
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"creative_plan.{key} is required")
    return value


def _clean_text(value: Any, *, limit: int) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()[:limit]


def _clean_id(value: Any) -> str:
    text = _clean_text(value, limit=80)
    return text if _SAFE_ID_RE.match(text) else ""


def _enum_text(value: Any, allowed: set[str], fallback: str) -> str:
    text = _clean_text(value, limit=80)
    return text if text in allowed else fallback


def _text_list(value: Any, *, limit: int, item_limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        clean
        for item in value[:limit]
        for clean in [_clean_text(item, limit=item_limit)]
        if clean
    ]


def _int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def _safe_json_value(value: Any) -> Any:
    if isinstance(value, str):
        return value[:240]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_safe_json_value(item) for item in value[:12]]
    if isinstance(value, dict):
        return {str(key): _safe_json_value(item) for key, item in list(value.items())[:12]}
    return str(value)[:120]
