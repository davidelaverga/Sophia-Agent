from __future__ import annotations

import contextlib
import os
import platform
import secrets
import shutil
import signal
import stat
import subprocess  # noqa: S404 - callers provide sanitized argv lists.
import tempfile
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:  # pragma: no cover - pwd is unavailable on Windows.
    import pwd
except ImportError:  # pragma: no cover
    pwd = None  # type: ignore[assignment]

from deerflow.sandbox_identity import (
    claim_thread_identity,
    deterministic_thread_identity,
    user_data_root_for_path,
)
from deerflow.sophia.subprocess_env import trusted_subprocess_env

_GROUP_DRAIN_SECONDS = 10
_UNPRIVILEGED_ID_MIN = 200_000
_UNPRIVILEGED_ID_SPAN = 1_000_000_000
_PROVIDER_ID_MIN = 1_100_000_000
_PROVIDER_ID_SPAN = 1_000_000_000
_PROVIDER_LEASE_ROOT = Path("/tmp/sophia-provider-identities")
_CAP_SETPCAP = 8
_THREAD_STATUS_PATH = Path("/proc/thread-self/status")


@dataclass(frozen=True)
class _WritableGrant:
    path: Path
    existed: bool
    uid: int
    gid: int
    mode: int
    directory: bool
    granted_uid: int
    granted_gid: int


@dataclass(frozen=True)
class _ReadGrant:
    path: Path
    uid: int
    gid: int
    mode: int
    directory: bool


def allocate_unprivileged_identity() -> tuple[int, int]:
    """Return a practically unique numeric identity for one native invocation.

    Reusing ``nobody`` would let concurrent children inspect one another's
    procfs entries and private runtime directories. A high, random numeric
    identity needs no passwd/group entry and makes that cross-task channel
    infeasible, including across independent LangGraph worker processes.
    """

    identifier = _UNPRIVILEGED_ID_MIN + secrets.randbelow(_UNPRIVILEGED_ID_SPAN)
    return identifier, identifier


def _claim_fresh_provider_identity() -> tuple[int, int, Path]:
    """Lease a provider-only UID/GID from a range disjoint from shell UIDs."""

    _ensure_provider_lease_root()
    for _attempt in range(128):
        identifier = _PROVIDER_ID_MIN + secrets.randbelow(_PROVIDER_ID_SPAN)
        if pwd is not None:
            try:
                pwd.getpwuid(identifier)
            except KeyError:
                pass
            else:
                continue
        lease = _PROVIDER_LEASE_ROOT / str(identifier)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(lease, flags, 0o600)
        except FileExistsError:
            continue
        try:
            os.write(descriptor, f"{os.getpid()}\n".encode())
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if _active_processes_for_uid(identifier):
            lease.unlink(missing_ok=True)
            continue
        return identifier, identifier, lease
    raise RuntimeError("unable to lease a fresh provider process identity")


def _ensure_provider_lease_root() -> None:
    """Materialize the root-owned provider lease directory fail-closed.

    Render can preserve an existing root-owned ``/tmp`` directory with the
    process umask's broader mode. Tightening that directory from 0755 to 0700
    is safe and removes access; every untrusted owner, symlink, or non-directory
    still fails without mutation.
    """

    _PROVIDER_LEASE_ROOT.mkdir(mode=0o700, exist_ok=True)
    info = _PROVIDER_LEASE_ROOT.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or _PROVIDER_LEASE_ROOT.is_symlink()
        or (_running_as_linux_root() and info.st_uid != 0)
    ):
        raise RuntimeError("provider identity lease root is not root-private")
    if stat.S_IMODE(info.st_mode) != 0o700:
        if not _running_as_linux_root() or info.st_uid != 0:
            raise RuntimeError("provider identity lease root is not root-private")
        os.chmod(_PROVIDER_LEASE_ROOT, 0o700, follow_symlinks=False)
        info = _PROVIDER_LEASE_ROOT.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or _PROVIDER_LEASE_ROOT.is_symlink()
        or (_running_as_linux_root() and info.st_uid != 0)
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise RuntimeError("provider identity lease root is not root-private")


def _active_processes_for_uid(uid: int) -> tuple[int, ...]:
    """Return active Linux processes carrying *uid* in any credential slot."""

    if platform.system() != "Linux" or not Path("/proc").is_dir():
        return ()
    try:
        Path("/proc/self/status").read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise RuntimeError("provider identity cleanup cannot inspect procfs") from exc
    matches: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        state = ""
        credentials: tuple[int, ...] = ()
        for line in status.splitlines():
            if line.startswith("State:"):
                state = line.split(":", 1)[1].strip()
            elif line.startswith("Uid:"):
                try:
                    credentials = tuple(int(value) for value in line.split()[1:5])
                except ValueError:
                    credentials = ()
        # Zombies cannot execute, fork, access files, or expose their former
        # environment. PID 1 may retain the entry briefly before reaping it.
        if uid in credentials and not state.startswith("Z"):
            matches.append(int(entry.name))
    return tuple(sorted(matches))


def _terminate_uid_processes(uid: int, *, timeout: float = 5.0) -> tuple[int, ...]:
    """SIGKILL and verify every active process under a leased provider UID."""

    deadline = time.monotonic() + timeout
    empty_scans = 0
    while True:
        matches = _active_processes_for_uid(uid)
        if not matches:
            empty_scans += 1
            if empty_scans >= 2:
                return ()
            time.sleep(0.01)
            continue
        empty_scans = 0
        for pid in matches:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                continue
            except OSError:
                pass
        if time.monotonic() >= deadline:
            return _active_processes_for_uid(uid)
        time.sleep(0.01)


def _running_as_linux_root() -> bool:
    return (
        os.name == "posix"
        and platform.system() == "Linux"
        and hasattr(os, "geteuid")
        and os.geteuid() == 0
    )


def _setpriv_path() -> str:
    executable = shutil.which("setpriv")
    if executable is None:
        raise RuntimeError(
            "native renderer refuses root Linux execution without the setpriv UID boundary"
        )
    return executable


def _has_permitted_capability(
    capability: int,
    *,
    status_path: Path = _THREAD_STATUS_PATH,
) -> bool:
    """Return whether util-linux can activate *capability* for this thread.

    Capability bounding-set changes require ``CAP_SETPCAP``. Some production
    containers intentionally grant root enough authority to switch UID/GID but
    omit that capability. In that case the child boundary must retain the
    host-imposed bounding ceiling while relying on the UID drop, empty active
    capability sets, and ``no_new_privs`` to make the ceiling non-reacquirable.
    """

    if capability < 0:
        raise ValueError("capability number must be non-negative")
    try:
        status = status_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise RuntimeError(
            "native renderer cannot inspect permitted capabilities"
        ) from exc
    permitted_lines = [
        line.split(":", 1)[1].strip()
        for line in status.splitlines()
        if line.startswith("CapPrm:")
    ]
    if len(permitted_lines) != 1 or not permitted_lines[0]:
        raise RuntimeError(
            "native renderer received invalid permitted capability status"
        )
    if any(character not in "0123456789abcdefABCDEF" for character in permitted_lines[0]):
        raise RuntimeError(
            "native renderer received invalid permitted capability status"
        )
    try:
        permitted = int(permitted_lines[0], 16)
    except ValueError as exc:
        raise RuntimeError(
            "native renderer received invalid permitted capability status"
        ) from exc
    return bool(permitted & (1 << capability))


def _setpriv_command(
    command: Sequence[str],
    *,
    uid: int,
    gid: int,
    executable: str | None = None,
    umask: int = 0o077,
    drop_bounding_set: bool,
) -> list[str]:
    if not 0 <= umask <= 0o777:
        raise ValueError("native subprocess umask must be between 0000 and 0777")
    # util-linux setpriv does not expose umask on Debian. Pass the original argv
    # positionally through a fixed shell wrapper; no command text is interpolated.
    payload = [
        "/bin/sh",
        "-c",
        f'umask {umask:03o}; exec "$@"',
        "sophia-umask",
        *command,
    ]
    privilege_args = [
        executable or _setpriv_path(),
        f"--reuid={uid}",
        f"--regid={gid}",
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
    ]
    if drop_bounding_set:
        privilege_args.append("--bounding-set=-all")
    return [
        *privilege_args,
        "--pdeathsig=KILL",
        "--",
        *payload,
    ]


def _safe_grant_path(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = Path.cwd() / path
    # Normalize ``..`` lexically without resolving symlinks; resolution would
    # hide the very redirect that this validation must reject.
    path = Path(os.path.abspath(os.fspath(path)))
    if path == Path(path.anchor) or path in {Path("/tmp"), Path("/var/tmp")}:
        raise RuntimeError(f"refusing an over-broad native renderer write grant: {path}")
    current = Path(path.anchor)
    for component in path.parts[1:-1]:
        current /= component
        try:
            info = current.lstat()
        except OSError as exc:
            raise RuntimeError(
                f"native renderer write-grant parent does not exist: {current}"
            ) from exc
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(
                f"refusing native renderer write grant through symlink ancestor: {current}"
            )
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(
                f"native renderer write-grant ancestor is not a directory: {current}"
            )
    if path.is_symlink():
        raise RuntimeError(f"refusing a symlink native renderer write grant: {path}")
    return path


def _grant_directory(value: str | Path, *, uid: int, gid: int) -> _WritableGrant:
    path = _safe_grant_path(value)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"native renderer writable directory is not a directory: {path}")
    os.chown(path, uid, gid, follow_symlinks=False)
    os.chmod(path, 0o700, follow_symlinks=False)
    return _WritableGrant(
        path=path,
        existed=True,
        uid=info.st_uid,
        gid=info.st_gid,
        mode=stat.S_IMODE(info.st_mode),
        directory=True,
        granted_uid=uid,
        granted_gid=gid,
    )


def _grant_file(value: str | Path, *, uid: int, gid: int) -> _WritableGrant:
    path = _safe_grant_path(value)
    parent_info = path.parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode):
        raise RuntimeError(
            f"native renderer writable-file parent is not a directory: {path.parent}"
        )
    existed = path.exists()
    if existed:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError(
                f"native renderer writable file must be a single-link regular file: {path}"
            )
    else:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o600)
        os.close(descriptor)
        info = path.lstat()
    os.chown(path, uid, gid, follow_symlinks=False)
    os.chmod(path, 0o600, follow_symlinks=False)
    thread_root = user_data_root_for_path(path)
    stable_thread_owner = (
        thread_root is not None
        and deterministic_thread_identity(thread_root) == (uid, gid)
    )
    return _WritableGrant(
        path=path,
        existed=existed,
        uid=uid if stable_thread_owner else info.st_uid,
        gid=gid if stable_thread_owner else info.st_gid,
        mode=(0o700 if stat.S_IMODE(info.st_mode) & 0o111 else 0o600)
        if stable_thread_owner
        else stat.S_IMODE(info.st_mode),
        directory=False,
        granted_uid=uid,
        granted_gid=gid,
    )


def _grant_private_read_tree(value: str | Path, *, gid: int) -> list[_ReadGrant]:
    """Expose a trusted root-owned snapshot read-only to one private GID."""

    path = _safe_grant_path(value)
    grants: list[_ReadGrant] = []
    candidates = [path]
    for root, directories, files in os.walk(path, topdown=True, followlinks=False):
        current = Path(root)
        for name in (*directories, *files):
            candidates.append(current / name)
    try:
        for candidate in candidates:
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise RuntimeError(f"private read snapshot contains a symlink: {candidate}")
            if stat.S_ISDIR(info.st_mode):
                directory = True
                mode = 0o710
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                directory = False
                # The dropped child remains group-read-only.  Keeping owner
                # write allows shutil.copy2() to preserve a mode that is still
                # writable when the destination is owned by that child.
                mode = 0o640
            else:
                raise RuntimeError(
                    f"private read snapshot contains an unsupported file: {candidate}"
                )
            grants.append(
                _ReadGrant(
                    path=candidate,
                    uid=info.st_uid,
                    gid=info.st_gid,
                    mode=stat.S_IMODE(info.st_mode),
                    directory=directory,
                )
            )
            os.chown(candidate, 0, gid, follow_symlinks=False)
            os.chmod(candidate, mode, follow_symlinks=False)
    except Exception:
        _restore_read_grants(grants)
        raise
    return grants


def _restore_read_grants(grants: Sequence[_ReadGrant]) -> None:
    for grant in reversed(grants):
        try:
            info = grant.path.lstat()
            valid = (
                stat.S_ISDIR(info.st_mode)
                if grant.directory
                else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            )
            if not valid or grant.path.is_symlink():
                continue
            os.chown(grant.path, grant.uid, grant.gid, follow_symlinks=False)
            os.chmod(grant.path, grant.mode, follow_symlinks=False)
        except OSError:
            continue
def _restore_generated_tree(
    path: Path,
    *,
    uid: int,
    gid: int,
    granted_uid: int,
    granted_gid: int,
) -> None:
    """Return child-created output ownership without following child symlinks."""

    for root, directories, files in os.walk(path, topdown=False, followlinks=False):
        for name in (*files, *directories):
            candidate = Path(root) / name
            try:
                info = candidate.lstat()
                if info.st_uid == granted_uid or info.st_gid == granted_gid:
                    os.chown(candidate, uid, gid, follow_symlinks=False)
            except OSError:
                continue


def _restore_grant(grant: _WritableGrant) -> None:
    try:
        info = grant.path.lstat()
    except OSError:
        return
    if grant.directory:
        if not stat.S_ISDIR(info.st_mode) or grant.path.is_symlink():
            if grant.path.is_symlink():
                grant.path.unlink(missing_ok=True)
            return
        _restore_generated_tree(
            grant.path,
            uid=grant.uid,
            gid=grant.gid,
            granted_uid=grant.granted_uid,
            granted_gid=grant.granted_gid,
        )
    elif (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or grant.path.is_symlink()
    ):
        try:
            grant.path.unlink(missing_ok=True)
        except OSError:
            pass
        return
    elif not grant.existed and info.st_size == 0:
        grant.path.unlink(missing_ok=True)
        return
    os.chown(grant.path, grant.uid, grant.gid, follow_symlinks=False)
    os.chmod(grant.path, grant.mode, follow_symlinks=False)


def _private_runtime_env(
    base: Mapping[str, str],
    scratch: Path,
    *,
    uid: int,
    gid: int,
) -> dict[str, str]:
    env = dict(base)
    locations = {
        "HOME": scratch / "home",
        "TMPDIR": scratch / "tmp",
        "TMP": scratch / "tmp",
        "TEMP": scratch / "tmp",
        "XDG_CACHE_HOME": scratch / "cache",
        "XDG_CONFIG_HOME": scratch / "config",
        "XDG_DATA_HOME": scratch / "data",
        "XDG_RUNTIME_DIR": scratch / "runtime",
        "NPM_CONFIG_CACHE": scratch / "npm-cache",
        "UV_CACHE_DIR": scratch / "uv-cache",
    }
    for directory in set(locations.values()):
        directory.mkdir(mode=0o700)
        os.chown(directory, uid, gid)
        os.chmod(directory, 0o700)
    env.update({key: str(value) for key, value in locations.items()})
    return env


@contextlib.contextmanager
def isolated_process_boundary(
    command: Sequence[str],
    *,
    env: Mapping[str, str] | None,
    writable_files: Sequence[str | Path],
    writable_dirs: Sequence[str | Path],
    private_read_dirs: Sequence[str | Path] = (),
    umask: int = 0o077,
    identity_paths: Sequence[str | Path] = (),
    force_fresh_identity: bool = False,
) -> Iterator[tuple[list[str], dict[str, str]]]:
    """Drop native renderers below the credential-bearing LangGraph UID.

    An allowlisted environment is insufficient on Linux because a same-UID
    child can read ``/proc/<parent>/environ``. Production runs as root, so all
    ordinary native renderers execute under their deterministic thread UID/GID
    (or a transient ordinary identity when no thread path exists). Credentialed
    providers use a collision-checked identity from a disjoint UID range. Only
    caller-declared output files/directories are writable, and their original
    ownership is restored afterward.
    """

    base_env = dict(env) if env is not None else trusted_subprocess_env()
    if not _running_as_linux_root():
        yield list(command), base_env
        return

    setpriv = _setpriv_path()  # Fail closed before changing any output modes.
    identity_roots = {
        root
        for value in (*identity_paths, *writable_files, *writable_dirs)
        if (root := user_data_root_for_path(value)) is not None
    }
    if len(identity_roots) > 1:
        raise RuntimeError("native subprocess paths cross thread user-data boundaries")
    provider_lease: Path | None = None
    if force_fresh_identity:
        uid, gid, provider_lease = _claim_fresh_provider_identity()
    elif identity_roots:
        uid, gid = claim_thread_identity(next(iter(identity_roots)))
    else:
        uid, gid = allocate_unprivileged_identity()
    scratch: Path | None = None
    grants: list[_WritableGrant] = []
    read_grants: list[_ReadGrant] = []
    try:
        scratch = Path(tempfile.mkdtemp(prefix="sophia-native-"))
        os.chown(scratch, uid, gid)
        os.chmod(scratch, 0o700)
        isolated_env = _private_runtime_env(base_env, scratch, uid=uid, gid=gid)
        for directory in private_read_dirs:
            read_grants.extend(_grant_private_read_tree(directory, gid=gid))
        for directory in writable_dirs:
            grants.append(_grant_directory(directory, uid=uid, gid=gid))
        for output in writable_files:
            grants.append(_grant_file(output, uid=uid, gid=gid))
        bounded_command = _setpriv_command(
            command,
            uid=uid,
            gid=gid,
            executable=setpriv,
            umask=umask,
            drop_bounding_set=_has_permitted_capability(_CAP_SETPCAP),
        )
        yield bounded_command, isolated_env
    finally:
        cleanup_error: RuntimeError | None = None
        if force_fresh_identity:
            residual = _terminate_uid_processes(uid)
            if residual:
                cleanup_error = RuntimeError(
                    f"provider identity {uid} retained active processes: {residual}"
                )
        for grant in reversed(grants):
            _restore_grant(grant)
        _restore_read_grants(read_grants)
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)
        if provider_lease is not None and cleanup_error is None:
            provider_lease.unlink(missing_ok=True)
        if cleanup_error is not None:
            raise cleanup_error


def run_native_process(
    command: list[str],
    *,
    writable_files: Sequence[str | Path] = (),
    writable_dirs: Sequence[str | Path] = (),
    private_read_dirs: Sequence[str | Path] = (),
    env: Mapping[str, str] | None = None,
    identity_paths: Sequence[str | Path] = (),
    force_fresh_identity: bool = False,
    **run_kwargs: Any,
) -> subprocess.CompletedProcess[Any]:
    """Run a captured non-provider native binary inside the UID boundary."""

    with isolated_process_boundary(
        command,
        env=env,
        writable_files=writable_files,
        writable_dirs=writable_dirs,
        private_read_dirs=private_read_dirs,
        identity_paths=identity_paths,
        force_fresh_identity=force_fresh_identity,
    ) as (bounded_command, bounded_env):
        return subprocess.run(  # noqa: S603 - callers provide sanitized argv lists.
            bounded_command,
            env=bounded_env,
            **run_kwargs,
        )


def run_process_group(
    command: list[str],
    *,
    timeout: int,
    cwd: str | Path | None = None,
    writable_files: Sequence[str | Path] = (),
    writable_dirs: Sequence[str | Path] = (),
    private_read_dirs: Sequence[str | Path] = (),
    env: Mapping[str, str] | None = None,
    identity_paths: Sequence[str | Path] = (),
    force_fresh_identity: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run an isolated command and always tear down its complete process tree."""
    if os.name == "nt":
        return run_native_process(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            writable_files=writable_files,
            writable_dirs=writable_dirs,
            private_read_dirs=private_read_dirs,
            env=env,
            identity_paths=identity_paths,
            force_fresh_identity=force_fresh_identity,
        )
    with isolated_process_boundary(
        command,
        env=env,
        writable_files=writable_files,
        writable_dirs=writable_dirs,
        private_read_dirs=private_read_dirs,
        identity_paths=identity_paths,
        force_fresh_identity=force_fresh_identity,
    ) as (bounded_command, bounded_env):
        process = subprocess.Popen(  # noqa: S603 - callers provide sanitized argv lists.
            bounded_command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
            env=bounded_env,
            start_new_session=True,
            errors="replace",
        )
        group_terminated = False
        try:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                terminate_process_group(process)
                group_terminated = True
                try:
                    stdout, stderr = process.communicate(timeout=_GROUP_DRAIN_SECONDS)
                except subprocess.TimeoutExpired:
                    stdout, stderr = "", ""
                raise subprocess.TimeoutExpired(
                    process.args,
                    timeout,
                    output=stdout,
                    stderr=stderr,
                ) from None
        finally:
            # A leader may exit normally, raise during communication, or fork a
            # survivor that closes the capture pipes. Always kill the original
            # session; the provider-UID sweep in the enclosing boundary catches
            # descendants that escaped it with setsid().
            if not group_terminated:
                terminate_process_group(process)
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)


def terminate_process_group(process: subprocess.Popen[str]) -> None:
    try:
        process_group = os.getpgid(process.pid)
    except (ProcessLookupError, OSError):
        process_group = process.pid
    try:
        os.killpg(process_group, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except OSError:
            pass
