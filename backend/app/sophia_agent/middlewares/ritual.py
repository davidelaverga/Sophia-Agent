"""RitualMiddleware — loads ritual files, tracks ritual_phase in state.

Position 11 in chain. MUST be before SkillRouter (position 12).
SkillRouter reads active_ritual from state — if Ritual hasn't run first,
skill routing has no ritual context.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.runnables import RunnableConfig

from app.sophia_agent.state import SophiaState


class RitualMiddleware:
    """Load active ritual file and set ritual state."""

    runs_during_crisis = False

    def __init__(self, rituals_dir: Path, ritual: str | None):
        self._rituals_dir = rituals_dir
        self._ritual = ritual

    async def before(self, state: SophiaState, config: RunnableConfig) -> SophiaState:
        if state.get("skip_expensive"):
            return state

        state["active_ritual"] = self._ritual

        if not self._ritual:
            return state

        ritual_file = self._rituals_dir / f"{self._ritual}.md"
        if ritual_file.exists():
            state.setdefault("system_prompt_blocks", []).append(ritual_file.read_text())

        # Initialize ritual_phase if not set
        if not state.get("ritual_phase"):
            state["ritual_phase"] = f"{self._ritual}.step1"

        return state
