"""Model-facing typed contract for the fresh-deck build tool."""

from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationInfo, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema

from deerflow.sophia.deck_build.prepare_input import (
    normalize_creative_plan_value,
    normalize_slides_value,
)


def normalize_slide_composition_aliases(raw: Any) -> Any:
    """Map only direct legacy aliases; never invent semantic content."""

    if not isinstance(raw, dict):
        return raw
    normalized = dict(raw)
    if not normalized.get("selector") and normalized.get("slide") is not None:
        slide = str(normalized["slide"]).strip()
        normalized["selector"] = slide if slide.startswith("slide:") else f"slide:{slide}"
    if not normalized.get("slide_role") and normalized.get("role") is not None:
        normalized["slide_role"] = normalized["role"]
    if not normalized.get("layout_name") and normalized.get("layout") is not None:
        normalized["layout_name"] = normalized["layout"]
    return normalized


class DeckColorTokenInput(BaseModel):
    name: str = Field(description="Short token name, such as background, ink, or accent.")
    hex: str = Field(description="Six-digit CSS hex color, for example #0B1020.")
    role: str = Field(description="How the color is used in the deck.")


class DeckTypographyInput(BaseModel):
    display: str = Field(description="Display/headline font family.")
    body: str = Field(description="Body font family.")
    utility: str | None = Field(default=None, description="Optional labels and utility font family.")
    display_weight: int = Field(default=720, ge=100, le=900)
    body_weight: int = Field(default=420, ge=100, le=900)


class DeckGridInput(BaseModel):
    margin_x_px: int = Field(default=120, ge=40, le=260)
    margin_y_px: int = Field(default=80, ge=30, le=180)
    title_y_px: int = Field(default=82, ge=30, le=220)
    footer_policy: Literal["none"] = Field(
        default="none",
        description="Fresh decks never add recurring footer or page-number chrome.",
    )
    eyebrow_policy: Literal["none"] = Field(
        default="none",
        description="Fresh decks never add eyebrow, kicker, section-label, or navigation chrome.",
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_legacy_chrome_policies(cls, value: Any) -> Any:
        """Accept queued legacy plans while preserving the strict public schema."""

        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        normalized["footer_policy"] = "none"
        normalized["eyebrow_policy"] = "none"
        return normalized


class DeckDesignPlanInput(BaseModel):
    source: str = Field(description="Origin of the creative direction, normally creative_plan.")
    subject: str = Field(description="Specific presentation subject.")
    audience: str = Field(description="Primary audience.")
    goal: str = Field(description="Communication goal.")
    style_lane: str = Field(description="Subject-derived visual direction; avoid generic dashboard styling.")
    palette: list[DeckColorTokenInput] = Field(min_length=4, max_length=8, description="Named deck color tokens.")
    typography: DeckTypographyInput
    grid: DeckGridInput = Field(default_factory=DeckGridInput)
    signature: str = Field(description="Distinctive visual motif tying the deck together.")
    rhythm: str = Field(description="How composition varies across the deck.")
    anti_slop_profile: list[str] = Field(default_factory=list)
    requested_style_terms: list[str] = Field(default_factory=list)


class DeckImageAssetInput(BaseModel):
    asset_id: str = Field(description="Stable unique identifier, for example asset:architecture.")
    slide_selector: str = Field(description="Owning slide selector, for example slide:3.")
    role: str = Field(description="Visual role, such as inset_illustration or subject_photo.")
    reason: str = Field(description="Why this generated asset improves the slide.")
    prompt: str = Field(description="Image prompt describing only the asset, with no baked text.")
    aspect_ratio: str = Field(default="16:9")
    integration: Literal[
        "full_bleed_background",
        "inset_illustration",
        "masked_panel",
        "texture_layer",
        "subject_photo",
        "none",
    ] = Field(default="inset_illustration")
    no_baked_text: bool = Field(default=True, description="Must remain true.")


class DeckCritiqueScoresInput(BaseModel):
    philosophy: int = Field(ge=1, le=5)
    hierarchy: int = Field(ge=1, le=5)
    execution_feasibility: int = Field(ge=1, le=5)
    specificity: int = Field(ge=1, le=5)
    restraint: int = Field(ge=1, le=5)
    variety: int = Field(ge=1, le=5)


class DeckPlanCritiqueInput(BaseModel):
    initial_scores: DeckCritiqueScoresInput
    weakest_point: str = Field(min_length=1, description="The weakest initial design dimension.")
    revision_made: str = Field(min_length=1, description="Specific revision made before authoring HTML.")
    final_scores: DeckCritiqueScoresInput


class DeckSlideCompositionInput(BaseModel):
    selector: str = Field(description="Canonical slide selector, for example slide:1.")
    slide_role: str = Field(description="Narrative role such as cover, architecture, evidence, or closing.")
    headline_intent: str = Field(description="What the slide headline must communicate.")
    layout_name: str = Field(description="Specific composition name for this slide.")
    composition_rationale: str = Field(description="Why this composition fits the slide's content.")
    native_elements: list[str] = Field(description="Native text, shape, chart, and diagram elements.")
    image_asset_ids: list[str] = Field(description="Generated asset IDs used by this slide; empty when none.")
    required_element_ids: list[str] = Field(
        min_length=1,
        description="Semantic data-deck-id values that must survive native compilation.",
    )
    structural_fingerprint: str = Field(
        min_length=1,
        description="Compact description of this slide's distinct spatial structure.",
    )
    risk_notes: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _normalize_direct_aliases(cls, value: Any) -> Any:
        return normalize_slide_composition_aliases(value)


class DeckCreativePlanInput(BaseModel):
    subject: str = Field(description="Presentation subject.")
    audience: str = Field(description="Primary audience.")
    goal: str = Field(description="Desired audience outcome.")
    viewing_context: str = Field(description="How and where the deck will be viewed.")
    subject_materials: list[str] = Field(
        min_length=3,
        description="At least three subject-specific materials, diagrams, metaphors, or visual cues.",
    )
    story_arc: str = Field(description="Concise beginning-to-end narrative arc.")
    design_plan: DeckDesignPlanInput
    image_strategy: Literal[
        "hero_only",
        "sparse_signature",
        "image_led",
        "diagram_native",
        "hybrid",
    ]
    image_strategy_rationale: str = Field(description="Why the selected visual medium fits this deck.")
    image_assets: list[DeckImageAssetInput] = Field(description="Planned generated assets; may be empty.")
    slide_compositions: list[DeckSlideCompositionInput] = Field(description="Exactly one canonical composition record for every slide.")
    skill_refs: list[str] = Field(
        min_length=1,
        description="Design guidance used; must include hands-on-deck/designing-slides.",
    )
    plan_critique: DeckPlanCritiqueInput
    anti_slop_commitments: list[str] = Field(default_factory=list)


_MAX_DECK_STYLESHEET_BYTES = 24 * 1024
_MAX_SLIDE_HTML_BODY_BYTES = 16 * 1024
_MAX_SLIDE_CSS_BYTES = 8 * 1024
_MAX_AUTHORING_PAYLOAD_BYTES = 128 * 1024
_V2_MAX_DECK_STYLESHEET_BYTES = 8 * 1024
COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES = 4 * 1024
COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES = 6 * 1024
_V2_MAX_SLIDE_CSS_BYTES = 1 * 1024
_V2_MAX_CREATIVE_PLAN_BYTES = 12 * 1024
_V2_MAX_AUTHORING_PAYLOAD_BYTES = 48 * 1024
_MAX_PREPARE_VALIDATION_ERRORS = 8
_MAX_PREPARE_VALIDATION_SUMMARY_CHARS = 1200
_DOCUMENT_FRAGMENT_TAGS = ("<html", "</html", "<head", "</head", "<body", "</body", "<style", "</style")
_REPAIR_ANCHOR_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}")


def _utf8_size(value: str | None) -> int:
    return len((value or "").encode("utf-8"))


def _compact_json_size(value: Any) -> int | None:
    try:
        encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError):
        return None
    return _utf8_size(encoded)


def _compact_slide_repair_target(*, index: int) -> str:
    """Return an unambiguous identifier without echoing model-authored content."""

    return f"index {index} (zero-based) = visible slide {index + 1}"


def _compact_slide_json_schema(schema: dict[str, Any]) -> None:
    required = schema.setdefault("required", [])
    for field_name in ("html_body", "repair_anchor_ids"):
        if field_name not in required:
            required.append(field_name)
    body_schema = schema.get("properties", {}).get("html_body")
    if isinstance(body_schema, dict):
        body_schema.pop("default", None)
        body_schema["description"] = (
            f"{str(body_schema.get('description') or '').rstrip()} "
            f"Target at most {COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES} UTF-8 bytes per slide. "
            f"Combined slide bodies must remain within {COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES} "
            f"bytes times the slide count. Slides may borrow unused body budget, with each slide "
            f"capped at {COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES} UTF-8 bytes."
        ).strip()
        _set_string_max_length(body_schema, COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES)
    slide_css_schema = schema.get("properties", {}).get("slide_css")
    if isinstance(slide_css_schema, dict):
        _set_string_max_length(slide_css_schema, _V2_MAX_SLIDE_CSS_BYTES)
    repair_anchor_schema = schema.get("properties", {}).get("repair_anchor_ids")
    if isinstance(repair_anchor_schema, dict):
        repair_anchor_schema.pop("default", None)
        repair_anchor_schema["minItems"] = 2
        repair_anchor_schema["maxItems"] = 2
        repair_anchor_schema["uniqueItems"] = True
        items_schema = repair_anchor_schema.get("items")
        if isinstance(items_schema, dict):
            items_schema["pattern"] = r"^[a-z][a-z0-9_-]{0,31}$"


def _compact_prepare_json_schema(schema: dict[str, Any]) -> None:
    properties = schema.setdefault("properties", {})
    register_schema = properties.pop("deck_register", None)
    if isinstance(register_schema, dict):
        register_schema["title"] = "Register"
        properties["register"] = register_schema
    required = schema.setdefault("required", [])
    if "deck_stylesheet" not in required:
        required.append("deck_stylesheet")
    stylesheet_schema = schema.get("properties", {}).get("deck_stylesheet")
    if isinstance(stylesheet_schema, dict):
        stylesheet_schema.pop("default", None)
        _set_string_max_length(stylesheet_schema, _V2_MAX_DECK_STYLESHEET_BYTES)
    if "authoring_contract" not in required:
        required.append("authoring_contract")
    schema.setdefault("properties", {})["authoring_contract"] = {
        "const": "compact_model_html_v2",
        "description": "Required compact authoring profile for new model-owned deck calls.",
        "type": "string",
    }


def _set_string_max_length(schema: dict[str, Any], limit: int) -> None:
    if schema.get("type") == "string":
        schema["maxLength"] = limit
        return
    for variant in schema.get("anyOf", []):
        if isinstance(variant, dict) and variant.get("type") == "string":
            variant["maxLength"] = limit


class DeckSlideInput(BaseModel):
    model_config = ConfigDict(json_schema_extra=_compact_slide_json_schema)
    title: str = Field(min_length=1, max_length=90)
    narrative: str = Field(min_length=1, max_length=280)
    role: str = Field(default="content")
    layout_kind: str = Field(default="single_visual_focus")
    html_body: str | None = Field(
        default=None,
        description=(
            "Compiler-supported markup inside the slide canvas. Do not include html, head, body, or style tags. "
            "Include at least two independent non-nested section or div direct children of the service-owned main "
            "canvas as repair-addressable layout anchors. Each anchor must contain visible semantic text and use "
            "an HTML id unique within its slide; the same two short anchor IDs may be reused in separate slide "
            "fragments so shared #id rules scale. Each anchor id must match [a-z][a-z0-9_-]{0,31}: a lowercase "
            "ASCII letter followed by at most "
            "31 lowercase ASCII letters, digits, underscore, or hyphen, for a maximum of 32 characters. Each "
            "anchor's data-deck-id must be unique within its slide, its data-deck-role must be nonempty, and "
            "data-deck-required must equal true."
        ),
    )
    repair_anchor_ids: list[str] = Field(
        default_factory=list,
        description=(
            "Exactly two short HTML ids naming this slide's repair-addressable direct-child anchors. Each value "
            "must match [a-z][a-z0-9_-]{0,31}, be unique within this list, and exactly match one eligible section "
            "or div id in html_body. These two ids define the strict repair witness pair; other layout elements "
            "remain allowed. Example: [\"hero\",\"proof\"]."
        ),
    )
    slide_css: str | None = Field(
        default=None,
        description=(
            "For compact_model_html_v2, omit slide_css or pass an empty string so the authenticated repair overlay "
            "retains its full 1024-byte budget. Put all fresh-deck CSS, including repair-anchor geometry, in "
            "deck_stylesheet."
        ),
    )
    # Transitional service compatibility. Keeping this out of JSON schema prevents
    # new model calls from rediscovering the oversized six-document contract.
    html_source: SkipJsonSchema[str | None] = Field(default=None)
    speaker_notes: str | None = None
    claim: str | None = None
    visual_prompt: str | None = None

    @model_validator(mode="after")
    def _validate_authoring_source(self) -> DeckSlideInput:
        body = (self.html_body or "").strip()
        source = (self.html_source or "").strip()
        slide_css = (self.slide_css or "").strip()
        if body and source:
            raise ValueError("html_body and legacy html_source are mutually exclusive")
        if not body and not source:
            raise ValueError("html_body is required for compact deck authoring")
        if body:
            lower = body.lower()
            forbidden = next((tag for tag in _DOCUMENT_FRAGMENT_TAGS if tag in lower), None)
            if forbidden:
                raise ValueError(f"html_body contains forbidden document tag {forbidden}")
            if _utf8_size(body) > _MAX_SLIDE_HTML_BODY_BYTES:
                raise ValueError("html_body exceeds the 16384-byte limit")
        if slide_css:
            if "</style" in slide_css.lower():
                raise ValueError("slide_css must not contain a closing style tag")
            if _utf8_size(slide_css) > _MAX_SLIDE_CSS_BYTES:
                raise ValueError("slide_css exceeds the 8192-byte limit")
        return self


NormalizedDeckSlides = Annotated[list[DeckSlideInput], BeforeValidator(normalize_slides_value)]
NormalizedDeckCreativePlan = Annotated[
    DeckCreativePlanInput,
    BeforeValidator(normalize_creative_plan_value),
]


class PrepareDeckBuildInput(BaseModel):
    model_config = ConfigDict(
        json_schema_extra=_compact_prepare_json_schema,
        populate_by_name=True,
    )
    deck_title: str
    slides: NormalizedDeckSlides
    output_path: str
    authoring_contract: Literal["compact_model_html_v1", "compact_model_html_v2"] | None = Field(
        default=None,
        description=(
            "New builder calls must use compact_model_html_v2. Omitted and v1 values remain accepted only for queued/internal compatibility."
        ),
    )
    creative_plan: NormalizedDeckCreativePlan
    deck_stylesheet: str | None = Field(
        default=None,
        description=(
            "Shared compiler-supported CSS for every slide. It must style the main 1920x1080 canvas with an opaque "
            "background. For each slide's two repair-addressable anchors, use the anchor's short HTML #id in a flat "
            "rule that declares position:absolute, box-sizing:border-box, margin:0, and finite pixel left, top, width, "
            "and height. Keep each anchor at least 48x24px and wholly on canvas; do not use !important, right, bottom, "
            "inset, min/max sizing, transform, or opacity for an anchor. Do not use at-rules or nested CSS anywhere "
            "in deck_stylesheet. No other CSS "
            "selector matching an anchor may declare a nonzero margin or any logical or vendor margin property; "
            "reset margins on anchor descendants with separate descendant selectors."
        ),
    )
    deck_register: str = Field(
        default="professional_technical",
    )
    visual_policy: str = "auto"
    style_profile: dict[str, Any] | None = None
    design_plan: dict[str, Any] | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_register_alias(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "deck_register" in value or "register" not in value:
            return value
        normalized = dict(value)
        normalized["deck_register"] = normalized.pop("register")
        return normalized

    @field_validator("creative_plan", mode="before")
    @classmethod
    def _require_v2_creative_plan_object(cls, value: Any, info: ValidationInfo) -> Any:
        if info.data.get("authoring_contract") == "compact_model_html_v2" and not isinstance(
            value,
            (dict, DeckCreativePlanInput),
        ):
            raise ValueError(
                "creative_plan must be a JSON object for compact_model_html_v2, not a JSON string"
            )
        return value

    @model_validator(mode="after")
    def _validate_authoring_mode(self) -> PrepareDeckBuildInput:
        compact_indexes = [index for index, slide in enumerate(self.slides) if (slide.html_body or "").strip()]
        legacy_indexes = [index for index, slide in enumerate(self.slides) if (slide.html_source or "").strip()]
        if compact_indexes and legacy_indexes:
            raise ValueError("slides use mixed authoring modes; every slide must use html_body or every slide must use legacy html_source")
        stylesheet = (self.deck_stylesheet or "").strip()
        if compact_indexes:
            if len(compact_indexes) != len(self.slides):
                raise ValueError("compact authoring requires html_body for every slide")
            if not stylesheet:
                raise ValueError("deck_stylesheet is required for compact deck authoring")
            if "</style" in stylesheet.lower():
                raise ValueError("deck_stylesheet must not contain a closing style tag")
            if _utf8_size(stylesheet) > _MAX_DECK_STYLESHEET_BYTES:
                raise ValueError("deck_stylesheet exceeds the 24576-byte limit")
        elif stylesheet:
            raise ValueError("deck_stylesheet cannot be combined with legacy html_source")
        total_bytes = _utf8_size(stylesheet)
        for slide in self.slides:
            total_bytes += _utf8_size(slide.html_body)
            total_bytes += _utf8_size(slide.slide_css)
            total_bytes += _utf8_size(slide.html_source)
        if total_bytes > _MAX_AUTHORING_PAYLOAD_BYTES:
            raise ValueError("deck authoring payload exceeds the 131072-byte limit")
        if self.authoring_contract == "compact_model_html_v2":
            self._validate_v2_authoring_profile(stylesheet)
        return self

    def _validate_v2_authoring_profile(self, stylesheet: str) -> None:
        if _utf8_size(stylesheet) > _V2_MAX_DECK_STYLESHEET_BYTES:
            raise ValueError("deck_stylesheet exceeds the compact-v2 8192-byte limit")
        body_sizes: list[int] = []
        for index, slide in enumerate(self.slides):
            anchor_ids = slide.repair_anchor_ids
            if len(anchor_ids) != 2:
                raise ValueError(
                    f"slides[{index}].repair_anchor_ids must contain exactly two short HTML ids"
                )
            if len(set(anchor_ids)) != 2:
                raise ValueError(
                    f"slides[{index}].repair_anchor_ids must contain two distinct HTML ids"
                )
            if any(_REPAIR_ANCHOR_ID_RE.fullmatch(identifier) is None for identifier in anchor_ids):
                raise ValueError(
                    f"slides[{index}].repair_anchor_ids values must match [a-z][a-z0-9_-]{{0,31}}"
                )
            body_size = _utf8_size((slide.html_body or "").strip())
            body_sizes.append(body_size)
            if body_size > COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES:
                raise ValueError(
                    f"slides[{index}].html_body exceeds the compact-v2 hard "
                    f"{COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES}-byte limit"
                )
            if _utf8_size((slide.slide_css or "").strip()) > _V2_MAX_SLIDE_CSS_BYTES:
                raise ValueError(f"slides[{index}].slide_css exceeds the compact-v2 1024-byte limit")
        body_total = sum(body_sizes)
        body_budget = len(body_sizes) * COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES
        if body_total > body_budget:
            raise ValueError(
                f"slides.html_body_total is {body_total} bytes; compact-v2 aggregate budget is "
                f"{body_budget} bytes ({len(body_sizes)} slides x "
                f"{COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES} bytes)"
            )
        plan_json = json.dumps(self.creative_plan.model_dump(mode="json"), separators=(",", ":"), ensure_ascii=False)
        if _utf8_size(plan_json) > _V2_MAX_CREATIVE_PLAN_BYTES:
            raise ValueError("creative_plan exceeds the compact-v2 12288-byte limit")
        if _utf8_size(self.model_dump_json(exclude_none=True)) > _V2_MAX_AUTHORING_PAYLOAD_BYTES:
            raise ValueError("prepare_deck_build arguments exceed the compact-v2 49152-byte limit")


def _compact_v2_size_violations(value: Any) -> list[tuple[str, str]]:
    if not isinstance(value, dict) or value.get("authoring_contract") != "compact_model_html_v2":
        return []

    violations: list[tuple[str, str]] = []
    stylesheet = value.get("deck_stylesheet")
    if isinstance(stylesheet, str):
        size = _utf8_size(stylesheet.strip())
        if size > _V2_MAX_DECK_STYLESHEET_BYTES:
            violations.append(
                (
                    "deck_stylesheet",
                    f"deck_stylesheet is {size} bytes; compact-v2 limit is {_V2_MAX_DECK_STYLESHEET_BYTES} bytes",
                )
            )

    slides = value.get("slides")
    if isinstance(slides, str):
        try:
            slides = normalize_slides_value(slides)
        except (TypeError, ValueError):
            pass
    if isinstance(slides, list):
        body_sizes: list[int] = []
        valid_body_count = 0
        hard_reduction_bytes = 0
        for index, slide in enumerate(slides):
            html_body = slide.get("html_body") if isinstance(slide, dict) else None
            body_size = _utf8_size(html_body.strip()) if isinstance(html_body, str) else 0
            body_sizes.append(body_size)
            if body_size > 0:
                valid_body_count += 1
            if body_size > COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES:
                field = f"slides[{index}].html_body"
                target = _compact_slide_repair_target(index=index)
                hard_excess = body_size - COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES
                hard_reduction_bytes += hard_excess
                violations.append(
                    (
                        field,
                        f"{field} is {body_size} bytes; compact-v2 hard limit is "
                        f"{COMPACT_V2_MAX_SLIDE_HTML_BODY_BYTES} bytes; "
                        f"exact target: {target}; reduce by at least "
                        f"{hard_excess} bytes",
                    )
                )
            slide_css = slide.get("slide_css") if isinstance(slide, dict) else None
            if isinstance(slide_css, str):
                size = _utf8_size(slide_css.strip())
                if size > _V2_MAX_SLIDE_CSS_BYTES:
                    field = f"slides[{index}].slide_css"
                    target = _compact_slide_repair_target(index=index)
                    violations.append(
                        (
                            field,
                            f"{field} is {size} bytes; compact-v2 limit is {_V2_MAX_SLIDE_CSS_BYTES} bytes; "
                            f"exact target: {target}; reduce by at least "
                            f"{size - _V2_MAX_SLIDE_CSS_BYTES} bytes",
                        )
                    )
        body_total = sum(body_sizes)
        body_budget = valid_body_count * COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES
        remaining_aggregate_reduction = max(
            0,
            body_total - hard_reduction_bytes - body_budget,
        )
        if remaining_aggregate_reduction > 0:
            field = "slides.html_body_total"
            budget_label = (
                f"{valid_body_count} slides"
                if valid_body_count == len(slides)
                else f"{valid_body_count} valid slide bod{'y' if valid_body_count == 1 else 'ies'}"
            )
            reduction_label = (
                f"reduce by at least {remaining_aggregate_reduction} bytes"
                if hard_reduction_bytes == 0
                else (
                    "after the mandatory hard-limit repairs, reduce by at least "
                    f"{remaining_aggregate_reduction} additional bytes"
                )
            )
            violations.append(
                (
                    field,
                    f"{field} is {body_total} bytes; compact-v2 aggregate budget is {body_budget} bytes "
                    f"({budget_label} x {COMPACT_V2_TARGET_SLIDE_HTML_BODY_BYTES} bytes); "
                    f"{reduction_label}",
                )
            )

    creative_plan = value.get("creative_plan")
    if isinstance(creative_plan, dict):
        plan_for_size: Any = creative_plan
        try:
            plan_for_size = DeckCreativePlanInput.model_validate(creative_plan).model_dump(mode="json")
        except (TypeError, ValueError):
            pass
        size = _compact_json_size(plan_for_size)
        if size is not None and size > _V2_MAX_CREATIVE_PLAN_BYTES:
            violations.append(
                (
                    "creative_plan",
                    f"creative_plan is {size} bytes; compact-v2 limit is {_V2_MAX_CREATIVE_PLAN_BYTES} bytes",
                )
            )

    size = _compact_json_size(value)
    if size is not None and size > _V2_MAX_AUTHORING_PAYLOAD_BYTES:
        violations.append(
            (
                "prepare_deck_build arguments",
                f"prepare_deck_build arguments are {size} bytes; compact-v2 limit is {_V2_MAX_AUTHORING_PAYLOAD_BYTES} bytes",
            )
        )
    return violations


def _prepare_validation_location(value: object) -> str:
    parts: list[str] = []
    for segment in value if isinstance(value, (list, tuple)) else ():
        if isinstance(segment, int):
            if parts:
                parts[-1] = f"{parts[-1]}[{segment}]"
            else:
                parts.append(f"[{segment}]")
        else:
            parts.append(str(segment))
    return ".".join(parts) or "arguments"


def _duplicates_size_violation(*, location: str, message: str, size_fields: set[str]) -> bool:
    if not any(token in message for token in ("byte limit", "compact-v2", "exceeds")):
        return False
    combined = f"{location}: {message}"
    for field in size_fields:
        if field in combined:
            return True
        parent, _, leaf = field.rpartition(".")
        if location == parent and leaf in message:
            return True
    return False


def _bounded_prepare_validation_summary(
    errors: list[str],
    *,
    max_errors: int,
    max_chars: int,
) -> str:
    error_limit = max(1, max_errors)
    char_limit = max(64, max_chars)
    normalized = [" ".join(item.split()) for item in errors if item.strip()]
    selected: list[str] = []
    for item in normalized[:error_limit]:
        candidate = "; ".join([*selected, item])
        if len(candidate) > char_limit:
            break
        selected.append(item)

    omitted = len(normalized) - len(selected)
    if omitted:
        suffix = f"{omitted} additional validation error{'s' if omitted != 1 else ''} omitted"
        while selected and len("; ".join([*selected, suffix])) > char_limit:
            selected.pop()
            omitted += 1
            suffix = f"{omitted} additional validation errors omitted"
        if len(suffix) <= char_limit:
            selected.append(suffix)
    return "; ".join(selected)


def prepare_deck_build_validation_summary(
    value: Any,
    *,
    max_errors: int = _MAX_PREPARE_VALIDATION_ERRORS,
    max_chars: int = _MAX_PREPARE_VALIDATION_SUMMARY_CHARS,
) -> str:
    """Return bounded, input-safe repair targets for invalid deck arguments."""

    size_violations = _compact_v2_size_violations(value)
    errors = [message for _, message in size_violations]
    size_fields = {field for field, _ in size_violations}
    try:
        PrepareDeckBuildInput.model_validate(value)
    except Exception as exc:  # Pydantic exposes safe structured errors below.
        errors_method = getattr(exc, "errors", None)
        if callable(errors_method):
            try:
                validation_errors = errors_method(
                    include_url=False,
                    include_context=False,
                    include_input=False,
                )
            except Exception:
                validation_errors = []
            for item in validation_errors:
                if not isinstance(item, dict):
                    continue
                location = _prepare_validation_location(item.get("loc"))
                message = str(item.get("msg") or "invalid value").strip()
                if _duplicates_size_violation(
                    location=location,
                    message=message,
                    size_fields=size_fields,
                ):
                    continue
                errors.append(f"{location}: {message}")
    return _bounded_prepare_validation_summary(
        errors,
        max_errors=max_errors,
        max_chars=max_chars,
    )
