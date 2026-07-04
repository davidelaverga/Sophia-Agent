"""Prepare a deterministic image-generation manifest for PPTX slide visuals.

The builder model still authors the creative prompt JSON files, but the harness
owns the machine-critical manifest shape: one generated visual per slide,
canonical output filenames, safe paths, and sanitized diagnostics. This keeps
parallel image generation fast without trusting the model to hand-write the
batch control plane.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path, PurePosixPath
from typing import Any

from langchain.tools import ToolRuntime, tool

from deerflow.sandbox.tools import get_thread_data, replace_virtual_path
from deerflow.sophia.tools.render_markdown_to_pdf import _ensure_relative_to_outputs, _result

logger = logging.getLogger(__name__)

_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_WORKSPACE_VIRTUAL_PREFIX = "/mnt/user-data/workspace/"
_DEFAULT_MANIFEST_PATH = f"{_OUTPUTS_VIRTUAL_PREFIX}assets/slide-visuals.manifest.json"
_MANIFEST_SCHEMA_VERSION = "sophia-pptx-image-manifest/v1"


def _trace_manifest_tool(
    name: str,
    *,
    inputs: dict[str, Any] | None = None,
    outputs: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> None:
    try:
        from langsmith import trace
        from langsmith.run_helpers import get_current_run_tree

        run_tree = get_current_run_tree()
        parent = getattr(run_tree, "dotted_order", None) if run_tree is not None else None
        with trace(
            name,
            run_type="tool",
            inputs=inputs or {},
            metadata={"sophia_component": "pptx_image_manifest_tool", **(metadata or {})},
            tags=["sophia", "builder", "pptx", "image_manifest", *(tags or [])],
            parent=parent,
        ) as run:
            try:
                run.end(outputs=outputs or {})
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001 - tracing must never block artifact builds.
        logger.debug("prepare_pptx_image_manifest: LangSmith span skipped", exc_info=True)


def _safe_basename(path: object) -> str | None:
    if not isinstance(path, str) or not path.strip():
        return None
    return PurePosixPath(path.replace("\\", "/").strip()).name or None


def _virtual_path_error(label: str, path: str, *, allow_workspace: bool) -> str | None:
    if not isinstance(path, str) or not path.strip():
        return f"{label}: empty or non-string path"
    normalized = path.strip().replace("\\", "/")
    if normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX) :]
    elif allow_workspace and normalized.startswith(_WORKSPACE_VIRTUAL_PREFIX):
        relative = normalized[len(_WORKSPACE_VIRTUAL_PREFIX) :]
    else:
        allowed = f"{_OUTPUTS_VIRTUAL_PREFIX} or {_WORKSPACE_VIRTUAL_PREFIX}" if allow_workspace else _OUTPUTS_VIRTUAL_PREFIX
        return f"{label}: must start with {allowed}"
    if ".." in relative.split("/"):
        return f"{label}: path traversal ('..') is not allowed: {normalized!r}"
    return None


def _host_path_for_virtual(path: str, thread_data: dict[str, Any] | None) -> Path:
    if thread_data is None:
        return Path(path)
    return Path(replace_virtual_path(path, thread_data))


def _prompt_hash_and_chars(path: Path) -> tuple[str | None, int]:
    try:
        data = path.read_bytes()
    except OSError:
        return None, 0
    return hashlib.sha256(data).hexdigest()[:16], len(data.decode("utf-8", errors="ignore"))


def _manifest_shape_summary(data: object) -> dict[str, Any]:
    if isinstance(data, dict):
        keys = sorted(str(key) for key in data.keys())[:20]
        raw_items = data.get("items")
        return {
            "top_level_type": "object",
            "top_level_keys": keys,
            "item_count": len(raw_items) if isinstance(raw_items, list) else None,
            "items_type": type(raw_items).__name__ if raw_items is not None else None,
        }
    return {"top_level_type": type(data).__name__}


def _error_payload(error_type: str, error: str, *, prompt_files: list[str], manifest_path: str) -> str:
    outputs = {
        "success": False,
        "error_type": error_type,
        "error": error,
        "manifest_path": manifest_path,
        "prompt_count": len(prompt_files),
    }
    _trace_manifest_tool(
        "Sophia PPTX Image Manifest Rejected",
        inputs={
            "prompt_count": len(prompt_files),
            "prompt_basenames": [_safe_basename(path) for path in prompt_files],
            "manifest_file": _safe_basename(manifest_path),
        },
        outputs=outputs,
        metadata={"pptx_manifest_error_class": error_type},
        tags=["manifest_rejected"],
    )
    return _result(**outputs)


@tool("prepare_pptx_image_manifest", parse_docstring=True)
def prepare_pptx_image_manifest(
    prompt_files: list[str],
    manifest_path: str = _DEFAULT_MANIFEST_PATH,
    runtime: ToolRuntime | None = None,
) -> str:
    """Create the deterministic PPTX slide-visual image manifest.

    Args:
        prompt_files: Ordered list of one readable prompt JSON file per slide.
            The first prompt is slide 1, the second prompt is slide 2, and so on.
            Prompt files may live under /mnt/user-data/workspace/ or
            /mnt/user-data/outputs/.
        manifest_path: Optional /mnt/user-data/outputs/... path for the manifest
            JSON. Defaults to /mnt/user-data/outputs/assets/slide-visuals.manifest.json.
    """
    if not isinstance(prompt_files, list) or not prompt_files:
        return _error_payload(
            "invalid_input",
            "prompt_files must be a non-empty ordered list.",
            prompt_files=[],
            manifest_path=manifest_path,
        )
    if len(prompt_files) > 20:
        return _error_payload(
            "invalid_input",
            "prompt_files may contain at most 20 slide prompts.",
            prompt_files=prompt_files,
            manifest_path=manifest_path,
        )
    if len(set(prompt_files)) != len(prompt_files):
        return _error_payload(
            "duplicate_prompt_file",
            "prompt_files must not contain duplicates.",
            prompt_files=prompt_files,
            manifest_path=manifest_path,
        )
    manifest_error = _ensure_relative_to_outputs("manifest_path", manifest_path)
    if manifest_error is not None:
        return _error_payload(
            "invalid_manifest_path",
            manifest_error,
            prompt_files=prompt_files,
            manifest_path=manifest_path,
        )

    thread_data = get_thread_data(runtime)
    sanitized_prompts: list[dict[str, Any]] = []
    for index, prompt_file in enumerate(prompt_files, start=1):
        if not isinstance(prompt_file, str):
            return _error_payload(
                "invalid_prompt_file",
                f"prompt_files[{index - 1}] must be a string.",
                prompt_files=prompt_files,
                manifest_path=manifest_path,
            )
        prompt_error = _virtual_path_error(f"prompt_files[{index - 1}]", prompt_file, allow_workspace=True)
        if prompt_error is not None:
            return _error_payload(
                "invalid_prompt_file",
                prompt_error,
                prompt_files=prompt_files,
                manifest_path=manifest_path,
            )
        prompt_host = _host_path_for_virtual(prompt_file, thread_data)
        if not prompt_host.is_file():
            return _error_payload(
                "manifest_prompt_missing",
                f"Prompt file is not readable: {_safe_basename(prompt_file)}",
                prompt_files=prompt_files,
                manifest_path=manifest_path,
            )
        prompt_hash, prompt_chars = _prompt_hash_and_chars(prompt_host)
        sanitized_prompts.append(
            {
                "slide_index": index,
                "prompt_file": prompt_file,
                "prompt_basename": _safe_basename(prompt_file),
                "prompt_hash": prompt_hash,
                "prompt_chars": prompt_chars,
            }
        )

    manifest_host = _host_path_for_virtual(manifest_path, thread_data)
    manifest_host.parent.mkdir(parents=True, exist_ok=True)
    assets_prefix = str(PurePosixPath(manifest_path).parent)
    items = [
        {
            "schema_version": _MANIFEST_SCHEMA_VERSION,
            "slide_index": prompt["slide_index"],
            "prompt_file": prompt["prompt_file"],
            "output_file": f"{assets_prefix}/slide-{prompt['slide_index']:02d}.png",
            "slide_visual": True,
            "aspect_ratio": "16:9",
        }
        for prompt in sanitized_prompts
    ]
    payload = {
        "schema_version": _MANIFEST_SCHEMA_VERSION,
        "manifest_author": "prepare_pptx_image_manifest",
        "items": items,
    }
    manifest_host.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    output_items = [
        {
            "slide_index": item["slide_index"],
            "prompt_file": prompt["prompt_basename"],
            "prompt_hash": prompt["prompt_hash"],
            "prompt_chars": prompt["prompt_chars"],
            "output_file": _safe_basename(item["output_file"]),
            "output_path": item["output_file"],
        }
        for item, prompt in zip(items, sanitized_prompts, strict=True)
    ]
    result = {
        "success": True,
        "manifest_path": manifest_path,
        "schema_version": _MANIFEST_SCHEMA_VERSION,
        "manifest_author": "prepare_pptx_image_manifest",
        "expected_count": len(items),
        "items": output_items,
    }
    _trace_manifest_tool(
        "Sophia PPTX Visual Prompt Files Prepared",
        inputs={
            "prompt_count": len(prompt_files),
            "prompt_basenames": [prompt["prompt_basename"] for prompt in sanitized_prompts],
        },
        outputs={
            "prompt_count": len(prompt_files),
            "prompts": [
                {
                    "slide_index": prompt["slide_index"],
                    "prompt_file": prompt["prompt_basename"],
                    "prompt_hash": prompt["prompt_hash"],
                    "prompt_chars": prompt["prompt_chars"],
                    "lint_status": "not_run",
                }
                for prompt in sanitized_prompts
            ],
        },
        tags=["prompt_files"],
    )
    _trace_manifest_tool(
        "Sophia PPTX Image Manifest Prepared",
        inputs={
            "schema_version": _MANIFEST_SCHEMA_VERSION,
            "manifest_author": "prepare_pptx_image_manifest",
            "manifest_file": _safe_basename(manifest_path),
            "expected_slide_count": len(items),
            "requested_item_count": len(items),
        },
        outputs={
            "success": True,
            "manifest_path": manifest_path,
            "shape": _manifest_shape_summary(payload),
            "prompt_readable_count": len(items),
            "output_basenames": [_safe_basename(item["output_file"]) for item in items],
        },
        metadata={
            "pptx_manifest_schema_version": _MANIFEST_SCHEMA_VERSION,
            "pptx_manifest_author": "prepare_pptx_image_manifest",
            "pptx_manifest_item_count": len(items),
        },
        tags=["manifest_prepared"],
    )
    return _result(**result)
