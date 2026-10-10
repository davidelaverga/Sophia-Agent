"""Content-free launch-timeline diagnostics (``sophia_diag`` lines).

Each instrumented hop emits exactly one event, carries only join identifiers,
codes and numbers, and never changes the outcome it observes. Inputs use
sentinel strings so any leak of owner identity or content is detectable.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from langchain_core.messages import HumanMessage
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from mem00_recorded_input_fixture import RecordedInputFixture
from sophia_diag_fixture import CONTENT, OWNER, SECRET_DETAIL, _assert_content_free, _events, _mock_store, _one, _uuid7
from sophia_diag_fixture import diag_logs as _diag_logs

from deerflow.sophia import diag

diag_logs = _diag_logs


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
