"""Integrity is necessary, never sufficient, for current memory admission."""

from copy import deepcopy
from dataclasses import replace
from uuid import UUID

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deerflow.sophia.memory_governance.context_provenance import seal_context, verify_context_seal
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.retained_admission import RetainedAdmission
from deerflow.sophia.memory_governance.retained_context import ContextTransition, RetainedMemoryContext

SECRET_TEXT = "SYNTHETIC_CONTEXT_TEXT_NOT_PORTABLE"


@pytest.fixture
def snapshot(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    admission = RetainedAdmission(ContextTransition("continue", "revocation_epoch_unchanged", 3),
        RetainedMemoryContext(keyed_ref("owner", "owner"), 3, ()), (), UUID(int=3))
    args = {"owner_id": "owner", "context_id": "thread", "messages": [HumanMessage(content=SECRET_TEXT, id="input-id"),
        AIMessage(content="", id="ai-id", tool_calls=[{"name": "synthetic_tool", "args": {"question": SECRET_TEXT}, "id": "call"}]),
        ToolMessage(content=SECRET_TEXT, name="synthetic_tool", tool_call_id="call", id="tool-id", artifact={"synthetic": SECRET_TEXT})],
        "blocks": ["Trusted synthetic rule"], "admission": admission}
    proof = seal_context(**args)
    return args, proof


def verify(snapshot, **overrides):
    args, proof = snapshot
    return verify_context_seal(**{key: val for key, val in {**args, "value": proof, **overrides}.items() if key != "admission"})


def test_server_seal_preserves_structural_manifest_without_plaintext(snapshot):
    args, proof = snapshot
    assert verify(snapshot) == args["admission"].context
    assert SECRET_TEXT not in str(proof)
    assert "Trusted synthetic rule" not in str(proof)
    assert "input-id" not in str(proof)


@pytest.mark.parametrize("field", ["artifact", "summary", "delegation_context", "async_tasks", "injected_memory_contents", "unknown_new_derivative"])
def test_full_checkpoint_proof_covers_non_message_derivatives(snapshot, field):
    from deerflow.sophia.memory_governance.context_provenance import CHECKPOINT_PROOF_KEY, seal_checkpoint, verify_checkpoint_seal
    args, _ = snapshot
    state = {"messages": args["messages"], "system_prompt_blocks": args["blocks"], field: {"synthetic": SECRET_TEXT}}
    identity = {"owner_id": args["owner_id"], "context_id": args["context_id"]}
    proof = seal_checkpoint(**identity, state=state, admission=args["admission"])
    assert SECRET_TEXT not in str(proof)
    state[CHECKPOINT_PROOF_KEY] = proof
    assert verify_checkpoint_seal(**identity, state=state) == args["admission"].context
    state[field] = {"unbound": "changed"}
    assert verify_checkpoint_seal(**identity, state=state) is None


def test_checkpoint_does_not_silently_drop_unsupported_state(snapshot):
    from deerflow.sophia.memory_governance.context_provenance import seal_checkpoint
    args, _ = snapshot
    with pytest.raises(ValueError):
        seal_checkpoint(owner_id=args["owner_id"], context_id=args["context_id"], admission=args["admission"],
            state={"messages": args["messages"], "system_prompt_blocks": [], "unknown": object()})


@pytest.mark.parametrize("field,value", [("owner_id", "wrong-owner"), ("context_id", "wrong-thread")])
def test_no_cross_owner_or_cross_context_replay(snapshot, field, value):
    assert verify(snapshot, **{field: value}) is None


@pytest.mark.parametrize("mutation", ["content", "tool_args", "tool_name", "artifact", "additional_kwargs", "message_id", "order", "drop", "append"])
def test_unproven_message_transform_requires_new_trusted_transition(snapshot, mutation):
    args, _ = snapshot
    messages = deepcopy(args["messages"])
    if mutation == "content":
        messages[0].content = "changed"
    elif mutation == "tool_args":
        messages[1].tool_calls[0]["args"] = {"changed": True}
    elif mutation == "tool_name":
        messages[2].name = "retrieve_memories"
    elif mutation == "artifact":
        messages[2].artifact = {"changed": True}
    elif mutation == "additional_kwargs":
        messages[0].additional_kwargs["untrusted_injection"] = "changed"
    elif mutation == "message_id":
        messages[0].id = "different-id"
    elif mutation == "order":
        messages.reverse()
    elif mutation == "drop":
        messages.pop()
    elif mutation == "append":
        messages.append(HumanMessage(content="New source not yet validated"))
    assert verify(snapshot, messages=messages) is None


def test_old_summary_or_builder_block_cannot_be_attached_to_valid_history(snapshot):
    assert verify(snapshot, blocks=["<prior_context_state>unbound</prior_context_state>"]) is None
    assert verify(snapshot, blocks=["Trusted synthetic rule", "<builder_briefing>unbound</builder_briefing>"]) is None


@pytest.mark.parametrize("mutation", ["epoch", "admission", "extra", "forged_seal", "missing", "empty"])
def test_caller_structural_metadata_is_not_provenance(snapshot, mutation):
    _, original = snapshot
    proof = deepcopy(original)
    if mutation == "epoch":
        proof["manifest"]["revocation_epoch"] += 1
    elif mutation == "admission":
        proof["admission_ref"] = "fake"
    elif mutation == "extra":
        proof["approved"] = True
    elif mutation == "forged_seal":
        proof["seal"] = "0" * 64
    elif mutation == "missing":
        del proof["seal"]
    elif mutation == "empty":
        proof = {}
    assert verify(snapshot, value=proof) is None


def test_credential_change_invalidates_prior_provenance(snapshot, monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "x" * 32)
    assert verify(snapshot) is None


@pytest.mark.parametrize("shape", [None, [], {}, "raw-provider-text"])
def test_bad_proof_never_continues(snapshot, shape):
    assert verify(snapshot, value=shape) is None


@pytest.mark.parametrize("shape", [[], ["raw-string"], [HumanMessage(content="x")] * 2049])
def test_bounded_typed_snapshot(snapshot, shape):
    assert verify(snapshot, messages=shape) is None


def test_no_seal_can_be_minted_from_denied_admission(snapshot):
    args, _ = snapshot
    with pytest.raises(ValueError, match="admission_required"):
        seal_context(**{**args, "admission": replace(args["admission"], transition=ContextTransition("zero_memory", "governance_unavailable", None))})


def test_plaintext_size_cap(snapshot):
    assert verify(snapshot, blocks=["x" * (4 * 1024 * 1024 + 1)]) is None
