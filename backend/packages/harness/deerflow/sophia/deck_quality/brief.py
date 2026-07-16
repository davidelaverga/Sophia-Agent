from __future__ import annotations

_FORBIDDEN_SECTION_MARKERS = (
    "relevant memories from this session:",
    "relevant memories:",
    "memory context:",
    "prior conversation memory:",
)


def forbidden_brief_marker(request: str) -> str | None:
    lowered = request.casefold()
    return next((marker for marker in _FORBIDDEN_SECTION_MARKERS if marker in lowered), None)


def sanitize_current_request(request: str) -> str:
    """Remove appended prior-memory sections from the current deck request."""

    stripped = request.strip()
    lowered = stripped.casefold()
    boundaries = [lowered.index(marker) for marker in _FORBIDDEN_SECTION_MARKERS if marker in lowered]
    if boundaries:
        stripped = stripped[: min(boundaries)].rstrip()
    if not stripped:
        raise ValueError("current request is empty after prior-memory removal")
    return stripped
