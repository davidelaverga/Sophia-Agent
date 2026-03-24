"""PlatformContextMiddleware — sets platform in state from configurable.

Position 6 in chain. All downstream middlewares read state["platform"].
"""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class PlatformContextMiddleware:
    """Extract platform signal from config and set in state."""

    runs_during_crisis = True

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        cfg = config.get("configurable", {})
        state["platform"] = cfg.get("platform", "voice")
        return state
