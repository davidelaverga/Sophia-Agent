"""Verify that model-declared semantic HTML elements survive native compile."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from deerflow.sophia.deck_build.models import DeckSlideSpec


@dataclass
class SlideSourceRetention:
    selector: str
    required_source_ids: list[str]
    native_shape_names: list[str]
    retained_required_ids: list[str]
    missing_required_ids: list[str]
    duplicate_source_ids: list[str]
    semantic_source_ids: list[str]
    retained_semantic_ids: list[str]
    retention_ratio: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def evaluate_source_retention(
    *,
    slides: list[DeckSlideSpec],
    native_shape_inventory: dict[str, Any],
    source_element_map: dict[str, Any] | None = None,
) -> list[SlideSourceRetention]:
    map_slides = (
        source_element_map.get("slides")
        if isinstance(source_element_map, dict) and isinstance(source_element_map.get("slides"), dict)
        else {}
    )
    return [
        _evaluate_slide_source_retention(
            slide=slide,
            slide_inventory=native_shape_inventory.get(slide.selector),
            slide_map=map_slides.get(slide.selector),
        )
        for slide in slides
    ]


def _evaluate_slide_source_retention(
    *,
    slide: DeckSlideSpec,
    slide_inventory: Any,
    slide_map: Any,
) -> SlideSourceRetention:
    native_names = _native_shape_names(slide_inventory)
    required_ids = _required_source_ids(slide)
    elements, duplicate_ids = _source_elements(slide_map)
    semantic_ids = sorted(str(source_id) for source_id in elements)
    retained_semantic = _retained_source_ids(semantic_ids, elements, native_names)
    retained_required = _retained_source_ids(required_ids, elements, native_names)
    missing_required = sorted(set(required_ids) - set(retained_required))
    ratio = len(retained_semantic) / len(semantic_ids) if semantic_ids else 1.0
    return SlideSourceRetention(
        selector=slide.selector,
        required_source_ids=required_ids,
        native_shape_names=native_names,
        retained_required_ids=retained_required,
        missing_required_ids=missing_required,
        duplicate_source_ids=duplicate_ids,
        semantic_source_ids=semantic_ids,
        retained_semantic_ids=retained_semantic,
        retention_ratio=round(ratio, 4),
    )


def _native_shape_names(slide_inventory: Any) -> list[str]:
    shapes = slide_inventory.get("shapes") if isinstance(slide_inventory, dict) else []
    return sorted(
        {
            str(shape.get("name"))
            for shape in shapes or []
            if isinstance(shape, dict) and shape.get("name")
        }
    )


def _required_source_ids(slide: DeckSlideSpec) -> list[str]:
    composition = slide.composition_plan
    raw_ids = (
        getattr(composition, "required_element_ids", [])
        if composition is not None and not isinstance(composition, dict)
        else (composition or {}).get("required_element_ids", [])
    )
    return sorted(set(raw_ids))


def _source_elements(slide_map: Any) -> tuple[dict[str, Any], list[str]]:
    elements = slide_map.get("elements") if isinstance(slide_map, dict) else {}
    elements = elements if isinstance(elements, dict) else {}
    duplicates = (
        sorted(str(item) for item in (slide_map.get("duplicate_source_ids") or []))
        if isinstance(slide_map, dict)
        else []
    )
    return elements, duplicates


def _retained_source_ids(
    source_ids: list[str],
    elements: dict[str, Any],
    native_names: list[str],
) -> list[str]:
    return [
        source_id
        for source_id in source_ids
        if _source_id_retained(source_id, elements.get(source_id), native_names)
    ]


def retention_summary(reports: list[SlideSourceRetention]) -> dict[str, Any]:
    missing = [
        {"selector": report.selector, "source_id": source_id}
        for report in reports
        for source_id in report.missing_required_ids
    ]
    duplicates = [
        {"selector": report.selector, "source_id": source_id}
        for report in reports
        for source_id in report.duplicate_source_ids
    ]
    low_retention = [
        {"selector": report.selector, "retention_ratio": report.retention_ratio}
        for report in reports
        if report.retention_ratio < 0.90
    ]
    return {
        "passed": not missing and not duplicates,
        "slide_count": len(reports),
        "missing_required_count": len(missing),
        "duplicate_source_id_count": len(duplicates),
        "missing_required": missing,
        "duplicates": duplicates,
        "low_retention": low_retention,
        "slides": [report.to_dict() for report in reports],
    }


def _source_id_retained(source_id: str, record: Any, native_names: list[str]) -> bool:
    expected = (
        [str(item) for item in record.get("shape_names") or []]
        if isinstance(record, dict)
        else []
    )
    if expected:
        return any(name in native_names for name in expected)
    marker = f"-{source_id}-"
    return any(marker in name for name in native_names)
