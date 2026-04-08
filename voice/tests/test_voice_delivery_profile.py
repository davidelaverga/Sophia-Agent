from __future__ import annotations

from voice.voice_delivery_profile import classify_user_transcript, resolve_voice_delivery


def _artifact(**overrides):
    artifact = {
        "active_tone_band": "engagement",
        "ritual_phase": "freeform.testing",
        "skill_loaded": "active_listening",
        "voice_emotion_primary": "content",
        "voice_speed": "normal",
    }
    artifact.update(overrides)
    return artifact


def test_grief_signal_resolves_supportive_profile() -> None:
    delivery = resolve_voice_delivery(
        assistant_text="I'm here with you. Take your time.",
        hinted_emotion="sympathetic",
        hinted_speed_label="gentle",
        queued_artifact=_artifact(
            active_tone_band="grief_fear",
            voice_emotion_primary="sad",
            voice_speed="slow",
        ),
    )

    assert delivery.family == "supportive"
    assert delivery.emotion in {"calm", "sympathetic"}
    assert delivery.emotion not in {"sad", "scared"}
    assert delivery.speed_label in {"slow", "gentle"}


def test_celebration_signal_resolves_companion_safe_celebration() -> None:
    delivery = resolve_voice_delivery(
        assistant_text="You did it. That's huge.",
        hinted_emotion="excited",
        hinted_speed_label="engaged",
        queued_artifact=_artifact(
            active_tone_band="enthusiasm",
            voice_emotion_primary="proud",
            voice_speed="energetic",
        ),
    )

    assert delivery.family == "celebratory"
    assert delivery.emotion == "excited"
    assert delivery.speed_label in {"engaged", "energetic"}


def test_classify_user_transcript_treats_noisy_today_disbelief_as_celebratory() -> None:
    assert classify_user_transcript("it today. and I still can believe it.") == "celebratory"


def test_classify_user_transcript_treats_dropped_prefix_breakthrough_as_celebratory() -> None:
    assert classify_user_transcript("and believe it, it actually happened.") == "celebratory"


def test_classify_user_transcript_treats_leave_it_residue_as_celebratory() -> None:
    assert classify_user_transcript("leave it, it actually happened.") == "celebratory"


def test_classify_user_transcript_treats_degraded_make_sense_grief_as_supportive() -> None:
    assert (
        classify_user_transcript("important to me. I still don't know to make sense with it.")
        == "supportive"
    )


def test_reflective_question_prefers_reflective_delivery() -> None:
    delivery = resolve_voice_delivery(
        assistant_text="What do you think that feeling is pointing at?",
        hinted_emotion=None,
        hinted_speed_label=None,
        queued_artifact=_artifact(
            voice_emotion_primary="curious",
            voice_speed="normal",
        ),
    )

    assert delivery.family == "reflective"
    assert delivery.emotion in {"curious", "contemplative"}
    assert delivery.speed_label == "normal"


def test_truth_telling_prompt_prefers_challenging_delivery() -> None:
    delivery = resolve_voice_delivery(
        assistant_text="You're catching yourself. Say it without the \"but\" — just the jealousy part.",
        hinted_emotion=None,
        hinted_speed_label=None,
        queued_artifact=_artifact(
            active_tone_band="antagonism",
            voice_emotion_primary="calm",
            voice_speed="normal",
        ),
    )

    assert delivery.family == "challenging"
    assert delivery.emotion in {"confident", "determined"}
    assert delivery.speed_label in {"normal", "engaged"}


def test_conflicting_signal_falls_back_to_safe_steady_profile() -> None:
    delivery = resolve_voice_delivery(
        assistant_text="Let's slow it down for a second.",
        hinted_emotion="excited",
        hinted_speed_label="energetic",
        queued_artifact=_artifact(
            voice_emotion_primary="outraged",
            voice_speed="energetic",
        ),
    )

    assert delivery.family in {"steady", "supportive"}
    assert delivery.emotion in {"content", "calm", "sympathetic"}
    assert delivery.speed_label in {"gentle", "normal"}


def test_rare_artifact_literal_downgrades_safely() -> None:
    delivery = resolve_voice_delivery(
        assistant_text="I'm here with you.",
        hinted_emotion=None,
        hinted_speed_label=None,
        queued_artifact=_artifact(
            voice_emotion_primary="outraged",
            voice_emotion_secondary="angry",
            voice_speed="energetic",
        ),
    )

    assert delivery.family in {"steady", "supportive"}
    assert delivery.emotion not in {"outraged", "angry"}