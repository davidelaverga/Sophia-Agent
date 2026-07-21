from __future__ import annotations

import json
import math
import re
from collections import Counter
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
_OVERLAP_MOVE_DELTA_RE = re.compile(
    r"\bmove\s+(?P<shape>[^\s,;:]+)\s+by\s+\[\s*"
    r"(?P<dx>-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*"
    r"(?P<dy>-?(?:\d+(?:\.\d+)?|\.\d+))\s*\]",
    re.I,
)
_NATIVE_SHAPE_ID_RE = re.compile(r"\bs\d+(?:-\d+)?\b", re.I)
_ALIGNMENT_ROLE_RE = re.compile(
    r"\b(?P<role>left|right|top|bottom|hcenter|vcenter)\b",
    re.I,
)
_ALIGNMENT_GRIDLINE_RE = re.compile(
    r"\bgridline\s+(?P<gridline>-?(?:\d+(?:\.\d+)?|\.\d+))(?:(?:\")|(?:in\b))",
    re.I,
)
_TYPOGRAPHY_SUMMARY_RE = re.compile(
    r"^(?P<kind>Required/body|Compact) text '(?P<label>.+)' compiles at "
    r"(?P<actual_pt>[\d.]+)pt \((?P<actual_px>[\d.]+)px\), below the "
    r"(?P<minimum_pt>[\d.]+)pt \((?P<minimum_px>[\d.]+)px\) floor\.?$",
    re.I,
)
_TYPOGRAPHY_GATE_CODES = {
    "native_required_text_too_small",
    "native_compact_text_too_small",
}
_MAX_MECHANICAL_REPAIR_TARGETS = 24
_MAX_MECHANICAL_REPAIR_MESSAGE_BYTES = 8 * 1024
_MAX_TYPOGRAPHY_REPAIR_LINE_BYTES = 1024
_MAX_TYPOGRAPHY_SOURCE_IDS = 3
_MAX_TYPOGRAPHY_SOURCE_ID_BYTES = 72
_MATERIAL_OVERLAP_MIN_AREA = 0.08
_CSS_PX_PER_NATIVE_INCH = 96.0
_MECHANICAL_REPAIR_PREAMBLE = (
    "Repair every listed source-quality and mechanical issue in the complete prior input; preserve copy, "
    "structure, and unnamed slides. Edit exact named HTML/CSS, shared CSS, or creative_plan image prompt/asset "
    "record. TYPE includes visible descendants. ALIGN native "
    "gridline C_in to CSS px with Cpx=96*C_in; for source Wpx/Hpx: left-edge left=Cpx; "
    "right-edge left=Cpx-Wpx; hcenter left=Cpx-Wpx/2; top-edge top=Cpx; "
    "bottom-edge top=Cpx-Hpx; vcenter top=Cpx-Hpx/2. "
    "Use supplied contrast colors. Then call prepare_deck_build once with the complete prior input."
)
_OVERLAP_REPAIR_GUIDANCE = (
    "OVERLAP boxes/hints use native inches; CSS delta px=96*native delta in, including nested sources "
    "(never parent-subtract a delta). For a sized target with padding/border, set box-sizing:border-box "
    "on that exact source element only; never add a global or universal box-sizing reset."
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
    source_quality_report: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Build one bounded repair instruction from source and mechanical reports.

    Native contrast, lint, and shape reports are intentionally richer than the
    mechanical gate summary. Preserve exact colors and source-addressable geometry
    in the one-retry prompt, while retaining unrelated mechanical gate issues.
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
    overflow_targets = _overflow_repair_targets(
        native_mechanical_report=native_mechanical_report,
        mechanical_gate_results=mechanical_gate_results,
        source_element_map=source_element_map,
        native_shape_inventory=native_shape_inventory,
    )
    alignment_targets = _alignment_repair_targets(
        native_mechanical_report=native_mechanical_report,
        mechanical_gate_results=mechanical_gate_results,
        source_element_map=source_element_map,
        native_shape_inventory=native_shape_inventory,
    )
    generic_targets = _generic_mechanical_repair_targets(
        mechanical_gate_results=mechanical_gate_results,
        has_contrast_targets=bool(contrast_targets),
        overlap_target_selectors={str(target.get("selector") or "") for target in overlap_targets},
        overflow_target_selectors=_fully_addressed_overflow_selectors(
            overflow_targets=overflow_targets,
            mechanical_gate_results=mechanical_gate_results,
        ),
        alignment_target_selectors={str(target.get("selector") or "") for target in alignment_targets},
        source_element_map=source_element_map,
    )
    source_quality_targets, source_quality_issue_count = _source_quality_repair_targets(source_quality_report)
    all_targets = [
        *source_quality_targets,
        *contrast_targets,
        *overlap_targets,
        *overflow_targets,
        *alignment_targets,
        *generic_targets,
    ]
    if not all_targets:
        return None

    targets = _bounded_mechanical_targets(
        source_quality_targets,
        contrast_targets,
        overlap_targets,
        overflow_targets,
        alignment_targets,
        generic_targets,
    )
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
        "overflow_repair_target_count": len(overflow_targets),
        "alignment_repair_target_count": len(alignment_targets),
        "generic_repair_target_count": len(generic_targets),
        "source_quality_repair_target_count": len(source_quality_targets),
        "source_quality_issue_count": source_quality_issue_count,
        "included_contrast_repair_target_count": included_by_type.get("contrast", 0),
        "included_overlap_repair_target_count": included_by_type.get("overlap", 0),
        "included_overflow_repair_target_count": included_by_type.get("overflow", 0),
        "included_alignment_repair_target_count": included_by_type.get("alignment", 0),
        "included_generic_repair_target_count": included_by_type.get("generic", 0),
        "included_source_quality_repair_target_count": included_by_type.get("quality", 0),
        "repair_targets": targets,
        "repair_message": repair_message,
    }


def _source_quality_repair_targets(
    source_quality_report: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], int]:
    report = source_quality_report if isinstance(source_quality_report, dict) else {}
    grouped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    issue_count = 0
    for issue in report.get("hard_failures") or []:
        if not isinstance(issue, dict):
            continue
        issue_count += 1
        selector = _compact_excerpt(issue.get("selector") or "deck", limit=80)
        check = _compact_excerpt(issue.get("check") or "quality", limit=80)
        detail = _compact_excerpt(issue.get("detail") or "Deck source quality failed.", limit=320)
        code = _compact_excerpt(issue.get("id") or "deck_source_quality_failed", limit=100)
        repair_hint = _compact_excerpt(
            issue.get("repair_hint") or "Remove the prohibited source pattern from this slide.",
            limit=240,
        )
        key = (code, check, detail, repair_hint)
        target = grouped.setdefault(
            key,
            {
                "target_type": "quality",
                "code": code,
                "selector": "",
                "selectors": [],
                "check": check,
                "summary": detail,
                "repair_hint": repair_hint,
            },
        )
        if selector not in target["selectors"]:
            target["selectors"].append(selector)
    targets = list(grouped.values())
    for target in targets:
        target["selector"] = ", ".join(target["selectors"])
    return targets, issue_count


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
    seen_pairs: set[tuple[str, tuple[str, ...]]] = set()
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
        normalized_pair = tuple(sorted(name.casefold() for name in pair))
        pair_key = (selector, normalized_pair)
        if len(normalized_pair) > 1 and pair_key in seen_pairs:
            continue
        if len(normalized_pair) > 1:
            seen_pairs.add(pair_key)
        pair_shapes: list[dict[str, Any]] = []
        for shape_id in pair:
            detail = _overlap_shape_target(
                shape_id=shape_id,
                selector=selector,
                native_shape_inventory=native_shape_inventory,
                source_element_map=source_element_map,
                direct_source=True,
            )
            if detail is not None:
                pair_shapes.append(detail)
        source_ids = sorted({source_id for detail in pair_shapes for source_id in detail["source_ids"]})
        suggestion = _compact_excerpt(item.get("suggest"), limit=160)
        suggested_move = _overlap_suggested_move(suggestion)
        targets.append(
            {
                "target_type": "overlap",
                "code": "native_lint_severe_overlap",
                "selector": selector,
                "pair": pair,
                "pair_shapes": pair_shapes,
                "area": area,
                "suggest": suggestion,
                "suggested_move": suggested_move,
                "issue": issue,
                "source_ids": source_ids,
            }
        )
    return targets


def _overflow_repair_targets(
    *,
    native_mechanical_report: dict[str, Any] | None,
    mechanical_gate_results: dict[str, Any] | None,
    source_element_map: dict[str, Any] | None,
    native_shape_inventory: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Promote unapproved overflow residue to exact source-addressable targets."""

    report = native_mechanical_report if isinstance(native_mechanical_report, dict) else {}
    residues = report.get("lint_residue") if isinstance(report.get("lint_residue"), list) else []
    gate_selectors = {
        str(item.get("selector") or "")
        for item in _mechanical_gate_issues(mechanical_gate_results)
        if str(item.get("code") or "") == "native_lint_unapproved_bleed"
    }
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in residues:
        if not isinstance(item, dict) or str(item.get("kind") or "") != "slide_overflow_non_text":
            continue
        selector = _selector_for_native_slide(item.get("slide"))
        if selector not in gate_selectors:
            continue
        shape_id = _compact_excerpt(item.get("shape"), limit=80)
        key = (selector, shape_id.casefold())
        if not shape_id or key in seen:
            continue
        seen.add(key)
        shape_detail = _overlap_shape_target(
            shape_id=shape_id,
            selector=selector,
            native_shape_inventory=native_shape_inventory,
            source_element_map=source_element_map,
        ) or {
            "id": shape_id,
            "name": "",
            "source_ids": [],
            "text_excerpt": "",
            "pos": [],
            "size": [],
        }
        source_ids = shape_detail.get("source_ids") or []
        if not source_ids:
            continue
        source_role = _direct_source_role_for_shape(
            source_element_map=source_element_map,
            selector=selector,
            shape_name=str(shape_detail.get("name") or ""),
        )
        if source_role in {"background", "bleed", "decorative"}:
            continue
        targets.append(
            {
                "target_type": "overflow",
                "code": "native_lint_unapproved_bleed",
                "selector": selector,
                "shape": shape_id,
                "shape_detail": shape_detail,
                "source_ids": source_ids,
                "source_role": source_role,
                "issue": _compact_excerpt(item.get("issue"), limit=220),
                "suggest": _compact_excerpt(item.get("suggest"), limit=180),
            }
        )
    return targets


def _alignment_repair_targets(
    *,
    native_mechanical_report: dict[str, Any] | None,
    mechanical_gate_results: dict[str, Any] | None,
    source_element_map: dict[str, Any] | None,
    native_shape_inventory: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Promote post-fix alignment residue to source-addressable repair targets."""

    report = native_mechanical_report if isinstance(native_mechanical_report, dict) else {}
    residues = report.get("lint_residue") if isinstance(report.get("lint_residue"), list) else []
    gate_selectors = {
        str(item.get("selector") or "")
        for item in _mechanical_gate_issues(mechanical_gate_results)
        if str(item.get("code") or "") == "native_lint_misaligned"
    }
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in residues:
        if not isinstance(item, dict) or str(item.get("kind") or "") != "misaligned":
            continue
        selector = _selector_for_native_slide(item.get("slide"))
        if gate_selectors and selector not in gate_selectors:
            continue
        shape_id = _compact_excerpt(item.get("shape"), limit=80)
        if not shape_id:
            continue
        raw_details = item.get("details") if isinstance(item.get("details"), list) else []
        details = [
            _compact_excerpt(value, limit=180)
            for value in raw_details
            if str(value).strip()
        ]
        issue = _compact_excerpt(item.get("issue"), limit=220)
        if issue and issue not in details:
            details.insert(0, issue)
        peer_ids: list[str] = []
        for peer_id in _NATIVE_SHAPE_ID_RE.findall(" ".join(details)):
            if peer_id.casefold() != shape_id.casefold() and peer_id not in peer_ids:
                peer_ids.append(peer_id)
        shape_detail = _overlap_shape_target(
            shape_id=shape_id,
            selector=selector,
            native_shape_inventory=native_shape_inventory,
            source_element_map=source_element_map,
        ) or {
            "id": shape_id,
            "name": "",
            "source_ids": [],
            "text_excerpt": "",
            "pos": [],
            "size": [],
        }
        peer_shapes: list[dict[str, Any]] = []
        for peer_id in peer_ids:
            peer_detail = _overlap_shape_target(
                shape_id=peer_id,
                selector=selector,
                native_shape_inventory=native_shape_inventory,
                source_element_map=source_element_map,
            )
            if peer_detail is not None:
                peer_shapes.append(peer_detail)
        for alignment_role in _alignment_roles(details):
            key = (selector, shape_id, alignment_role)
            if key in seen:
                continue
            seen.add(key)
            targets.append(
                {
                    "target_type": "alignment",
                    "code": "native_lint_misaligned",
                    "selector": selector,
                    "shape": shape_id,
                    "shape_detail": shape_detail,
                    "source_ids": shape_detail.get("source_ids") or [],
                    "peer_ids": peer_ids,
                    "peer_shapes": peer_shapes,
                    "details": details,
                    "alignment_role": alignment_role,
                    "css_target": _alignment_css_target(
                        alignment_role=alignment_role,
                        details=details,
                        shape_detail=shape_detail,
                    ),
                    "suggest": _compact_excerpt(
                        item.get("suggest") or "Align the source element to the reported peer gridline.",
                        limit=180,
                    ),
                }
            )
    return targets


def _alignment_roles(details: list[str]) -> list[str]:
    roles = list(
        dict.fromkeys(
            match.group("role").lower()
            for match in _ALIGNMENT_ROLE_RE.finditer(" ".join(details))
        )
    )
    return roles or ["gridline"]


def _alignment_css_target(
    *,
    alignment_role: str,
    details: list[str],
    shape_detail: dict[str, Any],
) -> dict[str, Any] | None:
    matching_detail = next(
        (
            detail
            for detail in details
            if alignment_role
            in {match.group("role").lower() for match in _ALIGNMENT_ROLE_RE.finditer(detail)}
        ),
        "",
    )
    if alignment_role == "gridline" and not matching_detail:
        matching_detail = next(
            (detail for detail in details if _ALIGNMENT_GRIDLINE_RE.search(detail)),
            "",
        )
    match = _ALIGNMENT_GRIDLINE_RE.search(matching_detail)
    gridline_in = _finite_float(match.group("gridline") if match else None)
    size = shape_detail.get("size") if isinstance(shape_detail.get("size"), list) else []
    if gridline_in is None:
        return None
    width_in = _finite_float(size[0]) if len(size) >= 1 else None
    height_in = _finite_float(size[1]) if len(size) >= 2 else None
    if alignment_role == "left":
        property_name, target_in = "left", gridline_in
    elif alignment_role == "right" and width_in is not None:
        property_name, target_in = "left", gridline_in - width_in
    elif alignment_role == "hcenter" and width_in is not None:
        property_name, target_in = "left", gridline_in - (width_in / 2)
    elif alignment_role == "top":
        property_name, target_in = "top", gridline_in
    elif alignment_role == "bottom" and height_in is not None:
        property_name, target_in = "top", gridline_in - height_in
    elif alignment_role == "vcenter" and height_in is not None:
        property_name, target_in = "top", gridline_in - (height_in / 2)
    else:
        return None
    extent_in = width_in if property_name == "left" else height_in
    canvas_limit_in = 20.0 if property_name == "left" else 11.25
    if extent_in is None or target_in < 0 or target_in + extent_in > canvas_limit_in:
        return None
    return {
        "canvas_property": property_name,
        "canvas_value_px": round(96 * target_in, 2),
        "gridline_in": round(gridline_in, 3),
    }


def _overlap_shape_target(
    *,
    shape_id: str,
    selector: str,
    native_shape_inventory: dict[str, Any] | None,
    source_element_map: dict[str, Any] | None,
    direct_source: bool = False,
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
        "source_ids": (
            _direct_first_source_ids_for_shape(
                source_element_map=source_element_map,
                selector=selector,
                shape_name=shape_name,
            )
            if direct_source
            else _source_ids_for_shape(
                source_element_map=source_element_map,
                selector=selector,
                shape_name=shape_name,
            )
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


def _overlap_suggested_move(value: str) -> dict[str, Any] | None:
    match = _OVERLAP_MOVE_DELTA_RE.search(value)
    if match is None:
        return None
    native_delta = [float(match.group("dx")), float(match.group("dy"))]
    return {
        "shape": _compact_excerpt(match.group("shape"), limit=80).rstrip(".)]"),
        "native_delta_in": [round(value, 3) for value in native_delta],
        "css_delta_px": [round(value * _CSS_PX_PER_NATIVE_INCH, 2) for value in native_delta],
    }


def _generic_mechanical_repair_targets(
    *,
    mechanical_gate_results: dict[str, Any] | None,
    has_contrast_targets: bool,
    overlap_target_selectors: set[str],
    overflow_target_selectors: set[str],
    alignment_target_selectors: set[str],
    source_element_map: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    typography_groups: dict[tuple[str, float], dict[str, Any]] = {}
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
        if code == "native_lint_unapproved_bleed" and selector in overflow_target_selectors:
            continue
        if code == "native_lint_misaligned" and selector in alignment_target_selectors:
            continue
        summary = _compact_excerpt(item.get("summary"), limit=220)
        repair_hint = _compact_excerpt(item.get("repair_hint"), limit=220)
        if code in _TYPOGRAPHY_GATE_CODES:
            occurrence, minimum_px = _typography_repair_occurrence(
                item,
                selector=selector,
                source_element_map=source_element_map,
            )
            key = (code, minimum_px)
            target = typography_groups.get(key)
            if target is None:
                target = {
                    "target_type": "generic",
                    "code": code,
                    "selector": selector,
                    "selectors": [],
                    "summary": summary,
                    "repair_hint": repair_hint,
                    "typography_minimum_px": minimum_px,
                    "typography_required": code == "native_required_text_too_small",
                    "typography_occurrences": [],
                }
                typography_groups[key] = target
            if selector not in target["selectors"]:
                target["selectors"].append(selector)
                target["selector"] = ", ".join(target["selectors"])
            if occurrence not in target["typography_occurrences"]:
                target["typography_occurrences"].append(occurrence)
            continue
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
    for target in typography_groups.values():
        targets.extend(_chunk_typography_target(target))
    return targets


def _fully_addressed_overflow_selectors(
    *,
    overflow_targets: list[dict[str, Any]],
    mechanical_gate_results: dict[str, Any] | None,
) -> set[str]:
    gate_counts = Counter(
        str(item.get("selector") or "")
        for item in _mechanical_gate_issues(mechanical_gate_results)
        if str(item.get("code") or "") == "native_lint_unapproved_bleed"
    )
    target_counts = Counter(str(target.get("selector") or "") for target in overflow_targets)
    return {
        selector
        for selector, gate_count in gate_counts.items()
        if gate_count > 0 and target_counts.get(selector, 0) >= gate_count
    }


def _chunk_typography_target(target: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep each typography target indivisible but small enough to survive bounds."""

    chunks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    for occurrence in target.get("typography_occurrences") or []:
        if not isinstance(occurrence, dict):
            continue
        candidate = [*current, occurrence]
        candidate_target = _typography_target_with_occurrences(target, candidate)
        if current and len(_typography_repair_line(1, candidate_target).encode("utf-8")) > (
            _MAX_TYPOGRAPHY_REPAIR_LINE_BYTES
        ):
            chunks.append(_typography_target_with_occurrences(target, current))
            current = [occurrence]
        else:
            current = candidate
    if current:
        chunks.append(_typography_target_with_occurrences(target, current))
    return chunks


def _typography_target_with_occurrences(
    target: dict[str, Any],
    occurrences: list[dict[str, Any]],
) -> dict[str, Any]:
    chunk = dict(target)
    chunk["typography_occurrences"] = occurrences
    selectors = list(dict.fromkeys(str(item.get("selector") or "deck") for item in occurrences))
    chunk["selectors"] = selectors
    chunk["selector"] = ", ".join(selectors)
    return chunk


def _typography_repair_occurrence(
    item: dict[str, Any],
    *,
    selector: str,
    source_element_map: dict[str, Any] | None,
) -> tuple[dict[str, Any], float]:
    summary = str(item.get("summary") or "").strip()
    match = _TYPOGRAPHY_SUMMARY_RE.match(summary)
    code = str(item.get("code") or "")
    minimum_px = 24.0 if code == "native_required_text_too_small" else 20.0
    source_label = ""
    source_lookup_label = ""
    actual_px: float | None = None
    if match:
        source_lookup_label = str(match.group("label") or "").strip()
        source_label = _compact_excerpt(source_lookup_label, limit=140)
        minimum_px = _finite_float(match.group("minimum_px")) or minimum_px
        actual_px = _finite_float(match.group("actual_px"))
    explicit_ids = item.get("source_ids") if isinstance(item.get("source_ids"), list) else []
    raw_source_ids = [str(value).strip() for value in explicit_ids if str(value).strip()]
    if not raw_source_ids:
        raw_source_ids = _source_ids_from_typography_label(
            source_element_map=source_element_map,
            selector=selector,
            source_label=source_lookup_label or source_label,
        )
    bounded_source_ids = [
        _bounded_typography_source_id(value)
        for value in raw_source_ids[:_MAX_TYPOGRAPHY_SOURCE_IDS]
    ]
    source_ids = [value for value, _truncated in bounded_source_ids]
    return {
        "selector": selector,
        "source_ids": source_ids,
        "source_ids_truncated": any(truncated for _value, truncated in bounded_source_ids),
        "source_id_omitted_count": max(0, len(raw_source_ids) - len(source_ids)),
        "source_label": source_label,
        "actual_px": round(actual_px, 3) if actual_px is not None else None,
    }, minimum_px


def _bounded_typography_source_id(value: str) -> tuple[str, bool]:
    compact = " ".join(str(value).split())
    encoded = compact.encode("utf-8")
    if len(encoded) <= _MAX_TYPOGRAPHY_SOURCE_ID_BYTES:
        return compact, False
    head_bytes = (_MAX_TYPOGRAPHY_SOURCE_ID_BYTES * 2) // 3
    tail_bytes = _MAX_TYPOGRAPHY_SOURCE_ID_BYTES - head_bytes - 3
    head = encoded[:head_bytes].decode("utf-8", errors="ignore")
    tail = encoded[-tail_bytes:].decode("utf-8", errors="ignore")
    return f"{head}…{tail}", True


def _source_ids_from_typography_label(
    *,
    source_element_map: dict[str, Any] | None,
    selector: str,
    source_label: str,
) -> list[str]:
    slides = source_element_map.get("slides") if isinstance(source_element_map, dict) else None
    slide = slides.get(selector) if isinstance(slides, dict) else None
    elements = slide.get("elements") if isinstance(slide, dict) else None
    if not isinstance(elements, dict) or not source_label:
        return []
    if source_label in elements:
        return [source_label]
    return [
        candidate
        for candidate in (value.strip() for value in source_label.split(","))
        if candidate in elements
    ]


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
    if any(str(target.get("target_type") or "") == "overlap" for target in targets):
        lines.append(_OVERLAP_REPAIR_GUIDANCE)
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
    if target_type == "quality":
        return _quality_repair_line(index, target)
    if target_type == "contrast":
        return _contrast_repair_line(index, target)
    if target_type == "overlap":
        return _overlap_repair_line(index, target)
    if target_type == "overflow":
        return _overflow_repair_line(index, target)
    if target_type == "alignment":
        return _alignment_repair_line(index, target)
    return _generic_repair_line(index, target)


def _quality_repair_line(index: int, target: dict[str, Any]) -> str:
    summary = json.dumps(target.get("summary") or "Deck source quality failed.", ensure_ascii=False)
    repair_hint = json.dumps(
        target.get("repair_hint") or "Remove the prohibited source pattern from this slide.",
        ensure_ascii=False,
    )
    selectors = ", ".join(str(value) for value in target.get("selectors") or [])
    return (
        f"{index}. QUALITY {selectors or target.get('selector') or 'deck'} "
        f"[{target.get('check') or target.get('code') or 'quality'}]: {summary}; {repair_hint}."
    )


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
    suggested_move = target.get("suggested_move")
    converted_move = ""
    if isinstance(suggested_move, dict):
        native_delta = _format_geometry(suggested_move.get("native_delta_in"))
        css_delta = _format_geometry(suggested_move.get("css_delta_px"), suffix="px")
        converted_move = (
            f" Move {suggested_move.get('shape') or 'the hinted source'} by native delta "
            f"{native_delta}in = CSS delta {css_delta}."
        )
    return (
        f"{index}. OVERLAP {target.get('selector') or 'deck'} area {target.get('area')}: {pair_detail}; "
        f"native-inch hint {suggestion}.{converted_move} Separate the exact source CSS without deleting "
        "content, and leave unrelated geometry unchanged."
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
        geometry = f" native_box_in={pos or '?'}+{size or '?'}"
    return f"{shape_id}{source} {text}{geometry}"


def _format_geometry(value: Any, *, suffix: str = "") -> str:
    values = value if isinstance(value, (list, tuple)) else []
    return "[" + ", ".join(f"{float(item):g}{suffix}" for item in values[:2]) + "]"


def _overflow_repair_line(index: int, target: dict[str, Any]) -> str:
    shape_detail = target.get("shape_detail")
    if not isinstance(shape_detail, dict):
        shape_detail = {"id": target.get("shape") or "unknown", "source_ids": []}
    primary = _overlap_shape_detail(shape_detail)
    issue = json.dumps(target.get("issue") or "Shape extends beyond the slide.", ensure_ascii=False)
    suggestion = json.dumps(target.get("suggest") or "keep the shape inside the canvas", ensure_ascii=False)
    return (
        f"{index}. OVERFLOW {target.get('selector') or 'deck'} {primary}; issue {issue}; hint {suggestion}. "
        "Edit that exact data-deck-id so non-bleed geometry stays inside 1920x1080. Native/inventory "
        "geometry is canvas-global, but child left/top inside a positioned parent are parent-local: "
        "local_left=target_canvas_left-parent_canvas_left and local_top=target_canvas_top-parent_canvas_top. "
        "If that explicitly sized target has padding or a border, first set box-sizing:border-box on that "
        "exact data-deck-id only so those additions stay within its declared width/height; never add a global "
        "or universal box-sizing reset. Otherwise correct the exact target's size or a nested child offset. "
        "Then do not enlarge or reposition its parent merely to mask overflow, and leave unrelated geometry unchanged."
    )


def _alignment_repair_line(index: int, target: dict[str, Any]) -> str:
    shape_detail = target.get("shape_detail")
    if not isinstance(shape_detail, dict):
        shape_detail = {"id": target.get("shape") or "unknown", "source_ids": []}
    primary = _alignment_shape_detail(shape_detail)
    peer_details = [
        _alignment_shape_detail(detail, include_geometry=False)
        for detail in target.get("peer_shapes") or []
        if isinstance(detail, dict)
    ]
    described_peers = peer_details or [str(value) for value in target.get("peer_ids") or []]
    peers = ", ".join(described_peers) or "the named inferred peers"
    detail = json.dumps("; ".join(str(value) for value in target.get("details") or []), ensure_ascii=False)
    role = str(target.get("alignment_role") or "gridline")
    guidance = (
        f"the preamble's exact {role} formula"
        if role != "gridline"
        else "the reported peer edge or centerline"
    )
    css_target = target.get("css_target")
    numeric_target = ""
    if (
        isinstance(css_target, dict)
        and css_target.get("canvas_property")
        and css_target.get("canvas_value_px") is not None
    ):
        property_name = str(css_target["canvas_property"])
        value_px = float(css_target["canvas_value_px"])
        gridline_in = float(css_target["gridline_in"])
        numeric_target = (
            f" Target canvas {property_name}={value_px:g}px ({gridline_in:g}in); "
            f"root CSS {property_name}={value_px:g}px; nested "
            f"local_{property_name}=target_canvas_{property_name}-parent_canvas_{property_name}."
        )
    return (
        f"{index}. ALIGN {target.get('selector') or 'deck'} role={role} {primary}; detail {detail}; "
        f"peers {peers}. Edit that data-deck-id geometry with {guidance}.{numeric_target}"
    )


def _alignment_shape_detail(
    detail: dict[str, Any],
    *,
    include_geometry: bool = True,
) -> str:
    shape_id = str(detail.get("id") or "unknown")
    source_ids = detail.get("source_ids") or []
    source = (
        "/data-deck-id=" + ",".join(json.dumps(source_id, ensure_ascii=False) for source_id in source_ids)
        if source_ids
        else ""
    )
    pos = detail.get("pos") or []
    size = detail.get("size") or []
    geometry = (
        f" native-in-box={pos or '?'}+{size or '?'}"
        if include_geometry and (pos or size)
        else ""
    )
    return f"{shape_id}{source}{geometry}"


def _generic_repair_line(index: int, target: dict[str, Any]) -> str:
    if target.get("typography_occurrences"):
        return _typography_repair_line(index, target)
    summary = json.dumps(target.get("summary") or "Mechanical gate failed.", ensure_ascii=False)
    repair_hint = json.dumps(target.get("repair_hint") or "Repair the affected source element.", ensure_ascii=False)
    return (
        f"{index}. GATE {target.get('selector') or 'deck'} "
        f"[{target.get('code') or 'deck_mechanical_gate_failed'}]: {summary}; {repair_hint}."
    )


def _typography_repair_line(index: int, target: dict[str, Any]) -> str:
    minimum_px = _finite_float(target.get("typography_minimum_px")) or 20.0
    required = bool(target.get("typography_required"))
    occurrences = "; ".join(
        _typography_occurrence_detail(item)
        for item in target.get("typography_occurrences") or []
        if isinstance(item, dict)
    )
    if required:
        scope = "REQUIRED descendants"
        tail = (
            "Every visible descendant of data-deck-required=true inherits required status; set nested "
            f"spans/labels in each exact source selector to >={minimum_px:g}px. 20-23px is allowed only "
            "inside optional elements; cut copy instead of shrinking."
        )
    else:
        scope = "OPTIONAL labels/captions"
        tail = f"Set each exact source selector and its visible descendants to >={minimum_px:g}px."
    return f"{index}. TYPE {scope} >={minimum_px:g}px: {occurrences}. {tail}"


def _typography_occurrence_detail(item: dict[str, Any]) -> str:
    selector = str(item.get("selector") or "deck")
    source_ids = item.get("source_ids") or []
    if source_ids:
        operator = "≈" if item.get("source_ids_truncated") else "="
        source = f"/data-deck-id{operator}" + ",".join(
            json.dumps(source_id, ensure_ascii=False) for source_id in source_ids
        )
    else:
        source_label = str(item.get("source_label") or "unknown source")
        source = "/source=" + json.dumps(source_label, ensure_ascii=False)
    omitted_count = int(item.get("source_id_omitted_count") or 0)
    if omitted_count:
        source += f"(+{omitted_count} ids)"
    actual_px = _finite_float(item.get("actual_px"))
    actual = f" @{actual_px:g}px" if actual_px is not None else ""
    return f"{selector}{source}{actual}"


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


def _direct_first_source_ids_for_shape(
    *,
    source_element_map: dict[str, Any] | None,
    selector: str,
    shape_name: str,
) -> list[str]:
    matches = _source_ids_for_shape(
        source_element_map=source_element_map,
        selector=selector,
        shape_name=shape_name,
    )
    direct = [
        source_id
        for source_id in matches
        if _is_direct_compiler_shape_name(shape_name=shape_name, source_id=source_id)
    ]
    if direct:
        return [max(direct, key=len)]
    return matches if len(matches) == 1 else []


def _direct_source_role_for_shape(
    *,
    source_element_map: dict[str, Any] | None,
    selector: str,
    shape_name: str,
) -> str | None:
    slides = source_element_map.get("slides") if isinstance(source_element_map, dict) else None
    slide = slides.get(selector) if isinstance(slides, dict) else None
    elements = slide.get("elements") if isinstance(slide, dict) else None
    if not isinstance(elements, dict) or not shape_name:
        return None
    matches = [
        (str(source_id), record)
        for source_id, record in elements.items()
        if isinstance(record, dict) and shape_name in {str(name) for name in record.get("shape_names") or []}
    ]
    direct_matches = [
        (source_id, record)
        for source_id, record in matches
        if _is_direct_compiler_shape_name(shape_name=shape_name, source_id=source_id)
    ]
    if direct_matches:
        _source_id, record = max(direct_matches, key=lambda item: len(item[0]))
        return str(record.get("source_role") or "").strip().lower() or None
    if len(matches) == 1:
        return str(matches[0][1].get("source_role") or "").strip().lower() or None
    return None


def _is_direct_compiler_shape_name(*, shape_name: str, source_id: str) -> bool:
    suffix_re = re.compile(
        rf"-{re.escape(source_id)}-"
        r"(?:(?:box|text|image|table)(?:-\d+)?|line-\d+(?:-part-\d+)?)$",
        re.I,
    )
    return bool(suffix_re.search(shape_name))


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
