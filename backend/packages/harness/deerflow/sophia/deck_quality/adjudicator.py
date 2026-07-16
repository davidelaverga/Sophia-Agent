from __future__ import annotations

from decimal import Decimal

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    BlindVisualAssessment,
    CoverageProof,
    CriterionScore,
    MechanicalProjection,
    PlanRealizationAssessment,
    QualityError,
    RubricCriterionProjection,
    ShadowDecision,
)


def _decision(
    *,
    result: str,
    reasons: tuple[str, ...],
    coverage: CoverageProof,
    visual: BlindVisualAssessment | None,
    mechanical: MechanicalProjection | None,
    plan: PlanRealizationAssessment | None,
    rubric_hash: str,
    policy: AdjudicationPolicy,
    weighted_score: Decimal | None = None,
    failing_criteria: tuple[str, ...] = (),
) -> ShadowDecision:
    failure_codes = set(visual.deck_failure_codes if visual else ())
    selectors = set()
    if visual:
        for finding in (*visual.slide_findings, *visual.strengths):
            selectors.update(finding.evidence_selectors)
    if plan:
        failure_codes.update(plan.failure_codes)
        for commitment in plan.commitments:
            if commitment.status in {"partial", "not_realized"}:
                selectors.update(commitment.evidence_selectors)
    if not coverage.complete:
        selectors.update(coverage.expected_selectors)
    return ShadowDecision(
        result=result,  # type: ignore[arg-type]
        reason_codes=reasons,
        weighted_score=weighted_score,
        critical_score_floor=policy.critical_score_floor,
        failing_criterion_ids=failing_criteria,
        failure_codes=tuple(sorted(failure_codes)),
        evidence_selectors=tuple(sorted(selectors, key=lambda item: int(item.split(":", 1)[1]))),
        rubric_hash=rubric_hash,
        policy_hash=canonical_sha256(policy),
        visual_assessment_hash=canonical_sha256(visual) if visual else None,
        mechanical_projection_hash=canonical_sha256(mechanical) if mechanical else None,
        plan_assessment_hash=canonical_sha256(plan) if plan else None,
    )


def _score_map(
    visual: BlindVisualAssessment,
    plan: PlanRealizationAssessment,
) -> dict[str, CriterionScore]:
    return {score.criterion_id: score for score in (*visual.criterion_scores, *plan.criterion_scores)}


def _weighted_score(applicable: list[tuple[RubricCriterionProjection, int]]) -> Decimal:
    numerator = sum((criterion.weight * score for criterion, score in applicable), Decimal("0"))
    denominator = sum((criterion.weight for criterion, _score in applicable), Decimal("0"))
    return numerator / denominator


def failed_to_judge_decision(
    *,
    coverage: CoverageProof,
    rubric_hash: str,
    policy: AdjudicationPolicy,
    errors: tuple[QualityError, ...],
    visual: BlindVisualAssessment | None = None,
    mechanical: MechanicalProjection | None = None,
    plan: PlanRealizationAssessment | None = None,
) -> ShadowDecision:
    reasons = tuple(sorted({error.code for error in errors})) or ("quality_machinery_error",)
    return _decision(
        result="failed_to_judge",
        reasons=reasons,
        coverage=coverage,
        visual=visual,
        mechanical=mechanical,
        plan=plan,
        rubric_hash=rubric_hash,
        policy=policy,
    )


def adjudicate_shadow_result(
    *,
    coverage: CoverageProof,
    visual: BlindVisualAssessment | None,
    mechanical: MechanicalProjection,
    plan: PlanRealizationAssessment | None,
    criteria: tuple[RubricCriterionProjection, ...],
    expected_plan_commitment_ids: tuple[str, ...],
    rubric_hash: str,
    policy: AdjudicationPolicy,
    machinery_errors: tuple[QualityError, ...] = (),
) -> ShadowDecision:
    """Apply the versioned policy. Model outputs never own the final verdict."""

    machinery_reasons = tuple(sorted({error.code for error in machinery_errors}))
    if machinery_reasons:
        return _decision(
            result="failed_to_judge",
            reasons=machinery_reasons,
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )
    if not coverage.complete:
        return _decision(
            result="failed_to_judge",
            reasons=("coverage_error", *coverage.errors),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )
    if mechanical.status == "incomplete":
        return _decision(
            result="failed_to_judge",
            reasons=("mechanical_projection_incomplete",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )
    if mechanical.status == "failed":
        return _decision(
            result="mechanically_invalid",
            reasons=("authoritative_mechanical_failure",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )
    if visual is None or plan is None:
        return _decision(
            result="failed_to_judge",
            reasons=("assessment_missing",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )

    if plan.evaluated_selectors != coverage.expected_selectors:
        return _decision(
            result="failed_to_judge",
            reasons=("plan_selector_coverage_invalid",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )
    actual_commitments = tuple(item.commitment_id for item in plan.commitments)
    if set(actual_commitments) != set(expected_plan_commitment_ids) or len(actual_commitments) != len(expected_plan_commitment_ids):
        return _decision(
            result="failed_to_judge",
            reasons=("plan_commitment_coverage_invalid",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )

    score_by_id = _score_map(visual, plan)
    expected_ids = {criterion.id for criterion in criteria}
    actual_ids = set(score_by_id)
    expected_visual_ids = {criterion.id for criterion in criteria if criterion.assessment == "blind_visual"}
    expected_plan_ids = {criterion.id for criterion in criteria if criterion.assessment == "plan_realization"}
    actual_visual_ids = {score.criterion_id for score in visual.criterion_scores}
    actual_plan_ids = {score.criterion_id for score in plan.criterion_scores}
    if expected_ids != actual_ids or not expected_ids or expected_visual_ids != actual_visual_ids or expected_plan_ids != actual_plan_ids:
        return _decision(
            result="failed_to_judge",
            reasons=("criterion_coverage_invalid",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )

    applicable: list[tuple[RubricCriterionProjection, int]] = []
    critical_failures: list[str] = []
    for criterion in criteria:
        score = score_by_id[criterion.id]
        if not score.applicable:
            continue
        numeric_score = score.score
        if numeric_score is None:
            return _decision(
                result="failed_to_judge",
                reasons=("applicable_score_missing",),
                coverage=coverage,
                visual=visual,
                mechanical=mechanical,
                plan=plan,
                rubric_hash=rubric_hash,
                policy=policy,
            )
        applicable.append((criterion, numeric_score))
        if criterion.critical and numeric_score < policy.critical_score_floor:
            critical_failures.append(criterion.id)
    if not applicable:
        return _decision(
            result="failed_to_judge",
            reasons=("no_applicable_criteria",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
        )

    weighted_score = _weighted_score(applicable)
    if critical_failures:
        return _decision(
            result="needs_revision",
            reasons=("critical_score_below_floor",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
            weighted_score=weighted_score,
            failing_criteria=tuple(sorted(critical_failures)),
        )
    if weighted_score < policy.min_weighted_score:
        return _decision(
            result="needs_revision",
            reasons=("weighted_score_below_threshold",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
            weighted_score=weighted_score,
        )
    conservative_scores = {criterion.id: score for criterion, score in applicable}
    for uncertainty in (*visual.uncertainties, *plan.uncertainties):
        if uncertainty.kind != "taste_score_range":
            continue
        criterion_id = uncertainty.criterion_id
        minimum = uncertainty.plausible_min_score
        if criterion_id is None or minimum is None or criterion_id not in conservative_scores:
            return _decision(
                result="failed_to_judge",
                reasons=("uncertainty_contract_invalid",),
                coverage=coverage,
                visual=visual,
                mechanical=mechanical,
                plan=plan,
                rubric_hash=rubric_hash,
                policy=policy,
                weighted_score=weighted_score,
            )
        conservative_scores[criterion_id] = minimum

    conservative_applicable = [(criterion, conservative_scores[criterion.id]) for criterion, _score in applicable]
    conservative_critical_failures = tuple(sorted(criterion.id for criterion, score in conservative_applicable if criterion.critical and score < policy.critical_score_floor))
    conservative_weighted_score = _weighted_score(conservative_applicable)
    if conservative_critical_failures or conservative_weighted_score < policy.min_weighted_score:
        return _decision(
            result="needs_user_review",
            reasons=("taste_score_range_crosses_policy_gate",),
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            rubric_hash=rubric_hash,
            policy=policy,
            weighted_score=weighted_score,
            failing_criteria=conservative_critical_failures,
        )
    return _decision(
        result="satisfied",
        reasons=("all_policy_gates_passed",),
        coverage=coverage,
        visual=visual,
        mechanical=mechanical,
        plan=plan,
        rubric_hash=rubric_hash,
        policy=policy,
        weighted_score=weighted_score,
    )
