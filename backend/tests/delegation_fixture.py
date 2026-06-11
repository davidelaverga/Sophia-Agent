"""Shared helpers for the Spec D G-DEL test battery.

Loads the 40-turn fixture (seeded requirements: audience@t3, style@t12,
data@t18, exclusion@t25) and materializes it as a real ledger file under a
tmp USERS_DIR. Tests monkeypatch ``delegation_ledger.USERS_DIR`` (the
module-level import, not the paths module) so every path helper in the
module under test resolves into the tmp tree.
"""

from __future__ import annotations

import json
from pathlib import Path

from deerflow.sophia import delegation_ledger

FIXTURE_PATH = Path(__file__).parent / "evals" / "fixtures" / "delegation_long_session.json"

USER_ID = "user-gdel"
THREAD_ID = "thread-gdel"

# Seeded verbatim strings the gates assert on.
SEEDED_STYLE_T12 = "hand-drawn style, never corporate stock"
SEEDED_EXCLUSION_T25 = "exclude pricing slides"
SEEDED_DATA_T18 = "Q3 numbers: 4.2M revenue"
SEEDED_AUDIENCE_T3 = "enterprise customers' CTOs"


def load_fixture_turns() -> list[dict]:
    with open(FIXTURE_PATH, encoding="utf-8") as fh:
        return json.load(fh)["turns"]


def fixture_entries(turns: list[dict] | None = None) -> list[dict]:
    """Fixture turns → ledger entries via the production entry builder."""
    return [
        delegation_ledger.build_entry(
            turn["turn_number"], turn["user_text"], turn.get("artifact")
        )
        for turn in (turns or load_fixture_turns())
    ]


def materialize_ledger(
    tmp_path: Path,
    monkeypatch,
    *,
    user_id: str = USER_ID,
    thread_id: str = THREAD_ID,
    turns: list[dict] | None = None,
) -> list[dict]:
    """Point delegation_ledger at tmp_path and write the fixture ledger."""
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    entries = fixture_entries(turns)
    for entry in entries:
        assert delegation_ledger.append_turn(user_id, thread_id, entry)
    return entries
