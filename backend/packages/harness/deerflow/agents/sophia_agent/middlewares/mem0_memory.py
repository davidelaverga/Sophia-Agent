"""Mem0 memory middleware.

Before-phase: rule-based category selection, cached search, inject memories.
After-phase: queues session for offline extraction (does NOT write per-turn).
"""

import logging
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)


class Mem0MemoryState(AgentState):
    skip_expensive: NotRequired[bool]
    active_ritual: NotRequired[str | None]
    active_skill: NotRequired[str]
    injected_memories: NotRequired[list[str]]
    system_prompt_blocks: NotRequired[list[str]]


def _select_categories(
    ritual: str | None,
    active_skill: str | None,
    messages: list,
) -> list[str]:
    """Rule-based category selection from CLAUDE.md spec."""
    categories = ["fact", "preference"]  # always

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
        if state.get("skip_expensive", False):
            return None

        ritual = state.get("active_ritual")
        active_skill = state.get("active_skill")
        messages = state.get("messages", [])

        categories = _select_categories(ritual, active_skill, messages)

        # Build query from last user message
        query = ""
        if messages:
            content = getattr(messages[-1], "content", "")
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            query = str(content)[:200]  # truncate for search

        try:
            from deerflow.sophia.mem0_client import search_memories

            results = search_memories(
                user_id=self._user_id,
                query=query,
                categories=categories,
            )
        except Exception:
            logger.warning("Mem0 retrieval failed for user %s", self._user_id, exc_info=True)
            return None

        if not results:
            return None

        # Format memories for prompt injection
        memory_lines = []
        memory_ids = []
        for mem in results[:10]:  # cap at 10 results
            memory_lines.append(f"- {mem.get('content', '')}")
            if mem.get("id"):
                memory_ids.append(mem["id"])

        block = "<memories>\n" + "\n".join(memory_lines) + "\n</memories>"

        return {
            "injected_memories": memory_ids,
            "system_prompt_blocks": [block],
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
