from __future__ import annotations

import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

from deerflow.sophia import process_group


def _write_minimal_pdf(path: Path) -> None:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
        b"<< /Length 0 >>\nstream\n\nendstream",
    ]
    payload = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(payload))
        payload.extend(f"{index} 0 obj\n".encode())
        payload.extend(body)
        payload.extend(b"\nendobj\n")
    xref = len(payload)
    payload.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        payload.extend(f"{offset:010d} 00000 n \n".encode())
    payload.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    path.write_bytes(payload)


def test_setpriv_command_drops_distinct_identity_and_all_capability_sets() -> None:
    command = process_group._setpriv_command(
        ["/bin/sh", "-c", "true"],
        uid=410_001,
        gid=410_002,
        executable="/usr/bin/setpriv",
    )

    assert command == [
        "/usr/bin/setpriv",
        "--reuid=410001",
        "--regid=410002",
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        "--pdeathsig=KILL",
        "--",
        "/bin/sh",
        "-c",
        'umask 077; exec "$@"',
        "sophia-umask",
        "/bin/sh",
        "-c",
        "true",
    ]


def test_unprivileged_identity_is_fresh_per_invocation(monkeypatch) -> None:
    values = iter((11, 29))
    monkeypatch.setattr(process_group.secrets, "randbelow", lambda _span: next(values))

    first = process_group.allocate_unprivileged_identity()
    second = process_group.allocate_unprivileged_identity()

    assert first == (200_011, 200_011)
    assert second == (200_029, 200_029)
    assert first != second


def test_provider_identity_range_is_disjoint_from_ordinary_shell_identities() -> None:
    ordinary_max = (
        process_group._UNPRIVILEGED_ID_MIN
        + process_group._UNPRIVILEGED_ID_SPAN
        - 1
    )
    provider_max = process_group._PROVIDER_ID_MIN + process_group._PROVIDER_ID_SPAN - 1

    assert ordinary_max < process_group._PROVIDER_ID_MIN
    assert provider_max < 2**31


def test_provider_identity_lease_skips_system_accounts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = iter((7, 11))
    monkeypatch.setattr(process_group, "_PROVIDER_LEASE_ROOT", tmp_path / "leases")
    monkeypatch.setattr(process_group.secrets, "randbelow", lambda _span: next(values))
    monkeypatch.setattr(process_group, "_active_processes_for_uid", lambda _uid: ())

    class _Pwd:
        @staticmethod
        def getpwuid(uid: int):
            if uid == process_group._PROVIDER_ID_MIN + 7:
                return object()
            raise KeyError(uid)

    monkeypatch.setattr(process_group, "pwd", _Pwd())

    uid, gid, lease = process_group._claim_fresh_provider_identity()
    try:
        assert (uid, gid) == (
            process_group._PROVIDER_ID_MIN + 11,
            process_group._PROVIDER_ID_MIN + 11,
        )
        assert lease.is_file()
        assert stat.S_IMODE(lease.stat().st_mode) == 0o600
    finally:
        lease.unlink(missing_ok=True)


def test_provider_identity_lease_rejects_non_private_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lease_root = tmp_path / "leases"
    lease_root.mkdir(mode=0o755)
    monkeypatch.setattr(process_group, "_PROVIDER_LEASE_ROOT", lease_root)

    with pytest.raises(RuntimeError, match="not root-private"):
        process_group._claim_fresh_provider_identity()


def test_write_grant_rejects_symlinked_parent(tmp_path: Path) -> None:
    real_parent = tmp_path / "real"
    real_parent.mkdir()
    redirected_parent = tmp_path / "redirected"
    redirected_parent.symlink_to(real_parent, target_is_directory=True)

    with pytest.raises(RuntimeError, match="symlink ancestor"):
        process_group._safe_grant_path(redirected_parent / "output.pdf")


def test_write_grant_rejects_non_directory_parent_component(tmp_path: Path) -> None:
    not_a_directory = tmp_path / "plain-file"
    not_a_directory.write_text("not a directory", encoding="utf-8")

    with pytest.raises(RuntimeError, match="ancestor is not a directory"):
        process_group._safe_grant_path(not_a_directory / "output.pdf")


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires a real root Linux process",
)
def test_real_linux_child_cannot_read_parent_environ_and_can_write_exact_output(
    monkeypatch,
) -> None:
    if shutil.which("setpriv") is None:
        pytest.fail("root Linux runtime is missing required setpriv")
    secret = "dq-parent-only-proof"
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", secret)
    output = Path(tempfile.gettempdir()) / f"dq1-proc-proof-{os.getpid()}.txt"
    output.unlink(missing_ok=True)
    probe = """
import os
from pathlib import Path
try:
    parent = Path(f'/proc/{os.getppid()}/environ').read_bytes()
except PermissionError:
    parent = b'DENIED'
Path(os.environ['PROBE_OUTPUT']).write_text(
    f'uid={os.geteuid()} parent={parent.decode(errors="replace")}',
    encoding='utf-8',
)
"""
    env = process_group.trusted_subprocess_env()
    env["PROBE_OUTPUT"] = str(output)

    try:
        completed = process_group.run_native_process(
            [sys.executable, "-c", probe],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
            env=env,
            writable_files=[output],
        )

        assert completed.returncode == 0, completed.stderr
        evidence = output.read_text(encoding="utf-8")
        assert "parent=DENIED" in evidence
        assert secret not in evidence
        assert f"uid={os.geteuid()}" not in evidence
    finally:
        output.unlink(missing_ok=True)


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires a real root Linux process",
)
def test_real_linux_concurrent_children_cannot_read_each_other_environ() -> None:
    first_state = Path(tempfile.gettempdir()) / f"dq1-first-child-{os.getpid()}.txt"
    second_state = Path(tempfile.gettempdir()) / f"dq1-second-child-{os.getpid()}.txt"
    for path in (first_state, second_state):
        path.unlink(missing_ok=True)
    first_env = process_group.trusted_subprocess_env()
    first_env.update(
        {
            "FIRST_STATE": str(first_state),
            "SIBLING_ONLY_SECRET": "sibling-private-proof",
        }
    )
    first_code = """
import os, time
from pathlib import Path
Path(os.environ['FIRST_STATE']).write_text(f'{os.getpid()} {os.geteuid()}')
time.sleep(2)
"""
    first_result: list[subprocess.CompletedProcess] = []

    def _run_first() -> None:
        first_result.append(
            process_group.run_native_process(
                [sys.executable, "-c", first_code],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
                env=first_env,
                writable_files=[first_state],
            )
        )

    thread = threading.Thread(target=_run_first, daemon=True)
    thread.start()
    deadline = time.monotonic() + 2
    while not first_state.exists() or first_state.stat().st_size == 0:
        if time.monotonic() >= deadline:
            pytest.fail("first isolated child did not publish its PID")
        time.sleep(0.01)
    first_pid, first_uid = first_state.read_text(encoding="utf-8").split()
    second_env = process_group.trusted_subprocess_env()
    second_env.update({"TARGET_PID": first_pid, "SECOND_STATE": str(second_state)})
    second_code = """
import os
from pathlib import Path
try:
    data = Path(f\"/proc/{os.environ['TARGET_PID']}/environ\").read_bytes()
except PermissionError:
    data = b'DENIED'
Path(os.environ['SECOND_STATE']).write_text(f'{os.geteuid()} {data.decode(errors="replace")}')
"""
    try:
        second = process_group.run_native_process(
            [sys.executable, "-c", second_code],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=second_env,
            writable_files=[second_state],
        )
        assert second.returncode == 0, second.stderr
        second_uid, evidence = second_state.read_text(encoding="utf-8").split(maxsplit=1)
        assert second_uid != first_uid
        assert evidence == "DENIED"
        assert "sibling-private-proof" not in evidence
    finally:
        thread.join(timeout=5)
        for path in (first_state, second_state):
            path.unlink(missing_ok=True)
    assert first_result and first_result[0].returncode == 0


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires a real root Linux renderer runtime",
)
def test_real_linux_pdftoppm_renderer_writes_only_granted_directory() -> None:
    pdftoppm = shutil.which("pdftoppm")
    if pdftoppm is None:
        pytest.skip("pdftoppm is not installed")
    output_dir = Path(tempfile.mkdtemp(prefix="dq1-native-render-smoke-"))
    source = output_dir.parent / f"dq1-native-render-input-{os.getpid()}.pdf"
    _write_minimal_pdf(source)
    try:
        completed = process_group.run_process_group(
            [pdftoppm, "-f", "1", "-singlefile", "-png", str(source), str(output_dir / "page")],
            timeout=30,
            writable_dirs=[output_dir],
        )

        rendered = output_dir / "page.png"
        assert completed.returncode == 0, completed.stderr
        assert rendered.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    finally:
        shutil.rmtree(output_dir, ignore_errors=True)
        source.unlink(missing_ok=True)


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
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "dq-private")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "storage-private")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

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
    assert popen_kwargs["env"]["PATH"] == "/usr/bin:/bin"
    assert "SOPHIA_DECK_QUALITY_OPENAI_API_KEY" not in popen_kwargs["env"]
    assert "SUPABASE_SERVICE_ROLE_KEY" not in popen_kwargs["env"]
    assert killed_groups == [(process.pid, process_group.signal.SIGKILL)]
    assert process.communicate_calls == 2
    assert caught.value.output == "partial stdout"
    assert caught.value.stderr == "partial stderr"


def test_run_process_group_kills_group_when_communicate_raises(monkeypatch) -> None:
    killed: list[tuple[int, int]] = []

    class _BrokenProcess:
        pid = 9981
        args = ["broken"]
        returncode = 0

        def communicate(self, *, timeout):
            raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid")

        def kill(self):
            raise AssertionError("killpg should be used")

    monkeypatch.setattr(process_group.subprocess, "Popen", lambda *_args, **_kwargs: _BrokenProcess())
    monkeypatch.setattr(process_group.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(
        process_group.os,
        "killpg",
        lambda pgid, sig: killed.append((pgid, sig)),
    )

    with pytest.raises(UnicodeDecodeError):
        process_group.run_process_group(["broken"], timeout=5)

    assert killed == [(9981, signal.SIGKILL)]


@pytest.mark.skipif(os.name == "nt", reason="requires Unix process groups")
def test_run_process_group_kills_detached_same_group_after_normal_leader_exit(
    tmp_path: Path,
) -> None:
    root_linux = platform.system() == "Linux" and hasattr(os, "geteuid") and os.geteuid() == 0
    state = (
        Path(f"/tmp/dq1-normal-group-{os.getpid()}.pid")
        if root_linux
        else tmp_path / "child.pid"
    )
    state.unlink(missing_ok=True)
    code = """import subprocess, sys
from pathlib import Path
p = subprocess.Popen(
    ['sleep', '30'],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
Path(sys.argv[1]).write_text(str(p.pid), encoding='utf-8')
"""

    try:
        completed = process_group.run_process_group(
            [sys.executable, "-c", code, str(state)],
            timeout=5,
            writable_files=[state] if root_linux else (),
        )

        assert completed.returncode == 0
        child_pid = int(state.read_text(encoding="utf-8"))
        deadline = time.monotonic() + 2
        while _pid_is_active(child_pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not _pid_is_active(child_pid)
    finally:
        state.unlink(missing_ok=True)


def _pid_is_active(pid: int) -> bool:
    status = Path(f"/proc/{pid}/status")
    if status.exists():
        try:
            state = next(
                line for line in status.read_text(encoding="utf-8").splitlines()
                if line.startswith("State:")
            )
        except (OSError, StopIteration):
            return False
        return "Z" not in state
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux provider identity boundary",
)
def test_real_linux_provider_lease_is_released_after_communicate_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _BrokenProcess:
        pid = 99_999_991
        args: list[str] = []
        returncode = 0

        def communicate(self, *, timeout):
            raise RuntimeError("synthetic non-timeout communication failure")

    def fake_popen(command, **_kwargs):
        captured["command"] = command
        _BrokenProcess.args = command
        return _BrokenProcess()

    monkeypatch.setattr(process_group.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(process_group, "terminate_process_group", lambda _process: None)

    with pytest.raises(RuntimeError, match="communication failure"):
        process_group.run_process_group(
            [sys.executable, "-c", "raise SystemExit(0)"],
            timeout=5,
            env={"OPENAI_API_KEY": "provider-only"},
            force_fresh_identity=True,
        )

    command = captured["command"]
    assert isinstance(command, list)
    uid = int(next(value.split("=", 1)[1] for value in command if value.startswith("--reuid=")))
    assert process_group._active_processes_for_uid(uid) == ()
    assert not (process_group._PROVIDER_LEASE_ROOT / str(uid)).exists()


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux provider identity boundary",
)
def test_real_linux_provider_invalid_utf8_is_replaced_and_lease_is_released() -> None:
    code = """import os
os.write(1, f'{os.geteuid()}\\n'.encode() + b'\\xff')
"""

    completed = process_group.run_process_group(
        [sys.executable, "-c", code],
        timeout=5,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        force_fresh_identity=True,
    )

    uid = int(completed.stdout.splitlines()[0])
    assert completed.returncode == 0
    assert "�" in completed.stdout
    assert process_group._PROVIDER_ID_MIN <= uid < (
        process_group._PROVIDER_ID_MIN + process_group._PROVIDER_ID_SPAN
    )
    assert process_group._active_processes_for_uid(uid) == ()
    assert not (process_group._PROVIDER_LEASE_ROOT / str(uid)).exists()


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux provider identity boundary",
)
def test_real_linux_provider_uid_sweep_kills_setsid_survivor() -> None:
    state = Path(f"/tmp/dq1-provider-setsid-{os.getpid()}.txt")
    state.unlink(missing_ok=True)
    code = """import os, subprocess, sys
from pathlib import Path
p = subprocess.Popen(
    [sys.executable, '-c', 'import time; time.sleep(30)'],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    preexec_fn=os.setsid,
)
Path(os.environ['STATE']).write_text(f'{os.geteuid()} {p.pid}', encoding='utf-8')
"""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "STATE": str(state)}
    survivor_pid = 0
    try:
        completed = process_group.run_process_group(
            [sys.executable, "-c", code],
            timeout=5,
            env=env,
            writable_files=[state],
            force_fresh_identity=True,
        )
        assert completed.returncode == 0
        uid_text, pid_text = state.read_text(encoding="utf-8").split()
        uid = int(uid_text)
        survivor_pid = int(pid_text)
        assert not _pid_is_active(survivor_pid)
        assert process_group._active_processes_for_uid(uid) == ()
        assert not (process_group._PROVIDER_LEASE_ROOT / str(uid)).exists()
    finally:
        if survivor_pid:
            try:
                os.kill(survivor_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        state.unlink(missing_ok=True)
