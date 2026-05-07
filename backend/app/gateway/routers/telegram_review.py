"""Internal endpoint for the Telegram review-link fallback.

Frontend route ``/api/auth/telegram-token`` POSTs the one-time token it
received in the LoginUrl-fallback URL. This endpoint validates the token
via ``telegram_link_store.pop_link_token`` and returns the canonical
user_id so the frontend can mint a session for that user.

Guarded by an internal shared-secret header (``X-Sophia-Internal-Token``).
The token has its own anti-replay protections (single-use, 10-min TTL)
but the secret prevents enumeration / abuse from outside the app.

This is a separate router so we don't have to relax the
``require_authorized_user_scope`` dependency on the user-facing
``telegram_link`` router.
"""

from __future__ import annotations

import hmac
import logging
import os

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field

from app.gateway.telegram_link_store import pop_link_token

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/sophia/internal", tags=["telegram-review"])


class RedeemTokenRequest(BaseModel):
    token: str = Field(..., min_length=16, max_length=96)


class RedeemTokenResponse(BaseModel):
    ok: bool
    user_id: str | None = None


def _check_internal_secret(presented: str | None) -> None:
    expected = os.getenv("SOPHIA_INTERNAL_TOKEN", "").strip()
    if not expected:
        # Closed by default: missing config is treated as locked, never as open.
        logger.warning(
            "telegram_review.internal_secret_unset — rejecting redeem call. "
            "Set SOPHIA_INTERNAL_TOKEN to enable."
        )
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="not_configured")
    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="forbidden")


@router.post(
    "/redeem-telegram-review-token",
    response_model=RedeemTokenResponse,
    summary="Redeem a one-time Telegram review token (internal)",
)
async def redeem_telegram_review_token(
    body: RedeemTokenRequest,
    x_sophia_internal_token: str | None = Header(default=None, alias="X-Sophia-Internal-Token"),
) -> RedeemTokenResponse:
    _check_internal_secret(x_sophia_internal_token)

    record = pop_link_token(body.token)
    if record is None:
        # Either unknown or expired. Don't differentiate — caller treats
        # both as "invalid".
        return RedeemTokenResponse(ok=False, user_id=None)

    return RedeemTokenResponse(ok=True, user_id=record.user_id)


__all__ = ["router"]
