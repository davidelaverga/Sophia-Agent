"""Mem0 SDK v3 wrapper with thread-safe bounded cache.

Provides cached search_memories() for the middleware and tools.
Cache has 60-second TTL and 256-entry max size via cachetools.TTLCache.
invalidate_user_cache() clears after writes. MemoryClient is cached at
module level (singleton).

v3 changes from v2:
- metadata passed directly via client.add() — no REST backfill.
- client.add() is async-by-default; we return event_id rows and
  optionally wait for pending events.
- search supports reference_date for temporal queries (D1).
- get_all returns a paginated envelope {count, next, previous, results}.
- expiration_date set natively for contextual memories.
- category post-filter removed — trust platform hybrid retrieval (Upgrade B).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from cachetools import TTLCache

logger = logging.getLogger(__name__)

_CACHE_TTL = 60  # seconds
_CACHE_MAX_SIZE = 256

# Thread-safe bounded TTL cache
_cache: TTLCache = TTLCache(maxsize=_CACHE_MAX_SIZE, ttl=_CACHE_TTL)
_cache_lock = threading.Lock()

# Module-level client singleton
_client: Any | None = None
_client_initialized: bool = False
_client_lock = threading.Lock()
_warm_up_completed: bool = False
_warm_up_lock = threading.Lock()


class Mem0EventFailedError(RuntimeError):
    """Raised when a Mem0 async add event reaches FAILED status."""


# ---------------------------------------------------------------------------
# Feature flags (read once at import, environment-driven)
# ---------------------------------------------------------------------------


def _env_bool(name: str, default: bool = False) -> bool:
    val = os.environ.get(name, "").lower().strip()
    if val in ("1", "true", "yes", "on"):
        return True
    if val in ("0", "false", "no", "off"):
        return False
    return default


MEM0_V3_ENABLED: bool = _env_bool("MEM0_V3_ENABLED", True)
MEM0_REFERENCE_DATE_ENABLED: bool = _env_bool("MEM0_REFERENCE_DATE_ENABLED", True)
MEM0_REMOVE_CATEGORY_FILTER_ENABLED: bool = _env_bool(
    "MEM0_REMOVE_CATEGORY_FILTER_ENABLED", True
)


# ---------------------------------------------------------------------------
# Client lifecycle
# ---------------------------------------------------------------------------


def _get_client() -> Any | None:
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
                logger.info("[Mem0] Client initialized successfully (v3)")
        except ImportError:
            logger.warning("mem0 package not installed — memory retrieval disabled")
            _client = None
        _client_initialized = True
        return _client


def warm_up() -> None:
    """Eagerly initialize the Mem0 client and verify connectivity."""
    global _warm_up_completed
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
            client.search(query="warm_up", filters={"user_id": "__warmup__"}, limit=1)
            elapsed = (time.perf_counter() - _t0) * 1000
            logger.info("[Mem0] warm_up completed (%.0fms)", elapsed)
        except Exception:
            elapsed = (time.perf_counter() - _t0) * 1000
            logger.warning(
                "[Mem0] warm_up ping failed (%.0fms)", elapsed, exc_info=True
            )
        finally:
            _warm_up_completed = True


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def search_memories(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
    context_mode: str | None = None,
    *,
    reference_date: datetime | None = None,
    limit: int = 25,
) -> list[dict]:
    """Search Mem0 for memories matching the query.

    Args:
        user_id: The user identifier.
        query: Semantic search query.
        categories: DEPRECATED — v3 hybrid retrieval handles relevance
            internally. Kept for backward compatibility during migration.
        context_mode: DEPRECATED — no longer used for client-side sorting.
        reference_date: Optional datetime used by v3 temporal reasoning
            to resolve relative time expressions ("yesterday", "last week").
        limit: Max results to return (v3 default 25).

    Returns a list of normalized memory dicts with 'id', 'content',
    'category', 'score', and 'metadata' fields. Results are cached per
    (user_id, query, reference_date, limit) for 60 seconds.
    """
    if categories is not None:
        logger.debug("[Mem0Search] categories parameter ignored in v3 mode")
    if context_mode is not None:
        logger.debug("[Mem0Search] context_mode parameter ignored in v3 mode")

    # Cache key must match the resolution the wire format uses (day-level
    # YYYY-MM-DD), NOT the full isoformat. Otherwise two calls on the same day
    # produce identical upstream queries (same Mem0 request) yet different
    # cache keys — the cache effectively never hits and every turn pays the
    # full Mem0 round-trip. The retrieval middleware passes
    # ``datetime.now(UTC)`` each turn, so isoformat would differ by
    # microseconds even for back-to-back calls.
    date_key = reference_date.strftime("%Y-%m-%d") if reference_date else ""
    cache_key = f"{user_id}:{query}:{date_key}:{limit}"

    with _cache_lock:
        cached_results = _cache.get(cache_key)
        if cached_results is not None:
            logger.info("[Mem0Cache] HIT (%d results cached)", len(cached_results))
            return cached_results

    logger.info(
        "[Mem0Cache] MISS — calling Mem0 API (query='%s' limit=%d)",
        query[:80],
        limit,
    )
    client = _get_client()
    if client is None:
        return []

    _t0 = time.perf_counter()
    try:
        # Mem0 v3 SDK uses ``top_k`` (documented in MemoryClient.search /
        # AsyncMemoryClient.search). Older code passed ``limit`` which the
        # server happened to accept in some environments but the v3 contract
        # is ``top_k`` — sending ``limit`` risks being silently ignored on
        # SDK/API combinations that strip unknown keys, falling back to the
        # default retrieval depth and undermining voice-mode's reduced
        # window. Keep the internal kwarg name ``limit`` so callers don't
        # have to know about the wire format.
        search_kwargs: dict[str, Any] = {
            "query": query,
            "filters": {"user_id": user_id},
            "top_k": limit,
        }
        if MEM0_REFERENCE_DATE_ENABLED and reference_date is not None:
            search_kwargs["reference_date"] = reference_date.strftime("%Y-%m-%d")

        results = client.search(**search_kwargs)
        api_ms = (time.perf_counter() - _t0) * 1000

        memories = _normalize_search_results(results)

        category_counts: dict[str, int] = {}
        for mem in memories:
            cat = (mem.get("category") or "unknown")
            category_counts[cat] = category_counts.get(cat, 0) + 1
        breakdown = ",".join(f"{k}:{v}" for k, v in sorted(category_counts.items()))

        logger.info(
            "[Mem0Search] user_id=%s query=%r filters=%s reference_date=%s top_k=%d "
            "latency_ms=%.0f results=%d categories=[%s]",
            user_id,
            query[:80],
            search_kwargs.get("filters", {"user_id": user_id}),
            search_kwargs.get("reference_date", "-"),
            limit,
            api_ms,
            len(memories),
            breakdown,
        )
        for i, mem in enumerate(memories):
            score_str = (
                f" score={mem['score']:.3f}"
                if mem.get("score") is not None
                else ""
            )
            logger.debug(
                "[Mem0Search]   [%d] [%s]%s %s",
                i,
                mem.get("category", "?"),
                score_str,
                (mem.get("content", ""))[:120],
            )

        with _cache_lock:
            _cache[cache_key] = memories

        return memories
    except Exception:
        logger.warning(
            "Mem0 search failed for user %s (%.0fms)",
            user_id,
            (time.perf_counter() - _t0) * 1000,
            exc_info=True,
        )
        return []


def _normalize_search_results(results: object) -> list[dict]:
    """Normalize v3 search response to a list of memory dicts."""
    memories: list[dict] = []
    if isinstance(results, dict) and "results" in results:
        results = results["results"]
    if isinstance(results, list):
        for r in results:
            if not isinstance(r, dict):
                continue
            meta = r.get("metadata") or {}
            score = r.get("score", r.get("relevance_score"))
            memories.append(
                {
                    "id": r.get("id", ""),
                    "content": r.get("memory", r.get("content", "")),
                    "category": meta.get("category", "")
                    if isinstance(meta, dict)
                    else "",
                    "score": score,
                    "metadata": meta if isinstance(meta, dict) else {},
                }
            )
    return memories


# ---------------------------------------------------------------------------
# Add
# ---------------------------------------------------------------------------


def _expiration_for_importance(importance: float | str | None) -> str | None:
    """Map importance to an ISO 8601 expiration_date.

    contextual (< 0.4)  -> today + 7 days
    Everything else     -> None (no expiration)
    """
    if importance is None:
        return None
    try:
        score = float(importance)
    except (ValueError, TypeError):
        return None
    if score < 0.4:
        return (datetime.now(UTC) + timedelta(days=7)).isoformat()
    return None


def add_memories(
    user_id: str,
    messages: list[dict],
    session_id: str,
    *,
    metadata: dict | None = None,
    timestamp: int | None = None,
) -> list[dict]:
    """Write memories to Mem0 for a user session using v3 SDK.

    metadata is passed directly to the v3 add() call (no REST backfill).
    importance is translated into expiration_date automatically.
    session_id is persisted as run_id so session-scoped recap retrieval
    remains exact.

    v3 add() is async-by-default; this helper blocks until pending
    events resolve (up to a default timeout) and returns the resolved
    memory dicts.  If the timeout elapses it falls back to the raw
    add-result payload so callers still have event IDs for later polling.

    Thread-safe: invalidates the user cache so subsequent searches reflect
    the new data.
    """
    client = _get_client()
    if client is None:
        return []

    resolved_metadata = dict(metadata) if metadata else {}

    # Translate legacy "status" -> "review_status" if present, BUT
    # keep "status" too — the gateway review path still queries by
    # metadata.status (e.g. GET /memories/recent?status=pending_review).
    if "status" in resolved_metadata and "review_status" not in resolved_metadata:
        resolved_metadata["review_status"] = resolved_metadata["status"]

    # Compute expiration from importance if not already set
    if "expiration_date" not in resolved_metadata:
        importance = resolved_metadata.get("importance_score")
        if importance is None:
            importance = resolved_metadata.get("importance")
        expiration = _expiration_for_importance(importance)
        if expiration:
            resolved_metadata["expiration_date"] = expiration

    add_kwargs: dict[str, Any] = {
        "messages": messages,
        "user_id": user_id,
        "run_id": session_id,
    }
    if resolved_metadata:
        add_kwargs["metadata"] = resolved_metadata
    if timestamp is not None:
        add_kwargs["timestamp"] = timestamp

    def _redact_meta(m: dict) -> dict:
        out = {}
        for k, v in (m or {}).items():
            if isinstance(v, str) and len(v) > 60:
                out[k] = v[:60] + "..."
            else:
                out[k] = v
        return out

    logger.info(
        "[Mem0Add] user_id=%s session_id=%s run_id=%s timestamp=%s msg_count=%d metadata=%s",
        user_id,
        session_id,
        add_kwargs.get("run_id"),
        add_kwargs.get("timestamp", "-"),
        len(messages) if messages else 0,
        _redact_meta(resolved_metadata) if resolved_metadata else {},
    )

    try:
        result = client.add(**add_kwargs)
    except Exception:
        logger.warning("Mem0 add failed for user %s", user_id, exc_info=True)
        return []

    normalized = _normalize_add_result(result)
    first_item = normalized[0] if normalized else None
    logger.info(
        "session.finalization mem0_add_response user_id=%s session_id=%s "
        "result_type=%s normalized_count=%s first_item_id=%s metadata_keys=%s",
        user_id,
        session_id,
        type(result).__name__,
        len(normalized),
        first_item.get("id") if isinstance(first_item, dict) else None,
        sorted(resolved_metadata.keys()) if resolved_metadata else None,
    )

    # Extract event IDs from the async add response and block until they
    # resolve so the offline pipeline does not report completion before
    # the memories are actually queryable.
    # Mem0 v3 returns `event_id` for queued async writes. Plain `id` values
    # can be resolved memory IDs from synchronous adds and must not be polled
    # as events.
    event_ids = [
        item.get("event_id")
        for item in normalized
        if isinstance(item, dict) and item.get("event_id")
    ]
    if event_ids:
        try:
            resolved = wait_for_pending_events(user_id, event_ids)
        except Mem0EventFailedError:
            logger.warning(
                "session.finalization mem0_add_failed user_id=%s session_id=%s event_ids=%s",
                user_id,
                session_id,
                event_ids,
                exc_info=True,
            )
            return []
        if resolved:
            logger.info(
                "session.finalization mem0_add_resolved user_id=%s session_id=%s "
                "resolved_count=%s",
                user_id,
                session_id,
                len(resolved),
            )
            invalidate_user_cache(user_id)
            return resolved
        logger.warning(
            "session.finalization mem0_add_timeout user_id=%s session_id=%s "
            "event_ids=%s — returning raw add result",
            user_id,
            session_id,
            event_ids,
        )

    invalidate_user_cache(user_id)
    return normalized


def wait_for_pending_events(
    user_id: str,
    event_ids: list[str],
    *,
    timeout_seconds: float = 30.0,
    poll_interval: float = 1.0,
) -> list[dict]:
    """Poll Mem0 until pending add events resolve to memory records.

    v3 add() may return event_ids for async processing. This helper
    blocks (up to timeout_seconds) and returns the resolved memories.
    If the timeout elapses, returns whatever is available.
    """
    client = _get_client()
    if client is None:
        return []

    deadline = time.monotonic() + timeout_seconds
    resolved: list[dict] = []
    pending = set(event_ids)

    # v3 async event IDs are different from memory IDs.
    # Prefer per-ID get_event() when the SDK supports it — avoids
    # pagination issues with busy projects. Fall back to paginated
    # get_events() only; get_all() cannot safely map event IDs to new
    # memory rows and would return unrelated historical memories.
    has_get_event = hasattr(client, "get_event")
    has_get_events = hasattr(client, "get_events")
    if not has_get_event and not has_get_events:
        logger.warning(
            "Mem0 event APIs unavailable for user %s; cannot resolve pending add events",
            user_id,
        )
        return []

    while pending and time.monotonic() < deadline:
        try:
            if has_get_event:
                # Per-ID polling: exact lookup, no pagination problems.
                for evt_id in list(pending):
                    event_result = client.get_event(event_id=evt_id)
                    events, _ = _normalize_paginated_result(event_result)
                    for evt in events:
                        status = evt.get("status", evt.get("event_status", "")).upper()
                        if status == "FAILED":
                            raise Mem0EventFailedError(f"Mem0 add event failed: {evt_id}")
                        if status not in ("SUCCEEDED", "COMPLETED"):
                            continue
                        resolved.extend(_extract_memories_from_event(evt))
                        pending.discard(evt_id)
            elif has_get_events:
                # Paginated get_events: walk every page so newly-queued
                # events cannot be off-page and missed.
                cursor = None
                while True:
                    page_kwargs: dict[str, Any] = {
                        "filters": {"user_id": user_id},
                    }
                    if cursor:
                        page_kwargs["cursor"] = cursor
                    events_result = client.get_events(**page_kwargs)
                    events, cursor = _normalize_paginated_result(events_result)
                    for evt in events:
                        evt_id = evt.get("event_id") or evt.get("id")
                        if evt_id not in pending:
                            continue
                        status = evt.get("status", evt.get("event_status", "")).upper()
                        if status == "FAILED":
                            raise Mem0EventFailedError(f"Mem0 add event failed: {evt_id}")
                        if status not in ("SUCCEEDED", "COMPLETED"):
                            continue
                        resolved.extend(_extract_memories_from_event(evt))
                        pending.discard(evt_id)
                    if not cursor or not pending:
                        break
        except Mem0EventFailedError:
            raise
        except Exception:
            logger.warning(
                "Mem0 poll for pending events failed for user %s", user_id, exc_info=True
            )
        if pending:
            time.sleep(poll_interval)

    if pending:
        logger.warning(
            "Mem0 pending event resolution timed out for user %s: %d remaining",
            user_id,
            len(pending),
        )
    return resolved


def _extract_memories_from_event(evt: dict) -> list[dict]:
    """Extract all memory records from a v3 event payload.

    Mem0 v3 get_events returns event wrappers that may nest the resolved
    memory under several different keys depending on the SDK version and
    event type.  We try known paths and return every memory dict found.

    A raw event wrapper always carries a top-level ``status`` key, so we
    use that as a discriminator — if ``status`` is present we treat the dict
    as an event and keep drilling, never returning the wrapper itself.
    """
    memories: list[dict] = []

    # Path 1: event.memory — most common, event nests one memory dict
    mem = evt.get("memory")
    if isinstance(mem, dict):
        memories.append(mem)

    # Path 2: event.data.memory — some SDK versions nest deeper
    data = evt.get("data")
    if isinstance(data, dict):
        mem = data.get("memory")
        if isinstance(mem, dict):
            memories.append(mem)

    # Path 3: event.result — alternative SDK naming
    mem = evt.get("result")
    if isinstance(mem, dict):
        memories.append(mem)

    # Path 4: event.results — v3 may return multiple memory outputs here
    results = evt.get("results")
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict):
                memories.append(item)
    elif isinstance(results, dict):
        memories.append(results)

    if memories:
        return memories

    # Path 5: the event itself is the memory record — NOT a raw wrapper.
    # Memory records have memory/content fields; event wrappers have status.
    if ("memory" in evt or "content" in evt) and "status" not in evt:
        return [evt]

    return []


def _normalize_add_result(result: object) -> list[dict]:
    """Normalize v3 add() response to a list of dicts."""
    if isinstance(result, dict) and "results" in result:
        nested = result["results"]
        return nested if isinstance(nested, list) else [nested]
    if isinstance(result, list):
        return result
    return [result] if isinstance(result, dict) and result else []


def _normalize_get_all_result(result: object) -> list[dict]:
    """Normalize v3 get_all() response (paginated envelope or bare list)."""
    if isinstance(result, dict):
        if "results" in result:
            nested = result["results"]
            return nested if isinstance(nested, list) else [nested]
        # v3 paginated envelope: {count, next, previous, results}
        if "count" in result and "results" not in result:
            return []
    if isinstance(result, list):
        return result
    return []


def _normalize_paginated_result(result: object) -> tuple[list[dict], str | None]:
    """Normalize a paginated v3 response to (results_list, next_cursor).

    Handles three shapes:
    1. Paginated envelope from get_events::
        {"count": N, "next": "c2...", "results": [{"id": "evt_1", "status": "SUCCEEDED"}]}
    2. Single event from get_event::
        {"id": "evt_1", "status": "SUCCEEDED", "results": [{"id": "mem_1"}]}
    3. Bare dict/list returns.

    For shape 2, we return the event dict itself (not the inner results)
    so callers can inspect status before extracting memories.
    """
    if isinstance(result, dict):
        if "results" in result:
            # get_event returns a single event with a top-level status key;
            # get_events returns a paginated envelope with a count key.
            if "status" in result or "event_id" in result:
                return [result], None
            # Paginated envelope — extract the results array and cursor.
            nested = result["results"]
            results = nested if isinstance(nested, list) else [nested]
            return results, result.get("next")
        # Bare single-event dict (from get_event without results key)
        if any(k in result for k in ("id", "status", "memory", "data", "result", "event_id")):
            return [result], None
        return [], None
    if isinstance(result, list):
        return result, None
    return [], None


# ---------------------------------------------------------------------------
# Reconciliation helpers (legacy bridge — to be deleted after backfill)
# ---------------------------------------------------------------------------


def reconcile_review_metadata_with_mem0(user_id: str) -> int:
    """NO-OP in v3: review metadata lives natively in Mem0 metadata.

    Kept as a stub so callers don't break during the migration window.
    Remove once all production users have been backfilled.
    """
    logger.info(
        "reconcile_review_metadata_with_mem0 is a no-op in v3 mode (user=%s)", user_id
    )
    return 0


# ---------------------------------------------------------------------------
# Cache utilities
# ---------------------------------------------------------------------------


def invalidate_user_cache(user_id: str) -> None:
    """Clear all cached results for a user. Call after Mem0 writes."""
    prefix = f"{user_id}:"
    with _cache_lock:
        keys_to_remove = [k for k in _cache if k.startswith(prefix)]
        for k in keys_to_remove:
            del _cache[k]


# ---------------------------------------------------------------------------
# Eager startup: init client + ping in a background thread
# ---------------------------------------------------------------------------

def _startup_warm_up() -> None:
    warm_up()


_warmup_thread = threading.Thread(
    target=_startup_warm_up, daemon=True, name="mem0-warmup"
)
_warmup_thread.start()
