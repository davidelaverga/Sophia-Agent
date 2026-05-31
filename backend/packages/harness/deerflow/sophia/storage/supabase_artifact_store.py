"""Supabase Storage adapter for Sophia builder artifacts.

Uploads and downloads builder-generated files to the ``sophia_builder``
bucket using the Supabase Storage REST API via ``httpx``. One folder per
``thread_id``, one object per generated document.

The adapter is a graceful no-op when the required environment variables
are missing so local development keeps working without Supabase.
"""

from __future__ import annotations

import logging
import mimetypes
import os
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


DEFAULT_BUCKET = "sophia_builder"
_REQUEST_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    service_role_key: str
    bucket: str


def _load_config() -> SupabaseConfig | None:
    url = os.getenv("SUPABASE_URL")
    service_role_key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_KEY")
    )
    bucket = os.getenv("SUPABASE_BUILDER_BUCKET", DEFAULT_BUCKET)
    if not url or not service_role_key:
        return None
    return SupabaseConfig(url=url.rstrip("/"), service_role_key=service_role_key, bucket=bucket)


def is_configured() -> bool:
    return _load_config() is not None


def _object_url(config: SupabaseConfig, object_path: str) -> str:
    # Path segments stay as-is; Supabase Storage accepts raw file names.
    return f"{config.url}/storage/v1/object/{config.bucket}/{object_path}"


def _object_path(thread_id: str, filename: str) -> str:
    safe_thread = thread_id.strip().strip("/")
    safe_name = filename.strip().lstrip("/")
    if not safe_thread or not safe_name:
        raise ValueError("thread_id and filename are required")
    return f"{safe_thread}/{safe_name}"


# Keyspace separation (Codex P1 PR #132). User UPLOADS mirror under
# ``{thread_id}/uploads/{name}``; builder OUTPUTS mirror under
# ``{thread_id}/{output_relative_path}`` (see ``supabase_mirror.py``).
# Without this prefix a user upload and a builder artifact with the same
# basename (e.g. ``report.pdf``) would overwrite each other in the same
# bucket folder — whichever ran last would win, and a later local miss in
# view_user_image / read_user_document could materialize the wrong bytes
# (or a completion-card signed URL could point at an upload instead of the
# builder deliverable). ``uploads_object_name`` is the SINGLE source of
# truth for the upload prefix, shared by the gateway upload mirror AND the
# companion read tools so both address the exact same object.
UPLOADS_PREFIX = "uploads/"


def uploads_object_name(filename: str) -> str:
    """Map a bare upload filename to its prefixed Supabase object name.

    ``report.pdf`` -> ``uploads/report.pdf``. The ``{thread_id}/`` folder is
    prepended by ``_object_path`` at call time, yielding the full key
    ``{thread_id}/uploads/report.pdf`` — distinct from the builder-output
    keyspace ``{thread_id}/report.pdf``.
    """
    return f"{UPLOADS_PREFIX}{filename.strip().lstrip('/')}"


def upload_artifact(
    thread_id: str,
    filename: str,
    content: bytes,
    *,
    content_type: str | None = None,
    client: httpx.Client | None = None,
) -> str | None:
    """Upload ``content`` to ``sophia_builder/{thread_id}/{filename}``.

    Returns the object path on success, ``None`` when Supabase is not
    configured, and raises :class:`httpx.HTTPError` on transport errors.
    """
    config = _load_config()
    if config is None:
        logger.debug("Supabase not configured; skipping upload for %s/%s", thread_id, filename)
        return None

    object_path = _object_path(thread_id, filename)
    url = _object_url(config, object_path)
    mime_type = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": mime_type,
        # Overwrite any existing copy so re-runs for the same thread are idempotent.
        "x-upsert": "true",
        "Cache-Control": "no-cache",
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.post(url, content=content, headers=headers)
        response.raise_for_status()
    finally:
        if owns_client:
            http.close()

    logger.info(
        "Uploaded builder artifact to Supabase: bucket=%s thread_id=%s filename=%s bytes=%d",
        config.bucket,
        thread_id,
        filename,
        len(content),
    )
    return object_path


def check_artifact_exists(
    thread_id: str,
    filename: str,
    *,
    client: httpx.Client | None = None,
) -> bool:
    """Return ``True`` if the object exists in the Supabase bucket.

    Uses a lightweight HEAD request. Returns ``False`` when Supabase is
    not configured, when the object is missing (404), or on transport
    errors (logged but swallowed so the builder flow never regresses).
    """
    config = _load_config()
    if config is None:
        return False

    object_path = _object_path(thread_id, filename)
    url = _object_url(config, object_path)
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.head(url, headers=headers)
        if response.status_code == 404:
            return False
        # Any non-2xx is treated as "not exists" to keep the builder flow
        # resilient against transient Supabase hiccups.
        if not response.is_success:
            logger.warning(
                "Supabase HEAD check failed for thread_id=%s filename=%s status=%s; treating as missing",
                thread_id,
                filename,
                response.status_code,
            )
            return False
        return True
    except httpx.HTTPError as exc:
        logger.warning(
            "Supabase HEAD check error for thread_id=%s filename=%s error=%s; treating as missing",
            thread_id,
            filename,
            exc,
        )
        return False
    finally:
        if owns_client:
            http.close()


def create_signed_url(
    thread_id: str,
    filename: str,
    *,
    expires_in_seconds: int = 7 * 24 * 60 * 60,
    client: httpx.Client | None = None,
) -> str | None:
    """Mint a temporary signed URL for an uploaded artifact.

    Used by the builder-events notifier so completion cards can deliver the
    artifact directly without server-side proxying. Returns the absolute
    signed URL on success, ``None`` when Supabase is not configured or
    signing fails (caller should fall back to no link in that case).

    Default expiry is 7 days. Channel-specific deliverers can override (e.g.
    Telegram passes the URL straight to ``send_document``, which downloads
    server-side, so a short expiry is fine).
    """
    config = _load_config()
    if config is None:
        return None

    object_path = _object_path(thread_id, filename)
    sign_url = f"{config.url}/storage/v1/object/sign/{config.bucket}/{object_path}"
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": "application/json",
    }
    body = {"expiresIn": int(expires_in_seconds)}

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.post(sign_url, json=body, headers=headers)
        if not response.is_success:
            logger.warning(
                "Supabase signed-URL mint failed for %s/%s status=%s body=%s",
                thread_id,
                filename,
                response.status_code,
                response.text[:200],
            )
            return None
        data = response.json()
        signed_url = data.get("signedURL") or data.get("signed_url")
        if not isinstance(signed_url, str) or not signed_url:
            logger.warning(
                "Supabase signed-URL response missing signedURL field for %s/%s",
                thread_id,
                filename,
            )
            return None
        # Supabase returns a path relative to ``/storage/v1`` — combine with
        # the configured public URL to produce a usable absolute link.
        if signed_url.startswith("http://") or signed_url.startswith("https://"):
            return signed_url
        if signed_url.startswith("/"):
            return f"{config.url}/storage/v1{signed_url}"
        return f"{config.url}/storage/v1/{signed_url}"
    except httpx.HTTPError as exc:
        logger.warning(
            "Supabase signed-URL mint error for %s/%s error=%s",
            thread_id,
            filename,
            exc,
        )
        return None
    finally:
        if owns_client:
            http.close()


def delete_artifact(
    thread_id: str,
    filename: str,
    *,
    client: httpx.Client | None = None,
) -> bool:
    """Delete the mirrored object at ``{bucket}/{thread_id}/{filename}``.

    Returns ``True`` when the object was deleted OR was already absent
    (404 — idempotent delete), ``False`` when Supabase is not configured
    or the delete failed. Best-effort: transport errors are logged and
    swallowed (returns ``False``) so a delete-endpoint call never 500s on
    a Supabase hiccup — the local file is the primary copy.

    PR #132: the upload route mirrors every upload to Supabase so the
    companion's read tools (which run in a separate container) can fetch
    it. The DELETE endpoint must therefore ALSO remove the mirror, or a
    discarded file would re-materialize from Supabase on the next
    view_user_image / read_user_document local miss.
    """
    config = _load_config()
    if config is None:
        return False

    object_path = _object_path(thread_id, filename)
    url = _object_url(config, object_path)
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.delete(url, headers=headers)
        if response.status_code == 404:
            return True  # already gone — idempotent
        if not response.is_success:
            logger.warning(
                "Supabase delete failed thread_id=%s filename=%s status=%s body=%s",
                thread_id,
                filename,
                response.status_code,
                response.text[:200],
            )
            return False
        logger.info(
            "Deleted mirrored artifact from Supabase: bucket=%s thread_id=%s filename=%s",
            config.bucket,
            thread_id,
            filename,
        )
        return True
    except httpx.HTTPError as exc:
        logger.warning(
            "Supabase delete error thread_id=%s filename=%s error=%s",
            thread_id,
            filename,
            exc,
        )
        return False
    finally:
        if owns_client:
            http.close()


def download_artifact(
    thread_id: str,
    filename: str,
    *,
    client: httpx.Client | None = None,
) -> tuple[bytes, str] | None:
    """Download the artifact bytes and content type from Supabase.

    Returns ``None`` when Supabase is not configured or the object is
    missing. Raises :class:`httpx.HTTPError` on other transport errors.
    """
    config = _load_config()
    if config is None:
        return None

    object_path = _object_path(thread_id, filename)
    url = _object_url(config, object_path)
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.get(url, headers=headers)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return (
            response.content,
            response.headers.get("content-type")
            or mimetypes.guess_type(filename)[0]
            or "application/octet-stream",
        )
    finally:
        if owns_client:
            http.close()


def list_upload_filenames(
    thread_id: str,
    *,
    client: httpx.Client | None = None,
) -> list[str]:
    """List the bare filenames mirrored under the thread's UPLOADS keyspace.

    Returns the names beneath ``{thread_id}/uploads/`` (the ``uploads/``
    prefix stripped, so callers get bare ``report.pdf`` etc.) so the
    frontend AttachmentBar uniquifier can reserve mirrored names even when
    the gateway's local disk is empty (Render restart / different instance).
    Without this, the list endpoint only sees the ephemeral local dir and a
    user could re-attach ``image.png``, overwriting the mirrored
    ``uploads/image.png`` (x-upsert) that earlier chat turns reference.

    Best-effort: returns ``[]`` when Supabase is not configured or on any
    transport error (the caller still has the local listing). Codex P2
    PR #132.
    """
    config = _load_config()
    if config is None:
        return []

    safe_thread = thread_id.strip().strip("/")
    if not safe_thread:
        return []

    list_url = f"{config.url}/storage/v1/object/list/{config.bucket}"
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": "application/json",
    }
    # The Storage list API treats ``prefix`` as a folder path and returns
    # entries relative to it, so ``name`` comes back as the bare filename.
    body = {
        "prefix": f"{safe_thread}/{UPLOADS_PREFIX}",
        "limit": 1000,
        "offset": 0,
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.post(list_url, json=body, headers=headers)
        if not response.is_success:
            logger.warning(
                "Supabase uploads list failed thread_id=%s status=%s; returning empty",
                thread_id,
                response.status_code,
            )
            return []
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Supabase uploads list error thread_id=%s error=%s; returning empty", thread_id, exc)
        return []
    finally:
        if owns_client:
            http.close()

    if not isinstance(data, list):
        return []
    names: list[str] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        # Supabase returns a placeholder row (id=None) for empty folders; skip
        # anything without a real object id, and any nested-folder rows.
        if isinstance(name, str) and name and "/" not in name and entry.get("id") is not None:
            names.append(name)
    return names
