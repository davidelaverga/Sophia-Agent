import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import app.gateway.routers.sessions as sessions_router
from app.gateway.auth import require_authenticated_user
from app.gateway.routers.sessions import router
from deerflow.sophia.memory_governance.flags import MemoryFeatureFlags
from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord, SessionStore

app = FastAPI()
app.include_router(router)


async def _mock_authenticated_session_user(request: Request) -> str:
    query_user_id = request.query_params.get("user_id")
    if query_user_id:
        return query_user_id
    try:
        body = await request.json()
    except ValueError:
        body = {}
    if isinstance(body, dict) and isinstance(body.get("user_id"), str):
        return body["user_id"]
    return "dev-user"


app.dependency_overrides[require_authenticated_user] = _mock_authenticated_session_user
client = TestClient(app)

VOICE_LAB_BUILD = "41a9b127af780bbe9d88acf34566a6aaf443e6b0"
VOICE_LAB_SECRET = "capability-secret-at-least-thirty-two-bytes"
VOICE_LAB_PROVIDER_EXPIRES_AT = (datetime.now(UTC) + timedelta(minutes=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _cleanup_id(test_run_id: str) -> str:
    return str(uuid.UUID(bytes=hashlib.sha256(test_run_id.encode()).digest()[:16], version=4))


def _session_create_capability(**overrides: object) -> str:
    now = int(time.time())
    claims: dict[str, object] = {
        "v": 1,
        "iss": "sophia-frontend",
        "aud": "sophia-voice-gateway",
        "sub": "voice-lab-user-1",
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-create-001",
        "cleanup_obligation_id": _cleanup_id("run-create-001"),
        "scenario_id": "vt00-create-001",
        "scenario_version": "v1",
        "synthetic": True,
        "environment": "production",
        "retention_hours": 24,
        "provider_expires_at": VOICE_LAB_PROVIDER_EXPIRES_AT,
        "allowed_ops": ["session:create"],
        "expected_deployment": {
            "frontend": VOICE_LAB_BUILD,
            "backend": VOICE_LAB_BUILD,
            "voice": VOICE_LAB_BUILD,
        },
        "iat": now,
        "nbf": now,
        "exp": now + 120,
        "jti": "jti-create-001",
        "nonce": "nonce-create-001",
    }
    claims.update(overrides)
    claims.setdefault("cleanup_obligation_id", _cleanup_id(str(claims["test_run_id"])))
    encoded = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode("utf-8")).rstrip(b"=")
    signature = hmac.new(VOICE_LAB_SECRET.encode(), encoded, hashlib.sha256).digest()
    return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def _enable_voice_lab(monkeypatch, *, kill_switch: str = "false") -> None:
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENABLED", "true")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_KILL_SWITCH", kill_switch)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_ENVIRONMENT", "production")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_CAPABILITY_SECRET", VOICE_LAB_SECRET)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_BUILDER_RETENTION_SECONDS", "86400")
    monkeypatch.setenv("RENDER_GIT_COMMIT", VOICE_LAB_BUILD)


def _synthetic_session_record(
    *,
    session_id: str = "synthetic-session",
    thread_id: str = "synthetic-thread",
    test_run_id: str = "run-create-001",
    status: str = "open",
) -> SessionRecord:
    created_at = datetime.now(UTC)
    return SessionRecord(
        session_id=session_id,
        thread_id=thread_id,
        user_id="voice-lab-user-1",
        status=status,
        run_id=test_run_id,
        created_at=created_at.isoformat(),
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "voice-lab-user-1",
                "test_run_id": test_run_id,
                "cleanup_obligation_id": _cleanup_id(test_run_id),
                "environment": "production",
                "scenario_id": "vt00-create-001",
                "scenario_version": "v1",
                "retention_hours": 24,
                "provider_expires_at": VOICE_LAB_PROVIDER_EXPIRES_AT,
                "retention_anchor": "session_created_at_provisional",
                "retention_expires_at": (created_at + timedelta(days=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            },
            "expected_deployment": {
                "frontend": VOICE_LAB_BUILD,
                "backend": VOICE_LAB_BUILD,
                "voice": VOICE_LAB_BUILD,
            },
            "memory_retrieval_disabled": True,
            "inactivity_finalization_disabled": True,
            "offline_pipeline_disabled": True,
            "memory_learning_disabled": True,
            "ordinary_analytics_disabled": True,
            "ordinary_projects_disabled": True,
            "shared_spaces_disabled": True,
        },
    )


@pytest.fixture(autouse=True)
def isolated_session_store(tmp_path, monkeypatch):
    store = SessionStore(tmp_path / "users")
    monkeypatch.setattr(sessions_router, "_store", store)
    return store


def test_start_session_creates_a_real_langgraph_thread(monkeypatch):
    monkeypatch.delenv("SOPHIA_LANGGRAPH_BASE_URL", raising=False)
    monkeypatch.delenv("SOPHIA_BACKEND_BASE_URL", raising=False)

    request = httpx.Request("POST", "http://127.0.0.1:2024/threads")
    mock_response = httpx.Response(200, request=request, json={"thread_id": "thread-live-123"})

    with (
        patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls,
        patch("app.gateway.inactivity_watcher.register_activity") as mock_register_activity,
    ):
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        response = client.post(
            "/api/v1/sessions/start",
            json={"session_type": "chat", "preset_context": "gaming"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["thread_id"] == "thread-live-123"
    assert payload["session_type"] == "chat"
    assert payload["preset_context"] == "gaming"
    mock_register_activity.assert_called_once()
    mock_client.post.assert_awaited_once_with(
        "http://127.0.0.1:2024/threads",
        json={"metadata": {"graph_id": "sophia_companion"}},
    )


def test_start_session_returns_503_when_langgraph_is_unavailable():
    request = httpx.Request("POST", "http://127.0.0.1:2024/threads")

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.RequestError("connection refused", request=request))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        response = client.post(
            "/api/v1/sessions/start",
            json={"session_type": "chat", "preset_context": "gaming"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "LangGraph is unavailable for session start."


def test_synthetic_session_create_rejects_missing_capability_before_langgraph_or_store(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch)
    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        response = client.post(
            "/api/v1/sessions/start",
            json={"user_id": "voice-lab-user-1", "platform": "voice"},
        )

    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_lab_capability_missing"}
    mock_client_cls.assert_not_called()
    assert isolated_session_store.list_open("voice-lab-user-1") == []


def test_synthetic_session_create_is_blocked_by_kill_switch_before_langgraph(
    monkeypatch,
):
    _enable_voice_lab(monkeypatch, kill_switch="true")
    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        response = client.post(
            "/api/v1/sessions/start",
            headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability()},
            json={"user_id": "voice-lab-user-1", "platform": "voice"},
        )

    assert response.status_code == 403
    assert response.json()["detail"] == {"code": "voice_lab_kill_switch_active"}
    mock_client_cls.assert_not_called()


def test_synthetic_session_create_tags_thread_and_record_without_idle_watcher(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch)

    async def create_exact_thread(_url: str, *, json: dict[str, object]):
        request = httpx.Request("POST", "http://127.0.0.1:2024/threads")
        return httpx.Response(
            200,
            request=request,
            json={"thread_id": json["thread_id"]},
        )

    with (
        patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls,
        patch("app.gateway.inactivity_watcher.register_activity") as mock_register_activity,
    ):
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=create_exact_thread)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client
        response = client.post(
            "/api/v1/sessions/start",
            headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability()},
            json={"user_id": "voice-lab-user-1", "platform": "voice"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["synthetic_test"] is True
    assert payload["test_run_id"] == "run-create-001"
    assert payload["scenario_id"] == "vt00-create-001"
    mock_register_activity.assert_not_called()
    mock_client.post.assert_awaited_once()
    thread_request = mock_client.post.await_args.kwargs["json"]["metadata"]
    assert thread_request == {
        "graph_id": "sophia_companion",
        "synthetic": True,
        "principal_id": "voice-lab-user-1",
        "test_run_id": "run-create-001",
        "environment": "production",
        "scenario_id": "vt00-create-001",
        "scenario_version": "v1",
        "cleanup_obligation_id": _cleanup_id("run-create-001"),
        "cleanup_admission_id": thread_request["cleanup_admission_id"],
        "retention_hours": 24,
        "provider_expires_at": VOICE_LAB_PROVIDER_EXPIRES_AT,
        "retention_anchor": "session_created_at_provisional",
        "retention_expires_at": thread_request["retention_expires_at"],
    }
    retention = datetime.fromisoformat(thread_request["retention_expires_at"])
    assert timedelta(hours=23, minutes=59) < retention - datetime.now(UTC) <= timedelta(days=1)
    record = isolated_session_store.get("voice-lab-user-1", payload["session_id"])
    assert record is not None
    assert record.run_id == "run-create-001"
    assert record.metadata["memory_retrieval_disabled"] is True
    assert record.metadata["inactivity_finalization_disabled"] is True
    assert record.metadata["offline_pipeline_disabled"] is True


def test_sessions_gateway_rejects_public_requests_before_store_access(
    isolated_session_store,
):
    original_override = app.dependency_overrides.pop(require_authenticated_user)
    try:
        with patch.object(isolated_session_store, "get") as mock_get:
            response = client.get("/api/v1/sessions/synthetic-session?user_id=voice-lab-user-1")
    finally:
        app.dependency_overrides[require_authenticated_user] = original_override

    assert response.status_code == 401
    mock_get.assert_not_called()


def test_sessions_gateway_rejects_authenticated_scope_mismatch_before_store(
    isolated_session_store,
):
    original_override = app.dependency_overrides[require_authenticated_user]
    app.dependency_overrides[require_authenticated_user] = lambda: "ordinary-user"
    try:
        with patch.object(isolated_session_store, "get") as mock_get:
            response = client.get("/api/v1/sessions/synthetic-session?user_id=voice-lab-user-1")
    finally:
        app.dependency_overrides[require_authenticated_user] = original_override

    assert response.status_code == 403
    mock_get.assert_not_called()


def test_synthetic_session_read_requires_capability_before_store(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch)
    isolated_session_store.create(_synthetic_session_record())
    with patch.object(isolated_session_store, "get", wraps=isolated_session_store.get) as mock_get:
        response = client.get("/api/v1/sessions/synthetic-session?user_id=voice-lab-user-1")

    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_lab_capability_missing"}
    mock_get.assert_not_called()


def test_synthetic_late_touch_is_content_free_and_never_reopens_or_registers_watcher(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch)
    isolated_session_store.create(_synthetic_session_record(status="ended"))
    with (
        patch.object(isolated_session_store, "update", wraps=isolated_session_store.update) as mock_update,
        patch("app.gateway.inactivity_watcher.register_activity") as mock_register,
    ):
        response = client.post(
            "/api/v1/sessions/synthetic-session/touch?user_id=voice-lab-user-1&message_preview=private-content",
            headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability()},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ended"
    mock_update.assert_not_called()
    mock_register.assert_not_called()
    record = isolated_session_store.get("voice-lab-user-1", "synthetic-session")
    assert record is not None
    assert record.status == "ended"
    assert record.last_message_preview is None


def test_synthetic_transcript_write_is_canonical_revisioned_and_isolated(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch)
    isolated_session_store.create(_synthetic_session_record())
    response = client.put(
        "/api/v1/sessions/synthetic-session/messages?user_id=voice-lab-user-1",
        headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability()},
        json={
            "user_id": "voice-lab-user-1",
            "thread_id": "synthetic-thread",
            "base_revision": 0,
            "messages": [
                {
                    "id": "synthetic-user-1",
                    "role": "user",
                    "content": "private synthetic transcript",
                    "turn_id": "turn-1",
                    "provider_event_id": "input-final-1",
                    "source": "voice",
                },
                {
                    "id": "synthetic-output-1",
                    "role": "assistant",
                    "content": "private synthetic reply",
                    "turn_id": "turn-1",
                    "provider_event_id": "output-final-1",
                    "source": "voice",
                },
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["synthetic_isolated"] is True
    assert payload["canonical_persistence"] is True
    assert payload["ordinary_consumers_excluded"] is True
    assert payload["message_revision"] == 1
    assert [message["content"] for message in payload["messages"]] == [
        "private synthetic transcript",
        "private synthetic reply",
    ]
    stored = isolated_session_store.list_messages(
        "voice-lab-user-1",
        "synthetic-session",
    )
    assert len(stored) == 2
    assert stored[0].metadata["test_run_id"] == "run-create-001"
    assert stored[0].metadata["scenario_version"] == "v1"
    assert stored[0].metadata["offline_pipeline_excluded"] is True
    assert stored[0].turn_id == "turn-1"

    read = client.get(
        "/api/v1/sessions/synthetic-session/messages?user_id=voice-lab-user-1",
        headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability(allowed_ops=["session:read"])},
    )
    assert read.status_code == 200
    assert read.json()["message_revision"] == 1
    assert read.json()["messages"] == payload["messages"]


def test_cross_run_touch_is_rejected_without_store_or_watcher_mutation(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch)
    isolated_session_store.create(_synthetic_session_record(test_run_id="run-B"))
    with (
        patch.object(isolated_session_store, "update", wraps=isolated_session_store.update) as mock_update,
        patch("app.gateway.inactivity_watcher.register_activity") as mock_register,
    ):
        response = client.post(
            "/api/v1/sessions/synthetic-session/touch?user_id=voice-lab-user-1",
            headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability(test_run_id="run-A")},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "voice_lab_session_binding_mismatch"}
    mock_update.assert_not_called()
    mock_register.assert_not_called()


def test_generic_end_cannot_bypass_synthetic_canonical_finalization(
    monkeypatch,
    isolated_session_store,
):
    _enable_voice_lab(monkeypatch, kill_switch="true")
    isolated_session_store.create(_synthetic_session_record())
    response = client.post(
        "/api/v1/sessions/end",
        headers={"X-Sophia-Voice-Lab-Capability": _session_create_capability(allowed_ops=["session:finalize"])},
        json={"user_id": "voice-lab-user-1", "session_id": "synthetic-session"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "voice_lab_canonical_finalization_required"}
    record = isolated_session_store.get("voice-lab-user-1", "synthetic-session")
    assert record is not None and record.status == "open"


def test_delete_session_removes_persisted_record(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-to-delete",
            thread_id="thread-to-delete",
            user_id="dev-user",
            status="open",
        )
    )

    response = client.delete("/api/v1/sessions/session-to-delete?user_id=dev-user")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "session_id": "session-to-delete"}
    assert isolated_session_store.get("dev-user", "session-to-delete") is None

    open_response = client.get("/api/v1/sessions/open?user_id=dev-user")
    assert open_response.status_code == 200
    assert open_response.json() == {"sessions": [], "count": 0}


def test_delete_all_sessions_removes_all_records_and_unregisters_threads(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-open",
            thread_id="thread-open",
            user_id="dev-user",
            status="open",
            updated_at="2026-04-15T00:01:00+00:00",
        )
    )
    isolated_session_store.create(
        SessionRecord(
            session_id="session-ended",
            thread_id="thread-ended",
            user_id="dev-user",
            status="ended",
            updated_at="2026-04-15T00:02:00+00:00",
        )
    )

    with patch("app.gateway.inactivity_watcher.unregister_thread") as mock_unregister_thread:
        response = client.delete("/api/v1/sessions/bulk?user_id=dev-user")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "deleted_count": 2,
        "session_ids": ["session-ended", "session-open"],
    }
    assert isolated_session_store.get("dev-user", "session-open") is None
    assert isolated_session_store.get("dev-user", "session-ended") is None
    mock_unregister_thread.assert_any_call("thread-open")
    mock_unregister_thread.assert_any_call("thread-ended")
    assert mock_unregister_thread.call_count == 2


def test_delete_all_sessions_falls_back_to_legacy_dev_user_records(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="legacy-session",
            thread_id="legacy-thread",
            user_id="dev-user",
            status="open",
        )
    )

    with patch("app.gateway.inactivity_watcher.unregister_thread") as mock_unregister_thread:
        response = client.delete("/api/v1/sessions/bulk?user_id=real-user-123")

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "deleted_count": 1,
        "session_ids": ["legacy-session"],
    }
    assert isolated_session_store.get("dev-user", "legacy-session") is None
    mock_unregister_thread.assert_called_once_with("legacy-thread")


def test_delete_session_returns_404_for_unknown_session():
    response = client.delete("/api/v1/sessions/missing-session?user_id=dev-user")

    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found."


def test_active_session_returns_most_recent_open_record(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="older-session",
            thread_id="older-thread",
            user_id="dev-user",
            status="open",
            updated_at="2026-04-15T20:00:00+00:00",
        )
    )
    isolated_session_store.create(
        SessionRecord(
            session_id="newer-session",
            thread_id="newer-thread",
            user_id="dev-user",
            status="open",
            preset_type="prepare",
            context_mode="gaming",
            updated_at="2026-04-15T21:00:00+00:00",
        )
    )

    response = client.get("/api/v1/sessions/active?user_id=dev-user")

    assert response.status_code == 200
    assert response.json() == {
        "has_active_session": True,
        "session": {
            "session_id": "newer-session",
            "thread_id": "newer-thread",
            "session_type": "prepare",
            "preset_context": "gaming",
            "status": "open",
            "started_at": response.json()["session"]["started_at"],
            "updated_at": "2026-04-15T21:00:00+00:00",
            "ended_at": None,
            "turn_count": 0,
            "title": None,
            "last_message_preview": None,
            "platform": "text",
            "intention": None,
            "focus_cue": None,
            "checkpointer_available": None,
            "transcript_available": False,
            "active_segment_started_at": None,
            "segment_count": 1,
            "continuation_count": 0,
            "memory_processed_until_sequence": 0,
            "recap_processed_until_sequence": 0,
        },
    }


def test_active_session_returns_empty_payload_when_no_open_sessions():
    response = client.get("/api/v1/sessions/active?user_id=dev-user")

    assert response.status_code == 200
    assert response.json() == {"has_active_session": False, "session": None}


def test_active_session_falls_back_to_legacy_dev_user_records(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="legacy-open-session",
            thread_id="legacy-thread",
            user_id="dev-user",
            status="open",
            updated_at="2026-04-15T22:00:00+00:00",
        )
    )

    response = client.get("/api/v1/sessions/active?user_id=real-user-123")

    assert response.status_code == 200
    assert response.json()["has_active_session"] is True
    assert response.json()["session"]["session_id"] == "legacy-open-session"


def test_touch_session_updates_preview_and_generates_title(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-to-touch",
            thread_id="thread-to-touch",
            user_id="dev-user",
            status="open",
            title=None,
            message_count=0,
        )
    )

    with patch("app.gateway.inactivity_watcher.register_activity") as mock_register_activity:
        response = client.post(
            "/api/v1/sessions/session-to-touch/touch?user_id=dev-user&message_preview=i%20need%20to%20prepare%20for%20my%20investor%20meeting%20tomorrow",
        )

    assert response.status_code == 200
    assert response.json()["session_id"] == "session-to-touch"
    assert response.json()["last_message_preview"] == "i need to prepare for my investor meeting tomorrow"
    assert response.json()["title"] == "Preparing for my investor meeting tomorrow"
    assert response.json()["turn_count"] == 1
    mock_register_activity.assert_called_once_with("thread-to-touch", "dev-user", "session-to-touch", "life")

    record = isolated_session_store.get("dev-user", "session-to-touch")
    assert record is not None
    assert record.message_count == 1
    assert record.last_message_preview == "i need to prepare for my investor meeting tomorrow"
    assert record.title == "Preparing for my investor meeting tomorrow"


def test_end_session_unregisters_thread(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-to-end",
            thread_id="thread-to-end",
            user_id="dev-user",
            status="open",
            created_at="2026-04-15T00:00:00+00:00",
            updated_at="2026-04-15T00:05:00+00:00",
            message_count=3,
        )
    )

    with patch("app.gateway.inactivity_watcher.unregister_thread") as mock_unregister_thread:
        response = client.post(
            "/api/v1/sessions/end",
            json={"session_id": "session-to-end", "user_id": "dev-user", "offer_debrief": False},
        )

    assert response.status_code == 200
    assert response.json()["session_id"] == "session-to-end"
    assert response.json()["turn_count"] == 3
    mock_unregister_thread.assert_called_once_with("thread-to-end")


def test_end_session_uses_atomic_mem00_finalization_for_enabled_owner(
    isolated_session_store,
    monkeypatch,
):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-mem00-end",
            thread_id="thread-mem00-end",
            user_id="mem00-cert-owner",
            status="open",
        )
    )
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "m" * 32)
    extraction = MagicMock()

    def _atomic_finalize(**payload):
        isolated_session_store.end(payload["user_id"], payload["session_id"])
        return object()

    extraction.finalize_and_enqueue_session.side_effect = _atomic_finalize

    with (
        patch(
            "deerflow.sophia.memory_governance.flags.memory_feature_flags_for_owner",
            return_value=MemoryFeatureFlags(candidate_ledger_write=True),
        ),
        patch(
            "deerflow.sophia.memory_governance.extraction_service.MemoryExtractionService",
            return_value=extraction,
        ),
        patch("deerflow.sophia.memory_governance.store.configured_memory_store"),
        patch("app.gateway.inactivity_watcher.unregister_thread") as mock_unregister_thread,
    ):
        response = client.post(
            "/api/v1/sessions/end",
            json={
                "session_id": "session-mem00-end",
                "user_id": "mem00-cert-owner",
                "offer_debrief": False,
            },
        )

    assert response.status_code == 200
    extraction.finalize_and_enqueue_session.assert_called_once()
    call = extraction.finalize_and_enqueue_session.call_args.kwargs
    assert call["user_id"] == "mem00-cert-owner"
    assert call["session_id"] == "session-mem00-end"
    mock_unregister_thread.assert_called_once_with("thread-mem00-end")


def test_update_session_can_pause_and_resume_resumable_sessions(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-to-pause",
            thread_id="thread-to-pause",
            user_id="dev-user",
            status="open",
            context_mode="gaming",
        )
    )

    with patch("app.gateway.inactivity_watcher.unregister_thread") as mock_unregister_thread:
        paused_response = client.patch(
            "/api/v1/sessions/session-to-pause?user_id=dev-user",
            json={"status": "paused"},
        )

    assert paused_response.status_code == 200
    assert paused_response.json()["status"] == "paused"
    mock_unregister_thread.assert_called_once_with("thread-to-pause")

    record = isolated_session_store.get("dev-user", "session-to-pause")
    assert record is not None
    assert record.status == "paused"
    assert record.ended_at is None

    with patch("app.gateway.inactivity_watcher.register_activity") as mock_register_activity:
        resumed_response = client.patch(
            "/api/v1/sessions/session-to-pause?user_id=dev-user",
            json={"status": "open"},
        )

    assert resumed_response.status_code == 200
    assert resumed_response.json()["status"] == "open"
    mock_register_activity.assert_called_once_with(
        "thread-to-pause",
        "dev-user",
        "session-to-pause",
        "gaming",
    )


def test_update_session_can_reopen_ended_sessions_for_continuation(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-ended",
            thread_id="thread-ended",
            user_id="dev-user",
            status="ended",
            ended_at="2026-04-15T00:10:00+00:00",
        )
    )

    response = client.patch(
        "/api/v1/sessions/session-ended?user_id=dev-user",
        json={"status": "open"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "open"
    assert response.json()["thread_id"] == "thread-ended"

    record = isolated_session_store.get("dev-user", "session-ended")
    assert record is not None
    assert record.status == "open"
    assert record.ended_at is None
    assert record.segment_count == 2
    assert record.continuation_count == 1
    assert record.active_segment_started_at is not None


def test_touch_session_resumes_paused_session(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="paused-session",
            thread_id="thread-paused",
            user_id="dev-user",
            status="paused",
            context_mode="work",
            message_count=2,
        )
    )

    with patch("app.gateway.inactivity_watcher.register_activity") as mock_register_activity:
        response = client.post(
            "/api/v1/sessions/paused-session/touch?user_id=dev-user&message_preview=back%20to%20the%20pitch%20deck",
        )

    assert response.status_code == 200
    assert response.json()["status"] == "open"
    assert response.json()["turn_count"] == 3
    mock_register_activity.assert_called_once_with("thread-paused", "dev-user", "paused-session", "work")


def test_touch_session_reopens_ended_session_and_keeps_ids(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="ended-session",
            thread_id="thread-ended",
            user_id="dev-user",
            status="ended",
            context_mode="life",
            ended_at="2026-04-15T00:10:00+00:00",
            message_count=20,
        )
    )

    with patch("app.gateway.inactivity_watcher.register_activity") as mock_register_activity:
        response = client.post(
            "/api/v1/sessions/ended-session/touch?user_id=dev-user&message_preview=continuing%20from%20where%20we%20left%20off",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == "ended-session"
    assert payload["thread_id"] == "thread-ended"
    assert payload["status"] == "open"
    assert payload["turn_count"] == 21
    assert payload["ended_at"] is None
    mock_register_activity.assert_called_once_with("thread-ended", "dev-user", "ended-session", "life")

    record = isolated_session_store.get("dev-user", "ended-session")
    assert record is not None
    assert record.status == "open"
    assert record.segment_count == 2
    assert record.continuation_count == 1
    assert record.active_segment_started_at is not None


def test_touch_session_falls_back_to_legacy_dev_user_records(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="legacy-touch-session",
            thread_id="legacy-thread",
            user_id="dev-user",
            status="open",
            title=None,
            message_count=0,
        )
    )

    response = client.post(
        "/api/v1/sessions/legacy-touch-session/touch?user_id=real-user-123&message_preview=can%20you%20help%20me%20debug%20this%20websocket%20reconnect%20issue",
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Debugging this websocket reconnect issue"

    record = isolated_session_store.get("dev-user", "legacy-touch-session")
    assert record is not None
    assert record.message_count == 1
    assert record.title == "Debugging this websocket reconnect issue"


def test_get_session_messages_strips_tool_use_metadata_from_ai_content(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-with-tool-blocks",
            thread_id="thread-with-tool-blocks",
            user_id="dev-user",
            status="open",
        )
    )

    request = httpx.Request("GET", "http://127.0.0.1:2024/threads/thread-with-tool-blocks/state")
    mock_response = httpx.Response(
        200,
        request=request,
        json={
            "values": {
                "messages": [
                    {
                        "id": "human-1",
                        "type": "human",
                        "content": "I still miss him.",
                    },
                    {
                        "id": "ai-1",
                        "type": "ai",
                        "content": [
                            {
                                "type": "text",
                                "text": "Two years in, and you're still asking about it.",
                            },
                            {
                                "type": "tool_use",
                                "id": "toolu_123",
                                "name": "emit_artifact",
                                "partial_json": '{"tone_estimate":2.0}',
                            },
                        ],
                    },
                    {
                        "id": "ai-2",
                        "type": "ai",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_456",
                                "name": "emit_artifact",
                                "partial_json": '{"tone_estimate":2.5}',
                            }
                        ],
                    },
                ]
            }
        },
    )

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        response = client.get("/api/v1/sessions/session-with-tool-blocks/messages?user_id=dev-user")

    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == "session-with-tool-blocks"
    assert payload["thread_id"] == "thread-with-tool-blocks"
    assert payload["message_revision"] == 1
    assert payload["accepted"] is True
    assert [(message["id"], message["role"], message["content"]) for message in payload["messages"]] == [
        ("human-1", "user", "I still miss him."),
        ("ai-1", "sophia", "Two years in, and you're still asking about it."),
    ]
    assert all(message["source"] == "langgraph_checkpointer" for message in payload["messages"])
    stored_messages = isolated_session_store.list_messages("dev-user", "session-with-tool-blocks")
    assert [message.content for message in stored_messages] == [
        "I still miss him.",
        "Two years in, and you're still asking about it.",
    ]


def test_persist_session_messages_writes_durable_transcript(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-with-transcript",
            thread_id="thread-with-transcript",
            user_id="dev-user",
            status="open",
        )
    )

    response = client.put(
        "/api/v1/sessions/session-with-transcript/messages?user_id=dev-user",
        json={
            "thread_id": "thread-with-transcript",
            "base_revision": 0,
            "messages": [
                {
                    "id": "user-1",
                    "role": "user",
                    "content": "This is a session persistence test.",
                    "created_at": "2026-04-15T00:01:00+00:00",
                    "source": "text",
                },
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": "I am tracking the thread with you.",
                    "created_at": "2026-04-15T00:01:05+00:00",
                    "source": "voice",
                    "approximate": True,
                },
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == "session-with-transcript"
    assert payload["thread_id"] == "thread-with-transcript"
    assert payload["message_revision"] == 1
    assert payload["accepted"] is True
    assert [(message["id"], message["role"], message["content"]) for message in payload["messages"]] == [
        ("user-1", "user", "This is a session persistence test."),
        ("assistant-1", "sophia", "I am tracking the thread with you."),
    ]
    assert payload["messages"][1]["source"] == "voice"
    assert payload["messages"][1]["approximate"] is True

    stored_messages = isolated_session_store.list_messages("dev-user", "session-with-transcript")
    assert len(stored_messages) == 2
    assert stored_messages[1].source == "voice"
    assert stored_messages[1].approximate is True

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        get_response = client.get("/api/v1/sessions/session-with-transcript/messages?user_id=dev-user")

    assert get_response.status_code == 200
    assert get_response.json()["messages"][0]["content"] == "This is a session persistence test."
    mock_client_cls.assert_not_called()


def test_repeated_session_message_snapshots_are_idempotent(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-idempotent",
            thread_id="thread-idempotent",
            user_id="dev-user",
            status="open",
        )
    )
    payload = {
        "thread_id": "thread-idempotent",
        "base_revision": 0,
        "messages": [
            {
                "id": "user-stable",
                "message_id": "user-stable",
                "role": "user",
                "content": "green harbor notebook",
                "created_at": "2026-04-15T00:01:00+00:00",
            },
            {
                "id": "assistant-stable",
                "message_id": "assistant-stable",
                "role": "assistant",
                "content": "I heard green harbor notebook.",
                "created_at": "2026-04-15T00:01:05+00:00",
            },
        ],
    }

    first = client.put("/api/v1/sessions/session-idempotent/messages?user_id=dev-user", json=payload)
    second = client.post(
        "/api/v1/sessions/session-idempotent/messages?user_id=dev-user",
        json={**payload, "base_revision": 1},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert len(isolated_session_store.list_messages("dev-user", "session-idempotent")) == 2
    assert [message["content"] for message in second.json()["messages"]] == [
        "green harbor notebook",
        "I heard green harbor notebook.",
    ]
    record = isolated_session_store.get("dev-user", "session-idempotent")
    assert record is not None
    assert record.message_count == 2


def test_revisionless_snapshot_is_non_authoritative(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-revision-required",
            thread_id="thread-revision-required",
            user_id="dev-user",
            status="open",
        )
    )

    response = client.post(
        "/api/v1/sessions/session-revision-required/messages?user_id=dev-user",
        json={
            "thread_id": "thread-revision-required",
            "messages": [
                {
                    "id": "stale-pagehide",
                    "role": "user",
                    "content": "this revisionless beacon must not win",
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is False
    assert response.json()["conflict"] is True
    assert response.json()["rejection_reason"] == "base_revision_required"
    assert response.json()["message_revision"] == 0
    assert isolated_session_store.list_messages("dev-user", "session-revision-required") == []


def test_multi_tab_stale_pagehide_is_rejected_without_overwriting_newer_snapshot(
    isolated_session_store,
):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-multi-tab",
            thread_id="thread-multi-tab",
            user_id="dev-user",
            status="open",
        )
    )
    newer = client.put(
        "/api/v1/sessions/session-multi-tab/messages?user_id=dev-user",
        json={
            "thread_id": "thread-multi-tab",
            "base_revision": 0,
            "messages": [
                {
                    "id": "newer-message",
                    "role": "user",
                    "content": "accepted in the active tab",
                }
            ],
        },
    )
    stale_pagehide = client.post(
        "/api/v1/sessions/session-multi-tab/messages?user_id=dev-user",
        json={
            "thread_id": "thread-multi-tab",
            "base_revision": 0,
            "messages": [
                {
                    "id": "older-message",
                    "role": "user",
                    "content": "older tab snapshot",
                }
            ],
        },
    )

    assert newer.json()["message_revision"] == 1
    assert stale_pagehide.json()["accepted"] is False
    assert stale_pagehide.json()["rejection_reason"] == "revision_conflict"
    assert stale_pagehide.json()["message_revision"] == 1
    assert [message.message_id for message in isolated_session_store.list_messages("dev-user", "session-multi-tab")] == ["newer-message"]


def test_stale_snapshot_cannot_resurrect_row_deleted_by_newer_revision(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-delete-race",
            thread_id="thread-delete-race",
            user_id="dev-user",
            status="open",
        )
    )
    created = client.put(
        "/api/v1/sessions/session-delete-race/messages?user_id=dev-user",
        json={
            "base_revision": 0,
            "messages": [
                {
                    "id": "deleted-message",
                    "role": "user",
                    "content": "delete me",
                }
            ],
        },
    )
    deleted = client.put(
        "/api/v1/sessions/session-delete-race/messages?user_id=dev-user",
        json={"base_revision": created.json()["message_revision"], "messages": []},
    )
    stale = client.post(
        "/api/v1/sessions/session-delete-race/messages?user_id=dev-user",
        json={
            "base_revision": created.json()["message_revision"],
            "messages": [
                {
                    "id": "deleted-message",
                    "role": "user",
                    "content": "delete me",
                }
            ],
        },
    )

    assert deleted.json()["deleted_count"] == 1
    assert deleted.json()["messages"] == []
    assert stale.json()["accepted"] is False
    assert stale.json()["message_revision"] == deleted.json()["message_revision"]
    assert stale.json()["messages"] == []


def test_session_message_snapshot_replaces_pagehide_and_end_session_duplicates(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-replace",
            thread_id="thread-replace",
            user_id="dev-user",
            status="open",
        )
    )
    isolated_session_store.append_or_upsert_messages(
        "dev-user",
        "session-replace",
        [
            # Simulates an older End Session write that used a different id.
            SessionMessageRecord(
                message_id="end-duplicate",
                session_id="session-replace",
                thread_id="thread-replace",
                role="user",
                content="Can you repeat that?",
                created_at="2026-04-15T00:01:00+00:00",
                sequence=99,
            )
        ],
    )

    response = client.put(
        "/api/v1/sessions/session-replace/messages?user_id=dev-user",
        json={
            "thread_id": "thread-replace",
            "base_revision": 1,
            "messages": [
                {
                    "id": "user-stable",
                    "role": "user",
                    "content": "Can you repeat that?",
                    "created_at": "2026-04-15T00:01:00+00:00",
                },
                {
                    "id": "assistant-stable",
                    "role": "assistant",
                    "content": "Of course. I said I am with you.",
                    "created_at": "2026-04-15T00:01:05+00:00",
                },
            ],
        },
    )

    assert response.status_code == 200
    stored_messages = isolated_session_store.list_messages("dev-user", "session-replace")
    assert [message.message_id for message in stored_messages] == ["user-stable", "assistant-stable"]
    assert [message.sequence for message in stored_messages] == [1, 2]


def test_persist_session_messages_filters_incomplete_assistant_and_counts_visible(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-final-only",
            thread_id="thread-final-only",
            user_id="dev-user",
            status="open",
        )
    )

    response = client.put(
        "/api/v1/sessions/session-final-only/messages?user_id=dev-user",
        json={
            "thread_id": "thread-final-only",
            "base_revision": 0,
            "messages": [
                {
                    "id": "user-1",
                    "role": "user",
                    "content": "Can you repeat that?",
                    "created_at": "2026-04-15T00:01:00+00:00",
                },
                {
                    "id": "assistant-streaming",
                    "role": "assistant",
                    "content": "Of co",
                    "created_at": "2026-04-15T00:01:02+00:00",
                    "final": False,
                    "incomplete": True,
                },
            ],
        },
    )

    assert response.status_code == 200
    assert [(message["id"], message["role"], message["content"]) for message in response.json()["messages"]] == [("user-1", "user", "Can you repeat that?")]
    record = isolated_session_store.get("dev-user", "session-final-only")
    assert record is not None
    assert record.message_count == 1


def test_get_session_messages_returns_deduped_ordered_visible_rows(isolated_session_store):
    isolated_session_store.create(
        SessionRecord(
            session_id="session-deduped-read",
            thread_id="thread-deduped-read",
            user_id="dev-user",
            status="ended",
        )
    )
    isolated_session_store.append_or_upsert_messages(
        "dev-user",
        "session-deduped-read",
        [
            SessionMessageRecord(
                message_id="user-original",
                session_id="session-deduped-read",
                thread_id="thread-deduped-read",
                role="user",
                content="green harbor notebook",
                created_at="2026-04-15T00:01:00+00:00",
                sequence=1,
            ),
            SessionMessageRecord(
                message_id="user-duplicate",
                session_id="session-deduped-read",
                thread_id="thread-deduped-read",
                role="user",
                content="green harbor notebook",
                created_at="2026-04-15T00:01:00+00:00",
                sequence=3,
            ),
            SessionMessageRecord(
                message_id="assistant-1",
                session_id="session-deduped-read",
                thread_id="thread-deduped-read",
                role="assistant",
                content="I wrote that down.",
                created_at="2026-04-15T00:01:05+00:00",
                sequence=3,
            ),
        ],
    )

    response = client.get("/api/v1/sessions/session-deduped-read/messages?user_id=dev-user")

    assert response.status_code == 200
    assert [message["content"] for message in response.json()["messages"]] == [
        "green harbor notebook",
        "I wrote that down.",
    ]
    assert response.json()["message_revision"] == 1
    record = isolated_session_store.get("dev-user", "session-deduped-read")
    assert record is not None
    assert record.message_count == 2


@pytest.mark.parametrize(
    ("message_preview", "expected_title"),
    [
        (
            "i need to prepare for my investor meeting tomorrow",
            "Preparing for my investor meeting tomorrow",
        ),
        (
            "can you help me debug this websocket reconnect issue?",
            "Debugging this websocket reconnect issue",
        ),
        (
            "i need help with pricing my SaaS",
            "Pricing my SaaS",
        ),
        (
            "what's the best way to plan a team offsite",
            "Planning a team offsite",
        ),
    ],
)
def test_build_session_title_uses_topic_style_labels(message_preview, expected_title):
    assert sessions_router._build_session_title(message_preview) == expected_title


def _seed_user_only_transcript(store, session_id: str, thread_id: str) -> None:
    store.create(
        SessionRecord(
            session_id=session_id,
            thread_id=thread_id,
            user_id="dev-user",
            status="open",
        )
    )
    store.append_or_upsert_messages(
        "dev-user",
        session_id,
        [
            SessionMessageRecord(
                message_id="user-only-1",
                session_id=session_id,
                thread_id=thread_id,
                role="user",
                content="Build me a page",
                created_at="2026-06-10T02:42:13+00:00",
                sequence=1,
            ),
        ],
    )


def _langgraph_state_client(mock_response):
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


def test_get_session_messages_user_only_durable_falls_through_to_thread_state(isolated_session_store):
    """A client-flushed transcript with no assistant rows must not shadow the
    final AIMessage in LangGraph state (post-builder wakeup replies are
    produced by a background run the browser never streams)."""
    _seed_user_only_transcript(isolated_session_store, "session-user-only", "thread-user-only")

    request = httpx.Request("GET", "http://127.0.0.1:2024/threads/thread-user-only/state")
    mock_response = httpx.Response(
        200,
        request=request,
        json={
            "values": {
                "messages": [
                    {"id": "human-1", "type": "human", "content": "Build me a page"},
                    {"id": "ai-wakeup", "type": "ai", "content": "Your page is ready — take a look!"},
                ]
            }
        },
    )

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value = _langgraph_state_client(mock_response)
        response = client.get("/api/v1/sessions/session-user-only/messages?user_id=dev-user")

    assert response.status_code == 200
    messages = response.json()["messages"]
    assert [(message["role"], message["content"]) for message in messages] == [
        ("user", "Build me a page"),
        ("sophia", "Your page is ready — take a look!"),
    ]
    stored_roles = [message.role for message in isolated_session_store.list_messages("dev-user", "session-user-only")]
    assert "assistant" in stored_roles


def test_get_history_returns_only_the_transcript_accepted_during_restore_race(
    isolated_session_store,
    monkeypatch,
):
    _seed_user_only_transcript(
        isolated_session_store,
        "session-restore-race",
        "thread-restore-race",
    )
    original_replace = isolated_session_store.replace_messages_revisioned
    raced = False

    def race_restore(user_id, session_id, messages, *, expected_revision):
        nonlocal raced
        if not raced:
            raced = True
            accepted_records = [
                *isolated_session_store.list_messages(user_id, session_id),
                SessionMessageRecord(
                    message_id="accepted-assistant",
                    session_id=session_id,
                    thread_id="thread-restore-race",
                    role="assistant",
                    content="This is the accepted concurrent transcript.",
                    sequence=2,
                ),
            ]
            accepted = original_replace(
                user_id,
                session_id,
                accepted_records,
                expected_revision=expected_revision,
            )
            assert accepted.accepted is True
        return original_replace(
            user_id,
            session_id,
            messages,
            expected_revision=expected_revision,
        )

    monkeypatch.setattr(
        isolated_session_store,
        "replace_messages_revisioned",
        race_restore,
    )
    request = httpx.Request("GET", "http://127.0.0.1:2024/threads/thread-restore-race/state")
    mock_response = httpx.Response(
        200,
        request=request,
        json={
            "values": {
                "messages": [
                    {"id": "human-1", "type": "human", "content": "Build me a page"},
                    {"id": "stale-ai", "type": "ai", "content": "Stale LangGraph projection."},
                ]
            }
        },
    )

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value = _langgraph_state_client(mock_response)
        response = client.get("/api/v1/sessions/session-restore-race/messages?user_id=dev-user")

    assert response.status_code == 200
    assert response.json()["message_revision"] == 2
    assert [message["content"] for message in response.json()["messages"]] == [
        "Build me a page",
        "This is the accepted concurrent transcript.",
    ]


def test_get_session_messages_user_only_durable_kept_when_state_has_no_assistant_text(isolated_session_store):
    """Tool-call-only AI turns yield no visible text — keep the durable view
    rather than replacing it with a state projection that adds nothing."""
    _seed_user_only_transcript(isolated_session_store, "session-toolcall-only", "thread-toolcall-only")

    request = httpx.Request("GET", "http://127.0.0.1:2024/threads/thread-toolcall-only/state")
    mock_response = httpx.Response(
        200,
        request=request,
        json={
            "values": {
                "messages": [
                    {"id": "human-1", "type": "human", "content": "Build me a page"},
                    {
                        "id": "ai-tool-only",
                        "type": "ai",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "toolu_789",
                                "name": "emit_artifact",
                                "partial_json": '{"tone_estimate":2.5}',
                            }
                        ],
                    },
                ]
            }
        },
    )

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value = _langgraph_state_client(mock_response)
        response = client.get("/api/v1/sessions/session-toolcall-only/messages?user_id=dev-user")

    assert response.status_code == 200
    messages = response.json()["messages"]
    assert [(message["role"], message["content"]) for message in messages] == [
        ("user", "Build me a page"),
    ]


def test_get_session_messages_user_only_durable_kept_when_langgraph_unavailable(isolated_session_store):
    """The state fall-through must never make a previously-200 durable read
    start failing when LangGraph is down."""
    _seed_user_only_transcript(isolated_session_store, "session-lg-down", "thread-lg-down")

    request = httpx.Request("GET", "http://127.0.0.1:2024/threads/thread-lg-down/state")

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.RequestError("connection refused", request=request))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        response = client.get("/api/v1/sessions/session-lg-down/messages?user_id=dev-user")

    assert response.status_code == 200
    messages = response.json()["messages"]
    assert [(message["role"], message["content"]) for message in messages] == [
        ("user", "Build me a page"),
    ]
