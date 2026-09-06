"""Explicit End must persist even after inactivity already extracted the range."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest

from deerflow.sophia.memory_governance.extraction_service import MemoryExtractionService
from deerflow.sophia.memory_governance.models import MemoryContract
from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict, SupabaseMemoryGovernanceStore
from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord


@pytest.mark.parametrize("database_status", ["active", "resumable", "ended"])
def test_finalize_uses_database_status_after_real_session_mapping(database_status):
    from deerflow.sophia.session_store import SupabaseSessionStoreConfig, SupabaseSessionTranscriptStore

    row = {"id": "session-1", "thread_id": "thread-1", "user_id": "owner-1", "status": database_status, "message_revision": 7, "memory_processed_until_sequence": 2}
    sessions = SupabaseSessionTranscriptStore(SupabaseSessionStoreConfig(url="https://example.invalid", service_role_key="test"))
    record = sessions._record_from_session_row(row)

    def respond(request):
        # Reproduce PostgREST's exact equality, not a mock unconditional success.
        matches = request.url.params["status"] == f"eq.{database_status}"
        return httpx.Response(200, json=[{"id": "session-1", "status": "ended", "ended_at": "2026-09-06T16:32:00+00:00"}] if matches else [])

    store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="test", client=httpx.Client(transport=httpx.MockTransport(respond)))
    store.finalize_processed_session(session=record, ended_at="2026-09-06T16:32:00+00:00")


def _setup(monkeypatch, *, processed=2, messages=2):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "m" * 32)
    record = SessionRecord(session_id="session-1", thread_id="thread-1", user_id="owner-1", status="resumable", message_revision=7, memory_processed_until_sequence=processed)
    sessions = MagicMock()
    sessions.get.return_value = record
    sessions.list_messages.return_value = [SessionMessageRecord(message_id=f"m-{i}", session_id="session-1", thread_id="thread-1", role="user", content="synthetic fact", sequence=i) for i in range(1, messages + 1)]
    governance = MagicMock()
    governance.get_contract.return_value = MemoryContract(contract_epoch=1, schema_version="mem00.v1", mode="enforced", updated_at=datetime.now(UTC))
    service = MemoryExtractionService(governance_store=governance, session_store=sessions, lease_owner="worker-1", service_name="test")
    return service, sessions, governance


def test_already_processed_range_uses_revision_guarded_end_without_new_extraction(monkeypatch):
    service, sessions, governance = _setup(monkeypatch)
    assert service.finalize_and_enqueue_session(user_id="owner-1", session_id="session-1", ended_at="2026-09-06T16:32:00+00:00") is None
    governance.finalize_processed_session.assert_called_once_with(session=sessions.get.return_value, ended_at="2026-09-06T16:32:00+00:00")
    governance.finalize_and_enqueue_extraction.assert_not_called()


def test_empty_session_can_end_without_inventing_extraction(monkeypatch):
    service, _, governance = _setup(monkeypatch, processed=0, messages=0)
    assert service.finalize_and_enqueue_session(user_id="owner-1", session_id="session-1", ended_at="2026-09-06T16:32:00+00:00") is None
    governance.finalize_processed_session.assert_called_once()
    governance.finalize_and_enqueue_extraction.assert_not_called()


def test_missing_session_cannot_report_success(monkeypatch):
    service, sessions, governance = _setup(monkeypatch)
    sessions.get.return_value = None
    with pytest.raises(MemoryGovernanceConflict):
        service.finalize_and_enqueue_session(user_id="owner-1", session_id="session-1", ended_at="2026-09-06T16:32:00+00:00")
    governance.finalize_processed_session.assert_not_called()


def test_foreign_snapshot_cannot_finalize(monkeypatch):
    service, sessions, governance = _setup(monkeypatch)
    sessions.get.return_value = sessions.get.return_value.model_copy(update={"user_id": "other-owner"})
    with pytest.raises(MemoryGovernanceConflict):
        service.finalize_and_enqueue_session(user_id="owner-1", session_id="session-1", ended_at="2026-09-06T16:32:00+00:00")
    governance.finalize_processed_session.assert_not_called()


def test_concurrent_snapshot_change_does_not_emit_end_receipt(monkeypatch):
    service, _, governance = _setup(monkeypatch)
    governance.finalize_processed_session.side_effect = MemoryGovernanceConflict("revision_changed")
    event = MagicMock()
    monkeypatch.setattr("deerflow.sophia.memory_governance.extraction_service.emit_memory_event", event)
    with pytest.raises(MemoryGovernanceConflict):
        service.finalize_and_enqueue_session(user_id="owner-1", session_id="session-1", ended_at="2026-09-06T16:32:00+00:00")
    event.assert_not_called()


@pytest.mark.parametrize("existing_recap", [None, {"session_id": "session-1", "thread_id": "thread-1", "turn_count": 2, "ended_at": "2026-09-06T16:30:00+00:00", "recap_artifacts": {}}])
def test_actual_product_route_finalizes_processed_range_even_after_failed_recap_write(monkeypatch, existing_recap):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.gateway.auth import require_authorized_user_scope
    from app.gateway.routers import sophia

    _, sessions, governance = _setup(monkeypatch)
    monkeypatch.setattr(sophia, "_session_store", sessions)
    monkeypatch.setattr(sophia, "_read_session_recap", lambda *_: existing_recap)
    monkeypatch.setattr(sophia, "_write_session_recap", MagicMock())
    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner", lambda _: SimpleNamespace(candidate_ledger_write=True))
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", lambda: governance)
    app = FastAPI()
    app.include_router(sophia.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "owner-1"
    response = TestClient(app).post("/api/sophia/owner-1/end-session", json={"session_id": "session-1", "thread_id": "thread-1"})
    assert response.status_code == 202
    assert response.json()["status"] == "no_new_messages"
    governance.finalize_processed_session.assert_called_once()
    governance.finalize_and_enqueue_extraction.assert_not_called()
    sessions.update.assert_not_called()


@pytest.mark.parametrize("rows", [[], [{"id": "wrong-session", "status": "ended", "ended_at": "2026-09-06T16:32:00+00:00"}]])
def test_compare_and_set_miss_or_wrong_receipt_fails_closed(rows):
    store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="test", client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=rows))))
    record = SessionRecord(session_id="session-1", thread_id="thread-1", user_id="owner-1", status="resumable", message_revision=7, memory_processed_until_sequence=2)
    with pytest.raises(MemoryGovernanceConflict):
        store.finalize_processed_session(session=record, ended_at="2026-09-06T16:32:00+00:00")


def test_compare_and_set_filters_owner_thread_revision_watermark_and_status():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=[{"id": "session-1", "status": "ended", "ended_at": "2026-09-06T16:32:00+00:00"}])

    store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="test", client=httpx.Client(transport=httpx.MockTransport(respond)))
    record = SessionRecord(session_id="session-1", thread_id="thread-1", user_id="owner-1", status="resumable", message_revision=7, memory_processed_until_sequence=2)
    store.finalize_processed_session(session=record, ended_at="2026-09-06T16:32:00+00:00")
    assert requests[0].method == "PATCH"
    assert dict(requests[0].url.params) == {
        "id": "eq.session-1",
        "user_id": "eq.owner-1",
        "thread_id": "eq.thread-1",
        "message_revision": "eq.7",
        "memory_processed_until_sequence": "eq.2",
        "status": "eq.resumable",
        "select": "id,status,ended_at",
    }


def test_gateway_accepts_confirmed_no_new_range_without_duplicate_work(monkeypatch):
    from app.gateway.routers import sophia

    monkeypatch.setattr("deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner", lambda _: SimpleNamespace(candidate_ledger_write=True))
    monkeypatch.setattr("deerflow.sophia.memory_governance.store.configured_memory_store", MagicMock())
    monkeypatch.setattr("deerflow.sophia.memory_governance.refs.keyed_ref", lambda *_: "hmac-test")
    extraction = MagicMock()
    extraction.finalize_and_enqueue_session.return_value = None
    monkeypatch.setattr("deerflow.sophia.memory_governance.extraction_service.MemoryExtractionService", lambda **_: extraction)
    offline = MagicMock()
    monkeypatch.setattr("deerflow.sophia.offline_pipeline.run_offline_pipeline", offline)
    sophia._queue_offline_pipeline("owner-1", "session-1", "thread-1", {}, "2026-09-06T16:32:00+00:00")
    offline.assert_not_called()
