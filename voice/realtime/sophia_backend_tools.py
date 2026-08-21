from __future__ import annotations

import importlib
import ipaddress
import os
import sys
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from voice.realtime.coreview import (
    gemini_coreview_action_function_declarations,
    gemini_read_artifact_text_function_declaration,
    is_coreview_enabled,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS_PACKAGE_PATH = REPO_ROOT / "backend" / "packages" / "harness"
EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
EMIT_ARTIFACT_CONTRACT_MODULE = "deerflow.sophia.tools.emit_artifact_contract"
BUILDER_LIFECYCLE_CONTRACT_MODULE = "deerflow.sophia.tools.builder_lifecycle_contract"
RETRIEVE_MEMORIES_CONTRACT_MODULE = "deerflow.sophia.tools.retrieve_memories_contract"
WEB_FETCH_TOOL_NAME = "web_fetch"
JINA_READER_URL = "https://r.jina.ai/"
WEB_FETCH_MAX_URL_LENGTH = 2048
WEB_FETCH_MAX_CONTENT_CHARS = 12_000
WEB_FETCH_TIMEOUT_SECONDS = 15.0

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


def gemini_web_fetch_function_declaration() -> dict[str, object]:
    """Declare exact-page retrieval for Gemini Live.

    Gemini Live has native Google Search, but it does not currently expose URL
    context. This small backend tool gives Sophia a bounded, text-only fetch for
    public URLs returned by Search or explicitly supplied by the user.
    """
    return {
        "name": WEB_FETCH_TOOL_NAME,
        "description": (
            "Fetch the readable text of one public HTTP or HTTPS URL. Use this after "
            "Google Search when you need the contents of a specific result, or when "
            "the user gives an exact URL."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "url": {
                    "type": "STRING",
                    "description": "The absolute public HTTP or HTTPS URL to read.",
                },
            },
            "required": ["url"],
        },
    }


def gemini_sophia_function_declarations(
    *,
    include_coreview: bool | None = None,
) -> list[dict[str, object]]:
    declarations = [
        gemini_emit_artifact_function_declaration(),
        *gemini_builder_lifecycle_function_declarations(),
        gemini_retrieve_memories_function_declaration(),
        gemini_web_fetch_function_declaration(),
    ]
    if include_coreview is None:
        include_coreview = is_coreview_enabled()
    if include_coreview:
        declarations.append(gemini_read_artifact_text_function_declaration())
        declarations.extend(gemini_coreview_action_function_declarations())
    return declarations


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


async def execute_realtime_web_fetch(args: Mapping[str, Any]) -> dict[str, Any]:
    """Fetch one public page through Jina Reader with strict, bounded output."""
    raw_url = args.get("url") if isinstance(args, Mapping) else None
    try:
        url = _validated_public_web_url(raw_url)
    except ValueError as exc:
        return {
            "ok": False,
            "status": "invalid_url",
            "error_type": "invalid_public_url",
            "result_summary": str(exc),
        }

    headers = {
        "Accept": "text/plain, text/markdown;q=0.9",
        "Content-Type": "application/json",
        "X-Return-Format": "markdown",
        "X-Timeout": "10",
    }
    api_key = os.getenv("JINA_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=WEB_FETCH_TIMEOUT_SECONDS) as client:
            response = await client.post(
                JINA_READER_URL,
                headers=headers,
                json={"url": url},
            )
    except httpx.RequestError as exc:
        return {
            "ok": False,
            "status": "unavailable",
            "error_type": exc.__class__.__name__,
            "url": url,
            "result_summary": "The page fetch service is temporarily unavailable.",
        }

    if response.status_code >= 400:
        return {
            "ok": False,
            "status": "error",
            "http_status": response.status_code,
            "url": url,
            "result_summary": f"The page fetch failed with HTTP {response.status_code}.",
        }

    content = response.text.strip()
    truncated = len(content) > WEB_FETCH_MAX_CONTENT_CHARS
    if truncated:
        content = content[:WEB_FETCH_MAX_CONTENT_CHARS].rstrip()
    return {
        "ok": True,
        "status": "success",
        "url": url,
        "content": content,
        "content_chars": len(content),
        "truncated": truncated,
        "result_summary": (
            "Fetched readable page text."
            if content
            else "The page was reachable but contained no readable text."
        ),
    }


def _validated_public_web_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Provide one absolute public HTTP or HTTPS URL.")
    url = value.strip()
    if len(url) > WEB_FETCH_MAX_URL_LENGTH:
        raise ValueError("The URL is too long to fetch safely.")
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Only absolute public HTTP or HTTPS URLs can be fetched.")
    if parsed.username or parsed.password:
        raise ValueError("URLs containing embedded credentials cannot be fetched.")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname.endswith(".local"):
        raise ValueError("Local or private network URLs cannot be fetched.")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        raise ValueError("Local or private network URLs cannot be fetched.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("The URL contains an invalid port.") from exc
    if port not in {None, 80, 443}:
        raise ValueError("Only standard HTTP and HTTPS ports can be fetched.")
    return url


def execute_realtime_retrieve_memories(
    args: Mapping[str, Any],
    *,
    user_id: str,
    context_mode: str | None = None,
) -> dict[str, Any]:
    """Execute the query-only realtime memory tool with trusted user context."""
    contract = _retrieve_memories_contract_module()
    query = _realtime_memory_query_from_args(args)

    result = contract.retrieve_memories_for_realtime(
        user_id=user_id,
        query=query,
        context_mode=context_mode,
    )
    return decorate_realtime_retrieve_memories_result(result, args=args)


def execute_realtime_retrieve_memories_unavailable(
    args: Mapping[str, Any],
    *,
    user_id: str,
    context_mode: str | None = None,
    provider_reason: str = "gateway_retrieval_not_configured",
    provider_status: str = "unavailable",
    diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the standard graceful unavailable shape without touching Mem0."""
    contract = _retrieve_memories_contract_module()
    query = _realtime_memory_query_from_args(args)
    result = contract.retrieve_memories_for_realtime(
        user_id=user_id,
        query=query,
        context_mode=context_mode,
        provider_available_func=lambda: {
            "available": False,
            "provider_status": provider_status,
            "provider_reason": provider_reason,
            "provider_transport": "gateway",
        },
        search_func=lambda **_kwargs: [],
    )
    result["provider_status"] = provider_status
    result["provider_reason"] = provider_reason
    result_diagnostics = result.get("diagnostics")
    if isinstance(result_diagnostics, dict) and diagnostics:
        result_diagnostics.update(dict(diagnostics))
    return decorate_realtime_retrieve_memories_result(result, args=args)


def decorate_realtime_retrieve_memories_result(
    result: dict[str, Any],
    *,
    args: Mapping[str, Any],
) -> dict[str, Any]:
    """Add voice-runtime trust/ignored-argument diagnostics to a backend result."""
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


def realtime_memory_query_from_args(args: Mapping[str, Any]) -> str:
    return _realtime_memory_query_from_args(args)


def _realtime_memory_query_from_args(args: Mapping[str, Any]) -> str:
    contract = _retrieve_memories_contract_module()
    try:
        validated_args = contract.validate_realtime_retrieve_memories_args(args)
        return validated_args["query"]
    except Exception:
        return args.get("query", "") if isinstance(args, Mapping) else ""


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
    if _schema_allows_null(schema):
        gemini_schema["nullable"] = True

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


def _schema_allows_null(schema: Mapping[str, Any]) -> bool:
    variants = schema.get("anyOf")
    if not isinstance(variants, list):
        return schema.get("type") == "null"
    return any(isinstance(variant, Mapping) and variant.get("type") == "null" for variant in variants)


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
