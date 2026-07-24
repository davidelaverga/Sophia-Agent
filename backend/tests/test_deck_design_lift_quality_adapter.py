from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest

from deerflow.sophia.build_manifest import BuildComponent, BuildManifest
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.quality_adapter import (
    DeckQualityEvidenceAdapterError,
    DurableDeckQualityEvidenceAdapter,
    load_committed_skill_excerpts,
)
from deerflow.sophia.deck_design_lift.runtime import BlindDeckJudgmentRequest
from deerflow.sophia.deck_quality.adjudicator import adjudicate_shadow_result
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.evidence import brief_scoped_criteria, prove_coverage
from deerflow.sophia.deck_quality.graph import (
    _AssessmentAArtifact,
    _AssessmentCArtifact,
    _MechanicalArtifact,
)
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.persistence import (
    REQUIRED_TRACE_ID_KEYS,
    STAGE_RANK,
    QualityRunDecision,
    QualityRunRecord,
    QualityRunStage,
    safe_trace_root_input_hash,
)
from deerflow.sophia.deck_quality.plan import derive_plan_realization_inputs
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    BlindBrief,
    BlindVisualAssessment,
    CommitmentRealization,
    CriterionScore,
    EvidenceFinding,
    ImageEvidence,
    MechanicalCheck,
    MechanicalProjection,
    PlanRealizationAssessment,
    QualityEvidenceSnapshot,
    QualityInstrumentLock,
    RenderEvidence,
    RubricCriterionProjection,
    RubricProjection,
    VisibleTextSlide,
)
from deerflow.sophia.deck_quality.snapshot import (
    RenderSourcePdfReference,
    RenderSourceReference,
    SnapshotArtifactReference,
    SnapshotEvidenceBundle,
    SnapshotEvidenceManifest,
    SnapshotObjectRecord,
    SnapshotSourceHashes,
)
from deerflow.sophia.deck_quality.tracing import SafeQualityTraceRootInput
from deerflow.sophia.storage.supabase_artifact_store import (
    immutable_builder_artifact_object_path,
)

NOW = datetime(2026, 7, 17, 12, 0, tzinfo=UTC)
USER_ID = "canary-user"
THREAD_ID = "parent-thread-0001"
OWNER_THREAD_ID = "builder-thread-0001"
BUILD_ID = "build-0001"
LOGICAL_ID = "artifact-0001"
TASK_ID = OWNER_THREAD_ID
BUILDER_RUN_ID = "builder-run-0001"
BUILDER_TRACE_ID = "builder-trace-0001"
SLIDE_SELECTORS = ("slide:1", "slide:2", "slide:3", "slide:4")


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _criterion(
    criterion_id: str,
    *,
    assessment: str,
    critical: bool,
    failure_code: str,
) -> RubricCriterionProjection:
    return RubricCriterionProjection(
        id=criterion_id,
        assessment=assessment,
        critical=critical,
        weight=Decimal("1"),
        score_anchors={1: "Poor", 3: "Adequate", 5: "Excellent"},
        allowed_failure_codes=(failure_code,),
    )


@dataclass(frozen=True)
class FakeInstrument:
    lock: QualityInstrumentLock
    blind_rubric: RubricProjection
    plan_rubric: RubricProjection
    all_criteria: tuple[RubricCriterionProjection, ...]
    policy: AdjudicationPolicy


def _instrument(*, include_explicit_taste: bool = False) -> FakeInstrument:
    rubric_hash = _digest("rubric")
    blind = (
        _criterion(
            "visual_hierarchy",
            assessment="blind_visual",
            critical=True,
            failure_code="weak_visual_hierarchy",
        ),
        _criterion(
            "sequence_rhythm",
            assessment="blind_visual",
            critical=False,
            failure_code="low_sequence_rhythm",
        ),
        *(
            (
                _criterion(
                    "explicit_user_taste_fit",
                    assessment="blind_visual",
                    critical=False,
                    failure_code="explicit_taste_mismatch",
                ),
            )
            if include_explicit_taste
            else ()
        ),
    )
    plan = (
        _criterion(
            "default_look",
            assessment="plan_realization",
            critical=True,
            failure_code="default_look_gravity",
        ),
    )
    policy = AdjudicationPolicy(
        critical_score_floor=3,
        min_weighted_score=Decimal("3.5"),
    )
    lock = QualityInstrumentLock(
        rubric_version="dq1-rubric-test-v1",
        rubric_hash=rubric_hash,
        prompt_hashes={
            "blind_visual": _digest("blind-prompt"),
            "plan_realization": _digest("plan-prompt"),
        },
        judge_plan_hash=_digest("judge-plan"),
        judge_profile_version="quality-test-v1",
        evidence_preprocessor_version="evidence-test-v1",
        judge_invoker_version="invoker-test-v1",
        assessment_schema_versions={
            "blind_visual": "deck-quality-blind-assessment/v4",
            "mechanical": "deck-quality-mechanical-projection/v1",
            "plan_realization": "deck-quality-plan-assessment/v4",
        },
        adjudication_policy_hash=canonical_sha256(policy),
    )
    return FakeInstrument(
        lock=lock,
        blind_rubric=RubricProjection(
            rubric_version=lock.rubric_version,
            rubric_hash=rubric_hash,
            assessment="blind_visual",
            criteria=blind,
        ),
        plan_rubric=RubricProjection(
            rubric_version=lock.rubric_version,
            rubric_hash=rubric_hash,
            assessment="plan_realization",
            criteria=plan,
        ),
        all_criteria=(*blind, *plan),
        policy=policy,
    )


def _mechanics(record_hash: str) -> MechanicalProjection:
    checks = tuple(
        MechanicalCheck(check_id=check_id, status="passed")
        for check_id in (
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
    )
    return MechanicalProjection(
        status="passed",
        checks=checks,
        authoritative_record_hash=record_hash,
    )


def _invocation_metrics(instrument: FakeInstrument, payload_hash: str) -> dict[str, object]:
    return {
        "latency_ms": 50,
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120,
        "deployment_name": "quality-test",
        "provider": "openai",
        "provider_model": "gpt-test",
        "route_name": "deck-quality-judge",
        "profile_version": instrument.lock.judge_profile_version,
        "plan_hash": instrument.lock.judge_plan_hash,
        "preflight_input_tokens": 100,
        "preflight_payload_hash": payload_hash,
        "pricing_version": "test-v1",
        "input_usd_per_million": "1",
        "output_usd_per_million": "1",
        "cost_usd": "0.001",
    }


@dataclass
class EvidenceFixture:
    instrument: FakeInstrument
    artifact: BuildArtifactVersion
    build_manifest: BuildManifest
    request: BlindDeckJudgmentRequest
    row: QualityRunRecord
    objects: dict[str, bytes]
    paths: dict[str, str]


def _fixture(
    *,
    artifact_version_id: str = "artifact-version-initial",
    artifact_created_at: datetime = NOW - timedelta(minutes=1),
    requested_at: datetime = NOW,
    include_explicit_taste: bool = False,
    explicit_style_constraints: tuple[str, ...] = (),
    slide_selectors: tuple[str, ...] = SLIDE_SELECTORS,
) -> EvidenceFixture:
    instrument = _instrument(include_explicit_taste=include_explicit_taste)
    artifact_hash = _digest(artifact_version_id)
    artifact_path = "outputs/psi-deck.pptx"
    artifact = BuildArtifactVersion(
        version_id=artifact_version_id,
        build_id=BUILD_ID,
        logical_artifact_id=LOGICAL_ID,
        manifest_revision=2,
        artifact_path=artifact_path,
        artifact_hash=artifact_hash,
        storage_object_path=(f"artifacts/{USER_ID}/{OWNER_THREAD_ID}/foundation/.builder/builds/{BUILD_ID}/artifacts/{artifact_version_id}/psi-deck.pptx"),
        verified=True,
        created_at=artifact_created_at.isoformat(),
    )
    quality_run_id = derive_quality_run_id(
        artifact_version_id=artifact.version_id,
        campaign_id="DQ-1",
        instrument=instrument.lock,
    )
    root = f"artifacts/{USER_ID}/{THREAD_ID}/foundation/.builder/builds/{BUILD_ID}/quality/{quality_run_id}"
    input_manifest_path = f"{root}/input_bundle/manifest.json"
    input_manifest_hash = _digest("input-manifest")
    mechanical_record = {"status": "passed", "artifact_hash": artifact_hash}
    mechanical_record_hash = canonical_sha256(mechanical_record)
    mechanics = _mechanics(mechanical_record_hash)

    images = tuple(
        ImageEvidence(
            selector=selector,
            path=f"{root}/renders/slide-{index:04d}.png",
            sha256=_digest(f"render-{index}"),
            width=1280,
            height=720,
        )
        for index, selector in enumerate(slide_selectors, start=1)
    )
    contact = ImageEvidence(
        selector="contact-sheet",
        path=f"{root}/renders/contact-sheet.png",
        sha256=_digest("contact-sheet"),
        width=1280,
        height=1440,
    )
    renders = RenderEvidence(
        expected_slide_count=len(slide_selectors),
        contact_sheet=contact,
        slides=images,
        selectors=slide_selectors,
    )
    visible_text = tuple(
        VisibleTextSlide(
            selector=selector,
            text=f"PSI semantic content {index}",
            source_hash=_digest(f"visible-text-{index}"),
        )
        for index, selector in enumerate(slide_selectors, start=1)
    )
    brief = BlindBrief(
        request="Build a five-slide PSI production deck.",
        subject="Progressive summarization interface",
        audience="Product and engineering leaders",
        goal="Explain the control loop",
        explicit_brand_style_constraints=explicit_style_constraints,
    )
    creative_plan: dict[str, Any] = {}
    design_plan: dict[str, Any] = {"anti_slop_profile": ["Resist generic technology-deck defaults"]}
    snapshot = QualityEvidenceSnapshot(
        campaign_id="DQ-1",
        build_id=BUILD_ID,
        user_id=USER_ID,
        task_id=TASK_ID,
        builder_run_id=BUILDER_RUN_ID,
        parent_builder_trace_id=BUILDER_TRACE_ID,
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=artifact.version_id,
        manifest_revision=artifact.manifest_revision,
        artifact_path=artifact_path,
        artifact_hash=artifact_hash,
        brief_hash=canonical_sha256(brief),
        creative_plan_hash=canonical_sha256(creative_plan),
        design_plan_hash=canonical_sha256(design_plan),
        brief=brief,
        renders=renders,
        visible_text=visible_text,
        creative_plan=creative_plan,
        design_plan=design_plan,
        mechanical_record=mechanical_record,
        mechanical_record_hash=mechanical_record_hash,
    )
    immutable_artifact_path = immutable_builder_artifact_object_path(
        user_id=USER_ID,
        thread_or_session_id=THREAD_ID,
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=artifact.version_id,
        artifact_sha256=artifact_hash,
        filename="psi-deck.pptx",
    )
    artifact_reference = SnapshotArtifactReference(
        virtual_path=artifact_path,
        storage_object_path=immutable_artifact_path,
        sha256=artifact_hash,
        size_bytes=1024,
    )
    build_record = {"build_id": BUILD_ID, "slide_count": len(slide_selectors)}
    bundle = SnapshotEvidenceBundle(
        quality_run_id=quality_run_id,
        thread_id=THREAD_ID,
        artifact=artifact_reference,
        build_record=build_record,
        snapshot=snapshot,
    )
    bundle_bytes = canonical_json_bytes(bundle)
    bundle_hash = _digest_bytes(bundle_bytes)
    bundle_path = f"{root}/evidence_bundle.json"
    render_pdf = RenderSourcePdfReference(
        object_path=f"{root}/render_source/objects/{_digest('pdf')}.pdf",
        sha256=_digest("pdf"),
        size_bytes=100,
        page_count=len(slide_selectors),
    )
    render_source = RenderSourceReference(
        manifest_path=f"{root}/render_source/manifest.json",
        manifest_hash=_digest("render-source-manifest"),
        pdf=render_pdf,
    )
    object_records = tuple(
        SnapshotObjectRecord(
            role="render",
            object_path=image.path,
            sha256=image.sha256,
            size_bytes=100,
            media_type="image/png",
        )
        for image in images
    ) + (
        SnapshotObjectRecord(
            role="contact_sheet",
            object_path=contact.path,
            sha256=contact.sha256,
            size_bytes=200,
            media_type="image/png",
        ),
        SnapshotObjectRecord(
            role="evidence_bundle",
            object_path=bundle_path,
            sha256=bundle_hash,
            size_bytes=len(bundle_bytes),
            media_type="application/json",
        ),
    )
    evidence_manifest = SnapshotEvidenceManifest(
        quality_run_id=quality_run_id,
        snapshot_id=quality_run_id,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        task_id=TASK_ID,
        builder_run_id=BUILDER_RUN_ID,
        parent_builder_trace_id=BUILDER_TRACE_ID,
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=artifact.version_id,
        artifact_manifest_revision=artifact.manifest_revision,
        input_manifest_path=input_manifest_path,
        input_manifest_hash=input_manifest_hash,
        artifact=artifact_reference,
        render_source=render_source,
        selectors=slide_selectors,
        source_hashes=SnapshotSourceHashes(
            input_manifest=input_manifest_hash,
            artifact=artifact_hash,
            render_source_manifest=render_source.manifest_hash,
            render_source_pdf=render_pdf.sha256,
            brief=snapshot.brief_hash,
            creative_plan=snapshot.creative_plan_hash,
            design_plan=snapshot.design_plan_hash,
            build_record=canonical_sha256(build_record),
            mechanical_record=mechanical_record_hash,
            visible_text=canonical_sha256(visible_text),
        ),
        render_hashes={
            **{str(image.selector): image.sha256 for image in images},
            "contact-sheet": contact.sha256,
        },
        objects=object_records,
        evidence_bundle_path=bundle_path,
        evidence_bundle_hash=bundle_hash,
    )
    evidence_manifest_bytes = canonical_json_bytes(evidence_manifest)
    evidence_manifest_hash = _digest_bytes(evidence_manifest_bytes)
    evidence_manifest_path = f"{root}/evidence_manifest.json"

    visual = BlindVisualAssessment(
        coverage_confirmed=True,
        evaluated_selectors=slide_selectors,
        overall_impression="The hierarchy and sequence remain too generic.",
        deck_failure_codes=("weak_visual_hierarchy", "low_sequence_rhythm"),
        slide_findings=(
            EvidenceFinding(
                code="weak_visual_hierarchy",
                observation="The primary claim does not lead the eye.",
                evidence_selectors=("slide:1",),
            ),
            EvidenceFinding(
                code="low_sequence_rhythm",
                observation="The second beat repeats the opening composition.",
                evidence_selectors=("slide:2",),
            ),
            EvidenceFinding(
                code="weak_visual_hierarchy",
                observation="The fourth beat also lacks a decisive lead.",
                evidence_selectors=("slide:4",),
            ),
        ),
        criterion_scores=(
            CriterionScore(
                criterion_id="visual_hierarchy",
                applicable=True,
                score=2,
                rationale="Hierarchy is weak.",
                evidence_selectors=("slide:1",),
            ),
            CriterionScore(
                criterion_id="sequence_rhythm",
                applicable=True,
                score=2,
                rationale="Rhythm repeats.",
                evidence_selectors=("slide:2",),
            ),
            *(
                (
                    CriterionScore(
                        criterion_id="explicit_user_taste_fit",
                        applicable=True,
                        score=5,
                        rationale="The explicit style direction is honored.",
                        evidence_selectors=("slide:1",),
                    ),
                )
                if include_explicit_taste and explicit_style_constraints
                else ()
            ),
        ),
        confidence=0.9,
    )
    plan_inputs = derive_plan_realization_inputs(
        creative_plan=creative_plan,
        design_plan=design_plan,
        selectors=slide_selectors,
        explicit_style_constraints=brief.explicit_brand_style_constraints,
    )
    assert tuple(item.commitment_id for item in plan_inputs.commitments) == ("default-look-resistance",)
    plan = PlanRealizationAssessment(
        evaluated_selectors=slide_selectors,
        commitments=(
            CommitmentRealization(
                commitment_id="default-look-resistance",
                dimension="default_look",
                status="not_realized",
                observation="The generic card system overrides the PSI mechanism.",
                evidence_selectors=slide_selectors,
            ),
        ),
        criterion_scores=(
            CriterionScore(
                criterion_id="default_look",
                applicable=True,
                score=2,
                rationale="The visual system remains transferable.",
                evidence_selectors=("slide:3",),
            ),
        ),
        failure_codes=("default_look_gravity",),
        confidence=0.9,
    )
    decision = adjudicate_shadow_result(
        coverage=prove_coverage(snapshot, visual),
        visual=visual,
        mechanical=mechanics,
        plan=plan,
        criteria=brief_scoped_criteria(instrument.all_criteria, brief),
        expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
        rubric_hash=instrument.blind_rubric.rubric_hash,
        policy=instrument.policy,
    )
    assert decision.result == "needs_revision"

    a_input_hash = canonical_sha256(
        {
            "evidence_bundle_hash": bundle_hash,
            "rubric_hash": instrument.blind_rubric.rubric_hash,
            "prompt_hash": instrument.lock.prompt_hashes["blind_visual"],
            "judge_plan_hash": instrument.lock.judge_plan_hash,
        }
    )
    b_input_hash = canonical_sha256(
        {
            "mechanical_record_hash": mechanical_record_hash,
            "artifact_hash": artifact_hash,
        }
    )
    c_input_hash = canonical_sha256(
        {
            "evidence_bundle_hash": bundle_hash,
            "rubric_hash": instrument.plan_rubric.rubric_hash,
            "prompt_hash": instrument.lock.prompt_hashes["plan_realization"],
            "judge_plan_hash": instrument.lock.judge_plan_hash,
        }
    )
    a_preflight_hash = _digest("a-preflight")
    c_preflight_hash = _digest("c-preflight")
    a_intent_hash = _digest("a-intent")
    c_intent_hash = _digest("c-intent")
    visual_stage = _AssessmentAArtifact(
        input_hash=a_input_hash,
        status="completed",
        provider_call_made=True,
        call_intent_hash=a_intent_hash,
        preflight={"input_tokens": 100, "payload_hash": a_preflight_hash},
        plan_preflight={
            "input_tokens": 100,
            "payload_hash": _digest("plan-preflight"),
        },
        assessment=visual,
        metrics=_invocation_metrics(instrument, a_preflight_hash),
    )
    mechanical_stage = _MechanicalArtifact(
        input_hash=b_input_hash,
        projection=mechanics,
    )
    plan_stage = _AssessmentCArtifact(
        input_hash=c_input_hash,
        status="completed",
        provider_call_made=True,
        call_intent_hash=c_intent_hash,
        preflight={"input_tokens": 100, "payload_hash": c_preflight_hash},
        assessment=plan,
        metrics=_invocation_metrics(instrument, c_preflight_hash),
    )
    stage_models = {
        "assessment_a_visual": visual_stage,
        "assessment_b_mechanical": mechanical_stage,
        "assessment_c_plan_realization": plan_stage,
        "decision": decision,
    }
    stage_bytes = {key: canonical_json_bytes(value) for key, value in stage_models.items()}
    stage_paths = {
        key: f"{root}/{filename}"
        for key, filename in (
            ("assessment_a_visual", "assessment_a_visual.json"),
            ("assessment_b_mechanical", "assessment_b_mechanical.json"),
            ("assessment_c_plan_realization", "assessment_c_plan_realization.json"),
            ("decision", "decision.json"),
        )
    }
    stage_hashes = {key: _digest_bytes(value) for key, value in stage_bytes.items()}
    stage_hashes.update(
        {
            "source_snapshot": _digest("source-snapshot"),
            "evidence_manifest": evidence_manifest_hash,
            "assessment_a_call_intent": a_intent_hash,
            "assessment_c_call_intent": c_intent_hash,
            "safe_metrics": _digest("safe-metrics"),
            "run": _digest("run"),
        }
    )
    root_trace_id = "quality-root-run"
    trace_ids = {key: (root_trace_id if key in {"quality_trace_id", "quality_root_run_id"} else f"trace-{index}") for index, key in enumerate(sorted(REQUIRED_TRACE_ID_KEYS), start=1)}
    safe_root = SafeQualityTraceRootInput(
        campaign_id="DQ-1",
        quality_run_id=quality_run_id,
        build_id=BUILD_ID,
        task_id=TASK_ID,
        builder_run_id=BUILDER_RUN_ID,
        parent_builder_run_id=BUILDER_RUN_ID,
        parent_builder_trace_id=BUILDER_TRACE_ID,
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=artifact.version_id,
        manifest_revision=artifact.manifest_revision,
        artifact_hash=artifact_hash,
        rubric_version=instrument.lock.rubric_version,
        rubric_hash=instrument.lock.rubric_hash,
        judge_deployment="quality-test",
        judge_provider="openai",
        judge_model="gpt-test",
        judge_profile_version=instrument.lock.judge_profile_version,
        judge_plan_hash=instrument.lock.judge_plan_hash,
        evidence_preprocessor_version=instrument.lock.evidence_preprocessor_version,
        source_commit_sha="1" * 40,
        gateway_deployed_sha="2" * 40,
        langgraph_deployed_sha="3" * 40,
    ).model_dump(mode="json")
    row = QualityRunRecord(
        quality_run_id=quality_run_id,
        campaign_id="DQ-1",
        scope_kind="canary",
        instrument_schema_version=instrument.lock.schema_version,
        instrument_identity_hash=canonical_sha256(instrument.lock),
        rubric_version=instrument.lock.rubric_version,
        rubric_hash=instrument.lock.rubric_hash,
        prompt_hashes=instrument.lock.prompt_hashes,
        judge_plan_hash=instrument.lock.judge_plan_hash,
        judge_profile_version=instrument.lock.judge_profile_version,
        evidence_preprocessor_version=instrument.lock.evidence_preprocessor_version,
        judge_invoker_version=instrument.lock.judge_invoker_version,
        assessment_schema_versions=instrument.lock.assessment_schema_versions,
        adjudication_policy_hash=instrument.lock.adjudication_policy_hash,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        task_id=TASK_ID,
        build_id=BUILD_ID,
        builder_run_id=BUILDER_RUN_ID,
        parent_builder_trace_id=BUILDER_TRACE_ID,
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=artifact.version_id,
        manifest_revision=artifact.manifest_revision,
        artifact_hash=artifact_hash,
        input_manifest_object_path=input_manifest_path,
        input_manifest_hash=input_manifest_hash,
        evidence_manifest_object_path=evidence_manifest_path,
        evidence_manifest_hash=evidence_manifest_hash,
        state="completed",
        stage=QualityRunStage.PERSISTED_AND_TRACED,
        stage_rank=STAGE_RANK[QualityRunStage.PERSISTED_AND_TRACED],
        attempt_count=1,
        max_attempts=5,
        error_count=0,
        next_attempt_at=requested_at,
        run_deadline_at=requested_at + timedelta(minutes=10),
        trace_deadline_at=requested_at + timedelta(minutes=12),
        lease_epoch=1,
        completion_owner="worker-0001",
        completion_token=1,
        decision_result=decision.result,
        decision_failure_codes=decision.failure_codes,
        decision_weighted_score=decision.weighted_score,
        safe_metrics={
            "slide_count": len(slide_selectors),
            "coverage_complete": True,
        },
        trace_ids=trace_ids,
        stage_artifact_hashes=stage_hashes,
        safe_trace_root_input=safe_root,
        safe_trace_root_input_hash=safe_trace_root_input_hash(safe_root),
        requested_at=requested_at,
        started_at=requested_at,
        updated_at=requested_at + timedelta(seconds=20),
        finished_at=requested_at + timedelta(seconds=20),
    )
    components = [
        BuildComponent(
            id=f"component-{index}",
            selector=selector,
            type="slide",
            index=index - 1,
            source_path=f"deck_build/slides/slide-{index:04d}.html",
            status="gated",
            current_version_id=f"component-version-{index}",
            source_roles={
                "body": f"deck_build/slides/slide-{index:04d}.body.html",
                "slide_css": f"deck_build/slides/slide-{index:04d}.css",
            },
        )
        for index, selector in enumerate(slide_selectors, start=1)
    ]
    build_manifest = BuildManifest(
        manifest_revision=artifact.manifest_revision,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=OWNER_THREAD_ID,
        format="pptx",
        status="complete",
        logical_artifact_id=LOGICAL_ID,
        current_artifact_version_id=artifact.version_id,
        deliverable_path=artifact.artifact_path,
        components=components,
        format_extensions={"deck": {"current_pptx_hash": artifact.artifact_hash}},
    )
    request = BlindDeckJudgmentRequest(
        campaign_run_id="campaign-run-0001",
        experiment_id="experiment-0001",
        build_id=BUILD_ID,
        artifact=artifact,
        mechanics=mechanics,
    )
    objects = {
        evidence_manifest_path: evidence_manifest_bytes,
        bundle_path: bundle_bytes,
        **{stage_paths[key]: content for key, content in stage_bytes.items()},
    }
    return EvidenceFixture(
        instrument=instrument,
        artifact=artifact,
        build_manifest=build_manifest,
        request=request,
        row=row,
        objects=objects,
        paths={
            "evidence_manifest": evidence_manifest_path,
            "evidence_bundle": bundle_path,
            **stage_paths,
        },
    )


def _digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class FakeStore:
    def __init__(self, responses: list[QualityRunRecord | None]) -> None:
        self.responses = list(responses)
        self.calls: list[str] = []

    async def get(self, quality_run_id: str) -> QualityRunRecord | None:
        self.calls.append(quality_run_id)
        if len(self.responses) > 1:
            return self.responses.pop(0)
        return self.responses[0]


class FakeObjects:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.calls: list[tuple[str, int]] = []
        self.raise_for: str | None = None

    async def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        self.calls.append((object_path, max_bytes))
        if object_path == self.raise_for:
            raise RuntimeError("raw provider body and secret must not escape")
        return self.objects.get(object_path)


class FakeManifests:
    def __init__(self, manifest: BuildManifest) -> None:
        self.manifest = manifest
        self.calls: list[str] = []

    async def load_for_artifact(self, artifact: BuildArtifactVersion) -> BuildManifest:
        self.calls.append(artifact.version_id)
        return self.manifest


class FakeClock:
    def __init__(self, now: datetime = NOW + timedelta(minutes=1)) -> None:
        self.now = now
        self.sleeps: list[float] = []

    def __call__(self) -> datetime:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += timedelta(seconds=seconds)


def _adapter(
    fixture: EvidenceFixture,
    *,
    responses: list[QualityRunRecord | None] | None = None,
    objects: FakeObjects | None = None,
    manifests: FakeManifests | None = None,
    clock: FakeClock | None = None,
    timeout: float = 5,
    interval: float = 1,
) -> tuple[
    DurableDeckQualityEvidenceAdapter,
    FakeStore,
    FakeObjects,
    FakeManifests,
    FakeClock,
]:
    store = FakeStore(responses or [fixture.row])
    object_reader = objects or FakeObjects(fixture.objects)
    manifest_loader = manifests or FakeManifests(fixture.build_manifest)
    fake_clock = clock or FakeClock()
    return (
        DurableDeckQualityEvidenceAdapter(
            store=store,
            objects=object_reader,
            instrument=fixture.instrument,
            manifests=manifest_loader,
            clock=fake_clock,
            sleep=fake_clock.sleep,
            candidate_timeout_seconds=timeout,
            poll_interval_seconds=interval,
            skill_excerpts=load_committed_skill_excerpts(),
        ),
        store,
        object_reader,
        manifest_loader,
        fake_clock,
    )


def _v46_shaped_compiler_snapshot(
    adapter: DurableDeckQualityEvidenceAdapter,
    verified: Any,
    *,
    readability_selector: str = "slide:3",
    readability_last: bool = False,
) -> Any:
    readability = _criterion(
        "rendered_readability",
        assessment="blind_visual",
        critical=True,
        failure_code="rendered_readability_failure",
    )
    closing = _criterion(
        "closing_synthesis",
        assessment="blind_visual",
        critical=True,
        failure_code="weak_closing_synthesis",
    )
    subject = _criterion(
        "subject_specificity",
        assessment="blind_visual",
        critical=True,
        failure_code="weak_subject_specificity",
    )
    default_look = _criterion(
        "default_look",
        assessment="plan_realization",
        critical=True,
        failure_code="default_look_gravity",
    )
    mechanism = _criterion(
        "mechanism_visualization",
        assessment="blind_visual",
        critical=False,
        failure_code="weak_mechanism_visualization",
    )
    criteria = (
        (closing, subject, default_look, readability, mechanism)
        if readability_last
        else (readability, closing, subject, default_look, mechanism)
    )
    adapter._instrument = replace(  # noqa: SLF001 - focused compiler boundary test
        adapter._instrument,  # noqa: SLF001 - focused compiler boundary test
        all_criteria=criteria,
    )
    visual = verified.visual.model_copy(
        update={
            "deck_failure_codes": (
                "rendered_readability_failure",
                "weak_closing_synthesis",
                "weak_mechanism_visualization",
                "weak_subject_specificity",
            ),
            "slide_findings": (
                EvidenceFinding(
                    code="weak_mechanism_visualization",
                    observation="The control loop remains a linear rail.",
                    evidence_selectors=("slide:2",),
                ),
                EvidenceFinding(
                    code="weak_closing_synthesis",
                    observation="The closing question is visually subordinate.",
                    evidence_selectors=("slide:5",),
                ),
                EvidenceFinding(
                    code="rendered_readability_failure",
                    observation="Scenario labels are occluded by their bars.",
                    evidence_selectors=(readability_selector,),
                ),
                EvidenceFinding(
                    code="weak_subject_specificity",
                    observation="The opening claim remains transferable.",
                    evidence_selectors=("slide:1",),
                ),
            ),
            "criterion_scores": (
                CriterionScore(
                    criterion_id="rendered_readability",
                    applicable=True,
                    score=1,
                    rationale="Labels are not legible.",
                    evidence_selectors=(readability_selector,),
                ),
                CriterionScore(
                    criterion_id="closing_synthesis",
                    applicable=True,
                    score=2,
                    rationale="The final synthesis is weak.",
                    evidence_selectors=("slide:5",),
                ),
                CriterionScore(
                    criterion_id="subject_specificity",
                    applicable=True,
                    score=2,
                    rationale="The opening is generic.",
                    evidence_selectors=("slide:1",),
                ),
                CriterionScore(
                    criterion_id="mechanism_visualization",
                    applicable=True,
                    score=2,
                    rationale="The mechanism remains linear.",
                    evidence_selectors=("slide:2",),
                ),
            ),
        }
    )
    plan = verified.plan.model_copy(
        update={
            "criterion_scores": (
                CriterionScore(
                    criterion_id="default_look",
                    applicable=True,
                    score=2,
                    rationale="The visual system remains transferable.",
                    evidence_selectors=("slide:3",),
                ),
            ),
        }
    )
    decision = verified.decision.model_copy(
        update={
            "failure_codes": tuple(
                sorted(
                    {
                        *visual.deck_failure_codes,
                        *plan.failure_codes,
                    }
                )
            ),
            "evidence_selectors": (
                "slide:1",
                "slide:2",
                "slide:3",
                "slide:4",
                "slide:5",
            ),
        }
    )
    return replace(
        verified,
        visual=visual,
        plan=plan,
        decision=decision,
    )


@pytest.mark.parametrize(
    "failure_code",
    (
        "weak_audience_fit",
        "weak_closing_synthesis",
        "weak_forward_momentum",
        "weak_narrative_arc",
        "weak_narrative_pacing",
        "weak_subject_specificity",
    ),
)
def test_narrative_findings_authorize_the_slide_css_repair_channel(
    failure_code: str,
) -> None:
    roles = DurableDeckQualityEvidenceAdapter._requested_roles(  # noqa: SLF001
        component_source_path="components/slide-1/body.html",
        component_source_roles={
            "body": "components/slide-1/body.html",
            "slide_css": "components/slide-1/slide.css",
            "notes": "components/slide-1/notes.txt",
        },
        failure_code=failure_code,
    )

    assert roles == ("body", "slide_css")


@pytest.mark.anyio
async def test_initial_projects_completed_dq1_and_compiles_three_local_findings() -> None:
    fixture = _fixture()
    adapter, store, objects, _manifests, _clock = _adapter(fixture)

    result = await adapter.judge_initial(fixture.request)

    assert result.evidence.verdict == "needs_revision"
    assert result.evidence.weighted_score == Decimal("2")
    scores = {score.criterion_id: score for score in result.evidence.criterion_scores}
    assert scores["visual_hierarchy"].critical is True
    assert scores["visual_hierarchy"].failed is True
    assert scores["sequence_rhythm"].critical is False
    assert result.evidence.critical_failure_codes == (
        "default_look_gravity",
        "weak_visual_hierarchy",
    )
    assert tuple(dict.fromkeys(finding.target_selector for finding in result.findings)) == (
        "slide:1",
        "slide:3",
        "slide:2",
    )
    assert {finding.failure_code for finding in result.findings} == {
        "default_look_gravity",
        "low_sequence_rhythm",
        "weak_visual_hierarchy",
    }
    assert all(not finding.render_evidence[0].path.startswith("/") for finding in result.findings)
    assert all("/quality/" in finding.render_evidence[0].path for finding in result.findings)
    authenticated_manifest = SnapshotEvidenceManifest.model_validate_json(fixture.objects[fixture.paths["evidence_manifest"]])
    render_inventory = {item.object_path: item.sha256 for item in authenticated_manifest.objects if item.role == "render"}
    assert all(render_inventory[finding.render_evidence[0].path] == finding.render_evidence[0].sha256 for finding in result.findings)
    assert len(store.calls) == 1
    assert {path for path, _limit in objects.calls} == set(fixture.paths.values())


@pytest.mark.anyio
async def test_adapter_excludes_explicit_taste_for_empty_structured_constraints() -> None:
    fixture = _fixture(include_explicit_taste=True)
    adapter, *_ = _adapter(fixture)

    result = await adapter.judge_initial(fixture.request)

    assert {
        score.criterion_id for score in result.evidence.criterion_scores
    } == {
        "visual_hierarchy",
        "sequence_rhythm",
        "default_look",
    }
    assert result.evidence.weighted_score == Decimal("2")


@pytest.mark.anyio
async def test_adapter_includes_explicit_taste_for_nonempty_structured_constraints() -> None:
    fixture = _fixture(
        include_explicit_taste=True,
        explicit_style_constraints=("Use a restrained blue palette.",),
    )
    adapter, *_ = _adapter(fixture)

    result = await adapter.judge_initial(fixture.request)

    assert {
        score.criterion_id for score in result.evidence.criterion_scores
    } == {
        "visual_hierarchy",
        "sequence_rhythm",
        "explicit_user_taste_fit",
        "default_look",
    }
    assert result.evidence.weighted_score == Decimal("2.75")


@pytest.mark.anyio
async def test_findings_and_skill_hashes_are_deterministic() -> None:
    fixture = _fixture()
    first, *_ = _adapter(fixture)
    second, *_ = _adapter(fixture)

    first_result = await first.judge_initial(fixture.request)
    second_result = await second.judge_initial(fixture.request)

    assert first_result.findings == second_result.findings
    catalog = {item.ref.path: item for item in first.skill_excerpts}
    for finding in first_result.findings:
        for ref in finding.skill_refs:
            locked = catalog[ref.path]
            assert locked.ref == ref
            assert _digest_bytes(locked.text.encode()) == ref.excerpt_hash


@pytest.mark.anyio
async def test_public_snapshot_contains_authenticated_durable_object_inventory() -> None:
    fixture = _fixture()
    adapter, *_ = _adapter(fixture)

    snapshot = await adapter.load_initial_snapshot(fixture.request)

    assert snapshot.row.quality_run_id == fixture.row.quality_run_id
    assert snapshot.manifest.current_artifact_version_id == fixture.artifact.version_id
    render_paths = {item.object_path for item in snapshot.evidence_manifest.objects if item.role in {"render", "contact_sheet"}}
    assert render_paths == {image.path for image in snapshot.evidence_bundle.snapshot.renders.slides} | {snapshot.evidence_bundle.snapshot.renders.contact_sheet.path}


@pytest.mark.anyio
async def test_completed_initial_mechanics_load_has_no_circular_request_dependency() -> None:
    fixture = _fixture()
    adapter, *_ = _adapter(fixture)

    mechanics = await adapter.load_completed_mechanics(fixture.artifact)

    assert mechanics == fixture.request.mechanics


@pytest.mark.anyio
async def test_candidate_polls_boundedly_and_reads_only_candidate_run() -> None:
    fixture = _fixture(artifact_version_id="artifact-version-candidate")
    adapter, store, objects, _manifests, clock = _adapter(
        fixture,
        responses=[None, None, fixture.row],
    )

    result = await adapter.judge_candidate(fixture.request)

    assert result.quality_run_id == fixture.row.quality_run_id
    assert store.calls == [fixture.row.quality_run_id] * 3
    assert clock.sleeps == [1, 1]
    assert all(fixture.row.quality_run_id in path for path, _limit in objects.calls)


@pytest.mark.anyio
async def test_initial_requires_an_already_completed_run_without_polling() -> None:
    fixture = _fixture()
    adapter, store, *_ = _adapter(fixture, responses=[None])

    with pytest.raises(DeckQualityEvidenceAdapterError, match="initial_quality_run_unavailable"):
        await adapter.judge_initial(fixture.request)

    assert store.calls == [fixture.row.quality_run_id]


@pytest.mark.anyio
async def test_candidate_timeout_is_bounded() -> None:
    fixture = _fixture(artifact_version_id="artifact-version-timeout")
    adapter, store, _objects, _manifests, clock = _adapter(
        fixture,
        responses=[None],
        timeout=2.5,
        interval=1,
    )

    with pytest.raises(DeckQualityEvidenceAdapterError, match="candidate_quality_run_timeout"):
        await adapter.judge_candidate(fixture.request)

    assert clock.sleeps == [1, 1, 0.5]
    assert len(store.calls) == 4


@pytest.mark.anyio
async def test_candidate_rejects_a_run_requested_before_candidate_creation() -> None:
    fixture = _fixture(
        artifact_version_id="artifact-version-stale",
        artifact_created_at=NOW + timedelta(seconds=10),
        requested_at=NOW,
    )
    adapter, *_ = _adapter(fixture)

    with pytest.raises(DeckQualityEvidenceAdapterError, match="candidate_quality_run_not_fresh"):
        await adapter.judge_candidate(fixture.request)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("row_update", "manifest_update", "expected"),
    [
        ({"user_id": "other-user"}, {}, "quality_run_identity_mismatch"),
        ({"artifact_hash": "f" * 64}, {}, "quality_run_identity_mismatch"),
        (
            {"thread_id": "other-parent", "task_id": "other-builder"},
            {},
            "quality_run_identity_mismatch",
        ),
        ({}, {"manifest_revision": 3}, "artifact_manifest_identity_mismatch"),
    ],
)
async def test_wrong_scope_revision_or_artifact_hash_fails_closed(
    row_update: dict[str, object],
    manifest_update: dict[str, object],
    expected: str,
) -> None:
    fixture = _fixture()
    row = fixture.row.model_copy(update=row_update)
    manifest = fixture.build_manifest.model_copy(update=manifest_update, deep=True)
    adapter, *_ = _adapter(
        fixture,
        responses=[row],
        manifests=FakeManifests(manifest),
    )

    with pytest.raises(DeckQualityEvidenceAdapterError, match=expected):
        await adapter.judge_initial(fixture.request)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "path_key",
    [
        "evidence_manifest",
        "evidence_bundle",
        "assessment_a_visual",
        "assessment_b_mechanical",
        "assessment_c_plan_realization",
        "decision",
    ],
)
async def test_every_required_object_hash_is_checked(path_key: str) -> None:
    fixture = _fixture()
    objects = FakeObjects(fixture.objects)
    objects.objects[fixture.paths[path_key]] += b" "
    adapter, *_ = _adapter(fixture, objects=objects)

    with pytest.raises(DeckQualityEvidenceAdapterError, match="quality_object_hash_mismatch"):
        await adapter.judge_initial(fixture.request)


@pytest.mark.anyio
async def test_canonical_json_is_required_even_when_hash_checkpoint_is_changed() -> None:
    fixture = _fixture()
    decision_path = fixture.paths["decision"]
    pretty = json.dumps(json.loads(fixture.objects[decision_path]), indent=2).encode()
    row = fixture.row.model_copy(
        update={
            "stage_artifact_hashes": {
                **fixture.row.stage_artifact_hashes,
                "decision": _digest_bytes(pretty),
            }
        }
    )
    objects = FakeObjects({**fixture.objects, decision_path: pretty})
    adapter, *_ = _adapter(fixture, responses=[row], objects=objects)

    with pytest.raises(DeckQualityEvidenceAdapterError, match="quality_object_not_canonical"):
        await adapter.judge_initial(fixture.request)


@pytest.mark.anyio
async def test_malformed_json_is_reduced_to_a_content_free_code() -> None:
    fixture = _fixture()
    decision_path = fixture.paths["decision"]
    malformed = b"{}"
    row = fixture.row.model_copy(
        update={
            "stage_artifact_hashes": {
                **fixture.row.stage_artifact_hashes,
                "decision": _digest_bytes(malformed),
            }
        }
    )
    objects = FakeObjects({**fixture.objects, decision_path: malformed})
    adapter, *_ = _adapter(fixture, responses=[row], objects=objects)

    with pytest.raises(DeckQualityEvidenceAdapterError) as caught:
        await adapter.judge_initial(fixture.request)

    assert caught.value.code == "quality_object_malformed"
    assert str(caught.value) == "quality_object_malformed"


@pytest.mark.anyio
async def test_oversize_reader_response_is_rejected_even_if_reader_ignores_ceiling() -> None:
    fixture = _fixture()
    objects = FakeObjects(fixture.objects)
    objects.objects[fixture.paths["evidence_manifest"]] = b"x" * (2 * 1024 * 1024 + 1)
    adapter, *_ = _adapter(fixture, objects=objects)

    with pytest.raises(
        DeckQualityEvidenceAdapterError,
        match="quality_object_oversized_or_invalid",
    ):
        await adapter.judge_initial(fixture.request)


@pytest.mark.anyio
async def test_object_reader_exception_does_not_expose_raw_evidence_or_secret() -> None:
    fixture = _fixture()
    objects = FakeObjects(fixture.objects)
    objects.raise_for = fixture.paths["assessment_a_visual"]
    adapter, *_ = _adapter(fixture, objects=objects)

    with pytest.raises(DeckQualityEvidenceAdapterError) as caught:
        await adapter.judge_initial(fixture.request)

    assert caught.value.code == "quality_object_unavailable"
    assert "secret" not in str(caught.value)
    assert caught.value.__cause__ is None


@pytest.mark.anyio
async def test_supplied_mechanics_must_exactly_match_persisted_projection() -> None:
    fixture = _fixture()
    wrong_request = fixture.request.model_copy(update={"mechanics": _mechanics(_digest("other-mechanical-record"))})
    adapter, *_ = _adapter(fixture)

    with pytest.raises(DeckQualityEvidenceAdapterError, match="quality_stage_input_mismatch"):
        await adapter.judge_initial(wrong_request)


@pytest.mark.anyio
async def test_decision_is_recomputed_from_persisted_assessments() -> None:
    fixture = _fixture()
    decision_path = fixture.paths["decision"]
    decision_payload = json.loads(fixture.objects[decision_path])
    decision_payload["failure_codes"] = ["weak_visual_hierarchy"]
    changed = json.dumps(
        decision_payload,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    row = fixture.row.model_copy(
        update={
            "stage_artifact_hashes": {
                **fixture.row.stage_artifact_hashes,
                "decision": _digest_bytes(changed),
            },
            "decision_failure_codes": ("weak_visual_hierarchy",),
        }
    )
    objects = FakeObjects({**fixture.objects, decision_path: changed})
    adapter, *_ = _adapter(fixture, responses=[row], objects=objects)

    with pytest.raises(DeckQualityEvidenceAdapterError, match="quality_decision_mismatch"):
        await adapter.judge_initial(fixture.request)


@pytest.mark.anyio
async def test_persisted_six_decimal_score_authenticates_repeating_decision() -> None:
    fixture = _fixture()
    visual_path = fixture.paths["assessment_a_visual"]
    decision_path = fixture.paths["decision"]
    visual_stage = _AssessmentAArtifact.model_validate_json(fixture.objects[visual_path])
    assert visual_stage.assessment is not None
    scores = list(visual_stage.assessment.criterion_scores)
    scores[0] = scores[0].model_copy(update={"score": 3})
    visual = visual_stage.assessment.model_copy(update={"criterion_scores": tuple(scores)})
    changed_visual = canonical_json_bytes(visual_stage.model_copy(update={"assessment": visual}))

    bundle = SnapshotEvidenceBundle.model_validate_json(fixture.objects[fixture.paths["evidence_bundle"]])
    mechanical_stage = _MechanicalArtifact.model_validate_json(fixture.objects[fixture.paths["assessment_b_mechanical"]])
    plan_stage = _AssessmentCArtifact.model_validate_json(fixture.objects[fixture.paths["assessment_c_plan_realization"]])
    assert plan_stage.assessment is not None
    plan_inputs = derive_plan_realization_inputs(
        creative_plan=bundle.snapshot.creative_plan,
        design_plan=bundle.snapshot.design_plan,
        selectors=tuple(str(item) for item in bundle.snapshot.renders.selectors),
        explicit_style_constraints=bundle.snapshot.brief.explicit_brand_style_constraints,
    )
    decision = adjudicate_shadow_result(
        coverage=prove_coverage(bundle.snapshot, visual),
        visual=visual,
        mechanical=mechanical_stage.projection,
        plan=plan_stage.assessment,
        criteria=fixture.instrument.all_criteria,
        expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
        rubric_hash=fixture.instrument.blind_rubric.rubric_hash,
        policy=fixture.instrument.policy,
    )
    assert decision.weighted_score == Decimal(7) / Decimal(3)
    changed_decision = canonical_json_bytes(decision)
    persisted_score = Decimal("2.333333")
    row = fixture.row.model_copy(
        update={
            "decision_result": QualityRunDecision(decision.result),
            "decision_failure_codes": decision.failure_codes,
            "decision_weighted_score": persisted_score,
            "stage_artifact_hashes": {
                **fixture.row.stage_artifact_hashes,
                "assessment_a_visual": _digest_bytes(changed_visual),
                "decision": _digest_bytes(changed_decision),
            },
        }
    )
    objects = FakeObjects(
        {
            **fixture.objects,
            visual_path: changed_visual,
            decision_path: changed_decision,
        }
    )
    adapter, *_ = _adapter(fixture, responses=[row], objects=objects)

    result = await adapter.judge_initial(fixture.request)

    assert result.evidence.weighted_score == decision.weighted_score


@pytest.mark.anyio
async def test_render_inventory_triplet_must_match_the_bundle() -> None:
    fixture = _fixture()
    manifest_path = fixture.paths["evidence_manifest"]
    manifest = SnapshotEvidenceManifest.model_validate_json(fixture.objects[manifest_path])
    records = list(manifest.objects)
    records[0] = records[0].model_copy(update={"sha256": _digest("substituted-render")})
    changed = canonical_json_bytes(manifest.model_copy(update={"objects": tuple(records)}))
    changed_hash = _digest_bytes(changed)
    row = fixture.row.model_copy(
        update={
            "evidence_manifest_hash": changed_hash,
            "stage_artifact_hashes": {
                **fixture.row.stage_artifact_hashes,
                "evidence_manifest": changed_hash,
            },
        }
    )
    objects = FakeObjects({**fixture.objects, manifest_path: changed})
    adapter, *_ = _adapter(fixture, responses=[row], objects=objects)

    with pytest.raises(DeckQualityEvidenceAdapterError, match="render_inventory_mismatch"):
        await adapter.judge_initial(fixture.request)


@pytest.mark.anyio
async def test_needs_revision_without_valid_persisted_findings_fails_closed() -> None:
    fixture = _fixture()
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)
    visual = verified.visual.model_copy(update={"slide_findings": ()})
    plan = verified.plan.model_copy(update={"commitments": tuple(item.model_copy(update={"status": "realized"}) for item in verified.plan.commitments)})

    with pytest.raises(DeckQualityEvidenceAdapterError, match="repair_findings_unavailable"):
        adapter._compile_findings(  # noqa: SLF001 - focused fail-closed compiler test
            replace(verified, visual=visual, plan=plan)
        )


@pytest.mark.anyio
async def test_v46_critical_rubric_order_admits_readability_closing_and_subject() -> None:
    fixture = _fixture(
        slide_selectors=(
            "slide:1",
            "slide:2",
            "slide:3",
            "slide:4",
            "slide:5",
        )
    )
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)

    findings = adapter._compile_findings(  # noqa: SLF001 - focused compiler test
        _v46_shaped_compiler_snapshot(adapter, verified)
    )

    assert tuple(
        dict.fromkeys(finding.target_selector for finding in findings)
    ) == (
        "slide:3",
        "slide:5",
        "slide:1",
    )
    pairs = {
        (finding.failure_code, finding.target_selector)
        for finding in findings
    }
    assert {
        ("rendered_readability_failure", "slide:3"),
        ("weak_closing_synthesis", "slide:5"),
        ("weak_subject_specificity", "slide:1"),
    } <= pairs
    assert "weak_mechanism_visualization" not in {
        finding.failure_code for finding in findings
    }


@pytest.mark.anyio
async def test_off_target_critical_readability_fails_closed_before_repair() -> None:
    fixture = _fixture(
        slide_selectors=(
            "slide:1",
            "slide:2",
            "slide:3",
            "slide:4",
            "slide:5",
        )
    )
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)
    off_target = _v46_shaped_compiler_snapshot(
        adapter,
        verified,
        readability_selector="slide:4",
        readability_last=True,
    )

    with pytest.raises(
        DeckQualityEvidenceAdapterError,
        match="critical_repair_findings_unavailable",
    ):
        adapter._compile_findings(  # noqa: SLF001 - focused fail-closed test
            off_target
        )


@pytest.mark.anyio
async def test_below_floor_critical_without_decision_failure_code_fails_closed() -> None:
    fixture = _fixture(
        slide_selectors=(
            "slide:1",
            "slide:2",
            "slide:3",
            "slide:4",
            "slide:5",
        )
    )
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)
    shaped = _v46_shaped_compiler_snapshot(adapter, verified)
    shaped = replace(
        shaped,
        decision=shaped.decision.model_copy(
            update={
                "failure_codes": tuple(
                    code
                    for code in shaped.decision.failure_codes
                    if code != "rendered_readability_failure"
                )
            }
        ),
    )

    with pytest.raises(
        DeckQualityEvidenceAdapterError,
        match="critical_repair_findings_unavailable",
    ):
        adapter._compile_findings(  # noqa: SLF001 - focused fail-closed test
            shaped
        )


@pytest.mark.anyio
async def test_critical_selector_reservation_uses_minimal_three_selector_cover() -> None:
    fixture = _fixture(
        slide_selectors=(
            "slide:1",
            "slide:2",
            "slide:3",
            "slide:4",
            "slide:5",
        )
    )
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)
    shaped = _v46_shaped_compiler_snapshot(adapter, verified)
    visual = shaped.visual.model_copy(
        update={
            "slide_findings": tuple(
                finding.model_copy(
                    update={
                        "evidence_selectors": (
                            ("slide:1", "slide:2")
                            if finding.code == "rendered_readability_failure"
                            else (
                                ("slide:2",)
                                if finding.code == "weak_closing_synthesis"
                                else (
                                    ("slide:3",)
                                    if finding.code == "weak_subject_specificity"
                                    else finding.evidence_selectors
                                )
                            )
                        )
                    }
                )
                for finding in shaped.visual.slide_findings
            ),
            "criterion_scores": tuple(
                score.model_copy(
                    update={
                        "evidence_selectors": (
                            ("slide:1", "slide:2")
                            if score.criterion_id == "rendered_readability"
                            else (
                                ("slide:2",)
                                if score.criterion_id == "closing_synthesis"
                                else (
                                    ("slide:3",)
                                    if score.criterion_id == "subject_specificity"
                                    else score.evidence_selectors
                                )
                            )
                        )
                    }
                )
                for score in shaped.visual.criterion_scores
            ),
        }
    )
    plan = shaped.plan.model_copy(
        update={
            "commitments": tuple(
                commitment.model_copy(
                    update={"evidence_selectors": ("slide:4",)}
                )
                for commitment in shaped.plan.commitments
            ),
            "criterion_scores": tuple(
                score.model_copy(
                    update={"evidence_selectors": ("slide:4",)}
                )
                if score.criterion_id == "default_look"
                else score
                for score in shaped.plan.criterion_scores
            ),
        }
    )

    findings = adapter._compile_findings(  # noqa: SLF001 - focused compiler test
        replace(shaped, visual=visual, plan=plan)
    )

    assert tuple(
        dict.fromkeys(finding.target_selector for finding in findings)
    ) == (
        "slide:2",
        "slide:3",
        "slide:4",
    )
    assert (
        "rendered_readability_failure",
        "slide:2",
    ) in {
        (finding.failure_code, finding.target_selector)
        for finding in findings
    }


@pytest.mark.anyio
async def test_evidence_bound_fill_reaches_three_distinct_selectors() -> None:
    fixture = _fixture(
        slide_selectors=(
            "slide:1",
            "slide:2",
            "slide:3",
            "slide:4",
            "slide:5",
        )
    )
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)
    shaped = _v46_shaped_compiler_snapshot(adapter, verified)
    critical_codes = {
        "rendered_readability_failure",
        "weak_closing_synthesis",
        "weak_subject_specificity",
    }
    visual = shaped.visual.model_copy(
        update={
            "slide_findings": tuple(
                finding.model_copy(
                    update={
                        "evidence_selectors": (
                            ("slide:1",)
                            if finding.code in critical_codes
                            else (
                                ("slide:2", "slide:3")
                                if finding.code
                                == "weak_mechanism_visualization"
                                else finding.evidence_selectors
                            )
                        )
                    }
                )
                for finding in shaped.visual.slide_findings
            ),
            "criterion_scores": tuple(
                score.model_copy(
                    update={"evidence_selectors": ("slide:1",)}
                )
                if score.criterion_id
                in {
                    "rendered_readability",
                    "closing_synthesis",
                    "subject_specificity",
                }
                else score
                for score in shaped.visual.criterion_scores
            ),
        }
    )
    plan = shaped.plan.model_copy(
        update={
            "commitments": tuple(
                commitment.model_copy(
                    update={"evidence_selectors": ("slide:1",)}
                )
                for commitment in shaped.plan.commitments
            ),
            "criterion_scores": tuple(
                score.model_copy(
                    update={"evidence_selectors": ("slide:1",)}
                )
                if score.criterion_id == "default_look"
                else score
                for score in shaped.plan.criterion_scores
            ),
        }
    )

    findings = adapter._compile_findings(  # noqa: SLF001 - focused compiler test
        replace(shaped, visual=visual, plan=plan)
    )

    assert tuple(
        dict.fromkeys(finding.target_selector for finding in findings)
    ) == (
        "slide:1",
        "slide:2",
        "slide:3",
    )


@pytest.mark.anyio
async def test_noncritical_selector_fill_uses_shared_psi_priority_order() -> None:
    fixture = _fixture()
    adapter, *_ = _adapter(fixture)
    verified = await adapter.load_initial_snapshot(fixture.request)
    visual_scores = tuple(
        score.model_copy(update={"score": 3})
        if score.criterion_id == "visual_hierarchy"
        else score
        for score in verified.visual.criterion_scores
    )
    plan_scores = tuple(
        score.model_copy(update={"score": 3})
        if score.criterion_id == "default_look"
        else score
        for score in verified.plan.criterion_scores
    )
    visual = verified.visual.model_copy(
        update={
            "slide_findings": (
                *verified.visual.slide_findings,
                EvidenceFinding(
                    code="weak_mechanism_visualization",
                    observation="The mechanism remains a linear rail.",
                    evidence_selectors=("slide:3",),
                ),
                EvidenceFinding(
                    code="weak_closing_synthesis",
                    observation="The final beat lacks synthesis.",
                    evidence_selectors=("slide:4",),
                ),
            ),
            "criterion_scores": visual_scores,
        }
    )
    plan = verified.plan.model_copy(
        update={"criterion_scores": plan_scores}
    )
    decision = verified.decision.model_copy(
        update={
            "failure_codes": tuple(
                sorted(
                    {
                        *verified.decision.failure_codes,
                        "weak_closing_synthesis",
                        "weak_mechanism_visualization",
                    }
                )
            ),
        }
    )

    findings = adapter._compile_findings(  # noqa: SLF001 - focused compiler test
        replace(
            verified,
            visual=visual,
            plan=plan,
            decision=decision,
        )
    )

    assert tuple(
        dict.fromkeys(finding.target_selector for finding in findings)
    ) == (
        "slide:3",
        "slide:4",
        "slide:2",
    )
