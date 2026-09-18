"""Final admission for a request that carries no memory at all.

An undeclared owner holds neither lane: not the governed one, which requires
`authority_state='governed'`, and not the temporary legacy one, which requires a
durable pre-cutover `authority_state='legacy'` declaration. Both SQL permits
refuse them by design, so routing their ordinary text turn through either
authority turns "this user is not in the pilot" into "this user cannot use the
product".

The permit exists to authorize *memory reaching a model*. This attempt carries
none: no admission, no inclusion manifest, no source witness, no Builder or
completion binding, no retained context. There is nothing for the database to
authorize, and asking it anyway would put a governance round trip on every
ordinary request from every non-pilot user.

So this authority is minted locally -- and it is the only one that may be. It
earns that by proving emptiness structurally rather than asserting it: the
attempt schema has no field capable of naming a memory, and the constructor
refuses unless every memory-bearing value the guard could hold is absent. The
exactness and single-use obligations are unchanged, and the receipt keeps the
same liveness shape so the transport's contract stays uniform across all three
lanes rather than acquiring a special case that skips checks.
"""

from datetime import UTC, datetime, timedelta
from threading import Lock
from time import monotonic
from typing import Literal
from uuid import uuid4

from pydantic import Field, field_validator

from .identity import assert_not_voice_lab_principal
from .model_dispatch import FinalModelDispatchReceipt, snapshot_model_request
from .source_intake import HistoricalOnly, IntakeModel, UuidText
from .store import MemoryGovernanceUnavailable

# Same shape as the SQL permits mint, so require_live() is one contract.
NO_MEMORY_PERMIT_SECONDS = 5


class NoMemoryModelAttempt(IntakeModel):
    """Note what is absent: no manifest, no witness, no bindings, no epochs.

    A memory cannot be smuggled through this attempt because there is no field
    to put one in. `memory_material_present` is a declaration the detector can
    read after the fact, not the mechanism.
    """

    schema_name: Literal["mem00.no-memory-model-attempt.v1"] = Field(alias="schema")
    attempt_id: UuidText
    run_id: UuidText
    thread_id: UuidText
    scope: str = Field(min_length=1, max_length=512)
    authority_state: Literal["unknown"]
    memory_material_present: Literal[False]
    payload_ref: str = Field(pattern=r"^hmac-sha256:model-payload:[a-f0-9]{64}$")
    endpoint_ref: str = Field(pattern=r"^hmac-sha256:model-endpoint:[a-f0-9]{64}$")
    model_ref: str = Field(pattern=r"^hmac-sha256:model-route:[a-f0-9]{64}$")

    @field_validator("memory_material_present", mode="before")
    @classmethod
    def exactly_none(cls, value):
        if value is not False:
            raise ValueError("no_memory_model_attempt_invalid")
        return value


class NoMemoryModelReceipt(NoMemoryModelAttempt):
    schema_name: Literal["mem00.no-memory-model-dispatch.v1"] = Field(alias="schema")
    owner_id: str = Field(min_length=1)
    event_id: UuidText
    canonical_approval_granted: bool
    legacy_lane_used: bool
    accepted_at: str
    expires_at: str
    single_use: HistoricalOnly
    dispatch_observed: bool

    @field_validator("canonical_approval_granted", "legacy_lane_used", "dispatch_observed", mode="before")
    @classmethod
    def not_approved_or_sent(cls, value):
        if value is not False:
            raise ValueError("no_memory_model_receipt_invalid")
        return value

    require_live = FinalModelDispatchReceipt.require_live


class NoMemoryModelDispatchAuthority:
    """One-use permit for an empty request; never a memory approval."""

    def __init__(self, *, owner_id, attempt, memory_state):
        assert_not_voice_lab_principal(owner_id)
        if not isinstance(owner_id, str) or not owner_id.strip() or owner_id != owner_id.strip():
            raise MemoryGovernanceUnavailable("memory_no_memory_model_owner_invalid")
        # The emptiness claim is checked here, at the boundary, against the
        # guard's own values -- not taken on trust from the caller that built
        # the attempt. Anything carrying memory belongs in a lane with a
        # database permit behind it.
        if any(value for value in memory_state):
            raise MemoryGovernanceUnavailable("memory_no_memory_model_material_present")
        self.owner_id = owner_id
        self._attempt_json = NoMemoryModelAttempt.model_validate(
            attempt.model_dump(mode="json", by_alias=True)).model_dump_json(by_alias=True)
        self._lock, self._used = Lock(), False

    @property
    def attempt(self):
        return NoMemoryModelAttempt.model_validate_json(self._attempt_json)

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
            accepted = datetime.now(UTC)
            attempt = self.attempt
            result = NoMemoryModelReceipt.model_validate({
                **attempt.model_dump(mode="json", by_alias=True),
                "schema": "mem00.no-memory-model-dispatch.v1",
                "owner_id": self.owner_id,
                "event_id": str(uuid4()),
                "canonical_approval_granted": False,
                "legacy_lane_used": False,
                "accepted_at": accepted.isoformat().replace("+00:00", "Z"),
                "expires_at": (accepted + timedelta(seconds=NO_MEMORY_PERMIT_SECONDS)).isoformat().replace("+00:00", "Z"),
                "single_use": True,
                "dispatch_observed": False,
            })
            fields = set(NoMemoryModelAttempt.model_fields) - {"schema_name"}
            if result.owner_id != self.owner_id or result.model_dump(include=fields) != attempt.model_dump(include=fields):
                raise ValueError("receipt_scope")
            if monotonic() - started >= NO_MEMORY_PERMIT_SECONDS:
                raise ValueError("receipt_delayed")
            result.require_live()
            self.require_exact(request)
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_no_memory_model_dispatch_unavailable") from None
