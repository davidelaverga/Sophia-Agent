"""Voice session API — Stream token generation and call lifecycle."""

import logging
import os
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sophia", tags=["voice"])

SUPPORTED_PLATFORMS = {"voice", "text", "ios_voice"}
SUPPORTED_CONTEXT_MODES = {"work", "gaming", "life"}


class VoiceConnectRequest(BaseModel):
    """Request body for establishing a voice session."""

    platform: str = Field(..., description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(default=None, description="Active ritual: prepare | debrief | vent | reset | None")


class VoiceConnectResponse(BaseModel):
    """Credentials the frontend needs to join the Stream call."""

    api_key: str
    token: str
    call_type: str
    call_id: str


def _get_stream_api_key() -> str:
    key = os.getenv("STREAM_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="STREAM_API_KEY not configured")
    return key


def _get_stream_api_secret() -> str:
    secret = os.getenv("STREAM_API_SECRET", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="STREAM_API_SECRET not configured")
    return secret


def _generate_stream_token(api_secret: str, user_id: str) -> str:
    """Generate a Stream user token using the getstream SDK.

    Falls back to a JWT-signed token if the SDK is unavailable.
    """
    try:
        from getstream import Stream

        client = Stream(api_key=_get_stream_api_key(), api_secret=api_secret)
        return client.create_token(user_id)
    except ImportError:
        pass

    # Fallback: manual JWT signing (Stream tokens are HS256 JWTs)
    import hashlib
    import hmac
    import json
    from base64 import urlsafe_b64encode

    header = urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).rstrip(b"=")
    payload = urlsafe_b64encode(
        json.dumps({"user_id": user_id, "iat": int(time.time())}).encode()
    ).rstrip(b"=")
    signing_input = header + b"." + payload
    signature = urlsafe_b64encode(
        hmac.new(api_secret.encode(), signing_input, hashlib.sha256).digest()
    ).rstrip(b"=")
    return (signing_input + b"." + signature).decode()


@router.post(
    "/{user_id}/voice/connect",
    response_model=VoiceConnectResponse,
    summary="Start a voice session",
    description="Generate Stream credentials for the frontend and signal the Voice Agent to join.",
)
async def voice_connect(user_id: str, body: VoiceConnectRequest) -> VoiceConnectResponse:
    """Create a Stream call and return credentials for the frontend to join."""

    if body.platform not in SUPPORTED_PLATFORMS:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid platform '{body.platform}'. Must be one of: {', '.join(sorted(SUPPORTED_PLATFORMS))}",
        )

    if body.context_mode not in SUPPORTED_CONTEXT_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid context_mode '{body.context_mode}'. Must be one of: {', '.join(sorted(SUPPORTED_CONTEXT_MODES))}",
        )

    api_key = _get_stream_api_key()
    api_secret = _get_stream_api_secret()

    call_id = f"sophia-{user_id}-{uuid.uuid4().hex[:8]}"
    token = _generate_stream_token(api_secret, user_id)

    logger.info(
        "voice.connect user_id=%s platform=%s context_mode=%s ritual=%s call_id=%s",
        user_id,
        body.platform,
        body.context_mode,
        body.ritual,
        call_id,
    )

    return VoiceConnectResponse(
        api_key=api_key,
        token=token,
        call_type="default",
        call_id=call_id,
    )
