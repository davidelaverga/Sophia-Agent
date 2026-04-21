"""Builder delivery middleware.

Clears the previous turn's transient builder delivery payload before each new
Sophia companion turn so attachments are only re-sent intentionally.
"""

import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware


class BuilderDeliveryState(AgentState):
    builder_delivery: NotRequired[dict | None]


class BuilderDeliveryMiddleware(AgentMiddleware[BuilderDeliveryState]):
    """Clear ephemeral builder_delivery state at the start of each turn."""

    state_schema = BuilderDeliveryState

    @override
    def before_agent(self, state: BuilderDeliveryState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("builder_delivery") is None:
            log_middleware("BuilderDelivery", "no stale delivery payload", _t0)
            return None
        log_middleware("BuilderDelivery", "cleared stale delivery payload", _t0)
        return {"builder_delivery": None}
