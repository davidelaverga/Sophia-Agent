"""Compiled recovery of ordinary companion derivatives after edit/forget."""

from copy import deepcopy
from uuid import UUID, uuid4

import pytest
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage
from mem00_owner_fixture import declare_memory_owners  # noqa: F401
from test_mem00_c2_text_context import _authorized, _revisioned_lookup, env, graph  # noqa: F401

from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextUnavailable
from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY, issue_recorded_authenticated_input
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.retained_context import RevocationDelta


def recorded_turn(env, content, session):  # noqa: F811
    run = str(uuid4())
    _, action = env.source_store.record("owner", env.tid, content, session=session)
    wire, proof = issue_recorded_authenticated_input(owner_id="owner", session_id=session, thread_id=env.tid,
        run_id=run, wire_input={"messages": [{"role": "user", "content": content}]}, source_action=action, store=env.source_store)
    return {"user_id": "owner", "langgraph_auth_user_id": "owner", "thread_id": env.tid,
        INPUT_PROOF_KEY: proof, INPUT_RUN_KEY: run}, [HumanMessage(**item) for item in wire["messages"]]


@pytest.mark.parametrize("forget", [False, True])
@pytest.mark.parametrize("blocked", [None, "builder_task", "unknown", "tampered", "source_changed", "native_file"])
def test_warm_companion_context_rebuilds_only_verified_sources(env, monkeypatch, tmp_path, forget, blocked):  # noqa: F811
    """Real checkpoint, source witnesses, middleware and model-view replacement.

    The fixture models the exact hosted extra channels, including generated
    insight/title/ritual text. SQL/provider authority remains independently tested.
    """
    memory_id = UUID(int=7)
    automatic = _revisioned_lookup(env, monkeypatch, memory_id)
    env.canonical[memory_id] = _authorized(memory_id, 1, 1, "OLD_SYNTHETIC_MEMORY")
    captured = []
    states = []
    rows = {}

    def read(method, table, params):
        assert (method, table) == ("GET", "sophia_session_messages")
        row = rows[params["id"].removeprefix("eq.")]
        assert all(params[key] == "eq." + row[key] for key in ("user_id", "session_id", "thread_id"))
        return [deepcopy(row)]

    env.source_store._request = read

    class Capture(FakeListChatModel):
        def _call(self, messages, *args, **kwargs):
            captured.append(deepcopy(messages))
            return super()._call(messages, *args, **kwargs)

    class CompanionDerivatives(AgentMiddleware):
        def before_model(self, state, runtime):
            states.append(deepcopy(state))
            if captured:
                return None
            return {"user_id": "owner", "title": "OLD_SYNTHETIC_MEMORY title", "active_ritual": "reset",
                "ritual_phase": "OLD_SYNTHETIC_MEMORY phase", "current_artifact": {"takeaway": "OLD_SYNTHETIC_MEMORY insight"},
                "previous_artifact": {"session_goal": "OLD_SYNTHETIC_MEMORY goal"},
                **({"builder_task": {"status": "running", "description": "held"}} if blocked == "builder_task" else {})}

    session = str(uuid4())
    model = Capture(responses=["OLD_SYNTHETIC_MEMORY answer", "NEW_SAFE_RESPONSE"])
    config, messages = recorded_turn(env, "FIRST_INDEPENDENT_SOURCE", session)
    first = graph(env, config, [automatic, CompanionDerivatives()], model)
    first.invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    checkpoint = first.get_state({"configurable": {"thread_id": env.tid}})
    original = deepcopy(checkpoint.values)
    for receipt in env.source_store.receipts.values():
        rows[receipt["source_row_id"]] = {"id": receipt["source_row_id"], "message_id": receipt["message_id"], "user_id": "owner",
            "session_id": session, "thread_id": env.tid, "sequence": receipt["sequence"], "role": "user", "content": "FIRST_INDEPENDENT_SOURCE",
            "final": True, "memory_source_version": receipt["source_version"]}
    env.clock.user_revocation_epoch += 1
    env.events.append(RevocationDelta(keyed_ref("owner", "owner"), env.clock.user_revocation_epoch, memory_id))
    if forget:
        env.canonical.clear()
    else:
        env.canonical[memory_id] = _authorized(memory_id, 2, 2, "NEW_SYNTHETIC_MEMORY")
    if blocked == "tampered":
        first.update_state({"configurable": {"thread_id": env.tid}}, {"title": "UNSEALED TITLE"})
    if blocked == "source_changed":
        env.source_store.versions[messages[0].id] = str(uuid4())
    if blocked == "native_file":
        path = tmp_path / env.tid / "work"
        path.mkdir(parents=True)
        (path / "retained.txt").write_text("OLD_SYNTHETIC_MEMORY")
    config, messages = recorded_turn(env, "SECOND_INDEPENDENT_SOURCE", session)
    receipt = env.source_store.receipts[("owner", config[INPUT_PROOF_KEY]["source_witness"]["command_key"])]
    rows[receipt["source_row_id"]] = {"id": receipt["source_row_id"], "message_id": receipt["message_id"], "user_id": "owner",
        "session_id": session, "thread_id": env.tid, "sequence": receipt["sequence"], "role": "user", "content": "SECOND_INDEPENDENT_SOURCE",
        "final": True, "memory_source_version": receipt["source_version"]}
    agent = graph(env, config, [automatic, CompanionDerivatives()], model)
    if blocked == "unknown":
        # Unknown extension channels remain refused even under a valid seal.
        from deerflow.sophia.memory_governance import chat_context_recovery
        real = chat_context_recovery.rebuild_plain_chat_sources
        def with_unknown(**kwargs):
            return real(**{**kwargs, "previous": {**kwargs["previous"], "unknown_extension": {"retained": True}}})
        monkeypatch.setattr(chat_context_recovery, "rebuild_plain_chat_sources", with_unknown)
    def invoke():
        return agent.invoke({"messages": messages}, {"configurable": {"thread_id": env.tid}}, context={"platform": "text", "thread_id": env.tid})
    if blocked:
        with pytest.raises(MemoryContextUnavailable):
            invoke()
        assert len(captured) == 1
    else:
        result = invoke()
        assert result["messages"][-1].content == "NEW_SAFE_RESPONSE"
        assert "OLD_SYNTHETIC_MEMORY" not in str(captured[-1])
        assert "OLD_SYNTHETIC_MEMORY" not in str(states[-1])
        assert "FIRST_INDEPENDENT_SOURCE" in str(captured[-1])
        assert "SECOND_INDEPENDENT_SOURCE" in str(captured[-1])
        assert ("NEW_SYNTHETIC_MEMORY" in str(captured[-1])) is not forget
        system = captured[-1][0].content
        assert "Journal manages your saved Sophia memories" in system
        assert "Keep and Complete" in system
        assert "does not prove an authorization lapse" in system
        assert first.get_state(checkpoint.config).values == original, "historical checkpoint is preserved"
