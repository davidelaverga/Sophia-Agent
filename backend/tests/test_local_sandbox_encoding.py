import builtins
import json
import os
import platform
import shlex
import shutil
import tempfile
import time
from pathlib import Path
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

    monkeypatch.setattr(local_sandbox, "running_as_linux_root", lambda: False)
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


def test_local_sandbox_delegates_list_argv_to_shared_process_boundary(monkeypatch):
    captured: dict[str, object] = {}

    class _Boundary:
        def __enter__(self):
            return ["/usr/bin/setpriv", "--", "/bin/sh", "-c", "printf safe"], {"PATH": "/usr/bin"}

        def __exit__(self, *_args):
            return False

    def _boundary(command, **kwargs):
        captured.update(command=command, **kwargs)
        return _Boundary()

    def _run(args, kwargs, _timeout):
        captured.update(bounded_args=args, run_env=kwargs["env"])
        return SimpleNamespace(stdout="safe", stderr="", returncode=0)

    monkeypatch.setattr(LocalSandbox, "_get_shell", staticmethod(lambda: "/bin/sh"))
    monkeypatch.setattr(local_sandbox, "running_as_linux_root", lambda: False)
    monkeypatch.setattr(local_sandbox, "isolated_process_boundary", _boundary)
    monkeypatch.setattr(local_sandbox, "_run_command_capture", _run)

    output = LocalSandbox("t").execute_command("printf safe")

    assert output == "safe"
    assert captured["command"] == ["/bin/sh", "-c", "printf safe"]
    assert captured["bounded_args"][:2] == ["/usr/bin/setpriv", "--"]
    assert captured["run_env"] == {"PATH": "/usr/bin"}


@pytest.mark.skipif(os.name == "nt", reason="subprocess env probe uses a Unix shell")
def test_local_sandbox_ordinary_shell_excludes_all_provider_and_service_authority(
    monkeypatch,
) -> None:
    monkeypatch.setattr(local_sandbox, "running_as_linux_root", lambda: False)
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "dq-private")
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_CANARY_USER_IDS", "canary-private")
    monkeypatch.setenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET", "signing-private")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "storage-private")
    monkeypatch.setenv("SUPABASE_URL", "https://private-project.supabase.co")
    monkeypatch.setenv("LANGSMITH_API_KEY", "trace-private")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "builder-parent-private")
    monkeypatch.setenv("MEM0_API_KEY", "memory-private")
    monkeypatch.setenv("DATABASE_URL", "postgresql://private")
    monkeypatch.setenv(
        "SOPHIA_VOICE_LAB_AUTH_DATABASE_URL",
        "postgresql://voice-lab-private",
    )
    monkeypatch.setenv("FUTURE_PRODUCT_DATABASE_URL", "postgresql://future-private")
    monkeypatch.setenv("STREAM_API_SECRET", "stream-private")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "telegram-private")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "cloud-private")
    monkeypatch.setenv("BABEL_SENTICNET_EMOTION_KEY", "provider-private")
    monkeypatch.setenv("REDIS_URL", "redis://private")
    monkeypatch.setenv("HTTPS_PROXY", "https://user:password@proxy.invalid")
    monkeypatch.setenv("OPENAI_API_KEY", "baseline-builder-key")
    monkeypatch.setenv("SOPHIA_SANDBOX_ENV_SENTINEL", "baseline-visible")

    probe = """import json
import os
print(json.dumps({
    "dq": os.getenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY"),
    "canary": os.getenv("SOPHIA_DECK_QUALITY_CANARY_USER_IDS"),
    "signing": os.getenv("SOPHIA_BUILDER_EVENTS_HMAC_SECRET"),
    "storage": os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
    "storage_url": os.getenv("SUPABASE_URL"),
    "trace": os.getenv("LANGSMITH_API_KEY"),
    "anthropic": os.getenv("ANTHROPIC_API_KEY"),
    "memory": os.getenv("MEM0_API_KEY"),
    "database": os.getenv("DATABASE_URL"),
    "voice_lab_database": os.getenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL"),
    "future_database": os.getenv("FUTURE_PRODUCT_DATABASE_URL"),
    "stream": os.getenv("STREAM_API_SECRET"),
    "telegram": os.getenv("TELEGRAM_BOT_TOKEN"),
    "cloud": os.getenv("AWS_ACCESS_KEY_ID"),
    "provider_key": os.getenv("BABEL_SENTICNET_EMOTION_KEY"),
    "redis": os.getenv("REDIS_URL"),
    "proxy": os.getenv("HTTPS_PROXY"),
    "baseline": os.getenv("OPENAI_API_KEY"),
    "sentinel": os.getenv("SOPHIA_SANDBOX_ENV_SENTINEL"),
}))
"""
    output = LocalSandbox("dq-env-isolation").execute_command(
        f"python3 -c {shlex.quote(probe)}"
    )

    assert json.loads(output) == {
        "dq": None,
        "canary": None,
        "signing": None,
        "storage": None,
        "storage_url": None,
        "trace": None,
        "anthropic": None,
        "memory": None,
        "database": None,
        "voice_lab_database": None,
        "future_database": None,
        "stream": None,
        "telegram": None,
        "cloud": None,
        "provider_key": None,
        "redis": None,
        "proxy": None,
        "baseline": None,
        "sentinel": "baseline-visible",
    }


def test_exact_fixed_image_command_preserves_baseline_provider_only(
    tmp_path,
    monkeypatch,
) -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "skills/public/image-generation/scripts/generate.py"
    )
    deer_home = tmp_path / "deer-home"
    user_data = deer_home / "threads" / "thread-1" / "user-data"
    workspace = user_data / "workspace"
    outputs = user_data / "outputs"
    uploads = user_data / "uploads"
    workspace.mkdir(parents=True)
    outputs.mkdir()
    uploads.mkdir()
    prompt = workspace / "prompt.json"
    prompt.write_text('{"prompt":"safe visual"}', encoding="utf-8")
    output = outputs / "visual.png"
    monkeypatch.setenv("DEER_FLOW_HOME", str(deer_home))
    monkeypatch.setenv("OPENAI_API_KEY", "baseline-builder-key")
    monkeypatch.setenv("LANGSMITH_API_KEY", "trace-key")
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_OPENAI_API_KEY", "dq-private")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "storage-private")
    command = (
        f"python {shlex.quote(str(script))} --prompt-file {shlex.quote(str(prompt))} "
        f"--output-file {shlex.quote(str(output))} --aspect-ratio 16:9"
    )

    provider = local_sandbox._trusted_image_provider_command(
        command,
        workspace_root=workspace,
        outputs_root=outputs,
        uploads_root=uploads,
    )

    assert provider is not None
    assert provider.script == script.resolve()
    assert provider.prompt_file == prompt
    assert provider.output_file == output
    env = local_sandbox.trusted_subprocess_env(allow_openai=True, allow_langsmith=True)
    assert env["OPENAI_API_KEY"] == "baseline-builder-key"
    assert env["LANGSMITH_API_KEY"] == "trace-key"
    assert "SOPHIA_DECK_QUALITY_OPENAI_API_KEY" not in env
    assert "SUPABASE_SERVICE_ROLE_KEY" not in env


def test_image_script_with_shell_chaining_is_not_a_trusted_provider_command(
    tmp_path,
) -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "skills/public/image-generation/scripts/generate.py"
    )
    command = (
        f"python {shlex.quote(str(script))} --preflight; "
        "python -c 'import os; print(os.getenv(\"OPENAI_API_KEY\"))'"
    )

    assert local_sandbox._trusted_image_provider_command(command) is None


def test_fixed_image_command_rejects_output_outside_configured_thread_root_without_side_effect(
    tmp_path,
    monkeypatch,
) -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "skills/public/image-generation/scripts/generate.py"
    )
    deer_home = tmp_path / "deer-home"
    workspace = deer_home / "threads" / "thread-1" / "user-data" / "workspace"
    workspace.mkdir(parents=True)
    prompt = workspace / "prompt.json"
    prompt.write_text('{"prompt":"safe visual"}', encoding="utf-8")
    outside_parent = tmp_path / "must-not-be-created"
    outside = outside_parent / "visual.png"
    monkeypatch.setenv("DEER_FLOW_HOME", str(deer_home))
    command = (
        f"python {shlex.quote(str(script))} --prompt-file {shlex.quote(str(prompt))} "
        f"--output-file {shlex.quote(str(outside))}"
    )

    outputs = deer_home / "threads" / "thread-1" / "user-data" / "outputs"
    outputs.mkdir()
    assert local_sandbox._trusted_image_provider_command(
        command,
        workspace_root=workspace,
        outputs_root=outputs,
    ) is None
    assert not outside_parent.exists()

    etc_command = (
        f"python {shlex.quote(str(script))} --prompt-file {shlex.quote(str(prompt))} "
        "--output-file /etc/dq1-provider-output.png"
    )
    assert local_sandbox._trusted_image_provider_command(
        etc_command,
        workspace_root=workspace,
        outputs_root=outputs,
    ) is None
    assert not Path("/etc/dq1-provider-output.png").exists()


def test_fixed_image_manifest_rejects_input_outside_current_thread_roots(
    tmp_path,
    monkeypatch,
) -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "skills/public/image-generation/scripts/generate.py"
    )
    deer_home = tmp_path / "deer-home"
    user_data = deer_home / "threads" / "thread-1" / "user-data"
    workspace = user_data / "workspace"
    outputs = user_data / "outputs"
    uploads = user_data / "uploads"
    for directory in (workspace, outputs, uploads):
        directory.mkdir(parents=True, exist_ok=True)
    manifest = outputs / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "prompt_file": "/etc/shadow",
                        "reference_images": [],
                        "output_file": "/mnt/user-data/outputs/visual.png",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("DEER_FLOW_HOME", str(deer_home))
    command = f"python {shlex.quote(str(script))} --manifest {shlex.quote(str(manifest))}"

    request = local_sandbox._trusted_image_provider_command(
        command,
        workspace_root=workspace,
        outputs_root=outputs,
        uploads_root=uploads,
    )
    assert request is not None
    with pytest.raises(RuntimeError, match="escapes current thread roots"):
        local_sandbox.run_trusted_image_request(request, env={}, timeout=1)
    assert not (outputs / "visual.png").exists()


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux production UID boundary",
)
def test_real_linux_sequential_sandbox_uids_can_update_same_workspace_file(
    monkeypatch,
) -> None:
    deer_home = Path(tempfile.mkdtemp(prefix="dq1-local-sandbox-home-"))
    workspace = deer_home / "threads" / "thread-1" / "user-data" / "workspace"
    outputs = deer_home / "threads" / "thread-1" / "user-data" / "outputs"
    uploads = deer_home / "threads" / "thread-1" / "user-data" / "uploads"
    workspace.mkdir(parents=True)
    outputs.mkdir()
    uploads.mkdir()
    deer_home.chmod(0o755)
    workspace.chmod(0o777)
    outputs.chmod(0o777)
    target = workspace / "shared.txt"
    monkeypatch.setenv("DEER_FLOW_HOME", str(deer_home))
    sandbox = LocalSandbox("real-linux-sequential")
    try:
        first = sandbox.execute_command(
            f"printf first > {shlex.quote(str(target))}; id -u",
            workspace_root=workspace,
            outputs_root=outputs,
            uploads_root=uploads,
        ).strip()
        assert target.read_text(encoding="utf-8") == "first"
        assert target.stat().st_mode & 0o777 == 0o600

        second = sandbox.execute_command(
            f"printf second > {shlex.quote(str(target))}; cat {shlex.quote(str(target))}; printf '\n'; id -u",
            workspace_root=workspace,
            outputs_root=outputs,
            uploads_root=uploads,
        ).strip().splitlines()
        assert target.read_text(encoding="utf-8") == "second"
        assert second[0] == "second"
        assert first == second[-1]

        removed = sandbox.execute_command(
            f"rm {shlex.quote(str(target))}; test ! -e {shlex.quote(str(target))}; id -u",
            workspace_root=workspace,
            outputs_root=outputs,
            uploads_root=uploads,
        ).strip()
        assert removed == first
        assert not target.exists()
    finally:
        shutil.rmtree(deer_home, ignore_errors=True)


@pytest.mark.skipif(
    platform.system() != "Linux" or not hasattr(os, "geteuid") or os.geteuid() != 0,
    reason="requires the real root-Linux thread filesystem boundary",
)
def test_real_linux_threads_are_private_and_uploads_are_read_only() -> None:
    deer_home = Path(tempfile.mkdtemp(prefix="dq1-thread-fs-", dir="/tmp"))
    deer_home.chmod(0o755)

    def roots(thread: str) -> tuple[Path, Path, Path]:
        user_data = deer_home / "threads" / thread / "user-data"
        workspace = user_data / "workspace"
        outputs = user_data / "outputs"
        uploads = user_data / "uploads"
        for root in (workspace, outputs, uploads):
            root.mkdir(parents=True, exist_ok=True)
        return workspace, outputs, uploads

    a_workspace, a_outputs, a_uploads = roots("thread-a")
    b_workspace, b_outputs, b_uploads = roots("thread-b")
    a_upload = a_uploads / "source.txt"
    b_upload = b_uploads / "secret.txt"
    a_upload.write_text("own-source", encoding="utf-8")
    b_upload.write_text("thread-b-secret", encoding="utf-8")
    a = LocalSandbox("thread-a")
    b = LocalSandbox("thread-b")
    try:
        b_uid = b.execute_command(
            "id -u",
            workspace_root=b_workspace,
            outputs_root=b_outputs,
            uploads_root=b_uploads,
        ).strip()
        a_uid = a.execute_command(
            "id -u",
            workspace_root=a_workspace,
            outputs_root=a_outputs,
            uploads_root=a_uploads,
        ).strip()
        assert a_uid != b_uid

        cross_thread = a.execute_command(
            (
                f"if cat {shlex.quote(str(b_upload))} >/dev/null 2>&1; "
                "then echo READ_BAD; else echo READ_DENIED; fi; "
                f"if printf hacked > {shlex.quote(str(b_outputs / 'hacked.txt'))} 2>/dev/null; "
                "then echo WRITE_BAD; else echo WRITE_DENIED; fi"
            ),
            workspace_root=a_workspace,
            outputs_root=a_outputs,
            uploads_root=a_uploads,
        )
        assert "READ_DENIED" in cross_thread
        assert "WRITE_DENIED" in cross_thread
        assert "READ_BAD" not in cross_thread
        assert "WRITE_BAD" not in cross_thread
        assert not (b_outputs / "hacked.txt").exists()

        own_upload = a.execute_command(
            (
                f"cat {shlex.quote(str(a_upload))}; "
                f"if printf changed > {shlex.quote(str(a_upload))} 2>/dev/null; "
                "then echo OVERWRITE_BAD; else echo OVERWRITE_DENIED; fi; "
                f"if rm {shlex.quote(str(a_upload))} 2>/dev/null; "
                "then echo DELETE_BAD; else echo DELETE_DENIED; fi; "
                f"if touch {shlex.quote(str(a_uploads / 'new.txt'))} 2>/dev/null; "
                "then echo CREATE_BAD; else echo CREATE_DENIED; fi"
            ),
            workspace_root=a_workspace,
            outputs_root=a_outputs,
            uploads_root=a_uploads,
        )
        assert "own-source" in own_upload
        assert "OVERWRITE_DENIED" in own_upload
        assert "DELETE_DENIED" in own_upload
        assert "CREATE_DENIED" in own_upload
        assert a_upload.read_text(encoding="utf-8") == "own-source"
        assert not (a_uploads / "new.txt").exists()
    finally:
        shutil.rmtree(deer_home, ignore_errors=True)


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
    monkeypatch.setattr(local_sandbox, "running_as_linux_root", lambda: False)
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
