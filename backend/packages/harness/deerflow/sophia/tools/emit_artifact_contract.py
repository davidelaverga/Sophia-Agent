"""Dependency-safe contract for Sophia's ``emit_artifact`` tool.

The LangChain tool wrapper imports this module, and realtime voice dogfood
imports it to declare/validate the existing tool without pulling in LangChain.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

EMIT_ARTIFACT_TOOL_NAME = "emit_artifact"
EMIT_ARTIFACT_RESULT = "Artifact recorded."
EMIT_ARTIFACT_DESCRIPTION = (
    "REQUIRED ON EVERY TURN. Call this ONCE per turn alongside your spoken response. "
    "Your spoken response goes in the message content. This tool carries the metadata "
    "that drives voice emotion, session continuity, and self-improvement. The user "
    "never sees this output. IMPORTANT: Call this exactly once per turn. After calling, "
    "do NOT call any more tools. Your turn is complete after this tool call."
)


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

    @field_validator("reflection", mode="before")
    @classmethod
    def normalize_null_like_reflection(cls, value: Any) -> Any:
        if isinstance(value, str) and value.strip().lower() in {"", "null", "none", "undefined", "n/a"}:
            return None
        return value


def coerce_emit_artifact_args(args: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(args)
    nested_artifact = payload.get("artifact")
    if isinstance(nested_artifact, Mapping) and not looks_like_emit_artifact_payload(payload):
        return dict(nested_artifact)
    return payload


def validate_emit_artifact_args(args: Mapping[str, Any]) -> dict[str, Any]:
    return ArtifactInput.model_validate(coerce_emit_artifact_args(args)).model_dump()


def looks_like_emit_artifact_payload(payload: Mapping[str, Any]) -> bool:
    return "session_goal" in payload or "tone_estimate" in payload or "voice_speed" in payload


def record_emit_artifact(**_: Any) -> str:
    return EMIT_ARTIFACT_RESULT