"""Post-boundary structural evidence, never permission or provider acceptance."""
import logging
import os
from time import monotonic

from .model_dispatch import FinalModelDispatchAuthority
from .observability import emit_memory_event, record_memory_observation_gap
from .refs import keyed_ref

logger = logging.getLogger(__name__)


def _transport_outcome(*, entered, response, cancelled):
    if cancelled:
        return "cancelled_after_transport" if entered else "cancelled_before_transport"
    if response is not None:
        return "response_headers_received"
    return "transport_effect_unknown" if entered else "admission_denied"


def observe_model_transport(*, authority, receipt, entered, response, cancelled, started):
    """Do no evidence I/O between the last permit check and transport entry.

    Headers do not prove a completed model result. A transport exception can
    follow a provider effect. Lost observation is a coverage gap, never a
    reason to replay a request or change its successful/failed product result.
    """
    from .dispatch_detector import detect_dispatch_violation
    detect_dispatch_violation(authority=authority, receipt=receipt, entered=entered)
    from .model_result_provenance import observe_parsed_transport
    observe_parsed_transport(authority=authority, receipt=receipt, entered=entered, response=response, cancelled=cancelled)
    from .no_memory_model_dispatch import NoMemoryModelDispatchAuthority
    if isinstance(authority, NoMemoryModelDispatchAuthority):
        # The no-memory lane is the ordinary non-pilot path, so it must be
        # visible rather than silent -- but only the fields it actually has.
        # No manifest, no epochs and no admission event are invented for it.
        try:
            attempt = authority.attempt
            emit_memory_event("memory.model.transport",
                service=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
                outcome=_transport_outcome(entered=entered, response=response, cancelled=cancelled),
                safe_reason_code="no_memory_lane_no_admission", fault_owner_id=authority.owner_id,
                observation_scope="sdk_http_transport_no_memory", transport_entered=entered,
                provider_effect="unknown", response_body_observed=False, model_result_observed=False,
                http_status=response.status_code if response is not None else None,
                latency_ms=max(0, int((monotonic() - started) * 1000)),
                owner_ref=keyed_ref("owner", authority.owner_id),
                attempt_ref=keyed_ref("model-attempt", attempt.attempt_id),
                run_ref=keyed_ref("run", attempt.run_id), context_ref=keyed_ref("context", attempt.thread_id),
                payload_ref=attempt.payload_ref, endpoint_ref=attempt.endpoint_ref, model_ref=attempt.model_ref,
                inclusion_count=0, memory_material_present=False, authority_state="unknown",
                authorization_receipt_validated=receipt is not None)
        except Exception:
            record_memory_observation_gap()
            logger.warning("memory_model_transport_observation unavailable contentExcluded=true", exc_info=False)
        return
    if not isinstance(authority, FinalModelDispatchAuthority):
        return  # Legacy or unbound factory coverage is not invented.
    try:
        attempt = authority.attempt
        outcome = _transport_outcome(entered=entered, response=response, cancelled=cancelled)
        fields = {
            "observation_scope": "sdk_http_transport",
            "transport_entered": entered,
            "provider_effect": "unknown",
            "response_body_observed": False,
            "model_result_observed": False,
            "http_status": response.status_code if response is not None else None,
            "latency_ms": max(0, int((monotonic() - started) * 1000)),
            "owner_ref": keyed_ref("owner", authority.owner_id),
            "attempt_ref": keyed_ref("model-attempt", attempt.attempt_id),
            "run_ref": keyed_ref("run", attempt.run_id),
            "context_ref": keyed_ref("context", attempt.thread_id),
            "session_refs": sorted({keyed_ref("session", source.session_id) for source in attempt.source_dependencies}),
            "source_event_refs": sorted({keyed_ref("source-event", source.event_id) for source in attempt.source_dependencies}),
            "prior_admission_ref": keyed_ref("prompt-admission", attempt.prior_admission_id),
            "payload_ref": attempt.payload_ref, "endpoint_ref": attempt.endpoint_ref, "model_ref": attempt.model_ref,
            "inclusion_count": len(attempt.authorized_manifest),
            "catalog_generation_requested": attempt.catalog_generation,
            "revocation_epoch_requested": attempt.revocation_epoch,
            "authorization_receipt_validated": receipt is not None,
            "catalog_generation_checked": receipt.catalog_generation if receipt is not None else None,
            "revocation_epoch_checked": receipt.revocation_epoch if receipt is not None else None,
            "memory_clear_epoch_checked": receipt.memory_clear_epoch if receipt is not None else None,
            "prompt_admission_ref": keyed_ref("prompt-admission", receipt.prompt_admission_id) if receipt is not None else None,
            "model_admission_event_ref": keyed_ref("model-admission-event", receipt.event_id) if receipt is not None else None,
        }
        if attempt.builder_binding is not None:
            binding = attempt.builder_binding
            fields.update(parent_run_ref=keyed_ref("run", binding.parent_run_id),
                parent_context_ref=keyed_ref("context", binding.parent_thread_id),
                builder_binding_ref=keyed_ref("builder-binding", binding.binding_event_id))
        if attempt.completion_binding is not None:
            binding = attempt.completion_binding
            fields.update(completion_binding_ref=keyed_ref("completion-binding", binding.binding_event_id),
                child_run_ref=keyed_ref("run", binding.request.child_binding.child_run_id))
        resumed = getattr(attempt, "resume_binding", None)
        if resumed is not None:
            fields.update(resume_binding_ref=keyed_ref("builder-resume-binding", resumed.binding_event_id),
                reconstruction_ref=keyed_ref("builder-reconstruction", resumed.reconstruction.event_id),
                original_child_run_ref=keyed_ref("run", resumed.reconstruction.request.child_binding.child_run_id),
                source_view_ref=attempt.source_view_ref, replacement_state_ref=attempt.replacement_state_ref)
        resumed_completion = getattr(attempt, "resumed_completion_binding", None)
        if resumed_completion is not None:
            child = resumed_completion.request.child_resume_binding
            fields.update(resumed_completion_binding_ref=keyed_ref("resumed-completion-binding", resumed_completion.binding_event_id),
                resume_binding_ref=keyed_ref("builder-resume-binding", child.binding_event_id),
                reconstruction_ref=keyed_ref("builder-reconstruction", child.reconstruction.event_id),
                child_run_ref=keyed_ref("run", child.resume_run_id),
                original_child_run_ref=keyed_ref("run", child.reconstruction.request.child_binding.child_run_id))
        emit_memory_event("memory.model.transport", service=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
            outcome=outcome, safe_reason_code=outcome, fault_owner_id=authority.owner_id, **fields)
    except Exception:
        record_memory_observation_gap()
        logger.warning("memory_model_transport_observation unavailable contentExcluded=true", exc_info=False)
