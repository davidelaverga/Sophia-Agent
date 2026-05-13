"""Gateway-side stream consumer for Builder runs.

Spawned per Builder run by:

- ``TelegramWorkChannel._dispatch_build`` (Stage 2A — Work bot main mode)
  when ``BUILDER_LIVE_STREAM_ENABLED`` is true.
- ``/internal/builder-dispatched`` endpoint (Stage 2B — companion subagent
  mode) when ``BuildAwarenessMiddleware`` notifies the gateway of a new
  builder task.

The consumer drives ``langgraph_sdk`` ``runs.stream``, converts each
``StreamPart`` via :mod:`app.gateway.builder_events.adapters`, and
publishes events to the process-wide :class:`BuilderEventFanout`.

Lifecycle:

- One ``asyncio.Task`` per run, named ``builder-stream-{thread_id}``.
- Lives until the stream ends naturally or a global timeout fires
  (30 min default — matches the Builder hard ceiling).
- On stream end, waits ``_WEBHOOK_GRACE_SECONDS`` for the LangGraph
  process's ``fire_completion_webhook_from_artifact`` POST to arrive.
  If it does, fanout's per-thread terminal flag drops the
  consumer-synthesised terminal as the loser of the race (the webhook
  carries richer artifact metadata). If not, the consumer publishes a
  best-effort synthetic terminal so chat surfaces aren't left dangling.

Failures inside the consumer never propagate — the task logs and exits.
Callers don't need to await it; the only reason to keep a reference is
to ``cancel()`` it on gateway shutdown (handled by the lifespan).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.gateway.builder_events import get_fanout
from app.gateway.builder_events.adapters import (
    StreamAdapterState,
    stream_part_to_events,
)
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


# Wait this long after stream end for the LangGraph webhook to arrive
# with the canonical terminal event before synthesising one.
_WEBHOOK_GRACE_SECONDS = 5.0

# Hard ceiling on consumer lifetime — matches Builder's run-timeout.
_CONSUMER_TIMEOUT_SECONDS = 30 * 60

# Bounded reconnect for join-mode consumers when the stream FINs without
# a terminal arriving (the langgraph-restart class of silent failure
# observed in production 2026-05-13: the SSE connection closed cleanly
# while the build was still grinding for another 35 minutes on the
# freshly-restarted langgraph service, and the gateway consumer just
# exited). Each reconnect re-attaches via ``runs.join_stream`` so we
# resume getting events without losing the run.
_RECONNECT_MAX_ATTEMPTS = 3
_RECONNECT_BACKOFF_SECONDS = (1.0, 3.0, 7.0)


async def consume_builder_stream(
    *,
    lg_client: Any,
    builder_thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    assistant_id: str = "sophia_builder",
    run_input: dict[str, Any] | None = None,
    run_id: str | None = None,
    run_config: dict[str, Any] | None = None,
    run_context: dict[str, Any] | None = None,
    fanout=None,
    webhook_grace_seconds: float = _WEBHOOK_GRACE_SECONDS,
    consumer_timeout_seconds: float = _CONSUMER_TIMEOUT_SECONDS,
    reconnect_max_attempts: int = _RECONNECT_MAX_ATTEMPTS,
    reconnect_backoffs: tuple[float, ...] = _RECONNECT_BACKOFF_SECONDS,
) -> None:
    """Subscribe to a Builder run's stream and publish events to fanout.

    Two modes selected by which argument is provided:

    - **Create-and-stream** (``run_input`` provided, ``run_id`` ignored).
      Calls ``client.runs.stream(thread_id, assistant_id, input=...)``
      which creates AND streams the run in one call. Use this from the
      Work bot path where the consumer owns the run lifecycle.
    - **Join-existing-stream** (``run_id`` provided, ``run_input`` is
      ``None``). Calls ``client.runs.join_stream(thread_id, run_id)``
      to attach to an already-created run's output. Used from the
      Stage 2B companion-dispatch path where ``start_builder_task``
      already called ``runs.create``.

    Exactly one of ``run_input`` and ``run_id`` must be set; otherwise
    a synthetic ``failed`` is published immediately and the function
    returns.
    """
    fanout = fanout or get_fanout()
    state = StreamAdapterState()

    if (run_input is None) == (run_id is None):
        # Both set or both None — caller bug. Publish a synthetic
        # failed so chat surfaces don't dangle, then bail.
        logger.error(
            "stream_consumer.misconfigured builder_thread_id=%s run_input_set=%s run_id_set=%s; exactly one of run_input or run_id must be provided",
            builder_thread_id,
            run_input is not None,
            run_id is not None,
        )
        await _publish_synthetic_terminal(
            fanout,
            builder_thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            run_id=run_id,
            event_type="failed",
            payload={
                "error_message": "Stream consumer misconfigured (need exactly one of run_input or run_id)",
                "error_type": "ConfigurationError",
            },
        )
        return

    logger.info(
        "stream_consumer.started builder_thread_id=%s parent_thread_id=%s user_id=%s mode=%s",
        builder_thread_id,
        parent_thread_id,
        user_id,
        "create" if run_input is not None else "join",
    )

    # Publish ``started`` BEFORE the stream attempt. Two reasons:
    #
    # 1. Semantically a run has begun the moment this consumer is
    #    invoked — not when the first chunk arrives.
    # 2. Load-bearing for thread reuse. ``TelegramWorkChannel`` keeps
    #    one thread_id per chat across builds; the fanout resets the
    #    terminal flag on ``started``. If the run dies before yielding
    #    any chunk (transport error, immediate API rejection), the
    #    prior run's stale terminal flag would otherwise dedup BOTH the
    #    webhook terminal AND our synthetic ``failed`` fallback,
    #    leaving the placeholder stuck across consecutive runs.
    await fanout.publish(
        BuilderEvent(
            thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            event_type="started",
            payload={"task_brief": _extract_task_brief(run_input)},
            run_id=run_id,
        )
    )

    chunks_seen = 0
    try:
        chunks_seen = await asyncio.wait_for(
            _run_stream_loop(
                lg_client=lg_client,
                builder_thread_id=builder_thread_id,
                parent_thread_id=parent_thread_id,
                user_id=user_id,
                trace_id=trace_id,
                assistant_id=assistant_id,
                run_input=run_input,
                run_id=run_id,
                run_config=run_config,
                run_context=run_context,
                fanout=fanout,
                state=state,
            ),
            timeout=consumer_timeout_seconds,
        )
    except asyncio.CancelledError:
        logger.info("stream_consumer.cancelled builder_thread_id=%s", builder_thread_id)
        raise
    except TimeoutError:
        logger.warning(
            "stream_consumer.timed_out builder_thread_id=%s after %ds; awaiting webhook grace before synthesising timed_out",
            builder_thread_id,
            consumer_timeout_seconds,
        )
        # Give the canonical webhook a grace window. Production
        # observation 2026-05-13: the 30-min consumer timeout fired
        # ~25s BEFORE the real status=failed webhook landed (build was
        # at turn 29 of 30 — finishing). Without this grace the sink
        # rendered "Hit a snag…" at timeout, then re-rendered the real
        # failure summary 25s later — a double-flicker UX. The natural-
        # end and exception paths already do this hop; timeout was the
        # outlier.
        arrived = await fanout.await_terminal_dispatch(builder_thread_id, timeout=webhook_grace_seconds)
        if arrived:
            logger.info(
                "stream_consumer.terminated builder_thread_id=%s outcome=webhook_won_after_timeout",
                builder_thread_id,
            )
            return
        await _publish_synthetic_terminal(
            fanout,
            builder_thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            run_id=run_id,
            event_type="timed_out",
            payload={"timeout_seconds": consumer_timeout_seconds},
        )
        return
    except Exception as exc:
        # Don't leave the chat surface stuck. If the webhook arrives
        # during the grace, its rich payload wins via fanout dedup; if
        # not, fall back to a synthetic ``failed`` so the placeholder /
        # SSE clients see a definitive terminal.
        logger.warning(
            "stream_consumer.error builder_thread_id=%s; awaiting webhook grace before synthesising failed",
            builder_thread_id,
            exc_info=True,
        )
        arrived = await fanout.await_terminal_dispatch(builder_thread_id, timeout=webhook_grace_seconds)
        if arrived:
            logger.info(
                "stream_consumer.terminated builder_thread_id=%s outcome=webhook_won_after_error",
                builder_thread_id,
            )
            return
        await _publish_synthetic_terminal(
            fanout,
            builder_thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            run_id=run_id,
            event_type="failed",
            payload={
                "error_message": f"Stream consumer error: {type(exc).__name__}",
                "error_type": type(exc).__name__,
                "stream_exception": True,
            },
        )
        logger.info(
            "stream_consumer.terminated builder_thread_id=%s outcome=synthetic_failed",
            builder_thread_id,
        )
        return

    # Stream finished naturally. Give the webhook a head start so the
    # rich terminal event wins. If it never arrives, try bounded
    # reconnects (only in join-mode — the langgraph-restart class of
    # silent failure) before publishing a minimal synthetic terminal so
    # chat / SSE see *something*.
    logger.info(
        "stream_consumer.natural_end builder_thread_id=%s chunks_seen=%d waiting_for_webhook=true",
        builder_thread_id,
        chunks_seen,
    )
    arrived = await fanout.await_terminal_dispatch(builder_thread_id, timeout=webhook_grace_seconds)
    if arrived:
        logger.info(
            "stream_consumer.terminated builder_thread_id=%s outcome=webhook_won chunks_seen=%d",
            builder_thread_id,
            chunks_seen,
        )
        return

    # Join-mode only: the langgraph server may have restarted (or
    # severed the connection) while the run kept going. Try to
    # re-attach. Bounded retries with exponential backoff. Each
    # successful reconnect re-enters the stream loop; events continue
    # to flow to fanout. After exhausting retries (or if we're in
    # create-and-stream mode where the consumer owns the run lifecycle
    # so reconnect doesn't apply), fall through to synthetic completed.
    if run_id is not None and reconnect_max_attempts > 0:
        reconnect_arrived = await _try_reconnect_after_stream_end(
            lg_client=lg_client,
            builder_thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            run_id=run_id,
            fanout=fanout,
            state=state,
            webhook_grace_seconds=webhook_grace_seconds,
            initial_chunks_seen=chunks_seen,
            max_attempts=reconnect_max_attempts,
            backoffs=reconnect_backoffs,
        )
        if reconnect_arrived:
            return

    await _publish_synthetic_terminal(
        fanout,
        builder_thread_id=builder_thread_id,
        parent_thread_id=parent_thread_id,
        user_id=user_id,
        trace_id=trace_id,
        run_id=run_id,
        event_type="completed",
        payload={
            "companion_summary": "Build finished, but the result wasn't returned in time.",
            "webhook_grace_exhausted": True,
        },
    )
    logger.info(
        "stream_consumer.terminated builder_thread_id=%s outcome=synthetic chunks_seen=%d",
        builder_thread_id,
        chunks_seen,
    )


async def _run_stream_loop(
    *,
    lg_client: Any,
    builder_thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    assistant_id: str,
    run_input: dict[str, Any] | None,
    run_id: str | None,
    run_config: dict[str, Any] | None,
    run_context: dict[str, Any] | None,
    fanout,
    state: StreamAdapterState,
) -> int:
    """Iterate the stream and publish per-chunk events.

    Branches on which arg was supplied:

    - ``run_input`` provided → ``runs.stream(thread_id, assistant_id,
      input=...)`` creates AND streams in one call (Work bot path).
    - ``run_id`` provided → ``runs.join_stream(thread_id, run_id, ...)``
      attaches to an already-created run's output (Stage 2B companion
      dispatch path).

    Caller (``consume_builder_stream``) has already validated that
    exactly one is set and has published the ``started`` event so the
    fanout's per-thread state is reset before any SDK call runs.
    """
    # ``values`` powers the tool_started / tool_completed / todo_updated
    # adapters that drive the chat-relay sinks; ``custom`` is forward-
    # compat for ``ProgressEmitter`` phase events. We deliberately omit
    # ``messages`` (legacy AI-text shape) and ``messages-tuple`` (the
    # spec's token-tuple shape used by production manager.py): no sink
    # currently renders ``ai_message_chunk`` events, and the two modes
    # deliver incompatible payloads so picking either one bakes in a
    # contract decision that should land with the first AI-text-rendering
    # sink instead. Codex review 2026-05-13 flagged the prior
    # ``["values", "messages", "custom"]`` value for divergence from
    # production; dropping the mode entirely sidesteps the dispute
    # without breaking the rest of the pipeline.
    stream_modes = ["values", "custom"]

    if run_input is not None:
        stream_kwargs: dict[str, Any] = {"stream_mode": stream_modes}
        stream_kwargs["input"] = run_input
        if run_config is not None:
            stream_kwargs["config"] = run_config
        if run_context is not None:
            stream_kwargs["context"] = run_context
        stream = lg_client.runs.stream(builder_thread_id, assistant_id, **stream_kwargs)
    else:
        # run_id is not None (validated by consume_builder_stream).
        # join_stream takes no assistant_id, input, config, or context —
        # the run already exists and carries its own state.
        stream = lg_client.runs.join_stream(
            builder_thread_id,
            run_id,
            stream_mode=stream_modes,
        )

    chunks_seen = 0
    async for part in stream:
        chunks_seen += 1
        # DEBUG-only — INFO would churn ~50-200 lines per build.
        event_name = part[0] if isinstance(part, tuple) and part else None
        logger.debug(
            "stream_loop.chunk_received builder_thread_id=%s event=%s chunks_seen=%d",
            builder_thread_id,
            event_name,
            chunks_seen,
        )
        for event in stream_part_to_events(
            part,
            thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            adapter_state=state,
            run_id=run_id,
        ):
            await fanout.publish(event)

    logger.info(
        "stream_loop.iterator_exhausted builder_thread_id=%s chunks_seen=%d mode=%s",
        builder_thread_id,
        chunks_seen,
        "create" if run_input is not None else "join",
    )
    return chunks_seen


async def _try_reconnect_after_stream_end(
    *,
    lg_client: Any,
    builder_thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    run_id: str,
    fanout,
    state: StreamAdapterState,
    webhook_grace_seconds: float,
    initial_chunks_seen: int,
    max_attempts: int = _RECONNECT_MAX_ATTEMPTS,
    backoffs: tuple[float, ...] = _RECONNECT_BACKOFF_SECONDS,
) -> bool:
    """Bounded ``runs.join_stream`` reconnect for the langgraph-restart case.

    When the gateway's SSE connection closes cleanly but no terminal
    event ever arrived, the langgraph service likely restarted (the
    `_flush_loop` FileNotFoundError class of crash in Render's
    inmem runtime). The run may still be live on the new langgraph
    process. Re-attach via ``join_stream(run_id)`` and resume eventing.

    Returns True when a terminal event arrived (webhook OR via a
    successful reconnect cycle that ended naturally with a webhook
    arrival), False when retries exhausted with no terminal — caller
    falls through to synthetic-completed.
    """
    chunks_seen_total = initial_chunks_seen
    for attempt in range(1, max_attempts + 1):
        backoff = backoffs[min(attempt - 1, len(backoffs) - 1)] if backoffs else 0.0
        logger.info(
            "stream_consumer.reconnect builder_thread_id=%s run_id=%s attempt=%d backoff=%.1fs",
            builder_thread_id,
            run_id,
            attempt,
            backoff,
        )
        await asyncio.sleep(backoff)
        try:
            new_chunks = await _run_stream_loop(
                lg_client=lg_client,
                builder_thread_id=builder_thread_id,
                parent_thread_id=parent_thread_id,
                user_id=user_id,
                trace_id=trace_id,
                assistant_id="",  # unused in join mode
                run_input=None,
                run_id=run_id,
                run_config=None,
                run_context=None,
                fanout=fanout,
                state=state,
            )
        except Exception:
            logger.warning(
                "stream_consumer.reconnect builder_thread_id=%s attempt=%d status=failed",
                builder_thread_id,
                attempt,
                exc_info=True,
            )
            continue
        chunks_seen_total += new_chunks
        logger.info(
            "stream_consumer.reconnect builder_thread_id=%s attempt=%d status=ok new_chunks=%d total=%d",
            builder_thread_id,
            attempt,
            new_chunks,
            chunks_seen_total,
        )
        # After each successful reattach + natural end, give the
        # webhook another chance — the run may have completed during
        # the reconnect window.
        arrived = await fanout.await_terminal_dispatch(builder_thread_id, timeout=webhook_grace_seconds)
        if arrived:
            logger.info(
                "stream_consumer.terminated builder_thread_id=%s outcome=webhook_won_after_reconnect attempts=%d chunks_seen=%d",
                builder_thread_id,
                attempt,
                chunks_seen_total,
            )
            return True
    logger.warning(
        "stream_consumer.reconnect_exhausted builder_thread_id=%s attempts=%d chunks_seen=%d",
        builder_thread_id,
        max_attempts,
        chunks_seen_total,
    )
    return False


async def _publish_synthetic_terminal(
    fanout,
    *,
    builder_thread_id: str,
    parent_thread_id: str | None,
    user_id: str,
    trace_id: str,
    event_type: str,
    payload: dict[str, Any],
    run_id: str | None = None,
) -> None:
    await fanout.publish(
        BuilderEvent(
            thread_id=builder_thread_id,
            parent_thread_id=parent_thread_id,
            user_id=user_id,
            trace_id=trace_id,
            event_type=event_type,  # type: ignore[arg-type]
            payload=payload,
            source="stream",
            run_id=run_id,
        )
    )


def _extract_task_brief(run_input: dict[str, Any] | None) -> str:
    if not run_input:
        return ""
    messages = run_input.get("messages")
    if not isinstance(messages, list):
        return ""
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                return content[:500]
    return ""
