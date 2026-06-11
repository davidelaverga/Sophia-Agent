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
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


DEFAULT_BUCKET = "sophia_builder"
_REQUEST_TIMEOUT_SECONDS = 15.0
_MAX_LIST_DEPTH = 8

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

# Delegation-ledger keyspace (Spec D D-1). The per-session conversation
# ledger mirrors under ``{thread_id}/ledger/session.jsonl`` — its own
# prefix for the same collision reason as ``UPLOADS_PREFIX``. Shared by
# the langgraph-side mirror writer (``delegation_ledger.mirror_ledger``)
# AND the gateway-side session-delete cleanup so both address the exact
# same object.
LEDGER_PREFIX = "ledger/"


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    service_role_key: str
    bucket: str


@dataclass(frozen=True)
class SupabaseArtifactInfo:
    filename: str
    size_bytes: int
    modified_at: str
    content_type: str | None = None


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
    return f"{config.url}/storage/v1/object/{config.bucket}/{_encoded_object_path(object_path)}"


def _encoded_object_path(object_path: str) -> str:
    return "/".join(quote(segment, safe="") for segment in object_path.split("/"))


def _list_url(config: SupabaseConfig) -> str:
    return f"{config.url}/storage/v1/object/list/{config.bucket}"


def _object_path(thread_id: str, filename: str) -> str:
    safe_thread = thread_id.strip().strip("/")
    safe_name = filename.strip().lstrip("/")
    if not safe_thread or not safe_name:
        raise ValueError("thread_id and filename are required")
    return f"{safe_thread}/{safe_name}"


def _thread_prefix(thread_id: str) -> str:
    safe_thread = thread_id.strip().strip("/")
    if not safe_thread:
        raise ValueError("thread_id is required")
    return f"{safe_thread}/"


def _metadata_value(record: dict[str, Any], *keys: str) -> Any:
    metadata = record.get("metadata")
    for key in keys:
        if key in record:
            return record[key]
        if isinstance(metadata, dict) and key in metadata:
            return metadata[key]
    return None


def _coerce_size(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number >= 0 else 0


def _coerce_modified_at(value: Any) -> str:
    if isinstance(value, str) and value:
        return value
    return datetime.now(UTC).isoformat()


def _is_folder_record(record: dict[str, Any]) -> bool:
    if record.get("id") is not None:
        return False
    metadata = record.get("metadata")
    if isinstance(metadata, dict) and metadata:
        return False
    return _metadata_value(record, "size", "contentLength", "content_length") is None


def _relative_list_name(root_prefix: str, current_prefix: str, raw_name: str) -> str:
    if raw_name.startswith(root_prefix):
        return raw_name[len(root_prefix) :]
    if raw_name.startswith(current_prefix):
        return raw_name[len(root_prefix) :]
    current_relative = current_prefix[len(root_prefix) :] if current_prefix.startswith(root_prefix) else ""
    return f"{current_relative}{raw_name}"


def _folder_prefix_from_list_record(root_prefix: str, current_prefix: str, record: dict[str, Any]) -> str | None:
    raw_name = record.get("name")
    if not isinstance(raw_name, str) or not raw_name.strip():
        return None
    relative = _relative_list_name(root_prefix, current_prefix, raw_name).strip().strip("/")
    if not relative:
        return None
    if _is_internal_relative_name(relative):
        return None
    return f"{root_prefix}{relative}/"


def _is_uploads_relative_name(filename: str) -> bool:
    normalized = filename.strip().lstrip("/")
    return normalized == UPLOADS_PREFIX.rstrip("/") or normalized.startswith(UPLOADS_PREFIX)


def is_ledger_object_name(filename: str) -> bool:
    """True when ``filename`` addresses the delegation-ledger keyspace.

    The ledger (Spec D D-1) is INTERNAL conversation content — never a
    user-facing artifact. Codex P1 PR #131 (2026-06-11): without this
    filter, ``{thread_id}/ledger/session.jsonl`` surfaced in artifact
    listings as ``mnt/user-data/outputs/ledger/session.jsonl`` and was
    downloadable via the artifact GET proxy. Shared by the list filters
    below AND the gateway's Supabase serve fallback so every read surface
    excludes the same keyspace.
    """
    normalized = filename.strip().lstrip("/")
    return normalized == LEDGER_PREFIX.rstrip("/") or normalized.startswith(LEDGER_PREFIX)


def _is_internal_relative_name(filename: str) -> bool:
    """Keyspaces that must never appear in artifact listings: uploads
    (surfaced through the attachments UI instead) and the delegation
    ledger (internal conversation record, AD-6)."""
    return _is_uploads_relative_name(filename) or is_ledger_object_name(filename)


def _record_name(record: Any) -> str | None:
    raw_name = record.get("name") if isinstance(record, dict) else None
    return raw_name if isinstance(raw_name, str) and raw_name else None


def _record_content_type(record: dict[str, Any]) -> str | None:
    content_type = _metadata_value(record, "mimetype", "mimeType", "contentType", "content_type")
    return content_type if isinstance(content_type, str) and content_type else None


def _record_modified_at(record: dict[str, Any]) -> str:
    return _coerce_modified_at(
        record.get("updated_at") or record.get("created_at") or record.get("last_accessed_at")
    )


def _info_from_list_record(
    root_prefix: str,
    record: Any,
    *,
    current_prefix: str | None = None,
) -> SupabaseArtifactInfo | None:
    if not isinstance(record, dict):
        return None
    raw_name = _record_name(record)
    if raw_name is None:
        return None
    current = current_prefix or root_prefix
    if _is_folder_record(record):
        return None
    filename = _relative_list_name(root_prefix, current, raw_name)
    filename = filename.strip().lstrip("/")
    if not filename or filename.endswith("/"):
        return None
    if _is_internal_relative_name(filename):
        return None
    size = _coerce_size(_metadata_value(record, "size", "contentLength", "content_length"))
    return SupabaseArtifactInfo(
        filename=filename,
        size_bytes=size,
        modified_at=_record_modified_at(record),
        content_type=_record_content_type(record),
    )


def uploads_object_name(filename: str) -> str:
    """Map a bare upload filename to its prefixed Supabase object name.

    ``report.pdf`` -> ``uploads/report.pdf``. The ``{thread_id}/`` folder is
    prepended by ``_object_path`` at call time, yielding the full key
    ``{thread_id}/uploads/report.pdf`` — distinct from the builder-output
    keyspace ``{thread_id}/report.pdf``.
    """
    return f"{UPLOADS_PREFIX}{filename.strip().lstrip('/')}"


def ledger_object_name() -> str:
    """Object name of the per-session delegation ledger (Spec D D-1).

    The ``{thread_id}/`` folder is prepended by ``_object_path`` at call
    time, yielding ``{thread_id}/ledger/session.jsonl``. One ledger per
    session and session_id == thread_id, so the name is constant.
    """
    return f"{LEDGER_PREFIX}session.jsonl"


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


def _list_page(
    http: httpx.Client,
    *,
    url: str,
    headers: dict[str, str],
    prefix: str,
    page_size: int,
    offset: int,
) -> list[Any] | None:
    response = http.post(
        url,
        headers=headers,
        json={
            "prefix": prefix,
            "limit": page_size,
            "offset": offset,
            "sortBy": {"column": "updated_at", "order": "desc"},
        },
    )
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, list) else None


def _extend_artifact_list(
    artifacts: list[SupabaseArtifactInfo],
    item: Any,
    *,
    root_prefix: str,
    current_prefix: str,
) -> str | None:
    if isinstance(item, dict) and _is_folder_record(item):
        return _folder_prefix_from_list_record(root_prefix, current_prefix, item)
    if info := _info_from_list_record(root_prefix, item, current_prefix=current_prefix):
        artifacts.append(info)
    return None


def _list_prefix_artifacts(
    http: httpx.Client,
    *,
    url: str,
    headers: dict[str, str],
    root_prefix: str,
    current_prefix: str,
    page_size: int,
    thread_id: str,
    depth: int,
    visited: set[str],
) -> list[SupabaseArtifactInfo]:
    if current_prefix in visited or depth > _MAX_LIST_DEPTH:
        return []
    visited.add(current_prefix)
    offset = 0
    artifacts: list[SupabaseArtifactInfo] = []
    while True:
        data = _list_page(
            http,
            url=url,
            headers=headers,
            prefix=current_prefix,
            page_size=page_size,
            offset=offset,
        )
        if data is None:
            logger.warning(
                "Supabase artifact list returned non-list payload for thread_id=%s prefix=%s",
                thread_id,
                current_prefix,
            )
            return artifacts
        for item in data:
            child_prefix = _extend_artifact_list(
                artifacts,
                item,
                root_prefix=root_prefix,
                current_prefix=current_prefix,
            )
            if child_prefix:
                artifacts.extend(
                    _list_prefix_artifacts(
                        http,
                        url=url,
                        headers=headers,
                        root_prefix=root_prefix,
                        current_prefix=child_prefix,
                        page_size=page_size,
                        thread_id=thread_id,
                        depth=depth + 1,
                        visited=visited,
                    )
                )
        if len(data) < page_size:
            return artifacts
        offset += page_size


def list_artifacts(
    thread_id: str,
    *,
    client: httpx.Client | None = None,
    limit: int = 1000,
) -> list[SupabaseArtifactInfo]:
    """List artifacts stored under ``sophia_builder/{thread_id}/``.

    Returns an empty list when Supabase is not configured or the prefix has no
    objects. Raises :class:`httpx.HTTPError` for transport or unexpected HTTP
    failures so gateway callers can log the failure without hiding local files.
    """
    config = _load_config()
    if config is None:
        return []

    prefix = _thread_prefix(thread_id)
    url = _list_url(config)
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": "application/json",
    }
    page_size = max(1, min(int(limit), 1000))

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)

    try:
        return _list_prefix_artifacts(
            http,
            url=url,
            headers=headers,
            root_prefix=prefix,
            current_prefix=prefix,
            page_size=page_size,
            thread_id=thread_id,
            depth=0,
            visited=set(),
        )
    finally:
        if owns_client:
            http.close()


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
    sign_url = f"{config.url}/storage/v1/object/sign/{config.bucket}/{_encoded_object_path(object_path)}"
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
