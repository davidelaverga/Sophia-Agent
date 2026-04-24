import asyncio
import os
from pathlib import Path

from starlette.requests import Request

import app.gateway.routers.artifacts as artifacts_router


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


def test_get_artifact_falls_back_to_binary_response_for_non_utf8_file(tmp_path, monkeypatch) -> None:
    artifact_path = tmp_path / "guide.pdf"
    content = b"%PDF-1.4\n\x93binary-pdf-content"
    artifact_path.write_bytes(content)

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: artifact_path)

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b""})
    response = asyncio.run(artifacts_router.get_artifact("thread-1", "mnt/user-data/outputs/guide.pdf", request))

    assert bytes(response.body) == content
    assert response.media_type == "application/pdf"


def test_list_artifacts_returns_output_files_sorted_by_modified_time(tmp_path, monkeypatch) -> None:
    outputs_dir = tmp_path / "outputs"
    nested_dir = outputs_dir / "nested"
    nested_dir.mkdir(parents=True)

    older_file = outputs_dir / "first.md"
    newer_file = nested_dir / "second.txt"
    older_file.write_text("first", encoding="utf-8")
    newer_file.write_text("second", encoding="utf-8")
    os.utime(older_file, (1_700_000_000, 1_700_000_000))
    os.utime(newer_file, (1_700_000_100, 1_700_000_100))

    monkeypatch.setattr(artifacts_router, "resolve_thread_virtual_path", lambda _thread_id, _path: outputs_dir)

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

    def fake_download(*, user_id: str | None, thread_id: str, filename: str):
        download_calls.append({"user_id": user_id, "thread_id": thread_id, "filename": filename})
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
    assert download_calls == [{"user_id": None, "thread_id": "thread-z", "filename": "report.md"}]


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
        lambda *, user_id, thread_id, filename: None,
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

