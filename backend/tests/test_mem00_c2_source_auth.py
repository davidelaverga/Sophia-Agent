"""Installed auth-hook contract joined to recorded input; no hosted auth claim."""
from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
from langgraph_sdk import Auth
from mem00_owner_fixture import declare_memory_owners
from mem00_recorded_input_fixture import RecordedInputFixture

from deerflow.sophia import langgraph_auth as policy
from deerflow.sophia.memory_governance.input_provenance import INPUT_PROOF_KEY, INPUT_RUN_KEY, RECORDED_SCHEMA
from deerflow.sophia.memory_governance.source_input_provenance import SOURCE_ACTION_KEY, SOURCE_SESSION_KEY


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def setup(monkeypatch, declare_memory_owners):
    declare_memory_owners({"owner": "governed", "legacy": "legacy"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-auth-source-" * 3)
    store = RecordedInputFixture()
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: store)
    thread, run = str(uuid4()), str(uuid4())
    session, action = store.record("owner", thread, "SYNTHETIC CURRENT INPUT")
    cfg = {"user_id": "owner", "langgraph_auth_user_id": "owner", SOURCE_ACTION_KEY: action, SOURCE_SESSION_KEY: session,
           INPUT_PROOF_KEY: {"caller_or_inherited": True}, INPUT_RUN_KEY: "old-run"}
    value = {"thread_id": thread, "run_id": run, "assistant_id": policy.COMPANION_ASSISTANT_ID,
             "kwargs": {"config": {"configurable": cfg}, "context": {},
                        "input": {"messages": [{"role": "user", "content": action["content"]}]}}}
    ctx = SimpleNamespace(user=SimpleNamespace(identity="owner"), permissions=[policy.USER_PERMISSION])
    return SimpleNamespace(store=store, value=value, cfg=cfg, ctx=ctx, action=action, session=session)


@pytest.mark.anyio
async def test_auth_hook_joins_recorded_source_and_overwrites_inherited_proof(setup):
    before = deepcopy(setup.store.receipts)
    result = await policy.create_run(setup.ctx, setup.value)
    proof = setup.cfg[INPUT_PROOF_KEY]
    assert proof["schema"] == RECORDED_SCHEMA
    assert proof["source_witness"]["owner_id"] == "owner"
    assert proof["source_witness"]["session_id"] == setup.session
    assert setup.cfg[INPUT_RUN_KEY] == setup.value["run_id"]
    assert setup.cfg[SOURCE_ACTION_KEY] is None and setup.cfg[SOURCE_SESSION_KEY] is None
    assert setup.value["kwargs"]["context"][INPUT_PROOF_KEY] is None
    assert setup.value["kwargs"]["context"]["user_id"] == "owner"
    assert setup.store.receipts == before, "auth must observe original receipt, not create source"
    assert result == setup.value["metadata"]


@pytest.mark.anyio
@pytest.mark.parametrize("fault", ["owner", "server_owner", "source_missing", "source_changed", "body_changed", "other_graph", "command", "db_outage", "context_owner"])
async def test_governed_auth_denies_uncertain_or_alternate_source(setup, fault):
    if fault == "owner": setup.cfg["user_id"] = "other"
    if fault == "server_owner": setup.cfg["langgraph_auth_user_id"] = "other"
    if fault == "source_missing": setup.cfg.pop(SOURCE_ACTION_KEY)
    if fault == "source_changed": setup.store.versions[setup.action["message_id"]] = str(uuid4())
    if fault == "body_changed": setup.value["kwargs"]["input"]["messages"][0]["content"] = "DIFFERENT INPUT"
    if fault == "other_graph": setup.value["assistant_id"] = "lead_agent"
    if fault == "command": setup.value["kwargs"]["command"] = {"resume": "untrusted"}
    if fault == "db_outage": setup.store.unavailable = True
    if fault == "context_owner": setup.value["kwargs"]["context"]["user_id"] = "other"
    with pytest.raises(Auth.exceptions.HTTPException):
        await policy.create_run(setup.ctx, setup.value)


@pytest.mark.anyio
@pytest.mark.parametrize("key", ["sophia_builder_handoff_v1", "sophia_builder_completion_request_v1", "sophia_builder_resume_request_v1", "memory_source_attachment_keys"])
@pytest.mark.parametrize("surface", ["config", "context"])
async def test_c2_disabled_transition_cannot_fall_through_to_text(setup, key, surface):
    target = setup.cfg if surface == "config" else setup.value["kwargs"]["context"]
    target[key] = {"old_or_untrusted": True}
    with pytest.raises(Auth.exceptions.HTTPException):
        await policy.create_run(setup.ctx, setup.value)


@pytest.mark.anyio
async def test_unknown_authority_gets_no_lane_and_no_source_provenance(setup):
    """An undeclared owner is not enrolled; that is not the same as blocked.

    This used to assert that `create_run` DENIES an unknown owner. It did, and
    that was the front-door defect: the hook runs on every authenticated run
    creation, so every account outside the pilot was refused before any
    middleware existed. The invariant the test is named for -- unknown never
    reopens the legacy lane -- is unchanged and asserted below: no recorded
    input proof, no source carriers, and no Builder handoff. The run proceeds
    with a run id and nothing else.
    """
    setup.ctx.user.identity = "unknown"
    setup.cfg.update(user_id="unknown", langgraph_auth_user_id="unknown")
    await policy.create_run(setup.ctx, setup.value)
    assert setup.cfg[INPUT_PROOF_KEY] is None, "no recorded-input provenance is minted"
    assert setup.cfg[SOURCE_ACTION_KEY] is None and setup.cfg[SOURCE_SESSION_KEY] is None
    assert setup.cfg[INPUT_RUN_KEY] == setup.value["run_id"]
    assert setup.cfg["sophia_builder_handoff_v1"] is None


@pytest.mark.anyio
async def test_unknown_authority_is_still_refused_a_builder_handoff(setup):
    """The lane that matters stays shut for an owner with no declaration."""
    setup.ctx.user.identity = "unknown"
    setup.cfg.update(user_id="unknown", langgraph_auth_user_id="unknown",
                     sophia_builder_handoff_v1={"claimed": True})
    with pytest.raises(Auth.exceptions.HTTPException):
        await policy.create_run(setup.ctx, setup.value)


@pytest.mark.anyio
async def test_an_outage_still_denies_rather_than_degrading_to_unknown(setup, monkeypatch):
    """Unavailability is not "not enrolled"; the front door still fails closed."""
    from deerflow.sophia.memory_governance import owner_authority

    def unreachable():
        raise TimeoutError("supabase unreachable")

    setup.ctx.user.identity = "unknown"
    setup.cfg.update(user_id="unknown", langgraph_auth_user_id="unknown")
    monkeypatch.setattr(owner_authority, "configured_memory_store", unreachable)
    with pytest.raises(Auth.exceptions.HTTPException):
        await policy.create_run(setup.ctx, setup.value)


@pytest.mark.anyio
async def test_declared_legacy_receives_current_run_identity_not_canonical_proof(setup):
    setup.ctx.user.identity = "legacy"
    setup.cfg.update(user_id="legacy", langgraph_auth_user_id="legacy")
    await policy.create_run(setup.ctx, setup.value)
    assert setup.cfg[INPUT_PROOF_KEY] is None
    assert setup.cfg[INPUT_RUN_KEY] == setup.value["run_id"]
