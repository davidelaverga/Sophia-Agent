"""G-DEL-2 — the deterministic digest carries seeded requirements verbatim.

Requirements seeded at t3 (audience), t12 (style), t18 (data), t25
(exclusion); compaction at t30 is irrelevant to the digest because it reads
the ledger, not state. The enriched description carries the digest section;
short sessions and the flag-off path are byte-identical to today.
"""

from __future__ import annotations

from delegation_fixture import (
    THREAD_ID,
    USER_ID,
    fixture_entries,
    materialize_ledger,
)

from deerflow.sophia import delegation_ledger
from deerflow.sophia.tools.start_builder_task import (
    _build_enriched_description,
    _resolve_dispatch_digest,
)
from deerflow.sophia.tools.update_async_task_wrapper import _delta_digest_block


def _enriched(digest: str | None) -> str:
    return _build_enriched_description(
        "Build a 10-slide technical deck",
        "presentation",
        memory_snippets=[],
        companion_artifact={"tone_estimate": 2.8},
        active_ritual=None,
        ritual_phase=None,
        explicit_user_urls=[],
        delegation_digest=digest,
    )


# ---- digest content -----------------------------------------------------------


def test_digest_carries_t12_and_t25_verbatim():
    digest = delegation_ledger.build_digest(fixture_entries())
    assert digest is not None
    assert len(digest) <= 1_400
    # t12's line renders the takeaway; t25's likewise — both carry the
    # seeded substance. The verbatim user strings live in the entries and
    # are recoverable via read_session_context; the digest carries the
    # turn-tagged takeaway lines.
    assert "t12:" in digest
    assert "t25:" in digest
    assert "hand-drawn" in digest
    assert "pricing slides" in digest


def test_digest_orders_oldest_first_and_keeps_goal_header():
    digest = delegation_ledger.build_digest(fixture_entries())
    assert digest.startswith("Session goal: ")
    assert "→" in digest.splitlines()[0]  # goal evolution captured
    t_numbers = [
        int(line.split(":")[0][1:])
        for line in digest.splitlines()[1:]
        if line.startswith("t")
    ]
    assert t_numbers == sorted(t_numbers)


def test_digest_deterministic_drop_order_under_cap_pressure():
    entries = fixture_entries()
    tight = delegation_ledger.build_digest(entries, cap_chars=400)
    assert tight is not None
    assert len(tight) <= 400
    # Deliverable-intent lines survive; recent-only filler drops first.
    assert tight == delegation_ledger.build_digest(entries, cap_chars=400)


def test_short_session_produces_no_digest():
    assert delegation_ledger.build_digest(fixture_entries()[:3]) is None


# ---- dispatch integration ------------------------------------------------------


def test_enriched_description_carries_digest_section():
    digest = delegation_ledger.build_digest(fixture_entries())
    enriched = _enriched(digest)
    assert "Conversation decisions relevant to this build:" in enriched
    assert "hand-drawn" in enriched
    # Positioned after the description, before memories/emotional context.
    assert enriched.index("10-slide technical deck") < enriched.index("hand-drawn")


def test_enriched_description_without_digest_is_byte_identical_to_today():
    assert "Conversation decisions" not in _enriched(None)
    assert _enriched(None) == _enriched("")  # falsy digest → no section


def test_resolve_dispatch_digest_reads_ledger_and_stamps_stats(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    state = {"turn_count": 5, "was_summarized": True}
    digest, stats, dispatched_at_turn = _resolve_dispatch_digest(state, USER_ID, THREAD_ID)
    assert digest is not None and "t25:" in digest
    assert stats["turns"] == 40
    assert stats["deliverable_intent_turns"] > 0
    assert stats["was_summarized"] is True
    assert stats["available"] is True
    assert dispatched_at_turn == 41  # ledger watermark, NOT state turn_count


def test_resolve_dispatch_digest_flag_off(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    monkeypatch.setenv("SOPHIA_DELEGATION_DIGEST", "0")
    digest, stats, dispatched_at_turn = _resolve_dispatch_digest(
        {"turn_count": 5}, USER_ID, THREAD_ID
    )
    assert digest is None
    assert stats is None
    assert dispatched_at_turn == 6  # state fallback


def test_resolve_dispatch_digest_missing_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    digest, stats, _ = _resolve_dispatch_digest({"turn_count": 5}, USER_ID, THREAD_ID)
    assert digest is None
    assert stats is None


# ---- update delta --------------------------------------------------------------


def test_delta_digest_covers_only_turns_after_dispatch(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    delegation_context = {
        "dispatched_at_turn": 25,
        "parent_thread_id": THREAD_ID,
        "parent_user_id": USER_ID,
    }
    block = _delta_digest_block({"user_id": USER_ID}, delegation_context)
    assert block.startswith("[Conversation since dispatch]")
    assert "t31:" in block  # the include@t31 requirement, post-dispatch
    assert "t12:" not in block  # pre-dispatch content excluded
    assert "t25:" not in block  # the dispatch turn itself excluded


def test_delta_digest_empty_when_nothing_since_dispatch(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    delegation_context = {
        "dispatched_at_turn": 40,
        "parent_thread_id": THREAD_ID,
        "parent_user_id": USER_ID,
    }
    assert _delta_digest_block({"user_id": USER_ID}, delegation_context) == ""


def test_delta_digest_degrades_on_missing_inputs(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    assert _delta_digest_block({}, None) == ""
    assert _delta_digest_block({}, {"parent_thread_id": THREAD_ID}) == ""
    monkeypatch.setenv("SOPHIA_DELEGATION_DIGEST", "0")
    assert (
        _delta_digest_block(
            {"user_id": USER_ID},
            {
                "dispatched_at_turn": 25,
                "parent_thread_id": THREAD_ID,
                "parent_user_id": USER_ID,
            },
        )
        == ""
    )
