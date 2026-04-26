"""MessageBus — async pub/sub hub that decouples channels from the agent dispatcher."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Message types
# ---------------------------------------------------------------------------


class InboundMessageType(StrEnum):
    """Types of messages arriving from IM channels."""

    CHAT = "chat"
    COMMAND = "command"


@dataclass
class InboundMessage:
    """A message arriving from an IM channel toward the agent dispatcher.

    Attributes:
        channel_name: Name of the source channel (e.g. "feishu", "slack").
        chat_id: Platform-specific chat/conversation identifier.
        user_id: Platform-specific user identifier.
        text: The message text.
        msg_type: Whether this is a regular chat message or a command.
        thread_ts: Optional platform thread identifier (for threaded replies).
        topic_id: Conversation topic identifier used to map to a DeerFlow thread.
            Messages sharing the same ``topic_id`` within a ``chat_id`` will
            reuse the same DeerFlow thread.  When ``None``, each message
            creates a new thread (one-shot Q&A).
        files: Optional list of file attachments (platform-specific dicts).
        metadata: Arbitrary extra data from the channel.
        created_at: Unix timestamp when the message was created.
    """

    channel_name: str
    chat_id: str
    user_id: str
    text: str
    msg_type: InboundMessageType = InboundMessageType.CHAT
    thread_ts: str | None = None
    topic_id: str | None = None
    files: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


@dataclass
class ResolvedAttachment:
    """A file attachment resolved to a host filesystem path, ready for upload.

    Attributes:
        virtual_path: Original virtual path (e.g. /mnt/user-data/outputs/report.pdf).
        actual_path: Resolved host filesystem path.
        filename: Basename of the file.
        mime_type: MIME type (e.g. "application/pdf").
        size: File size in bytes.
        is_image: True for image/* MIME types (platforms may handle images differently).
    """

    virtual_path: str
    actual_path: Path
    filename: str
    mime_type: str
    size: int
    is_image: bool


@dataclass
class OutboundMessage:
    """A message from the agent dispatcher back to a channel.

    Attributes:
        channel_name: Target channel name (used for routing).
        chat_id: Target chat/conversation identifier.
        thread_id: DeerFlow thread ID that produced this response.
        text: The response text.
        artifacts: List of artifact paths produced by the agent.
        is_final: Whether this is the final message in the response stream.
        thread_ts: Optional platform thread identifier for threaded replies.
        metadata: Arbitrary extra data.
        created_at: Unix timestamp.
    """

    channel_name: str
    chat_id: str
    thread_id: str
    text: str
    artifacts: list[str] = field(default_factory=list)
    attachments: list[ResolvedAttachment] = field(default_factory=list)
    is_final: bool = True
    thread_ts: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# MessageBus
# ---------------------------------------------------------------------------

OutboundCallback = Callable[[OutboundMessage], Coroutine[Any, Any, None]]
BuilderCompletionCallback = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


class MessageBus:
    """Async pub/sub hub connecting channels and the agent dispatcher.

    Channels publish inbound messages; the dispatcher consumes them.
    The dispatcher publishes outbound messages; channels receive them
    via registered callbacks.

    Builder-completion events ride a parallel pub/sub track. They are not
    OutboundMessages — they don't have a per-turn ``text`` and they fire
    asynchronously after the parent companion run already returned. Each
    channel adapter that wants to render completion cards subscribes via
    ``subscribe_builder_completion``.
    """

    def __init__(self) -> None:
        self._inbound_queue: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self._outbound_listeners: list[OutboundCallback] = []
        self._builder_completion_listeners: list[BuilderCompletionCallback] = []

    # -- inbound -----------------------------------------------------------

    async def publish_inbound(self, msg: InboundMessage) -> None:
        """Enqueue an inbound message from a channel."""
        await self._inbound_queue.put(msg)
        logger.info(
            "[Bus] inbound enqueued: channel=%s, chat_id=%s, type=%s, queue_size=%d",
            msg.channel_name,
            msg.chat_id,
            msg.msg_type.value,
            self._inbound_queue.qsize(),
        )

    async def get_inbound(self) -> InboundMessage:
        """Block until the next inbound message is available."""
        return await self._inbound_queue.get()

    @property
    def inbound_queue(self) -> asyncio.Queue[InboundMessage]:
        return self._inbound_queue

    # -- outbound ----------------------------------------------------------

    def subscribe_outbound(self, callback: OutboundCallback) -> None:
        """Register an async callback for outbound messages."""
        self._outbound_listeners.append(callback)

    def unsubscribe_outbound(self, callback: OutboundCallback) -> None:
        """Remove a previously registered outbound callback."""
        self._outbound_listeners = [cb for cb in self._outbound_listeners if cb is not callback]

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Dispatch an outbound message to all registered listeners."""
        logger.info(
            "[Bus] outbound dispatching: channel=%s, chat_id=%s, listeners=%d, text_len=%d",
            msg.channel_name,
            msg.chat_id,
            len(self._outbound_listeners),
            len(msg.text),
        )
        for callback in self._outbound_listeners:
            try:
                await callback(msg)
            except Exception:
                logger.exception("Error in outbound callback for channel=%s", msg.channel_name)

    # -- builder completion ------------------------------------------------

    def subscribe_builder_completion(self, callback: BuilderCompletionCallback) -> None:
        """Register a coroutine listener for builder completion events.

        Each channel adapter that surfaces completion cards (Telegram first,
        Slack/Feishu later) subscribes here. The callback receives the raw
        webhook payload from
        ``deerflow.sophia.builder_events.build_completion_payload``.
        Adapters are responsible for the channel-specific rendering and
        thread→chat_id reverse lookup (via ``app.channels.store``).
        """
        self._builder_completion_listeners.append(callback)

    def unsubscribe_builder_completion(self, callback: BuilderCompletionCallback) -> None:
        self._builder_completion_listeners = [
            cb for cb in self._builder_completion_listeners if cb is not callback
        ]

    async def publish_builder_completion(self, payload: dict[str, Any]) -> None:
        """Fan a builder completion event out to all subscribed channel adapters.

        Best-effort: a failing adapter logs but never blocks the others.
        """
        logger.info(
            "[Bus] builder_completion dispatching: thread_id=%s task_id=%s status=%s listeners=%d",
            payload.get("thread_id"),
            payload.get("task_id"),
            payload.get("status"),
            len(self._builder_completion_listeners),
        )
        for callback in self._builder_completion_listeners:
            try:
                await callback(payload)
            except Exception:
                logger.exception(
                    "Error in builder_completion callback for task_id=%s",
                    payload.get("task_id"),
                )


# ---------------------------------------------------------------------------
# Module-level convenience for the gateway router
# ---------------------------------------------------------------------------


_global_bus: "MessageBus | None" = None


def set_global_bus(bus: "MessageBus | None") -> None:
    """Register (or clear) the process-wide bus.

    Channels register themselves on this bus during their startup. The
    gateway router uses it to forward incoming builder-events webhooks
    without needing app-state plumbing.
    """
    global _global_bus
    _global_bus = bus


def get_global_bus() -> "MessageBus | None":
    return _global_bus


async def publish_builder_completion(payload: dict[str, Any]) -> None:
    """Publish a builder completion to the process-wide bus, if installed."""
    bus = _global_bus
    if bus is None:
        logger.debug("publish_builder_completion: no global bus installed; skipping channel fan-out")
        return
    await bus.publish_builder_completion(payload)
