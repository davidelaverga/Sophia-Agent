from __future__ import annotations

import json
import os
import secrets
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from deerflow.sandbox_identity import (
    claim_thread_identity,
    running_as_linux_root,
    user_data_root_for_path,
)
from deerflow.sophia.process_group import run_process_group

_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_MAX_PROMPT_BYTES = 2 * 1024 * 1024
_MAX_REFERENCE_BYTES = 50 * 1024 * 1024
_MAX_OUTPUT_BYTES = 50 * 1024 * 1024
_MAX_MANIFEST_ITEMS = 64
_MAX_REFERENCES_PER_ITEM = 16
_MAX_TOTAL_INPUT_BYTES = 256 * 1024 * 1024
_MAX_TOTAL_OUTPUT_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True)
class ImageThreadRoots:
    workspace: Path
    outputs: Path
    uploads: Path
    user_data: Path

    @classmethod
    def create(
        cls,
        *,
        workspace: str | Path,
        outputs: str | Path,
        uploads: str | Path,
    ) -> ImageThreadRoots:
        values = {
            "workspace": Path(os.path.abspath(os.fspath(workspace))),
            "outputs": Path(os.path.abspath(os.fspath(outputs))),
            "uploads": Path(os.path.abspath(os.fspath(uploads))),
        }
        user_roots = {user_data_root_for_path(path) for path in values.values()}
        if None in user_roots or len(user_roots) != 1:
            # Local developer/test runtimes historically use three sibling
            # roots without the production threads/<id>/user-data envelope.
            # Root Linux remains strict and fail-closed.
            parents = {path.parent for path in values.values()}
            if running_as_linux_root() or len(parents) != 1:
                raise RuntimeError("image subprocess roots cross thread boundaries")
            user_data = next(iter(parents))
        else:
            user_data = next(iter(user_roots))
            assert user_data is not None
        for name, path in values.items():
            if (
                path != user_data / name
                or not path.is_dir()
                or path.is_symlink()
                or path.resolve(strict=True) != path
            ):
                raise RuntimeError(f"invalid image subprocess {name} root: {path}")
        if running_as_linux_root():
            claim_thread_identity(user_data)
        return cls(user_data=user_data, **values)

    def containing_root(self, path: Path) -> Path | None:
        candidate = Path(os.path.abspath(os.fspath(path)))
        for root in (self.workspace, self.outputs, self.uploads):
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            return root
        return None


@dataclass(frozen=True)
class TrustedImageRequest:
    python_executable: str
    script: Path
    roots: ImageThreadRoots
    mode: Literal["preflight", "single", "manifest"]
    prompt_file: Path | None = None
    output_file: Path | None = None
    reference_images: tuple[Path, ...] = ()
    manifest_file: Path | None = None
    aspect_ratio: str = "16:9"
    size: str | None = None
    slide_visual: bool = False


@dataclass
class _OutputTarget:
    original: Path
    staged: Path
    parent_fd: int
    parent_stat: os.stat_result
    root: Path
    parent_parts: tuple[str, ...]
    name: str

    def close(self) -> None:
        try:
            os.close(self.parent_fd)
        except OSError:
            pass


def _validate_fixed_runtime(request: TrustedImageRequest) -> tuple[str, Path]:
    python = Path(request.python_executable).resolve(strict=True)
    script = request.script.resolve(strict=True)
    if not python.is_file() or not script.is_file():
        raise RuntimeError("trusted image runtime is missing")
    if os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0:
        for path in (python, script):
            info = path.stat()
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                raise RuntimeError(f"trusted image runtime is writable or not root-owned: {path}")
    return str(python), script


def _relative_parts(root: Path, candidate: Path) -> tuple[str, ...]:
    normalized = Path(os.path.abspath(os.fspath(candidate)))
    try:
        relative = normalized.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"image subprocess path escapes its allowed root: {candidate}") from exc
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise RuntimeError(f"invalid image subprocess relative path: {candidate}")
    return relative.parts


def _open_dir_beneath(root: Path, parts: tuple[str, ...]) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(root, flags)
    try:
        for part in parts:
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _snapshot_file(
    roots: ImageThreadRoots,
    path: Path,
    *,
    maximum_bytes: int,
) -> tuple[bytes, str]:
    root = roots.containing_root(path)
    if root is None:
        raise RuntimeError(f"image subprocess input is outside current thread roots: {path}")
    parts = _relative_parts(root, path)
    parent_fd = _open_dir_beneath(root, parts[:-1])
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(parts[-1], flags, dir_fd=parent_fd)
        try:
            before = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_size > maximum_bytes
            ):
                raise RuntimeError(f"image subprocess input is not a bounded regular file: {path}")
            chunks: list[bytes] = []
            remaining = maximum_bytes + 1
            while remaining > 0:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            after = os.fstat(descriptor)
            if len(payload) > maximum_bytes or (
                before.st_ino,
                before.st_dev,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            ) != (
                after.st_ino,
                after.st_dev,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ):
                raise RuntimeError(f"image subprocess input changed during snapshot: {path}")
            return payload, path.suffix
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def _output_target(
    roots: ImageThreadRoots,
    original: Path,
    staged: Path,
) -> _OutputTarget:
    parts = _relative_parts(roots.outputs, original)
    parent_fd = _open_dir_beneath(roots.outputs, parts[:-1])
    return _OutputTarget(
        original=original,
        staged=staged,
        parent_fd=parent_fd,
        parent_stat=os.fstat(parent_fd),
        root=roots.outputs,
        parent_parts=parts[:-1],
        name=parts[-1],
    )


def _resolve_manifest_path(
    value: object,
    *,
    manifest_parent: Path,
    roots: ImageThreadRoots,
    output: bool,
) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("image manifest contains an empty path")
    prefixes = {
        "/mnt/user-data/workspace/": roots.workspace,
        "/mnt/user-data/outputs/": roots.outputs,
        "/mnt/user-data/uploads/": roots.uploads,
    }
    for prefix, root in prefixes.items():
        if value.startswith(prefix):
            candidate = root / value.removeprefix(prefix)
            break
    else:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = manifest_parent / candidate
    candidate = Path(os.path.abspath(os.fspath(candidate)))
    if output and roots.containing_root(candidate) != roots.outputs:
        raise RuntimeError("image manifest output escapes current thread outputs")
    if not output and roots.containing_root(candidate) is None:
        raise RuntimeError("image manifest input escapes current thread roots")
    return candidate


def _write_staged_input(directory: Path, index: int, payload: bytes, suffix: str) -> Path:
    path = directory / f"input-{index:04d}{suffix}"
    path.write_bytes(payload)
    path.chmod(0o444)
    return path


def _prepare_request_unchecked(
    request: TrustedImageRequest,
    stage: Path,
    *,
    targets: list[_OutputTarget],
) -> tuple[list[str], list[_OutputTarget], dict[str, str]]:
    python, script = _validate_fixed_runtime(request)
    inputs_dir = stage / "inputs"
    outputs_dir = stage / "outputs"
    inputs_dir.mkdir(mode=0o755)
    outputs_dir.mkdir(mode=0o755)
    replacements: dict[str, str] = {}
    if request.mode == "preflight":
        return [python, "-I", str(script), "--preflight"], targets, replacements

    if request.mode == "single":
        if request.prompt_file is None or request.output_file is None:
            raise RuntimeError("single image request is incomplete")
        payload, suffix = _snapshot_file(
            request.roots,
            request.prompt_file,
            maximum_bytes=_MAX_PROMPT_BYTES,
        )
        staged_prompt = _write_staged_input(inputs_dir, 0, payload, suffix or ".json")
        staged_refs: list[Path] = []
        if len(request.reference_images) > _MAX_REFERENCES_PER_ITEM:
            raise RuntimeError("single image request has too many references")
        total_input_bytes = len(payload)
        for index, reference in enumerate(request.reference_images, start=1):
            ref_payload, ref_suffix = _snapshot_file(
                request.roots,
                reference,
                maximum_bytes=_MAX_REFERENCE_BYTES,
            )
            staged_refs.append(
                _write_staged_input(inputs_dir, index, ref_payload, ref_suffix or ".png")
            )
            total_input_bytes += len(ref_payload)
            if total_input_bytes > _MAX_TOTAL_INPUT_BYTES:
                raise RuntimeError("single image request exceeds its input byte budget")
        staged_output = outputs_dir / f"output-0000{request.output_file.suffix or '.png'}"
        targets.append(_output_target(request.roots, request.output_file, staged_output))
        command = [
            python,
            "-I",
            str(script),
            "--prompt-file",
            str(staged_prompt),
            "--output-file",
            str(staged_output),
            "--aspect-ratio",
            request.aspect_ratio,
        ]
        if staged_refs:
            command.extend(["--reference-images", *(str(path) for path in staged_refs)])
        if request.size:
            command.extend(["--size", request.size])
        if request.slide_visual:
            command.append("--slide-visual")
        replacements[str(staged_output)] = str(request.output_file)
        return command, targets, replacements

    if request.manifest_file is None:
        raise RuntimeError("manifest image request is incomplete")
    manifest_bytes, _ = _snapshot_file(
        request.roots,
        request.manifest_file,
        maximum_bytes=_MAX_MANIFEST_BYTES,
    )
    try:
        manifest = json.loads(manifest_bytes)
    except ValueError as exc:
        raise RuntimeError("image manifest is invalid JSON") from exc
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if (
        not isinstance(items, list)
        or not items
        or len(items) > _MAX_MANIFEST_ITEMS
    ):
        raise RuntimeError("image manifest has no items")
    staged_items: list[dict[str, Any]] = []
    input_index = 0
    total_input_bytes = len(manifest_bytes)
    seen_outputs: set[Path] = set()
    for output_index, raw_item in enumerate(items):
        if not isinstance(raw_item, dict):
            raise RuntimeError("image manifest item is not an object")
        item = dict(raw_item)
        prompt = _resolve_manifest_path(
            item.get("prompt_file"),
            manifest_parent=request.manifest_file.parent,
            roots=request.roots,
            output=False,
        )
        prompt_payload, prompt_suffix = _snapshot_file(
            request.roots,
            prompt,
            maximum_bytes=_MAX_PROMPT_BYTES,
        )
        staged_prompt = _write_staged_input(
            inputs_dir,
            input_index,
            prompt_payload,
            prompt_suffix or ".json",
        )
        input_index += 1
        total_input_bytes += len(prompt_payload)
        if total_input_bytes > _MAX_TOTAL_INPUT_BYTES:
            raise RuntimeError("image manifest exceeds its input byte budget")
        staged_references: list[str] = []
        references = item.get("reference_images") or []
        if (
            not isinstance(references, list)
            or len(references) > _MAX_REFERENCES_PER_ITEM
        ):
            raise RuntimeError("image manifest references must be a list")
        for raw_reference in references:
            reference = _resolve_manifest_path(
                raw_reference,
                manifest_parent=request.manifest_file.parent,
                roots=request.roots,
                output=False,
            )
            ref_payload, ref_suffix = _snapshot_file(
                request.roots,
                reference,
                maximum_bytes=_MAX_REFERENCE_BYTES,
            )
            staged_reference = _write_staged_input(
                inputs_dir,
                input_index,
                ref_payload,
                ref_suffix or ".png",
            )
            input_index += 1
            staged_references.append(str(staged_reference))
            total_input_bytes += len(ref_payload)
            if total_input_bytes > _MAX_TOTAL_INPUT_BYTES:
                raise RuntimeError("image manifest exceeds its input byte budget")
        original_output = _resolve_manifest_path(
            item.get("output_file"),
            manifest_parent=request.manifest_file.parent,
            roots=request.roots,
            output=True,
        )
        if original_output in seen_outputs:
            raise RuntimeError("image manifest repeats an output path")
        seen_outputs.add(original_output)
        staged_output = outputs_dir / f"output-{output_index:04d}{original_output.suffix or '.png'}"
        targets.append(_output_target(request.roots, original_output, staged_output))
        item["prompt_file"] = str(staged_prompt)
        item["reference_images"] = staged_references
        item["output_file"] = str(staged_output)
        staged_items.append(item)
        replacements[str(staged_output)] = str(original_output)
    manifest["items"] = staged_items
    staged_manifest = stage / "manifest.json"
    staged_manifest.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    staged_manifest.chmod(0o444)
    return [python, "-I", str(script), "--manifest", str(staged_manifest)], targets, replacements


def _prepare_request(
    request: TrustedImageRequest,
    stage: Path,
) -> tuple[list[str], list[_OutputTarget], dict[str, str]]:
    targets: list[_OutputTarget] = []
    try:
        return _prepare_request_unchecked(request, stage, targets=targets)
    except Exception:
        for target in targets:
            target.close()
        raise


def _read_staged_output(path: Path) -> bytes | None:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or not 0 < info.st_size <= _MAX_OUTPUT_BYTES
        ):
            return None
        chunks: list[bytes] = []
        total = 0
        while total <= _MAX_OUTPUT_BYTES:
            chunk = os.read(descriptor, min(1024 * 1024, _MAX_OUTPUT_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        data = b"".join(chunks)
        return data if 0 < len(data) <= _MAX_OUTPUT_BYTES else None
    finally:
        os.close(descriptor)


def _publish_output(target: _OutputTarget, payload: bytes, *, uid: int, gid: int) -> None:
    current = os.fstat(target.parent_fd)
    if (current.st_dev, current.st_ino) != (target.parent_stat.st_dev, target.parent_stat.st_ino):
        raise RuntimeError("image output parent changed before publication")
    # Re-open the canonical namespace after the provider returns. The retained
    # dirfd is safe from symlink redirection, but publishing into a renamed,
    # detached directory would silently lose the artifact; fail closed instead.
    namespace_fd = _open_dir_beneath(target.root, target.parent_parts)
    try:
        namespace = os.fstat(namespace_fd)
        if (namespace.st_dev, namespace.st_ino) != (
            target.parent_stat.st_dev,
            target.parent_stat.st_ino,
        ):
            raise RuntimeError("image output parent was replaced during provider execution")
    finally:
        os.close(namespace_fd)
    temporary = f".sophia-image-{secrets.token_hex(12)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600, dir_fd=target.parent_fd)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        if running_as_linux_root():
            os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, 0o600)
    except Exception:
        try:
            os.unlink(temporary, dir_fd=target.parent_fd)
        except OSError:
            pass
        raise
    finally:
        os.close(descriptor)
    os.rename(
        temporary,
        target.name,
        src_dir_fd=target.parent_fd,
        dst_dir_fd=target.parent_fd,
    )
    os.fsync(target.parent_fd)
    namespace_fd = _open_dir_beneath(target.root, target.parent_parts)
    try:
        namespace = os.fstat(namespace_fd)
        if (namespace.st_dev, namespace.st_ino) != (
            target.parent_stat.st_dev,
            target.parent_stat.st_ino,
        ):
            raise RuntimeError("image output parent changed during publication")
    finally:
        os.close(namespace_fd)


def run_trusted_image_request(
    request: TrustedImageRequest,
    *,
    env: Mapping[str, str],
    timeout: int,
) -> subprocess.CompletedProcess[str]:
    """Run the fixed provider script over immutable private snapshots."""

    stage = Path(tempfile.mkdtemp(prefix="sophia-image-provider-"))
    stage.chmod(0o700)
    targets: list[_OutputTarget] = []
    try:
        command, targets, replacements = _prepare_request(request, stage)
        isolated_env = dict(env)
        for key in (
            "PYTHONPATH",
            "PYTHONHOME",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "SOPHIA_OUTPUTS_HOST_PATH",
            "SOPHIA_WORKSPACE_HOST_PATH",
        ):
            isolated_env.pop(key, None)
        isolated_env.update(
            {
                "PYTHONNOUSERSITE": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONSAFEPATH": "1",
            }
        )
        completed = run_process_group(
            command,
            timeout=timeout,
            cwd=Path(command[2]).parent,
            private_read_dirs=[stage],
            writable_dirs=[stage / "outputs"],
            env=isolated_env,
            identity_paths=[request.roots.user_data],
            force_fresh_identity=True,
        )
        if running_as_linux_root():
            uid, gid = claim_thread_identity(request.roots.user_data)
        else:
            uid = os.geteuid() if hasattr(os, "geteuid") else 0
            gid = os.getegid() if hasattr(os, "getegid") else 0
        total_output_bytes = 0
        for target in targets:
            payload = _read_staged_output(target.staged)
            if payload is not None:
                total_output_bytes += len(payload)
                if total_output_bytes > _MAX_TOTAL_OUTPUT_BYTES:
                    raise RuntimeError("image provider output exceeds its aggregate byte budget")
                _publish_output(target, payload, uid=uid, gid=gid)
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        for staged, original in replacements.items():
            stdout = stdout.replace(staged, original)
            stderr = stderr.replace(staged, original)
        return subprocess.CompletedProcess(
            completed.args,
            completed.returncode,
            stdout=stdout,
            stderr=stderr,
        )
    finally:
        for target in targets:
            target.close()
        shutil.rmtree(stage, ignore_errors=True)
