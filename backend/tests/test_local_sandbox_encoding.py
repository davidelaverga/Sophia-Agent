import builtins
import os
import shutil
import time
from types import SimpleNamespace

import pytest

import deerflow.sandbox.local.local_sandbox as local_sandbox
from deerflow.sandbox.local.local_sandbox import LocalSandbox


def _open(base, file, mode="r", *args, **kwargs):
    if "b" in mode:
        return base(file, mode, *args, **kwargs)
    return base(file, mode, *args, encoding=kwargs.pop("encoding", "gbk"), **kwargs)


def test_read_file_uses_utf8_on_windows_locale(tmp_path, monkeypatch):
    path = tmp_path / "utf8.txt"
    text = "\u201cutf8\u201d"
    path.write_text(text, encoding="utf-8")
    base = builtins.open

    monkeypatch.setattr(local_sandbox, "open", lambda file, mode="r", *args, **kwargs: _open(base, file, mode, *args, **kwargs), raising=False)

    assert LocalSandbox("t").read_file(str(path)) == text


def test_write_file_uses_utf8_on_windows_locale(tmp_path, monkeypatch):
    path = tmp_path / "utf8.txt"
    text = "emoji \U0001F600"
    base = builtins.open

    monkeypatch.setattr(local_sandbox, "open", lambda file, mode="r", *args, **kwargs: _open(base, file, mode, *args, **kwargs), raising=False)

    LocalSandbox("t").write_file(str(path), text)

    assert path.read_text(encoding="utf-8") == text


def test_execute_command_with_metadata_reports_shell_resolution_failure(monkeypatch):
    sandbox = LocalSandbox("t")

    def _raise_no_shell():
        raise RuntimeError("No suitable shell executable found.")

    monkeypatch.setattr(LocalSandbox, "_get_shell", staticmethod(_raise_no_shell))

    output, telemetry = sandbox.execute_command_with_metadata("ls /mnt/user-data/workspace")

    assert output == "Error: No suitable shell executable found."
    assert telemetry["status"] == "shell_unavailable"
    assert telemetry["command"] == "ls /mnt/user-data/workspace"
    assert telemetry["error"] == "No suitable shell executable found."


def test_execute_command_with_metadata_captures_nonzero_exit(monkeypatch):
    sandbox = LocalSandbox("t")

    monkeypatch.setattr(LocalSandbox, "_get_shell", staticmethod(lambda: "/bin/sh"))
    monkeypatch.setattr(
        local_sandbox,
        "_run_command_capture",
        lambda *args, **kwargs: SimpleNamespace(stdout="", stderr="boom", returncode=2),
    )

    output, telemetry = sandbox.execute_command_with_metadata("false")

    assert "boom" in output
    assert "Exit Code: 2" in output
    assert telemetry["status"] == "nonzero_exit"
    assert telemetry["exit_code"] == 2


@pytest.mark.skipif(os.name == "nt", reason="process-group kill is the Unix execution path")
def test_execute_command_kills_forking_child_on_timeout(monkeypatch):
    # Regression for the prod deck hang (019f0679, 2026-06-27): a grandchild that
    # inherits and HOLDS the captured stdout pipe open defeats subprocess.run's own
    # timeout — its post-timeout drain (`communicate()` with no timeout) blocks on
    # the held pipe for the child's full lifetime. The repro must keep the pipe fd
    # open in a live grandchild (a backgrounded `sleep &` does NOT reproduce it on
    # macOS/Linux). The new start_new_session + process-group SIGKILL must reap the
    # whole tree so the call returns near the timeout, not ~30s later. Without the
    # fix this assertion fails (elapsed ~30s); with it, ~3s.
    if shutil.which("python3") is None:
        pytest.skip("python3 required to spawn a pipe-holding grandchild")
    monkeypatch.setattr(local_sandbox, "_COMMAND_TIMEOUT_SECONDS", 3)
    sandbox = LocalSandbox("t")

    # Direct child (python) stays alive holding fd 1; it also spawns a `sleep 30`
    # grandchild that inherits and holds fd 1 — both keep the captured pipe open.
    cmd = "python3 -c 'import subprocess,time; subprocess.Popen([\"sleep\",\"30\"]); time.sleep(30)'"
    start = time.perf_counter()
    output, telemetry = sandbox.execute_command_with_metadata(cmd)
    elapsed = time.perf_counter() - start

    assert telemetry["status"] == "timed_out"
    assert "exceeded" in output.lower()
    # Reaped as a group near the 3s timeout — NOT hung ~30s on the held pipe.
    assert elapsed < 20, f"timeout did not reap the process group (elapsed={elapsed:.1f}s)"
