"""Sophia session management — multi-session persistence.

Real CRUD for /api/v1/sessions/* endpoints backed by file-based SessionStore.
Creates LangGraph threads and persists session records.
"""

import os
import re
import uuid
from datetime import UTC, datetime
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from deerflow.sophia.session_store import SessionRecord, SessionStore

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])

LANGGRAPH_THREAD_CREATE_TIMEOUT_SECONDS = 5.0
MAX_OPEN_SESSIONS_PER_USER = 15

# Singleton store — base path resolved relative to cwd (repo root).
_store = SessionStore()
_LEGACY_USER_ID = "dev-user"


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SessionStartRequest(BaseModel):
    user_id: str = "dev-user"
    session_type: str = "open"
    preset_context: str = "life"
    platform: str = "text"
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


class SessionInfoResponse(BaseModel):
    session_id: str
    thread_id: str
    session_type: str
    preset_context: str
    status: str
    started_at: str
    updated_at: str
    ended_at: str | None = None
    turn_count: int
    title: str | None = None
    last_message_preview: str | None = None
    platform: str = "text"
    intention: str | None = None
    focus_cue: str | None = None


class ActiveSessionResponse(BaseModel):
    has_active_session: bool
    session: SessionInfoResponse | None = None


class OpenSessionsResponse(BaseModel):
    sessions: list[SessionInfoResponse]
    count: int


class SessionListResponse(BaseModel):
    sessions: list[SessionInfoResponse]
    total: int


class SessionEndRequest(BaseModel):
    session_id: str
    user_id: str = "dev-user"
    offer_debrief: bool = False


class SessionEndResponse(BaseModel):
    session_id: str
    ended_at: str
    duration_minutes: int
    turn_count: int
    recap_artifacts: dict | None = None
    offer_debrief: bool
    debrief_prompt: str | None = None


class SessionUpdateRequest(BaseModel):
    title: str | None = None
    status: Literal["open", "paused"] | None = None


class SessionContinueRequest(BaseModel):
    user_id: str = "dev-user"
    session_type: str | None = None
    preset_context: str | None = None
    platform: str | None = None
    intention: str | None = None
    focus_cue: str | None = None


class SessionContinueResponse(BaseModel):
    continued_from_session_id: str
    session: SessionInfoResponse


class SessionDeleteResponse(BaseModel):
    ok: bool = True
    session_id: str


class SessionBulkDeleteResponse(BaseModel):
    ok: bool = True
    deleted_count: int
    session_ids: list[str]


_REQUEST_PREFIX_PATTERNS = (
    re.compile(r".*?\b(?:can|could|would)\s+you\s+help\s+me\s+(?:with|on|about)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:can|could|would)\s+you\s+help\s+me\s+to\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:can|could|would)\s+you\s+help\s+me\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:please\s+)?help\s+me\s+(?:with|on|about)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:please\s+)?help\s+me\s+to\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:please\s+)?help\s+me\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i\s+need|need)\s+(?:some\s+)?help\s+(?:with|on|about)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i\s+need|need)\s+(?:some\s+)?help\s+to\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i\s+need|need)\s+(?:some\s+)?help\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i\s+need|we\s+need|i\s+want|i(?:'m|\s+am)\s+trying)\s+to\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:how\s+do\s+i|how\s+can\s+i|can\s+i|could\s+i|should\s+i)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:what(?:'s|\s+is)\s+the\s+best\s+way\s+to)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i\s+need\s+advice|need\s+advice|advice)\s+(?:on|about)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i(?:'m|\s+am)\s+struggling\s+with)\s+", re.IGNORECASE),
    re.compile(r".*?\b(?:i(?:'m|\s+am)\s+dealing\s+with)\s+", re.IGNORECASE),
)

_GERUND_OVERRIDES = {
    "be": "being",
    "build": "building",
    "choose": "choosing",
    "cope": "coping",
    "create": "creating",
    "debug": "debugging",
    "deal": "dealing",
    "decide": "deciding",
    "explore": "exploring",
    "figure": "figuring",
    "find": "finding",
    "fix": "fixing",
    "focus": "focusing",
    "get": "getting",
    "handle": "handling",
    "have": "having",
    "improve": "improving",
    "make": "making",
    "manage": "managing",
    "navigate": "navigating",
    "negotiate": "negotiating",
    "organize": "organizing",
    "plan": "planning",
    "prepare": "preparing",
    "prioritize": "prioritizing",
    "process": "processing",
    "put": "putting",
    "quit": "quitting",
    "recover": "recovering",
    "reflect": "reflecting",
    "repair": "repairing",
    "reset": "resetting",
    "review": "reviewing",
    "set": "setting",
    "sort": "sorting",
    "start": "starting",
    "stop": "stopping",
    "talk": "talking",
    "understand": "understanding",
    "update": "updating",
    "write": "writing",
}


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


def _normalize_user_id(user_id: str | None) -> str:
    normalized = (user_id or "").strip()
    return normalized or _LEGACY_USER_ID


def _legacy_user_id_for(user_id: str) -> str | None:
    return None if user_id == _LEGACY_USER_ID else _LEGACY_USER_ID


def _unique_records(records: list[SessionRecord]) -> list[SessionRecord]:
    deduped: dict[str, SessionRecord] = {}
    for record in records:
        deduped[record.session_id] = record
    return sorted(deduped.values(), key=lambda record: record.updated_at, reverse=True)


def _list_open_records(user_id: str) -> list[SessionRecord]:
    records = list(_store.list_open(user_id))
    if records:
        return _unique_records(records)

    legacy_user_id = _legacy_user_id_for(user_id)
    if legacy_user_id:
        records.extend(_store.list_open(legacy_user_id))
    return _unique_records(records)


def _list_recent_records(user_id: str, limit: int) -> list[SessionRecord]:
    records = list(_store.list_recent(user_id, limit=limit))
    if records:
        return _unique_records(records)[:limit]

    legacy_user_id = _legacy_user_id_for(user_id)
    if legacy_user_id:
        records.extend(_store.list_recent(legacy_user_id, limit=limit))
    return _unique_records(records)[:limit]


def _resolve_session_record(user_id: str, session_id: str) -> tuple[str, SessionRecord | None]:
    record = _store.get(user_id, session_id)
    if record is not None:
        return user_id, record

    legacy_user_id = _legacy_user_id_for(user_id)
    if legacy_user_id is None:
        return user_id, None

    legacy_record = _store.get(legacy_user_id, session_id)
    if legacy_record is not None:
        return legacy_user_id, legacy_record

    return user_id, None

@router.post("/start", response_model=SessionStartResponse)
async def start_session(body: SessionStartRequest) -> SessionStartResponse:
    """Create a new session with a real LangGraph thread and persist it."""
    user_id = _normalize_user_id(body.user_id)
    # Enforce resumable-session limit
    open_sessions = _store.list_open(user_id)
    if len(open_sessions) >= MAX_OPEN_SESSIONS_PER_USER:
        raise HTTPException(
            status_code=409,
            detail=f"Maximum of {MAX_OPEN_SESSIONS_PER_USER} open sessions reached. "
            "Please end an existing session first.",
        )

    now = datetime.now(UTC).isoformat()
    session_id = str(uuid.uuid4())
    thread_id = await _create_langgraph_thread()
    message_id = str(uuid.uuid4())

    # Persist the session record
    record = SessionRecord(
        session_id=session_id,
        thread_id=thread_id,
        user_id=user_id,
        status="open",
        preset_type=body.session_type,
        context_mode=body.preset_context,
        platform=body.platform,
        intention=body.intention,
        focus_cue=body.focus_cue,
        created_at=now,
        updated_at=now,
    )
    _store.create(record)

    from app.gateway.inactivity_watcher import register_activity

    register_activity(thread_id, user_id, session_id, body.preset_context)

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
async def get_active_session(
    user_id: str = Query(default="dev-user"),
) -> ActiveSessionResponse:
    """Return the most recently updated resumable session for compatibility callers."""
    records = _list_open_records(_normalize_user_id(user_id))
    if not records:
        return ActiveSessionResponse(has_active_session=False, session=None)
    return ActiveSessionResponse(
        has_active_session=True,
        session=_record_to_info(records[0]),
    )


@router.get("/open", response_model=OpenSessionsResponse)
async def get_open_sessions(
    user_id: str = Query(default="dev-user"),
) -> OpenSessionsResponse:
    """Return all resumable sessions for a user."""
    records = _list_open_records(_normalize_user_id(user_id))
    sessions = [_record_to_info(r) for r in records]
    return OpenSessionsResponse(sessions=sessions, count=len(sessions))


@router.get("/list", response_model=SessionListResponse)
async def list_sessions(
    user_id: str = Query(default="dev-user"),
    limit: int = Query(default=30, ge=1, le=100),
    status: str | None = Query(default=None),
) -> SessionListResponse:
    """Return recent sessions (all statuses) or filter by status."""
    records = _list_recent_records(_normalize_user_id(user_id), limit=limit)
    if status:
        records = [r for r in records if r.status == status]
    sessions = [_record_to_info(r) for r in records]
    return SessionListResponse(sessions=sessions, total=len(sessions))


@router.get("/{session_id}", response_model=SessionInfoResponse)
async def get_session(
    session_id: str,
    user_id: str = Query(default="dev-user"),
) -> SessionInfoResponse:
    """Get a single session by ID."""
    _, record = _resolve_session_record(_normalize_user_id(user_id), session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return _record_to_info(record)


@router.patch("/{session_id}", response_model=SessionInfoResponse)
async def update_session(
    session_id: str,
    body: SessionUpdateRequest,
    user_id: str = Query(default="dev-user"),
) -> SessionInfoResponse:
    """Update session metadata or resumable status."""
    normalized_user_id = _normalize_user_id(user_id)
    updates = body.model_dump(exclude_none=True)
    requested_status = updates.pop("status", None)

    owner_user_id, record = _resolve_session_record(normalized_user_id, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    if not updates:
        if requested_status is None:
            return _record_to_info(record)

    # Allow reopening ended sessions: users can continue any prior conversation.
    # The same thread_id is preserved so the transcript and memory context stay
    # intact. When the session is ended again later, the offline pipeline will
    # re-run against only the newly added turns (existing memories are passed
    # into the extraction prompt for dedupe).
    reopening_ended = requested_status == "open" and record.status == "ended"

    if (
        requested_status is not None
        and record.status == "ended"
        and not reopening_ended
    ):
        raise HTTPException(status_code=409, detail="Ended sessions cannot change status.")

    if updates:
        record = _store.update(owner_user_id, session_id, **updates)
        if record is None:
            raise HTTPException(status_code=404, detail="Session not found.")

    if requested_status == "paused":
        from app.gateway.inactivity_watcher import unregister_thread

        record = _store.pause(owner_user_id, session_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Session not found.")
        unregister_thread(record.thread_id)
    elif requested_status == "open":
        from app.gateway.inactivity_watcher import register_activity

        record = _store.resume(owner_user_id, session_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Session not found.")
        register_activity(
            record.thread_id,
            owner_user_id,
            record.session_id,
            record.context_mode,
        )

        if reopening_ended:
            # Clear the idempotency marker so the offline pipeline can re-run
            # at the next session end with the newly added turns.
            try:
                from deerflow.sophia.offline_pipeline import forget_processed_session

                forget_processed_session(session_id)
            except Exception:
                # Non-fatal: dedupe via existing_memories still protects Mem0.
                pass

    return _record_to_info(record)


@router.post("/{session_id}/continue", response_model=SessionContinueResponse)
async def continue_session(
    session_id: str,
    body: SessionContinueRequest,
) -> SessionContinueResponse:
    """Start a new resumable session segment from an ended session.

    This creates a new session_id while preserving the original thread_id,
    which keeps the full transcript continuous and avoids reprocessing
    offline pipeline artifacts for the already-ended segment.
    """
    normalized_user_id = _normalize_user_id(body.user_id)
    source_owner_user_id, source_record = _resolve_session_record(normalized_user_id, session_id)
    if source_record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    if source_record.status != "ended":
        raise HTTPException(status_code=409, detail="Only ended sessions can be continued.")

    open_records = list(_list_open_records(normalized_user_id))
    if source_owner_user_id != normalized_user_id:
        open_records.extend(_store.list_open(source_owner_user_id))
    open_records = _unique_records(open_records)

    if any(record.thread_id == source_record.thread_id for record in open_records):
        raise HTTPException(
            status_code=409,
            detail="This thread already has an active session. Resume the active one instead.",
        )

    if len(open_records) >= MAX_OPEN_SESSIONS_PER_USER:
        raise HTTPException(
            status_code=409,
            detail=f"Maximum of {MAX_OPEN_SESSIONS_PER_USER} open sessions reached. "
            "Please end an existing session first.",
        )

    now = datetime.now(UTC).isoformat()
    new_session_id = str(uuid.uuid4())
    session_type = body.session_type or source_record.preset_type
    preset_context = body.preset_context or source_record.context_mode
    platform = body.platform or source_record.platform

    continued_record = SessionRecord(
        session_id=new_session_id,
        thread_id=source_record.thread_id,
        user_id=normalized_user_id,
        status="open",
        preset_type=session_type,
        context_mode=preset_context,
        platform=platform,
        intention=body.intention if body.intention is not None else source_record.intention,
        focus_cue=body.focus_cue if body.focus_cue is not None else source_record.focus_cue,
        created_at=now,
        updated_at=now,
    )
    _store.create(continued_record)

    from app.gateway.inactivity_watcher import register_activity

    register_activity(
        continued_record.thread_id,
        normalized_user_id,
        continued_record.session_id,
        continued_record.context_mode,
    )

    return SessionContinueResponse(
        continued_from_session_id=session_id,
        session=_record_to_info(continued_record),
    )


@router.delete("/bulk", response_model=SessionBulkDeleteResponse)
async def delete_all_sessions(
    user_id: str = Query(default="dev-user"),
) -> SessionBulkDeleteResponse:
    """Delete all persisted session records for the resolved user."""
    normalized_user_id = _normalize_user_id(user_id)
    deleted_records = _store.delete_all(normalized_user_id)

    if not deleted_records:
        legacy_user_id = _legacy_user_id_for(normalized_user_id)
        if legacy_user_id is not None:
            deleted_records = _store.delete_all(legacy_user_id)

    if deleted_records:
        from app.gateway.inactivity_watcher import unregister_thread

        for record in deleted_records:
            unregister_thread(record.thread_id)

    return SessionBulkDeleteResponse(
        ok=True,
        deleted_count=len(deleted_records),
        session_ids=[record.session_id for record in deleted_records],
    )


@router.delete("/{session_id}", response_model=SessionDeleteResponse)
async def delete_session(
    session_id: str,
    user_id: str = Query(default="dev-user"),
) -> SessionDeleteResponse:
    """Delete a persisted session record."""
    normalized_user_id = _normalize_user_id(user_id)
    owner_user_id, _ = _resolve_session_record(normalized_user_id, session_id)
    deleted = _store.delete(owner_user_id, session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found.")
    return SessionDeleteResponse(ok=True, session_id=session_id)


@router.post("/end", response_model=SessionEndResponse)
async def end_session(body: SessionEndRequest) -> SessionEndResponse:
    """End a session — marks it as ended and computes duration."""
    normalized_user_id = _normalize_user_id(body.user_id)
    owner_user_id, _ = _resolve_session_record(normalized_user_id, body.session_id)
    record = _store.end(owner_user_id, body.session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    from app.gateway.inactivity_watcher import unregister_thread

    unregister_thread(record.thread_id)

    # Compute duration
    duration_minutes = 0
    if record.created_at and record.ended_at:
        try:
            start = datetime.fromisoformat(record.created_at)
            end = datetime.fromisoformat(record.ended_at)
            duration_minutes = max(0, int((end - start).total_seconds() / 60))
        except (ValueError, TypeError):
            pass

    return SessionEndResponse(
        session_id=record.session_id,
        ended_at=record.ended_at or datetime.now(UTC).isoformat(),
        duration_minutes=duration_minutes,
        turn_count=record.message_count,
        recap_artifacts=None,
        offer_debrief=body.offer_debrief,
        debrief_prompt=None,
    )


class SessionMessageResponse(BaseModel):
    id: str
    role: str  # "user" | "sophia"
    content: str
    created_at: str | None = None


class SessionMessagesResponse(BaseModel):
    session_id: str
    thread_id: str
    messages: list[SessionMessageResponse]


@router.get("/{session_id}/messages", response_model=SessionMessagesResponse)
async def get_session_messages(
    session_id: str,
    user_id: str = Query(default="dev-user"),
) -> SessionMessagesResponse:
    """Retrieve conversation history from the LangGraph thread state."""
    _, record = _resolve_session_record(_normalize_user_id(user_id), session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    thread_id = record.thread_id
    base_url = _get_langgraph_base_url()

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url}/threads/{thread_id}/state")
            resp.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=503,
            detail="LangGraph timed out while reading thread state.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail="LangGraph is unavailable.",
        ) from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            # Thread exists but has no checkpoint yet (no messages sent)
            return SessionMessagesResponse(
                session_id=session_id,
                thread_id=thread_id,
                messages=[],
            )
        raise HTTPException(
            status_code=502,
            detail=f"LangGraph returned HTTP {exc.response.status_code}.",
        ) from exc

    try:
        state = resp.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="LangGraph returned invalid JSON.",
        ) from exc

    raw_messages = state.get("values", {}).get("messages", [])
    messages: list[SessionMessageResponse] = []
    for msg in raw_messages:
        if isinstance(msg, dict):
            msg_type = msg.get("type", "")
            content = msg.get("content", "")
            msg_id = msg.get("id", "")
            # Map LangGraph message types to frontend roles
            if msg_type == "human":
                role = "user"
            elif msg_type == "ai":
                role = "sophia"
            else:
                continue  # skip system/tool messages
            content_text = _extract_visible_message_text(content)
            # Skip empty AI messages (tool-only turns)
            if role == "sophia" and not content_text:
                continue
            if role == "user" and not content_text:
                continue
            messages.append(SessionMessageResponse(
                id=msg_id,
                role=role,
                content=content_text,
                created_at=None,
            ))

    return SessionMessagesResponse(
        session_id=session_id,
        thread_id=thread_id,
        messages=messages,
    )


@router.post("/{session_id}/touch", response_model=SessionInfoResponse)
async def touch_session(
    session_id: str,
    user_id: str = Query(default="dev-user"),
    message_preview: str | None = Query(default=None, max_length=200),
) -> SessionInfoResponse:
    """Increment message count and update last_message_preview.

    Called by the chat handler after each user message.
    """
    normalized_user_id = _normalize_user_id(user_id)
    owner_user_id, record = _resolve_session_record(normalized_user_id, session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    updates: dict = {"message_count": record.message_count + 1}
    if record.status == "paused":
        updates["status"] = "open"
        updates["ended_at"] = None
    normalized_preview = _normalize_message_preview(message_preview)
    if normalized_preview:
        updates["last_message_preview"] = normalized_preview
        if not record.title or record.title.strip().lower() == "new session":
            updates["title"] = _build_session_title(normalized_preview)
    updated_record = _store.update(owner_user_id, session_id, **updates)
    if updated_record is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    from app.gateway.inactivity_watcher import register_activity

    register_activity(
        updated_record.thread_id,
        owner_user_id,
        updated_record.session_id,
        updated_record.context_mode,
    )
    return _record_to_info(updated_record)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _record_to_info(record: SessionRecord) -> SessionInfoResponse:
    return SessionInfoResponse(
        session_id=record.session_id,
        thread_id=record.thread_id,
        session_type=record.preset_type,
        preset_context=record.context_mode,
        status=record.status,
        started_at=record.created_at,
        updated_at=record.updated_at,
        ended_at=record.ended_at,
        turn_count=record.message_count,
        title=record.title,
        last_message_preview=record.last_message_preview,
        platform=record.platform,
        intention=record.intention,
        focus_cue=record.focus_cue,
    )


def _normalize_message_preview(message_preview: str | None) -> str | None:
    if not message_preview:
        return None
    normalized = " ".join(message_preview.split()).strip()
    if not normalized:
        return None
    return normalized[:200]


def _extract_visible_message_text(content: object) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, dict):
        if content.get("type") != "text":
            return ""
        text = content.get("text")
        return text if isinstance(text, str) else ""

    if isinstance(content, list):
        parts = [_extract_visible_message_text(block) for block in content]
        visible_parts = [part for part in parts if part]
        return "\n".join(visible_parts)

    return ""


def _build_session_title(message_preview: str) -> str:
    normalized = _normalize_message_preview(message_preview)
    if not normalized:
        return "New session"

    title = _extract_title_candidate(normalized)
    title = _promote_to_topic_phrase(title)
    title = title.strip(" \t\n\r\"'.,!?;:-") or "New session"
    if len(title) > 60:
        title = title[:60].rsplit(" ", 1)[0] or title[:60]
    return title[:1].upper() + title[1:]


def _extract_title_candidate(message_preview: str) -> str:
    candidate = re.split(r"[\n.!?;]+", message_preview, maxsplit=1)[0].strip()
    if len(candidate) > 90 and "," in candidate:
        candidate = candidate.split(",", 1)[0].strip()

    for pattern in _REQUEST_PREFIX_PATTERNS:
        match = pattern.search(candidate)
        if match and match.end() < len(candidate):
            candidate = candidate[match.end():].strip()
            break

    candidate = re.sub(r"^(?:to|about)\s+", "", candidate, flags=re.IGNORECASE)
    candidate = re.sub(r"\b(?:please|thanks|thank you)\b[.!?]*$", "", candidate, flags=re.IGNORECASE)

    if len(candidate.split()) > 10:
        candidate = re.split(r"\b(?:because|since|but)\b", candidate, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    if len(candidate.split()) > 10:
        candidate = re.split(r"\band\b", candidate, maxsplit=1, flags=re.IGNORECASE)[0].strip()

    return candidate or message_preview


def _promote_to_topic_phrase(candidate: str) -> str:
    text = candidate.strip(" \t\n\r\"'")
    text = re.sub(r"^how\s+to\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:a|an|the)\s+(?=[a-z])", "", text, flags=re.IGNORECASE)
    words = text.split()
    if not words:
        return "New session"

    first_word = words[0]
    first_key = re.sub(r"[^a-z]", "", first_word.lower())
    if first_key.endswith("ing"):
        return " ".join(words)
    if first_key in _GERUND_OVERRIDES:
        words[0] = _GERUND_OVERRIDES[first_key]
    return " ".join(words)
