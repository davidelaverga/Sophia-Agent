"""Durable ownership resolution before legacy or governed memory access.

No environment flag, negative cache, absent row or transport failure proves
pre-cutover ownership. This reader does not enroll or mutate owners. Positive
legacy decisions are never cached across requests.
"""

from dataclasses import replace

from .flags import MemoryFeatureFlags, configured_memory_feature_flags_for_owner
from .store import MemoryGovernanceUnavailable, configured_memory_store

OWNER_AUTHORITY_READER = "mem00.owner-authority.v1"
SUPPORTED_OWNER_EPOCHS = frozenset({1})


def resolve_owner_authority(owner_id, *, store=None):
    try:
        if not isinstance(owner_id, str) or not owner_id or owner_id != owner_id.strip():
            raise ValueError("owner_invalid")
        store = store or configured_memory_store()
        contract = store.get_contract()
        authority = store.get_owner_authority(owner_id)
        if (authority.user_id != owner_id or authority.authority_state not in {"legacy", "governed"}
                or authority.authority_declared_at is None or authority.authority_epoch not in SUPPORTED_OWNER_EPOCHS
                or authority.authority_epoch != contract.contract_epoch or contract.schema_version != "mem00.v1"):
            raise ValueError("authority_unproven")
        return authority
    except Exception:
        raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable") from None


def resolved_memory_flags_for_owner(owner_id, *, store=None, environ=None):
    authority = resolve_owner_authority(owner_id, store=store)
    if authority.authority_state == "legacy":
        # Even a configured cohort cannot silently enroll a declared legacy owner.
        return MemoryFeatureFlags()
    try:
        configured = configured_memory_feature_flags_for_owner(owner_id, environ)
    except Exception:
        raise MemoryGovernanceUnavailable("memory_configuration_unavailable") from None
    # Availability flags control optional producers/recall, never ownership.
    # Canonical management remains routed to the ledger when recall is off.
    return replace(configured, candidate_ledger_read=True, canonical_pool_read=True)


def legacy_memory_lane_allowed(owner_id) -> bool:
    """No cached or negative decision can enable unversioned memory paths."""
    try:
        return resolve_owner_authority(owner_id).authority_state == "legacy"
    except MemoryGovernanceUnavailable:
        return False


def require_legacy_memory_lane(owner_id) -> None:
    authority = resolve_owner_authority(owner_id)
    if authority.authority_state != "legacy":
        raise MemoryGovernanceUnavailable("legacy_memory_disabled")


def require_candidate_extraction(owner_id, *, store=None) -> None:
    """A worker's global enablement is not authorization for a claimed owner."""
    try:
        store = store or configured_memory_store()
        flags = resolved_memory_flags_for_owner(owner_id, store=store)
        if not flags.candidate_ledger_write:
            raise MemoryGovernanceUnavailable("memory_extraction_disabled")
        if store.get_contract().mode not in {"shadow", "enforced"}:
            raise MemoryGovernanceUnavailable("memory_contract_not_active")
    except MemoryGovernanceUnavailable:
        raise
    except Exception:
        raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable") from None
