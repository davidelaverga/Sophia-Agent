"""Compose disposable SQL results through the installed Gateway/HTTP store."""

import json
import os
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ["SOPHIA_MEMORY_REFERENCE_HMAC_SECRET"] = "r" * 32
os.environ["SOPHIA_MEMORY_LANGSMITH_EXPORT"] = "false"

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import sophia
from deerflow.sophia.memory_governance.extraction_service import _manifest_ref
from deerflow.sophia.memory_governance.review import read_review_envelope
from deerflow.sophia.memory_governance.service import CanonicalMemoryService, MemoryProviderContract
from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore
from deerflow.sophia.session_store import SessionMessageRecord, SupabaseSessionStoreConfig, SupabaseSessionTranscriptStore

OWNER = "review-owner"
SESSION = "review-session"
message = SessionMessageRecord(message_id="message-1", session_id=SESSION, thread_id="review-thread",
    role="user", content="SYNTHETIC-SOURCE", sequence=1)
manifest = _manifest_ref(user_id=OWNER, session_id=SESSION, transcript_revision=1, messages=[message])
if "--manifest" in sys.argv:
    print(json.dumps({"manifest": manifest}))
    raise SystemExit(0)

payload = json.load(sys.stdin)
pages = payload["pages"]
by_after = {None: pages[0]}
for previous, following in zip(pages, pages[1:]):
    by_after[previous["next_after_candidate_id"]] = following
requests = []


def transport(request):
    name = request.url.path.rsplit("/", 1)[1]
    if name == "sophia_sessions":
        assert request.url.params["user_id"] == f"eq.{OWNER}" and request.url.params["id"] == f"eq.{SESSION}"
        return httpx.Response(200, json=[{"id": SESSION, "user_id": OWNER, "thread_id": "review-thread",
            "status": "ended", "message_revision": 1, "ended_at": payload["source_snapshot"]["ended_at"]}])
    if name == "sophia_session_messages":
        assert request.url.params["user_id"] == f"eq.{OWNER}" and request.url.params["session_id"] == f"eq.{SESSION}"
        assert request.url.params["order"] == "id.asc" and request.url.params["limit"] == "200"
        return httpx.Response(200, json=[] if "id" in request.url.params else [{"id": "00000000-0000-4000-8000-000000000001",
            "message_id": message.message_id, "user_id": OWNER, "session_id": SESSION, "thread_id": "review-thread",
            "role": message.role, "content": message.content, "sequence": 1, "final": True, "created_at": "2026-09-09T00:00:00Z", "memory_source_version": payload["source_version"]}])
    if name == "sophia_memory_contract":
        return httpx.Response(200, json=[{key: payload["contract"][key] for key in request.url.params["select"].split(",")}])
    if name == "sophia_memory_user_governance":
        return httpx.Response(200, json=[payload["owner"]])
    if name == "sophia_memory_source_snapshot":
        return httpx.Response(200, json=payload["source_snapshot"])
    assert name == "sophia_memory_review_snapshot"
    body = json.loads(request.content)
    assert body["p_user_id"] == OWNER and body["p_session_id"] == SESSION
    assert body["p_source_manifest_ref"] == manifest
    assert body["p_target_messages"] == [{"message_id": "message-1", "sequence": 1, "source_version": payload["source_version"]}]
    assert body["p_page_size"] == 100
    page = by_after[body["p_after_candidate_id"]]
    assert body["p_snapshot_id"] in {None, page["snapshot_id"]}
    requests.append(body)
    return httpx.Response(200, json=page)


def observed_reader(**kwargs):
    try:
        return read_review_envelope(**kwargs)
    except Exception as exc:
        reason = getattr(exc, "reason", None)
        print("MEM00_GATEWAY_DIAGNOSTIC " + json.dumps({"error_type": type(exc).__name__,
            "reason": reason if isinstance(reason, str) and reason.startswith("memory_") else "instrument_assertion",
            "frames": [[Path(frame.filename).name, frame.lineno] for frame in traceback.extract_tb(exc.__traceback__)]}), file=sys.stderr)
        raise


with httpx.Client(transport=httpx.MockTransport(transport)) as http:
    source = SupabaseSessionTranscriptStore(SupabaseSessionStoreConfig("https://synthetic.invalid", "synthetic"), client=http)
    store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=http)
    service = CanonicalMemoryService(owner_id=OWNER, store=store, provider=MemoryProviderContract("mem0", "synthetic", "existing-project"))
    with patch.object(sophia, "_session_store", source), patch.object(sophia, "_canonical_memory_service", return_value=service), \
        patch("deerflow.sophia.memory_governance.review.read_review_envelope", side_effect=observed_reader), \
        patch.object(sophia, "_memory_flags", return_value=SimpleNamespace(candidate_ledger_read=True)), \
        patch.object(sophia, "_read_session_recap", side_effect=AssertionError("derivative accessed")):
        app = FastAPI()
        app.include_router(sophia.router)
        app.dependency_overrides[sophia.require_authorized_user_scope] = lambda: OWNER
        results = []
        recent_results = []
        cursor = None
        with TestClient(app) as client:
            for _ in pages:
                response = client.get(f"/api/sophia/{OWNER}/sessions/{SESSION}/recap", params={"cursor": cursor} if cursor else {})
                assert response.status_code == 200, "canonical HTTP snapshot unavailable"
                assert response.headers["Cache-Control"] == "no-store"
                result = response.json()
                recent = client.get(f"/api/sophia/{OWNER}/memories/recent", params={"session_id": SESSION,
                    "status": "pending_review", **({"cursor": cursor} if cursor else {})})
                assert recent.status_code == 200 and recent.headers["Cache-Control"] == "no-store"
                recent_result = recent.json()
                assert recent_result["memory_review"] == result["memory_review"]
                assert [(item["id"], item["metadata"]["candidate_revision"]) for item in recent_result["memories"]] == [
                    (item["candidate_id"], item["candidate_revision"]) for item in result["memory_review"]["candidates"]]
                recent_results.append(recent_result)
                results.append(result)
                cursor = result["memory_review"]["next_cursor"]
        assert cursor is None and len(requests) == 2 * len(pages)
        assert sum(len(item["memory_review"]["candidates"]) for item in results) == 1005
        print(json.dumps({"passed": True, "http_pages": results, "recent_pages": recent_results, "request_count": len(requests), "provider_calls": 0}))
