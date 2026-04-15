import os
import shutil
import subprocess
import time
from datetime import UTC, datetime

from deerflow.sandbox.local.list_dir import list_dir
from deerflow.sandbox.sandbox import Sandbox

_COMMAND_TIMEOUT_SECONDS = 600
_COMMAND_PREVIEW_CHARS = 400


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

    def execute_command_with_metadata(self, command: str) -> tuple[str, dict[str, object]]:
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
            # On Windows, subprocess.run(shell=True, executable=...) doesn't work
            # the same way as on Unix. Build the correct invocation per shell type.
            shell_name = os.path.basename(shell_executable).lower().replace(".exe", "")
            if os.name == "nt" and shell_name in ("powershell", "pwsh"):
                run_args: list[str] | str = [shell_executable, "-NoProfile", "-Command", command]
                run_kwargs = {"shell": False}
            elif os.name == "nt" and shell_name == "cmd":
                run_args = command
                run_kwargs = {"shell": True}  # shell=True on Windows uses cmd.exe
            else:
                # Unix path — use the detected shell
                run_args = command
                run_kwargs = {"shell": True, "executable": shell_executable}

            result = subprocess.run(
                run_args,
                capture_output=True,
                text=True,
                timeout=_COMMAND_TIMEOUT_SECONDS,
                **run_kwargs,
            )
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

    def execute_command(self, command: str) -> str:
        output, _telemetry = self.execute_command_with_metadata(command)
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
