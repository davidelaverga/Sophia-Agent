"""Tests for the gateway-side BuilderProgressRegistry.

Phase 4H of the v3 streaming migration. The registry maps
``task_id`` → placeholder anchor + per-task ``ProgressRenderer``, and
invokes a per-channel edit callback when phase / tool-call events
arrive via ``/internal/builder-progress``.
"""

from __future__ import annotations

import asyncio

import pytest

from app.gateway.builder_progress import (
    BuilderProgressRegistry,
    get_progress_registry,
)
from app.gateway.builder_progress.registry import reset_for_tests


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_for_tests()


def test_singleton_is_lazy_initialized() -> None:
    """First call constructs; subsequent calls return the same instance."""
    a = get_progress_registry()
    b = get_progress_registry()
    assert a is b
    assert isinstance(a, BuilderProgressRegistry)


def test_register_and_has_task() -> None:
    r = BuilderProgressRegistry()
    r.register_task(
        task_id="t-1",
        chat_id=42,
        message_id=99,
        channel_name="telegram",
        run_id="r-1",
    )
    assert r.has_task("t-1") is True
    assert r.has_task("t-other") is False


def test_unregister_task() -> None:
    r = BuilderProgressRegistry()
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1"
    )
    r.unregister_task("t-1")
    assert r.has_task("t-1") is False


@pytest.mark.anyio
async def test_apply_event_drops_when_no_entry() -> None:
    """Common case: middleware fires ``starting`` before the channel has
    registered the placeholder. The registry returns False (dropped)
    instead of raising or queuing."""
    r = BuilderProgressRegistry()
    applied = await r.apply_event(
        task_id="t-unknown",
        event_name="custom",
        data={"name": "phase", "phase": "starting"},
    )
    assert applied is False


@pytest.mark.anyio
async def test_apply_event_calls_channel_callback_on_state_change() -> None:
    """When the entry exists AND the event changes renderer state AND
    a callback is registered, the registry invokes it with the new
    placeholder body."""
    r = BuilderProgressRegistry()

    captured: list[tuple[int, int, str]] = []

    async def cb(chat_id: int, message_id: int, body: str) -> None:
        captured.append((chat_id, message_id, body))

    r.register_channel_callback("telegram", cb)
    r.register_task(task_id="t-1", chat_id=42, message_id=99, channel_name="telegram", run_id="r-1")

    applied = await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )
    assert applied is True
    assert len(captured) == 1
    chat_id, message_id, body = captured[0]
    assert chat_id == 42
    assert message_id == 99
    assert "[ Researching ]" in body


@pytest.mark.anyio
async def test_apply_event_skips_unchanged_body() -> None:
    """If a follow-up event doesn't change the rendered body (e.g.
    same phase re-fired), the registry skips the edit to keep the
    Telegram API quiet."""
    r = BuilderProgressRegistry()
    calls = {"n": 0}

    async def cb(_c: int, _m: int, _b: str) -> None:
        calls["n"] += 1

    r.register_channel_callback("telegram", cb)
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1")

    await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )
    await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )
    # First fired; second is a no-op.
    assert calls["n"] == 1


@pytest.mark.anyio
async def test_apply_event_drops_when_no_callback() -> None:
    """If the channel hasn't registered a callback (e.g. test fixture
    without a real channel), the registry logs and returns False
    rather than raising."""
    r = BuilderProgressRegistry()
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1")

    applied = await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )
    assert applied is False


@pytest.mark.anyio
async def test_apply_event_swallows_callback_exception() -> None:
    """A failing edit callback (e.g. Telegram 5xx) MUST be logged and
    swallowed — the builder never blocks on the gateway."""
    r = BuilderProgressRegistry()

    async def bad_cb(*_: object) -> None:
        raise RuntimeError("simulated edit failure")

    r.register_channel_callback("telegram", bad_cb)
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1")

    # Must not raise.
    applied = await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )
    assert applied is False


@pytest.mark.anyio
async def test_mark_done_finalizes_and_unregisters() -> None:
    """``mark_done`` pushes the final ``[ Done ]`` body and removes
    the entry so subsequent events for the same task_id are no-ops."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1")

    # Transition the renderer past starting so mark_done produces a state change.
    await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )

    finalized = await r.mark_done(task_id="t-1", summary="Built FST report.")
    assert finalized is True
    assert "[ Done ]" in captured[-1]
    assert "Built FST report." in captured[-1]
    assert r.has_task("t-1") is False


@pytest.mark.anyio
async def test_mark_done_returns_false_for_unknown_task() -> None:
    """Codex P2 (post-Phase-4H review): when no entry exists,
    ``mark_done`` returns False AND records the terminal in
    ``_pending_terminals`` for later replay on registration."""
    r = BuilderProgressRegistry()
    finalized = await r.mark_done(task_id="t-missing", summary="ran fast")
    assert finalized is False
    # The pending terminal is now recorded for replay.
    # Phase 4I-followup (codex P1): keyed by (task_id, run_id_or_empty);
    # no run_id passed → empty-string fallback key.
    assert ("t-missing", "") in r._pending_terminals
    assert r._pending_terminals[("t-missing", "")].summary == "ran fast"


# ---- Codex P1 post-Phase-4H: run_id matching ------------------------------


@pytest.mark.anyio
async def test_apply_event_drops_when_run_id_mismatches() -> None:
    """Codex P1: events from an obsoleted run (interrupted via
    ``update_async_task``) MUST NOT mutate the new placeholder. The
    registry validates the incoming ``run_id`` against the stored one
    and drops mismatches silently.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    # Register the NEW run.
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )
    # Incoming event from the OLD (interrupted) run — same task_id,
    # different run_id. Must be dropped.
    applied = await r.apply_event(
        task_id="t-1",
        run_id="r-OLD",
        event_name="custom",
        data={"name": "phase", "phase": "drafting"},
    )
    assert applied is False
    assert captured == []  # no edit pushed


@pytest.mark.anyio
async def test_apply_event_accepts_matching_run_id() -> None:
    """Sanity: matching run_id flows through normally."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1"
    )

    applied = await r.apply_event(
        task_id="t-1",
        run_id="r-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
    )
    assert applied is True
    assert any("[ Researching ]" in body for body in captured)


@pytest.mark.anyio
async def test_apply_event_with_no_run_id_param_still_works() -> None:
    """Backward-compatibility: callers (e.g. tests, hypothetical
    older middlewares) can omit run_id. The registry then skips the
    run_id check and applies the event normally.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1"
    )

    applied = await r.apply_event(
        task_id="t-1",
        event_name="custom",
        data={"name": "phase", "phase": "researching"},
        # No run_id passed — should still apply.
    )
    assert applied is True


# ---- Codex P2 post-Phase-4H: pending-terminal early-arrival ---------------


@pytest.mark.anyio
async def test_pending_replay_holds_strong_reference_to_task() -> None:
    """Codex P2 (post-Phase-4I review): the replay task spawned by
    ``_schedule_pending_replay`` MUST be held in
    ``self._replay_tasks`` so the asyncio runtime doesn't GC it
    mid-flight. ``asyncio.create_task`` returns a weakly-referenced
    handle; without a strong ref, a fast-finish placeholder could
    leave the user stuck on "Working on it…" because the replay
    coroutine was collected before it completed.
    """
    r = BuilderProgressRegistry()

    # Capture the registry's _replay_tasks set immediately after
    # schedule but BEFORE awaiting any sleep. The task should be
    # in the set as soon as create_task returns.
    seen_in_set: dict[str, bool] = {"value": False}
    callback_fired: dict[str, bool] = {"value": False}

    async def cb(_c, _m, _b):
        # Re-read the set from inside the callback. The replay
        # task should still be referenced (we're inside it).
        if r._replay_tasks:
            seen_in_set["value"] = True
        callback_fired["value"] = True

    r.register_channel_callback("telegram", cb)
    # Terminal arrives early, recorded as pending.
    await r.mark_done(task_id="t-strong-ref", summary="ok", run_id="r-1")
    # Now register — this should schedule a replay task and
    # immediately add it to _replay_tasks.
    r.register_task(
        task_id="t-strong-ref",
        chat_id=1,
        message_id=2,
        channel_name="telegram",
        run_id="r-1",
    )
    # Replay task is scheduled but not yet run. The set MUST be
    # non-empty at this point (the strong ref is held).
    assert len(r._replay_tasks) == 1, (
        f"replay task must be strong-ref'd in _replay_tasks set; "
        f"got len={len(r._replay_tasks)}"
    )
    # Let the loop run the task.
    await asyncio.sleep(0.1)
    # Callback fired (proves the task ran to completion).
    assert callback_fired["value"] is True
    assert seen_in_set["value"] is True, (
        "strong ref must still be held while the callback runs"
    )
    # Discard-on-done callback eventually clears the set.
    # Yield once more to let the done-callback run.
    await asyncio.sleep(0.01)
    assert len(r._replay_tasks) == 0, (
        f"replay task should be discarded after completion; "
        f"_replay_tasks still has {len(r._replay_tasks)} entries"
    )


@pytest.mark.anyio
async def test_register_task_replays_pending_terminal() -> None:
    """Codex P2: if ``mark_done`` arrives before ``register_task``
    (fast-build race), the terminal is recorded and replayed when
    the placeholder is eventually registered. Without this, the
    placeholder would stay stuck on "Working on it…" forever."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)

    # Terminal arrives FIRST (fast-build race).
    await r.mark_done(task_id="t-fast", summary="Built quickly.")
    # Codex P1 post-Phase-4I: keyed by (task_id, run_id_or_empty);
    # no run_id passed → empty-string slot.
    assert ("t-fast", "") in r._pending_terminals
    assert captured == []  # no edit yet — no anchor to edit

    # Now placeholder lands and registers.
    r.register_task(
        task_id="t-fast",
        chat_id=1,
        message_id=2,
        channel_name="telegram",
        run_id="r-fast",
    )

    # Pending terminal is consumed (removed from cache) and replay is scheduled.
    # register_task tried (t-fast, "r-fast") first, missed, fell back
    # to (t-fast, "") and popped it.
    assert ("t-fast", "") not in r._pending_terminals
    assert ("t-fast", "r-fast") not in r._pending_terminals

    # Yield to the event loop so the scheduled replay can run.
    await asyncio.sleep(0.05)

    # The replay fired mark_done; placeholder now reads "[ Done ]".
    assert captured, "pending terminal replay should have pushed a final edit"
    assert "[ Done ]" in captured[-1]
    assert "Built quickly." in captured[-1]
    assert r.has_task("t-fast") is False  # mark_done unregisters


@pytest.mark.anyio
async def test_mark_done_does_not_overwrite_pending_terminal() -> None:
    """If ``mark_done`` is called twice before registration with the
    SAME (task_id, run_id) pair (rare — terminal webhook is dedup'd
    at langgraph but defensive), the FIRST call's summary is
    preserved; the SECOND is a no-op. (Different run_ids now coexist
    under separate composite keys — see codex-P1 race test below.)
    """
    r = BuilderProgressRegistry()
    await r.mark_done(task_id="t-1", summary="first summary")
    await r.mark_done(task_id="t-1", summary="second summary")
    assert r._pending_terminals[("t-1", "")].summary == "first summary"


def test_pending_terminals_evict_on_ttl() -> None:
    """Pending terminals older than the TTL are dropped on trim."""
    import time as time_module

    from app.gateway.builder_progress import registry as registry_mod

    r = BuilderProgressRegistry()
    # Manually insert an "old" pending entry (bypass the public API
    # so we can backdate the timestamp).
    r._pending_terminals[("t-old", "")] = registry_mod._PendingTerminal(
        timestamp=time_module.time() - 1000.0,  # >> 300s TTL
        summary="stale",
    )
    r._pending_terminals[("t-fresh", "")] = registry_mod._PendingTerminal(
        timestamp=time_module.time(),
        summary="fresh",
    )
    # Trigger a trim. Use the locked variant since we're in a test
    # without coroutine context.
    with r._lock:
        r._trim_pending_terminals_locked()
    assert ("t-old", "") not in r._pending_terminals
    assert ("t-fresh", "") in r._pending_terminals


@pytest.mark.anyio
async def test_mark_done_drops_when_run_id_mismatches() -> None:
    """Codex P1 (post-Phase-4H follow-up): a stale-run terminal MUST NOT
    close the new run's placeholder. ``mark_done`` validates ``run_id``
    against the registered entry's run_id and drops on mismatch.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    # Register the NEW run.
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )

    # Stale terminal from the OLD run arrives.
    finalized = await r.mark_done(task_id="t-1", summary="old summary", run_id="r-OLD")
    assert finalized is False
    assert captured == []
    # Entry is still registered (the new run's placeholder is intact).
    assert r.has_task("t-1") is True


@pytest.mark.anyio
async def test_mark_done_accepts_matching_run_id() -> None:
    """Sanity: matching run_id finalizes normally."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1"
    )

    finalized = await r.mark_done(task_id="t-1", summary="all good", run_id="r-1")
    assert finalized is True
    assert any("[ Done ]" in body for body in captured)
    assert any("all good" in body for body in captured)
    assert r.has_task("t-1") is False


# ---- Phase 4I: mark_stopped (codex P2 post-Phase-4H) ---------------------


@pytest.mark.anyio
async def test_mark_stopped_finalizes_with_stopped_header() -> None:
    """Codex P2: failure terminals get [ Stopped — (reason) ] instead
    of the misleading [ Done ]."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1"
    )

    finalized = await r.mark_stopped(task_id="t-1", reason="timed out")
    assert finalized is True
    assert captured, "edit callback should have been invoked"
    final_body = captured[-1]
    assert "[ Stopped ]" in final_body
    assert "timed out" in final_body
    assert "[ Done ]" not in final_body, (
        "stopped finalize must not produce a Done header"
    )
    assert r.has_task("t-1") is False


@pytest.mark.anyio
async def test_mark_stopped_drops_when_run_id_mismatches() -> None:
    """Codex P1+P2 combination: a stale failure-terminal from the
    interrupted run MUST NOT close the new run's placeholder either.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )

    finalized = await r.mark_stopped(
        task_id="t-1", reason="old run errored", run_id="r-OLD"
    )
    assert finalized is False
    assert captured == []
    assert r.has_task("t-1") is True


@pytest.mark.anyio
async def test_mark_stopped_records_pending_when_no_entry() -> None:
    """Codex P2 + early-arrival race: a failure terminal arriving
    before registration is queued so the eventual placeholder can be
    finalized correctly (not as Done)."""
    r = BuilderProgressRegistry()
    finalized = await r.mark_stopped(task_id="t-fast-fail", reason="timed out")
    assert finalized is False
    # Codex P1 post-Phase-4I: keyed by (task_id, run_id_or_empty).
    pending = r._pending_terminals[("t-fast-fail", "")]
    assert pending.kind == "stopped"
    assert pending.reason == "timed out"


@pytest.mark.anyio
async def test_pending_replay_routes_to_stopped_when_kind_is_stopped() -> None:
    """Codex P2 replay: when the pending was a failure-kind terminal,
    register_task's replay path routes through mark_stopped (not
    mark_done) so the placeholder shows [ Stopped ]."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)

    # Fast-failed: terminal arrives first.
    await r.mark_stopped(task_id="t-fast-fail", reason="build failed", run_id="r-1")
    # Placeholder lands.
    r.register_task(
        task_id="t-fast-fail",
        chat_id=1,
        message_id=2,
        channel_name="telegram",
        run_id="r-1",
    )
    # Yield to the loop so the scheduled replay runs.
    await asyncio.sleep(0.05)

    assert captured, "replay should have invoked the edit callback"
    final = captured[-1]
    assert "[ Stopped ]" in final
    assert "build failed" in final
    assert "[ Done ]" not in final


@pytest.mark.anyio
async def test_pending_replay_drops_when_run_id_mismatches() -> None:
    """Codex P1 replay path: a pending terminal recorded for an OLD run
    must NOT fire onto a NEW run's freshly-registered placeholder
    (update_async_task flow with a race-y old-run terminal queued
    early). The replay validates pending.run_id against entry.run_id
    and drops on mismatch.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)

    # Old run's terminal lands BEFORE its own registration (early race).
    await r.mark_done(task_id="t-1", summary="old run done", run_id="r-OLD")
    # Codex P1 post-Phase-4I: keyed by (task_id, run_id_or_empty).
    assert ("t-1", "r-OLD") in r._pending_terminals
    assert r._pending_terminals[("t-1", "r-OLD")].run_id == "r-OLD"

    # Now a NEW run for the same task_id registers (e.g. the user
    # already fired update_async_task in between).
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )
    await asyncio.sleep(0.05)

    # Register_task swept the stale (t-1, r-OLD) pending entry and
    # didn't find a (t-1, r-NEW) one. No replay fires. The new
    # placeholder stays active for its own terminal to arrive.
    assert captured == [], (
        "stale-run pending replay must NOT push an edit to the new placeholder"
    )
    assert r.has_task("t-1") is True
    # And the old pending was cleaned up (codex P1 stale-sweep).
    assert ("t-1", "r-OLD") not in r._pending_terminals


@pytest.mark.anyio
async def test_pending_replay_picks_newer_run_when_both_present() -> None:
    """Codex P1 (post-Phase-4I review) primary lock: in the
    ``update_async_task`` flow the SAME task_id can produce
    early-arrival terminals from TWO different run_ids before
    registration. The old key-by-task_id behaviour silently
    dropped the second one (``if task_key not in pending`` skip),
    and then registration popped the stale entry and rejected
    it on run_id mismatch — placeholder stuck forever.

    With composite ``(task_id, run_id)`` keys, both terminals
    coexist. Registration picks the one matching the entry's
    run_id and replays it; the stale entry is cleaned up.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)

    # 1. Old run's terminal lands first.
    await r.mark_done(task_id="t-1", summary="old summary", run_id="r-OLD")
    # 2. update_async_task interrupts the old run; new run starts and
    #    ALSO terminates early.
    await r.mark_done(task_id="t-1", summary="NEW summary", run_id="r-NEW")
    # Both pending entries coexist.
    assert ("t-1", "r-OLD") in r._pending_terminals
    assert ("t-1", "r-NEW") in r._pending_terminals

    # 3. Placeholder for the NEW run lands.
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )
    await asyncio.sleep(0.05)

    # Replay fired for r-NEW (correct), and the stale r-OLD pending
    # was cleaned up by the stale-sweep.
    assert captured, "expected replay to push an edit for r-NEW"
    final = captured[-1]
    assert "[ Done ]" in final
    assert "NEW summary" in final
    assert "old summary" not in final  # OLD entry was discarded
    assert r.has_task("t-1") is False  # mark_done unregisters
    # And both pending entries are gone (matched one consumed, stale swept).
    assert ("t-1", "r-OLD") not in r._pending_terminals
    assert ("t-1", "r-NEW") not in r._pending_terminals


@pytest.mark.anyio
async def test_pending_replay_picks_newer_when_arrival_order_inverted() -> None:
    """The race-direction symmetry: the NEW run's terminal arrives
    BEFORE the OLD run's terminal (still both before registration).
    The composite key still finds the NEW entry on lookup; the
    OLD one is swept as stale. Without the composite key, this
    would have worked correctly (the old code kept the first one,
    which was r-NEW), but it's worth locking — the composite key
    handles both orderings the same way.
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)

    # Inverted order: NEW arrives first, OLD arrives second.
    await r.mark_done(task_id="t-1", summary="NEW summary", run_id="r-NEW")
    await r.mark_done(task_id="t-1", summary="old summary", run_id="r-OLD")

    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )
    await asyncio.sleep(0.05)

    assert captured
    assert "NEW summary" in captured[-1]
    assert "old summary" not in captured[-1]


@pytest.mark.anyio
async def test_pending_replay_falls_back_to_empty_runid_legacy_pending() -> None:
    """Back-compat: pre-4I-payload-plumb terminals that arrived
    without run_id stored under ``(task_id, "")``. Registration
    for a run WITH run_id first looks up ``(task_id, run_id)``,
    misses, then falls back to ``(task_id, "")`` and replays. The
    pending's empty run_id passes the replay's match check (it's
    falsy so the guard short-circuits to "match").
    """
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)

    # Legacy mark_done without run_id (pre-4I payload).
    await r.mark_done(task_id="t-1", summary="legacy summary")
    assert ("t-1", "") in r._pending_terminals

    # Registration for a current run with run_id.
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1"
    )
    await asyncio.sleep(0.05)

    # Replay fires (fallback to empty-run_id pending).
    assert captured
    assert "legacy summary" in captured[-1]
    assert "[ Done ]" in captured[-1]


def test_pending_terminals_evict_on_cap() -> None:
    """When the pending-cache exceeds its cap, the OLDEST entries are
    dropped (FIFO via dict insertion order)."""
    import time as time_module

    from app.gateway.builder_progress import registry as registry_mod

    r = BuilderProgressRegistry()
    # Fill past the cap with FRESH timestamps so the TTL pass
    # doesn't drop them — we want to exercise the cap pass only.
    # Codex P1 post-Phase-4I: keyed by (task_id, run_id_or_empty).
    now = time_module.time()
    for i in range(registry_mod._PENDING_TERMINAL_CAP + 50):
        r._pending_terminals[(f"t-{i:04d}", "")] = registry_mod._PendingTerminal(
            timestamp=now, summary=str(i)
        )
    with r._lock:
        r._trim_pending_terminals_locked()
    assert len(r._pending_terminals) <= registry_mod._PENDING_TERMINAL_CAP
    # Oldest entries evicted; newest preserved.
    last_idx = registry_mod._PENDING_TERMINAL_CAP + 49
    assert (f"t-{last_idx:04d}", "") in r._pending_terminals
    assert ("t-0000", "") not in r._pending_terminals


@pytest.mark.anyio
async def test_apply_event_with_updates_emits_activity_lines() -> None:
    """``updates`` mode events carrying tool_calls produce activity
    lines (🔍 Searching / 🔗 Reading / 📝 Drafting) in the placeholder
    body. This is what makes the live UX feel responsive."""
    r = BuilderProgressRegistry()
    captured: list[str] = []

    async def cb(_c: int, _m: int, body: str) -> None:
        captured.append(body)

    r.register_channel_callback("telegram", cb)
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-1")

    await r.apply_event(
        task_id="t-1",
        event_name="updates",
        data={"agent": {"messages": [{"tool_calls": [
            {"name": "builder_web_search", "args": {"query": "Zep memory"}}
        ]}]}},
    )
    assert any("🔍 Searching: Zep memory" in body for body in captured)
