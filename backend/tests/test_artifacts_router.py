import asyncio
import os
import zipfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

import app.gateway.routers.artifacts as artifacts_router


class OwnedSophiaSessionStore:
    def __init__(self, parent_thread_id: str = "parent-thread", user_id: str = "user-1") -> None:
        self.parent_thread_id = parent_thread_id
        self.user_id = user_id

    def find_session_by_thread_id(self, user_id: str, thread_id: str):
        if user_id == self.user_id and thread_id == self.parent_thread_id:
            return object()
        return None

    def find_any_session_by_thread_id(self, thread_id: str):
        if thread_id == self.parent_thread_id:
            return object()
        return None


def thread_user_data_resolver(thread_roots: dict[str, Path]):
    def resolve_path(thread_id: str, virtual_path: str) -> Path:
        normalized = virtual_path.lstrip("/")
        prefix = "mnt/user-data/"
        if not normalized.startswith(prefix):
            raise AssertionError(f"Unexpected virtual path: {virtual_path}")
        return thread_roots[thread_id] / normalized[len(prefix) :]

    return resolve_path


def http_request(query_string: bytes = b"") -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": query_string})


def test_normalize_artifact_virtual_path_accepts_safe_output_forms() -> None:
    assert artifacts_router._normalize_artifact_virtual_path(
        "/mnt/user-data/outputs/builder-demo.md"
    ) == "mnt/user-data/outputs/builder-demo.md"
    assert artifacts_router._normalize_artifact_virtual_path(
        "user-data/outputs/builder-demo.md"
    ) == "mnt/user-data/outputs/builder-demo.md"
    assert artifacts_router._normalize_artifact_virtual_path(
        "outputs/builder-demo.md"
    ) == "mnt/user-data/outputs/builder-demo.md"


def test_get_artifact_reads_utf8_text_file_on_windows_locale(tmp_path, monkeypatch) -> None:
    artifact_path = tmp_path / "note.txt"
    text = "Curly quotes: \u201cutf8\u201d"
    artifact_path.write_text(text, encoding="utf-8")

    original_read_text = Path.read_text

    def read_text_with_gbk_default(self, *args, **kwargs):
        kwargs.setdefault("encoding", "gbk")
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text_with_gbk_default)
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: artifact_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(artifacts_router.get_artifact("thread-1", "mnt/user-data/outputs/note.txt", request))

    assert bytes(response.body).decode("utf-8") == text
    assert response.media_type == "text/plain"


def test_get_artifact_serves_local_pptx_as_attachment(tmp_path, monkeypatch) -> None:
    artifact_path = tmp_path / "deck.pptx"
    artifact_path.write_bytes(b"pptx-bytes")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: artifact_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(
        artifacts_router.get_artifact("thread-1", "mnt/user-data/outputs/deck.pptx", request)
    )

    assert response.headers["content-disposition"].startswith("attachment;")
    assert "deck.pptx" in response.headers["content-disposition"]


def test_get_artifact_serves_supabase_pptx_as_attachment(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    workspace_outputs_dir = tmp_path / "workspace" / "outputs"

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        if virtual_path == "mnt/user-data/outputs/deck.pptx":
            return outputs_dir / "deck.pptx"
        if virtual_path == "mnt/user-data/workspace/outputs/deck.pptx":
            return workspace_outputs_dir / "deck.pptx"
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact",
        lambda *, thread_id, filename: (b"pptx-bytes", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    )

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(
        artifacts_router.get_artifact("thread-1", "mnt/user-data/outputs/deck.pptx", request)
    )

    assert bytes(response.body) == b"pptx-bytes"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert "deck.pptx" in response.headers["content-disposition"]


def test_list_artifacts_returns_output_files_sorted_by_modified_time(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    nested_dir = outputs_dir / "nested"
    visuals_dir = outputs_dir / "visuals"
    nested_dir.mkdir(parents=True)
    visuals_dir.mkdir(parents=True)

    older_file = outputs_dir / "first.md"
    newer_file = nested_dir / "second.txt"
    support_file = visuals_dir / "chart.png"
    older_file.write_text("first", encoding="utf-8")
    newer_file.write_text("second", encoding="utf-8")
    support_file.write_bytes(b"png")
    os.utime(older_file, (1_700_000_000, 1_700_000_000))
    os.utime(newer_file, (1_700_000_100, 1_700_000_100))

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: outputs_dir)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "list_artifacts", lambda *, thread_id: [])

    response = asyncio.run(artifacts_router.list_artifacts("thread-1"))

    assert response.thread_id == "thread-1"
    assert [item.path for item in response.artifacts] == [
        "mnt/user-data/outputs/nested/second.txt",
        "mnt/user-data/outputs/first.md",
    ]
    assert response.artifacts[0].name == "second.txt"
    assert response.artifacts[0].size_bytes == len("second")
    assert response.artifacts[0].mime_type == "text/plain"
    assert response.artifacts[1].name == "first.md"
    assert all("visuals/" not in item.path for item in response.artifacts)


def test_list_artifacts_includes_supabase_objects_when_local_outputs_are_missing(tmp_path, monkeypatch) -> None:
    missing_outputs = tmp_path / "missing" / "outputs"
    supabase_info = artifacts_router.supabase_artifact_store.SupabaseArtifactInfo(
        filename="prompt_engineering.md",
        size_bytes=123,
        modified_at="2026-05-26T22:46:50Z",
        content_type="text/markdown",
    )

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: missing_outputs)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: [supabase_info],
    )

    response = asyncio.run(artifacts_router.list_artifacts("thread-1"))

    assert [item.path for item in response.artifacts] == [
        "mnt/user-data/outputs/prompt_engineering.md",
    ]
    assert response.artifacts[0].size_bytes == 123
    assert response.artifacts[0].mime_type == "text/markdown"


def test_list_artifacts_filters_supabase_visual_support_assets(tmp_path, monkeypatch) -> None:
    missing_outputs = tmp_path / "missing" / "outputs"
    supabase_items = [
        artifacts_router.supabase_artifact_store.SupabaseArtifactInfo(
            filename="deck.pptx",
            size_bytes=1234,
            modified_at="2026-05-26T22:46:50Z",
            content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        artifacts_router.supabase_artifact_store.SupabaseArtifactInfo(
            filename="visuals/openclaw_workflow.png",
            size_bytes=4321,
            modified_at="2026-05-26T22:46:51Z",
            content_type="image/png",
        ),
    ]

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: missing_outputs)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: supabase_items,
    )

    response = asyncio.run(artifacts_router.list_artifacts("thread-1"))

    assert [item.path for item in response.artifacts] == ["mnt/user-data/outputs/deck.pptx"]


def test_list_artifacts_merges_and_dedupes_local_and_supabase(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    local_file = outputs_dir / "brief.md"
    local_file.write_text("local", encoding="utf-8")
    os.utime(local_file, (1_700_000_200, 1_700_000_200))

    supabase_items = [
        artifacts_router.supabase_artifact_store.SupabaseArtifactInfo(
            filename="brief.md",
            size_bytes=999,
            modified_at="2026-05-26T22:46:50Z",
            content_type="text/markdown",
        ),
        artifacts_router.supabase_artifact_store.SupabaseArtifactInfo(
            filename="nested/second.txt",
            size_bytes=6,
            modified_at="2026-05-26T22:46:51Z",
            content_type="text/plain",
        ),
        artifacts_router.supabase_artifact_store.SupabaseArtifactInfo(
            filename="_generate_pdf.py",
            size_bytes=10,
            modified_at="2026-05-26T22:46:52Z",
            content_type="text/x-python",
        ),
    ]

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: outputs_dir)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: supabase_items,
    )

    response = asyncio.run(artifacts_router.list_artifacts("thread-1"))

    paths = [item.path for item in response.artifacts]
    assert "mnt/user-data/outputs/brief.md" in paths
    assert "mnt/user-data/outputs/nested/second.txt" in paths
    assert "mnt/user-data/outputs/_generate_pdf.py" not in paths
    brief = next(item for item in response.artifacts if item.path.endswith("/brief.md"))
    assert brief.size_bytes == len("local")


def test_list_artifacts_keeps_local_results_when_supabase_listing_fails(tmp_path, monkeypatch, caplog) -> None:
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    local_file = outputs_dir / "brief.md"
    local_file.write_text("local", encoding="utf-8")

    def raise_list(*, thread_id: str):
        raise RuntimeError("boom")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: outputs_dir)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "list_artifacts", raise_list)

    response = asyncio.run(artifacts_router.list_artifacts("thread-1"))

    assert [item.path for item in response.artifacts] == ["mnt/user-data/outputs/brief.md"]
    assert "Supabase artifact list failed" in caplog.text


def test_list_artifacts_includes_associated_builder_task_outputs(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"
    task_outputs = task_user_data / "outputs"
    task_outputs.mkdir(parents=True)
    builder_file = task_outputs / "builder-demo.md"
    builder_file.write_text("builder artifact", encoding="utf-8")
    os.utime(builder_file, (1_700_000_300, 1_700_000_300))

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "list_artifacts", lambda *, thread_id: [])

    response = asyncio.run(
        artifacts_router.list_artifacts("parent-thread", authenticated_user_id="user-1")
    )

    assert response.thread_id == "parent-thread"
    assert [item.path for item in response.artifacts] == ["mnt/user-data/outputs/builder-demo.md"]
    assert response.artifacts[0].name == "builder-demo.md"
    assert response.artifacts[0].size_bytes == len("builder artifact")


def test_list_artifacts_prefers_newest_duplicate_associated_builder_output(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    old_task_user_data = tmp_path / "old-task" / "user-data"
    new_task_user_data = tmp_path / "new-task" / "user-data"
    old_outputs = old_task_user_data / "outputs"
    new_outputs = new_task_user_data / "outputs"
    old_outputs.mkdir(parents=True)
    new_outputs.mkdir(parents=True)
    old_file = old_outputs / "report.pdf"
    new_file = new_outputs / "report.pdf"
    old_file.write_bytes(b"old")
    new_file.write_bytes(b"newer artifact")
    os.utime(old_file, (1_700_000_100, 1_700_000_100))
    os.utime(new_file, (1_700_000_500, 1_700_000_500))

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("old-task-thread", "new-task-thread")

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "old-task-thread": old_task_user_data,
            "new-task-thread": new_task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "list_artifacts", lambda *, thread_id: [])

    response = asyncio.run(
        artifacts_router.list_artifacts("parent-thread", authenticated_user_id="user-1")
    )

    assert [item.path for item in response.artifacts] == ["mnt/user-data/outputs/report.pdf"]
    assert response.artifacts[0].size_bytes == len(b"newer artifact")
    assert response.artifacts[0].modified_at == "2023-11-14T22:21:40+00:00"


def test_get_artifact_resolves_associated_builder_task_output(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"
    task_outputs = task_user_data / "outputs"
    task_outputs.mkdir(parents=True)
    (task_outputs / "builder-demo.md").write_text("builder artifact", encoding="utf-8")

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact", lambda *, thread_id, filename: None)

    response = asyncio.run(
        artifacts_router.get_artifact(
            "parent-thread",
            "mnt/user-data/outputs/builder-demo.md",
            http_request(),
            authenticated_user_id="user-1",
        )
    )

    assert bytes(response.body).decode("utf-8") == "builder artifact"
    assert response.media_type == "text/markdown"


def test_get_artifact_prefers_newest_duplicate_associated_builder_output(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    old_task_user_data = tmp_path / "old-task" / "user-data"
    new_task_user_data = tmp_path / "new-task" / "user-data"
    old_outputs = old_task_user_data / "outputs"
    new_outputs = new_task_user_data / "outputs"
    old_outputs.mkdir(parents=True)
    new_outputs.mkdir(parents=True)
    old_file = old_outputs / "report.md"
    new_file = new_outputs / "report.md"
    old_file.write_text("old builder artifact", encoding="utf-8")
    new_file.write_text("new builder artifact", encoding="utf-8")
    os.utime(old_file, (1_700_000_100, 1_700_000_100))
    os.utime(new_file, (1_700_000_500, 1_700_000_500))

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("old-task-thread", "new-task-thread")

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "old-task-thread": old_task_user_data,
            "new-task-thread": new_task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact", lambda *, thread_id, filename: None)

    response = asyncio.run(
        artifacts_router.get_artifact(
            "parent-thread",
            "mnt/user-data/outputs/report.md",
            http_request(),
            authenticated_user_id="user-1",
        )
    )

    assert bytes(response.body).decode("utf-8") == "new builder artifact"
    assert response.media_type == "text/markdown"


def test_get_skill_archive_member_resolves_associated_builder_task_output(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"
    task_outputs = task_user_data / "outputs"
    task_outputs.mkdir(parents=True)
    skill_path = task_outputs / "demo.skill"
    with zipfile.ZipFile(skill_path, "w") as archive:
        archive.writestr("demo/SKILL.md", "# Demo skill\n")

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)

    response = asyncio.run(
        artifacts_router.get_artifact(
            "parent-thread",
            "mnt/user-data/outputs/demo.skill/SKILL.md",
            http_request(),
            authenticated_user_id="user-1",
        )
    )

    assert bytes(response.body).decode("utf-8") == "# Demo skill\n"
    assert response.media_type == "text/markdown"


def test_list_artifacts_includes_builder_task_pdf_with_mime_type(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"
    task_outputs = task_user_data / "outputs"
    task_outputs.mkdir(parents=True)
    pdf_file = task_outputs / "simple-product-review.pdf"
    pdf_file.write_bytes(b"%PDF-1.4\n")

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "list_artifacts", lambda *, thread_id: [])

    response = asyncio.run(
        artifacts_router.list_artifacts("parent-thread", authenticated_user_id="user-1")
    )

    assert [item.path for item in response.artifacts] == [
        "mnt/user-data/outputs/simple-product-review.pdf"
    ]
    assert response.artifacts[0].mime_type == "application/pdf"


def test_get_artifact_serves_associated_builder_task_pdf_inline(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"
    task_outputs = task_user_data / "outputs"
    task_outputs.mkdir(parents=True)
    pdf_bytes = b"%PDF-1.4\nbody"
    (task_outputs / "simple-product-review.pdf").write_bytes(pdf_bytes)

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact", lambda *, thread_id, filename: None)

    response = asyncio.run(
        artifacts_router.get_artifact(
            "parent-thread",
            "mnt/user-data/outputs/simple-product-review.pdf",
            http_request(),
            authenticated_user_id="user-1",
        )
    )

    assert bytes(response.body) == pdf_bytes
    assert response.media_type == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline;")


def test_get_artifact_download_resolves_leading_slash_builder_task_output(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"
    task_outputs = task_user_data / "outputs"
    task_outputs.mkdir(parents=True)
    (task_outputs / "builder-demo.md").write_text("builder artifact", encoding="utf-8")

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact", lambda *, thread_id, filename: None)

    response = asyncio.run(
        artifacts_router.get_artifact(
            "parent-thread",
            "/mnt/user-data/outputs/builder-demo.md",
            http_request(b"download=true"),
            authenticated_user_id="user-1",
        )
    )

    assert response.headers["content-disposition"].startswith("attachment;")
    assert "builder-demo.md" in response.headers["content-disposition"]


def test_get_artifact_returns_safe_detail_when_parent_and_builder_task_outputs_missing(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    task_user_data = tmp_path / "task" / "user-data"

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("task-thread",)

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(
        artifacts_router,
        "resolve_thread_virtual_path",
        thread_user_data_resolver({
            "parent-thread": parent_user_data,
            "task-thread": task_user_data,
        }),
    )
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact", lambda *, thread_id, filename: None)

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "parent-thread",
                "mnt/user-data/outputs/missing.md",
                http_request(),
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
        assert exc.detail == {
            "message": "Artifact not found",
            "requested_path": "mnt/user-data/outputs/missing.md",
            "normalized_path": "mnt/user-data/outputs/missing.md",
            "checked_parent_thread": "parent-thread",
            "checked_builder_task_outputs": True,
            "checked_builder_task_thread_ids": ["task-thread"],
            "failure_reason": "not_found_in_parent_or_associated_builder_tasks",
        }
    else:
        raise AssertionError("Expected missing associated builder task artifact to return 404")


def test_list_artifacts_requires_thread_owner_before_supabase_listing(tmp_path, monkeypatch) -> None:
    missing_outputs = tmp_path / "missing" / "outputs"
    supabase_calls: list[str] = []

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "thread-1"
            return None

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: missing_outputs)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: supabase_calls.append(thread_id) or [],
    )

    import fastapi

    try:
        asyncio.run(artifacts_router.list_artifacts("thread-1", authenticated_user_id="user-1"))
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("Expected 404 for non-owned thread")
    assert supabase_calls == []


def test_list_artifacts_preserves_local_non_sophia_outputs_without_supabase_lookup(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    local_file = outputs_dir / "legacy-report.md"
    local_file.write_text("legacy", encoding="utf-8")
    supabase_calls: list[str] = []

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "legacy-thread"
            return None

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: outputs_dir)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: supabase_calls.append(thread_id) or [],
    )

    response = asyncio.run(
        artifacts_router.list_artifacts("legacy-thread", authenticated_user_id="user-1")
    )

    assert [item.path for item in response.artifacts] == ["mnt/user-data/outputs/legacy-report.md"]
    assert supabase_calls == []


def test_get_artifact_preserves_listed_local_non_sophia_output(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    workspace_outputs_dir = tmp_path / "workspace" / "outputs"
    outputs_dir.mkdir()
    local_file = outputs_dir / "legacy-report.md"
    local_file.write_text("legacy", encoding="utf-8")

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "legacy-thread"
            return None

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        if virtual_path == "mnt/user-data/outputs":
            return outputs_dir
        if virtual_path == "mnt/user-data/outputs/legacy-report.md":
            return local_file
        if virtual_path == "mnt/user-data/workspace/outputs/legacy-report.md":
            return workspace_outputs_dir / "legacy-report.md"
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: [],
    )

    listed = asyncio.run(
        artifacts_router.list_artifacts("legacy-thread", authenticated_user_id="user-1")
    )
    assert [item.path for item in listed.artifacts] == ["mnt/user-data/outputs/legacy-report.md"]

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(
        artifacts_router.get_artifact(
            "legacy-thread",
            "mnt/user-data/outputs/legacy-report.md",
            request,
            authenticated_user_id="user-1",
        )
    )

    assert bytes(response.body).decode("utf-8") == "legacy"
    assert response.media_type == "text/markdown"


def test_list_artifacts_rejects_local_outputs_for_non_owner_sophia_thread(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    (outputs_dir / "private-report.md").write_text("private", encoding="utf-8")
    supabase_calls: list[str] = []

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "thread-1"
            return None

        def find_any_session_by_thread_id(self, thread_id: str):
            assert thread_id == "thread-1"
            return object()

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: outputs_dir)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "list_artifacts",
        lambda *, thread_id: supabase_calls.append(thread_id) or [],
    )

    import fastapi

    try:
        asyncio.run(artifacts_router.list_artifacts("thread-1", authenticated_user_id="user-1"))
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("Expected 404 for non-owned Sophia thread")
    assert supabase_calls == []


def test_list_artifacts_route_requires_authentication(monkeypatch) -> None:
    monkeypatch.delenv("SOPHIA_AUTH_BYPASS", raising=False)
    app = FastAPI()
    app.include_router(artifacts_router.router)

    response = TestClient(app).get("/api/threads/thread-1/artifacts")

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing bearer token"


def test_get_artifact_requires_thread_owner_before_supabase_download(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    workspace_outputs_dir = tmp_path / "workspace" / "outputs"
    download_calls: list[str] = []

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "thread-1"
            return None

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        if virtual_path == "mnt/user-data/outputs/report.md":
            return outputs_dir / "report.md"
        if virtual_path == "mnt/user-data/workspace/outputs/report.md":
            return workspace_outputs_dir / "report.md"
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact",
        lambda *, thread_id, filename: download_calls.append(filename) or None,
    )

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "thread-1",
                "mnt/user-data/outputs/report.md",
                request,
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("Expected 404 for non-owned thread")
    assert download_calls == []


def test_get_artifact_requires_thread_owner_before_local_output(tmp_path, monkeypatch) -> None:
    local_output = tmp_path / "outputs" / "report.md"
    local_output.parent.mkdir(parents=True)
    local_output.write_text("private report", encoding="utf-8")

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "thread-1"
            return None

        def find_any_session_by_thread_id(self, thread_id: str):
            assert thread_id == "thread-1"
            return object()

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: local_output)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "thread-1",
                "mnt/user-data/outputs/report.md",
                request,
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("Expected 404 for non-owned local output")


def test_get_artifact_rejects_dot_segments_before_owner_check(tmp_path, monkeypatch) -> None:
    local_output = tmp_path / "outputs" / "report.md"
    local_output.parent.mkdir(parents=True)
    local_output.write_text("private report", encoding="utf-8")
    resolve_calls: list[str] = []

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "thread-1"
            return None

        def find_any_session_by_thread_id(self, thread_id: str):
            assert thread_id == "thread-1"
            return object()

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        resolve_calls.append(virtual_path)
        if virtual_path == "mnt/user-data/outputs/report.md":
            return local_output
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "thread-1",
                "mnt/user-data/uploads/../outputs/report.md",
                request,
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Expected 403 for artifact path traversal")
    assert resolve_calls == []


def test_get_artifact_rejects_encoded_traversal_before_resolution(tmp_path, monkeypatch) -> None:
    resolve_calls: list[tuple[str, str]] = []

    def resolve_path(thread_id: str, virtual_path: str) -> Path:
        resolve_calls.append((thread_id, virtual_path))
        return tmp_path / "should-not-resolve"

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "parent-thread",
                "mnt/user-data/outputs/%2e%2e/uploads/secret.txt",
                http_request(),
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Expected 403 for encoded artifact path traversal")
    assert resolve_calls == []


def test_get_artifact_rejects_traversal_out_of_protected_outputs(tmp_path, monkeypatch) -> None:
    upload_path = tmp_path / "uploads" / "notes.txt"
    upload_path.parent.mkdir(parents=True)
    upload_path.write_text("uploaded note", encoding="utf-8")
    resolve_calls: list[str] = []

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        resolve_calls.append(virtual_path)
        return upload_path

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "legacy-thread",
                "mnt/user-data/outputs/../uploads/notes.txt",
                request,
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Expected 403 for traversal out of protected outputs")
    assert resolve_calls == []


def test_get_artifact_does_not_serve_unassociated_builder_task_output(tmp_path, monkeypatch) -> None:
    parent_user_data = tmp_path / "parent" / "user-data"
    associated_user_data = tmp_path / "associated" / "user-data"
    unassociated_user_data = tmp_path / "unassociated" / "user-data"
    unassociated_outputs = unassociated_user_data / "outputs"
    unassociated_outputs.mkdir(parents=True)
    (unassociated_outputs / "builder-demo.md").write_text("wrong parent", encoding="utf-8")
    resolve_calls: list[tuple[str, str]] = []

    async def associated(parent_thread_id: str) -> tuple[str, ...]:
        assert parent_thread_id == "parent-thread"
        return ("associated-task",)

    def resolve_path(thread_id: str, virtual_path: str) -> Path:
        resolve_calls.append((thread_id, virtual_path))
        normalized = virtual_path.lstrip("/")
        prefix = "mnt/user-data/"
        if not normalized.startswith(prefix):
            raise AssertionError(f"Unexpected virtual path: {virtual_path}")
        return {
            "parent-thread": parent_user_data,
            "associated-task": associated_user_data,
            "unassociated-task": unassociated_user_data,
        }[thread_id] / normalized[len(prefix) :]

    monkeypatch.setattr(artifacts_router, "_session_store", OwnedSophiaSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)
    monkeypatch.setattr(artifacts_router, "_associated_builder_task_thread_ids", associated)
    monkeypatch.setattr(artifacts_router.supabase_artifact_store, "download_artifact", lambda *, thread_id, filename: None)

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact(
                "parent-thread",
                "mnt/user-data/outputs/builder-demo.md",
                http_request(),
                authenticated_user_id="user-1",
            )
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("Expected 404 for artifact in unassociated task thread")
    assert all(thread_id != "unassociated-task" for thread_id, _ in resolve_calls)


def test_get_artifact_preserves_local_non_sophia_upload_url(tmp_path, monkeypatch) -> None:
    upload_path = tmp_path / "uploads" / "notes.txt"
    upload_path.parent.mkdir(parents=True)
    upload_path.write_text("uploaded note", encoding="utf-8")

    class FakeSessionStore:
        def find_session_by_thread_id(self, user_id: str, thread_id: str):
            assert user_id == "user-1"
            assert thread_id == "legacy-thread"
            return None

    monkeypatch.setattr(artifacts_router, "_session_store", FakeSessionStore())
    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: upload_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(
        artifacts_router.get_artifact(
            "legacy-thread",
            "mnt/user-data/uploads/notes.txt",
            request,
            authenticated_user_id="user-1",
        )
    )

    assert bytes(response.body).decode("utf-8") == "uploaded note"
    assert response.media_type == "text/plain"


def test_get_artifact_falls_back_to_workspace_outputs_when_primary_output_is_missing(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    workspace_outputs_dir = tmp_path / "workspace" / "outputs"
    workspace_outputs_dir.mkdir(parents=True)
    artifact_path = workspace_outputs_dir / "report.md"
    artifact_path.write_text("workspace copy", encoding="utf-8")

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        if virtual_path == "mnt/user-data/outputs/report.md":
            return outputs_dir / "report.md"
        if virtual_path == "mnt/user-data/workspace/outputs/report.md":
            return artifact_path
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(artifacts_router.get_artifact("thread-1", "mnt/user-data/outputs/report.md", request))

    assert bytes(response.body).decode("utf-8") == "workspace copy"
    assert response.media_type == "text/markdown"


def test_get_artifact_resolves_outputs_and_workspace_fallback_with_requested_thread_id(tmp_path, monkeypatch) -> None:
    thread_a_user_data = tmp_path / "thread-a" / "user-data"
    thread_b_user_data = tmp_path / "thread-b" / "user-data"

    thread_a_outputs = thread_a_user_data / "outputs"
    thread_b_workspace_outputs = thread_b_user_data / "workspace" / "outputs"
    thread_a_outputs.mkdir(parents=True)
    thread_b_workspace_outputs.mkdir(parents=True)

    thread_a_artifact = thread_a_outputs / "report.md"
    thread_b_workspace_artifact = thread_b_workspace_outputs / "report.md"
    thread_a_artifact.write_text("thread-a primary", encoding="utf-8")
    thread_b_workspace_artifact.write_text("thread-b fallback", encoding="utf-8")

    thread_roots = {
        "thread-a": thread_a_user_data,
        "thread-b": thread_b_user_data,
    }
    resolve_calls: list[tuple[str, str]] = []

    def resolve_path(thread_id: str, virtual_path: str) -> Path:
        resolve_calls.append((thread_id, virtual_path))
        normalized = virtual_path.lstrip("/")
        prefix = "mnt/user-data/"
        if not normalized.startswith(prefix):
            raise AssertionError(f"Unexpected virtual path: {virtual_path}")
        return thread_roots[thread_id] / normalized[len(prefix) :]

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})

    response_a = asyncio.run(artifacts_router.get_artifact("thread-a", "mnt/user-data/outputs/report.md", request))
    response_b = asyncio.run(artifacts_router.get_artifact("thread-b", "mnt/user-data/outputs/report.md", request))

    assert bytes(response_a.body).decode("utf-8") == "thread-a primary"
    assert bytes(response_b.body).decode("utf-8") == "thread-b fallback"
    assert resolve_calls == [
        ("thread-a", "mnt/user-data/outputs/report.md"),
        ("thread-b", "mnt/user-data/outputs/report.md"),
        ("thread-b", "mnt/user-data/workspace/outputs/report.md"),
    ]


def test_get_artifact_falls_back_to_supabase_when_local_and_workspace_copies_missing(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    workspace_outputs_dir = tmp_path / "workspace" / "outputs"

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        if virtual_path == "mnt/user-data/outputs/report.md":
            return outputs_dir / "report.md"
        if virtual_path == "mnt/user-data/workspace/outputs/report.md":
            return workspace_outputs_dir / "report.md"
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)

    download_calls: list[dict[str, str]] = []

    def fake_download(*, thread_id: str, filename: str):
        download_calls.append({"thread_id": thread_id, "filename": filename})
        return (b"supabase copy", "text/markdown")

    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact",
        fake_download,
    )

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(
        artifacts_router.get_artifact("thread-z", "mnt/user-data/outputs/report.md", request)
    )

    assert bytes(response.body).decode("utf-8") == "supabase copy"
    assert response.media_type == "text/markdown"
    assert download_calls == [{"thread_id": "thread-z", "filename": "report.md"}]


def test_get_artifact_returns_404_when_local_missing_and_supabase_has_no_object(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    workspace_outputs_dir = tmp_path / "workspace" / "outputs"

    def resolve_path(_thread_id: str, virtual_path: str) -> Path:
        if virtual_path == "mnt/user-data/outputs/report.md":
            return outputs_dir / "report.md"
        if virtual_path == "mnt/user-data/workspace/outputs/report.md":
            return workspace_outputs_dir / "report.md"
        raise AssertionError(f"Unexpected virtual path: {virtual_path}")

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", resolve_path)
    monkeypatch.setattr(
        artifacts_router.supabase_artifact_store,
        "download_artifact",
        lambda *, thread_id, filename: None,
    )

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})

    import fastapi

    try:
        asyncio.run(
            artifacts_router.get_artifact("thread-z", "mnt/user-data/outputs/report.md", request)
        )
    except fastapi.HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("Expected 404 when both local and Supabase copies are missing")
