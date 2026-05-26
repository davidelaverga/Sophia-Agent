from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.gateway.auth import require_authorized_user_scope
from app.gateway.routers import builder_canvas
from app.gateway.workers.builder_canvas import install_builder_canvas_worker
from deerflow.sophia.session_store import SessionRecord, SessionStore


@pytest.fixture
def app(tmp_path, monkeypatch) -> FastAPI:
    store = SessionStore(tmp_path / "users")
    store.create(SessionRecord(session_id="session-1", thread_id="parent-1", user_id="user-1"))
    monkeypatch.setattr(builder_canvas, "_session_store", store)
    app = FastAPI()
    install_builder_canvas_worker(app)
    app.include_router(builder_canvas.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "user-1"
    return app


@pytest.mark.anyio
async def test_snapshot_uses_native_task_identity_and_activity(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [{"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-1", "status": "running"}]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "running"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    worker = app.state._builder_canvas_worker
    await worker.publish_progress({
        "parent_thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "sequence": 1,
        "event_name": "custom",
        "data": {"name": "phase", "phase": "drafting"},
    })

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    assert response.json()["active_task"] == {
        "parent_thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "status": "running",
        "latest_activity": {"kind": "phase", "phase": "drafting", "label": "Drafting"},
    }


@pytest.mark.anyio
async def test_snapshot_selects_latest_task_by_last_updated_at(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-old",
                "run_id": "run-old",
                "updated_at": "2026-05-25T10:02:00Z",
                "last_updated_at": "2026-05-25T10:00:00Z",
            },
            {
                "agent_name": "sophia_builder",
                "task_id": "task-new",
                "run_id": "run-new",
                "updated_at": "2026-05-25T10:01:00Z",
                "last_updated_at": "2026-05-25T10:03:00Z",
            },
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "running"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    assert response.json()["active_task"]["task_id"] == "task-new"
    assert response.json()["active_task"]["run_id"] == "run-new"


@pytest.mark.anyio
async def test_snapshot_rejects_thread_not_owned_by_user(app: FastAPI) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/other-parent/builder-canvas/snapshot")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_cancel_validates_native_task_and_publishes_terminal(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [{"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-1"}]

    cancelled: list[tuple[str, str, str]] = []

    class Runs:
        async def get(self, task_id: str, run_id: str):
            return {"status": "running"}

        async def cancel(self, task_id: str, run_id: str, action: str):
            cancelled.append((task_id, run_id, action))

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "get_client", lambda url: SimpleNamespace(runs=Runs()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/runs/run-1/cancel"
        )

    assert response.status_code == 200
    assert cancelled == [("task-1", "run-1", "interrupt")]
    events = await app.state._builder_canvas_worker.recent_events("parent-1")
    assert events[-1]["status"] == "cancelled"


@pytest.mark.anyio
async def test_cancel_does_not_publish_cancel_for_already_terminal_run(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [{"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-1", "status": "running"}]

    cancelled: list[tuple[str, str, str]] = []

    class Runs:
        async def get(self, task_id: str, run_id: str):
            return {"status": "success"}

        async def cancel(self, task_id: str, run_id: str, action: str):
            cancelled.append((task_id, run_id, action))

    worker = app.state._builder_canvas_worker
    await worker.publish_progress({
        "parent_thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "sequence": 1,
        "event_name": "custom",
        "data": {"name": "phase", "phase": "finalizing"},
    })
    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "get_client", lambda url: SimpleNamespace(runs=Runs()))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/runs/run-1/cancel"
        )

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert cancelled == []
    events = await worker.recent_events("parent-1")
    assert [event["kind"] for event in events] == ["progress"]
    assert events[-1]["status"] == "running"


@pytest.mark.anyio
async def test_cancel_resolves_latest_native_run_when_run_id_is_absent(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-old", "updated_at": "2026-05-25T10:00:00Z"},
            {"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-new", "updated_at": "2026-05-25T10:01:00Z"},
        ]

    cancelled: list[tuple[str, str, str]] = []

    class Runs:
        async def get(self, task_id: str, run_id: str):
            return {"status": "running"}

        async def cancel(self, task_id: str, run_id: str, action: str):
            cancelled.append((task_id, run_id, action))

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "get_client", lambda url: SimpleNamespace(runs=Runs()))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/cancel"
        )

    assert response.status_code == 200
    assert response.json()["run_id"] == "run-new"
    assert cancelled == [("task-1", "run-new", "interrupt")]
