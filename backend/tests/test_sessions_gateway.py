from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers.sessions import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)


def test_start_session_creates_a_real_langgraph_thread(monkeypatch):
    monkeypatch.delenv("SOPHIA_LANGGRAPH_BASE_URL", raising=False)
    monkeypatch.delenv("SOPHIA_BACKEND_BASE_URL", raising=False)

    request = httpx.Request("POST", "http://127.0.0.1:2024/threads")
    mock_response = httpx.Response(200, request=request, json={"thread_id": "thread-live-123"})

    with patch("app.gateway.routers.sessions.httpx.AsyncClient") as mock_client_cls:
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