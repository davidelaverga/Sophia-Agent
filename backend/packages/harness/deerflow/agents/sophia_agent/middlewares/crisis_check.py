"""Crisis fast-path middleware.

Detects crisis language in the user's last message and sets state flags
that cause downstream middlewares to short-circuit. Only soul.md and
crisis_redirect.md are injected on the crisis path.
"""

from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

CRISIS_SIGNALS = [
    "want to die",
    "kill myself",
    "end it all",
    "don't want to be here",
    "hurt myself",
    "self harm",
    "suicide",
    "not worth living",
    "can't go on",
    "want to disappear",
]


class CrisisCheckState(AgentState):
    force_skill: NotRequired[str | None]
    skip_expensive: NotRequired[bool]


class CrisisCheckMiddleware(AgentMiddleware[CrisisCheckState]):
    """Detect crisis language and activate the fast-path."""

    state_schema = CrisisCheckState

    @override
    def before_agent(self, state: CrisisCheckState, runtime: Runtime) -> dict | None:
        messages = state.get("messages", [])
        if not messages:
            return None

        last_message = messages[-1]
        content = getattr(last_message, "content", "")
        if isinstance(content, list):
            content = " ".join(
                p.get("text", "") for p in content if isinstance(p, dict)
            )
        content_lower = str(content).lower()

        if any(signal in content_lower for signal in CRISIS_SIGNALS):
            return {
                "force_skill": "crisis_redirect",
                "skip_expensive": True,
            }

        return None
