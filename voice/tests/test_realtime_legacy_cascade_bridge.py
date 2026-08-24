from __future__ import annotations

from typing import Any

import pytest

from voice.adapters.base import BackendEvent, REQUIRED_ARTIFACT_FIELDS
from voice.realtime import (
    LEGACY_CASCADE_PROVIDER_NAME,
    LegacyCascadeCompatibilityBridge,
    LegacyCascadeProviderSession,
    ProviderEvent,
    ProviderEventType,
    SophiaEventNormalizer,
    SophiaRealtimeTurnRuntime,
)


def _artifact(**overrides: object) -> dict[str, object]:
    artifact = {
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
    artifact.update(overrides)
    return artifact


def _bridge() -> LegacyCascadeCompatibilityBridge:
    return LegacyCascadeCompatibilityBridge(
        session_id="voice-session-1",
        user_id="user-1",
        turn_id="legacy-turn-1",
        response_id="legacy-response-1",
    )


def _payloads(
    provider_events: list[ProviderEvent],
    *,
    artifact_validator=None,  # noqa: ANN001
) -> list[dict[str, Any]]:
    normalizer = SophiaEventNormalizer(artifact_validator=artifact_validator)
    return [event.as_payload() for event in normalizer.normalize_events(provider_events)]


def _event_types(payloads: list[dict[str, Any]]) -> list[str]:
    return [payload["type"] for payload in payloads]


def _turn_phases(payloads: list[dict[str, Any]]) -> list[str]:
    return [
        payload["data"].get("phase")
        for payload in payloads
        if payload["type"] == "sophia.turn"
    ]


@pytest.mark.anyio
async def test_successful_legacy_cascade_turn_normalizes_to_public_contract() -> None:
    bridge = _bridge()
    provider_events = [
        bridge.final_user_transcript("I had a rough day.", utterance_id="legacy-utt-1"),
        bridge.agent_response_started(stage="first_text"),
        bridge.translate_backend_event(BackendEvent.text_chunk("I hear you. ")),
        bridge.translate_backend_event(BackendEvent.text_chunk("Let's slow it down together.")),
        bridge.assistant_final_text(),
        bridge.translate_backend_event(BackendEvent.artifact_payload(_artifact())),
        bridge.agent_response_ended(stage="backend_complete"),
    ]

    assert [event.type for event in provider_events] == [
        ProviderEventType.USER_TRANSCRIPT_FINAL,
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_FINAL,
        ProviderEventType.ARTIFACT_PAYLOAD,
        ProviderEventType.RESPONSE_ENDED,
    ]
    assert {event.provider for event in provider_events} == {LEGACY_CASCADE_PROVIDER_NAME}

    session = LegacyCascadeProviderSession(provider_events, bridge=bridge)
    runtime = SophiaRealtimeTurnRuntime(
        provider_session=session,
        normalizer=SophiaEventNormalizer(),
    )
    payloads = [event.as_payload() async for event in runtime.public_events()]

    assert _event_types(payloads) == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
        "sophia.turn",
    ]
    assert payloads[0] == {
        "type": "sophia.user_transcript",
        "data": {"text": "I had a rough day.", "utterance_id": "legacy-utt-1"},
    }
    assert _turn_phases(payloads) == ["user_ended", "agent_started", "agent_ended"]
    assert payloads[3]["data"] == {"text": "I hear you. ", "is_final": False}
    assert payloads[4]["data"] == {
        "text": "I hear you. Let's slow it down together.",
        "is_final": False,
    }
    assert payloads[5]["data"] == {
        "text": "I hear you. Let's slow it down together.",
        "is_final": True,
    }
    assert payloads[6] == {"type": "sophia.artifact", "data": _artifact()}


def test_builder_task_payload_is_preserved_through_provider_events() -> None:
    bridge = _bridge()
    provider_events = [
        bridge.final_user_transcript("Can you have the builder draft this?", utterance_id="legacy-utt-2"),
        bridge.translate_backend_event(
            BackendEvent.builder_task_payload(
                {
                    "type": "task_started",
                    "task_id": "builder-1",
                    "description": "Builder: draft a project plan",
                    "progress_percent": 0,
                }
            )
        ),
        bridge.agent_response_started(),
        bridge.translate_backend_event(BackendEvent.text_chunk("I'll start that in the background.")),
        bridge.assistant_final_text(),
        bridge.translate_backend_event(BackendEvent.artifact_payload(_artifact())),
        bridge.agent_response_ended(),
    ]

    assert provider_events[1].type == ProviderEventType.BUILDER_TASK_PAYLOAD
    payloads = _payloads(provider_events)

    builder_payloads = [payload for payload in payloads if payload["type"] == "sophia.builder_task"]
    assert builder_payloads == [
        {
            "type": "sophia.builder_task",
            "data": {
                "type": "task_started",
                "task_id": "builder-1",
                "description": "Builder: draft a project plan",
                "progress_percent": 0,
            },
        }
    ]


def test_cancellation_interruption_maps_to_terminal_diagnostic_shape() -> None:
    bridge = _bridge()
    provider_events = [
        bridge.agent_response_started(),
        bridge.response_interrupted("cancel_and_merge", source="conversation_flow"),
        bridge.agent_response_ended(),
    ]

    payloads = _payloads(provider_events)

    assert payloads == [
        {
            "type": "sophia.turn",
            "data": {
                "phase": "agent_started",
                "response_id": "legacy-response-1",
                "turn_id": "legacy-turn-1",
            },
        },
        {
            "type": "sophia.turn",
            "data": {
                "phase": "agent_ended",
                "response_id": "legacy-response-1",
                "turn_id": "legacy-turn-1",
                "reason": "interrupted",
            },
        },
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "turn_id": "legacy-turn-1",
                "status": "failed",
                "reason": "interrupted",
                "provider": LEGACY_CASCADE_PROVIDER_NAME,
                "response_id": "legacy-response-1",
                "interrupted": True,
            },
        },
    ]


def test_stage_error_maps_to_provider_error_and_public_terminal_events() -> None:
    bridge = _bridge()
    provider_events = [
        bridge.agent_response_started(),
        bridge.translate_backend_event(
            BackendEvent.error_event(
                "backend-stream",
                "DeerFlow stream closed unexpectedly.",
                recoverable=False,
            )
        ),
    ]

    payloads = _payloads(provider_events)

    assert payloads == [
        {
            "type": "sophia.turn",
            "data": {
                "phase": "agent_started",
                "response_id": "legacy-response-1",
                "turn_id": "legacy-turn-1",
            },
        },
        {
            "type": "sophia.turn",
            "data": {
                "phase": "agent_ended",
                "response_id": "legacy-response-1",
                "turn_id": "legacy-turn-1",
                "reason": "provider_error",
            },
        },
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "turn_id": "legacy-turn-1",
                "status": "failed",
                "reason": "provider_error",
                "provider": LEGACY_CASCADE_PROVIDER_NAME,
                "response_id": "legacy-response-1",
                "stage": "backend-stream",
                "message": "DeerFlow stream closed unexpectedly.",
                "recoverable": False,
            },
        },
    ]


def test_duplicate_legacy_lifecycle_markers_are_deduped_downstream() -> None:
    bridge = _bridge()
    provider_events = [
        bridge.agent_response_started(source="first_backend_text"),
        bridge.agent_response_started(source="tts_audio_started"),
        bridge.agent_response_ended(source="backend_complete"),
        bridge.agent_response_ended(source="tts_audio_ended"),
    ]

    assert [event.type for event in provider_events].count(ProviderEventType.RESPONSE_STARTED) == 2
    assert [event.type for event in provider_events].count(ProviderEventType.RESPONSE_ENDED) == 2

    payloads = _payloads(provider_events)

    assert payloads == [
        {
            "type": "sophia.turn",
            "data": {
                "phase": "agent_started",
                "response_id": "legacy-response-1",
                "turn_id": "legacy-turn-1",
            },
        },
        {
            "type": "sophia.turn",
            "data": {
                "phase": "agent_ended",
                "response_id": "legacy-response-1",
                "turn_id": "legacy-turn-1",
            },
        },
    ]


def test_artifact_payload_keeps_existing_validation_shape_and_delivery_metadata() -> None:
    bridge = _bridge()
    artifact = _artifact()
    provider_event = bridge.translate_backend_event(BackendEvent.artifact_payload(artifact))

    def validator(candidate: dict[str, Any]) -> dict[str, Any]:
        assert REQUIRED_ARTIFACT_FIELDS.issubset(candidate)
        return {**candidate, "validated_by": "legacy-compat-test"}

    payloads = _payloads([provider_event], artifact_validator=validator)

    assert provider_event.type == ProviderEventType.ARTIFACT_PAYLOAD
    assert provider_event.data["artifact"] == artifact
    assert provider_event.delivery_intent is not None
    assert provider_event.delivery_intent.pace == "gentle"
    assert provider_event.delivery_intent.provider_hints == {
        "legacy_voice_emotion_primary": "calm",
        "legacy_voice_emotion_secondary": "sympathetic",
        "legacy_voice_speed": "gentle",
        "legacy_active_tone_band": "engagement",
        "legacy_skill_loaded": "active_listening",
        "legacy_ritual_phase": "free_conversation.opening",
    }
    assert payloads == [
        {
            "type": "sophia.artifact",
            "data": {**artifact, "validated_by": "legacy-compat-test"},
        }
    ]


def test_turn_diagnostic_payload_can_be_represented_as_provider_metric() -> None:
    bridge = _bridge()
    provider_event = bridge.turn_diagnostic(
        {
            "turn_id": "legacy-turn-1",
            "status": "completed",
            "reason": "completed",
            "raw_false_end_count": 2,
            "duplicate_phase_counts": {"agent_started": 1},
            "backend_request_start_ms": 20.0,
            "backend_first_event_ms": 80.0,
            "first_text_ms": 120.0,
            "backend_complete_ms": 500.0,
            "first_audio_ms": 160.0,
        }
    )

    payloads = _payloads([provider_event])

    assert provider_event.type == ProviderEventType.PROVIDER_METRIC
    assert payloads == [
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "turn_id": "legacy-turn-1",
                "status": "completed",
                "reason": "completed",
                "provider": LEGACY_CASCADE_PROVIDER_NAME,
                "response_id": "legacy-response-1",
                "raw_false_end_count": 2,
                "duplicate_phase_counts": {"agent_started": 1},
                "backend_request_start_ms": 20.0,
                "backend_first_event_ms": 80.0,
                "first_text_ms": 120.0,
                "backend_complete_ms": 500.0,
                "first_audio_ms": 160.0,
            },
        }
    ]
