"""Safe one-layer normalization for model-authored prepare_deck_build inputs."""

from __future__ import annotations

import json
from typing import Any

MAX_PREPARE_JSON_BYTES = 2_000_000
MAX_PREPARE_DEPTH = 32
MAX_PREPARE_NODES = 25_000
MAX_SLIDES = 64
MAX_STRING_LENGTH = 300_000


class PrepareDeckInputError(ValueError):
    def __init__(self, code: str, summary: str, *, retryable: bool) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary
        self.retryable = retryable


def normalize_slides_value(value: Any) -> Any:
    parsed = _parse_one_json_layer(value, expected="list", field="slides")
    if isinstance(parsed, list) and len(parsed) > MAX_SLIDES:
        raise ValueError(f"slides exceeds the {MAX_SLIDES}-slide limit")
    _validate_shape(parsed, field="slides")
    return parsed


def normalize_creative_plan_value(value: Any) -> Any:
    parsed = _parse_one_json_layer(value, expected="object", field="creative_plan")
    _validate_shape(parsed, field="creative_plan")
    return parsed


def normalize_prepare_deck_input(
    *,
    slides: Any,
    creative_plan: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    normalized_slides = normalize_slides_value(slides)
    normalized_plan = normalize_creative_plan_value(creative_plan)
    if not isinstance(normalized_slides, list):
        raise PrepareDeckInputError(
            "deck_prepare_argument_invalid",
            "slides must be a JSON array.",
            retryable=True,
        )
    if not isinstance(normalized_plan, dict):
        raise PrepareDeckInputError(
            "deck_prepare_argument_invalid",
            "creative_plan must be a JSON object.",
            retryable=True,
        )
    return normalized_slides, normalized_plan


def _parse_one_json_layer(value: Any, *, expected: str, field: str) -> Any:
    if not isinstance(value, str):
        return value
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_PREPARE_JSON_BYTES:
        raise ValueError(f"{field} exceeds the {MAX_PREPARE_JSON_BYTES}-byte limit")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field} contains malformed JSON: {exc.msg}") from exc
    if expected == "list" and not isinstance(parsed, list):
        raise ValueError(f"{field} JSON must decode to an array")
    if expected == "object" and not isinstance(parsed, dict):
        raise ValueError(f"{field} JSON must decode to an object")
    return parsed


def _validate_shape(value: Any, *, field: str) -> None:
    nodes = 0

    def walk(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_PREPARE_NODES:
            raise ValueError(f"{field} exceeds the structured item limit")
        if depth > MAX_PREPARE_DEPTH:
            raise ValueError(f"{field} exceeds the nesting-depth limit")
        if isinstance(item, str):
            if len(item) > MAX_STRING_LENGTH:
                raise ValueError(f"{field} contains an oversized string")
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if len(str(key)) > 160:
                    raise ValueError(f"{field} contains an oversized key")
                walk(child, depth + 1)
            return
        if isinstance(item, list):
            for child in item:
                walk(child, depth + 1)

    walk(value, 0)
