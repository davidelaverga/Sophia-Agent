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

# Phase 4M (codex P1 post-Phase-4K rollback review): outbound callbacks
# may now return ``True`` to signal "I handled this message" (used by
# ``publish_outbound_strict`` to confirm at least one listener actually
# consumed the message before reporting delivery success). Returning
# ``None`` / ``False`` means "no-op for me" (e.g.,
# ``Channel._on_outbound`` no-ops when ``msg.channel_name != self.name``).
# Raising means "delivery error" — ``publish_outbound_strict`` treats
# both not-handled AND raised as undelivered. Back-compat: existing
# ``publish_outbound`` (non-strict) ignores the return value entirely.
OutboundCallback = Callable[[OutboundMessage], Coroutine[Any, Any, bool | None]]
BuilderCompletionCallback = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]
ReviewNotificationCallback = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


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

    Memory-review notifications ride a third track for the same reason:
    the Telegram session tracker publishes a ``review_notification`` event
    after the offline pipeline completes; channel adapters subscribe and
    render a LoginUrl-button DM. Keeping this on the bus instead of a
    direct module import keeps ``app.channels.telegram_session_tracker``
    independent of ``app.channels.service`` (would otherwise close a
    ``service → manager → tracker → service`` cycle).
    """

    def __init__(self) -> None:
        self._inbound_queue: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self._outbound_listeners: list[OutboundCallback] = []
        self._builder_completion_listeners: list[BuilderCompletionCallback] = []
        self._review_notification_listeners: list[ReviewNotificationCallback] = []

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
        """Dispatch an outbound message to all registered listeners.

        Listener exceptions are CAUGHT AND LOGGED, not raised (this is
        v3-migration learning #3: a Telegram send failure is invisible
        to callers that rely on the bus return). Callers that need
        delivery confirmation should use ``publish_outbound_strict``.
        """
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

    async def publish_outbound_strict(self, msg: OutboundMessage) -> bool:
        """Dispatch like ``publish_outbound`` but confirm a listener handled it.

        Returns ``True`` only when:

        - At least one listener returned ``True`` (signalling "I handled
          this message" — for ``Channel._on_outbound`` that means the
          listener's ``channel_name`` matched ``msg.channel_name`` AND
          the send succeeded), AND
        - No listener raised an exception during iteration.

        Returns ``False`` when:

        - No listeners are registered, OR
        - All listeners returned a falsy value (none handled — e.g., the
          target channel's listener was unregistered during a restart
          race while other channels' listeners remain subscribed), OR
        - At least one listener raised (the bus still iterates the rest
          so unaffected channels still receive the message, but the
          boolean tells the caller "delivery wasn't confirmed").

        Phase 4M (codex P1 post-Phase-4K rollback review): added the
        "at-least-one-handled" check. Without it, a publish during a
        window where the target listener was missing but OTHER channel
        listeners remained subscribed reported ``True`` (no listener
        raised — they just no-op'd via ``msg.channel_name != self.name``)
        and the manager dedup-marked the ``(task_id, run_id)``,
        permanently blocking retries for that run even though no
        channel actually consumed the placeholder. Requiring an
        explicit ``True`` return closes this race.

        Phase 4J (codex P2 post-Phase-4I review): the zero-listener case
        is also ``False`` — same rationale, just a different cause
        (channel never registered vs. wrong channel registered).

        Use this for delivery-sensitive paths like the builder progress
        placeholder.
        """
        logger.info(
            "[Bus] outbound dispatching (strict): channel=%s, chat_id=%s, listeners=%d, text_len=%d",
            msg.channel_name,
            msg.chat_id,
            len(self._outbound_listeners),
            len(msg.text),
        )
        if not self._outbound_listeners:
            # Codex P2 (Phase 4J): zero listeners = undelivered.
            logger.warning(
                "[Bus] publish_outbound_strict with zero listeners — "
                "treating as undelivered (channel=%s chat_id=%s)",
                msg.channel_name,
                msg.chat_id,
            )
            return False

        any_handled = False
        any_failed = False
        for callback in self._outbound_listeners:
            try:
                result = await callback(msg)
            except Exception:
                any_failed = True
                logger.exception(
                    "Error in outbound callback (strict) for channel=%s",
                    msg.channel_name,
                )
                continue
            # Phase 4M: explicit-True contract. Listeners that no-op
            # (channel-name mismatch) return None and DO NOT count as
            # a handler. Only an explicit ``True`` means "I did the
            # work this message asked for".
            if result is True:
                any_handled = True

        if any_failed:
            return False
        if not any_handled:
            logger.warning(
                "[Bus] publish_outbound_strict: no listener handled the "
                "message channel=%s chat_id=%s listeners=%d — likely the "
                "target-channel listener is missing (restart race / "
                "wrong channel registered). Treating as undelivered "
                "so the caller can retry.",
                msg.channel_name,
                msg.chat_id,
                len(self._outbound_listeners),
            )
            return False
        return True

    # -- builder completion ------------------------------------------------

    def subscribe_builder_completion(self, callback: BuilderCompletionCallback) -> None:
        """Register a coroutine listener for builder completion events.

        Each channel adapter that surfaces completion cards (Telegram first,
        Slack/Feishu later) subscribes here. The callback receives the raw
        webhook payload from
        ``deerflow.sophia.builder_events.build_completion_payload_from_artifact``.
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

    # -- review notification (Telegram memory review handoff) --------------

    def subscribe_review_notification(
        self, callback: ReviewNotificationCallback
    ) -> None:
        """Register a coroutine listener for memory-review notifications."""
        self._review_notification_listeners.append(callback)

    def unsubscribe_review_notification(
        self, callback: ReviewNotificationCallback
    ) -> None:
        self._review_notification_listeners = [
            cb for cb in self._review_notification_listeners if cb is not callback
        ]

    async def publish_review_notification(self, payload: dict[str, Any]) -> None:
        """Fan a memory-review notification out to subscribed adapters.

        Payload keys (set by ``telegram_review_notifier``):
          - ``channel``: target channel name (e.g. ``"telegram"``)
          - ``chat_id``: chat to deliver into
          - ``session_id``: the just-finalized session
          - ``review_url``: the URL to put on the inline-keyboard button
          - ``use_login_url``: bool — Telegram LoginUrl button vs plain URL

        Best-effort: failures are logged, never raised.
        """
        logger.info(
            "[Bus] review_notification dispatching: channel=%s chat_id=%s session_id=%s listeners=%d",
            payload.get("channel"),
            payload.get("chat_id"),
            payload.get("session_id"),
            len(self._review_notification_listeners),
        )
        for callback in self._review_notification_listeners:
            try:
                await callback(payload)
            except Exception:
                logger.exception(
                    "Error in review_notification callback for chat_id=%s",
                    payload.get("chat_id"),
                )


# ---------------------------------------------------------------------------
# Module-level convenience for the gateway router
# ---------------------------------------------------------------------------


_global_bus: MessageBus | None = None


def set_global_bus(bus: MessageBus | None) -> None:
    """Register (or clear) the process-wide bus.

    Channels register themselves on this bus during their startup. The
    gateway router uses it to forward incoming builder-events webhooks
    without needing app-state plumbing.
    """
    global _global_bus
    _global_bus = bus


def get_global_bus() -> MessageBus | None:
    return _global_bus


async def publish_builder_completion(payload: dict[str, Any]) -> None:
    """Publish a builder completion to the process-wide bus, if installed."""
    bus = _global_bus
    if bus is None:
        logger.debug("publish_builder_completion: no global bus installed; skipping channel fan-out")
        return
    await bus.publish_builder_completion(payload)


async def publish_review_notification(payload: dict[str, Any]) -> None:
    """Publish a memory-review notification to the process-wide bus.

    Used by the Telegram session tracker after the offline pipeline
    finalizes a session. Best-effort: a missing global bus is logged and
    swallowed — the trace + handoff already wrote to disk so the user is
    not stranded, just unnotified.
    """
    bus = _global_bus
    if bus is None:
        logger.debug(
            "publish_review_notification: no global bus installed; skipping fan-out"
        )
        return
    await bus.publish_review_notification(payload)
