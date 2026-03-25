"""Sophia summarization middleware.

Adapts DeerFlow's SummarizationMiddleware with a custom summary prompt
that preserves emotional states and extracts emotional arc from artifacts.
"""

import json
import logging
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

# Thresholds from spec
TOKEN_THRESHOLD = 8000
MESSAGE_THRESHOLD = 40
KEEP_MESSAGES = 30

SUMMARY_PROMPT = """Extract the most important context from this conversation.
Preserve emotional states in the user's own words where possible.
Capture decisions made, commitments stated, unresolved tensions.
Return only the extracted context, no preamble."""


def _extract_emotional_arc(messages: list[Any]) -> str:
    """Extract emotional arc from emit_artifact tool calls in messages."""
    artifacts = []
    for msg in messages:
        if getattr(msg, "type", None) == "ai":
            for tc in getattr(msg, "tool_calls", []) or []:
                if tc.get("name") == "emit_artifact":
                    artifacts.append(tc.get("args", {}))

    if not artifacts:
        return ""

    first = artifacts[0]
    last = artifacts[-1]
    skills = list(dict.fromkeys(a.get("skill_loaded", "") for a in artifacts if a.get("skill_loaded")))

    return (
        f"\n[Emotional arc of summarized turns]\n"
        f"Tone: {first.get('active_tone_band', '?')} ({first.get('tone_estimate', '?')})"
        f" → {last.get('active_tone_band', '?')} ({last.get('tone_estimate', '?')})\n"
        f"Skills activated: {', '.join(skills)}\n"
    )


class SophiaSummarizationState(AgentState):
    turn_count: NotRequired[int]


class SophiaSummarizationMiddleware(AgentMiddleware[SophiaSummarizationState]):
    """Context summarization with emotional arc preservation.

    Note: Full summarization integration with DeerFlow's SummarizationMiddleware
    will be refined during integration testing. This implementation provides
    the emotional arc extraction and summary prompt customization.
    """

    state_schema = SophiaSummarizationState

    @override
    def after_model(self, state: SophiaSummarizationState, runtime: Runtime) -> dict | None:
        # Summarization is handled by DeerFlow's built-in SummarizationMiddleware
        # configured in config.yaml. This middleware exists to provide the
        # emotional arc extraction hook when needed.
        #
        # The actual summarization trigger is based on token/message count
        # thresholds configured in config.yaml. This middleware will be
        # enhanced during integration (Unit 14) to hook into the
        # summarization pipeline for emotional arc preservation.
        return None
