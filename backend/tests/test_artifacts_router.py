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
