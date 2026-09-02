"""Sophia API router for memory management, reflect, journal, visual artifacts, and session control."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

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
from app.gateway.voice_lab_capability import (
    VoiceLabClaims,
    assert_voice_lab_session_record,
    capability_for_gateway_action,
)
from deerflow.agents.sophia_agent.paths import USERS_DIR
from deerflow.agents.sophia_agent.utils import safe_user_path
from deerflow.sophia.memory_governance.store import MemoryGovernanceConflict
from deerflow.sophia.review_metadata_store import (
    apply_review_metadata_overlays,
    remove_review_metadata,
    upsert_review_metadata,
)
from deerflow.sophia.session_store import (
    SessionMessageRecord,
    SessionRecord,
    SessionStore,
    SessionStoreError,
    canonical_visible_messages,
    derive_message_id,
)

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
    """Get the flags-off Mem0 compatibility facade or raise 503."""
    try:
        from deerflow.sophia.memory_governance.mem0_projection_adapter import LegacyMem0Facade

        api_key = os.environ.get("MEM0_API_KEY")
        if not api_key:
            raise HTTPException(status_code=503, detail="MEM0_API_KEY not configured")
        client = LegacyMem0Facade()
        client.ensure_client()
        return client
    except ImportError:
        raise HTTPException(status_code=503, detail="mem0 package not installed")


def _memory_flags(user_id: str):
    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )

    return memory_feature_flags_for_owner(user_id)


def _canonical_memory_service(user_id: str):
    from deerflow.sophia.memory_governance.service import CanonicalMemoryService

    return CanonicalMemoryService(owner_id=user_id)


def _canonical_to_memory_item(memory) -> MemoryItem:
    return MemoryItem(
        id=str(memory.memory_id),
        content=memory.canonical_content or "",
        category=memory.category,
        metadata={
            "lifecycle": memory.lifecycle,
            "tier": memory.user_tier,
            "scope": memory.scope,
            "content_revision": memory.current_content_revision,
            "memory_governance_revision": memory.memory_governance_revision,
            "projection_state": memory.projection_state,
            "authority": "sophia_canonical",
        },
        created_at=str(memory.created_at) if memory.created_at else None,
        updated_at=str(memory.updated_at) if memory.updated_at else None,
    )


def _resolve_session_record_owner(user_id: str, session_id: str) -> tuple[str, SessionRecord | None]:
    """Resolve the persisted session owner.

    The legacy ``dev-user`` fallback is allowed only by the filesystem local/dev
    store. Supabase production reads are scoped strictly by trusted backend
    ``user_id``.
    """
    record = _session_store.get(user_id, session_id)
    if record is not None:
        return user_id, record

    if user_id == _LEGACY_SESSION_USER_ID or not getattr(
        _session_store,
        "allow_legacy_dev_user_fallback",
        True,
    ):
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
    source: str = Field(default="unknown", description="Safe diagnostic source classification")
    candidate_count: int = Field(default=0, description="Safe diagnostic candidate count")
    session_id_received: bool = Field(default=False, description="Whether a diagnostic session_id query param was received")
    local_overlay_count: int = Field(default=0, description="Count of local review overlay entries returned or applied")
    skipped_mem0_hydration_for_session_scope: bool = Field(
        default=False,
        description="Whether local review metadata supplied enough status metadata to skip per-memory hydration",
    )
    empty_reason: str | None = Field(default=None, description="Safe empty-result reason for terminal empty responses")
    trace_id: str | None = Field(default=None, description="Safe request correlation id")


class MemoryUpdateRequest(BaseModel):
    text: str | None = Field(default=None, description="Updated memory text")
    metadata: dict | None = Field(default=None, description="Updated metadata")
    expected_content_revision: int | None = Field(default=None, gt=0)
    expected_governance_revision: int | None = Field(default=None, gt=0)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)


class MemoryCreateRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Memory content text")
    category: str | None = Field(default=None, description="Optional memory category")
    metadata: dict | None = Field(default=None, description="Optional memory metadata")
    scope: str = Field(default="global", min_length=1, max_length=80)
    tier: Literal["conscious", "subconscious", "none"] = "none"
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)


class LegacyMemoryImportRequest(BaseModel):
    provider_memory_id: str = Field(min_length=1, max_length=256)
    approval_evidence_ref: str = Field(pattern=r"^hmac-sha256:[a-z0-9._-]+:[a-f0-9]{64}$")
    text: str = Field(min_length=1)
    category: str = Field(default="fact", min_length=1, max_length=80)
    scope: str = Field(default="global", min_length=1, max_length=80)
    tier: Literal["conscious", "subconscious", "none"] = "none"
    idempotency_key: str = Field(min_length=8, max_length=200)


class BulkReviewItem(BaseModel):
    id: str = Field(..., description="Memory ID")
    action: Literal["approve", "discard"] = Field(..., description="Action to take")
    expected_candidate_revision: int | None = Field(default=None, gt=0)
    reviewed_text: str | None = Field(default=None, min_length=1)
    category: str = "fact"
    scope: str = "global"
    tier: Literal["conscious", "subconscious", "none"] = "none"
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)


class BulkReviewRequest(BaseModel):
    items: list[BulkReviewItem] = Field(..., description="List of review actions")


class BulkReviewResult(BaseModel):
    id: str
    action: str
    status: str = "ok"
    error: str | None = None


class BulkReviewResponse(BaseModel):
    results: list[BulkReviewResult] = Field(default_factory=list)


class MemoryLifecycleRequest(BaseModel):
    expected_governance_revision: int = Field(gt=0)
    idempotency_key: str = Field(min_length=8, max_length=200)


class MemoryGovernanceReceiptResponse(BaseModel):
    status: str
    memory_id: str
    content_revision: int | None = None
    memory_governance_revision: int | None = None
    user_catalog_generation: int
    user_revocation_epoch: int
    provider_purge: str | None = None
    canonical_memory_fence: str | None = None
    source_transcript: str | None = None
    derived_artifacts: str | None = None
    cache_invalidation: str | None = None
    other_account_data: str = "not_covered_by_mem00"


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
    id: str | None = Field(default=None, description="Stable client message ID")
    message_id: str | None = Field(default=None, description="Stable provider/backend message ID")
    role: str = Field(..., description="Message role")
    content: str = Field(default="", description="Message text content")
    created_at: str | None = Field(default=None, description="Client timestamp")
    source: str | None = Field(default=None, description="Client/source transport")
    final: bool | None = Field(default=None, description="Whether message content is finalized")
    incomplete: bool | None = Field(default=None, description="Whether message was interrupted mid-stream")
    approximate: bool | None = Field(default=None, description="Whether content is approximate")
    turn_id: str | None = Field(default=None, description="Stable turn ID")
    provider_event_id: str | None = Field(default=None, description="Stable provider event ID")
    redaction_level: str = Field(default="none", description="Redaction level")


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
    base_revision: int | None = Field(
        default=None,
        ge=0,
        description="Authoritative transcript revision used by the ending client",
    )
    messages: list[SessionMessageInput] = Field(default_factory=list)
    recap_artifacts: SessionRecapArtifactsPayload | None = Field(default=None)


class SyntheticFinalizationEvidenceReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    storage: Literal["postgres_session", "supabase", "local_ephemeral"]
    object_path: str = Field(min_length=1, max_length=1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class SyntheticTranscriptExpectedDeployment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    frontend: str = Field(min_length=1, max_length=256)
    backend: str = Field(min_length=1, max_length=256)
    voice: str = Field(min_length=1, max_length=256)


class SyntheticCanonicalTranscriptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(min_length=1, max_length=256)
    sequence: int = Field(gt=0)
    role: Literal["user", "assistant"]
    content: str
    created_at: str = Field(min_length=1)
    source: str = Field(min_length=1, max_length=128)
    final: bool
    approximate: bool
    turn_id: str | None = None
    provider_event_id: str | None = None
    redaction_level: str


class SyntheticCanonicalTurnBoundary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turn_id: str | None = None
    first_sequence: int = Field(gt=0)
    last_sequence: int = Field(gt=0)
    input_message_count: int = Field(ge=0)
    output_message_count: int = Field(ge=0)


class SyntheticCanonicalTranscript(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema: Literal["sophia_voice_lab_canonical_transcript_v1"]
    source: Literal["sophia_session_messages"]
    synthetic: Literal[True]
    principal_id: str = Field(min_length=1, max_length=256)
    test_run_id: str = Field(min_length=1, max_length=256)
    scenario_id: str = Field(min_length=1, max_length=256)
    scenario_version: str = Field(min_length=1, max_length=256)
    environment: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    expected_deployment: SyntheticTranscriptExpectedDeployment
    message_revision: int = Field(ge=0)
    message_count: int = Field(ge=0)
    input_message_count: int = Field(ge=0)
    output_message_count: int = Field(ge=0)
    turn_boundary_count: int = Field(ge=0)
    digest_algorithm: Literal["sha-256"]
    canonicalization: Literal["utf8-json-sort-keys-compact-ascii-v1"]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    finalized_at: str = Field(min_length=1)
    retention_hours: int = Field(ge=1, le=168)
    retention_anchor: Literal["finalized_at"]
    retention_expires_at: str = Field(min_length=1)
    provider_expires_at: str = Field(min_length=1)
    cleanup_obligation_id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    raw_audio_excluded: Literal[True]
    messages: list[SyntheticCanonicalTranscriptMessage]
    turn_boundaries: list[SyntheticCanonicalTurnBoundary]

    @model_validator(mode="after")
    def validate_canonical_identity(self) -> SyntheticCanonicalTranscript:
        canonical_messages = [message.model_dump(mode="json") for message in self.messages]
        canonical_bytes = json.dumps(
            canonical_messages,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
        input_count = sum(message.role == "user" for message in self.messages)
        output_count = sum(message.role == "assistant" for message in self.messages)
        sequences = [message.sequence for message in self.messages]
        finalized_at = _parse_exact_utc_millis(self.finalized_at)
        retention_expires_at = _parse_exact_utc_millis(self.retention_expires_at)
        provider_expires_at = _parse_exact_utc_millis(self.provider_expires_at)
        if (
            self.message_count != len(self.messages)
            or self.input_message_count != input_count
            or self.output_message_count != output_count
            or self.turn_boundary_count != len(self.turn_boundaries)
            or sequences != list(range(1, len(self.messages) + 1))
            or self.sha256 != hashlib.sha256(canonical_bytes).hexdigest()
            or finalized_at is None
            or retention_expires_at is None
            or provider_expires_at is None
            or provider_expires_at > retention_expires_at
            or retention_expires_at != finalized_at + timedelta(hours=self.retention_hours)
        ):
            raise ValueError("canonical transcript identity mismatch")
        return self


class SessionEndResponse(BaseModel):
    status: str = Field(default="pipeline_queued")
    session_id: str = Field(default="")
    ended_at: str | None = Field(default=None)
    duration_minutes: int = Field(default=0)
    turn_count: int = Field(default=0)
    recap_artifacts: dict | None = Field(default=None)
    offer_debrief: bool = Field(default=False)
    debrief_prompt: str | None = Field(default=None)
    synthetic_isolated: bool = Field(default=False)
    test_run_id: str | None = Field(default=None)
    finalized_at: str | None = Field(default=None)
    retention_hours: int | None = Field(default=None, ge=1, le=168)
    retention_anchor: Literal["finalized_at"] | None = Field(default=None)
    retention_expires_at: str | None = Field(default=None)
    provider_expires_at: str | None = Field(default=None)
    cleanup_obligation_id: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    exclusions: dict[str, bool] | None = Field(default=None)
    evidence_receipt: SyntheticFinalizationEvidenceReceipt | None = Field(default=None)
    canonical_transcript: SyntheticCanonicalTranscript | None = Field(default=None)

    @model_validator(mode="after")
    def require_synthetic_finalization_evidence(self) -> SessionEndResponse:
        if self.synthetic_isolated and (
            self.evidence_receipt is None
            or self.canonical_transcript is None
            or self.finalized_at is None
            or self.retention_hours is None
            or self.retention_anchor != "finalized_at"
            or self.retention_expires_at is None
            or self.provider_expires_at is None
            or self.cleanup_obligation_id is None
        ):
            raise ValueError("synthetic finalization evidence is required")
        if self.synthetic_isolated:
            finalized_at = _parse_exact_utc_millis(self.finalized_at)
            retention_expires_at = _parse_exact_utc_millis(self.retention_expires_at)
            provider_expires_at = _parse_exact_utc_millis(self.provider_expires_at)
            if (
                finalized_at is None
                or retention_expires_at is None
                or provider_expires_at is None
                or provider_expires_at > retention_expires_at
                or retention_expires_at != finalized_at + timedelta(hours=self.retention_hours or 0)
                or self.canonical_transcript is None
                or self.canonical_transcript.finalized_at != self.finalized_at
                or self.canonical_transcript.retention_hours != self.retention_hours
                or self.canonical_transcript.retention_anchor != self.retention_anchor
                or self.canonical_transcript.retention_expires_at != self.retention_expires_at
                or self.canonical_transcript.provider_expires_at != self.provider_expires_at
                or self.canonical_transcript.cleanup_obligation_id != self.cleanup_obligation_id
            ):
                raise ValueError("synthetic finalization retention mismatch")
        return self


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
    return isinstance(mem, dict) and (mem.get("metadata") is None or (not mem.get("categories") and mem.get("category") is None))


def _has_memory_status(mem: dict) -> bool:
    metadata = mem.get("metadata") if isinstance(mem, dict) else None
    return isinstance(metadata, dict) and isinstance(metadata.get("status"), str)


def _memory_session_id(memory: dict) -> str | None:
    session_id = memory.get("session_id") if isinstance(memory, dict) else None
    if isinstance(session_id, str) and session_id:
        return session_id

    metadata = memory.get("metadata") if isinstance(memory, dict) else None
    metadata_session_id = metadata.get("session_id") if isinstance(metadata, dict) else None
    return metadata_session_id if isinstance(metadata_session_id, str) and metadata_session_id else None


def _hydrate_memories_for_review(
    user_id: str,
    client,
    memories: list[dict],
    status: str | None,
    *,
    session_id: str | None = None,
) -> tuple[list[dict], dict[str, Any]]:
    scoped_overlay_session_id = session_id if status == "pending_review" else None
    memories = apply_review_metadata_overlays(user_id, memories, session_id=scoped_overlay_session_id)
    local_overlay_count = sum(1 for memory in memories if isinstance(memory, dict) and isinstance(memory.get("id"), str) and memory["id"].startswith("local:"))

    if session_id and status == "pending_review":
        filtered = [memory for memory in memories if isinstance(memory, dict) and isinstance(memory.get("metadata"), dict) and memory["metadata"].get("status") == status and _memory_session_id(memory) == session_id]
        return filtered, {
            "source": "local_review_overlay",
            "local_overlay_count": local_overlay_count,
            "detail_hydration_count": 0,
            "skipped_detail_hydration_count": len(memories),
            "skipped_mem0_hydration_for_session_scope": True,
            "empty_reason": "no_session_candidates" if not filtered else None,
        }

    detail_hydration_count = 0
    skipped_detail_hydration_count = 0
    hydrated: list[dict] = []

    for memory in memories:
        merged_memory = memory
        memory_id = memory.get("id") if isinstance(memory, dict) else None
        has_status = status is not None and _has_memory_status(memory)

        needs_hydration = memory_id and ((status is not None and not has_status) or (_should_hydrate_memory_detail(memory) and not has_status))

        if needs_hydration:
            detail_hydration_count += 1
            try:
                merged_memory = _merge_memory_detail(memory, client.get(memory_id))
            except Exception:
                logger.warning("Failed to hydrate memory detail for %s", memory_id, exc_info=True)
        elif status is not None and has_status:
            skipped_detail_hydration_count += 1

        hydrated.append(merged_memory)

    hydrated = apply_review_metadata_overlays(user_id, hydrated, session_id=scoped_overlay_session_id)
    local_overlay_count = max(
        local_overlay_count,
        sum(1 for memory in hydrated if isinstance(memory, dict) and isinstance(memory.get("id"), str) and memory["id"].startswith("local:")),
    )

    if not status:
        filtered = hydrated
    else:
        filtered = [memory for memory in hydrated if isinstance(memory.get("metadata"), dict) and memory["metadata"].get("status") == status]

    if session_id and status == "pending_review":
        filtered = [memory for memory in filtered if _memory_session_id(memory) == session_id]

    if not filtered:
        source = "none"
    elif local_overlay_count > 0 or skipped_detail_hydration_count > 0:
        source = "local_review_overlay"
    elif detail_hydration_count > 0:
        source = "global_hydration"
    else:
        source = "mem0"

    return filtered, {
        "source": source,
        "local_overlay_count": local_overlay_count,
        "detail_hydration_count": detail_hydration_count,
        "skipped_detail_hydration_count": skipped_detail_hydration_count,
        "skipped_mem0_hydration_for_session_scope": skipped_detail_hydration_count > 0,
        "empty_reason": "no_session_candidates" if session_id and status == "pending_review" and not filtered else None,
    }


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


_SYNTHETIC_FINALIZATION_EXCLUSIONS = {
    "memory": True,
    "offline_pipeline": True,
    "learning": True,
    "ordinary_product_analytics": True,
    "ordinary_user_projects": True,
    "shared_spaces": True,
    "debrief": True,
}

_SYNTHETIC_TRANSCRIPT_MAX_MESSAGES = 512
_SYNTHETIC_TRANSCRIPT_MAX_MESSAGE_BYTES = 32 * 1024
_SYNTHETIC_TRANSCRIPT_MAX_TOTAL_BYTES = 1024 * 1024


def _canonical_utc_millis(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_exact_utc_millis(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(UTC)
    return normalized if _canonical_utc_millis(normalized) == value else None


def _synthetic_message_metadata(
    record: SessionRecord,
    claims: VoiceLabClaims,
) -> dict[str, Any]:
    record_metadata = record.metadata if isinstance(record.metadata, dict) else {}
    synthetic = record_metadata.get("synthetic_voice_lab")
    retention_expires_at = synthetic.get("retention_expires_at") if isinstance(synthetic, dict) else None
    if not isinstance(retention_expires_at, str) or not retention_expires_at:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_session_retention_missing"},
        )
    return {
        **claims.synthetic_context(),
        "scenario_version": claims.scenario_version,
        "expected_deployment": dict(claims.expected_deployment),
        "retention_hours": synthetic.get("retention_hours"),
        "retention_anchor": synthetic.get("retention_anchor"),
        **({"finalized_at": synthetic.get("finalized_at")} if isinstance(synthetic.get("finalized_at"), str) else {}),
        "retention_expires_at": retention_expires_at,
        "memory_retrieval_excluded": True,
        "memory_learning_excluded": True,
        "offline_pipeline_excluded": True,
        "ordinary_analytics_excluded": True,
        "ordinary_projects_excluded": True,
        "shared_spaces_excluded": True,
    }


def _validate_synthetic_finalization_transcript(body: SessionEndRequest) -> None:
    if len(body.messages) > _SYNTHETIC_TRANSCRIPT_MAX_MESSAGES:
        raise HTTPException(
            status_code=413,
            detail={"code": "voice_lab_transcript_too_large"},
        )
    total_bytes = 0
    for message in body.messages:
        content_bytes = len(message.content.encode("utf-8"))
        if content_bytes > _SYNTHETIC_TRANSCRIPT_MAX_MESSAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail={"code": "voice_lab_transcript_too_large"},
            )
        total_bytes += content_bytes
        if total_bytes > _SYNTHETIC_TRANSCRIPT_MAX_TOTAL_BYTES:
            raise HTTPException(
                status_code=413,
                detail={"code": "voice_lab_transcript_too_large"},
            )


def _synthetic_finalization_messages(
    user_id: str,
    body: SessionEndRequest,
    record: SessionRecord,
    claims: VoiceLabClaims,
) -> tuple[list[SessionMessageRecord], int]:
    """Build a bounded transcript without performing a pre-finalization write."""

    _validate_synthetic_finalization_transcript(body)
    existing = canonical_visible_messages(_session_store.list_messages(user_id, body.session_id))
    if not body.messages:
        return existing, max(0, int(record.message_revision))
    if body.base_revision is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_transcript_base_revision_required"},
        )
    return (
        canonical_visible_messages(_synthetic_records_from_end_request(body, record, claims)),
        body.base_revision,
    )


def _synthetic_records_from_end_request(
    body: SessionEndRequest,
    record: SessionRecord,
    claims: VoiceLabClaims,
) -> list[SessionMessageRecord]:
    message_metadata = _synthetic_message_metadata(record, claims)
    records: list[SessionMessageRecord] = []
    for message in body.messages:
        content = message.content.strip()
        role = "assistant" if message.role in {"assistant", "sophia"} else message.role
        is_final = message.final if message.final is not None else not bool(message.incomplete)
        if not content or role not in {"user", "assistant"} or not is_final:
            continue
        sequence = len(records) + 1
        records.append(
            SessionMessageRecord(
                message_id=derive_message_id(
                    session_id=body.session_id,
                    role=role,
                    sequence=sequence,
                    message_id=message.message_id or message.id,
                    turn_id=message.turn_id,
                    provider_event_id=message.provider_event_id,
                    content=content,
                ),
                session_id=body.session_id,
                thread_id=record.thread_id,
                role=role,
                content=content,
                created_at=_canonical_synthetic_message_timestamp(message.created_at or _canonical_utc_millis(datetime.now(UTC))),
                source=message.source or body.platform or record.platform or "voice",
                final=True,
                approximate=bool(message.approximate),
                turn_id=message.turn_id,
                provider_event_id=message.provider_event_id,
                sequence=sequence,
                redaction_level=message.redaction_level,
                metadata=dict(message_metadata),
            )
        )
    return records


def _synthetic_message_replay_identity(
    message: SessionMessageRecord,
) -> tuple[object, ...]:
    return (
        message.message_id,
        message.sequence,
        message.role,
        message.content,
        message.source,
        message.final,
        message.approximate,
        message.turn_id,
        message.provider_event_id,
        message.redaction_level,
    )


def _assert_synthetic_terminal_transcript_replay(
    user_id: str,
    body: SessionEndRequest,
    record: SessionRecord,
    claims: VoiceLabClaims,
) -> tuple[SessionRecord, list[SessionMessageRecord]]:
    """Verify a terminal retry without granting any transcript mutation."""
    stored = canonical_visible_messages(_session_store.list_messages(user_id, body.session_id))
    current = _session_store.get(user_id, body.session_id) or record
    if body.messages:
        _validate_synthetic_finalization_transcript(body)
        incoming = canonical_visible_messages(_synthetic_records_from_end_request(body, current, claims))
        if [_synthetic_message_replay_identity(message) for message in incoming] != [_synthetic_message_replay_identity(message) for message in stored]:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_finalization_transcript_conflict"},
            )

    return current, stored


def _assert_synthetic_provisional_retention_open(
    record: SessionRecord,
    *,
    now: datetime | None = None,
) -> None:
    synthetic = record.metadata.get("synthetic_voice_lab") if isinstance(record.metadata, dict) else None
    deadline = _parse_exact_utc_millis(synthetic.get("retention_expires_at")) if isinstance(synthetic, dict) and synthetic.get("retention_anchor") == "session_created_at_provisional" else None
    if deadline is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "voice_lab_provisional_retention_binding_invalid"},
        )
    observed_at = (now or datetime.now(UTC)).astimezone(UTC)
    if observed_at >= deadline:
        raise HTTPException(
            status_code=410,
            detail={"code": "voice_lab_provisional_retention_expired"},
        )


def _finalize_synthetic_session_atomically(
    user_id: str,
    body: SessionEndRequest,
    record: SessionRecord,
    claims: VoiceLabClaims,
    *,
    authoritative_messages: list[SessionMessageRecord] | None = None,
) -> tuple[
    SessionRecord,
    list[SessionMessageRecord],
    dict[str, object],
    dict[str, str],
]:
    """Commit transcript, lifecycle, retention, and CLOSED as one boundary."""

    if authoritative_messages is None:
        messages, expected_revision = _synthetic_finalization_messages(
            user_id,
            body,
            record,
            claims,
        )
    else:
        # Terminal retries are read-only. Reuse committed rows (including
        # DB-authoritative timestamps) after the caller compared the incoming
        # content identity to this snapshot.
        messages = canonical_visible_messages(authoritative_messages)
        expected_revision = max(0, int(record.message_revision))
    message_metadata_base: dict[str, object] = {
        **claims.synthetic_context(),
        "scenario_version": claims.scenario_version,
        "expected_deployment": dict(claims.expected_deployment),
        "memory_retrieval_excluded": True,
        "memory_learning_excluded": True,
        "offline_pipeline_excluded": True,
        "ordinary_analytics_excluded": True,
        "ordinary_projects_excluded": True,
        "shared_spaces_excluded": True,
    }
    canonical_transcript_json = _canonical_synthetic_messages_json(messages)
    canonical_transcript_sha256 = hashlib.sha256(canonical_transcript_json.encode("utf-8")).hexdigest()
    try:
        started_at = datetime.fromisoformat(str(body.started_at or record.created_at).replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_finalization_started_at_invalid"},
        ) from exc
    if started_at.tzinfo is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_finalization_started_at_invalid"},
        )
    finalization_started_at = _canonical_utc_millis(started_at)
    turn_count = body.turn_count if body.turn_count is not None else len(messages)
    try:
        result = _session_store.finalize_synthetic_session(
            user_id,
            record.session_id,
            messages,
            expected_revision=expected_revision,
            cleanup_obligation_id=claims.cleanup_obligation_id,
            provider_expires_at=claims.provider_expires_at,
            retention_hours=claims.retention_hours,
            expected_synthetic_binding=claims.synthetic_context(),
            expected_deployment=dict(claims.expected_deployment),
            message_metadata_base=message_metadata_base,
            canonical_transcript_sha256=canonical_transcript_sha256,
            canonical_transcript_json=canonical_transcript_json,
            finalization_started_at=finalization_started_at,
            turn_count=turn_count,
            capability_jti_sha256=hashlib.sha256(claims.jti.encode("utf-8")).hexdigest(),
        )
    except (OSError, RuntimeError, SessionStoreError) as exc:
        reason = str(exc).lower()
        if "provisional" in reason and ("expired" in reason or "deadline" in reason):
            status_code = 410
            code = "voice_lab_provisional_retention_expired"
        elif "revision" in reason:
            status_code = 409
            code = "voice_lab_transcript_revision_conflict"
        elif any(marker in reason for marker in ("closed", "unavailable", "binding", "conflict")):
            status_code = 409
            code = "voice_lab_finalization_unavailable"
        else:
            status_code = 503
            code = "voice_lab_finalization_transaction_failed"
        raise HTTPException(status_code=status_code, detail={"code": code}) from exc
    retention_fields: dict[str, object] = {
        "finalized_at": result.finalized_at,
        "retention_hours": claims.retention_hours,
        "retention_anchor": "finalized_at",
        "retention_expires_at": result.retention_expires_at,
    }
    if _canonical_synthetic_messages_sha256(result.messages) != canonical_transcript_sha256:
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_finalization_readback_conflict"},
        )
    return result.record, result.messages, retention_fields, result.evidence_receipt


def _canonical_synthetic_messages(
    messages: list[SessionMessageRecord],
) -> list[dict[str, object]]:
    return [
        {
            "message_id": message.message_id,
            "sequence": message.sequence,
            "role": message.role,
            "content": message.content,
            "created_at": _canonical_synthetic_message_timestamp(message.created_at),
            "source": message.source,
            "final": message.final,
            "approximate": message.approximate,
            "turn_id": message.turn_id,
            "provider_event_id": message.provider_event_id,
            "redaction_level": message.redaction_level,
        }
        for message in messages
    ]


def _canonical_synthetic_message_timestamp(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_message_timestamp_invalid"},
        ) from exc
    if parsed.tzinfo is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "voice_lab_message_timestamp_invalid"},
        )
    return _canonical_utc_millis(parsed)


def _canonical_synthetic_messages_json(
    messages: list[SessionMessageRecord],
) -> str:
    return json.dumps(
        _canonical_synthetic_messages(messages),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )


def _canonical_synthetic_messages_sha256(
    messages: list[SessionMessageRecord],
) -> str:
    return hashlib.sha256(_canonical_synthetic_messages_json(messages).encode("utf-8")).hexdigest()


def _synthetic_transcript_evidence(
    record: SessionRecord,
    messages: list[SessionMessageRecord],
    claims: VoiceLabClaims,
) -> dict[str, Any]:
    canonical_messages = _canonical_synthetic_messages(messages)
    synthetic = record.metadata.get("synthetic_voice_lab", {})
    turn_boundaries: list[dict[str, Any]] = []
    for message in canonical_messages:
        turn_id = message["turn_id"]
        boundary = next(
            (candidate for candidate in reversed(turn_boundaries) if candidate["turn_id"] == turn_id and candidate["last_sequence"] == message["sequence"] - 1),
            None,
        )
        if boundary is None:
            boundary = {
                "turn_id": turn_id,
                "first_sequence": message["sequence"],
                "last_sequence": message["sequence"],
                "input_message_count": 0,
                "output_message_count": 0,
            }
            turn_boundaries.append(boundary)
        boundary["last_sequence"] = message["sequence"]
        boundary["input_message_count" if message["role"] == "user" else "output_message_count"] += 1
    payload = {
        "schema": "sophia_voice_lab_canonical_transcript_v1",
        "source": "sophia_session_messages",
        "synthetic": True,
        "principal_id": claims.principal_id,
        "test_run_id": claims.test_run_id,
        "scenario_id": claims.scenario_id,
        "scenario_version": claims.scenario_version,
        "environment": claims.environment,
        "session_id": record.session_id,
        "thread_id": record.thread_id,
        "expected_deployment": dict(claims.expected_deployment),
        "message_revision": max(0, int(record.message_revision)),
        "message_count": len(canonical_messages),
        "input_message_count": sum(1 for message in canonical_messages if message["role"] == "user"),
        "output_message_count": sum(1 for message in canonical_messages if message["role"] == "assistant"),
        "turn_boundary_count": len(turn_boundaries),
        "digest_algorithm": "sha-256",
        "canonicalization": "utf8-json-sort-keys-compact-ascii-v1",
        "sha256": _canonical_synthetic_messages_sha256(messages),
        "finalized_at": synthetic.get("finalized_at"),
        "retention_hours": synthetic.get("retention_hours"),
        "retention_anchor": synthetic.get("retention_anchor"),
        "retention_expires_at": synthetic.get("retention_expires_at"),
        "provider_expires_at": claims.provider_expires_at,
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "raw_audio_excluded": True,
        "messages": canonical_messages,
        "turn_boundaries": turn_boundaries,
    }
    try:
        return SyntheticCanonicalTranscript.model_validate(payload).model_dump(mode="json")
    except ValidationError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_canonical_transcript_invalid"},
        ) from exc


def _synthetic_finalization_path(user_id: str, cleanup_obligation_id: str) -> Path:
    return safe_user_path(
        USERS_DIR,
        user_id,
        "synthetic_voice_lab",
        "finalizations",
        f"{cleanup_obligation_id}.json",
    )


def _synthetic_finalization_object_path(payload: dict[str, Any]) -> str:
    return f".builder/voice_lab_evidence/finalizations/v2/{payload['cleanup_obligation_id']}.json"


def _synthetic_finalization_identity(payload: dict[str, Any]) -> tuple[object, ...]:
    transcript = payload.get("canonical_transcript")
    transcript_identity = (
        (
            transcript.get("message_revision"),
            transcript.get("message_count"),
            transcript.get("sha256"),
            transcript.get("finalized_at"),
            transcript.get("retention_hours"),
            transcript.get("retention_anchor"),
            transcript.get("retention_expires_at"),
            transcript.get("provider_expires_at"),
        )
        if isinstance(transcript, dict)
        else None
    )
    return (
        payload.get("schema"),
        payload.get("principal_id"),
        payload.get("test_run_id"),
        payload.get("cleanup_obligation_id"),
        payload.get("scenario_id"),
        payload.get("scenario_version"),
        payload.get("environment"),
        payload.get("session_id"),
        payload.get("thread_id"),
        payload.get("expected_deployment"),
        transcript_identity,
    )


def _postgres_synthetic_finalization_payload(
    claims: VoiceLabClaims,
    record: SessionRecord,
    canonical_transcript: dict[str, Any],
    evidence_receipt: dict[str, str],
) -> tuple[dict[str, Any], dict[str, str]]:
    """Read back the immutable finalization projection committed by Postgres."""

    synthetic = record.metadata.get("synthetic_voice_lab") if isinstance(record.metadata, dict) else None
    stored = synthetic.get("finalization_receipt") if isinstance(synthetic, dict) else None
    if (
        not isinstance(stored, dict)
        or stored.get("schema") != "sophia_voice_lab_postgres_finalization_receipt_v1"
        or stored.get("storage") != "postgres_session"
        or stored.get("cleanup_obligation_id") != claims.cleanup_obligation_id
        or stored.get("transcript_sha256") != canonical_transcript.get("sha256")
        or stored.get("finalized_at") != canonical_transcript.get("finalized_at")
        or stored.get("retention_expires_at") != canonical_transcript.get("retention_expires_at")
        or stored.get("provider_expires_at") != claims.provider_expires_at
        or stored.get("message_revision") != canonical_transcript.get("message_revision")
        or stored.get("message_count") != canonical_transcript.get("message_count")
        or not isinstance(stored.get("started_at"), str)
        or not isinstance(stored.get("turn_count"), int)
        or not isinstance(stored.get("capability_jti_sha256"), str)
        or evidence_receipt
        != {
            "storage": "postgres_session",
            "object_path": stored.get("object_path"),
            "sha256": stored.get("sha256"),
        }
    ):
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_finalization_receipt_readback_conflict"},
        )
    payload: dict[str, Any] = {
        "schema": "sophia_voice_lab_finalization_v1",
        "status": "synthetic_isolated",
        "synthetic": True,
        "principal_id": claims.principal_id,
        "test_run_id": claims.test_run_id,
        "scenario_id": claims.scenario_id,
        "scenario_version": claims.scenario_version,
        "environment": claims.environment,
        "session_id": record.session_id,
        "thread_id": record.thread_id,
        "started_at": stored["started_at"],
        "ended_at": stored["finalized_at"],
        "turn_count": stored["turn_count"],
        "expected_deployment": dict(claims.expected_deployment),
        "capability_jti_sha256": stored["capability_jti_sha256"],
        "finalized_at": stored["finalized_at"],
        "retention_hours": claims.retention_hours,
        "retention_anchor": "finalized_at",
        "retention_expires_at": stored["retention_expires_at"],
        "provider_expires_at": stored["provider_expires_at"],
        "cleanup_obligation_id": claims.cleanup_obligation_id,
        "canonical_transcript": canonical_transcript,
        "exclusions": dict(_SYNTHETIC_FINALIZATION_EXCLUSIONS),
    }
    return payload, evidence_receipt


def _build_synthetic_finalization_response(
    body: SessionEndRequest,
    payload: dict[str, Any],
    evidence_receipt: dict[str, str],
) -> SessionEndResponse:
    ended_at = payload.get("ended_at") if isinstance(payload.get("ended_at"), str) else body.ended_at
    started_at = payload.get("started_at") if isinstance(payload.get("started_at"), str) else body.started_at
    turn_count = payload.get("turn_count") if isinstance(payload.get("turn_count"), int) else 0
    try:
        canonical_transcript = SyntheticCanonicalTranscript.model_validate(payload.get("canonical_transcript"))
        validated_receipt = SyntheticFinalizationEvidenceReceipt.model_validate(evidence_receipt)
    except ValidationError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "voice_lab_finalization_evidence_invalid"},
        ) from exc
    return SessionEndResponse(
        status="synthetic_isolated",
        session_id=body.session_id,
        ended_at=ended_at,
        duration_minutes=_compute_duration_minutes(started_at, ended_at),
        turn_count=turn_count,
        recap_artifacts=None,
        offer_debrief=False,
        debrief_prompt=None,
        synthetic_isolated=True,
        test_run_id=str(payload["test_run_id"]),
        finalized_at=str(payload["finalized_at"]),
        retention_hours=int(payload["retention_hours"]),
        retention_anchor="finalized_at",
        retention_expires_at=str(payload["retention_expires_at"]),
        provider_expires_at=str(payload["provider_expires_at"]),
        cleanup_obligation_id=str(payload["cleanup_obligation_id"]),
        exclusions=dict(_SYNTHETIC_FINALIZATION_EXCLUSIONS),
        evidence_receipt=validated_receipt,
        canonical_transcript=canonical_transcript,
    )


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


def _build_session_recap_payload(
    body: SessionEndRequest,
    ended_at: str,
    *,
    thread_id: str | None = None,
) -> dict:
    recap_artifacts = body.recap_artifacts.model_dump(exclude_none=True) if body.recap_artifacts else None
    turn_count = body.turn_count if body.turn_count is not None else len(body.messages)
    return {
        "session_id": body.session_id,
        "thread_id": thread_id or body.thread_id,
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


def _get_memory_extraction_window(user_id: str, session_id: str) -> tuple[int, int, bool]:
    """Return last processed sequence, current max sequence, and whether new messages exist."""
    owner_user_id, record = _resolve_session_record_owner(user_id, session_id)
    if record is None:
        return 0, 0, True

    visible_messages = canonical_visible_messages(_session_store.list_messages(owner_user_id, session_id))
    current_max = max((message.sequence for message in visible_messages), default=0)
    last_processed = max(0, int(record.memory_processed_until_sequence or 0))
    return last_processed, current_max, current_max > last_processed


def _build_thread_state_from_end_request(
    body: SessionEndRequest,
    authoritative_messages: list[SessionMessageRecord] | None = None,
) -> dict | None:
    if authoritative_messages is None:
        serialized_messages = [
            {
                "role": message.role,
                "content": message.content,
            }
            for message in body.messages
            if message.content.strip() and (message.role in {"user", "assistant", "sophia"}) and (message.final if message.final is not None else not bool(message.incomplete))
        ]
    else:
        serialized_messages = [
            {
                "role": message.role,
                "content": message.content,
            }
            for message in authoritative_messages
            if message.content.strip() and message.role in {"user", "assistant"} and message.final
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


def _persist_end_session_transcript(
    user_id: str,
    body: SessionEndRequest,
) -> list[SessionMessageRecord] | None:
    owner_user_id, record = _resolve_session_record_owner(user_id, body.session_id)
    if record is None:
        return None

    existing_visible = canonical_visible_messages(_session_store.list_messages(owner_user_id, body.session_id))
    if not body.messages:
        return existing_visible

    records: list[SessionMessageRecord] = []
    for message in body.messages:
        content = message.content.strip()
        if not content:
            continue
        role = "assistant" if message.role in {"assistant", "sophia"} else message.role
        if role not in {"user", "assistant"}:
            continue
        is_final = message.final if message.final is not None else not bool(message.incomplete)
        if not is_final:
            continue
        sequence = len(records) + 1
        records.append(
            SessionMessageRecord(
                message_id=derive_message_id(
                    session_id=body.session_id,
                    role=role,
                    sequence=sequence,
                    message_id=message.message_id or message.id,
                    turn_id=message.turn_id,
                    provider_event_id=message.provider_event_id,
                    content=content,
                ),
                session_id=body.session_id,
                thread_id=record.thread_id,
                role=role,
                content=content,
                created_at=message.created_at or datetime.now(UTC).isoformat(),
                source=message.source or body.platform or record.platform or "text",
                final=True,
                approximate=bool(message.approximate),
                turn_id=message.turn_id,
                provider_event_id=message.provider_event_id,
                sequence=sequence,
                redaction_level=message.redaction_level,
            )
        )

    if not records:
        return existing_visible

    if body.base_revision is None:
        if int(record.message_revision) > 0:
            logger.info(
                "session.finalization revisionless_transcript_rejected user_id=%s session_id=%s current_revision=%s",
                owner_user_id,
                body.session_id,
                record.message_revision,
            )
            visible_records = existing_visible
        else:
            # Backward-compatible first write only. Once a revision exists, an
            # ending client must prove which snapshot it observed.
            visible_records = canonical_visible_messages(
                _session_store.replace_messages_revisioned(
                    owner_user_id,
                    body.session_id,
                    records,
                    expected_revision=0,
                ).messages
            )
    else:
        snapshot = _session_store.replace_messages_revisioned(
            owner_user_id,
            body.session_id,
            records,
            expected_revision=body.base_revision,
        )
        visible_records = canonical_visible_messages(snapshot.messages)
        if snapshot.conflict:
            logger.info(
                "session.finalization transcript_conflict_rejected user_id=%s session_id=%s expected_revision=%s current_revision=%s",
                owner_user_id,
                body.session_id,
                body.base_revision,
                snapshot.current_revision,
            )

    updates: dict[str, object] = {"message_count": len(visible_records)}
    last_visible = next((message for message in reversed(visible_records) if message.content.strip()), None)
    if last_visible is not None:
        updates["last_message_preview"] = last_visible.content.strip()[:200]
    _session_store.update(owner_user_id, body.session_id, **updates)
    return visible_records


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
    ended_at: str,
) -> None:
    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )
    from deerflow.sophia.offline_pipeline import run_offline_pipeline

    memory_flags = memory_feature_flags_for_owner(user_id)
    if memory_flags.candidate_ledger_write:
        from deerflow.sophia.memory_governance.extraction_service import (
            MemoryExtractionService,
        )
        from deerflow.sophia.memory_governance.refs import keyed_ref
        from deerflow.sophia.memory_governance.store import configured_memory_store

        extraction = MemoryExtractionService(
            governance_store=configured_memory_store(),
            session_store=_session_store,
            lease_owner=keyed_ref("worker", "gateway-finalization-enqueue-only"),
            service_name="sophia-gateway",
        )
        durable_run = extraction.finalize_and_enqueue_session(
            user_id=user_id,
            session_id=session_id,
            ended_at=ended_at,
        )
        if durable_run is None:
            raise RuntimeError("memory_extraction_range_unavailable")
        logger.info(
            "session.finalization durable_memory_enqueued extraction_run_ref=%s contentExcluded=true",
            keyed_ref("extraction-run", str(durable_run.extraction_run_id)),
        )

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


def _mark_session_record_ended(user_id: str, session_id: str, ended_at: str) -> bool:
    owner_user_id, record = _resolve_session_record_owner(user_id, session_id)
    if record is None:
        return False
    if record.status == "ended":
        return True

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
        return False
    return True


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
    session_id: str | None = Query(default=None, description="Optional diagnostic source session identifier"),
) -> MemoryListResponse:
    _validate_user(user_id)
    flags = _memory_flags(user_id)
    if flags.candidate_ledger_read:
        try:
            store = _canonical_memory_service(user_id).store
            if status in {None, "pending_review"}:
                candidates = store.list_candidates(
                    user_id=user_id,
                    session_id=session_id,
                    state=status or "pending_review",
                )
                items = [
                    MemoryItem(
                        id=str(candidate.candidate_id),
                        content=candidate.content or "",
                        category=candidate.category,
                        metadata={
                            "authority": "sophia_candidate_ledger",
                            "review_state": candidate.review_state,
                            "candidate_revision": candidate.current_candidate_revision,
                            "projection_state": "absent",
                        },
                        created_at=str(candidate.created_at) if candidate.created_at else None,
                    )
                    for candidate in candidates
                ]
                return MemoryListResponse(
                    memories=items,
                    count=len(items),
                    source="sophia_candidate_ledger",
                    candidate_count=len(items),
                    session_id_received=bool(session_id),
                    empty_reason=None if items else "terminal_zero_candidates",
                )
            if flags.canonical_pool_read and status in {"approved", "active", "forgotten"}:
                memories = _canonical_memory_service(user_id).list_pool(include_forgotten=status == "forgotten")
                if status == "forgotten":
                    memories = tuple(item for item in memories if item.lifecycle == "forgotten")
                items = [_canonical_to_memory_item(memory) for memory in memories]
                return MemoryListResponse(
                    memories=items,
                    count=len(items),
                    source="sophia_canonical",
                    candidate_count=0,
                    session_id_received=bool(session_id),
                    empty_reason=None if items else "terminal_zero_canonical",
                )
            return MemoryListResponse(
                memories=[],
                count=0,
                source="sophia_governance_denied",
                candidate_count=0,
                session_id_received=bool(session_id),
                empty_reason="review_state_not_exposed",
            )
        except Exception as exc:
            logger.warning(
                "MEM00 list unavailable error_type=%s contentExcluded=true",
                exc.__class__.__name__,
            )
            raise HTTPException(status_code=503, detail="Memory governance unavailable")
    client = _get_mem0_client()
    trace_id = f"memrecent-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}"
    try:
        logger.info(
            "session.finalization list_memories_request user_id=%s status=%s session_id_received=%s trace_id=%s",
            user_id,
            status or "<none>",
            bool(session_id),
            trace_id,
        )
        result = client.get_all(filters={"user_id": user_id})
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
        memories_raw, diagnostics = _hydrate_memories_for_review(
            user_id,
            client,
            memories_raw,
            status,
            session_id=session_id,
        )
        memories_raw = _dedupe_memories_by_id(memories_raw)
        items = [_to_memory_item(m) for m in memories_raw]
        logger.info(
            "session.finalization list_memories_result user_id=%s status=%s count=%s source=%s trace_id=%s",
            user_id,
            status or "<none>",
            len(items),
            diagnostics.get("source"),
            trace_id,
        )
        return MemoryListResponse(
            memories=items,
            count=len(items),
            source=str(diagnostics.get("source") or "unknown"),
            candidate_count=len(items),
            session_id_received=bool(session_id),
            local_overlay_count=int(diagnostics.get("local_overlay_count") or 0),
            skipped_mem0_hydration_for_session_scope=bool(diagnostics.get("skipped_mem0_hydration_for_session_scope")),
            empty_reason=diagnostics.get("empty_reason") if isinstance(diagnostics.get("empty_reason"), str) else None,
            trace_id=trace_id,
        )
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
async def create_memory(user_id: str, body: MemoryCreateRequest) -> MemoryItem:
    _validate_user(user_id)
    if _memory_flags(user_id).canonical_pool_read:
        if not body.idempotency_key:
            raise HTTPException(status_code=409, detail="Memory idempotency key required")
        try:
            service = _canonical_memory_service(user_id)
            receipt = service.manual_create(
                content=body.text,
                category=body.category or "fact",
                scope=body.scope,
                user_tier=body.tier,
                idempotency_key=body.idempotency_key,
            )
            memory = next(item for item in service.list_pool() if item.memory_id == receipt.memory_id)
            return _canonical_to_memory_item(memory)
        except StopIteration:
            raise HTTPException(status_code=503, detail="Canonical memory receipt unavailable")
        except (ValueError, MemoryGovernanceConflict):
            raise HTTPException(status_code=409, detail="Canonical memory operation conflict")
        except Exception as exc:
            logger.warning(
                "MEM00 manual create failed error_type=%s contentExcluded=true",
                exc.__class__.__name__,
            )
            raise HTTPException(status_code=503, detail="Memory governance unavailable")
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


@router.post(
    "/{user_id}/memories/legacy-import",
    response_model=MemoryItem,
    summary="Import one exact evidence-approved legacy memory",
)
async def import_legacy_memory(user_id: str, body: LegacyMemoryImportRequest) -> MemoryItem:
    _validate_user(user_id)
    flags = _memory_flags(user_id)
    if not flags.legacy_inventory or not flags.legacy_import:
        raise HTTPException(status_code=404, detail="Legacy memory import is not enabled")
    try:
        service = _canonical_memory_service(user_id)
        receipt = service.import_approved_legacy(
            provider_memory_id=body.provider_memory_id,
            approval_evidence_ref=body.approval_evidence_ref,
            content=body.text,
            category=body.category,
            scope=body.scope,
            user_tier=body.tier,
            idempotency_key=body.idempotency_key,
        )
        memory = next(item for item in service.list_pool() if item.memory_id == receipt.memory_id)
        return _canonical_to_memory_item(memory)
    except (ValueError, StopIteration, MemoryGovernanceConflict):
        raise HTTPException(status_code=409, detail="Legacy approval evidence conflict")
    except Exception as exc:
        logger.warning(
            "MEM00 legacy import failed error_type=%s contentExcluded=true",
            exc.__class__.__name__,
        )
        raise HTTPException(status_code=503, detail="Memory governance unavailable")


@router.put(
    "/{user_id}/memories/{memory_id}",
    response_model=MemoryItem,
    summary="Update a memory",
)
async def update_memory(user_id: str, memory_id: str, body: MemoryUpdateRequest) -> MemoryItem:
    _validate_user(user_id)
    if _memory_flags(user_id).canonical_pool_read:
        if body.text is None or body.expected_content_revision is None or body.expected_governance_revision is None or not body.idempotency_key:
            raise HTTPException(status_code=409, detail="Expected revisions and idempotency key required")
        try:
            service = _canonical_memory_service(user_id)
            metadata = body.metadata or {}
            receipt = service.edit(
                memory_id=UUID(memory_id),
                expected_content_revision=body.expected_content_revision,
                expected_governance_revision=body.expected_governance_revision,
                content=body.text,
                category=str(metadata.get("category") or "fact"),
                scope=str(metadata.get("scope") or "global"),
                user_tier=str(metadata.get("tier") or "none"),
                idempotency_key=body.idempotency_key,
            )
            memory = next(item for item in service.list_pool() if item.memory_id == receipt.memory_id)
            return _canonical_to_memory_item(memory)
        except (ValueError, StopIteration, MemoryGovernanceConflict):
            raise HTTPException(status_code=409, detail="Canonical memory revision conflict")
        except Exception as exc:
            logger.warning(
                "MEM00 edit failed error_type=%s contentExcluded=true",
                exc.__class__.__name__,
            )
            raise HTTPException(status_code=503, detail="Memory governance unavailable")
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
    if _memory_flags(user_id).canonical_pool_read:
        raise HTTPException(
            status_code=409,
            detail="Use the revision-bound MEM00 privacy deletion endpoint",
        )
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
    "/{user_id}/memories/{memory_id}/forget",
    response_model=MemoryGovernanceReceiptResponse,
    summary="Forget a canonical memory",
)
async def forget_memory(user_id: str, memory_id: str, body: MemoryLifecycleRequest) -> MemoryGovernanceReceiptResponse:
    _validate_user(user_id)
    if not _memory_flags(user_id).canonical_pool_read:
        raise HTTPException(status_code=404, detail="Canonical memory is not enabled")
    try:
        receipt = _canonical_memory_service(user_id).forget(
            memory_id=UUID(memory_id),
            expected_governance_revision=body.expected_governance_revision,
            idempotency_key=body.idempotency_key,
        )
        return MemoryGovernanceReceiptResponse(
            status="forgotten",
            memory_id=str(receipt.memory_id),
            content_revision=receipt.content_revision,
            memory_governance_revision=receipt.memory_governance_revision,
            user_catalog_generation=receipt.user_catalog_generation,
            user_revocation_epoch=receipt.user_revocation_epoch,
            provider_purge=receipt.provider_purge,
        )
    except (ValueError, MemoryGovernanceConflict):
        raise HTTPException(status_code=409, detail="Canonical memory revision conflict")
    except Exception as exc:
        logger.warning(
            "MEM00 forget failed error_type=%s contentExcluded=true",
            exc.__class__.__name__,
        )
        raise HTTPException(status_code=503, detail="Memory governance unavailable")


@router.post(
    "/{user_id}/memories/{memory_id}/restore",
    response_model=MemoryGovernanceReceiptResponse,
    summary="Restore a forgotten canonical memory",
)
async def restore_memory(user_id: str, memory_id: str, body: MemoryLifecycleRequest) -> MemoryGovernanceReceiptResponse:
    _validate_user(user_id)
    if not _memory_flags(user_id).canonical_pool_read:
        raise HTTPException(status_code=404, detail="Canonical memory is not enabled")
    try:
        receipt = _canonical_memory_service(user_id).restore(
            memory_id=UUID(memory_id),
            expected_governance_revision=body.expected_governance_revision,
            idempotency_key=body.idempotency_key,
        )
        return MemoryGovernanceReceiptResponse(
            status="active_projection_pending",
            memory_id=str(receipt.memory_id),
            content_revision=receipt.content_revision,
            memory_governance_revision=receipt.memory_governance_revision,
            user_catalog_generation=receipt.user_catalog_generation,
            user_revocation_epoch=receipt.user_revocation_epoch,
        )
    except (ValueError, MemoryGovernanceConflict):
        raise HTTPException(status_code=409, detail="Canonical memory revision conflict")
    except Exception as exc:
        logger.warning(
            "MEM00 restore failed error_type=%s contentExcluded=true",
            exc.__class__.__name__,
        )
        raise HTTPException(status_code=503, detail="Memory governance unavailable")


@router.post(
    "/{user_id}/memories/{memory_id}/permanent-delete",
    response_model=MemoryGovernanceReceiptResponse,
    summary="Fence and permanently delete canonical memory content",
)
async def permanently_delete_memory(user_id: str, memory_id: str, body: MemoryLifecycleRequest) -> MemoryGovernanceReceiptResponse:
    _validate_user(user_id)
    if not _memory_flags(user_id).canonical_pool_read:
        raise HTTPException(status_code=404, detail="Canonical memory is not enabled")
    try:
        privacy = _canonical_memory_service(user_id).permanently_delete(
            memory_id=UUID(memory_id),
            expected_governance_revision=body.expected_governance_revision,
            idempotency_key=body.idempotency_key,
        )
        receipt = privacy.receipt
        if receipt is None:
            raise RuntimeError("memory_privacy_receipt_missing")
        return MemoryGovernanceReceiptResponse(
            status=privacy.status,
            memory_id=str(receipt.memory_id),
            content_revision=receipt.content_revision,
            memory_governance_revision=receipt.memory_governance_revision,
            user_catalog_generation=receipt.user_catalog_generation,
            user_revocation_epoch=receipt.user_revocation_epoch,
            provider_purge=privacy.provider_purge,
            canonical_memory_fence=privacy.canonical_memory_fence,
            source_transcript=privacy.source_transcript,
            derived_artifacts=privacy.derived_artifacts,
            cache_invalidation=privacy.cache_invalidation,
        )
    except (ValueError, MemoryGovernanceConflict):
        raise HTTPException(status_code=409, detail="Canonical memory revision conflict")
    except Exception as exc:
        logger.warning(
            "MEM00 permanent delete failed error_type=%s contentExcluded=true",
            exc.__class__.__name__,
        )
        raise HTTPException(status_code=503, detail="Memory governance unavailable")


@router.post(
    "/{user_id}/memories/bulk-review",
    response_model=BulkReviewResponse,
    summary="Bulk approve or discard memories",
)
async def bulk_review(user_id: str, body: BulkReviewRequest) -> BulkReviewResponse:
    _validate_user(user_id)
    if _memory_flags(user_id).candidate_ledger_read:
        service = _canonical_memory_service(user_id)
        candidates = {candidate.candidate_id: candidate for candidate in service.store.list_candidates(user_id=user_id)}
        results = []
        for item in body.items:
            try:
                candidate_id = UUID(item.id)
                candidate = candidates.get(candidate_id)
                if candidate is None:
                    raise ValueError("candidate_not_pending")
                revision = item.expected_candidate_revision
                if revision is None or not item.idempotency_key:
                    raise ValueError("candidate_revision_or_idempotency_missing")
                if item.action == "approve":
                    service.approve_candidate(
                        candidate_id=candidate_id,
                        expected_candidate_revision=revision,
                        reviewed_content=item.reviewed_text or candidate.content or "",
                        category=item.category,
                        scope=item.scope,
                        user_tier=item.tier,
                        idempotency_key=item.idempotency_key,
                    )
                else:
                    service.reject_candidate(
                        candidate_id=candidate_id,
                        expected_candidate_revision=revision,
                        idempotency_key=item.idempotency_key,
                    )
                results.append(BulkReviewResult(id=item.id, action=item.action, status="ok"))
            except Exception as exc:
                results.append(
                    BulkReviewResult(
                        id=item.id,
                        action=item.action,
                        status="error",
                        error=exc.__class__.__name__,
                    )
                )
        return BulkReviewResponse(results=results)
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
    if _memory_flags(user_id).canonical_pool_read:
        try:
            include_forgotten = status == "forgotten"
            memories = _canonical_memory_service(user_id).list_pool(include_forgotten=include_forgotten)
            if include_forgotten:
                memories = tuple(memory for memory in memories if memory.lifecycle == "forgotten")
            else:
                memories = tuple(memory for memory in memories if memory.lifecycle == "active")
            selected_category = category or memory_type
            normalized_search = search.strip().lower() if search and search.strip() else None
            entries = [
                JournalEntry(
                    id=str(memory.memory_id),
                    content=memory.canonical_content or "",
                    category=memory.category,
                    metadata={
                        "authority": "sophia_canonical",
                        "lifecycle": memory.lifecycle,
                        "tier": memory.user_tier,
                        "scope": memory.scope,
                        "projection_state": memory.projection_state,
                        "content_revision": memory.current_content_revision,
                        "memory_governance_revision": memory.memory_governance_revision,
                    },
                    created_at=str(memory.created_at) if memory.created_at else None,
                )
                for memory in memories
                if (not selected_category or memory.category == selected_category) and (not normalized_search or normalized_search in (memory.canonical_content or "").lower())
            ]
            return JournalResponse(entries=entries, count=len(entries))
        except Exception as exc:
            logger.warning(
                "MEM00 journal failed error_type=%s contentExcluded=true",
                exc.__class__.__name__,
            )
            raise HTTPException(status_code=503, detail="Memory governance unavailable")
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
            memories_raw, _ = _hydrate_memories_for_review(user_id, client, memories_raw, status)

            # Preserve the previous plain-text search behavior if Mem0 search returns no results.
            if not memories_raw:
                filters: dict = {"user_id": user_id}
                if selected_category:
                    filters["categories"] = selected_category
                result = client.get_all(filters=filters)
                memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
                memories_raw, _ = _hydrate_memories_for_review(user_id, client, memories_raw, status)
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
            memories_raw, _ = _hydrate_memories_for_review(user_id, client, memories_raw, status)

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
    if _memory_flags(user_id).canonical_pool_read:
        memories = tuple(memory for memory in _canonical_memory_service(user_id).list_pool() if memory.category == "decision")
        items = [_canonical_to_memory_item(memory) for memory in memories]
        return CategoryMemoryResponse(memories=items, count=len(items))
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
    if _memory_flags(user_id).canonical_pool_read:
        memories = tuple(memory for memory in _canonical_memory_service(user_id).list_pool() if memory.category == "commitment")
        items = [_canonical_to_memory_item(memory) for memory in memories]
        return CategoryMemoryResponse(memories=items, count=len(items))
    client = _get_mem0_client()
    try:
        result = client.get_all(filters={"user_id": user_id, "categories": "commitment"})
        memories_raw = result if isinstance(result, list) else result.get("results", result.get("memories", []))
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
                entries.append(
                    {
                        "type": "thinking",
                        "title": "Analyzing task",
                        "status": "done",
                    }
                )
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
            is_terminal = getattr(result, "status", None) not in (None,) and (hasattr(result, "status") and getattr(result.status, "value", None) in ("completed", "failed", "timed_out", "cancelled"))
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
        last_has_emit_builder_artifact=(bool(last_summary.get("has_emit_builder_artifact")) if isinstance(last_summary, dict) and "has_emit_builder_artifact" in last_summary else None),
        late_tool_names=_task_summary_tool_names(late_summary),
        late_has_emit_builder_artifact=(bool(late_summary.get("has_emit_builder_artifact")) if isinstance(late_summary, dict) and "has_emit_builder_artifact" in late_summary else None),
        timeout_observed_during_stream=bool(getattr(result, "timeout_observed_during_stream", False)),
        timed_out_at=(getattr(result, "timed_out_at", None).isoformat() if getattr(result, "timed_out_at", None) is not None else None),
        final_state_present=isinstance(getattr(result, "final_state", None), dict),
        builder_result_present=isinstance(builder_result, dict) and bool(builder_result),
        suspected_blocker=suspected_blocker,
        suspected_blocker_detail=blocker_detail,
        last_shell_command=(
            dict(getattr(result, "live_state", {}).get("last_shell_command")) if isinstance(getattr(result, "live_state", None), dict) and isinstance(getattr(result, "live_state", {}).get("last_shell_command"), dict) else None
        ),
        recent_shell_commands=([dict(entry) for entry in getattr(result, "live_state", {}).get("recent_shell_commands", []) if isinstance(entry, dict)] if isinstance(getattr(result, "live_state", None), dict) else []),
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
async def end_session(
    user_id: str,
    body: SessionEndRequest,
    request: Request,
) -> SessionEndResponse:
    _validate_user(user_id)
    voice_lab_claims = capability_for_gateway_action(
        request,
        user_id,
        required_operation="session:finalize",
    )
    ended_at = body.ended_at or datetime.now(UTC).isoformat()

    if voice_lab_claims is not None:
        owner_user_id, session_record = _resolve_session_record_owner(
            user_id,
            body.session_id,
        )
        if session_record is None or owner_user_id != user_id:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_record_not_found"},
            )
        if session_record.thread_id != body.thread_id:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_thread_mismatch"},
            )
        assert_voice_lab_session_record(session_record, voice_lab_claims)
        try:
            cleanup_bound_record = _session_store.find_session_by_cleanup_obligation_id(voice_lab_claims.cleanup_obligation_id)
        except (OSError, RuntimeError, SessionStoreError) as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_cleanup_binding_mismatch"},
            ) from exc
        if cleanup_bound_record is None or cleanup_bound_record.session_id != session_record.session_id:
            raise HTTPException(
                status_code=409,
                detail={"code": "voice_lab_session_cleanup_binding_mismatch"},
            )
        if session_record.status != "ended":
            # This is deliberately before transcript parsing/persistence: an
            # expired provisional session is cleanup-only and cannot allocate
            # or extend canonical evidence.
            _assert_synthetic_provisional_retention_open(session_record)
        terminal_messages: list[SessionMessageRecord] | None = None
        if session_record.status == "ended":
            session_record, terminal_messages = _assert_synthetic_terminal_transcript_replay(
                user_id,
                body,
                session_record,
                voice_lab_claims,
            )
        (
            canonical_record,
            authoritative_messages,
            _retention_fields,
            evidence_receipt,
        ) = _finalize_synthetic_session_atomically(
            user_id,
            body,
            session_record,
            voice_lab_claims,
            authoritative_messages=terminal_messages,
        )
        try:
            from app.gateway.inactivity_watcher import unregister_thread

            unregister_thread(session_record.thread_id)
        except ImportError:
            pass
        # The immutable receipt is already part of the same Postgres commit;
        # this read-back only projects it into the response.
        canonical_transcript = _synthetic_transcript_evidence(
            canonical_record,
            authoritative_messages,
            voice_lab_claims,
        )
        isolated_payload, evidence_receipt = _postgres_synthetic_finalization_payload(
            voice_lab_claims,
            canonical_record,
            canonical_transcript,
            evidence_receipt,
        )
        logger.info(
            "session.finalization synthetic_isolated test_run_id=%s session_id=%s",
            voice_lab_claims.test_run_id,
            body.session_id,
        )
        return _build_synthetic_finalization_response(body, isolated_payload, evidence_receipt)

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

    authoritative_transcript = _persist_end_session_transcript(user_id, body)
    _owner_user_id, authoritative_record = _resolve_session_record_owner(
        user_id,
        body.session_id,
    )
    authoritative_thread_id = authoritative_record.thread_id if authoritative_record is not None else body.thread_id
    last_processed_sequence, current_max_sequence, has_new_messages = _get_memory_extraction_window(
        user_id,
        body.session_id,
    )
    if isinstance(existing_recap, dict):
        recap_turn_count = existing_recap.get("turn_count")
        if isinstance(recap_turn_count, int):
            has_new_messages = current_max_sequence > max(last_processed_sequence, recap_turn_count)

    if isinstance(existing_recap, dict) and not has_new_messages:
        existing_ended_at = existing_recap.get("ended_at") if isinstance(existing_recap.get("ended_at"), str) else ended_at
        _mark_session_record_ended(user_id, body.session_id, existing_ended_at)
        try:
            from app.gateway.inactivity_watcher import unregister_thread

            unregister_thread(authoritative_thread_id)
        except ImportError:
            pass

        logger.info(
            "session.finalization duplicate_suppressed user_id=%s session_id=%s thread_id=%s duplicateFinalizationSuppressed=%s recapPipelineQueued=%s currentMaxSequence=%s",
            user_id,
            body.session_id,
            authoritative_thread_id,
            True,
            False,
            current_max_sequence,
        )
        return _build_session_end_response_from_recap(
            body,
            existing_recap,
            status="no_new_messages",
        )

    recap_payload = (
        existing_recap
        if isinstance(existing_recap, dict)
        else _build_session_recap_payload(
            body,
            ended_at,
            thread_id=authoritative_thread_id,
        )
    )
    duration_minutes = _compute_duration_minutes(body.started_at, ended_at)
    turn_count = recap_payload.get("turn_count", 0)
    recap_artifacts = recap_payload.get("recap_artifacts")
    debrief_prompt = _build_debrief_prompt(body, recap_artifacts, duration_minutes)

    if not isinstance(existing_recap, dict):
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
    else:
        logger.info(
            "session.finalization continuation_existing_recap_preserved user_id=%s session_id=%s currentMaxSequence=%s",
            user_id,
            body.session_id,
            current_max_sequence,
        )

    from deerflow.sophia.memory_governance.flags import (
        memory_feature_flags_for_owner,
    )

    atomic_memory_finalization = memory_feature_flags_for_owner(user_id).candidate_ledger_write
    if not atomic_memory_finalization:
        _mark_session_record_ended(user_id, body.session_id, ended_at)

    # Remove from inactivity tracking — session explicitly ended
    try:
        from app.gateway.inactivity_watcher import unregister_thread

        unregister_thread(authoritative_thread_id)
    except ImportError:
        pass

    try:
        _queue_offline_pipeline(
            user_id,
            body.session_id,
            authoritative_thread_id,
            _build_thread_state_from_end_request(body, authoritative_transcript),
            ended_at,
        )
        logger.info(
            "session.finalization end_session_queued user_id=%s session_id=%s thread_id=%s recapPipelineQueued=%s",
            user_id,
            body.session_id,
            authoritative_thread_id,
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
