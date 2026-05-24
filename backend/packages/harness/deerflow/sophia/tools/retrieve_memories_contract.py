"""Dependency-safe contract and core for Sophia's ``retrieve_memories`` tool.

The text companion wraps this module with a LangChain ``StructuredTool``.
Realtime providers import it for declaration/validation and execute the same
core without exposing ``user_id`` or category filters to the model.
"""

from __future__ import annotations

import math
import re
import time
from collections.abc import Callable, Iterable, Mapping
from hashlib import sha256
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

RETRIEVE_MEMORIES_TOOL_NAME = "retrieve_memories"
REALTIME_RETRIEVE_MEMORIES_LIMIT = 5
TEXT_COMPANION_RETRIEVE_MEMORIES_LIMIT = 15
MAX_RETRIEVE_MEMORIES_QUERY_CHARS = 240
MAX_RETRIEVE_MEMORIES_TEXT_CHARS = 280

RETRIEVE_MEMORIES_REALTIME_DESCRIPTION = (
    "Retrieve relevant long-term memories about the current authenticated user "
    "when the user asks an explicit memory, recall, or prior-context question. "
    "Call this for prompts like 'what do you remember about me?', 'do you remember "
    "what I use to stay calm when gaming?', 'do you remember my favorite childhood "
    "movie?', 'do you remember when I told you about...', 'what did we talk about "
    "last time?', 'have I told you about...', or 'what do you know about my "
    "thesis/project/work/workout?'. A later specific recall question is a new "
    "retrieval opportunity even if a broad memory search already happened earlier "
    "in the session. Do not call it for simple greetings, for 'what is my name?' "
    "when the preferred name is already in setup context, for facts already visible "
    "in the current conversation, for generic advice or present-moment clarifying "
    "questions, or every turn. The only model-facing argument is query; user "
    "identity and category weighting are supplied by trusted runtime context."
)

_SUCCESS_GUIDANCE = (
    "Returned memories are relevance-ranked. Use them only if directly relevant. "
    "If a returned memory answers a specific recall question, answer directly from "
    "the highest-ranked matching memory instead of asking the user to remind you. "
    "Say a fact is remembered only when the matching fact appears in the returned "
    "memories. Do not treat setup context, current-session context, inference, or "
    "a guess as retrieved memory."
)
_NO_RESULTS_GUIDANCE = (
    "No relevant stored memories were found. Do not pretend to remember. If the "
    "user gives hints, label guesses as guesses. If the user gives the answer, "
    "treat it as current-session knowledge unless offline memory writeback later "
    "confirms persistence. Do not promise to remember it permanently."
)
_UNAVAILABLE_GUIDANCE = (
    "Memory retrieval is unavailable right now. Do not say the memory does not "
    "exist or that you do not remember; say you cannot check stored memory at the "
    "moment and continue from setup or current-session context."
)
_ERROR_GUIDANCE = (
    "Memory retrieval failed right now. Do not expose provider details, do not say "
    "the memory does not exist, and do not pretend to remember. Say you cannot "
    "check stored memory at the moment."
)
_INVALID_QUERY_GUIDANCE = (
    "Ask the user for a clearer memory question if needed. Do not search again "
    "with a vague query and do not guess as if it were stored memory."
)
RETRIEVE_MEMORIES_GUIDANCE = _SUCCESS_GUIDANCE

_NO_RESULTS_MESSAGE = (
    "No relevant stored memories were found. Ask the user directly if the missing "
    "context matters."
)
_UNAVAILABLE_MESSAGE = (
    "Memory retrieval is unavailable right now. Continue using the current "
    "conversation context."
)
_INVALID_QUERY_MESSAGE = (
    "Memory retrieval needs a specific non-empty query. Ask the user directly if "
    "the missing context matters."
)
_NULL_LIKE_STRINGS = {"", "null", "none", "undefined", "n/a", "na", "(none)"}
_WHITESPACE_RE = re.compile(r"\s+")

RetrieveMemoriesStatus = Literal[
    "success",
    "no_results",
    "unavailable",
    "error",
    "invalid_query",
]
SearchMemoriesFunc = Callable[..., Any]
ProviderAvailableFunc = Callable[[], bool | Mapping[str, Any]]


class RealtimeRetrieveMemoriesInput(BaseModel):
    query: str = Field(
        description="Specific natural-language memory/context to retrieve for the current user.",
    )

    @field_validator("query", mode="before")
    @classmethod
    def sanitize_query_value(cls, value: Any) -> str:
        return sanitize_retrieve_memories_query(value)[0]


def validate_realtime_retrieve_memories_args(args: Mapping[str, Any]) -> dict[str, str]:
    """Validate provider args without accepting identity or category controls."""
    return RealtimeRetrieveMemoriesInput.model_validate(dict(args)).model_dump()


def sanitize_retrieve_memories_query(value: Any) -> tuple[str, bool]:
    """Normalize and cap the model-supplied memory query.

    Returns ``(query, was_truncated)``. Empty/null-like queries are represented
    as an empty string so the core can return a model-friendly ``invalid_query``
    response instead of throwing.
    """
    if value is None:
        return "", False
    query = _WHITESPACE_RE.sub(" ", str(value)).strip()
    if query.lower() in _NULL_LIKE_STRINGS:
        return "", False
    was_truncated = len(query) > MAX_RETRIEVE_MEMORIES_QUERY_CHARS
    if was_truncated:
        query = query[:MAX_RETRIEVE_MEMORIES_QUERY_CHARS].rstrip()
    return query, was_truncated


def retrieve_memories_for_realtime(
    *,
    user_id: str,
    query: Any,
    limit: int = REALTIME_RETRIEVE_MEMORIES_LIMIT,
    context_mode: str | None = None,
    categories: Iterable[str] | None = None,
    search_func: SearchMemoriesFunc | None = None,
    provider_available_func: ProviderAvailableFunc | None = None,
) -> dict[str, Any]:
    """Retrieve bounded memories for realtime voice providers.

    ``user_id`` is trusted runtime/session context. It is intentionally not part
    of ``RealtimeRetrieveMemoriesInput`` and must never be supplied by the model.
    """
    return _retrieve_memories_core(
        user_id=user_id,
        query=query,
        limit=limit,
        context_mode=context_mode,
        categories=categories,
        max_memory_text_chars=MAX_RETRIEVE_MEMORIES_TEXT_CHARS,
        search_func=search_func or _default_realtime_search_memories,
        provider_available_func=provider_available_func or _default_memory_provider_available,
        include_guidance=True,
    )


def retrieve_memories_for_text_companion(
    *,
    user_id: str,
    query: Any,
    categories: Iterable[str] | None = None,
    context_mode: str | None = None,
    limit: int = TEXT_COMPANION_RETRIEVE_MEMORIES_LIMIT,
) -> str:
    """Backward-compatible text companion wrapper result."""
    result = _retrieve_memories_core(
        user_id=user_id,
        query=query,
        limit=limit,
        context_mode=context_mode,
        categories=categories,
        max_memory_text_chars=None,
        search_func=_default_text_search_memories,
        provider_available_func=lambda: True,
        include_guidance=False,
    )
    status = result["status"]
    if status == "success":
        return "\n".join(f"- {memory['text']}" for memory in result["memories"])
    if status == "unavailable" or status == "error":
        return "Memory retrieval temporarily unavailable."
    return "No relevant memories found."


def redacted_retrieve_memories_diagnostic(response: Mapping[str, Any]) -> dict[str, Any]:
    """Return telemetry-safe diagnostics for a realtime tool response."""
    diagnostics = response.get("diagnostics")
    safe_diagnostics = _safe_diagnostics_subset(diagnostics)
    count = _coerce_non_negative_int(response.get("count"))
    return {
        "ok": bool(response.get("ok")),
        "status": str(response.get("status") or "error"),
        "count": count,
        "has_results": count > 0,
        "provider_status": str(response.get("provider_status") or safe_diagnostics.get("provider_status") or "unknown"),
        "provider_reason": str(response.get("provider_reason") or safe_diagnostics.get("provider_reason") or "unknown"),
        "trusted_user_id_source": str(response.get("trusted_user_id_source") or "unknown"),
        "ignored_model_arg_names": [
            str(name) for name in response.get("ignored_model_arg_names") or [] if isinstance(name, str)
        ],
        "raw_memory_text_excluded": True,
        "raw_query_excluded": True,
        "diagnostics": safe_diagnostics,
    }


def _retrieve_memories_core(
    *,
    user_id: str,
    query: Any,
    limit: int,
    context_mode: str | None,
    categories: Iterable[str] | None,
    max_memory_text_chars: int | None,
    search_func: SearchMemoriesFunc,
    provider_available_func: ProviderAvailableFunc,
    include_guidance: bool,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    sanitized_query, query_was_truncated = sanitize_retrieve_memories_query(query)
    trusted_user_id = _clean_string(user_id)
    safe_limit = _safe_limit(limit)
    internal_categories = _sanitize_categories(categories)

    if not trusted_user_id:
        return _status_response(
            ok=False,
            status="unavailable",
            query=sanitized_query,
            limit=safe_limit,
            message=_UNAVAILABLE_MESSAGE,
            latency_ms=_elapsed_ms(started_at),
            query_was_truncated=query_was_truncated,
            provider_status="unavailable",
            provider_reason="invalid_user",
            categories=internal_categories,
            include_guidance=include_guidance,
        )

    if not sanitized_query:
        return _status_response(
            ok=False,
            status="invalid_query",
            query=sanitized_query,
            limit=safe_limit,
            message=_INVALID_QUERY_MESSAGE,
            latency_ms=_elapsed_ms(started_at),
            query_was_truncated=query_was_truncated,
            provider_status="not_called",
            provider_reason="empty_query",
            categories=internal_categories,
            include_guidance=include_guidance,
        )

    try:
        provider_details = _provider_availability_details(provider_available_func())
    except Exception:
        provider_details = {
            "available": False,
            "provider_status": "unavailable",
            "provider_reason": "provider_status_exception",
            "provider_transport": "none",
        }
    if not provider_details["available"]:
        return _status_response(
            ok=False,
            status="unavailable",
            query=sanitized_query,
            limit=safe_limit,
            message=_UNAVAILABLE_MESSAGE,
            latency_ms=_elapsed_ms(started_at),
            query_was_truncated=query_was_truncated,
            provider_status=str(provider_details["provider_status"]),
            provider_reason=str(provider_details["provider_reason"]),
            categories=internal_categories,
            include_guidance=include_guidance,
        )

    try:
        raw_search_result = search_func(
            user_id=trusted_user_id,
            query=sanitized_query,
            categories=internal_categories,
            context_mode=context_mode,
            limit=safe_limit,
        )
        raw_results, search_diagnostics = _extract_search_result(raw_search_result)
    except Exception as exc:
        provider_reason = _exception_reason(exc, fallback="provider_exception")
        status = "unavailable" if provider_reason in {
            "missing_api_key",
            "missing_mem0_sdk",
            "missing_httpx",
            "client_unavailable",
            "client_initialization_failed",
        } else "error"
        return _status_response(
            ok=False,
            status=status,
            query=sanitized_query,
            limit=safe_limit,
            message=_UNAVAILABLE_MESSAGE,
            latency_ms=_elapsed_ms(started_at),
            query_was_truncated=query_was_truncated,
            provider_status="unavailable" if status == "unavailable" else "error",
            provider_reason=provider_reason,
            categories=internal_categories,
            include_guidance=include_guidance,
        )

    memories = _normalize_memory_results(
        raw_results,
        limit=safe_limit,
        max_text_chars=max_memory_text_chars,
    )
    if not memories:
        return _status_response(
            ok=True,
            status="no_results",
            query=sanitized_query,
            limit=safe_limit,
            message=_NO_RESULTS_MESSAGE,
            latency_ms=_elapsed_ms(started_at),
            query_was_truncated=query_was_truncated,
            provider_status=str(search_diagnostics.get("provider_status") or "available"),
            provider_reason=str(search_diagnostics.get("provider_reason") or provider_details["provider_reason"]),
            cache_status=str(search_diagnostics.get("cache_status") or "unknown"),
            provider_transport=_optional_string(search_diagnostics.get("provider_transport")),
            categories=internal_categories,
            include_guidance=include_guidance,
        )

    return _status_response(
        ok=True,
        status="success",
        query=sanitized_query,
        limit=safe_limit,
        memories=memories,
        latency_ms=_elapsed_ms(started_at),
        query_was_truncated=query_was_truncated,
        provider_status=str(search_diagnostics.get("provider_status") or "available"),
        provider_reason=str(search_diagnostics.get("provider_reason") or provider_details["provider_reason"]),
        cache_status=str(search_diagnostics.get("cache_status") or "unknown"),
        provider_transport=_optional_string(search_diagnostics.get("provider_transport")),
        categories=internal_categories,
        include_guidance=include_guidance,
    )


def _status_response(
    *,
    ok: bool,
    status: RetrieveMemoriesStatus,
    query: str,
    limit: int,
    latency_ms: int,
    query_was_truncated: bool,
    provider_status: str,
    provider_reason: str,
    categories: list[str],
    include_guidance: bool,
    cache_status: str = "unknown",
    provider_transport: str | None = None,
    memories: list[dict[str, Any]] | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    result_memories = memories or []
    response: dict[str, Any] = {
        "ok": ok,
        "status": status,
        "query": query,
        "count": len(result_memories),
        "memories": result_memories,
    }
    response["provider_status"] = provider_status
    response["provider_reason"] = provider_reason
    if message:
        response["message"] = message
    if include_guidance:
        response["guidance"] = _guidance_for_status(status)
    if include_guidance and status == "success":
        response["answer_hint"] = (
            "The memories are ranked. For a specific recall question, answer from "
            "the highest-ranked returned memory that directly matches the user's question."
        )
    result_fingerprints = _result_fingerprints(result_memories, query=query)
    query_terms = _query_terms(query)
    response["diagnostics"] = {
        "schema": "realtime_retrieve_memories_diagnostics_v1",
        "tool": RETRIEVE_MEMORIES_TOOL_NAME,
        "status": status,
        "count": len(result_memories),
        "has_results": bool(result_memories),
        "latency_ms": latency_ms,
        "query_length": len(query),
        "query_fingerprint": _text_fingerprint(query) if query else None,
        "raw_query_excluded": True,
        "query_was_truncated": query_was_truncated,
        "limit": limit,
        "provider_status": provider_status,
        "provider_reason": provider_reason,
        "cache_status": cache_status,
        "internal_category_count": len(categories),
        "result_categories": [
            memory["category"] for memory in result_memories if isinstance(memory.get("category"), str)
        ],
        "result_text_lengths": [len(str(memory.get("text") or "")) for memory in result_memories],
        "result_fingerprints": result_fingerprints,
        "result_preview_included": False,
        "raw_memory_text_excluded": True,
        "query_term_count": len(query_terms),
        "max_query_terms_matched_count": max(
            (fingerprint["query_terms_matched_count"] for fingerprint in result_fingerprints),
            default=0,
        ),
        "any_result_exact_query_terms_present": any(
            bool(fingerprint["exact_query_terms_present"]) for fingerprint in result_fingerprints
        ),
    }
    if provider_transport:
        response["diagnostics"]["provider_transport"] = provider_transport
    return response


def _guidance_for_status(status: RetrieveMemoriesStatus) -> str:
    if status == "success":
        return _SUCCESS_GUIDANCE
    if status == "no_results":
        return _NO_RESULTS_GUIDANCE
    if status == "unavailable":
        return _UNAVAILABLE_GUIDANCE
    if status == "error":
        return _ERROR_GUIDANCE
    if status == "invalid_query":
        return _INVALID_QUERY_GUIDANCE
    return _SUCCESS_GUIDANCE


def _provider_availability_details(value: bool | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(value, Mapping):
        available = bool(value.get("available"))
        return {
            "available": available,
            "provider_status": str(value.get("provider_status") or ("available" if available else "unavailable")),
            "provider_reason": str(value.get("provider_reason") or ("available" if available else "client_unavailable")),
            "provider_transport": str(value.get("provider_transport") or "unknown"),
        }
    available = bool(value)
    return {
        "available": available,
        "provider_status": "available" if available else "unavailable",
        "provider_reason": "available" if available else "client_unavailable",
        "provider_transport": "unknown",
    }


def _extract_search_result(raw_search_result: Any) -> tuple[Any, Mapping[str, Any]]:
    if isinstance(raw_search_result, Mapping) and "memories" in raw_search_result:
        memories = raw_search_result.get("memories")
        return memories, raw_search_result
    return raw_search_result, {}


def _exception_reason(exc: Exception, *, fallback: str) -> str:
    reason = getattr(exc, "reason", None)
    if isinstance(reason, str) and reason.strip():
        return reason.strip()
    return fallback


def _optional_string(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _normalize_memory_results(
    raw_results: Any,
    *,
    limit: int,
    max_text_chars: int | None,
) -> list[dict[str, Any]]:
    if not isinstance(raw_results, list):
        return []
    memories: list[dict[str, Any]] = []
    for raw in raw_results:
        if not isinstance(raw, Mapping):
            continue
        text = _memory_text(raw)
        if not text:
            continue
        if max_text_chars is not None and len(text) > max_text_chars:
            text = text[: max_text_chars - 3].rstrip() + "..."
        memory: dict[str, Any] = {"text": text}
        category = _clean_string(raw.get("category"))
        if not category:
            metadata = raw.get("metadata")
            if isinstance(metadata, Mapping):
                category = _clean_string(metadata.get("category"))
        if category:
            memory["category"] = category
        score = _safe_score(raw.get("score"))
        if score is not None:
            memory["score"] = score
        memory["source"] = "long_term_memory"
        memory["rank"] = len(memories) + 1
        memories.append(memory)
        if len(memories) >= limit:
            break
    return memories


def _result_fingerprints(memories: list[dict[str, Any]], *, query: str) -> list[dict[str, Any]]:
    query_terms = _query_terms(query)
    fingerprints: list[dict[str, Any]] = []
    for index, memory in enumerate(memories, start=1):
        text = str(memory.get("text") or "")
        matched_terms = _matched_query_terms(query_terms, text)
        fingerprint: dict[str, Any] = {
            "rank": _coerce_non_negative_int(memory.get("rank")) or index,
            "text_fingerprint": _text_fingerprint(text),
            "text_length": len(text),
            "query_terms_matched_count": len(matched_terms),
            "query_term_count": len(query_terms),
            "exact_query_terms_present": bool(query_terms) and len(matched_terms) == len(query_terms),
        }
        category = _clean_string(memory.get("category"))
        if category:
            fingerprint["category"] = category
        score = _safe_score(memory.get("score"))
        if score is not None:
            fingerprint["score"] = score
        fingerprints.append(fingerprint)
    return fingerprints


def _query_terms(query: str) -> set[str]:
    normalized = _normalize_for_fingerprint(query)
    return {
        term
        for term in re.findall(r"[a-z0-9']+", normalized)
        if len(term) >= 3 and term not in _QUERY_STOPWORDS
    }


def _matched_query_terms(query_terms: set[str], text: str) -> set[str]:
    if not query_terms:
        return set()
    text_terms = set(re.findall(r"[a-z0-9']+", _normalize_for_fingerprint(text)))
    return query_terms.intersection(text_terms)


def _text_fingerprint(text: str) -> str:
    normalized = _normalize_for_fingerprint(text)
    return "sha256:" + sha256(normalized.encode("utf-8")).hexdigest()[:16]


def _normalize_for_fingerprint(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", str(text).strip().lower())


_QUERY_STOPWORDS = {
    "about",
    "after",
    "again",
    "always",
    "and",
    "are",
    "because",
    "did",
    "does",
    "for",
    "from",
    "had",
    "have",
    "how",
    "into",
    "know",
    "like",
    "memory",
    "remember",
    "say",
    "says",
    "that",
    "the",
    "this",
    "used",
    "use",
    "uses",
    "what",
    "when",
    "where",
    "with",
    "you",
    "your",
}


def _memory_text(raw: Mapping[str, Any]) -> str:
    for key in ("content", "memory", "text"):
        text = _clean_string(raw.get(key))
        if text:
            return text
    return ""


def _clean_string(value: Any) -> str:
    if value is None:
        return ""
    text = _WHITESPACE_RE.sub(" ", str(value)).strip()
    if text.lower() in _NULL_LIKE_STRINGS:
        return ""
    return text


def _sanitize_categories(categories: Iterable[str] | None) -> list[str]:
    sanitized: list[str] = []
    for category in categories or []:
        cleaned = _clean_string(category)
        if cleaned and cleaned not in sanitized:
            sanitized.append(cleaned)
    return sanitized


def _safe_limit(limit: int) -> int:
    if isinstance(limit, bool):
        return REALTIME_RETRIEVE_MEMORIES_LIMIT
    try:
        parsed = int(limit)
    except (TypeError, ValueError):
        return REALTIME_RETRIEVE_MEMORIES_LIMIT
    return max(1, min(parsed, TEXT_COMPANION_RETRIEVE_MEMORIES_LIMIT))


def _safe_score(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if not isinstance(value, int | float):
        return None
    score = float(value)
    if not math.isfinite(score):
        return None
    return round(score, 4)


def _coerce_non_negative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value >= 0:
        return value
    return 0


def _safe_diagnostics_subset(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    safe: dict[str, Any] = {}
    for key in _SAFE_DIAGNOSTIC_KEYS:
        if key in value:
            safe[key] = _safe_result_fingerprints(value[key]) if key == "result_fingerprints" else _safe_diagnostic_value(value[key])
    return safe


def _safe_result_fingerprints(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    fingerprints: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        fingerprints.append(
            {
                key: _safe_diagnostic_value(item[key])
                for key in _SAFE_RESULT_FINGERPRINT_KEYS
                if key in item
            }
        )
    return fingerprints


def _safe_diagnostic_value(value: Any) -> Any:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, list):
        return [_safe_diagnostic_value(item) for item in value]
    if isinstance(value, Mapping):
        return {
            str(key): _safe_diagnostic_value(item)
            for key, item in value.items()
            if isinstance(key, str)
        }
    return str(value)


_SAFE_DIAGNOSTIC_KEYS = {
    "any_result_exact_query_terms_present",
    "cache_status",
    "count",
    "has_results",
    "ignored_model_arg_names",
    "internal_category_count",
    "latency_ms",
    "limit",
    "max_query_terms_matched_count",
    "provider_reason",
    "provider_status",
    "provider_transport",
    "query_fingerprint",
    "query_length",
    "query_term_count",
    "query_was_truncated",
    "raw_memory_text_excluded",
    "raw_query_excluded",
    "result_categories",
    "result_fingerprints",
    "result_preview_included",
    "result_text_lengths",
    "schema",
    "status",
    "tool",
    "trusted_user_id_source",
}

_SAFE_RESULT_FINGERPRINT_KEYS = {
    "category",
    "exact_query_terms_present",
    "query_term_count",
    "query_terms_matched_count",
    "rank",
    "score",
    "text_fingerprint",
    "text_length",
}


def _elapsed_ms(started_at: float) -> int:
    return max(int((time.perf_counter() - started_at) * 1000), 0)


def _default_memory_provider_available() -> Mapping[str, Any]:
    from deerflow.sophia.mem0_client import memory_provider_status

    return memory_provider_status()


def _default_realtime_search_memories(
    *,
    user_id: str,
    query: str,
    categories: list[str] | None,
    context_mode: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    from deerflow.sophia.mem0_client import search_memories_with_diagnostics

    return search_memories_with_diagnostics(
        user_id=user_id,
        query=query,
        categories=categories,
        context_mode=context_mode,
        limit=limit,
        log_content_previews=False,
        raise_on_error=True,
    )


def _default_text_search_memories(
    *,
    user_id: str,
    query: str,
    categories: list[str] | None,
    context_mode: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    from deerflow.sophia.mem0_client import search_memories

    return search_memories(
        user_id=user_id,
        query=query,
        categories=categories,
        context_mode=context_mode,
        limit=limit,
    )