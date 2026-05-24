from __future__ import annotations

from voice.realtime import SophiaEvent, summarize_dogfood_events


def _artifact() -> dict[str, object]:
    return {
        "session_goal": "Compare realtime providers.",
        "active_goal": "Keep the dogfood run repeatable.",
        "next_step": "Run the next scenario.",
        "takeaway": "The provider produced a complete turn.",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "free_conversation.test",
        "voice_emotion_primary": "calm",
        "voice_emotion_secondary": "sympathetic",
        "voice_speed": "gentle",
    }


def test_summarizes_complete_normalized_dogfood_evidence() -> None:
    summary = summarize_dogfood_events(
        [
            {"type": "sophia.user_transcript", "data": {"text": "hello", "utterance_id": "utt-1"}, "timestamp": 1.0},
            {"type": "sophia.turn", "data": {"phase": "user_ended"}, "timestamp": 1.1},
            {"type": "sophia.turn", "data": {"phase": "agent_started"}, "timestamp": 1.4},
            {"type": "sophia.transcript", "data": {"text": "Hi.", "is_final": False}, "timestamp": 1.5},
            {"type": "sophia.transcript", "data": {"text": "Hi.", "is_final": True}, "timestamp": 1.7},
            {"type": "sophia.artifact", "data": _artifact(), "timestamp": 1.8},
            {"type": "sophia.turn", "data": {"phase": "agent_ended"}, "timestamp": 1.9},
        ],
        session_id="browser-openai-1",
        provider="openai-gpt-realtime-2",
        transport="openai_browser_webrtc_with_server_sideband",
    )

    assert summary.evidence_status == "complete"
    assert summary.session_id == "browser-openai-1"
    assert summary.normalized_event_count == 7
    assert summary.event_counts == {
        "sophia.artifact": 1,
        "sophia.transcript": 2,
        "sophia.turn": 3,
        "sophia.user_transcript": 1,
    }
    assert summary.first_event_type == "sophia.user_transcript"
    assert summary.last_event_type == "sophia.turn"
    assert summary.first_event_at == 1.0
    assert summary.last_event_at == 1.9
    assert summary.first_event_at_by_type["sophia.turn"] == 1.1
    assert summary.has_user_transcript is True
    assert summary.has_agent_started is True
    assert summary.has_agent_ended is True
    assert summary.has_final_transcript is True
    assert summary.has_artifact is True
    assert summary.missing_required_events == ()
    assert summary.as_dict()["evidence_status"] == "complete"


def test_flags_missing_events_interruptions_and_provider_errors() -> None:
    summary = summarize_dogfood_events(
        [
            SophiaEvent("sophia.turn", {"phase": "agent_started"}),
            SophiaEvent("sophia.turn", {"phase": "agent_ended", "reason": "interrupted"}),
            SophiaEvent(
                "sophia.turn_diagnostic",
                {
                    "status": "failed",
                    "reason": "provider_error",
                    "stage": "gemini-live",
                    "message": "socket closed",
                },
            ),
        ],
        provider="google-gemini-live",
        transport="gemini_browser_websocket_ephemeral_token_with_backend_relay",
    )

    assert summary.evidence_status == "provider_error"
    assert summary.has_agent_started is True
    assert summary.has_agent_ended is True
    assert summary.interruption_marker_count == 1
    assert summary.provider_error_count == 1
    assert summary.diagnostic_count == 1
    assert summary.close_reason == "interrupted"
    assert summary.missing_required_events == (
        "sophia.user_transcript",
        "sophia.transcript:is_final",
        "sophia.artifact",
    )


def test_flags_public_event_boundary_leaks() -> None:
    summary = summarize_dogfood_events(
        [
            {"type": "response.output_audio_transcript.delta", "data": {"delta": "Hi."}},
            {"type": "sophia.turn", "data": {"phase": "agent_started"}},
        ]
    )

    assert summary.evidence_status == "provider_leak"
    assert summary.normalized_event_count == 1
    assert summary.non_sophia_event_types == ("response.output_audio_transcript.delta",)