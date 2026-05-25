"""Sophia API router for memory management, reflect, journal, visual artifacts, and session control."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, ValidationError

from app.gateway.auth import require_authorized_user_scope
from app.gateway.sophia_realtime_context import (
    REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER,
    RealtimeContextRequest,
    RealtimeContextResponse,
    RealtimeMemoryRetrieveRequest,
    build_realtime_memory_retrieve_error_envelope,
    build_sophia_realtime_context,
    retrieve_sophia_realtime_memories,
    retrieve_sophia_realtime_memories_for_grant,
)
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
internal_router = APIRouter(prefix="/internal/sophia-realtime", tags=["sophia-realtime-internal"])

# Strong references to background tasks to prevent GC cancellation
_background_tasks: set = set()
_session_store = SessionStore()
_LEGACY_SESSION_USER_ID = "dev-user"
_MEM0_GET_ALL_PAGE_SIZE = 100
# Default upper bound on pages walked by ``_get_all_paginated``. At
# ``page_size=100`` this caps a single request at 2000 memories.
#
# Codex P2 review on PR #130 R15: R20 removed the prior 5-page cap because
# users with >500 memories had pending_review records hidden past page 5.
# But ``max_pages=None`` made worst-case latency scale linearly with total
# stored memories — a single UI request could walk the entire user history.
# 20 pages (2000 memories) is the happy medium: 4x the prior cap (covers
# heavy users), but bounded enough to keep request latency predictable.
# Callers that genuinely need unbounded traversal (e.g. a future
# reconciliation worker) can pass ``max_pages=None`` explicitly.
_MEM0_GET_ALL_DEFAULT_MAX_PAGES = 20


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


async def _parse_realtime_memory_retrieve_request(
    request: Request,
) -> tuple[RealtimeMemoryRetrieveRequest | None, dict[str, Any] | None]:
    raw_body = await request.body()
    if raw_body.strip():
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            return None, build_realtime_memory_retrieve_error_envelope(
                status="invalid_request",
                provider_status="error",
                provider_reason="invalid_json_request",
                diagnostics={"validation_error": "invalid_json_body"},
            )
    else:
        payload = {}
    try:
        return RealtimeMemoryRetrieveRequest.model_validate(payload), None
    except ValidationError as exc:
        return None, build_realtime_memory_retrieve_error_envelope(
            status="invalid_request",
            provider_status="error",
            provider_reason="request_validation_error",
            diagnostics={
                "validation_error": "schema",
                "validation_error_count": len(exc.errors()),
                "validation_errors": [
                    {
                        "loc": [str(part) for part in error.get("loc", [])],
                        "type": str(error.get("type") or "unknown")[:80],
                    }
                    for error in exc.errors()[:5]
                ],
            },
        )


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


def _memory_session_id(memory: dict) -> str | None:
    if not isinstance(memory, dict):
        return None

    session_id = memory.get("session_id")
    if isinstance(session_id, str) and session_id:
        return session_id

    metadata = memory.get("metadata")
    if isinstance(metadata, dict):
        for key in ("session_id", "source_session_id"):
            metadata_session_id = metadata.get(key)
            if isinstance(metadata_session_id, str) and metadata_session_id:
                return metadata_session_id

    return None


def _filter_memories_for_review(
    memories: list[dict],
    *,
    status: str | None = None,
    session_id: str | None = None,
) -> list[dict]:
    return [
        memory
        for memory in memories
        if (
            (
                not status
                or (
                    isinstance(memory.get("metadata"), dict)
                    and memory["metadata"].get("status") == status
                )
            )
            and (not session_id or _memory_session_id(memory) == session_id)
        )
    ]


def _hydrate_memories_for_review(
    user_id: str,
    client,
    memories: list[dict],
    status: str | None,
    *,
    hydrate_missing_status: bool = True,
    hydrate_missing_detail: bool = True,
) -> list[dict]:
    memories = apply_review_metadata_overlays(user_id, memories)
    hydrated: list[dict] = []

    for memory in memories:
        merged_memory = memory
        memory_id = memory.get("id") if isinstance(memory, dict) else None
        has_status = status is not None and _has_memory_status(memory)

        needs_hydration = memory_id and (
            (hydrate_missing_status and status is not None and not has_status)
            or (hydrate_missing_detail and _should_hydrate_memory_detail(memory) and not has_status)
        )

        if needs_hydration:
            try:
                merged_memory = _merge_memory_detail(memory, client.get(memory_id))
            except Exception:
                logger.warning("Failed to hydrate memory detail for %s", memory_id, exc_info=True)

        hydrated.append(merged_memory)

    hydrated = apply_review_metadata_overlays(user_id, hydrated)

    return _filter_memories_for_review(hydrated, status=status)


def _is_memory_record(item: dict) -> bool:
    """Return True if ``item`` is a resolved Mem0 memory dict, not an event wrapper."""
    if not isinstance(item, dict):
        return False
    if item.get("status") or item.get("event_status"):
        return False
    if isinstance(item.get("memory"), dict):
        return False
    # Event wrappers carry event_id and lack memory/content.
    # Memory records have either memory, content, or metadata with category.
    if item.get("event_id") and not item.get("memory") and not item.get("content"):
        return False
    if item.get("id"):
        return True
    if not item.get("memory") and not item.get("content") and not item.get("metadata"):
        return False
    return True


def _no_extraction_memory_item(content: str, metadata: dict) -> MemoryItem:
    """Synthesize a 200-OK MemoryItem for the completed-empty case.

    Codex P2 review on PR #130 R10: Mem0 can legitimately succeed without
    extracting any memory (low-signal content like definitions or single
    words). The endpoint previously returned 503 here, forcing clients to
    retry a guaranteed-to-fail-again request. Returning a deterministic
    application-level result with ``mem0_sync_state="no_extraction"`` lets
    callers render a "we processed this but didn't save anything" message
    without polling.

    The ID is intentionally not registered in review_metadata — it's a
    transient response shape, not a persisted record. Clients should treat
    ``metadata.mem0_sync_state == "no_extraction"`` as "do not retry; do
    not display as a real memory".

    ID stability (Codex P2 review on PR #130 R11): the helper passes a
    fixed ``"noext"`` discriminator to ``_local_memory_id_for_content``
    so identical retries of the same content collide on the SAME
    deterministic ID. The unsalted ``_local_memory_id_for_content(content)``
    call would fall back to ``time.time_ns()``, giving every retry a fresh
    ID and breaking client-side dedup / reconciliation.
    """
    response_metadata = dict(metadata or {})
    response_metadata["mem0_sync_state"] = "no_extraction"
    # Deterministic placeholder ID — same (content, "noext") always hashes
    # to the same local handle. Clearly marked non-persistent via the
    # ``local:noext:`` prefix so clients don't confuse it with a real ID.
    salted = _local_memory_id_for_content(content, discriminator="noext")
    if salted and salted.startswith("local:"):
        local_id = "local:noext:" + salted.split(":", 1)[1]
    else:
        local_id = "local:noext"
    return MemoryItem(
        id=local_id,
        content=content,
        category=response_metadata.get("category"),
        session_id="manual-create",
        metadata=response_metadata,
    )


def _pending_memory_item_from_add_result(
    item: dict,
    *,
    content: str,
    metadata: dict,
    session_id: str,
) -> MemoryItem | None:
    if not isinstance(item, dict):
        return None
    event_id = item.get("event_id") or item.get("id")
    if not event_id:
        return None
    # Salt the local ID with the Mem0 event_id so two pending creates with
    # identical text (e.g. duplicate API calls) get distinct local handles
    # and don't overwrite each other's review_metadata.
    local_memory_id = _local_memory_id_for_content(
        content,
        discriminator=str(event_id),
    )
    if not local_memory_id:
        return None

    pending_metadata = dict(metadata)
    pending_metadata["mem0_event_id"] = str(event_id)
    pending_metadata["mem0_sync_state"] = "pending"

    return MemoryItem(
        id=local_memory_id,
        content=content,
        category=pending_metadata.get("category"),
        session_id=session_id,
        metadata=pending_metadata,
    )


def _get_all_paginated(
    client,
    filters: dict,
    page_size: int = _MEM0_GET_ALL_PAGE_SIZE,
    max_pages: int | None = _MEM0_GET_ALL_DEFAULT_MAX_PAGES,
    max_results: int | None = None,
) -> list[dict]:
    """Fetch pages from Mem0 v3 get_all and return a flat list.

    ``max_pages`` defaults to ``_MEM0_GET_ALL_DEFAULT_MAX_PAGES`` (=20)
    so a single UI request can't walk an entire heavy user's history
    unbounded — see Codex P2 review on PR #130 R15. Callers that need
    unbounded traversal (e.g. a future reconciliation worker) can pass
    ``max_pages=None`` explicitly; callers that need tighter caps for
    specific endpoints can pass a smaller integer.
    """
    all_results: list[dict] = []
    page_size = max(1, min(page_size, _MEM0_GET_ALL_PAGE_SIZE))
    if max_pages is not None:
        max_pages = max(1, max_pages)
    if max_results is not None:
        max_results = max(1, max_results)
    page = 1
    page_count = 0
    while True:
        if max_pages is not None and page_count >= max_pages:
            break
        if max_results is not None and len(all_results) >= max_results:
            break
        result = client.get_all(filters=filters, page=page, page_size=page_size)
        page_count += 1
        if isinstance(result, dict):
            results = result.get("results", [])
            if isinstance(results, list):
                if max_results is None:
                    all_results.extend(results)
                else:
                    all_results.extend(results[: max_results - len(all_results)])
            elif results:
                all_results.append(results)
            if not result.get("next"):
                break
            page += 1
        elif isinstance(result, list):
            if max_results is None:
                all_results.extend(result)
            else:
                all_results.extend(result[: max_results - len(all_results)])
            break
        else:
            break
    logger.debug(
        "get_all paginated | pages=%d | total=%d | max_pages=%s | max_results=%s",
        page_count,
        len(all_results),
        max_pages,
        max_results,
    )
    return all_results


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


def _local_memory_id_for_content(
    content: str,
    *,
    discriminator: str | None = None,
) -> str | None:
    """Build a stable but per-write-unique local placeholder ID.

    Two queued ``add_memories`` calls with identical text would otherwise
    collide on the same ``local:{sha256(content)}`` ID and overwrite each
    other's review_metadata + ``mem0_event_id`` linkage. Passing the Mem0
    ``event_id`` (or any per-write unique value) as ``discriminator`` salts
    the hash so each pending write gets a distinct local ID. The same call
    with the same ``(content, discriminator)`` is still deterministic, so
    the ID acts as a stable handle for follow-up update/discard calls.

    When no discriminator is provided, fall back to a nanosecond-precision
    timestamp so callers without a known event_id still avoid collisions
    (the only realistic same-nanosecond collision would be two coroutines
    racing inside the same event loop tick with identical content — vanishingly
    rare and still safer than the bare content hash).
    """
    normalized = (content or "").strip()
    if not normalized:
        return None
    disc = discriminator if discriminator else f"ts:{time.time_ns()}"
    composite = f"{normalized}|{disc}".encode()
    return f"local:{hashlib.sha256(composite).hexdigest()}"


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


def _build_session_end_response_from_recap(
    body: SessionEndRequest,
    recap_payload: dict,
    status: str = "pipeline_queued",
) -> SessionEndResponse:
    ended_at = recap_payload.get("ended_at") if isinstance(recap_payload.get("ended_at"), str) else body.ended_at
    started_at = recap_payload.get("started_at") if isinstance(recap_payload.get("started_at"), str) else body.started_at
    turn_count = recap_payload.get("turn_count")
    if not isinstance(turn_count, int):
        turn_count = body.turn_count if body.turn_count is not None else len(body.messages)

    recap_artifacts = recap_payload.get("recap_artifacts")
    if not isinstance(recap_artifacts, dict):
        recap_artifacts = None

    duration_minutes = _compute_duration_minutes(started_at, ended_at)
    debrief_prompt = _build_debrief_prompt(body, recap_artifacts, duration_minutes)
    return SessionEndResponse(
        status=status,
        session_id=body.session_id,
        ended_at=ended_at,
        duration_minutes=duration_minutes,
        turn_count=turn_count,
        recap_artifacts=recap_artifacts,
        offer_debrief=debrief_prompt is not None,
        debrief_prompt=debrief_prompt,
    )


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


def _queue_offline_pipeline(
    user_id: str,
    session_id: str,
    thread_id: str,
    thread_state: dict | None,
    *,
    force_reprocess: bool = False,
) -> None:
    from deerflow.sophia.offline_pipeline import run_offline_pipeline

    logger.info(
        "session.finalization queue_pipeline user_id=%s session_id=%s thread_id=%s has_thread_state=%s message_count=%s artifact_count=%s force_reprocess=%s",
        user_id,
        session_id,
        thread_id,
        thread_state is not None,
        len(thread_state.get("messages", [])) if isinstance(thread_state, dict) else 0,
        len(thread_state.get("artifacts", [])) if isinstance(thread_state, dict) and isinstance(thread_state.get("artifacts"), list) else 0,
        force_reprocess,
    )

    task = asyncio.create_task(
        asyncio.to_thread(
            run_offline_pipeline,
            user_id,
            session_id,
            thread_id,
            thread_state,
            force_reprocess=force_reprocess,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def _mark_session_record_ended(user_id: str, session_id: str, ended_at: str) -> None:
    owner_user_id, record = _resolve_session_record_owner(user_id, session_id)
    if record is None or record.status == "ended":
        return

    ended_record = _session_store.update(
        owner_user_id,
        session_id,
        status="ended",
        ended_at=ended_at,
    )
    if ended_record is None:
        logger.warning(
            "session.finalization failed_to_persist_session_end user_id=%s session_id=%s",
            owner_user_id,
            session_id,
        )


# ---------------------------------------------------------------------------
# 1. Realtime Context
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/realtime/context",
    response_model=RealtimeContextResponse,
    summary="Get bounded realtime context for Sophia voice",
    description="Returns backend-owned setup context for realtime voice sessions.",
)
async def get_realtime_context(
    user_id: str,
    body: RealtimeContextRequest | None = None,
) -> RealtimeContextResponse:
    _validate_user(user_id)
    return await asyncio.to_thread(
        build_sophia_realtime_context,
        user_id=user_id,
        request=body or RealtimeContextRequest(),
    )


@router.post(
    "/{user_id}/realtime/memories/retrieve",
    summary="Retrieve bounded realtime memories for Sophia voice",
    description="Executes query-only realtime memory retrieval using backend-owned Mem0 access.",
)
async def retrieve_realtime_memories(
    user_id: str,
    request: Request,
) -> dict[str, Any]:
    _validate_user(user_id)
    body, error_envelope = await _parse_realtime_memory_retrieve_request(request)
    if error_envelope is not None:
        return error_envelope
    try:
        return await asyncio.to_thread(
            retrieve_sophia_realtime_memories,
            user_id=user_id,
            request=body,
        )
    except Exception:
        logger.warning("sophia.realtime_memory_retrieve public callback failed", exc_info=True)
        return build_realtime_memory_retrieve_error_envelope(
            status="error",
            provider_status="error",
            provider_reason="gateway_retrieval_exception",
            request=body,
            diagnostics={"callback_scope": "public"},
        )


@internal_router.post(
    "/memories/retrieve",
    summary="Internal Gemini realtime memory retrieval callback",
    description="Protected by a gateway-minted session grant; used by sophia-voice only.",
)
async def retrieve_realtime_memories_internal(
    request: Request,
    token: str | None = Header(default=None, alias=REALTIME_MEMORY_RETRIEVAL_TOKEN_HEADER),
) -> dict[str, Any]:
    body, error_envelope = await _parse_realtime_memory_retrieve_request(request)
    if error_envelope is not None:
        return error_envelope
    try:
        return await asyncio.to_thread(
            retrieve_sophia_realtime_memories_for_grant,
            token=token or "",
            request=body,
        )
    except Exception:
        logger.warning("sophia.realtime_memory_retrieve internal callback failed", exc_info=True)
        return build_realtime_memory_retrieve_error_envelope(
            status="error",
            provider_status="error",
            provider_reason="gateway_retrieval_exception",
            request=body,
            diagnostics={"callback_scope": "internal"},
        )


# ---------------------------------------------------------------------------
# 2. Memory List
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
    session_id: str | None = Query(default=None, description="Filter by source session identifier"),
) -> MemoryListResponse:
    _validate_user(user_id)
    try:
        logger.info(
            "session.finalization list_memories_request user_id=%s status=%s session_id=%s",
            user_id,
            status or "<none>",
            session_id or "<none>",
        )
        if session_id and status:
            local_review_memories = _filter_memories_for_review(
                apply_review_metadata_overlays(user_id, []),
                status=status,
                session_id=session_id,
            )
            if local_review_memories:
                local_review_memories = _dedupe_memories_by_id(local_review_memories)
                items = [_to_memory_item(m) for m in local_review_memories]
                logger.info(
                    "session.finalization list_memories_result user_id=%s status=%s session_id=%s count=%s source=local_review_overlay",
                    user_id,
                    status,
                    session_id,
                    len(items),
                )
                return MemoryListResponse(memories=items, count=len(items))

        client = _get_mem0_client()
        memories_raw = _get_all_paginated(client, {"user_id": user_id})
        memories_raw = _hydrate_memories_for_review(
            user_id,
            client,
            memories_raw,
            status,
            hydrate_missing_status=session_id is None,
            hydrate_missing_detail=session_id is None,
        )
        if session_id:
            memories_raw = _filter_memories_for_review(memories_raw, session_id=session_id)
        memories_raw = _dedupe_memories_by_id(memories_raw)
        items = [_to_memory_item(m) for m in memories_raw]
        logger.info(
            "session.finalization list_memories_result user_id=%s status=%s session_id=%s count=%s",
            user_id,
            status or "<none>",
            session_id or "<none>",
            len(items),
        )
        return MemoryListResponse(memories=items, count=len(items))
    except Exception as e:
        logger.warning("Failed to list memories for %s: %s", user_id, e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


# ---------------------------------------------------------------------------
# 3. Memory CRUD
# ---------------------------------------------------------------------------

@router.post(
    "/{user_id}/memories",
    response_model=MemoryItem,
    summary="Create a memory",
)
async def create_memory(user_id: str, body: MemoryCreateRequest, response: Response) -> MemoryItem:
    _validate_user(user_id)
    logger.info(
        "[GwCreate] user_id=%s text_len=%d category=%s metadata_keys=%s",
        user_id,
        len(body.text or ""),
        body.category or "-",
        sorted((body.metadata or {}).keys()),
    )
    try:
        from deerflow.sophia.mem0_client import add_memories_with_outcome

        memory_metadata = dict(body.metadata or {})
        if body.category and "category" not in memory_metadata:
            memory_metadata["category"] = body.category

        # ``add_memories_with_outcome`` is synchronous and can block up to
        # ~30s while it polls Mem0 events to wait for terminal status (see
        # ``wait_for_pending_events`` in mem0_client). Run it in a worker
        # thread so the async route doesn't stall the event loop for any
        # other concurrent requests on this worker. The outcome string
        # (Codex P2 R10) lets us distinguish "Mem0 succeeded but extracted
        # nothing" (200 no-op) from "Mem0 unavailable / failed" (503).
        created, outcome = await asyncio.to_thread(
            add_memories_with_outcome,
            user_id=user_id,
            messages=[{"role": "user", "content": body.text}],
            session_id="manual-create",
            metadata=memory_metadata or None,
        )

        if outcome in ("unavailable", "failed"):
            logger.warning(
                "Mem0 add did not persist for user %s — outcome=%s", user_id, outcome
            )
            raise HTTPException(status_code=503, detail="Memory service unavailable")

        if outcome == "completed_empty":
            # Mem0 processed the input but extracted no memories — a valid
            # outcome for low-signal text (definitions, single words, etc.).
            # Return 200 with a synthesized no-op MemoryItem so the client
            # sees a deterministic application-level result and doesn't
            # retry. (Codex P2 review on PR #130 R10.)
            logger.info(
                "Mem0 create_memory completed empty for user %s — "
                "no extraction (text_len=%d)",
                user_id,
                len(body.text or ""),
            )
            return _no_extraction_memory_item(body.text, memory_metadata)

        if not created:
            # Defensive: outcome was "resolved"/"queued" but the list is
            # empty. Should be unreachable given the contract, but treat
            # as service error rather than silently 200-ing.
            logger.warning(
                "Mem0 add returned empty list with outcome=%s for user %s",
                outcome,
                user_id,
            )
            raise HTTPException(status_code=503, detail="Memory service unavailable")

        first = created[0]
        if isinstance(first, dict) and _is_memory_record(first) and first.get("id"):
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

        pending_item = _pending_memory_item_from_add_result(
            first,
            content=body.text,
            metadata=memory_metadata,
            session_id="manual-create",
        )
        if pending_item is not None:
            response.status_code = 202
            upsert_review_metadata(
                user_id,
                content=body.text,
                content_hash=_local_content_hash_from_memory_id(pending_item.id),
                metadata=pending_item.metadata,
                session_id="manual-create",
                sync_state="pending",
            )
            logger.info(
                "Mem0 create_memory queued async add for user %s event_id=%s",
                user_id,
                pending_item.metadata.get("mem0_event_id") if pending_item.metadata else None,
            )
            return pending_item

        # add_memories returned neither a resolved memory nor a queued event.
        logger.warning(
            "Mem0 create_memory returned non-memory for user %s: %s",
            user_id,
            first,
        )
        raise HTTPException(status_code=503, detail="Memory service unavailable")
    except HTTPException:
        raise
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
                memories_raw = _get_all_paginated(client, filters)
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
            memories_raw = _get_all_paginated(client, filters)
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
        memories_raw = _get_all_paginated(client, {"user_id": user_id, "categories": "decision"})
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
        memories_raw = _get_all_paginated(client, {"user_id": user_id, "categories": "commitment"})
        items = [_to_memory_item(m) for m in memories_raw]
        return CategoryMemoryResponse(memories=items, count=len(items))
    except Exception as e:
        logger.warning("Visual commitments failed: %s", e)
        raise HTTPException(status_code=503, detail="Memory service unavailable")


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
async def get_task_status(user_id: str, task_id: str) -> TaskStatusResponse:
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
            raise HTTPException(status_code=404, detail="Task not found")
        persisted_payload.pop("owner_id", None)
        return TaskStatusResponse(**persisted_payload)

    status_value = result.status.value
    progress_payload = build_subagent_progress_payload(result)
    builder_result = _extract_builder_result_from_task_result(result)
    detail = _build_task_status_detail(result, progress_payload, builder_result)

    return TaskStatusResponse(
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
    ended_at = body.ended_at or datetime.now(UTC).isoformat()

    logger.info(
        "session.finalization end_session_request user_id=%s session_id=%s thread_id=%s message_count=%s has_recap_artifacts=%s",
        user_id,
        body.session_id,
        body.thread_id,
        len(body.messages or []),
        body.recap_artifacts is not None,
    )

    try:
        existing_recap = _read_session_recap(user_id, body.session_id)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "session.finalization existing_recap_read_failed user_id=%s session_id=%s error=%s",
            user_id,
            body.session_id,
            exc,
        )
        existing_recap = None

    if isinstance(existing_recap, dict):
        existing_ended_at = existing_recap.get("ended_at") if isinstance(existing_recap.get("ended_at"), str) else ended_at
        _mark_session_record_ended(user_id, body.session_id, existing_ended_at)
        try:
            from app.gateway.inactivity_watcher import unregister_thread
            unregister_thread(body.thread_id)
        except ImportError:
            pass

        logger.info(
            "session.finalization duplicate_suppressed user_id=%s session_id=%s thread_id=%s duplicateFinalizationSuppressed=%s recapPipelineQueued=%s",
            user_id,
            body.session_id,
            body.thread_id,
            True,
            False,
        )
        return _build_session_end_response_from_recap(
            body,
            existing_recap,
            status="pipeline_queued",
        )

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

    _mark_session_record_ended(user_id, body.session_id, ended_at)

    # Remove from inactivity tracking — session explicitly ended
    try:
        from app.gateway.inactivity_watcher import unregister_thread
        unregister_thread(body.thread_id)
    except ImportError:
        pass

    try:
        # force_reprocess=True so an explicit "End Session" click always
        # re-runs the pipeline, even if an earlier inactivity_watcher fire
        # processed a thinner version of the same session. The two-stage
        # idempotency in run_offline_pipeline serializes concurrent calls
        # via `_in_flight_sessions` so this is safe.
        _queue_offline_pipeline(
            user_id,
            body.session_id,
            body.thread_id,
            _build_thread_state_from_end_request(body),
            force_reprocess=True,
        )
        logger.info(
            "session.finalization end_session_queued user_id=%s session_id=%s thread_id=%s recapPipelineQueued=%s",
            user_id,
            body.session_id,
            body.thread_id,
            True,
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
