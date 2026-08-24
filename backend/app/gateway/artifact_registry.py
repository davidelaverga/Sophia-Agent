"""Durable metadata registry for Sophia artifacts.

The registry intentionally stores metadata only. Artifact bytes continue to
live behind the existing thread artifact routes and Supabase/local output
storage. Local JSON is the MVP backend for development and tests; the API
surface is shaped so a Postgres/Supabase implementation can replace it later.
"""

from __future__ import annotations

import builtins
import hashlib
import json
import logging
import mimetypes
import os
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import unquote

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.agents.sophia_agent.utils import safe_user_path
from deerflow.sophia.session_store import SessionTranscriptStore
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.synthetic_builder import synthetic_retention_expired

logger = logging.getLogger(__name__)

ArtifactSource = Literal[
    "builder",
    "upload",
    "quick_edit",
    "coreview_version",
    "file_library_backfill",
    "backfill",
]
ArtifactStorageProvider = Literal["local", "supabase", "hybrid"]
ArtifactRole = Literal["primary", "wrapper", "support", "internal"]

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_BASE_PATH = _BACKEND_ROOT / "users"
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
_SUPPORT_ARTIFACT_DIRS = {
    "visuals",
    "assets",
    "slides",
    "sources",
    "source_artifact",
    "deck_build",
    ".builder",
}
_SUPPORT_ARTIFACT_SUFFIXES = (
    ".source.md",
    ".source.html",
    ".plan.json",
    ".manifest.json",
    ".preview.pdf",
    ".metadata.json",
    ".meta.json",
    ".diagnostics.json",
)
_HTML_WRAPPER_TEXT_MARKERS = (
    "handoff wrapper",
    "artifact wrapper",
    "builder wrapper",
    "render wrapper",
    "preview wrapper",
    "internal wrapper",
    "support wrapper",
)
_ACTION_HTML_PREFIXES = (
    "build-",
    "create-",
    "draft-",
    "generate-",
    "make-",
    "render-",
    "write-",
)
_NON_HTML_TARGET_HINTS = ("markdown", ".md", " pdf", ".pdf", "pptx", ".pptx")
_BACKFILL_SOURCES = {"file_library_backfill", "backfill"}
_SOURCE_PRIORITY: dict[str, int] = {
    "builder": 10,
    "quick_edit": 20,
    "coreview_version": 30,
    "upload": 40,
    "file_library_backfill": 50,
    "backfill": 50,
}
_SYNTHETIC_DEPLOYMENT_KEYS = {
    "repository_sha",
    "frontend_deployment_id",
    "backend_deployment_id",
    "voice_deployment_id",
    "frontend_sha",
    "backend_sha",
    "voice_sha",
    "builder_sha",
    "builder_deployment_id",
    "builder_service_id",
    "builder_service_name",
}
_MAX_SYNTHETIC_ARTIFACT_RETENTION = timedelta(days=7)


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


def _canonical_utc_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _parse_canonical_utc_millis(value: object) -> datetime | None:
    text = _normalize_token(value)
    if text is None:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(UTC)
    return normalized if _canonical_utc_millis(normalized) == text else None


def _normalize_deployment_identity(value: object) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("deployment identity must be an object")
    normalized: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key)
        if key not in _SYNTHETIC_DEPLOYMENT_KEYS:
            raise ValueError("deployment identity contains an unsupported field")
        token = _normalize_token(raw_value)
        if token is None or len(token) > 512 or "\x00" in token:
            raise ValueError("deployment identity contains an invalid value")
        normalized[key] = token
    return normalized


def _assert_bounded_synthetic_retention(*, created_at: str, expires_at: str) -> None:
    created = _parse_timestamp(created_at)
    expires = _parse_timestamp(expires_at)
    if created <= 0 or expires <= created:
        raise ValueError("synthetic artifact retention expiry must follow creation")
    if expires - created > _MAX_SYNTHETIC_ARTIFACT_RETENTION.total_seconds():
        raise ValueError("synthetic artifact retention exceeds the seven-day safety bound")


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


def normalize_artifact_storage_object_path(path: str | None) -> str | None:
    normalized = _normalize_token(path)
    if normalized is None:
        return None
    decoded = _decode_artifact_virtual_path(normalized)
    try:
        return supabase_artifact_store.normalize_object_path(decoded)
    except ValueError as exc:
        raise ValueError("Unsafe artifact storage path") from exc


def _storage_object_addresses_internal_keyspace(relative_object_path: str) -> bool:
    """True when a thread-relative object path addresses an internal,
    non-deliverable keyspace that must never be served as a user artifact."""
    segments = [segment for segment in relative_object_path.split("/") if segment]
    if supabase_artifact_store.is_internal_artifact_path(relative_object_path):
        return True
    name = segments[-1].lower() if segments else ""
    return (
        name.endswith((".source.md", ".source.html", ".plan.json", ".manifest.json", ".preview.pdf"))
        or (name.startswith("_") and name.endswith(".py"))
        or (name.startswith("test_") and name.endswith((".py", ".sh")))
    )


def _allowed_storage_thread_ids(*values: str | None) -> set[str]:
    return {value.strip() for value in values if isinstance(value, str) and value.strip()}


def _artifact_storage_object_scope(object_path: str) -> tuple[str | None, str | None, str]:
    parts = object_path.split("/")
    if parts[0] == "artifacts":
        if len(parts) < 5:
            raise HTTPException(status_code=403, detail="Artifact storage path must belong to the artifact thread")
        return parts[1].strip() or None, parts[2].strip() or None, "/".join(parts[4:])
    return None, parts[0].strip() or None, "/".join(parts[1:])


def validate_artifact_storage_object_path(
    storage_object_path: str | None,
    *,
    thread_id: str,
    session_id: str | None = None,
    user_id: str | None = None,
) -> str | None:
    try:
        object_path = normalize_artifact_storage_object_path(storage_object_path)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Unsafe artifact storage path") from exc
    if object_path is None:
        return None
    object_user_id, object_thread_id, relative = _artifact_storage_object_scope(object_path)
    if object_thread_id not in _allowed_storage_thread_ids(thread_id, session_id):
        raise HTTPException(status_code=403, detail="Artifact storage path must belong to the artifact thread")
    if user_id and object_user_id is not None:
        expected_user_id = supabase_artifact_store.safe_object_path_segment(user_id, default="user")
        if object_user_id != expected_user_id:
            raise HTTPException(status_code=403, detail="Artifact storage path must belong to the artifact thread")
    # Codex P1 PR #131: prefix==thread_id is not sufficient — the object path
    # may still address an internal keyspace under the owner's OWN thread
    # (e.g. ``{thread_id}/ledger/session.jsonl``), which leaks internal
    # conversation state / raw uploads through the SERVICE-ROLE download path.
    if _storage_object_addresses_internal_keyspace(relative):
        raise HTTPException(status_code=403, detail="Artifact references an internal keyspace")
    return object_path


def _filename_from_path(path: str) -> str:
    filename = PurePosixPath(path).name
    return filename or "artifact"


def _relative_output_path(path: str) -> str | None:
    if path == _OUTPUTS_PREFIX:
        return ""
    if path.startswith(f"{_OUTPUTS_PREFIX}/"):
        return path[len(_OUTPUTS_PREFIX) + 1 :]
    return None


def _relative_any_output_path(path: str) -> str | None:
    if path == _OUTPUTS_PREFIX or path == _WORKSPACE_OUTPUTS_PREFIX:
        return ""
    if path.startswith(f"{_OUTPUTS_PREFIX}/"):
        return path[len(_OUTPUTS_PREFIX) + 1 :]
    if path.startswith(f"{_WORKSPACE_OUTPUTS_PREFIX}/"):
        return path[len(_WORKSPACE_OUTPUTS_PREFIX) + 1 :]
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


def _source_priority(source: str | None) -> int:
    return _SOURCE_PRIORITY.get(source or "", 100)


def _normalize_extension(value: str | None) -> str | None:
    normalized = (value or "").strip().lower().lstrip(".")
    if not normalized:
        return None
    if normalized == "markdown":
        return "md"
    if normalized == "htm":
        return "html"
    return normalized


def _is_builder_internal_name(name: str) -> bool:
    lowered = name.lower()
    return (
        name.startswith("_")
        and lowered.endswith((".py", ".sh", ".ps1"))
        or lowered.startswith("test_")
        and lowered.endswith((".py", ".sh", ".ps1"))
    )


def _is_support_artifact_path(local_path: str) -> bool:
    relative = _relative_any_output_path(local_path)
    if relative is None:
        return False
    normalized = relative.strip().lstrip("/").replace("\\", "/")
    if not normalized:
        return False
    parts = [part for part in normalized.split("/") if part]
    if not parts:
        return False
    if parts[0].lower() in _SUPPORT_ARTIFACT_DIRS:
        return True
    name = parts[-1].lower()
    return _is_builder_internal_name(parts[-1]) or name.endswith(_SUPPORT_ARTIFACT_SUFFIXES)


def _looks_like_html_wrapper(
    *,
    local_path: str,
    filename: str,
    title: str | None,
    requested_artifact_ext: str | None = None,
    artifact_is_fallback: bool | None = None,
) -> bool:
    suffix = PurePosixPath(local_path).suffix.lower()
    if suffix not in {".html", ".htm"}:
        return False

    lowered_name = filename.lower()
    lowered_title = (title or "").lower()
    combined = f"{lowered_title} {lowered_name} {local_path.lower()}"
    if any(marker in combined for marker in _HTML_WRAPPER_TEXT_MARKERS):
        return True
    if "handoff" in combined and "wrapper" in combined:
        return True
    if "wrapper" in lowered_name and any(marker in combined for marker in ("render", "preview", "handoff")):
        return True

    requested_ext = _normalize_extension(requested_artifact_ext)
    if requested_ext and requested_ext != "html" and artifact_is_fallback is not True:
        return True

    if lowered_name.startswith(_ACTION_HTML_PREFIXES) and any(hint in combined for hint in _NON_HTML_TARGET_HINTS):
        return True

    return False


def _detect_artifact_role(
    *,
    local_path: str,
    filename: str,
    title: str | None,
    artifact_type: str,
    renderer_kind: str,
    requested_artifact_ext: str | None = None,
    artifact_is_fallback: bool | None = None,
) -> ArtifactRole:
    if _is_support_artifact_path(local_path):
        return "support"
    if _looks_like_html_wrapper(
        local_path=local_path,
        filename=filename,
        title=title,
        requested_artifact_ext=requested_artifact_ext,
        artifact_is_fallback=artifact_is_fallback,
    ):
        return "wrapper"
    if renderer_kind in {"metadata", "unsupported"} and artifact_type in {"metadata", "other"}:
        return "internal"
    return "primary"


def _effective_artifact_role(record: Any) -> ArtifactRole:
    detected_role = _detect_artifact_role(
        local_path=record.local_path,
        filename=record.filename,
        title=record.title,
        artifact_type=record.artifact_type,
        renderer_kind=record.renderer_kind,
    )
    if detected_role != "primary":
        return detected_role
    if record.artifact_role in {"wrapper", "support", "internal"}:
        return record.artifact_role
    return "primary"


def _is_effectively_visible(record: Any) -> bool:
    return (
        getattr(record, "deleted_at", None) is None
        and getattr(record, "is_library_visible", False) is True
        and _effective_artifact_role(record) == "primary"
        and getattr(record, "storage_status", "available") == "available"
    )


def _canonical_thread_identity(thread_id: str | None, parent_thread_id: str | None) -> str:
    return (_normalize_token(parent_thread_id) or _normalize_token(thread_id) or "").lower()


def _canonical_path_identity(local_path: str | None, storage_object_path: str | None) -> str:
    normalized_local_path = _normalize_token(local_path)
    if normalized_local_path:
        return normalized_local_path.replace("\\", "/").strip("/").lower()
    normalized_storage_path = _normalize_token(storage_object_path)
    return normalized_storage_path.replace("\\", "/").strip("/").lower() if normalized_storage_path else ""


def _canonical_artifact_identity(
    *,
    user_id: str,
    thread_id: str | None,
    parent_thread_id: str | None,
    local_path: str | None,
    storage_object_path: str | None,
    renderer_kind: str | None,
    artifact_type: str | None,
) -> tuple[str, str, str, str, str]:
    return (
        user_id,
        _canonical_thread_identity(thread_id, parent_thread_id),
        _canonical_path_identity(local_path, storage_object_path),
        (renderer_kind or "").strip().lower(),
        (artifact_type or "").strip().lower(),
    )


def _record_artifact_identity(record: Any) -> tuple[str, str, str, str, str]:
    return _canonical_artifact_identity(
        user_id=record.user_id,
        thread_id=record.thread_id,
        parent_thread_id=record.parent_thread_id,
        local_path=record.local_path,
        storage_object_path=record.storage_object_path,
        renderer_kind=record.renderer_kind,
        artifact_type=record.artifact_type,
    )


def _extra_token(request: ArtifactUpsertRequest, key: str) -> str | None:
    value = request.model_extra.get(key) if request.model_extra else None
    return _normalize_token(value)


def _extra_bool(request: ArtifactUpsertRequest, key: str) -> bool | None:
    value = request.model_extra.get(key) if request.model_extra else None
    return value if isinstance(value, bool) else None


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
    artifact_role: ArtifactRole = "primary"
    is_library_visible: bool = True
    created_at: str
    updated_at: str
    deleted_at: str | None = None
    last_opened_at: str | None = None
    opened_count: int = Field(default=0, ge=0)
    raw_content_excluded: bool = True
    signed_url_excluded: bool = True
    synthetic_test: bool = False
    test_run_id: str | None = None
    test_principal_id: str | None = None
    scenario_id: str | None = None
    scenario_version: str | None = None
    environment: str | None = None
    retention_hours: int | None = Field(default=None, ge=1, le=168)
    retention_anchor: Literal["builder_task_created_at_provisional"] | None = None
    retention_anchor_at: str | None = None
    retention_expires_at: str | None = None
    cleanup_obligation_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    provider_expires_at: str | None = None
    deployment_identity: dict[str, str] | None = None
    memory_retrieval_excluded: bool = False
    memory_learning_excluded: bool = False
    ordinary_artifact_publication_excluded: bool = False
    ordinary_analytics_excluded: bool = False
    deck_quality_publication_excluded: bool = False
    langsmith_export_excluded: bool = False
    langsmith_trace_status: Literal["trace_unavailable"] | None = None
    langsmith_trace_unavailable_reason: Literal["synthetic_isolation_policy"] | None = None

    @field_validator("local_path")
    @classmethod
    def _validate_local_path(cls, value: str) -> str:
        return normalize_artifact_registry_path(value)

    @field_validator("storage_object_path")
    @classmethod
    def _validate_storage_object_path(cls, value: str | None) -> str | None:
        return normalize_artifact_storage_object_path(value)

    @field_validator("raw_content_excluded", "signed_url_excluded")
    @classmethod
    def _must_be_excluded(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("artifact registry rows must exclude raw content and signed URLs")
        return True

    @field_validator("deployment_identity")
    @classmethod
    def _validate_deployment_identity(
        cls, value: dict[str, str] | None
    ) -> dict[str, str] | None:
        return _normalize_deployment_identity(value)

    @field_validator(
        "retention_anchor_at", "retention_expires_at", "provider_expires_at"
    )
    @classmethod
    def _validate_retention_expiry(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if _parse_canonical_utc_millis(value) is None:
            raise ValueError("synthetic artifact deadline must be canonical UTC millis")
        return value

    @model_validator(mode="after")
    def _normalize_library_visibility(self) -> ArtifactRecord:
        detected_role = _effective_artifact_role(self)
        role = detected_role if detected_role != "primary" else self.artifact_role
        visible = (
            self.is_library_visible
            if (
                role == "primary"
                and self.deleted_at is None
                and self.storage_status == "available"
                and not self.synthetic_test
            )
            else False
        )
        if self.synthetic_test:
            required = {
                "test_run_id": self.test_run_id,
                "test_principal_id": self.test_principal_id,
                "scenario_id": self.scenario_id,
                "scenario_version": self.scenario_version,
                "environment": self.environment,
                "retention_hours": self.retention_hours,
                "retention_anchor": self.retention_anchor,
                "retention_anchor_at": self.retention_anchor_at,
                "retention_expires_at": self.retention_expires_at,
                "cleanup_obligation_id": self.cleanup_obligation_id,
                "provider_expires_at": self.provider_expires_at,
            }
            missing = sorted(
                key
                for key, value in required.items()
                if value is None
                or (isinstance(value, str) and not value.strip())
            )
            if missing:
                raise ValueError(
                    "synthetic artifact is missing isolation metadata: "
                    + ", ".join(missing)
                )
            if self.user_id != self.test_principal_id:
                raise ValueError("synthetic artifact principal does not match user scope")
            _assert_bounded_synthetic_retention(
                created_at=self.created_at,
                expires_at=str(self.retention_expires_at),
            )
            anchor_at = _parse_canonical_utc_millis(self.retention_anchor_at)
            expires_at = _parse_canonical_utc_millis(self.retention_expires_at)
            provider_expires_at = _parse_canonical_utc_millis(
                self.provider_expires_at
            )
            if (
                self.retention_anchor != "builder_task_created_at_provisional"
                or anchor_at is None
                or expires_at is None
                or provider_expires_at is None
                or not isinstance(self.retention_hours, int)
                or isinstance(self.retention_hours, bool)
                or expires_at
                != anchor_at + timedelta(hours=self.retention_hours)
                or provider_expires_at > expires_at
            ):
                raise ValueError("synthetic artifact retention receipt is invalid")
            exclusions = (
                self.memory_retrieval_excluded,
                self.memory_learning_excluded,
                self.ordinary_artifact_publication_excluded,
                self.ordinary_analytics_excluded,
                self.deck_quality_publication_excluded,
                self.langsmith_export_excluded,
            )
            if not all(value is True for value in exclusions):
                raise ValueError("synthetic artifact isolation exclusions must be explicit")
            if (
                self.langsmith_trace_status != "trace_unavailable"
                or self.langsmith_trace_unavailable_reason
                != "synthetic_isolation_policy"
            ):
                raise ValueError(
                    "synthetic artifact LangSmith status must reflect isolation policy"
                )
        object.__setattr__(self, "artifact_role", role)
        object.__setattr__(self, "is_library_visible", bool(visible))
        return self


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
    artifact_role: ArtifactRole | None = None
    is_library_visible: bool | None = None
    created_at: str | None = None
    updated_at: str | None = None
    deleted_at: str | None = None
    raw_content_excluded: bool = True
    signed_url_excluded: bool = True
    synthetic_test: bool | None = None
    test_run_id: str | None = None
    test_principal_id: str | None = None
    scenario_id: str | None = None
    scenario_version: str | None = None
    environment: str | None = None
    retention_hours: int | None = Field(default=None, ge=1, le=168)
    retention_anchor: Literal["builder_task_created_at_provisional"] | None = None
    retention_anchor_at: str | None = None
    retention_expires_at: str | None = None
    cleanup_obligation_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    provider_expires_at: str | None = None
    deployment_identity: dict[str, str] | None = None
    memory_retrieval_excluded: bool | None = None
    memory_learning_excluded: bool | None = None
    ordinary_artifact_publication_excluded: bool | None = None
    ordinary_analytics_excluded: bool | None = None
    deck_quality_publication_excluded: bool | None = None
    langsmith_export_excluded: bool | None = None
    langsmith_trace_status: Literal["trace_unavailable"] | None = None
    langsmith_trace_unavailable_reason: Literal["synthetic_isolation_policy"] | None = None

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

    @field_validator("storage_object_path")
    @classmethod
    def _validate_storage_object_path(cls, value: str | None) -> str | None:
        return normalize_artifact_storage_object_path(value)

    @field_validator("raw_content_excluded", "signed_url_excluded")
    @classmethod
    def _must_be_excluded(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("artifact registry rows must exclude raw content and signed URLs")
        return True

    @field_validator("deployment_identity")
    @classmethod
    def _validate_deployment_identity(
        cls, value: dict[str, str] | None
    ) -> dict[str, str] | None:
        return _normalize_deployment_identity(value)

    @field_validator(
        "retention_anchor_at", "retention_expires_at", "provider_expires_at"
    )
    @classmethod
    def _validate_retention_expiry(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if _parse_canonical_utc_millis(value) is None:
            raise ValueError("synthetic artifact deadline must be canonical UTC millis")
        return value

    def to_record(
        self,
        *,
        user_id: str,
        existing: ArtifactRecord | None = None,
        preserve_existing_identity: bool = False,
        preserve_existing_source: bool = False,
    ) -> ArtifactRecord:
        now = _now_iso()
        local_path = normalize_artifact_registry_path(self.local_path)
        filename = _normalize_token(self.filename) or _filename_from_path(local_path)
        mime_type = _infer_mime_type(filename, _normalize_token(self.mime_type))
        artifact_type = _normalize_artifact_type(self.artifact_type, local_path, mime_type)
        renderer_kind = _normalize_renderer_kind(self.renderer_kind, artifact_type)
        logical_artifact_id = (
            (existing.logical_artifact_id if existing and preserve_existing_identity else None)
            or _normalize_token(self.logical_artifact_id)
            or (existing.logical_artifact_id if existing else None)
            or _hash_id("logical", user_id, self.thread_id, local_path, renderer_kind)
        )
        version_id = (
            (existing.version_id if existing and preserve_existing_identity else None)
            or _normalize_token(self.version_id)
            or (existing.version_id if existing else None)
            or f"{logical_artifact_id}::v1"
        )
        artifact_id = (
            (existing.artifact_id if existing and preserve_existing_identity else None)
            or _normalize_token(self.artifact_id)
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
        detected_role = _detect_artifact_role(
            local_path=local_path,
            filename=filename,
            title=title,
            artifact_type=artifact_type,
            renderer_kind=renderer_kind,
            requested_artifact_ext=_extra_token(self, "requested_artifact_ext"),
            artifact_is_fallback=_extra_bool(self, "artifact_is_fallback"),
        )
        requested_role = self.artifact_role or (existing.artifact_role if existing else "primary")
        artifact_role = detected_role if detected_role != "primary" else requested_role
        requested_visibility = (
            self.is_library_visible
            if self.is_library_visible is not None
            else (existing.is_library_visible if existing else True)
        )
        if (
            existing is not None
            and self.synthetic_test is not None
            and self.synthetic_test is not existing.synthetic_test
        ):
            raise ValueError("artifact synthetic isolation identity cannot be changed")
        if (
            existing is not None
            and self.cleanup_obligation_id is not None
            and self.cleanup_obligation_id != existing.cleanup_obligation_id
        ):
            raise ValueError("artifact cleanup obligation identity cannot be changed")
        if (
            existing is not None
            and self.provider_expires_at is not None
            and self.provider_expires_at != existing.provider_expires_at
        ):
            raise ValueError("artifact provider deadline cannot be changed")
        synthetic_test = (
            existing.synthetic_test
            if self.synthetic_test is None and existing is not None
            else bool(self.synthetic_test)
        )
        deleted_at = _normalize_iso(self.deleted_at) or (existing.deleted_at if existing else None)
        storage_status = (
            _normalize_token(self.storage_status)
            or (existing.storage_status if existing else None)
            or "available"
        )
        is_library_visible = bool(
            requested_visibility
            and artifact_role == "primary"
            and deleted_at is None
            and storage_status == "available"
            and not synthetic_test
        )
        session_id = _normalize_token(self.session_id) or (existing.session_id if existing else None)
        storage_object_path = validate_artifact_storage_object_path(
            self.storage_object_path,
            thread_id=self.thread_id,
            session_id=session_id,
            user_id=user_id,
        )
        effective_storage_object_path = storage_object_path or (existing.storage_object_path if existing else None)
        effective_storage_bucket = _normalize_token(self.storage_bucket) or (existing.storage_bucket if existing else None)
        storage_provider = self.storage_provider
        if storage_provider is None:
            storage_provider = (
                existing.storage_provider
                if existing is not None and effective_storage_object_path
                else ("supabase" if effective_storage_object_path and effective_storage_bucket else "local")
            )

        return ArtifactRecord(
            artifact_id=artifact_id,
            user_id=user_id,
            thread_id=self.thread_id,
            session_id=session_id,
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
            source=existing.source if existing and preserve_existing_source else self.source,
            local_path=local_path,
            storage_provider=storage_provider,
            storage_bucket=effective_storage_bucket,
            storage_object_path=effective_storage_object_path,
            size_bytes=self.size_bytes if self.size_bytes is not None else (existing.size_bytes if existing else None),
            content_hash=_normalize_token(self.content_hash) or (existing.content_hash if existing else None),
            storage_status=storage_status,
            artifact_role=artifact_role,
            is_library_visible=is_library_visible,
            created_at=created_at,
            updated_at=updated_at,
            deleted_at=deleted_at,
            last_opened_at=existing.last_opened_at if existing else None,
            opened_count=existing.opened_count if existing else 0,
            raw_content_excluded=True,
            signed_url_excluded=True,
            synthetic_test=synthetic_test,
            test_run_id=_normalize_token(self.test_run_id)
            or (existing.test_run_id if existing else None),
            test_principal_id=_normalize_token(self.test_principal_id)
            or (existing.test_principal_id if existing else None),
            scenario_id=_normalize_token(self.scenario_id)
            or (existing.scenario_id if existing else None),
            scenario_version=_normalize_token(self.scenario_version)
            or (existing.scenario_version if existing else None),
            environment=_normalize_token(self.environment)
            or (existing.environment if existing else None),
            retention_hours=self.retention_hours
            if self.retention_hours is not None
            else (existing.retention_hours if existing else None),
            retention_anchor=self.retention_anchor
            if self.retention_anchor is not None
            else (existing.retention_anchor if existing else None),
            retention_anchor_at=_normalize_iso(self.retention_anchor_at)
            or (existing.retention_anchor_at if existing else None),
            retention_expires_at=_normalize_iso(self.retention_expires_at)
            or (existing.retention_expires_at if existing else None),
            cleanup_obligation_id=_normalize_token(self.cleanup_obligation_id)
            or (existing.cleanup_obligation_id if existing else None),
            provider_expires_at=_normalize_iso(self.provider_expires_at)
            or (existing.provider_expires_at if existing else None),
            deployment_identity=self.deployment_identity
            if self.deployment_identity is not None
            else (existing.deployment_identity if existing else None),
            memory_retrieval_excluded=self.memory_retrieval_excluded
            if self.memory_retrieval_excluded is not None
            else (existing.memory_retrieval_excluded if existing else False),
            memory_learning_excluded=self.memory_learning_excluded
            if self.memory_learning_excluded is not None
            else (existing.memory_learning_excluded if existing else False),
            ordinary_artifact_publication_excluded=(
                self.ordinary_artifact_publication_excluded
                if self.ordinary_artifact_publication_excluded is not None
                else (
                    existing.ordinary_artifact_publication_excluded
                    if existing
                    else False
                )
            ),
            ordinary_analytics_excluded=self.ordinary_analytics_excluded
            if self.ordinary_analytics_excluded is not None
            else (existing.ordinary_analytics_excluded if existing else False),
            deck_quality_publication_excluded=(
                self.deck_quality_publication_excluded
                if self.deck_quality_publication_excluded is not None
                else (existing.deck_quality_publication_excluded if existing else False)
            ),
            langsmith_export_excluded=self.langsmith_export_excluded
            if self.langsmith_export_excluded is not None
            else (
                existing.langsmith_export_excluded
                if existing
                else synthetic_test
            ),
            langsmith_trace_status=_normalize_token(self.langsmith_trace_status)
            or (
                existing.langsmith_trace_status
                if existing
                else ("trace_unavailable" if synthetic_test else None)
            ),
            langsmith_trace_unavailable_reason=_normalize_token(
                self.langsmith_trace_unavailable_reason
            )
            or (
                existing.langsmith_trace_unavailable_reason
                if existing
                else (
                    "synthetic_isolation_policy"
                    if synthetic_test
                    else None
                )
            ),
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
    include_hidden: bool = False
    include_synthetic: bool = False
    sort: Literal["updated", "created", "recent", "title"] = "updated"
    limit: int = Field(default=100, ge=1, le=250)


class SyntheticArtifactCleanupIssue(BaseModel):
    kind: Literal["artifact_object", "artifact_record"]
    identifier_hash: str = Field(pattern=r"^[0-9a-f]{32}$")
    code: str


class SyntheticArtifactPurgeReceipt(BaseModel):
    test_run_id: str
    test_principal_id: str
    matched_artifact_count: int = Field(ge=0)
    artifact_records_deleted: int = Field(ge=0)
    artifact_objects_deleted: int = Field(ge=0)
    artifact_objects_missing: int = Field(ge=0)
    artifact_objects_not_applicable: int = Field(ge=0)
    remaining_artifact_count: int = Field(ge=0)
    cleanup_complete: bool
    unresolved: list[SyntheticArtifactCleanupIssue] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_zero_artifact_proof(self) -> SyntheticArtifactPurgeReceipt:
        if self.cleanup_complete and (
            self.remaining_artifact_count != 0 or self.unresolved
        ):
            raise ValueError(
                "synthetic artifact cleanup success requires verified zero records"
            )
        return self


def _synthetic_cleanup_identifier(kind: str, value: str) -> str:
    return hashlib.sha256(f"{kind}\0{value}".encode()).hexdigest()[:32]


class ArtifactRegistryConfigurationError(RuntimeError):
    """Raised when the configured artifact registry backend cannot start."""


class ArtifactRegistryStoreError(RuntimeError):
    """Raised when the durable artifact registry backend fails unexpectedly."""


@dataclass(frozen=True)
class SupabaseArtifactRegistryConfig:
    url: str
    service_role_key: str
    bucket: str
    table: str = "artifact_registry_records"


def _truthy_env(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _is_production_runtime() -> bool:
    return any(
        _truthy_env(os.getenv(name))
        for name in ("RENDER", "VERCEL", "RAILWAY_ENVIRONMENT")
    ) or (os.getenv("SOPHIA_ENV") or os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or "").lower() in {
        "prod",
        "production",
        "staging",
    }


def _is_strict_production_runtime() -> bool:
    env_name = (os.getenv("SOPHIA_ENV") or os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or "").lower()
    return env_name in {"prod", "production"} or (
        _truthy_env(os.getenv("RENDER")) and env_name not in {"staging", "stage"}
    )


def _load_supabase_artifact_registry_config() -> SupabaseArtifactRegistryConfig:
    url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    service_role_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    bucket = (os.getenv("SUPABASE_BUILDER_BUCKET") or "").strip()
    missing = [
        name
        for name, value in (
            ("SUPABASE_URL", url),
            ("SUPABASE_SERVICE_ROLE_KEY", service_role_key),
            ("SUPABASE_BUILDER_BUCKET", bucket if _is_production_runtime() else bucket or "local-default"),
        )
        if not value
    ]
    if missing:
        raise ArtifactRegistryConfigurationError(
            "SOPHIA_ARTIFACT_REGISTRY_STORE=supabase requires backend env vars: "
            + ", ".join(missing)
        )
    table = (os.getenv("SOPHIA_ARTIFACT_REGISTRY_TABLE") or "artifact_registry_records").strip()
    return SupabaseArtifactRegistryConfig(
        url=url,
        service_role_key=service_role_key,
        bucket=bucket or supabase_artifact_store.DEFAULT_BUCKET,
        table=table or "artifact_registry_records",
    )


def _supabase_registry_read_limit() -> int:
    try:
        configured = int(os.getenv("SOPHIA_ARTIFACT_REGISTRY_READ_LIMIT", "5000"))
    except ValueError:
        configured = 5000
    return max(250, configured)


class LocalArtifactRegistry:
    """JSON-backed artifact metadata store scoped by user id."""

    def __init__(self, base_path: Path | str | None = None) -> None:
        configured = os.getenv("SOPHIA_ARTIFACT_REGISTRY_BASE_PATH")
        self._base = Path(base_path or configured or _DEFAULT_BASE_PATH)

    def _user_dir(self, user_id: str) -> Path:
        try:
            return safe_user_path(self._base, user_id, "artifacts")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid artifact user scope") from exc

    def _registry_path(self, user_id: str) -> Path:
        return self._user_dir(user_id) / "registry.json"

    def _read_records(self, user_id: str) -> builtins.list[ArtifactRecord]:
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

    def _write_records(
        self,
        user_id: str,
        records: builtins.list[ArtifactRecord],
    ) -> None:
        path = self._registry_path(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "updated_at": _now_iso(),
            "artifacts": [record.model_dump(mode="json") for record in records],
        }
        temporary_path = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            temporary_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
            os.replace(temporary_path, path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()

    def upsert(self, request: ArtifactUpsertRequest, *, user_id: str) -> ArtifactRecord:
        if request.user_id is not None and request.user_id != user_id:
            raise HTTPException(status_code=403, detail="Artifact user scope mismatch")

        records = self._read_records(user_id)
        existing_index = self._find_existing_index(records, request, user_id=user_id)
        existing = records[existing_index] if existing_index is not None else None
        preserve_existing_priority = (
            existing is not None
            and _source_priority(existing.source) <= _source_priority(request.source)
        )
        record = request.to_record(
            user_id=user_id,
            existing=existing,
            preserve_existing_identity=preserve_existing_priority,
            preserve_existing_source=preserve_existing_priority,
        )
        if request.source in _BACKFILL_SOURCES and existing is None and record.artifact_role != "primary":
            return record
        if existing_index is None:
            records.append(record)
        else:
            records[existing_index] = record
        self._write_sorted_records(user_id, records)
        return record

    def upsert_record(self, record: ArtifactRecord, *, user_id: str) -> ArtifactRecord:
        if record.user_id != user_id:
            raise HTTPException(status_code=403, detail="Artifact user scope mismatch")
        records = self._read_records(user_id)
        for index, existing in enumerate(records):
            if existing.artifact_id == record.artifact_id:
                records[index] = record
                self._write_sorted_records(user_id, records)
                return record
        records.append(record)
        self._write_sorted_records(user_id, records)
        return record

    def _write_sorted_records(
        self,
        user_id: str,
        records: builtins.list[ArtifactRecord],
    ) -> None:
        records.sort(key=lambda item: (_parse_timestamp(item.updated_at), item.title.lower()), reverse=True)
        self._write_records(user_id, records)

    def get(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        for record in self._read_records(user_id):
            if record.artifact_id == artifact_id:
                return record
        return None

    def list(self, *, user_id: str, filters: ArtifactRegistryFilters | None = None) -> ArtifactListResponse:
        filters = filters if filters is not None else ArtifactRegistryFilters()
        records = [self._with_effective_visibility(record) for record in self._read_records(user_id)]
        records = self._apply_filters(records, filters)
        if not filters.include_hidden:
            records = self._dedupe_visible(records)
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

    def mark_deleted(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        records = self._read_records(user_id)
        deleted_at = _now_iso()
        updated: ArtifactRecord | None = None
        for index, record in enumerate(records):
            if record.artifact_id != artifact_id:
                continue
            updated = record.model_copy(
                update={
                    "deleted_at": deleted_at,
                    "is_library_visible": False,
                    "updated_at": deleted_at,
                }
            )
            records[index] = updated
            break
        if updated is not None:
            self._write_records(user_id, records)
        return updated

    def synthetic_run_records(
        self,
        *,
        user_id: str,
        test_run_id: str,
    ) -> builtins.list[ArtifactRecord]:
        """Return only records bearing the exact synthetic principal/run tuple."""

        principal = _normalize_token(user_id)
        run_id = _normalize_token(test_run_id)
        if principal is None or run_id is None:
            raise ValueError("synthetic cleanup requires exact principal and run ids")
        return [
            record
            for record in self._read_records(principal)
            if record.synthetic_test
            and record.test_principal_id == principal
            and record.test_run_id == run_id
        ]

    def synthetic_cleanup_obligation_records(
        self,
        *,
        cleanup_obligation_id: str,
    ) -> builtins.list[ArtifactRecord]:
        """Return globally indexed synthetic records for one opaque obligation."""

        if not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            cleanup_obligation_id,
        ):
            raise ValueError("cleanup obligation id must be a canonical UUIDv4")
        if not self._base.is_dir():
            return []
        matched: builtins.list[ArtifactRecord] = []
        for registry_path in self._base.glob("*/artifacts/registry.json"):
            principal = registry_path.parent.parent.name
            matched.extend(
                record
                for record in self._read_records(principal)
                if record.synthetic_test
                and record.cleanup_obligation_id == cleanup_obligation_id
            )
        return sorted(matched, key=lambda record: (record.user_id, record.artifact_id))

    def expired_synthetic_records(
        self,
        *,
        user_id: str,
        now: datetime | None = None,
    ) -> builtins.list[ArtifactRecord]:
        """Return expired synthetic rows for an authenticated bounded reaper."""

        principal = _normalize_token(user_id)
        if principal is None:
            raise ValueError("synthetic cleanup requires an exact principal id")
        return [
            record
            for record in self._read_records(principal)
            if record.synthetic_test
            and record.test_principal_id == principal
            and synthetic_retention_expired(record.model_dump(), now=now)
        ]

    def expired_synthetic_records_global(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> builtins.list[ArtifactRecord]:
        """Return a bounded cross-principal scan of expired synthetic rows."""

        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10_000:
            raise ValueError("synthetic artifact scan limit must be between 1 and 10000")
        if not self._base.is_dir():
            return []
        due: builtins.list[ArtifactRecord] = []
        for registry_path in self._base.glob("*/artifacts/registry.json"):
            principal = registry_path.parent.parent.name
            for record in self.expired_synthetic_records(user_id=principal, now=now):
                due.append(record)
        due.sort(
            key=lambda record: (
                str(record.retention_expires_at or ""),
                record.user_id,
                record.artifact_id,
            )
        )
        return due[:limit]

    def _delete_synthetic_metadata_record(
        self,
        record: ArtifactRecord,
        *,
        user_id: str,
    ) -> None:
        records = self._read_records(user_id)
        retained = [
            current
            for current in records
            if not (
                current.artifact_id == record.artifact_id
                and current.synthetic_test
                and current.test_principal_id == user_id
                and current.test_run_id == record.test_run_id
            )
        ]
        if len(retained) != len(records):
            self._write_sorted_records(user_id, retained)

    def purge_synthetic_run(
        self,
        *,
        user_id: str,
        test_run_id: str,
    ) -> SyntheticArtifactPurgeReceipt:
        """Delete exact-run artifact objects then metadata, safely and idempotently.

        Object bytes are removed before their registry row. If a process dies
        between those steps, the next invocation observes a missing object and
        completes the metadata deletion. Ambiguous transport failures retain the
        metadata row so the cleanup remains auditable and retryable.
        """

        records = self.synthetic_run_records(user_id=user_id, test_run_id=test_run_id)
        objects_deleted = 0
        objects_missing = 0
        objects_not_applicable = 0
        records_deleted = 0
        unresolved: list[SyntheticArtifactCleanupIssue] = []

        for record in records:
            if record.storage_provider in {"supabase", "hybrid"} and record.storage_object_path:
                try:
                    outcome = supabase_artifact_store.delete_artifact_object_if_present(
                        record.storage_object_path
                    )
                except Exception as exc:  # noqa: BLE001 - retain metadata for retry.
                    logger.warning(
                        "Synthetic artifact object cleanup failed artifact_id_hash=%s error_type=%s",
                        _synthetic_cleanup_identifier("artifact", record.artifact_id),
                        type(exc).__name__,
                    )
                    unresolved.append(
                        SyntheticArtifactCleanupIssue(
                            kind="artifact_object",
                            identifier_hash=_synthetic_cleanup_identifier(
                                "artifact_object", record.storage_object_path
                            ),
                            code="object_delete_unconfirmed",
                        )
                    )
                    continue
                if outcome == "deleted":
                    objects_deleted += 1
                else:
                    objects_missing += 1
            else:
                objects_not_applicable += 1

            try:
                self._delete_synthetic_metadata_record(record, user_id=user_id)
                records_deleted += 1
            except Exception as exc:  # noqa: BLE001 - exact typed retry receipt.
                logger.warning(
                    "Synthetic artifact metadata cleanup failed artifact_id_hash=%s error_type=%s",
                    _synthetic_cleanup_identifier("artifact", record.artifact_id),
                    type(exc).__name__,
                )
                unresolved.append(
                    SyntheticArtifactCleanupIssue(
                        kind="artifact_record",
                        identifier_hash=_synthetic_cleanup_identifier(
                            "artifact", record.artifact_id
                        ),
                        code="record_delete_unconfirmed",
                    )
                )

        remaining = self.synthetic_run_records(user_id=user_id, test_run_id=test_run_id)
        known_issue_hashes = {issue.identifier_hash for issue in unresolved}
        for record in remaining:
            identifier_hash = _synthetic_cleanup_identifier("artifact", record.artifact_id)
            if identifier_hash not in known_issue_hashes:
                unresolved.append(
                    SyntheticArtifactCleanupIssue(
                        kind="artifact_record",
                        identifier_hash=identifier_hash,
                        code="record_still_present",
                    )
                )
        return SyntheticArtifactPurgeReceipt(
            test_run_id=test_run_id,
            test_principal_id=user_id,
            matched_artifact_count=len(records),
            artifact_records_deleted=records_deleted,
            artifact_objects_deleted=objects_deleted,
            artifact_objects_missing=objects_missing,
            artifact_objects_not_applicable=objects_not_applicable,
            remaining_artifact_count=len(remaining),
            cleanup_complete=not remaining and not unresolved,
            unresolved=unresolved,
        )

    def _find_existing_index(
        self,
        records: builtins.list[ArtifactRecord],
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
        storage_object_path = validate_artifact_storage_object_path(
            request.storage_object_path,
            thread_id=request.thread_id,
            session_id=request.session_id,
            user_id=user_id,
        )
        request_identity = _canonical_artifact_identity(
            user_id=user_id,
            thread_id=request.thread_id,
            parent_thread_id=request.parent_thread_id,
            local_path=local_path,
            storage_object_path=storage_object_path,
            renderer_kind=renderer_kind,
            artifact_type=artifact_type,
        )
        request_is_synthetic = request.synthetic_test is True

        for index, record in enumerate(records):
            if record.synthetic_test is not request_is_synthetic:
                continue
            if request_is_synthetic and (
                record.test_run_id != request.test_run_id
                or record.test_principal_id != request.test_principal_id
            ):
                continue
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
            if _record_artifact_identity(record) == request_identity:
                return index
        return None

    def _apply_filters(
        self,
        records: builtins.list[ArtifactRecord],
        filters: ArtifactRegistryFilters,
    ) -> builtins.list[ArtifactRecord]:
        result = records
        if not filters.include_synthetic:
            result = [record for record in result if not record.synthetic_test]
        if not filters.include_hidden:
            result = [record for record in result if _is_effectively_visible(record)]
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
    def _with_effective_visibility(record: ArtifactRecord) -> ArtifactRecord:
        role = _effective_artifact_role(record)
        visible = bool(
            record.is_library_visible
            and role == "primary"
            and record.deleted_at is None
            and record.storage_status == "available"
            and not record.synthetic_test
        )
        if role == record.artifact_role and visible == record.is_library_visible:
            return record
        return record.model_copy(update={"artifact_role": role, "is_library_visible": visible})

    @staticmethod
    def _dedupe_visible(
        records: builtins.list[ArtifactRecord],
    ) -> builtins.list[ArtifactRecord]:
        by_identity: dict[tuple[str, str, str, str, str], ArtifactRecord] = {}
        for record in records:
            identity = _record_artifact_identity(record)
            current = by_identity.get(identity)
            if current is None:
                by_identity[identity] = record
                continue
            by_identity[identity] = LocalArtifactRegistry._choose_dedupe_record(current, record)
        return list(by_identity.values())

    @staticmethod
    def _choose_dedupe_record(left: ArtifactRecord, right: ArtifactRecord) -> ArtifactRecord:
        left_key = (
            _source_priority(left.source),
            -_parse_timestamp(left.last_opened_at),
            -_parse_timestamp(left.updated_at),
            left.title.lower(),
        )
        right_key = (
            _source_priority(right.source),
            -_parse_timestamp(right.last_opened_at),
            -_parse_timestamp(right.updated_at),
            right.title.lower(),
        )
        selected, fallback = (left, right) if left_key <= right_key else (right, left)
        return selected.model_copy(
            update={
                "safe_summary": selected.safe_summary or fallback.safe_summary,
                "mime_type": selected.mime_type or fallback.mime_type,
                "size_bytes": selected.size_bytes if selected.size_bytes is not None else fallback.size_bytes,
                "content_hash": selected.content_hash or fallback.content_hash,
                "storage_bucket": selected.storage_bucket or fallback.storage_bucket,
                "storage_object_path": selected.storage_object_path or fallback.storage_object_path,
                "last_opened_at": selected.last_opened_at or fallback.last_opened_at,
                "opened_count": max(selected.opened_count, fallback.opened_count),
            }
        )

    @staticmethod
    def _sort(
        records: builtins.list[ArtifactRecord],
        sort: str,
    ) -> builtins.list[ArtifactRecord]:
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


class SupabaseArtifactRegistry(LocalArtifactRegistry):
    """Supabase Postgres-backed artifact metadata store.

    Artifact bytes stay in local/Supabase object storage and are served through
    the gateway. This store persists only safe metadata rows via PostgREST.
    """

    def __init__(
        self,
        config: SupabaseArtifactRegistryConfig | None = None,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self._config = config or _load_supabase_artifact_registry_config()
        self._client = client or httpx.Client(timeout=10.0)
        self._read_limit = _supabase_registry_read_limit()

    def _headers(self, *, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
        }
        if prefer:
            headers["Prefer"] = prefer
            headers["Content-Type"] = "application/json"
        return headers

    def _table_url(self) -> str:
        return f"{self._config.url}/rest/v1/{self._config.table}"

    def _request(
        self,
        method: str,
        *,
        params: dict[str, str] | None = None,
        json_body: object | None = None,
        prefer: str | None = None,
    ) -> object:
        try:
            response = self._client.request(
                method,
                self._table_url(),
                headers=self._headers(prefer=prefer),
                params=params,
                json=json_body,
            )
        except httpx.HTTPError as exc:
            raise ArtifactRegistryStoreError(f"Supabase artifact registry request failed: {exc}") from exc

        if response.status_code >= 400:
            raise ArtifactRegistryStoreError(
                "Supabase artifact registry request failed "
                f"status={response.status_code} body={response.text[:200]!r}"
            )

        if not response.text:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise ArtifactRegistryStoreError("Supabase artifact registry returned invalid JSON") from exc

    def _row_from_record(self, record: ArtifactRecord) -> dict[str, object]:
        payload = record.model_dump(mode="json")
        return {
            "artifact_id": record.artifact_id,
            "user_id": record.user_id,
            "thread_id": record.thread_id,
            "session_id": record.session_id,
            "parent_thread_id": record.parent_thread_id,
            "task_id": record.task_id,
            "run_id": record.run_id,
            "trace_id": record.trace_id,
            "logical_artifact_id": record.logical_artifact_id,
            "version_id": record.version_id,
            "parent_version_id": record.parent_version_id,
            "title": record.title,
            "filename": record.filename,
            "artifact_type": record.artifact_type,
            "renderer_kind": record.renderer_kind,
            "mime_type": record.mime_type,
            "safe_summary": record.safe_summary,
            "source": record.source,
            "local_path": record.local_path,
            "storage_provider": record.storage_provider,
            "storage_bucket": record.storage_bucket,
            "storage_object_path": record.storage_object_path,
            "size_bytes": record.size_bytes,
            "content_hash": record.content_hash,
            "storage_status": record.storage_status,
            "artifact_role": record.artifact_role,
            "is_library_visible": record.is_library_visible,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "deleted_at": record.deleted_at,
            "last_opened_at": record.last_opened_at,
            "opened_count": record.opened_count,
            "raw_content_excluded": record.raw_content_excluded,
            "signed_url_excluded": record.signed_url_excluded,
            "record_payload": payload,
        }

    def _record_from_row(self, row: object) -> ArtifactRecord | None:
        if not isinstance(row, dict):
            return None
        payload = row.get("record_payload")
        raw = payload if isinstance(payload, dict) else row
        try:
            return ArtifactRecord.model_validate(raw)
        except Exception:
            return None

    def _with_verified_storage(self, record: ArtifactRecord) -> ArtifactRecord:
        if not _is_production_runtime() or record.deleted_at is not None:
            return record
        if record.artifact_role != "primary":
            return record
        if record.storage_provider not in {"supabase", "hybrid"} or not record.storage_object_path:
            if record.is_library_visible:
                logger.warning(
                    "Artifact registry hiding unverified production artifact metadata: artifact_id=%s reason=no_storage_object",
                    record.artifact_id,
                )
            return record.model_copy(update={"storage_status": "missing", "is_library_visible": False})
        exists = supabase_artifact_store.check_artifact_object_exists(record.storage_object_path)
        if not exists:
            logger.warning(
                "Artifact registry hiding production artifact with missing Supabase object: artifact_id=%s",
                record.artifact_id,
            )
            return record.model_copy(update={"storage_status": "missing", "is_library_visible": False})
        return record.model_copy(
            update={
                "storage_bucket": record.storage_bucket or self._config.bucket,
                "storage_status": "available",
            }
        )

    def _read_records(self, user_id: str) -> builtins.list[ArtifactRecord]:
        result = self._request(
            "GET",
            params={
                "select": "*",
                "user_id": f"eq.{user_id}",
                "order": "updated_at.desc",
                "limit": str(self._read_limit),
            },
        )
        rows = result if isinstance(result, list) else []
        return [record for record in (self._record_from_row(row) for row in rows) if record]

    def expired_synthetic_records_global(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> builtins.list[ArtifactRecord]:
        """Return only due synthetic rows from durable global metadata."""

        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10_000:
            raise ValueError("synthetic artifact scan limit must be between 1 and 10000")
        due: builtins.list[ArtifactRecord] = []
        page_size = 100
        offset = 0
        max_scanned = 10_000
        rows: builtins.list[object] = []
        while len(due) < limit and offset < max_scanned:
            result = self._request(
                "GET",
                params={
                    "select": "*",
                    "record_payload->>synthetic_test": "eq.true",
                    "record_payload->>retention_expires_at": (
                        f"lte.{_canonical_utc_millis(now.astimezone(UTC))}"
                    ),
                    "order": "record_payload->>retention_expires_at.asc,artifact_id.asc",
                    "limit": str(page_size),
                    "offset": str(offset),
                },
            )
            rows = result if isinstance(result, list) else []
            for row in rows:
                record = self._record_from_row(row)
                if (
                    record is not None
                    and record.synthetic_test
                    and synthetic_retention_expired(record.model_dump(), now=now)
                ):
                    due.append(record)
                    if len(due) >= limit:
                        break
            offset += len(rows)
            if len(rows) < page_size:
                break
        if len(due) < limit and offset >= max_scanned and len(rows) == page_size:
            raise ArtifactRegistryStoreError(
                "Synthetic artifact reaper scan exceeded its bounded poison-page budget."
            )
        due.sort(
            key=lambda record: (
                str(record.retention_expires_at or ""),
                record.user_id,
                record.artifact_id,
            )
        )
        return due[:limit]

    def synthetic_cleanup_obligation_records(
        self,
        *,
        cleanup_obligation_id: str,
    ) -> builtins.list[ArtifactRecord]:
        if not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            cleanup_obligation_id,
        ):
            raise ValueError("cleanup obligation id must be a canonical UUIDv4")
        result = self._request(
            "GET",
            params={
                "select": "*",
                "record_payload->>synthetic_test": "eq.true",
                "record_payload->>cleanup_obligation_id": (
                    f"eq.{cleanup_obligation_id}"
                ),
                "order": "artifact_id.asc",
                "limit": "1001",
            },
        )
        rows = result if isinstance(result, list) else []
        if len(rows) > 1000:
            raise ArtifactRegistryStoreError(
                "Synthetic cleanup obligation lookup exceeded its hard bound."
            )
        records = [
            record
            for record in (self._record_from_row(row) for row in rows)
            if record is not None
            and record.synthetic_test
            and record.cleanup_obligation_id == cleanup_obligation_id
        ]
        if len(records) != len(rows):
            raise ArtifactRegistryStoreError(
                "Synthetic cleanup obligation lookup contained malformed rows."
            )
        return records

    def upsert(self, request: ArtifactUpsertRequest, *, user_id: str) -> ArtifactRecord:
        if request.user_id is not None and request.user_id != user_id:
            raise HTTPException(status_code=403, detail="Artifact user scope mismatch")

        records = self._read_records(user_id)
        existing_index = self._find_existing_index(records, request, user_id=user_id)
        existing = records[existing_index] if existing_index is not None else None
        preserve_existing_priority = (
            existing is not None
            and _source_priority(existing.source) <= _source_priority(request.source)
        )
        record = request.to_record(
            user_id=user_id,
            existing=existing,
            preserve_existing_identity=preserve_existing_priority,
            preserve_existing_source=preserve_existing_priority,
        )
        if request.source in _BACKFILL_SOURCES and existing is None and record.artifact_role != "primary":
            return record
        record = self._with_verified_storage(record)
        return self.upsert_record(record, user_id=user_id)

    def upsert_record(self, record: ArtifactRecord, *, user_id: str) -> ArtifactRecord:
        if record.user_id != user_id:
            raise HTTPException(status_code=403, detail="Artifact user scope mismatch")
        record = self._with_verified_storage(record)
        result = self._request(
            "POST",
            params={"on_conflict": "artifact_id"},
            json_body=[self._row_from_record(record)],
            prefer="resolution=merge-duplicates,return=representation",
        )
        rows = result if isinstance(result, list) else []
        stored = self._record_from_row(rows[0]) if rows else None
        return stored or record

    def get(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        result = self._request(
            "GET",
            params={
                "select": "*",
                "artifact_id": f"eq.{artifact_id}",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        rows = result if isinstance(result, list) else []
        if not rows:
            return None
        return self._record_from_row(rows[0])

    def list(self, *, user_id: str, filters: ArtifactRegistryFilters | None = None) -> ArtifactListResponse:
        filters = filters if filters is not None else ArtifactRegistryFilters()
        records = [self._with_effective_visibility(record) for record in self._read_records(user_id)]
        records = self._apply_filters(records, filters)
        if not filters.include_hidden:
            records = self._dedupe_visible(records)
        records = self._sort(records, filters.sort)
        limited = records[: filters.limit]
        return ArtifactListResponse(artifacts=limited, total=len(records))

    def mark_opened(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        record = self.get(artifact_id, user_id=user_id)
        if record is None:
            return None
        opened_at = _now_iso()
        updated = record.model_copy(
            update={
                "last_opened_at": opened_at,
                "opened_count": record.opened_count + 1,
                "updated_at": opened_at,
            }
        )
        return self.upsert_record(updated, user_id=user_id)

    def mark_deleted(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        record = self.get(artifact_id, user_id=user_id)
        if record is None:
            return None
        deleted_at = _now_iso()
        updated = record.model_copy(
            update={
                "deleted_at": deleted_at,
                "is_library_visible": False,
                "updated_at": deleted_at,
            }
        )
        return self.upsert_record(updated, user_id=user_id)

    def _delete_synthetic_metadata_record(
        self,
        record: ArtifactRecord,
        *,
        user_id: str,
    ) -> None:
        self._request(
            "DELETE",
            params={
                "artifact_id": f"eq.{record.artifact_id}",
                "user_id": f"eq.{user_id}",
            },
        )
        remaining = self.get(record.artifact_id, user_id=user_id)
        if remaining is not None:
            raise ArtifactRegistryStoreError(
                "Supabase synthetic artifact metadata deletion was not confirmed"
            )


class HybridArtifactRegistry(LocalArtifactRegistry):
    """Supabase-primary registry with local JSON fallback for migration windows."""

    def __init__(
        self,
        *,
        local_registry: LocalArtifactRegistry | None = None,
        supabase_registry: SupabaseArtifactRegistry | None = None,
    ) -> None:
        self._local = local_registry or LocalArtifactRegistry()
        self._supabase = supabase_registry or SupabaseArtifactRegistry()

    def _read_merged_records(
        self,
        user_id: str,
    ) -> builtins.list[ArtifactRecord]:
        records: list[ArtifactRecord] = []
        seen_artifact_ids: set[str] = set()
        seen_identities: set[tuple[str, str, str, str, str]] = set()

        for record in self._supabase._read_records(user_id):
            records.append(record)
            seen_artifact_ids.add(record.artifact_id)
            seen_identities.add(_record_artifact_identity(record))

        for record in self._local._read_records(user_id):
            identity = _record_artifact_identity(record)
            if record.artifact_id in seen_artifact_ids or identity in seen_identities:
                continue
            records.append(record)
            seen_artifact_ids.add(record.artifact_id)
            seen_identities.add(identity)

        return records

    def _read_records(self, user_id: str) -> builtins.list[ArtifactRecord]:
        return self._read_merged_records(user_id)

    def expired_synthetic_records_global(
        self,
        *,
        now: datetime,
        limit: int,
    ) -> builtins.list[ArtifactRecord]:
        candidates = [
            *self._supabase.expired_synthetic_records_global(now=now, limit=limit),
            *self._local.expired_synthetic_records_global(now=now, limit=limit),
        ]
        deduped: dict[tuple[str, str], ArtifactRecord] = {}
        for record in candidates:
            deduped.setdefault((record.user_id, record.artifact_id), record)
        return sorted(
            deduped.values(),
            key=lambda record: (
                str(record.retention_expires_at or ""),
                record.user_id,
                record.artifact_id,
            ),
        )[:limit]

    def synthetic_cleanup_obligation_records(
        self,
        *,
        cleanup_obligation_id: str,
    ) -> builtins.list[ArtifactRecord]:
        candidates = [
            *self._supabase.synthetic_cleanup_obligation_records(
                cleanup_obligation_id=cleanup_obligation_id
            ),
            *self._local.synthetic_cleanup_obligation_records(
                cleanup_obligation_id=cleanup_obligation_id
            ),
        ]
        deduped: dict[tuple[str, str], ArtifactRecord] = {}
        for record in candidates:
            deduped.setdefault((record.user_id, record.artifact_id), record)
        return sorted(
            deduped.values(),
            key=lambda record: (record.user_id, record.artifact_id),
        )

    def _delete_synthetic_metadata_record(
        self,
        record: ArtifactRecord,
        *,
        user_id: str,
    ) -> None:
        self._supabase._delete_synthetic_metadata_record(record, user_id=user_id)
        self._local._delete_synthetic_metadata_record(record, user_id=user_id)

    def upsert(self, request: ArtifactUpsertRequest, *, user_id: str) -> ArtifactRecord:
        record = self._supabase.upsert(request, user_id=user_id)
        try:
            self._local.upsert_record(record, user_id=user_id)
        except Exception:
            pass
        return record

    def upsert_record(self, record: ArtifactRecord, *, user_id: str) -> ArtifactRecord:
        stored = self._supabase.upsert_record(record, user_id=user_id)
        try:
            self._local.upsert_record(stored, user_id=user_id)
        except Exception:
            pass
        return stored

    def get(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        return self._supabase.get(artifact_id, user_id=user_id) or self._local.get(
            artifact_id,
            user_id=user_id,
        )

    def list(self, *, user_id: str, filters: ArtifactRegistryFilters | None = None) -> ArtifactListResponse:
        filters = filters if filters is not None else ArtifactRegistryFilters()
        records = [self._with_effective_visibility(record) for record in self._read_merged_records(user_id)]
        records = self._apply_filters(records, filters)
        if not filters.include_hidden:
            records = self._dedupe_visible(records)
        records = self._sort(records, filters.sort)
        limited = records[: filters.limit]
        return ArtifactListResponse(artifacts=limited, total=len(records))

    def mark_opened(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        if self._supabase.get(artifact_id, user_id=user_id) is not None:
            opened = self._supabase.mark_opened(artifact_id, user_id=user_id)
            if opened is not None:
                try:
                    self._local.upsert_record(opened, user_id=user_id)
                except Exception:
                    pass
            return opened
        return self._local.mark_opened(artifact_id, user_id=user_id)

    def mark_deleted(self, artifact_id: str, *, user_id: str) -> ArtifactRecord | None:
        if self._supabase.get(artifact_id, user_id=user_id) is not None:
            deleted = self._supabase.mark_deleted(artifact_id, user_id=user_id)
            if deleted is not None:
                try:
                    self._local.upsert_record(deleted, user_id=user_id)
                except Exception:
                    pass
            return deleted
        return self._local.mark_deleted(artifact_id, user_id=user_id)


def ArtifactRegistry(
    base_path: Path | str | None = None,
    *,
    backend: Literal["local", "supabase", "hybrid"] | None = None,
    client: httpx.Client | None = None,
) -> LocalArtifactRegistry:
    """Return the configured artifact metadata registry.

    Local development defaults to the JSON-backed store. Production-like
    runtimes default to Supabase so artifact metadata does not silently depend
    on an ephemeral filesystem.
    """

    if base_path is not None:
        return LocalArtifactRegistry(base_path)

    configured_backend = os.getenv("SOPHIA_ARTIFACT_REGISTRY_STORE")
    selected = (backend or configured_backend or "").strip().lower()
    if not selected:
        if _is_production_runtime():
            raise ArtifactRegistryConfigurationError(
                "Production runtime requires SOPHIA_ARTIFACT_REGISTRY_STORE=supabase; "
                "artifact registry metadata must not default silently."
            )
        selected = "local"

    if selected == "local":
        if _is_production_runtime() and not _truthy_env(os.getenv("SOPHIA_ALLOW_LOCAL_ARTIFACT_REGISTRY_IN_PRODUCTION")):
            raise ArtifactRegistryConfigurationError(
                "Production runtime requires SOPHIA_ARTIFACT_REGISTRY_STORE=supabase; "
                "local artifact registry metadata is not durable on ephemeral filesystems."
            )
        return LocalArtifactRegistry()

    if selected == "supabase":
        return SupabaseArtifactRegistry(client=client)

    if selected == "hybrid":
        if _is_strict_production_runtime():
            raise ArtifactRegistryConfigurationError(
                "SOPHIA_ARTIFACT_REGISTRY_STORE=hybrid is reserved for migration or staging; "
                "production must use SOPHIA_ARTIFACT_REGISTRY_STORE=supabase."
            )
        return HybridArtifactRegistry(
            local_registry=LocalArtifactRegistry(),
            supabase_registry=SupabaseArtifactRegistry(client=client),
        )

    raise ArtifactRegistryConfigurationError(
        "SOPHIA_ARTIFACT_REGISTRY_STORE must be one of: local, supabase, hybrid"
    )


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

    raw_synthetic = payload.get("synthetic_test")
    synthetic_mapping = raw_synthetic if isinstance(raw_synthetic, dict) else {}
    synthetic_test = raw_synthetic is True or synthetic_mapping.get("synthetic") is True

    def _synthetic_value(key: str) -> object:
        value = payload.get(key)
        return value if value is not None else synthetic_mapping.get(key)

    local_path = normalize_artifact_registry_path(artifact_path)
    relative = _relative_output_path(local_path)
    filename = _normalize_token(payload.get("artifact_filename")) or _filename_from_path(local_path)
    mime_type = _infer_mime_type(filename, None)
    artifact_type = _normalize_artifact_type(_normalize_token(payload.get("artifact_type")), local_path, mime_type)
    renderer_kind = _normalize_renderer_kind(_normalize_token(payload.get("renderer_kind")), artifact_type)
    emitted_artifact_id = _normalize_token(payload.get("artifact_id"))
    artifact_id = (
        _hash_id(
            "synthetic_artifact",
            user_id,
            _normalize_token(_synthetic_value("test_run_id")) or "missing-run",
            emitted_artifact_id or "",
            thread_id,
            local_path,
            renderer_kind,
        )
        if synthetic_test
        else emitted_artifact_id
        or supabase_artifact_store.builder_artifact_record_id(
            user_id=user_id,
            thread_id=thread_id,
            local_path=local_path,
            renderer_kind=renderer_kind,
        )
    )
    storage_bucket = _normalize_token(payload.get("storage_bucket")) or supabase_artifact_store.configured_bucket_name()
    storage_object_path = normalize_artifact_storage_object_path(payload.get("storage_object_path"))
    if storage_object_path is None and relative and storage_bucket and supabase_artifact_store.is_configured():
        storage_object_path = supabase_artifact_store.builder_artifact_object_path(
            user_id=user_id,
            thread_or_session_id=getattr(session_record, "session_id", None) or thread_id,
            artifact_id=artifact_id,
            filename=filename,
        )
    storage_provider: ArtifactStorageProvider = "supabase" if storage_bucket and storage_object_path else "local"
    deployment_identity = _normalize_deployment_identity(
        _synthetic_value("deployment_identity")
    )
    return user_id, ArtifactUpsertRequest(
        artifact_id=artifact_id,
        user_id=user_id,
        thread_id=thread_id,
        session_id=getattr(session_record, "session_id", None),
        parent_thread_id=thread_id,
        task_id=_normalize_token(payload.get("task_id")),
        run_id=_normalize_token(payload.get("run_id")),
        trace_id=_normalize_token(payload.get("trace_id")),
        logical_artifact_id=_normalize_token(payload.get("logical_artifact_id")),
        version_id=(
            _normalize_token(payload.get("current_artifact_version_id"))
            or _normalize_token(payload.get("artifact_version_id"))
        ),
        title=_normalize_token(payload.get("artifact_title")) or _normalize_token(payload.get("artifact_filename")),
        filename=filename,
        artifact_type=artifact_type,
        renderer_kind=renderer_kind,
        requested_artifact_ext=_normalize_token(payload.get("requested_artifact_ext")),
        artifact_ext=_normalize_token(payload.get("artifact_ext")),
        artifact_is_fallback=payload.get("artifact_is_fallback")
        if isinstance(payload.get("artifact_is_fallback"), bool)
        else None,
        mime_type=mime_type,
        safe_summary=_normalize_token(payload.get("summary")) or _normalize_token(payload.get("user_next_action")),
        source="builder",
        local_path=local_path,
        storage_provider=storage_provider,
        storage_bucket=storage_bucket,
        storage_object_path=storage_object_path,
        storage_status=_normalize_token(payload.get("storage_status")) or "available",
        is_library_visible=not synthetic_test,
        created_at=_normalize_iso(payload.get("completed_at")),
        raw_content_excluded=True,
        signed_url_excluded=True,
        synthetic_test=synthetic_test,
        test_run_id=_normalize_token(_synthetic_value("test_run_id")),
        test_principal_id=_normalize_token(
            _synthetic_value("test_principal_id")
            or _synthetic_value("principal_id")
        ),
        scenario_id=_normalize_token(_synthetic_value("scenario_id")),
        scenario_version=_normalize_token(_synthetic_value("scenario_version")),
        environment=_normalize_token(_synthetic_value("environment")),
        retention_hours=(
            _synthetic_value("retention_hours")
            if isinstance(_synthetic_value("retention_hours"), int)
            and not isinstance(_synthetic_value("retention_hours"), bool)
            else None
        ),
        retention_anchor=_normalize_token(_synthetic_value("retention_anchor")),
        retention_anchor_at=_normalize_iso(_synthetic_value("retention_anchor_at")),
        retention_expires_at=_normalize_iso(
            _synthetic_value("retention_expires_at")
            or _synthetic_value("retention_expiry")
        ),
        cleanup_obligation_id=_normalize_token(
            _synthetic_value("cleanup_obligation_id")
        ),
        provider_expires_at=_normalize_iso(
            _synthetic_value("provider_expires_at")
        ),
        deployment_identity=deployment_identity,
        memory_retrieval_excluded=synthetic_test,
        memory_learning_excluded=synthetic_test,
        ordinary_artifact_publication_excluded=synthetic_test,
        ordinary_analytics_excluded=synthetic_test,
        deck_quality_publication_excluded=synthetic_test,
        langsmith_export_excluded=synthetic_test,
        langsmith_trace_status=("trace_unavailable" if synthetic_test else None),
        langsmith_trace_unavailable_reason=(
            "synthetic_isolation_policy" if synthetic_test else None
        ),
    )
