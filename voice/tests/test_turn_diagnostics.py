from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

import voice.sophia_llm as sophia_llm_module
from voice.sophia_llm import SophiaLLM
from voice.tests.conftest import make_settings
from voice.turn_diagnostics import TurnDiagnosticsTracker


def test_tracker_dedupes_agent_phases_and_emits_completion() -> None:
    tracker = TurnDiagnosticsTracker()

    tracker.note_user_ended("user-1", 10.0)
    assert tracker.note_agent_phase("user-1", "agent_started") is True

    assert tracker.note_agent_phase("user-1", "agent_started") is False

    stabilization_ms = tracker.note_submission_stabilization("user-1", 175.0)
    assert stabilization_ms is not None

    request_start_ms = tracker.note_backend_request_start("user-1", 10.05)
    assert request_start_ms is not None
    first_event_ms = tracker.note_backend_first_event("user-1", 10.08)
    assert first_event_ms is not None
    tracker.note_first_text("user-1", 10.1)
    backend_complete_ms = tracker.note_backend_complete("user-1", 10.3)
    assert backend_complete_ms is not None

    assert tracker.note_agent_phase("user-1", "agent_ended") is True

    diagnostic = tracker.complete("user-1")
    assert diagnostic is not None
    assert diagnostic.reason == "completed"
    assert diagnostic.raw_false_end_count == 1
    assert diagnostic.submission_stabilization_ms == pytest.approx(175.0)
    assert diagnostic.backend_request_start_ms is not None
    assert diagnostic.backend_first_event_ms is not None
    assert diagnostic.duplicate_phase_counts == {"agent_started": 1}


def test_tracker_reuses_active_turn_for_repeated_false_ends() -> None:
    tracker = TurnDiagnosticsTracker()

    first_turn_id = tracker.note_user_ended("user-1", 20.0)
    second_turn_id = tracker.note_user_ended("user-1", 20.2)

    assert second_turn_id == first_turn_id

    diagnostic = tracker.fail("user-1", "silence_timing")
    assert diagnostic is not None
    assert diagnostic.reason == "silence_timing"
    assert diagnostic.raw_false_end_count == 2


def test_tracker_waits_for_post_backend_agent_end_when_late_audio_chunks_arrive() -> None:
    tracker = TurnDiagnosticsTracker()

    tracker.note_user_ended("user-1", 30.0)
    assert tracker.note_agent_phase("user-1", "agent_started") is True
    assert tracker.note_agent_phase("user-1", "agent_ended") is True
    assert tracker.note_backend_complete("user-1", 30.2) is not None
    assert tracker.can_finalize("user-1") is True

    # A second chunk cycle should keep the same logical turn alive until its end.
    assert tracker.note_agent_phase("user-1", "agent_started") is False
    assert tracker.can_finalize("user-1") is False
    assert tracker.complete("user-1") is None

    assert tracker.note_agent_phase("user-1", "agent_ended") is False
    diagnostic = tracker.complete("user-1")

    assert diagnostic is not None
    assert diagnostic.reason == "completed"
    assert diagnostic.duplicate_phase_counts == {
        "agent_ended": 1,
        "agent_started": 1,
    }


def test_tracker_can_finalize_from_final_text_when_tts_events_never_arrive() -> None:
    tracker = TurnDiagnosticsTracker()

    tracker.note_user_ended("user-1", 40.0)
    assert tracker.note_agent_phase("user-1", "agent_started") is True
    assert tracker.note_first_text("user-1", 40.1) is not None
    assert tracker.note_backend_complete("user-1", 40.3) is not None

    tracker.note_final_text("user-1")

    assert tracker.can_finalize("user-1") is True

    diagnostic = tracker.complete("user-1")

    assert diagnostic is not None
    assert diagnostic.reason == "completed"
    assert diagnostic.first_audio_ms is None


def test_tracker_reanchors_clock_on_cancel_and_merge() -> None:
    """A second backend_request_start on the same active turn (cancel-and-merge)
    must reset the clock so telemetry measures only the final merged request."""
    tracker = TurnDiagnosticsTracker()

    tracker.note_user_ended("user-1", 100.0)
    # First backend attempt (gets cancelled).
    first_start = tracker.note_backend_request_start("user-1", 100.05)
    assert first_start is not None
    assert first_start == pytest.approx(50.0)
    tracker.note_agent_phase("user-1", "agent_started")
    tracker.note_backend_first_event("user-1", 100.10)
    tracker.note_first_text("user-1", 100.12)

    # Simulate cancel-and-merge: user kept talking for 5s, then final request fires.
    second_start = tracker.note_backend_request_start("user-1", 105.0)
    assert second_start == 0.0, "Second call must re-anchor to zero"

    # Downstream metrics must be cleared so they re-measure from the new anchor.
    active = tracker._turns["user-1"]
    assert active.backend_first_event_ms is None
    assert active.first_text_ms is None
    assert active.backend_complete_ms is None
    assert active.first_audio_ms is None
    assert active.agent_started_emitted is False
    assert active.agent_ended_emitted is False
    assert active.audio_cycle_open is False
    assert active.agent_cycle_count == 0

    # The merged request takes 1.2s to respond — telemetry should report exactly that.
    first_event_ms = tracker.note_backend_first_event("user-1", 106.2)
    assert first_event_ms == pytest.approx(1200.0)

    # raw_false_end_count is preserved across merges (it's a separate signal).
    assert active.raw_false_end_count == 1


@pytest.mark.anyio
async def test_llm_emits_turn_diagnostic_and_suppresses_duplicate_agent_phases() -> None:
    emitted: list[dict[str, object]] = []

    async def fake_emitter(payload: dict[str, object]) -> None:
        emitted.append(payload)

    original_grace_ms = sophia_llm_module.TURN_COMPLETION_GRACE_MS
    sophia_llm_module.TURN_COMPLETION_GRACE_MS = 0

    llm = SophiaLLM(make_settings())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")

    try:
        llm.note_turn_end(participant)
        await llm.emit_turn_event("user_ended", user_id="user-1")
        time.sleep(0.001)
        llm.note_submission_stabilized("user-1", 175.0)
        time.sleep(0.001)
        llm.note_backend_request_started("user-1")
        time.sleep(0.001)
        llm.note_backend_first_event("user-1")
        time.sleep(0.001)
        llm.note_first_text_emitted("user-1")
        time.sleep(0.001)
        llm.note_backend_completed("user-1")
        time.sleep(0.001)
        llm.note_tts_audio_emitted("user-1")
        await llm.emit_turn_event("agent_started", user_id="user-1")
        await llm.emit_turn_event("agent_started", user_id="user-1")
        await llm.emit_turn_event("agent_ended", user_id="user-1")
        await llm.emit_turn_event("agent_ended", user_id="user-1")
        await asyncio.sleep(0)

        assert [payload["type"] for payload in emitted] == [
            "sophia.turn",
            "sophia.turn",
            "sophia.turn",
            "sophia.turn_diagnostic",
        ]

        diagnostic = emitted[-1]["data"]
        assert diagnostic["reason"] == "completed"
        assert diagnostic["raw_false_end_count"] == 1
        assert diagnostic["duplicate_phase_counts"] == {
            "agent_ended": 1,
            "agent_started": 1,
        }
        assert diagnostic["submission_stabilization_ms"] == pytest.approx(175.0)
        assert diagnostic["backend_request_start_ms"] is not None
        assert diagnostic["backend_first_event_ms"] is not None
        assert diagnostic["backend_complete_ms"] is not None
        assert diagnostic["first_audio_ms"] is not None
    finally:
        sophia_llm_module.TURN_COMPLETION_GRACE_MS = original_grace_ms


@pytest.mark.anyio
async def test_llm_queues_user_ended_until_flushed() -> None:
    emitted: list[dict[str, object]] = []

    async def fake_emitter(payload: dict[str, object]) -> None:
        emitted.append(payload)

    llm = SophiaLLM(make_settings())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")

    llm.note_turn_end(participant)

    assert llm.has_pending_user_ended("user-1") is True
    assert emitted == []

    emitted_now = await llm.emit_pending_user_ended("user-1")

    assert emitted_now is True
    assert llm.has_pending_user_ended("user-1") is False
    assert emitted == [
        {"type": "sophia.turn", "data": {"phase": "user_ended"}},
    ]


@pytest.mark.anyio
async def test_llm_emits_single_user_ended_after_repeated_raw_turn_ends() -> None:
    emitted: list[dict[str, object]] = []

    async def fake_emitter(payload: dict[str, object]) -> None:
        emitted.append(payload)

    llm = SophiaLLM(make_settings())
    llm.attach_call_emitter(fake_emitter)
    participant = SimpleNamespace(user_id="user-1")

    llm.note_turn_end(participant)
    llm.note_turn_end(participant)

    emitted_now = await llm.emit_pending_user_ended("user-1")

    assert emitted_now is True
    assert emitted == [
        {"type": "sophia.turn", "data": {"phase": "user_ended"}},
    ]