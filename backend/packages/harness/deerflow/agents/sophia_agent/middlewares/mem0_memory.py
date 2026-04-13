"""Mem0 memory middleware.

Before-phase: rule-based category selection, cached search, inject memories.
After-phase: queues session for offline extraction (does NOT write per-turn).
"""

import logging
import re
import threading
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import extract_last_message_text, log_middleware
from deerflow.sophia.mem0_client import search_memories, warm_up

logger = logging.getLogger(__name__)


class Mem0MemoryState(AgentState):
    skip_expensive: NotRequired[bool]
    active_ritual: NotRequired[str | None]
    active_skill: NotRequired[str]
    context_mode: NotRequired[str]
    injected_memories: NotRequired[list[str]]
    platform: NotRequired[str]
    turn_count: NotRequired[int]
    system_prompt_blocks: NotRequired[list[str]]


# Context-specific categories that get added when the matching context_mode is active
_CONTEXT_MODE_CATEGORIES: dict[str, list[str]] = {
    "work": ["project", "colleague", "career", "deadline"],
    "gaming": ["game", "achievement", "gaming_team", "strategy"],
    "life": ["family", "health", "personal_goal", "life_event"],
}

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


def _select_categories(
    ritual: str | None,
    active_skill: str | None,
    messages: list,
    context_mode: str | None = None,
) -> list[str]:
    """Rule-based category selection from CLAUDE.md spec + context-specific categories."""
    categories = ["fact", "preference"]  # always

    # Add context-specific categories
    if context_mode and context_mode in _CONTEXT_MODE_CATEGORIES:
        categories += _CONTEXT_MODE_CATEGORIES[context_mode]

    if ritual in ("prepare", "debrief"):
        categories += ["commitment", "decision"]
    if ritual == "vent":
        categories += ["feeling", "relationship"]
    if ritual == "reset":
        categories += ["feeling", "pattern"]

    if active_skill in ("vulnerability_holding", "trust_building"):
        categories += ["feeling", "relationship"]
    if active_skill == "challenging_growth":
        categories += ["pattern", "lesson"]

    if ritual:
        categories.append("ritual_context")

    # Deduplicate while preserving order
    return list(dict.fromkeys(categories))


class Mem0MemoryMiddleware(AgentMiddleware[Mem0MemoryState]):
    """Retrieve and inject Mem0 memories per turn."""

    state_schema = Mem0MemoryState

    def __init__(self, user_id: str):
        super().__init__()
        self._user_id = user_id
        self._voice_recent_cache: dict[tuple[str, str, tuple[str, ...]], dict] = {}
        self._voice_recent_cache_lock = threading.Lock()
        warm_up()

    @staticmethod
    def _query_tokens(query: str) -> set[str]:
        return {
            token
            for token in _QUERY_TOKEN_RE.findall(query.lower())
            if len(token) >= 3
        }

    @staticmethod
    def _content_tokens(query: str) -> set[str]:
        return {
            token
            for token in _QUERY_TOKEN_RE.findall(query.lower())
            if len(token) >= 3 and token not in _QUERY_STOPWORDS
        }

    @staticmethod
    def _is_low_signal_voice_query(query: str) -> bool:
        normalized = query.lower().strip()
        if not normalized:
            return True
        if _VOICE_LOW_SIGNAL_RE.search(normalized):
            return True
        content_tokens = Mem0MemoryMiddleware._content_tokens(normalized)
        token_count = len(_QUERY_TOKEN_RE.findall(normalized))
        return "?" not in normalized and token_count <= 3 and len(content_tokens) <= 1

    @staticmethod
    def _is_explicit_memory_query(query: str) -> bool:
        return bool(_VOICE_EXPLICIT_MEMORY_RE.search(query.lower()))

    @classmethod
    def _is_clear_topic_shift(cls, query: str, cached_content_tokens: set[str]) -> bool:
        if not cached_content_tokens:
            return False

        normalized = query.lower().strip()
        if _VOICE_CONTINUATION_RE.search(normalized):
            return False

        query_content_tokens = cls._content_tokens(normalized)
        if len(query_content_tokens) < 3 or len(cached_content_tokens) < 3:
            return False

        return len(query_content_tokens & cached_content_tokens) == 0

    def _maybe_reuse_voice_results(
        self,
        *,
        thread_id: str | None,
        platform: str | None,
        context_mode: str | None,
        categories: list[str],
        query: str,
        turn_count: int | None,
    ) -> list[dict] | None:
        if platform not in ("voice", "ios_voice") or not thread_id:
            return None

        cache_key = (thread_id, context_mode or "", tuple(categories))
        with self._voice_recent_cache_lock:
            cached = self._voice_recent_cache.get(cache_key)
        if not cached:
            return None

        age_seconds = time.monotonic() - cached["stored_at"]
        if age_seconds > _VOICE_FAST_CACHE_TTL_SECONDS:
            with self._voice_recent_cache_lock:
                self._voice_recent_cache.pop(cache_key, None)
            return None

        if self._is_low_signal_voice_query(query):
            logger.info(
                "[Mem0Memory] voice recent-cache hit | thread_id=%s | reason=low_signal | age_ms=%.0f",
                thread_id,
                age_seconds * 1000,
            )
            return cached["results"]

        if self._is_explicit_memory_query(query):
            return None

        cached_content_tokens = cached["content_tokens"]
        if not self._is_clear_topic_shift(query, cached_content_tokens):
            if age_seconds <= _VOICE_FAST_CACHE_STICKY_SECONDS:
                logger.info(
                    "[Mem0Memory] voice recent-cache hit | thread_id=%s | reason=sticky | age_ms=%.0f",
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
                    "[Mem0Memory] voice recent-cache hit | thread_id=%s | reason=recent_turn_window | turn_delta=%s",
                    thread_id,
                    turn_count - cached_turn_count,
                )
                return cached["results"]

        query_tokens = self._query_tokens(query)
        cached_tokens = cached["query_tokens"]
        if not query_tokens:
            logger.info("[Mem0Memory] voice recent-cache hit | thread_id=%s | reason=empty_query_tokens", thread_id)
            return cached["results"]

        overlap_count = len(query_tokens & cached_tokens)
        if overlap_count == 0:
            return None

        union_count = len(query_tokens | cached_tokens)
        overlap = overlap_count / union_count if union_count else 1.0
        if len(query_tokens) <= _VOICE_FAST_CACHE_SHORT_QUERY_TOKENS or overlap >= _VOICE_FAST_CACHE_MIN_OVERLAP:
            logger.info(
                "[Mem0Memory] voice recent-cache hit | thread_id=%s | overlap=%.2f | age_ms=%.0f",
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
        categories: list[str],
        query: str,
        results: list[dict],
        turn_count: int | None,
    ) -> None:
        if platform not in ("voice", "ios_voice") or not thread_id or not results:
            return

        cache_key = (thread_id, context_mode or "", tuple(categories))
        with self._voice_recent_cache_lock:
            self._voice_recent_cache[cache_key] = {
                "stored_at": time.monotonic(),
                "turn_count": turn_count,
                "query": query,
                "query_tokens": self._query_tokens(query),
                "content_tokens": self._content_tokens(query),
                "results": results,
            }

    @override
    def before_agent(self, state: Mem0MemoryState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Mem0Memory", "skipped (crisis)", _t0)
            return None

        if self._user_id == _VOICE_WARMUP_USER_ID:
            log_middleware("Mem0Memory", "skipped (voice warmup)", _t0)
            return None

        ritual = state.get("active_ritual")
        active_skill = state.get("active_skill")
        context_mode = state.get("context_mode")
        platform = state.get("platform") or runtime.context.get("platform")
        thread_id = runtime.context.get("thread_id")
        turn_count = state.get("turn_count")
        messages = state.get("messages", [])

        categories = _select_categories(ritual, active_skill, messages, context_mode)
        memory_limit = _VOICE_MEMORY_LIMIT if platform in ("voice", "ios_voice") else _DEFAULT_MEMORY_LIMIT

        # Build query from last user message
        query = extract_last_message_text(messages).strip()[:200]

        if not query:
            log_middleware("Mem0Memory", "skipped (empty query)", _t0)
            return None

        if platform in ("voice", "ios_voice") and self._is_low_signal_voice_query(query):
            cached_results = self._maybe_reuse_voice_results(
                thread_id=thread_id,
                platform=platform,
                context_mode=context_mode,
                categories=categories,
                query=query,
                turn_count=turn_count,
            )
            if cached_results is not None:
                results = cached_results
                search_ms = 0.0
            else:
                log_middleware("Mem0Memory", "skipped (low-signal voice turn)", _t0)
                return None
        else:
            results = self._maybe_reuse_voice_results(
                thread_id=thread_id,
                platform=platform,
                context_mode=context_mode,
                categories=categories,
                query=query,
                turn_count=turn_count,
            )
            search_ms = 0.0

        logger.info(
            "[Mem0Memory] query='%s' | categories=%s | context_mode=%s | ritual=%s | skill=%s",
            query[:80], categories, context_mode, ritual, active_skill,
        )

        if results is None:
            _t_search = time.perf_counter()
            try:
                results = search_memories(
                    user_id=self._user_id,
                    query=query,
                    categories=categories,
                    context_mode=context_mode,
                    limit=memory_limit,
                )
            except Exception:
                logger.warning("Mem0 retrieval failed for user %s", self._user_id, exc_info=True)
                log_middleware("Mem0Memory", "retrieval failed", _t0)
                return None
            search_ms = (time.perf_counter() - _t_search) * 1000
            self._store_voice_results(
                thread_id=thread_id,
                platform=platform,
                context_mode=context_mode,
                categories=categories,
                query=query,
                results=results,
                turn_count=turn_count,
            )

        if not results:
            log_middleware("Mem0Memory", f"no memories found (search: {search_ms:.0f}ms)", _t0)
            return None

        # Log per-category breakdown
        category_counts: dict[str, int] = {}
        for mem in results[:memory_limit]:
            cat = mem.get("category", "unknown") or "unknown"
            category_counts[cat] = category_counts.get(cat, 0) + 1
        logger.info(
            "[Mem0Memory] %d results | search: %.0fms | breakdown: %s",
            len(results), search_ms,
            " | ".join(f"{cat}: {count}" for cat, count in sorted(category_counts.items())),
        )
        # Log each memory's content preview for debugging
        for i, mem in enumerate(results[:memory_limit]):
            logger.debug(
                "[Mem0Memory]   [%d] [%s] %s",
                i, mem.get("category", "?"), (mem.get("content", ""))[:100],
            )

        # Format memories for prompt injection
        memory_lines = []
        memory_ids = []
        for mem in results[:memory_limit]:
            memory_lines.append(f"- {mem.get('content', '')}")
            if mem.get("id"):
                memory_ids.append(mem["id"])

        block = "<memories>\n" + "\n".join(memory_lines) + "\n</memories>"

        log_middleware("Mem0Memory", f"{len(results)} memories injected (search: {search_ms:.0f}ms)", _t0)
        return {
            "injected_memories": memory_ids,
            "system_prompt_blocks": list(state.get("system_prompt_blocks", [])) + [block],
        }

    @override
    def after_agent(self, state: Mem0MemoryState, runtime: Runtime) -> dict | None:
        """Queue session for offline extraction. Does NOT write per-turn."""
        # The offline pipeline handles Mem0 writes.
        # Here we just log that the session should be processed.
        thread_id = runtime.context.get("thread_id")
        if thread_id:
            logger.debug("Session %s queued for offline Mem0 extraction", thread_id)
        return None
