from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class DeckIRValidationError:
    slide_index: int | None
    field: str | None
    code: str
    summary: str
    retryable: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class DeckIRRepairInstruction:
    should_retry: bool
    repair_message: str
    max_retry_count: int = 1
    validation_error: DeckIRValidationError | None = None

    def to_dict(self) -> dict:
        payload = asdict(self)
        if self.validation_error is not None:
            payload["validation_error"] = self.validation_error.to_dict()
        return payload


_SLIDE_FIELD_RE = re.compile(r"\bSlide\s+(?P<slide>\d+)\s+(?P<field>[A-Za-z_][\w-]*)\b")
_HEX_COLOR_RE = re.compile(r"^#?(?P<hex>[0-9A-Fa-f]{6})$")
_MAX_MECHANICAL_REPAIR_TARGETS = 24


def deck_ir_repair_instruction_from_failure(
    *,
    failure_code: str,
    failure_summary: str,
    retryable: bool,
    attempt_count: int,
) -> DeckIRRepairInstruction:
    validation_error = _validation_error_from_failure(
        failure_code=failure_code,
        failure_summary=failure_summary,
        retryable=retryable,
    )
    if failure_code != "invalid_deck_ir" or not retryable or attempt_count >= 1:
        return DeckIRRepairInstruction(
            should_retry=False,
            repair_message="",
            validation_error=validation_error,
        )
    field_phrase = _field_phrase(validation_error)
    return DeckIRRepairInstruction(
        should_retry=True,
        repair_message=(
            "Repair the Deck IR and call prepare_deck_build exactly once more. "
            f"{field_phrase}{failure_summary.strip()} Keep the same deck title, output path, "
            "register, and visual policy. Do not end the build until this single repair retry is attempted."
        ),
        validation_error=validation_error,
    )


def _validation_error_from_failure(
    *,
    failure_code: str,
    failure_summary: str,
    retryable: bool,
) -> DeckIRValidationError:
    match = _SLIDE_FIELD_RE.search(failure_summary or "")
    slide_index = int(match.group("slide")) if match else None
    field = match.group("field") if match else None
    return DeckIRValidationError(
        slide_index=slide_index,
        field=field,
        code=failure_code,
        summary=failure_summary,
        retryable=retryable,
    )


def _field_phrase(error: DeckIRValidationError) -> str:
    if error.slide_index is None or not error.field:
        return ""
    return f"Slide {error.slide_index} has an invalid {error.field}: "


def deck_mechanical_repair_instruction_from_reports(
    *,
    native_contrast_report: dict[str, Any] | None,
    source_element_map: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Build a bounded, exact repair instruction for deterministic contrast failures.

    The native report is intentionally richer than the mechanical gate summary.  Use
    it to put the affected slide, source element, text, and computed colors directly
    in the one-retry prompt instead of asking the authoring model to rediscover them
    in a large tool result.
    """

    report = native_contrast_report if isinstance(native_contrast_report, dict) else {}
    issues = [
        item
        for item in report.get("issues") or []
        if isinstance(item, dict) and item.get("required_semantic")
    ]
    if not issues:
        return None

    targets = [
        _contrast_repair_target(item, source_element_map)
        for item in issues[:_MAX_MECHANICAL_REPAIR_TARGETS]
    ]
    omitted_count = max(0, len(issues) - len(targets))
    lines = [_contrast_repair_line(index, target) for index, target in enumerate(targets, start=1)]
    if omitted_count:
        lines.append(
            f"{omitted_count} additional required contrast failures remain in native_contrast_report; "
            "apply the same explicit-color repair to every remaining required issue before retrying."
        )
    return {
        "repair_target_count": len(issues),
        "included_repair_target_count": len(targets),
        "omitted_repair_target_count": omitted_count,
        "repair_targets": targets,
        "repair_message": (
            "Repair every deterministic contrast target below in the existing slide html_body or shared "
            "deck_stylesheet. Preserve the approved deck structure, copy, and passing slides. On the exact "
            "text-bearing element, set an explicit compiler-supported CSS color and an opaque background; "
            "do not rely on inherited or transparent colors, and do not change font size or weight merely to "
            "lower the required ratio. The safe foreground shown for each target is guaranteed to exceed its "
            "required ratio on the shown background. Fix all targets, then call prepare_deck_build exactly once "
            "more with the complete deck input.\n"
            + "\n".join(lines)
        ),
    }


def _contrast_repair_target(
    issue: dict[str, Any],
    source_element_map: dict[str, Any] | None,
) -> dict[str, Any]:
    selector = str(issue.get("selector") or "deck")
    shape_name = str(issue.get("shape_name") or "")
    background = _css_hex(issue.get("background")) or "#FFFFFF"
    recommended_foreground, recommended_ratio = _highest_contrast_foreground(background)
    return {
        "code": "native_text_contrast_indeterminate" if issue.get("indeterminate") else "native_text_contrast_failed",
        "selector": selector,
        "shape_name": shape_name,
        "source_ids": _source_ids_for_shape(
            source_element_map=source_element_map,
            selector=selector,
            shape_name=shape_name,
        ),
        "text_excerpt": _compact_excerpt(issue.get("text_excerpt")),
        "foreground": _css_hex(issue.get("foreground")),
        "background": _css_hex(issue.get("background")),
        "contrast_ratio": issue.get("contrast_ratio"),
        "required_ratio": issue.get("required_ratio"),
        "indeterminate": bool(issue.get("indeterminate")),
        "recommended_foreground": recommended_foreground,
        "recommended_background": background,
        "recommended_contrast_ratio": recommended_ratio,
    }


def _contrast_repair_line(index: int, target: dict[str, Any]) -> str:
    source_ids = target.get("source_ids") or []
    source = (
        " data-deck-id=" + ",".join(json.dumps(source_id, ensure_ascii=False) for source_id in source_ids)
        if source_ids
        else ""
    )
    text = json.dumps(target.get("text_excerpt") or "", ensure_ascii=False)
    current_foreground = target.get("foreground") or "indeterminate foreground"
    current_background = target.get("background") or "indeterminate background"
    actual_ratio = target.get("contrast_ratio")
    actual = "indeterminate" if actual_ratio is None else str(actual_ratio)
    return (
        f"{index}. {target['selector']}{source}, text {text}, native shape {target['shape_name'] or 'unknown'}: "
        f"{current_foreground} on {current_background} has ratio {actual}, requires >= {target.get('required_ratio')}. "
        f"Safe direct fix: {target['recommended_foreground']} text on {target['recommended_background']} "
        f"(ratio {target['recommended_contrast_ratio']})."
    )


def _source_ids_for_shape(
    *,
    source_element_map: dict[str, Any] | None,
    selector: str,
    shape_name: str,
) -> list[str]:
    slides = source_element_map.get("slides") if isinstance(source_element_map, dict) else None
    slide = slides.get(selector) if isinstance(slides, dict) else None
    elements = slide.get("elements") if isinstance(slide, dict) else None
    if not isinstance(elements, dict) or not shape_name:
        return []
    return sorted(
        str(source_id)
        for source_id, record in elements.items()
        if isinstance(record, dict) and shape_name in {str(name) for name in record.get("shape_names") or []}
    )


def _compact_excerpt(value: Any, *, limit: int = 120) -> str:
    return " ".join(str(value or "").split())[:limit]


def _css_hex(value: Any) -> str | None:
    match = _HEX_COLOR_RE.fullmatch(str(value or "").strip())
    return f"#{match.group('hex').upper()}" if match else None


def _highest_contrast_foreground(background: str) -> tuple[str, float]:
    choices = ("#000000", "#FFFFFF")
    foreground = max(choices, key=lambda color: _contrast_ratio(color, background))
    return foreground, round(_contrast_ratio(foreground, background), 3)


def _contrast_ratio(foreground: str, background: str) -> float:
    first = _relative_luminance(foreground)
    second = _relative_luminance(background)
    high, low = max(first, second), min(first, second)
    return (high + 0.05) / (low + 0.05)


def _relative_luminance(value: str) -> float:
    raw = value.removeprefix("#")
    channels = [int(raw[index : index + 2], 16) / 255 for index in (0, 2, 4)]
    linear = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
