from __future__ import annotations

import base64
import json
import os
import re
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from voice.realtime.capabilities import ProviderCapabilities
from voice.realtime.coreview import GEMINI_COREVIEW_ACTION_TOOL_NAMES
from voice.realtime.delivery import DeliveryIntent, DeliveryPace
from voice.realtime.events import ProviderEvent, ProviderEventType


GEMINI_LIVE_PROVIDER_NAME = "google-gemini-live"
DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"
DEFAULT_GEMINI_LIVE_VOICE_NAME = "Kore"
GEMINI_LIVE_VOICE_NAME_ENV = "SOPHIA_GEMINI_LIVE_VOICE_NAME"
GEMINI_LIVE_ADAPTER_FEATURE_FLAG = "SOPHIA_VOICE_GEMINI_LIVE_ADAPTER_ENABLED"
ALLOWED_GEMINI_LIVE_VOICE_NAMES = (
    "Zephyr",
    "Puck",
    "Charon",
    "Kore",
    "Fenrir",
    "Leda",
    "Orus",
    "Aoede",
    "Callirrhoe",
    "Autonoe",
    "Enceladus",
    "Iapetus",
    "Umbriel",
    "Algieba",
    "Despina",
    "Erinome",
    "Algenib",
    "Rasalgethi",
    "Laomedeia",
    "Achernar",
    "Alnilam",
    "Schedar",
    "Gacrux",
    "Pulcherrima",
    "Achird",
    "Zubenelgenubi",
    "Vindemiatrix",
    "Sadachbia",
    "Sadaltager",
    "Sulafat",
)
_GEMINI_LIVE_VOICE_NAMES_BY_CASEFOLD = {
    voice_name.casefold(): voice_name
    for voice_name in ALLOWED_GEMINI_LIVE_VOICE_NAMES
}

GEMINI_LIVE_CAPABILITIES = ProviderCapabilities(
    native_audio_input=True,
    native_audio_output=True,
    transcript_input=True,
    transcript_output=True,
    tool_calls=True,
    structured_tool_payloads=True,
    native_cancellation=True,
    session_updates=False,
    image_input=True,
    artifact_vision=True,
    speech_delivery_control="instructions",
    turn_authority="provider",
    provider_hints={
        "runtime": "gemini_live_preview",
        "model": DEFAULT_GEMINI_LIVE_MODEL,
        "protocol": "stateful_websocket_bidi_generate_content",
        "setup_handshake": "setup_then_setupComplete_before_inputs",
        "input_audio": "raw_16_bit_pcm_little_endian",
        "input_audio_default_rate_hz": 16000,
        "output_audio": "raw_16_bit_pcm_little_endian",
        "output_audio_rate_hz": 24000,
        "default_response_modalities": ["AUDIO"],
        "transcripts": "enable inputAudioTranscription and outputAudioTranscription in setup",
        "explicit_session_updates": "not_supported_while_connection_is_open",
        "explicit_cancel_message": "none_documented; interruption is driven by realtime input activity",
        "public_event_boundary": "SophiaEventNormalizer",
    },
)

_PACE_VALUES: set[DeliveryPace] = {"slow", "gentle", "normal", "engaged", "energetic"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
_ARTIFACT_TOOL_NAMES = {"emit_artifact"}
_NULL_LIKE_ARTIFACT_STRINGS = {"", "null", "none", "undefined", "n/a"}
_BUILDER_TOOL_NAMES = {
    "start_builder_task",
    "edit_builder_artifact",
    "check_async_task",
    "update_async_task",
    "cancel_async_task",
    "list_async_tasks",
}
_MEMORY_TOOL_NAMES = {"retrieve_memories"}
_REVIEW_TOOL_NAMES = {"read_artifact_text", *GEMINI_COREVIEW_ACTION_TOOL_NAMES}
_STRUCTURED_TOOL_NAMES = (
    _ARTIFACT_TOOL_NAMES | _BUILDER_TOOL_NAMES | _MEMORY_TOOL_NAMES | _REVIEW_TOOL_NAMES
)
_TOOL_SYNTAX_LEAK_RE = re.compile(
    r"^\s*(?:try\s*\{\s*)?(?:"
    + "|".join(re.escape(name) for name in sorted(_STRUCTURED_TOOL_NAMES))
    + r")\s*(?:\(|\{)",
    re.IGNORECASE,
)
_JSONISH_TOOL_SYNTAX_LEAK_RE = re.compile(
    r"^\s*(?:```(?:json)?\s*)?\{?\s*['\"]?(?:"
    + "|".join(re.escape(name) for name in sorted(_STRUCTURED_TOOL_NAMES))
    + r")['\"]?\s*[:({]",
    re.IGNORECASE,
)
_PROMPT_OR_TOOL_LEAK_RE = re.compile(
    r"(?:\bactive_goal\s*:|\btool_call_id\b|\bsystem\s+prompt\b|\bdeveloper\s+instructions\b|"
    r"\binternal\s+prompt\b|\btool\s+schema\b|\bfunction\s+declarations?\b|\bfunctiondeclarations\b|"
    r"\bbehavior\s+prompt\b|\btask[_\s-]?id\b|\basync\s+task\b|"
    r"\btracking\s+that\s+specific\s+task\b|"
    r"\b(?:try\s+listing\s+all\s+(?:the\s+)?builds|listing\s+all\s+(?:the\s+)?builds|list(?:ing)?\s+builds)\b|"
    r"\btool\s+(?:call|response|result|name|mechanic|mechanics)\b|"
    r"\b(?:read_artifact_text|coreview_set_view|coreview_refresh_view|coreview_get_current_view|"
    r"coreview_request_artifact_update|coreview_get_builder_status|coreview_cancel_builder_task|"
    r"start_builder_task|edit_builder_artifact|check_async_task|update_async_task|cancel_async_task|list_async_tasks)\b|^\s*schema\s*$)",
    re.IGNORECASE,
)

GeminiLiveSender = Callable[[dict[str, Any]], Awaitable[None]]
GeminiLiveMappingObserver = Callable[[Mapping[str, Any], list[ProviderEvent]], None]
RawGeminiLiveEvents = AsyncIterable[Mapping[str, Any]] | Iterable[Mapping[str, Any]]


@dataclass(frozen=True)
class ResolvedGeminiLiveVoiceConfig:
    voice_name: str
    source: str
    configured: bool
    configured_value_valid: bool
    diagnostic: str | None = None

    def as_public_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "gemini_voice_name": self.voice_name,
            "gemini_voice_source": self.source,
            "gemini_voice_configured": self.configured,
            "gemini_voice_configured_value_valid": self.configured_value_valid,
        }
        if self.diagnostic:
            payload["gemini_voice_diagnostic"] = self.diagnostic
        return payload


def resolve_gemini_live_voice_name(
    configured_value: str | None,
) -> ResolvedGeminiLiveVoiceConfig:
    configured = (configured_value or "").strip()
    if not configured:
        return ResolvedGeminiLiveVoiceConfig(
            voice_name=DEFAULT_GEMINI_LIVE_VOICE_NAME,
            source="default",
            configured=False,
            configured_value_valid=True,
        )

    canonical_voice_name = _GEMINI_LIVE_VOICE_NAMES_BY_CASEFOLD.get(
        configured.casefold()
    )
    if canonical_voice_name is not None:
        return ResolvedGeminiLiveVoiceConfig(
            voice_name=canonical_voice_name,
            source="env",
            configured=True,
            configured_value_valid=True,
        )

    return ResolvedGeminiLiveVoiceConfig(
        voice_name=DEFAULT_GEMINI_LIVE_VOICE_NAME,
        source="fallback_invalid",
        configured=True,
        configured_value_valid=False,
        diagnostic="invalid_configured_voice",
    )


class GeminiLiveAdapterDisabledError(RuntimeError):
    """Raised when code tries to construct the inactive adapter without its flag."""


@dataclass
class GeminiToolCallState:
    call_id: str
    name: str | None = None
    arguments: dict[str, Any] = field(default_factory=dict)
    emitted_request: bool = False


@dataclass
class GeminiLiveEventMapper:
    """Translate official Gemini Live server messages into ProviderEvent values.

    The mapper accepts raw WebSocket-style dictionaries using the documented
    BidiGenerateContent union fields: setupComplete, serverContent, toolCall,
    toolCallCancellation, goAway, sessionResumptionUpdate, and usageMetadata.
    SDK-style snake_case keys are accepted only as casing aliases for those same
    documented fields. Public sophia.* envelopes remain owned by the normalizer.
    """

    provider_name: str = GEMINI_LIVE_PROVIDER_NAME
    session_id: str | None = None
    _sequence: int = 0
    _active_response_id: str | None = None
    _response_started_ids: set[str] = field(default_factory=set)
    _audio_started_response_ids: set[str] = field(default_factory=set)
    _audio_ended_response_ids: set[str] = field(default_factory=set)
    _assistant_text_source_by_response: dict[str, str] = field(default_factory=dict)
    _assistant_last_text_source_by_response: dict[str, str] = field(default_factory=dict)
    _assistant_text_seen_response_ids: set[str] = field(default_factory=set)
    _transcript_segment_index_by_response: dict[str, int] = field(default_factory=dict)
    _assistant_final_response_ids: set[str] = field(default_factory=set)
    _tool_calls_by_id: dict[str, GeminiToolCallState] = field(default_factory=dict)
    _current_source_metadata: dict[str, Any] | None = None

    def map_event(
        self,
        raw_event: Mapping[str, Any],
        *,
        source_metadata: Mapping[str, Any] | None = None,
    ) -> list[ProviderEvent]:
        raw = dict(raw_event)
        events: list[ProviderEvent] = []
        previous_source_metadata = self._current_source_metadata
        self._current_source_metadata = _compact_source_metadata(source_metadata)

        try:
            if _has_key(raw, "setupComplete", "setup_complete"):
                return []

            server_content = _record_from_any_key(raw, "serverContent", "server_content")
            if server_content is not None:
                events.extend(self._map_server_content(server_content, raw))

            tool_call = _record_from_any_key(raw, "toolCall", "tool_call")
            if tool_call is not None:
                events.extend(self._map_tool_call(tool_call, raw))

            tool_call_cancellation = _record_from_any_key(
                raw,
                "toolCallCancellation",
                "tool_call_cancellation",
            )
            if tool_call_cancellation is not None:
                events.extend(self._map_tool_call_cancellation(tool_call_cancellation, raw))

            go_away = _record_from_any_key(raw, "goAway", "go_away")
            if go_away is not None:
                events.append(
                    self._event(
                        ProviderEventType.PROVIDER_METRIC,
                        {
                            "provider_event_name": "goAway",
                            "time_left": go_away.get("timeLeft") or go_away.get("time_left"),
                        },
                        raw=raw,
                    )
                )

            session_resumption_update = _record_from_any_key(
                raw,
                "sessionResumptionUpdate",
                "session_resumption_update",
            )
            if session_resumption_update is not None:
                events.append(
                    self._event(
                        ProviderEventType.PROVIDER_METRIC,
                        {
                            "provider_event_name": "sessionResumptionUpdate",
                            "resumable": session_resumption_update.get("resumable"),
                            "new_handle_present": bool(
                                _string_value(session_resumption_update.get("newHandle"))
                                or _string_value(session_resumption_update.get("new_handle"))
                            ),
                        },
                        raw=raw,
                    )
                )

            usage_metadata = _record_from_any_key(raw, "usageMetadata", "usage_metadata")
            if usage_metadata is not None and not events:
                events.append(
                    self._event(
                        ProviderEventType.PROVIDER_METRIC,
                        {
                            "provider_event_name": "usageMetadata",
                            "total_token_count": usage_metadata.get("totalTokenCount")
                            or usage_metadata.get("total_token_count"),
                            "image_count": usage_metadata.get("imageCount")
                            or usage_metadata.get("image_count"),
                            "video_duration_seconds": usage_metadata.get("videoDurationSeconds")
                            or usage_metadata.get("video_duration_seconds"),
                            "audio_duration_seconds": usage_metadata.get("audioDurationSeconds")
                            or usage_metadata.get("audio_duration_seconds"),
                        },
                        raw=raw,
                    )
                )

            if events:
                return events

            error = _record_from_any_key(raw, "error")
            if error is not None:
                return [
                    self._event(
                        ProviderEventType.PROVIDER_ERROR,
                        {
                            "stage": "gemini-live",
                            "message": _string_value(error.get("message"))
                            or "Gemini Live reported an error.",
                            "recoverable": error.get("recoverable") is not False,
                            "provider_event_name": "error",
                            "code": _string_value(error.get("code")),
                        },
                        response_id=self._active_response_id,
                        turn_id=self._active_response_id,
                        raw=raw,
                    )
                ]

            return []
        finally:
            self._current_source_metadata = previous_source_metadata

    def tool_name_for_call_id(self, call_id: str) -> str | None:
        tool_call = self._tool_calls_by_id.get(call_id)
        return tool_call.name if tool_call is not None else None

    def _map_server_content(
        self,
        content: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        events: list[ProviderEvent] = []

        input_transcription = _value_from_any_key(
            content,
            "inputTranscription",
            "input_transcription",
        )
        if input_transcription is not None:
            events.extend(self._map_input_transcription(input_transcription, raw))

        response_id = self._response_id_for_content(content, raw)
        interrupted = _bool_from_any_key(content, "interrupted")
        if interrupted:
            events.append(
                self._event(
                    ProviderEventType.RESPONSE_INTERRUPTED,
                    {
                        "provider_event_name": "serverContent.interrupted",
                        "reason": "interrupted",
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )

        model_turn = _record_from_any_key(content, "modelTurn", "model_turn")
        if model_turn is not None:
            events.extend(self._map_model_turn(model_turn, raw, response_id=response_id))

        output_transcription = _record_from_any_key(
            content,
            "outputTranscription",
            "output_transcription",
        )
        if output_transcription is not None:
            events.extend(
                self._map_output_transcription(
                    output_transcription,
                    raw,
                    response_id=response_id,
                )
            )

        if _bool_from_any_key(content, "generationComplete", "generation_complete"):
            events.extend(
                self._map_generation_complete(raw, response_id=response_id)
            )

        if _bool_from_any_key(content, "turnComplete", "turn_complete"):
            events.extend(self._map_turn_complete(raw, response_id=response_id))

        if interrupted:
            self._active_response_id = None

        return events

    def _map_input_transcription(
        self,
        transcription: Any,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        if isinstance(transcription, Mapping):
            text = _string_from_any_key(transcription, "text", "transcript")
        else:
            text = _string_value(transcription)
        text = text.strip() if text else None
        if not text:
            return []
        turn_id = _turn_id_from_raw(raw)
        return [
            self._event(
                ProviderEventType.USER_TRANSCRIPT_FINAL,
                {
                    "text": text,
                    "utterance_id": turn_id,
                    "provider_event_name": "serverContent.inputTranscription",
                },
                turn_id=turn_id,
                raw=raw,
            )
        ]

    def _map_model_turn(
        self,
        model_turn: Mapping[str, Any],
        raw: Mapping[str, Any],
        *,
        response_id: str,
    ) -> list[ProviderEvent]:
        events = self._response_started_events(response_id, raw, "serverContent.modelTurn")
        for part in _sequence_from_any_key(model_turn, "parts"):
            if not isinstance(part, Mapping):
                continue
            part_payload = dict(part)
            inline_data = _record_from_any_key(part_payload, "inlineData", "inline_data")
            if inline_data is not None:
                events.extend(self._assistant_audio_started_events(response_id, raw, inline_data))

            text = _string_value(part_payload.get("text"))
            if text:
                events.extend(
                    self._assistant_text_delta_events(
                        response_id,
                        text,
                        source="model_turn_text",
                        provider_event_name="serverContent.modelTurn.parts.text",
                        raw=raw,
                    )
                )

            function_call = _record_from_any_key(
                part_payload,
                "functionCall",
                "function_call",
            )
            if function_call is not None:
                events.extend(self._map_function_call(function_call, raw))
        return events

    def _map_output_transcription(
        self,
        transcription: Mapping[str, Any],
        raw: Mapping[str, Any],
        *,
        response_id: str,
    ) -> list[ProviderEvent]:
        text = _string_value(transcription.get("text"))
        if not text:
            return []
        events = self._response_started_events(
            response_id,
            raw,
            "serverContent.outputTranscription",
        )
        events.extend(
            self._assistant_text_delta_events(
                response_id,
                text,
                source="output_transcription",
                provider_event_name="serverContent.outputTranscription",
                raw=raw,
            )
        )
        return events

    def _map_generation_complete(
        self,
        raw: Mapping[str, Any],
        *,
        response_id: str,
    ) -> list[ProviderEvent]:
        events: list[ProviderEvent] = []
        if response_id not in self._assistant_final_response_ids:
            self._assistant_final_response_ids.add(response_id)
            events.append(
                self._event(
                    ProviderEventType.ASSISTANT_TEXT_FINAL,
                    {
                        "provider_event_name": "serverContent.generationComplete",
                        **self._assistant_transcript_response_metadata(response_id),
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )
        events.append(
            self._event(
                ProviderEventType.RESPONSE_ENDED,
                {"provider_event_name": "serverContent.generationComplete"},
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        )
        return events

    def _map_turn_complete(
        self,
        raw: Mapping[str, Any],
        *,
        response_id: str,
    ) -> list[ProviderEvent]:
        events: list[ProviderEvent] = []
        if response_id not in self._assistant_final_response_ids:
            self._assistant_final_response_ids.add(response_id)
            events.append(
                self._event(
                    ProviderEventType.ASSISTANT_TEXT_FINAL,
                    {
                        "provider_event_name": "serverContent.turnComplete",
                        **self._assistant_transcript_response_metadata(response_id),
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )
        if response_id not in self._audio_ended_response_ids:
            self._audio_ended_response_ids.add(response_id)
            events.append(
                self._event(
                    ProviderEventType.ASSISTANT_AUDIO_ENDED,
                    {"provider_event_name": "serverContent.turnComplete"},
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )
        events.append(
            self._event(
                ProviderEventType.RESPONSE_ENDED,
                {"provider_event_name": "serverContent.turnComplete"},
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        )
        self._active_response_id = None
        return events

    def _map_tool_call(
        self,
        tool_call: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        events: list[ProviderEvent] = []
        response_id = self._ensure_response_id()
        events.extend(self._response_started_events(response_id, raw, "toolCall"))
        for function_call in _sequence_from_any_key(
            tool_call,
            "functionCalls",
            "function_calls",
        ):
            if isinstance(function_call, Mapping):
                events.extend(self._map_function_call(function_call, raw))
        self._advance_transcript_segment_after_tool_call(response_id)
        return events

    def _map_function_call(
        self,
        function_call: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        call_id = _string_value(function_call.get("id")) or str(uuid4())
        name = _string_value(function_call.get("name"))
        arguments = _json_object_value(function_call.get("args"))
        if arguments is None:
            arguments = _json_object_value(function_call.get("arguments")) or {}

        tool_call = self._tool_calls_by_id.get(call_id)
        if tool_call is None:
            tool_call = GeminiToolCallState(call_id=call_id)
            self._tool_calls_by_id[call_id] = tool_call
        if name:
            tool_call.name = name
        tool_call.arguments = arguments
        return self._tool_call_requested_events(tool_call, raw)

    def _map_tool_call_cancellation(
        self,
        cancellation: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        ids = [
            call_id
            for call_id in _sequence_from_any_key(cancellation, "ids")
            if isinstance(call_id, str)
        ]
        response_id = self._active_response_id or f"gemini-response-{uuid4()}"
        return [
            self._event(
                ProviderEventType.RESPONSE_INTERRUPTED,
                {
                    "provider_event_name": "toolCallCancellation",
                    "reason": "tool_call_cancelled",
                    "cancelled_tool_call_ids": ids,
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _tool_call_requested_events(
        self,
        tool_call: GeminiToolCallState,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        if tool_call.emitted_request:
            return []
        tool_call.emitted_request = True

        response_id = self._active_response_id or self._ensure_response_id()
        data = {
            "call_id": tool_call.call_id,
            "name": tool_call.name,
            "arguments": dict(tool_call.arguments),
            "provider_event_name": "toolCall",
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
            artifact = _artifact_from_tool_arguments(tool_call.arguments)
            events.append(
                self._event(
                    ProviderEventType.ARTIFACT_PAYLOAD,
                    {
                        "artifact": artifact,
                        "call_id": tool_call.call_id,
                        "provider_event_name": "toolCall",
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
                        "builder_task": dict(tool_call.arguments),
                        "call_id": tool_call.call_id,
                        "name": tool_call.name,
                        "provider_event_name": "toolCall",
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            )

        self._advance_transcript_segment_after_tool_call(response_id)
        return events

    def _response_started_events(
        self,
        response_id: str,
        raw: Mapping[str, Any],
        provider_event_name: str,
    ) -> list[ProviderEvent]:
        self._active_response_id = response_id
        if response_id in self._response_started_ids:
            return []
        self._response_started_ids.add(response_id)
        return [
            self._event(
                ProviderEventType.RESPONSE_STARTED,
                {"provider_event_name": provider_event_name},
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _assistant_audio_started_events(
        self,
        response_id: str,
        raw: Mapping[str, Any],
        inline_data: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        if response_id in self._audio_started_response_ids:
            return []
        self._audio_started_response_ids.add(response_id)
        return [
            self._event(
                ProviderEventType.ASSISTANT_AUDIO_STARTED,
                {
                    "provider_event_name": "serverContent.modelTurn.parts.inlineData",
                    "mime_type": _string_value(inline_data.get("mimeType"))
                    or _string_value(inline_data.get("mime_type")),
                },
                response_id=response_id,
                turn_id=response_id,
                raw=raw,
            )
        ]

    def _assistant_text_delta_events(
        self,
        response_id: str,
        text: str,
        *,
        source: str,
        provider_event_name: str,
        raw: Mapping[str, Any],
    ) -> list[ProviderEvent]:
        if _looks_like_tool_syntax_leak(text):
            return [
                self._event(
                    ProviderEventType.PROVIDER_METRIC,
                    {
                        "provider_event_name": f"{provider_event_name}.tool_syntax_filtered",
                        "tool_syntax_filtered": True,
                        "text_surface": source,
                    },
                    response_id=response_id,
                    turn_id=response_id,
                    raw=raw,
                )
            ]
        if not self._accept_assistant_text_source(response_id, source):
            return []
        self._assistant_last_text_source_by_response[response_id] = source
        data = {
            "text": text,
            "is_delta": True,
            "source": source,
            "provider_event_name": provider_event_name,
            **self._assistant_transcript_source_metadata(source),
        }
        if source == "output_transcription":
            self._assistant_text_seen_response_ids.add(response_id)
            data.update(
                {
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": self._transcript_segment_id(response_id),
                }
            )
        return [
            self._event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                data,
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

    def _assistant_transcript_source_metadata(self, source: str | None) -> dict[str, Any]:
        if source == "output_transcription":
            return {
                "assistant_transcript_source": "provider_output_transcription",
                "assistant_transcript_approximate": True,
            }
        if source == "model_turn_text":
            return {
                "assistant_transcript_source": "model_turn_text",
                "assistant_transcript_approximate": False,
            }
        return {}

    def _assistant_transcript_response_metadata(self, response_id: str) -> dict[str, Any]:
        return self._assistant_transcript_source_metadata(
            self._assistant_text_source_by_response.get(response_id)
            or self._assistant_last_text_source_by_response.get(response_id)
        )

    def _transcript_segment_id(self, response_id: str) -> str:
        segment_index = self._transcript_segment_index_by_response.get(response_id, 0)
        return f"gemini-segment-{segment_index}"

    def _advance_transcript_segment_after_tool_call(self, response_id: str) -> None:
        if response_id not in self._assistant_text_seen_response_ids:
            return
        self._transcript_segment_index_by_response[response_id] = (
            self._transcript_segment_index_by_response.get(response_id, 0) + 1
        )
        self._assistant_text_seen_response_ids.discard(response_id)
        self._assistant_text_source_by_response.pop(response_id, None)

    def _response_id_for_content(
        self,
        content: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> str:
        response_id = _string_value(raw.get("responseId")) or _string_value(
            raw.get("response_id")
        )
        if response_id:
            self._active_response_id = response_id
            return response_id
        response_id = _string_value(content.get("responseId")) or _string_value(
            content.get("response_id")
        )
        if response_id:
            self._active_response_id = response_id
            return response_id
        return self._ensure_response_id()

    def _ensure_response_id(self) -> str:
        if self._active_response_id is None:
            self._active_response_id = f"gemini-response-{uuid4()}"
        return self._active_response_id

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
        mapper_sequence = self._sequence
        event_data = dict(data or {})
        source_metadata = self._current_source_metadata
        source_sequence = None
        if source_metadata:
            event_data.update(source_metadata)
            source_sequence = _int_value(source_metadata.get("source_sequence"))
        return ProviderEvent(
            event_type,
            event_data,
            provider=self.provider_name,
            session_id=self.session_id,
            response_id=response_id,
            turn_id=turn_id,
            sequence=source_sequence or mapper_sequence,
            delivery_intent=delivery_intent,
            raw=raw,
        )


class GeminiLiveProviderSession:
    """Feature-flagged Gemini Live ProviderSession adapter.

    The class translates documented Live API client/server messages but does not
    open a Google SDK session or WebSocket. A later routing phase can inject the
    transport while this adapter remains safe and inactive in production.
    """

    def __init__(
        self,
        raw_events: RawGeminiLiveEvents | None = None,
        *,
        sender: GeminiLiveSender | None = None,
        session_id: str | None = None,
        model: str = DEFAULT_GEMINI_LIVE_MODEL,
        feature_enabled: bool | None = None,
    ) -> None:
        enabled = is_gemini_live_adapter_enabled() if feature_enabled is None else feature_enabled
        if not enabled:
            raise GeminiLiveAdapterDisabledError(
                "Gemini Live adapter is disabled. Set "
                f"{GEMINI_LIVE_ADAPTER_FEATURE_FLAG}=true to construct it."
            )

        self._raw_events = raw_events
        self._sender = sender
        self._mapper = GeminiLiveEventMapper(session_id=session_id)
        self._config: dict[str, object] = {"model": model}
        self._mapping_observer: GeminiLiveMappingObserver | None = None
        self._setup_sent = False
        self._closed = False
        self.sent_events: list[dict[str, Any]] = []

    @property
    def provider_name(self) -> str:
        return GEMINI_LIVE_PROVIDER_NAME

    @property
    def capabilities(self) -> ProviderCapabilities:
        return GEMINI_LIVE_CAPABILITIES

    def set_mapping_observer(self, observer: GeminiLiveMappingObserver | None) -> None:
        self._mapping_observer = observer

    async def configure(self, config: dict[str, object]) -> None:
        if self._setup_sent:
            raise RuntimeError(
                "Gemini Live setup can only be sent once per open connection."
            )
        setup = dict(config)
        setup.setdefault("model", _model_resource(_string_value(self._config.get("model"))))
        self._config.update(setup)
        self._setup_sent = True
        await self._send_client_event({"setup": setup})

    async def send_audio(self, chunk: bytes) -> None:
        if not chunk:
            return
        encoded_audio = base64.b64encode(chunk).decode("ascii")
        await self._send_client_event(
            {
                "realtimeInput": {
                    "audio": {
                        "data": encoded_audio,
                        "mimeType": "audio/pcm;rate=16000",
                    }
                }
            }
        )

    async def send_text(self, text: str) -> None:
        await self._send_client_event({"realtimeInput": {"text": text}})

    async def send_tool_result(
        self,
        tool_call_id: str,
        result: dict[str, object],
    ) -> None:
        tool_name = self._mapper.tool_name_for_call_id(tool_call_id) or _string_value(
            result.get("name")
        )
        if not tool_name:
            tool_name = "unknown_tool"
        await self._send_client_event(
            {
                "toolResponse": {
                    "functionResponses": [
                        {
                            "id": tool_call_id,
                            "name": tool_name,
                            "response": dict(result),
                        }
                    ]
                }
            }
        )

    async def cancel_response(self, reason: str | None = None) -> None:
        await self._send_client_event({"realtimeInput": {"activityStart": {}}})

    async def events(self) -> AsyncIterator[ProviderEvent]:
        async for raw_item in self._raw_event_stream():
            raw_event, source_metadata = _unwrap_raw_event_context(raw_item)
            provider_events = self._mapper.map_event(raw_event, source_metadata=source_metadata)
            if self._mapping_observer is not None:
                self._mapping_observer(raw_event, provider_events)
            for provider_event in provider_events:
                yield provider_event

    async def close(self) -> None:
        self._closed = True
        raw_events_close = getattr(self._raw_events, "aclose", None)
        if callable(raw_events_close):
            await raw_events_close()

    async def _send_client_event(self, event: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("Cannot send Gemini Live events after session close.")
        event_payload = dict(event)
        self.sent_events.append(event_payload)
        if self._sender is not None:
            await self._sender(event_payload)

    async def _raw_event_stream(self) -> AsyncIterator[Any]:
        if self._raw_events is None:
            return

        if isinstance(self._raw_events, AsyncIterable):
            async for raw_event in self._raw_events:
                if not self._closed:
                    yield raw_event
            return

        for raw_event in self._raw_events:
            if self._closed:
                return
            yield raw_event


def build_gemini_live_setup_config(
    *,
    instructions: str | None = None,
    model: str = DEFAULT_GEMINI_LIVE_MODEL,
    response_modalities: Iterable[str] = ("AUDIO",),
    tools: Iterable[Mapping[str, Any]] | None = None,
    voice_name: str | None = DEFAULT_GEMINI_LIVE_VOICE_NAME,
    input_audio_transcription: bool = True,
    output_audio_transcription: bool = True,
) -> dict[str, object]:
    setup: dict[str, object] = {
        "model": _model_resource(model),
        "generationConfig": {"responseModalities": list(response_modalities)},
    }
    generation_config = _record_value(setup["generationConfig"])
    if voice_name and generation_config is not None:
        generation_config["speechConfig"] = {
            "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice_name}}
        }
        setup["generationConfig"] = generation_config
    if instructions:
        setup["systemInstruction"] = {"parts": [{"text": instructions}]}
    if tools is not None:
        setup["tools"] = [dict(tool) for tool in tools]
    if input_audio_transcription:
        setup["inputAudioTranscription"] = {}
    if output_audio_transcription:
        setup["outputAudioTranscription"] = {}
    return setup


def is_gemini_live_adapter_enabled(value: str | None = None) -> bool:
    raw_value = os.getenv(GEMINI_LIVE_ADAPTER_FEATURE_FLAG) if value is None else value
    return raw_value is not None and raw_value.strip().lower() in _TRUE_VALUES


def _delivery_intent_from_artifact(artifact: Mapping[str, Any]) -> DeliveryIntent:
    pace = artifact.get("voice_speed")
    if pace not in _PACE_VALUES:
        pace = "normal"

    provider_hints = {
        key: value
        for key, value in {
            "gemini_voice_emotion_primary": artifact.get("voice_emotion_primary"),
            "gemini_voice_emotion_secondary": artifact.get("voice_emotion_secondary"),
            "gemini_voice_speed": artifact.get("voice_speed"),
            "gemini_active_tone_band": artifact.get("active_tone_band"),
            "gemini_skill_loaded": artifact.get("skill_loaded"),
            "gemini_ritual_phase": artifact.get("ritual_phase"),
        }.items()
        if value is not None
    }
    tone = _string_value(artifact.get("active_tone_band")) or "steady"
    return DeliveryIntent(
        tone=tone,
        pace=pace,
        provider_hints=provider_hints,
    ).clamped()


def _artifact_from_tool_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    artifact = _record_value(arguments.get("artifact"))
    normalized = artifact if artifact is not None else dict(arguments)
    reflection = normalized.get("reflection")
    if isinstance(reflection, str) and reflection.strip().lower() in _NULL_LIKE_ARTIFACT_STRINGS:
        normalized["reflection"] = None
    return normalized


def _model_resource(model: str | None) -> str:
    model_name = model or DEFAULT_GEMINI_LIVE_MODEL
    if model_name.startswith("models/"):
        return model_name
    return f"models/{model_name}"


def _looks_like_tool_syntax_leak(text: str) -> bool:
    return bool(
        _TOOL_SYNTAX_LEAK_RE.search(text)
        or _JSONISH_TOOL_SYNTAX_LEAK_RE.search(text)
        or _PROMPT_OR_TOOL_LEAK_RE.search(text)
    )


def _turn_id_from_raw(raw: Mapping[str, Any]) -> str:
    return (
        _string_value(raw.get("eventId"))
        or _string_value(raw.get("event_id"))
        or f"gemini-utterance-{uuid4()}"
    )


def _has_key(source: Mapping[str, Any], *names: str) -> bool:
    return any(name in source for name in names)


def _bool_from_any_key(source: Mapping[str, Any], *names: str) -> bool:
    return any(source.get(name) is True for name in names)


def _value_from_any_key(source: Mapping[str, Any], *names: str) -> Any | None:
    for name in names:
        if name in source:
            return source.get(name)
    return None


def _record_from_any_key(source: Mapping[str, Any], *names: str) -> dict[str, Any] | None:
    for name in names:
        record = _record_value(source.get(name))
        if record is not None:
            return record
    return None


def _unwrap_raw_event_context(raw_item: Any) -> tuple[Mapping[str, Any], Mapping[str, Any] | None]:
    event = getattr(raw_item, "event", None)
    if isinstance(event, Mapping):
        source_metadata = getattr(raw_item, "source_metadata", None)
        return event, source_metadata if isinstance(source_metadata, Mapping) else None
    return raw_item, None


def _compact_source_metadata(source_metadata: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not source_metadata:
        return None
    source_sequence = _int_value(source_metadata.get("provider_receive_sequence"))
    if source_sequence is None:
        return None
    compact: dict[str, Any] = {"source_sequence": source_sequence}
    provider_relay_sequence = _int_value(source_metadata.get("provider_relay_sequence"))
    provider_received_at = _string_value(source_metadata.get("provider_received_at"))
    relay_correlation_id = _string_value(source_metadata.get("relay_correlation_id"))
    provider_primary_category = _string_value(source_metadata.get("provider_primary_category"))
    provider_categories = _sequence_value(source_metadata.get("provider_categories"))
    if provider_received_at:
        compact["provider_received_at"] = provider_received_at
    if provider_relay_sequence is not None:
        compact["provider_relay_sequence"] = provider_relay_sequence
    if relay_correlation_id:
        compact["relay_correlation_id"] = relay_correlation_id
    if provider_primary_category:
        compact["provider_primary_category"] = provider_primary_category
    if provider_categories:
        compact["provider_categories"] = [category for category in provider_categories if isinstance(category, str)]
    return compact


def _string_from_any_key(source: Mapping[str, Any], *names: str) -> str | None:
    for name in names:
        text = _string_value(source.get(name))
        if text:
            return text
    return None


def _sequence_from_any_key(source: Mapping[str, Any], *names: str) -> list[Any]:
    for name in names:
        sequence = _sequence_value(source.get(name))
        if sequence:
            return sequence
    return []


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


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _record_value(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None
