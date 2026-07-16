from __future__ import annotations

from copy import deepcopy
from typing import Any

from pydantic import BaseModel


def _resolve_local_ref(root: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValueError("strict output schemas may only use local references")
    value: Any = root
    for raw_part in ref[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or part not in value:
            raise ValueError("strict output schema contains an unresolved reference")
        value = value[part]
    if not isinstance(value, dict):
        raise ValueError("strict output schema reference must resolve to an object")
    return deepcopy(value)


def _normalize(value: Any, *, root: dict[str, Any]) -> Any:
    if isinstance(value, list):
        return [_normalize(item, root=root) for item in value]
    if not isinstance(value, dict):
        return value

    normalized = {key: _normalize(item, root=root) for key, item in value.items()}
    if normalized.get("default", object()) is None:
        normalized.pop("default", None)
    properties = normalized.get("properties")
    if isinstance(properties, dict):
        normalized["required"] = list(properties)
        normalized["properties"] = {key: _normalize(item, root=root) for key, item in properties.items()}
    if normalized.get("type") == "object":
        normalized.setdefault("additionalProperties", False)
    all_of = normalized.get("allOf")
    if isinstance(all_of, list) and len(all_of) == 1 and isinstance(all_of[0], dict):
        normalized.update(all_of[0])
        normalized.pop("allOf", None)
        normalized = _normalize(normalized, root=root)
    ref = normalized.get("$ref")
    if isinstance(ref, str) and len(normalized) > 1:
        resolved = _resolve_local_ref(root, ref)
        normalized = {**resolved, **normalized}
        normalized.pop("$ref", None)
        normalized = _normalize(normalized, root=root)
    return normalized


def strict_model_json_schema(schema: type[BaseModel]) -> dict[str, Any]:
    """Produce provider-neutral JSON Schema suitable for strict structured output."""

    root = schema.model_json_schema(mode="validation")
    return _normalize(deepcopy(root), root=root)
