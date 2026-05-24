from __future__ import annotations

import importlib
import sys
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS_PACKAGE_PATH = REPO_ROOT / "backend" / "packages" / "harness"
EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
EMIT_ARTIFACT_CONTRACT_MODULE = "deerflow.sophia.tools.emit_artifact_contract"
BUILDER_LIFECYCLE_CONTRACT_MODULE = "deerflow.sophia.tools.builder_lifecycle_contract"
RETRIEVE_MEMORIES_CONTRACT_MODULE = "deerflow.sophia.tools.retrieve_memories_contract"

_JSON_SCHEMA_TO_GEMINI_TYPE = {
    "object": "OBJECT",
    "string": "STRING",
    "number": "NUMBER",
    "integer": "INTEGER",
    "boolean": "BOOLEAN",
    "array": "ARRAY",
}


class SophiaBackendToolConfigurationError(RuntimeError):
    """Raised when a realtime dogfood tool contract cannot be loaded safely."""


def gemini_emit_artifact_function_declaration() -> dict[str, object]:
    """Build Gemini's declaration from the dependency-safe emit_artifact contract."""
    try:
        contract = _emit_artifact_contract_module()
        schema = contract.ArtifactInput.model_json_schema()
        return {
            "name": contract.EMIT_ARTIFACT_TOOL_NAME,
            "description": _normalize_description(contract.EMIT_ARTIFACT_DESCRIPTION),
            "parameters": _gemini_parameters_from_json_schema(schema),
        }
    except Exception as exc:
        raise SophiaBackendToolConfigurationError(
            "Gemini dogfood emit_artifact declaration could not be built from the "
            f"dependency-safe contract {EMIT_ARTIFACT_CONTRACT_MODULE!r}: {exc}"
        ) from exc


def gemini_builder_lifecycle_function_declarations() -> list[dict[str, object]]:
    """Build Gemini declarations for existing builder/lifecycle tools."""
    try:
        contract = _builder_lifecycle_contract_module()
        declarations: list[dict[str, object]] = []
        for tool_name in contract.BUILDER_LIFECYCLE_TOOL_ORDER:
            input_model = contract.TOOL_INPUT_MODELS[tool_name]
            declarations.append(
                {
                    "name": tool_name,
                    "description": _normalize_description(contract.TOOL_DESCRIPTIONS[tool_name]),
                    "parameters": _gemini_parameters_from_json_schema(input_model.model_json_schema()),
                }
            )
        return declarations
    except Exception as exc:
        raise SophiaBackendToolConfigurationError(
            "Gemini dogfood builder/lifecycle declarations could not be built from the "
            f"dependency-safe contract {BUILDER_LIFECYCLE_CONTRACT_MODULE!r}: {exc}"
        ) from exc


def gemini_retrieve_memories_function_declaration() -> dict[str, object]:
    """Build Gemini's declaration from the dependency-safe memory contract."""
    try:
        contract = _retrieve_memories_contract_module()
        return {
            "name": contract.RETRIEVE_MEMORIES_TOOL_NAME,
            "description": _normalize_description(contract.RETRIEVE_MEMORIES_REALTIME_DESCRIPTION),
            "parameters": _gemini_parameters_from_json_schema(
                contract.RealtimeRetrieveMemoriesInput.model_json_schema()
            ),
        }
    except Exception as exc:
        raise SophiaBackendToolConfigurationError(
            "Gemini dogfood retrieve_memories declaration could not be built from the "
            f"dependency-safe contract {RETRIEVE_MEMORIES_CONTRACT_MODULE!r}: {exc}"
        ) from exc


def gemini_sophia_function_declarations() -> list[dict[str, object]]:
    return [
        gemini_emit_artifact_function_declaration(),
        *gemini_builder_lifecycle_function_declarations(),
        gemini_retrieve_memories_function_declaration(),
    ]


def openai_retrieve_memories_function_declaration() -> dict[str, object]:
    """Return the provider-neutral memory schema in OpenAI function format.

    This is intentionally not wired into the OpenAI production/dogfood route in
    this phase; it gives the next GPT Realtime phase a tested conversion target.
    """
    contract = _retrieve_memories_contract_module()
    schema = contract.RealtimeRetrieveMemoriesInput.model_json_schema()
    return {
        "type": "function",
        "name": contract.RETRIEVE_MEMORIES_TOOL_NAME,
        "description": _normalize_description(contract.RETRIEVE_MEMORIES_REALTIME_DESCRIPTION),
        "parameters": _openai_parameters_from_json_schema(schema),
    }


def execute_existing_emit_artifact(args: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """Execute Sophia's backend-owned emit_artifact contract with Gemini args."""
    contract = _emit_artifact_contract_module()
    artifact = contract.validate_emit_artifact_args(args)
    result = contract.record_emit_artifact(**artifact)
    return str(result), artifact


def execute_realtime_retrieve_memories(
    args: Mapping[str, Any],
    *,
    user_id: str,
    context_mode: str | None = None,
) -> dict[str, Any]:
    """Execute the query-only realtime memory tool with trusted user context."""
    contract = _retrieve_memories_contract_module()
    try:
        validated_args = contract.validate_realtime_retrieve_memories_args(args)
        query = validated_args["query"]
    except Exception:
        query = args.get("query", "") if isinstance(args, Mapping) else ""

    result = contract.retrieve_memories_for_realtime(
        user_id=user_id,
        query=query,
        context_mode=context_mode,
    )
    ignored_arg_names = [
        name
        for name in ("user_id", "categories", "category", "filters", "memory_provider")
        if name in args
    ]
    if ignored_arg_names:
        result["ignored_model_arg_names"] = sorted(ignored_arg_names)
    result["trusted_user_id_source"] = "authenticated_session_context"
    diagnostics = result.get("diagnostics")
    if isinstance(diagnostics, dict):
        diagnostics["trusted_user_id_source"] = "authenticated_session_context"
        diagnostics["ignored_model_arg_names"] = sorted(ignored_arg_names)
        diagnostics["raw_memory_text_excluded"] = True
    return result


def redacted_retrieve_memories_diagnostic(response: Mapping[str, Any]) -> dict[str, Any]:
    contract = _retrieve_memories_contract_module()
    return contract.redacted_retrieve_memories_diagnostic(response)


def validate_builder_lifecycle_tool_args(tool_name: str, args: Mapping[str, Any]) -> dict[str, Any]:
    contract = _builder_lifecycle_contract_module()
    return contract.validate_builder_lifecycle_tool_args(tool_name, args)


def builder_lifecycle_contract() -> Any:
    return _builder_lifecycle_contract_module()


def retrieve_memories_contract() -> Any:
    return _retrieve_memories_contract_module()


def _gemini_parameters_from_json_schema(schema: Mapping[str, Any]) -> dict[str, object]:
    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        properties = {}
    return {
        "type": "OBJECT",
        "properties": {
            str(name): _gemini_property_schema(prop)
            for name, prop in properties.items()
            if isinstance(prop, Mapping)
        },
        "required": [str(name) for name in schema.get("required", []) if isinstance(name, str)],
    }


def _openai_parameters_from_json_schema(schema: Mapping[str, Any]) -> dict[str, object]:
    properties = schema.get("properties")
    required = schema.get("required")
    return {
        "type": "object",
        "properties": dict(properties) if isinstance(properties, Mapping) else {},
        "required": [str(name) for name in required if isinstance(name, str)]
        if isinstance(required, list)
        else [],
        "additionalProperties": False,
    }


def _gemini_property_schema(schema: Mapping[str, Any]) -> dict[str, object]:
    normalized = _first_non_null_schema(schema)
    gemini_schema: dict[str, object] = {}

    json_type = normalized.get("type")
    if isinstance(json_type, str):
        gemini_schema["type"] = _JSON_SCHEMA_TO_GEMINI_TYPE.get(json_type, json_type.upper())

    description = normalized.get("description") or schema.get("description")
    if isinstance(description, str) and description.strip():
        gemini_schema["description"] = description.strip()

    enum_values = normalized.get("enum")
    if isinstance(enum_values, list):
        gemini_schema["enum"] = list(enum_values)

    minimum = normalized.get("minimum")
    if isinstance(minimum, int | float):
        gemini_schema["minimum"] = minimum
    maximum = normalized.get("maximum")
    if isinstance(maximum, int | float):
        gemini_schema["maximum"] = maximum

    child_properties = normalized.get("properties")
    if isinstance(child_properties, Mapping):
        gemini_schema["properties"] = {
            str(name): _gemini_property_schema(prop)
            for name, prop in child_properties.items()
            if isinstance(prop, Mapping)
        }

    items = normalized.get("items")
    if isinstance(items, Mapping):
        gemini_schema["items"] = _gemini_property_schema(items)

    if "type" not in gemini_schema:
        gemini_schema["type"] = "STRING"
    return gemini_schema


def _first_non_null_schema(schema: Mapping[str, Any]) -> Mapping[str, Any]:
    variants = schema.get("anyOf")
    if isinstance(variants, list):
        for variant in variants:
            if isinstance(variant, Mapping) and variant.get("type") != "null":
                return {**schema, **variant}
    return schema


def _normalize_description(value: object) -> str:
    if not isinstance(value, str):
        return "Emit the structured Sophia companion turn artifact."
    return " ".join(value.split())


@lru_cache(maxsize=1)
def _emit_artifact_contract_module() -> Any:
    harness_path = str(HARNESS_PACKAGE_PATH)
    if harness_path not in sys.path:
        sys.path.insert(0, harness_path)
    return importlib.import_module(EMIT_ARTIFACT_CONTRACT_MODULE)


@lru_cache(maxsize=1)
def _builder_lifecycle_contract_module() -> Any:
    harness_path = str(HARNESS_PACKAGE_PATH)
    if harness_path not in sys.path:
        sys.path.insert(0, harness_path)
    return importlib.import_module(BUILDER_LIFECYCLE_CONTRACT_MODULE)


@lru_cache(maxsize=1)
def _retrieve_memories_contract_module() -> Any:
    harness_path = str(HARNESS_PACKAGE_PATH)
    if harness_path not in sys.path:
        sys.path.insert(0, harness_path)
    return importlib.import_module(RETRIEVE_MEMORIES_CONTRACT_MODULE)