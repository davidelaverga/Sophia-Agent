"""Unit tests for the Supabase artifact store adapter."""

from __future__ import annotations

import json

import httpx
import pytest

from deerflow.sophia.storage import supabase_artifact_store


@pytest.fixture(autouse=True)
def _clear_supabase_env(monkeypatch):
    for var in (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_KEY",
        "SUPABASE_BUILDER_BUCKET",
    ):
        monkeypatch.delenv(var, raising=False)


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key")


def test_is_configured_false_when_env_missing() -> None:
    assert supabase_artifact_store.is_configured() is False


def test_is_configured_true_when_env_present(monkeypatch) -> None:
    _configure(monkeypatch)
    assert supabase_artifact_store.is_configured() is True


def test_upload_noop_when_not_configured() -> None:
    result = supabase_artifact_store.upload_artifact(
        thread_id="thread-1", filename="note.md", content=b"hello"
    )
    assert result is None


def test_upload_posts_to_thread_folder_with_defaults(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["content"] = request.content
        return httpx.Response(200, json={"Key": "sophia_builder/thread-1/note.md"})

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)

    object_path = supabase_artifact_store.upload_artifact(
        thread_id="thread-1",
        filename="note.md",
        content=b"hello",
        client=client,
    )

    assert object_path == "thread-1/note.md"
    assert captured["url"] == (
        "https://example.supabase.co/storage/v1/object/sophia_builder/thread-1/note.md"
    )
    headers = captured["headers"]
    assert headers["authorization"] == "Bearer svc-role-key"
    assert headers["apikey"] == "svc-role-key"
    assert headers["x-upsert"] == "true"
    assert headers["content-type"] == "text/markdown"
    assert captured["content"] == b"hello"


def test_upload_honors_custom_bucket(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "custom_bucket")

    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    supabase_artifact_store.upload_artifact(
        thread_id="thread-2", filename="deck.pptx", content=b"x", client=client
    )

    assert "/storage/v1/object/custom_bucket/thread-2/deck.pptx" in captured["url"]


def test_upload_encodes_object_path_segments(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    object_path = supabase_artifact_store.upload_artifact(
        thread_id="thread-1",
        filename="reports/report #1?.pdf",
        content=b"x",
        client=client,
    )

    assert object_path == "thread-1/reports/report #1?.pdf"
    assert captured["url"] == (
        "https://example.supabase.co/storage/v1/object/"
        "sophia_builder/thread-1/reports/report%20%231%3F.pdf"
    )


def test_download_returns_none_on_404(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(
        thread_id="thread-1", filename="note.md", client=client
    )
    assert result is None


def test_download_returns_bytes_and_content_type(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"stored",
            headers={"content-type": "text/markdown"},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(
        thread_id="thread-1", filename="note.md", client=client
    )

    assert result == (b"stored", "text/markdown")


def test_signed_url_request_encodes_object_path_segments(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"signedURL": "/object/sign/sophia_builder/token"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    supabase_artifact_store.create_signed_url(
        thread_id="thread-1",
        filename="report #1?.pdf",
        client=client,
    )

    assert captured["url"] == (
        "https://example.supabase.co/storage/v1/object/sign/"
        "sophia_builder/thread-1/report%20%231%3F.pdf"
    )


def test_list_artifacts_recurses_into_supabase_folder_records(monkeypatch) -> None:
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefixes.append(payload["prefix"])
        if payload["prefix"] == "thread-1/":
            return httpx.Response(200, json=[
                {"name": "assets", "id": None, "metadata": None},
                {
                    "name": "root.md",
                    "id": "file-root",
                    "metadata": {"size": 12, "mimetype": "text/markdown"},
                    "updated_at": "2026-05-27T20:00:00Z",
                },
            ])
        if payload["prefix"] == "thread-1/assets/":
            return httpx.Response(200, json=[
                {
                    "name": "style.css",
                    "id": "file-style",
                    "metadata": {"size": 34, "mimetype": "text/css"},
                    "updated_at": "2026-05-27T20:01:00Z",
                },
            ])
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/", "thread-1/assets/"]
    assert [(artifact.filename, artifact.size_bytes, artifact.content_type) for artifact in artifacts] == [
        ("assets/style.css", 34, "text/css"),
        ("root.md", 12, "text/markdown"),
    ]
    assert "assets" not in {artifact.filename for artifact in artifacts}


def test_list_artifacts_excludes_mirrored_uploads(monkeypatch) -> None:
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefixes.append(payload["prefix"])
        if payload["prefix"] == "thread-1/":
            return httpx.Response(200, json=[
                {"name": "uploads", "id": None, "metadata": None},
                {
                    "name": "uploads/leaked-input.pdf",
                    "id": "file-upload-direct",
                    "metadata": {"size": 99, "mimetype": "application/pdf"},
                    "updated_at": "2026-05-27T20:02:00Z",
                },
                {
                    "name": "builder-output.md",
                    "id": "file-output",
                    "metadata": {"size": 12, "mimetype": "text/markdown"},
                    "updated_at": "2026-05-27T20:00:00Z",
                },
            ])
        if payload["prefix"] == "thread-1/uploads/":
            return httpx.Response(200, json=[
                {
                    "name": "photo.png",
                    "id": "file-upload",
                    "metadata": {"size": 34, "mimetype": "image/png"},
                    "updated_at": "2026-05-27T20:01:00Z",
                },
            ])
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/"]
    assert [artifact.filename for artifact in artifacts] == ["builder-output.md"]


def test_upload_rejects_blank_thread_or_filename(monkeypatch) -> None:
    _configure(monkeypatch)
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(
            thread_id="  ", filename="note.md", content=b"x"
        )
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(
            thread_id="thread-1", filename=" ", content=b"x"
        )


def test_list_artifacts_excludes_delegation_ledger(monkeypatch) -> None:
    """Codex P1 PR #131: the mirrored delegation ledger
    ({thread_id}/ledger/session.jsonl) is internal conversation content —
    it must never surface as a user-facing artifact. The list filter must
    skip both the ledger FOLDER (no recursion into it) and any flat
    ledger-prefixed file record, exactly like the uploads keyspace."""
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefixes.append(payload["prefix"])
        if payload["prefix"] == "thread-1/":
            return httpx.Response(200, json=[
                {"name": "ledger", "id": None, "metadata": None},
                {
                    "name": "ledger/session.jsonl",
                    "id": "file-ledger-direct",
                    "metadata": {"size": 4096, "mimetype": "application/x-ndjson"},
                    "updated_at": "2026-06-11T20:02:00Z",
                },
                {
                    "name": "builder-output.md",
                    "id": "file-output",
                    "metadata": {"size": 12, "mimetype": "text/markdown"},
                    "updated_at": "2026-06-11T20:00:00Z",
                },
            ])
        if payload["prefix"] == "thread-1/ledger/":
            return httpx.Response(200, json=[
                {
                    "name": "session.jsonl",
                    "id": "file-ledger",
                    "metadata": {"size": 4096, "mimetype": "application/x-ndjson"},
                    "updated_at": "2026-06-11T20:01:00Z",
                },
            ])
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/"]  # never descended into ledger/
    assert [artifact.filename for artifact in artifacts] == ["builder-output.md"]


def test_is_ledger_object_name_covers_keyspace_and_descendants() -> None:
    assert supabase_artifact_store.is_ledger_object_name("ledger/session.jsonl") is True
    assert supabase_artifact_store.is_ledger_object_name("ledger") is True
    assert supabase_artifact_store.is_ledger_object_name("/ledger/session.jsonl") is True
    assert supabase_artifact_store.is_ledger_object_name("ledger/sub/dir.jsonl") is True
    assert supabase_artifact_store.is_ledger_object_name("report.pdf") is False
    assert supabase_artifact_store.is_ledger_object_name("ledgers/notes.md") is False
    assert supabase_artifact_store.is_ledger_object_name("uploads/ledger.csv") is False
