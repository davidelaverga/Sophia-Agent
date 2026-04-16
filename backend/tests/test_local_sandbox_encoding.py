import builtins
from types import SimpleNamespace

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
        local_sandbox.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(stdout="", stderr="boom", returncode=2),
    )

    output, telemetry = sandbox.execute_command_with_metadata("false")

    assert "boom" in output
    assert "Exit Code: 2" in output
    assert telemetry["status"] == "nonzero_exit"
    assert telemetry["exit_code"] == 2
