from __future__ import annotations

import hashlib
import io
import json
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from PIL import Image
from pypdf import PdfWriter

import deerflow.sophia.deck_quality.graph as graph_module
import deerflow.sophia.deck_quality.runner as runner_module
from deerflow.config.model_route_config import ResolvedModelPlan
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.graph import (
    DeckQualityGraphError,
    DeckQualityGraphRuntime,
    compile_deck_quality_shadow_graph,
)
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.instrument import DeckQualityRuntimeInstrument
from deerflow.sophia.deck_quality.invoker import (
    QualityInputTokenCount,
    QualityInvocationMetrics,
    QualityInvocationResult,
)
from deerflow.sophia.deck_quality.messages import (
    DIRECT_EVIDENCE_MAX_CONTACT_SHEET_DIMENSION,
    DIRECT_EVIDENCE_MAX_IMAGE_BYTES,
    DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION,
    DirectEvidenceBudgetError,
    _validate_direct_evidence_budget,
)
from deerflow.sophia.deck_quality.persistence import (
    STAGE_RANK,
    QualityRunDecision,
    QualityRunErrorCode,
    QualityRunLease,
    QualityRunRecord,
    QualityRunStage,
    QualityRunTerminalState,
)
from deerflow.sophia.deck_quality.persistence import (
    safe_trace_root_input_hash as compute_safe_trace_root_input_hash,
)
from deerflow.sophia.deck_quality.prompts import PromptPack, VersionedPrompt
from deerflow.sophia.deck_quality.runner import (
    DeckQualityShadowRunner,
    compile_registered_deck_quality_shadow_graph,
    initial_graph_state,
)
from deerflow.sophia.deck_quality.schemas import (
    AdjudicationPolicy,
    BlindBrief,
    BlindVisualAssessment,
    CommitmentRealization,
    CriterionScore,
    ImageEvidence,
    PlanRealizationAssessment,
    QualityEvidenceSnapshot,
    QualityInstrumentLock,
    RenderEvidence,
    RubricCriterionProjection,
    RubricProjection,
    VisibleTextSlide,
)
from deerflow.sophia.deck_quality.snapshot import (
    RenderSourceManifest,
    RenderSourcePdfReference,
    RenderSourceReference,
    SnapshotArtifactReference,
    SnapshotEvidenceBundle,
    SnapshotEvidenceManifest,
    SnapshotObjectRecord,
    SnapshotSourceHashes,
)
from deerflow.sophia.deck_quality.tracing import (
    REQUIRED_QUALITY_TRACE_OPERATIONS,
    QualityTraceOperation,
    SafeQualityTraceOperationTerminal,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    immutable_builder_artifact_object_path,
)

HASH = "a" * 64
SOURCE_SHA = "1" * 40
GATEWAY_SHA = "2" * 40
LANGGRAPH_SHA = "3" * 40
CANARY_USER = "canary-user"
BUILD_ID = "build-01"
ARTIFACT_VERSION_ID = "artifact-version-01"
ARTIFACT_BYTES = b"immutable-pptx-fixture"
ARTIFACT_HASH = hashlib.sha256(ARTIFACT_BYTES).hexdigest()


def _png() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (16, 9), "navy").save(output, format="PNG")
    return output.getvalue()


def _oversized_png() -> bytes:
    output = io.BytesIO()
    Image.effect_noise((1000, 1000), 100).convert("RGB").save(output, format="PNG")
    assert len(output.getvalue()) > DIRECT_EVIDENCE_MAX_IMAGE_BYTES
    return output.getvalue()


def _pdf(*, pages: int) -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=720, height=405)
    writer.write(output)
    return output.getvalue()


def _criterion(
    criterion_id: str,
    assessment: str,
) -> RubricCriterionProjection:
    return RubricCriterionProjection(
        id=criterion_id,
        assessment=assessment,  # type: ignore[arg-type]
        critical=True,
        weight=Decimal("1"),
        score_anchors={1: "weak", 3: "adequate", 5: "strong"},
        allowed_failure_codes=(f"weak_{criterion_id}",),
    )


VISUAL_CRITERION = _criterion("subject_specificity", "blind_visual")
PLAN_CRITERION = _criterion("signature_realization", "plan_realization")


def _instrument() -> DeckQualityRuntimeInstrument:
    blind = RubricProjection(
        rubric_version="deck-rubric-v2",
        rubric_hash="b" * 64,
        assessment="blind_visual",
        criteria=(VISUAL_CRITERION,),
    )
    plan_rubric = RubricProjection(
        rubric_version="deck-rubric-v2",
        rubric_hash="b" * 64,
        assessment="plan_realization",
        criteria=(PLAN_CRITERION,),
    )
    prompts = PromptPack(
        blind_visual=VersionedPrompt(
            name="blind",
            version="v4",
            sha256="c" * 64,
            content="Safe blind prompt",
        ),
        plan_realization=VersionedPrompt(
            name="plan",
            version="v4",
            sha256="d" * 64,
            content="Safe plan prompt",
        ),
        large_deck_consolidation=VersionedPrompt(
            name="large",
            version="v1",
            sha256="e" * 64,
            content="Safe consolidation prompt",
        ),
    )
    policy = AdjudicationPolicy(
        critical_score_floor=4,
        min_weighted_score=Decimal("3.5"),
    )
    route = ResolvedModelPlan(
        route_name="deck.judge.visual",
        deployment_name="openai-gpt-5-6-sol",
        provider="openai",
        provider_model="gpt-5.6-sol",
        profile_name="deck-visual-judge-v2",
        profile_version="v2",
        capabilities=frozenset(
            {
                "image_input",
                "multi_image_input",
                "strict_structured_output",
                "reasoning_effort",
            }
        ),
        model_overrides={
            "reasoning": {
                "effort": "high",
                "mode": "standard",
                "context": "current_turn",
            },
            "output_version": "responses/v1",
            "use_responses_api": True,
            "store": False,
            "max_completion_tokens": 6000,
            "timeout": 180,
            "max_retries": 0,
        },
        plan_hash="f" * 64,
    )
    lock = QualityInstrumentLock(
        rubric_version="deck-rubric-v2",
        rubric_hash=blind.rubric_hash,
        prompt_hashes={
            "blind_visual": prompts.blind_visual.sha256,
            "plan_realization": prompts.plan_realization.sha256,
            "large_deck_consolidation": prompts.large_deck_consolidation.sha256,
        },
        judge_plan_hash=route.plan_hash,
        judge_profile_version=route.profile_version,
        evidence_preprocessor_version="deck-evidence-v4",
        judge_invoker_version="deck-judge-invoker-v4",
        assessment_schema_versions={
            "blind_visual": "deck-quality-blind-assessment/v4",
            "mechanical": "deck-quality-mechanical-projection/v1",
            "plan_realization": "deck-quality-plan-assessment/v4",
        },
        adjudication_policy_hash=canonical_sha256(policy),
    )
    return DeckQualityRuntimeInstrument.model_construct(
        plan=route,
        rubric=None,
        blind_rubric=blind,
        plan_rubric=plan_rubric,
        all_criteria=(VISUAL_CRITERION, PLAN_CRITERION),
        prompts=prompts,
        policy=policy,
        lock=lock,
    )


class MemoryObjects:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.created: list[str] = []
        self.read_count = 0
        self.read_paths: list[str] = []
        self.fail_reads = False
        self.fail_create_suffix: str | None = None
        self.fail_after_create_suffix: str | None = None
        self.failed_create_once = False

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        assert content_type == "application/json"
        self.created.append(object_path)
        if self.fail_create_suffix is not None and object_path.endswith(self.fail_create_suffix) and not self.failed_create_once:
            self.failed_create_once = True
            raise RuntimeError("simulated immutable write crash")
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = content
        if self.fail_after_create_suffix is not None and object_path.endswith(self.fail_after_create_suffix) and not self.failed_create_once:
            self.failed_create_once = True
            raise RuntimeError("simulated crash after immutable create")
        return "created"

    def read(self, object_path: str) -> bytes | None:
        self.read_count += 1
        self.read_paths.append(object_path)
        if self.fail_reads:
            raise RuntimeError("simulated storage outage")
        return self.objects.get(object_path)

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        value = self.read(object_path)
        if value is not None and len(value) > max_bytes:
            raise RuntimeError("simulated bounded-read rejection")
        return value


def _snapshot_objects(
    quality_run_id: str,
    *,
    mechanical_passed: bool = True,
    slide_count: int = 1,
    render_over_budget: bool = False,
) -> tuple[MemoryObjects, str, str]:
    root = f"artifacts/{CANARY_USER}/thread-01/foundation/.builder/builds/{BUILD_ID}/quality/{quality_run_id}"
    contact_path = f"{root}/renders/contact-sheet.png"
    bundle_path = f"{root}/evidence_bundle.json"
    manifest_path = f"{root}/evidence_manifest.json"
    image = _oversized_png() if render_over_budget else _png()
    image_hash = hashlib.sha256(image).hexdigest()
    artifact_object_path = immutable_builder_artifact_object_path(
        user_id=CANARY_USER,
        thread_or_session_id="thread-01",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        artifact_sha256=ARTIFACT_HASH,
        filename="deck.pptx",
    )
    selectors = tuple(f"slide:{index}" for index in range(1, slide_count + 1))
    slide_paths = tuple(f"{root}/renders/slide-{index:04d}.png" for index in range(1, slide_count + 1))
    renders = RenderEvidence(
        expected_slide_count=slide_count,
        contact_sheet=ImageEvidence(
            selector="contact-sheet",
            path=contact_path,
            sha256=image_hash,
            width=16,
            height=9,
        ),
        slides=tuple(
            ImageEvidence(
                selector=selector,
                path=slide_path,
                sha256=image_hash,
                width=16,
                height=9,
            )
            for selector, slide_path in zip(selectors, slide_paths, strict=True)
        ),
        selectors=selectors,
    )
    brief = BlindBrief(
        request="Explain the control loop without exposing private memory.",
        subject="Control loops",
        audience="AI engineers",
        goal="Explain the mechanism",
    )
    creative_plan = {"subject_materials": ["control loop"]}
    design_plan = {"signature": "loop motif", "rhythm": "setup-mechanism-close"}
    mechanical = {
        "checks": {
            check: mechanical_passed
            for check in (
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
        }
    }
    visible_text = tuple(
        VisibleTextSlide(
            selector=selector,
            text=f"Observe → appraise → act {index}",
            source_hash=hashlib.sha256(f"visible-{index}".encode()).hexdigest(),
        )
        for index, selector in enumerate(selectors, start=1)
    )
    snapshot = QualityEvidenceSnapshot(
        campaign_id="DQ-1",
        build_id=BUILD_ID,
        user_id=CANARY_USER,
        task_id="task-01",
        builder_run_id="builder-run-01",
        parent_builder_trace_id="019f675a-dcc1-7053-80dc-c6f572fb4d87",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        manifest_revision=1,
        artifact_path="/mnt/user-data/outputs/deck.pptx",
        artifact_hash=ARTIFACT_HASH,
        brief_hash=canonical_sha256(brief),
        creative_plan_hash=canonical_sha256(creative_plan),
        design_plan_hash=canonical_sha256(design_plan),
        brief=brief,
        renders=renders,
        visible_text=visible_text,
        creative_plan=creative_plan,
        design_plan=design_plan,
        mechanical_record=mechanical,
        mechanical_record_hash=canonical_sha256(mechanical),
    )
    artifact = SnapshotArtifactReference(
        virtual_path=snapshot.artifact_path,
        storage_object_path=artifact_object_path,
        sha256=snapshot.artifact_hash,
        size_bytes=len(ARTIFACT_BYTES),
    )
    input_manifest_path = f"{root}/input_bundle/manifest.json"
    input_manifest_hash = "8" * 64
    render_pdf = _pdf(pages=slide_count)
    render_pdf_hash = hashlib.sha256(render_pdf).hexdigest()
    render_pdf_path = f"{root}/render_source/objects/{render_pdf_hash}.pdf"
    render_manifest_path = f"{root}/render_source/manifest.json"
    render_pdf_reference = RenderSourcePdfReference(
        object_path=render_pdf_path,
        sha256=render_pdf_hash,
        size_bytes=len(render_pdf),
        page_count=slide_count,
    )
    render_manifest = RenderSourceManifest(
        quality_run_id=quality_run_id,
        build_id=BUILD_ID,
        user_id=CANARY_USER,
        thread_id="thread-01",
        task_id="task-01",
        builder_run_id="builder-run-01",
        parent_builder_trace_id="019f675a-dcc1-7053-80dc-c6f572fb4d87",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        artifact_manifest_revision=1,
        input_manifest_path=input_manifest_path,
        input_manifest_hash=input_manifest_hash,
        source_artifact=artifact,
        pdf=render_pdf_reference,
    )
    render_manifest_bytes = canonical_json_bytes(render_manifest)
    render_reference = RenderSourceReference(
        manifest_path=render_manifest_path,
        manifest_hash=hashlib.sha256(render_manifest_bytes).hexdigest(),
        pdf=render_pdf_reference,
    )
    build_record = {
        "build_id": BUILD_ID,
        "slides": [{"selector": selector} for selector in selectors],
    }
    bundle = SnapshotEvidenceBundle(
        quality_run_id=quality_run_id,
        thread_id="thread-01",
        artifact=artifact,
        build_record=build_record,
        snapshot=snapshot,
    )
    bundle_bytes = canonical_json_bytes(bundle)
    records = (
        *(
            SnapshotObjectRecord(
                role="render",
                object_path=slide_path,
                sha256=image_hash,
                size_bytes=len(image),
                media_type="image/png",
            )
            for slide_path in slide_paths
        ),
        SnapshotObjectRecord(
            role="contact_sheet",
            object_path=contact_path,
            sha256=image_hash,
            size_bytes=len(image),
            media_type="image/png",
        ),
        SnapshotObjectRecord(
            role="evidence_bundle",
            object_path=bundle_path,
            sha256=hashlib.sha256(bundle_bytes).hexdigest(),
            size_bytes=len(bundle_bytes),
            media_type="application/json",
        ),
    )
    manifest = SnapshotEvidenceManifest(
        quality_run_id=quality_run_id,
        snapshot_id=quality_run_id,
        build_id=BUILD_ID,
        user_id=CANARY_USER,
        thread_id="thread-01",
        task_id="task-01",
        builder_run_id="builder-run-01",
        parent_builder_trace_id="019f675a-dcc1-7053-80dc-c6f572fb4d87",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        artifact_manifest_revision=1,
        input_manifest_path=input_manifest_path,
        input_manifest_hash=input_manifest_hash,
        artifact=artifact,
        render_source=render_reference,
        selectors=selectors,
        source_hashes=SnapshotSourceHashes(
            input_manifest=input_manifest_hash,
            artifact=snapshot.artifact_hash,
            render_source_manifest=render_reference.manifest_hash,
            render_source_pdf=render_pdf_hash,
            brief=snapshot.brief_hash,
            creative_plan=snapshot.creative_plan_hash,
            design_plan=snapshot.design_plan_hash,
            build_record=canonical_sha256(build_record),
            mechanical_record=snapshot.mechanical_record_hash,
            visible_text=canonical_sha256(visible_text),
        ),
        render_hashes={
            **{selector: image_hash for selector in selectors},
            "contact-sheet": image_hash,
        },
        objects=records,
        evidence_bundle_path=bundle_path,
        evidence_bundle_hash=hashlib.sha256(bundle_bytes).hexdigest(),
    )
    manifest_bytes = canonical_json_bytes(manifest)
    return (
        MemoryObjects(
            {
                **{slide_path: image for slide_path in slide_paths},
                contact_path: image,
                bundle_path: bundle_bytes,
                manifest_path: manifest_bytes,
                artifact_object_path: ARTIFACT_BYTES,
                render_manifest_path: render_manifest_bytes,
                render_pdf_path: render_pdf,
            }
        ),
        manifest_path,
        hashlib.sha256(manifest_bytes).hexdigest(),
    )


def _row(
    instrument: DeckQualityRuntimeInstrument,
    manifest_path: str,
    manifest_hash: str,
) -> QualityRunRecord:
    quality_run_id = derive_quality_run_id(
        artifact_version_id=ARTIFACT_VERSION_ID,
        campaign_id="DQ-1",
        instrument=instrument.lock,
    )
    assert quality_run_id in manifest_path
    now = datetime(2026, 7, 16, 8, 0, tzinfo=UTC)
    lock = instrument.lock
    return QualityRunRecord(
        quality_run_id=quality_run_id,
        campaign_id="DQ-1",
        scope_kind="canary",
        instrument_schema_version=lock.schema_version,
        instrument_identity_hash=canonical_sha256(lock),
        rubric_version=lock.rubric_version,
        rubric_hash=lock.rubric_hash,
        prompt_hashes=lock.prompt_hashes,
        judge_plan_hash=lock.judge_plan_hash,
        judge_profile_version=lock.judge_profile_version,
        evidence_preprocessor_version=lock.evidence_preprocessor_version,
        judge_invoker_version=lock.judge_invoker_version,
        assessment_schema_versions=lock.assessment_schema_versions,
        adjudication_policy_hash=lock.adjudication_policy_hash,
        user_id=CANARY_USER,
        thread_id="thread-01",
        task_id="task-01",
        build_id=BUILD_ID,
        builder_run_id="builder-run-01",
        parent_builder_trace_id="019f675a-dcc1-7053-80dc-c6f572fb4d87",
        logical_artifact_id="artifact-01",
        artifact_version_id=ARTIFACT_VERSION_ID,
        manifest_revision=1,
        artifact_hash=ARTIFACT_HASH,
        input_manifest_object_path=manifest_path.removesuffix("/evidence_manifest.json") + "/input_bundle/manifest.json",
        input_manifest_hash="8" * 64,
        state="running",
        stage=QualityRunStage.REQUESTED,
        stage_rank=STAGE_RANK[QualityRunStage.REQUESTED],
        attempt_count=1,
        max_attempts=3,
        error_count=0,
        next_attempt_at=now,
        run_deadline_at=now + timedelta(minutes=10),
        trace_deadline_at=now + timedelta(minutes=12),
        lease_owner="worker-01",
        lease_epoch=1,
        lease_expires_at=now + timedelta(minutes=5),
        claim_token="claim-01",
        claim_hash="9" * 64,
        safe_metrics={},
        trace_ids={},
        stage_artifact_hashes={},
        requested_at=now,
        started_at=now,
        updated_at=now,
    )


class MemoryStore:
    def __init__(self, row: QualityRunRecord) -> None:
        self.row = row
        self.fail_checkpoint_stage: QualityRunStage | None = None
        self.fail_checkpoint_artifact_key: str | None = None
        self.failed_once = False
        self.checkpoints: list[QualityRunStage] = []
        self.fail_prepare_once = False
        self.fail_complete_once = False
        self.fail_complete_response_once = False
        self.prepare_calls = 0
        self.complete_calls = 0

    def _lease(self, lease: QualityRunLease) -> None:
        assert self.row.state in {"running", "finalizing"}
        assert self.row.quality_run_id == lease.quality_run_id
        assert self.row.lease_owner == lease.owner
        assert self.row.lease_epoch == lease.epoch

    async def renew(
        self,
        lease: QualityRunLease,
        *,
        lease_seconds: int = 120,
    ) -> QualityRunRecord:
        self._lease(lease)
        return self.row

    async def checkpoint(
        self,
        lease: QualityRunLease,
        *,
        stage: QualityRunStage,
        safe_metrics: dict[str, object] | None = None,
        trace_ids: dict[str, object] | None = None,
        stage_artifact_hashes: dict[str, object] | None = None,
        evidence_manifest_object_path: str | None = None,
        evidence_manifest_hash: str | None = None,
    ) -> QualityRunRecord:
        self._lease(lease)
        if self.fail_checkpoint_stage is stage and not self.failed_once:
            self.failed_once = True
            raise RuntimeError("simulated crash")
        if self.fail_checkpoint_artifact_key is not None and self.fail_checkpoint_artifact_key in (stage_artifact_hashes or {}) and not self.failed_once:
            self.failed_once = True
            raise RuntimeError("simulated intent checkpoint crash")
        hashes = {
            **self.row.stage_artifact_hashes,
            **{str(key): str(value) for key, value in (stage_artifact_hashes or {}).items()},
        }
        self.row = self.row.model_copy(
            update={
                "stage": stage,
                "stage_rank": STAGE_RANK[stage],
                "stage_artifact_hashes": hashes,
                "safe_metrics": {**self.row.safe_metrics, **(safe_metrics or {})},
                "trace_ids": {**self.row.trace_ids, **(trace_ids or {})},
                "evidence_manifest_object_path": (evidence_manifest_object_path if evidence_manifest_object_path is not None else self.row.evidence_manifest_object_path),
                "evidence_manifest_hash": (evidence_manifest_hash if evidence_manifest_hash is not None else self.row.evidence_manifest_hash),
            }
        )
        self.checkpoints.append(stage)
        return self.row

    async def prepare_completion(
        self,
        lease: QualityRunLease,
        *,
        decision_result: QualityRunDecision,
        decision_failure_codes: tuple[str, ...] = (),
        decision_weighted_score: Decimal | float | None = None,
        safe_metrics: dict[str, object],
        trace_ids: dict[str, object],
        stage_artifact_hashes: dict[str, object],
        safe_trace_root_input: dict[str, object],
    ) -> QualityRunRecord:
        self._lease(lease)
        self.prepare_calls += 1
        if self.fail_prepare_once:
            self.fail_prepare_once = False
            raise RuntimeError("simulated prepare crash")
        update = {
            "state": "finalizing",
            "decision_result": decision_result,
            "decision_failure_codes": decision_failure_codes,
            "decision_weighted_score": decision_weighted_score,
            "safe_metrics": {**self.row.safe_metrics, **safe_metrics},
            "trace_ids": {**self.row.trace_ids, **trace_ids},
            "stage_artifact_hashes": {
                **self.row.stage_artifact_hashes,
                **stage_artifact_hashes,
            },
            "safe_trace_root_input": dict(safe_trace_root_input),
            "safe_trace_root_input_hash": compute_safe_trace_root_input_hash(safe_trace_root_input),
        }
        if self.row.state == "finalizing":
            assert self.row == self.row.model_copy(update=update)
            return self.row
        self.row = self.row.model_copy(update=update)
        return self.row

    async def prepare_failure_trace(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        error_code: QualityRunErrorCode,
        error_stage: str,
        terminal_trace_payload_hash: str,
        safe_trace_root_input: dict[str, object],
    ) -> QualityRunRecord:
        self._lease(lease)
        existing_terminal = getattr(
            self.row,
            "pending_terminal_state",
            None,
        )
        existing_hash = getattr(
            self.row,
            "terminal_trace_payload_hash",
            None,
        )
        if existing_terminal is not None:
            assert existing_terminal == terminal_state.value
            assert self.row.last_error_code is error_code
            assert self.row.last_error_stage == error_stage
            assert existing_hash in {None, terminal_trace_payload_hash}
            if self.row.safe_trace_root_input is not None:
                assert self.row.safe_trace_root_input == safe_trace_root_input
                assert self.row.safe_trace_root_input_hash == (compute_safe_trace_root_input_hash(safe_trace_root_input))
        self.row = self.row.model_copy(
            update={
                "state": "finalizing",
                "pending_terminal_state": terminal_state.value,
                "terminal_trace_payload_hash": terminal_trace_payload_hash,
                "last_error_code": error_code,
                "last_error_stage": error_stage,
                "last_error_at": self.row.updated_at,
                "safe_trace_root_input": dict(safe_trace_root_input),
                "safe_trace_root_input_hash": compute_safe_trace_root_input_hash(safe_trace_root_input),
            }
        )
        return self.row

    async def complete_after_trace(
        self,
        lease: QualityRunLease,
    ) -> QualityRunRecord:
        self._lease(lease)
        self.complete_calls += 1
        assert self.row.state == "finalizing"
        if self.fail_complete_once:
            self.fail_complete_once = False
            raise RuntimeError("simulated post-ack completion crash")
        self.row = self.row.model_copy(
            update={
                "state": "completed",
                "stage": QualityRunStage.PERSISTED_AND_TRACED,
                "stage_rank": STAGE_RANK[QualityRunStage.PERSISTED_AND_TRACED],
                "lease_owner": None,
                "lease_expires_at": None,
                "claim_token": None,
                "claim_hash": None,
                "finished_at": self.row.updated_at,
            }
        )
        if self.fail_complete_response_once:
            self.fail_complete_response_once = False
            raise RuntimeError("simulated lost completion response")
        return self.row

    async def finish(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        decision_result: QualityRunDecision | None = None,
        decision_failure_codes: tuple[str, ...] = (),
        decision_weighted_score: Decimal | float | None = None,
        error_code: Any = None,
        error_stage: str | None = None,
        safe_metrics: dict[str, object] | None = None,
        trace_ids: dict[str, object] | None = None,
        stage_artifact_hashes: dict[str, object] | None = None,
        terminal_trace_payload_hash: str | None = None,
    ) -> QualityRunRecord:
        self._lease(lease)
        assert terminal_state is not QualityRunTerminalState.COMPLETED
        assert (
            getattr(
                self.row,
                "terminal_trace_payload_hash",
                None,
            )
            == terminal_trace_payload_hash
        )
        state_value = terminal_state.value
        self.row = self.row.model_copy(
            update={
                "state": state_value,
                "stage": self.row.stage,
                "stage_rank": self.row.stage_rank,
                "lease_owner": None,
                "lease_expires_at": None,
                "claim_token": None,
                "claim_hash": None,
                "finished_at": self.row.updated_at,
                "decision_result": decision_result,
                "decision_failure_codes": decision_failure_codes,
                "decision_weighted_score": decision_weighted_score,
                "last_error_code": error_code,
                "last_error_stage": error_stage,
                "safe_metrics": safe_metrics or {},
                "trace_ids": trace_ids or {},
                "stage_artifact_hashes": stage_artifact_hashes or {},
            }
        )
        return self.row

    async def retry(
        self,
        lease: QualityRunLease,
        *,
        error_code: Any,
        error_stage: str,
        delay_seconds: int = 30,
        max_attempts: int = 5,
    ) -> QualityRunRecord:
        del delay_seconds, max_attempts
        self._lease(lease)
        retry_state = "finalizing" if self.row.state == "finalizing" else "retry_wait"
        self.row = self.row.model_copy(
            update={
                "state": retry_state,
                "lease_owner": None,
                "lease_expires_at": None,
                "claim_token": None,
                "claim_hash": None,
                "error_count": self.row.error_count + 1,
                "last_error_code": error_code,
                "last_error_stage": error_stage,
            }
        )
        return self.row

    async def get(self, quality_run_id: str) -> QualityRunRecord | None:
        return self.row if quality_run_id == self.row.quality_run_id else None


class FakeInvoker:
    def __init__(self) -> None:
        self.blind_calls = 0
        self.plan_calls = 0
        self.timeouts: list[int] = []
        self.image_counts: list[int] = []
        self.after_blind_call: Any = None
        self.blind_input_tokens = 100
        self.plan_input_tokens = 100
        self.count_error_for: type[Any] | None = None
        self.events: list[str] = []

    def prepare_request(
        self,
        *,
        schema: type[Any],
        messages: list[Any],
        **kwargs: Any,
    ) -> Any:
        del kwargs
        return SimpleNamespace(
            schema=schema,
            messages=messages,
            payload_hash=("a" if schema is BlindVisualAssessment else "c") * 64,
        )

    async def count_input_tokens(
        self,
        *,
        request: Any,
        **kwargs: Any,
    ) -> QualityInputTokenCount:
        del kwargs
        schema = request.schema
        operation = "a" if schema is BlindVisualAssessment else "c"
        self.events.append(f"count_{operation}")
        if schema is self.count_error_for:
            raise RuntimeError("synthetic count failure")
        return QualityInputTokenCount(
            input_tokens=(self.blind_input_tokens if schema is BlindVisualAssessment else self.plan_input_tokens),
            payload_hash=("a" if schema is BlindVisualAssessment else "c") * 64,
        )

    async def invoke(self, *, request: Any, **kwargs: Any) -> Any:
        schema = request.schema
        operation = "a" if schema is BlindVisualAssessment else "c"
        self.events.append(f"invoke_{operation}")
        self.timeouts.append(int(kwargs["timeout_seconds"]))
        payload_text = request.messages[1].content[0]["text"]
        self.image_counts.append(sum(1 for block in request.messages[1].content if block.get("type") == "image_url"))
        selectors = tuple(json.loads(payload_text.split("\n", 1)[1])["selectors"])
        preflight = kwargs["preflight"]
        metrics = QualityInvocationMetrics(
            latency_ms=25,
            input_tokens=preflight.input_tokens,
            output_tokens=50,
            total_tokens=preflight.input_tokens + 50,
            deployment_name="openai-gpt-5-6-sol",
            provider="openai",
            provider_model="gpt-5.6-sol",
            route_name="deck.judge.visual",
            profile_version="v2",
            plan_hash="f" * 64,
            preflight_input_tokens=preflight.input_tokens,
            preflight_payload_hash=preflight.payload_hash,
        )
        score = CriterionScore(
            criterion_id=("subject_specificity" if schema is BlindVisualAssessment else "signature_realization"),
            applicable=True,
            score=4,
            rationale="The rendered evidence supports this score.",
            evidence_selectors=(selectors[0],),
        )
        if schema is BlindVisualAssessment:
            self.blind_calls += 1
            if self.after_blind_call is not None:
                self.after_blind_call()
            parsed = BlindVisualAssessment(
                coverage_confirmed=True,
                evaluated_selectors=selectors,
                overall_impression="A coherent, specific deck.",
                criterion_scores=(score,),
                confidence=0.9,
            )
        else:
            self.plan_calls += 1
            parsed = PlanRealizationAssessment(
                evaluated_selectors=selectors,
                commitments=tuple(
                    CommitmentRealization(
                        commitment_id=commitment_id,
                        dimension=dimension,  # type: ignore[arg-type]
                        status="realized",
                        observation="The planned commitment is visible.",
                        evidence_selectors=("slide:1",),
                    )
                    for commitment_id, dimension in (
                        ("subject-materials", "subject_material"),
                        ("signature", "signature"),
                        ("rhythm", "rhythm"),
                    )
                ),
                criterion_scores=(score,),
                confidence=0.9,
            )
        return QualityInvocationResult(parsed=parsed, metrics=metrics)


class FakeSpan:
    def __init__(self, trace: FakeTrace, operation: str) -> None:
        self.trace = trace
        self.operation = operation

    def finish(self, output: Any) -> None:
        assert output.operation == self.operation
        self.trace.outputs[self.operation] = output


class FakeTrace:
    def __init__(self, root_input: Any) -> None:
        self.root_input = root_input
        self.inputs: dict[str, Any] = {}
        self.outputs: dict[str, Any] = {}
        self.root_output: Any = None

    def start_operation(self, operation_input: Any) -> FakeSpan:
        self.inputs[operation_input.operation] = operation_input
        return FakeSpan(self, operation_input.operation)

    @property
    def operation_terminals(self) -> tuple[Any, ...]:
        return tuple(SafeQualityTraceOperationTerminal.from_output(self.outputs[operation]) for operation in REQUIRED_QUALITY_TRACE_OPERATIONS)

    def finish(self, output: Any) -> None:
        self.root_output = output


def _assert_failure_trace(
    trace: FakeTrace,
    *,
    failing_operation: QualityTraceOperation,
    error_code: str,
) -> None:
    assert tuple(trace.outputs) == REQUIRED_QUALITY_TRACE_OPERATIONS
    assert trace.root_output.shadow_result == "failed_to_judge"
    assert trace.root_output.error_code == error_code
    failure_index = REQUIRED_QUALITY_TRACE_OPERATIONS.index(failing_operation)
    for index, operation in enumerate(REQUIRED_QUALITY_TRACE_OPERATIONS):
        output = trace.outputs[operation]
        if index < failure_index:
            assert output.status == "completed"
        elif index == failure_index:
            assert output.status == "error"
            assert output.error.error_code == error_code
        elif operation == "deck.quality.shadow.persist":
            assert output.status == "completed"
            assert output.shadow_result == "failed_to_judge"
        else:
            assert output.status == "skipped"
            assert output.skip_code == "upstream_error"


def _runtime(
    tmp_path: Path,
    instrument: DeckQualityRuntimeInstrument,
    store: MemoryStore,
    objects: MemoryObjects,
    invoker: FakeInvoker,
    traces: list[FakeTrace],
    *,
    canary_user_ids: frozenset[str] = frozenset({CANARY_USER}),
) -> DeckQualityGraphRuntime:
    def trace_factory(root_input: Any) -> FakeTrace:
        trace = FakeTrace(root_input)
        traces.append(trace)
        return trace

    return DeckQualityGraphRuntime(
        instrument=instrument,
        store=store,
        objects=objects,
        canary_user_ids=canary_user_ids,
        source_commit_sha=SOURCE_SHA,
        gateway_deployed_sha=GATEWAY_SHA,
        langgraph_deployed_sha=LANGGRAPH_SHA,
        invoker=invoker,  # type: ignore[arg-type]
        trace_factory=trace_factory,
        materialization_root=tmp_path,
        timeout_seconds=60,
        clock=lambda: datetime(2026, 7, 16, 8, 0, 1, tzinfo=UTC),
    )


def _setup(
    tmp_path: Path,
    *,
    mechanical_passed: bool = True,
    slide_count: int = 1,
    render_over_budget: bool = False,
) -> tuple[
    DeckQualityRuntimeInstrument,
    MemoryObjects,
    MemoryStore,
    FakeInvoker,
    list[FakeTrace],
    DeckQualityGraphRuntime,
]:
    instrument = _instrument()
    quality_run_id = derive_quality_run_id(
        artifact_version_id=ARTIFACT_VERSION_ID,
        campaign_id="DQ-1",
        instrument=instrument.lock,
    )
    objects, manifest_path, manifest_hash = _snapshot_objects(
        quality_run_id,
        mechanical_passed=mechanical_passed,
        slide_count=slide_count,
        render_over_budget=render_over_budget,
    )
    store = MemoryStore(_row(instrument, manifest_path, manifest_hash))
    invoker = FakeInvoker()
    traces: list[FakeTrace] = []
    runtime = _runtime(
        tmp_path,
        instrument,
        store,
        objects,
        invoker,
        traces,
    )
    return instrument, objects, store, invoker, traces, runtime


@pytest.mark.anyio
async def test_graph_persists_all_stages_traces_eight_operations_and_finishes_run(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    graph = compile_deck_quality_shadow_graph(runtime)

    output = await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert store.row.state == "completed"
    assert store.row.decision_result is QualityRunDecision.SATISFIED
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert set(store.row.stage_artifact_hashes) == {
        "source_snapshot",
        "evidence_manifest",
        "assessment_a_call_intent",
        "assessment_a_visual",
        "assessment_b_mechanical",
        "assessment_c_call_intent",
        "assessment_c_plan_realization",
        "decision",
        "safe_metrics",
        "run",
    }
    assert objects.created[-2].endswith("/safe_metrics.json")
    assert objects.created[-1].endswith("/run.json")
    run_path = objects.created[-1]
    run_payload = json.loads(objects.objects[run_path])
    assert run_payload["schema_version"] == "deck-quality-shadow-run/v2"
    assert run_payload["completion_protocol_state"] == "prepared_awaiting_trace_ack"
    assert "terminal_state" not in run_payload
    assert len(traces) == 1
    assert tuple(traces[0].outputs) == REQUIRED_QUALITY_TRACE_OPERATIONS
    assert traces[0].root_output.shadow_result == "satisfied"
    assert output["terminal_state"] == "completed"


@pytest.mark.anyio
async def test_exact_preflight_order_is_count_a_count_c_then_both_inferences(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, _traces, runtime = _setup(tmp_path)

    await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert invoker.events == ["count_a", "count_c", "invoke_a", "invoke_c"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "failed_schema",
    [BlindVisualAssessment, PlanRealizationAssessment],
)
async def test_any_preflight_failure_writes_no_provider_call_intent(
    tmp_path: Path,
    failed_schema: type[Any],
) -> None:
    _instrument_value, objects, store, invoker, _traces, runtime = _setup(tmp_path)
    invoker.count_error_for = failed_schema

    await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert not any(event.startswith("invoke_") for event in invoker.events)
    assert not any(path.endswith("_call_intent.json") for path in objects.created)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("combined_counts", "expected_inference_calls"),
    [
        ((24_000, 24_000), 2),
        ((24_000, 24_001), 0),
    ],
)
async def test_graph_cost_boundary_admits_equality_and_rejects_one_token_over(
    tmp_path: Path,
    combined_counts: tuple[int, int],
    expected_inference_calls: int,
) -> None:
    _instrument_value, objects, store, invoker, _traces, runtime = _setup(tmp_path)
    invoker.blind_input_tokens, invoker.plan_input_tokens = combined_counts

    await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert invoker.blind_calls + invoker.plan_calls == expected_inference_calls
    if expected_inference_calls == 0:
        assert not any(path.endswith("_call_intent.json") for path in objects.created)


@pytest.mark.anyio
@pytest.mark.parametrize("crash_point", ["run_object", "prepare_row"])
async def test_crash_before_durable_prepare_resumes_without_model_reissue(
    tmp_path: Path,
    crash_point: str,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    if crash_point == "run_object":
        objects.fail_after_create_suffix = "run.json"
    else:
        store.fail_prepare_once = True
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError):
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert store.row.state == "running"
    assert store.row.stage is QualityRunStage.ADJUDICATED
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert traces == []

    output = await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert output["terminal_state"] == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert store.prepare_calls >= 1


@pytest.mark.anyio
async def test_partial_trace_failure_leaves_reclaimable_prepared_row_and_replays_without_models(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)

    class _PartialTraceFailure(FakeTrace):
        def finish(self, output: Any) -> None:
            super().finish(output)
            raise RuntimeError("simulated remote trace readback failure")

    attempts = 0

    def trace_factory(root_input: Any) -> FakeTrace:
        nonlocal attempts
        attempts += 1
        trace: FakeTrace = _PartialTraceFailure(root_input) if attempts == 1 else FakeTrace(root_input)
        traces.append(trace)
        return trace

    runtime = replace(runtime, trace_factory=trace_factory)
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError):
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert store.row.state == "finalizing"
    assert store.row.stage is QualityRunStage.ADJUDICATED
    assert store.row.finished_at is None
    assert {"decision", "safe_metrics", "run"}.issubset(store.row.stage_artifact_hashes)
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    run_path = next(path for path in objects.objects if path.endswith("/run.json"))
    assert b'"terminal_state":"completed"' not in objects.objects[run_path]

    output = await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert output["terminal_state"] == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert attempts == 2


@pytest.mark.anyio
async def test_crash_after_trace_ack_before_completion_reacks_without_model_reissue(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, traces, runtime = _setup(tmp_path)
    store.fail_complete_once = True
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError):
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert store.row.state == "finalizing"
    assert len(traces) == 1
    assert traces[0].root_output is not None
    assert store.complete_calls == 1

    output = await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert output["terminal_state"] == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert len(traces) == 2
    assert all(trace.root_output is not None for trace in traces)
    assert store.prepare_calls == 2
    assert store.complete_calls == 2


@pytest.mark.anyio
async def test_lost_completion_response_is_recovered_from_durable_terminal_row(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, traces, runtime = _setup(tmp_path)
    store.fail_complete_response_once = True

    output = await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert output["terminal_state"] == "completed"
    assert store.row.state == "completed"
    assert store.complete_calls == 1
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert len(traces) == 1


@pytest.mark.anyio
async def test_one_invocation_materializes_each_evidence_object_once(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, _invoker, _traces, runtime = _setup(tmp_path)

    await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    evidence_manifest = store.row.evidence_manifest_object_path
    assert evidence_manifest is not None
    assert objects.read_paths.count(evidence_manifest) == 2  # recovery probe + verified descriptor
    for suffix in (
        "/evidence_bundle.json",
        "/deck.pptx",
        "/render_source/manifest.json",
        "/renders/slide-0001.png",
        "/renders/contact-sheet.png",
    ):
        paths = [path for path in objects.read_paths if path.endswith(suffix)]
        assert len(paths) == 1
    render_pdf_reads = [path for path in objects.read_paths if "/render_source/objects/" in path and path.endswith(".pdf")]
    assert len(render_pdf_reads) == 1


@pytest.mark.anyio
async def test_direct_budget_covers_complete_five_slide_canary_without_truncation(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, _traces, runtime = _setup(
        tmp_path,
        slide_count=5,
    )

    await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert store.row.state == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert invoker.image_counts == [6, 6]


@pytest.mark.anyio
async def test_over_direct_budget_fails_coverage_before_provider_intent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(
        tmp_path,
    )

    def reject_direct_evidence(_evidence: object) -> None:
        raise DirectEvidenceBudgetError("raw budget detail must not escape")

    monkeypatch.setattr(
        graph_module,
        "validate_blind_visual_direct_evidence",
        reject_direct_evidence,
    )

    payload = _dispatch_payload(store)
    output = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(runtime),
        payload,
    )

    assert output["state"] == "failed"
    assert output["error_code"] == "coverage_error"
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0
    assert not any(path.endswith("call_intent.json") for path in objects.objects)
    assert len(traces) == 1
    _assert_failure_trace(
        traces[0],
        failing_operation="deck.quality.evidence",
        error_code="coverage_error",
    )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mutation", "expected_state", "expected_code"),
    (
        ("missing", "failed", "coverage_error"),
        ("stale", "stale", "artifact_snapshot_stale"),
        ("artifact_hash", "stale", "artifact_snapshot_stale"),
    ),
)
async def test_snapshot_terminal_failure_requires_exact_safe_trace_ack(
    tmp_path: Path,
    mutation: str,
    expected_state: str,
    expected_code: str,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    evidence_manifest_path = store.row.input_manifest_object_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"
    if mutation == "missing":
        del objects.objects[evidence_manifest_path]
    elif mutation == "stale":
        objects.objects[evidence_manifest_path] = b"{}"
    else:
        store.row = store.row.model_copy(update={"artifact_hash": "0" * 64})

    payload = _dispatch_payload(store)
    output = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(runtime),
        payload,
    )

    assert output["state"] == expected_state
    assert output["error_code"] == expected_code
    assert store.row.pending_terminal_state == expected_state
    assert store.row.terminal_trace_payload_hash is not None
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0
    assert len(traces) == 1
    _assert_failure_trace(
        traces[0],
        failing_operation="deck.quality.snapshot",
        error_code=expected_code,
    )


@pytest.mark.anyio
async def test_early_failure_never_terminalizes_before_remote_trace_ack(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _instrument_value, _objects, store, invoker, traces, runtime = _setup(
        tmp_path,
    )

    def reject_direct_evidence(_evidence: object) -> None:
        raise DirectEvidenceBudgetError("raw budget detail must not escape")

    monkeypatch.setattr(
        graph_module,
        "validate_blind_visual_direct_evidence",
        reject_direct_evidence,
    )

    class _FailureAckLoss(FakeTrace):
        def finish(self, output: Any) -> None:
            super().finish(output)
            raise RuntimeError("raw remote response must not escape")

    def failing_trace_factory(root_input: Any) -> FakeTrace:
        assert store.row.state == "finalizing"
        assert store.row.pending_terminal_state == "failed"
        assert store.row.terminal_trace_payload_hash is not None
        assert store.row.safe_trace_root_input is not None
        assert store.row.safe_trace_root_input_hash is not None
        trace = _FailureAckLoss(root_input)
        traces.append(trace)
        return trace

    first_runtime = replace(runtime, trace_factory=failing_trace_factory)
    payload = _dispatch_payload(store)
    first = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(first_runtime),
        payload,
    )

    assert first["state"] == "finalizing"
    assert store.row.finished_at is None
    assert store.row.pending_terminal_state == "failed"
    assert store.row.last_error_code is QualityRunErrorCode.COVERAGE_ERROR
    assert store.row.terminal_trace_payload_hash is not None
    assert store.row.safe_trace_root_input is not None
    assert store.row.safe_trace_root_input_hash is not None
    prepared_payload_hash = store.row.terminal_trace_payload_hash
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0

    store.row = store.row.model_copy(
        update={
            "lease_owner": "worker-02",
            "lease_epoch": store.row.lease_epoch + 1,
            "lease_expires_at": store.row.trace_deadline_at,
            "claim_token": "claim-02",
            "claim_hash": "8" * 64,
        }
    )

    def successful_trace_factory(root_input: Any) -> FakeTrace:
        trace = FakeTrace(root_input)
        traces.append(trace)
        return trace

    second_runtime = replace(
        runtime,
        trace_factory=successful_trace_factory,
        clock=lambda: store.row.run_deadline_at + timedelta(seconds=1),
        source_commit_sha="4" * 40,
        gateway_deployed_sha="5" * 40,
        langgraph_deployed_sha="6" * 40,
    )
    payload = _dispatch_payload(store, gateway_sha="5" * 40)
    second = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(second_runtime),
        payload,
    )

    assert second["state"] == "failed"
    assert store.row.terminal_trace_payload_hash == prepared_payload_hash
    assert len(traces) == 2
    assert traces[0].root_input == traces[1].root_input
    assert traces[0].inputs == traces[1].inputs
    assert traces[0].outputs == traces[1].outputs
    assert traces[0].root_output == traces[1].root_output
    assert traces[1].root_input.source_commit_sha == SOURCE_SHA
    assert traces[1].root_input.gateway_deployed_sha == GATEWAY_SHA
    assert traces[1].root_input.langgraph_deployed_sha == LANGGRAPH_SHA
    _assert_failure_trace(
        traces[1],
        failing_operation="deck.quality.evidence",
        error_code="coverage_error",
    )


def test_direct_evidence_byte_and_pixel_boundaries_are_exact(tmp_path: Path) -> None:
    contact = tmp_path / "contact.png"
    slide = tmp_path / "slide.png"
    contact.write_bytes(b"c")
    slide.write_bytes(b"s" * DIRECT_EVIDENCE_MAX_IMAGE_BYTES)

    usage = _validate_direct_evidence_budget(
        expected_slide_count=1,
        selectors=("slide:1",),
        slides=(
            (
                "slide:1",
                slide.as_posix(),
                DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION,
                1152,
            ),
        ),
        contact_sheet=(contact.as_posix(), 2048, 2048),
        text_payload={"bounded": True},
    )

    assert usage.slide_count == 1
    assert usage.total_image_bytes == DIRECT_EVIDENCE_MAX_IMAGE_BYTES + 1

    slide.write_bytes(b"s" * (DIRECT_EVIDENCE_MAX_IMAGE_BYTES + 1))
    with pytest.raises(DirectEvidenceBudgetError):
        _validate_direct_evidence_budget(
            expected_slide_count=1,
            selectors=("slide:1",),
            slides=(
                (
                    "slide:1",
                    slide.as_posix(),
                    DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION,
                    1152,
                ),
            ),
            contact_sheet=(contact.as_posix(), 2048, 2048),
            text_payload={"bounded": True},
        )

    slide.write_bytes(b"s")
    with pytest.raises(DirectEvidenceBudgetError):
        _validate_direct_evidence_budget(
            expected_slide_count=1,
            selectors=("slide:1",),
            slides=(
                (
                    "slide:1",
                    slide.as_posix(),
                    DIRECT_EVIDENCE_MAX_SLIDE_DIMENSION + 1,
                    1238,
                ),
            ),
            contact_sheet=(
                contact.as_posix(),
                DIRECT_EVIDENCE_MAX_CONTACT_SHEET_DIMENSION,
                DIRECT_EVIDENCE_MAX_CONTACT_SHEET_DIMENSION,
            ),
            text_payload={"bounded": True},
        )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("intent_suffix", "expected_stage", "blind_calls", "plan_calls"),
    (
        ("assessment_a_call_intent.json", QualityRunStage.EVIDENCE_PREPARED, 0, 0),
        ("assessment_c_call_intent.json", QualityRunStage.MECHANICAL_PROJECTED, 1, 0),
    ),
)
async def test_crash_after_durable_call_intent_never_reissues_ambiguous_call(
    tmp_path: Path,
    intent_suffix: str,
    expected_stage: QualityRunStage,
    blind_calls: int,
    plan_calls: int,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    objects.fail_after_create_suffix = intent_suffix
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError):
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert store.row.stage is expected_stage
    assert invoker.blind_calls == blind_calls
    assert invoker.plan_calls == plan_calls
    await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))
    assert invoker.blind_calls == blind_calls
    assert invoker.plan_calls == plan_calls
    assert store.row.decision_result is QualityRunDecision.FAILED_TO_JUDGE


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("checkpoint_stage", "blind_calls", "plan_calls"),
    (
        (QualityRunStage.BLIND_ASSESSED, 1, 0),
        (QualityRunStage.PLAN_REALIZATION_ASSESSED, 1, 1),
    ),
)
async def test_orphan_assessment_stage_is_recovered_without_repeat_call(
    tmp_path: Path,
    checkpoint_stage: QualityRunStage,
    blind_calls: int,
    plan_calls: int,
) -> None:
    _instrument_value, _objects, store, invoker, _traces, runtime = _setup(tmp_path)
    store.fail_checkpoint_stage = checkpoint_stage
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError):
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert invoker.blind_calls == blind_calls
    assert invoker.plan_calls == plan_calls
    await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))
    assert invoker.blind_calls == blind_calls
    assert invoker.plan_calls == 1
    assert store.row.state == "completed"


@pytest.mark.anyio
async def test_second_call_receives_only_remaining_run_wall_clock(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    started_at = store.row.started_at
    assert started_at is not None
    now = [started_at + timedelta(seconds=1)]
    invoker.after_blind_call = lambda: now.__setitem__(
        0,
        started_at + timedelta(seconds=41),
    )
    runtime = replace(runtime, clock=lambda: now[0], timeout_seconds=60)

    await compile_deck_quality_shadow_graph(runtime).ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert invoker.timeouts == [59, 19]


class _ExplodingGraph:
    async def ainvoke(self, *_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("unexpected graph failure")


@pytest.mark.anyio
async def test_runner_disables_ambient_tracing_around_raw_inner_graph_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _instrument_value, _objects, store, _invoker, _traces, runtime = _setup(tmp_path)
    tracing_disabled = False
    leaked: list[str] = []
    raw_marker = "https://signed.example/private?authorization=secret-slide-source"

    @contextmanager
    def disabled_context() -> Any:
        nonlocal tracing_disabled
        assert tracing_disabled is False
        tracing_disabled = True
        try:
            yield
        finally:
            tracing_disabled = False

    class _RawEvidenceFailureGraph:
        async def ainvoke(self, *_args: Any, **_kwargs: Any) -> None:
            if not tracing_disabled:
                leaked.append(raw_marker)
            raise RuntimeError(raw_marker)

    monkeypatch.setattr(
        runner_module,
        "langsmith_tracing_disabled",
        disabled_context,
    )
    runner = DeckQualityShadowRunner(runtime)
    runner._graph = _RawEvidenceFailureGraph()  # type: ignore[assignment]

    result = await runner.run(store.row)

    assert result.state == "retry_wait"
    assert result.last_error_code is QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR
    assert leaked == []
    assert raw_marker not in repr(result)
    assert tracing_disabled is False


@pytest.mark.anyio
async def test_runner_reduces_unexpected_exception_to_retry_then_max_attempt_failure(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, _invoker, _traces, runtime = _setup(tmp_path)
    runner = DeckQualityShadowRunner(runtime, max_attempts=5)
    runner._graph = _ExplodingGraph()  # type: ignore[assignment]

    retried = await runner.run(store.row)

    assert retried.state == "retry_wait"
    assert retried.last_error_code.value == "quality_persistence_error"

    _instrument_value, _objects, max_store, _invoker, max_traces, max_runtime = _setup(tmp_path / "max-attempt")
    max_store.row = max_store.row.model_copy(update={"attempt_count": 5})
    max_runner = DeckQualityShadowRunner(max_runtime, max_attempts=5)
    max_runner._graph = _ExplodingGraph()  # type: ignore[assignment]

    failed = await max_runner.run(max_store.row)

    assert failed.state == "failed"
    assert failed.last_error_code is QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED
    assert len(max_traces) == 1
    _assert_failure_trace(
        max_traces[0],
        failing_operation="deck.quality.snapshot",
        error_code="attempt_limit_exhausted",
    )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("error_code", "error_stage"),
    (
        (QualityRunErrorCode.RUN_DEADLINE_EXCEEDED, "run_deadline"),
        (QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED, "attempt_limit"),
    ),
)
async def test_trace_pending_terminal_precursor_skips_raw_graph_and_requires_trace_ack(
    tmp_path: Path,
    error_code: QualityRunErrorCode,
    error_stage: str,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    pending_values = {
        **store.row.model_dump(mode="python"),
        "state": "finalizing",
        "attempt_count": store.row.max_attempts,
        "lease_expires_at": store.row.run_deadline_at + timedelta(minutes=1),
        "pending_terminal_state": "failed",
        "terminal_trace_payload_hash": None,
        "last_error_code": error_code,
        "last_error_stage": error_stage,
        "last_error_at": store.row.updated_at,
    }
    store.row = QualityRunRecord.model_validate(pending_values)
    runtime = replace(
        runtime,
        clock=lambda: store.row.run_deadline_at + timedelta(seconds=1),
    )
    objects.fail_reads = True

    finished = await DeckQualityShadowRunner(
        runtime,
        max_attempts=store.row.max_attempts,
    ).run(store.row)

    assert finished.state == "failed"
    assert finished.last_error_code is error_code
    assert finished.finished_at is not None
    assert objects.read_count == 0
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0
    assert len(traces) == 1
    assert traces[0].root_input.artifact_hash == ARTIFACT_HASH
    _assert_failure_trace(
        traces[0],
        failing_operation="deck.quality.snapshot",
        error_code=error_code.value,
    )


@pytest.mark.anyio
async def test_expired_trace_grace_never_reenters_raw_graph_or_emits_unleased_trace(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    pending_values = {
        **store.row.model_dump(mode="python"),
        "state": "finalizing",
        "attempt_count": store.row.max_attempts,
        "lease_expires_at": store.row.trace_deadline_at,
        "pending_terminal_state": "failed",
        "terminal_trace_payload_hash": None,
        "last_error_code": QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
        "last_error_stage": "run_deadline",
        "last_error_at": store.row.updated_at,
    }
    store.row = QualityRunRecord.model_validate(pending_values)
    runtime = replace(runtime, clock=lambda: store.row.trace_deadline_at)
    objects.fail_reads = True

    with pytest.raises(DeckQualityGraphError) as captured:
        await DeckQualityShadowRunner(
            runtime,
            max_attempts=store.row.max_attempts,
        ).run(store.row)

    assert captured.value.code is QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR
    assert captured.value.stage == "failure_trace_lease"
    assert store.row.state == "finalizing"
    assert store.row.finished_at is None
    assert objects.read_count == 0
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0
    assert traces == []


@pytest.mark.anyio
async def test_trace_pending_attempt_limit_survives_lost_trace_ack_and_reclaim(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    pending_values = {
        **store.row.model_dump(mode="python"),
        "state": "finalizing",
        "attempt_count": store.row.max_attempts,
        "lease_expires_at": store.row.run_deadline_at + timedelta(minutes=1),
        "pending_terminal_state": "failed",
        "terminal_trace_payload_hash": None,
        "last_error_code": QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED,
        "last_error_stage": "attempt_limit",
        "last_error_at": store.row.updated_at,
    }
    store.row = QualityRunRecord.model_validate(pending_values)
    runtime = replace(
        runtime,
        clock=lambda: store.row.run_deadline_at + timedelta(seconds=1),
    )
    objects.fail_reads = True

    class _TraceAckLoss(FakeTrace):
        def finish(self, output: Any) -> None:
            super().finish(output)
            raise RuntimeError("raw trace transport response must not escape")

    def failing_trace_factory(root_input: Any) -> FakeTrace:
        assert store.row.state == "finalizing"
        assert store.row.pending_terminal_state == "failed"
        assert store.row.terminal_trace_payload_hash is not None
        assert store.row.safe_trace_root_input is not None
        assert store.row.safe_trace_root_input_hash is not None
        trace = _TraceAckLoss(root_input)
        traces.append(trace)
        return trace

    first_runtime = replace(runtime, trace_factory=failing_trace_factory)
    first = await DeckQualityShadowRunner(
        first_runtime,
        max_attempts=store.row.max_attempts,
    ).run(store.row)

    assert first.state == "finalizing"
    assert first.finished_at is None
    assert first.last_error_code is QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED
    assert first.last_error_stage == "attempt_limit"
    assert first.lease_owner is None
    prepared_payload_hash = first.terminal_trace_payload_hash
    assert prepared_payload_hash is not None

    store.row = store.row.model_copy(
        update={
            "lease_owner": "worker-02",
            "lease_epoch": store.row.lease_epoch + 1,
            "lease_expires_at": store.row.trace_deadline_at,
            "claim_token": "claim-02",
            "claim_hash": "8" * 64,
        }
    )

    def successful_trace_factory(root_input: Any) -> FakeTrace:
        trace = FakeTrace(root_input)
        traces.append(trace)
        return trace

    second_runtime = replace(
        runtime,
        trace_factory=successful_trace_factory,
        source_commit_sha="4" * 40,
        gateway_deployed_sha="5" * 40,
        langgraph_deployed_sha="6" * 40,
    )
    second = await DeckQualityShadowRunner(
        second_runtime,
        max_attempts=store.row.max_attempts,
    ).run(store.row)

    assert second.state == "failed"
    assert second.last_error_code is QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED
    assert second.terminal_trace_payload_hash == prepared_payload_hash
    assert len(traces) == 2
    assert traces[0].root_input == traces[1].root_input
    assert traces[0].inputs == traces[1].inputs
    assert traces[0].outputs == traces[1].outputs
    assert traces[0].root_output == traces[1].root_output
    assert traces[1].root_input.source_commit_sha == SOURCE_SHA
    assert traces[1].root_input.gateway_deployed_sha == GATEWAY_SHA
    assert traces[1].root_input.langgraph_deployed_sha == LANGGRAPH_SHA
    assert objects.read_count == 0
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0
    _assert_failure_trace(
        traces[1],
        failing_operation="deck.quality.snapshot",
        error_code="attempt_limit_exhausted",
    )


@pytest.mark.anyio
async def test_restart_after_durable_c_does_not_repeat_either_model_invocation(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, traces, runtime = _setup(tmp_path)
    store.fail_checkpoint_stage = QualityRunStage.ADJUDICATED
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError) as captured:
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert captured.value.code.value == "quality_persistence_error"
    assert store.row.stage is QualityRunStage.PLAN_REALIZATION_ASSESSED
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1

    output = await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert output["terminal_state"] == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert len(traces) == 1


@pytest.mark.anyio
async def test_mechanical_gate_writes_deterministic_skipped_c_without_plan_call(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(
        tmp_path,
        mechanical_passed=False,
    )
    graph = compile_deck_quality_shadow_graph(runtime)

    await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 0
    assert store.row.decision_result is QualityRunDecision.MECHANICALLY_INVALID
    c_path = next(path for path in objects.objects if path.endswith("assessment_c_plan_realization.json"))
    assert b'"skip_code":"mechanically_invalid"' in objects.objects[c_path]
    assert traces[0].outputs["deck.judge.plan_realization"].status == "skipped"


@pytest.mark.anyio
async def test_exact_canary_recheck_precedes_raw_object_and_model_access(
    tmp_path: Path,
) -> None:
    instrument, objects, store, invoker, traces, _runtime_value = _setup(tmp_path)
    baseline_reads = objects.read_count
    runtime = _runtime(
        tmp_path,
        instrument,
        store,
        objects,
        invoker,
        traces,
        canary_user_ids=frozenset({"different-canary"}),
    )
    graph = compile_deck_quality_shadow_graph(runtime)

    with pytest.raises(DeckQualityGraphError) as captured:
        await graph.ainvoke(initial_graph_state(store.row, gateway_deployed_sha=GATEWAY_SHA))

    assert captured.value.code.value == "shadow_dispatch_unavailable"
    assert objects.read_count == baseline_reads
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0


def _recursive_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return {
            *(str(key) for key in value),
            *(key for child in value.values() for key in _recursive_keys(child)),
        }
    if isinstance(value, (tuple, list)):
        return {key for child in value for key in _recursive_keys(child)}
    return set()


def test_graph_input_state_is_content_free() -> None:
    instrument = _instrument()
    quality_run_id = derive_quality_run_id(
        artifact_version_id=ARTIFACT_VERSION_ID,
        campaign_id="DQ-1",
        instrument=instrument.lock,
    )
    _objects, manifest_path, manifest_hash = _snapshot_objects(quality_run_id)
    state = initial_graph_state(
        _row(instrument, manifest_path, manifest_hash),
        gateway_deployed_sha=GATEWAY_SHA,
    )

    assert {
        "brief",
        "creative_plan",
        "design_plan",
        "image",
        "messages",
        "prompt",
        "provider_content",
        "source_snapshot",
        "visual_assessment",
        "plan_realization_assessment",
    }.isdisjoint(_recursive_keys(state))
    assert all("private memory" not in value for value in state.values() if isinstance(value, str))


def _dispatch_payload(
    store: MemoryStore,
    *,
    gateway_sha: str = GATEWAY_SHA,
) -> dict[str, object]:
    return {
        "quality_run_id": store.row.quality_run_id,
        "lease_owner": store.row.lease_owner,
        "lease_epoch": store.row.lease_epoch,
        "gateway_deployed_sha": gateway_sha,
    }


async def _invoke_registered_graph(
    graph: Any,
    payload: dict[str, object],
    *,
    config: dict[str, object] | None = None,
) -> dict[str, object]:
    return await graph.ainvoke(
        payload,
        config=config,
        context=payload,
    )


def test_configured_trace_factory_is_dedicated_nonbatching_and_workspace_optional(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created: dict[str, Any] = {}

    class _Client:
        def __init__(self, **kwargs: Any) -> None:
            created.update(kwargs)

        def close(self) -> None:
            created["closed"] = True

    emitted: dict[str, Any] = {}

    def safe_trace(root_input: Any, **kwargs: Any) -> object:
        emitted.update(root_input=root_input, **kwargs)
        return object()

    monkeypatch.setattr(runner_module, "LangSmithClient", _Client)
    monkeypatch.setattr(runner_module, "SafeQualityTrace", safe_trace)
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com")
    monkeypatch.setenv("LANGSMITH_API_KEY", "explicit-key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.delenv("LANGSMITH_WORKSPACE_ID", raising=False)

    factory = runner_module._configured_safe_trace_factory()

    assert created == {
        "api_url": "https://eu.api.smith.langchain.com",
        "api_key": "explicit-key",
        "workspace_id": None,
        "timeout_ms": 15_000,
        "auto_batch_tracing": False,
        "omit_traced_runtime_info": True,
    }
    root_input = object()
    assert factory(root_input) is not None  # type: ignore[arg-type]
    assert emitted == {
        "root_input": root_input,
        "client": factory._client,
        "project_name": "Sophia",
        "flush_timeout_seconds": 15.0,
    }
    factory.close()
    assert created["closed"] is True


@pytest.mark.parametrize(
    "missing",
    ("LANGSMITH_ENDPOINT", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"),
)
def test_configured_trace_factory_rejects_missing_explicit_values_without_legacy_fallback(
    monkeypatch: pytest.MonkeyPatch,
    missing: str,
) -> None:
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com")
    monkeypatch.setenv("LANGSMITH_API_KEY", "explicit-key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")
    monkeypatch.delenv(missing, raising=False)
    monkeypatch.setenv("LANGCHAIN_ENDPOINT", "https://legacy.example.com")
    monkeypatch.setenv("LANGCHAIN_API_KEY", "legacy-key")
    monkeypatch.setenv("LANGCHAIN_PROJECT", "legacy-project")

    with pytest.raises(RuntimeError, match=missing):
        runner_module._configured_safe_trace_factory()


def test_configured_trace_factory_rejects_non_https_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "http://smith.example.com")
    monkeypatch.setenv("LANGSMITH_API_KEY", "explicit-key")
    monkeypatch.setenv("LANGSMITH_PROJECT", "Sophia")

    with pytest.raises(RuntimeError, match="HTTPS endpoint"):
        runner_module._configured_safe_trace_factory()


def test_configured_graph_runtime_binds_the_dedicated_trace_factory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    instrument = _instrument()
    store = object()
    objects = object()
    trace_factory = object()
    config = SimpleNamespace(
        deck_quality=SimpleNamespace(
            enabled=True,
            canary_user_ids=frozenset({CANARY_USER}),
            max_quality_wall_clock_seconds=60,
            max_quality_calls=2,
            max_quality_cost_usd=Decimal("0.60"),
        )
    )
    monkeypatch.setattr(runner_module, "get_app_config", lambda: config)
    monkeypatch.setattr(
        runner_module,
        "compile_runtime_instrument",
        lambda _config: instrument,
    )
    monkeypatch.setattr(
        runner_module,
        "configured_deck_quality_run_store",
        lambda: store,
    )
    monkeypatch.setattr(
        runner_module,
        "SupabaseImmutableObjectStore",
        lambda: objects,
    )
    monkeypatch.setattr(
        runner_module,
        "_configured_safe_trace_factory",
        lambda: trace_factory,
    )
    monkeypatch.setenv("SOPHIA_SOURCE_COMMIT_SHA", SOURCE_SHA)
    monkeypatch.setenv("SOPHIA_GATEWAY_DEPLOYED_SHA", GATEWAY_SHA)
    monkeypatch.setenv("SOPHIA_LANGGRAPH_DEPLOYED_SHA", LANGGRAPH_SHA)
    monkeypatch.setenv("SOPHIA_DECK_QUALITY_MATERIALIZATION_ROOT", str(tmp_path))

    runtime = runner_module.configured_graph_runtime()

    assert runtime.store is store
    assert runtime.objects is objects
    assert runtime.trace_factory is trace_factory


@pytest.mark.anyio
async def test_registered_four_field_dispatch_bootstraps_and_completes(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, _traces, runtime = _setup(tmp_path)
    graph = compile_registered_deck_quality_shadow_graph(runtime)

    payload = _dispatch_payload(store)
    output = await _invoke_registered_graph(graph, payload)

    assert output["state"] == "completed"
    assert output["decision_result"] == "satisfied"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1


@pytest.mark.anyio
async def test_registered_retryable_failure_persists_retry_state(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, _invoker, _traces, runtime = _setup(tmp_path)
    objects.fail_reads = True
    graph = compile_registered_deck_quality_shadow_graph(runtime)

    payload = _dispatch_payload(store)
    output = await _invoke_registered_graph(graph, payload)

    assert output["state"] == "retry_wait"
    assert output["error_code"] == "quality_persistence_error"
    assert store.row.lease_owner is None


@pytest.mark.anyio
async def test_registered_retry_reuses_thread_without_revalidating_checkpoint_output(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, _traces, runtime = _setup(
        tmp_path
    )
    objects.fail_reads = True
    graph = compile_registered_deck_quality_shadow_graph(runtime)
    graph.checkpointer = InMemorySaver()
    config = {"configurable": {"thread_id": "dq1-retry-thread"}}

    first_payload = _dispatch_payload(store)
    first = await _invoke_registered_graph(
        graph,
        first_payload,
        config=config,
    )

    assert first["state"] == "retry_wait"
    assert first["error_code"] == "quality_persistence_error"
    assert store.row.lease_owner is None

    objects.fail_reads = False
    store.row = store.row.model_copy(
        update={
            "state": "running",
            "lease_owner": "worker-02",
            "lease_epoch": store.row.lease_epoch + 1,
            "lease_expires_at": store.row.run_deadline_at,
            "claim_token": "claim-02",
            "claim_hash": "8" * 64,
            "attempt_count": store.row.attempt_count + 1,
        }
    )
    second_payload = _dispatch_payload(store)

    second = await _invoke_registered_graph(
        graph,
        second_payload,
        config=config,
    )

    assert second["state"] == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1


@pytest.mark.anyio
async def test_registered_dispatch_requires_exact_per_run_context(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(
        tmp_path
    )
    payload = _dispatch_payload(store)
    baseline_reads = objects.read_count

    for invalid_context in (
        None,
        {**payload, "state": "retry_wait"},
        {**payload, "lease_epoch": int(payload["lease_epoch"]) + 1},
    ):
        with pytest.raises(DeckQualityGraphError) as captured:
            await compile_registered_deck_quality_shadow_graph(runtime).ainvoke(
                payload,
                context=invalid_context,
            )

        assert (
            captured.value.code
            is QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE
        )
        assert captured.value.stage == "shadow_dispatch"

    assert objects.read_count == baseline_reads
    assert invoker.blind_calls == 0
    assert invoker.plan_calls == 0
    assert traces == []


@pytest.mark.anyio
async def test_prepared_success_trace_replays_through_grace_without_raw_graph_or_models(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)

    class _TraceAckFailure(FakeTrace):
        def finish(self, output: Any) -> None:
            super().finish(output)
            raise RuntimeError("simulated trace ACK failure")

    def failing_trace_factory(root_input: Any) -> FakeTrace:
        trace = _TraceAckFailure(root_input)
        traces.append(trace)
        return trace

    first_runtime = replace(runtime, trace_factory=failing_trace_factory)
    payload = _dispatch_payload(store)
    first_output = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(first_runtime),
        payload,
    )

    assert first_output["state"] == "finalizing"
    assert first_output["error_code"] == "quality_persistence_error"
    assert store.row.lease_owner is None
    assert store.row.stage is QualityRunStage.ADJUDICATED
    assert store.row.safe_trace_root_input is not None
    assert store.row.safe_trace_root_input_hash is not None
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1

    store.row = store.row.model_copy(
        update={
            "lease_owner": "worker-02",
            "lease_epoch": store.row.lease_epoch + 1,
            "lease_expires_at": store.row.trace_deadline_at,
            "claim_token": "claim-02",
            "claim_hash": "8" * 64,
            "attempt_count": store.row.attempt_count + 1,
        }
    )

    def successful_trace_factory(root_input: Any) -> FakeTrace:
        trace = FakeTrace(root_input)
        traces.append(trace)
        return trace

    second_runtime = replace(
        runtime,
        trace_factory=successful_trace_factory,
        source_commit_sha="4" * 40,
        gateway_deployed_sha="5" * 40,
        langgraph_deployed_sha="6" * 40,
        clock=lambda: store.row.run_deadline_at + timedelta(seconds=1),
    )
    objects.read_count = 0
    objects.read_paths.clear()
    created_before_replay = tuple(objects.created)
    checkpoints_before_replay = tuple(store.checkpoints)
    runner = DeckQualityShadowRunner(second_runtime)
    runner._graph = _ExplodingGraph()  # type: ignore[assignment]

    second_output = await runner.run(store.row)

    assert second_output.state == "completed"
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1
    assert tuple(objects.created) == created_before_replay
    assert tuple(store.checkpoints) == checkpoints_before_replay
    assert {
        Path(path).name for path in objects.read_paths
    } == {
        "assessment_a_visual.json",
        "assessment_b_mechanical.json",
        "assessment_c_plan_realization.json",
        "decision.json",
        "safe_metrics.json",
        "run.json",
    }
    assert all(
        "/renders/" not in path
        and not path.endswith("/evidence_manifest.json")
        and "/input_bundle/" not in path
        for path in objects.read_paths
    )
    assert len(traces) == 2
    assert traces[0].root_input == traces[1].root_input
    assert traces[0].inputs == traces[1].inputs
    assert traces[0].outputs == traces[1].outputs
    assert traces[0].root_output == traces[1].root_output
    assert traces[1].root_input.source_commit_sha == SOURCE_SHA
    assert traces[1].root_input.gateway_deployed_sha == GATEWAY_SHA
    assert traces[1].root_input.langgraph_deployed_sha == LANGGRAPH_SHA


@pytest.mark.anyio
async def test_prepared_success_trace_ack_loss_inside_grace_preserves_success_payload(
    tmp_path: Path,
) -> None:
    _instrument_value, _objects, store, invoker, traces, runtime = _setup(tmp_path)

    class _TraceAckFailure(FakeTrace):
        def finish(self, output: Any) -> None:
            super().finish(output)
            raise RuntimeError("simulated trace ACK failure")

    def failing_trace_factory(root_input: Any) -> FakeTrace:
        trace = _TraceAckFailure(root_input)
        traces.append(trace)
        return trace

    first_runtime = replace(runtime, trace_factory=failing_trace_factory)
    payload = _dispatch_payload(store)
    first = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(first_runtime),
        payload,
    )
    assert first["state"] == "finalizing"
    assert store.row.pending_terminal_state is None
    assert store.row.decision_result is QualityRunDecision.SATISFIED

    store.row = store.row.model_copy(
        update={
            "lease_owner": "worker-02",
            "lease_epoch": store.row.lease_epoch + 1,
            "lease_expires_at": store.row.trace_deadline_at,
            "claim_token": "claim-02",
            "claim_hash": "8" * 64,
        }
    )
    replay_runtime = replace(
        runtime,
        trace_factory=failing_trace_factory,
        clock=lambda: store.row.run_deadline_at + timedelta(seconds=1),
    )
    runner = DeckQualityShadowRunner(replay_runtime, max_attempts=1)
    runner._graph = _ExplodingGraph()  # type: ignore[assignment]

    replay = await runner.run(store.row)

    assert replay.state == "finalizing"
    assert replay.pending_terminal_state is None
    assert replay.terminal_trace_payload_hash is None
    assert replay.decision_result is QualityRunDecision.SATISFIED
    assert replay.last_error_code is QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR
    assert replay.last_error_stage == "shadow_persist"
    assert replay.finished_at is None
    assert len(traces) == 2
    assert traces[0].root_input == traces[1].root_input
    assert traces[0].inputs == traces[1].inputs
    assert traces[0].outputs == traces[1].outputs
    assert traces[0].root_output == traces[1].root_output
    assert invoker.blind_calls == 1
    assert invoker.plan_calls == 1


@pytest.mark.anyio
async def test_registered_nonretryable_gateway_mismatch_persists_failed_state(
    tmp_path: Path,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    graph = compile_registered_deck_quality_shadow_graph(runtime)

    payload = _dispatch_payload(store, gateway_sha="4" * 40)
    output = await _invoke_registered_graph(graph, payload)

    assert output["state"] == "failed"
    assert output["error_code"] == "shadow_dispatch_unavailable"
    assert objects.read_count == 0
    assert invoker.blind_calls == 0
    assert len(traces) == 1
    _assert_failure_trace(
        traces[0],
        failing_operation="deck.quality.shadow.dispatch",
        error_code="shadow_dispatch_unavailable",
    )


@pytest.mark.anyio
@pytest.mark.parametrize(
    "preflight_error",
    ("scope_mismatch", "instrument_mismatch"),
)
async def test_registered_dispatch_preflight_rejection_is_safely_traced(
    tmp_path: Path,
    preflight_error: str,
) -> None:
    _instrument_value, objects, store, invoker, traces, runtime = _setup(tmp_path)
    payload = {
        **_dispatch_payload(store),
        "dispatch_preflight_error": preflight_error,
    }

    output = await _invoke_registered_graph(
        compile_registered_deck_quality_shadow_graph(runtime),
        payload,
    )

    assert output["state"] == "failed"
    assert output["error_code"] == "shadow_dispatch_unavailable"
    assert objects.read_count == 0
    assert invoker.blind_calls == 0
    assert len(traces) == 1
    _assert_failure_trace(
        traces[0],
        failing_operation="deck.quality.shadow.dispatch",
        error_code="shadow_dispatch_unavailable",
    )
