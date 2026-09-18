from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from mem00_recorded_input_fixture import RecordedInputFixture
from mem00_owner_fixture import declare_memory_owners
from deerflow.sophia.memory_governance.builder_source_binding import independent_builder_source_text
from deerflow.sophia.memory_governance.input_provenance import issue_recorded_authenticated_input
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable


@pytest.fixture
def source(monkeypatch, request):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-source-" * 4)
    store = RecordedInputFixture()
    thread, run = str(uuid4()), str(uuid4())
    session, action = store.record("owner", thread, getattr(request, "param", "Build a simple synthetic table"))
    wire, proof = issue_recorded_authenticated_input(owner_id="owner", session_id=session, thread_id=thread, run_id=run,
        wire_input={"messages": [{"role": "user", "content": action["content"]}]}, source_action=action, store=store)
    return dict(owner_id="owner", thread_id=thread, run_id=run, input_proof=proof,
        messages=[HumanMessage(**wire["messages"][0])], store=store)


def test_builder_fallback_requires_and_keeps_actual_run_guard(monkeypatch, declare_memory_owners):
    import asyncio
    from deerflow.agents.sophia_agent.builder_middlewares import build_builder_middleware_chain
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware, active_model_guard
    from deerflow.sophia.builder_provider_fallback import build_fallback_chat_model, FALLBACK_MODEL_ENV
    from deerflow.sophia.memory_governance.model_clients import GovernedChatOpenAI, ModelDispatchDenied
    from test_mem00_model_clients import close_model

    declare_memory_owners({"owner": "legacy"})
    monkeypatch.setenv(FALLBACK_MODEL_ENV, "gpt-4o-mini")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-not-a-provider-key")
    with pytest.raises(ModelDispatchDenied):
        build_fallback_chat_model()
    chain = build_builder_middleware_chain("owner")
    assert isinstance(chain[0], MemoryContextEntryMiddleware)
    model = chain[0].wrap_model_call(None, lambda _: build_fallback_chat_model())
    try:
        assert isinstance(model, GovernedChatOpenAI)
        assert model.memory_authority_factory.__self__ is chain[0].guard
        assert model.streaming is True
        assert active_model_guard() is None
    finally:
        asyncio.run(close_model(model))


def test_only_recorded_user_request_survives_enriched_parent_context(source):
    source["messages"] = [AIMessage(content="SYNTHETIC PERSONAL MEMORY"), *source["messages"],
        AIMessage(content="SYNTHETIC ENRICHED TASK")]
    assert independent_builder_source_text(**source) == "Build a simple synthetic table"


@pytest.mark.parametrize("fault", ["owner", "run", "thread", "missing", "duplicate", "changed", "outage", "clear"])
def test_unprovable_source_cannot_become_independent_builder_text(source, fault):
    if fault in {"owner", "run", "thread"}:
        source[fault + "_id"] = str(uuid4())
    elif fault == "missing":
        source["messages"] = []
    elif fault == "duplicate":
        source["messages"] *= 2
    elif fault == "changed":
        source["messages"][0] = source["messages"][0].model_copy(update={"content": "SYNTHETIC ENRICHMENT"})
    elif fault == "outage":
        source["store"].unavailable = True
    else:
        source["store"].clear_epoch += 1
    with pytest.raises(MemoryGovernanceUnavailable, match="independent_builder_source_unavailable"):
        independent_builder_source_text(**source)


@pytest.mark.parametrize("fault", [None, "nonempty", "inactive", "outage"])
def test_independent_child_registration_does_not_inherit_parent_admission(source, monkeypatch, fault):
    from types import SimpleNamespace
    from deerflow.sophia.memory_governance.builder_source_binding import BuilderSourceBindingService
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition
    parent_admission = object()
    seen = []
    def readmit(context):
        seen.append(context)
        assert context.inclusions == ()
        if fault == "outage":
            raise RuntimeError("synthetic")
        return RetainedAdmission(ContextTransition("continue", "empty", 0), context,
            (object(),) if fault == "nonempty" else (), uuid4())
    guard = SimpleNamespace(context_id=source["thread_id"], owner="owner", scope="life", admission=parent_admission,
        check=lambda: None, _readmit=readmit, config={INPUT_PROOF_KEY: source["input_proof"], INPUT_RUN_KEY: source["run_id"]})
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.memory_context.active_builder_parent_guard",
        lambda owner, thread: None if fault == "inactive" else guard)
    source["store"].get_user_governance = lambda owner: SimpleNamespace(user_id=owner, user_revocation_epoch=0, user_catalog_generation=3)
    service = BuilderSourceBindingService(owner_id="owner", store=source["store"])
    def register():
        return service.register_independent_text(guard=guard, child_thread_id=str(uuid4()), messages=[
            *source["messages"], AIMessage(content="SYNTHETIC MEMORY-ENRICHED TASK")])
    if fault:
        with pytest.raises(MemoryGovernanceUnavailable, match="independent_builder_handoff_unavailable"):
            register()
        assert source["store"].builder_handoffs == {}
    else:
        wire, receipt, admission = register()
        assert set(wire) == {"messages"}
        assert wire["messages"][0]["content"] == "Build a simple synthetic table"
        assert receipt.initial_memory_manifest == receipt.request.initial_memory_manifest == []
        assert len(receipt.request.source_dependencies) == 1
        assert str(admission.prompt_admission_id) == receipt.request.prior_admission_id
        assert len(source["store"].builder_handoffs) == 1
    assert guard.admission is parent_admission


@pytest.mark.parametrize("source,expected_type,expected_ext", [
    ("Build a simple synthetic table", "document", ".md"),
    ("Create a PowerPoint presentation about synthetic planets", "presentation", ".pptx"),
    ("Build an HTML website for a synthetic garden", "frontend", ".html"),
], indirect=["source"])
def test_source_only_transport_binds_actual_child_run_and_rejects_old_contract(source, monkeypatch, tmp_path, expected_type, expected_ext):
    from copy import deepcopy
    from types import SimpleNamespace
    from deerflow.sophia.memory_governance.builder_provenance import issue_builder_handoff, bind_builder_run, verify_builder_run, _json
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition
    from deerflow.sophia.memory_governance.refs import keyed_ref
    parent = object()
    guard = SimpleNamespace(enabled=True, context_id=source["thread_id"], owner="owner", scope="life", admission=parent,
        check=lambda: None, _readmit=lambda context: RetainedAdmission(ContextTransition("continue", "empty", 0), context, (), uuid4()),
        config={INPUT_PROOF_KEY: source["input_proof"], INPUT_RUN_KEY: source["run_id"]})
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.memory_context.active_builder_parent_guard", lambda *_: guard)
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: source["store"])
    source["store"].get_user_governance = lambda owner: SimpleNamespace(user_id=owner, user_revocation_epoch=0, user_catalog_generation=3)
    child, run = str(uuid4()), str(uuid4())
    wire, proof = issue_builder_handoff(guard=guard, owner_id="owner", parent_thread_id=source["thread_id"],
        child_thread_id=child, source_messages=source["messages"])
    retry_wire, retry_proof = issue_builder_handoff(guard=guard, owner_id="owner", parent_thread_id=source["thread_id"],
        child_thread_id=child, source_messages=source["messages"])
    assert retry_wire == wire and retry_proof == proof
    assert len(source["store"].builder_handoffs) == 1
    old = deepcopy(proof)
    old["schema"] = "mem00.builder-handoff.v3"
    old["seal"] = keyed_ref("builder-handoff-seal", _json({k: v for k, v in old.items() if k != "seal"}))
    with pytest.raises(ValueError):
        bind_builder_run(owner_id="owner", child_thread_id=child, run_id=run, wire_input=wire, proof=old)
    bound, run_proof = bind_builder_run(owner_id="owner", child_thread_id=child, run_id=run, wire_input=wire, proof=proof)
    manifest = verify_builder_run(owner_id="owner", child_thread_id=child, run_id=run, state=bound, proof=run_proof)
    assert manifest is not None and manifest.inclusions == ()
    import asyncio
    from deerflow.sophia import langgraph_auth as policy
    from deerflow.sophia.memory_governance.builder_provenance import HANDOFF_KEY, HANDOFF_RUN_KEY
    monkeypatch.setattr("deerflow.sophia.memory_governance.owner_authority.resolve_owner_authority",
        lambda owner: SimpleNamespace(user_id=owner, authority_state="governed"))
    cfg = {"user_id": "owner", "langgraph_auth_user_id": "owner", HANDOFF_KEY: proof,
        HANDOFF_RUN_KEY: {"stale": True}, INPUT_PROOF_KEY: {"stale": True},
        "task_type": "presentation", "artifact_target_ext": ".pptx", "parent_thread_id": "wrong"}
    value = {"thread_id": child, "run_id": run, "assistant_id": policy.BUILDER_ASSISTANT_ID,
        "kwargs": {"config": {"configurable": cfg}, "context": {}, "input": wire}}
    ctx = SimpleNamespace(user=SimpleNamespace(identity="owner"), permissions=[policy.USER_PERMISSION])
    asyncio.run(policy.create_run(ctx, value))
    assert cfg[HANDOFF_KEY] is None and cfg[INPUT_PROOF_KEY] is None
    assert cfg[INPUT_RUN_KEY] == run
    assert cfg["task_type"] == expected_type and cfg["artifact_target_ext"] == expected_ext
    assert cfg["parent_thread_id"] == source["thread_id"]
    assert verify_builder_run(owner_id="owner", child_thread_id=child, run_id=run,
        state=value["kwargs"]["input"], proof=cfg[HANDOFF_RUN_KEY]).inclusions == ()
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard, MemoryContextUnavailable
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner",
        lambda owner: SimpleNamespace(governed_runtime_read=True, canonical_pool_read=True))
    monkeypatch.setattr(MemoryRunGuard, "_readmit", lambda self, context: RetainedAdmission(
        ContextTransition("continue", "empty", 0), context, (), uuid4()))
    surfaces = []
    monkeypatch.setattr(MemoryRunGuard, "_empty_native_surface", lambda self: surfaces.append(self.context_id))
    cfg["thread_id"] = child
    child_guard = MemoryRunGuard(owner_id="owner", config=cfg, scope="builder")
    seeded = child_guard.enter(value["kwargs"]["input"])
    assert seeded["memory_context_proof"] is None
    delegation = seeded["delegation_context"]
    assert delegation["task"] == source["messages"][0].content
    assert delegation["parent_thread_id"] == source["thread_id"] and delegation["parent_user_id"] == "owner"
    assert delegation["relevant_memories"] == [] and delegation["companion_artifact"] == {}
    assert delegation["uploaded_image_paths"] == [] and delegation["active_ritual"] is None
    assert seeded["builder_budget"]["max_cost_usd"] > 0
    assert seeded["builder_budget"]["max_non_artifact_turns"] > 0
    if expected_type == "presentation":
        assert seeded["builder_deadline_epoch_ms"] > seeded["builder_task_kickoff_ms"]
    else:
        assert seeded["builder_deadline_epoch_ms"] == 0  # Existing simple tier has cost/turn caps.
    from deerflow.sophia.memory_governance.builder_source_binding import independent_builder_runtime_seed
    assert independent_builder_runtime_seed(binding=child_guard.builder_binding, wire_input=bound) == {
        key: value for key, value in seeded.items() if key != "memory_context_proof"}
    with pytest.raises(MemoryGovernanceUnavailable):
        independent_builder_runtime_seed(binding=child_guard.builder_binding,
            wire_input={**bound, "delegation_context": {"task": "SYNTHETIC MEMORY ENRICHMENT"}})
    from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
    def forbidden_parent_read(*args, **kwargs):
        pytest.fail("source-only briefing read the parent ledger or invoked extraction")
    monkeypatch.setattr("deerflow.sophia.delegation_ledger.read_ledger_with_fallback", forbidden_parent_read)
    monkeypatch.setattr("deerflow.sophia.brief_extraction.extract_brief", forbidden_parent_read)
    briefing = BuilderTaskMiddleware(user_id="owner").before_agent(
        {**bound, **seeded}, SimpleNamespace(config={"configurable": cfg}, context={"thread_id": child}))
    rendered = "\n".join(briefing["system_prompt_blocks"])
    assert source["messages"][0].content in str(bound["messages"]) + rendered
    assert "<memories>" not in rendered and "<session_recall>" not in rendered
    assert "<tone_guidance>" not in rendered
    if expected_type == "document":
        from langchain.agents import create_agent
        from langchain.agents.middleware import AgentMiddleware
        from langchain_core.language_models.fake_chat_models import FakeListChatModel
        from langgraph.errors import GraphBubbleUp
        from deerflow.config.paths import Paths
        from deerflow.agents.sophia_agent import builder_agent
        from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextModelProducer
        monkeypatch.setattr("deerflow.sophia.memory_governance.mem0_projection_adapter.Mem0ProjectionAdapter", lambda: object())
        monkeypatch.setattr("deerflow.sophia.memory_governance.service.MemoryProviderContract.from_environ", lambda: object())
        monkeypatch.setattr("deerflow.sophia.memory_governance.retained_admission.readmit_retained_context",
            lambda **kwargs: RetainedAdmission(ContextTransition("continue", "empty", 0), kwargs["context"], (), uuid4()))
        class ModelBoundaryReached(GraphBubbleUp):
            pass
        seen = []
        model_turns = []
        def next_response(messages):
            from langchain_core.outputs import ChatGeneration, ChatResult
            model_turns.append(list(messages))
            seen.extend(messages)
            if len(model_turns) == 1:
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{
                    "name": "write_todos", "id": "synthetic-builder-todo",
                    "args": {"todos": [{"content": "Build the independent synthetic table", "status": "in_progress"}]},
                    "type": "tool_call"}]))])
            raise ModelBoundaryReached()
        class RecordingBoundaryModel(FakeListChatModel):
            def bind_tools(self, *args, **kwargs):
                return self
            def _generate(self, messages, **kwargs):
                return next_response(messages)
            async def _agenerate(self, messages, **kwargs):
                return self._generate(messages, **kwargs)
            async def _astream(self, messages, **kwargs):
                from langchain_core.messages import AIMessageChunk
                from langchain_core.outputs import ChatGenerationChunk
                result = next_response(messages).generations[0].message
                yield ChatGenerationChunk(message=AIMessageChunk(content=result.content, tool_calls=result.tool_calls))
        monkeypatch.setattr(builder_agent, "ChatAnthropic", lambda **kwargs: RecordingBoundaryModel(responses=["unused"]))
        def compile_chain(**kwargs):
            chain = kwargs["middleware"]
            index = next(i for i, item in enumerate(chain) if isinstance(item, MemoryContextModelProducer))
            for item in chain[index + 1:]:
                assert type(item).before_model is AgentMiddleware.before_model
                assert type(item).abefore_model is AgentMiddleware.abefore_model
            return create_agent(**kwargs)
        monkeypatch.setattr(builder_agent, "create_agent", compile_chain)
        paths = Paths(str(tmp_path))
        monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: paths)
        monkeypatch.setattr("deerflow.agents.middlewares.thread_data_middleware.get_paths", lambda: paths)
        graph = builder_agent._create_builder_agent(user_id="owner", trace_config={"configurable": cfg}, task_type="document")
        try:
            terminal = asyncio.run(graph.ainvoke(bound, {"configurable": cfg}, context={"thread_id": child, "user_id": "owner"}))
        except ModelBoundaryReached:
            terminal = None
        assert terminal is None, {key: terminal.get(key) for key in ("builder_terminal_halt_reason", "builder_result", "builder_budget", "builder_deadline_epoch_ms")}
        assert source["messages"][0].content in str(seen)
        assert "<tone_guidance>" not in str(seen) and "<memories>" not in str(seen)
        assert len(model_turns) == 2
        from langchain_core.messages import ToolMessage
        assert any(isinstance(message, ToolMessage) and message.tool_call_id == "synthetic-builder-todo"
            and message.status != "error" for message in model_turns[1])
    assert child_guard.entered and child_guard.admission.context.inclusions == ()
    assert child_guard.source_witness is None and child_guard.builder_binding.child_run_id == run
    assert surfaces == [child] * (2 if expected_type == "document" else 1)
    source["store"].unavailable = True
    with pytest.raises(MemoryContextUnavailable):
        child_guard.check()
    assert not child_guard.entered
    source["store"].unavailable = False
    for changed in [{"owner_id": "wrong"}, {"run_id": str(uuid4())}, {"child_thread_id": str(uuid4())},
        {"state": {**bound, "delegation_context": {"relevant_memories": ["SYNTHETIC"]}}}]:
        args = dict(owner_id="owner", child_thread_id=child, run_id=run, state=bound, proof=run_proof)
        args.update(changed)
        assert verify_builder_run(**args) is None
    assert guard.admission is parent
    source["store"].get_user_governance = lambda owner: SimpleNamespace(user_id=owner, user_revocation_epoch=0, user_catalog_generation=4)
    with pytest.raises(MemoryGovernanceUnavailable):
        issue_builder_handoff(guard=guard, owner_id="owner", parent_thread_id=source["thread_id"],
            child_thread_id=child, source_messages=source["messages"])
    assert len(source["store"].builder_handoffs) == 1
    assert source["store"].get_builder_handoff(p_user_id="owner", p_child_thread_id=child) == proof["binding_receipt"]


@pytest.mark.parametrize("nonempty", [False, True])
def test_builder_readmission_never_accepts_personal_memory(source, monkeypatch, nonempty):
    from types import SimpleNamespace
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard, MemoryContextUnavailable
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition, RetainedMemoryContext, MemoryInclusion
    from deerflow.sophia.memory_governance.refs import keyed_ref
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner",
        lambda owner: SimpleNamespace(governed_runtime_read=True, canonical_pool_read=True))
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: source["store"])
    monkeypatch.setattr("deerflow.sophia.memory_governance.mem0_projection_adapter.Mem0ProjectionAdapter", lambda: object())
    monkeypatch.setattr("deerflow.sophia.memory_governance.service.MemoryProviderContract.from_environ", lambda: object())
    context = RetainedMemoryContext(keyed_ref("owner", "owner"), 0, (MemoryInclusion(uuid4(), 1, 1),) if nonempty else ())
    result = RetainedAdmission(ContextTransition("continue", "synthetic", 0), context, (), uuid4())
    monkeypatch.setattr("deerflow.sophia.memory_governance.retained_admission.readmit_retained_context", lambda **kwargs: result)
    guard = MemoryRunGuard(owner_id="owner", config={"thread_id": source["thread_id"]}, scope="builder")
    if nonempty:
        with pytest.raises(MemoryContextUnavailable):
            guard._readmit(context)
    else:
        assert guard._readmit(context) is result


@pytest.mark.parametrize("fault", [None, "lost_reply", "no_run", "wrong_native", "native_outage"])
def test_source_only_dispatch_recovers_exact_run_without_duplicate_create(source, monkeypatch, fault):
    import asyncio
    from types import SimpleNamespace
    from deerflow.sophia.memory_governance.builder_provenance import dispatch_independent_builder, bind_builder_run, HANDOFF_KEY
    from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY
    from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
    from deerflow.sophia.memory_governance.retained_context import ContextTransition

    guard = SimpleNamespace(enabled=True, owner="owner", context_id=source["thread_id"], scope="life",
        check=lambda: None, config={INPUT_PROOF_KEY: source["input_proof"], INPUT_RUN_KEY: source["run_id"]},
        _readmit=lambda context: RetainedAdmission(ContextTransition("continue", "empty", 0), context, (), uuid4()))
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.memory_context.active_builder_parent_guard", lambda *_: guard)
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: source["store"])
    source["store"].get_user_governance = lambda owner: SimpleNamespace(user_id=owner, user_revocation_epoch=0, user_catalog_generation=3)
    threads, runs, requests = set(), {}, []

    async def create_thread(**kwargs):
        assert kwargs["if_exists"] == "raise"
        child = kwargs["thread_id"]
        if child in threads:
            raise RuntimeError("exists")
        threads.add(child)
        return {"thread_id": child}

    async def create_run(**kwargs):
        requests.append(kwargs)
        assert set(kwargs["input"]) == {"messages"}
        assert kwargs["input"]["messages"][0]["content"] == source["messages"][0].content
        assert kwargs["stream_resumable"] is True
        if fault == "no_run":
            raise RuntimeError("unknown effect")
        child, run = kwargs["thread_id"], str(uuid4())
        bind_builder_run(owner_id="owner", child_thread_id=child, run_id=run, wire_input=kwargs["input"],
            proof=kwargs["config"]["configurable"][HANDOFF_KEY])
        runs[(child, run)] = {"thread_id": child, "run_id": run, "status": "running"}
        if fault == "lost_reply":
            raise RuntimeError("response lost")
        return runs[(child, run)]

    async def get_run(child, run):
        if fault == "native_outage":
            raise RuntimeError("unavailable")
        return {**runs[(child, run)], **({"thread_id": "wrong"} if fault == "wrong_native" else {})}

    client = SimpleNamespace(threads=SimpleNamespace(create=create_thread), runs=SimpleNamespace(create=create_run, get=get_run))
    monkeypatch.setattr("deerflow.sophia.langgraph_client_auth.get_client", lambda **kwargs: client)
    args = dict(guard=guard, owner_id="owner", parent_thread_id=source["thread_id"], source_messages=source["messages"], tool_call_id="synthetic-call")
    first = asyncio.run(dispatch_independent_builder(**args))
    retry = asyncio.run(dispatch_independent_builder(**args))
    assert first == retry and len(threads) == len(requests) == 1
    assert first["confirmed"] is (fault in (None, "lost_reply"))
    if not first["confirmed"]:
        assert first["status"] == "unconfirmed" and first["run_id"] is None
    import importlib
    from langgraph.types import Command
    launch = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.memory_context.active_governed_tool_guard", lambda: guard)
    def forbidden_inheritance(*args, **kwargs):
        pytest.fail("governed launch reached legacy enrichment or file inheritance")
    for name in ("_resolve_companion_artifact", "_resolve_dispatch_digest", "_build_enriched_description", "_copy_parent_uploaded_images"):
        monkeypatch.setattr(launch, name, forbidden_inheritance)
    state = {"messages": [*source["messages"], AIMessage(content="SYNTHETIC MEMORY ENRICHED BRIEF")],
        "injected_memory_contents": ["SYNTHETIC MEMORY"], "active_ritual": "vent"}
    runtime = SimpleNamespace(state=state, tool_call_id="synthetic-call", context={"thread_id": source["thread_id"]},
        config={"configurable": {"thread_id": source["thread_id"], "user_id": "owner"}})
    result = asyncio.run(launch._start_builder_task_impl("SYNTHETIC MODEL DESCRIPTION", "presentation", runtime,
        configured_user_id="owner"))
    assert isinstance(result, Command)
    tracked = result.update["async_tasks"][first["thread_id"]]
    assert tracked["run_id"] == first["run_id"] and tracked["status"] == first["status"]
    assert "SYNTHETIC MEMORY" not in str(result.update)
    state.update(result.update)
    held = asyncio.run(launch._start_builder_task_impl("replacement", "document", runtime, configured_user_id="owner"))
    assert "already tracked" in held and len(requests) == 1


@pytest.mark.parametrize("authority", ["governed", "unknown"])
def test_missing_guard_cannot_route_governed_or_unknown_owner_to_legacy(monkeypatch, declare_memory_owners, authority):
    import asyncio
    import importlib
    from types import SimpleNamespace
    launch = importlib.import_module("deerflow.sophia.tools.start_builder_task")
    declare_memory_owners({"owner": "governed"} if authority == "governed" else {})
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.memory_context.active_governed_tool_guard", lambda: None)
    def forbidden(*args, **kwargs):
        pytest.fail("missing guard reached legacy context or dispatch")
    for name in ("_resolve_companion_artifact", "_resolve_dispatch_digest", "_dispatch_via_asgi"):
        monkeypatch.setattr(launch, name, forbidden)
    runtime = SimpleNamespace(state={"messages": [HumanMessage(content="synthetic request")]},
        config={"configurable": {"user_id": "owner", "thread_id": str(uuid4())}}, context={}, tool_call_id="synthetic")
    result = asyncio.run(launch._start_builder_task_impl("synthetic", "document", runtime, configured_user_id="owner"))
    assert "No launch was attempted" in result
