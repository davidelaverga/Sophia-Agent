"""Explicit user source intake; a recorded source is never memory approval.

The SQL operation appends only a new human occurrence. Full transcript flushes
and recovered checkpoints cannot use this operation as an epoch upgrade.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.session_store import SessionMessageRecord, _storage_message_row_id

from .identity import assert_not_voice_lab_principal
from .refs import keyed_ref
from .service import CanonicalMemoryService
from .store import MemoryGovernanceUnavailable

UuidText = Annotated[str, Field(pattern=r"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$")]
ActionKey = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{8,200}$")]


def _historical_only(value):
    if value is not True:
        raise ValueError("source_historical_flag_invalid")
    return value


HistoricalOnly = Annotated[Literal[True], BeforeValidator(_historical_only)]


class IntakeModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class SourceActionRequest(IntakeModel):
    thread_id: UuidText
    message_id: ActionKey
    command_key: ActionKey
    expected_clear_epoch: int = Field(ge=0)
    content: str = Field(min_length=1, max_length=1048576)

    @field_validator("content")
    @classmethod
    def exact_visible_content(cls, value):
        value = value.strip()
        if not value or "\x00" in value or len(value.encode("utf-8")) > 1048576:
            raise ValueError("source_content_invalid")
        return value


class SourceBoundary(IntakeModel):
    schema_name: Literal["mem00.source-boundary.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    session_id: UuidText
    thread_id: UuidText
    memory_clear_epoch: int = Field(ge=0)
    transcript_revision: int = Field(ge=0)


class SourceActionReceipt(IntakeModel):
    schema_name: Literal["mem00.source-action.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    session_id: UuidText
    thread_id: UuidText
    command_key: ActionKey
    event_id: UuidText
    message_id: ActionKey
    source_row_id: UuidText
    source_version: UuidText
    sequence: int = Field(gt=0)
    created_at: str
    memory_clear_epoch: int = Field(ge=0)
    transcript_revision: int = Field(gt=0)
    content_ref: str = Field(pattern=r"^hmac-sha256:source-action-content:[a-f0-9]{64}$")
    historical_result_only: HistoricalOnly
    idempotent_replay: bool
    status: Literal["source_recorded"]
    memory_approval: Literal["not_granted"]
    current_extraction_eligibility: Literal["not_verified_in_this_response"]

    @field_validator("created_at")
    @classmethod
    def aware_timestamp(cls, value):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("source_timestamp_invalid")
        return value


class SourceProfile(IntakeModel):
    schema_name: Literal["mem00.source-profile.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    session_id: UuidText
    thread_id: UuidText
    authority: Literal["governed", "legacy"]
    boundary: SourceBoundary | None
    observation_only: HistoricalOnly

    @model_validator(mode="after")
    def exact_profile_boundary(self):
        if (self.authority == "governed") != (self.boundary is not None):
            raise ValueError("source_profile_invalid")
        if self.boundary is not None and (self.boundary.owner_id, self.boundary.session_id, self.boundary.thread_id) != (self.owner_id, self.session_id, self.thread_id):
            raise ValueError("source_profile_scope_invalid")
        return self


class SourceActionStatus(IntakeModel):
    schema_name: Literal["mem00.source-action-status.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    command_key: ActionKey
    status: Literal["committed", "not_found"]
    historical_result_only: HistoricalOnly
    receipt: SourceActionReceipt | None

    @model_validator(mode="after")
    def exact_original_receipt(self):
        if (self.status == "committed") != (self.receipt is not None):
            raise ValueError("source_status_incomplete")
        if self.receipt is not None and (self.receipt.owner_id != self.owner_id or self.receipt.command_key != self.command_key or not self.receipt.idempotent_replay):
            raise ValueError("source_status_mismatch")
        return self


class SourceIntakeService:
    def __init__(self, *, owner_id: str, store):
        assert_not_voice_lab_principal(owner_id)
        if not owner_id or owner_id != owner_id.strip():
            raise ValueError("source_owner_invalid")
        self.owner_id, self.store = owner_id, store

    def profile(self, *, session_id: str, thread_id: str, session_store) -> SourceProfile:
        from .owner_authority import resolve_owner_authority

        try:
            # Positive durable legacy evidence only; absence/outage is not a
            # profile. This observation never authorizes a later model request.
            authority = resolve_owner_authority(self.owner_id, store=self.store)
            parent = session_store.get(self.owner_id, session_id)
            if parent is None or (parent.user_id, parent.session_id, parent.thread_id) != (self.owner_id, session_id, thread_id) or "synthetic_voice_lab" in parent.metadata:
                raise ValueError("source_profile_scope_invalid")
            boundary = self.boundary(session_id=session_id, thread_id=thread_id) if authority.authority_state == "governed" else None
            return SourceProfile(schema="mem00.source-profile.v1", owner_id=self.owner_id, session_id=session_id,
                thread_id=thread_id, authority=authority.authority_state, boundary=boundary, observation_only=True)
        except Exception:
            raise MemoryGovernanceUnavailable("memory_source_profile_unavailable") from None

    def boundary(self, *, session_id: str, thread_id: str) -> SourceBoundary:
        raw = self.store.source_boundary(user_id=self.owner_id, session_id=session_id, thread_id=thread_id)
        try:
            result = SourceBoundary.model_validate(raw)
            if (result.owner_id, result.session_id, result.thread_id) != (self.owner_id, session_id, thread_id):
                raise ValueError("source_boundary_mismatch")
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_source_boundary_invalid") from None

    def accept(self, *, session_id: str, action: SourceActionRequest) -> SourceActionReceipt:
        message = SessionMessageRecord(session_id=session_id, thread_id=action.thread_id, message_id=action.message_id, role="user", content=action.content)
        row_id = _storage_message_row_id(message)
        content_ref = keyed_ref("source-action-content", action.content)
        # Every effect-changing input, including the originally observed epoch,
        # belongs to the stable digest. Never read a newer epoch for a retry.
        digest = CanonicalMemoryService._stable_payload(
            "source_action",
            {
                "owner_id": self.owner_id,
                "session_id": session_id,
                "source_row_id": row_id,
                **action.model_dump(exclude={"content"}),
                "content_ref": content_ref,
            },
        )
        from .refs import request_digest

        raw = self.store.accept_source_action(
            p_user_id=self.owner_id,
            p_session_id=session_id,
            p_thread_id=action.thread_id,
            p_message_id=action.message_id,
            p_source_row_id=row_id,
            p_content=action.content,
            p_expected_clear_epoch=action.expected_clear_epoch,
            p_idempotency_key=action.command_key,
            p_request_digest=request_digest(digest),
            p_content_ref=content_ref,
        )
        try:
            result = SourceActionReceipt.model_validate(raw)
            if (result.owner_id, result.session_id, result.thread_id, result.command_key, result.message_id, result.source_row_id, result.memory_clear_epoch, result.content_ref) != (
                self.owner_id,
                session_id,
                action.thread_id,
                action.command_key,
                action.message_id,
                row_id,
                action.expected_clear_epoch,
                content_ref,
            ):
                raise ValueError("source_receipt_mismatch")
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_source_receipt_invalid") from None

    def status(self, *, command_key: str) -> SourceActionStatus:
        raw = self.store.source_action_status(user_id=self.owner_id, command_key=command_key)
        try:
            result = SourceActionStatus.model_validate(raw)
            if (result.owner_id, result.command_key) != (self.owner_id, command_key):
                raise ValueError("source_status_mismatch")
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_source_status_invalid") from None
