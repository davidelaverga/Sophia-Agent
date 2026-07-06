"""Deterministic slide-quality gate for the HTML-slide deck path (FIX 2, 2026-06-30).

The deck pipeline (``build_deck_from_slides``) screenshots each authored
``slides/*.html`` to a full-bleed PNG and wraps them into a ``.pptx``. Until now
nothing checked the slides for the defects that shipped in prod (2026-06-30):
cramped/clipped DOM text (the screenshot clips at the 16:9 canvas, so overflow is
silently cut off) and invented "template chrome" (a top eyebrow/nav row, a bottom
icon strip, page-number footers) that the SKILL never asked for.

This module owns ALL slide-quality logic in ONE place, as a *declarative list of
checks* so a new dimension is a new entry, not new tangled middleware. The
deterministic checks cover overflow, chrome, density, and visual prompt
contract. A mockable LLM-as-judge grader plugs in as check N+1 via
:class:`GraderConfig`.

Pure: no I/O. The caller (``BuilderArtifactMiddleware``) collects the signals
(the ``build_deck_from_slides`` result + the slide HTML/prompt sources) and
passes them in; the inspector returns the gaps; the middleware spends bounded
repair turns. Layout gaps are HTML/CSS only; visual-contract gaps may
regenerate only the affected image.
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
_GENERATED_TEXT_RE = re.compile(
    r"\b(the\s+text\s+reads|large\s+labels?|large\s+readable\s+text(?:\s+labels?)?|label\s+copy|"
    r"render(?:ed)?\s+text|text\s+inside\s+the\s+image)\b",
    re.IGNORECASE,
)
_BANNED_AESTHETIC_RE = re.compile(
    r"\b(chalkboard|blackboard|whiteboard|hand[-\s]?written|hand[-\s]?drawn|sketch|sketched|marker[-\s]?like)\b",
    re.IGNORECASE,
)
_NEGATED_BANNED_TERM_RE = re.compile(r"(?:\bno\b|\bavoid\b|\bwithout\b|\bnever\b|\bdo\s+not\b)\W*$", re.IGNORECASE)
_UNREQUESTED_STYLE_RE = re.compile(
    r"\b(cyberpunk|neon|matrix|hacker|terminal\s+green|glowing\s+grid|chalkboard|blackboard|whiteboard|"
    r"hand[-\s]?written|hand[-\s]?drawn|sketch|sketched)\b",
    re.IGNORECASE,
)
_TINY_FONT_RE = re.compile(r"font-size\s*:\s*(?:[0-9]|1[0-5])px\b", re.IGNORECASE)
_CARD_CLASS_RE = re.compile(r"\b(?:class|id)\s*=\s*['\"][^'\"]*\bcard\b", re.IGNORECASE)


@dataclass(frozen=True)
class SlideSignals:
    """Everything the deterministic checks read for one deck build.

    ``slide_sources`` is the ordered ``(name, html_source)`` of each slide HTML
    (same order build_deck_from_slides renders them, so a 1-based overflow index
    maps to ``slide_sources[index - 1]``). ``overflow_slides`` is the renderer's
    per-slide CDP measurement (``[{"slide": int, "overflow_px": int}]``).
    """

    slide_sources: list[tuple[str, str]] = field(default_factory=list)
    prompt_sources: list[tuple[str, str]] = field(default_factory=list)
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


def visual_contract_check(signals: SlideSignals) -> list[QualityGap]:
    """Flag prompt/source contracts that bake text or odd aesthetics into images."""
    gaps: list[QualityGap] = []
    for name, source in signals.prompt_sources:
        reasons: list[str] = []
        text_match = next(
            (
                match
                for match in _GENERATED_TEXT_RE.finditer(source)
                if not _match_is_negated(source, match)
            ),
            None,
        )
        if text_match is not None:
            reasons.append("asks the image model to render text/labels/formulas")
        aesthetic_match = next(
            (
                match
                for match in _BANNED_AESTHETIC_RE.finditer(source)
                if not _match_is_negated(source, match)
            ),
            None,
        )
        if aesthetic_match is not None:
            reasons.append("uses an unrequested chalkboard/handwritten/sketch aesthetic")
        if reasons:
            gaps.append(
                QualityGap(
                    slide=name,
                    check="visual_contract",
                    detail=(
                        "rewrite the visual prompt as a mostly text-free, restrained professional "
                        "technical visual — " + "; ".join(reasons)
                    ),
                )
            )
    return gaps


def _match_is_negated(source: str, match: re.Match[str]) -> bool:
    prefix = source[max(0, match.start() - 32) : match.start()]
    return bool(_NEGATED_BANNED_TERM_RE.search(prefix))


def visual_style_check(signals: SlideSignals) -> list[QualityGap]:
    """Flag narrow source patterns behind unrequested bad deck aesthetics."""
    gaps: list[QualityGap] = []
    for name, html in signals.slide_sources:
        reasons: list[str] = []
        style_match = next(
            (
                match
                for match in _UNREQUESTED_STYLE_RE.finditer(html)
                if not _match_is_negated(html, match)
            ),
            None,
        )
        if style_match is not None:
            reasons.append(f"unrequested {style_match.group(1)} aesthetic")
        if _TINY_FONT_RE.search(html):
            reasons.append("font-size below 16px")
        card_count = len(_CARD_CLASS_RE.findall(html))
        if card_count > 4:
            reasons.append(f"{card_count} card-style panels")
        if reasons:
            gaps.append(
                QualityGap(
                    slide=name,
                    check="visual_style",
                    detail=(
                        "use restrained professional technical styling with legible text and fewer "
                        "UI/card panels — " + "; ".join(reasons)
                    ),
                )
            )
    return gaps


DEFAULT_CHECKS: tuple[QualityCheck, ...] = (
    overflow_check,
    chrome_check,
    density_check,
    visual_contract_check,
    visual_style_check,
)


@dataclass(frozen=True)
class GraderConfig:
    """The designed-in, mockable visual judge slot.

    When enabled with a ``judge`` callable, the inspector appends one bounded
    subjective pass as check N+1, grounded in deterministic signals and mocked
    in unit tests. Production can wire an LLM judge here without changing the
    middleware loop semantics.
    """

    enabled: bool = False
    model_name: str | None = None
    judge: Callable[[SlideSignals], list[QualityGap]] | None = None


class SlideQualityInspector:
    def __init__(
        self,
        checks: tuple[QualityCheck, ...] = DEFAULT_CHECKS,
        grader: GraderConfig | None = None,
    ) -> None:
        self.checks = checks
        self.grader = grader

    def inspect(self, signals: SlideSignals) -> list[QualityGap]:
        gaps: list[QualityGap] = []
        for check in self.checks:
            gaps.extend(check(signals))
        if self.grader and self.grader.enabled and self.grader.judge is not None:
            judged = self.grader.judge(signals)
            if isinstance(judged, list):
                gaps.extend(gap for gap in judged if isinstance(gap, QualityGap))
        return gaps


def format_slide_quality_feedback(gaps: list[QualityGap]) -> str:
    """One re-author directive listing the per-slide gaps (HTML-only, reuse images)."""
    by_slide: dict[str, list[str]] = {}
    for gap in gaps:
        by_slide.setdefault(gap.slide, []).append(f"{gap.check}: {gap.detail}")
    lines = [f"- {slide}: " + "; ".join(details) for slide, details in by_slide.items()]
    return (
        "[Sophia/slide-quality] The deck compiled, but these slides have fixable layout/visual-contract issues. "
        "Re-author ONLY the affected `slides/*.html` and/or visual prompt JSON files. Reuse existing good "
        "images, but regenerate any affected visual whose prompt baked text or an odd aesthetic into the image, "
        "then call `build_deck_from_slides` again:\n"
        + "\n".join(lines)
        + "\nKeep each slide to the title, the visual, and a concise narrative — no eyebrow/nav row, "
        "no bottom icon strip, no page numbers, and no image-baked typography unless the user explicitly asked for it."
    )
