from __future__ import annotations

import os
import signal
import subprocess  # noqa: S404 - callers provide sanitized argv lists.
from pathlib import Path

_GROUP_DRAIN_SECONDS = 10


def run_process_group(
    command: list[str],
    *,
    timeout: int,
    cwd: str | Path | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a captured command and terminate its complete process tree on timeout."""
    if os.name == "nt":
        return subprocess.run(  # noqa: S603 - callers provide sanitized argv lists.
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
    process = subprocess.Popen(  # noqa: S603 - callers provide sanitized argv lists.
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        terminate_process_group(process)
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
