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
from typing import Any

try:
    from cachetools import TTLCache
except ImportError:  # pragma: no cover - exercised from the slim voice runtime

    class TTLCache(dict):  # type: ignore[no-redef]
        def __init__(self, *, maxsize: int, ttl: int):
            super().__init__()
            self.maxsize = maxsize
            self.ttl = ttl
            self._expires_at: dict[Any, float] = {}

        def get(self, key, default=None):  # noqa: ANN001, ANN202
            self._purge_expired()
            return super().get(key, default)

        def __setitem__(self, key, value) -> None:  # noqa: ANN001
            self._purge_expired()
            if len(self) >= self.maxsize and key not in self:
                oldest_key = next(iter(self), None)
                if oldest_key is not None:
                    super().pop(oldest_key, None)
                    self._expires_at.pop(oldest_key, None)
            self._expires_at[key] = time.monotonic() + self.ttl
            super().__setitem__(key, value)

        def pop(self, key, default=None):  # noqa: ANN001, ANN202
            self._expires_at.pop(key, None)
            return super().pop(key, default)

        def __iter__(self):  # noqa: ANN204
            self._purge_expired()
            return super().__iter__()

        def _purge_expired(self) -> None:
            now = time.monotonic()
            expired = [key for key, expires_at in self._expires_at.items() if expires_at <= now]
            for key in expired:
                super().pop(key, None)
                self._expires_at.pop(key, None)


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
    "fact",
    "feeling",
    "decision",
    "lesson",
    "commitment",
    "preference",
    "relationship",
    "pattern",
    "ritual_context",
    # Work context
    "project",
    "colleague",
    "career",
    "deadline",
    # Gaming context
    "game",
    "achievement",
    "gaming_team",
    "strategy",
    # Life context
    "family",
    "health",
    "personal_goal",
    "life_event",
]

_CACHE_TTL = 60  # seconds
_CACHE_MAX_SIZE = 256

# Thread-safe bounded TTL cache
_cache: TTLCache = TTLCache(maxsize=_CACHE_MAX_SIZE, ttl=_CACHE_TTL)
_cache_lock = threading.Lock()

# Module-level client singleton
_client = None
_client_initialized = False
_client_unavailable_reason: str | None = None
_client_lock = threading.Lock()
_warm_up_completed = False
_warm_up_lock = threading.Lock()


class MemoryProviderUnavailableError(RuntimeError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


class MemoryProviderSearchError(RuntimeError):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _get_client():
    """Lazy-initialize the Mem0 client (singleton, thread-safe)."""
    global _client, _client_initialized, _client_unavailable_reason
    if _client_initialized:
        return _client
    with _client_lock:
        if _client_initialized:
            return _client
        api_key = os.environ.get("MEM0_API_KEY", "").strip()
        if not api_key:
            logger.warning("MEM0_API_KEY not set — memory retrieval disabled")
            _client = None
            _client_unavailable_reason = "missing_api_key"
            _client_initialized = True
            return _client
        try:
            from deerflow.sophia.memory_governance.mem0_projection_adapter import LegacyMem0Facade

            _client = LegacyMem0Facade()
            _client.ensure_client()
            _client_unavailable_reason = None
            logger.info("[Mem0] Client initialized successfully")
        except ImportError:
            logger.warning("mem0 package not installed — memory retrieval disabled")
            _client = None
            _client_unavailable_reason = "missing_mem0_sdk"
        except Exception:
            logger.warning("Mem0 client initialization failed", exc_info=True)
            _client = None
            _client_unavailable_reason = "client_initialization_failed"
        _client_initialized = True
        return _client


def _httpx_module():
    try:
        import httpx
    except ImportError:
        return None
    return httpx


def _rest_fallback_available() -> bool:
    return bool(os.environ.get("MEM0_API_KEY", "").strip()) and _httpx_module() is not None


def _memory_provider_status_from_client() -> dict[str, Any]:
    client = _get_client()
    if client is not None:
        return {
            "available": True,
            "provider_status": "available",
            "provider_reason": "sdk_client",
            "provider_transport": "mem0_sdk",
        }

    api_key_present = bool(os.environ.get("MEM0_API_KEY", "").strip())
    if not api_key_present:
        return {
            "available": False,
            "provider_status": "unavailable",
            "provider_reason": "missing_api_key",
            "provider_transport": "none",
        }

    if _rest_fallback_available():
        return {
            "available": True,
            "provider_status": "available",
            "provider_reason": "rest_fallback",
            "provider_transport": "mem0_rest",
            "sdk_unavailable_reason": _client_unavailable_reason or "missing_mem0_sdk",
        }

    return {
        "available": False,
        "provider_status": "unavailable",
        "provider_reason": _client_unavailable_reason or "client_unavailable",
        "provider_transport": "none",
    }


def warm_up() -> None:
    """Eagerly initialize the Mem0 client and verify connectivity.

    Call at startup (e.g., in make_sophia_agent) so the first user
    request doesn't pay the cold-start latency (~1-2s for client init + ping).
    Safe to call multiple times — the client is a singleton.
    """
    global _warm_up_completed

    from deerflow.sophia.memory_governance.flags import memory_feature_flags

    if memory_feature_flags().governed_runtime_read:
        # Governed retrieval has no content-bearing warmup query. Adapter and
        # database availability are exercised by readiness/canary probes.
        _warm_up_completed = True
        return

    if _warm_up_completed:
        return

    with _warm_up_lock:
        if _warm_up_completed:
            return

        _t0 = time.perf_counter()
        client = _get_client()
        if client is None:
            logger.warning("[Mem0] warm_up: client unavailable")
            _warm_up_completed = True
            return

        try:
            # The Mem0 SDK pings the server on first API call.
            # Do a lightweight search to trigger that ping now.
            client.search(query="warm_up", filters={"user_id": "__warmup__"}, limit=1)
            elapsed = (time.perf_counter() - _t0) * 1000
            logger.info("[Mem0] warm_up completed (%.0fms)", elapsed)
        except Exception:
            elapsed = (time.perf_counter() - _t0) * 1000
            logger.warning("[Mem0] warm_up ping failed (%.0fms)", elapsed, exc_info=True)
        finally:
            _warm_up_completed = True


def search_memories(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
    context_mode: str | None = None,
    limit: int = 10,
    log_content_previews: bool = True,
    raise_on_error: bool = False,
    caller: str = "legacy_facade",
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
    Results are cached per (user_id, query, categories, context_mode, limit)
    for 60 seconds.
    Thread-safe with bounded cache size.
    """
    result = search_memories_with_diagnostics(
        user_id=user_id,
        query=query,
        categories=categories,
        context_mode=context_mode,
        limit=limit,
        log_content_previews=log_content_previews,
        raise_on_error=raise_on_error,
        caller=caller,
    )
    return result["memories"]


def search_memories_with_diagnostics(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
    context_mode: str | None = None,
    limit: int = 10,
    log_content_previews: bool = True,
    raise_on_error: bool = False,
    caller: str = "legacy_facade",
) -> dict[str, Any]:
    """Search Mem0 and return privacy-safe provider diagnostics with results."""
    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )

    if memory_feature_flags_for_owner(user_id).governed_runtime_read:
        from deerflow.sophia.memory_governance.mem0_projection_adapter import (
            Mem0ProjectionAdapter,
        )
        from deerflow.sophia.memory_governance.reader import GovernedMemoryReader
        from deerflow.sophia.memory_governance.service import MemoryProviderContract
        from deerflow.sophia.memory_governance.store import configured_memory_store

        started = time.perf_counter()
        reader = GovernedMemoryReader(
            store=configured_memory_store(),
            adapter=Mem0ProjectionAdapter(),
            provider=MemoryProviderContract.from_environ(),
            service_name=(os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph"),
        )
        governed = reader.retrieve(
            owner_id=user_id,
            caller=caller,
            scope=context_mode or "global",
            query=query,
            limit=limit,
        )
        memories = [
            {
                "id": str(memory.memory_id),
                "content": memory.canonical_content,
                "category": memory.category or "",
                "score": memory.score,
                "content_revision": memory.content_revision,
                "memory_governance_revision": memory.memory_governance_revision,
                "authority": "sophia_canonical",
            }
            for memory in governed.memories
        ]
        if categories:
            memories = [item for item in memories if item["category"] in categories]
        return {
            "memories": memories,
            "provider_status": governed.receipt.provider_status,
            "provider_reason": governed.receipt.safe_reason_code or "governed",
            "provider_transport": "mem0_ids_canonical_join",
            "cache_status": "disabled_governed",
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "retrieval_receipt": governed.receipt.model_dump(mode="json"),
        }
    cache_key = f"{user_id}:{query}:{','.join(sorted(categories or []))}:{context_mode or ''}:{limit}"

    # Check cache (thread-safe)
    with _cache_lock:
        cached_results = _cache.get(cache_key)
        if cached_results is not None:
            logger.info("[Mem0Cache] HIT (%d results cached)", len(cached_results))
            return {
                "memories": cached_results,
                "provider_status": "available",
                "provider_reason": "cache_hit",
                "provider_transport": "cache",
                "cache_status": "hit",
                "latency_ms": 0,
            }

    logger.info("[Mem0Cache] MISS — calling Mem0 API (query='%s' limit=%d)", query[:80], limit)
    provider_status = memory_provider_status()
    if not provider_status.get("available"):
        if raise_on_error:
            raise MemoryProviderUnavailableError(str(provider_status.get("provider_reason") or "client_unavailable"))
        return {
            "memories": [],
            "provider_status": provider_status.get("provider_status", "unavailable"),
            "provider_reason": provider_status.get("provider_reason", "client_unavailable"),
            "provider_transport": provider_status.get("provider_transport", "none"),
            "cache_status": "miss",
            "latency_ms": 0,
        }

    _t0 = time.perf_counter()
    try:
        provider_transport = str(provider_status.get("provider_transport") or "mem0_sdk")
        client = _get_client()
        if client is not None:
            # Mem0 v2 API requires filters dict instead of top-level params
            results = client.search(
                query=query,
                filters={"user_id": user_id},
                limit=limit,
            )
        else:
            results = _search_memories_via_rest(user_id=user_id, query=query, limit=limit)
            provider_transport = "mem0_rest"

        api_ms = (time.perf_counter() - _t0) * 1000

        # Normalize results to list of dicts
        memories = []
        if isinstance(results, dict) and "results" in results:
            results = results["results"]
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict):
                    meta = r.get("metadata") or {}
                    score = r.get("score", r.get("relevance_score"))
                    memories.append(
                        {
                            "id": r.get("id", ""),
                            "content": r.get("memory", r.get("content", "")),
                            "category": meta.get("category", "") if isinstance(meta, dict) else "",
                            "score": score,
                        }
                    )

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
            memories.sort(
                key=lambda m: (0 if m.get("category") in context_categories else 1,),
            )

        # Log each retrieved memory with score and content preview when allowed.
        # Realtime voice tools disable this so telemetry/log diagnostics do not
        # duplicate raw memory text outside the actual tool result.
        logger.info(
            "[Mem0Search] %d results in %.0fms (query='%s')",
            len(memories),
            api_ms,
            query[:60],
        )
        if log_content_previews:
            for i, mem in enumerate(memories):
                score_str = f" score={mem['score']:.3f}" if mem.get("score") is not None else ""
                logger.info(
                    "[Mem0Search]   [%d] [%s]%s %s",
                    i,
                    mem.get("category", "?"),
                    score_str,
                    (mem.get("content", ""))[:120],
                )

        # Update cache (thread-safe, bounded by TTLCache maxsize)
        with _cache_lock:
            _cache[cache_key] = memories

        return {
            "memories": memories,
            "provider_status": "available",
            "provider_reason": provider_status.get("provider_reason", "sdk_client"),
            "provider_transport": provider_transport,
            "cache_status": "miss",
            "latency_ms": int(api_ms),
        }

    except Exception:
        elapsed_ms = int((time.perf_counter() - _t0) * 1000)
        logger.warning("Mem0 search failed for user %s (%.0fms)", user_id, elapsed_ms, exc_info=True)
        if raise_on_error:
            raise MemoryProviderSearchError("provider_exception")
        return {
            "memories": [],
            "provider_status": "error",
            "provider_reason": "provider_exception",
            "provider_transport": provider_status.get("provider_transport", "unknown"),
            "cache_status": "miss",
            "latency_ms": elapsed_ms,
        }


def memory_provider_available() -> bool:
    """Return whether the Mem0 client is configured and importable."""
    return bool(memory_provider_status().get("available"))


def memory_provider_status() -> dict[str, Any]:
    """Return privacy-safe Mem0 availability details for diagnostics."""
    from deerflow.sophia.memory_governance.flags import memory_feature_flags

    if memory_feature_flags().governed_runtime_read:
        configured = bool(os.environ.get("MEM0_API_KEY", "").strip()) and bool(os.environ.get("SOPHIA_MEMORY_PROVIDER_PROJECT", "").strip())
        return {
            "available": configured,
            "provider_status": "available" if configured else "unavailable",
            "provider_reason": "governed_contract" if configured else "governed_contract_unconfigured",
            "provider_transport": "mem0_ids_canonical_join" if configured else "none",
        }
    try:
        return _memory_provider_status_from_client()
    except Exception:
        logger.warning("Mem0 provider status check failed", exc_info=True)
        return {
            "available": False,
            "provider_status": "unavailable",
            "provider_reason": "provider_status_exception",
            "provider_transport": "none",
        }


def _search_memories_via_rest(*, user_id: str, query: str, limit: int) -> dict[str, Any]:
    httpx = _httpx_module()
    api_key = os.environ.get("MEM0_API_KEY", "").strip()
    if httpx is None:
        raise MemoryProviderUnavailableError("missing_httpx")
    if not api_key:
        raise MemoryProviderUnavailableError("missing_api_key")

    from deerflow.sophia.memory_governance.mem0_projection_adapter import (
        PINNED_MEM0_HOST,
        legacy_search_via_rest,
    )

    host = (os.environ.get("MEM0_BASE_URL") or PINNED_MEM0_HOST).rstrip("/")
    return legacy_search_via_rest(
        httpx_module=httpx,
        api_key=api_key,
        host=host,
        user_id=user_id,
        query=query,
        limit=limit,
    )


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
    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )

    if memory_feature_flags_for_owner(user_id).candidate_ledger_write:
        raise MemoryProviderUnavailableError("raw_memory_write_disabled_by_mem00")
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
    if not hasattr(client, "update_metadata"):
        raise MemoryProviderUnavailableError("metadata_update_boundary_unavailable")
    return client.update_metadata(memory_id=memory_id, metadata=metadata)


def reconcile_review_metadata_with_mem0(user_id: str) -> int:
    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )

    if memory_feature_flags_for_owner(user_id).candidate_ledger_write:
        return 0
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


# ---------------------------------------------------------------------------
# Eager startup: init client + ping in a background thread so the first
# request doesn't pay the ~2s cold-start.  Runs once at module import time
# (when LangGraph loads the sophia_companion graph).
# ---------------------------------------------------------------------------
def _startup_warm_up() -> None:
    """Background thread target — initializes client and pings Mem0."""
    warm_up()


_warmup_thread = threading.Thread(target=_startup_warm_up, daemon=True, name="mem0-warmup")
_warmup_thread.start()
