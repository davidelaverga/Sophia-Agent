"""Tests for the Sophia gateway API router."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    """Create a test client with the Sophia router."""
    from app.gateway.auth import require_authorized_user_scope
    from app.gateway.routers.sophia import router

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "test_user"
    return TestClient(app)


@pytest.fixture
def secure_client():
    """Create a test client with the real auth dependency enabled."""
    from app.gateway.routers.sophia import router

    app = FastAPI()
    app.include_router(router)
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
        assert resp.json()["count"] == 1
        mock_mem0.get.assert_not_called()

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
        with patch("app.gateway.routers.sophia._queue_offline_pipeline") as mock_queue, \
             patch("app.gateway.routers.sophia.USERS_DIR", tmp_path):
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
        mock_queue.assert_called_once()
        queued_state = mock_queue.call_args.args[3]
        assert queued_state is not None
        assert queued_state["messages"][0]["content"] == "I needed to talk this through."

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
