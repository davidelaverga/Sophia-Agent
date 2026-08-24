from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.gateway.auth import (
    assert_voice_lab_gateway_route_allowed,
    require_authenticated_user,
    voice_lab_governed_route_keys,
)
from app.gateway.routers import (
    agents,
    bootstrap,
    channels,
    mcp,
    memory,
    skills,
    suggestions,
    uploads,
    voice,
)


@pytest.fixture(autouse=True)
def _lab_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_AUTH_BYPASS", "true")
    monkeypatch.setenv("SOPHIA_USER_ID", "voice-lab-user-1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-user-1")


def _request(method: str, route_path: str, concrete_path: str) -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": concrete_path,
        "raw_path": concrete_path.encode(),
        "query_string": b"",
        "headers": [],
        "scheme": "https",
        "server": ("gateway.test", 443),
        "client": ("127.0.0.1", 12345),
        "route": SimpleNamespace(path=route_path),
    }
    return Request(scope)


def test_governed_inventory_is_exact_and_new_routes_default_to_denied() -> None:
    allowed = voice_lab_governed_route_keys()
    assert ("POST", "/api/sophia/{user_id}/voice/connect") in allowed
    assert ("POST", "/api/v1/sessions/start") in allowed
    assert (
        "GET",
        "/api/sophia/{user_id}/threads/{parent_thread_id}/builder-canvas/snapshot",
    ) in allowed

    forbidden = {
        ("POST", "/api/sophia/{user_id}/voice/dogfood/gemini/browser-session"),
        ("POST", "/api/sophia/{user_id}/voice/dogfood/openai/browser-session"),
        ("POST", "/api/sophia/{user_id}/voice/warmup"),
        ("POST", "/api/sophia/{user_id}/realtime/memories/retrieve"),
        ("POST", "/api/sophia/{user_id}/memories"),
        ("POST", "/api/sophia/{user_id}/tasks/{task_id}/cancel"),
        ("POST", "/api/threads/{thread_id}/uploads"),
        ("POST", "/api/threads/{thread_id}/suggestions"),
        ("PUT", "/api/mcp/config"),
        ("POST", "/api/memory/reload"),
        ("POST", "/api/skills/install"),
        ("POST", "/api/agents"),
        ("POST", "/api/channels/{name}/restart"),
    }
    assert allowed.isdisjoint(forbidden)
    for method, route_path in forbidden:
        concrete = (
            route_path
            .replace("{user_id}", "voice-lab-user-1")
            .replace("{thread_id}", "thread-1")
            .replace("{task_id}", "task-1")
            .replace("{name}", "slack")
        )
        with pytest.raises(HTTPException) as exc:
            assert_voice_lab_gateway_route_allowed(
                _request(method, route_path, concrete),
                "voice-lab-user-1",
            )
        assert exc.value.status_code == 403


def test_lab_dogfood_start_is_denied_before_voice_proxy_or_provider_allocation() -> None:
    app = FastAPI()
    app.include_router(voice.router)
    with patch(
        "app.gateway.routers.voice._proxy_voice_dogfood_json",
        new_callable=AsyncMock,
    ) as proxy:
        response = TestClient(app).post(
            "/api/sophia/voice-lab-user-1/voice/dogfood/gemini/browser-session",
            json={"session_id": "must-not-allocate"},
        )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "voice_lab_ordinary_product_route_forbidden"
    proxy.assert_not_awaited()


def test_lab_upload_is_denied_before_thread_lookup_or_body_materialization() -> None:
    app = FastAPI()
    app.include_router(uploads.router)
    with patch("app.gateway.routers.uploads._get_ownership_store") as store:
        response = TestClient(app).post(
            "/api/threads/thread-1/uploads",
            files={"files": ("secret.txt", b"must-not-write", "text/plain")},
        )
    assert response.status_code == 403
    store.assert_not_called()


def test_lab_suggestion_is_denied_before_model_factory_allocation() -> None:
    app = FastAPI()
    app.include_router(suggestions.router)
    with patch("app.gateway.routers.suggestions.create_chat_model") as model_factory:
        response = TestClient(app).post(
            "/api/threads/thread-1/suggestions",
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
    assert response.status_code == 403
    model_factory.assert_not_called()


def test_ordinary_principal_retains_legacy_dogfood_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_USER_ID", "ordinary-user-1")
    app = FastAPI()
    app.include_router(voice.router)
    with patch(
        "app.gateway.routers.voice._proxy_voice_dogfood_json",
        new_callable=AsyncMock,
        return_value={"session_id": "ordinary-session", "client_secret": "ephemeral"},
    ) as proxy:
        response = TestClient(app).post(
            "/api/sophia/ordinary-user-1/voice/dogfood/gemini/browser-session",
            json={},
        )
    assert response.status_code == 201
    assert response.json()["session_id"] == "ordinary-session"
    proxy.assert_awaited_once()


def test_sensitive_global_router_inventory_requires_authentication() -> None:
    for protected_router in (
        memory.router,
        agents.router,
        mcp.router,
        skills.router,
        channels.router,
        suggestions.router,
        bootstrap.router,
    ):
        for route in protected_router.routes:
            dependency_calls = {
                dependency.call for dependency in route.dependant.dependencies
            }
            assert require_authenticated_user in dependency_calls, (
                route.path,
                sorted(route.methods or ()),
            )


def test_sensitive_global_reads_reject_unauthenticated_before_data_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    app = FastAPI()
    for protected_router in (
        memory.router,
        agents.router,
        mcp.router,
        skills.router,
        channels.router,
        bootstrap.router,
    ):
        app.include_router(protected_router)

    with (
        patch("app.gateway.routers.memory.get_memory_data") as memory_read,
        patch("app.gateway.routers.agents.list_custom_agents") as agent_read,
        patch("app.gateway.routers.mcp.get_extensions_config") as mcp_read,
        patch("app.gateway.routers.skills.load_skills") as skill_read,
        patch("app.channels.service.get_channel_service") as channel_read,
    ):
        client = TestClient(app)
        for path in (
            "/api/memory",
            "/api/agents",
            "/api/user-profile",
            "/api/mcp/config",
            "/api/skills",
            "/api/channels/",
            "/api/v1/bootstrap/opener",
        ):
            assert client.get(path).status_code == 401, path

    memory_read.assert_not_called()
    agent_read.assert_not_called()
    mcp_read.assert_not_called()
    skill_read.assert_not_called()
    channel_read.assert_not_called()


def test_ordinary_authenticated_global_read_contract_is_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOPHIA_USER_ID", "ordinary-user-1")
    app = FastAPI()
    app.include_router(memory.router)
    with patch(
        "app.gateway.routers.memory.get_memory_data",
        return_value={"version": "1.0", "facts": []},
    ) as memory_read:
        response = TestClient(app).get("/api/memory")

    assert response.status_code == 200
    assert response.json()["version"] == "1.0"
    memory_read.assert_called_once_with()
