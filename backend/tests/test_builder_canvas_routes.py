from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.gateway.auth import require_authorized_user_scope
from app.gateway.routers import builder_canvas
from app.gateway.workers.builder_canvas import install_builder_canvas_worker
from deerflow.sophia.session_store import SessionRecord, SessionStore


class _RunningThenInterruptedRuns:
    status = "running"

    def __init__(self, cancelled: list[tuple[str, str, str]]) -> None:
        self.cancelled = cancelled

    async def get(self, task_id: str, run_id: str):
        return {"status": self.status}

    async def cancel(self, task_id: str, run_id: str, wait: bool, action: str):
        self.cancelled.append((task_id, run_id, action))
        assert wait is True
        self.status = "interrupted"


class _AlreadySuccessfulRuns:
    def __init__(self, cancelled: list[tuple[str, str, str]]) -> None:
        self.cancelled = cancelled

    async def get(self, task_id: str, run_id: str):
        return {"status": "success"}

    async def cancel(self, task_id: str, run_id: str, wait: bool, action: str):
        self.cancelled.append((task_id, run_id, action))


class _RunningThenSuccessfulRuns:
    call_count = 0

    def __init__(self, cancelled: list[tuple[str, str, str]]) -> None:
        self.cancelled = cancelled

    async def get(self, task_id: str, run_id: str):
        self.call_count += 1
        return {"status": "running" if self.call_count == 1 else "success"}

    async def cancel(self, task_id: str, run_id: str, wait: bool, action: str):
        self.cancelled.append((task_id, run_id, action))
        assert wait is True


class _RunningThenReadFailureRuns:
    call_count = 0

    def __init__(self, cancelled: list[tuple[str, str, str]]) -> None:
        self.cancelled = cancelled

    async def get(self, task_id: str, run_id: str):
        self.call_count += 1
        if self.call_count == 1:
            return {"status": "running"}
        raise RuntimeError("transient status read failure")

    async def cancel(self, task_id: str, run_id: str, wait: bool, action: str):
        self.cancelled.append((task_id, run_id, action))
        assert wait is True


async def _publish_finalizing_progress(app: FastAPI) -> None:
    await app.state._builder_canvas_worker.publish_progress({
        "parent_thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "sequence": 1,
        "event_name": "custom",
        "data": {"name": "phase", "phase": "finalizing"},
    })


async def _single_running_builder_task(_parent: str):
    return [{"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-1", "status": "running"}]


def _client_factory(runs):
    return lambda url: SimpleNamespace(runs=runs)


async def _post_cancel(app: FastAPI):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/runs/run-1/cancel"
        )


def test_thread_owner_validation_uses_direct_thread_lookup(monkeypatch) -> None:
    class Store:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "older-parent-thread"
            return SessionRecord(session_id="old-session", thread_id=thread_id, user_id=user_id)

        def list_recent(self, user_id: str, limit: int = 30):  # pragma: no cover - regression guard
            raise AssertionError("ownership checks must not use a capped recent-session scan")

    monkeypatch.setattr(builder_canvas, "_session_store", Store())

    builder_canvas._require_thread_owner("user-1", "older-parent-thread")


def test_langgraph_url_honors_deployed_env(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_LANGGRAPH_BASE_URL", raising=False)
    monkeypatch.delenv("SOPHIA_BACKEND_BASE_URL", raising=False)
    monkeypatch.setenv("LANGGRAPH_URL", "https://langgraph.render.internal/")

    assert builder_canvas._langgraph_url() == "https://langgraph.render.internal"


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
        "latest_activity": {
            "kind": "phase",
            "phase": "drafting",
            "category": "draft",
            "action": "creating_artifact",
            "label": "Creating artifact",
        },
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
async def test_snapshot_prefers_running_task_over_newer_terminal_task(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-old",
                "run_id": "run-old",
                "status": "success",
                "last_updated_at": "2026-05-25T10:05:00Z",
            },
            {
                "agent_name": "sophia_builder",
                "task_id": "task-new",
                "run_id": "run-new",
                "status": "running",
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
async def test_snapshot_includes_terminal_completion_artifact_data(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "trace_id": "trace-1",
                "task_type": "document",
                "last_updated_at": "2026-05-27T10:00:00Z",
                "builder_result": {
                    "artifact_path": "/mnt/user-data/outputs/report.md",
                    "artifact_title": "Report",
                    "artifact_type": "document",
                    "companion_summary": "Report is ready.",
                    "user_next_action": "Open it.",
                },
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    monkeypatch.setattr(
        builder_canvas,
        "_signed_artifact_url",
        lambda thread_id, artifact_path: f"https://signed.example/{thread_id}/{artifact_path}",
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    completion = response.json()["active_task"]["completion"]
    assert completion["status"] == "success"
    assert completion["artifact_path"] == "mnt/user-data/outputs/report.md"
    assert completion["artifact_url"] == "https://signed.example/parent-1/mnt/user-data/outputs/report.md"
    assert completion["artifact_filename"] == "report.md"
    assert completion["artifact_title"] == "Report"
    assert completion["summary"] == "Report is ready."
    assert completion["completed_at"] == "2026-05-27T10:00:00Z"


@pytest.mark.anyio
async def test_snapshot_downgrades_native_success_without_deliverable(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": "2026-05-27T10:00:00Z",
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["status"] == "failed"
    assert active_task["completion"]["status"] == "error"
    assert active_task["completion"]["error_message"] == "Builder finished without a deliverable artifact."


@pytest.mark.anyio
async def test_snapshot_prefers_retained_failed_terminal_over_native_success(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": "2026-05-27T10:00:00Z",
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    await app.state._builder_canvas_worker.publish_progress({
        "parent_thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "sequence": 1,
        "event_name": "custom",
        "data": {"name": "phase", "phase": "finalizing"},
    })
    await app.state._builder_canvas_worker.publish_completion({
        "thread_id": "parent-1",
        "task_id": "task-1",
        "run_id": "run-1",
        "status": "error",
        "error_message": "The referenced artifact was missing.",
    })

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["status"] == "failed"
    assert active_task["completion"]["status"] == "error"
    assert active_task["completion"]["error_message"] == "The referenced artifact was missing."


@pytest.mark.anyio
async def test_snapshot_preserves_timed_out_status_and_completion(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-timeout",
                "run_id": "run-timeout",
                "status": "timed_out",
                "last_updated_at": "2026-05-27T10:00:00Z",
                "error_message": "Builder timed out before the artifact was ready.",
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "timed_out"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["status"] == "timed_out"
    assert active_task["completion"]["status"] == "timeout"
    assert active_task["completion"]["error_message"] == "Builder timed out before the artifact was ready."
    assert active_task["completion"]["completed_at"] == "2026-05-27T10:00:00Z"


@pytest.mark.anyio
async def test_snapshot_rejects_thread_not_owned_by_user(app: FastAPI) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/other-parent/builder-canvas/snapshot")
    assert response.status_code == 404


@pytest.mark.anyio
async def test_snapshot_uses_authenticated_user_for_thread_ownership(
    app: FastAPI,
    monkeypatch,
) -> None:
    async def tasks(_parent: str):
        return []

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "other-user"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 404


@pytest.mark.anyio
async def test_cancel_validates_native_task_and_publishes_terminal(app: FastAPI, monkeypatch) -> None:
    cancelled: list[tuple[str, str, str]] = []

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", _single_running_builder_task)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(_RunningThenInterruptedRuns(cancelled)),
    )
    response = await _post_cancel(app)

    assert response.status_code == 200
    assert cancelled == [("task-1", "run-1", "interrupt")]
    events = await app.state._builder_canvas_worker.recent_events("parent-1")
    assert events[-1]["status"] == "cancelled"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("runs_factory", "expected_cancelled"),
    [
        (_AlreadySuccessfulRuns, []),
        (_RunningThenSuccessfulRuns, [("task-1", "run-1", "interrupt")]),
    ],
)
async def test_cancel_does_not_publish_cancel_when_native_status_is_success(
    app: FastAPI,
    monkeypatch,
    runs_factory,
    expected_cancelled,
) -> None:
    cancelled: list[tuple[str, str, str]] = []

    worker = app.state._builder_canvas_worker
    await _publish_finalizing_progress(app)
    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", _single_running_builder_task)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(runs_factory(cancelled)),
    )

    response = await _post_cancel(app)

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert cancelled == expected_cancelled
    events = await worker.recent_events("parent-1")
    assert len(events) == 1
    assert events[0]["kind"] == "progress"
    assert events[-1]["status"] == "running"


@pytest.mark.anyio
async def test_cancel_publishes_cancel_when_status_reread_fails_after_successful_cancel(
    app: FastAPI,
    monkeypatch,
) -> None:
    cancelled: list[tuple[str, str, str]] = []

    await _publish_finalizing_progress(app)
    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", _single_running_builder_task)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(_RunningThenReadFailureRuns(cancelled)),
    )

    response = await _post_cancel(app)

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    assert cancelled == [("task-1", "run-1", "interrupt")]
    events = await app.state._builder_canvas_worker.recent_events("parent-1")
    assert events[-1]["kind"] == "terminal"
    assert events[-1]["status"] == "cancelled"


@pytest.mark.anyio
async def test_cancel_resolves_latest_native_run_when_run_id_is_absent(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-old", "updated_at": "2026-05-25T10:00:00Z"},
            {"agent_name": "sophia_builder", "task_id": "task-1", "run_id": "run-new", "updated_at": "2026-05-25T10:01:00Z"},
        ]

    cancelled: list[tuple[str, str, str]] = []

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(_RunningThenInterruptedRuns(cancelled)),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/cancel"
        )

    assert response.status_code == 200
    assert response.json()["run_id"] == "run-new"
    assert cancelled == [("task-1", "run-new", "interrupt")]
