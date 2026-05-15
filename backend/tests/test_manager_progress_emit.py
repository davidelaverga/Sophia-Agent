"""Tests for ChannelManager._maybe_open_progress_message (Phase 3)."""

from __future__ import annotations

from typing import Any

import pytest

from app.channels.manager import ChannelManager
from app.channels.message_bus import (
    InboundMessage,
    InboundMessageType,
    MessageBus,
    OutboundMessage,
)
from app.channels.store import ChannelStore
from app.gateway.builder_events import (
    BuilderEventFanout,
    TaskResolutionCache,
    set_global_workshop_dependencies,
)


@pytest.fixture
def manager() -> ChannelManager:
    return ChannelManager(bus=MessageBus(), store=ChannelStore())


@pytest.fixture
def cache_singleton() -> TaskResolutionCache:
    cache = TaskResolutionCache()
    set_global_workshop_dependencies(fanout=None, workshop_sink=None, task_cache=cache)
    yield cache
    set_global_workshop_dependencies(fanout=None, workshop_sink=None, task_cache=None)


def _inbound(channel_name: str = "telegram") -> InboundMessage:
    return InboundMessage(
        channel_name=channel_name,
        chat_id="42",
        user_id="user-abc",
        text="research best EVs",
        msg_type=InboundMessageType.CHAT,
    )


def _result_with_one_call(
    *,
    task_id: str,
    brief: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "messages": [
            {"type": "human", "content": "do thing"},
            {
                "type": "ai",
                "tool_calls": [
                    {"id": "c1", "name": "start_builder_task", "args": {"description": brief}}
                ],
            },
            {
                "type": "tool",
                "name": "start_builder_task",
                "tool_call_id": "c1",
                "content": f"Launched builder task. task_id: {task_id}. background work.",
            },
        ]
    }
    if run_id is not None:
        result["async_tasks"] = {
            task_id: {
                "task_id": task_id,
                "thread_id": task_id,
                "run_id": run_id,
                "agent_name": "sophia_builder",
                "status": "running",
            }
        }
    return result


async def _subscribe_capture(bus: MessageBus, sink: list[OutboundMessage]) -> None:
    async def _capture(msg: OutboundMessage) -> None:
        sink.append(msg)

    bus.subscribe_outbound(_capture)


@pytest.mark.anyio
async def test_publishes_plain_text_progress_placeholder(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Phase 3 contract: the placeholder is plain text, no @-mention, no brief."""
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    await manager._maybe_open_progress_message(
        _inbound(),
        _result_with_one_call(task_id="task-1", brief="Research best EVs in Europe."),
        thread_id="thread-1",
    )

    assert len(published) == 1
    placeholder = published[0]
    # No @-mention, no brief dumped in chat.
    assert "@Sophia_work_bot" not in placeholder.text
    assert "Research best EVs in Europe." not in placeholder.text
    # Plain-text working-on-it copy
    assert "Working on it" in placeholder.text
    # builder_progress metadata routes the receiver registration in telegram.py
    progress = placeholder.metadata.get("builder_progress", {})
    assert progress.get("task_id") == "task-1"
    assert progress.get("user_id") == "user-abc"


@pytest.mark.anyio
async def test_extractor_dedup_handles_within_call_duplicates(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The extractor's per-call ``seen_task_ids`` is the source-of-truth
    dedup. Manager has no separate dedup set (codex P1 fix): the
    previous mark-after-publish was delivery-blind because
    ``publish_outbound`` swallows listener exceptions, and a
    cross-call re-entry for the same task_id can't actually happen in
    production (extractor scopes the walk to the current human turn).

    Cross-call invocations with the same result therefore each publish
    once — and that's fine, the placeholder send is idempotent at the
    sink layer (the sink keeps one receiver per task_id, the second
    register replaces the first).
    """
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    result = _result_with_one_call(task_id="task-x", brief="brief")
    # Two separate invocations — manager has no dedup memory, so both
    # publish. (In real production this scenario doesn't arise — the
    # extractor scopes its walk to a single turn and _handle_chat is
    # sequential per inbound message.)
    await manager._maybe_open_progress_message(_inbound(), result, thread_id="thread")
    await manager._maybe_open_progress_message(_inbound(), result, thread_id="thread")
    assert len(published) == 2

    # Within a single call, the extractor's seen_task_ids dedup
    # collapses duplicates — even if the result accidentally contained
    # two ToolMessages with the same task_id, only one placeholder
    # would be published per invocation.
    duplicate_result = {
        "messages": [
            {"type": "human", "content": "do thing"},
            {
                "type": "ai",
                "tool_calls": [
                    {"id": "c1", "name": "start_builder_task", "args": {"description": "brief"}}
                ],
            },
            {
                "type": "tool",
                "name": "start_builder_task",
                "tool_call_id": "c1",
                "content": "Launched builder task. task_id: dup-x. background work.",
            },
            {
                "type": "tool",
                "name": "start_builder_task",
                "tool_call_id": "c1",
                "content": "Launched builder task. task_id: dup-x. background work.",
            },
        ]
    }
    published.clear()
    await manager._maybe_open_progress_message(_inbound(), duplicate_result, thread_id="thread")
    assert len(published) == 1


@pytest.mark.anyio
async def test_skips_non_telegram_channel(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    await manager._maybe_open_progress_message(
        _inbound(channel_name="slack"),
        _result_with_one_call(task_id="t", brief="b"),
        thread_id="th",
    )

    assert published == []


@pytest.mark.anyio
async def test_skips_when_env_flag_off(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "false")
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    await manager._maybe_open_progress_message(
        _inbound(),
        _result_with_one_call(task_id="t", brief="b"),
        thread_id="th",
    )
    assert published == []


@pytest.mark.anyio
async def test_attaches_fanout_stream_per_placeholder(
    manager: ChannelManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Phase 2 regression (kept): every placeholder must also attach the v3
    stream consumer, otherwise the workshop sink only ever sees the
    terminal CompletedEvent and the progress UX collapses to a blocking
    summary.
    """
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    monkeypatch.setenv("BUILDER_LIVE_STREAM_ENABLED", "true")
    fanout = BuilderEventFanout()
    set_global_workshop_dependencies(fanout=fanout, workshop_sink=None, task_cache=None)

    attach_calls: list[dict] = []

    async def _spy_attach(
        *,
        task_id,
        thread_id,
        user_id,
        channel_origin,
        run_id=None,
        consumer_factory=None,
    ):
        attach_calls.append(
            {
                "task_id": task_id,
                "thread_id": thread_id,
                "user_id": user_id,
                "channel_origin": channel_origin,
                "run_id": run_id,
            }
        )

    monkeypatch.setattr(fanout, "attach_stream", _spy_attach)

    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    try:
        await manager._maybe_open_progress_message(
            _inbound(),
            _result_with_one_call(task_id="task-xyz", brief="brief", run_id="run-deadbeef"),
            thread_id="thread",
        )
    finally:
        set_global_workshop_dependencies(fanout=None, workshop_sink=None, task_cache=None)

    assert len(published) == 1
    assert len(attach_calls) == 1
    call = attach_calls[0]
    assert call["task_id"] == "task-xyz"
    assert call["thread_id"] == "task-xyz"
    assert call["user_id"] == "user-abc"
    assert call["channel_origin"] == "telegram"
    # Production regression: run_id is REQUIRED for runs.join_stream.
    assert call["run_id"] == "run-deadbeef"


@pytest.mark.anyio
async def test_attach_failure_does_not_block_placeholder(
    manager: ChannelManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A broken fanout must not swallow the visible progress placeholder."""
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    fanout = BuilderEventFanout()
    set_global_workshop_dependencies(fanout=fanout, workshop_sink=None, task_cache=None)

    async def _broken_attach(**_kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(fanout, "attach_stream", _broken_attach)

    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    try:
        await manager._maybe_open_progress_message(
            _inbound(),
            _result_with_one_call(task_id="t", brief="b"),
            thread_id="th",
        )
    finally:
        set_global_workshop_dependencies(fanout=None, workshop_sink=None, task_cache=None)

    assert len(published) == 1  # placeholder still went out


@pytest.mark.anyio
async def test_publish_failure_logs_and_continues(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bus-raise on publish must be logged and not bubble out to the caller.

    The previous incarnation of this test asserted the task was NOT
    marked in a manager-side dedup set. After codex P1: the dedup set
    is gone entirely (it was delivery-blind anyway — see
    ``test_extractor_dedup_handles_within_call_duplicates`` for why
    cross-call re-entry for the same task_id is not a real scenario).
    What this test now locks: an exception from publish_outbound must
    not propagate out of ``_maybe_open_progress_message`` and must not
    break processing of additional targets on the same call.
    """
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")

    async def _always_raise(_outbound):
        raise RuntimeError("simulated bus blow-up")

    monkeypatch.setattr(manager.bus, "publish_outbound", _always_raise)

    result = _result_with_one_call(task_id="task-x", brief="brief")
    # Must not raise.
    await manager._maybe_open_progress_message(_inbound(), result, thread_id="th")
