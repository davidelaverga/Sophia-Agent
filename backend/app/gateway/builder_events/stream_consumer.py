"""StreamConsumer — subscribe to LangGraph v3 thread stream and feed fanout.

The consumer runs as a background asyncio task spawned by
``BuilderEventFanout.attach_stream``. It opens a stream against the
LangGraph SDK for the builder thread and pushes adapted events into the
fanout's :meth:`publish`.

Phase 1 ships a defensive implementation that tolerates the v3 protocol
shape variations (see ``adapters.adapt_v3_chunk`` for details). The
exact ``client.threads.stream(...)`` signature is acknowledged as
unpinned in the spec (§22 Q1) — we use ``stream_mode`` arguments
documented in the agent-protocol streaming docs (messages-tuple +
updates + custom).

The consumer self-terminates when:

- The terminal lifecycle event arrives (e.g. ``thread.completed``)
- The configured per-event timeout is exceeded
- The wall-clock task timeout is exceeded
- ``BuilderEventFanout.cancel_stream`` cancels the task

Spec reference: ``sophia_telegram_architecture_spec_v1.md`` §10.2,
§14.1 (timeouts).
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any

from app.gateway.builder_events.adapters import adapt_v3_chunk
from app.gateway.builder_events.types import BuilderEvent

logger = logging.getLogger(__name__)


_DEFAULT_LANGGRAPH_URL = "http://localhost:2024"
_DEFAULT_ASSISTANT_ID = "sophia_builder"
_DEFAULT_TASK_TIMEOUT_SECONDS = 900
_DEFAULT_EVENT_TIMEOUT_SECONDS = 30


def _resolved_int(env_key: str, default: int) -> int:
    try:
        return int(os.environ.get(env_key, default))
    except (TypeError, ValueError):
        return default


class StreamConsumer:
    """One-shot consumer for a single in-progress builder run.

    Construction is cheap; :meth:`run` opens the stream via
    ``client.runs.join_stream(thread_id, run_id, stream_mode=[...])``.
    Callers spawn it via ``asyncio.create_task``.
    """

    def __init__(
        self,
        *,
        task_id: str,
        thread_id: str,
        user_id: str,
        channel_origin: str,
        publish: Callable[[BuilderEvent], Awaitable[None]],
        run_id: str | None = None,
        langgraph_url: str | None = None,
        assistant_id: str | None = None,
    ) -> None:
        self._task_id = task_id
        self._thread_id = thread_id
        self._user_id = user_id
        self._channel_origin = channel_origin
        self._publish = publish
        self._run_id = run_id
        self._langgraph_url = langgraph_url or os.environ.get("LANGGRAPH_URL", _DEFAULT_LANGGRAPH_URL)
        self._assistant_id = assistant_id or _DEFAULT_ASSISTANT_ID
        self._task_timeout = _resolved_int("WORKSHOP_TASK_TIMEOUT_SECONDS", _DEFAULT_TASK_TIMEOUT_SECONDS)
        self._event_timeout = _resolved_int("WORKSHOP_PER_EVENT_TIMEOUT_SECONDS", _DEFAULT_EVENT_TIMEOUT_SECONDS)

    async def run(self) -> None:
        """Subscribe to the v3 stream and publish adapted events.

        Returns when the stream completes, errors out, or hits a
        timeout. Errors are logged and swallowed.
        """
        try:
            await asyncio.wait_for(self._run_inner(), timeout=self._task_timeout)
        except TimeoutError:
            logger.warning(
                "StreamConsumer: wall-clock timeout exceeded task_id=%s thread_id=%s timeout=%ds",
                self._task_id,
                self._thread_id,
                self._task_timeout,
            )
        except asyncio.CancelledError:
            logger.info("StreamConsumer: cancelled task_id=%s", self._task_id)
            raise
        except Exception:
            logger.warning(
                "StreamConsumer: unhandled exception task_id=%s thread_id=%s",
                self._task_id,
                self._thread_id,
                exc_info=True,
            )

    async def _run_inner(self) -> None:
        client = await self._build_client()
        if client is None:
            return

        sequence = 0
        stream_iter = await self._open_stream(client)
        if stream_iter is None:
            return

        async for chunk in self._iter_with_event_timeout(stream_iter):
            sequence += 1
            # Phase 3 diagnostic: one log line per chunk so we can see
            # exactly which stream_mode values deepagents 0.5 emits and
            # whether the adapter is recognising them. Truncated to keep
            # production logs scannable.
            chunk_event_attr = getattr(chunk, "event", None)
            logger.info(
                "StreamConsumer: chunk task_id=%s seq=%d event=%s shape=%s preview=%.180s",
                self._task_id,
                sequence,
                chunk_event_attr,
                type(chunk).__name__,
                repr(chunk),
            )
            try:
                event = adapt_v3_chunk(
                    chunk,
                    task_id=self._task_id,
                    thread_id=self._thread_id,
                    user_id=self._user_id,
                    channel_origin=self._channel_origin,
                    sequence=sequence,
                )
            except Exception:
                logger.warning(
                    "StreamConsumer: adapter raised for task_id=%s",
                    self._task_id,
                    exc_info=True,
                )
                continue
            if event is None:
                logger.info(
                    "StreamConsumer: chunk ignored task_id=%s seq=%d event=%s — adapter could not extract BuilderEvent",
                    self._task_id,
                    sequence,
                    chunk_event_attr,
                )
                continue
            try:
                await self._publish(event)
            except Exception:
                logger.warning(
                    "StreamConsumer: publish raised for task_id=%s",
                    self._task_id,
                    exc_info=True,
                )
            if event.type == "completed":
                return

    async def _build_client(self) -> Any | None:
        try:
            from langgraph_sdk import get_client  # type: ignore[import-not-found]
        except ImportError:
            logger.error("StreamConsumer: langgraph_sdk is not installed; skipping stream task_id=%s", self._task_id)
            return None
        try:
            return get_client(url=self._langgraph_url)
        except Exception:
            logger.warning(
                "StreamConsumer: failed to construct SDK client url=%s task_id=%s",
                self._langgraph_url,
                self._task_id,
                exc_info=True,
            )
            return None

    async def _open_stream(self, client: Any) -> Any | None:
        """Open a v3 stream against an already-running builder run.

        We use ``client.runs.join_stream(thread_id, run_id, stream_mode=[...])``
        — NOT ``client.runs.stream(...)`` which would start a NEW run,
        and NOT ``client.threads.stream(...)`` which doesn't exist on
        the SDK's threads namespace.

        ``run_id`` is sourced from companion state's ``async_tasks``
        entry that ``start_builder_task`` wrote at dispatch time. When
        absent, we cannot tail this particular run, so we log and bail
        — the fanout's terminal-webhook ingress is the durability
        backstop.
        """
        if not self._run_id:
            logger.info(
                "StreamConsumer: no run_id supplied for task_id=%s; "
                "cannot tail run, falling back to terminal-webhook ingress only",
                self._task_id,
            )
            return None
        try:
            return client.runs.join_stream(
                self._thread_id,
                self._run_id,
                stream_mode=["messages-tuple", "updates", "custom"],
            )
        except AttributeError:
            logger.warning(
                "StreamConsumer: installed langgraph_sdk has no runs.join_stream — "
                "is the SDK version too old? task_id=%s",
                self._task_id,
            )
            return None
        except Exception:
            logger.warning(
                "StreamConsumer: failed to open v3 stream task_id=%s thread_id=%s run_id=%s",
                self._task_id,
                self._thread_id,
                self._run_id,
                exc_info=True,
            )
            return None

    async def _iter_with_event_timeout(self, stream_iter: Any):
        """Yield chunks with a per-event-arrival timeout."""
        iterator = stream_iter.__aiter__()
        while True:
            try:
                chunk = await asyncio.wait_for(iterator.__anext__(), timeout=self._event_timeout)
            except TimeoutError:
                logger.warning(
                    "StreamConsumer: per-event timeout exceeded task_id=%s timeout=%ds",
                    self._task_id,
                    self._event_timeout,
                )
                return
            except StopAsyncIteration:
                return
            except Exception:
                logger.warning("StreamConsumer: iterator raised task_id=%s", self._task_id, exc_info=True)
                return
            yield chunk


__all__ = ["StreamConsumer"]
