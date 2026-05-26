"""Tests for the Sophia gateway API router."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from deerflow.sophia.session_store import SessionRecord, SessionStore

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    """Create a test client with the Sophia router."""
    from app.gateway.auth import require_authorized_user_scope
    from app.gateway.routers.sophia import internal_router, router

    app = FastAPI()
    app.include_router(router)
    app.include_router(internal_router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "test_user"
    return TestClient(app)


@pytest.fixture
def secure_client():
    """Create a test client with the real auth dependency enabled."""
    from app.gateway.routers.sophia import internal_router, router

    app = FastAPI()
    app.include_router(router)
    app.include_router(internal_router)
    return TestClient(app)


@pytest.fixture
def mock_mem0():
    """Mock the Mem0 MemoryClient."""
    with patch("app.gateway.routers.sophia._get_mem0_client") as mock:
        mock_client = MagicMock()
        mock.return_value = mock_client
        yield mock_client


@pytest.fixture(autouse=True)
def mock_review_store():
    with (
        patch("app.gateway.routers.sophia.apply_review_metadata_overlays", side_effect=lambda _user_id, memories: memories) as mock_apply,
        patch("app.gateway.routers.sophia.upsert_review_metadata") as mock_upsert,
        patch("app.gateway.routers.sophia.remove_review_metadata") as mock_remove,
    ):
        yield {
            "apply": mock_apply,
            "upsert": mock_upsert,
            "remove": mock_remove,
        }


# ---------------------------------------------------------------------------
# User ID Validation
# ---------------------------------------------------------------------------

class TestUserIdValidation:
    def test_invalid_user_id_returns_400(self, client):
        resp = client.get("/api/sophia/user;rm -rf/memories/recent")
        assert resp.status_code == 400

    def test_user_id_with_spaces_returns_400(self, client):
        resp = client.get("/api/sophia/user%20with%20spaces/memories/recent")
        assert resp.status_code == 400


class TestUserScopedAuthorization:
    def test_prefers_sophia_auth_backend_url_for_auth_validation(self, monkeypatch):
        from app.gateway.auth import _get_legacy_auth_base_url

        monkeypatch.setenv("BACKEND_API_URL", "http://backend-service:8000")
        monkeypatch.setenv("SOPHIA_AUTH_BACKEND_URL", "http://frontend-auth-bridge:3000")

        assert _get_legacy_auth_base_url() == "http://frontend-auth-bridge:3000"

    def test_missing_bearer_token_returns_401(self, secure_client):
        resp = secure_client.get("/api/sophia/test_user/memories/recent")
        assert resp.status_code == 401

    def test_mismatched_authenticated_user_returns_403(self, secure_client):
        request = httpx.Request("GET", "http://localhost:8000/api/v1/auth/me")
        auth_response = httpx.Response(200, request=request, json={"id": "other_user"})

        with patch("app.gateway.auth.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=auth_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            resp = secure_client.get(
                "/api/sophia/test_user/memories/recent",
                headers={"Authorization": "Bearer test-token"},
            )

        assert resp.status_code == 403

    def test_matching_authenticated_user_allows_request(self, secure_client, mock_mem0):
        mock_mem0.get_all.return_value = []
        request = httpx.Request("GET", "http://localhost:8000/api/v1/auth/me")
        auth_response = httpx.Response(200, request=request, json={"id": "test_user"})

        with patch("app.gateway.auth.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=auth_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = mock_client

            resp = secure_client.get(
                "/api/sophia/test_user/memories/recent",
                headers={"Authorization": "Bearer test-token"},
            )

        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    def test_explicit_backend_bypass_keeps_local_user_scope(self, secure_client, mock_mem0, monkeypatch):
        monkeypatch.setenv("SOPHIA_AUTH_BYPASS", "true")
        monkeypatch.setenv("SOPHIA_USER_ID", "dev-user")
        mock_mem0.get_all.return_value = []

        resp = secure_client.get("/api/sophia/dev-user/memories/recent")

        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    def test_public_frontend_bypass_flags_do_not_enable_backend_bypass(self, secure_client, monkeypatch):
        monkeypatch.setenv("NEXT_PUBLIC_DEV_BYPASS_AUTH", "true")
        monkeypatch.setenv("NEXT_PUBLIC_SOPHIA_USER_ID", "e2e-user")

        resp = secure_client.get("/api/sophia/e2e-user/memories/recent")

        assert resp.status_code == 401


class TestRealtimeContext:
    def test_requires_authorization_when_auth_dependency_is_active(self, secure_client):
        resp = secure_client.post("/api/sophia/test_user/realtime/context", json={})

        assert resp.status_code == 401

    def test_returns_identity_and_handoff_when_available(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        user_dir = tmp_path / "test_user"
        (user_dir / "handoffs").mkdir(parents=True)
        (user_dir / "identity.md").write_text(
            "Name: Luis\nLuis responds well to direct acknowledgments.",
            encoding="utf-8",
        )
        (user_dir / "handoffs" / "latest.md").write_text(
            "Session initiated with Luis. Keep the opener grounded.",
            encoding="utf-8",
        )
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": False,
                "provider_status": "unavailable",
                "provider_reason": "missing_api_key",
            },
        )

        resp = client.post("/api/sophia/test_user/realtime/context", json={"platform": "voice"})

        assert resp.status_code == 200
        data = resp.json()
        assert data["preferred_name"] == "Luis"
        assert "direct acknowledgments" in data["identity_excerpt"]
        assert "Keep the opener grounded" in data["handoff_excerpt"]
        assert data["memories"] == []
        assert data["diagnostics"]["identity_available"] is True
        assert data["diagnostics"]["handoff_available"] is True
        assert data["diagnostics"]["identity_file_status"] == "present"
        assert data["diagnostics"]["handoff_file_status"] == "present"
        assert data["diagnostics"]["preferred_name_source"] == "identity_file"
        assert data["diagnostics"]["preferred_name_conflict"] is False
        assert data["diagnostics"]["mem0_status"] == "missing_api_key"

    def test_realtime_context_promotes_mem0_preferred_name_when_identity_missing(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        calls: list[dict[str, object]] = []
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "_apply_review_metadata_overlays_readonly",
            lambda _user_id, memories: memories,
        )

        def fake_search(**kwargs):  # noqa: ANN202
            calls.append(dict(kwargs))
            query = str(kwargs.get("query", ""))
            if "what the user wants to be called" in query:
                return {
                    "memories": [
                        {
                            "id": "m-name",
                            "content": "Preferred name: Mira. Explicit user statement.",
                            "category": "fact",
                            "score": 0.99,
                        }
                    ],
                    "provider_status": "available",
                    "provider_reason": "sdk_client",
                }
            return {
                "memories": [
                    {
                        "id": "m-other",
                        "content": "User prefers concise context.",
                        "category": "preference",
                        "score": 0.8,
                    }
                ],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            }

        monkeypatch.setattr(context_module, "search_memories_with_diagnostics", fake_search)

        resp = client.post("/api/sophia/test_user/realtime/context", json={"platform": "voice"})

        assert resp.status_code == 200
        data = resp.json()
        assert data["preferred_name"] == "Mira"
        assert data["diagnostics"]["identity_file_status"] == "missing"
        assert data["diagnostics"]["handoff_file_status"] == "missing"
        assert data["diagnostics"]["preferred_name_source"] == "mem0"
        assert data["diagnostics"]["preferred_name_available"] is True
        assert data["diagnostics"]["preferred_name_conflict"] is False
        assert data["diagnostics"]["mem0_preferred_name_status"] == "available"
        assert "Mira" not in json.dumps(data["diagnostics"])
        assert calls[-1]["categories"] == ["fact", "preference"]
        assert calls[-1]["log_content_previews"] is False

    def test_realtime_context_prefers_mem0_correction_over_handoff_inference(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        user_dir = tmp_path / "test_user" / "handoffs"
        user_dir.mkdir(parents=True)
        (user_dir / "latest.md").write_text(
            "Session initiated with Daniel. Keep the opener grounded.",
            encoding="utf-8",
        )
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "_apply_review_metadata_overlays_readonly",
            lambda _user_id, memories: memories,
        )
        monkeypatch.setattr(
            context_module,
            "search_memories_with_diagnostics",
            lambda **kwargs: {
                "memories": [
                    {
                        "id": "m-name",
                        "content": "Preferred name: Mira. Explicit user statement.",
                        "category": "fact",
                        "score": 0.99,
                    }
                ]
                if "what the user wants to be called" in str(kwargs.get("query", ""))
                else [],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )

        resp = client.post("/api/sophia/test_user/realtime/context", json={})

        assert resp.status_code == 200
        data = resp.json()
        assert data["preferred_name"] == "Mira"
        assert data["diagnostics"]["preferred_name_source"] == "mem0"
        assert data["diagnostics"]["preferred_name_conflict"] is True
        assert data["diagnostics"]["handoff_file_status"] == "present"
        assert "Mira" not in json.dumps(data["diagnostics"])
        assert "Daniel" not in json.dumps(data["diagnostics"])

    def test_realtime_context_missing_identity_and_mem0_no_results_does_not_invent_name(
        self,
        client,
        tmp_path,
        monkeypatch,
    ):
        from app.gateway import sophia_realtime_context as context_module

        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "search_memories_with_diagnostics",
            lambda **_kwargs: {
                "memories": [],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )

        resp = client.post("/api/sophia/test_user/realtime/context", json={})

        assert resp.status_code == 200
        data = resp.json()
        assert data["preferred_name"] is None
        assert data["diagnostics"]["preferred_name_source"] == "unavailable"
        assert data["diagnostics"]["preferred_name_available"] is False
        assert data["diagnostics"]["identity_file_status"] == "missing"
        assert data["diagnostics"]["mem0_preferred_name_status"] == "available"

    def test_returns_bounded_mem0_snippets_when_provider_available(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        calls: list[dict[str, object]] = []
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "_apply_review_metadata_overlays_readonly",
            lambda _user_id, memories: memories,
        )

        def fake_search(**kwargs):  # noqa: ANN202
            calls.append(dict(kwargs))
            return {
                "memories": [
                    {"id": "m1", "content": "Luis prefers crisp context.", "category": "preference", "score": 0.9},
                    {"id": "m2", "content": "Luis is preparing a demo.", "category": "commitment", "score": 0.8},
                    {"id": "m3", "content": "This one should be outside the requested limit.", "category": "fact"},
                ],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            }

        monkeypatch.setattr(context_module, "search_memories_with_diagnostics", fake_search)

        resp = client.post(
            "/api/sophia/test_user/realtime/context",
            json={"context_mode": "work", "ritual": "debrief", "limit": 2},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert [memory["id"] for memory in data["memories"]] == ["m1", "m2"]
        assert data["diagnostics"]["mem0_status"] == "available"
        assert data["diagnostics"]["memory_count"] == 2
        assert calls[0]["user_id"] == "test_user"
        assert calls[0]["limit"] == 2
        assert calls[0]["log_content_previews"] is False
        assert calls[0]["raise_on_error"] is True
        assert "ritual_context" in calls[0]["categories"]

    def test_mem0_error_degrades_with_diagnostics(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "search_memories_with_diagnostics",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        resp = client.post("/api/sophia/test_user/realtime/context", json={})

        assert resp.status_code == 200
        data = resp.json()
        assert data["memories"] == []
        assert data["diagnostics"]["mem0_status"] == "error"
        assert data["diagnostics"]["mem0_provider_reason"] == "provider_exception"
        assert data["diagnostics"]["memory_count"] == 0

    def test_limit_is_capped_server_side(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        calls: list[dict[str, object]] = []
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "_apply_review_metadata_overlays_readonly",
            lambda _user_id, memories: memories,
        )

        def fake_search(**kwargs):  # noqa: ANN202
            calls.append(dict(kwargs))
            return {
                "memories": [
                    {"id": f"m{i}", "content": f"Memory {i}", "category": "fact"}
                    for i in range(12)
                ],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            }

        monkeypatch.setattr(context_module, "search_memories_with_diagnostics", fake_search)

        resp = client.post("/api/sophia/test_user/realtime/context", json={"limit": 99})

        assert resp.status_code == 200
        data = resp.json()
        assert calls[0]["limit"] == 10
        assert len(data["memories"]) == 10
        assert data["diagnostics"]["memory_limit"] == 10

    def test_dynamic_memory_retrieve_returns_bounded_success(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        calls: list[dict[str, object]] = []
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "_apply_review_metadata_overlays_readonly",
            lambda _user_id, memories: memories,
        )

        def fake_search(**kwargs):  # noqa: ANN202
            calls.append(dict(kwargs))
            return {
                "memories": [
                    {"id": f"m{i}", "content": f"Memory {i}", "category": "preference"}
                    for i in range(8)
                ],
                "provider_status": "available",
                "provider_reason": "sdk_client",
                "provider_transport": "mem0_sdk",
                "cache_status": "miss",
            }

        monkeypatch.setattr(context_module, "search_memories_with_diagnostics", fake_search)

        resp = client.post(
            "/api/sophia/test_user/realtime/memories/retrieve",
            json={
                "query": "gaming focus cue",
                "context_mode": "gaming",
                "limit": 99,
                "user_id": "model_supplied_user",
                "categories": ["relationship"],
            },
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["schema"] == "sophia_realtime_memory_retrieve_response_v1"
        assert data["status"] == "success"
        assert data["count"] == 5
        assert [memory["rank"] for memory in data["memories"]] == [1, 2, 3, 4, 5]
        assert data["trusted_user_id_source"] == "authenticated_realtime_session"
        assert data["diagnostics"]["dynamic_retrieval_source"] == "gateway"
        assert data["diagnostics"]["raw_memory_text_excluded"] is True
        assert data["diagnostics"]["memory_limit"] == 5
        assert calls[0]["user_id"] == "test_user"
        assert calls[0]["limit"] == 5
        assert "preference" in calls[0]["categories"]
        assert "strategy" in calls[0]["categories"]

    def test_dynamic_memory_retrieve_returns_no_results_when_provider_empty(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "search_memories_with_diagnostics",
            lambda **_kwargs: {
                "memories": [],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )

        resp = client.post(
            "/api/sophia/test_user/realtime/memories/retrieve",
            json={"query": "childhood movie"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["status"] == "no_results"
        assert data["memories"] == []
        assert data["diagnostics"]["provider_status"] == "available"

    def test_dynamic_memory_retrieve_degrades_when_provider_unavailable(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": False,
                "provider_status": "unavailable",
                "provider_reason": "missing_api_key",
            },
        )

        resp = client.post(
            "/api/sophia/test_user/realtime/memories/retrieve",
            json={"query": "what do you remember about gaming"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is False
        assert data["status"] == "unavailable"
        assert data["provider_reason"] == "missing_api_key"
        assert data["diagnostics"]["raw_memory_text_excluded"] is True
        assert resp.headers["content-type"].startswith("application/json")

    def test_dynamic_memory_retrieve_internal_grant_binds_trusted_user(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        calls: list[dict[str, object]] = []
        grant = context_module.create_realtime_memory_retrieval_grant(
            user_id="test_user",
            session_id="gemini-prod-session",
        )
        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "_apply_review_metadata_overlays_readonly",
            lambda _user_id, memories: memories,
        )

        def fake_search(**kwargs):  # noqa: ANN202
            calls.append(dict(kwargs))
            return {
                "memories": [{"id": "m1", "content": "Trusted user memory.", "category": "fact"}],
                "provider_status": "available",
                "provider_reason": "sdk_client",
            }

        monkeypatch.setattr(context_module, "search_memories_with_diagnostics", fake_search)

        resp = client.post(
            "/internal/sophia-realtime/memories/retrieve",
            headers={context_module.REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER: grant.token},
            json={"query": "trusted memory", "user_id": "model_supplied_user"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "success"
        assert data["session_id"] == "gemini-prod-session"
        assert calls[0]["user_id"] == "test_user"

    @pytest.mark.parametrize(
        ("headers", "expected_status", "expected_reason"),
        [
            ({}, "unauthorized", "missing_grant"),
            ({"X-Sophia-Realtime-Memory-Token": "not-a-real-grant"}, "unauthorized", "invalid_grant"),
        ],
    )
    def test_dynamic_memory_retrieve_internal_grant_failures_return_json_envelope(
        self,
        client,
        headers,
        expected_status,
        expected_reason,
    ):
        resp = client.post(
            "/internal/sophia-realtime/memories/retrieve",
            headers=headers,
            json={"query": "trusted memory"},
        )

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        data = resp.json()
        assert data["schema"] == "sophia_realtime_memory_retrieve_response_v1"
        assert data["ok"] is False
        assert data["status"] == expected_status
        assert data["provider_status"] == "unavailable"
        assert data["provider_reason"] == expected_reason
        assert data["memories"] == []
        assert data["count"] == 0
        assert data["diagnostics"]["grant_status"] == expected_reason

    def test_dynamic_memory_retrieve_internal_expired_grant_returns_json_envelope(self, client):
        from app.gateway import sophia_realtime_context as context_module

        grant = context_module.create_realtime_memory_retrieval_grant(
            user_id="test_user",
            session_id="expired-session",
        )
        with context_module._memory_retrieval_grants_lock:
            context_module._memory_retrieval_grants[grant.token] = context_module.RealtimeMemoryRetrievalGrant(
                token=grant.token,
                user_id=grant.user_id,
                session_id=grant.session_id,
                expires_at=0,
            )

        resp = client.post(
            "/internal/sophia-realtime/memories/retrieve",
            headers={context_module.REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER: grant.token},
            json={"query": "trusted memory"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "expired_grant"
        assert data["provider_reason"] == "expired_grant"
        assert data["diagnostics"]["grant_status"] == "expired_grant"

    def test_dynamic_memory_retrieve_internal_validation_error_returns_json_envelope(self, client):
        from app.gateway import sophia_realtime_context as context_module

        grant = context_module.create_realtime_memory_retrieval_grant(
            user_id="test_user",
            session_id="validation-session",
        )

        resp = client.post(
            "/internal/sophia-realtime/memories/retrieve",
            headers={context_module.REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER: grant.token},
            json=["not", "an", "object"],
        )

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        data = resp.json()
        assert data["status"] == "invalid_request"
        assert data["provider_status"] == "error"
        assert data["provider_reason"] == "request_validation_error"
        assert data["memories"] == []

    def test_dynamic_memory_retrieve_public_validation_error_returns_json_envelope(self, client):
        resp = client.post(
            "/api/sophia/test_user/realtime/memories/retrieve",
            json=["not", "an", "object"],
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "invalid_request"
        assert data["provider_reason"] == "request_validation_error"
        assert data["count"] == 0

    def test_dynamic_memory_retrieve_search_error_returns_error_without_500(self, client, tmp_path, monkeypatch):
        from app.gateway import sophia_realtime_context as context_module

        monkeypatch.setattr(context_module, "USERS_DIR", tmp_path)
        monkeypatch.setattr(
            context_module,
            "memory_provider_status",
            lambda: {
                "available": True,
                "provider_status": "available",
                "provider_reason": "sdk_client",
            },
        )
        monkeypatch.setattr(
            context_module,
            "search_memories_with_diagnostics",
            lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        resp = client.post(
            "/api/sophia/test_user/realtime/memories/retrieve",
            json={"query": "stored context"},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "error"
        assert data["provider_status"] == "error"
        assert data["diagnostics"]["raw_memory_text_excluded"] is True


# ---------------------------------------------------------------------------
# Memory List
# ---------------------------------------------------------------------------

class TestListMemories:
    def test_returns_memories(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Likes pizza", "categories": ["food"], "created_at": "2026-01-01"},
            {"id": "m2", "memory": "Works at startup", "categories": ["professional_details"]},
        ]
        resp = client.get("/api/sophia/test_user/memories/recent")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 2
        assert data["memories"][0]["id"] == "m1"
        assert data["memories"][0]["content"] == "Likes pizza"

    def test_empty_list(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/memories/recent")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0
        assert resp.json()["memories"] == []

    def test_with_status_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Needs review", "metadata": None},
            {"id": "m2", "memory": "Already approved", "metadata": None},
        ]
        mock_mem0.get.side_effect = [
            {"id": "m1", "memory": "Needs review", "metadata": {"status": "pending_review"}},
            {"id": "m2", "memory": "Already approved", "metadata": {"status": "approved"}},
        ]
        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["memories"][0]["id"] == "m1"
        mock_mem0.get_all.assert_called_once_with(filters={"user_id": "test_user"})
        assert mock_mem0.get.call_count == 2

    def test_status_filter_uses_local_review_metadata_overlay(self, client, mock_mem0, mock_review_store):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Needs review", "metadata": None},
        ]
        mock_mem0.get.return_value = {"id": "m1", "memory": "Needs review", "metadata": None}
        mock_review_store["apply"].side_effect = None
        mock_review_store["apply"].return_value = [
            {
                "id": "m1",
                "memory": "Needs review",
                "metadata": {"status": "pending_review", "category": "fact"},
                "category": "fact",
            }
        ]

        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")

        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["memories"][0]["metadata"]["status"] == "pending_review"

    def test_local_review_overlay_propagates_session_id_in_recent_memory_payload(self, client, mock_mem0, mock_review_store):
        mock_mem0.get_all.return_value = []
        mock_review_store["apply"].side_effect = None
        mock_review_store["apply"].return_value = [
            {
                "id": "local:latest",
                "memory": "Fresh local overlay memory",
                "session_id": "sess-latest",
                "metadata": {"status": "pending_review", "category": "lesson"},
                "category": "lesson",
                "updated_at": "2026-04-17T15:12:23.465604+00:00",
            }
        ]

        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")

        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["memories"][0]["session_id"] == "sess-latest"
        assert data["memories"][0]["updated_at"] == "2026-04-17T15:12:23.465604+00:00"

    def test_status_filter_skips_detail_hydration_when_overlay_supplies_status(self, client, mock_mem0, mock_review_store):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Needs review", "metadata": None},
        ]
        mock_review_store["apply"].side_effect = None
        mock_review_store["apply"].return_value = [
            {"id": "m1", "memory": "Needs review", "metadata": {"status": "pending_review"}},
        ]

        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")

        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["source"] == "local_review_overlay"
        assert data["candidate_count"] == 1
        assert data["skipped_mem0_hydration_for_session_scope"] is True
        assert isinstance(data["trace_id"], str)
        mock_mem0.get.assert_not_called()

    def test_recent_memory_diagnostics_reports_session_id_received(self, client, mock_mem0, mock_review_store):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Needs review", "metadata": {"status": "pending_review"}},
        ]

        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review&session_id=sess-1")

        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id_received"] is True
        assert data["candidate_count"] == data["count"] == 1
        assert data["trace_id"].startswith("memrecent-")

    def test_global_hydration_path_reports_safe_source(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Needs review", "metadata": None},
            {"id": "m2", "memory": "Already approved", "metadata": None},
        ]
        mock_mem0.get.side_effect = [
            {"id": "m1", "memory": "Needs review", "metadata": {"status": "pending_review"}},
            {"id": "m2", "memory": "Already approved", "metadata": {"status": "approved"}},
        ]

        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")

        assert resp.status_code == 200
        data = resp.json()
        assert data["source"] == "global_hydration"
        assert data["candidate_count"] == 1
        assert data["local_overlay_count"] == 0

    def test_hydrates_missing_metadata_without_status_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Likes pizza", "metadata": None, "categories": []},
        ]
        mock_mem0.get.return_value = {
            "id": "m1",
            "memory": "Likes pizza",
            "metadata": {"status": "approved"},
            "categories": ["food"],
        }

        resp = client.get("/api/sophia/test_user/memories/recent")

        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["memories"][0]["metadata"] == {"status": "approved"}
        assert data["memories"][0]["category"] == "food"
        mock_mem0.get.assert_called_once_with("m1")

    def test_mem0_failure_returns_503(self, client, mock_mem0):
        mock_mem0.get_all.side_effect = Exception("API error")
        resp = client.get("/api/sophia/test_user/memories/recent")
        assert resp.status_code == 503

    def test_returns_memory_categories(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Lost the game", "categories": ["feeling"]},
            {"id": "m2", "memory": "Works at startup", "categories": ["fact"]},
        ]
        resp = client.get("/api/sophia/test_user/memories/recent")
        assert resp.status_code == 200
        data = resp.json()
        assert data["memories"][0]["category"] == "feeling"
        assert data["memories"][1]["category"] == "fact"

    def test_deduplicates_duplicate_memory_ids_before_returning_recent_memories(self, client, mock_mem0, mock_review_store):
        mock_mem0.get_all.return_value = []
        mock_review_store["apply"].side_effect = None
        mock_review_store["apply"].return_value = [
            {"id": "local:dup", "memory": "Older duplicate", "metadata": {"status": "pending_review"}, "updated_at": "2026-04-01T00:00:00+00:00"},
            {"id": "local:dup", "memory": "Newer duplicate", "metadata": {"status": "pending_review"}, "updated_at": "2026-04-02T00:00:00+00:00"},
        ]

        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")

        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["memories"][0]["id"] == "local:dup"
        assert data["memories"][0]["content"] == "Newer duplicate"


# ---------------------------------------------------------------------------
# Memory Create
# ---------------------------------------------------------------------------

class TestCreateMemory:
    def test_create_memory_returns_item(self, client, mock_mem0, mock_review_store):
        mock_mem0.add.return_value = [{"id": "m1", "memory": "Likes pizza", "categories": ["food"]}]
        with patch("deerflow.sophia.mem0_client.invalidate_user_cache") as mock_invalidate:
            resp = client.post(
                "/api/sophia/test_user/memories",
                json={"text": "Likes pizza", "category": "food", "metadata": {"status": "approved"}},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "m1"
        assert data["content"] == "Likes pizza"
        mock_mem0.add.assert_called_once()
        mock_invalidate.assert_called_once_with("test_user")
        mock_review_store["upsert"].assert_called_once_with(
            "test_user",
            memory_id="m1",
            content="Likes pizza",
            metadata={"status": "approved", "category": "food"},
            session_id="manual-create",
            sync_state="manual",
        )

    def test_create_memory_falls_back_without_metadata(self, client, mock_mem0):
        mock_mem0.add.side_effect = [TypeError("metadata unsupported"), [{"id": "m2", "memory": "Keeps going"}]]
        with patch("deerflow.sophia.mem0_client.invalidate_user_cache"):
            resp = client.post(
                "/api/sophia/test_user/memories",
                json={"text": "Keeps going", "metadata": {"status": "approved"}},
            )
        assert resp.status_code == 200
        assert mock_mem0.add.call_count == 2

    def test_create_memory_invalid_user_returns_400(self, client):
        resp = client.post(
            "/api/sophia/user;hack/memories",
            json={"text": "test"},
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Memory Update
# ---------------------------------------------------------------------------

class TestUpdateMemory:
    def test_update_text(self, client, mock_mem0, mock_review_store):
        mock_mem0.update.return_value = {"id": "m1", "memory": "Updated text"}
        with patch("app.gateway.routers.sophia.invalidate_user_cache", create=True):
            resp = client.put(
                "/api/sophia/test_user/memories/m1",
                json={"text": "Updated text"},
            )
        assert resp.status_code == 200
        mock_review_store["upsert"].assert_called_once_with(
            "test_user",
            memory_id="m1",
            content="Updated text",
            metadata=None,
            sync_state="manual",
        )

    def test_invalid_user_returns_400(self, client):
        resp = client.put(
            "/api/sophia/user;hack/memories/m1",
            json={"text": "test"},
        )
        assert resp.status_code == 400

    def test_update_with_metadata(self, client, mock_mem0, mock_review_store):
        mock_mem0.update.return_value = {"id": "m1", "memory": "Updated text"}
        with patch("app.gateway.routers.sophia.invalidate_user_cache", create=True):
            resp = client.put(
                "/api/sophia/test_user/memories/m1",
                json={"text": "Updated text", "metadata": {"status": "approved"}},
            )
        assert resp.status_code == 200
        mock_mem0.update.assert_called_once_with(
            memory_id="m1", text="Updated text", metadata={"status": "approved"},
        )
        mock_review_store["upsert"].assert_called_once_with(
            "test_user",
            memory_id="m1",
            content="Updated text",
            metadata={"status": "approved"},
            sync_state="manual",
        )

    def test_update_no_fields_returns_422(self, client, mock_mem0):
        with patch("app.gateway.routers.sophia.invalidate_user_cache", create=True):
            resp = client.put(
                "/api/sophia/test_user/memories/m1",
                json={},
            )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Memory Delete
# ---------------------------------------------------------------------------

class TestDeleteMemory:
    def test_delete_returns_204(self, client, mock_mem0, mock_review_store):
        mock_mem0.delete.return_value = None
        with patch("app.gateway.routers.sophia.invalidate_user_cache", create=True):
            resp = client.delete("/api/sophia/test_user/memories/m1")
        assert resp.status_code == 204
        mock_review_store["remove"].assert_called_once_with("test_user", memory_id="m1")

    def test_delete_failure_returns_503(self, client, mock_mem0):
        mock_mem0.delete.side_effect = Exception("Not found")
        resp = client.delete("/api/sophia/test_user/memories/m1")
        assert resp.status_code == 503


class TestBulkReview:
    def test_bulk_review_updates_local_store(self, client, mock_mem0, mock_review_store):
        resp = client.post(
            "/api/sophia/test_user/memories/bulk-review",
            json={
                "items": [
                    {"id": "m1", "action": "approve"},
                    {"id": "m2", "action": "discard"},
                ]
            },
        )

        assert resp.status_code == 200
        mock_mem0.update.assert_called_once_with(memory_id="m1", metadata={"status": "approved"})
        mock_mem0.delete.assert_called_once_with(memory_id="m2")
        mock_review_store["upsert"].assert_called_once_with(
            "test_user",
            memory_id="m1",
            content_hash=None,
            metadata={"status": "approved"},
            sync_state="manual",
        )
        mock_review_store["remove"].assert_called_once_with("test_user", memory_id="m2")

    def test_delete_invalidates_cache(self, client, mock_mem0):
        mock_mem0.delete.return_value = None
        with patch("deerflow.sophia.mem0_client.invalidate_user_cache") as mock_invalidate:
            resp = client.delete("/api/sophia/test_user/memories/m1")
        assert resp.status_code == 204
        mock_invalidate.assert_called_once_with("test_user")

    def test_approve_and_discard(self, client, mock_mem0):
        mock_mem0.update.return_value = {}
        mock_mem0.delete.return_value = None
        resp = client.post(
            "/api/sophia/test_user/memories/bulk-review",
            json={"items": [
                {"id": "m1", "action": "approve"},
                {"id": "m2", "action": "discard"},
            ]},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["results"]) == 2
        assert data["results"][0]["status"] == "ok"
        assert data["results"][1]["status"] == "ok"

    def test_partial_failure(self, client, mock_mem0):
        mock_mem0.update.return_value = {}
        mock_mem0.delete.side_effect = Exception("Failed")
        resp = client.post(
            "/api/sophia/test_user/memories/bulk-review",
            json={"items": [
                {"id": "m1", "action": "approve"},
                {"id": "m2", "action": "discard"},
            ]},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["results"][0]["status"] == "ok"
        assert data["results"][1]["status"] == "error"

    def test_empty_items_returns_200(self, client, mock_mem0):
        resp = client.post(
            "/api/sophia/test_user/memories/bulk-review",
            json={"items": []},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["results"] == []


# ---------------------------------------------------------------------------
# Reflect
# ---------------------------------------------------------------------------

class TestReflect:
    def test_reflect_success(self, client):
        mock_result = {"voice_context": "You've been focused on work.", "visual_parts": []}
        with patch("deerflow.sophia.reflection.generate_reflection", return_value=mock_result):
            resp = client.post(
                "/api/sophia/test_user/reflect",
                json={"query": "How have I been?", "period": "this_week"},
            )
        assert resp.status_code == 200
        data = resp.json()
        assert "voice_context" in data

    def test_invalid_period_returns_422(self, client):
        resp = client.post(
            "/api/sophia/test_user/reflect",
            json={"query": "test", "period": "invalid"},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Journal
# ---------------------------------------------------------------------------

class TestJournal:
    def test_returns_entries(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Likes pizza", "categories": ["food"]},
        ]
        resp = client.get("/api/sophia/test_user/journal")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["entries"][0]["content"] == "Likes pizza"

    def test_handles_empty_categories_list(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Approved memory", "categories": [], "metadata": {"status": "approved"}},
        ]
        resp = client.get("/api/sophia/test_user/journal")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["entries"][0]["category"] is None

    def test_with_category_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/journal?category=relationship")
        assert resp.status_code == 200
        mock_mem0.get_all.assert_called_once()

    def test_with_type_alias_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/journal?type=relationship")
        assert resp.status_code == 200
        mock_mem0.get_all.assert_called_once_with(filters={"user_id": "test_user", "categories": "relationship"})

    def test_with_search_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Presentation went well", "categories": ["lesson"]},
            {"id": "m2", "memory": "Likes pizza", "categories": ["fact"]},
        ]
        resp = client.get("/api/sophia/test_user/journal?search=present")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["entries"][0]["id"] == "m1"

    def test_with_status_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "m1", "memory": "Approved memory", "metadata": {"status": "approved"}},
            {"id": "m2", "memory": "Pending memory", "metadata": {"status": "pending_review"}},
        ]
        resp = client.get("/api/sophia/test_user/journal?status=approved")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["entries"][0]["id"] == "m1"

    def test_empty_journal(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/journal")
        assert resp.status_code == 200
        assert resp.json()["entries"] == []

    def test_deduplicates_duplicate_memory_ids_before_returning_journal(self, client, mock_mem0, mock_review_store):
        mock_mem0.get_all.return_value = []
        mock_review_store["apply"].side_effect = None
        mock_review_store["apply"].return_value = [
            {"id": "local:dup", "memory": "Older duplicate", "metadata": {"status": "approved"}, "created_at": "2026-04-01T00:00:00+00:00"},
            {"id": "local:dup", "memory": "Newer duplicate", "metadata": {"status": "approved"}, "created_at": "2026-04-02T00:00:00+00:00"},
        ]

        resp = client.get("/api/sophia/test_user/journal")

        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        assert data["entries"][0]["id"] == "local:dup"
        assert data["entries"][0]["content"] == "Newer duplicate"


# ---------------------------------------------------------------------------
# Session Recap
# ---------------------------------------------------------------------------

class TestSessionRecap:
    def test_returns_persisted_recap(self, client, tmp_path):
        recap_dir = tmp_path / "test_user" / "recaps"
        recap_dir.mkdir(parents=True, exist_ok=True)
        (recap_dir / "sess-001.json").write_text(
            '{"session_id": "sess-001", "thread_id": "thread-001", "status": "ready", "ended_at": "2026-04-05T10:00:00+00:00", "turn_count": 4, "recap_artifacts": {"takeaway": "You stayed with the hard part."}}',
            encoding="utf-8",
        )

        with patch("app.gateway.routers.sophia.USERS_DIR", tmp_path):
            resp = client.get("/api/sophia/test_user/sessions/sess-001/recap")

        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"] == "sess-001"
        assert data["recap_artifacts"]["takeaway"] == "You stayed with the hard part."

    def test_missing_recap_returns_404(self, client, tmp_path):
        with patch("app.gateway.routers.sophia.USERS_DIR", tmp_path):
            resp = client.get("/api/sophia/test_user/sessions/missing/recap")

        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Visual Weekly
# ---------------------------------------------------------------------------

class TestVisualWeekly:
    def test_empty_traces(self, client, tmp_path):
        with patch("app.gateway.routers.sophia.safe_user_path", return_value=tmp_path / "traces", create=True), \
             patch("app.gateway.routers.sophia.USERS_DIR", tmp_path, create=True):
            resp = client.get("/api/sophia/test_user/visual/weekly")
        assert resp.status_code == 200
        assert resp.json()["data_points"] == []

    def test_invalid_user_returns_400(self, client):
        resp = client.get("/api/sophia/user;hack/visual/weekly")
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Visual Decisions / Commitments
# ---------------------------------------------------------------------------

class TestVisualCategories:
    def test_decisions(self, client, mock_mem0):
        mock_mem0.get_all.return_value = [
            {"id": "d1", "memory": "Decided to quit", "categories": ["decision"]},
        ]
        resp = client.get("/api/sophia/test_user/visual/decisions")
        assert resp.status_code == 200
        assert resp.json()["count"] == 1

    def test_commitments(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/visual/commitments")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0


# ---------------------------------------------------------------------------
# Background Task Control
# ---------------------------------------------------------------------------

class TestTaskStatus:
    def test_returns_running_task_progress_and_diagnostics(self, client):
        from types import SimpleNamespace

        task_result = SimpleNamespace(
            task_id="task-1",
            trace_id="trace-1",
            status=SimpleNamespace(value="running"),
            started_at=None,
            completed_at=None,
            last_update_at=None,
            last_progress_at=None,
            result=None,
            error=None,
            ai_messages=[{"content": "working"}],
            owner_id="test_user",
            timeout_observed_during_stream=False,
            timed_out_at=None,
            final_state=None,
            last_ai_message_summary={
                "tool_names": ["search_web"],
                "has_emit_builder_artifact": False,
            },
            late_ai_message_summary=None,
        )
        task_result.live_state = {
            "todos": [
                {"id": 1, "title": "Research sources", "status": "completed"},
                {"id": 2, "title": "Draft the summary", "status": "in-progress"},
            ],
            "last_shell_command": {
                "tool": "bash",
                "status": "shell_unavailable",
                "requested_command": "ls /mnt/user-data/workspace",
                "error": "No suitable shell executable found.",
            },
            "recent_shell_commands": [
                {
                    "tool": "bash",
                    "status": "shell_unavailable",
                    "requested_command": "ls /mnt/user-data/workspace",
                    "error": "No suitable shell executable found.",
                }
            ],
        }

        with (
            patch("deerflow.subagents.executor.get_background_task_result", return_value=task_result),
            patch(
                "deerflow.subagents.executor.build_subagent_progress_payload",
                return_value={
                    "started_at": "2026-04-05T10:00:00+00:00",
                    "completed_at": None,
                    "last_update_at": "2026-04-05T10:00:28+00:00",
                    "last_progress_at": "2026-04-05T10:00:27+00:00",
                    "heartbeat_ms": 2000,
                    "idle_ms": 3000,
                    "is_stuck": False,
                    "stuck_reason": None,
                    "progress_percent": 50,
                    "progress_source": "todos",
                    "active_step_title": "Draft the summary",
                    "todos": task_result.live_state["todos"],
                    "total_steps": 2,
                    "completed_steps": 1,
                    "in_progress_steps": 1,
                    "pending_steps": 0,
                },
            ),
        ):
            resp = client.get("/api/sophia/test_user/tasks/task-1")

        assert resp.status_code == 200
        data = resp.json()
        assert data["task_id"] == "task-1"
        assert data["status"] == "running"
        assert data["progress_percent"] == 50
        assert data["active_step_title"] == "Draft the summary"
        assert data["debug"]["last_tool_names"] == ["search_web"]
        assert data["debug"]["suspected_blocker"] == "tool_call"
        assert data["debug"]["last_shell_command"]["status"] == "shell_unavailable"
        assert data["debug"]["last_shell_command"]["requested_command"] == "ls /mnt/user-data/workspace"
        assert data["debug"]["recent_shell_commands"][0]["error"] == "No suitable shell executable found."

    def test_returns_completed_task_builder_result(self, client):
        from types import SimpleNamespace

        task_result = SimpleNamespace(
            task_id="task-2",
            trace_id="trace-2",
            status=SimpleNamespace(value="completed"),
            result="Deliverable ready.",
            started_at=None,
            completed_at=None,
            last_update_at=None,
            last_progress_at=None,
            ai_messages=[{"content": "done"}],
            owner_id="test_user",
            error=None,
            timeout_observed_during_stream=False,
            timed_out_at=None,
            live_state=None,
            last_ai_message_summary=None,
            late_ai_message_summary=None,
        )
        task_result.final_state = {
            "builder_result": {
                "artifact_title": "One-page brief",
                "artifact_type": "brief",
                "companion_summary": "Deliverable ready.",
            },
        }

        with (
            patch("deerflow.subagents.executor.get_background_task_result", return_value=task_result),
            patch(
                "deerflow.subagents.executor.build_subagent_progress_payload",
                return_value={
                    "started_at": "2026-04-05T10:00:00+00:00",
                    "completed_at": "2026-04-05T10:00:44+00:00",
                    "last_update_at": "2026-04-05T10:00:44+00:00",
                    "last_progress_at": "2026-04-05T10:00:44+00:00",
                    "heartbeat_ms": 0,
                    "idle_ms": 0,
                    "is_stuck": False,
                    "stuck_reason": None,
                    "progress_percent": 100,
                    "progress_source": "todos",
                    "active_step_title": None,
                    "todos": [],
                },
            ),
        ):
            resp = client.get("/api/sophia/test_user/tasks/task-2")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["builder_result"]["artifact_title"] == "One-page brief"
        assert data["detail"] == "Deliverable ready."
        assert data["debug"]["builder_result_present"] is True
        assert data["debug"]["suspected_blocker"] is None

    def test_returns_persisted_task_snapshot_when_in_memory_state_is_unavailable(self, client):
        persisted_payload = {
            "task_id": "task-3",
            "status": "running",
            "trace_id": "trace-3",
            "description": "Builder: concise draft document",
            "detail": "Draft the summary",
            "result": None,
            "error": None,
            "builder_result": None,
            "message_count": 2,
            "started_at": "2026-04-05T10:00:00+00:00",
            "completed_at": None,
            "last_update_at": "2026-04-05T10:00:28+00:00",
            "last_progress_at": "2026-04-05T10:00:27+00:00",
            "heartbeat_ms": 2000,
            "idle_ms": 3000,
            "is_stuck": False,
            "stuck_reason": None,
            "progress_percent": 50,
            "progress_source": "todos",
            "total_steps": 2,
            "completed_steps": 1,
            "in_progress_steps": 1,
            "pending_steps": 0,
            "active_step_title": "Draft the summary",
            "todos": [
                {"id": 1, "title": "Research sources", "status": "completed"},
                {"id": 2, "title": "Draft the summary", "status": "in-progress"},
            ],
            "debug": {
                "last_tool_names": ["write_todos"],
                "last_has_emit_builder_artifact": False,
                "late_tool_names": [],
                "late_has_emit_builder_artifact": None,
                "timeout_observed_during_stream": False,
                "timed_out_at": None,
                "final_state_present": False,
                "builder_result_present": False,
                "suspected_blocker": "tool_call",
                "suspected_blocker_detail": "Latest captured Builder step called write_todos and has not reached emit_builder_artifact yet.",
                "last_shell_command": {
                    "tool": "bash",
                    "status": "timed_out",
                    "requested_command": "python /mnt/user-data/workspace/script.py",
                    "error": "Command exceeded 600 seconds",
                },
                "recent_shell_commands": [
                    {
                        "tool": "bash",
                        "status": "timed_out",
                        "requested_command": "python /mnt/user-data/workspace/script.py",
                        "error": "Command exceeded 600 seconds",
                    }
                ],
            },
            "owner_id": "test_user",
        }

        with (
            patch("deerflow.subagents.executor.get_background_task_result", return_value=None),
            patch("deerflow.subagents.executor.read_background_task_status_payload", return_value=persisted_payload),
        ):
            resp = client.get("/api/sophia/test_user/tasks/task-3")

        assert resp.status_code == 200
        data = resp.json()
        assert data["task_id"] == "task-3"
        assert data["status"] == "running"
        assert data["description"] == "Builder: concise draft document"
        assert data["progress_percent"] == 50
        assert data["debug"]["last_tool_names"] == ["write_todos"]
        assert data["debug"]["last_shell_command"]["status"] == "timed_out"


# ---------------------------------------------------------------------------
# Session End
# ---------------------------------------------------------------------------

class TestSessionEnd:
    def test_returns_202(self, client, tmp_path):
        store = SessionStore(tmp_path)
        store.create(
            SessionRecord(
                session_id="sess-001",
                thread_id="thread-001",
                user_id="test_user",
                status="open",
            )
        )

        with patch("app.gateway.routers.sophia._queue_offline_pipeline") as mock_queue, \
             patch("app.gateway.routers.sophia.USERS_DIR", tmp_path), \
             patch("app.gateway.routers.sophia._session_store", store):
            resp = client.post(
                "/api/sophia/test_user/end-session",
                json={
                    "session_id": "sess-001",
                    "thread_id": "thread-001",
                    "started_at": "2026-04-05T09:52:00+00:00",
                    "ended_at": "2026-04-05T10:00:00+00:00",
                    "offer_debrief": True,
                    "session_type": "open",
                    "context_mode": "life",
                    "turn_count": 4,
                    "messages": [
                        {"role": "user", "content": "I needed to talk this through."},
                        {"role": "assistant", "content": "You stayed with it."},
                    ],
                    "recap_artifacts": {
                        "takeaway": "You stayed with it.",
                        "reflection_candidate": {"prompt": "What shifted once you slowed down?"},
                    },
                },
            )
        assert resp.status_code == 202
        data = resp.json()
        assert data["status"] == "pipeline_queued"
        assert data["session_id"] == "sess-001"
        assert data["turn_count"] == 4
        assert data["offer_debrief"] is True
        assert data["recap_artifacts"]["takeaway"] == "You stayed with it."

        saved = json.loads((tmp_path / "test_user" / "recaps" / "sess-001.json").read_text(encoding="utf-8"))
        assert saved["status"] == "ready"
        assert saved["recap_artifacts"]["takeaway"] == "You stayed with it."
        record = store.get("test_user", "sess-001")
        assert record is not None
        assert record.status == "ended"
        assert record.ended_at == "2026-04-05T10:00:00+00:00"
        mock_queue.assert_called_once()
        queued_state = mock_queue.call_args.args[3]
        assert queued_state is not None
        assert queued_state["messages"][0]["content"] == "I needed to talk this through."
        transcript = store.list_messages("test_user", "sess-001")
        assert [message.role for message in transcript] == ["user", "assistant"]
        assert [message.content for message in transcript] == [
            "I needed to talk this through.",
            "You stayed with it.",
        ]

    def test_duplicate_end_session_reuses_existing_recap_and_queues_once(self, client, tmp_path):
        store = SessionStore(tmp_path)
        store.create(
            SessionRecord(
                session_id="sess-dupe",
                thread_id="thread-dupe",
                user_id="test_user",
                status="open",
            )
        )
        payload = {
            "session_id": "sess-dupe",
            "thread_id": "thread-dupe",
            "started_at": "2026-04-05T09:52:00+00:00",
            "ended_at": "2026-04-05T10:00:00+00:00",
            "offer_debrief": False,
            "session_type": "open",
            "context_mode": "life",
            "turn_count": 2,
            "messages": [
                {"role": "user", "content": "Let's close this cleanly."},
                {"role": "assistant", "content": "Closed with care."},
            ],
        }

        with patch("app.gateway.routers.sophia._queue_offline_pipeline") as mock_queue, \
             patch("app.gateway.routers.sophia.USERS_DIR", tmp_path), \
             patch("app.gateway.routers.sophia._session_store", store):
            first = client.post("/api/sophia/test_user/end-session", json=payload)
            second_payload = {**payload, "ended_at": "2026-04-05T10:05:00+00:00"}
            second = client.post("/api/sophia/test_user/end-session", json=second_payload)

        assert first.status_code == 202
        assert second.status_code == 202
        assert first.json()["status"] == "pipeline_queued"
        assert second.json()["status"] == "pipeline_queued"
        assert second.json()["ended_at"] == "2026-04-05T10:00:00+00:00"
        mock_queue.assert_called_once()

        saved = json.loads((tmp_path / "test_user" / "recaps" / "sess-dupe.json").read_text(encoding="utf-8"))
        assert saved["ended_at"] == "2026-04-05T10:00:00+00:00"
        record = store.get("test_user", "sess-dupe")
        assert record is not None
        assert record.status == "ended"
        assert record.ended_at == "2026-04-05T10:00:00+00:00"
        assert len(store.list_messages("test_user", "sess-dupe")) == 2

    def test_missing_session_id_returns_422(self, client):
        resp = client.post(
            "/api/sophia/test_user/end-session",
            json={"thread_id": "thread-001"},
        )
        assert resp.status_code == 422

    def test_invalid_user_returns_400(self, client):
        resp = client.post(
            "/api/sophia/user;hack/end-session",
            json={"session_id": "s1", "thread_id": "t1"},
        )
        assert resp.status_code == 400
