from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal


# Structural fields that must be present in the artifact. Missing structural
# fields indicate the backend never produced a coherent companion turn and the
# run should fail loudly. Calibration and voice-delivery fields are handled
# separately below so a partial tool_use call does not cut TTS mid-sentence.
REQUIRED_ARTIFACT_FIELDS = {
    "session_goal",
    "active_goal",
    "next_step",
    "takeaway",
    "tone_estimate",
    "tone_target",
    "active_tone_band",
    "skill_loaded",
    "ritual_phase",
    "voice_emotion_primary",
    "voice_emotion_secondary",
    "voice_speed",
}

# Defaults for voice-delivery fields. Claude occasionally omits these when
# emitting emit_artifact — the rest of the artifact is usually correct. Rather
# than failing the entire turn (which cuts off TTS mid-response and hides the
# transcript from the UI), we fill safe neutrals here. `_normalize_artifact`
# later re-derives these from the user/response family when signals warrant it,
# so these defaults are only used when the backend truly has no signal.
ARTIFACT_VOICE_DELIVERY_DEFAULTS: dict[str, str] = {
    "voice_emotion_primary": "content",
    "voice_emotion_secondary": "calm",
    "voice_speed": "normal",
}

# Defaults for calibration fields (tone, skill, ritual). Observed on
# 2026-04-21: Claude Haiku occasionally omits these on long-response turns
# even though the tool call itself succeeds. Failing the whole turn meant the
# UI showed the full transcript but Cartesia was cut mid-sentence because the
# adapter raised `BackendStageError` after ~6s of playback. These neutrals let
# `_normalize_artifact` re-derive calibration from the user/response signal;
# when that also has no signal, the frontend falls back to the previous
# artifact's emotion, which is correct per the CLAUDE.md handoff rule
# ("artifact updates the emotion for the *next* TTS call").
#
# `reflection` is intentionally absent from REQUIRED_ARTIFACT_FIELDS per
# CLAUDE.md: "reflection (nullable)". It does not need a default.
ARTIFACT_CALIBRATION_DEFAULTS: dict[str, Any] = {
    "tone_estimate": 2.5,
    "tone_target": 3.0,
    "active_tone_band": "engagement",
    "skill_loaded": "active_listening",
    "ritual_phase": None,
}


@dataclass(frozen=True)
class BackendRequest:
    text: str
    user_id: str
    platform: str
    ritual: str | None
    context_mode: str
    session_id: str | None = None
    thread_id: str | None = None


@dataclass(frozen=True)
class BackendEvent:
    kind: Literal["text", "artifact", "builder_task", "error"]
    text: str = ""
    artifact: dict[str, Any] | None = None
    builder_task: dict[str, Any] | None = None
    stage: str | None = None
    message: str | None = None
    recoverable: bool = True

    @classmethod
    def text_chunk(cls, text: str) -> "BackendEvent":
        return cls(kind="text", text=text)

    @classmethod
    def artifact_payload(cls, artifact: dict[str, Any]) -> "BackendEvent":
        return cls(kind="artifact", artifact=artifact)

    @classmethod
    def builder_task_payload(cls, builder_task: dict[str, Any]) -> "BackendEvent":
        return cls(kind="builder_task", builder_task=builder_task)

    @classmethod
    def error_event(
        cls,
        stage: str,
        message: str,
        *,
        recoverable: bool = True,
    ) -> "BackendEvent":
        return cls(
            kind="error",
            stage=stage,
            message=message,
            recoverable=recoverable,
        )


class BackendStageError(RuntimeError):
    def __init__(
        self,
        stage: str,
        message: str,
        *,
        recoverable: bool = True,
        original: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.recoverable = recoverable
        self.original = original


class BackendAdapter(ABC):
    mode: str

    @abstractmethod
    async def probe(self) -> None:
        """Fail fast when the selected backend is not available."""

    @abstractmethod
    async def stream_events(
        self,
        request: BackendRequest,
    ) -> AsyncIterator[BackendEvent]:
        """Yield normalized backend events for one assistant turn."""

    async def warmup(self, request: BackendRequest) -> None:
        """Optionally prewarm backend request paths for an upcoming turn."""
        return None

    async def close(self) -> None:
        return None