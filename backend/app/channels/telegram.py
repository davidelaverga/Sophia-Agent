"""Telegram channel — connects via long-polling (no public IP needed)."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from app.channels.base import Channel
from app.channels.message_bus import InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment
from app.channels.telegram_linking import get_telegram_link_store

logger = logging.getLogger(__name__)

_BUILD_COMMAND_PREFIX = (
    "Please route this request through Sophia's builder workflow and complete it end-to-end.\n\n"
)


class TelegramChannel(Channel):
    """Telegram bot channel using long-polling.

    Configuration keys (in ``config.yaml`` under ``channels.telegram``):
        - ``bot_token``: Telegram Bot API token (from @BotFather).
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
        self._link_store = get_telegram_link_store()
        # chat_id -> last sent message_id for threaded replies
        self._last_bot_message: dict[str, int] = {}

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

        # Build the application
        app = ApplicationBuilder().token(bot_token).build()

        # Command handlers
        app.add_handler(CommandHandler("start", self._cmd_start))
        app.add_handler(CommandHandler("new", self._cmd_generic))
        app.add_handler(CommandHandler("status", self._cmd_generic))
        app.add_handler(CommandHandler("models", self._cmd_generic))
        app.add_handler(CommandHandler("memory", self._cmd_generic))
        app.add_handler(CommandHandler("help", self._cmd_generic))
        app.add_handler(CommandHandler("build", self._cmd_build))

        # Media handlers
        app.add_handler(MessageHandler((filters.PHOTO | filters.Document.ALL) & ~filters.COMMAND, self._on_media))

        # General text message handler
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._on_text))

        self._application = app

        # Run polling in a dedicated thread with its own event loop
        self._thread = threading.Thread(target=self._run_polling, daemon=True)
        self._thread.start()
        logger.info("Telegram channel started")

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)
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

    def get_inbound_file_reader(self):
        return self._read_inbound_files

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _resolve_topic_id(update) -> str | None:
        if update.effective_chat.type == "private":
            return None
        reply_to = update.message.reply_to_message
        if reply_to:
            return str(reply_to.message_id)
        return str(update.message.message_id)

    async def _send_link_required_message(self, update) -> None:
        await update.message.reply_text(
            "This chat is not linked to your Sophia account yet.\n"
            "Open Sophia on the web, create a Telegram link, then use /start <token> here."
        )

    async def _resolve_link_for_chat(self, update) -> dict[str, Any] | None:
        chat_id = str(update.effective_chat.id)
        link = self._link_store.get_link_by_chat(chat_id)
        if link:
            self._link_store.touch_chat_activity(chat_id)
        return link

    async def _publish_inbound(self, inbound, *, chat_id: str, reply_to_message_id: int) -> None:
        if self._main_loop and self._main_loop.is_running():
            asyncio.run_coroutine_threadsafe(self._send_running_reply(chat_id, reply_to_message_id), self._main_loop)
            asyncio.run_coroutine_threadsafe(self.bus.publish_inbound(inbound), self._main_loop)

    async def _read_inbound_files(self, inbound) -> list[dict[str, Any]]:
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
                telegram_file = await bot.get_file(file_id)
                content = await telegram_file.download_as_bytearray()
            except Exception:
                logger.exception("[Telegram] failed to download inbound file_id=%s", file_id)
                continue

            downloaded.append(
                {
                    "filename": filename,
                    "mime_type": mime_type,
                    "content": bytes(content),
                }
            )

        return downloaded

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
        """Handle /start command with optional one-time link token."""
        if not self._check_user(update.effective_user.id):
            return

        args = list(getattr(context, "args", []) or [])
        token = args[0].strip() if args else ""
        chat_id = str(update.effective_chat.id)
        telegram_user = update.effective_user

        if token:
            if update.effective_chat.type != "private":
                await update.message.reply_text("Please run /start <token> in a private chat with me.")
                return

            linked = self._link_store.redeem_link_token(
                token=token,
                telegram_chat_id=chat_id,
                telegram_user_id=str(telegram_user.id),
                telegram_username=telegram_user.username,
                telegram_first_name=telegram_user.first_name,
                telegram_last_name=telegram_user.last_name,
            )
            if not linked:
                await update.message.reply_text("That link token is invalid or expired. Generate a new one in Sophia and try again.")
                return

            context_mode = linked.get("context_mode", "life")
            await update.message.reply_text(
                "Telegram linked successfully.\n"
                f"Sophia context mode: {context_mode}.\n"
                "You can now message me directly, send images/files, or use /build <task>."
            )
            return

        existing_link = self._link_store.get_link_by_chat(chat_id)
        if existing_link:
            await update.message.reply_text("You're already linked. Send me a message to continue with Sophia.")
            return

        await update.message.reply_text(
            "Welcome to Sophia on Telegram.\n"
            "To link this chat, generate a Telegram link from Sophia on the web and run /start <token>."
        )

    async def _cmd_generic(self, update, context) -> None:
        """Forward slash commands to the channel manager."""
        if not self._check_user(update.effective_user.id):
            return

        chat_id = str(update.effective_chat.id)
        text = update.message.text
        msg_id = str(update.message.message_id)
        topic_id = self._resolve_topic_id(update)
        link = await self._resolve_link_for_chat(update)

        command_name = (text or "").split(maxsplit=1)[0].lstrip("/").lower()
        if command_name not in {"help", "start"} and link is None:
            await self._send_link_required_message(update)
            return

        user_id = str(link.get("user_id")) if isinstance(link, dict) and isinstance(link.get("user_id"), str) else str(update.effective_user.id)
        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=InboundMessageType.COMMAND,
            thread_ts=msg_id,
        )
        inbound.topic_id = topic_id
        await self._publish_inbound(
            inbound,
            chat_id=chat_id,
            reply_to_message_id=update.message.message_id,
        )

    async def _cmd_build(self, update, context) -> None:
        """Handle explicit /build command by converting it into a chat request."""
        if not self._check_user(update.effective_user.id):
            return

        link = await self._resolve_link_for_chat(update)
        if link is None:
            await self._send_link_required_message(update)
            return

        build_request = " ".join(getattr(context, "args", []) or []).strip()
        if not build_request:
            await update.message.reply_text("Usage: /build <what you want Sophia to build>")
            return

        chat_id = str(update.effective_chat.id)
        msg_id = str(update.message.message_id)
        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=str(link["user_id"]),
            text=f"{_BUILD_COMMAND_PREFIX}{build_request}",
            msg_type=InboundMessageType.CHAT,
            thread_ts=msg_id,
        )
        inbound.topic_id = self._resolve_topic_id(update)
        await self._publish_inbound(
            inbound,
            chat_id=chat_id,
            reply_to_message_id=update.message.message_id,
        )

    async def _on_text(self, update, context) -> None:
        """Handle regular text messages."""
        if not self._check_user(update.effective_user.id):
            return

        text = update.message.text.strip()
        if not text:
            return

        link = await self._resolve_link_for_chat(update)
        if link is None:
            await self._send_link_required_message(update)
            return

        chat_id = str(update.effective_chat.id)
        msg_id = str(update.message.message_id)
        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=str(link["user_id"]),
            text=text,
            msg_type=InboundMessageType.CHAT,
            thread_ts=msg_id,
        )
        inbound.topic_id = self._resolve_topic_id(update)
        await self._publish_inbound(
            inbound,
            chat_id=chat_id,
            reply_to_message_id=update.message.message_id,
        )

    async def _on_media(self, update, context) -> None:
        """Handle images and documents by forwarding as chat with file references."""
        if not self._check_user(update.effective_user.id):
            return

        link = await self._resolve_link_for_chat(update)
        if link is None:
            await self._send_link_required_message(update)
            return

        message = update.message
        files: list[dict[str, Any]] = []
        if message.photo:
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

        text = (message.caption or "").strip() or "Please process the attached file."
        chat_id = str(update.effective_chat.id)
        inbound = self._make_inbound(
            chat_id=chat_id,
            user_id=str(link["user_id"]),
            text=text,
            msg_type=InboundMessageType.CHAT,
            thread_ts=str(message.message_id),
            files=files,
        )
        inbound.topic_id = self._resolve_topic_id(update)
        await self._publish_inbound(
            inbound,
            chat_id=chat_id,
            reply_to_message_id=message.message_id,
        )
