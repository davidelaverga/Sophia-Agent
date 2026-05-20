"""Abstract base class for IM channels."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment

logger = logging.getLogger(__name__)


class Channel(ABC):
    """Base class for all IM channel implementations.

    Each channel connects to an external messaging platform and:
    1. Receives messages, wraps them as InboundMessage, publishes to the bus.
    2. Subscribes to outbound messages and sends replies back to the platform.

    Subclasses must implement ``start``, ``stop``, and ``send``.
    """

    def __init__(self, name: str, bus: MessageBus, config: dict[str, Any]) -> None:
        self.name = name
        self.bus = bus
        self.config = config
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    # -- lifecycle ---------------------------------------------------------

    @abstractmethod
    async def start(self) -> None:
        """Start listening for messages from the external platform."""

    @abstractmethod
    async def stop(self) -> None:
        """Gracefully stop the channel."""

    # -- outbound ----------------------------------------------------------

    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None:
        """Send a message back to the external platform.

        The implementation should use ``msg.chat_id`` and ``msg.thread_ts``
        to route the reply to the correct conversation/thread.
        """

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        """Upload a single file attachment to the platform.

        Returns True if the upload succeeded, False otherwise.
        Default implementation returns False (no file upload support).
        """
        return False

    # -- helpers -----------------------------------------------------------

    def _make_inbound(
        self,
        chat_id: str,
        user_id: str,
        text: str,
        *,
        msg_type: InboundMessageType = InboundMessageType.CHAT,
        thread_ts: str | None = None,
        files: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> InboundMessage:
        """Convenience factory for creating InboundMessage instances."""
        return InboundMessage(
            channel_name=self.name,
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=msg_type,
            thread_ts=thread_ts,
            files=files or [],
            metadata=metadata or {},
        )

    async def _on_outbound(self, msg: OutboundMessage) -> bool | None:
        """Outbound callback registered with the bus.

        Only forwards messages targeted at this channel. Sends the text
        message first, then uploads any file attachments. File uploads
        are skipped entirely when the text send fails to avoid partial
        deliveries (files without accompanying text).

        Phase 4F (codex P1 post-review, fifth pass): the text-send
        exception is logged AND RE-RAISED. The bus's
        ``publish_outbound`` already has its own iteration-level catch
        (so a single channel's failure doesn't crash other channels'
        listeners), and ``publish_outbound_strict`` needs the
        propagated exception to flip ``all_ok=False`` for delivery-
        sensitive callers. Catching here too was redundant defensive
        coding that hid send failures from the manager's placeholder
        path. File-upload failures remain non-fatal (advisory) — they
        are independent attachments and a failed upload should not
        flip delivery to False for the text payload.

        Phase 4M (codex P1 post-Phase-4K rollback review): explicit
        ``True`` return on the matching-channel-and-sent path so
        ``publish_outbound_strict`` can confirm THIS listener actually
        handled the message. The channel-mismatch branch returns
        ``None`` implicitly (no-op) so other channels' listeners can
        still be subscribed without falsely signalling handled. See
        the ``OutboundCallback`` contract in ``message_bus.py``.
        """
        if msg.channel_name == self.name:
            try:
                await self.send(msg)
            except Exception:
                logger.exception("Failed to send outbound message on channel %s", self.name)
                raise

            for attachment in msg.attachments:
                try:
                    success = await self.send_file(msg, attachment)
                    if not success:
                        logger.warning("[%s] file upload skipped for %s", self.name, attachment.filename)
                except Exception:
                    logger.exception("[%s] failed to upload file %s", self.name, attachment.filename)

            return True
        return None
