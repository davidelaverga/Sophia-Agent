from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

DeckVisualPolicy = Literal["required", "text_only"]
DeckRegister = Literal["professional_technical", "executive", "expressive", "reflective", "utility"]
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
class DeckSlideSpec:
    selector: str
    index: int
    role: str
    layout_kind: str
    title: str
    narrative: str
    visual_prompt: str | None = None
    speaker_notes: str | None = None
    visual_required: bool = True
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
    deck_route: str = "deck_ir_html_raster"
    deck_compile_mode: str = "not_compiled"
    native_required: bool = True
    legacy_screenshot_debug: bool = False
    native_editability_score: float | None = 0.0
    native_text_shape_count: int = 0
    picture_shape_count: int = 0
    full_slide_picture_count: int = 0
    native_shape_inventory: dict[str, Any] = field(default_factory=dict)
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
    deck_route: str = "deck_ir_html_raster"
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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
