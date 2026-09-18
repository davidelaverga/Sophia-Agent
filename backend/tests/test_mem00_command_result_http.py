"""Real command routes separate original receipts from exact current display reads."""

import json
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from mem00_pool_fixture import pool_page

from app.gateway.routers import sophia
from deerflow.sophia.memory_governance.service import CanonicalMemoryService, MemoryProviderContract
from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore

MEMORY = "10000000-0000-4000-8000-000000000001"


def logical_receipt():
    return {
        "event_id": "20000000-0000-4000-8000-000000000001",
        "operation_id": "original-operation",
        "event_type": "memory_manual_created",
        "resulting_lifecycle": "active",
        "memory_id": MEMORY,
        "candidate_id": None,
        "content_revision": 1,
        "memory_governance_revision": 1,
        "user_catalog_generation": 1,
        "user_revocation_epoch": 0,
        "idempotent_replay": False,
    }


def current_view(state="active", owner="owner"):
    record = pool_page(0, count=1)["records"][0]
    record.update(state=state, revision=4, memory_governance_revision=6, content="CURRENT_LATER_CANONICAL")
    return {
        "schema": "mem00.current-memory.v1",
        "owner_id": owner,
        "memory_id": MEMORY,
        "status": "available" if state in {"active", "forgotten", "tombstoned"} else state,
        "lifecycle": state if state in {"active", "forgotten", "tombstoned"} else None,
        "content_revision": 4 if state in {"active", "forgotten", "tombstoned"} else None,
        "memory_governance_revision": 6 if state in {"active", "forgotten", "tombstoned"} else None,
        "memory": record if state in {"active", "forgotten"} else None,
        "provider_state_queried": False,
        "current_view_only": True,
    }


@pytest.mark.parametrize("action", ["create", "edit", "forget", "restore", "permanent-delete"])
@pytest.mark.parametrize("state", ["active", "forgotten", "tombstoned", "not_found", "unavailable", "outage", "wrong_owner", "tombstoned_text", "lost_response"])
def test_committed_command_replay_survives_current_state_changes(monkeypatch, declare_memory_owners, action, state):  # noqa: F811 - pytest fixture request
    declare_memory_owners({"owner": "governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "r" * 32)
    applied = {}
    calls = []
    command_name = {"create": "manual_create", "edit": "edit", "forget": "forget", "restore": "restore", "permanent-delete": "tombstone"}[action]
    event_type = {"create": "memory_manual_created", "edit": "memory_edited", "forget": "memory_forgotten", "restore": "memory_restored", "permanent-delete": "memory_tombstoned"}[action]

    def transport(request):
        name = request.url.path.rsplit("/", 1)[1]
        calls.append(name)
        if name == "sophia_memory_contract":
            return httpx.Response(200, json=[{"contract_epoch": 1, "schema_version": "mem00.v1", "mode": "enforced", "updated_at": "2026-09-09T00:00:00Z"}])
        body = json.loads(request.content)
        assert body["p_user_id"] == "owner"
        if name == f"sophia_memory_{command_name}":
            key = body["p_idempotency_key"]
            assert key == "original-command-key"
            replay = key in applied
            if replay:
                assert applied[key] == body["p_request_digest"]
            applied[key] = body["p_request_digest"]
            if state == "lost_response" and not replay:
                return httpx.Response(503, text="SYNTHETIC_LOST_RESPONSE_AFTER_COMMIT")
            receipt = logical_receipt()
            receipt["idempotent_replay"] = replay
            receipt["event_type"] = event_type
            receipt["resulting_lifecycle"] = "forgotten" if action == "forget" else "tombstoned" if action == "permanent-delete" else "active"
            if action == "permanent-delete":
                receipt.update(status="accepted_and_fenced", provider_purge="purge_pending", tombstone_id="30000000-0000-4000-8000-000000000001")
            return httpx.Response(200, json=receipt)
        assert name == "sophia_memory_current_view"
        assert body == {"p_user_id": "owner", "p_memory_id": MEMORY}
        if state == "outage":
            return httpx.Response(503, text="PRIVATE_CURRENT_READ_FAILURE")
        value = current_view(state if state in {"active", "forgotten", "tombstoned", "not_found", "unavailable"} else "active")
        if state == "wrong_owner":
            value["owner_id"] = "different-owner"
        if state == "tombstoned_text":
            value["lifecycle"] = "tombstoned"
        return httpx.Response(200, json=value)

    with httpx.Client(transport=httpx.MockTransport(transport)) as http:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=http)
        store.list_pool = MagicMock(side_effect=AssertionError("post-command Pool lookup"))
        service = CanonicalMemoryService(owner_id="owner", store=store, provider=MemoryProviderContract("mem0", "synthetic", "existing-project"))
        monkeypatch.setattr(sophia, "_canonical_memory_service", lambda _: service)
        app = FastAPI()
        app.include_router(sophia.router)
        app.dependency_overrides[sophia.require_authorized_user_scope] = lambda: "owner"
        body = {"text": "ORIGINAL_SUBMITTED_PRIVATE_TEXT", "idempotency_key": "original-command-key"}
        if action == "edit":
            body.update(expected_content_revision=1, expected_governance_revision=1)
        if action in {"forget", "restore", "permanent-delete"}:
            body = {"idempotency_key": "original-command-key", "expected_governance_revision": 1}
        with TestClient(app) as client:
            for attempt in range(2):
                path = "/api/sophia/owner/memories" + (f"/{MEMORY}" if action == "edit" else f"/{MEMORY}/{action}" if action != "create" else "")
                response = client.request("PUT" if action == "edit" else "POST", path, json=body)
                if state == "lost_response" and attempt == 0:
                    assert response.status_code == 503
                    continue
                assert response.status_code == 200
                assert response.headers["Cache-Control"] == "no-store"
                payload = response.json()
                assert payload["status"] == "committed" and payload["historical_result_only"] is True
                assert payload["receipt"]["content_revision"] == 1
                assert payload["receipt"]["idempotent_replay"] is (attempt == 1)
                assert payload["receipt"]["operation_id"] == "original-operation"
                if action == "permanent-delete":
                    assert payload["privacy_disposition"]["canonical_fence"] == "committed_in_original_receipt"
                    assert payload["privacy_disposition"]["provider_cleanup"] == "not_verified_in_this_response"
                assert "ORIGINAL_SUBMITTED_PRIVATE_TEXT" not in response.text
                assert "PRIVATE_CURRENT_READ_FAILURE" not in response.text
                if state in {"active", "forgotten", "lost_response"} and action != "permanent-delete":
                    assert payload["current_view"]["memory"]["content"] == "CURRENT_LATER_CANONICAL"
                    assert payload["current_view"]["content_revision"] == 4
                else:
                    assert payload["current_view"]["memory"] is None
                    if state in {"outage", "wrong_owner", "tombstoned_text"}:
                        assert payload["current_view"]["status"] == "unavailable"
        assert len(applied) == 1
        store.list_pool.assert_not_called()


@pytest.mark.parametrize(
    "fault", ["owner", "target", "receipt_target", "tombstone_text", "revision", "unavailable_text", "older_content", "older_governance", "delete_missing_disposition", "delete_revived_text", "delete_missing_fence", "false_erasure"]
)
def test_command_result_model_rejects_cross_scope_or_noncurrent_text(fault):
    from pydantic import ValidationError

    from deerflow.sophia.memory_governance.command_result import CanonicalCommandResult

    value = {"schema": "mem00.command-result.v1", "owner_id": "owner", "command_key": "original-command-key", "status": "committed", "historical_result_only": True, "receipt": logical_receipt(), "current_view": current_view()}
    if fault == "owner":
        value["owner_id"] = "wrong-owner"
    if fault == "target":
        value["current_view"]["memory_id"] = "10000000-0000-4000-8000-000000000002"
    if fault == "receipt_target":
        value["receipt"]["memory_id"] = None
    if fault == "tombstone_text":
        value["current_view"]["lifecycle"] = "tombstoned"
    if fault == "revision":
        value["current_view"]["content_revision"] = 2
    if fault == "unavailable_text":
        value["current_view"]["status"] = "unavailable"
    if fault == "older_content":
        value["receipt"]["content_revision"] = 5
    if fault == "older_governance":
        value["receipt"]["memory_governance_revision"] = 7
    if fault.startswith("delete_") or fault == "false_erasure":
        from deerflow.sophia.memory_governance.command_result import DeletionDisposition

        value["receipt"].update(event_type="memory_tombstoned", resulting_lifecycle="tombstoned", status="accepted_and_fenced", tombstone_id="30000000-0000-4000-8000-000000000001")
        value["privacy_disposition"] = DeletionDisposition().model_dump()
        if fault != "delete_revived_text":
            value["current_view"] = current_view("tombstoned")
        if fault == "delete_missing_disposition":
            value["privacy_disposition"] = None
        if fault == "delete_missing_fence":
            value["receipt"]["tombstone_id"] = None
        if fault == "false_erasure":
            value["privacy_disposition"]["provider_cleanup"] = "complete"
    with pytest.raises(ValidationError):
        CanonicalCommandResult.model_validate(value)


@pytest.mark.parametrize("revision", ["content_revision", "memory_governance_revision"])
def test_current_read_older_than_original_receipt_keeps_receipt_but_zero_text(revision):
    from deerflow.sophia.memory_governance.command_result import CurrentMemoryView, command_result
    from deerflow.sophia.memory_governance.models import CommandReceipt

    receipt = logical_receipt()
    receipt[revision] = 10
    store = MagicMock()
    store.current_memory.return_value = CurrentMemoryView.model_validate(current_view())
    result = command_result(owner_id="owner", command_key="original-command-key", receipt=CommandReceipt.model_validate(receipt), store=store)
    assert getattr(result.receipt, revision) == 10
    assert result.current_view.status == "unavailable"
    assert result.current_view.memory is None
