"""Sophia title middleware.

Generates a 3-5 word session title after the first complete exchange,
incorporating ritual and session goal context from the artifact.
"""

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


class SophiaTitleState(AgentState):
    title: NotRequired[str | None]
    turn_count: NotRequired[int]
    current_artifact: NotRequired[dict | None]
    active_ritual: NotRequired[str | None]
    ritual_phase: NotRequired[str | None]


class SophiaTitleMiddleware(AgentMiddleware[SophiaTitleState]):
    """Generate session title on first turn."""

    state_schema = SophiaTitleState

    @override
    def after_model(self, state: SophiaTitleState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        # Only generate on first exchange
        if state.get("title"):
            log_middleware("Title", "already set", _t0)
            return None

        turn_count = state.get("turn_count", 0)
        if turn_count > 1:
            log_middleware("Title", "skipped (not turn 0)", _t0)
            return None

        artifact = state.get("current_artifact") or {}
        session_goal = artifact.get("session_goal", "")
        ritual = state.get("active_ritual")

        # Build a simple title from available context
        parts = []
        if ritual:
            parts.append(ritual.capitalize())
        if session_goal:
            # Take first few words of session_goal
            words = session_goal.split()[:4]
            parts.append(" ".join(words))

        if parts:
            title = " — ".join(parts)
        else:
            title = "New session"

        # Cap at reasonable length
        if len(title) > 50:
            title = title[:47] + "..."

        log_middleware("Title", f"title='{title}'", _t0)
        return {"title": title}
