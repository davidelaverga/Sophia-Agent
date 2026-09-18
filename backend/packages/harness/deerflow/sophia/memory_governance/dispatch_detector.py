"""Post-entry detector; never substitutes for canonical pre-dispatch authority."""
from .legacy_model_dispatch import LegacyModelAttempt, LegacyModelDispatchAuthority
from .model_dispatch import FinalModelDispatchAuthority
from .no_memory_model_dispatch import NoMemoryModelAttempt, NoMemoryModelDispatchAuthority
from .observability import emit_memory_event, increment_counter, record_memory_observation_gap
from .refs import keyed_ref


def detect_dispatch_violation(*, authority, receipt, entered):
    # A refused attempt is not a policy escape. This does not re-read current
    # ownership after dispatch: a later cutover cannot invalidate an earlier
    # legitimate admission retroactively.
    if not entered or not isinstance(authority, (FinalModelDispatchAuthority, LegacyModelDispatchAuthority, NoMemoryModelDispatchAuthority)):
        return
    try:
        attempt = authority.attempt
        cross_owner = receipt is not None and receipt.owner_id != authority.owner_id
        fields = {"attempt_id", "run_id", "thread_id", "prior_admission_id", "payload_ref", "endpoint_ref", "model_ref",
                  "catalog_generation", "revocation_epoch", "authorized_manifest", "source_dependencies"}
        mismatch = receipt is None or cross_owner
        if isinstance(authority, LegacyModelDispatchAuthority):
            fields = set(LegacyModelAttempt.model_fields) - {"schema_name"}
            if receipt is not None:
                mismatch = mismatch or receipt.authority_state != "legacy" or receipt.canonical_approval_granted is not False
        elif isinstance(authority, NoMemoryModelDispatchAuthority):
            # This lane mints its own receipt, so the detector cannot rely on an
            # independent database reply to catch substitution. What it can
            # still check independently is the claim the lane is built on: that
            # nothing was admitted, neither canonically nor through the legacy
            # lane. A request that entered the transport under this authority
            # while declaring memory material is a policy escape.
            fields = set(NoMemoryModelAttempt.model_fields) - {"schema_name"}
            if receipt is not None:
                mismatch = (mismatch or receipt.authority_state != "unknown"
                    or receipt.memory_material_present is not False
                    or receipt.canonical_approval_granted is not False
                    or receipt.legacy_lane_used is not False)
        if receipt is not None:
            mismatch = mismatch or receipt.model_dump(include=fields) != attempt.model_dump(include=fields)
            if isinstance(authority, FinalModelDispatchAuthority):
                # Source/Builder/completion identity and the clear boundary are
                # outside the common manifest fields. Detect their substitution
                # too, even if the wire payload and owner still match.
                mismatch = mismatch or not authority._matches_origin(receipt, attempt)
        if not mismatch:
            return
        # Record before export: an exporter outage must never erase the alarm.
        increment_counter("memory_policy_escape_total")
        if cross_owner:
            increment_counter("memory_cross_owner_admission_total")
        emit_memory_event("memory.policy.violation", service="model-transport", outcome="SECURITY_HOLD",
            safe_reason_code="dispatch_owner_mismatch" if cross_owner else "dispatch_receipt_mismatch",
            owner_ref=keyed_ref("owner", authority.owner_id),
            attempt_ref=keyed_ref("model-attempt", attempt.attempt_id),
            detection_scope="entered_transport_receipt_consistency")
    except Exception:
        # No retry or response rewriting: the transport may already have an
        # effect. Evidence loss is separately visible and disqualifies a run.
        record_memory_observation_gap()
