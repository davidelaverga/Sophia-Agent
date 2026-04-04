from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping


SAFE_FAMILIES = {"celebratory", "challenging", "reflective", "steady", "supportive"}
SAFE_SPEED_LABELS = {"slow", "gentle", "normal", "engaged", "energetic"}

_SUPPORTIVE_EMOTIONS = {
    "affectionate",
    "calm",
    "grateful",
    "peaceful",
    "serene",
    "sympathetic",
    "trust",
}
_STEADY_EMOTIONS = {"content", "neutral"}
_REFLECTIVE_EMOTIONS = {"anticipation", "contemplative", "curious", "mysterious"}
_CHALLENGING_EMOTIONS = {"confident", "determined"}
_CELEBRATORY_EMOTIONS = {"amazed", "elated", "enthusiastic", "euphoric", "excited", "happy", "proud", "triumphant"}
_DISTRESSED_EMOTIONS = {
    "alarmed",
    "anxious",
    "confused",
    "dejected",
    "disappointed",
    "guilty",
    "hesitant",
    "hurt",
    "insecure",
    "melancholic",
    "panicked",
    "rejected",
    "resigned",
    "sad",
    "scared",
    "tired",
}
_URGENT_EMOTIONS = {"agitated", "angry", "frustrated", "mad", "outraged", "threatened"}
_GUARDED_EMOTIONS = {"contempt", "distant", "disgusted", "envious", "flirtatious", "ironic", "sarcastic", "skeptical"}

_SUPPORTIVE_PATTERNS = [
    re.compile(r"\b(i'?m here|with you|take your time|that makes sense|you don'?t have to)\b", re.I),
    re.compile(r"\b(i hear you|i can see why|of course|i'm sorry|that sounds)\b", re.I),
    re.compile(r"\b(let'?s slow (it )?down|slow it down for a second)\b", re.I),
]
_CELEBRATORY_PATTERNS = [
    re.compile(r"\b(you did it|that'?s huge|i'?m proud of you|we made it|good news)\b", re.I),
    re.compile(r"\b(congratulations|amazing|beautiful|incredible)\b", re.I),
]
_USER_CELEBRATORY_PATTERNS = [
    re.compile(r"\b(got the (job|offer|promotion)|we (won|made it|did it)|i did it)\b", re.I),
    re.compile(r"\b(can'?t believe (it )?(worked|happened|went through|got it))\b", re.I),
    re.compile(
        r"\b(still )?can(?:not|'?t)? believe it\b.*\b(it actually happened|actually happened|it happened)\b",
        re.I,
    ),
    re.compile(
        r"\b(?:believe it|leave it)\b.*\b(it actually happened|actually happened|it happened)\b",
        re.I,
    ),
    re.compile(r"\btoday\b.*\b(?:still )?can(?:not|'?t)? believe it\b", re.I),
    re.compile(r"\b(so (happy|excited|proud)|amazing news|good news)\b", re.I),
]
_CHALLENGING_PATTERNS = [
    re.compile(r"\b(be honest|name it|the pattern|what would happen if|let'?s stop)\b", re.I),
    re.compile(r"\b(what do you want|what is it actually about|tell the truth)\b", re.I),
    re.compile(r"\b(say it without|without the [\"'“”]?but[\"'“”]?|finish (?:it|the sentence))\b", re.I),
    re.compile(r"\bjust the [a-z][a-z' -]* part\b", re.I),
]
_USER_CHALLENGING_PATTERNS = [
    re.compile(r"\b(why do i keep|i keep (?:doing|ending up)|same pattern|stuck in)\b", re.I),
    re.compile(r"\b(i want .* but .* keep|jealous|resentful|envy|envying)\b", re.I),
    re.compile(r"\b(can'?t stop comparing|always comparing)\b", re.I),
]
_REFLECTIVE_PATTERNS = [
    re.compile(r"\b(what|how|where|when|why)\b.*\?", re.I),
    re.compile(r"\b(i wonder|what do you think|what does that)\b", re.I),
]
_USER_SUPPORTIVE_PATTERNS = [
    re.compile(r"\b(passed away|died|lost (him|her|them|my)|heartbroken|devastated)\b", re.I),
    re.compile(r"\b(scared|terrified|panicking|anxious|overwhelmed|crying)\b", re.I),
    re.compile(r"\b(feel(?:ing)? (empty|numb|broken|hopeless)|can'?t go on)\b", re.I),
    re.compile(r"\bimportant to me\b.*\bdon'?t know (?:how )?to make sense (?:of|with) it\b", re.I),
]


@dataclass(frozen=True)
class ResolvedVoiceDelivery:
    family: str
    emotion: str
    speed_label: str


def classify_emotion_family(emotion: str | None) -> str | None:
    if not emotion:
        return None

    normalized = emotion.strip().lower()
    if normalized in _SUPPORTIVE_EMOTIONS:
        return "supportive"
    if normalized in _STEADY_EMOTIONS:
        return "steady"
    if normalized in _REFLECTIVE_EMOTIONS:
        return "reflective"
    if normalized in _CHALLENGING_EMOTIONS:
        return "challenging"
    if normalized in _CELEBRATORY_EMOTIONS:
        return "celebratory"
    if normalized in _DISTRESSED_EMOTIONS:
        return "distressed"
    if normalized in _URGENT_EMOTIONS:
        return "urgent"
    if normalized in _GUARDED_EMOTIONS:
        return "guarded"
    return None


def classify_response_intent(text: str) -> str | None:
    if any(pattern.search(text) for pattern in _CELEBRATORY_PATTERNS):
        return "celebratory"
    if any(pattern.search(text) for pattern in _SUPPORTIVE_PATTERNS):
        return "supportive"
    if any(pattern.search(text) for pattern in _CHALLENGING_PATTERNS):
        return "challenging"
    if any(pattern.search(text) for pattern in _REFLECTIVE_PATTERNS) or text.strip().endswith("?"):
        return "reflective"
    return None


def classify_user_transcript(text: str | None) -> str | None:
    if not text:
        return None

    if any(pattern.search(text) for pattern in _USER_CELEBRATORY_PATTERNS):
        return "celebratory"
    if any(pattern.search(text) for pattern in _USER_SUPPORTIVE_PATTERNS):
        return "supportive"
    if any(pattern.search(text) for pattern in _USER_CHALLENGING_PATTERNS):
        return "challenging"
    return None


def resolve_voice_delivery(
    *,
    assistant_text: str,
    has_real_artifact: bool = False,
    hinted_emotion: str | None,
    hinted_speed_label: str | None,
    queued_artifact: Mapping[str, Any] | None,
    user_transcript: str | None = None,
) -> ResolvedVoiceDelivery:
    artifact = dict(queued_artifact or {})
    emitted_family = classify_emotion_family(_as_string(artifact.get("voice_emotion_primary")))
    secondary_family = classify_emotion_family(_as_string(artifact.get("voice_emotion_secondary")))
    response_family = classify_response_intent(assistant_text)
    user_family = _classify_user_signal(hinted_emotion)
    user_text_family = classify_user_transcript(user_transcript)
    context_family = _classify_context(artifact)

    scores = {
        "celebratory": 0,
        "challenging": 0,
        "reflective": 0,
        "steady": 1,
        "supportive": 0,
    }

    if response_family in SAFE_FAMILIES:
        scores[response_family] += 3
    if user_text_family in SAFE_FAMILIES:
        scores[user_text_family] += 3
    if user_family in SAFE_FAMILIES:
        scores[user_family] += 2
    if context_family in SAFE_FAMILIES:
        scores[context_family] += 2
    if emitted_family in SAFE_FAMILIES:
        scores[emitted_family] += 1
    elif secondary_family in SAFE_FAMILIES:
        scores[secondary_family] += 1

    family = max(scores, key=scores.get)
    if response_family and scores[response_family] == scores[family]:
        family = response_family
    elif user_text_family in SAFE_FAMILIES and scores[user_text_family] == scores[family]:
        family = user_text_family
    elif user_family in SAFE_FAMILIES and scores[user_family] == scores[family]:
        family = user_family
    elif emitted_family in SAFE_FAMILIES and scores[emitted_family] == scores[family]:
        family = emitted_family

    if emitted_family in {"distressed", "guarded", "urgent"} and family not in {"celebratory", "challenging"}:
        family = "supportive" if user_family == "supportive" or context_family == "supportive" else "steady"

    if user_family == "supportive" and family in {"celebratory", "challenging"} and response_family != family:
        family = "supportive"

    return ResolvedVoiceDelivery(
        family=family,
        emotion=_resolve_emotion(family, assistant_text, artifact),
        speed_label=_resolve_speed_label(
            family,
            has_real_artifact,
            _as_string(artifact.get("voice_speed")),
            hinted_speed_label,
        ),
    )


def _as_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _classify_context(artifact: Mapping[str, Any]) -> str | None:
    tone_band = _as_string(artifact.get("active_tone_band"))
    skill = _as_string(artifact.get("skill_loaded"))
    ritual_phase = _as_string(artifact.get("ritual_phase"))

    if tone_band == "grief_fear":
        return "supportive"
    if tone_band == "enthusiasm":
        return "celebratory"
    if skill in {"boundary_holding", "challenging_growth"}:
        return "challenging"
    if skill in {"trust_building", "vulnerability_holding"}:
        return "supportive"
    if ritual_phase and ritual_phase.startswith("vent"):
        return "supportive"
    emitted_family = classify_emotion_family(_as_string(artifact.get("voice_emotion_primary")))
    return None if emitted_family == "steady" else emitted_family


def _classify_user_signal(hinted_emotion: str | None) -> str | None:
    family = classify_emotion_family(hinted_emotion)
    if family in {"distressed", "guarded", "urgent"}:
        return "supportive"
    return family


def _resolve_emotion(
    family: str,
    assistant_text: str,
    artifact: Mapping[str, Any],
) -> str:
    emitted = _as_string(artifact.get("voice_emotion_primary"))
    secondary = _as_string(artifact.get("voice_emotion_secondary"))
    if family == "supportive":
        if emitted in {"calm", "sympathetic"}:
            return emitted
        if secondary in {"calm", "sympathetic"}:
            return secondary
        return "sympathetic" if any(pattern.search(assistant_text) for pattern in _SUPPORTIVE_PATTERNS) else "calm"
    if family == "reflective":
        if emitted in {"curious", "contemplative"}:
            return emitted
        if secondary in {"curious", "contemplative"}:
            return secondary
        return "curious" if assistant_text.strip().endswith("?") else "contemplative"
    if family == "challenging":
        if secondary == "confident":
            return secondary
        return "confident" if emitted == "confident" else "determined"
    if family == "celebratory":
        if secondary == "excited":
            return secondary
        return "excited"
    return "content"


def _resolve_speed_label(
    family: str,
    has_real_artifact: bool,
    artifact_speed_label: str | None,
    hinted_speed_label: str | None,
) -> str:
    if has_real_artifact:
        preferred = artifact_speed_label if artifact_speed_label in SAFE_SPEED_LABELS else hinted_speed_label
    else:
        preferred = hinted_speed_label if hinted_speed_label in SAFE_SPEED_LABELS else artifact_speed_label

    if family == "supportive":
        if preferred in {"slow", "gentle", "normal"}:
            return preferred
        return "gentle"
    if family == "reflective":
        if preferred in {"gentle", "normal"}:
            return preferred
        return "normal"
    if family == "challenging":
        if preferred in {"normal", "engaged"}:
            return preferred
        return "engaged"
    if family == "celebratory":
        if preferred in {"engaged", "energetic"}:
            return preferred
        return "engaged"
    if preferred in {"gentle", "normal"}:
        return preferred
    return "normal"