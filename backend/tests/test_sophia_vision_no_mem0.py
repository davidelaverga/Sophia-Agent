"""Viewing an image must not write its bytes to durable memory.

Acceptance criterion #6: in-session viewing only — durable multimodal
extraction is explicitly out of scope and deferred to a later
memory-axis spec.

The actual guarantee lives upstream in the offline pipeline's
``_flatten_content`` (text blocks only; image/PDF bytes are dropped per
``backend/CLAUDE.md`` and the docstring in
``deerflow.sophia.offline_pipeline``). This test pins that behaviour so
a future refactor that "adds multimodal extraction" forces an explicit
spec decision rather than slipping in silently.
"""

from __future__ import annotations

import importlib


def test_flatten_content_drops_image_blocks_from_text_extraction() -> None:
    """A multi-block message with text + image_url must yield text only."""
    pipeline_mod = importlib.import_module(
        "deerflow.sophia.offline_pipeline"
    )
    flatten = getattr(pipeline_mod, "_flatten_content", None)
    if flatten is None:
        # If the helper is renamed/moved, surface that — the offline
        # pipeline is the gate that enforces "no image bytes to Mem0".
        import pytest

        pytest.skip(
            "deerflow.sophia.offline_pipeline._flatten_content not found; "
            "vision no-Mem0 guarantee needs reverification — please update "
            "this test to point at the new gate."
        )

    multimodal = [
        {"type": "text", "text": "user said this"},
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,aGVsbG8="},
        },
    ]
    flat = flatten(multimodal)
    assert "user said this" in flat
    assert "image_url" not in flat
    assert "base64" not in flat
    assert "aGVsbG8" not in flat, (
        "Image base64 must NEVER appear in the flattened text the extractor "
        "sends to Mem0 — that would create a durable multimodal write, which "
        "is explicitly out of scope for the vision-port spec."
    )
