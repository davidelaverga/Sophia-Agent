from __future__ import annotations

import hashlib
import os
import platform
import secrets
import stat
from pathlib import Path

try:  # pragma: no cover - pwd is unavailable on Windows.
    import pwd
except ImportError:  # pragma: no cover
    pwd = None  # type: ignore[assignment]

IDENTITY_MIN = 200_000
IDENTITY_SPAN = 1_000_000_000


def running_as_linux_root() -> bool:
    return (
        os.name == "posix"
        and platform.system() == "Linux"
        and hasattr(os, "geteuid")
        and os.geteuid() == 0
    )


def user_data_root_for_path(value: str | Path) -> Path | None:
    path = Path(os.path.abspath(os.fspath(value)))
    for candidate in (path, *path.parents):
        if candidate.name == "user-data" and candidate.parent.parent.name == "threads":
            return candidate
    return None


def deterministic_thread_identity(user_data_root: str | Path) -> tuple[int, int]:
    root = Path(os.path.abspath(os.fspath(user_data_root)))
    digest = hashlib.sha256(os.fsencode(root)).digest()
    identifier = IDENTITY_MIN + int.from_bytes(digest[:8], "big") % IDENTITY_SPAN
    return identifier, identifier


def _registry_root(user_data_root: Path) -> Path:
    # <base>/threads/<thread>/user-data -> <base>/.sandbox-identities
    return user_data_root.parents[2] / ".sandbox-identities"


def claim_thread_identity(user_data_root: str | Path) -> tuple[int, int]:
    """Claim a deterministic UID for one canonical thread, failing on collision."""

    root = Path(os.path.abspath(os.fspath(user_data_root)))
    if root.name != "user-data" or root.parent.parent.name != "threads":
        raise RuntimeError(f"invalid thread user-data root: {root}")
    if root.is_symlink() or root.resolve(strict=True) != root:
        raise RuntimeError(f"thread user-data root is redirected: {root}")
    uid, gid = deterministic_thread_identity(root)
    if pwd is not None:
        try:
            pwd.getpwuid(uid)
        except KeyError:
            pass
        else:
            raise RuntimeError(f"thread sandbox UID collides with a system account: {uid}")

    registry = _registry_root(root)
    registry.mkdir(mode=0o700, parents=True, exist_ok=True)
    registry_info = registry.lstat()
    if not stat.S_ISDIR(registry_info.st_mode) or registry.is_symlink():
        raise RuntimeError(f"thread sandbox identity registry is redirected: {registry}")
    if running_as_linux_root() and registry_info.st_uid != 0:
        raise RuntimeError(f"thread sandbox identity registry is not root-owned: {registry}")
    registry.chmod(0o700)
    record = registry / str(uid)
    temporary = registry / f".{uid}.{os.getpid()}.{secrets.token_hex(8)}"
    expected = f"{root}\n".encode()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        os.write(descriptor, expected)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        try:
            os.link(temporary, record, follow_symlinks=False)
        except FileExistsError:
            read_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            try:
                existing = os.open(record, read_flags)
            except OSError as exc:
                raise RuntimeError(
                    f"thread sandbox identity registry is unreadable: {record}"
                ) from exc
            try:
                info = os.fstat(existing)
                actual = os.read(existing, len(expected) + 1)
            finally:
                os.close(existing)
            if not stat.S_ISREG(info.st_mode) or actual != expected:
                raise RuntimeError(
                    f"thread sandbox UID collision: {uid} is already assigned to another root"
                )
        else:
            directory_fd = os.open(registry, _directory_open_flags())
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return uid, gid


def _adopt_writable_tree(root: Path, *, uid: int, gid: int) -> None:
    descriptor = _open_directory_no_follow(root)
    try:
        _adopt_writable_directory_fd(descriptor, root, uid=uid, gid=gid)
    finally:
        os.close(descriptor)


def _directory_open_flags() -> int:
    return (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )


def _open_directory_no_follow(path: Path) -> int:
    try:
        descriptor = os.open(path, _directory_open_flags())
    except OSError as exc:
        raise RuntimeError(f"thread data directory is redirected: {path}") from exc
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode):
        os.close(descriptor)
        raise RuntimeError(f"thread data path is not a directory: {path}")
    return descriptor


def _open_regular_no_follow(parent_fd: int, name: str, path: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise RuntimeError(f"thread data file changed during adoption: {path}") from exc
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(descriptor)
        raise RuntimeError(f"thread data file is not a single-link regular file: {path}")
    return descriptor


def _adopt_writable_directory_fd(
    descriptor: int,
    path: Path,
    *,
    uid: int,
    gid: int,
) -> None:
    os.fchown(descriptor, uid, gid)
    os.fchmod(descriptor, 0o700)
    with os.scandir(descriptor) as entries:
        for entry in entries:
            candidate = path / entry.name
            info = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child_fd = os.open(entry.name, _directory_open_flags(), dir_fd=descriptor)
                try:
                    _adopt_writable_directory_fd(child_fd, candidate, uid=uid, gid=gid)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode):
                child_fd = _open_regular_no_follow(descriptor, entry.name, candidate)
                try:
                    child_info = os.fstat(child_fd)
                    os.fchown(child_fd, uid, gid)
                    executable = bool(stat.S_IMODE(child_info.st_mode) & 0o111)
                    os.fchmod(child_fd, 0o700 if executable else 0o600)
                finally:
                    os.close(child_fd)
            elif stat.S_ISLNK(info.st_mode):
                os.chown(
                    entry.name,
                    uid,
                    gid,
                    dir_fd=descriptor,
                    follow_symlinks=False,
                )
            else:
                raise RuntimeError(f"unsupported file in thread writable tree: {candidate}")


def _make_uploads_read_only(root: Path, *, gid: int) -> None:
    descriptor = _open_directory_no_follow(root)
    try:
        _make_uploads_directory_read_only(descriptor, root, gid=gid)
    finally:
        os.close(descriptor)


def _make_uploads_directory_read_only(descriptor: int, path: Path, *, gid: int) -> None:
    os.fchown(descriptor, 0, gid)
    os.fchmod(descriptor, 0o550)
    with os.scandir(descriptor) as entries:
        for entry in entries:
            candidate = path / entry.name
            info = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child_fd = os.open(entry.name, _directory_open_flags(), dir_fd=descriptor)
                try:
                    _make_uploads_directory_read_only(child_fd, candidate, gid=gid)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode):
                child_fd = _open_regular_no_follow(descriptor, entry.name, candidate)
                try:
                    os.fchown(child_fd, 0, gid)
                    os.fchmod(child_fd, 0o440)
                finally:
                    os.close(child_fd)
            elif stat.S_ISLNK(info.st_mode):
                raise RuntimeError(f"symlink is not allowed in read-only uploads: {candidate}")
            else:
                raise RuntimeError(f"unsupported file in read-only uploads: {candidate}")


def prepare_thread_data_boundary(
    *,
    workspace_root: str | Path,
    outputs_root: str | Path,
    uploads_root: str | Path,
) -> tuple[int, int]:
    """Adopt one thread tree for its stable UID without following links."""

    roots = {
        "workspace": Path(os.path.abspath(os.fspath(workspace_root))),
        "outputs": Path(os.path.abspath(os.fspath(outputs_root))),
        "uploads": Path(os.path.abspath(os.fspath(uploads_root))),
    }
    user_roots = {user_data_root_for_path(path) for path in roots.values()}
    if None in user_roots or len(user_roots) != 1:
        raise RuntimeError("thread sandbox roots do not share one user-data boundary")
    user_data = next(iter(user_roots))
    assert user_data is not None
    for name, root in roots.items():
        if (
            root != user_data / name
            or not root.is_dir()
            or root.is_symlink()
            or root.resolve(strict=True) != root
        ):
            raise RuntimeError(f"invalid canonical thread {name} root: {root}")
    uid, gid = claim_thread_identity(user_data)
    # Keep the boundary itself root-owned and non-writable.  The thread's
    # stable supplementary identity may traverse it, but cannot rename the
    # canonical workspace/outputs/uploads roots underneath it.
    os.chown(user_data, 0, gid, follow_symlinks=False)
    os.chmod(user_data, 0o710, follow_symlinks=False)
    _adopt_writable_tree(roots["workspace"], uid=uid, gid=gid)
    _adopt_writable_tree(roots["outputs"], uid=uid, gid=gid)
    _make_uploads_read_only(roots["uploads"], gid=gid)
    return uid, gid
