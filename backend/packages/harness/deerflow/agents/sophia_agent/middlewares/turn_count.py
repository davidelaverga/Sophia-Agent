"""Turn count middleware.

Derives the prior completed user-turn count from the conversation state so
first-turn-only middlewares do not keep firing on every request.
"""

import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware


class TurnCountState(AgentState):
    turn_count: NotRequired[int]


class TurnCountMiddleware(AgentMiddleware[TurnCountState]):
    """Populate turn_count from the current message history."""

    state_schema = TurnCountState

    @staticmethod
    def _is_user_message(message: object) -> bool:
        return getattr(message, "type", None) in ("human", "user")

    @override
    def before_agent(self, state: TurnCountState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        messages = state.get("messages", [])
        if not messages:
            log_middleware("TurnCount", "turn_count=0 (no messages)", _t0)
            return {"turn_count": 0}

        user_message_count = sum(1 for message in messages if self._is_user_message(message))
        latest_is_user = self._is_user_message(messages[-1])
        completed_turns = user_message_count - 1 if latest_is_user else user_message_count
        turn_count = max(completed_turns, 0)

        log_middleware("TurnCount", f"turn_count={turn_count}", _t0)
        return {"turn_count": turn_count}