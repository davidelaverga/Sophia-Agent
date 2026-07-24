from __future__ import annotations

from deerflow.sophia.deck_design_lift.schemas import (
    ContentPreservationProof,
    DeckVersionComparison,
    DeckVersionComparisonInput,
    LocalityProof,
)

PSI_FAILURE_FAMILY_BY_CODE = {
    "weak_subject_specificity": "weak_subject_specificity",
    "weak_signature_realization": "weak_signature_realization",
    "default_look_gravity": "default_look_gravity",
    "low_sequence_rhythm": "low_sequence_rhythm",
    "weak_narrative_pacing": "low_sequence_rhythm",
    "weak_closing_synthesis": "weak_closing_synthesis",
    "weak_mechanism_visualization": "weak_mechanism_visualization",
}
# Stable campaign tie-break shared by repair-program admission and repair
# authorship.  It is deliberately independent of persisted/compiler
# serialization order so the same frozen findings yield the same PSI target
# families at every boundary.
PSI_PRIORITY_CODE_ORDER = (
    "weak_mechanism_visualization",
    "weak_closing_synthesis",
    "default_look_gravity",
    "low_sequence_rhythm",
    "weak_narrative_pacing",
    "weak_subject_specificity",
    "weak_signature_realization",
)
PSI_REQUIRED_RESOLVED_FAMILY_COUNT = 3


def _locality_passed(proof: LocalityProof) -> bool:
    if proof.unexpected_changes:
        return False
    if not proof.native_inventory_preserved or not proof.render_collateral_within_tolerance:
        return False
    authorized = set(proof.authorized_selectors)
    changed = set(proof.changed_component_versions)
    if proof.shared_dependency_changed:
        return "deck-style:root" in authorized
    return "deck-style:root" not in authorized and changed.issubset(authorized)


def _content_passed(proof: ContentPreservationProof) -> bool:
    return (
        proof.brief_preserved
        and proof.initial_slide_count == proof.candidate_slide_count
        and proof.required_content_preserved
        and proof.factual_content_preserved
        and proof.native_editability_preserved
    )


def compare_deck_versions(inputs: DeckVersionComparisonInput) -> DeckVersionComparison:
    """Apply the ten deterministic improvement gates and the PSI fixture overlay."""

    initial = inputs.initial
    candidate = inputs.candidate
    initial_scores = {item.criterion_id: item for item in initial.criterion_scores}
    candidate_scores = {item.criterion_id: item for item in candidate.criterion_scores}
    criterion_coverage_matches = set(initial_scores) == set(candidate_scores)
    common_ids = sorted(set(initial_scores) & set(candidate_scores))
    score_deltas = {
        criterion_id: float(
            candidate_scores[criterion_id].score - initial_scores[criterion_id].score
        )
        for criterion_id in common_ids
    }

    critical_regressions = tuple(
        criterion_id
        for criterion_id in common_ids
        if initial_scores[criterion_id].critical and score_deltas[criterion_id] < 0
    )
    unchanged_critical = tuple(
        criterion_id
        for criterion_id in common_ids
        if initial_scores[criterion_id].critical and score_deltas[criterion_id] == 0
    )
    improved_critical = tuple(
        criterion_id
        for criterion_id in common_ids
        if initial_scores[criterion_id].critical and score_deltas[criterion_id] > 0
    )
    candidate_critical_floor_passed = all(
        item.score >= inputs.critical_score_floor
        for item in candidate.criterion_scores
        if item.critical
    )
    improved_initial_failures = tuple(
        criterion_id
        for criterion_id in common_ids
        if initial_scores[criterion_id].failed and score_deltas[criterion_id] > 0
    )
    critical_two_point_gain = any(
        initial_scores[criterion_id].critical and score_deltas[criterion_id] >= 2
        for criterion_id in common_ids
    )
    strong_dimension_improvement = (
        len(improved_initial_failures) >= 2 or critical_two_point_gain
    )

    resolved_failures = tuple(sorted(set(initial.failure_codes) - set(candidate.failure_codes)))
    new_failures = tuple(sorted(set(candidate.failure_codes) - set(initial.failure_codes)))
    expected_failure_resolved = bool(
        set(resolved_failures) & set(inputs.expected_failure_codes)
    )
    new_critical_failures = set(candidate.critical_failure_codes) - set(
        initial.failure_codes
    )
    resolved_psi_families = {
        PSI_FAILURE_FAMILY_BY_CODE[code]
        for code in resolved_failures
        if code in PSI_FAILURE_FAMILY_BY_CODE
    }
    psi_floor_passed = (
        len(resolved_psi_families) >= PSI_REQUIRED_RESOLVED_FAMILY_COUNT
    )

    mechanics_preserved = initial.mechanics_passed and candidate.mechanics_passed
    locality_preserved = _locality_passed(inputs.locality)
    content_preserved = _content_passed(inputs.content)
    fresh_quality_run = initial.quality_run_id != candidate.quality_run_id
    distinct_artifact_version = (
        initial.artifact_version_id != candidate.artifact_version_id
    )
    candidate_judgment_complete = (
        candidate.coverage_complete and not candidate.grader_error
    )
    user_review_eligible = (
        candidate.verdict == "needs_user_review"
        and candidate_critical_floor_passed
        and strong_dimension_improvement
        and bool(candidate.uncertainties)
        and set(candidate.uncertainties) == {"taste_score_range"}
    )
    candidate_verdict_approved = candidate.verdict == "satisfied" or user_review_eligible

    gate_results = (
        ("initial_verdict_not_needs_revision", initial.verdict == "needs_revision"),
        (
            "candidate_verdict_not_approved",
            candidate_verdict_approved
            and candidate_judgment_complete
            and candidate_critical_floor_passed,
        ),
        ("candidate_mechanics_failed", candidate.mechanics_passed),
        ("critical_score_regression", not critical_regressions),
        (
            "weighted_score_not_improved",
            candidate.weighted_score > initial.weighted_score,
        ),
        ("insufficient_dimension_improvement", strong_dimension_improvement),
        ("expected_failure_unresolved", expected_failure_resolved),
        ("new_critical_failure_family", not new_critical_failures),
        ("locality_not_preserved", locality_preserved),
        ("content_not_preserved", content_preserved),
        ("psi_resolved_failure_family_floor_not_met", psi_floor_passed),
        ("criterion_coverage_mismatch", criterion_coverage_matches),
        ("initial_mechanics_failed", initial.mechanics_passed),
        ("quality_run_not_fresh", fresh_quality_run),
        ("artifact_version_not_distinct", distinct_artifact_version),
    )
    reasons = tuple(reason for reason, passed in gate_results if not passed)
    if candidate.verdict == "needs_user_review" and not user_review_eligible:
        reasons = ("candidate_needs_user_review_not_eligible", *reasons)

    if not reasons:
        result = "approved_improvement"
        reasons = ("all_improvement_gates_passed",)
    elif (
        not criterion_coverage_matches
        or not candidate_judgment_complete
        or not fresh_quality_run
        or not distinct_artifact_version
    ):
        result = "incomparable"
    elif (
        critical_regressions
        or new_critical_failures
        or candidate.weighted_score < initial.weighted_score
    ):
        result = "regressed"
    else:
        result = "not_improved"

    return DeckVersionComparison(
        initial_quality_run_id=initial.quality_run_id,
        candidate_quality_run_id=candidate.quality_run_id,
        initial_artifact_version_id=initial.artifact_version_id,
        candidate_artifact_version_id=candidate.artifact_version_id,
        result=result,
        score_deltas=score_deltas,
        resolved_failure_codes=resolved_failures,
        new_failure_codes=new_failures,
        unchanged_critical_scores=unchanged_critical,
        improved_critical_scores=improved_critical,
        mechanics_preserved=mechanics_preserved,
        locality_preserved=locality_preserved,
        content_preserved=content_preserved,
        reasons=reasons,
    )
