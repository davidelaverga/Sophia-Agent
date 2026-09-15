"""Canonical recap reader crosses the actual HTTP store without a local recap."""

import json
from unittest.mock import MagicMock
from uuid import uuid4

import httpx
import pytest
from test_mem00_command_status_pilot import declare_memory_owners
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mem00_source_snapshot_fixture import source_snapshot_fixture

from app.gateway.routers import sophia
from deerflow.sophia.memory_governance.review import decode_review_cursor, encode_review_cursor
from deerflow.sophia.memory_governance.service import CanonicalMemoryService, MemoryProviderContract
from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict, SupabaseMemoryGovernanceStore
from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord


@pytest.mark.parametrize("route", ["sessions/review-session/recap", "memories/recent?session_id=review-session&status=pending_review"])
@pytest.mark.parametrize("case", ["complete_zero", "reviewed", "processing", "retry", "failed", "wrong_owner", "source_changed", "snapshot_changed", "partial_target", "outage"])
def test_actual_recap_envelope_is_independent_of_local_file(monkeypatch, declare_memory_owners, case, route):
    owner="review-owner"
    declare_memory_owners({owner:"governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "r"*32)
    source=MagicMock()
    source.get.return_value=SessionRecord(user_id=owner,session_id="review-session",thread_id="review-thread",status="ended",message_revision=1,ended_at="2026-09-09T00:00:00Z")
    version=str(uuid4())
    source.read_memory_source_messages.return_value=[SessionMessageRecord(message_id="message-1",session_id="review-session",thread_id="review-thread",role="user",content="SYNTHETIC_SOURCE_ONLY",sequence=1,memory_source_version=version)]
    source.list_messages.side_effect=AssertionError("unbounded legacy source read")
    monkeypatch.setattr(sophia,"_session_store",source)
    derivative=MagicMock(side_effect=AssertionError("local recap is not memory authority"))
    monkeypatch.setattr(sophia,"_read_session_recap",derivative)
    calls=[]
    def transport(request):
        name=request.url.path.rsplit("/",1)[1];calls.append(name)
        if name=="sophia_memory_contract":
            return httpx.Response(200,json=[{"contract_epoch":1,"schema_version":"mem00.v1","mode":"enforced","updated_at":"2026-09-08T00:00:00Z"}])
        if name=="sophia_memory_user_governance":
            return httpx.Response(200,json=[{"user_id":owner,"authority_state":"governed","authority_epoch":1,"authority_declared_at":"2026-09-08T00:00:00Z"}])
        if name=="sophia_memory_source_snapshot":
            return httpx.Response(200,json=source_snapshot_fixture(source.get.return_value,source.read_memory_source_messages.return_value,epoch=0))
        assert name=="sophia_memory_review_snapshot"
        body=json.loads(request.content)
        assert body["p_user_id"]==owner and body["p_session_id"]=="review-session"
        assert body["p_target_messages"]==[{"message_id":"message-1","sequence":1,"source_version":version}]
        assert "SYNTHETIC_SOURCE_ONLY" not in request.content.decode()
        if case=="outage":return httpx.Response(503,json={"detail":"PRIVATE_DATABASE_ERROR"})
        state={"processing":"processing","retry":"failed_retryable","failed":"failed_terminal","source_changed":"source_changed","snapshot_changed":"snapshot_changed"}.get(case,"complete")
        return httpx.Response(200,json={"schema":"mem00.review.v2","memory_contract_epoch":1,"owner_id":"wrong-owner" if case=="wrong_owner" else owner,
            "session_id":"review-session","thread_id":"review-thread","transcript_revision":1,"source_manifest_ref":body["p_source_manifest_ref"],
            "target_sequence_start":1,"target_sequence_end":1,"finalization":{"kind":"source_target_receipt","status":"ended","ended_at":"2026-09-09T00:00:00Z",
                "event_id":"00000000-0000-4000-8000-000000000001","transcript_revision":1,"source_manifest_ref":body["p_source_manifest_ref"]},
            "snapshot_id":"a"*32,"review_filter":"pending_review","extraction_state":state,
            "source_eligibility":{"memory_clear_epoch":0,"source_snapshot_id":"mem00-source-snapshot-"+"a"*32,
                "visible_message_count":1,"eligible_message_count":1,"before_clear_count":0,"accepted_version_changed_count":0,"acceptance_unproven_count":0},
            "target_message_count":1,"covered_message_count":0 if case in {"processing","retry","failed","partial_target"} else 1,"run_count":1,
            "summary":{"scope":"session_history","produced":2 if case=="reviewed" else 0,"pending":0,"approved":1 if case=="reviewed" else 0,"rejected":1 if case=="reviewed" else 0,"invalidated":0},
            "candidates":[],"next_after_candidate_id":None,"enumeration_complete":True,
            "retryable":state in {"processing","failed_retryable","source_changed","snapshot_changed"},
            "recovery_action":"none"})
    with httpx.Client(transport=httpx.MockTransport(transport)) as http:
        store=SupabaseMemoryGovernanceStore(url="https://synthetic.invalid",service_role_key="synthetic",client=http)
        service=CanonicalMemoryService(owner_id=owner,store=store,provider=MemoryProviderContract("mem0","synthetic","existing-project"))
        monkeypatch.setattr(sophia,"_canonical_memory_service",lambda _:service)
        app=FastAPI();app.include_router(sophia.router)
        app.dependency_overrides[sophia.require_authorized_user_scope]=lambda:owner
        with TestClient(app) as client:
            response=client.get("/api/sophia/review-owner/"+route)
        expected=409 if case in {"source_changed","snapshot_changed"} else 503 if case in {"wrong_owner","partial_target","outage"} else 200
        assert response.status_code==expected
        assert response.headers["Cache-Control"]=="no-store"
        assert "SYNTHETIC_SOURCE_ONLY" not in response.text and "PRIVATE_DATABASE_ERROR" not in response.text
        if expected==200:
            body=response.json()["memory_review"]
            assert body["summary"]["produced"]==(2 if case=="reviewed" else 0)
            assert body["enumeration_complete"] is True  # not extraction completion
            if case=="processing":assert body["extraction_state"]=="processing"
    derivative.assert_not_called()
    assert "sophia_memory_review_snapshot" in calls


def test_review_cursor_binds_owner_session_snapshot_and_position(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET","r"*32)
    after=uuid4();cursor=encode_review_cursor("owner","session","a"*32,after)
    assert decode_review_cursor("owner","session",cursor)==("a"*32,str(after))
    for owner,session,value in [("other","session",cursor),("owner","other",cursor),("owner","session",cursor+"x"),("owner","session","malformed")]:
        with pytest.raises(MemoryGovernanceConflict):decode_review_cursor(owner,session,value)
