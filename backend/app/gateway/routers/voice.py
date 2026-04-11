"""Voice session API — Stream token generation, agent dispatch, and call lifecycle."""

import asyncio
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.gateway.auth import require_authorized_user_scope

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/api/sophia",
    tags=["voice"],
    dependencies=[Depends(require_authorized_user_scope)],
)

SUPPORTED_PLATFORMS = {"voice", "text", "ios_voice"}
SUPPORTED_CONTEXT_MODES = {"work", "gaming", "life"}
VOICE_SERVER_DISPATCH_TIMEOUT = 10.0


@dataclass(frozen=True)
class ActiveVoiceSession:
    call_id: str
    session_id: str


_active_voice_sessions: dict[str, ActiveVoiceSession] = {}
_active_voice_session_locks: dict[str, asyncio.Lock] = {}
_active_voice_session_locks_guard = asyncio.Lock()


def _get_voice_server_url() -> str:
    return os.getenv("VOICE_SERVER_URL", "http://localhost:8000").rstrip("/")


async def _get_active_voice_session_lock(user_id: str) -> asyncio.Lock:
    async with _active_voice_session_locks_guard:
        return _active_voice_session_locks.setdefault(user_id, asyncio.Lock())


class VoiceConnectRequest(BaseModel):
    """Request body for establishing a voice session."""

    platform: str = Field(..., description="Platform signal: voice | text | ios_voice")
    context_mode: str = Field(default="life", description="Context adaptation: work | gaming | life")
    ritual: str | None = Field(default=None, description="Active ritual: prepare | debrief | vent | reset | None")
    session_id: str | None = Field(
        default=None,
        description="Frontend companion session ID for continuity",
    )
    thread_id: str | None = Field(
        default=None,
        description="LangGraph thread ID to reuse for this voice session",
    )


class VoiceConnectResponse(BaseModel):
    """Credentials the frontend needs to join the Stream call."""

    api_key: str
    token: str
    call_type: str
    call_id: str
    session_id: str | None = Field(
        default=None,
        description="Voice agent session ID (from Vision Agents server)",
    )


class VoiceDisconnectRequest(BaseModel):
    """Request body for ending a voice session."""

    call_id: str = Field(..., description="The call_id returned from /voice/connect")
    session_id: str = Field(..., description="The session_id returned from /voice/connect")


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


def _sanitize_call_id_fragment(value: str) -> str:
    """Normalize user-derived fragments to the voice server's call_id charset."""

    normalized = re.sub(r"[^a-z0-9_-]+", "-", value.lower()).strip("-_")
    return normalized or "user"


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
    """Create a Stream call, dispatch the voice agent, and return credentials."""

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

    call_id = f"sophia-{_sanitize_call_id_fragment(user_id)}-{uuid.uuid4().hex[:8]}"
    call_type = "default"
    token = _generate_stream_token(api_secret, user_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        previous_session = _active_voice_sessions.get(user_id)
        if previous_session is not None:
            logger.info(
                "voice.connect closing previous session user_id=%s call_id=%s session_id=%s",
                user_id,
                previous_session.call_id,
                previous_session.session_id,
            )
            await _disconnect_voice_session(
                previous_session.call_id,
                previous_session.session_id,
            )
            if _active_voice_sessions.get(user_id) == previous_session:
                _active_voice_sessions.pop(user_id, None)

        session_id = await _dispatch_voice_agent(
            call_id=call_id,
            call_type=call_type,
            platform=body.platform,
            context_mode=body.context_mode,
            ritual=body.ritual,
            session_id=body.session_id,
            thread_id=body.thread_id,
        )

        if session_id:
            _active_voice_sessions[user_id] = ActiveVoiceSession(
                call_id=call_id,
                session_id=session_id,
            )

    logger.info(
        "voice.connect user_id=%s platform=%s context_mode=%s ritual=%s companion_session_id=%s thread_id=%s call_id=%s session_id=%s",
        user_id,
        body.platform,
        body.context_mode,
        body.ritual,
        body.session_id,
        body.thread_id,
        call_id,
        session_id,
    )

    return VoiceConnectResponse(
        api_key=api_key,
        token=token,
        call_type=call_type,
        call_id=call_id,
        session_id=session_id,
    )


async def _dispatch_voice_agent(
    call_id: str,
    call_type: str,
    platform: str,
    context_mode: str,
    ritual: str | None,
    session_id: str | None = None,
    thread_id: str | None = None,
) -> str | None:
    """Tell the Vision Agents voice server to spawn an agent for this call.

    Returns the session_id on success, or None if the voice server is unavailable
    (logged as a warning — the call proceeds without an agent so the frontend
    can display an appropriate error state rather than hanging).
    """
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions"

    try:
        async with httpx.AsyncClient(timeout=VOICE_SERVER_DISPATCH_TIMEOUT) as client:
            resp = await client.post(
                url,
                json={
                    "call_type": call_type,
                    "platform": platform,
                    "context_mode": context_mode,
                    "ritual": ritual,
                    "session_id": session_id,
                    "thread_id": thread_id,
                },
            )
            resp.raise_for_status()
            try:
                data = resp.json()
            except ValueError:
                logger.warning(
                    "voice.dispatch failed — voice server returned invalid JSON for call_id=%s",
                    call_id,
                )
                return None

            if not isinstance(data, dict):
                logger.warning(
                    "voice.dispatch failed — voice server returned non-object payload for call_id=%s",
                    call_id,
                )
                return None

            session_id = data.get("session_id")
            if session_id is not None and not isinstance(session_id, str):
                logger.warning(
                    "voice.dispatch failed — voice server returned invalid session_id for call_id=%s",
                    call_id,
                )
                return None

            logger.info("voice.dispatch call_id=%s session_id=%s", call_id, session_id)
            return session_id
    except httpx.ConnectError:
        logger.warning("voice.dispatch failed — voice server unreachable at %s", voice_url)
        return None
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.dispatch failed — voice server returned %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return None
    except httpx.TimeoutException:
        logger.warning("voice.dispatch timed out after %.1fs for call_id=%s", VOICE_SERVER_DISPATCH_TIMEOUT, call_id)
        return None
    except httpx.RequestError as exc:
        logger.warning(
            "voice.dispatch failed — request error for call_id=%s: %s",
            call_id,
            exc,
        )
        return None


@router.post(
    "/{user_id}/voice/disconnect",
    status_code=204,
    summary="End a voice session",
    description="Signal the Voice Agent to leave the call. Falls back to idle timeout if unreachable.",
)
async def voice_disconnect(user_id: str, body: VoiceDisconnectRequest) -> None:
    """Request the voice server to close the agent session."""
    await _disconnect_voice_session(body.call_id, body.session_id)

    lock = await _get_active_voice_session_lock(user_id)
    async with lock:
        active_session = _active_voice_sessions.get(user_id)
        if active_session == ActiveVoiceSession(call_id=body.call_id, session_id=body.session_id):
            _active_voice_sessions.pop(user_id, None)

    logger.info(
        "voice.disconnect user_id=%s call_id=%s session_id=%s",
        user_id,
        body.call_id,
        body.session_id,
    )


async def _disconnect_voice_session(call_id: str, session_id: str) -> None:
    voice_url = _get_voice_server_url()
    url = f"{voice_url}/calls/{call_id}/sessions/{session_id}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.delete(url)
            if resp.status_code == 404:
                logger.info(
                    "voice.disconnect session already gone call_id=%s session_id=%s",
                    call_id,
                    session_id,
                )
                return
            resp.raise_for_status()
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.warning(
            "voice.disconnect — voice server unreachable, relying on idle timeout for call_id=%s",
            call_id,
        )
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.disconnect failed — %s: %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
    except httpx.RequestError as exc:
        logger.warning(
            "voice.disconnect failed — request error for call_id=%s: %s",
            call_id,
            exc,
        )
