"""Shared policy helpers for builder-only web research."""

from __future__ import annotations

import re

_EXPLICIT_URL_RE = re.compile(r"https?://[^\s<>\]\)\"']+")
_TRAILING_URL_PUNCTUATION = ".,;:!?)]}\"'"
_PRESENTATION_OR_DOCUMENT_TYPES = {"presentation", "document", "visual_report"}
_DISALLOWED_TASK_TYPES = {"frontend"}
_FRESHNESS_CUES = (
    "latest",
    "current",
    "today",
    "recent",
    "verify",
    "research",
    "compare",
    "market",
    "competitor",
    "pricing",
    "trend",
)


def normalize_builder_web_url(url: str) -> str:
    """Normalize a user- or tool-provided web URL for exact matching."""
    return url.strip().rstrip(_TRAILING_URL_PUNCTUATION)


def extract_explicit_user_urls(text: str) -> list[str]:
    """Extract exact URLs explicitly present in the delegated task brief."""
    seen: set[str] = set()
    urls: list[str] = []
    for match in _EXPLICIT_URL_RE.findall(text or ""):
        normalized = normalize_builder_web_url(match)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
    return urls


def should_allow_builder_web_research(task_type: str, task: str) -> bool:
    """Gate autonomous browsing for the builder's phase-1 rollout."""
    normalized_type = (task_type or "").strip().lower()
    task_text = (task or "").lower()

    if normalized_type == "research":
        return True
    if normalized_type in _DISALLOWED_TASK_TYPES:
        return False

    explicit_urls = extract_explicit_user_urls(task)
    if explicit_urls:
        return True

    if normalized_type in _PRESENTATION_OR_DOCUMENT_TYPES:
        return any(cue in task_text for cue in _FRESHNESS_CUES)

    return False


def make_builder_web_budget(task_type: str) -> dict[str, int]:
    """Return the default search/fetch budget for a delegated builder task."""
    normalized_type = (task_type or "").strip().lower()
    if normalized_type == "research":
        return {
            "search_limit": 5,
            "fetch_limit": 8,
            "search_calls": 0,
            "fetch_calls": 0,
        }

    return {
        "search_limit": 3,
        "fetch_limit": 5,
        "search_calls": 0,
        "fetch_calls": 0,
    }
