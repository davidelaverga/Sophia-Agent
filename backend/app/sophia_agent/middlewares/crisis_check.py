"""CrisisCheckMiddleware — fast-path for crisis language detection.

Position 2 in chain. BEFORE any expensive middleware.
When triggered: sets force_skill="crisis_redirect" and skip_expensive=True.
Only soul.md + crisis_redirect.md are injected on crisis path.
"""

from __future__ import annotations

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState

CRISIS_SIGNALS = [
    "want to die",
    "kill myself",
    "end it all",
    "don't want to be here",
    "hurt myself",
    "self harm",
    "suicide",
    "not worth living",
    "can't go on",
    "want to disappear",
]


class CrisisCheckMiddleware:
    """Scans last message for crisis language and activates fast-path."""

    runs_during_crisis = True

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if not state.get("messages"):
            return state
        last_content = state["messages"][-1].content
        if isinstance(last_content, str):
            last_lower = last_content.lower()
            if any(signal in last_lower for signal in CRISIS_SIGNALS):
                state["force_skill"] = "crisis_redirect"
                state["skip_expensive"] = True
        return state
