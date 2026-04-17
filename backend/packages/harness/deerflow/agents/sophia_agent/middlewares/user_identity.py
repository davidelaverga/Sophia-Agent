"""User identity middleware.

Reads the user's identity.md file and injects it as a system prompt block.
Returns empty on first session when the file doesn't exist yet.
"""

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import log_middleware, safe_user_path

logger = logging.getLogger(__name__)


class UserIdentityState(AgentState):
    skip_expensive: NotRequired[bool]
    system_prompt_blocks: NotRequired[list[str]]
    user_id: NotRequired[str]


class UserIdentityMiddleware(AgentMiddleware[UserIdentityState]):
    """Inject the user's identity file into system prompt."""

    state_schema = UserIdentityState

    def __init__(self, user_id: str):
        super().__init__()
        self._user_id = user_id

    @override
    def before_agent(self, state: UserIdentityState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("UserIdentity", "skipped (crisis)", _t0)
            return None

        updates: dict[str, object] = {}
        if state.get("user_id") != self._user_id:
            updates["user_id"] = self._user_id

        try:
            identity_path = safe_user_path(USERS_DIR, self._user_id, "identity.md")
        except ValueError:
            logger.warning("Invalid user_id for identity lookup: %s", self._user_id)
            if updates:
                log_middleware("UserIdentity", "user id cached (invalid identity path)", _t0)
                return updates
            log_middleware("UserIdentity", "no identity file", _t0)
            return None

        if not identity_path.exists():
            if updates:
                log_middleware("UserIdentity", "user id cached (no identity file)", _t0)
                return updates
            log_middleware("UserIdentity", "no identity file", _t0)
            return None

        try:
            content = identity_path.read_text(encoding="utf-8")
            if content.strip():
                blocks = list(state.get("system_prompt_blocks", []))
                blocks.append(f"<user_identity>\n{content}\n</user_identity>")
                updates["system_prompt_blocks"] = blocks
                log_middleware("UserIdentity", f"identity loaded ({len(content)} chars)", _t0)
                return updates
        except Exception:
            logger.warning("Failed to read identity file for user %s", self._user_id, exc_info=True)

        if updates:
            log_middleware("UserIdentity", "user id cached (identity read failed)", _t0)
            return updates
        log_middleware("UserIdentity", "no identity file", _t0)
        return None
