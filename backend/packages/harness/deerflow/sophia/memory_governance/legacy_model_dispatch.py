"""One-use exact legacy model permit, never canonical memory approval.

Only a durable, affirmative pre-cutover owner declaration can authorize this
temporary lane. The final SQL lock races cutover; flags cannot reopen it.
"""
from threading import Lock
from time import monotonic
from typing import Literal

from pydantic import Field, field_validator

from .identity import assert_not_voice_lab_principal
from .model_dispatch import FinalModelDispatchReceipt, snapshot_model_request
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable


class LegacyModelAttempt(IntakeModel):
    schema_name: Literal["mem00.legacy-model-attempt.v1"] = Field(alias="schema")
    attempt_id: UuidText
    run_id: UuidText
    thread_id: UuidText
    scope: str = Field(min_length=1, max_length=512)
    contract_epoch: Literal[1]
    payload_ref: str = Field(pattern=r"^hmac-sha256:model-payload:[a-f0-9]{64}$")
    endpoint_ref: str = Field(pattern=r"^hmac-sha256:model-endpoint:[a-f0-9]{64}$")
    model_ref: str = Field(pattern=r"^hmac-sha256:model-route:[a-f0-9]{64}$")

    @field_validator("contract_epoch", mode="before")
    @classmethod
    def exact_epoch(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("legacy_model_epoch_invalid")
        return value


class LegacyModelReceipt(LegacyModelAttempt):
    schema_name: Literal["mem00.legacy-model-dispatch.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    event_id: UuidText
    authority_state: Literal["legacy"]
    canonical_approval_granted: bool
    accepted_at: str
    expires_at: str
    single_use: HistoricalOnly
    dispatch_observed: bool

    @field_validator("canonical_approval_granted", "dispatch_observed", mode="before")
    @classmethod
    def not_approved_or_sent(cls, value):
        if value is not False:
            raise ValueError("legacy_model_receipt_invalid")
        return value

    require_live = FinalModelDispatchReceipt.require_live


class LegacyModelDispatchAuthority:
    def __init__(self, *, owner_id, attempt, store):
        assert_not_voice_lab_principal(owner_id)
        if not isinstance(owner_id, str) or not owner_id.strip() or owner_id != owner_id.strip():
            raise MemoryGovernanceUnavailable("memory_legacy_model_owner_invalid")
        self.owner_id, self.store = owner_id, store
        self._attempt_json = LegacyModelAttempt.model_validate(attempt.model_dump(mode="json", by_alias=True)).model_dump_json(by_alias=True)
        self._lock, self._used = Lock(), False

    @property
    def attempt(self):
        return LegacyModelAttempt.model_validate_json(self._attempt_json)

    def require_exact(self, request):
        snapshot = snapshot_model_request(request)
        if snapshot.__dict__ != self.attempt.model_dump(include={"payload_ref", "endpoint_ref", "model_ref"}):
            raise MemoryGovernanceUnavailable("memory_model_payload_changed")

    def admit(self, request):
        with self._lock:
            if self._used:
                raise MemoryGovernanceUnavailable("memory_model_attempt_consumed")
            self._used = True
        started = monotonic()
        try:
            self.require_exact(request)
            result = LegacyModelReceipt.model_validate(self.store.authorize_legacy_model_dispatch(
                p_user_id=self.owner_id, p_attempt=self.attempt.model_dump(mode="json", by_alias=True)))
            fields = set(LegacyModelAttempt.model_fields) - {"schema_name"}
            if result.owner_id != self.owner_id or result.model_dump(include=fields) != self.attempt.model_dump(include=fields):
                raise ValueError("receipt_scope")
            if monotonic() - started >= 5:
                raise ValueError("receipt_delayed")
            result.require_live()
            self.require_exact(request)
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_legacy_model_dispatch_unavailable") from None
