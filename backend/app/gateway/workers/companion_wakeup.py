"""Server-side companion wakeup on builder completion.

Background:
    Sophia's companion-to-builder hand-off is asynchronous. The companion
    queues a builder task via ``switch_to_builder``, the task runs in the
    background, and on completion the LangGraph process posts to
    ``POST /internal/builder-events`` (handled by the builder_events
    router). The router fans the event out to webapp SSE subscribers and
    IM channels.

    BUT — the companion itself only adopts ``builder_result`` when it runs
    a turn. ``BuilderSessionMiddleware.before_agent`` polls the background
    task state and synthesizes the artifact announcement; this only
    happens on a real turn (i.e. when the user sends a new message). If
    the user sits idle while the builder is working, the artifact
    completes, the webhook fires, the frontend SSE may even render the
    artifact card — but the companion's chat thread stays silent until
    the user types something else. From the user's POV: "Sophia doesn't
    know about the work."

This worker closes that gap by triggering a synthetic companion turn
when the builder finishes:

    1. ``receive_builder_event`` POST handler delegates to ``wake()``
       after publishing to SSE / channels.
    2. ``wake()`` calls ``client.runs.create(thread_id, "sophia_companion",
       input={"messages": []}, ...)`` with ``multitask_strategy="enqueue"``
       so the wakeup turn runs after any in-flight user turn instead of
       interrupting it.
    3. LangGraph processes the empty input. ``BuilderSessionMiddleware``
       polls and adopts the terminal builder state. ``ArtifactMiddleware``
       sees ``builder_result`` is set and ``builder_task.status ==
       "completed"``, injects the synthesis block, and the model emits a
       tone-aware completion message into the thread.
    4. Frontend's existing message stream picks up the new AI message
       automatically — same surface, no additional UI plumbing.

Design notes:

- **Fire-and-forget.** ``wake()`` is launched via ``asyncio.create_task``
  so the webhook handler returns immediately. Failures are logged and
  swallowed: the builder result is already in state, the user can ask
  Sophia for status as a fallback (the existing turn-driven adoption
  still works).
- **Idempotent.** A bounded recent-task-id set deduplicates retried
  webhooks (the LangGraph process publishes once per terminal transition,
  but we guard against the rare double-publish under e.g. retries on
  the publisher side).
- **Status filter.** Only ``success | error | timeout`` trigger a wakeup.
  ``cancelled`` does not — the user already knows they cancelled and a
  proactive announcement would be noise.
- **Configuration carry-through.** The wakeup turn passes
  ``is_builder_wakeup=True`` and the originating ``builder_task_id`` in
  ``configurable`` so future code paths can branch on this if needed
  (none currently — the existing middlewares are wakeup-agnostic).
"""

from __future__ import annotations

import logging
import os
from collections import OrderedDict
from typing import Any

logger = logging.getLogger(__name__)

# Status values that should trigger a proactive companion announcement.
# ``cancelled`` is intentionally excluded — see module docstring.
_WAKEUP_STATUSES = frozenset({"success", "error", "timeout"})

# Bounded recent-task-id memory for idempotency. Sized for ~1 day of
# normal usage at ~10 builders/hour; an in-process LRU is sufficient
# because retries arrive within seconds of the first publish.
_DEDUP_MAX_ENTRIES = 256

# Default LangGraph URL when the env var isn't set. Matches the channels
# layer default in ``app/channels/service.py``.
_DEFAULT_LANGGRAPH_URL = "http://localhost:2024"

# Companion graph id from ``backend/langgraph.json``. Hard-coded because
# this worker is companion-specific; a generalization would belong in a
# different module.
_COMPANION_ASSISTANT_ID = "sophia_companion"


class CompanionWakeup:
    """Trigger synthetic companion turns when the builder completes.

    Lifecycle: instantiated once during gateway startup, accessed via
    ``get_companion_wakeup(app)``. Single asyncio event loop; not
    thread-safe (mirrors ``BuilderEventsWorker``).
    """

    def __init__(self, *, langgraph_url: str | None = None) -> None:
        self._langgraph_url = (
            langgraph_url
            or os.getenv("LANGGRAPH_URL")
            or _DEFAULT_LANGGRAPH_URL
        )
        self._client: Any = None
        self._seen_task_ids: OrderedDict[str, None] = OrderedDict()

    @property
    def langgraph_url(self) -> str:
        return self._langgraph_url

    def _get_client(self) -> Any:
        """Lazy-init the langgraph_sdk async client.

        Mirrors ``app.channels.manager.ChannelManager._get_client`` —
        single instance per worker, created on first use so test
        fixtures and offline imports don't hit the network.
        """
        if self._client is None:
            from langgraph_sdk import get_client  # type: ignore[import-not-found]

            self._client = get_client(url=self._langgraph_url)
        return self._client

    def _should_skip(self, event: dict[str, Any]) -> tuple[bool, str | None]:
        """Return ``(skip, reason)``. Always check before the network call."""
        status = event.get("status")
        if status not in _WAKEUP_STATUSES:
            return True, f"status={status} not in wakeup set"

        thread_id = event.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            return True, "missing thread_id"

        task_id = event.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            # Without a task id we can't dedup. Allow through but log;
            # the LangGraph publisher always sets task_id, so this is
            # mainly defensive.
            return False, None

        # Idempotency: skip if we've already woken on this task.
        if task_id in self._seen_task_ids:
            return True, f"task_id={task_id} already triggered wakeup"
        return False, None

    def _remember(self, task_id: str | None) -> None:
        """Add ``task_id`` to the recent set, evicting oldest if over cap."""
        if not isinstance(task_id, str) or not task_id:
            return
        self._seen_task_ids[task_id] = None
        while len(self._seen_task_ids) > _DEDUP_MAX_ENTRIES:
            self._seen_task_ids.popitem(last=False)

    async def wake(self, event: dict[str, Any]) -> bool:
        """Best-effort wakeup. Returns True iff a run was queued.

        Never raises — failures are logged and swallowed so the webhook
        path (already accepted by the gateway) doesn't surface errors to
        the LangGraph process.
        """
        skip, reason = self._should_skip(event)
        if skip:
            logger.debug(
                "Companion wakeup: skipping thread_id=%s task_id=%s reason=%s",
                event.get("thread_id"),
                event.get("task_id"),
                reason,
            )
            return False

        thread_id = event["thread_id"]
        task_id = event.get("task_id")
        try:
            client = self._get_client()
            # Empty input.messages — the existing companion middlewares
            # (``BuilderSessionMiddleware`` + ``ArtifactMiddleware``)
            # adopt and synthesize without needing a fresh user message.
            #
            # ``multitask_strategy="enqueue"`` queues the wakeup behind
            # any in-flight user turn instead of interrupting it (the
            # default ``"reject"`` would drop us, ``"interrupt"`` would
            # cancel the user's run mid-flight — neither is what we want).
            await client.runs.create(
                thread_id,
                _COMPANION_ASSISTANT_ID,
                input={"messages": []},
                config={
                    "configurable": {
                        "is_builder_wakeup": True,
                        "builder_task_id": task_id,
                        "builder_event_status": event.get("status"),
                    }
                },
                multitask_strategy="enqueue",
            )
            self._remember(task_id)
            logger.info(
                "Companion wakeup: queued thread_id=%s task_id=%s status=%s",
                thread_id,
                task_id,
                event.get("status"),
            )
            return True
        except Exception:
            # Never fail the webhook path. The user can still ask
            # Sophia for status; the turn-driven adoption flow is the
            # fallback that already worked before this worker existed.
            logger.exception(
                "Companion wakeup: client.runs.create failed thread_id=%s task_id=%s",
                thread_id,
                task_id,
            )
            return False


# ---- Lifespan helpers ------------------------------------------------------


_WAKEUP_ATTR = "_companion_wakeup"


def install_companion_wakeup(app, *, langgraph_url: str | None = None) -> CompanionWakeup:
    """Attach a wakeup worker to ``app.state``.

    Called from the gateway lifespan handler. Mirrors
    ``install_builder_events_worker``.
    """
    wakeup = CompanionWakeup(langgraph_url=langgraph_url)
    setattr(app.state, _WAKEUP_ATTR, wakeup)
    return wakeup


def get_companion_wakeup(app) -> CompanionWakeup:
    """Retrieve the wakeup worker from ``app.state``. Raises if not installed."""
    wakeup = getattr(app.state, _WAKEUP_ATTR, None)
    if wakeup is None:
        raise RuntimeError(
            "CompanionWakeup is not installed on app.state. "
            "Did the gateway lifespan run? Did the test fixture forget to install it?"
        )
    return wakeup


def get_companion_wakeup_or_none(app) -> CompanionWakeup | None:
    """Retrieve the wakeup worker from ``app.state`` if installed.

    Test fixtures may install the gateway router without the wakeup
    worker (the existing ``test_builder_events_worker`` fixture predates
    this module). The webhook route handler uses this helper so missing
    wakeup is silent rather than logging a noisy warning on every test.
    """
    return getattr(app.state, _WAKEUP_ATTR, None)
