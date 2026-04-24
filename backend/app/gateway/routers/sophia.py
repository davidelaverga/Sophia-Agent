"""Sophia API router for memory management, reflect, journal, visual artifacts, and session control."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.channels.telegram_linking import (
    DEFAULT_LINK_TOKEN_TTL_SECONDS,
    get_telegram_link_store,
)
from app.gateway.auth import require_authorized_user_scope
from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path
from deerflow.sophia.review_metadata_store import (
    apply_review_metadata_overlays,
    remove_review_metadata,
    upsert_review_metadata,
)
from deerflow.sophia.session_store import SessionRecord, SessionStore

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/sophia",
    tags=["sophia"],
    dependencies=[Depends(require_authorized_user_scope)],
)

# Strong references to background tasks to prevent GC cancellation
_background_tasks: set = set()
_session_store = SessionStore()
_LEGACY_SESSION_USER_ID = "dev-user"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _validate_user(user_id: str) -> str:
    """Validate user_id and return it, or raise 400."""
    try:
        from deerflow.agents.sophia_agent.utils import validate_user_id
        return validate_user_id(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user_id format")


def _serialize_optional_datetime(value: object) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def _task_status_value(value: object) -> str:
    status_value = getattr(value, "value", value)
    return str(status_value).strip().lower()


def _get_mem0_client():
    """Get Mem0 MemoryClient or raise 503."""
    try:
        from mem0 import MemoryClient
        api_key = os.environ.get("MEM0_API_KEY")
        if not api_key:
            raise HTTPException(status_code=503, detail="MEM0_API_KEY not configured")
        return MemoryClient(api_key=api_key)
    except ImportError:
        raise HTTPException(status_code=503, detail="mem0 package not installed")


def _resolve_session_record_owner(user_id: str, session_id: str) -> tuple[str, SessionRecord | None]:
    """Resolve the persisted session owner, including the legacy dev-user fallback."""
    record = _session_store.get(user_id, session_id)
    if record is not None:
        return user_id, record

    if user_id == _LEGACY_SESSION_USER_ID:
        return user_id, None

    legacy_record = _session_store.get(_LEGACY_SESSION_USER_ID, session_id)
    if legacy_record is not None:
        return _LEGACY_SESSION_USER_ID, legacy_record

    return user_id, None


# ---------------------------------------------------------------------------
# Response Models
# ---------------------------------------------------------------------------

class MemoryItem(BaseModel):
    id: str = Field(..., description="Memory ID")
    content: str = Field(default="", description="Memory content text")
    category: str | None = Field(default=None, description="Memory category")
    session_id: str | None = Field(default=None, description="Source session identifier")
    metadata: dict | None = Field(default=None, description="Memory metadata")
    created_at: str | None = Field(default=None, description="Creation timestamp")
    updated_at: str | None = Field(default=None, description="Last update timestamp")


class MemoryListResponse(BaseModel):
    memories: list[MemoryItem] = Field(default_factory=list)
    count: int = Field(default=0, description="Total memory count")


class MemoryUpdateRequest(BaseModel):
    text: str | None = Field(default=None, description="Updated memory text")
    metadata: dict | None = Field(default=None, description="Updated metadata")


class MemoryCreateRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Memory content text")
    category: str | None = Field(default=None, description="Optional memory category")
    metadata: dict | None = Field(default=None, description="Optional memory metadata")


class BulkReviewItem(BaseModel):
    id: str = Field(..., description="Memory ID")
    action: Literal["approve", "discard"] = Field(..., description="Action to take")


class BulkReviewRequest(BaseModel):
    items: list[BulkReviewItem] = Field(..., description="List of review actions")


class BulkReviewResult(BaseModel):
    id: str
    action: str
    status: str = "ok"
    error: str | None = None


class BulkReviewResponse(BaseModel):
    results: list[BulkReviewResult] = Field(default_factory=list)


class ReflectRequest(BaseModel):
    query: str = Field(..., description="What to reflect on")
    period: Literal["this_week", "this_month", "overall"] = Field(..., description="Time period")


class ReflectResponse(BaseModel):
    voice_context: str = Field(default="", description="Text for Sophia to read aloud")
    visual_parts: list[dict] = Field(default_factory=list, description="Structured visual data")


class JournalEntry(BaseModel):
    id: str = Field(..., description="Memory ID")
    content: str = Field(default="", description="Memory content")
    category: str | None = Field(default=None)
    metadata: dict | None = Field(default=None)
    created_at: str | None = Field(default=None)


class JournalResponse(BaseModel):
    entries: list[JournalEntry] = Field(default_factory=list)
    count: int = Field(default=0)


def _sort_memories_desc(memories: list[dict]) -> list[dict]:
    def sort_key(memory: dict) -> tuple[int, str]:
        created_at = memory.get("created_at")
        if isinstance(created_at, str):
            return (1, created_at)
        return (0, "")

    return sorted(memories, key=sort_key, reverse=True)


def _memory_timestamp(memory: dict) -> str:
    updated_at = memory.get("updated_at") if isinstance(memory, dict) else None
    if isinstance(updated_at, str) and updated_at:
        return updated_at

    created_at = memory.get("created_at") if isinstance(memory, dict) else None
    if isinstance(created_at, str) and created_at:
        return created_at

    return ""


def _dedupe_memories_by_id(memories: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    index_by_id: dict[str, int] = {}

    for memory in memories:
        if not isinstance(memory, dict):
            deduped.append(memory)
            continue

        memory_id = memory.get("id")
        if not isinstance(memory_id, str) or not memory_id:
            deduped.append(memory)
            continue

        existing_index = index_by_id.get(memory_id)
        if existing_index is None:
            index_by_id[memory_id] = len(deduped)
            deduped.append(memory)
            continue

        if _memory_timestamp(memory) >= _memory_timestamp(deduped[existing_index]):
            deduped[existing_index] = memory

    return deduped


class ToneDataPoint(BaseModel):
    date: str = Field(..., description="Date (YYYY-MM-DD)")
    avg_tone: float = Field(default=0.0, description="Average tone estimate")
    turn_count: int = Field(default=0, description="Number of turns with tone data")


class WeeklyVisualResponse(BaseModel):
    data_points: list[ToneDataPoint] = Field(default_factory=list)


class CategoryMemoryResponse(BaseModel):
    memories: list[MemoryItem] = Field(default_factory=list)
    count: int = Field(default=0)


class SessionMessageInput(BaseModel):
    role: str = Field(..., description="Message role")
    content: str = Field(default="", description="Message text content")
    created_at: str | None = Field(default=None, description="Client timestamp")


class SessionRecapArtifactsPayload(BaseModel):
    takeaway: str | None = Field(default=None)
    session_takeaway: str | None = Field(default=None)
    reflection_candidate: dict | None = Field(default=None)
    reflection: dict | None = Field(default=None)
    memory_candidates: list[dict] | None = Field(default=None)
    memories_created: int | None = Field(default=None)
    status: str | None = Field(default=None)


class SessionRecapResponse(BaseModel):
    session_id: str = Field(..., description="Session identifier")
    thread_id: str | None = Field(default=None, description="LangGraph thread ID")
    session_type: str | None = Field(default=None)
    context_mode: str | None = Field(default=None)
    started_at: str | None = Field(default=None)
    ended_at: str | None = Field(default=None)
    turn_count: int = Field(default=0)
    status: str = Field(default="processing")
    recap_artifacts: dict | None = Field(default=None)


class SessionEndRequest(BaseModel):
    session_id: str = Field(..., description="Session ID to process")
    thread_id: str = Field(..., description="LangGraph thread ID")
    offer_debrief: bool = Field(default=False, description="Whether UI should offer debrief")
    session_type: str | None = Field(default=None)
    context_mode: str | None = Field(default=None)
    started_at: str | None = Field(default=None)
    ended_at: str | None = Field(default=None)
    turn_count: int | None = Field(default=None)
    platform: str | None = Field(default=None)
    messages: list[SessionMessageInput] = Field(default_factory=list)
    recap_artifacts: SessionRecapArtifactsPayload | None = Field(default=None)


class SessionEndResponse(BaseModel):
    status: str = Field(default="pipeline_queued")
    session_id: str = Field(default="")
    ended_at: str | None = Field(default=None)
    duration_minutes: int = Field(default=0)
    turn_count: int = Field(default=0)
    recap_artifacts: dict | None = Field(default=None)
    offer_debrief: bool = Field(default=False)
    debrief_prompt: str | None = Field(default=None)


def _get_langgraph_base_url() -> str:
    return (
        os.getenv("SOPHIA_LANGGRAPH_BASE_URL")
        or os.getenv("SOPHIA_BACKEND_BASE_URL")
        or "http://127.0.0.1:2024"
    ).strip().rstrip("/")


async def _fetch_langgraph_thread_state(thread_id: str) -> dict[str, Any]:
    """Fetch the current thread state from LangGraph REST API."""
    base_url = _get_langgraph_base_url()
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{base_url}/threads/{thread_id}/state")
        resp.raise_for_status()
        return resp.json()


def _hydrate_builder_delivery(thread_id: str, builder_result: dict[str, Any] | None) -> dict[str, Any] | None:
    """Build a builder_delivery payload from a builder_result so the frontend can display the artifact inline."""
    if not builder_result or not isinstance(builder_result, dict):
        return None
    try:
        from deerflow.sophia.tools.builder_delivery import build_builder_delivery_payload
        return build_builder_delivery_payload(
            thread_id=thread_id,
            builder_result=builder_result,
        )
    except Exception:
        logger.warning(
            "Failed to hydrate builder_delivery for thread_id=%s",
            thread_id,
            exc_info=True,
        )
        return None


class TelegramLinkCreateRequest(BaseModel):
    context_mode: Literal["work", "gaming", "life"] = Field(
        default="life",
        description="Default Sophia context mode to apply on Telegram runs.",
    )
    ttl_seconds: int = Field(
        default=DEFAULT_LINK_TOKEN_TTL_SECONDS,
        ge=60,
        le=86400,
        description="One-time Telegram link token TTL in seconds.",
    )


class TelegramLinkCreateResponse(BaseModel):
    linked: bool = Field(default=False)
    token: str = Field(..., description="One-time token used in Telegram deep-linking.")
    deep_link: str | None = Field(default=None)
    expires_at: str
    context_mode: str = Field(default="life")


class TelegramLinkStatusResponse(BaseModel):
    linked: bool = Field(default=False)
    user_id: str
    telegram_chat_id: str | None = None
    telegram_user_id: str | None = None
    telegram_username: str | None = None
    context_mode: str | None = None
    linked_at: str | None = None
    last_seen_at: str | None = None


class TelegramLinkRemoveResponse(BaseModel):
    linked: bool = Field(default=False)
    removed: bool = Field(default=False)


class TaskCancelResponse(BaseModel):
    task_id: str = Field(..., description="Background task identifier")
    status: str = Field(..., description="Cancellation status")
    detail: str | None = Field(default=None, description="Optional status detail")


class TaskStatusDebug(BaseModel):
    last_tool_names: list[str] = Field(default_factory=list)
    last_has_emit_builder_artifact: bool | None = Field(default=None)
    late_tool_names: list[str] = Field(default_factory=list)
    late_has_emit_builder_artifact: bool | None = Field(default=None)
    timeout_observed_during_stream: bool = Field(default=False)
    timed_out_at: str | None = Field(default=None)
    final_state_present: bool = Field(default=False)
    builder_result_present: bool = Field(default=False)
    suspected_blocker: str | None = Field(default=None)
    suspected_blocker_detail: str | None = Field(default=None)
    last_shell_command: dict | None = Field(default=None)
    recent_shell_commands: list[dict] = Field(default_factory=list)


class TaskStatusResponse(BaseModel):
    task_id: str = Field(..., description="Background task identifier")
    status: str = Field(..., description="Current task status")
    trace_id: str | None = Field(default=None, description="Trace identifier for task diagnostics")
    description: str | None = Field(default=None, description="Optional task description")
    detail: str | None = Field(default=None, description="Human-readable status detail")
    result: str | None = Field(default=None, description="Terminal result summary")
    error: str | None = Field(default=None, description="Terminal error detail")
    builder_result: dict | None = Field(default=None, description="Normalized builder artifact payload when available")
    message_count: int = Field(default=0, description="Captured AI message count")
    started_at: str | None = Field(default=None)
    completed_at: str | None = Field(default=None)
    last_update_at: str | None = Field(default=None)
    last_progress_at: str | None = Field(default=None)
    heartbeat_ms: int | None = Field(default=None)
    idle_ms: int | None = Field(default=None)
    is_stuck: bool = Field(default=False)
    stuck_reason: str | None = Field(default=None)
    progress_percent: int | None = Field(default=None)
    progress_source: str | None = Field(default=None)
    total_steps: int | None = Field(default=None)
    completed_steps: int | None = Field(default=None)
    in_progress_steps: int | None = Field(default=None)
    pending_steps: int | None = Field(default=None)
    active_step_title: str | None = Field(default=None)
    todos: list[dict] = Field(default_factory=list)
    debug: TaskStatusDebug | None = Field(default=None, description="Latest executor-side diagnostics")
    activity_log: list[dict] = Field(default_factory=list, description="Chronological builder activity entries")
    builder_delivery: dict | None = Field(default=None, description="Inline artifact payload for channel delivery (populated when builder_result is available)")


# ---------------------------------------------------------------------------
# Helper: normalize Mem0 memory to MemoryItem
# ---------------------------------------------------------------------------

def _get_primary_category(mem: dict) -> str | None:
    categories = mem.get("categories") if isinstance(mem, dict) else None
    if isinstance(categories, list):
        for category in categories:
            if isinstance(category, str) and category:
                return category
        return None

    category = mem.get("category") if isinstance(mem, dict) else None
    return category if isinstance(category, str) and category else None

def _to_memory_item(mem: dict) -> MemoryItem:
    metadata = mem.get("metadata") if isinstance(mem, dict) else None
    return MemoryItem(
        id=mem.get("id", ""),
        content=mem.get("memory", mem.get("content", "")),
        category=_get_primary_category(mem),
        session_id=mem.get("session_id") or (metadata.get("session_id") if isinstance(metadata, dict) else None),
        metadata=metadata,
        created_at=mem.get("created_at"),
        updated_at=mem.get("updated_at"),
    )


def _get_telegram_bot_username() -> str | None:
    env_username = os.environ.get("TELEGRAM_BOT_USERNAME")
    if isinstance(env_username, str) and env_username.strip():
        return env_username.strip().lstrip("@")

    try:
        from deerflow.config.app_config import get_app_config

        app_config = get_app_config()
        extra = app_config.model_extra or {}
        channels = extra.get("channels", {})
        if isinstance(channels, dict):
            telegram_cfg = channels.get("telegram", {})
            if isinstance(telegram_cfg, dict):
                candidate = telegram_cfg.get("bot_username")
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip().lstrip("@")
    except Exception:
        logger.warning("Unable to resolve Telegram bot username from config", exc_info=True)
    return None


def _merge_memory_detail(summary: dict, detail: dict | None) -> dict:
    if not isinstance(summary, dict):
        return detail or {}
    if not isinstance(detail, dict):
        return summary

    merged = dict(summary)
    merged.update(detail)

    if merged.get("metadata") is None and detail.get("metadata") is not None:
        merged["metadata"] = detail.get("metadata")

    if not merged.get("categories") and detail.get("categories"):
        merged["categories"] = detail.get("categories")

    if merged.get("category") is None and detail.get("category") is not None:
        merged["category"] = detail.get("category")

    return merged


def _should_hydrate_memory_detail(mem: dict) -> bool:
    return isinstance(mem, dict) and (
        mem.get("metadata") is None
        or (not mem.get("categories") and mem.get("category") is None)
    )


def _has_memory_status(mem: dict) -> bool:
    metadata = mem.get("metadata") if isinstance(mem, dict) else None
    return isinstance(metadata, dict) and isinstance(metadata.get("status"), str)


def _hydrate_memories_for_review(user_id: str, client, memories: list[dict], status: str | None) -> list[dict]:
    memories = apply_review_metadata_overlays(user_id, memories)
    hydrated: list[dict] = []

    for memory in memories:
        merged_memory = memory
        memory_id = memory.get("id") if isinstance(memory, dict) else None
        has_status = status is not None and _has_memory_status(memory)

        needs_hydration = memory_id and (
            (status is not None and not has_status)
            or (_should_hydrate_memory_detail(memory) and not has_status)
        )

        if needs_hydration:
            try:
                merged_memory = _merge_memory_detail(memory, client.get(memory_id))
            except Exception:
                logger.warning("Failed to hydrate memory detail for %s", memory_id, exc_info=True)

        hydrated.append(merged_memory)

    hydrated = apply_review_metadata_overlays(user_id, hydrated)

    if not status:
        return hydrated

    return [
        memory
        for memory in hydrated
        if isinstance(memory.get("metadata"), dict) and memory["metadata"].get("status") == status
    ]


def _get_session_recap_path(user_id: str, session_id: str) -> Path:
    return safe_user_path(USERS_DIR, user_id, "recaps", f"{session_id}.json")


def _read_session_recap(user_id: str, session_id: str) -> dict | None:
    recap_path = _get_session_recap_path(user_id, session_id)
    if not recap_path.exists():
        return None
    return json.loads(recap_path.read_text(encoding="utf-8"))


def _write_session_recap(user_id: str, session_id: str, payload: dict) -> None:
    recap_path = _get_session_recap_path(user_id, session_id)
    recap_path.parent.mkdir(parents=True, exist_ok=True)
    recap_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed
    except ValueError:
        return None


def _local_content_hash_from_memory_id(memory_id: str) -> str | None:
    if isinstance(memory_id, str) and memory_id.startswith("local:"):
        return memory_id.split(":", 1)[1] or None
    return None


def _compute_duration_minutes(started_at: str | None, ended_at: str | None) -> int:
    start_dt = _parse_iso_datetime(started_at)
    end_dt = _parse_iso_datetime(ended_at)
    if start_dt is None or end_dt is None:
        return 0
    return max(0, int((end_dt - start_dt).total_seconds() // 60))


def _build_session_recap_payload(body: SessionEndRequest, ended_at: str) -> dict:
    recap_artifacts = body.recap_artifacts.model_dump(exclude_none=True) if body.recap_artifacts else None
    turn_count = body.turn_count if body.turn_count is not None else len(body.messages)
    return {
        "session_id": body.session_id,
        "thread_id": body.thread_id,
        "session_type": body.session_type,
        "context_mode": body.context_mode,
        "started_at": body.started_at,
        "ended_at": ended_at,
        "turn_count": turn_count,
        "status": "ready" if recap_artifacts else "processing",
        "recap_artifacts": recap_artifacts,
    }


def _build_thread_state_from_end_request(body: SessionEndRequest) -> dict | None:
    serialized_messages = [
        {
            "role": message.role,
            "content": message.content,
        }
        for message in body.messages
        if message.content.strip()
    ]
    recap_artifacts = body.recap_artifacts.model_dump(exclude_none=True) if body.recap_artifacts else None

    if not serialized_messages and not recap_artifacts:
        return None

    thread_state: dict = {
        "messages": serialized_messages,
        "platform": body.platform or "text",
        "context_mode": body.context_mode or "life",
        "configurable": {
            "platform": body.platform or "text",
            "context_mode": body.context_mode or "life",
        },
    }

    if recap_artifacts:
        thread_state["current_artifact"] = recap_artifacts
        thread_state["artifacts"] = [recap_artifacts]

    return thread_state


def _build_debrief_prompt(body: SessionEndRequest, recap_artifacts: dict | None, duration_minutes: int) -> str | None:
    if not body.offer_debrief or duration_minutes < 5:
        return None
    if body.session_type == "debrief":
        return None

    reflection = recap_artifacts.get("reflection_candidate") if isinstance(recap_artifacts, dict) else None
    if isinstance(reflection, dict) and isinstance(reflection.get("prompt"), str):
        return reflection["prompt"]

    takeaway = recap_artifacts.get("takeaway") if isinstance(recap_artifacts, dict) else None
    if isinstance(takeaway, str) and takeaway.strip():
        return f"Want to debrief this for a minute? {takeaway.strip()}"

    return "Want a quick debrief before you go?"


def _queue_offline_pipeline(user_id: str, session_id: str, thread_id: str, thread_state: dict | None) -> None:
    from deerflow.sophia.offline_pipeline import run_offline_pipeline

    logger.info(
        "session.finalization queue_pipeline user_id=%s session_id=%s thread_id=%s has_thread_state=%s message_count=%s artifact_count=%s",
        user_id,
        session_id,
        thread_id,
        thread_state is not None,
        len(thread_state.get("messages", [])) if isinstance(thread_state, dict) else 0,
        len(thread_state.get("artifacts", [])) if isinstance(thread_state, dict) and isinstance(thread_state.get("artifacts"), list) else 0,
    )

    task = asyncio.create_task(
        asyncio.to_thread(
            run_offline_pipeline,
            user_id,
            session_id,
            thread_id,
            thread_state,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# ---------------------------------------------------------------------------
# 1. Memory List
# ---------------------------------------------------------------------------

@router.get(
    "/{user_id}/memories/recent",
    response_model=MemoryListResponse,
    summary="List recent memories for review",
    description="Returns memories for a user, optionally filtered by status.",
)
async def list_memories(
    user_id: str,
    status: str | None = Query(default=None, description="Filter by status (e.g. pending_review)"),
) -> MemoryListResponse:
    _validate_user(user_id)
    client = _get_mem0_client()
    try:
        logger.info(
            "session.finalization list_memories_request user_id=%s status=%s",
            user_id,
            status or "<none>",
        )
        result = client.get_all(filters={"user_id": user_id})
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
        memories_raw = _hydrate_memories_for_review(user_id, client, memories_raw, status)
        memories_raw = _dedupe_memories_by_id(memories_raw)
        items = [_to_memory_item(m) for m in memories_raw]
        logger.info(
            "session.finalization list_memories_result user_id=%s status=%s count=%s",
            user_id,
            status or "<none>",
            len(items),
        )
        return MemoryListResponse(memories=items, count=len(items))
    except Exception as e:
        logger.warning("Failed to list memories for %s: %s", user_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


# ---------------------------------------------------------------------------
# 2. Memory CRUD
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/memories",
    response_model=MemoryItem,
    summary="Create a memory",
)
async def create_memory(user_id: str, body: MemoryCreateRequest) -> MemoryItem:
    _validate_user(user_id)
    client = _get_mem0_client()
    try:
        memory_metadata = dict(body.metadata or {})
        if body.category and "category" not in memory_metadata:
            memory_metadata["category"] = body.category

        add_kwargs = {
            "messages": [{"role": "user", "content": body.text}],
            "user_id": user_id,
        }
        if memory_metadata:
            add_kwargs["metadata"] = memory_metadata

        try:
            result = client.add(**add_kwargs)
        except TypeError:
            add_kwargs.pop("metadata", None)
            result = client.add(**add_kwargs)

        from deerflow.sophia.mem0_client import invalidate_user_cache
        invalidate_user_cache(user_id)

        if isinstance(result, dict):
            created = result.get("results", [result])
        elif isinstance(result, list):
            created = result
        else:
            created = [result] if result else []

        first = created[0] if created else None
        if isinstance(first, dict) and first.get("id"):
            if memory_metadata:
                upsert_review_metadata(
                    user_id,
                    memory_id=first.get("id"),
                    content=body.text,
                    metadata=memory_metadata,
                    session_id="manual-create",
                    sync_state="manual",
                )
            return _to_memory_item(first)

        if memory_metadata:
            upsert_review_metadata(
                user_id,
                memory_id=first.get("id") if isinstance(first, dict) else None,
                content=body.text,
                metadata=memory_metadata,
                session_id="manual-create",
                sync_state="manual",
            )

        return MemoryItem(
            id=str(first.get("id", "")) if isinstance(first, dict) else "",
            content=body.text,
            category=body.category or memory_metadata.get("category"),
            metadata=memory_metadata or None,
        )
    except Exception as e:
        logger.warning("Failed to create memory for %s: %s", user_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")

@router.put(
    "/{user_id}/memories/{memory_id}",
    response_model=MemoryItem,
    summary="Update a memory",
)
async def update_memory(user_id: str, memory_id: str, body: MemoryUpdateRequest) -> MemoryItem:
    _validate_user(user_id)
    local_content_hash = _local_content_hash_from_memory_id(memory_id)
    if local_content_hash:
        if body.text is None and body.metadata is None:
            raise HTTPException(status_code=422, detail="At least text or metadata must be provided")
        upsert_review_metadata(
            user_id,
            content=body.text,
            content_hash=local_content_hash,
            metadata=body.metadata,
            sync_state="manual",
        )
        return MemoryItem(
            id=memory_id,
            content=body.text or "",
            category=body.metadata.get("category") if isinstance(body.metadata, dict) else None,
            metadata=body.metadata,
        )

    client = _get_mem0_client()
    try:
        update_data = {}
        if body.text is not None:
            update_data["text"] = body.text
        if body.metadata is not None:
            update_data["metadata"] = body.metadata
        if not update_data:
            raise HTTPException(status_code=422, detail="At least text or metadata must be provided")
        result = client.update(memory_id=memory_id, **update_data)
        from deerflow.sophia.mem0_client import invalidate_user_cache
        invalidate_user_cache(user_id)
        mem = result if isinstance(result, dict) else {}
        upsert_review_metadata(
            user_id,
            memory_id=memory_id,
            content=body.text or mem.get("memory"),
            metadata=body.metadata,
            sync_state="manual",
        )
        return _to_memory_item(mem) if mem.get("id") else MemoryItem(id=memory_id, content=body.text or "")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Failed to update memory %s: %s", memory_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


@router.delete(
    "/{user_id}/memories/{memory_id}",
    status_code=204,
    summary="Delete a memory",
)
async def delete_memory(user_id: str, memory_id: str):
    _validate_user(user_id)
    local_content_hash = _local_content_hash_from_memory_id(memory_id)
    if local_content_hash:
        remove_review_metadata(user_id, content_hash=local_content_hash)
        return

    client = _get_mem0_client()
    try:
        client.delete(memory_id=memory_id)
        from deerflow.sophia.mem0_client import invalidate_user_cache
        invalidate_user_cache(user_id)
        remove_review_metadata(user_id, memory_id=memory_id)
    except Exception as e:
        logger.warning("Failed to delete memory %s: %s", memory_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


@router.post(
    "/{user_id}/memories/bulk-review",
    response_model=BulkReviewResponse,
    summary="Bulk approve or discard memories",
)
async def bulk_review(user_id: str, body: BulkReviewRequest) -> BulkReviewResponse:
    _validate_user(user_id)
    client = _get_mem0_client()
    results = []
    for item in body.items:
        try:
            local_content_hash = _local_content_hash_from_memory_id(item.id)
            if item.action == "approve":
                if local_content_hash:
                    upsert_review_metadata(
                        user_id,
                        content_hash=local_content_hash,
                        metadata={"status": "approved"},
                        sync_state="manual",
                    )
                else:
                    client.update(memory_id=item.id, metadata={"status": "approved"})
                upsert_review_metadata(
                    user_id,
                    memory_id=item.id if not local_content_hash else None,
                    content_hash=local_content_hash,
                    metadata={"status": "approved"},
                    sync_state="manual",
                )
                results.append(BulkReviewResult(id=item.id, action="approve", status="ok"))
            elif item.action == "discard":
                if local_content_hash:
                    remove_review_metadata(user_id, content_hash=local_content_hash)
                else:
                    client.delete(memory_id=item.id)
                    remove_review_metadata(user_id, memory_id=item.id)
                results.append(BulkReviewResult(id=item.id, action="discard", status="ok"))
        except Exception as e:
            results.append(BulkReviewResult(id=item.id, action=item.action, status="error", error=str(e)))
    try:
        from deerflow.sophia.mem0_client import invalidate_user_cache
        invalidate_user_cache(user_id)
    except Exception:
        pass
    return BulkReviewResponse(results=results)


# ---------------------------------------------------------------------------
# 3. Reflect
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/reflect",
    response_model=ReflectResponse,
    summary="Generate a reflection",
    description="Produces voice context and visual parts based on user memories and a query.",
)
async def reflect(user_id: str, body: ReflectRequest) -> ReflectResponse:
    _validate_user(user_id)
    try:
        from deerflow.sophia.reflection import generate_reflection
        result = await asyncio.to_thread(
            generate_reflection,
            user_id=user_id,
            query=body.query,
            period=body.period,
        )
        return ReflectResponse(**result)
    except ImportError:
        raise HTTPException(status_code=503, detail="Reflection service not available")
    except Exception as e:
        logger.warning("Reflect failed for %s: %s", user_id, e)
        raise HTTPException(status_code=503, detail="Reflection service error")


# ---------------------------------------------------------------------------
# 4. Journal
# ---------------------------------------------------------------------------

@router.get(
    "/{user_id}/journal",
    response_model=JournalResponse,
    summary="Browse user journal (all memories)",
)
async def journal(
    user_id: str,
    category: str | None = Query(default=None, description="Filter by category"),
    memory_type: str | None = Query(default=None, alias="type", description="Alias for category filter"),
    search: str | None = Query(default=None, description="Case-insensitive text search"),
    status: str | None = Query(default=None, description="Filter by metadata.status"),
) -> JournalResponse:
    _validate_user(user_id)
    client = _get_mem0_client()
    try:
        selected_category = category or memory_type
        normalized_search = search.strip().lower() if isinstance(search, str) and search.strip() else None
        memories_raw: list[dict]

        if normalized_search:
            from deerflow.sophia.mem0_client import search_memories

            memories_raw = await asyncio.to_thread(
                search_memories,
                user_id,
                normalized_search,
                categories=[selected_category] if selected_category else None,
            )
            memories_raw = _hydrate_memories_for_review(user_id, client, memories_raw, status)

            # Preserve the previous plain-text search behavior if Mem0 search returns no results.
            if not memories_raw:
                filters: dict = {"user_id": user_id}
                if selected_category:
                    filters["categories"] = selected_category
                result = client.get_all(filters=filters)
                memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
                memories_raw = _hydrate_memories_for_review(user_id, client, memories_raw, status)
                memories_raw = [
                    memory
                    for memory in memories_raw
                    if any(
                        isinstance(target, str) and normalized_search in target.lower()
                        for target in [
                            memory.get("memory", memory.get("content", "")),
                            *(memory.get("categories") if isinstance(memory.get("categories"), list) else []),
                        ]
                    )
                ]
        else:
            filters = {"user_id": user_id}
            if selected_category:
                filters["categories"] = selected_category
            result = client.get_all(filters=filters)
            memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
            memories_raw = _hydrate_memories_for_review(user_id, client, memories_raw, status)

        memories_raw = _sort_memories_desc(memories_raw)
        memories_raw = _dedupe_memories_by_id(memories_raw)

        entries = [
            JournalEntry(
                id=m.get("id", ""),
                content=m.get("memory", m.get("content", "")),
                category=_get_primary_category(m),
                metadata=m.get("metadata"),
                created_at=m.get("created_at"),
            )
            for m in memories_raw
        ]
        return JournalResponse(entries=entries, count=len(entries))
    except Exception as e:
        logger.warning("Journal failed for %s: %s", user_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


# ---------------------------------------------------------------------------
# 5. Session Recap
# ---------------------------------------------------------------------------

@router.get(
    "/{user_id}/sessions/{session_id}/recap",
    response_model=SessionRecapResponse,
    summary="Get persisted recap for a completed Sophia session",
)
async def get_session_recap(user_id: str, session_id: str) -> SessionRecapResponse:
    _validate_user(user_id)
    try:
        recap = _read_session_recap(user_id, session_id)
    except json.JSONDecodeError as e:
        logger.warning("Invalid recap JSON for %s/%s: %s", user_id, session_id, e)
        raise HTTPException(status_code=503, detail="Session recap unavailable")

    if recap is None:
        raise HTTPException(status_code=404, detail="Session recap not found")

    return SessionRecapResponse(**recap)


# ---------------------------------------------------------------------------
# 6. Visual Artifacts
# ---------------------------------------------------------------------------

@router.get(
    "/{user_id}/visual/weekly",
    response_model=WeeklyVisualResponse,
    summary="Weekly tone trajectory",
)
async def visual_weekly(user_id: str) -> WeeklyVisualResponse:
    _validate_user(user_id)
    try:
        from deerflow.agents.sophia_agent.paths import USERS_DIR
        from deerflow.agents.sophia_agent.utils import safe_user_path

        traces_dir = safe_user_path(USERS_DIR, user_id, "traces")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user_id format")

    if not traces_dir.exists():
        return WeeklyVisualResponse(data_points=[])

    cutoff = datetime.now(UTC) - timedelta(days=7)
    daily: dict[str, list[float]] = {}

    for trace_file in sorted(traces_dir.glob("*.json")):
        try:
            data = json.loads(trace_file.read_text(encoding="utf-8"))
            turns = data.get("turns", [])
            for turn in turns:
                ts = turn.get("timestamp", "")
                tone = turn.get("tone_after", turn.get("tone_estimate"))
                if ts and tone is not None:
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=UTC)
                        if dt >= cutoff:
                            date_key = dt.strftime("%Y-%m-%d")
                            daily.setdefault(date_key, []).append(float(tone))
                    except (ValueError, TypeError):
                        continue
        except (json.JSONDecodeError, OSError):
            continue

    data_points = [
        ToneDataPoint(
            date=date,
            avg_tone=round(sum(tones) / len(tones), 2),
            turn_count=len(tones),
        )
        for date, tones in sorted(daily.items())
    ]
    return WeeklyVisualResponse(data_points=data_points)


@router.get(
    "/{user_id}/visual/decisions",
    response_model=CategoryMemoryResponse,
    summary="Decision memories",
)
async def visual_decisions(user_id: str) -> CategoryMemoryResponse:
    _validate_user(user_id)
    client = _get_mem0_client()
    try:
        result = client.get_all(filters={"user_id": user_id, "categories": "decision"})
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
        items = [_to_memory_item(m) for m in memories_raw]
        return CategoryMemoryResponse(memories=items, count=len(items))
    except Exception as e:
        logger.warning("Visual decisions failed: %s", e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


@router.get(
    "/{user_id}/visual/commitments",
    response_model=CategoryMemoryResponse,
    summary="Commitment memories",
)
async def visual_commitments(user_id: str) -> CategoryMemoryResponse:
    _validate_user(user_id)
    client = _get_mem0_client()
    try:
        result = client.get_all(filters={"user_id": user_id, "categories": "commitment"})
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
        items = [_to_memory_item(m) for m in memories_raw]
        return CategoryMemoryResponse(memories=items, count=len(items))
    except Exception as e:
        logger.warning("Visual commitments failed: %s", e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")

# ---------------------------------------------------------------------------
# 6b. Telegram linking
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/telegram/link",
    response_model=TelegramLinkCreateResponse,
    summary="Create a one-time Telegram deep-link token",
)
async def create_telegram_link_token(
    user_id: str,
    body: TelegramLinkCreateRequest,
) -> TelegramLinkCreateResponse:
    user_id = _validate_user(user_id)
    store = get_telegram_link_store()
    issued = store.issue_link_token(
        sophia_user_id=user_id,
        context_mode=body.context_mode,
        ttl_seconds=body.ttl_seconds,
    )
    bot_username = _get_telegram_bot_username()
    deep_link = f"https://t.me/{bot_username}?start={issued['token']}" if bot_username else None
    return TelegramLinkCreateResponse(
        linked=False,
        token=issued["token"],
        deep_link=deep_link,
        expires_at=issued["expires_at"],
        context_mode=issued["context_mode"],
    )


@router.get(
    "/{user_id}/telegram/link",
    response_model=TelegramLinkStatusResponse,
    summary="Get Telegram link status for the Sophia user",
)
async def get_telegram_link_status(user_id: str) -> TelegramLinkStatusResponse:
    user_id = _validate_user(user_id)
    store = get_telegram_link_store()
    link = store.get_link_by_user(user_id)
    if not link:
        return TelegramLinkStatusResponse(linked=False, user_id=user_id)
    return TelegramLinkStatusResponse(
        linked=True,
        user_id=user_id,
        telegram_chat_id=link.get("telegram_chat_id"),
        telegram_user_id=link.get("telegram_user_id"),
        telegram_username=link.get("telegram_username"),
        context_mode=link.get("context_mode"),
        linked_at=link.get("linked_at"),
        last_seen_at=link.get("last_seen_at"),
    )


@router.delete(
    "/{user_id}/telegram/link",
    response_model=TelegramLinkRemoveResponse,
    summary="Unlink Telegram from the Sophia user",
)
async def remove_telegram_link(user_id: str) -> TelegramLinkRemoveResponse:
    user_id = _validate_user(user_id)
    store = get_telegram_link_store()
    removed = store.unlink_user(user_id)
    return TelegramLinkRemoveResponse(linked=False, removed=removed)


def _extract_builder_result_from_task_result(result: object) -> dict | None:
    final_state = getattr(result, "final_state", None)
    if isinstance(final_state, dict):
        builder_result = final_state.get("builder_result")
        if isinstance(builder_result, dict) and builder_result:
            return builder_result

    ai_messages = getattr(result, "ai_messages", None)
    if not isinstance(ai_messages, list):
        return None

    for message in reversed(ai_messages):
        if not isinstance(message, dict):
            continue

        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue

        for tool_call in reversed(tool_calls):
            if not isinstance(tool_call, dict):
                continue
            if tool_call.get("name") != "emit_builder_artifact":
                continue

            args = tool_call.get("args")
            if isinstance(args, dict) and args:
                return args

    return None


def _task_summary_tool_names(summary: object) -> list[str]:
    if not isinstance(summary, dict):
        return []

    tool_names = summary.get("tool_names")
    if not isinstance(tool_names, list):
        return []

    return [tool_name for tool_name in tool_names if isinstance(tool_name, str) and tool_name]


def _infer_task_blocker(
    status_value: str,
    *,
    builder_result: dict | None,
    last_summary: object,
    late_summary: object,
    message_count: int,
) -> tuple[str | None, str | None]:
    if status_value in {"completed", "cancelled"}:
        return (None, None)

    last_tool_names = _task_summary_tool_names(last_summary)
    late_tool_names = _task_summary_tool_names(late_summary)
    last_has_emit = bool(isinstance(last_summary, dict) and last_summary.get("has_emit_builder_artifact"))
    late_has_emit = bool(isinstance(late_summary, dict) and late_summary.get("has_emit_builder_artifact"))

    if status_value == "timed_out":
        if late_has_emit:
            return (
                "final_artifact_emission",
                "Builder only reached emit_builder_artifact after the timeout window closed.",
            )
        if last_tool_names:
            return (
                "tool_call",
                f"Builder timed out after calling {', '.join(last_tool_names)} before emit_builder_artifact.",
            )
        return (
            "background_agent",
            "Builder timed out before a terminal artifact or result was captured.",
        )

    if status_value == "failed":
        if last_has_emit:
            return (
                "final_artifact_emission",
                "Builder failed after emit_builder_artifact was attempted.",
            )
        if last_tool_names:
            return (
                "tool_call",
                f"Latest captured Builder activity called {', '.join(last_tool_names)} before failing.",
            )
        return (
            "background_agent",
            "Builder failed outside a captured tool call or final artifact emission step.",
        )

    if isinstance(builder_result, dict) and builder_result:
        return (
            "final_artifact_emission",
            "Builder artifact exists, but the background task has not reported a terminal status yet.",
        )

    if late_has_emit or last_has_emit:
        return (
            "final_artifact_emission",
            "Latest captured Builder step already called emit_builder_artifact, but task closure is still pending.",
        )

    if last_tool_names:
        return (
            "tool_call",
            f"Latest captured Builder step called {', '.join(last_tool_names)} and has not reached emit_builder_artifact yet.",
        )

    if late_tool_names:
        return (
            "tool_call",
            f"Late Builder activity was observed in {', '.join(late_tool_names)} without a final artifact.",
        )

    if message_count > 0:
        return (
            "background_agent",
            "No recent Builder tool calls were captured; it may be waiting on the model loop or a hidden downstream dependency.",
        )

    return (
        "background_agent",
        "Builder task exists in memory but no AI/tool activity has been captured yet.",
    )


# ---------------------------------------------------------------------------
# Activity log extraction
# ---------------------------------------------------------------------------

_TOOL_LABELS: dict[str, str] = {
    "bash": "Running shell command",
    "shell": "Running shell command",
    "write_file": "Writing file",
    "create_file": "Creating file",
    "read_file": "Reading file",
    "edit_file": "Editing file",
    "list_directory": "Listing directory",
    "web_search": "Searching the web",
    "web_browse": "Browsing webpage",
    "crawl_tool": "Crawling webpage",
    "python_repl": "Running Python",
    "write_todos": "Updating plan",
    "emit_builder_artifact": "Finalizing deliverable",
}

_MAX_ACTIVITY_LOG_ENTRIES = 30


def _tool_activity_title(tool_name: str) -> str:
    return _TOOL_LABELS.get(tool_name, tool_name.replace("_", " ").title())


def _summarize_tool_args(tool_name: str, args: dict[str, Any] | None) -> str | None:
    if not isinstance(args, dict):
        return None

    if tool_name in ("bash", "shell"):
        command = args.get("command") or args.get("cmd")
        if isinstance(command, str) and command.strip():
            return command.strip()[:120]
        return None

    if tool_name in ("write_file", "create_file", "edit_file", "read_file"):
        path = args.get("path") or args.get("file_path") or args.get("filename")
        if isinstance(path, str) and path.strip():
            return path.strip()
        return None

    if tool_name in ("web_search", "crawl_tool"):
        query = args.get("query") or args.get("search_query")
        if isinstance(query, str) and query.strip():
            return query.strip()[:100]
        return None

    if tool_name == "web_browse":
        url = args.get("url")
        if isinstance(url, str) and url.strip():
            return url.strip()[:120]
        return None

    if tool_name == "write_todos":
        todos = args.get("todos")
        if isinstance(todos, list):
            return f"{len(todos)} items"
        return None

    if tool_name == "emit_builder_artifact":
        title = args.get("artifact_title") or args.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()[:100]
        return None

    return None


def _build_activity_log(result: object) -> list[dict[str, Any]]:
    ai_messages = getattr(result, "ai_messages", None) or []
    if not ai_messages:
        return []

    entries: list[dict[str, Any]] = []

    for msg_index, message in enumerate(ai_messages):
        if not isinstance(message, dict):
            continue

        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list) or not tool_calls:
            # AI message with text only — planning/thinking step
            content = message.get("content")
            if isinstance(content, str) and content.strip() and msg_index == 0:
                entries.append({
                    "type": "thinking",
                    "title": "Analyzing task",
                    "status": "done",
                })
            continue

        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue

            tool_name = tool_call.get("name")
            if not isinstance(tool_name, str) or not tool_name:
                continue

            args = tool_call.get("args")
            detail = _summarize_tool_args(tool_name, args if isinstance(args, dict) else None)

            is_last_message = msg_index == len(ai_messages) - 1
            is_terminal = getattr(result, "status", None) not in (None,) and (
                hasattr(result, "status")
                and getattr(result.status, "value", None) in ("completed", "failed", "timed_out", "cancelled")
            )
            status = "done" if not is_last_message or is_terminal else "running"

            entry: dict[str, Any] = {
                "type": "tool_call",
                "title": _tool_activity_title(tool_name),
                "tool": tool_name,
                "status": status,
            }
            if detail:
                entry["detail"] = detail

            entries.append(entry)

    # Keep only the most recent entries
    return entries[-_MAX_ACTIVITY_LOG_ENTRIES:]


def _build_task_status_debug(result: object, status_value: str, builder_result: dict | None) -> TaskStatusDebug:
    last_summary = getattr(result, "last_ai_message_summary", None)
    late_summary = getattr(result, "late_ai_message_summary", None)
    message_count = len(getattr(result, "ai_messages", None) or [])
    suspected_blocker, blocker_detail = _infer_task_blocker(
        status_value,
        builder_result=builder_result,
        last_summary=last_summary,
        late_summary=late_summary,
        message_count=message_count,
    )

    return TaskStatusDebug(
        last_tool_names=_task_summary_tool_names(last_summary),
        last_has_emit_builder_artifact=(
            bool(last_summary.get("has_emit_builder_artifact"))
            if isinstance(last_summary, dict) and "has_emit_builder_artifact" in last_summary
            else None
        ),
        late_tool_names=_task_summary_tool_names(late_summary),
        late_has_emit_builder_artifact=(
            bool(late_summary.get("has_emit_builder_artifact"))
            if isinstance(late_summary, dict) and "has_emit_builder_artifact" in late_summary
            else None
        ),
        timeout_observed_during_stream=bool(getattr(result, "timeout_observed_during_stream", False)),
        timed_out_at=(
            getattr(result, "timed_out_at", None).isoformat()
            if getattr(result, "timed_out_at", None) is not None
            else None
        ),
        final_state_present=isinstance(getattr(result, "final_state", None), dict),
        builder_result_present=isinstance(builder_result, dict) and bool(builder_result),
        suspected_blocker=suspected_blocker,
        suspected_blocker_detail=blocker_detail,
        last_shell_command=(
            dict(getattr(result, "live_state", {}).get("last_shell_command"))
            if isinstance(getattr(result, "live_state", None), dict)
            and isinstance(getattr(result, "live_state", {}).get("last_shell_command"), dict)
            else None
        ),
        recent_shell_commands=(
            [
                dict(entry)
                for entry in getattr(result, "live_state", {}).get("recent_shell_commands", [])
                if isinstance(entry, dict)
            ]
            if isinstance(getattr(result, "live_state", None), dict)
            else []
        ),
    )


def _build_task_status_detail(result: object, progress_payload: dict, builder_result: dict | None) -> str | None:
    explicit_error = getattr(result, "error", None)
    if isinstance(explicit_error, str) and explicit_error.strip():
        return explicit_error.strip()

    stuck_reason = progress_payload.get("stuck_reason")
    if isinstance(stuck_reason, str) and stuck_reason.strip():
        return stuck_reason.strip()

    if isinstance(builder_result, dict):
        companion_summary = builder_result.get("companion_summary")
        if isinstance(companion_summary, str) and companion_summary.strip():
            return companion_summary.strip()

    result_text = getattr(result, "result", None)
    if isinstance(result_text, str) and result_text.strip():
        return result_text.strip()

    live_state = getattr(result, "live_state", None)
    if isinstance(live_state, dict):
        builder_task = live_state.get("builder_task")
        if isinstance(builder_task, dict):
            detail = builder_task.get("detail")
            if isinstance(detail, str) and detail.strip():
                return detail.strip()

        last_shell_command = live_state.get("last_shell_command")
        if isinstance(last_shell_command, dict):
            shell_error = last_shell_command.get("error")
            if isinstance(shell_error, str) and shell_error.strip():
                return shell_error.strip()

    return None


def _build_task_status_description(result: object, builder_result: dict | None) -> str | None:
    for state_name in ("live_state", "final_state"):
        state = getattr(result, state_name, None)
        if not isinstance(state, dict):
            continue

        builder_task = state.get("builder_task")
        if isinstance(builder_task, dict):
            description = builder_task.get("description")
            if isinstance(description, str) and description.strip():
                return description.strip()

    if isinstance(builder_result, dict):
        artifact_title = builder_result.get("artifact_title")
        if isinstance(artifact_title, str) and artifact_title.strip():
            return artifact_title.strip()

    return None


# ---------------------------------------------------------------------------
# 7. Background Task Control
# ---------------------------------------------------------------------------

@router.get(
    "/{user_id}/tasks/active",
    response_model=TaskStatusResponse | None,
    summary="Get the latest builder task for a thread (if any)",
)
async def get_active_task(
    user_id: str,
    thread_id: str | None = None,
) -> TaskStatusResponse | None:
    """Return the most recent in-memory builder task for *thread_id*.

    The frontend calls this after a voice reconnect to discover builder tasks
    that may have been started while the SSE stream was disconnected.
    Returns ``null`` when no matching task exists.
    """
    _validate_user(user_id)

    if not thread_id:
        return None

    from deerflow.subagents.executor import (
        build_subagent_progress_payload,
        get_latest_task_for_thread,
    )

    result = get_latest_task_for_thread(thread_id)
    if result is None or (result.owner_id and result.owner_id != user_id):
        return None

    status_value = result.status.value
    progress_payload = build_subagent_progress_payload(result)
    builder_result = _extract_builder_result_from_task_result(result)
    detail = _build_task_status_detail(result, progress_payload, builder_result)

    return TaskStatusResponse(
        task_id=result.task_id,
        status=status_value,
        trace_id=result.trace_id,
        description=_build_task_status_description(result, builder_result),
        detail=detail,
        result=result.result,
        error=result.error,
        builder_result=builder_result,
        message_count=len(result.ai_messages or []),
        started_at=progress_payload.get("started_at"),
        completed_at=progress_payload.get("completed_at"),
        last_update_at=progress_payload.get("last_update_at"),
        last_progress_at=progress_payload.get("last_progress_at"),
        heartbeat_ms=progress_payload.get("heartbeat_ms"),
        idle_ms=progress_payload.get("idle_ms"),
        is_stuck=bool(progress_payload.get("is_stuck", False)),
        stuck_reason=progress_payload.get("stuck_reason"),
        progress_percent=progress_payload.get("progress_percent"),
        progress_source=progress_payload.get("progress_source"),
        total_steps=progress_payload.get("total_steps"),
        completed_steps=progress_payload.get("completed_steps"),
        in_progress_steps=progress_payload.get("in_progress_steps"),
        pending_steps=progress_payload.get("pending_steps"),
        active_step_title=progress_payload.get("active_step_title"),
        todos=progress_payload.get("todos") or [],
        debug=_build_task_status_debug(result, status_value, builder_result),
        activity_log=_build_activity_log(result),
    )

@router.get(
    "/{user_id}/tasks/{task_id}",
    response_model=TaskStatusResponse,
    summary="Get live status for a Sophia background task",
)
async def get_task_status(
    user_id: str,
    task_id: str,
    thread_id: str | None = Query(default=None, description="Optional LangGraph thread ID for fallback state query"),
) -> TaskStatusResponse:
    _validate_user(user_id)

    from deerflow.subagents.executor import (
        build_subagent_progress_payload,
        get_background_task_result,
        read_background_task_status_payload,
    )

    result = get_background_task_result(task_id)
    if result is None or (result.owner_id and result.owner_id != user_id):
        persisted_payload = read_background_task_status_payload(user_id, task_id)
        if persisted_payload is None:
            # Fallback 1: pushed registry populated by gateway_notify from LangGraph process
            from app.gateway.routers.internal_builder_tasks import get_pushed_builder_task
            pushed = get_pushed_builder_task(task_id)
            if pushed is not None:
                pushed_status = pushed.get("status", "unknown")
                pushed_builder_result = pushed.get("builder_result")
                response = TaskStatusResponse(
                    task_id=task_id,
                    status=pushed_status,
                    trace_id=pushed.get("trace_id"),
                    error=pushed.get("error"),
                    builder_result=pushed_builder_result if isinstance(pushed_builder_result, dict) else None,
                    completed_at=pushed.get("completed_at"),
                    started_at=pushed.get("started_at"),
                )
                if thread_id and response.builder_result:
                    response.builder_delivery = _hydrate_builder_delivery(thread_id, response.builder_result)
                return response

            # Fallback 2: query LangGraph thread state directly (useful when gateway_notify push failed)
            if thread_id:
                try:
                    thread_state = await _fetch_langgraph_thread_state(thread_id)
                    values = thread_state.get("values", {})
                    builder_task = values.get("builder_task")
                    builder_result = values.get("builder_result")
                    if builder_task and isinstance(builder_task, dict):
                        task_status = builder_task.get("status", "unknown")
                        response = TaskStatusResponse(
                            task_id=task_id,
                            status=task_status,
                            builder_result=builder_result if isinstance(builder_result, dict) else None,
                        )
                        if thread_id and response.builder_result:
                            response.builder_delivery = _hydrate_builder_delivery(thread_id, response.builder_result)
                        return response
                except Exception:
                    logger.warning(
                        "LangGraph thread state fallback failed for task_id=%s thread_id=%s",
                        task_id,
                        thread_id,
                        exc_info=True,
                    )

            raise HTTPException(status_code=404, detail="Task not found")

        persisted_payload.pop("owner_id", None)
        if thread_id and persisted_payload.get("builder_result"):
            persisted_payload["builder_delivery"] = _hydrate_builder_delivery(
                thread_id, persisted_payload["builder_result"]
            )
        return TaskStatusResponse(**persisted_payload)

    status_value = result.status.value
    progress_payload = build_subagent_progress_payload(result)
    builder_result = _extract_builder_result_from_task_result(result)
    detail = _build_task_status_detail(result, progress_payload, builder_result)

    response = TaskStatusResponse(
        task_id=task_id,
        status=status_value,
        trace_id=result.trace_id,
        description=_build_task_status_description(result, builder_result),
        detail=detail,
        result=result.result,
        error=result.error,
        builder_result=builder_result,
        message_count=len(result.ai_messages or []),
        started_at=progress_payload.get("started_at"),
        completed_at=progress_payload.get("completed_at"),
        last_update_at=progress_payload.get("last_update_at"),
        last_progress_at=progress_payload.get("last_progress_at"),
        heartbeat_ms=progress_payload.get("heartbeat_ms"),
        idle_ms=progress_payload.get("idle_ms"),
        is_stuck=bool(progress_payload.get("is_stuck", False)),
        stuck_reason=progress_payload.get("stuck_reason"),
        progress_percent=progress_payload.get("progress_percent"),
        progress_source=progress_payload.get("progress_source"),
        total_steps=progress_payload.get("total_steps"),
        completed_steps=progress_payload.get("completed_steps"),
        in_progress_steps=progress_payload.get("in_progress_steps"),
        pending_steps=progress_payload.get("pending_steps"),
        active_step_title=progress_payload.get("active_step_title"),
        todos=progress_payload.get("todos") or [],
        debug=_build_task_status_debug(result, status_value, builder_result),
        activity_log=_build_activity_log(result),
    )
    if thread_id and builder_result:
        response.builder_delivery = _hydrate_builder_delivery(thread_id, builder_result)
    return response

@router.post(
    "/{user_id}/tasks/{task_id}/cancel",
    response_model=TaskCancelResponse,
    summary="Cancel a running Sophia background task",
)
async def cancel_task(user_id: str, task_id: str) -> TaskCancelResponse:
    _validate_user(user_id)

    from deerflow.subagents.executor import cancel_background_task, get_background_task_result

    result = get_background_task_result(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Task not found")

    if result.owner_id and result.owner_id != user_id:
        raise HTTPException(status_code=404, detail="Task not found")

    cancelled = cancel_background_task(task_id)
    if cancelled is None:
        raise HTTPException(status_code=404, detail="Task not found")

    if cancelled.status.value != "cancelled":
        return TaskCancelResponse(
            task_id=task_id,
            status=cancelled.status.value,
            detail=cancelled.error,
        )

    return TaskCancelResponse(
        task_id=task_id,
        status="cancelled",
        detail=cancelled.error,
    )


# ---------------------------------------------------------------------------
# 8. Session End Trigger
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/end-session",
    response_model=SessionEndResponse,
    status_code=202,
    summary="Trigger offline pipeline for a completed session",
)
async def end_session(user_id: str, body: SessionEndRequest) -> SessionEndResponse:
    _validate_user(user_id)

    logger.info(
        "session.finalization end_session_request user_id=%s session_id=%s thread_id=%s message_count=%s has_recap_artifacts=%s",
        user_id,
        body.session_id,
        body.thread_id,
        len(body.messages or []),
        body.recap_artifacts is not None,
    )

    ended_at = body.ended_at or datetime.now(UTC).isoformat()
    recap_payload = _build_session_recap_payload(body, ended_at)
    duration_minutes = _compute_duration_minutes(body.started_at, ended_at)
    turn_count = recap_payload.get("turn_count", 0)
    recap_artifacts = recap_payload.get("recap_artifacts")
    debrief_prompt = _build_debrief_prompt(body, recap_artifacts, duration_minutes)

    try:
        _write_session_recap(user_id, body.session_id, recap_payload)
        logger.info(
            "session.finalization recap_persisted user_id=%s session_id=%s status=%s",
            user_id,
            body.session_id,
            recap_payload.get("status"),
        )
    except OSError as e:
        logger.warning("Failed to persist recap for %s/%s: %s", user_id, body.session_id, e)

    owner_user_id, record = _resolve_session_record_owner(user_id, body.session_id)
    if record is not None and record.status != "ended":
        ended_record = _session_store.update(
            owner_user_id,
            body.session_id,
            status="ended",
            ended_at=ended_at,
        )
        if ended_record is None:
            logger.warning(
                "session.finalization failed_to_persist_session_end user_id=%s session_id=%s",
                owner_user_id,
                body.session_id,
            )

    # Remove from inactivity tracking — session explicitly ended
    try:
        from app.gateway.inactivity_watcher import unregister_thread
        unregister_thread(body.thread_id)
    except ImportError:
        pass

    try:
        _queue_offline_pipeline(
            user_id,
            body.session_id,
            body.thread_id,
            _build_thread_state_from_end_request(body),
        )
        logger.info(
            "session.finalization end_session_queued user_id=%s session_id=%s thread_id=%s",
            user_id,
            body.session_id,
            body.thread_id,
        )
        return SessionEndResponse(
            status="pipeline_queued",
            session_id=body.session_id,
            ended_at=ended_at,
            duration_minutes=duration_minutes,
            turn_count=turn_count,
            recap_artifacts=recap_artifacts,
            offer_debrief=debrief_prompt is not None,
            debrief_prompt=debrief_prompt,
        )
    except ImportError:
        raise HTTPException(status_code=503, detail="Offline pipeline not available")
