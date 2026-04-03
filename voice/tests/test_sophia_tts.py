from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from voice.sophia_tts import (
    CARTESIA_EMOTIONS,
    SPEED_MAP,
    WARM_DEFAULT_ARTIFACT,
    SophiaTTS,
    _EMOTION_HINT_RULES,
)
from voice.tests.conftest import make_settings


def _make_tts() -> SophiaTTS:
    """Create a SophiaTTS with mocked Cartesia client (no real API calls)."""
    settings = make_settings(cartesia_voice_id="test-voice-id", cartesia_model_id="sonic-3")
    tts = SophiaTTS(settings)
    # Mock the Cartesia client to avoid real API calls
    mock_response = MagicMock()
    mock_response.iter_bytes = MagicMock(return_value=iter([b"\x00\x00" * 160]))
    tts.client = MagicMock()
    tts.client.tts = MagicMock()
    tts.client.tts.generate = AsyncMock(return_value=mock_response)
    return tts


def _valid_artifact(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "session_goal": "Test session",
        "active_goal": "Test goal",
        "next_step": "Next step",
        "takeaway": "Takeaway",
        "reflection": None,
        "tone_estimate": 2.0,
        "tone_target": 2.5,
        "active_tone_band": "engagement",
        "skill_loaded": "active_listening",
        "ritual_phase": "freeform.testing",
        "voice_emotion_primary": "sympathetic",
        "voice_emotion_secondary": "content",
        "voice_speed": "gentle",
    }
    base.update(overrides)
    return base


# ── Happy path tests ──────────────────────────────────────────────


@pytest.mark.anyio
async def test_stream_audio_applies_emotion_and_speed_from_artifact() -> None:
    tts = _make_tts()
    tts.update_from_artifact(_valid_artifact())

    await tts.stream_audio("Hello there.")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["generation_config"]["emotion"] == "sympathetic"
    assert call_kwargs["generation_config"]["speed"] == 0.9  # gentle


@pytest.mark.anyio
async def test_stream_audio_primary_set_emotion_passed_directly() -> None:
    tts = _make_tts()
    tts.update_from_artifact(_valid_artifact(voice_emotion_primary="calm"))

    await tts.stream_audio("I'm here with you.")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["generation_config"]["emotion"] == "calm"


@pytest.mark.parametrize(
    "label,expected_float",
    [
        ("slow", 0.8),
        ("gentle", 0.9),
        ("normal", 1.0),
        ("engaged", 1.05),
        ("energetic", 1.15),
    ],
)
def test_speed_label_mapping(label: str, expected_float: float) -> None:
    assert SPEED_MAP[label] == expected_float


# ── Edge case tests ───────────────────────────────────────────────


@pytest.mark.anyio
async def test_warm_default_on_first_turn() -> None:
    """First turn: no real artifact → warm default (content / gentle)."""
    tts = _make_tts()

    await tts.stream_audio("Hello.")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    gen = call_kwargs["generation_config"]
    assert gen["emotion"] == "content"
    assert gen["speed"] == 0.9  # gentle


@pytest.mark.anyio
async def test_unknown_primary_falls_back_to_secondary() -> None:
    tts = _make_tts()
    tts.update_from_artifact(
        _valid_artifact(
            voice_emotion_primary="joking/comedic",  # not in Cartesia set
            voice_emotion_secondary="excited",
        )
    )

    await tts.stream_audio("Ha!")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["generation_config"]["emotion"] == "excited"


@pytest.mark.anyio
async def test_unknown_primary_and_secondary_no_emotion() -> None:
    tts = _make_tts()
    tts.update_from_artifact(
        _valid_artifact(
            voice_emotion_primary="joking/comedic",
            voice_emotion_secondary="joking/comedic",
        )
    )

    await tts.stream_audio("Ha!")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["generation_config"]["emotion"] == "content"


@pytest.mark.anyio
async def test_valid_emotion_missing_speed() -> None:
    tts = _make_tts()
    artifact = _valid_artifact()
    del artifact["voice_speed"]
    tts.update_from_artifact(artifact)

    await tts.stream_audio("I'm here with you.")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["generation_config"]["emotion"] == "sympathetic"
    assert call_kwargs["generation_config"]["speed"] == 0.9


@pytest.mark.anyio
async def test_unknown_speed_label_omits_speed() -> None:
    tts = _make_tts()
    tts.update_from_artifact(_valid_artifact(voice_speed="hyperspeed"))

    await tts.stream_audio("I'm here with you.")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["generation_config"]["emotion"] == "sympathetic"
    assert call_kwargs["generation_config"]["speed"] == 0.9


@pytest.mark.anyio
async def test_artifact_persists_across_turns() -> None:
    """Artifact should be reused if no new artifact arrives."""
    tts = _make_tts()
    tts.update_from_artifact(_valid_artifact(voice_emotion_primary="excited", voice_speed="energetic"))

    await tts.stream_audio("First turn.")
    await tts.stream_audio("Second turn.")

    assert tts.client.tts.generate.call_count == 2
    for call in tts.client.tts.generate.call_args_list:
        assert call.kwargs["generation_config"]["emotion"] == "excited"
        assert call.kwargs["generation_config"]["speed"] == 1.15


# ── Integration: update_from_artifact → stream_audio flow ────────


@pytest.mark.anyio
async def test_update_artifact_then_stream_end_to_end() -> None:
    """Full flow: update_from_artifact queues values → stream_audio reads them."""
    tts = _make_tts()

    # First turn: warm default (content / gentle)
    await tts.stream_audio("First.")
    call_1 = tts.client.tts.generate.call_args.kwargs
    gen_1 = call_1["generation_config"]
    assert gen_1["emotion"] == "content"
    assert gen_1["speed"] == 0.9

    # Artifact arrives after first turn
    tts.update_from_artifact(_valid_artifact(
        voice_emotion_primary="proud",
        voice_speed="engaged",
    ))

    # Second turn: uses queued artifact
    await tts.stream_audio("Second.")
    call_2 = tts.client.tts.generate.call_args.kwargs
    assert call_2["generation_config"]["emotion"] == "excited"
    assert call_2["generation_config"]["speed"] == 1.05


# ── Constant validation tests ────────────────────────────────────


def test_speed_map_values_within_cartesia_range() -> None:
    """All speed values must be within Cartesia's 0.6–1.5 range."""
    for label, value in SPEED_MAP.items():
        assert 0.6 <= value <= 1.5, f"Speed '{label}' = {value} is out of range"


def test_cartesia_emotions_contains_primary_set() -> None:
    """The primary reliable set must be in our emotions frozenset."""
    primary_set = {"neutral", "angry", "excited", "content", "sad", "scared"}
    assert primary_set <= CARTESIA_EMOTIONS


@pytest.mark.anyio
async def test_stream_audio_passes_voice_and_model() -> None:
    """Basic params (model_id, voice, output_format) always present."""
    tts = _make_tts()

    await tts.stream_audio("Test.")

    call_kwargs = tts.client.tts.generate.call_args.kwargs
    assert call_kwargs["model_id"] == "sonic-3"
    assert call_kwargs["voice"] == {"id": "test-voice-id", "mode": "id"}
    assert call_kwargs["output_format"]["sample_rate"] == 16000


# ── Warm default tests ───────────────────────────────────────────


def test_warm_default_artifact_has_required_keys() -> None:
    assert "voice_emotion_primary" in WARM_DEFAULT_ARTIFACT
    assert "voice_speed" in WARM_DEFAULT_ARTIFACT
    assert WARM_DEFAULT_ARTIFACT["voice_emotion_primary"] in CARTESIA_EMOTIONS
    assert WARM_DEFAULT_ARTIFACT["voice_speed"] in SPEED_MAP


@pytest.mark.anyio
async def test_warm_default_replaced_after_real_artifact() -> None:
    """Once a real artifact arrives, warm default is no longer used."""
    tts = _make_tts()

    # Turn 1: warm default
    await tts.stream_audio("Hello.")
    gen_1 = tts.client.tts.generate.call_args.kwargs["generation_config"]
    assert gen_1["emotion"] == "content"

    # Real artifact arrives
    tts.update_from_artifact(_valid_artifact(voice_emotion_primary="excited", voice_speed="engaged"))
    assert tts._has_real_artifact is True

    # Turn 2: uses real artifact
    await tts.stream_audio("Great!")
    gen_2 = tts.client.tts.generate.call_args.kwargs["generation_config"]
    assert gen_2["emotion"] == "excited"
    assert gen_2["speed"] == 1.05


# ── Emotion hinting tests ────────────────────────────────────────


@pytest.mark.anyio
async def test_hint_from_angry_transcript() -> None:
    tts = _make_tts()
    tts.hint_emotion_from_transcript("I'm so angry right now!")

    assert tts._hint_emotion == "determined"
    assert tts._hint_speed == 1.0

    await tts.stream_audio("Name what makes you so angry.")
    gen = tts.client.tts.generate.call_args.kwargs["generation_config"]
    # Warm default emotion is "content" but hint overrides it
    assert gen["emotion"] == "determined"
    assert gen["speed"] == 1.0


@pytest.mark.anyio
async def test_hint_from_grief_transcript() -> None:
    tts = _make_tts()
    tts.hint_emotion_from_transcript("My grandmother passed away yesterday.")

    assert tts._hint_emotion == "sympathetic"
    assert tts._hint_speed == 0.8


@pytest.mark.anyio
async def test_hint_from_excited_transcript() -> None:
    tts = _make_tts()
    tts.hint_emotion_from_transcript("I got the job! I'm so happy!")

    assert tts._hint_emotion == "excited"
    assert tts._hint_speed == 1.05


@pytest.mark.anyio
async def test_hint_case_insensitive() -> None:
    tts = _make_tts()
    tts.hint_emotion_from_transcript("I AM SO ANGRY ABOUT THIS!")

    assert tts._hint_emotion == "determined"


@pytest.mark.anyio
async def test_hint_no_match_stays_none() -> None:
    tts = _make_tts()
    tts.hint_emotion_from_transcript("The weather is nice today.")

    assert tts._hint_emotion is None
    assert tts._hint_speed is None


@pytest.mark.anyio
async def test_hint_cleared_after_stream_audio() -> None:
    """Hint is one-shot: cleared after stream_audio uses it."""
    tts = _make_tts()
    tts.hint_emotion_from_transcript("I'm so angry!")

    # First call uses the hint
    await tts.stream_audio("Name what makes you so angry.")
    gen_1 = tts.client.tts.generate.call_args.kwargs["generation_config"]
    assert gen_1["emotion"] == "determined"

    # Second call: hint cleared, falls back to warm default
    await tts.stream_audio("Tell me more.")
    gen_2 = tts.client.tts.generate.call_args.kwargs["generation_config"]
    assert gen_2["emotion"] == "content"  # warm default


@pytest.mark.anyio
async def test_artifact_overrides_hint() -> None:
    """Real artifact always wins over hint."""
    tts = _make_tts()
    tts.hint_emotion_from_transcript("I'm so angry!")

    # Artifact arrives before stream_audio
    tts.update_from_artifact(_valid_artifact(voice_emotion_primary="sympathetic"))

    # Hint should have been cleared by update_from_artifact
    assert tts._hint_emotion is None

    await tts.stream_audio("Let's talk.")
    gen = tts.client.tts.generate.call_args.kwargs["generation_config"]
    assert gen["emotion"] == "sympathetic"  # artifact, not hint


@pytest.mark.anyio
async def test_hint_used_when_artifact_emotion_invalid() -> None:
    """If artifact has invalid emotion, hint fills the gap."""
    tts = _make_tts()
    tts._hint_emotion = "calm"
    tts._hint_speed = 0.9
    tts.update_from_artifact(_valid_artifact(
        voice_emotion_primary="joking/comedic",
        voice_emotion_secondary="joking/comedic",
    ))
    # update_from_artifact clears hint, so re-set it after
    tts._hint_emotion = "calm"
    tts._hint_speed = 0.9

    await tts.stream_audio("Test.")
    gen = tts.client.tts.generate.call_args.kwargs["generation_config"]
    # Both artifact emotions invalid → falls to hint
    assert gen["emotion"] == "calm"
    assert gen["speed"] == 0.9


def test_emotion_hint_rules_use_valid_cartesia_emotions() -> None:
    """Every emotion in _EMOTION_HINT_RULES must be in CARTESIA_EMOTIONS."""
    for _pattern, emotion, _speed in _EMOTION_HINT_RULES:
        assert emotion in CARTESIA_EMOTIONS, f"Hint emotion '{emotion}' not in Cartesia set"
