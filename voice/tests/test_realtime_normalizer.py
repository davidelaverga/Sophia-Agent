from __future__ import annotations

from typing import Any

import pytest

from voice.realtime import (
    DeliveryIntent,
    ProviderCapabilities,
    ProviderEvent,
    ProviderEventType,
    SophiaEventNormalizer,
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


def _event(
    event_type: ProviderEventType,
    data: dict[str, Any] | None = None,
    *,
    provider: str = "fixture-provider",
    response_id: str | None = "response-1",
    turn_id: str | None = "turn-1",
) -> ProviderEvent:
    return ProviderEvent(
        event_type,
        data or {},
        provider=provider,
        response_id=response_id,
        turn_id=turn_id,
    )


def _payloads(events: list[ProviderEvent]) -> list[dict[str, Any]]:
    return [event.as_payload() for event in SophiaEventNormalizer().normalize_events(events)]


def _assert_public_envelope_shape(payloads: list[dict[str, Any]]) -> None:
    assert payloads
    for payload in payloads:
        assert set(payload) == {"type", "data"}
        assert isinstance(payload["type"], str)
        assert payload["type"].startswith("sophia.")
        assert isinstance(payload["data"], dict)


def _assert_turn_contract(payloads: list[dict[str, Any]], *, utterance_id: str) -> None:
    _assert_public_envelope_shape(payloads)

    assert payloads[0] == {
        "type": "sophia.user_transcript",
        "data": {"text": "I had a rough day.", "utterance_id": utterance_id},
    }
    assert {payload["type"] for payload in payloads}.issubset(
        {
            "sophia.user_transcript",
            "sophia.turn",
            "sophia.transcript",
            "sophia.artifact",
            "sophia.builder_task",
            "sophia.turn_diagnostic",
        }
    )

    turn_phases = [
        payload["data"].get("phase")
        for payload in payloads
        if payload["type"] == "sophia.turn"
    ]
    assert "user_ended" in turn_phases
    assert "agent_started" in turn_phases
    assert "agent_ended" in turn_phases

    final_transcripts = [
        payload
        for payload in payloads
        if payload["type"] == "sophia.transcript"
        and payload["data"].get("is_final") is True
    ]
    assert len(final_transcripts) == 1
    assert isinstance(final_transcripts[0]["data"].get("text"), str)
    assert final_transcripts[0]["data"]["text"]

    artifacts = [payload for payload in payloads if payload["type"] == "sophia.artifact"]
    assert len(artifacts) == 1
    assert artifacts[0]["data"] == _artifact()


def test_capabilities_and_delivery_intent_are_provider_neutral() -> None:
    capabilities = ProviderCapabilities(
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
    )
    delivery = DeliveryIntent(
        tone="supportive",
        family="warm",
        intensity=1.4,
        pace="gentle",
        warmth=0.8,
        restraint=-0.2,
    ).clamped()

    assert capabilities.supports_transcripts is True
    assert capabilities.speech_delivery_control == "instructions"
    assert delivery.intensity == 1.0
    assert delivery.restraint == 0.0
    assert delivery.provider_hints == {}


def test_legacy_cascade_shaped_turn_normalizes_to_public_sophia_events() -> None:
    payloads = _payloads(
        [
            ProviderEvent.user_transcript_final(
                "I had a rough day.",
                utterance_id="legacy-utt-1",
            ),
            _event(
                ProviderEventType.RESPONSE_STARTED,
                provider="legacy-cascade",
                response_id="legacy-response-1",
            ),
            ProviderEvent.assistant_text_delta("I hear you. "),
            ProviderEvent.assistant_text_delta("Let's slow it down together."),
            ProviderEvent.assistant_text_final(),
            ProviderEvent.artifact_payload(_artifact()),
            _event(
                ProviderEventType.RESPONSE_ENDED,
                provider="legacy-cascade",
                response_id="legacy-response-1",
            ),
        ]
    )

    _assert_turn_contract(payloads, utterance_id="legacy-utt-1")
    assert [payload["type"] for payload in payloads] == [
        "sophia.user_transcript",
        "sophia.turn",
        "sophia.turn",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.transcript",
        "sophia.artifact",
        "sophia.turn",
    ]
    assert payloads[3]["data"] == {"text": "I hear you. ", "is_final": False}
    assert payloads[4]["data"] == {
        "text": "I hear you. Let's slow it down together.",
        "is_final": False,
    }
    assert payloads[5]["data"] == {
        "text": "I hear you. Let's slow it down together.",
        "is_final": True,
    }


def test_user_transcript_public_event_preserves_provider_source_metadata() -> None:
    payloads = _payloads(
        [
            _event(
                ProviderEventType.USER_TRANSCRIPT_FINAL,
                {
                    "text": "Quick question before I go.",
                    "utterance_id": "gemini-utt-7",
                    "source_sequence": 17,
                    "provider_relay_sequence": 12,
                    "provider_received_at": "2026-05-20T12:00:01.000Z",
                    "relay_correlation_id": "relay-17",
                },
            )
        ]
    )

    assert payloads[0] == {
        "type": "sophia.user_transcript",
        "data": {
            "text": "Quick question before I go.",
            "utterance_id": "gemini-utt-7",
            "source_sequence": 17,
            "provider_relay_sequence": 12,
            "provider_received_at": "2026-05-20T12:00:01.000Z",
            "relay_correlation_id": "relay-17",
        },
    }
    assert payloads[1] == {"type": "sophia.turn", "data": {"phase": "user_ended"}}


def test_assistant_transcript_public_event_preserves_source_response_segment_metadata() -> None:
    payloads = _payloads(
        [
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Please call emergency services now.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                    "source_sequence": 42,
                    "provider_received_at": "2026-05-20T12:00:01.000Z",
                    "relay_correlation_id": "relay-42",
                    "assistant_transcript_source": "provider_output_transcription",
                    "assistant_transcript_approximate": True,
                },
                provider="google-gemini-live",
                response_id="gemini-response-42",
            )
        ]
    )

    assert payloads == [
        {
            "type": "sophia.transcript",
            "data": {
                "text": "Please call emergency services now.",
                "is_final": False,
                "response_id": "gemini-response-42",
                "segment_id": "gemini-segment-0",
                "source_sequence": 42,
                "provider_received_at": "2026-05-20T12:00:01.000Z",
                "relay_correlation_id": "relay-42",
                "assistant_transcript_source": "provider_output_transcription",
                "assistant_transcript_approximate": True,
            },
        }
    ]


def test_gemini_internal_thought_transcript_is_suppressed_from_public_assistant_text() -> None:
    payloads = _payloads(
        [
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Thought: The user confirmed their name is Luis. I need to acknowledge that.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                    "source_sequence": 51,
                },
                provider="google-gemini-live",
                response_id="gemini-response-internal-1",
            )
        ]
    )

    assert [payload["type"] for payload in payloads] == ["sophia.turn_diagnostic"]
    assert payloads[0]["data"]["reason"] == "gemini_internal_output_suppressed"
    assert payloads[0]["data"]["matched_marker"] == "thought_label"
    assert "Thought:" not in str(payloads)


def test_gemini_emit_artifact_correction_transcript_is_suppressed_from_public_assistant_text() -> None:
    payloads = _payloads(
        [
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Emit Artifact Correction attempt: reflection must be a string.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                    "source_sequence": 52,
                },
                provider="google-gemini-live",
                response_id="gemini-response-internal-2",
            )
        ]
    )

    assert [payload["type"] for payload in payloads] == ["sophia.turn_diagnostic"]
    assert payloads[0]["data"]["reason"] == "gemini_internal_output_suppressed"
    assert payloads[0]["data"]["matched_marker"] == "emit_artifact_correction"
    assert "Emit Artifact Correction attempt" not in str(payloads)


@pytest.mark.parametrize(
    ("text", "matched_marker"),
    [
        ("emit_artifact{", "emit_artifact_tool_syntax"),
        ("read_artifact_text", "read_artifact_text"),
        ("active_goal: Wait for completion", "active_goal"),
        ("tool_call_id", "tool_call_id"),
        ("schema", "schema_word"),
    ],
)
def test_gemini_tool_schema_like_transcript_is_suppressed_from_public_assistant_text(
    text: str,
    matched_marker: str,
) -> None:
    payloads = _payloads(
        [
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": text,
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                    "source_sequence": 53,
                },
                provider="google-gemini-live",
                response_id="gemini-response-internal-markers",
            )
        ]
    )

    assert [payload["type"] for payload in payloads] == ["sophia.turn_diagnostic"]
    assert payloads[0]["data"]["reason"] == "gemini_internal_output_suppressed"
    assert payloads[0]["data"]["matched_marker"] == matched_marker
    assert "text" not in payloads[0]["data"]
    assert not any(payload["type"] == "sophia.transcript" for payload in payloads)


def test_normal_gemini_assistant_text_still_emits_public_transcript() -> None:
    payloads = _payloads(
        [
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Luis, always good to get that right.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                    "source_sequence": 53,
                },
                provider="google-gemini-live",
                response_id="gemini-response-normal-1",
            )
        ]
    )

    assert payloads == [
        {
            "type": "sophia.transcript",
            "data": {
                "text": "Luis, always good to get that right.",
                "is_final": False,
                "response_id": "gemini-response-normal-1",
                "segment_id": "gemini-segment-0",
                "source_sequence": 53,
            },
        }
    ]


def test_openai_style_realtime_fixture_normalizes_without_leaking_provider_names() -> None:
    payloads = _payloads(
        [
            ProviderEvent.user_transcript_partial("I had a rough"),
            ProviderEvent.user_transcript_final(
                "I had a rough day.",
                utterance_id="openai-utt-1",
            ),
            _event(
                ProviderEventType.RESPONSE_STARTED,
                {"provider_event_name": "response.created"},
                provider="openai-realtime-fixture",
                response_id="openai-response-1",
            ),
            ProviderEvent.assistant_text_delta("That sounds heavy. "),
            _event(
                ProviderEventType.TOOL_CALL_REQUESTED,
                {"name": "emit_artifact", "arguments": _artifact()},
                provider="openai-realtime-fixture",
                response_id="openai-response-1",
            ),
            _event(
                ProviderEventType.ARTIFACT_CANDIDATE,
                {"artifact": _artifact(takeaway="candidate only")},
                provider="openai-realtime-fixture",
                response_id="openai-response-1",
            ),
            ProviderEvent.assistant_text_delta("I'm here with you."),
            ProviderEvent.assistant_text_final(),
            ProviderEvent.artifact_payload(_artifact()),
            _event(
                ProviderEventType.BUILDER_TASK_PAYLOAD,
                {
                    "builder_task": {
                        "type": "task_started",
                        "task_id": "builder-openai-1",
                        "description": "Draft the grounding note.",
                    }
                },
                provider="openai-realtime-fixture",
                response_id="openai-response-1",
            ),
            _event(
                ProviderEventType.RESPONSE_ENDED,
                {"provider_event_name": "response.done"},
                provider="openai-realtime-fixture",
                response_id="openai-response-1",
            ),
        ]
    )

    _assert_turn_contract(payloads, utterance_id="openai-utt-1")
    assert all("response." not in payload["type"] for payload in payloads)
    assert [payload["type"] for payload in payloads].count("sophia.builder_task") == 1
    assert payloads[-2] == {
        "type": "sophia.builder_task",
        "data": {
            "type": "task_started",
            "task_id": "builder-openai-1",
            "description": "Draft the grounding note.",
        },
    }


def test_gemini_style_realtime_fixture_can_use_audio_lifecycle_for_turns() -> None:
    payloads = _payloads(
        [
            ProviderEvent.user_transcript_final(
                "I had a rough day.",
                utterance_id="gemini-utt-1",
            ),
            _event(
                ProviderEventType.ASSISTANT_AUDIO_STARTED,
                {"provider_event_name": "audio.started"},
                provider="gemini-live-fixture",
                response_id="gemini-response-1",
            ),
            ProviderEvent.assistant_text_delta(
                "You're not alone in this.",
                is_delta=False,
            ),
            ProviderEvent.assistant_text_final("You're not alone in this."),
            ProviderEvent.artifact_payload(_artifact()),
            _event(
                ProviderEventType.ASSISTANT_AUDIO_ENDED,
                {"provider_event_name": "audio.ended"},
                provider="gemini-live-fixture",
                response_id="gemini-response-1",
            ),
        ]
    )

    _assert_turn_contract(payloads, utterance_id="gemini-utt-1")
    assert [
        payload["data"].get("phase")
        for payload in payloads
        if payload["type"] == "sophia.turn"
    ] == ["user_ended", "agent_started", "agent_ended"]


def test_normalizer_rejects_higher_sequence_transcript_after_interruption() -> None:
    normalizer = SophiaEventNormalizer()
    payloads = [
        event.as_payload()
        for event in normalizer.normalize_events(
            [
                _event(
                    ProviderEventType.RESPONSE_STARTED,
                    response_id="gemini-response-stale",
                ),
                _event(
                    ProviderEventType.ASSISTANT_TEXT_DELTA,
                    {
                        "text": "Done and ready.",
                        "is_delta": False,
                        "transcript_assembly": "auto",
                        "segment_id": "gemini-segment-0",
                        "source_sequence": 20,
                    },
                    provider="google-gemini-live",
                    response_id="gemini-response-stale",
                ),
                _event(
                    ProviderEventType.RESPONSE_INTERRUPTED,
                    {"source_sequence": 21},
                    provider="google-gemini-live",
                    response_id="gemini-response-stale",
                ),
                _event(
                    ProviderEventType.ASSISTANT_TEXT_DELTA,
                    {
                        "text": "Done and ready. Old tail should not return.",
                        "is_delta": False,
                        "transcript_assembly": "auto",
                        "segment_id": "gemini-segment-0",
                        "source_sequence": 22,
                    },
                    provider="google-gemini-live",
                    response_id="gemini-response-stale",
                ),
            ]
        )
    ]

    transcripts = [payload for payload in payloads if payload["type"] == "sophia.transcript"]
    diagnostics = [payload for payload in payloads if payload["type"] == "sophia.turn_diagnostic"]

    assert [payload["data"]["text"] for payload in transcripts] == ["Done and ready."]
    assert diagnostics[-1]["data"]["reason"] == "transcript_response_interrupted_rejected"
    assert "Old tail" not in str(transcripts)


def test_normalizer_closes_active_response_when_user_barges_in_with_spanish_turn() -> None:
    normalizer = SophiaEventNormalizer()
    payloads = [
        event.as_payload()
        for event in normalizer.normalize_events(
            [
                _event(
                    ProviderEventType.RESPONSE_STARTED,
                    provider="google-gemini-live",
                    response_id="gemini-response-before-spanish",
                ),
                _event(
                    ProviderEventType.ASSISTANT_TEXT_DELTA,
                    {
                        "text": "Done and ready.",
                        "is_delta": False,
                        "transcript_assembly": "auto",
                        "segment_id": "gemini-segment-0",
                        "source_sequence": 30,
                    },
                    provider="google-gemini-live",
                    response_id="gemini-response-before-spanish",
                ),
                _event(
                    ProviderEventType.USER_TRANSCRIPT_FINAL,
                    {
                        "text": "¿Puedes responder en español?",
                        "utterance_id": "spanish-utt-1",
                        "source_sequence": 31,
                    },
                    provider="google-gemini-live",
                    response_id=None,
                    turn_id=None,
                ),
                _event(
                    ProviderEventType.ASSISTANT_TEXT_DELTA,
                    {
                        "text": "Done and ready. This stale continuation must stay hidden.",
                        "is_delta": False,
                        "transcript_assembly": "auto",
                        "segment_id": "gemini-segment-0",
                        "source_sequence": 32,
                    },
                    provider="google-gemini-live",
                    response_id="gemini-response-before-spanish",
                ),
                _event(
                    ProviderEventType.RESPONSE_STARTED,
                    provider="google-gemini-live",
                    response_id="gemini-response-spanish-answer",
                ),
                _event(
                    ProviderEventType.ASSISTANT_TEXT_DELTA,
                    {
                        "text": "Sí, puedo responder en español.",
                        "is_delta": False,
                        "transcript_assembly": "auto",
                        "segment_id": "gemini-segment-0",
                        "source_sequence": 33,
                    },
                    provider="google-gemini-live",
                    response_id="gemini-response-spanish-answer",
                ),
            ]
        )
    ]

    turns = [payload["data"] for payload in payloads if payload["type"] == "sophia.turn"]
    transcripts = [payload["data"]["text"] for payload in payloads if payload["type"] == "sophia.transcript"]
    diagnostics = [payload["data"] for payload in payloads if payload["type"] == "sophia.turn_diagnostic"]

    assert {payload["data"]["text"] for payload in payloads if payload["type"] == "sophia.user_transcript"} == {
        "¿Puedes responder en español?"
    }
    assert {turn.get("reason") for turn in turns} >= {"interrupted_by_user_input"}
    assert transcripts == ["Done and ready.", "Sí, puedo responder en español."]
    assert diagnostics[-1]["reason"] == "transcript_response_interrupted_rejected"
    assert "stale continuation" not in str(transcripts)


def test_normalizer_allows_non_stale_transcript_after_interruption_on_new_response() -> None:
    normalizer = SophiaEventNormalizer()
    payloads = [
        event.as_payload()
        for event in normalizer.normalize_events(
            [
                _event(ProviderEventType.RESPONSE_STARTED, response_id="old-response"),
                _event(
                    ProviderEventType.RESPONSE_INTERRUPTED,
                    {"source_sequence": 40},
                    response_id="old-response",
                ),
                _event(ProviderEventType.RESPONSE_STARTED, response_id="new-response"),
                _event(
                    ProviderEventType.ASSISTANT_TEXT_DELTA,
                    {
                        "text": "Fresh answer.",
                        "is_delta": False,
                        "transcript_assembly": "auto",
                        "segment_id": "gemini-segment-0",
                        "source_sequence": 41,
                    },
                    response_id="new-response",
                ),
            ]
        )
    ]

    assert [payload["data"]["text"] for payload in payloads if payload["type"] == "sophia.transcript"] == [
        "Fresh answer."
    ]


    def test_normalizer_rejects_stale_assistant_transcript_snapshot_for_same_segment() -> None:
        normalizer = SophiaEventNormalizer()

        newer = _event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {
                "text": "You ready to lock in before your game?",
                "is_delta": False,
                "transcript_assembly": "auto",
                "segment_id": "gemini-segment-0",
                "source_sequence": 12,
            },
            provider="google-gemini-live",
            response_id="gemini-response-1",
        )
        stale = _event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {
                "text": "to lock",
                "is_delta": False,
                "transcript_assembly": "auto",
                "segment_id": "gemini-segment-0",
                "source_sequence": 11,
            },
            provider="google-gemini-live",
            response_id="gemini-response-1",
        )

        newer_payloads = [event.as_payload() for event in normalizer.normalize_events([newer])]
        stale_payloads = [event.as_payload() for event in normalizer.normalize_events([stale])]

        assert newer_payloads == [
            {
                "type": "sophia.transcript",
                "data": {
                    "text": "You ready to lock in before your game?",
                    "is_final": False,
                    "response_id": "gemini-response-1",
                    "segment_id": "gemini-segment-0",
                    "source_sequence": 12,
                },
            }
        ]
        assert stale_payloads[0]["type"] == "sophia.turn_diagnostic"
        assert stale_payloads[0]["data"]["reason"] == "transcript_sequence_stale_rejected"
        assert "to lock You ready" not in str(stale_payloads)


    def test_normalizer_rejects_late_transcript_after_interruption_boundary() -> None:
        normalizer = SophiaEventNormalizer()
        accepted = _event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {
                "text": "I can't tell you that. It has to come from you.",
                "is_delta": False,
                "transcript_assembly": "auto",
                "segment_id": "gemini-segment-0",
                "source_sequence": 20,
            },
            provider="google-gemini-live",
            response_id="gemini-response-2",
        )
        interrupted = _event(
            ProviderEventType.RESPONSE_INTERRUPTED,
            {"source_sequence": 21},
            provider="google-gemini-live",
            response_id="gemini-response-2",
        )
        late_old = _event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {
                "text": "tell I can't It has you that.",
                "is_delta": False,
                "transcript_assembly": "auto",
                "segment_id": "gemini-segment-0",
                "source_sequence": 19,
            },
            provider="google-gemini-live",
            response_id="gemini-response-2",
        )

        payloads = [
            event.as_payload()
            for event in normalizer.normalize_events([accepted, interrupted, late_old])
        ]

        assert [payload["type"] for payload in payloads].count("sophia.transcript") == 1
        assert payloads[-1]["type"] == "sophia.turn_diagnostic"
        assert payloads[-1]["data"]["reason"] == "transcript_sequence_stale_rejected"
        assert "tell I can't It has you that" not in [
            payload["data"].get("text") for payload in payloads if payload["type"] == "sophia.transcript"
        ]


def test_auto_transcript_assembly_replaces_cumulative_revisions() -> None:
    payloads = _payloads(
        [
            _event(ProviderEventType.RESPONSE_STARTED, response_id="auto-response-1"),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Yeah, I hear",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                },
                response_id="auto-response-1",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Yeah, I hear you.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                },
                response_id="auto-response-1",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Yeah, I can hear you fine.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                },
                response_id="auto-response-1",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_FINAL,
                {"segment_id": "gemini-segment-0"},
                response_id="auto-response-1",
            ),
        ]
    )

    transcripts = [
        payload["data"]["text"]
        for payload in payloads
        if payload["type"] == "sophia.transcript"
    ]
    assert transcripts == [
        "Yeah, I hear",
        "Yeah, I hear you.",
        "Yeah, I can hear you fine.",
        "Yeah, I can hear you fine.",
    ]
    assert all("hearYeah" not in text for text in transcripts)


def test_auto_transcript_assembly_replaces_revisions_with_changed_opening() -> None:
    payloads = _payloads(
        [
            _event(ProviderEventType.RESPONSE_STARTED, response_id="auto-response-2"),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Yeah, I hear you.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                },
                response_id="auto-response-2",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "I can hear you fine.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                },
                response_id="auto-response-2",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_FINAL,
                {"segment_id": "gemini-segment-0"},
                response_id="auto-response-2",
            ),
        ]
    )

    transcripts = [
        payload["data"]["text"]
        for payload in payloads
        if payload["type"] == "sophia.transcript"
    ]
    assert transcripts == [
        "Yeah, I hear you.",
        "I can hear you fine.",
        "I can hear you fine.",
    ]


def test_auto_transcript_assembly_respects_segment_boundaries() -> None:
    payloads = _payloads(
        [
            _event(ProviderEventType.RESPONSE_STARTED, response_id="tool-response-1"),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Let me check that.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-0",
                },
                response_id="tool-response-1",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_DELTA,
                {
                    "text": "Here's what I found.",
                    "is_delta": False,
                    "transcript_assembly": "auto",
                    "segment_id": "gemini-segment-1",
                },
                response_id="tool-response-1",
            ),
            _event(
                ProviderEventType.ASSISTANT_TEXT_FINAL,
                {"segment_id": "gemini-segment-1"},
                response_id="tool-response-1",
            ),
        ]
    )

    transcripts = [
        payload["data"]
        for payload in payloads
        if payload["type"] == "sophia.transcript"
    ]
    assert transcripts == [
        {"text": "Let me check that.", "is_final": False},
        {"text": "Here's what I found.", "is_final": False},
        {"text": "Here's what I found.", "is_final": True},
    ]


def test_interruption_clears_auto_transcript_buffer_for_response() -> None:
    normalizer = SophiaEventNormalizer()
    events = [
        _event(ProviderEventType.RESPONSE_STARTED, response_id="interrupt-response-1"),
        _event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {
                "text": "I can hear",
                "is_delta": False,
                "transcript_assembly": "auto",
                "segment_id": "gemini-segment-0",
            },
            response_id="interrupt-response-1",
        ),
        _event(ProviderEventType.RESPONSE_INTERRUPTED, response_id="interrupt-response-1"),
        _event(ProviderEventType.RESPONSE_STARTED, response_id="interrupt-response-1"),
        _event(
            ProviderEventType.ASSISTANT_TEXT_DELTA,
            {
                "text": "Yes, I'm here.",
                "is_delta": False,
                "transcript_assembly": "auto",
                "segment_id": "gemini-segment-0",
            },
            response_id="interrupt-response-1",
        ),
    ]
    payloads = [payload.as_payload() for event in events for payload in normalizer.normalize_event(event)]

    transcripts = [
        payload["data"]["text"]
        for payload in payloads
        if payload["type"] == "sophia.transcript"
    ]
    assert transcripts == ["I can hear", "Yes, I'm here."]


def test_artifact_payloads_can_pass_through_the_sophia_validator_hook() -> None:
    def validator(artifact: dict[str, Any]) -> dict[str, Any]:
        return {**artifact, "validated": True}

    normalizer = SophiaEventNormalizer(artifact_validator=validator)
    payloads = [
        event.as_payload()
        for event in normalizer.normalize_events([ProviderEvent.artifact_payload(_artifact())])
    ]

    assert payloads == [
        {
            "type": "sophia.artifact",
            "data": {**_artifact(), "validated": True},
        }
    ]


def test_interruption_maps_to_agent_end_and_turn_diagnostic() -> None:
    payloads = _payloads(
        [
            _event(ProviderEventType.RESPONSE_STARTED, response_id="cancel-response-1"),
            _event(
                ProviderEventType.RESPONSE_INTERRUPTED,
                {"reason": "barge_in"},
                response_id="cancel-response-1",
                turn_id="cancel-turn-1",
            ),
            _event(ProviderEventType.RESPONSE_ENDED, response_id="cancel-response-1"),
        ]
    )

    assert payloads == [
        {"type": "sophia.turn", "data": {"phase": "agent_started"}},
        {
            "type": "sophia.turn",
            "data": {"phase": "agent_ended", "reason": "interrupted"},
        },
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "turn_id": "cancel-turn-1",
                "status": "failed",
                "reason": "interrupted",
                "provider": "fixture-provider",
                "response_id": "cancel-response-1",
                "interrupted": True,
            },
        },
    ]
    _assert_public_envelope_shape(payloads)


def test_provider_error_maps_to_public_diagnostic_without_raw_event_leakage() -> None:
    payloads = _payloads(
        [
            _event(ProviderEventType.RESPONSE_STARTED, response_id="error-response-1"),
            ProviderEvent.provider_error(
                "Provider socket closed.",
                stage="provider-stream",
                recoverable=False,
                provider_event_name="error",
            ),
        ]
    )

    assert payloads == [
        {"type": "sophia.turn", "data": {"phase": "agent_started"}},
        {
            "type": "sophia.turn",
            "data": {"phase": "agent_ended", "reason": "provider_error"},
        },
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "turn_id": "error-response-1",
                "status": "failed",
                "reason": "provider_error",
                "provider": None,
                "response_id": "error-response-1",
                "stage": "provider-stream",
                "message": "Provider socket closed.",
                "recoverable": False,
            },
        },
    ]
    assert all(payload["type"].startswith("sophia.") for payload in payloads)
