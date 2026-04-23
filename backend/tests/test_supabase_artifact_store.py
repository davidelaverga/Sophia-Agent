"""Unit tests for the Supabase artifact store adapter."""

from __future__ import annotations

import httpx
import pytest

from deerflow.sophia.storage import supabase_artifact_store


@pytest.fixture(autouse=True)
def _clear_supabase_env(monkeypatch):
    for var in (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SERVICE_KEY",
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


def test_is_configured_true_with_service_key_alias(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc-role-key")

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
