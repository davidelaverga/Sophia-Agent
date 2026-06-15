import logging
import mimetypes
import os
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from app.gateway.artifact_registry import (
    ArtifactListResponse,
    ArtifactOpenResponse,
    ArtifactRecord,
    ArtifactRegistry,
    ArtifactRegistryFilters,
    ArtifactSource,
    ArtifactUpsertRequest,
    open_response_for_record,
)
from app.gateway.auth import require_authenticated_user
from app.gateway.html_quick_patch import (
    apply_html_quick_patch,
    content_hash,
    revision_artifact_path,
    stable_path_hash,
)
from app.gateway.path_utils import resolve_thread_virtual_path
from deerflow.sophia.session_store import SessionStore
from deerflow.sophia.storage import supabase_artifact_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["artifacts"])
_OUTPUTS_VIRTUAL_PATH = "mnt/user-data/outputs"
_WORKSPACE_OUTPUTS_VIRTUAL_PATH = "mnt/user-data/workspace/outputs"
_OFFICE_DOWNLOAD_EXTENSIONS = frozenset({".pptx", ".ppt", ".docx", ".xlsx"})
_BUILDER_ARTIFACT_TASK_STATUSES = frozenset({"success", "completed"})
_session_store = SessionStore()
_artifact_registry = ArtifactRegistry()


@dataclass(frozen=True)
class ArtifactPathResolution:
    actual_path: Path
    requested_thread_id: str
    requested_path: str
    normalized_path: str
    resolution_scope: str
    resolved_task_thread_id: str | None = None
    checked_builder_task_thread_ids: tuple[str, ...] = ()


class ThreadArtifactListItem(BaseModel):
    path: str
    name: str
    size_bytes: int
    modified_at: str
    mime_type: str | None = None


class ThreadArtifactListResponse(BaseModel):
    thread_id: str
    artifacts: list[ThreadArtifactListItem] = Field(default_factory=list)


class HtmlQuickPatchRequest(BaseModel):
    artifact_path: str = Field(min_length=1)
    artifact_stable_identity: str | None = None
    renderer_kind: str = Field(default="html")
    user_update_request: str = Field(min_length=1)
    requested_change_summary: str | None = None
    quick_edit_kind: str = Field(min_length=1)
    target_fields: dict[str, Any] = Field(default_factory=dict)
    workspace_key: str | None = None
    session_id: str | None = None
    thread_id: str | None = None


class HtmlQuickPatchResponse(BaseModel):
    ok: bool
    result: str
    fallback_reason: str | None = None
    quick_edit_kind: str | None = None
    requested_change_summary: str | None = None
    original_artifact_path: str | None = None
    revision_artifact_path: str | None = None
    source_artifact_path: str | None = None
    revision_of_artifact_path: str | None = None
    renderer_kind: str | None = "html"
    content_hash: str | None = None
    revision_path_hash: str | None = None
    safe_summary: str | None = None
    preserved_original: bool = True
    raw_html_excluded: bool = True
    raw_artifact_text_excluded: bool = True


@router.get(
    "/artifacts",
    response_model=ArtifactListResponse,
    summary="List User Artifacts",
    description="List safe artifact metadata for the authenticated user.",
)
async def list_user_artifacts(
    artifact_type: str | None = Query(default=None),
    source: ArtifactSource | None = Query(default=None),
    thread_id: str | None = Query(default=None),
    session_id: str | None = Query(default=None),
    search: str | None = Query(default=None),
    created_after: str | None = Query(default=None),
    created_before: str | None = Query(default=None),
    recent_after: str | None = Query(default=None),
    include_hidden: bool = Query(default=False),
    sort: str = Query(default="updated"),
    limit: int = Query(default=100, ge=1, le=250),
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> ArtifactListResponse:
    selected_sort = sort if sort in {"updated", "created", "recent", "title"} else "updated"
    return _artifact_registry.list(
        user_id=authenticated_user_id,
        filters=ArtifactRegistryFilters(
            artifact_type=artifact_type,
            source=source,
            thread_id=thread_id,
            session_id=session_id,
            search=search,
            created_after=created_after,
            created_before=created_before,
            recent_after=recent_after,
            include_hidden=include_hidden,
            sort=selected_sort,
            limit=limit,
        ),
    )


@router.post(
    "/artifacts/upsert",
    response_model=ArtifactOpenResponse,
    summary="Upsert Artifact Metadata",
    description="Idempotently persist safe artifact metadata for the authenticated user.",
)
async def upsert_user_artifact(
    request_body: ArtifactUpsertRequest,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> ArtifactOpenResponse:
    _require_thread_owner(authenticated_user_id, request_body.thread_id)
    record = _artifact_registry.upsert(request_body, user_id=authenticated_user_id)
    return open_response_for_record(record)


@router.get(
    "/artifacts/{artifact_id}",
    response_model=ArtifactOpenResponse,
    summary="Get Artifact Metadata",
)
async def get_user_artifact(
    artifact_id: str,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> ArtifactOpenResponse:
    record = _get_visible_user_artifact(artifact_id, authenticated_user_id)
    return open_response_for_record(record)


@router.post(
    "/artifacts/{artifact_id}/open",
    response_model=ArtifactOpenResponse,
    summary="Open Artifact",
)
async def open_user_artifact(
    artifact_id: str,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> ArtifactOpenResponse:
    existing = _get_visible_user_artifact(artifact_id, authenticated_user_id)
    opened = _artifact_registry.mark_opened(artifact_id, user_id=authenticated_user_id) or existing
    return open_response_for_record(opened)


@router.delete(
    "/artifacts/{artifact_id}",
    response_model=ArtifactOpenResponse,
    summary="Hide Artifact",
)
async def delete_user_artifact(
    artifact_id: str,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> ArtifactOpenResponse:
    existing = _artifact_registry.get(artifact_id, user_id=authenticated_user_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    deleted = _artifact_registry.mark_deleted(artifact_id, user_id=authenticated_user_id) or existing
    return open_response_for_record(deleted)


@router.get(
    "/artifacts/{artifact_id}/content",
    summary="Preview Artifact Content",
)
async def preview_user_artifact(
    artifact_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> Response:
    record = _get_visible_user_artifact(artifact_id, authenticated_user_id)
    return await _serve_registry_artifact(record, request, force_download=False)


@router.get(
    "/artifacts/{artifact_id}/download",
    summary="Download Artifact",
)
async def download_user_artifact(
    artifact_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authenticated_user),
) -> Response:
    record = _get_visible_user_artifact(artifact_id, authenticated_user_id)
    return await _serve_registry_artifact(record, request, force_download=True)


def _get_visible_user_artifact(artifact_id: str, authenticated_user_id: str) -> ArtifactRecord:
    record = _artifact_registry.get(artifact_id, user_id=authenticated_user_id)
    if record is None or not _is_visible_primary_artifact(record):
        raise HTTPException(status_code=404, detail="Artifact not found")
    return record


def _is_visible_primary_artifact(record: ArtifactRecord) -> bool:
    return (
        record.deleted_at is None
        and record.is_library_visible is True
        and record.artifact_role == "primary"
        and record.storage_status == "available"
    )


async def _serve_registry_artifact(
    record: ArtifactRecord,
    request: Request,
    *,
    force_download: bool,
) -> Response:
    if (
        supabase_artifact_store.requires_durable_artifact_upload()
        and record.storage_provider in {"supabase", "hybrid"}
        and record.storage_object_path
    ):
        object_response = _try_serve_registry_storage_object(record, request, force_download=force_download)
        if object_response is not None:
            return object_response
        raise HTTPException(status_code=404, detail="Artifact content not found")

    missing_resolution: ArtifactPathResolution | None = None
    for thread_id in _registry_artifact_thread_ids(record):
        resolution = await _resolve_artifact_path_for_request(thread_id, record.local_path)
        actual_path = resolution.actual_path
        if not actual_path.exists():
            missing_resolution = missing_resolution or resolution
            continue
        if not actual_path.is_file():
            raise HTTPException(status_code=400, detail=f"Path is not a file: {record.local_path}")
        return _serve_local_artifact(
            thread_id,
            actual_path,
            request,
            force_download=force_download,
        )

    object_response = _try_serve_registry_storage_object(record, request, force_download=force_download)
    if object_response is not None:
        return object_response
    if record.storage_provider in {"supabase", "hybrid"} and record.storage_object_path:
        raise HTTPException(status_code=404, detail="Artifact content not found")

    for thread_id in _registry_artifact_thread_ids(record):
        supabase_response = _try_serve_from_supabase(
            thread_id,
            record.local_path,
            request,
            force_download=force_download,
        )
        if supabase_response is not None:
            return supabase_response

    if missing_resolution is None:
        missing_resolution = ArtifactPathResolution(
            actual_path=_resolve_artifact_path(record.thread_id, record.local_path),
            requested_thread_id=record.thread_id,
            requested_path=record.local_path,
            normalized_path=record.local_path,
            resolution_scope="registry_record",
        )
    raise HTTPException(
        status_code=404,
        detail=_artifact_not_found_detail(record.thread_id, record.local_path, missing_resolution),
    )


def _registry_artifact_thread_ids(record: ArtifactRecord) -> tuple[str, ...]:
    thread_ids: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        if not isinstance(value, str) or not value.strip():
            return
        normalized = value.strip()
        if normalized in seen:
            return
        seen.add(normalized)
        thread_ids.append(normalized)

    add(record.thread_id)
    add(record.task_id)
    add(record.run_id)
    add(record.parent_thread_id)
    storage_thread_id = _thread_id_from_storage_object_path(record.storage_object_path)
    add(storage_thread_id)
    return tuple(thread_ids)


def _thread_id_from_storage_object_path(storage_object_path: str | None) -> str | None:
    if not isinstance(storage_object_path, str) or "/" not in storage_object_path:
        return None
    try:
        normalized = supabase_artifact_store.normalize_object_path(storage_object_path)
    except ValueError:
        return None
    parts = normalized.split("/")
    if len(parts) >= 3 and parts[0] == "artifacts":
        thread_id = parts[2].strip()
        return thread_id or None
    thread_id = parts[0].strip()
    return thread_id or None


def _is_builder_internal(name: str) -> bool:
    # Builder generator/helper scripts are byproducts, not deliverables.
    lowered = name.lower()
    return (
        name.startswith("_") and lowered.endswith(".py")
        or lowered.startswith("test_") and lowered.endswith((".py", ".sh"))
    )


def _is_builder_support_artifact_path(relative_path: str) -> bool:
    """Return True for builder support assets that should not be primary cards."""
    normalized = relative_path.strip().lstrip("/").replace("\\", "/")
    if not normalized:
        return False
    parts = [part for part in normalized.split("/") if part]
    if not parts:
        return False
    if parts[0] in {"visuals", "sources", "source_artifact", ".builder"}:
        return True
    name = parts[-1].lower()
    return (
        _is_builder_internal(parts[-1])
        or name.endswith((".source.md", ".source.html", ".plan.json", ".manifest.json"))
    )


def _is_office_download(filename: str | Path) -> bool:
    return Path(filename).suffix.lower() in _OFFICE_DOWNLOAD_EXTENSIONS


def _short_id(value: str | None) -> str | None:
    return value[:12] if value else None


def _path_modified_timestamp(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _iso_timestamp_value(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _require_thread_owner(authenticated_user_id: str | None, thread_id: str) -> None:
    if not isinstance(authenticated_user_id, str) or not authenticated_user_id:
        return
    if _is_thread_owner(authenticated_user_id, thread_id):
        return
    logger.warning(
        "Artifact route ownership rejected user_id=%s thread_id=%s",
        _short_id(authenticated_user_id),
        _short_id(thread_id),
    )
    raise HTTPException(status_code=404, detail="Thread not found")


def _is_thread_owner(authenticated_user_id: str | None, thread_id: str) -> bool:
    if not isinstance(authenticated_user_id, str) or not authenticated_user_id:
        return True
    return _session_store.find_session_by_thread_id(authenticated_user_id, thread_id) is not None


def _has_sophia_session(thread_id: str) -> bool:
    finder = getattr(_session_store, "find_any_session_by_thread_id", None)
    if not callable(finder):
        return False
    return finder(thread_id) is not None


def is_text_file_by_content(path: Path, sample_size: int = 8192) -> bool:
    """Check if file is text by examining content for null bytes."""
    try:
        with open(path, "rb") as f:
            chunk = f.read(sample_size)
            # Text files shouldn't contain null bytes
            return b"\x00" not in chunk
    except Exception:
        return False


def _extract_file_from_skill_archive(zip_path: Path, internal_path: str) -> bytes | None:
    """Extract a file from a .skill ZIP archive.

    Args:
        zip_path: Path to the .skill file (ZIP archive).
        internal_path: Path to the file inside the archive (e.g., "SKILL.md").

    Returns:
        The file content as bytes, or None if not found.
    """
    if not zipfile.is_zipfile(zip_path):
        return None

    try:
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            # List all files in the archive
            namelist = zip_ref.namelist()

            # Try direct path first
            if internal_path in namelist:
                return zip_ref.read(internal_path)

            # Try with any top-level directory prefix (e.g., "skill-name/SKILL.md")
            for name in namelist:
                if name.endswith("/" + internal_path) or name == internal_path:
                    return zip_ref.read(name)

            # Not found
            return None
    except (zipfile.BadZipFile, KeyError):
        return None


def _relative_output_artifact_path(path: str) -> str | None:
    normalized = path.lstrip("/")
    if normalized == _OUTPUTS_VIRTUAL_PATH:
        return ""
    if normalized.startswith(_OUTPUTS_VIRTUAL_PATH + "/"):
        return normalized[len(_OUTPUTS_VIRTUAL_PATH) + 1 :]
    return None


def _requires_thread_owner_for_artifact(path: str) -> bool:
    normalized = path.lstrip("/")
    return (
        normalized == _OUTPUTS_VIRTUAL_PATH
        or normalized.startswith(_OUTPUTS_VIRTUAL_PATH + "/")
        or normalized == _WORKSPACE_OUTPUTS_VIRTUAL_PATH
        or normalized.startswith(_WORKSPACE_OUTPUTS_VIRTUAL_PATH + "/")
    )


def _artifact_container_path(path: str) -> str:
    skill_marker = ".skill/"
    marker_pos = path.find(skill_marker)
    if marker_pos == -1:
        return path
    return path[: marker_pos + len(".skill")]


def _decode_artifact_virtual_path(path: str) -> str:
    decoded = path
    for _ in range(3):
        next_decoded = unquote(decoded)
        if next_decoded == decoded:
            break
        decoded = next_decoded
    return decoded


def _canonicalize_output_virtual_path(path: str) -> str:
    if path == "outputs":
        return _OUTPUTS_VIRTUAL_PATH
    if path.startswith("outputs/"):
        return f"{_OUTPUTS_VIRTUAL_PATH}/{path[len('outputs/'):]}"
    if path == "user-data/outputs":
        return _OUTPUTS_VIRTUAL_PATH
    if path.startswith("user-data/outputs/"):
        return f"mnt/{path}"
    return path


def _normalize_artifact_virtual_path(path: str) -> str:
    """Normalize separators while rejecting traversal before authorization."""
    decoded = _decode_artifact_virtual_path(path).strip()
    if decoded.startswith("file://"):
        decoded = decoded[len("file://") :]
    if decoded.startswith(("//", "\\\\")) or (len(decoded) >= 2 and decoded[1] == ":"):
        raise HTTPException(status_code=403, detail="Unsafe artifact path")
    parts: list[str] = []
    for part in PurePosixPath(decoded.replace("\\", "/")).parts:
        if part in {"", "/", "."}:
            continue
        if part == "..":
            raise HTTPException(status_code=403, detail="Path traversal detected")
        parts.append(part)
    return _canonicalize_output_virtual_path("/".join(parts))


def _resolve_artifact_path(thread_id: str, path: str) -> Path:
    actual_path = resolve_thread_virtual_path(thread_id, path)
    if actual_path.exists():
        return actual_path

    relative_output_path = _relative_output_artifact_path(path)
    if relative_output_path is None:
        return actual_path

    fallback_virtual_path = _WORKSPACE_OUTPUTS_VIRTUAL_PATH
    if relative_output_path:
        fallback_virtual_path = f"{fallback_virtual_path}/{relative_output_path}"

    fallback_path = resolve_thread_virtual_path(thread_id, fallback_virtual_path)
    if fallback_path.exists():
        logger.warning(
            "Artifact missing under outputs, serving workspace/outputs fallback: thread_id=%s requested_path=%s fallback_path=%s",
            thread_id,
            path,
            fallback_path,
        )
        return fallback_path

    return actual_path


def _langgraph_url() -> str:
    return (
        os.getenv("SOPHIA_LANGGRAPH_BASE_URL")
        or os.getenv("LANGGRAPH_URL")
        or os.getenv("SOPHIA_BACKEND_BASE_URL")
        or "http://127.0.0.1:2024"
    ).strip().rstrip("/")


def _builder_task_thread_id(task: dict[str, Any]) -> str | None:
    for key in ("thread_id", "task_id"):
        value = task.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _builder_task_parent_id(task: dict[str, Any]) -> str | None:
    value = task.get("parent_thread_id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    delegation_context = task.get("delegation_context")
    if isinstance(delegation_context, dict):
        value = delegation_context.get("parent_thread_id")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _is_completed_builder_task_for_parent(parent_thread_id: str, task: dict[str, Any]) -> bool:
    if task.get("agent_name") != "sophia_builder":
        return False
    status = str(task.get("status") or "").lower()
    if status not in _BUILDER_ARTIFACT_TASK_STATUSES:
        return False
    explicit_parent_id = _builder_task_parent_id(task)
    return explicit_parent_id is None or explicit_parent_id == parent_thread_id


async def _associated_builder_task_thread_ids(parent_thread_id: str) -> tuple[str, ...]:
    """Return completed builder task thread ids associated with a parent thread.

    Association comes from the parent thread's trusted ``async_tasks`` state.
    The returned ids are only used as alternate thread roots for the same
    normalized output-relative artifact path.
    """
    try:
        from langgraph_sdk import get_client

        client = get_client(url=_langgraph_url())
        state = await client.threads.get_state(parent_thread_id)
    except Exception:  # noqa: BLE001 - artifact listing must degrade gracefully.
        logger.info(
            "Builder task artifact association unavailable: parent_thread_id=%s",
            _short_id(parent_thread_id),
            exc_info=True,
        )
        return ()

    values = state.get("values", {}) if isinstance(state, dict) else {}
    tasks = values.get("async_tasks", {}) if isinstance(values, dict) else {}
    if not isinstance(tasks, dict):
        return ()

    task_thread_ids: list[str] = []
    seen: set[str] = set()
    for task in tasks.values():
        _append_associated_builder_task_thread_id(
            task_thread_ids,
            seen,
            parent_thread_id,
            task,
        )
    return tuple(task_thread_ids)


def _append_associated_builder_task_thread_id(
    task_thread_ids: list[str],
    seen: set[str],
    parent_thread_id: str,
    task: object,
) -> None:
    if not isinstance(task, dict) or not _is_completed_builder_task_for_parent(parent_thread_id, task):
        return
    task_thread_id = _builder_task_thread_id(task)
    if not task_thread_id or task_thread_id == parent_thread_id or task_thread_id in seen:
        return
    seen.add(task_thread_id)
    task_thread_ids.append(task_thread_id)


async def _builder_task_thread_ids_to_check(parent_thread_id: str) -> tuple[str, ...]:
    if not _has_sophia_session(parent_thread_id):
        return ()
    return await _associated_builder_task_thread_ids(parent_thread_id)


async def _resolve_artifact_path_for_request(thread_id: str, path: str) -> ArtifactPathResolution:
    parent_path = _resolve_artifact_path(thread_id, path)
    if parent_path.exists():
        resolution = ArtifactPathResolution(
            actual_path=parent_path,
            requested_thread_id=thread_id,
            requested_path=path,
            normalized_path=path,
            resolution_scope="parent_thread",
        )
        _log_artifact_resolution(resolution, artifact_exists=True)
        return resolution

    relative_output_path = _relative_output_artifact_path(path)
    checked_task_thread_ids: tuple[str, ...] = ()
    if relative_output_path is not None:
        checked_task_thread_ids = await _builder_task_thread_ids_to_check(thread_id)
        best_resolution: ArtifactPathResolution | None = None
        best_modified_at = 0.0
        for task_thread_id in checked_task_thread_ids:
            try:
                task_path = _resolve_artifact_path(task_thread_id, path)
            except HTTPException:
                logger.warning(
                    "Builder task artifact path resolution skipped: requested_thread_id=%s task_thread_id=%s requested_path=%s",
                    _short_id(thread_id),
                    _short_id(task_thread_id),
                    path,
                )
                continue
            if task_path.exists():
                modified_at = _path_modified_timestamp(task_path)
                if best_resolution is not None and modified_at <= best_modified_at:
                    continue
                best_modified_at = modified_at
                best_resolution = ArtifactPathResolution(
                    actual_path=task_path,
                    requested_thread_id=thread_id,
                    requested_path=path,
                    normalized_path=path,
                    resolution_scope="builder_task_thread",
                    resolved_task_thread_id=task_thread_id,
                    checked_builder_task_thread_ids=checked_task_thread_ids,
                )
        if best_resolution is not None:
            _log_artifact_resolution(best_resolution, artifact_exists=True)
            return best_resolution

    resolution = ArtifactPathResolution(
        actual_path=parent_path,
        requested_thread_id=thread_id,
        requested_path=path,
        normalized_path=path,
        resolution_scope="parent_thread",
        checked_builder_task_thread_ids=checked_task_thread_ids,
    )
    _log_artifact_resolution(resolution, artifact_exists=False, failure_reason="not_found")
    return resolution


def _log_artifact_resolution(
    resolution: ArtifactPathResolution,
    *,
    artifact_exists: bool,
    failure_reason: str | None = None,
) -> None:
    logger.info(
        "Artifact resolution: requested_path=%s normalized_path=%s resolution_scope=%s "
        "requested_thread_id=%s resolved_task_thread_id=%s checked_builder_task_count=%d "
        "artifact_exists=%s failure_reason=%s actual_path=%s",
        resolution.requested_path,
        resolution.normalized_path,
        resolution.resolution_scope,
        resolution.requested_thread_id,
        resolution.resolved_task_thread_id,
        len(resolution.checked_builder_task_thread_ids),
        artifact_exists,
        failure_reason,
        resolution.actual_path,
    )


def _artifact_not_found_detail(thread_id: str, path: str, resolution: ArtifactPathResolution) -> dict[str, Any]:
    checked_builder_task_outputs = bool(resolution.checked_builder_task_thread_ids)
    return {
        "message": "Artifact not found",
        "requested_path": path,
        "normalized_path": resolution.normalized_path,
        "checked_parent_thread": thread_id,
        "checked_builder_task_outputs": checked_builder_task_outputs,
        "checked_builder_task_thread_ids": list(resolution.checked_builder_task_thread_ids),
        "failure_reason": (
            "not_found_in_parent_or_associated_builder_tasks"
            if checked_builder_task_outputs
            else "not_found_in_parent_thread"
        ),
    }


def _add_output_artifacts_from_dir(
    artifacts_by_path: dict[str, ThreadArtifactListItem],
    outputs_path: Path,
    *,
    replace_existing_with_newer: bool = False,
) -> int:
    files_with_stat = [
        (candidate, candidate.stat(), candidate.relative_to(outputs_path).as_posix())
        for candidate in outputs_path.rglob("*")
        if (
            candidate.is_file()
            and not _is_builder_support_artifact_path(candidate.relative_to(outputs_path).as_posix())
        )
    ]
    for file_path, stat_result, relative_path in files_with_stat:
        mime_type, _ = mimetypes.guess_type(file_path.name)
        path = f"{_OUTPUTS_VIRTUAL_PATH}/{relative_path}"
        existing = artifacts_by_path.get(path)
        if existing is not None:
            if not replace_existing_with_newer:
                continue
            if stat_result.st_mtime <= _iso_timestamp_value(existing.modified_at):
                continue
        artifacts_by_path[path] = ThreadArtifactListItem(
            path=path,
            name=file_path.name,
            size_bytes=stat_result.st_size,
            modified_at=datetime.fromtimestamp(stat_result.st_mtime, tz=UTC).isoformat(),
            mime_type=mime_type,
        )
    return len(files_with_stat)


def _can_serve_local_non_sophia_artifact(thread_id: str, path: str) -> bool:
    if _has_sophia_session(thread_id):
        return False
    actual_path = _resolve_artifact_path(thread_id, path)
    return actual_path.exists() and actual_path.is_file()


def _enforce_artifact_owner(authenticated_user_id: str | None, thread_id: str, path: str) -> None:
    container_path = _artifact_container_path(path)
    if not _requires_thread_owner_for_artifact(container_path):
        return
    if _is_thread_owner(authenticated_user_id, thread_id):
        return
    if _can_serve_local_non_sophia_artifact(thread_id, container_path):
        logger.warning(
            "Serving protected local artifact for non-Sophia thread: user_id=%s thread_id=%s",
            _short_id(authenticated_user_id),
            _short_id(thread_id),
        )
        return
    _require_thread_owner(authenticated_user_id, thread_id)


def _try_serve_registry_storage_object(
    record: ArtifactRecord,
    request: Request,
    *,
    force_download: bool = False,
) -> Response | None:
    object_path = record.storage_object_path
    if not isinstance(object_path, str) or not object_path.strip():
        return None
    if record.storage_provider not in {"supabase", "hybrid"}:
        return None
    try:
        result = supabase_artifact_store.download_artifact_object(object_path)
    except ValueError as exc:
        logger.warning(
            "Unsafe artifact storage object path rejected: artifact_id=%s error=%s",
            record.artifact_id,
            exc,
        )
        raise HTTPException(status_code=403, detail="Unsafe artifact storage path") from exc
    except Exception:  # noqa: BLE001 — network/transport failure
        logger.exception(
            "Supabase object download failed: artifact_id=%s storage_provider=%s",
            record.artifact_id,
            record.storage_provider,
        )
        return None
    if result is None:
        return None

    content, supabase_mime = result
    filename = record.filename or Path(object_path).name
    mime_type = supabase_mime or record.mime_type or mimetypes.guess_type(filename)[0]
    logger.info(
        "Serving registry artifact from Supabase object storage: artifact_id=%s bytes=%d",
        record.artifact_id,
        len(content),
    )
    if force_download or request.query_params.get("download") or _is_office_download(filename):
        return _supabase_attachment_response(
            record.thread_id,
            filename,
            content,
            mime_type,
            request,
            force_download=force_download,
        )
    return _supabase_inline_response(filename, content, mime_type)


def _try_serve_from_supabase(
    thread_id: str,
    path: str,
    request: Request,
    *,
    force_download: bool = False,
) -> Response | None:
    """Serve the artifact from the configured Supabase builder bucket when missing locally.

    Legacy layout: ``{thread_id}/{relative_output_path}``. Returns
    ``None`` when Supabase is not configured, the path is not under the
    outputs virtual prefix, or the object is missing. Raises ``HTTPException``
    with 502 only when Supabase responds with an unexpected transport error.
    """
    relative = _relative_output_artifact_path(path)
    if relative is None or relative == "":
        return None
    # The delegation ledger (Spec D) is internal conversation content,
    # mirrored under {thread_id}/ledger/ — never user-facing. Without this
    # guard, mnt/user-data/outputs/ledger/session.jsonl would download the
    # mirror through the artifact proxy (Codex P1 PR #131).
    if supabase_artifact_store.is_ledger_object_name(relative):
        logger.info(
            "Refusing artifact serve for internal ledger keyspace: thread_id=%s",
            thread_id,
        )
        return None
    try:
        result = supabase_artifact_store.download_artifact(
            thread_id=thread_id,
            filename=relative,
        )
    except Exception:  # noqa: BLE001 — network/transport failure
        logger.exception(
            "Supabase download failed: thread_id=%s requested_path=%s", thread_id, path
        )
        return None
    if result is None:
        return None

    content, supabase_mime = result
    filename = Path(relative).name
    mime_type = supabase_mime or mimetypes.guess_type(filename)[0]

    logger.info(
        "Serving artifact from Supabase bucket: thread_id=%s requested_path=%s bytes=%d",
        thread_id,
        path,
        len(content),
    )

    if force_download or request.query_params.get("download") or _is_office_download(filename):
        return _supabase_attachment_response(
            thread_id,
            filename,
            content,
            mime_type,
            request,
            force_download=force_download,
        )

    return _supabase_inline_response(filename, content, mime_type)


def _supabase_attachment_response(
    thread_id: str,
    filename: str,
    content: bytes,
    mime_type: str | None,
    request: Request,
    *,
    force_download: bool = False,
) -> Response:
    logger.info(
        "Serving artifact with attachment disposition: thread_id=%s ext=%s source=supabase download=%s bytes=%d",
        thread_id,
        Path(filename).suffix.lower().lstrip(".") or None,
        bool(force_download or request.query_params.get("download")),
        len(content),
    )
    return Response(
        content=content,
        media_type=mime_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


def _supabase_inline_response(
    filename: str,
    content: bytes,
    mime_type: str | None,
) -> Response:
    encoded_filename = quote(filename)
    if mime_type == "text/html":
        return HTMLResponse(content=content.decode("utf-8", errors="replace"))
    if mime_type and mime_type.startswith("text/"):
        return PlainTextResponse(
            content=content.decode("utf-8", errors="replace"),
            media_type=mime_type,
        )
    if mime_type:
        return Response(
            content=content,
            media_type=mime_type,
            headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"},
        )

    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return Response(
            content=content,
            media_type=mime_type or "application/octet-stream",
            headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"},
        )
    return PlainTextResponse(content=text, media_type=mime_type or "text/plain")


@router.get(
    "/threads/{thread_id}/artifacts",
    response_model=ThreadArtifactListResponse,
    summary="List Thread Artifacts",
    description="List files generated under the thread's outputs directory.",
)
async def list_artifacts(
    thread_id: str,
    authenticated_user_id: str | None = Depends(require_authenticated_user),
) -> ThreadArtifactListResponse:
    outputs_path = resolve_thread_virtual_path(thread_id, _OUTPUTS_VIRTUAL_PATH)

    artifacts_by_path: dict[str, ThreadArtifactListItem] = {}
    local_count = 0

    if outputs_path.exists() and not outputs_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {_OUTPUTS_VIRTUAL_PATH}")

    if outputs_path.exists():
        local_count = _add_output_artifacts_from_dir(artifacts_by_path, outputs_path)

    supabase_count = 0
    owns_thread = _is_thread_owner(authenticated_user_id, thread_id)
    builder_task_local_count, checked_builder_task_thread_ids = await _add_builder_task_local_artifacts(
        artifacts_by_path,
        thread_id,
        owns_thread=owns_thread,
    )
    if owns_thread:
        supabase_count = _merge_supabase_artifacts(
            artifacts_by_path,
            _list_supabase_artifacts(thread_id),
        )
    else:
        _enforce_artifact_list_access(
            authenticated_user_id,
            thread_id,
            has_local_artifacts=bool(artifacts_by_path),
            local_count=local_count,
        )

    artifacts = sorted(
        artifacts_by_path.values(),
        key=lambda item: item.modified_at,
        reverse=True,
    )

    logger.info(
        "Artifact list resolved: thread_id=%s local_count=%d builder_task_local_count=%d "
        "builder_task_thread_count=%d supabase_count=%d merged_count=%d",
        thread_id,
        local_count,
        builder_task_local_count,
        len(checked_builder_task_thread_ids),
        supabase_count,
        len(artifacts),
    )

    return ThreadArtifactListResponse(thread_id=thread_id, artifacts=artifacts)


async def _add_builder_task_local_artifacts(
    artifacts_by_path: dict[str, ThreadArtifactListItem],
    thread_id: str,
    *,
    owns_thread: bool,
) -> tuple[int, tuple[str, ...]]:
    if not owns_thread:
        return 0, ()
    checked_thread_ids = await _builder_task_thread_ids_to_check(thread_id)
    builder_artifacts_by_path: dict[str, ThreadArtifactListItem] = {}
    count = 0
    for task_thread_id in checked_thread_ids:
        task_outputs_path = _builder_task_outputs_path(thread_id, task_thread_id)
        if task_outputs_path is not None and task_outputs_path.exists():
            count += _add_output_artifacts_from_dir(
                builder_artifacts_by_path,
                task_outputs_path,
                replace_existing_with_newer=True,
            )
    for path, item in builder_artifacts_by_path.items():
        artifacts_by_path.setdefault(path, item)
    return count, checked_thread_ids


def _builder_task_outputs_path(parent_thread_id: str, task_thread_id: str) -> Path | None:
    try:
        task_outputs_path = resolve_thread_virtual_path(task_thread_id, _OUTPUTS_VIRTUAL_PATH)
    except HTTPException:
        logger.warning(
            "Builder task artifact list skipped invalid task output root: parent_thread_id=%s task_thread_id=%s",
            _short_id(parent_thread_id),
            _short_id(task_thread_id),
        )
        return None
    if task_outputs_path.exists() and not task_outputs_path.is_dir():
        logger.warning(
            "Builder task artifact list skipped non-directory output root: parent_thread_id=%s task_thread_id=%s",
            _short_id(parent_thread_id),
            _short_id(task_thread_id),
        )
        return None
    return task_outputs_path


def _list_supabase_artifacts(thread_id: str):
    try:
        return supabase_artifact_store.list_artifacts(thread_id=thread_id)
    except Exception as exc:  # noqa: BLE001 — listing is best-effort.
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        logger.warning(
            "Supabase artifact list failed: thread_id=%s error_type=%s status=%s",
            thread_id,
            exc.__class__.__name__,
            status_code,
        )
        return []


def _merge_supabase_artifacts(
    artifacts_by_path: dict[str, ThreadArtifactListItem],
    supabase_artifacts,
) -> int:
    count = 0
    for artifact in supabase_artifacts:
        if _is_builder_support_artifact_path(artifact.filename):
            continue
        path = f"{_OUTPUTS_VIRTUAL_PATH}/{artifact.filename}"
        if path in artifacts_by_path:
            continue
        artifacts_by_path[path] = ThreadArtifactListItem(
            path=path,
            name=Path(artifact.filename).name,
            size_bytes=artifact.size_bytes,
            modified_at=artifact.modified_at,
            mime_type=artifact.content_type or mimetypes.guess_type(artifact.filename)[0],
        )
        count += 1
    return count


def _enforce_artifact_list_access(
    authenticated_user_id: str | None,
    thread_id: str,
    *,
    has_local_artifacts: bool,
    local_count: int,
) -> None:
    if _has_sophia_session(thread_id) or not has_local_artifacts:
        _require_thread_owner(authenticated_user_id, thread_id)
        return
    logger.warning(
        "Skipping Supabase artifact list for non-Sophia thread: user_id=%s thread_id=%s local_count=%d",
        _short_id(authenticated_user_id),
        _short_id(thread_id),
        local_count,
    )


def _quick_patch_response(
    *,
    ok: bool,
    result: str,
    request: HtmlQuickPatchRequest,
    original_artifact_path: str | None,
    fallback_reason: str | None = None,
    revision_path: str | None = None,
    patched_content: str | None = None,
    safe_summary: str | None = None,
) -> HtmlQuickPatchResponse:
    return HtmlQuickPatchResponse(
        ok=ok,
        result=result,
        fallback_reason=fallback_reason,
        quick_edit_kind=request.quick_edit_kind,
        requested_change_summary=_safe_quick_patch_summary(
            request.requested_change_summary or request.user_update_request
        ),
        original_artifact_path=original_artifact_path,
        revision_artifact_path=revision_path,
        source_artifact_path=original_artifact_path,
        revision_of_artifact_path=original_artifact_path,
        renderer_kind="html",
        content_hash=content_hash(patched_content) if patched_content is not None else None,
        revision_path_hash=stable_path_hash(revision_path),
        safe_summary=safe_summary,
        preserved_original=True,
        raw_html_excluded=True,
        raw_artifact_text_excluded=True,
    )


def _safe_quick_patch_summary(value: str | None) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return " ".join(value.split())[:160]


def _read_quick_patch_source(
    *,
    thread_id: str,
    path: str,
    resolution: ArtifactPathResolution,
) -> tuple[str, str | None]:
    actual_path = resolution.actual_path
    if actual_path.exists() and actual_path.is_file():
        return actual_path.read_text(encoding="utf-8"), mimetypes.guess_type(actual_path.name)[0]

    relative = _relative_output_artifact_path(path)
    if relative is None or relative == "":
        raise FileNotFoundError(path)
    result = supabase_artifact_store.download_artifact(thread_id=thread_id, filename=relative)
    if result is None:
        raise FileNotFoundError(path)
    content, content_type = result
    return content.decode("utf-8", errors="replace"), content_type


def _write_quick_patch_revision(
    *,
    thread_id: str,
    revision_path: str,
    content: str,
) -> Path:
    revision_actual_path = _resolve_artifact_path(thread_id, revision_path)
    revision_actual_path.parent.mkdir(parents=True, exist_ok=True)
    revision_actual_path.write_text(content, encoding="utf-8")
    return revision_actual_path


def _mirror_quick_patch_revision(
    *,
    thread_id: str,
    revision_path: str,
    content: str,
) -> None:
    relative = _relative_output_artifact_path(revision_path)
    if not relative:
        return
    try:
        supabase_artifact_store.upload_artifact(
            thread_id=thread_id,
            filename=relative,
            content=content.encode("utf-8"),
            content_type="text/html",
        )
    except Exception:  # noqa: BLE001 - quick patch remains valid locally.
        logger.info(
            "Quick HTML patch Supabase mirror skipped: thread_id=%s revision_path_hash=%s",
            _short_id(thread_id),
            stable_path_hash(revision_path),
            exc_info=True,
        )


@router.post(
    "/threads/{thread_id}/artifacts/quick-html-patch",
    response_model=HtmlQuickPatchResponse,
    summary="Quick Patch HTML Artifact",
    description="Apply a conservative deterministic quick edit to a selected HTML artifact.",
)
async def quick_patch_html_artifact(
    thread_id: str,
    request_body: HtmlQuickPatchRequest,
    authenticated_user_id: str | None = Depends(require_authenticated_user),
) -> HtmlQuickPatchResponse:
    path = _normalize_artifact_virtual_path(request_body.artifact_path)
    _enforce_artifact_owner(authenticated_user_id, thread_id, path)
    original_path = path

    if request_body.renderer_kind != "html" or not path.lower().endswith((".html", ".htm")):
        return _quick_patch_response(
            ok=False,
            result="unsupported",
            request=request_body,
            original_artifact_path=original_path,
            fallback_reason="artifact_not_html",
        )

    resolution = await _resolve_artifact_path_for_request(thread_id, path)
    try:
        source_html, content_type = _read_quick_patch_source(
            thread_id=resolution.resolved_task_thread_id or thread_id,
            path=path,
            resolution=resolution,
        )
    except (FileNotFoundError, UnicodeDecodeError):
        return _quick_patch_response(
            ok=False,
            result="unsupported",
            request=request_body,
            original_artifact_path=original_path,
            fallback_reason="source_artifact_not_found",
        )

    if content_type and content_type.split(";")[0].strip().lower() not in {"text/html", "application/xhtml+xml"}:
        return _quick_patch_response(
            ok=False,
            result="unsupported",
            request=request_body,
            original_artifact_path=original_path,
            fallback_reason="source_content_type_not_html",
        )

    patch = apply_html_quick_patch(
        source_html,
        quick_edit_kind=request_body.quick_edit_kind,
        target_fields=request_body.target_fields,
    )
    if not patch.ok or patch.html is None:
        return _quick_patch_response(
            ok=False,
            result=patch.result,
            request=request_body,
            original_artifact_path=original_path,
            fallback_reason=patch.fallback_reason,
            safe_summary=patch.safe_summary,
        )

    revision_path = revision_artifact_path(path, patch.html, request_body.user_update_request)
    # The revision is a user-facing derived artifact: the browser only receives
    # `revision_artifact_path` and re-fetches it through the parent
    # `/api/threads/{thread_id}/artifacts/...` route. That route's local
    # resolution checks the parent thread first and its Supabase fallback
    # (`_try_serve_from_supabase`) only ever looks under the parent `thread_id`.
    # Writing/mirroring under the source builder-task id (when the source
    # resolved from an associated task) would 404 the revision after a
    # disk-wiping restart even though it was mirrored. Home the revision —
    # local copy and Supabase mirror both — under the parent thread.
    _write_quick_patch_revision(
        thread_id=thread_id,
        revision_path=revision_path,
        content=patch.html,
    )
    _mirror_quick_patch_revision(
        thread_id=thread_id,
        revision_path=revision_path,
        content=patch.html,
    )

    logger.info(
        "Quick HTML patch saved: thread_id=%s source_path_hash=%s revision_path_hash=%s kind=%s",
        _short_id(thread_id),
        stable_path_hash(original_path),
        stable_path_hash(revision_path),
        request_body.quick_edit_kind,
    )
    response = _quick_patch_response(
        ok=True,
        result="patched",
        request=request_body,
        original_artifact_path=original_path,
        revision_path=revision_path,
        patched_content=patch.html,
        safe_summary=patch.safe_summary,
    )
    if authenticated_user_id:
        _upsert_quick_patch_revision_artifact(
            authenticated_user_id=authenticated_user_id,
            thread_id=thread_id,
            session_id=request_body.session_id,
            response=response,
        )
    return response


def _upsert_quick_patch_revision_artifact(
    *,
    authenticated_user_id: str,
    thread_id: str,
    session_id: str | None,
    response: HtmlQuickPatchResponse,
) -> None:
    if not response.ok or not response.revision_artifact_path:
        return
    try:
        _artifact_registry.upsert(
            ArtifactUpsertRequest(
                user_id=authenticated_user_id,
                thread_id=thread_id,
                session_id=session_id,
                title=Path(response.revision_artifact_path).name,
                filename=Path(response.revision_artifact_path).name,
                artifact_type="html",
                renderer_kind="html",
                mime_type="text/html",
                safe_summary=response.safe_summary,
                source="quick_edit",
                local_path=response.revision_artifact_path,
                content_hash=response.content_hash,
                storage_status="available",
                raw_content_excluded=True,
                signed_url_excluded=True,
            ),
            user_id=authenticated_user_id,
        )
    except Exception:  # noqa: BLE001 - registry is best-effort for quick edit.
        logger.warning(
            "Quick HTML patch artifact registry upsert failed: thread_id=%s revision_path_hash=%s",
            _short_id(thread_id),
            stable_path_hash(response.revision_artifact_path),
            exc_info=True,
        )


@router.get(
    "/threads/{thread_id}/artifacts/{path:path}",
    summary="Get Artifact File",
    description="Retrieve an artifact file generated by the AI agent. Supports text, HTML, and binary files.",
)
async def get_artifact(
    thread_id: str,
    path: str,
    request: Request,
    authenticated_user_id: str | None = Depends(require_authenticated_user),
) -> Response:
    """Get an artifact file by its path.

    The endpoint automatically detects file types and returns appropriate content types.
    Use the `?download=true` query parameter to force file download.

    Args:
        thread_id: The thread ID.
        path: The artifact path with virtual prefix (e.g., mnt/user-data/outputs/file.txt).
        request: FastAPI request object (automatically injected).

    Returns:
        The file content as a FileResponse with appropriate content type:
        - HTML files: Rendered as HTML
        - Text files: Plain text with proper MIME type
        - Binary files: Inline display with download option

    Raises:
        HTTPException:
            - 400 if path is invalid or not a file
            - 403 if access denied (path traversal detected)
            - 404 if file not found

    Query Parameters:
        download (bool): If true, returns file as attachment for download

    Example:
        - Get HTML file: `/api/threads/abc123/artifacts/mnt/user-data/outputs/index.html`
        - Download file: `/api/threads/abc123/artifacts/mnt/user-data/outputs/data.csv?download=true`
    """
    path = _normalize_artifact_virtual_path(path)
    _enforce_artifact_owner(authenticated_user_id, thread_id, path)

    # Check if this is a request for a file inside a .skill archive (e.g., xxx.skill/SKILL.md)
    if ".skill/" in path:
        return await _serve_skill_archive_artifact(thread_id, path)

    resolution = await _resolve_artifact_path_for_request(thread_id, path)
    actual_path = resolution.actual_path

    if not actual_path.exists():
        supabase_response = _try_serve_from_supabase(thread_id, path, request)
        if supabase_response is not None:
            return supabase_response
        raise HTTPException(status_code=404, detail=_artifact_not_found_detail(thread_id, path, resolution))

    if not actual_path.is_file():
        raise HTTPException(status_code=400, detail=f"Path is not a file: {path}")

    return _serve_local_artifact(thread_id, actual_path, request)


async def _serve_skill_archive_artifact(thread_id: str, path: str) -> Response:
    # Split the path at ".skill/" to get the ZIP file path and internal path
    skill_marker = ".skill/"
    marker_pos = path.find(skill_marker)
    skill_file_path = path[: marker_pos + len(".skill")]  # e.g., "mnt/user-data/outputs/my-skill.skill"
    internal_path = path[marker_pos + len(skill_marker) :]  # e.g., "SKILL.md"

    resolution = await _resolve_artifact_path_for_request(thread_id, skill_file_path)
    actual_skill_path = resolution.actual_path
    if not actual_skill_path.exists():
        raise HTTPException(status_code=404, detail=f"Skill file not found: {skill_file_path}")
    if not actual_skill_path.is_file():
        raise HTTPException(status_code=400, detail=f"Path is not a file: {skill_file_path}")

    content = _extract_file_from_skill_archive(actual_skill_path, internal_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File '{internal_path}' not found in skill archive")

    return _skill_archive_content_response(content, internal_path)


def _skill_archive_content_response(content: bytes, internal_path: str) -> Response:
    mime_type, _ = mimetypes.guess_type(internal_path)
    cache_headers = {"Cache-Control": "private, max-age=300"}
    if mime_type and mime_type.startswith("text/"):
        return PlainTextResponse(content=content.decode("utf-8"), media_type=mime_type, headers=cache_headers)

    try:
        return PlainTextResponse(content=content.decode("utf-8"), media_type="text/plain", headers=cache_headers)
    except UnicodeDecodeError:
        return Response(content=content, media_type=mime_type or "application/octet-stream", headers=cache_headers)


def _serve_local_artifact(
    thread_id: str,
    actual_path: Path,
    request: Request,
    *,
    force_download: bool = False,
) -> Response:
    mime_type, _ = mimetypes.guess_type(actual_path)
    # Encode filename for Content-Disposition header (RFC 5987)
    encoded_filename = quote(actual_path.name)

    # if `download` query parameter is true, return the file as a download.
    # Office binaries are also attachment-first because browsers cannot
    # preview authenticated PPTX/DOCX/XLSX files reliably.
    if force_download or request.query_params.get("download") or _is_office_download(actual_path):
        logger.info(
            "Serving artifact with attachment disposition: thread_id=%s ext=%s source=local download=%s bytes=%d",
            thread_id,
            actual_path.suffix.lower().lstrip(".") or None,
            bool(force_download or request.query_params.get("download")),
            actual_path.stat().st_size,
        )
        return FileResponse(path=actual_path, filename=actual_path.name, media_type=mime_type, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"})

    if mime_type and mime_type == "text/html":
        return HTMLResponse(content=actual_path.read_text(encoding="utf-8"))

    if mime_type and mime_type.startswith("text/"):
        return PlainTextResponse(content=actual_path.read_text(encoding="utf-8"), media_type=mime_type)

    if mime_type:
        return Response(content=actual_path.read_bytes(), media_type=mime_type, headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"})

    if is_text_file_by_content(actual_path):
        return PlainTextResponse(content=actual_path.read_text(encoding="utf-8"), media_type=mime_type)

    return Response(content=actual_path.read_bytes(), media_type=mime_type, headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"})
