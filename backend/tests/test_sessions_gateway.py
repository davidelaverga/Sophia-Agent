from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.gateway.routers.sessions as sessions_router
from app.gateway.routers.sessions import router
from deerflow.sophia.session_store import SessionRecord, SessionStore

app = FastAPI()
app.include_router(router)
client = TestClient(app)


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
        json={},
    )


def test_start_session_returns_503_when_langgraph_is_unavailable():
    request = httpx.Request("POST", "http://127.0.0.1:2024/threads")

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            side_effect=httpx.RequestError("connection refused", request=request)
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        response = client.post(
            "/api/v1/sessions/start",
            json={"session_type": "chat", "preset_context": "gaming"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "LangGraph is unavailable for session start."


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
            "/api/v1/sessions/session-to-touch/touch?user_id=dev-user&message_preview="
            "i%20need%20to%20prepare%20for%20my%20investor%20meeting%20tomorrow",
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
        "/api/v1/sessions/legacy-touch-session/touch?user_id=real-user-123&message_preview="
        "can%20you%20help%20me%20debug%20this%20websocket%20reconnect%20issue",
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
    assert response.json() == {
        "session_id": "session-with-tool-blocks",
        "thread_id": "thread-with-tool-blocks",
        "messages": [
            {
                "id": "human-1",
                "role": "user",
                "content": "I still miss him.",
                "created_at": None,
            },
            {
                "id": "ai-1",
                "role": "sophia",
                "content": "Two years in, and you're still asking about it.",
                "created_at": None,
            },
        ],
    }


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