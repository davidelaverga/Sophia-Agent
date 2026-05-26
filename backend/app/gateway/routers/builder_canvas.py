"""Authenticated Sophia builder-canvas snapshot, stream, and cancel API."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from langgraph_sdk import get_client
from pydantic import BaseModel, Field

from app.gateway.auth import require_authorized_user_scope
from app.gateway.workers.builder_canvas import get_builder_canvas_worker
from deerflow.sophia.session_store import SessionStore

router = APIRouter(
    prefix="/api/sophia",
    tags=["builder-canvas"],
    dependencies=[Depends(require_authorized_user_scope)],
)

_session_store = SessionStore()


class BuilderCanvasSnapshot(BaseModel):
    version: int = 1
    active_task: dict[str, Any] | None = None
    recent_events: list[dict[str, Any]] = Field(default_factory=list)


class BuilderCanvasCancelResponse(BaseModel):
    task_id: str
    run_id: str
    status: str
    detail: str


_TERMINAL_CANVAS_STATUSES = {"completed", "failed", "cancelled"}


def _langgraph_url() -> str:
    return (
        os.getenv("SOPHIA_LANGGRAPH_BASE_URL")
        or os.getenv("SOPHIA_BACKEND_BASE_URL")
        or "http://127.0.0.1:2024"
    ).strip().rstrip("/")


def _require_thread_owner(user_id: str, parent_thread_id: str) -> None:
    if _session_store.find_session_by_thread_id(user_id, parent_thread_id) is not None:
        return
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


def _latest_builder_task(tasks: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not tasks:
        return None
    return max(
        tasks,
        key=lambda task: str(task.get("last_updated_at") or task.get("updated_at") or task.get("created_at") or ""),
    )


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
        "timeout": "failed",
        "timed_out": "failed",
        "interrupted": "cancelled",
        "cancelled": "cancelled",
    }.get(str(status or "").lower(), "running")


async def _native_run_status_for_client(client: Any, task_id: str, run_id: str, fallback: str | None) -> str:
    try:
        run = await client.runs.get(task_id, run_id)
    except Exception:
        return _map_native_status(fallback)
    raw_status = run.get("status") if isinstance(run, dict) else None
    return _map_native_status(str(raw_status) if raw_status else fallback)


async def _native_run_status(task_id: str, run_id: str, fallback: str | None) -> str:
    client = get_client(url=_langgraph_url())
    return await _native_run_status_for_client(client, task_id, run_id, fallback)


def _cancel_detail_for_status(status: str) -> str:
    return {
        "completed": "Builder already finished before cancellation could be applied.",
        "failed": "Builder already stopped with an error before cancellation could be applied.",
        "cancelled": "Builder was already cancelled.",
        "running": "Builder cancellation was requested.",
    }.get(status, "Builder was cancelled before finishing the deliverable.")


def _format_sse(payload: dict[str, Any]) -> bytes:
    event_id = str(payload.get("event_id") or "")
    return f"id: {event_id}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _cancel_builder_run(
    parent_thread_id: str,
    task_id: str,
    run_id: str,
    request: Request,
    fallback_status: str | None = None,
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
    final_status = await _native_run_status_for_client(client, task_id, run_id, current_status)
    if final_status != "cancelled":
        return BuilderCanvasCancelResponse(
            task_id=task_id,
            run_id=run_id,
            status=final_status,
            detail=_cancel_detail_for_status(final_status),
        )
    worker = get_builder_canvas_worker(request.app)
    await worker.publish_completion(
        {
            "thread_id": parent_thread_id,
            "task_id": task_id,
            "run_id": run_id,
            "status": "cancelled",
            "completed_at": datetime.now(UTC).isoformat(),
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
) -> BuilderCanvasSnapshot:
    _require_thread_owner(user_id, parent_thread_id)
    worker = get_builder_canvas_worker(request.app)
    task = _latest_builder_task(await _parent_builder_tasks(parent_thread_id))
    recent_events = await worker.recent_events(parent_thread_id)
    if task is None:
        return BuilderCanvasSnapshot(recent_events=recent_events)
    task_id = task.get("task_id")
    run_id = task.get("run_id")
    if not isinstance(task_id, str) or not isinstance(run_id, str):
        return BuilderCanvasSnapshot(recent_events=recent_events)
    status = await _native_run_status(task_id, run_id, task.get("status"))
    latest_activity = await worker.latest_activity(parent_thread_id, task_id, run_id)
    active_task = {
        "parent_thread_id": parent_thread_id,
        "task_id": task_id,
        "run_id": run_id,
        "status": status,
        **({"latest_activity": latest_activity} if latest_activity else {}),
    }
    return BuilderCanvasSnapshot(active_task=active_task, recent_events=recent_events)


@router.get("/{user_id}/threads/{parent_thread_id}/builder-canvas/events")
async def stream_builder_canvas_events(
    user_id: str,
    parent_thread_id: str,
    request: Request,
) -> StreamingResponse:
    _require_thread_owner(user_id, parent_thread_id)
    worker = get_builder_canvas_worker(request.app)
    last_event_id = request.headers.get("last-event-id")

    async def _events():
        async with worker.subscribe(parent_thread_id) as queue:
            for event in await worker.replay_after(parent_thread_id, last_event_id):
                yield _format_sse(event)
            while True:
                if await request.is_disconnected():
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
) -> BuilderCanvasCancelResponse:
    _require_thread_owner(user_id, parent_thread_id)
    task = await _authorized_task(parent_thread_id, task_id, run_id)
    fallback_status = task.get("status") if isinstance(task.get("status"), str) else None
    return await _cancel_builder_run(parent_thread_id, task_id, run_id, request, fallback_status)


@router.post(
    "/{user_id}/threads/{parent_thread_id}/builder-canvas/tasks/{task_id}/cancel",
    response_model=BuilderCanvasCancelResponse,
)
async def cancel_latest_builder_canvas_task_run(
    user_id: str,
    parent_thread_id: str,
    task_id: str,
    request: Request,
) -> BuilderCanvasCancelResponse:
    _require_thread_owner(user_id, parent_thread_id)
    task, run_id = await _authorized_latest_task(parent_thread_id, task_id)
    fallback_status = task.get("status") if isinstance(task.get("status"), str) else None
    return await _cancel_builder_run(parent_thread_id, task_id, run_id, request, fallback_status)
