"""Shared PPTX/image-generation diagnostic reducers.

These reducers are used by the graph state schema and by middleware-local
delta composition. Keep absolute snapshot fields in the latest-value set; only
true delta counters should fall through to the generic ``*_count`` summing rule.
"""

from __future__ import annotations

from typing import Any

PPTX_DIAGNOSTIC_LATEST_COUNT_KEYS = frozenset(
    {
        "expected_generated_visual_count",
        "image_generation_manifest_failed_count",
        "image_generation_manifest_requested_count",
        "image_generation_manifest_success_count",
        "missing_expected_visual_count",
        "pptx_deck_missing_image_count",
        "pptx_deck_visual_quality_gap_count",
        "pptx_generator_picture_count",
        "pptx_generator_slide_count",
        "pptx_plan_image_ref_count",
        "pptx_plan_slide_count",
        "prepare_repair_count",
        "referenced_visual_count",
        "successful_generated_visual_count",
    }
)
PPTX_DIAGNOSTIC_LATEST_LIST_KEYS = frozenset(
    {
        "image_generation_manifest_expected_items",
        "image_generation_manifest_failed_outputs",
        "image_generation_manifest_unresolved_outputs",
        "pptx_slide_title_results",
    }
)


def _merge_string_list(current: object, update: list) -> list[str]:
    seen = {str(item): None for item in current if isinstance(item, str)} if isinstance(current, list) else {}
    for item in update:
        if isinstance(item, str):
            seen[item] = None
    return list(seen)


def _record_merge_key(item: dict[str, Any], fallback: int) -> str:
    for key in ("image_hash", "image_ref", "path", "png_path", "spec_path", "output_file"):
        value = item.get(key)
        if value:
            return str(value)
    return str(fallback)


def _merge_record_list(current: object, update: list) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    if isinstance(current, list):
        for item in current:
            if isinstance(item, dict):
                merged[_record_merge_key(item, len(merged))] = dict(item)
    for item in update:
        if isinstance(item, dict):
            merged[_record_merge_key(item, len(merged))] = dict(item)
    return list(merged.values())


def _merge_builder_pptx_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    """Reducer for safe PPTX/image-generation diagnostics."""
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)

    merged = dict(current)
    for key, value in update.items():
        _merge_builder_pptx_diagnostic_value(merged, key, value)
    return merged


def _merge_builder_pptx_diagnostic_value(merged: dict, key: str, value: object) -> None:
    if key in PPTX_DIAGNOSTIC_LATEST_COUNT_KEYS:
        merged[key] = value
        return
    if (key.endswith("_count") or key.endswith("_bytes_total")) and isinstance(value, int):
        merged[key] = int(merged.get(key, 0) or 0) + value
        return
    if key in PPTX_DIAGNOSTIC_LATEST_LIST_KEYS and isinstance(value, list):
        merged[key] = value
        return
    if key in {"image_output_paths", "pptx_output_paths", "qc_reasons"} and isinstance(value, list):
        merged[key] = _merge_string_list(merged.get(key), value)
        return
    if key in {"image_output_records", "qc_image_records"} and isinstance(value, list):
        merged[key] = _merge_record_list(merged.get(key), value)
        return
    if key == "qc_results" and isinstance(value, list):
        merged[key] = [*(merged.get(key) if isinstance(merged.get(key), list) else []), *value]
        return
    merged[key] = value
