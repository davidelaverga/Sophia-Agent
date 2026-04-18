"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).
"""

import logging
import time
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


class BuilderArtifactState(AgentState):
    messages: NotRequired[list]
    builder_result: NotRequired[dict | None]


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent."""

    state_schema = BuilderArtifactState

    @override
    def after_model(self, state: BuilderArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_builder_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()

        # Don't overwrite a previously captured result
        if state.get("builder_result") is not None:
            log_middleware("BuilderArtifact", "already captured, skipping", _t0)
            return None

        messages = state.get("messages", [])

        # Scan messages in reverse for an AI message with tool_calls
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue

            tool_calls = getattr(msg, "tool_calls", [])

            # AI message has tool calls -- look for emit_builder_artifact
            if tool_calls:
                tool_names = [
                    tc.get("name")
                    for tc in tool_calls
                    if isinstance(tc, dict) and isinstance(tc.get("name"), str)
                ]
                for tc in tool_calls:
                    if tc.get("name") == "emit_builder_artifact":
                        args = tc.get("args", {})
                        log_middleware(
                            "BuilderArtifact",
                            f"builder artifact captured: type={args.get('artifact_type')}, "
                            f"confidence={args.get('confidence')}",
                            _t0,
                        )
                        return {"builder_result": args}

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                tool_summary = ", ".join(tool_names[:4]) if tool_names else "unknown"
                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact (loop continues; tools={tool_summary})",
                    _t0,
                )
                return None

            # AI message with NO tool calls -- agent ending with plain text, create fallback
            fallback = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task completed",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": "The build task was completed.",
                "companion_tone_hint": "Neutral \u2014 no builder context available.",
                "user_next_action": None,
                "confidence": 0.3,
            }
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            return {"builder_result": fallback}

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
