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
