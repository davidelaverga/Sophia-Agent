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

Diagnostics + REST fallback (merged from main):
- ``search_memories_with_diagnostics`` returns a privacy-safe envelope
  describing provider status / transport / latency so callers can show
  honest "memory unavailable" states without exposing the raw exception.
- When the SDK client cannot be initialised but ``MEM0_API_KEY`` + httpx
  are present, search falls back to a direct REST call against
  ``/v2/memories/search/`` so the slim voice runtime still gets memories.
- ``MemoryProviderUnavailableError`` / ``MemoryProviderSearchError`` let
  callers opt into raising on provider failure via ``raise_on_error=True``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
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

logger = logging.getLogger(__name__)

_CACHE_TTL = 60  # seconds
_CACHE_MAX_SIZE = 256

# Thread-safe bounded TTL cache
_cache: TTLCache = TTLCache(maxsize=_CACHE_MAX_SIZE, ttl=_CACHE_TTL)
_cache_lock = threading.Lock()

# Module-level client singleton
_client: Any | None = None
_client_initialized: bool = False
# Tracks why the SDK client is unavailable so diagnostics + REST fallback
# can branch on the specific reason (missing key vs. missing SDK vs. init
# error). ``None`` means "client healthy or not initialised yet".
_client_unavailable_reason: str | None = None
_client_lock = threading.Lock()
_warm_up_completed: bool = False
_warm_up_lock = threading.Lock()


class Mem0EventFailedError(RuntimeError):
    """Raised when a Mem0 async add event reaches FAILED status."""


class MemoryProviderUnavailableError(RuntimeError):
    """Raised by diagnostics-aware callers when the Mem0 provider is unavailable."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


class MemoryProviderSearchError(RuntimeError):
    """Raised by diagnostics-aware callers when a Mem0 search raises."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


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
    """Lazy-initialize the Mem0 client (singleton, thread-safe).

    Records ``_client_unavailable_reason`` (``missing_api_key`` /
    ``missing_mem0_sdk`` / ``client_initialization_failed``) when the client
    cannot be built. Callers like ``_memory_provider_status_from_client`` use
    that signal to decide between REST fallback and a hard "unavailable"
    response. Honors ``MEM0_BASE_URL`` for self-hosted Mem0 deployments.
    """
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
            from mem0 import MemoryClient
        except ImportError:
            logger.warning("mem0 package not installed — memory retrieval disabled")
            _client = None
            _client_unavailable_reason = "missing_mem0_sdk"
        else:
            try:
                _client = MemoryClient(
                    api_key=api_key,
                    host=(os.environ.get("MEM0_BASE_URL") or None),
                )
                _client_unavailable_reason = None
                logger.info("[Mem0] Client initialized successfully (v3)")
            except Exception:
                logger.warning("Mem0 client initialization failed", exc_info=True)
                _client = None
                _client_unavailable_reason = "client_initialization_failed"
        _client_initialized = True
        return _client


def _httpx_module():
    """Lazy-import helper for httpx (REST fallback only)."""
    try:
        import httpx
    except ImportError:
        return None
    return httpx


def _rest_fallback_available() -> bool:
    """True iff the REST fallback transport can be used right now."""
    return bool(os.environ.get("MEM0_API_KEY", "").strip()) and _httpx_module() is not None


def _memory_provider_status_from_client() -> dict[str, Any]:
    """Inspect the current client + env to describe provider availability."""
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


def memory_provider_available() -> bool:
    """Return whether the Mem0 client is configured and importable."""
    return bool(memory_provider_status().get("available"))


def memory_provider_status() -> dict[str, Any]:
    """Return privacy-safe Mem0 availability details for diagnostics."""
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
            # Mem0 v3 SDK uses ``top_k`` for result count, not ``limit``
            # (same fix as ``search_memories``). On strict SDK/server combos
            # that reject unknown kwargs, ``limit=1`` makes warm-up fail on
            # every boot — and since ``_warm_up_completed`` is set in
            # ``finally``, we never retry. The first real user search then
            # pays the cold-start latency this warm-up exists to avoid.
            client.search(query="warm_up", filters={"user_id": "__warmup__"}, top_k=1)
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
    log_content_previews: bool = True,
    raise_on_error: bool = False,
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
        log_content_previews: If False, suppress per-result content preview
            logging (used by realtime voice paths to avoid duplicating raw
            memory text outside the tool result).
        raise_on_error: If True, raise MemoryProviderUnavailableError /
            MemoryProviderSearchError instead of returning an empty list.

    Returns a list of normalized memory dicts with 'id', 'content',
    'category', 'score', and 'metadata' fields. Results are cached per
    (user_id, query, reference_date, limit) for 60 seconds.
    """
    result = search_memories_with_diagnostics(
        user_id=user_id,
        query=query,
        categories=categories,
        context_mode=context_mode,
        reference_date=reference_date,
        limit=limit,
        log_content_previews=log_content_previews,
        raise_on_error=raise_on_error,
    )
    return result["memories"]


def search_memories_with_diagnostics(
    user_id: str,
    query: str,
    categories: list[str] | None = None,
    context_mode: str | None = None,
    *,
    reference_date: datetime | None = None,
    limit: int = 25,
    log_content_previews: bool = True,
    raise_on_error: bool = False,
) -> dict[str, Any]:
    """Search Mem0 and return a privacy-safe diagnostics envelope.

    Returns a dict with:
        memories: normalized memory list (same shape as search_memories).
        provider_status / provider_reason / provider_transport: which Mem0
            backend served the result (sdk / rest / cache / unavailable).
        cache_status: ``hit`` or ``miss``.
        latency_ms: API wall-clock latency (0 on cache hit / unavailable).

    Note: v3 deprecates the ``categories`` post-filter and the
    ``context_mode`` client-side sort. They are accepted for backward
    compatibility but ignored at runtime — Mem0's hybrid retrieval handles
    relevance natively.
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
            return {
                "memories": cached_results,
                "provider_status": "available",
                "provider_reason": "cache_hit",
                "provider_transport": "cache",
                "cache_status": "hit",
                "latency_ms": 0,
            }

    logger.info(
        "[Mem0Cache] MISS — calling Mem0 API (query='%s' limit=%d)",
        query[:80],
        limit,
    )
    provider_status = memory_provider_status()
    if not provider_status.get("available"):
        if raise_on_error:
            raise MemoryProviderUnavailableError(
                str(provider_status.get("provider_reason") or "client_unavailable")
            )
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
        results, provider_transport = _execute_mem0_search(
            user_id=user_id,
            query=query,
            limit=limit,
            reference_date=reference_date,
            default_transport=str(provider_status.get("provider_transport") or "mem0_sdk"),
        )
        api_ms = (time.perf_counter() - _t0) * 1000
        memories = _normalize_search_results(results)

        _log_search_diagnostics(
            user_id=user_id,
            query=query,
            reference_date=reference_date,
            limit=limit,
            memories=memories,
            api_ms=api_ms,
            log_content_previews=log_content_previews,
        )

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
        logger.warning(
            "Mem0 search failed for user %s (%.0fms)", user_id, elapsed_ms, exc_info=True
        )
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


def _execute_mem0_search(
    *,
    user_id: str,
    query: str,
    limit: int,
    reference_date: datetime | None,
    default_transport: str,
) -> tuple[Any, str]:
    """Run the Mem0 search via SDK (preferred) or REST fallback (slim runtime).

    Extracted from ``search_memories_with_diagnostics`` to keep that function
    below the sentrux CC threshold (16). Returns ``(raw_results, transport)``
    where transport is ``"mem0_sdk"`` (or whatever ``default_transport`` was)
    when the SDK served the request, or ``"mem0_rest"`` when we fell back.
    """
    client = _get_client()
    if client is not None:
        # Mem0 v3 SDK uses ``top_k`` (documented in MemoryClient.search). Older
        # code passed ``limit`` which the server happened to accept in some
        # environments but the v3 contract is ``top_k`` — sending ``limit``
        # risks being silently ignored on SDK/API combinations that strip
        # unknown keys, falling back to the default retrieval depth and
        # undermining voice-mode's reduced window.
        search_kwargs: dict[str, Any] = {
            "query": query,
            "filters": {"user_id": user_id},
            "top_k": limit,
        }
        if MEM0_REFERENCE_DATE_ENABLED and reference_date is not None:
            search_kwargs["reference_date"] = reference_date.strftime("%Y-%m-%d")
        return client.search(**search_kwargs), default_transport

    # SDK unavailable (e.g. slim voice runtime without the mem0 package).
    # Fall back to the REST API via httpx so the user still gets memory
    # results. The REST endpoint is v2 and uses ``limit`` on the wire.
    return _search_memories_via_rest(user_id=user_id, query=query, limit=limit), "mem0_rest"


def _log_search_diagnostics(
    *,
    user_id: str,
    query: str,
    reference_date: datetime | None,
    limit: int,
    memories: list[dict],
    api_ms: float,
    log_content_previews: bool,
) -> None:
    """Emit the ``[Mem0Search]`` summary + optional per-result debug lines.

    Extracted from ``search_memories_with_diagnostics`` to keep that function
    below the sentrux CC threshold. The summary line is grep-friendly and
    includes the resolved ``reference_date`` (day-precision) and a category
    breakdown so an operator can quickly count what came back.
    """
    category_counts: dict[str, int] = {}
    for mem in memories:
        cat = (mem.get("category") or "unknown")
        category_counts[cat] = category_counts.get(cat, 0) + 1
    breakdown = ",".join(f"{k}:{v}" for k, v in sorted(category_counts.items()))

    ref_date_str = "-"
    if MEM0_REFERENCE_DATE_ENABLED and reference_date is not None:
        ref_date_str = reference_date.strftime("%Y-%m-%d")

    logger.info(
        "[Mem0Search] user_id=%s query=%r filters=%s reference_date=%s top_k=%d "
        "latency_ms=%.0f results=%d categories=[%s]",
        user_id,
        query[:80],
        {"user_id": user_id},
        ref_date_str,
        limit,
        api_ms,
        len(memories),
        breakdown,
    )

    if not log_content_previews:
        return
    for i, mem in enumerate(memories):
        score_str = ""
        if mem.get("score") is not None:
            score_str = f" score={mem['score']:.3f}"
        logger.debug(
            "[Mem0Search]   [%d] [%s]%s %s",
            i,
            mem.get("category", "?"),
            score_str,
            (mem.get("content", ""))[:120],
        )


def _search_memories_via_rest(*, user_id: str, query: str, limit: int) -> dict[str, Any]:
    """REST fallback for environments without the mem0 SDK installed."""
    httpx = _httpx_module()
    api_key = os.environ.get("MEM0_API_KEY", "").strip()
    if httpx is None:
        raise MemoryProviderUnavailableError("missing_httpx")
    if not api_key:
        raise MemoryProviderUnavailableError("missing_api_key")

    host = (os.environ.get("MEM0_BASE_URL") or "https://api.mem0.ai").rstrip("/")
    with httpx.Client(
        base_url=host,
        headers={"Authorization": f"Token {api_key}"},
        timeout=30.0,
    ) as client:
        response = client.post(
            "/v2/memories/search/",
            json={"query": query, "filters": {"user_id": user_id}, "limit": limit},
        )
        response.raise_for_status()
        result = response.json()
    if isinstance(result, list):
        return {"results": result}
    return result if isinstance(result, dict) else {"results": []}


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
            resolved, still_pending = wait_for_pending_events(user_id, event_ids)
        except Mem0EventFailedError:
            logger.warning(
                "session.finalization mem0_add_failed user_id=%s session_id=%s event_ids=%s",
                user_id,
                session_id,
                event_ids,
                exc_info=True,
            )
            return []
        if not still_pending:
            # All events reached terminal status (SUCCEEDED / COMPLETED).
            # Differentiate "completed with memories" from "completed empty"
            # — the latter is rare but valid (low-signal content where Mem0
            # extracted nothing). Codex P2 review on PR #130 R9: previously
            # both cases logged ``mem0_add_timeout`` and returned event
            # wrappers, which downstream interpreted as "still pending" and
            # never reconciled.
            if resolved:
                logger.info(
                    "session.finalization mem0_add_resolved user_id=%s session_id=%s "
                    "resolved_count=%s",
                    user_id,
                    session_id,
                    len(resolved),
                )
            else:
                logger.info(
                    "session.finalization mem0_add_completed_empty user_id=%s session_id=%s "
                    "event_ids=%s — Mem0 reported success with no extracted memories "
                    "(no fallback to raw event wrappers; nothing pending)",
                    user_id,
                    session_id,
                    event_ids,
                )
            invalidate_user_cache(user_id)
            return resolved  # may be [] on completed-empty — that's correct
        # Real timeout: some events never reached terminal status.
        # Return the raw add result so downstream can persist event_ids
        # for later reconciliation.
        logger.warning(
            "session.finalization mem0_add_timeout user_id=%s session_id=%s "
            "resolved_count=%d still_pending=%d event_ids=%s — returning raw "
            "add result so callers can track the remaining events",
            user_id,
            session_id,
            len(resolved),
            len(still_pending),
            sorted(still_pending),
        )

    invalidate_user_cache(user_id)
    return normalized


def wait_for_pending_events(
    user_id: str,
    event_ids: list[str],
    *,
    timeout_seconds: float = 30.0,
    poll_interval: float = 1.0,
) -> tuple[list[dict], set[str]]:
    """Poll Mem0 until pending add events resolve.

    v3 add() may return event_ids for async processing. This helper blocks
    (up to ``timeout_seconds``) and returns BOTH the resolved memories AND
    the set of event_ids that are still pending.

    The two-value return lets callers (Codex P2 R9) distinguish three outcomes
    that the old single-list return conflated:

    - ``(resolved, set())``           — all events reached terminal status
                                        (SUCCEEDED / COMPLETED). ``resolved``
                                        may be empty: Mem0 finished but
                                        extracted no memories (rare but valid
                                        for low-signal content). Caller should
                                        NOT fall back to event wrappers — the
                                        events are done.
    - ``(partial, {ids})``            — timeout fired with some events still
                                        in flight. Caller should fall back to
                                        the raw add-result event wrappers so
                                        downstream can reconcile later.
    - ``([], set(event_ids))``        — no poll strategy was available at all
                                        (no SDK methods, no REST fallback).
                                        Conservative: treat as timeout so the
                                        caller doesn't drop the event_ids.

    Polling strategy is chosen ONCE up front:

    1. ``client.get_event(event_id=...)`` — per-ID SDK lookup, no
       pagination issues. Used when the SDK exposes it.
    2. ``client.get_events(filters=...)`` — paginated SDK list. Used
       when only get_events exists.
    3. ``GET /v1/events/?limit=50`` via httpx — REST fallback for
       Mem0 SDKs that don't wrap the events endpoint (e.g. mem0ai>=2.0.2
       at time of writing exposes neither get_event nor get_events). The
       REST endpoint doesn't accept event_id / user_id query filters
       server-side (verified empirically), so we fetch the most-recent N
       events and client-side filter for our pending IDs. Best for the
       common case where event_ids were just created.
    4. None of the above → log warning, return []. ``add_memories`` then
       falls back to the raw add result (event wrappers) and downstream
       callers treat them as pending.

    Codex P1 review on PR #130: the previous build short-circuited at the
    has_get_event/has_get_events check, breaking event resolution entirely
    on the pinned SDK version. The REST fallback restores correctness
    without requiring any SDK update.
    """
    if not event_ids:
        return [], set()

    poll = _select_event_poll_strategy(user_id)
    if poll is None:
        logger.warning(
            "Mem0 event APIs unavailable for user %s (no SDK methods, no REST "
            "fallback); cannot resolve pending add events",
            user_id,
        )
        # Treat as "all pending" so the caller falls back to event wrappers
        # rather than silently dropping the event_ids.
        return [], set(event_ids)

    deadline = time.monotonic() + timeout_seconds
    resolved: list[dict] = []
    pending = set(event_ids)

    while pending and time.monotonic() < deadline:
        try:
            poll(pending, resolved)
        except Mem0EventFailedError:
            raise
        except Exception:
            logger.warning(
                "Mem0 poll for pending events failed for user %s",
                user_id,
                exc_info=True,
            )
        if pending:
            time.sleep(poll_interval)

    if pending:
        logger.warning(
            "Mem0 pending event resolution timed out for user %s: %d remaining",
            user_id,
            len(pending),
        )
    return resolved, pending


def _select_event_poll_strategy(user_id: str) -> Callable[[set[str], list[dict]], None] | None:
    """Pick the polling strategy ONCE up front so the hot loop stays branch-free.

    Priority:
      1. ``client.get_event(event_id=...)`` — per-ID SDK lookup (forward-compat).
      2. ``client.get_events(filters=...)`` — paginated SDK list (forward-compat).
      3. REST ``GET /v1/events/`` via httpx — the only strategy that works on
         the pinned ``mem0ai>=2.0.2`` SDK, which exposes neither SDK method.

    Returns a closure that takes ``(pending, resolved)`` and mutates them in
    place. Returns ``None`` if no strategy is available (no SDK client, no
    httpx, no API key) — caller logs warning and short-circuits.
    """
    client = _get_client()
    if client is not None and hasattr(client, "get_event"):
        return lambda pending, resolved: _poll_events_via_sdk_per_id(
            client, pending, resolved
        )
    if client is not None and hasattr(client, "get_events"):
        return lambda pending, resolved: _poll_events_via_sdk_paginated(
            client, user_id, pending, resolved
        )
    if _rest_fallback_available():
        return _poll_events_via_rest
    return None


def _consume_events(
    events: list[dict],
    pending: set[str],
    resolved: list[dict],
    *,
    fallback_id: str | None = None,
) -> None:
    """Walk ``events``, draining terminal-success ones from ``pending``.

    Mutates both ``pending`` (discards resolved IDs) and ``resolved`` (appends
    extracted memories). Raises ``Mem0EventFailedError`` on FAILED status.

    ``fallback_id`` is used when polling per-ID and the API returns a
    single-event payload that lacks its own id (rare but defensive).
    """
    for evt in events:
        evt_id = evt.get("event_id") or evt.get("id") or fallback_id
        if evt_id is None or evt_id not in pending:
            continue
        status = (evt.get("status") or evt.get("event_status") or "").upper()
        if status == "FAILED":
            raise Mem0EventFailedError(f"Mem0 add event failed: {evt_id}")
        if status not in ("SUCCEEDED", "COMPLETED"):
            continue
        resolved.extend(_extract_memories_from_event(evt))
        pending.discard(evt_id)


def _poll_events_via_sdk_per_id(
    client: Any,
    pending: set[str],
    resolved: list[dict],
) -> None:
    """Per-event-ID SDK lookup. No pagination, exact match."""
    for evt_id in list(pending):
        event_result = client.get_event(event_id=evt_id)
        events, _ = _normalize_paginated_result(event_result)
        _consume_events(events, pending, resolved, fallback_id=evt_id)


def _poll_events_via_sdk_paginated(
    client: Any,
    user_id: str,
    pending: set[str],
    resolved: list[dict],
) -> None:
    """Paginated SDK list. Walks every page so off-page events aren't missed."""
    cursor: str | None = None
    while True:
        kwargs: dict[str, Any] = {"filters": {"user_id": user_id}}
        if cursor:
            kwargs["cursor"] = cursor
        events_result = client.get_events(**kwargs)
        events, cursor = _normalize_paginated_result(events_result)
        _consume_events(events, pending, resolved)
        if not cursor or not pending:
            break


_REST_EVENTS_PAGE_SIZE = 50
_REST_EVENTS_MAX_PAGES = 10  # 500 events of buffer for busy projects


def _poll_events_via_rest(
    pending: set[str],
    resolved: list[dict],
) -> None:
    """REST ``GET /v1/events/`` fallback for SDKs without get_event(s).

    Mem0's REST list endpoint doesn't accept event_id or user_id query
    filters server-side (verified empirically against api.mem0.ai), so we
    fetch most-recent events and client-side filter for our pending IDs.

    Pagination (Codex P2 R9): under moderate / high concurrent traffic the
    target event_id can be off the first page even when it has already
    completed. We follow the response's ``next`` cursor for up to
    ``_REST_EVENTS_MAX_PAGES`` pages (= 500 events of buffer) or until all
    pending IDs are resolved — whichever comes first. The unbounded
    alternative would walk the entire event log (often 10k+) on every poll
    cycle, which is wasteful for the common case where events are within
    the first 1-2 pages.
    """
    httpx = _httpx_module()
    api_key = os.environ.get("MEM0_API_KEY", "").strip()
    if httpx is None or not api_key:
        return
    base_url = (os.environ.get("MEM0_BASE_URL") or "https://api.mem0.ai").rstrip("/")
    headers = {"Authorization": f"Token {api_key}"}
    url: str | None = f"{base_url}/v1/events/?limit={_REST_EVENTS_PAGE_SIZE}"

    with httpx.Client(timeout=10.0) as http:
        for _ in range(_REST_EVENTS_MAX_PAGES):
            if url is None or not pending:
                break
            resp = http.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            events = _events_from_rest_payload(data)
            _consume_events(events, pending, resolved)
            url = _resolve_rest_next_url(data, base_url)


def _events_from_rest_payload(data: Any) -> list[dict]:
    """Normalize Mem0 REST ``/v1/events/`` response to a flat list of dicts."""
    if isinstance(data, dict):
        results = data.get("results")
        if isinstance(results, list):
            return [e for e in results if isinstance(e, dict)]
        return []
    if isinstance(data, list):
        return [e for e in data if isinstance(e, dict)]
    return []


def _resolve_rest_next_url(data: Any, base_url: str) -> str | None:
    """Resolve the ``next`` cursor field to an absolute URL, or None when done.

    Mem0 returns ``next`` as either a relative path (``/v1/events/?page=2``)
    or a full URL. Both shapes are accepted.
    """
    if not isinstance(data, dict):
        return None
    next_url = data.get("next")
    if not isinstance(next_url, str) or not next_url:
        return None
    if next_url.startswith("/"):
        return f"{base_url.rstrip('/')}{next_url}"
    return next_url


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
