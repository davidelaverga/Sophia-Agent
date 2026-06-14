"""Migrate local Artifact Library registry JSON into Supabase.

Default mode is a dry run. Pass --execute to write metadata rows and upload
available bytes into the durable artifact object namespace.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from app.gateway.artifact_registry import (
    ArtifactRecord,
    SupabaseArtifactRegistry,
)
from app.gateway.path_utils import resolve_thread_virtual_path
from deerflow.sophia.storage import supabase_artifact_store

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_USERS_ROOT = _BACKEND_ROOT / "users"
_OUTPUTS_PREFIX = "mnt/user-data/outputs"
_WORKSPACE_OUTPUTS_PREFIX = "mnt/user-data/workspace/outputs"


@dataclass
class MigrationSummary:
    users_seen: int = 0
    records_seen: int = 0
    records_valid: int = 0
    records_written: int = 0
    records_skipped_invalid: int = 0
    bytes_uploaded: int = 0
    bytes_reused_from_supabase: int = 0
    bytes_missing: int = 0


def _safe_segment(value: str | None, fallback: str) -> str:
    text = (value or fallback).strip().replace("\\", "/")
    text = PurePosixPath(text).name if "/" in text else text
    if text in {"", ".", ".."}:
        text = fallback
    return quote(text, safe="-_.")


def durable_object_path(record: ArtifactRecord) -> str:
    scope = record.session_id or record.thread_id
    return supabase_artifact_store.normalize_object_path(
        "/".join(
            (
                "artifacts",
                _safe_segment(record.user_id, "user"),
                _safe_segment(scope, "session"),
                _safe_segment(record.artifact_id, "artifact"),
                _safe_segment(record.filename, "artifact"),
            )
        )
    )


def _registry_files(base_path: Path) -> list[Path]:
    return sorted(base_path.glob("*/artifacts/registry.json"))


def _records_from_file(path: Path) -> list[ArtifactRecord]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_records = payload.get("artifacts", []) if isinstance(payload, dict) else payload
    if not isinstance(raw_records, list):
        return []
    records: list[ArtifactRecord] = []
    for item in raw_records:
        records.append(ArtifactRecord.model_validate(item))
    return records


def _candidate_thread_ids(record: ArtifactRecord) -> tuple[str, ...]:
    values = (record.thread_id, record.task_id, record.run_id, record.parent_thread_id)
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        normalized = value.strip()
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return tuple(ordered)


def _relative_output_path(local_path: str) -> str | None:
    if local_path.startswith(f"{_OUTPUTS_PREFIX}/"):
        return local_path[len(_OUTPUTS_PREFIX) + 1 :]
    if local_path.startswith(f"{_WORKSPACE_OUTPUTS_PREFIX}/"):
        return local_path[len(_WORKSPACE_OUTPUTS_PREFIX) + 1 :]
    return None


def _find_local_bytes(record: ArtifactRecord) -> tuple[bytes, str | None] | None:
    for thread_id in _candidate_thread_ids(record):
        try:
            path = resolve_thread_virtual_path(thread_id, record.local_path)
        except Exception:
            continue
        if path.is_file():
            return path.read_bytes(), mimetypes.guess_type(record.filename)[0]
    return None


def _download_legacy_supabase_bytes(record: ArtifactRecord) -> tuple[bytes, str | None] | None:
    relative = _relative_output_path(record.local_path)
    if not relative:
        return None
    for thread_id in _candidate_thread_ids(record):
        result = supabase_artifact_store.download_artifact(thread_id=thread_id, filename=relative)
        if result is not None:
            return result
    return None


def _record_with_durable_storage(record: ArtifactRecord, content: bytes, object_path: str) -> ArtifactRecord:
    return record.model_copy(
        update={
            "storage_provider": "supabase",
            "storage_bucket": os.getenv("SUPABASE_BUILDER_BUCKET", supabase_artifact_store.DEFAULT_BUCKET),
            "storage_object_path": object_path,
            "size_bytes": len(content),
            "content_hash": hashlib.sha256(content).hexdigest(),
            "storage_status": "available",
        }
    )


def migrate(
    *,
    base_path: Path = _DEFAULT_USERS_ROOT,
    execute: bool = False,
    upload_bytes: bool = True,
    registry: SupabaseArtifactRegistry | None = None,
) -> MigrationSummary:
    summary = MigrationSummary()
    target_registry = registry if execute else None
    if execute and target_registry is None:
        target_registry = SupabaseArtifactRegistry()

    for registry_path in _registry_files(base_path):
        user_id = registry_path.parent.parent.name
        summary.users_seen += 1
        try:
            records = _records_from_file(registry_path)
        except Exception:
            summary.records_skipped_invalid += 1
            continue

        for record in records:
            summary.records_seen += 1
            if record.user_id != user_id:
                record = record.model_copy(update={"user_id": user_id})
            summary.records_valid += 1
            migrated = record
            if upload_bytes:
                object_path = durable_object_path(record)
                materialized = _find_local_bytes(record)
                if materialized is None and execute:
                    materialized = _download_legacy_supabase_bytes(record)
                    if materialized is not None:
                        summary.bytes_reused_from_supabase += 1
                if materialized is not None:
                    content, content_type = materialized
                    if execute:
                        stored_path = supabase_artifact_store.upload_artifact_object(
                            object_path,
                            content,
                            content_type=content_type or record.mime_type,
                        )
                        if stored_path:
                            migrated = _record_with_durable_storage(record, content, stored_path)
                            summary.bytes_uploaded += 1
                    else:
                        summary.bytes_uploaded += 1
                else:
                    summary.bytes_missing += 1

            if execute and target_registry is not None:
                target_registry.upsert_record(migrated, user_id=user_id)
                summary.records_written += 1

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-path", type=Path, default=_DEFAULT_USERS_ROOT)
    parser.add_argument("--execute", action="store_true", help="Write rows and upload available bytes.")
    parser.add_argument("--skip-upload", action="store_true", help="Only migrate metadata rows.")
    args = parser.parse_args()

    summary = migrate(
        base_path=args.base_path,
        execute=args.execute,
        upload_bytes=not args.skip_upload,
    )
    print(json.dumps({"dry_run": not args.execute, **asdict(summary)}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
