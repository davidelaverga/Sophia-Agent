from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any
from uuid import uuid4

from voice.realtime.delivery import DeliveryIntent


class ProviderEventType(StrEnum):
    USER_TRANSCRIPT_PARTIAL = "user_transcript_partial"
    USER_TRANSCRIPT_FINAL = "user_transcript_final"
    ASSISTANT_TEXT_DELTA = "assistant_text_delta"
    ASSISTANT_TEXT_FINAL = "assistant_text_final"
    RESPONSE_STARTED = "response_started"
    RESPONSE_ENDED = "response_ended"
    ASSISTANT_AUDIO_STARTED = "assistant_audio_started"
    ASSISTANT_AUDIO_ENDED = "assistant_audio_ended"
    TOOL_CALL_REQUESTED = "tool_call_requested"
    TOOL_RESULT_RECEIVED = "tool_result_received"
    ARTIFACT_CANDIDATE = "artifact_candidate"
    ARTIFACT_PAYLOAD = "artifact_payload"
    BUILDER_TASK_CANDIDATE = "builder_task_candidate"
    BUILDER_TASK_PAYLOAD = "builder_task_payload"
    RESPONSE_CANCELLED = "response_cancelled"
    RESPONSE_INTERRUPTED = "response_interrupted"
    PROVIDER_ERROR = "provider_error"
    PROVIDER_METRIC = "provider_metric"


@dataclass(frozen=True)
class ProviderEvent:
    """Normalized internal event emitted by realtime provider adapters."""

    type: ProviderEventType
    data: dict[str, Any] = field(default_factory=dict)
    provider: str | None = None
    session_id: str | None = None
    response_id: str | None = None
    turn_id: str | None = None
    sequence: int | None = None
    timestamp: float | None = None
    delivery_intent: DeliveryIntent | None = None
    raw: Any = None

    @classmethod
    def user_transcript_partial(cls, text: str, **data: Any) -> "ProviderEvent":
        return cls(
            ProviderEventType.USER_TRANSCRIPT_PARTIAL,
            {"text": text, **data},
        )

    @classmethod
    def user_transcript_final(
        cls,
        text: str,
        *,
        utterance_id: str | None = None,
        **data: Any,
    ) -> "ProviderEvent":
        return cls(
            ProviderEventType.USER_TRANSCRIPT_FINAL,
            {"text": text, "utterance_id": utterance_id or str(uuid4()), **data},
        )

    @classmethod
    def assistant_text_delta(
        cls,
        text: str,
        *,
        is_delta: bool = True,
        **data: Any,
    ) -> "ProviderEvent":
        return cls(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {"text": text, "is_delta": is_delta, **data},
        )

    @classmethod
    def assistant_text_final(cls, text: str | None = None, **data: Any) -> "ProviderEvent":
        payload: dict[str, Any] = dict(data)
        if text is not None:
            payload["text"] = text
        return cls(ProviderEventType.ASSISTANT_TEXT_FINAL, payload)

    @classmethod
    def artifact_payload(cls, artifact: dict[str, Any], **data: Any) -> "ProviderEvent":
        return cls(ProviderEventType.ARTIFACT_PAYLOAD, {"artifact": artifact, **data})

    @classmethod
    def builder_task_payload(cls, builder_task: dict[str, Any], **data: Any) -> "ProviderEvent":
        return cls(
            ProviderEventType.BUILDER_TASK_PAYLOAD,
            {"builder_task": builder_task, **data},
        )

    @classmethod
    def provider_error(
        cls,
        message: str,
        *,
        stage: str = "provider",
        recoverable: bool = True,
        **data: Any,
    ) -> "ProviderEvent":
        return cls(
            ProviderEventType.PROVIDER_ERROR,
            {
                "message": message,
                "stage": stage,
                "recoverable": recoverable,
                **data,
            },
        )


@dataclass(frozen=True)
class SophiaEvent:
    """Public browser-facing Sophia event envelope."""

    type: str
    data: dict[str, Any] = field(default_factory=dict)

    def as_payload(self) -> dict[str, Any]:
        return {"type": self.type, "data": dict(self.data)}