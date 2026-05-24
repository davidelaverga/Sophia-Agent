from __future__ import annotations

from collections import deque
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from voice.realtime.capabilities import ProviderCapabilities
from voice.realtime.delivery import DeliveryIntent, DeliveryPace
from voice.realtime.events import ProviderEvent, ProviderEventType


LEGACY_CASCADE_PROVIDER_NAME = "legacy-cascade"

LEGACY_CASCADE_CAPABILITIES = ProviderCapabilities(
    native_audio_input=False,
    native_audio_output=False,
    transcript_input=True,
    transcript_output=True,
    tool_calls=True,
    structured_tool_payloads=True,
    native_cancellation=False,
    session_updates=False,
    speech_delivery_control="hints",
    turn_authority="sophia",
    provider_hints={
        "runtime": "vision_agents_cascade",
        "stt": "deepgram",
        "backend": "deerflow_runs_stream",
        "tts": "cartesia",
    },
)

_PACE_VALUES: set[DeliveryPace] = {"slow", "gentle", "normal", "engaged", "energetic"}


@dataclass
class LegacyCascadeCompatibilityBridge:
    """Translate current cascade lifecycle markers into ProviderEvent values.

    This bridge is intentionally not wired into the live voice service. It is a
    compatibility adapter for tests, shadow instrumentation, and future runtime
    migration work. It stops at ProviderEvent and never emits public sophia.*
    envelopes directly.
    """

    provider_name: str = LEGACY_CASCADE_PROVIDER_NAME
    session_id: str | None = None
    user_id: str | None = None
    turn_id: str = field(default_factory=lambda: f"legacy-turn-{uuid4()}")
    response_id: str = field(default_factory=lambda: f"legacy-response-{uuid4()}")
    _sequence: int = 0
    _assistant_text: str = ""

    def reset_turn(
        self,
        *,
        turn_id: str | None = None,
        response_id: str | None = None,
    ) -> None:
        self.turn_id = turn_id or f"legacy-turn-{uuid4()}"
        self.response_id = response_id or f"legacy-response-{uuid4()}"
        self._assistant_text = ""

    def final_user_transcript(
        self,
        text: str,
        *,
        utterance_id: str | None = None,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(
            ProviderEventType.USER_TRANSCRIPT_FINAL,
            {
                "text": text,
                "utterance_id": utterance_id or str(uuid4()),
                **metadata,
            },
            raw=raw,
        )

    def agent_response_started(
        self,
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(ProviderEventType.RESPONSE_STARTED, metadata, raw=raw)

    def assistant_partial_text(
        self,
        text: str,
        *,
        is_delta: bool = True,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        if is_delta:
            self._assistant_text += text
        else:
            self._assistant_text = text

        return self._event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {"text": text, "is_delta": is_delta, **metadata},
            raw=raw,
        )

    def assistant_final_text(
        self,
        text: str | None = None,
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        final_text = self._assistant_text if text is None else text
        if text is not None:
            self._assistant_text = text

        payload = dict(metadata)
        if final_text:
            payload["text"] = final_text
        return self._event(ProviderEventType.ASSISTANT_TEXT_FINAL, payload, raw=raw)

    def artifact_payload(
        self,
        artifact: Mapping[str, Any],
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        artifact_payload = dict(artifact)
        return self._event(
            ProviderEventType.ARTIFACT_PAYLOAD,
            {"artifact": artifact_payload, **metadata},
            raw=raw,
            delivery_intent=_delivery_intent_from_artifact(artifact_payload),
        )

    def builder_task_payload(
        self,
        builder_task: Mapping[str, Any],
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(
            ProviderEventType.BUILDER_TASK_PAYLOAD,
            {"builder_task": dict(builder_task), **metadata},
            raw=raw,
        )

    def agent_response_ended(
        self,
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(ProviderEventType.RESPONSE_ENDED, metadata, raw=raw)

    def response_cancelled(
        self,
        reason: str = "cancelled",
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(
            ProviderEventType.RESPONSE_CANCELLED,
            {"legacy_reason": reason, **metadata},
            raw=raw,
        )

    def response_interrupted(
        self,
        reason: str = "interrupted",
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(
            ProviderEventType.RESPONSE_INTERRUPTED,
            {"legacy_reason": reason, **metadata},
            raw=raw,
        )

    def stage_error(
        self,
        stage: str,
        message: str,
        *,
        recoverable: bool = True,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        return self._event(
            ProviderEventType.PROVIDER_ERROR,
            {
                "stage": stage,
                "message": message,
                "recoverable": recoverable,
                **metadata,
            },
            raw=raw,
        )

    def turn_diagnostic(
        self,
        diagnostic: Mapping[str, Any] | Any,
        *,
        raw: Any = None,
        **metadata: Any,
    ) -> ProviderEvent:
        as_payload = getattr(diagnostic, "as_payload", None)
        if callable(as_payload):
            payload = as_payload()
        elif isinstance(diagnostic, Mapping):
            payload = dict(diagnostic)
        else:
            payload = {"diagnostic": diagnostic}

        return self._event(
            ProviderEventType.PROVIDER_METRIC,
            {**payload, **metadata},
            raw=raw or diagnostic,
        )

    def translate_backend_event(self, backend_event: Any) -> ProviderEvent:
        kind = getattr(backend_event, "kind", None)
        if kind == "text":
            return self.assistant_partial_text(
                _string_value(getattr(backend_event, "text", "")) or "",
                raw=backend_event,
            )
        if kind == "artifact":
            artifact = getattr(backend_event, "artifact", None)
            return self.artifact_payload(
                artifact if isinstance(artifact, Mapping) else {},
                raw=backend_event,
            )
        if kind == "builder_task":
            builder_task = getattr(backend_event, "builder_task", None)
            return self.builder_task_payload(
                builder_task if isinstance(builder_task, Mapping) else {},
                raw=backend_event,
            )
        if kind == "error":
            return self.stage_error(
                _string_value(getattr(backend_event, "stage", None)) or "backend-stream",
                _string_value(getattr(backend_event, "message", None))
                or "Legacy cascade backend event reported an error.",
                recoverable=getattr(backend_event, "recoverable", True) is not False,
                raw=backend_event,
            )

        return self.stage_error(
            "legacy-cascade",
            f"Unsupported legacy cascade event kind: {kind!r}",
            raw=backend_event,
        )

    def _event(
        self,
        event_type: ProviderEventType,
        data: Mapping[str, Any] | None = None,
        *,
        raw: Any = None,
        delivery_intent: DeliveryIntent | None = None,
    ) -> ProviderEvent:
        self._sequence += 1
        return ProviderEvent(
            event_type,
            dict(data or {}),
            provider=self.provider_name,
            session_id=self.session_id,
            response_id=self.response_id,
            turn_id=self.turn_id,
            sequence=self._sequence,
            delivery_intent=delivery_intent,
            raw=raw,
        )


class LegacyCascadeProviderSession:
    """Replayable RealtimeProviderSession for legacy cascade compatibility tests."""

    def __init__(
        self,
        events: list[ProviderEvent] | None = None,
        *,
        bridge: LegacyCascadeCompatibilityBridge | None = None,
    ) -> None:
        self.bridge = bridge or LegacyCascadeCompatibilityBridge()
        self._events: deque[ProviderEvent] = deque(events or [])
        self._config: dict[str, object] = {}
        self._closed = False

    @property
    def provider_name(self) -> str:
        return self.bridge.provider_name

    @property
    def capabilities(self) -> ProviderCapabilities:
        return LEGACY_CASCADE_CAPABILITIES

    async def configure(self, config: dict[str, object]) -> None:
        self._config.update(config)

    async def send_audio(self, chunk: bytes) -> None:
        if chunk:
            self.record(
                self.bridge.stage_error(
                    "legacy-cascade",
                    "Legacy cascade compatibility sessions are externally driven and do not accept audio chunks.",
                    recoverable=False,
                )
            )

    async def send_text(self, text: str) -> None:
        self.record(self.bridge.final_user_transcript(text))

    async def send_tool_result(
        self,
        tool_call_id: str,
        result: dict[str, object],
    ) -> None:
        self.record(
            self.bridge.turn_diagnostic(
                {
                    "tool_call_id": tool_call_id,
                    "tool_result_received": True,
                    "tool_result_keys": sorted(result),
                }
            )
        )

    async def cancel_response(self, reason: str | None = None) -> None:
        self.record(self.bridge.response_cancelled(reason or "cancelled"))

    def record(self, event: ProviderEvent) -> None:
        if self._closed:
            return
        self._events.append(event)

    def record_many(self, events: list[ProviderEvent]) -> None:
        for event in events:
            self.record(event)

    async def events(self) -> AsyncIterator[ProviderEvent]:
        while self._events and not self._closed:
            yield self._events.popleft()

    async def close(self) -> None:
        self._closed = True
        self._events.clear()


def _delivery_intent_from_artifact(artifact: Mapping[str, Any]) -> DeliveryIntent:
    pace = artifact.get("voice_speed")
    if pace not in _PACE_VALUES:
        pace = "normal"

    provider_hints = {
        key: value
        for key, value in {
            "legacy_voice_emotion_primary": artifact.get("voice_emotion_primary"),
            "legacy_voice_emotion_secondary": artifact.get("voice_emotion_secondary"),
            "legacy_voice_speed": artifact.get("voice_speed"),
            "legacy_active_tone_band": artifact.get("active_tone_band"),
            "legacy_skill_loaded": artifact.get("skill_loaded"),
            "legacy_ritual_phase": artifact.get("ritual_phase"),
        }.items()
        if value is not None
    }

    tone = _string_value(artifact.get("active_tone_band")) or "steady"
    return DeliveryIntent(
        tone=tone,
        pace=pace,
        provider_hints=provider_hints,
    ).clamped()


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None