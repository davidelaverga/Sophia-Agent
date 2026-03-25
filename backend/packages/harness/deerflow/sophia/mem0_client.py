"""Mem0 SDK wrapper with thread-safe bounded cache.

Provides cached search_memories() for the middleware and tools.
Cache has 60-second TTL and 256-entry max size. invalidate_user_cache()
clears after writes. MemoryClient is cached at module level (singleton).
"""

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

_CACHE_TTL = 60  # seconds
_CACHE_MAX_SIZE = 256

# Thread-safe cache with bounded size
_cache: dict[str, tuple[float, list[dict]]] = {}
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


def _evict_oldest_if_full() -> None:
    """Evict oldest cache entries if cache exceeds max size. Caller must hold _cache_lock."""
    if len(_cache) >= _CACHE_MAX_SIZE:
        # Remove oldest 10% to avoid evicting on every insert
        entries = sorted(_cache.items(), key=lambda x: x[1][0])
        to_remove = max(1, _CACHE_MAX_SIZE // 10)
        for key, _ in entries[:to_remove]:
            del _cache[key]


def search_memories(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
) -> list[dict]:
    """Search Mem0 for memories matching the query and categories.

    Returns a list of memory dicts with 'id' and 'content' fields.
    Results are cached per (user_id, query, categories) for 60 seconds.
    Thread-safe with bounded cache size.
    """
    cache_key = f"{user_id}:{query}:{','.join(sorted(categories or []))}"
    now = time.time()

    # Check cache (thread-safe)
    with _cache_lock:
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

        # Update cache (thread-safe, bounded)
        with _cache_lock:
            _evict_oldest_if_full()
            _cache[cache_key] = (now, memories)

        return memories

    except Exception:
        logger.warning("Mem0 search failed for user %s", user_id, exc_info=True)
        return []


def invalidate_user_cache(user_id: str) -> None:
    """Clear all cached results for a user. Call after Mem0 writes."""
    with _cache_lock:
        keys_to_remove = [k for k in _cache if k.startswith(f"{user_id}:")]
        for k in keys_to_remove:
            del _cache[k]
