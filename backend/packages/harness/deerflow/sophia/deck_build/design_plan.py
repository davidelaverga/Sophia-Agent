from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any

from deerflow.sophia.deck_build.models import (
    DeckColorToken,
    DeckDesignPlan,
    DeckGridPlan,
    DeckTypographyPlan,
)

PX_PER_IN = 96
NATIVE_SLIDE_WIDTH_IN = 20
NATIVE_SLIDE_HEIGHT_IN = 11.25
NATIVE_SLIDE_WIDTH_PX = int(NATIVE_SLIDE_WIDTH_IN * PX_PER_IN)
NATIVE_SLIDE_HEIGHT_PX = int(NATIVE_SLIDE_HEIGHT_IN * PX_PER_IN)

_SUBSTRATE_ROLE = r"(?:background|substrate|canvas|deck|slides?|theme)"
_LIGHT_SUBSTRATE_TOKEN = (
    r"(?:warm\s+ivory|soft\s+ivory|off\s+white|light|bright|daylight|white|ivory|cream|eggshell|parchment)"
)
_DARK_SUBSTRATE_TOKEN = (
    r"(?:ink\s+black|near\s+black|dark\s+(?:charcoal|navy|blue|green|brown|gray|grey)|dark|charcoal|black|blueprint|terminal|night|midnight|cyber|command\s+center)"
)
_FOREGROUND_ROLE = r"(?:body\s+text|text|type|typography|foreground|accents?|linework|copy|lettering)"
_NEGATION_START_RE = re.compile(
    r"\b(?:instead\s+of|rather\s+than|anything\s+but|do\s+not|don\s+t|no|not|never|without|avoid(?:ed|ing|s)?)\b",
    re.I,
)
_POSITIVE_DIRECTIVE_BOUNDARY_RE = re.compile(
    r"\b(?:"
    r"(?:and|but|then|comma)\s+"
    r"(?:use|using|make|render|choose|set|keep|create|build|apply|prefer|switch|go)\b"
    rf"|but\s+(?:(?:a|an|the)\s+)?(?:{_LIGHT_SUBSTRATE_TOKEN}|{_DARK_SUBSTRATE_TOKEN})\b"
    r")",
    re.I,
)
_SUBSTRATE_FILLER = r"(?:editorial|clean|calm|soft|solid|opaque|slide)"
_SUBSTRATE_CONNECTOR = r"(?:color|is|uses?|on|in|of|to|as|a|an)"
_EXPLICIT_LIGHT_SUBSTRATE_RES = (
    re.compile(
        rf"\b{_LIGHT_SUBSTRATE_TOKEN}\b(?:\s+{_SUBSTRATE_FILLER})?\s+\b{_SUBSTRATE_ROLE}\b",
        re.I,
    ),
    re.compile(
        rf"\b{_SUBSTRATE_ROLE}\b(?:\s+{_SUBSTRATE_CONNECTOR}){{0,3}}\s+"
        rf"\b{_LIGHT_SUBSTRATE_TOKEN}\b(?!\s+{_FOREGROUND_ROLE}\b)",
        re.I,
    ),
)
_EXPLICIT_DARK_SUBSTRATE_RES = (
    re.compile(
        rf"\b{_DARK_SUBSTRATE_TOKEN}\b(?:\s+{_SUBSTRATE_FILLER})?\s+\b{_SUBSTRATE_ROLE}\b",
        re.I,
    ),
    re.compile(
        rf"\b{_SUBSTRATE_ROLE}\b(?:\s+{_SUBSTRATE_CONNECTOR}){{0,3}}\s+"
        rf"\b{_DARK_SUBSTRATE_TOKEN}\b(?!\s+{_FOREGROUND_ROLE}\b)",
        re.I,
    ),
)
_FOREGROUND_COLOR_RE = re.compile(
    rf"\b(?:{_LIGHT_SUBSTRATE_TOKEN}|{_DARK_SUBSTRATE_TOKEN})\b\s+\b{_FOREGROUND_ROLE}\b"
    rf"|\b{_FOREGROUND_ROLE}\b(?:\s+(?:color|is|in|uses?)){{0,2}}\s+"
    rf"\b(?:{_LIGHT_SUBSTRATE_TOKEN}|{_DARK_SUBSTRATE_TOKEN})\b",
    re.I,
)
_BARE_INK_BLACK_RE = re.compile(r"\b(?:ink\s+black|black\s+ink)\b", re.I)
_STYLE_CLAUSE_SPLIT_RE = re.compile(r"[;.!?\n]+")
_LIGHT_RE = re.compile(rf"\b{_LIGHT_SUBSTRATE_TOKEN}\b", re.I)
_DARK_RE = re.compile(rf"\b{_DARK_SUBSTRATE_TOKEN}\b", re.I)
_EXEC_RE = re.compile(r"\b(executive|board|strategy|investor|leadership)\b", re.I)
_EXPRESSIVE_RE = re.compile(r"\b(expressive|keynote|launch|cinematic)\b", re.I)
_KNOWN_STYLE_PROFILE_KEYS = {
    "aesthetic",
    "background",
    "brand",
    "color",
    "colors",
    "font",
    "mood",
    "palette",
    "style",
    "tone",
    "visual_style",
}


def resolve_deck_design_plan(
    *,
    deck_title: str,
    slides: list[dict[str, Any]],
    register: str,
    style_profile: dict[str, Any] | None,
    design_plan: dict[str, Any] | None,
    request_context: str,
) -> DeckDesignPlan:
    """Resolve user/style hints into deterministic deck design tokens."""

    style_profile = style_profile or {}
    normalized_style_profile = normalize_deck_style_profile(style_profile)
    explicit_text = _stringify_known_values(design_plan or {})
    style_text = _stringify_known_values(normalized_style_profile)
    slide_text = "\n".join(str(slide.get("title") or "") for slide in slides[:3])
    haystack = "\n".join([explicit_text, request_context, style_text, deck_title, slide_text])
    substrate_intent = (
        classify_substrate_intent(request_context)
        or classify_substrate_intent(design_plan or {})
        or classify_substrate_intent(normalized_style_profile)
        or classify_substrate_intent("\n".join([deck_title, slide_text]))
    )
    dark_requested = substrate_intent == "dark"
    executive_requested = bool(_EXEC_RE.search(haystack)) or register == "executive"
    expressive_requested = bool(_EXPRESSIVE_RE.search(haystack)) or register == "expressive"

    if dark_requested:
        style_lane = "technical_blueprint"
        palette = _dark_technical_palette()
        typography = DeckTypographyPlan(display="Cambria", body="Calibri", utility="Calibri")
        signature = "dark substrate, precise cyan accents, native linework"
        rhythm = "high-contrast claims with disciplined diagram bands"
    elif executive_requested:
        style_lane = "executive_editorial"
        palette = _executive_palette()
        typography = DeckTypographyPlan(display="Cambria", body="Calibri")
        signature = "quiet editorial substrate, strong headline hierarchy"
        rhythm = "wide margins, evidence blocks, decisive synthesis"
    elif expressive_requested:
        style_lane = "expressive_keynote"
        palette = _expressive_palette()
        typography = DeckTypographyPlan(display="Cambria", body="Calibri")
        signature = "confident color accents with native editorial shapes"
        rhythm = "alternating hero, proof, and synthesis moments"
    else:
        style_lane = "calm_technical"
        palette = _calm_technical_palette()
        typography = DeckTypographyPlan(display="Cambria", body="Calibri")
        signature = "clean technical substrate with restrained accent geometry"
        rhythm = "claim-first slides with native diagrams and measured whitespace"

    return DeckDesignPlan(
        source="explicit_request" if design_plan else "request_and_style_profile",
        subject=_clean_subject(deck_title),
        audience=str((design_plan or {}).get("audience") or "technical stakeholders"),
        goal=str((design_plan or {}).get("goal") or "explain the system clearly and persuasively"),
        style_lane=style_lane,
        palette=palette,
        typography=typography,
        grid=DeckGridPlan(slide_width_px=NATIVE_SLIDE_WIDTH_PX, slide_height_px=NATIVE_SLIDE_HEIGHT_PX),
        signature=signature,
        rhythm=rhythm,
        anti_slop_profile=[
            "native text remains real text",
            "generated imagery is asset-only",
            "no screenshot-backed slide substrate",
            "no image-baked title or narrative",
        ],
        requested_style_terms=_requested_style_terms(
            haystack,
            substrate_intent=substrate_intent,
        ),
        normalized_from_style_profile=normalized_style_profile,
    )


def design_token(plan: DeckDesignPlan, name: str, fallback: str = "#000000") -> str:
    for token in plan.palette:
        if token.name == name:
            return token.hex
    return fallback


def write_design_plan(plan: DeckDesignPlan, host_path: Path) -> None:
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(json.dumps(asdict(plan), indent=2), encoding="utf-8")


def normalize_deck_style_profile(style_profile: dict[str, Any]) -> dict[str, Any]:
    return {
        str(key): value
        for key, value in style_profile.items()
        if str(key) in _KNOWN_STYLE_PROFILE_KEYS and _safe_style_value(value) is not None
    }


def _safe_style_value(value: Any) -> Any:
    if isinstance(value, str):
        return value[:240]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_safe_style_value(item) for item in value[:12]]
    if isinstance(value, dict):
        return {str(key): _safe_style_value(item) for key, item in list(value.items())[:12]}
    return None


def _stringify_known_values(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(_stringify_known_values(item) for item in value.values())
    if isinstance(value, (list, tuple, set)):
        return "\n".join(_stringify_known_values(item) for item in value)
    if value is None:
        return ""
    return str(value)


def _clean_subject(deck_title: str) -> str:
    subject = re.sub(r"\s+", " ", deck_title).strip()
    return subject[:120] or "presentation"


def classify_substrate_intent(text: Any) -> str | None:
    """Classify canvas intent without mistaking foreground colors for a substrate."""

    if isinstance(text, (dict, list, tuple, set)):
        try:
            raw = json.dumps(text, ensure_ascii=False, sort_keys=False)
        except (TypeError, ValueError):
            raw = str(text)
    else:
        raw = str(text or "")
    clauses = _STYLE_CLAUSE_SPLIT_RE.split(re.sub(r"[_/\-]+", " ", raw.casefold()))
    explicit_matches: list[tuple[int, str]] = []
    cursor = 0
    normalized_clauses: list[str] = []
    for clause in clauses:
        clause = clause.replace(",", " comma ")
        normalized = re.sub(r"[^\w\s]+", " ", clause)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        normalized = _strip_negated_style_scopes(normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if not normalized:
            cursor += len(clause) + 1
            continue
        normalized_clauses.append(normalized)
        for intent, patterns in (
            ("light", _EXPLICIT_LIGHT_SUBSTRATE_RES),
            ("dark", _EXPLICIT_DARK_SUBSTRATE_RES),
        ):
            for pattern in patterns:
                explicit_matches.extend(
                    (cursor + match.start(), intent)
                    for match in pattern.finditer(normalized)
                )
        cursor += len(clause) + 1
    if explicit_matches:
        return max(explicit_matches, key=lambda item: item[0])[1]
    normalized = " ".join(normalized_clauses)
    normalized = _FOREGROUND_COLOR_RE.sub(" ", normalized)
    light_match = bool(_LIGHT_RE.search(normalized))
    dark_match = bool(_DARK_RE.search(normalized))
    if (
        light_match
        and _BARE_INK_BLACK_RE.search(normalized)
        and not _DARK_RE.search(_BARE_INK_BLACK_RE.sub(" ", normalized))
    ):
        return "light"
    if light_match == dark_match:
        return None
    if light_match:
        return "light"
    return "dark"


def _strip_negated_style_scopes(text: str) -> str:
    """Remove prohibited style spans without swallowing a later positive directive."""

    retained: list[str] = []
    cursor = 0
    while match := _NEGATION_START_RE.search(text, cursor):
        retained.append(text[cursor : match.start()])
        positive = _POSITIVE_DIRECTIVE_BOUNDARY_RE.search(text, match.end())
        if positive is None:
            cursor = len(text)
            break
        cursor = positive.start()
    retained.append(text[cursor:])
    return " ".join(retained)


def _requested_style_terms(text: str, *, substrate_intent: str | None) -> list[str]:
    terms: list[str] = []
    if substrate_intent == "dark":
        terms.append("dark_technical")
    elif substrate_intent == "light":
        terms.append("light")
    for pattern, term in ((_EXEC_RE, "executive"), (_EXPRESSIVE_RE, "expressive")):
        if pattern.search(text) and term not in terms:
            terms.append(term)
    return terms


def _dark_technical_palette() -> list[DeckColorToken]:
    return [
        DeckColorToken("background", "#0A0E14", "slide substrate"),
        DeckColorToken("surface", "#111827", "elevated native panels"),
        DeckColorToken("ink", "#EEF4FB", "primary text"),
        DeckColorToken("muted", "#A7B4C2", "secondary text"),
        DeckColorToken("accent", "#38BDF8", "technical accent"),
        DeckColorToken("support", "#F59E0B", "small contrast marker"),
    ]


def _calm_technical_palette() -> list[DeckColorToken]:
    return [
        DeckColorToken("background", "#F5F7FA", "slide substrate"),
        DeckColorToken("surface", "#FFFFFF", "native panels"),
        DeckColorToken("ink", "#1F2937", "primary text"),
        DeckColorToken("muted", "#526173", "secondary text"),
        DeckColorToken("accent", "#2563EB", "technical accent"),
        DeckColorToken("support", "#10B981", "small contrast marker"),
    ]


def _executive_palette() -> list[DeckColorToken]:
    return [
        DeckColorToken("background", "#F7F5F0", "slide substrate"),
        DeckColorToken("surface", "#FFFFFF", "native panels"),
        DeckColorToken("ink", "#202124", "primary text"),
        DeckColorToken("muted", "#626A73", "secondary text"),
        DeckColorToken("accent", "#0F766E", "executive accent"),
        DeckColorToken("support", "#B45309", "small contrast marker"),
    ]


def _expressive_palette() -> list[DeckColorToken]:
    return [
        DeckColorToken("background", "#F8FAFC", "slide substrate"),
        DeckColorToken("surface", "#FFFFFF", "native panels"),
        DeckColorToken("ink", "#101828", "primary text"),
        DeckColorToken("muted", "#5B6472", "secondary text"),
        DeckColorToken("accent", "#E11D48", "expressive accent"),
        DeckColorToken("support", "#0EA5E9", "support accent"),
    ]
