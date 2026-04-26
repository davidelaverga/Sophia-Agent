"""Tests for the IM channel system (MessageBus, ChannelStore, ChannelManager)."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.channels.base import Channel
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage
from app.channels.store import ChannelStore


def _run(coro):
    """Run an async coroutine synchronously."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _wait_for(condition, *, timeout=5.0, interval=0.05):
    """Poll *condition* until it returns True, or raise after *timeout* seconds."""
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        await asyncio.sleep(interval)
    raise TimeoutError(f"Condition not met within {timeout}s")


# ---------------------------------------------------------------------------
# MessageBus tests
# ---------------------------------------------------------------------------


class TestMessageBus:
    def test_publish_and_get_inbound(self):
        bus = MessageBus()

        async def go():
            msg = InboundMessage(
                channel_name="test",
                chat_id="chat1",
                user_id="user1",
                text="hello",
            )
            await bus.publish_inbound(msg)
            result = await bus.get_inbound()
            assert result.text == "hello"
            assert result.channel_name == "test"
            assert result.chat_id == "chat1"

        _run(go())

    def test_inbound_queue_is_fifo(self):
        bus = MessageBus()

        async def go():
            for i in range(3):
                await bus.publish_inbound(InboundMessage(channel_name="test", chat_id="c", user_id="u", text=f"msg{i}"))
            for i in range(3):
                msg = await bus.get_inbound()
                assert msg.text == f"msg{i}"

        _run(go())

    def test_outbound_callback(self):
        bus = MessageBus()
        received = []

        async def callback(msg):
            received.append(msg)

        async def go():
            bus.subscribe_outbound(callback)
            out = OutboundMessage(channel_name="test", chat_id="c1", thread_id="t1", text="reply")
            await bus.publish_outbound(out)
            assert len(received) == 1
            assert received[0].text == "reply"

        _run(go())

    def test_unsubscribe_outbound(self):
        bus = MessageBus()
        received = []

        async def callback(msg):
            received.append(msg)

        async def go():
            bus.subscribe_outbound(callback)
            bus.unsubscribe_outbound(callback)
            out = OutboundMessage(channel_name="test", chat_id="c1", thread_id="t1", text="reply")
            await bus.publish_outbound(out)
            assert len(received) == 0

        _run(go())

    def test_outbound_error_does_not_crash(self):
        bus = MessageBus()

        async def bad_callback(msg):
            raise ValueError("boom")

        received = []

        async def good_callback(msg):
            received.append(msg)

        async def go():
            bus.subscribe_outbound(bad_callback)
            bus.subscribe_outbound(good_callback)
            out = OutboundMessage(channel_name="test", chat_id="c1", thread_id="t1", text="reply")
            await bus.publish_outbound(out)
            assert len(received) == 1

        _run(go())

    def test_inbound_message_defaults(self):
        msg = InboundMessage(channel_name="test", chat_id="c", user_id="u", text="hi")
        assert msg.msg_type == InboundMessageType.CHAT
        assert msg.thread_ts is None
        assert msg.files == []
        assert msg.metadata == {}
        assert msg.created_at > 0

    def test_outbound_message_defaults(self):
        msg = OutboundMessage(channel_name="test", chat_id="c", thread_id="t", text="hi")
        assert msg.artifacts == []
        assert msg.is_final is True
        assert msg.thread_ts is None
        assert msg.metadata == {}


# ---------------------------------------------------------------------------
# ChannelStore tests
# ---------------------------------------------------------------------------


class TestChannelStore:
    @pytest.fixture
    def store(self, tmp_path):
        return ChannelStore(path=tmp_path / "store.json")

    def test_set_and_get_thread_id(self, store):
        store.set_thread_id("slack", "ch1", "thread-abc", user_id="u1")
        assert store.get_thread_id("slack", "ch1") == "thread-abc"

    def test_get_nonexistent_returns_none(self, store):
        assert store.get_thread_id("slack", "nonexistent") is None

    def test_remove(self, store):
        store.set_thread_id("slack", "ch1", "t1")
        assert store.remove("slack", "ch1") is True
        assert store.get_thread_id("slack", "ch1") is None

    def test_remove_nonexistent_returns_false(self, store):
        assert store.remove("slack", "nope") is False

    def test_list_entries_all(self, store):
        store.set_thread_id("slack", "ch1", "t1")
        store.set_thread_id("feishu", "ch2", "t2")
        entries = store.list_entries()
        assert len(entries) == 2

    def test_list_entries_filtered(self, store):
        store.set_thread_id("slack", "ch1", "t1")
        store.set_thread_id("feishu", "ch2", "t2")
        entries = store.list_entries(channel_name="slack")
        assert len(entries) == 1
        assert entries[0]["channel_name"] == "slack"

    def test_persistence(self, tmp_path):
        path = tmp_path / "store.json"
        store1 = ChannelStore(path=path)
        store1.set_thread_id("slack", "ch1", "t1")

        store2 = ChannelStore(path=path)
        assert store2.get_thread_id("slack", "ch1") == "t1"

    def test_update_preserves_created_at(self, store):
        store.set_thread_id("slack", "ch1", "t1")
        entries = store.list_entries()
        created_at = entries[0]["created_at"]

        store.set_thread_id("slack", "ch1", "t2")
        entries = store.list_entries()
        assert entries[0]["created_at"] == created_at
        assert entries[0]["thread_id"] == "t2"
        assert entries[0]["updated_at"] >= created_at

    def test_corrupt_file_handled(self, tmp_path):
        path = tmp_path / "store.json"
        path.write_text("not json", encoding="utf-8")
        store = ChannelStore(path=path)
        assert store.get_thread_id("x", "y") is None


# ---------------------------------------------------------------------------
# Channel base class tests
# ---------------------------------------------------------------------------


class DummyChannel(Channel):
    """Concrete test implementation of Channel."""

    def __init__(self, bus, config=None):
        super().__init__(name="dummy", bus=bus, config=config or {})
        self.sent_messages: list[OutboundMessage] = []
        self._running = False

    async def start(self):
        self._running = True
        self.bus.subscribe_outbound(self._on_outbound)

    async def stop(self):
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)

    async def send(self, msg: OutboundMessage):
        self.sent_messages.append(msg)


class TestChannelBase:
    def test_make_inbound(self):
        bus = MessageBus()
        ch = DummyChannel(bus)
        msg = ch._make_inbound(
            chat_id="c1",
            user_id="u1",
            text="hello",
            msg_type=InboundMessageType.COMMAND,
        )
        assert msg.channel_name == "dummy"
        assert msg.chat_id == "c1"
        assert msg.text == "hello"
        assert msg.msg_type == InboundMessageType.COMMAND

    def test_on_outbound_routes_to_channel(self):
        bus = MessageBus()
        ch = DummyChannel(bus)

        async def go():
            await ch.start()
            msg = OutboundMessage(channel_name="dummy", chat_id="c1", thread_id="t1", text="hi")
            await bus.publish_outbound(msg)
            assert len(ch.sent_messages) == 1

        _run(go())

    def test_on_outbound_ignores_other_channels(self):
        bus = MessageBus()
        ch = DummyChannel(bus)

        async def go():
            await ch.start()
            msg = OutboundMessage(channel_name="other", chat_id="c1", thread_id="t1", text="hi")
            await bus.publish_outbound(msg)
            assert len(ch.sent_messages) == 0

        _run(go())


# ---------------------------------------------------------------------------
# _extract_response_text tests
# ---------------------------------------------------------------------------


class TestExtractResponseText:
    def test_string_content(self):
        from app.channels.manager import _extract_response_text

        result = {"messages": [{"type": "ai", "content": "hello"}]}
        assert _extract_response_text(result) == "hello"

    def test_list_content_blocks(self):
        from app.channels.manager import _extract_response_text

        result = {"messages": [{"type": "ai", "content": [{"type": "text", "text": "hello"}, {"type": "text", "text": " world"}]}]}
        assert _extract_response_text(result) == "hello world"

    def test_picks_last_ai_message(self):
        from app.channels.manager import _extract_response_text

        result = {
            "messages": [
                {"type": "ai", "content": "first"},
                {"type": "human", "content": "question"},
                {"type": "ai", "content": "second"},
            ]
        }
        assert _extract_response_text(result) == "second"

    def test_empty_messages(self):
        from app.channels.manager import _extract_response_text

        assert _extract_response_text({"messages": []}) == ""

    def test_no_ai_messages(self):
        from app.channels.manager import _extract_response_text

        result = {"messages": [{"type": "human", "content": "hi"}]}
        assert _extract_response_text(result) == ""

    def test_list_result(self):
        from app.channels.manager import _extract_response_text

        result = [{"type": "ai", "content": "from list"}]
        assert _extract_response_text(result) == "from list"

    def test_skips_empty_ai_content(self):
        from app.channels.manager import _extract_response_text

        result = {
            "messages": [
                {"type": "ai", "content": ""},
                {"type": "ai", "content": "actual response"},
            ]
        }
        assert _extract_response_text(result) == "actual response"

    def test_clarification_tool_message(self):
        from app.channels.manager import _extract_response_text

        result = {
            "messages": [
                {"type": "human", "content": "健身"},
                {"type": "ai", "content": "", "tool_calls": [{"name": "ask_clarification", "args": {"question": "您想了解哪方面？"}}]},
                {"type": "tool", "name": "ask_clarification", "content": "您想了解哪方面？"},
            ]
        }
        assert _extract_response_text(result) == "您想了解哪方面？"

    def test_clarification_over_empty_ai(self):
        """When AI content is empty but ask_clarification tool message exists, use the tool message."""
        from app.channels.manager import _extract_response_text

        result = {
            "messages": [
                {"type": "ai", "content": ""},
                {"type": "tool", "name": "ask_clarification", "content": "Could you clarify?"},
            ]
        }
        assert _extract_response_text(result) == "Could you clarify?"

    def test_does_not_leak_previous_turn_text(self):
        """When current turn AI has no text (only tool calls), do not return previous turn's text."""
        from app.channels.manager import _extract_response_text

        result = {
            "messages": [
                {"type": "human", "content": "hello"},
                {"type": "ai", "content": "Hi there!"},
                {"type": "human", "content": "export data"},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [{"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/data.csv"]}}],
                },
                {"type": "tool", "name": "present_files", "content": "ok"},
            ]
        }
        # Should return "" (no text in current turn), NOT "Hi there!" from previous turn
        assert _extract_response_text(result) == ""


# ---------------------------------------------------------------------------
# ChannelManager tests
# ---------------------------------------------------------------------------


def _make_mock_langgraph_client(thread_id="test-thread-123", run_result=None):
    """Create a mock langgraph_sdk async client."""
    mock_client = MagicMock()

    # threads.create() returns a Thread-like dict
    mock_client.threads.create = AsyncMock(return_value={"thread_id": thread_id})

    # threads.get() returns thread info (succeeds by default)
    mock_client.threads.get = AsyncMock(return_value={"thread_id": thread_id})

    # runs.wait() returns the final state with messages
    if run_result is None:
        run_result = {
            "messages": [
                {"type": "human", "content": "hi"},
                {"type": "ai", "content": "Hello from agent!"},
            ]
        }
    mock_client.runs.wait = AsyncMock(return_value=run_result)

    return mock_client


def _make_stream_part(event: str, data):
    return SimpleNamespace(event=event, data=data)


def _make_async_iterator(items):
    async def iterator():
        for item in items:
            yield item

    return iterator()


def _make_failing_async_iterator(exc: BaseException):
    async def iterator():
        raise exc
        yield  # pragma: no cover

    return iterator()


def _make_http_status_error(status_code: int, body: str = '{"detail":"Thread or assistant not found."}') -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://langgraph.test/threads/stale-thread/runs/wait")
    response = httpx.Response(status_code, text=body, request=request)
    return httpx.HTTPStatusError(
        f"Client error '{status_code}' for url '{request.url}'",
        request=request,
        response=response,
    )


class TestChannelManager:
    def test_handle_chat_creates_thread(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            mock_client = _make_mock_langgraph_client()
            manager._client = mock_client

            await manager.start()

            inbound = InboundMessage(channel_name="test", chat_id="chat1", user_id="user1", text="hi")
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            # Thread should be created on the LangGraph Server
            mock_client.threads.create.assert_called_once()

            # Thread ID should be stored
            thread_id = store.get_thread_id("test", "chat1")
            assert thread_id == "test-thread-123"

            # runs.wait should be called with the thread_id
            mock_client.runs.wait.assert_called_once()
            call_args = mock_client.runs.wait.call_args
            assert call_args[0][0] == "test-thread-123"  # thread_id
            assert call_args[0][1] == "lead_agent"  # assistant_id
            assert call_args[1]["input"]["messages"][0]["content"] == "hi"

            assert len(outbound_received) == 1
            assert outbound_received[0].text == "Hello from agent!"

        _run(go())

    def test_handle_chat_recovers_stale_langgraph_thread_once(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            store.set_thread_id("telegram", "chat1", "stale-thread", user_id="user1")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            recovered_result = {
                "messages": [
                    {"type": "human", "content": "hi"},
                    {"type": "ai", "content": "Recovered thread response"},
                ]
            }
            mock_client = _make_mock_langgraph_client(thread_id="fresh-thread")
            mock_client.threads.get = AsyncMock(side_effect=_make_http_status_error(404, '{"detail":"Thread not found."}'))
            mock_client.runs.wait = AsyncMock(side_effect=[_make_http_status_error(404), recovered_result])
            manager._client = mock_client

            await manager.start()
            await bus.publish_inbound(InboundMessage(channel_name="telegram", chat_id="chat1", user_id="user1", text="hi"))
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert store.get_thread_id("telegram", "chat1") == "fresh-thread"
            mock_client.threads.create.assert_called_once()
            assert mock_client.runs.wait.call_count == 2
            assert [call.args[0] for call in mock_client.runs.wait.call_args_list] == ["stale-thread", "fresh-thread"]
            assert outbound_received[0].thread_id == "fresh-thread"
            assert outbound_received[0].text == "Recovered thread response"

        _run(go())

    def test_handle_chat_does_not_recover_when_assistant_missing_but_thread_exists(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            store.set_thread_id("telegram", "chat1", "existing-thread", user_id="user1")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            mock_client = _make_mock_langgraph_client(thread_id="fresh-thread")
            mock_client.threads.get = AsyncMock(return_value={"thread_id": "existing-thread"})
            mock_client.runs.wait = AsyncMock(side_effect=_make_http_status_error(404))
            manager._client = mock_client

            await manager.start()
            await bus.publish_inbound(InboundMessage(channel_name="telegram", chat_id="chat1", user_id="user1", text="hi"))
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert store.get_thread_id("telegram", "chat1") == "existing-thread"
            mock_client.threads.get.assert_called_once_with("existing-thread")
            mock_client.threads.create.assert_not_called()
            mock_client.runs.wait.assert_called_once()
            assert outbound_received[0].text == "An internal error occurred. Please try again."

        _run(go())

    def test_handle_chat_does_not_recover_unrelated_404(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            store.set_thread_id("telegram", "chat1", "stale-thread", user_id="user1")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            mock_client = _make_mock_langgraph_client(thread_id="fresh-thread")
            mock_client.runs.wait = AsyncMock(side_effect=_make_http_status_error(404, '{"detail":"Run not found."}'))
            manager._client = mock_client

            await manager.start()
            await bus.publish_inbound(InboundMessage(channel_name="telegram", chat_id="chat1", user_id="user1", text="hi"))
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert store.get_thread_id("telegram", "chat1") == "stale-thread"
            mock_client.threads.create.assert_not_called()
            mock_client.runs.wait.assert_called_once()
            assert outbound_received[0].text == "An internal error occurred. Please try again."

        _run(go())

    def test_handle_chat_does_not_recover_5xx(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            store.set_thread_id("telegram", "chat1", "stale-thread", user_id="user1")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            mock_client = _make_mock_langgraph_client(thread_id="fresh-thread")
            mock_client.runs.wait = AsyncMock(side_effect=_make_http_status_error(503, "Service unavailable"))
            manager._client = mock_client

            await manager.start()
            await bus.publish_inbound(InboundMessage(channel_name="telegram", chat_id="chat1", user_id="user1", text="hi"))
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert store.get_thread_id("telegram", "chat1") == "stale-thread"
            mock_client.threads.create.assert_not_called()
            mock_client.runs.wait.assert_called_once()
            assert outbound_received[0].text == "An internal error occurred. Please try again."

        _run(go())

    def test_handle_chat_uses_channel_session_overrides(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(
                bus=bus,
                store=store,
                channel_sessions={
                    "telegram": {
                        "assistant_id": "mobile_agent",
                        "config": {"recursion_limit": 55},
                        "context": {
                            "thinking_enabled": False,
                            "subagent_enabled": True,
                        },
                    }
                },
            )

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            mock_client = _make_mock_langgraph_client()
            manager._client = mock_client

            await manager.start()

            inbound = InboundMessage(channel_name="telegram", chat_id="chat1", user_id="user1", text="hi")
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            mock_client.runs.wait.assert_called_once()
            call_args = mock_client.runs.wait.call_args
            assert call_args[0][1] == "mobile_agent"
            assert call_args[1]["config"]["recursion_limit"] == 55
            assert call_args[1]["context"]["thinking_enabled"] is False
            assert call_args[1]["context"]["subagent_enabled"] is True

        _run(go())

    def test_handle_chat_uses_user_session_overrides(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(
                bus=bus,
                store=store,
                default_session={"context": {"is_plan_mode": True}},
                channel_sessions={
                    "telegram": {
                        "assistant_id": "mobile_agent",
                        "config": {"recursion_limit": 55},
                        "context": {
                            "thinking_enabled": False,
                            "subagent_enabled": False,
                        },
                        "users": {
                            "vip-user": {
                                "assistant_id": "vip_agent",
                                "config": {"recursion_limit": 77},
                                "context": {
                                    "thinking_enabled": True,
                                    "subagent_enabled": True,
                                },
                            }
                        },
                    }
                },
            )

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            mock_client = _make_mock_langgraph_client()
            manager._client = mock_client

            await manager.start()

            inbound = InboundMessage(channel_name="telegram", chat_id="chat1", user_id="vip-user", text="hi")
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            mock_client.runs.wait.assert_called_once()
            call_args = mock_client.runs.wait.call_args
            assert call_args[0][1] == "vip_agent"
            assert call_args[1]["config"]["recursion_limit"] == 77
            assert call_args[1]["context"]["thinking_enabled"] is True
            assert call_args[1]["context"]["subagent_enabled"] is True
            assert call_args[1]["context"]["is_plan_mode"] is True

        _run(go())

    def test_resolve_run_params_propagates_user_id_via_context_only(self):
        """Telegram user_id MUST be propagated via `context` ONLY, not via
        `config.configurable`. langgraph-api 0.7+ rejects requests that set
        both with `400 "Cannot specify both configurable and context."`
        (langgraph_api/models/run.py:225). When only context is set, the
        server copies it into configurable (run.py:233), so Sophia's
        factories still see `cfg["user_id"]`."""
        from app.channels.manager import ChannelManager

        bus = MessageBus()
        store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
        manager = ChannelManager(
            bus=bus,
            store=store,
            channel_sessions={
                "telegram": {
                    "assistant_id": "sophia_companion",
                    "context": {"platform": "text", "context_mode": "life"},
                }
            },
        )

        msg = InboundMessage(channel_name="telegram", chat_id="123", user_id="7681651928", text="hello")
        assistant_id, run_config, run_context = manager._resolve_run_params(msg, "thread-abc")

        assert assistant_id == "sophia_companion"
        # user_id MUST be in context, NOT in configurable.
        assert run_context["user_id"] == "7681651928"
        configurable = run_config.get("configurable") or {}
        assert "user_id" not in configurable, (
            "Manager must NOT populate config.configurable.user_id — "
            "langgraph-api 0.7+ raises 400 when both configurable and context "
            "are set on the request."
        )
        assert run_context["thread_id"] == "thread-abc"
        assert run_context["platform"] == "text"
        assert run_context["context_mode"] == "life"

    def test_resolve_run_params_session_configurable_does_not_force_conflict(self):
        """If a channel's session config explicitly provides
        `config.configurable`, the manager preserves that user-supplied value
        as-is (the session author opted into the legacy path knowingly). The
        manager itself never adds user_id to configurable; it only adds it to
        context."""
        from app.channels.manager import ChannelManager

        bus = MessageBus()
        store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
        manager = ChannelManager(
            bus=bus,
            store=store,
            channel_sessions={
                "telegram": {
                    "users": {
                        "vip-user": {
                            "config": {"configurable": {"user_id": "canonical-vip"}},
                        }
                    }
                }
            },
        )

        msg = InboundMessage(channel_name="telegram", chat_id="c", user_id="vip-user", text="hi")
        _, run_config, run_context = manager._resolve_run_params(msg, "thread-1")

        # Session-author-supplied configurable.user_id is left alone (user opted in).
        assert run_config["configurable"]["user_id"] == "canonical-vip"
        # Manager still populates context.user_id from msg.user_id (which becomes
        # the canonical id post-_apply_canonical_user_id rewrite).
        assert run_context["user_id"] == "vip-user"

    def test_resolve_run_params_skips_user_id_when_msg_user_id_empty(self):
        """If msg.user_id is empty, the manager must NOT add a user_id key to
        either configurable or context — let make_sophia_agent fall back to
        its defensive default."""
        from app.channels.manager import ChannelManager

        bus = MessageBus()
        store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
        manager = ChannelManager(bus=bus, store=store)

        msg = InboundMessage(channel_name="telegram", chat_id="c", user_id="", text="hi")
        _, run_config, run_context = manager._resolve_run_params(msg, "thread-1")

        configurable = run_config.get("configurable") or {}
        assert "user_id" not in configurable
        assert "user_id" not in run_context
        assert run_context["thread_id"] == "thread-1"

    def test_handle_feishu_chat_streams_multiple_outbound_updates(self, monkeypatch):
        from app.channels.manager import ChannelManager

        monkeypatch.setattr("app.channels.manager.STREAM_UPDATE_MIN_INTERVAL_SECONDS", 0.0)

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            stream_events = [
                _make_stream_part(
                    "messages-tuple",
                    [
                        {"id": "ai-1", "content": "Hello", "type": "AIMessageChunk"},
                        {"langgraph_node": "agent"},
                    ],
                ),
                _make_stream_part(
                    "messages-tuple",
                    [
                        {"id": "ai-1", "content": " world", "type": "AIMessageChunk"},
                        {"langgraph_node": "agent"},
                    ],
                ),
                _make_stream_part(
                    "values",
                    {
                        "messages": [
                            {"type": "human", "content": "hi"},
                            {"type": "ai", "content": "Hello world"},
                        ],
                        "artifacts": [],
                    },
                ),
            ]

            mock_client = _make_mock_langgraph_client()
            mock_client.runs.stream = MagicMock(return_value=_make_async_iterator(stream_events))
            manager._client = mock_client

            await manager.start()

            inbound = InboundMessage(
                channel_name="feishu",
                chat_id="chat1",
                user_id="user1",
                text="hi",
                thread_ts="om-source-1",
            )
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: len(outbound_received) >= 3)
            await manager.stop()

            mock_client.runs.stream.assert_called_once()
            assert [msg.text for msg in outbound_received] == ["Hello", "Hello world", "Hello world"]
            assert [msg.is_final for msg in outbound_received] == [False, False, True]
            assert all(msg.thread_ts == "om-source-1" for msg in outbound_received)

        _run(go())

    def test_handle_feishu_stream_recovers_stale_langgraph_thread_once(self, monkeypatch):
        from app.channels.manager import ChannelManager

        monkeypatch.setattr("app.channels.manager.STREAM_UPDATE_MIN_INTERVAL_SECONDS", 0.0)

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            store.set_thread_id("feishu", "chat1", "stale-thread", user_id="user1")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            success_events = [
                _make_stream_part(
                    "values",
                    {
                        "messages": [
                            {"type": "human", "content": "hi"},
                            {"type": "ai", "content": "Recovered stream response"},
                        ],
                        "artifacts": [],
                    },
                )
            ]
            mock_client = _make_mock_langgraph_client(thread_id="fresh-thread")
            mock_client.threads.get = AsyncMock(side_effect=_make_http_status_error(404, '{"detail":"Thread not found."}'))
            mock_client.runs.stream = MagicMock(
                side_effect=[
                    _make_failing_async_iterator(_make_http_status_error(404)),
                    _make_async_iterator(success_events),
                ]
            )
            manager._client = mock_client

            await manager.start()
            await bus.publish_inbound(
                InboundMessage(
                    channel_name="feishu",
                    chat_id="chat1",
                    user_id="user1",
                    text="hi",
                    thread_ts="om-source-1",
                )
            )
            await _wait_for(lambda: any(m.is_final for m in outbound_received))
            await manager.stop()

            assert store.get_thread_id("feishu", "chat1") == "fresh-thread"
            mock_client.threads.create.assert_called_once()
            assert mock_client.runs.stream.call_count == 2
            assert [call.args[0] for call in mock_client.runs.stream.call_args_list] == ["stale-thread", "fresh-thread"]
            final = [m for m in outbound_received if m.is_final][-1]
            assert final.thread_id == "fresh-thread"
            assert final.text == "Recovered stream response"

        _run(go())

    def test_handle_feishu_stream_error_still_sends_final(self, monkeypatch):
        """When the stream raises mid-way, a final outbound with is_final=True must still be published."""
        from app.channels.manager import ChannelManager

        monkeypatch.setattr("app.channels.manager.STREAM_UPDATE_MIN_INTERVAL_SECONDS", 0.0)

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)

            async def _failing_stream():
                yield _make_stream_part(
                    "messages-tuple",
                    [
                        {"id": "ai-1", "content": "Partial", "type": "AIMessageChunk"},
                        {"langgraph_node": "agent"},
                    ],
                )
                raise ConnectionError("stream broken")

            mock_client = _make_mock_langgraph_client()
            mock_client.runs.stream = MagicMock(return_value=_failing_stream())
            manager._client = mock_client

            await manager.start()

            inbound = InboundMessage(
                channel_name="feishu",
                chat_id="chat1",
                user_id="user1",
                text="hi",
                thread_ts="om-source-1",
            )
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: any(m.is_final for m in outbound_received))
            await manager.stop()

            # Should have at least one intermediate and one final message
            final_msgs = [m for m in outbound_received if m.is_final]
            assert len(final_msgs) == 1
            assert final_msgs[0].thread_ts == "om-source-1"

        _run(go())

    def test_handle_command_help(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)
            await manager.start()

            inbound = InboundMessage(
                channel_name="test",
                chat_id="chat1",
                user_id="user1",
                text="/help",
                msg_type=InboundMessageType.COMMAND,
            )
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert len(outbound_received) == 1
            assert "/new" in outbound_received[0].text
            assert "/help" in outbound_received[0].text

        _run(go())

    def test_handle_command_new(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            store.set_thread_id("test", "chat1", "old-thread")

            mock_client = _make_mock_langgraph_client(thread_id="new-thread-456")
            manager._client = mock_client

            outbound_received = []

            async def capture_outbound(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture_outbound)
            await manager.start()

            inbound = InboundMessage(
                channel_name="test",
                chat_id="chat1",
                user_id="user1",
                text="/new",
                msg_type=InboundMessageType.COMMAND,
            )
            await bus.publish_inbound(inbound)
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            new_thread = store.get_thread_id("test", "chat1")
            assert new_thread == "new-thread-456"
            assert new_thread != "old-thread"
            assert "New conversation started" in outbound_received[0].text

            # threads.create should be called for /new
            mock_client.threads.create.assert_called_once()

        _run(go())

    def test_each_topic_creates_new_thread(self):
        """Messages with distinct topic_ids should each create a new DeerFlow thread."""
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            # Return a different thread_id for each create call
            thread_ids = iter(["thread-1", "thread-2"])

            async def create_thread(**kwargs):
                return {"thread_id": next(thread_ids)}

            mock_client = _make_mock_langgraph_client()
            mock_client.threads.create = AsyncMock(side_effect=create_thread)
            manager._client = mock_client

            outbound_received = []

            async def capture(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture)
            await manager.start()

            # Send two messages with different topic_ids (e.g. group chat, each starts a new topic)
            for i, text in enumerate(["first", "second"]):
                await bus.publish_inbound(
                    InboundMessage(
                        channel_name="test",
                        chat_id="chat1",
                        user_id="user1",
                        text=text,
                        topic_id=f"topic-{i}",
                    )
                )
            await _wait_for(lambda: mock_client.runs.wait.call_count >= 2)
            await manager.stop()

            # threads.create should be called twice (different topics)
            assert mock_client.threads.create.call_count == 2

            # runs.wait should be called twice with different thread_ids
            assert mock_client.runs.wait.call_count == 2
            wait_thread_ids = [c[0][0] for c in mock_client.runs.wait.call_args_list]
            assert "thread-1" in wait_thread_ids
            assert "thread-2" in wait_thread_ids

        _run(go())

    def test_same_topic_reuses_thread(self):
        """Messages with the same topic_id should reuse the same DeerFlow thread."""
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            mock_client = _make_mock_langgraph_client(thread_id="topic-thread-1")
            manager._client = mock_client

            outbound_received = []

            async def capture(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture)
            await manager.start()

            # Send two messages with the same topic_id (simulates replies in a thread)
            for text in ["first message", "follow-up"]:
                msg = InboundMessage(
                    channel_name="test",
                    chat_id="chat1",
                    user_id="user1",
                    text=text,
                    topic_id="topic-root-123",
                )
                await bus.publish_inbound(msg)

            await _wait_for(lambda: mock_client.runs.wait.call_count >= 2)
            await manager.stop()

            # threads.create should be called only ONCE (second message reuses the thread)
            mock_client.threads.create.assert_called_once()

            # Both runs.wait calls should use the same thread_id
            assert mock_client.runs.wait.call_count == 2
            for call in mock_client.runs.wait.call_args_list:
                assert call[0][0] == "topic-thread-1"

        _run(go())

    def test_none_topic_reuses_thread(self):
        """Messages with topic_id=None should reuse the same thread (e.g. Telegram private chat)."""
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            mock_client = _make_mock_langgraph_client(thread_id="private-thread-1")
            manager._client = mock_client

            outbound_received = []

            async def capture(msg):
                outbound_received.append(msg)

            bus.subscribe_outbound(capture)
            await manager.start()

            # Send two messages with topic_id=None (simulates Telegram private chat)
            for text in ["hello", "what did I just say?"]:
                msg = InboundMessage(
                    channel_name="telegram",
                    chat_id="chat1",
                    user_id="user1",
                    text=text,
                    topic_id=None,
                )
                await bus.publish_inbound(msg)

            await _wait_for(lambda: mock_client.runs.wait.call_count >= 2)
            await manager.stop()

            # threads.create should be called only ONCE (second message reuses the thread)
            mock_client.threads.create.assert_called_once()

            # Both runs.wait calls should use the same thread_id
            assert mock_client.runs.wait.call_count == 2
            for call in mock_client.runs.wait.call_args_list:
                assert call[0][0] == "private-thread-1"

        _run(go())

    def test_different_topics_get_different_threads(self):
        """Messages with different topic_ids should create separate threads."""
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            thread_ids = iter(["thread-A", "thread-B"])

            async def create_thread(**kwargs):
                return {"thread_id": next(thread_ids)}

            mock_client = _make_mock_langgraph_client()
            mock_client.threads.create = AsyncMock(side_effect=create_thread)
            manager._client = mock_client

            bus.subscribe_outbound(lambda msg: None)
            await manager.start()

            # Send messages with different topic_ids
            for topic in ["topic-1", "topic-2"]:
                msg = InboundMessage(
                    channel_name="test",
                    chat_id="chat1",
                    user_id="user1",
                    text="hi",
                    topic_id=topic,
                )
                await bus.publish_inbound(msg)

            await _wait_for(lambda: mock_client.runs.wait.call_count >= 2)
            await manager.stop()

            # threads.create called twice (different topics)
            assert mock_client.threads.create.call_count == 2

            # runs.wait used different thread_ids
            wait_thread_ids = [c[0][0] for c in mock_client.runs.wait.call_args_list]
            assert set(wait_thread_ids) == {"thread-A", "thread-B"}

        _run(go())


# ---------------------------------------------------------------------------
# ChannelService tests
# ---------------------------------------------------------------------------


class TestExtractArtifacts:
    def test_extracts_from_present_files_tool_call(self):
        from app.channels.manager import _extract_artifacts

        result = {
            "messages": [
                {"type": "human", "content": "generate report"},
                {
                    "type": "ai",
                    "content": "Here is your report.",
                    "tool_calls": [
                        {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/report.md"]}},
                    ],
                },
                {"type": "tool", "name": "present_files", "content": "Successfully presented files"},
            ]
        }
        assert _extract_artifacts(result) == ["/mnt/user-data/outputs/report.md"]

    def test_empty_when_no_present_files(self):
        from app.channels.manager import _extract_artifacts

        result = {
            "messages": [
                {"type": "human", "content": "hello"},
                {"type": "ai", "content": "hello"},
            ]
        }
        assert _extract_artifacts(result) == []

    def test_empty_for_list_result_no_tool_calls(self):
        from app.channels.manager import _extract_artifacts

        result = [{"type": "ai", "content": "hello"}]
        assert _extract_artifacts(result) == []

    def test_only_extracts_after_last_human_message(self):
        """Artifacts from previous turns (before the last human message) should be ignored."""
        from app.channels.manager import _extract_artifacts

        result = {
            "messages": [
                {"type": "human", "content": "make report"},
                {
                    "type": "ai",
                    "content": "Created report.",
                    "tool_calls": [
                        {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/report.md"]}},
                    ],
                },
                {"type": "tool", "name": "present_files", "content": "ok"},
                {"type": "human", "content": "add chart"},
                {
                    "type": "ai",
                    "content": "Created chart.",
                    "tool_calls": [
                        {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/chart.png"]}},
                    ],
                },
                {"type": "tool", "name": "present_files", "content": "ok"},
            ]
        }
        # Should only return chart.png (from the last turn)
        assert _extract_artifacts(result) == ["/mnt/user-data/outputs/chart.png"]

    def test_multiple_files_in_single_call(self):
        from app.channels.manager import _extract_artifacts

        result = {
            "messages": [
                {"type": "human", "content": "export"},
                {
                    "type": "ai",
                    "content": "Done.",
                    "tool_calls": [
                        {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/a.txt", "/mnt/user-data/outputs/b.csv"]}},
                    ],
                },
            ]
        }
        assert _extract_artifacts(result) == ["/mnt/user-data/outputs/a.txt", "/mnt/user-data/outputs/b.csv"]


class TestFormatArtifactText:
    def test_single_artifact(self):
        from app.channels.manager import _format_artifact_text

        text = _format_artifact_text(["/mnt/user-data/outputs/report.md"])
        assert text == "Created File: 📎 report.md"

    def test_multiple_artifacts(self):
        from app.channels.manager import _format_artifact_text

        text = _format_artifact_text(
            ["/mnt/user-data/outputs/a.txt", "/mnt/user-data/outputs/b.csv"],
        )
        assert text == "Created Files: 📎 a.txt、b.csv"


class TestHandleChatWithArtifacts:
    def test_artifacts_appended_to_text(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            run_result = {
                "messages": [
                    {"type": "human", "content": "generate report"},
                    {
                        "type": "ai",
                        "content": "Here is your report.",
                        "tool_calls": [
                            {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/report.md"]}},
                        ],
                    },
                    {"type": "tool", "name": "present_files", "content": "ok"},
                ],
            }
            mock_client = _make_mock_langgraph_client(run_result=run_result)
            manager._client = mock_client

            outbound_received = []
            bus.subscribe_outbound(lambda msg: outbound_received.append(msg))
            await manager.start()

            await bus.publish_inbound(
                InboundMessage(
                    channel_name="test",
                    chat_id="c1",
                    user_id="u1",
                    text="generate report",
                )
            )
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert len(outbound_received) == 1
            assert "Here is your report." in outbound_received[0].text
            assert "report.md" in outbound_received[0].text
            assert outbound_received[0].artifacts == ["/mnt/user-data/outputs/report.md"]

        _run(go())

    def test_artifacts_only_no_text(self):
        """When agent produces artifacts but no text, the artifacts should be the response."""
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            run_result = {
                "messages": [
                    {"type": "human", "content": "export data"},
                    {
                        "type": "ai",
                        "content": "",
                        "tool_calls": [
                            {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/output.csv"]}},
                        ],
                    },
                    {"type": "tool", "name": "present_files", "content": "ok"},
                ],
            }
            mock_client = _make_mock_langgraph_client(run_result=run_result)
            manager._client = mock_client

            outbound_received = []
            bus.subscribe_outbound(lambda msg: outbound_received.append(msg))
            await manager.start()

            await bus.publish_inbound(
                InboundMessage(
                    channel_name="test",
                    chat_id="c1",
                    user_id="u1",
                    text="export data",
                )
            )
            await _wait_for(lambda: len(outbound_received) >= 1)
            await manager.stop()

            assert len(outbound_received) == 1
            # Should NOT be the "(No response from agent)" fallback
            assert outbound_received[0].text != "(No response from agent)"
            assert "output.csv" in outbound_received[0].text
            assert outbound_received[0].artifacts == ["/mnt/user-data/outputs/output.csv"]

        _run(go())

    def test_only_last_turn_artifacts_returned(self):
        """Only artifacts from the current turn's present_files calls should be included."""
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            manager = ChannelManager(bus=bus, store=store)

            # Turn 1: produces report.md
            turn1_result = {
                "messages": [
                    {"type": "human", "content": "make report"},
                    {
                        "type": "ai",
                        "content": "Created report.",
                        "tool_calls": [
                            {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/report.md"]}},
                        ],
                    },
                    {"type": "tool", "name": "present_files", "content": "ok"},
                ],
            }
            # Turn 2: accumulated messages include turn 1's artifacts, but only chart.png is new
            turn2_result = {
                "messages": [
                    {"type": "human", "content": "make report"},
                    {
                        "type": "ai",
                        "content": "Created report.",
                        "tool_calls": [
                            {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/report.md"]}},
                        ],
                    },
                    {"type": "tool", "name": "present_files", "content": "ok"},
                    {"type": "human", "content": "add chart"},
                    {
                        "type": "ai",
                        "content": "Created chart.",
                        "tool_calls": [
                            {"name": "present_files", "args": {"filepaths": ["/mnt/user-data/outputs/chart.png"]}},
                        ],
                    },
                    {"type": "tool", "name": "present_files", "content": "ok"},
                ],
            }

            mock_client = _make_mock_langgraph_client(thread_id="thread-dup-test")
            mock_client.runs.wait = AsyncMock(side_effect=[turn1_result, turn2_result])
            manager._client = mock_client

            outbound_received = []
            bus.subscribe_outbound(lambda msg: outbound_received.append(msg))
            await manager.start()

            # Send two messages with the same topic_id (same thread)
            for text in ["make report", "add chart"]:
                msg = InboundMessage(
                    channel_name="test",
                    chat_id="c1",
                    user_id="u1",
                    text=text,
                    topic_id="topic-dup",
                )
                await bus.publish_inbound(msg)

            await _wait_for(lambda: len(outbound_received) >= 2)
            await manager.stop()

            assert len(outbound_received) == 2

            # Turn 1: should include report.md
            assert "report.md" in outbound_received[0].text
            assert outbound_received[0].artifacts == ["/mnt/user-data/outputs/report.md"]

            # Turn 2: should include ONLY chart.png (report.md is from previous turn)
            assert "chart.png" in outbound_received[1].text
            assert "report.md" not in outbound_received[1].text
            assert outbound_received[1].artifacts == ["/mnt/user-data/outputs/chart.png"]

        _run(go())


class TestFeishuChannel:
    def test_prepare_inbound_publishes_without_waiting_for_running_card(self):
        from app.channels.feishu import FeishuChannel

        async def go():
            bus = MessageBus()
            bus.publish_inbound = AsyncMock()
            channel = FeishuChannel(bus, config={})

            reply_started = asyncio.Event()
            release_reply = asyncio.Event()

            async def slow_reply(message_id: str, text: str) -> str:
                reply_started.set()
                await release_reply.wait()
                return "om-running-card"

            channel._add_reaction = AsyncMock()
            channel._reply_card = AsyncMock(side_effect=slow_reply)

            inbound = InboundMessage(
                channel_name="feishu",
                chat_id="chat-1",
                user_id="user-1",
                text="hello",
                thread_ts="om-source-msg",
            )

            prepare_task = asyncio.create_task(channel._prepare_inbound("om-source-msg", inbound))

            await _wait_for(lambda: bus.publish_inbound.await_count == 1)
            await prepare_task

            assert reply_started.is_set()
            assert "om-source-msg" in channel._running_card_tasks
            assert channel._reply_card.await_count == 1

            release_reply.set()
            await _wait_for(lambda: channel._running_card_ids.get("om-source-msg") == "om-running-card")
            await _wait_for(lambda: "om-source-msg" not in channel._running_card_tasks)

        _run(go())

    def test_prepare_inbound_and_send_share_running_card_task(self):
        from app.channels.feishu import FeishuChannel

        async def go():
            bus = MessageBus()
            bus.publish_inbound = AsyncMock()
            channel = FeishuChannel(bus, config={})
            channel._api_client = MagicMock()

            reply_started = asyncio.Event()
            release_reply = asyncio.Event()

            async def slow_reply(message_id: str, text: str) -> str:
                reply_started.set()
                await release_reply.wait()
                return "om-running-card"

            channel._add_reaction = AsyncMock()
            channel._reply_card = AsyncMock(side_effect=slow_reply)
            channel._update_card = AsyncMock()

            inbound = InboundMessage(
                channel_name="feishu",
                chat_id="chat-1",
                user_id="user-1",
                text="hello",
                thread_ts="om-source-msg",
            )

            prepare_task = asyncio.create_task(channel._prepare_inbound("om-source-msg", inbound))
            await _wait_for(lambda: bus.publish_inbound.await_count == 1)
            await _wait_for(reply_started.is_set)

            send_task = asyncio.create_task(
                channel.send(
                    OutboundMessage(
                        channel_name="feishu",
                        chat_id="chat-1",
                        thread_id="thread-1",
                        text="Hello",
                        is_final=False,
                        thread_ts="om-source-msg",
                    )
                )
            )

            await asyncio.sleep(0)
            assert channel._reply_card.await_count == 1

            release_reply.set()
            await prepare_task
            await send_task

            assert channel._reply_card.await_count == 1
            channel._update_card.assert_awaited_once_with("om-running-card", "Hello")
            assert "om-source-msg" not in channel._running_card_tasks

        _run(go())

    def test_streaming_reuses_single_running_card(self):
        from lark_oapi.api.im.v1 import (
            CreateMessageReactionRequest,
            CreateMessageReactionRequestBody,
            Emoji,
            PatchMessageRequest,
            PatchMessageRequestBody,
            ReplyMessageRequest,
            ReplyMessageRequestBody,
        )

        from app.channels.feishu import FeishuChannel

        async def go():
            bus = MessageBus()
            channel = FeishuChannel(bus, config={})

            channel._api_client = MagicMock()
            channel._ReplyMessageRequest = ReplyMessageRequest
            channel._ReplyMessageRequestBody = ReplyMessageRequestBody
            channel._PatchMessageRequest = PatchMessageRequest
            channel._PatchMessageRequestBody = PatchMessageRequestBody
            channel._CreateMessageReactionRequest = CreateMessageReactionRequest
            channel._CreateMessageReactionRequestBody = CreateMessageReactionRequestBody
            channel._Emoji = Emoji

            reply_response = MagicMock()
            reply_response.data.message_id = "om-running-card"
            channel._api_client.im.v1.message.reply = MagicMock(return_value=reply_response)
            channel._api_client.im.v1.message.patch = MagicMock()
            channel._api_client.im.v1.message_reaction.create = MagicMock()

            await channel._send_running_reply("om-source-msg")

            await channel.send(
                OutboundMessage(
                    channel_name="feishu",
                    chat_id="chat-1",
                    thread_id="thread-1",
                    text="Hello",
                    is_final=False,
                    thread_ts="om-source-msg",
                )
            )
            await channel.send(
                OutboundMessage(
                    channel_name="feishu",
                    chat_id="chat-1",
                    thread_id="thread-1",
                    text="Hello world",
                    is_final=True,
                    thread_ts="om-source-msg",
                )
            )

            assert channel._api_client.im.v1.message.reply.call_count == 1
            assert channel._api_client.im.v1.message.patch.call_count == 2
            assert channel._api_client.im.v1.message_reaction.create.call_count == 1
            assert "om-source-msg" not in channel._running_card_ids
            assert "om-source-msg" not in channel._running_card_tasks

            first_patch_request = channel._api_client.im.v1.message.patch.call_args_list[0].args[0]
            final_patch_request = channel._api_client.im.v1.message.patch.call_args_list[1].args[0]
            assert first_patch_request.message_id == "om-running-card"
            assert final_patch_request.message_id == "om-running-card"
            assert json.loads(first_patch_request.body.content)["elements"][0]["content"] == "Hello"
            assert json.loads(final_patch_request.body.content)["elements"][0]["content"] == "Hello world"
            assert json.loads(final_patch_request.body.content)["config"]["update_multi"] is True

        _run(go())


class TestChannelService:
    def test_get_status_no_channels(self):
        from app.channels.service import ChannelService

        async def go():
            service = ChannelService(channels_config={})
            await service.start()

            status = service.get_status()
            assert status["service_running"] is True
            for ch_status in status["channels"].values():
                assert ch_status["enabled"] is False
                assert ch_status["running"] is False

            await service.stop()

        _run(go())

    def test_disabled_channels_are_skipped(self):
        from app.channels.service import ChannelService

        async def go():
            service = ChannelService(
                channels_config={
                    "feishu": {"enabled": False, "app_id": "x", "app_secret": "y"},
                }
            )
            await service.start()
            assert "feishu" not in service._channels
            await service.stop()

        _run(go())

    def test_session_config_is_forwarded_to_manager(self):
        from app.channels.service import ChannelService

        service = ChannelService(
            channels_config={
                "session": {"context": {"thinking_enabled": False}},
                "telegram": {
                    "enabled": False,
                    "session": {
                        "assistant_id": "mobile_agent",
                        "users": {
                            "vip": {
                                "assistant_id": "vip_agent",
                            }
                        },
                    },
                },
            }
        )

        assert service.manager._default_session["context"]["thinking_enabled"] is False
        assert service.manager._channel_sessions["telegram"]["assistant_id"] == "mobile_agent"
        assert service.manager._channel_sessions["telegram"]["users"]["vip"]["assistant_id"] == "vip_agent"


# ---------------------------------------------------------------------------
# Slack send retry tests
# ---------------------------------------------------------------------------


class TestSlackSendRetry:
    def test_retries_on_failure_then_succeeds(self):
        from app.channels.slack import SlackChannel

        async def go():
            bus = MessageBus()
            ch = SlackChannel(bus=bus, config={"bot_token": "xoxb-test", "app_token": "xapp-test"})

            mock_web = MagicMock()
            call_count = 0

            def post_message(**kwargs):
                nonlocal call_count
                call_count += 1
                if call_count < 3:
                    raise ConnectionError("network error")
                return MagicMock()

            mock_web.chat_postMessage = post_message
            ch._web_client = mock_web

            msg = OutboundMessage(channel_name="slack", chat_id="C123", thread_id="t1", text="hello")
            await ch.send(msg)
            assert call_count == 3

        _run(go())

    def test_raises_after_all_retries_exhausted(self):
        from app.channels.slack import SlackChannel

        async def go():
            bus = MessageBus()
            ch = SlackChannel(bus=bus, config={"bot_token": "xoxb-test", "app_token": "xapp-test"})

            mock_web = MagicMock()
            mock_web.chat_postMessage = MagicMock(side_effect=ConnectionError("fail"))
            ch._web_client = mock_web

            msg = OutboundMessage(channel_name="slack", chat_id="C123", thread_id="t1", text="hello")
            with pytest.raises(ConnectionError):
                await ch.send(msg)

            assert mock_web.chat_postMessage.call_count == 3

        _run(go())


# ---------------------------------------------------------------------------
# Telegram send retry tests
# ---------------------------------------------------------------------------


class TestTelegramSendRetry:
    def test_retries_on_failure_then_succeeds(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})

            mock_app = MagicMock()
            mock_bot = AsyncMock()
            call_count = 0

            async def send_message(**kwargs):
                nonlocal call_count
                call_count += 1
                if call_count < 3:
                    raise ConnectionError("network error")
                result = MagicMock()
                result.message_id = 999
                return result

            mock_bot.send_message = send_message
            mock_app.bot = mock_bot
            ch._application = mock_app

            msg = OutboundMessage(channel_name="telegram", chat_id="12345", thread_id="t1", text="hello")
            await ch.send(msg)
            assert call_count == 3

        _run(go())

    def test_raises_after_all_retries_exhausted(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})

            mock_app = MagicMock()
            mock_bot = AsyncMock()
            mock_bot.send_message = AsyncMock(side_effect=ConnectionError("fail"))
            mock_app.bot = mock_bot
            ch._application = mock_app

            msg = OutboundMessage(channel_name="telegram", chat_id="12345", thread_id="t1", text="hello")
            with pytest.raises(ConnectionError):
                await ch.send(msg)

            assert mock_bot.send_message.call_count == 3

        _run(go())


# ---------------------------------------------------------------------------
# Telegram private-chat thread context tests
# ---------------------------------------------------------------------------


def _make_telegram_update(chat_type: str, message_id: int, *, reply_to_message_id: int | None = None, text: str = "hello"):
    """Build a minimal mock telegram Update for testing _on_text / _cmd_generic."""
    update = MagicMock()
    update.effective_chat.type = chat_type
    update.effective_chat.id = 100
    update.effective_user.id = 42
    update.message.text = text
    update.message.message_id = message_id
    if reply_to_message_id is not None:
        reply_msg = MagicMock()
        reply_msg.message_id = reply_to_message_id
        update.message.reply_to_message = reply_msg
    else:
        update.message.reply_to_message = None
    return update


class TestTelegramPrivateChatThread:
    """Verify that private chats use topic_id=None (single thread per chat)."""

    def test_private_chat_no_reply_uses_none_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("private", message_id=10)
            await ch._on_text(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id is None

        _run(go())

    def test_private_chat_with_reply_still_uses_none_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("private", message_id=11, reply_to_message_id=5)
            await ch._on_text(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id is None

        _run(go())

    def test_group_chat_no_reply_uses_msg_id_as_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("group", message_id=20)
            await ch._on_text(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id == "20"

        _run(go())

    def test_group_chat_reply_uses_reply_msg_id_as_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("group", message_id=21, reply_to_message_id=15)
            await ch._on_text(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id == "15"

        _run(go())

    def test_supergroup_chat_uses_msg_id_as_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("supergroup", message_id=25)
            await ch._on_text(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id == "25"

        _run(go())

    def test_cmd_generic_private_chat_uses_none_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("private", message_id=30, text="/new")
            await ch._cmd_generic(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id is None
            assert msg.msg_type == InboundMessageType.COMMAND

        _run(go())

    def test_cmd_generic_group_chat_uses_msg_id_as_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("group", message_id=31, text="/status")
            await ch._cmd_generic(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id == "31"
            assert msg.msg_type == InboundMessageType.COMMAND

        _run(go())

    def test_cmd_generic_group_chat_reply_uses_reply_msg_id_as_topic(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("group", message_id=32, reply_to_message_id=20, text="/status")
            await ch._cmd_generic(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.topic_id == "20"
            assert msg.msg_type == InboundMessageType.COMMAND

        _run(go())


class TestTelegramRunningReplyEventLoop:
    """Regression: `_send_running_reply` invokes the bot's HTTP client, which
    is bound to `_tg_loop` (the polling-thread loop). Scheduling it onto
    `_main_loop` raised
        RuntimeError: <asyncio.locks.Event …> is bound to a different event loop
    in production whenever `_main_loop != _tg_loop`. The handlers themselves
    run on `_tg_loop`, so the reply MUST be scheduled there. We also keep the
    scheduling fire-and-forget so transient Telegram slowness can never delay
    forwarding the user's message to the manager — the codex bot caught a
    regression in PR #79 where `await self._send_running_reply(...)` made
    manager dispatch depend on the best-effort acknowledgement.
    """

    @staticmethod
    def _capture_loop_bot():
        """A mock telegram bot whose `send_message` records the running loop
        and signals an Event on entry so tests can wait for the
        fire-and-forget task to actually execute."""
        captured: dict = {}

        async def send_message(**kwargs):
            captured["loop"] = asyncio.get_running_loop()
            captured["kwargs"] = kwargs
            captured["called"].set()
            return MagicMock(message_id=42)

        bot = MagicMock()
        bot.send_message = send_message
        return bot, captured

    def test_on_text_runs_running_reply_on_handler_loop_not_main_loop(self):
        """`_on_text` must schedule `bot.send_message` on the current handler
        loop (= `_tg_loop` in production), NOT on `_main_loop`."""
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})

            bot, captured = self._capture_loop_bot()
            captured["called"] = asyncio.Event()
            mock_app = MagicMock()
            mock_app.bot = bot
            ch._application = mock_app
            # Production shape: _main_loop is a DIFFERENT loop from the one
            # running this handler. Use a fresh event loop to model that.
            different_loop = asyncio.new_event_loop()
            ch._main_loop = different_loop

            handler_loop = asyncio.get_running_loop()
            update = _make_telegram_update("private", message_id=100)

            try:
                await ch._on_text(update, None)
                # Fire-and-forget — wait for the scheduled task to actually run.
                await asyncio.wait_for(captured["called"].wait(), timeout=2.0)
            finally:
                different_loop.close()

            assert captured.get("loop") is handler_loop, (
                "bot.send_message must run on the handler's loop "
                "(= _tg_loop in prod), not on _main_loop. Got loop "
                f"{captured.get('loop')!r} vs handler_loop {handler_loop!r}."
            )
            assert captured["kwargs"]["text"] == "Working on it..."

        _run(go())

    def test_cmd_generic_runs_running_reply_on_handler_loop_not_main_loop(self):
        """Same contract for slash-command handler `_cmd_generic`."""
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})

            bot, captured = self._capture_loop_bot()
            captured["called"] = asyncio.Event()
            mock_app = MagicMock()
            mock_app.bot = bot
            ch._application = mock_app
            different_loop = asyncio.new_event_loop()
            ch._main_loop = different_loop

            handler_loop = asyncio.get_running_loop()
            update = _make_telegram_update("private", message_id=200, text="/status")

            try:
                await ch._cmd_generic(update, None)
                await asyncio.wait_for(captured["called"].wait(), timeout=2.0)
            finally:
                different_loop.close()

            assert captured.get("loop") is handler_loop, (
                "bot.send_message must run on the handler's loop, not on _main_loop."
            )

        _run(go())

    def test_on_text_does_not_block_on_slow_running_reply(self):
        """If `bot.send_message` is slow/stuck, the handler MUST still return
        promptly so the user's message reaches the manager via
        `bus.publish_inbound` without waiting for the best-effort reply.

        This regression locks in the codex bot's review: PR #79's interim
        `await self._send_running_reply(...)` made the chat path block on a
        Telegram round-trip; this test fails under that pattern and passes
        with the fire-and-forget scheduling.
        """
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})

            send_release = asyncio.Event()
            send_started = asyncio.Event()

            async def slow_send_message(**kwargs):
                send_started.set()
                # Block until the test releases — simulates a stuck Telegram
                # API call, rate-limit retry, or network latency.
                await send_release.wait()
                return MagicMock(message_id=42)

            mock_bot = MagicMock()
            mock_bot.send_message = slow_send_message
            mock_app = MagicMock()
            mock_app.bot = mock_bot
            ch._application = mock_app
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("private", message_id=300)

            # Handler must return BEFORE the slow send completes. A tight
            # timeout is the proof that we are not awaiting the reply.
            await asyncio.wait_for(ch._on_text(update, None), timeout=1.0)
            # Manager dispatch (via the bus) must already be possible even
            # though the reply is still stuck.
            inbound_msg = await asyncio.wait_for(bus.get_inbound(), timeout=1.0)
            assert inbound_msg.text == "hello"
            # Confirm the reply task at least started (was scheduled, not skipped).
            await asyncio.wait_for(send_started.wait(), timeout=1.0)
            # Release the slow send so the background task drains cleanly.
            send_release.set()
            # Drain pending background tasks so the test doesn't leak warnings.
            await asyncio.sleep(0)

        _run(go())

    def test_cmd_generic_does_not_block_on_slow_running_reply(self):
        """Same non-blocking contract for slash-command handler `_cmd_generic`."""
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})

            send_release = asyncio.Event()
            send_started = asyncio.Event()

            async def slow_send_message(**kwargs):
                send_started.set()
                await send_release.wait()
                return MagicMock(message_id=42)

            mock_bot = MagicMock()
            mock_bot.send_message = slow_send_message
            mock_app = MagicMock()
            mock_app.bot = mock_bot
            ch._application = mock_app
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_update("private", message_id=301, text="/status")

            await asyncio.wait_for(ch._cmd_generic(update, None), timeout=1.0)
            inbound_msg = await asyncio.wait_for(bus.get_inbound(), timeout=1.0)
            assert inbound_msg.msg_type == InboundMessageType.COMMAND
            await asyncio.wait_for(send_started.wait(), timeout=1.0)
            send_release.set()
            await asyncio.sleep(0)

        _run(go())


# ---------------------------------------------------------------------------
# Slack markdown-to-mrkdwn conversion tests (via markdown_to_mrkdwn library)
# ---------------------------------------------------------------------------


class TestSlackMarkdownConversion:
    """Verify that the SlackChannel.send() path applies mrkdwn conversion."""

    def test_bold_converted(self):
        from app.channels.slack import _slack_md_converter

        result = _slack_md_converter.convert("this is **bold** text")
        assert "*bold*" in result
        assert "**" not in result

    def test_link_converted(self):
        from app.channels.slack import _slack_md_converter

        result = _slack_md_converter.convert("[click](https://example.com)")
        assert "<https://example.com|click>" in result

    def test_heading_converted(self):
        from app.channels.slack import _slack_md_converter

        result = _slack_md_converter.convert("# Title")
        assert "*Title*" in result
        assert "#" not in result


# ---------------------------------------------------------------------------
# B5 — Telegram inbound attachments (images + PDFs).
#
# The user-visible bug: photos / PDFs sent to the Telegram bot were silently
# dropped because `start()` only registered a TEXT handler. The fix adds a
# media handler + per-channel inbound-file reader + manager-side multimodal
# block builder that turns Telegram file_ids into Anthropic content blocks.
# ---------------------------------------------------------------------------


def _make_telegram_media_update(
    *,
    message_id: int,
    photo: bool = False,
    document: dict[str, str] | None = None,
    caption: str | None = None,
    chat_type: str = "private",
):
    """Build a mock Telegram Update carrying a photo and/or document."""
    update = MagicMock()
    update.effective_chat.type = chat_type
    update.effective_chat.id = 200
    update.effective_user.id = 42
    update.message.message_id = message_id
    update.message.caption = caption
    update.message.text = None
    update.message.reply_to_message = None
    if photo:
        # Telegram sends multiple sizes; the channel uses the last (largest).
        small = MagicMock(file_id="ph_small_id", file_unique_id="phu_s")
        large = MagicMock(file_id="ph_large_id", file_unique_id="phu_l")
        update.message.photo = [small, large]
    else:
        update.message.photo = []
    if document:
        doc = MagicMock()
        doc.file_id = document.get("file_id", "doc_id")
        doc.file_unique_id = document.get("file_unique_id", "docu_1")
        doc.file_name = document.get("file_name")
        doc.mime_type = document.get("mime_type")
        update.message.document = doc
    else:
        update.message.document = None
    return update


class TestTelegramInboundMedia:
    """Capture-side: ``_on_media`` extracts file_ids and publishes an
    InboundMessage with a populated ``files`` list. Without this handler
    Telegram drops photos / documents silently — that was the prod
    regression."""

    def test_photo_message_publishes_inbound_with_files(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_media_update(message_id=300, photo=True, caption="What is in this photo?")
            await ch._on_media(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            assert msg.text == "What is in this photo?"
            assert msg.files == [
                {
                    "file_id": "ph_large_id",
                    "filename": "telegram_photo_phu_l.jpg",
                    "mime_type": "image/jpeg",
                }
            ]

        _run(go())

    def test_document_message_uses_document_filename_and_mime(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_media_update(
                message_id=301,
                document={"file_id": "pdf_id_1", "file_name": "research.pdf", "mime_type": "application/pdf"},
            )
            await ch._on_media(update, None)

            msg = await asyncio.wait_for(bus.get_inbound(), timeout=2)
            # Default text when caption is missing — keeps the LLM aware that
            # the user attached something even with no caption.
            assert msg.text == "Please look at the attached file."
            assert msg.files == [
                {
                    "file_id": "pdf_id_1",
                    "filename": "research.pdf",
                    "mime_type": "application/pdf",
                }
            ]

        _run(go())

    def test_no_attachments_short_circuits(self):
        """A media handler that fires for an update with neither a photo
        nor a document (defensive: shouldn't happen given the handler
        filter, but fail-safe is correct)."""
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._main_loop = asyncio.get_event_loop()

            update = _make_telegram_media_update(message_id=302)
            await ch._on_media(update, None)

            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(bus.get_inbound(), timeout=0.2)

        _run(go())


class TestTelegramInboundFileReader:
    """The channel's ``get_inbound_file_reader()`` returns an async
    callable the manager invokes to download bytes for each
    ``InboundMessage.files`` entry. Mocked Bot API here — the integration
    smoke is on Render staging."""

    def test_reader_downloads_each_file_id(self):
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            mock_bot = MagicMock()

            async def fake_get_file(file_id):
                tg_file = MagicMock()
                # Different bytes per file so we can assert ordering.
                payload = b"PNG_BYTES" if file_id.startswith("ph_") else b"%PDF-PAYLOAD"

                async def _download():
                    return bytearray(payload)

                tg_file.download_as_bytearray = _download
                return tg_file

            mock_bot.get_file = fake_get_file
            ch._application = MagicMock()
            ch._application.bot = mock_bot

            inbound = MagicMock()
            inbound.files = [
                {"file_id": "ph_x", "filename": "photo.jpg", "mime_type": "image/jpeg"},
                {"file_id": "doc_x", "filename": "report.pdf", "mime_type": "application/pdf"},
            ]
            reader = ch.get_inbound_file_reader()
            downloaded = await reader(inbound)

            assert downloaded == [
                {"filename": "photo.jpg", "mime_type": "image/jpeg", "content": b"PNG_BYTES"},
                {"filename": "report.pdf", "mime_type": "application/pdf", "content": b"%PDF-PAYLOAD"},
            ]

        _run(go())

    def test_reader_skips_failures_and_continues(self):
        """If one file fails to download, the others still come through."""
        from app.channels.telegram import TelegramChannel

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            mock_bot = MagicMock()

            async def fake_get_file(file_id):
                if file_id == "doc_broken":
                    raise RuntimeError("simulated CDN failure")
                tg_file = MagicMock()

                async def _download():
                    return bytearray(b"PNG_DATA")

                tg_file.download_as_bytearray = _download
                return tg_file

            mock_bot.get_file = fake_get_file
            ch._application = MagicMock()
            ch._application.bot = mock_bot

            inbound = MagicMock()
            inbound.files = [
                {"file_id": "ph_ok", "filename": "ok.jpg", "mime_type": "image/jpeg"},
                {"file_id": "doc_broken", "filename": "broken.pdf", "mime_type": "application/pdf"},
            ]
            downloaded = await ch.get_inbound_file_reader()(inbound)

            assert downloaded == [
                {"filename": "ok.jpg", "mime_type": "image/jpeg", "content": b"PNG_DATA"},
            ]

        _run(go())

    def test_reader_dispatches_bot_calls_to_telegram_loop(self):
        from app.channels.telegram import TelegramChannel

        download_started = threading.Event()
        threads_seen: dict[str, int] = {}
        loops_seen: dict[str, asyncio.AbstractEventLoop] = {}

        loop_holder: dict[str, asyncio.AbstractEventLoop] = {}

        def _run_telegram_loop():
            loop = asyncio.new_event_loop()
            loop_holder["loop"] = loop
            asyncio.set_event_loop(loop)
            loop.run_forever()
            loop.close()

        tg_thread = threading.Thread(target=_run_telegram_loop, daemon=True)
        tg_thread.start()

        while "loop" not in loop_holder:
            time.sleep(0.01)

        async def go():
            bus = MessageBus()
            ch = TelegramChannel(bus=bus, config={"bot_token": "test-token"})
            ch._tg_loop = loop_holder["loop"]

            class FakeTelegramFile:
                async def download_as_bytearray(self):
                    threads_seen["download"] = threading.get_ident()
                    loops_seen["download"] = asyncio.get_running_loop()
                    download_started.set()
                    return bytearray(b"LOOP_HOP_OK")

            async def fake_get_file(file_id):
                assert file_id == "ph_x"
                threads_seen["get_file"] = threading.get_ident()
                loops_seen["get_file"] = asyncio.get_running_loop()
                return FakeTelegramFile()

            ch._application = MagicMock()
            ch._application.bot = MagicMock()
            ch._application.bot.get_file = fake_get_file

            inbound = MagicMock()
            inbound.files = [{"file_id": "ph_x", "filename": "photo.jpg", "mime_type": "image/jpeg"}]

            downloaded = await ch.get_inbound_file_reader()(inbound)
            assert downloaded == [{"filename": "photo.jpg", "mime_type": "image/jpeg", "content": b"LOOP_HOP_OK"}]
            assert download_started.is_set()
            assert loops_seen["get_file"] is ch._tg_loop
            assert loops_seen["download"] is ch._tg_loop
            assert threads_seen["get_file"] == tg_thread.ident
            assert threads_seen["download"] == tg_thread.ident

        try:
            _run(go())
        finally:
            loop_holder["loop"].call_soon_threadsafe(loop_holder["loop"].stop)
            tg_thread.join(timeout=2)


class TestManagerMultimodalBlockBuilder:
    """``_build_multimodal_blocks_for_inbound_files`` turns the reader's
    output into Anthropic content blocks."""

    def test_image_under_cap_becomes_base64_image_block(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        png_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 100

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "What's in this image?",
                [{"filename": "photo.png", "mime_type": "image/png", "content": png_bytes}],
            )

            assert blocks[0] == {"type": "text", "text": "What's in this image?"}
            assert blocks[1]["type"] == "image"
            assert blocks[1]["source"]["type"] == "base64"
            assert blocks[1]["source"]["media_type"] == "image/png"
            assert base64.b64decode(blocks[1]["source"]["data"]) == png_bytes

        _run(go())

    def test_pdf_under_cap_becomes_native_document_block(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        pdf_bytes = b"%PDF-1.7\n" + b"y" * 200

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "Summarize this paper",
                [{"filename": "paper.pdf", "mime_type": "application/pdf", "content": pdf_bytes}],
            )

            assert blocks[0]["type"] == "text"
            assert blocks[1]["type"] == "document"
            assert blocks[1]["source"]["type"] == "base64"
            assert blocks[1]["source"]["media_type"] == "application/pdf"
            assert blocks[1]["title"] == "paper.pdf"
            assert base64.b64decode(blocks[1]["source"]["data"]) == pdf_bytes

        _run(go())

    def test_pdf_under_cap_does_not_call_markitdown(self):
        """Small PDFs must keep going through native vision — markitdown is
        only the large-PDF fallback. Patching the converter and asserting it
        was never awaited proves the dispatcher short-circuits before it."""
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            with patch("app.channels.manager.convert_bytes_to_markdown_text", new=AsyncMock(return_value="should-not-be-used")) as mock_convert:
                blocks = await _build_multimodal_blocks_for_inbound_files(
                    "small pdf",
                    [{"filename": "small.pdf", "mime_type": "application/pdf", "content": b"%PDF-1.7" + b"z" * 100}],
                )
            mock_convert.assert_not_awaited()
            assert blocks[1]["type"] == "document"
            assert blocks[1]["source"]["type"] == "base64"

        _run(go())

    def test_image_over_cap_falls_back_to_descriptive_note(self):
        from app.channels.manager import _INLINE_IMAGE_MAX_BYTES, _build_multimodal_blocks_for_inbound_files

        oversized = b"\xff" * (_INLINE_IMAGE_MAX_BYTES + 1)

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "huge image",
                [{"filename": "big.jpg", "mime_type": "image/jpeg", "content": oversized}],
            )

            assert blocks[1]["type"] == "text"
            assert "big.jpg" in blocks[1]["text"]
            assert "5 MB" in blocks[1]["text"]

        _run(go())

    def test_pdf_over_cap_converts_via_markitdown(self):
        """Large PDFs route through markitdown and land as text-source
        document blocks — the ground-truth regression PR #85 left out."""
        from app.channels.manager import _INLINE_PDF_MAX_BYTES, _build_multimodal_blocks_for_inbound_files

        oversized = b"%PDF-1.7\n" + b"\xff" * _INLINE_PDF_MAX_BYTES

        async def go():
            with patch(
                "app.channels.manager.convert_bytes_to_markdown_text",
                new=AsyncMock(return_value="# Big paper\n\nextracted body text"),
            ) as mock_convert:
                blocks = await _build_multimodal_blocks_for_inbound_files(
                    "huge paper",
                    [{"filename": "big.pdf", "mime_type": "application/pdf", "content": oversized}],
                )

            mock_convert.assert_awaited_once()
            assert blocks[1]["type"] == "document"
            assert blocks[1]["source"]["type"] == "text"
            assert blocks[1]["source"]["media_type"] == "text/plain"
            assert blocks[1]["title"] == "big.pdf"
            assert "Big paper" in blocks[1]["source"]["data"]

        _run(go())

    def test_pdf_over_cap_with_markitdown_failure_falls_back_to_note(self):
        """When markitdown can't extract anything, the user still gets a
        descriptive note instead of a silent failure."""
        from app.channels.manager import _INLINE_PDF_MAX_BYTES, _build_multimodal_blocks_for_inbound_files

        oversized = b"%PDF-1.7\n" + b"\xff" * _INLINE_PDF_MAX_BYTES

        async def go():
            with patch("app.channels.manager.convert_bytes_to_markdown_text", new=AsyncMock(return_value=None)):
                blocks = await _build_multimodal_blocks_for_inbound_files(
                    "huge paper",
                    [{"filename": "big.pdf", "mime_type": "application/pdf", "content": oversized}],
                )

            assert blocks[1]["type"] == "text"
            assert "big.pdf" in blocks[1]["text"]
            assert "couldn't extract" in blocks[1]["text"]

        _run(go())

    def test_xlsx_converts_via_markitdown(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            with patch(
                "app.channels.manager.convert_bytes_to_markdown_text",
                new=AsyncMock(return_value="| col |\n|---|\n| val |"),
            ) as mock_convert:
                blocks = await _build_multimodal_blocks_for_inbound_files(
                    "look at this",
                    [{"filename": "spreadsheet.xlsx", "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content": b"PK..."}],
                )

            mock_convert.assert_awaited_once()
            assert blocks[1]["type"] == "document"
            assert blocks[1]["source"]["type"] == "text"
            assert blocks[1]["title"] == "spreadsheet.xlsx"
            assert "| col |" in blocks[1]["source"]["data"]

        _run(go())

    def test_markitdown_returns_none_falls_back_to_note(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            with patch("app.channels.manager.convert_bytes_to_markdown_text", new=AsyncMock(return_value=None)):
                blocks = await _build_multimodal_blocks_for_inbound_files(
                    "see this",
                    [{"filename": "report.docx", "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content": b"PK..."}],
                )

            assert blocks[1]["type"] == "text"
            assert "report.docx" in blocks[1]["text"]
            assert "couldn't extract" in blocks[1]["text"]

        _run(go())

    def test_truly_unsupported_binary_falls_back_to_note(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "what is this",
                [{"filename": "blob.bin", "mime_type": "application/octet-stream", "content": b"\x00\x01\x02"}],
            )

            assert len(blocks) == 2
            assert blocks[1]["type"] == "text"
            assert "blob.bin" in blocks[1]["text"]
            assert "binary attachment" in blocks[1]["text"]

        _run(go())

    def test_text_like_extension_decoded_as_document(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "read this",
                [{"filename": "notes.txt", "mime_type": "text/plain", "content": b"hello world"}],
            )

            assert blocks[1] == {
                "type": "document",
                "source": {"type": "text", "media_type": "text/plain", "data": "hello world"},
                "title": "notes.txt",
            }

        _run(go())

    def test_csv_via_text_like_path(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "csv",
                [{"filename": "data.csv", "mime_type": "text/csv", "content": b"a,b\n1,2"}],
            )

            assert blocks[1]["type"] == "document"
            assert blocks[1]["source"]["type"] == "text"
            assert blocks[1]["source"]["data"] == "a,b\n1,2"
            assert blocks[1]["title"] == "data.csv"

        _run(go())

    def test_text_like_truncation_appends_suffix(self):
        from app.channels.manager import (
            _INLINE_TEXT_MAX_CHARS,
            _TRUNCATION_SUFFIX,
            _build_multimodal_blocks_for_inbound_files,
        )

        long_text = "a" * (_INLINE_TEXT_MAX_CHARS + 5_000)

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "long",
                [{"filename": "long.txt", "mime_type": "text/plain", "content": long_text.encode()}],
            )

            data = blocks[1]["source"]["data"]
            assert data.endswith(_TRUNCATION_SUFFIX)
            assert len(data) == _INLINE_TEXT_MAX_CHARS + len(_TRUNCATION_SUFFIX)

        _run(go())

    def test_text_like_undecodable_empty_falls_back_to_note(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "empty",
                [{"filename": "empty.txt", "mime_type": "text/plain", "content": b""}],
            )

            assert blocks[1]["type"] == "text"
            assert "empty.txt" in blocks[1]["text"]
            assert "empty or undecodable" in blocks[1]["text"]

        _run(go())

    def test_multiple_attachments_in_order(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "compare these",
                [
                    {"filename": "a.png", "mime_type": "image/png", "content": b"PNG1"},
                    {"filename": "b.pdf", "mime_type": "application/pdf", "content": b"%PDF-2"},
                    {"filename": "c.png", "mime_type": "image/png", "content": b"PNG3"},
                ],
            )

            assert [b["type"] for b in blocks] == ["text", "image", "document", "image"]
            # PDF in the middle shows up as a document with the right filename.
            assert blocks[2]["title"] == "b.pdf"

        _run(go())

    def test_empty_text_omits_text_block(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "",
                [{"filename": "p.png", "mime_type": "image/png", "content": b"PNG"}],
            )

            # Only the image block — no leading empty text block.
            assert len(blocks) == 1
            assert blocks[0]["type"] == "image"

        _run(go())

    def test_invalid_file_entries_are_skipped(self):
        from app.channels.manager import _build_multimodal_blocks_for_inbound_files

        async def go():
            blocks = await _build_multimodal_blocks_for_inbound_files(
                "mixed",
                [
                    "not-a-dict",  # type: ignore[list-item]
                    {"filename": "ok.png", "mime_type": "image/png", "content": b"PNG"},
                    {"filename": "no-content.png", "mime_type": "image/png"},
                    {"filename": "bad-content", "mime_type": "image/png", "content": "not-bytes"},
                ],
            )

            # text + only one valid image survives.
            assert [b["type"] for b in blocks] == ["text", "image"]

        _run(go())


class TestManagerInboundFileReaderRegistry:
    """``register_inbound_file_reader`` + ``_resolve_human_message_input``
    drive the actual download path that runs inside ``_handle_chat``."""

    def test_resolve_input_text_only_when_no_files(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            mgr = ChannelManager(bus=bus, store=store)
            msg = InboundMessage(channel_name="telegram", chat_id="1", user_id="u", text="hi")

            input_payload = await mgr._resolve_human_message_input(msg)

            assert input_payload == {"messages": [{"role": "human", "content": "hi"}]}

        _run(go())

    def test_resolve_input_uses_registered_reader_for_attachments(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            mgr = ChannelManager(bus=bus, store=store)

            async def fake_reader(_inbound):
                return [{"filename": "p.png", "mime_type": "image/png", "content": b"PNG"}]

            mgr.register_inbound_file_reader("telegram", fake_reader)

            msg = InboundMessage(
                channel_name="telegram",
                chat_id="1",
                user_id="u",
                text="see this",
                files=[{"file_id": "ph", "filename": "p.png", "mime_type": "image/png"}],
            )
            input_payload = await mgr._resolve_human_message_input(msg)
            blocks = input_payload["messages"][0]["content"]

            assert isinstance(blocks, list)
            assert blocks[0] == {"type": "text", "text": "see this"}
            assert blocks[1]["type"] == "image"

        _run(go())

    def test_resolve_input_falls_back_to_descriptive_text_when_no_reader(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            mgr = ChannelManager(bus=bus, store=store)

            msg = InboundMessage(
                channel_name="slack",  # no reader registered
                chat_id="1",
                user_id="u",
                text="see this",
                files=[{"file_id": "x", "filename": "doc.pdf", "mime_type": "application/pdf"}],
            )
            input_payload = await mgr._resolve_human_message_input(msg)
            content = input_payload["messages"][0]["content"]

            # String content (text-only fallback) carrying a description so
            # the LLM doesn't pretend the user sent nothing.
            assert isinstance(content, str)
            assert "doc.pdf" in content
            assert "application/pdf" in content

        _run(go())

    def test_resolve_input_falls_back_when_reader_raises(self):
        from app.channels.manager import ChannelManager

        async def go():
            bus = MessageBus()
            store = ChannelStore(path=Path(tempfile.mkdtemp()) / "store.json")
            mgr = ChannelManager(bus=bus, store=store)

            async def broken_reader(_inbound):
                raise RuntimeError("boom")

            mgr.register_inbound_file_reader("telegram", broken_reader)

            msg = InboundMessage(
                channel_name="telegram",
                chat_id="1",
                user_id="u",
                text="hi",
                files=[{"file_id": "x", "filename": "p.png", "mime_type": "image/png"}],
            )
            input_payload = await mgr._resolve_human_message_input(msg)

            # Reader failure → text-only payload preserves the user's intent
            # without crashing the dispatch.
            assert input_payload == {"messages": [{"role": "human", "content": "hi"}]}

        _run(go())


# Add base64 import at module scope for the multimodal block tests.
import base64  # noqa: E402  — kept at end to minimise diff against pre-B5 file
