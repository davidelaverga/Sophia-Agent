"""Gateway endpoints for the builder completion notifier.

Three endpoints:

- ``POST /internal/builder-events`` — accepts a webhook from the LangGraph
  process (``deerflow.sophia.builder_events``) when a sophia_builder task
  reaches a terminal state. Hands the payload to the per-app
  ``BuilderEventsWorker``, which fans it out to webapp SSE subscribers
  and the channel ``MessageBus``.

- ``GET /api/threads/{thread_id}/builder-events`` — Server-Sent Events
  stream for the webapp. Holds the connection open and emits one
  ``data: {...json...}`` line per event delivered to the thread.

- ``GET /api/threads/{thread_id}/builder-events/last`` — late-mount
  recovery. Returns the most recent event for the thread (if still
  inside the worker's TTL window) or ``204 No Content``.

The internal POST is intended for in-cluster traffic only. Production
deployments should bind the gateway to a non-public interface or guard
the path at the reverse proxy.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.gateway.workers.builder_events import get_builder_events_worker

logger = logging.getLogger(__name__)


# ---- Request model ---------------------------------------------------------


class BuilderCompletionEvent(BaseModel):
    """Wire contract for the LangGraph-process webhook.

    Mirrors ``deerflow.sophia.builder_events.build_completion_payload``.
    """

    thread_id: str = Field(..., description="Parent companion thread id.")
    task_id: str = Field(..., description="Subagent / async task id.")
    trace_id: str | None = None
    agent_name: str | None = None
    status: str = Field(..., description="success | error | timeout | cancelled")
    task_type: str | None = None
    task_brief: str | None = None
    artifact_url: str | None = None
    artifact_title: str | None = None
    artifact_type: str | None = None
    artifact_filename: str | None = None
    summary: str | None = None
    user_next_action: str | None = None
    error_message: str | None = None
    completed_at: str | None = None
    source: str | None = Field(None, description="Origin: subagent_executor | async_subagent_monitor")


# ---- Routers ---------------------------------------------------------------


internal_router = APIRouter(prefix="/internal", tags=["builder-events"])
public_router = APIRouter(prefix="/api/threads", tags=["builder-events"])


@internal_router.post(
    "/builder-events",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Receive a builder-completion event from the LangGraph process",
)
async def receive_builder_event(event: BuilderCompletionEvent, request: Request) -> dict[str, Any]:
    """Internal webhook target.

    Accepts the event, hands it to the worker for SSE fan-out, and also
    publishes it onto the channel ``MessageBus`` so Telegram/Slack/Feishu
    adapters can deliver a card to the originating chat.
    """
    payload = event.model_dump()
    worker = get_builder_events_worker(request.app)
    delivered = await worker.publish(payload)

    # Fan out to channel adapters too. Best-effort: never let a channel
    # failure surface to the LangGraph process (which already moved on).
    try:
        from app.channels.message_bus import publish_builder_completion

        await publish_builder_completion(payload)
    except Exception:
        logger.warning(
            "Channel fan-out failed for builder event task_id=%s",
            payload.get("task_id"),
            exc_info=True,
        )

    return {"delivered_subscribers": delivered}


def _format_sse_event(payload: dict[str, Any]) -> bytes:
    """Encode an event for the SSE wire format.

    The webapp listener parses ``event.data`` as JSON. Always emit a
    standard ``data:`` line followed by the required blank line.
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


@public_router.get(
    "/{thread_id}/builder-events",
    summary="Subscribe to builder completion events for a thread (SSE)",
)
async def stream_builder_events(thread_id: str, request: Request) -> StreamingResponse:
    """Hold a long-lived SSE connection and stream events as they arrive.

    The webapp opens this from ``useSessionRouteExperience`` whenever the
    local ``builderTask.status`` is ``queued`` or ``running``. The stream
    closes when the client disconnects or when the gateway shuts down.
    """
    worker = get_builder_events_worker(request.app)

    async def _event_stream():
        async with worker.subscribe(thread_id) as queue:
            # Replay the last event (if any) so a fast-mounting client
            # immediately sees the current state without an extra HTTP
            # round-trip to ``/last``.
            cached = await worker.get_last(thread_id)
            if cached is not None:
                yield _format_sse_event(cached)

            try:
                while True:
                    if await request.is_disconnected():
                        return
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        # Heartbeat keeps proxies / browsers from closing
                        # the connection on idle. SSE comments are valid
                        # and ignored by the EventSource API.
                        yield b": keepalive\n\n"
                        continue
                    yield _format_sse_event(event)
            except asyncio.CancelledError:
                return

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # nginx: don't buffer the stream
        },
    )


@public_router.get(
    "/{thread_id}/builder-events/last",
    summary="Fetch the most recent builder event for a thread (late-mount recovery)",
)
async def last_builder_event(thread_id: str, request: Request) -> Response:
    """Return the cached event or 204 if nothing in the TTL window."""
    worker = get_builder_events_worker(request.app)
    event = await worker.get_last(thread_id)
    if event is None:
        return Response(status_code=204)
    return Response(
        content=json.dumps(event, ensure_ascii=False),
        media_type="application/json",
        status_code=200,
    )
