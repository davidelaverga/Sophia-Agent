"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).
"""

import logging
import time
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


class BuilderArtifactState(AgentState):
    messages: NotRequired[list]
    builder_result: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent."""

    state_schema = BuilderArtifactState

    @staticmethod
    def _tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
        names: list[str] = []
        for call in tool_calls:
            name = call.get("name")
            if isinstance(name, str) and name:
                names.append(name)
        return names

    @staticmethod
    def _append_turn_summary(state: BuilderArtifactState, summary: dict[str, Any]) -> list[dict]:
        history = list(state.get("builder_tool_turn_summaries", []) or [])
        history.append(summary)
        return history[-12:]

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
                tool_names = self._tool_names(tool_calls)
                for tc in tool_calls:
                    if tc.get("name") == "emit_builder_artifact":
                        args = tc.get("args", {})
                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                            },
                        )
                        log_middleware(
                            "BuilderArtifact",
                            f"builder artifact captured: type={args.get('artifact_type')}, "
                            f"confidence={args.get('confidence')}",
                            _t0,
                        )
                        return {
                            "builder_result": args,
                            "builder_non_artifact_turns": 0,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                        }

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"
                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact: turn={non_artifact_turns}, tools={joined_names}",
                    _t0,
                )
                return {
                    "builder_non_artifact_turns": non_artifact_turns,
                    "builder_last_tool_names": tool_names,
                    "builder_tool_turn_summaries": history,
                }

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
            history = self._append_turn_summary(
                state,
                {
                    "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                    "tool_names": [],
                    "has_emit_builder_artifact": False,
                    "ended_with_plain_text": True,
                },
            )
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
