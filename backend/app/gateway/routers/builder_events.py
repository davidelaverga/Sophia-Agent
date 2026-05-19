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
from app.gateway.workers.companion_wakeup import get_companion_wakeup_or_none

logger = logging.getLogger(__name__)


# Strong references to in-flight background tasks scheduled by
# ``receive_builder_event``. ``asyncio.create_task`` without an external
# reference is technically GC-collectable while still running; this set
# pins them until done (v3-migration learning #4). Bounded by the rate
# at which the builder fires completion webhooks (~1 per task,
# infrequent). Each task self-discards via ``add_done_callback``.
#
# Phase 4K (cherry-picked from abandoned PR #125 commit ``4ea5c657``):
# PR #128 branched off ``main`` BEFORE the fire-and-forget fix landed
# on the PR #125 branch, so the synchronous-await pattern that triggers
# ``httpx.ReadTimeout`` on every artifact-bearing run came back. The
# LangGraph-side daemon thread that POSTs here gives up after
# ``_WEBHOOK_TIMEOUT_SECONDS`` (10s in builder_events.py). Heavy
# downstream work — bot artifact delivery via the channel bus,
# companion wakeup — runs as background tasks so this handler
# responds in ~milliseconds.
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


async def _fan_out_to_channels(payload: dict[str, Any]) -> None:
    """Best-effort artifact delivery via the channel MessageBus.

    Heavy: the EI bot's ``_on_builder_completion`` awaits ``mark_done``
    (under the per-task ``asyncio.Lock`` added by codex P1 ``b9eeb7c3``),
    then downloads the artifact from Supabase + uploads to Telegram
    (5-15s for real documents). Runs as a background task so the
    webhook handler returns fast.
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
        logger.warning(
            "drain_background_tasks: timed out waiting for %d task(s)",
            len(pending),
        )


# ---- Request model ---------------------------------------------------------


class BuilderCompletionEvent(BaseModel):
    """Wire contract for the LangGraph-process webhook.

    Mirrors ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``.
    """

    thread_id: str = Field(..., description="Parent companion thread id.")
    task_id: str = Field(..., description="Subagent / async task id.")
    run_id: str | None = Field(
        None,
        description=(
            "LangGraph run id of the terminating run. Phase 4I post-review "
            "(codex P1): plumbed through so ``_on_builder_completion`` can "
            "pass it to ``BuilderProgressRegistry.mark_done`` / ``mark_stopped`` "
            "for run-id matching — a delayed terminal from a previous run "
            "(interrupted via ``update_async_task``) must NOT close the new "
            "run's placeholder. Optional for back-compat with any in-flight "
            "payload from a pre-4I langgraph deploy."
        ),
    )
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


class BuilderProgressEvent(BaseModel):
    """Wire contract for the LangGraph-side ``BuilderProgressMiddleware`` webhook.

    Phase 4H (webhook relay): replaces the ``runs.join_stream`` HTTP
    subscriber path that doesn't work cross-process against
    ``langgraph dev``'s in-mem runtime. The middleware POSTs one
    payload per phase transition (or per AI message with tool_calls);
    the endpoint dispatches it through the per-task ``ProgressRenderer``
    and calls the channel's edit callback to update the placeholder.

    ``event_name`` matches the renderer's ``apply`` API:
    - ``"custom"`` with ``data={"name": "phase", "phase": "<phase>"}``
      for lifecycle transitions (starting / researching / drafting /
      finalizing / done).
    - ``"updates"`` with ``data={"agent": {"messages": [{"tool_calls": [...]}]}}``
      for tool-call activity lines (🔍 / 🔗 / 📝 / 📦).
    - ``"messages"`` / ``"messages-tuple"`` reserved for future per-
      token streaming if we move to a runtime that supports it.
    """

    task_id: str = Field(..., description="Builder thread_id / subagent task id.")
    run_id: str = Field(..., description="LangGraph run id (for diagnostics).")
    event_name: str = Field(..., description="messages | updates | custom")
    data: Any | None = Field(
        default=None, description="Mode-specific payload — see class docstring."
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
    ``deerflow.sophia.builder_events``). Heavy downstream work — channel
    fan-out (artifact delivery via the bus → ``_on_builder_completion``)
    and companion wakeup — runs as background tasks so this handler
    responds in ~milliseconds and the daemon thread never times out.
    Each task swallows its own errors; failures land on the gateway
    logs but never echo back to the builder process (which already
    moved on).

    The synchronous step kept inline is ``worker.publish(payload)`` —
    the legacy SSE pub/sub for the webapp completion card. It only
    enqueues to in-memory subscribers, so it returns in microseconds.

    Phase 4K (cherry-picked from abandoned PR #125 commit ``4ea5c657``):
    fix-and-forget restored. PR #128 inherited the pre-4ea5c657
    synchronous-await state from main; this commit restores the
    pattern that PR #125 had landed on May 14.
    """
    payload = event.model_dump()
    worker = get_builder_events_worker(request.app)
    delivered = await worker.publish(payload)

    # Channel fan-out → background. The bus subscriber chain
    # (``_on_builder_completion``) takes 5-15s for real artifact
    # uploads; awaiting it inline would block the langgraph daemon
    # thread past its webhook timeout.
    bg = asyncio.create_task(_fan_out_to_channels(payload))
    _BACKGROUND_TASKS.add(bg)
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


@internal_router.post(
    "/builder-progress",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Receive a progress event from the builder middleware",
)
async def receive_builder_progress(event: BuilderProgressEvent) -> dict[str, Any]:
    """Internal webhook for builder phase / tool-call events.

    The langgraph-side ``BuilderProgressMiddleware`` POSTs one of
    these per lifecycle hook (``before_agent``, ``after_model`` with
    relevant tool_calls, ``after_agent``). The gateway-side registry
    dispatches the event through the per-task ``ProgressRenderer``
    and edits the Telegram placeholder via the channel's edit
    callback. See ``app/gateway/builder_progress/registry.py`` for
    the full flow.

    Phase 4H (webhook relay) replaces the ``runs.join_stream`` HTTP
    consumer that doesn't work cross-process against the
    ``langgraph_runtime_inmem`` backend.

    Best-effort: any registry failure is logged and swallowed so the
    builder never blocks waiting on the gateway. The 202 response
    means "accepted for relay" — NOT "successfully edited".
    """
    from app.gateway.builder_progress import get_progress_registry

    registry = get_progress_registry()
    try:
        applied = await registry.apply_event(
            task_id=event.task_id,
            event_name=event.event_name,
            data=event.data,
            # Codex P1 (post-Phase-4H review): pass run_id so the
            # registry can drop in-flight POSTs from an obsoleted run
            # (interrupted via ``update_async_task``).
            run_id=event.run_id,
        )
    except Exception:
        logger.warning(
            "Builder-progress relay failed task_id=%s event=%s",
            event.task_id,
            event.event_name,
            exc_info=True,
        )
        applied = False
    return {"applied": applied}


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
