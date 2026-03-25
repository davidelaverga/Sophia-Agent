"""Mem0 SDK wrapper with LRU cache.

Provides cached search_memories() for the middleware and tools.
Cache has 60-second TTL. invalidate_user_cache() clears after writes.
"""

import logging
import os
import time
from functools import lru_cache

logger = logging.getLogger(__name__)

_cache: dict[str, tuple[float, list[dict]]] = {}
_CACHE_TTL = 60  # seconds


def _get_client():
    """Lazy-initialize the Mem0 client."""
    try:
        from mem0 import MemoryClient

        api_key = os.environ.get("MEM0_API_KEY", "")
        if not api_key:
            logger.warning("MEM0_API_KEY not set — memory retrieval disabled")
            return None
        return MemoryClient(api_key=api_key)
    except ImportError:
        logger.warning("mem0 package not installed — memory retrieval disabled")
        return None


def search_memories(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
) -> list[dict]:
    """Search Mem0 for memories matching the query and categories.

    Returns a list of memory dicts with 'id' and 'content' fields.
    Results are cached per (user_id, query, categories) for 60 seconds.
    """
    cache_key = f"{user_id}:{query}:{','.join(sorted(categories or []))}"
    now = time.time()

    # Check cache
    if cache_key in _cache:
        cached_time, cached_results = _cache[cache_key]
        if now - cached_time < _CACHE_TTL:
            return cached_results

    client = _get_client()
    if client is None:
        return []

    try:
        results = client.search(
            query=query,
            user_id=user_id,
            agent_id="sophia_companion",
            limit=10,
        )

        # Normalize results to list of dicts
        memories = []
        if isinstance(results, dict) and "results" in results:
            results = results["results"]
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict):
                    memories.append({
                        "id": r.get("id", ""),
                        "content": r.get("memory", r.get("content", "")),
                        "category": r.get("metadata", {}).get("category", ""),
                    })

        # Filter by categories if specified
        if categories:
            memories = [m for m in memories if not m["category"] or m["category"] in categories]

        # Update cache
        _cache[cache_key] = (now, memories)
        return memories

    except Exception:
        logger.warning("Mem0 search failed for user %s", user_id, exc_info=True)
        return []


def invalidate_user_cache(user_id: str) -> None:
    """Clear all cached results for a user. Call after Mem0 writes."""
    keys_to_remove = [k for k in _cache if k.startswith(f"{user_id}:")]
    for k in keys_to_remove:
        del _cache[k]
