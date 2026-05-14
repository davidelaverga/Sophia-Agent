"""WorkshopTelegramChannel — Phase 1 skeleton for @Sophia_work_bot.

Phase 1 of ``sophia_telegram_architecture_spec_v1.md``. The full spec
calls for:

1. Receiving Telegram guest-mode dispatches when companion ``@``-mentions
   the workshop bot in a user-companion chat.
2. Resolving ``chat_id + summoning_message_id → task_id`` via the
   gateway's ``TaskResolutionCache``.
3. Opening a streaming reply, subscribing to the BuilderEventFanout for
   that task, and pushing rendered activity until the terminal event.
4. Sending the artifact as a Telegram document via the shared
   ``_sophia_artifact_bridge``.
5. Cold DM redirect (§6.5).
6. Loop prevention (§14).

This Phase 1 channel ships as a skeleton. With
``TELEGRAM_WORKSHOP_BOT_ENABLED=false`` (the default), :meth:`start`
short-circuits before opening a polling connection. The handler stubs
below are exercised by unit tests so the routing + redirect + loop
prevention wiring is verifiable. Phase 2 wires the real event
subscription + ``StreamingTextClient`` lifecycle.

Mutual exclusion: a startup assertion in
:meth:`ChannelService._start_channel` prevents this channel from running
alongside the legacy ``telegram_work`` channel (they share the bot
token). The check lives in :meth:`start` below.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from app.channels.base import Channel
from app.channels.message_bus import MessageBus, OutboundMessage
from app.channels.telegram_loop_prevention import LoopPreventionGate

logger = logging.getLogger(__name__)


_CHANNEL_NAME = "telegram_workshop"
_DEFAULT_BOT_USERNAME = "Sophia_work_bot"
_COLD_DM_MUTE_MINUTES_DEFAULT = 30


def _strict_loop_prevention() -> bool:
    return os.environ.get("TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT", "true").lower() not in {"0", "false", "no"}


def _workshop_enabled_env() -> bool:
    return os.environ.get("TELEGRAM_WORKSHOP_BOT_ENABLED", "false").lower() in {"1", "true", "yes"}


class WorkshopTelegramChannel(Channel):
    """@Sophia_work_bot — workshop presentation layer (Phase 1 skeleton)."""

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name=_CHANNEL_NAME, bus=bus, config=config)
        self._application = None
        self._bot_token = str(config.get("bot_token", "")).strip()
        self._bot_username = str(config.get("bot_username", _DEFAULT_BOT_USERNAME)).strip().lstrip("@")
        # Config-level ``enabled`` flag combines with the env-level
        # ``TELEGRAM_WORKSHOP_BOT_ENABLED`` master switch; both must be
        # true for the polling loop to start.
        self._config_enabled = bool(config.get("enabled", False))
        self._cold_dm_mute_minutes = int(config.get("cold_dm_mute_minutes", _COLD_DM_MUTE_MINUTES_DEFAULT))
        self._muted_users: dict[int, float] = {}
        self._loop_prevention = LoopPreventionGate()
        self._strict_loop_prevention = _strict_loop_prevention()

    # -- lifecycle ----------------------------------------------------------

    @property
    def is_active(self) -> bool:
        """Composite enable flag (config + env). Public for diagnostics."""
        return self._config_enabled and _workshop_enabled_env()

    async def start(self) -> None:
        if self._running:
            return

        # Mutual-exclusion guard. The legacy ``telegram_work`` channel
        # (PR #120 — Builder-as-Main DM) uses the same bot token; running
        # both at once collides on update consumption. Refuse to start.
        if self._config_enabled and self._legacy_work_channel_enabled():
            logger.error(
                "[TelegramWorkshop] cannot start: channels.telegram_work.enabled=true. "
                "Disable the legacy telegram_work channel before enabling telegram_workshop."
            )
            return

        if not self.is_active:
            reason = "config" if not self._config_enabled else "env"
            logger.info(
                "[TelegramWorkshop] disabled (%s) — skipping start (Phase 1 default)",
                reason,
            )
            return

        if not self._bot_token:
            logger.error(
                "[TelegramWorkshop] bot_token empty; set channels.telegram_workshop.bot_token "
                "(or $TELEGRAM_WORKER_BOT_TOKEN) and restart"
            )
            return

        # Phase 1 leaves polling unstarted intentionally — wiring lives in
        # Phase 2. The skeleton flips ``_running`` so the service reports
        # the channel as live and tests can exercise the handler stubs.
        self._running = True
        logger.info(
            "[TelegramWorkshop] Phase 1 skeleton started bot_username=%s "
            "(real polling wired in Phase 2)",
            self._bot_username,
        )

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        logger.info("[TelegramWorkshop] stopped")

    async def send(self, msg: OutboundMessage) -> None:
        """Phase 1 stub — outbound from workshop is event-driven, not bus-driven.

        Phase 2 routes streaming-text updates via the StreamingTextClient
        directly rather than through ``OutboundMessage``. This stub keeps
        the abstract contract satisfied.
        """
        if msg.channel_name == self.name:
            logger.debug("[TelegramWorkshop] send() called in Phase 1 skeleton — ignored")

    # -- handler stubs ------------------------------------------------------

    async def handle_cold_dm(
        self,
        *,
        telegram_user_id: int,
        bot_send: Any,
        chat_id: int,
    ) -> bool:
        """Send the cold-DM redirect and mute the user for 30 minutes.

        Returns True when the redirect was issued, False when the user is
        currently muted (silent no-op).

        Spec §6.5 redirect text.
        """
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
        """Run all loop-prevention checks. Returns False (block) on any failure.

        With ``TELEGRAM_WORKSHOP_LOOP_PREVENTION_STRICT=false`` (test-only),
        blocks are still logged but the gate returns True so the handler
        continues. Production must keep strict mode ON.
        """
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
        """Read the legacy ``channels.telegram_work.enabled`` flag from app config."""
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
