"""Correction 2026-06-12 — the document paging contract must prevent
partial-read summaries.

Prod report: the companion summarized attached documents from the first
64 KB window and stopped; the user had to ask "can you read it in chunks?"
before she continued. Partial pages now announce partiality AT THE TOP and
the footer forbids answering before the end-of-document marker.
"""

from __future__ import annotations

from deerflow.sophia.tools.read_user_document import (
    _MAX_BYTES_RETURNED,
    _page_for_context,
)

_BIG = "x" * (_MAX_BYTES_RETURNED * 2 + 100)  # three windows
_SMALL = "short document content"


def test_small_document_returned_verbatim_no_markers():
    assert _page_for_context(_SMALL, 0) == _SMALL


def test_partial_page_announces_partiality_at_the_top():
    page = _page_for_context(_BIG, 0)
    assert page.startswith("[PARTIAL VIEW: bytes 0–")
    assert "This is NOT the whole document." in page.splitlines()[0]


def test_partial_footer_is_imperative_and_names_next_offset():
    page = _page_for_context(_BIG, 0)
    assert f"offset={_MAX_BYTES_RETURNED}" in page
    assert "do NOT answer yet" in page
    assert "Answering from a partial read silently drops" in page


def test_middle_page_keeps_partial_markers():
    page = _page_for_context(_BIG, _MAX_BYTES_RETURNED)
    assert page.startswith("[PARTIAL VIEW:")
    assert f"offset={_MAX_BYTES_RETURNED * 2}" in page


def test_final_page_confirms_whole_document_seen():
    page = _page_for_context(_BIG, _MAX_BYTES_RETURNED * 2)
    assert "End of document" in page
    assert "You have now seen the whole document." in page
    assert "PARTIAL VIEW" not in page


def test_offset_past_end_reports_no_more_content():
    page = _page_for_context(_SMALL, 10_000)
    assert "No more content to read" in page


def test_tool_docstring_forbids_partial_answers():
    from deerflow.sophia.tools.read_user_document import read_user_document

    doc = read_user_document.description
    assert "NEVER summarize" in doc
    assert "Read to the end first" in doc


def test_coordination_core_teaches_chunked_document_reading():
    """Prod 2026-06-12: the companion summarized attached documents from the
    first 64 KB window — read_user_document appeared in NO system-prompt
    file, so her only teaching was the tool spec. The always-loaded
    coordination_core.md now carries the standing instruction; this test
    keeps it from silently regressing."""
    from pathlib import Path

    skill = (
        Path(__file__).resolve().parents[2]
        / "skills"
        / "public"
        / "sophia"
        / "coordination_core.md"
    ).read_text(encoding="utf-8")
    assert "Working With Attached Documents" in skill
    assert "read_user_document" in skill
    assert "PARTIAL VIEW" in skill
    assert "read ALL of it" in skill
    assert "End of document" in skill
    assert "only claim full coverage after the end-of-document marker" in skill
