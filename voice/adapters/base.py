from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal


REQUIRED_ARTIFACT_FIELDS = {
    "session_goal",
    "active_goal",
    "next_step",
    "takeaway",
    "reflection",
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