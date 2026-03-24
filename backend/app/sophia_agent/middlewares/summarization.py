"""SophiaSummarizationMiddleware — enhanced with artifact arc extraction.

Position 16 (last) in chain. Context reduction when approaching limits.
"""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class SophiaSummarizationMiddleware:
    """Summarize conversation with artifact arc extraction."""

    runs_during_crisis = False

    async def after(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        # TODO(jorge): Implement enhanced summarization with artifact arc.
        return state
