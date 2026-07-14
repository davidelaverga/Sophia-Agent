"""Copy Sophia-owned PostgREST rows and builder objects between projects.

The script is dry-run by default. It never prints keys, row contents, object
contents, signed URLs, or database credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx

TABLES = (
    "telegram_user_bindings",
    "sophia_sessions",
    "sophia_session_messages",
    "artifact_registry_records",
    "sophia_build_manifest_heads",
    "sophia_build_registry",
    "sophia_build_operation_events",
    "sophia_build_acceptance_outbox",
    "sophia_build_mutation_transactions",
)
BETTER_AUTH_TABLES = ("user", "account", "session", "verification")
DEFAULT_SOURCE_BUCKET = "sophia_builder"
TARGET_BUCKET = "sophia-builder-artifacts"
PAGE_SIZE = 500
NETWORK_ATTEMPTS = 6
CONTROL_PLANE_TIMEOUT_SECONDS = 60.0
OBJECT_TRANSFER_TIMEOUT_SECONDS = 600.0
SOURCE_PROJECT_REF = "qtyqgvdkbhjfmnfkxyvm"
TARGET_PROJECT_REF = "vlxnwmyvhchwbousrdzc"


class ProjectClient:
    def __init__(self, url: str, key: str) -> None:
        self.url = url.rstrip("/")
        self.client = httpx.Client(
            timeout=httpx.Timeout(CONTROL_PLANE_TIMEOUT_SECONDS, connect=30.0),
            headers={"Authorization": f"Bearer {key}", "apikey": key},
        )

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        for attempt in range(NETWORK_ATTEMPTS):
            try:
                response = self.client.request(method, url, **kwargs)
            except httpx.TransportError:
                if attempt == NETWORK_ATTEMPTS - 1:
                    raise
            else:
                if response.status_code not in {408, 429} and response.status_code < 500:
                    return response
                if attempt == NETWORK_ATTEMPTS - 1:
                    return response
                response.close()
            time.sleep(min(2**attempt, 16))
        raise RuntimeError("Supabase request retry loop exhausted")

    def rows(self, table: str, *, filters: dict[str, str] | None = None) -> Iterator[list[dict[str, Any]]]:
        offset = 0
        while True:
            response = self._request(
                "GET",
                f"{self.url}/rest/v1/{table}",
                params={"select": "*", "offset": offset, "limit": PAGE_SIZE, **(filters or {})},
            )
            if response.status_code == 404:
                payload = response.json()
                if isinstance(payload, dict) and payload.get("code") in {"PGRST204", "PGRST205"}:
                    return
            response.raise_for_status()
            page = response.json()
            if not page:
                return
            yield page
            if len(page) < PAGE_SIZE:
                return
            offset += len(page)

    def upsert_rows(self, table: str, rows: list[dict[str, Any]]) -> None:
        response = self._request(
            "POST",
            f"{self.url}/rest/v1/{table}",
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            json=rows,
        )
        response.raise_for_status()

    def row_count(self, table: str, *, filters: dict[str, str] | None = None) -> int | None:
        response = self._request(
            "GET",
            f"{self.url}/rest/v1/{table}",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "*", **(filters or {})},
        )
        if response.status_code == 403:
            return None
        response.raise_for_status()
        content_range = response.headers.get("content-range", "0-0/0")
        return int(content_range.rsplit("/", 1)[-1])

    def list_objects(self, bucket: str, prefix: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
        offset = 0
        while True:
            response = self._request(
                "POST",
                f"{self.url}/storage/v1/object/list/{bucket}",
                json={"prefix": prefix, "limit": PAGE_SIZE, "offset": offset, "sortBy": {"column": "name", "order": "asc"}},
            )
            response.raise_for_status()
            entries = response.json()
            if not entries:
                return
            for entry in entries:
                name = str(entry.get("name") or "").strip("/")
                if not name:
                    continue
                path = f"{prefix.rstrip('/')}/{name}".lstrip("/")
                if entry.get("id") is None:
                    yield from self.list_objects(bucket, path)
                else:
                    yield path, entry
            if len(entries) < PAGE_SIZE:
                return
            offset += len(entries)

    def download_object(self, bucket: str, path: str) -> bytes:
        response = self._request(
            "GET",
            f"{self.url}/storage/v1/object/{bucket}/{quote(path, safe='/')}",
            timeout=httpx.Timeout(OBJECT_TRANSFER_TIMEOUT_SECONDS, connect=30.0),
        )
        response.raise_for_status()
        return response.content

    def download_object_if_present(self, bucket: str, path: str) -> bytes | None:
        response = self._request(
            "GET",
            f"{self.url}/storage/v1/object/{bucket}/{quote(path, safe='/')}",
            timeout=httpx.Timeout(OBJECT_TRANSFER_TIMEOUT_SECONDS, connect=30.0),
        )
        if response.status_code in {400, 404}:
            return None
        response.raise_for_status()
        return response.content

    def upload_object(
        self,
        bucket: str,
        path: str,
        content: bytes,
        *,
        content_type: str = "application/octet-stream",
        cache_control: str | None = None,
    ) -> None:
        headers = {"x-upsert": "true", "Content-Type": content_type}
        if cache_control:
            headers["cache-control"] = cache_control
        response = self._request(
            "POST",
            f"{self.url}/storage/v1/object/{bucket}/{quote(path, safe='/')}",
            headers=headers,
            content=content,
            timeout=httpx.Timeout(OBJECT_TRANSFER_TIMEOUT_SECONDS, connect=30.0),
        )
        response.raise_for_status()


def _copy_and_verify_object(
    source: ProjectClient,
    target: ProjectClient,
    source_bucket: str,
    path: str,
    entry: dict[str, Any],
) -> tuple[str, bytes, int]:
    content = source.download_object(source_bucket, path)
    content_hash = hashlib.sha256(content).digest()
    metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
    target_content = target.download_object_if_present(TARGET_BUCKET, path)
    if target_content is None or hashlib.sha256(target_content).digest() != content_hash:
        target.upload_object(
            TARGET_BUCKET,
            path,
            content,
            content_type=str(metadata.get("mimetype") or "application/octet-stream"),
            cache_control=str(metadata.get("cacheControl") or "") or None,
        )
        target_content = target.download_object(TARGET_BUCKET, path)
    if hashlib.sha256(target_content).digest() != content_hash:
        raise RuntimeError("Target object hash verification failed")
    return path, content_hash, len(content)


def _normalized_timestamp(value: Any) -> str | None:
    if value in {None, ""}:
        return None
    normalized = str(value).replace("Z", "+00:00")
    return datetime.fromisoformat(normalized).astimezone(UTC).isoformat()


def _assert_restored_metadata(source: dict[str, Any], restored: dict[str, Any]) -> None:
    if str(restored.get("id") or "") != str(source.get("id") or ""):
        raise RuntimeError("Target object identity verification failed")
    for key in ("created_at", "updated_at", "last_accessed_at"):
        if _normalized_timestamp(restored.get(key)) != _normalized_timestamp(source.get(key)):
            raise RuntimeError("Target object timestamp verification failed")
    source_metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
    restored_metadata = restored.get("metadata") if isinstance(restored.get("metadata"), dict) else {}
    if restored_metadata != source_metadata:
        raise RuntimeError("Target object metadata verification failed")


def _sql_literal(value: Any) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _timestamp_sql(value: Any) -> str:
    return "NULL" if value in {None, ""} else f"{_sql_literal(value)}::timestamptz"


def _storage_metadata_sql(objects: list[tuple[str, dict[str, Any]]]) -> str:
    rows: list[str] = []
    for path, entry in objects:
        object_id = str(entry.get("id") or "")
        if not object_id:
            raise RuntimeError("Source object is missing its storage identity")
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        metadata_json = json.dumps(metadata, sort_keys=True, separators=(",", ":"))
        rows.append(
            "("
            + ", ".join(
                (
                    _sql_literal(path),
                    f"{_sql_literal(object_id)}::uuid",
                    _timestamp_sql(entry.get("created_at")),
                    _timestamp_sql(entry.get("updated_at")),
                    _timestamp_sql(entry.get("last_accessed_at")),
                    f"{_sql_literal(metadata_json)}::jsonb",
                )
            )
            + ")"
        )
    values = ",\n    ".join(rows)
    return f"""-- Generated by migrate_supabase_project.py. Contains no credentials or object bytes.
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE sophia_storage_metadata_restore (
    name TEXT PRIMARY KEY,
    id UUID NOT NULL,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL
) ON COMMIT DROP;
INSERT INTO sophia_storage_metadata_restore
    (name, id, created_at, updated_at, last_accessed_at, metadata)
VALUES
    {values};
UPDATE storage.objects AS target
SET id = source.id,
    created_at = source.created_at,
    updated_at = source.updated_at,
    last_accessed_at = source.last_accessed_at,
    metadata = source.metadata
FROM sophia_storage_metadata_restore AS source
WHERE target.bucket_id = '{TARGET_BUCKET}'
  AND target.name = source.name;
DO $$
DECLARE
    expected_count INTEGER;
    matched_count INTEGER;
BEGIN
    SELECT count(*) INTO expected_count FROM sophia_storage_metadata_restore;
    SELECT count(*) INTO matched_count
    FROM sophia_storage_metadata_restore AS source
    JOIN storage.objects AS target
      ON target.bucket_id = '{TARGET_BUCKET}'
     AND target.name = source.name
     AND target.id = source.id
     AND target.created_at IS NOT DISTINCT FROM source.created_at
     AND target.updated_at IS NOT DISTINCT FROM source.updated_at
     AND target.last_accessed_at IS NOT DISTINCT FROM source.last_accessed_at
     AND target.metadata = source.metadata;
    IF matched_count <> expected_count THEN
        RAISE EXCEPTION 'Builder storage metadata parity check failed';
    END IF;
END
$$;
COMMIT;
"""


def _verify_storage_metadata(
    source_objects: list[tuple[str, dict[str, Any]]],
    target_objects: list[tuple[str, dict[str, Any]]],
) -> None:
    source_by_path = dict(source_objects)
    target_by_path = dict(target_objects)
    if set(source_by_path) != set(target_by_path):
        raise RuntimeError("Target object path inventory verification failed")
    for path, source_entry in source_by_path.items():
        _assert_restored_metadata(source_entry, target_by_path[path])


def _required(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def _assert_project(url: str, expected_ref: str, role: str) -> None:
    hostname = (urlparse(url).hostname or "").lower()
    actual_ref = hostname.split(".", 1)[0] if hostname.endswith(".supabase.co") else None
    if actual_ref != expected_ref:
        raise SystemExit(f"{role} URL does not identify the required Supabase project")


def _migrate_storage(
    source: ProjectClient,
    target: ProjectClient,
    args: argparse.Namespace,
) -> tuple[int, int, str, str, int]:
    objects = list(source.list_objects(args.source_bucket))
    inventory_digest = hashlib.sha256()
    for path, entry in objects:
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        inventory_digest.update(path.encode("utf-8"))
        inventory_digest.update(str(entry.get("id") or "").encode("utf-8"))
        inventory_digest.update(str(entry.get("updated_at") or "").encode("utf-8"))
        inventory_digest.update(str(int(metadata.get("size") or 0)).encode("utf-8"))
    if args.metadata_sql_output:
        args.metadata_sql_output.write_text(_storage_metadata_sql(objects), encoding="utf-8")
        print(f"metadata_sql_objects={len(objects)} output_written=true")

    byte_count = sum(int((entry.get("metadata") or {}).get("size") or 0) for _, entry in objects if isinstance(entry.get("metadata"), dict))
    content_digest = hashlib.sha256()
    verified_object_count = 0
    if args.apply:
        workers = max(1, min(16, args.storage_workers))

        def copy_object(item: tuple[str, dict[str, Any]]) -> tuple[str, bytes, int]:
            return _copy_and_verify_object(source, target, args.source_bucket, item[0], item[1])

        byte_count = 0
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for path, content_hash, size in executor.map(copy_object, objects):
                content_digest.update(path.encode("utf-8"))
                content_digest.update(content_hash)
                verified_object_count += 1
                byte_count += size
                if verified_object_count % 50 == 0:
                    print(
                        f"storage_progress={verified_object_count}/{len(objects)} verified_bytes={byte_count}",
                        flush=True,
                    )
    if args.verify_storage_metadata:
        _verify_storage_metadata(objects, list(target.list_objects(TARGET_BUCKET)))
        print(f"storage_metadata_verified={len(objects)}")
    return (
        len(objects),
        byte_count,
        inventory_digest.hexdigest(),
        content_digest.hexdigest(),
        verified_object_count,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write to the target project")
    parser.add_argument("--skip-storage", action="store_true")
    parser.add_argument(
        "--metadata-sql-output",
        type=Path,
        help="Write one-time SQL that restores storage IDs, timestamps, and metadata",
    )
    parser.add_argument(
        "--verify-storage-metadata",
        action="store_true",
        help="Require exact source/target object identity and metadata parity",
    )
    parser.add_argument(
        "--storage-workers",
        type=int,
        default=int(os.getenv("SOPHIA_STORAGE_MIGRATION_WORKERS", "4")),
        help="Bounded parallel storage copy workers (1-16)",
    )
    parser.add_argument(
        "--include-better-auth",
        action="store_true",
        help="Copy Better Auth rows through temporary service-role table grants",
    )
    parser.add_argument(
        "--source-bucket",
        default=os.getenv("SOPHIA_SOURCE_BUILDER_BUCKET", DEFAULT_SOURCE_BUCKET),
    )
    args = parser.parse_args()

    source_url = _required("SOPHIA_SOURCE_SUPABASE_URL")
    target_url = _required("SOPHIA_TARGET_SUPABASE_URL")
    _assert_project(source_url, SOURCE_PROJECT_REF, "Source")
    _assert_project(target_url, TARGET_PROJECT_REF, "Target")
    source = ProjectClient(
        source_url,
        _required("SOPHIA_SOURCE_SUPABASE_SERVICE_ROLE_KEY"),
    )
    target = ProjectClient(
        target_url,
        _required("SOPHIA_TARGET_SUPABASE_SERVICE_ROLE_KEY"),
    )
    if source.url == target.url:
        raise SystemExit("Source and target Supabase projects must differ")

    for table in TABLES:
        copied = 0
        for page in source.rows(table):
            if args.apply:
                target.upsert_rows(table, page)
            copied += len(page)
        target_count = target.row_count(table)
        printable_target_count = target_count if target_count is not None else "restricted"
        print(f"table={table} source_rows={copied} target_rows={printable_target_count} applied={args.apply}")

    if args.include_better_auth:
        now = datetime.now(UTC).isoformat()
        for table in BETTER_AUTH_TABLES:
            filters = {"expiresAt": f"gt.{now}"} if table in {"session", "verification"} else None
            copied = 0
            for page in source.rows(table, filters=filters):
                if args.apply:
                    target.upsert_rows(table, page)
                copied += len(page)
            target_count = target.row_count(table, filters=filters)
            printable_target_count = target_count if target_count is not None else "restricted"
            print(f"better_auth_table={table} source_rows={copied} target_rows={printable_target_count} applied={args.apply}")

    object_count = byte_count = verified_object_count = 0
    inventory_hash = content_hash_inventory = hashlib.sha256().hexdigest()
    if not args.skip_storage:
        object_count, byte_count, inventory_hash, content_hash_inventory, verified_object_count = _migrate_storage(source, target, args)
    print(
        f"source_bucket={args.source_bucket} target_bucket={TARGET_BUCKET} "
        f"objects={object_count} bytes={byte_count} "
        f"inventory_hash={inventory_hash} content_hash_inventory={content_hash_inventory} "
        f"verified_objects={verified_object_count} applied={args.apply}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
