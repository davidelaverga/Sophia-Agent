from __future__ import annotations

import asyncio
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from deerflow.sophia.deck_quality.adjudicator import adjudicate_shadow_result
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.fixture_runner import load_corpus, load_fixture_inputs
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    AssessmentUncertainty,
    BlindVisualAssessment,
    CommitmentRealization,
    CoverageProof,
    CriterionScore,
    EvidenceFinding,
    MechanicalCheck,
    MechanicalProjection,
    PlanRealizationAssessment,
    QualityError,
    RubricCriterionProjection,
    RubricProjection,
)
from deerflow.sophia.deck_quality.service import DeckQualityCoreService, PlanRealizationInputs

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_ROOT = REPO_ROOT / "backend/tests/fixtures/deck_quality_shadow"
HASH = "a" * 64
RUBRIC_HASH = "b" * 64
SELECTORS = ("slide:1", "slide:2")
MECHANICAL_CHECK_IDS = (
    "authoritative_gate",
    "source_retention",
    "native_editability",
    "contrast",
    "native_lint",
    "overflow_collision_clipping",
    "render_success",
    "visual_asset_completeness",
    "artifact_identity",
)


def _criterion(
    criterion_id: str,
    *,
    assessment: str,
    critical: bool = False,
    weight: str = "1",
) -> RubricCriterionProjection:
    return RubricCriterionProjection(
        id=criterion_id,
        assessment=assessment,  # type: ignore[arg-type]
        critical=critical,
        weight=Decimal(weight),
        score_anchors={1: "weak", 3: "adequate", 5: "strong"},
        allowed_failure_codes=(f"weak_{criterion_id}",),
    )


VISUAL_CRITERION = _criterion("subject_specificity", assessment="blind_visual", critical=True)
PLAN_CRITERION = _criterion("signature_realization", assessment="plan_realization")
CRITERIA = (VISUAL_CRITERION, PLAN_CRITERION)
POLICY = AdjudicationPolicy(critical_score_floor=3, min_weighted_score=Decimal("3.5"))


def _score(
    criterion_id: str,
    value: int | None,
    *,
    applicable: bool = True,
) -> CriterionScore:
    return CriterionScore(
        criterion_id=criterion_id,
        applicable=applicable,
        score=value,
        applicability_reason=None if applicable else "Not relevant to this deck.",
        rationale="Observed against the rendered artifact.",
        evidence_selectors=("slide:1",) if applicable else (),
    )


def _taste_range(
    criterion_id: str,
    minimum: int,
    maximum: int,
    *,
    selector: str = "slide:2",
) -> AssessmentUncertainty:
    return AssessmentUncertainty(
        kind="taste_score_range",
        criterion_id=criterion_id,
        plausible_min_score=minimum,
        plausible_max_score=maximum,
        reason="Two adjacent scores remain plausible from the rendered evidence.",
        evidence_selectors=(selector,),  # type: ignore[arg-type]
    )


def _visual(
    score: CriterionScore | None = None,
    *,
    uncertainties: tuple[AssessmentUncertainty, ...] = (),
    failure_codes: tuple[str, ...] = (),
    finding_selector: str | None = None,
) -> BlindVisualAssessment:
    findings = (
        (
            EvidenceFinding(
                code="weak_subject_specificity",
                observation="The visual language remains generic.",
                evidence_selectors=(finding_selector,),  # type: ignore[arg-type]
            ),
        )
        if finding_selector
        else ()
    )
    return BlindVisualAssessment(
        coverage_confirmed=True,
        evaluated_selectors=SELECTORS,
        overall_impression="Mechanically clean and visually coherent.",
        deck_failure_codes=failure_codes,
        slide_findings=findings,
        criterion_scores=(score or _score(VISUAL_CRITERION.id, 4),),
        confidence=0.9,
        uncertainties=uncertainties,
    )


def _plan(
    score: CriterionScore | None = None,
    *,
    uncertainties: tuple[AssessmentUncertainty, ...] = (),
    failure_codes: tuple[str, ...] = (),
    commitment_status: str = "realized",
    commitment_selector: str = "slide:1",
) -> PlanRealizationAssessment:
    return PlanRealizationAssessment(
        evaluated_selectors=SELECTORS,
        commitments=(
            CommitmentRealization(
                commitment_id="signature.loop",
                dimension="signature",
                status=commitment_status,  # type: ignore[arg-type]
                observation="The planned signature is visible.",
                evidence_selectors=(commitment_selector,),
            ),
        ),
        criterion_scores=(score or _score(PLAN_CRITERION.id, 4),),
        failure_codes=failure_codes,
        confidence=0.9,
        uncertainties=uncertainties,
    )


def _coverage(*, complete: bool = True) -> CoverageProof:
    return CoverageProof(
        expected_selectors=SELECTORS,
        rendered_selectors=SELECTORS,
        evaluated_selectors=SELECTORS if complete else ("slide:1",),
        contact_sheet_present=True,
        images_decode=True,
        complete=complete,
        errors=() if complete else ("evaluated_selector_mismatch",),
    )


def _mechanical(status: str = "passed") -> MechanicalProjection:
    statuses = ["passed"] * len(MECHANICAL_CHECK_IDS)
    if status == "failed":
        statuses[0] = "failed"
    elif status == "incomplete":
        statuses[0] = "unknown"
    return MechanicalProjection(
        status=status,  # type: ignore[arg-type]
        checks=tuple(
            MechanicalCheck(check_id=check_id, status=check_status)  # type: ignore[arg-type]
            for check_id, check_status in zip(MECHANICAL_CHECK_IDS, statuses, strict=True)
        ),
        authoritative_record_hash=HASH,
    )


def _adjudicate(**overrides: Any):
    values: dict[str, Any] = {
        "coverage": _coverage(),
        "visual": _visual(),
        "mechanical": _mechanical(),
        "plan": _plan(),
        "criteria": CRITERIA,
        "expected_plan_commitment_ids": ("signature.loop",),
        "rubric_hash": RUBRIC_HASH,
        "policy": POLICY,
    }
    values.update(overrides)
    return adjudicate_shadow_result(**values)


def test_adjudicator_machinery_error_branch_precedes_all_measurement_results() -> None:
    decision = _adjudicate(
        machinery_errors=(
            QualityError(code="judge_unavailable", stage="a", retryable=True),
            QualityError(code="coverage_error", stage="render"),
            QualityError(code="judge_unavailable", stage="c", retryable=True),
        ),
        mechanical=_mechanical("failed"),
    )

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("coverage_error", "judge_unavailable")


def test_adjudicator_coverage_error_branch_reports_specific_coverage_failures() -> None:
    decision = _adjudicate(coverage=_coverage(complete=False))

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("coverage_error", "evaluated_selector_mismatch")
    assert decision.evidence_selectors == SELECTORS


def test_adjudicator_incomplete_mechanical_projection_branch() -> None:
    decision = _adjudicate(mechanical=_mechanical("incomplete"))

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("mechanical_projection_incomplete",)


def test_adjudicator_mechanical_failure_branch() -> None:
    decision = _adjudicate(mechanical=_mechanical("failed"))

    assert decision.result == "mechanically_invalid"
    assert decision.reason_codes == ("authoritative_mechanical_failure",)


@pytest.mark.parametrize(("field", "value"), [("visual", None), ("plan", None)])
def test_adjudicator_missing_assessment_branch(field: str, value: None) -> None:
    decision = _adjudicate(**{field: value})

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("assessment_missing",)


def test_adjudicator_criterion_coverage_branch_rejects_missing_or_extra_scores() -> None:
    decision = _adjudicate(plan=_plan().model_copy(update={"criterion_scores": ()}))

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("criterion_coverage_invalid",)


def test_adjudicator_plan_selector_coverage_branch() -> None:
    plan = _plan().model_copy(update={"evaluated_selectors": ("slide:1",)})
    decision = _adjudicate(plan=plan)

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("plan_selector_coverage_invalid",)


def test_adjudicator_plan_commitment_coverage_branch() -> None:
    decision = _adjudicate(expected_plan_commitment_ids=("different.commitment",))

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("plan_commitment_coverage_invalid",)


def test_adjudicator_applicable_score_missing_branch_fails_closed() -> None:
    impossible_score = CriterionScore.model_construct(
        criterion_id=VISUAL_CRITERION.id,
        applicable=True,
        score=None,
        applicability_reason=None,
        rationale="Malformed provider output.",
        evidence_selectors=("slide:1",),
    )
    malformed_visual = _visual().model_copy(update={"criterion_scores": (impossible_score,)})
    decision = _adjudicate(visual=malformed_visual)

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("applicable_score_missing",)


def test_adjudicator_no_applicable_criteria_branch() -> None:
    decision = _adjudicate(
        visual=_visual(_score(VISUAL_CRITERION.id, None, applicable=False)),
        plan=_plan(_score(PLAN_CRITERION.id, None, applicable=False)),
    )

    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("no_applicable_criteria",)


def test_adjudicator_critical_floor_branch_takes_precedence_over_weighted_threshold() -> None:
    decision = _adjudicate(
        visual=_visual(_score(VISUAL_CRITERION.id, 2)),
        plan=_plan(_score(PLAN_CRITERION.id, 5)),
    )

    assert decision.result == "needs_revision"
    assert decision.reason_codes == ("critical_score_below_floor",)
    assert decision.failing_criterion_ids == (VISUAL_CRITERION.id,)
    assert decision.weighted_score == Decimal("3.5")


def test_adjudicator_weighted_score_branch() -> None:
    decision = _adjudicate(
        visual=_visual(_score(VISUAL_CRITERION.id, 3)),
        plan=_plan(_score(PLAN_CRITERION.id, 3)),
    )

    assert decision.result == "needs_revision"
    assert decision.reason_codes == ("weighted_score_below_threshold",)
    assert decision.weighted_score == Decimal("3")


def test_adjudicator_current_critical_failure_precedes_taste_range_materiality() -> None:
    decision = _adjudicate(
        visual=_visual(
            _score(VISUAL_CRITERION.id, 2),
            uncertainties=(_taste_range(VISUAL_CRITERION.id, 2, 3),),
        ),
        plan=_plan(_score(PLAN_CRITERION.id, 5)),
    )

    assert decision.result == "needs_revision"
    assert decision.reason_codes == ("critical_score_below_floor",)
    assert decision.failing_criterion_ids == (VISUAL_CRITERION.id,)


def test_adjudicator_current_weighted_failure_precedes_taste_range_materiality() -> None:
    decision = _adjudicate(
        visual=_visual(
            _score(VISUAL_CRITERION.id, 3),
            uncertainties=(_taste_range(VISUAL_CRITERION.id, 3, 4),),
        ),
        plan=_plan(_score(PLAN_CRITERION.id, 3)),
    )

    assert decision.result == "needs_revision"
    assert decision.reason_codes == ("weighted_score_below_threshold",)
    assert decision.weighted_score == Decimal("3")


def test_adjudicator_taste_range_crossing_critical_floor_requires_user_review() -> None:
    decision = _adjudicate(
        visual=_visual(
            _score(VISUAL_CRITERION.id, 3),
            uncertainties=(_taste_range(VISUAL_CRITERION.id, 2, 3),),
        ),
        plan=_plan(_score(PLAN_CRITERION.id, 4)),
    )

    assert decision.result == "needs_user_review"
    assert decision.reason_codes == ("taste_score_range_crosses_policy_gate",)
    assert decision.weighted_score == Decimal("3.5")
    assert decision.failing_criterion_ids == (VISUAL_CRITERION.id,)


def test_adjudicator_lowers_all_taste_ranges_for_aggregate_weighted_crossing() -> None:
    decision = _adjudicate(
        visual=_visual(
            _score(VISUAL_CRITERION.id, 4),
            uncertainties=(_taste_range(VISUAL_CRITERION.id, 3, 4),),
        ),
        plan=_plan(
            _score(PLAN_CRITERION.id, 4),
            uncertainties=(_taste_range(PLAN_CRITERION.id, 3, 4),),
        ),
    )

    # Lowering either range alone yields 3.5 and passes; lowering both yields 3.
    assert decision.result == "needs_user_review"
    assert decision.reason_codes == ("taste_score_range_crosses_policy_gate",)
    assert decision.weighted_score == Decimal("4")
    assert decision.failing_criterion_ids == ()


def test_adjudicator_non_crossing_taste_range_is_satisfied() -> None:
    decision = _adjudicate(
        plan=_plan(
            _score(PLAN_CRITERION.id, 5),
            uncertainties=(_taste_range(PLAN_CRITERION.id, 4, 5),),
        )
    )

    assert decision.result == "satisfied"
    assert decision.reason_codes == ("all_policy_gates_passed",)
    assert decision.weighted_score == Decimal("4.5")


def test_uncertainty_kind_is_required_and_retired_v3_fields_are_rejected() -> None:
    with pytest.raises(ValidationError):
        AssessmentUncertainty(
            criterion_id=PLAN_CRITERION.id,
            reason="The render does not expose enough evidence.",
            evidence_selectors=("slide:2",),
        )
    with pytest.raises(ValidationError):
        AssessmentUncertainty(
            kind="evidence_limit",
            criterion_id=PLAN_CRITERION.id,
            material=True,  # type: ignore[call-arg]
            reason="The render does not expose enough evidence.",
            evidence_selectors=("slide:2",),
        )
    with pytest.raises(ValidationError):
        AssessmentUncertainty(
            kind="material_taste",  # type: ignore[arg-type]
            criterion_id=PLAN_CRITERION.id,
            reason="The retired material taste kind is not valid in v4.",
            evidence_selectors=("slide:2",),
        )

    uncertainty = AssessmentUncertainty(
        kind="evidence_limit",
        criterion_id=PLAN_CRITERION.id,
        reason="The render does not expose enough evidence.",
        evidence_selectors=("slide:2",),
    )
    assert uncertainty.kind == "evidence_limit"
    assert "material" not in uncertainty.model_dump()


@pytest.mark.parametrize(
    "payload",
    [
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 3,
            "reason": "Taste ranges require both bounds.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 3,
            "plausible_max_score": 3,
            "reason": "The bounds are not adjacent.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 2,
            "plausible_max_score": 4,
            "reason": "The bounds skip a score.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 4,
            "plausible_max_score": 3,
            "reason": "The bounds are reversed.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 0,
            "plausible_max_score": 1,
            "reason": "The lower bound is outside the rubric scale.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 5,
            "plausible_max_score": 6,
            "reason": "The upper bound is outside the rubric scale.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "taste_score_range",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 3,
            "plausible_max_score": 4,
            "reason": "Taste ranges require evidence.",
            "evidence_selectors": (),
        },
        {
            "kind": "taste_score_range",
            "plausible_min_score": 3,
            "plausible_max_score": 4,
            "reason": "Taste ranges require a criterion.",
            "evidence_selectors": ("slide:2",),
        },
        {
            "kind": "evidence_limit",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_min_score": 3,
            "reason": "Evidence limits cannot carry a lower score bound.",
        },
        {
            "kind": "evidence_limit",
            "criterion_id": PLAN_CRITERION.id,
            "plausible_max_score": 4,
            "reason": "Evidence limits cannot carry an upper score bound.",
        },
    ],
)
def test_uncertainty_schema_rejects_invalid_range_shapes(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        AssessmentUncertainty.model_validate(payload)


def test_assessment_rejects_unknown_uncertainty_criterion() -> None:
    uncertainty = AssessmentUncertainty(
        kind="evidence_limit",
        criterion_id="unknown_criterion",
        reason="The referenced criterion is not present in this assessment.",
        evidence_selectors=("slide:2",),
    )
    with pytest.raises(ValidationError, match="unknown criterion"):
        _plan(uncertainties=(uncertainty,))


def test_assessment_rejects_uncertainty_for_non_applicable_criterion() -> None:
    uncertainty = AssessmentUncertainty(
        kind="evidence_limit",
        criterion_id=PLAN_CRITERION.id,
        reason="The criterion cannot be scored from the available evidence.",
    )
    with pytest.raises(ValidationError, match="non-applicable criterion"):
        _plan(
            _score(PLAN_CRITERION.id, None, applicable=False),
            uncertainties=(uncertainty,),
        )


def test_assessment_rejects_emitted_score_outside_taste_range() -> None:
    with pytest.raises(ValidationError, match="outside taste score range"):
        _plan(
            _score(PLAN_CRITERION.id, 5),
            uncertainties=(_taste_range(PLAN_CRITERION.id, 3, 4),),
        )


def test_assessment_rejects_duplicate_taste_range_for_criterion() -> None:
    uncertainty = _taste_range(PLAN_CRITERION.id, 3, 4)
    with pytest.raises(ValidationError, match="duplicate taste score ranges"):
        _plan(
            _score(PLAN_CRITERION.id, 4),
            uncertainties=(uncertainty, uncertainty),
        )


def test_evidence_limit_without_score_bounds_never_produces_user_review() -> None:
    uncertainty = AssessmentUncertainty(
        kind="evidence_limit",
        criterion_id=PLAN_CRITERION.id,
        reason="A native source property cannot be confirmed from the render.",
        evidence_selectors=("slide:2",),
    )
    decision = _adjudicate(plan=_plan(uncertainties=(uncertainty,)))

    assert decision.result == "satisfied"
    assert decision.reason_codes == ("all_policy_gates_passed",)


def test_assessment_schema_is_v4_for_score_range_uncertainties() -> None:
    assert _visual().schema_version == "deck-quality-blind-assessment/v4"
    assert _plan().schema_version == "deck-quality-plan-assessment/v4"


def test_adjudicator_satisfied_branch_hashes_inputs_and_merges_evidence() -> None:
    visual = _visual(
        failure_codes=("visual_observation",),
        finding_selector="slide:2",
    )
    plan = _plan(
        failure_codes=("plan_observation",),
        commitment_status="partial",
        commitment_selector="slide:1",
    )
    mechanical = _mechanical()
    decision = _adjudicate(visual=visual, plan=plan, mechanical=mechanical)

    assert decision.result == "satisfied"
    assert decision.reason_codes == ("all_policy_gates_passed",)
    assert decision.failure_codes == ("plan_observation", "visual_observation")
    assert decision.evidence_selectors == SELECTORS
    assert decision.visual_assessment_hash == canonical_sha256(visual)
    assert decision.mechanical_projection_hash == canonical_sha256(mechanical)
    assert decision.plan_assessment_hash == canonical_sha256(plan)


def _recursive_keys(value: object) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            keys.add(str(key))
            keys.update(_recursive_keys(child))
    elif isinstance(value, (list, tuple)):
        for child in value:
            keys.update(_recursive_keys(child))
    return keys


def _actual_fixture_snapshot():
    corpus = load_corpus(CORPUS_ROOT / "corpus.yaml")
    snapshot = load_fixture_inputs(corpus.fixtures[0], root=CORPUS_ROOT)
    checks = {check_id: True for check_id in MECHANICAL_CHECK_IDS}
    mechanical_record = {"checks": checks, "source": "stored authoritative record"}
    return snapshot.model_copy(
        update={
            "mechanical_record": mechanical_record,
            "mechanical_record_hash": canonical_sha256(mechanical_record),
        }
    )


def test_service_persists_a_before_projecting_b_or_invoking_fresh_c_and_never_exposes_labels() -> None:
    snapshot = _actual_fixture_snapshot()
    selectors = snapshot.renders.selectors
    timeline: list[str] = []
    blind_criterion = VISUAL_CRITERION
    plan_criterion = PLAN_CRITERION
    visual = BlindVisualAssessment(
        coverage_confirmed=True,
        evaluated_selectors=selectors,
        overall_impression="Clean, coherent, and sufficiently subject-specific.",
        criterion_scores=(
            CriterionScore(
                criterion_id=blind_criterion.id,
                applicable=True,
                score=4,
                rationale="Supported by the rendered slides.",
                evidence_selectors=(selectors[0],),
            ),
        ),
        confidence=0.9,
    )
    plan = PlanRealizationAssessment(
        evaluated_selectors=selectors,
        commitments=(),
        criterion_scores=(
            CriterionScore(
                criterion_id=plan_criterion.id,
                applicable=True,
                score=4,
                rationale="The signature is realized.",
                evidence_selectors=(selectors[1],),
            ),
        ),
        confidence=0.9,
    )
    forbidden_label_keys = {
        "expected",
        "verdict",
        "label_source",
        "top_failure_codes",
        "required_failure_codes",
        "prohibited_failure_codes",
        "human_label",
    }

    class Invoker:
        async def assess_blind(self, evidence):
            assert timeline == []
            keys = _recursive_keys(evidence.model_dump(mode="json"))
            assert forbidden_label_keys.isdisjoint(keys)
            assert {"creative_plan", "design_plan", "mechanical_record"}.isdisjoint(keys)
            timeline.append("assess_a")
            return visual

        async def assess_plan(self, evidence):
            assert timeline == ["assess_a", "persist_a", "persist_b"]
            keys = _recursive_keys(evidence.model_dump(mode="json"))
            assert forbidden_label_keys.isdisjoint(keys)
            assert {"visual_assessment", "overall_impression", "deck_failure_codes"}.isdisjoint(keys)
            timeline.append("assess_c")
            return plan

    class Recorder:
        async def persist_a(self, assessment):
            assert assessment is visual
            assert timeline == ["assess_a"]
            timeline.append("persist_a")

        async def persist_b(self, projection):
            assert projection.status == "passed"
            assert timeline == ["assess_a", "persist_a"]
            timeline.append("persist_b")

        async def persist_c(self, assessment):
            assert assessment is plan
            assert timeline == ["assess_a", "persist_a", "persist_b", "assess_c"]
            timeline.append("persist_c")

        async def persist_decision(self, decision):
            assert decision.result == "satisfied"
            assert timeline == [
                "assess_a",
                "persist_a",
                "persist_b",
                "assess_c",
                "persist_c",
            ]
            timeline.append("persist_decision")

        async def persist_error(self, error):
            raise AssertionError(f"successful service run persisted an unexpected error: {error}")

    service = DeckQualityCoreService(invoker=Invoker(), recorder=Recorder())
    decision = asyncio.run(
        service.run(
            snapshot=snapshot,
            blind_rubric=RubricProjection(
                rubric_version="deck-rubric-v1",
                rubric_hash=RUBRIC_HASH,
                assessment="blind_visual",
                criteria=(blind_criterion,),
            ),
            plan_rubric=RubricProjection(
                rubric_version="deck-rubric-v1",
                rubric_hash=RUBRIC_HASH,
                assessment="plan_realization",
                criteria=(plan_criterion,),
            ),
            all_criteria=(blind_criterion, plan_criterion),
            policy=POLICY,
            plan_inputs=PlanRealizationInputs(
                subject_materials=("feedback loop",),
                signature="control loop",
                rhythm="setup-mechanism-close",
                commitments=(),
                explicit_style_constraints=(),
            ),
        )
    )

    assert decision.result == "satisfied"
    assert timeline == [
        "assess_a",
        "persist_a",
        "persist_b",
        "assess_c",
        "persist_c",
        "persist_decision",
    ]


def test_service_does_not_project_b_or_invoke_c_when_a_is_not_durable() -> None:
    snapshot = _actual_fixture_snapshot()
    visual = BlindVisualAssessment(
        coverage_confirmed=True,
        evaluated_selectors=snapshot.renders.selectors,
        overall_impression="Assessment A completed.",
        criterion_scores=(
            CriterionScore(
                criterion_id=VISUAL_CRITERION.id,
                applicable=True,
                score=4,
                rationale="Rendered evidence.",
                evidence_selectors=(snapshot.renders.selectors[0],),
            ),
        ),
        confidence=0.9,
    )
    timeline: list[str] = []

    class Invoker:
        async def assess_blind(self, evidence):
            timeline.append("assess_a")
            return visual

        async def assess_plan(self, evidence):
            timeline.append("assess_c")
            raise AssertionError("C must not be invoked before A is durable")

    class Recorder:
        async def persist_a(self, assessment):
            timeline.append("persist_a_failed")
            raise RuntimeError("durable store unavailable")

        async def persist_b(self, projection):
            timeline.append("persist_b")

        async def persist_c(self, assessment):
            timeline.append("persist_c")

        async def persist_decision(self, decision):
            timeline.append("persist_decision")

        async def persist_error(self, error):
            raise AssertionError(f"recorder failure was misclassified as an invocation error: {error}")

    service = DeckQualityCoreService(invoker=Invoker(), recorder=Recorder())
    with pytest.raises(RuntimeError, match="durable store unavailable"):
        asyncio.run(
            service.run(
                snapshot=snapshot,
                blind_rubric=RubricProjection(
                    rubric_version="deck-rubric-v1",
                    rubric_hash=RUBRIC_HASH,
                    assessment="blind_visual",
                    criteria=(VISUAL_CRITERION,),
                ),
                plan_rubric=RubricProjection(
                    rubric_version="deck-rubric-v1",
                    rubric_hash=RUBRIC_HASH,
                    assessment="plan_realization",
                    criteria=(PLAN_CRITERION,),
                ),
                all_criteria=CRITERIA,
                policy=POLICY,
                plan_inputs=PlanRealizationInputs(
                    subject_materials=(),
                    signature="control loop",
                    rhythm="setup-close",
                    commitments=(),
                    explicit_style_constraints=(),
                ),
            )
        )

    assert timeline == ["assess_a", "persist_a_failed"]


def test_service_a_value_error_persists_structured_error_and_failed_decision_without_b_or_c() -> None:
    snapshot = _actual_fixture_snapshot()
    timeline: list[str] = []
    errors: list[QualityError] = []
    decisions: list[object] = []

    class Invoker:
        async def assess_blind(self, evidence):
            timeline.append("assess_a")
            raise ValueError("provider output did not match the strict A schema")

        async def assess_plan(self, evidence):
            timeline.append("assess_c")
            raise AssertionError("C must not run after A fails")

    class Recorder:
        async def persist_a(self, assessment):
            timeline.append("persist_a")

        async def persist_b(self, projection):
            timeline.append("persist_b")

        async def persist_c(self, assessment):
            timeline.append("persist_c")

        async def persist_error(self, error):
            errors.append(error)
            timeline.append("persist_error")

        async def persist_decision(self, decision):
            decisions.append(decision)
            timeline.append("persist_decision")

    service = DeckQualityCoreService(invoker=Invoker(), recorder=Recorder())
    decision = asyncio.run(
        service.run(
            snapshot=snapshot,
            blind_rubric=RubricProjection(
                rubric_version="deck-rubric-v1",
                rubric_hash=RUBRIC_HASH,
                assessment="blind_visual",
                criteria=(VISUAL_CRITERION,),
            ),
            plan_rubric=RubricProjection(
                rubric_version="deck-rubric-v1",
                rubric_hash=RUBRIC_HASH,
                assessment="plan_realization",
                criteria=(PLAN_CRITERION,),
            ),
            all_criteria=CRITERIA,
            policy=POLICY,
            plan_inputs=PlanRealizationInputs(
                subject_materials=(),
                signature="control loop",
                rhythm="setup-close",
                commitments=(),
                explicit_style_constraints=(),
            ),
        )
    )

    assert timeline == ["assess_a", "persist_error", "persist_decision"]
    assert len(errors) == 1
    assert errors[0].model_dump() == {
        "code": "structured_output_invalid",
        "stage": "assessment_a",
        "retryable": False,
    }
    assert decisions == [decision]
    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("structured_output_invalid",)
    assert decision.visual_assessment_hash is None
    assert decision.mechanical_projection_hash is None
    assert decision.plan_assessment_hash is None


def test_service_c_exception_persists_a_then_b_then_error_and_failed_decision_without_c() -> None:
    snapshot = _actual_fixture_snapshot()
    selectors = snapshot.renders.selectors
    timeline: list[str] = []
    errors: list[QualityError] = []
    decisions: list[object] = []
    visual = BlindVisualAssessment(
        coverage_confirmed=True,
        evaluated_selectors=selectors,
        overall_impression="Assessment A completed before C failed.",
        criterion_scores=(
            CriterionScore(
                criterion_id=VISUAL_CRITERION.id,
                applicable=True,
                score=4,
                rationale="Supported by the rendered slides.",
                evidence_selectors=(selectors[0],),
            ),
        ),
        confidence=0.9,
    )
    persisted_mechanical: list[MechanicalProjection] = []

    class Invoker:
        async def assess_blind(self, evidence):
            timeline.append("assess_a")
            return visual

        async def assess_plan(self, evidence):
            assert timeline == ["assess_a", "persist_a", "persist_b"]
            timeline.append("assess_c")
            raise RuntimeError("visual judge unavailable during C")

    class Recorder:
        async def persist_a(self, assessment):
            assert assessment is visual
            timeline.append("persist_a")

        async def persist_b(self, projection):
            persisted_mechanical.append(projection)
            timeline.append("persist_b")

        async def persist_c(self, assessment):
            timeline.append("persist_c")

        async def persist_error(self, error):
            errors.append(error)
            timeline.append("persist_error")

        async def persist_decision(self, decision):
            decisions.append(decision)
            timeline.append("persist_decision")

    service = DeckQualityCoreService(invoker=Invoker(), recorder=Recorder())
    decision = asyncio.run(
        service.run(
            snapshot=snapshot,
            blind_rubric=RubricProjection(
                rubric_version="deck-rubric-v1",
                rubric_hash=RUBRIC_HASH,
                assessment="blind_visual",
                criteria=(VISUAL_CRITERION,),
            ),
            plan_rubric=RubricProjection(
                rubric_version="deck-rubric-v1",
                rubric_hash=RUBRIC_HASH,
                assessment="plan_realization",
                criteria=(PLAN_CRITERION,),
            ),
            all_criteria=CRITERIA,
            policy=POLICY,
            plan_inputs=PlanRealizationInputs(
                subject_materials=("feedback loop",),
                signature="control loop",
                rhythm="setup-close",
                commitments=(),
                explicit_style_constraints=(),
            ),
        )
    )

    assert timeline == [
        "assess_a",
        "persist_a",
        "persist_b",
        "assess_c",
        "persist_error",
        "persist_decision",
    ]
    assert len(errors) == 1
    assert errors[0].model_dump() == {
        "code": "judge_unavailable",
        "stage": "assessment_c",
        "retryable": False,
    }
    assert decisions == [decision]
    assert decision.result == "failed_to_judge"
    assert decision.reason_codes == ("judge_unavailable",)
    assert decision.visual_assessment_hash == canonical_sha256(visual)
    assert decision.mechanical_projection_hash == canonical_sha256(persisted_mechanical[0])
    assert decision.plan_assessment_hash is None
