"""Bind authenticated current input to an already-recorded original source.

Read evidence only: this is not the final per-model dispatch permit. Never
create a source or refresh an old action epoch in an auth hook or retry.
"""

from typing import Literal

from pydantic import Field

from .refs import keyed_ref
from .source_intake import ActionKey, IntakeModel, SourceActionRequest, SourceIntakeService, UuidText
from .source_snapshot import SourceSnapshot
from .store import MemoryGovernanceUnavailable

SOURCE_ACTION_KEY = "memory_source_action"
SOURCE_SESSION_KEY = "memory_source_session_id"


class SourceInputWitness(IntakeModel):
    schema_name: Literal["mem00.recorded-input-source.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    session_id: UuidText
    thread_id: UuidText
    command_key: ActionKey
    event_id: UuidText
    message_id: ActionKey
    source_row_id: UuidText
    source_version: UuidText
    sequence: int = Field(gt=0)
    memory_clear_epoch: int = Field(ge=0)
    content_ref: str = Field(pattern=r"^hmac-sha256:source-action-content:[a-f0-9]{64}$")


def _witness(receipt):
    return SourceInputWitness.model_validate({"schema": "mem00.recorded-input-source.v1",
        **receipt.model_dump(include=set(SourceInputWitness.model_fields) - {"schema_name"})})


def recheck_recorded_source(*, witness: SourceInputWitness, owner_id: str, thread_id: str, store):
    """Current immutable receipt/source-version/epoch join, with no effect."""
    try:
        witness = SourceInputWitness.model_validate(witness.model_dump(mode="python", by_alias=True, warnings=False))
        if (witness.owner_id, witness.thread_id) != (owner_id, thread_id):
            raise ValueError("scope")
        status = SourceIntakeService(owner_id=owner_id, store=store).status(command_key=witness.command_key)
        if status.receipt is None or _witness(status.receipt) != witness:
            raise ValueError("original_receipt")
        snapshot = SourceSnapshot.model_validate(store.source_snapshot(user_id=owner_id, session_id=witness.session_id, thread_id=thread_id))
        if (snapshot.owner_id, snapshot.session_id, snapshot.thread_id, snapshot.memory_clear_epoch) != (owner_id, witness.session_id, thread_id, witness.memory_clear_epoch):
            raise ValueError("source_scope_or_epoch")
        rows = [row for row in snapshot.sources if row.message_id == witness.message_id]
        if len(rows) != 1:
            raise ValueError("source_missing")
        row = rows[0]
        if (row.eligibility, row.sequence, row.source_version, row.acceptance_epoch) != (
            "eligible", witness.sequence, witness.source_version, witness.memory_clear_epoch
        ):
            raise ValueError("source_changed")
        # The epoch-zero SQL trigger intentionally leaves accepted_version
        # null. Only an immutable explicit-action receipt whose version still
        # equals the current row proves this source; legacy eligibility alone
        # never does. Nonzero epochs additionally require the acceptance stamp.
        if row.accepted_version != witness.source_version and not (witness.memory_clear_epoch == 0 and row.accepted_version is None):
            raise ValueError("source_acceptance_changed")
        return witness
    except Exception:
        raise MemoryGovernanceUnavailable("recorded_input_source_unavailable") from None


def observe_recorded_source(*, owner_id: str, session_id: str, thread_id: str, action, store):
    try:
        original = SourceActionRequest.model_validate(action)
        if original.thread_id != thread_id:
            raise ValueError("thread")
        status = SourceIntakeService(owner_id=owner_id, store=store).status(command_key=original.command_key)
        if status.receipt is None:
            raise ValueError("source_not_recorded")
        witness = _witness(status.receipt)
        if (witness.owner_id, witness.session_id, witness.thread_id, witness.message_id, witness.memory_clear_epoch, witness.content_ref) != (
            owner_id, session_id, thread_id, original.message_id, original.expected_clear_epoch, keyed_ref("source-action-content", original.content)
        ):
            raise ValueError("action_changed")
        return recheck_recorded_source(witness=witness, owner_id=owner_id, thread_id=thread_id, store=store)
    except Exception:
        raise MemoryGovernanceUnavailable("recorded_input_source_unavailable") from None
