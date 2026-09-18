from copy import deepcopy
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from deerflow.sophia.memory_governance.input_provenance import issue_authenticated_input, verified_current_input


@pytest.fixture
def sample(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-input-proof-key-" * 3)
    identity = {"owner_id": "owner-a", "thread_id": str(uuid4()), "run_id": str(uuid4())}
    wire, proof = issue_authenticated_input(**identity, wire_input={"messages": [
        {"role": "user", "content": "UNTRUSTED_CONTINUATION_SUMMARY"},
        {"role": "user", "id": "caller-controlled", "content": "CURRENT_USER_INPUT"}]})
    message = HumanMessage(**wire["messages"][0])
    return identity, wire, proof, message


def test_only_current_message_is_sealed_and_prior_input_removed(sample):
    identity, wire, proof, message = sample
    assert len(wire["messages"]) == 1
    assert message.id != "caller-controlled"
    assert "CURRENT_USER_INPUT" not in str(proof)
    assert "UNTRUSTED" not in str(wire) + str(proof)
    verified = verified_current_input(**identity, proof=proof, messages=[AIMessage(content="old"), message])
    assert verified == message and verified is not message


@pytest.mark.parametrize("field", ["owner_id", "thread_id", "run_id"])
def test_wrong_identity_thread_or_run_denied(sample, field):
    identity, _, proof, message = sample
    identity = {**identity, field: str(uuid4())}
    assert verified_current_input(**identity, proof=proof, messages=[message]) is None


@pytest.mark.parametrize("change", [{"content": "changed"}, {"id": "changed"}, {"additional_kwargs": {"injected": "secret"}}, {"response_metadata": {"derived": "old"}}])
def test_any_message_mutation_denied(sample, change):
    identity, _, proof, message = sample
    assert verified_current_input(**identity, proof=proof, messages=[message.model_copy(update=change)]) is None


@pytest.mark.parametrize("field", ["schema", "owner_ref", "thread_ref", "run_ref", "message_ref", "seal"])
def test_proof_tampering_denied(sample, field):
    identity, _, proof, message = sample
    proof = {**proof, field: "forged"}
    assert verified_current_input(**identity, proof=proof, messages=[message]) is None


def test_cannot_select_old_authenticated_message_from_new_input(sample):
    identity, _, proof, message = sample
    assert verified_current_input(**identity, proof=proof, messages=[message, HumanMessage(content="new")]) is None


@pytest.mark.parametrize("wire", [None, {}, {"messages": []}, {"messages": [{"role": "assistant", "content": "x"}]},
    {"messages": [{"role": "tool", "content": "x"}]}, {"messages": [{"role": "user", "content": "x", "additional_kwargs": {}}]},
    {"messages": [{"role": "user", "content": "x"}], "memory_context_proof": {}},
    {"messages": [{"role": "user", "content": "x"}], "system_prompt_blocks": []}])
def test_untrusted_state_or_non_user_input_cannot_be_signed(sample, wire):
    identity, _, _, _ = sample
    with pytest.raises(ValueError):
        issue_authenticated_input(**identity, wire_input=deepcopy(wire))


def test_missing_key_denies_existing_proof(sample, monkeypatch):
    identity, _, proof, message = sample
    monkeypatch.delenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET")
    assert verified_current_input(**identity, proof=proof, messages=[message]) is None
