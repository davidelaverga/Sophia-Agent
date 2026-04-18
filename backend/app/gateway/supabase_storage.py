"""Supabase Storage client for thread artifacts.

Persists builder-generated files to a Supabase bucket so they survive
server restarts in cloud deployments (Render's ephemeral filesystem
wipes local files on redeploy).

Layout inside the bucket:
    {thread_id}/
        mnt/user-data/outputs/
            SFV_Restaurant_Guide.md
            ...

Env vars required:
    SUPABASE_URL                 — e.g. https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY    — service role key (server-side only!)
    SUPABASE_ARTIFACTS_BUCKET    — bucket name (default: "thread-artifacts")

If env vars are not set, the client is disabled and all operations
become no-ops.  This keeps local dev working without Supabase.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_BUCKET = "thread-artifacts"


class _SupabaseStorageDisabled:
    """No-op fallback when Supabase env vars are missing."""

    enabled = False

    def upload_file(self, thread_id: str, virtual_path: str, local_path: Path) -> bool:
        return False

    def download_file(self, thread_id: str, virtual_path: str, local_path: Path) -> bool:
        return False

    def list_artifacts(self, thread_id: str) -> list[dict]:
        return []

    def exists(self, thread_id: str, virtual_path: str) -> bool:
        return False


class SupabaseArtifactsStorage:
    """Wrapper around the Supabase Storage API for thread artifacts."""

    enabled = True

    def __init__(self, url: str, service_key: str, bucket: str):
        from supabase import create_client

        self._bucket_name = bucket
        self._client = create_client(url, service_key)
        # Ensure bucket exists (idempotent).  Public=False so files require
        # the gateway proxy to serve them.
        try:
            self._client.storage.create_bucket(bucket, options={"public": False})
        except Exception:
            # Already exists — ignore
            pass

    def _object_key(self, thread_id: str, virtual_path: str) -> str:
        """Build the object key inside the bucket."""
        return f"{thread_id}/{virtual_path.lstrip('/')}"

    def upload_file(self, thread_id: str, virtual_path: str, local_path: Path) -> bool:
        if not local_path.exists() or not local_path.is_file():
            return False
        try:
            data = local_path.read_bytes()
            key = self._object_key(thread_id, virtual_path)
            self._client.storage.from_(self._bucket_name).upload(
                path=key,
                file=data,
                file_options={"upsert": "true"},
            )
            logger.info("supabase.storage uploaded key=%s bytes=%d", key, len(data))
            return True
        except Exception as exc:
            logger.warning("supabase.storage upload failed key=%s err=%s", virtual_path, exc)
            return False

    def download_file(self, thread_id: str, virtual_path: str, local_path: Path) -> bool:
        try:
            key = self._object_key(thread_id, virtual_path)
            data = self._client.storage.from_(self._bucket_name).download(key)
            if not data:
                return False
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(data)
            logger.info("supabase.storage downloaded key=%s bytes=%d", key, len(data))
            return True
        except Exception as exc:
            logger.info("supabase.storage download miss key=%s err=%s", virtual_path, exc)
            return False

    def exists(self, thread_id: str, virtual_path: str) -> bool:
        try:
            key = self._object_key(thread_id, virtual_path)
            # Supabase doesn't expose a cheap HEAD — use download and discard.
            # For large files this is wasteful; callers should prefer
            # download_file() which caches to disk anyway.
            data = self._client.storage.from_(self._bucket_name).download(key)
            return bool(data)
        except Exception:
            return False

    def list_artifacts(self, thread_id: str) -> list[dict]:
        """List all files under {thread_id}/ in the bucket."""
        try:
            prefix = f"{thread_id}/"
            results: list[dict] = []

            def _walk(path: str):
                items = self._client.storage.from_(self._bucket_name).list(
                    path=path,
                    options={"limit": 1000},
                )
                for item in items:
                    name = item.get("name", "")
                    # Folders show up with id=None in Supabase responses
                    if item.get("id") is None:
                        _walk(f"{path}{name}/")
                    else:
                        metadata = item.get("metadata") or {}
                        results.append({
                            "path": f"{path}{name}"[len(prefix):],
                            "name": name,
                            "size_bytes": metadata.get("size", 0),
                            "modified_at": item.get("updated_at") or item.get("created_at"),
                            "mime_type": metadata.get("mimetype"),
                        })

            _walk(prefix)
            return results
        except Exception as exc:
            logger.warning("supabase.storage list failed thread_id=%s err=%s", thread_id, exc)
            return []


@lru_cache(maxsize=1)
def get_supabase_storage() -> SupabaseArtifactsStorage | _SupabaseStorageDisabled:
    """Return a cached Supabase storage client, or a no-op fallback."""
    url = os.getenv("SUPABASE_URL", "").strip()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    bucket = os.getenv("SUPABASE_ARTIFACTS_BUCKET", _DEFAULT_BUCKET).strip() or _DEFAULT_BUCKET

    if not url or not service_key:
        logger.info("supabase.storage disabled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)")
        return _SupabaseStorageDisabled()

    try:
        storage = SupabaseArtifactsStorage(url, service_key, bucket)
        logger.info("supabase.storage initialized bucket=%s", bucket)
        return storage
    except Exception as exc:
        logger.error("supabase.storage init failed err=%s", exc)
        return _SupabaseStorageDisabled()
