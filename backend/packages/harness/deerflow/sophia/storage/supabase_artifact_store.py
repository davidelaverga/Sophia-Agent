"""Supabase Storage adapter for Sophia builder artifacts.

Uploads and downloads builder-generated files to the configured Supabase
Storage bucket using the Supabase Storage REST API via ``httpx``. Legacy
builder objects use one folder per ``thread_id``; durable Artifact
Observatory objects use an explicit user-scoped path.

The adapter is a graceful no-op when the required environment variables
are missing so local development keeps working without Supabase.
"""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any, Literal
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


DEFAULT_BUCKET = "sophia-builder-artifacts"
_REQUEST_TIMEOUT_SECONDS = 15.0
_MAX_LIST_DEPTH = 8
_MAX_INTERNAL_LIST_OBJECTS = 10_000
_MAX_INTERNAL_LIST_DEPTH = 32
_MAX_INTERNAL_LIST_PAGE_SIZE = 1_000
_MAX_INTERNAL_LIST_PAGES = 1_000
_MAX_STORAGE_ERROR_BODY_BYTES = 4_096
_SAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9._=-]+")
_CREATE_ONLY_CONFLICT_STATUS_CODES = frozenset({400, 409})

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

# Reserved storage path segments that hold inputs or builder-internal state,
# never user-facing deliverables. Match these at *any* depth: durable deck
# quality evidence lives below ``foundation/.builder/...``, not at a legacy
# thread-relative root. Service-role worker read/write helpers intentionally do
# not enforce this presentation boundary; only public listing/signing surfaces
# do.
_INTERNAL_ARTIFACT_PATH_SEGMENTS = frozenset(
    {
        ".builder",
        "assets",
        "deck_build",
        "ledger",
        "slides",
        "source_artifact",
        "sources",
        "uploads",
        "visuals",
    }
)


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


class ArtifactObjectSizeError(RuntimeError):
    """A remote object exceeded an explicit pre-allocation read budget."""


class ArtifactObjectListLimitError(RuntimeError):
    """A bounded internal object listing could not be completed safely."""


def _truthy_env(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def is_production_runtime() -> bool:
    return any(_truthy_env(os.getenv(name)) for name in ("RENDER", "VERCEL", "RAILWAY_ENVIRONMENT")) or (os.getenv("SOPHIA_ENV") or os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or "").lower() in {
        "prod",
        "production",
        "staging",
    }


def artifact_registry_store_mode() -> str:
    return (os.getenv("SOPHIA_ARTIFACT_REGISTRY_STORE") or "").strip().lower()


def requires_durable_artifact_upload() -> bool:
    return is_production_runtime() and artifact_registry_store_mode() == "supabase"


def missing_required_config() -> tuple[str, ...]:
    required_service_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    service_key = required_service_key or (os.getenv("SUPABASE_KEY") or "").strip()
    missing: list[str] = []
    if not (os.getenv("SUPABASE_URL") or "").strip():
        missing.append("SUPABASE_URL")
    if requires_durable_artifact_upload():
        if not required_service_key:
            missing.append("SUPABASE_SERVICE_ROLE_KEY")
        if not (os.getenv("SUPABASE_BUILDER_BUCKET") or "").strip():
            missing.append("SUPABASE_BUILDER_BUCKET")
    elif not service_key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    return tuple(missing)


def _load_config() -> SupabaseConfig | None:
    url = (os.getenv("SUPABASE_URL") or "").strip()
    if requires_durable_artifact_upload():
        service_role_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    else:
        service_role_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or (os.getenv("SUPABASE_KEY") or "").strip()
    bucket = (os.getenv("SUPABASE_BUILDER_BUCKET") or "").strip()
    if requires_durable_artifact_upload() and not bucket:
        return None
    if not bucket:
        bucket = DEFAULT_BUCKET
    if not url or not service_role_key:
        return None
    return SupabaseConfig(url=url.rstrip("/"), service_role_key=service_role_key, bucket=bucket)


def _load_service_role_config() -> SupabaseConfig | None:
    """Load storage config only when the explicit service-role key is set.

    Generic prefix enumeration is intentionally unavailable to deployments
    configured with only ``SUPABASE_KEY``. Exact object operations retain
    their existing development fallback, while recursive internal scans must
    always authenticate as the service role.
    """

    if not (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip():
        return None
    return _load_config()


def is_configured() -> bool:
    return _load_config() is not None


def configured_bucket_name() -> str | None:
    config = _load_config()
    return config.bucket if config is not None else None


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


def normalize_object_path(object_path: str) -> str:
    """Normalize a full Supabase Storage object path and reject traversal."""
    decoded = object_path.strip().replace("\\", "/")
    if decoded.startswith("file://"):
        decoded = decoded[len("file://") :]
    if decoded.startswith("/") or decoded.startswith("//") or (len(decoded) >= 2 and decoded[1] == ":"):
        raise ValueError("Unsafe Supabase object path")
    parts: list[str] = []
    for part in decoded.split("/"):
        if part in {"", "."}:
            continue
        if part == "..":
            raise ValueError("Supabase object path traversal detected")
        parts.append(part)
    normalized = "/".join(parts)
    if not normalized:
        raise ValueError("Supabase object path is required")
    return normalized


def is_internal_artifact_path(path: str) -> bool:
    """Return whether ``path`` enters a reserved artifact keyspace.

    This is a segment classifier rather than a prefix check so both legacy
    paths (``thread/.builder/...``) and user-scoped durable paths
    (``artifacts/user/thread/foundation/.builder/...``) are protected. It is
    deliberately side-effect free and does not prevent trusted workers from
    reading an exact internal object through the service-role APIs.
    """
    normalized = str(path or "").strip().replace("\\", "/")
    return any(segment.casefold() in _INTERNAL_ARTIFACT_PATH_SEGMENTS for segment in normalized.split("/") if segment not in {"", "."})


def safe_object_path_segment(value: object, *, default: str = "segment") -> str:
    text = str(value or "").strip().replace("\\", "/").strip("/")
    text = text.replace("/", "_")
    text = _SAFE_SEGMENT_RE.sub("_", text).strip(" ._")
    if not text or text in {".", ".."}:
        text = default
    return text[:128] or default


def safe_filename_segment(value: object, *, default: str = "artifact") -> str:
    name = PurePosixPath(str(value or "").strip().replace("\\", "/")).name
    return safe_object_path_segment(name, default=default)


def _hash_id(prefix: str, *parts: object) -> str:
    basis = "\x1f".join("" if part is None else str(part) for part in parts)
    digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def _artifact_type_from_path(path: str, artifact_type: str | None = None) -> str:
    lower_value = (artifact_type or "").strip().lower()
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in {".html", ".htm"}:
        return "html"
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".md", ".markdown"}:
        return "markdown"
    if suffix in {".pptx", ".ppt"}:
        return "pptx"
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}:
        return "image"
    if lower_value in {"html", "pdf", "markdown", "pptx", "image", "visual"}:
        return "image" if lower_value == "visual" else lower_value
    if lower_value in {"webpage", "website"}:
        return "html"
    if lower_value in {"slide", "slides", "presentation", "deck"}:
        return "pptx"
    return lower_value or "other"


def builder_renderer_kind(path: str, artifact_type: str | None = None) -> str:
    normalized_type = _artifact_type_from_path(path, artifact_type)
    if normalized_type == "pptx":
        return "download_only"
    if normalized_type in {"html", "pdf", "markdown", "image"}:
        return normalized_type
    return "metadata"


def builder_artifact_record_id(
    *,
    user_id: str,
    thread_id: str,
    local_path: str,
    renderer_kind: str,
    source: str = "builder",
) -> str:
    logical_artifact_id = _hash_id("logical", user_id, thread_id, local_path, renderer_kind)
    version_id = f"{logical_artifact_id}::v1"
    return _hash_id("artifact", user_id, thread_id, local_path, renderer_kind, source, version_id)


def builder_artifact_object_path(
    *,
    user_id: str,
    thread_or_session_id: str,
    artifact_id: str,
    filename: str,
) -> str:
    return normalize_object_path(
        f"artifacts/{safe_object_path_segment(user_id, default='user')}/{safe_object_path_segment(thread_or_session_id, default='thread')}/{safe_object_path_segment(artifact_id, default='artifact')}/{safe_filename_segment(filename)}"
    )


def immutable_builder_artifact_object_path(
    *,
    user_id: str,
    thread_or_session_id: str,
    logical_artifact_id: str,
    artifact_version_id: str,
    artifact_sha256: str,
    filename: str,
) -> str:
    """Return a public-signable, version/hash-bound create-only artifact key."""

    required_identity = {
        "user_id": user_id,
        "thread_or_session_id": thread_or_session_id,
        "logical_artifact_id": logical_artifact_id,
        "artifact_version_id": artifact_version_id,
        "filename": filename,
    }
    if any(not isinstance(value, str) or not value.strip() for value in required_identity.values()):
        raise ValueError("immutable artifact identity is invalid")
    if re.fullmatch(r"[0-9a-f]{64}", artifact_sha256) is None:
        raise ValueError("artifact SHA-256 is invalid")
    version_digest = hashlib.sha256(artifact_version_id.encode("utf-8")).hexdigest()
    return normalize_object_path(
        "artifacts/"
        f"{safe_object_path_segment(user_id, default='user')}/"
        f"{safe_object_path_segment(thread_or_session_id, default='thread')}/"
        f"{safe_object_path_segment(logical_artifact_id, default='artifact')}/"
        f"versions/{version_digest}/{artifact_sha256}/"
        f"{safe_filename_segment(filename)}"
    )


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
    if is_internal_artifact_path(relative):
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
    """Keyspaces that must never appear in user-facing artifact listings."""
    return is_internal_artifact_path(filename)


def _record_name(record: Any) -> str | None:
    raw_name = record.get("name") if isinstance(record, dict) else None
    return raw_name if isinstance(raw_name, str) and raw_name else None


def _record_content_type(record: dict[str, Any]) -> str | None:
    content_type = _metadata_value(record, "mimetype", "mimeType", "contentType", "content_type")
    return content_type if isinstance(content_type, str) and content_type else None


def _record_modified_at(record: dict[str, Any]) -> str:
    return _coerce_modified_at(record.get("updated_at") or record.get("created_at") or record.get("last_accessed_at"))


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
    """Upload ``content`` to ``{bucket}/{thread_id}/{filename}``.

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


def upload_artifact_object(
    object_path: str,
    content: bytes,
    *,
    content_type: str | None = None,
    client: httpx.Client | None = None,
) -> str | None:
    """Upload bytes to an explicit safe object path in the artifacts bucket."""
    normalized_path = normalize_object_path(object_path)
    config = _load_config()
    if config is None:
        logger.debug("Supabase not configured; skipping upload for object_path=%s", normalized_path)
        return None

    url = _object_url(config, normalized_path)
    mime_type = content_type or mimetypes.guess_type(normalized_path)[0] or "application/octet-stream"
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": mime_type,
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
        "Uploaded artifact object to Supabase: bucket=%s object_path=%s bytes=%d",
        config.bucket,
        normalized_path,
        len(content),
    )
    return normalized_path


def create_artifact_object_if_absent(
    object_path: str,
    content: bytes,
    *,
    content_type: str | None = None,
    client: httpx.Client | None = None,
) -> Literal["created", "exists"]:
    """Create an exact object without overwriting an existing copy.

    Supabase Storage has returned both 400 and 409 for create-only conflicts.
    The response body is intentionally neither parsed nor logged. A conflict
    status is classified as ``exists`` only after an exact-path existence
    probe succeeds; otherwise the original HTTP failure is raised.
    """
    normalized_path = normalize_object_path(object_path)
    config = _load_config()
    if config is None:
        raise RuntimeError("Supabase artifact store is not configured")

    url = _object_url(config, normalized_path)
    mime_type = content_type or mimetypes.guess_type(normalized_path)[0] or "application/octet-stream"
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": mime_type,
        "x-upsert": "false",
        "Cache-Control": "no-cache",
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.post(url, content=content, headers=headers)
        if response.status_code in _CREATE_ONLY_CONFLICT_STATUS_CODES and check_artifact_object_exists(normalized_path, client=http):
            logger.info(
                "Artifact object already exists in Supabase: bucket=%s object_path=%s",
                config.bucket,
                normalized_path,
            )
            return "exists"
        response.raise_for_status()
    finally:
        if owns_client:
            http.close()

    logger.info(
        "Created immutable artifact object in Supabase: bucket=%s object_path=%s bytes=%d",
        config.bucket,
        normalized_path,
        len(content),
    )
    return "created"


def _list_page(
    http: httpx.Client,
    *,
    url: str,
    headers: dict[str, str],
    prefix: str,
    page_size: int,
    offset: int,
    sort_column: str = "updated_at",
    sort_order: Literal["asc", "desc"] = "desc",
) -> list[Any] | None:
    response = http.post(
        url,
        headers=headers,
        json={
            "prefix": prefix,
            "limit": page_size,
            "offset": offset,
            "sortBy": {"column": sort_column, "order": sort_order},
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
    """List artifacts stored under ``{bucket}/{thread_id}/``.

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


def _validate_internal_list_bound(name: str, value: int, *, minimum: int, maximum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")


def _internal_list_record_path(
    *,
    root_prefix: str,
    current_prefix: str,
    raw_name: str,
) -> str:
    raw_path = raw_name.strip().replace("\\", "/")
    root_path = root_prefix.rstrip("/")
    current_path = current_prefix.rstrip("/")
    if raw_path == root_path or raw_path.startswith(root_prefix):
        candidate = raw_path
    elif raw_path == current_path or raw_path.startswith(current_prefix):
        candidate = raw_path
    else:
        candidate = f"{current_prefix}{raw_path}"
    normalized = normalize_object_path(candidate)
    if normalized != root_path and not normalized.startswith(root_prefix):
        raise ValueError("Supabase list response escaped the requested prefix")
    return normalized


def list_artifact_object_paths_bounded(
    prefix: str,
    *,
    max_objects: int,
    max_depth: int,
    page_size: int = 100,
    client: httpx.Client | None = None,
) -> list[str]:
    """Recursively list canonical object paths under an internal prefix.

    This is a trusted service-role primitive, not a user-facing artifact
    listing. It intentionally does not apply presentation-keyspace filters so
    a recovery worker can scan a top-level internal producer queue such as
    ``dq1/producer/v1``. Every caller-selected dimension is validated against a
    hard ceiling, and overflow raises :class:`ArtifactObjectListLimitError`
    instead of returning an apparently complete partial scan.
    """

    normalized_root = normalize_object_path(prefix)
    _validate_internal_list_bound(
        "max_objects",
        max_objects,
        minimum=1,
        maximum=_MAX_INTERNAL_LIST_OBJECTS,
    )
    _validate_internal_list_bound(
        "max_depth",
        max_depth,
        minimum=0,
        maximum=_MAX_INTERNAL_LIST_DEPTH,
    )
    _validate_internal_list_bound(
        "page_size",
        page_size,
        minimum=1,
        maximum=_MAX_INTERNAL_LIST_PAGE_SIZE,
    )

    config = _load_service_role_config()
    if config is None:
        raise RuntimeError("Supabase service-role artifact listing is not configured")

    root_prefix = f"{normalized_root}/"
    root_segment_count = len(normalized_root.split("/"))
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": "application/json",
    }
    url = _list_url(config)
    paths: list[str] = []
    seen_paths: set[str] = set()
    visited_prefixes: set[str] = set()
    page_requests = 0

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)

    def visit(current_prefix: str) -> None:
        nonlocal page_requests
        if current_prefix in visited_prefixes:
            return
        visited_prefixes.add(current_prefix)
        offset = 0
        while True:
            if page_requests >= _MAX_INTERNAL_LIST_PAGES:
                raise ArtifactObjectListLimitError("internal object listing exceeded its page budget")
            page_requests += 1
            data = _list_page(
                http,
                url=url,
                headers=headers,
                prefix=current_prefix,
                page_size=page_size,
                offset=offset,
            )
            if data is None:
                raise RuntimeError("Supabase internal object listing returned an invalid response")

            for item in data:
                raw_name = _record_name(item)
                if raw_name is None:
                    continue
                object_path = _internal_list_record_path(
                    root_prefix=root_prefix,
                    current_prefix=current_prefix,
                    raw_name=raw_name,
                )
                if object_path == normalized_root:
                    continue
                relative_segments = object_path.split("/")[root_segment_count:]
                if not relative_segments:
                    continue

                if isinstance(item, dict) and _is_folder_record(item):
                    folder_depth = len(relative_segments)
                    if folder_depth > max_depth:
                        raise ArtifactObjectListLimitError("internal object listing exceeded max_depth")
                    visit(f"{object_path}/")
                    continue

                parent_depth = len(relative_segments) - 1
                if parent_depth > max_depth:
                    raise ArtifactObjectListLimitError("internal object listing exceeded max_depth")
                if object_path in seen_paths:
                    continue
                if len(paths) >= max_objects:
                    raise ArtifactObjectListLimitError("internal object listing exceeded max_objects")
                seen_paths.add(object_path)
                paths.append(object_path)

            if len(data) < page_size:
                return
            offset += page_size

    try:
        visit(root_prefix)
        return sorted(paths)
    finally:
        if owns_client:
            http.close()


def list_artifact_object_paths_flat_page(
    prefix: str,
    *,
    limit: int,
    client: httpx.Client | None = None,
) -> list[str]:
    """List one bounded page of direct child objects under an internal prefix.

    Returning exactly ``limit`` objects is valid and does not imply the prefix
    is complete. Nested folders fail closed so deleting processed direct
    children always advances the next deterministic queue page.
    """

    normalized_root = normalize_object_path(prefix)
    _validate_internal_list_bound(
        "limit",
        limit,
        minimum=1,
        maximum=_MAX_INTERNAL_LIST_PAGE_SIZE,
    )
    config = _load_service_role_config()
    if config is None:
        raise RuntimeError("Supabase service-role artifact listing is not configured")

    root_prefix = f"{normalized_root}/"
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": "application/json",
    }
    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        data = _list_page(
            http,
            url=_list_url(config),
            headers=headers,
            prefix=root_prefix,
            page_size=limit,
            offset=0,
            sort_column="name",
            sort_order="asc",
        )
        if data is None:
            raise RuntimeError("Supabase flat object listing returned an invalid response")
        paths: list[str] = []
        seen: set[str] = set()
        for item in data:
            if not isinstance(item, dict):
                raise RuntimeError("Supabase flat object listing returned a malformed record")
            raw_name = _record_name(item)
            if raw_name is None:
                raise RuntimeError("Supabase flat object listing returned a nameless record")
            if _is_folder_record(item):
                raise ArtifactObjectListLimitError("flat internal object queue contains a nested folder")
            object_path = _internal_list_record_path(
                root_prefix=root_prefix,
                current_prefix=root_prefix,
                raw_name=raw_name,
            )
            relative = object_path.removeprefix(root_prefix)
            if not relative or "/" in relative:
                raise ArtifactObjectListLimitError("flat internal object queue contains a nested object")
            if object_path in seen:
                raise RuntimeError("Supabase flat object listing returned a duplicate")
            seen.add(object_path)
            paths.append(object_path)
        return sorted(paths)
    finally:
        if owns_client:
            http.close()


def delete_artifact_object_if_present(
    object_path: str,
    *,
    client: httpx.Client | None = None,
) -> Literal["deleted", "missing"]:
    """Delete one canonical internal object with service-role authorization.

    Callers requiring ambiguity safety read the path back after this operation;
    transport failure can occur after Supabase committed deletion.
    """

    normalized_path = normalize_object_path(object_path)
    config = _load_service_role_config()
    if config is None:
        raise RuntimeError("Supabase service-role artifact deletion is not configured")
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
        "Content-Type": "application/json",
    }
    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        # Supabase's remove contract is bucket-scoped. The object keys belong
        # in the ``prefixes`` JSON body; a 404 from this endpoint is a route or
        # bucket failure, not proof that the requested object is absent.
        response = http.request(
            "DELETE",
            f"{config.url}/storage/v1/object/{config.bucket}",
            headers=headers,
            json={"prefixes": [normalized_path]},
        )
        response.raise_for_status()
        try:
            deleted = response.json()
        except ValueError as exc:
            raise RuntimeError("Supabase artifact deletion returned invalid JSON") from exc
        if deleted == []:
            return "missing"
        if not isinstance(deleted, list) or len(deleted) != 1:
            raise RuntimeError("Supabase artifact deletion returned an invalid result")
        record = deleted[0]
        if not isinstance(record, dict) or _record_name(record) != normalized_path:
            raise RuntimeError("Supabase artifact deletion did not acknowledge the exact object")
        return "deleted"
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
        # Supabase Storage answers 400 (not only 404) for the missing-object
        # shape on some endpoints (prod 2026-06-12 / 2026-06-26) — treat both as
        # a benign "no object yet", not a transport error worth a warning.
        if response.status_code in (400, 404):
            logger.debug(
                "Supabase HEAD: no object yet thread_id=%s filename=%s status=%s",
                thread_id,
                filename,
                response.status_code,
            )
            return False
        # Any other non-2xx is treated as "not exists" to keep the builder flow
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
    object_path: str | None = None,
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

    target_object_path = normalize_object_path(object_path) if object_path else _object_path(thread_id, filename)
    if is_internal_artifact_path(target_object_path):
        logger.warning("Refusing to mint a signed URL for an internal artifact keyspace")
        return None
    sign_url = f"{config.url}/storage/v1/object/sign/{config.bucket}/{_encoded_object_path(target_object_path)}"
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
                "Supabase signed-URL mint failed for object_path=%s status=%s body=%s",
                target_object_path,
                response.status_code,
                response.text[:200],
            )
            return None
        data = response.json()
        signed_url = data.get("signedURL") or data.get("signed_url")
        if not isinstance(signed_url, str) or not signed_url:
            logger.warning(
                "Supabase signed-URL response missing signedURL field for object_path=%s",
                target_object_path,
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
            "Supabase signed-URL mint error for object_path=%s error=%s",
            target_object_path,
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
        # Supabase Storage answers 400 (not only 404) for the missing-object
        # shape on some endpoints (prod 2026-06-12 ledger + 2026-06-26 pptx
        # emit-check) — treat both as "not there" rather than raising.
        if response.status_code in (400, 404):
            return None
        response.raise_for_status()
        return (
            response.content,
            response.headers.get("content-type") or mimetypes.guess_type(filename)[0] or "application/octet-stream",
        )
    finally:
        if owns_client:
            http.close()


def download_artifact_object(
    object_path: str,
    *,
    client: httpx.Client | None = None,
) -> tuple[bytes, str] | None:
    """Download bytes from an explicit safe object path in Supabase Storage."""
    normalized_path = normalize_object_path(object_path)
    config = _load_config()
    if config is None:
        return None

    url = _object_url(config, normalized_path)
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
            response.headers.get("content-type") or mimetypes.guess_type(normalized_path)[0] or "application/octet-stream",
        )
    finally:
        if owns_client:
            http.close()


def _is_supabase_missing_object_response(response: httpx.Response) -> bool:
    """Recognize the exact Supabase Storage missing-object response shape.

    Some Supabase Storage deployments have returned HTTP 400 while carrying
    the canonical 404 payload. An arbitrary 400 must still fail closed. The
    error body is consumed only up to a small fixed ceiling and is never
    logged, because provider error bodies can contain sensitive object data.
    """

    if response.status_code == 404:
        return True
    if response.status_code != 400:
        return False

    content_length = response.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > _MAX_STORAGE_ERROR_BODY_BYTES:
                return False
        except ValueError:
            return False

    body = bytearray()
    for chunk in response.iter_bytes():
        if len(body) + len(chunk) > _MAX_STORAGE_ERROR_BODY_BYTES:
            return False
        body.extend(chunk)
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False

    status_code = str(payload.get("statusCode", "")).strip()
    error = str(payload.get("error", "")).strip().casefold().replace("-", "_").replace(" ", "_")
    message = " ".join(str(payload.get("message", "")).strip().casefold().split())
    return status_code == "404" and error == "not_found" and message == "object not found"


def download_artifact_object_bounded(
    object_path: str,
    *,
    max_bytes: int,
    client: httpx.Client | None = None,
) -> tuple[bytes, str] | None:
    """Stream an explicit object while enforcing a decoded-byte ceiling."""

    if not 1 <= max_bytes <= 128 * 1024 * 1024:
        raise ValueError("object read budget must be between 1 byte and 128 MiB")
    normalized_path = normalize_object_path(object_path)
    config = _load_config()
    if config is None:
        return None

    url = _object_url(config, normalized_path)
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
    }
    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        with http.stream("GET", url, headers=headers) as response:
            if _is_supabase_missing_object_response(response):
                return None
            response.raise_for_status()
            content_length = response.headers.get("content-length")
            if content_length is not None:
                try:
                    declared_size = int(content_length)
                except ValueError:
                    declared_size = -1
                if declared_size < 0 or declared_size > max_bytes:
                    raise ArtifactObjectSizeError("remote object exceeds its read budget")
            content = bytearray()
            for chunk in response.iter_bytes():
                if len(content) + len(chunk) > max_bytes:
                    raise ArtifactObjectSizeError("remote object exceeds its read budget")
                content.extend(chunk)
            return (
                bytes(content),
                response.headers.get("content-type") or mimetypes.guess_type(normalized_path)[0] or "application/octet-stream",
            )
    finally:
        if owns_client:
            http.close()


def check_artifact_object_exists(
    object_path: str,
    *,
    client: httpx.Client | None = None,
) -> bool:
    """Return True when an explicit safe object path exists in Supabase Storage."""
    try:
        normalized_path = normalize_object_path(object_path)
    except ValueError:
        return False

    config = _load_config()
    if config is None:
        return False

    url = _object_url(config, normalized_path)
    headers = {
        "Authorization": f"Bearer {config.service_role_key}",
        "apikey": config.service_role_key,
    }

    owns_client = client is None
    http = client or httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS)
    try:
        response = http.head(url, headers=headers)
        # Supabase Storage answers 400 (not only 404) for the missing-object
        # shape on some endpoints — treat both as a benign "no object yet".
        if response.status_code in (400, 404):
            logger.debug(
                "Supabase HEAD: no object yet object_path=%s status=%s",
                normalized_path,
                response.status_code,
            )
            return False
        if not response.is_success:
            logger.warning(
                "Supabase HEAD check failed for object_path=%s status=%s; treating as missing",
                normalized_path,
                response.status_code,
            )
            return False
        return True
    except httpx.HTTPError as exc:
        logger.warning(
            "Supabase HEAD check error for object_path=%s error=%s; treating as missing",
            normalized_path,
            exc,
        )
        return False
    finally:
        if owns_client:
            http.close()


class SupabaseImmutableObjectStore:
    """Supabase-backed implementation of the deck-quality snapshot protocol."""

    def __init__(self, *, client: httpx.Client | None = None) -> None:
        self._client = client

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> Literal["created", "exists"]:
        return create_artifact_object_if_absent(
            object_path,
            content,
            content_type=content_type,
            client=self._client,
        )

    def read(self, object_path: str) -> bytes | None:
        stored = download_artifact_object(object_path, client=self._client)
        return stored[0] if stored is not None else None

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        stored = download_artifact_object_bounded(
            object_path,
            max_bytes=max_bytes,
            client=self._client,
        )
        return stored[0] if stored is not None else None

    def list_prefix(
        self,
        prefix: str,
        *,
        max_objects: int,
        max_depth: int,
    ) -> list[str]:
        return list_artifact_object_paths_bounded(
            prefix,
            max_objects=max_objects,
            max_depth=max_depth,
            client=self._client,
        )

    def list_flat_page(self, prefix: str, *, limit: int) -> list[str]:
        return list_artifact_object_paths_flat_page(
            prefix,
            limit=limit,
            client=self._client,
        )

    def delete_if_present(
        self,
        object_path: str,
    ) -> Literal["deleted", "missing"]:
        return delete_artifact_object_if_present(
            object_path,
            client=self._client,
        )


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
