from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.gateway.routers.artifacts as artifacts_router
import app.gateway.routers.builder_events as builder_events_router
from app.gateway.artifact_registry import (
    ArtifactRegistryFilters,
    ArtifactUpsertRequest,
    LocalArtifactRegistry,
)
from app.gateway.auth import require_authenticated_user
from deerflow.sophia.session_store import SessionRecord, SessionStore


def _request(**overrides) -> ArtifactUpsertRequest:
    base = {
        "thread_id": "thread-1",
        "session_id": "session-1",
        "title": "Launch Page",
        "artifact_type": "webpage",
        "renderer_kind": "html",
        "mime_type": "text/html",
        "safe_summary": "Safe dashboard summary.",
        "source": "builder",
        "local_path": "mnt/user-data/outputs/launch.html",
        "created_at": "2026-06-01T10:00:00+00:00",
        "raw_content_excluded": True,
        "signed_url_excluded": True,
    }
    base.update(overrides)
    return ArtifactUpsertRequest(**base)


def _owned_app(tmp_path, monkeypatch) -> tuple[TestClient, LocalArtifactRegistry]:
    registry = LocalArtifactRegistry(tmp_path / "artifact-registry")
    store = SessionStore(tmp_path / "users")
    store.create(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    monkeypatch.setattr(artifacts_router, "_artifact_registry", registry)
    monkeypatch.setattr(artifacts_router, "_session_store", store)

    app = FastAPI()
    app.include_router(artifacts_router.router)
    app.dependency_overrides[require_authenticated_user] = lambda: "user-1"
    return TestClient(app), registry


def test_registry_upsert_is_idempotent(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    first = registry.upsert(_request(), user_id="user-1")
    second = registry.upsert(_request(title="Launch Page Updated"), user_id="user-1")

    assert second.artifact_id == first.artifact_id
    assert second.title == "Launch Page Updated"
    assert second.created_at == first.created_at
    assert registry.list(user_id="user-1").total == 1


def test_registry_is_user_scoped(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    registry.upsert(_request(), user_id="user-1")
    registry.upsert(_request(thread_id="thread-2", local_path="outputs/other.pdf"), user_id="user-2")

    assert registry.list(user_id="user-1").total == 1
    assert registry.list(user_id="user-2").artifacts[0].thread_id == "thread-2"
    assert registry.list(user_id="missing-user").total == 0


def test_registry_rejects_unsafe_paths_and_raw_content(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)

    try:
        registry.upsert(_request(local_path="C:/Users/alice/secrets.html"), user_id="user-1")
    except HTTPException as exc:
        assert exc.status_code == 403
    else:  # pragma: no cover - defensive assertion.
        raise AssertionError("unsafe path was accepted")

    with pytest.raises(ValidationError, match="raw content"):
        ArtifactUpsertRequest(**{
            "thread_id": "thread-1",
            "local_path": "outputs/private.html",
            "raw_content": "<html>secret</html>",
        })


def test_registry_list_filters_by_type_source_thread_date_and_search(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    registry.upsert(
        _request(
            artifact_type="webpage",
            local_path="outputs/launch.html",
            title="Launch Page",
            safe_summary="Public launch summary",
            source="builder",
            created_at="2026-06-01T10:00:00+00:00",
        ),
        user_id="user-1",
    )
    registry.upsert(
        _request(
            artifact_type="pdf",
            renderer_kind="pdf",
            local_path="outputs/report.pdf",
            title="Quarterly Report",
            safe_summary="Finance summary",
            source="file_library_backfill",
            created_at="2026-06-05T10:00:00+00:00",
        ),
        user_id="user-1",
    )
    registry.upsert(
        _request(
            thread_id="thread-2",
            session_id="session-2",
            artifact_type="markdown",
            renderer_kind="markdown",
            local_path="outputs/notes.md",
            title="Notes",
            source="builder",
            created_at="2026-06-07T10:00:00+00:00",
        ),
        user_id="user-1",
    )

    html = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(artifact_type="html"))
    assert [artifact.filename for artifact in html.artifacts] == ["launch.html"]

    source = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(source="file_library_backfill"))
    assert [artifact.filename for artifact in source.artifacts] == ["report.pdf"]

    thread = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(thread_id="thread-2"))
    assert [artifact.filename for artifact in thread.artifacts] == ["notes.md"]

    dated = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(created_after="2026-06-04T00:00:00+00:00"))
    assert {artifact.filename for artifact in dated.artifacts} == {"report.pdf", "notes.md"}

    searched = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(search="finance"))
    assert [artifact.filename for artifact in searched.artifacts] == ["report.pdf"]


def test_registry_hides_builder_handoff_wrappers_by_default(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    markdown = registry.upsert(
        _request(
            title="Durable Registry Smoke Markdown",
            artifact_type="markdown",
            renderer_kind="markdown",
            mime_type="text/markdown",
            local_path="outputs/durable-registry-smoke-markdown.md",
        ),
        user_id="user-1",
    )
    wrapper = registry.upsert(
        _request(
            title="Durable Artifact Registry Smoke Test - Handoff Wrapper",
            artifact_type="html",
            renderer_kind="html",
            mime_type="text/html",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
        ),
        user_id="user-1",
    )

    assert markdown.artifact_role == "primary"
    assert markdown.is_library_visible is True
    assert wrapper.artifact_role == "wrapper"
    assert wrapper.is_library_visible is False
    assert [artifact.filename for artifact in registry.list(user_id="user-1").artifacts] == [
        "durable-registry-smoke-markdown.md"
    ]

    hidden = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    assert {artifact.filename for artifact in hidden.artifacts} == {
        "durable-registry-smoke-markdown.md",
        "create-a-real-markdown-artifact-file-nam.html",
    }


def test_registry_hides_backfilled_support_and_wrapper_artifacts(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    registry.upsert(
        _request(
            source="file_library_backfill",
            artifact_type="html",
            renderer_kind="html",
            title="Durable Artifact Registry Smoke Test - Handoff Wrapper",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
        ),
        user_id="user-1",
    )
    registry.upsert(
        _request(
            source="file_library_backfill",
            artifact_type="image",
            renderer_kind="image",
            title="Support Chart",
            local_path="outputs/visuals/chart.png",
        ),
        user_id="user-1",
    )
    registry.upsert(
        _request(
            source="file_library_backfill",
            artifact_type="markdown",
            renderer_kind="markdown",
            title="Readable Notes",
            local_path="outputs/readable-notes.md",
        ),
        user_id="user-1",
    )

    visible = registry.list(user_id="user-1")
    assert [artifact.filename for artifact in visible.artifacts] == ["readable-notes.md"]

    all_records = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    by_name = {artifact.filename: artifact for artifact in all_records.artifacts}
    assert by_name["create-a-real-markdown-artifact-file-nam.html"].artifact_role == "wrapper"
    assert by_name["chart.png"].artifact_role == "support"
    assert by_name["readable-notes.md"].artifact_role == "primary"


def test_registry_keeps_explicit_html_artifacts_library_visible(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    record = registry.upsert(
        _request(
            title="Interactive Launch Page",
            artifact_type="webpage",
            renderer_kind="html",
            mime_type="text/html",
            local_path="outputs/interactive-launch-page.html",
            requested_artifact_ext="html",
            artifact_ext="html",
        ),
        user_id="user-1",
    )

    assert record.artifact_type == "html"
    assert record.artifact_role == "primary"
    assert record.is_library_visible is True
    assert registry.list(user_id="user-1").artifacts[0].filename == "interactive-launch-page.html"


def test_registry_classifies_non_fallback_html_for_markdown_request_as_wrapper(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    wrapper = registry.upsert(
        _request(
            title="Create a real markdown artifact file",
            artifact_type="html",
            renderer_kind="html",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
            requested_artifact_ext="md",
            artifact_ext="html",
            artifact_is_fallback=False,
        ),
        user_id="user-1",
    )

    assert wrapper.artifact_role == "wrapper"
    assert wrapper.is_library_visible is False
    assert registry.list(user_id="user-1").total == 0


def test_open_endpoint_returns_canvas_target(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    artifact = registry.upsert(_request(), user_id="user-1")

    response = client.post(f"/api/artifacts/{artifact.artifact_id}/open")

    assert response.status_code == 200
    body = response.json()
    assert body["canvas_target"] == {
        "artifact_id": artifact.artifact_id,
        "thread_id": "thread-1",
        "session_id": "session-1",
        "artifact_path": "mnt/user-data/outputs/launch.html",
        "renderer_kind": "html",
        "mime_type": "text/html",
        "title": "Launch Page",
        "review_room_supported": True,
    }
    assert body["artifact"]["opened_count"] == 1


def test_open_endpoint_still_returns_canvas_target_for_visible_markdown(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    artifact = registry.upsert(
        _request(
            title="Durable Registry Smoke Markdown",
            artifact_type="markdown",
            renderer_kind="markdown",
            mime_type="text/markdown",
            local_path="outputs/durable-registry-smoke-markdown.md",
        ),
        user_id="user-1",
    )

    response = client.post(f"/api/artifacts/{artifact.artifact_id}/open")

    assert response.status_code == 200
    body = response.json()
    assert body["artifact"]["is_library_visible"] is True
    assert body["canvas_target"]["artifact_path"] == "mnt/user-data/outputs/durable-registry-smoke-markdown.md"
    assert body["canvas_target"]["renderer_kind"] == "markdown"


def test_list_endpoint_hides_wrappers_by_default(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    registry.upsert(
        _request(
            title="Durable Registry Smoke Markdown",
            artifact_type="markdown",
            renderer_kind="markdown",
            local_path="outputs/durable-registry-smoke-markdown.md",
        ),
        user_id="user-1",
    )
    registry.upsert(
        _request(
            title="Durable Artifact Registry Smoke Test - Handoff Wrapper",
            artifact_type="html",
            renderer_kind="html",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
        ),
        user_id="user-1",
    )

    response = client.get("/api/artifacts")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [artifact["filename"] for artifact in body["artifacts"]] == ["durable-registry-smoke-markdown.md"]

    hidden_response = client.get("/api/artifacts?include_hidden=true")
    assert hidden_response.status_code == 200
    hidden_body = hidden_response.json()
    assert hidden_body["total"] == 2


def test_download_endpoint_redirects_to_existing_thread_artifact_route(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    artifact = registry.upsert(
        _request(local_path="outputs/Quarterly Report.pdf", renderer_kind="pdf", artifact_type="pdf"),
        user_id="user-1",
    )

    response = client.get(f"/api/artifacts/{artifact.artifact_id}/download", follow_redirects=False)

    assert response.status_code == 307
    assert response.headers["location"] == (
        "/api/threads/thread-1/artifacts/mnt/user-data/outputs/Quarterly%20Report.pdf?download=true"
    )


def test_builder_terminal_event_upserts_registry_metadata(tmp_path, monkeypatch) -> None:
    registry = LocalArtifactRegistry(tmp_path / "artifact-registry")
    store = SessionStore(tmp_path / "users")
    store.create(SessionRecord(session_id="session-1", thread_id="parent-thread", user_id="user-1"))
    monkeypatch.setattr(builder_events_router, "_artifact_registry", registry)
    monkeypatch.setattr(builder_events_router, "_session_store", store)
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.is_configured",
        lambda: False,
    )

    builder_events_router._upsert_builder_terminal_artifact({
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "run-1",
        "trace_id": "trace-1",
        "status": "success",
        "artifact_path": "mnt/user-data/outputs/brief.md",
        "artifact_url": "https://signed.example/temporary",
        "artifact_title": "Builder Brief",
        "artifact_type": "document",
        "summary": "Safe brief summary",
        "completed_at": "2026-06-01T10:00:00+00:00",
        "user_id": "user-1",
    })

    artifacts = registry.list(user_id="user-1").artifacts
    assert len(artifacts) == 1
    record = artifacts[0]
    assert record.thread_id == "parent-thread"
    assert record.session_id == "session-1"
    assert record.task_id == "builder-task"
    assert record.run_id == "run-1"
    assert record.filename == "brief.md"
    assert record.artifact_type == "markdown"
    assert record.artifact_role == "primary"
    assert record.is_library_visible is True
    assert record.safe_summary == "Safe brief summary"
    serialized = record.model_dump_json()
    assert "signed.example" not in serialized
    assert "artifact_url" not in serialized
