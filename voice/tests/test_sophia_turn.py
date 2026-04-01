"""Tests for SophiaTurnDetection echo suppression."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from voice.sophia_turn import (
    SophiaTurnDetection,
    DEFAULT_ECHO_COOLDOWN_MS,
    _CONTINUATION_PATTERNS,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_detector(**overrides) -> SophiaTurnDetection:
    """Create a detector with sensible test defaults."""
    defaults = dict(
        silence_duration_ms=1200,
        speech_probability_threshold=0.75,
        pre_speech_buffer_ms=200,
        vad_reset_interval_seconds=5.0,
    )
    defaults.update(overrides)
    return SophiaTurnDetection(**defaults)


# ---------------------------------------------------------------------------
# Unit tests — suppression flag logic
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_not_suppressed_by_default():
    td = _make_detector()
    assert td.is_suppressed is False


@pytest.mark.anyio
async def test_suppressed_after_note_agent_will_speak():
    td = _make_detector()
    td.note_agent_will_speak()
    assert td.is_suppressed is True


@pytest.mark.anyio
async def test_note_agent_audio_ready_sets_finite_window():
    td = _make_detector(echo_cooldown_ms=100)
    td.note_agent_will_speak()
    td.note_agent_audio_ready(playback_duration_ms=500)
    # Should still be suppressed (window = 500 + 100 = 600ms from now)
    assert td.is_suppressed is True


@pytest.mark.anyio
async def test_suppression_expires_after_window():
    td = _make_detector(echo_cooldown_ms=0)
    td.note_agent_will_speak()
    # Simulate audio that lasts 0ms with 0ms cooldown
    td.note_agent_audio_ready(playback_duration_ms=0)
    # Tiny sleep to ensure monotonic clock advances
    await asyncio.sleep(0.01)
    assert td.is_suppressed is False


@pytest.mark.anyio
async def test_note_agent_interrupted_starts_cooldown():
    td = _make_detector(echo_cooldown_ms=100)
    td.note_agent_will_speak()
    td.note_agent_interrupted()
    # Should still be suppressed for the cooldown period
    assert td.is_suppressed is True


@pytest.mark.anyio
async def test_interrupted_cooldown_expires():
    td = _make_detector(echo_cooldown_ms=0)
    td.note_agent_will_speak()
    td.note_agent_interrupted()
    await asyncio.sleep(0.01)
    assert td.is_suppressed is False


def test_default_cooldown_value():
    assert DEFAULT_ECHO_COOLDOWN_MS == 600


@pytest.mark.anyio
async def test_custom_cooldown():
    td = _make_detector(echo_cooldown_ms=1000)
    assert td._echo_cooldown_ms == 1000


# ---------------------------------------------------------------------------
# Integration tests — process_audio is skipped during suppression
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_process_audio_skipped_while_suppressed():
    td = _make_detector()
    td.note_agent_will_speak()

    # Patch parent's process_audio — should NOT be called
    with patch.object(
        SophiaTurnDetection.__bases__[0],
        "process_audio",
        new_callable=AsyncMock,
    ) as parent_process:
        await td.process_audio(MagicMock(), MagicMock())
        parent_process.assert_not_called()


@pytest.mark.anyio
async def test_process_audio_passes_through_when_not_suppressed():
    td = _make_detector()

    with patch.object(
        SophiaTurnDetection.__bases__[0],
        "process_audio",
        new_callable=AsyncMock,
    ) as parent_process:
        audio = MagicMock()
        participant = MagicMock()
        await td.process_audio(audio, participant)
        parent_process.assert_called_once_with(audio, participant, None)


@pytest.mark.anyio
async def test_process_audio_resumes_after_suppression_expires():
    td = _make_detector(echo_cooldown_ms=0)
    td.note_agent_will_speak()
    td.note_agent_audio_ready(playback_duration_ms=0)

    # Wait for suppression to expire
    await asyncio.sleep(0.01)

    with patch.object(
        SophiaTurnDetection.__bases__[0],
        "process_audio",
        new_callable=AsyncMock,
    ) as parent_process:
        await td.process_audio(MagicMock(), MagicMock())
        parent_process.assert_called_once()


# ---------------------------------------------------------------------------
# TTS integration — echo guard wiring
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_tts_signals_echo_guard():
    """stream_audio should call note_agent_will_speak and note_agent_audio_ready."""
    from voice.sophia_tts import SophiaTTS
    from voice.config import VoiceSettings

    settings = MagicMock(spec=VoiceSettings)
    settings.cartesia_model_id = "sonic-3"
    settings.cartesia_voice_id = "test-voice"
    settings.cartesia_sample_rate = 16000

    tts = SophiaTTS.__new__(SophiaTTS)
    tts.model_id = settings.cartesia_model_id
    tts.voice_id = settings.cartesia_voice_id
    tts.sample_rate = settings.cartesia_sample_rate
    tts._next_artifact = {}
    tts._has_real_artifact = False
    tts._hint_emotion = None
    tts._hint_speed = None
    tts._echo_guard = MagicMock()

    # Mock the Cartesia client
    mock_response = MagicMock()
    mock_response.iter_bytes.return_value = iter([b"\x00\x00" * 16000])
    mock_client = MagicMock()
    mock_client.tts.generate = AsyncMock(return_value=mock_response)
    tts.client = mock_client

    # Mock PcmData.from_response to return a mock with duration_ms
    mock_pcm = MagicMock()
    mock_pcm.duration_ms = 2000.0
    with patch("voice.sophia_tts.PcmData") as pcm_cls:
        pcm_cls.from_response.return_value = mock_pcm
        await tts.stream_audio("Hello there friend")

    tts._echo_guard.note_agent_will_speak.assert_called_once()
    tts._echo_guard.note_agent_audio_ready.assert_called_once()
    # Estimated: 3 words / 2.5 wps * 1000 = 1200ms (no speed override)
    estimated_ms = tts._echo_guard.note_agent_audio_ready.call_args[0][0]
    assert estimated_ms == pytest.approx(1200.0, rel=0.01)


# ---------------------------------------------------------------------------
# Adaptive silence threshold tests (Layer 1)
# ---------------------------------------------------------------------------

class TestAdaptiveSilence:
    """Tests for word-count-based adaptive silence thresholds."""

    pytestmark = pytest.mark.anyio

    async def test_short_utterance_sets_short_silence(self):
        td = _make_detector()
        td.update_transcript("yes")
        assert td._trailing_silence_ms == 1000

    async def test_single_word(self):
        td = _make_detector()
        td.update_transcript("hello")
        assert td._trailing_silence_ms == 1000

    async def test_three_words_still_short(self):
        td = _make_detector()
        td.update_transcript("I am good")
        assert td._trailing_silence_ms == 1000

    async def test_four_words_medium(self):
        td = _make_detector()
        td.update_transcript("I am doing fine")
        assert td._trailing_silence_ms == 1500

    async def test_seven_words_medium(self):
        td = _make_detector()
        td.update_transcript("I think the meeting went really well")
        assert td._trailing_silence_ms == 1500

    async def test_ten_words_still_medium(self):
        td = _make_detector()
        td.update_transcript("one two three four five six seven eight nine ten")
        assert td._trailing_silence_ms == 1500

    async def test_eleven_words_long(self):
        td = _make_detector()
        td.update_transcript("one two three four five six seven eight nine ten eleven")
        assert td._trailing_silence_ms == 2000

    async def test_many_words_long(self):
        td = _make_detector()
        td.update_transcript("I think the meeting went well and I am happy about the outcome overall")
        assert td._trailing_silence_ms == 2000

    async def test_empty_transcript_defaults_to_short(self):
        td = _make_detector()
        td.update_transcript("")
        assert td._trailing_silence_ms == 1000

    async def test_whitespace_only_defaults_to_short(self):
        td = _make_detector()
        td.update_transcript("   ")
        assert td._trailing_silence_ms == 1000

    async def test_reset_transcript_restores_short(self):
        td = _make_detector()
        td.update_transcript("one two three four five six seven eight nine ten eleven")
        assert td._trailing_silence_ms == 2000
        td.reset_transcript()
        assert td._trailing_silence_ms == 1000

    async def test_custom_thresholds(self):
        td = _make_detector(
            adaptive_silence_short_ms=500,
            adaptive_silence_medium_ms=900,
            adaptive_silence_long_ms=1400,
        )
        td.update_transcript("yes")
        assert td._trailing_silence_ms == 500
        td.update_transcript("yes no one two three")
        assert td._trailing_silence_ms == 900
        td.update_transcript("yes no one two three four five six seven ten eleven")
        assert td._trailing_silence_ms == 1400

    async def test_ceiling_enforced(self):
        td = _make_detector(adaptive_silence_ceiling_ms=1800)
        # 11 words (long=2000) but ceiling at 1800
        td.update_transcript("a b c d e f g h i j k")
        assert td._trailing_silence_ms == 1800


# ---------------------------------------------------------------------------
# Continuation signal tests (Layer 1 — R2)
# ---------------------------------------------------------------------------

class TestContinuationSignals:
    """Tests for trailing continuation pattern detection."""

    pytestmark = pytest.mark.anyio

    async def test_trailing_conjunction_and(self):
        td = _make_detector()
        td.update_transcript("I was thinking about and")
        # 6 words → medium (1500) + continuation (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_trailing_conjunction_because(self):
        td = _make_detector()
        td.update_transcript("It happened because")
        # 3 words → short (1000) + continuation (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_trailing_filler_um(self):
        td = _make_detector()
        td.update_transcript("I feel like um")
        # 4 words → medium (1500) + continuation (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_trailing_filler_you_know(self):
        td = _make_detector()
        td.update_transcript("the thing is you know")
        # 6 words → medium (1500) + continuation (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_trailing_incomplete_i_think(self):
        td = _make_detector()
        td.update_transcript("well I think")
        # 3 words → short (1000) + continuation (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_trailing_article_the(self):
        td = _make_detector()
        td.update_transcript("I want to find the")
        # 6 words → medium (1500) + continuation (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_no_continuation_after_complete_word(self):
        td = _make_detector()
        td.update_transcript("I finally understand")
        # 3 words → short (1000), no continuation
        assert td._trailing_silence_ms == 1000

    async def test_case_insensitive_continuation(self):
        td = _make_detector()
        td.update_transcript("I was saying AND")
        # 4 words → medium (1500) + continuation (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_continuation_at_ceiling(self):
        td = _make_detector()
        # 11+ words → long (2000) + continuation (+800) = 2800 (at ceiling)
        td.update_transcript("a b c d e f g h i j k and")
        assert td._trailing_silence_ms == 2800

    async def test_continuation_capped_at_ceiling(self):
        td = _make_detector(adaptive_silence_ceiling_ms=2500)
        # 11+ words → long (2000) + continuation (+800) = 2800,
        # but ceiling is 2500
        td.update_transcript("a b c d e f g h i j k because")
        assert td._trailing_silence_ms == 2500

    async def test_custom_continuation_bonus(self):
        td = _make_detector(adaptive_silence_continuation_bonus_ms=400)
        td.update_transcript("I think")
        # 2 words → short (1000) + continuation (+400) = 1400
        assert td._trailing_silence_ms == 1400

    def test_has_continuation_signal_static(self):
        assert SophiaTurnDetection._has_continuation_signal("hello and") is True
        assert SophiaTurnDetection._has_continuation_signal("I think") is True
        assert SophiaTurnDetection._has_continuation_signal("um") is True
        assert SophiaTurnDetection._has_continuation_signal("great thanks") is False
        assert SophiaTurnDetection._has_continuation_signal("") is False

    async def test_trailing_its_like(self):
        td = _make_detector()
        td.update_transcript("well it's like")
        # 3 words → short (1000) + continuation (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_trailing_the_thing_is(self):
        td = _make_detector()
        td.update_transcript("yeah the thing is")
        # 4 words → medium (1500) + continuation (+800) = 2300
        assert td._trailing_silence_ms == 2300


# ---------------------------------------------------------------------------
# Fragment start detection tests (Layer 1 — short mid-sentence phrases)
# ---------------------------------------------------------------------------

class TestFragmentDetection:
    """Tests for fragment start pattern that boosts silence on short function-word phrases."""

    pytestmark = pytest.mark.anyio

    async def test_aux_verb_are_getting_better(self):
        td = _make_detector()
        td.update_transcript("are getting better")
        # 3 words → short (1000) + fragment (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_aux_verb_was_thinking(self):
        td = _make_detector()
        td.update_transcript("was thinking")
        # 2 words → short (1000) + fragment (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_preposition_with_my_friend(self):
        td = _make_detector()
        td.update_transcript("with my friend")
        # 3 words → short (1000) + fragment (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_article_the_whole_point(self):
        td = _make_detector()
        td.update_transcript("the whole point")
        # 3 words → short (1000) + fragment (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_modal_could_have_been(self):
        td = _make_detector()
        td.update_transcript("could have been")
        # 3 words → short (1000) + fragment (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_subordinate_when_she_said(self):
        td = _make_detector()
        td.update_transcript("when she said that")
        # 4 words → medium (1500) + fragment (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_participle_getting_closer(self):
        td = _make_detector()
        td.update_transcript("getting closer to")
        # 3 words → short (1000) + fragment (+800) + continuation (trailing "to") → only one bonus
        # fragment and continuation are OR'd, not added
        assert td._trailing_silence_ms == 1800

    async def test_adverb_still_not_sure(self):
        td = _make_detector()
        td.update_transcript("still not sure")
        # 3 words → short (1000) + fragment (+800) = 1800
        assert td._trailing_silence_ms == 1800

    async def test_fragment_at_five_words(self):
        td = _make_detector()
        td.update_transcript("is really hard to say")
        # 5 words → medium (1500) + fragment (+800) = 2300
        assert td._trailing_silence_ms == 2300

    async def test_fragment_not_triggered_above_max_words(self):
        td = _make_detector()
        td.update_transcript("are those things really getting any better now")
        # 8 words (> 5) → medium (1500), no fragment bonus
        assert td._trailing_silence_ms == 1500

    async def test_non_fragment_complete_utterance(self):
        td = _make_detector()
        td.update_transcript("yes definitely")
        # 2 words → short (1000), no fragment (starts with "yes")
        assert td._trailing_silence_ms == 1000

    async def test_non_fragment_pronoun_start(self):
        td = _make_detector()
        td.update_transcript("I am good")
        # 3 words → short (1000), no fragment ("I" is not in pattern)
        assert td._trailing_silence_ms == 1000

    async def test_fragment_case_insensitive(self):
        td = _make_detector()
        td.update_transcript("Are getting better")
        # Case-insensitive: "Are" matches "are"
        assert td._trailing_silence_ms == 1800

    def test_is_fragment_static_method(self):
        assert SophiaTurnDetection._is_fragment("are getting better", 3) is True
        assert SophiaTurnDetection._is_fragment("yes definitely", 2) is False
        assert SophiaTurnDetection._is_fragment("the thing", 2) is True
        assert SophiaTurnDetection._is_fragment("", 0) is False
        assert SophiaTurnDetection._is_fragment("are you doing well today friend", 6) is False

    async def test_fragment_combined_with_rhythm_offset(self):
        td = _make_detector()
        td.set_rhythm_offset(100)
        td.update_transcript("are getting better")
        # 3 words → short (1000) + fragment (+800) + rhythm (+100) = 1900
        assert td._trailing_silence_ms == 1900


# ---------------------------------------------------------------------------
# Rhythm offset tests (Layer 3 integration — R14)
# ---------------------------------------------------------------------------

class TestRhythmOffset:
    """Tests for per-user rhythm offset applied to adaptive silence."""

    pytestmark = pytest.mark.anyio

    async def test_positive_rhythm_offset(self):
        td = _make_detector()
        td.set_rhythm_offset(200)
        td.update_transcript("one two three four five")
        # 5 words → medium (1500) + rhythm (+200) = 1700
        assert td._trailing_silence_ms == 1700

    async def test_negative_rhythm_offset(self):
        td = _make_detector()
        td.set_rhythm_offset(-200)
        td.update_transcript("one two three four five")
        # 5 words → medium (1500) + rhythm (-200) = 1300
        assert td._trailing_silence_ms == 1300

    async def test_rhythm_offset_respects_ceiling(self):
        td = _make_detector()
        td.set_rhythm_offset(500)
        # 11+ words → long (2000) + continuation (+800) + rhythm (+500) = 3300
        # → capped at 2800
        td.update_transcript("a b c d e f g h i j k and")
        assert td._trailing_silence_ms == 2800

    async def test_rhythm_offset_respects_floor(self):
        td = _make_detector()
        td.set_rhythm_offset(-800)
        td.update_transcript("yes")
        # 1 word → short (1000) + rhythm (-800) = 200
        # → floored at short_ms (1000)
        assert td._trailing_silence_ms == 1000

    async def test_no_rhythm_offset_by_default(self):
        td = _make_detector()
        td.update_transcript("yes")
        assert td._trailing_silence_ms == 1000
        # offset is 0
        assert td._rhythm_offset_ms == 0

    async def test_rhythm_combined_with_continuation(self):
        td = _make_detector()
        td.set_rhythm_offset(100)
        td.update_transcript("I think")
        # 2 words → short (1000) + continuation (+800) + rhythm (+100) = 1900
        assert td._trailing_silence_ms == 1900
