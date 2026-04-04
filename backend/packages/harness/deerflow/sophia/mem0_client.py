"""Mem0 SDK wrapper with thread-safe bounded cache.

Provides cached search_memories() for the middleware and tools.
Cache has 60-second TTL and 256-entry max size via cachetools.TTLCache.
invalidate_user_cache() clears after writes. MemoryClient is cached at
module level (singleton).
"""

import logging
import os
import threading

from cachetools import TTLCache

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
        if categories:
            memories = [m for m in memories if not m["category"] or m["category"] in categories]

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

    Calls Mem0 SDK client.add() with user_id scoping and full metadata dict.
    NOTE: agent_id is NOT passed — Mem0 v2 creates a separate namespace for
    agent-scoped memories that is unreachable from user_id-only searches.
    Thread-safe: acquires lock around SDK call, then invalidates the user
    cache so subsequent searches reflect the new data.

    Returns the result from the SDK (typically a list of memory dicts),
    or an empty list if Mem0 is unavailable or the call fails.
    """
    client = _get_client()
    if client is None:
        return []

    try:
        # Explicitly pass org_id/project_id to ensure memories land in the
        # correct project scope (the SDK's _prepare_params should do this
        # automatically, but being explicit prevents the orphaned-memory
        # issue seen when the client's init ping hasn't completed yet).
        # NOTE: Do NOT pass metadata={} to client.add().
        # Mem0 v2 silently drops memories that include custom metadata.
        # All context (category, importance, etc.) is embedded in the
        # memory text by the extraction prompt instead.
        add_kwargs = {
            "messages": messages,
            "user_id": user_id,
        }

        result = client.add(**add_kwargs)

        # Invalidate cache so searches reflect new memories
        invalidate_user_cache(user_id)

        # Normalize to list
        if isinstance(result, dict) and "results" in result:
            return result["results"]
        if isinstance(result, list):
            return result
        return [result] if result else []

    except Exception:
        logger.warning("Mem0 add failed for user %s", user_id, exc_info=True)
        return []


def invalidate_user_cache(user_id: str) -> None:
    """Clear all cached results for a user. Call after Mem0 writes."""
    prefix = f"{user_id}:"
    with _cache_lock:
        keys_to_remove = [k for k in _cache if k.startswith(prefix)]
        for k in keys_to_remove:
            del _cache[k]
