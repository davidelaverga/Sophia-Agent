import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import anthropic
import httpx
import openai
import pytest
from mem00_recorded_input_fixture import RecordedInputFixture
from pydantic import ValidationError

from deerflow.sophia.memory_governance.model_dispatch import FinalModelAttempt, FinalModelDispatchAuthority, snapshot_model_request
from deerflow.sophia.memory_governance.model_transport import FinalModelAsyncTransport, FinalModelTransport
from deerflow.sophia.memory_governance.source_input_provenance import observe_recorded_source
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable


@pytest.fixture
def anyio_backend():
    return "asyncio"


def recorded_model_context(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-model-transport-" * 3)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-only-synthetic")
    source_store = RecordedInputFixture()
    thread = str(uuid4())
    session, action = source_store.record("owner", thread, "SYNTHETIC USER")
    witness = observe_recorded_source(owner_id="owner", session_id=session, thread_id=thread, action=action, store=source_store)
    return {"thread": thread, "source": witness}


@pytest.fixture
def context(monkeypatch):
    return recorded_model_context(monkeypatch)


def request(content="SYNTHETIC USER", model="existing-model"):
    return httpx.Request("POST", "https://api.anthropic.com/v1/messages", json={"model": model, "messages": [{"role": "user", "content": content}]}, headers={"anthropic-version": "2023-06-01", "x-api-key": "synthetic-key"})


def attempt(context, wire):
    snapshot = snapshot_model_request(wire)
    return FinalModelAttempt.model_validate(
        {
            "schema": "mem00.model-attempt.v4",
            "attempt_id": str(uuid4()),
            "run_id": str(uuid4()),
            "thread_id": context["thread"],
            "scope": "life",
            "contract_epoch": 1,
            **snapshot.__dict__,
            "source_witness": context["source"].model_dump(mode="json", by_alias=True),
            "builder_binding": None, "completion_binding": None,
            "source_dependencies": [context["source"].model_dump(mode="json", by_alias=True)],
            "prior_admission_id": str(uuid4()),
            "authorized_manifest": [],
            "catalog_generation": 1,
            "revocation_epoch": 0,
            "provider": "mem0",
            "environment": "synthetic",
            "provider_project": "existing-project",
            "provider_namespace": "synthetic-namespace",
        }
    )


class PermitStore:
    def __init__(self):
        self.calls = []
        self.failure = None
        self.mutation = lambda: None
        self.receipt_patch = {}

    def authorize_model_dispatch(self, *, p_user_id, p_attempt):
        self.calls.append(p_attempt)
        if self.failure:
            raise self.failure
        now = datetime.now(UTC)
        value = {key: p_attempt[key] for key in ("attempt_id", "run_id", "thread_id", "prior_admission_id", "payload_ref", "endpoint_ref", "model_ref", "catalog_generation", "revocation_epoch", "authorized_manifest", "source_dependencies")}
        self.mutation()
        return {
            "schema": "mem00.model-dispatch.v4",
            "owner_id": p_user_id,
            **value,
            "event_id": str(uuid4()),
            "prompt_admission_id": str(uuid4()),
            "memory_clear_epoch": (p_attempt["source_witness"] or p_attempt["builder_binding"] or p_attempt["completion_binding"])["memory_clear_epoch"],
            "source_event_id": p_attempt["source_witness"]["event_id"] if p_attempt["source_witness"] else None,
            "builder_binding_id": p_attempt["builder_binding"]["binding_event_id"] if p_attempt["builder_binding"] else None,
            "completion_binding_id": p_attempt["completion_binding"]["binding_event_id"] if p_attempt["completion_binding"] else None,
            "accepted_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=5)).isoformat(),
            "single_use": True,
            "dispatch_observed": False,
            **self.receipt_patch,
        }


def test_payload_snapshot_binds_exact_wire_body_and_route_without_plaintext(context):
    first = snapshot_model_request(request())
    assert first != snapshot_model_request(request("SYNTHETIC CHANGED"))
    assert first != snapshot_model_request(request(model="different-model"))
    changed = request()
    changed.headers["anthropic-version"] = "different-version"
    assert first != snapshot_model_request(changed)
    assert "SYNTHETIC" not in repr(first) and "synthetic-key" not in repr(first)


@pytest.mark.parametrize("epoch", [True, 1.0, "1"])
def test_contract_epoch_requires_an_exact_integer(context, epoch):
    value = attempt(context, request()).model_dump(mode="json", by_alias=True)
    with pytest.raises(ValidationError):
        FinalModelAttempt.model_validate({**value, "contract_epoch": epoch})


def test_ordinary_attempt_cannot_rebind_recorded_source_to_another_thread(context):
    value = attempt(context, request()).model_dump(mode="json", by_alias=True)
    with pytest.raises(ValidationError, match="model_source_ancestry_unbound"):
        FinalModelAttempt.model_validate({**value, "thread_id": str(uuid4())})


def test_inspection_cannot_mutate_captured_authority(context):
    store = PermitStore()
    wire = request()
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store)
    inspected = authority.attempt
    inspected.source_witness.owner_id = "other-owner"
    inspected.payload_ref = "hmac-sha256:model-payload:" + "0" * 64
    assert authority.attempt.source_witness.owner_id == "owner"
    assert authority.admit(wire).owner_id == "owner"


def builder_attempt(context, wire):
    value = attempt(context, wire).model_dump(mode="json", by_alias=True)
    child = str(uuid4())
    value.update(
        thread_id=child,
        scope="builder",
        source_witness=None,
        builder_binding={
            "schema": "mem00.builder-source-run.v1",
            "binding_event_id": str(uuid4()),
            "handoff_event_id": str(uuid4()),
            "owner_id": "owner",
            "parent_thread_id": context["thread"],
            "parent_run_id": str(uuid4()),
            "child_thread_id": child,
            "child_run_id": value["run_id"],
            "payload_ref": "hmac-sha256:checkpoint-state:" + "a" * 64,
            "source_dependencies": value["source_dependencies"],
            "memory_clear_epoch": context["source"].memory_clear_epoch,
            "initial_memory_manifest": [],
            "accepted_at": datetime.now(UTC).isoformat(),
            "historical_result_only": True,
        },
    )
    return FinalModelAttempt.model_validate(value)


def completion_attempt(context, wire):
    child = builder_attempt(context, wire).builder_binding
    value = attempt(context, wire).model_dump(mode="json", by_alias=True)
    child_manifest = [{"memory_id": str(uuid4()), "content_revision": 1, "memory_governance_revision": 1}]
    child.initial_memory_manifest = []
    request = {
        "schema": "mem00.completion-source-request.v1", "contract_epoch": 1,
        "parent_thread_id": context["thread"], "completion_run_id": value["run_id"],
        "trigger_ref": "hmac-sha256:completion-trigger:" + "a" * 64,
        "parent_checkpoint_ref": "hmac-sha256:checkpoint-state:" + "b" * 64,
        "parent_checkpoint_run_ref": "hmac-sha256:run:" + "c" * 64,
        "child_checkpoint_ref": "hmac-sha256:checkpoint-state:" + "d" * 64,
        "child_binding": child.model_dump(mode="json", by_alias=True),
        "parent_source_dependencies": value["source_dependencies"], "source_dependencies": value["source_dependencies"],
        "parent_memory_manifest": [], "child_memory_manifest": child_manifest, "initial_memory_manifest": child_manifest,
        "prior_admission_id": str(uuid4()), "scope": "life", "catalog_generation": 1, "revocation_epoch": 0,
    }
    value.update(source_witness=None, authorized_manifest=child_manifest, completion_binding={
        "schema": "mem00.completion-source-run.v1", "binding_event_id": str(uuid4()), "owner_id": "owner",
        "completion_run_id": value["run_id"], "request": request, "memory_clear_epoch": child.memory_clear_epoch,
        "accepted_at": datetime.now(UTC).isoformat(), "historical_result_only": True,
    })
    return FinalModelAttempt.model_validate(value)


def test_completion_final_permit_is_exact_and_one_use(context):
    wire, store = request(), PermitStore()
    bound = completion_attempt(context, wire)
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=bound, store=store)
    receipt = authority.admit(wire)
    assert receipt.completion_binding_id == bound.completion_binding.binding_event_id
    assert receipt.source_event_id is None and receipt.builder_binding_id is None
    assert receipt.run_id == bound.completion_binding.completion_run_id
    assert receipt.authorized_manifest == bound.authorized_manifest
    with pytest.raises(MemoryGovernanceUnavailable):
        authority.admit(wire)


@pytest.mark.parametrize("fault", ["absent", "source", "builder", "run", "thread", "scope", "sources", "manifest", "old_protocol"])
def test_completion_attempt_rejects_substitution(context, fault):
    value = completion_attempt(context, request()).model_dump(mode="json", by_alias=True)
    patches = {
        "absent": {"completion_binding": None},
        "source": {"source_witness": context["source"].model_dump(mode="json", by_alias=True)},
        "builder": {"builder_binding": value["completion_binding"]["request"]["child_binding"]},
        "run": {"run_id": str(uuid4())}, "thread": {"thread_id": str(uuid4())}, "scope": {"scope": "builder"},
        "sources": {"source_dependencies": [{**value["source_dependencies"][0], "source_version": str(uuid4())}]},
        "manifest": {"authorized_manifest": []}, "old_protocol": {"schema": "mem00.model-attempt.v3"},
    }
    with pytest.raises((ValidationError, MemoryGovernanceUnavailable)):
        FinalModelAttempt.model_validate({**value, **patches[fault]})


@pytest.mark.parametrize("fault", ["owner", "run", "binding", "missing", "source", "child", "clear", "manifest", "expired"])
def test_completion_receipt_substitution_never_reaches_network(context, fault):
    wire, store = request(), PermitStore()
    bound = completion_attempt(context, wire)
    store.receipt_patch = {
        "owner": {"owner_id": "other"}, "run": {"run_id": str(uuid4())},
        "binding": {"completion_binding_id": str(uuid4())}, "missing": {"completion_binding_id": None},
        "source": {"source_event_id": context["source"].event_id},
        "child": {"builder_binding_id": bound.completion_binding.request.child_binding.binding_event_id},
        "clear": {"memory_clear_epoch": bound.completion_binding.memory_clear_epoch + 1},
        "manifest": {"authorized_manifest": []},
        "expired": {"expires_at": (datetime.now(UTC) - timedelta(seconds=1)).isoformat()},
    }[fault]
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=bound, store=store)
    sent = []
    transport = FinalModelTransport(delegate=httpx.MockTransport(lambda req: sent.append(req) or httpx.Response(200)), authority_factory=lambda req: authority)
    with pytest.raises(MemoryGovernanceUnavailable):
        transport.handle_request(wire)
    assert sent == []
    with pytest.raises(MemoryGovernanceUnavailable):
        authority.admit(wire)


def test_builder_authority_joins_child_binding_and_never_relabels_parent_as_input(context):
    wire = request()
    store = PermitStore()
    bound = builder_attempt(context, wire)
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=bound, store=store)
    receipt = authority.admit(wire)
    assert receipt.builder_binding_id == bound.builder_binding.binding_event_id
    assert receipt.source_event_id is None and authority.attempt.source_witness is None
    assert receipt.thread_id == bound.thread_id != context["thread"]


@pytest.mark.parametrize("fault", ["no_binding", "both", "run", "thread", "scope", "source", "manifest", "old_protocol"])
def test_builder_attempt_requires_exact_disjoint_authority(context, fault):
    value = builder_attempt(context, request()).model_dump(mode="json", by_alias=True)
    if fault == "no_binding":
        value["builder_binding"] = None
    elif fault == "both":
        value["source_witness"] = context["source"].model_dump(mode="json", by_alias=True)
    elif fault == "run":
        value["run_id"] = str(uuid4())
    elif fault == "thread":
        value["thread_id"] = context["thread"]
    elif fault == "scope":
        value["scope"] = "life"
    elif fault == "source":
        value["source_dependencies"] = [{**value["source_dependencies"][0], "source_version": str(uuid4())}]
    elif fault == "manifest":
        value["builder_binding"]["initial_memory_manifest"] = [{"memory_id": str(uuid4()), "content_revision": 1, "memory_governance_revision": 1}]
    else:
        value["schema"] = "mem00.model-attempt.v2"
    with pytest.raises((ValidationError, MemoryGovernanceUnavailable)):
        FinalModelAttempt.model_validate(value)


@pytest.mark.parametrize("fault", ["owner", "binding", "source", "clear", "thread", "missing"])
def test_builder_receipt_substitution_cannot_authorize_network(context, fault):
    wire = request()
    store = PermitStore()
    store.receipt_patch = {
        "owner": {"owner_id": "other"},
        "binding": {"builder_binding_id": str(uuid4())},
        "source": {"source_event_id": context["source"].event_id},
        "clear": {"memory_clear_epoch": 1},
        "thread": {"thread_id": context["thread"]},
        "missing": {"builder_binding_id": None},
    }[fault]
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=builder_attempt(context, wire), store=store)
    with pytest.raises(MemoryGovernanceUnavailable):
        authority.admit(wire)
    with pytest.raises(MemoryGovernanceUnavailable):
        authority.admit(wire)


@pytest.mark.parametrize("kind", ["outage", "payload_before", "payload_during", "wrong_receipt", "expired", "replay"])
def test_uncertainty_changed_payload_receipt_expiry_and_reuse_never_dispatch(context, kind):
    wire = request()
    store = PermitStore()
    authority = FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store)
    if kind == "outage":
        store.failure = RuntimeError("SYNTHETIC LOST DATABASE REPLY")
    if kind == "payload_before":
        wire.headers["anthropic-version"] = "changed"
    if kind == "payload_during":
        store.mutation = lambda: wire.headers.update({"anthropic-version": "changed"})
    if kind == "wrong_receipt":
        store.receipt_patch = {"owner_id": "other-owner"}
    if kind == "expired":
        store.receipt_patch = {"accepted_at": (datetime.now(UTC) - timedelta(seconds=6)).isoformat(), "expires_at": (datetime.now(UTC) - timedelta(seconds=1)).isoformat()}
    if kind == "replay":
        authority.admit(wire)
    sent = []
    transport = FinalModelTransport(delegate=httpx.MockTransport(lambda req: sent.append(req) or httpx.Response(200)), authority_factory=lambda req: authority)
    with pytest.raises(MemoryGovernanceUnavailable):
        transport.handle_request(wire)
    assert sent == []
    with pytest.raises(MemoryGovernanceUnavailable):
        authority.admit(request())


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_installed_sdk_retry_crosses_transport_with_a_new_exact_attempt(context, provider):
    store = PermitStore()
    bodies = []

    def network(wire):
        bodies.append(json.loads(wire.content))
        assert len(store.calls) == len(bodies)
        if len(bodies) == 1:
            return httpx.Response(500, json={"error": {"type": "api_error", "message": "synthetic failure"}}, headers={"retry-after-ms": "1"})
        if provider == "anthropic":
            return httpx.Response(
                200,
                json={
                    "id": "msg_synthetic",
                    "type": "message",
                    "role": "assistant",
                    "model": "existing-model",
                    "content": [{"type": "text", "text": "SYNTHETIC RESPONSE"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
            )
        return httpx.Response(
            200, json={"id": "chatcmpl_synthetic", "object": "chat.completion", "created": 1, "model": "existing-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": "SYNTHETIC RESPONSE"}, "finish_reason": "stop"}]}
        )

    with httpx.Client(transport=FinalModelTransport(delegate=httpx.MockTransport(network), authority_factory=lambda wire: FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store))) as http:
        if provider == "anthropic":
            with anthropic.Anthropic(api_key="synthetic", http_client=http, max_retries=1) as client:
                client.messages.create(model="existing-model", max_tokens=10, messages=[{"role": "user", "content": "SYNTHETIC USER"}])
        else:
            with openai.OpenAI(api_key="synthetic", http_client=http, max_retries=1) as client:
                client.chat.completions.create(model="existing-model", messages=[{"role": "user", "content": "SYNTHETIC USER"}])
    assert len(bodies) == 2 and len({item["attempt_id"] for item in store.calls}) == 2
    assert store.calls[0]["payload_ref"] == store.calls[1]["payload_ref"]
    assert "SYNTHETIC USER" not in json.dumps(store.calls)


@pytest.mark.anyio
async def test_installed_async_sdk_crosses_same_exact_gate(context):
    store = PermitStore()
    seen = []

    async def network(wire):
        seen.append(wire)
        assert len(store.calls) == 1
        return httpx.Response(
            200,
            json={
                "id": "msg_synthetic",
                "type": "message",
                "role": "assistant",
                "model": "existing-model",
                "content": [{"type": "text", "text": "SYNTHETIC RESPONSE"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    async with httpx.AsyncClient(transport=FinalModelAsyncTransport(delegate=httpx.MockTransport(network), authority_factory=lambda wire: FinalModelDispatchAuthority(owner_id="owner", attempt=attempt(context, wire), store=store))) as http:
        async with anthropic.AsyncAnthropic(api_key="synthetic", http_client=http, max_retries=0) as client:
            await client.messages.create(model="existing-model", max_tokens=10, messages=[{"role": "user", "content": "SYNTHETIC USER"}])
    assert len(seen) == 1
