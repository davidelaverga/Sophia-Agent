"""emit_artifact — REQUIRED on every companion turn via tool_use.

13 required fields. Carries TTS emotion, session continuity, and
self-improvement metadata. The user never sees this output.
Anthropic guarantees valid JSON on tool calls — never use text parsing.
"""

from __future__ import annotations

from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

TONE_BANDS = ["shutdown", "grief_fear", "anger_antagonism", "engagement", "enthusiasm"]
SKILLS = [
    "active_listening",
    "vulnerability_holding",
    "crisis_redirect",
    "trust_building",
    "boundary_holding",
    "challenging_growth",
    "identity_fluidity_support",
    "celebrating_breakthrough",
]
VOICE_SPEEDS = ["slow", "gentle", "normal", "engaged", "energetic"]


class ArtifactInput(BaseModel):
    """Schema for the emit_artifact tool call."""

    session_goal: str = Field(description="What this session is about. Set on turn 1, stable after.")
    active_goal: str = Field(description="What YOU are doing for the user THIS turn.")
    next_step: str = Field(description="What should happen next turn.")
    takeaway: str = Field(description="One insight worth remembering from this exchange.")
    reflection: str | None = Field(description="A question for the user to sit with. Can be null.")
    tone_estimate: float = Field(ge=0.0, le=4.0, description="User's current tone (0-4).")
    tone_target: float = Field(ge=0.0, le=4.0, description="tone_estimate + 0.5, capped at 4.0.")
    active_tone_band: str = Field(description="One of: shutdown|grief_fear|anger_antagonism|engagement|enthusiasm")
    skill_loaded: str = Field(description="Active skill name.")
    ritual_phase: str = Field(description="Format: ritual_name.step_description or freeform.topic")
    voice_emotion_primary: str = Field(
        description="Cartesia emotion for TTS. See vocabulary in artifact_instructions.md"
    )
    voice_emotion_secondary: str = Field(description="Fallback emotion from primary set.")
    voice_speed: Literal["slow", "gentle", "normal", "engaged", "energetic"] = Field(
        description="TTS speed."
    )


@tool(args_schema=ArtifactInput)
def emit_artifact(**kwargs) -> str:
    """REQUIRED ON EVERY TURN. Call this tool with your internal state calibration.

    Your spoken response goes in the message content. This tool carries the
    metadata that drives voice emotion, session continuity, and self-improvement.
    The user never sees this output.
    """
    return "Artifact recorded."
