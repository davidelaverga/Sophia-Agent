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
    async def _capture(msg: OutboundMessage) -> bool:
        # Phase 4M (post-Phase-4K-rollback codex P1): listeners must
        # return True to signal "I handled this message" so
        # publish_outbound_strict can confirm a real channel consumed
        # the placeholder. Returning None would treat this capturing
        # stub as a no-op (channel-mismatch case) and the manager's
        # strict path would report undelivered, skipping the dedup
        # mark these tests rely on.
        sink.append(msg)
        return True

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
    """If the strict publish raises (bus-level failure, NOT listener
    failure), the task is NOT marked — a follow-up turn retries.

    Phase 4F codex P1 (post-review, fourth pass): the manager now
    calls ``publish_outbound_strict``. Patch that method, not the
    swallow-flavored ``publish_outbound``.
    """
    flaky = {"calls": 0}

    async def _flaky_publish(_msg):
        flaky["calls"] += 1
        if flaky["calls"] == 1:
            raise RuntimeError("simulated bus failure")
        return True  # subsequent calls: delivered=True

    monkeypatch.setattr(manager.bus, "publish_outbound_strict", _flaky_publish)

    result = _result_with_task(task_id="t-retry", run_id="r")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    # Phase 4F codex P1 post-review: dedup key is (task_id, run_id).
    assert ("t-retry", "r") not in manager._progress_task_ids
    # Second attempt — publish succeeds, task marked.
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert ("t-retry", "r") in manager._progress_task_ids


@pytest.mark.anyio
async def test_listener_failure_does_not_mark_dedup(
    manager: ChannelManager,
) -> None:
    """Codex P1 (post-Phase-4F review, fourth pass) regression: the
    real Telegram listener raises on transient send failures (network
    error, Telegram 5xx). ``publish_outbound`` swallows those — but
    ``publish_outbound_strict`` returns False.

    The manager MUST NOT mark the dedup on False, because that would
    permanently block retries and the run would get no live progress
    subscriber at all. Subsequent turns retry; the dedup is only
    marked when a listener actually accepted the placeholder without
    raising.
    """
    # Subscribe a listener that always raises — simulates a Telegram
    # channel whose ``send`` is hitting transient errors.
    async def _failing_listener(_msg):
        raise RuntimeError("simulated transient Telegram send failure")

    manager.bus.subscribe_outbound(_failing_listener)

    result = _result_with_task(task_id="t-flaky-listener", run_id="r-1")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")

    # Listener raised → strict returned False → dedup NOT marked.
    assert ("t-flaky-listener", "r-1") not in manager._progress_task_ids, (
        "listener failure must NOT mark the dedup — retry on next turn"
    )

    # Now swap in a successful listener and retry on the next turn.
    # (Simulates the network issue resolving.)
    manager.bus.unsubscribe_outbound(_failing_listener)
    delivered_msgs: list[OutboundMessage] = []

    async def _good_listener(msg):
        # Phase 4M: listeners must return True to signal "I handled
        # this message" so publish_outbound_strict can confirm a
        # real channel consumed the placeholder (not just a no-op
        # from a mismatched-channel listener).
        delivered_msgs.append(msg)
        return True

    manager.bus.subscribe_outbound(_good_listener)
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert len(delivered_msgs) == 1
    assert ("t-flaky-listener", "r-1") in manager._progress_task_ids


@pytest.mark.anyio
async def test_real_channel_send_failure_does_not_mark_dedup(
    manager: ChannelManager,
) -> None:
    """End-to-end regression for codex P1 fifth pass: a real
    ``Channel`` subclass whose ``send`` raises must flip the dedup
    decision to False all the way through the chain:

        manager._maybe_open_progress_placeholders
            → bus.publish_outbound_strict
                → Channel._on_outbound (subscribed)
                    → self.send (raises)
                ← _on_outbound RE-RAISES (codex P1 fifth pass)
            ← strict returns False
        ← manager skips dedup mark

    Before the fifth-pass fix, ``Channel._on_outbound`` caught the
    exception and returned silently, so the strict variant saw no
    raise and returned True — the manager marked the dedup for a
    placeholder that never reached the user, and subsequent turns
    skipped re-emitting indefinitely.
    """
    from app.channels.base import Channel

    class _BrokenChannel(Channel):
        def __init__(self, bus_):
            super().__init__(name="telegram", bus=bus_, config={})

        async def start(self):
            self._running = True
            self.bus.subscribe_outbound(self._on_outbound)

        async def stop(self):
            self._running = False
            self.bus.unsubscribe_outbound(self._on_outbound)

        async def send(self, _msg):
            raise RuntimeError("simulated transient Telegram API error")

    channel = _BrokenChannel(manager.bus)
    await channel.start()
    try:
        result = _result_with_task(task_id="t-real-fail", run_id="r-1")
        await manager._maybe_open_progress_placeholders(
            _inbound(), result, thread_id="th"
        )
        assert ("t-real-fail", "r-1") not in manager._progress_task_ids, (
            "real Channel.send failure must flip delivered=False through "
            "the strict variant and leave the dedup unmarked"
        )
    finally:
        await channel.stop()


@pytest.mark.anyio
async def test_listener_failure_with_mixed_listeners_still_does_not_mark(
    manager: ChannelManager,
) -> None:
    """Even if SOME listeners succeed, a single raising listener flips
    delivered=False and the dedup stays unmarked. Conservative for the
    placeholder path: better to retry one too many times than to
    permanently silence a run."""
    async def _failing(_msg):
        raise RuntimeError("boom")

    async def _ok(_msg):
        return None

    manager.bus.subscribe_outbound(_failing)
    manager.bus.subscribe_outbound(_ok)

    result = _result_with_task(task_id="t-mixed", run_id="r")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert ("t-mixed", "r") not in manager._progress_task_ids


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
    [
        "success",
        "completed",
        "error",
        "failed",
        "cancelled",
        "timeout",
        "timed_out",
        # Phase 4F codex P2 post-review: ``interrupted`` runs are
        # suspended (awaiting resume) or already replaced by a new run
        # — either way they produce no further stream events, so
        # subscribing would just stall.
        "interrupted",
    ],
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
    # And the task must NOT be added to the dedup dict — that would silently
    # block a future legitimate (re-)dispatch of a task with the same id.
    # Phase 4F codex P1 post-review: dedup key is (task_id, run_id).
    assert ("historical-task", "old-run") not in manager._progress_task_ids


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

    Phase 4F codex P1 post-review: keys are ``(task_id, run_id)`` tuples.
    """
    # Fill the structure past the cap with deterministically-ordered keys.
    for i in range(1100):
        manager._progress_task_ids[(f"t-{i:04d}", "r")] = None
        manager._trim_progress_set()

    assert ("t-0000", "r") not in manager._progress_task_ids, (
        "FIFO trim must evict the oldest entries"
    )
    assert ("t-1099", "r") in manager._progress_task_ids, (
        "FIFO trim must NEVER evict the most-recently-added entry"
    )
    # And the cap is respected.
    assert len(manager._progress_task_ids) <= 1024


def test_trim_progress_set_no_op_when_under_cap(manager: ChannelManager) -> None:
    """Trim is a no-op when the structure is at or under 1024 entries."""
    for i in range(500):
        manager._progress_task_ids[(f"t-{i:04d}", "r")] = None
    before = dict(manager._progress_task_ids)
    manager._trim_progress_set()
    assert manager._progress_task_ids == before


@pytest.mark.anyio
async def test_update_flow_new_run_id_re_emits_placeholder(
    manager: ChannelManager,
) -> None:
    """Codex P1 (post-Phase-4F, second pass) regression: ``update_async_task``
    keeps the same task_id but creates a new run with a new run_id.
    With dedup-by-task_id-alone, the second placeholder would be
    silently skipped — original subscriber stays on the interrupted
    run (no events), new run has no subscriber, Telegram freezes.

    Dedup by ``(task_id, run_id)`` ensures the replacement run gets
    its own placeholder + subscriber.
    """
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    # Turn 1: original dispatch — task_id=t-1, run_id=r-1.
    result_1 = _result_with_task(task_id="t-1", run_id="r-1")
    await manager._maybe_open_progress_placeholders(_inbound(), result_1, thread_id="th")
    assert len(captured) == 1
    assert captured[0].metadata["builder_progress"]["run_id"] == "r-1"

    # Turn 2: user fired ``update_async_task`` — same task_id, new run_id.
    # The deepagents middleware overwrites async_tasks[task_id] with the
    # new run record (see deepagents async_subagents.py::update_async_task).
    result_2 = _result_with_task(task_id="t-1", run_id="r-2")
    await manager._maybe_open_progress_placeholders(_inbound(), result_2, thread_id="th")
    assert len(captured) == 2, (
        "update_async_task (new run_id on same task_id) MUST trigger a "
        "second placeholder so a fresh subscriber attaches to the replacement run"
    )
    assert captured[1].metadata["builder_progress"]["run_id"] == "r-2"
    # And both dedup keys are tracked.
    assert ("t-1", "r-1") in manager._progress_task_ids
    assert ("t-1", "r-2") in manager._progress_task_ids


@pytest.mark.anyio
async def test_same_task_id_same_run_id_still_dedups(
    manager: ChannelManager,
) -> None:
    """The dedup key is ``(task_id, run_id)`` so an identical
    (task_id, run_id) pair on a subsequent turn is still skipped.
    """
    captured: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, captured)

    result = _result_with_task(task_id="t-1", run_id="r-1")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    await manager._maybe_open_progress_placeholders(_inbound(), result, thread_id="th")
    assert len(captured) == 1
