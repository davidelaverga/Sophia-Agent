"""Content-free decision for rotating a previously admitted memory context.

This is not an admission authority: callers must obtain owner-bound, complete
governance observations and independently render freshly authorized canonical
text. A decision cannot authorize provider text, cached text or an old revision.
"""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID


@dataclass(frozen=True)
class MemoryInclusion:
    memory_id: UUID
    content_revision: int
    governance_revision: int


@dataclass(frozen=True)
class RetainedMemoryContext:
    owner_ref: str
    revocation_epoch: int
    inclusions: tuple[MemoryInclusion, ...]


@dataclass(frozen=True)
class RevocationDelta:
    """One owner-bound governance event which advanced the revocation epoch."""

    owner_ref: str
    epoch: int
    memory_id: UUID | None


@dataclass(frozen=True)
class ContextTransition:
    action: Literal["continue", "rotate", "zero_memory"]
    reason: str
    next_epoch: int | None


def decode_context_manifest(value: object) -> RetainedMemoryContext | None:
    """Strictly decode content-free checkpoint metadata; invalid means unbound."""
    if not isinstance(value, dict) or set(value) != {"schema", "owner_ref", "revocation_epoch", "inclusions"}:
        return None
    if value["schema"] != "mem00.retained-context.v1" or not isinstance(value["owner_ref"], str) or not value["owner_ref"]:
        return None
    if type(value["revocation_epoch"]) is not int or value["revocation_epoch"] < 0:
        return None
    rows = value["inclusions"]
    if not isinstance(rows, list) or len(rows) > 100:
        return None
    inclusions = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"memory_id", "content_revision", "governance_revision"}:
            return None
        if not isinstance(row["memory_id"], str):
            return None
        try:
            memory_id = UUID(row["memory_id"])
        except ValueError:
            return None
        if memory_id in seen or any(type(row[key]) is not int or row[key] < 1 for key in ("content_revision", "governance_revision")):
            return None
        seen.add(memory_id)
        inclusions.append(MemoryInclusion(memory_id, row["content_revision"], row["governance_revision"]))
    return RetainedMemoryContext(value["owner_ref"], value["revocation_epoch"], tuple(inclusions))


def encode_context_manifest(context: RetainedMemoryContext) -> dict:
    """Serialize only structural metadata; never persist the memory plaintext."""
    value = {
        "schema": "mem00.retained-context.v1",
        "owner_ref": context.owner_ref,
        "revocation_epoch": context.revocation_epoch,
        "inclusions": [{"memory_id": str(item.memory_id), "content_revision": item.content_revision, "governance_revision": item.governance_revision} for item in context.inclusions],
    }
    if decode_context_manifest(value) != context:
        raise ValueError("invalid_context_manifest")
    return value


def context_transition(
    *,
    context: RetainedMemoryContext | None,
    owner_ref: str,
    current_epoch: int | None,
    deltas: tuple[RevocationDelta, ...] = (),
    delta_complete: bool = False,
) -> ContextTransition:
    """Plan continuation using only complete owner-scoped revocation evidence.

    A non-intersecting revocation refreshes the epoch without rotation. A
    missing, contradictory or incomplete delta never means no changes. The
    caller must actually discard/rebuild a stale native/model context before
    accepting input; merely recording this decision does not satisfy the fence.
    """
    if not owner_ref or type(current_epoch) is not int or current_epoch < 0:
        return ContextTransition("zero_memory", "governance_unavailable", None)
    if not isinstance(context, RetainedMemoryContext):
        return ContextTransition("rotate", "unbound_context", current_epoch)
    if context.owner_ref != owner_ref:
        return ContextTransition("zero_memory", "context_owner_mismatch", None)
    if type(context.revocation_epoch) is not int or context.revocation_epoch < 0:
        return ContextTransition("rotate", "invalid_context_epoch", current_epoch)
    if not isinstance(context.inclusions, tuple) or len(context.inclusions) > 100:
        return ContextTransition("rotate", "invalid_inclusion_manifest", current_epoch)
    seen = set()
    for item in context.inclusions:
        if (
            not isinstance(item, MemoryInclusion)
            or not isinstance(item.memory_id, UUID)
            or type(item.content_revision) is not int
            or item.content_revision < 1
            or type(item.governance_revision) is not int
            or item.governance_revision < 1
            or item.memory_id in seen
        ):
            return ContextTransition("rotate", "invalid_inclusion_manifest", current_epoch)
        seen.add(item.memory_id)
    if current_epoch < context.revocation_epoch:
        return ContextTransition("zero_memory", "revocation_epoch_regressed", None)
    if current_epoch == context.revocation_epoch:
        if deltas:
            return ContextTransition("rotate", "revocation_delta_unprovable", current_epoch)
        return ContextTransition("continue", "revocation_epoch_unchanged", current_epoch)
    if not delta_complete:
        return ContextTransition("rotate", "revocation_delta_incomplete", current_epoch)
    epochs = set()
    affected = set()
    for delta in deltas:
        if (
            not isinstance(delta, RevocationDelta)
            or delta.owner_ref != owner_ref
            or type(delta.epoch) is not int
            or not context.revocation_epoch < delta.epoch <= current_epoch
            or delta.epoch in epochs
            or not isinstance(delta.memory_id, UUID)
        ):
            return ContextTransition("rotate", "revocation_delta_unprovable", current_epoch)
        epochs.add(delta.epoch)
        affected.add(delta.memory_id)
    # No unbounded allocation for a hostile/invalid large epoch gap.
    if len(epochs) != current_epoch - context.revocation_epoch:
        return ContextTransition("rotate", "revocation_delta_gap", current_epoch)
    if seen.intersection(affected):
        return ContextTransition("rotate", "included_memory_revoked", current_epoch)
    return ContextTransition("continue", "unrelated_revocation", current_epoch)


def read_revocation_deltas(
    store,
    *,
    user_id: str,
    owner_ref: str,
    after_epoch: int,
    through_epoch: int,
    max_pages: int = 20,
    page_size: int = 100,
) -> tuple[RevocationDelta, ...]:
    """Read only structural events in a bounded, owner-filtered epoch window.

    A successful return requires an explicit empty terminal page. It does not
    certify a stable current epoch: the caller must reread that epoch after the
    scan and reject a concurrent change before applying any transition.
    """
    if (
        not user_id
        or not owner_ref
        or type(after_epoch) is not int
        or type(through_epoch) is not int
        or not 0 <= after_epoch < through_epoch
        or type(max_pages) is not int
        or not 1 <= max_pages <= 20
        or type(page_size) is not int
        or not 1 <= page_size <= 100
    ):
        raise ValueError("context_delta_bounds_invalid")
    fields = {"event_id", "user_id", "memory_id", "event_type", "user_revocation_epoch"}
    revoking = {"memory_edited", "memory_forgotten", "memory_tombstoned"}
    # These existing ledger writers record the current clock but do not
    # advance it. They cannot substitute for an actual revocation delta:
    # context_transition still requires every intervening epoch exactly once.
    non_revoking = {"candidate_approved", "memory_manual_created", "memory_restored",
        "memory_source_action_accepted", "model_dispatch_authorized", "model_result_observed",
        "builder_source_handoff_recorded", "builder_source_run_bound"}
    cursor = None
    deltas = []
    for _ in range(max_pages):
        params = {
            "select": ",".join(sorted(fields)),
            "user_id": f"eq.{user_id}",
            "and": f"(user_revocation_epoch.gt.{after_epoch},user_revocation_epoch.lte.{through_epoch})",
            "order": "event_id.asc",
            "limit": str(page_size),
        }
        if cursor is not None:
            params["event_id"] = f"gt.{cursor}"
        rows = store._request("GET", "sophia_memory_governance_events", params=params)
        if not isinstance(rows, list) or len(rows) > page_size:
            raise ValueError("context_delta_page_invalid")
        if not rows:
            return tuple(deltas)
        for row in rows:
            if not isinstance(row, dict) or set(row) != fields or row["user_id"] != user_id:
                raise ValueError("context_delta_row_invalid")
            event_id = str(UUID(row["event_id"]))
            if cursor is not None and event_id <= cursor:
                raise ValueError("context_delta_page_not_advancing")
            cursor = event_id
            epoch = row["user_revocation_epoch"]
            if type(epoch) is not int or not after_epoch < epoch <= through_epoch:
                raise ValueError("context_delta_epoch_invalid")
            event_type = row["event_type"]
            if event_type in non_revoking:
                continue
            if event_type not in revoking:
                # Future policy-revocation actions require an explicit mapping;
                # an unknown event can never be interpreted as unrelated.
                raise ValueError("context_delta_event_unknown")
            memory_id = UUID(row["memory_id"]) if row["memory_id"] else None
            deltas.append(RevocationDelta(owner_ref, epoch, memory_id))
    raise ValueError("context_delta_page_cap")


def observe_context_transition(store, *, user_id: str, owner_ref: str, context: RetainedMemoryContext | None, contract_epoch: int = 1) -> ContextTransition:
    """Obtain current owner clocks around the bounded event scan, fail closed.

    Still decision-only: after this returns, a model boundary must honor rotate
    or zero_memory and independently obtain fresh canonical admission. No
    serialized inclusion manifest is ever approval authority.
    """
    try:
        contract = store.get_contract()
        if contract.mode != "enforced" or contract.schema_version != "mem00.v1" or contract.contract_epoch != contract_epoch:
            return ContextTransition("zero_memory", "contract_not_enforced", None)
        before = store.get_user_governance(user_id)
        if before.user_id != user_id:
            return ContextTransition("zero_memory", "governance_owner_mismatch", None)
        decision = context_transition(context=context, owner_ref=owner_ref, current_epoch=before.user_revocation_epoch)
        if decision.reason == "revocation_delta_incomplete":
            try:
                deltas = read_revocation_deltas(store, user_id=user_id, owner_ref=owner_ref, after_epoch=context.revocation_epoch, through_epoch=before.user_revocation_epoch)
            except Exception:
                # Do not reuse a previously admitted context when a delta scan
                # is incomplete, unsupported, unavailable or malformed.
                decision = ContextTransition("rotate", "revocation_delta_unprovable", before.user_revocation_epoch)
            else:
                decision = context_transition(context=context, owner_ref=owner_ref, current_epoch=before.user_revocation_epoch, deltas=deltas, delta_complete=True)
        after = store.get_user_governance(user_id)
        if after.user_id != user_id or after.user_revocation_epoch != before.user_revocation_epoch or after.provider_subject != before.provider_subject:
            return ContextTransition("zero_memory", "governance_changed_during_check", None)
        return decision
    except Exception:
        return ContextTransition("zero_memory", "governance_unavailable", None)
