from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient, Response
from httpx import Request as HttpxRequest
from langgraph_sdk.errors import NotFoundError

from app.gateway.artifact_registry import ArtifactListResponse, ArtifactRecord
from app.gateway.auth import require_authorized_user_scope
from app.gateway.routers import builder_canvas
from app.gateway.workers.builder_canvas import install_builder_canvas_worker
from deerflow.sophia.session_store import SessionRecord, SessionStore


def _recent_timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


RECENT_TASK_TIMESTAMP = _recent_timestamp()


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


class _FakeThreads:
    def __init__(self, updates: list[tuple[str, dict]]) -> None:
        self.updates = updates

    async def update_state(self, thread_id: str, values: dict):
        self.updates.append((thread_id, values))
        return {"checkpoint": {"thread_id": thread_id}}


def _client_factory(runs, updates: list[tuple[str, dict]] | None = None):
    return lambda url: SimpleNamespace(runs=runs, threads=_FakeThreads(updates if updates is not None else []))


class _EmptyArtifactRegistry:
    def list(self, *, user_id: str, filters=None) -> ArtifactListResponse:
        return ArtifactListResponse(artifacts=[], total=0)


def _durable_builder_artifact(parent_thread_id: str) -> ArtifactRecord:
    timestamp = _recent_timestamp()
    return ArtifactRecord(
        artifact_id="artifact-deck-1",
        user_id="user-1",
        thread_id=parent_thread_id,
        session_id="session-legacy-parent",
        parent_thread_id=parent_thread_id,
        task_id="task-deck-1",
        run_id="run-deck-1",
        logical_artifact_id="logical-deck-1",
        version_id="version-deck-1",
        title="Recovered presentation",
        filename="recovered-presentation.pptx",
        artifact_type="presentation",
        renderer_kind="presentation",
        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        safe_summary="The presentation is ready.",
        source="builder",
        local_path="mnt/user-data/outputs/recovered-presentation.pptx",
        storage_provider="supabase",
        storage_bucket="builder-artifacts",
        storage_object_path="users/user-1/session-legacy-parent/artifact-deck-1/recovered-presentation.pptx",
        storage_status="available",
        created_at=timestamp,
        updated_at=timestamp,
        raw_content_excluded=True,
        signed_url_excluded=True,
    )


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


def _synthetic_canvas_session() -> SessionRecord:
    return SessionRecord(
        session_id="synthetic-session",
        thread_id="parent-1",
        user_id="user-1",
        run_id="test-run-1",
        metadata={
            "synthetic_voice_lab": {
                "synthetic": True,
                "principal_id": "user-1",
                "test_run_id": "test-run-1",
                "scenario_id": "builder-deck",
                "scenario_version": "v1",
                "environment": "production",
            }
        },
    )


@pytest.fixture
def app(tmp_path, monkeypatch) -> FastAPI:
    store = SessionStore(tmp_path / "users")
    store.create(SessionRecord(session_id="session-1", thread_id="parent-1", user_id="user-1"))
    monkeypatch.setattr(builder_canvas, "_session_store", store)
    monkeypatch.setattr(builder_canvas, "_artifact_registry", _EmptyArtifactRegistry())
    app = FastAPI()
    install_builder_canvas_worker(app)
    app.include_router(builder_canvas.router)
    app.dependency_overrides[require_authorized_user_scope] = lambda: "user-1"
    return app


@pytest.mark.anyio
async def test_parent_builder_tasks_maps_langgraph_not_found_to_404(monkeypatch) -> None:
    class MissingThreads:
        async def get_state(self, _thread_id: str):
            response = Response(404, request=HttpxRequest("GET", "https://langgraph.test/threads/missing/state"))
            raise NotFoundError("Thread not found", response=response, body=None)

    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        lambda url: SimpleNamespace(threads=MissingThreads()),
    )

    with pytest.raises(HTTPException) as exc_info:
        await builder_canvas._parent_builder_tasks("missing-parent")

    assert exc_info.value.status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("method", "path", "required_operation"),
    [
        ("GET", "/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot", "session:read"),
        ("GET", "/api/sophia/user-1/threads/parent-1/builder-canvas/events", "session:read"),
        (
            "POST",
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/runs/run-1/cancel",
            "session:finalize",
        ),
        (
            "POST",
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/cancel",
            "session:finalize",
        ),
    ],
)
async def test_synthetic_canvas_routes_require_capability_before_task_state_access(
    app: FastAPI,
    monkeypatch,
    method: str,
    path: str,
    required_operation: str,
) -> None:
    record = _synthetic_canvas_session()

    class Store:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert (user_id, thread_id) == ("user-1", "parent-1")
            return record

    operations: list[str] = []

    def no_capability(_request, user_id: str, *, required_operation: str):
        assert user_id == "user-1"
        operations.append(required_operation)
        return None

    def downstream_access_forbidden(*_args, **_kwargs):
        raise AssertionError("synthetic route touched canvas state before capability authorization")

    async def async_downstream_access_forbidden(*_args, **_kwargs):
        downstream_access_forbidden()

    monkeypatch.setattr(builder_canvas, "_session_store", Store())
    monkeypatch.setattr(builder_canvas, "capability_for_gateway_action", no_capability)
    monkeypatch.setattr(builder_canvas, "get_builder_canvas_worker", downstream_access_forbidden)
    monkeypatch.setattr(builder_canvas, "_authorized_task", async_downstream_access_forbidden)
    monkeypatch.setattr(builder_canvas, "_authorized_latest_task", async_downstream_access_forbidden)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.request(method, path)

    assert response.status_code == 401
    assert response.json()["detail"] == {"code": "voice_lab_capability_missing"}
    assert operations == [required_operation]


@pytest.mark.anyio
async def test_synthetic_canvas_snapshot_accepts_exact_bound_read_capability(
    app: FastAPI,
    monkeypatch,
) -> None:
    record = _synthetic_canvas_session()
    claims = object()
    checked: list[tuple[object, object]] = []

    class Store:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert (user_id, thread_id) == ("user-1", "parent-1")
            return record

    def capability(request, user_id: str, *, required_operation: str):
        assert request.headers["x-sophia-voice-lab-capability"] == "exact-token"
        assert user_id == "user-1"
        assert required_operation == "session:read"
        return claims

    def assert_record(candidate, candidate_claims):
        checked.append((candidate, candidate_claims))
        return True

    async def no_tasks(_parent_thread_id: str):
        return []

    monkeypatch.setattr(builder_canvas, "_session_store", Store())
    monkeypatch.setattr(builder_canvas, "capability_for_gateway_action", capability)
    monkeypatch.setattr(builder_canvas, "assert_voice_lab_session_record", assert_record)
    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", no_tasks)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot",
            headers={"X-Sophia-Voice-Lab-Capability": "exact-token"},
        )

    assert response.status_code == 200
    assert response.json() == {"version": 1, "active_task": None, "recent_events": []}
    assert checked == [(record, claims)]


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
async def test_snapshot_recovers_uuid_parent_terminal_from_retained_canvas_event(
    app: FastAPI,
    monkeypatch,
) -> None:
    parent_thread_id = "0198c1e8-0f3a-7a1b-8f4c-2c2e8d5f0a11"
    builder_canvas._session_store.create(
        SessionRecord(session_id="session-uuid-parent", thread_id=parent_thread_id, user_id="user-1")
    )

    async def no_native_tasks(_parent: str):
        return []

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", no_native_tasks)
    await app.state._builder_canvas_worker.publish_completion({
        "thread_id": parent_thread_id,
        "task_id": "task-uuid-parent",
        "run_id": "run-uuid-parent",
        "status": "error",
        "error_message": "Deck preparation failed.",
        "builder_failure_diagnostics": {
            "schema": "builder_failure_diagnostics_v1",
            "failure_code": "deck_prepare_retry_exhausted",
        },
    })

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            f"/api/sophia/user-1/threads/{parent_thread_id}/builder-canvas/snapshot"
        )

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["task_id"] == "task-uuid-parent"
    assert active_task["run_id"] == "run-uuid-parent"
    assert active_task["status"] == "failed"
    assert active_task["completion"]["status"] == "error"
    assert active_task["completion"]["error_message"] == "Deck preparation failed."


@pytest.mark.anyio
async def test_snapshot_recovers_missing_legacy_parent_from_durable_artifact(
    app: FastAPI,
    monkeypatch,
) -> None:
    parent_thread_id = "0198c1e8-0f3a-7a1b-8f4c-2c2e8d5f0a22"
    builder_canvas._session_store.create(
        SessionRecord(session_id="session-legacy-parent", thread_id=parent_thread_id, user_id="user-1")
    )

    async def missing_parent(_parent: str):
        raise HTTPException(status_code=404, detail="Builder parent thread is unavailable")

    record = _durable_builder_artifact(parent_thread_id)

    class Registry:
        def list(self, *, user_id: str, filters=None) -> ArtifactListResponse:
            assert user_id == "user-1"
            assert filters.thread_id == parent_thread_id
            assert filters.include_hidden is False
            return ArtifactListResponse(artifacts=[record], total=1)

    async def unexpected_native_status(*_args):  # pragma: no cover - regression guard
        raise AssertionError("registry recovery must not query a missing native run")

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", missing_parent)
    monkeypatch.setattr(builder_canvas, "_artifact_registry", Registry())
    monkeypatch.setattr(builder_canvas, "_native_run_status", unexpected_native_status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            f"/api/sophia/user-1/threads/{parent_thread_id}/builder-canvas/snapshot"
        )

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["task_id"] == "task-deck-1"
    assert active_task["run_id"] == "run-deck-1"
    assert active_task["status"] == "completed"
    assert active_task["completion"]["status"] == "success"
    assert active_task["completion"]["artifact_id"] == "artifact-deck-1"
    assert active_task["completion"]["artifact_path"] == (
        "mnt/user-data/outputs/recovered-presentation.pptx"
    )


@pytest.mark.anyio
async def test_snapshot_returns_empty_when_legacy_parent_and_registry_artifact_are_missing(
    app: FastAPI,
    monkeypatch,
) -> None:
    parent_thread_id = "0198c1e8-0f3a-7a1b-8f4c-2c2e8d5f0a33"
    builder_canvas._session_store.create(
        SessionRecord(session_id="session-empty-parent", thread_id=parent_thread_id, user_id="user-1")
    )

    async def missing_parent(_parent: str):
        raise HTTPException(status_code=404, detail="Builder parent thread is unavailable")

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", missing_parent)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            f"/api/sophia/user-1/threads/{parent_thread_id}/builder-canvas/snapshot"
        )

    assert response.status_code == 200
    assert response.json() == {"version": 1, "active_task": None, "recent_events": []}


@pytest.mark.anyio
async def test_snapshot_does_not_mask_transient_native_state_outage(
    app: FastAPI,
    monkeypatch,
) -> None:
    parent_thread_id = "0198c1e8-0f3a-7a1b-8f4c-2c2e8d5f0a44"
    builder_canvas._session_store.create(
        SessionRecord(session_id="session-outage-parent", thread_id=parent_thread_id, user_id="user-1")
    )

    async def unavailable_parent(_parent: str):
        raise HTTPException(status_code=503, detail="Builder state is unavailable")

    class UnexpectedRegistry:
        def list(self, **_kwargs):  # pragma: no cover - regression guard
            raise AssertionError("transient outages must not use artifact reconciliation")

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", unavailable_parent)
    monkeypatch.setattr(builder_canvas, "_artifact_registry", UnexpectedRegistry())

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            f"/api/sophia/user-1/threads/{parent_thread_id}/builder-canvas/snapshot"
        )

    assert response.status_code == 503


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
                "last_updated_at": RECENT_TASK_TIMESTAMP,
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
        lambda thread_id, artifact_path, **_kwargs: f"https://signed.example/{thread_id}/{artifact_path}",
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
    assert completion["completed_at"] == RECENT_TASK_TIMESTAMP


@pytest.mark.anyio
async def test_snapshot_resigns_durable_artifact_with_storage_object_path(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
                "builder_result": {
                    "artifact_path": "mnt/user-data/outputs/report.md",
                    "artifact_id": "artifact-123",
                    "storage_provider": "supabase",
                    "storage_bucket": "sophia_builder",
                    "storage_object_path": "artifacts/user-1/parent-1/artifact_123/report.md",
                    "storage_status": "available",
                    "manifest_path": "artifacts/user-1/parent-1/foundation/.builder/builds/build-1/manifest.json",
                    "manifest_revision": 2,
                    "logical_artifact_id": "logical-1",
                    "current_artifact_version_id": "version-2",
                    "foundation_status": "committed",
                    "artifact_title": "Report",
                    "artifact_type": "document",
                },
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    signed_calls: list[tuple[str, str | None, str | None, str | None]] = []

    def signed_url(
        thread_id: str,
        artifact_path: str | None,
        *,
        storage_object_path: str | None = None,
        authenticated_user_id: str | None = None,
    ) -> str:
        signed_calls.append((thread_id, artifact_path, storage_object_path, authenticated_user_id))
        return f"https://signed.example/{storage_object_path}"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    monkeypatch.setattr(builder_canvas, "_signed_artifact_url", signed_url)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    completion = response.json()["active_task"]["completion"]
    assert completion["artifact_url"] == "https://signed.example/artifacts/user-1/parent-1/artifact_123/report.md"
    assert completion["artifact_id"] == "artifact-123"
    assert completion["storage_provider"] == "supabase"
    assert completion["storage_bucket"] == "sophia_builder"
    assert completion["storage_object_path"] == "artifacts/user-1/parent-1/artifact_123/report.md"
    assert completion["storage_status"] == "available"
    assert completion["manifest_revision"] == 2
    assert completion["logical_artifact_id"] == "logical-1"
    assert completion["current_artifact_version_id"] == "version-2"
    assert completion["foundation_status"] == "committed"
    assert signed_calls == [
        (
            "parent-1",
            "mnt/user-data/outputs/report.md",
            "artifacts/user-1/parent-1/artifact_123/report.md",
            "user-1",
        )
    ]


@pytest.mark.anyio
async def test_snapshot_refuses_internal_storage_object_path(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
                "builder_result": {
                    "artifact_path": "mnt/user-data/outputs/report.md",
                    "storage_object_path": "parent-1/ledger/session.jsonl",
                    "artifact_title": "Report",
                    "artifact_type": "document",
                },
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    def create_signed_url(**_kwargs):  # pragma: no cover - must not be reached
        raise AssertionError("internal storage object paths must not be signed")

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.create_signed_url",
        create_signed_url,
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    completion = response.json()["active_task"]["completion"]
    assert completion["artifact_url"] is None
    assert completion["artifact_path"] == "mnt/user-data/outputs/report.md"


@pytest.mark.anyio
async def test_snapshot_downgrades_native_success_without_deliverable(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    async def no_payload(_task: dict):
        return None

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    monkeypatch.setattr(builder_canvas, "_builder_thread_artifact_payload", no_payload)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["status"] == "failed"
    assert active_task["completion"]["status"] == "error"
    assert active_task["completion"]["error_message"] == "Builder finished without a deliverable artifact."
    diagnostic = active_task["completion"]["builder_failure_diagnostics"]
    assert diagnostic["task_id"] == "task-1"
    assert diagnostic["run_id"] == "run-1"
    assert diagnostic["failure_stage"] == "completion_reconciliation"
    assert diagnostic["failure_code"] == "builder_completed_without_deliverable"
    assert diagnostic["canvas_reconciliation_action"] == "coerced_success_to_failed_no_deliverable"


@pytest.mark.anyio
async def test_snapshot_hydrates_completed_deliverable_from_builder_thread_state(
    app: FastAPI,
    monkeypatch,
) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "thread_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "task_type": "visual_report",
                "artifact_target_path": "/mnt/user-data/outputs/build.html",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    async def builder_payload(task: dict):
        assert task["thread_id"] == "task-1"
        return {
            "artifact_path": "/mnt/user-data/outputs/report.html",
            "artifact_title": "Recovered HTML report",
            "artifact_type": "html",
            "companion_summary": "Report is ready.",
        }

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    monkeypatch.setattr(builder_canvas, "_builder_thread_artifact_payload", builder_payload)
    monkeypatch.setattr(
        builder_canvas,
        "_signed_artifact_url",
        lambda thread_id, artifact_path, **_kwargs: f"https://signed.example/{thread_id}/{artifact_path}",
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["status"] == "completed"
    assert active_task["completion"]["status"] == "success"
    assert active_task["completion"]["artifact_path"] == "mnt/user-data/outputs/report.html"
    assert active_task["completion"]["artifact_url"] == "https://signed.example/parent-1/mnt/user-data/outputs/report.html"
    assert active_task["completion"]["artifact_title"] == "Recovered HTML report"
    assert active_task["completion"]["summary"] == "Report is ready."


@pytest.mark.anyio
async def test_snapshot_reconstructs_html_fallback_metadata_for_requested_pptx(
    app: FastAPI,
    monkeypatch,
) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "thread_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "task_type": "presentation",
                "artifact_target_path": "/mnt/user-data/outputs/deck.pptx",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):
        return "completed"

    async def builder_payload(_task: dict):
        return {
            "artifact_path": "/mnt/user-data/outputs/deck.html",
            "artifact_title": "Deck fallback",
            "artifact_type": "webpage",
            "companion_summary": "Fallback is ready.",
        }

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)
    monkeypatch.setattr(builder_canvas, "_builder_thread_artifact_payload", builder_payload)
    monkeypatch.setattr(builder_canvas, "_signed_artifact_url", lambda _thread_id, _artifact_path, **_kwargs: None)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    completion = response.json()["active_task"]["completion"]
    assert completion["status"] == "success"
    assert completion["artifact_path"] == "mnt/user-data/outputs/deck.html"
    assert completion["requested_artifact_ext"] == "pptx"
    assert completion["artifact_ext"] == "html"
    assert completion["artifact_is_fallback"] is True
    assert completion["fallback_reason"] == "pptx_generation_not_completed"


@pytest.mark.anyio
async def test_snapshot_preserves_retained_successful_terminal_with_artifact(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
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
        "status": "success",
        "artifact_path": "mnt/user-data/outputs/report.html",
        "artifact_filename": "report.html",
    })

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    active_task = response.json()["active_task"]
    assert active_task["status"] == "completed"
    assert active_task["completion"]["status"] == "success"
    assert active_task["completion"]["artifact_path"] == "mnt/user-data/outputs/report.html"
    assert active_task["completion"]["artifact_filename"] == "report.html"


@pytest.mark.anyio
async def test_snapshot_prefers_retained_failed_terminal_over_native_success(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "success",
                "last_updated_at": RECENT_TASK_TIMESTAMP,
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
                "last_updated_at": RECENT_TASK_TIMESTAMP,
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
    assert active_task["completion"]["completed_at"] == RECENT_TASK_TIMESTAMP


@pytest.mark.anyio
async def test_snapshot_does_not_resurrect_stale_terminal_task(app: FastAPI, monkeypatch) -> None:
    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-old",
                "run_id": "run-old",
                "status": "success",
                "last_updated_at": "2026-01-01T10:00:00Z",
                "builder_result": {
                    "artifact_path": "/mnt/user-data/outputs/old-report.md",
                    "artifact_title": "Old Report",
                },
            }
        ]

    async def status(_task: str, _run: str, _fallback: str | None):  # pragma: no cover
        raise AssertionError("stale terminal tasks should not be hydrated")

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    assert response.json()["active_task"] is None
    assert response.json()["recent_events"] == []


@pytest.mark.anyio
async def test_snapshot_does_not_resurrect_stale_cached_running_task_after_native_completion(
    app: FastAPI,
    monkeypatch,
) -> None:
    native_status_calls: list[tuple[str, str]] = []

    async def tasks(_parent: str):
        return [
            {
                "agent_name": "sophia_builder",
                "task_id": "task-stale",
                "run_id": "run-stale",
                "status": "running",
                "last_updated_at": "2026-01-01T10:00:00Z",
                "builder_result": {
                    "artifact_path": "/mnt/user-data/outputs/stale-report.md",
                    "artifact_title": "Stale Report",
                },
            }
        ]

    async def status(task_id: str, run_id: str, _fallback: str | None):
        native_status_calls.append((task_id, run_id))
        return "completed"

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(builder_canvas, "_native_run_status", status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/sophia/user-1/threads/parent-1/builder-canvas/snapshot")

    assert response.status_code == 200
    assert native_status_calls == [("task-stale", "run-stale")]
    assert response.json()["active_task"] is None
    assert response.json()["recent_events"] == []


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
    state_updates: list[tuple[str, dict]] = []

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", _single_running_builder_task)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(_RunningThenInterruptedRuns(cancelled), state_updates),
    )
    response = await _post_cancel(app)

    assert response.status_code == 200
    assert cancelled == [("task-1", "run-1", "interrupt")]
    assert len(state_updates) == 1
    assert state_updates[0][0] == "parent-1"
    _assert_persisted_cancelled_task(state_updates[0][1]["async_tasks"]["task-1"])
    events = await app.state._builder_canvas_worker.recent_events("parent-1")
    assert events[-1]["status"] == "cancelled"


def _assert_persisted_cancelled_task(persisted_task: dict) -> None:
    expected = {
        "agent_name": "sophia_builder",
        "task_id": "task-1",
        "run_id": "run-1",
        "status": "cancelled",
        "error_message": "Builder was cancelled by the user.",
    }
    for key, value in expected.items():
        assert persisted_task[key] == value
    assert persisted_task["completed_at"]
    for timestamp_key in ("last_checked_at", "last_updated_at", "updated_at"):
        assert persisted_task[timestamp_key] == persisted_task["completed_at"]


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
    state_updates: list[tuple[str, dict]] = []

    worker = app.state._builder_canvas_worker
    await _publish_finalizing_progress(app)
    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", _single_running_builder_task)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(runs_factory(cancelled), state_updates),
    )

    response = await _post_cancel(app)

    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert cancelled == expected_cancelled
    assert state_updates == []
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
    state_updates: list[tuple[str, dict]] = []

    await _publish_finalizing_progress(app)
    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", _single_running_builder_task)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(_RunningThenReadFailureRuns(cancelled), state_updates),
    )

    response = await _post_cancel(app)

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    assert cancelled == [("task-1", "run-1", "interrupt")]
    assert state_updates[0][0] == "parent-1"
    assert state_updates[0][1]["async_tasks"]["task-1"]["status"] == "cancelled"
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
    state_updates: list[tuple[str, dict]] = []

    monkeypatch.setattr(builder_canvas, "_parent_builder_tasks", tasks)
    monkeypatch.setattr(
        builder_canvas,
        "get_client",
        _client_factory(_RunningThenInterruptedRuns(cancelled), state_updates),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/api/sophia/user-1/threads/parent-1/builder-canvas/tasks/task-1/cancel"
        )

    assert response.status_code == 200
    assert response.json()["run_id"] == "run-new"
    assert cancelled == [("task-1", "run-new", "interrupt")]
    assert state_updates[0][1]["async_tasks"]["task-1"]["run_id"] == "run-new"
    assert state_updates[0][1]["async_tasks"]["task-1"]["status"] == "cancelled"
