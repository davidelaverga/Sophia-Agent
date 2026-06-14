"""G-DEL-1 — the delegation ledger survives compaction and deletion reaches it.

Drives ``DelegationLedgerMiddleware`` per turn with fabricated state,
simulates the ``RemoveMessage(REMOVE_ALL_MESSAGES)`` compaction at turn 30
(message list collapses, ``turn_count`` restarts), and asserts the ledger
holds 40 correctly-numbered entries with the seeded turn-12 style
constraint verbatim. Deletion: the gateway session-delete path removes the
local file AND the Supabase mirror object.
"""

from __future__ import annotations

from types import SimpleNamespace

from delegation_fixture import (
    SEEDED_STYLE_T12,
    THREAD_ID,
    USER_ID,
    load_fixture_turns,
    materialize_ledger,
)
from langchain_core.messages import AIMessage, HumanMessage

from deerflow.agents.sophia_agent.middlewares.delegation_ledger import (
    DelegationLedgerMiddleware,
)
from deerflow.sophia import delegation_ledger


def _runtime(thread_id: str = THREAD_ID, user_id: str | None = None) -> SimpleNamespace:
    configurable: dict = {"thread_id": thread_id}
    if user_id is not None:
        configurable["user_id"] = user_id
    return SimpleNamespace(
        context={"thread_id": thread_id},
        config={"configurable": configurable},
    )


def _turn_state(turn: dict, turn_count: int) -> dict:
    return {
        "user_id": USER_ID,
        "turn_count": turn_count,
        "messages": [
            HumanMessage(content=turn["user_text"]),
            AIMessage(content="ok", tool_calls=[]),
        ],
        "current_artifact": turn.get("artifact") or {},
    }


def _drive_session(monkeypatch, tmp_path, *, compaction_at: int = 30) -> None:
    """Run the middleware once per fixture turn, collapsing turn_count at
    ``compaction_at`` the way TurnCountMiddleware does after RemoveAll."""
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    mw = DelegationLedgerMiddleware()
    for turn in load_fixture_turns():
        n = turn["turn_number"]
        # Post-compaction the message list holds only the recent tail, so
        # the derived turn_count restarts near zero — the ledger numbering
        # must NOT.
        turn_count = (n - 1) if n <= compaction_at else (n - compaction_at)
        mw.after_agent(_turn_state(turn, turn_count), _runtime())


def test_ledger_survives_compaction_40_of_40(tmp_path, monkeypatch):
    _drive_session(monkeypatch, tmp_path)
    entries = delegation_ledger.read_ledger(USER_ID, THREAD_ID)
    assert len(entries) == 40
    assert [entry["turn_number"] for entry in entries] == list(range(1, 41))


def test_seeded_turn_12_style_constraint_verbatim(tmp_path, monkeypatch):
    _drive_session(monkeypatch, tmp_path)
    entries = delegation_ledger.read_ledger(USER_ID, THREAD_ID)
    entry_12 = next(entry for entry in entries if entry["turn_number"] == 12)
    assert SEEDED_STYLE_T12 in entry_12["user_text"]
    assert entry_12["deliverable_intent"] is True  # "style" marker


def test_user_text_capped_with_truncation_flag(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    entry = delegation_ledger.build_entry(1, "x" * 4_001, None)
    assert len(entry["user_text"]) == 4_000
    assert entry["user_text_truncated"] is True
    short = delegation_ledger.build_entry(2, "x" * 4_000, None)
    assert "user_text_truncated" not in short


def test_deliverable_intent_marker_and_lifecycle_branches():
    assert delegation_ledger.deliverable_intent("can you build me something") is True
    assert delegation_ledger.deliverable_intent("rough day at work") is False
    assert (
        delegation_ledger.deliverable_intent("rough day", ["start_builder_task"]) is True
    )
    assert delegation_ledger.deliverable_intent("rough day", ["emit_artifact"]) is False


def test_append_never_raises_on_bad_user_id(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    assert delegation_ledger.append_turn("../evil", THREAD_ID, {"turn_number": 1}) is False


def test_middleware_skips_cleanly_without_ids(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    mw = DelegationLedgerMiddleware()
    state = {"messages": [HumanMessage(content="hello")], "turn_count": 0}
    runtime = SimpleNamespace(context={}, config={})
    assert mw.after_agent(state, runtime) is None
    assert delegation_ledger.read_ledger(USER_ID, THREAD_ID) == []


def test_ledger_flag_off_disables_appends(tmp_path, monkeypatch):
    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")
    monkeypatch.setenv("SOPHIA_DELEGATION_LEDGER", "0")
    mw = DelegationLedgerMiddleware()
    turn = load_fixture_turns()[0]
    mw.after_agent(_turn_state(turn, 0), _runtime())
    assert delegation_ledger.read_ledger(USER_ID, THREAD_ID) == []


def test_restart_overwrite_guard_materializes_mirror_before_append(tmp_path, monkeypatch):
    """A langgraph restart wipes the local file; the next append must extend
    the mirrored 40-entry record, not start a fresh 1-entry file."""
    entries = materialize_ledger(tmp_path, monkeypatch)
    full_content = delegation_ledger.ledger_path(USER_ID, THREAD_ID).read_bytes()
    delegation_ledger.ledger_path(USER_ID, THREAD_ID).unlink()  # the restart

    def _fake_download(thread_id, object_name):
        assert thread_id == THREAD_ID
        assert object_name == "ledger/session.jsonl"
        return full_content, "application/x-ndjson"

    fake_store = SimpleNamespace(
        is_configured=lambda: True,
        download_artifact=_fake_download,
        upload_artifact=lambda *a, **k: "path",
        ledger_object_name=lambda: "ledger/session.jsonl",
    )
    monkeypatch.setattr(delegation_ledger, "_store", lambda: fake_store)

    new_entry = delegation_ledger.build_entry(41, "and add a closing slide", None)
    assert delegation_ledger.append_turn(USER_ID, THREAD_ID, new_entry)
    recovered = delegation_ledger.read_ledger(USER_ID, THREAD_ID)
    assert len(recovered) == len(entries) + 1
    assert recovered[-1]["turn_number"] == 41


def test_next_turn_number_is_compaction_immune(tmp_path, monkeypatch):
    materialize_ledger(tmp_path, monkeypatch)
    # Post-compaction state turn_count restarts at 2 — ledger continues at 41.
    assert delegation_ledger.next_turn_number(USER_ID, THREAD_ID, 2) == 41
    # Empty ledger falls back to state.
    assert delegation_ledger.next_turn_number(USER_ID, "thread-empty", 2) == 3


def test_session_delete_removes_local_file_and_mirror(tmp_path, monkeypatch):
    from app.gateway.routers import sessions as sessions_router

    materialize_ledger(tmp_path, monkeypatch)
    assert delegation_ledger.ledger_path(USER_ID, THREAD_ID).is_file()

    deleted_objects: list[tuple[str, str]] = []

    class _FakeStore:
        @staticmethod
        def is_configured() -> bool:
            return True

        @staticmethod
        def delete_artifact(thread_id: str, filename: str) -> bool:
            deleted_objects.append((thread_id, filename))
            return True

        @staticmethod
        def ledger_object_name() -> str:
            return "ledger/session.jsonl"

    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.is_configured",
        _FakeStore.is_configured,
    )
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.delete_artifact",
        _FakeStore.delete_artifact,
    )

    sessions_router._cleanup_session_ledger(USER_ID, THREAD_ID)

    assert not delegation_ledger.ledger_path(USER_ID, THREAD_ID).exists()
    assert deleted_objects == [(THREAD_ID, "ledger/session.jsonl")]


def test_chain_position_after_artifact_before_summarization(monkeypatch):
    """Order is load-bearing: the ledger entry must see this turn's
    current_artifact (Artifact runs first) and must be written from
    un-wiped messages (Summarization is appended last)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    import deerflow.agents.sophia_agent.agent as companion_module

    captured: dict = {}

    def _capture_create_agent(**kwargs):
        captured["middleware"] = kwargs.get("middleware") or []
        agent = SimpleNamespace(name="agent")
        agent.recursion_limit = 0
        return agent

    monkeypatch.setattr(companion_module, "ChatAnthropic", lambda **kwargs: {"model": kwargs["model"]})
    monkeypatch.setattr(companion_module, "create_agent", _capture_create_agent)
    companion_module.make_sophia_agent({"configurable": {"user_id": "user_123"}})
    names = [type(mw).__name__ for mw in captured["middleware"]]
    assert "DelegationLedgerMiddleware" in names
    artifact_index = names.index("ArtifactMiddleware")
    ledger_index = names.index("DelegationLedgerMiddleware")
    assert ledger_index == artifact_index + 1
    if "SophiaSummarizationMiddleware" in names:
        assert ledger_index < names.index("SophiaSummarizationMiddleware")


def test_expected_mirror_miss_logs_debug_not_warning(tmp_path, monkeypatch, caplog):
    """Correction wave 2026-06-12: Supabase answers 400 for the expected
    no-mirror-yet first-turn shape — that must not produce a warning
    traceback (1 of the 2026-06-12 window's 3 prod tracebacks was this
    non-event). Real transport failures keep the loud path."""
    import logging

    import httpx

    monkeypatch.setattr(delegation_ledger, "USERS_DIR", tmp_path / "users")

    def _make_store(status_code: int):
        def _raise_download(_t, _o):
            request = httpx.Request("GET", "https://supabase.example/object")
            response = httpx.Response(status_code, request=request)
            raise httpx.HTTPStatusError("boom", request=request, response=response)

        return SimpleNamespace(
            is_configured=lambda: True,
            download_artifact=_raise_download,
            upload_artifact=lambda *a, **k: "path",
            ledger_object_name=lambda: "ledger/session.jsonl",
        )

    monkeypatch.setattr(delegation_ledger, "_store", lambda: _make_store(400))
    with caplog.at_level(logging.DEBUG):
        assert delegation_ledger._materialize_from_mirror(USER_ID, THREAD_ID) is False
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert not warnings
    assert "no mirror yet" in caplog.text

    caplog.clear()
    monkeypatch.setattr(delegation_ledger, "_store", lambda: _make_store(503))
    with caplog.at_level(logging.DEBUG):
        assert delegation_ledger._materialize_from_mirror(USER_ID, THREAD_ID) is False
    assert any(
        r.levelno >= logging.WARNING and "mirror_download_failed" in r.message
        for r in caplog.records
    )


def test_cleanup_failure_never_raises(monkeypatch):
    from app.gateway.routers import sessions as sessions_router

    monkeypatch.setattr(
        "deerflow.sophia.delegation_ledger.delete_ledger_local",
        lambda *_a: (_ for _ in ()).throw(RuntimeError("disk")),
    )
    sessions_router._cleanup_session_ledger(USER_ID, THREAD_ID)  # must not raise
    sessions_router._cleanup_session_ledger(USER_ID, None)  # no-op on missing thread
