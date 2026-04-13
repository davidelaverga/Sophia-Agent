"""Artifact middleware.

Before-phase: injects artifact_instructions.md and conditionally injects
the previous artifact.
After-model: captures emit_artifact tool call output and stores in state.
"""

import json
import logging
import time
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

TONE_DELTA_THRESHOLD = 0.3

_VOICE_ARTIFACT_INSTRUCTIONS = """<artifact_contract>
Every turn has two outputs:
- Spoken reply in normal assistant text.
- Exactly one emit_artifact tool call after the spoken reply. Never print JSON in the reply.

emit_artifact is REQUIRED on every turn with these 13 fields:
- session_goal: stable session-level aim unless the topic genuinely shifts.
- active_goal: what you are doing for the user right now.
- next_step: likely best next move for the following turn.
- takeaway: one concrete thing worth remembering.
- reflection: one later question, or null.
- tone_estimate: honest 0.0-4.0 read of where the user ends this turn.
- tone_target: min(tone_estimate + 0.5, 4.0).
- active_tone_band: shutdown | grief_fear | anger_antagonism | engagement | enthusiasm.
- skill_loaded: exact injected skill name, or active_listening if none is visible.
- ritual_phase: ritual.step or freeform.topic.
- voice_emotion_primary: choose the delivery intent, not the user's raw state.
- voice_emotion_secondary: close fallback emotion.
- voice_speed: slow | gentle | normal | engaged | energetic.

Voice defaults:
- shutdown or grief: calm or sympathetic, slow or gentle.
- reflective exploration: curious or contemplative, normal.
- clean challenge or stuck-loop work: determined, confident, or curious, engaged.
- good news, breakthrough, or celebrating_breakthrough: enthusiasm band with excited or proud, engaged or energetic.

First turn:
- Build session_goal from ritual + opening message + known context.

Later turns:
- Keep session_goal stable unless the session truly changes.
- Update active_goal, next_step, tone_estimate, and delivery based on this turn.

After the emit_artifact call, stop. Do not call more tools.
</artifact_contract>"""


class ArtifactState(AgentState):
    skip_expensive: NotRequired[bool]
    current_artifact: NotRequired[dict | None]
    previous_artifact: NotRequired[dict | None]
    system_prompt_blocks: NotRequired[list[str]]
    builder_result: NotRequired[dict | None]
    builder_task: NotRequired[dict | None]
    active_tone_band: NotRequired[str]
    platform: NotRequired[str]


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
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Artifact", "skipped (crisis)", _t0)
            return None

        platform = state.get("platform") or runtime.context.get("platform")
        instructions = _VOICE_ARTIFACT_INSTRUCTIONS if platform in ("voice", "ios_voice") else self._instructions
        blocks = [instructions]

        # --- Builder synthesis injection ---
        builder_result = state.get("builder_result")
        builder_task = state.get("builder_task") or {}
        if builder_result and builder_task.get("status") == "completed":
            synthesis_block = self._build_synthesis_prompt(builder_result, state)
            blocks.append(synthesis_block)
            # Mark as synthesized to prevent re-injection on subsequent turns
            log_middleware("Artifact", "builder synthesis injected", _t0)
            existing = list(state.get("system_prompt_blocks", []))
            existing.extend(blocks)
            builder_task_updated = {**builder_task, "status": "synthesized"}
            return {"system_prompt_blocks": existing, "builder_task": builder_task_updated}

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
        log_middleware("Artifact", f"instructions injected (platform={platform or 'default'})", _t0)
        return {"system_prompt_blocks": existing}

    @override
    def after_model(self, state: ArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()
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
            log_middleware("Artifact", f"artifact captured: tone={artifact_data.get('tone_estimate')}", _t0)
            return {
                "previous_artifact": state.get("current_artifact"),
                "current_artifact": artifact_data,
            }

        log_middleware("Artifact", "no artifact in response", _t0)
        return None

    # ------------------------------------------------------------------
    # Builder synthesis
    # ------------------------------------------------------------------

    _SYNTHESIS_INSTRUCTIONS = {
        "shutdown": (
            "The user is in a very low state. Keep presentation ultra-brief. "
            "Just tell them it's ready. No details unless they ask."
        ),
        "grief_fear": (
            "The user is carrying weight. Present as something taken care of. "
            "Warm and brief. One or two sentences, then offer the file."
        ),
        "anger_antagonism": (
            "The user was frustrated. Present as forward motion. Be direct. "
            "'Here's what I built. It does X.' State next action clearly."
        ),
        "engagement": (
            "The user has energy. Give more detail about what was built. "
            "Mention 1-2 key decisions. Frame next action as collaboration."
        ),
        "enthusiasm": (
            "The user is high energy. Match that energy. Present with confidence. "
            "Highlight any surprise element. Let them ride the momentum."
        ),
    }

    def _build_synthesis_prompt(self, builder: dict, state: dict) -> str:
        """Build the synthesis prompt for presenting builder results."""
        tone_band = state.get("active_tone_band", "engagement")
        instruction = self._SYNTHESIS_INSTRUCTIONS.get(
            tone_band, self._SYNTHESIS_INSTRUCTIONS["engagement"]
        )

        parts = ["<builder_completed>"]
        parts.append(f"WHAT WAS BUILT: {builder.get('companion_summary', 'Task completed.')}")
        parts.append(
            f"DELIVERABLE: {builder.get('artifact_title', 'Untitled')} "
            f"({builder.get('artifact_type', 'file')})"
        )

        decisions = builder.get("decisions_made", [])
        if decisions:
            parts.append(f"KEY DECISIONS: {'; '.join(decisions)}")

        tone_hint = builder.get("companion_tone_hint", "")
        if tone_hint:
            parts.append(f"BUILDER'S SUGGESTION: {tone_hint}")

        next_action = builder.get("user_next_action")
        if next_action:
            parts.append(f"USER'S NEXT STEP: {next_action}")

        parts.append(f"\nHOW TO PRESENT THIS:\n{instruction}")
        parts.append(
            "\nExpress this result naturally in your voice. Do not list "
            "decisions mechanically. The user should feel this was done "
            "WITH care, not BY a machine."
        )
        parts.append("</builder_completed>")

        return "\n".join(parts)
