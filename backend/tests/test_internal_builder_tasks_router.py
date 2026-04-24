import asyncio
import time

import pytest

from app.gateway.routers import internal_builder_tasks


class _Req:
    def __init__(self, payload, headers=None):
        self._payload = payload
        self.headers = headers or {}

    async def json(self):
        return self._payload


class TestRequireSecret:
    def test_raises_503_when_secret_not_set(self, monkeypatch):
        monkeypatch.delenv("SOPHIA_INTERNAL_SECRET", raising=False)
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            internal_builder_tasks._require_secret(_Req({}))
        assert exc.value.status_code == 503

    def test_raises_401_when_missing_bearer(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "correct")
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            internal_builder_tasks._require_secret(_Req({}, headers={}))
        assert exc.value.status_code == 401

    def test_raises_401_on_wrong_secret(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "correct")
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            internal_builder_tasks._require_secret(
                _Req({}, headers={"authorization": "Bearer wrong"})
            )
        assert exc.value.status_code == 401

    def test_accepts_correct_bearer(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "correct")
        internal_builder_tasks._require_secret(
            _Req({}, headers={"authorization": "Bearer correct"})
        )


class TestPushBuilderTaskStatus:
    def setup_method(self):
        internal_builder_tasks.clear_registry()

    def teardown_method(self):
        internal_builder_tasks.clear_registry()

    def test_stores_payload_and_returns_204(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s3cret")
        req = _Req(
            {"status": "completed", "builder_result": {"artifact_path": "/x/y"}},
            headers={"authorization": "Bearer s3cret"},
        )
        resp = asyncio.run(
            internal_builder_tasks.push_builder_task_status(req, "abc-42")
        )
        assert resp.status_code == 204
        got = internal_builder_tasks.get_pushed_builder_task("abc-42")
        assert got is not None
        assert got["status"] == "completed"
        assert got["builder_result"] == {"artifact_path": "/x/y"}
        assert got["task_id"] == "abc-42"
        assert "received_at" in got

    def test_rejects_missing_task_id(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s3cret")
        from fastapi import HTTPException
        req = _Req({"status": "completed"}, headers={"authorization": "Bearer s3cret"})
        with pytest.raises(HTTPException) as exc:
            asyncio.run(internal_builder_tasks.push_builder_task_status(req, "  "))
        assert exc.value.status_code == 400

    def test_rejects_non_object_payload(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s3cret")
        from fastapi import HTTPException
        req = _Req(["not", "a", "dict"], headers={"authorization": "Bearer s3cret"})
        with pytest.raises(HTTPException) as exc:
            asyncio.run(internal_builder_tasks.push_builder_task_status(req, "abc"))
        assert exc.value.status_code == 400

    def test_rejects_without_auth(self, monkeypatch):
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s3cret")
        from fastapi import HTTPException
        req = _Req({"status": "completed"})
        with pytest.raises(HTTPException) as exc:
            asyncio.run(internal_builder_tasks.push_builder_task_status(req, "abc"))
        assert exc.value.status_code == 401


class TestGetPushedBuilderTask:
    def setup_method(self):
        internal_builder_tasks.clear_registry()

    def teardown_method(self):
        internal_builder_tasks.clear_registry()

    def test_returns_none_for_unknown(self):
        assert internal_builder_tasks.get_pushed_builder_task("missing") is None

    def test_returns_none_for_empty_id(self):
        assert internal_builder_tasks.get_pushed_builder_task("") is None

    def test_expires_old_entries(self, monkeypatch):
        now = time.monotonic()
        with internal_builder_tasks._registry_lock:
            internal_builder_tasks._registry["old"] = {
                "status": "completed",
                "received_at": now - internal_builder_tasks._REGISTRY_TTL_SECONDS - 60,
            }
            internal_builder_tasks._registry["fresh"] = {
                "status": "completed",
                "received_at": now,
            }
        assert internal_builder_tasks.get_pushed_builder_task("old") is None
        assert internal_builder_tasks.get_pushed_builder_task("fresh") is not None

    def test_returns_shallow_copy(self):
        with internal_builder_tasks._registry_lock:
            internal_builder_tasks._registry["a"] = {
                "status": "completed",
                "received_at": time.monotonic(),
            }
        got = internal_builder_tasks.get_pushed_builder_task("a")
        got["status"] = "mutated"
        again = internal_builder_tasks.get_pushed_builder_task("a")
        assert again["status"] == "completed"
