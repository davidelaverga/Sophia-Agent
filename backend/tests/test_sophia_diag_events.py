"""Content-free launch-timeline diagnostics (``sophia_diag`` lines).

Each instrumented hop emits exactly one event, carries only join identifiers,
codes and numbers, and never changes the outcome it observes. Inputs use
sentinel strings so any leak of owner identity or content is detectable.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import random
import re
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from langchain_core.messages import HumanMessage
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from mem00_recorded_input_fixture import RecordedInputFixture

from deerflow.sophia import diag

OWNER = "owner-sentinel-q7z"
CONTENT = "SENTINEL PRIVATE CONTENT 4471"
SECRET_DETAIL = "SENTINEL EXCEPTION DETAIL 9902"
DIAG_LOGGER = "deerflow.sophia.diag"
BACKEND = Path(__file__).resolve().parents[1]


def _events(caplog, name=None):
    found = []
    for record in caplog.records:
        message = record.getMessage()
        if message.startswith("sophia_diag "):
            payload = json.loads(message[len("sophia_diag ") :])
            if name is None or payload["ev"] == name:
                found.append((record.levelno, payload))
    return found


def _one(caplog, name):
    events = _events(caplog, name)
    assert len(events) == 1, events
    return events[0]


def _assert_content_free(caplog, *extra):
    text = caplog.text
    for sentinel in (OWNER, CONTENT, SECRET_DETAIL, *extra):
        assert sentinel not in text


def _uuid7() -> str:
    millis = int(time.time() * 1000)
    value = (millis << 80) | (0x7 << 76) | (random.getrandbits(12) << 64) | (0b10 << 62) | random.getrandbits(62)
    return str(UUID(int=value))


@pytest.fixture
def diag_logs(caplog):
    caplog.set_level(logging.DEBUG, logger=DIAG_LOGGER)
    return caplog


# ---------------------------------------------------------------------------
# Helper contract
# ---------------------------------------------------------------------------


def test_validator_rejects_denied_keys_free_text_and_unknown_keys(diag_logs):
    before = diag.diag_stats()["dropped_fields"]
    diag.diag_event(
        "builder.launch",
        phase="begin",
        thread_id=str(uuid4()).upper(),
        user_id=OWNER,
        session_id=str(uuid4()),
        content=CONTENT,
        query=CONTENT,
        outcome=CONTENT,
        reason="Has Spaces",
        route="voice\n",
        error_type="Mem0ContractError",
        tool_call_id="toolu_01AbCdEf",
        owner=OWNER,
        site="https://example.com/?q=1",
        by_site={"memory": {"n": 1}},
        exports={"disabled": {"n": 2, "ms": 3}},
        total_ms=12.345,
        check_ms=float("nan"),
        handoff_event_id=object(),
    )
    level, event = _one(diag_logs, "builder.launch")
    assert level == logging.INFO
    assert event["phase"] == "begin"
    assert event["thread_id"] == event["thread_id"].lower()
    assert event["error_type"] == "Mem0ContractError"
    assert event["tool_call_id"] == "toolu_01AbCdEf"
    assert event["exports"] == {"disabled": {"n": 2, "ms": 3}}
    assert event["total_ms"] == 12.3
    for dropped in ("user_id", "session_id", "content", "query", "outcome", "reason", "route", "owner", "site", "by_site", "check_ms", "handoff_event_id"):
        assert dropped not in event
    assert event["dropped_fields"] == 12
    assert diag.diag_stats()["dropped_fields"] - before == 12
    _assert_content_free(diag_logs, "https://example.com")


def test_diag_event_never_raises_and_skips_disabled_levels(diag_logs, monkeypatch):
    diag.diag_event("not a valid name!", outcome="ok")
    assert _events(diag_logs)[-1][1]["ev"] == "invalid_event"
    monkeypatch.setattr(diag.json, "dumps", lambda *a, **k: (_ for _ in ()).throw(RuntimeError(SECRET_DETAIL)))
    failed = diag.diag_stats()["failed"]
    diag.diag_event("builder.launch", phase="end")
    assert diag.diag_stats()["failed"] == failed + 1
    monkeypatch.undo()
    diag_logs.set_level(logging.INFO, logger=DIAG_LOGGER)
    diag.diag_event("memory_guard.check", _level=logging.DEBUG, op="check")
    assert _events(diag_logs, "memory_guard.check") == []
    _assert_content_free(diag_logs)


def test_safe_ref_never_raises_without_a_secret(monkeypatch):
    monkeypatch.delenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", raising=False)
    assert diag.safe_ref("owner", OWNER) is None
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    assert diag.safe_ref("owner", OWNER).startswith("hmac-sha256:owner:")


def test_run_timing_uses_factory_start_and_uuid7_creation():
    run_id = _uuid7()
    diag.mark_run_start(run_id)
    timing = diag.run_timing(run_id)
    assert 0 <= timing["since_run_start_ms"] < 5_000
    assert 0 <= timing["since_run_created_ms"] < 5_000
    assert diag.run_timing(str(uuid4())).keys() <= {"since_run_start_ms"}
    assert diag.run_timing("not-a-run") == {}


# ---------------------------------------------------------------------------
# Governance store and Mem0 adapter accumulation
# ---------------------------------------------------------------------------


def _mock_store(requests=None):
    from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore

    def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        path = request.url.path
        if path.endswith("/sophia_memory_contract"):
            return httpx.Response(200, json=[{"contract_epoch": 1, "schema_version": "mem00.v1", "mode": "enforced", "updated_at": "2026-09-01T00:00:00Z"}])
        if path.endswith("/sophia_memory_user_governance"):
            return httpx.Response(200, json=[{"user_id": OWNER, "user_catalog_generation": 1, "user_revocation_epoch": 0, "provider_subject": "synthetic-subject"}])
        if path.endswith("/rpc/sophia_memory_record_prompt_admission"):
            return httpx.Response(200, json=str(uuid4()))
        return httpx.Response(503, json={"message": SECRET_DETAIL})

    return SupabaseMemoryGovernanceStore(url="https://synthetic.supabase.test", service_role_key="k" * 40, client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_store_counters_aggregate_across_to_thread():
    store = _mock_store()

    async def main():
        run, token = diag.install_run_diag()
        try:
            await asyncio.to_thread(store.get_contract)
            await asyncio.gather(asyncio.to_thread(store.get_user_governance, OWNER), asyncio.to_thread(store.get_user_governance, OWNER))
            with pytest.raises(Exception):
                await asyncio.to_thread(store._request, "GET", "sophia_memory_unknown_table")
        finally:
            diag.reset_run_diag(token)
        # Outside the accumulator nothing is counted.
        await asyncio.to_thread(store.get_contract)
        return run.snapshot()

    snapshot = asyncio.run(main())
    assert snapshot["store_requests"] == 4
    assert snapshot["store_errors"] == 1
    assert snapshot["store_by_resource"]["sophia_memory_contract"]["n"] == 1
    assert snapshot["store_by_resource"]["sophia_memory_user_governance"]["n"] == 2
    assert snapshot["store_by_resource"]["sophia_memory_unknown_table"]["n"] == 1
    assert OWNER not in json.dumps(snapshot) and SECRET_DETAIL not in json.dumps(snapshot)


def test_mem0_adapter_reports_client_construction_and_search(monkeypatch):
    import sys

    from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter

    class FakeClient:
        def __init__(self, **kwargs):
            time.sleep(0.002)

        def search(self, **kwargs):
            return {"results": [{"id": "p1", "score": 0.5}]}

    monkeypatch.setitem(sys.modules, "mem0", SimpleNamespace(MemoryClient=FakeClient))
    monkeypatch.setenv("MEM0_API_KEY", "synthetic-key")
    monkeypatch.delenv("MEM0_BASE_URL", raising=False)
    run, token = diag.install_run_diag()
    try:
        adapter = Mem0ProjectionAdapter()
        hits = adapter.search_ids(query=CONTENT, provider_subject="subject", metadata_filter={}, limit=1)
        assert adapter.diag_last_client_ms >= 1
        adapter.search_ids(query=CONTENT, provider_subject="subject", metadata_filter={}, limit=1)
        assert adapter.diag_last_client_ms == 0
    finally:
        diag.reset_run_diag(token)
    assert [hit.provider_memory_id for hit in hits] == ["p1"]
    snapshot = run.snapshot()
    assert snapshot["mem0_client_new"] == 1 and snapshot["mem0_search_count"] == 2
    assert CONTENT not in json.dumps(snapshot)


# ---------------------------------------------------------------------------
# Retained admission timing segments
# ---------------------------------------------------------------------------


def test_retained_admission_records_extra_latency_segments_and_export_status(monkeypatch):
    from unittest.mock import Mock

    from deerflow.sophia.memory_governance.models import AuthorizedMemory
    from deerflow.sophia.memory_governance.refs import keyed_ref
    from deerflow.sophia.memory_governance.retained_admission import readmit_retained_context
    from deerflow.sophia.memory_governance.retained_context import MemoryInclusion, RetainedMemoryContext
    from deerflow.sophia.memory_governance.service import MemoryProviderContract

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "false")
    memory = UUID(int=1)
    context = RetainedMemoryContext(keyed_ref("owner", OWNER), 3, (MemoryInclusion(memory, 2, 4),))
    store = Mock()
    store.get_contract.return_value = SimpleNamespace(schema_version="mem00.v1", mode="enforced", contract_epoch=1)
    store.get_user_governance.return_value = SimpleNamespace(user_id=OWNER, user_revocation_epoch=3, user_catalog_generation=6, provider_subject="ns")
    store.hydrate_inclusions.return_value = (AuthorizedMemory(memory_id=memory, content_revision=2, memory_governance_revision=4, canonical_content=CONTENT, category="fact", scope="global", score=None),)
    store.record_prompt_admission.return_value = UUID(int=9)
    adapter = Mock()
    adapter.search_ids.return_value = ()
    adapter.diag_last_client_ms = 7
    run, token = diag.install_run_diag()
    try:
        result = readmit_retained_context(
            store=store,
            adapter=adapter,
            provider=MemoryProviderContract("mem0", "production", "project"),
            service_name="test",
            owner_id=OWNER,
            context=context,
            scope="text",
            caller="runtime_context_boundary",
            query=CONTENT,
            latency_segments={"flags_ms": 3, "bogus": "x", "flag": 2, "bool_ms": True},
        )
    finally:
        diag.reset_run_diag(token)
    assert result.transition.action == "continue"
    segments = store.record_prompt_admission.call_args.args[0]["latency_segments"]
    assert set(segments) == {"flags_ms", "observe_ms", "clock_ms", "mem0_client_ms", "mem0_search_ms", "hydrate_ms", "contract_ms", "total_ms"}
    assert segments["flags_ms"] == 3 and segments["mem0_client_ms"] == 7
    assert all(isinstance(value, int) and not isinstance(value, bool) for value in segments.values())
    assert run.snapshot()["exports"] == {"disabled": {"n": 1, "ms": run.snapshot()["exports"]["disabled"]["ms"]}}


def _rpc_body(sql: str) -> str:
    match = re.search(
        r"CREATE OR REPLACE FUNCTION public\.sophia_memory_record_prompt_admission\((?P<body>.*?)\$function\$;",
        sql,
        re.S,
    )
    assert match, "record_prompt_admission RPC definition not found"
    return match.group("body")


def test_prompt_admission_rpc_stores_latency_segments_jsonb_without_key_checks():
    """Extra latency keys are safe: every deployed RPC version coalesces the JSONB as-is."""
    migrations = BACKEND / "migrations"
    definitions = [path for path in sorted(migrations.glob("*.sql")) if "sophia_memory_record_prompt_admission(" in path.read_text()]
    assert [path.name for path in definitions if "FUNCTION public.sophia_memory_record_prompt_admission" in path.read_text()]
    for path in definitions:
        text = path.read_text()
        if "FUNCTION public.sophia_memory_record_prompt_admission" not in text:
            continue
        body = _rpc_body(text)
        uses = re.findall(r"[^\n]*p_latency_segments[^\n]*", body)
        assert any("p_latency_segments JSONB" in line for line in uses)
        assert all("p_latency_segments JSONB" in line or "coalesce(p_latency_segments, '{}'::jsonb)" in line for line in uses), (path.name, uses)
        assert "jsonb_object_keys(p_latency_segments" not in body
        assert re.search(r"p_latency_segments\s*(\?|->|#>|@>)", body) is None
    for path in sorted(migrations.glob("*.sql")):
        assert re.search(r"latency_segments[^\n;]*CHECK", path.read_text(), re.I) is None


def test_store_passes_latency_segments_to_rpc_unchanged():
    requests = []
    store = _mock_store(requests)
    segments = {"flags_ms": 1, "observe_ms": 2, "mem0_client_ms": 3, "total_ms": 9}
    store.record_prompt_admission(
        {
            "retrieval_request_id": str(uuid4()),
            "user_id": OWNER,
            "caller": "c",
            "scope": "s",
            "query_ref": "q",
            "provider": "mem0",
            "environment": "e",
            "provider_project": "p",
            "provider_namespace": "n",
            "provider_status": "ok",
            "provider_hit_count": 0,
            "catalog_generation_checked": 1,
            "revocation_epoch_checked": 0,
            "authorized_manifest": [],
            "denial_counts": {},
            "outcome": "zero_memory",
            "safe_reason_code": None,
            "latency_segments": segments,
        }
    )
    assert json.loads(requests[0].content)["p_latency_segments"] == segments


# ---------------------------------------------------------------------------
# MemoryRunGuard per-run summary
# ---------------------------------------------------------------------------


def _scripted_guard(monkeypatch, store_calls):
    from deerflow.agents.sophia_agent.middlewares import memory_context
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition, RetainedMemoryContext

    store = _mock_store()
    readmits = []

    def readmit(**kwargs):
        assert isinstance(kwargs["latency_segments"]["flags_ms"], int)
        readmits.append(kwargs["context"])
        for _ in range(store_calls):
            store.get_contract()
        return RetainedAdmission(ContextTransition("continue", "empty", 0), kwargs["context"], (), uuid4())

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    monkeypatch.setattr(MemoryRunGuard, "_owner_is_undeclared", staticmethod(lambda owner: False))
    monkeypatch.setattr("deerflow.sophia.memory_governance.context_state.allows_unversioned_builder_handoff", lambda owner: False)
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner", lambda owner: SimpleNamespace(governed_runtime_read=True))
    monkeypatch.setattr("deerflow.sophia.memory_governance.retained_admission.readmit_retained_context", readmit)
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: store)
    monkeypatch.setattr("deerflow.sophia.memory_governance.mem0_projection_adapter.Mem0ProjectionAdapter", lambda: object())
    monkeypatch.setattr("deerflow.sophia.memory_governance.service.MemoryProviderContract.from_environ", lambda: object())
    monkeypatch.setattr(memory_context, "seal_checkpoint", lambda **kwargs: {"state_ref": "synthetic"})
    monkeypatch.setattr("deerflow.sophia.memory_governance.task_context_retention.validate_task_retention", lambda **kwargs: None)
    thread_id, run_id = str(uuid4()), str(uuid4())
    from deerflow.sophia.memory_governance.input_provenance import INPUT_RUN_KEY

    guard = MemoryRunGuard(owner_id=OWNER, config={"thread_id": thread_id, INPUT_RUN_KEY: run_id}, scope="life")
    assert guard.enabled
    context = RetainedMemoryContext(memory_context.keyed_ref("owner", OWNER), 0, ())
    guard.entered = True
    guard.admission = RetainedAdmission(ContextTransition("continue", "empty", 0), context, (), uuid4())
    return guard, readmits, thread_id, run_id


def test_memory_guard_summary_counts_match_a_scripted_sequence(diag_logs, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares.memory_context import _at_site

    guard, readmits, thread_id, run_id = _scripted_guard(monkeypatch, store_calls=2)
    with _at_site("script_a"):
        guard.check()
        guard.check()

    async def threaded():
        with _at_site("script_b"):
            await asyncio.to_thread(guard.check)

    asyncio.run(threaded())
    with _at_site("script_finish"):
        guard.finish({"messages": []})

    assert len(readmits) == 4  # three checks + the check inside finish
    checks = _events(diag_logs, "memory_guard.check")
    assert [(event["op"], event["site"]) for _, event in checks] == [("check", "script_a"), ("check", "script_a"), ("check", "script_b"), ("finish", "script_finish")]
    assert all(level == logging.DEBUG for level, _ in checks)
    assert checks[-1][1]["readmits"] == 1 and checks[-1][1]["store_requests"] == 2
    level, summary = _one(diag_logs, "memory_guard.summary")
    assert level == logging.INFO
    assert summary["outcome"] == "finished" and summary["lane"] == "governed" and summary["scope"] == "life"
    assert summary["thread_id"] == thread_id and summary["run_id"] == run_id
    assert summary["check_count"] == 4 and summary["readmit_count"] == 4
    assert summary["by_op"]["check"]["n"] == 4 and summary["by_op"]["finish"]["n"] == 1
    assert summary["by_site"]["script_a"] == {"n": 2, "ms": summary["by_site"]["script_a"]["ms"], "op": "check"}
    assert summary["by_site"]["script_b"]["n"] == 1 and summary["by_site"]["script_finish"]["op"] == "finish"
    assert summary["store_requests"] == 8 and summary["store_by_resource"]["sophia_memory_contract"]["n"] == 8
    assert summary["store_scope"] == "guard_ops" and summary["denied"] == 0 and summary["slow_ops"] == 0
    assert "dropped_fields" not in summary
    _assert_content_free(diag_logs)


def test_slow_guard_operation_logs_at_info_and_denials_are_counted(diag_logs, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextUnavailable

    guard, _, _, _ = _scripted_guard(monkeypatch, store_calls=0)
    monkeypatch.setattr(diag, "SLOW_GUARD_OP_MS", -1)
    guard.check()
    level, event = _events(diag_logs, "memory_guard.check")[-1]
    assert level == logging.INFO and event["op"] == "check"
    guard.entered = False
    with pytest.raises(MemoryContextUnavailable):
        guard.check()
    level, event = _events(diag_logs, "memory_guard.check")[-1]
    assert event["outcome"] == "denied" and event["error_type"] == "MemoryContextUnavailable"
    assert guard._diag_stats.summary()["denied"] == 1 and guard._diag_stats.summary()["slow_ops"] == 2


def test_entry_middleware_labels_pre_and_post_model_checks(diag_logs, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware

    guard, readmits, _, _ = _scripted_guard(monkeypatch, store_calls=0)
    middleware = MemoryContextEntryMiddleware(guard)

    async def handler(request):
        return "model-result"

    result = asyncio.run(middleware.awrap_model_call(SimpleNamespace(), handler))
    assert result == "model-result"
    # Check-count parity at the model boundary: exactly one check before and
    # one after the model call, as before instrumentation.
    assert len(readmits) == 2
    sites = [event["site"] for _, event in _events(diag_logs, "memory_guard.check")]
    assert sites == ["entry_pre", "entry_post"]


# ---------------------------------------------------------------------------
# Governed Builder dispatch
# ---------------------------------------------------------------------------


@pytest.fixture
def source(monkeypatch):
    from deerflow.sophia.memory_governance.input_provenance import issue_recorded_authenticated_input

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-diag-source-" * 3)
    store = RecordedInputFixture()
    thread, run = str(uuid4()), str(uuid4())
    session, action = store.record(OWNER, thread, CONTENT)
    wire, proof = issue_recorded_authenticated_input(owner_id=OWNER, session_id=session, thread_id=thread, run_id=run, wire_input={"messages": [{"role": "user", "content": action["content"]}]}, source_action=action, store=store)
    return SimpleNamespace(thread_id=thread, run_id=run, input_proof=proof, messages=[HumanMessage(**wire["messages"][0])], store=store)


def _dispatch_fixture(source, monkeypatch, fault):
    from deerflow.sophia.memory_governance.builder_provenance import HANDOFF_KEY, bind_builder_run
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition

    calls = []
    guard = SimpleNamespace(
        enabled=True,
        owner=OWNER,
        context_id=source.thread_id,
        scope="life",
        check=lambda: calls.append("check"),
        config={INPUT_PROOF_KEY: source.input_proof, INPUT_RUN_KEY: source.run_id},
        _readmit=lambda context: RetainedAdmission(ContextTransition("continue", "empty", 0), context, (), uuid4()),
    )
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.memory_context.active_builder_parent_guard", lambda *_: guard)
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: source.store)
    source.store.get_user_governance = lambda owner: SimpleNamespace(user_id=owner, user_revocation_epoch=0, user_catalog_generation=3)
    runs = {}

    async def create_thread(**kwargs):
        calls.append("thread")
        return {"thread_id": kwargs["thread_id"]}

    async def create_run(**kwargs):
        calls.append("run")
        if fault == "run_create_failure":
            raise RuntimeError(SECRET_DETAIL)
        child, run = kwargs["thread_id"], str(uuid4())
        bind_builder_run(owner_id=OWNER, child_thread_id=child, run_id=run, wire_input=kwargs["input"], proof=kwargs["config"]["configurable"][HANDOFF_KEY])
        runs[(child, run)] = {"thread_id": child, "run_id": run, "status": "pending"}
        return runs[(child, run)]

    async def get_run(child, run):
        calls.append("get")
        return runs[(child, run)]

    client = SimpleNamespace(threads=SimpleNamespace(create=create_thread), runs=SimpleNamespace(create=create_run, get=get_run))
    monkeypatch.setattr("deerflow.sophia.langgraph_client_auth.get_client", lambda **kwargs: client)
    return guard, calls


def test_dispatch_emits_each_hop_once_and_keeps_check_parity(source, monkeypatch, diag_logs):
    from deerflow.sophia.memory_governance.builder_provenance import dispatch_independent_builder

    guard, calls = _dispatch_fixture(source, monkeypatch, None)
    outcome = asyncio.run(dispatch_independent_builder(guard=guard, owner_id=OWNER, parent_thread_id=source.thread_id, source_messages=source.messages, tool_call_id="toolu_01Synthetic"))
    assert outcome["confirmed"] is True and outcome["status"] == "pending"
    # Same checks in the same order as before instrumentation: registration,
    # handoff seal, pre-allocation, pre-create, post-observation.
    assert calls == ["check", "check", "check", "thread", "check", "run", "get", "check"]
    _, issued = _one(diag_logs, "builder.handoff.issued")
    assert issued["parent_thread_id"] == source.thread_id and issued["child_thread_id"] == outcome["thread_id"]
    assert issued["tool_call_id"] == "toolu_01Synthetic" and isinstance(issued["register_ms"], int)
    assert UUID(issued["handoff_event_id"])
    _, created = _one(diag_logs, "builder.child.thread_created")
    assert created["outcome"] == "created" and created["child_thread_id"] == outcome["thread_id"]
    _, run_create = _one(diag_logs, "builder.child.run_create")
    assert run_create["outcome"] == "created" and run_create["child_run_id"] == outcome["run_id"]
    _, observed = _one(diag_logs, "builder.child.observed")
    assert observed["confirmed"] is True and observed["native_status"] == "pending" and observed["child_run_id"] == outcome["run_id"]
    assert UUID(observed["binding_event_id"])
    _assert_content_free(diag_logs)


def test_run_create_failure_is_logged_and_outcome_is_unchanged(source, monkeypatch, diag_logs):
    from deerflow.sophia.memory_governance.builder_provenance import dispatch_independent_builder

    guard, calls = _dispatch_fixture(source, monkeypatch, "run_create_failure")
    outcome = asyncio.run(dispatch_independent_builder(guard=guard, owner_id=OWNER, parent_thread_id=source.thread_id, source_messages=source.messages, tool_call_id="call-1"))
    assert outcome == {"thread_id": outcome["thread_id"], "run_id": None, "status": "unconfirmed", "confirmed": False}
    assert calls == ["check", "check", "check", "thread", "check", "run"]
    level, failed = _one(diag_logs, "builder.child.run_create")
    assert level == logging.WARNING
    assert failed["outcome"] == "failed_observing" and failed["error_type"] == "RuntimeError"
    level, observed = _one(diag_logs, "builder.child.observed")
    assert level == logging.WARNING and observed["confirmed"] is False
    _assert_content_free(diag_logs)


def test_builder_launch_logs_begin_end_and_keeps_silent_dispatch_result(source, monkeypatch, diag_logs):
    import importlib

    launch = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    guard = SimpleNamespace(owner=OWNER, context_id=source.thread_id, check=lambda: None)

    async def failing_dispatch(**kwargs):
        raise RuntimeError(SECRET_DETAIL)

    monkeypatch.setattr("deerflow.sophia.memory_governance.builder_provenance.dispatch_independent_builder", failing_dispatch)
    runtime = SimpleNamespace(state={"messages": source.messages}, tool_call_id="call-2", context={"thread_id": source.thread_id}, config={"configurable": {"thread_id": source.thread_id}})
    result = asyncio.run(launch._start_independent_builder_task(guard=guard, runtime=runtime, state=runtime.state, tool_name="start_builder_task", edit_context=None, configured_user_id=OWNER))
    assert result == "Builder launch could not be confirmed. Do not assume no background work exists or automatically launch a replacement."
    phases = [(event["phase"], event.get("outcome")) for _, event in _events(diag_logs, "builder.launch")]
    assert phases == [("begin", None), ("end", "dispatch_error")]
    _, end = _events(diag_logs, "builder.launch")[-1]
    assert end["error_type"] == "RuntimeError" and isinstance(end["guard_check_ms"], int) and end["tool_call_id"] == "call-2"
    _assert_content_free(diag_logs)


def test_legacy_dispatch_log_carries_keyed_owner_reference(monkeypatch, caplog, declare_memory_owners):  # noqa: F811 - pytest fixture request
    import importlib
    from unittest.mock import AsyncMock, MagicMock

    declare_memory_owners({OWNER: "legacy"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    module = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    client = MagicMock()
    client.threads.create = AsyncMock(return_value={"thread_id": "asgi-1"})
    client.runs.create = AsyncMock(return_value={"run_id": "run-1"})
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: client)
    runtime = SimpleNamespace(state={}, context={"thread_id": "thread-1"}, config={"configurable": {"thread_id": "thread-1", "user_id": OWNER}, "metadata": {}}, tool_call_id="tc-test")
    with caplog.at_level(logging.INFO, logger="deerflow.sophia.tools.start_builder_task"):
        asyncio.run(module.start_builder_task.coroutine(description="Make a doc", task_type="document", runtime=runtime))
    lines = [record.getMessage() for record in caplog.records if "start_builder_task dispatching" in record.getMessage()]
    assert len(lines) == 1
    assert "user_ref=hmac-sha256:owner:" in lines[0] and OWNER not in lines[0]


# ---------------------------------------------------------------------------
# Auth hook admission
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("authority", ["governed", "legacy"])
def test_run_admission_event_once_per_admitted_run(monkeypatch, diag_logs, declare_memory_owners, authority):  # noqa: F811 - pytest fixture request
    from deerflow.sophia import langgraph_auth as policy
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY
    from deerflow.sophia.memory_governance.source_input_provenance import SOURCE_ACTION_KEY, SOURCE_SESSION_KEY

    declare_memory_owners({OWNER: authority})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-auth-source-" * 3)
    store = RecordedInputFixture()
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: store)
    thread, run = str(uuid4()), str(uuid4())
    session, action = store.record(OWNER, thread, CONTENT)
    cfg = {"user_id": OWNER, "langgraph_auth_user_id": OWNER, SOURCE_ACTION_KEY: action, SOURCE_SESSION_KEY: session}
    value = {"thread_id": thread, "run_id": run, "assistant_id": policy.COMPANION_ASSISTANT_ID, "kwargs": {"config": {"configurable": cfg}, "context": {}, "input": {"messages": [{"role": "user", "content": CONTENT}]}}}
    ctx = SimpleNamespace(user=SimpleNamespace(identity=OWNER), permissions=[policy.USER_PERMISSION])
    asyncio.run(policy.create_run(ctx, value))
    assert (cfg[INPUT_PROOF_KEY] is not None) is (authority == "governed")
    _, event = _one(diag_logs, "run.admission")
    assert event["thread_id"] == thread and event["run_id"] == run and event["authority"] == authority
    assert isinstance(event["owner_authority_ms"], int) and isinstance(event["total_ms"], int)
    if authority == "governed":
        assert event["branch"] == "companion" and event["source_message_id"] == action["message_id"] and isinstance(event["issue_ms"], int)
    else:
        assert event["branch"] == "ungoverned" and "issue_ms" not in event
    _assert_content_free(diag_logs, session)


def test_denied_run_emits_no_admission_event(monkeypatch, diag_logs, declare_memory_owners):  # noqa: F811 - pytest fixture request
    from langgraph_sdk import Auth

    from deerflow.sophia import langgraph_auth as policy

    declare_memory_owners({OWNER: "governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-auth-source-" * 3)
    value = {"thread_id": str(uuid4()), "run_id": str(uuid4()), "assistant_id": policy.COMPANION_ASSISTANT_ID, "kwargs": {"config": {"configurable": {"user_id": OWNER, "langgraph_auth_user_id": OWNER}}, "context": {}, "input": {}}}
    ctx = SimpleNamespace(user=SimpleNamespace(identity=OWNER), permissions=[policy.USER_PERMISSION])
    with pytest.raises(Auth.exceptions.HTTPException):
        asyncio.run(policy.create_run(ctx, value))
    assert _events(diag_logs, "run.admission") == []


# ---------------------------------------------------------------------------
# BuilderCommand routing
# ---------------------------------------------------------------------------


def test_builder_command_routed_event_carries_tool_call_and_run_timing(diag_logs):
    from langchain_core.runnables.config import var_child_runnable_config

    from deerflow.agents.sophia_agent.middlewares.builder_command import BuilderCommandMiddleware

    run_id = _uuid7()
    diag.mark_run_start(run_id)
    request = SimpleNamespace(state={}, messages=[HumanMessage(content=f"[Voice build request]\nTask type: research\nBrief: {CONTENT}")])

    def route():
        var_child_runnable_config.set({"configurable": {"run_id": run_id}, "metadata": {}})
        return BuilderCommandMiddleware()._build_direct_tool_call(request)

    call = contextvars.copy_context().run(route)
    _, event = _one(diag_logs, "builder.command.routed")
    assert event["route"] == "voice" and event["task_type"] == "research"
    assert event["tool_call_id"] == call.tool_calls[0]["id"]
    assert 0 <= event["since_run_start_ms"] < 5_000 and 0 <= event["since_run_created_ms"] < 5_000
    _assert_content_free(diag_logs)


# ---------------------------------------------------------------------------
# Graph factory timing
# ---------------------------------------------------------------------------


def test_graph_factory_event_once_per_call_with_segments(diag_logs):
    store = _mock_store()

    @diag.timed_graph_factory("sophia_builder")
    def inner(config):
        diag.factory_segment_add("guard_init", 4)
        with diag.factory_segment("foundation_probe"):
            store.get_contract()
        diag.factory_mark("pre_compile")
        return "graph"

    @diag.timed_graph_factory("sophia_builder")
    def outer(config):
        return inner(config)

    config = {"configurable": {"run_id": str(uuid4()), "thread_id": str(uuid4())}}
    assert outer(config) == "graph"
    _, event = _one(diag_logs, "graph.factory")
    assert event["graph"] == "sophia_builder" and event["outcome"] == "ok" and event["for_execution"] is False
    assert event["guard_init_ms"] == 4 and isinstance(event["foundation_probe_ms"], int) and isinstance(event["compile_ms"], int)
    assert event["store_requests"] == 1 and event["run_id"] == config["configurable"]["run_id"]
    assert diag.current_run_diag() is None


def test_graph_factory_error_is_logged_and_reraised(diag_logs):
    @diag.timed_graph_factory("sophia_companion")
    def broken(config):
        raise ValueError(SECRET_DETAIL)

    with pytest.raises(ValueError, match=SECRET_DETAIL):
        broken({})
    _, event = _one(diag_logs, "graph.factory")
    assert event["outcome"] == "error" and event["error_type"] == "ValueError"
    _assert_content_free(diag_logs)


def test_async_factory_is_timed_at_entry_and_execution_run_keeps_accumulator(diag_logs):
    from contextlib import asynccontextmanager

    @diag.timed_graph_factory("sophia_builder")
    def sync_factory(config):
        return "graph"

    @diag.timed_graph_factory("sophia_builder")
    @asynccontextmanager
    async def factory(config):
        yield sync_factory(config)

    run_id = str(uuid4())
    config = {"configurable": {"run_id": run_id, "__is_for_execution__": True}}

    async def main():
        manager = factory(config)
        assert _events(diag_logs, "graph.factory") == []
        async with manager as graph:
            assert graph == "graph"
            # A run's accumulator stays current for the rest of the run task.
            run = diag.current_run_diag()
            assert run is not None and run.run_scoped
        return run

    contextvars.copy_context().run(asyncio.run, main())
    _, event = _one(diag_logs, "graph.factory")
    assert event["for_execution"] is True and event["run_id"] == run_id
    assert "since_run_start_ms" in diag.run_timing(run_id)
    assert diag.current_run_diag() is None


def test_registered_factories_keep_their_server_signature():
    from langgraph_api._factory_utils import _classify_factory

    from deerflow.agents.sophia_agent import make_sophia_agent
    from deerflow.agents.sophia_agent.builder_agent import make_sophia_builder, make_sophia_builder_with_distributed_tracing

    for factory in (make_sophia_agent, make_sophia_builder, make_sophia_builder_with_distributed_tracing):
        assert hasattr(factory, "__wrapped__")
        hook = _classify_factory(factory)
        assert hook({"configurable": {}}, object()) == {"config": {"configurable": {}}}


# ---------------------------------------------------------------------------
# Builder progress (langgraph POST, gateway receipt, canvas fan-out)
# ---------------------------------------------------------------------------


class _FakeAsyncClient:
    behaviour = "ok"
    status = 202

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, content=None, headers=None):
        if self.behaviour == "raise":
            raise httpx.ConnectError(SECRET_DETAIL)
        return SimpleNamespace(status_code=self.status, text=SECRET_DETAIL)


@pytest.mark.parametrize(
    ("behaviour", "status", "phase", "level", "outcome"),
    [
        ("raise", None, "starting", logging.WARNING, "failed"),
        ("ok", 500, "starting", logging.WARNING, "rejected"),
        ("ok", 202, "starting", logging.INFO, "delivered"),
        ("ok", 202, "done", logging.INFO, "delivered"),
        ("ok", 202, "researching", logging.DEBUG, "delivered"),
    ],
)
def test_progress_post_levels_and_failure_warning(monkeypatch, diag_logs, behaviour, status, phase, level, outcome):
    from deerflow.agents.sophia_agent.middlewares import builder_progress

    client = type("Client", (_FakeAsyncClient,), {"behaviour": behaviour, "status": status})
    monkeypatch.setattr(builder_progress.httpx, "AsyncClient", client)
    monkeypatch.setattr(builder_progress, "signed_builder_event_headers", lambda body: {})
    task, run, parent = str(uuid4()), str(uuid4()), str(uuid4())
    asyncio.run(builder_progress._post_progress_event(task_id=task, run_id=run, event_name="custom", data={"name": "phase", "phase": phase}, parent_thread_id=parent, sequence=3))
    got_level, event = _one(diag_logs, "builder.progress.post")
    assert got_level == level and event["outcome"] == outcome and event["phase"] == phase
    assert event["task_id"] == task and event["run_id"] == run and event["parent_thread_id"] == parent and event["seq"] == 3
    assert isinstance(event["post_ms"], int)
    if behaviour == "raise":
        assert event["error_type"] == "ConnectError" and "http_status" not in event
    else:
        assert event["http_status"] == status
    _assert_content_free(diag_logs)


def test_gateway_progress_received_event(monkeypatch, diag_logs):
    from datetime import UTC, datetime, timedelta

    from app.gateway.routers.builder_events import BuilderProgressEvent, receive_builder_progress

    class Registry:
        async def apply_event(self, **kwargs):
            return True

    monkeypatch.setattr("app.gateway.builder_progress.get_progress_registry", lambda: Registry())
    task, run, parent = str(uuid4()), str(uuid4()), str(uuid4())
    occurred = (datetime.now(UTC) - timedelta(milliseconds=250)).isoformat()
    event = BuilderProgressEvent(
        task_id=task, run_id=run, parent_thread_id=parent, sequence=1, occurred_at=occurred, event_name="updates", data={"agent": {"messages": [{"tool_calls": [{"name": "web_search", "args": {"query": CONTENT}}]}]}}
    )
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    response = asyncio.run(receive_builder_progress(event, request))
    assert response == {"applied": True, "web_delivered": 0}
    _, logged = _one(diag_logs, "builder.progress.received")
    assert logged["task_id"] == task and logged["run_id"] == run and logged["parent_thread_id"] == parent
    assert logged["event"] == "updates" and logged["applied"] is True and logged["web_delivered"] == 0 and logged["synthetic"] is False
    assert 200 <= logged["lag_ms"] < 5_000
    _assert_content_free(diag_logs)


def test_canvas_delivered_subscriber_count(diag_logs):
    from app.gateway.workers.builder_canvas import BuilderCanvasWorker

    worker = BuilderCanvasWorker()
    parent, task, run = str(uuid4()), str(uuid4()), str(uuid4())

    async def main():
        async with worker.subscribe(parent), worker.subscribe(parent):
            return await worker.publish_progress({"parent_thread_id": parent, "task_id": task, "run_id": run, "sequence": 1, "event_name": "custom", "data": {"name": "phase", "phase": "starting"}})

    assert asyncio.run(main()) == 2
    _, event = _one(diag_logs, "builder.canvas.delivered")
    assert event["parent_thread_id"] == parent and event["task_id"] == task and event["run_id"] == run
    assert event["subscribers"] == 2 and event["delivered"] == 2 and event["dropped"] == 0 and event["seq"] == 1


# ---------------------------------------------------------------------------
# Gateway source intake
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fault", [None, "conflict", "outage"])
def test_source_action_event(monkeypatch, diag_logs, fault):
    from fastapi import HTTPException

    from app.gateway.routers import memory_source
    from deerflow.sophia.memory_governance.source_intake import SourceActionRequest
    from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict

    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    session, thread, message = str(uuid4()), str(uuid4()), str(uuid4())

    class Service:
        def __init__(self, *, owner_id, store):
            assert owner_id == OWNER

        def accept(self, *, session_id, action):
            if fault == "conflict":
                raise MemoryGovernanceConflict("governance_revision_conflict")
            if fault == "outage":
                raise RuntimeError(SECRET_DETAIL)
            return SimpleNamespace(sequence=7, idempotent_replay=False, model_dump=lambda **kwargs: {"status": "source_recorded"})

    monkeypatch.setattr(memory_source, "SourceIntakeService", Service)
    monkeypatch.setattr(memory_source, "configured_memory_store", lambda: object())
    action = SourceActionRequest(thread_id=thread, message_id=message, command_key=str(uuid4()), expected_clear_epoch=0, content=CONTENT)
    if fault is None:
        response = memory_source.accept_source_action(session, action=action, owner=OWNER)
        assert response.status_code == 200
    else:
        with pytest.raises(HTTPException) as raised:
            memory_source.accept_source_action(session, action=action, owner=OWNER)
        assert raised.value.status_code == (409 if fault == "conflict" else 503)
    _, event = _one(diag_logs, "source_action")
    assert event["message_id"] == message and event["thread_id"] == thread
    assert event["session_ref"].startswith("hmac-sha256:session:") and isinstance(event["duration_ms"], int)
    assert event["outcome"] == {None: "recorded", "conflict": "conflict", "outage": "unavailable"}[fault]
    assert ("seq" in event) is (fault is None)
    _assert_content_free(diag_logs, session)
