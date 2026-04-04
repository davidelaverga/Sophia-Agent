"""Tests for ConversationFlowCoordinator (Layer 2) + acknowledgment pool."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from voice.conversation_flow import (
    ACKNOWLEDGMENT_PHRASES,
    ConversationFlowCoordinator,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_coordinator(**overrides) -> ConversationFlowCoordinator:
    defaults = dict(
        backend_stall_timeout_ms=8000,
        fragile_window_ms=600,
        merge_min_new_words=2,
        cancel_llm_task=AsyncMock(),
        interrupt_tts=AsyncMock(),
        on_backend_stall=AsyncMock(),
        record_turn=MagicMock(),
        send_acknowledgment=AsyncMock(),
        same_turn_repeat_debounce_ms=1200,
        resubmit_response=AsyncMock(),
    )
    defaults.update(overrides)
    return ConversationFlowCoordinator(**defaults)


# ---------------------------------------------------------------------------
# Fragile window — normal path (R8)
# ---------------------------------------------------------------------------

class TestFragileWindowNormalPath:
    """When no new speech arrives, the fragile window adds zero overhead."""

    pytestmark = pytest.mark.anyio

    async def test_window_expires_without_cancel(self):
        coord = _make_coordinator(fragile_window_ms=50)
        assert coord.on_turn_ended("I just feel like", MagicMock()) is True
        await asyncio.sleep(0.1)  # let window expire
        coord._cancel_llm_task.assert_not_called()
        coord._interrupt_tts.assert_not_called()
        assert coord.is_merge_pending is False

    async def test_no_cancel_when_below_word_threshold(self):
        coord = _make_coordinator(fragile_window_ms=200, merge_min_new_words=2)
        assert coord.on_turn_ended("I just feel like", MagicMock()) is True
        # Only 1 new word — below threshold
        coord.on_partial_transcript("I just feel like nobody")
        await asyncio.sleep(0.05)
        coord._cancel_llm_task.assert_not_called()
        assert coord.is_merge_pending is False


# ---------------------------------------------------------------------------
# Cancel-and-merge trigger
# ---------------------------------------------------------------------------

class TestCancelAndMerge:
    """Cancel-and-merge fires when ≥2 new words arrive during fragile window."""

    pytestmark = pytest.mark.anyio

    async def test_cancel_fires_with_enough_new_words(self):
        coord = _make_coordinator(fragile_window_ms=500)
        assert coord.on_turn_ended("I just feel like", MagicMock()) is True
        # 2 new words
        coord.on_partial_transcript("I just feel like nobody gets")
        await asyncio.sleep(0.1)  # let cancel execute
        coord._cancel_llm_task.assert_called_once()
        coord._interrupt_tts.assert_called_once()
        coord._send_acknowledgment.assert_called_once()
        assert coord.is_merge_pending is True

    async def test_cancel_fires_for_reset_clause_continuation(self):
        coord = _make_coordinator(fragile_window_ms=500)
        assert coord.on_turn_ended("for my friend.", MagicMock()) is True
        coord.on_partial_transcript("But if I'm honest,")
        await asyncio.sleep(0.1)

        coord._cancel_llm_task.assert_called_once()
        coord._interrupt_tts.assert_called_once()
        coord._send_acknowledgment.assert_called_once()
        assert coord.is_merge_pending is True

    async def test_cancel_fires_at_most_once_per_turn(self):
        """R12: cancel-and-merge at most once per user turn."""
        coord = _make_coordinator(fragile_window_ms=500)
        assert coord.on_turn_ended("hello", MagicMock()) is True
        # First trigger
        coord.on_partial_transcript("hello world out there")
        await asyncio.sleep(0.05)
        assert coord._cancel_llm_task.call_count == 1
        # More words — should NOT trigger again
        coord.on_partial_transcript("hello world out there for sure")
        await asyncio.sleep(0.05)
        assert coord._cancel_llm_task.call_count == 1

    async def test_no_cancel_outside_fragile_window(self):
        coord = _make_coordinator(fragile_window_ms=30)
        assert coord.on_turn_ended("hi", MagicMock()) is True
        await asyncio.sleep(0.1)  # window expired
        coord.on_partial_transcript("hi there how are you")
        await asyncio.sleep(0.05)
        coord._cancel_llm_task.assert_not_called()

    async def test_cancel_sequence_order(self):
        """Cancel LLM → interrupt TTS → send ack."""
        call_order: list[str] = []

        async def mock_cancel():
            call_order.append("cancel_llm")

        async def mock_interrupt():
            call_order.append("interrupt_tts")

        async def mock_ack(phrase: str):
            call_order.append(f"ack:{phrase}")

        coord = _make_coordinator(
            fragile_window_ms=500,
            cancel_llm_task=mock_cancel,
            interrupt_tts=mock_interrupt,
            send_acknowledgment=mock_ack,
        )
        assert coord.on_turn_ended("hello", MagicMock()) is True
        coord.on_partial_transcript("hello world friends")
        await asyncio.sleep(0.1)

        assert call_order[0] == "cancel_llm"
        assert call_order[1] == "interrupt_tts"
        assert call_order[2].startswith("ack:")


# ---------------------------------------------------------------------------
# Merge + resubmit
# ---------------------------------------------------------------------------

class TestMergeAndResubmit:
    pytestmark = pytest.mark.anyio

    async def test_merge_resubmit_called_on_second_turn_end(self):
        coord = _make_coordinator(fragile_window_ms=500)
        participant = MagicMock()
        assert coord.on_turn_ended("I just feel", participant) is True
        coord.on_partial_transcript("I just feel like nobody gets it")
        await asyncio.sleep(0.1)
        assert coord.is_merge_pending is True

        # User finishes; second turn ended
        coord.on_merge_turn_ended("I just feel like nobody really gets it")
        await asyncio.sleep(0.05)
        coord._resubmit_response.assert_called_once()
        merged = coord._resubmit_response.call_args[0][0]
        assert "nobody really gets it" in merged
        assert coord.is_merge_pending is False

    async def test_merge_not_called_without_pending(self):
        coord = _make_coordinator()
        coord.on_merge_turn_ended("some text")
        coord._resubmit_response.assert_not_called()

    async def test_merge_transcripts_continuation_already_contains_original(self):
        merged = ConversationFlowCoordinator._merge_transcripts(
            "I just feel",
            "I just feel like nobody gets it",
        )
        assert merged == "I just feel like nobody gets it"

    async def test_merge_transcripts_separate_segments(self):
        merged = ConversationFlowCoordinator._merge_transcripts(
            "I just feel",
            "nobody really gets it",
        )
        assert merged == "I just feel nobody really gets it"

    async def test_merge_transcripts_empty_original(self):
        merged = ConversationFlowCoordinator._merge_transcripts("", "hello world")
        assert merged == "hello world"

    async def test_merge_transcripts_empty_continuation(self):
        merged = ConversationFlowCoordinator._merge_transcripts("hello", "")
        assert merged == "hello"

    async def test_merge_transcripts_deduplicates_overlap(self):
        merged = ConversationFlowCoordinator._merge_transcripts(
            "function today and I still can believe it.",
            "and I still can believe it. It actually happened.",
        )
        assert merged == "function today and I still can believe it. It actually happened."

    async def test_merge_transcripts_keeps_original_when_continuation_already_present(self):
        merged = ConversationFlowCoordinator._merge_transcripts(
            "my friend. But if I'm honest, I also feel jealous and a little ashamed of that.",
            "But if I'm honest, I also feel jealous and a little ashamed of that.",
        )
        assert merged == "my friend. But if I'm honest, I also feel jealous and a little ashamed of that."


# ---------------------------------------------------------------------------
# Word counting
# ---------------------------------------------------------------------------

class TestCountNewWords:
    def test_two_new_words(self):
        assert ConversationFlowCoordinator._count_new_words(
            "hello there", "hello there how are"
        ) == 2

    def test_no_new_words(self):
        assert ConversationFlowCoordinator._count_new_words(
            "hello there", "hello there"
        ) == 0

    def test_empty_original(self):
        assert ConversationFlowCoordinator._count_new_words("", "hello world") == 2

    def test_fewer_words(self):
        """STT replaced transcript with shorter version — no new words."""
        assert ConversationFlowCoordinator._count_new_words(
            "hello there friend", "hello"
        ) == 0


# ---------------------------------------------------------------------------
# Acknowledgment pool (R9)
# ---------------------------------------------------------------------------

class TestAcknowledgmentPool:
    def test_all_phrases_are_strings(self):
        assert all(isinstance(p, str) for p in ACKNOWLEDGMENT_PHRASES)

    def test_no_consecutive_duplicates(self):
        coord = _make_coordinator()
        prev = None
        for _ in range(20):
            phrase = coord._pick_acknowledgment()
            assert phrase != prev, f"Consecutive duplicate: {phrase!r}"
            prev = phrase

    def test_pool_returns_valid_phrase(self):
        coord = _make_coordinator()
        phrase = coord._pick_acknowledgment()
        assert phrase in ACKNOWLEDGMENT_PHRASES


# ---------------------------------------------------------------------------
# Error resilience
# ---------------------------------------------------------------------------

class TestErrorResilience:
    pytestmark = pytest.mark.anyio

    async def test_cancel_llm_failure_is_graceful(self):
        """If cancel_llm_task raises, coordinator still sends ack."""
        async def failing_cancel():
            raise RuntimeError("LLM cancel failed")

        coord = _make_coordinator(
            fragile_window_ms=500,
            cancel_llm_task=failing_cancel,
        )
        assert coord.on_turn_ended("hi", MagicMock()) is True
        coord.on_partial_transcript("hi there friend")
        await asyncio.sleep(0.1)
        # Should still have attempted ack despite cancel failure
        coord._send_acknowledgment.assert_called_once()
        assert coord.is_merge_pending is True

    async def test_same_fingerprint_repeats_are_suppressed(self):
        coord = _make_coordinator()
        participant = MagicMock()

        assert coord.on_turn_ended("I need a second", participant) is True
        assert coord.on_turn_ended("I need a second", participant) is False

    async def test_backend_stall_calls_callback(self):
        stalled = asyncio.Event()

        async def on_backend_stall(*_args):
            stalled.set()

        coord = _make_coordinator(
            backend_stall_timeout_ms=20,
            on_backend_stall=on_backend_stall,
        )

        assert coord.on_turn_ended("I need a second", MagicMock()) is True
        await asyncio.wait_for(stalled.wait(), timeout=0.1)

    async def test_backend_progress_cancels_stall_timer(self):
        stalled = asyncio.Event()

        async def on_backend_stall(*_args):
            stalled.set()

        coord = _make_coordinator(
            backend_stall_timeout_ms=20,
            on_backend_stall=on_backend_stall,
        )

        assert coord.on_turn_ended("I need a second", MagicMock()) is True
        coord.on_backend_progress()
        await asyncio.sleep(0.05)

        assert stalled.is_set() is False

    async def test_agent_ended_records_turn_and_clears_active_state(self):
        coord = _make_coordinator()

        assert coord.on_turn_ended("I need a second", MagicMock()) is True
        await asyncio.sleep(0.01)
        assert coord.on_turn_ended("I need a second", MagicMock()) is False

        coord.on_agent_started()
        coord.on_agent_ended()

        coord._record_turn.assert_called_once()
        word_count, pause_durations = coord._record_turn.call_args.args[:2]
        assert word_count == 4
        assert len(pause_durations) == 1

    async def test_recently_resolved_repeat_uses_debounce_setting(self):
        coord = _make_coordinator(same_turn_repeat_debounce_ms=10)

        assert coord.on_turn_ended("same words", MagicMock()) is True
        coord.on_agent_started()
        coord.on_agent_ended()
        assert coord.on_turn_ended("same words", MagicMock()) is False
        await asyncio.sleep(0.02)
        assert coord.on_turn_ended("same words", MagicMock()) is True

    async def test_late_continuation_recovers_inflight_response(self):
        coord = _make_coordinator()
        participant = MagicMock()
        participant.user_id = "user-1"

        assert coord.on_turn_ended("Things are getting better", participant) is True
        coord.mark_response_submitted("Things are getting better", participant)
        coord.on_agent_started()

        merged = await coord.recover_late_continuation(
            "Things are getting better just not as fast as I thought",
            participant,
        )

        assert merged == "Things are getting better just not as fast as I thought"
        coord._cancel_llm_task.assert_called_once()
        coord._interrupt_tts.assert_called_once()
        coord._send_acknowledgment.assert_not_called()

    async def test_late_continuation_ignored_after_response_finishes(self):
        coord = _make_coordinator()
        participant = MagicMock()
        participant.user_id = "user-1"

        assert coord.on_turn_ended("Things are getting better", participant) is True
        coord.mark_response_submitted("Things are getting better", participant)
        coord.on_agent_started()
        coord.on_agent_ended()

        merged = await coord.recover_late_continuation(
            "Things are getting better just not as fast as I thought",
            participant,
        )

        assert merged is None

    async def test_pre_response_continuation_waits_for_second_turn_end(self):
        coord = _make_coordinator()
        participant = MagicMock()
        participant.user_id = "user-1"

        assert coord.on_turn_ended("for my friend.", participant) is True
        coord.mark_response_submitted("for my friend.", participant)

        merged = await coord.defer_response_for_continuation(
            "But if I'm honest,",
            participant,
        )

        assert merged == "for my friend. But if I'm honest,"
        coord._cancel_llm_task.assert_called_once()
        coord._interrupt_tts.assert_called_once()
        coord._send_acknowledgment.assert_not_called()
        assert coord.is_merge_pending is True

        coord.on_merge_turn_ended("But if I'm honest, I also feel jealous.")
        await asyncio.sleep(0.05)

        coord._resubmit_response.assert_called_once_with(
            "for my friend. But if I'm honest, I also feel jealous.",
            participant,
        )

    async def test_pre_response_continuation_ignored_after_backend_progress(self):
        coord = _make_coordinator()
        participant = MagicMock()
        participant.user_id = "user-1"

        assert coord.on_turn_ended("for my friend.", participant) is True
        coord.mark_response_submitted("for my friend.", participant)
        coord.on_backend_progress()

        merged = await coord.defer_response_for_continuation(
            "But if I'm honest,",
            participant,
        )

        assert merged is None
        coord._cancel_llm_task.assert_not_called()
        coord._interrupt_tts.assert_not_called()
