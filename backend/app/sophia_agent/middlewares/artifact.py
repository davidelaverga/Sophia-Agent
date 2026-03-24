"""ArtifactMiddleware — injects artifact_instructions.md.

Position 14 in chain. Also handles platform-conditional injection
and previous artifact injection.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class ArtifactMiddleware:
    """Inject artifact instructions and previous artifact context."""

    runs_during_crisis = False

    def __init__(self, artifact_instructions_path: Path):
        self._content = ""
        if artifact_instructions_path.exists():
            self._content = artifact_instructions_path.read_text()

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state

        if self._content:
            state.setdefault("system_prompt_blocks", []).append(self._content)

        # Inject previous artifact for continuity
        prev = state.get("previous_artifact")
        if prev and isinstance(prev, dict):
            state.setdefault("system_prompt_blocks", []).append(
                f"<previous_artifact>{prev}</previous_artifact>"
            )

        return state
