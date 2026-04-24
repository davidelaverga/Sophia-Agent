"""Supabase Storage adapter for Sophia builder artifacts.

Uploads/downloads builder-generated files to the ``sophia_builder`` bucket
using the Supabase Storage REST API via ``httpx``.

Key layout (v2, April 2026): ``{user_id}/{thread_id}/{filename}``. This
keeps files scoped to their owning user so the cross-session Files library
can list them with a single prefix query, and makes ownership part of the
key itself (future-proof for per-user RLS policies).

Backward compatibility: read paths (``download_artifact``, ``delete_object``)
transparently fall back to the legacy ``{thread_id}/{filename}`` layout when
the new-layout object is missing. New uploads always write the new layout.
Run ``scripts/migrate_supabase_artifacts.py`` to copy legacy objects.

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
        or os.getenv("SUPABASE_SERVICE_KEY")
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


def _object_path(user_id: str, thread_id: str, filename: str) -> str:
    """Return the new-layout key: ``{user_id}/{thread_id}/{filename}``."""
    safe_user = (user_id or "").strip().strip("/")
    safe_thread = (thread_id or "").strip().strip("/")
    safe_name = (filename or "").strip().lstrip("/")
    if not safe_user or not safe_thread or not safe_name:
        raise ValueError("user_id, thread_id and filename are required")
    return f"{safe_user}/{safe_thread}/{safe_name}"


def _legacy_object_path(thread_id: str, filename: str) -> str:
    """Return the legacy layout key: ``{thread_id}/{filename}``."""
    safe_thread = (thread_id or "").strip().strip("/")
    safe_name = (filename or "").strip().lstrip("/")
    if not safe_thread or not safe_name:
        raise ValueError("thread_id and filename are required")
    return f"{safe_thread}/{safe_name}"


def _auth_headers(config: SupabaseConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
    }


def upload_artifact(
    user_id: str,
    thread_id: str,
    filename: str,
    content: bytes,
    *,
    content_type: str | None = None,
    client: httpx.Client | None = None,
) -> str | None:
    """Upload ``content`` to ``sophia_builder/{user_id}/{thread_id}/{filename}``.

    Returns the object path on success, ``None`` when Supabase is not
    configured, and raises :class:`httpx.HTTPError` on transport errors.
    """
    config = _load_config()
    if config is None:
        logger.debug(
            "Supabase not configured; skipping upload for %s/%s/%s",
            user_id,
            thread_id,
            filename,
        )
        return None

    object_path = _object_path(user_id, thread_id, filename)
    url = _object_url(config, object_path)
    mime_type = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    headers = {
        **_auth_headers(config),
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
        "Uploaded builder artifact to Supabase: bucket=%s user_id=%s thread_id=%s filename=%s bytes=%d",
        config.bucket,
        user_id,
        thread_id,
        filename,
        len(content),
    )
    return object_path


def _download_at_path(
    config: SupabaseConfig,
    object_path: str,
    filename: str,
    http: httpx.Client,
) -> tuple[bytes, str] | None:
    url = _object_url(config, object_path)
    response = http.get(url, headers=_auth_headers(config))
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return (
        response.content,
        response.headers.get("content-type")
        or mimetypes.guess_type(filename)[0]
        or "application/octet-stream",
    )


def download_artifact(
    user_id: str | None,
    thread_id: str,
    filename: str,
    *,
    client: httpx.Client | None = None,
) -> tuple[bytes, str] | None:
    """Download artifact bytes and content type from Supabase.

    Tries the new-layout key ``{user_id}/{thread_id}/{filename}`` first,
    then falls back to the legacy ``{thread_id}/{filename}`` key so objects
    uploaded before the layout migration remain reachable. Pass
    ``user_id=None`` to force legacy-only lookup.

    Returns ``None`` when Supabase is not configured or neither key exists.
    Raises :class:`httpx.HTTPError` on other transport errors.
    """
    config = _load_config()
    if config is None:
        return None

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        if user_id:
            try:
                new_path = _object_path(user_id, thread_id, filename)
            except ValueError:
                new_path = None
            if new_path:
                result = _download_at_path(config, new_path, filename, http)
                if result is not None:
                    return result

        legacy_path = _legacy_object_path(thread_id, filename)
        return _download_at_path(config, legacy_path, filename, http)
    finally:
        if owns_client:
            http.close()


def _list_at_prefix(
    config: SupabaseConfig,
    prefix: str,
    limit: int,
    http: httpx.Client,
) -> list[dict]:
    url = f"{config.url}/storage/v1/object/list/{config.bucket}"
    payload = {
        "prefix": prefix,
        "limit": max(1, min(limit, 1000)),
        "sortBy": {"column": "updated_at", "order": "desc"},
    }
    response = http.post(
        url,
        json=payload,
        headers={**_auth_headers(config), "Content-Type": "application/json"},
    )
    if response.status_code == 404:
        return []
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, list) else []


def list_thread_objects(
    user_id: str | None,
    thread_id: str,
    *,
    limit: int = 100,
    client: httpx.Client | None = None,
) -> list[dict] | None:
    """List objects under a single thread folder.

    Tries the new layout ``{user_id}/{thread_id}/`` first, merging in any
    legacy ``{thread_id}/`` results so the transition is invisible to callers.
    Returns ``None`` when Supabase is not configured.
    """
    config = _load_config()
    if config is None:
        return None

    safe_thread = (thread_id or "").strip().strip("/")
    if not safe_thread:
        raise ValueError("thread_id is required")

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        merged: list[dict] = []
        seen_names: set[str] = set()
        if user_id:
            safe_user = user_id.strip().strip("/")
            if safe_user:
                new_prefix = f"{safe_user}/{safe_thread}/"
                for item in _list_at_prefix(config, new_prefix, limit, http):
                    name = item.get("name")
                    if isinstance(name, str):
                        seen_names.add(name)
                        merged.append(item)

        legacy_prefix = f"{safe_thread}/"
        for item in _list_at_prefix(config, legacy_prefix, limit, http):
            name = item.get("name")
            if isinstance(name, str) and name not in seen_names:
                merged.append(item)

        return merged
    finally:
        if owns_client:
            http.close()


def list_user_objects(
    user_id: str,
    *,
    limit: int = 1000,
    client: httpx.Client | None = None,
) -> list[dict] | None:
    """List every object under ``{user_id}/`` across all their threads.

    Returns a list of objects where ``name`` is the path **relative to the
    user folder** (i.e. ``{thread_id}/{filename}``). The Supabase list
    endpoint only returns one level per call, so this walks thread folders
    explicitly.

    Returns ``None`` when Supabase is not configured.
    """
    config = _load_config()
    if config is None:
        return None

    safe_user = (user_id or "").strip().strip("/")
    if not safe_user:
        raise ValueError("user_id is required")

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        root_items = _list_at_prefix(config, f"{safe_user}/", limit, http)
        all_items: list[dict] = []
        for item in root_items:
            name = item.get("name")
            if not isinstance(name, str):
                continue
            is_folder = item.get("id") is None
            if is_folder:
                thread_id = name
                thread_files = _list_at_prefix(
                    config,
                    f"{safe_user}/{thread_id}/",
                    limit,
                    http,
                )
                for file_item in thread_files:
                    file_name = file_item.get("name")
                    if not isinstance(file_name, str):
                        continue
                    if file_item.get("id") is None:
                        continue
                    all_items.append({**file_item, "name": f"{thread_id}/{file_name}"})
            else:
                all_items.append(item)

        def _ts(item: dict) -> str:
            value = item.get("updated_at") or item.get("created_at") or ""
            return value if isinstance(value, str) else ""

        all_items.sort(key=_ts, reverse=True)
        return all_items[: max(1, min(limit, 1000))]
    finally:
        if owns_client:
            http.close()


def delete_object(
    user_id: str | None,
    thread_id: str,
    filename: str,
    *,
    client: httpx.Client | None = None,
) -> bool:
    """Delete an object at ``{user_id}/{thread_id}/{filename}``.

    Attempts the new-layout key first, then the legacy ``{thread_id}/{filename}``
    key, returning ``True`` if either delete succeeded. Pass ``user_id=None``
    to force legacy-only delete.

    Returns ``False`` when Supabase is not configured or both objects were
    already gone. Raises :class:`httpx.HTTPError` on unexpected transport
    errors.
    """
    config = _load_config()
    if config is None:
        return False

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        deleted_any = False
        paths: list[str] = []
        if user_id:
            try:
                paths.append(_object_path(user_id, thread_id, filename))
            except ValueError:
                pass
        paths.append(_legacy_object_path(thread_id, filename))

        for object_path in paths:
            url = _object_url(config, object_path)
            response = http.delete(url, headers=_auth_headers(config))
            if response.status_code in (400, 404):
                continue
            response.raise_for_status()
            logger.info(
                "Deleted builder artifact from Supabase: bucket=%s object_path=%s",
                config.bucket,
                object_path,
            )
            deleted_any = True
        return deleted_any
    finally:
        if owns_client:
            http.close()


def list_objects(
    thread_id: str,
    *,
    user_id: str | None = None,
    limit: int = 100,
    client: httpx.Client | None = None,
) -> list[dict] | None:
    """Backwards-compatible wrapper around :func:`list_thread_objects`."""
    return list_thread_objects(user_id, thread_id, limit=limit, client=client)
