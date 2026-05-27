from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

TRUST_SESSION_THRESHOLD = 5
MAX_RECURRING_PATTERN_COUNT = 3
MAX_RECURRING_PATTERN_CHARS = 96
VOICE_SKILL_STATE_SEED_SCHEMA = "voice_skill_state_seed_v1"

TONE_BANDS = {
    "shutdown",
    "grief_fear",
    "anger_antagonism",
    "engagement",
    "enthusiasm",
}

ALWAYS_IN_BOUNDS_SKILLS = (
    "active_listening",
    "crisis_redirect",
)

LIVE_MOMENT_SKILLS = (
    "trust_building",
    "vulnerability_holding",
    "boundary_holding",
    "identity_fluidity_support",
    "celebrating_breakthrough",
)


@dataclass(frozen=True)
class VoiceSkillSlowStateSeed:
    session_count: int | None = None
    trust_established: bool | None = None
    recurring_patterns: tuple[str, ...] = ()
    recurring_patterns_known: bool = False
    prior_tone_band: str | None = None


def build_voice_skill_state_seed_block(seed: VoiceSkillSlowStateSeed | None = None) -> str:
    """Render the dynamic voice skill slow-state seed block.

    The seed is setup-time state. It must be appended after stable prompt text,
    never baked into the cached prompt prefix.
    """
    normalized = normalize_voice_skill_slow_state_seed(seed)
    session_count = _format_session_count(normalized.session_count)
    trust_established = _format_optional_bool(normalized.trust_established)
    recurring_patterns = _format_recurring_patterns(normalized)
    prior_tone_band = normalized.prior_tone_band or "unknown"
    default_posture = _default_posture(normalized)
    challenging_growth_allowed = _challenging_growth_allowed(normalized)
    challenging_growth_reason = _challenging_growth_reason(normalized)
    in_bounds = _format_in_bounds(challenging_growth_allowed)
    out_of_bounds = "none" if challenging_growth_allowed else f"challenging_growth ({challenging_growth_reason})"

    return "\n".join(
        [
            "### Voice Skill State",
            "This state conditions which emotional skills are in bounds. Use it as slow structural context, not as a replacement for listening to the user live.",
            "",
            f"- session_count: {session_count}",
            f"- trust_established: {trust_established}",
            f"- recurring_patterns: {recurring_patterns}",
            f"- prior_tone_band: {prior_tone_band}",
            f"- default_posture: {default_posture}",
            f"- challenging_growth_allowed: {_format_bool(challenging_growth_allowed)}",
            f"- challenging_growth_reason: {challenging_growth_reason}",
            f"- in_bounds: {in_bounds}",
            f"- out_of_bounds: {out_of_bounds}",
            "- crisis_override: always in bounds",
            "",
            "Rules:",
            "The model still reads the live emotional moment.",
            "Harness state only gates slow structural appropriateness.",
            "active_listening is always in bounds.",
            "crisis_redirect is always in bounds and overrides everything.",
            "trust_building is preferred/default in early sessions or unknown trust.",
            "challenging_growth is out of bounds unless trust is established and there is a recurring pattern.",
            "vulnerability_holding, boundary_holding, identity_fluidity_support, and celebrating_breakthrough remain available when the live moment clearly calls for them.",
            "prior_tone_band is only an opening prior; live user tone wins.",
            "If state is unknown, choose conservative defaults: trust_established unknown, challenging_growth_allowed false, default_posture trust_building.",
        ]
    )


def normalize_voice_skill_slow_state_seed(
    seed: VoiceSkillSlowStateSeed | None,
) -> VoiceSkillSlowStateSeed:
    if seed is None:
        return VoiceSkillSlowStateSeed()
    return VoiceSkillSlowStateSeed(
        session_count=_normalize_session_count(seed.session_count),
        trust_established=seed.trust_established if isinstance(seed.trust_established, bool) else None,
        recurring_patterns=_bounded_pattern_summaries(seed.recurring_patterns),
        recurring_patterns_known=bool(seed.recurring_patterns_known),
        prior_tone_band=_normalize_tone_band(seed.prior_tone_band),
    )


def voice_skill_slow_state_seed_diagnostics(
    seed: VoiceSkillSlowStateSeed | None = None,
) -> dict[str, object]:
    normalized = normalize_voice_skill_slow_state_seed(seed)
    challenging_growth_allowed = _challenging_growth_allowed(normalized)
    return {
        "schema": VOICE_SKILL_STATE_SEED_SCHEMA,
        "session_count_known": normalized.session_count is not None,
        "session_count": normalized.session_count,
        "trust_established": normalized.trust_established,
        "recurring_patterns_known": normalized.recurring_patterns_known,
        "recurring_pattern_count": len(normalized.recurring_patterns),
        "prior_tone_band": normalized.prior_tone_band or "unknown",
        "default_posture": _default_posture(normalized),
        "challenging_growth_allowed": challenging_growth_allowed,
        "challenging_growth_reason": _challenging_growth_reason(normalized),
        "active_listening_always_in_bounds": True,
        "crisis_override_always_in_bounds": True,
        "raw_unbounded_memory_text_included": False,
    }


def voice_skill_slow_state_seed_from_setup_context(
    *,
    identity_text: str | None = None,
    handoff_text: str | None = None,
    memory_snippets: Iterable[object] | None = None,
    recurring_patterns_known: bool = False,
) -> VoiceSkillSlowStateSeed:
    combined_text = "\n".join(text for text in (identity_text, handoff_text) if text)
    return VoiceSkillSlowStateSeed(
        session_count=_extract_session_count(combined_text),
        trust_established=_extract_trust_established(combined_text),
        recurring_patterns=_extract_recurring_patterns(memory_snippets),
        recurring_patterns_known=recurring_patterns_known,
        prior_tone_band=_extract_prior_tone_band(combined_text),
    )


def _default_posture(seed: VoiceSkillSlowStateSeed) -> str:
    if seed.trust_established is not True:
        return "trust_building"
    if seed.session_count is not None and seed.session_count < TRUST_SESSION_THRESHOLD:
        return "trust_building"
    return "active_listening"


def _challenging_growth_allowed(seed: VoiceSkillSlowStateSeed) -> bool:
    return seed.trust_established is True and bool(seed.recurring_patterns)


def _challenging_growth_reason(seed: VoiceSkillSlowStateSeed) -> str:
    if seed.trust_established is not True and not seed.recurring_patterns_known:
        return "trust/pattern evidence unavailable"
    if seed.trust_established is not True:
        return "trust is not established"
    if not seed.recurring_patterns_known:
        return "recurring pattern evidence unavailable"
    if not seed.recurring_patterns:
        return "no recurring pattern evidence"
    return "trust established and recurring pattern evidence present"


def _format_in_bounds(challenging_growth_allowed: bool) -> str:
    skills = [
        "active_listening (always)",
        "crisis_redirect (override)",
        "trust_building (default for early/unknown trust)",
        "vulnerability_holding",
        "boundary_holding",
        "identity_fluidity_support",
        "celebrating_breakthrough",
    ]
    if challenging_growth_allowed:
        skills.append("challenging_growth")
    return "; ".join(skills)


def _format_session_count(value: int | None) -> str:
    return str(value) if value is not None else "unknown"


def _format_optional_bool(value: bool | None) -> str:
    if value is None:
        return "unknown"
    return _format_bool(value)


def _format_bool(value: bool) -> str:
    return "true" if value else "false"


def _format_recurring_patterns(seed: VoiceSkillSlowStateSeed) -> str:
    if not seed.recurring_patterns_known:
        return "unknown"
    if not seed.recurring_patterns:
        return "none"
    return "; ".join(seed.recurring_patterns)


def _normalize_session_count(value: int | None) -> int | None:
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    if value < 0:
        return None
    return min(value, 9999)


def _normalize_tone_band(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    return normalized if normalized in TONE_BANDS else None


def _bounded_pattern_summaries(values: Iterable[str] | None) -> tuple[str, ...]:
    if values is None:
        return ()
    summaries: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        summary = " ".join(value.split())
        if not summary:
            continue
        if len(summary) > MAX_RECURRING_PATTERN_CHARS:
            summary = summary[: MAX_RECURRING_PATTERN_CHARS - 3].rstrip() + "..."
        fingerprint = summary.lower()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        summaries.append(summary)
        if len(summaries) >= MAX_RECURRING_PATTERN_COUNT:
            break
    return tuple(summaries)


def _extract_session_count(text: str) -> int | None:
    if not text:
        return None
    match = re.search(
        r"(?im)\b(?:session[_ -]?count|sessions[_ -]?total|sessions)\s*[:=]\s*(\d{1,4})\b",
        text,
    )
    if match is None:
        return None
    return _normalize_session_count(int(match.group(1)))


def _extract_trust_established(text: str) -> bool | None:
    if not text:
        return None
    match = re.search(
        r"(?im)\btrust[_ -]?established\s*[:=]\s*(true|false|yes|no)\b",
        text,
    )
    if match is None:
        return None
    return match.group(1).lower() in {"true", "yes"}


def _extract_prior_tone_band(text: str) -> str | None:
    if not text:
        return None
    for pattern in (
        r"(?im)\bprior[_ -]?tone[_ -]?band\s*[:=]\s*([A-Za-z_ -]+)",
        r"(?im)\bactive[_ -]?tone[_ -]?band\s*[:=]\s*([A-Za-z_ -]+)",
        r"(?im)\btone[_ -]?band\s*[:=]\s*([A-Za-z_ -]+)",
    ):
        match = re.search(pattern, text)
        if match is None:
            continue
        tone_band = _normalize_tone_band(match.group(1))
        if tone_band is not None:
            return tone_band
    return None


def _extract_recurring_patterns(memory_snippets: Iterable[object] | None) -> tuple[str, ...]:
    if memory_snippets is None:
        return ()
    pattern_values: list[str] = []
    for snippet in memory_snippets:
        category = _snippet_value(snippet, "category")
        if not isinstance(category, str) or category.strip().lower() != "pattern":
            continue
        content = _snippet_value(snippet, "content") or _snippet_value(snippet, "memory")
        if isinstance(content, str):
            pattern_values.append(content)
    return _bounded_pattern_summaries(pattern_values)


def _snippet_value(snippet: object, key: str) -> Any:
    if isinstance(snippet, Mapping):
        return snippet.get(key)
    return getattr(snippet, key, None)