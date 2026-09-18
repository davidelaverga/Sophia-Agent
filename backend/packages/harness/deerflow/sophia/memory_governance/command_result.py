"""Immutable logical command outcome and an independently current display view."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from .inventory import InventoryRecord
from .models import CommandReceipt, StrictModel
from .store import MemoryGovernanceUnavailable


class CurrentMemoryView(StrictModel):
    schema_name: Literal["mem00.current-memory.v1"] = Field(alias="schema")
    owner_id: str
    memory_id: UUID
    status: Literal["available", "not_found", "unavailable"]
    lifecycle: Literal["active", "forgotten", "tombstoned"] | None
    content_revision: int | None = Field(gt=0, strict=True)
    memory_governance_revision: int | None = Field(gt=0, strict=True)
    memory: InventoryRecord | None
    provider_state_queried: Literal[False]
    current_view_only: Literal[True]

    @model_validator(mode="after")
    def validate_current_state(self):
        if self.status != "available":
            if any(value is not None for value in (self.lifecycle, self.content_revision, self.memory_governance_revision, self.memory)):
                raise ValueError("memory_current_view_unavailable")
        elif self.lifecycle is None or self.content_revision is None or self.memory_governance_revision is None:
            raise ValueError("memory_current_view_incomplete")
        elif self.lifecycle == "tombstoned":
            if self.memory is not None:
                raise ValueError("memory_current_tombstone_has_text")
        elif (self.memory is None or self.memory.kind != "memory" or self.memory.id != self.memory_id
                or self.memory.state != self.lifecycle or self.memory.revision != self.content_revision
                or self.memory.memory_governance_revision != self.memory_governance_revision):
            raise ValueError("memory_current_view_mismatch")
        return self


class DeletionDisposition(StrictModel):
    scope: Literal["canonical_memory_only"] = "canonical_memory_only"
    canonical_fence: Literal["committed_in_original_receipt"] = "committed_in_original_receipt"
    canonical_plaintext_erasure: Literal["not_verified_in_this_response"] = "not_verified_in_this_response"
    provider_cleanup: Literal["not_verified_in_this_response"] = "not_verified_in_this_response"
    derived_invalidation: Literal["not_verified_in_this_response"] = "not_verified_in_this_response"
    managed_browser_erasure: Literal["not_verified_in_this_response"] = "not_verified_in_this_response"
    source_transcript: Literal["not_deleted_by_this_command"] = "not_deleted_by_this_command"
    other_account_data: Literal["not_covered_by_mem00"] = "not_covered_by_mem00"
    verification_as_of: None = None
    provider_state_queried: Literal[False] = False


class CanonicalCommandResult(StrictModel):
    schema_name: Literal["mem00.command-result.v1"] = Field(alias="schema")
    owner_id: str
    command_key: str = Field(min_length=8, max_length=200)
    status: Literal["committed"]
    historical_result_only: Literal[True]
    receipt: CommandReceipt
    current_view: CurrentMemoryView
    privacy_disposition: DeletionDisposition | None = None

    @model_validator(mode="after")
    def validate_scope(self):
        if self.owner_id != self.current_view.owner_id or self.receipt.memory_id != self.current_view.memory_id:
            raise ValueError("memory_command_result_scope_invalid")
        deleted = self.receipt.event_type == "memory_tombstoned"
        if deleted != (self.privacy_disposition is not None):
            raise ValueError("memory_command_privacy_disposition_invalid")
        if deleted and (self.receipt.resulting_lifecycle != "tombstoned" or not self.receipt.tombstone_id or self.receipt.status != "accepted_and_fenced"):
            raise ValueError("memory_command_tombstone_receipt_invalid")
        if self.current_view.status == "available":
            if ((deleted and self.current_view.lifecycle != "tombstoned")
                    or self.current_view.content_revision < (self.receipt.content_revision or 0)
                    or self.current_view.memory_governance_revision < (self.receipt.memory_governance_revision or 0)):
                raise ValueError("memory_command_current_view_precedes_receipt")
        return self


def command_result(*, owner_id: str, command_key: str, receipt, store) -> CanonicalCommandResult:
    try:
        logical = CommandReceipt.model_validate(receipt.model_dump(mode="json", by_alias=True))
        if logical.memory_id is None:
            raise ValueError
    except Exception:
        raise MemoryGovernanceUnavailable("memory_command_receipt_unavailable") from None
    try:
        current = store.current_memory(user_id=owner_id, memory_id=logical.memory_id)
        if current.owner_id != owner_id or current.memory_id != logical.memory_id:
            raise MemoryGovernanceUnavailable("memory_current_view_scope_invalid")
        if current.status == "available" and (
            (logical.event_type == "memory_tombstoned" and current.lifecycle != "tombstoned")
            or current.content_revision < (logical.content_revision or 0)
            or current.memory_governance_revision < (logical.memory_governance_revision or 0)
        ):
            raise MemoryGovernanceUnavailable("memory_current_view_precedes_receipt")
    except Exception:
        # Current read uncertainty cannot erase a committed historical decision,
        # restore its old plaintext or silently issue another command.
        current = CurrentMemoryView.model_validate({"schema": "mem00.current-memory.v1", "owner_id": owner_id,
            "memory_id": str(logical.memory_id), "status": "unavailable", "lifecycle": None, "content_revision": None,
            "memory_governance_revision": None, "memory": None, "provider_state_queried": False, "current_view_only": True})
    return CanonicalCommandResult.model_validate({"schema": "mem00.command-result.v1", "owner_id": owner_id,
        "command_key": command_key, "status": "committed", "historical_result_only": True,
        "receipt": logical, "current_view": current,
        "privacy_disposition": DeletionDisposition() if logical.event_type == "memory_tombstoned" else None})
