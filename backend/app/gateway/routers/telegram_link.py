"""Telegram deep-link token issuance + binding management.

Webapp flow:

    POST   /api/sophia/{user_id}/telegram/link  -> { url, token, expires_at }
    GET    /api/sophia/{user_id}/telegram/link  -> { linked, telegram_username? }
    DELETE /api/sophia/{user_id}/telegram/link  -> 204

The bot's ``/start <token>`` handler redeems tokens via direct calls to
``app.gateway.telegram_link_store`` (same process — no internal HTTP hop).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app.gateway.auth import require_authorized_user_scope
from app.gateway.telegram_link_store import (
    get_binding_for_user,
    get_bot_username,
    issue_link_token,
    unbind_user,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/sophia",
    tags=["telegram"],
    dependencies=[Depends(require_authorized_user_scope)],
)


class TelegramLinkResponse(BaseModel):
    """Response body returned by ``POST /telegram/link``."""

    url: str = Field(..., description="Deep-link URL the user should open: t.me/<bot>?start=<token>")
    token: str = Field(..., description="The raw token, also embedded in the URL (surfaced for QR rendering)")
    expires_at: float = Field(..., description="Unix timestamp after which the token will no longer redeem")
    bot_username: str = Field(..., description="The bot username the user will be connecting with")


class TelegramLinkStatusResponse(BaseModel):
    """Response body returned by ``GET /telegram/link``."""

    linked: bool = Field(..., description="True if the webapp user has a live Telegram binding")
    telegram_username: str | None = Field(default=None, description="The bound Telegram username (no @)")
    telegram_chat_id: str | None = Field(default=None, description="Opaque Telegram chat id (for UI only)")
    bot_username: str = Field(..., description="Bot username so the UI can render a 'talk to @bot' label")


def _build_start_url(bot_username: str, token: str) -> str:
    return f"https://t.me/{bot_username}?start={token}"


@router.post(
    "/{user_id}/telegram/link",
    response_model=TelegramLinkResponse,
    summary="Issue a Telegram start-chat deep-link token",
    description=(
        "Returns a short-lived (10 min), single-use token wrapped in a "
        "``t.me/<bot>?start=<token>`` URL. Opening the URL in Telegram and "
        "tapping Start binds the resulting chat_id to the authenticated user."
    ),
)
async def create_telegram_link(user_id: str) -> TelegramLinkResponse:
    record = issue_link_token(user_id)
    bot_username = get_bot_username()
    url = _build_start_url(bot_username, record.token)
    return TelegramLinkResponse(
        url=url,
        token=record.token,
        expires_at=record.expires_at,
        bot_username=bot_username,
    )


@router.get(
    "/{user_id}/telegram/link",
    response_model=TelegramLinkStatusResponse,
    summary="Read the user's Telegram link status",
    description="Returns whether the authenticated user has an active Telegram binding.",
)
async def get_telegram_link(user_id: str) -> TelegramLinkStatusResponse:
    bot_username = get_bot_username()
    binding = get_binding_for_user(user_id, channel="telegram")
    if binding is None:
        return TelegramLinkStatusResponse(linked=False, bot_username=bot_username)
    return TelegramLinkStatusResponse(
        linked=True,
        telegram_username=binding.telegram_username,
        telegram_chat_id=binding.chat_id,
        bot_username=bot_username,
    )


@router.delete(
    "/{user_id}/telegram/link",
    status_code=204,
    summary="Revoke the user's Telegram binding",
    description="Removes all Telegram bindings for the authenticated user.",
)
async def delete_telegram_link(user_id: str) -> Response:
    removed = unbind_user(user_id, channel="telegram")
    logger.info("telegram_link.revoke user_id=%s removed=%d", user_id, removed)
    # 204 regardless of whether a binding existed — idempotent UX.
    return Response(status_code=204)


# Re-export for readability in tests that want to assert responses
__all__ = [
    "router",
    "TelegramLinkResponse",
    "TelegramLinkStatusResponse",
]


# Guardrail: keeping the HTTP 404 path explicit for endpoints that rely on
# an active binding. Not currently used but reserved for future endpoints
# like "send a welcome message to my Telegram chat".
def ensure_binding_or_404(user_id: str) -> None:
    if get_binding_for_user(user_id, channel="telegram") is None:
        raise HTTPException(status_code=404, detail="No Telegram binding for this user")
