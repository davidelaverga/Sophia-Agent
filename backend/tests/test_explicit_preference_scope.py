"""The deterministic fallback must not erase scope or merge distinct choices."""

import pytest

from deerflow.sophia.extraction import _merge_deterministic_entries, analyze_explicit_remember_messages


@pytest.mark.parametrize("statement", [
    "these two preferences for my disposable memory-test projects: for Cedar Kite, I prefer progress summaries in two numbered sentences; "
    "for Copper Fern, I prefer release notes in rhyming couplets. Keep the project names with each preference so I can review them separately "
    "after this session. These are synthetic test preferences, not real personal facts.",
    "for Cedar Kite, I prefer progress summaries in two numbered sentences.",
    "I prefer short summaries; for Copper Fern, I prefer rhyming couplets.",
    "I prefer short summaries. This is only a synthetic test preference.",
    "for Cedar Kite, my preferred summary format is two numbered sentences.",
])
def test_ambiguous_fallback_preserves_model_scoped_candidates(statement):
    scoped = [
        {"content": "Synthetic test preference: Cedar Kite summaries use two numbered sentences."},
        {"content": "Synthetic test preference: Copper Fern release notes use rhyming couplets."},
    ]
    analysis = analyze_explicit_remember_messages([{"role": "user", "content": "Please remember " + statement}])
    assert analysis["entries"] == []
    assert _merge_deterministic_entries(scoped, analysis["entries"]) == scoped


def test_simple_explicit_preference_keeps_fallback():
    analysis = analyze_explicit_remember_messages([
        {"role": "user", "content": "Please remember I prefer short progress summaries."},
    ])
    assert [entry["content"] for entry in analysis["entries"]] == ["User prefers short progress summaries."]
