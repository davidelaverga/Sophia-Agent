from __future__ import annotations

import base64
import json
import os
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from voice.realtime.capabilities import ProviderCapabilities
from voice.realtime.delivery import DeliveryIntent, DeliveryPace
from voice.realtime.events import ProviderEvent, ProviderEventType


OPENAI_REALTIME_PROVIDER_NAME = "openai-gpt-realtime-2"
DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2"
OPENAI_REALTIME_ADAPTER_FEATURE_FLAG = "SOPHIA_VOICE_OPENAI_REALTIME_ADAPTER_ENABLED"

OPENAI_REALTIME_CAPABILITIES = ProviderCapabilities(
    native_audio_input=True,
    native_audio_output=True,
    transcript_input=True,
    transcript_output=True,
    tool_calls=True,
    structured_tool_payloads=True,
    native_cancellation=True,
    session_updates=True,
    image_input=True,
    artifact_vision=True,
    speech_delivery_control="instructions",
    turn_authority="provider",
    provider_hints={
        "runtime": "openai_realtime_ga",
        "model": DEFAULT_OPENAI_REALTIME_MODEL,
        "default_turn_detection": "semantic_vad",
        "recommended_voices": ["marin", "cedar"],
        "public_event_boundary": "SophiaEventNormalizer",
    },
)

_PACE_VALUES: set[DeliveryPace] = {"slow", "gentle", "normal", "engaged", "energetic"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
_ARTIFACT_TOOL_NAMES = {"emit_artifact"}
_BUILDER_TOOL_NAMES = {
    "start_builder_task",
    "check_async_task",
    "update_async_task",
    "cancel_async_task",
    "list_async_tasks",
}

OpenAIRealtimeSender = Callable[[dict[str, Any]], Awaitable[None]]
RawOpenAIRealtimeEvents = AsyncIterable[Mapping[str, Any]] | Iterable[Mapping[str, Any]]


class OpenAIRealtimeAdapterDisabledError(RuntimeError):
    """Raised when code tries to construct the inactive adapter without its flag."""


@dataclass
class OpenAIToolCallState:
    call_id: str
    name: str | None = None
    item_id: str | None = None
    arguments: str = ""
    emitted_request: bool = False


@dataclass
class OpenAIRealtimeEventMapper:
    """Translate OpenAI Realtime GA server events into ProviderEvent values.

    This mapper is intentionally stateful: OpenAI may stream function-call
    arguments, audio transcript deltas, and final response summaries across
    separate events. The mapper stitches only provider-internal state and still
    stops at ProviderEvent, leaving public sophia.* envelopes to the normalizer.
    """

    provider_name: str = OPENAI_REALTIME_PROVIDER_NAME
    session_id: str | None = None
    _sequence: int = 0
    _active_response_id: str | None = None
    _audio_started_response_ids: set[str] = field(default_factory=set)
    _audio_ended_response_ids: set[str] = field(default_factory=set)
    _assistant_text_source_by_response: dict[str, str] = field(default_factory=dict)
    _assistant_final_response_ids: set[str] = field(default_factory=set)
    _tool_calls_by_call_id: dict[str, OpenAIToolCallState] = field(default_factory=dict)
    _tool_calls_by_item_id: dict[str, OpenAIToolCallState] = field(default_factory=dict)

    def map_event(self, raw_event: Mapping[str, Any]) -> list[ProviderEvent]:
        raw = dict(raw_event)
        event_name = _string_value(raw.get("type"))
        if event_name is None:
            return [
                self._event(
                    ProviderEventType.PROVIDER_ERROR,
                    {
                        "stage": "openai-realtime",
                        "message": "OpenAI Realtime event omitted a string type.",
                        "recoverable": True,
                    },
                    raw=raw,
                )
            ]

        if event_name in {"session.created", "session.updated"}:
            self._capture_session_id(raw)
            return []

        if event_name in {
            "input_audio_buffer.speech_started",
            "input_audio_buffer.speech_stopped",
            "input_audio_buffer.committed",
            "conversation.item.created",
        }:
            return self._map_non_response_lifecycle_event(event_name, raw)

        if event_name == "conversation.item.input_audio_transcription.delta":
            return self._map_user_transcription_delta(raw)

        if event_name == "conversation.item.input_audio_transcription.completed":
            return self._map_user_transcription_completed(raw)

        if event_name == "conversation.item.input_audio_transcription.failed":
            return self._map_provider_error(
                raw,
                stage="openai-input-audio-transcription",
                fallback_message="OpenAI input audio transcription failed.",
            )

        if event_name == "response.created":
            return self._map_response_created(raw)

        if event_name in {"response.output_audio.delta", "response.audio.delta"}:
            return self._map_audio_delta(raw)

        if event_name in {"response.output_audio.done", "response.audio.done"}:
            return self._map_audio_done(raw)

        if event_name in {
            "response.output_text.delta",
            "response.output_audio_transcript.delta",
            "response.audio_transcript.delta",
        }:
            return self._map_assistant_text_delta(event_name, raw)

        if event_name in {
            "response.output_text.done",
            "response.output_audio_transcript.done",
            "response.audio_transcript.done",
        }:
            return self._map_assistant_text_done(event_name, raw)

        if event_name in {
            "response.output_item.added",
            "response.output_item.done",
            "response.content_part.added",
            "response.content_part.done",
        }:
            return self._map_output_item_event(raw)

        if event_name in {
            "response.function_call_arguments.delta",
            "response.mcp_call_arguments.delta",
        }:
            return self._map_tool_call_arguments_delta(raw)

        if event_name in {
            "response.function_call_arguments.done",
            "response.mcp_call_arguments.done",
        }:
            return self._map_tool_call_arguments_done(raw)

        if event_name == "response.done":
            return self._map_response_done(raw)

        if event_name in {"response.cancelled", "response.canceled"}:
            return self._map_response_cancelled(raw)

        if event_name == "error":
            return self._map_provider_error(
                raw,
                stage="openai-realtime",
                fallback_message="OpenAI Realtime reported an error.",
            )

        return []

    def _map_non_response_lifecycle_event(
        self,
        event_name: str,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        if event_name == "conversation.item.created":
            item = _record_value(raw.get("item"))
            if item is None:
                return []
            if _string_value(item.get("type")) == "function_call_output":
                return self._map_tool_result_item(item, raw)

            user_text = _extract_user_text(item)
            if not user_text:
                return []

            turn_id = _string_value(item.get("id")) or _string_value(raw.get("event_id")) or str(uuid4())
            return [
                self._event(
                    ProviderEventType.USER_TRANSCRIPT_FINAL,
                    {
                        "text": user_text,
                        "utterance_id": turn_id,
                        "provider_event_name": event_name,
                    },
                    turn_id=turn_id,
                    raw=raw,
                )
            ]

        return []

    def _map_user_transcription_delta(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        delta = _string_value(raw.get("delta"))
        if not delta:
            return []
        turn_id = self._turn_id_from_raw(raw)
        return [
            self._event(
                ProviderEventType.USER_TRANSCRIPT_PARTIAL,
                {
                    "text": delta,
                    "utterance_id": turn_id,
                    "provider_event_name": "conversation.item.input_audio_transcription.delta",
                },
                turn_id=turn_id,
                raw=raw,
            )
        ]

    def _map_user_transcription_completed(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        transcript = _string_value(raw.get("transcript")) or _string_value(raw.get("text"))
        if not transcript:
            return []
        turn_id = self._turn_id_from_raw(raw)
        return [
            self._event(
                ProviderEventType.USER_TRANSCRIPT_FINAL,
                {
                    "text": transcript,
                    "utterance_id": turn_id,
                    "provider_event_name": "conversation.item.input_audio_transcription.completed",
                },
                turn_id=turn_id,
                raw=raw,
            )
        ]

    def _map_response_created(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        response_id = self._response_id_from_raw(raw) or f"openai-response-{uuid4()}"
        self._active_response_id = response_id
        response = _record_value(raw.get("response")) or {}
        return [
            self._event(
                ProviderEventType.RESPONSE_STARTED,
                {
                    "provider_event_name": "response.created",
                    "status": _string_value(response.get("status")) or "in_progress",
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _map_audio_delta(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        response_id = self._response_id_from_raw(raw) or self._active_response_id or f"openai-response-{uuid4()}"
        self._active_response_id = response_id
        if response_id in self._audio_started_response_ids:
            return []
        self._audio_started_response_ids.add(response_id)
        return [
            self._event(
                ProviderEventType.ASSISTANT_AUDIO_STARTED,
                {
                    "provider_event_name": _string_value(raw.get("type")) or "response.output_audio.delta",
                    "item_id": _string_value(raw.get("item_id")),
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _map_audio_done(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        response_id = self._response_id_from_raw(raw) or self._active_response_id
        if response_id is None or response_id in self._audio_ended_response_ids:
            return []
        self._audio_ended_response_ids.add(response_id)
        return [
            self._event(
                ProviderEventType.ASSISTANT_AUDIO_ENDED,
                {
                    "provider_event_name": _string_value(raw.get("type")) or "response.output_audio.done",
                    "item_id": _string_value(raw.get("item_id")),
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _map_assistant_text_delta(
        self,
        event_name: str,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        delta = _string_value(raw.get("delta"))
        if not delta:
            return []
        response_id = self._response_id_from_raw(raw) or self._active_response_id or f"openai-response-{uuid4()}"
        self._active_response_id = response_id
        source = _assistant_text_source(event_name)
        if not self._accept_assistant_text_source(response_id, source):
            return []
        return [
            self._event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": delta,
                    "is_delta": True,
                    "source": source,
                    "provider_event_name": event_name,
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _map_assistant_text_done(
        self,
        event_name: str,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        response_id = self._response_id_from_raw(raw) or self._active_response_id
        if response_id is None or response_id in self._assistant_final_response_ids:
            return []
        source = _assistant_text_source(event_name)
        if not self._accept_assistant_text_source(response_id, source):
            return []
        self._assistant_final_response_ids.add(response_id)
        text = _string_value(raw.get("text")) or _string_value(raw.get("transcript"))
        payload: dict[str, Any] = {
            "source": source,
            "provider_event_name": event_name,
        }
        if text is not None:
            payload["text"] = text
        return [
            self._event(
                ProviderEventType.ASSISTANT_TEXT_FINAL,
                payload,
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _accept_assistant_text_source(self, response_id: str, source: str) -> bool:
        selected_source = self._assistant_text_source_by_response.get(response_id)
        if selected_source is None:
            self._assistant_text_source_by_response[response_id] = source
            return True
        return selected_source == source

    def _map_output_item_event(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        item = _record_value(raw.get("item")) or _record_value(raw.get("part"))
        if item is None:
            return []
        if _string_value(item.get("type")) in {"function_call", "mcp_call"}:
            self._remember_tool_call_item(item)
            if _string_value(raw.get("type")) == "response.output_item.done":
                return self._map_tool_call_item(item, raw)
        return []

    def _map_tool_call_arguments_delta(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        tool_call = self._tool_call_state_from_raw(raw)
        delta = _string_value(raw.get("delta"))
        if delta:
            tool_call.arguments += delta
        return []

    def _map_tool_call_arguments_done(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        tool_call = self._tool_call_state_from_raw(raw)
        arguments = _string_value(raw.get("arguments"))
        if arguments is not None:
            tool_call.arguments = arguments
        return self._tool_call_requested_events(tool_call, raw)

    def _map_response_done(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        response = _record_value(raw.get("response")) or {}
        response_id = self._response_id_from_raw(raw) or self._active_response_id or _string_value(response.get("id"))
        events: list[ProviderEvent] = []

        for item in _sequence_value(response.get("output")):
            if not isinstance(item, Mapping):
                continue
            item_payload = dict(item)
            item_type = _string_value(item_payload.get("type"))
            if item_type in {"function_call", "mcp_call"}:
                events.extend(self._map_tool_call_item(item_payload, raw))
                continue
            if item_type == "message":
                events.extend(self._map_response_done_message_item(item_payload, raw, response_id))

        status = _string_value(response.get("status")) or _string_value(raw.get("status")) or "completed"
        if status == "completed":
            events.append(
                self._event(
                    ProviderEventType.RESPONSE_ENDED,
                    {"provider_event_name": "response.done", "status": status},
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )
        elif status in {"cancelled", "canceled"}:
            events.append(self._response_cancelled_event(raw, response_id=response_id, status=status))
        elif status in {"failed", "incomplete"}:
            events.extend(
                self._map_provider_error(
                    raw,
                    stage="openai-realtime-response",
                    fallback_message=f"OpenAI Realtime response ended with status {status}.",
                    response_id=response_id,
                    recoverable=status == "incomplete",
                )
            )

        return events

    def _map_response_done_message_item(
        self,
        item: Mapping[str, Any],
        raw: Mapping[str, Any],
        response_id: str | None,
    ) -> list[ProviderEvent]:
        if response_id is None or response_id in self._assistant_final_response_ids:
            return []
        final_text = _extract_assistant_text(item)
        if not final_text:
            return []
        self._assistant_final_response_ids.add(response_id)
        return [
            self._event(
                ProviderEventType.ASSISTANT_TEXT_FINAL,
                {
                    "text": final_text,
                    "source": "response.done.message",
                    "provider_event_name": "response.done",
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _map_response_cancelled(self, raw: Mapping[str, Any]) -> list[ProviderEvent]:
        return [self._response_cancelled_event(raw)]

    def _response_cancelled_event(
        self,
        raw: Mapping[str, Any],
        *,
        response_id: str | None = None,
        status: str = "cancelled",
    ) -> ProviderEvent:
        resolved_response_id = response_id or self._response_id_from_raw(raw) or self._active_response_id
        return self._event(
            ProviderEventType.RESPONSE_CANCELLED,
            {
                "provider_event_name": _string_value(raw.get("type")) or "response.done",
                "status": status,
                "reason": _response_cancel_reason(raw),
            },
            response_id=resolved_response_id,
            turn_id=resolved_response_id,
            raw=raw,
        )

    def _map_provider_error(
        self,
        raw: Mapping[str, Any],
        *,
        stage: str,
        fallback_message: str,
        response_id: str | None = None,
        recoverable: bool = True,
    ) -> list[ProviderEvent]:
        error = _record_value(raw.get("error")) or _record_value(raw.get("response", {})) or {}
        resolved_response_id = response_id or self._response_id_from_raw(raw) or self._active_response_id
        return [
            self._event(
                ProviderEventType.PROVIDER_ERROR,
                {
                    "stage": stage,
                    "message": _string_value(error.get("message")) or _string_value(raw.get("message")) or fallback_message,
                    "recoverable": recoverable,
                    "provider_event_name": _string_value(raw.get("type")),
                    "code": _string_value(error.get("code")),
                },
                response_id=resolved_response_id,
                turn_id=resolved_response_id,
                raw=raw,
            )
        ]

    def _map_tool_call_item(
        self,
        item: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        tool_call = self._remember_tool_call_item(item)
        arguments = _string_value(item.get("arguments"))
        if arguments is not None:
            tool_call.arguments = arguments
        return self._tool_call_requested_events(tool_call, raw)

    def _map_tool_result_item(
        self,
        item: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        call_id = _string_value(item.get("call_id")) or _string_value(item.get("id")) or str(uuid4())
        tool_call = self._tool_calls_by_call_id.get(call_id)
        output = _json_object_value(item.get("output"))
        events = [
            self._event(
                ProviderEventType.TOOL_RESULT_RECEIVED,
                {
                    "call_id": call_id,
                    "name": tool_call.name if tool_call is not None else None,
                    "output": output if output is not None else item.get("output"),
                    "provider_event_name": _string_value(raw.get("type")),
                },
                response_id=self._response_id_from_raw(raw) or self._active_response_id,
                raw=raw,
            )
        ]
        if output is not None and _looks_like_builder_task_payload(output):
            events.append(
                self._event(
                    ProviderEventType.BUILDER_TASK_PAYLOAD,
                    {
                        "builder_task": _builder_task_payload(output),
                        "call_id": call_id,
                        "provider_event_name": _string_value(raw.get("type")),
                    },
                    response_id=self._response_id_from_raw(raw) or self._active_response_id,
                    raw=raw,
                )
            )
        return events

    def _tool_call_requested_events(
        self,
        tool_call: OpenAIToolCallState,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        if tool_call.emitted_request:
            return []
        tool_call.emitted_request = True

        arguments = _json_object_value(tool_call.arguments) or {}
        response_id = self._response_id_from_raw(raw) or self._active_response_id
        data = {
            "call_id": tool_call.call_id,
            "item_id": tool_call.item_id,
            "name": tool_call.name,
            "arguments": arguments,
            "provider_event_name": _string_value(raw.get("type")),
        }
        events = [
            self._event(
                ProviderEventType.TOOL_CALL_REQUESTED,
                data,
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

        if tool_call.name in _ARTIFACT_TOOL_NAMES:
            artifact = _artifact_from_tool_arguments(arguments)
            events.append(
                self._event(
                    ProviderEventType.ARTIFACT_PAYLOAD,
                    {
                        "artifact": artifact,
                        "call_id": tool_call.call_id,
                        "provider_event_name": _string_value(raw.get("type")),
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    delivery_intent=_delivery_intent_from_artifact(artifact),
                    raw=raw,
                )
            )
        elif tool_call.name in _BUILDER_TOOL_NAMES:
            events.append(
                self._event(
                    ProviderEventType.BUILDER_TASK_CANDIDATE,
                    {
                        "builder_task": arguments,
                        "call_id": tool_call.call_id,
                        "name": tool_call.name,
                        "provider_event_name": _string_value(raw.get("type")),
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )

        return events

    def _tool_call_state_from_raw(self, raw: Mapping[str, Any]) -> OpenAIToolCallState:
        call_id = _string_value(raw.get("call_id")) or _string_value(raw.get("item_id")) or str(uuid4())
        item_id = _string_value(raw.get("item_id"))
        tool_call = self._tool_calls_by_call_id.get(call_id)
        if tool_call is None:
            tool_call = OpenAIToolCallState(call_id=call_id, item_id=item_id)
            self._tool_calls_by_call_id[call_id] = tool_call
        if item_id:
            tool_call.item_id = item_id
            self._tool_calls_by_item_id[item_id] = tool_call
        name = _string_value(raw.get("name"))
        if name:
            tool_call.name = name
        return tool_call

    def _remember_tool_call_item(self, item: Mapping[str, Any]) -> OpenAIToolCallState:
        call_id = _string_value(item.get("call_id")) or _string_value(item.get("id")) or str(uuid4())
        item_id = _string_value(item.get("id"))
        tool_call = self._tool_calls_by_call_id.get(call_id)
        if tool_call is None:
            tool_call = OpenAIToolCallState(call_id=call_id, item_id=item_id)
            self._tool_calls_by_call_id[call_id] = tool_call
        name = _string_value(item.get("name"))
        if name:
            tool_call.name = name
        if item_id:
            tool_call.item_id = item_id
            self._tool_calls_by_item_id[item_id] = tool_call
        return tool_call

    def _capture_session_id(self, raw: Mapping[str, Any]) -> None:
        session = _record_value(raw.get("session"))
        session_id = _string_value(session.get("id")) if session is not None else None
        if session_id:
            self.session_id = session_id

    def _response_id_from_raw(self, raw: Mapping[str, Any]) -> str | None:
        response_id = _string_value(raw.get("response_id"))
        if response_id:
            return response_id
        response = _record_value(raw.get("response"))
        if response is not None:
            return _string_value(response.get("id"))
        return None

    def _turn_id_from_raw(self, raw: Mapping[str, Any]) -> str:
        return _string_value(raw.get("item_id")) or _string_value(raw.get("event_id")) or str(uuid4())

    def _event(
        self,
        event_type: ProviderEventType,
        data: Mapping[str, Any] | None = None,
        *,
        response_id: str | None = None,
        turn_id: str | None = None,
        raw: Any = None,
        delivery_intent: DeliveryIntent | None = None,
    ) -> ProviderEvent:
        self._sequence += 1
        return ProviderEvent(
            event_type,
            dict(data or {}),
            provider=self.provider_name,
            session_id=self.session_id,
            response_id=response_id,
            turn_id=turn_id,
            sequence=self._sequence,
            delivery_intent=delivery_intent,
            raw=raw,
        )


class OpenAIRealtimeProviderSession:
    """Feature-flagged OpenAI Realtime ProviderSession adapter.

    The class owns OpenAI GA client/server event translation but deliberately
    does not open a socket or replace the legacy cascade. A later routing phase
    can inject a real WebSocket/WebRTC transport through sender/raw_events.
    """

    def __init__(
        self,
        raw_events: RawOpenAIRealtimeEvents | None = None,
        *,
        sender: OpenAIRealtimeSender | None = None,
        session_id: str | None = None,
        model: str = DEFAULT_OPENAI_REALTIME_MODEL,
        feature_enabled: bool | None = None,
    ) -> None:
        enabled = is_openai_realtime_adapter_enabled() if feature_enabled is None else feature_enabled
        if not enabled:
            raise OpenAIRealtimeAdapterDisabledError(
                f"OpenAI Realtime adapter is disabled. Set {OPENAI_REALTIME_ADAPTER_FEATURE_FLAG}=true to construct it."
            )

        self._raw_events = raw_events
        self._sender = sender
        self._mapper = OpenAIRealtimeEventMapper(session_id=session_id)
        self._config: dict[str, object] = {"model": model}
        self._closed = False
        self.sent_events: list[dict[str, Any]] = []

    @property
    def provider_name(self) -> str:
        return OPENAI_REALTIME_PROVIDER_NAME

    @property
    def capabilities(self) -> ProviderCapabilities:
        return OPENAI_REALTIME_CAPABILITIES

    async def configure(self, config: dict[str, object]) -> None:
        self._config.update(config)
        await self._send_client_event({"type": "session.update", "session": dict(config)})

    async def send_audio(self, chunk: bytes) -> None:
        if not chunk:
            return
        encoded_audio = base64.b64encode(chunk).decode("ascii")
        await self._send_client_event(
            {"type": "input_audio_buffer.append", "audio": encoded_audio}
        )

    async def send_text(self, text: str) -> None:
        await self._send_client_event(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            }
        )
        await self._send_client_event({"type": "response.create"})

    async def send_tool_result(
        self,
        tool_call_id: str,
        result: dict[str, object],
    ) -> None:
        await self._send_client_event(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": tool_call_id,
                    "output": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                },
            }
        )
        await self._send_client_event({"type": "response.create"})

    async def cancel_response(self, reason: str | None = None) -> None:
        cancel_event: dict[str, Any] = {"type": "response.cancel"}
        if reason:
            cancel_event["metadata"] = {"reason": reason}
        await self._send_client_event(cancel_event)

    async def events(self) -> AsyncIterator[ProviderEvent]:
        async for raw_event in self._raw_event_stream():
            for provider_event in self._mapper.map_event(raw_event):
                yield provider_event

    async def close(self) -> None:
        self._closed = True
        raw_events_close = getattr(self._raw_events, "aclose", None)
        if callable(raw_events_close):
            await raw_events_close()

    async def _send_client_event(self, event: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("Cannot send OpenAI Realtime events after session close.")
        event_payload = dict(event)
        self.sent_events.append(event_payload)
        if self._sender is not None:
            await self._sender(event_payload)

    async def _raw_event_stream(self) -> AsyncIterator[Mapping[str, Any]]:
        if self._raw_events is None:
            return

        if isinstance(self._raw_events, AsyncIterable):
            async for raw_event in self._raw_events:
                if not self._closed:
                    yield _raw_event_payload(raw_event)
            return

        for raw_event in self._raw_events:
            if self._closed:
                return
            yield _raw_event_payload(raw_event)


def _raw_event_payload(raw_event: Any) -> Mapping[str, Any]:
    event = getattr(raw_event, "event", None)
    if isinstance(event, Mapping):
        return event
    return raw_event


def build_openai_realtime_session_config(
    *,
    instructions: str | None = None,
    model: str = DEFAULT_OPENAI_REALTIME_MODEL,
    voice: str = "marin",
    output_modalities: Iterable[str] = ("audio",),
    tools: Iterable[Mapping[str, Any]] | None = None,
) -> dict[str, object]:
    session: dict[str, object] = {
        "type": "realtime",
        "model": model,
        "output_modalities": list(output_modalities),
        "audio": {
            "input": {"turn_detection": {"type": "semantic_vad"}},
            "output": {"voice": voice},
        },
    }
    if instructions:
        session["instructions"] = instructions
    if tools is not None:
        session["tools"] = [dict(tool) for tool in tools]
        session["tool_choice"] = "auto"
    return session


def is_openai_realtime_adapter_enabled(value: str | None = None) -> bool:
    raw_value = os.getenv(OPENAI_REALTIME_ADAPTER_FEATURE_FLAG) if value is None else value
    return raw_value is not None and raw_value.strip().lower() in _TRUE_VALUES


def _delivery_intent_from_artifact(artifact: Mapping[str, Any]) -> DeliveryIntent:
    pace = artifact.get("voice_speed")
    if pace not in _PACE_VALUES:
        pace = "normal"

    provider_hints = {
        key: value
        for key, value in {
            "openai_voice_emotion_primary": artifact.get("voice_emotion_primary"),
            "openai_voice_emotion_secondary": artifact.get("voice_emotion_secondary"),
            "openai_voice_speed": artifact.get("voice_speed"),
            "openai_active_tone_band": artifact.get("active_tone_band"),
            "openai_skill_loaded": artifact.get("skill_loaded"),
            "openai_ritual_phase": artifact.get("ritual_phase"),
        }.items()
        if value is not None
    }
    tone = _string_value(artifact.get("active_tone_band")) or "steady"
    return DeliveryIntent(
        tone=tone,
        pace=pace,
        provider_hints=provider_hints,
    ).clamped()


def _assistant_text_source(event_name: str) -> str:
    if "audio_transcript" in event_name or "audio_transcript" in event_name.replace(".", "_"):
        return "output_audio_transcript"
    return "output_text"


def _artifact_from_tool_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    artifact = _record_value(arguments.get("artifact"))
    if artifact is not None:
        return artifact
    return dict(arguments)


def _builder_task_payload(output: Mapping[str, Any]) -> dict[str, Any]:
    builder_task = _record_value(output.get("builder_task"))
    if builder_task is not None:
        return builder_task
    return dict(output)


def _looks_like_builder_task_payload(output: Mapping[str, Any]) -> bool:
    if isinstance(output.get("builder_task"), Mapping):
        return True
    return any(key in output for key in ("task_id", "thread_id", "status", "tasks"))


def _extract_user_text(item: Mapping[str, Any]) -> str | None:
    if _string_value(item.get("role")) != "user":
        return None
    text_parts: list[str] = []
    for content_part in _sequence_value(item.get("content")):
        if not isinstance(content_part, Mapping):
            continue
        part_text = _string_value(content_part.get("text")) or _string_value(content_part.get("transcript"))
        if part_text:
            text_parts.append(part_text)
    return "".join(text_parts) or None


def _extract_assistant_text(item: Mapping[str, Any]) -> str | None:
    text_parts: list[str] = []
    for content_part in _sequence_value(item.get("content")):
        if not isinstance(content_part, Mapping):
            continue
        part_text = _string_value(content_part.get("text")) or _string_value(content_part.get("transcript"))
        if part_text:
            text_parts.append(part_text)
    return "".join(text_parts) or None


def _response_cancel_reason(raw: Mapping[str, Any]) -> str | None:
    status_details = _record_value(raw.get("status_details"))
    if status_details is None:
        response = _record_value(raw.get("response")) or {}
        status_details = _record_value(response.get("status_details"))
    if status_details is None:
        return None
    return _string_value(status_details.get("reason")) or _string_value(status_details.get("type"))


def _json_object_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def _sequence_value(value: Any) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, tuple):
        return list(value)
    return []


def _record_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None