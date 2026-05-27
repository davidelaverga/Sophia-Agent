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
    return f"{root_prefix}{relative}/"


def _info_from_list_record(
    root_prefix: str,
    record: Any,
    *,
    current_prefix: str | None = None,
) -> SupabaseArtifactInfo | None:
    if not isinstance(record, dict):
        return None
    raw_name = record.get("name")
    if not isinstance(raw_name, str) or not raw_name:
        return None
    current = current_prefix or root_prefix
    if _is_folder_record(record):
        return None
    filename = _relative_list_name(root_prefix, current, raw_name)
    filename = filename.strip().lstrip("/")
    if not filename or filename.endswith("/"):
        return None
    size = _coerce_size(_metadata_value(record, "size", "contentLength", "content_length"))
    content_type = _metadata_value(record, "mimetype", "mimeType", "contentType", "content_type")
    return SupabaseArtifactInfo(
        filename=filename,
        size_bytes=size,
        modified_at=_coerce_modified_at(
            record.get("updated_at") or record.get("created_at") or record.get("last_accessed_at")
        ),
        content_type=content_type if isinstance(content_type, str) and content_type else None,
    )


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
    def list_prefix(current_prefix: str, *, depth: int, visited: set[str]) -> list[SupabaseArtifactInfo]:
        if current_prefix in visited or depth > _MAX_LIST_DEPTH:
            return []
        visited.add(current_prefix)
        offset = 0
        artifacts: list[SupabaseArtifactInfo] = []
        while True:
            response = http.post(
                url,
                headers=headers,
                json={
                    "prefix": current_prefix,
                    "limit": page_size,
                    "offset": offset,
                    "sortBy": {"column": "updated_at", "order": "desc"},
                },
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, list):
                logger.warning(
                    "Supabase artifact list returned non-list payload for thread_id=%s prefix=%s",
                    thread_id,
                    current_prefix,
                )
                return artifacts
            for item in data:
                if isinstance(item, dict) and _is_folder_record(item):
                    if child_prefix := _folder_prefix_from_list_record(prefix, current_prefix, item):
                        artifacts.extend(list_prefix(child_prefix, depth=depth + 1, visited=visited))
                    continue
                if info := _info_from_list_record(prefix, item, current_prefix=current_prefix):
                    artifacts.append(info)
            if len(data) < page_size:
                return artifacts
            offset += page_size

    try:
        return list_prefix(prefix, depth=0, visited=set())
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
