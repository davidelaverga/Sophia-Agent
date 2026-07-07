from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class NativeDeckInspectResult:
    success: bool
    slide_count: int
    shape_count: int
    native_text_shape_count: int
    picture_shape_count: int
    full_slide_picture_count: int
    native_editability_score: float
    shape_inventory_path: str | None
    raw_json_path: str | None
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NativeDeckPatchResult:
    success: bool
    output_pptx_path: str | None
    patch_path: str | None
    patch_op_count: int
    validation_error_count: int
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NativeDeckRenderResult:
    success: bool
    render_dir: str | None
    rendered_slide_count: int
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NativeDeckLintFixResult:
    success: bool
    lint_issue_count_before: int
    fix_applied_count: int
    residue_count: int
    touched_slide_count: int
    residue: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
