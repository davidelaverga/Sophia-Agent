"""Tests for the gateway-side BuilderProgressRegistry.

Phase 4H of the v3 streaming migration. The registry maps
``task_id`` → placeholder anchor + per-task ``ProgressRenderer``, and
invokes a per-channel edit callback when phase / tool-call events
arrive via ``/internal/builder-progress``.
"""

from __future__ import annotations

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
    )
    assert r.has_task("t-1") is True
    assert r.has_task("t-other") is False


def test_unregister_task() -> None:
    r = BuilderProgressRegistry()
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")
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
    r.register_task(task_id="t-1", chat_id=42, message_id=99, channel_name="telegram")

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
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")

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
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")

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
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")

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
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")

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
    r = BuilderProgressRegistry()
    finalized = await r.mark_done(task_id="t-missing")
    assert finalized is False


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
    r.register_task(task_id="t-1", chat_id=1, message_id=2, channel_name="telegram")

    await r.apply_event(
        task_id="t-1",
        event_name="updates",
        data={"agent": {"messages": [{"tool_calls": [
            {"name": "builder_web_search", "args": {"query": "Zep memory"}}
        ]}]}},
    )
    assert any("🔍 Searching: Zep memory" in body for body in captured)
