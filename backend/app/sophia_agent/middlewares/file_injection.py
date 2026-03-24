"""FileInjectionMiddleware — injects a skill file into system prompt blocks.

Positions 3-5 in chain (soul.md, voice.md, techniques.md).
voice.md and techniques.md set skip_on_crisis=True.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class FileInjectionMiddleware:
    """Read a file at init and inject its content into system_prompt_blocks."""

    runs_during_crisis = False  # overridden per instance via skip_on_crisis

    def __init__(self, file_path: Path, *, skip_on_crisis: bool = False):
        self._content = file_path.read_text() if file_path.exists() else ""
        self._skip_on_crisis = skip_on_crisis

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if self._skip_on_crisis and state.get("skip_expensive"):
            return state
        state.setdefault("system_prompt_blocks", []).append(self._content)
        return state
