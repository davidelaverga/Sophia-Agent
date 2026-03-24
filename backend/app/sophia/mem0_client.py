"""Mem0 SDK wrapper with LRU cache.

60-second TTL. Cache hits ~70% of turns within a session.
Call invalidate_user_cache(user_id) after any Mem0 write.

9 custom categories configured in CLAUDE.md § Mem0.
"""

from __future__ import annotations

import os
import time
from functools import lru_cache

CACHE_TTL_SECONDS = 60

# Category definitions for Mem0 configuration
CUSTOM_CATEGORIES = [
    {"fact": "Static user info — name, job, location. High stability."},
    {"feeling": "Emotional patterns. ALWAYS include tone_estimate in metadata."},
    {"decision": "Genuine decisions made. Not considerations."},
    {"lesson": "Insights the user articulated or realized."},
    {"commitment": "Goals, deadlines, stated intentions."},
    {"preference": "Communication style, how they want to be treated."},
    {"relationship": "People in the user's life — names, roles, dynamics."},
    {"pattern": "Recurring behavioral observations. Require 2+ session evidence."},
    {"ritual_context": "How the user uses each ritual — what works, preferences."},
]

# Simple TTL cache for user memories
_cache: dict[str, tuple[float, list]] = {}


def get_client():
    """Lazy-initialize Mem0 client."""
    # TODO(jorge): Initialize MemoryClient with MEM0_API_KEY
    # from mem0 import MemoryClient
    # return MemoryClient(api_key=os.environ["MEM0_API_KEY"])
    return None


def search_memories(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
    limit: int = 10,
) -> list[dict]:
    """Search user memories with optional category filter and LRU cache."""
    cache_key = f"{user_id}:{query}:{categories}"
    now = time.time()

    if cache_key in _cache:
        cached_time, cached_result = _cache[cache_key]
        if now - cached_time < CACHE_TTL_SECONDS:
            return cached_result

    # TODO(jorge): Implement actual Mem0 search
    results: list[dict] = []
    _cache[cache_key] = (now, results)
    return results


def add_memory(
    user_id: str,
    messages: list[dict],
    session_id: str,
    metadata: dict,
) -> None:
    """Write memory to Mem0 with full metadata."""
    # TODO(jorge): Implement Mem0 write
    # client.add(messages, user_id=user_id, agent_id="sophia_companion",
    #            run_id=session_id, metadata=metadata)
    invalidate_user_cache(user_id)


def invalidate_user_cache(user_id: str) -> None:
    """Clear all cached entries for a user after a Mem0 write."""
    keys_to_delete = [k for k in _cache if k.startswith(f"{user_id}:")]
    for k in keys_to_delete:
        del _cache[k]
