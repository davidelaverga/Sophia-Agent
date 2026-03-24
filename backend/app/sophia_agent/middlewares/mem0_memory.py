"""Mem0MemoryMiddleware — retrieves memories before LLM call.

Position 13 in chain. After ritual+skill set so retrieval can be
biased by both. Before-phase only — after-phase (extraction) runs
in the offline pipeline, never in-turn.

Rule-based category selection documented in CLAUDE.md § Mem0.
"""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class Mem0MemoryMiddleware:
    """Retrieve and inject relevant memories from Mem0."""

    runs_during_crisis = False

    def __init__(self, user_id: str):
        self._user_id = user_id

    def _select_categories(self, state: SophiaState) -> list[str]:
        """Rule-based category selection before semantic search."""
        categories = ["fact", "preference"]

        ritual = state.get("active_ritual")
        if ritual in ("prepare", "debrief"):
            categories += ["commitment", "decision"]
        if ritual == "vent":
            categories += ["feeling", "relationship"]
        if ritual == "reset":
            categories += ["feeling", "pattern"]

        skill = state.get("active_skill", "")
        if skill in ("vulnerability_holding", "trust_building"):
            categories += ["feeling", "relationship"]
        if skill == "challenging_growth":
            categories += ["pattern", "lesson"]

        if ritual:
            categories.append("ritual_context")

        return list(set(categories))

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state

        # TODO(jorge): Wire up mem0_client.search() with category filtering
        # and inject results into system_prompt_blocks.
        # Categories to query: self._select_categories(state)
        # Results should be formatted as <memories>...</memories> block.
        state["injected_memories"] = []

        return state
