"""CompanionProgressReceiver — Sophia (EI bot) owns the streaming progress UX.

Phase 3 of the workshop architecture. When companion's
``start_builder_task`` fires in a Telegram chat, the channel layer
sends a placeholder message ("Working on it…") from the EI bot and
binds a ``CompanionProgressReceiver`` to it via the
``WorkshopTelegramSink``. The receiver consumes builder events from
the fanout and edits the placeholder message live as the build runs.

This replaces Phase 2's @-mention summon → workshop-bot streaming
reply pattern. Reasons:

- No chat pollution (the delegation brief is no longer dumped in chat).
- No dependency on Telegram Guest Mode / Bot-to-Bot dispatch routing.
- Single bot, single voice in the chat.
- The workshop bot's polling thread can stay disabled; the
  ``WorkshopTelegramSink`` becomes a generic "stream-to-channel"
  conduit and the receiver is whoever wants to render those events.

The receiver does NOT deliver the final artifact. That stays with
``telegram._on_builder_completion`` (subscribed to the channel bus
under ``publish_builder_completion``). The receiver finalizes the
placeholder with the summary and unregisters — the artifact follows
as a Telegram document from the existing path.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.channels.telegram_workshop_renderer import WorkshopMessageRenderer
from app.channels.telegram_workshop_streaming import StreamingTextClient
from app.gateway.builder_events.types import BuilderEvent, CompletedEvent

logger = logging.getLogger(__name__)


class CompanionProgressReceiver:
    """Bound to one (chat_id, placeholder_message_id) on the EI bot.

    The receiver lives in the gateway process, where the fanout
    dispatches events. Bot calls (``edit_message_text`` etc.) are
    loop-affine to the EI bot's polling thread loop, so we bounce
    edits through ``asyncio.run_coroutine_threadsafe``.
    """

    def __init__(
        self,
        *,
        bot: Any,
        chat_id: int,
        message_id: int,
        tg_loop: asyncio.AbstractEventLoop,
        sink: Any,
        task_id: str,
    ) -> None:
        self._bot = bot
        self._chat_id = int(chat_id)
        self._message_id = int(message_id)
        self._tg_loop = tg_loop
        self._sink = sink
        self._task_id = task_id
        self._renderer = WorkshopMessageRenderer()
        self._streaming = StreamingTextClient(bot=bot, chat_id=chat_id)
        # Mark the streaming client as already-open against the existing
        # placeholder so subsequent ``set_body`` calls edit it instead of
        # sending a new message.
        self._streaming._message_id = self._message_id  # noqa: SLF001
        self._streaming._latest_body = ""  # noqa: SLF001
        self._streaming._last_pushed_body = ""  # noqa: SLF001
        self._finalized = False

    async def on_event(self, event: BuilderEvent) -> None:
        """Apply one builder event to the rendered placeholder.

        Never raises — failures are logged and isolated so a single
        bad event doesn't break the rest of the stream.
        """
        if self._finalized:
            return

        try:
            result = self._renderer.apply(event)
        except Exception:
            logger.warning(
                "[CompanionProgressReceiver] renderer.apply raised task_id=%s type=%s",
                self._task_id,
                getattr(event, "type", "?"),
                exc_info=True,
            )
            return

        if result.state_changed:
            body = self._renderer.render()
            await self._push_edit(body, flush=result.terminal)

        if result.terminal and isinstance(event, CompletedEvent):
            self._finalized = True
            try:
                self._sink.unregister_workshop(self._task_id)
            except Exception:
                logger.debug(
                    "[CompanionProgressReceiver] unregister_workshop raised task_id=%s",
                    self._task_id,
                    exc_info=True,
                )

    async def _push_edit(self, body: str, *, flush: bool) -> None:
        """Bounce the editMessageText onto the EI bot's polling loop."""
        if self._tg_loop is None or not self._tg_loop.is_running():
            logger.warning(
                "[CompanionProgressReceiver] tg_loop not running; dropping edit task_id=%s",
                self._task_id,
            )
            return
        future = asyncio.run_coroutine_threadsafe(
            self._streaming.set_body(body, flush=flush), self._tg_loop
        )
        try:
            await asyncio.wrap_future(future)
        except Exception:
            logger.warning(
                "[CompanionProgressReceiver] streaming set_body raised task_id=%s",
                self._task_id,
                exc_info=True,
            )


__all__ = ["CompanionProgressReceiver"]
