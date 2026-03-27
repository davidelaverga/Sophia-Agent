"""Session state middleware.

Reads the user's handoff file and extracts the smart opener for first-turn
injection. On turn_count == 0, injects a first-turn instruction block.
"""

import logging
import re
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)


class SessionStateState(AgentState):
    turn_count: NotRequired[int]
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]


class SessionStateMiddleware(AgentMiddleware[SessionStateState]):
    """Inject smart opener on first turn from handoff file."""

    state_schema = SessionStateState

    def __init__(self, user_id: str):
        super().__init__()
        self._user_id = user_id

    def _extract_smart_opener(self, content: str) -> str | None:
        """Extract smart_opener from YAML frontmatter."""
        match = re.search(r"^smart_opener:\s*[\"']?(.+?)[\"']?\s*$", content, re.MULTILINE)
        if match:
            return match.group(1).strip()
        return None

    @override
    def before_agent(self, state: SessionStateState, runtime: Runtime) -> dict | None:
        if state.get("skip_expensive", False):
            return None

        turn_count = state.get("turn_count", 0)
        if turn_count != 0:
            return None

        try:
            handoff_path = safe_user_path(USERS_DIR, self._user_id, "handoffs", "latest.md")
        except ValueError:
            logger.warning("Invalid user_id for session state: %s", self._user_id)
            return None

        if not handoff_path.exists():
            return None

        try:
            content = handoff_path.read_text(encoding="utf-8")
            opener = self._extract_smart_opener(content)
            if opener:
                block = (
                    "<first_turn_instruction>\n"
                    f"This is the first turn of a new session. Open with: \"{opener}\"\n"
                    "Deliver this as your opening line before the user says anything.\n"
                    "</first_turn_instruction>"
                )
                return {"system_prompt_blocks": [block]}
        except Exception:
            logger.warning("Failed to read handoff for user %s", self._user_id, exc_info=True)

        return None
