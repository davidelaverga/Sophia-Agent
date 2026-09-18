"""Canonical, snapshot-bound review reads; no derivative or provider authority."""

from __future__ import annotations

import base64
import hmac
import json
from typing import Literal
from uuid import UUID

from pydantic import Field

from .models import StrictModel
from .refs import keyed_ref
from .store import MemoryGovernanceConflict, MemoryGovernanceUnavailable


class ReviewCandidate(StrictModel):
    candidate_id: UUID
    candidate_revision: int = Field(gt=0, strict=True)
    review_state: Literal["pending_review"]
    content: str = Field(min_length=1)
    category: str
    extraction_run_id: UUID
    source_manifest_ref: str
    sequence_start: int = Field(gt=0, strict=True)
    sequence_end: int = Field(gt=0, strict=True)


class ReviewSummary(StrictModel):
    scope: Literal["session_history"]
    produced: int = Field(ge=0, strict=True)
    pending: int = Field(ge=0, strict=True)
    approved: int = Field(ge=0, strict=True)
    rejected: int = Field(ge=0, strict=True)
    invalidated: int = Field(ge=0, strict=True)


class ReviewFinalization(StrictModel):
    kind: Literal["source_target_receipt"]
    status: str | None
    ended_at: str | None
    event_id: UUID | None
    transcript_revision: int | None
    source_manifest_ref: str | None


class ReviewSourceEligibility(StrictModel):
    memory_clear_epoch: int = Field(ge=0, strict=True)
    source_snapshot_id: str = Field(pattern=r"^mem00-source-snapshot-[a-f0-9]{32}$")
    visible_message_count: int = Field(ge=0, strict=True)
    eligible_message_count: int = Field(ge=0, strict=True)
    before_clear_count: int = Field(ge=0, strict=True)
    accepted_version_changed_count: int = Field(ge=0, strict=True)
    acceptance_unproven_count: int = Field(ge=0, strict=True)


class ReviewEnvelope(StrictModel):
    schema_name: Literal["mem00.review.v2"] = Field(alias="schema")
    memory_contract_epoch: Literal[1]
    owner_id: str
    session_id: str
    thread_id: str | None
    transcript_revision: int = Field(ge=0, strict=True)
    source_manifest_ref: str
    target_sequence_start: int | None
    target_sequence_end: int | None
    finalization: ReviewFinalization
    source_eligibility: ReviewSourceEligibility
    snapshot_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    review_filter: Literal["pending_review"]
    extraction_state: Literal["awaiting_finalization", "processing", "complete", "source_excluded", "failed_retryable", "failed_terminal", "unavailable", "not_found", "source_changed", "snapshot_changed"]
    target_message_count: int = Field(ge=0, strict=True)
    covered_message_count: int = Field(ge=0, strict=True)
    run_count: int = Field(ge=0, strict=True)
    summary: ReviewSummary
    candidates: tuple[ReviewCandidate, ...]
    next_after_candidate_id: UUID | None
    enumeration_complete: bool
    retryable: bool
    recovery_action: Literal["refresh_view", "await_or_recover_extraction", "retry_extraction", "finalize_source", "inspect_failure", "none"]
    next_cursor: str | None = None


def _cursor_context(owner_id: str, session_id: str, snapshot_id: str, after: str) -> str:
    return json.dumps([owner_id, session_id, snapshot_id, after], separators=(",", ":"))


def encode_review_cursor(owner_id: str, session_id: str, snapshot_id: str, after: UUID) -> str:
    payload = base64.urlsafe_b64encode(json.dumps([snapshot_id, str(after)], separators=(",", ":")).encode()).decode().rstrip("=")
    signature = keyed_ref("review-cursor", _cursor_context(owner_id, session_id, snapshot_id, str(after)))
    return payload + "." + signature


def decode_review_cursor(owner_id: str, session_id: str, cursor: str | None) -> tuple[str | None, str | None]:
    if cursor is None:
        return None, None
    try:
        if len(cursor) > 512:
            raise ValueError
        payload, signature = cursor.split(".", 1)
        snapshot, after = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        after = str(UUID(after))
        if not isinstance(snapshot, str) or len(snapshot) != 32 or any(char not in "0123456789abcdef" for char in snapshot):
            raise ValueError
        expected = keyed_ref("review-cursor", _cursor_context(owner_id, session_id, snapshot, after))
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        return snapshot, after
    except Exception:
        raise MemoryGovernanceConflict("memory_review_cursor_invalid") from None


def read_review_envelope(*, owner_id: str, session_id: str, session_store, governance_store, cursor: str | None = None, page_size: int = 100) -> ReviewEnvelope:
    from .extraction_service import _manifest_ref
    from .owner_authority import resolve_owner_authority
    from .source_snapshot import read_snapshot_source_messages, read_source_snapshot
    from .source_target import dependencies

    if not 1 <= page_size <= 200:
        raise ValueError("memory_review_page_size_invalid")
    authority = resolve_owner_authority(owner_id, store=governance_store)
    if authority.authority_state != "governed":
        raise MemoryGovernanceUnavailable("memory_review_owner_unavailable")
    snapshot, after = decode_review_cursor(owner_id, session_id, cursor)
    session = session_store.get(owner_id, session_id)
    if session is None:
        raise MemoryGovernanceConflict("memory_review_source_not_found")
    if session.user_id != owner_id or session.session_id != session_id:
        raise MemoryGovernanceUnavailable("memory_review_source_scope_invalid")
    source_snapshot = read_source_snapshot(store=governance_store, session=session)
    messages = read_snapshot_source_messages(session_store=session_store, session=session, snapshot=source_snapshot)
    manifest = _manifest_ref(user_id=owner_id, session_id=session_id, transcript_revision=session.message_revision, messages=messages)
    raw = governance_store.review_snapshot({
        "p_user_id": owner_id, "p_session_id": session_id, "p_transcript_revision": session.message_revision,
        "p_source_manifest_ref": manifest, "p_target_messages": [item.model_dump(mode="json") for item in dependencies(messages)],
        "p_snapshot_id": snapshot, "p_after_candidate_id": after, "p_page_size": page_size,
    })
    try:
        envelope = ReviewEnvelope.model_validate(raw)
    except Exception:
        raise MemoryGovernanceUnavailable("memory_review_snapshot_invalid") from None
    if (envelope.owner_id, envelope.session_id, envelope.transcript_revision, envelope.source_manifest_ref) != (owner_id, session_id, session.message_revision, manifest):
        raise MemoryGovernanceUnavailable("memory_review_snapshot_scope_invalid")
    if envelope.extraction_state in {"source_changed", "snapshot_changed", "not_found"}:
        raise MemoryGovernanceConflict("memory_review_" + envelope.extraction_state)
    if envelope.extraction_state == "unavailable":
        raise MemoryGovernanceUnavailable("memory_review_snapshot_unavailable")
    expected_eligibility = ReviewSourceEligibility(
        memory_clear_epoch=source_snapshot.memory_clear_epoch,
        source_snapshot_id=source_snapshot.snapshot_id,
        visible_message_count=len(source_snapshot.sources),
        eligible_message_count=sum(row.eligibility == "eligible" for row in source_snapshot.sources),
        before_clear_count=sum(row.eligibility == "before_clear" for row in source_snapshot.sources),
        accepted_version_changed_count=sum(row.eligibility == "accepted_version_changed" for row in source_snapshot.sources),
        acceptance_unproven_count=sum(row.eligibility == "acceptance_unproven" for row in source_snapshot.sources),
    )
    if envelope.source_eligibility != expected_eligibility or envelope.target_message_count != expected_eligibility.eligible_message_count:
        raise MemoryGovernanceUnavailable("memory_review_source_eligibility_changed")
    if (envelope.extraction_state == "source_excluded" and (expected_eligibility.visible_message_count == 0
        or envelope.target_message_count != 0 or envelope.covered_message_count != 0 or envelope.candidates or envelope.summary.pending != 0)):
        raise MemoryGovernanceUnavailable("memory_review_exclusion_unproven")
    if envelope.extraction_state == "complete" and expected_eligibility.visible_message_count > 0 and envelope.target_message_count == 0:
        raise MemoryGovernanceUnavailable("memory_review_excluded_source_not_zero")
    if envelope.extraction_state != "awaiting_finalization" and (envelope.finalization.event_id is None
        or envelope.finalization.transcript_revision != session.message_revision or envelope.finalization.source_manifest_ref != manifest
        or envelope.finalization.status != "ended" or envelope.finalization.ended_at is None):
        raise MemoryGovernanceUnavailable("memory_review_finalization_unproven")
    if envelope.covered_message_count > envelope.target_message_count or len(envelope.candidates) > page_size:
        raise MemoryGovernanceUnavailable("memory_review_snapshot_counts_invalid")
    if envelope.extraction_state == "complete" and envelope.covered_message_count != envelope.target_message_count:
        raise MemoryGovernanceUnavailable("memory_review_completion_unproven")
    if envelope.enumeration_complete != (envelope.next_after_candidate_id is None):
        raise MemoryGovernanceUnavailable("memory_review_page_invalid")
    if envelope.next_after_candidate_id is not None:
        if not envelope.candidates or envelope.candidates[-1].candidate_id != envelope.next_after_candidate_id:
            raise MemoryGovernanceUnavailable("memory_review_cursor_mismatch")
        envelope.next_cursor = encode_review_cursor(owner_id, session_id, envelope.snapshot_id, envelope.next_after_candidate_id)
    return envelope
