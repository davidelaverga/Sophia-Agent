"""Tests for ChannelManager._maybe_open_progress_placeholders (Phase 4D)."""

from __future__ import annotations

from typing import Any

import pytest

from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage
from app.channels.store import ChannelStore


@pytest.fixture
def manager() -> ChannelManager:
    return ChannelManager(bus=MessageBus(), store=ChannelStore())


def _inbound(channel_name: str = "telegram") -> InboundMessage:
    return InboundMessage(
        channel_name=channel_name,
        chat_id="42",
        user_id="user-abc",
        text="research best EVs",
        msg_type=InboundMessageType.CHAT,
    )


def _result_with_task(*, task_id: str, run_id: str | None = "run-xyz") -> dict[str, Any]:
    """A minimal ``runs.wait`` result dict with one builder task on async_tasks."""
    result: dict[str, Any] = {
        "messages": [
            {"type": "human", "content": "research best EVs"},
            {"type": "ai", "content": "On it."},
        ]
    }
    record: dict[str, Any] = {
        "task_id": task_id,
        "thread_id": task_id,
        "agent_name": "sophia_builder",
        "status": "running",
    }
    if run_id is not None:
        record["run_id"] = run_id
    result["async_tasks"] = {task_id: record}
    return result


async def _subscribe_capture(bus: MessageBus, sink: list[OutboundMessage]) -> None:
    async def _capture(msg: OutboundMessage) -> None:
        sink.append(msg)

    bus.subscribe_outbound(_capture)


@pytest.mark.anyio
async def test_emits_placeholder_for_new_builder_task(manager: ChannelManager) -> None:
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    await manager._maybe_open_progress_placeholders(
        _inbound(),
        _result_with_task(task_id="t1", run_id="r1"),
        thread_id="thread-A",
    )
    assert len(captured) == 1
    msg = captured[0]
    assert msg.text.startswith("Working on it")
    assert msg.metadata.get("builder_progress") == {
        "task_id": "t1",
        "run_id": "r1",
        "user_id": "user-abc",
    }


@pytest.mark.anyio
async def test_dedup_avoids_double_emission(manager: ChannelManager) -> None:
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    result = _result_with_task(task_id="t-once", run_id="r")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert len(captured) == 1


@pytest.mark.anyio
async def test_publish_failure_leaves_task_unmarked_for_retry(
    manager: ChannelManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If publish raises, the task is NOT marked — a follow-up turn retries."""
    flaky = {"calls": 0}

    async def _flaky_publish(_msg):
        flaky["calls"] += 1
        if flaky["calls"] == 1:
            raise RuntimeError("simulated bus failure")

    monkeypatch.setattr(manager.bus, "publish_outbound", _flaky_publish)

    result = _result_with_task(task_id="t-retry", run_id="r")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert "t-retry" not in manager._progress_task_ids
    # Second attempt — publish succeeds, task marked.
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert "t-retry" in manager._progress_task_ids


@pytest.mark.anyio
async def test_skips_non_telegram_channel(manager: ChannelManager) -> None:
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    await manager._maybe_open_progress_placeholders(
        _inbound(channel_name="slack"),
        _result_with_task(task_id="t-slack", run_id="r"),
        thread_id="th",
    )
    assert captured == []


@pytest.mark.anyio
async def test_skips_task_without_run_id(manager: ChannelManager) -> None:
    """Without ``run_id`` the subscriber can't call ``runs.join_stream`` —
    skip the placeholder rather than emit a dud."""
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    await manager._maybe_open_progress_placeholders(
        _inbound(),
        _result_with_task(task_id="t-no-run", run_id=None),
        thread_id="th",
    )
    assert captured == []


@pytest.mark.anyio
async def test_skips_non_builder_async_task(manager: ChannelManager) -> None:
    """``agent_name`` != ``sophia_builder`` → skip."""
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    result: dict[str, Any] = {
        "async_tasks": {
            "other-task": {
                "task_id": "other-task",
                "agent_name": "some_other_agent",
                "run_id": "r",
                "status": "running",
            }
        }
    }
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert captured == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    "terminal_status",
    ["success", "completed", "error", "failed", "cancelled", "timeout", "timed_out"],
)
async def test_skips_terminal_status_tasks(
    manager: ChannelManager, terminal_status: str
) -> None:
    """Codex P1 regression: historical builder rows from past turns persist
    in ``async_tasks``. On a gateway restart the per-process dedup set
    ``_progress_task_ids`` is empty, so without a status gate every
    completed-but-still-in-state task would re-emit a "Working on it…"
    placeholder for an already-finished run. Terminal statuses must be
    skipped entirely.
    """
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    result: dict[str, Any] = {
        "async_tasks": {
            "historical-task": {
                "task_id": "historical-task",
                "thread_id": "historical-task",
                "agent_name": "sophia_builder",
                "run_id": "old-run",
                "status": terminal_status,
            }
        }
    }
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert captured == [], (
        f"terminal status {terminal_status!r} must not re-emit a placeholder"
    )
    # And the task must NOT be added to the dedup set — that would silently
    # block a future legitimate (re-)dispatch of a task with the same id.
    assert "historical-task" not in manager._progress_task_ids


@pytest.mark.anyio
async def test_terminal_status_check_is_case_insensitive(
    manager: ChannelManager,
) -> None:
    """Different middlewares may write status as "Completed" / "ERROR" /
    " success "; the gate normalizes before comparing."""
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    result: dict[str, Any] = {
        "async_tasks": {
            "t-cased": {
                "task_id": "t-cased",
                "thread_id": "t-cased",
                "agent_name": "sophia_builder",
                "run_id": "r",
                "status": "  Completed  ",
            }
        }
    }
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert captured == []


@pytest.mark.anyio
async def test_unknown_status_is_treated_as_active(manager: ChannelManager) -> None:
    """Default-active is the safer behaviour: an unrecognized status like
    ``pending`` / ``interrupted`` / future LangGraph states must NOT be
    treated as terminal — they're still-active runs we should subscribe to.
    Mirrors the duplicate-launch protection in start_builder_task."""
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    result: dict[str, Any] = {
        "async_tasks": {
            "t-pending": {
                "task_id": "t-pending",
                "thread_id": "t-pending",
                "agent_name": "sophia_builder",
                "run_id": "r",
                "status": "pending",
            }
        }
    }
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert len(captured) == 1


def test_trim_progress_set_evicts_oldest_not_arbitrary(
    manager: ChannelManager,
) -> None:
    """Codex P2 regression: dedup storage MUST be insertion-ordered so
    the trim path evicts the OLDEST entries (FIFO). The previous ``set``
    implementation evicted hash-table-order entries — which could drop
    a just-added in-flight task_id and let the same active build
    re-emit a duplicate "Working on it…" on the next companion turn.

    This test fills the dedup storage past the 1024 cap, then verifies
    that the OLDEST entries are gone and the NEWEST are still tracked.
    """
    # Fill the structure past the cap with deterministically-ordered keys.
    # The manager's bookkeeping does:  self._progress_task_ids[k] = None
    # so we mirror that pattern instead of going through the full
    # placeholder path (which requires Telegram-channel msg + bus + etc).
    for i in range(1100):
        manager._progress_task_ids[f"t-{i:04d}"] = None
        manager._trim_progress_set()

    # After the final trim the size must be at most 1024 (cap) - 256
    # (evicted on the last overflow) + 1 (the just-added one) = 769,
    # OR somewhere between that and the cap depending on how many
    # times the trim fired across the 1100 insertions. The contract
    # the test really cares about is: oldest gone, newest present.
    assert "t-0000" not in manager._progress_task_ids, (
        "FIFO trim must evict the oldest entries"
    )
    assert "t-1099" in manager._progress_task_ids, (
        "FIFO trim must NEVER evict the most-recently-added entry"
    )
    # And the cap is respected.
    assert len(manager._progress_task_ids) <= 1024


def test_trim_progress_set_no_op_when_under_cap(manager: ChannelManager) -> None:
    """Trim is a no-op when the structure is at or under 1024 entries."""
    for i in range(500):
        manager._progress_task_ids[f"t-{i:04d}"] = None
    before = dict(manager._progress_task_ids)
    manager._trim_progress_set()
    assert manager._progress_task_ids == before
