"""Per-process registry mapping builder task_id → placeholder anchor + renderer.

The flow (PR #126 Phase 4H — webhook relay):

1. Manager publishes a "Working on it…" placeholder with metadata
   ``{"builder_progress": {"task_id", "run_id", "user_id"}}``.
2. ``TelegramChannel.send`` sends the placeholder, captures the
   resulting ``message_id``, and calls
   ``registry.register_task(task_id, chat_id, message_id, channel)``.
3. The builder's ``BuilderProgressMiddleware`` (runs in the langgraph
   service process) POSTs phase events to
   ``/internal/builder-progress``.
4. The endpoint calls ``registry.apply_event(task_id, ...)``.
5. The registry's per-task ``ProgressRenderer`` consumes the event
   and produces a new placeholder body.
6. If the body changed, the registry invokes the channel's edit
   callback to push the new body via ``bot.edit_message_text``.
7. On terminal (``_on_builder_completion`` artifact delivery), the
   channel calls ``registry.unregister_task(task_id)``.

The architecture deliberately doesn't use ``runs.join_stream``:
``langgraph dev``'s in-mem runtime doesn't deliver buffered events
to late-joining HTTP subscribers across processes (verified in
production smoke tests 2026-05-16/17). The webhook is fired
synchronously from inside the builder's run, so the gateway sees
events as they happen — no replay needed.

Channels register an async edit callback at start-up via
``register_channel_callback(channel_name, callback)``. The callback
signature is ``(chat_id, message_id, body) -> None`` (async). On each
state change the registry invokes the callback. Telegram's callback
hops to ``_tg_loop`` to keep PTB bot calls loop-affine (learning
#14 in the v3 migration plan).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from itertools import islice
from typing import Any

from app.channels.telegram_progress_renderer import ProgressRenderer

logger = logging.getLogger(__name__)


# Bound the registry so a leak (terminal webhook never fires for a
# task) can't consume unbounded memory. The trim path drops the
# OLDEST entries (FIFO via dict iteration order) when we exceed the
# cap. 1024 active builds is way beyond realistic concurrent load.
_CAP = 1024
_TRIM_TARGET = 768  # keep ~75% on overflow

# Codex P2 (post-Phase-4H review): terminal events that arrive BEFORE
# ``register_task`` (fast-build race) are recorded here and replayed
# on registration. TTL prevents leaks if the placeholder never lands
# (e.g. companion turn failed downstream of the build). 5 minutes is
# longer than any realistic placeholder-send delay (typically <30s
# from `runs.wait` returning to `bot.send_message` completing) and
# short enough not to mask real bugs.
_PENDING_TERMINAL_TTL_SECONDS = 300.0
_PENDING_TERMINAL_CAP = 256

# Codex P2 (post-Phase-4K+1 review): when the terminal edit callback
# fails (transient Telegram 5xx, channel restarting mid-edit, etc.)
# the placeholder must NOT be unregistered as "done" — builder
# completion webhooks are LRU-deduped server-side (see
# ``_emitted_task_ids`` in ``deerflow/sophia/builder_events.py``), so
# no second terminal webhook will ever fire. Without an explicit
# retry, the placeholder stays stuck on its last non-terminal body
# forever.
#
# Retry policy: bounded attempts with exponential-ish backoff. After
# the last attempt, we give up + unregister + log warning so the
# entry doesn't leak. Three attempts at 2/5/15 seconds (~22s total
# wall clock) is enough to ride out a typical Telegram 5xx blip
# without keeping the entry alive indefinitely.
_TERMINAL_RETRY_BACKOFFS_SECONDS: tuple[float, ...] = (2.0, 5.0, 15.0)
_MAX_TERMINAL_RETRIES = len(_TERMINAL_RETRY_BACKOFFS_SECONDS)


# Type alias for the per-channel edit callback. Channels register one
# of these for their channel_name; the registry invokes it on every
# placeholder-body change.
EditCallback = Callable[[int, int, str], Awaitable[None]]


@dataclass
class BuilderProgressEntry:
    """Per-task placeholder anchor + renderer.

    Codex P1 (post-Phase-4H review): ``run_id`` is now part of the
    entry. ``update_async_task`` keeps the same ``task_id`` but
    starts a new run with a new ``run_id``; delayed in-flight webhook
    POSTs from the interrupted run would otherwise mutate the new
    placeholder (phase regressions, premature "done"). ``apply_event``
    validates the incoming run_id against this field and drops
    mismatches.

    Codex P1 (Phase 4J post-review): ``update_lock`` serializes
    per-task renderer mutation + body cache update + edit callback
    await. The middleware emits webhook POSTs fire-and-forget; the
    endpoint spawns a coroutine per POST. Without serialization,
    two events for the same task_id can interleave at the
    ``renderer.apply`` mutation and the ``last_pushed_body`` write,
    causing visible phase regressions (a newer ``[ Finalizing ]``
    overwritten by an older ``[ Drafting ]``) or dropped retries.
    The lock is per-entry so cross-task events still process
    concurrently. It's an asyncio.Lock not a threading.Lock — the
    gateway endpoint runs on a single FastAPI loop so loop-affinity
    is fine.
    """

    chat_id: int
    message_id: int
    channel_name: str
    run_id: str
    renderer: ProgressRenderer = field(default_factory=ProgressRenderer)
    # Last-pushed body so we can avoid no-op edits.
    last_pushed_body: str = ""
    # Lazily initialised on first use so the dataclass constructor
    # doesn't require an asyncio loop to be running (the registry
    # is constructed at import time in some test paths). See
    # ``BuilderProgressRegistry._ensure_entry_lock``.
    update_lock: asyncio.Lock | None = None
    # Codex P2 (post-Phase-4K+1 review): bounded retry counter for
    # the terminal edit. Incremented on each callback failure inside
    # ``_finalize_terminal_locked``; once it hits
    # ``_MAX_TERMINAL_RETRIES`` we give up and unregister. Counter
    # is per-entry so a replacement run (``update_async_task``) gets
    # a fresh budget.
    terminal_retry_attempts: int = 0


@dataclass
class _PendingTerminal:
    """Terminal event captured before ``register_task`` happened.

    Phase 4I (codex post-Phase-4H follow-up): carries ``kind`` and
    ``run_id`` so the replay path can:

    - Route to ``mark_done`` (success) or ``mark_stopped`` (failure)
      based on the original terminal's status (codex P2).
    - Validate the pending's run_id against the just-registered
      entry's run_id and drop the replay if they disagree (codex P1
      for the replay path — stale-run terminal queued early shouldn't
      land on a fresh-run placeholder via ``update_async_task``).
    """

    timestamp: float
    kind: str = "done"  # "done" | "stopped"
    summary: str = ""    # used when kind == "done"
    reason: str = ""     # used when kind == "stopped"
    run_id: str = ""


class BuilderProgressRegistry:
    """In-memory registry of active builder-progress placeholders.

    Singleton-per-process. Access via :func:`get_progress_registry`.
    """

    def __init__(self) -> None:
        # Insertion order matters for FIFO trim — use ``dict`` not
        # ``set`` (CPython 3.7+ language spec guarantees insertion
        # order for dict iteration).
        self._entries: dict[str, BuilderProgressEntry] = {}
        self._callbacks: dict[str, EditCallback] = {}
        # Codex P2 (post-Phase-4H review): terminal events that
        # arrive before ``register_task`` are recorded here for
        # replay on registration. Bounded + TTL'd to prevent leaks
        # when a placeholder never lands.
        #
        # Codex P1 (post-Phase-4I review): keyed by
        # ``(task_id, run_id_or_empty)`` rather than just ``task_id``.
        # The ``update_async_task`` flow can produce TWO early
        # terminals for the same task_id from different run_ids
        # before registration; keying by task_id alone would silently
        # drop the second one (the "if task_key not in pending"
        # short-circuit), and registration would then pop the stale
        # one and reject it on run_id mismatch — leaving the
        # placeholder stuck. Composite key lets both coexist;
        # registration picks the one matching the entry's run_id.
        # Legacy/back-compat terminals without a run_id store under
        # ``(task_id, "")``.
        self._pending_terminals: dict[tuple[str, str], _PendingTerminal] = {}
        # Codex P2 (post-Phase-4I review): strong-ref set for
        # ``_schedule_pending_replay``'s fire-and-forget tasks.
        # asyncio only weakly references tasks created via
        # ``loop.create_task``; without a strong-ref hold, the GC
        # can collect an in-flight replay task before mark_done /
        # mark_stopped completes, leaving the placeholder stuck.
        # Same pattern as ``_POST_TASKS`` in the middleware and
        # ``_progress_subscriber_tasks`` in the original Phase 4D
        # subscriber. ``add_done_callback(discard)`` keeps the set
        # bounded.
        self._replay_tasks: set[asyncio.Task] = set()
        # Codex P2 (post-Phase-4K+1 review): strong-ref set for
        # ``_schedule_terminal_retry``'s fire-and-forget retry tasks.
        # Separate from ``_replay_tasks`` so failure modes (replay
        # tasks leaking would be a different bug from retries
        # leaking) are diagnosable independently in logs / tests.
        self._terminal_retry_tasks: set[asyncio.Task] = set()
        # Protect registration / lookup against concurrent access
        # from the HTTP endpoint coroutine + channel send coroutine.
        # All operations are short (dict ops + a callback await
        # outside the lock), so a single threading.Lock is fine.
        self._lock = threading.Lock()

    # -- channel-side wiring ------------------------------------------------

    def register_channel_callback(
        self, channel_name: str, callback: EditCallback
    ) -> None:
        """Register an async function that edits a placeholder body.

        Signature: ``async def cb(chat_id, message_id, body)``.

        Each channel calls this once on start. The registry invokes
        the callback on every placeholder-body change for tasks
        registered with that ``channel_name``.
        """
        with self._lock:
            self._callbacks[channel_name] = callback
        logger.info(
            "[BuilderProgress] channel callback registered channel=%s",
            channel_name,
        )

    def unregister_channel_callback(self, channel_name: str) -> None:
        with self._lock:
            self._callbacks.pop(channel_name, None)

    # -- task-side wiring ---------------------------------------------------

    def register_task(
        self,
        *,
        task_id: str,
        chat_id: int,
        message_id: int,
        channel_name: str,
        run_id: str,
    ) -> None:
        """Bind a task_id to its placeholder anchor.

        Called from ``TelegramChannel.send`` after the placeholder
        message lands and we have its ``message_id``. The renderer
        starts at the ``starting`` phase by default (matches the
        placeholder text "Working on it…").

        Codex P1 (post-Phase-4H review): ``run_id`` is now part of
        the entry so ``apply_event`` can reject in-flight POSTs from
        a previous (interrupted-via-``update_async_task``) run that
        share the same task_id but a different run_id.

        Codex P2 (post-Phase-4H review): on registration we check
        ``_pending_terminals`` for a terminal event that arrived
        before this call (fast-build race) and replay it via a
        scheduled ``mark_done`` so the placeholder doesn't stay
        stuck on "Working on it…" indefinitely.
        """
        task_key = str(task_id)
        run_id_str = str(run_id)
        with self._lock:
            self._entries[task_key] = BuilderProgressEntry(
                chat_id=chat_id,
                message_id=message_id,
                channel_name=channel_name,
                run_id=run_id_str,
            )
            # Codex P1 (post-Phase-4I review): pending terminals are
            # now keyed by ``(task_id, run_id_or_empty)``. Look up the
            # matching one for THIS run first; fall back to a legacy
            # entry stored under ``(task_id, "")`` for pre-4I
            # terminals that didn't carry run_id. Clean up any other
            # pending entries for the SAME task_id (different run_ids
            # — from previous interrupted runs) since they can't
            # match this entry and would just leak until the TTL
            # eviction fires.
            pending = self._pending_terminals.pop((task_key, run_id_str), None)
            if pending is None:
                pending = self._pending_terminals.pop((task_key, ""), None)
            # Sweep stale same-task pending entries (from interrupted
            # previous runs whose terminals couldn't be matched).
            stale_keys = [
                k for k in self._pending_terminals if k[0] == task_key
            ]
            for k in stale_keys:
                self._pending_terminals.pop(k, None)
            self._trim_locked()
            self._trim_pending_terminals_locked()
        logger.info(
            "[BuilderProgress] task registered task_id=%s run_id=%s chat_id=%s message_id=%s channel=%s",
            task_id,
            run_id,
            chat_id,
            message_id,
            channel_name,
        )
        if pending is not None:
            self._schedule_pending_replay(task_key, pending)

    def _schedule_pending_replay(
        self, task_id: str, pending: _PendingTerminal
    ) -> None:
        """Fire the appropriate terminal for a task whose webhook arrived early.

        Called from ``register_task`` (sync) after we find a pending
        terminal. Schedules the async finalizer on the current loop
        so the placeholder transforms without the registering caller
        having to await. If no loop is running (sync caller), we
        log and skip — the artifact path is still the durability
        backstop.

        Phase 4I (codex P1 + P2):

        - Routes to ``mark_done`` or ``mark_stopped`` based on
          ``pending.kind`` so failure terminals don't render as Done.
        - Validates ``pending.run_id`` against the just-registered
          entry's run_id. Mismatch means the pending was for a
          previous run (interrupted before its terminal could fire
          and the new run was started via ``update_async_task``);
          we drop the replay so the new run's placeholder isn't
          closed prematurely.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning(
                "[BuilderProgress] pending terminal replay skipped (no running loop) task_id=%s",
                task_id,
            )
            return
        # Codex P1: validate that the pending's run_id matches the
        # just-registered entry's run_id. Look up the entry under the
        # lock since register_task has already inserted it.
        with self._lock:
            entry = self._entries.get(task_id)
        if entry is None:
            # Race: entry was unregistered between register_task and
            # this scheduling step. Drop the replay — there's nothing
            # to finalize.
            logger.warning(
                "[BuilderProgress] pending terminal replay aborted — entry gone task_id=%s",
                task_id,
            )
            return
        if pending.run_id and pending.run_id != entry.run_id:
            logger.info(
                "[BuilderProgress] pending terminal replay dropped — run_id mismatch "
                "task_id=%s pending_run_id=%s entry_run_id=%s kind=%s",
                task_id,
                pending.run_id,
                entry.run_id,
                pending.kind,
            )
            return
        if pending.kind == "stopped":
            coro = self.mark_stopped(
                task_id=task_id,
                reason=pending.reason,
                run_id=entry.run_id,
            )
        else:
            coro = self.mark_done(
                task_id=task_id,
                summary=pending.summary,
                run_id=entry.run_id,
            )
        # Codex P2 (post-Phase-4I review): keep a strong reference to
        # the scheduled task. asyncio.create_task only weakly
        # references the task; without this set, the GC can collect
        # the replay coroutine mid-flight and the placeholder stays
        # stuck. ``add_done_callback(discard)`` reaps on completion.
        task = loop.create_task(coro)
        self._replay_tasks.add(task)
        task.add_done_callback(self._replay_tasks.discard)
        logger.info(
            "[BuilderProgress] pending terminal replay scheduled task_id=%s "
            "kind=%s age_s=%.1f",
            task_id,
            pending.kind,
            time.time() - pending.timestamp,
        )

    def unregister_task(
        self,
        task_id: str,
        *,
        expected_entry: BuilderProgressEntry | None = None,
    ) -> None:
        """Drop a task's entry. Called from ``_on_builder_completion``.

        Codex P2 (post-Phase-4K review): ``expected_entry`` is an
        identity guard against the ``update_async_task`` replacement
        race. When ``register_task`` is called with the same
        ``task_id`` but a new ``run_id`` (the replacement-run flow),
        ``_entries[task_id]`` is overwritten with a fresh
        ``BuilderProgressEntry`` instance. If an in-flight terminal
        handler from the OLD run is currently awaiting the slow
        Telegram edit, releasing the lock and calling
        ``unregister_task(task_id)`` unconditionally would pop the
        NEW entry — detaching the active run's placeholder.

        The run_id check at the top of ``_finalize_terminal_locked``
        doesn't catch this because it operates on the snapshot
        ``entry`` captured BEFORE the await; that snapshot's
        ``run_id`` legitimately matches the OLD run's terminal
        payload, so the check passes.

        Identity guard: only pop if the dict slot still points at the
        same entry object the caller acquired. ``is`` comparison is
        unambiguous — even if a future code path reused the same
        run_id string, a freshly-constructed entry would be a
        different object.
        """
        task_key = str(task_id)
        with self._lock:
            current = self._entries.get(task_key)
            if expected_entry is not None and current is not expected_entry:
                # Replacement run is now registered under this task_id.
                # Leave it alone — the new entry's terminal handler
                # will unregister itself when its time comes.
                logger.info(
                    "[BuilderProgress] unregister skipped — entry was "
                    "replaced (likely update_async_task race) task_id=%s",
                    task_id,
                )
                return
            popped = self._entries.pop(task_key, None)
        if popped is not None:
            logger.info(
                "[BuilderProgress] task unregistered task_id=%s", task_id
            )

    def has_task(self, task_id: str) -> bool:
        with self._lock:
            return str(task_id) in self._entries

    def _ensure_entry_lock(self, entry: BuilderProgressEntry) -> asyncio.Lock:
        """Lazily construct the per-entry asyncio.Lock under threading.Lock.

        Codex P1 (Phase 4J post-review): we don't initialise the
        Lock at ``register_task`` time because some callers
        (notably the singleton-init path triggered at module import
        in test fixtures) may not have an asyncio loop running yet.
        First touch from an async context (always ``apply_event`` or
        ``_finalize_terminal``) creates it.

        The compare-and-set must happen under ``self._lock`` to
        prevent two concurrent first-touch callers from each
        creating a fresh Lock and proceeding unsynchronized — the
        whole point is to serialize on a SINGLE lock object.
        """
        with self._lock:
            if entry.update_lock is None:
                entry.update_lock = asyncio.Lock()
            return entry.update_lock

    # -- event dispatch -----------------------------------------------------

    async def apply_event(
        self,
        *,
        task_id: str,
        event_name: str,
        data: Any,
        run_id: str | None = None,
    ) -> bool:
        """Apply one progress event to the per-task renderer + push edit.

        ``event_name`` matches the renderer's ``apply`` API:
        ``"messages"``, ``"updates"``, ``"custom"``. ``data`` is the
        payload for that mode. ``run_id`` is required for codex P1
        run-id matching: when present, events whose ``run_id`` doesn't
        match the entry's stored ``run_id`` are dropped (events from
        a previous run interrupted by ``update_async_task``).

        Returns ``True`` when an edit was attempted (state changed
        AND a channel callback is registered AND the body actually
        differs from the last pushed body). Returns ``False`` for
        any short-circuit (unknown task / unchanged state /
        unregistered channel / run_id mismatch) so the endpoint can
        report visibility.
        """
        task_key = str(task_id)
        with self._lock:
            entry = self._entries.get(task_key)
            callback = self._callbacks.get(entry.channel_name) if entry else None
        if entry is None:
            # Common case: middleware fired ``starting`` before the
            # channel registered. We drop silently — the placeholder
            # text already says "Working on it…" which IS the
            # starting state.
            logger.debug(
                "[BuilderProgress] apply_event dropped — no entry for task_id=%s event=%s",
                task_id,
                event_name,
            )
            return False
        # Codex P1 (Phase 4J post-review): serialize per-task
        # renderer mutation + body cache update + callback await.
        # The middleware fires webhook POSTs as fire-and-forget
        # asyncio tasks; the gateway endpoint spawns a coroutine per
        # POST. Without this lock, two events for the same task_id
        # can interleave at ``renderer.apply`` and the
        # ``last_pushed_body`` write — older state can overwrite
        # newer state (phase regression: ``[ Finalizing ]`` →
        # ``[ Drafting ]``), and a retry attempt can race with the
        # original. The lock is per-entry; cross-task events still
        # proceed concurrently.
        lock = self._ensure_entry_lock(entry)
        async with lock:
            return await self._apply_event_locked(
                entry=entry,
                callback=callback,
                task_id=task_id,
                event_name=event_name,
                data=data,
                run_id=run_id,
            )

    async def _apply_event_locked(
        self,
        *,
        entry: BuilderProgressEntry,
        callback: EditCallback | None,
        task_id: str,
        event_name: str,
        data: Any,
        run_id: str | None,
    ) -> bool:
        """Critical section of ``apply_event`` held under ``entry.update_lock``.

        Extracted so the lock-acquisition site is a clean three-line
        ``async with`` block and the body-mutation logic is testable
        without lock-dance noise. All decision branches that previously
        lived inline in ``apply_event`` are preserved verbatim here.
        """
        # Codex P1 (post-Phase-4H review): drop events from an
        # obsoleted run. ``update_async_task`` keeps the same task_id
        # but starts a new run; in-flight POSTs from the interrupted
        # run would otherwise mutate the new placeholder (phase
        # regressions, premature "done").
        if run_id is not None and str(run_id) != entry.run_id:
            logger.info(
                "[BuilderProgress] apply_event dropped — run_id mismatch task_id=%s event=%s "
                "expected_run_id=%s incoming_run_id=%s",
                task_id,
                event_name,
                entry.run_id,
                run_id,
            )
            return False
        result = entry.renderer.apply(event_name, data)
        if not result.state_changed:
            return False
        body = entry.renderer.render()
        if not body or body == entry.last_pushed_body:
            return False
        if callback is None:
            logger.warning(
                "[BuilderProgress] no edit callback for channel=%s task_id=%s — dropping update",
                entry.channel_name,
                task_id,
            )
            return False
        # Codex P2 (Phase 4J post-review): cache ``last_pushed_body``
        # AFTER the callback succeeds, not before. The body-equality
        # guard above (``body == entry.last_pushed_body``) already
        # prevents spam on back-to-back identical events. The original
        # "cache before" approach traded retry-ability for one extra
        # spam guard — wrong tradeoff: a transient Telegram edit
        # failure (5xx / network blip) would mark the body as
        # delivered, and the next event carrying the SAME body would
        # be dropped at the equality check → placeholder stuck on
        # whatever was last actually pushed, possibly for the rest
        # of the run. With "cache after success", a failed edit
        # leaves ``last_pushed_body`` at its previous value so the
        # next same-body event retries.
        try:
            await callback(entry.chat_id, entry.message_id, body)
        except Exception:
            logger.warning(
                "[BuilderProgress] edit callback raised channel=%s task_id=%s",
                entry.channel_name,
                task_id,
                exc_info=True,
            )
            return False
        entry.last_pushed_body = body
        return True

    async def mark_done(
        self,
        *,
        task_id: str,
        summary: str = "",
        run_id: str | None = None,
    ) -> bool:
        """Finalize the placeholder as ``[ Done ]`` and unregister.

        Called from ``_on_builder_completion`` when the artifact
        delivery webhook fires AND ``status == "success"``. The
        placeholder body transforms to the done header + optional
        summary; the entry is then dropped so future webhooks for
        the same task_id are no-ops.

        Codex P1 (post-Phase-4H review): ``run_id`` is checked
        against the registered entry's run_id. A delayed terminal
        from a previous run (interrupted via ``update_async_task``)
        must NOT close the new run's placeholder. When ``run_id``
        is omitted (callers that don't yet plumb it), the check is
        skipped — non-breaking.

        Codex P2 (post-Phase-4H review): if the entry isn't
        registered yet (fast-build race — terminal webhook arrived
        before ``runs.wait`` returned and the channel sent the
        placeholder), record the terminal in ``_pending_terminals``
        so ``register_task`` can replay it on registration. Without
        this, a fast-build placeholder would land AFTER the terminal
        and stay stuck on "Working on it…" forever.
        """
        return await self._finalize_terminal(
            task_id=task_id,
            kind="done",
            summary=summary,
            reason="",
            run_id=run_id,
        )

    async def mark_stopped(
        self,
        *,
        task_id: str,
        reason: str = "",
        run_id: str | None = None,
    ) -> bool:
        """Finalize the placeholder as ``[ Stopped — (reason) ]`` and unregister.

        Phase 4I (codex P2 post-Phase-4H): symmetric counterpart to
        ``mark_done`` for non-success terminal outcomes
        (``error`` / ``failed`` / ``timeout`` / ``timed_out`` /
        ``cancelled`` / ``canceled``). The placeholder transforms to
        a "[ Stopped ]" header instead of falsely claiming "[ Done ]"
        when the channel is about to render a retry card right
        below it.

        Same run_id-match guard and pending-record-on-miss semantics
        as ``mark_done``.
        """
        return await self._finalize_terminal(
            task_id=task_id,
            kind="stopped",
            summary="",
            reason=reason,
            run_id=run_id,
        )

    async def _finalize_terminal(
        self,
        *,
        task_id: str,
        kind: str,
        summary: str,
        reason: str,
        run_id: str | None,
    ) -> bool:
        """Shared implementation for ``mark_done`` / ``mark_stopped``.

        Returns True iff the renderer was advanced AND an edit was
        pushed (and the entry was unregistered). Returns False on
        any short-circuit:

        - Entry not found → records the terminal as pending for
          later replay (and logs).
        - run_id mismatch on existing entry → drops silently.
        - Renderer produced no body change → unregisters but
          doesn't push.
        - Callback raised → swallows the exception, unregisters
          anyway (the artifact-delivery path is independent).
        """
        task_key = str(task_id)
        with self._lock:
            entry = self._entries.get(task_key)
            callback = self._callbacks.get(entry.channel_name) if entry else None
        if entry is None:
            # Codex P1 (post-Phase-4I review): key the pending entry
            # by ``(task_id, run_id_or_empty)`` so multiple early
            # terminals from different run_ids (the
            # ``update_async_task`` race) coexist. The "if key not
            # in pending" short-circuit now only dedupes terminals
            # for the SAME (task_id, run_id) pair — which the
            # langgraph side already dedups via
            # ``_emitted_task_ids``, so this is belt-and-braces.
            pending_run_id = str(run_id) if run_id else ""
            pending_key: tuple[str, str] = (task_key, pending_run_id)
            with self._lock:
                if pending_key not in self._pending_terminals:
                    self._pending_terminals[pending_key] = _PendingTerminal(
                        timestamp=time.time(),
                        kind=kind,
                        summary=summary,
                        reason=reason,
                        run_id=pending_run_id,
                    )
                    self._trim_pending_terminals_locked()
            logger.info(
                "[BuilderProgress] mark_%s recorded as pending — no entry yet "
                "task_id=%s run_id=%s",
                kind,
                task_id,
                run_id,
            )
            return False
        # Codex P1 (Phase 4J post-review): same per-task lock as
        # ``apply_event``. Serializes renderer mutation + body cache
        # update + callback await so a concurrent ``apply_event``
        # for the same task_id can't interleave with the terminal
        # finalize. Without this, the renderer state could be
        # mid-mutation when terminal fires, producing an
        # inconsistent rendered body and a partial edit.
        lock = self._ensure_entry_lock(entry)
        async with lock:
            return await self._finalize_terminal_locked(
                entry=entry,
                callback=callback,
                task_id=task_id,
                kind=kind,
                summary=summary,
                reason=reason,
                run_id=run_id,
            )

    async def _finalize_terminal_locked(
        self,
        *,
        entry: BuilderProgressEntry,
        callback: EditCallback | None,
        task_id: str,
        kind: str,
        summary: str,
        reason: str,
        run_id: str | None,
    ) -> bool:
        """Critical section of ``_finalize_terminal`` under ``entry.update_lock``."""
        # Codex P1: drop terminal events from an obsoleted run.
        if run_id is not None and str(run_id) != entry.run_id:
            logger.info(
                "[BuilderProgress] mark_%s dropped — run_id mismatch task_id=%s "
                "expected_run_id=%s incoming_run_id=%s",
                kind,
                task_id,
                entry.run_id,
                run_id,
            )
            return False
        if kind == "done":
            entry.renderer.mark_done(summary=summary)
        elif kind == "stopped":
            entry.renderer.mark_stopped(reason=reason)
        else:
            logger.warning(
                "[BuilderProgress] _finalize_terminal called with unknown kind=%r task_id=%s",
                kind,
                task_id,
            )
            return False
        body = entry.renderer.render()
        callback_succeeded = True
        if callback is not None and body and body != entry.last_pushed_body:
            # Codex P2 (Phase 4J post-review): cache AFTER the
            # callback succeeds — see ``apply_event`` for the
            # rationale. A failed terminal edit shouldn't mark the
            # body as delivered.
            try:
                await callback(entry.chat_id, entry.message_id, body)
                entry.last_pushed_body = body
            except Exception:
                callback_succeeded = False
                logger.warning(
                    "[BuilderProgress] mark_%s edit raised channel=%s task_id=%s "
                    "attempt=%d/%d",
                    kind,
                    entry.channel_name,
                    task_id,
                    entry.terminal_retry_attempts + 1,
                    _MAX_TERMINAL_RETRIES,
                    exc_info=True,
                )

        if not callback_succeeded:
            # Codex P2 (post-Phase-4K+1 review): terminal edit failed.
            # Builder completion webhooks are LRU-deduped server-side
            # (one terminal per task_id, ever), so there's no second
            # webhook to retry from. Without an explicit retry the
            # placeholder is permanently stuck on its previous
            # non-terminal body. Schedule a backoff retry; if all
            # retries fail we eventually unregister + log.
            entry.terminal_retry_attempts += 1
            if entry.terminal_retry_attempts < _MAX_TERMINAL_RETRIES:
                self._schedule_terminal_retry(
                    task_id=task_id,
                    kind=kind,
                    summary=summary,
                    reason=reason,
                    run_id=run_id,
                    expected_entry=entry,
                    attempt=entry.terminal_retry_attempts,
                )
                # IMPORTANT: do NOT unregister here. The retry needs
                # the entry to still be in ``_entries`` so its
                # identity-guarded ``mark_done`` / ``mark_stopped``
                # can re-fetch it. Cleanup happens either on a later
                # successful retry or on retry-budget exhaustion
                # (below).
                return False
            # Retries exhausted — give up so the entry doesn't leak.
            # The user will see the last-pushed (non-terminal) body
            # but the artifact-delivery path is independent and
            # still ran via ``_on_builder_completion``.
            logger.warning(
                "[BuilderProgress] mark_%s retries exhausted (%d/%d) — "
                "giving up; placeholder may be stuck task_id=%s channel=%s",
                kind,
                entry.terminal_retry_attempts,
                _MAX_TERMINAL_RETRIES,
                task_id,
                entry.channel_name,
            )
            self.unregister_task(task_id, expected_entry=entry)
            return False

        # Codex P2 (post-Phase-4K review): identity-guarded unregister.
        # During the slow callback await above, ``register_task`` may
        # have been called by ``update_async_task`` for a replacement
        # run on the same task_id — overwriting ``_entries[task_key]``
        # with a fresh entry. Without ``expected_entry``, the
        # unconditional pop here would detach the new run's
        # placeholder. The guard checks that the dict slot still
        # points at our snapshot ``entry`` before popping.
        self.unregister_task(task_id, expected_entry=entry)
        return True

    def _schedule_terminal_retry(
        self,
        *,
        task_id: str,
        kind: str,
        summary: str,
        reason: str,
        run_id: str | None,
        expected_entry: BuilderProgressEntry,
        attempt: int,
    ) -> None:
        """Schedule a delayed re-attempt of ``mark_done``/``mark_stopped``.

        ``attempt`` is the 1-indexed retry number that just FAILED — so
        ``attempt=1`` means we just had our first failure and are
        scheduling retry #1. We index the backoff table with
        ``attempt - 1`` (clamped at the end of the table) and the
        retry function itself goes through the public ``mark_*`` API
        so it inherits run_id matching, identity-guarded unregister,
        and lock acquisition.

        Identity guard inside the retry: before we re-enter mark_*,
        we re-check that ``_entries[task_id] is expected_entry``. If
        the entry was replaced by ``update_async_task`` or removed by
        a concurrent unregister, the retry is a no-op (the new
        entry's terminal will arrive on its own; the removed entry
        is already done).
        """
        backoff_idx = min(attempt - 1, len(_TERMINAL_RETRY_BACKOFFS_SECONDS) - 1)
        backoff = _TERMINAL_RETRY_BACKOFFS_SECONDS[backoff_idx]

        async def _retry() -> None:
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                return
            with self._lock:
                current = self._entries.get(str(task_id))
            if current is not expected_entry:
                logger.info(
                    "[BuilderProgress] terminal retry skipped — entry "
                    "replaced or removed task_id=%s",
                    task_id,
                )
                return
            logger.info(
                "[BuilderProgress] terminal retry firing task_id=%s "
                "kind=%s attempt=%d backoff_s=%.1f",
                task_id,
                kind,
                attempt,
                backoff,
            )
            try:
                if kind == "done":
                    await self.mark_done(
                        task_id=task_id, summary=summary, run_id=run_id
                    )
                else:
                    await self.mark_stopped(
                        task_id=task_id, reason=reason, run_id=run_id
                    )
            except Exception:
                logger.warning(
                    "[BuilderProgress] terminal retry mark_%s raised task_id=%s",
                    kind,
                    task_id,
                    exc_info=True,
                )

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No active loop — caller is in a sync context we don't
            # expect (terminal handlers always run under FastAPI's
            # async loop). Log and bail; the placeholder may stay
            # stuck but the artifact path is independent.
            logger.warning(
                "[BuilderProgress] terminal retry not scheduled — no "
                "running loop task_id=%s",
                task_id,
            )
            return
        task = loop.create_task(_retry())
        self._terminal_retry_tasks.add(task)
        task.add_done_callback(self._terminal_retry_tasks.discard)

    # -- internals ----------------------------------------------------------

    def _trim_locked(self) -> None:
        """Drop the oldest entries when we exceed the cap. Caller holds lock."""
        if len(self._entries) <= _CAP:
            return
        to_drop = len(self._entries) - _TRIM_TARGET
        stale_keys = list(islice(self._entries, to_drop))
        for k in stale_keys:
            self._entries.pop(k, None)
        logger.warning(
            "[BuilderProgress] trimmed registry — evicted %d oldest entries (size=%d → %d)",
            to_drop,
            _CAP,
            len(self._entries),
        )

    def _trim_pending_terminals_locked(self) -> None:
        """Evict expired and excess pending-terminal entries. Caller holds lock.

        TTL eviction first (drops anything older than
        ``_PENDING_TERMINAL_TTL_SECONDS``), then cap eviction (drops
        oldest by insertion order until len ≤ cap). Both protect
        against the placeholder-never-arrives leak scenario.
        """
        now = time.time()
        # TTL pass: build a list of expired keys (can't pop while iterating).
        expired = [
            k for k, p in self._pending_terminals.items()
            if now - p.timestamp > _PENDING_TERMINAL_TTL_SECONDS
        ]
        for k in expired:
            self._pending_terminals.pop(k, None)
        # Cap pass.
        if len(self._pending_terminals) > _PENDING_TERMINAL_CAP:
            to_drop = len(self._pending_terminals) - _PENDING_TERMINAL_CAP
            stale = list(islice(self._pending_terminals, to_drop))
            for k in stale:
                self._pending_terminals.pop(k, None)
            logger.warning(
                "[BuilderProgress] pending-terminal cap exceeded — evicted %d oldest",
                to_drop,
            )


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------


_registry: BuilderProgressRegistry | None = None


def get_progress_registry() -> BuilderProgressRegistry:
    """Return the process-wide registry (lazy-init)."""
    global _registry
    if _registry is None:
        _registry = BuilderProgressRegistry()
    return _registry


def reset_for_tests() -> None:
    """Drop the singleton — test-only helper."""
    global _registry
    _registry = None


# Suppress unused-import warning for asyncio (referenced in callback
# typing & docstrings, kept available for downstream consumers).
_ = asyncio
