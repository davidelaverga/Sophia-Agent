"""Ritual middleware.

Loads ritual file when a ritual is active and sets ritual state fields.
Must run BEFORE SkillRouterMiddleware so skill routing has ritual context.
"""

import logging
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

VALID_RITUALS = {"prepare", "debrief", "vent", "reset"}


class RitualState(AgentState):
    skip_expensive: NotRequired[bool]
    active_ritual: NotRequired[str | None]
    ritual_phase: NotRequired[str | None]
    system_prompt_blocks: NotRequired[list[str]]


class RitualMiddleware(AgentMiddleware[RitualState]):
    """Inject ritual guidance and set ritual state."""

    state_schema = RitualState

    def __init__(self, rituals_dir: Path, ritual: str | None):
        super().__init__()
        self._rituals_dir = rituals_dir
        self._ritual = ritual if ritual in VALID_RITUALS else None
        # Pre-load ritual file if available
        self._content: str | None = None
        if self._ritual:
            path = rituals_dir / f"{self._ritual}.md"
            if path.exists():
                self._content = path.read_text(encoding="utf-8")
            else:
                logger.warning("Ritual file not found: %s", path)

    @override
    def before_agent(self, state: RitualState, runtime: Runtime) -> dict | None:
        if state.get("skip_expensive", False):
            return None

        if not self._ritual:
            return {"active_ritual": None, "ritual_phase": None}

        result: dict = {
            "active_ritual": self._ritual,
        }

        # Initialize ritual_phase if not already set
        if not state.get("ritual_phase"):
            result["ritual_phase"] = f"{self._ritual}.intro"

        if self._content:
            result["system_prompt_blocks"] = [self._content]

        return result
