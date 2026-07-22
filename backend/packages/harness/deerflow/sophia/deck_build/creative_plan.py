from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any

from deerflow.sophia.deck_build.models import (
    DeckBuild,
    DeckColorToken,
    DeckCreativePlan,
    DeckCritiqueScores,
    DeckDesignPlan,
    DeckGridPlan,
    DeckImageAssetPlan,
    DeckPlanCritique,
    DeckSlideCompositionPlan,
    DeckTypographyPlan,
)
from deerflow.sophia.deck_build.tool_contract import normalize_slide_composition_aliases

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$")
_DECK_ELEMENT_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_DECK_ID_ATTRIBUTE_RE = re.compile(r"\bdata-deck-id\s*=\s*([\"'])([^\"']+)\1", re.I)
_SEMANTIC_IMAGE_TEXT_RE = re.compile(
    r"\b(?:include|show|render|display|write|add)\s+(?:the\s+)?"
    r"(?:words?|text|labels?|title|caption|annotations?|axis|formula)\b|"
    r"\b(?:labelled|labeled|annotated)\s+(?:diagram|graphic|image|illustration)\b",
    re.I,
)
_ALLOWED_IMAGE_STRATEGIES = {"hero_only", "sparse_signature", "image_led", "diagram_native", "hybrid"}
_ALLOWED_INTEGRATIONS = {
    "full_bleed_background",
    "inset_illustration",
    "masked_panel",
    "texture_layer",
    "subject_photo",
    "none",
}
_MANDATORY_SKILL_REF = "hands-on-deck/designing-slides"
_GENERIC_SIGNATURES = {
    "subject-derived visual system",
    "professional technical visual system",
    "clean modern visual system",
}
_GENERIC_RHYTHMS = {
    "varied slide structures with one idea per slide",
    "varied layouts",
    "one idea per slide",
}
_CANONICAL_PPTX_FONTS = {
    "arial": "Arial",
    "calibri": "Calibri",
    "cambria": "Cambria",
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
    )
    image_assets = _coerce_image_assets(raw.get("image_assets"))
    slide_compositions = _coerce_slide_compositions(raw.get("slide_compositions"))
    skill_refs = _required_text_list(
        raw.get("skill_refs"),
        path="creative_plan.skill_refs",
        minimum=1,
        limit=12,
        item_limit=100,
    )
    if _MANDATORY_SKILL_REF not in skill_refs:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"creative_plan.skill_refs must include {_MANDATORY_SKILL_REF}",
        )
    plan = DeckCreativePlan(
        subject=_required_text(raw, "subject", limit=160, path="creative_plan"),
        audience=_required_text(raw, "audience", limit=160, path="creative_plan"),
        goal=_required_text(raw, "goal", limit=220, path="creative_plan"),
        viewing_context=_required_text(raw, "viewing_context", limit=240, path="creative_plan"),
        subject_materials=_required_text_list(
            raw.get("subject_materials"),
            path="creative_plan.subject_materials",
            minimum=3,
            limit=12,
            item_limit=160,
        ),
        story_arc=_required_text(raw, "story_arc", limit=800, path="creative_plan"),
        design_plan=design_plan,
        image_strategy=_required_enum(
            raw.get("image_strategy"),
            _ALLOWED_IMAGE_STRATEGIES,
            "creative_plan.image_strategy",
        ),
        image_strategy_rationale=_required_text(
            raw,
            "image_strategy_rationale",
            limit=360,
            path="creative_plan",
        ),
        image_assets=image_assets,
        slide_compositions=slide_compositions,
        skill_refs=skill_refs,
        plan_critique=_coerce_plan_critique(raw.get("plan_critique")),
        anti_slop_commitments=_required_text_list(
            raw.get("anti_slop_commitments"),
            path="creative_plan.anti_slop_commitments",
            minimum=1,
            limit=10,
            item_limit=180,
        ),
    )
    _validate_slide_links(plan, deck)
    return plan


def write_creative_plan(plan: DeckCreativePlan, host_path: Path) -> None:
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(json.dumps(asdict(plan), indent=2), encoding="utf-8")


def _coerce_design_plan(
    raw: Any,
) -> DeckDesignPlan:
    if not isinstance(raw, dict):
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            "creative_plan.design_plan is required and must contain explicit design evidence.",
        )
    palette = raw.get("palette")
    palette_tokens = [
        _coerce_color_token(item, path=f"creative_plan.design_plan.palette[{index}]")
        for index, item in enumerate(palette)
    ] if isinstance(palette, list) else []
    typography = _coerce_typography(raw.get("typography"))
    grid = _coerce_grid(raw.get("grid"))
    if len(palette_tokens) < 4:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            "creative_plan.design_plan.palette requires at least four named colors.",
        )
    if typography is None:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            "creative_plan.design_plan.typography is required.",
        )
    signature = _required_text(raw, "signature", limit=240, path="creative_plan.design_plan")
    rhythm = _required_text(raw, "rhythm", limit=240, path="creative_plan.design_plan")
    if signature.lower() in _GENERIC_SIGNATURES:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            "creative_plan.design_plan.signature must be subject-specific, not a generic fallback.",
        )
    if rhythm.lower() in _GENERIC_RHYTHMS:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            "creative_plan.design_plan.rhythm must describe a specific sequence, not a generic fallback.",
        )
    return DeckDesignPlan(
        source=_required_text(raw, "source", limit=80, path="creative_plan.design_plan"),
        subject=_required_text(raw, "subject", limit=160, path="creative_plan.design_plan"),
        audience=_required_text(raw, "audience", limit=160, path="creative_plan.design_plan"),
        goal=_required_text(raw, "goal", limit=220, path="creative_plan.design_plan"),
        style_lane=_required_text(raw, "style_lane", limit=80, path="creative_plan.design_plan"),
        palette=palette_tokens,
        typography=typography,
        grid=grid,
        signature=signature,
        rhythm=rhythm,
        anti_slop_profile=_required_text_list(
            raw.get("anti_slop_profile"),
            path="creative_plan.design_plan.anti_slop_profile",
            minimum=1,
            limit=12,
            item_limit=160,
        ),
        requested_style_terms=_text_list(raw.get("requested_style_terms"), limit=12, item_limit=80),
        normalized_from_style_profile={
            str(key): _safe_json_value(value)
            for key, value in (raw.get("normalized_from_style_profile") or {}).items()
        }
        if isinstance(raw.get("normalized_from_style_profile"), dict)
        else {},
    )


def _coerce_color_token(raw: Any, *, path: str) -> DeckColorToken:
    if not isinstance(raw, dict):
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"{path} must be an object")
    name = _required_text(raw, "name", limit=60, path=path)
    hex_value = _required_text(raw, "hex", limit=16, path=path)
    if not re.match(r"^#[0-9a-fA-F]{6}$", hex_value):
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"{path}.hex must be a six-digit CSS hex color")
    return DeckColorToken(
        name=name,
        hex=hex_value,
        role=_required_text(raw, "role", limit=120, path=path),
    )


def _coerce_typography(raw: Any) -> DeckTypographyPlan | None:
    if not isinstance(raw, dict):
        return None
    display = _required_text(raw, "display", limit=80, path="creative_plan.design_plan.typography")
    body = _required_text(raw, "body", limit=80, path="creative_plan.design_plan.typography")
    utility = _clean_text(raw.get("utility"), limit=80) or body
    return DeckTypographyPlan(
        # Fresh native decks use a deliberately narrow Office-safe contract.
        # Normalize non-conforming model choices instead of letting browser and
        # LibreOffice substitutions silently diverge.
        display=_canonical_pptx_font(display, fallback="Cambria", allow_cambria=True),
        body=_canonical_pptx_font(body, fallback="Calibri", allow_cambria=False),
        utility=_canonical_pptx_font(utility, fallback="Calibri", allow_cambria=False),
        display_weight=_int(raw.get("display_weight"), default=720, minimum=100, maximum=900),
        body_weight=_int(raw.get("body_weight"), default=420, minimum=100, maximum=900),
    )


def _canonical_pptx_font(value: str, *, fallback: str, allow_cambria: bool) -> str:
    key = re.sub(r"\s+", " ", value.strip()).lower()
    canonical = _CANONICAL_PPTX_FONTS.get(key)
    if canonical == "Cambria" and not allow_cambria:
        return fallback
    return canonical or fallback


def _coerce_grid(raw: Any) -> DeckGridPlan:
    if not isinstance(raw, dict):
        return DeckGridPlan()
    return DeckGridPlan(
        slide_width_px=1920,
        slide_height_px=1080,
        margin_x_px=_int(raw.get("margin_x_px"), default=120, minimum=40, maximum=260),
        margin_y_px=_int(raw.get("margin_y_px"), default=80, minimum=30, maximum=180),
        title_y_px=_int(raw.get("title_y_px"), default=82, minimum=30, maximum=220),
        # The terminal quality contract forbids recurring page chrome. Normalize
        # legacy/internal payloads to the same invariant exposed by the typed tool.
        footer_policy="none",
        eyebrow_policy="none",
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
        path = f"creative_plan.image_assets[{index - 1}]"
        prompt = _required_text(item, "prompt", limit=1200, path=path)
        if _SEMANTIC_IMAGE_TEXT_RE.search(prompt):
            raise CreativePlanValidationError(
                "deck_image_asset_plan_invalid",
                f"{path}.prompt asks generated imagery to carry semantic text or labels",
            )
        assets.append(
            DeckImageAssetPlan(
                asset_id=asset_id,
                slide_selector=_required_text(item, "slide_selector", limit=40, path=path),
                role=_clean_text(item.get("role"), limit=60) or "inset_illustration",
                reason=_required_text(item, "reason", limit=240, path=path),
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
    for index, source_item in enumerate(raw):
        item = normalize_slide_composition_aliases(source_item)
        if not isinstance(item, dict):
            continue
        path = f"creative_plan.slide_compositions[{index}]"
        selector = _required_text(item, "selector", limit=40, path=path)
        if selector in seen:
            raise CreativePlanValidationError("deck_creative_plan_invalid", f"Duplicate slide composition selector: {selector}")
        seen.add(selector)
        compositions.append(
            DeckSlideCompositionPlan(
                selector=selector,
                slide_role=_clean_text(item.get("slide_role"), limit=80) or "content",
                headline_intent=_required_text(item, "headline_intent", limit=220, path=path),
                layout_name=_required_text(item, "layout_name", limit=100, path=path),
                composition_rationale=_required_text(item, "composition_rationale", limit=300, path=path),
                native_elements=_text_list(item.get("native_elements"), limit=16, item_limit=80),
                image_asset_ids=[_clean_id(value) for value in _text_list(item.get("image_asset_ids"), limit=8, item_limit=80) if _clean_id(value)],
                required_element_ids=_required_deck_ids(item.get("required_element_ids"), path=path),
                structural_fingerprint=_required_text(item, "structural_fingerprint", limit=180, path=path),
                risk_notes=_text_list(item.get("risk_notes"), limit=8, item_limit=140),
            )
        )
    return compositions


def _validate_slide_links(plan: DeckCreativePlan, deck: DeckBuild) -> None:
    selectors = {slide.selector for slide in deck.slides}
    composition_selectors = {composition.selector for composition in plan.slide_compositions}
    missing_compositions = sorted(selectors - composition_selectors)
    if missing_compositions:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"creative_plan.slide_compositions missing selectors: {', '.join(missing_compositions[:5])}",
        )
    _validate_image_asset_links(plan, selectors)
    _validate_composition_asset_links(plan)
    _validate_required_html_ids(plan, deck)
    _validate_structural_fingerprints(plan)


def _validate_image_asset_links(plan: DeckCreativePlan, selectors: set[str]) -> None:
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


def _validate_composition_asset_links(plan: DeckCreativePlan) -> None:
    asset_ids = {asset.asset_id for asset in plan.image_assets}
    for composition in plan.slide_compositions:
        unknown = [asset_id for asset_id in composition.image_asset_ids if asset_id not in asset_ids]
        if unknown:
            raise CreativePlanValidationError(
                "deck_image_asset_plan_invalid",
                f"slide {composition.selector} references unknown image_asset_ids: {', '.join(unknown[:5])}",
            )


def _validate_required_html_ids(plan: DeckCreativePlan, deck: DeckBuild) -> None:
    slides_by_selector = {slide.selector: slide for slide in deck.slides}
    for composition in plan.slide_compositions:
        slide = slides_by_selector.get(composition.selector)
        if slide is None or not (slide.html_source or "").strip():
            continue
        source_ids = {
            match.group(2)
            for match in _DECK_ID_ATTRIBUTE_RE.finditer(slide.html_source or "")
        }
        missing_ids = [element_id for element_id in composition.required_element_ids if element_id not in source_ids]
        if missing_ids:
            raise CreativePlanValidationError(
                "deck_creative_plan_invalid",
                f"creative_plan slide {composition.selector} required_element_ids missing from html_source: {', '.join(missing_ids[:5])}",
            )


def _validate_structural_fingerprints(plan: DeckCreativePlan) -> None:
    fingerprints = [composition.structural_fingerprint.strip().lower() for composition in plan.slide_compositions]
    if len(fingerprints) >= 3 and len(set(fingerprints)) == 1:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            "creative_plan.slide_compositions must not reuse one structural_fingerprint for every slide",
        )


def _coerce_plan_critique(raw: Any) -> DeckPlanCritique:
    if not isinstance(raw, dict):
        raise CreativePlanValidationError("deck_creative_plan_invalid", "creative_plan.plan_critique is required")
    initial = _coerce_critique_scores(raw.get("initial_scores"), path="creative_plan.plan_critique.initial_scores")
    final = _coerce_critique_scores(raw.get("final_scores"), path="creative_plan.plan_critique.final_scores")
    below_threshold = [
        name
        for name, value in final.to_dict().items()
        if int(value) < 3
    ]
    if below_threshold:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"creative_plan.plan_critique.final_scores.{below_threshold[0]} must be at least 3 after revision",
        )
    return DeckPlanCritique(
        initial_scores=initial,
        weakest_point=_required_text(raw, "weakest_point", limit=240, path="creative_plan.plan_critique"),
        revision_made=_required_text(raw, "revision_made", limit=360, path="creative_plan.plan_critique"),
        final_scores=final,
    )


def _coerce_critique_scores(raw: Any, *, path: str) -> DeckCritiqueScores:
    if not isinstance(raw, dict):
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"{path} is required")
    return DeckCritiqueScores(
        philosophy=_score(raw.get("philosophy"), f"{path}.philosophy"),
        hierarchy=_score(raw.get("hierarchy"), f"{path}.hierarchy"),
        execution_feasibility=_score(raw.get("execution_feasibility"), f"{path}.execution_feasibility"),
        specificity=_score(raw.get("specificity"), f"{path}.specificity"),
        restraint=_score(raw.get("restraint"), f"{path}.restraint"),
        variety=_score(raw.get("variety"), f"{path}.variety"),
    )


def _score(value: Any, path: str) -> int:
    try:
        score = int(value)
    except (TypeError, ValueError) as exc:
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"{path} must be an integer from 1 to 5") from exc
    if not 1 <= score <= 5:
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"{path} must be from 1 to 5")
    return score


def _required_deck_ids(value: Any, *, path: str) -> list[str]:
    ids = _required_text_list(
        value,
        path=f"{path}.required_element_ids",
        minimum=1,
        limit=32,
        item_limit=64,
    )
    invalid = [element_id for element_id in ids if not _DECK_ELEMENT_ID_RE.fullmatch(element_id)]
    if invalid:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"{path}.required_element_ids contains invalid ID: {invalid[0]}",
        )
    if len(ids) != len(set(ids)):
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"{path}.required_element_ids contains duplicates",
        )
    return ids


def _required_text(raw: dict[str, Any], key: str, *, limit: int, path: str) -> str:
    value = _clean_text(raw.get(key), limit=limit)
    if not value:
        raise CreativePlanValidationError("deck_creative_plan_invalid", f"{path}.{key} is required")
    return value


def _required_text_list(
    value: Any,
    *,
    path: str,
    minimum: int,
    limit: int,
    item_limit: int,
) -> list[str]:
    items = _text_list(value, limit=limit, item_limit=item_limit)
    if len(items) < minimum:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"{path} requires at least {minimum} item(s)",
        )
    return items


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


def _required_enum(value: Any, allowed: set[str], path: str) -> str:
    text = _clean_text(value, limit=80)
    if text not in allowed:
        raise CreativePlanValidationError(
            "deck_creative_plan_invalid",
            f"{path} must be one of: {', '.join(sorted(allowed))}",
        )
    return text


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
