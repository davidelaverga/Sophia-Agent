"""Sophia session management stubs.

Development stubs for /api/v1/sessions/* endpoints.
These keep the frontend contract stable while still bootstrapping
real LangGraph threads for live continuity.
"""

import os
import uuid
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])

LANGGRAPH_THREAD_CREATE_TIMEOUT_SECONDS = 5.0


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SessionStartRequest(BaseModel):
    session_type: str = "open"
    preset_context: str = "life"
    intention: str | None = None
    focus_cue: str | None = None


class MemoryHighlight(BaseModel):
    id: str = ""
    text: str = ""
    category: str = ""


class SessionStartResponse(BaseModel):
    session_id: str
    thread_id: str
    greeting_message: str
    message_id: str
    memory_highlights: list[MemoryHighlight]
    is_resumed: bool
    briefing_source: str
    has_memory: bool
    session_type: str
    preset_context: str
    started_at: str


class SessionInfo(BaseModel):
    session_id: str
    thread_id: str
    session_type: str
    preset_context: str
    status: str
    started_at: str
    turn_count: int
    intention: str | None = None
    focus_cue: str | None = None


class ActiveSessionResponse(BaseModel):
    has_active_session: bool
    session: SessionInfo | None = None


class SessionEndRequest(BaseModel):
    session_id: str
    offer_debrief: bool = False


class SessionEndResponse(BaseModel):
    session_id: str
    ended_at: str
    duration_minutes: int
    turn_count: int
    recap_artifacts: dict | None = None
    offer_debrief: bool
    debrief_prompt: str | None = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _get_langgraph_base_url() -> str:
    return (
        os.getenv("SOPHIA_LANGGRAPH_BASE_URL")
        or os.getenv("SOPHIA_BACKEND_BASE_URL")
        or "http://127.0.0.1:2024"
    ).strip().rstrip("/")


async def _create_langgraph_thread() -> str:
    try:
        async with httpx.AsyncClient(
            timeout=LANGGRAPH_THREAD_CREATE_TIMEOUT_SECONDS,
        ) as client:
            response = await client.post(
                f"{_get_langgraph_base_url()}/threads",
                json={},
            )
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=503,
            detail="LangGraph timed out while creating the session thread.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="LangGraph is unavailable for session start.",
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"LangGraph thread creation failed with HTTP {exc.response.status_code}.",
        ) from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="LangGraph thread creation returned invalid JSON.",
        ) from exc

    if not isinstance(payload, dict) or not isinstance(payload.get("thread_id"), str):
        raise HTTPException(
            status_code=502,
            detail="LangGraph thread creation returned no thread_id.",
        )

    return payload["thread_id"]

@router.post("/start", response_model=SessionStartResponse)
async def start_session(body: SessionStartRequest) -> SessionStartResponse:
    """Create a new session (dev stub)."""
    now = datetime.now(UTC).isoformat()
    session_id = str(uuid.uuid4())
    thread_id = await _create_langgraph_thread()
    message_id = str(uuid.uuid4())
    return SessionStartResponse(
        session_id=session_id,
        thread_id=thread_id,
        greeting_message="I'm here with you. What's on your mind?",
        message_id=message_id,
        memory_highlights=[],
        is_resumed=False,
        briefing_source="fallback",
        has_memory=False,
        session_type=body.session_type,
        preset_context=body.preset_context,
        started_at=now,
    )


@router.get("/active", response_model=ActiveSessionResponse)
async def get_active_session() -> ActiveSessionResponse:
    """Check for an active session (dev stub — always returns none)."""
    return ActiveSessionResponse(has_active_session=False, session=None)


@router.post("/end", response_model=SessionEndResponse)
async def end_session(body: SessionEndRequest) -> SessionEndResponse:
    """End a session (dev stub)."""
    now = datetime.now(UTC).isoformat()
    return SessionEndResponse(
        session_id=body.session_id,
        ended_at=now,
        duration_minutes=0,
        turn_count=0,
        recap_artifacts=None,
        offer_debrief=False,
        debrief_prompt=None,
    )
