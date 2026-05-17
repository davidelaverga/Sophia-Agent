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
    assert "t-missing" in r._pending_terminals
    assert r._pending_terminals["t-missing"].summary == "ran fast"


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
    assert "t-fast" in r._pending_terminals
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
    assert "t-fast" not in r._pending_terminals

    # Yield to the event loop so the scheduled replay can run.
    await asyncio.sleep(0.05)

    # The replay fired mark_done; placeholder now reads "[ Done ]".
    assert captured, "pending terminal replay should have pushed a final edit"
    assert "[ Done ]" in captured[-1]
    assert "Built quickly." in captured[-1]
    assert r.has_task("t-fast") is False  # mark_done unregisters


@pytest.mark.anyio
async def test_mark_done_does_not_overwrite_pending_terminal() -> None:
    """If ``mark_done`` is called twice before registration (rare —
    terminal webhook is dedup'd at langgraph but defensive), the
    FIRST call's summary is preserved; the SECOND is a no-op."""
    r = BuilderProgressRegistry()
    await r.mark_done(task_id="t-1", summary="first summary")
    await r.mark_done(task_id="t-1", summary="second summary")
    assert r._pending_terminals["t-1"].summary == "first summary"


def test_pending_terminals_evict_on_ttl() -> None:
    """Pending terminals older than the TTL are dropped on trim."""
    import time as time_module

    from app.gateway.builder_progress import registry as registry_mod

    r = BuilderProgressRegistry()
    # Manually insert an "old" pending entry (bypass the public API
    # so we can backdate the timestamp).
    r._pending_terminals["t-old"] = registry_mod._PendingTerminal(
        timestamp=time_module.time() - 1000.0,  # >> 300s TTL
        summary="stale",
    )
    r._pending_terminals["t-fresh"] = registry_mod._PendingTerminal(
        timestamp=time_module.time(),
        summary="fresh",
    )
    # Trigger a trim. Use the locked variant since we're in a test
    # without coroutine context.
    with r._lock:
        r._trim_pending_terminals_locked()
    assert "t-old" not in r._pending_terminals
    assert "t-fresh" in r._pending_terminals


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
    pending = r._pending_terminals["t-fast-fail"]
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
    assert "t-1" in r._pending_terminals
    assert r._pending_terminals["t-1"].run_id == "r-OLD"

    # Now a NEW run for the same task_id registers (e.g. the user
    # already fired update_async_task in between).
    r.register_task(
        task_id="t-1", chat_id=1, message_id=2, channel_name="telegram", run_id="r-NEW"
    )
    await asyncio.sleep(0.05)

    # Pending was consumed by register_task but replay was DROPPED
    # because the run_id didn't match — so no edit fires and the
    # new placeholder stays active.
    assert captured == [], (
        "stale-run pending replay must NOT push an edit to the new placeholder"
    )
    assert r.has_task("t-1") is True


def test_pending_terminals_evict_on_cap() -> None:
    """When the pending-cache exceeds its cap, the OLDEST entries are
    dropped (FIFO via dict insertion order)."""
    import time as time_module

    from app.gateway.builder_progress import registry as registry_mod

    r = BuilderProgressRegistry()
    # Fill past the cap with FRESH timestamps so the TTL pass
    # doesn't drop them — we want to exercise the cap pass only.
    now = time_module.time()
    for i in range(registry_mod._PENDING_TERMINAL_CAP + 50):
        r._pending_terminals[f"t-{i:04d}"] = registry_mod._PendingTerminal(
            timestamp=now, summary=str(i)
        )
    with r._lock:
        r._trim_pending_terminals_locked()
    assert len(r._pending_terminals) <= registry_mod._PENDING_TERMINAL_CAP
    # Oldest entries evicted; newest preserved.
    last_idx = registry_mod._PENDING_TERMINAL_CAP + 49
    assert f"t-{last_idx:04d}" in r._pending_terminals
    assert "t-0000" not in r._pending_terminals


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
