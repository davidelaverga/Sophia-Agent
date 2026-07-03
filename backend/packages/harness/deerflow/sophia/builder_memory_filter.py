"""Memory filtering helpers for delegated Sophia builder tasks."""

from __future__ import annotations

import re
from collections.abc import Iterable

DEFAULT_BUILDER_MEMORY_TOP_K = 5

_STYLE_INTENT_RE = re.compile(
    r"\b(?:prefer(?:s|red)?|like(?:s|d)?|want(?:s|ed)?|love(?:s|d)?|"
    r"dislike(?:s|d)?|hate(?:s|d)?|favorite|favourite|style|aesthetic)\b",
    re.IGNORECASE,
)
_ARTIFACT_STYLE_RE = re.compile(
    r"\b(?:aesthetic|brand|caption|chart|color|colour|dark|deck|diagram|"
    r"excalidraw|heavy|hero|image|illustration|layout|light|minimal|palette|"
    r"presentation|report|slide|slides|theme|title|visual|visuals)\b",
    re.IGNORECASE,
)
_PRESENTATION_RE = re.compile(r"\b(?:deck|decks|pptx|presentation|slide|slides|slideshow|keynote)\b", re.IGNORECASE)
_REPORT_RE = re.compile(r"\b(?:document|pdf|report|reports|paper|memo|brief|article|write[- ]?up)\b", re.IGNORECASE)
_STYLE_TOPIC_SCOPE_RE = re.compile(
    r"\b(?:for|about|on)\s+(.{1,80}?)\s+"
    r"(?:deck|decks|pptx|presentation|slide|slides|slideshow|keynote|"
    r"document|pdf|report|reports|paper|memo|brief|article|write[- ]?up)\b",
    re.IGNORECASE,
)
_TASK_TOKEN_STOPWORDS = frozenset({
    "about",
    "aesthetic",
    "artifact",
    "build",
    "chart",
    "color",
    "colour",
    "create",
    "dark",
    "deck",
    "decks",
    "deliver",
    "diagram",
    "generate",
    "heavy",
    "layout",
    "light",
    "make",
    "minimal",
    "minimalist",
    "palette",
    "prefer",
    "prefers",
    "presentation",
    "presentations",
    "preferred",
    "report",
    "reports",
    "slide",
    "slides",
    "style",
    "theme",
    "technical",
    "user",
    "visual",
    "visuals",
    "with",
})


def builder_memory_modality(*, task_type: str | None = None, text: str = "") -> str | None:
    """Return the current artifact modality when it is unambiguous."""

    normalized_type = str(task_type or "").strip().lower()
    if normalized_type in {"presentation", "slides", "slide_deck", "deck"}:
        return "presentation"
    if normalized_type in {"document", "pdf", "report", "research", "research_report", "visual_report"}:
        return "report"
    haystack = str(text or "")
    presentation = bool(_PRESENTATION_RE.search(haystack))
    report = bool(_REPORT_RE.search(haystack))
    if presentation == report:
        return None
    return "presentation" if presentation else "report"


def _memory_modalities(snippet: str) -> set[str]:
    modalities: set[str] = set()
    if _PRESENTATION_RE.search(snippet):
        modalities.add("presentation")
    if _REPORT_RE.search(snippet):
        modalities.add("report")
    return modalities


def builder_task_terms(query: str) -> set[str]:
    """Extract topic-bearing task terms used to keep task-specific memories."""

    terms: set[str] = set()
    for raw in re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", query):
        token = raw.lower().strip("_-")
        if token and token not in _TASK_TOKEN_STOPWORDS:
            terms.add(token)
    return terms


def _style_topic_terms(snippet: str) -> set[str]:
    terms: set[str] = set()
    for match in _STYLE_TOPIC_SCOPE_RE.finditer(snippet):
        terms.update(builder_task_terms(match.group(1)))
    return terms


def should_exclude_builder_memory(
    snippet: str,
    *,
    query: str = "",
    task_type: str | None = None,
) -> bool:
    """Return True for stale or cross-modality artifact style memories."""

    normalized = str(snippet or "").strip()
    if not normalized:
        return True
    style_memory = bool(_STYLE_INTENT_RE.search(normalized) and _ARTIFACT_STYLE_RE.search(normalized))
    if not style_memory:
        return False
    current_modality = builder_memory_modality(task_type=task_type, text=query)
    snippet_modalities = _memory_modalities(normalized)
    if current_modality and snippet_modalities and current_modality not in snippet_modalities:
        return True
    lowered = normalized.lower()
    task_terms = builder_task_terms(query)
    if task_terms and any(term in lowered for term in task_terms):
        return False
    if current_modality and current_modality in snippet_modalities:
        return bool(_style_topic_terms(normalized))
    return True


def filter_builder_memory_snippets(
    snippets: Iterable[str],
    *,
    query: str = "",
    task_type: str | None = None,
    limit: int = DEFAULT_BUILDER_MEMORY_TOP_K,
) -> list[str]:
    """Filter and cap builder memory snippets while preserving order."""

    capped = max(0, int(limit))
    if capped <= 0:
        return []
    kept: list[str] = []
    seen: set[str] = set()
    for raw in snippets:
        snippet = str(raw or "").strip()
        if not snippet or snippet in seen:
            continue
        if should_exclude_builder_memory(snippet, query=query, task_type=task_type):
            continue
        seen.add(snippet)
        kept.append(snippet)
        if len(kept) >= capped:
            break
    return kept
