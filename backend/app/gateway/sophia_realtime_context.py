"""Backend-owned bounded realtime context assembly for Sophia voice."""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path, validate_user_id
from deerflow.sophia import review_metadata_store
from deerflow.sophia.mem0_client import memory_provider_status, search_memories_with_diagnostics

logger = logging.getLogger(__name__)

REALTIME_CONTEXT_SCHEMA = "sophia_realtime_context_v1"
DEFAULT_REALTIME_MEMORY_LIMIT = 4
MAX_REALTIME_MEMORY_LIMIT = 10
IDENTITY_EXCERPT_MAX_CHARS = 1200
HANDOFF_EXCERPT_MAX_CHARS = 900
MEMORY_SNIPPET_MAX_CHARS = 240

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

    identity_text = _read_user_context_file(safe_user_id, "identity.md")
    handoff_text = _read_user_context_file(safe_user_id, "handoffs", "latest.md")
    preferred_name = _extract_preferred_name(identity_text) or _extract_preferred_name(handoff_text)
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
        "identity_available": identity_excerpt is not None,
        "handoff_available": handoff_excerpt is not None,
        "preferred_name_available": preferred_name is not None,
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


def _apply_review_metadata_overlays_readonly(user_id: str, memories: list[dict]) -> list[dict]:
    if not memories:
        return []

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


def _memory_context_query(*, context_mode: str, ritual: str | None) -> str:
    parts = [
        "stable facts, preferred name, communication preferences, relationships, commitments, "
        "emotional patterns, and useful context about this user",
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


def _coerce_memory_limit(value: int | None) -> int:
    if not isinstance(value, int):
        return DEFAULT_REALTIME_MEMORY_LIMIT
    return min(max(value, 1), MAX_REALTIME_MEMORY_LIMIT)


def _extract_preferred_name(text: str | None) -> str | None:
    if not text:
        return None
    explicit = re.search(
        r"(?im)^\s*(?:preferred[_ -]?name|display[_ -]?name|name)\s*:\s*([^\n#]{1,80})",
        text,
    )
    if explicit:
        return _clean_preferred_name(explicit.group(1))

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
    name = re.split(r"\s+(?:responds|prefers|likes|wants|needs|arrives|uses|is|has)\b", name, maxsplit=1)[0]
    name = name.strip()
    if not name or len(name) > 60:
        return None
    if any(ch in name for ch in ("/", "\\", "\x00", "<", ">", "{", "}")):
        return None
    if name.lower() in {"user", "unknown", "anonymous", "none", "null", "n/a"}:
        return None
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


def _collapse_whitespace(value: str) -> str:
    return " ".join(value.split())
