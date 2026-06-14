"""G-DEL-4 — read_session_context recalls exact parent-session content;
cross-session addressing is structurally impossible; the 4-call cap holds."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from delegation_fixture import (
    SEEDED_DATA_T18,
    THREAD_ID,
    USER_ID,
    fixture_entries,
    materialize_ledger,
)

from deerflow.sophia import delegation_ledger
from deerflow.sophia.tools.read_session_context import read_session_context

_OTHER_THREAD = "thread-other"


def _runtime(
    *,
    parent_thread_id: str | None = THREAD_ID,
    parent_user_id: str | None = USER_ID,
    reads_used: int = 0,
) -> SimpleNamespace:
    delegation = {}
    if parent_thread_id is not None:
        delegation["parent_thread_id"] = parent_thread_id
    if parent_user_id is not None:
        delegation["parent_user_id"] = parent_user_id
    return SimpleNamespace(
        state={
            "delegation_context": delegation,
            "builder_session_context_reads": reads_used,
        },
        config={"configurable": {}},
        context={},
    )


def _invoke(runtime: SimpleNamespace, query: str, **kwargs):
    return asyncio.run(
        read_session_context.coroutine(
            runtime=runtime, query=query, tool_call_id="tc-read", **kwargs
        )
    )


def _materialize_two_sessions(tmp_path, monkeypatch) -> None:
    materialize_ledger(tmp_path, monkeypatch)
    # A sibling session with DIFFERENT content under the same user.
    other = [
        {"turn_number": 1, "user_text": "Secret project Zephyr budget is 9.9M", "artifact": {}},
    ]
    materialize_ledger(tmp_path, monkeypatch, thread_id=_OTHER_THREAD, turns=other)


def _message_text(command) -> str:
    return command.update["messages"][0].content


def test_query_recalls_seeded_t18_data(tmp_path, monkeypatch):
    _materialize_two_sessions(tmp_path, monkeypatch)
    result = _invoke(_runtime(), "Q3 numbers")
    text = _message_text(result)
    assert "t18" in text
    assert SEEDED_DATA_T18 in text
    assert result.update["builder_session_context_reads"] == 1


def test_cross_session_content_is_unreachable(tmp_path, monkeypatch):
    _materialize_two_sessions(tmp_path, monkeypatch)
    result = _invoke(_runtime(), "Zephyr budget")
    text = _message_text(result)
    assert "9.9M" not in text
    assert "Zephyr" not in text.replace("Zephyr budget", "")  # only the echo of the query


def test_tool_signature_has_no_thread_or_user_params():
    fields = set(read_session_context.args_schema.model_fields)
    assert "query" in fields
    assert "max_results" in fields
    assert not fields & {"user_id", "thread_id", "session_id", "parent_thread_id"}


def test_fifth_call_is_refused(tmp_path, monkeypatch):
    _materialize_two_sessions(tmp_path, monkeypatch)
    result = _invoke(_runtime(reads_used=4), "Q3 numbers")
    text = _message_text(result)
    assert "Call cap reached" in text
    assert "brief_assumptions" in text
    # The refusal does not burn another increment.
    assert "builder_session_context_reads" not in result.update


def test_unresolvable_scope_returns_clean_message(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    result = _invoke(_runtime(parent_thread_id=None, parent_user_id=None), "anything")
    assert "not resolvable" in _message_text(result)


def test_invalid_user_id_cannot_traverse(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    result = _invoke(_runtime(parent_user_id="../../etc"), "anything")
    # safe_user_path raises inside read_ledger_with_fallback → caught →
    # clean "no record" message; never an exception, never a hit.
    assert "No conversation record" in _message_text(result)


def test_no_match_suggests_assumption_path(tmp_path, monkeypatch):
    _materialize_two_sessions(tmp_path, monkeypatch)
    result = _invoke(_runtime(), "quarterly kumquat forecast")
    assert "No conversation turns matched" in _message_text(result)


def test_mirror_fallback_on_local_miss(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    lines = "\n".join(
        __import__("json").dumps(entry) for entry in fixture_entries()
    ).encode("utf-8")
    fake_store = SimpleNamespace(
        is_configured=lambda: True,
        download_artifact=lambda _t, _o: (lines, "application/x-ndjson"),
        upload_artifact=lambda *a, **k: "path",
        ledger_object_name=lambda: "ledger/session.jsonl",
    )
    monkeypatch.setattr(delegation_ledger, "_store", lambda: fake_store)
    result = _invoke(_runtime(), "Q3 numbers")
    assert SEEDED_DATA_T18 in _message_text(result)


def test_max_results_clamped(tmp_path, monkeypatch):
    _materialize_two_sessions(tmp_path, monkeypatch)
    result = _invoke(_runtime(), "the", max_results=99)
    text = _message_text(result)
    hits = [line for line in text.splitlines() if line.startswith("t")]
    assert len(hits) <= 10
