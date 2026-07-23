from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from deerflow.sophia.deck_quality.adjudicator import adjudicate_shadow_result, failed_to_judge_decision
from deerflow.sophia.deck_quality.evidence import (
    brief_scoped_criteria,
    prepare_blind_visual_evidence,
    prepare_plan_realization_evidence,
    prove_coverage,
)
from deerflow.sophia.deck_quality.mechanical import project_mechanical_truth
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    BlindVisualAssessment,
    BlindVisualEvidence,
    MechanicalProjection,
    PlanCommitment,
    PlanRealizationAssessment,
    PlanRealizationEvidence,
    QualityError,
    QualityEvidenceSnapshot,
    RubricCriterionProjection,
    RubricProjection,
    ShadowDecision,
)


class AssessmentInvoker(Protocol):
    async def assess_blind(self, evidence: BlindVisualEvidence) -> BlindVisualAssessment: ...

    async def assess_plan(self, evidence: PlanRealizationEvidence) -> PlanRealizationAssessment: ...


class AssessmentRecorder(Protocol):
    async def persist_a(self, assessment: BlindVisualAssessment) -> None: ...

    async def persist_b(self, projection: MechanicalProjection) -> None: ...

    async def persist_c(self, assessment: PlanRealizationAssessment) -> None: ...

    async def persist_decision(self, decision: ShadowDecision) -> None: ...

    async def persist_error(self, error: QualityError) -> None: ...


@dataclass(frozen=True)
class PlanRealizationInputs:
    subject_materials: tuple[str, ...]
    signature: str
    rhythm: str
    commitments: tuple[PlanCommitment, ...]
    explicit_style_constraints: tuple[str, ...]


class DeckQualityCoreService:
    """A/B/C orchestration with no imports or authority in the builder path."""

    def __init__(self, *, invoker: AssessmentInvoker, recorder: AssessmentRecorder) -> None:
        self._invoker = invoker
        self._recorder = recorder

    async def _record_invocation_error(
        self,
        *,
        stage: str,
        error: Exception,
        snapshot: QualityEvidenceSnapshot,
        rubric_hash: str,
        policy: AdjudicationPolicy,
        visual: BlindVisualAssessment | None = None,
        mechanical: MechanicalProjection | None = None,
    ) -> ShadowDecision:
        controlled_code = getattr(error, "code", None)
        if controlled_code in {"judge_unavailable", "structured_output_invalid"}:
            code = controlled_code
        else:
            code = "structured_output_invalid" if isinstance(error, (TypeError, ValueError)) else "judge_unavailable"
        quality_error = QualityError(code=code, stage=stage, retryable=False)
        persist_error = getattr(self._recorder, "persist_error", None)
        if callable(persist_error):
            await persist_error(quality_error)
        decision = failed_to_judge_decision(
            coverage=prove_coverage(snapshot, visual),
            rubric_hash=rubric_hash,
            policy=policy,
            errors=(quality_error,),
            visual=visual,
            mechanical=mechanical,
        )
        await self._recorder.persist_decision(decision)
        return decision

    async def run(
        self,
        *,
        snapshot: QualityEvidenceSnapshot,
        blind_rubric: RubricProjection,
        plan_rubric: RubricProjection,
        all_criteria: tuple[RubricCriterionProjection, ...],
        policy: AdjudicationPolicy,
        plan_inputs: PlanRealizationInputs,
    ) -> ShadowDecision:
        scoped_criteria = brief_scoped_criteria(all_criteria, snapshot.brief)
        blind_evidence = prepare_blind_visual_evidence(snapshot, blind_rubric)
        try:
            visual = await self._invoker.assess_blind(blind_evidence)
        except Exception as exc:
            return await self._record_invocation_error(
                stage="assessment_a",
                error=exc,
                snapshot=snapshot,
                rubric_hash=blind_rubric.rubric_hash,
                policy=policy,
            )
        await self._recorder.persist_a(visual)

        # DQ-1 locks this order: no mechanical or plan context exists before A is durable.
        mechanical = project_mechanical_truth(snapshot)
        await self._recorder.persist_b(mechanical)

        coverage = prove_coverage(snapshot, visual)
        if not coverage.complete or mechanical.status != "passed":
            decision = adjudicate_shadow_result(
                coverage=coverage,
                visual=visual,
                mechanical=mechanical,
                plan=None,
                criteria=scoped_criteria,
                expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
                rubric_hash=blind_rubric.rubric_hash,
                policy=policy,
            )
            await self._recorder.persist_decision(decision)
            return decision

        plan_evidence = prepare_plan_realization_evidence(
            snapshot,
            rubric=plan_rubric,
            subject_materials=plan_inputs.subject_materials,
            signature=plan_inputs.signature,
            rhythm=plan_inputs.rhythm,
            commitments=plan_inputs.commitments,
            explicit_style_constraints=plan_inputs.explicit_style_constraints,
        )
        try:
            plan = await self._invoker.assess_plan(plan_evidence)
        except Exception as exc:
            return await self._record_invocation_error(
                stage="assessment_c",
                error=exc,
                snapshot=snapshot,
                rubric_hash=blind_rubric.rubric_hash,
                policy=policy,
                visual=visual,
                mechanical=mechanical,
            )
        await self._recorder.persist_c(plan)

        decision = adjudicate_shadow_result(
            coverage=coverage,
            visual=visual,
            mechanical=mechanical,
            plan=plan,
            criteria=scoped_criteria,
            expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
            rubric_hash=blind_rubric.rubric_hash,
            policy=policy,
        )
        await self._recorder.persist_decision(decision)
        return decision
