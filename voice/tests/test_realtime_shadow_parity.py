from __future__ import annotations

from voice.realtime.shadow_parity import LegacyCascadeShadowParity, ShadowParityResult


def _artifact(**overrides: object) -> dict[str, object]:
    artifact = {
        "session_goal": "Stay present.",
        "active_goal": "Reflect the user clearly.",
        "next_step": "Listen for the next turn.",
        "takeaway": "The user wants steadiness.",
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


def test_legacy_shadow_parity_records_perfect_public_event_match() -> None:
    artifact = _artifact()
    parity = LegacyCascadeShadowParity(session_id="session-1", user_id="user-1")
    parity.start_turn(turn_id="turn-1", response_id="response-1")
    parity.expect_final_user_transcript("hello", utterance_id="utt-1")
    parity.expect_agent_response_started()
    parity.expect_assistant_transcript("I hear you.", is_final=False)
    parity.expect_assistant_transcript("I hear you.", is_final=True)
    parity.expect_artifact(artifact)
    parity.expect_agent_response_ended()

    actual_events = [
        {"type": "sophia.user_transcript", "data": {"text": "hello", "utterance_id": "utt-1"}},
        {"type": "sophia.turn", "data": {"phase": "user_ended"}},
        {"type": "sophia.turn", "data": {"phase": "agent_started"}},
        {"type": "sophia.transcript", "data": {"text": "I hear you.", "is_final": False}},
        {"type": "sophia.transcript", "data": {"text": "I hear you.", "is_final": True}},
        {"type": "sophia.artifact", "data": artifact},
        {"type": "sophia.turn", "data": {"phase": "agent_ended"}},
    ]

    for payload in actual_events:
        parity.observe_actual_public_event(payload)

    assert [record.result for record in parity.diagnostics] == [
        ShadowParityResult.MATCH,
        ShadowParityResult.MATCH,
        ShadowParityResult.MATCH,
        ShadowParityResult.MATCH,
        ShadowParityResult.MATCH,
        ShadowParityResult.MATCH,
        ShadowParityResult.MATCH,
    ]
    assert parity.pending_expected_count == 0


def test_shadow_parity_ignores_dynamic_diagnostic_fields() -> None:
    parity = LegacyCascadeShadowParity(session_id="session-1", user_id="user-1")
    parity.start_turn(turn_id="turn-1", response_id="response-1")
    parity.expect_turn_diagnostic(
        {
            "status": "completed",
            "reason": "completed",
            "raw_false_end_count": 1,
            "duplicate_phase_counts": {},
            "backend_request_start_ms": 10.0,
            "first_text_ms": 20.0,
            "created_at": "earlier",
        }
    )

    parity.observe_actual_public_event(
        {
            "type": "sophia.turn_diagnostic",
            "data": {
                "status": "completed",
                "reason": "completed",
                "raw_false_end_count": 1,
                "duplicate_phase_counts": {},
                "backend_request_start_ms": 999.0,
                "first_text_ms": 1000.0,
                "created_at": "later",
            },
        }
    )

    assert parity.diagnostics[-1].result == ShadowParityResult.MATCH


def test_shadow_parity_records_payload_mismatch_without_emitting_events() -> None:
    parity = LegacyCascadeShadowParity(session_id="session-1", user_id="user-1")
    parity.start_turn(turn_id="turn-1", response_id="response-1")
    parity.expect_assistant_transcript("I hear you.", is_final=False)

    parity.observe_actual_public_event(
        {
            "type": "sophia.transcript",
            "data": {"text": "Different text.", "is_final": False},
        }
    )

    record = parity.diagnostics[-1]
    assert record.result == ShadowParityResult.PAYLOAD_SHAPE_MISMATCH
    assert record.expected_event_type == "sophia.transcript"
    assert record.actual_event_type == "sophia.transcript"
    assert record.expected_subset == {"text": "I hear you.", "is_final": False}
    assert record.actual_subset == {"text": "Different text.", "is_final": False}


def test_shadow_parity_records_sequence_type_unexpected_and_missing() -> None:
    parity = LegacyCascadeShadowParity(session_id="session-1", user_id="user-1")
    parity.start_turn(turn_id="turn-1", response_id="response-1")
    parity.expect_agent_response_started()
    parity.expect_assistant_transcript("I hear you.", is_final=False)

    parity.observe_actual_public_event(
        {
            "type": "sophia.transcript",
            "data": {"text": "I hear you.", "is_final": False},
        }
    )
    parity.observe_actual_public_event({"type": "sophia.artifact", "data": _artifact()})
    parity.observe_actual_public_event({"type": "not.sophia", "data": {}})
    parity.flush_missing_expected(reason="test flush")

    assert [record.result for record in parity.diagnostics] == [
        ShadowParityResult.SEQUENCING_MISMATCH,
        ShadowParityResult.TYPE_MISMATCH,
        ShadowParityResult.UNEXPECTED_ACTUAL_EVENT,
    ]

    parity.expect_agent_response_ended()
    parity.flush_missing_expected(reason="missing test")
    assert parity.diagnostics[-1].result == ShadowParityResult.MISSING_EXPECTED_EVENT