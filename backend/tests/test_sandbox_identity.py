from __future__ import annotations

import os
import platform
import stat
from pathlib import Path

import pytest

from deerflow import sandbox_identity


def _thread_roots(base: Path, thread: str) -> tuple[Path, Path, Path, Path]:
    user_data = base / "threads" / thread / "user-data"
    workspace = user_data / "workspace"
    outputs = user_data / "outputs"
    uploads = user_data / "uploads"
    for root in (workspace, outputs, uploads):
        root.mkdir(parents=True, exist_ok=True)
    return user_data, workspace, outputs, uploads


def test_thread_identity_is_stable_and_thread_specific(tmp_path: Path) -> None:
    first, *_ = _thread_roots(tmp_path, "first")
    second, *_ = _thread_roots(tmp_path, "second")

    assert sandbox_identity.deterministic_thread_identity(first) == (
        sandbox_identity.deterministic_thread_identity(first)
    )
    assert sandbox_identity.deterministic_thread_identity(first) != (
        sandbox_identity.deterministic_thread_identity(second)
    )


def test_thread_identity_collision_fails_closed(tmp_path: Path, monkeypatch) -> None:
    first, *_ = _thread_roots(tmp_path, "first")
    second, *_ = _thread_roots(tmp_path, "second")
    monkeypatch.setattr(
        sandbox_identity,
        "deterministic_thread_identity",
        lambda _root: (812_345, 812_345),
    )
    if sandbox_identity.pwd is not None:
        monkeypatch.setattr(
            sandbox_identity.pwd,
            "getpwuid",
            lambda _uid: (_ for _ in ()).throw(KeyError()),
        )

    assert sandbox_identity.claim_thread_identity(first) == (812_345, 812_345)
    with pytest.raises(RuntimeError, match="UID collision"):
        sandbox_identity.claim_thread_identity(second)


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux ownership boundary",
)
def test_root_linux_boundary_is_non_writable_and_uploads_are_read_only(
    tmp_path: Path,
) -> None:
    user_data, workspace, outputs, uploads = _thread_roots(tmp_path, "secure")
    workspace_file = workspace / "resume.txt"
    workspace_file.write_text("resume", encoding="utf-8")
    upload = uploads / "source.txt"
    upload.write_text("source", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    link = workspace / "outside-link"
    link.symlink_to(outside)
    outside_before = outside.stat()

    uid, gid = sandbox_identity.prepare_thread_data_boundary(
        workspace_root=workspace,
        outputs_root=outputs,
        uploads_root=uploads,
    )

    assert (user_data.stat().st_uid, user_data.stat().st_gid) == (0, gid)
    assert stat.S_IMODE(user_data.stat().st_mode) == 0o710
    assert (workspace.stat().st_uid, workspace.stat().st_gid) == (uid, gid)
    assert stat.S_IMODE(workspace.stat().st_mode) == 0o700
    assert (workspace_file.stat().st_uid, workspace_file.stat().st_gid) == (uid, gid)
    assert stat.S_IMODE(workspace_file.stat().st_mode) == 0o600
    assert (uploads.stat().st_uid, uploads.stat().st_gid) == (0, gid)
    assert stat.S_IMODE(uploads.stat().st_mode) == 0o550
    assert (upload.stat().st_uid, upload.stat().st_gid) == (0, gid)
    assert stat.S_IMODE(upload.stat().st_mode) == 0o440
    assert link.is_symlink()
    assert (outside.stat().st_uid, outside.stat().st_gid) == (
        outside_before.st_uid,
        outside_before.st_gid,
    )


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux ownership boundary",
)
def test_root_linux_adoption_rejects_hardlink_and_upload_symlink_aliases(
    tmp_path: Path,
) -> None:
    _user_data, workspace, outputs, uploads = _thread_roots(tmp_path, "aliases")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    os.link(outside, workspace / "hardlink.txt")

    with pytest.raises(RuntimeError, match="single-link regular file"):
        sandbox_identity.prepare_thread_data_boundary(
            workspace_root=workspace,
            outputs_root=outputs,
            uploads_root=uploads,
        )
    assert outside.stat().st_uid == 0

    (workspace / "hardlink.txt").unlink()
    (uploads / "redirected.txt").symlink_to(outside)
    with pytest.raises(RuntimeError, match="symlink is not allowed"):
        sandbox_identity.prepare_thread_data_boundary(
            workspace_root=workspace,
            outputs_root=outputs,
            uploads_root=uploads,
        )
    assert outside.stat().st_uid == 0
