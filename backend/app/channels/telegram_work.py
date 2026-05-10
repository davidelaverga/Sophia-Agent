"""TelegramWorkChannel — Builder-as-Main DM surface for @Sophia_Work_bot.

Stage 1 of the Phase-3 Telegram diagnostic spec. When a user DMs the Work
bot, this channel:

1. Resolves their Sophia user_id via the existing telegram_link_store
   (shared with the EI bot — bindings are per Telegram identity, not per
   bot, so a user already bound through @Sophia_EI_bot is recognised here).
2. Looks up or creates a LangGraph thread keyed by ``telegram_work:chat_id``
   (NO topic_id suffix in private chats — see spec §D5 / upstream issue
   #1101). The ``telegram_work:`` prefix keeps Work bot threads isolated
   from EI bot's ``telegram:`` threads.
3. Posts a placeholder Telegram message ("🔨 Working on your request…") so
   the user gets immediate feedback (Stage 1 is blocking; Stage 2 will
   stream phase events via placeholder edits).
4. Calls ``client.runs.wait(thread_id, "sophia_builder", input=…)`` directly
   — no companion graph, no ``start_builder_task`` wrapper. The Builder
   graph's ``BuilderTaskMiddleware`` synthesises a ``delegation_context``
   when one isn't on input (single Haiku classification call).
5. Edits the placeholder with the final summary; sends the artifact (if
   any) as a follow-up document via the same Supabase ``download_artifact``
   bytes-download path the EI bot uses for completion delivery.

Bypassing the bus + ChannelManager dispatch loop is deliberate: the EI
bot's bus pattern exists so multiple subscribers (companion outbound,
builder completion fan-out, review notifications) can hang off a single
inbound. Work bot DMs have a single response path — directly editing the
placeholder — so going through the bus would add queue latency without
adding behaviour.

Config (under ``channels.telegram_work`` in ``config.yaml``):

- ``enabled``: feature flag. When False, the handler returns a "not
  enabled" placeholder. Default off.
- ``bot_token``: Telegram Bot API token for ``@Sophia_Work_bot``.
- ``bot_username``: e.g. ``Sophia_Work_bot``. Used in user-facing
  prompts and the placeholder message.
- ``pilot_user_id``: Stage-1B gate. When set, only this Sophia user_id
  can use the channel (everyone else gets the "not enabled" message).
  Clear to remove the gate.
- ``allowed_users``: optional Telegram user-id allowlist (additional gate
  on top of ``enabled`` and ``pilot_user_id``).
- ``run_timeout_seconds``: hard ceiling on ``runs.wait`` — defaults to
  900 (15 min) which matches Builder's hard turn-budget ceiling.

Spec: ``docs/specs/sophia_builder_as_main_work_bot_spec.md``.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import threading
from io import BytesIO
from typing import Any

from app.channels.base import Channel
from app.channels.message_bus import MessageBus

# Note: artifact download routes through ``app.channels._sophia_artifact_bridge``
# (Phase-C cleanup) so both Telegram channels share one app→deerflow_sophia_services
# crossing instead of importing it twice. The bridge import is lazy inside
# ``_send_artifact_document`` to match the pattern ``_resolve_sophia_user_id``
# uses for ``telegram_link_store``.

logger = logging.getLogger(__name__)

_TELEGRAM_TEXT_LIMIT = 4096
_TELEGRAM_CAPTION_LIMIT = 1024
_DEFAULT_RUN_TIMEOUT_SECONDS = 900  # 15 minutes — matches Builder hard ceiling
_DEFAULT_BUILDER_ASSISTANT_ID = "sophia_builder"
_CHANNEL_NAME = "telegram_work"
# Identity binding lookups always use channel="telegram" because bindings are
# per Telegram user, not per bot — a user bound via @Sophia_EI_bot's /start
# deep-link should be recognised by @Sophia_Work_bot too.
_BINDING_CHANNEL_KEY = "telegram"


class TelegramWorkChannel(Channel):
    """@Sophia_Work_bot — direct Builder DM surface (Stage 1, blocking)."""

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name=_CHANNEL_NAME, bus=bus, config=config)
        self._application = None
        self._thread: threading.Thread | None = None
        self._tg_loop: asyncio.AbstractEventLoop | None = None
        self._main_loop: asyncio.AbstractEventLoop | None = None

        bot_token = str(config.get("bot_token", "")).strip()
        bot_username = str(config.get("bot_username", "Sophia_Work_bot")).strip().lstrip("@")
        pilot_user_id = str(config.get("pilot_user_id", "")).strip()
        run_timeout = config.get("run_timeout_seconds", _DEFAULT_RUN_TIMEOUT_SECONDS)
        try:
            run_timeout_seconds = int(run_timeout)
        except (TypeError, ValueError):
            run_timeout_seconds = _DEFAULT_RUN_TIMEOUT_SECONDS

        self._bot_token = bot_token
        self._bot_username = bot_username or "Sophia_Work_bot"
        self._enabled = bool(config.get("enabled", False))
        self._pilot_user_id = pilot_user_id or None
        self._run_timeout_seconds = max(60, run_timeout_seconds)

        self._allowed_users: set[int] = set()
        for uid in config.get("allowed_users", []) or []:
            try:
                self._allowed_users.add(int(uid))
            except (ValueError, TypeError):
                pass

        # Background tasks scheduled on `_tg_loop` (placeholder send,
        # build dispatch). Held by strong reference so the GC doesn't drop
        # an in-flight task; entries removed via add_done_callback.
        self._background_tasks: set[asyncio.Task] = set()

        # Resolved at start() time from the channel service (avoids
        # circular import at module load).
        self._store = None
        self._lg_client = None

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        if self._running:
            return

        if not self._enabled:
            logger.info(
                "[TelegramWork] channel is disabled (channels.telegram_work.enabled=false); skipping start"
            )
            # We deliberately mark the channel as "not running" so the
            # service status reflects the disabled state. Returning before
            # setting self._running keeps stop() a no-op.
            return

        if not self._bot_token:
            logger.error(
                "[TelegramWork] bot_token is empty; set channels.telegram_work.bot_token (or $TELEGRAM_WORKER_BOT_TOKEN) and restart"
            )
            return

        try:
            from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters
        except ImportError:
            logger.error(
                "[TelegramWork] python-telegram-bot is not installed. Install it with: uv add python-telegram-bot"
            )
            return

        # Look up the shared store + LangGraph SDK client from the service
        # singleton. Done in start() (not __init__) because the service
        # constructs channels via `cls(bus=..., config=...)` per the
        # registry signature — no extra kwargs are passed.
        from app.channels.service import get_channel_service

        service = get_channel_service()
        if service is None:
            logger.error(
                "[TelegramWork] ChannelService is not started yet; cannot resolve store/langgraph_url"
            )
            return

        self._store = service.store
        self._main_loop = asyncio.get_event_loop()

        from langgraph_sdk import get_client

        # Use the same LangGraph URL the manager uses (already resolved
        # from config via DEFAULT_LANGGRAPH_URL or app config). We pull
        # it off the manager so a misconfiguration there is the single
        # source of truth.
        langgraph_url = getattr(service.manager, "_langgraph_url", None) or "http://localhost:2024"
        self._lg_client = get_client(url=langgraph_url)

        self._running = True

        app = ApplicationBuilder().token(self._bot_token).build()
        app.add_handler(CommandHandler("start", self._cmd_start))
        app.add_handler(CommandHandler("help", self._cmd_help))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._on_text))
        self._application = app

        self._thread = threading.Thread(target=self._run_polling, daemon=True)
        self._thread.start()
        logger.info(
            "[TelegramWork] channel started (bot_username=%s pilot_user_id=%s timeout=%ds)",
            self._bot_username,
            self._pilot_user_id or "<none>",
            self._run_timeout_seconds,
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
        logger.info("[TelegramWork] channel stopped")

    async def send(self, msg) -> None:
        """Bus-driven outbound is a no-op for the Work bot.

        Stage 1 directly edits the placeholder + sends the document from
        ``_on_text`` — no bus subscriptions, no fan-out. The base class
        requires this method (abstract), so we provide a defensive no-op
        that logs if anyone routes traffic here by mistake.
        """
        if msg.channel_name == self.name:
            logger.warning(
                "[TelegramWork] received bus outbound for channel=%s (chat_id=%s) but Work bot does not subscribe to the bus; ignoring",
                msg.channel_name,
                msg.chat_id,
            )

    # -- internal: polling --------------------------------------------------

    def _run_polling(self) -> None:
        self._tg_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._tg_loop)
        try:
            # Cannot use run_polling() because it calls add_signal_handler(),
            # which only works in the main thread (same constraint as the
            # EI TelegramChannel — see telegram.py:_run_polling).
            self._tg_loop.run_until_complete(self._application.initialize())
            self._tg_loop.run_until_complete(self._application.start())
            self._tg_loop.run_until_complete(self._application.updater.start_polling())
            self._tg_loop.run_forever()
        except Exception:
            if self._running:
                logger.exception("[TelegramWork] polling error")
        finally:
            try:
                if self._application and self._application.updater.running:
                    self._tg_loop.run_until_complete(self._application.updater.stop())
                if self._application:
                    self._tg_loop.run_until_complete(self._application.stop())
                    self._tg_loop.run_until_complete(self._application.shutdown())
            except Exception:
                logger.exception("[TelegramWork] error during shutdown")

    # -- handlers ----------------------------------------------------------

    def _check_user(self, telegram_user_id: int) -> bool:
        if not self._allowed_users:
            return True
        return telegram_user_id in self._allowed_users

    async def _cmd_start(self, update, context) -> None:
        if not self._check_user(update.effective_user.id):
            return
        await update.message.reply_text(
            f"Hi, I'm {self._bot_username} — Sophia's Builder. "
            "Send me a build request (research, document, code, presentation, …) "
            "and I'll handle it directly. For emotional / conversational chats, "
            "DM @Sophia_EI_bot instead."
        )

    async def _cmd_help(self, update, context) -> None:
        if not self._check_user(update.effective_user.id):
            return
        await update.message.reply_text(
            "I'm the direct line to Sophia's Builder. Just send me a request "
            "in plain English — \"research the best electric cars for European "
            "families\", \"write a one-page brief on X\", etc. — and I'll "
            "produce a deliverable. No back-and-forth needed; be specific in "
            "the first message."
        )

    async def _on_text(self, update, context) -> None:
        if not self._check_user(update.effective_user.id):
            return

        text = (update.message.text or "").strip()
        if not text:
            return

        chat_id = str(update.effective_chat.id)
        telegram_user_id = str(update.effective_user.id)
        # Username is optional on Telegram (some accounts don't set one)
        # but, when present, gets persisted to the binding row alongside
        # the canonical user_id so we have a human-readable handle for
        # support / audit logs later.
        telegram_username = getattr(update.effective_user, "username", None) or None
        chat_type = getattr(update.effective_chat, "type", None)

        # Stage 1 supports private DMs only. Group chats with this bot
        # are not part of Stage 1 scope; ignore them with a one-time
        # nudge so users aren't confused.
        if chat_type != "private":
            try:
                await update.message.reply_text(
                    f"@{self._bot_username} only handles 1:1 DMs in Stage 1. "
                    "Open a private chat with me to launch a build."
                )
            except Exception:
                logger.debug("[TelegramWork] group nudge failed", exc_info=True)
            return

        # Schedule the build dispatch as a background task on _tg_loop so
        # the polling handler returns immediately (otherwise we block the
        # next inbound message until runs.wait completes).
        task = asyncio.create_task(
            self._dispatch_build(
                chat_id=chat_id,
                telegram_user_id=telegram_user_id,
                telegram_username=telegram_username,
                user_text=text,
                reply_to_message_id=update.message.message_id,
            )
        )
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    # -- dispatch ---------------------------------------------------------

    async def _dispatch_build(
        self,
        *,
        chat_id: str,
        telegram_user_id: str,
        user_text: str,
        reply_to_message_id: int,
        telegram_username: str | None = None,
    ) -> None:
        """Resolve identity → look up/create thread → placeholder → runs.wait → render."""
        bot = self._application.bot if self._application else None
        if bot is None:
            logger.warning("[TelegramWork] dispatch invoked but bot is unset; dropping")
            return

        # 1. Resolve canonical Sophia user_id (3-step: forward fast-path,
        #    then EI-binding reverse lookup with auto-bind on first hit).
        sophia_user_id = await asyncio.to_thread(
            self._resolve_sophia_user_id,
            chat_id=chat_id,
            telegram_user_id=telegram_user_id,
            telegram_username=telegram_username,
        )
        if not sophia_user_id:
            await self._safe_reply(
                bot,
                chat_id,
                reply_to_message_id,
                (
                    "I can't find your Sophia account yet. Please DM "
                    "@Sophia_EI_bot first and follow the /start link from "
                    "the webapp to bind your Telegram — then come back here."
                ),
            )
            logger.info(
                "[TelegramWork] unbound user — chat_id=%s telegram_user_id=%s",
                chat_id,
                telegram_user_id,
            )
            return

        # 2. Pilot-user gate (Stage 1B). When set, only the configured
        # Sophia user_id may proceed.
        if self._pilot_user_id and sophia_user_id != self._pilot_user_id:
            await self._safe_reply(
                bot,
                chat_id,
                reply_to_message_id,
                (
                    f"@{self._bot_username} is in limited preview right now. "
                    "DM @Sophia_EI_bot for now — the Work bot DM surface "
                    "will roll out to everyone soon."
                ),
            )
            logger.info(
                "[TelegramWork] pilot gate rejected user_id=%s (pilot=%s) chat_id=%s",
                sophia_user_id,
                self._pilot_user_id,
                chat_id,
            )
            return

        # 3. Look up or create the LangGraph thread. No topic_id in private
        # chats — Spec D5 / upstream issue #1101.
        thread_id = await asyncio.to_thread(
            self._store.get_thread_id, _CHANNEL_NAME, chat_id, None
        )
        if thread_id:
            logger.info(
                "[TelegramWork] reusing thread chat_id=%s thread_id=%s user_id=%s",
                chat_id,
                thread_id,
                sophia_user_id,
            )
        else:
            try:
                thread = await self._lg_client.threads.create()
            except Exception:
                logger.exception(
                    "[TelegramWork] threads.create failed chat_id=%s user_id=%s",
                    chat_id,
                    sophia_user_id,
                )
                await self._safe_reply(
                    bot,
                    chat_id,
                    reply_to_message_id,
                    "Hit an issue spinning up the thread. Try again in a moment?",
                )
                return
            thread_id = thread["thread_id"]
            await asyncio.to_thread(
                self._store.set_thread_id,
                _CHANNEL_NAME,
                chat_id,
                thread_id,
                topic_id=None,
                user_id=sophia_user_id,
            )
            logger.info(
                "[TelegramWork] thread created chat_id=%s thread_id=%s user_id=%s",
                chat_id,
                thread_id,
                sophia_user_id,
            )

        # 4. Placeholder message. Telegram doesn't support partial-message
        # streaming natively; Stage 1 edits this single message at the
        # end. Stage 2 (when BUILDER_LIVE_STREAM_ENABLED=true) patches it
        # per progress event via TelegramWorkBotChatRelaySink.
        try:
            placeholder = await bot.send_message(
                chat_id=int(chat_id),
                text="🔨 Working on your request…",
                reply_to_message_id=reply_to_message_id,
            )
        except Exception:
            logger.exception("[TelegramWork] placeholder send failed chat_id=%s", chat_id)
            return
        placeholder_message_id = placeholder.message_id

        # 5. Direct dispatch to sophia_builder. Stage 1 uses runs.wait
        # (blocking). Stage 2 (flag on) uses a gateway-side stream
        # consumer + runs.stream so the placeholder updates live.
        # BuilderTaskMiddleware synthesises delegation_context either
        # way (spec §6).
        run_input: dict[str, Any] = {
            "messages": [{"role": "user", "content": user_text}],
        }
        # IMPORTANT: thread_id / user_id / channel go in `context` ONLY,
        # NOT also in `config["configurable"]`. langgraph-api 0.7+ rejects
        # requests that set BOTH with HTTP 400 "Cannot specify both
        # configurable and context. Prefer setting context alone."
        # (langgraph_api/models/run.py:225–228). When only `context` is
        # supplied, langgraph-api copies it into `configurable` server-side
        # (run.py:233 `configurable = context.copy()`), so
        # ``make_sophia_builder(config)`` still reads
        # ``cfg["configurable"]["user_id"]`` correctly. This mirrors
        # ``manager.py:_resolve_run_params`` (lines 633–645) — the EI bot
        # path that has been working in production.
        # An earlier version of this code passed BOTH; the result was a
        # 1ms-rejected 400 from /threads/<id>/runs/wait the moment any
        # user DM'd @Sophia_Work_bot. Don't reintroduce.
        run_config: dict[str, Any] = {
            "recursion_limit": 100,
        }
        run_context: dict[str, Any] = {
            "thread_id": thread_id,
            "user_id": sophia_user_id,
            "channel": _CHANNEL_NAME,
        }

        from app.gateway.builder_events import is_live_stream_enabled

        if is_live_stream_enabled():
            await self._dispatch_streaming(
                bot=bot,
                chat_id=chat_id,
                thread_id=thread_id,
                sophia_user_id=sophia_user_id,
                placeholder_message_id=placeholder_message_id,
                run_input=run_input,
                run_config=run_config,
                run_context=run_context,
            )
            return

        try:
            result = await asyncio.wait_for(
                self._lg_client.runs.wait(
                    thread_id,
                    _DEFAULT_BUILDER_ASSISTANT_ID,
                    input=run_input,
                    config=run_config,
                    context=run_context,
                ),
                timeout=self._run_timeout_seconds,
            )
        except TimeoutError:
            logger.warning(
                "[TelegramWork] runs.wait timed out after %ds chat_id=%s thread_id=%s",
                self._run_timeout_seconds,
                chat_id,
                thread_id,
            )
            await self._safe_edit(
                bot,
                chat_id,
                placeholder_message_id,
                (
                    "The build took longer than the per-task ceiling and was "
                    "cut short. Send the request again to retry, or break it "
                    "into smaller chunks."
                ),
            )
            return
        except Exception as exc:
            logger.exception(
                "[TelegramWork] runs.wait failed chat_id=%s thread_id=%s",
                chat_id,
                thread_id,
            )
            await self._safe_edit(
                bot,
                chat_id,
                placeholder_message_id,
                f"Hit a snag and couldn't finish ({type(exc).__name__}). Try again or rephrase?",
            )
            return

        # 6. Render the result.
        await self._render_builder_result(
            bot=bot,
            chat_id=chat_id,
            placeholder_message_id=placeholder_message_id,
            thread_id=thread_id,
            result=result,
        )

    async def _dispatch_streaming(
        self,
        *,
        bot,
        chat_id: str,
        thread_id: str,
        sophia_user_id: str,
        placeholder_message_id: int,
        run_input: dict[str, Any],
        run_config: dict[str, Any],
        run_context: dict[str, Any],
    ) -> None:
        """Spawn a gateway-loop stream consumer; let the sink drive edits.

        The dispatch handler runs on ``_tg_loop`` (PTB polling thread).
        The stream consumer must run on the gateway loop because that's
        where the fanout and lg_client connection pool were initialised.
        We hop with ``asyncio.run_coroutine_threadsafe``.

        Artifact bytes-download still happens here on completion — the
        sink only edits the placeholder, it doesn't have the channel's
        artifact download path. We achieve "artifact follows summary" by
        subscribing to the same builder-events bus the EI bot uses for
        terminal delivery (see ``message_bus.publish_builder_completion``)
        — but the bus already fires on terminal webhook in the existing
        path, so artifact delivery is unchanged by this branch.
        """
        from app.gateway.builder_events import get_fanout
        from app.gateway.builder_events.sinks import TelegramWorkBotChatRelaySink
        from app.gateway.builder_events.stream_consumer import consume_builder_stream

        # Register the placeholder with the sink so it can edit live.
        fanout = get_fanout()
        sink: TelegramWorkBotChatRelaySink | None = None
        for s in fanout.sinks():
            if getattr(s, "name", "") == "telegram_work_chat":
                sink = s  # type: ignore[assignment]
                break
        if sink is None:
            logger.warning(
                "[TelegramWork] no telegram_work_chat sink registered; falling back to runs.wait"
            )
            try:
                result = await asyncio.wait_for(
                    self._lg_client.runs.wait(
                        thread_id,
                        _DEFAULT_BUILDER_ASSISTANT_ID,
                        input=run_input,
                        config=run_config,
                        context=run_context,
                    ),
                    timeout=self._run_timeout_seconds,
                )
            except Exception:
                logger.exception(
                    "[TelegramWork] streaming fallback runs.wait failed thread_id=%s",
                    thread_id,
                )
                await self._safe_edit(
                    bot, chat_id, placeholder_message_id,
                    "Hit a snag and couldn't finish. Try again?",
                )
                return
            await self._render_builder_result(
                bot=bot,
                chat_id=chat_id,
                placeholder_message_id=placeholder_message_id,
                thread_id=thread_id,
                result=result,
            )
            return

        sink.register_placeholder(thread_id, chat_id, placeholder_message_id)

        # Schedule the consumer on the gateway loop. We don't await it —
        # the sink drives the chat surface; the existing webhook-driven
        # MessageBus subscription delivers the artifact document on
        # terminal (same path the EI bot already uses).
        main_loop = self._main_loop
        if main_loop is None or not main_loop.is_running():
            logger.warning(
                "[TelegramWork] _main_loop unavailable; streaming dispatch aborted thread_id=%s",
                thread_id,
            )
            await self._safe_edit(
                bot, chat_id, placeholder_message_id,
                "Couldn't start the build pipeline. Try again?",
            )
            return

        coro = consume_builder_stream(
            lg_client=self._lg_client,
            builder_thread_id=thread_id,
            parent_thread_id=None,
            user_id=sophia_user_id,
            trace_id="",
            assistant_id=_DEFAULT_BUILDER_ASSISTANT_ID,
            run_input=run_input,
            run_config=run_config,
            run_context=run_context,
            consumer_timeout_seconds=self._run_timeout_seconds,
        )
        asyncio.run_coroutine_threadsafe(coro, main_loop)
        logger.info(
            "[TelegramWork] streaming consumer spawned thread_id=%s chat_id=%s user_id=%s",
            thread_id,
            chat_id,
            sophia_user_id,
        )

    async def relay_builder_event_edit(
        self,
        *,
        chat_id: str,
        message_id: int,
        text: str,
    ) -> None:
        """Cross-loop API for ``TelegramWorkBotChatRelaySink``.

        Called from the gateway loop; hops to ``_tg_loop`` to do the
        actual ``edit_message_text`` (PTB Bot is loop-affine).
        """
        bot = getattr(self._application, "bot", None) if self._application else None
        if bot is None:
            logger.debug("[TelegramWork] relay_edit no bot available")
            return
        await self._run_bot_call_on_telegram_loop(
            self._safe_edit(bot, chat_id, message_id, text)
        )

    async def _render_builder_result(
        self,
        *,
        bot,
        chat_id: str,
        placeholder_message_id: int,
        thread_id: str,
        result: Any,
    ) -> None:
        summary = self._extract_summary(result)
        artifact_filename = self._extract_artifact_filename(result)
        artifact_title = self._extract_artifact_title(result)

        # Edit the placeholder with the summary first so the user sees
        # text immediately, then send the artifact as a follow-up document.
        if summary:
            display_text = summary
        elif artifact_filename:
            display_text = f"Done — delivering {artifact_filename}."
        else:
            display_text = "Done. (No summary available.)"

        await self._safe_edit(bot, chat_id, placeholder_message_id, display_text)

        if artifact_filename:
            await self._send_artifact_document(
                bot=bot,
                chat_id=chat_id,
                thread_id=thread_id,
                filename=artifact_filename,
                caption=artifact_title,
            )

    async def _send_artifact_document(
        self,
        *,
        bot,
        chat_id: str,
        thread_id: str,
        filename: str,
        caption: str | None,
    ) -> None:
        """Download the artifact bytes from Supabase and send via send_document.

        Mirrors the EI bot's _on_builder_completion delivery pattern:
        bytes upload sidesteps Telegram's 'Failed to get http url content'
        edge case with Supabase signed URLs (see telegram.py:909–914).
        """
        # Lazy import via the Phase-C bridge — both Telegram channels
        # share one cross-layer edge (app → deerflow_sophia_services)
        # routed through ``app.channels._sophia_artifact_bridge`` instead
        # of each channel reaching into ``deerflow.sophia.storage``
        # independently. The lazy locality is preserved (no top-level
        # bridge import in this file).
        from app.channels._sophia_artifact_bridge import download_artifact

        try:
            result = await asyncio.to_thread(download_artifact, thread_id, filename)
        except Exception:
            logger.warning(
                "[TelegramWork] artifact download error chat_id=%s thread_id=%s filename=%s",
                chat_id,
                thread_id,
                filename,
                exc_info=True,
            )
            return

        if result is None:
            logger.warning(
                "[TelegramWork] artifact missing in storage chat_id=%s thread_id=%s filename=%s",
                chat_id,
                thread_id,
                filename,
            )
            return

        doc_bytes, _ = result

        from telegram import InputFile

        safe_caption: str | None = None
        if caption:
            safe_caption = self._truncate(caption, _TELEGRAM_CAPTION_LIMIT)

        try:
            await bot.send_document(
                chat_id=int(chat_id),
                document=InputFile(BytesIO(doc_bytes), filename=filename),
                caption=safe_caption,
            )
            logger.info(
                "[TelegramWork] artifact delivered chat_id=%s thread_id=%s filename=%s bytes=%d",
                chat_id,
                thread_id,
                filename,
                len(doc_bytes),
            )
        except Exception:
            logger.exception(
                "[TelegramWork] send_document failed chat_id=%s filename=%s",
                chat_id,
                filename,
            )

    # -- helpers -----------------------------------------------------------

    def _resolve_sophia_user_id(
        self,
        *,
        chat_id: str,
        telegram_user_id: str,
        telegram_username: str | None = None,
    ) -> str | None:
        """Resolve canonical Sophia user_id with EI-binding fallback + auto-bind.

        Three-step resolver — production-ready entry point for any
        EI-bound user (Stage 1C rollout).

        Step 1 — **forward fast path**: ``resolve_user_id("telegram", chat_id)``
        with this Work-DM chat_id. Hits when this chat was already
        auto-bound on a prior turn. Cheap; no Mem0 / Supabase round-trip.

        Step 2 — **reverse lookup**: ``resolve_user_id_by_telegram_user_id(
        telegram_user_id)``. Finds users who bound through
        @Sophia_EI_bot's deep-link flow but are now DM-ing the Work bot
        for the first time. Telegram assigns different chat_ids to
        different bot DMs (the same human gets a separate chat_id per
        bot), but ``update.effective_user.id`` is the same Telegram
        identity across bots. The reverse index (populated by
        ``bind_chat`` whenever a deep-link redemption happens, including
        EI's) lets us cross-reference.

        Step 3 — **auto-bind**: when step 2 hits, persist
        ``(channel="telegram", chat_id=<this Work-DM>)`` so step 1
        succeeds on subsequent turns. Best-effort: a bind failure logs
        but does NOT block this request — we already resolved the
        canonical user_id, so the build can proceed; only the next
        Work-DM lookup would re-pay step 2's cost.

        Returns ``None`` only when the user has never bound through ANY
        Telegram bot. Caller sends the friendly "DM @Sophia_EI_bot
        first" prompt.

        Stage 2+ enhancement (out of scope for this PR): add a webapp
        deep-link flow specifically for the Work bot
        (``t.me/Sophia_Work_bot?start=<token>``) so brand-new users can
        bind to Work without touching EI. Until then, the EI deep-link
        is the universal entry point per spec C6.
        """
        try:
            from app.gateway.telegram_link_store import (
                bind_chat,
                resolve_user_id,
                resolve_user_id_by_telegram_user_id,
            )
        except ImportError:  # pragma: no cover — defensive
            logger.warning("[TelegramWork] telegram_link_store unavailable")
            return None

        # Step 1 — forward fast path
        user_id = resolve_user_id(_BINDING_CHANNEL_KEY, chat_id)
        if user_id:
            return user_id

        # Step 2 — reverse lookup via Telegram identity
        user_id = resolve_user_id_by_telegram_user_id(telegram_user_id)
        if not user_id:
            return None

        # Step 3 — auto-bind so future Work DMs hit the fast path
        self._auto_bind_work_dm(
            bind_chat=bind_chat,
            chat_id=chat_id,
            user_id=user_id,
            telegram_user_id=telegram_user_id,
            telegram_username=telegram_username,
        )
        return user_id

    @staticmethod
    def _auto_bind_work_dm(
        *,
        bind_chat,
        chat_id: str,
        user_id: str,
        telegram_user_id: str,
        telegram_username: str | None,
    ) -> None:
        """Persist the Work-DM chat → canonical user_id binding.

        Best-effort: any failure (Supabase outage, validation reject,
        store-side race) is logged at WARNING and swallowed so the
        in-flight build is not blocked. Worst case is the next Work-DM
        from the same user re-pays the reverse-lookup cost.
        """
        try:
            bind_chat(
                _BINDING_CHANNEL_KEY,
                chat_id,
                user_id,
                telegram_user_id=telegram_user_id,
                telegram_username=telegram_username,
            )
        except Exception:
            logger.warning(
                "[TelegramWork] auto-bind failed chat=%s user_id=%s tg_user_id=%s "
                "— request still proceeds, future Work DMs will re-resolve via reverse lookup",
                chat_id,
                user_id,
                telegram_user_id,
                exc_info=True,
            )
            return
        logger.info(
            "[TelegramWork] auto-bound Work-DM chat=%s user_id=%s tg_user_id=%s "
            "(EI binding via reverse lookup)",
            chat_id,
            user_id,
            telegram_user_id,
        )

    @staticmethod
    def _extract_summary(result: Any) -> str | None:
        """Walk the runs.wait result for the latest builder summary.

        Priority order (most informative first):
        1. ``emit_builder_artifact`` tool-call args ``companion_summary``
           (the structured payload Builder produces on completion).
        2. The last AI message text (free-form summary if no artifact emit).

        Both passes are split into helpers to keep this method's
        cyclomatic complexity under sentrux's threshold; the helpers
        are also independently testable.
        """
        messages = TelegramWorkChannel._messages_from_result(result)
        return (
            TelegramWorkChannel._companion_summary_from_artifact_call(messages)
            or TelegramWorkChannel._last_ai_text(messages)
        )

    @staticmethod
    def _companion_summary_from_artifact_call(messages: list) -> str | None:
        """Find the latest ``emit_builder_artifact`` call's companion_summary.

        Returns None when no such call is present, when its args are
        malformed, or when ``companion_summary`` is empty.
        """
        for tool_call in TelegramWorkChannel._iter_artifact_tool_calls(messages):
            args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else {}
            summary = args.get("companion_summary")
            if isinstance(summary, str) and summary.strip():
                return summary.strip()
        return None

    @staticmethod
    def _last_ai_text(messages: list) -> str | None:
        """Walk messages backward for the latest AI text reply.

        Stops at the most recent human message so we don't bleed text
        from a prior turn. Handles both string content and the
        Anthropic content-block list shape (``[{"type": "text", ...}]``).
        """
        for msg in reversed(messages):
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "human":
                return None  # don't return text from prior turns
            if msg.get("type") != "ai":
                continue
            text = TelegramWorkChannel._flatten_ai_content(msg.get("content"))
            if text:
                return text
        return None

    @staticmethod
    def _flatten_ai_content(content: Any) -> str | None:
        """Coerce ``content`` (str | list-of-blocks | other) to a stripped string."""
        if isinstance(content, str):
            text = content.strip()
            return text or None
        if isinstance(content, list):
            parts = [TelegramWorkChannel._block_text(block) for block in content]
            text = "".join(parts).strip()
            return text or None
        return None

    @staticmethod
    def _block_text(block: Any) -> str:
        if isinstance(block, dict) and block.get("type") == "text":
            return str(block.get("text", ""))
        if isinstance(block, str):
            return block
        return ""

    @staticmethod
    def _iter_artifact_tool_calls(messages: list):
        """Yield ``emit_builder_artifact`` tool-call dicts (newest first)."""
        for msg in reversed(messages):
            if not isinstance(msg, dict) or msg.get("type") != "ai":
                continue
            for tc in msg.get("tool_calls") or []:
                if isinstance(tc, dict) and tc.get("name") == "emit_builder_artifact":
                    yield tc

    @staticmethod
    def _extract_artifact_filename(result: Any) -> str | None:
        """Return the basename of artifact_path from emit_builder_artifact."""
        messages = TelegramWorkChannel._messages_from_result(result)
        for tc in TelegramWorkChannel._iter_artifact_tool_calls(messages):
            args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
            path = args.get("artifact_path")
            if isinstance(path, str) and path.strip():
                return path.rsplit("/", 1)[-1]
        return None

    @staticmethod
    def _extract_artifact_title(result: Any) -> str | None:
        """Return artifact_title from emit_builder_artifact (used as caption)."""
        messages = TelegramWorkChannel._messages_from_result(result)
        for tc in TelegramWorkChannel._iter_artifact_tool_calls(messages):
            args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
            title = args.get("artifact_title")
            if isinstance(title, str) and title.strip():
                return title.strip()
        return None

    @staticmethod
    def _messages_from_result(result: Any) -> list:
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            messages = result.get("messages")
            if isinstance(messages, list):
                return messages
        return []

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        if limit <= 1:
            return "…"
        return f"{text[: limit - 1]}…"

    async def _safe_reply(self, bot, chat_id: str, reply_to_message_id: int, text: str) -> None:
        try:
            await bot.send_message(
                chat_id=int(chat_id),
                text=self._truncate(text, _TELEGRAM_TEXT_LIMIT),
                reply_to_message_id=reply_to_message_id,
            )
        except Exception:
            logger.exception("[TelegramWork] safe_reply failed chat_id=%s", chat_id)

    async def _safe_edit(self, bot, chat_id: str, message_id: int, text: str) -> None:
        try:
            await bot.edit_message_text(
                chat_id=int(chat_id),
                message_id=message_id,
                text=self._truncate(text, _TELEGRAM_TEXT_LIMIT),
            )
        except Exception:
            logger.exception(
                "[TelegramWork] safe_edit failed chat_id=%s message_id=%s",
                chat_id,
                message_id,
            )
            # Fall back to a fresh message so the user is not left hanging
            # if the edit fails (e.g., placeholder deleted by the user).
            try:
                await bot.send_message(
                    chat_id=int(chat_id),
                    text=self._truncate(text, _TELEGRAM_TEXT_LIMIT),
                )
            except Exception:
                logger.debug("[TelegramWork] fallback send_message also failed", exc_info=True)

    async def _run_bot_call_on_telegram_loop(self, coro):
        """Run a bot API coroutine on ``_tg_loop`` when called cross-loop.

        Mirror of TelegramChannel._run_bot_call_on_telegram_loop. Bot
        internals are loop-affine to ``_tg_loop`` (the polling-thread loop
        where the application was initialised). Any caller scheduling work
        from a different loop must hop back here.
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
