from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from deerflow.sophia.deck_design_lift import (
    ContentPreservationProof,
    DeckRepairCandidate,
    DeckRepairProgram,
    DeckVersionComparisonInput,
    JudgmentRepairFinding,
    LocalityProof,
    RepairCompilerInput,
    RepairProgramRejected,
    RepairRenderEvidence,
    SelectorSourceAuthorization,
    SkillRef,
    SourceUpdate,
    VersionCriterionScore,
    VersionQualityEvidence,
    compare_deck_versions,
    compile_repair_program,
    validate_candidate_against_program,
)
from deerflow.sophia.deck_quality.schemas import ShadowDecision

HASH = "a" * 64
OTHER_HASH = "b" * 64
PSI_FAILURES = (
    "weak_subject_specificity",
    "weak_signature_realization",
    "default_look_gravity",
    "low_sequence_rhythm",
)


def _decision() -> ShadowDecision:
    return ShadowDecision(
        result="needs_revision",
        reason_codes=("critical_score_below_floor",),
        weighted_score=Decimal("2.4"),
        critical_score_floor=3,
        failure_codes=PSI_FAILURES,
        evidence_selectors=("slide:1", "slide:3", "slide:5"),
        rubric_hash=HASH,
        policy_hash=OTHER_HASH,
    )


def _skill() -> SkillRef:
    return SkillRef(
        path="skills/public/hands-on-deck/designing-slides.md",
        source_hash=HASH,
        excerpt_hash=OTHER_HASH,
    )


def _finding(selector: str, failure_code: str) -> JudgmentRepairFinding:
    return JudgmentRepairFinding(
        target_selector=selector,
        failure_code=failure_code,
        observation=f"{failure_code} is visible in the rendered slide.",
        render_evidence=(
            RepairRenderEvidence(
                selector=selector,
                path=f"renders/{selector.replace(':', '-')}.png",
                sha256=HASH,
            ),
        ),
        requested_source_roles=("body", "slide_css"),
        retained_content=("Preserve the PSI claim and factual wording.",),
        skill_refs=(_skill(),),
    )


def _compiler_input(**updates: object) -> RepairCompilerInput:
    values = {
        "build_id": "build-1",
        "initial_quality_run_id": "quality-initial",
        "initial_manifest_revision": 1,
        "initial_decision": _decision(),
        "source_authorizations": tuple(
            SelectorSourceAuthorization(
                selector=selector,
                source_roles=("body", "slide_css"),
            )
            for selector in ("slide:1", "slide:3", "slide:5")
        ),
        "findings": (
            _finding("slide:1", "weak_subject_specificity"),
            _finding("slide:3", "weak_signature_realization"),
            _finding("slide:5", "low_sequence_rhythm"),
        ),
        "rubric_version": "sophia-deck-rubric/v1",
        "instrument_hash": HASH,
    }
    values.update(updates)
    return RepairCompilerInput.model_validate(values)


def test_compiler_freezes_selector_roles_and_canonical_hash() -> None:
    program = compile_repair_program(_compiler_input())

    assert program.repair_attempt == 1
    assert program.authorized_selectors == ("slide:1", "slide:3", "slide:5")
    assert program.authorized_source_roles["slide:3"] == ("body", "slide_css")
    assert set(program.expected_improvements) == {
        "weak_subject_specificity",
        "weak_signature_realization",
        "low_sequence_rhythm",
    }
    assert DeckRepairProgram.model_validate(program.model_dump()) == program

    tampered = program.model_dump()
    tampered["deck_instruction"] = "Write anything anywhere."
    with pytest.raises(ValidationError, match="program hash"):
        DeckRepairProgram.model_validate(tampered)


def test_compiler_enforces_one_repair_and_source_authorization() -> None:
    with pytest.raises(RepairProgramRejected, match="automatic_repair_limit_reached"):
        compile_repair_program(_compiler_input(prior_repair_count=1))

    unauthorized = _finding("slide:1", "weak_subject_specificity").model_copy(
        update={"requested_source_roles": ("notes",)}
    )
    with pytest.raises(RepairProgramRejected, match="unauthorized_source_role"):
        compile_repair_program(_compiler_input(findings=(unauthorized,)))


def test_candidate_authorization_rejects_unfrozen_writes_and_plan_patches() -> None:
    program = compile_repair_program(_compiler_input())
    authorized = DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=HASH,
                content="<section>PSI-specific revision</section>",
            ),
        ),
        rationale="Resolve the frozen subject-specificity failure.",
    )
    assert validate_candidate_against_program(authorized, program) is authorized

    unauthorized = authorized.model_copy(
        update={
            "source_updates": (
                SourceUpdate(
                    selector="slide:2",
                    source_role="body",
                    expected_source_hash=HASH,
                    content="<section>Collateral edit</section>",
                ),
            )
        }
    )
    with pytest.raises(RepairProgramRejected, match="unauthorized_selector_write"):
        validate_candidate_against_program(unauthorized, program)

    plan_patch = authorized.model_copy(update={"design_plan_patch": {"signature": "new"}})
    with pytest.raises(RepairProgramRejected, match="plan_revision_not_authorized"):
        validate_candidate_against_program(plan_patch, program)


def _criteria(*, candidate: bool = False, critical_regression: bool = False):
    if not candidate:
        return (
            VersionCriterionScore(
                criterion_id="subject_specificity", score=2, critical=True, failed=True
            ),
            VersionCriterionScore(
                criterion_id="signature_realization", score=2, critical=False, failed=True
            ),
            VersionCriterionScore(
                criterion_id="sequence_rhythm", score=2, critical=False, failed=True
            ),
            VersionCriterionScore(
                criterion_id="content_fidelity", score=4, critical=True
            ),
        )
    return (
        VersionCriterionScore(
            criterion_id="subject_specificity", score=4, critical=True
        ),
        VersionCriterionScore(
            criterion_id="signature_realization", score=4, critical=False
        ),
        VersionCriterionScore(
            criterion_id="sequence_rhythm", score=3, critical=False
        ),
        VersionCriterionScore(
            criterion_id="content_fidelity",
            score=3 if critical_regression else 4,
            critical=True,
        ),
    )


def _quality(*, candidate: bool = False, **updates: object) -> VersionQualityEvidence:
    values = {
        "quality_run_id": "quality-candidate" if candidate else "quality-initial",
        "artifact_version_id": "artifact-candidate" if candidate else "artifact-initial",
        "verdict": "satisfied" if candidate else "needs_revision",
        "weighted_score": Decimal("4.0") if candidate else Decimal("2.4"),
        "criterion_scores": _criteria(candidate=candidate),
        "failure_codes": () if candidate else PSI_FAILURES,
        "critical_failure_codes": (),
        "mechanics_passed": True,
        "coverage_complete": True,
    }
    updates and values.update(updates)
    return VersionQualityEvidence.model_validate(values)


def _comparison_input(**candidate_updates: object) -> DeckVersionComparisonInput:
    return DeckVersionComparisonInput(
        initial=_quality(),
        candidate=_quality(candidate=True, **candidate_updates),
        locality=LocalityProof(
            authorized_selectors=("slide:1", "slide:3", "slide:5"),
            changed_component_versions=("slide:1", "slide:3", "slide:5"),
            unchanged_component_versions=("slide:2", "slide:4"),
            shared_dependency_changed=False,
        ),
        content=ContentPreservationProof(
            brief_preserved=True,
            initial_slide_count=5,
            candidate_slide_count=5,
            required_content_preserved=True,
            factual_content_preserved=True,
            native_editability_preserved=True,
        ),
        expected_failure_codes=PSI_FAILURES,
    )


def test_comparator_approves_all_ten_gates_and_psi_three_family_floor() -> None:
    comparison = compare_deck_versions(_comparison_input())

    assert comparison.result == "approved_improvement"
    assert comparison.reasons == ("all_improvement_gates_passed",)
    assert comparison.score_deltas["subject_specificity"] == 2.0
    assert comparison.locality_preserved is True
    assert set(comparison.resolved_failure_codes) == set(PSI_FAILURES)


def test_comparator_rejects_when_only_two_psi_families_resolve() -> None:
    comparison = compare_deck_versions(
        _comparison_input(
            failure_codes=("default_look_gravity", "low_sequence_rhythm"),
        )
    )

    assert comparison.result == "not_improved"
    assert "psi_resolved_failure_family_floor_not_met" in comparison.reasons


def test_needs_user_review_requires_preference_only_uncertainty_and_strong_gain() -> None:
    eligible = compare_deck_versions(
        _comparison_input(
            verdict="needs_user_review",
            uncertainties=("taste_score_range",),
        )
    )
    assert eligible.result == "approved_improvement"

    evidence_limited = compare_deck_versions(
        _comparison_input(
            verdict="needs_user_review",
            uncertainties=("evidence_limit",),
        )
    )
    assert evidence_limited.result == "not_improved"
    assert "candidate_needs_user_review_not_eligible" in evidence_limited.reasons


def test_comparator_classifies_critical_score_regression() -> None:
    comparison = compare_deck_versions(
        _comparison_input(criterion_scores=_criteria(candidate=True, critical_regression=True))
    )

    assert comparison.result == "regressed"
    assert "critical_score_regression" in comparison.reasons
