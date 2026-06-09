"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).

PR-D (2026-04-24): adds file-existence verification before accepting an
emit_builder_artifact call. When the referenced file is missing on disk
and in Supabase, the emit is rejected via wrap_tool_call with a
Command(goto="model") so the builder gets another turn to retry instead
of completing with a phantom artifact.
"""

import json
import logging
import re
import shlex
import time
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact
from deerflow.sophia.builder_web_policy import extract_explicit_user_urls
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.supabase_mirror import maybe_mirror_file

try:  # pragma: no cover - dependency availability varies in minimal tests.
    from pypdf import PdfReader
except Exception:  # noqa: BLE001
    PdfReader = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


def _skill_name_from_path(path: str) -> str | None:
    for marker in ("/skills/public/", "/mnt/skills/public/", "/skills/", "/mnt/skills/"):
        if marker in path:
            tail = path.split(marker, 1)[1]
            skill = tail.split("/", 1)[0]
            return skill or None
    return None


def _command_references_skill(command: str, skill_name: str) -> bool:
    return any(
        marker in command
        for marker in (
            f"/skills/{skill_name}/",
            f"/mnt/skills/{skill_name}/",
            f"/skills/public/{skill_name}/",
            f"/mnt/skills/public/{skill_name}/",
        )
    )


def _emit_skill_usage_logs(tool_calls: list[dict[str, Any]]) -> None:
    """Log builder skill discovery / invocation as INFO breadcrumbs.

    Two distinct events are surfaced so the user can grep one line per
    builder run to answer "did the builder pick a skill?":

    - ``[BuilderSkill] manifest_read: skill=<name>`` — the model called
      ``read_file`` on a SKILL.md, i.e. it discovered the skill workflow.
    - ``[BuilderSkill] script_invoked: skill=<name>`` — the model called
      ``bash`` with a command path under ``skills/<name>/``, i.e. it
      executed a skill-bundled script.

    Without these the existing logs only show ``write_file`` and ``bash``
    tool names, with no signal whether the builder is using a pre-tested
    skill workflow or writing its own ``_generate_*.py`` script.
    """
    relevant = BuilderTaskMiddleware._BUILDER_RELEVANT_SKILLS
    for tc in tool_calls:
        name = tc.get("name")
        args = tc.get("args") or {}
        if name in ("read_file", "read_file_tool"):
            path = args.get("path") or args.get("file_path") or ""
            if isinstance(path, str) and "/skills/" in path and path.endswith("/SKILL.md"):
                segment = _skill_name_from_path(path)
                if segment in relevant:
                    logger.info("[BuilderSkill] manifest_read: skill=%s", segment)
        elif name == "bash":
            cmd = args.get("command")
            if not isinstance(cmd, str) or not cmd:
                continue
            for skill_name in relevant:
                # Match both the host (``skills/<name>/``) and container
                # (``/mnt/skills/<name>/``) layouts so this works in
                # local-sandbox and aio-sandbox modes alike.
                if _command_references_skill(cmd, skill_name):
                    logger.info("[BuilderSkill] script_invoked: skill=%s", skill_name)
                    break


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_SIMPLE_PDF_TOOL_NAME = "create_pdf_artifact"
_PDF_CREATION_TOOL_NAMES = frozenset({"render_markdown_to_pdf", _SIMPLE_PDF_TOOL_NAME})
_BUILDER_WRITE_TOOL_NAMES = {"write_file", "write_file_tool"}
_BUILDER_RESEARCH_TOOL_NAMES = {"builder_web_search", "builder_web_fetch"}
_BUILDER_SUBSTANTIVE_TOOL_NAMES = {
    "write_file",
    "write_file_tool",
    "str_replace",
    "str_replace_tool",
    "emit_builder_artifact",
    "generate_visual_asset",
}
_SIMPLE_PDF_REQUEST_MARKERS = (
    "simple pdf",
    "simple .pdf",
    "simple product review",
    "artifact canvas smoke test",
    "pdf artifact",
)
_SAFE_BASH_COMMAND_RE = re.compile(
    r"^\s*(?:pwd|ls|find|cat|sed|head|tail|grep|rg|wc|file|du|stat|jq)\b"
)
_BASH_WRITE_MARKER_RE = re.compile(
    r"(?:^|\s)(?:python|node|perl|ruby)\b|[>|]\s*|(?:^|\s)tee\s+|<<"
)
_FILE_TARGET_HINT_MARKER = "[Sophia/post-interrupt build directive]"
_CONCRETE_FILE_TARGET_RE = re.compile(r"Concrete file target:\s*`([^`]+)`")
_PPTX_SKILL_PATH_MARKERS = (
    "/skills/public/ppt-generation/SKILL.md",
    "/mnt/skills/public/ppt-generation/SKILL.md",
    "/skills/ppt-generation/SKILL.md",
    "/mnt/skills/ppt-generation/SKILL.md",
)
_PPTX_GENERATOR_PATH_MARKERS = (
    "/skills/public/ppt-generation/scripts/generate.py",
    "/mnt/skills/public/ppt-generation/scripts/generate.py",
    "/skills/ppt-generation/scripts/generate.py",
    "/mnt/skills/ppt-generation/scripts/generate.py",
)
_IMAGE_GENERATION_PATH_MARKERS = (
    "/skills/public/image-generation/scripts/generate.py",
    "/mnt/skills/public/image-generation/scripts/generate.py",
    "/skills/image-generation/scripts/generate.py",
    "/mnt/skills/image-generation/scripts/generate.py",
)
_PATH_CORRECTABLE_WRITE_ERROR_CLASSES = {
    "path_is_directory",
    "path_not_outputs",
    "path_traversal",
    "permission_denied",
    "write_tool_error",
}
_RUNTIME_WRITE_ERROR_CLASSES = {
    "missing_thread_data",
    "missing_thread_id",
    "sandbox_not_found",
    "sandbox_runtime",
    "unexpected_write_error",
    "write_os_error",
}
_PROMOTABLE_DELIVERABLE_EXTENSIONS = frozenset({
    ".pdf",
    ".pptx",
    ".docx",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".html",
    ".htm",
    ".zip",
    ".md",
    ".txt",
    ".csv",
    ".json",
    ".yaml",
    ".yml",
    ".js",
    ".ts",
    ".css",
})
_PDF_FALLBACK_EXTENSIONS = frozenset({".md", ".html"})
_PDF_RENDER_SOURCE_EXTENSIONS = frozenset({".md", ".markdown", ".html", ".htm"})
_PPTX_FALLBACK_EXTENSIONS = frozenset({".md", ".html"})
_PPTX_REQUIRED_ZIP_ENTRIES = frozenset({
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
})
_PPTX_MIN_BYTES = 1024
_PPTX_IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
_HTML_FALLBACK_MIN_BYTES = 128
_PDF_VISUAL_FALLBACK_MARKERS = (
    "chart",
    "charts",
    "diagram",
    "diagrams",
    "visual",
    "visuals",
    "visualization",
    "visualisation",
    "infographic",
    "layout",
    "image",
    "images",
)
_VISUAL_REQUEST_MARKERS = _PDF_VISUAL_FALLBACK_MARKERS + (
    "flowchart",
    "timeline",
    "matrix",
    "quadrant",
    "concept map",
)
_VISUAL_DESIGN_SKILL_PATH_MARKERS = (
    "/skills/public/visual-design/SKILL.md",
    "/mnt/skills/public/visual-design/SKILL.md",
    "/skills/visual-design/SKILL.md",
    "/mnt/skills/visual-design/SKILL.md",
)
_VISUAL_ASSET_TOOL_NAMES = frozenset({"generate_visual_asset"})
_VISUAL_ASSET_EXTENSIONS = frozenset({".svg", ".png", ".jpg", ".jpeg", ".webp"})
_WRITE_ERROR_CLASS_MARKERS = (
    ("missing_thread_id", ("thread id not available", "nonetype' object has no attribute 'get")),
    ("missing_thread_data", ("thread data not available", "no allowed local sandbox directories")),
    ("sandbox_not_found", ("sandbox with id", "sandbox not found")),
    ("sandbox_runtime", ("sandbox",)),
    ("path_traversal", ("path traversal", "access denied")),
    ("permission_denied", ("permission denied",)),
    ("path_is_directory", ("path is a directory",)),
    ("write_os_error", ("failed to write file",)),
    ("unexpected_write_error", ("unexpected error writing file",)),
)


def _merge_builder_write_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)
    merged = dict(current)
    for key, value in update.items():
        _merge_builder_write_diagnostic_value(merged, key, value)
    return merged


def _merge_builder_write_diagnostic_value(
    merged: dict, key: str, value: object
) -> None:
    if key in {"success_count", "error_count"} and isinstance(value, int):
        merged[key] = int(merged.get(key, 0) or 0) + value
        return
    if key in {"successful_output_paths", "successful_deliverable_output_paths"} and isinstance(value, list):
        merged[key] = _merge_string_list(merged.get(key), value)
        return
    merged[key] = value


def _merge_string_list(current: object, update: list) -> list[str]:
    seen = {str(item): None for item in current if isinstance(item, str)} if isinstance(current, list) else {}
    for item in update:
        if isinstance(item, str):
            seen[item] = None
    return list(seen)


def _merge_builder_pptx_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)
    merged = dict(current)
    for key, value in update.items():
        _merge_builder_pptx_diagnostic_value(merged, key, value)
    return merged


def _merge_builder_pptx_diagnostic_value(merged: dict, key: str, value: object) -> None:
    if (key.endswith("_count") or key.endswith("_bytes_total")) and isinstance(value, int):
        merged[key] = int(merged.get(key, 0) or 0) + value
        return
    if key in {"image_output_paths", "pptx_output_paths"} and isinstance(value, list):
        merged[key] = _merge_string_list(merged.get(key), value)
        return
    merged[key] = value


def _merge_builder_visual_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)
    merged = dict(current)
    for key, value in update.items():
        if (key.endswith("_count") or key.endswith("_bytes_total")) and isinstance(value, int):
            merged[key] = int(merged.get(key, 0) or 0) + value
            continue
        if key in {"visual_asset_paths", "visual_svg_paths", "visual_png_paths"} and isinstance(value, list):
            merged[key] = _merge_string_list(merged.get(key), value)
            continue
        merged[key] = value
    return merged


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):].lstrip("/")
    if not relative:
        return None

    # Reject path traversal so emit verification/mirroring cannot resolve
    # outside the outputs root (e.g. "/mnt/user-data/outputs/../../etc/passwd").
    relative_path = PurePosixPath(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return None
    return relative_path.as_posix()


def _upload_builder_outputs_to_supabase(
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> None:
    """Best-effort upload of the builder's outputs to Supabase Storage.

    PR-E (Phase 2.2): delegates to ``maybe_mirror_file`` which uses SHA-256
    hash deduplication. Files that were already mirrored at write time by
    the tool hooks are skipped automatically. Any failure is logged and
    swallowed so builder flow never regresses.
    """
    if not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping Supabase upload; missing thread_id=%s outputs_host_path=%s",
            thread_id,
            outputs_host_path,
        )
        return

    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    outputs_root = Path(outputs_host_path)
    for candidate in candidates:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        maybe_mirror_file(str(host_file), thread_id, outputs_host_path)


def _outputs_host_path_from_state(state: dict[str, Any]) -> str | None:
    thread_data = state.get("thread_data") or {}
    return thread_data.get("outputs_path") if isinstance(thread_data, dict) else None


def _outputs_root_from_state(state: dict[str, Any]) -> Path | None:
    outputs_host_path = _outputs_host_path_from_state(state)
    if not outputs_host_path:
        return None
    outputs_root = Path(outputs_host_path)
    return outputs_root if outputs_root.is_dir() else None


def _builder_started_min_mtime(state: dict[str, Any]) -> float | None:
    started_ms = state.get("builder_task_started_at_ms")
    if isinstance(started_ms, (int, float)) and started_ms > 0:
        return (float(started_ms) / 1000.0) - 5.0
    return None


def _is_recovery_candidate(entry: Path, *, requested_suffix: str, min_mtime: float | None) -> bool:
    if not entry.is_file() or entry.name.startswith((".", "_")):
        return False
    if requested_suffix and entry.suffix.lower() != requested_suffix:
        return False
    return min_mtime is None or entry.stat().st_mtime >= min_mtime


def _is_fresh_pdf_output(entry: Path, min_mtime: float | None) -> bool:
    if not _is_public_output_file(entry):
        return False
    if entry.suffix.lower() != ".pdf":
        return False
    return min_mtime is None or entry.stat().st_mtime >= min_mtime


def _is_public_output_file(entry: Path) -> bool:
    if not entry.is_file():
        return False
    return not entry.name.startswith((".", "_"))


def _output_tree_has_fresh_pdf(outputs_root: Path, min_mtime: float | None) -> bool:
    for entry in outputs_root.rglob("*"):
        if _is_fresh_pdf_output(entry, min_mtime):
            return True
    return False


def _output_tree_has_completion_candidate(
    outputs_root: Path,
    state: dict[str, Any],
    min_mtime: float | None,
) -> bool:
    for entry in outputs_root.rglob("*"):
        if _is_completion_output_candidate(entry, state, min_mtime):
            return True
    return False


def _is_completion_output_candidate(
    entry: Path,
    state: dict[str, Any],
    min_mtime: float | None,
) -> bool:
    if not _is_public_output_file(entry):
        return False
    if min_mtime is not None and entry.stat().st_mtime < min_mtime:
        return False
    if _completion_candidate_integrity_error(entry, state) is not None:
        return False
    return _output_suffix_allowed_for_request(entry.suffix.lower(), state)


def _completion_candidate_integrity_error(entry: Path, state: dict[str, Any]) -> str | None:
    suffix = entry.suffix.lower()
    if suffix == ".pptx":
        return _log_completion_candidate_integrity_error(
            entry,
            ext="pptx",
            reason=_pptx_integrity_error_for_file(entry),
        )
    if _requested_pptx_artifact(state) and suffix in {".html", ".htm"}:
        return _log_completion_candidate_integrity_error(
            entry,
            ext="html",
            reason=_html_fallback_integrity_error_for_file(entry),
            requested_ext="pptx",
        )
    return None


def _log_completion_candidate_integrity_error(
    entry: Path,
    *,
    ext: str,
    reason: str | None,
    requested_ext: str | None = None,
) -> str | None:
    if reason is None:
        return None
    requested = f" requested_ext={requested_ext}" if requested_ext else ""
    logger.warning(
        "BuilderArtifact: artifact_integrity ext=%s valid=false reason=%s "
        "bytes=%s source=outputs_scan%s",
        ext,
        reason,
        entry.stat().st_size,
        requested,
    )
    return reason


def _output_suffix_allowed_for_request(suffix: str, state: dict[str, Any]) -> bool:
    if _requested_pdf_artifact(state):
        return suffix in _allowed_pdf_artifact_suffixes(state)
    if _requested_pptx_artifact(state):
        return suffix in _allowed_pptx_artifact_suffixes(state)
    return True


def _is_promotable_candidate_path(
    path: Path,
    *,
    min_mtime: float | None,
    requested_pdf: bool = False,
    requested_pptx: bool,
) -> bool:
    if not _is_recent_promotable_path(path, min_mtime):
        return False
    if path.suffix.lower() == ".pptx":
        return _pptx_integrity_error_for_file(path) is None
    if requested_pdf and path.suffix.lower() in {".html", ".htm"}:
        return _html_fallback_integrity_error_for_file(path) is None
    if requested_pptx and path.suffix.lower() in {".html", ".htm"}:
        return _html_fallback_integrity_error_for_file(path) is None
    return True


def _is_recent_promotable_path(path: Path, min_mtime: float | None) -> bool:
    return (
        path.is_file()
        and not path.name.startswith("_")
        and path.suffix.lower() in _PROMOTABLE_DELIVERABLE_EXTENSIONS
        and (min_mtime is None or path.stat().st_mtime >= min_mtime)
    )


def _emit_candidate_paths(artifact_args: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str) and primary.strip():
        candidates.append(primary.strip())
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(
            path for path in supporting
            if isinstance(path, str) and path.strip()
        )
    return candidates


def _invalid_outputs_candidate(candidate: str) -> bool:
    return candidate.strip().startswith(_OUTPUTS_VIRTUAL_PREFIX)


def _local_emit_candidate_status(
    candidate: str,
    relative: str,
    outputs_host_path: str | None,
) -> str:
    if not outputs_host_path:
        return "missing"
    host_file = Path(outputs_host_path) / relative
    if not host_file.is_file():
        return "missing"
    if PurePosixPath(candidate).suffix.lower() == ".pptx":
        return _local_pptx_candidate_status(host_file)
    return "valid"


def _local_pptx_candidate_status(host_file: Path) -> str:
    reason = _pptx_integrity_error_for_file(host_file)
    if reason is not None:
        logger.warning(
            "BuilderArtifact: artifact_integrity ext=pptx valid=false "
            "reason=%s bytes=%s source=local",
            reason,
            host_file.stat().st_size,
        )
        return "invalid"
    logger.info(
        "BuilderArtifact: artifact_integrity ext=pptx valid=true bytes=%s source=local",
        host_file.stat().st_size,
    )
    return "valid"


def _remote_emit_candidate_status(
    candidate: str,
    relative: str,
    remote_thread_ids: list[str],
) -> str:
    if not remote_thread_ids:
        return "missing"
    if PurePosixPath(candidate).suffix.lower() == ".pptx":
        return _remote_pptx_candidate_status(relative, remote_thread_ids)
    if any(supabase_artifact_store.check_artifact_exists(thread_id, relative) for thread_id in remote_thread_ids):
        return "valid"
    return "missing"


def _remote_pptx_candidate_status(relative: str, remote_thread_ids: list[str]) -> str:
    for thread_id in remote_thread_ids:
        result = _download_pptx_candidate(thread_id, relative, remote_thread_ids[0])
        if result is None:
            continue
        content, _mime = result
        reason = _pptx_integrity_error_for_bytes(content)
        if reason is not None:
            logger.warning(
                "BuilderArtifact: artifact_integrity ext=pptx valid=false "
                "reason=%s bytes=%s source=supabase",
                reason,
                len(content),
            )
            return "invalid"
        logger.info(
            "BuilderArtifact: artifact_integrity ext=pptx valid=true bytes=%s source=supabase",
            len(content),
        )
        return "valid"
    return "missing"


def _download_pptx_candidate(thread_id: str, relative: str, primary_thread_id: str):
    try:
        return supabase_artifact_store.download_artifact(thread_id, relative)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "BuilderArtifact: pptx remote integrity check failed "
            "error_type=%s thread_role=%s",
            exc.__class__.__name__,
            "parent" if thread_id == primary_thread_id else "fallback",
        )
        return None


def _log_missing_emit_candidate(
    candidate: str,
    relative: str,
    outputs_host_path: str | None,
    remote_thread_ids: list[str],
) -> None:
    logger.warning(
        "BuilderArtifact: file missing for emit verification: path=%s local=%s supabase=%s",
        candidate,
        bool(outputs_host_path and (Path(outputs_host_path) / relative).is_file()),
        bool(
            any(
                supabase_artifact_store.check_artifact_exists(thread_id, relative)
                for thread_id in remote_thread_ids
            )
        ),
    )


def _emit_candidate_verified(
    candidate: str,
    *,
    outputs_host_path: str | None,
    remote_thread_ids: list[str],
) -> bool:
    relative = _extract_output_relative_path(candidate)
    if relative is None:
        if _invalid_outputs_candidate(candidate):
            logger.warning(
                "BuilderArtifact: rejecting invalid outputs artifact path=%s",
                candidate,
            )
            return False
        return True

    local_status = _local_emit_candidate_status(candidate, relative, outputs_host_path)
    if local_status == "valid":
        return True
    if local_status == "invalid":
        return False

    remote_status = _remote_emit_candidate_status(candidate, relative, remote_thread_ids)
    if remote_status == "valid":
        return True
    if remote_status == "invalid":
        return False

    _log_missing_emit_candidate(candidate, relative, outputs_host_path, remote_thread_ids)
    return False


def _is_user_facing_output_path(artifact_path: str | None) -> bool:
    relative = _extract_output_relative_path(artifact_path)
    if relative is None:
        return False
    name = PurePosixPath(relative).name
    if not name or name.startswith((".", "_")):
        return False
    return PurePosixPath(relative).suffix.lower() in _PROMOTABLE_DELIVERABLE_EXTENSIONS


def _requested_target_suffix(state: dict[str, Any]) -> str:
    target = state.get("builder_artifact_target_path")
    if not isinstance(target, str):
        delegation = state.get("delegation_context")
        target = delegation.get("artifact_target_path") if isinstance(delegation, dict) else None
    if not isinstance(target, str):
        return ""
    return PurePosixPath(target.strip()).suffix.lower()


def _requested_pdf_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) == ".pdf"


def _requested_pptx_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) == ".pptx"


def _requested_office_artifact(state: dict[str, Any]) -> bool:
    return _requested_target_suffix(state) in {".pptx", ".docx", ".xlsx"}


def _requested_task_text(state: dict[str, Any]) -> str:
    parts = _delegation_task_text_parts(state) + _state_task_text_parts(state)
    return "\n".join(parts).lower()


def _delegation_task_text_parts(state: dict[str, Any]) -> list[str]:
    delegation = state.get("delegation_context")
    if not isinstance(delegation, dict):
        return []
    keys = ("task", "task_description", "description", "original_task", "task_type")
    return [value for key in keys if isinstance((value := delegation.get(key)), str)]


def _state_task_text_parts(state: dict[str, Any]) -> list[str]:
    keys = ("task", "task_description", "builder_task_description")
    return [value for key in keys if isinstance((value := state.get(key)), str)]


def _pdf_fallback_suffix(state: dict[str, Any]) -> str:
    task_text = _requested_task_text(state)
    if any(marker in task_text for marker in _PDF_VISUAL_FALLBACK_MARKERS):
        return ".html"
    return ".md"


def _allowed_pdf_artifact_suffixes(state: dict[str, Any]) -> frozenset[str]:
    return frozenset({".pdf", _pdf_fallback_suffix(state)})


def _pptx_fallback_suffix(state: dict[str, Any]) -> str:
    task_text = _requested_task_text(state)
    if any(marker in task_text for marker in _PDF_VISUAL_FALLBACK_MARKERS):
        return ".html"
    return ".md"


def _allowed_pptx_artifact_suffixes(state: dict[str, Any]) -> frozenset[str]:
    return frozenset({".pptx", _pptx_fallback_suffix(state)})


def _runtime_thread_id(runtime: Runtime | None) -> str | None:
    context = getattr(runtime, "context", None)
    if isinstance(context, dict) and isinstance(context.get("thread_id"), str):
        return context["thread_id"]
    config = getattr(runtime, "config", None)
    configurable = config.get("configurable") if isinstance(config, dict) else None
    if isinstance(configurable, dict) and isinstance(configurable.get("thread_id"), str):
        return configurable["thread_id"]
    return None


def _artifact_remote_thread_ids(state: dict[str, Any], runtime: Runtime | None) -> list[str]:
    ids: list[str] = []
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        parent = delegation.get("parent_thread_id")
        if isinstance(parent, str) and parent:
            ids.append(parent)
    runtime_thread_id = _runtime_thread_id(runtime)
    if runtime_thread_id:
        ids.append(runtime_thread_id)
    deduped: list[str] = []
    for thread_id in ids:
        if thread_id not in deduped:
            deduped.append(thread_id)
    return deduped


def _pptx_integrity_error_for_bytes(content: bytes) -> str | None:
    if len(content) < _PPTX_MIN_BYTES:
        return "pptx_too_small"
    try:
        from io import BytesIO

        with zipfile.ZipFile(BytesIO(content)) as archive:
            entries = set(archive.namelist())
    except zipfile.BadZipFile:
        return "pptx_not_zip"
    missing = sorted(_PPTX_REQUIRED_ZIP_ENTRIES - entries)
    if missing:
        return f"pptx_missing_entries:{','.join(missing)}"
    return None


def _pptx_integrity_error_for_file(path: Path) -> str | None:
    try:
        size = path.stat().st_size
    except OSError:
        return "pptx_stat_failed"
    if size < _PPTX_MIN_BYTES:
        return "pptx_too_small"
    try:
        with zipfile.ZipFile(path) as archive:
            entries = set(archive.namelist())
    except zipfile.BadZipFile:
        return "pptx_not_zip"
    except OSError:
        return "pptx_read_failed"
    missing = sorted(_PPTX_REQUIRED_ZIP_ENTRIES - entries)
    if missing:
        return f"pptx_missing_entries:{','.join(missing)}"
    return None


def _html_fallback_integrity_error_for_text(content: str) -> str | None:
    stripped = content.lstrip("\ufeff \t\r\n")
    lowered = stripped[:512].lower()
    if len(content.encode("utf-8", errors="ignore")) < _HTML_FALLBACK_MIN_BYTES:
        return "html_too_small"
    if lowered.startswith("```"):
        return "html_markdown_fence"
    if lowered.startswith("&lt;!doctype") or lowered.startswith("&lt;html"):
        return "html_escaped"
    if "<html" not in lowered and "<!doctype html" not in lowered:
        return "html_missing_document_root"
    if "<body" not in content.lower():
        return "html_missing_body"
    return None


def _html_fallback_integrity_error_for_bytes(content: bytes) -> str | None:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return "html_not_utf8"
    return _html_fallback_integrity_error_for_text(text)


def _html_fallback_integrity_error_for_file(path: Path) -> str | None:
    if path.name.startswith(("_", ".")) or path.name.lower().startswith(("test_", "test-")):
        return "html_internal_filename"
    try:
        return _html_fallback_integrity_error_for_bytes(path.read_bytes())
    except OSError:
        return "html_read_failed"


def _requested_artifact_ext(state: dict[str, Any]) -> str | None:
    suffix = _requested_target_suffix(state).lstrip(".")
    return suffix or None


def _artifact_ext_from_path(path: Any) -> str | None:
    suffix = PurePosixPath(str(path or "")).suffix.lower().lstrip(".")
    return suffix or None


def _apply_edit_context_metadata(artifact: dict[str, Any], state: dict[str, Any]) -> None:
    delegation = state.get("delegation_context")
    edit_context = delegation.get("edit_context") if isinstance(delegation, dict) else None
    if not isinstance(edit_context, dict) or edit_context.get("mode") != "edit_existing_artifact":
        return
    source_path = edit_context.get("source_artifact_path")
    if not isinstance(source_path, str) or not source_path.strip():
        return
    artifact.setdefault("source_artifact_path", source_path)
    artifact.setdefault("revision_of_artifact_path", source_path)


def _apply_artifact_request_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
    *,
    fallback_reason: str | None = None,
) -> dict[str, Any]:
    requested_ext = _requested_artifact_ext(state)
    artifact_ext = _artifact_ext_from_path(artifact.get("artifact_path"))
    _apply_edit_context_metadata(artifact, state)
    if requested_ext:
        artifact["requested_artifact_ext"] = requested_ext
    if artifact_ext:
        artifact["artifact_ext"] = artifact_ext
        if requested_ext == "pptx" and artifact_ext in {"html", "htm"}:
            artifact["artifact_type"] = "webpage"
    if _artifact_is_extension_fallback(requested_ext, artifact_ext):
        artifact["artifact_is_fallback"] = True
        artifact["fallback_reason"] = _artifact_fallback_reason(artifact, requested_ext, fallback_reason)
    elif fallback_reason:
        artifact["fallback_reason"] = fallback_reason
    elif requested_ext:
        artifact.setdefault("artifact_is_fallback", False)
    image_status, image_reason = _image_generation_metadata_from_state(state)
    if image_status:
        artifact["image_generation_status"] = image_status
        if image_reason:
            artifact["image_generation_reason"] = image_reason
        else:
            artifact.pop("image_generation_reason", None)
    return artifact


def _artifact_is_extension_fallback(requested_ext: str | None, artifact_ext: str | None) -> bool:
    return bool(requested_ext and artifact_ext and artifact_ext != requested_ext)


def _artifact_fallback_reason(
    artifact: dict[str, Any],
    requested_ext: str | None,
    fallback_reason: str | None,
) -> str | None:
    return fallback_reason or artifact.get("fallback_reason") or (
        f"{requested_ext}_generation_not_completed" if requested_ext else None
    )


def _pptx_artifact_path_rejection_reason(path: Any, state: dict[str, Any]) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return "pptx_artifact_path_not_under_outputs"
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix not in _allowed_pptx_artifact_suffixes(state):
        return f"pptx_invalid_artifact_extension:{suffix or 'none'}"
    return None


def _pptx_html_fallback_integrity_rejection_reason(
    canonical: str,
    state: dict[str, Any],
    runtime: Runtime,
) -> str | None:
    suffix = PurePosixPath(canonical).suffix.lower()
    if not _requested_pptx_artifact(state) or suffix not in {".html", ".htm"}:
        return None
    relative = _extract_output_relative_path(canonical)
    if relative is None:
        return "pptx_html_fallback_not_under_outputs"
    outputs_host_path = _outputs_host_path_from_state(state)
    if outputs_host_path:
        host_file = Path(outputs_host_path) / relative
        if host_file.is_file():
            reason = _html_fallback_integrity_error_for_file(host_file)
            if reason is not None:
                return reason
            return None
    for thread_id in _artifact_remote_thread_ids(state, runtime):
        try:
            result = supabase_artifact_store.download_artifact(thread_id, relative)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: html fallback remote integrity check failed error_type=%s",
                exc.__class__.__name__,
            )
            continue
        if result is not None:
            content, _mime = result
            return _html_fallback_integrity_error_for_bytes(content)
    return "html_fallback_missing"


def _pptx_path_integrity_rejection_reason(
    canonical: str,
    state: dict[str, Any],
    runtime: Runtime,
) -> str | None:
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix != ".pptx":
        return None
    relative = _extract_output_relative_path(canonical)
    if relative is None:
        return "pptx_artifact_path_not_under_outputs"
    thread_data = state.get("thread_data") or {}
    outputs_host_path = thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
    if outputs_host_path:
        host_file = Path(outputs_host_path) / relative
        if host_file.is_file():
            return _pptx_integrity_error_for_file(host_file)
    for thread_id in _artifact_remote_thread_ids(state, runtime):
        try:
            result = supabase_artifact_store.download_artifact(thread_id, relative)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: pptx remote integrity check failed error_type=%s",
                exc.__class__.__name__,
            )
            continue
        if result is not None:
            content, _mime = result
            return _pptx_integrity_error_for_bytes(content)
    return None


def _render_markdown_to_pdf_attempted(state: dict[str, Any]) -> bool:
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(
        any(name in _PDF_CREATION_TOOL_NAMES for name in (summary.get("tool_names") or []))
        for summary in summaries
        if isinstance(summary, dict)
    )


def _simple_pdf_writer_attempted(state: dict[str, Any]) -> bool:
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(
        _SIMPLE_PDF_TOOL_NAME in (summary.get("tool_names") or [])
        for summary in summaries
        if isinstance(summary, dict)
    )


def _requested_simple_pdf_artifact(state: dict[str, Any]) -> bool:
    if not _requested_pdf_artifact(state):
        return False
    task_text = _requested_task_text(state)
    if not task_text:
        return False
    if "product review" in task_text and "pdf" in task_text:
        return True
    return any(marker in task_text for marker in _SIMPLE_PDF_REQUEST_MARKERS)


def _successful_pdf_render_result(state: dict[str, Any]) -> dict[str, Any] | None:
    result = state.get("builder_pdf_render_result")
    if not isinstance(result, dict) or result.get("success") is not True:
        return None
    pdf_path = result.get("pdf_path")
    if not isinstance(pdf_path, str) or not pdf_path.strip():
        return None
    return result


def _pdf_render_layout_quality(state: dict[str, Any]) -> str:
    result = _successful_pdf_render_result(state) or {}
    return str(result.get("layout_quality") or "unknown")


def _pdf_layout_repair_attempts(state: dict[str, Any]) -> int:
    return int(state.get("builder_pdf_layout_repair_attempts", 0) or 0)


def _pdf_layout_repair_needed(state: dict[str, Any]) -> bool:
    quality = _pdf_render_layout_quality(state)
    return quality in {"warning", "unusable"} and _pdf_layout_repair_attempts(state) < 1


def _pdf_render_unusable_after_repair(state: dict[str, Any]) -> bool:
    return _pdf_render_layout_quality(state) == "unusable" and _pdf_layout_repair_attempts(state) >= 1


def _successful_pdf_ready_to_emit(state: dict[str, Any]) -> bool:
    result = _successful_pdf_render_result(state)
    if result is None:
        return False
    if _pdf_layout_repair_needed(state):
        return False
    if _pdf_render_unusable_after_repair(state):
        return False
    return _canonical_outputs_artifact_path(result.get("pdf_path")) is not None


def _pdf_layout_repair_message(result: dict[str, Any]) -> str:
    page_count = result.get("page_count")
    blank_count = result.get("blank_page_count")
    short_count = result.get("short_page_count")
    warning = result.get("layout_warning") or "layout_quality_warning"
    return (
        "[Sophia/PDF layout repair]\n"
        "The PDF rendered successfully, but the layout quality check found a sparse document. "
        f"Metrics: page_count={page_count}, blank_page_count={blank_count}, "
        f"short_page_count={short_count}, warning={warning}. Target length is 10-15 pages "
        "when the user did not ask for a longer PDF.\n\n"
        "Revise the Markdown source once: compact sparse tables or continuation pages, remove "
        "unnecessary page breaks, combine thin sections, then call render_markdown_to_pdf again. "
        "After this single repair pass, emit the best PDF rather than looping."
    )


def _canonical_outputs_artifact_path(path: Any) -> str | None:
    candidate = _stripped_artifact_path(path)
    if candidate is None:
        return None
    if candidate.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return _valid_prefixed_output_path(candidate)
    return _plain_output_artifact_path(candidate)


def _stripped_artifact_path(path: Any) -> str | None:
    if not isinstance(path, str) or not path.strip():
        return None
    return path.strip()


def _valid_prefixed_output_path(candidate: str) -> str | None:
    return candidate if _extract_output_relative_path(candidate) is not None else None


def _plain_output_artifact_path(candidate: str) -> str | None:
    return f"{_OUTPUTS_VIRTUAL_PREFIX}{candidate}" if _is_plain_output_filename(candidate) else None


def _is_plain_output_filename(candidate: str) -> bool:
    pure = PurePosixPath(candidate)
    return (
        not pure.is_absolute()
        and ".." not in pure.parts
        and "/" not in candidate
        and "\\" not in candidate
    )


def _pdf_artifact_path_rejection_reason(path: Any, state: dict[str, Any]) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return "pdf_artifact_path_not_under_outputs"
    return _pdf_artifact_suffix_rejection_reason(canonical, state)


def _pdf_artifact_suffix_rejection_reason(canonical: str, state: dict[str, Any]) -> str | None:
    suffix = PurePosixPath(canonical).suffix.lower()
    if suffix not in _allowed_pdf_artifact_suffixes(state):
        return f"pdf_invalid_artifact_extension:{suffix or 'none'}"
    return _pdf_fallback_rejection_reason(suffix, state)


def _pdf_fallback_rejection_reason(suffix: str, state: dict[str, Any]) -> str | None:
    if suffix in _PDF_FALLBACK_EXTENSIONS and not _render_markdown_to_pdf_attempted(state):
        return "pdf_fallback_before_render_attempt"
    return None


def _pdf_source_candidate_paths(state: dict[str, Any]) -> list[Path]:
    outputs_root = _outputs_root_from_state(state)
    if outputs_root is None:
        return []
    min_mtime = _builder_started_min_mtime(state)
    try:
        candidates = [
            entry for entry in outputs_root.rglob("*")
            if _is_recent_promotable_path(entry, min_mtime)
            and entry.suffix.lower() in _PDF_RENDER_SOURCE_EXTENSIONS
            and (
                entry.suffix.lower() not in {".html", ".htm"}
                or _html_fallback_integrity_error_for_file(entry) is None
            )
        ]
    except OSError:
        logger.debug(
            "BuilderArtifact: pdf source scan failed outputs_path=%s",
            _outputs_host_path_from_state(state),
            exc_info=True,
        )
        return []
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates


def _preferred_pdf_render_source_path(state: dict[str, Any]) -> str | None:
    candidates = _pdf_source_candidate_paths(state)
    if not candidates:
        return None
    target = BuilderArtifactMiddleware._target_artifact_path(state)
    target_stem = Path(target or "").stem
    if target_stem:
        for candidate in candidates:
            if candidate.stem == target_stem:
                return BuilderArtifactMiddleware._virtual_output_path(candidate, state)
    return BuilderArtifactMiddleware._virtual_output_path(candidates[0], state)


def _pdf_render_target_path(state: dict[str, Any], source_path: str | None) -> str:
    target = BuilderArtifactMiddleware._target_artifact_path(state)
    if isinstance(target, str) and PurePosixPath(target).suffix.lower() == ".pdf":
        return target
    source = _canonical_outputs_artifact_path(source_path)
    if source:
        relative = PurePosixPath(source.removeprefix(_OUTPUTS_VIRTUAL_PREFIX))
        return f"{_OUTPUTS_VIRTUAL_PREFIX}{relative.with_suffix('.pdf').as_posix()}"
    return f"{_OUTPUTS_VIRTUAL_PREFIX}build.pdf"


def _pdf_render_attempt_missing(state: dict[str, Any]) -> bool:
    if not _requested_pdf_artifact(state):
        return False
    return not _render_markdown_to_pdf_attempted(state)


def _artifact_path_suffix_label(path: object) -> str | None:
    return PurePosixPath(str(path or "")).suffix.lower().lstrip(".") or None


def _recovery_hint(outputs_root: Path, candidates: list[Path]) -> str:
    logger.info(
        "BuilderArtifact: emit_path_missing recovery_candidate_count=%s recovery_accepted=%s",
        len(candidates),
        len(candidates) == 1,
    )
    if len(candidates) != 1:
        return ""
    recovered = candidates[0].relative_to(outputs_root).as_posix()
    return (
        " I found exactly one plausible output candidate in the artifact "
        f"directory: `{_OUTPUTS_VIRTUAL_PREFIX}{recovered}`. If that is the "
        "intended deliverable, call emit_builder_artifact again with that exact path."
    )


def _first_research_tool_index(tool_names: list[str]) -> int:
    indexes = [
        index
        for index, name in enumerate(tool_names)
        if name in _BUILDER_RESEARCH_TOOL_NAMES
    ]
    return indexes[0] if indexes else len(tool_names) + 1


def _first_write_tool_index(tool_names: list[str]) -> int:
    indexes = [
        index
        for index, name in enumerate(tool_names)
        if name in _BUILDER_WRITE_TOOL_NAMES
    ]
    return indexes[0] if indexes else len(tool_names) + 1


def _diagnostic_int(diagnostics: dict[str, Any], key: str) -> int:
    return int(diagnostics.get(key, 0) or 0)


def _diagnostic_counts(diagnostics: dict[str, Any]) -> tuple[int, int, int]:
    return (
        _diagnostic_int(diagnostics, "builder_web_search_count"),
        _diagnostic_int(diagnostics, "builder_web_fetch_count"),
        _diagnostic_int(diagnostics, "write_file_count"),
    )


def _is_safe_pre_research_bash(command: Any) -> bool:
    """Return whether a bash command is read-only inspection."""
    if not isinstance(command, str) or not command.strip():
        return False
    if _BASH_WRITE_MARKER_RE.search(command):
        return False
    return bool(_SAFE_BASH_COMMAND_RE.search(command))


def _should_warn_missing_web_tools(
    *,
    phase: str,
    allow_web_research: bool,
    search_count: int,
    fetch_count: int,
    write_file_count: int,
) -> bool:
    return (
        allow_web_research
        and (phase == "completion" or write_file_count > 0)
        and search_count + fetch_count == 0
    )


def _write_tool_names(tool_names: list[str]) -> list[str]:
    return [name for name in tool_names if name in _BUILDER_WRITE_TOOL_NAMES]


def _builder_web_attempt_count(state: dict[str, Any]) -> int:
    budget = state.get("builder_web_budget") or {}
    if not isinstance(budget, dict):
        return 0
    return int(budget.get("search_calls", 0) or 0) + int(budget.get("fetch_calls", 0) or 0)


def _builder_web_call_count(state: dict[str, Any], key: str) -> int:
    budget = state.get("builder_web_budget") or {}
    if not isinstance(budget, dict):
        return 0
    return int(budget.get(f"{key}_calls", 0) or 0)


def _has_builder_search_source(state: dict[str, Any]) -> bool:
    sources = state.get("builder_search_sources") or []
    return any(isinstance(source, dict) and source.get("url") for source in sources)


def _has_fetchable_builder_source(state: dict[str, Any]) -> bool:
    allowed = state.get("builder_allowed_urls") or []
    sources = state.get("builder_search_sources") or []
    return any(str(url).strip() for url in allowed) or any(
        isinstance(source, dict) and source.get("url") for source in sources
    )


def _builder_task_needs_fetch(state: dict[str, Any]) -> bool:
    if _requested_pdf_artifact(state):
        return True
    delegation = state.get("delegation_context")
    task_type = delegation.get("task_type") if isinstance(delegation, dict) else None
    return str(task_type or "").lower() in {"document", "research", "visual_report"}


def _needs_fetch_before_write(state: dict[str, Any]) -> bool:
    if not _builder_task_needs_fetch(state):
        return False
    if _builder_web_call_count(state, "fetch") > 0:
        return False
    return _builder_web_call_count(state, "search") > 0 and _has_fetchable_builder_source(state)


def _pptx_skill_read_seen(state: dict[str, Any]) -> bool:
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(
        bool(summary.get("pptx_skill_read"))
        for summary in summaries
        if isinstance(summary, dict)
    )


def _pptx_diagnostics(state: dict[str, Any]) -> dict[str, Any]:
    diagnostics = state.get("builder_pptx_diagnostics")
    return diagnostics if isinstance(diagnostics, dict) else {}


def _pptx_diagnostic_count(state: dict[str, Any], key: str) -> int:
    value = _pptx_diagnostics(state).get(key)
    return int(value or 0) if isinstance(value, int) else 0


def _pptx_generator_invoked_seen(state: dict[str, Any]) -> bool:
    if _pptx_diagnostic_count(state, "pptx_generator_attempt_count") > 0:
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(
        bool(summary.get("pptx_generator_invoked"))
        for summary in summaries
        if isinstance(summary, dict)
    )


def _pptx_fallback_generation_attempt_satisfied(state: dict[str, Any]) -> bool:
    attempts = _pptx_diagnostic_count(state, "pptx_generator_attempt_count")
    if attempts <= 0:
        summaries = state.get("builder_tool_turn_summaries") or []
        return any(
            bool(summary.get("pptx_generator_invoked"))
            for summary in summaries
            if isinstance(summary, dict)
        )
    diagnostics = _pptx_diagnostics(state)
    if diagnostics.get("pptx_generator_error_class") == "invalid_plan_json" and attempts < 2:
        return False
    return True


def _image_generation_invoked_seen(state: dict[str, Any]) -> bool:
    if _pptx_diagnostic_count(state, "image_generation_attempt_count") > 0:
        return True
    summaries = state.get("builder_tool_turn_summaries") or []
    return any(
        bool(summary.get("image_generation_invoked"))
        for summary in summaries
        if isinstance(summary, dict)
    )


def _command_parts(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _command_flag_value(command: str, flag: str) -> str | None:
    parts = _command_parts(command)
    for index, part in enumerate(parts):
        if part == flag and index + 1 < len(parts):
            return parts[index + 1]
        if part.startswith(flag + "="):
            return part.split("=", 1)[1]
    return None


def _command_flag_values(command: str, flag: str) -> list[str]:
    parts = _command_parts(command)
    values: list[str] = []
    collect = False
    for part in parts:
        if collect:
            if part.startswith("--"):
                collect = False
            else:
                values.append(part)
                continue
        if part == flag:
            collect = True
            continue
        if part.startswith(flag + "="):
            values.append(part.split("=", 1)[1])
    return values


def _empty_pptx_skill_flags() -> dict[str, Any]:
    return {
        "pptx_skill_read": False,
        "pptx_generator_invoked": False,
        "image_generation_invoked": False,
        "image_output_paths": [],
        "pptx_output_paths": [],
    }


def _pptx_skill_flags_for_read(args: dict[str, Any]) -> dict[str, Any]:
    flags = _empty_pptx_skill_flags()
    path = str(args.get("path") or args.get("file_path") or "")
    flags["pptx_skill_read"] = any(marker in path for marker in _PPTX_SKILL_PATH_MARKERS)
    return flags


def _pptx_skill_flags_for_bash(args: dict[str, Any]) -> dict[str, Any]:
    flags = _empty_pptx_skill_flags()
    command = str(args.get("command") or "")
    command_invokes_generator = any(marker in command for marker in _PPTX_GENERATOR_PATH_MARKERS)
    command_invokes_image = any(marker in command for marker in _IMAGE_GENERATION_PATH_MARKERS)
    flags["pptx_generator_invoked"] = command_invokes_generator
    flags["image_generation_invoked"] = command_invokes_image
    output_path = _command_flag_value(command, "--output-file")
    if output_path and command_invokes_image:
        flags["image_output_paths"] = [output_path]
    if output_path and command_invokes_generator:
        flags["pptx_output_paths"] = [output_path]
    return flags


def _merge_pptx_skill_flags(current: dict[str, Any], update: dict[str, Any]) -> None:
    current["pptx_skill_read"] = bool(current["pptx_skill_read"] or update.get("pptx_skill_read"))
    current["pptx_generator_invoked"] = bool(
        current["pptx_generator_invoked"] or update.get("pptx_generator_invoked")
    )
    current["image_generation_invoked"] = bool(
        current["image_generation_invoked"] or update.get("image_generation_invoked")
    )
    current["image_output_paths"].extend(update.get("image_output_paths") or [])
    current["pptx_output_paths"].extend(update.get("pptx_output_paths") or [])


def _pptx_skill_flags_from_tool_calls(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    flags = _empty_pptx_skill_flags()
    for call in tool_calls:
        args = call.get("args") or {}
        if not isinstance(args, dict):
            continue
        name = call.get("name")
        if name in ("read_file", "read_file_tool"):
            _merge_pptx_skill_flags(flags, _pptx_skill_flags_for_read(args))
        elif name in ("bash", "bash_tool"):
            _merge_pptx_skill_flags(flags, _pptx_skill_flags_for_bash(args))
    return flags


def _visual_skill_flags_from_tool_calls(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    for call in tool_calls:
        if call.get("name") not in ("read_file", "read_file_tool"):
            continue
        args = call.get("args") or {}
        if not isinstance(args, dict):
            continue
        path = str(args.get("path") or args.get("file_path") or "")
        if any(marker in path for marker in _VISUAL_DESIGN_SKILL_PATH_MARKERS):
            return {"visual_design_skill_read": True}
    return {"visual_design_skill_read": False}


def _visual_design_skill_read_seen(state: dict[str, Any]) -> bool:
    summaries = state.get("builder_tool_turn_summaries") or []
    if any(
        bool(summary.get("visual_design_skill_read"))
        for summary in summaries
        if isinstance(summary, dict)
    ):
        return True
    diagnostics = state.get("builder_visual_diagnostics")
    return isinstance(diagnostics, dict) and bool(
        diagnostics.get("visual_design_skill_read") or diagnostics.get("design_skill_read")
    )


def _visuals_requested(state: dict[str, Any]) -> bool:
    delegation = state.get("delegation_context")
    if not isinstance(delegation, dict):
        return False
    combined = "\n".join(
        str(delegation.get(key) or "").lower()
        for key in ("task", "description", "artifact_brief", "original_task")
    )
    return any(marker in combined for marker in _VISUAL_REQUEST_MARKERS)


def _visual_asset_success_count(state: dict[str, Any]) -> int:
    diagnostics = state.get("builder_visual_diagnostics")
    if not isinstance(diagnostics, dict):
        return 0
    return int(diagnostics.get("visual_asset_success_count", 0) or 0)


def _visual_asset_attempt_count(state: dict[str, Any]) -> int:
    diagnostics = state.get("builder_visual_diagnostics")
    if not isinstance(diagnostics, dict):
        return 0
    return int(diagnostics.get("visual_asset_attempt_count", 0) or 0)


def _visual_asset_paths(state: dict[str, Any]) -> list[str]:
    diagnostics = state.get("builder_visual_diagnostics")
    if not isinstance(diagnostics, dict):
        return []
    paths = diagnostics.get("visual_asset_paths") or []
    return [path for path in paths if isinstance(path, str)]


def _local_output_file_for_artifact(state: dict[str, Any], artifact_path: object) -> Path | None:
    canonical = _canonical_outputs_artifact_path(artifact_path)
    relative = _extract_output_relative_path(canonical)
    outputs_root = _outputs_root_from_state(state)
    if canonical is None or relative is None or outputs_root is None:
        return None
    candidate = outputs_root / relative
    return candidate if candidate.is_file() else None


def _html_contains_visual_evidence(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return False
    return (
        "<svg" in text
        or "/visuals/" in text
        or "visuals/" in text
        or "outputs/visuals/" in text
    )


def _pdf_source_contains_visual_evidence(state: dict[str, Any]) -> bool:
    for source in _pdf_source_candidate_paths(state):
        try:
            text = source.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            continue
        if (
            "<svg" in text
            or "/visuals/" in text
            or "visuals/" in text
            or "outputs/visuals/" in text
        ):
            return True
    return False


def _pptx_contains_visual_evidence(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
    except (OSError, zipfile.BadZipFile):
        return False
    return any(
        name.startswith("ppt/media/")
        or name.startswith("ppt/charts/")
        or name.startswith("ppt/diagrams/")
        for name in names
    )


def _pdf_object(value: Any) -> Any:
    getter = getattr(value, "get_object", None)
    if callable(getter):
        try:
            return getter()
        except Exception:  # noqa: BLE001
            return value
    return value


def _pdf_page_image_count(page: Any) -> int:
    try:
        images = getattr(page, "images", None)
        if images:
            return len(images)
    except Exception:  # noqa: BLE001
        pass
    try:
        resources = _pdf_object(page.get("/Resources", {}))
        xobjects = _pdf_object(resources.get("/XObject", {})) if hasattr(resources, "get") else {}
    except Exception:  # noqa: BLE001
        return 0
    count = 0
    if hasattr(xobjects, "values"):
        for value in xobjects.values():
            xobject = _pdf_object(value)
            subtype = xobject.get("/Subtype") if hasattr(xobject, "get") else None
            if subtype == "/Image":
                count += 1
            elif subtype == "/Form":
                count += _pdf_page_image_count(xobject)
    return count


def _pdf_contains_visual_evidence(path: Path, state: dict[str, Any]) -> bool:
    render_result = state.get("builder_pdf_render_result")
    if isinstance(render_result, dict):
        try:
            return int(render_result.get("image_count", 0) or 0) > 0
        except (TypeError, ValueError):
            pass
    if PdfReader is None:
        return False
    try:
        reader = PdfReader(str(path))
        return sum(_pdf_page_image_count(page) for page in reader.pages) > 0
    except Exception:  # noqa: BLE001
        logger.warning("[BuilderVisualDiagnostics] pdf_visual_inspection_failed", exc_info=True)
        return False


def _visual_presence_validated(artifact_args: dict[str, Any], state: dict[str, Any]) -> bool:
    if not _visuals_requested(state):
        return True
    artifact_path = artifact_args.get("artifact_path")
    artifact_file = _local_output_file_for_artifact(state, artifact_path)
    suffix = PurePosixPath(str(artifact_path or "")).suffix.lower()

    if suffix in {".html", ".htm"} and artifact_file is not None:
        return _html_contains_visual_evidence(artifact_file)
    if suffix == ".pptx" and artifact_file is not None:
        return _pptx_contains_visual_evidence(artifact_file)
    if suffix == ".pdf" and artifact_file is not None:
        return _pdf_contains_visual_evidence(artifact_file, state)
    return _visual_asset_success_count(state) > 0


def _apply_visual_missing_fallback_metadata(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    if not _visuals_requested(state):
        return artifact
    requested_ext = _requested_artifact_ext(state)
    artifact_ext = _artifact_ext_from_path(artifact.get("artifact_path"))
    if requested_ext not in {"pdf", "pptx"} or artifact_ext != requested_ext:
        return artifact
    if _visual_presence_validated(artifact, state):
        return artifact
    updated = dict(artifact)
    updated["requested_artifact_ext"] = requested_ext
    updated["artifact_ext"] = artifact_ext
    updated["artifact_is_fallback"] = True
    updated["fallback_reason"] = "visuals_not_embedded"
    confidence = updated.get("confidence")
    if isinstance(confidence, (int, float)):
        updated["confidence"] = min(float(confidence), 0.65)
    tone_hint = str(updated.get("companion_tone_hint") or "").strip()
    degraded_hint = "Explain that the file is usable, but visual embedding did not complete."
    updated["companion_tone_hint"] = f"{tone_hint} {degraded_hint}".strip()
    logger.warning(
        "[BuilderVisualDiagnostics] phase=visual_missing_marked_fallback requested_ext=%s final_ext=%s",
        requested_ext,
        artifact_ext,
    )
    return updated


def _visual_asset_result_delta(result: ToolMessage) -> dict[str, Any] | None:
    if not isinstance(result.content, str):
        return None
    try:
        payload = json.loads(result.content)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    success = payload.get("success") is True
    svg_path = payload.get("svg_path")
    png_path = payload.get("png_path")
    paths = [path for path in (svg_path, png_path) if isinstance(path, str) and path]
    logger.info(
        "[BuilderVisualDiagnostics] phase=tool_result success=%s visual_type=%s "
        "svg_bytes=%s png_bytes=%s png_error=%s",
        success,
        payload.get("visual_type"),
        payload.get("svg_bytes"),
        payload.get("png_bytes"),
        payload.get("png_error"),
    )
    return {
        "visual_asset_attempt_count": 1,
        "visual_asset_success_count": 1 if success else 0,
        "visual_asset_bytes_total": int(payload.get("svg_bytes", 0) or 0)
        + int(payload.get("png_bytes", 0) or 0),
        "visual_asset_error_class": None if success else payload.get("error_type", "visual_asset_error"),
        "visual_asset_paths": paths if success else [],
        "visual_svg_paths": [svg_path] if success and isinstance(svg_path, str) else [],
        "visual_png_paths": [png_path] if success and isinstance(png_path, str) else [],
    }


def _virtual_output_status(state: dict[str, Any], path: str | None) -> tuple[bool, int, str | None]:
    canonical = _canonical_outputs_artifact_path(path)
    if canonical is None:
        return False, 0, "not_outputs_path"
    relative = _extract_output_relative_path(canonical)
    outputs_root = _outputs_root_from_state(state)
    if relative is None or outputs_root is None:
        return False, 0, "missing_outputs_root"
    host_path = outputs_root / relative
    if not host_path.is_file():
        return False, 0, "missing_output"
    try:
        return True, int(host_path.stat().st_size), None
    except OSError:
        return False, 0, "stat_failed"


def _classify_image_generation_error(text: str, exists: bool, bytes_count: int) -> str | None:
    lowered = text.lower()
    if exists and bytes_count > 0:
        return None
    explicit = re.search(r"\bimagegen_fail\s+reason=([a-z0-9_:-]+)", lowered)
    if explicit:
        return explicit.group(1)
    if "openai_api_key" in lowered:
        return "missing_api_key"
    if "openai image generation failed" in lowered:
        return "api_error"
    if "reference image" in lowered and "invalid" in lowered:
        return "invalid_reference_image"
    if "no bytes landed" in lowered or "usable image bytes" in lowered:
        return "empty_output"
    if "error" in lowered or "failed" in lowered:
        return "api_error"
    return "missing_output"


def _image_generation_metadata_from_state(state: dict[str, Any]) -> tuple[str | None, str | None]:
    diagnostics = _pptx_diagnostics(state)
    attempts = int(diagnostics.get("image_generation_attempt_count", 0) or 0)
    if attempts <= 0:
        return None, None
    successes = int(diagnostics.get("image_generation_success_count", 0) or 0)
    if successes > 0:
        return "success", None
    reason = diagnostics.get("image_generation_error_class")
    return "failed", str(reason) if reason else "api_error"


def _classify_pptx_generation_error(
    state: dict[str, Any],
    path: str | None,
    text: str,
    exists: bool,
) -> str | None:
    if exists:
        integrity_reason = _existing_pptx_generation_error(state, path)
        if integrity_reason != "__inspect_text__":
            return integrity_reason
    return _pptx_generation_error_from_text(text)


def _existing_pptx_generation_error(state: dict[str, Any], path: str | None) -> str | None:
    canonical = _canonical_outputs_artifact_path(path)
    if not canonical:
        return "__inspect_text__"
    relative = _extract_output_relative_path(canonical)
    outputs_root = _outputs_root_from_state(state)
    if not relative or not outputs_root:
        return "__inspect_text__"
    return _pptx_integrity_error_for_file(outputs_root / relative)


def _pptx_picture_count_from_text(text: str) -> int:
    match = re.search(r"\bpicture_count=(\d+)\b", text)
    if match is None:
        return 0
    try:
        return int(match.group(1))
    except ValueError:
        return 0


def _pptx_generation_error_from_text(text: str) -> str:
    lowered = text.lower()
    if "slide image not found" in lowered:
        return "missing_slide_image"
    if "invalid presentation plan" in lowered or "json" in lowered:
        return "invalid_plan_json"
    if "error" in lowered or "failed" in lowered:
        return "pptx_generation_error"
    return "missing_output"


def _log_pptx_diagnostics(
    *,
    phase: str,
    state: dict[str, Any],
    artifact_path: object = None,
    integrity_reason: str | None = None,
) -> None:
    if not _requested_pptx_artifact(state):
        return
    diagnostics = state.get("builder_write_diagnostics") or {}
    write_arg_errors = _pptx_write_arg_error_count(diagnostics)
    pptx_diagnostics = _pptx_diagnostics(state)
    logger.info(
        "[BuilderPptxDiagnostics] phase=%s pptx_skill_read_seen=%s "
        "pptx_generator_invoked=%s image_generation_invoked=%s "
        "valid_pptx_seen=%s pptx_integrity_reason=%s fallback_ext=%s "
        "write_file_missing_arg_count=%d requested_artifact_ext=%s "
        "final_artifact_ext=%s artifact_is_fallback=%s fallback_reason=%s "
        "image_generation_attempt_count=%d image_generation_success_count=%d "
        "image_generation_bytes_total=%d image_generation_error_class=%s "
        "pptx_generator_attempt_count=%d pptx_generator_success_count=%d "
        "pptx_generator_bytes_total=%d pptx_generator_error_class=%s "
        "pptx_generator_picture_count=%d",
        phase,
        _pptx_skill_read_seen(state),
        _pptx_generator_invoked_seen(state),
        _image_generation_invoked_seen(state),
        BuilderArtifactMiddleware._has_valid_pptx_output(state),
        integrity_reason,
        _pptx_fallback_suffix(state).lstrip("."),
        write_arg_errors,
        _requested_artifact_ext(state),
        _artifact_path_suffix_label(artifact_path),
        _pptx_artifact_is_fallback_label(state, artifact_path),
        _pptx_fallback_reason_label(state, artifact_path),
        _pptx_diagnostic_count(state, "image_generation_attempt_count"),
        _pptx_diagnostic_count(state, "image_generation_success_count"),
        int(pptx_diagnostics.get("image_generation_bytes_total", 0) or 0),
        pptx_diagnostics.get("image_generation_error_class"),
        _pptx_diagnostic_count(state, "pptx_generator_attempt_count"),
        _pptx_diagnostic_count(state, "pptx_generator_success_count"),
        int(pptx_diagnostics.get("pptx_generator_bytes_total", 0) or 0),
        pptx_diagnostics.get("pptx_generator_error_class"),
        _pptx_diagnostic_count(state, "pptx_generator_picture_count"),
    )


def _pptx_write_arg_error_count(diagnostics: object) -> int:
    if not isinstance(diagnostics, dict):
        return 0
    if diagnostics.get("last_error_class") != "missing_required_tool_arg":
        return 0
    return int(diagnostics.get("error_count", 0) or 0)


def _pptx_artifact_is_fallback_label(state: dict[str, Any], artifact_path: object) -> bool:
    requested = _requested_artifact_ext(state)
    artifact = _artifact_path_suffix_label(artifact_path)
    return bool(requested and artifact and artifact != requested)


def _pptx_fallback_reason_label(state: dict[str, Any], artifact_path: object) -> str | None:
    if _requested_pptx_artifact(state) and _artifact_path_suffix_label(artifact_path) not in {None, "pptx"}:
        return "pptx_generation_not_completed"
    return None


_PPTX_DRIFT_TOOL_NAMES = {
    "write_file",
    "write_file_tool",
    "bash",
    "bash_tool",
    "str_replace",
    "str_replace_tool",
    "emit_builder_artifact",
}


def _recent_builder_tool_names(state: dict[str, Any], *, limit: int) -> list[str]:
    summaries = state.get("builder_tool_turn_summaries") or []
    return [
        name
        for summary in summaries[-limit:]
        if isinstance(summary, dict)
        for name in (summary.get("tool_names") or [])
        if isinstance(name, str)
    ]


def _pptx_recent_tools_drifted(tool_names: list[str]) -> bool:
    return any(name in _PPTX_DRIFT_TOOL_NAMES for name in tool_names)


def _pptx_write_error_count(state: dict[str, Any]) -> int:
    diagnostics = state.get("builder_write_diagnostics")
    if not isinstance(diagnostics, dict):
        return 0
    return int(diagnostics.get("error_count", 0) or 0)


def _log_pptx_skill_correction(
    state: dict[str, Any],
    *,
    non_artifact_turns: int,
    recent_tool_names: list[str],
    generator_invoked_seen: bool,
    valid_pptx_seen: bool,
) -> None:
    logger.warning(
        "BuilderArtifact: presentation target needs ppt-generation correction "
        "turn=%d recent_tools=%s pptx_skill_read_seen=%s "
        "pptx_generator_invoked=%s image_generation_invoked=%s "
        "valid_pptx_seen=%s fallback_ext=%s write_file_missing_arg_count=%s",
        non_artifact_turns,
        ",".join(recent_tool_names[-6:]),
        _pptx_skill_read_seen(state),
        generator_invoked_seen,
        _image_generation_invoked_seen(state),
        valid_pptx_seen,
        _pptx_fallback_suffix(state).lstrip("."),
        _pptx_write_error_count(state),
    )


def _pptx_skill_correction_message(state: dict[str, Any]) -> str:
    fallback_suffix = _pptx_fallback_suffix(state)
    return (
        "[Sophia/presentation-skill correction]\n"
        "This is a PPTX slide-deck build. Reading SKILL.md is useful, "
        "but it is not completion. Stop ad hoc deck generation, "
        "python-pptx scripts, `.py` files, and generic write_file loops.\n\n"
        "Your next safe workflow is:\n"
        "1. If you have not already done so, call "
        "`read_file(path='/mnt/skills/public/ppt-generation/SKILL.md')`.\n"
        "2. Create a valid slide plan JSON under "
        "`/mnt/user-data/workspace/`.\n"
        "3. Compose a no-image deck by running "
        "`/mnt/skills/public/ppt-generation/scripts/generate.py` with "
        "`--plan-file` and `--output-file` only.\n"
        "4. Use `/mnt/skills/public/image-generation/scripts/generate.py` only if the "
        "user explicitly requested generated images or illustrations. If image generation "
        "fails, continue with a no-image PPTX.\n"
        "5. Emit only after the `.pptx` exists and is a valid PowerPoint package.\n\n"
        "If deck composition or validation cannot complete after this correction, create a real "
        f"{fallback_suffix} fallback under `/mnt/user-data/outputs/` with "
        "`write_file(description='fallback deck outline', path='/mnt/user-data/outputs/deck"
        f"{fallback_suffix}', content='...', append=False)`, then emit that "
        "fallback. Do not emit placeholder/tiny/corrupt `.pptx` files, Python scripts, "
        "or test files."
    )


def _pptx_plan_correction_message() -> str:
    return (
        "[Sophia/presentation-plan correction]\n"
        "The PPTX generator rejected the presentation plan JSON. Do not switch "
        "to HTML yet. Rewrite the plan as a valid JSON object under "
        "`/mnt/user-data/workspace/` and run the PPT generator once more.\n\n"
        "Minimum schema:\n"
        "{\n"
        '  "title": "Deck title",\n'
        '  "aspect_ratio": "16:9",\n'
        '  "slides": [\n'
        '    {"slide_number": 1, "type": "title", "title": "Title", "subtitle": "Subtitle"},\n'
        '    {"slide_number": 2, "type": "content", "title": "Slide title", '
        '"key_points": ["Point 1", "Point 2"]}\n'
        "  ]\n"
        "}\n\n"
        "Generated slide images are optional unless the user explicitly asked "
        "for generated images. A text/layout/chart-only deck is valid."
    )


def _pdf_render_correction_message(source_path: str, pdf_path: str) -> str:
    return (
        "[Sophia/PDF render correction]\n"
        "A requested PDF has a source document on disk, but the PDF renderer "
        "has not been attempted. Your next action must be:\n"
        f"`render_markdown_to_pdf(markdown_path='{source_path}', pdf_path='{pdf_path}')`.\n"
        "If rendering succeeds, immediately emit that `.pdf`. If rendering "
        "fails, emit the approved Markdown/HTML fallback with explicit PDF "
        "fallback metadata."
    )


def _pdf_source_write_message(target_path: str) -> str:
    source_path = f"{_OUTPUTS_VIRTUAL_PREFIX}{PurePosixPath(target_path).with_suffix('.md').name}"
    return (
        "[Sophia/PDF source correction]\n"
        "This is a requested PDF build, but no Markdown/HTML source is available "
        "for the renderer yet. Stop writing helper scripts. Use one complete "
        "`write_file` call to create the Markdown source now:\n"
        "`write_file(description='write PDF source', "
        f"path='{source_path}', content='...', append=False)`.\n"
        "After that, call `render_markdown_to_pdf` to create the PDF."
    )


def _visual_design_skill_message() -> str:
    return (
        "[Sophia/visual-design correction]\n"
        "The user requested charts, diagrams, or visual explanations. Before "
        "creating visual assets or emitting the final artifact, read the visual "
        "design skill now:\n"
        "`read_file(description='read visual design skill', "
        "path='/mnt/skills/public/visual-design/SKILL.md')`.\n"
        "Then create local visual assets with `generate_visual_asset` under "
        "`/mnt/user-data/outputs/visuals/` and embed them in the final artifact."
    )


def _visual_asset_required_message(state: dict[str, Any]) -> str:
    target_ext = _requested_target_suffix(state).lstrip(".") or "artifact"
    return (
        "[Sophia/visual-asset correction]\n"
        f"This {target_ext} request asked for charts, diagrams, or visuals, but "
        "no verified local visual asset has been created yet. Create one now "
        "with `generate_visual_asset`, writing under `/mnt/user-data/outputs/visuals/`, "
        "then reference or embed that asset in the final HTML/PDF source/PPTX plan "
        "before emitting. Remote chart URLs and prose descriptions do not count."
    )


def _force_reason(turn_force: bool, clock_force: bool) -> str:
    if turn_force and clock_force:
        return "turns+wall_clock"
    if clock_force:
        return "wall_clock"
    return "turns"


def _wrote_before_research(
    *,
    previous: dict[str, Any],
    search_count: int,
    fetch_count: int,
    write_names: list[str],
    tool_names: list[str],
) -> bool:
    if previous.get("wrote_before_research", False):
        return True
    if not write_names or search_count + fetch_count > 0:
        return False
    return _first_research_tool_index(tool_names) > _first_write_tool_index(tool_names)


class BuilderArtifactState(AgentState):
    builder_result: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]
    builder_research_diagnostics: NotRequired[dict]
    builder_update_epoch: NotRequired[int]
    builder_update_required_urls: NotRequired[list[str]]
    builder_artifact_target_path: NotRequired[str]
    builder_last_successful_output_path: NotRequired[str | None]
    builder_write_diagnostics: NotRequired[Annotated[dict, _merge_builder_write_diagnostics]]
    builder_pptx_diagnostics: NotRequired[Annotated[dict, _merge_builder_pptx_diagnostics]]
    builder_visual_diagnostics: NotRequired[Annotated[dict, _merge_builder_visual_diagnostics]]
    # PR #94: count consecutive emit attempts rejected for empty/missing
    # ``artifact_path``. When this reaches ``_REJECTION_SHORT_CIRCUIT_AT``
    # we route directly to the hard-ceiling fallback instead of letting
    # the model retry into the LangGraph recursion limit.
    builder_consecutive_empty_emit_rejections: NotRequired[int]
    builder_last_missing_emit_path: NotRequired[str | None]
    builder_consecutive_missing_emit_path_rejections: NotRequired[int]
    # Phase 2F.3: idempotency flag. Set once we've injected a path-
    # correction HumanMessage after N consecutive write_file_tool errors,
    # so we don't repeat the correction on every subsequent before_model.
    builder_path_correction_emitted: NotRequired[bool]
    builder_tool_argument_correction_emitted: NotRequired[bool]
    builder_recovered_deliverable_emitted: NotRequired[bool]
    builder_pdf_render_result: NotRequired[dict | None]
    builder_pdf_layout_repair_attempts: NotRequired[int]
    builder_pdf_layout_repair_requested: NotRequired[bool]
    builder_pdf_render_correction_emitted: NotRequired[bool]
    builder_pdf_source_write_directive_emitted: NotRequired[bool]
    builder_pptx_skill_correction_emitted: NotRequired[bool]
    builder_pptx_plan_correction_emitted: NotRequired[bool]
    builder_pptx_fallback_directive_emitted: NotRequired[bool]
    builder_visual_design_correction_emitted: NotRequired[bool]
    builder_visual_asset_correction_emitted: NotRequired[bool]


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent."""

    state_schema = BuilderArtifactState

    @staticmethod
    def _tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
        names: list[str] = []
        for call in tool_calls:
            name = call.get("name")
            if isinstance(name, str) and name:
                names.append(name)
        return names

    @staticmethod
    def _append_turn_summary(state: BuilderArtifactState, summary: dict[str, Any]) -> list[dict]:
        history = list(state.get("builder_tool_turn_summaries", []) or [])
        history.append(summary)
        return history[-12:]

    @staticmethod
    def _allow_web_research(state: BuilderArtifactState) -> bool:
        delegation = state.get("delegation_context")
        if "allow_web_research" in state or isinstance(delegation, dict):
            return True
        return False

    @staticmethod
    def _is_edit_existing_artifact_state(state: BuilderArtifactState) -> bool:
        delegation = state.get("delegation_context")
        edit_context = delegation.get("edit_context") if isinstance(delegation, dict) else None
        return isinstance(edit_context, dict) and edit_context.get("mode") == "edit_existing_artifact"

    @staticmethod
    def _has_required_edit_research_input(state: BuilderArtifactState) -> bool:
        explicit_urls = state.get("explicit_user_urls") or []
        required_urls = state.get("builder_update_required_urls") or []
        return any(str(url).strip() for url in (*explicit_urls, *required_urls))

    @staticmethod
    def _edit_state_requires_research(state: BuilderArtifactState) -> bool:
        if not BuilderArtifactMiddleware._is_edit_existing_artifact_state(state):
            return True
        return BuilderArtifactMiddleware._has_required_edit_research_input(state)

    @staticmethod
    def _research_attempted(state: BuilderArtifactState) -> bool:
        return _builder_web_attempt_count(state) > 0 or _has_builder_search_source(state)

    @staticmethod
    def _planning_completed(state: BuilderArtifactState) -> bool:
        summaries = state.get("builder_tool_turn_summaries") or []
        if any(
            "write_todos" in (summary.get("tool_names") or [])
            for summary in summaries
            if isinstance(summary, dict)
        ):
            return True
        return int(state.get("builder_non_artifact_turns", 0) or 0) > 0

    @classmethod
    def _should_force_research_tool(cls, state: BuilderArtifactState) -> bool:
        return (
            cls._allow_web_research(state)
            and cls._edit_state_requires_research(state)
            and cls._planning_completed(state)
            and not cls._research_attempted(state)
        )

    @classmethod
    def _should_force_fetch_tool(cls, state: BuilderArtifactState) -> bool:
        return (
            cls._allow_web_research(state)
            and cls._edit_state_requires_research(state)
            and cls._planning_completed(state)
            and _needs_fetch_before_write(state)
        )

    @classmethod
    def _research_gate_active(cls, state: BuilderArtifactState) -> bool:
        if not cls._allow_web_research(state):
            return False
        if not cls._edit_state_requires_research(state):
            return False
        return not (cls._research_attempted(state) and not cls._should_force_fetch_tool(state))

    @staticmethod
    def _bash_is_substantive_before_research(tool_call: dict[str, Any]) -> bool:
        args = tool_call.get("args") or {}
        command = args.get("command") if isinstance(args, dict) else None
        return not _is_safe_pre_research_bash(command)

    @classmethod
    def _is_substantive_before_research_tool(cls, state: BuilderArtifactState, tool_call: dict[str, Any]) -> bool:
        if not cls._research_gate_active(state):
            return False
        name = tool_call.get("name")
        if name in _BUILDER_SUBSTANTIVE_TOOL_NAMES:
            return True
        if name == _SIMPLE_PDF_TOOL_NAME:
            return not _requested_simple_pdf_artifact(state)
        if name in {"bash", "bash_tool"}:
            return cls._bash_is_substantive_before_research(tool_call)
        return False

    @staticmethod
    def _update_research_diagnostics(
        state: BuilderArtifactState,
        tool_names: list[str],
    ) -> dict[str, Any]:
        previous = dict(state.get("builder_research_diagnostics") or {})
        search_count, fetch_count, write_file_count = _diagnostic_counts(previous)
        first_content_tool = previous.get("first_content_tool")
        write_names = _write_tool_names(tool_names)
        wrote_before_research = _wrote_before_research(
            previous=previous,
            search_count=search_count,
            fetch_count=fetch_count,
            write_names=write_names,
            tool_names=tool_names,
        )
        search_count += tool_names.count("builder_web_search")
        fetch_count += tool_names.count("builder_web_fetch")
        write_file_count += len(write_names)
        first_content_tool = first_content_tool or (write_names[0] if write_names else None)

        return {
            "builder_web_search_count": search_count,
            "builder_web_fetch_count": fetch_count,
            "write_file_count": write_file_count,
            "first_content_tool": first_content_tool,
            "wrote_before_research": wrote_before_research,
        }

    @staticmethod
    def _log_research_diagnostics(
        *,
        phase: str,
        diagnostics: dict[str, Any],
        allow_web_research: bool,
        sources_used: Any = None,
    ) -> None:
        sources_empty = isinstance(sources_used, list) and len(sources_used) == 0
        search_count, fetch_count, write_file_count = _diagnostic_counts(diagnostics)
        logger.info(
            "[BuilderResearchDiagnostics] phase=%s allow_web_research=%s builder_web_search_count=%d builder_web_fetch_count=%d write_file_count=%d first_content_tool=%s wrote_before_research=%s sources_used_empty=%s",
            phase,
            allow_web_research,
            search_count,
            fetch_count,
            write_file_count,
            diagnostics.get("first_content_tool"),
            bool(diagnostics.get("wrote_before_research", False)),
            sources_empty,
        )
        if _should_warn_missing_web_tools(
            phase=phase,
            allow_web_research=allow_web_research,
            search_count=search_count,
            fetch_count=fetch_count,
            write_file_count=write_file_count,
        ):
            logger.warning(
                "[BuilderResearchDiagnostics] reason=research_enabled_no_web_tools first_content_tool=%s write_file_count=%d",
                diagnostics.get("first_content_tool"),
                write_file_count,
            )
        if allow_web_research and sources_empty:
            logger.warning("[BuilderResearchDiagnostics] reason=research_enabled_empty_sources_used")

    # Ceiling enforcement — MUST stay in sync with _HARD_CEILING in after_model
    # and with builder_task.py's _HARD_CEILING. When the model is within this
    # many turns of termination, we force Anthropic tool_choice to emit so the
    # model literally cannot call any other tool. Prompt-level escalation is
    # not reliable mid-retry-loop; the API-level constraint is.
    #
    # PR-B (2026-04-28): bumped ceiling 20 → 30 after run ``c130c516`` (PDF
    # with diagrams) hit the 20-turn cap mid-progress: write→bash→fix cycles
    # for binary deliverables legitimately need 12-15 turns of build pipeline
    # plus initial planning + final emit. At 20 the model ran out of budget
    # while still iterating productively, then got trapped in 3 wasted forced-
    # write turns (LLM emitted near-empty content because the recovery path
    # for binary tasks is bash, not write_file). Soft warn rescaled to 18
    # (60%) and force-emit at remaining<=3 (turn 27+). Wall-clock force-emit
    # at 70% of per-run timeout (1260s of 1800s) is the backstop for runaway
    # text deliverables — those rarely need 30 turns.
    #
    # PR-A history (2026-04-27): bumped 10 → 20 after a research-heavy task
    # in log ``019dcfbf-f219-7d83-86a4-ffb161ebddf7`` proved 10 too tight.
    # PR-C F6 history (2026-04-24): lowered 20 → 10 because the original
    # ceiling let pathological retries burn the budget. PR-A fixes those
    # retries at the source (two-stage forced-emit + empty-path rejection)
    # so the larger budget no longer enables runaway retry loops.
    _FORCE_EMIT_REMAINING = 3
    _CEILING_FOR_FORCE = 30
    _SOFT_WARN_AT = 18
    # Wall-clock fraction of the per-run timeout at which we activate
    # force-emit even if the turn-count ceiling hasn't been hit. Each
    # write_file LLM call costs ~95s on long-form deliverables; with
    # _resolve_builder_limits returning timeout=1800s, 0.70 leaves ~540s of
    # slack — enough for one final write + emit + network buffer.
    _FORCE_EMIT_WALL_CLOCK_FRACTION = 0.70
    # PR #94: when the model emits ``artifact_path=None`` (or any empty
    # path) under forced ``tool_choice=emit_builder_artifact``, we reject
    # and let it retry. After this many consecutive empty rejections we
    # short-circuit straight to the hard-ceiling fallback — synthesizing
    # ``builder_result`` from disk state — rather than letting the rejection
    # loop burn the remaining LangGraph recursion budget. Threshold of 2
    # leaves room for one transient empty-emit (e.g. a typo on the model's
    # first attempt) while still bounding the loop to ~12 super-steps
    # instead of the ~21 the ceiling-only path costs.
    _REJECTION_SHORT_CIRCUIT_AT = 2

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        remaining = BuilderArtifactMiddleware._CEILING_FOR_FORCE - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

    @staticmethod
    def _should_force_emit_by_clock(state: BuilderArtifactState, runtime: Runtime | None = None) -> bool:
        """Return True when the wall-clock budget has crossed the force-emit fraction.

        Reads ``builder_timeout_seconds`` and ``builder_task_kickoff_ms`` from
        ``state`` (populated via ``SubagentExecutor``'s ``extra_configurable``
        plumbing in ``switch_to_builder``). Uses ``builder_task_started_at_ms``
        from state when present, falling back to ``builder_task_kickoff_ms``
        (set at queue time) so the very first turn — before ``after_model``
        has had a chance to record ``builder_task_started_at_ms`` — still
        gets the right answer.

        ``runtime`` is accepted for parity with other middleware methods and
        kept as a fallback signal source, but the canonical path is state-only:
        ``executor.py`` already merges ``extra_configurable`` into initial
        state, matching how ``delegation_context`` flows.

        Returns False (today's behavior, turn-count-only) when neither timestamp
        is set or when ``builder_timeout_seconds`` is missing/non-positive. This
        keeps the gate backward-compatible for any caller that doesn't opt in.
        """
        raw_timeout = state.get("builder_timeout_seconds")
        timeout_s = 0
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            timeout_s = int(raw_timeout)
        if timeout_s <= 0:
            return False

        started_ms = state.get("builder_task_started_at_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            started_ms = state.get("builder_task_kickoff_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            return False

        elapsed_ms = max(0, int(time.time() * 1000) - int(started_ms))
        return elapsed_ms / (timeout_s * 1000) >= BuilderArtifactMiddleware._FORCE_EMIT_WALL_CLOCK_FRACTION

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

    @staticmethod
    def _forced_write_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces write_file.

        PR-A: used in the two-stage forced-emit path when the model is in the
        forced-emit window but hasn't written any deliverable yet. Forcing
        emit at that point traps the model — it can only call emit, the
        emit gets rejected (no file exists), and the loop spins. By forcing
        write_file for one turn first, we guarantee the model has at least
        one chance to land a file before tool_choice locks to emit.
        """
        return {"type": "tool", "name": "write_file"}

    @staticmethod
    def _forced_read_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces read_file."""
        return {"type": "tool", "name": "read_file"}

    @staticmethod
    def _forced_visual_asset_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces local visual asset generation."""
        return {"type": "tool", "name": "generate_visual_asset"}

    @staticmethod
    def _forced_search_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces builder_web_search."""
        return {"type": "tool", "name": "builder_web_search"}

    @staticmethod
    def _forced_fetch_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces builder_web_fetch."""
        return {"type": "tool", "name": "builder_web_fetch"}

    @staticmethod
    def _forced_pdf_render_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces the PDF renderer."""
        return {"type": "tool", "name": "render_markdown_to_pdf"}

    @staticmethod
    def _forced_simple_pdf_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces the deterministic PDF writer."""
        return {"type": "tool", "name": _SIMPLE_PDF_TOOL_NAME}

    def _research_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if self._should_force_fetch_tool(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=builder_web_fetch "
                "after search before factual artifact writing"
            )
            return self._forced_fetch_tool_choice()
        if not self._should_force_research_tool(state):
            return None
        explicit_urls = [
            url for url in (state.get("explicit_user_urls") or []) if str(url).strip()
        ]
        if explicit_urls:
            logger.warning(
                "BuilderArtifact: forcing tool_choice=builder_web_fetch "
                "before artifact writing (explicit_urls=%d)",
                len(explicit_urls),
            )
            return self._forced_fetch_tool_choice()
        logger.warning(
            "BuilderArtifact: forcing tool_choice=builder_web_search "
            "before artifact writing"
        )
        return self._forced_search_tool_choice()

    def _visual_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _visuals_requested(state):
            return None
        if not _visual_design_skill_read_seen(state):
            logger.warning("BuilderArtifact: forcing tool_choice=read_file for visual-design skill")
            return self._forced_read_tool_choice()
        if (
            state.get("builder_visual_asset_correction_emitted")
            and _visual_asset_success_count(state) <= 0
            and _visual_asset_attempt_count(state) <= 0
        ):
            logger.warning("BuilderArtifact: forcing tool_choice=generate_visual_asset after visual correction")
            return self._forced_visual_asset_tool_choice()
        return None

    def _completion_tool_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        turn_force = self._should_force_emit(state)
        clock_force = self._should_force_emit_by_clock(state, runtime)
        if not (turn_force or clock_force):
            return None
        force_reason = _force_reason(turn_force, clock_force)
        non_artifact_turns = state.get("builder_non_artifact_turns")

        if self._has_output_file(state):
            return self._output_file_completion_tool_choice(state, non_artifact_turns, force_reason)

        if self._has_generator_script(state):
            return self._generator_recovery_tool_choice(state, non_artifact_turns, force_reason)

        if _requested_pptx_artifact(state) and not state.get("builder_pptx_skill_correction_emitted"):
            logger.warning(
                "BuilderArtifact: PPTX target has no valid deck/fallback and no "
                "skill correction yet; withholding generic write_file force so "
                "the presentation-skill correction can steer the next turn "
                "(non_artifact_turns=%s, reason=%s)",
                non_artifact_turns,
                force_reason,
            )
            return None

        logger.warning(
            "BuilderArtifact: forcing tool_choice=write_file before emit "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s, no output file yet — "
            "force prevents phantom-emit loop)",
            non_artifact_turns,
            self._CEILING_FOR_FORCE,
            force_reason,
        )
        return self._forced_write_tool_choice()

    def _output_file_completion_tool_choice(
        self,
        state: BuilderArtifactState,
        non_artifact_turns: object,
        force_reason: str,
    ) -> dict[str, Any]:
        if self._should_force_pdf_render_before_emit(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=render_markdown_to_pdf "
                "before PDF fallback emit (non_artifact_turns=%s, "
                "ceiling=%s, reason=%s)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_pdf_render_tool_choice()
        logger.warning(
            "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s)",
            non_artifact_turns,
            self._CEILING_FOR_FORCE,
            force_reason,
        )
        return self._forced_tool_choice()

    @classmethod
    def _should_force_pdf_render_before_emit(cls, state: BuilderArtifactState) -> bool:
        if not _requested_pdf_artifact(state):
            return False
        if cls._has_requested_pdf_binary(state):
            return False
        return not _render_markdown_to_pdf_attempted(state)

    def _generator_recovery_tool_choice(
        self,
        state: BuilderArtifactState,
        non_artifact_turns: object,
        force_reason: str,
    ) -> dict[str, Any]:
        if _requested_pdf_artifact(state):
            logger.warning(
                "BuilderArtifact: PDF target has generator script but no deliverable; "
                "forcing write_file to create a Markdown source/fallback instead "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_write_tool_choice()
        if _requested_pptx_artifact(state):
            if not state.get("builder_pptx_skill_correction_emitted"):
                logger.warning(
                    "BuilderArtifact: PPTX target has ad hoc generator script but "
                    "no valid deck/fallback; withholding bash force until the "
                    "ppt-generation skill correction runs (non_artifact_turns=%s, "
                    "reason=%s)",
                    non_artifact_turns,
                    force_reason,
                )
                return None
            logger.warning(
                "BuilderArtifact: PPTX target still has no valid deck after skill "
                "correction; forcing write_file only to create a Markdown/HTML "
                "fallback, never a Python deck script (non_artifact_turns=%s, "
                "reason=%s)",
                non_artifact_turns,
                force_reason,
            )
            return self._forced_write_tool_choice()
        logger.warning(
            "BuilderArtifact: forcing tool_choice=bash before emit "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s, generator "
            "script on disk but no binary — three-stage force gives the "
            "model a chance to RUN the generator instead of writing yet "
            "another one)",
            non_artifact_turns,
            self._CEILING_FOR_FORCE,
            force_reason,
        )
        return self._forced_bash_tool_choice()

    @staticmethod
    def _forced_bash_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces bash.

        PR-B (2026-04-28): used by the three-stage forced-emit path when a
        generator script (``_generate_*.py``) exists in outputs/ but no
        user-facing binary (pdf/pptx/png/...) has been produced yet. For
        binary deliverables the recovery action is *running* the generator,
        not writing yet another generator. Forcing write_file in that state
        — as PR-A did — traps the model: each forced write produces another
        ``_generate_*.py`` (which ``_has_output_file`` filters out), so the
        gate stays False and the loop spins. Forcing bash gives the model a
        deterministic chance to produce the binary by running what it
        already has on disk. If bash also fails to produce output, the
        hard-ceiling fallback promotes the generator script with
        ``confidence=0.4`` so the user still gets something.
        """
        return {"type": "tool", "name": "bash"}

    @staticmethod
    def _has_output_file(state: BuilderArtifactState) -> bool:
        """Return True if any user-facing file exists in the sandbox outputs dir.

        PR-A: used by ``wrap_model_call`` to decide whether the forced-emit
        window should immediately force ``tool_choice=emit_builder_artifact``
        or first force ``tool_choice=write_file`` to give a not-yet-written
        deliverable a chance to land.

        Files whose name starts with ``_`` (e.g. generator scripts named
        ``_generate_foo.py``) or ``.`` (hidden files) are excluded — those
        aren't user-facing deliverables.
        """
        outputs_host_path = _outputs_host_path_from_state(state)
        outputs_root = _outputs_root_from_state(state)
        if outputs_root is None:
            # No outputs dir configured — assume the model hasn't written
            # anything. Returning False routes through the safer path
            # (force write_file first) instead of forcing a phantom emit.
            return False

        # Ignore stale artifacts from prior builder tasks in the same thread.
        # Keep the same 5s grace used by hard-ceiling promotion.
        min_mtime = _builder_started_min_mtime(state)

        try:
            return _output_tree_has_completion_candidate(outputs_root, state, min_mtime)
        except OSError:
            # Filesystem error (permissions, race) — fall through to True
            # so the existing forced-emit path proceeds. Better to risk one
            # phantom emit than to accidentally trap the model in write_file
            # forcing on every turn when something is genuinely wrong with
            # the sandbox.
            logger.debug(
                "BuilderArtifact._has_output_file: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return True
        return False

    @staticmethod
    def _has_requested_pdf_binary(state: BuilderArtifactState) -> bool:
        outputs_root = _outputs_root_from_state(state)
        if outputs_root is None:
            return False
        min_mtime = _builder_started_min_mtime(state)
        try:
            return _output_tree_has_fresh_pdf(outputs_root, min_mtime)
        except OSError:
            logger.debug(
                "BuilderArtifact._has_requested_pdf_binary: scan failed for outputs_path=%s",
                _outputs_host_path_from_state(state),
                exc_info=True,
            )
            return False

    @staticmethod
    def _has_valid_pptx_output(state: BuilderArtifactState) -> bool:
        outputs_root = _outputs_root_from_state(state)
        if outputs_root is None:
            return False
        min_mtime = _builder_started_min_mtime(state)
        try:
            for entry in outputs_root.rglob("*.pptx"):
                if not _is_public_output_file(entry):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                if _pptx_integrity_error_for_file(entry) is None:
                    return True
        except OSError:
            logger.debug(
                "BuilderArtifact._has_valid_pptx_output: scan failed for outputs_path=%s",
                _outputs_host_path_from_state(state),
                exc_info=True,
            )
        return False

    @staticmethod
    def _promotable_output_candidates(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
    ) -> list[Path]:
        outputs_host_path = _outputs_host_path_from_state(state)
        if not outputs_host_path:
            return []
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []

        min_mtime = _builder_started_min_mtime(state)
        candidates = [
            p for p in outputs_root.rglob("*")
            if _is_promotable_candidate_path(
                p,
                min_mtime=min_mtime,
                requested_pdf=requested_pdf,
                requested_pptx=requested_pptx,
            )
        ]
        candidates = BuilderArtifactMiddleware._target_promotable_candidates(
            candidates,
            state,
            requested_pdf=requested_pdf,
            requested_pptx=requested_pptx,
        )
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates

    @staticmethod
    def _target_promotable_candidates(
        candidates: list[Path],
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
    ) -> list[Path]:
        if requested_pdf:
            return BuilderArtifactMiddleware._preferred_suffix_candidates(
                candidates,
                primary_suffix=".pdf",
                fallback_suffix=_pdf_fallback_suffix(state),
                primary_disabled=_pdf_render_unusable_after_repair(state),
            )
        if requested_pptx:
            return BuilderArtifactMiddleware._preferred_suffix_candidates(
                candidates,
                primary_suffix=".pptx",
                fallback_suffix=_pptx_fallback_suffix(state),
            )
        return candidates

    @staticmethod
    def _preferred_suffix_candidates(
        candidates: list[Path],
        *,
        primary_suffix: str,
        fallback_suffix: str,
        primary_disabled: bool = False,
    ) -> list[Path]:
        primary = [] if primary_disabled else [
            p for p in candidates if p.suffix.lower() == primary_suffix
        ]
        fallback = [
            p for p in candidates if p.suffix.lower() == fallback_suffix
        ]
        return primary or fallback

    @staticmethod
    def _generator_output_candidates(state: BuilderArtifactState) -> list[Path]:
        outputs_host_path = _outputs_host_path_from_state(state)
        if not outputs_host_path:
            return []
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []

        min_mtime = _builder_started_min_mtime(state)
        candidates = [
            p for p in outputs_root.rglob("*")
            if p.is_file()
            and p.name.startswith("_generate_")
            and p.suffix.lower() == ".py"
            and (min_mtime is None or p.stat().st_mtime >= min_mtime)
        ]
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates

    @staticmethod
    def _virtual_output_path(path: Path, state: BuilderArtifactState) -> str:
        outputs_host_path = _outputs_host_path_from_state(state)
        outputs_root = Path(outputs_host_path or "")
        return f"/mnt/user-data/outputs/{path.relative_to(outputs_root).as_posix()}"

    @staticmethod
    def _promoted_deliverable_from_outputs(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
        reason: str,
    ) -> tuple[str | None, str]:
        try:
            candidates = BuilderArtifactMiddleware._promotable_output_candidates(
                state,
                requested_pdf=requested_pdf,
                requested_pptx=requested_pptx,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort only
            logger.warning(
                "BuilderArtifact: ceiling fallback scan failed reason=%s error=%s",
                reason,
                exc,
            )
            return None, "unknown"
        if not candidates:
            return None, "unknown"
        best = candidates[0]
        return (
            BuilderArtifactMiddleware._virtual_output_path(best, state),
            best.suffix.lower().lstrip(".") or "unknown",
        )

    @staticmethod
    def _promoted_generator_from_outputs(
        state: BuilderArtifactState,
        *,
        requested_pdf: bool,
        requested_pptx: bool,
        reason: str,
    ) -> str | None:
        try:
            gen_candidates = BuilderArtifactMiddleware._generator_output_candidates(state)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BuilderArtifact: generator-script fallback scan failed reason=%s error=%s",
                reason,
                exc,
            )
            return None
        if not gen_candidates:
            return None
        promoted_path = BuilderArtifactMiddleware._virtual_output_path(
            gen_candidates[0],
            state,
        )
        if requested_pdf:
            logger.warning(
                "BuilderArtifact: PDF fallback refusing generator script %s "
                "(reason=%s, no pdf_or_markdown deliverable found)",
                promoted_path,
                reason,
            )
            return None
        if requested_pptx:
            logger.warning(
                "BuilderArtifact: PPTX fallback refusing generator script %s "
                "(reason=%s, no valid deck_or_fallback deliverable found)",
                promoted_path,
                reason,
            )
            return None
        logger.warning(
            "BuilderArtifact: fallback promoting generator script %s "
            "(reason=%s, no binary deliverable found)",
            promoted_path,
            reason,
        )
        return promoted_path

    @staticmethod
    def _recovered_deliverable_fallback(
        promoted_path: str,
        promoted_type: str,
        *,
        steps_completed: int,
    ) -> dict[str, Any]:
        return {
            "artifact_path": promoted_path,
            "artifact_type": promoted_type,
            "artifact_title": "Build task completed (recovered)",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                "The builder ran long and didn't call emit cleanly, "
                "but the deliverable is on disk — I'm surfacing it now."
            ),
            "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
            "user_next_action": "Open the file and let me know if it lands.",
            "confidence": 0.5,
        }

    @staticmethod
    def _generator_script_fallback(
        promoted_generator_path: str,
        *,
        steps_completed: int,
    ) -> dict[str, Any]:
        return {
            "artifact_path": promoted_generator_path,
            "artifact_type": "code",
            "artifact_title": "Build task partial (generator script only)",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                "I built the generator script but couldn't produce the final "
                "binary cleanly — sharing the script so you have something to "
                "work with."
            ),
            "companion_tone_hint": (
                "Honest and constructive — partial deliverable; offer to debug "
                "if the user shares the error from running it."
            ),
            "user_next_action": (
                "Try running `python <path>` yourself, or send me the error "
                "and I'll fix it."
            ),
            "confidence": 0.4,
        }

    @staticmethod
    def _pdf_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "pdf",
            "artifact_title": "PDF build did not complete",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                "The builder could not produce a PDF or Markdown fallback. "
                "I did not surface the generator script as a completed PDF."
            ),
            "companion_tone_hint": (
                "Apologetic and direct — PDF rendering did not produce a "
                "deliverable; offer to retry."
            ),
            "user_next_action": "Ask me to retry the PDF build.",
            "confidence": 0.2,
        }

    @staticmethod
    def _pptx_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "presentation",
            "artifact_title": "Slide deck did not complete",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                "The builder could not produce a valid PowerPoint deck or "
                "a usable markdown/html fallback. I did not surface a broken "
                "PPTX as completed."
            ),
            "companion_tone_hint": (
                "Apologetic and direct — deck generation did not produce a "
                "valid deliverable; offer to retry."
            ),
            "user_next_action": "Ask me to retry the slide deck build.",
            "confidence": 0.2,
        }

    @staticmethod
    def _generic_no_deliverable_fallback(*, steps_completed: int) -> dict[str, Any]:
        return {
            "artifact_path": None,
            "artifact_type": "unknown",
            "artifact_title": "Build task force-stopped",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                f"The builder made {steps_completed} edits but didn't finish cleanly. "
                "No final deliverable was produced."
            ),
            "companion_tone_hint": "Apologetic — builder ran out of budget.",
            "user_next_action": "Tell me what to try differently and I'll run it again.",
            "confidence": 0.2,
        }

    @staticmethod
    def _fallback_completion_status(fallback: dict[str, Any]) -> str:
        return "completed" if fallback.get("artifact_path") else "failed"

    @staticmethod
    def _log_missing_pdf_render_attempt_if_needed(
        state: BuilderArtifactState,
        artifact_args: dict[str, Any],
    ) -> None:
        if not _pdf_render_attempt_missing(state):
            return
        logger.warning(
            "BuilderArtifact: requested_ext=pdf render_tool_attempted=false "
            "fallback_ext=%s rejected_ext=%s reason=pdf_render_tool_not_attempted",
            _pdf_fallback_suffix(state).lstrip("."),
            _artifact_path_suffix_label(artifact_args.get("artifact_path")),
        )

    @staticmethod
    def _requested_pdf_without_render_fallback(
        state: BuilderArtifactState,
        *,
        promoted_path: str | None,
        steps_completed: int,
    ) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state) or _render_markdown_to_pdf_attempted(state):
            return None
        if promoted_path:
            promoted_suffix = PurePosixPath(promoted_path).suffix.lower()
            if promoted_suffix == ".pdf":
                return None
            logger.warning(
                "BuilderArtifact: PDF ceiling fallback refused source before "
                "render attempt source_ext=%s reason=pdf_render_tool_not_attempted",
                promoted_suffix.lstrip(".") or None,
            )
        elif not _preferred_pdf_render_source_path(state):
            return None
        else:
            logger.warning(
                "BuilderArtifact: PDF ceiling found source but no render attempt "
                "reason=pdf_render_tool_not_attempted"
            )
        fallback = BuilderArtifactMiddleware._pdf_no_deliverable_fallback(
            steps_completed=steps_completed,
        )
        return _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pdf_render_tool_not_attempted",
        )

    @staticmethod
    def _requested_pptx_without_generation_fallback(
        state: BuilderArtifactState,
        *,
        promoted_path: str | None,
        steps_completed: int,
    ) -> dict[str, Any] | None:
        if (
            not promoted_path
            or not _requested_pptx_artifact(state)
            or _pptx_fallback_generation_attempt_satisfied(state)
        ):
            return None
        promoted_suffix = PurePosixPath(promoted_path).suffix.lower()
        if promoted_suffix == ".pptx":
            return None
        logger.warning(
            "BuilderArtifact: PPTX ceiling fallback refused before "
            "generator attempt source_ext=%s",
            promoted_suffix.lstrip(".") or None,
        )
        fallback = BuilderArtifactMiddleware._pptx_no_deliverable_fallback(
            steps_completed=steps_completed,
        )
        return _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pptx_generation_not_completed",
        )

    @staticmethod
    def _build_ceiling_fallback(
        state: BuilderArtifactState,
        *,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        """Synthesize a ``builder_result`` dict by scanning ``outputs/`` for
        a deliverable to promote.

        Used by both the hard-ceiling termination path
        (``non_artifact_turns >= _CEILING_FOR_FORCE``) and the
        consecutive-rejection short-circuit path (PR #94, when the model
        emits ``artifact_path=None`` repeatedly under forced emit).

        Promotion priority:

        1. Preferred binary deliverable extension (``.pdf/.pptx/.docx/.xlsx/
           .png/.jpg/.jpeg/.svg/.html/.zip``) — confidence=0.5, "recovered".
        2. Generator script (``_generate_*.py``) — confidence=0.4, partial
           deliverable with a "run it yourself" companion summary.
        3. Apology fallback (``artifact_path=None``, confidence=0.2) — when
           neither category matches.

        ``reason`` is included in log lines so traces can distinguish ceiling
        terminations from rejection short-circuits.

        PDF requests are stricter than generic binary fallbacks: a
        ``_generate_*.py`` file is never a successful PDF artifact. If
        ``render_markdown_to_pdf`` cannot produce a PDF, the only acceptable
        degraded deliverable is the Markdown source; otherwise fail truthfully.
        """
        requested_pdf = _requested_pdf_artifact(state)
        requested_pptx = _requested_pptx_artifact(state)
        promoted_path, promoted_type = BuilderArtifactMiddleware._promoted_deliverable_from_outputs(
            state,
            requested_pdf=requested_pdf,
            requested_pptx=requested_pptx,
            reason=reason,
        )
        fallback = BuilderArtifactMiddleware._requested_pdf_without_render_fallback(
            state,
            promoted_path=promoted_path,
            steps_completed=steps_completed,
        )
        if fallback is not None:
            return fallback
        fallback = BuilderArtifactMiddleware._requested_pptx_without_generation_fallback(
            state,
            promoted_path=promoted_path,
            steps_completed=steps_completed,
        )
        if fallback is not None:
            return fallback
        if promoted_path:
            fallback = BuilderArtifactMiddleware._recovered_deliverable_fallback(
                promoted_path,
                promoted_type,
                steps_completed=steps_completed,
            )
            return _apply_artifact_request_metadata(
                fallback,
                state,
                fallback_reason="pptx_generation_not_completed" if requested_pptx else reason,
            )
        fallback = BuilderArtifactMiddleware._requested_pdf_without_render_fallback(
            state,
            promoted_path=None,
            steps_completed=steps_completed,
        )
        if fallback is not None:
            return fallback
        promoted_generator_path = BuilderArtifactMiddleware._promoted_generator_from_outputs(
            state,
            requested_pdf=requested_pdf,
            requested_pptx=requested_pptx,
            reason=reason,
        )
        if promoted_generator_path:
            fallback = BuilderArtifactMiddleware._generator_script_fallback(
                promoted_generator_path,
                steps_completed=steps_completed,
            )
            return _apply_artifact_request_metadata(fallback, state, fallback_reason=reason)
        if requested_pdf:
            fallback = BuilderArtifactMiddleware._pdf_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return _apply_artifact_request_metadata(fallback, state, fallback_reason=reason)
        if requested_pptx:
            fallback = BuilderArtifactMiddleware._pptx_no_deliverable_fallback(
                steps_completed=steps_completed,
            )
            return _apply_artifact_request_metadata(fallback, state, fallback_reason=reason)
        return BuilderArtifactMiddleware._generic_no_deliverable_fallback(
            steps_completed=steps_completed,
        )

    @staticmethod
    def _upload_fallback_and_fire(
        state: BuilderArtifactState,
        runtime: Runtime,
        fallback: dict[str, Any],
        status: str,
    ) -> None:
        """Mirror the ceiling-fallback file to Supabase BEFORE firing the
        completion webhook.

        Phase 4L (2026-05-19): the two ceiling-fallback call sites used
        to fire ``fire_completion_webhook_from_artifact`` directly,
        without uploading the promoted file. If ``SOPHIA_SUPABASE_MIRROR_ALL``
        wasn't enabled (or the per-write mirror missed the file), the
        downstream signed-URL mint returned 404 and Telegram delivery
        fell back to plaintext. Mirrors the upload step from the normal
        happy path at ``after_model`` (the lines that resolve
        ``upload_thread_id`` and call ``_upload_builder_outputs_to_supabase``).

        Safe to call when ``fallback["artifact_path"]`` is None:
        ``maybe_mirror_file`` is a no-op for missing paths, and
        ``_upload_builder_outputs_to_supabase`` short-circuits when
        ``outputs_host_path`` or ``thread_id`` is unset. The upload
        helper also documents "Any failure is logged and swallowed so
        builder flow never regresses" — so if the upload raises, the
        webhook still fires (the placeholder is finalized; delivery
        may still degrade to plaintext, which is the pre-Phase-4L
        behavior — i.e. no regression).
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        )
        delegation = state.get("delegation_context")
        parent_thread_id = (
            delegation.get("parent_thread_id") if isinstance(delegation, dict) else None
        )
        builder_thread_id = (
            runtime.context.get("thread_id") if getattr(runtime, "context", None) else None
        )
        upload_thread_id = parent_thread_id or builder_thread_id
        fallback = _apply_visual_missing_fallback_metadata(fallback, state)
        _upload_builder_outputs_to_supabase(
            thread_id=upload_thread_id,
            outputs_host_path=outputs_host_path,
            artifact_args=fallback,
        )
        fire_completion_webhook_from_artifact(
            state=state,
            runtime=runtime,
            artifact=fallback,
            status=status,
        )

    @staticmethod
    def _has_generator_script(state: BuilderArtifactState) -> bool:
        """Return True if a builder-produced ``_generate_*.py`` script exists.

        PR-B (2026-04-28): companion to ``_has_output_file`` for the three-
        stage forced-emit path. The builder prompt instructs binary tasks
        to write ``_generate_<name>.py`` then bash-run it. When no binary
        deliverable has landed yet but a generator script has, the recovery
        action is running the script (force ``bash``), not writing yet
        another script (force ``write_file``).

        Same staleness filtering as ``_has_output_file``: ignores generators
        from prior builder tasks via ``builder_task_started_at_ms``.
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                # Match generator scripts produced by the builder per the
                # binary-deliverable prompt (``_generate_<name>.py``).
                if not (entry.name.startswith("_generate_") and entry.suffix.lower() == ".py"):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
        except OSError:
            logger.debug(
                "BuilderArtifact._has_generator_script: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            # Conservative on error: report no generator so the existing
            # write_file forcing path proceeds.
            return False
        return False

    @classmethod
    def _artifact_files_exist(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        """Verify that every file referenced in the emit args exists on disk or in Supabase.

        PR-D (2026-04-24): prevents phantom artifacts where the builder calls
        emit_builder_artifact before the file has actually been written.
        Returns ``True`` only when ALL referenced paths resolve to an existing
        local file OR an existing Supabase object.

        PR-A (2026-04-27): tightened the empty-candidates fast-path. When the
        model is in the forced-emit window (``_should_force_emit`` is True),
        an empty ``artifact_path`` is treated as ESCAPE-HATCH-INVALID: it
        almost always means the model gave up under tool_choice pressure
        and is emitting nothing. We reject so the hard-ceiling fallback
        path (which scans outputs/ and produces a deterministic
        confidence=0.5 promotion or confidence=0.2 apology) can take over.
        Outside the forced-emit window the old behaviour applies — text-only
        / conceptual artifacts are still accepted.
        """
        if _requested_pdf_artifact(state) and not cls._pdf_artifact_args_valid(artifact_args, state):
            return False
        if _requested_pptx_artifact(state) and not cls._pptx_artifact_args_valid(artifact_args, state, runtime):
            return False
        candidates = _emit_candidate_paths(artifact_args)
        if not candidates:
            # Reject empty artifact_path under EITHER turn-count pressure
            # (existing) OR wall-clock pressure (new). Both indicate the
            # model is emitting under tool_choice pressure with no real
            # deliverable to point at — let the hard-ceiling fallback
            # promote a real file or surface a deterministic apology.
            if cls._should_force_emit(state) or cls._should_force_emit_by_clock(state, runtime):
                logger.warning(
                    "BuilderArtifact: rejecting empty artifact_path during "
                    "forced-emit (non_artifact_turns=%s) — letting hard "
                    "ceiling fallback promote a real file or surface a "
                    "deterministic apology instead of a phantom emit.",
                    state.get("builder_non_artifact_turns"),
                )
                return False
            # No files referenced AND not under forced-emit pressure —
            # accept (builder may be emitting a text-only or conceptual
            # result).
            return True

        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        remote_thread_ids = _artifact_remote_thread_ids(state, runtime)

        for candidate in candidates:
            if not _emit_candidate_verified(
                candidate,
                outputs_host_path=outputs_host_path,
                remote_thread_ids=remote_thread_ids,
            ):
                return False

        visual_ok = _visual_presence_validated(artifact_args, state)
        logger.info(
            "[BuilderVisualDiagnostics] phase=emit_validation visuals_requested=%s "
            "design_skill_read=%s visual_asset_success_count=%d "
            "visual_presence_validated=%s requested_ext=%s final_ext=%s",
            _visuals_requested(state),
            _visual_design_skill_read_seen(state),
            _visual_asset_success_count(state),
            visual_ok,
            _requested_artifact_ext(state),
            _artifact_path_suffix_label(artifact_args.get("artifact_path")),
        )
        if not visual_ok:
            logger.warning(
                "[BuilderVisualDiagnostics] phase=emit_visual_missing_soft_pass "
                "requested_ext=%s final_ext=%s visual assets are support-only; "
                "allowing artifact truth validation to continue",
                _requested_artifact_ext(state),
                _artifact_path_suffix_label(artifact_args.get("artifact_path")),
            )

        return True

    @staticmethod
    def _pptx_artifact_args_valid(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        primary = artifact_args.get("artifact_path")
        rejection_reason = _pptx_artifact_path_rejection_reason(primary, state)
        if rejection_reason is not None:
            _log_pptx_diagnostics(
                phase="emit_rejected",
                state=state,
                artifact_path=primary,
                integrity_reason=rejection_reason,
            )
            BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, rejection_reason)
            return False
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return False
        canonical_suffix = PurePosixPath(canonical_primary).suffix.lower()
        if canonical_suffix in _PPTX_FALLBACK_EXTENSIONS:
            if not _pptx_fallback_generation_attempt_satisfied(state):
                _log_pptx_diagnostics(
                    phase="emit_rejected",
                    state=state,
                    artifact_path=primary,
                    integrity_reason="pptx_fallback_before_generation_attempt",
                )
                BuilderArtifactMiddleware._log_pptx_artifact_rejection(
                    primary,
                    "pptx_fallback_before_generation_attempt",
                )
                return False
            if BuilderArtifactMiddleware._has_valid_pptx_output(state):
                _log_pptx_diagnostics(
                    phase="emit_rejected",
                    state=state,
                    artifact_path=primary,
                    integrity_reason="pptx_fallback_when_valid_deck_exists",
                )
                BuilderArtifactMiddleware._log_pptx_artifact_rejection(
                    primary,
                    "pptx_fallback_when_valid_deck_exists",
                )
                return False
        integrity_rejection = _pptx_path_integrity_rejection_reason(canonical_primary, state, runtime)
        if integrity_rejection is not None:
            _log_pptx_diagnostics(
                phase="emit_rejected",
                state=state,
                artifact_path=primary,
                integrity_reason=integrity_rejection,
            )
            BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, integrity_rejection)
            return False
        html_fallback_rejection = _pptx_html_fallback_integrity_rejection_reason(canonical_primary, state, runtime)
        if html_fallback_rejection is not None:
            _log_pptx_diagnostics(
                phase="emit_rejected",
                state=state,
                artifact_path=primary,
                integrity_reason=html_fallback_rejection,
            )
            BuilderArtifactMiddleware._log_pptx_artifact_rejection(primary, html_fallback_rejection)
            return False
        artifact_args["artifact_path"] = canonical_primary
        _apply_artifact_request_metadata(
            artifact_args,
            state,
            fallback_reason="pptx_generation_not_completed",
        )
        return True

    @staticmethod
    def _log_pptx_artifact_rejection(primary: object, rejection_reason: str) -> None:
        rejected_ext = PurePosixPath(str(primary or "")).suffix.lower().lstrip(".") or None
        logger.warning(
            "BuilderArtifact: rejecting PPTX artifact path reason=%s "
            "requested_ext=pptx rejected_ext=%s",
            rejection_reason,
            rejected_ext,
        )

    @staticmethod
    def _pdf_artifact_args_valid(
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> bool:
        primary = artifact_args.get("artifact_path")
        rejection_reason = _pdf_artifact_path_rejection_reason(primary, state)
        if rejection_reason is not None:
            BuilderArtifactMiddleware._log_pdf_artifact_rejection(primary, rejection_reason, state)
            return False
        return BuilderArtifactMiddleware._canonicalize_pdf_artifact_path(artifact_args, primary)

    @staticmethod
    def _log_pdf_artifact_rejection(
        primary: object,
        rejection_reason: str,
        state: BuilderArtifactState,
    ) -> None:
        rejected_ext = PurePosixPath(str(primary or "")).suffix.lower().lstrip(".") or None
        logger.warning(
            "BuilderArtifact: rejecting PDF artifact path reason=%s "
            "requested_ext=pdf render_tool_attempted=%s fallback_ext=%s "
            "rejected_ext=%s",
            rejection_reason,
            _render_markdown_to_pdf_attempted(state),
            _pdf_fallback_suffix(state).lstrip("."),
            rejected_ext,
        )
        if not _render_markdown_to_pdf_attempted(state):
            BuilderArtifactMiddleware._log_missing_pdf_render_attempt_if_needed(
                state,
                {"artifact_path": primary},
            )

    @staticmethod
    def _canonicalize_pdf_artifact_path(
        artifact_args: dict[str, Any],
        primary: object,
    ) -> bool:
        canonical_primary = _canonical_outputs_artifact_path(primary)
        if canonical_primary is None:
            return False
        artifact_args["artifact_path"] = canonical_primary
        return True

    @classmethod
    def _missing_artifact_recovery_hint(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        primary = artifact_args.get("artifact_path")
        outputs_host_path = _outputs_host_path_from_state(state)
        if not isinstance(primary, str) or not primary.strip() or not outputs_host_path:
            return ""
        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return ""
            requested_suffix = Path(primary).suffix.lower()
            min_mtime = _builder_started_min_mtime(state)
            candidates = [
                entry for entry in outputs_root.rglob("*")
                if _is_recovery_candidate(entry, requested_suffix=requested_suffix, min_mtime=min_mtime)
            ]
        except OSError:
            logger.debug(
                "BuilderArtifact: missing-path recovery scan failed outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return ""
        return _recovery_hint(outputs_root, candidates)

    @classmethod
    def _emit_rejection_message(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
    ) -> str:
        if _visuals_requested(state) and not _visual_presence_validated(artifact_args, state):
            return (
                "Error: emit_builder_artifact rejected — the user requested charts, "
                "diagrams, or visuals, but the artifact does not contain verified "
                "visual evidence yet. Read /mnt/skills/public/visual-design/SKILL.md "
                "if you have not already, create a local visual with generate_visual_asset "
                "under /mnt/user-data/outputs/visuals/, then embed or reference it before "
                "emitting. Inline SVG in HTML also counts."
            )
        if _requested_pdf_artifact(state):
            primary = artifact_args.get("artifact_path")
            reason = _pdf_artifact_path_rejection_reason(primary, state)
            if reason is not None:
                fallback_ext = _pdf_fallback_suffix(state)
                if reason == "pdf_fallback_before_render_attempt":
                    return (
                        "Error: emit_builder_artifact rejected — this is a PDF request, "
                        "so you must attempt render_markdown_to_pdf before emitting a "
                        f"{fallback_ext} fallback. If rendering fails, emit the "
                        f"{fallback_ext} fallback from /mnt/user-data/outputs/."
                    )
                return (
                    "Error: emit_builder_artifact rejected — this is a PDF request. "
                    "The final artifact must be a real .pdf, or the approved "
                    f"{fallback_ext} fallback after a render_markdown_to_pdf attempt. "
                    "Do not emit Python files, generator scripts, bare paths, or "
                    "files outside /mnt/user-data/outputs/ as the user-ready artifact."
                )
        if _requested_pptx_artifact(state):
            fallback_ext = _pptx_fallback_suffix(state)
            return (
                "Error: emit_builder_artifact rejected — this is a slide-deck "
                "request. The final artifact must be a structurally valid .pptx "
                "PowerPoint package under /mnt/user-data/outputs/, or a real "
                f"{fallback_ext} fallback if deck generation cannot complete. "
                "Use the ppt-generation skill workflow, then emit only the valid "
                "deck or fallback. Do not emit Python files, placeholder decks, "
                "tiny/corrupt .pptx files, bare paths, or files outside outputs. "
                "If using HTML fallback, write a complete standalone HTML document "
                "with <!doctype html>, <html>, <head>, and <body>; do not wrap it "
                "in Markdown fences and do not HTML-escape the document source."
            )
        recovery_hint = cls._missing_artifact_recovery_hint(artifact_args, state)
        return (
            "Error: emit_builder_artifact rejected — the referenced "
            f"artifact file ({artifact_args.get('artifact_path')}) does not exist "
            "on disk or in remote storage. Please write the file first, "
            "then call emit_builder_artifact again."
            f"{recovery_hint}"
        )

    @classmethod
    def _recover_emit_args_from_last_write(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        recovered_path = (
            cls._preferred_successful_pdf_render_path(state, runtime)
            or cls._preferred_successful_deliverable_path(state, runtime)
        )
        if not recovered_path:
            return None
        recovered_args = dict(artifact_args)
        recovered_args["artifact_path"] = recovered_path
        if not cls._artifact_files_exist(recovered_args, state, runtime):
            return None
        logger.warning(
            "BuilderArtifact: emit_path_missing recovered_from_last_successful_write ext=%s",
            Path(recovered_path).suffix.lower().lstrip(".") or None,
        )
        return recovered_args

    @classmethod
    def _authoritative_pdf_emit_args(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        pdf_path = cls._preferred_successful_pdf_render_path(state, runtime)
        if not pdf_path:
            return None
        current_path = _canonical_outputs_artifact_path(artifact_args.get("artifact_path"))
        current_ext = _artifact_ext_from_path(current_path or artifact_args.get("artifact_path"))
        if current_path == pdf_path and current_ext == "pdf":
            return None
        authoritative_args = dict(artifact_args)
        authoritative_args["artifact_path"] = pdf_path
        authoritative_args["requested_artifact_ext"] = "pdf"
        authoritative_args["artifact_ext"] = "pdf"
        authoritative_args["artifact_is_fallback"] = False
        authoritative_args["fallback_reason"] = None
        authoritative_args["artifact_type"] = "pdf"
        logger.warning(
            "BuilderArtifact: pdf_emit_overrode_stale_fallback "
            "requested_ext=pdf emitted_ext=%s layout_quality=%s",
            current_ext,
            _pdf_render_layout_quality(state),
        )
        return authoritative_args

    @classmethod
    def _preferred_successful_pdf_render_path(
        cls,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        if not _requested_pdf_artifact(state) or not _successful_pdf_ready_to_emit(state):
            return None
        result = _successful_pdf_render_result(state)
        if result is None:
            return None
        pdf_path = _canonical_outputs_artifact_path(result.get("pdf_path"))
        if pdf_path is None:
            return None
        if cls._artifact_files_exist({"artifact_path": pdf_path}, state, runtime):
            return pdf_path
        return None

    @staticmethod
    def _successful_output_paths(state: BuilderArtifactState) -> list[str]:
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return []
        return [
            path
            for path in (diagnostics.get("successful_output_paths") or [])
            if isinstance(path, str) and _extract_output_relative_path(path) is not None
        ]

    @staticmethod
    def _successful_deliverable_output_paths(state: BuilderArtifactState) -> list[str]:
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict):
            return []
        explicit = [
            path
            for path in (diagnostics.get("successful_deliverable_output_paths") or [])
            if isinstance(path, str) and _is_user_facing_output_path(path)
        ]
        if explicit:
            return explicit
        return [
            path
            for path in BuilderArtifactMiddleware._successful_output_paths(state)
            if _is_user_facing_output_path(path)
        ]

    @staticmethod
    def _target_artifact_path(state: BuilderArtifactState) -> str | None:
        target = state.get("builder_artifact_target_path")
        if isinstance(target, str) and _extract_output_relative_path(target) is not None:
            return target
        delegation = state.get("delegation_context")
        if isinstance(delegation, dict):
            delegated = delegation.get("artifact_target_path")
            if isinstance(delegated, str) and _extract_output_relative_path(delegated) is not None:
                return delegated
        return None

    @classmethod
    def _preferred_successful_deliverable_path(
        cls,
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        paths = cls._allowed_successful_deliverable_paths(state)
        diagnostics = state.get("builder_write_diagnostics") or {}
        target_path = cls._target_artifact_path(state)
        target_match = cls._preferred_target_deliverable_path(target_path, paths, state, runtime)
        if target_match is not None:
            return target_match

        target_suffix = Path(target_path or "").suffix.lower()
        matching = [
            path for path in paths
            if not target_suffix or Path(path).suffix.lower() == target_suffix
        ]
        if len(matching) == 1:
            return matching[0]

        last_successful = cls._last_successful_deliverable_path(diagnostics)
        last_match = cls._preferred_last_successful_path(
            last_successful,
            paths=paths,
            matching=matching,
        )
        if last_match is not None:
            return last_match

        if len(paths) == 1:
            return paths[0]
        return None

    @classmethod
    def _allowed_successful_deliverable_paths(cls, state: BuilderArtifactState) -> list[str]:
        paths = cls._successful_deliverable_output_paths(state)
        if _requested_pdf_artifact(state):
            return [
                path for path in paths
                if PurePosixPath(path).suffix.lower() in _allowed_pdf_artifact_suffixes(state)
            ]
        if _requested_pptx_artifact(state):
            return [
                path for path in paths
                if PurePosixPath(path).suffix.lower() in _allowed_pptx_artifact_suffixes(state)
            ]
        return paths

    @classmethod
    def _preferred_target_deliverable_path(
        cls,
        target_path: str | None,
        paths: list[str],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> str | None:
        if not target_path or not _is_user_facing_output_path(target_path):
            return None
        target_args = {"artifact_path": target_path}
        if target_path in paths or cls._artifact_files_exist(target_args, state, runtime):
            return target_path
        return None

    @staticmethod
    def _last_successful_deliverable_path(diagnostics: object) -> str | None:
        if not isinstance(diagnostics, dict):
            return None
        path = diagnostics.get("last_successful_deliverable_output_path")
        return path if isinstance(path, str) else None

    @staticmethod
    def _preferred_last_successful_path(
        last_successful: str | None,
        *,
        paths: list[str],
        matching: list[str],
    ) -> str | None:
        if last_successful is None:
            return None
        if last_successful in matching:
            return last_successful
        if not matching and last_successful in paths:
            return last_successful
        return None

    @staticmethod
    def _build_recovered_artifact_result(
        artifact_path: str,
        *,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        artifact_type = Path(artifact_path).suffix.lower().lstrip(".") or "unknown"
        logger.warning(
            "BuilderArtifact: promoting recovered deliverable reason=%s ext=%s",
            reason,
            artifact_type or None,
        )
        return {
            "artifact_path": artifact_path,
            "artifact_type": artifact_type,
            "artifact_title": "Build task completed (recovered)",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                "The builder wrote a deliverable but did not emit it cleanly, "
                "so I recovered the completed file from the output directory."
            ),
            "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
            "user_next_action": "Open the file and let me know if it lands.",
            "confidence": 0.55,
        }

    @classmethod
    def _recover_missing_emit_args_if_possible(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> dict[str, Any]:
        authoritative_pdf = cls._authoritative_pdf_emit_args(artifact_args, state, runtime)
        if authoritative_pdf is not None:
            return authoritative_pdf
        if cls._artifact_files_exist(artifact_args, state, runtime):
            return artifact_args
        return cls._recover_emit_args_from_last_write(artifact_args, state, runtime) or artifact_args

    def _force_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        """Three-stage forced-tool-choice (PR-A + PR-B) with wall-clock awareness.

        Activates when EITHER the turn-count ceiling is imminent
        (``_should_force_emit``) OR the wall-clock fraction of the per-run
        timeout has been crossed (``_should_force_emit_by_clock``). The
        stage selection within the force window is what changed in PR-B
        for binary deliverables that have written a generator but failed
        to produce the final binary.

        Returns the Anthropic ``tool_choice`` payload appropriate for the
        current state:

        - ``None`` when forcing isn't required yet.
        - ``{"type": "tool", "name": "emit_builder_artifact"}`` when a
          user-facing binary already exists on disk — proceed with emit.
        - ``{"type": "tool", "name": "bash"}`` (PR-B) when no binary exists
          but a ``_generate_*.py`` does — recovery for binary deliverables
          is to RUN the generator, not write yet another one. After this
          forced bash either produces a binary (next turn flips to emit)
          or doesn't (hard-ceiling fallback promotes the script itself).
        - ``{"type": "tool", "name": "write_file"}`` when neither a binary
          nor a generator exists — the model has produced nothing on disk
          and needs to land at least one file before emit is forced.
        """
        return (
            self._pdf_terminal_tool_choice_for_state(state)
            or self._simple_pdf_tool_choice_for_state(state)
            or self._research_tool_choice_for_state(state)
            or self._visual_tool_choice_for_state(state)
            or self._pdf_render_source_tool_choice_for_state(state)
            or self._completion_tool_choice_for_state(state, runtime)
        )

    def _simple_pdf_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_simple_pdf_artifact(state):
            return None
        if _simple_pdf_writer_attempted(state) or self._has_requested_pdf_binary(state):
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=%s for simple PDF artifact path",
            _SIMPLE_PDF_TOOL_NAME,
        )
        return self._forced_simple_pdf_tool_choice()

    def _pdf_terminal_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state) or not _successful_pdf_ready_to_emit(state):
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=emit_builder_artifact after "
            "successful PDF render (layout_quality=%s repair_attempts=%d)",
            _pdf_render_layout_quality(state),
            _pdf_layout_repair_attempts(state),
        )
        return self._forced_tool_choice()

    def _pdf_render_source_tool_choice_for_state(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state):
            return None
        if self._has_requested_pdf_binary(state) or _render_markdown_to_pdf_attempted(state):
            return None
        source_path = _preferred_pdf_render_source_path(state)
        if not source_path:
            return None
        logger.warning(
            "BuilderArtifact: forcing tool_choice=render_markdown_to_pdf "
            "because PDF source exists before render source_ext=%s",
            PurePosixPath(source_path).suffix.lower().lstrip(".") or None,
        )
        return self._forced_pdf_render_tool_choice()

    # Phase 2F.3: after N consecutive write_file_tool errors, inject a
    # corrective HumanMessage so the model breaks out of the loop and
    # writes to the canonical /mnt/user-data/outputs/ path. The threshold
    # is intentionally tight (3) so we recover fast; idempotency is
    # tracked via ``builder_path_correction_emitted`` in state.
    _PATH_CORRECTION_ERROR_THRESHOLD = 3
    _PATH_CORRECTION_LOOKBACK = 8  # cap scan range so we don't walk huge histories

    @staticmethod
    def _count_trailing_write_file_errors(messages: list, lookback: int) -> int:
        """Count trailing ToolMessages from write_file_tool whose content
        starts with "Error". Stops at the first non-error / non-write_file
        ToolMessage so we only count an UNBROKEN trailing streak.

        Other message types (AIMessage, HumanMessage) between the
        trailing tool results are tolerated — we walk backwards through
        the most recent ToolMessages, ignoring intervening ai/human msgs,
        and count only the consecutive write_file ones.
        """
        count = 0
        scanned = 0
        for msg in reversed(messages):
            scanned += 1
            if scanned > lookback:
                break
            if not isinstance(msg, ToolMessage):
                continue
            name = getattr(msg, "name", None) or ""
            if name not in ("write_file", "write_file_tool"):
                # Non-write_file tool result — streak broken.
                return count
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content.startswith("Error"):
                count += 1
            else:
                return count
        return count

    @classmethod
    def _trailing_write_file_error_classes(
        cls,
        messages: list,
        lookback: int,
    ) -> list[str]:
        classes: list[str] = []
        scanned = 0
        for msg in reversed(messages):
            scanned += 1
            if scanned > lookback:
                break
            if not isinstance(msg, ToolMessage):
                continue
            name = getattr(msg, "name", None) or ""
            if name not in ("write_file", "write_file_tool"):
                return classes
            text = cls._tool_message_text(msg)
            if text.startswith("Error"):
                classes.append(cls._classify_write_error(text, under_outputs=None))
            else:
                return classes
        return classes

    @staticmethod
    def _tool_message_content_shape(result: ToolMessage) -> str:
        content = result.content
        if isinstance(content, str):
            return "text"
        if isinstance(content, list):
            return "list"
        if isinstance(content, dict):
            return "dict"
        if content is None:
            return "none"
        return type(content).__name__

    @staticmethod
    def _classify_write_error(text: str, under_outputs: bool | None) -> str:
        if not text.startswith("Error"):
            return ""
        lowered = text.lower()
        if "field required" in lowered and any(
            field in lowered for field in ("description", "path", "content", "command")
        ):
            return "missing_required_tool_arg"
        for error_class, markers in _WRITE_ERROR_CLASS_MARKERS:
            if any(marker in lowered for marker in markers):
                return error_class
        if under_outputs is False:
            return "path_not_outputs"
        return "write_tool_error"

    @staticmethod
    def _is_runtime_write_failure(error_class: str | None) -> bool:
        return bool(error_class and error_class in _RUNTIME_WRITE_ERROR_CLASSES)

    @staticmethod
    def _is_path_correctable_write_failure(error_class: str | None) -> bool:
        return not error_class or error_class in _PATH_CORRECTABLE_WRITE_ERROR_CLASSES

    def _write_runtime_failure_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        count: int,
        error_class: str,
    ) -> dict[str, Any]:
        logger.error(
            "[BuilderArtifact] %d consecutive write_file_tool runtime errors "
            "detected; stopping build instead of path-correcting error_class=%s",
            count,
            error_class,
        )
        fallback = self._build_ceiling_fallback(
            state,
            steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0),
            reason=f"runtime_write_failure:{error_class}",
        )
        status = "failed" if not fallback.get("artifact_path") else "completed"
        if runtime is not None:
            self._upload_fallback_and_fire(
                state=state,
                runtime=runtime,
                fallback=fallback,
                status=status,
            )
        return {
            "builder_result": fallback,
            "builder_non_artifact_turns": 0,
            "builder_task_started_at_ms": 0,
            "builder_consecutive_empty_emit_rejections": 0,
            "builder_last_missing_emit_path": None,
            "builder_consecutive_missing_emit_path_rejections": 0,
            "builder_runtime_write_failure_emitted": True,
            "jump_to": "end",
        }

    def _recovered_deliverable_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        artifact_path: str,
        reason: str,
    ) -> dict[str, Any]:
        fallback = self._build_recovered_artifact_result(
            artifact_path,
            steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0),
            reason=reason,
        )
        _apply_artifact_request_metadata(
            fallback,
            state,
            fallback_reason="pptx_generation_not_completed" if _requested_pptx_artifact(state) else reason,
        )
        if runtime is not None:
            self._upload_fallback_and_fire(
                state=state,
                runtime=runtime,
                fallback=fallback,
                status="completed",
            )
        return {
            "builder_result": fallback,
            "builder_non_artifact_turns": 0,
            "builder_task_started_at_ms": 0,
            "builder_consecutive_empty_emit_rejections": 0,
            "builder_last_missing_emit_path": None,
            "builder_consecutive_missing_emit_path_rejections": 0,
            "builder_recovered_deliverable_emitted": True,
            "jump_to": "end",
        }

    def _maybe_promote_recovered_deliverable(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        reason: str,
    ) -> dict[str, Any] | None:
        if not self._should_attempt_recovered_deliverable_promotion(state, runtime):
            return None
        candidate = self._preferred_successful_deliverable_path(state, runtime)
        if not candidate:
            return None
        if not self._artifact_files_exist({"artifact_path": candidate}, state, runtime):
            return None
        return self._recovered_deliverable_update(
            state,
            runtime,
            artifact_path=candidate,
            reason=reason,
        )

    def _should_attempt_recovered_deliverable_promotion(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
    ) -> bool:
        if state.get("builder_recovered_deliverable_emitted") or runtime is None:
            return False
        diagnostics = state.get("builder_write_diagnostics") or {}
        if not isinstance(diagnostics, dict) or diagnostics.get("last_status") != "success":
            return False
        return self._write_error_threshold_reached(state, diagnostics)

    def _write_error_threshold_reached(
        self,
        state: BuilderArtifactState,
        diagnostics: dict,
    ) -> bool:
        error_count = int(diagnostics.get("error_count", 0) or 0)
        had_correction = bool(
            state.get("builder_path_correction_emitted")
            or state.get("builder_tool_argument_correction_emitted")
        )
        return error_count >= self._PATH_CORRECTION_ERROR_THRESHOLD or had_correction

    def _write_tool_argument_failure_update(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None,
        *,
        count: int,
        error_class: str,
    ) -> dict[str, Any] | None:
        candidate = (
            self._preferred_successful_deliverable_path(state, runtime)
            if runtime is not None
            else None
        )
        if candidate and self._artifact_files_exist({"artifact_path": candidate}, state, runtime):
            return self._recovered_deliverable_update(
                state,
                runtime,
                artifact_path=candidate,
                reason=error_class,
            )

        if state.get("builder_tool_argument_correction_emitted"):
            logger.error(
                "[BuilderArtifact] repeated missing required tool arguments "
                "after correction; stopping build count=%d error_class=%s",
                count,
                error_class,
            )
            fallback = self._build_ceiling_fallback(
                state,
                steps_completed=int(state.get("builder_non_artifact_turns", 0) or 0),
                reason=f"repeated_{error_class}",
            )
            status = "failed" if not fallback.get("artifact_path") else "completed"
            if runtime is not None:
                self._upload_fallback_and_fire(
                    state=state,
                    runtime=runtime,
                    fallback=fallback,
                    status=status,
                )
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
                "builder_tool_argument_correction_emitted": True,
                "jump_to": "end",
            }

        logger.warning(
            "[BuilderArtifact] %d consecutive write_file_tool missing-argument "
            "errors detected — injecting tool-argument correction instead of "
            "path correction. error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/tool-argument correction]\n"
                "Your recent tool call was missing required arguments. "
                "Do not retry the same incomplete call.\n\n"
                "For text deliverables, call the exposed `write_file` tool with "
                "`description`, `path`, and `content` arguments, for example "
                "`write_file(description='write the final report', "
                "path='/mnt/user-data/outputs/report.html', "
                "content='<html>...</html>', append=False)`. For shell work, "
                "call `bash_tool` with a non-empty `command` argument.\n\n"
                "If you have already written the final file under "
                "`/mnt/user-data/outputs/`, call `emit_builder_artifact` with "
                "that exact path and stop."
            )
        )
        return {
            "messages": [correction],
            "builder_tool_argument_correction_emitted": True,
        }

    def _maybe_inject_path_correction(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        """Phase 2F.3: detect ``write_file_tool`` error loops and inject a
        single corrective HumanMessage so the model recovers.

        Production failure 2026-05-22 19:54-20:14 UTC: builder spent 20+
        minutes retrying write_file_tool with bare filenames (test.md,
        test2.md, etc.), each rejected with PermissionError. The model
        kept retrying with similar bad names. Phase 2F.2 fixes the bare-
        filename case via auto-prefix; Phase 2F.3 is the defensive
        escape hatch for any residual write_file-error loop.

        Idempotent: once we emit the correction (tracked via
        ``builder_path_correction_emitted``), don't emit again on this
        run. The model has already been told; further repetition adds
        noise without value.
        """
        if state.get("builder_path_correction_emitted"):
            return None
        messages = state.get("messages") or []
        count = self._count_trailing_write_file_errors(
            messages, self._PATH_CORRECTION_LOOKBACK
        )
        if count < self._PATH_CORRECTION_ERROR_THRESHOLD:
            return None
        error_class = self._write_error_class_from_state(state, messages)
        if self._is_runtime_write_failure(error_class):
            if state.get("builder_runtime_write_failure_emitted"):
                return None
            return self._write_runtime_failure_update(
                state,
                runtime,
                count=count,
                error_class=error_class,
            )
        if error_class == "missing_required_tool_arg":
            return self._write_tool_argument_failure_update(
                state,
                runtime,
                count=count,
                error_class=error_class,
            )
        if not self._is_path_correctable_write_failure(error_class):
            return None
        logger.warning(
            "[BuilderArtifact] %d consecutive write_file_tool errors detected "
            "— injecting path-correction directive (Phase 2F.3 escape hatch). "
            "error_class=%s",
            count,
            error_class,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/path-correction directive]\n"
                f"Your last {count} write_file calls all failed with "
                "errors. This usually means the path you used is not under "
                "/mnt/user-data/outputs/.\n\n"
                "STOP retrying with the same kind of path. Your NEXT "
                "`write_file` call MUST include `description`, `path`, and "
                "`content`, and the path MUST start with "
                "`/mnt/user-data/outputs/`, e.g. "
                "`write_file(description='write final document', "
                "path='/mnt/user-data/outputs/my-document.md', content='...', "
                "append=False)`. If you only had a "
                "bare filename like `report.md`, prepend "
                "`/mnt/user-data/outputs/` to it.\n\n"
                "After the file is on disk under /mnt/user-data/outputs/, "
                "call emit_builder_artifact with that exact path to deliver "
                "the artifact and end this run."
            )
        )
        return {
            "messages": [correction],
            "builder_path_correction_emitted": True,
        }

    def _write_error_class_from_state(
        self,
        state: BuilderArtifactState,
        messages: list,
    ) -> str:
        diagnostics = state.get("builder_write_diagnostics") or {}
        error_class = diagnostics.get("last_error_class") if isinstance(diagnostics, dict) else None
        if isinstance(error_class, str) and error_class:
            return error_class
        classes = self._trailing_write_file_error_classes(
            messages,
            self._PATH_CORRECTION_LOOKBACK,
        )
        return classes[0] if classes else "write_tool_error"

    @staticmethod
    def _is_post_interrupt_update(messages: list) -> bool:
        """Detect whether the latest HumanMessage in ``messages`` arrived
        AFTER the builder had already started working — the signal that
        ``update_async_task`` interrupted an in-flight run and appended a
        new user message via deepagents' ``multitask_strategy="interrupt"``.

        Heuristic: the latest message is a ``HumanMessage`` AND somewhere
        earlier in the conversation there is an ``AIMessage`` carrying
        ``tool_calls``. That AIMessage proves the builder did work (made
        tool calls) before the new user instruction landed.

        This is a one-shot trigger: as soon as the model responds, the
        latest message becomes an AIMessage and the heuristic stops
        matching for that turn-cycle. The caller resets the counter once,
        then the normal counter-increment logic runs unchanged.
        """
        if not messages:
            return False
        latest = messages[-1]
        if not isinstance(latest, HumanMessage):
            return False
        # Look backward for any AIMessage with tool_calls (builder did
        # real work before this new instruction).
        for msg in reversed(messages[:-1]):
            if isinstance(msg, AIMessage):
                tool_calls = getattr(msg, "tool_calls", None) or []
                if tool_calls:
                    return True
        return False

    @staticmethod
    def _latest_human_content(messages: list) -> str:
        if not messages or not isinstance(messages[-1], HumanMessage):
            return ""
        content = messages[-1].content
        return content if isinstance(content, str) else str(content or "")

    @staticmethod
    def _extract_update_target_path(content: str) -> str | None:
        match = _CONCRETE_FILE_TARGET_RE.search(content or "")
        if not match:
            return None
        target = match.group(1).strip()
        if not target.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            return None
        if _extract_output_relative_path(target) is None:
            return None
        return target

    def _post_interrupt_state_hints(
        self, state: BuilderArtifactState, messages: list
    ) -> dict[str, Any]:
        content = self._latest_human_content(messages)
        update: dict[str, Any] = {}
        urls = extract_explicit_user_urls(content)
        if urls:
            update["explicit_user_urls"] = urls
            update["builder_allowed_urls"] = urls
            update["builder_update_required_urls"] = urls
        target_path = self._extract_update_target_path(content)
        if target_path:
            update["builder_artifact_target_path"] = target_path
        if _FILE_TARGET_HINT_MARKER in content:
            update["builder_update_epoch"] = int(state.get("builder_update_epoch", 0) or 0) + 1
            logger.info(
                "[BuilderArtifact] post-interrupt update hints: explicit_url_count=%d target_ext=%s",
                len(urls),
                Path(target_path).suffix.lower().lstrip(".") if target_path else None,
            )
        return update

    def _maybe_reset_turn_budget(
        self, state: BuilderArtifactState
    ) -> dict[str, Any] | None:
        """Phase 2E.1: when an interrupted builder run resumes with a new
        user instruction, reset ``builder_non_artifact_turns`` to 0 so the
        post-update work gets a fresh turn budget. Without this, the
        pre-interrupt research turns count against the post-update writing
        budget and the builder hits the hard ceiling without producing a
        deliverable (production failure 2026-05-21 21:18-21:46 UTC).
        """
        messages = state.get("messages") or []
        if not self._is_post_interrupt_update(messages):
            return None
        current = int(state.get("builder_non_artifact_turns", 0) or 0)
        update = self._post_interrupt_state_hints(state, messages)
        if current > 0:
            logger.info(
                "[BuilderArtifact] post-interrupt update detected — resetting "
                "builder_non_artifact_turns: %d -> 0 (fresh budget for the update)",
                current,
            )
            update["builder_non_artifact_turns"] = 0
        return update or None

    def _maybe_inject_pdf_layout_repair(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state) or state.get("builder_pdf_layout_repair_requested"):
            return None
        result = _successful_pdf_render_result(state)
        if result is None or not _pdf_layout_repair_needed(state):
            return None
        logger.warning(
            "BuilderArtifact: requesting one PDF layout repair page_count=%s "
            "blank_page_count=%s short_page_count=%s layout_quality=%s",
            result.get("page_count"),
            result.get("blank_page_count"),
            result.get("short_page_count"),
            result.get("layout_quality"),
        )
        return {
            "messages": [HumanMessage(content=_pdf_layout_repair_message(result))],
            "builder_pdf_render_result": None,
            "builder_pdf_layout_repair_requested": True,
            "builder_pdf_layout_repair_attempts": _pdf_layout_repair_attempts(state) + 1,
        }

    def _maybe_inject_pdf_render_source_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state):
            return None
        if state.get("builder_pdf_render_correction_emitted"):
            return None
        if self._has_requested_pdf_binary(state) or _render_markdown_to_pdf_attempted(state):
            return None
        source_path = _preferred_pdf_render_source_path(state)
        if not source_path:
            return None
        pdf_path = _pdf_render_target_path(state, source_path)
        logger.warning(
            "BuilderArtifact: injecting PDF render correction source_ext=%s target_ext=pdf",
            PurePosixPath(source_path).suffix.lower().lstrip(".") or None,
        )
        return {
            "messages": [HumanMessage(content=_pdf_render_correction_message(source_path, pdf_path))],
            "builder_pdf_render_correction_emitted": True,
        }

    def _maybe_inject_pdf_source_write_directive(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pdf_artifact(state):
            return None
        if state.get("builder_pdf_source_write_directive_emitted"):
            return None
        if self._has_requested_pdf_binary(state) or _render_markdown_to_pdf_attempted(state):
            return None
        if _preferred_pdf_render_source_path(state):
            return None
        turn_force = self._should_force_emit(state)
        if not turn_force:
            return None
        target = self._target_artifact_path(state) or f"{_OUTPUTS_VIRTUAL_PREFIX}build.pdf"
        logger.warning(
            "BuilderArtifact: injecting PDF source write directive before force window"
        )
        return {
            "messages": [HumanMessage(content=_pdf_source_write_message(target))],
            "builder_pdf_source_write_directive_emitted": True,
        }

    def _maybe_inject_pptx_plan_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pptx_artifact(state):
            return None
        if state.get("builder_pptx_plan_correction_emitted"):
            return None
        diagnostics = _pptx_diagnostics(state)
        if diagnostics.get("pptx_generator_error_class") != "invalid_plan_json":
            return None
        if self._has_valid_pptx_output(state):
            return None
        logger.warning("BuilderArtifact: injecting PPTX plan JSON correction after invalid_plan_json")
        return {
            "messages": [HumanMessage(content=_pptx_plan_correction_message())],
            "builder_pptx_plan_correction_emitted": True,
        }

    def _maybe_inject_pptx_skill_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _requested_pptx_artifact(state):
            return None
        if state.get("builder_pptx_skill_correction_emitted"):
            return None
        valid_pptx_seen = self._has_valid_pptx_output(state)
        generator_invoked_seen = _pptx_generator_invoked_seen(state)
        if valid_pptx_seen or generator_invoked_seen:
            return None
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        recent_tool_names = _recent_builder_tool_names(state, limit=4)
        drifted = _pptx_recent_tools_drifted(recent_tool_names)
        if not drifted and non_artifact_turns < 3:
            return None
        _log_pptx_skill_correction(
            state,
            non_artifact_turns=non_artifact_turns,
            recent_tool_names=recent_tool_names,
            generator_invoked_seen=generator_invoked_seen,
            valid_pptx_seen=valid_pptx_seen,
        )
        return {
            "messages": [
                HumanMessage(content=_pptx_skill_correction_message(state))
            ],
            "builder_pptx_skill_correction_emitted": True,
        }

    def _maybe_inject_pptx_fallback_after_image_failure(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        # Image generation is optional for slide decks unless the user
        # explicitly asked for generated images. Do not turn image failures
        # into HTML fallback by themselves; the builder should continue with a
        # no-image PPTX and fall back only if deck composition/validation fails.
        return None
        if not _requested_pptx_artifact(state):
            return None
        if state.get("builder_pptx_fallback_directive_emitted"):
            return None
        if not state.get("builder_pptx_skill_correction_emitted"):
            return None
        if self._has_valid_pptx_output(state):
            return None
        image_attempts = _pptx_diagnostic_count(state, "image_generation_attempt_count")
        image_successes = _pptx_diagnostic_count(state, "image_generation_success_count")
        if image_attempts <= 0 or image_successes > 0:
            return None
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        if non_artifact_turns < 5:
            return None
        diagnostics = _pptx_diagnostics(state)
        fallback_ext = _pptx_fallback_suffix(state)
        logger.warning(
            "BuilderArtifact: presentation image generation produced no valid images "
            "after correction; directing explicit fallback image_attempts=%d "
            "error_class=%s fallback_ext=%s",
            image_attempts,
            diagnostics.get("image_generation_error_class"),
            fallback_ext.lstrip("."),
        )
        return {
            "messages": [
                HumanMessage(
                    content=(
                        "[Sophia/presentation fallback directive]\n"
                        "Image generation did not produce valid slide image bytes after the PPTX correction. "
                        "Stop trying to compose a PowerPoint package in this run. Create a real degraded "
                        f"{fallback_ext} fallback under `/mnt/user-data/outputs/` now, then call "
                        "emit_builder_artifact for that fallback with explicit fallback metadata: "
                        "`requested_artifact_ext='pptx'`, `artifact_is_fallback=true`, and "
                        "`fallback_reason='pptx_generation_not_completed'`. "
                        "If the fallback is HTML, it must be standalone browser-renderable HTML with "
                        "`<!doctype html>`, `<html>`, `<head>`, and `<body>`; no Markdown fences. "
                        "Do not emit Python scripts, test files, or placeholder PPTX files."
                    )
                )
            ],
            "builder_pptx_fallback_directive_emitted": True,
        }

    def _maybe_inject_visual_design_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _visuals_requested(state):
            return None
        if _visual_design_skill_read_seen(state):
            return None
        if state.get("builder_visual_design_correction_emitted"):
            return None
        logger.warning(
            "[BuilderVisualDiagnostics] phase=design_skill_required design_skill_read=false"
        )
        return {
            "messages": [HumanMessage(content=_visual_design_skill_message())],
            "builder_visual_design_correction_emitted": True,
        }

    def _maybe_inject_visual_asset_correction(self, state: BuilderArtifactState) -> dict[str, Any] | None:
        if not _visuals_requested(state):
            return None
        if not (_requested_pdf_artifact(state) or _requested_pptx_artifact(state)):
            return None
        if not _visual_design_skill_read_seen(state):
            return None
        if _visual_asset_success_count(state) > 0:
            return None
        if state.get("builder_visual_asset_correction_emitted"):
            return None
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        if non_artifact_turns < 2:
            return None
        logger.warning(
            "[BuilderVisualDiagnostics] phase=asset_required requested_ext=%s "
            "asset_success_count=0",
            _requested_artifact_ext(state),
        )
        return {
            "messages": [HumanMessage(content=_visual_asset_required_message(state))],
            "builder_visual_asset_correction_emitted": True,
        }

    def _combined_before_model_updates(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict | None:
        """Run all before_model state-update probes (Phase 2E.1 turn-budget
        reset + Phase 2F.3 path-correction injection) and merge their
        returns into a single update dict for the langgraph reducer."""
        update: dict[str, Any] = {}
        reset = self._maybe_reset_turn_budget(state)
        if isinstance(reset, dict):
            update.update(reset)
        promotion = self._maybe_promote_recovered_deliverable(
            state,
            runtime,
            reason="successful_write_after_correction",
        )
        if isinstance(promotion, dict):
            update.update(promotion)
            return update
        visual_design = self._maybe_inject_visual_design_correction(state)
        if isinstance(visual_design, dict):
            update.update(visual_design)
            return update
        visual_asset = self._maybe_inject_visual_asset_correction(state)
        if isinstance(visual_asset, dict):
            update.update(visual_asset)
            return update
        pdf_render = self._maybe_inject_pdf_render_source_correction(state)
        if isinstance(pdf_render, dict):
            update.update(pdf_render)
            return update
        pdf_repair = self._maybe_inject_pdf_layout_repair(state)
        if isinstance(pdf_repair, dict):
            update.update(pdf_repair)
            return update
        pdf_source_write = self._maybe_inject_pdf_source_write_directive(state)
        if isinstance(pdf_source_write, dict):
            update.update(pdf_source_write)
            return update
        pptx_plan = self._maybe_inject_pptx_plan_correction(state)
        if isinstance(pptx_plan, dict):
            update.update(pptx_plan)
            return update
        pptx_fallback = self._maybe_inject_pptx_fallback_after_image_failure(state)
        if isinstance(pptx_fallback, dict):
            update.update(pptx_fallback)
            return update
        pptx_correction = self._maybe_inject_pptx_skill_correction(state)
        if isinstance(pptx_correction, dict):
            update.update(pptx_correction)
            return update
        correction = self._maybe_inject_path_correction(state, runtime)
        if isinstance(correction, dict):
            # Merge: ``messages`` reducer concatenates, scalar flags overwrite.
            for key, value in correction.items():
                update[key] = value
        return update or None

    @hook_config(can_jump_to=["end"])
    @override
    def before_model(
        self, state: BuilderArtifactState, runtime: Runtime | None = None
    ) -> dict | None:
        return self._combined_before_model_updates(state, runtime)

    @hook_config(can_jump_to=["end"])
    @override
    async def abefore_model(
        self, state: BuilderArtifactState, runtime: Runtime | None = None
    ) -> dict | None:
        return self._combined_before_model_updates(state, runtime)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force tool_choice when ceiling is imminent (two-stage)."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same two-stage logic as wrap_model_call."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return await handler(request)

    def _block_substantive_tool_before_research(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        if not self._is_substantive_before_research_tool(request.state, request.tool_call):
            return None

        tool_name = request.tool_call.get("name") or "unknown"
        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "[BuilderResearchEnforcement] blocked_content_tool_before_research "
            "tool=%s",
            tool_name,
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: research-before-write enforcement blocked this tool call. "
                            "You may keep your plan, but before writing, editing, running "
                            "artifact-generating bash, or emitting the artifact, call "
                            "builder_web_search first, then builder_web_fetch on one approved "
                            "result URL for factual document/PDF work. If the web tool fails "
                            "or returns weak results, continue afterward with the best "
                            "available context."
                        ),
                        tool_call_id=tool_call_id,
                        name=str(tool_name),
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    def _block_visual_asset_before_design_skill(
        self,
        request: ToolCallRequest,
    ) -> Command | None:
        tool_name = request.tool_call.get("name")
        if tool_name not in _VISUAL_ASSET_TOOL_NAMES:
            return None
        if not _visuals_requested(request.state):
            return None
        if _visual_design_skill_read_seen(request.state):
            return None

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "[BuilderVisualDiagnostics] blocked_visual_asset_before_design_skill "
            "tool=%s",
            tool_name,
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: visual-design enforcement blocked this tool call. "
                            "Before creating chart or diagram assets, read the design "
                            "skill with `read_file(description='read visual design skill', "
                            "path='/mnt/skills/public/visual-design/SKILL.md')`, then "
                            "call generate_visual_asset again."
                        ),
                        tool_call_id=tool_call_id,
                        name=str(tool_name or "generate_visual_asset"),
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @staticmethod
    def _normalized_write_path(tool_call: dict[str, Any]) -> str | None:
        args = tool_call.get("args") or {}
        if not isinstance(args, dict):
            return None
        raw_path = args.get("path") or args.get("file_path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            return None
        return BuilderArtifactMiddleware._normalize_requested_write_path(raw_path.strip())

    @staticmethod
    def _normalize_requested_write_path(path: str) -> str:
        if path.startswith(_OUTPUTS_VIRTUAL_PREFIX):
            return path
        if "/" not in path and "\\" not in path:
            return _OUTPUTS_VIRTUAL_PREFIX + path
        return path

    @staticmethod
    def _tool_message_text(result: ToolMessage) -> str:
        content = result.content
        if isinstance(content, str):
            return content
        return str(content or "")

    def _write_result_delta(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> dict[str, Any]:
        text = self._tool_message_text(result).strip()
        success = text.startswith("OK")
        path = self._normalized_write_path(request.tool_call)
        ext, under_outputs = self._write_path_metadata(path)
        delta: dict[str, Any] = {
            "success_count": 1 if success else 0,
            "error_count": 0 if success else 1,
            "last_content_shape": self._tool_message_content_shape(result),
            "last_ext": ext,
            "last_under_outputs": under_outputs,
            "last_status": "success" if success else "error",
        }
        if not success:
            delta["last_error_class"] = self._classify_write_error(text, under_outputs)
        if success and under_outputs and path:
            delta["last_successful_output_path"] = path
            delta["successful_output_paths"] = [path]
            if _is_user_facing_output_path(path):
                delta["last_successful_deliverable_output_path"] = path
                delta["successful_deliverable_output_paths"] = [path]
        return delta

    @staticmethod
    def _write_path_metadata(path: str | None) -> tuple[str, bool]:
        if not path:
            return "", False
        return Path(path).suffix.lower().lstrip("."), _extract_output_relative_path(path) is not None

    def _write_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name not in _BUILDER_WRITE_TOOL_NAMES or not isinstance(result, ToolMessage):
            return result

        delta = self._write_result_delta(request, result)
        logger.info(
            "[BuilderWriteDiagnostics] tool=%s status=%s path_under_outputs=%s "
            "ext=%s error_class=%s content_shape=%s",
            tool_name,
            delta["last_status"],
            delta["last_under_outputs"],
            delta["last_ext"] or None,
            delta.get("last_error_class"),
            delta.get("last_content_shape"),
        )
        return Command(
            update={
                "messages": [result],
                "builder_write_diagnostics": delta,
            }
        )

    @staticmethod
    def _render_pdf_result_delta(result: ToolMessage) -> dict[str, Any] | None:
        if not isinstance(result.content, str):
            return None
        try:
            payload = json.loads(result.content)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        logger.info(
            "[BuilderPdfDiagnostics] render_success=%s page_count=%s "
            "blank_page_count=%s short_page_count=%s layout_quality=%s "
            "layout_warning=%s",
            payload.get("success"),
            payload.get("page_count"),
            payload.get("blank_page_count"),
            payload.get("short_page_count"),
            payload.get("layout_quality"),
            payload.get("layout_warning"),
        )
        return {"builder_pdf_render_result": payload}

    @staticmethod
    def _pdf_generation_failed_fallback(
        *,
        steps_completed: int,
        error_type: str,
    ) -> dict[str, Any]:
        safe_reason = error_type if error_type == "pdf_generation_failed" else "pdf_generation_failed"
        return {
            "artifact_path": None,
            "artifact_type": "pdf",
            "artifact_title": "PDF generation failed",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                "The builder tried to create the PDF, but PDF generation failed "
                "before a valid file could be written."
            ),
            "companion_tone_hint": "Direct and apologetic — PDF generation failed; offer to retry.",
            "user_next_action": "Ask me to retry the PDF build.",
            "confidence": 0.0,
            "error_reason": safe_reason,
        }

    def _pdf_generation_failure_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
        payload: dict[str, Any],
    ) -> Command:
        error_type = str(payload.get("error_type") or "pdf_generation_failed")
        fallback = self._pdf_generation_failed_fallback(
            steps_completed=int(request.state.get("builder_non_artifact_turns", 0) or 0) + 1,
            error_type=error_type,
        )
        logger.warning(
            "BuilderArtifact: terminal PDF generation failure reason=%s",
            fallback["error_reason"],
        )
        self._upload_fallback_and_fire(
            state=request.state,
            runtime=request.runtime,
            fallback=fallback,
            status="failed",
        )
        return Command(
            update={
                "messages": [result],
                "builder_pdf_render_result": payload,
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_task_started_at_ms": 0,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
            },
            goto="end",
        )

    def _pdf_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> ToolMessage | Command:
        delta = self._render_pdf_result_delta(result)
        if delta is None:
            return result
        payload = delta["builder_pdf_render_result"]
        if (
            request.tool_call.get("name") == _SIMPLE_PDF_TOOL_NAME
            and payload.get("success") is False
            and payload.get("error_type") == "pdf_generation_failed"
        ):
            return self._pdf_generation_failure_command(request, result, payload)
        return Command(update={"messages": [result], **delta})

    @staticmethod
    def _image_generation_bash_delta(
        *,
        command: str,
        text: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        output_path = _command_flag_value(command, "--output-file")
        exists, bytes_count, status_reason = _virtual_output_status(state, output_path)
        suffix = PurePosixPath(str(output_path or "")).suffix.lower()
        valid_image = exists and bytes_count > 0 and suffix in _PPTX_IMAGE_EXTENSIONS
        error_class = _classify_image_generation_error(text, valid_image, bytes_count)
        logger.info(
            "[BuilderImageGeneration] model=gpt-image-2 success=%s output_ext=%s "
            "bytes=%d error_class=%s status_reason=%s",
            valid_image,
            suffix.lstrip(".") or None,
            bytes_count,
            error_class,
            status_reason,
        )
        delta: dict[str, Any] = {
            "image_generation_attempt_count": 1,
            "image_generation_success_count": 1 if valid_image else 0,
            "image_generation_bytes_total": bytes_count if valid_image else 0,
            "image_generation_error_class": error_class,
        }
        if output_path and valid_image:
            delta["image_output_paths"] = [output_path]
        return delta

    @staticmethod
    def _pptx_generation_bash_delta(
        *,
        command: str,
        text: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        output_path = _command_flag_value(command, "--output-file")
        exists, bytes_count, status_reason = _virtual_output_status(state, output_path)
        error_class = _classify_pptx_generation_error(state, output_path, text, exists)
        valid_pptx = error_class is None
        slide_count = len(_command_flag_values(command, "--slide-images"))
        picture_count = _pptx_picture_count_from_text(text)
        logger.info(
            "[BuilderPptxGeneration] success=%s output_ext=%s bytes=%d "
            "slide_image_count=%d picture_count=%d error_class=%s status_reason=%s",
            valid_pptx,
            PurePosixPath(str(output_path or "")).suffix.lower().lstrip(".") or None,
            bytes_count,
            slide_count,
            picture_count,
            error_class,
            status_reason,
        )
        delta: dict[str, Any] = {
            "pptx_generator_attempt_count": 1,
            "pptx_generator_success_count": 1 if valid_pptx else 0,
            "pptx_generator_bytes_total": bytes_count if valid_pptx else 0,
            "pptx_generator_error_class": error_class,
            "pptx_generator_picture_count": picture_count,
        }
        if output_path and valid_pptx:
            delta["pptx_output_paths"] = [output_path]
        return delta

    @staticmethod
    def _pptx_bash_result_delta(
        request: ToolCallRequest,
        result: ToolMessage,
    ) -> dict[str, Any] | None:
        args = request.tool_call.get("args") or {}
        if not isinstance(args, dict):
            return None
        command = str(args.get("command") or "")
        text = BuilderArtifactMiddleware._tool_message_text(result)
        state = request.state or {}
        if any(marker in command for marker in _IMAGE_GENERATION_PATH_MARKERS):
            return BuilderArtifactMiddleware._image_generation_bash_delta(
                command=command,
                text=text,
                state=state,
            )
        if any(marker in command for marker in _PPTX_GENERATOR_PATH_MARKERS):
            return BuilderArtifactMiddleware._pptx_generation_bash_delta(
                command=command,
                text=text,
                state=state,
            )
        return None

    def _pptx_bash_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        delta = self._pptx_bash_result_delta(request, result)
        if delta is None:
            return result
        return Command(
            update={
                "messages": [result],
                "builder_pptx_diagnostics": delta,
            }
        )

    def _visual_asset_result_command(
        self,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage):
            return result
        delta = _visual_asset_result_delta(result)
        if delta is None:
            return result
        return Command(
            update={
                "messages": [result],
                "builder_visual_diagnostics": delta,
            }
        )

    def _tool_result_command(
        self,
        request: ToolCallRequest,
        result: ToolMessage | Command,
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name in _BUILDER_WRITE_TOOL_NAMES:
            return self._write_result_command(request, result)
        if tool_name in _PDF_CREATION_TOOL_NAMES and isinstance(result, ToolMessage):
            return self._pdf_result_command(request, result)
        if tool_name in {"bash", "bash_tool"}:
            return self._pptx_bash_result_command(request, result)
        if tool_name in _VISUAL_ASSET_TOOL_NAMES:
            return self._visual_asset_result_command(result)
        return result

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Intercept emit_builder_artifact to verify the file exists before executing.

        PR-D (2026-04-24): when the referenced file is missing, we bypass the
        normal tool execution (which has ``return_direct=True`` and would end the
        builder graph) and instead return a ``Command(goto=\"model\")`` with an
        error ToolMessage. This lets the model see the rejection and retry.
        """
        research_block = self._block_substantive_tool_before_research(request)
        if research_block is not None:
            return research_block
        visual_design_block = self._block_visual_asset_before_design_skill(request)
        if visual_design_block is not None:
            return visual_design_block

        if request.tool_call.get("name") != "emit_builder_artifact":
            return self._tool_result_command(request, handler(request))

        args = request.tool_call.get("args", {})
        authoritative_pdf_args = self._authoritative_pdf_emit_args(args, request.state, request.runtime)
        if authoritative_pdf_args is not None:
            request.tool_call["args"] = authoritative_pdf_args
            return handler(request)
        if self._artifact_files_exist(args, request.state, request.runtime):
            return handler(request)
        recovered_args = self._recover_emit_args_from_last_write(args, request.state, request.runtime)
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in wrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=self._emit_rejection_message(args, request.state),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Async variant — same logic as wrap_tool_call."""
        research_block = self._block_substantive_tool_before_research(request)
        if research_block is not None:
            return research_block
        visual_design_block = self._block_visual_asset_before_design_skill(request)
        if visual_design_block is not None:
            return visual_design_block

        if request.tool_call.get("name") != "emit_builder_artifact":
            return self._tool_result_command(request, await handler(request))

        args = request.tool_call.get("args", {})
        authoritative_pdf_args = self._authoritative_pdf_emit_args(args, request.state, request.runtime)
        if authoritative_pdf_args is not None:
            request.tool_call["args"] = authoritative_pdf_args
            return await handler(request)
        if self._artifact_files_exist(args, request.state, request.runtime):
            return await handler(request)
        recovered_args = self._recover_emit_args_from_last_write(args, request.state, request.runtime)
        if recovered_args is not None:
            request.tool_call["args"] = recovered_args
            return await handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in awrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=self._emit_rejection_message(args, request.state),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @hook_config(can_jump_to=["end"])
    @override
    def after_model(self, state: BuilderArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_builder_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()

        # Don't overwrite a previously captured result
        if state.get("builder_result") is not None:
            log_middleware("BuilderArtifact", "already captured, skipping", _t0)
            return None

        messages = state.get("messages", [])

        # Scan messages in reverse for an AI message with tool_calls
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue

            tool_calls = getattr(msg, "tool_calls", []) or []

            # AI message has tool calls -- look for emit_builder_artifact
            if tool_calls:
                # Surface skill-discovery / skill-invocation breadcrumbs
                # before any control-flow branches return. The user
                # complained about zero visibility into which skills the
                # builder picks; this resolves that without changing
                # behaviour.
                _emit_skill_usage_logs(tool_calls)
                artifact_calls = [tc for tc in tool_calls if tc.get("name") == "emit_builder_artifact"]
                tool_names = self._tool_names(tool_calls)
                pptx_skill_flags = _pptx_skill_flags_from_tool_calls(tool_calls)
                visual_skill_flags = _visual_skill_flags_from_tool_calls(tool_calls)
                research_diagnostics = self._update_research_diagnostics(state, tool_names)
                allow_web_research = self._allow_web_research(state)

                if artifact_calls and len(artifact_calls) == len(tool_calls):
                    args = artifact_calls[-1].get("args", {})

                    # PR-D (2026-04-24): verify the referenced file exists before
                    # accepting the emit. If missing, let wrap_tool_call handle the
                    # retry (Command(goto="model")) instead of completing with a
                    # phantom artifact.
                    #
                    # Codex fix (2026-04-24): on rejection we MUST still increment
                    # builder_non_artifact_turns. If the builder is in the forced-emit
                    # window (_should_force_emit is True) and the counter stays
                    # frozen, the model is trapped: tool_choice forces emit →
                    # emit is rejected → tool_choice forces emit again → loop.
                    # Incrementing lets the hard ceiling (10) trigger after a few
                    # retries and terminate the run instead of spinning forever.
                    args = self._recover_missing_emit_args_if_possible(args, state, runtime)

                    if not self._artifact_files_exist(args, state, runtime):
                        logger.warning(
                            "BuilderArtifact: emit rejected in after_model — "
                            "artifact_path %s not found on disk or in Supabase. "
                            "Builder will retry via wrap_tool_call.",
                            args.get("artifact_path"),
                        )
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1

                        # PR #94: track *empty* artifact_path rejections separately
                        # so we can short-circuit before the LangGraph recursion
                        # limit blows. The model's ``artifact_path=None`` under
                        # forced ``tool_choice`` is a strong signal that further
                        # retries won't help — collapse to the hard-ceiling
                        # fallback after _REJECTION_SHORT_CIRCUIT_AT consecutive
                        # such rejections.
                        primary = args.get("artifact_path")
                        is_empty_path_rejection = not (
                            isinstance(primary, str) and primary.strip()
                        )
                        consecutive_rejections = int(
                            state.get("builder_consecutive_empty_emit_rejections", 0) or 0
                        )
                        if is_empty_path_rejection:
                            consecutive_rejections += 1
                        else:
                            consecutive_rejections = 0
                        missing_path = (
                            str(primary).strip()
                            if isinstance(primary, str) and primary.strip()
                            else None
                        )
                        previous_missing_path = state.get("builder_last_missing_emit_path")
                        same_missing_path = (
                            isinstance(previous_missing_path, str)
                            and missing_path is not None
                            and previous_missing_path == missing_path
                        )
                        consecutive_missing_path_rejections = int(
                            state.get("builder_consecutive_missing_emit_path_rejections", 0) or 0
                        )
                        if missing_path is None:
                            consecutive_missing_path_rejections = 0
                        elif same_missing_path:
                            consecutive_missing_path_rejections += 1
                        else:
                            consecutive_missing_path_rejections = 1

                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                                "emit_rejected": True,
                                "empty_artifact_path": is_empty_path_rejection,
                                "missing_artifact_path": missing_path,
                                **pptx_skill_flags,
                                **visual_skill_flags,
                            },
                        )
                        write_diagnostics = state.get("builder_write_diagnostics") or {}
                        write_success_count = int(write_diagnostics.get("success_count", 0) or 0)
                        write_error_count = int(write_diagnostics.get("error_count", 0) or 0)
                        if write_success_count == 0 and write_error_count >= 3:
                            logger.warning(
                                "BuilderArtifact: stopping after repeated write failures "
                                "with no successful output write (write_errors=%d)",
                                write_error_count,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason="repeated_write_failures_no_output",
                            )
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status=self._fallback_completion_status(fallback),
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "jump_to": "end",
                            }

                        if (
                            is_empty_path_rejection
                            and consecutive_rejections >= self._REJECTION_SHORT_CIRCUIT_AT
                        ):
                            logger.warning(
                                "BuilderArtifact: short-circuiting after %d consecutive "
                                "empty-artifact_path rejections at turn=%d (ceiling=%d) — "
                                "routing to ceiling fallback to avoid GraphRecursionError.",
                                consecutive_rejections,
                                non_artifact_turns,
                                self._CEILING_FOR_FORCE,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason=f"consecutive_empty_emit_rejections={consecutive_rejections}",
                            )
                            # Phase 4L: upload the promoted file to
                            # Supabase BEFORE firing the webhook so the
                            # signed-URL mint + Telegram bytes-download
                            # both succeed. Without this the ceiling
                            # fallback delivered plaintext instead of
                            # the actual file (2026-05-19 production
                            # smoke test).
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status="failed" if not fallback.get("artifact_path") else "completed",
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "builder_last_missing_emit_path": None,
                                "builder_consecutive_missing_emit_path_rejections": 0,
                                "jump_to": "end",
                            }

                        if (
                            missing_path is not None
                            and consecutive_missing_path_rejections >= self._REJECTION_SHORT_CIRCUIT_AT
                        ):
                            logger.warning(
                                "BuilderArtifact: short-circuiting after %d consecutive "
                                "missing artifact_path rejections for the same path at "
                                "turn=%d path=%s — routing to ceiling fallback.",
                                consecutive_missing_path_rejections,
                                non_artifact_turns,
                                missing_path,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason=(
                                    "consecutive_missing_emit_path_rejections="
                                    f"{consecutive_missing_path_rejections}"
                                ),
                            )
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status=self._fallback_completion_status(fallback),
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_research_diagnostics": research_diagnostics,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "builder_last_missing_emit_path": None,
                                "builder_consecutive_missing_emit_path_rejections": 0,
                                "jump_to": "end",
                            }

                        return {
                            "builder_non_artifact_turns": non_artifact_turns,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_research_diagnostics": research_diagnostics,
                            "builder_consecutive_empty_emit_rejections": consecutive_rejections,
                            "builder_last_missing_emit_path": missing_path,
                            "builder_consecutive_missing_emit_path_rejections": consecutive_missing_path_rejections,
                        }

                    history = self._append_turn_summary(
                        state,
                        {
                            "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                            "tool_names": tool_names,
                            "has_emit_builder_artifact": True,
                            **pptx_skill_flags,
                            **visual_skill_flags,
                        },
                    )
                    _apply_artifact_request_metadata(
                        args,
                        state,
                        fallback_reason="pptx_generation_not_completed" if _requested_pptx_artifact(state) else None,
                    )
                    args = _apply_visual_missing_fallback_metadata(args, state)
                    _log_pptx_diagnostics(
                        phase="emit_accepted",
                        state={**state, "builder_tool_turn_summaries": history},
                        artifact_path=args.get("artifact_path"),
                    )
                    thread_data = state.get("thread_data") or {}
                    outputs_host_path = (
                        thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
                    )
                    # Phase-1 async migration created a fresh builder thread
                    # per build (deepagents native dispatch). The Telegram
                    # channel adapter looks up artifact bytes via the
                    # CONVERSATION thread_id (parent / companion), not the
                    # ephemeral build thread, so we namespace the upload
                    # under the parent thread to keep the storage path and
                    # the channel-adapter download path aligned.
                    #
                    # Production traceback (2026-05-06T22:18:16): Telegram
                    # downloaded from sophia_builder/<parent>/<file> and got
                    # 400 because the file lived at sophia_builder/<builder>/<file>.
                    # Switching to parent_thread_id here restores the legacy
                    # SubagentExecutor convention.
                    delegation_for_upload = (
                        state.get("delegation_context")
                        if isinstance(state.get("delegation_context"), dict)
                        else {}
                    )
                    parent_thread_id = (
                        delegation_for_upload.get("parent_thread_id")
                        if isinstance(delegation_for_upload, dict)
                        else None
                    )
                    builder_thread_id = (
                        runtime.context.get("thread_id") if runtime.context else None
                    )
                    upload_thread_id = parent_thread_id or builder_thread_id
                    _upload_builder_outputs_to_supabase(
                        thread_id=upload_thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=args,
                    )
                    self._log_missing_pdf_render_attempt_if_needed(state, args)
                    self._log_research_diagnostics(
                        phase="completion",
                        diagnostics=research_diagnostics,
                        allow_web_research=allow_web_research,
                        sources_used=args.get("sources_used"),
                    )
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={args.get('artifact_type')}, "
                        f"confidence={args.get('confidence')}",
                        _t0,
                    )
                    # Fire the gateway webhook so the Telegram channel adapter
                    # (and webapp SSE) deliver the artifact bytes to the user.
                    # Replaces the deleted ``SubagentExecutor`` terminal-flip
                    # call site after the Phase-1 async migration.
                    fire_completion_webhook_from_artifact(
                        state=state,
                        runtime=runtime,
                        artifact=args,
                        status="completed",
                    )
                    return {
                        "builder_result": args,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_research_diagnostics": research_diagnostics,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
                        "builder_last_missing_emit_path": None,
                        "builder_consecutive_missing_emit_path_rejections": 0,
                        "jump_to": "end",
                    }

                if artifact_calls:
                    log_middleware("BuilderArtifact", "mixed tool calls with builder artifact; loop continues", _t0)
                    return None

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                # Record task start wall-clock on the first non-emit turn so
                # the ceiling fallback can scan ONLY files produced during
                # this task (prevents promoting a stale file from a prior
                # builder task that ran in the same thread).
                builder_task_started_at_ms = state.get("builder_task_started_at_ms")
                if not isinstance(builder_task_started_at_ms, (int, float)) or builder_task_started_at_ms <= 0:
                    builder_task_started_at_ms = int(time.time() * 1000)
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                        **pptx_skill_flags,
                        **visual_skill_flags,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"
                recovered = self._maybe_promote_recovered_deliverable(
                    state,
                    runtime,
                    reason="non_emit_after_successful_deliverable_write",
                )
                if recovered is not None:
                    recovered.update({
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_research_diagnostics": research_diagnostics,
                    })
                    return recovered

                # PR-C F6 (2026-04-24): soft-warn halfway so the model sees
                # an early wrap-up signal in logs (and future trace events).
                # Emitted exactly once per task, at the ``_SOFT_WARN_AT`` turn.
                if non_artifact_turns == self._SOFT_WARN_AT:
                    logger.warning(
                        "BuilderArtifact: soft ceiling warning at turn=%d "
                        "(hard_ceiling=%d, remaining=%d). Builder should wrap up "
                        "— emit_builder_artifact with what's on disk instead of "
                        "continuing to iterate.",
                        non_artifact_turns,
                        self._CEILING_FOR_FORCE,
                        self._CEILING_FOR_FORCE - non_artifact_turns,
                    )

                # Hard ceiling: force end before hitting the recursion limit.
                # Builds that haven't emitted by this point almost never recover
                # — the budget is better spent recovering whatever file is
                # already on disk than letting bash thrash. PR #94 extracted
                # the fallback-construction logic into ``_build_ceiling_fallback``
                # so the consecutive-rejection short-circuit can reuse it.
                _HARD_CEILING = self._CEILING_FOR_FORCE
                if non_artifact_turns >= _HARD_CEILING:
                    logger.warning(
                        "BuilderArtifact: hard ceiling reached at turn=%d, tools=%s — forcing end with fallback",
                        non_artifact_turns,
                        joined_names,
                    )
                    fallback = self._build_ceiling_fallback(
                        state,
                        steps_completed=non_artifact_turns,
                        reason="hard_ceiling",
                    )
                    # Phase 4L: upload-before-webhook (see
                    # ``_upload_fallback_and_fire`` docstring). Same
                    # contract as the consecutive-rejection short-circuit
                    # above — ensures the ceiling-fallback file actually
                    # lands in Supabase before the channel adapter
                    # tries to download bytes for the user.
                    self._upload_fallback_and_fire(
                        state=state,
                        runtime=runtime,
                        fallback=fallback,
                        status=self._fallback_completion_status(fallback),
                    )
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_research_diagnostics": research_diagnostics,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
                        "builder_last_missing_emit_path": None,
                        "builder_consecutive_missing_emit_path_rejections": 0,
                        "jump_to": "end",
                    }

                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact: turn={non_artifact_turns}, tools={joined_names}",
                    _t0,
                )
                self._log_research_diagnostics(
                    phase="progress",
                    diagnostics=research_diagnostics,
                    allow_web_research=allow_web_research,
                )
                return {
                    "builder_non_artifact_turns": non_artifact_turns,
                    "builder_last_tool_names": tool_names,
                    "builder_tool_turn_summaries": history,
                    "builder_research_diagnostics": research_diagnostics,
                    "builder_task_started_at_ms": builder_task_started_at_ms,
                    # PR #94: any non-emit turn breaks the empty-rejection
                    # streak. Reset so the short-circuit only fires on
                    # *consecutive* empty emits.
                    "builder_consecutive_empty_emit_rejections": 0,
                    "builder_last_missing_emit_path": None,
                    "builder_consecutive_missing_emit_path_rejections": 0,
                }

            # AI message with NO tool calls -- agent ending with plain text, create fallback
            fallback = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task completed",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": "The build task was completed.",
                "companion_tone_hint": "Neutral \u2014 no builder context available.",
                "user_next_action": None,
                "confidence": 0.3,
            }
            history = self._append_turn_summary(
                state,
                {
                    "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                    "tool_names": [],
                    "has_emit_builder_artifact": False,
                    "ended_with_plain_text": True,
                },
            )
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            # Fire an explicit failure webhook: this fallback has no real
            # deliverable, so it must not surface as a ready/completed card.
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=fallback,
                status="failed",
                error_message=(
                    "Builder finished without producing a deliverable. "
                    "Want me to try again?"
                ),
            )
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
                "builder_consecutive_empty_emit_rejections": 0,
                "builder_last_missing_emit_path": None,
                "builder_consecutive_missing_emit_path_rejections": 0,
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
