"""User identity middleware.

Reads the user's identity.md file and injects it as a system prompt block.
Returns empty on first session when the file doesn't exist yet.
"""

import logging
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import safe_user_path

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent.parent.parent
_USERS_DIR = _PROJECT_ROOT / "users"


class UserIdentityState(AgentState):
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]


class UserIdentityMiddleware(AgentMiddleware[UserIdentityState]):
    """Inject the user's identity file into system prompt."""

    state_schema = UserIdentityState

    def __init__(self, user_id: str):
        super().__init__()
        self._user_id = user_id

    @override
    def before_agent(self, state: UserIdentityState, runtime: Runtime) -> dict | None:
        if state.get("skip_expensive", False):
            return None

        try:
            identity_path = safe_user_path(_USERS_DIR, self._user_id, "identity.md")
        except ValueError:
            logger.warning("Invalid user_id for identity lookup: %s", self._user_id)
            return None

        if not identity_path.exists():
            return None

        try:
            content = identity_path.read_text(encoding="utf-8")
            if content.strip():
                return {"system_prompt_blocks": [f"<user_identity>\n{content}\n</user_identity>"]}
        except Exception:
            logger.warning("Failed to read identity file for user %s", self._user_id, exc_info=True)

        return None
