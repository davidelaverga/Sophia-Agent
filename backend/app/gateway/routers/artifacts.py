import logging
import mimetypes
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from app.gateway.path_utils import resolve_thread_virtual_path
from deerflow.sophia.session_store import SessionStore
from deerflow.sophia.storage import supabase_artifact_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["artifacts"])
_OUTPUTS_VIRTUAL_PATH = "mnt/user-data/outputs"
_WORKSPACE_OUTPUTS_VIRTUAL_PATH = "mnt/user-data/workspace/outputs"

_session_store = SessionStore()


def _lookup_user_for_thread(thread_id: str) -> str | None:
    """Resolve the owning user_id for a thread by scanning session records.

    Best-effort — returns ``None`` when no matching record exists. Used to
    build the new-layout Supabase key ``{user_id}/{thread_id}/{filename}``
    from a per-thread artifact route that only has the thread_id.
    """
    if not thread_id:
        return None
    record = _session_store.find_by_thread_id(thread_id)
    return record.user_id if record is not None else None


class ThreadArtifactListItem(BaseModel):
    path: str
    name: str
    size_bytes: int
    modified_at: str
    mime_type: str | None = None


class ThreadArtifactListResponse(BaseModel):
    thread_id: str
    artifacts: list[ThreadArtifactListItem] = Field(default_factory=list)


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


def _try_serve_from_supabase(thread_id: str, path: str, request: Request) -> Response | None:
    """Serve the artifact from the ``sophia_builder`` Supabase bucket when missing locally.

    Layout: ``sophia_builder/{thread_id}/{relative_output_path}``. Returns
    ``None`` when Supabase is not configured, the path is not under the
    outputs virtual prefix, or the object is missing. Raises ``HTTPException``
    with 502 only when Supabase responds with an unexpected transport error.
    """
    relative = _relative_output_artifact_path(path)
    if relative is None or relative == "":
        return None
    try:
        result = supabase_artifact_store.download_artifact(
            user_id=_lookup_user_for_thread(thread_id),
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
    encoded_filename = quote(filename)

    logger.info(
        "Serving artifact from Supabase bucket: thread_id=%s requested_path=%s bytes=%d",
        thread_id,
        path,
        len(content),
    )

    if request.query_params.get("download"):
        return Response(
            content=content,
            media_type=mime_type or "application/octet-stream",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            },
        )

    if mime_type == "text/html":
        return HTMLResponse(content=content.decode("utf-8", errors="replace"))
    if mime_type and mime_type.startswith("text/"):
        return PlainTextResponse(
            content=content.decode("utf-8", errors="replace"),
            media_type=mime_type,
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
async def list_artifacts(thread_id: str) -> ThreadArtifactListResponse:
    outputs_path = resolve_thread_virtual_path(thread_id, _OUTPUTS_VIRTUAL_PATH)

    if not outputs_path.exists():
        return ThreadArtifactListResponse(thread_id=thread_id, artifacts=[])

    if not outputs_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {_OUTPUTS_VIRTUAL_PATH}")

    # Filter out builder-internal generator/helper scripts.
    # Convention (see builder_task.py completion_instruction): scripts that
    # produce a binary deliverable are named `_generate_<name>.py`,
    # `_gen_<name>.py`, `_launcher.py`, etc. Those live under outputs/ as
    # byproducts of the build process but should never be surfaced to the
    # user as deliverables — the user wants the PDF/PPTX/DOCX, not the
    # script that made it.
    def _is_builder_internal(name: str) -> bool:
        return name.startswith("_") and name.endswith(".py")

    files_with_stat = [
        (candidate, candidate.stat())
        for candidate in outputs_path.rglob("*")
        if candidate.is_file() and not _is_builder_internal(candidate.name)
    ]
    files_with_stat.sort(key=lambda item: item[1].st_mtime, reverse=True)

    artifacts: list[ThreadArtifactListItem] = []
    for file_path, stat_result in files_with_stat:
        relative_path = file_path.relative_to(outputs_path).as_posix()
        mime_type, _ = mimetypes.guess_type(file_path.name)
        artifacts.append(ThreadArtifactListItem(
            path=f"{_OUTPUTS_VIRTUAL_PATH}/{relative_path}",
            name=file_path.name,
            size_bytes=stat_result.st_size,
            modified_at=datetime.fromtimestamp(stat_result.st_mtime, tz=UTC).isoformat(),
            mime_type=mime_type,
        ))

    return ThreadArtifactListResponse(thread_id=thread_id, artifacts=artifacts)


@router.get(
    "/threads/{thread_id}/artifacts/{path:path}",
    summary="Get Artifact File",
    description="Retrieve an artifact file generated by the AI agent. Supports text, HTML, and binary files.",
)
async def get_artifact(thread_id: str, path: str, request: Request) -> Response:
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
    # Check if this is a request for a file inside a .skill archive (e.g., xxx.skill/SKILL.md)
    if ".skill/" in path:
        # Split the path at ".skill/" to get the ZIP file path and internal path
        skill_marker = ".skill/"
        marker_pos = path.find(skill_marker)
        skill_file_path = path[: marker_pos + len(".skill")]  # e.g., "mnt/user-data/outputs/my-skill.skill"
        internal_path = path[marker_pos + len(skill_marker) :]  # e.g., "SKILL.md"

        actual_skill_path = _resolve_artifact_path(thread_id, skill_file_path)

        if not actual_skill_path.exists():
            raise HTTPException(status_code=404, detail=f"Skill file not found: {skill_file_path}")

        if not actual_skill_path.is_file():
            raise HTTPException(status_code=400, detail=f"Path is not a file: {skill_file_path}")

        # Extract the file from the .skill archive
        content = _extract_file_from_skill_archive(actual_skill_path, internal_path)
        if content is None:
            raise HTTPException(status_code=404, detail=f"File '{internal_path}' not found in skill archive")

        # Determine MIME type based on the internal file
        mime_type, _ = mimetypes.guess_type(internal_path)
        # Add cache headers to avoid repeated ZIP extraction (cache for 5 minutes)
        cache_headers = {"Cache-Control": "private, max-age=300"}
        if mime_type and mime_type.startswith("text/"):
            return PlainTextResponse(content=content.decode("utf-8"), media_type=mime_type, headers=cache_headers)

        # Default to plain text for unknown types that look like text
        try:
            return PlainTextResponse(content=content.decode("utf-8"), media_type="text/plain", headers=cache_headers)
        except UnicodeDecodeError:
            return Response(content=content, media_type=mime_type or "application/octet-stream", headers=cache_headers)

    actual_path = _resolve_artifact_path(thread_id, path)

    logger.info(f"Resolving artifact path: thread_id={thread_id}, requested_path={path}, actual_path={actual_path}")

    if not actual_path.exists():
        supabase_response = _try_serve_from_supabase(thread_id, path, request)
        if supabase_response is not None:
            return supabase_response
        raise HTTPException(status_code=404, detail=f"Artifact not found: {path}")

    if not actual_path.is_file():
        raise HTTPException(status_code=400, detail=f"Path is not a file: {path}")

    mime_type, _ = mimetypes.guess_type(actual_path)

    # Encode filename for Content-Disposition header (RFC 5987)
    encoded_filename = quote(actual_path.name)

    # if `download` query parameter is true, return the file as a download
    if request.query_params.get("download"):
        return FileResponse(path=actual_path, filename=actual_path.name, media_type=mime_type, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"})

    if mime_type and mime_type == "text/html":
        try:
            return HTMLResponse(content=actual_path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            logger.warning("Artifact guessed as HTML is not valid UTF-8; serving inline bytes instead: %s", actual_path)

    if mime_type and mime_type.startswith("text/"):
        try:
            return PlainTextResponse(content=actual_path.read_text(encoding="utf-8"), media_type=mime_type)
        except UnicodeDecodeError:
            logger.warning("Artifact guessed as text is not valid UTF-8; serving inline bytes instead: %s", actual_path)

    if is_text_file_by_content(actual_path):
        try:
            return PlainTextResponse(content=actual_path.read_text(encoding="utf-8"), media_type=mime_type)
        except UnicodeDecodeError:
            logger.warning("Artifact content sniffed as text is not valid UTF-8; serving inline bytes instead: %s", actual_path)

    return Response(content=actual_path.read_bytes(), media_type=mime_type, headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"})


# ---------------------------------------------------------------------------
# User-scoped builder files (cross-session library)
# ---------------------------------------------------------------------------


class UserBuilderFileItem(BaseModel):
    thread_id: str
    session_id: str | None = None
    session_title: str | None = None
    path: str
    name: str
    size_bytes: int
    modified_at: str
    mime_type: str | None = None


class UserBuilderFilesResponse(BaseModel):
    user_id: str
    items: list[UserBuilderFileItem] = Field(default_factory=list)
    total: int
    limit: int


def _validate_user_id(user_id: str) -> str:
    try:
        from deerflow.agents.sophia_agent.utils import validate_user_id
        return validate_user_id(user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Invalid user_id format") from e


def _is_builder_internal_file(name: str) -> bool:
    return name.startswith("_") and name.endswith(".py")


def _collect_thread_artifacts(
    thread_id: str,
    session_id: str | None,
    session_title: str | None,
) -> list[UserBuilderFileItem]:
    outputs_path = resolve_thread_virtual_path(thread_id, _OUTPUTS_VIRTUAL_PATH)
    if not outputs_path.exists() or not outputs_path.is_dir():
        return []
    items: list[UserBuilderFileItem] = []
    for file_path in outputs_path.rglob("*"):
        if not file_path.is_file():
            continue
        if _is_builder_internal_file(file_path.name):
            continue
        try:
            stat_result = file_path.stat()
        except OSError:
            continue
        relative = file_path.relative_to(outputs_path).as_posix()
        mime_type, _ = mimetypes.guess_type(file_path.name)
        items.append(UserBuilderFileItem(
            thread_id=thread_id,
            session_id=session_id,
            session_title=session_title,
            path=f"{_OUTPUTS_VIRTUAL_PATH}/{relative}",
            name=file_path.name,
            size_bytes=stat_result.st_size,
            modified_at=datetime.fromtimestamp(stat_result.st_mtime, tz=UTC).isoformat(),
            mime_type=mime_type,
        ))
    return items


@router.get(
    "/users/{user_id}/builder-files",
    response_model=UserBuilderFilesResponse,
    summary="List all builder files for a user across sessions",
)
async def list_user_builder_files(
    user_id: str,
    limit: int = 30,
) -> UserBuilderFilesResponse:
    """Return up to ``limit`` most-recently-modified builder files across every
    thread owned by ``user_id``.

    Walks the local per-thread outputs directories. The existing
    ``GET /api/threads/{thread_id}/artifacts/{path}`` endpoint remains the
    download surface — it already falls back to Supabase when the local copy
    is missing. This endpoint only needs to enumerate.
    """
    validated_user = _validate_user_id(user_id)
    safe_limit = max(1, min(limit, 100))

    # Avoid a hard import cycle — import lazily.
    from app.gateway.routers.sessions import _list_recent_records

    records = _list_recent_records(validated_user, limit=200)

    # Dedupe by thread_id (a reopened session may share a thread).
    seen_threads: dict[str, tuple[str | None, str | None]] = {}
    for record in records:
        if not record.thread_id:
            continue
        if record.thread_id in seen_threads:
            continue
        seen_threads[record.thread_id] = (record.session_id, record.title)

    all_items: list[UserBuilderFileItem] = []
    # Track (thread_id, relative_path) to merge Supabase entries without
    # duplicating files we already found on local disk.
    seen_keys: set[tuple[str, str]] = set()
    for thread_id, (session_id, session_title) in seen_threads.items():
        for item in _collect_thread_artifacts(thread_id, session_id, session_title):
            relative = item.path[len(_OUTPUTS_VIRTUAL_PATH) + 1 :] if item.path.startswith(
                _OUTPUTS_VIRTUAL_PATH + "/"
            ) else item.name
            seen_keys.add((thread_id, relative))
            all_items.append(item)

    # Merge Supabase-mirrored files the gateway does not have locally. Happens
    # on stateless/multi-instance deployments where the outputs dir is ephemeral.
    if supabase_artifact_store.is_configured():
        try:
            supabase_items = supabase_artifact_store.list_user_objects(
                validated_user,
                limit=max(safe_limit * 4, 200),
            ) or []
        except Exception:  # noqa: BLE001 — best-effort enrichment
            logger.exception(
                "Supabase list failed for user_id=%s; serving local results only",
                validated_user,
            )
            supabase_items = []

        for remote in supabase_items:
            name = remote.get("name")
            if not isinstance(name, str) or "/" not in name:
                continue
            thread_id, _, relative = name.partition("/")
            if not thread_id or not relative:
                continue
            if _is_builder_internal_file(Path(relative).name):
                continue
            key = (thread_id, relative)
            if key in seen_keys:
                continue
            seen_keys.add(key)

            metadata = remote.get("metadata") if isinstance(remote.get("metadata"), dict) else {}
            size_bytes = metadata.get("size") if isinstance(metadata, dict) else None
            mime_type = metadata.get("mimetype") if isinstance(metadata, dict) else None
            modified_at = (
                remote.get("updated_at")
                or remote.get("created_at")
                or datetime.now(UTC).isoformat()
            )
            session_id, session_title = seen_threads.get(thread_id, (None, None))
            all_items.append(UserBuilderFileItem(
                thread_id=thread_id,
                session_id=session_id,
                session_title=session_title,
                path=f"{_OUTPUTS_VIRTUAL_PATH}/{relative}",
                name=Path(relative).name,
                size_bytes=int(size_bytes) if isinstance(size_bytes, (int, float)) else 0,
                modified_at=modified_at if isinstance(modified_at, str) else datetime.now(UTC).isoformat(),
                mime_type=mime_type if isinstance(mime_type, str) else None,
            ))

    all_items.sort(key=lambda item: item.modified_at, reverse=True)
    total = len(all_items)
    return UserBuilderFilesResponse(
        user_id=validated_user,
        items=all_items[:safe_limit],
        total=total,
        limit=safe_limit,
    )


@router.delete(
    "/threads/{thread_id}/artifacts/{path:path}",
    summary="Delete a builder artifact file (local + Supabase mirror)",
)
async def delete_artifact(thread_id: str, path: str) -> Response:
    """Delete a builder-generated file.

    Removes the local copy under ``mnt/user-data/outputs/`` and, best-effort,
    the Supabase mirror at ``sophia_builder/{thread_id}/{relative_path}``.
    Returns 204 on success, 404 when neither copy exists.
    """
    relative = _relative_output_artifact_path(path)
    if relative is None or relative == "":
        raise HTTPException(status_code=400, detail="Only paths under outputs/ can be deleted")

    actual_path = _resolve_artifact_path(thread_id, path)
    deleted_local = False
    if actual_path.exists() and actual_path.is_file():
        try:
            actual_path.unlink()
            deleted_local = True
        except OSError as e:
            logger.warning("Failed to delete local artifact %s: %s", actual_path, e)
            raise HTTPException(status_code=500, detail="Failed to delete artifact") from e

    deleted_remote = False
    try:
        deleted_remote = supabase_artifact_store.delete_object(
            user_id=_lookup_user_for_thread(thread_id),
            thread_id=thread_id,
            filename=relative,
        )
    except Exception:  # noqa: BLE001 — network/transport; local delete is authoritative
        logger.exception(
            "Supabase delete failed: thread_id=%s path=%s", thread_id, path,
        )

    if not deleted_local and not deleted_remote:
        raise HTTPException(status_code=404, detail=f"Artifact not found: {path}")

    logger.info(
        "Deleted artifact thread_id=%s path=%s local=%s supabase=%s",
        thread_id, path, deleted_local, deleted_remote,
    )
    return Response(status_code=204)
