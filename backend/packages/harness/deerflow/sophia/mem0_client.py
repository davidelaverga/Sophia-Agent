"""Mem0 SDK wrapper with thread-safe bounded cache.

Provides cached search_memories() for the middleware and tools.
Cache has 60-second TTL and 256-entry max size via cachetools.TTLCache.
invalidate_user_cache() clears after writes. MemoryClient is cached at
module level (singleton).
"""

import logging
import os
import threading
import time

from cachetools import TTLCache

from deerflow.sophia.review_metadata_store import reconcile_review_metadata_entries, upsert_review_metadata

logger = logging.getLogger(__name__)

# Context-specific category sets — memories in these categories are prioritized
# when searching within the matching context_mode
_CONTEXT_CATEGORIES: dict[str, set[str]] = {
    "work": {"project", "colleague", "career", "deadline", "commitment", "decision"},
    "gaming": {"game", "achievement", "gaming_team", "strategy"},
    "life": {"family", "health", "personal_goal", "life_event", "relationship"},
}

# All custom categories (base 9 + context-specific)
CUSTOM_CATEGORIES: list[str] = [
    # Base 9 (from spec — apply across all contexts)
    "fact", "feeling", "decision", "lesson", "commitment",
    "preference", "relationship", "pattern", "ritual_context",
    # Work context
    "project", "colleague", "career", "deadline",
    # Gaming context
    "game", "achievement", "gaming_team", "strategy",
    # Life context
    "family", "health", "personal_goal", "life_event",
]

_CACHE_TTL = 60  # seconds
_CACHE_MAX_SIZE = 256

# Thread-safe bounded TTL cache
_cache: TTLCache = TTLCache(maxsize=_CACHE_MAX_SIZE, ttl=_CACHE_TTL)
_cache_lock = threading.Lock()

# Module-level client singleton
_client = None
_client_initialized = False
_client_lock = threading.Lock()


def _get_client():
    """Lazy-initialize the Mem0 client (singleton, thread-safe)."""
    global _client, _client_initialized
    if _client_initialized:
        return _client
    with _client_lock:
        if _client_initialized:
            return _client
        try:
            from mem0 import MemoryClient

            api_key = os.environ.get("MEM0_API_KEY", "")
            if not api_key:
                logger.warning("MEM0_API_KEY not set — memory retrieval disabled")
                _client = None
            else:
                _client = MemoryClient(api_key=api_key)
        except ImportError:
            logger.warning("mem0 package not installed — memory retrieval disabled")
            _client = None
        _client_initialized = True
        return _client


def search_memories(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
    context_mode: str | None = None,
) -> list[dict]:
    """Search Mem0 for memories matching the query, categories, and context.

    Args:
        user_id: The user identifier.
        query: Semantic search query.
        categories: Optional list of categories to filter by.
        context_mode: Optional context mode (work/gaming/life) to prioritize
            context-specific memories. Memories from other contexts are still
            returned but ranked lower.

    Returns a list of memory dicts with 'id', 'content', and 'category' fields.
    Results are cached per (user_id, query, categories, context_mode) for 60 seconds.
    Thread-safe with bounded cache size.
    """
    cache_key = f"{user_id}:{query}:{','.join(sorted(categories or []))}:{context_mode or ''}"

    # Check cache (thread-safe)
    with _cache_lock:
        cached_results = _cache.get(cache_key)
        if cached_results is not None:
            logger.info("[Mem0Cache] HIT (%d results cached)", len(cached_results))
            return cached_results

    logger.info("[Mem0Cache] MISS — calling Mem0 API")
    client = _get_client()
    if client is None:
        return []

    try:
        # Mem0 v2 API requires filters dict instead of top-level params
        results = client.search(
            query=query,
            filters={"user_id": user_id},
            limit=10,
        )

        # Normalize results to list of dicts
        memories = []
        if isinstance(results, dict) and "results" in results:
            results = results["results"]
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict):
                    meta = r.get("metadata") or {}
                    memories.append({
                        "id": r.get("id", ""),
                        "content": r.get("memory", r.get("content", "")),
                        "category": meta.get("category", "") if isinstance(meta, dict) else "",
                    })

        # Filter by categories if specified
        pre_filter_count = len(memories)
        if categories:
            memories = [m for m in memories if not m["category"] or m["category"] in categories]
        filtered_out = pre_filter_count - len(memories)
        if filtered_out > 0:
            logger.info("[Mem0Search] filtered out %d/%d memories (not in requested categories)", filtered_out, pre_filter_count)

        # Sort by context relevance if context_mode specified
        if context_mode:
            context_categories = _CONTEXT_CATEGORIES.get(context_mode, set())
            # Memories matching the context's categories come first
            memories.sort(
                key=lambda m: (
                    0 if m.get("category") in context_categories else 1,
                ),
            )

        # Update cache (thread-safe, bounded by TTLCache maxsize)
        with _cache_lock:
            _cache[cache_key] = memories

        return memories

    except Exception:
        logger.warning("Mem0 search failed for user %s", user_id, exc_info=True)
        return []


def add_memories(
    user_id: str,
    messages: list[dict],
    session_id: str,
    metadata: dict | None = None,
) -> list[dict]:
    """Write memories to Mem0 for a user session.

    Calls Mem0 SDK client.add() with user_id scoping.
    NOTE: the installed Mem0 SDK strips metadata from add() requests, so when
    metadata is provided this wrapper backfills it with per-memory update()
    calls after creation. This path forces synchronous add() responses so the
    created memory IDs are available immediately for the metadata backfill.
    agent_id is NOT passed — Mem0 v2 creates a separate namespace for
    agent-scoped memories that is unreachable from user_id-only searches.
    Thread-safe: acquires lock around SDK call, then invalidates the user cache
    so subsequent searches reflect the new data.

    Returns the result from the SDK (typically a list of memory dicts),
    or an empty list if Mem0 is unavailable or the call fails.
    """
    client = _get_client()
    if client is None:
        return []

    try:
        add_kwargs = {
            "messages": messages,
            "user_id": user_id,
            "async_mode": False,
        }

        result = client.add(**add_kwargs)

        normalized_result = _normalize_add_result(result)
        first_item = normalized_result[0] if normalized_result else None
        logger.info(
            "session.finalization mem0_add_response user_id=%s session_id=%s result_type=%s normalized_count=%s first_item_id=%s metadata_keys=%s first_item_keys=%s",
            user_id,
            session_id,
            type(result).__name__,
            len(normalized_result),
            first_item.get("id") if isinstance(first_item, dict) else None,
            sorted(metadata.keys()) if isinstance(metadata, dict) else None,
            sorted(first_item.keys()) if isinstance(first_item, dict) else None,
        )

        if metadata:
            normalized_result = _apply_metadata_updates(
                client=client,
                memories=normalized_result,
                messages=messages,
                metadata=metadata,
                user_id=user_id,
                session_id=session_id,
            )

        # Invalidate cache so searches reflect new memories
        invalidate_user_cache(user_id)

        return normalized_result

    except Exception:
        logger.warning("Mem0 add failed for user %s", user_id, exc_info=True)
        return []


def _normalize_add_result(result: object) -> list[dict]:
    if isinstance(result, dict) and "results" in result:
        nested_results = result["results"]
        return nested_results if isinstance(nested_results, list) else [nested_results]
    if isinstance(result, list):
        return result
    return [result] if isinstance(result, dict) and result else []


def _apply_metadata_updates(
    *,
    client,
    memories: list[dict],
    messages: list[dict],
    metadata: dict,
    user_id: str,
    session_id: str,
) -> list[dict]:
    updated_memories: list[dict] = []

    for memory in memories:
        memory_text = _extract_memory_text(memory, messages)
        memory_id = _resolve_memory_id_for_update(
            client=client,
            memory=memory,
            memory_text=memory_text,
            user_id=user_id,
            session_id=session_id,
        )

        upsert_review_metadata(
            user_id,
            memory_id=memory_id,
            content=memory_text,
            metadata=metadata,
            session_id=session_id,
            sync_state="pending",
        )

        merged_memory = dict(memory) if isinstance(memory, dict) else {}
        if memory_id:
            merged_memory["id"] = memory_id
        if memory_text and not merged_memory.get("memory"):
            merged_memory["memory"] = memory_text
        merged_memory["metadata"] = dict(metadata)

        category = metadata.get("category") if isinstance(metadata, dict) else None
        if category:
            if merged_memory.get("category") is None:
                merged_memory["category"] = category
            if not merged_memory.get("categories"):
                merged_memory["categories"] = [category]

        if not memory_id:
            updated_memories.append(merged_memory)
            continue

        try:
            logger.info(
                "session.finalization mem0_update_attempt user_id=%s session_id=%s memory_id=%s metadata_keys=%s",
                user_id,
                session_id,
                memory_id,
                sorted(metadata.keys()),
            )
            updated_memory = _update_memory_metadata_via_rest(
                client=client,
                memory_id=memory_id,
                metadata=metadata,
            )
            upsert_review_metadata(
                user_id,
                memory_id=memory_id,
                content=memory_text,
                metadata=metadata,
                session_id=session_id,
                sync_state="synced",
            )
        except Exception:
            logger.warning(
                "Mem0 metadata update failed for user %s session %s memory %s",
                user_id,
                session_id,
                memory_id,
                exc_info=True,
            )
            upsert_review_metadata(
                user_id,
                memory_id=memory_id,
                content=memory_text,
                metadata=metadata,
                session_id=session_id,
                sync_state="local_only",
            )
            updated_memories.append(merged_memory)
            continue

        if isinstance(updated_memory, dict):
            merged_memory.update(updated_memory)
        merged_memory["id"] = memory_id
        merged_memory["metadata"] = metadata
        updated_memories.append(merged_memory)

    return updated_memories


def _resolve_memory_id_for_update(
    *,
    client,
    memory: dict,
    memory_text: str | None,
    user_id: str,
    session_id: str,
) -> str | None:
    if not isinstance(memory, dict):
        return None

    memory_id = memory.get("id")
    if memory_id:
        return memory_id

    resolved_memory_text = memory_text or memory.get("memory") or memory.get("content")
    if not resolved_memory_text:
        return None

    for attempt in range(3):
        try:
            recent_memories = client.get_all(filters={"user_id": user_id})
        except Exception:
            logger.warning(
                "Mem0 memory-id resolution failed for user %s session %s",
                user_id,
                session_id,
                exc_info=True,
            )
            return None

        normalized_recent = _normalize_get_all_result(recent_memories)
        for recent_memory in reversed(normalized_recent):
            if not isinstance(recent_memory, dict):
                continue
            recent_text = recent_memory.get("memory") or recent_memory.get("content")
            recent_id = recent_memory.get("id")
            if recent_id and recent_text == resolved_memory_text:
                logger.info(
                    "session.finalization mem0_id_resolved_from_get_all user_id=%s session_id=%s memory_id=%s attempt=%s",
                    user_id,
                    session_id,
                    recent_id,
                    attempt + 1,
                )
                return recent_id

        if attempt < 2:
            time.sleep(0.25)

    logger.warning(
        "Mem0 returned no usable id for user %s session %s",
        user_id,
        session_id,
    )
    return None


def _normalize_get_all_result(result: object) -> list[dict]:
    if isinstance(result, dict) and "results" in result:
        nested_results = result["results"]
        return nested_results if isinstance(nested_results, list) else [nested_results]
    if isinstance(result, list):
        return result
    return []


def _extract_memory_text(memory: dict, messages: list[dict]) -> str:
    if isinstance(memory, dict):
        text = memory.get("memory") or memory.get("content")
        if isinstance(text, str) and text.strip():
            return text.strip()

    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()

    return ""


def _update_memory_metadata_via_rest(*, client, memory_id: str, metadata: dict) -> dict:
    params = {}
    if getattr(client, "org_id", None):
        params["org_id"] = client.org_id
    if getattr(client, "project_id", None):
        params["project_id"] = client.project_id

    response = client.client.put(
        f"/v1/memories/{memory_id}/",
        json={"metadata": metadata},
        params=params or None,
    )
    response.raise_for_status()
    result = response.json()
    return result if isinstance(result, dict) else {}


def reconcile_review_metadata_with_mem0(user_id: str) -> int:
    client = _get_client()
    if client is None:
        return 0

    try:
        result = client.get_all(filters={"user_id": user_id})
    except Exception:
        logger.warning("Mem0 reconciliation fetch failed for user %s", user_id, exc_info=True)
        return 0

    reconciled = reconcile_review_metadata_entries(user_id, _normalize_get_all_result(result))
    if reconciled:
        invalidate_user_cache(user_id)
        logger.info("session.finalization review_metadata_reconciled user_id=%s count=%s", user_id, reconciled)
    return reconciled


def invalidate_user_cache(user_id: str) -> None:
    """Clear all cached results for a user. Call after Mem0 writes."""
    prefix = f"{user_id}:"
    with _cache_lock:
        keys_to_remove = [k for k in _cache if k.startswith(prefix)]
        for k in keys_to_remove:
            del _cache[k]
