from __future__ import annotations

import subprocess

import pytest

from deerflow.sophia import process_group


def test_run_process_group_kills_complete_tree_on_timeout(monkeypatch) -> None:
    killed_groups: list[tuple[int, int]] = []
    popen_kwargs: dict = {}

    class _HungProcess:
        pid = 4321
        args = ["command"]
        returncode = -9
        communicate_calls = 0

        def communicate(self, *, timeout):
            self.communicate_calls += 1
            if self.communicate_calls == 1:
                raise subprocess.TimeoutExpired(self.args, timeout)
            return "partial stdout", "partial stderr"

        def kill(self):
            raise AssertionError("direct-child fallback should not be needed")

    process = _HungProcess()

    def _fake_popen(command, **kwargs):
        popen_kwargs.update(kwargs)
        process.args = command
        return process

    monkeypatch.setattr(process_group.subprocess, "Popen", _fake_popen)
    monkeypatch.setattr(process_group.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(process_group.os, "killpg", lambda pgid, sig: killed_groups.append((pgid, sig)))

    with pytest.raises(subprocess.TimeoutExpired) as caught:
        process_group.run_process_group(["command"], timeout=30, cwd="/tmp")

    assert popen_kwargs["start_new_session"] is True
    assert popen_kwargs["cwd"] == "/tmp"
    assert killed_groups == [(process.pid, process_group.signal.SIGKILL)]
    assert process.communicate_calls == 2
    assert caught.value.output == "partial stdout"
    assert caught.value.stderr == "partial stderr"
