"""Preserve store error classes when deterministic SQL errors move off 40001.

PostgREST mapped 40001 to HTTP 500; the non-retryable P0001 maps to 400.
Only the reviewed messages below keep their previous store-level status. The
actual HTTP response and SQLSTATE remain available to lower-level telemetry.
"""

from __future__ import annotations

from typing import Any

_FORMER_40001_MESSAGES = frozenset(
    {
        "build_manifest_concurrent_modification",
        "build_mutation_stale_commit_lease",
        "build_mutation_stale_lease",
        "build_mutation_stale_transition",
        "build_registry_concurrent_modification",
        "deck_quality_dispatch_resolution_conflict",
        "deck_quality_lease_stale",
        "deck_quality_producer_failure_resolution_conflict",
        "deck_quality_producer_failure_resolution_identity_conflict",
        "deck_quality_publication_lease_stale",
        "memory_already_tombstoned_without_receipt",
        "memory_builder_handoff_unproven",
        "memory_builder_parent_admission_stale",
        "memory_builder_source_governance_changed",
        "memory_c2_completion_disabled",
        "memory_c2_consumer_disabled",
        "memory_candidate_not_pending",
        "memory_candidate_revision_stale",
        "memory_candidate_source_ineligible",
        "memory_clear_epoch_required",
        "memory_clear_epoch_stale",
        "memory_extraction_candidate_sources_invalid",
        "memory_extraction_contract_unavailable",
        "memory_extraction_dispatch_already_consumed",
        "memory_extraction_dispatch_ineligible",
        "memory_extraction_input_conflict",
        "memory_extraction_lease_stale",
        "memory_extraction_range_conflict",
        "memory_extraction_source_ineligible",
        "memory_extraction_source_unavailable",
        "memory_extractor_input_invalid",
        "memory_governance_revision_stale",
        "memory_legacy_model_authority_denied",
        "memory_legacy_model_contract_denied",
        "memory_model_attempt_consumed",
        "memory_model_availability_unproven",
        "memory_model_builder_binding_changed",
        "memory_model_builder_manifest_unproven",
        "memory_model_governance_changed",
        "memory_model_result_origin_unproven",
        "memory_model_source_changed",
        "memory_model_source_thread_changed",
        "memory_model_source_unavailable",
        "memory_not_active",
        "memory_not_editable",
        "memory_not_forgotten",
        "memory_projection_lease_stale",
        "memory_prompt_admission_denied",
        "memory_prompt_governance_stale",
        "memory_recovery_lease_stale",
        "memory_reviewed_content_reference_mismatch",
        "memory_revision_stale",
        "memory_session_revision_conflict",
        "memory_source_decision_mapping_unproven",
        "memory_source_occurrence_exists",
        "memory_source_range_conflict",
        "memory_source_runs_changed",
        "memory_source_snapshot_changed",
        "memory_source_target_conflict",
        "memory_source_use_scope_changed",
        "memory_source_witness_invalid",
        "memory_transcript_revision_stale",
    }
)


def store_error_status(response: Any) -> int:
    """Return the pre-migration store status for an exact reviewed RPC error.

    The database response body is never returned to a caller. An unrelated
    P0001, malformed body, or another SQLSTATE keeps its actual HTTP status.
    """

    status = response.status_code
    if status != 400:
        return status
    try:
        payload = response.json()
    except (TypeError, ValueError):
        return status
    if (
        isinstance(payload, dict)
        and payload.get("code") == "P0001"
        and payload.get("message") in _FORMER_40001_MESSAGES
    ):
        return 500
    return status
