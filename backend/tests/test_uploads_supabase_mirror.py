"""Gateway upload → Supabase mirror (PR #132 cross-service bridge).

The gateway and the langgraph runtime are separate Render containers with
separate ephemeral disks. A file the gateway writes to its own disk is
invisible to the companion's read tools (which run in langgraph). The
upload route mirrors every file to Supabase Storage so the read tools can
download it on a local miss.

These cover ``_mirror_upload_to_supabase`` — the best-effort helper the
upload route calls for both the original file and its converted ``.md``
sibling.
"""

from __future__ import annotations

import pytest


def test_mirror_calls_upload_artifact_when_configured(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    calls: list[tuple[str, str, bytes]] = []

    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setattr(
        up.supabase_artifact_store,
        "upload_artifact",
        lambda thread_id, filename, content: calls.append((thread_id, filename, content)),
    )

    up._mirror_upload_to_supabase("thread-1", "report.pdf", b"%PDF-1.4 data")

    # Uploads keyspace is prefixed (Codex P1 PR #132): the mirror object is
    # ``{thread_id}/uploads/report.pdf``, NOT ``{thread_id}/report.pdf``
    # (which is the builder-output keyspace — collision otherwise).
    assert calls == [("thread-1", "uploads/report.pdf", b"%PDF-1.4 data")]


def test_mirror_noop_when_not_configured(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    called = False

    def _should_not_run(*_a, **_k):
        nonlocal called
        called = True

    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: False)
    monkeypatch.setattr(up.supabase_artifact_store, "upload_artifact", _should_not_run)

    up._mirror_upload_to_supabase("thread-1", "report.pdf", b"data")

    assert called is False


def test_mirror_swallows_upload_errors(monkeypatch) -> None:
    """A Supabase outage must NOT fail the upload — the helper logs and
    returns, never raises."""
    from app.gateway.routers import uploads as up

    def _boom(*_a, **_k):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setattr(up.supabase_artifact_store, "upload_artifact", _boom)

    # Must not raise.
    up._mirror_upload_to_supabase("thread-1", "report.pdf", b"data")


def test_delete_endpoint_helper_removes_supabase_mirror(monkeypatch) -> None:
    """DELETE mirror removal (PR #132): discarding an upload must also drop
    the Supabase copy, or the read tools would re-materialize the deleted
    file from the mirror on the next local miss."""
    from app.gateway.routers import uploads as up

    deletes: list[tuple[str, str]] = []
    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setattr(
        up.supabase_artifact_store,
        "delete_artifact",
        lambda thread_id, filename: deletes.append((thread_id, filename)),
    )

    up._delete_supabase_mirror("thread-1", "report.pdf")

    # Prefixed uploads keyspace (Codex P1 PR #132).
    assert deletes == [("thread-1", "uploads/report.pdf")]


def test_delete_mirror_noop_when_not_configured(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    called = False

    def _should_not_run(*_a, **_k):
        nonlocal called
        called = True

    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: False)
    monkeypatch.setattr(up.supabase_artifact_store, "delete_artifact", _should_not_run)

    up._delete_supabase_mirror("thread-1", "report.pdf")

    assert called is False


def test_delete_mirror_swallows_errors(monkeypatch) -> None:
    """A Supabase outage on delete must not 500 the DELETE endpoint."""
    from app.gateway.routers import uploads as up

    def _boom(*_a, **_k):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: True)
    monkeypatch.setattr(up.supabase_artifact_store, "delete_artifact", _boom)

    up._delete_supabase_mirror("thread-1", "report.pdf")  # must not raise


def test_store_delete_artifact_idempotent_on_404(monkeypatch) -> None:
    """``delete_artifact`` treats a 404 as success (idempotent delete)."""
    from deerflow.sophia.storage import supabase_artifact_store as store

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

    class _FakeResp:
        status_code = 404
        is_success = False
        text = ""

    class _FakeClient:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def delete(self, url, headers=None):  # noqa: ANN001
            self.calls.append(url)
            return _FakeResp()

        def close(self) -> None:
            pass

    fake = _FakeClient()
    assert store.delete_artifact("thread-1", "gone.png", client=fake) is True
    assert len(fake.calls) == 1
    assert "thread-1/gone.png" in fake.calls[0]


def test_store_delete_artifact_returns_false_when_unconfigured(monkeypatch) -> None:
    from deerflow.sophia.storage import supabase_artifact_store as store

    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)

    assert store.delete_artifact("thread-1", "x.png") is False


# ─── Uploads list must include the Supabase mirror (Codex P2 PR #132) ──


class _FakeListResp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.is_success = 200 <= status_code < 300

    def json(self):
        return self._payload


class _FakeListClient:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self._status = status_code
        self.calls: list[tuple[str, dict]] = []

    def post(self, url, json=None, headers=None):  # noqa: A002 — match httpx signature
        self.calls.append((url, json))
        return _FakeListResp(self._payload, self._status)

    def close(self):
        pass


def test_store_list_upload_filenames_strips_prefix_and_filters(monkeypatch) -> None:
    """list_upload_filenames returns bare names under {thread_id}/uploads/,
    skipping the empty-folder placeholder (id=None) and nested entries."""
    from deerflow.sophia.storage import supabase_artifact_store as store

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

    payload = [
        {"name": "report.pdf", "id": "obj-1"},
        {"name": "image.png", "id": "obj-2"},
        {"name": ".emptyFolderPlaceholder", "id": None},  # Supabase placeholder
        {"name": "nested/inner.png", "id": "obj-3"},  # nested — skip
    ]
    fake = _FakeListClient(payload)
    names = store.list_upload_filenames("thread-1", client=fake)

    assert sorted(names) == ["image.png", "report.pdf"]
    # The list request targets the {thread_id}/uploads/ prefix.
    _url, body = fake.calls[0]
    assert body["prefix"] == "thread-1/uploads/"


def test_store_list_upload_filenames_empty_when_unconfigured(monkeypatch) -> None:
    from deerflow.sophia.storage import supabase_artifact_store as store

    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)

    assert store.list_upload_filenames("thread-1") == []


def test_list_helper_swallows_errors(monkeypatch) -> None:
    from app.gateway.routers import uploads as up

    monkeypatch.setattr(up.supabase_artifact_store, "is_configured", lambda: True)

    def _boom(*_a, **_k):
        raise RuntimeError("supabase down")

    monkeypatch.setattr(up.supabase_artifact_store, "list_upload_filenames", _boom)

    assert up._list_supabase_upload_filenames("thread-1") == []


def test_list_endpoint_unions_local_and_mirror(monkeypatch, tmp_path) -> None:
    """The /list endpoint unions local disk + Supabase mirror and dedupes by
    filename, so the AttachmentBar uniquifier sees mirrored names too."""
    import asyncio

    from app.gateway.routers import uploads as up

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir(parents=True)
    (uploads_dir / "local_only.png").write_bytes(b"local")
    (uploads_dir / "shared.png").write_bytes(b"both")  # also in mirror

    monkeypatch.setattr(up, "get_uploads_dir", lambda _tid: uploads_dir)
    # Mirror has the shared file (dup) + a mirror-only file.
    monkeypatch.setattr(
        up, "_list_supabase_upload_filenames",
        lambda _tid: ["shared.png", "mirror_only.pdf"],
    )

    result = asyncio.run(up.list_uploaded_files("thread-1"))
    names = {f["filename"] for f in result["files"]}
    assert names == {"local_only.png", "shared.png", "mirror_only.pdf"}
    assert result["count"] == 3
    # The mirror-only entry is tagged so callers can tell it's not local yet.
    mirror_only = next(f for f in result["files"] if f["filename"] == "mirror_only.pdf")
    assert mirror_only["source"] == "supabase-mirror"
    # The shared file appears once (local wins, no source tag).
    shared = [f for f in result["files"] if f["filename"] == "shared.png"]
    assert len(shared) == 1
    assert "source" not in shared[0]


def test_list_endpoint_returns_mirror_when_local_dir_absent(monkeypatch, tmp_path) -> None:
    """The bug's core case: gateway disk lost (Render restart) so the local
    uploads dir doesn't exist, but the mirror still holds prior uploads. The
    endpoint must surface the mirror names, not an empty list."""
    import asyncio

    from app.gateway.routers import uploads as up

    missing_dir = tmp_path / "gone" / "uploads"  # never created

    monkeypatch.setattr(up, "get_uploads_dir", lambda _tid: missing_dir)
    monkeypatch.setattr(
        up, "_list_supabase_upload_filenames",
        lambda _tid: ["image.png", "report.pdf"],
    )

    result = asyncio.run(up.list_uploaded_files("thread-1"))
    names = {f["filename"] for f in result["files"]}
    assert names == {"image.png", "report.pdf"}, (
        "When the local dir is gone, the list must still surface mirrored "
        "uploads so the uniquifier reserves their names."
    )


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
