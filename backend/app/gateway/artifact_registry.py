"""Durable metadata registry for Sophia artifacts.

The registry intentionally stores metadata only. Artifact bytes continue to
live behind the existing thread artifact routes and Supabase/local output
storage. Local JSON is the MVP backend for development and tests; the API
surface is shaped so a Postgres/Supabase implementation can replace it later.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.session_store import SessionTranscriptStore
from deerflow.sophia.storage import supabase_artifact_store

ArtifactSource = Literal[
    "builder",
    "upload",
    "quick_edit",
    "coreview_version",
    "file_library_backfill",
]
ArtifactStorageProvider = Literal["local", "supabase", "hybrid"]

_DEFAULT_BASE_PATH = Path("users")
_FORBIDDEN_EXTRA_KEYS = {
    "artifact_url",
    "artifactUrl",
    "content",
    "html",
    "markdown",
    "raw_artifact_content",
    "rawArtifactContent",
    "raw_content",
    "rawContent",
    "raw_html",
    "rawHtml",
    "raw_markdown",
    "rawMarkdown",
    "signed_url",
    "signedUrl",
}
_OUTPUTS_PREFIX = "mnt/user-data/outputs"
_WORKSPACE_OUTPUTS_PREFIX = "mnt/user-data/workspace/outputs"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _hash_id(prefix: str, *parts: object) -> str:
    basis = "\x1f".join("" if part is None else str(part) for part in parts)
    digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def _normalize_token(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized or None


def _normalize_iso(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return text


def _decode_artifact_virtual_path(path: str) -> str:
    decoded = path
    for _ in range(3):
        next_decoded = unquote(decoded)
        if next_decoded == decoded:
            break
        decoded = next_decoded
    return decoded


def _canonicalize_output_virtual_path(path: str) -> str:
    if path == "outputs":
        return _OUTPUTS_PREFIX
    if path.startswith("outputs/"):
        return f"{_OUTPUTS_PREFIX}/{path[len('outputs/'):]}"
    if path == "user-data/outputs":
        return _OUTPUTS_PREFIX
    if path.startswith("user-data/outputs/"):
        return f"mnt/{path}"
    return path


def normalize_artifact_registry_path(path: str) -> str:
    decoded = _decode_artifact_virtual_path(path).strip()
    if decoded.startswith("file://"):
        decoded = decoded[len("file://") :]
    if decoded.startswith(("//", "\\\\")) or (len(decoded) >= 2 and decoded[1] == ":"):
        raise HTTPException(status_code=403, detail="Unsafe artifact path")

    parts: list[str] = []
    for part in PurePosixPath(decoded.replace("\\", "/")).parts:
        if part in {"", "/", "."}:
            continue
        if part == "..":
            raise HTTPException(status_code=403, detail="Path traversal detected")
        parts.append(part)

    normalized = _canonicalize_output_virtual_path("/".join(parts))
    if not normalized:
        raise HTTPException(status_code=400, detail="Artifact path is required")
    if not (
        normalized == _OUTPUTS_PREFIX
        or normalized.startswith(f"{_OUTPUTS_PREFIX}/")
        or normalized == _WORKSPACE_OUTPUTS_PREFIX
        or normalized.startswith(f"{_WORKSPACE_OUTPUTS_PREFIX}/")
    ):
        raise HTTPException(status_code=400, detail="Artifact path must be a virtual output path")
    return normalized


def _filename_from_path(path: str) -> str:
    filename = PurePosixPath(path).name
    return filename or "artifact"


def _relative_output_path(path: str) -> str | None:
    if path == _OUTPUTS_PREFIX:
        return ""
    if path.startswith(f"{_OUTPUTS_PREFIX}/"):
        return path[len(_OUTPUTS_PREFIX) + 1 :]
    return None


def _infer_mime_type(filename: str, mime_type: str | None) -> str | None:
    return mime_type or mimetypes.guess_type(filename)[0]


def _normalize_artifact_type(value: str | None, path: str, mime_type: str | None) -> str:
    lower_value = (value or "").strip().lower()
    lower_mime = (mime_type or "").split(";")[0].strip().lower()
    lower_path = path.lower().split("?", 1)[0]
    if lower_path.endswith((".html", ".htm")):
        return "html"
    if lower_path.endswith(".pdf"):
        return "pdf"
    if lower_path.endswith((".md", ".markdown")):
        return "markdown"
    if lower_path.endswith((".pptx", ".ppt")):
        return "pptx"
    if lower_path.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")):
        return "image"
    if lower_mime in {"text/html", "application/xhtml+xml"}:
        return "html"
    if lower_mime in {"application/pdf", "application/x-pdf"}:
        return "pdf"
    if lower_mime in {"text/markdown", "text/x-markdown"}:
        return "markdown"
    if lower_mime.startswith("image/"):
        return "image"
    if lower_value in {"html", "pdf", "markdown", "pptx", "image", "visual"}:
        return "image" if lower_value == "visual" else lower_value
    if lower_value in {"webpage", "website"}:
        return "html"
    if lower_value in {"slide", "slides", "presentation", "deck"}:
        return "pptx"
    return lower_value or "other"


def _normalize_renderer_kind(value: str | None, artifact_type: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized:
        return normalized
    if artifact_type == "pptx":
        return "download_only"
    if artifact_type in {"html", "pdf", "markdown", "image"}:
        return artifact_type
    return "metadata"


def _safe_summary(value: str | None) -> str | None:
    normalized = _normalize_token(value)
    if normalized is None:
        return None
    return normalized[:240]


def _parse_timestamp(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class ArtifactRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_id: str
    user_id: str
    thread_id: str
    session_id: str | None = None
    parent_thread_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    trace_id: str | None = None
    logical_artifact_id: str
    version_id: str
    parent_version_id: str | None = None
    title: str
    filename: str
    artifact_type: str
    renderer_kind: str
    mime_type: str | None = None
    safe_summary: str | None = None
    source: ArtifactSource
    local_path: str
    storage_provider: ArtifactStorageProvider = "local"
    storage_bucket: str | None = None
    storage_object_path: str | None = None
    size_bytes: int | None = Field(default=None, ge=0)
    content_hash: str | None = None
    storage_status: str = "available"
    created_at: str
    updated_at: str
    last_opened_at: str | None = None
    opened_count: int = Field(default=0, ge=0)
    raw_content_excluded: bool = True
    signed_url_excluded: bool = True

    @field_validator("local_path")
    @classmethod
    def _validate_local_path(cls, value: str) -> str:
        return normalize_artifact_registry_path(value)

    @field_validator("raw_content_excluded", "signed_url_excluded")
    @classmethod
    def _must_be_excluded(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("artifact registry rows must exclude raw content and signed URLs")
        return True


class ArtifactUpsertRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    artifact_id: str | None = None
    user_id: str | None = None
    thread_id: str
    session_id: str | None = None
    parent_thread_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    trace_id: str | None = None
    logical_artifact_id: str | None = None
    version_id: str | None = None
    parent_version_id: str | None = None
    title: str | None = None
    filename: str | None = None
    artifact_type: str | None = None
    renderer_kind: str | None = None
    mime_type: str | None = None
    safe_summary: str | None = None
    source: ArtifactSource = "builder"
    local_path: str
    storage_provider: ArtifactStorageProvider | None = None
    storage_bucket: str | None = None
    storage_object_path: str | None = None
    size_bytes: int | None = Field(default=None, ge=0)
    content_hash: str | None = None
    storage_status: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    raw_content_excluded: bool = True
    signed_url_excluded: bool = True

    @model_validator(mode="before")
    @classmethod
    def _reject_raw_or_signed_fields(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        forbidden = sorted(str(key) for key in data if str(key) in _FORBIDDEN_EXTRA_KEYS)
        if forbidden:
            raise ValueError(f"Artifact registry cannot persist raw content or signed URLs: {', '.join(forbidden)}")
        return data

    @field_validator("local_path")
    @classmethod
    def _validate_local_path(cls, value: str) -> str:
        return normalize_artifact_registry_path(value)

    @field_validator("raw_content_excluded", "signed_url_excluded")
    @classmethod
    def _must_be_excluded(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("artifact registry rows must exclude raw content and signed URLs")
        return True

    def to_record(self, *, user_id: str, existing: ArtifactRecord | None = None) -> ArtifactRecord:
        now = _now_iso()
        local_path = normalize_artifact_registry_path(self.local_path)
        filename = _normalize_token(self.filename) or _filename_from_path(local_path)
        mime_type = _infer_mime_type(filename, _normalize_token(self.mime_type))
        artifact_type = _normalize_artifact_type(self.artifact_type, local_path, mime_type)
        renderer_kind = _normalize_renderer_kind(self.renderer_kind, artifact_type)
        logical_artifact_id = (
            _normalize_token(self.logical_artifact_id)
            or (existing.logical_artifact_id if existing else None)
            or _hash_id("logical", user_id, self.thread_id, local_path, renderer_kind)
        )
        version_id = (
            _normalize_token(self.version_id)
            or (existing.version_id if existing else None)
            or f"{logical_artifact_id}::v1"
        )
        artifact_id = (
            _normalize_token(self.artifact_id)
            or (existing.artifact_id if existing else None)
            or _hash_id("artifact", user_id, self.thread_id, local_path, renderer_kind, self.source, version_id)
        )
        created_at = (
            existing.created_at
            if existing is not None
            else (_normalize_iso(self.created_at) or now)
        )
        updated_at = _normalize_iso(self.updated_at) or now
        title = _normalize_token(self.title) or (existing.title if existing else None) or filename
        storage_object_path = _normalize_token(self.storage_object_path)
        if storage_object_path is None:
            relative = _relative_output_path(local_path)
            storage_object_path = f"{self.thread_id}/{relative}" if relative else None
        storage_provider = self.storage_provider
        if storage_provider is None:
            storage_provider = "hybrid" if storage_object_path and self.storage_bucket else "local"

        return ArtifactRecord(
            artifact_id=artifact_id,
            user_id=user_id,
            thread_id=self.thread_id,
            session_id=_normalize_token(self.session_id) or (existing.session_id if existing else None),
            parent_thread_id=_normalize_token(self.parent_thread_id)
            or (existing.parent_thread_id if existing else None),
            task_id=_normalize_token(self.task_id) or (existing.task_id if existing else None),
            run_id=_normalize_token(self.run_id) or (existing.run_id if existing else None),
            trace_id=_normalize_token(self.trace_id) or (existing.trace_id if existing else None),
            logical_artifact_id=logical_artifact_id,
            version_id=version_id,
            parent_version_id=_normalize_token(self.parent_version_id)
            or (existing.parent_version_id if existing else None),
            title=title,
            filename=filename,
            artifact_type=artifact_type,
            renderer_kind=renderer_kind,
            mime_type=mime_type,
            safe_summary=_safe_summary(self.safe_summary) or (existing.safe_summary if existing else None),
            source=self.source,
            local_path=local_path,
            storage_provider=storage_provider,
            storage_bucket=_normalize_token(self.storage_bucket) or (existing.storage_bucket if existing else None),
            storage_object_path=storage_object_path or (existing.storage_object_path if existing else None),
            size_bytes=self.size_bytes if self.size_bytes is not None else (existing.size_bytes if existing else None),
            content_hash=_normalize_token(self.content_hash) or (existing.content_hash if existing else None),
            storage_status=_normalize_token(self.storage_status)
            or (existing.storage_status if existing else None)
            or "available",
            created_at=created_at,
            updated_at=updated_at,
            last_opened_at=existing.last_opened_at if existing else None,
            opened_count=existing.opened_count if existing else 0,
            raw_content_excluded=True,
            signed_url_excluded=True,
        )


class ArtifactListResponse(BaseModel):
    artifacts: list[ArtifactRecord]
    total: int


class ArtifactOpenTarget(BaseModel):
    artifact_id: str
    thread_id: str
    session_id: str | None = None
    artifact_path: str
    renderer_kind: str
    mime_type: str | None = None
    title: str
    review_room_supported: bool = True


class ArtifactOpenResponse(BaseModel):
    artifact: ArtifactRecord
    canvas_target: ArtifactOpenTarget


class ArtifactRegistryFilters(BaseModel):
    artifact_type: str | None = None
    source: ArtifactSource | None = None
    thread_id: str | None = None
    session_id: str | None = None
    search: str | None = None
    created_after: str | None = None
    created_before: str | None = None
    recent_after: str | None = None
    sort: Literal["updated", "created", "recent", "title"] = "updated"
    limit: int = Field(default=100, ge=1, le=250)


class LocalArtifactRegistry:
    """JSON-backed artifact metadata store scoped by user id."""

    def __init__(self, base_path: Path | str | None = None) -> None:
        configured = os.getenv("SOPHIA_ARTIFACT_REGISTRY_BASE_PATH")
        self._base = Path(base_path or configured or _DEFAULT_BASE_PATH)

    def _user_dir(self, user_id: str) -> Path:
        return self._base / user_id / "artifacts"

    def _registry_path(self, user_id: str) -> Path:
        return self._user_dir(user_id) / "registry.json"

    def _read_records(self, user_id: str) -> list[ArtifactRecord]:
        path = self._registry_path(user_id)
        if not path.is_file():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        raw_records = payload.get("artifacts", []) if isinstance(payload, dict) else payload
        if not isinstance(raw_records, list):
            return []
        records: list[ArtifactRecord] = []
        for item in raw_records:
            try:
                records.append(ArtifactRecord.model_validate(item))
            except Exception:  # noqa: BLE001 - ignore corrupt local rows.
                continue
        return records

    def _write_records(self, user_id: str, records: list[ArtifactRecord]) -> None:
        path = self._registry_path(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "updated_at": _now_iso(),
            "artifacts": [record.model_dump(mode="json") for record in records],
        }
        path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def upsert(self, request: ArtifactUpsertRequest, *, user_id: str) -> ArtifactRecord:
        if request.user_id is not None and request.user_id != user_id:
            raise HTTPException(status_code=403, detail="Artifact user scope mismatch")

        records = self._read_records(user_id)
        existing_index = self._find_existing_index(records, request, user_id=user_id)
        existing = records[existing_index] if existing_index is not None else None
        record = request.to_record(user_id=user_id, existing=existing)
        if existing_index is None:
            records.append(record)
        else:
            records[existing_index] = record
        records.sort(key=lambda item: (_parse_timestamp(item.updated_at), item.title.lower()), reverse=True)
        self._write_records(user_id, records)
        return record

    def get(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        for record in self._read_records(user_id):
            if record.artifact_id == artifact_id:
                return record
        return None

    def list(self, *, user_id: str, filters: ArtifactRegistryFilters | None = None) -> ArtifactListResponse:
        filters = filters if filters is not None else ArtifactRegistryFilters()
        records = [record for record in self._read_records(user_id)]
        records = self._apply_filters(records, filters)
        records = self._sort(records, filters.sort)
        limited = records[: filters.limit]
        return ArtifactListResponse(artifacts=limited, total=len(records))

    def mark_opened(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        records = self._read_records(user_id)
        opened_at = _now_iso()
        updated: ArtifactRecord | None = None
        for index, record in enumerate(records):
            if record.artifact_id != artifact_id:
                continue
            updated = record.model_copy(
                update={
                    "last_opened_at": opened_at,
                    "opened_count": record.opened_count + 1,
                    "updated_at": opened_at,
                }
            )
            records[index] = updated
            break
        if updated is not None:
            self._write_records(user_id, records)
        return updated

    def _find_existing_index(
        self,
        records: list[ArtifactRecord],
        request: ArtifactUpsertRequest,
        *,
        user_id: str,
    ) -> int | None:
        local_path = normalize_artifact_registry_path(request.local_path)
        filename = _normalize_token(request.filename) or _filename_from_path(local_path)
        mime_type = _infer_mime_type(filename, _normalize_token(request.mime_type))
        artifact_type = _normalize_artifact_type(request.artifact_type, local_path, mime_type)
        renderer_kind = _normalize_renderer_kind(request.renderer_kind, artifact_type)
        logical_artifact_id = _normalize_token(request.logical_artifact_id) or _hash_id(
            "logical",
            user_id,
            request.thread_id,
            local_path,
            renderer_kind,
        )
        version_id = _normalize_token(request.version_id) or f"{logical_artifact_id}::v1"

        for index, record in enumerate(records):
            if request.artifact_id and record.artifact_id == request.artifact_id:
                return index
            if (
                record.user_id == user_id
                and record.thread_id == request.thread_id
                and record.local_path == local_path
                and record.renderer_kind == renderer_kind
                and record.source == request.source
                and record.version_id == version_id
            ):
                return index
        return None

    def _apply_filters(
        self,
        records: list[ArtifactRecord],
        filters: ArtifactRegistryFilters,
    ) -> list[ArtifactRecord]:
        result = records
        if filters.artifact_type:
            artifact_type = filters.artifact_type.strip().lower()
            result = [record for record in result if record.artifact_type == artifact_type]
        if filters.source:
            result = [record for record in result if record.source == filters.source]
        if filters.thread_id:
            result = [record for record in result if record.thread_id == filters.thread_id]
        if filters.session_id:
            result = [record for record in result if record.session_id == filters.session_id]
        if filters.search and filters.search.strip():
            query = filters.search.strip().lower()
            result = [
                record
                for record in result
                if query in record.title.lower()
                or query in record.filename.lower()
                or query in (record.safe_summary or "").lower()
            ]
        if filters.created_after:
            lower = _parse_timestamp(filters.created_after)
            result = [record for record in result if _parse_timestamp(record.created_at) >= lower]
        if filters.created_before:
            upper = _parse_timestamp(filters.created_before)
            result = [record for record in result if _parse_timestamp(record.created_at) <= upper]
        if filters.recent_after:
            lower = _parse_timestamp(filters.recent_after)
            result = [record for record in result if _parse_timestamp(record.last_opened_at) >= lower]
        return result

    @staticmethod
    def _sort(records: list[ArtifactRecord], sort: str) -> list[ArtifactRecord]:
        if sort == "title":
            return sorted(records, key=lambda record: record.title.lower())
        if sort == "created":
            return sorted(records, key=lambda record: _parse_timestamp(record.created_at), reverse=True)
        if sort == "recent":
            return sorted(
                records,
                key=lambda record: (
                    _parse_timestamp(record.last_opened_at),
                    _parse_timestamp(record.updated_at),
                ),
                reverse=True,
            )
        return sorted(records, key=lambda record: _parse_timestamp(record.updated_at), reverse=True)


def open_response_for_record(record: ArtifactRecord) -> ArtifactOpenResponse:
    return ArtifactOpenResponse(
        artifact=record,
        canvas_target=ArtifactOpenTarget(
            artifact_id=record.artifact_id,
            thread_id=record.thread_id,
            session_id=record.session_id,
            artifact_path=record.local_path,
            renderer_kind=record.renderer_kind,
            mime_type=record.mime_type,
            title=record.title,
            review_room_supported=record.renderer_kind in {"html", "pdf", "markdown", "image"},
        ),
    )


def builder_completion_upsert_request(
    payload: dict[str, Any],
    *,
    session_store: SessionTranscriptStore | None = None,
) -> tuple[str, ArtifactUpsertRequest] | None:
    status = str(payload.get("status") or "").lower()
    artifact_path = _normalize_token(payload.get("artifact_path"))
    thread_id = _normalize_token(payload.get("thread_id"))
    if status not in {"success", "completed"} or not artifact_path or not thread_id:
        return None

    session_record = None
    if session_store is not None:
        finder = getattr(session_store, "find_any_session_by_thread_id", None)
        if callable(finder):
            session_record = finder(thread_id)

    user_id = _normalize_token(payload.get("user_id")) or getattr(session_record, "user_id", None)
    if not user_id:
        return None

    local_path = normalize_artifact_registry_path(artifact_path)
    relative = _relative_output_path(local_path)
    bucket = os.getenv("SUPABASE_BUILDER_BUCKET", supabase_artifact_store.DEFAULT_BUCKET)
    storage_bucket = bucket if relative and supabase_artifact_store.is_configured() else None
    storage_object_path = f"{thread_id}/{relative}" if relative else None
    storage_provider: ArtifactStorageProvider = "hybrid" if storage_bucket and storage_object_path else "local"

    return user_id, ArtifactUpsertRequest(
        user_id=user_id,
        thread_id=thread_id,
        session_id=getattr(session_record, "session_id", None),
        parent_thread_id=thread_id,
        task_id=_normalize_token(payload.get("task_id")),
        run_id=_normalize_token(payload.get("run_id")),
        trace_id=_normalize_token(payload.get("trace_id")),
        title=_normalize_token(payload.get("artifact_title")) or _normalize_token(payload.get("artifact_filename")),
        filename=_normalize_token(payload.get("artifact_filename")),
        artifact_type=_normalize_token(payload.get("artifact_type")),
        mime_type=None,
        safe_summary=_normalize_token(payload.get("summary")) or _normalize_token(payload.get("user_next_action")),
        source="builder",
        local_path=local_path,
        storage_provider=storage_provider,
        storage_bucket=storage_bucket,
        storage_object_path=storage_object_path,
        storage_status="available",
        created_at=_normalize_iso(payload.get("completed_at")),
        raw_content_excluded=True,
        signed_url_excluded=True,
    )
