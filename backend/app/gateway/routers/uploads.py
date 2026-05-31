"""Upload router for handling file uploads."""

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel

from app.gateway.auth import is_auth_bypass_enabled, resolve_bearer_user_id
from deerflow.config.paths import VIRTUAL_PATH_PREFIX, get_paths
from deerflow.sandbox.sandbox_provider import get_sandbox_provider
from deerflow.sophia.session_store import SessionStore
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.utils.file_conversion import CONVERTIBLE_EXTENSIONS, convert_file_to_markdown

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Auth: authenticated, thread-ownership-scoped access (Codex P1 PR #132).
#
# The gateway is independently reachable (it's the public ``sophia-gateway``
# Render web service, and nginx also proxies ``/api/threads/.../uploads`` to
# it), so these routes must NOT rely on the Next.js proxy's ownership check —
# a caller who knows a thread id could otherwise POST / list / DELETE files
# under another user's thread (and mutate the Supabase mirror), which the
# victim's view_user_image / builder flow would later consume.
#
# Enforcement is UNCONDITIONAL — same posture as the other protected
# gateway routers (voice, telegram_link), which always require auth. We do
# NOT gate on a feature flag: a default-off flag (the earlier approach) left
# the routes open in any deployment that didn't set it — exactly the
# production hole Codex flagged (render.yaml never set it). The upload routes
# are scoped by ``{thread_id}`` (no ``{user_id}`` path param), so they can't
# use ``require_authorized_user_scope`` (which reads
# ``path_params['user_id']``); instead we resolve the bearer token to a user
# via the async ``resolve_bearer_user_id`` and verify that user owns the
# thread. The frontend proxy already forwards the user-scoped Bearer token,
# and ``resolve_bearer_user_id`` reuses the SAME ``/api/v1/auth/me`` bridge
# voice.py uses in production — so this works with the existing deployment.
#
# Local dev / tests set ``SOPHIA_AUTH_BYPASS=true``: token resolution then
# returns the dev user and ownership is skipped (the same escape hatch the
# other routers honor). Bypass must NEVER be set in production.
# ---------------------------------------------------------------------------

# NOTE: ``SessionStore`` is a FACTORY FUNCTION (returns a
# SophiaSupabaseSessionStore / filesystem store instance), NOT a class —
# so it must not be used as a type annotation (``SessionStore | None``
# would evaluate ``function | None`` at import time and raise TypeError,
# since this module has no ``from __future__ import annotations``). Hold
# the lazily-built instance without a union annotation.
_ownership_store = None  # built lazily by _get_ownership_store()


def _get_ownership_store():
    """Lazily build the session store used for thread-ownership lookups.

    Lazy so importing this module never triggers store construction at
    import time (keeps test collection + cold starts cheap).
    """
    global _ownership_store
    if _ownership_store is None:
        _ownership_store = SessionStore()
    return _ownership_store


def _user_owns_thread(user_id: str, thread_id: str) -> bool:
    """Return True iff one of ``user_id``'s sessions maps to ``thread_id``.

    Mirrors the frontend proxy's ``userOwnsThread`` (which lists the user's
    sessions and matches the thread). Checks BOTH open and recent sessions
    via the real ``SessionStore`` API (``list_open`` / ``list_recent`` — the
    same methods the sessions router uses; there is no ``list_all_for_user``).
    Fails CLOSED on any error — a lookup failure must never grant access.
    """
    try:
        store = _get_ownership_store()
        records = list(store.list_open(user_id)) + list(store.list_recent(user_id, limit=100))
    except Exception as exc:  # noqa: BLE001 — fail closed on any store error
        logger.warning("Thread-ownership lookup failed user_id=%s thread_id=%s error=%s", user_id, thread_id, exc)
        return False
    return any(getattr(r, "thread_id", None) == thread_id for r in records)


async def verify_thread_access(thread_id: str, request: Request) -> str:
    """FastAPI dependency: authenticate the caller and enforce thread ownership.

    Unconditional. Resolves the bearer token to a user (401 on a
    missing/invalid token, 503 if the auth bridge is down), then raises 403
    unless that user owns ``thread_id``. In explicit dev-bypass mode
    (``SOPHIA_AUTH_BYPASS=true``) the resolver returns the dev user and the
    ownership check is skipped — local dev / tests only; never production.
    Router-level dependencies ignore the return value; it's returned for
    direct unit testing.
    """
    user_id = await resolve_bearer_user_id(request)
    if is_auth_bypass_enabled():
        return user_id
    if not _user_owns_thread(user_id, thread_id):
        raise HTTPException(status_code=403, detail="Thread not owned by current user")
    return user_id


router = APIRouter(
    prefix="/api/threads/{thread_id}/uploads",
    tags=["uploads"],
    dependencies=[Depends(verify_thread_access)],
)


class UploadResponse(BaseModel):
    """Response model for file upload."""

    success: bool
    files: list[dict[str, str]]
    message: str


def get_uploads_dir(thread_id: str) -> Path:
    """Get the uploads directory for a thread.

    Args:
        thread_id: The thread ID.

    Returns:
        Path to the uploads directory.
    """
    base_dir = get_paths().sandbox_uploads_dir(thread_id)
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _mirror_upload_to_supabase(thread_id: str, filename: str, content: bytes) -> None:
    """Best-effort mirror of an uploaded file to Supabase Storage.

    See the call site for the full rationale: the gateway and the langgraph
    runtime are separate Render containers with separate disks, so the
    companion's read tools (which run in langgraph) can't see a file written
    only to the gateway's disk. We push every upload to Supabase under the
    UPLOADS keyspace ``{thread_id}/uploads/{filename}`` (separate from the
    builder-output keyspace ``{thread_id}/{name}`` so same-named files don't
    collide — Codex P1 PR #132) and the read tools download on a local miss.

    Never raises — a Supabase outage / missing config must not fail the
    upload (local/dev without Supabase keeps working).
    """
    if not supabase_artifact_store.is_configured():
        return
    try:
        object_name = supabase_artifact_store.uploads_object_name(filename)
        supabase_artifact_store.upload_artifact(thread_id, object_name, content)
    except Exception as exc:  # noqa: BLE001 — best-effort mirror, never block upload
        logger.warning(
            "Supabase upload mirror failed (continuing) thread_id=%s filename=%s error=%s",
            thread_id,
            filename,
            exc,
        )


def _delete_supabase_mirror(thread_id: str, filename: str) -> None:
    """Best-effort removal of a mirrored upload from Supabase Storage.

    Counterpart to ``_mirror_upload_to_supabase`` (PR #132): without this,
    a file the user discards stays in Supabase and the companion's read
    tools would re-materialize the "deleted" content from the mirror on
    the next local miss. Never raises — the local delete is the primary
    operation.
    """
    if not supabase_artifact_store.is_configured():
        return
    try:
        object_name = supabase_artifact_store.uploads_object_name(filename)
        supabase_artifact_store.delete_artifact(thread_id, object_name)
    except Exception as exc:  # noqa: BLE001 — best-effort, never block delete
        logger.warning(
            "Supabase delete mirror failed (continuing) thread_id=%s filename=%s error=%s",
            thread_id,
            filename,
            exc,
        )


@router.post("", response_model=UploadResponse)
async def upload_files(
    thread_id: str,
    files: list[UploadFile] = File(...),
) -> UploadResponse:
    """Upload multiple files to a thread's uploads directory.

    For PDF, PPT, Excel, and Word files, they will be converted to markdown using markitdown.
    All files (original and converted) are saved to /mnt/user-data/uploads.

    Args:
        thread_id: The thread ID to upload files to.
        files: List of files to upload.

    Returns:
        Upload response with success status and file information.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    uploads_dir = get_uploads_dir(thread_id)
    paths = get_paths()
    uploaded_files = []

    sandbox_provider = get_sandbox_provider()
    sandbox_id = sandbox_provider.acquire(thread_id)
    sandbox = sandbox_provider.get(sandbox_id)

    for file in files:
        if not file.filename:
            continue

        try:
            # Normalize filename to prevent path traversal
            safe_filename = Path(file.filename).name
            if not safe_filename or safe_filename in {".", ".."} or "/" in safe_filename or "\\" in safe_filename:
                logger.warning(f"Skipping file with unsafe filename: {file.filename!r}")
                continue

            content = await file.read()
            file_path = uploads_dir / safe_filename
            file_path.write_bytes(content)

            # Cross-service mirror (PR #132): the gateway and the langgraph
            # runtime are SEPARATE Render containers with SEPARATE ephemeral
            # disks (render.yaml declares no shared/persistent disk). The
            # companion's view_user_image / read_user_document tools run in
            # the langgraph container and read sandbox_uploads_dir(thread_id)
            # on THAT disk — so a file written here on the gateway disk is
            # invisible to them. Mirror every upload to Supabase Storage under
            # {thread_id}/{filename}; the read tools fall back to downloading
            # from there on a local miss. Best-effort: a Supabase failure must
            # not fail the upload (local/dev with no Supabase keeps working).
            _mirror_upload_to_supabase(thread_id, safe_filename, content)

            # Build relative path from backend root
            relative_path = str(paths.sandbox_uploads_dir(thread_id) / safe_filename)
            virtual_path = f"{VIRTUAL_PATH_PREFIX}/uploads/{safe_filename}"

            # Keep local sandbox source of truth in thread-scoped host storage.
            # For non-local sandboxes, also sync to virtual path for runtime visibility.
            if sandbox_id != "local":
                sandbox.update_file(virtual_path, content)

            file_info = {
                "filename": safe_filename,
                "size": str(len(content)),
                "path": relative_path,  # Actual filesystem path (relative to backend/)
                "virtual_path": virtual_path,  # Path for Agent in sandbox
                "artifact_url": f"/api/threads/{thread_id}/artifacts/mnt/user-data/uploads/{safe_filename}",  # HTTP URL
            }

            logger.info(f"Saved file: {safe_filename} ({len(content)} bytes) to {relative_path}")

            # Check if file should be converted to markdown
            file_ext = file_path.suffix.lower()
            if file_ext in CONVERTIBLE_EXTENSIONS:
                md_path = await convert_file_to_markdown(file_path)
                if md_path:
                    md_relative_path = str(paths.sandbox_uploads_dir(thread_id) / md_path.name)
                    md_virtual_path = f"{VIRTUAL_PATH_PREFIX}/uploads/{md_path.name}"

                    # Mirror the conversion sibling too — read_user_document
                    # reads the <stem>.md for PDFs/DOCX/etc., and it lives on
                    # the gateway disk just like the original. Without this the
                    # converted text is also invisible to the langgraph tools.
                    try:
                        _mirror_upload_to_supabase(thread_id, md_path.name, md_path.read_bytes())
                    except OSError as mirror_exc:
                        logger.warning("Could not read converted md for Supabase mirror: %s", mirror_exc)

                    if sandbox_id != "local":
                        sandbox.update_file(md_virtual_path, md_path.read_bytes())

                    file_info["markdown_file"] = md_path.name
                    file_info["markdown_path"] = md_relative_path
                    file_info["markdown_virtual_path"] = md_virtual_path
                    file_info["markdown_artifact_url"] = f"/api/threads/{thread_id}/artifacts/mnt/user-data/uploads/{md_path.name}"

            uploaded_files.append(file_info)

        except Exception as e:
            logger.error(f"Failed to upload {file.filename}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to upload {file.filename}: {str(e)}")

    return UploadResponse(
        success=True,
        files=uploaded_files,
        message=f"Successfully uploaded {len(uploaded_files)} file(s)",
    )


@router.get("/list", response_model=dict)
async def list_uploaded_files(thread_id: str) -> dict:
    """List all files in a thread's uploads directory.

    Args:
        thread_id: The thread ID to list files for.

    Returns:
        Dictionary containing list of files with their metadata.
    """
    uploads_dir = get_uploads_dir(thread_id)

    if not uploads_dir.exists():
        return {"files": [], "count": 0}

    files = []
    for file_path in sorted(uploads_dir.iterdir()):
        if file_path.is_file():
            stat = file_path.stat()
            relative_path = str(get_paths().sandbox_uploads_dir(thread_id) / file_path.name)
            files.append(
                {
                    "filename": file_path.name,
                    "size": stat.st_size,
                    "path": relative_path,  # Actual filesystem path
                    "virtual_path": f"{VIRTUAL_PATH_PREFIX}/uploads/{file_path.name}",  # Path for Agent in sandbox
                    "artifact_url": f"/api/threads/{thread_id}/artifacts/mnt/user-data/uploads/{file_path.name}",  # HTTP URL
                    "extension": file_path.suffix,
                    "modified": stat.st_mtime,
                }
            )

    return {"files": files, "count": len(files)}


@router.delete("/{filename}")
async def delete_uploaded_file(thread_id: str, filename: str) -> dict:
    """Delete a file from a thread's uploads directory.

    Args:
        thread_id: The thread ID.
        filename: The filename to delete.

    Returns:
        Success message.
    """
    uploads_dir = get_uploads_dir(thread_id)
    file_path = uploads_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    # Security check: ensure the path is within the uploads directory
    try:
        file_path.resolve().relative_to(uploads_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        if file_path.suffix.lower() in CONVERTIBLE_EXTENSIONS:
            companion_markdown = file_path.with_suffix(".md")
            companion_markdown.unlink(missing_ok=True)
            # Mirror removal (PR #132): drop the converted .md from Supabase
            # too, or read_user_document (separate container) would
            # re-materialize the discarded conversion on the next local miss.
            _delete_supabase_mirror(thread_id, companion_markdown.name)
        file_path.unlink(missing_ok=True)
        # Remove the Supabase mirror of the original (PR #132). Without this,
        # view_user_image / read_user_document (which run in a separate
        # container) would re-download the discarded file on the next local
        # miss and surface it to the companion / builder again.
        _delete_supabase_mirror(thread_id, filename)
        logger.info(f"Deleted file: {filename}")
        return {"success": True, "message": f"Deleted {filename}"}
    except Exception as e:
        logger.error(f"Failed to delete {filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete {filename}: {str(e)}")
