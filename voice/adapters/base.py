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
    kind: Literal["text", "artifact", "error"]
    text: str = ""
    artifact: dict[str, Any] | None = None
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

    async def close(self) -> None:
        return None