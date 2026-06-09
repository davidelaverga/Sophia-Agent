"""Sanitized diagnostics for terminal Builder failures.

This module intentionally serializes only allowlisted metadata. It must never
emit raw artifact text, HTML, frames, comments, environment values, tokens, or
signed URLs.
"""

from __future__ import annotations

import logging
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal

logger = logging.getLogger(__name__)

BUILDER_FAILURE_DIAGNOSTICS_SCHEMA = "builder_failure_diagnostics_v1"
OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
MAX_OUTPUT_SUMMARY_FILES = 50
_HTML_MIN_BYTES = 64
_PPTX_MIN_BYTES = 1024
_PPTX_REQUIRED_ZIP_ENTRIES = frozenset({
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
})

FailureStage = Literal[
    "generation",
    "emit_attempted",
    "emit_rejected",
    "artifact_missing",
    "validation_failed",
    "completion_reconciliation",
    "storage_mirror",
    "unknown",
]

MirrorResult = Literal[
    "not_configured",
    "skipped",
    "uploaded",
    "failed_best_effort",
    "signed_url_created",
    "signed_url_failed",
]

_ALLOWED_DIAGNOSTIC_KEYS = frozenset({
    "schema",
    "task_id",
    "run_id",
    "thread_id",
    "parent_thread_id",
    "user_id",
    "trace_id",
    "task_type",
    "target_path",
    "target_extension",
    "failure_stage",
    "failure_reason",
    "failure_code",
    "emit_attempted",
    "emit_tool_call_seen",
    "sanitized_emit_args",
    "outputs_summary",
    "artifact_target_path",
    "artifact_target_exists",
    "artifact_target_integrity_status",
    "supabase_mirror_attempted",
    "supabase_mirror_result",
    "signed_url_created",
    "completion_webhook_attempted",
    "completion_webhook_result",
    "canvas_reconciliation_action",
    "raw_content_excluded",
    "raw_artifact_text_excluded",
    "raw_frame_excluded",
    "secrets_excluded",
    # Provider-fallback snapshot (Builder OpenAI fallback). Values come
    # exclusively from ``builder_provider_fallback.provider_fallback_snapshot``
    # — fixed template strings + booleans, never key material or raw
    # provider payloads.
    "primary_provider",
    "fallback_provider",
    "fallback_enabled",
    "fallback_attempted",
    "fallback_reason",
    "fallback_result",
    "fallback_model_configured",
    "provider_error_class",
    "provider_error_safe_message",
    "raw_provider_payload_excluded",
    "provider_secrets_excluded",
})

# Keys copied from ``state["builder_provider_fallback"]`` into failure
# diagnostics. Subset of ``_ALLOWED_DIAGNOSTIC_KEYS`` by construction.
_PROVIDER_FALLBACK_KEYS = frozenset({
    "primary_provider",
    "fallback_provider",
    "fallback_enabled",
    "fallback_attempted",
    "fallback_reason",
    "fallback_result",
    "fallback_model_configured",
    "provider_error_class",
    "provider_error_safe_message",
    "raw_provider_payload_excluded",
    "provider_secrets_excluded",
})

_UNSAFE_KEY_MARKERS = (
    "content",
    "html",
    "artifact_text",
    "raw",
    "frame",
    "comment",
    "token",
    "secret",
    "service_role",
    "service-role",
    "apikey",
    "api_key",
    "signedurl",
    "signed_url",
    "artifact_url",
    "url",
    "env",
)


@dataclass(slots=True)
class BuilderFailureDiagnostics:
    task_id: str | None = None
    run_id: str | None = None
    thread_id: str | None = None
    parent_thread_id: str | None = None
    user_id: str | None = None
    trace_id: str | None = None
    task_type: str | None = None
    target_path: str | None = None
    target_extension: str | None = None
    failure_stage: FailureStage = "unknown"
    failure_reason: str = "Builder failure could not be classified."
    failure_code: str | None = None
    emit_attempted: bool = False
    emit_tool_call_seen: bool | None = None
    sanitized_emit_args: dict[str, Any] | None = None
    outputs_summary: list[dict[str, Any]] = field(default_factory=list)
    artifact_target_path: str | None = None
    artifact_target_exists: bool | None = None
    artifact_target_integrity_status: str | None = None
    supabase_mirror_attempted: bool | None = None
    supabase_mirror_result: str | None = None
    signed_url_created: bool | None = None
    completion_webhook_attempted: bool | None = None
    completion_webhook_result: str | None = None
    canvas_reconciliation_action: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema": BUILDER_FAILURE_DIAGNOSTICS_SCHEMA,
            "failure_stage": self.failure_stage,
            "failure_reason": _safe_reason(self.failure_reason),
            "emit_attempted": bool(self.emit_attempted),
            "raw_content_excluded": True,
            "raw_artifact_text_excluded": True,
            "raw_frame_excluded": True,
            "secrets_excluded": True,
        }
        optional = {
            "task_id": self.task_id,
            "run_id": self.run_id,
            "thread_id": self.thread_id,
            "parent_thread_id": self.parent_thread_id,
            "user_id": self.user_id,
            "trace_id": self.trace_id,
            "task_type": self.task_type,
            "target_path": self.target_path,
            "target_extension": self.target_extension,
            "failure_code": self.failure_code,
            "emit_tool_call_seen": self.emit_tool_call_seen,
            "sanitized_emit_args": self.sanitized_emit_args,
            "outputs_summary": self.outputs_summary,
            "artifact_target_path": self.artifact_target_path,
            "artifact_target_exists": self.artifact_target_exists,
            "artifact_target_integrity_status": self.artifact_target_integrity_status,
            "supabase_mirror_attempted": self.supabase_mirror_attempted,
            "supabase_mirror_result": self.supabase_mirror_result,
            "signed_url_created": self.signed_url_created,
            "completion_webhook_attempted": self.completion_webhook_attempted,
            "completion_webhook_result": self.completion_webhook_result,
            "canvas_reconciliation_action": self.canvas_reconciliation_action,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        return sanitize_diagnostic_payload(payload)


def build_builder_failure_diagnostics(
    *,
    state: dict[str, Any] | None = None,
    runtime: Any = None,
    artifact_args: dict[str, Any] | None = None,
    failure_stage: FailureStage = "unknown",
    failure_reason: str = "Builder failure could not be classified.",
    failure_code: str | None = None,
    emit_attempted: bool = False,
    emit_tool_call_seen: bool | None = None,
    outputs_host_path: str | None = None,
    include_outputs_summary: bool = True,
    artifact_target_path: Any = None,
    supabase_mirror_attempted: bool | None = None,
    supabase_mirror_result: str | None = None,
    signed_url_created: bool | None = None,
    completion_webhook_attempted: bool | None = None,
    completion_webhook_result: str | None = None,
    canvas_reconciliation_action: str | None = None,
) -> dict[str, Any]:
    """Build a best-effort sanitized diagnostic payload."""

    try:
        state_dict = state if isinstance(state, dict) else {}
        outputs_root = _outputs_root(outputs_host_path or _outputs_host_path_from_state(state_dict))
        target = artifact_target_path or _target_path_from_state(state_dict)
        safe_target = safe_output_path(target, outputs_root=outputs_root)
        target_exists, target_integrity = _target_status(safe_target, outputs_root)
        diagnostic = BuilderFailureDiagnostics(
            task_id=_runtime_thread_id(runtime),
            run_id=_runtime_run_id(runtime),
            thread_id=_runtime_thread_id(runtime),
            parent_thread_id=_parent_thread_id(state_dict),
            user_id=_user_id(state_dict),
            trace_id=_trace_id(runtime),
            task_type=_task_type(state_dict),
            target_path=safe_target,
            target_extension=_extension(safe_target),
            failure_stage=failure_stage,
            failure_reason=failure_reason,
            failure_code=failure_code,
            emit_attempted=emit_attempted,
            emit_tool_call_seen=emit_tool_call_seen,
            sanitized_emit_args=sanitize_emit_args(artifact_args, outputs_root=outputs_root)
            if isinstance(artifact_args, dict)
            else None,
            outputs_summary=summarize_outputs(outputs_root) if include_outputs_summary else [],
            artifact_target_path=safe_target,
            artifact_target_exists=target_exists,
            artifact_target_integrity_status=target_integrity,
            supabase_mirror_attempted=supabase_mirror_attempted,
            supabase_mirror_result=supabase_mirror_result,
            signed_url_created=signed_url_created,
            completion_webhook_attempted=completion_webhook_attempted,
            completion_webhook_result=completion_webhook_result,
            canvas_reconciliation_action=canvas_reconciliation_action,
        )
        payload = diagnostic.to_payload()
        provider_snapshot = _provider_fallback_fields(state_dict)
        if provider_snapshot:
            payload = merge_builder_failure_diagnostics(payload, **provider_snapshot)
        return payload
    except Exception:  # pragma: no cover - diagnostics must never fail Builder
        logger.debug("Builder failure diagnostics construction failed", exc_info=True)
        return BuilderFailureDiagnostics(
            failure_stage=failure_stage,
            failure_reason="Builder failure diagnostics construction failed safely.",
            failure_code=failure_code or "diagnostics_unavailable",
            emit_attempted=emit_attempted,
            emit_tool_call_seen=emit_tool_call_seen,
        ).to_payload()


def merge_builder_failure_diagnostics(
    current: dict[str, Any] | None,
    **updates: Any,
) -> dict[str, Any]:
    payload = sanitize_diagnostic_payload(current or {})
    payload.update({key: value for key, value in updates.items() if value is not None})
    return sanitize_diagnostic_payload(payload)


def sanitize_diagnostic_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}
    sanitized: dict[str, Any] = {
        "schema": BUILDER_FAILURE_DIAGNOSTICS_SCHEMA,
        "raw_content_excluded": True,
        "raw_artifact_text_excluded": True,
        "raw_frame_excluded": True,
        "secrets_excluded": True,
    }
    for key in _ALLOWED_DIAGNOSTIC_KEYS:
        if key in sanitized or key not in payload:
            continue
        value = payload.get(key)
        if value is None:
            continue
        sanitized[key] = _sanitize_allowed_value(key, value)
    sanitized["schema"] = BUILDER_FAILURE_DIAGNOSTICS_SCHEMA
    return sanitized


def sanitize_emit_args(
    args: dict[str, Any] | None,
    *,
    outputs_root: Path | None = None,
) -> dict[str, Any] | None:
    if not isinstance(args, dict):
        return None
    sanitized: dict[str, Any] = {}
    artifact_path = safe_output_path(args.get("artifact_path"), outputs_root=outputs_root)
    if artifact_path:
        sanitized["artifact_path"] = artifact_path
    artifact_type = _safe_scalar(args.get("artifact_type"))
    if artifact_type:
        sanitized["artifact_type"] = artifact_type
    artifact_title = _safe_scalar(args.get("artifact_title"))
    if artifact_title:
        sanitized["artifact_title"] = artifact_title[:160]
    supporting = args.get("supporting_files")
    if isinstance(supporting, list):
        paths = [
            safe_path
            for item in supporting[:MAX_OUTPUT_SUMMARY_FILES]
            if (safe_path := safe_output_path(item, outputs_root=outputs_root))
        ]
        sanitized["supporting_files"] = {
            "count": len(supporting),
            "paths": paths,
        }
    source_artifact_path = safe_output_path(args.get("source_artifact_path"), outputs_root=outputs_root)
    if source_artifact_path:
        sanitized["source_artifact_path"] = source_artifact_path
    revision_path = safe_output_path(args.get("revision_of_artifact_path"), outputs_root=outputs_root)
    if revision_path:
        sanitized["revision_of_artifact_path"] = revision_path
    confidence = args.get("confidence")
    if isinstance(confidence, (int, float)):
        sanitized["confidence"] = float(confidence)
    elif isinstance(confidence, str):
        try:
            sanitized["confidence"] = float(confidence)
        except ValueError:
            pass
    return sanitized


def summarize_outputs(
    outputs_root: Path | str | None,
    *,
    limit: int = MAX_OUTPUT_SUMMARY_FILES,
) -> list[dict[str, Any]]:
    root = _outputs_root(outputs_root)
    if root is None:
        return []
    try:
        files = [entry for entry in root.rglob("*") if entry.is_file()]
    except OSError:
        logger.debug("Builder diagnostics outputs scan failed root=%s", root, exc_info=True)
        return []
    files.sort(key=lambda entry: (_safe_mtime(entry), entry.as_posix()))
    summary: list[dict[str, Any]] = []
    for entry in files[: max(limit, 0)]:
        item = output_file_summary(entry, root)
        if item is not None:
            summary.append(item)
    return summary


def output_file_summary(entry: Path, outputs_root: Path) -> dict[str, Any] | None:
    try:
        relative = entry.resolve().relative_to(outputs_root.resolve()).as_posix()
    except (OSError, ValueError):
        return None
    if not _safe_relative_path(relative):
        return None
    try:
        stat = entry.stat()
    except OSError:
        return {
            "relative_path": relative,
            "extension": _extension(relative),
            "size_bytes": 0,
            "mtime": None,
            "exists": False,
        }
    item = {
        "relative_path": relative,
        "extension": _extension(relative),
        "size_bytes": int(stat.st_size),
        "mtime": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
        "exists": True,
    }
    integrity = _integrity_status(entry)
    if integrity:
        item["integrity_status"] = integrity
    return item


def safe_output_path(value: Any, *, outputs_root: Path | None = None) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip().replace("\\", "/")
    if not cleaned or _looks_like_url(cleaned):
        return None
    if "?" in cleaned:
        cleaned = cleaned.split("?", 1)[0]
    if "#" in cleaned:
        cleaned = cleaned.split("#", 1)[0]
    if cleaned.startswith("file://"):
        cleaned = cleaned[len("file://") :]

    relative = _relative_from_virtual_path(cleaned)
    if relative:
        return relative

    if outputs_root is not None:
        try:
            relative_to_root = Path(cleaned).resolve().relative_to(outputs_root.resolve()).as_posix()
        except (OSError, ValueError):
            relative_to_root = None
        if relative_to_root and _safe_relative_path(relative_to_root):
            return relative_to_root

    marker = "/outputs/"
    marker_index = cleaned.find(marker)
    if marker_index >= 0:
        tail = cleaned[marker_index + len(marker) :]
        if _safe_relative_path(tail):
            return tail

    if _safe_relative_path(cleaned):
        return cleaned.strip("/")
    return None


def normalize_emit_failure_code(reason: str | None, *, is_supporting_file: bool = False) -> str:
    if is_supporting_file:
        return "supporting_file_missing"
    if reason is None:
        return "unknown_emit_validation_error"
    raw = str(reason).strip().lower()
    if "traversal" in raw or "/../" in raw or raw.endswith("/.."):
        return "artifact_path_traversal"
    if "not_under_outputs" in raw or "outside_outputs" in raw or "path_not_under_outputs" in raw:
        return "artifact_path_outside_outputs"
    if raw.startswith("html_invalid_artifact_extension"):
        return "html_invalid_artifact_extension"
    if raw == "html_markdown_fence":
        return "html_markdown_fence"
    if raw == "html_escaped":
        return "html_escaped_as_text"
    if raw in {
        "html_too_small",
        "html_missing_document_root",
        "html_missing_body",
        "html_not_utf8",
        "html_internal_filename",
        "html_read_failed",
    }:
        return "html_missing_standalone_structure"
    if raw in {"html_artifact_missing", "html_fallback_missing", "missing"}:
        return "artifact_file_missing"
    if raw.startswith("pdf_"):
        return "pdf_integrity_failed"
    if raw.startswith("pptx_"):
        return "pptx_integrity_failed"
    if raw in {"artifact_file_missing", "supporting_file_missing"}:
        return raw
    return "unknown_emit_validation_error"


def diagnostic_safe_failure_message(code: str | None, reason: str | None = None) -> str:
    messages = {
        "artifact_file_missing": "Builder failed: artifact file was missing.",
        "supporting_file_missing": "Builder failed: a supporting file was missing.",
        "builder_completed_without_deliverable": "Builder finished without a deliverable artifact.",
        "html_invalid_artifact_extension": (
            "Builder rejected HTML output because it was not a standalone .html file."
        ),
        "html_markdown_fence": "Builder rejected HTML output because it was wrapped in Markdown fences.",
        "html_escaped_as_text": "Builder rejected HTML output because HTML was escaped as text.",
        "html_missing_standalone_structure": (
            "Builder rejected HTML output because it was not a standalone HTML document."
        ),
        "artifact_path_outside_outputs": "Builder rejected the artifact path because it was outside outputs.",
        "artifact_path_traversal": "Builder rejected the artifact path because it contained path traversal.",
        "pdf_integrity_failed": "Builder rejected PDF output because integrity validation failed.",
        "pptx_integrity_failed": "Builder rejected PPTX output because integrity validation failed.",
    }
    if code in messages:
        return messages[code]
    return _safe_reason(reason or "Builder failed before a deliverable artifact could be verified.")


def _sanitize_allowed_value(key: str, value: Any) -> Any:
    if key in {"sanitized_emit_args"}:
        return value if isinstance(value, dict) else None
    if key == "outputs_summary":
        return _sanitize_outputs_summary(value)
    if key in {
        "emit_attempted",
        "emit_tool_call_seen",
        "artifact_target_exists",
        "supabase_mirror_attempted",
        "signed_url_created",
        "completion_webhook_attempted",
        "raw_content_excluded",
        "raw_artifact_text_excluded",
        "raw_frame_excluded",
        "secrets_excluded",
        "fallback_enabled",
        "fallback_attempted",
        "fallback_model_configured",
        "raw_provider_payload_excluded",
        "provider_secrets_excluded",
    }:
        return bool(value)
    if key in {"failure_reason", "provider_error_safe_message"}:
        return _safe_reason(value)
    if key.endswith("_path") or key in {"target_path"}:
        return safe_output_path(value)
    return _safe_scalar(value)


def _sanitize_outputs_summary(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    sanitized: list[dict[str, Any]] = []
    for item in value[:MAX_OUTPUT_SUMMARY_FILES]:
        if not isinstance(item, dict):
            continue
        relative_path = safe_output_path(item.get("relative_path"))
        if not relative_path:
            continue
        sanitized.append({
            "relative_path": relative_path,
            "extension": _safe_scalar(item.get("extension")) or _extension(relative_path),
            "size_bytes": _safe_int(item.get("size_bytes")),
            "mtime": _safe_scalar(item.get("mtime")),
            "exists": bool(item.get("exists")),
            **(
                {"integrity_status": _safe_scalar(item.get("integrity_status"))}
                if item.get("integrity_status") is not None
                else {}
            ),
        })
    return sanitized


def _safe_reason(value: Any) -> str:
    text = _safe_scalar(value) or "Builder failure could not be classified."
    if _looks_like_url(text) or any(marker in text.lower() for marker in ("service_role", "api_key", "token=")):
        return "Builder failure reason was excluded because it contained sensitive data."
    return text[:240]


def _safe_scalar(value: Any) -> str | None:
    if not isinstance(value, str):
        if isinstance(value, (int, float, bool)):
            return str(value)
        return None
    text = value.strip()
    if not text:
        return None
    if _looks_like_url(text):
        return None
    lowered = text.lower()
    if lowered.startswith(("<!doctype", "<html", "```", "&lt;!doctype", "&lt;html")):
        return None
    if any(marker in lowered for marker in ("service_role", "service-role", "api_key", "apikey", "token=")):
        return None
    return text


def _safe_int(value: Any) -> int:
    return int(value) if isinstance(value, int) and value >= 0 else 0


def _provider_fallback_fields(state: dict[str, Any]) -> dict[str, Any]:
    """Allowlisted provider-fallback fields from state, for diagnostics merge.

    Reads the sanitized snapshot the ``BuilderProviderFallbackMiddleware``
    wrote into ``state["builder_provider_fallback"]``. Only
    ``_PROVIDER_FALLBACK_KEYS`` survive; values are re-sanitized by
    ``merge_builder_failure_diagnostics`` at the call site.
    """
    snapshot = state.get("builder_provider_fallback")
    if not isinstance(snapshot, dict) or not snapshot:
        return {}
    return {
        key: snapshot.get(key)
        for key in _PROVIDER_FALLBACK_KEYS
        if snapshot.get(key) is not None
    }


def _outputs_host_path_from_state(state: dict[str, Any]) -> str | None:
    thread_data = state.get("thread_data")
    if isinstance(thread_data, dict):
        outputs_path = thread_data.get("outputs_path")
        return outputs_path if isinstance(outputs_path, str) and outputs_path.strip() else None
    return None


def _outputs_root(value: Path | str | None) -> Path | None:
    if isinstance(value, Path):
        candidate = value
    elif isinstance(value, str) and value.strip():
        candidate = Path(value)
    else:
        return None
    try:
        return candidate.resolve() if candidate.is_dir() else None
    except (OSError, ValueError):
        return None


def _target_path_from_state(state: dict[str, Any]) -> Any:
    builder_task = state.get("builder_task")
    if isinstance(builder_task, dict):
        return builder_task.get("artifact_target_path") or builder_task.get("target_path")
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        return delegation.get("artifact_target_path") or delegation.get("target_path")
    legacy_target = state.get("builder_artifact_target_path")
    if isinstance(legacy_target, str) and legacy_target.strip():
        return legacy_target
    return None


def _target_status(safe_target: str | None, outputs_root: Path | None) -> tuple[bool | None, str | None]:
    if not safe_target or outputs_root is None:
        return None, None
    path = outputs_root / safe_target
    try:
        exists = path.is_file()
    except OSError:
        return False, None
    return exists, _integrity_status(path) if exists else None


def _parent_thread_id(state: dict[str, Any]) -> str | None:
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        value = delegation.get("parent_thread_id")
        return value if isinstance(value, str) and value.strip() else None
    return None


def _user_id(state: dict[str, Any]) -> str | None:
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        value = delegation.get("parent_user_id") or delegation.get("user_id")
        return value if isinstance(value, str) and value.strip() else None
    return None


def _task_type(state: dict[str, Any]) -> str | None:
    builder_task = state.get("builder_task")
    if isinstance(builder_task, dict):
        value = builder_task.get("task_type")
        if isinstance(value, str) and value.strip():
            return value
    delegation = state.get("delegation_context")
    if isinstance(delegation, dict):
        value = delegation.get("task_type")
        return value if isinstance(value, str) and value.strip() else None
    return None


def _trace_id(runtime: Any) -> str | None:
    config = getattr(runtime, "config", None)
    metadata = config.get("metadata") if isinstance(config, dict) else None
    value = metadata.get("trace_id") if isinstance(metadata, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def _runtime_thread_id(runtime: Any) -> str | None:
    info = getattr(runtime, "execution_info", None)
    value = getattr(info, "thread_id", None) if info is not None else None
    if isinstance(value, str) and value.strip():
        return value
    context = getattr(runtime, "context", None)
    value = context.get("thread_id") if isinstance(context, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def _runtime_run_id(runtime: Any) -> str | None:
    info = getattr(runtime, "execution_info", None)
    value = getattr(info, "run_id", None) if info is not None else None
    if isinstance(value, str) and value.strip():
        return value
    context = getattr(runtime, "context", None)
    value = context.get("run_id") if isinstance(context, dict) else None
    return value if isinstance(value, str) and value.strip() else None


def _relative_from_virtual_path(cleaned: str) -> str | None:
    prefixes = (
        OUTPUTS_VIRTUAL_PREFIX,
        "mnt/user-data/outputs/",
        "/user-data/outputs/",
        "user-data/outputs/",
        "/outputs/",
        "outputs/",
    )
    for prefix in prefixes:
        if cleaned.startswith(prefix):
            relative = cleaned[len(prefix) :].strip("/")
            return relative if _safe_relative_path(relative) else None
    return None


def _safe_relative_path(value: str | None) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    cleaned = value.strip().replace("\\", "/")
    if _looks_like_url(cleaned):
        return False
    pure = PurePosixPath(cleaned)
    return (
        not pure.is_absolute()
        and ".." not in pure.parts
        and ":" not in cleaned.split("/", 1)[0]
    )


def _looks_like_url(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith(("http://", "https://", "supabase://"))


def _extension(path: str | None) -> str | None:
    suffix = PurePosixPath(str(path or "")).suffix.lower().lstrip(".")
    return suffix or None


def _safe_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _integrity_status(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in {".html", ".htm"}:
        return _html_integrity_status(path)
    if suffix == ".pdf":
        return _pdf_integrity_status(path)
    if suffix == ".pptx":
        return _pptx_integrity_status(path)
    return None


def _html_integrity_status(path: Path) -> str:
    try:
        content = path.read_bytes()[:8192]
    except OSError:
        return "html_read_failed"
    if len(content) < _HTML_MIN_BYTES:
        return "html_too_small"
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return "html_not_utf8"
    lowered = text.lstrip("\ufeff \t\r\n").lower()
    if lowered.startswith("```"):
        return "html_markdown_fence"
    if lowered.startswith("&lt;!doctype") or lowered.startswith("&lt;html"):
        return "html_escaped_as_text"
    if "<html" not in lowered and "<!doctype html" not in lowered:
        return "html_missing_standalone_structure"
    if "<body" not in lowered:
        return "html_missing_standalone_structure"
    return "valid"


def _pdf_integrity_status(path: Path) -> str:
    try:
        header = path.read_bytes()[:5]
    except OSError:
        return "pdf_read_failed"
    return "valid" if header == b"%PDF-" else "pdf_integrity_failed"


def _pptx_integrity_status(path: Path) -> str:
    try:
        size = path.stat().st_size
    except OSError:
        return "pptx_read_failed"
    if size < _PPTX_MIN_BYTES:
        return "pptx_too_small"
    try:
        with zipfile.ZipFile(path) as archive:
            entries = set(archive.namelist())
    except (OSError, zipfile.BadZipFile):
        return "pptx_integrity_failed"
    missing = sorted(_PPTX_REQUIRED_ZIP_ENTRIES - entries)
    if missing:
        return "pptx_integrity_failed"
    return "valid"
