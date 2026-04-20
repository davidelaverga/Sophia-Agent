"""Sophia title middleware.

Generates a session title:
- Turn 0: quick title from ritual + session_goal artifact
- After summarization (turn 5+): refined title from the summary message
  that captures the actual conversation topic
"""

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

# After this many turns, refine the title from conversation context
_REFINE_AFTER_TURN = 5


class SophiaTitleState(AgentState):
    title: NotRequired[str | None]
    turn_count: NotRequired[int]
    current_artifact: NotRequired[dict | None]
    active_ritual: NotRequired[str | None]
    ritual_phase: NotRequired[str | None]


class SophiaTitleMiddleware(AgentMiddleware[SophiaTitleState]):
    """Generate and refine session title."""

    state_schema = SophiaTitleState

    def __init__(self):
        super().__init__()
        self._refined = False

    @override
    def after_model(self, state: SophiaTitleState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        turn_count = state.get("turn_count", 0)
        current_title = state.get("title")

        # Turn 0: generate initial title from artifact + ritual
        if not current_title:
            title = self._generate_initial_title(state)
            log_middleware("Title", f"title='{title}'", _t0)
            return {"title": title}

        # After N turns: refine title from conversation summary (once)
        if not self._refined and turn_count >= _REFINE_AFTER_TURN:
            refined = self._refine_from_summary(state)
            if refined and refined != current_title:
                self._refined = True
                log_middleware("Title", f"refined='{refined}' (was '{current_title}')", _t0)
                return {"title": refined}

        log_middleware("Title", "already set", _t0)
        return None

    def _generate_initial_title(self, state: SophiaTitleState) -> str:
        """Build a quick title from ritual + artifact session_goal."""
        artifact = state.get("current_artifact") or {}
        session_goal = artifact.get("session_goal", "")
        ritual = state.get("active_ritual")

        parts = []
        if ritual:
            parts.append(ritual.capitalize())
        if session_goal:
            words = session_goal.split()[:4]
            parts.append(" ".join(words))

        if parts:
            title = " — ".join(parts)
        else:
            title = "New session"

        if len(title) > 50:
            title = title[:47] + "..."
        return title

    def _refine_from_summary(self, state: SophiaTitleState) -> str | None:
        """Extract a better title from the summarization message if present.

        SummarizationMiddleware replaces old messages with a SystemMessage
        containing the conversation summary. We use that + the latest
        artifact to build a more descriptive title.
        """
        messages = state.get("messages", [])
        artifact = state.get("current_artifact") or {}

        # Look for the summary message (SystemMessage injected by SummarizationMiddleware)
        summary_text = None
        for msg in messages:
            if isinstance(msg, SystemMessage) and hasattr(msg, "content"):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                # SummarizationMiddleware summaries are typically longer than
                # the prompt assembly system message and contain conversation context
                if "summary" in content.lower() or len(content) > 200:
                    summary_text = content
                    break

        if not summary_text:
            return None

        # Build title from the artifact's session_goal (updated by the model
        # every turn, so by turn 5+ it reflects the real topic)
        session_goal = artifact.get("session_goal", "")
        takeaway = artifact.get("takeaway", "")
        ritual = state.get("active_ritual")

        # Use session_goal — it's updated each turn and captures the real topic
        if session_goal:
            # Take meaningful words, skip generic prefixes
            words = session_goal.split()
            if len(words) > 6:
                words = words[:6]
            title = " ".join(words)
        elif takeaway:
            words = takeaway.split()[:5]
            title = " ".join(words)
        else:
            return None

        if ritual:
            title = f"{ritual.capitalize()} — {title}"

        if len(title) > 50:
            title = title[:47] + "..."
        return title
