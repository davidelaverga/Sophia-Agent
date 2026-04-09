"""Mem0 memory middleware.

Before-phase: rule-based category selection, cached search, inject memories.
After-phase: queues session for offline extraction (does NOT write per-turn).
"""

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import extract_last_message_text, log_middleware
from deerflow.sophia.mem0_client import search_memories

logger = logging.getLogger(__name__)


class Mem0MemoryState(AgentState):
    skip_expensive: NotRequired[bool]
    active_ritual: NotRequired[str | None]
    active_skill: NotRequired[str]
    context_mode: NotRequired[str]
    injected_memories: NotRequired[list[str]]
    injected_memory_contents: NotRequired[list[str]]
    system_prompt_blocks: NotRequired[list[str]]


# Context-specific categories that get added when the matching context_mode is active
_CONTEXT_MODE_CATEGORIES: dict[str, list[str]] = {
    "work": ["project", "colleague", "career", "deadline"],
    "gaming": ["game", "achievement", "gaming_team", "strategy"],
    "life": ["family", "health", "personal_goal", "life_event"],
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

    @override
    def before_agent(self, state: Mem0MemoryState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Mem0Memory", "skipped (crisis)", _t0)
            return None

        ritual = state.get("active_ritual")
        active_skill = state.get("active_skill")
        context_mode = state.get("context_mode")
        messages = state.get("messages", [])

        categories = _select_categories(ritual, active_skill, messages, context_mode)

        # Build query from last user message
        query = extract_last_message_text(messages)[:200]  # truncate for search

        logger.info(
            "[Mem0Memory] query='%s' | categories=%s | context_mode=%s | ritual=%s | skill=%s",
            query[:80], categories, context_mode, ritual, active_skill,
        )

        _t_search = time.perf_counter()
        try:
            results = search_memories(
                user_id=self._user_id,
                query=query,
                categories=categories,
                context_mode=context_mode,
            )
        except Exception:
            logger.warning("Mem0 retrieval failed for user %s", self._user_id, exc_info=True)
            log_middleware("Mem0Memory", "retrieval failed", _t0)
            return None
        search_ms = (time.perf_counter() - _t_search) * 1000

        if not results:
            log_middleware("Mem0Memory", f"no memories found (search: {search_ms:.0f}ms)", _t0)
            return None

        # Log per-category breakdown
        category_counts: dict[str, int] = {}
        for mem in results[:10]:
            cat = mem.get("category", "unknown") or "unknown"
            category_counts[cat] = category_counts.get(cat, 0) + 1
        logger.info(
            "[Mem0Memory] %d results | search: %.0fms | breakdown: %s",
            len(results), search_ms,
            " | ".join(f"{cat}: {count}" for cat, count in sorted(category_counts.items())),
        )
        # Log each memory's content preview for debugging
        for i, mem in enumerate(results[:10]):
            logger.debug(
                "[Mem0Memory]   [%d] [%s] %s",
                i, mem.get("category", "?"), (mem.get("content", ""))[:100],
            )

        # Format memories for prompt injection
        memory_lines = []
        memory_ids = []
        memory_contents = []
        for mem in results[:10]:  # cap at 10 results
            content = str(mem.get("content", "")).strip()
            if not content:
                continue
            memory_lines.append(f"- {content}")
            memory_contents.append(content)
            if mem.get("id"):
                memory_ids.append(mem["id"])

        block = "<memories>\n" + "\n".join(memory_lines) + "\n</memories>"

        log_middleware("Mem0Memory", f"{len(results)} memories injected (search: {search_ms:.0f}ms)", _t0)
        return {
            "injected_memories": memory_ids,
            "injected_memory_contents": memory_contents,
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
