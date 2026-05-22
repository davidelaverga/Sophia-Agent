from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from voice.realtime import SophiaEventNormalizer
from voice.realtime.events import ProviderEventType
from voice.realtime.gemini_live import (
    DEFAULT_GEMINI_LIVE_MODEL,
    GEMINI_LIVE_ADAPTER_FEATURE_FLAG,
    GEMINI_LIVE_CAPABILITIES,
    GEMINI_LIVE_PROVIDER_NAME,
    GeminiLiveAdapterDisabledError,
    GeminiLiveEventMapper,
    GeminiLiveProviderSession,
    build_gemini_live_setup_config,
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


def _payloads(provider_events: list[Any]) -> list[dict[str, Any]]:
    return [
        event.as_payload()
        for event in SophiaEventNormalizer().normalize_events(provider_events)
    ]


def test_capabilities_describe_gemini_live_without_making_it_default() -> None:
    assert GEMINI_LIVE_PROVIDER_NAME == "google-gemini-live"
    assert GEMINI_LIVE_CAPABILITIES.native_audio_input is True
    assert GEMINI_LIVE_CAPABILITIES.native_audio_output is True
    assert GEMINI_LIVE_CAPABILITIES.tool_calls is True
    assert GEMINI_LIVE_CAPABILITIES.structured_tool_payloads is True
    assert GEMINI_LIVE_CAPABILITIES.native_cancellation is True
    assert GEMINI_LIVE_CAPABILITIES.session_updates is False
    assert GEMINI_LIVE_CAPABILITIES.provider_hints["model"] == DEFAULT_GEMINI_LIVE_MODEL
    assert (
        GEMINI_LIVE_CAPABILITIES.provider_hints["setup_handshake"]
        == "setup_then_setupComplete_before_inputs"
    )


def test_session_construction_requires_explicit_feature_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(GEMINI_LIVE_ADAPTER_FEATURE_FLAG, raising=False)

    with pytest.raises(GeminiLiveAdapterDisabledError):
        GeminiLiveProviderSession()

    monkeypatch.setenv(GEMINI_LIVE_ADAPTER_FEATURE_FLAG, "true")
    session = GeminiLiveProviderSession()

    assert session.provider_name == GEMINI_LIVE_PROVIDER_NAME
    assert session.capabilities == GEMINI_LIVE_CAPABILITIES


@pytest.mark.anyio
async def test_raw_gemini_live_flow_normalizes_to_existing_sophia_events() -> None:
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
            }
        },
        {"serverContent": {"outputTranscription": {"text": "That sounds heavy. "}}},
        {"serverContent": {"outputTranscription": {"text": "I'm here with you."}}},
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
        {"serverContent": {"turnComplete": True}},
    ]
    session = GeminiLiveProviderSession(raw_events, feature_enabled=True)

    provider_events = [provider_event async for provider_event in session.events()]
    payloads = _payloads(provider_events)

    assert [provider_event.type for provider_event in provider_events] == [
        ProviderEventType.USER_TRANSCRIPT_FINAL,
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.ASSISTANT_AUDIO_STARTED,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
        ProviderEventType.ASSISTANT_TEXT_FINAL,
        ProviderEventType.RESPONSE_ENDED,
        ProviderEventType.ASSISTANT_AUDIO_ENDED,
        ProviderEventType.RESPONSE_ENDED,
    ]
    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
        "sophia.transcript",
        "sophia.turn",
    ]
    assert payloads[0]["data"] == {
        "text": "I had a rough day.",
        "utterance_id": "user-item-1",
    }
    assert payloads[3]["data"] == {
        "text": "That sounds heavy.",
        "is_final": False,
    }
    assert payloads[4]["data"] == {
        "text": "That sounds heavy. I'm here with you.",
        "is_final": False,
    }
    assert payloads[5] == {"type": "sophia.artifact", "data": _artifact()}
    assert payloads[6]["data"] == {
        "text": "That sounds heavy. I'm here with you.",
        "is_final": True,
    }
    assert all(payload["type"].startswith("sophia.") for payload in payloads)
    assert all("serverContent" not in payload["type"] for payload in payloads)
    assert provider_events[0].raw["serverContent"]["inputTranscription"]["text"]


def test_emit_artifact_tool_call_emits_structured_artifact_event() -> None:
    mapper = GeminiLiveEventMapper(session_id="sess-gemini-1")
    events = mapper.map_event(
        {
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "artifact-call-1",
                        "name": "emit_artifact",
                        "args": {"artifact": _artifact(voice_speed="energetic")},
                    }
                ]
            }
        }
    )

    assert [event.type for event in events] == [
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.TOOL_CALL_REQUESTED,
        ProviderEventType.ARTIFACT_PAYLOAD,
    ]
    assert events[1].data["name"] == "emit_artifact"
    assert events[1].data["arguments"] == {"artifact": _artifact(voice_speed="energetic")}
    assert events[2].data["artifact"] == _artifact(voice_speed="energetic")
    assert events[2].delivery_intent is not None
    assert events[2].delivery_intent.pace == "energetic"


def test_emit_artifact_tool_call_normalizes_null_like_reflection() -> None:
    mapper = GeminiLiveEventMapper(session_id="sess-gemini-1")
    events = mapper.map_event(
        {
            "toolCall": {
                "functionCalls": [
                    {
                        "id": "artifact-call-1",
                        "name": "emit_artifact",
                        "args": {"artifact": _artifact(reflection="null")},
                    }
                ]
            }
        }
    )

    assert events[2].type == ProviderEventType.ARTIFACT_PAYLOAD
    assert events[2].data["artifact"]["reflection"] is None


def test_output_transcription_preserves_browser_relay_source_metadata() -> None:
    mapper = GeminiLiveEventMapper(session_id="sess-gemini-source-order")
    events = mapper.map_event(
        {"serverContent": {"outputTranscription": {"text": "You ready"}}},
        source_metadata={
            "provider_receive_sequence": 41,
            "provider_relay_sequence": 7,
            "provider_received_at": "2026-05-20T00:00:00.000Z",
            "relay_correlation_id": "gemini-relay-41-outputTranscription",
            "provider_primary_category": "serverContent",
            "provider_categories": ["serverContent", "outputTranscription"],
        },
    )

    transcript_event = next(event for event in events if event.type == ProviderEventType.ASSISTANT_TEXT_DELTA)
    assert transcript_event.sequence == 41
    assert transcript_event.data["source_sequence"] == 41
    assert transcript_event.data["provider_relay_sequence"] == 7
    assert transcript_event.data["provider_received_at"] == "2026-05-20T00:00:00.000Z"
    assert transcript_event.data["relay_correlation_id"] == "gemini-relay-41-outputTranscription"


def test_input_transcription_preserves_browser_relay_source_metadata() -> None:
    mapper = GeminiLiveEventMapper(session_id="sess-gemini-input-source-order")
    events = mapper.map_event(
        {
            "eventId": "user-item-source-1",
            "serverContent": {"inputTranscription": {"text": "Quick question before I go."}},
        },
        source_metadata={
            "provider_receive_sequence": 42,
            "provider_relay_sequence": 8,
            "provider_received_at": "2026-05-20T00:00:01.000Z",
            "relay_correlation_id": "gemini-relay-42-inputTranscription",
            "provider_primary_category": "serverContent",
            "provider_categories": ["serverContent", "inputTranscription"],
        },
    )

    transcript_event = next(event for event in events if event.type == ProviderEventType.USER_TRANSCRIPT_FINAL)
    assert transcript_event.sequence == 42
    assert transcript_event.data["source_sequence"] == 42
    assert transcript_event.data["provider_relay_sequence"] == 8
    assert transcript_event.data["provider_received_at"] == "2026-05-20T00:00:01.000Z"
    assert transcript_event.data["relay_correlation_id"] == "gemini-relay-42-inputTranscription"
    assert _payloads(events)[0] == {
        "type": "sophia.user_transcript",
        "data": {
            "text": "Quick question before I go.",
            "utterance_id": "user-item-source-1",
            "source_sequence": 42,
            "provider_relay_sequence": 8,
            "provider_received_at": "2026-05-20T00:00:01.000Z",
            "relay_correlation_id": "gemini-relay-42-inputTranscription",
        },
    }


@pytest.mark.parametrize(
    ("input_transcription", "expected_text"),
    [
        ({"text": "Text field transcript."}, "Text field transcript."),
        ({"transcript": "Transcript alias."}, "Transcript alias."),
        ("String transcript.", "String transcript."),
    ],
)
def test_input_transcription_shapes_normalize_to_public_user_transcript(
    input_transcription: object,
    expected_text: str,
) -> None:
    mapper = GeminiLiveEventMapper(session_id="sess-gemini-input-shape")
    events = mapper.map_event(
        {
            "eventId": "user-item-shape-1",
            "serverContent": {"inputTranscription": input_transcription},
        }
    )

    assert [event.type for event in events] == [ProviderEventType.USER_TRANSCRIPT_FINAL]
    assert _payloads(events) == [
        {
            "type": "sophia.user_transcript",
            "data": {"text": expected_text, "utterance_id": "user-item-shape-1"},
        },
        {"type": "sophia.turn", "data": {"phase": "user_ended"}},
    ]


def test_tool_call_cancellation_maps_to_interruption_diagnostic() -> None:
    mapper = GeminiLiveEventMapper()
    provider_events = []
    provider_events.extend(
        mapper.map_event(
            {
                "serverContent": {
                    "modelTurn": {
                        "parts": [
                            {"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": "AAE="}}
                        ]
                    }
                }
            }
        )
    )
    provider_events.extend(
        mapper.map_event({"toolCallCancellation": {"ids": ["artifact-call-1"]}})
    )

    assert provider_events[-1].type == ProviderEventType.RESPONSE_INTERRUPTED
    assert provider_events[-1].data["cancelled_tool_call_ids"] == ["artifact-call-1"]
    payloads = _payloads(provider_events)

    assert payloads[0] == {"type": "sophia.turn", "data": {"phase": "agent_started"}}
    assert payloads[1]["type"] == "sophia.turn"
    assert payloads[1]["data"] == {"phase": "agent_ended", "reason": "interrupted"}
    assert payloads[2]["type"] == "sophia.turn_diagnostic"
    assert payloads[2]["data"]["provider"] == GEMINI_LIVE_PROVIDER_NAME
    assert payloads[2]["data"]["reason"] == "interrupted"


def test_mapper_uses_one_assistant_transcript_surface_per_response() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    events.extend(
        mapper.map_event(
            {"serverContent": {"modelTurn": {"parts": [{"text": "Model text. "}]}}}
        )
    )
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Duplicate audio transcript. "}}}
        )
    )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    assert [event.type for event in events] == [
        ProviderEventType.RESPONSE_STARTED,
        ProviderEventType.ASSISTANT_TEXT_DELTA,
        ProviderEventType.ASSISTANT_TEXT_FINAL,
        ProviderEventType.RESPONSE_ENDED,
    ]
    assert _payloads(events) == [
        {"type": "sophia.turn", "data": {"phase": "agent_started"}},
        {
            "type": "sophia.transcript",
            "data": {
                "text": "Model text. ",
                "is_final": False,
            },
        },
        {
            "type": "sophia.transcript",
            "data": {
                "text": "Model text. ",
                "is_final": True,
            },
        },
        {"type": "sophia.turn", "data": {"phase": "agent_ended"}},
    ]


def test_output_transcription_fragments_join_with_safe_spacing() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Yeah, I hear you."}}}
        )
    )
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "What's good?"}}}
        )
    )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    transcripts = [
        payload["data"]["text"]
        for payload in _payloads(events)
        if payload["type"] == "sophia.transcript"
    ]

    assert transcripts == [
        "Yeah, I hear you.",
        "Yeah, I hear you. What's good?",
        "Yeah, I hear you. What's good?",
    ]
    assert all("hearYeah" not in text for text in transcripts)
    assert all("you.What's" not in text for text in transcripts)


def test_output_transcription_cumulative_snapshots_do_not_duplicate() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    for text in [
        "Yeah, I hear",
        "Yeah, I hear you.",
        "Yeah, I can hear you fine.",
    ]:
        events.extend(
            mapper.map_event({"serverContent": {"outputTranscription": {"text": text}}})
        )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    transcripts = [
        payload["data"]["text"]
        for payload in _payloads(events)
        if payload["type"] == "sophia.transcript"
    ]

    assert transcripts == [
        "Yeah, I hear",
        "Yeah, I hear you.",
        "Yeah, I can hear you fine.",
        "Yeah, I can hear you fine.",
    ]
    assert all("hearYeah" not in text for text in transcripts)


def test_output_transcription_revised_snapshot_replaces_prior_partial() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Yeah, I hear you."}}}
        )
    )
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Yeah, I can hear you fine."}}}
        )
    )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    transcripts = [
        payload["data"]["text"]
        for payload in _payloads(events)
        if payload["type"] == "sophia.transcript"
    ]

    assert transcripts == [
        "Yeah, I hear you.",
        "Yeah, I can hear you fine.",
        "Yeah, I can hear you fine.",
    ]


def test_output_transcription_revised_snapshot_can_change_opening_phrase() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Yeah, I hear you."}}}
        )
    )
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "I can hear you fine."}}}
        )
    )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    transcripts = [
        payload["data"]["text"]
        for payload in _payloads(events)
        if payload["type"] == "sophia.transcript"
    ]

    assert transcripts == [
        "Yeah, I hear you.",
        "I can hear you fine.",
        "I can hear you fine.",
    ]


def test_tool_call_continuation_uses_new_transcript_segment() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Let me check that."}}}
        )
    )
    events.extend(
        mapper.map_event(
            {
                "toolCall": {
                    "functionCalls": [
                        {
                            "id": "lookup-call-1",
                            "name": "lookup_context",
                            "args": {"query": "today"},
                        }
                    ]
                }
            }
        )
    )
    events.extend(
        mapper.map_event(
            {"serverContent": {"outputTranscription": {"text": "Here's what I found."}}}
        )
    )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    transcript_payloads = [
        payload["data"]
        for payload in _payloads(events)
        if payload["type"] == "sophia.transcript"
    ]

    assert transcript_payloads == [
        {"text": "Let me check that.", "is_final": False},
        {"text": "Here's what I found.", "is_final": False},
        {"text": "Here's what I found.", "is_final": True},
    ]


def test_interruption_resets_output_transcription_buffer() -> None:
    mapper = GeminiLiveEventMapper()
    events = []
    events.extend(
        mapper.map_event({"serverContent": {"outputTranscription": {"text": "I can hear"}}})
    )
    events.extend(mapper.map_event({"serverContent": {"interrupted": True}}))
    events.extend(
        mapper.map_event({"serverContent": {"outputTranscription": {"text": "Yes, I'm here."}}})
    )
    events.extend(mapper.map_event({"serverContent": {"generationComplete": True}}))

    transcripts = [
        payload["data"]["text"]
        for payload in _payloads(events)
        if payload["type"] == "sophia.transcript"
    ]

    assert transcripts == ["I can hear", "Yes, I'm here.", "Yes, I'm here."]
    assert all("I can hear Yes" not in text for text in transcripts)


@pytest.mark.parametrize(
    "raw_event",
    [
        {
            "serverContent": {
                "outputTranscription": {
                    "text": "try{emit_artifact{active_goal:Wait for completion",
                }
            }
        },
        {
            "serverContent": {
                "modelTurn": {
                    "parts": [{"text": "emit_artifact({\"active_goal\":\"Wait\"})"}]
                }
            }
        },
    ],
)
def test_mapper_filters_pseudo_tool_syntax_from_assistant_transcripts(raw_event: dict[str, Any]) -> None:
    mapper = GeminiLiveEventMapper()

    events = mapper.map_event(raw_event)
    payloads = _payloads(events)

    assert ProviderEventType.ASSISTANT_TEXT_DELTA not in [event.type for event in events]
    assert any(
        event.type == ProviderEventType.PROVIDER_METRIC
        and event.data["tool_syntax_filtered"] is True
        for event in events
    )
    assert not any(payload["type"] == "sophia.transcript" for payload in payloads)
    assert "try{emit_artifact" not in json.dumps(payloads)
    assert "active_goal" not in json.dumps(payloads)


@pytest.mark.anyio
async def test_session_methods_emit_documented_gemini_client_message_shapes() -> None:
    sent_events: list[dict[str, Any]] = []

    async def sender(event: dict[str, Any]) -> None:
        sent_events.append(event)

    session = GeminiLiveProviderSession(
        [
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
            }
        ],
        sender=sender,
        feature_enabled=True,
    )
    config = build_gemini_live_setup_config(
        instructions="Speak as Sophia.",
        tools=[{"functionDeclarations": [{"name": "emit_artifact"}]}],
    )

    await session.configure(config)
    await session.send_audio(b"\x00\x01")
    await session.send_text("hello")
    _ = [provider_event async for provider_event in session.events()]
    await session.send_tool_result("artifact-call-1", {"ok": True})
    await session.cancel_response("barge_in")

    assert sent_events == session.sent_events
    assert [next(iter(event)) for event in sent_events] == [
        "setup",
        "realtimeInput",
        "realtimeInput",
        "toolResponse",
        "realtimeInput",
    ]
    assert sent_events[0]["setup"] == config
    assert sent_events[0]["setup"]["model"] == f"models/{DEFAULT_GEMINI_LIVE_MODEL}"
    assert sent_events[0]["setup"]["inputAudioTranscription"] == {}
    assert sent_events[0]["setup"]["outputAudioTranscription"] == {}
    assert (
        sent_events[1]["realtimeInput"]["audio"]["data"]
        == base64.b64encode(b"\x00\x01").decode("ascii")
    )
    assert sent_events[1]["realtimeInput"]["audio"]["mimeType"] == "audio/pcm;rate=16000"
    assert sent_events[2] == {"realtimeInput": {"text": "hello"}}
    assert sent_events[3] == {
        "toolResponse": {
            "functionResponses": [
                {
                    "id": "artifact-call-1",
                    "name": "emit_artifact",
                    "response": {"ok": True},
                }
            ]
        }
    }
    assert sent_events[4] == {"realtimeInput": {"activityStart": {}}}


@pytest.mark.anyio
async def test_configure_only_sends_initial_setup_once() -> None:
    session = GeminiLiveProviderSession(feature_enabled=True)
    await session.configure(build_gemini_live_setup_config())

    with pytest.raises(RuntimeError, match="setup can only be sent once"):
        await session.configure(build_gemini_live_setup_config())