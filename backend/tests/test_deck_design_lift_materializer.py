from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass

import pytest

from deerflow.sophia.build_manifest import (
    DECK_STYLE_ROOT_SELECTOR,
    BuildComponent,
    BuildManifest,
    manifest_components_by_selector,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.deck_design_lift.materializer import (
    BaselineManifestHead,
    DeckCandidateCompilation,
    DeckCandidateCompileRequest,
    DeckCandidateMaterializationError,
    DerivedDeckSource,
    DurableDeckCandidateMaterializer,
)
from deerflow.sophia.deck_design_lift.schemas import (
    AssetUpdate,
    ContentPreservationProof,
    DeckRepairCandidate,
    DeckRepairProgram,
    LocalityProof,
    RepairRenderEvidence,
    SelectorRepair,
    SkillRef,
    SourceUpdate,
)
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.schemas import MechanicalCheck, MechanicalProjection

USER_ID = "user_canary_01"
THREAD_ID = "thread_canary_01"
BUILD_ID = "build_psi_01"
TRANSACTION_ID = "transaction_psi_01"
OPERATION_ID = "operation_psi_01"
INITIAL_ARTIFACT_ID = "artifact_initial_01"
INITIAL_ARTIFACT_HASH = "f" * 64
INITIAL_QUALITY_RUN_ID = "quality_initial_01"
FIXED_TIME = "2026-07-20T00:00:00+00:00"
OBJECT_ROOT = f"artifacts/{USER_ID}/{THREAD_ID}/foundation/.builder/builds/{BUILD_ID}"


def _run(coro):
    return asyncio.run(coro)


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _manifest_bytes(manifest: BuildManifest) -> bytes:
    return json.dumps(
        manifest.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()


def _legacy_source_path(component_id: str, version_id: str, filename: str) -> str:
    return f"/mnt/user-data/outputs/.builder/builds/{BUILD_ID}/components/{component_id}/versions/{version_id}/{filename}"


def _object_source_path(component_id: str, version_id: str, filename: str) -> str:
    return f"{OBJECT_ROOT}/components/{component_id}/versions/{version_id}/{filename}"


def _production_host_source_path(path: str, *, thread_id: str = THREAD_ID, build_id: str = BUILD_ID) -> str:
    suffix = path.split(f"/.builder/builds/{BUILD_ID}/", 1)[1]
    return f"/app/backend/.deer-flow/threads/{thread_id}/user-data/outputs/.builder/builds/{build_id}/{suffix}"


def _component(
    selector: str,
    index: int,
    contents: dict[str, bytes],
) -> BuildComponent:
    if selector == DECK_STYLE_ROOT_SELECTOR:
        component_id = "component_style_01"
        version_id = "component_version_style_01"
        source_roles = {"deck_css": _legacy_source_path(component_id, version_id, "deck.css")}
        return BuildComponent(
            id=component_id,
            selector=selector,
            type="deck_style",
            index=index,
            source_path=source_roles["deck_css"],
            status="gated",
            current_version_id=version_id,
            source_roles=source_roles,
            source_hashes={"deck_css": _sha(contents["deck_css"])},
            shared_dependencies=[],
            gate_results={"mechanical_passed": True},
            provenance={"authored_by": "fresh", "source_version_id": "source_style_01"},
        )
    number = selector.split(":", 1)[1]
    component_id = f"component_slide_{number}"
    version_id = f"component_version_slide_{number}_01"
    filenames = {
        "body": "body.html",
        "slide_css": "slide.css",
        "notes": "notes.txt",
        "assembled": "assembled.html",
    }
    source_roles = {role: _legacy_source_path(component_id, version_id, filename) for role, filename in filenames.items()}
    return BuildComponent(
        id=component_id,
        selector=selector,
        type="slide",
        index=index,
        source_path=source_roles["body"],
        status="gated",
        current_version_id=version_id,
        source_roles=source_roles,
        source_hashes={
            **{role: _sha(contents[role]) for role in filenames},
            "deck_css": _sha(_source_contents(DECK_STYLE_ROOT_SELECTOR)["deck_css"]),
        },
        shared_dependencies=[DECK_STYLE_ROOT_SELECTOR],
        gate_results={"mechanical_passed": True},
        provenance={"authored_by": "fresh", "source_version_id": f"source_slide_{number}_01"},
    )


def _source_contents(selector: str) -> dict[str, bytes]:
    if selector == DECK_STYLE_ROOT_SELECTOR:
        return {"deck_css": b":root { --brand: #0B1F3A; }"}
    number = selector.split(":", 1)[1]
    return {
        "body": f"<main><h1>Slide {number}</h1></main>".encode(),
        "slide_css": f".slide-{number} {{ color: #0B1F3A; }}".encode(),
        "notes": f"Speaker notes {number}".encode(),
        "assembled": f"<html><main><h1>Slide {number}</h1></main></html>".encode(),
    }


class FakeObjectStore:
    def __init__(self, objects: dict[str, bytes] | None = None) -> None:
        self.objects = dict(objects or {})
        self.create_calls: list[str] = []
        self.fail_after_persist_at: int | None = None

    async def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        value = self.objects.get(object_path)
        if value is not None and len(value) > max_bytes:
            raise RuntimeError("oversized")
        return value

    async def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        del content_type
        self.create_calls.append(object_path)
        outcome = "exists" if object_path in self.objects else "created"
        self.objects.setdefault(object_path, content)
        if self.fail_after_persist_at == len(self.create_calls):
            self.fail_after_persist_at = None
            raise RuntimeError("ambiguous create")
        return outcome


class FakeManifestRepository:
    def __init__(self, head: BaselineManifestHead) -> None:
        self.head = head
        self.loads = 0

    def load_manifest_head(self, *, build_id: str, user_id: str) -> BaselineManifestHead:
        assert build_id == BUILD_ID
        assert user_id == USER_ID
        self.loads += 1
        return self.head


def _mechanical(*, passed: bool = True, record_hash: str) -> MechanicalProjection:
    check_ids = (
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
    checks = []
    for index, check_id in enumerate(check_ids):
        failed = not passed and index == 0
        checks.append(
            MechanicalCheck(
                check_id=check_id,
                status="failed" if failed else "passed",
                failure_codes=("failed",) if failed else (),
            )
        )
    return MechanicalProjection(
        status="passed" if passed else "failed",
        checks=tuple(checks),
        authoritative_record_hash=record_hash,
    )


CompilationMutator = Callable[
    [DeckCandidateCompilation, DeckCandidateCompileRequest],
    DeckCandidateCompilation,
]


class FakeCompiler:
    def __init__(self, mutator: CompilationMutator | None = None) -> None:
        self.calls: list[DeckCandidateCompileRequest] = []
        self.mutator = mutator

    async def compile(self, request: DeckCandidateCompileRequest) -> DeckCandidateCompilation:
        self.calls.append(request)
        common = {
            "build_id": request.build_id,
            "transaction_id": request.transaction_id,
            "artifact_version_id": request.artifact_version_id,
            "manifest_revision": request.candidate_manifest_revision,
        }
        slides = tuple(component.selector for component in request.baseline_manifest.components if component.selector != DECK_STYLE_ROOT_SELECTOR)
        changed = {source.selector for source in request.sources if source.component_version_changed}
        mechanical_record = {
            **common,
            "passed": True,
            "source_retention": True,
        }
        compilation = DeckCandidateCompilation(
            pptx_bytes=b"PK\x03\x04" + hashlib.sha256(request.candidate_hash.encode()).digest(),
            derived_sources=tuple(
                DerivedDeckSource(
                    selector=selector,
                    source_role=role,
                    content=f"<html><main>Compiled {selector}</main></html>",
                )
                for selector, role in request.derived_source_targets
            ),
            build_record={**common, "slide_count": len(slides)},
            creative_plan_record={**common, "plan_revision_changed": False},
            design_plan_record={**common, "plan_revision_changed": False},
            mechanical_record=mechanical_record,
            mechanical=_mechanical(
                record_hash=canonical_sha256(mechanical_record),
            ),
            native_record={
                **common,
                "verified": True,
                "native_editable": True,
                "full_slide_picture_count": 0,
                "slide_count": len(slides),
            },
            render_collateral_record={
                **common,
                "verified": True,
                "within_tolerance": True,
                "expected_selectors": list(slides),
                "rendered_selectors": list(slides),
            },
            locality=LocalityProof(
                authorized_selectors=tuple(request.program.authorized_selectors),
                changed_component_versions=tuple(component.selector for component in request.baseline_manifest.components if component.selector in changed),
                unchanged_component_versions=tuple(component.selector for component in request.baseline_manifest.components if component.selector not in changed),
                shared_dependency_changed=DECK_STYLE_ROOT_SELECTOR in changed,
            ),
            content=ContentPreservationProof(
                brief_preserved=True,
                initial_slide_count=len(slides),
                candidate_slide_count=len(slides),
                required_content_preserved=True,
                factual_content_preserved=True,
                native_editability_preserved=True,
            ),
            dq1_publication_metadata={
                **common,
                "publication_schema": "dq1-candidate/v1",
            },
        )
        return self.mutator(compilation, request) if self.mutator else compilation


@dataclass
class Fixture:
    manifest: BuildManifest
    repository: FakeManifestRepository
    store: FakeObjectStore
    compiler: FakeCompiler
    transaction: BuildMutationTransaction
    program: DeckRepairProgram
    candidate: DeckRepairCandidate

    def materializer(self) -> DurableDeckCandidateMaterializer:
        return DurableDeckCandidateMaterializer(
            manifest_repository=self.repository,
            object_store=self.store,
            compiler=self.compiler,
        )


def _program(selector: str, roles: tuple[str, ...]) -> DeckRepairProgram:
    skill = SkillRef(
        path="skills/slides/SKILL.md",
        source_hash="a" * 64,
        excerpt_hash="b" * 64,
    )
    repair = SelectorRepair(
        selector=selector,
        failure_codes=("weak_subject_specificity",),
        render_evidence=(
            RepairRenderEvidence(
                selector="slide:1",
                path="renders/slide-1.png",
                sha256="c" * 64,
            ),
        ),
        instruction="Strengthen the selected visual hierarchy.",
        retained_content=("all factual slide text",),
    )
    payload = {
        "schema_version": "sophia-deck-repair-program/v1",
        "build_id": BUILD_ID,
        "initial_quality_run_id": INITIAL_QUALITY_RUN_ID,
        "initial_manifest_revision": 1,
        "repair_attempt": 1,
        "plan_revision_allowed": False,
        "authorized_selectors": (selector,),
        "authorized_source_roles": {selector: roles},
        "deck_instruction": "Make the one frozen repair.",
        "selector_repairs": (repair,),
        "must_preserve": ("facts",),
        "must_not": ("change slide count",),
        "skill_refs": (skill,),
        "expected_improvements": ("weak_subject_specificity",),
        "forbidden_regressions": ("content_fidelity",),
        "rubric_version": "v2",
        "instrument_hash": "d" * 64,
    }
    return DeckRepairProgram(**payload, program_hash=canonical_sha256(payload))


def _fixture(
    *,
    selector: str = "slide:1",
    roles: tuple[str, ...] = ("body", "slide_css"),
    mutator: CompilationMutator | None = None,
) -> Fixture:
    contents = {
        DECK_STYLE_ROOT_SELECTOR: _source_contents(DECK_STYLE_ROOT_SELECTOR),
        "slide:1": _source_contents("slide:1"),
        "slide:2": _source_contents("slide:2"),
    }
    components = [
        _component(DECK_STYLE_ROOT_SELECTOR, 0, contents[DECK_STYLE_ROOT_SELECTOR]),
        _component("slide:1", 1, contents["slide:1"]),
        _component("slide:2", 2, contents["slide:2"]),
    ]
    manifest = BuildManifest(
        manifest_revision=1,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        format="pptx",
        status="complete",
        logical_artifact_id="logical_deck_01",
        current_artifact_version_id=INITIAL_ARTIFACT_ID,
        deliverable_path="/mnt/user-data/outputs/deck.pptx",
        components=components,
        format_extensions={
            "deck": {
                "schema_version": "sophia-deck-extension/v1",
                "current_pptx_hash": INITIAL_ARTIFACT_HASH,
                "artifact_storage_object_path": (f"{OBJECT_ROOT}/artifacts/{INITIAL_ARTIFACT_ID}/deck.pptx"),
                "authoring_contract": "compact_model_html_v1",
            }
        },
        created_at=FIXED_TIME,
        updated_at=FIXED_TIME,
    )
    objects: dict[str, bytes] = {}
    for component in components:
        component_contents = contents[component.selector]
        for role, source_path in component.source_roles.items():
            suffix = source_path.split(f"/.builder/builds/{BUILD_ID}/", 1)[1]
            objects[f"{OBJECT_ROOT}/{suffix}"] = component_contents[role]
    manifest_raw = _manifest_bytes(manifest)
    manifest_path = f"{OBJECT_ROOT}/manifest/manifest-r1.json"
    objects[manifest_path] = manifest_raw
    head = BaselineManifestHead(
        build_id=BUILD_ID,
        user_id=USER_ID,
        owner_thread_id=THREAD_ID,
        manifest_revision=1,
        manifest_object_path=manifest_path,
        manifest_hash=_sha(manifest_raw),
        logical_artifact_id="logical_deck_01",
        current_artifact_version_id=INITIAL_ARTIFACT_ID,
        status="complete",
        format="pptx",
        updated_at=FIXED_TIME,
    )
    program = _program(selector, roles)
    versions = {component.selector: component.current_version_id for component in components}
    transaction = BuildMutationTransaction.prepare(
        build_id=BUILD_ID,
        user_id=USER_ID,
        operation_id=OPERATION_ID,
        owner_thread_id=THREAD_ID,
        expected_manifest_revision=1,
        lease_owner="worker_01",
        expected_artifact_version_id=INITIAL_ARTIFACT_ID,
        expected_artifact_hash=INITIAL_ARTIFACT_HASH,
        expected_component_versions=versions,
        authorized_selectors=[selector],
        campaign_run_id="campaign_run_01",
        authorized_source_roles={selector: list(roles)},
        repair_program_hash=program.program_hash,
        initial_quality_run_id=INITIAL_QUALITY_RUN_ID,
        gate_evidence={"initial": "frozen"},
    ).model_copy(update={"transaction_id": TRANSACTION_ID})
    component = manifest_components_by_selector(manifest)[selector]
    updates = tuple(
        SourceUpdate(
            selector=selector,
            source_role=role,
            expected_source_hash=component.source_hashes[role],
            content=(":root { --brand: #C44A2B; }" if role == "deck_css" else f"updated {selector} {role}"),
        )
        for role in roles
    )
    return Fixture(
        manifest=manifest,
        repository=FakeManifestRepository(head),
        store=FakeObjectStore(objects),
        compiler=FakeCompiler(mutator),
        transaction=transaction,
        program=program,
        candidate=DeckRepairCandidate(
            source_updates=updates,
            rationale="Apply the frozen targeted source repair.",
        ),
    )


def _replace_manifest(fixture: Fixture, manifest: BuildManifest) -> None:
    raw = _manifest_bytes(manifest)
    path = f"{OBJECT_ROOT}/manifest/manifest-r1.json"
    fixture.store.objects[path] = raw
    fixture.repository.head = fixture.repository.head.model_copy(update={"manifest_hash": _sha(raw)})
    fixture.manifest = manifest


def test_stage_materializes_native_candidate_and_retains_sibling_versions() -> None:
    fixture = _fixture()
    staged = _run(
        fixture.materializer().stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )

    baseline = manifest_components_by_selector(fixture.manifest)
    candidate = manifest_components_by_selector(staged.candidate_manifest)
    assert staged.artifact.version_id.startswith("artifact_version_")
    assert staged.artifact.artifact_hash == hashlib.sha256(fixture.store.objects[staged.artifact.storage_object_path]).hexdigest()
    assert candidate["slide:1"].current_version_id != baseline["slide:1"].current_version_id
    assert candidate["slide:2"].current_version_id == baseline["slide:2"].current_version_id
    assert candidate[DECK_STYLE_ROOT_SELECTOR].current_version_id == baseline[DECK_STYLE_ROOT_SELECTOR].current_version_id
    assert staged.locality.changed_component_versions == ("slide:1",)
    assert set(staged.locality.unchanged_component_versions) == {
        DECK_STYLE_ROOT_SELECTOR,
        "slide:2",
    }
    assert all(path.startswith(f"{OBJECT_ROOT}/") for path in staged.staged_object_paths)
    assert staged.manifest_object_path == f"{OBJECT_ROOT}/manifest/manifest-r2.json"
    assert _run(fixture.materializer().load_staged(transaction=fixture.transaction)) == staged


def test_restart_after_ambiguous_create_replays_exact_bytes() -> None:
    fixture = _fixture()
    materializer = fixture.materializer()
    fixture.store.fail_after_persist_at = 3

    with pytest.raises(DeckCandidateMaterializationError, match="^storage_unavailable$"):
        _run(
            materializer.stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    partial = dict(fixture.store.objects)
    staged = _run(
        materializer.stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )
    assert all(fixture.store.objects[path] == value for path, value in partial.items())
    assert len(fixture.compiler.calls) == 2

    replayed = _run(
        materializer.stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )
    assert replayed == staged
    assert len(fixture.compiler.calls) == 2


def test_compiler_failure_preserves_only_allowlisted_detail_code() -> None:
    class CompilerFailure(RuntimeError):
        code = "mechanical_gate_failed"

    def fail_compile(
        _compilation: DeckCandidateCompilation,
        _request: DeckCandidateCompileRequest,
    ) -> DeckCandidateCompilation:
        raise CompilerFailure("unsafe raw compiler detail")

    fixture = _fixture()
    fixture.compiler.mutator = fail_compile

    with pytest.raises(DeckCandidateMaterializationError) as error:
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )

    assert error.value.code == "compiler_failed"
    assert error.value.detail_code == "mechanical_gate_failed"
    assert str(error.value) == "compiler_failed"
    assert "unsafe raw compiler detail" not in str(error.value)
    assert (
        DeckCandidateMaterializationError(
            "compiler_failed",
            detail_code="unsafe_unclassified_detail",
        ).detail_code
        is None
    )
    assert (
        DeckCandidateMaterializationError(
            "proof_invalid",
            detail_code="mechanical_gate_failed",
        ).detail_code
        is None
    )
    assert (
        DeckCandidateMaterializationError(
            "compiler_failed",
            detail_code=[],  # type: ignore[arg-type]
        ).detail_code
        is None
    )


def test_existing_conflicting_candidate_object_fails_closed() -> None:
    fixture = _fixture()
    materializer = fixture.materializer()
    staged = _run(
        materializer.stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )
    stage_record = next(path for path in staged.staged_object_paths if path.endswith("materialization.json"))
    candidate_source = next(path for path in staged.staged_object_paths if "/components/component_slide_1/versions/" in path and path.endswith("body.html"))
    del fixture.store.objects[stage_record]
    fixture.store.objects[candidate_source] = b"conflicting immutable bytes"

    with pytest.raises(DeckCandidateMaterializationError, match="^immutable_conflict$"):
        _run(
            materializer.stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )


def test_stale_manifest_revision_and_hash_fail_before_compilation_or_writes() -> None:
    fixture = _fixture()
    fixture.repository.head = fixture.repository.head.model_copy(update={"manifest_revision": 2})
    with pytest.raises(DeckCandidateMaterializationError, match="^stale_manifest$"):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    assert fixture.compiler.calls == []
    assert fixture.store.create_calls == []

    fixture = _fixture()
    fixture.store.objects[f"{OBJECT_ROOT}/manifest/manifest-r1.json"] += b" "
    with pytest.raises(DeckCandidateMaterializationError, match="^manifest_hash_mismatch$"):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    assert fixture.compiler.calls == []
    assert fixture.store.create_calls == []


def test_stale_source_and_candidate_hash_binding_fail_before_any_write() -> None:
    fixture = _fixture()
    source_path = _object_source_path(
        "component_slide_1",
        "component_version_slide_1_01",
        "body.html",
    )
    fixture.store.objects[source_path] = b"stale source bytes"
    with pytest.raises(DeckCandidateMaterializationError, match="^source_hash_mismatch$"):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    assert fixture.store.create_calls == []
    assert fixture.compiler.calls == []

    fixture = _fixture()
    first = fixture.candidate.source_updates[0].model_copy(update={"expected_source_hash": "0" * 64})
    candidate = fixture.candidate.model_copy(update={"source_updates": (first, *fixture.candidate.source_updates[1:])})
    with pytest.raises(
        DeckCandidateMaterializationError,
        match="^candidate_write_hash_mismatch$",
    ):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=candidate,
            )
        )
    assert fixture.store.create_calls == []
    assert fixture.compiler.calls == []


def test_missing_extra_duplicate_and_unauthorized_writes_are_rejected() -> None:
    fixture = _fixture()
    missing = fixture.candidate.model_copy(update={"source_updates": fixture.candidate.source_updates[:1]})
    extra_update = SourceUpdate(
        selector="slide:2",
        source_role="body",
        expected_source_hash=manifest_components_by_selector(fixture.manifest)["slide:2"].source_hashes["body"],
        content="unauthorized sibling write",
    )
    extra = fixture.candidate.model_copy(update={"source_updates": (*fixture.candidate.source_updates, extra_update)})
    duplicate = DeckRepairCandidate.model_construct(
        source_updates=(fixture.candidate.source_updates[0], fixture.candidate.source_updates[0]),
        asset_updates=(),
        creative_plan_patch=None,
        design_plan_patch=None,
        rationale="duplicate target",
    )
    for candidate in (missing, extra, duplicate):
        with pytest.raises(
            DeckCandidateMaterializationError,
            match="^candidate_writes_invalid$",
        ):
            _run(
                fixture.materializer().stage(
                    transaction=fixture.transaction,
                    program=fixture.program,
                    candidate=candidate,
                )
            )
    assert fixture.store.create_calls == []


def test_plan_and_asset_changes_are_not_supported_by_materialization_core() -> None:
    fixture = _fixture()
    plan = fixture.candidate.model_copy(update={"design_plan_patch": {"palette": "new"}})
    asset = fixture.candidate.model_copy(
        update={
            "asset_updates": (
                AssetUpdate(
                    selector="slide:1",
                    asset_id="visual-1",
                    operation="remove",
                ),
            )
        }
    )
    for candidate in (plan, asset):
        with pytest.raises(
            DeckCandidateMaterializationError,
            match="^unsupported_candidate_change$",
        ):
            _run(
                fixture.materializer().stage(
                    transaction=fixture.transaction,
                    program=fixture.program,
                    candidate=candidate,
                )
            )


def test_shared_deck_css_versions_dependency_closure_and_derived_sources() -> None:
    fixture = _fixture(selector=DECK_STYLE_ROOT_SELECTOR, roles=("deck_css",))
    staged = _run(
        fixture.materializer().stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )
    baseline = manifest_components_by_selector(fixture.manifest)
    candidate = manifest_components_by_selector(staged.candidate_manifest)
    assert candidate[DECK_STYLE_ROOT_SELECTOR].current_version_id != baseline[DECK_STYLE_ROOT_SELECTOR].current_version_id
    assert candidate["slide:1"].current_version_id != baseline["slide:1"].current_version_id
    assert candidate["slide:2"].current_version_id != baseline["slide:2"].current_version_id
    candidate_css_hash = candidate[DECK_STYLE_ROOT_SELECTOR].source_hashes["deck_css"]
    assert candidate["slide:1"].source_hashes["deck_css"] == candidate_css_hash
    assert candidate["slide:2"].source_hashes["deck_css"] == candidate_css_hash
    assert fixture.compiler.calls[0].derived_source_targets == (
        ("slide:1", "assembled"),
        ("slide:2", "assembled"),
    )
    assert staged.locality.shared_dependency_changed is True
    assert staged.locality.authorized_selectors == (DECK_STYLE_ROOT_SELECTOR,)
    assert staged.locality.changed_component_versions == (
        DECK_STYLE_ROOT_SELECTOR,
        "slide:1",
        "slide:2",
    )
    assert staged.locality.unchanged_component_versions == ()


def test_exact_underscore_scope_is_accepted_but_traversal_and_neighbor_prefix_are_rejected() -> None:
    fixture = _fixture()
    staged = _run(
        fixture.materializer().stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )
    assert all(f"artifacts/{USER_ID}/{THREAD_ID}/" in path for path in staged.staged_object_paths)

    for unsafe_path in (
        f"{OBJECT_ROOT}/components/component_slide_1/versions/../body.html",
        ("artifacts/userXcanary_01/thread_canary_01/foundation/.builder/builds/build_psi_01/components/component_slide_1/versions/v1/body.html"),
    ):
        fixture = _fixture()
        components = list(fixture.manifest.components)
        slide = components[1]
        roles = dict(slide.source_roles)
        roles["body"] = unsafe_path
        components[1] = slide.model_copy(update={"source_roles": roles})
        _replace_manifest(
            fixture,
            fixture.manifest.model_copy(update={"components": components}, deep=True),
        )
        with pytest.raises(DeckCandidateMaterializationError, match="^source_path_invalid$"):
            _run(
                fixture.materializer().stage(
                    transaction=fixture.transaction,
                    program=fixture.program,
                    candidate=fixture.candidate,
                )
            )


def test_exact_production_host_thread_sources_map_to_hash_verified_canonical_objects() -> None:
    fixture = _fixture()
    components = []
    for component in fixture.manifest.components:
        roles = {role: _production_host_source_path(path) for role, path in component.source_roles.items()}
        components.append(
            component.model_copy(
                update={
                    "source_path": roles.get("body") or roles.get("deck_css"),
                    "source_roles": roles,
                },
                deep=True,
            )
        )
    _replace_manifest(
        fixture,
        fixture.manifest.model_copy(update={"components": components}, deep=True),
    )

    staged = _run(
        fixture.materializer().stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )

    assert staged.manifest_object_path == f"{OBJECT_ROOT}/manifest/manifest-r2.json"
    request = fixture.compiler.calls[0]
    assert all(source.object_path.startswith(f"{OBJECT_ROOT}/") for source in request.sources)
    assert all(source.source_hash == _sha(source.content) for source in request.sources)


@pytest.mark.parametrize(
    "unsafe_path",
    (
        _production_host_source_path(
            _legacy_source_path("component_slide_1", "component_version_slide_1_01", "body.html"),
            thread_id="thread_neighbor_01",
        ),
        _production_host_source_path(
            _legacy_source_path("component_slide_1", "component_version_slide_1_01", "body.html"),
            build_id="build_neighbor_01",
        ),
        ("/srv/app/backend/.deer-flow/threads/thread_canary_01/user-data/outputs/.builder/builds/build_psi_01/components/component_slide_1/versions/component_version_slide_1_01/body.html"),
        ("/app/backend/.deer-flow/threads/thread_canary_01/user-data/outputs/.builder/builds/build_psi_01/components/component_slide_1/versions/../body.html"),
        ("/app/backend/.deer-flow/threads/thread_canary_01/user-data/outputs/.builder/builds/build_psi_01/components//component_slide_1/versions/component_version_slide_1_01/body.html"),
    ),
)
def test_production_host_source_mapping_rejects_scope_drift_and_traversal(
    unsafe_path: str,
) -> None:
    fixture = _fixture()
    components = list(fixture.manifest.components)
    slide = components[1]
    roles = dict(slide.source_roles)
    roles["body"] = unsafe_path
    components[1] = slide.model_copy(update={"source_roles": roles}, deep=True)
    _replace_manifest(
        fixture,
        fixture.manifest.model_copy(update={"components": components}, deep=True),
    )

    with pytest.raises(DeckCandidateMaterializationError, match="^source_path_invalid$"):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    assert fixture.compiler.calls == []
    assert fixture.store.create_calls == []


def _mechanical_failure_mutator(
    compilation: DeckCandidateCompilation,
    _request: DeckCandidateCompileRequest,
) -> DeckCandidateCompilation:
    return compilation.model_copy(
        update={
            "mechanical": _mechanical(
                passed=False,
                record_hash=canonical_sha256(compilation.mechanical_record),
            )
        }
    )


def _native_failure_mutator(
    compilation: DeckCandidateCompilation,
    _request: DeckCandidateCompileRequest,
) -> DeckCandidateCompilation:
    return compilation.model_copy(update={"native_record": {**compilation.native_record, "verified": False}})


def _render_failure_mutator(
    compilation: DeckCandidateCompilation,
    _request: DeckCandidateCompileRequest,
) -> DeckCandidateCompilation:
    return compilation.model_copy(
        update={
            "render_collateral_record": {
                **compilation.render_collateral_record,
                "rendered_selectors": ["slide:1"],
            }
        }
    )


def _content_failure_mutator(
    compilation: DeckCandidateCompilation,
    _request: DeckCandidateCompileRequest,
) -> DeckCandidateCompilation:
    return compilation.model_copy(update={"content": compilation.content.model_copy(update={"factual_content_preserved": False})})


def _locality_failure_mutator(
    compilation: DeckCandidateCompilation,
    _request: DeckCandidateCompileRequest,
) -> DeckCandidateCompilation:
    return compilation.model_copy(update={"locality": compilation.locality.model_copy(update={"unexpected_changes": ("slide:2",)})})


@pytest.mark.parametrize(
    "mutator",
    (
        _mechanical_failure_mutator,
        _native_failure_mutator,
        _render_failure_mutator,
        _content_failure_mutator,
        _locality_failure_mutator,
    ),
)
def test_compiler_proof_failures_are_rejected_before_writes(mutator: CompilationMutator) -> None:
    fixture = _fixture(mutator=mutator)
    with pytest.raises(DeckCandidateMaterializationError, match="^proof_invalid$"):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    assert fixture.store.create_calls == []


def test_provider_prompt_and_raw_error_records_are_rejected() -> None:
    def mutate(
        compilation: DeckCandidateCompilation,
        _request: DeckCandidateCompileRequest,
    ) -> DeckCandidateCompilation:
        return compilation.model_copy(update={"build_record": {**compilation.build_record, "prompt": "private"}})

    fixture = _fixture(mutator=mutate)
    with pytest.raises(
        DeckCandidateMaterializationError,
        match="^compiler_result_invalid$",
    ):
        _run(
            fixture.materializer().stage(
                transaction=fixture.transaction,
                program=fixture.program,
                candidate=fixture.candidate,
            )
        )
    assert fixture.store.create_calls == []


def test_load_staged_hash_verifies_every_immutable_record() -> None:
    fixture = _fixture()
    materializer = fixture.materializer()
    staged = _run(
        materializer.stage(
            transaction=fixture.transaction,
            program=fixture.program,
            candidate=fixture.candidate,
        )
    )
    fixture.store.objects[staged.artifact.storage_object_path] += b"tampered"
    with pytest.raises(DeckCandidateMaterializationError, match="^staged_record_invalid$"):
        _run(materializer.load_staged(transaction=fixture.transaction))


def test_rollback_is_idempotent_retention_only_and_never_moves_a_pointer() -> None:
    fixture = _fixture()
    materializer = fixture.materializer()
    _run(materializer.rollback(transaction=fixture.transaction))
    _run(materializer.rollback(transaction=fixture.transaction))

    marker_path = f"{OBJECT_ROOT}/deck_design_lift/transactions/{TRANSACTION_ID}/candidate/rollback.json"
    payload = json.loads(fixture.store.objects[marker_path])
    assert payload == {
        "action": "retain_immutable_candidate_objects_for_gc",
        "current_pointer_moved": False,
        "schema_version": "sophia-deck-candidate-rollback/v1",
        "transaction_identity_hash": canonical_sha256(
            {
                "schema_version": "sophia-deck-candidate-transaction-identity/v1",
                "transaction_id": fixture.transaction.transaction_id,
                "build_id": fixture.transaction.build_id,
                "user_id": fixture.transaction.user_id,
                "operation_id": fixture.transaction.operation_id,
                "owner_thread_id": fixture.transaction.owner_thread_id,
                "expected_manifest_revision": fixture.transaction.expected_manifest_revision,
                "expected_artifact_version_id": fixture.transaction.expected_artifact_version_id,
                "expected_artifact_hash": fixture.transaction.expected_artifact_hash,
                "expected_component_versions": fixture.transaction.expected_component_versions,
                "authorized_selectors": fixture.transaction.authorized_selectors,
                "authorized_source_roles": fixture.transaction.authorized_source_roles,
                "campaign_run_id": fixture.transaction.campaign_run_id,
                "repair_program_hash": fixture.transaction.repair_program_hash,
                "initial_quality_run_id": fixture.transaction.initial_quality_run_id,
            }
        ),
    }
    assert fixture.repository.loads == 0
    assert fixture.store.create_calls == [marker_path, marker_path]
