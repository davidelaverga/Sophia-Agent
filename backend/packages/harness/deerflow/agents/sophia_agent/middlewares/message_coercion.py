"""Normalize message-like payloads into LangChain BaseMessage objects.

Sophia voice and HTTP entrypoints can supply message dictionaries like
{"role": "user", "content": "..."}. These are valid message-like payloads,
but several middlewares in the companion chain assume concrete BaseMessage
instances and access attributes like `.id` and `.type`. Coerce them once at the
start of the chain so later middleware can treat state["messages"] uniformly.
"""

import logging
import time
from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages.base import BaseMessage
from langchain_core.messages.utils import convert_to_messages
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


class MessageCoercionMiddleware(AgentMiddleware[AgentState]):
    """Coerce dict-backed messages to BaseMessage before other middleware runs."""

    state_schema = AgentState

    @override
    def before_agent(self, state: AgentState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        messages = state.get("messages", [])
        if not messages:
            return None

        if all(isinstance(message, BaseMessage) for message in messages):
            return None

        try:
            normalized = convert_to_messages(messages)
        except Exception:
            logger.exception("Failed to coerce Sophia messages before agent execution")
            raise

        coerced_count = sum(not isinstance(message, BaseMessage) for message in messages)
        log_middleware("MessageCoercion", f"coerced {coerced_count}/{len(messages)} messages", _t0)
        return {"messages": normalized}