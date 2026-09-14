"""Typed contracts for the MEM00 authority and projection boundary."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ContractMode = Literal["disabled", "shadow", "enforced"]
CandidateReviewState = Literal["pending_review", "approved", "rejected", "expired", "legacy_quarantined"]
MemoryLifecycle = Literal["active", "forgotten", "tombstoned"]
MemoryTier = Literal["conscious", "subconscious", "none"]
ExtractionState = Literal[
    "queued",
    "leased",
    "retry_wait",
    "succeeded_zero",
    "succeeded_nonzero",
    "failed_terminal",
    "superseded",
]
ProjectionState = Literal[
    "absent",
    "queued",
    "leased",
    "ambiguous",
    "active",
    "stale",
    "purge_queued",
    "purging",
    "purged",
    "failed_retryable",
    "failed_terminal",
    "orphaned",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemoryContract(StrictModel):
    contract_epoch: int = Field(gt=0)
    schema_version: str
    mode: ContractMode
    updated_at: datetime | str


class UserGovernance(StrictModel):
    user_id: str
    user_catalog_generation: int = Field(ge=0)
    user_revocation_epoch: int = Field(ge=0)
    provider_subject: str


class OwnerMemoryAuthority(StrictModel):
    user_id: str
    authority_state: Literal["unknown", "legacy", "governed"]
    authority_epoch: int | None = Field(default=None, gt=0)
    authority_declared_at: datetime | None = None


class CandidateSource(StrictModel):
    session_id: str
    message_id: str
    sequence: int = Field(gt=0)
    transcript_revision: int = Field(ge=0)


class SourceRecoveryClaim(StrictModel):
    user_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    sweep_id: UUID
    lease_token: UUID
    lease_owner: str = Field(min_length=1)
    lease_expires_at: datetime


class SourceRecoveryReceipt(StrictModel):
    schema_name: Literal["mem00.source-recovery.v1"] = Field(alias="schema")
    user_id: str
    session_id: str
    sweep_id: UUID
    lease_token: UUID
    outcome: Literal["target_checked", "source_ineligible", "retryable_failure"]
    checked_at: datetime
    extraction_complete: bool = Field(strict=True)
    idempotent_replay: bool = Field(strict=True)


class ExtractedCandidate(StrictModel):
    content: str = Field(min_length=1)
    content_ref: str = Field(min_length=1)
    category: str = "fact"
    confidence: float | None = Field(default=None, ge=0, le=1)
    importance: float | None = Field(default=None, ge=0, le=1)
    proposed_tier: MemoryTier | None = None
    producer: str = "memory_extraction_service"
    origin: str = "session_extraction"
    sources: tuple[CandidateSource, ...] = ()


class SourceDependency(StrictModel):
    message_id: str = Field(min_length=1)
    sequence: int = Field(gt=0, strict=True)
    source_version: UUID


class ExtractionInputContext(StrictModel):
    schema_name: Literal["mem00.extract-input.v1"] = Field(alias="schema")
    session_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    context_mode: str = Field(min_length=1, max_length=512)
    template_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ExtractionRun(StrictModel):
    extraction_run_id: UUID
    user_id: str
    session_id: str
    thread_id: str
    transcript_revision: int = Field(ge=0)
    sequence_start: int = Field(gt=0)
    sequence_end: int = Field(gt=0)
    input_manifest_ref: str
    extractor_contract_version: str
    state: ExtractionState
    attempt_count: int = Field(default=0, ge=0)
    lease_token: UUID | None = None
    terminal_candidate_count: int | None = Field(default=None, ge=0)
    processed_through_sequence: int | None = Field(default=None, ge=0)
    safe_terminal_reason: str | None = None
    error_code: str | None = None
    extractor_model: str | None = None
    extractor_prompt_version: str | None = None
    source_dependencies: tuple[SourceDependency, ...] | None = None
    validated_transcript_revision: int | None = Field(default=None, ge=0)
    extractor_input_context: ExtractionInputContext | None = None
    extractor_input_ref: str | None = None
    memory_clear_epoch: int | None = Field(default=None, ge=0, strict=True)


class CandidateRecord(StrictModel):
    candidate_id: UUID
    user_id: str
    extraction_run_id: UUID
    stable_ordinal: int = Field(ge=0)
    current_candidate_revision: int = Field(gt=0)
    review_state: CandidateReviewState
    content: str | None = None
    content_ref: str | None = None
    category: str | None = None
    proposed_tier: MemoryTier | None = None
    canonical_memory_id: UUID | None = None
    projection_state: ProjectionState = "absent"
    created_at: datetime | str | None = None


class CanonicalMemory(StrictModel):
    memory_id: UUID
    user_id: str
    lifecycle: MemoryLifecycle
    user_tier: MemoryTier
    current_content_revision: int = Field(gt=0)
    memory_governance_revision: int = Field(gt=0)
    canonical_content: str | None = None
    content_ref: str | None = None
    category: str | None = None
    scope: str | None = None
    projection_state: ProjectionState = "absent"
    created_at: datetime | str | None = None
    updated_at: datetime | str | None = None


class GovernanceReceipt(StrictModel):
    event_id: UUID
    operation_id: str | None = None
    event_type: str | None = None
    resulting_lifecycle: MemoryLifecycle | None = None
    memory_id: UUID | None = None
    candidate_id: UUID | None = None
    content_revision: int | None = None
    memory_governance_revision: int | None = None
    user_catalog_generation: int = Field(ge=0)
    user_revocation_epoch: int = Field(ge=0)
    idempotent_replay: bool = False
    status: str | None = None
    tombstone_id: UUID | None = None
    provider_purge: str | None = None


class CommandReceipt(GovernanceReceipt):
    operation_id: str = Field(min_length=1)
    event_type: str = Field(min_length=1)
    resulting_lifecycle: MemoryLifecycle | None = None


class ProviderHit(StrictModel):
    provider_memory_id: str
    score: float | None = None


class AuthorizedMemory(StrictModel):
    memory_id: UUID
    content_revision: int = Field(gt=0)
    memory_governance_revision: int = Field(gt=0)
    canonical_content: str
    category: str | None = None
    scope: str | None = None
    score: float | None = None


class RetrievalReceipt(StrictModel):
    retrieval_request_id: UUID
    prompt_admission_id: UUID | None = None
    owner_ref: str
    query_ref: str
    provider_status: str
    provider_hit_count: int = Field(ge=0)
    catalog_generation_checked: int = Field(ge=0)
    revocation_epoch_checked: int = Field(ge=0)
    authorized_memory_ids: tuple[str, ...]
    denial_counts_by_reason: dict[str, int]
    latency_segments: dict[str, int]
    safe_reason_code: str | None = None


class GovernedMemoryContext(StrictModel):
    memories: tuple[AuthorizedMemory, ...]
    context_text: str
    receipt: RetrievalReceipt


class ProjectionLease(StrictModel):
    projection_job_id: UUID
    user_id: str
    memory_id: UUID
    provider: str
    environment: str
    provider_project: str
    provider_namespace: str
    desired_content_revision: int
    desired_governance_revision: int
    operation: Literal["project_revision", "purge_binding", "verify_binding"]
    state: str
    lease_token: UUID
    projection_operation_id: str
    canonical_content: str | None = None


class PrivacyReceipt(StrictModel):
    status: Literal[
        "accepted_and_fenced",
        "purge_pending",
        "purge_verified",
        "partial_failure",
        "unsupported",
        "failed",
    ]
    canonical_memory_fence: str
    provider_purge: str
    source_transcript: str
    derived_artifacts: str
    cache_invalidation: str
    other_account_data: Literal["not_covered_by_mem00"] = "not_covered_by_mem00"
    receipt: GovernanceReceipt | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class SourceInvalidationReceipt(StrictModel):
    event_id: UUID
    invalidated_candidate_count: int = Field(ge=0)
    invalidated_run_count: int = Field(ge=0)
    detached_manifest_count: int = Field(ge=0)
    idempotent_replay: bool = False
