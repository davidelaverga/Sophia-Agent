"""WorkshopTelegramChannel — @Sophia_work_bot presentation layer.

Phase 2 of ``sophia_telegram_architecture_spec_v1.md``. When companion's
``start_builder_task`` tool fires in a Telegram chat, the companion's
channel handler posts a follow-up ``@Sophia_work_bot`` message in the
same chat. Telegram dispatches a guest update to this bot. The handler:

1. Resolves ``(chat_id, summoning_message_id) → (task_id, user_id)`` via
   the gateway ``TaskResolutionCache``.
2. Opens a streaming reply via ``StreamingTextClient``.
3. Registers a receiver with ``WorkshopTelegramSink`` for the task_id;
   the sink dispatches builder events (from the fanout) to the receiver,
   which projects them via ``WorkshopMessageRenderer`` and pushes
   incremental updates through the streaming client.
4. On the terminal event: finalizes the streaming message and sends the
   artifact as a Telegram document via the shared
   ``_sophia_artifact_bridge.download_artifact`` path the EI bot uses.

Mutual exclusion: this channel and the legacy ``telegram_work`` (PR #120
Builder-as-Main DM) share the same bot token. ``start`` refuses to run
if the legacy channel is also enabled in config.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from io import BytesIO
from typing import Any

from app.channels.base import Channel
from app.channels.message_bus import MessageBus, OutboundMessage
from app.channels.telegram_loop_prevention import LoopPreventionGate
from app.channels.telegram_workshop_renderer import WorkshopMessageRenderer
from app.channels.telegram_workshop_streaming import StreamingTextClient
from app.gateway.builder_events.types import BuilderEvent, CompletedEvent

logger = logging.getLogger(__name__)


_CHANNEL_NAME = "telegram_workshop"
_DEFAULT_BOT_USERNAME = "Sophia_work_bot"
_COLD_DM_MUTE_MINUTES_DEFAULT = 30
_DEFAULT_TASK_TIMEOUT_SECONDS = 900
_TELEGRAM_CAPTION_LIMIT = 1024


def _strict_loop_prevention() -> bool:
    return os.environ.get("TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT", "true").lower() not in {"0", "false", "no"}


def _workshop_enabled_env() -> bool:
    # Phase 2 default ON — flipping the master kill switch requires
    # ``TELEGRAM_WORKSHOP_BOT_ENABLED=false`` plus the config-level
    # ``channels.telegram_workshop.enabled: false``.
    return os.environ.get("TELEGRAM_WORKSHOP_BOT_ENABLED", "true").lower() not in {"0", "false", "no"}


def _task_timeout_seconds() -> int:
    try:
        return int(os.environ.get("WORKSHOP_TASK_TIMEOUT_SECONDS", _DEFAULT_TASK_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        return _DEFAULT_TASK_TIMEOUT_SECONDS


class _WorkshopEventReceiver:
    """Per-task receiver that renders events and pushes to a StreamingTextClient.

    Runs on the gateway's main async loop (where the fanout publishes);
    bot calls are dispatched back onto the workshop's ``_tg_loop`` via
    ``run_coroutine_threadsafe`` because PTB bot I/O is loop-affine.
    """

    def __init__(
        self,
        *,
        streaming_client: StreamingTextClient,
        renderer: WorkshopMessageRenderer,
        tg_loop: asyncio.AbstractEventLoop,
        completed: asyncio.Event,
        terminal_event_box: list[CompletedEvent | None],
    ) -> None:
        self._streaming = streaming_client
        self._renderer = renderer
        self._tg_loop = tg_loop
        self._completed = completed
        self._terminal_event = terminal_event_box

    async def on_event(self, event: BuilderEvent) -> None:
        try:
            result = self._renderer.apply(event)
        except Exception:
            logger.warning("[TelegramWorkshop] renderer apply raised task_id=%s", event.task_id, exc_info=True)
            return

        if result.state_changed:
            body = self._renderer.render()
            await self._dispatch_streaming(body, flush=result.terminal)

        if result.terminal and isinstance(event, CompletedEvent):
            self._terminal_event[0] = event
            self._completed.set()

    async def _dispatch_streaming(self, body: str, *, flush: bool) -> None:
        """Bounce the streaming-text update onto the PTB event loop."""
        if not self._tg_loop or not self._tg_loop.is_running():
            logger.warning("[TelegramWorkshop] tg_loop not running; dropping update")
            return
        future = asyncio.run_coroutine_threadsafe(
            self._streaming.set_body(body, flush=flush), self._tg_loop
        )
        try:
            await asyncio.wrap_future(future)
        except Exception:
            logger.warning("[TelegramWorkshop] streaming set_body raised", exc_info=True)


class WorkshopTelegramChannel(Channel):
    """@Sophia_work_bot — workshop presentation layer (Phase 2)."""

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name=_CHANNEL_NAME, bus=bus, config=config)
        self._application = None
        self._thread: threading.Thread | None = None
        self._tg_loop: asyncio.AbstractEventLoop | None = None
        self._bot_token = str(config.get("bot_token", "")).strip()
        self._bot_username = str(config.get("bot_username", _DEFAULT_BOT_USERNAME)).strip().lstrip("@")
        self._companion_bot_username = (
            os.environ.get("SOPHIA_EI_BOT_USERNAME")
            or str(config.get("companion_bot_username", "")).strip().lstrip("@")
            or "Sophia_EI_bot"
        )
        self._config_enabled = bool(config.get("enabled", False))
        self._cold_dm_mute_minutes = int(config.get("cold_dm_mute_minutes", _COLD_DM_MUTE_MINUTES_DEFAULT))
        self._task_timeout_seconds = _task_timeout_seconds()
        self._muted_users: dict[int, float] = {}
        self._loop_prevention = LoopPreventionGate()
        self._strict_loop_prevention = _strict_loop_prevention()
        self._background_tasks: set[asyncio.Task] = set()

    # -- lifecycle ----------------------------------------------------------

    @property
    def is_active(self) -> bool:
        return self._config_enabled and _workshop_enabled_env()

    async def start(self) -> None:
        if self._running:
            return

        if self._config_enabled and self._legacy_work_channel_enabled():
            logger.error(
                "[TelegramWorkshop] cannot start: channels.telegram_work.enabled=true. "
                "Disable the legacy telegram_work channel before enabling telegram_workshop."
            )
            return

        if not self.is_active:
            reason = "config" if not self._config_enabled else "env"
            logger.info(
                "[TelegramWorkshop] disabled (%s) — skipping start",
                reason,
            )
            return

        if not self._bot_token:
            logger.error(
                "[TelegramWorkshop] bot_token empty; set channels.telegram_workshop.bot_token "
                "(or $TELEGRAM_WORKER_BOT_TOKEN) and restart"
            )
            return

        try:
            from telegram.ext import ApplicationBuilder, MessageHandler, filters
        except ImportError:
            logger.error("[TelegramWorkshop] python-telegram-bot not installed. Install it with: uv add python-telegram-bot")
            return

        self._running = True

        app = ApplicationBuilder().token(self._bot_token).build()
        # No /start command — workshop should never respond to /start
        # directly. All updates flow through the text-message handler
        # which discriminates between guest dispatch and cold DM.
        app.add_handler(MessageHandler(filters.TEXT, self._on_text))
        self._application = app

        self._thread = threading.Thread(target=self._run_polling, daemon=True)
        self._thread.start()
        logger.info(
            "[TelegramWorkshop] started bot_username=%s companion_bot_username=%s task_timeout=%ds strict_loop_prevention=%s",
            self._bot_username,
            self._companion_bot_username,
            self._task_timeout_seconds,
            self._strict_loop_prevention,
        )

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        if self._tg_loop and self._tg_loop.is_running():
            self._tg_loop.call_soon_threadsafe(self._tg_loop.stop)
        if self._thread:
            self._thread.join(timeout=10)
            self._thread = None
        self._application = None
        logger.info("[TelegramWorkshop] stopped")

    async def send(self, msg: OutboundMessage) -> None:
        """Bus-driven outbound is unused — workshop is event-driven."""
        if msg.channel_name == self.name:
            logger.debug("[TelegramWorkshop] received bus outbound; workshop is event-driven, ignoring")

    def _run_polling(self) -> None:
        self._tg_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._tg_loop)
        try:
            self._tg_loop.run_until_complete(self._application.initialize())
            self._tg_loop.run_until_complete(self._application.start())
            self._tg_loop.run_until_complete(self._application.updater.start_polling())
            self._tg_loop.run_forever()
        except Exception:
            if self._running:
                logger.exception("[TelegramWorkshop] polling error")
        finally:
            try:
                if self._application and self._application.updater.running:
                    self._tg_loop.run_until_complete(self._application.updater.stop())
                if self._application:
                    self._tg_loop.run_until_complete(self._application.stop())
                    self._tg_loop.run_until_complete(self._application.shutdown())
            except Exception:
                logger.exception("[TelegramWorkshop] error during shutdown")

    # -- handlers ----------------------------------------------------------

    async def _on_text(self, update, _context) -> None:
        try:
            chat_id = int(update.effective_chat.id)
            telegram_user_id = int(update.effective_user.id) if update.effective_user else 0
        except (AttributeError, TypeError, ValueError):
            return

        if self._is_guest_dispatch(update):
            task = asyncio.create_task(self._handle_guest_dispatch(update))
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)
            return

        # Cold DM path — only respond when it's a private chat. Group
        # mentions / replies are ignored silently (no loop risk).
        chat_type = getattr(update.effective_chat, "type", None)
        if chat_type != "private":
            return

        bot = self._application.bot if self._application else None
        if bot is None:
            return
        await self.handle_cold_dm(
            telegram_user_id=telegram_user_id,
            bot_send=bot.send_message,
            chat_id=chat_id,
        )

    def _is_guest_dispatch(self, update) -> bool:
        """True when this update looks like a Telegram guest dispatch.

        Heuristics: the message author is a bot, AND that bot is the
        companion EI bot, AND the text starts with an ``@``-mention of us.
        Other shapes (direct user mentions, dispatch from unknown bots)
        are deferred to v2 per spec §11.4.
        """
        msg = getattr(update, "message", None) or getattr(update, "effective_message", None)
        if msg is None:
            return False
        from_user = getattr(msg, "from_user", None)
        if from_user is None or not getattr(from_user, "is_bot", False):
            return False
        author_username = (getattr(from_user, "username", None) or "").lstrip("@")
        if author_username.lower() != self._companion_bot_username.lower():
            logger.info(
                "[TelegramWorkshop] guest dispatch from unknown bot @%s — ignoring",
                author_username,
            )
            return False
        text = (msg.text or "").lstrip()
        expected_prefix = f"@{self._bot_username}".lower()
        return text.lower().startswith(expected_prefix)

    async def _handle_guest_dispatch(self, update) -> None:
        bot = self._application.bot if self._application else None
        msg = getattr(update, "message", None) or getattr(update, "effective_message", None)
        from_user = getattr(msg, "from_user", None) if msg else None
        if bot is None or msg is None or from_user is None:
            return

        chat_id = int(update.effective_chat.id)
        summoning_message_id = int(msg.message_id)
        source_bot_id = int(from_user.id)
        text = msg.text or ""

        if not self.check_loop_prevention(
            chat_id=chat_id,
            root_message_id=summoning_message_id,
            source_bot_id=source_bot_id,
            text=text,
        ):
            return

        from app.gateway.builder_events import get_global_task_cache, get_global_workshop_sink

        cache = get_global_task_cache()
        sink = get_global_workshop_sink()
        if cache is None or sink is None:
            logger.warning(
                "[TelegramWorkshop] guest dispatch but cache/sink unavailable chat_id=%s msg_id=%s",
                chat_id,
                summoning_message_id,
            )
            return

        resolved = cache.resolve(chat_id=chat_id, message_id=summoning_message_id)
        if resolved is None:
            logger.warning(
                "[TelegramWorkshop] guest dispatch with no task_id mapping chat_id=%s msg_id=%s",
                chat_id,
                summoning_message_id,
            )
            return
        task_id, user_id = resolved

        logger.info(
            "[TelegramWorkshop] guest dispatch resolved chat_id=%s msg_id=%s task_id=%s user_id=%s",
            chat_id,
            summoning_message_id,
            task_id,
            user_id,
        )

        await self._stream_task_lifecycle(
            bot=bot,
            chat_id=chat_id,
            task_id=task_id,
            sink=sink,
        )

    async def _stream_task_lifecycle(
        self,
        *,
        bot: Any,
        chat_id: int,
        task_id: str,
        sink: Any,
    ) -> None:
        renderer = WorkshopMessageRenderer()
        streaming = StreamingTextClient(bot=bot, chat_id=chat_id)
        try:
            await streaming.open(initial_body="🛠 Starting work…")
        except Exception:
            logger.warning("[TelegramWorkshop] failed to open streaming reply chat_id=%s", chat_id, exc_info=True)
            return

        completed = asyncio.Event()
        terminal_box: list[CompletedEvent | None] = [None]

        receiver = _WorkshopEventReceiver(
            streaming_client=streaming,
            renderer=renderer,
            tg_loop=self._tg_loop,
            completed=completed,
            terminal_event_box=terminal_box,
        )
        sink.register_workshop(task_id, receiver)
        try:
            try:
                await asyncio.wait_for(completed.wait(), timeout=self._task_timeout_seconds)
            except TimeoutError:
                logger.warning(
                    "[TelegramWorkshop] task_id=%s timed out after %ds",
                    task_id,
                    self._task_timeout_seconds,
                )
                # Synthesize a terminal render so the user sees a final state.
                from app.gateway.builder_events.types import CompletedEvent as _CE

                terminal_box[0] = _CE(
                    task_id=task_id,
                    thread_id="",
                    user_id=None,
                    channel_origin="telegram",
                    timestamp_ms=int(time.time() * 1000),
                    sequence=10**9,
                    status="timed_out",
                )
                renderer.apply(terminal_box[0])

            final_body = renderer.render()
            try:
                await streaming.finalize(final_body)
            except Exception:
                logger.warning("[TelegramWorkshop] finalize failed task_id=%s", task_id, exc_info=True)

            terminal_event = terminal_box[0]
            if terminal_event is not None and terminal_event.status == "completed":
                await self._deliver_artifact(bot=bot, chat_id=chat_id, event=terminal_event)
        finally:
            sink.unregister_workshop(task_id)

    async def _deliver_artifact(
        self,
        *,
        bot: Any,
        chat_id: int,
        event: CompletedEvent,
    ) -> None:
        filename = event.artifact_filename
        thread_id = event.thread_id
        if not filename or not thread_id:
            return
        try:
            from app.channels._sophia_artifact_bridge import download_artifact

            result = await asyncio.to_thread(download_artifact, thread_id, filename)
        except Exception:
            logger.warning(
                "[TelegramWorkshop] artifact download failed thread_id=%s filename=%s",
                thread_id,
                filename,
                exc_info=True,
            )
            return
        if not result:
            logger.info("[TelegramWorkshop] artifact not found thread_id=%s filename=%s", thread_id, filename)
            return
        data, _mime = result
        caption = (event.companion_summary or "").strip()
        if len(caption) > _TELEGRAM_CAPTION_LIMIT:
            caption = caption[: _TELEGRAM_CAPTION_LIMIT - 1] + "…"
        try:
            from telegram import InputFile

            buf = BytesIO(data)
            buf.name = filename
            await bot.send_document(
                chat_id=chat_id,
                document=InputFile(buf, filename=filename),
                caption=caption or None,
            )
            logger.info(
                "[TelegramWorkshop] artifact delivered chat_id=%s filename=%s bytes=%d",
                chat_id,
                filename,
                len(data),
            )
        except Exception:
            logger.warning(
                "[TelegramWorkshop] send_document failed chat_id=%s filename=%s",
                chat_id,
                filename,
                exc_info=True,
            )

    # -- handler stubs (cold DM + loop prevention) -------------------------

    async def handle_cold_dm(
        self,
        *,
        telegram_user_id: int,
        bot_send: Any,
        chat_id: int,
    ) -> bool:
        now = asyncio.get_event_loop().time()
        muted_until = self._muted_users.get(int(telegram_user_id), 0.0)
        if muted_until > now:
            logger.info(
                "[TelegramWorkshop] cold DM ignored (user muted) telegram_user_id=%s remaining=%.0fs",
                telegram_user_id,
                muted_until - now,
            )
            return False
        try:
            await bot_send(
                chat_id=chat_id,
                text=(
                    "Hi — I'm Sophia's workshop. I do focused work, but the relationship is with her.\n"
                    "Start here: @Sophia_EI_bot"
                ),
            )
        except Exception:
            logger.warning(
                "[TelegramWorkshop] cold DM send failed telegram_user_id=%s",
                telegram_user_id,
                exc_info=True,
            )
            return False
        self._muted_users[int(telegram_user_id)] = now + self._cold_dm_mute_minutes * 60
        logger.info(
            "[TelegramWorkshop] cold DM redirect sent telegram_user_id=%s mute_minutes=%d",
            telegram_user_id,
            self._cold_dm_mute_minutes,
        )
        return True

    def check_loop_prevention(
        self,
        *,
        chat_id: int,
        root_message_id: int,
        source_bot_id: int,
        text: str,
    ) -> bool:
        decision = self._loop_prevention.check(
            chat_id=chat_id,
            root_message_id=root_message_id,
            source_bot_id=source_bot_id,
            text=text,
        )
        if not decision.allow:
            logger.warning(
                "[TelegramWorkshop] loop_prevention.blocked rule=%s chat_id=%s value=%s limit=%s strict=%s",
                decision.blocked_rule,
                chat_id,
                decision.blocked_value,
                decision.blocked_limit,
                self._strict_loop_prevention,
            )
            return not self._strict_loop_prevention
        return True

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _legacy_work_channel_enabled() -> bool:
        try:
            from deerflow.config.app_config import get_app_config

            cfg = get_app_config()
            extra = cfg.model_extra or {}
            channels_cfg = extra.get("channels") or {}
            work_cfg = channels_cfg.get("telegram_work") if isinstance(channels_cfg, dict) else None
            if isinstance(work_cfg, dict):
                return bool(work_cfg.get("enabled", False))
        except Exception:
            logger.debug("[TelegramWorkshop] legacy work-channel flag lookup failed", exc_info=True)
        return False


__all__ = ["WorkshopTelegramChannel"]
