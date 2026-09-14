"""Channel identity binding scopes the shared SDK; it is not source approval."""
import asyncio

from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus
from app.channels.store import ChannelStore
from deerflow.sophia.langgraph_client_auth import _owner, langgraph_owner_scope


def test_canonical_binding_precedes_task_local_owner_scope(tmp_path, monkeypatch):
    manager = ChannelManager(bus=MessageBus(), store=ChannelStore(path=tmp_path / "channels.json"))
    seen = []
    def bind(msg):
        msg.user_id = "canonical-" + msg.user_id
    monkeypatch.setattr(manager, "_apply_canonical_user_id", bind)
    async def handle(msg):
        await asyncio.sleep(0)
        seen.append((msg.user_id, _owner.get()))
    monkeypatch.setattr(manager, "_handle_chat", handle)
    monkeypatch.setattr(manager, "_handle_command", handle)
    async def run():
        manager._semaphore = asyncio.Semaphore(2)
        with langgraph_owner_scope("outer"):
            await asyncio.gather(*(manager._handle_message(InboundMessage(channel_name="test", chat_id=owner,
                user_id=owner, text="synthetic", msg_type=kind)) for owner, kind in [
                    ("a", InboundMessageType.CHAT), ("b", InboundMessageType.COMMAND)]))
            assert _owner.get() == "outer"
        assert _owner.get() is None
    asyncio.run(run())
    assert sorted(seen) == [("canonical-a", "canonical-a"), ("canonical-b", "canonical-b")]


def test_error_handler_cannot_inherit_failed_channel_owner(tmp_path, monkeypatch):
    manager = ChannelManager(bus=MessageBus(), store=ChannelStore(path=tmp_path / "channels.json"))
    seen = []
    async def fail(msg):
        assert _owner.get() == "owner"
        raise RuntimeError("synthetic")
    async def error(msg, text):
        seen.append(_owner.get())
    monkeypatch.setattr(manager, "_handle_chat", fail)
    monkeypatch.setattr(manager, "_send_error", error)
    async def run():
        manager._semaphore = asyncio.Semaphore(2)
        await manager._handle_message(InboundMessage(channel_name="test", chat_id="chat", user_id="owner", text="synthetic"))
    asyncio.run(run())
    assert seen == [None]
    assert _owner.get() is None
