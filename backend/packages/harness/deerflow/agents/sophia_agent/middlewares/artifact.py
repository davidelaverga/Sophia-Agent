"""Artifact middleware.

Before-phase: injects artifact_instructions.md and conditionally injects
the previous artifact.
After-model: captures emit_artifact tool call output and stores in state.
"""

import json
import logging
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

TONE_DELTA_THRESHOLD = 0.3


class ArtifactState(AgentState):
    skip_expensive: NotRequired[bool]
    current_artifact: NotRequired[dict | None]
    previous_artifact: NotRequired[dict | None]
    system_prompt_blocks: NotRequired[list[str]]


class ArtifactMiddleware(AgentMiddleware[ArtifactState]):
    """Manage artifact instructions and emit_artifact tool call capture."""

    state_schema = ArtifactState

    def __init__(self, artifact_instructions_path: Path):
        super().__init__()
        if not artifact_instructions_path.exists():
            raise FileNotFoundError(f"Artifact instructions not found: {artifact_instructions_path}")
        self._instructions = artifact_instructions_path.read_text(encoding="utf-8")

    @override
    def before_agent(self, state: ArtifactState, runtime: Runtime) -> dict | None:
        if state.get("skip_expensive", False):
            return None

        blocks = [self._instructions]

        # Conditionally inject previous artifact
        prev = state.get("previous_artifact")
        if prev:
            tone_estimate = prev.get("tone_estimate", 2.5)
            tone_target = prev.get("tone_target", tone_estimate)
            tone_delta = abs(tone_target - tone_estimate)

            if tone_delta > TONE_DELTA_THRESHOLD or prev.get("skill_loaded") in (
                "vulnerability_holding", "challenging_growth", "identity_fluidity_support",
            ):
                blocks.append(
                    "<previous_artifact>\n"
                    + json.dumps(prev, indent=2)
                    + "\n</previous_artifact>"
                )

        existing = list(state.get("system_prompt_blocks", []))
        existing.extend(blocks)
        return {"system_prompt_blocks": existing}

    @override
    def after_model(self, state: ArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_artifact tool call result from latest messages."""
        messages = state.get("messages", [])

        artifact_data = None
        for msg in reversed(messages):
            if getattr(msg, "type", None) == "ai":
                tool_calls = getattr(msg, "tool_calls", [])
                for tc in (tool_calls or []):
                    if tc.get("name") == "emit_artifact":
                        artifact_data = tc.get("args", {})
                        break
                if artifact_data:
                    break

        if artifact_data:
            return {
                "previous_artifact": state.get("current_artifact"),
                "current_artifact": artifact_data,
            }

        return None
