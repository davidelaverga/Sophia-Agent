"""Strict actual service/HTTP route boundaries; SQL is composed separately."""

from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.gateway.routers import memory_source
from deerflow.sophia.memory_governance.source_intake import SourceActionRequest, SourceIntakeService
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

OWNER = "source-intake-test-owner"
SESSION = "10000000-0000-4000-8000-000000000001"
THREAD = "20000000-0000-4000-8000-000000000001"
EVENT = "30000000-0000-4000-8000-000000000001"
SOURCE_VERSION = "40000000-0000-4000-8000-000000000001"
ACTION = dict(thread_id=THREAD, message_id="current-user-message", command_key="stable-action-key", content="SYNTHETIC USER SOURCE", expected_clear_epoch=2)


def receipt(payload):
    return dict(
        schema="mem00.source-action.v1",
        owner_id=payload["p_user_id"],
        session_id=payload["p_session_id"],
        thread_id=payload["p_thread_id"],
        command_key=payload["p_idempotency_key"],
        event_id=EVENT,
        message_id=payload["p_message_id"],
        source_row_id=payload["p_source_row_id"],
        source_version=SOURCE_VERSION,
        sequence=3,
        created_at="2026-09-09T07:00:00+00:00",
        memory_clear_epoch=payload["p_expected_clear_epoch"],
        transcript_revision=5,
        content_ref=payload["p_content_ref"],
        historical_result_only=True,
        idempotent_replay=False,
        status="source_recorded",
        memory_approval="not_granted",
        current_extraction_eligibility="not_verified_in_this_response",
    )


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    value = Mock()
    value.accept_source_action.side_effect = lambda **payload: receipt(payload)
    value.source_boundary.return_value = dict(schema="mem00.source-boundary.v1", owner_id=OWNER, session_id=SESSION, thread_id=THREAD, memory_clear_epoch=2, transcript_revision=4)
    value.source_action_status.return_value = dict(schema="mem00.source-action-status.v1", owner_id=OWNER, command_key=ACTION["command_key"], status="not_found", historical_result_only=True, receipt=None)
    return value


def test_explicit_action_is_owner_bound_no_epoch_refresh_and_no_provider(store):
    service = SourceIntakeService(owner_id=OWNER, store=store)
    action = SourceActionRequest.model_validate(ACTION)
    first = service.accept(session_id=SESSION, action=action)
    second = service.accept(session_id=SESSION, action=action)
    assert first == second
    assert store.accept_source_action.call_args_list[0] == store.accept_source_action.call_args_list[1]
    payload = store.accept_source_action.call_args.kwargs
    assert payload["p_user_id"] == OWNER and payload["p_expected_clear_epoch"] == 2
    assert payload["p_content"] == ACTION["content"]
    assert payload["p_content_ref"].startswith("hmac-sha256:source-action-content:")
    assert payload["p_request_digest"].startswith("hmac-sha256:request:")
    assert ACTION["content"] not in first.model_dump_json()
    store.source_boundary.assert_not_called()
    assert [call[0] for call in store.mock_calls] == ["accept_source_action", "accept_source_action"]


@pytest.mark.parametrize("state", ["governed", "legacy", "unknown", "missing", "wrong-owner", "outage"])
def test_source_profile_requires_positive_current_owner_and_session(client, store, monkeypatch, state):
    from datetime import UTC, datetime

    from app.gateway.routers import sessions
    from deerflow.sophia.memory_governance.models import MemoryContract, OwnerMemoryAuthority
    from deerflow.sophia.session_store import SessionRecord

    store.get_contract.return_value = MemoryContract(contract_epoch=1, schema_version="mem00.v1", mode="enforced", updated_at=datetime.now(UTC))
    store.get_owner_authority.return_value = OwnerMemoryAuthority(user_id="wrong" if state == "wrong-owner" else OWNER,
        authority_state=state if state in {"governed", "legacy", "unknown"} else "governed", authority_epoch=1,
        authority_declared_at=None if state == "missing" else datetime.now(UTC))
    if state == "outage":
        store.get_owner_authority.side_effect = RuntimeError("SYNTHETIC PRIVATE ERROR")
    source_store = Mock()
    source_store.get.return_value = SessionRecord(user_id=OWNER, session_id=SESSION, thread_id=THREAD)
    monkeypatch.setattr(sessions, "_store", source_store)
    response = client.get(f"/api/v1/sessions/{SESSION}/memory-source-profile", params={"thread_id": THREAD})
    assert response.headers["Cache-Control"] == "no-store"
    assert "SYNTHETIC" not in response.text
    if state not in {"governed", "legacy"}:
        assert response.status_code == 503
        store.source_boundary.assert_not_called()
    else:
        assert response.status_code == 200
        assert response.json()["authority"] == state
        assert response.json()["observation_only"] is True
        assert (response.json()["boundary"] is None) == (state == "legacy")
    store.accept_source_action.assert_not_called()


@pytest.mark.parametrize("change", [{"user_id": "wrong"}, {"thread_id": EVENT}, {"metadata": {"synthetic_voice_lab": {}}}])
def test_profile_denies_foreign_or_synthetic_parent(store, change):
    from datetime import UTC, datetime

    from deerflow.sophia.memory_governance.models import MemoryContract, OwnerMemoryAuthority
    from deerflow.sophia.session_store import SessionRecord

    store.get_contract.return_value = MemoryContract(contract_epoch=1, schema_version="mem00.v1", mode="enforced", updated_at=datetime.now(UTC))
    store.get_owner_authority.return_value = OwnerMemoryAuthority(user_id=OWNER, authority_state="legacy", authority_epoch=1, authority_declared_at=datetime.now(UTC))
    sessions = Mock()
    sessions.get.return_value = SessionRecord(user_id=OWNER, session_id=SESSION, thread_id=THREAD).model_copy(update=change)
    with pytest.raises(MemoryGovernanceUnavailable, match="profile_unavailable"):
        SourceIntakeService(owner_id=OWNER, store=store).profile(session_id=SESSION, thread_id=THREAD, session_store=sessions)


@pytest.mark.parametrize("change", [{"expected_clear_epoch": 3}, {"content": "SYNTHETIC CHANGED SOURCE"}, {"message_id": "other-user-message"}, {"thread_id": EVENT}, {"command_key": "different-action-key"}])
def test_every_effect_changing_input_changes_digest(store, change):
    service = SourceIntakeService(owner_id=OWNER, store=store)
    service.accept(session_id=SESSION, action=SourceActionRequest.model_validate(ACTION))
    digest = store.accept_source_action.call_args.kwargs["p_request_digest"]
    service.accept(session_id=SESSION, action=SourceActionRequest.model_validate({**ACTION, **change}))
    assert store.accept_source_action.call_args.kwargs["p_request_digest"] != digest


@pytest.mark.parametrize(
    "change",
    [
        {"owner_id": "wrong-owner"},
        {"session_id": EVENT},
        {"thread_id": EVENT},
        {"command_key": "wrong-action-key"},
        {"message_id": "wrong-message-id"},
        {"source_row_id": EVENT},
        {"source_version": "invalid"},
        {"memory_clear_epoch": 3},
        {"memory_clear_epoch": True},
        {"content_ref": "unkeyed"},
        {"sequence": 0},
        {"transcript_revision": -1},
        {"created_at": "2026-09-09"},
        {"memory_approval": "approved"},
        {"current_extraction_eligibility": "eligible"},
        {"historical_result_only": False},
        {"historical_result_only": 1},
        {"historical_result_only": 1.0},
        {"idempotent_replay": "false"},
        {"content": "SYNTHETIC SECRET"},
    ],
)
def test_malformed_or_wrong_scope_receipt_is_unavailable(store, change):
    store.accept_source_action.side_effect = lambda **payload: {**receipt(payload), **change}
    with pytest.raises(MemoryGovernanceUnavailable, match="memory_source_receipt_invalid"):
        SourceIntakeService(owner_id=OWNER, store=store).accept(session_id=SESSION, action=SourceActionRequest.model_validate(ACTION))


@pytest.mark.parametrize("change", [{"owner_id": "wrong-owner"}, {"session_id": EVENT}, {"thread_id": EVENT}, {"memory_clear_epoch": True}, {"memory_clear_epoch": -1}, {"transcript_revision": "4"}, {"schema": "wrong"}])
def test_boundary_never_supplies_guessed_scope_or_epoch(store, change):
    store.source_boundary.return_value.update(change)
    with pytest.raises(MemoryGovernanceUnavailable):
        SourceIntakeService(owner_id=OWNER, store=store).boundary(session_id=SESSION, thread_id=THREAD)


def test_status_outage_is_not_not_found(store):
    store.source_action_status.side_effect = MemoryGovernanceUnavailable("outage")
    with pytest.raises(MemoryGovernanceUnavailable):
        SourceIntakeService(owner_id=OWNER, store=store).status(command_key=ACTION["command_key"])


@pytest.mark.parametrize("change", [{"historical_result_only": 1}, {"historical_result_only": 1.0}, {"owner_id": "wrong-owner"}, {"command_key": "wrong-command-key"}, {"status": "committed"}])
def test_status_requires_exact_scope_and_complete_historical_receipt(store, change):
    store.source_action_status.return_value.update(change)
    with pytest.raises(MemoryGovernanceUnavailable):
        SourceIntakeService(owner_id=OWNER, store=store).status(command_key=ACTION["command_key"])


def test_actual_http_store_uses_only_fixed_source_rpcs(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    calls = []

    def transport(request):
        import json

        assert request.method == "POST" and request.headers["Authorization"] == "Bearer synthetic"
        calls.append(request.url.path)
        payload = json.loads(request.content)
        assert payload["p_user_id"] == OWNER
        return httpx.Response(200, json=receipt(payload))

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        SourceIntakeService(owner_id=OWNER, store=store).accept(session_id=SESSION, action=SourceActionRequest.model_validate(ACTION))
    assert calls == ["/rest/v1/rpc/sophia_memory_accept_source_action"]


@pytest.fixture
def client(store, monkeypatch):
    monkeypatch.setattr(memory_source, "configured_memory_store", lambda: store)
    app = FastAPI()
    app.include_router(memory_source.router)
    app.dependency_overrides[memory_source.require_authenticated_user] = lambda: OWNER
    with TestClient(app) as value:
        yield value


@pytest.mark.parametrize(
    "change",
    [
        {"expected_clear_epoch": True},
        {"expected_clear_epoch": None},
        {"expected_clear_epoch": -1},
        {"content": "\x00SECRET"},
        {"user_id": "forged-owner"},
        {"role": "assistant"},
        {"memory_source_acceptance_epoch": 99},
        {"message_id": "short"},
    ],
)
def test_bad_source_body_is_content_free_no_store_and_has_no_effect(client, store, change):
    response = client.post(f"/api/v1/sessions/{SESSION}/memory-source-actions", json={**ACTION, **change})
    assert response.status_code == 400
    assert response.headers["Cache-Control"] == "no-store"
    assert "SYNTHETIC" not in response.text and "SECRET" not in response.text
    store.accept_source_action.assert_not_called()


def test_gateway_paths_bind_owner_and_return_only_structural_receipts(client):
    boundary = client.get(f"/api/v1/sessions/{SESSION}/memory-source-boundary", params={"thread_id": THREAD})
    assert boundary.status_code == 200 and boundary.json()["owner_id"] == OWNER
    response = client.post(f"/api/v1/sessions/{SESSION}/memory-source-actions", json=ACTION)
    assert response.status_code == 200 and "SYNTHETIC" not in response.text
    assert response.headers["Cache-Control"] == "no-store"
    missing = client.get(f"/api/v1/sessions/memory-source-actions/{ACTION['command_key']}")
    assert missing.status_code == 200 and missing.json()["status"] == "not_found"


def test_missing_database_function_is_no_store_unavailable_not_fallback(client, store):
    store.accept_source_action.side_effect = MemoryGovernanceUnavailable("SYNTHETIC DATABASE BODY")
    response = client.post(f"/api/v1/sessions/{SESSION}/memory-source-actions", json=ACTION)
    assert response.status_code == 503 and "SYNTHETIC" not in response.text
    assert response.headers["Cache-Control"] == "no-store"


def test_oversized_body_is_rejected_without_source_echo_or_effect(client, store):
    response = client.post(f"/api/v1/sessions/{SESSION}/memory-source-actions", content=b"SYNTHETIC" * 262145, headers={"Content-Type": "application/json"})
    assert response.status_code == 413 and "SYNTHETIC" not in response.text
    assert response.headers["Cache-Control"] == "no-store"
    store.accept_source_action.assert_not_called()


def test_voice_lab_principal_cannot_use_explicit_intake(client, store, monkeypatch):
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", OWNER)
    response = client.post(f"/api/v1/sessions/{SESSION}/memory-source-actions", json=ACTION)
    assert response.status_code == 503
    store.accept_source_action.assert_not_called()


def test_auth_denial_prevents_store_access_and_is_no_store(store, monkeypatch):
    factory = Mock(return_value=store)
    monkeypatch.setattr(memory_source, "configured_memory_store", factory)

    def denied():
        raise HTTPException(401, "Authentication required")

    app = FastAPI()
    app.include_router(memory_source.router)
    app.dependency_overrides[memory_source.require_authenticated_user] = denied
    with TestClient(app) as client:
        response = client.post(f"/api/v1/sessions/{SESSION}/memory-source-actions", json=ACTION)
    assert response.status_code == 401 and response.headers["Cache-Control"] == "no-store"
    factory.assert_not_called()


def test_actual_gateway_mounts_source_endpoints():
    from app.gateway.app import create_app

    routes = {route.path for route in create_app().routes}
    assert "/api/v1/sessions/{session_id}/memory-source-boundary" in routes
    assert "/api/v1/sessions/{session_id}/memory-source-actions" in routes
    assert "/api/v1/sessions/memory-source-actions/{command_key}" in routes
