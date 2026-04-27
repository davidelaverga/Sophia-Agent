"""Telegram channel — connects via long-polling (no public IP needed)."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import re
import threading
from typing import Any

from app.channels.base import Channel
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment

logger = logging.getLogger(__name__)

# Telegram /start payloads are ASCII tokens bounded by the client (~64 chars).
# Deep-link tokens issued by the gateway are 43-char urlsafe-b64; accept
# anything that looks like a plausible token so future rotations still work.
_LINK_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{16,96}$")


def _looks_like_link_token(value: str) -> bool:
    return bool(_LINK_TOKEN_RE.match(value or ""))


class TelegramChannel(Channel):
    """Telegram bot channel using long-polling.

    Configuration keys (in ``config.yaml`` under ``channels.telegram``):
        - ``bot_token``: Telegram Bot API token (from @BotFather).
        - ``bot_username``: (optional) Bot username (without '@'). Used for
          deep-link URLs. Falls back to the ``TELEGRAM_BOT_USERNAME`` env var
          read by ``app.gateway.telegram_link_store``.
        - ``allowed_users``: (optional) List of allowed Telegram user IDs. Empty = allow all.
    """

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name="telegram", bus=bus, config=config)
        self._application = None
        self._thread: threading.Thread | None = None
        self._tg_loop: asyncio.AbstractEventLoop | None = None
        self._main_loop: asyncio.AbstractEventLoop | None = None
        self._allowed_users: set[int] = set()
        for uid in config.get("allowed_users", []):
            try:
                self._allowed_users.add(int(uid))
            except (ValueError, TypeError):
                pass
        # chat_id -> last sent message_id for threaded replies
        self._last_bot_message: dict[str, int] = {}
        # Fire-and-forget tasks scheduled inside the bot's loop (`_tg_loop`)
        # for "Working on it..." replies. Keep strong references so the GC
        # cannot drop a running task; entries are removed on completion via
        # `task.add_done_callback(self._background_tasks.discard)`.
        self._background_tasks: set[asyncio.Task] = set()

    async def start(self) -> None:
        if self._running:
            return

        try:
            from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters
        except ImportError:
            logger.error("python-telegram-bot is not installed. Install it with: uv add python-telegram-bot")
            return

        bot_token = self.config.get("bot_token", "")
        if not bot_token:
            logger.error("Telegram channel requires bot_token")
            return

        self._main_loop = asyncio.get_event_loop()
        self._running = True
        self.bus.subscribe_outbound(self._on_outbound)
        # Builder completion cards (sync `switch_to_builder` and async
        # deepagents path) ride a parallel pub/sub channel — see PR plan.
        self.bus.subscribe_builder_completion(self._on_builder_completion)

        # Build the application
        app = ApplicationBuilder().token(bot_token).build()

        # Command handlers
        app.add_handler(CommandHandler("start", self._cmd_start))
        app.add_handler(CommandHandler("new", self._cmd_generic))
        app.add_handler(CommandHandler("status", self._cmd_generic))
        app.add_handler(CommandHandler("models", self._cmd_generic))
        app.add_handler(CommandHandler("memory", self._cmd_generic))
        app.add_handler(CommandHandler("help", self._cmd_generic))

        # Builder retry / dismiss buttons on the completion card.
        from telegram.ext import CallbackQueryHandler

        app.add_handler(CallbackQueryHandler(self._on_callback_query))

        # Media handler — registered BEFORE the text handler so photo /
        # document messages with optional captions are routed here instead of
        # falling through to the text-only path. Without this handler, images
        # and PDFs sent to the bot are silently dropped before they ever
        # reach the manager (the user-visible regression: "Sophia, do you
        # see the images I sent you?" → no, because they never arrived).
        # The reader is registered with the manager via service.py so the
        # manager can download bytes on demand and inline them as Anthropic
        # content blocks.
        app.add_handler(
            MessageHandler(
                (filters.PHOTO | filters.Document.ALL) & ~filters.COMMAND,
                self._on_media,
            )
        )

        # General message handler
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._on_text))

        self._application = app

        # Run polling in a dedicated thread with its own event loop
        self._thread = threading.Thread(target=self._run_polling, daemon=True)
        self._thread.start()
        logger.info("Telegram channel started")

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)
        self.bus.unsubscribe_builder_completion(self._on_builder_completion)
        if self._tg_loop and self._tg_loop.is_running():
            self._tg_loop.call_soon_threadsafe(self._tg_loop.stop)
        if self._thread:
            self._thread.join(timeout=10)
            self._thread = None
        self._application = None
        logger.info("Telegram channel stopped")

    async def send(self, msg: OutboundMessage, *, _max_retries: int = 3) -> None:
        if not self._application:
            return

        try:
            chat_id = int(msg.chat_id)
        except (ValueError, TypeError):
            logger.error("Invalid Telegram chat_id: %s", msg.chat_id)
            return

        kwargs: dict[str, Any] = {"chat_id": chat_id, "text": msg.text}

        # Reply to the last bot message in this chat for threading
        reply_to = self._last_bot_message.get(msg.chat_id)
        if reply_to:
            kwargs["reply_to_message_id"] = reply_to

        bot = self._application.bot
        last_exc: Exception | None = None
        for attempt in range(_max_retries):
            try:
                sent = await bot.send_message(**kwargs)
                self._last_bot_message[msg.chat_id] = sent.message_id
                return
            except Exception as exc:
                last_exc = exc
                if attempt < _max_retries - 1:
                    delay = 2**attempt  # 1s, 2s
                    logger.warning(
                        "[Telegram] send failed (attempt %d/%d), retrying in %ds: %s",
                        attempt + 1,
                        _max_retries,
                        delay,
                        exc,
                    )
                    await asyncio.sleep(delay)

        logger.error("[Telegram] send failed after %d attempts: %s", _max_retries, last_exc)
        raise last_exc  # type: ignore[misc]

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        if not self._application:
            return False

        try:
            chat_id = int(msg.chat_id)
        except (ValueError, TypeError):
            logger.error("[Telegram] Invalid chat_id: %s", msg.chat_id)
            return False

        # Telegram limits: 10MB for photos, 50MB for documents
        if attachment.size > 50 * 1024 * 1024:
            logger.warning("[Telegram] file too large (%d bytes), skipping: %s", attachment.size, attachment.filename)
            return False

        bot = self._application.bot
        reply_to = self._last_bot_message.get(msg.chat_id)

        try:
            if attachment.is_image and attachment.size <= 10 * 1024 * 1024:
                with open(attachment.actual_path, "rb") as f:
                    kwargs: dict[str, Any] = {"chat_id": chat_id, "photo": f}
                    if reply_to:
                        kwargs["reply_to_message_id"] = reply_to
                    sent = await bot.send_photo(**kwargs)
            else:
                from telegram import InputFile

                with open(attachment.actual_path, "rb") as f:
                    input_file = InputFile(f, filename=attachment.filename)
                    kwargs = {"chat_id": chat_id, "document": input_file}
                    if reply_to:
                        kwargs["reply_to_message_id"] = reply_to
                    sent = await bot.send_document(**kwargs)

            self._last_bot_message[msg.chat_id] = sent.message_id
            logger.info("[Telegram] file sent: %s to chat=%s", attachment.filename, msg.chat_id)
            return True
        except Exception:
            logger.exception("[Telegram] failed to send file: %s", attachment.filename)
            return False

    # -- helpers -----------------------------------------------------------

    async def _send_running_reply(self, chat_id: str, reply_to_message_id: int) -> None:
        """Send a 'Working on it...' reply to the user's message."""
        if not self._application:
            return
        try:
            bot = self._application.bot
            await bot.send_message(
                chat_id=int(chat_id),
                text="Working on it...",
                reply_to_message_id=reply_to_message_id,
            )
            logger.info("[Telegram] 'Working on it...' reply sent in chat=%s", chat_id)
        except Exception:
            logger.exception("[Telegram] failed to send running reply in chat=%s", chat_id)

    # -- internal ----------------------------------------------------------

    def _run_polling(self) -> None:
        """Run telegram polling in a dedicated thread."""
        self._tg_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._tg_loop)
        try:
            # Cannot use run_polling() because it calls add_signal_handler(),
            # which only works in the main thread.  Instead, manually
            # initialize the application and start the updater.
            self._tg_loop.run_until_complete(self._application.initialize())
            self._tg_loop.run_until_complete(self._application.start())
            self._tg_loop.run_until_complete(self._application.updater.start_polling())
            self._tg_loop.run_forever()
        except Exception:
            if self._running:
                logger.exception("Telegram polling error")
        finally:
            # Graceful shutdown
            try:
                if self._application.updater.running:
                    self._tg_loop.run_until_complete(self._application.updater.stop())
                self._tg_loop.run_until_complete(self._application.stop())
                self._tg_loop.run_until_complete(self._application.shutdown())
            except Exception:
                logger.exception("Error during Telegram shutdown")

    def _check_user(self, user_id: int) -> bool:
        if not self._allowed_users:
            return True
        return user_id in self._allowed_users

    async def _cmd_start(self, update, context) -> None:
        """Handle /start command.

        When the user arrived via a ``t.me/<bot>?start=<token>`` deep-link,
        Telegram passes the token as the first positional arg. Redeem the
        token against the gateway's in-process registry and bind the chat
        to the canonical user_id so subsequent messages route under the
        same identity as the webapp session.

        Deep-link redemption is restricted to **private** chats — in groups
        or supergroups ``effective_chat.id`` is shared by every member, so
        a single redemption there would collapse multiple users onto one
        canonical id. Redemption in a non-private chat is rejected without
        consuming the token so the user can re-open the link in a DM.
        """
        if not self._check_user(update.effective_user.id):
            return
        args = list(getattr(context, "args", None) or [])
        if args and _looks_like_link_token(args[0]):
            chat_type = getattr(update.effective_chat, "type", None)
            if chat_type != "private":
                logger.warning(
                    "telegram._cmd_start.non_private_redemption_blocked chat_type=%s chat_id=%s tg_user_id=%s",
                    chat_type,
                    update.effective_chat.id,
                    update.effective_user.id,
                )
                await update.message.reply_text(
                    "Please open the deep link in a 1:1 chat with me, not in a group. "
                    "Tap the original link again and accept the DM prompt."
                )
                return
            ok = self._redeem_start_token(
                token=args[0],
                chat_id=str(update.effective_chat.id),
                tg_user_id=str(update.effective_user.id),
                tg_username=getattr(update.effective_user, "username", None),
            )
            if ok:
                await update.message.reply_text(
                    "You're connected. Sophia will now remember you across Telegram and the webapp."
                )
                return
            await update.message.reply_text(
                "That link has expired. Generate a new one from the webapp and try again."
            )
            return
        await update.message.reply_text(
            "Hi, I'm Sophia. Send me a message any time.\nType /help for available commands."
        )

    def _redeem_start_token(
        self,
        *,
        token: str,
        chat_id: str,
        tg_user_id: str,
        tg_username: str | None,
    ) -> bool:
        """Redeem a deep-link token and persist the chat binding.

        The Telegram channel runs in the same process as the gateway so we
        call the store directly. Returns True if the token was valid and
        the binding was persisted.
        """
        try:
            from app.gateway.telegram_link_store import bind_chat, pop_link_token
        except ImportError:  # pragma: no cover — gateway not mounted in this process
            logger.warning("telegram._cmd_start: telegram_link_store unavailable")
            return False
        record = pop_link_token(token)
        if record is None:
            logger.info("telegram._cmd_start.redeem_failed chat_id=%s token_prefix=%s", chat_id, token[:6])
            return False
        try:
            bind_chat(
                "telegram",
                chat_id,
                record.user_id,
                telegram_user_id=tg_user_id,
                telegram_username=tg_username,
            )
        except Exception:  # noqa: BLE001 — never crash the bot handler
            logger.exception("telegram._cmd_start.bind_failed chat_id=%s", chat_id)
            return False
        return True

    async def _cmd_generic(self, update, context) -> None:
        """Forward slash commands to the channel manager."""
        if not self._check_user(update.effective_user.id):
            return

        text = update.message.text
        chat_id = str(update.effective_chat.id)
        user_id = str(update.effective_user.id)
        msg_id = str(update.message.message_id)

        # Use the same topic_id logic as _on_text so that commands
        # like /new target the correct thread mapping.
        if update.effective_chat.type == "private":
            topic_id = None
        else:
            reply_to = update.message.reply_to_message
            if reply_to:
                topic_id = str(reply_to.message_id)
            else:
                topic_id = msg_id

        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=InboundMessageType.COMMAND,
            thread_ts=msg_id,
        )
        inbound.topic_id = topic_id

        # `_send_running_reply` calls `bot.send_message`, whose httpx client and
        # internal asyncio primitives are bound to `_tg_loop` (where the bot
        # was initialised). This handler is itself running on `_tg_loop`
        # (Telegram's polling loop), so `asyncio.create_task` schedules the
        # reply on the correct loop. We deliberately fire-and-forget so a
        # slow/failing Telegram API call does NOT delay forwarding the user's
        # message to the manager (the codex bot review caught a regression
        # where `await self._send_running_reply(...)` made manager dispatch
        # depend on the best-effort acknowledgement). Errors inside
        # `_send_running_reply` are already logged via its own try/except.
        # Scheduling onto `_main_loop` instead raised
        #   RuntimeError: <asyncio.locks.Event …> is bound to a different event loop
        # in production. `bus.publish_inbound` does need the cross-loop hop
        # because the bus's queue lives on `_main_loop`.
        reply_task = asyncio.create_task(
            self._send_running_reply(chat_id, update.message.message_id)
        )
        self._background_tasks.add(reply_task)
        reply_task.add_done_callback(self._background_tasks.discard)
        if self._main_loop and self._main_loop.is_running():
            asyncio.run_coroutine_threadsafe(self.bus.publish_inbound(inbound), self._main_loop)

    async def _on_text(self, update, context) -> None:
        """Handle regular text messages."""
        if not self._check_user(update.effective_user.id):
            return

        text = update.message.text.strip()
        if not text:
            return

        chat_id = str(update.effective_chat.id)
        user_id = str(update.effective_user.id)
        msg_id = str(update.message.message_id)

        # topic_id determines which DeerFlow thread the message maps to.
        # In private chats, use None so that all messages share a single
        # thread (the store key becomes "channel:chat_id").
        # In group chats, use the reply-to message id or the current
        # message id to keep separate conversation threads.
        if update.effective_chat.type == "private":
            topic_id = None
        else:
            reply_to = update.message.reply_to_message
            if reply_to:
                topic_id = str(reply_to.message_id)
            else:
                topic_id = msg_id

        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=InboundMessageType.CHAT,
            thread_ts=msg_id,
        )
        inbound.topic_id = topic_id

        # See `_cmd_generic` above for the loop / fire-and-forget rationale.
        reply_task = asyncio.create_task(
            self._send_running_reply(chat_id, update.message.message_id)
        )
        self._background_tasks.add(reply_task)
        reply_task.add_done_callback(self._background_tasks.discard)
        if self._main_loop and self._main_loop.is_running():
            asyncio.run_coroutine_threadsafe(self.bus.publish_inbound(inbound), self._main_loop)

    async def _on_media(self, update, context) -> None:
        """Handle photo and document messages.

        The companion (Sophia) receives the attachment as inline content
        blocks in the human message — the manager downloads bytes via
        ``get_inbound_file_reader()`` and constructs Anthropic image /
        document blocks from them. The user's optional caption is used as
        the message text; if absent we ship a neutral default so the LLM
        understands it should interpret the file.

        Only the ``file_id`` and metadata are placed on the InboundMessage
        here — actual byte download is deferred to the manager's
        registered reader to avoid blocking the polling thread on a long
        Telegram CDN fetch (the bus dispatch loop is the right place to
        await the download, behind the per-conversation lock).
        """
        if not self._check_user(update.effective_user.id):
            return

        message = update.message
        files: list[dict[str, Any]] = []

        if message.photo:
            # Telegram sends multiple photo sizes — the last entry is the
            # largest (highest resolution). That's what we ship to the LLM.
            photo = message.photo[-1]
            files.append(
                {
                    "file_id": photo.file_id,
                    "filename": f"telegram_photo_{photo.file_unique_id}.jpg",
                    "mime_type": "image/jpeg",
                }
            )
        if message.document:
            document = message.document
            files.append(
                {
                    "file_id": document.file_id,
                    "filename": document.file_name or f"telegram_document_{document.file_unique_id}",
                    "mime_type": document.mime_type or "application/octet-stream",
                }
            )

        if not files:
            return

        text = (message.caption or "").strip() or "Please look at the attached file."
        chat_id = str(update.effective_chat.id)
        user_id = str(update.effective_user.id)
        msg_id = str(message.message_id)

        # Same topic_id rule as _on_text: private chats share a single
        # thread; group chats key on reply-to or message_id.
        if update.effective_chat.type == "private":
            topic_id = None
        else:
            reply_to = message.reply_to_message
            topic_id = str(reply_to.message_id) if reply_to else msg_id

        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=InboundMessageType.CHAT,
            thread_ts=msg_id,
        )
        inbound.topic_id = topic_id
        inbound.files = files

        # Same fire-and-forget pattern as _on_text — see `_cmd_generic` for
        # the loop rationale (handler is on `_tg_loop`, bus is on `_main_loop`).
        reply_task = asyncio.create_task(
            self._send_running_reply(chat_id, message.message_id)
        )
        self._background_tasks.add(reply_task)
        reply_task.add_done_callback(self._background_tasks.discard)
        if self._main_loop and self._main_loop.is_running():
            asyncio.run_coroutine_threadsafe(self.bus.publish_inbound(inbound), self._main_loop)

    def get_inbound_file_reader(self):
        """Return the async callable the manager invokes to download the
        bytes referenced by ``InboundMessage.files``.

        Registered with ``ChannelManager.register_inbound_file_reader``
        when the channel starts (see ``ChannelService._start_channel``).
        Kept as a method on the channel so it can capture
        ``self._application`` and only fire when the bot is alive.
        """
        return self._read_inbound_files

    async def _run_bot_call_on_telegram_loop(self, coro):
        """Run a bot API coroutine on ``_tg_loop`` when called cross-loop.

        Telegram bot internals are loop-affine to the polling loop where the
        application was initialized (``_tg_loop``). The manager invokes the
        inbound file reader on its own loop, so attachment bot I/O must hop
        back to ``_tg_loop`` to avoid "bound to a different event loop"
        runtime errors.
        """
        tg_loop = self._tg_loop
        if not tg_loop or not tg_loop.is_running():
            return await coro
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is tg_loop:
            return await coro

        future = asyncio.run_coroutine_threadsafe(coro, tg_loop)
        try:
            return await asyncio.wrap_future(future)
        except asyncio.CancelledError:
            future.cancel()
            raise
        except Exception:
            if isinstance(future, concurrent.futures.Future):
                future.cancel()
            raise

    async def _read_inbound_files(self, inbound) -> list[dict[str, Any]]:
        """Download bytes for each ``inbound.files`` entry via the Bot API.

        Returns a list of ``{filename, mime_type, content}`` dicts —
        opaque to the manager; the manager's block builder turns these
        into Anthropic content blocks.
        """
        if not self._application:
            return []
        if not inbound.files:
            return []

        downloaded: list[dict[str, Any]] = []
        bot = self._application.bot
        for index, file_meta in enumerate(inbound.files, start=1):
            if not isinstance(file_meta, dict):
                continue
            file_id = file_meta.get("file_id")
            if not isinstance(file_id, str) or not file_id:
                continue
            filename = file_meta.get("filename")
            if not isinstance(filename, str) or not filename.strip():
                filename = f"telegram_upload_{index}"
            mime_type = file_meta.get("mime_type")
            if not isinstance(mime_type, str) or not mime_type:
                mime_type = "application/octet-stream"

            try:
                telegram_file = await self._run_bot_call_on_telegram_loop(bot.get_file(file_id))
                content = await self._run_bot_call_on_telegram_loop(telegram_file.download_as_bytearray())
            except Exception:
                logger.exception(
                    "[Telegram] failed to download inbound file_id=%s filename=%s",
                    file_id,
                    filename,
                )
                continue

            downloaded.append(
                {
                    "filename": filename,
                    "mime_type": mime_type,
                    "content": bytes(content),
                }
            )

        return downloaded

    # -- builder completion fan-out --------------------------------------

    _RETRY_PROMPT = "yes, please try that again"

    def _find_chat_topic_for_thread(
        self, thread_id: str
    ) -> tuple[str, str | None] | None:
        """Reverse-lookup the originating Telegram chat *and* topic_id.

        The completion notifier delivers events keyed by parent thread_id;
        we map back to the originating IM conversation via the channel
        store. Returns ``(chat_id, topic_id)`` on hit, or ``None`` when
        the thread isn't bound to a Telegram chat (cross-channel events
        for non-Telegram threads are silently dropped).

        ``topic_id`` is the SAME value the store keys on for group/forum
        chats. It must be propagated through the retry inbound message,
        otherwise ``ChannelManager._handle_chat`` would call
        ``store.get_thread_id(chat_id, topic_id=None)`` and miss the
        original mapping — starting a fresh DeerFlow thread instead of
        continuing the conversation that owned the failed builder task.
        """
        try:
            store = getattr(self.bus, "_store", None)
            if store is None:
                # The store isn't on the bus; reach for the manager's store
                # via service.
                from app.channels.service import get_channel_service

                service = get_channel_service()
                store = service.store if service else None
            if store is None:
                return None
            entry = store.find_by_thread_id(thread_id, channel_name="telegram")
            if not entry:
                return None
            chat_id = entry.get("chat_id")
            if not isinstance(chat_id, str) or not chat_id:
                return None
            topic_id = entry.get("topic_id")
            if topic_id is not None and not isinstance(topic_id, str):
                topic_id = str(topic_id)
            return chat_id, topic_id
        except Exception:
            logger.exception(
                "[Telegram] reverse lookup failed for thread_id=%s", thread_id
            )
            return None

    # Backwards-compat shim: the unit-test fixture and older callers still
    # patch / expect the chat-id-only helper. Keep delegating so a single
    # source of truth (``_find_chat_topic_for_thread``) drives both paths.
    def _find_chat_id_for_thread(self, thread_id: str) -> str | None:
        match = self._find_chat_topic_for_thread(thread_id)
        return match[0] if match else None

    @staticmethod
    def _build_completion_caption(payload: dict[str, Any]) -> str:
        status = payload.get("status")
        title = payload.get("artifact_title") or payload.get("artifact_filename") or "your build"
        summary = payload.get("summary")
        task_brief = payload.get("task_brief")

        if status == "success":
            text = f"✅ {title} is ready"
            if summary:
                text += f"\n\n{summary}"
            return text

        # Failure family: include the original brief so the user
        # immediately knows which task is being asked about for retry.
        body = (
            "Sorry it seems like the task didn’t complete. "
            "Do you want me to try again?"
        )
        if status == "timeout":
            body = (
                "The build took longer than expected and was cut short. "
                "Want me to try again?"
            )
        elif status == "cancelled":
            body = "Build was cancelled."

        if task_brief:
            body += f"\n\nTask: {task_brief}"
        return body

    @staticmethod
    def _encode_callback_data(action: str, task_id: str, topic_id: str | None) -> str:
        """Pack ``(task_id, topic_id)`` into a single callback_data string.

        Telegram's per-button ``callback_data`` is capped at 64 bytes. Our
        scheme is ``builder_<action>_<task_id>__<topic_id>`` (or just
        ``builder_<action>_<task_id>`` when there's no topic, e.g. private
        chats). ``__`` is the separator since neither task_id (uuid hex)
        nor topic_id (Telegram message_id digits) ever contain it.
        """
        base = f"builder_{action}_{task_id}"
        if topic_id is None or topic_id == "":
            return base
        return f"{base}__{topic_id}"

    @staticmethod
    def _parse_callback_data(data: str) -> tuple[str | None, str | None, str | None]:
        """Inverse of :meth:`_encode_callback_data`.

        Returns ``(action, task_id, topic_id)``. ``action`` is None when
        the prefix doesn't match the builder card scheme.
        """
        if not data.startswith("builder_"):
            return None, None, None
        # Expect "builder_<action>_<rest>" — split on first two underscores.
        try:
            _, action, rest = data.split("_", 2)
        except ValueError:
            return None, None, None
        if "__" in rest:
            task_id, _, topic_id = rest.partition("__")
            return action, task_id or None, topic_id or None
        return action, rest or None, None

    def _build_retry_keyboard(self, task_id: str, *, topic_id: str | None = None):
        """Build inline keyboard with retry/dismiss buttons.

        ``callback_data`` carries both ``task_id`` and (when present)
        ``topic_id`` so the retry handler can route the synthesized user
        message to the original DeerFlow thread — see
        :meth:`_find_chat_topic_for_thread` for why.
        """
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup

        return InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton(
                        "Try again",
                        callback_data=self._encode_callback_data("retry", task_id, topic_id),
                    ),
                    InlineKeyboardButton(
                        "Dismiss",
                        callback_data=self._encode_callback_data("dismiss", task_id, topic_id),
                    ),
                ]
            ]
        )

    async def _on_builder_completion(self, payload: dict[str, Any]) -> None:
        """Render a builder completion card in the originating Telegram chat.

        Best-effort: any failure logs and returns. The webapp SSE path
        delivers the same event independently, so a Telegram outage doesn't
        leave the user without notification.
        """
        if not self._application or not self._tg_loop:
            return

        thread_id = payload.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            return
        match = self._find_chat_topic_for_thread(thread_id)
        if match is None:
            # Not a Telegram-originated thread; the webapp path handles it.
            return
        chat_id, topic_id = match

        caption = self._build_completion_caption(payload)
        status = payload.get("status")
        artifact_url = payload.get("artifact_url")
        task_id = payload.get("task_id") or "unknown"

        bot = self._application.bot

        async def _send():
            try:
                if status == "success" and isinstance(artifact_url, str) and artifact_url:
                    # Send the file as a document with caption. Telegram
                    # downloads the URL server-side, so a 7-day signed URL
                    # is plenty.
                    sent = await bot.send_document(
                        chat_id=int(chat_id),
                        document=artifact_url,
                        caption=caption,
                    )
                elif status in {"error", "timeout"}:
                    sent = await bot.send_message(
                        chat_id=int(chat_id),
                        text=caption,
                        reply_markup=self._build_retry_keyboard(task_id, topic_id=topic_id),
                    )
                else:
                    sent = await bot.send_message(chat_id=int(chat_id), text=caption)

                self._last_bot_message[chat_id] = sent.message_id
                logger.info(
                    "[Telegram] builder completion delivered chat=%s task_id=%s status=%s",
                    chat_id,
                    task_id,
                    status,
                )
            except Exception:
                logger.exception(
                    "[Telegram] failed to deliver builder completion chat=%s task_id=%s",
                    chat_id,
                    task_id,
                )

        # Telegram bot calls are loop-affine to ``_tg_loop``; the bus fires
        # this on the gateway's main loop, so hop over.
        try:
            await self._run_bot_call_on_telegram_loop(_send())
        except Exception:
            logger.exception(
                "[Telegram] builder completion dispatch error chat=%s task_id=%s",
                chat_id,
                task_id,
            )

    async def _on_callback_query(self, update, context) -> None:
        """Handle inline button presses from completion cards.

        ``builder_retry_*`` translates the click into an inbound user
        message ``"yes, please try that again"`` — the companion's
        ``BuilderSessionMiddleware`` already injects the original task
        brief into the prompt (see PR memory fix), so Sophia can naturally
        re-issue ``switch_to_builder`` with the same task.

        ``builder_dismiss_*`` edits the card to remove the buttons; no
        further action.
        """
        query = update.callback_query
        if query is None:
            return

        try:
            await query.answer()
        except Exception:
            logger.debug("[Telegram] callback_query answer failed", exc_info=True)

        data = (query.data or "").strip()
        action, task_id, topic_id = self._parse_callback_data(data)
        if action is None or action not in {"retry", "dismiss"}:
            return

        chat_id = query.message.chat_id if query.message else None
        if chat_id is None:
            return

        user_id = str(query.from_user.id) if query.from_user else ""

        if action == "dismiss":
            try:
                await query.edit_message_reply_markup(reply_markup=None)
            except Exception:
                logger.debug("[Telegram] dismiss edit_reply_markup failed", exc_info=True)
            return

        # action == "retry"
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:
            logger.debug("[Telegram] retry edit_reply_markup failed", exc_info=True)

        # Translate the click into a normal user turn so it flows through
        # the same channel→LangGraph path as a typed reply. The retry
        # InboundMessage MUST carry the original topic_id so
        # ``ChannelManager._handle_chat`` resolves to the same DeerFlow
        # thread the failed builder task was running in — without this,
        # group / forum chats start a fresh thread on retry and lose the
        # builder's prior context (the codex bot review on PR #87 caught
        # this).
        inbound = self._build_inbound_message(
            chat_id=str(chat_id),
            user_id=user_id,
            text=self._RETRY_PROMPT,
            topic_id=topic_id,
        )
        logger.info(
            "[Telegram] retry button clicked: chat=%s task_id=%s topic_id=%s",
            chat_id,
            task_id,
            topic_id,
        )
        if self._main_loop and self._main_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self.bus.publish_inbound(inbound), self._main_loop
            )

    def _build_inbound_message(
        self,
        *,
        chat_id: str,
        user_id: str,
        text: str,
        topic_id: str | None = None,
    ):
        """Construct a CHAT InboundMessage matching ``_on_text``'s shape."""
        inbound = InboundMessage(
            channel_name="telegram",
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=InboundMessageType.CHAT,
        )
        # ``topic_id`` is set as an attribute (not a constructor field) to
        # match ``_on_text`` / ``_on_media``: see the existing pattern at
        # ``inbound.topic_id = topic_id`` in those handlers.
        inbound.topic_id = topic_id
        return inbound
