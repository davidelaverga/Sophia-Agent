"""Durable, one-shot fault controls for the MEM00 synthetic principal only."""

from __future__ import annotations

from typing import Literal, get_args

from .flags import memory_feature_flags_for_owner
from .identity import memory_certification_principal
from .refs import keyed_ref
from .store import SupabaseMemoryGovernanceStore, configured_memory_store

FaultMode = Literal[
    "extraction_claimant_crash",
    "provider_timeout_before_effect",
    "provider_commit_response_loss",
    "provider_429_5xx",
    "database_failure_after_provider_success",
    "projection_lease_expiry",
    "provider_delete_blocked",
    "cache_retained_through_tombstone",
    "langsmith_unavailable",
]

FAULT_MODES = frozenset(get_args(FaultMode))


class MemoryFaultControlError(RuntimeError):
    pass


class InjectedExtractionClaimantCrash(RuntimeError):
    """Abort one claimant cycle without completing or failing its lease."""


class MemoryFaultController:
    def __init__(self, *, store: SupabaseMemoryGovernanceStore | None = None) -> None:
        self.store = store or configured_memory_store()

    @staticmethod
    def _assert_authorized(owner_id: str) -> None:
        if owner_id != memory_certification_principal():
            raise MemoryFaultControlError("memory_fault_principal_denied")
        if not memory_feature_flags_for_owner(owner_id).memory_fault_injection:
            raise MemoryFaultControlError("memory_fault_injection_disabled")

    def arm(
        self,
        *,
        owner_id: str,
        mode: FaultMode,
        ttl_seconds: int = 120,
        operation_ref: str,
    ) -> dict[str, object]:
        self._assert_authorized(owner_id)
        if mode not in FAULT_MODES or not 1 <= ttl_seconds <= 300:
            raise MemoryFaultControlError("memory_fault_setting_invalid")
        return self.store.arm_fault(
            user_id=owner_id,
            mode=mode,
            ttl_seconds=ttl_seconds,
            audit_ref=keyed_ref("fault-operation", operation_ref),
        )

    def consume(self, *, owner_id: str, mode: FaultMode) -> bool:
        self._assert_authorized(owner_id)
        return self.store.consume_fault(user_id=owner_id, mode=mode)

    def clear(self, *, owner_id: str) -> int:
        self._assert_authorized(owner_id)
        return self.store.clear_faults(user_id=owner_id)


__all__ = [
    "FAULT_MODES",
    "FaultMode",
    "InjectedExtractionClaimantCrash",
    "MemoryFaultControlError",
    "MemoryFaultController",
]
