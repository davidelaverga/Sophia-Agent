"""One-use, current SQL authority at the actual extractor dispatch boundary.

An authorization event is not proof of transmission or completion. Lost replies
consume this attempt locally; no historical receipt can authorize another send.
"""

from datetime import UTC, datetime
from threading import Lock
from typing import Literal
from uuid import uuid4

from pydantic import Field, field_validator

from .identity import assert_not_voice_lab_principal
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable


class ExtractionDispatchReceipt(IntakeModel):
    schema_name: Literal["mem00.extraction-dispatch.v1"] = Field(alias="schema")
    owner_id: str
    session_id: str
    thread_id: str
    extraction_run_id: UuidText
    lease_token: UuidText
    attempt_id: UuidText
    event_id: UuidText
    input_manifest_ref: str
    extractor_input_ref: str
    memory_clear_epoch: int = Field(ge=0)
    accepted_at: str
    expires_at: str
    single_use: HistoricalOnly
    sdk_max_retries: int = Field(ge=0, le=0)
    dispatch_observed: bool

    @field_validator("dispatch_observed")
    @classmethod
    def not_observed(cls, value):
        if value is not False:
            raise ValueError("extraction_dispatch_not_observed")
        return value


class ExtractionDispatchAuthority:
    def __init__(self, *, run, store):
        assert_not_voice_lab_principal(run.user_id)
        if run.lease_token is None or run.extractor_input_ref is None:
            raise MemoryGovernanceUnavailable("extraction_dispatch_lease_missing")
        self.run = run.model_copy(deep=True)
        self.store = store
        self.attempt_id = str(uuid4())
        self._used = False
        self._lock = Lock()

    def admit(self, *, owner_id: str, session_id: str, extractor_input_ref: str):
        with self._lock:
            if self._used:
                raise MemoryGovernanceUnavailable("extraction_dispatch_already_consumed")
            self._used = True
        run = self.run
        if (owner_id, session_id, extractor_input_ref) != (run.user_id, run.session_id, run.extractor_input_ref):
            raise MemoryGovernanceUnavailable("extraction_dispatch_scope_invalid")
        raw = self.store.authorize_extraction_dispatch(
            p_user_id=owner_id,
            p_extraction_run_id=str(run.extraction_run_id),
            p_lease_token=str(run.lease_token),
            p_attempt_id=self.attempt_id,
            p_input_manifest_ref=run.input_manifest_ref,
            p_extractor_input_ref=extractor_input_ref,
        )
        try:
            result = ExtractionDispatchReceipt.model_validate(raw)
            if (result.owner_id, result.session_id, result.thread_id, result.extraction_run_id, result.lease_token, result.attempt_id, result.input_manifest_ref, result.extractor_input_ref) != (
                owner_id,
                session_id,
                run.thread_id,
                str(run.extraction_run_id),
                str(run.lease_token),
                self.attempt_id,
                run.input_manifest_ref,
                extractor_input_ref,
            ):
                raise ValueError("extraction_dispatch_scope_invalid")
            accepted = datetime.fromisoformat(result.accepted_at.replace("Z", "+00:00"))
            expires = datetime.fromisoformat(result.expires_at.replace("Z", "+00:00"))
            if accepted.tzinfo is None or expires.tzinfo is None or not accepted <= datetime.now(UTC) < expires or not 0 < (expires - accepted).total_seconds() <= 5:
                raise ValueError("extraction_dispatch_time_invalid")
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("extraction_dispatch_receipt_invalid") from None
