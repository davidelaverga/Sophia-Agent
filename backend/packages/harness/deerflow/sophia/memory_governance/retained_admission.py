"""Current canonical re-admission of a proven retained inclusion manifest.

This service cannot prove message provenance or rotate a native context. Its
caller must do both. It never receives cached memory text and never interprets
provider text as approval. No new database authority or schema is introduced.
"""

from dataclasses import dataclass, replace
from time import monotonic
from uuid import UUID, uuid4

from .models import AuthorizedMemory
from .observability import emit_memory_event
from .refs import keyed_ref
from .retained_context import ContextTransition, RetainedMemoryContext, encode_context_manifest, observe_context_transition


@dataclass(frozen=True)
class RetainedAdmission:
    transition: ContextTransition
    context: RetainedMemoryContext | None = None
    memories: tuple[AuthorizedMemory, ...] = ()
    prompt_admission_id: UUID | None = None


def readmit_retained_context(*, store, adapter, provider, service_name: str, owner_id: str,
                            context: RetainedMemoryContext | None, scope: str, caller: str, query: str) -> RetainedAdmission:
    """Check delta, fresh provider availability, exact canonical versions, then RPC.

    The availability lookup is bounded and does not select new memories. Existing
    eligible bindings plus canonical truth authorize the retained inclusions at
    the atomic admission RPC. A missing provider hit is not a revocation event.
    Any uncertainty returns NO text and NO continuation permission.
    """
    started = monotonic()
    request_id = uuid4()
    owner_ref = None

    def denied(transition):
        # A missing HMAC configuration must not cause raw identifiers to escape
        # or turn an unavailable result into a model request.
        if owner_ref is not None:
            emit_memory_event("memory.context.transition", service=service_name, outcome=transition.action,
                              fault_owner_id=owner_id, owner_ref=owner_ref, safe_reason_code=transition.reason,
                              retrieval_request_ref=keyed_ref("retrieval", str(request_id)))
        return RetainedAdmission(transition)

    try:
        owner_ref = keyed_ref("owner", owner_id)
        if context is not None:
            encode_context_manifest(context)
        decision = observe_context_transition(store, user_id=owner_id, owner_ref=owner_ref, context=context, contract_epoch=provider.contract_epoch)
        if decision.action != "continue":
            return denied(decision)
        clock = store.get_user_governance(owner_id)
        if clock.user_id != owner_id or clock.user_revocation_epoch != decision.next_epoch:
            return denied(ContextTransition("zero_memory", "governance_changed_during_check", None))
        # Use the existing pinned endpoint/filter contract. Never change SDK or
        # project settings to make an availability measurement pass.
        try:
            adapter.search_ids(query=query, provider_subject=clock.provider_subject, limit=1, metadata_filter={
                "sophia_managed": True, "memory_contract_epoch": provider.contract_epoch,
                "environment": provider.environment, "provider_namespace": clock.provider_subject,
            })
        except Exception:
            return denied(ContextTransition("zero_memory", "provider_unavailable", None))
        canonical = store.hydrate_inclusions(user_id=owner_id, inclusions=context.inclusions, scope=scope)
        expected = {(item.memory_id, item.content_revision, item.governance_revision) for item in context.inclusions}
        actual = {(item.memory_id, item.content_revision, item.memory_governance_revision) for item in canonical}
        if len(canonical) != len(expected) or expected != actual:
            return denied(ContextTransition("zero_memory", "retained_hydration_incomplete", None))
        after = store.get_user_governance(owner_id)
        if (after.user_id != owner_id or after.user_revocation_epoch != clock.user_revocation_epoch
                or after.provider_subject != clock.provider_subject):
            return denied(ContextTransition("zero_memory", "governance_changed_during_check", None))
        contract = store.get_contract()
        if contract.mode != "enforced" or contract.schema_version != "mem00.v1" or contract.contract_epoch != provider.contract_epoch:
            return denied(ContextTransition("zero_memory", "contract_not_enforced", None))
        # Existing SQL locks the current owner clock and independently checks
        # every revision, lifecycle, scope, tombstone and eligible binding.
        prompt_id = store.record_prompt_admission({
            "retrieval_request_id": str(request_id), "user_id": owner_id, "caller": caller, "scope": scope,
            "query_ref": keyed_ref("query", query), "provider": provider.provider,
            "environment": provider.environment, "provider_project": provider.project, "provider_namespace": after.provider_subject,
            "provider_status": "ok", "provider_hit_count": 0,
            "catalog_generation_checked": after.user_catalog_generation, "revocation_epoch_checked": after.user_revocation_epoch,
            "authorized_manifest": [{"memory_id": str(item.memory_id), "content_revision": item.content_revision,
                                     "memory_governance_revision": item.memory_governance_revision} for item in canonical],
            "denial_counts": {}, "outcome": "authorized" if canonical else "zero_memory",
            "safe_reason_code": None if canonical else "empty_retained_context",
            "latency_segments": {"total_ms": int((monotonic() - started) * 1000)},
        })
        if not isinstance(prompt_id, UUID):
            return denied(ContextTransition("zero_memory", "prompt_admission_receipt_invalid", None))
        emit_memory_event("memory.context.transition", service=service_name, outcome="continue", fault_owner_id=owner_id,
                          owner_ref=owner_ref, safe_reason_code=decision.reason, authorized_count=len(canonical),
                          retrieval_request_ref=keyed_ref("retrieval", str(request_id)),
                          prompt_admission_ref=keyed_ref("prompt-admission", str(prompt_id)))
        return RetainedAdmission(decision, replace(context, revocation_epoch=after.user_revocation_epoch), canonical, prompt_id)
    except Exception:
        return denied(ContextTransition("zero_memory", "retained_governance_unavailable", None))
