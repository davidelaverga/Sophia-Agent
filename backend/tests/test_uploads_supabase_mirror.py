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


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-v"])
