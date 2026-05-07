"""Send the "memories ready to review" DM after a Telegram session ends.

Wired into ``app.channels.telegram_session_tracker._check_inactive_chats``:
fires once per finalized session, using the Telegram primary bot to deliver
an inline-keyboard button that opens the web app's recap page authenticated
as the canonical user.

Two delivery modes (selected by env / availability):

1. **LoginUrl button (preferred)** — Telegram appends an HMAC-signed payload
   (``id``, ``auth_date``, ``hash``) to the URL. Requires that the URL host
   be registered with ``@BotFather /setdomain`` for the primary bot.
2. **Plain URL with one-time token (fallback)** — when LoginUrl is disabled
   via env or domain registration is unavailable, mint a single-use 10-min
   token via ``telegram_link_store.issue_link_token`` and embed it in the
   URL. The frontend route validates the token instead of the HMAC.

Best-effort: any failure logs and returns. Never raises into the tracker
loop — pipeline finalization must not be blocked on a notification error.
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlencode, urljoin

logger = logging.getLogger(__name__)

# Public env knobs. Documented in backend/CLAUDE.md.
_ENV_BASE_URL = "SOPHIA_WEB_BASE_URL"
_ENV_FEATURE_FLAG = "TELEGRAM_REVIEW_NOTIFICATIONS_ENABLED"
_ENV_USE_LOGIN_URL = "TELEGRAM_REVIEW_USE_LOGIN_URL"

_DEFAULT_PATH = "/api/auth/telegram-login"
_FALLBACK_PATH = "/api/auth/telegram-token"


def _flag_enabled(name: str, *, default: bool = True) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _join_url(base: str, path: str, params: dict[str, str]) -> str:
    base = base.rstrip("/") + "/"
    relative = path.lstrip("/")
    qs = urlencode(params)
    return urljoin(base, relative) + ("?" + qs if qs else "")


async def enqueue_review_notification(
    chat_id: str,
    user_id: str,
    session_id: str,
) -> bool:
    """Send a memory-review DM for the just-finalized session.

    Returns True if the message reached Telegram, False on any failure
    (skip, missing config, transport error, etc.). Never raises.
    """
    if not _flag_enabled(_ENV_FEATURE_FLAG, default=True):
        logger.info(
            "telegram_review_notifier.disabled chat_id=%s session_id=%s",
            chat_id,
            session_id,
        )
        return False

    base_url = os.getenv(_ENV_BASE_URL, "").strip()
    if not base_url:
        logger.warning(
            "telegram_review_notifier.no_base_url chat_id=%s session_id=%s — "
            "set SOPHIA_WEB_BASE_URL to enable review notifications",
            chat_id,
            session_id,
        )
        return False

    if not chat_id or not session_id:
        logger.warning(
            "telegram_review_notifier.invalid_args chat_id=%r session_id=%r",
            chat_id,
            session_id,
        )
        return False

    # Resolve the running Telegram channel. Best-effort — if the channel
    # service isn't running (e.g. tests, gateway-only deploy) we skip.
    try:
        from app.channels.service import get_channel_service
    except ImportError:
        logger.warning("telegram_review_notifier.no_channel_service")
        return False

    service = get_channel_service()
    if service is None:
        logger.info("telegram_review_notifier.channel_service_not_started")
        return False

    channel = service.get_channel("telegram")
    if channel is None:
        logger.info("telegram_review_notifier.no_telegram_channel chat_id=%s", chat_id)
        return False

    use_login_url = _flag_enabled(_ENV_USE_LOGIN_URL, default=True)

    if use_login_url:
        review_url = _join_url(base_url, _DEFAULT_PATH, {"session": session_id})
    else:
        # Fallback: mint a one-time token bound to the canonical user_id.
        # The frontend route verifies the token via ``pop_link_token``
        # (single-use, 10-min TTL) instead of the Telegram HMAC.
        try:
            from app.gateway.telegram_link_store import issue_link_token
        except ImportError:
            logger.warning("telegram_review_notifier.no_link_store")
            return False
        try:
            record = issue_link_token(user_id)
        except ValueError:
            logger.warning(
                "telegram_review_notifier.invalid_user_id user_id=%r", user_id
            )
            return False
        review_url = _join_url(
            base_url,
            _FALLBACK_PATH,
            {"token": record.token, "session": session_id},
        )

    try:
        return await channel.send_review_notification(
            chat_id=chat_id,
            session_id=session_id,
            review_url=review_url,
            use_login_url=use_login_url,
        )
    except Exception:
        logger.exception(
            "telegram_review_notifier.send_failed chat_id=%s session_id=%s",
            chat_id,
            session_id,
        )
        return False
