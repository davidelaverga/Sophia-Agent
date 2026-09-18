"""Durable ownership resolution before legacy or governed memory access.

No environment flag, negative cache, absent row or transport failure proves
pre-cutover ownership. This reader does not enroll or mutate owners. Positive
legacy decisions are never cached across requests.
"""

from dataclasses import replace

from .flags import MemoryFeatureFlags, configured_memory_feature_flags_for_owner
from .store import (
    MemoryGovernanceUnavailable,
    MemoryOwnerUndeclared,
    configured_memory_store,
    memory_governance_deliberately_absent,
)

OWNER_AUTHORITY_READER = "mem00.owner-authority.v1"
SUPPORTED_OWNER_EPOCHS = frozenset({1})


def resolve_owner_authority(owner_id, *, store=None):
    try:
        if not isinstance(owner_id, str) or not owner_id or owner_id != owner_id.strip():
            raise ValueError("owner_invalid")
        store = store or configured_memory_store()
        contract = store.get_contract()
        if contract.schema_version != "mem00.v1" or contract.contract_epoch not in SUPPORTED_OWNER_EPOCHS:
            raise ValueError("contract_unsupported")
        authority = store.get_owner_authority(owner_id)
        if authority.user_id != owner_id:
            raise ValueError("authority_unproven")
        if authority.authority_state == "unknown":
            # The schema's own default for every account that has never been
            # declared. A definite answer, and still not legacy.
            raise MemoryOwnerUndeclared("memory_owner_undeclared")
        if (authority.authority_state not in {"legacy", "governed"}
                or authority.authority_declared_at is None or authority.authority_epoch not in SUPPORTED_OWNER_EPOCHS
                or authority.authority_epoch != contract.contract_epoch):
            raise ValueError("authority_unproven")
        return authority
    except MemoryOwnerUndeclared:
        # Propagate the narrower answer; it is still a MemoryGovernanceUnavailable
        # for every caller that does not distinguish them.
        raise
    except Exception:
        raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable") from None


def owner_is_definitely_undeclared(owner_id, *, store=None) -> bool:
    """True only for a definite "this owner has no durable declaration".

    Only MemoryOwnerUndeclared counts: the store answered against a current
    schema and the owner simply is not enrolled. A transport failure, an error
    body or an unsupported contract is NOT this -- those keep the governed path
    engaged so it fails closed for a governed owner during an outage, rather
    than silently skipping memory governance for everyone.

    Callers use this to open the no-memory path, never to grant memory access.
    """
    try:
        resolve_owner_authority(owner_id, store=store)
    except MemoryOwnerUndeclared:
        return True
    except Exception:
        return False
    return False


def ordinary_path_memory_flags_for_owner(owner_id, *, store=None, environ=None) -> MemoryFeatureFlags:
    """Owner-scoped availability for code paths that are not memory features.

    Ordinary chat and session finalization must keep working for people who are
    not in the pilot. They call this instead of `resolved_memory_flags_for_owner`
    so that an owner who is merely *undeclared* yields all-off flags — the
    pre-MEM00 behaviour — while a store or transport failure still fails closed,
    which is what keeps the guard honest for a governed owner during an outage.

    Nothing here grants memory access: the result is `MemoryFeatureFlags()` with
    every flag false, and `legacy_memory_lane_allowed` still answers False.
    """
    try:
        return resolved_memory_flags_for_owner(owner_id, store=store, environ=environ)
    except MemoryOwnerUndeclared:
        return MemoryFeatureFlags()
    except MemoryGovernanceUnavailable:
        # Exactly two things may select all-off flags. One is the definite
        # MemoryOwnerUndeclared above. The other is an operator DECLARING that
        # MEM00 is not installed here, which is only honoured outside a
        # deployment. An OUTAGE is neither, and must never land here.
        #
        # Two earlier versions of this were wrong, in the same direction. The
        # first asked only `any_enabled()`, so rolled-back flags plus an
        # unreachable store degraded. The second asked whether the Supabase
        # credentials were present, which reads a missing SETTING as an absence
        # of durable records -- a deploy that drops one variable would then skip
        # source invalidation on delete and serve recaps never bound to a
        # canonical revision, over a database still full of canonical rows.
        #
        # The check also stays AFTER the resolution attempt, not before it:
        # `resolved_memory_flags_for_owner` forces candidate_ledger_read and
        # canonical_pool_read True for a governed owner regardless of the
        # environment, so canonical management stays routed to the ledger even
        # when recall is off. Short-circuiting on the environment first stripped
        # that from every governed owner.
        if store is None and memory_governance_deliberately_absent(environ):
            return MemoryFeatureFlags()
        raise


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
