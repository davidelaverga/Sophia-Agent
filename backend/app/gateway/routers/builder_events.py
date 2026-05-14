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

from app.gateway.builder_events.fanout import get_builder_event_fanout_or_none
from app.gateway.workers.builder_events import get_builder_events_worker
from app.gateway.workers.companion_wakeup import get_companion_wakeup_or_none

logger = logging.getLogger(__name__)


# Strong references to in-flight background tasks scheduled by
# ``receive_builder_event``. asyncio.create_task without an external
# reference is technically GC-collectable while still running; this set
# pins them until done. Bounded by the rate at which the builder fires
# completion webhooks (~1 per task, infrequent).
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


async def _fan_out_to_channels(payload: dict[str, Any]) -> None:
    """Best-effort artifact delivery via the channel MessageBus.

    Heavy: the EI bot's ``_on_builder_completion`` downloads the artifact
    from Supabase and uploads it to Telegram (5-15s for real documents).
    Run as a background task so the webhook handler returns fast.
    """
    try:
        from app.channels.message_bus import publish_builder_completion

        await publish_builder_completion(payload)
    except Exception:
        logger.warning(
            "Channel fan-out failed for builder event task_id=%s",
            payload.get("task_id"),
            exc_info=True,
        )


async def _publish_to_fanout(fanout: Any, payload: dict[str, Any], origin: str) -> None:
    """Best-effort terminal-event publish to the BuilderEventFanout."""
    try:
        await fanout.publish_terminal(payload, channel_origin=origin)
    except Exception:
        logger.warning(
            "BuilderEventFanout terminal publish failed for task_id=%s",
            payload.get("task_id"),
            exc_info=True,
        )


async def drain_background_tasks(*, timeout: float = 30.0) -> None:
    """Wait for all in-flight webhook background tasks to finish.

    Test utility. Production callers don't need this — the runtime keeps
    tasks alive on the event loop until they complete on their own. The
    fire-and-forget pattern means the webhook handler can't be observed
    via the response, so tests need an explicit drain point.
    """
    if not _BACKGROUND_TASKS:
        return
    pending = list(_BACKGROUND_TASKS)
    if not pending:
        return
    try:
        await asyncio.wait_for(
            asyncio.gather(*pending, return_exceptions=True),
            timeout=timeout,
        )
    except TimeoutError:
        logger.warning("drain_background_tasks: timed out waiting for %d task(s)", len(pending))


# ---- Request model ---------------------------------------------------------


class BuilderCompletionEvent(BaseModel):
    """Wire contract for the LangGraph-process webhook.

    Mirrors ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``.
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
    user_id: str | None = Field(
        None,
        description="Originating user id, used by the companion wakeup worker to "
        "construct a properly-attributed synthetic turn.",
    )
    channel_origin: str | None = Field(
        None,
        description="Channel that originated the companion turn (telegram | web | voice). "
        "Used by the BuilderEventFanout's terminal-webhook adapter to gate sinks. "
        "When absent, falls back to 'telegram' for backward-compat with PR #120 payloads.",
    )


# ---- Routers ---------------------------------------------------------------


internal_router = APIRouter(prefix="/internal", tags=["builder-events"])
public_router = APIRouter(prefix="/api/threads", tags=["builder-events"])


@internal_router.post(
    "/builder-events",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Receive a builder-completion event from the LangGraph process",
)
async def receive_builder_event(event: BuilderCompletionEvent, request: Request) -> dict[str, Any]:
    """Internal webhook target — return fast, deliver async.

    The langgraph-side daemon thread that posts here gives up after a
    short HTTP timeout (see ``_WEBHOOK_TIMEOUT_SECONDS`` in
    ``deerflow.sophia.builder_events``). Heavy downstream work — bot
    artifact delivery via the channel bus, fanout terminal sinks,
    companion wakeup — is dispatched as background tasks so this
    handler responds in ~milliseconds and the daemon thread never
    times out. Each task swallows its own errors; failures land on
    the gateway logs but never echo back to the builder process,
    which already moved on.

    The synchronous step kept inline is ``worker.publish(payload)`` —
    the legacy SSE pub/sub for the webapp completion card. It only
    enqueues to in-memory subscribers, so it returns in microseconds.
    """
    payload = event.model_dump()
    worker = get_builder_events_worker(request.app)
    delivered = await worker.publish(payload)

    # Schedule heavy work off the request path. The asyncio runtime
    # keeps these tasks alive even after the response returns; they
    # complete on the gateway's event loop. Holding strong references
    # so the GC doesn't drop a still-running task.
    fanout = get_builder_event_fanout_or_none(request.app)
    background_tasks: list[asyncio.Task[Any]] = []

    background_tasks.append(asyncio.create_task(_fan_out_to_channels(payload)))
    if fanout is not None:
        origin = payload.get("channel_origin") or "telegram"
        background_tasks.append(
            asyncio.create_task(_publish_to_fanout(fanout, payload, origin))
        )
    _BACKGROUND_TASKS.update(background_tasks)
    for bg in background_tasks:
        bg.add_done_callback(_BACKGROUND_TASKS.discard)

    # Trigger a synthetic companion turn so Sophia proactively surfaces
    # the artifact in chat without the user having to send another
    # message. Fire-and-forget: ``wake()`` swallows its own errors and
    # the user's existing turn-driven adoption flow remains the
    # fallback. See ``app/gateway/workers/companion_wakeup.py``.
    #
    # Use the ``_or_none`` lookup so test fixtures that install only the
    # SSE worker don't get a noisy warning on every webhook POST.
    wakeup = get_companion_wakeup_or_none(request.app)
    if wakeup is not None:
        try:
            asyncio.create_task(wakeup.wake(payload))
        except Exception:
            logger.warning(
                "Companion wakeup scheduling failed for builder event task_id=%s",
                payload.get("task_id"),
                exc_info=True,
            )

    return {"delivered_subscribers": delivered}


def _format_sse_event(payload: dict[str, Any]) -> bytes:
    """Encode an event for the SSE wire format.

    The webapp listener parses ``event.data`` as JSON. Always emit a
    standard ``data:`` line followed by the required blank line.
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


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
                    except TimeoutError:
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
