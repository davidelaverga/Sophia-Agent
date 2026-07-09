from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

DeckVisualPolicy = Literal["auto", "required", "text_only", "auto_with_images_allowed"]
DeckRegister = Literal["professional_technical", "executive", "expressive", "reflective", "utility"]
DeckVisualMode = Literal["native_html", "generated_asset", "hybrid", "text_only"]
DeckCreativeStrategy = Literal[
    "hero_only",
    "sparse_signature",
    "image_led",
    "diagram_native",
    "hybrid",
]
GeneratedAssetIntegration = Literal[
    "full_bleed_background",
    "inset_illustration",
    "masked_panel",
    "texture_layer",
    "subject_photo",
    "none",
]
DeckAssetRole = Literal[
    "none",
    "hero_background",
    "section_texture",
    "inset_illustration",
    "subject_photo",
    "conceptual_metaphor",
    "supporting_texture",
]
DeckImageFit = Literal["none", "contain", "cover", "crop_safe_cover", "full_bleed"]
SlideRole = Literal[
    "cover",
    "problem",
    "context",
    "architecture",
    "process",
    "comparison",
    "evidence",
    "timeline",
    "closing",
]
SlideLayoutKind = Literal[
    "cover_hero",
    "single_visual_focus",
    "visual_left_text_right",
    "text_left_visual_right",
    "comparison_two_column",
    "timeline_flow",
    "closing_summary",
]
DeckBuildStatus = Literal[
    "planned",
    "visual_specs_ready",
    "visual_batch_running",
    "visuals_complete",
    "slides_rendered",
    "compiled",
    "evaluated",
    "emitted",
    "failed_terminal",
]


@dataclass
class DeckColorToken:
    name: str
    hex: str
    role: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckTypographyPlan:
    display: str
    body: str
    utility: str | None = None
    display_weight: int = 720
    body_weight: int = 420

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckGridPlan:
    slide_width_px: int = 1920
    slide_height_px: int = 1080
    margin_x_px: int = 120
    margin_y_px: int = 80
    title_y_px: int = 82
    footer_policy: str = "none"
    eyebrow_policy: str = "only_when_meaningful"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckDesignPlan:
    source: str
    subject: str
    audience: str
    goal: str
    style_lane: str
    palette: list[DeckColorToken]
    typography: DeckTypographyPlan
    grid: DeckGridPlan
    signature: str
    rhythm: str
    anti_slop_profile: list[str] = field(default_factory=list)
    requested_style_terms: list[str] = field(default_factory=list)
    normalized_from_style_profile: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckImageAssetPlan:
    asset_id: str
    slide_selector: str
    role: str
    reason: str
    prompt: str
    aspect_ratio: str = "16:9"
    integration: str = "inset_illustration"
    no_baked_text: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckSlideCompositionPlan:
    selector: str
    slide_role: str
    headline_intent: str
    layout_name: str
    composition_rationale: str
    native_elements: list[str]
    image_asset_ids: list[str]
    risk_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckCreativePlan:
    subject: str
    audience: str
    goal: str
    story_arc: str
    design_plan: DeckDesignPlan
    image_strategy: str
    image_assets: list[DeckImageAssetPlan]
    slide_compositions: list[DeckSlideCompositionPlan]
    anti_slop_commitments: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckAssetPlan:
    visual_mode: str
    image_gen_required: bool
    asset_role: str = "none"
    fit: str = "none"
    aspect_ratio: str | None = None
    allow_full_bleed: bool = False
    prompt: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckCompositionSpec:
    layout_family: str
    title_slot: dict[str, Any] = field(default_factory=dict)
    narrative_slot: dict[str, Any] = field(default_factory=dict)
    visual_slot: dict[str, Any] = field(default_factory=dict)
    support_slots: list[dict[str, Any]] = field(default_factory=list)
    max_words: int = 48
    min_title_px: int = 40
    min_body_px: int = 18

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckSlideSpec:
    selector: str
    index: int
    role: str
    layout_kind: str
    title: str
    narrative: str
    claim: str | None = None
    visual_prompt: str | None = None
    html_source: str | None = None
    speaker_notes: str | None = None
    visual_required: bool = True
    asset_plan: DeckAssetPlan | None = None
    composition: DeckCompositionSpec | None = None
    composition_plan: DeckSlideCompositionPlan | dict[str, Any] | None = None
    visual_prompt_path: str | None = None
    visual_asset_path: str | None = None
    visual_status: str = "pending"
    visual_error_class: str | None = None
    html_source_path: str | None = None
    gate_results: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckBuild:
    build_id: str
    schema_version: str
    user_id: str | None
    thread_id: str
    parent_thread_id: str | None
    run_id: str | None
    task_id: str | None
    requested_slide_count: int
    status: str
    register: str
    visual_policy: str
    style_profile: dict[str, Any]
    deck_title: str
    output_path: str
    slides: list[DeckSlideSpec]
    expected_visual_count: int
    design_plan: DeckDesignPlan | dict[str, Any] | None = None
    creative_plan: DeckCreativePlan | dict[str, Any] | None = None
    creative_plan_path: str | None = None
    design_plan_path: str | None = None
    asset_policy_path: str | None = None
    html_source_validation: dict[str, Any] = field(default_factory=dict)
    mechanical_gate_results: dict[str, Any] = field(default_factory=dict)
    style_warnings: list[str] = field(default_factory=list)
    generated_asset_count: int = 0
    native_html_slide_count: int = 0
    hybrid_slide_count: int = 0
    text_only_slide_count: int = 0
    deck_route: str = "deck_creative_html_native"
    deck_compile_mode: str = "not_compiled"
    native_required: bool = True
    legacy_screenshot_debug: bool = False
    native_editability_score: float | None = 0.0
    native_text_shape_count: int = 0
    picture_shape_count: int = 0
    full_slide_picture_count: int = 0
    native_shape_inventory: dict[str, Any] = field(default_factory=dict)
    native_mechanical_report: dict[str, Any] = field(default_factory=dict)
    successful_visual_count: int = 0
    referenced_visual_count: int = 0
    missing_visual_count: int = 0
    pptx_path: str | None = None
    preview_pdf_path: str | None = None
    compile_overflow_slides: list[dict[str, Any]] = field(default_factory=list)
    quality_warning: str | None = None
    failure_code: str | None = None
    failure_summary: str | None = None
    image_generation_status: str | None = None
    image_generation_reason: str | None = None
    primary_image_batch_status: str | None = None
    primary_image_batch_error_class: str | None = None
    serial_repair_count: int = 0
    batch_timeout_count: int = 0
    partial_batch_salvaged: bool = False
    langsmith_trace_ids: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["slides"] = [slide.to_dict() for slide in self.slides]
        return payload


@dataclass
class DeckQualityIssue:
    id: str
    severity: str
    selector: str
    check: str
    detail: str
    repair_hint: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeckEvaluation:
    passed: bool
    hard_failures: list[DeckQualityIssue] = field(default_factory=list)
    soft_warnings: list[DeckQualityIssue] = field(default_factory=list)
    quality_warning: str | None = None
    langsmith_feedback: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "hard_failures": [issue.to_dict() for issue in self.hard_failures],
            "soft_warnings": [issue.to_dict() for issue in self.soft_warnings],
            "quality_warning": self.quality_warning,
            "langsmith_feedback": self.langsmith_feedback,
        }


@dataclass
class DeckBuildResult:
    success: bool
    build_id: str
    deck_build_path: str
    pptx_path: str | None = None
    deck_route: str = "deck_creative_html_native"
    deck_compile_mode: str = "not_compiled"
    native_required: bool = True
    legacy_screenshot_debug: bool = False
    native_editability_score: float | None = 0.0
    native_text_shape_count: int = 0
    picture_shape_count: int = 0
    full_slide_picture_count: int = 0
    slide_count: int = 0
    expected_visual_count: int = 0
    successful_visual_count: int = 0
    referenced_visual_count: int = 0
    missing_visual_count: int = 0
    creative_plan_path: str | None = None
    design_plan_path: str | None = None
    asset_policy_path: str | None = None
    html_source_validation: dict[str, Any] = field(default_factory=dict)
    mechanical_gate_results: dict[str, Any] = field(default_factory=dict)
    style_warnings: list[str] = field(default_factory=list)
    generated_asset_count: int = 0
    native_html_slide_count: int = 0
    hybrid_slide_count: int = 0
    text_only_slide_count: int = 0
    quality_status: str = "failed"
    quality_warning: str | None = None
    warnings: list[str] = field(default_factory=list)
    failure_code: str | None = None
    failure_summary: str | None = None
    retryable: bool = False
    image_generation_status: str | None = None
    image_generation_reason: str | None = None
    primary_image_batch_status: str | None = None
    primary_image_batch_error_class: str | None = None
    serial_repair_count: int = 0
    batch_timeout_count: int = 0
    partial_batch_salvaged: bool = False
    native_mechanical_report: dict[str, Any] = field(default_factory=dict)
    repair_instruction: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
