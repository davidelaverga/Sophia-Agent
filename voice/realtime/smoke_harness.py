from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from voice.realtime.events import ProviderEvent, SophiaEvent
from voice.realtime.legacy_cascade import LegacyCascadeCompatibilityBridge
from voice.realtime.runtime_factory import (
    RealtimeRuntimeFactoryConfig,
    build_realtime_runtime_bundle,
)
from voice.realtime.runtime_selection import VoiceRuntimeMode


@dataclass(frozen=True)
class RealtimeSmokeResult:
    mode: VoiceRuntimeMode
    provider_name: str
    provider_event_types: tuple[str, ...]
    public_events: tuple[SophiaEvent, ...]

    @property
    def public_event_types(self) -> tuple[str, ...]:
        return tuple(event.type for event in self.public_events)

    @property
    def public_payloads(self) -> tuple[dict[str, Any], ...]:
        return tuple(event.as_payload() for event in self.public_events)


@dataclass(frozen=True)
class RealtimeSmokeComparison:
    results: tuple[RealtimeSmokeResult, ...]
    missing_required_by_mode: dict[str, tuple[str, ...]]
    provider_wire_leaks_by_mode: dict[str, tuple[str, ...]]

    @property
    def passed(self) -> bool:
        return not any(self.missing_required_by_mode.values()) and not any(
            self.provider_wire_leaks_by_mode.values()
        )


async def run_realtime_smoke(
    mode: VoiceRuntimeMode | str,
) -> RealtimeSmokeResult:
    selected_mode = VoiceRuntimeMode(str(mode).strip().lower().replace("-", "_"))
    config = _smoke_config_for_mode(selected_mode)
    raw_events, provider_events = _smoke_events_for_mode(selected_mode)
    bundle = build_realtime_runtime_bundle(
        config,
        raw_events=raw_events,
        provider_events=provider_events,
    )
    public_events: list[SophiaEvent] = []
    provider_event_types: list[str] = []

    try:
        async for provider_event in bundle.provider_session.events():
            provider_event_types.append(provider_event.type.value)
            for public_event in bundle.runtime.normalizer.normalize_event(provider_event):
                public_events.append(public_event)
    finally:
        await bundle.runtime.close()

    return RealtimeSmokeResult(
        mode=bundle.selection.mode,
        provider_name=bundle.provider_session.provider_name,
        provider_event_types=tuple(provider_event_types),
        public_events=tuple(public_events),
    )


async def run_comparative_smoke_harness(
    modes: tuple[VoiceRuntimeMode, ...] = (
        VoiceRuntimeMode.LEGACY_CASCADE,
        VoiceRuntimeMode.OPENAI_REALTIME,
        VoiceRuntimeMode.GEMINI_LIVE,
    ),
) -> RealtimeSmokeComparison:
    results = tuple([await run_realtime_smoke(mode) for mode in modes])
    return compare_smoke_results(results)


def compare_smoke_results(
    results: tuple[RealtimeSmokeResult, ...],
) -> RealtimeSmokeComparison:
    return RealtimeSmokeComparison(
        results=results,
        missing_required_by_mode={
            result.mode.value: _missing_required_contract_events(result)
            for result in results
        },
        provider_wire_leaks_by_mode={
            result.mode.value: _provider_wire_leaks(result)
            for result in results
        },
    )


def _smoke_config_for_mode(mode: VoiceRuntimeMode) -> RealtimeRuntimeFactoryConfig:
    if mode == VoiceRuntimeMode.LEGACY_CASCADE:
        return RealtimeRuntimeFactoryConfig(mode=mode, session_id="smoke-legacy-session")
    if mode == VoiceRuntimeMode.OPENAI_REALTIME:
        return RealtimeRuntimeFactoryConfig(
            mode=mode,
            experimental_runtime_enabled=True,
            openai_realtime_adapter_enabled=True,
            session_id="smoke-openai-session",
        )
    if mode == VoiceRuntimeMode.GEMINI_LIVE:
        return RealtimeRuntimeFactoryConfig(
            mode=mode,
            experimental_runtime_enabled=True,
            gemini_live_adapter_enabled=True,
            session_id="smoke-gemini-session",
        )
    raise ValueError(f"Unsupported smoke runtime mode: {mode!r}")


def _smoke_events_for_mode(
    mode: VoiceRuntimeMode,
) -> tuple[list[dict[str, Any]] | None, list[ProviderEvent] | None]:
    if mode == VoiceRuntimeMode.LEGACY_CASCADE:
        return None, _legacy_smoke_events()
    if mode == VoiceRuntimeMode.OPENAI_REALTIME:
        return _openai_smoke_raw_events(), None
    if mode == VoiceRuntimeMode.GEMINI_LIVE:
        return _gemini_smoke_raw_events(), None
    raise ValueError(f"Unsupported smoke runtime mode: {mode!r}")


def _legacy_smoke_events() -> list[ProviderEvent]:
    bridge = LegacyCascadeCompatibilityBridge(
        session_id="smoke-legacy-session",
        turn_id="smoke-legacy-turn",
        response_id="smoke-legacy-response",
    )
    return [
        bridge.final_user_transcript("I had a rough day.", utterance_id="smoke-user-1"),
        bridge.agent_response_started(),
        bridge.assistant_partial_text("That sounds heavy. "),
        bridge.assistant_partial_text("I'm here with you."),
        bridge.assistant_final_text(),
        bridge.artifact_payload(_smoke_artifact()),
        bridge.agent_response_ended(),
    ]


def _openai_smoke_raw_events() -> list[dict[str, Any]]:
    return [
        {"type": "session.created", "session": {"id": "smoke-openai-session"}},
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "smoke-user-1",
            "transcript": "I had a rough day.",
        },
        {"type": "response.created", "response": {"id": "smoke-openai-response"}},
        {
            "type": "response.output_audio.delta",
            "response_id": "smoke-openai-response",
            "delta": "AAE=",
        },
        {
            "type": "response.output_audio_transcript.delta",
            "response_id": "smoke-openai-response",
            "delta": "That sounds heavy. ",
        },
        {
            "type": "response.output_audio_transcript.delta",
            "response_id": "smoke-openai-response",
            "delta": "I'm here with you.",
        },
        {
            "type": "response.output_audio_transcript.done",
            "response_id": "smoke-openai-response",
        },
        {
            "type": "response.function_call_arguments.done",
            "response_id": "smoke-openai-response",
            "call_id": "smoke-artifact-call",
            "name": "emit_artifact",
            "arguments": json.dumps(_smoke_artifact()),
        },
        {
            "type": "response.done",
            "response": {"id": "smoke-openai-response", "status": "completed"},
        },
    ]


def _gemini_smoke_raw_events() -> list[dict[str, Any]]:
    return [
        {"setupComplete": {}},
        {
            "eventId": "smoke-user-1",
            "serverContent": {
                "inputTranscription": {"text": "I had a rough day."},
            },
        },
        {
            "responseId": "smoke-gemini-response",
            "serverContent": {
                "modelTurn": {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": "audio/pcm;rate=24000",
                                "data": "AAE=",
                            }
                        }
                    ]
                }
            },
        },
        {
            "responseId": "smoke-gemini-response",
            "serverContent": {"outputTranscription": {"text": "That sounds heavy. "}},
        },
        {
            "responseId": "smoke-gemini-response",
            "serverContent": {"outputTranscription": {"text": "I'm here with you."}},
        },
        {
            "responseId": "smoke-gemini-response",
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "smoke-artifact-call",
                        "name": "emit_artifact",
                        "args": {"artifact": _smoke_artifact()},
                    }
                ]
            },
        },
        {
            "responseId": "smoke-gemini-response",
            "serverContent": {"generationComplete": True},
        },
        {
            "responseId": "smoke-gemini-response",
            "serverContent": {"turnComplete": True},
        },
    ]


def _missing_required_contract_events(result: RealtimeSmokeResult) -> tuple[str, ...]:
    missing: list[str] = []
    payloads = result.public_payloads
    event_types = result.public_event_types

    if "sophia.user_transcript" not in event_types:
        missing.append("sophia.user_transcript")
    if not _has_turn_phase(payloads, "user_ended"):
        missing.append("sophia.turn:user_ended")
    if not _has_turn_phase(payloads, "agent_started"):
        missing.append("sophia.turn:agent_started")
    if not _has_final_transcript(payloads):
        missing.append("sophia.transcript:final")
    if "sophia.artifact" not in event_types:
        missing.append("sophia.artifact")
    if not _has_turn_phase(payloads, "agent_ended"):
        missing.append("sophia.turn:agent_ended")

    return tuple(missing)


def _provider_wire_leaks(result: RealtimeSmokeResult) -> tuple[str, ...]:
    leaks: list[str] = []
    for payload in result.public_payloads:
        event_type = payload["type"]
        if not event_type.startswith("sophia."):
            leaks.append(event_type)
            continue
        serialized = json.dumps(payload, sort_keys=True, default=str)
        if any(marker in serialized for marker in _PROVIDER_WIRE_MARKERS):
            leaks.append(event_type)
    return tuple(leaks)


def _has_turn_phase(payloads: tuple[dict[str, Any], ...], phase: str) -> bool:
    return any(
        payload["type"] == "sophia.turn" and payload["data"].get("phase") == phase
        for payload in payloads
    )


def _has_final_transcript(payloads: tuple[dict[str, Any], ...]) -> bool:
    return any(
        payload["type"] == "sophia.transcript"
        and payload["data"].get("is_final") is True
        and isinstance(payload["data"].get("text"), str)
        and bool(payload["data"].get("text"))
        for payload in payloads
    )


def _smoke_artifact() -> dict[str, Any]:
    return {
        "session_goal": "Stay grounded in the voice session.",
        "active_goal": "Help the user name what is happening.",
        "next_step": "Listen for the next turn.",
        "takeaway": "The user wants a steadier moment.",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "free_conversation.opening",
        "voice_emotion_primary": "calm",
        "voice_emotion_secondary": "sympathetic",
        "voice_speed": "gentle",
    }


_PROVIDER_WIRE_MARKERS = (
    "conversation.item",
    "response.",
    "serverContent",
    "toolCall",
    "setupComplete",
)