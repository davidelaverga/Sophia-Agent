"""Unit tests for the Supabase mirror module (PR-E, Phase 2.2)."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage import supabase_mirror


@pytest.fixture(autouse=True)
def _clear_env_and_cache(monkeypatch):
    """Reset environment and in-memory hash cache before every test."""
    monkeypatch.delenv("SOPHIA_SUPABASE_MIRROR_ALL", raising=False)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    supabase_mirror._MIRROR_HASH_CACHE.clear()
    yield
    supabase_mirror._MIRROR_HASH_CACHE.clear()


def _configure_supabase(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key")


def test_is_mirror_enabled_false_by_default(monkeypatch) -> None:
    """Mirror is off when SOPHIA_SUPABASE_MIRROR_ALL is absent."""
    monkeypatch.delenv("SOPHIA_SUPABASE_MIRROR_ALL", raising=False)
    # Force re-read of the module-level flag by reloading
    import importlib

    importlib.reload(supabase_mirror)
    assert supabase_mirror.is_mirror_enabled() is False


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", "TRUE", "YES", "ON"])
def test_is_mirror_enabled_true_when_env_set(monkeypatch, value: str) -> None:
    """Mirror is on for any canonical truthy value."""
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", value)
    import importlib

    importlib.reload(supabase_mirror)
    assert supabase_mirror.is_mirror_enabled() is True


def test_maybe_mirror_skips_when_feature_flag_off(monkeypatch, tmp_path) -> None:
    """With the flag off, maybe_mirror_file is a silent no-op."""
    monkeypatch.delenv("SOPHIA_SUPABASE_MIRROR_ALL", raising=False)
    import importlib

    importlib.reload(supabase_mirror)
    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    file_path = outputs_dir / "note.md"
    file_path.write_text("hello")
    # Should not raise even though Supabase is unconfigured
    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))


def test_maybe_mirror_uploads_file_when_enabled(monkeypatch, tmp_path) -> None:
    """When enabled, a file under outputs is uploaded via the artifact store."""
    _configure_supabase(monkeypatch)
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    file_path = outputs_dir / "report.md"
    file_path.write_text("build output")

    captured: dict[str, object] = {}

    def fake_upload_artifact(thread_id, filename, content, client=None):
        captured["thread_id"] = thread_id
        captured["filename"] = filename
        captured["content"] = content
        return f"{thread_id}/{filename}"

    monkeypatch.setattr(supabase_artifact_store, "upload_artifact", fake_upload_artifact)

    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))

    assert captured["thread_id"] == "thread-1"
    assert captured["filename"] == "report.md"
    assert captured["content"] == b"build output"


def test_maybe_mirror_dedup_on_unchanged_file(monkeypatch, tmp_path) -> None:
    """Second call with the same file content skips upload (hash dedup)."""
    _configure_supabase(monkeypatch)
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    file_path = outputs_dir / "stable.md"
    file_path.write_text("same content")

    upload_calls: list[dict[str, object]] = []

    def counting_upload(thread_id, filename, content, client=None):
        upload_calls.append({"thread_id": thread_id, "filename": filename, "content": content})
        return f"{thread_id}/{filename}"

    monkeypatch.setattr(supabase_artifact_store, "upload_artifact", counting_upload)

    # First call — should upload
    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))
    assert len(upload_calls) == 1

    # Second call — identical content, should dedup
    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))
    assert len(upload_calls) == 1

    # Change content — should upload again
    file_path.write_text("new content")
    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))
    assert len(upload_calls) == 2


def test_maybe_mirror_skips_files_outside_outputs(monkeypatch, tmp_path) -> None:
    """Files outside the outputs directory are not mirrored."""
    _configure_supabase(monkeypatch)
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()
    file_path = workspace_dir / "secret.md"
    file_path.write_text("should not mirror")

    upload_calls: list[dict[str, object]] = []
    monkeypatch.setattr(supabase_artifact_store, "upload_artifact", lambda **kw: upload_calls.append(kw))

    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))
    assert len(upload_calls) == 0


def test_scan_and_mirror_outputs_walks_directory(monkeypatch, tmp_path) -> None:
    """scan_and_mirror_outputs walks the outputs tree and mirrors every file."""
    _configure_supabase(monkeypatch)
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    (outputs_dir / "a" / "b").mkdir(parents=True)
    (outputs_dir / "top.md").write_text("top")
    (outputs_dir / "a" / "mid.md").write_text("mid")
    (outputs_dir / "a" / "b" / "deep.md").write_text("deep")

    upload_calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        supabase_artifact_store,
        "upload_artifact",
        lambda thread_id, filename, content, client=None: upload_calls.append(
            {"thread_id": thread_id, "filename": filename, "content": content}
        ),
    )

    supabase_mirror.scan_and_mirror_outputs("thread-1", str(outputs_dir))

    assert len(upload_calls) == 3
    filenames = {c["filename"] for c in upload_calls}
    assert filenames == {"top.md", "a/mid.md", "a/b/deep.md"}


def test_invalidate_cache_removes_thread_entries(monkeypatch, tmp_path) -> None:
    """invalidate_cache clears only the hashes for the specified thread."""
    _configure_supabase(monkeypatch)
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    (outputs_dir / "f1.md").write_text("one")
    (outputs_dir / "f2.md").write_text("two")

    monkeypatch.setattr(supabase_artifact_store, "upload_artifact", lambda **kw: f"{kw['thread_id']}/{kw['filename']}")

    supabase_mirror.maybe_mirror_file(str(outputs_dir / "f1.md"), "thread-a", str(outputs_dir))
    supabase_mirror.maybe_mirror_file(str(outputs_dir / "f2.md"), "thread-b", str(outputs_dir))

    assert len(supabase_mirror._MIRROR_HASH_CACHE) == 2

    supabase_mirror.invalidate_cache("thread-a")
    assert len(supabase_mirror._MIRROR_HASH_CACHE) == 1
    assert ("thread-b", "f2.md") in supabase_mirror._MIRROR_HASH_CACHE


def test_maybe_mirror_skips_when_supabase_unconfigured(monkeypatch, tmp_path) -> None:
    """If Supabase is not configured, mirror silently no-ops."""
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)
    # Ensure Supabase env is NOT set
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    file_path = outputs_dir / "note.md"
    file_path.write_text("hello")

    # Should not raise
    supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))


def test_maybe_mirror_logs_and_continues_on_upload_error(monkeypatch, tmp_path, caplog) -> None:
    """Upload errors are logged and swallowed so the builder never regresses."""
    _configure_supabase(monkeypatch)
    monkeypatch.setenv("SOPHIA_SUPABASE_MIRROR_ALL", "1")
    import importlib

    importlib.reload(supabase_mirror)

    outputs_dir = tmp_path / "outputs"
    outputs_dir.mkdir()
    file_path = outputs_dir / "note.md"
    file_path.write_text("hello")

    def exploding_upload(**kw):
        raise RuntimeError("network down")

    monkeypatch.setattr(supabase_artifact_store, "upload_artifact", exploding_upload)

    import logging

    with caplog.at_level(logging.WARNING, logger=supabase_mirror.logger.name):
        supabase_mirror.maybe_mirror_file(str(file_path), "thread-1", str(outputs_dir))

    assert "Mirror upload failed" in caplog.text
