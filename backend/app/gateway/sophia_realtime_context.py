"""Backend-owned bounded realtime context assembly for Sophia voice."""

from __future__ import annotations

import logging
import re
import secrets
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path, validate_user_id
from deerflow.sophia import review_metadata_store
from deerflow.sophia.mem0_client import memory_provider_status, search_memories_with_diagnostics
from deerflow.sophia.tools.retrieve_memories_contract import (
    REALTIME_RETRIEVE_MEMORIES_LIMIT,
    retrieve_memories_for_realtime,
)

logger = logging.getLogger(__name__)

REALTIME_CONTEXT_SCHEMA = "sophia_realtime_context_v1"
REALTIME_DYNAMIC_MEMORY_RETRIEVAL_SCHEMA = "sophia_realtime_dynamic_memory_retrieval_v1"
REALTIME_MEMORY_RETRIEVE_RESPONSE_SCHEMA = "sophia_realtime_memory_retrieve_response_v1"
REALTIME_MEMORY_RETRIEVE_DIAGNOSTIC_SCHEMA = "sophia_realtime_memory_retrieve_v1"
REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER = "X-Sophia-Realtime-Memory-Token"
DEFAULT_REALTIME_MEMORY_LIMIT = 4
MAX_REALTIME_MEMORY_LIMIT = 10
MAX_REALTIME_DYNAMIC_MEMORY_LIMIT = REALTIME_RETRIEVE_MEMORIES_LIMIT
IDENTITY_EXCERPT_MAX_CHARS = 1200
HANDOFF_EXCERPT_MAX_CHARS = 900
MEMORY_SNIPPET_MAX_CHARS = 240
DEFAULT_REALTIME_MEMORY_GRANT_TTL_SECONDS = 2 * 60 * 60

Mem0Status = Literal["available", "missing_api_key", "unavailable", "error"]


class RealtimeContextMemory(BaseModel):
    id: str | None = Field(default=None, description="Memory identifier when available")
    content: str = Field(default="", description="Bounded memory text")
    category: str | None = Field(default=None, description="Memory category when available")
    score: float | None = Field(default=None, description="Provider relevance score when available")


class RealtimeContextRequest(BaseModel):
    thread_id: str | None = Field(default=None, description="Optional companion thread id")
    session_id: str | None = Field(default=None, description="Optional voice/session id")
    query: str | None = Field(default=None, description="Optional setup-time search query")
    platform: str = Field(default="voice", description="Platform signal")
    context_mode: str | None = Field(default="life", description="Context mode")
    ritual: str | None = Field(default=None, description="Active ritual")
    limit: int | None = Field(
        default=DEFAULT_REALTIME_MEMORY_LIMIT,
        description="Requested memory snippet limit; capped server-side",
    )


class RealtimeContextResponse(BaseModel):
    preferred_name: str | None = None
    identity_excerpt: str | None = None
    handoff_excerpt: str | None = None
    memories: list[RealtimeContextMemory] = Field(default_factory=list)
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class RealtimeMemoryRetrieveRequest(BaseModel):
    query: str | None = Field(default=None, description="Model-supplied natural language memory query")
    context_mode: str | None = Field(default="life", description="Trusted runtime context mode")
    ritual: str | None = Field(default=None, description="Trusted runtime ritual")
    limit: int | None = Field(
        default=MAX_REALTIME_DYNAMIC_MEMORY_LIMIT,
        description="Requested dynamic memory limit; capped server-side",
    )


@dataclass(frozen=True)
class RealtimeMemoryRetrievalGrant:
    token: str
    user_id: str
    session_id: str
    expires_at: float

    @property
    def expires_at_iso(self) -> str:
        return datetime.fromtimestamp(self.expires_at, UTC).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class _PreferredNameCandidate:
    name: str
    source: str
    confidence: float
    rank: int


@dataclass(frozen=True)
class _PreferredNameResolution:
    name: str | None
    source: str
    conflict: bool
    candidate_count: int


_memory_retrieval_grants: dict[str, RealtimeMemoryRetrievalGrant] = {}
_memory_retrieval_grants_lock = threading.Lock()


def build_sophia_realtime_context(
    *,
    user_id: str,
    request: RealtimeContextRequest | None = None,
) -> RealtimeContextResponse:
    """Assemble the bounded setup context Gemini Live needs from backend-owned sources."""
    safe_user_id = validate_user_id(user_id)
    request = request or RealtimeContextRequest()
    limit = _coerce_memory_limit(request.limit)
    context_mode = _normalize_context_mode(request.context_mode)
    ritual = _clean_optional_text(request.ritual)
    platform = _clean_optional_text(request.platform) or "voice"
    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )

    mem00_containment = memory_feature_flags_for_owner(safe_user_id).candidate_ledger_write
    identity_file_status = "quarantined_mem00" if mem00_containment else _user_context_file_status(safe_user_id, "identity.md")
    handoff_file_status = "quarantined_mem00" if mem00_containment else _user_context_file_status(safe_user_id, "handoffs", "latest.md")
    identity_text = None if mem00_containment else _read_user_context_file(safe_user_id, "identity.md")
    handoff_text = None if mem00_containment else _read_user_context_file(safe_user_id, "handoffs", "latest.md")
    identity_excerpt = _bounded_text(identity_text, IDENTITY_EXCERPT_MAX_CHARS)
    handoff_excerpt = _bounded_text(handoff_text, HANDOFF_EXCERPT_MAX_CHARS)

    query = _bounded_text(request.query, 500) or _memory_context_query(
        context_mode=context_mode,
        ritual=ritual,
    )
    memories, mem0_status, mem0_provider_reason = _search_realtime_memories(
        user_id=safe_user_id,
        query=query,
        context_mode=context_mode,
        ritual=ritual,
        limit=limit,
    )
    preferred_name_candidates = _preferred_name_candidates_from_sources(
        identity_text=identity_text,
        handoff_text=handoff_text,
        memories=memories,
    )
    mem0_preferred_name_status = "not_needed"
    mem0_preferred_name_reason: str | None = None
    if not any(candidate.source == "identity_file" for candidate in preferred_name_candidates):
        mem0_candidates, mem0_preferred_name_status, mem0_preferred_name_reason = _search_preferred_name_memories(
            user_id=safe_user_id,
            context_mode=context_mode,
            ritual=ritual,
        )
        preferred_name_candidates.extend(mem0_candidates)
    preferred_name_resolution = _resolve_preferred_name(preferred_name_candidates)
    preferred_name = preferred_name_resolution.name

    diagnostics: dict[str, Any] = {
        "schema": REALTIME_CONTEXT_SCHEMA,
        "context_source": "gateway",
        "context_fetch_status": "ok",
        "platform": platform,
        "context_mode": context_mode,
        "ritual": ritual,
        "thread_id_present": bool(_clean_optional_text(request.thread_id)),
        "session_id_present": bool(_clean_optional_text(request.session_id)),
        "mem0_status": mem0_status,
        "mem0_provider_reason": mem0_provider_reason,
        "mem0_preferred_name_status": mem0_preferred_name_status,
        "mem0_preferred_name_reason": mem0_preferred_name_reason,
        "identity_file_status": identity_file_status,
        "handoff_file_status": handoff_file_status,
        "identity_available": identity_excerpt is not None,
        "handoff_available": handoff_excerpt is not None,
        "preferred_name_available": preferred_name is not None,
        "preferred_name_source": preferred_name_resolution.source,
        "preferred_name_conflict": preferred_name_resolution.conflict,
        "preferred_name_candidate_count": preferred_name_resolution.candidate_count,
        "memory_count": len(memories),
        "memory_limit": limit,
        "memory_categories": sorted({memory.category for memory in memories if memory.category}),
        "identity_excerpt_chars": len(identity_excerpt or ""),
        "handoff_excerpt_chars": len(handoff_excerpt or ""),
        "memory_chars": sum(len(memory.content) for memory in memories),
    }

    return RealtimeContextResponse(
        preferred_name=preferred_name,
        identity_excerpt=identity_excerpt,
        handoff_excerpt=handoff_excerpt,
        memories=memories,
        diagnostics=diagnostics,
    )


def retrieve_sophia_realtime_memories(
    *,
    user_id: str,
    request: RealtimeMemoryRetrieveRequest | None = None,
) -> dict[str, Any]:
    """Execute the dynamic realtime memory lookup from backend-owned Mem0 access."""
    safe_user_id = validate_user_id(user_id)
    request = request or RealtimeMemoryRetrieveRequest()
    limit = _coerce_dynamic_memory_limit(request.limit)
    context_mode = _normalize_context_mode(request.context_mode)
    ritual = _clean_optional_text(request.ritual)

    def search_func(**kwargs: Any) -> dict[str, Any]:
        search_result = search_memories_with_diagnostics(
            user_id=safe_user_id,
            query=str(kwargs.get("query") or ""),
            categories=_memory_categories(context_mode=context_mode, ritual=ritual),
            context_mode=context_mode,
            limit=limit,
            log_content_previews=False,
            raise_on_error=True,
            caller="voice_dynamic_retrieval",
        )
        raw_memories = search_result.get("memories", []) if isinstance(search_result, Mapping) else []
        if not isinstance(raw_memories, list):
            raw_memories = []
        overlaid_memories = _apply_review_metadata_overlays_readonly(safe_user_id, raw_memories)
        return {
            **dict(search_result),
            "memories": [memory for memory in overlaid_memories if _memory_visible_for_realtime(memory)],
        }

    result = retrieve_memories_for_realtime(
        user_id=safe_user_id,
        query=request.query,
        limit=limit,
        context_mode=context_mode,
        categories=_memory_categories(context_mode=context_mode, ritual=ritual),
        search_func=search_func,
        provider_available_func=memory_provider_status,
    )
    result["trusted_user_id_source"] = "authenticated_realtime_session"
    result["dynamic_retrieval_source"] = "gateway"
    result["raw_memory_text_bounded"] = True
    _finalize_realtime_memory_retrieve_envelope(
        result,
        context_mode=context_mode,
        ritual=ritual,
        limit=limit,
    )

    diagnostics = result.get("diagnostics")
    if isinstance(diagnostics, dict):
        diagnostics.update(
            {
                "schema": REALTIME_MEMORY_RETRIEVE_DIAGNOSTIC_SCHEMA,
                "context_source": "gateway_dynamic_retrieve",
                "context_mode": context_mode,
                "ritual": ritual,
                "trusted_user_id_source": "authenticated_realtime_session",
                "dynamic_retrieval_source": "gateway",
                "raw_memory_text_excluded": True,
                "memory_limit": limit,
            }
        )
    _finalize_realtime_memory_retrieve_envelope(
        result,
        context_mode=context_mode,
        ritual=ritual,
        limit=limit,
    )
    return result


def create_realtime_memory_retrieval_grant(
    *,
    user_id: str,
    session_id: str,
    ttl_seconds: int = DEFAULT_REALTIME_MEMORY_GRANT_TTL_SECONDS,
) -> RealtimeMemoryRetrievalGrant:
    safe_user_id = validate_user_id(user_id)
    safe_session_id = _safe_session_id(session_id)
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + max(60, int(ttl_seconds))
    grant = RealtimeMemoryRetrievalGrant(
        token=token,
        user_id=safe_user_id,
        session_id=safe_session_id,
        expires_at=expires_at,
    )
    with _memory_retrieval_grants_lock:
        _purge_expired_memory_retrieval_grants_locked()
        _memory_retrieval_grants[token] = grant
    return grant


def retrieve_sophia_realtime_memories_for_grant(
    *,
    token: str,
    request: RealtimeMemoryRetrieveRequest | None = None,
) -> dict[str, Any]:
    grant, grant_reason = _resolve_realtime_memory_retrieval_grant_with_reason(token)
    if grant is None:
        status = "expired_grant" if grant_reason == "expired_grant" else "unauthorized"
        return build_realtime_memory_retrieve_error_envelope(
            status=status,
            provider_reason=grant_reason or "invalid_grant",
            request=request,
            diagnostics={"grant_status": grant_reason or "invalid_grant"},
        )
    result = retrieve_sophia_realtime_memories(user_id=grant.user_id, request=request)
    result["session_id"] = grant.session_id
    diagnostics = result.get("diagnostics")
    if isinstance(diagnostics, dict):
        diagnostics["session_id_present"] = bool(grant.session_id)
    return result


def build_realtime_memory_retrieve_error_envelope(
    *,
    status: str,
    provider_reason: str,
    provider_status: str = "unavailable",
    request: RealtimeMemoryRetrieveRequest | None = None,
    diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the stable gateway callback envelope for handled failures."""
    context_mode = _normalize_context_mode(request.context_mode if request else None)
    ritual = _clean_optional_text(request.ritual) if request else None
    limit = _coerce_dynamic_memory_limit(request.limit if request else None)
    query = _bounded_text(request.query, 500) if request else ""
    safe_status = (
        status
        if status
        in {
            "success",
            "no_results",
            "unavailable",
            "error",
            "unauthorized",
            "expired_grant",
            "invalid_request",
        }
        else "error"
    )
    safe_provider_status = _safe_reason(provider_status) or "unavailable"
    safe_provider_reason = _safe_reason(provider_reason) or "unknown"
    envelope: dict[str, Any] = {
        "schema": REALTIME_MEMORY_RETRIEVE_RESPONSE_SCHEMA,
        "ok": False,
        "status": safe_status,
        "query": query or "",
        "count": 0,
        "memories": [],
        "provider_status": safe_provider_status,
        "provider_reason": safe_provider_reason,
        "message": "Memory retrieval is unavailable right now. Continue using the current conversation context.",
        "guidance": ("Memory retrieval is unavailable right now. Do not say the memory does not exist; say you cannot check stored memory at the moment."),
        "trusted_user_id_source": "authenticated_realtime_session",
        "dynamic_retrieval_source": "gateway",
        "raw_memory_text_bounded": True,
    }
    envelope["diagnostics"] = {
        "schema": REALTIME_MEMORY_RETRIEVE_DIAGNOSTIC_SCHEMA,
        "response_schema": REALTIME_MEMORY_RETRIEVE_RESPONSE_SCHEMA,
        "tool": "retrieve_memories",
        "status": safe_status,
        "count": 0,
        "has_results": False,
        "provider_status": safe_provider_status,
        "provider_reason": safe_provider_reason,
        "context_source": "gateway_dynamic_retrieve",
        "context_mode": context_mode,
        "ritual": ritual,
        "raw_query_excluded": True,
        "raw_memory_text_excluded": True,
        "result_categories": [],
        "result_text_lengths": [],
        "result_fingerprints": [],
        "result_preview_included": False,
        "memory_limit": limit,
    }
    if diagnostics:
        envelope["diagnostics"].update({str(key): _safe_diagnostic_value(value) for key, value in diagnostics.items() if value is not None})
    return envelope


def build_degraded_realtime_context_response(
    *,
    reason: str,
    limit: int | None = DEFAULT_REALTIME_MEMORY_LIMIT,
) -> RealtimeContextResponse:
    bounded_limit = _coerce_memory_limit(limit)
    return RealtimeContextResponse(
        diagnostics={
            "schema": REALTIME_CONTEXT_SCHEMA,
            "context_source": "gateway",
            "context_fetch_status": "error",
            "mem0_status": "error",
            "mem0_provider_reason": _safe_reason(reason),
            "identity_available": False,
            "handoff_available": False,
            "preferred_name_available": False,
            "preferred_name_source": "unavailable",
            "preferred_name_conflict": False,
            "preferred_name_candidate_count": 0,
            "identity_file_status": "unavailable",
            "handoff_file_status": "unavailable",
            "mem0_preferred_name_status": "error",
            "mem0_preferred_name_reason": _safe_reason(reason),
            "memory_count": 0,
            "memory_limit": bounded_limit,
        }
    )


def _search_realtime_memories(
    *,
    user_id: str,
    query: str,
    context_mode: str,
    ritual: str | None,
    limit: int,
) -> tuple[list[RealtimeContextMemory], Mem0Status, str | None]:
    try:
        provider_status = memory_provider_status()
    except Exception:
        logger.warning("realtime.context mem0 status check failed", exc_info=True)
        return [], "error", "provider_status_exception"

    provider_reason = _safe_reason(provider_status.get("provider_reason")) or "client_unavailable"
    if not provider_status.get("available"):
        if provider_reason == "missing_api_key":
            return [], "missing_api_key", provider_reason
        return [], "unavailable", provider_reason

    try:
        search_result = search_memories_with_diagnostics(
            user_id=user_id,
            query=query,
            categories=_memory_categories(context_mode=context_mode, ritual=ritual),
            context_mode=context_mode,
            limit=limit,
            log_content_previews=False,
            raise_on_error=True,
            caller="voice_setup",
        )
    except Exception:
        logger.warning("realtime.context mem0 search failed", exc_info=True)
        return [], "error", "provider_exception"

    raw_memories = search_result.get("memories", []) if isinstance(search_result, Mapping) else []
    if not isinstance(raw_memories, list):
        raw_memories = []
    overlaid_memories = _apply_review_metadata_overlays_readonly(user_id, raw_memories)
    snippets = [_normalize_memory(memory) for memory in overlaid_memories]
    snippets = [snippet for snippet in snippets if snippet is not None]
    reason = _safe_reason(search_result.get("provider_reason")) if isinstance(search_result, Mapping) else None
    return snippets[:limit], "available", reason or provider_reason


def _search_preferred_name_memories(
    *,
    user_id: str,
    context_mode: str,
    ritual: str | None,
) -> tuple[list[_PreferredNameCandidate], str, str | None]:
    try:
        provider_status = memory_provider_status()
    except Exception:
        logger.warning("realtime.context preferred-name mem0 status check failed", exc_info=True)
        return [], "error", "provider_status_exception"

    provider_reason = _safe_reason(provider_status.get("provider_reason")) or "client_unavailable"
    if not provider_status.get("available"):
        if provider_reason == "missing_api_key":
            return [], "missing_api_key", provider_reason
        return [], "unavailable", provider_reason

    try:
        search_result = search_memories_with_diagnostics(
            user_id=user_id,
            query=_preferred_name_memory_query(context_mode=context_mode, ritual=ritual),
            categories=["fact", "preference"],
            context_mode=None,
            limit=5,
            log_content_previews=False,
            raise_on_error=True,
            caller="voice_preferred_name",
        )
    except Exception:
        logger.warning("realtime.context preferred-name mem0 search failed", exc_info=True)
        return [], "error", "provider_exception"

    raw_memories = search_result.get("memories", []) if isinstance(search_result, Mapping) else []
    if not isinstance(raw_memories, list):
        raw_memories = []
    overlaid_memories = _apply_review_metadata_overlays_readonly(user_id, raw_memories)
    visible_memories = [memory for memory in overlaid_memories if _memory_visible_for_realtime(memory)]

    candidates: list[_PreferredNameCandidate] = []
    for index, memory in enumerate(visible_memories):
        if not isinstance(memory, Mapping):
            continue
        content = _memory_content(memory)
        candidate = _preferred_name_candidate_from_text(
            content,
            source="mem0",
            rank=index,
            confidence=_preferred_name_confidence(content, source="mem0"),
        )
        if candidate is not None:
            candidates.append(candidate)

    reason = _safe_reason(search_result.get("provider_reason")) if isinstance(search_result, Mapping) else None
    return candidates, "available", reason or provider_reason


def _apply_review_metadata_overlays_readonly(user_id: str, memories: list[dict]) -> list[dict]:
    if not memories:
        return []
    if all(memory.get("authority") == "sophia_canonical" for memory in memories):
        return memories

    try:
        store = review_metadata_store._load_store(user_id)
    except Exception:
        logger.warning("realtime.context review metadata read failed", exc_info=True)
        return memories

    entries = store.get("entries") if isinstance(store, dict) else []
    if not isinstance(entries, list):
        return memories

    overlaid: list[dict] = []
    for memory in memories:
        if not isinstance(memory, dict):
            continue

        merged = dict(memory)
        content = _memory_content(memory)
        content_hash = review_metadata_store._content_hash(content)
        entry = review_metadata_store._select_entry(
            entries,
            memory_id=_clean_optional_text(memory.get("id")),
            content_hash=content_hash,
        )
        if isinstance(entry, dict):
            local_content = _clean_optional_text(entry.get("content"))
            if local_content:
                merged["memory"] = local_content
                merged["content"] = local_content

            local_metadata = entry.get("metadata")
            if isinstance(local_metadata, dict):
                current_metadata = merged.get("metadata") if isinstance(merged.get("metadata"), dict) else {}
                merged["metadata"] = {**current_metadata, **local_metadata}
                category = _clean_optional_text(local_metadata.get("category"))
                if category:
                    merged["category"] = category
                    merged["categories"] = [category]

        overlaid.append(merged)

    return overlaid


def _normalize_memory(memory: dict) -> RealtimeContextMemory | None:
    content = _memory_content(memory)
    if not content:
        return None

    metadata = memory.get("metadata") if isinstance(memory.get("metadata"), dict) else {}
    status = _clean_optional_text(metadata.get("status")) if isinstance(metadata, dict) else None
    if status and status.lower() in {"discarded", "rejected"}:
        return None

    category = _primary_category(memory)
    score = memory.get("score", memory.get("relevance_score"))
    content = _collapse_whitespace(content)
    if len(content) > MEMORY_SNIPPET_MAX_CHARS:
        content = content[: MEMORY_SNIPPET_MAX_CHARS - 1].rstrip() + "..."

    return RealtimeContextMemory(
        id=_clean_optional_text(memory.get("id")),
        content=content,
        category=category,
        score=float(score) if isinstance(score, int | float) else None,
    )


def _memory_visible_for_realtime(memory: object) -> bool:
    if not isinstance(memory, Mapping):
        return False
    metadata = memory.get("metadata") if isinstance(memory.get("metadata"), Mapping) else {}
    status = _clean_optional_text(metadata.get("status")) if isinstance(metadata, Mapping) else None
    return not status or status.lower() not in {"discarded", "rejected"}


def _primary_category(memory: Mapping[str, Any]) -> str | None:
    categories = memory.get("categories")
    if isinstance(categories, list):
        for category in categories:
            cleaned = _clean_optional_text(category)
            if cleaned:
                return cleaned

    category = _clean_optional_text(memory.get("category"))
    if category:
        return category

    metadata = memory.get("metadata")
    if isinstance(metadata, Mapping):
        return _clean_optional_text(metadata.get("category"))
    return None


def _memory_content(memory: Mapping[str, Any]) -> str | None:
    return _clean_optional_text(memory.get("memory")) or _clean_optional_text(memory.get("content"))


def _read_user_context_file(user_id: str, *segments: str) -> str | None:
    path = safe_user_path(USERS_DIR, user_id, *segments)
    if not path.exists() or not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("realtime.context could not read user context file %s", "/".join(segments), exc_info=True)
        return None


def _user_context_file_status(user_id: str, *segments: str) -> str:
    try:
        path = safe_user_path(USERS_DIR, user_id, *segments)
    except ValueError:
        return "unavailable"
    try:
        return "present" if path.exists() and path.is_file() else "missing"
    except OSError:
        logger.warning("realtime.context could not stat user context file %s", "/".join(segments), exc_info=True)
        return "unavailable"


def _memory_context_query(*, context_mode: str, ritual: str | None) -> str:
    parts = [
        "stable facts, preferred name, communication preferences, relationships, commitments, emotional patterns, and useful context about this user",
        f"current context mode: {context_mode}",
    ]
    if ritual:
        parts.append(f"active ritual: {ritual}")
    return ". ".join(parts)


def _preferred_name_memory_query(*, context_mode: str, ritual: str | None) -> str:
    parts = [
        "preferred name, display name, what the user wants to be called, name correction",
        f"current context mode: {context_mode}",
    ]
    if ritual:
        parts.append(f"active ritual: {ritual}")
    return ". ".join(parts)


def _memory_categories(*, context_mode: str, ritual: str | None) -> list[str]:
    categories = ["fact", "preference", "relationship", "feeling", "commitment", "decision", "lesson", "pattern"]
    if ritual:
        categories.append("ritual_context")
    if context_mode == "work":
        categories.extend(["project", "colleague", "career", "deadline"])
    elif context_mode == "gaming":
        categories.extend(["game", "achievement", "gaming_team", "strategy"])
    elif context_mode == "life":
        categories.extend(["family", "health", "personal_goal", "life_event"])
    return list(dict.fromkeys(categories))


def _normalize_context_mode(value: str | None) -> str:
    cleaned = _clean_optional_text(value)
    return cleaned if cleaned in {"work", "gaming", "life"} else "life"


def _finalize_realtime_memory_retrieve_envelope(
    result: dict[str, Any],
    *,
    context_mode: str,
    ritual: str | None,
    limit: int,
) -> None:
    memories = result.get("memories")
    if not isinstance(memories, list):
        memories = []
        result["memories"] = memories
    status = _clean_optional_text(result.get("status")) or "error"
    if status == "invalid_query":
        status = "invalid_request"
        result["status"] = status
    result["schema"] = REALTIME_MEMORY_RETRIEVE_RESPONSE_SCHEMA
    result["count"] = len(memories)
    result["provider_status"] = _safe_reason(result.get("provider_status")) or ("available" if bool(result.get("ok")) else "unavailable")
    result["provider_reason"] = _safe_reason(result.get("provider_reason")) or "unknown"
    result.setdefault("ok", False)
    result.setdefault("trusted_user_id_source", "authenticated_realtime_session")
    result.setdefault("dynamic_retrieval_source", "gateway")
    result.setdefault("raw_memory_text_bounded", True)

    diagnostics = result.get("diagnostics")
    if not isinstance(diagnostics, dict):
        diagnostics = {}
        result["diagnostics"] = diagnostics
    diagnostics["schema"] = REALTIME_MEMORY_RETRIEVE_DIAGNOSTIC_SCHEMA
    diagnostics["response_schema"] = REALTIME_MEMORY_RETRIEVE_RESPONSE_SCHEMA
    diagnostics["status"] = status
    diagnostics["count"] = len(memories)
    diagnostics["has_results"] = bool(memories)
    diagnostics["provider_status"] = result["provider_status"]
    diagnostics["provider_reason"] = result["provider_reason"]
    diagnostics["context_source"] = "gateway_dynamic_retrieve"
    diagnostics["context_mode"] = context_mode
    diagnostics["ritual"] = ritual
    diagnostics["raw_query_excluded"] = True
    diagnostics["raw_memory_text_excluded"] = True
    diagnostics["memory_limit"] = limit


def _coerce_memory_limit(value: int | None) -> int:
    if not isinstance(value, int):
        return DEFAULT_REALTIME_MEMORY_LIMIT
    return min(max(value, 1), MAX_REALTIME_MEMORY_LIMIT)


def _coerce_dynamic_memory_limit(value: int | None) -> int:
    if not isinstance(value, int):
        return MAX_REALTIME_DYNAMIC_MEMORY_LIMIT
    return min(max(value, 1), MAX_REALTIME_DYNAMIC_MEMORY_LIMIT)


def _resolve_realtime_memory_retrieval_grant(token: str) -> RealtimeMemoryRetrievalGrant | None:
    cleaned = _clean_optional_text(token)
    if cleaned is None:
        return None
    with _memory_retrieval_grants_lock:
        _purge_expired_memory_retrieval_grants_locked()
        return _memory_retrieval_grants.get(cleaned)


def _resolve_realtime_memory_retrieval_grant_with_reason(
    token: str,
) -> tuple[RealtimeMemoryRetrievalGrant | None, str | None]:
    cleaned = _clean_optional_text(token)
    if cleaned is None:
        return None, "missing_grant"
    now = time.time()
    with _memory_retrieval_grants_lock:
        grant = _memory_retrieval_grants.get(cleaned)
        if grant is not None:
            if grant.expires_at <= now:
                _memory_retrieval_grants.pop(cleaned, None)
                return None, "expired_grant"
            _purge_expired_memory_retrieval_grants_locked()
            return grant, None
        _purge_expired_memory_retrieval_grants_locked()
        return None, "invalid_grant"


def _purge_expired_memory_retrieval_grants_locked() -> None:
    now = time.time()
    expired = [token for token, grant in _memory_retrieval_grants.items() if grant.expires_at <= now]
    for token in expired:
        _memory_retrieval_grants.pop(token, None)


def _safe_session_id(value: str) -> str:
    cleaned = _clean_optional_text(value) or "unknown-session"
    return re.sub(r"[^A-Za-z0-9_.:-]+", "-", cleaned)[:160] or "unknown-session"


def _preferred_name_candidates_from_sources(
    *,
    identity_text: str | None,
    handoff_text: str | None,
    memories: list[RealtimeContextMemory],
) -> list[_PreferredNameCandidate]:
    candidates: list[_PreferredNameCandidate] = []
    identity_candidate = _preferred_name_candidate_from_text(
        identity_text,
        source="identity_file",
        rank=0,
        confidence=_preferred_name_confidence(identity_text, source="identity_file"),
    )
    if identity_candidate is not None:
        candidates.append(identity_candidate)

    for index, memory in enumerate(memories):
        candidate = _preferred_name_candidate_from_text(
            memory.content,
            source="mem0",
            rank=index,
            confidence=_preferred_name_confidence(memory.content, source="mem0"),
        )
        if candidate is not None:
            candidates.append(candidate)

    handoff_candidate = _preferred_name_candidate_from_text(
        handoff_text,
        source="handoff",
        rank=0,
        confidence=_preferred_name_confidence(handoff_text, source="handoff"),
    )
    if handoff_candidate is not None:
        candidates.append(handoff_candidate)
    return candidates


def _preferred_name_candidate_from_text(
    text: str | None,
    *,
    source: str,
    rank: int,
    confidence: float,
) -> _PreferredNameCandidate | None:
    name = _extract_preferred_name(text)
    if not name:
        return None
    return _PreferredNameCandidate(
        name=name,
        source=source,
        confidence=confidence,
        rank=rank,
    )


def _preferred_name_confidence(text: str | None, *, source: str) -> float:
    if source == "identity_file":
        return 1.0
    if not text:
        return 0.0
    lowered = text.lower()
    if "explicit user statement" in lowered or "name correction" in lowered:
        return 0.97
    if "preferred name" in lowered or "display name" in lowered:
        return 0.92
    if "call me" in lowered or "goes by" in lowered or "name correction" in lowered:
        return 0.88
    if "name is" in lowered or "session initiated with" in lowered:
        return 0.78 if source == "mem0" else 0.58
    return 0.68 if source == "mem0" else 0.5


def _resolve_preferred_name(candidates: list[_PreferredNameCandidate]) -> _PreferredNameResolution:
    filtered = [candidate for candidate in candidates if candidate.name]
    if not filtered:
        return _PreferredNameResolution(
            name=None,
            source="unavailable",
            conflict=False,
            candidate_count=0,
        )

    source_priority = {
        "identity_file": 0,
        "mem0": 1,
        "handoff": 2,
    }
    sorted_candidates = sorted(
        filtered,
        key=lambda candidate: (
            source_priority.get(candidate.source, 99),
            -candidate.confidence,
            candidate.rank,
            candidate.name.casefold(),
        ),
    )
    best = sorted_candidates[0]
    unique_names = {candidate.name.casefold() for candidate in sorted_candidates}
    return _PreferredNameResolution(
        name=best.name,
        source=best.source,
        conflict=len(unique_names) > 1,
        candidate_count=len(sorted_candidates),
    )


def _extract_preferred_name(text: str | None) -> str | None:
    if not text:
        return None
    explicit = re.search(
        r"(?im)^\s*(?:preferred[_ -]?name|display[_ -]?name|name)\s*:\s*([^\n#]{1,80})",
        text,
    )
    if explicit:
        return _clean_preferred_name(explicit.group(1))

    named_patterns = [
        r"(?i)\b(?:the\s+)?user'?s\s+(?:preferred\s+name|display\s+name|name)\s+(?:is|as|=)\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\b(?:the\s+)?user\s+(?:goes\s+by|prefers\s+to\s+be\s+called|wants\s+to\s+be\s+called|likes\s+to\s+be\s+called)\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\b(?:my\s+name\s+is|call\s+me|refer\s+to\s+me\s+as|i\s+go\s+by)\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\bname\s+correction\b[^.:\n]{0,80}[:\-]\s*([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
    ]
    for pattern in named_patterns:
        match = re.search(pattern, text)
        if match:
            cleaned = _clean_preferred_name(match.group(1))
            if cleaned:
                return cleaned

    inferred = re.search(
        r"(?m)^\s*([A-Z][A-Za-z'_-]{1,40})\s+"
        r"(?:responds|prefers|likes|wants|needs|arrives|uses|is|has)\b",
        text,
    )
    if inferred:
        return _clean_preferred_name(inferred.group(1))

    session_initiated = re.search(r"(?i)\bsession initiated with\s+([A-Z][A-Za-z'_-]{1,40})\b", text)
    if session_initiated:
        return _clean_preferred_name(session_initiated.group(1))
    return None


def _clean_preferred_name(value: str) -> str | None:
    name = value.strip().strip("-:.,;()[]{}\"'")
    name = re.split(r"[.,;:!?]\s+", name, maxsplit=1)[0]
    name = re.split(
        r"\s+(?:responds|prefers|likes|wants|needs|arrives|uses|is|has|no|not|please|from|instead|because|when|if|but|could|can|remember|going)\b",
        name,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    name = name.strip()
    if not name or len(name) > 60:
        return None
    if any(ch in name for ch in ("/", "\\", "\x00", "<", ">", "{", "}")):
        return None
    if not re.fullmatch(r"[A-Za-z][A-Za-z'_-]*(?:\s+[A-Za-z][A-Za-z'_-]*){0,2}", name):
        return None
    lowered = name.lower()
    stop_words = {
        "user",
        "unknown",
        "anonymous",
        "none",
        "null",
        "n/a",
        "na",
        "the user",
        "me",
        "you",
        "on",
        "the",
        "a",
        "an",
        "this",
        "that",
        "it",
        "important",
        "tomorrow",
        "today",
        "later",
        "thing",
        "one",
        "someone",
        "list",
        "about",
        "launch",
    }
    if lowered in stop_words or any(part in stop_words for part in lowered.split()):
        return None
    if name.islower():
        return " ".join(part[:1].upper() + part[1:] for part in name.split())
    return name


def _bounded_text(text: str | None, limit: int) -> str | None:
    if not text:
        return None
    normalized = _collapse_whitespace(text)
    if not normalized:
        return None
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "..."


def _clean_optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _safe_reason(value: object) -> str | None:
    reason = _clean_optional_text(value)
    if reason is None:
        return None
    return re.sub(r"[^A-Za-z0-9_.:-]+", "_", reason)[:80]


def _safe_diagnostic_value(value: object) -> object:
    if isinstance(value, str):
        return _safe_reason(value) or "unknown"
    if isinstance(value, bool | int | float) or value is None:
        return value
    if isinstance(value, list):
        return [_safe_diagnostic_value(item) for item in value[:20]]
    if isinstance(value, Mapping):
        return {str(key)[:80]: _safe_diagnostic_value(item) for key, item in list(value.items())[:20]}
    return str(type(value).__name__)


def _collapse_whitespace(value: str) -> str:
    return " ".join(value.split())
