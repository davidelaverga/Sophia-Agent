from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

SubstrateVerdict = Literal[
    "native",
    "native_with_full_bleed_warning",
    "screenshot_substrate_forbidden",
    "native_editability_failed",
    "native_text_missing",
]


@dataclass(frozen=True)
class NativeDeckSubstrateVerdict:
    passed: bool
    verdict: SubstrateVerdict
    hard_failure_code: str | None = None
    hard_failure_summary: str | None = None
    warnings: list[str] = field(default_factory=list)


def classify_native_deck_substrate(
    *,
    slide_count: int,
    native_editability_score: float | None,
    native_text_shape_count: int,
    picture_shape_count: int,
    full_slide_picture_count: int,
    native_shape_inventory: dict[str, Any] | None = None,
) -> NativeDeckSubstrateVerdict:
    """Decide whether native deck geometry is an editable deck or a screenshot deck."""
    score = float(native_editability_score or 0.0)
    slide_total = max(0, int(slide_count or 0))
    native_text_total = max(0, int(native_text_shape_count or 0))
    picture_total = max(0, int(picture_shape_count or 0))
    full_slide_total = max(0, int(full_slide_picture_count or 0))

    if _looks_like_screenshot_substrate(
        slide_count=slide_total,
        native_text_shape_count=native_text_total,
        picture_shape_count=picture_total,
        full_slide_picture_count=full_slide_total,
        native_shape_inventory=native_shape_inventory,
    ):
        return NativeDeckSubstrateVerdict(
            passed=False,
            verdict="screenshot_substrate_forbidden",
            hard_failure_code="deck_screenshot_substrate_forbidden",
            hard_failure_summary="Native deck output is structurally a screenshot-backed deck.",
        )
    if score < 0.60:
        return NativeDeckSubstrateVerdict(
            passed=False,
            verdict="native_editability_failed",
            hard_failure_code="deck_native_editability_failed",
            hard_failure_summary=f"Native editability score {score:.2f} is below the required threshold.",
        )
    if native_text_total <= 0:
        return NativeDeckSubstrateVerdict(
            passed=False,
            verdict="native_text_missing",
            hard_failure_code="deck_native_text_missing",
            hard_failure_summary="Native deck output contains no editable text shapes.",
        )
    if full_slide_total > 0:
        return NativeDeckSubstrateVerdict(
            passed=True,
            verdict="native_with_full_bleed_warning",
            warnings=["native_full_bleed_picture_present"],
        )
    return NativeDeckSubstrateVerdict(passed=True, verdict="native")


def _looks_like_screenshot_substrate(
    *,
    slide_count: int,
    native_text_shape_count: int,
    picture_shape_count: int,
    full_slide_picture_count: int,
    native_shape_inventory: dict[str, Any] | None,
) -> bool:
    if slide_count <= 0:
        return False
    if native_text_shape_count > 0:
        return False
    if full_slide_picture_count >= slide_count:
        return True
    if picture_shape_count == slide_count and full_slide_picture_count == slide_count:
        return True
    return _every_slide_inventory_is_single_full_slide_picture(
        native_shape_inventory,
        expected_slide_count=slide_count,
    )


def _every_slide_inventory_is_single_full_slide_picture(
    inventory: dict[str, Any] | None,
    *,
    expected_slide_count: int,
) -> bool:
    if not isinstance(inventory, dict) or not inventory:
        return False
    slide_entries = [
        value
        for key, value in sorted(inventory.items())
        if str(key).startswith("slide:") and isinstance(value, dict)
    ]
    if len(slide_entries) < expected_slide_count:
        return False
    for slide in slide_entries[:expected_slide_count]:
        if slide.get("title") or slide.get("body"):
            return False
        shapes = slide.get("shapes")
        if not isinstance(shapes, list) or len(shapes) != 1:
            return False
        shape = shapes[0]
        if not isinstance(shape, dict):
            return False
        if str(shape.get("type") or "") != "PICTURE":
            return False
        if shape.get("full_slide") is not True:
            return False
    return True
