"""Sophia API router for memory management, reflect, journal, visual artifacts, and session control."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

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
        import os
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


class SessionEndRequest(BaseModel):
    session_id: str = Field(..., description="Session ID to process")
    thread_id: str = Field(..., description="LangGraph thread ID")


class SessionEndResponse(BaseModel):
    status: str = Field(default="pipeline_queued")
    session_id: str = Field(default="")


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
        filters: dict = {"user_id": user_id}
        if status:
            filters["metadata"] = {"status": status}
        result = client.get_all(filters=filters)
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
        items = [_to_memory_item(m) for m in memories_raw]
        return MemoryListResponse(memories=items, count=len(items))
    except Exception as e:
        logger.warning("Failed to list memories for %s: %s", user_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


# ---------------------------------------------------------------------------
# 2. Memory CRUD
# ---------------------------------------------------------------------------

@router.put(
    "/{user_id}/memories/{memory_id}",
    response_model=MemoryItem,
    summary="Update a memory",
)
async def update_memory(user_id: str, memory_id: str, body: MemoryUpdateRequest) -> MemoryItem:
    _validate_user(user_id)
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
        return _to_memory_item(mem) if mem.get("id") else MemoryItem(id=memory_id, content=body.text or "")
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
    client = _get_mem0_client()
    try:
        client.delete(memory_id=memory_id)
        from deerflow.sophia.mem0_client import invalidate_user_cache
        invalidate_user_cache(user_id)
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
            if item.action == "approve":
                client.update(memory_id=item.id, metadata={"status": "approved"})
                results.append(BulkReviewResult(id=item.id, action="approve", status="ok"))
            elif item.action == "discard":
                client.delete(memory_id=item.id)
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
# 5. Visual Artifacts
# ---------------------------------------------------------------------------

@router.get(
    "/{user_id}/visual/weekly",
    response_model=WeeklyVisualResponse,
    summary="Weekly tone trajectory",
)
async def visual_weekly(user_id: str) -> WeeklyVisualResponse:
    _validate_user(user_id)
    try:
        from deerflow.agents.sophia_agent.utils import safe_user_path
        from deerflow.agents.sophia_agent.paths import USERS_DIR
        traces_dir = safe_user_path(USERS_DIR, user_id, "traces")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user_id format")

    if not traces_dir.exists():
        return WeeklyVisualResponse(data_points=[])

    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
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
                            dt = dt.replace(tzinfo=timezone.utc)
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
# 6. Session End Trigger
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/end-session",
    response_model=SessionEndResponse,
    status_code=202,
    summary="Trigger offline pipeline for a completed session",
)
async def end_session(user_id: str, body: SessionEndRequest) -> SessionEndResponse:
    _validate_user(user_id)

    # Remove from inactivity tracking — session explicitly ended
    try:
        from app.gateway.inactivity_watcher import unregister_thread
        unregister_thread(body.thread_id)
    except ImportError:
        pass

    try:
        from deerflow.sophia.offline_pipeline import run_offline_pipeline

        # Fire pipeline as background task — don't block the HTTP response
        task = asyncio.create_task(
            asyncio.to_thread(
                run_offline_pipeline,
                user_id,
                body.session_id,
                body.thread_id,
                None,  # thread_state — pipeline will need to fetch it
            )
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        return SessionEndResponse(status="pipeline_queued", session_id=body.session_id)
    except ImportError:
        raise HTTPException(status_code=503, detail="Offline pipeline not available")
