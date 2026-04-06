"""Tests for the Sophia gateway API router."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    """Create a test client with the Sophia router."""
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
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/memories/recent?status=pending_review")
        assert resp.status_code == 200
        mock_mem0.get_all.assert_called_once()
        call_kwargs = mock_mem0.get_all.call_args
        filters = call_kwargs[1].get("filters", call_kwargs[0][0] if call_kwargs[0] else {})
        assert "user_id" in str(filters)

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


# ---------------------------------------------------------------------------
# Memory Update
# ---------------------------------------------------------------------------

class TestUpdateMemory:
    def test_update_text(self, client, mock_mem0):
        mock_mem0.update.return_value = {"id": "m1", "memory": "Updated text"}
        with patch("app.gateway.routers.sophia.invalidate_user_cache", create=True):
            resp = client.put(
                "/api/sophia/test_user/memories/m1",
                json={"text": "Updated text"},
            )
        assert resp.status_code == 200

    def test_invalid_user_returns_400(self, client):
        resp = client.put(
            "/api/sophia/user;hack/memories/m1",
            json={"text": "test"},
        )
        assert resp.status_code == 400

    def test_update_with_metadata(self, client, mock_mem0):
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
    def test_delete_returns_204(self, client, mock_mem0):
        mock_mem0.delete.return_value = None
        with patch("app.gateway.routers.sophia.invalidate_user_cache", create=True):
            resp = client.delete("/api/sophia/test_user/memories/m1")
        assert resp.status_code == 204

    def test_delete_failure_returns_503(self, client, mock_mem0):
        mock_mem0.delete.side_effect = Exception("Not found")
        resp = client.delete("/api/sophia/test_user/memories/m1")
        assert resp.status_code == 503

    def test_delete_invalidates_cache(self, client, mock_mem0):
        mock_mem0.delete.return_value = None
        with patch("deerflow.sophia.mem0_client.invalidate_user_cache") as mock_invalidate:
            resp = client.delete("/api/sophia/test_user/memories/m1")
        assert resp.status_code == 204
        mock_invalidate.assert_called_once_with("test_user")


# ---------------------------------------------------------------------------
# Bulk Review
# ---------------------------------------------------------------------------

class TestBulkReview:
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
        with patch("app.gateway.routers.sophia.generate_reflection", return_value=mock_result, create=True):
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

    def test_with_category_filter(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/journal?category=relationship")
        assert resp.status_code == 200
        mock_mem0.get_all.assert_called_once()

    def test_empty_journal(self, client, mock_mem0):
        mock_mem0.get_all.return_value = []
        resp = client.get("/api/sophia/test_user/journal")
        assert resp.status_code == 200
        assert resp.json()["entries"] == []


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
# Session End
# ---------------------------------------------------------------------------

class TestSessionEnd:
    def test_returns_202(self, client):
        with patch("app.gateway.routers.sophia.run_offline_pipeline", create=True):
            resp = client.post(
                "/api/sophia/test_user/end-session",
                json={"session_id": "sess-001", "thread_id": "thread-001"},
            )
        assert resp.status_code == 202
        data = resp.json()
        assert data["status"] == "pipeline_queued"
        assert data["session_id"] == "sess-001"

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
