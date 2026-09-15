import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from mem00_owner_fixture import declare_memory_owners
from anthropic import Anthropic as HttpAnthropic
from mem00_dispatch_fixture import dispatch_authority, dispatch_receipt

from deerflow.sophia import extraction
from deerflow.sophia.memory_governance.extraction_input import capture_context, extraction_input_ref
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

INPUT = "hmac-sha256:extractor-input:" + "b" * 64


def authority_with(change=None):
    store = Mock()

    def respond(**payload):
        value = dispatch_receipt(payload, session_id="session", thread_id="synthetic-thread")
        return {**value, **(change or {})}

    store.authorize_extraction_dispatch.side_effect = respond
    return dispatch_authority("owner", "session", INPUT, store=store), store


def admit(authority):
    return authority.admit(owner_id="owner", session_id="session", extractor_input_ref=INPUT)


def test_exact_authorization_is_consumed_once_and_is_not_a_transmission_receipt():
    authority, store = authority_with()
    receipt = admit(authority)
    assert receipt.dispatch_observed is False and receipt.sdk_max_retries == 0 and receipt.single_use is True
    with pytest.raises(MemoryGovernanceUnavailable, match="already_consumed"):
        admit(authority)
    assert store.authorize_extraction_dispatch.call_count == 1


def test_lost_sql_response_cannot_reuse_the_attempt_locally():
    authority, store = authority_with()
    store.authorize_extraction_dispatch.side_effect = MemoryGovernanceUnavailable("synthetic response lost")
    with pytest.raises(MemoryGovernanceUnavailable):
        admit(authority)
    with pytest.raises(MemoryGovernanceUnavailable, match="already_consumed"):
        admit(authority)
    assert store.authorize_extraction_dispatch.call_count == 1


@pytest.mark.parametrize(
    "change",
    [
        {"owner_id": "foreign"},
        {"session_id": "foreign"},
        {"thread_id": "foreign"},
        {"attempt_id": "10000000-0000-4000-8000-000000000001"},
        {"lease_token": "10000000-0000-4000-8000-000000000001"},
        {"extraction_run_id": "10000000-0000-4000-8000-000000000001"},
        {"input_manifest_ref": "foreign"},
        {"extractor_input_ref": "foreign"},
        {"single_use": 1},
        {"single_use": False},
        {"sdk_max_retries": True},
        {"sdk_max_retries": 1},
        {"dispatch_observed": 0},
        {"dispatch_observed": True},
        {"memory_clear_epoch": True},
        {"memory_clear_epoch": -1},
        {"accepted_at": "2026-09-09T00:00:00"},
        {"expires_at": "2026-01-01T00:00:00Z"},
        {"expires_at": "2100-01-01T00:00:00Z"},
        {"accepted_at": "2100-01-01T00:00:00Z"},
        {"source_text": "SYNTHETIC LEAK"},
        {"schema": "old-contract"},
    ],
)
def test_malformed_or_wrong_scope_receipt_denies_and_stays_consumed(change):
    authority, store = authority_with(change)
    with pytest.raises(MemoryGovernanceUnavailable, match="receipt_invalid"):
        admit(authority)
    with pytest.raises(MemoryGovernanceUnavailable, match="already_consumed"):
        admit(authority)
    assert store.authorize_extraction_dispatch.call_count == 1


@pytest.mark.parametrize("field,value", [("owner_id", "other"), ("session_id", "other"), ("extractor_input_ref", "changed")])
def test_wrong_call_scope_denied_without_database(field, value):
    authority, store = authority_with()
    arguments = dict(owner_id="owner", session_id="session", extractor_input_ref=INPUT)
    arguments[field] = value
    with pytest.raises(MemoryGovernanceUnavailable, match="scope_invalid"):
        authority.admit(**arguments)
    store.authorize_extraction_dispatch.assert_not_called()


def test_store_uses_only_fixed_dispatch_rpc():
    store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=Mock())
    store._rpc = Mock(return_value={"synthetic": True})
    assert store.authorize_extraction_dispatch(p_user_id="owner") == {"synthetic": True}
    store._rpc.assert_called_once_with("sophia_memory_authorize_extraction_dispatch", {"p_user_id": "owner"})


@pytest.fixture
def sdk_boundary(monkeypatch, declare_memory_owners):
    declare_memory_owners({"owner": "governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "owner")
    monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE", "true")
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "d" * 32)
    monkeypatch.setattr(extraction, "_load_template", lambda: "Extract {transcript}")
    messages = [{"role": "user", "content": "SYNTHETIC SOURCE"}]
    context = capture_context(context_mode="life", session_date="2026-09-09")
    input_ref = extraction_input_ref(owner_id="owner", session_id="session", messages=messages, context=context, model=extraction._PIPELINE_MODEL)
    metadata = {"session_date": context.session_date, "context_mode": context.context_mode, "extractor_input_ref": input_ref}
    client = Mock()
    client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(text="[]")], stop_reason="end_turn")
    constructor = Mock(return_value=client)
    monkeypatch.setattr(extraction.anthropic, "Anthropic", constructor)
    return messages, metadata, client, constructor


def test_actual_sdk_requires_current_admission_after_constructor_and_has_no_hidden_retries(sdk_boundary):
    messages, metadata, client, constructor = sdk_boundary
    store = Mock()
    events = []
    constructor.side_effect = lambda **kwargs: (events.append("construct") or client)
    store.authorize_extraction_dispatch.side_effect = lambda **payload: (events.append("admit") or dispatch_receipt(payload, session_id="session", thread_id="synthetic-thread"))
    client.messages.create.side_effect = lambda **kwargs: (events.append("send") or SimpleNamespace(content=[SimpleNamespace(text="[]")], stop_reason="end_turn"))
    authority = dispatch_authority("owner", "session", metadata["extractor_input_ref"], store=store)
    assert extraction.extract_session_memories("owner", "session", messages, metadata, candidate_only=True, dispatch_authority=authority) == []
    assert events == ["construct", "admit", "send"]
    constructor.assert_called_once_with(max_retries=0)
    assert "lease_token" not in str(client.messages.create.call_args)


def test_clear_or_outage_during_sdk_construction_prevents_send(sdk_boundary, caplog):
    messages, metadata, client, constructor = sdk_boundary
    store = Mock()

    def construct(**kwargs):
        store.authorize_extraction_dispatch.side_effect = MemoryGovernanceUnavailable("synthetic intervening clear")
        return client

    constructor.side_effect = construct
    authority = dispatch_authority("owner", "session", metadata["extractor_input_ref"], store=store)
    with pytest.raises((extraction.MemoryWriteError, MemoryGovernanceUnavailable)):
        extraction.extract_session_memories("owner", "session", messages, metadata, candidate_only=True, dispatch_authority=authority)
    client.messages.create.assert_not_called()
    assert "Anthropic API call failed" not in caplog.text
    assert "Extractor dispatch authority unavailable" in caplog.text
    client.close.assert_called_once()


def test_input_hmac_alone_cannot_authorize_direct_candidate_extraction(sdk_boundary):
    messages, metadata, client, constructor = sdk_boundary
    with pytest.raises(extraction.MemoryWriteError, match="dispatch_authority_required"):
        extraction.extract_session_memories("owner", "session", messages, metadata, candidate_only=True)
    constructor.assert_not_called()
    client.messages.create.assert_not_called()


@pytest.mark.parametrize("outcome", ["success", "503", "transport_failure"])
def test_installed_sdk_serialization_and_no_automatic_retries(sdk_boundary, monkeypatch, outcome):
    messages, metadata, _, _ = sdk_boundary
    requests = []

    def transport(request):
        requests.append(json.loads(request.content))
        if outcome == "503":
            return httpx.Response(503, json={"type": "error", "error": {"type": "overloaded_error", "message": "synthetic unavailable"}})
        if outcome == "transport_failure":
            raise httpx.ConnectError("synthetic connection failure", request=request)
        return httpx.Response(
            200,
            json={
                "id": "msg_synthetic",
                "type": "message",
                "role": "assistant",
                "model": extraction._PIPELINE_MODEL,
                "content": [{"type": "text", "text": "[]"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 2},
            },
        )

    with httpx.Client(transport=httpx.MockTransport(transport)) as http:
        factory = Mock(side_effect=lambda **kwargs: HttpAnthropic(api_key="synthetic-only", http_client=http, **kwargs))
        monkeypatch.setattr(extraction.anthropic, "Anthropic", factory)
        authority = dispatch_authority("owner", "session", metadata["extractor_input_ref"])
        if outcome == "success":
            assert extraction.extract_session_memories("owner", "session", messages, metadata, candidate_only=True, dispatch_authority=authority) == []
        else:
            with pytest.raises(extraction.MemoryWriteError, match="extractor_failed"):
                extraction.extract_session_memories("owner", "session", messages, metadata, candidate_only=True, dispatch_authority=authority)
        factory.assert_called_once_with(max_retries=0)
        assert len(requests) == 1
        assert requests[0] == {"model": extraction._PIPELINE_MODEL, "max_tokens": 4096, "messages": [{"role": "user", "content": "Extract User: SYNTHETIC SOURCE"}]}
        assert http.is_closed
