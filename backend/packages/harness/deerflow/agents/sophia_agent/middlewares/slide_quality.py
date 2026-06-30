"""Deterministic slide-quality gate for the HTML-slide deck path (FIX 2, 2026-06-30).

The deck pipeline (``build_deck_from_slides``) screenshots each authored
``slides/*.html`` to a full-bleed PNG and wraps them into a ``.pptx``. Until now
nothing checked the slides for the defects that shipped in prod (2026-06-30):
cramped/clipped DOM text (the screenshot clips at the 16:9 canvas, so overflow is
silently cut off) and invented "template chrome" (a top eyebrow/nav row, a bottom
icon strip, page-number footers) that the SKILL never asked for.

This module owns ALL slide-quality logic in ONE place, as a *declarative list of
checks* so a new dimension is a new entry, not new tangled middleware. v1 ships
three deterministic checks (overflow / chrome / density); a future LLM-as-judge
grader plugs in as check N+1 via :class:`GraderConfig` (the socket is built here;
the plug is OFF in v1 — see ``SlideQualityInspector.__init__``).

Pure: no I/O. The caller (``BuilderArtifactMiddleware``) collects the signals
(the ``build_deck_from_slides`` result + the slide HTML sources) and passes them
in; the inspector returns the gaps; the middleware spends ONE bounded re-author
turn (HTML only — existing images are reused, never regenerated).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

# A slide whose rendered content overran the 16:9 canvas by more than this is
# flagged as clipped. build_deck_from_slides already applies an 8px tolerance
# before it reports a slide in ``overflow_slides``; this is a redundant floor.
_OVERFLOW_FLAG_PX = 8
# A slide with more visible body text than this is "a wall of text". Generous so
# only egregious density trips it — the overflow check is the precise safety net.
_DENSITY_WORD_CAP = 130
# More than this many deck columns in one slide reads as cramped (the page-1
# defect packed 6 feature columns into the lower band).
_MAX_SLIDE_COLUMNS = 3

# Chrome the ppt-generation SKILL bans (only .title/.visual/.narrative belong on a
# slide). Matched against class="..."/id="..." tokens + semantic tags.
_CHROME_CLASS_TOKENS = (
    "eyebrow",
    "navbar",
    "nav-row",
    "nav-bar",
    "navrow",
    "topnav",
    "breadcrumb",
    "pagination",
    "page-number",
    "page-num",
    "pagenum",
    "slide-number",
    "slide-num",
    "icon-strip",
    "iconstrip",
    "footer-strip",
)
_NAV_TAG_RE = re.compile(r"<(nav|footer)[\s/>]", re.IGNORECASE)
_NAV_ROLE_RE = re.compile(r"""role\s*=\s*['"]\s*(navigation|contentinfo)\s*['"]""", re.IGNORECASE)
_CLASS_OR_ID_RE = re.compile(r"""(?:class|id)\s*=\s*['"]([^'"]*)['"]""", re.IGNORECASE)
# "page 2 of 4" / "slide 2 of 4" — an unambiguous page-number footer phrasing.
_PAGE_NUMBER_TEXT_RE = re.compile(r"\b(?:page|slide)\s+\d+\s+of\s+\d+\b", re.IGNORECASE)
_STYLE_BLOCK_RE = re.compile(r"<(style|script)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_GRID_COLUMNS_RE = re.compile(r"grid-template-columns\s*:\s*([^;}\"']+)", re.IGNORECASE)
_REPEAT_RE = re.compile(r"repeat\(\s*(\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class SlideSignals:
    """Everything the deterministic checks read for one deck build.

    ``slide_sources`` is the ordered ``(name, html_source)`` of each slide HTML
    (same order build_deck_from_slides renders them, so a 1-based overflow index
    maps to ``slide_sources[index - 1]``). ``overflow_slides`` is the renderer's
    per-slide CDP measurement (``[{"slide": int, "overflow_px": int}]``).
    """

    slide_sources: list[tuple[str, str]] = field(default_factory=list)
    overflow_slides: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class QualityGap:
    slide: str
    check: str
    detail: str


QualityCheck = Callable[[SlideSignals], list[QualityGap]]


def _slide_label(signals: SlideSignals, one_based_index: int) -> str:
    if 1 <= one_based_index <= len(signals.slide_sources):
        return signals.slide_sources[one_based_index - 1][0]
    return f"slide {one_based_index}"


def overflow_check(signals: SlideSignals) -> list[QualityGap]:
    """Flag slides whose content was clipped by the 16:9 screenshot."""
    gaps: list[QualityGap] = []
    for entry in signals.overflow_slides:
        if not isinstance(entry, dict):
            continue
        px = int(entry.get("overflow_px", 0) or 0)
        index = int(entry.get("slide", 0) or 0)
        if px <= _OVERFLOW_FLAG_PX or index <= 0:
            continue
        gaps.append(
            QualityGap(
                slide=_slide_label(signals, index),
                check="overflow",
                detail=f"content overflows the slide frame by ~{px}px and is clipped — cut text or shrink the visual so it fits the 1920×1080 canvas",
            )
        )
    return gaps


def _strip_to_visible_text(html: str) -> str:
    without_blocks = _STYLE_BLOCK_RE.sub(" ", html)
    return _TAG_RE.sub(" ", without_blocks)


def _max_columns(html: str) -> int:
    most = 0
    for value in _GRID_COLUMNS_RE.findall(html):
        repeat = _REPEAT_RE.search(value)
        if repeat:
            most = max(most, int(repeat.group(1)))
            continue
        # Count explicit track tokens (e.g. "1fr 1fr 1fr 1fr").
        tracks = [token for token in value.replace(",", " ").split() if token.strip()]
        most = max(most, len(tracks))
    return most


def density_check(signals: SlideSignals) -> list[QualityGap]:
    """Flag walls of text or too many columns crammed into one slide."""
    gaps: list[QualityGap] = []
    for name, html in signals.slide_sources:
        words = len(_strip_to_visible_text(html).split())
        if words > _DENSITY_WORD_CAP:
            gaps.append(
                QualityGap(
                    slide=name,
                    check="density",
                    detail=f"~{words} words of body text is too dense — tighten to a comfortable amount (cut content, do not shrink the font)",
                )
            )
        columns = _max_columns(html)
        if columns > _MAX_SLIDE_COLUMNS:
            gaps.append(
                QualityGap(
                    slide=name,
                    check="density",
                    detail=f"{columns} columns is too many for one slide — use at most {_MAX_SLIDE_COLUMNS}",
                )
            )
    return gaps


def chrome_check(signals: SlideSignals) -> list[QualityGap]:
    """Flag invented template chrome (eyebrow/nav row, icon strip, page footer)."""
    gaps: list[QualityGap] = []
    for name, html in signals.slide_sources:
        reasons: list[str] = []
        if _NAV_TAG_RE.search(html):
            reasons.append("a <nav>/<footer> element")
        if _NAV_ROLE_RE.search(html):
            reasons.append('a navigation/contentinfo role')
        if _PAGE_NUMBER_TEXT_RE.search(html):
            reasons.append("a page-number footer")
        class_blob = " ".join(_CLASS_OR_ID_RE.findall(html)).lower()
        hit_tokens = sorted({token for token in _CHROME_CLASS_TOKENS if token in class_blob})
        if hit_tokens:
            reasons.append(f"chrome classes ({', '.join(hit_tokens)})")
        if reasons:
            gaps.append(
                QualityGap(
                    slide=name,
                    check="chrome",
                    detail="remove invented chrome — " + "; ".join(reasons) + " — keep only the title, visual, and narrative",
                )
            )
    return gaps


DEFAULT_CHECKS: tuple[QualityCheck, ...] = (overflow_check, chrome_check, density_check)


@dataclass(frozen=True)
class GraderConfig:
    """The designed-in LLM-as-judge slot (OFF in v1).

    When enabled, the inspector would run an LLM judge as check N+1, GROUNDED in
    the deterministic signals (the overflow/chrome/density facts) with
    ``max_iterations=1`` and HTML-only revisions. Deliberately inert until the
    deterministic base is stable and there is evidence subjective quality is the
    gap (see the spec). Build the socket, defer the plug.
    """

    enabled: bool = False
    model_name: str | None = None


class SlideQualityInspector:
    def __init__(
        self,
        checks: tuple[QualityCheck, ...] = DEFAULT_CHECKS,
        grader: GraderConfig | None = None,
    ) -> None:
        self.checks = checks
        self.grader = grader  # v1: always None / disabled — the future plug.

    def inspect(self, signals: SlideSignals) -> list[QualityGap]:
        gaps: list[QualityGap] = []
        for check in self.checks:
            gaps.extend(check(signals))
        # Grader slot (OFF in v1): if self.grader and self.grader.enabled, append
        # an LLM-judge pass here, grounded in `gaps`. Intentionally not wired.
        return gaps


def format_slide_quality_feedback(gaps: list[QualityGap]) -> str:
    """One re-author directive listing the per-slide gaps (HTML-only, reuse images)."""
    by_slide: dict[str, list[str]] = {}
    for gap in gaps:
        by_slide.setdefault(gap.slide, []).append(gap.detail)
    lines = [f"- {slide}: " + "; ".join(details) for slide, details in by_slide.items()]
    return (
        "[Sophia/slide-quality] The deck compiled, but these slides have fixable layout issues. "
        "Re-author ONLY the affected `slides/*.html` (HTML/CSS only — REUSE the existing images in "
        "`assets/`, do NOT regenerate any image), then call `build_deck_from_slides` again:\n"
        + "\n".join(lines)
        + "\nKeep each slide to the title, the visual, and a concise narrative — no eyebrow/nav row, "
        "no bottom icon strip, no page numbers."
    )
