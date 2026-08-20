from __future__ import annotations

import json
import os
import platform
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

from deerflow.sandbox.local.local_sandbox import LocalSandbox
from deerflow.sandbox_identity import prepare_thread_data_boundary
from deerflow.sophia import image_subprocess
from deerflow.sophia.image_subprocess import (
    ImageThreadRoots,
    TrustedImageRequest,
    run_trusted_image_request,
)


def _roots(tmp_path: Path, thread: str = "thread-1") -> ImageThreadRoots:
    user_data = tmp_path / "threads" / thread / "user-data"
    workspace = user_data / "workspace"
    outputs = user_data / "outputs"
    uploads = user_data / "uploads"
    for root in (workspace, outputs, uploads):
        root.mkdir(parents=True, exist_ok=True)
    return ImageThreadRoots.create(
        workspace=workspace,
        outputs=outputs,
        uploads=uploads,
    )


def _script(tmp_path: Path) -> Path:
    script = tmp_path / "trusted-generate.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    script.chmod(0o755)
    return script


def test_actual_image_script_preflight_runs_through_broker_without_provider_key(
    tmp_path: Path,
) -> None:
    roots = _roots(tmp_path)
    script = (
        Path(__file__).resolve().parents[2]
        / "skills/public/image-generation/scripts/generate.py"
    )

    completed = run_trusted_image_request(
        TrustedImageRequest(
            python_executable=sys.executable,
            script=script,
            roots=roots,
            mode="preflight",
        ),
        env={},
        timeout=10,
    )

    assert completed.returncode == 1
    assert json.loads(completed.stdout) == {
        "preflight": "failed",
        "reason": "env_missing",
    }


def test_broker_preserves_virtualenv_python_symlink_for_execution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    roots = _roots(tmp_path)
    script = _script(tmp_path)
    python_entry = tmp_path / "venv" / "bin" / "python"
    python_entry.parent.mkdir(parents=True)
    python_entry.symlink_to(Path(sys.executable).resolve())
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
        captured.update(command=command, **kwargs)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(image_subprocess, "run_process_group", fake_run)
    run_trusted_image_request(
        TrustedImageRequest(
            python_executable=str(python_entry),
            script=script,
            roots=roots,
            mode="preflight",
        ),
        env={},
        timeout=10,
    )

    command = captured["command"]
    assert isinstance(command, list)
    assert Path(command[0]) == python_entry
    assert Path(command[0]).resolve() == Path(sys.executable).resolve()


def test_manifest_inputs_are_snapshotted_and_import_paths_are_hardened(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    roots = _roots(tmp_path)
    script = _script(tmp_path)
    prompt = roots.workspace / "prompt.json"
    prompt.write_text('{"prompt":"ORIGINAL"}', encoding="utf-8")
    output_parent = roots.outputs / "assets"
    output_parent.mkdir()
    output = output_parent / "visual.png"
    outside = tmp_path / "outside.png"
    manifest = roots.outputs / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "prompt_file": str(prompt),
                        "reference_images": [],
                        "output_file": str(output),
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
        captured.update(command=command, **kwargs)
        staged_manifest = Path(command[-1])
        staged_payload = json.loads(staged_manifest.read_text(encoding="utf-8"))
        item = staged_payload["items"][0]
        staged_prompt = Path(item["prompt_file"])
        staged_output = Path(item["output_file"])
        captured["stage"] = staged_manifest.parent
        assert staged_prompt.read_text(encoding="utf-8") == '{"prompt":"ORIGINAL"}'
        assert staged_prompt != prompt
        assert staged_output != output

        # Deterministic TOCTOU: mutate both originals only after the broker has
        # snapshotted and rewritten them. The provider must consume the snapshot.
        prompt.write_text('{"prompt":"MUTATED"}', encoding="utf-8")
        manifest.write_text(
            json.dumps(
                {
                    "items": [
                        {
                            "prompt_file": "/etc/shadow",
                            "reference_images": [],
                            "output_file": str(outside),
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        staged_output.write_bytes(b"snapshot:" + staged_prompt.read_bytes())
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=f"WROTE {staged_output}",
            stderr="",
        )

    monkeypatch.setattr(image_subprocess, "run_process_group", fake_run)
    completed = run_trusted_image_request(
        TrustedImageRequest(
            python_executable=sys.executable,
            script=script,
            roots=roots,
            mode="manifest",
            manifest_file=manifest,
        ),
        env={
            "OPENAI_API_KEY": "provider-only",
            "PYTHONPATH": "/attacker/imports",
            "PYTHONHOME": "/attacker/python",
            "LD_LIBRARY_PATH": "/attacker/libs",
            "SOPHIA_OUTPUTS_HOST_PATH": str(roots.outputs),
        },
        timeout=33,
    )

    command = captured["command"]
    assert isinstance(command, list)
    assert command[1] == "-I"
    assert Path(command[2]) == script.resolve()
    child_env = captured["env"]
    assert isinstance(child_env, dict)
    assert child_env["OPENAI_API_KEY"] == "provider-only"
    for forbidden in (
        "PYTHONPATH",
        "PYTHONHOME",
        "LD_LIBRARY_PATH",
        "SOPHIA_OUTPUTS_HOST_PATH",
    ):
        assert forbidden not in child_env
    assert child_env["PYTHONNOUSERSITE"] == "1"
    assert captured["force_fresh_identity"] is True
    assert captured["identity_paths"] == [roots.user_data]
    assert captured["cwd"] == script.resolve().parent
    assert captured["private_read_dirs"] == [Path(captured["stage"])]
    assert captured["writable_dirs"] == [Path(captured["stage"]) / "outputs"]
    assert output.read_bytes() == b'snapshot:{"prompt":"ORIGINAL"}'
    assert str(output) in completed.stdout
    assert not outside.exists()
    assert not Path(captured["stage"]).exists()


def test_output_parent_replacement_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    roots = _roots(tmp_path)
    script = _script(tmp_path)
    prompt = roots.workspace / "prompt.json"
    prompt.write_text('{"prompt":"safe"}', encoding="utf-8")
    output_parent = roots.outputs / "assets"
    output_parent.mkdir()
    output = output_parent / "visual.png"

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        staged_output = Path(command[command.index("--output-file") + 1])
        staged_output.write_bytes(b"provider-result")
        output_parent.rename(roots.outputs / "assets-detached")
        output_parent.mkdir()
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(image_subprocess, "run_process_group", fake_run)
    with pytest.raises(RuntimeError, match="replaced during provider execution"):
        run_trusted_image_request(
            TrustedImageRequest(
                python_executable=sys.executable,
                script=script,
                roots=roots,
                mode="single",
                prompt_file=prompt,
                output_file=output,
            ),
            env={"OPENAI_API_KEY": "provider-only"},
            timeout=10,
        )

    assert not output.exists()
    assert not (roots.outputs / "assets-detached" / "visual.png").exists()


def test_manifest_preserves_partial_batch_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    roots = _roots(tmp_path)
    script = _script(tmp_path)
    prompt = roots.workspace / "prompt.json"
    prompt.write_text('{"prompt":"safe"}', encoding="utf-8")
    assets = roots.outputs / "assets"
    assets.mkdir()
    first = assets / "first.png"
    second = assets / "second.png"
    manifest = roots.outputs / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "items": [
                    {"prompt_file": str(prompt), "output_file": str(first)},
                    {"prompt_file": str(prompt), "output_file": str(second)},
                ]
            }
        ),
        encoding="utf-8",
    )

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        staged = json.loads(Path(command[-1]).read_text(encoding="utf-8"))
        Path(staged["items"][0]["output_file"]).write_bytes(b"first-complete")
        return subprocess.CompletedProcess(command, 1, stdout="partial", stderr="failed")

    monkeypatch.setattr(image_subprocess, "run_process_group", fake_run)
    completed = run_trusted_image_request(
        TrustedImageRequest(
            python_executable=sys.executable,
            script=script,
            roots=roots,
            mode="manifest",
            manifest_file=manifest,
        ),
        env={"OPENAI_API_KEY": "provider-only"},
        timeout=10,
    )

    assert completed.returncode == 1
    assert first.read_bytes() == b"first-complete"
    assert not second.exists()


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux credential boundary",
)
def test_detached_ordinary_shell_cannot_read_provider_environment(tmp_path: Path) -> None:
    base = Path(tempfile.mkdtemp(prefix="dq1-provider-probe-", dir="/tmp"))
    base.chmod(0o755)
    roots = _roots(base)
    prepare_thread_data_boundary(
        workspace_root=roots.workspace,
        outputs_root=roots.outputs,
        uploads_root=roots.uploads,
    )
    marker = Path(f"/tmp/dq1-provider-pid-{os.getpid()}.txt")
    marker.unlink(missing_ok=True)
    evidence = roots.workspace / "provider-probe.txt"
    prompt = roots.workspace / "prompt.json"
    prompt.write_text('{"prompt":"safe"}', encoding="utf-8")
    output = roots.outputs / "visual.png"
    provider_script = base / "root-provider.py"
    provider_script.write_text(
        """import argparse, os, time
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--prompt-file')
p.add_argument('--output-file')
p.add_argument('--aspect-ratio')
a = p.parse_args()
marker = Path(os.environ['PID_MARKER'])
marker.write_text(str(os.getpid()), encoding='utf-8')
marker.chmod(0o644)
prompt = Path(a.prompt_file)
try:
    prompt.write_text('tampered', encoding='utf-8')
    write_status = 'WRITE_BAD'
except PermissionError:
    write_status = 'WRITE_DENIED'
try:
    prompt.unlink()
    unlink_status = 'UNLINK_BAD'
except PermissionError:
    unlink_status = 'UNLINK_DENIED'
time.sleep(2)
Path(a.output_file).write_text(
    f'provider-output:{write_status}:{unlink_status}',
    encoding='utf-8',
)
""",
        encoding="utf-8",
    )
    provider_script.chmod(0o755)
    spy_code = """import os, sys, time
from pathlib import Path
marker, evidence = map(Path, sys.argv[1:3])
deadline = time.monotonic() + 10
while not marker.exists():
    if time.monotonic() >= deadline:
        evidence.write_text('NO_PROVIDER', encoding='utf-8')
        raise SystemExit(0)
    time.sleep(0.01)
pid = marker.read_text(encoding='utf-8').strip()
try:
    payload = Path(f'/proc/{pid}/environ').read_bytes()
except PermissionError:
    payload = b'DENIED'
except FileNotFoundError:
    payload = b'GONE'
evidence.write_bytes(payload)
time.sleep(30)
"""
    launcher_code = """import os, subprocess, sys
p = subprocess.Popen(
    [sys.executable, '-c', sys.argv[1], sys.argv[2], sys.argv[3]],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    preexec_fn=os.setsid,
)
print(p.pid)
"""
    command = (
        f"{shlex.quote(sys.executable)} -c {shlex.quote(launcher_code)} "
        f"{shlex.quote(spy_code)} {shlex.quote(str(marker))} {shlex.quote(str(evidence))}"
    )
    spy_pid = int(
        LocalSandbox("provider-probe").execute_command(
            command,
            workspace_root=roots.workspace,
            outputs_root=roots.outputs,
            uploads_root=roots.uploads,
        ).strip()
    )
    try:
        os.kill(spy_pid, 0)
        completed = run_trusted_image_request(
            TrustedImageRequest(
                python_executable=sys.executable,
                script=provider_script,
                roots=roots,
                mode="single",
                prompt_file=prompt,
                output_file=output,
            ),
            env={
                "OPENAI_API_KEY": "provider-secret-proof",
                "PID_MARKER": str(marker),
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            },
            timeout=10,
        )
        assert completed.returncode == 0
        # Cold production-like containers may still be settling large runtime
        # pages after image start. Preserve the security assertion while giving
        # the detached probe the same scheduling budget as its marker wait.
        deadline = time.monotonic() + 10
        while not evidence.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert evidence.read_bytes() == b"DENIED"
        assert output.read_text(encoding="utf-8") == (
            "provider-output:WRITE_DENIED:UNLINK_DENIED"
        )
    finally:
        try:
            os.kill(spy_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        marker.unlink(missing_ok=True)
        shutil.rmtree(base, ignore_errors=True)
