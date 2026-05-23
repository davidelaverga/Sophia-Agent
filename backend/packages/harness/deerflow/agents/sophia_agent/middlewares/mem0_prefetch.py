"""Mem0 retrieval middleware — async prefetch of memories into state.

Upgrade E splits the old Mem0MemoryMiddleware into two parts:
1. Mem0RetrievalMiddleware (this file) — runs early in the chain to
   fetch memories and store them in state["prefetched_memories"].
2. MemoryInjectionMiddleware — runs later to format and inject the
   prefetched memories into system_prompt_blocks.

The split allows retrieval to overlap with other expensive middleware
work when the runtime invokes the async abefore_agent hook.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from datetime import UTC, datetime
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import extract_last_message_text, log_middleware
from deerflow.sophia.mem0_client import search_memories, warm_up

logger = logging.getLogger(__name__)

# Voice fast-cache is module-level so it survives per-request middleware
# re-instantiation. `make_sophia_agent()` is called for every LangGraph run,
# which would otherwise reset an instance-local cache and guarantee 0% hits.
# Upgrade B: key simplified to (thread_id, context_mode) — categories dropped.
_VOICE_FASTCACHE: dict[tuple[str, str], dict] = {}
_VOICE_FASTCACHE_LOCK = threading.Lock()

_VOICE_FAST_CACHE_TTL_SECONDS = 90.0
_VOICE_FAST_CACHE_STICKY_SECONDS = 30.0
_VOICE_FAST_CACHE_RECENT_TURN_WINDOW = 2
_VOICE_FAST_CACHE_SHORT_QUERY_TOKENS = 8
_VOICE_FAST_CACHE_MIN_OVERLAP = 0.15
_VOICE_MEMORY_LIMIT = 4
_DEFAULT_MEMORY_LIMIT = 10
_VOICE_WARMUP_USER_ID = "__voice_warmup__"
_QUERY_TOKEN_RE = re.compile(r"[a-z0-9']+")
_VOICE_LOW_SIGNAL_RE = re.compile(
    r"\b(thanks|thank you|appreciate it|got it|okay|ok|alright|all right|sounds good|that helps|helpful|nice|cool|wow|i see|makes sense)\b"
)
_VOICE_EXPLICIT_MEMORY_RE = re.compile(
    r"\b(remember|remind me|what do you know|what do you remember|have i mentioned|last time we|patterns about me|my patterns|do i usually)\b"
)
_VOICE_CONTINUATION_RE = re.compile(
    r"\b(actually|also|and|but|so|that|tell me more|could you|can you|what about|how about|go on|continue|wait)\b"
)
_QUERY_STOPWORDS = {
    "about",
    "actually",
    "also",
    "and",
    "are",
    "can",
    "could",
    "for",
    "from",
    "have",
    "how",
    "into",
    "just",
    "like",
    "more",
    "need",
    "really",
    "should",
    "tell",
    "that",
    "them",
    "this",
    "what",
    "with",
    "would",
    "yeah",
    "you",
    "your",
}


class Mem0RetrievalState(AgentState):
    skip_expensive: NotRequired[bool]
    context_mode: NotRequired[str]
    platform: NotRequired[str]
    turn_count: NotRequired[int]
    prefetched_memories: NotRequired[list[dict]]
    prefetched_memory_ids: NotRequired[list[str]]


class Mem0RetrievalMiddleware(AgentMiddleware[Mem0RetrievalState]):
    """Fetch Mem0 memories and store them in state for later injection."""

    state_schema = Mem0RetrievalState

    def __init__(self, user_id: str):
        super().__init__()
        self._user_id = user_id
        warm_up()

    # ------------------------------------------------------------------
    # Token / query helpers (static, shared with injection middleware)
    # ------------------------------------------------------------------

    @staticmethod
    def query_tokens(query: str) -> set[str]:
        return {
            token
            for token in _QUERY_TOKEN_RE.findall(query.lower())
            if len(token) >= 3
        }

    @staticmethod
    def content_tokens(query: str) -> set[str]:
        return {
            token
            for token in _QUERY_TOKEN_RE.findall(query.lower())
            if len(token) >= 3 and token not in _QUERY_STOPWORDS
        }

    @staticmethod
    def is_low_signal_voice_query(query: str) -> bool:
        normalized = query.lower().strip()
        if not normalized:
            return True
        if _VOICE_LOW_SIGNAL_RE.search(normalized):
            return True
        toks = Mem0RetrievalMiddleware.content_tokens(normalized)
        token_count = len(_QUERY_TOKEN_RE.findall(normalized))
        return "?" not in normalized and token_count <= 3 and len(toks) <= 1

    @staticmethod
    def is_explicit_memory_query(query: str) -> bool:
        return bool(_VOICE_EXPLICIT_MEMORY_RE.search(query.lower()))

    @classmethod
    def is_clear_topic_shift(cls, query: str, cached_content_tokens: set[str]) -> bool:
        if not cached_content_tokens:
            return False
        normalized = query.lower().strip()
        if _VOICE_CONTINUATION_RE.search(normalized):
            return False
        query_content_tokens = cls.content_tokens(normalized)
        if len(query_content_tokens) < 3 or len(cached_content_tokens) < 3:
            return False
        return len(query_content_tokens & cached_content_tokens) == 0

    # ------------------------------------------------------------------
    # Voice fast-cache
    # ------------------------------------------------------------------

    def _maybe_reuse_voice_results(
        self,
        *,
        thread_id: str | None,
        platform: str | None,
        context_mode: str | None,
        query: str,
        turn_count: int | None,
    ) -> list[dict] | None:
        if platform not in ("voice", "ios_voice") or not thread_id:
            return None

        cache_key = (thread_id, context_mode or "")
        with _VOICE_FASTCACHE_LOCK:
            cached = _VOICE_FASTCACHE.get(cache_key)
            cache_size = len(_VOICE_FASTCACHE)
        logger.info(
            "[Mem0Retrieval] fastcache_lookup | key_thread=%s | key_ctx=%s | hit=%s | cache_size=%d",
            thread_id[:8] if thread_id else "-",
            context_mode or "-",
            "yes" if cached else "no",
            cache_size,
        )
        if not cached:
            return None

        age_seconds = time.monotonic() - cached["stored_at"]
        if age_seconds > _VOICE_FAST_CACHE_TTL_SECONDS:
            with _VOICE_FASTCACHE_LOCK:
                _VOICE_FASTCACHE.pop(cache_key, None)
            return None

        if self.is_low_signal_voice_query(query):
            logger.info(
                "[Mem0Retrieval] voice recent-cache hit | thread_id=%s | reason=low_signal | age_ms=%.0f",
                thread_id,
                age_seconds * 1000,
            )
            return cached["results"]

        if self.is_explicit_memory_query(query):
            return None

        cached_content_tokens = cached["content_tokens"]
        if not self.is_clear_topic_shift(query, cached_content_tokens):
            if age_seconds <= _VOICE_FAST_CACHE_STICKY_SECONDS:
                logger.info(
                    "[Mem0Retrieval] voice recent-cache hit | thread_id=%s | reason=sticky | age_ms=%.0f",
                    thread_id,
                    age_seconds * 1000,
                )
                return cached["results"]

            cached_turn_count = cached.get("turn_count")
            if (
                turn_count is not None
                and cached_turn_count is not None
                and turn_count - cached_turn_count < _VOICE_FAST_CACHE_RECENT_TURN_WINDOW
            ):
                logger.info(
                    "[Mem0Retrieval] voice recent-cache hit | thread_id=%s | reason=recent_turn_window | turn_delta=%s",
                    thread_id,
                    turn_count - cached_turn_count,
                )
                return cached["results"]

        query_tokens = self.query_tokens(query)
        cached_tokens = cached["query_tokens"]
        if not query_tokens:
            logger.info("[Mem0Retrieval] voice recent-cache hit | thread_id=%s | reason=empty_query_tokens", thread_id)
            return cached["results"]

        overlap_count = len(query_tokens & cached_tokens)
        if overlap_count == 0:
            return None

        union_count = len(query_tokens | cached_tokens)
        overlap = overlap_count / union_count if union_count else 1.0
        if len(query_tokens) <= _VOICE_FAST_CACHE_SHORT_QUERY_TOKENS or overlap >= _VOICE_FAST_CACHE_MIN_OVERLAP:
            logger.info(
                "[Mem0Retrieval] voice recent-cache hit | thread_id=%s | overlap=%.2f | age_ms=%.0f",
                thread_id,
                overlap,
                age_seconds * 1000,
            )
            return cached["results"]
        return None

    def _store_voice_results(
        self,
        *,
        thread_id: str | None,
        platform: str | None,
        context_mode: str | None,
        query: str,
        results: list[dict],
        turn_count: int | None,
    ) -> None:
        if platform not in ("voice", "ios_voice") or not thread_id or not results:
            logger.info(
                "[Mem0Retrieval] fastcache_store_skipped | platform=%s | thread=%s | results=%d",
                platform, (thread_id[:8] if thread_id else "-"), len(results) if results else 0,
            )
            return

        cache_key = (thread_id, context_mode or "")
        with _VOICE_FASTCACHE_LOCK:
            _VOICE_FASTCACHE[cache_key] = {
                "stored_at": time.monotonic(),
                "turn_count": turn_count,
                "query": query,
                "query_tokens": self.query_tokens(query),
                "content_tokens": self.content_tokens(query),
                "results": results,
            }
            size_after = len(_VOICE_FASTCACHE)
        logger.info(
            "[Mem0Retrieval] fastcache_stored | thread=%s | results=%d | cache_size=%d",
            thread_id[:8], len(results), size_after,
        )

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def _run_search(
        self,
        state: Mem0RetrievalState,
        runtime: Runtime,
    ) -> tuple[list[dict], float]:
        """Execute the memory search and return (results, search_ms)."""
        context_mode = state.get("context_mode")
        platform = state.get("platform") or runtime.context.get("platform")
        thread_id = runtime.context.get("thread_id")
        turn_count = state.get("turn_count")
        messages = state.get("messages", [])

        memory_limit = _VOICE_MEMORY_LIMIT if platform in ("voice", "ios_voice") else _DEFAULT_MEMORY_LIMIT
        query = extract_last_message_text(messages).strip()[:200]

        _tid = str(thread_id or "")
        logger.info(
            "[Mem0RetrievalCtx] user_id=%s thread_id=%s platform=%s context_mode=%s turn=%s query=%r",
            self._user_id,
            (_tid[:8] + "..." if _tid else "-"),
            platform or "-",
            context_mode or "-",
            turn_count,
            query[:80],
        )

        if not query:
            return [], 0.0

        if platform in ("voice", "ios_voice") and self.is_low_signal_voice_query(query):
            cached_results = self._maybe_reuse_voice_results(
                thread_id=thread_id,
                platform=platform,
                context_mode=context_mode,
                query=query,
                turn_count=turn_count,
            )
            if cached_results is not None:
                return cached_results, 0.0
            return [], 0.0

        results = self._maybe_reuse_voice_results(
            thread_id=thread_id,
            platform=platform,
            context_mode=context_mode,
            query=query,
            turn_count=turn_count,
        )
        if results is not None:
            return results, 0.0

        _t_search = time.perf_counter()
        try:
            # Pass ``reference_date`` so Mem0 v3 temporal reasoning can anchor
            # relative-time queries ("yesterday", "last week", "earlier this
            # month") to *now* instead of the memory's own timestamp. Without
            # this, the platform's temporal layer falls back to default behavior
            # and stale memories outrank time-relevant ones for these queries.
            results = search_memories(
                user_id=self._user_id,
                query=query,
                limit=memory_limit,
                reference_date=datetime.now(UTC),
            )
        except Exception:
            logger.warning("Mem0 retrieval failed for user %s", self._user_id, exc_info=True)
            return [], 0.0

        search_ms = (time.perf_counter() - _t_search) * 1000
        self._store_voice_results(
            thread_id=thread_id,
            platform=platform,
            context_mode=context_mode,
            query=query,
            results=results,
            turn_count=turn_count,
        )

        # Log per-category breakdown (informational only — v3 handles ranking)
        category_counts: dict[str, int] = {}
        for mem in results[:memory_limit]:
            cat = mem.get("category", "unknown") or "unknown"
            category_counts[cat] = category_counts.get(cat, 0) + 1
        logger.info(
            "[Mem0Retrieval] %d results | search: %.0fms | breakdown: %s",
            len(results), search_ms,
            " | ".join(f"{cat}: {count}" for cat, count in sorted(category_counts.items())),
        )
        for i, mem in enumerate(results[:memory_limit]):
            logger.debug(
                "[Mem0Retrieval]   [%d] [%s] %s",
                i, mem.get("category", "?"), (mem.get("content", ""))[:100],
            )

        return results, search_ms

    # ------------------------------------------------------------------
    # Hooks
    # ------------------------------------------------------------------

    @override
    def before_agent(self, state: Mem0RetrievalState, runtime: Runtime) -> dict | None:
        """Sync path: search memories and store in state."""
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Mem0Retrieval", "skipped (crisis)", _t0)
            return None

        if self._user_id == _VOICE_WARMUP_USER_ID:
            log_middleware("Mem0Retrieval", "skipped (voice warmup)", _t0)
            return None

        results, search_ms = self._run_search(state, runtime)
        if not results:
            log_middleware("Mem0Retrieval", f"no memories (search: {search_ms:.0f}ms)", _t0)
            return {"prefetched_memories": [], "prefetched_memory_ids": []}

        memory_ids = [mem["id"] for mem in results if mem.get("id")]
        log_middleware("Mem0Retrieval", f"{len(results)} memories prefetched (search: {search_ms:.0f}ms)", _t0)
        return {
            "prefetched_memories": results,
            "prefetched_memory_ids": memory_ids,
        }

    @override
    async def abefore_agent(self, state: Mem0RetrievalState, runtime: Runtime) -> dict | None:
        """Async path: run search in a thread pool so it can overlap with
        other async middleware work."""
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Mem0Retrieval", "skipped (crisis)", _t0)
            return None

        if self._user_id == _VOICE_WARMUP_USER_ID:
            log_middleware("Mem0Retrieval", "skipped (voice warmup)", _t0)
            return None

        try:
            results, search_ms = await asyncio.to_thread(self._run_search, state, runtime)
        except Exception:
            logger.warning("Mem0 async retrieval failed for user %s", self._user_id, exc_info=True)
            log_middleware("Mem0Retrieval", "async retrieval failed", _t0)
            return {"prefetched_memories": [], "prefetched_memory_ids": []}

        if not results:
            log_middleware("Mem0Retrieval", f"no memories (search: {search_ms:.0f}ms)", _t0)
            return {"prefetched_memories": [], "prefetched_memory_ids": []}

        memory_ids = [mem["id"] for mem in results if mem.get("id")]
        log_middleware("Mem0Retrieval", f"{len(results)} memories prefetched (search: {search_ms:.0f}ms)", _t0)
        return {
            "prefetched_memories": results,
            "prefetched_memory_ids": memory_ids,
        }
