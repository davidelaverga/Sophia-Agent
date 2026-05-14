"""Tests for ChannelManager.\\_maybe_emit_workshop_summons (Phase 2)."""

from __future__ import annotations

from typing import Any

import pytest

from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage
from app.channels.store import ChannelStore
from app.gateway.builder_events import (
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


def _result_with_one_call(*, task_id: str, brief: str) -> dict[str, Any]:
    return {
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


@pytest.mark.anyio
async def test_publishes_summon_outbound_with_metadata(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    published: list[OutboundMessage] = []

    async def _capture(msg: OutboundMessage) -> None:
        published.append(msg)

    manager.bus.subscribe_outbound(_capture)

    await manager._maybe_emit_workshop_summons(
        _inbound(),
        _result_with_one_call(task_id="task-1", brief="Research best EVs."),
        thread_id="thread-1",
    )

    assert len(published) == 1
    summon = published[0]
    assert summon.text.startswith("@Sophia_work_bot\n\n")
    assert "Research best EVs." in summon.text
    assert summon.metadata.get("workshop_summon", {}).get("task_id") == "task-1"
    assert summon.metadata.get("workshop_summon", {}).get("user_id") == "user-abc"


async def _subscribe_capture(bus: MessageBus, sink: list[OutboundMessage]) -> None:
    async def _capture(msg: OutboundMessage) -> None:
        sink.append(msg)

    bus.subscribe_outbound(_capture)


@pytest.mark.anyio
async def test_does_not_double_emit_for_same_task_id(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    result = _result_with_one_call(task_id="task-x", brief="brief")
    await manager._maybe_emit_workshop_summons(_inbound(), result, thread_id="thread")
    await manager._maybe_emit_workshop_summons(_inbound(), result, thread_id="thread")

    assert len(published) == 1


@pytest.mark.anyio
async def test_skips_non_telegram_channel(
    manager: ChannelManager, cache_singleton: TaskResolutionCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    await manager._maybe_emit_workshop_summons(
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

    await manager._maybe_emit_workshop_summons(
        _inbound(),
        _result_with_one_call(task_id="t", brief="b"),
        thread_id="th",
    )
    assert published == []


@pytest.mark.anyio
async def test_skips_when_no_task_cache_singleton(
    manager: ChannelManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TELEGRAM_WORKSHOP_BOT_ENABLED", "true")
    set_global_workshop_dependencies(fanout=None, workshop_sink=None, task_cache=None)
    published: list[OutboundMessage] = []
    await _subscribe_capture(manager.bus, published)

    await manager._maybe_emit_workshop_summons(
        _inbound(),
        _result_with_one_call(task_id="t", brief="b"),
        thread_id="th",
    )
    assert published == []
