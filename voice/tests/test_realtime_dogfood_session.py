from __future__ import annotations

import asyncio
import json

import pytest

from voice.realtime import (
    ProviderEvent,
    RealtimeDogfoodConfigurationError,
    RealtimeDogfoodSessionManager,
    VoiceRuntimeMode,
)
from voice.tests.conftest import make_settings


def _set_common_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STREAM_API_KEY", "stream-key")
    monkeypatch.setenv("STREAM_API_SECRET", "stream-secret")


def _artifact() -> dict[str, object]:
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


def _openai_settings():  # noqa: ANN202
    return make_settings(
        voice_runtime_mode=VoiceRuntimeMode.OPENAI_REALTIME.value,
        experimental_realtime_runtime_enabled=True,
        openai_realtime_adapter_enabled=True,
    )


def _gemini_settings():  # noqa: ANN202
    return make_settings(
        voice_runtime_mode=VoiceRuntimeMode.GEMINI_LIVE.value,
        experimental_realtime_runtime_enabled=True,
        gemini_live_adapter_enabled=True,
    )


@pytest.mark.anyio
async def test_dogfood_session_rejects_legacy_runtime() -> None:
    manager = RealtimeDogfoodSessionManager()

    with pytest.raises(RealtimeDogfoodConfigurationError, match="openai_realtime or gemini_live"):
        await manager.start_session(make_settings(), user_id="user-1")


@pytest.mark.anyio
async def test_openai_dogfood_session_pumps_public_events_through_normalizer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_common_provider_env(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    manager = RealtimeDogfoodSessionManager()
    session = await manager.start_session(
        _openai_settings(),
        user_id="user-1",
        session_id="dogfood-openai",
    )

    assert session.metadata()["runtime"] == "openai_realtime"
    assert session.metadata()["public_event_boundary"] == "SophiaEventNormalizer"
    assert session.metadata()["browser_audio"] == "not_implemented"

    await session.send_text("I had a rough day.")
    assert session.sent_client_event_count == 3

    raw_events = [
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "user-item-1",
            "transcript": "I had a rough day.",
        },
        {"type": "response.created", "response": {"id": "resp-openai-1"}},
        {
            "type": "response.output_audio_transcript.delta",
            "response_id": "resp-openai-1",
            "delta": "That sounds heavy. ",
        },
        {
            "type": "response.output_audio_transcript.done",
            "response_id": "resp-openai-1",
        },
        {
            "type": "response.function_call_arguments.done",
            "response_id": "resp-openai-1",
            "call_id": "artifact-call-1",
            "name": "emit_artifact",
            "arguments": json.dumps(_artifact()),
        },
        {
            "type": "response.done",
            "response": {"id": "resp-openai-1", "status": "completed", "output": []},
        },
    ]

    for raw_event in raw_events:
        await session.ingest_provider_event(raw_event)

    payloads = await session.wait_for_public_payloads(7)

    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
        "sophia.turn",
    ]
    assert payloads[0]["data"] == {"text": "I had a rough day.", "utterance_id": "user-item-1"}
    assert payloads[5] == {"type": "sophia.artifact", "data": _artifact()}
    assert all(str(payload["type"]).startswith("sophia.") for payload in payloads)
    assert "response." not in json.dumps(payloads)

    await manager.close_session(session.session_id)


@pytest.mark.anyio
async def test_gemini_dogfood_session_pumps_public_events_through_normalizer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_common_provider_env(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-key")
    manager = RealtimeDogfoodSessionManager()
    session = await manager.start_session(
        _gemini_settings(),
        user_id="user-1",
        session_id="dogfood-gemini",
    )

    assert session.metadata()["runtime"] == "gemini_live"
    assert session.metadata()["transport"] == "internal_provider_event_pump"

    await session.send_text("I had a rough day.")
    assert session.sent_client_event_count == 2

    raw_events = [
        {"setupComplete": {}},
        {
            "eventId": "user-item-1",
            "serverContent": {
                "inputTranscription": {"text": "I had a rough day."},
            },
        },
        {
            "serverContent": {
                "outputTranscription": {"text": "That sounds heavy. "},
            },
        },
        {
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "artifact-call-1",
                        "name": "emit_artifact",
                        "args": {"artifact": _artifact()},
                    }
                ]
            }
        },
        {"serverContent": {"generationComplete": True}},
    ]

    for raw_event in raw_events:
        await session.ingest_provider_event(raw_event)

    payloads = await session.wait_for_public_payloads(7)

    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.artifact",
        "sophia.transcript",
        "sophia.turn",
    ]
    assert payloads[0]["data"] == {"text": "I had a rough day.", "utterance_id": "user-item-1"}
    assert payloads[4] == {"type": "sophia.artifact", "data": _artifact()}
    assert all(str(payload["type"]).startswith("sophia.") for payload in payloads)
    assert "serverContent" not in json.dumps(payloads)

    late_subscriber = session.subscribe()
    assert await asyncio.wait_for(late_subscriber.get(), timeout=1.0) == payloads[0]
    assert late_subscriber.empty()
    session.unsubscribe(late_subscriber)

    await session.publish_provider_metric({"metric": "relay_lag_ms", "value": 12})
    await session.publish_provider_event(
        ProviderEvent.builder_task_payload(
            {"type": "task_started", "task_id": "builder-1"},
        )
    )
    event_subscriber = session.subscribe_events(after_event_id=7)
    replayed_events = [
        await asyncio.wait_for(event_subscriber.get(), timeout=1.0),
        await asyncio.wait_for(event_subscriber.get(), timeout=1.0),
    ]
    assert [event.event_id for event in replayed_events if event is not None] == [8, 9]
    assert [event.payload["type"] for event in replayed_events if event is not None] == [
        "sophia.turn_diagnostic",
        "sophia.builder_task",
    ]
    assert event_subscriber.empty()
    session.unsubscribe_events(event_subscriber)

    await manager.close_session(session.session_id)
