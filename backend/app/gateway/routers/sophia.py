"""Sophia API router for memory management, reflect, journal, visual artifacts, and session control."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path
from deerflow.sophia.review_metadata_store import (
    apply_review_metadata_overlays,
    remove_review_metadata,
    upsert_review_metadata,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sophia", tags=["sophia"])

# Strong references to background tasks to prevent GC cancellation
_background_tasks: set = set()


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


# ---------------------------------------------------------------------------
# Response Models
# ---------------------------------------------------------------------------

class MemoryItem(BaseModel):
    id: str = Field(..., description="Memory ID")
    content: str = Field(default="", description="Memory content text")
    category: str | None = Field(default=None, description="Memory category")
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


# ---------------------------------------------------------------------------
# Helper: normalize Mem0 memory to MemoryItem
# ---------------------------------------------------------------------------

def _to_memory_item(mem: dict) -> MemoryItem:
    return MemoryItem(
        id=mem.get("id", ""),
        content=mem.get("memory", mem.get("content", "")),
        category=mem.get("categories", [None])[0] if isinstance(mem.get("categories"), list) else mem.get("category"),
        metadata=mem.get("metadata"),
        created_at=mem.get("created_at"),
        updated_at=mem.get("updated_at"),
    )


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
) -> JournalResponse:
    _validate_user(user_id)
    client = _get_mem0_client()
    try:
        filters: dict = {"user_id": user_id}
        if category:
            filters["categories"] = category
        result = client.get_all(filters=filters)
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
        memories_raw = apply_review_metadata_overlays(user_id, memories_raw)
        entries = [
            JournalEntry(
                id=m.get("id", ""),
                content=m.get("memory", m.get("content", "")),
                category=m.get("categories", [None])[0] if isinstance(m.get("categories"), list) else m.get("category"),
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
# 7. Session End Trigger
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
