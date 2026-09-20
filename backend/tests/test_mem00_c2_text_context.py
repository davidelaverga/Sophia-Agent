"""Real local agent/checkpointer flow with fake model and canonical authorities."""

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name

from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware, MemoryContextModelProducer, MemoryContextUnavailable, MemoryRunGuard
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.sophia.memory_governance.context_provenance import CHECKPOINT_PROOF_KEY
from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY, issue_recorded_authenticated_input
from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission


@pytest.fixture
def env(monkeypatch, tmp_path, declare_memory_owners):  # noqa: F811 - pytest fixture request
    declare_memory_owners({"owner": "governed"})
    for name in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ", "PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ"):
        monkeypatch.setenv("SOPHIA_MEMORY_" + name, "true")
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "owner")
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-runtime-key-" * 3)
    clock = SimpleNamespace(user_id="owner", user_revocation_epoch=3, user_catalog_generation=0)
    from mem00_recorded_input_fixture import RecordedInputFixture
    store = RecordedInputFixture()
    store.get_user_governance = lambda owner: clock
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: store)
    monkeypatch.setattr("deerflow.sophia.memory_governance.mem0_projection_adapter.Mem0ProjectionAdapter", lambda: object())
    monkeypatch.setattr("deerflow.sophia.memory_governance.service.MemoryProviderContract.from_environ", lambda: object())
    monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: SimpleNamespace(
        sandbox_work_dir=lambda tid: tmp_path / tid / "work", sandbox_uploads_dir=lambda tid: tmp_path / tid / "uploads", sandbox_outputs_dir=lambda tid: tmp_path / tid / "outputs"))
    calls = []
    canonical = {}
    events = []
    def readmit(**kwargs):
        from deerflow.sophia.memory_governance.retained_context import context_transition
        context = kwargs["context"]
        calls.append(context)
        decision = context_transition(context=context, owner_ref=context.owner_ref, current_epoch=clock.user_revocation_epoch,
            deltas=tuple(event for event in events if context.revocation_epoch < event.epoch <= clock.user_revocation_epoch), delta_complete=True)
        if decision.action != "continue":
            return RetainedAdmission(decision)
        memories = tuple(canonical[item.memory_id] for item in context.inclusions)
        return RetainedAdmission(decision, replace(context, revocation_epoch=clock.user_revocation_epoch), memories, UUID(int=9))
    monkeypatch.setattr("deerflow.sophia.memory_governance.retained_admission.readmit_retained_context", readmit)
    return SimpleNamespace(clock=clock, calls=calls, canonical=canonical, events=events, tid=str(uuid4()), checkpointer=InMemorySaver(), source_store=store)


def current(env, content="CURRENT_SYNTHETIC_INPUT"):
    rid = str(uuid4())
    session, action = env.source_store.record("owner", env.tid, content)
    wire, proof = issue_recorded_authenticated_input(owner_id="owner", session_id=session, thread_id=env.tid, run_id=rid,
        wire_input={"messages": [{"role": "user", "content": content}]}, source_action=action, store=env.source_store)
    cfg = {"user_id": "owner", "langgraph_auth_user_id": "owner", "thread_id": env.tid, INPUT_PROOF_KEY: proof, INPUT_RUN_KEY: rid}
    return cfg, [HumanMessage(**item) for item in wire["messages"]]


def graph(env, cfg, extra=(), model=None, summarize=False):
    from deerflow.agents.sophia_agent.state import SophiaState
    guard = MemoryRunGuard(owner_id="owner", config=cfg)
    if summarize:
        from deerflow.agents.sophia_agent.middlewares.sophia_summarization import SophiaSummarizationMiddleware
        summary = SophiaSummarizationMiddleware(model=FakeListChatModel(responses=["unused"]),
            trigger=("messages", 2), keep=("messages", 1), token_counter=lambda messages: len(messages))
        summary.memory_guard = guard
        extra = (*extra, summary)
    return create_agent(model or FakeListChatModel(responses=["SYNTHETIC_MODEL_RESPONSE"]), tools=[], checkpointer=env.checkpointer, state_schema=SophiaState,
        middleware=[MemoryContextEntryMiddleware(guard), *extra, MemoryContextModelProducer(guard), PromptAssemblyMiddleware("owner", context_id=env.tid)])


def test_fresh_authenticated_turn_executes_and_retained_second_turn_continues(env):
    cfg, messages = current(env)
    agent = graph(env, cfg)
    result = agent.invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}})
    assert result["messages"][-1].content == "SYNTHETIC_MODEL_RESPONSE"
    checkpoint = agent.get_state({"configurable": {"thread_id": env.tid}}).values
    assert CHECKPOINT_PROOF_KEY in checkpoint
    assert CHECKPOINT_PROOF_KEY not in result
    cfg, messages = current(env, "SECOND_SYNTHETIC_INPUT")
    second = graph(env, cfg).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}})
    assert len(second["messages"]) == 4
    assert second["messages"][-1].content == "SYNTHETIC_MODEL_RESPONSE"


@pytest.mark.parametrize("revoke_at_dispatch", [False, True])
def test_compiled_text_agent_reaches_exact_sdk_boundary(env, monkeypatch, revoke_at_dispatch):
    from test_mem00_model_clients import close_model, reply
    from test_mem00_model_dispatch import PermitStore

    from deerflow.agents.sophia_agent.state import SophiaState
    from deerflow.sophia.memory_governance.model_clients import GovernedChatAnthropic, ModelDispatchDenied
    from deerflow.sophia.memory_governance.service import MemoryProviderContract

    memory, automatic = approved_lookup(env, monkeypatch)
    cfg, messages = current(env)
    env.clock.provider_subject = "synthetic-namespace"
    provider = MemoryProviderContract("mem0", "synthetic", "existing-project")
    monkeypatch.setattr(MemoryProviderContract, "from_environ", lambda: provider)
    permit = PermitStore()
    observed, sent = [], []
    def authorize(**kwargs):
        observed.append(kwargs)
        # This fault is at final authority after prompt assembly and retrieval,
        # not at the earlier search. SQL denial must prevent transport entry.
        if revoke_at_dispatch:
            raise RuntimeError("synthetic final revocation conflict")
        return permit.authorize_model_dispatch(**kwargs)
    env.source_store.authorize_model_dispatch = authorize
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", lambda transport, wire: sent.append(json.loads(wire.content)) or reply("anthropic", wire))
    guard = MemoryRunGuard(owner_id="owner", config=cfg)
    model = GovernedChatAnthropic(model="existing-model", api_key="synthetic", max_retries=2,
        memory_authority_factory=guard.final_dispatch_authority)
    agent = create_agent(model, tools=[], checkpointer=env.checkpointer, state_schema=SophiaState,
        middleware=[MemoryContextEntryMiddleware(guard), automatic, MemoryContextModelProducer(guard),
                    PromptAssemblyMiddleware("owner", context_id=env.tid)])
    try:
        def invoke():
            return agent.invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}},
                context={"platform": "text", "thread_id": env.tid})
        if revoke_at_dispatch:
            with pytest.raises(ModelDispatchDenied):
                invoke()
            assert sent == []
        else:
            assert invoke()["messages"][-1].content == "SYNTHETIC RESPONSE"
            assert len(sent) == 1
            assert memory.canonical_content in json.dumps(sent[0])
        assert len(observed) == 1, "admission denial must not become SDK retry"
        attempt = observed[0]["p_attempt"]
        assert attempt["authorized_manifest"] == [{"memory_id": str(memory.memory_id), "content_revision": 1, "memory_governance_revision": 1}]
        assert attempt["source_witness"]["owner_id"] == "owner"
        assert memory.canonical_content not in json.dumps(attempt)
    finally:
        asyncio.run(close_model(model))


@pytest.mark.parametrize("key", ["sophia_builder_resume_request_v1", "sophia_builder_resume_run_v1",
    "sophia_builder_completion_run_v1", "sophia_builder_handoff_run_v1", "sophia_source_attachments_run_v1"])
def test_c2_text_refuses_disabled_lineage_before_consumers(env, key):
    cfg, messages = current(env)
    cfg[key] = {"untrusted_or_old": True}
    with pytest.raises(MemoryContextUnavailable):
        graph(env, cfg).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}})


@pytest.mark.parametrize("asynchronous", [False, True])
def test_pilot_build_awareness_preserves_tasks_without_rendering_retained_text(monkeypatch, asynchronous):
    from copy import deepcopy

    from deerflow.agents.sophia_agent.middlewares.build_awareness import BuildAwarenessMiddleware
    checked = []
    guard = SimpleNamespace(enabled=True, check=lambda: checked.append(True))
    middleware = BuildAwarenessMiddleware(memory_guard=guard)
    state = {"async_tasks": {"synthetic-task": {"agent_name": "builder", "status": "success",
             "description": "OLD_MEMORY_DERIVED_BRIEF", "result": "OLD_MEMORY_DERIVED_RESULT"}},
             "system_prompt_blocks": ["Independent rule", "<build_status>OLD_MEMORY_DERIVED_RESULT</build_status>"]}
    original = deepcopy(state)
    result = asyncio.run(middleware.abefore_agent(state, None)) if asynchronous else middleware.before_agent(state, None)
    assert checked == [True]
    assert state == original
    assert "async_tasks" not in result
    assert "OLD_MEMORY_DERIVED" not in repr(result)
    assert result["system_prompt_blocks"][0] == "Independent rule"
    assert "No task was cancelled or restarted" in repr(result)

def approved_lookup(env, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
    from deerflow.sophia.memory_governance.models import AuthorizedMemory
    from deerflow.sophia.memory_governance.refs import keyed_ref
    from deerflow.sophia.memory_governance.retrieval_provenance import issue_retrieval_proof
    memory = AuthorizedMemory(memory_id=UUID(int=7), content_revision=1, memory_governance_revision=1, canonical_content="SYNTHETIC_APPROVED_MEMORY", category="fact")
    env.canonical[memory.memory_id] = memory
    def lookup(**kwargs):
        if memory.memory_id not in env.canonical:
            return []
        receipt = SimpleNamespace(owner_ref=keyed_ref("owner", "owner"), provider_status="ok", prompt_admission_id=UUID(int=8),
            revocation_epoch_checked=env.clock.user_revocation_epoch, authorized_memory_ids=(keyed_ref("memory-revision", f"{memory.memory_id}:1:1"),))
        proof = issue_retrieval_proof(owner_id="owner", memories=(memory,), receipt=receipt)
        return [{"id": str(memory.memory_id), "content": memory.canonical_content, "category": "fact", "memory_retrieval_proof": proof}]
    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories", lookup)
    return memory, Mem0MemoryMiddleware("owner")


def test_approved_memory_reaches_model_and_unrelated_revocation_preserves_context(env, monkeypatch):
    from deerflow.sophia.memory_governance.refs import keyed_ref
    from deerflow.sophia.memory_governance.retained_context import RevocationDelta
    memory, automatic = approved_lookup(env, monkeypatch)
    captured = []
    class CaptureModel(FakeListChatModel):
        def _call(self, messages, *args, **kwargs):
            captured.append(messages)
            return super()._call(messages, *args, **kwargs)
    model = CaptureModel(responses=["SYNTHETIC_MODEL_RESPONSE"])
    cfg, messages = current(env)
    graph(env, cfg, [automatic], model).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    assert any(memory.canonical_content in str(message.content) for message in captured[0])
    env.clock.user_revocation_epoch = 4
    env.events.append(RevocationDelta(keyed_ref("owner", "owner"), 4, UUID(int=999)))
    cfg, messages = current(env, "NEXT_CURRENT_INPUT")
    result = graph(env, cfg, [automatic], model).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    assert len(result["messages"]) == 4
    assert len(captured) == 2


def test_related_revocation_blocks_old_native_context_and_fresh_native_context_has_zero_old_text(env, monkeypatch):
    from deerflow.sophia.memory_governance.refs import keyed_ref
    from deerflow.sophia.memory_governance.retained_context import RevocationDelta
    memory, automatic = approved_lookup(env, monkeypatch)
    cfg, messages = current(env)
    graph(env, cfg, [automatic]).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    env.clock.user_revocation_epoch = 4
    env.events.append(RevocationDelta(keyed_ref("owner", "owner"), 4, memory.memory_id))
    env.canonical.clear()
    cfg, messages = current(env, "POST_REVOCATION_INPUT")
    with pytest.raises(MemoryContextUnavailable):
        graph(env, cfg, [automatic]).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    env.tid = str(uuid4())
    cfg, messages = current(env, "POST_REVOCATION_INPUT")
    result = graph(env, cfg, [automatic]).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    assert len(result["messages"]) == 2
    assert memory.canonical_content not in str(result)


def test_complete_companion_middleware_chain_continues_on_sealed_checkpoint(env, monkeypatch, tmp_path):
    import deerflow.agents.sophia_agent.agent as companion
    from deerflow.config.paths import Paths

    class ToolCapableFake(FakeListChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setattr(companion, "ChatAnthropic", lambda **kwargs: ToolCapableFake(responses=["SYNTHETIC_FULL_CHAIN_RESPONSE"]))
    # This test owns the whole middleware/checkpoint flow with a fake model.
    # Real governed client/transport/SQL composition is a separate instrument.
    monkeypatch.setattr("deerflow.sophia.memory_governance.model_clients.GovernedChatAnthropic",
        lambda **kwargs: ToolCapableFake(responses=["SYNTHETIC_FULL_CHAIN_RESPONSE"]))
    monkeypatch.setattr(companion, "load_sophia_web_tools", lambda: [])
    monkeypatch.setattr(companion, "_create_summarization_middleware", lambda: None)
    def checked_factory(**kwargs):

        chain = kwargs["middleware"]
        producer_index = next(index for index, item in enumerate(chain) if isinstance(item, MemoryContextModelProducer))
        # Every later state writer would invalidate the exact persisted seal.
        # Model-call wrappers may transform the request, which still crosses
        # the separate final wire-payload admission boundary.
        for item in chain[producer_index + 1:]:
            assert type(item).before_model is AgentMiddleware.before_model
            assert type(item).abefore_model is AgentMiddleware.abefore_model
        return create_agent(**kwargs, checkpointer=env.checkpointer)
    monkeypatch.setattr(companion, "create_agent", checked_factory)
    paths = Paths(str(tmp_path))
    monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: paths)
    monkeypatch.setattr("deerflow.agents.middlewares.thread_data_middleware.get_paths", lambda: paths)
    monkeypatch.setattr("deerflow.sophia.delegation_ledger.ledger_enabled", lambda: False)
    memory, _ = approved_lookup(env, monkeypatch)
    for text in ("FIRST_FULL_CHAIN_INPUT", "SECOND_FULL_CHAIN_INPUT"):
        cfg, messages = current(env, text)
        cfg.update(platform="text", context_mode="life")
        agent = companion.make_sophia_agent({"configurable": cfg})
        result = agent.invoke({"messages": messages}, {"configurable": cfg}, context={"thread_id": env.tid, "platform": "text", "user_id": "owner"})
        assert result["messages"][-1].content == "SYNTHETIC_FULL_CHAIN_RESPONSE"
    assert len(result["messages"]) == 4
    assert result["injected_memories"] == [str(memory.memory_id)]


def test_unverifiable_retrieve_memories_proof_currently_aborts_the_turn(env):
    """Characterisation of the C3 finding, not an endorsement of the behaviour.

    A ``retrieve_memories`` result whose proof fails re-verification makes
    ``prepare_model`` raise, which aborts the whole run. The tool itself
    degrades to a sentinel in the same situation, so the guard is strictly
    harsher than its own producer.
    """
    from langchain_core.messages import ToolMessage

    cfg, messages = current(env)
    guard = MemoryRunGuard(owner_id="owner", config=cfg)
    guard.enter({"messages": messages})
    unproven = ToolMessage(content="- UNPROVEN_SYNTHETIC_MEMORY_TEXT", name="retrieve_memories", tool_call_id="call-1")
    with pytest.raises(MemoryContextUnavailable):
        guard.prepare_model({"messages": [*messages, unproven]})


def test_sentinel_retrieve_memories_result_is_skipped_and_turn_survives(env):
    """The existing graceful path: sentinel content with no artifact is skipped."""
    from langchain_core.messages import ToolMessage

    cfg, messages = current(env)
    guard = MemoryRunGuard(owner_id="owner", config=cfg)
    guard.enter({"messages": messages})
    sentinel = ToolMessage(content="Memory retrieval temporarily unavailable.", name="retrieve_memories", tool_call_id="call-2")
    update = guard.prepare_model({"messages": [*messages, sentinel]})
    assert "memory_context_proof" in update


def test_edited_revision_conflicts_with_retained_context(env, monkeypatch):
    """Reproduces the C3 edit-then-recall failure shape.

    A retained context holding content_revision 1, plus a fresh retrieval
    proving content_revision 2 for the same memory, is a replacement rather
    than an addition. The guard treats that as the documented "requires
    rotation" case and refuses the turn.
    """
    from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
    from deerflow.sophia.memory_governance.models import AuthorizedMemory
    from deerflow.sophia.memory_governance.refs import keyed_ref
    from deerflow.sophia.memory_governance.retrieval_provenance import issue_retrieval_proof

    memory_id = UUID(int=7)

    def lookup(**kwargs):
        held = env.canonical.get(memory_id)
        if held is None:
            return []
        receipt = SimpleNamespace(
            owner_ref=keyed_ref("owner", "owner"), provider_status="ok", prompt_admission_id=UUID(int=8),
            revocation_epoch_checked=env.clock.user_revocation_epoch,
            authorized_memory_ids=(keyed_ref("memory-revision", f"{memory_id}:{held.content_revision}:{held.memory_governance_revision}"),))
        proof = issue_retrieval_proof(owner_id="owner", memories=(held,), receipt=receipt)
        return [{"id": str(memory_id), "content": held.canonical_content, "category": "fact", "memory_retrieval_proof": proof}]

    monkeypatch.setattr("deerflow.agents.sophia_agent.middlewares.mem0_memory.search_memories", lookup)
    automatic = Mem0MemoryMiddleware("owner")

    env.canonical[memory_id] = AuthorizedMemory(memory_id=memory_id, content_revision=1, memory_governance_revision=1,
        canonical_content="TIN_OTTER_SYNTHETIC_BEFORE_EDIT", category="fact")
    cfg, messages = current(env)
    graph(env, cfg, [automatic]).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})

    env.canonical[memory_id] = AuthorizedMemory(memory_id=memory_id, content_revision=2, memory_governance_revision=1,
        canonical_content="TIN_OTTER_SYNTHETIC_AFTER_EDIT", category="fact")
    cfg, messages = current(env, "AFTER_EDIT_INPUT")
    with pytest.raises(MemoryContextUnavailable):
        graph(env, cfg, [automatic]).invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
