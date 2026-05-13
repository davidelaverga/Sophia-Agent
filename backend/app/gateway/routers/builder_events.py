"""Gateway endpoints for the builder completion notifier.

Four endpoints:

- ``POST /internal/builder-events`` — accepts a webhook from the LangGraph
  process (``deerflow.sophia.builder_events``) when a sophia_builder task
  reaches a terminal state. Hands the payload to the per-app
  ``BuilderEventsWorker``, which fans it out to webapp SSE subscribers
  and the channel ``MessageBus``.

- ``POST /internal/builder-dispatched`` — Stage 2B kick-off signal. The
  LangGraph process fires this immediately after ``start_builder_task``
  creates a builder thread/run via ASGI in-process transport. The
  gateway spawns a ``consume_builder_stream`` task (join-existing mode)
  so registered chat-relay sinks (e.g. the EI bot relay) can render
  live progress while the build runs. No-op when
  ``BUILDER_LIVE_STREAM_ENABLED`` is off.

- ``GET /api/threads/{thread_id}/builder-events`` — Server-Sent Events
  stream for the webapp. Holds the connection open and emits one
  ``data: {...json...}`` line per event delivered to the thread.

- ``GET /api/threads/{thread_id}/builder-events/last`` — late-mount
  recovery. Returns the most recent event for the thread (if still
  inside the worker's TTL window) or ``204 No Content``.

The internal POSTs are intended for in-cluster traffic only. Production
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

from app.gateway.builder_events import get_fanout
from app.gateway.builder_events.adapters import webhook_payload_to_event
from app.gateway.builder_events.flags import is_live_stream_enabled
from app.gateway.builder_events.stream_consumer import consume_builder_stream
from app.gateway.workers.builder_events import get_builder_events_worker
from app.gateway.workers.companion_wakeup import get_companion_wakeup_or_none

logger = logging.getLogger(__name__)


# ---- Request model ---------------------------------------------------------


class BuilderCompletionEvent(BaseModel):
    """Wire contract for the LangGraph-process webhook.

    Mirrors ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``.

    ``thread_id`` is the parent companion thread when Builder is a
    subagent (companion → ``start_builder_task`` dispatch), and ``None``
    in Builder-as-main mode (Work bot DM). Downstream consumers handle
    null correctly: the SSE worker drops null-keyed events with a
    warning (no webapp for Work bot anyway), the MessageBus channel
    subscribers find no match (Work bot runs don't belong to other
    channels), the companion wakeup worker skips (no companion to
    wake), and the BuilderEventFanout adapter maps null →
    ``BuilderEvent.parent_thread_id=None`` and uses ``task_id`` for the
    canonical ``BuilderEvent.thread_id``.
    """

    thread_id: str | None = Field(
        None,
        description="Parent companion thread id; null in Builder-as-main mode.",
    )
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
        description="Originating user id, used by the companion wakeup worker to construct a properly-attributed synthetic turn.",
    )


class BuilderDispatchedSignal(BaseModel):
    """Wire contract for the Stage 2B "builder dispatched" kick-off.

    Fired by ``start_builder_task`` (LangGraph process) immediately after
    it creates a builder thread + run via ASGI in-process transport. The
    gateway uses this to spin up a stream consumer in join-existing mode
    so registered chat-relay sinks can render live progress in
    companion's originating chat (e.g. EI bot DM) while the build runs.
    """

    builder_thread_id: str = Field(..., description="The builder's LangGraph thread id (used as task_id in webhook payloads).")
    parent_thread_id: str = Field(..., description="Companion's thread id — the chat where progress should be rendered.")
    user_id: str = Field(..., description="Originating user id.")
    run_id: str = Field(..., description="The builder run id, for join_stream attachment.")
    trace_id: str | None = None
    assistant_id: str = Field("sophia_builder", description="LangGraph assistant id for the builder graph.")


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

    # Additive: publish the same terminal event to the BuilderEventFanout
    # so registered sinks (TraceSink, Stage-2 chat relays, etc.) can act
    # on it. Existing worker.publish / publish_builder_completion /
    # wakeup.wake calls above stay in place — fanout is layered on top,
    # not replacing them. See plan §Stage 1A.
    try:
        await get_fanout().publish(webhook_payload_to_event(payload))
    except Exception:
        logger.warning(
            "BuilderEventFanout publish failed for task_id=%s",
            payload.get("task_id"),
            exc_info=True,
        )

    return {"delivered_subscribers": delivered}


def _resolve_langgraph_client():
    """Return a ``langgraph_sdk`` client pointed at the langgraph service.

    Reused by the dispatch-signal endpoint to spawn a stream consumer that
    joins the existing builder run. We pull the URL off the channel
    service so a single source of truth (``manager._langgraph_url``)
    drives both inbound channel adapters and gateway-internal consumers.
    """
    from langgraph_sdk import get_client

    try:
        from app.channels.service import get_channel_service

        service = get_channel_service()
        langgraph_url = (
            getattr(getattr(service, "manager", None), "_langgraph_url", None)
            if service is not None
            else None
        )
    except Exception:
        langgraph_url = None
    return get_client(url=langgraph_url or "http://localhost:2024")


@internal_router.post(
    "/builder-dispatched",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Stage 2B kick-off — attach a stream consumer to a companion-dispatched builder run",
)
async def receive_builder_dispatched(signal: BuilderDispatchedSignal) -> dict[str, Any]:
    """Spawn a fire-and-forget stream consumer for the just-created run.

    No-op when ``BUILDER_LIVE_STREAM_ENABLED`` is off — start_builder_task
    fires this every dispatch, but the gateway only starts consuming when
    the flag is on. Errors here are swallowed: the existing webhook +
    blocking ``check_async_task`` flow remains the user-facing fallback
    so a missed consumer never breaks completion delivery.
    """
    if not is_live_stream_enabled():
        logger.debug(
            "builder-dispatched: live stream disabled — skipping consumer (builder_thread_id=%s)",
            signal.builder_thread_id,
        )
        return {"accepted": False, "reason": "live_stream_disabled"}

    lg_client = _resolve_langgraph_client()

    asyncio.create_task(
        consume_builder_stream(
            lg_client=lg_client,
            builder_thread_id=signal.builder_thread_id,
            parent_thread_id=signal.parent_thread_id,
            user_id=signal.user_id,
            trace_id=signal.trace_id or signal.builder_thread_id[:8],
            assistant_id=signal.assistant_id,
            run_id=signal.run_id,
        ),
        name=f"builder-stream-{signal.builder_thread_id}",
    )

    logger.info(
        "builder-dispatched: spawned stream consumer builder_thread_id=%s parent_thread_id=%s user_id=%s run_id=%s",
        signal.builder_thread_id,
        signal.parent_thread_id,
        signal.user_id,
        signal.run_id,
    )
    return {"accepted": True}


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
