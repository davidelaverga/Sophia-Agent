"""C051: synthetic transcript persistence must not advance the revision behind a 500.

J4 (2026-09-23): every transcript PUT that committed its revisioned CAS then
called ``_store.update(message_count=...)``. The production Supabase store
implements ``update`` as an upsert (``POST ... on_conflict=id``); Postgres
fires the BEFORE INSERT trigger for the proposed row, and
``sophia_voice_lab_cleanup_write_fence`` refuses a synthetic ``sophia_sessions``
INSERT once the obligation has left ``auth_provisional``
(backend/migrations/2026_08_23_voice_lab_cleanup_obligation_indexes.sql ~4058)
with P0001 "synthetic cleanup obligation admission is closed". The PUT
answered 500 after the revision had already advanced, the client kept the old
revision, and the ordinary End then failed the finalization CAS with 409.

The store below models that boundary for an existing synthetic session:
revisioned message writes succeed, the route metadata upsert is refused. The
real trigger behaviour is proved separately on disposable PostgreSQL by
tools/voice_lab_session_upsert_fence_contract.mjs. The session row is seeded
directly (``_record``) for the first three tests; only the last one creates
its session through the signed start route before persist and End.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import app.gateway.routers.sessions as sessions_router
from app.gateway.auth import require_authenticated_user, require_authorized_user_scope
from deerflow.sophia.session_store import FilesystemSessionTranscriptStore, SessionRecord, SessionStoreError

BUILD = "41a9b127af780bbe9d88acf34566a6aaf443e6b0"
SECRET = "capability-secret-at-least-thirty-two-bytes"
USER = "voice-lab-user-1"
RUN = "run-c051-001"
CREATED_AT = datetime.now(UTC).replace(microsecond=0)
PROVIDER_EXPIRES_AT = (CREATED_AT + timedelta(minutes=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
FENCE_ERROR = (
    "Supabase session store request failed status=400 body='{\"code\":\"P0001\",\"details\":null,\"hint\":null,"
    "\"message\":\"synthetic cleanup obligation admission is closed\"}'"
)


def _cleanup_id(test_run_id: str) -> str:
    return str(uuid.UUID(bytes=hashlib.sha256(test_run_id.encode()).digest()[:16], version=4))


def _capability(ops: list[str], jti: str, run: str = RUN) -> str:
    now = int(time.time())
    claims = {
        "v": 1, "iss": "sophia-frontend", "aud": "sophia-voice-gateway", "sub": USER, "principal_id": USER,
        "test_run_id": run, "cleanup_obligation_id": _cleanup_id(run), "scenario_id": "vt00-c051-001",
        "scenario_version": "v1", "synthetic": True, "environment": "production", "retention_hours": 24,
        "provider_expires_at": PROVIDER_EXPIRES_AT, "allowed_ops": ops,
        "expected_deployment": {"frontend": BUILD, "backend": BUILD, "voice": BUILD},
        "iat": now, "nbf": now, "exp": now + 120, "jti": jti, "nonce": f"nonce-{jti}",
    }
    encoded = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=")
    signature = hmac.new(SECRET.encode(), encoded, hashlib.sha256).digest()
    return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def _record() -> SessionRecord:
    from deerflow.sophia.cleanup_fence import assert_cleanup_obligation_open

    retention = (CREATED_AT + timedelta(days=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert_cleanup_obligation_open(_cleanup_id(RUN), retention, PROVIDER_EXPIRES_AT)
    return SessionRecord(
        session_id="sess-c051", thread_id="thread-c051", user_id=USER, status="open", run_id=RUN,
        created_at=CREATED_AT.isoformat(),
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True, "principal_id": USER, "test_run_id": RUN, "cleanup_obligation_id": _cleanup_id(RUN),
                "environment": "production", "scenario_id": "vt00-c051-001", "scenario_version": "v1",
                "retention_hours": 24, "retention_anchor": "session_created_at_provisional",
                "retention_expires_at": retention, "provider_expires_at": PROVIDER_EXPIRES_AT,
            },
            "expected_deployment": {"frontend": BUILD, "backend": BUILD, "voice": BUILD},
            "memory_retrieval_disabled": True, "inactivity_finalization_disabled": True,
            "offline_pipeline_disabled": True, "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True, "ordinary_projects_disabled": True, "shared_spaces_disabled": True,
        },
    )


class AdmissionFencedStore(FilesystemSessionTranscriptStore):
    """Filesystem store with the production metadata-upsert boundary."""

    def __init__(self, root) -> None:
        super().__init__(root)
        self.metadata_upserts = 0

    # Production advances the revision and transcript flag INSIDE the
    # revisioned RPC (sophia_replace_session_messages, a plain UPDATE the fence
    # admits); this filesystem store routes those internal writes through
    # update(), so they pass. What the J4 Gateway traceback shows failing is
    # the ROUTE's separate metadata upsert (sessions.py persist -> update ->
    # upsert_session), which carries these fields.
    _ROUTE_METADATA = frozenset({"message_count", "last_message_preview", "title"})

    def update(self, user_id: str, session_id: str, **updates: object):
        record = self.get(user_id, session_id)
        synthetic = record is not None and isinstance((record.metadata or {}).get("synthetic_voice_lab"), dict)
        if synthetic and set(updates) & self._ROUTE_METADATA:
            self.metadata_upserts += 1
            raise SessionStoreError(FENCE_ERROR)
        return super().update(user_id, session_id, **updates)


MESSAGES = [
    {"id": "c051-user-1", "role": "user", "content": "synthetic first input", "turn_id": "turn-1",
     "provider_event_id": "input-final-1", "source": "voice"},
    {"id": "c051-output-1", "role": "assistant", "content": "synthetic first reply", "turn_id": "turn-1",
     "provider_event_id": "output-final-1", "source": "voice"},
]


@pytest.fixture
def lab(tmp_path, monkeypatch):
    from app.gateway.routers.sophia import internal_router
    from app.gateway.routers.sophia import router as sophia_router
    from deerflow.sophia import cleanup_fence

    cleanup_fence._reset_local_cleanup_fences_for_tests()
    for key, value in {
        "SOPHIA_VOICE_LAB_ENABLED": "true", "SOPHIA_VOICE_LAB_KILL_SWITCH": "false",
        "SOPHIA_VOICE_LAB_TEST_PRINCIPAL": USER, "SOPHIA_VOICE_LAB_ENVIRONMENT": "production",
        "SOPHIA_VOICE_LAB_CAPABILITY_SECRET": SECRET, "SOPHIA_VOICE_LAB_BUILDER_RETENTION_SECONDS": "86400",
        "RENDER_GIT_COMMIT": BUILD,
    }.items():
        monkeypatch.setenv(key, value)
    store = AdmissionFencedStore(tmp_path / "users")
    store.create(_record())
    monkeypatch.setattr(sessions_router, "_store", store)
    app = FastAPI()
    app.include_router(sessions_router.router)
    app.include_router(sophia_router)
    app.include_router(internal_router)

    async def _user(request: Request) -> str:
        return request.query_params.get("user_id") or USER

    app.dependency_overrides[require_authenticated_user] = _user
    app.dependency_overrides[require_authorized_user_scope] = lambda: USER
    with (
        patch("app.gateway.routers.sophia.USERS_DIR", tmp_path),
        patch("app.gateway.routers.sophia._session_store", store),
        patch("app.gateway.routers.sophia._read_session_recap"),
        patch("app.gateway.routers.sophia._persist_end_session_transcript"),
        patch("app.gateway.routers.sophia._write_session_recap"),
        patch("app.gateway.routers.sophia._queue_offline_pipeline"),
        patch("app.gateway.inactivity_watcher.unregister_thread"),
        patch("app.gateway.inactivity_watcher.register_activity"),
    ):
        yield TestClient(app, raise_server_exceptions=False), store


def _persist(client: TestClient, base_revision: int, messages=MESSAGES, *, session_id="sess-c051",
             thread_id="thread-c051", run=RUN):
    return client.put(
        f"/api/v1/sessions/{session_id}/messages?user_id={USER}",
        headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:create"], f"jti-put-{run}-{base_revision}", run)},
        json={"user_id": USER, "thread_id": thread_id, "base_revision": base_revision, "messages": messages},
    )


def test_synthetic_persist_returns_the_committed_revision_and_ordinary_end_finalizes(lab):
    client, store = lab
    persisted = _persist(client, 0)
    # The CAS write committed: the response must say so, never a 500 that
    # leaves the client one revision behind the server.
    assert store.get(USER, "sess-c051").message_revision == 1
    assert persisted.status_code == 200, persisted.text
    body = persisted.json()
    assert body["message_revision"] == 1
    assert body["synthetic_isolated"] is True and body["canonical_persistence"] is True
    assert store.metadata_upserts == 0  # no post-commit synthetic metadata upsert

    assert store.read_exact_session_messages(USER, "sess-c051")

    ended = client.post(
        f"/api/sophia/{USER}/end-session",
        headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:finalize"], "jti-end")},
        json={"session_id": "sess-c051", "thread_id": "thread-c051", "started_at": CREATED_AT.isoformat(),
              "turn_count": 1, "base_revision": body["message_revision"], "messages": MESSAGES},
    )
    assert ended.status_code == 202, ended.text
    finalized = store.get(USER, "sess-c051")
    assert finalized.status == "ended"
    assert finalized.message_count == len(MESSAGES)  # set atomically by finalization, not by the PUT


def test_active_synthetic_end_accepts_canonical_rows_with_duplicate_and_nonfinal(lab):
    client, store = lab
    persisted = _persist(client, 0)
    assert persisted.status_code == 200, persisted.text
    active = store.get(USER, "sess-c051")
    assert active is not None and active.status == "open"
    assert active.message_revision == 1 and active.message_count == 0

    visible = store.list_messages(USER, "sess-c051")
    assert len(visible) == 2
    duplicate = visible[0].model_copy(update={
        "message_id": "c051-user-duplicate", "provider_event_id": "input-final-duplicate",
        "sequence": 3,
    })
    nonfinal = visible[1].model_copy(update={
        "message_id": "c051-output-pending", "provider_event_id": "output-pending",
        "content": "unfinished reply", "final": False, "sequence": 4,
    })
    # Model historical rows in an active transcript. The exact read must
    # validate their shape, then canonicalize without requiring the active
    # session's finalization-only message_count to have been updated.
    store._write_messages(USER, "sess-c051", [*visible, duplicate, nonfinal])

    ended = client.post(
        f"/api/sophia/{USER}/end-session",
        headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:finalize"], "jti-end-duplicate")},
        json={"session_id": "sess-c051", "thread_id": "thread-c051", "started_at": CREATED_AT.isoformat(),
              "turn_count": 1},
    )
    assert ended.status_code == 202, ended.text
    assert ended.json()["canonical_transcript"]["message_count"] == 2
    assert store.get(USER, "sess-c051").message_count == 2


def test_active_synthetic_end_rejects_missing_transcript_rows(lab):
    client, store = lab
    assert _persist(client, 0).status_code == 200
    active = store.get(USER, "sess-c051")
    assert active is not None and active.transcript_available is True
    store._transcript_path(USER, "sess-c051").unlink()

    ended = client.post(
        f"/api/sophia/{USER}/end-session",
        headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:finalize"], "jti-end-missing")},
        json={"session_id": "sess-c051", "thread_id": "thread-c051", "turn_count": 1},
    )
    assert ended.status_code == 503
    assert ended.json()["detail"]["code"] == "voice_lab_canonical_transcript_invalid"
    assert store.get(USER, "sess-c051").status == "open"


def test_a_stale_base_revision_still_conflicts_at_finalization(lab):
    client, _ = lab
    assert _persist(client, 0).status_code == 200
    stale = client.post(
        f"/api/sophia/{USER}/end-session",
        headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:finalize"], "jti-end-stale")},
        json={"session_id": "sess-c051", "thread_id": "thread-c051", "started_at": CREATED_AT.isoformat(),
              "turn_count": 1, "base_revision": 0, "messages": MESSAGES},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "voice_lab_transcript_revision_conflict"


def test_a_rejected_synthetic_write_still_reports_conflict_without_advancing(lab):
    client, store = lab
    assert _persist(client, 0).status_code == 200
    conflict = _persist(client, 0, MESSAGES + [
        {"id": "c051-user-2", "role": "user", "content": "second input", "turn_id": "turn-2",
         "provider_event_id": "input-final-2", "source": "voice"},
    ])
    assert conflict.status_code == 200
    assert conflict.json()["message_revision"] == 1
    assert store.get(USER, "sess-c051").message_revision == 1


def test_signed_start_then_persist_then_end_finalizes_on_the_committed_revision(lab):
    client, store = lab
    run = "run-c051-start"

    async def create_exact_thread(_url: str, *, json: dict[str, object]):
        return httpx.Response(200, request=httpx.Request("POST", "http://127.0.0.1:2024/threads"),
                              json={"thread_id": json["thread_id"]})

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as client_cls:
        langgraph = AsyncMock()
        langgraph.post = AsyncMock(side_effect=create_exact_thread)
        langgraph.__aenter__ = AsyncMock(return_value=langgraph)
        langgraph.__aexit__ = AsyncMock(return_value=False)
        client_cls.return_value = langgraph
        started = client.post(
            "/api/v1/sessions/start",
            headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:create"], "jti-start", run)},
            json={"user_id": USER, "platform": "voice"},
        )
    assert started.status_code == 200, started.text
    session_id, thread_id = started.json()["session_id"], started.json()["thread_id"]

    persisted = _persist(client, 0, session_id=session_id, thread_id=thread_id, run=run)
    assert persisted.status_code == 200, persisted.text
    assert persisted.json()["message_revision"] == 1 == store.get(USER, session_id).message_revision
    assert store.metadata_upserts == 0

    created_at = store.get(USER, session_id).created_at
    ended = client.post(
        f"/api/sophia/{USER}/end-session",
        headers={"X-Sophia-Voice-Lab-Capability": _capability(["session:finalize"], "jti-start-end", run)},
        json={"session_id": session_id, "thread_id": thread_id, "started_at": created_at, "turn_count": 1,
              "base_revision": persisted.json()["message_revision"], "messages": MESSAGES},
    )
    assert ended.status_code == 202, ended.text
    finalized = store.get(USER, session_id)
    assert finalized.status == "ended" and finalized.message_count == len(MESSAGES)
