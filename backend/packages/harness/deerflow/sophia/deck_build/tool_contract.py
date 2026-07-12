"""Model-facing typed contract for the fresh-deck build tool."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator
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
    footer_policy: str = Field(default="none")
    eyebrow_policy: str = Field(default="only_when_meaningful")


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
_V2_MAX_SLIDE_HTML_BODY_BYTES = 3 * 1024
_V2_MAX_SLIDE_CSS_BYTES = 1 * 1024
_V2_MAX_CREATIVE_PLAN_BYTES = 12 * 1024
_V2_MAX_AUTHORING_PAYLOAD_BYTES = 48 * 1024
_DOCUMENT_FRAGMENT_TAGS = ("<html", "</html", "<head", "</head", "<body", "</body", "<style", "</style")


def _utf8_size(value: str | None) -> int:
    return len((value or "").encode("utf-8"))


def _compact_slide_json_schema(schema: dict[str, Any]) -> None:
    required = schema.setdefault("required", [])
    if "html_body" not in required:
        required.append("html_body")
    body_schema = schema.get("properties", {}).get("html_body")
    if isinstance(body_schema, dict):
        body_schema.pop("default", None)
        _set_string_max_length(body_schema, _V2_MAX_SLIDE_HTML_BODY_BYTES)
    slide_css_schema = schema.get("properties", {}).get("slide_css")
    if isinstance(slide_css_schema, dict):
        _set_string_max_length(slide_css_schema, _V2_MAX_SLIDE_CSS_BYTES)


def _compact_prepare_json_schema(schema: dict[str, Any]) -> None:
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
        description=("Compiler-supported markup inside the slide canvas. Do not include html, head, body, or style tags."),
    )
    slide_css: str | None = Field(
        default=None,
        description="Optional CSS used only by this slide; shared rules belong in deck_stylesheet.",
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
    model_config = ConfigDict(json_schema_extra=_compact_prepare_json_schema)
    deck_title: str
    slides: NormalizedDeckSlides
    output_path: str
    creative_plan: NormalizedDeckCreativePlan
    authoring_contract: Literal["compact_model_html_v1", "compact_model_html_v2"] | None = Field(
        default=None,
        description=(
            "New builder calls must use compact_model_html_v2. Omitted and v1 values remain accepted only for queued/internal compatibility."
        ),
    )
    deck_stylesheet: str | None = Field(
        default=None,
        description=("Shared compiler-supported CSS for every slide. It must style the main 1920x1080 canvas with an opaque background."),
    )
    register: str = "professional_technical"
    visual_policy: str = "auto"
    style_profile: dict[str, Any] | None = None
    design_plan: dict[str, Any] | None = None

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
        for index, slide in enumerate(self.slides):
            if _utf8_size(slide.html_body) > _V2_MAX_SLIDE_HTML_BODY_BYTES:
                raise ValueError(f"slides[{index}].html_body exceeds the compact-v2 3072-byte limit")
            if _utf8_size(slide.slide_css) > _V2_MAX_SLIDE_CSS_BYTES:
                raise ValueError(f"slides[{index}].slide_css exceeds the compact-v2 1024-byte limit")
        plan_json = json.dumps(self.creative_plan.model_dump(mode="json"), separators=(",", ":"), ensure_ascii=False)
        if _utf8_size(plan_json) > _V2_MAX_CREATIVE_PLAN_BYTES:
            raise ValueError("creative_plan exceeds the compact-v2 12288-byte limit")
        if _utf8_size(self.model_dump_json(exclude_none=True)) > _V2_MAX_AUTHORING_PAYLOAD_BYTES:
            raise ValueError("prepare_deck_build arguments exceed the compact-v2 49152-byte limit")
