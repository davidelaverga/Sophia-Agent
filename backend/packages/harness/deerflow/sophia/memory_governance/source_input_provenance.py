"""Bind authenticated current input to an already-recorded original source.

Read evidence only: this is not the final per-model dispatch permit. Never
create a source or refresh an old action epoch in an auth hook or retry.
"""

import re
from typing import Literal

from pydantic import Field

from .refs import keyed_ref
from .source_intake import ActionKey, IntakeModel, SourceActionRequest, SourceIntakeService, UuidText
from .source_snapshot import SourceSnapshot
from .store import MemoryGovernanceConflict, MemoryGovernanceUnavailable

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


# Literals raised by the admission checks below and in input/pending
# provenance. Only these, a governance store reason or a class name are ever
# reported: exception text can carry owner content and is never used.
_SAFE_VALUE_REASONS = frozenset({
    "scope", "original_receipt", "source_scope_or_epoch", "source_missing", "source_before_clear",
    "source_accepted_version_changed", "source_acceptance_unproven", "source_sequence_changed",
    "source_version_changed", "source_epoch_changed", "source_acceptance_changed",
    "thread", "source_not_recorded", "action_changed",
    "recorded_input_transform_unproven", "authenticated_input_invalid", "authenticated_input_too_large",
    "authenticated_input_owner_invalid", "authenticated_input_fields_invalid", "authenticated_input_messages_invalid",
    "authenticated_input_role_invalid", "authenticated_input_message_fields_invalid", "authenticated_input_content_invalid",
    "state_shape", "current_scope", "unsealed_nonmessage_state", "no_exact_appended_suffix", "old_whole_state_changed",
    "pending_bound", "not_plain_user_input", "pending_source_order_or_scope", "pending_source_text_changed",
    "pending_message_metadata",
})
_STORE_REASON = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# What safe_reason_code itself returns: a literal above, a store reason or a
# class name. Only these are carried from one wrapper to the next.
_CARRIED_REASON = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def safe_reason_code(exc: BaseException) -> str:
    """Content-free cause of an admission refusal, for logs only. Never raises."""
    try:
        carried = getattr(exc, "safe_reason", None)
        if isinstance(carried, str) and _CARRIED_REASON.fullmatch(carried):
            return carried
        if type(exc) is ValueError and len(exc.args) == 1 and isinstance(exc.args[0], str) and exc.args[0] in _SAFE_VALUE_REASONS:
            return exc.args[0]
        # Governance store errors carry fixed reasons such as governance_http_4xx.
        reason = getattr(exc, "reason", None)
        if isinstance(exc, MemoryGovernanceUnavailable | MemoryGovernanceConflict) and isinstance(reason, str) and _STORE_REASON.fullmatch(reason):
            return reason
        return type(exc).__name__
    except Exception:
        return "unclassified"


def _source_unavailable(exc: BaseException) -> MemoryGovernanceUnavailable:
    error = MemoryGovernanceUnavailable("recorded_input_source_unavailable")
    error.safe_reason = safe_reason_code(exc)
    return error


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
        if row.eligibility != "eligible":
            raise ValueError(f"source_{row.eligibility}")
        if row.sequence != witness.sequence:
            raise ValueError("source_sequence_changed")
        if row.source_version != witness.source_version:
            raise ValueError("source_version_changed")
        if row.acceptance_epoch != witness.memory_clear_epoch:
            raise ValueError("source_epoch_changed")
        # The epoch-zero SQL trigger intentionally leaves accepted_version
        # null. Only an immutable explicit-action receipt whose version still
        # equals the current row proves this source; legacy eligibility alone
        # never does. Nonzero epochs additionally require the acceptance stamp.
        if row.accepted_version != witness.source_version and not (witness.memory_clear_epoch == 0 and row.accepted_version is None):
            raise ValueError("source_acceptance_changed")
        return witness
    except Exception as exc:
        raise _source_unavailable(exc) from None


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
    except Exception as exc:
        raise _source_unavailable(exc) from None
