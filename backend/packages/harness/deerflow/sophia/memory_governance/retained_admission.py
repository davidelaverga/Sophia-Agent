"""Current canonical re-admission of a proven retained inclusion manifest.

This service cannot prove message provenance or rotate a native context. Its
caller must do both. It never receives cached memory text and never interprets
provider text as approval. No new database authority or schema is introduced.
"""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from time import monotonic
from uuid import UUID, uuid4

from deerflow.sophia.diag import record_export

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


def _segment_ms(since: float) -> int:
    return int((monotonic() - since) * 1000)


def _emit(*args, **kwargs):
    """emit_memory_event plus a content-free per-run export status/time count."""
    started = monotonic()
    status = emit_memory_event(*args, **kwargs)
    record_export(status, (monotonic() - started) * 1000)
    return status


def readmit_retained_context(*, store, adapter, provider, service_name: str, owner_id: str,
                            context: RetainedMemoryContext | None, scope: str, caller: str, query: str,
                            latency_segments: Mapping[str, int] | None = None) -> RetainedAdmission:
    """Check delta, fresh provider availability, exact canonical versions, then RPC.

    The availability lookup is bounded and does not select new memories. Existing
    eligible bindings plus canonical truth authorize the retained inclusions at
    the atomic admission RPC. A missing provider hit is not a revocation event.
    Any uncertainty returns NO text and NO continuation permission.

    ``latency_segments`` carries caller-measured whole-millisecond segments
    (for example ``flags_ms``) into the admission row's JSONB timing record.
    """
    started = monotonic()
    request_id = uuid4()
    owner_ref = None
    segments: dict[str, int] = {key: value for key, value in (latency_segments.items() if isinstance(latency_segments, Mapping) else ())
        if isinstance(key, str) and key.endswith("_ms") and isinstance(value, int) and not isinstance(value, bool)}

    def denied(transition):
        # A missing HMAC configuration must not cause raw identifiers to escape
        # or turn an unavailable result into a model request.
        if owner_ref is not None:
            _emit("memory.context.transition", service=service_name, outcome=transition.action,
                  fault_owner_id=owner_id, owner_ref=owner_ref, safe_reason_code=transition.reason,
                  retrieval_request_ref=keyed_ref("retrieval", str(request_id)))
        return RetainedAdmission(transition)

    try:
        owner_ref = keyed_ref("owner", owner_id)
        if context is not None:
            encode_context_manifest(context)
        mark = monotonic()
        decision = observe_context_transition(store, user_id=owner_id, owner_ref=owner_ref, context=context, contract_epoch=provider.contract_epoch)
        segments["observe_ms"] = _segment_ms(mark)
        if decision.action != "continue":
            return denied(decision)
        mark = monotonic()
        clock = store.get_user_governance(owner_id)
        segments["clock_ms"] = _segment_ms(mark)
        if clock.user_id != owner_id or clock.user_revocation_epoch != decision.next_epoch:
            return denied(ContextTransition("zero_memory", "governance_changed_during_check", None))
        # Use the existing pinned endpoint/filter contract. Never change SDK or
        # project settings to make an availability measurement pass.
        mark = monotonic()
        try:
            adapter.search_ids(query=query, provider_subject=clock.provider_subject, limit=1, metadata_filter={
                "sophia_managed": True, "memory_contract_epoch": provider.contract_epoch,
                "environment": provider.environment, "provider_namespace": clock.provider_subject,
            })
        except Exception:
            return denied(ContextTransition("zero_memory", "provider_unavailable", None))
        # The adapter reports client construction (TLS + ping) separately when
        # this call had to build one; the remainder is the search itself.
        client_ms = getattr(adapter, "diag_last_client_ms", None)
        client_ms = client_ms if isinstance(client_ms, int) and not isinstance(client_ms, bool) else 0
        segments["mem0_client_ms"] = client_ms
        segments["mem0_search_ms"] = max(0, _segment_ms(mark) - client_ms)
        mark = monotonic()
        canonical = store.hydrate_inclusions(user_id=owner_id, inclusions=context.inclusions, scope=scope)
        segments["hydrate_ms"] = _segment_ms(mark)
        expected = {(item.memory_id, item.content_revision, item.governance_revision) for item in context.inclusions}
        actual = {(item.memory_id, item.content_revision, item.memory_governance_revision) for item in canonical}
        if len(canonical) != len(expected) or expected != actual:
            return denied(ContextTransition("zero_memory", "retained_hydration_incomplete", None))
        mark = monotonic()
        after = store.get_user_governance(owner_id)
        if (after.user_id != owner_id or after.user_revocation_epoch != clock.user_revocation_epoch
                or after.provider_subject != clock.provider_subject):
            return denied(ContextTransition("zero_memory", "governance_changed_during_check", None))
        contract = store.get_contract()
        segments["contract_ms"] = _segment_ms(mark)
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
            "latency_segments": {**segments, "total_ms": int((monotonic() - started) * 1000)},
        })
        if not isinstance(prompt_id, UUID):
            return denied(ContextTransition("zero_memory", "prompt_admission_receipt_invalid", None))
        _emit("memory.context.transition", service=service_name, outcome="continue", fault_owner_id=owner_id,
              owner_ref=owner_ref, safe_reason_code=decision.reason, authorized_count=len(canonical),
              retrieval_request_ref=keyed_ref("retrieval", str(request_id)),
              prompt_admission_ref=keyed_ref("prompt-admission", str(prompt_id)))
        return RetainedAdmission(decision, replace(context, revocation_epoch=after.user_revocation_epoch), canonical, prompt_id)
    except Exception:
        return denied(ContextTransition("zero_memory", "retained_governance_unavailable", None))
