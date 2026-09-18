"""Undeclared non-cohort owner through the compiled text / model-entry path.

`test_mem00_noncohort_owner_paths.py` fixed the two *ordinary* call sites so an
undeclared owner resolves all-off memory flags instead of raising. That is only
half the supported path. The compiled text agent also builds a `MemoryRunGuard`
(`agent.py`, `MemoryRunGuard(owner_id=user_id, config=cfg, scope=context_mode)`)
and `MemoryContextEntryMiddleware.before_agent` calls `guard.enter(state)`.

The guard decides whether to engage the governed path from
`allows_unversioned_builder_handoff`, which catches every exception and returns
False. For an undeclared owner that reads as "not allowed to use the unversioned
lane", so the guard sets `enabled = True` and enters the governed branch — where
the first thing it does is require `governed_runtime_read`, which an undeclared
owner can never have. The ordinary middleware has already told that same turn
there is no memory.

So the two halves disagree, and the disagreement surfaces as
`MemoryContextUnavailable` escaping `before_agent` on an ordinary text turn for
any user outside the pilot. These tests pin the intended behaviour under the
selected non-cohort policy: an undeclared owner takes the no-memory path, a
store outage still fails closed, and a governed owner is unaffected.
"""

from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

PILOT_ENV = {
    "SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE": "true",
    "SOPHIA_MEMORY_CANDIDATE_LEDGER_READ": "true",
    "SOPHIA_MEMORY_CANONICAL_POOL_READ": "true",
    "SOPHIA_MEMORY_PROVIDER_PROJECTION": "true",
    "SOPHIA_MEMORY_GOVERNED_RUNTIME_READ": "true",
    "SOPHIA_MEMORY_COHORT_PRINCIPALS": "governed-pilot-owner",
}


class _StubStore:
    def __init__(self, authority_state="unknown"):
        self.authority_state = authority_state

    def get_contract(self):
        return SimpleNamespace(schema_version="mem00.v1", contract_epoch=1, mode="enforced")

    def get_owner_authority(self, user_id):
        if self.authority_state == "unknown":
            return SimpleNamespace(
                user_id=user_id, authority_state="unknown",
                authority_epoch=None, authority_declared_at=None,
            )
        return SimpleNamespace(
            user_id=user_id, authority_state=self.authority_state,
            authority_epoch=1, authority_declared_at=datetime.now(UTC),
        )


class _DownStore:
    def get_contract(self):
        raise TimeoutError("supabase unreachable")

    def get_owner_authority(self, user_id):
        raise TimeoutError("supabase unreachable")


def _env(monkeypatch):
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)


def _store(monkeypatch, store):
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: store)


@contextmanager
def _as_active_model_guard(guard):
    """What MemoryContextModelProducer.wrap_model_call does around the handler.

    Bound explicitly here because `final_dispatch_authority` refuses any guard
    that is not the active one -- the check that made the previous version of
    the last test pass for the wrong reason.
    """
    from deerflow.agents.sophia_agent.middlewares import memory_context

    token = memory_context._active_model_guard.set(guard)
    try:
        yield
    finally:
        memory_context._active_model_guard.reset(token)


def _guard(owner, thread_id="thread-1"):
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard

    return MemoryRunGuard(owner_id=owner, config={"thread_id": thread_id}, scope="global")


def test_undeclared_owner_does_not_engage_the_governed_path(monkeypatch):
    """The guard must agree with the ordinary middleware: this owner has none."""
    _env(monkeypatch)
    _store(monkeypatch, _StubStore("unknown"))

    guard = _guard("ordinary-production-user")
    assert guard.enabled is False


def test_undeclared_owner_survives_before_agent_on_the_text_path(monkeypatch):
    """An ordinary text turn for a non-pilot user must not raise."""
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware

    _env(monkeypatch)
    _store(monkeypatch, _StubStore("unknown"))

    guard = _guard("ordinary-production-user")
    middleware = MemoryContextEntryMiddleware(guard)
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)

    # No memory state is produced, and nothing escapes.
    assert middleware.before_agent({"messages": []}, runtime) is None


def test_store_outage_still_fails_closed(monkeypatch):
    """An outage is not an answer; the guard must still engage and deny."""
    from deerflow.agents.sophia_agent.middlewares.memory_context import (
        MemoryContextEntryMiddleware,
        MemoryContextUnavailable,
    )

    _env(monkeypatch)
    _store(monkeypatch, _DownStore())

    guard = _guard("governed-pilot-owner")
    assert guard.enabled is True

    middleware = MemoryContextEntryMiddleware(guard)
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)
    with pytest.raises(MemoryContextUnavailable):
        middleware.before_agent({"messages": []}, runtime)


def test_governed_owner_still_engages_the_governed_path(monkeypatch):
    """The repair must not quietly disable the pilot owner's own guard."""
    _env(monkeypatch)
    _store(monkeypatch, _StubStore("governed"))

    guard = _guard("governed-pilot-owner")
    assert guard.enabled is True


def test_declared_legacy_owner_is_unchanged(monkeypatch):
    """A declared legacy owner keeps the unversioned lane the design gives it."""
    _env(monkeypatch)
    _store(monkeypatch, _StubStore("legacy"))

    guard = _guard("declared-legacy-user")
    # allows_unversioned_builder_handoff is True for legacy, so the governed
    # guard stays off. This is existing behaviour, pinned so the repair does
    # not move it.
    assert guard.enabled is False


def test_an_unbound_guard_is_refused_at_the_model_boundary(monkeypatch):
    """A guard that is not the active one cannot mint any authority at all.

    This used to be the file's only dispatch test, asserting
    `pytest.raises((MemoryContextUnavailable, Exception))` -- which the
    active-guard check below satisfies on its own, so it proved nothing about
    undeclared owners. It is kept for what it does establish, and the real
    dispatch behaviour is exercised against the compiled agent further down.
    """
    import httpx

    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    _env(monkeypatch)
    _store(monkeypatch, _StubStore("unknown"))

    guard = _guard("ordinary-production-user")
    wire = httpx.Request("POST", "https://api.anthropic.com/v1/messages",
        json={"model": "existing-model", "messages": []}, headers={"content-type": "application/json"})
    with pytest.raises(MemoryGovernanceUnavailable):
        guard.final_dispatch_authority(wire)


# ---------------------------------------------------------------------------
# The compiled path, executed for real.
#
# Everything above inspects guard state. None of it runs a model request, so
# none of it can show that an ordinary non-pilot turn actually completes --
# and the final-authority test above is weaker still: `active_model_guard()
# is not self` raises before any undeclared-owner logic runs, and
# `pytest.raises((MemoryContextUnavailable, Exception))` accepts that. It is
# replaced below by a test that reaches the SDK boundary.
# ---------------------------------------------------------------------------


class _UndeclaredStore(_StubStore):
    """Reachable store in which no owner has ever been declared.

    Every governance RPC raises if called: the no-memory lane must not reach
    one. `get_owner_authority` returns the schema's own default row rather
    than raising, because that is what production returns for an account that
    exists and was never enrolled.
    """

    def __init__(self):
        super().__init__("unknown")
        self.rpc_calls = []

    def _refuse(self, name, **kwargs):
        self.rpc_calls.append(name)
        raise AssertionError(f"no-memory lane must not call {name}")

    def authorize_model_dispatch(self, **kwargs):
        self._refuse("authorize_model_dispatch", **kwargs)

    def authorize_legacy_model_dispatch(self, **kwargs):
        self._refuse("authorize_legacy_model_dispatch", **kwargs)

    def get_user_governance(self, owner):
        self._refuse("get_user_governance")


@pytest.fixture
def compiled_env(monkeypatch, tmp_path):
    """Valid authenticated run context for an owner nobody has declared."""
    import json
    from uuid import uuid4

    import httpx

    _env(monkeypatch)
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-runtime-key-" * 3)
    store = _UndeclaredStore()
    _store(monkeypatch, store)
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: store)
    monkeypatch.setattr("deerflow.config.paths.get_paths", lambda: SimpleNamespace(
        sandbox_work_dir=lambda tid: tmp_path / tid / "work",
        sandbox_uploads_dir=lambda tid: tmp_path / tid / "uploads",
        sandbox_outputs_dir=lambda tid: tmp_path / tid / "outputs"))
    sent = []
    from test_mem00_model_clients import reply
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request",
        lambda transport, wire: sent.append(json.loads(wire.content)) or reply("anthropic", wire))
    thread_id = str(uuid4())
    # Exactly what the authenticated create_run hook leaves behind for an owner
    # who is not governed: an owner-scoped run id, and no input/source proof.
    cfg = {"user_id": "ordinary-production-user", "langgraph_auth_user_id": "ordinary-production-user",
           "thread_id": thread_id, "sophia_authenticated_input_run_id": str(uuid4())}
    return SimpleNamespace(store=store, sent=sent, tid=thread_id, cfg=cfg)


def _compiled_agent(compiled_env, guard):
    from langchain.agents import create_agent
    from langgraph.checkpoint.memory import InMemorySaver

    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware, MemoryContextModelProducer
    from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
    from deerflow.agents.sophia_agent.state import SophiaState
    from deerflow.sophia.memory_governance.model_clients import GovernedChatAnthropic

    model = GovernedChatAnthropic(model="existing-model", api_key="synthetic", max_retries=2,
        memory_authority_factory=guard.final_dispatch_authority)
    agent = create_agent(model, tools=[], checkpointer=InMemorySaver(), state_schema=SophiaState,
        middleware=[MemoryContextEntryMiddleware(guard), MemoryContextModelProducer(guard),
                    PromptAssemblyMiddleware(guard.owner, context_id=compiled_env.tid)])
    return model, agent


def test_undeclared_owner_completes_a_compiled_model_request(compiled_env):
    """The positive case: an ordinary text turn for a non-pilot user succeeds.

    This is the claim the earlier tests could not make. It runs the real
    compiled agent, the real governed model client and the real final-admission
    transport, and asserts the request reaches the provider and comes back.
    """
    import asyncio
    import json

    from langchain_core.messages import HumanMessage
    from test_mem00_model_clients import close_model

    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard

    # Built exactly as agent.py builds it: from the authenticated run config.
    guard = MemoryRunGuard(owner_id="ordinary-production-user", config=compiled_env.cfg, scope="global")
    assert guard.undeclared is True
    # Record which lane the transport was actually handed, so a pass cannot mean
    # "it worked somehow" -- only "it worked through the no-memory lane".
    lanes = []
    factory = guard.final_dispatch_authority
    guard.final_dispatch_authority = lambda wire: lanes.append(factory(wire)) or lanes[-1]
    model, agent = _compiled_agent(compiled_env, guard)
    try:
        result = agent.invoke({"messages": [HumanMessage("CURRENT_SYNTHETIC_INPUT")]},
            {"configurable": compiled_env.cfg},
            context={"platform": "text", "thread_id": compiled_env.tid})
    finally:
        asyncio.run(close_model(model))

    assert result["messages"][-1].content == "SYNTHETIC RESPONSE"
    assert len(compiled_env.sent) == 1, "one physical request, no admission-denial retry"
    # No admission of any kind was sought. Not the governed permit, not the
    # temporary legacy one.
    assert compiled_env.store.rpc_calls == []
    # Nothing memory-derived reached the model: no retained inclusion, no
    # retrieval block, no personal-memory system block.
    payload = json.dumps(compiled_env.sent[0])
    assert "memory_retrieval_proof" not in payload
    assert "injected_memories" not in payload
    assert guard.admission is None
    assert guard.entered is False
    from deerflow.sophia.memory_governance.no_memory_model_dispatch import NoMemoryModelDispatchAuthority
    assert [type(lane) for lane in lanes] == [NoMemoryModelDispatchAuthority]


def test_no_memory_authority_is_a_distinct_lane_not_the_legacy_one(compiled_env):
    """The authority itself: right type, empty attempt, one use only."""
    import httpx

    from deerflow.sophia.memory_governance.legacy_model_dispatch import LegacyModelDispatchAuthority
    from deerflow.sophia.memory_governance.model_dispatch import FinalModelDispatchAuthority
    from deerflow.sophia.memory_governance.no_memory_model_dispatch import NoMemoryModelDispatchAuthority
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
    guard = _guard("ordinary-production-user", thread_id=compiled_env.tid)
    guard.config.update(compiled_env.cfg)
    wire = httpx.Request("POST", "https://api.anthropic.com/v1/messages",
        json={"model": "existing-model", "messages": []}, headers={"content-type": "application/json"})
    with _as_active_model_guard(guard):
        authority = guard.final_dispatch_authority(wire)
    assert isinstance(authority, NoMemoryModelDispatchAuthority)
    assert not isinstance(authority, (FinalModelDispatchAuthority, LegacyModelDispatchAuthority))
    attempt = authority.attempt
    assert attempt.authority_state == "unknown"
    assert attempt.memory_material_present is False
    # There is no field in which a memory could be named.
    assert "authorized_manifest" not in attempt.model_dump()
    assert "source_dependencies" not in attempt.model_dump()

    receipt = authority.admit(wire)
    assert receipt.canonical_approval_granted is False
    assert receipt.legacy_lane_used is False
    assert compiled_env.store.rpc_calls == []
    with pytest.raises(MemoryGovernanceUnavailable):
        authority.admit(wire)


def test_no_memory_authority_refuses_to_cover_a_request_carrying_memory(compiled_env):
    """Emptiness is checked at the boundary, not taken on the guard's word."""
    import httpx

    from deerflow.sophia.memory_governance.model_dispatch import snapshot_model_request
    from deerflow.sophia.memory_governance.no_memory_model_dispatch import NoMemoryModelAttempt, NoMemoryModelDispatchAuthority
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    wire = httpx.Request("POST", "https://api.anthropic.com/v1/messages",
        json={"model": "existing-model", "messages": []}, headers={"content-type": "application/json"})
    attempt = NoMemoryModelAttempt.model_validate({
        "schema": "mem00.no-memory-model-attempt.v1", "attempt_id": compiled_env.cfg["sophia_authenticated_input_run_id"],
        "run_id": compiled_env.cfg["sophia_authenticated_input_run_id"], "thread_id": compiled_env.tid,
        "scope": "global", "authority_state": "unknown", "memory_material_present": False,
        **snapshot_model_request(wire).__dict__})
    with pytest.raises(MemoryGovernanceUnavailable):
        NoMemoryModelDispatchAuthority(owner_id="ordinary-production-user", attempt=attempt,
            memory_state=(None, object(), None))


def test_governed_owner_still_takes_the_governed_lane_not_the_no_memory_one(compiled_env, monkeypatch):
    """The repair must not give a pilot owner a free pass around admission."""
    import httpx

    from deerflow.sophia.memory_governance.no_memory_model_dispatch import NoMemoryModelDispatchAuthority
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
    _store(monkeypatch, _StubStore("governed"))
    guard = _guard("governed-pilot-owner", thread_id=compiled_env.tid)
    guard.config.update({**compiled_env.cfg, "user_id": "governed-pilot-owner",
                         "langgraph_auth_user_id": "governed-pilot-owner"})
    assert guard.undeclared is False
    wire = httpx.Request("POST", "https://api.anthropic.com/v1/messages",
        json={"model": "existing-model", "messages": []}, headers={"content-type": "application/json"})
    with _as_active_model_guard(guard):
        # No source witness and no admission, so the governed lane denies. What
        # it must never do is fall back to the no-memory lane.
        with pytest.raises(MemoryGovernanceUnavailable) as raised:
            guard.final_dispatch_authority(wire)
    assert not isinstance(raised.value, NoMemoryModelDispatchAuthority)


def test_store_outage_never_reaches_the_no_memory_lane(compiled_env, monkeypatch):
    """An outage is not "undeclared"; it must still fail closed at dispatch."""
    import httpx

    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
    _store(monkeypatch, _DownStore())
    guard = _guard("ordinary-production-user", thread_id=compiled_env.tid)
    guard.config.update(compiled_env.cfg)
    assert guard.undeclared is False, "an unreachable store proves nothing about enrollment"
    wire = httpx.Request("POST", "https://api.anthropic.com/v1/messages",
        json={"model": "existing-model", "messages": []}, headers={"content-type": "application/json"})
    with _as_active_model_guard(guard):
        with pytest.raises(MemoryGovernanceUnavailable):
            guard.final_dispatch_authority(wire)
