"""Build + publish the "memories ready to review" notification payload.

Wired into ``app.channels.telegram_session_tracker._check_inactive_chats``:
fires once per finalized session, builds the LoginUrl (or plain-URL
one-time-token fallback), and publishes the payload to the process-wide
``MessageBus`` for the Telegram channel adapter to render.

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

Architecture note: this module deliberately does NOT import from
``app.channels.service`` or ``app.channels.telegram``. Instead it
publishes to the process-wide bus via ``publish_review_notification``;
the Telegram adapter subscribes on startup. That indirection breaks
what would otherwise be a ``service → manager → tracker → notifier →
service`` cycle (caught by Sentrux as a score regression).
"""

from __future__ import annotations

import logging
import os
from urllib.parse import urlencode, urljoin

from app.channels.message_bus import publish_review_notification

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
    """Build the URL + publish a review-notification event on the bus.

    Returns True if the event was published (a subscriber may still fail
    asynchronously — the bus swallows those errors), False on a config
    short-circuit (flag disabled, base URL unset, invalid args, no bus).
    Never raises.
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

    payload = {
        "channel": "telegram",
        "chat_id": chat_id,
        "user_id": user_id,
        "session_id": session_id,
        "review_url": review_url,
        "use_login_url": use_login_url,
    }
    try:
        await publish_review_notification(payload)
    except Exception:
        logger.exception(
            "telegram_review_notifier.publish_failed chat_id=%s session_id=%s",
            chat_id,
            session_id,
        )
        return False
    return True
