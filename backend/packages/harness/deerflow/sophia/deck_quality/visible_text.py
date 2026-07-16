from __future__ import annotations

from collections.abc import Iterable

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import VisibleTextSlide


def visible_text_sidecar(
    slides: Iterable[tuple[str, Iterable[str]]],
) -> tuple[VisibleTextSlide, ...]:
    """Create exact text evidence from authoritative native/source records."""

    result = []
    for selector, fragments in slides:
        normalized = "\n".join(fragment.strip() for fragment in fragments if fragment.strip())
        result.append(
            VisibleTextSlide(
                selector=selector,
                text=normalized,
                source_hash=canonical_sha256({"selector": selector, "text": normalized}),
            )
        )
    return tuple(result)
