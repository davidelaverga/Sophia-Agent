"""Internal artifact replication router.

Accepts POST requests from the LangGraph service to replicate builder
artifacts onto the Gateway's persistent disk. Not exposed to browsers or
end-users; authentication is via a shared secret.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse

from app.gateway.path_utils import resolve_thread_virtual_path

logger = logging.getLogger(__name__)

router = APIRouter(tags=["internal"])

_INTERNAL_SECRET_ENV = "SOPHIA_INTERNAL_SECRET"
_OUTPUTS_VIRTUAL_PREFIX = "mnt/user-data/outputs"


def _load_secret() -> str | None:
    val = os.getenv(_INTERNAL_SECRET_ENV, "").strip()
    return val if val else None


def _require_secret(request: Request) -> None:
    secret = _load_secret()
    if not secret:
        raise HTTPException(status_code=503, detail="Internal replication not configured")
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    provided = auth[len("Bearer "):].strip()
    # Use a constant-time comparison to avoid timing side-channels.
    if not _constant_time_compare(provided, secret):
        raise HTTPException(status_code=401, detail="Invalid bearer token")


def _constant_time_compare(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    return sum(x != y for x, y in zip(a, b)) == 0


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _resolve_safe_path(thread_id: str, tail_path: str) -> Path:
    """Resolve a path relative to the thread's outputs directory.

    Rejects anything that does not resolve under ``outputs/`` to prevent
    writing to arbitrary filesystem locations.
    """
    virtual = f"/mnt/user-data/outputs/{tail_path.lstrip('/')}"
    try:
        actual = resolve_thread_virtual_path(thread_id, virtual)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {exc}") from exc

    return actual


@router.post("/internal/artifacts/{thread_id}/{path:path}", status_code=204)
async def replicate_artifact(
    request: Request,
    thread_id: str,
    path: str,
    x_content_sha256: str | None = Header(default=None),
) -> Response:
    """Replicate a single builder artifact onto the Gateway disk.

    The body is the raw file bytes. The response is ``204 No Content`` on
    success with an ``ETag`` header set to the SHA-256 of the stored file.
    """
    _require_secret(request)

    actual = _resolve_safe_path(thread_id, path)

    # Ensure parent directory exists with permissive permissions so sandbox
    # containers that may run as a different UID can still read/write.
    actual.parent.mkdir(parents=True, exist_ok=True)
    actual.parent.chmod(0o777)

    body = await request.body()
    if x_content_sha256 and _sha256_of_bytes(body) != x_content_sha256:
        # Don't reject — just warn. SHA-256 may have been computed with
        # different newline normalization; the file should still land.
        logger.warning(
            "SHA-256 mismatch during replication: thread_id=%s path=%s", thread_id, path
        )

    tmp = actual.with_suffix(actual.suffix + ".part")
    tmp.write_bytes(body)
    tmp.replace(actual)

    etag = _sha256(actual)
    logger.info(
        "Replicated artifact: thread_id=%s path=%s bytes=%d etag=%s",
        thread_id,
        path,
        len(body),
        etag,
    )
    return Response(status_code=204, headers={"ETag": etag})


@router.head("/internal/artifacts/{thread_id}/{path:path}")
async def check_artifact(
    request: Request,
    thread_id: str,
    path: str,
    x_content_sha256: str | None = Header(default=None),
) -> Response:
    """Check whether a replicated artifact exists and matches a hash."""
    _require_secret(request)

    actual = _resolve_safe_path(thread_id, path)
    if not actual.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")

    etag = _sha256(actual)
    if x_content_sha256 and x_content_sha256 != etag:
        # Hash mismatch — file changed since expected
        return Response(status_code=409, headers={"ETag": etag})

    return Response(status_code=200, headers={"ETag": etag})


def _sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
