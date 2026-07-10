"""Model-facing typed contract for the fresh-deck build tool."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field, model_validator

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
    slide_compositions: list[DeckSlideCompositionInput] = Field(
        description="Exactly one canonical composition record for every slide."
    )
    skill_refs: list[str] = Field(
        min_length=1,
        description="Design guidance used; must include hands-on-deck/designing-slides.",
    )
    plan_critique: DeckPlanCritiqueInput
    anti_slop_commitments: list[str] = Field(default_factory=list)


class DeckSlideInput(BaseModel):
    title: str = Field(min_length=1, max_length=90)
    narrative: str = Field(min_length=1, max_length=280)
    role: str = Field(default="content")
    layout_kind: str = Field(default="single_visual_focus")
    html_source: str = Field(min_length=1, description="Complete 1920x1080 compiler-supported slide HTML.")
    speaker_notes: str | None = None
    claim: str | None = None
    visual_prompt: str | None = None


NormalizedDeckSlides = Annotated[list[DeckSlideInput], BeforeValidator(normalize_slides_value)]
NormalizedDeckCreativePlan = Annotated[
    DeckCreativePlanInput,
    BeforeValidator(normalize_creative_plan_value),
]


class PrepareDeckBuildInput(BaseModel):
    deck_title: str
    slides: NormalizedDeckSlides
    output_path: str
    creative_plan: NormalizedDeckCreativePlan
    register: str = "professional_technical"
    visual_policy: str = "auto"
    style_profile: dict[str, Any] | None = None
    design_plan: dict[str, Any] | None = None
