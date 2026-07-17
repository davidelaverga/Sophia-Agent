import os
import shlex
import shutil
import signal
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from deerflow.sandbox.local.list_dir import list_dir
from deerflow.sandbox.sandbox import Sandbox
from deerflow.sandbox_identity import prepare_thread_data_boundary, running_as_linux_root
from deerflow.sophia.image_subprocess import (
    ImageThreadRoots,
    TrustedImageRequest,
    run_trusted_image_request,
)
from deerflow.sophia.process_group import isolated_process_boundary
from deerflow.sophia.subprocess_env import trusted_subprocess_env

_COMMAND_TIMEOUT_SECONDS = 600
_COMMAND_PREVIEW_CHARS = 400
_GROUP_DRAIN_SECONDS = 10
_SANDBOX_PRIVATE_ENV_KEYS = frozenset(
    {
        # DQ-1 authority is parent-process only. Ordinary builder shell tools
        # cannot discover either provider credentials or canary admission data.
        "SOPHIA_DECK_QUALITY_OPENAI_API_KEY",
        "SOPHIA_DECK_QUALITY_CANARY_USER_IDS",
        # The internal builder-event signing key is likewise orchestration
        # authority, not an agent/tool capability.
        "SOPHIA_BUILDER_EVENTS_HMAC_SECRET",
        # Parent services hold durable storage, trace-export, database, and
        # service-to-service authority.  A LocalSandbox command is authored by
        # an ordinary user/model and must not inherit any of it.
        "DATABASE_URL",
        "POSTGRES_URL",
        "POSTGRESQL_URL",
        "REDIS_URL",
        "REDIS_TLS_URL",
        "MONGO_URL",
        "MONGODB_URI",
        "MYSQL_URL",
        "AMQP_URL",
        "CELERY_BROKER_URL",
        "PGPASSWORD",
        "PGPASSFILE",
        "PGSERVICE",
        "SUPABASE_URL",
        "SSH_AUTH_SOCK",
        # Proxy URLs may contain inline credentials.  Render does not require
        # them for the existing visual-skill subprocess path.
        "ALL_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
    }
)

_SANDBOX_PRIVATE_ENV_NAME_FRAGMENTS = (
    "API_KEY",
    "AUTHORIZATION",
    "CONNECTION_STRING",
    "COOKIE",
    "CREDENTIAL",
    "DSN",
    "_KEY",
    "PASSWORD",
    "PRIVATE_KEY",
    "SERVICE_ROLE",
    "SECRET",
    "TOKEN",
)

_SANDBOX_PRIVATE_ENV_PREFIXES = (
    "AWS_",
    "AZURE_",
    "GCP_",
    "GOOGLE_APPLICATION_CREDENTIALS",
)


def _is_sandbox_private_env_key(key: str) -> bool:
    """Return whether *key* carries parent-process authority.

    Ordinary user/model-authored shell commands receive no provider keys.
    The fixed, root-owned image generator has a separate exact-command path
    below; everything else that resembles authority is fail-closed.
    """

    normalized = key.upper()
    if normalized in _SANDBOX_PRIVATE_ENV_KEYS:
        return True
    if normalized.startswith(_SANDBOX_PRIVATE_ENV_PREFIXES):
        return True
    return any(fragment in normalized for fragment in _SANDBOX_PRIVATE_ENV_NAME_FRAGMENTS)


def _sandbox_child_env() -> dict[str, str]:
    """Copy only non-authority environment for an ordinary shell command."""

    return {
        key: value
        for key, value in os.environ.items()
        if not _is_sandbox_private_env_key(key)
    }


def _fixed_image_script(path: str) -> Path | None:
    try:
        candidate = Path(path).resolve(strict=True)
    except OSError:
        return None
    configured = os.getenv("SOPHIA_IMAGE_GENERATION_SCRIPT", "").strip()
    candidates = [
        Path("/mnt/skills/public/image-generation/scripts/generate.py"),
        Path("/app/skills/public/image-generation/scripts/generate.py"),
        Path(__file__).resolve().parents[6] / "skills/public/image-generation/scripts/generate.py",
    ]
    if configured:
        candidates.insert(0, Path(configured))
    allowed: set[Path] = set()
    for item in candidates:
        try:
            allowed.add(item.resolve(strict=True))
        except OSError:
            continue
    if candidate not in allowed:
        return None
    info = candidate.stat()
    if (
        os.name == "posix"
        and hasattr(os, "geteuid")
        and os.geteuid() == 0
        and (info.st_uid != 0 or info.st_mode & 0o022)
    ):
        return None
    return candidate


def _trusted_image_provider_command(
    command: str,
    *,
    workspace_root: str | Path | None = None,
    outputs_root: str | Path | None = None,
    uploads_root: str | Path | None = None,
) -> TrustedImageRequest | None:
    """Parse one exact fixed image command into a staged broker request."""

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    if len(tokens) < 3 or Path(tokens[0]).name not in {"python", "python3"}:
        return None
    interpreter = shutil.which(tokens[0])
    script = _fixed_image_script(tokens[1])
    if interpreter is None or script is None:
        return None
    if outputs_root is not None:
        parent = Path(outputs_root).parent
        workspace_root = workspace_root or parent / "workspace"
        uploads_root = uploads_root or parent / "uploads"
    if workspace_root is None or outputs_root is None or uploads_root is None:
        return None
    try:
        roots = ImageThreadRoots.create(
            workspace=workspace_root,
            outputs=outputs_root,
            uploads=uploads_root,
        )
    except (OSError, RuntimeError):
        return None

    value_flags = {"--prompt-file", "--output-file", "--aspect-ratio", "--size", "--manifest"}
    switch_flags = {"--slide-visual", "--preflight"}
    parsed: dict[str, list[str]] = {}
    index = 2
    while index < len(tokens):
        flag = tokens[index]
        if flag in switch_flags:
            if flag in parsed:
                return None
            parsed[flag] = []
            index += 1
            continue
        if flag == "--reference-images":
            index += 1
            values: list[str] = []
            while index < len(tokens) and not tokens[index].startswith("--"):
                values.append(tokens[index])
                index += 1
            if not values or flag in parsed:
                return None
            parsed[flag] = values
            continue
        if flag not in value_flags or flag in parsed or index + 1 >= len(tokens):
            return None
        parsed[flag] = [tokens[index + 1]]
        index += 2

    preflight = "--preflight" in parsed
    manifest_value = parsed.get("--manifest", [None])[0]
    prompt_value = parsed.get("--prompt-file", [None])[0]
    output_value = parsed.get("--output-file", [None])[0]
    if preflight:
        if len(parsed) != 1:
            return None
        return TrustedImageRequest(
            python_executable=interpreter,
            script=script,
            roots=roots,
            mode="preflight",
        )
    elif manifest_value is not None:
        if len(parsed) != 1:
            return None
        manifest = Path(manifest_value)
        if not manifest.is_absolute():
            return None
        return TrustedImageRequest(
            python_executable=interpreter,
            script=script,
            roots=roots,
            mode="manifest",
            manifest_file=manifest,
        )
    else:
        if prompt_value is None or output_value is None:
            return None
        prompt = Path(prompt_value)
        output = Path(output_value)
        if not prompt.is_absolute() or not output.is_absolute():
            return None
        references: list[Path] = []
        for reference in parsed.get("--reference-images", []):
            reference_path = Path(reference)
            if not reference_path.is_absolute():
                return None
            references.append(reference_path)
        return TrustedImageRequest(
            python_executable=interpreter,
            script=script,
            roots=roots,
            mode="single",
            prompt_file=prompt,
            output_file=output,
            reference_images=tuple(references),
            aspect_ratio=parsed.get("--aspect-ratio", ["16:9"])[0],
            size=parsed.get("--size", [None])[0],
            slide_visual="--slide-visual" in parsed,
        )


def _terminate_process_group(proc: "subprocess.Popen[str]") -> None:
    """Best-effort SIGKILL of the child's entire process group (Unix).

    A forked grandchild (e.g. the image-generation worker subprocess) can
    inherit and hold the stdout pipe open, so killing only the direct child
    leaves ``communicate()`` blocked far past the timeout — the exact wedge that
    hung deck build 019f0679 in prod (2026-06-27). Because the child was started
    with ``start_new_session=True`` it owns its own process group, so killpg
    reaps the whole tree without touching the harness.
    """
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        # Leader already exited; the group still lives under proc.pid (it was the
        # new-session leader, so pgid == pid) as long as a grandchild survives.
        pgid = proc.pid
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def _run_command_capture(
    run_args: "list[str] | str",
    run_kwargs: dict[str, object],
    timeout: int,
) -> "subprocess.CompletedProcess[str]":
    """Run a command capturing stdout/stderr, with a wall-clock that actually fires.

    On Unix the child is started in a new session and, on timeout, the whole
    process group is SIGKILLed so a forking grandchild cannot hold the pipe open
    and defeat the timeout (``subprocess.run``'s own timeout only kills the direct
    child). Raises ``subprocess.TimeoutExpired`` on timeout so callers keep their
    existing handling. Windows keeps the plain ``subprocess.run`` path.
    """
    if os.name == "nt":
        return subprocess.run(run_args, capture_output=True, text=True, timeout=timeout, **run_kwargs)

    popen_kwargs = dict(run_kwargs)
    popen_kwargs["start_new_session"] = True
    proc = subprocess.Popen(  # noqa: S603 — shell/executable come from the caller's validated shell detection
        run_args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **popen_kwargs,
    )
    group_terminated = False
    try:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_process_group(proc)
            group_terminated = True
            try:
                stdout, stderr = proc.communicate(timeout=_GROUP_DRAIN_SECONDS)
            except subprocess.TimeoutExpired:
                stdout, stderr = "", ""
            raise subprocess.TimeoutExpired(proc.args, timeout, output=stdout, stderr=stderr) from None
    finally:
        if not group_terminated:
            _terminate_process_group(proc)
    return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)


def _preview_text(value: str | bytes | None, *, limit: int = _COMMAND_PREVIEW_CHARS) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    else:
        text = value

    if len(text) <= limit:
        return text

    return f"{text[:limit]}..."


class LocalSandbox(Sandbox):
    def __init__(self, id: str):
        """
        Initialize local sandbox.

        Args:
            id: Sandbox identifier
        """
        super().__init__(id)

    @staticmethod
    def _get_shell() -> str:
        """Detect available shell executable with fallback.

        Returns the first available shell in order of preference:
        Unix: /bin/zsh → /bin/bash → /bin/sh → first `sh` found on PATH.
        Windows: pwsh → powershell → cmd (PowerShell preferred for better
        compatibility with Unix-style commands via built-in aliases).
        Raises a RuntimeError if no suitable shell is found.
        """
        if os.name == "nt":
            for name in ("pwsh", "powershell", "cmd"):
                found = shutil.which(name)
                if found is not None:
                    return found
            raise RuntimeError(
                "No suitable shell executable found on Windows. "
                "Tried pwsh, powershell, and cmd on PATH."
            )

        for shell in ("/bin/zsh", "/bin/bash", "/bin/sh"):
            if os.path.isfile(shell) and os.access(shell, os.X_OK):
                return shell
        shell_from_path = shutil.which("sh")
        if shell_from_path is not None:
            return shell_from_path
        raise RuntimeError("No suitable shell executable found. Tried /bin/zsh, /bin/bash, /bin/sh, and `sh` on PATH.")

    def execute_command_with_metadata(
        self,
        command: str,
        *,
        workspace_root: str | Path | None = None,
        outputs_root: str | Path | None = None,
        uploads_root: str | Path | None = None,
    ) -> tuple[str, dict[str, object]]:
        started_at = datetime.now(UTC)
        started_perf = time.perf_counter()
        telemetry: dict[str, object] = {
            "command": command,
            "started_at": started_at.isoformat(),
            "timeout_seconds": _COMMAND_TIMEOUT_SECONDS,
            "runner": "local_sandbox",
        }

        try:
            shell_executable = self._get_shell()
        except Exception as exc:
            completed_at = datetime.now(UTC)
            telemetry.update(
                {
                    "status": "shell_unavailable",
                    "shell_executable": None,
                    "completed_at": completed_at.isoformat(),
                    "duration_ms": round((time.perf_counter() - started_perf) * 1000),
                    "error": str(exc),
                }
            )
            return (f"Error: {exc}", telemetry)

        telemetry["shell_executable"] = shell_executable

        try:
            if running_as_linux_root():
                if workspace_root is None or outputs_root is None or uploads_root is None:
                    raise RuntimeError(
                        "LocalSandbox refuses root Linux execution without canonical thread roots"
                    )
                prepare_thread_data_boundary(
                    workspace_root=workspace_root,
                    outputs_root=outputs_root,
                    uploads_root=uploads_root,
                )
            provider_request = _trusted_image_provider_command(
                command,
                workspace_root=workspace_root,
                outputs_root=outputs_root,
                uploads_root=uploads_root,
            )
            # On Windows, subprocess.run(shell=True, executable=...) doesn't work
            # the same way as on Unix. Build the correct invocation per shell type.
            shell_name = os.path.basename(shell_executable).lower().replace(".exe", "")
            if provider_request is not None:
                # Preserve the established image-generation skill, but bypass
                # the user shell entirely. The broker snapshots inputs, assigns
                # a fresh provider-only UID, and parent-publishes staged output.
                telemetry["runner"] = "trusted_image_provider"
                result = run_trusted_image_request(
                    provider_request,
                    env=trusted_subprocess_env(allow_openai=True, allow_langsmith=True),
                    timeout=_COMMAND_TIMEOUT_SECONDS,
                )
            elif os.name == "nt" and shell_name in ("powershell", "pwsh"):
                run_args: list[str] | str = [shell_executable, "-NoProfile", "-Command", command]
                run_kwargs = {"shell": False}
                child_env = _sandbox_child_env()
                writable_files = []
            elif os.name == "nt" and shell_name == "cmd":
                run_args = command
                run_kwargs = {"shell": True}  # shell=True on Windows uses cmd.exe
                child_env = _sandbox_child_env()
                writable_files = []
            else:
                # An explicit argv keeps the shell command compatible with the
                # root-Linux UID/capability boundary below.
                run_args = [shell_executable, "-c", command]
                run_kwargs = {
                    "shell": False,
                    "cwd": str(workspace_root) if workspace_root is not None else None,
                }
                child_env = _sandbox_child_env()
                writable_files = []

            # LocalSandbox executes ordinary user-directed builder commands in
            # the LangGraph process. Always pass an explicit child environment;
            # only the exact fixed provider command above receives baseline
            # OpenAI/LangSmith, never DQ/canary/signing/storage authority.
            if provider_request is not None:
                pass
            elif isinstance(run_args, list):
                with isolated_process_boundary(
                    run_args,
                    env=child_env,
                    writable_files=writable_files,
                    writable_dirs=(),
                    identity_paths=[
                        value
                        for value in (workspace_root, outputs_root, uploads_root)
                        if value is not None
                    ],
                ) as (bounded_args, bounded_env):
                    run_kwargs["env"] = bounded_env
                    result = _run_command_capture(
                        bounded_args,
                        run_kwargs,
                        _COMMAND_TIMEOUT_SECONDS,
                    )
            else:
                # Windows cmd.exe is the sole string/shell=True path.
                run_kwargs["env"] = child_env
                result = _run_command_capture(run_args, run_kwargs, _COMMAND_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as exc:
            completed_at = datetime.now(UTC)
            stdout_preview = _preview_text(exc.stdout)
            stderr_preview = _preview_text(exc.stderr)
            telemetry.update(
                {
                    "status": "timed_out",
                    "completed_at": completed_at.isoformat(),
                    "duration_ms": round((time.perf_counter() - started_perf) * 1000),
                    "error": f"Command exceeded {_COMMAND_TIMEOUT_SECONDS} seconds",
                    "stdout_preview": stdout_preview,
                    "stderr_preview": stderr_preview,
                    "stdout_chars": len(exc.stdout or "") if not isinstance(exc.stdout, bytes) else len(exc.stdout),
                    "stderr_chars": len(exc.stderr or "") if not isinstance(exc.stderr, bytes) else len(exc.stderr),
                }
            )
            output = stdout_preview or ""
            if stderr_preview:
                output += f"\nStd Error:\n{stderr_preview}" if output else stderr_preview
            output = output.strip()
            if output:
                output += f"\nError: Command exceeded {_COMMAND_TIMEOUT_SECONDS} seconds"
            else:
                output = f"Error: Command exceeded {_COMMAND_TIMEOUT_SECONDS} seconds"
            return (output, telemetry)
        except Exception as exc:
            completed_at = datetime.now(UTC)
            telemetry.update(
                {
                    "status": "error",
                    "completed_at": completed_at.isoformat(),
                    "duration_ms": round((time.perf_counter() - started_perf) * 1000),
                    "error": str(exc),
                }
            )
            return (f"Error: Unexpected error executing command: {exc}", telemetry)

        completed_at = datetime.now(UTC)
        output = result.stdout
        if result.stderr:
            output += f"\nStd Error:\n{result.stderr}" if output else result.stderr
        if result.returncode != 0:
            output += f"\nExit Code: {result.returncode}"

        telemetry.update(
            {
                "status": "ok" if result.returncode == 0 else "nonzero_exit",
                "completed_at": completed_at.isoformat(),
                "duration_ms": round((time.perf_counter() - started_perf) * 1000),
                "exit_code": result.returncode,
                "stdout_preview": _preview_text(result.stdout),
                "stderr_preview": _preview_text(result.stderr),
                "output_preview": _preview_text(output),
                "stdout_chars": len(result.stdout or ""),
                "stderr_chars": len(result.stderr or ""),
                "output_chars": len(output or ""),
            }
        )

        return (output if output else "(no output)", telemetry)

    def execute_command(
        self,
        command: str,
        *,
        workspace_root: str | Path | None = None,
        outputs_root: str | Path | None = None,
        uploads_root: str | Path | None = None,
    ) -> str:
        output, _telemetry = self.execute_command_with_metadata(
            command,
            workspace_root=workspace_root,
            outputs_root=outputs_root,
            uploads_root=uploads_root,
        )
        return output

    def list_dir(self, path: str, max_depth=2) -> list[str]:
        return list_dir(path, max_depth)

    def read_file(self, path: str) -> str:
        with open(path, encoding="utf-8") as f:
            return f.read()

    def write_file(self, path: str, content: str, append: bool = False) -> None:
        dir_path = os.path.dirname(path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
        mode = "a" if append else "w"
        with open(path, mode, encoding="utf-8") as f:
            f.write(content)

    def update_file(self, path: str, content: bytes) -> None:
        dir_path = os.path.dirname(path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
        with open(path, "wb") as f:
            f.write(content)
