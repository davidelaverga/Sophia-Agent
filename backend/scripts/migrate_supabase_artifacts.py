"""Migrate legacy Supabase builder artifacts to the user-scoped layout.

Old layout: ``sophia_builder/{thread_id}/{filename}``
New layout: ``sophia_builder/{user_id}/{thread_id}/{filename}``

The script is idempotent and safe to re-run:
- Objects already in the new layout are skipped.
- Objects with no resolvable owner (no local session record) are left in place
  and reported at the end; they remain reachable via the legacy fallback.
- Original objects are only deleted after the copy succeeds.

Usage (from repo root):

    python -m backend.scripts.migrate_supabase_artifacts           # dry run
    python -m backend.scripts.migrate_supabase_artifacts --commit  # perform

Environment: requires the usual SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and
access to the local ``users/{user_id}/sessions/`` records to resolve
``thread_id -> user_id``.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Iterable

import httpx

# Make the backend packages importable when running as a script.
try:
    from deerflow.sophia.session_store import SessionStore
    from deerflow.sophia.storage import supabase_artifact_store
except ModuleNotFoundError:  # pragma: no cover - path fix for ad-hoc invocation
    import os
    import pathlib

    repo_root = pathlib.Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo_root / "backend" / "packages" / "harness"))
    os.chdir(repo_root)
    from deerflow.sophia.session_store import SessionStore
    from deerflow.sophia.storage import supabase_artifact_store


logger = logging.getLogger("migrate_supabase_artifacts")


def _iter_root_entries(config, client: httpx.Client) -> Iterable[dict]:
    url = f"{config.url}/storage/v1/object/list/{config.bucket}"
    offset = 0
    page_size = 1000
    while True:
        response = client.post(
            url,
            headers={
                "Authorization": f"Bearer {config.service_role_key}",
                "apikey": config.service_role_key,
                "Content-Type": "application/json",
            },
            json={
                "prefix": "",
                "limit": page_size,
                "offset": offset,
                "sortBy": {"column": "name", "order": "asc"},
            },
        )
        response.raise_for_status()
        batch = response.json()
        if not isinstance(batch, list) or not batch:
            return
        yield from batch
        if len(batch) < page_size:
            return
        offset += page_size


def _iter_thread_files(
    config,
    thread_id: str,
    client: httpx.Client,
) -> Iterable[dict]:
    url = f"{config.url}/storage/v1/object/list/{config.bucket}"
    offset = 0
    page_size = 1000
    while True:
        response = client.post(
            url,
            headers={
                "Authorization": f"Bearer {config.service_role_key}",
                "apikey": config.service_role_key,
                "Content-Type": "application/json",
            },
            json={
                "prefix": f"{thread_id}/",
                "limit": page_size,
                "offset": offset,
            },
        )
        response.raise_for_status()
        batch = response.json()
        if not isinstance(batch, list) or not batch:
            return
        yield from batch
        if len(batch) < page_size:
            return
        offset += page_size


def _copy_object(
    config,
    src_path: str,
    dest_path: str,
    client: httpx.Client,
) -> None:
    """Server-side copy via the Storage REST API."""
    url = f"{config.url}/storage/v1/object/copy"
    response = client.post(
        url,
        headers={
            "Authorization": f"Bearer {config.service_role_key}",
            "apikey": config.service_role_key,
            "Content-Type": "application/json",
        },
        json={
            "bucketId": config.bucket,
            "sourceKey": src_path,
            "destinationKey": dest_path,
        },
    )
    if response.status_code == 409:
        # Destination already exists — treat as success so reruns are idempotent.
        logger.info("Destination already exists, skipping copy: %s", dest_path)
        return
    response.raise_for_status()


def _delete_object(config, object_path: str, client: httpx.Client) -> None:
    url = f"{config.url}/storage/v1/object/{config.bucket}/{object_path}"
    response = client.delete(
        url,
        headers={
            "Authorization": f"Bearer {config.service_role_key}",
            "apikey": config.service_role_key,
        },
    )
    if response.status_code in (200, 204, 404):
        return
    response.raise_for_status()


def migrate(commit: bool) -> int:
    config = supabase_artifact_store._load_config()  # noqa: SLF001 — internal config reuse
    if config is None:
        logger.error("Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
        return 2

    store = SessionStore()

    migrated = 0
    skipped_already_new = 0
    skipped_no_owner = 0
    orphan_threads: list[str] = []

    with httpx.Client(timeout=30.0) as client:
        root_entries = list(_iter_root_entries(config, client))
        thread_ids: list[str] = []
        for entry in root_entries:
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                continue
            # The list endpoint returns both folders and files at the root.
            # Folders have id=None; files have id set. We only care about
            # legacy thread folders whose name doesn't look like a user_id
            # that already adopted the new layout. Heuristic: if a record
            # with this thread_id exists locally, treat it as a thread.
            thread_ids.append(name)

        logger.info("Root entries to evaluate: %d", len(thread_ids))

        for thread_id in thread_ids:
            record = store.find_by_thread_id(thread_id)
            if record is None:
                # Could be a user_id folder from a previous migration run,
                # or an orphan. Skip either way.
                skipped_no_owner += 1
                continue

            owner = record.user_id
            if not owner:
                orphan_threads.append(thread_id)
                continue

            for file_entry in _iter_thread_files(config, thread_id, client):
                name = file_entry.get("name")
                if not isinstance(name, str) or not name:
                    continue
                if file_entry.get("id") is None:
                    # A nested folder under the thread — skip; we only move files.
                    continue

                src = f"{thread_id}/{name}"
                dest = f"{owner}/{thread_id}/{name}"

                if src == dest:
                    skipped_already_new += 1
                    continue

                if not commit:
                    logger.info("[dry-run] would copy %s -> %s and delete %s", src, dest, src)
                    migrated += 1
                    continue

                try:
                    _copy_object(config, src, dest, client)
                    _delete_object(config, src, client)
                    migrated += 1
                    logger.info("Migrated %s -> %s", src, dest)
                except httpx.HTTPError as exc:
                    logger.error("Failed to migrate %s -> %s: %s", src, dest, exc)

    logger.info(
        "Done. migrated=%d skipped_already_new=%d skipped_no_owner=%d orphan_threads=%d",
        migrated,
        skipped_already_new,
        skipped_no_owner,
        len(orphan_threads),
    )
    if orphan_threads:
        logger.warning("Orphan thread folders (no user_id): %s", ", ".join(orphan_threads[:20]))
    return 0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually perform the copy/delete. Without this flag runs in dry-run mode.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING). Default: INFO",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    return migrate(commit=args.commit)


if __name__ == "__main__":
    sys.exit(main())
