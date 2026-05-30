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

    assert calls == [("thread-1", "report.pdf", b"%PDF-1.4 data")]


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

    assert deletes == [("thread-1", "report.pdf")]


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


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
