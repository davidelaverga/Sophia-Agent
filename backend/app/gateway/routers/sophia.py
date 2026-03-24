"""Sophia-specific gateway endpoints.

Endpoints for memory management, visual artifacts, reflect flow,
and journal access. All paths prefixed with /api/sophia/{user_id}/.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/sophia", tags=["sophia"])


# ── Request/Response models ──


class ReflectRequest(BaseModel):
    query: str
    period: str  # "this_week" | "this_month" | "overall"


class ReflectResponse(BaseModel):
    voice_context: str
    visual_parts: list[dict]


class MemoryUpdateRequest(BaseModel):
    text: str | None = None
    metadata: dict | None = None


class BulkReviewRequest(BaseModel):
    memory_ids: list[str]
    action: str  # "approve" | "reject"


# ── Memory endpoints ──


@router.get("/{user_id}/memories/recent")
async def get_recent_memories(user_id: str, status: str = "pending_review"):
    """Get recent memory candidates for review."""
    # TODO(jorge): Query Mem0 with status filter
    return {"memories": [], "count": 0}


@router.put("/{user_id}/memories/{memory_id}")
async def update_memory(user_id: str, memory_id: str, body: MemoryUpdateRequest):
    """Update a memory's text or metadata."""
    # TODO(jorge): Update memory in Mem0
    return {"success": True, "memory_id": memory_id}


@router.delete("/{user_id}/memories/{memory_id}")
async def delete_memory(user_id: str, memory_id: str):
    """Delete a memory."""
    # TODO(jorge): Delete memory from Mem0
    return {"success": True, "memory_id": memory_id}


@router.post("/{user_id}/memories/bulk-review")
async def bulk_review_memories(user_id: str, body: BulkReviewRequest):
    """Approve or reject multiple memory candidates at once."""
    # TODO(jorge): Bulk update in Mem0
    return {"success": True, "count": len(body.memory_ids)}


# ── Visual artifact endpoints ──


@router.get("/{user_id}/visual/weekly")
async def get_weekly_visual(user_id: str):
    """Tone trajectory from Mem0 session metadata."""
    # TODO(jorge): Query Mem0 for weekly tone data
    return {"data": [], "period": "weekly"}


@router.get("/{user_id}/visual/decisions")
async def get_decisions_visual(user_id: str):
    """Decision-category memories as cards."""
    # TODO(jorge): Query Mem0 for decision category
    return {"decisions": []}


@router.get("/{user_id}/visual/commitments")
async def get_commitments_visual(user_id: str):
    """Commitment-category memories with status."""
    # TODO(jorge): Query Mem0 for commitment category
    return {"commitments": []}


# ── Reflect endpoint ──


@router.post("/{user_id}/reflect", response_model=ReflectResponse)
async def reflect(user_id: str, body: ReflectRequest):
    """Generate reflection: voice narrative + visual artifact data."""
    from app.sophia.reflection import generate_reflection

    result = await generate_reflection(user_id, body.query, body.period)
    return result


# ── Journal endpoint ──


@router.get("/{user_id}/journal")
async def get_journal(user_id: str):
    """Browsable memories by category for the Journal view."""
    # TODO(jorge): Query Mem0 for all categories, format for Journal
    return {"categories": {}, "total": 0}
