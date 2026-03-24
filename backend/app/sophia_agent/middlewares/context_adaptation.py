"""ContextAdaptationMiddleware — loads work/gaming/life context files.

Position 10 in chain. Reads one context file based on context_mode.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class ContextAdaptationMiddleware:
    """Inject the active context file (work, gaming, or life)."""

    runs_during_crisis = False

    def __init__(self, context_dir: Path, context_mode: str):
        self._context_dir = context_dir
        self._context_mode = context_mode

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state

        state["context_mode"] = self._context_mode
        context_file = self._context_dir / f"{self._context_mode}.md"
        if context_file.exists():
            state.setdefault("system_prompt_blocks", []).append(context_file.read_text())

        return state
