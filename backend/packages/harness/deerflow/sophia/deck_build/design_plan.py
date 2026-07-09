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

_DARK_RE = re.compile(r"\b(dark|charcoal|black|near[-\s]?black|blueprint|terminal|cyber|technical|mono|command\s+center)\b", re.I)
_LIGHT_RE = re.compile(r"\b(light|white|bright|daylight|minimal\s+white|clean\s+white)\b", re.I)
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
    explicit_text = _stringify_known_values(design_plan or {})
    style_text = _stringify_known_values(_known_style_profile(style_profile))
    slide_text = "\n".join(str(slide.get("title") or "") for slide in slides[:3])
    haystack = "\n".join([explicit_text, request_context, style_text, deck_title, slide_text])
    light_requested = bool(_LIGHT_RE.search(haystack))
    dark_requested = bool(_DARK_RE.search(haystack)) and not light_requested
    executive_requested = bool(_EXEC_RE.search(haystack)) or register == "executive"
    expressive_requested = bool(_EXPRESSIVE_RE.search(haystack)) or register == "expressive"

    if dark_requested:
        style_lane = "technical_blueprint"
        palette = _dark_technical_palette()
        typography = DeckTypographyPlan(display="Aptos Display", body="Aptos", utility="Courier New")
        signature = "dark substrate, precise cyan accents, native linework"
        rhythm = "high-contrast claims with disciplined diagram bands"
    elif executive_requested:
        style_lane = "executive_editorial"
        palette = _executive_palette()
        typography = DeckTypographyPlan(display="Aptos Display", body="Aptos")
        signature = "quiet editorial substrate, strong headline hierarchy"
        rhythm = "wide margins, evidence blocks, decisive synthesis"
    elif expressive_requested:
        style_lane = "expressive_keynote"
        palette = _expressive_palette()
        typography = DeckTypographyPlan(display="Aptos Display", body="Aptos")
        signature = "confident color accents with native editorial shapes"
        rhythm = "alternating hero, proof, and synthesis moments"
    else:
        style_lane = "calm_technical"
        palette = _calm_technical_palette()
        typography = DeckTypographyPlan(display="Aptos Display", body="Aptos")
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
        requested_style_terms=_requested_style_terms(haystack),
        normalized_from_style_profile=_known_style_profile(style_profile),
    )


def design_token(plan: DeckDesignPlan, name: str, fallback: str = "#000000") -> str:
    for token in plan.palette:
        if token.name == name:
            return token.hex
    return fallback


def write_design_plan(plan: DeckDesignPlan, host_path: Path) -> None:
    host_path.parent.mkdir(parents=True, exist_ok=True)
    host_path.write_text(json.dumps(asdict(plan), indent=2), encoding="utf-8")


def _known_style_profile(style_profile: dict[str, Any]) -> dict[str, Any]:
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


def _requested_style_terms(text: str) -> list[str]:
    terms: list[str] = []
    for pattern, term in (
        (_DARK_RE, "dark_technical"),
        (_LIGHT_RE, "light"),
        (_EXEC_RE, "executive"),
        (_EXPRESSIVE_RE, "expressive"),
    ):
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
