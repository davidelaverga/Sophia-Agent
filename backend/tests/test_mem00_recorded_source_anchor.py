"""A recorded source row stays provable; admission refusals name their cause.

2026-09-28: voice Builder requests were recorded, then the browser's transcript
snapshot rewrote the recorded row, so LangGraph refused every admission with
one opaque 403. A retry on the same thread then hit a store method that did not
exist. These tests pin the three repairs: the write-once migration (SQL proof is
the disposable-PostgreSQL contract below), the pending-input receipt lookup,
and content-free refusal reasons.
"""

import ast
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from langchain_core.messages import HumanMessage
from langgraph_sdk import Auth
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from mem00_recorded_input_fixture import RecordedInputFixture
from pydantic import BaseModel

from deerflow.sophia import langgraph_auth as policy
from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
from deerflow.sophia.memory_governance.pending_input_recovery import checkpoint_source_history
from deerflow.sophia.memory_governance.source_input_provenance import (
    SOURCE_ACTION_KEY,
    SOURCE_SESSION_KEY,
    observe_recorded_source,
    safe_reason_code,
)
from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict, MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

ROOT = Path(__file__).parents[1]
MIGRATION = ROOT / "migrations/2026_09_29_mem00_recorded_source_anchor.sql"
CONTRACT = Path(__file__).parent / "mem00_recorded_source_anchor_contract.sql"
HARNESS = ROOT / "packages/harness/deerflow"
SECRET_CONTENT = "SYNTHETIC SECRET BRIEF 7f3c"

# Store calls behind C1 transitions that create_run refuses outright
# (memory_source_attachment_keys, sophia_builder_completion_request_v1).
DEFERRED_STORE_CALLS = frozenset({
    "check_source_attachment", "get_source_attachment", "register_source_attachment",
    "get_completion_source_run", "register_completion_source_run",
})


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-anchor-source-" * 3)


def _store_calls(path: Path) -> set[str]:
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            target = node.func.value
            if isinstance(target, ast.Name) and target.id == "store":
                names.add(node.func.attr)
            elif isinstance(target, ast.Attribute) and target.attr == "store" and isinstance(target.value, ast.Name) and target.value.id == "self":
                names.add(node.func.attr)
    return names


def test_every_reachable_governance_store_call_exists_on_the_supabase_store():
    paths = [*(HARNESS / "sophia/memory_governance").glob("*.py"), HARNESS / "agents/sophia_agent/middlewares/memory_context.py"]
    called = set().union(*(_store_calls(path) for path in paths))
    missing = {name for name in called if not hasattr(SupabaseMemoryGovernanceStore, name)}
    assert "source_action_receipt_for_message" in called
    assert missing == DEFERRED_STORE_CALLS


def test_receipt_lookup_calls_the_by_message_rpc():
    calls = []
    store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="synthetic")
    store._rpc = lambda name, payload: calls.append((name, payload)) or {"ok": True}
    assert store.source_action_receipt_for_message(user_id="owner", session_id="session", message_id="message-0001") == {"ok": True}
    assert calls == [("sophia_memory_lookup_source_action_by_message",
        {"p_user_id": "owner", "p_session_id": "session", "p_message_id": "message-0001"})]


def test_missing_receipt_is_refused_with_its_own_reason():
    store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="synthetic")
    store._rpc = lambda name, payload: None
    with pytest.raises(MemoryGovernanceUnavailable) as missing:
        store.source_action_receipt_for_message(user_id="owner", session_id="session", message_id="message-0001")
    assert missing.value.reason == "memory_source_receipt_not_found"


def _pending_state(secret_fixture_owner="owner"):
    store = RecordedInputFixture()
    thread = str(uuid4())
    session, earlier = store.record(secret_fixture_owner, thread, SECRET_CONTENT)
    _, current = store.record(secret_fixture_owner, thread, "SYNTHETIC CURRENT INPUT", session=session)
    witness = observe_recorded_source(owner_id=secret_fixture_owner, session_id=session, thread_id=thread, action=current, store=store)
    # A run that failed entry leaves its input in the checkpoint, unsealed.
    state = {"messages": [HumanMessage(id=earlier["message_id"], content=earlier["content"])]}
    return store, thread, earlier, witness, state


def test_pending_input_recovery_proves_an_intact_earlier_input(secret):
    store, thread, earlier, witness, state = _pending_state()
    history = checkpoint_source_history(owner_id="owner", context_id=thread, state=state, current_witness=witness, store=store)
    assert history.pending_count == 1
    assert [item.message_id for item in history.sources] == [earlier["message_id"]]


def test_pending_input_recovery_refuses_a_rewritten_earlier_input_and_names_why(secret):
    store, thread, earlier, witness, state = _pending_state()
    store.versions[earlier["message_id"]] = str(uuid4())
    with pytest.raises(MemoryGovernanceUnavailable) as refused:
        checkpoint_source_history(owner_id="owner", context_id=thread, state=state, current_witness=witness, store=store)
    assert refused.value.reason == "memory_pending_source_history_unproven"
    assert refused.value.safe_reason == "source_version_changed"


def test_safe_reason_never_reports_exception_text():
    class Shape(BaseModel):
        value: int

    assert safe_reason_code(ValueError("source_version_changed")) == "source_version_changed"
    assert safe_reason_code(ValueError(SECRET_CONTENT)) == "ValueError"
    assert safe_reason_code(ValueError("batteries")) == "ValueError"
    with pytest.raises(ValueError) as invalid:
        Shape.model_validate({"value": SECRET_CONTENT})
    assert safe_reason_code(invalid.value) == "ValidationError"
    assert safe_reason_code(MemoryGovernanceUnavailable("governance_http_4xx")) == "governance_http_4xx"
    assert safe_reason_code(MemoryGovernanceConflict("governance_revision_conflict")) == "governance_revision_conflict"
    assert safe_reason_code(RuntimeError(SECRET_CONTENT)) == "RuntimeError"
    assert safe_reason_code(AttributeError("source_action_receipt_for_message")) == "AttributeError"
    # Never raises, even on odd exception arguments.
    assert safe_reason_code(ValueError(["unhashable"])) == "ValueError"


def test_safe_reason_survives_nested_wrappers():
    from deerflow.sophia.memory_governance.source_input_provenance import _source_unavailable

    inner = _source_unavailable(AttributeError("missing"))
    assert safe_reason_code(_source_unavailable(inner)) == "AttributeError"
    inner = _source_unavailable(ValueError("source_version_changed"))
    assert safe_reason_code(_source_unavailable(inner)) == "source_version_changed"
    # An attribute that is not a safe token is ignored.
    odd = MemoryGovernanceUnavailable("governance_http_5xx")
    odd.safe_reason = SECRET_CONTENT
    assert safe_reason_code(odd) == "governance_http_5xx"


def test_pending_input_recovery_refuses_an_earlier_input_without_a_receipt(secret):
    store, thread, earlier, witness, state = _pending_state()
    state["messages"][0] = HumanMessage(id="unrecorded-message-0001", content=earlier["content"])
    with pytest.raises(MemoryGovernanceUnavailable) as refused:
        checkpoint_source_history(owner_id="owner", context_id=thread, state=state, current_witness=witness, store=store)
    assert refused.value.safe_reason == "memory_source_receipt_not_found"


@pytest.fixture
def admission(monkeypatch, declare_memory_owners, secret):  # noqa: F811 - pytest fixture request
    declare_memory_owners({"owner": "governed"})
    store = RecordedInputFixture()
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: store)
    thread, run = str(uuid4()), str(uuid4())
    session, action = store.record("owner", thread, SECRET_CONTENT)
    cfg = {"user_id": "owner", "langgraph_auth_user_id": "owner", SOURCE_ACTION_KEY: action, SOURCE_SESSION_KEY: session,
        INPUT_PROOF_KEY: None, INPUT_RUN_KEY: None}
    value = {"thread_id": thread, "run_id": run, "assistant_id": policy.COMPANION_ASSISTANT_ID,
        "kwargs": {"config": {"configurable": cfg}, "context": {}, "input": {"messages": [{"role": "user", "content": action["content"]}]}}}
    ctx = SimpleNamespace(user=SimpleNamespace(identity="owner"), permissions=[policy.USER_PERMISSION])
    return SimpleNamespace(store=store, value=value, ctx=ctx, action=action, session=session, thread=thread, run=run)


def _denials(caplog):
    return [json.loads(record.getMessage().split(" ", 1)[1]) for record in caplog.records
        if record.name == policy.logger.name and record.getMessage().startswith("memory_admission_denied ")]


@pytest.mark.anyio
async def test_rewritten_source_is_refused_with_a_content_free_logged_reason(admission, caplog):
    admission.store.versions[admission.action["message_id"]] = str(uuid4())
    with caplog.at_level(logging.WARNING, logger=policy.logger.name), pytest.raises(Auth.exceptions.HTTPException) as refused:
        await policy.create_run(admission.ctx, admission.value)
    assert refused.value.status_code == 403 and refused.value.detail == "sophia_access_denied"
    [event] = _denials(caplog)
    assert event["stage"] == "admission"
    assert event["error_type"] == "MemoryGovernanceUnavailable"
    assert event["denial_reason"] == "source_version_changed"
    assert set(event) == {"event_name", "stage", "error_type", "denial_reason", "owner_ref", "context_ref", "run_ref"}
    logged = caplog.text
    for raw in (SECRET_CONTENT, "owner\"", admission.thread, admission.run, admission.session, admission.action["message_id"]):
        assert raw not in logged


@pytest.mark.anyio
@pytest.mark.parametrize(("fault", "stage"), [
    ("command", "command_present"), ("other_graph", "companion_scope"),
    ("config_owner", "configurable_owner"), ("disabled", "disabled_carrier"),
])
async def test_direct_refusals_log_their_stage(admission, caplog, fault, stage):
    cfg = admission.value["kwargs"]["config"]["configurable"]
    if fault == "command":
        admission.value["kwargs"]["command"] = {"resume": "untrusted"}
    if fault == "other_graph":
        admission.value["assistant_id"] = "lead_agent"
    if fault == "config_owner":
        cfg["user_id"] = "other"
    if fault == "disabled":
        cfg["memory_source_attachment_keys"] = ["untrusted"]
    with caplog.at_level(logging.WARNING, logger=policy.logger.name), pytest.raises(Auth.exceptions.HTTPException):
        await policy.create_run(admission.ctx, admission.value)
    [event] = _denials(caplog)
    assert event["stage"] == stage
    assert "denial_reason" not in event


@pytest.mark.anyio
async def test_admitted_run_logs_no_denial(admission, caplog):
    with caplog.at_level(logging.WARNING, logger=policy.logger.name):
        await policy.create_run(admission.ctx, admission.value)
    assert _denials(caplog) == []


def test_migration_keeps_the_snapshot_rpc_contract_and_adds_only_service_role_grants():
    sql = MIGRATION.read_text()
    assert sql.lstrip().startswith("--") and "\nBEGIN;\n" in sql and sql.rstrip().endswith("COMMIT;")
    assert "CREATE OR REPLACE FUNCTION public.sophia_replace_session_messages(\n    p_user_id TEXT,\n    p_session_id TEXT,\n    p_expected_revision BIGINT,\n    p_messages JSONB\n)" in sql
    assert "SECURITY DEFINER\nSET search_path = public" in sql
    assert "GRANT EXECUTE ON FUNCTION public.sophia_replace_session_messages(TEXT, TEXT, BIGINT, JSONB)\n    TO service_role;" in sql
    assert "GRANT EXECUTE ON FUNCTION public.sophia_memory_lookup_source_action_by_message(text,text,text) TO service_role;" in sql
    assert sql.count("GRANT EXECUTE") == 2
    assert "FROM PUBLIC,anon,authenticated,service_role" in sql
    lowered = sql.lower()
    # The Voice Lab ledger pins the exact trigger set of sophia_session_messages.
    for forbidden in ("create trigger", "drop trigger", "drop function", "disable trigger", "alter table",
                      "update public.sophia_session_messages", "delete from public.sophia_memory"):
        assert forbidden not in lowered


@pytest.mark.skipif(not os.getenv("SOPHIA_MEM00_TEST_DATABASE_URL"), reason="requires a disposable, fully migrated local PostgreSQL")
def test_recorded_source_anchor_contract_on_postgres():
    import psycopg

    dsn = os.environ["SOPHIA_MEM00_TEST_DATABASE_URL"]
    host = urlsplit(dsn).hostname or ""
    assert host in {"127.0.0.1", "localhost"} or host.startswith("/"), "disposable local database only"
    with psycopg.connect(dsn) as db:
        try:
            db.execute(CONTRACT.read_text())
        finally:
            db.rollback()
