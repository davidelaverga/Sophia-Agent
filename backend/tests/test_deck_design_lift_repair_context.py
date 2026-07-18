from __future__ import annotations

import asyncio
import hashlib
import io
import threading
from dataclasses import dataclass
from decimal import Decimal
from types import SimpleNamespace

import pytest
from PIL import Image

from deerflow.sophia.build_manifest import (
    DECK_STYLE_ROOT_SELECTOR,
    BuildComponent,
    BuildManifest,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.deck_design_lift.production_storage import (
    ProductionDeckManifestRepository,
    foundation_object_root,
)
from deerflow.sophia.deck_design_lift.quality_adapter import (
    AuthenticatedDeckQualitySnapshot,
    LockedSkillExcerpt,
)
from deerflow.sophia.deck_design_lift.repair_author import (
    MAX_REPAIR_CONTEXT_IMAGE_BYTES,
    MAX_REPAIR_CONTEXT_SOURCE_BYTES,
    DeckRepairAuthorError,
)
from deerflow.sophia.deck_design_lift.repair_context import (
    ProductionRepairAuthorContextLoader,
)
from deerflow.sophia.deck_design_lift.runtime import (
    InitialRenderedJudgment,
    RepairInvocationRequest,
)
from deerflow.sophia.deck_design_lift.schemas import (
    DeckRepairProgram,
    JudgmentRepairFinding,
    RepairRenderEvidence,
    SelectorRepair,
    SkillRef,
    VersionCriterionScore,
    VersionQualityEvidence,
)
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.persistence import QualityRunRecord
from deerflow.sophia.deck_quality.schemas import (
    BlindBrief,
    ImageEvidence,
    MechanicalCheck,
    MechanicalProjection,
    QualityEvidenceSnapshot,
    RenderEvidence,
    ShadowDecision,
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

USER_ID = "canary-user-001"
THREAD_ID = "thread-canary-001"
BUILD_ID = "build-psi-001"
ARTIFACT_ID = "artifact-initial-001"
LOGICAL_ID = "logical-psi-001"
QUALITY_RUN_ID = "quality_" + "1" * 64
CAMPAIGN_RUN_ID = "campaign-dq2-001"
EXPERIMENT_ID = "experiment-dq2-001"
OPERATION_ID = "operation-dq2-001"
ARTIFACT_BYTES = b"PK\x03\x04verified-pptx"
ARTIFACT_HASH = hashlib.sha256(ARTIFACT_BYTES).hexdigest()
INSTRUMENT_HASH = "2" * 64
RUBRIC_VERSION = "dq1-rubric-v1"
SOURCE_BYTES = b'<main><h1 data-deck-id="psi-title">PSI control loop</h1></main>'
SOURCE_HASH = hashlib.sha256(SOURCE_BYTES).hexdigest()
SKILL_TEXT = "Use one decisive hierarchy and preserve native semantic text."
SKILL_REF = SkillRef(
    path="skills/public/hands-on-deck/designing-slides.md",
    source_hash="3" * 64,
    excerpt_hash=hashlib.sha256(SKILL_TEXT.encode()).hexdigest(),
)
SELECTORS = tuple(f"slide:{index}" for index in range(1, 6))


def _png(color: tuple[int, int, int]) -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (64, 36), color).save(stream, format="PNG")
    return stream.getvalue()


def _mechanics(record_hash: str) -> MechanicalProjection:
    return MechanicalProjection(
        status="passed",
        checks=tuple(
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
        ),
        authoritative_record_hash=record_hash,
    )


def _decision() -> ShadowDecision:
    return ShadowDecision(
        result="needs_revision",
        reason_codes=("critical_criterion_below_floor",),
        weighted_score=Decimal("2.4"),
        critical_score_floor=3,
        failing_criterion_ids=("visual_hierarchy",),
        failure_codes=("weak_visual_hierarchy",),
        evidence_selectors=("slide:1",),
        rubric_hash="4" * 64,
        policy_hash="5" * 64,
    )


def _program(render_path: str, render_hash: str) -> DeckRepairProgram:
    repair = SelectorRepair(
        selector="slide:1",
        failure_codes=("weak_visual_hierarchy",),
        render_evidence=(
            RepairRenderEvidence(
                selector="slide:1",
                path=render_path,
                sha256=render_hash,
            ),
        ),
        instruction="Create a decisive PSI-specific hierarchy on the first slide.",
        retained_content=("All PSI control-loop claims",),
    )
    payload = {
        "schema_version": "sophia-deck-repair-program/v1",
        "build_id": BUILD_ID,
        "initial_quality_run_id": QUALITY_RUN_ID,
        "initial_manifest_revision": 1,
        "repair_attempt": 1,
        "plan_revision_allowed": False,
        "authorized_selectors": ("slide:1",),
        "authorized_source_roles": {"slide:1": ("body",)},
        "deck_instruction": "Repair only the frozen first-slide hierarchy.",
        "selector_repairs": (repair,),
        "must_preserve": ("brief", "facts", "five slides"),
        "must_not": ("change unrelated sources",),
        "skill_refs": (SKILL_REF,),
        "expected_improvements": ("weak_visual_hierarchy",),
        "forbidden_regressions": ("content_regression",),
        "rubric_version": RUBRIC_VERSION,
        "instrument_hash": INSTRUMENT_HASH,
    }
    return DeckRepairProgram(**payload, program_hash=canonical_sha256(payload))


def _component(selector: str, *, source_path: str) -> BuildComponent:
    if selector == DECK_STYLE_ROOT_SELECTOR:
        return BuildComponent(
            id="style",
            selector=selector,
            type="deck_style",
            index=0,
            source_path=source_path,
            status="gated",
            current_version_id="style-version-001",
            source_roles={"deck_css": source_path},
            source_hashes={"deck_css": hashlib.sha256(b":root{}").hexdigest()},
        )
    index = int(selector.split(":", 1)[1])
    return BuildComponent(
        id=f"slide-{index}",
        selector=selector,
        type="slide",
        index=index,
        source_path=source_path,
        status="gated",
        current_version_id=f"slide-version-{index:03d}",
        source_roles={"body": source_path},
        source_hashes={"body": SOURCE_HASH},
        shared_dependencies=[DECK_STYLE_ROOT_SELECTOR],
    )


class FakeObjectStore:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.calls: list[tuple[str, int]] = []
        self.thread_ids: list[int] = []

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        self.thread_ids.append(threading.get_ident())
        self.calls.append((object_path, max_bytes))
        value = self.objects.get(object_path)
        if value is not None and len(value) > max_bytes:
            raise RuntimeError("oversized")
        return value


class FakeMutationStore:
    def __init__(self) -> None:
        self.transaction: BuildMutationTransaction | None = None
        self.thread_ids: list[int] = []

    def load(
        self,
        *,
        transaction_id: str,
        user_id: str,
    ) -> BuildMutationTransaction:
        self.thread_ids.append(threading.get_ident())
        assert self.transaction is not None
        assert transaction_id == self.transaction.transaction_id
        assert user_id == USER_ID
        return self.transaction.model_copy(deep=True)


class FakeQualityAdapter:
    def __init__(self, authenticated: AuthenticatedDeckQualitySnapshot) -> None:
        self.authenticated = authenticated
        self.calls = []
        self.skill_excerpts = (
            LockedSkillExcerpt(
                route_key="hands_on_deck",
                ref=SKILL_REF,
                text=SKILL_TEXT,
            ),
        )

    async def load_initial_snapshot(self, request):
        self.calls.append(request)
        return self.authenticated


@dataclass
class Fixture:
    loader: ProductionRepairAuthorContextLoader
    request: RepairInvocationRequest
    transaction: BuildMutationTransaction
    mutations: FakeMutationStore
    objects: FakeObjectStore
    quality: FakeQualityAdapter
    source_path: str
    render_path: str


def _fixture() -> Fixture:
    object_root = foundation_object_root(
        user_id=USER_ID,
        thread_id=THREAD_ID,
        build_id=BUILD_ID,
    )
    source_paths = {
        DECK_STYLE_ROOT_SELECTOR: (f"/mnt/user-data/outputs/.builder/builds/{BUILD_ID}/components/style/versions/style-version-001/deck.css"),
        **{selector: (f"/mnt/user-data/outputs/.builder/builds/{BUILD_ID}/components/slide-{index}/versions/slide-version-{index:03d}/body.html") for index, selector in enumerate(SELECTORS, start=1)},
    }
    components = [_component(selector, source_path=source_paths[selector]) for selector in (DECK_STYLE_ROOT_SELECTOR, *SELECTORS)]
    artifact_path = f"{object_root}/artifacts/{ARTIFACT_ID}/psi.pptx"
    manifest = BuildManifest(
        manifest_revision=1,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        format="pptx",
        status="complete",
        logical_artifact_id=LOGICAL_ID,
        current_artifact_version_id=ARTIFACT_ID,
        deliverable_path="/mnt/user-data/outputs/psi.pptx",
        components=components,
        format_extensions={
            "deck": {
                "current_pptx_hash": ARTIFACT_HASH,
                "artifact_storage_object_path": artifact_path,
            }
        },
    )
    manifest_path = f"{object_root}/manifest/manifest-r1.json"
    manifest_bytes = canonical_json_bytes(manifest)

    quality_root = f"{object_root}/quality/{QUALITY_RUN_ID}"
    render_bytes = {selector: _png((20 * index, 30, 40)) for index, selector in enumerate(SELECTORS, start=1)}
    render_paths = {selector: f"{quality_root}/renders/slide-{index:04d}.png" for index, selector in enumerate(SELECTORS, start=1)}
    render_hashes = {selector: hashlib.sha256(render_bytes[selector]).hexdigest() for selector in SELECTORS}
    contact_bytes = _png((10, 20, 30))
    contact_path = f"{quality_root}/renders/contact-sheet.png"
    contact_hash = hashlib.sha256(contact_bytes).hexdigest()
    program = _program(render_paths["slide:1"], render_hashes["slide:1"])

    brief = BlindBrief(
        request="Build exactly five editable PSI slides.",
        subject="Proportional-symbolic integration",
        audience="Product and engineering leaders",
        goal="Explain the PSI control loop",
    )
    creative_plan = {
        "story_arc": "motivation, mechanism, operation, close",
        "image_assets": [],
    }
    design_plan = {"signature": "observable PSI control-loop trace"}
    mechanical_record = {"passed": True, "artifact_hash": ARTIFACT_HASH}
    mechanical_record_hash = canonical_sha256(mechanical_record)
    mechanics = _mechanics(mechanical_record_hash)
    renders = RenderEvidence(
        expected_slide_count=5,
        contact_sheet=ImageEvidence(
            selector="contact-sheet",
            path=contact_path,
            sha256=contact_hash,
            width=64,
            height=36,
        ),
        slides=tuple(
            ImageEvidence(
                selector=selector,
                path=render_paths[selector],
                sha256=render_hashes[selector],
                width=64,
                height=36,
            )
            for selector in SELECTORS
        ),
        selectors=SELECTORS,
    )
    visible_text = tuple(
        VisibleTextSlide(
            selector=selector,
            text=f"PSI semantic content {index}",
            source_hash=hashlib.sha256(f"visible-{index}".encode()).hexdigest(),
        )
        for index, selector in enumerate(SELECTORS, start=1)
    )
    snapshot = QualityEvidenceSnapshot(
        campaign_id="DQ-1",
        build_id=BUILD_ID,
        user_id=USER_ID,
        task_id="task-psi-001",
        builder_run_id="builder-run-psi-001",
        parent_builder_trace_id="builder-trace-psi-001",
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=ARTIFACT_ID,
        manifest_revision=1,
        artifact_path="/mnt/user-data/outputs/psi.pptx",
        artifact_hash=ARTIFACT_HASH,
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
    immutable_artifact_path = f"{quality_root}/immutable/psi.pptx"
    artifact_reference = SnapshotArtifactReference(
        virtual_path=snapshot.artifact_path,
        storage_object_path=immutable_artifact_path,
        sha256=ARTIFACT_HASH,
        size_bytes=len(ARTIFACT_BYTES),
    )
    evidence_bundle_path = f"{quality_root}/evidence_bundle.json"
    evidence_bundle = SnapshotEvidenceBundle(
        quality_run_id=QUALITY_RUN_ID,
        thread_id=THREAD_ID,
        artifact=artifact_reference,
        build_record={"build_id": BUILD_ID, "slide_count": 5},
        snapshot=snapshot,
    )
    evidence_bundle_hash = hashlib.sha256(canonical_json_bytes(evidence_bundle)).hexdigest()
    render_source_pdf = RenderSourcePdfReference(
        object_path=f"{quality_root}/render-source.pdf",
        sha256="6" * 64,
        size_bytes=100,
        page_count=5,
    )
    render_source = RenderSourceReference(
        manifest_path=f"{quality_root}/render-source.json",
        manifest_hash="7" * 64,
        pdf=render_source_pdf,
    )
    render_records = tuple(
        SnapshotObjectRecord(
            role="render",
            object_path=render_paths[selector],
            sha256=render_hashes[selector],
            size_bytes=len(render_bytes[selector]),
            media_type="image/png",
        )
        for selector in SELECTORS
    )
    evidence_manifest = SnapshotEvidenceManifest(
        quality_run_id=QUALITY_RUN_ID,
        snapshot_id=QUALITY_RUN_ID,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        task_id="task-psi-001",
        builder_run_id="builder-run-psi-001",
        parent_builder_trace_id="builder-trace-psi-001",
        logical_artifact_id=LOGICAL_ID,
        artifact_version_id=ARTIFACT_ID,
        artifact_manifest_revision=1,
        input_manifest_path=f"{quality_root}/input_bundle/manifest.json",
        input_manifest_hash="8" * 64,
        artifact=artifact_reference,
        render_source=render_source,
        selectors=SELECTORS,
        source_hashes=SnapshotSourceHashes(
            input_manifest="8" * 64,
            artifact=ARTIFACT_HASH,
            render_source_manifest=render_source.manifest_hash,
            render_source_pdf=render_source_pdf.sha256,
            brief=snapshot.brief_hash,
            creative_plan=snapshot.creative_plan_hash,
            design_plan=snapshot.design_plan_hash,
            build_record=canonical_sha256(evidence_bundle.build_record),
            mechanical_record=mechanical_record_hash,
            visible_text=canonical_sha256(visible_text),
        ),
        render_hashes={**render_hashes, "contact-sheet": contact_hash},
        objects=(
            *render_records,
            SnapshotObjectRecord(
                role="contact_sheet",
                object_path=contact_path,
                sha256=contact_hash,
                size_bytes=len(contact_bytes),
                media_type="image/png",
            ),
            SnapshotObjectRecord(
                role="evidence_bundle",
                object_path=evidence_bundle_path,
                sha256=evidence_bundle_hash,
                size_bytes=len(canonical_json_bytes(evidence_bundle)),
                media_type="application/json",
            ),
        ),
        evidence_bundle_path=evidence_bundle_path,
        evidence_bundle_hash=evidence_bundle_hash,
    )
    decision = _decision()
    row = QualityRunRecord.model_construct(
        quality_run_id=QUALITY_RUN_ID,
        campaign_id="DQ-1",
        state="completed",
        decision_result="needs_revision",
        instrument_identity_hash=INSTRUMENT_HASH,
        rubric_version=RUBRIC_VERSION,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        build_id=BUILD_ID,
        artifact_version_id=ARTIFACT_ID,
        manifest_revision=1,
        artifact_hash=ARTIFACT_HASH,
    )
    authenticated = AuthenticatedDeckQualitySnapshot(
        row=row,
        manifest=manifest,
        evidence_manifest=evidence_manifest,
        evidence_bundle=evidence_bundle,
        visual=SimpleNamespace(),  # type: ignore[arg-type]
        mechanical=mechanics,
        plan=SimpleNamespace(),  # type: ignore[arg-type]
        decision=decision,
    )
    quality = FakeQualityAdapter(authenticated)

    initial = InitialRenderedJudgment(
        evidence=VersionQualityEvidence(
            quality_run_id=QUALITY_RUN_ID,
            artifact_version_id=ARTIFACT_ID,
            verdict="needs_revision",
            weighted_score=Decimal("2.4"),
            criterion_scores=(
                VersionCriterionScore(
                    criterion_id="visual_hierarchy",
                    score=2,
                    critical=True,
                    failed=True,
                ),
            ),
            failure_codes=("weak_visual_hierarchy",),
            critical_failure_codes=("weak_visual_hierarchy",),
            mechanics_passed=True,
            coverage_complete=True,
        ),
        decision=decision,
        findings=(
            JudgmentRepairFinding(
                target_selector="slide:1",
                failure_code="weak_visual_hierarchy",
                observation="The PSI claim lacks a decisive reading order.",
                render_evidence=program.selector_repairs[0].render_evidence,
                requested_source_roles=("body",),
                retained_content=("All PSI control-loop claims",),
                skill_refs=(SKILL_REF,),
            ),
        ),
    )
    transaction = BuildMutationTransaction.prepare(
        build_id=BUILD_ID,
        user_id=USER_ID,
        operation_id=OPERATION_ID,
        expected_manifest_revision=1,
        lease_owner="lease-owner-001",
        lease_seconds=900,
        owner_thread_id=THREAD_ID,
        expected_artifact_version_id=ARTIFACT_ID,
        expected_artifact_hash=ARTIFACT_HASH,
        expected_component_versions={component.selector: component.current_version_id for component in manifest.components},
        authorized_selectors=list(program.authorized_selectors),
        campaign_run_id=CAMPAIGN_RUN_ID,
        authorized_source_roles={"slide:1": ["body"]},
        repair_program_hash=program.program_hash,
        initial_quality_run_id=QUALITY_RUN_ID,
    )
    transaction = transaction.model_copy(
        update={
            "gate_evidence": {
                "deck_design_lift_runtime": {
                    "schema_version": "sophia-deck-design-lift-checkpoint/v1",
                    "campaign_run_id": CAMPAIGN_RUN_ID,
                    "experiment_id": EXPERIMENT_ID,
                    "owner_thread_id": THREAD_ID,
                    "initial_mechanics": mechanics.model_dump(mode="json"),
                    "initial_judgment": initial.model_dump(mode="json"),
                    "repair_program": program.model_dump(mode="json"),
                }
            }
        },
        deep=True,
    )
    request = RepairInvocationRequest(
        campaign_run_id=CAMPAIGN_RUN_ID,
        experiment_id=EXPERIMENT_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        build_id=BUILD_ID,
        operation_id=OPERATION_ID,
        transaction_id=transaction.transaction_id,
        initial_artifact_version_id=ARTIFACT_ID,
        program=program,
    )
    durable_sources = {selector: f"{object_root}/{path.split(f'{BUILD_ID}/', 1)[1]}" for selector, path in source_paths.items()}
    objects = FakeObjectStore(
        {
            manifest_path: manifest_bytes,
            artifact_path: ARTIFACT_BYTES,
            durable_sources[DECK_STYLE_ROOT_SELECTOR]: b":root{}",
            **{durable_sources[selector]: SOURCE_BYTES for selector in SELECTORS},
            **{render_paths[selector]: render_bytes[selector] for selector in SELECTORS},
            contact_path: contact_bytes,
        }
    )
    mutations = FakeMutationStore()
    mutations.transaction = transaction
    repository = ProductionDeckManifestRepository(
        mutation_store=mutations,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
    )
    loader = ProductionRepairAuthorContextLoader(
        manifest_repository=repository,
        mutation_store=mutations,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
        quality_adapter=quality,
    )
    return Fixture(
        loader=loader,
        request=request,
        transaction=transaction,
        mutations=mutations,
        objects=objects,
        quality=quality,
        source_path=durable_sources["slide:1"],
        render_path=render_paths["slide:1"],
    )


def _run(coroutine):
    return asyncio.run(coroutine)


def test_loads_exact_durable_manifest_snapshot_sources_and_skill_context() -> None:
    fixture = _fixture()

    context = _run(fixture.loader.load(fixture.request))

    assert context.identity.manifest_revision == 1
    assert context.identity.initial_artifact_version_id == ARTIFACT_ID
    assert context.brief.brief.request == "Build exactly five editable PSI slides."
    assert tuple(plan.role for plan in context.plans) == (
        "creative_plan",
        "design_plan",
    )
    assert context.contact_sheet.path.startswith("artifacts/")
    assert tuple(item.path for item in context.failing_renders) == (fixture.render_path,)
    assert tuple((source.selector, source.source_role, source.manifest_source_path) for source in context.authorized_sources) == (("slide:1", "body", fixture.source_path),)
    assert context.authorized_sources[0].text == SOURCE_BYTES.decode()
    assert context.owned_assets == ()
    assert context.skill_excerpts[0].excerpt == SKILL_TEXT
    assert len(fixture.quality.calls) == 1
    assert fixture.quality.calls[0].artifact.version_id == ARTIFACT_ID
    assert (fixture.source_path, MAX_REPAIR_CONTEXT_SOURCE_BYTES) in fixture.objects.calls
    assert (fixture.render_path, MAX_REPAIR_CONTEXT_IMAGE_BYTES) in fixture.objects.calls
    assert fixture.mutations.thread_ids
    assert all(thread_id != threading.get_ident() for thread_id in fixture.mutations.thread_ids)
    assert fixture.objects.thread_ids
    assert all(thread_id != threading.get_ident() for thread_id in fixture.objects.thread_ids)


def test_request_identity_mismatch_stops_before_quality_or_source_reads() -> None:
    fixture = _fixture()
    fixture.request = fixture.request.model_copy(update={"experiment_id": "experiment-dq2-tampered"})

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(fixture.loader.load(fixture.request))

    assert error.value.code == "context_invalid"
    assert fixture.quality.calls == []
    assert all(path != fixture.source_path for path, _limit in fixture.objects.calls)


@pytest.mark.parametrize("kind", ["source", "render", "skill"])
def test_tampered_authorized_context_fails_content_free(kind: str) -> None:
    fixture = _fixture()
    if kind == "source":
        fixture.objects.objects[fixture.source_path] += b"tampered"
    elif kind == "render":
        fixture.objects.objects[fixture.render_path] += b"tampered"
    else:
        fixture.quality.skill_excerpts = (
            LockedSkillExcerpt(
                route_key="hands_on_deck",
                ref=SKILL_REF,
                text="secret tampered excerpt",
            ),
        )

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(fixture.loader.load(fixture.request))

    assert error.value.code == "context_invalid"
    assert str(error.value) == "context_invalid"
    assert "tampered" not in str(error.value)


def test_missing_immutable_object_is_content_free_unavailable() -> None:
    fixture = _fixture()
    fixture.objects.objects.pop(fixture.source_path)

    with pytest.raises(DeckRepairAuthorError) as error:
        _run(fixture.loader.load(fixture.request))

    assert error.value.code == "context_unavailable"
    assert str(error.value) == "context_unavailable"
