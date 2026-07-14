from __future__ import annotations

import json
import math
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
_OVERLAP_PAIR_RE = re.compile(r"\boverlaps\s+(?P<other>[^\s,;:]+)", re.I)
_MAX_MECHANICAL_REPAIR_TARGETS = 24
_MAX_MECHANICAL_REPAIR_MESSAGE_BYTES = 8 * 1024
_MATERIAL_OVERLAP_MIN_AREA = 0.08
_MECHANICAL_REPAIR_PREAMBLE = (
    "Repair every listed mechanical issue in the existing slide HTML/CSS; preserve copy, structure, "
    "and passing slides. CONTRAST: use the supplied explicit safe colors. OVERLAP: change source "
    "geometry; move hints are directional, not literal coordinates. Then call prepare_deck_build once "
    "with the complete prior input."
)


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
    native_mechanical_report: dict[str, Any] | None = None,
    mechanical_gate_results: dict[str, Any] | None = None,
    native_shape_inventory: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Build one bounded repair instruction from deterministic mechanical reports.

    Native contrast and lint reports are intentionally richer than the mechanical
    gate summary.  Preserve exact contrast colors and exact overlap geometry in the
    one-retry prompt, while retaining unrelated mechanical gate issues.
    """

    report = native_contrast_report if isinstance(native_contrast_report, dict) else {}
    contrast_issues = [
        item
        for item in report.get("issues") or []
        if isinstance(item, dict) and item.get("required_semantic")
    ]
    contrast_targets = [_contrast_repair_target(item, source_element_map) for item in contrast_issues]
    overlap_targets = _overlap_repair_targets(
        native_mechanical_report=native_mechanical_report,
        mechanical_gate_results=mechanical_gate_results,
        source_element_map=source_element_map,
        native_shape_inventory=native_shape_inventory,
    )
    generic_targets = _generic_mechanical_repair_targets(
        mechanical_gate_results=mechanical_gate_results,
        has_contrast_targets=bool(contrast_targets),
        overlap_target_selectors={str(target.get("selector") or "") for target in overlap_targets},
    )
    all_targets = [*contrast_targets, *overlap_targets, *generic_targets]
    if not all_targets:
        return None

    targets = _bounded_mechanical_targets(contrast_targets, overlap_targets, generic_targets)
    targets, repair_message = _fit_mechanical_repair_message(
        targets=targets,
        total_target_count=len(all_targets),
    )
    omitted_count = max(0, len(all_targets) - len(targets))
    included_by_type = _target_type_counts(targets)
    return {
        "repair_target_count": len(all_targets),
        "included_repair_target_count": len(targets),
        "omitted_repair_target_count": omitted_count,
        "contrast_repair_target_count": len(contrast_targets),
        "overlap_repair_target_count": len(overlap_targets),
        "generic_repair_target_count": len(generic_targets),
        "included_contrast_repair_target_count": included_by_type.get("contrast", 0),
        "included_overlap_repair_target_count": included_by_type.get("overlap", 0),
        "included_generic_repair_target_count": included_by_type.get("generic", 0),
        "repair_targets": targets,
        "repair_message": repair_message,
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
        "target_type": "contrast",
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


def _overlap_repair_targets(
    *,
    native_mechanical_report: dict[str, Any] | None,
    mechanical_gate_results: dict[str, Any] | None,
    source_element_map: dict[str, Any] | None,
    native_shape_inventory: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    report = native_mechanical_report if isinstance(native_mechanical_report, dict) else {}
    residues = report.get("lint_residue") if isinstance(report.get("lint_residue"), list) else []
    severe_selectors = {
        str(item.get("selector") or "")
        for item in _mechanical_gate_issues(mechanical_gate_results)
        if str(item.get("code") or "") == "native_lint_severe_overlap"
    }
    targets: list[dict[str, Any]] = []
    for item in residues:
        if not isinstance(item, dict) or str(item.get("kind") or "") != "overlap":
            continue
        area = _finite_float(item.get("overlap_area"))
        selector = _selector_for_native_slide(item.get("slide"))
        if area is None or area < _MATERIAL_OVERLAP_MIN_AREA:
            continue
        if severe_selectors and selector not in severe_selectors:
            continue
        shape = _compact_excerpt(item.get("shape"), limit=80)
        issue = _compact_excerpt(item.get("issue"), limit=180)
        match = _OVERLAP_PAIR_RE.search(issue)
        other_shape = _compact_excerpt(match.group("other") if match else "", limit=80).rstrip(".)]")
        pair = [name for name in (shape, other_shape) if name]
        pair_shapes: list[dict[str, Any]] = []
        for shape_id in pair:
            detail = _overlap_shape_target(
                shape_id=shape_id,
                selector=selector,
                native_shape_inventory=native_shape_inventory,
                source_element_map=source_element_map,
            )
            if detail is not None:
                pair_shapes.append(detail)
        source_ids = sorted({source_id for detail in pair_shapes for source_id in detail["source_ids"]})
        targets.append(
            {
                "target_type": "overlap",
                "code": "native_lint_severe_overlap",
                "selector": selector,
                "pair": pair,
                "pair_shapes": pair_shapes,
                "area": area,
                "suggest": _compact_excerpt(item.get("suggest"), limit=160),
                "issue": issue,
                "source_ids": source_ids,
            }
        )
    return targets


def _overlap_shape_target(
    *,
    shape_id: str,
    selector: str,
    native_shape_inventory: dict[str, Any] | None,
    source_element_map: dict[str, Any] | None,
) -> dict[str, Any] | None:
    record = _native_shape_record(
        native_shape_inventory=native_shape_inventory,
        selector=selector,
        shape_id=shape_id,
    )
    if not record:
        return None
    shape_name = _compact_excerpt(record.get("name"), limit=100)
    return {
        "id": shape_id,
        "name": shape_name,
        "source_ids": _source_ids_for_shape(
            source_element_map=source_element_map,
            selector=selector,
            shape_name=shape_name,
        ),
        "text_excerpt": _compact_excerpt(record.get("text_preview"), limit=120),
        "pos": _compact_geometry(record.get("pos")),
        "size": _compact_geometry(record.get("size")),
    }


def _native_shape_record(
    *,
    native_shape_inventory: dict[str, Any] | None,
    selector: str,
    shape_id: str,
) -> dict[str, Any]:
    inventory = native_shape_inventory if isinstance(native_shape_inventory, dict) else {}
    wrapped_slides = inventory.get("slides")
    if isinstance(wrapped_slides, dict):
        inventory = wrapped_slides
    slide = inventory.get(selector) if isinstance(inventory, dict) else None
    shapes = slide.get("shapes") if isinstance(slide, dict) else None
    for record in shapes if isinstance(shapes, list) else []:
        if isinstance(record, dict) and str(record.get("id") or "") == shape_id:
            return record
    return {}


def _compact_geometry(value: Any) -> list[float]:
    if not isinstance(value, (list, tuple)):
        return []
    result: list[float] = []
    for item in value[:2]:
        number = _finite_float(item)
        if number is not None:
            result.append(round(number, 3))
    return result


def _generic_mechanical_repair_targets(
    *,
    mechanical_gate_results: dict[str, Any] | None,
    has_contrast_targets: bool,
    overlap_target_selectors: set[str],
) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for item in _mechanical_gate_issues(mechanical_gate_results):
        code = _compact_excerpt(item.get("code"), limit=80)
        selector = _compact_excerpt(item.get("selector") or "deck", limit=80)
        if has_contrast_targets and code in {
            "native_text_contrast_failed",
            "native_text_contrast_indeterminate",
        }:
            continue
        if code == "native_lint_severe_overlap" and selector in overlap_target_selectors:
            continue
        summary = _compact_excerpt(item.get("summary"), limit=220)
        repair_hint = _compact_excerpt(item.get("repair_hint"), limit=220)
        key = (code, selector, summary, repair_hint)
        if key in seen:
            continue
        seen.add(key)
        targets.append(
            {
                "target_type": "generic",
                "code": code or "deck_mechanical_gate_failed",
                "selector": selector,
                "summary": summary,
                "repair_hint": repair_hint,
            }
        )
    return targets


def _mechanical_gate_issues(mechanical_gate_results: dict[str, Any] | None) -> list[dict[str, Any]]:
    report = mechanical_gate_results if isinstance(mechanical_gate_results, dict) else {}
    return [item for item in report.get("issues") or [] if isinstance(item, dict)]


def _bounded_mechanical_targets(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Round-robin categories so one noisy report cannot hide another category."""

    remaining = [list(group) for group in groups if group]
    targets: list[dict[str, Any]] = []
    while remaining and len(targets) < _MAX_MECHANICAL_REPAIR_TARGETS:
        next_remaining: list[list[dict[str, Any]]] = []
        for group in remaining:
            if len(targets) >= _MAX_MECHANICAL_REPAIR_TARGETS:
                break
            targets.append(group.pop(0))
            if group:
                next_remaining.append(group)
        remaining = next_remaining
    return targets


def _target_type_counts(targets: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for target in targets:
        target_type = str(target.get("target_type") or "generic")
        counts[target_type] = counts.get(target_type, 0) + 1
    return counts


def _fit_mechanical_repair_message(
    *,
    targets: list[dict[str, Any]],
    total_target_count: int,
) -> tuple[list[dict[str, Any]], str]:
    included = list(targets)
    while included:
        message = _mechanical_repair_message(included, total_target_count=total_target_count)
        if len(message.encode("utf-8")) <= _MAX_MECHANICAL_REPAIR_MESSAGE_BYTES:
            return included, message
        included.pop()
    return [], _mechanical_repair_message([], total_target_count=total_target_count)


def _mechanical_repair_message(
    targets: list[dict[str, Any]],
    *,
    total_target_count: int,
) -> str:
    lines = [_MECHANICAL_REPAIR_PREAMBLE]
    lines.extend(_mechanical_repair_line(index, target) for index, target in enumerate(targets, start=1))
    omitted_count = max(0, total_target_count - len(targets))
    if omitted_count:
        lines.append(
            f"{omitted_count} additional targets were omitted by the prompt bound; repair every remaining "
            "reported issue with the same source-local method."
        )
    return "\n".join(lines)


def _selector_for_native_slide(value: Any) -> str:
    try:
        return f"slide:{int(value or 0) + 1}"
    except (TypeError, ValueError):
        return "deck"


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _mechanical_repair_line(index: int, target: dict[str, Any]) -> str:
    target_type = str(target.get("target_type") or "generic")
    if target_type == "contrast":
        return _contrast_repair_line(index, target)
    if target_type == "overlap":
        return _overlap_repair_line(index, target)
    return _generic_repair_line(index, target)


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
        f"{index}. CONTRAST {target['selector']}{source}, text {text}, native "
        f"{target['shape_name'] or 'unknown'}: {current_foreground}/{current_background} ratio {actual}, "
        f"needs {target.get('required_ratio')}; set {target['recommended_foreground']}/"
        f"{target['recommended_background']} (ratio {target['recommended_contrast_ratio']})."
    )


def _overlap_repair_line(index: int, target: dict[str, Any]) -> str:
    pair = " / ".join(str(name) for name in target.get("pair") or []) or "unknown pair"
    suggestion = json.dumps(target.get("suggest") or "no producer suggestion", ensure_ascii=False)
    details = " vs ".join(
        _overlap_shape_detail(detail)
        for detail in target.get("pair_shapes") or []
        if isinstance(detail, dict)
    )
    pair_detail = details or pair
    return (
        f"{index}. OVERLAP {target.get('selector') or 'deck'} area {target.get('area')}: {pair_detail}; "
        f"hint {suggestion}. Separate in source CSS without deleting content."
    )


def _overlap_shape_detail(detail: dict[str, Any]) -> str:
    shape_id = str(detail.get("id") or "unknown")
    source_ids = detail.get("source_ids") or []
    source = (
        "/data-deck-id=" + ",".join(json.dumps(source_id, ensure_ascii=False) for source_id in source_ids)
        if source_ids
        else ""
    )
    text = json.dumps(detail.get("text_excerpt") or "", ensure_ascii=False)
    geometry = ""
    pos = detail.get("pos") or []
    size = detail.get("size") or []
    if pos or size:
        geometry = f" box={pos or '?'}+{size or '?'}"
    return f"{shape_id}{source} {text}{geometry}"


def _generic_repair_line(index: int, target: dict[str, Any]) -> str:
    summary = json.dumps(target.get("summary") or "Mechanical gate failed.", ensure_ascii=False)
    repair_hint = json.dumps(target.get("repair_hint") or "Repair the affected source element.", ensure_ascii=False)
    return (
        f"{index}. GATE {target.get('selector') or 'deck'} "
        f"[{target.get('code') or 'deck_mechanical_gate_failed'}]: {summary}; {repair_hint}."
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
