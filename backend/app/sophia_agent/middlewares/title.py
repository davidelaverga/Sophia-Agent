"""SophiaTitleMiddleware — ritual-aware title generation.

Position 15 in chain. Generates thread title after first exchange.
"""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class SophiaTitleMiddleware:
    """Generate a ritual-aware thread title."""

    runs_during_crisis = False

    async def after(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        # TODO(jorge): Implement ritual-aware title prompt.
        # Use active_ritual to prefix title when applicable.
        return state
