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
        user_id="user-1", thread_id="thread-1", filename="note.md", content=b"hello"
    )
    assert result is None


def test_upload_posts_to_user_thread_folder_with_defaults(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["content"] = request.content
        return httpx.Response(200, json={"Key": "sophia_builder/user-1/thread-1/note.md"})

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)

    object_path = supabase_artifact_store.upload_artifact(
        user_id="user-1",
        thread_id="thread-1",
        filename="note.md",
        content=b"hello",
        client=client,
    )

    assert object_path == "user-1/thread-1/note.md"
    assert captured["url"] == (
        "https://example.supabase.co/storage/v1/object/sophia_builder/user-1/thread-1/note.md"
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
        user_id="user-1",
        thread_id="thread-2",
        filename="deck.pptx",
        content=b"x",
        client=client,
    )

    assert "/storage/v1/object/custom_bucket/user-1/thread-2/deck.pptx" in captured["url"]


def test_download_tries_new_layout_first(monkeypatch) -> None:
    _configure(monkeypatch)
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        if "user-1/thread-1/note.md" in str(request.url):
            return httpx.Response(
                200,
                content=b"new-layout",
                headers={"content-type": "text/markdown"},
            )
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(
        user_id="user-1",
        thread_id="thread-1",
        filename="note.md",
        client=client,
    )

    assert result == (b"new-layout", "text/markdown")
    assert len(seen_urls) == 1
    assert "/user-1/thread-1/note.md" in seen_urls[0]


def test_download_falls_back_to_legacy_layout(monkeypatch) -> None:
    _configure(monkeypatch)
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen_urls.append(url)
        if "user-1/thread-1/note.md" in url:
            return httpx.Response(404)
        if "sophia_builder/thread-1/note.md" in url:
            return httpx.Response(
                200,
                content=b"legacy",
                headers={"content-type": "text/markdown"},
            )
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(
        user_id="user-1",
        thread_id="thread-1",
        filename="note.md",
        client=client,
    )

    assert result == (b"legacy", "text/markdown")
    assert len(seen_urls) == 2


def test_download_returns_none_when_both_layouts_missing(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(
        user_id="user-1",
        thread_id="thread-1",
        filename="note.md",
        client=client,
    )
    assert result is None


def test_download_with_no_user_only_tries_legacy(monkeypatch) -> None:
    _configure(monkeypatch)
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen_urls.append(url)
        return httpx.Response(200, content=b"x", headers={"content-type": "text/plain"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    supabase_artifact_store.download_artifact(
        user_id=None,
        thread_id="thread-1",
        filename="note.md",
        client=client,
    )

    assert len(seen_urls) == 1
    assert "sophia_builder/thread-1/note.md" in seen_urls[0]


def test_delete_tries_new_then_legacy(monkeypatch) -> None:
    _configure(monkeypatch)
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen_urls.append(url)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    deleted = supabase_artifact_store.delete_object(
        user_id="user-1",
        thread_id="thread-1",
        filename="note.md",
        client=client,
    )

    assert deleted is True
    assert len(seen_urls) == 2
    assert "/user-1/thread-1/note.md" in seen_urls[0]
    assert "/sophia_builder/thread-1/note.md" in seen_urls[1]


def test_delete_returns_false_when_both_missing(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    deleted = supabase_artifact_store.delete_object(
        user_id="user-1",
        thread_id="thread-1",
        filename="note.md",
        client=client,
    )
    assert deleted is False


def test_upload_rejects_blank_user_thread_or_filename(monkeypatch) -> None:
    _configure(monkeypatch)
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(
            user_id=" ", thread_id="thread-1", filename="note.md", content=b"x"
        )
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(
            user_id="user-1", thread_id="  ", filename="note.md", content=b"x"
        )
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(
            user_id="user-1", thread_id="thread-1", filename=" ", content=b"x"
        )


def test_list_user_objects_walks_thread_folders(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode() if request.content else ""
        payload = json.loads(body) if body else {}
        prefix = payload.get("prefix", "")
        if prefix == "user-1/":
            return httpx.Response(
                200,
                json=[
                    {"name": "thread-a", "id": None},
                    {"name": "thread-b", "id": None},
                ],
            )
        if prefix == "user-1/thread-a/":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "note.md",
                        "id": "obj-1",
                        "updated_at": "2026-04-22T10:00:00Z",
                        "metadata": {"size": 12, "mimetype": "text/markdown"},
                    }
                ],
            )
        if prefix == "user-1/thread-b/":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "deck.pptx",
                        "id": "obj-2",
                        "updated_at": "2026-04-23T10:00:00Z",
                        "metadata": {"size": 99, "mimetype": "application/vnd"},
                    }
                ],
            )
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.list_user_objects("user-1", client=client)

    assert result is not None
    names = [item["name"] for item in result]
    assert names == ["thread-b/deck.pptx", "thread-a/note.md"]
