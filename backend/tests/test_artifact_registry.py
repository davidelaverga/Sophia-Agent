from __future__ import annotations

import json
import logging
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.gateway.artifact_registry as artifact_registry_module
import app.gateway.routers.artifacts as artifacts_router
import app.gateway.routers.builder_events as builder_events_router
from app.gateway.artifact_registry import (
    ArtifactRegistry,
    ArtifactRegistryConfigurationError,
    ArtifactRegistryFilters,
    ArtifactUpsertRequest,
    LocalArtifactRegistry,
    SupabaseArtifactRegistry,
    SupabaseArtifactRegistryConfig,
)
from app.gateway.auth import require_authenticated_user
from deerflow.sophia.session_store import SessionRecord, SessionStore

KNOWN_ARTIFACT_ID = "artifact_2f8254e3547d87ab29e56bef"


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


class FakeSupabaseArtifactPostgrest:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        table = request.url.path.rstrip("/").split("/")[-1]
        if table != "artifact_registry_records":
            return httpx.Response(404, json={"error": "unknown table"})
        params = {key: values[-1] for key, values in parse_qs(request.url.query.decode()).items()}
        if request.method == "POST":
            rows = json.loads(request.content.decode("utf-8")) if request.content else []
            for row in rows:
                artifact_id = row["artifact_id"]
                merged = dict(self.rows.get(artifact_id, {}))
                merged.update(row)
                self.rows[artifact_id] = merged
            return httpx.Response(201, json=[self.rows[row["artifact_id"]] for row in rows])
        if request.method == "GET":
            rows = [row for row in self.rows.values() if self._matches(row, params)]
            rows.sort(key=lambda row: row.get("updated_at") or "", reverse=True)
            if limit := params.get("limit"):
                rows = rows[: int(limit)]
            return httpx.Response(200, json=rows)
        return httpx.Response(405)

    def _matches(self, row: dict, params: dict[str, str]) -> bool:
        for key in ("artifact_id", "user_id", "thread_id", "session_id"):
            value = params.get(key)
            if value and value.startswith("eq.") and str(row.get(key)) != value[3:]:
                return False
        return True


def _supabase_registry(fake: FakeSupabaseArtifactPostgrest) -> SupabaseArtifactRegistry:
    client = httpx.Client(transport=httpx.MockTransport(fake.handler))
    return SupabaseArtifactRegistry(
        SupabaseArtifactRegistryConfig(
            url="https://example.supabase.co",
            service_role_key="service-role",
            bucket="sophia-builder-artifacts",
        ),
        client=client,
    )


def _diagnostic_payloads(caplog: pytest.LogCaptureFixture, event: str) -> list[dict]:
    payloads: list[dict] = []
    for record in caplog.records:
        message = record.getMessage()
        if not message.startswith(f"{event} "):
            continue
        _, _, payload = message.partition(" ")
        payloads.append(json.loads(payload))
    return payloads


def test_registry_default_storage_base_is_backend_users(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_ARTIFACT_REGISTRY_BASE_PATH", raising=False)

    registry = LocalArtifactRegistry()

    assert registry._base == artifact_registry_module._BACKEND_ROOT / "users"


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


def test_local_registry_rejects_unsafe_user_ids(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)

    with pytest.raises(HTTPException) as exc_info:
        registry.list(user_id="../user-1")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Invalid artifact user scope"
    assert not (tmp_path.parent / "user-1" / "artifacts" / "registry.json").exists()


def test_artifact_routes_reject_unsafe_authenticated_user_id(tmp_path, monkeypatch) -> None:
    registry = LocalArtifactRegistry(tmp_path / "artifact-registry")
    store = SessionStore(tmp_path / "users")
    monkeypatch.setattr(artifacts_router, "_artifact_registry", registry)
    monkeypatch.setattr(artifacts_router, "_session_store", store)

    app = FastAPI()
    app.include_router(artifacts_router.router)
    app.dependency_overrides[require_authenticated_user] = lambda: "../user-1"

    response = TestClient(app).get("/api/artifacts")

    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid artifact user scope"


def test_registry_rejects_unsafe_paths_and_raw_content(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)

    try:
        registry.upsert(_request(local_path="C:/Users/alice/secrets.html"), user_id="user-1")
    except HTTPException as exc:
        assert exc.status_code == 403
    else:  # pragma: no cover - defensive assertion.
        raise AssertionError("unsafe path was accepted")

    try:
        registry.upsert(_request(local_path="outputs/../secrets.html"), user_id="user-1")
    except HTTPException as exc:
        assert exc.status_code == 403
    else:  # pragma: no cover - defensive assertion.
        raise AssertionError("traversal path was accepted")

    with pytest.raises(ValidationError, match="raw content"):
        ArtifactUpsertRequest(**{
            "thread_id": "thread-1",
            "local_path": "outputs/private.html",
            "raw_content": "<html>secret</html>",
        })

    with pytest.raises(ValidationError, match="Unsafe artifact storage path"):
        ArtifactUpsertRequest(**{
            "thread_id": "thread-1",
            "local_path": "outputs/private.html",
            "storage_provider": "supabase",
            "storage_object_path": "../secret.md",
        })


def test_registry_persists_records_across_store_restart(tmp_path) -> None:
    base_path = tmp_path / "artifact-registry"
    first_registry = LocalArtifactRegistry(base_path)
    artifact = first_registry.upsert(_request(), user_id="user-1")

    second_registry = LocalArtifactRegistry(base_path)
    listed = second_registry.list(user_id="user-1")

    assert listed.total == 1
    assert listed.artifacts[0].artifact_id == artifact.artifact_id
    serialized = (base_path / "user-1" / "artifacts" / "registry.json").read_text(encoding="utf-8")
    assert "<html" not in serialized
    assert "signed.example" not in serialized
    assert "artifact_url" not in serialized


def test_registry_soft_delete_persists_across_store_restart(tmp_path) -> None:
    base_path = tmp_path / "artifact-registry"
    first_registry = LocalArtifactRegistry(base_path)
    artifact = first_registry.upsert(_request(), user_id="user-1")
    assert first_registry.mark_deleted(artifact.artifact_id, user_id="user-1") is not None

    second_registry = LocalArtifactRegistry(base_path)

    assert second_registry.list(user_id="user-1").total == 0
    hidden = second_registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    assert hidden.total == 1
    assert hidden.artifacts[0].deleted_at is not None
    assert hidden.artifacts[0].is_library_visible is False


def test_supabase_registry_persists_metadata_across_store_recreation() -> None:
    fake = FakeSupabaseArtifactPostgrest()
    first_registry = _supabase_registry(fake)
    artifact = first_registry.upsert(_request(), user_id="user-1")

    second_registry = _supabase_registry(fake)
    opened = second_registry.mark_opened(artifact.artifact_id, user_id="user-1")
    assert opened is not None
    assert opened.opened_count == 1

    deleted = second_registry.mark_deleted(artifact.artifact_id, user_id="user-1")
    assert deleted is not None
    assert deleted.deleted_at is not None

    third_registry = _supabase_registry(fake)
    assert third_registry.list(user_id="user-1").total == 0
    hidden = third_registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    assert hidden.total == 1
    assert hidden.artifacts[0].artifact_id == artifact.artifact_id
    serialized = json.dumps(fake.rows[artifact.artifact_id], sort_keys=True)
    assert "<html" not in serialized
    assert "signed.example" not in serialized
    assert "artifact_url" not in serialized


def test_supabase_registry_list_emits_safe_query_diagnostics(caplog) -> None:
    fake = FakeSupabaseArtifactPostgrest()
    registry = _supabase_registry(fake)
    registry.upsert(_request(artifact_id=KNOWN_ARTIFACT_ID), user_id="user-1")
    caplog.set_level(logging.INFO, logger=artifact_registry_module.__name__)

    response = registry.list(
        user_id="user-1",
        filters=ArtifactRegistryFilters(diagnostics_trace_id="trace-supabase-list"),
    )

    assert response.total == 1
    payload = _diagnostic_payloads(caplog, "artifact_registry_list_query_result")[-1]
    assert payload["trace_id"] == "trace-supabase-list"
    assert payload["registry_backend"] == "supabase"
    assert payload["table_name"] == "artifact_registry_records"
    assert payload["user_hash"] != "user-1"
    assert payload["raw_result_count"] == 1
    assert payload["returned_count"] == 1
    assert payload["known_artifact_present"] is True

    serialized_logs = "\n".join(record.getMessage() for record in caplog.records)
    assert "user-1" not in serialized_logs
    assert "service-role" not in serialized_logs


def test_production_supabase_upsert_hides_missing_storage_object(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        artifact_registry_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: False,
    )
    fake = FakeSupabaseArtifactPostgrest()
    registry = _supabase_registry(fake)

    record = registry.upsert(
        _request(
            storage_provider="supabase",
            storage_bucket="sophia-builder-artifacts",
            storage_object_path="artifacts/user-1/session-1/artifact-1/launch.html",
        ),
        user_id="user-1",
    )

    assert record.storage_status == "missing"
    assert record.is_library_visible is False
    assert registry.list(user_id="user-1").total == 0
    hidden = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    assert hidden.total == 1
    assert hidden.artifacts[0].storage_status == "missing"


def test_production_supabase_upsert_keeps_existing_storage_object_visible(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        artifact_registry_module.supabase_artifact_store,
        "check_artifact_object_exists",
        lambda _path: True,
    )
    fake = FakeSupabaseArtifactPostgrest()
    registry = _supabase_registry(fake)

    record = registry.upsert(
        _request(
            storage_provider="supabase",
            storage_bucket="sophia-builder-artifacts",
            storage_object_path="artifacts/user-1/session-1/artifact-1/launch.html",
        ),
        user_id="user-1",
    )

    assert record.storage_status == "available"
    assert record.is_library_visible is True
    assert registry.list(user_id="user-1").total == 1


def test_supabase_registry_dedupes_builder_and_backfill_and_hides_wrappers() -> None:
    fake = FakeSupabaseArtifactPostgrest()
    registry = _supabase_registry(fake)
    builder = registry.upsert(
        _request(
            source="builder",
            title="Explicit HTML Library Test",
            local_path="outputs/explicit-html-library-test.html",
            artifact_type="webpage",
            renderer_kind="html",
        ),
        user_id="user-1",
    )
    registry.upsert_record(
        builder.model_copy(
            update={
                "artifact_id": "artifact_backfill_duplicate",
                "logical_artifact_id": "logical_backfill_duplicate",
                "version_id": "logical_backfill_duplicate::v1",
                "source": "file_library_backfill",
                "updated_at": "2026-06-02T10:00:00+00:00",
            }
        ),
        user_id="user-1",
    )
    wrapper = registry.upsert(
        _request(
            title="Durable Artifact Registry Smoke Test - Handoff Wrapper",
            artifact_type="html",
            renderer_kind="html",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
        ),
        user_id="user-1",
    )

    visible = registry.list(user_id="user-1")
    assert visible.total == 1
    assert visible.artifacts[0].artifact_id == builder.artifact_id
    assert visible.artifacts[0].source == "builder"
    assert wrapper.is_library_visible is False
    hidden = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    assert {artifact.filename for artifact in hidden.artifacts} == {
        "explicit-html-library-test.html",
        "create-a-real-markdown-artifact-file-nam.html",
    }


def test_artifact_registry_factory_requires_supabase_in_production(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("SOPHIA_ARTIFACT_REGISTRY_STORE", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    with pytest.raises(ArtifactRegistryConfigurationError) as exc_info:
        ArtifactRegistry()

    message = str(exc_info.value)
    assert "SOPHIA_ARTIFACT_REGISTRY_STORE=supabase" in message
    assert "service-role" not in message


def test_production_supabase_registry_missing_supabase_url_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")

    with pytest.raises(ArtifactRegistryConfigurationError) as exc_info:
        ArtifactRegistry()

    message = str(exc_info.value)
    assert "SUPABASE_URL" in message
    assert "placeholder-service-role" not in message


def test_production_supabase_registry_missing_service_role_key_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")

    with pytest.raises(ArtifactRegistryConfigurationError) as exc_info:
        ArtifactRegistry()

    message = str(exc_info.value)
    assert "SUPABASE_SERVICE_ROLE_KEY" in message
    assert "example.supabase.co" not in message


def test_production_supabase_registry_missing_bucket_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role")
    monkeypatch.delenv("SUPABASE_BUILDER_BUCKET", raising=False)

    with pytest.raises(ArtifactRegistryConfigurationError) as exc_info:
        ArtifactRegistry()

    message = str(exc_info.value)
    assert "SUPABASE_BUILDER_BUCKET" in message
    assert "placeholder-service-role" not in message


def test_production_local_registry_rejected_unless_explicit_override(monkeypatch) -> None:
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "local")
    monkeypatch.delenv("SOPHIA_ALLOW_LOCAL_ARTIFACT_REGISTRY_IN_PRODUCTION", raising=False)

    with pytest.raises(ArtifactRegistryConfigurationError):
        ArtifactRegistry()

    monkeypatch.setenv("SOPHIA_ALLOW_LOCAL_ARTIFACT_REGISTRY_IN_PRODUCTION", "true")
    assert isinstance(ArtifactRegistry(), LocalArtifactRegistry)


def test_local_dev_registry_still_defaults_to_local(monkeypatch) -> None:
    for name in ("RENDER", "VERCEL", "RAILWAY_ENVIRONMENT", "SOPHIA_ENV", "APP_ENV", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("SOPHIA_ARTIFACT_REGISTRY_STORE", raising=False)

    assert isinstance(ArtifactRegistry(), LocalArtifactRegistry)


def test_strict_production_rejects_hybrid_registry_mode(monkeypatch) -> None:
    monkeypatch.setenv("SOPHIA_ENV", "production")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "hybrid")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")

    with pytest.raises(ArtifactRegistryConfigurationError) as exc_info:
        ArtifactRegistry()

    assert "migration or staging" in str(exc_info.value)


def test_local_registry_migration_writes_supabase_metadata_and_uploads_bytes(tmp_path, monkeypatch) -> None:
    import scripts.migrate_artifact_registry_to_supabase as migration

    base_path = tmp_path / "users"
    local_registry = LocalArtifactRegistry(base_path)
    artifact = local_registry.upsert(
        _request(
            local_path="outputs/report.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
        ),
        user_id="user-1",
    )
    local_file = tmp_path / "outputs" / "report.md"
    local_file.parent.mkdir(parents=True)
    local_file.write_text("# Report", encoding="utf-8")
    monkeypatch.setattr(migration, "resolve_thread_virtual_path", lambda _thread_id, _path: local_file)

    uploads: list[tuple[str, bytes, str | None]] = []

    def upload_object(object_path: str, content: bytes, *, content_type: str | None = None):
        uploads.append((object_path, content, content_type))
        return object_path

    monkeypatch.setattr(migration.supabase_artifact_store, "upload_artifact_object", upload_object)
    fake = FakeSupabaseArtifactPostgrest()
    target_registry = _supabase_registry(fake)

    summary = migration.migrate(base_path=base_path, execute=True, registry=target_registry)

    assert summary.records_seen == 1
    assert summary.records_written == 1
    assert summary.bytes_uploaded == 1
    assert uploads == [
        (
            f"artifacts/user-1/session-1/{artifact.artifact_id}/report.md",
            b"# Report",
            "text/markdown",
        )
    ]
    stored_payload = fake.rows[artifact.artifact_id]["record_payload"]
    assert stored_payload["storage_provider"] == "supabase"
    assert stored_payload["storage_object_path"] == uploads[0][0]
    assert stored_payload["size_bytes"] == len(b"# Report")
    serialized = json.dumps(stored_payload, sort_keys=True)
    assert "# Report" not in serialized
    assert "artifact_url" not in serialized
    assert stored_payload["raw_content_excluded"] is True
    assert stored_payload["signed_url_excluded"] is True


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
    wrapper = registry.upsert(
        _request(
            source="file_library_backfill",
            artifact_type="html",
            renderer_kind="html",
            title="Durable Artifact Registry Smoke Test - Handoff Wrapper",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
        ),
        user_id="user-1",
    )
    support = registry.upsert(
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
    assert wrapper.artifact_role == "wrapper"
    assert support.artifact_role == "support"
    assert "create-a-real-markdown-artifact-file-nam.html" not in by_name
    assert "chart.png" not in by_name
    assert by_name["readable-notes.md"].artifact_role == "primary"


def test_registry_filters_old_visible_wrapper_records_at_read_time(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    visible = registry.upsert(
        _request(
            title="Durable Registry Smoke Markdown",
            artifact_type="markdown",
            renderer_kind="markdown",
            mime_type="text/markdown",
            local_path="outputs/durable-registry-smoke-markdown.md",
        ),
        user_id="user-1",
    )
    wrapper_payload = visible.model_dump(mode="json")
    wrapper_payload.update({
        "artifact_id": "artifact_legacy_wrapper",
        "logical_artifact_id": "logical_legacy_wrapper",
        "version_id": "logical_legacy_wrapper::v1",
        "title": "Durable Artifact Registry Smoke Test - Handoff Wrapper",
        "filename": "create-a-real-markdown-artifact-file-nam.html",
        "artifact_type": "html",
        "renderer_kind": "html",
        "mime_type": "text/html",
        "source": "builder",
        "local_path": "mnt/user-data/outputs/create-a-real-markdown-artifact-file-nam.html",
        "artifact_role": "primary",
        "is_library_visible": True,
    })
    registry_path = registry._registry_path("user-1")
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        json.dumps({"version": 1, "artifacts": [visible.model_dump(mode="json"), wrapper_payload]}),
        encoding="utf-8",
    )

    listed = registry.list(user_id="user-1")
    assert [artifact.filename for artifact in listed.artifacts] == ["durable-registry-smoke-markdown.md"]

    hidden = registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    hidden_by_name = {artifact.filename: artifact for artifact in hidden.artifacts}
    assert hidden_by_name["create-a-real-markdown-artifact-file-nam.html"].artifact_role == "wrapper"
    assert hidden_by_name["create-a-real-markdown-artifact-file-nam.html"].is_library_visible is False

    reloaded = LocalArtifactRegistry(tmp_path)
    assert [artifact.filename for artifact in reloaded.list(user_id="user-1").artifacts] == [
        "durable-registry-smoke-markdown.md"
    ]
    reloaded_hidden = reloaded.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True))
    reloaded_wrapper = {
        artifact.filename: artifact for artifact in reloaded_hidden.artifacts
    }["create-a-real-markdown-artifact-file-nam.html"]
    assert reloaded_wrapper.artifact_role == "wrapper"
    assert reloaded_wrapper.is_library_visible is False


def test_registry_dedupes_builder_and_backfill_records_by_visible_identity(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    builder = registry.upsert(
        _request(
            source="builder",
            title="Explicit HTML Library Test",
            local_path="outputs/explicit-html-library-test.html",
            artifact_type="webpage",
            renderer_kind="html",
            created_at="2026-06-01T10:00:00+00:00",
            updated_at="2026-06-01T10:00:00+00:00",
        ),
        user_id="user-1",
    )
    backfill_payload = builder.model_copy(
        update={
            "artifact_id": "artifact_backfill_duplicate",
            "logical_artifact_id": "logical_backfill_duplicate",
            "version_id": "logical_backfill_duplicate::v1",
            "source": "file_library_backfill",
            "title": "Explicit HTML Library Test",
            "updated_at": "2026-06-02T10:00:00+00:00",
        }
    )
    registry._write_records("user-1", [backfill_payload, builder])

    listed = registry.list(user_id="user-1")

    assert listed.total == 1
    assert listed.artifacts[0].artifact_id == builder.artifact_id
    assert listed.artifacts[0].source == "builder"


def test_registry_backfill_upsert_merges_into_existing_builder_record(tmp_path) -> None:
    registry = LocalArtifactRegistry(tmp_path)
    builder = registry.upsert(
        _request(
            source="builder",
            title="Explicit HTML Library Test",
            local_path="outputs/explicit-html-library-test.html",
            artifact_type="webpage",
            renderer_kind="html",
        ),
        user_id="user-1",
    )

    backfill = registry.upsert(
        _request(
            artifact_id="artifact_backfill_duplicate",
            logical_artifact_id="logical_backfill_duplicate",
            version_id="logical_backfill_duplicate::v1",
            source="file_library_backfill",
            title="Explicit HTML Library Test from Backfill",
            local_path="outputs/explicit-html-library-test.html",
            artifact_type="webpage",
            renderer_kind="html",
            safe_summary="Backfill had a safe summary.",
        ),
        user_id="user-1",
    )

    listed = registry.list(user_id="user-1")

    assert backfill.artifact_id == builder.artifact_id
    assert backfill.source == "builder"
    assert backfill.safe_summary == "Backfill had a safe summary."
    assert listed.total == 1
    assert listed.artifacts[0].source == "builder"


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


def test_list_endpoint_emits_safe_trace_diagnostics(tmp_path, monkeypatch, caplog) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    registry.upsert(
        _request(
            artifact_id=KNOWN_ARTIFACT_ID,
            title="Sophia Test",
            artifact_type="markdown",
            renderer_kind="markdown",
            mime_type="text/markdown",
            local_path="outputs/sophia_test.md",
        ),
        user_id="user-1",
    )
    caplog.set_level(logging.INFO, logger=artifacts_router.__name__)
    caplog.set_level(logging.INFO, logger=artifact_registry_module.__name__)

    response = client.get(
        "/api/artifacts?sort=created&limit=10",
        headers={"x-sophia-artifact-trace-id": "trace-list-test"},
    )

    assert response.status_code == 200
    gateway_payload = _diagnostic_payloads(caplog, "artifact_registry_list_gateway_result")[-1]
    assert gateway_payload["trace_id"] == "trace-list-test"
    assert gateway_payload["authenticated_user_present"] is True
    assert gateway_payload["authenticated_user_hash"] != "user-1"
    assert gateway_payload["thread_id_present"] is False
    assert gateway_payload["limit"] == 10
    assert gateway_payload["known_artifact_present"] is True
    assert gateway_payload["response_artifact_count"] == 1

    registry_payload = _diagnostic_payloads(caplog, "artifact_registry_list_query_result")[-1]
    assert registry_payload["trace_id"] == "trace-list-test"
    assert registry_payload["registry_backend"] == "local"
    assert registry_payload["table_name"] == "local_registry_json"
    assert registry_payload["user_hash"] != "user-1"
    assert registry_payload["raw_result_count"] == 1
    assert registry_payload["returned_count"] == 1
    assert registry_payload["known_artifact_present"] is True

    serialized_logs = "\n".join(record.getMessage() for record in caplog.records)
    assert "user-1" not in serialized_logs


def test_download_endpoint_serves_visible_artifact_by_registry_id(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    actual_file = tmp_path / "served" / "Quarterly Report.pdf"
    actual_file.parent.mkdir(parents=True)
    actual_file.write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: actual_file)
    artifact = registry.upsert(
        _request(local_path="outputs/Quarterly Report.pdf", renderer_kind="pdf", artifact_type="pdf"),
        user_id="user-1",
    )

    response = client.get(f"/api/artifacts/{artifact.artifact_id}/download")

    assert response.status_code == 200
    assert response.content == b"%PDF-1.4"
    assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''Quarterly%20Report.pdf"


def test_content_endpoint_serves_visible_artifact_by_registry_id(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    actual_file = tmp_path / "served" / "launch page.html"
    actual_file.parent.mkdir(parents=True)
    actual_file.write_text("<html><body>launch</body></html>", encoding="utf-8")
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: actual_file)
    artifact = registry.upsert(
        _request(local_path="outputs/launch page.html", renderer_kind="html", artifact_type="webpage"),
        user_id="user-1",
    )

    response = client.get(f"/api/artifacts/{artifact.artifact_id}/content")

    assert response.status_code == 200
    assert response.text == "<html><body>launch</body></html>"
    assert "location" not in response.headers


def test_content_endpoint_serves_registry_artifact_from_supabase_object(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    missing_file = tmp_path / "missing" / "remote.md"
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: missing_file)

    requested_paths: list[str] = []

    def download_object(object_path: str):
        requested_paths.append(object_path)
        return b"# Remote\n\nstored in supabase", "text/markdown"

    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact_object", download_object)
    artifact = registry.upsert(
        _request(
            local_path="outputs/remote.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="thread-1/outputs/remote.md",
        ),
        user_id="user-1",
    )

    response = client.get(f"/api/artifacts/{artifact.artifact_id}/content")

    assert response.status_code == 200
    assert response.text == "# Remote\n\nstored in supabase"
    assert requested_paths == ["thread-1/outputs/remote.md"]


def test_content_and_download_return_404_when_registry_object_missing(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    missing_file = tmp_path / "missing" / "remote.md"
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: missing_file)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact_object", lambda _path: None)
    legacy_calls: list[str] = []
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact",
        lambda *, thread_id, filename: legacy_calls.append(filename) or None,
    )

    artifact = registry.upsert(
        _request(
            local_path="outputs/remote.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="artifacts/user-1/session-1/artifact-1/remote.md",
        ),
        user_id="user-1",
    )

    content = client.get(f"/api/artifacts/{artifact.artifact_id}/content")
    download = client.get(f"/api/artifacts/{artifact.artifact_id}/download")

    assert content.status_code == 404
    assert download.status_code == 404
    assert "sophia_builder" not in content.text
    assert "service" not in content.text.lower()
    assert legacy_calls == []


def test_upsert_endpoint_rejects_cross_thread_supabase_object_path(tmp_path, monkeypatch) -> None:
    client, _registry = _owned_app(tmp_path, monkeypatch)

    payload = _request(
        local_path="outputs/remote.md",
        renderer_kind="markdown",
        artifact_type="markdown",
        mime_type="text/markdown",
        storage_provider="supabase",
        storage_bucket="sophia_builder",
        storage_object_path="thread-2/outputs/secret.md",
    ).model_dump(mode="json", exclude_none=True)

    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact storage path must belong to the artifact thread"


def test_content_endpoint_rejects_legacy_cross_thread_supabase_object_path(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    missing_file = tmp_path / "missing" / "remote.md"
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: missing_file)
    requested_paths: list[str] = []

    def download_object(object_path: str):
        requested_paths.append(object_path)
        return b"secret", "text/markdown"

    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact_object", download_object)
    artifact = registry.upsert(
        _request(
            local_path="outputs/remote.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="thread-1/outputs/remote.md",
        ),
        user_id="user-1",
    )
    registry.upsert_record(
        artifact.model_copy(update={"storage_object_path": "thread-2/outputs/secret.md"}),
        user_id="user-1",
    )

    response = client.get(f"/api/artifacts/{artifact.artifact_id}/content")

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact storage path must belong to the artifact thread"
    assert requested_paths == []

def test_content_endpoint_rejects_unsafe_supabase_object_path() -> None:
    with pytest.raises(ValidationError, match="Unsafe artifact storage path"):
        _request(
            local_path="outputs/remote.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="../secret.md",
        )


def test_artifact_id_endpoints_do_not_require_live_session_record(tmp_path, monkeypatch) -> None:
    registry = LocalArtifactRegistry(tmp_path / "artifact-registry")
    store = SessionStore(tmp_path / "users")
    actual_file = tmp_path / "served" / "orphaned-session.md"
    parent_missing_file = tmp_path / "missing-parent" / "orphaned-session.md"
    actual_file.parent.mkdir(parents=True)
    actual_file.write_text("# Still here", encoding="utf-8")
    monkeypatch.setattr(artifacts_router, "_artifact_registry", registry)
    monkeypatch.setattr(artifacts_router, "_session_store", store)

    def resolve_path(thread_id: str, _virtual_path: str) -> Path:
        if thread_id == "thread-1":
            return parent_missing_file
        if thread_id == "task-thread-1":
            return actual_file
        raise AssertionError(f"Unexpected thread id: {thread_id}")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    app = FastAPI()
    app.include_router(artifacts_router.router)
    app.dependency_overrides[require_authenticated_user] = lambda: "user-1"
    client = TestClient(app)
    artifact = registry.upsert(
        _request(
            task_id="task-thread-1",
            local_path="outputs/orphaned-session.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
        ),
        user_id="user-1",
    )

    metadata = client.get(f"/api/artifacts/{artifact.artifact_id}")
    opened = client.post(f"/api/artifacts/{artifact.artifact_id}/open")
    content = client.get(f"/api/artifacts/{artifact.artifact_id}/content")
    download = client.get(f"/api/artifacts/{artifact.artifact_id}/download")

    assert metadata.status_code == 200
    assert opened.status_code == 200
    assert content.status_code == 200
    assert content.text == "# Still here"
    assert download.status_code == 200
    assert download.headers["content-disposition"] == "attachment; filename*=UTF-8''orphaned-session.md"


def test_thread_artifact_route_falls_back_to_registry_storage(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    missing_file = tmp_path / "missing" / "brief.md"
    legacy_calls: list[tuple[str, str]] = []
    object_calls: list[str] = []
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        lambda _thread_id, _path: missing_file,
    )
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact",
        lambda thread_id, filename: legacy_calls.append((thread_id, filename)) or None,
    )
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact_object",
        lambda object_path: object_calls.append(object_path) or (b"# Sophia test", "text/markdown"),
    )
    artifact = registry.upsert(
        _request(
            title="Sophia Test",
            local_path="outputs/brief.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="artifacts/user-1/session-1/artifact-1/brief.md",
        ),
        user_id="user-1",
    )

    response = client.get("/api/threads/thread-1/artifacts/mnt/user-data/outputs/brief.md")

    assert response.status_code == 200
    assert response.text == "# Sophia test"
    assert response.headers["content-type"].startswith("text/markdown")
    assert legacy_calls == [("thread-1", "brief.md")]
    assert object_calls == [artifact.storage_object_path]


def test_hidden_artifact_id_endpoints_return_404(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    artifact = registry.upsert(
        _request(
            title="Durable Artifact Registry Smoke Test - Handoff Wrapper",
            artifact_type="html",
            renderer_kind="html",
            local_path="outputs/create-a-real-markdown-artifact-file-nam.html",
        ),
        user_id="user-1",
    )

    assert artifact.is_library_visible is False
    for method, path in (
        ("get", f"/api/artifacts/{artifact.artifact_id}"),
        ("post", f"/api/artifacts/{artifact.artifact_id}/open"),
        ("get", f"/api/artifacts/{artifact.artifact_id}/content"),
        ("get", f"/api/artifacts/{artifact.artifact_id}/download"),
    ):
        response = getattr(client, method)(path, follow_redirects=False)
        assert response.status_code == 404


def test_delete_endpoint_hides_artifact_without_deleting_bytes(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    output_file = tmp_path / "outputs" / "launch.html"
    output_file.parent.mkdir(parents=True)
    output_file.write_text("<html>launch</html>", encoding="utf-8")
    download_calls: list[str] = []
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact_object",
        lambda object_path: download_calls.append(object_path) or (b"<html>launch</html>", "text/html"),
    )
    artifact = registry.upsert(
        _request(
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="artifacts/user-1/session-1/artifact-1/launch.html",
        ),
        user_id="user-1",
    )

    response = client.delete(f"/api/artifacts/{artifact.artifact_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["artifact"]["deleted_at"] is not None
    assert body["artifact"]["is_library_visible"] is False
    assert output_file.read_text(encoding="utf-8") == "<html>launch</html>"

    listed = client.get("/api/artifacts")
    assert listed.status_code == 200
    assert listed.json()["artifacts"] == []
    assert listed.json()["total"] == 0

    hidden = client.get("/api/artifacts?include_hidden=true")
    assert hidden.status_code == 200
    assert hidden.json()["total"] == 1
    assert hidden.json()["artifacts"][0]["artifact_id"] == artifact.artifact_id

    for method, path in (
        ("get", f"/api/artifacts/{artifact.artifact_id}"),
        ("post", f"/api/artifacts/{artifact.artifact_id}/open"),
        ("get", f"/api/artifacts/{artifact.artifact_id}/content"),
        ("get", f"/api/artifacts/{artifact.artifact_id}/download"),
    ):
        response_after_delete = getattr(client, method)(path, follow_redirects=False)
        assert response_after_delete.status_code == 404
    assert download_calls == []


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


def test_builder_terminal_event_uses_user_scoped_verified_storage_path(tmp_path, monkeypatch) -> None:
    registry = LocalArtifactRegistry(tmp_path / "artifact-registry")
    store = SessionStore(tmp_path / "users")
    store.create(SessionRecord(session_id="session-1", thread_id="parent-thread", user_id="user-1"))
    monkeypatch.setattr(builder_events_router, "_artifact_registry", registry)
    monkeypatch.setattr(builder_events_router, "_session_store", store)
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "sophia-builder-artifacts")
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.is_configured",
        lambda: True,
    )
    monkeypatch.setattr(
        "deerflow.sophia.storage.supabase_artifact_store.configured_bucket_name",
        lambda: "sophia-builder-artifacts",
    )

    builder_events_router._upsert_builder_terminal_artifact({
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "run-1",
        "status": "success",
        "artifact_path": "mnt/user-data/outputs/brief.md",
        "artifact_url": "https://signed.example/temporary",
        "artifact_title": "Builder Brief",
        "artifact_type": "document",
        "summary": "Safe brief summary",
        "completed_at": "2026-06-01T10:00:00+00:00",
        "user_id": "user-1",
    })

    record = registry.list(user_id="user-1").artifacts[0]
    assert record.storage_provider == "supabase"
    assert record.storage_bucket == "sophia-builder-artifacts"
    assert record.storage_object_path is not None
    assert record.storage_object_path.startswith("artifacts/user-1/session-1/")
    assert f"/{record.artifact_id}/" in record.storage_object_path
    assert record.storage_object_path.endswith("/brief.md")
    serialized = record.model_dump_json()
    assert "signed.example" not in serialized
    assert "artifact_url" not in serialized


def test_builder_terminal_failed_storage_event_does_not_create_registry_row(tmp_path, monkeypatch) -> None:
    registry = LocalArtifactRegistry(tmp_path / "artifact-registry")
    store = SessionStore(tmp_path / "users")
    store.create(SessionRecord(session_id="session-1", thread_id="parent-thread", user_id="user-1"))
    monkeypatch.setattr(builder_events_router, "_artifact_registry", registry)
    monkeypatch.setattr(builder_events_router, "_session_store", store)

    builder_events_router._upsert_builder_terminal_artifact({
        "thread_id": "parent-thread",
        "task_id": "builder-task",
        "run_id": "run-1",
        "status": "error",
        "artifact_path": "mnt/user-data/outputs/brief.md",
        "artifact_title": "Builder Brief",
        "artifact_type": "document",
        "builder_failure_diagnostics": {
            "failure_stage": "storage_mirror",
            "supabase_mirror_result": "required_upload_failed",
        },
        "user_id": "user-1",
    })

    assert registry.list(user_id="user-1", filters=ArtifactRegistryFilters(include_hidden=True)).total == 0


# ---------------------------------------------------------------------------
# Codex P1 (PR #131) follow-up: close the two gaps left after
# `validate_artifact_storage_object_path` anchored storage_object_path to
# thread_id — (1) forged parent_thread_id/task_id still flowed into the
# serve-time thread set and were fetched with the service-role key; (2) an
# object path under the owner's OWN thread could still address an internal
# keyspace (ledger/uploads/builder support).
# ---------------------------------------------------------------------------


def _set_associated_builder_tasks(monkeypatch, *thread_ids: str) -> None:
    async def _fake(_parent_thread_id: str):
        return tuple(thread_ids)

    monkeypatch.setattr(artifacts_router, "_builder_task_thread_ids_to_check", _fake)


@pytest.mark.parametrize("field", ["task_id", "parent_thread_id"])
def test_upsert_endpoint_rejects_forged_thread_reference(tmp_path, monkeypatch, field) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    _set_associated_builder_tasks(monkeypatch)  # no associated builder tasks

    payload = _request(**{field: "victim-thread"}).model_dump(mode="json", exclude_none=True)
    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact references an unauthorized thread"
    assert registry.list(user_id="user-1").artifacts == []


def test_upsert_endpoint_allows_associated_builder_task_reference_with_run_metadata(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    _set_associated_builder_tasks(monkeypatch, "builder-task-1")

    payload = _request(
        parent_thread_id="thread-1",
        task_id="builder-task-1",
        run_id="langgraph-run-not-a-thread",
    ).model_dump(mode="json", exclude_none=True)
    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 200
    records = registry.list(user_id="user-1").artifacts
    assert len(records) == 1
    assert records[0].task_id == "builder-task-1"
    assert records[0].run_id == "langgraph-run-not-a-thread"


def test_upsert_endpoint_rejects_forged_task_even_with_owned_run_id(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    _set_associated_builder_tasks(monkeypatch)

    payload = _request(task_id="victim-thread", run_id="thread-1").model_dump(mode="json", exclude_none=True)
    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact references an unauthorized thread"
    assert registry.list(user_id="user-1").artifacts == []


def test_run_id_is_not_used_as_registry_serve_thread() -> None:
    record = _request(
        task_id="builder-task-1",
        run_id="victim-thread",
        parent_thread_id="thread-1",
    ).to_record(user_id="user-1")

    assert artifacts_router._registry_artifact_thread_ids(record) == (
        "thread-1",
        "builder-task-1",
    )


def test_upsert_endpoint_rejects_mismatched_client_user_id(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    _set_associated_builder_tasks(monkeypatch)

    payload = _request(user_id="victim-user").model_dump(mode="json", exclude_none=True)
    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact user scope mismatch"
    assert registry.list(user_id="user-1").artifacts == []


def test_upsert_endpoint_uses_authenticated_user_when_client_user_id_absent(tmp_path, monkeypatch) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    _set_associated_builder_tasks(monkeypatch)

    payload = _request(user_id=None).model_dump(mode="json", exclude_none=True)
    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 200
    records = registry.list(user_id="user-1").artifacts
    assert len(records) == 1
    assert records[0].user_id == "user-1"


@pytest.mark.parametrize(
    "object_path",
    [
        "thread-1/ledger/session.jsonl",
        "thread-1/uploads/secret.pdf",
        "thread-1/.builder/state.json",
        "thread-1/outputs/report.plan.json",
    ],
)
def test_upsert_endpoint_rejects_internal_keyspace_object_path(tmp_path, monkeypatch, object_path) -> None:
    client, registry = _owned_app(tmp_path, monkeypatch)
    _set_associated_builder_tasks(monkeypatch)

    payload = _request(
        local_path="outputs/remote.md",
        renderer_kind="markdown",
        artifact_type="markdown",
        mime_type="text/markdown",
        storage_provider="supabase",
        storage_bucket="sophia_builder",
        storage_object_path=object_path,
    ).model_dump(mode="json", exclude_none=True)

    response = client.post("/api/artifacts/upsert", json=payload)

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact references an internal keyspace"
    assert registry.list(user_id="user-1").artifacts == []


def test_content_endpoint_refuses_internal_keyspace_storage_object(tmp_path, monkeypatch) -> None:
    """Serve-time defense-in-depth: a record whose storage_object_path was
    injected outside the validated write path (server-side / migrated / legacy)
    must never serve an internal keyspace object through the service-role key."""
    client, registry = _owned_app(tmp_path, monkeypatch)
    missing_file = tmp_path / "missing" / "remote.md"
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _t, _p: missing_file)

    object_calls: list[str] = []

    def download_object(object_path: str):
        object_calls.append(object_path)
        return b"INTERNAL LEDGER BYTES", "application/json"

    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact_object", download_object)

    artifact = registry.upsert(
        _request(
            local_path="outputs/remote.md",
            renderer_kind="markdown",
            artifact_type="markdown",
            mime_type="text/markdown",
            storage_provider="supabase",
            storage_bucket="sophia_builder",
            storage_object_path="thread-1/outputs/remote.md",
        ),
        user_id="user-1",
    )
    # Bypass the validated write path to plant an internal-keyspace object path.
    registry.upsert_record(
        artifact.model_copy(update={"storage_object_path": "thread-1/ledger/session.jsonl"}),
        user_id="user-1",
    )

    response = client.get(f"/api/artifacts/{artifact.artifact_id}/content")

    assert response.status_code == 403
    assert response.json()["detail"] == "Artifact references an internal keyspace"
    assert object_calls == []  # ledger object never fetched with the service-role key
