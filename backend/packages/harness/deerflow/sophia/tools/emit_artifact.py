"""The emit_artifact tool — required on every companion turn.

Carries TTS emotion, session continuity data, and calibration metadata.
Delivered as a tool_use call (never text parsing) to guarantee valid JSON.
"""

from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field


class ArtifactInput(BaseModel):
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
    voice_emotion_primary: str = Field(description="Cartesia emotion for TTS.")
    voice_emotion_secondary: str = Field(description="Fallback emotion.")
    voice_speed: Literal["slow", "gentle", "normal", "engaged", "energetic"] = Field(
        description="TTS speed."
    )


@tool(args_schema=ArtifactInput, return_direct=True)
def emit_artifact(**kwargs) -> str:
    """REQUIRED ON EVERY TURN. Call this ONCE per turn alongside your spoken response.
    Your spoken response goes in the message content. This tool carries the
    metadata that drives voice emotion, session continuity, and self-improvement.
    The user never sees this output.
    IMPORTANT: Call this exactly once per turn. After calling, do NOT call any more tools.
    Your turn is complete after this tool call."""
    return "Artifact recorded."
