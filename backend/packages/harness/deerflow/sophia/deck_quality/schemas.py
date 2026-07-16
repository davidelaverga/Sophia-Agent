from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
StableSlideSelector = Annotated[str, Field(pattern=r"^slide:[1-9][0-9]*$")]
AssessmentOwner = Literal["blind_visual", "plan_realization"]


class StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _duplicates(values: tuple[str, ...]) -> set[str]:
    seen: set[str] = set()
    duplicate: set[str] = set()
    for value in values:
        if value in seen:
            duplicate.add(value)
        seen.add(value)
    return duplicate


class BlindBrief(StrictFrozenModel):
    request: str = Field(min_length=1, max_length=20_000)
    subject: str = Field(min_length=1, max_length=2_000)
    audience: str = Field(min_length=1, max_length=2_000)
    goal: str = Field(min_length=1, max_length=2_000)
    viewing_context: str = Field(default="presentation", max_length=2_000)
    explicit_brand_style_constraints: tuple[str, ...] = ()


class ImageEvidence(StrictFrozenModel):
    selector: StableSlideSelector | Literal["contact-sheet"]
    path: str = Field(min_length=1, max_length=4_096)
    sha256: Sha256
    media_type: Literal["image/png"] = "image/png"
    width: int = Field(gt=0, le=20_000)
    height: int = Field(gt=0, le=20_000)
    decodes: bool = True


class VisibleTextSlide(StrictFrozenModel):
    selector: StableSlideSelector
    text: str = Field(max_length=40_000)
    source_hash: Sha256


class RubricCriterionProjection(StrictFrozenModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    assessment: AssessmentOwner
    critical: bool
    weight: Decimal = Field(gt=0)
    score_anchors: dict[Literal[1, 3, 5], str]
    allowed_failure_codes: tuple[str, ...] = ()

    @field_validator("score_anchors")
    @classmethod
    def require_all_anchors(cls, value: dict[int, str]) -> dict[int, str]:
        if set(value) != {1, 3, 5}:
            raise ValueError("criterion must define observable score anchors 1, 3, and 5")
        if any(not anchor.strip() for anchor in value.values()):
            raise ValueError("score anchors cannot be blank")
        return value


class RubricProjection(StrictFrozenModel):
    schema_version: Literal["deck-quality-rubric-projection/v1"] = "deck-quality-rubric-projection/v1"
    rubric_version: str
    rubric_hash: Sha256
    assessment: AssessmentOwner
    criteria: tuple[RubricCriterionProjection, ...]

    @model_validator(mode="after")
    def require_unique_criteria(self) -> RubricProjection:
        duplicate = _duplicates(tuple(item.id for item in self.criteria))
        if duplicate:
            raise ValueError(f"duplicate projected criterion IDs: {', '.join(sorted(duplicate))}")
        if not self.criteria:
            raise ValueError("rubric projection cannot be empty")
        if any(item.assessment != self.assessment for item in self.criteria):
            raise ValueError("projected criterion owner does not match projection owner")
        return self


class RenderEvidence(StrictFrozenModel):
    expected_slide_count: int = Field(ge=1, le=500)
    contact_sheet: ImageEvidence
    slides: tuple[ImageEvidence, ...]
    selectors: tuple[StableSlideSelector, ...]

    @model_validator(mode="after")
    def validate_static_coverage(self) -> RenderEvidence:
        if self.contact_sheet.selector != "contact-sheet":
            raise ValueError("contact sheet evidence must use selector 'contact-sheet'")
        if len(self.slides) != self.expected_slide_count:
            raise ValueError("rendered slide count does not equal expected slide count")
        if len(self.selectors) != self.expected_slide_count:
            raise ValueError("selector count does not equal expected slide count")
        duplicate = _duplicates(tuple(self.selectors))
        if duplicate:
            raise ValueError(f"duplicate selectors: {', '.join(sorted(duplicate))}")
        slide_selectors = tuple(str(image.selector) for image in self.slides)
        if slide_selectors != self.selectors:
            raise ValueError("individual slide evidence must exactly match selector order")
        paths = tuple(image.path for image in self.slides)
        if _duplicates(paths):
            raise ValueError("each slide selector must reference a unique image path")
        if not self.contact_sheet.decodes or any(not image.decodes for image in self.slides):
            raise ValueError("all render evidence must decode")
        return self


class BlindVisualEvidence(StrictFrozenModel):
    schema_version: Literal["deck-quality-blind-evidence/v1"] = "deck-quality-blind-evidence/v1"
    brief: BlindBrief
    renders: RenderEvidence
    visible_text: tuple[VisibleTextSlide, ...]
    rubric: RubricProjection

    @model_validator(mode="after")
    def align_visible_text(self) -> BlindVisualEvidence:
        if self.rubric.assessment != "blind_visual":
            raise ValueError("blind evidence requires a blind-visual rubric projection")
        selectors = tuple(item.selector for item in self.visible_text)
        if selectors != self.renders.selectors:
            raise ValueError("visible-text sidecar must exactly match rendered selector order")
        return self


class PlanCommitment(StrictFrozenModel):
    commitment_id: str = Field(pattern=r"^[a-zA-Z0-9_.:-]+$")
    dimension: Literal[
        "subject_material",
        "signature",
        "rhythm",
        "structural_fingerprint",
        "visual_medium",
        "default_look",
    ]
    promise: str = Field(min_length=1, max_length=10_000)
    selectors: tuple[StableSlideSelector, ...] = ()


class PlanRealizationEvidence(StrictFrozenModel):
    schema_version: Literal["deck-quality-plan-evidence/v1"] = "deck-quality-plan-evidence/v1"
    brief: BlindBrief
    renders: RenderEvidence
    visible_text: tuple[VisibleTextSlide, ...]
    creative_plan: dict[str, Any]
    design_plan: dict[str, Any]
    subject_materials: tuple[str, ...]
    signature: str
    rhythm: str
    commitments: tuple[PlanCommitment, ...]
    explicit_style_constraints: tuple[str, ...]
    rubric: RubricProjection

    @model_validator(mode="after")
    def validate_plan_context(self) -> PlanRealizationEvidence:
        if self.rubric.assessment != "plan_realization":
            raise ValueError("plan evidence requires a plan-realization rubric projection")
        duplicate = _duplicates(tuple(item.commitment_id for item in self.commitments))
        if duplicate:
            raise ValueError(f"duplicate plan commitments: {', '.join(sorted(duplicate))}")
        if tuple(item.selector for item in self.visible_text) != self.renders.selectors:
            raise ValueError("plan visible-text sidecar must exactly match rendered selector order")
        return self


class QualityEvidenceSnapshot(StrictFrozenModel):
    schema_version: Literal["deck-quality-snapshot/v1"] = "deck-quality-snapshot/v1"
    campaign_id: str
    build_id: str
    user_id: str
    task_id: str | None = None
    builder_run_id: str | None = None
    parent_builder_trace_id: str | None = None
    logical_artifact_id: str
    artifact_version_id: str
    manifest_revision: int | None = Field(default=None, ge=1)
    artifact_path: str
    artifact_hash: Sha256
    brief_hash: Sha256
    creative_plan_hash: Sha256
    design_plan_hash: Sha256
    brief: BlindBrief
    renders: RenderEvidence
    visible_text: tuple[VisibleTextSlide, ...]
    creative_plan: dict[str, Any]
    design_plan: dict[str, Any]
    mechanical_record: dict[str, Any]
    mechanical_record_hash: Sha256


class EvidenceFinding(StrictFrozenModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    observation: str = Field(min_length=1, max_length=8_000)
    evidence_selectors: tuple[StableSlideSelector, ...]

    @field_validator("evidence_selectors")
    @classmethod
    def require_evidence(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if not value:
            raise ValueError("material findings require at least one slide selector")
        if _duplicates(value):
            raise ValueError("finding selectors must be unique")
        return value


class CriterionScore(StrictFrozenModel):
    criterion_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    applicable: bool
    score: int | None = Field(default=None, ge=1, le=5)
    applicability_reason: str | None = Field(default=None, max_length=2_000)
    rationale: str = Field(min_length=1, max_length=8_000)
    evidence_selectors: tuple[StableSlideSelector, ...]

    @model_validator(mode="after")
    def align_score_and_applicability(self) -> CriterionScore:
        if self.applicable and self.score is None:
            raise ValueError("applicable criteria require a score")
        if not self.applicable and self.score is not None:
            raise ValueError("non-applicable criteria cannot have a score")
        if not self.applicable and not (self.applicability_reason or "").strip():
            raise ValueError("non-applicable criteria require an applicability reason")
        if self.applicable and not self.evidence_selectors:
            raise ValueError("applicable criteria require evidence selectors")
        if _duplicates(tuple(self.evidence_selectors)):
            raise ValueError("criterion evidence selectors must be unique")
        return self


class AssessmentUncertainty(StrictFrozenModel):
    kind: Literal["taste_score_range", "evidence_limit"]
    criterion_id: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_]*$")
    plausible_min_score: int | None = Field(default=None, ge=1, le=5)
    plausible_max_score: int | None = Field(default=None, ge=1, le=5)
    reason: str = Field(min_length=1, max_length=4_000)
    evidence_selectors: tuple[StableSlideSelector, ...] = ()

    @model_validator(mode="after")
    def validate_uncertainty_shape(self) -> AssessmentUncertainty:
        if _duplicates(tuple(self.evidence_selectors)):
            raise ValueError("uncertainty evidence selectors must be unique")
        if self.kind == "taste_score_range":
            if self.criterion_id is None:
                raise ValueError("taste score ranges require a criterion ID")
            if self.plausible_min_score is None or self.plausible_max_score is None:
                raise ValueError("taste score ranges require plausible minimum and maximum scores")
            if self.plausible_max_score != self.plausible_min_score + 1:
                raise ValueError("taste score range bounds must be adjacent scores")
            if not self.evidence_selectors:
                raise ValueError("taste score ranges require evidence selectors")
        elif self.plausible_min_score is not None or self.plausible_max_score is not None:
            raise ValueError("evidence-limit uncertainties cannot include score bounds")
        return self


def _validate_assessment_uncertainties(
    *,
    criterion_scores: tuple[CriterionScore, ...],
    uncertainties: tuple[AssessmentUncertainty, ...],
) -> None:
    score_by_id = {item.criterion_id: item for item in criterion_scores}
    taste_criterion_ids: list[str] = []
    for uncertainty in uncertainties:
        criterion_id = uncertainty.criterion_id
        if criterion_id is None:
            continue
        score = score_by_id.get(criterion_id)
        if score is None:
            raise ValueError(f"uncertainty references unknown criterion: {criterion_id}")
        if not score.applicable or score.score is None:
            raise ValueError(f"uncertainty references non-applicable criterion: {criterion_id}")
        if uncertainty.kind != "taste_score_range":
            continue
        taste_criterion_ids.append(criterion_id)
        minimum = uncertainty.plausible_min_score
        maximum = uncertainty.plausible_max_score
        if minimum is None or maximum is None or not minimum <= score.score <= maximum:
            raise ValueError(f"emitted criterion score falls outside taste score range: {criterion_id}")
    duplicate = _duplicates(tuple(taste_criterion_ids))
    if duplicate:
        raise ValueError(f"duplicate taste score ranges: {', '.join(sorted(duplicate))}")


class BlindVisualAssessment(StrictFrozenModel):
    schema_version: Literal["deck-quality-blind-assessment/v4"] = "deck-quality-blind-assessment/v4"
    coverage_confirmed: bool
    evaluated_selectors: tuple[StableSlideSelector, ...]
    overall_impression: str = Field(min_length=1, max_length=8_000)
    strengths: tuple[EvidenceFinding, ...] = ()
    deck_failure_codes: tuple[str, ...] = ()
    slide_findings: tuple[EvidenceFinding, ...] = ()
    criterion_scores: tuple[CriterionScore, ...]
    confidence: float = Field(ge=0, le=1)
    uncertainties: tuple[AssessmentUncertainty, ...] = ()

    @model_validator(mode="after")
    def require_unique_output_keys(self) -> BlindVisualAssessment:
        selector_duplicates = _duplicates(tuple(self.evaluated_selectors))
        criterion_duplicates = _duplicates(tuple(item.criterion_id for item in self.criterion_scores))
        if selector_duplicates:
            raise ValueError(f"duplicate evaluated selectors: {', '.join(sorted(selector_duplicates))}")
        if criterion_duplicates:
            raise ValueError(f"duplicate criterion scores: {', '.join(sorted(criterion_duplicates))}")
        _validate_assessment_uncertainties(
            criterion_scores=self.criterion_scores,
            uncertainties=self.uncertainties,
        )
        return self


class MechanicalCheck(StrictFrozenModel):
    check_id: Literal[
        "authoritative_gate",
        "source_retention",
        "native_editability",
        "contrast",
        "native_lint",
        "overflow_collision_clipping",
        "render_success",
        "visual_asset_completeness",
        "artifact_identity",
    ]
    status: Literal["passed", "failed", "unknown"]
    failure_codes: tuple[str, ...] = ()
    selectors: tuple[StableSlideSelector, ...] = ()


class MechanicalProjection(StrictFrozenModel):
    schema_version: Literal["deck-quality-mechanical-projection/v1"] = "deck-quality-mechanical-projection/v1"
    status: Literal["passed", "failed", "incomplete"]
    checks: tuple[MechanicalCheck, ...]
    authoritative_record_hash: Sha256

    @model_validator(mode="after")
    def align_projection_status(self) -> MechanicalProjection:
        duplicate = _duplicates(tuple(item.check_id for item in self.checks))
        if duplicate:
            raise ValueError(f"duplicate mechanical checks: {', '.join(sorted(duplicate))}")
        required = {
            "authoritative_gate",
            "source_retention",
            "native_editability",
            "contrast",
            "native_lint",
            "overflow_collision_clipping",
            "render_success",
            "visual_asset_completeness",
            "artifact_identity",
        }
        actual = {item.check_id for item in self.checks}
        if actual != required:
            missing = ", ".join(sorted(required - actual)) or "none"
            extra = ", ".join(sorted(actual - required)) or "none"
            raise ValueError(f"mechanical projection check coverage invalid; missing={missing}; extra={extra}")
        statuses = {item.status for item in self.checks}
        if self.status == "passed" and statuses != {"passed"}:
            raise ValueError("passed mechanical projection cannot contain failed or unknown checks")
        if self.status == "failed" and "failed" not in statuses:
            raise ValueError("failed mechanical projection requires at least one failed check")
        if self.status == "incomplete" and "unknown" not in statuses:
            raise ValueError("incomplete mechanical projection requires at least one unknown check")
        return self


class CommitmentRealization(StrictFrozenModel):
    commitment_id: str = Field(pattern=r"^[a-zA-Z0-9_.:-]+$")
    dimension: Literal[
        "subject_material",
        "signature",
        "rhythm",
        "structural_fingerprint",
        "visual_medium",
        "default_look",
    ]
    status: Literal["realized", "partial", "not_realized", "not_applicable"]
    observation: str = Field(min_length=1, max_length=8_000)
    evidence_selectors: tuple[StableSlideSelector, ...]


class PlanRealizationAssessment(StrictFrozenModel):
    schema_version: Literal["deck-quality-plan-assessment/v4"] = "deck-quality-plan-assessment/v4"
    evaluated_selectors: tuple[StableSlideSelector, ...]
    commitments: tuple[CommitmentRealization, ...]
    criterion_scores: tuple[CriterionScore, ...]
    failure_codes: tuple[str, ...] = ()
    confidence: float = Field(ge=0, le=1)
    uncertainties: tuple[AssessmentUncertainty, ...] = ()

    @model_validator(mode="after")
    def require_unique_plan_outputs(self) -> PlanRealizationAssessment:
        groups = {
            "evaluated selectors": tuple(self.evaluated_selectors),
            "commitment IDs": tuple(item.commitment_id for item in self.commitments),
            "criterion scores": tuple(item.criterion_id for item in self.criterion_scores),
        }
        for label, values in groups.items():
            duplicate = _duplicates(values)
            if duplicate:
                raise ValueError(f"duplicate {label}: {', '.join(sorted(duplicate))}")
        _validate_assessment_uncertainties(
            criterion_scores=self.criterion_scores,
            uncertainties=self.uncertainties,
        )
        return self


class CoverageProof(StrictFrozenModel):
    expected_selectors: tuple[StableSlideSelector, ...]
    rendered_selectors: tuple[StableSlideSelector, ...]
    evaluated_selectors: tuple[StableSlideSelector, ...]
    contact_sheet_present: bool
    images_decode: bool
    complete: bool
    errors: tuple[str, ...] = ()


class QualityError(StrictFrozenModel):
    code: Literal[
        "judge_unavailable",
        "coverage_error",
        "structured_output_invalid",
        "artifact_snapshot_stale",
        "quality_persistence_error",
        "shadow_dispatch_unavailable",
    ]
    stage: str
    retryable: bool = False


class AdjudicationPolicy(StrictFrozenModel):
    schema_version: Literal["deck-quality-adjudication/v1"] = "deck-quality-adjudication/v1"
    critical_score_floor: int = Field(default=3, ge=1, le=5)
    min_weighted_score: Decimal = Field(default=Decimal("3.5"), ge=1, le=5)


class ShadowDecision(StrictFrozenModel):
    schema_version: Literal["deck-quality-shadow-decision/v1"] = "deck-quality-shadow-decision/v1"
    result: Literal[
        "failed_to_judge",
        "mechanically_invalid",
        "needs_revision",
        "needs_user_review",
        "satisfied",
    ]
    reason_codes: tuple[str, ...]
    weighted_score: Decimal | None = None
    critical_score_floor: int
    failing_criterion_ids: tuple[str, ...] = ()
    failure_codes: tuple[str, ...] = ()
    evidence_selectors: tuple[StableSlideSelector, ...] = ()
    rubric_hash: Sha256
    policy_hash: Sha256
    visual_assessment_hash: Sha256 | None = None
    mechanical_projection_hash: Sha256 | None = None
    plan_assessment_hash: Sha256 | None = None


class QualityInstrumentLock(StrictFrozenModel):
    schema_version: Literal["deck-quality-instrument/v2"] = "deck-quality-instrument/v2"
    rubric_version: str
    rubric_hash: Sha256
    prompt_hashes: dict[str, Sha256]
    judge_plan_hash: Sha256
    judge_profile_version: str
    evidence_preprocessor_version: str
    judge_invoker_version: str
    assessment_schema_versions: dict[str, str]
    adjudication_policy_hash: Sha256


class ScopeDecision(StrictFrozenModel):
    eligible: bool
    reason: Literal[
        "eligible",
        "disabled",
        "not_canary_user",
        "builder_not_successful",
        "artifact_not_pptx",
        "artifact_not_downloadable",
        "mechanical_not_passed",
    ]
