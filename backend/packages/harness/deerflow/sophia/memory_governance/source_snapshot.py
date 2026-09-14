"""Content-free current-epoch source partition, never standalone permission.

The complete transcript reader must match every version in this snapshot before
the planner may select input. The transactional aligner must independently
recheck the entire snapshot; its ID is a change token, not an authorization.
"""

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord

from .models import ExtractionRun
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable


class SourceSnapshotRow(IntakeModel):
    message_id: str = Field(min_length=1, max_length=1000)
    sequence: int = Field(gt=0)
    source_version: UuidText
    acceptance_epoch: int = Field(ge=0)
    accepted_version: UuidText | None
    eligibility: Literal["eligible", "before_clear", "accepted_version_changed", "acceptance_unproven"]


class SourceSnapshot(IntakeModel):
    schema_name: Literal["mem00.source-snapshot.v1"] = Field(alias="schema")
    snapshot_id: str = Field(pattern=r"^mem00-source-snapshot-[a-f0-9]{32}$")
    owner_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    thread_id: str = Field(min_length=1)
    transcript_revision: int = Field(ge=0)
    memory_clear_epoch: int = Field(ge=0)
    context_mode: str = Field(min_length=1, max_length=512)
    status: Literal["active", "resumable", "ended"]
    ended_at: str | None
    sources: list[SourceSnapshotRow] = Field(max_length=10000)

    @field_validator("ended_at")
    @classmethod
    def aware_timestamp(cls, value):
        if value is not None and datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("source_snapshot_timestamp_invalid")
        return value

    @model_validator(mode="after")
    def exact_partition(self):
        if len({row.message_id for row in self.sources}) != len(self.sources) or len({row.sequence for row in self.sources}) != len(self.sources):
            raise ValueError("source_snapshot_duplicate")
        if self.sources != sorted(self.sources, key=lambda row: (row.sequence, row.message_id)):
            raise ValueError("source_snapshot_order_invalid")
        for row in self.sources:
            if row.acceptance_epoch > self.memory_clear_epoch:
                raise ValueError("source_snapshot_future_epoch")
            expected = (
                "before_clear" if row.acceptance_epoch < self.memory_clear_epoch else
                "eligible" if self.memory_clear_epoch == 0 or row.accepted_version == row.source_version else
                "acceptance_unproven" if row.accepted_version is None else "accepted_version_changed"
            )
            if row.eligibility != expected:
                raise ValueError("source_snapshot_partition_invalid")
        return self

    def match_complete_source(self, session: SessionRecord, messages: list[SessionMessageRecord]) -> None:
        """Missing, deduplicated or changed source is unavailable, never excluded."""
        from .source_target import dependencies

        if (self.owner_id, self.session_id, self.thread_id, self.transcript_revision, self.context_mode, self.status) != (
            session.user_id, session.session_id, session.thread_id, session.message_revision, session.context_mode,
            {"open": "active", "paused": "resumable", "active": "active", "resumable": "resumable", "ended": "ended"}.get(session.status)
        ):
            raise MemoryGovernanceUnavailable("memory_source_snapshot_scope_changed")
        actual_ended = session.ended_at
        if actual_ended is not None:
            try:
                actual_ended = datetime.fromisoformat(actual_ended.replace("Z", "+00:00"))
                if actual_ended.tzinfo is None:
                    raise ValueError("timestamp")
            except Exception:
                raise MemoryGovernanceUnavailable("memory_source_snapshot_scope_changed") from None
        expected_ended = datetime.fromisoformat(self.ended_at.replace("Z", "+00:00")) if self.ended_at is not None else None
        # SessionRecord deliberately serializes database timestamps to millis.
        # Compare that reader projection here, but keep the untouched full SQL
        # timestamp in the HMAC-bound snapshot and transactional exact CAS.
        if actual_ended is not None:
            actual_ended = actual_ended.replace(microsecond=actual_ended.microsecond // 1000 * 1000)
        if expected_ended is not None:
            expected_ended = expected_ended.replace(microsecond=expected_ended.microsecond // 1000 * 1000)
        if actual_ended != expected_ended:
            raise MemoryGovernanceUnavailable("memory_source_snapshot_scope_changed")
        ordered = sorted(messages, key=lambda row: (row.sequence, row.message_id))
        actual = [row.model_dump(mode="json") for row in dependencies(ordered)]
        expected = [{"message_id": row.message_id, "sequence": row.sequence, "source_version": row.source_version} for row in self.sources]
        if actual != expected or any((row.session_id, row.thread_id) != (self.session_id, self.thread_id) for row in ordered):
            raise MemoryGovernanceUnavailable("memory_source_snapshot_versions_changed")


def read_source_snapshot(*, store, session: SessionRecord) -> SourceSnapshot:
    try:
        result = store.source_snapshot(user_id=session.user_id, session_id=session.session_id, thread_id=session.thread_id)
        snapshot = SourceSnapshot.model_validate(result)
        if (snapshot.owner_id, snapshot.session_id, snapshot.thread_id, snapshot.transcript_revision) != (
            session.user_id, session.session_id, session.thread_id, session.message_revision
        ):
            raise ValueError("scope")
        return snapshot
    except Exception:
        raise MemoryGovernanceUnavailable("memory_source_snapshot_unavailable") from None


def visible_source_occurrences(messages: list[SessionMessageRecord]) -> list[SessionMessageRecord]:
    """SQL visibility without display deduplication or source-text rewriting."""
    return sorted((message for message in messages if message.final is True
        and message.role in {"user", "assistant"} and message.content.strip(" ") != ""), key=lambda row: (row.sequence, row.message_id))


def read_snapshot_source_messages(*, session_store, session: SessionRecord, snapshot: SourceSnapshot) -> list[SessionMessageRecord]:
    """Complete source occurrences, not the legacy display-deduplicated view.

    Different durable IDs are different source occurrences even when text,
    provider IDs, turn IDs or millisecond timestamps happen to coincide.
    The SQL partition, not fuzzy display identity, defines this exact domain.
    """
    try:
        all_messages = session_store.read_memory_source_messages(session.user_id, session.session_id, expected_revision=session.message_revision)
        # Match PostgreSQL's btrim(content) predicate exactly (ASCII space),
        # without rewriting any source text or database-issued version.
        selected = visible_source_occurrences(all_messages)
        snapshot.match_complete_source(session, selected)
        return selected
    except Exception:
        raise MemoryGovernanceUnavailable("memory_source_snapshot_read_unavailable") from None


class EpochSourceTargetReceipt(IntakeModel):
    schema_name: Literal["mem00.source-target-at-epoch.v1"] = Field(alias="schema")
    event_id: UuidText
    run: ExtractionRun | None
    invalidated_count: int = Field(ge=0)
    source_manifest_ref: str = Field(pattern=r"^hmac-sha256:transcript-manifest:[a-f0-9]{64}$")
    idempotent_replay: bool
    historical_result_only: HistoricalOnly
    memory_clear_epoch: int = Field(ge=0)
    source_snapshot: SourceSnapshot
    source_target: SourceSnapshot
    extractor_contract_version: Literal["mem00.extract.v1"]

    @field_validator("run", mode="before")
    @classmethod
    def fixed_run_projection(cls, value):
        # SQL returns its complete run record. Match the ordinary store's fixed
        # model projection; never forward internal SQL columns in this receipt.
        if isinstance(value, dict):
            return {key: item for key, item in value.items() if key in ExtractionRun.model_fields}
        return value

    @model_validator(mode="after")
    def exact_epoch_and_source(self):
        original = self.source_snapshot
        target = self.source_target
        if original.memory_clear_epoch != self.memory_clear_epoch or target.memory_clear_epoch != self.memory_clear_epoch:
            raise ValueError("source_target_epoch_invalid")
        before = original.model_dump(exclude={"status", "ended_at", "snapshot_id"})
        after = target.model_dump(exclude={"status", "ended_at", "snapshot_id"})
        if before != after:
            raise ValueError("source_target_partition_changed")
        if self.run is not None and (self.run.user_id, self.run.session_id, self.run.thread_id, self.run.memory_clear_epoch) != (
            original.owner_id, original.session_id, original.thread_id, self.memory_clear_epoch
        ):
            raise ValueError("source_target_run_scope_invalid")
        return self
