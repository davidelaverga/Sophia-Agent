"""Voice session endpoints.

Provides connect/disconnect lifecycle for voice sessions and queues
the offline pipeline on disconnect so memories, handoffs, and traces
are generated after every voice conversation.
"""

import asyncio
import logging
import os

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.utils import validate_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sophia/{user_id}/voice", tags=["sophia-voice"])

_VOICE_SERVER_URL = os.getenv("SOPHIA_VOICE_SERVER_URL", "http://localhost:8080")

# Background tasks set — prevents GC from cancelling fire-and-forget tasks
_background_tasks: set[asyncio.Task] = set()


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class VoiceConnectRequest(BaseModel):
    platform: str = Field(default="voice", description="voice or ios_voice")
    ritual: str | None = Field(default=None, description="Active ritual or null")
    context_mode: str = Field(default="life", description="work, gaming, or life")


class VoiceConnectResponse(BaseModel):
    call_id: str
    session_id: str
    thread_id: str
    stream_url: str


class VoiceDisconnectRequest(BaseModel):
    call_id: str
    session_id: str
    thread_id: str = Field(
        min_length=1,
        description="LangGraph thread_id — required for offline pipeline "
                    "to fetch conversation state for memory extraction."
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/connect",
    response_model=VoiceConnectResponse,
    summary="Start a voice session",
)
async def voice_connect(user_id: str, body: VoiceConnectRequest) -> VoiceConnectResponse:
    """Start a voice session via the voice server.

    Returns call_id, session_id, thread_id, and the SSE stream URL.
    """
    try:
        validate_user_id(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Proxy to voice server
    url = f"{_VOICE_SERVER_URL}/calls"
    payload = {
        "user_id": user_id,
        "platform": body.platform,
        "ritual": body.ritual,
        "context_mode": body.context_mode,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Voice server unreachable")
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="Voice server error")

    call_id = data.get("call_id", "")
    session_id = data.get("session_id", "")
    thread_id = data.get("thread_id", "")

    if not call_id or not session_id or not thread_id:
        raise HTTPException(
            status_code=502,
            detail="Voice server returned incomplete session data (missing call_id, session_id, or thread_id)",
        )

    # Register with inactivity watcher
    try:
        from app.gateway.inactivity_watcher import register_activity
        register_activity(thread_id, user_id, session_id, body.context_mode)
    except ImportError:
        pass

    stream_url = f"/api/sophia/{user_id}/voice/events?call_id={call_id}&session_id={session_id}"

    logger.info(
        "voice.connect user_id=%s call_id=%s session_id=%s thread_id=%s",
        user_id, call_id, session_id, thread_id,
    )

    return VoiceConnectResponse(
        call_id=call_id,
        session_id=session_id,
        thread_id=thread_id,
        stream_url=stream_url,
    )


@router.post(
    "/disconnect",
    status_code=204,
    summary="End a voice session",
    description=(
        "Signal the voice agent to leave the call and queue the offline pipeline. "
        "Falls back to idle timeout if voice server is unreachable."
    ),
)
async def voice_disconnect(user_id: str, body: VoiceDisconnectRequest) -> None:
    """Close the voice session and trigger session finalization."""
    try:
        validate_user_id(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Step 1: Unregister from inactivity tracking (prevent double-fire)
    try:
        from app.gateway.inactivity_watcher import unregister_thread
        unregister_thread(body.thread_id)
    except ImportError:
        pass

    # Step 2: Queue offline pipeline (idempotent — _processed_sessions prevents double run)
    thread_id = body.thread_id
    try:
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        task = asyncio.create_task(
            asyncio.to_thread(
                run_offline_pipeline,
                user_id,
                body.session_id,
                thread_id,
                None,  # thread_state: pipeline now self-fetches from LangGraph
            )
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    except ImportError:
        logger.warning("Offline pipeline not available — skipping finalization")

    # Step 3: Close voice transport
    url = f"{_VOICE_SERVER_URL}/calls/{body.call_id}/sessions/{body.session_id}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.delete(url)
            if resp.status_code == 404:
                logger.info(
                    "voice.disconnect session already gone call_id=%s session_id=%s",
                    body.call_id, body.session_id,
                )
                return
            resp.raise_for_status()
    except (httpx.ConnectError, httpx.TimeoutException):
        logger.warning(
            "voice.disconnect — voice server unreachable, relying on idle timeout call_id=%s",
            body.call_id,
        )
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "voice.disconnect failed — %s: %s",
            exc.response.status_code, exc.response.text[:200],
        )

    logger.info(
        "voice.disconnect user_id=%s call_id=%s session_id=%s pipeline=queued",
        user_id, body.call_id, body.session_id,
    )
