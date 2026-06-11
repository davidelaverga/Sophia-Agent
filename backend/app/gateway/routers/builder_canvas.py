"""Authenticated Sophia builder-canvas snapshot, stream, and cancel API."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from langgraph_sdk import get_client
from pydantic import BaseModel, Field

from app.gateway.auth import require_authorized_user_scope
from app.gateway.workers.builder_canvas import DEFAULT_TERMINAL_TTL_SECONDS, get_builder_canvas_worker
from deerflow.sophia.builder_failure_diagnostics import merge_builder_failure_diagnostics
from deerflow.sophia.session_store import SessionStore

router = APIRouter(
    prefix="/api/sophia",
    tags=["builder-canvas"],
)

_session_store = SessionStore()
logger = logging.getLogger(__name__)


class BuilderCanvasSnapshot(BaseModel):
    version: int = 1
    active_task: dict[str, Any] | None = None
    recent_events: list[dict[str, Any]] = Field(default_factory=list)


class BuilderCanvasCancelResponse(BaseModel):
    task_id: str
    run_id: str
    status: str
    detail: str


_TERMINAL_CANVAS_STATUSES = {"completed", "failed", "timed_out", "cancelled"}
_TERMINAL_TASK_STATUSES = {
    "success",
    "completed",
    "error",
    "failed",
    "timeout",
    "timed_out",
    "interrupted",
    "cancelled",
}
_MISSING_DELIVERABLE_ERROR = "Builder finished without a deliverable artifact."


def _short_id(value: str | None) -> str | None:
    return value[:12] if value else None


def _langgraph_url() -> str:
    return (
        os.getenv("SOPHIA_LANGGRAPH_BASE_URL")
        or os.getenv("LANGGRAPH_URL")
        or os.getenv("SOPHIA_BACKEND_BASE_URL")
        or "http://127.0.0.1:2024"
    ).strip().rstrip("/")


def _require_thread_owner(authenticated_user_id: str, parent_thread_id: str) -> None:
    if _session_store.find_session_by_thread_id(authenticated_user_id, parent_thread_id) is not None:
        logger.info(
            "Builder canvas route ownership accepted user_id=%s parent_thread_id=%s",
            _short_id(authenticated_user_id),
            _short_id(parent_thread_id),
        )
        return
    logger.warning(
        "Builder canvas route ownership rejected user_id=%s parent_thread_id=%s",
        _short_id(authenticated_user_id),
        _short_id(parent_thread_id),
    )
    raise HTTPException(status_code=404, detail="Thread not found")


async def _parent_builder_tasks(parent_thread_id: str) -> list[dict[str, Any]]:
    client = get_client(url=_langgraph_url())
    try:
        state = await client.threads.get_state(parent_thread_id)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Builder state is unavailable") from exc
    values = state.get("values", {}) if isinstance(state, dict) else {}
    tasks = values.get("async_tasks", {}) if isinstance(values, dict) else {}
    if not isinstance(tasks, dict):
        return []
    return [
        task for task in tasks.values()
        if isinstance(task, dict) and task.get("agent_name") == "sophia_builder"
    ]


def _task_updated_at(task: dict[str, Any]) -> str:
    return str(task.get("last_updated_at") or task.get("updated_at") or task.get("created_at") or "")


def _task_updated_datetime(task: dict[str, Any]) -> datetime | None:
    raw = _task_updated_at(task)
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _is_terminal_task(task: dict[str, Any]) -> bool:
    return str(task.get("status") or "").lower() in _TERMINAL_TASK_STATUSES


def _terminal_task_within_snapshot_ttl(task: dict[str, Any]) -> bool:
    updated_at = _task_updated_datetime(task)
    if updated_at is None:
        return False
    return (datetime.now(UTC) - updated_at).total_seconds() <= DEFAULT_TERMINAL_TTL_SECONDS


def _latest_builder_task(tasks: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not tasks:
        return None
    active_tasks = [task for task in tasks if not _is_terminal_task(task)]
    if active_tasks:
        return max(active_tasks, key=_task_updated_at)
    recent_terminal_tasks = [
        task for task in tasks
        if _terminal_task_within_snapshot_ttl(task)
    ]
    if not recent_terminal_tasks:
        return None
    return max(recent_terminal_tasks, key=_task_updated_at)


def _should_hide_stale_terminal_snapshot(
    task: dict[str, Any],
    *,
    native_status: str,
    recent_events: list[dict[str, Any]],
    task_id: str,
    run_id: str,
) -> bool:
    if native_status not in _TERMINAL_CANVAS_STATUSES:
        return False
    if _terminal_task_within_snapshot_ttl(task):
        return False
    return _retained_terminal_for_run(recent_events, task_id, run_id) is None


async def _authorized_task(parent_thread_id: str, task_id: str, run_id: str) -> dict[str, Any]:
    for task in await _parent_builder_tasks(parent_thread_id):
        if task.get("task_id") == task_id and task.get("run_id") == run_id:
            return task
    raise HTTPException(status_code=404, detail="Builder run not found")


async def _authorized_latest_task(parent_thread_id: str, task_id: str) -> tuple[dict[str, Any], str]:
    matches = [
        task for task in await _parent_builder_tasks(parent_thread_id)
        if task.get("task_id") == task_id and isinstance(task.get("run_id"), str)
    ]
    task = _latest_builder_task(matches)
    if task is None:
        raise HTTPException(status_code=404, detail="Builder run not found")
    return task, str(task["run_id"])


def _map_native_status(status: str | None) -> str:
    return {
        "pending": "running",
        "running": "running",
        "success": "completed",
        "completed": "completed",
        "error": "failed",
        "failed": "failed",
        "timeout": "timed_out",
        "timed_out": "timed_out",
        "interrupted": "cancelled",
        "cancelled": "cancelled",
    }.get(str(status or "").lower(), "running")


def _completion_status(status: str) -> str | None:
    return {
        "completed": "success",
        "failed": "error",
        "timed_out": "timeout",
        "cancelled": "cancelled",
    }.get(status)


_ARTIFACT_PATH_PREFIXES = (
    ("/mnt/user-data/outputs/", lambda value: value[1:]),
    ("mnt/user-data/outputs/", lambda value: value),
    ("/user-data/outputs/", lambda value: f"mnt{value}"),
    ("user-data/outputs/", lambda value: f"mnt/{value}"),
    ("/outputs/", lambda value: f"mnt/user-data{value}"),
    ("outputs/", lambda value: f"mnt/user-data/{value}"),
)


def _canonical_artifact_path(path: Any) -> str | None:
    if not isinstance(path, str):
        return None
    cleaned = path.strip().replace("\\", "/")
    if cleaned.startswith("file://"):
        cleaned = cleaned[len("file://") :]
    if not cleaned:
        return None
    for prefix, canonicalize in _ARTIFACT_PATH_PREFIXES:
        if cleaned.startswith(prefix):
            return canonicalize(cleaned)
    user_data_index = cleaned.find("/user-data/outputs/")
    if user_data_index >= 0:
        return f"mnt{cleaned[user_data_index:]}"
    return cleaned.lstrip("/")


def _relative_output_artifact_path(path: str | None) -> str | None:
    prefix = "mnt/user-data/outputs/"
    if not path or not path.startswith(prefix):
        return None
    relative = path[len(prefix):].strip("/")
    return relative or None


def _signed_artifact_url(thread_id: str, artifact_path: str | None) -> str | None:
    storage_path = _relative_output_artifact_path(artifact_path) or artifact_path
    if not storage_path:
        return None
    try:
        from deerflow.sophia.storage.supabase_artifact_store import create_signed_url

        return create_signed_url(thread_id=thread_id, filename=storage_path)
    except Exception:
        return None


def _artifact_payload_from_task(task: dict[str, Any]) -> dict[str, Any]:
    builder_result = task.get("builder_result")
    if isinstance(builder_result, dict):
        return builder_result
    artifact = task.get("artifact")
    if isinstance(artifact, dict):
        return artifact
    return task


def _artifact_payload_has_deliverable(artifact: dict[str, Any]) -> bool:
    artifact_path = _canonical_artifact_path(artifact.get("artifact_path"))
    artifact_url = artifact.get("artifact_url")
    if isinstance(artifact_url, str) and artifact_url.strip():
        return True
    if artifact_path:
        return True
    return False


def _task_has_deliverable(parent_thread_id: str, task: dict[str, Any]) -> bool:
    return _artifact_payload_has_deliverable(_artifact_payload_from_task(task))


def _thread_id_for_builder_task(task: dict[str, Any]) -> str | None:
    for key in ("thread_id", "task_id"):
        value = task.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _artifact_payload_from_builder_values(values: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("builder_result", "artifact"):
        payload = values.get(key)
        if isinstance(payload, dict) and payload:
            return payload
    return None


async def _builder_thread_artifact_payload(task: dict[str, Any]) -> dict[str, Any] | None:
    builder_thread_id = _thread_id_for_builder_task(task)
    if not builder_thread_id:
        return None
    client = get_client(url=_langgraph_url())
    try:
        state = await client.threads.get_state(builder_thread_id)
    except Exception:
        logger.info(
            "Builder canvas snapshot: builder-thread artifact hydration unavailable task_id=%s run_id=%s",
            _short_id(str(task.get("task_id") or "")),
            _short_id(str(task.get("run_id") or "")),
            exc_info=True,
        )
        return None
    values = state.get("values", {}) if isinstance(state, dict) else {}
    if not isinstance(values, dict):
        return None
    return _artifact_payload_from_builder_values(values)


def _target_artifact_payload_if_exists(parent_thread_id: str, task: dict[str, Any]) -> dict[str, Any] | None:
    artifact_path = _canonical_artifact_path(task.get("artifact_target_path"))
    relative_path = _relative_output_artifact_path(artifact_path)
    if not artifact_path or not relative_path:
        return None
    try:
        from deerflow.sophia.storage.supabase_artifact_store import check_artifact_exists

        exists = check_artifact_exists(parent_thread_id, relative_path)
    except Exception:
        exists = False
    if not exists:
        return None
    return {
        "artifact_path": artifact_path,
        "artifact_type": artifact_path.rsplit(".", 1)[-1] if "." in artifact_path else None,
        "artifact_title": task.get("description") or task.get("task_brief") or "Builder artifact",
    }


async def _hydrate_completed_task_deliverable(
    parent_thread_id: str,
    task: dict[str, Any],
    *,
    native_status: str,
    task_id: str,
    run_id: str,
    recent_events: list[dict[str, Any]],
) -> dict[str, Any]:
    retained_status, retained_completion = _retained_status_and_completion(recent_events, task_id, run_id)
    if (
        native_status != "completed"
        or _task_has_deliverable(parent_thread_id, task)
        or _retained_terminal_status(retained_status, retained_completion) is not None
    ):
        return task

    builder_payload = await _builder_thread_artifact_payload(task)
    if isinstance(builder_payload, dict) and _artifact_payload_has_deliverable(builder_payload):
        logger.info(
            "Builder canvas snapshot: hydrated deliverable from builder thread state parent_thread_id=%s task_id=%s run_id=%s",
            _short_id(parent_thread_id),
            _short_id(task_id),
            _short_id(run_id),
        )
        return {**task, "builder_result": builder_payload}

    target_payload = _target_artifact_payload_if_exists(parent_thread_id, task)
    if isinstance(target_payload, dict):
        logger.info(
            "Builder canvas snapshot: hydrated deliverable from persisted artifact target parent_thread_id=%s task_id=%s run_id=%s",
            _short_id(parent_thread_id),
            _short_id(task_id),
            _short_id(run_id),
        )
        return {**task, "builder_result": target_payload}

    return task


def _retained_terminal_for_run(
    recent_events: list[dict[str, Any]],
    task_id: str,
    run_id: str,
) -> dict[str, Any] | None:
    for event in reversed(recent_events):
        if (
            isinstance(event, dict)
            and event.get("kind") == "terminal"
            and event.get("task_id") == task_id
            and event.get("run_id") == run_id
        ):
            return event
    return None


def _completion_has_deliverable(completion: dict[str, Any] | None) -> bool:
    if not isinstance(completion, dict):
        return False
    for key in ("artifact_path", "artifact_url"):
        value = completion.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False


def _retained_completion_for_run(
    recent_events: list[dict[str, Any]],
    task_id: str,
    run_id: str,
) -> dict[str, Any] | None:
    terminal = _retained_terminal_for_run(recent_events, task_id, run_id)
    completion = terminal.get("completion") if isinstance(terminal, dict) else None
    return completion if isinstance(completion, dict) else None


def _retained_status_and_completion(
    recent_events: list[dict[str, Any]],
    task_id: str,
    run_id: str,
) -> tuple[Any, dict[str, Any] | None]:
    retained_terminal = _retained_terminal_for_run(recent_events, task_id, run_id)
    retained_status = retained_terminal.get("status") if isinstance(retained_terminal, dict) else None
    completion = retained_terminal.get("completion") if isinstance(retained_terminal, dict) else None
    return retained_status, completion if isinstance(completion, dict) else None


def _retained_terminal_status(retained_status: Any, completion: dict[str, Any] | None) -> tuple[str, str | None] | None:
    if retained_status == "completed" and _completion_has_deliverable(completion):
        return "completed", None
    if retained_status in {"failed", "timed_out", "cancelled"}:
        error_message = completion.get("error_message") if isinstance(completion, dict) else None
        return str(retained_status), error_message if isinstance(error_message, str) else None
    return None


def _missing_deliverable_snapshot_status(
    parent_thread_id: str,
    task_id: str,
    run_id: str,
) -> tuple[str, str]:
    logger.warning(
        "Builder canvas snapshot: native success coerced to failed reason=missing_deliverable parent_thread_id=%s task_id=%s run_id=%s",
        _short_id(parent_thread_id),
        _short_id(task_id),
        _short_id(run_id),
    )
    return "failed", _MISSING_DELIVERABLE_ERROR


def _effective_snapshot_status(
    parent_thread_id: str,
    task: dict[str, Any],
    *,
    native_status: str,
    task_id: str,
    run_id: str,
    recent_events: list[dict[str, Any]],
) -> tuple[str, str | None]:
    retained_status, completion = _retained_status_and_completion(recent_events, task_id, run_id)
    terminal_status = _retained_terminal_status(retained_status, completion)
    if terminal_status is not None:
        return terminal_status
    if native_status == "completed" and not _task_has_deliverable(parent_thread_id, task):
        return _missing_deliverable_snapshot_status(parent_thread_id, task_id, run_id)
    return native_status, None


def _completion_artifact_url(parent_thread_id: str, artifact_path: str | None, artifact: dict[str, Any]) -> str | None:
    artifact_url = artifact.get("artifact_url")
    if isinstance(artifact_url, str) and artifact_url.strip():
        return artifact_url
    return _signed_artifact_url(parent_thread_id, artifact_path)


def _completion_completed_at(task: dict[str, Any]) -> str | None:
    completed_at = next(
        (
            task.get(key)
            for key in ("completed_at", "last_updated_at", "updated_at", "created_at")
            if task.get(key)
        ),
        None,
    )
    return completed_at if isinstance(completed_at, str) else None


def _artifact_ext_from_path(path: str | None) -> str | None:
    if not path or "." not in path.rsplit("/", 1)[-1]:
        return None
    return path.rsplit(".", 1)[-1].lower()


def _requested_ext_from_task_or_artifact(task: dict[str, Any], artifact: dict[str, Any]) -> str | None:
    explicit = artifact.get("requested_artifact_ext")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower().lstrip(".")
    target_path = _canonical_artifact_path(task.get("artifact_target_path"))
    return _artifact_ext_from_path(target_path)


def _completion_provenance_path(
    task: dict[str, Any],
    artifact: dict[str, Any],
    key: str,
) -> Any:
    return artifact.get(key) or task.get(key)


def _completion_from_terminal_task(
    parent_thread_id: str,
    task: dict[str, Any],
    *,
    status: str,
    task_id: str,
    run_id: str,
    error_message_override: str | None = None,
) -> dict[str, Any] | None:
    completion_status = _completion_status(status)
    if completion_status is None:
        return None
    artifact = _artifact_payload_from_task(task)
    artifact_path = _canonical_artifact_path(artifact.get("artifact_path"))
    artifact_url = _completion_artifact_url(parent_thread_id, artifact_path, artifact)
    artifact_filename = artifact_path.rsplit("/", 1)[-1] if artifact_path else None
    fallback = _completion_fallback_metadata(task, artifact, artifact_path)
    diagnostics = _completion_failure_diagnostics_from_task(
        parent_thread_id,
        task,
        artifact,
        status=status,
        task_id=task_id,
        run_id=run_id,
        error_message_override=error_message_override,
    )
    completion = {
        "thread_id": parent_thread_id,
        "task_id": task_id,
        "run_id": run_id,
        "trace_id": task.get("trace_id"),
        "agent_name": "sophia_builder",
        "status": completion_status,
        "task_type": task.get("task_type") or artifact.get("artifact_type"),
        "task_brief": task.get("description") or task.get("task_brief"),
        "artifact_path": artifact_path,
        "artifact_url": artifact_url,
        "artifact_title": artifact.get("artifact_title"),
        "artifact_type": artifact.get("artifact_type"),
        "artifact_filename": artifact_filename,
        **fallback,
        "image_generation_status": artifact.get("image_generation_status"),
        "image_generation_reason": artifact.get("image_generation_reason"),
        "image_generation_outcome": artifact.get("image_generation_outcome"),
        "iterations_used": artifact.get("iterations_used"),
        "unmet_conditions": artifact.get("unmet_conditions"),
        "artifact_preview_filename": artifact.get("artifact_preview_filename"),
        "quality_warning": artifact.get("quality_warning"),
        "visuals_missing": artifact.get("visuals_missing"),
        "source_artifact_path": _completion_provenance_path(task, artifact, "source_artifact_path"),
        "revision_of_artifact_path": _completion_provenance_path(task, artifact, "revision_of_artifact_path"),
        "summary": artifact.get("companion_summary") or artifact.get("summary"),
        "user_next_action": artifact.get("user_next_action"),
        "error_message": error_message_override or task.get("error_message") or task.get("error"),
        "completed_at": _completion_completed_at(task),
        "source": "builder_canvas_snapshot",
    }
    if diagnostics:
        completion["builder_failure_diagnostics"] = diagnostics
    return completion


def _completion_failure_diagnostics_from_task(
    parent_thread_id: str,
    task: dict[str, Any],
    artifact: dict[str, Any],
    *,
    status: str,
    task_id: str,
    run_id: str,
    error_message_override: str | None,
) -> dict[str, Any] | None:
    current = artifact.get("builder_failure_diagnostics") or task.get("builder_failure_diagnostics")
    current_diag = current if isinstance(current, dict) else None
    if status == "failed" and error_message_override == _MISSING_DELIVERABLE_ERROR:
        updates: dict[str, Any] = {
            "task_id": task_id,
            "run_id": run_id,
            "thread_id": task_id,
            "parent_thread_id": parent_thread_id,
            "trace_id": task.get("trace_id"),
            "task_type": task.get("task_type") or artifact.get("artifact_type"),
            "failure_stage": "completion_reconciliation",
            "failure_reason": _MISSING_DELIVERABLE_ERROR,
            "failure_code": "builder_completed_without_deliverable",
            "canvas_reconciliation_action": "coerced_success_to_failed_no_deliverable",
        }
        if not current_diag or "emit_attempted" not in current_diag:
            updates["emit_attempted"] = False
        return merge_builder_failure_diagnostics(current_diag, **updates)
    return merge_builder_failure_diagnostics(current_diag) if current_diag else None


def _completion_fallback_metadata(
    task: dict[str, Any],
    artifact: dict[str, Any],
    artifact_path: str | None,
) -> dict[str, Any]:
    requested_artifact_ext = _requested_ext_from_task_or_artifact(task, artifact)
    artifact_ext = _completion_artifact_ext(artifact, artifact_path)
    artifact_is_fallback = _completion_artifact_is_fallback(
        artifact,
        requested_artifact_ext=requested_artifact_ext,
        artifact_ext=artifact_ext,
    )
    return {
        "requested_artifact_ext": requested_artifact_ext,
        "artifact_ext": artifact_ext,
        "artifact_is_fallback": artifact_is_fallback,
        "fallback_reason": _completion_fallback_reason(
            artifact,
            artifact_is_fallback=artifact_is_fallback,
            requested_artifact_ext=requested_artifact_ext,
        ),
    }


def _completion_artifact_ext(artifact: dict[str, Any], artifact_path: str | None) -> str | None:
    explicit = artifact.get("artifact_ext")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower().lstrip(".")
    return _artifact_ext_from_path(artifact_path)


def _completion_artifact_is_fallback(
    artifact: dict[str, Any],
    *,
    requested_artifact_ext: str | None,
    artifact_ext: str | None,
) -> bool:
    explicit = artifact.get("artifact_is_fallback")
    if explicit is not None:
        return bool(explicit)
    return bool(requested_artifact_ext and artifact_ext and artifact_ext != requested_artifact_ext)


def _completion_fallback_reason(
    artifact: dict[str, Any],
    *,
    artifact_is_fallback: bool,
    requested_artifact_ext: str | None,
) -> str | None:
    fallback_reason = artifact.get("fallback_reason")
    if isinstance(fallback_reason, str):
        return fallback_reason
    if artifact_is_fallback:
        return f"{requested_artifact_ext}_generation_not_completed" if requested_artifact_ext else "fallback_deliverable"
    return None


async def _read_native_run_status_for_client(client: Any, task_id: str, run_id: str) -> str | None:
    try:
        run = await client.runs.get(task_id, run_id)
    except Exception:
        return None
    raw_status = run.get("status") if isinstance(run, dict) else None
    return _map_native_status(str(raw_status)) if raw_status else None


async def _native_run_status_for_client(client: Any, task_id: str, run_id: str, fallback: str | None) -> str:
    status = await _read_native_run_status_for_client(client, task_id, run_id)
    if status is None:
        return _map_native_status(fallback)
    return status


async def _native_run_status(task_id: str, run_id: str, fallback: str | None) -> str:
    client = get_client(url=_langgraph_url())
    return await _native_run_status_for_client(client, task_id, run_id, fallback)


def _cancel_detail_for_status(status: str) -> str:
    return {
        "completed": "Builder already finished before cancellation could be applied.",
        "failed": "Builder already stopped with an error before cancellation could be applied.",
        "timed_out": "Builder already timed out before cancellation could be applied.",
        "cancelled": "Builder was already cancelled.",
        "running": "Builder cancellation was requested.",
    }.get(status, "Builder was cancelled before finishing the deliverable.")


def _cancelled_async_task_payload(
    task: dict[str, Any] | None,
    *,
    task_id: str,
    run_id: str,
    completed_at: str,
) -> dict[str, Any]:
    payload = dict(task or {})
    payload.update(
        {
            "task_id": task_id,
            "run_id": run_id,
            "agent_name": payload.get("agent_name") or "sophia_builder",
            "status": "cancelled",
            "error_message": payload.get("error_message") or "Builder was cancelled by the user.",
            "completed_at": completed_at,
            "last_checked_at": completed_at,
            "last_updated_at": completed_at,
            "updated_at": completed_at,
        }
    )
    return payload


async def _persist_cancelled_builder_task(
    client: Any,
    *,
    parent_thread_id: str,
    task_id: str,
    run_id: str,
    task: dict[str, Any] | None,
    completed_at: str,
) -> None:
    try:
        await client.threads.update_state(
            parent_thread_id,
            {
                "async_tasks": {
                    task_id: _cancelled_async_task_payload(
                        task,
                        task_id=task_id,
                        run_id=run_id,
                        completed_at=completed_at,
                    )
                }
            },
        )
    except Exception as exc:
        logger.exception(
            "Builder canvas cancel failed to persist parent async task: parent_thread_id=%s task_id=%s run_id=%s",
            _short_id(parent_thread_id),
            _short_id(task_id),
            _short_id(run_id),
        )
        raise HTTPException(status_code=503, detail="Builder cancellation state could not be persisted") from exc


def _format_sse(payload: dict[str, Any]) -> bytes:
    event_id = str(payload.get("event_id") or "")
    return f"id: {event_id}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _cancel_builder_run(
    parent_thread_id: str,
    task_id: str,
    run_id: str,
    request: Request,
    fallback_status: str | None = None,
    task: dict[str, Any] | None = None,
) -> BuilderCanvasCancelResponse:
    client = get_client(url=_langgraph_url())
    current_status = await _native_run_status_for_client(client, task_id, run_id, fallback_status)
    if current_status in _TERMINAL_CANVAS_STATUSES:
        return BuilderCanvasCancelResponse(
            task_id=task_id,
            run_id=run_id,
            status=current_status,
            detail=_cancel_detail_for_status(current_status),
        )
    try:
        await client.runs.cancel(task_id, run_id, wait=True, action="interrupt")
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Builder cancellation is unavailable") from exc
    final_status = await _read_native_run_status_for_client(client, task_id, run_id)
    if final_status is not None and final_status != "cancelled":
        return BuilderCanvasCancelResponse(
            task_id=task_id,
            run_id=run_id,
            status=final_status,
            detail=_cancel_detail_for_status(final_status),
        )
    completed_at = datetime.now(UTC).isoformat()
    await _persist_cancelled_builder_task(
        client,
        parent_thread_id=parent_thread_id,
        task_id=task_id,
        run_id=run_id,
        task=task,
        completed_at=completed_at,
    )
    worker = get_builder_canvas_worker(request.app)
    await worker.publish_completion(
        {
            "thread_id": parent_thread_id,
            "task_id": task_id,
            "run_id": run_id,
            "status": "cancelled",
            "completed_at": completed_at,
        }
    )
    return BuilderCanvasCancelResponse(
        task_id=task_id,
        run_id=run_id,
        status="cancelled",
        detail="Builder was cancelled before finishing the deliverable.",
    )


@router.get(
    "/{user_id}/threads/{parent_thread_id}/builder-canvas/snapshot",
    response_model=BuilderCanvasSnapshot,
)
async def builder_canvas_snapshot(
    user_id: str,
    parent_thread_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authorized_user_scope),
) -> BuilderCanvasSnapshot:
    _require_thread_owner(authenticated_user_id, parent_thread_id)
    worker = get_builder_canvas_worker(request.app)
    task = _latest_builder_task(await _parent_builder_tasks(parent_thread_id))
    recent_events = await worker.recent_events(parent_thread_id)
    worker_summary = await worker.active_summary(parent_thread_id)
    if task is None:
        logger.info(
            "Builder canvas snapshot served user_id=%s parent_thread_id=%s active_task_present=%s recent_events=%s worker_subscribers=%s",
            _short_id(authenticated_user_id),
            _short_id(parent_thread_id),
            False,
            len(recent_events),
            worker_summary.get("subscriber_count"),
        )
        return BuilderCanvasSnapshot(recent_events=recent_events)
    task_id = task.get("task_id")
    run_id = task.get("run_id")
    if not isinstance(task_id, str) or not isinstance(run_id, str):
        logger.info(
            "Builder canvas snapshot served user_id=%s parent_thread_id=%s active_task_present=%s valid_identity=%s recent_events=%s worker_subscribers=%s",
            _short_id(authenticated_user_id),
            _short_id(parent_thread_id),
            True,
            False,
            len(recent_events),
            worker_summary.get("subscriber_count"),
        )
        return BuilderCanvasSnapshot(recent_events=recent_events)
    native_status = await _native_run_status(task_id, run_id, task.get("status"))
    if _should_hide_stale_terminal_snapshot(
        task,
        native_status=native_status,
        recent_events=recent_events,
        task_id=task_id,
        run_id=run_id,
    ):
        logger.info(
            "Builder canvas snapshot suppressed stale terminal task user_id=%s parent_thread_id=%s task_id=%s run_id=%s native_status=%s recent_events=%s worker_subscribers=%s",
            _short_id(authenticated_user_id),
            _short_id(parent_thread_id),
            _short_id(task_id),
            _short_id(run_id),
            native_status,
            len(recent_events),
            worker_summary.get("subscriber_count"),
        )
        return BuilderCanvasSnapshot(recent_events=recent_events)
    task = await _hydrate_completed_task_deliverable(
        parent_thread_id,
        task,
        native_status=native_status,
        task_id=task_id,
        run_id=run_id,
        recent_events=recent_events,
    )
    status, error_message_override = _effective_snapshot_status(
        parent_thread_id,
        task,
        native_status=native_status,
        task_id=task_id,
        run_id=run_id,
        recent_events=recent_events,
    )
    latest_activity = await worker.latest_activity(parent_thread_id, task_id, run_id)
    active_task = {
        "parent_thread_id": parent_thread_id,
        "task_id": task_id,
        "run_id": run_id,
        "status": status,
        **({"latest_activity": latest_activity} if latest_activity else {}),
    }
    retained_completion = _retained_completion_for_run(recent_events, task_id, run_id)
    if status == "completed" and _completion_has_deliverable(retained_completion):
        completion = retained_completion
    else:
        completion = _completion_from_terminal_task(
            parent_thread_id,
            task,
            status=status,
            task_id=task_id,
            run_id=run_id,
            error_message_override=error_message_override,
        )
    if completion is not None:
        active_task["completion"] = completion
    logger.info(
        "Builder canvas snapshot served user_id=%s parent_thread_id=%s active_task_present=%s task_id=%s run_id=%s status=%s recent_events=%s worker_retained_events=%s worker_subscribers=%s has_completion=%s",
        _short_id(authenticated_user_id),
        _short_id(parent_thread_id),
        True,
        _short_id(task_id),
        _short_id(run_id),
        status,
        len(recent_events),
        worker_summary.get("retained_event_count"),
        worker_summary.get("subscriber_count"),
        completion is not None,
    )
    return BuilderCanvasSnapshot(active_task=active_task, recent_events=recent_events)


@router.get("/{user_id}/threads/{parent_thread_id}/builder-canvas/events")
async def stream_builder_canvas_events(
    user_id: str,
    parent_thread_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authorized_user_scope),
) -> StreamingResponse:
    _require_thread_owner(authenticated_user_id, parent_thread_id)
    worker = get_builder_canvas_worker(request.app)
    last_event_id = request.headers.get("last-event-id")
    worker_summary = await worker.active_summary(parent_thread_id)
    logger.info(
        "Builder canvas events opening user_id=%s parent_thread_id=%s last_event_id=%s active_task_id=%s active_run_id=%s retained_events=%s subscriber_count=%s",
        _short_id(authenticated_user_id),
        _short_id(parent_thread_id),
        _short_id(last_event_id),
        _short_id(worker_summary.get("active_task_id")),
        _short_id(worker_summary.get("active_run_id")),
        worker_summary.get("retained_event_count"),
        worker_summary.get("subscriber_count"),
    )

    async def _events():
        async with worker.subscribe(parent_thread_id) as queue:
            replay_events = await worker.replay_after(parent_thread_id, last_event_id)
            logger.info(
                "Builder canvas events replay user_id=%s parent_thread_id=%s replay_count=%s last_event_id=%s",
                _short_id(authenticated_user_id),
                _short_id(parent_thread_id),
                len(replay_events),
                _short_id(last_event_id),
            )
            for event in replay_events:
                yield _format_sse(event)
            while True:
                if await request.is_disconnected():
                    logger.info(
                        "Builder canvas events disconnected user_id=%s parent_thread_id=%s",
                        _short_id(authenticated_user_id),
                        _short_id(parent_thread_id),
                    )
                    return
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    yield b": keepalive\n\n"
                    continue
                yield _format_sse(event)

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/{user_id}/threads/{parent_thread_id}/builder-canvas/tasks/{task_id}/runs/{run_id}/cancel",
    response_model=BuilderCanvasCancelResponse,
)
async def cancel_builder_canvas_task(
    user_id: str,
    parent_thread_id: str,
    task_id: str,
    run_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authorized_user_scope),
) -> BuilderCanvasCancelResponse:
    _require_thread_owner(authenticated_user_id, parent_thread_id)
    task = await _authorized_task(parent_thread_id, task_id, run_id)
    fallback_status = task.get("status") if isinstance(task.get("status"), str) else None
    return await _cancel_builder_run(parent_thread_id, task_id, run_id, request, fallback_status, task)


@router.post(
    "/{user_id}/threads/{parent_thread_id}/builder-canvas/tasks/{task_id}/cancel",
    response_model=BuilderCanvasCancelResponse,
)
async def cancel_latest_builder_canvas_task_run(
    user_id: str,
    parent_thread_id: str,
    task_id: str,
    request: Request,
    authenticated_user_id: str = Depends(require_authorized_user_scope),
) -> BuilderCanvasCancelResponse:
    _require_thread_owner(authenticated_user_id, parent_thread_id)
    task, run_id = await _authorized_latest_task(parent_thread_id, task_id)
    fallback_status = task.get("status") if isinstance(task.get("status"), str) else None
    return await _cancel_builder_run(parent_thread_id, task_id, run_id, request, fallback_status, task)
