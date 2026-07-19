from __future__ import annotations

import asyncio
import hashlib
from types import SimpleNamespace
from typing import cast

import pytest

from deerflow.sophia.build_manifest import BuildComponent, BuildManifest
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.deck_design_lift.materializer import BaselineManifestHead
from deerflow.sophia.deck_design_lift.production_storage import (
    DeckDesignLiftProductionStorageError,
    ProductionDeckDesignLiftRequestFactory,
    ProductionDeckManifestRepository,
    canonical_manifest_source_path,
    foundation_object_root,
)
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.instrument import DeckQualityRuntimeInstrument
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock

USER_ID = "user-canary-001"
THREAD_ID = "thread-canary-001"
BUILD_ID = "build-psi-001"
ARTIFACT_ID = "artifact-initial-001"
ARTIFACT_BYTES = b"PK\x03\x04verified-pptx"
ARTIFACT_HASH = hashlib.sha256(ARTIFACT_BYTES).hexdigest()


def _component(selector: str, index: int) -> BuildComponent:
    root = f"/mnt/user-data/outputs/.builder/builds/{BUILD_ID}"
    if selector == "deck-style:root":
        path = f"{root}/components/style/versions/style-v1/deck.css"
        return BuildComponent(
            id="style",
            selector=selector,
            type="deck_style",
            index=0,
            source_path=path,
            status="gated",
            current_version_id="style-v1",
            source_roles={"deck_css": path},
            source_hashes={"deck_css": "a" * 64},
        )
    body = f"{root}/components/slide-{index}/versions/slide-{index}-v1/body.html"
    css = body.replace("body.html", "slide.css")
    notes = body.replace("body.html", "notes.txt")
    assembled = body.replace("body.html", "assembled.html")
    return BuildComponent(
        id=f"slide-{index}",
        selector=selector,
        type="slide",
        index=index,
        source_path=body,
        status="gated",
        current_version_id=f"slide-{index}-v1",
        source_roles={
            "body": body,
            "slide_css": css,
            "notes": notes,
            "assembled": assembled,
        },
        source_hashes={
            "body": "b" * 64,
            "slide_css": "c" * 64,
            "notes": "d" * 64,
            "assembled": "e" * 64,
            "deck_css": "a" * 64,
        },
        shared_dependencies=["deck-style:root"],
    )


def _manifest(*, revision: int = 1, artifact_id: str = ARTIFACT_ID) -> BuildManifest:
    root = foundation_object_root(user_id=USER_ID, thread_id=THREAD_ID, build_id=BUILD_ID)
    return BuildManifest(
        manifest_revision=revision,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        format="pptx",
        status="complete",
        logical_artifact_id="logical-psi-001",
        current_artifact_version_id=artifact_id,
        deliverable_path="/mnt/user-data/outputs/psi.pptx",
        components=[
            _component("deck-style:root", 0),
            *(_component(f"slide:{index}", index) for index in range(1, 6)),
        ],
        format_extensions={
            "deck": {
                "current_pptx_hash": ARTIFACT_HASH,
                "artifact_storage_object_path": f"{root}/artifacts/{artifact_id}/psi.pptx",
            }
        },
    )


class _Objects:
    def __init__(self, values: dict[str, bytes]) -> None:
        self.values = values

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        value = self.values.get(object_path)
        assert value is None or len(value) <= max_bytes
        return value


class _Mutations:
    def __init__(
        self,
        head: BaselineManifestHead,
        *,
        transaction: BuildMutationTransaction | None = None,
    ) -> None:
        self.head = head
        self.transaction = transaction

    def load_manifest_head(self, *, build_id: str, user_id: str) -> BaselineManifestHead:
        assert (build_id, user_id) == (BUILD_ID, USER_ID)
        return self.head

    def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction:
        assert self.transaction is not None
        assert (transaction_id, user_id) == (self.transaction.transaction_id, USER_ID)
        return self.transaction


def _lock() -> QualityInstrumentLock:
    return QualityInstrumentLock(
        rubric_version="deck-rubric-v2",
        rubric_hash="1" * 64,
        prompt_hashes={
            "blind_visual": "2" * 64,
            "plan_realization": "3" * 64,
        },
        judge_plan_hash="4" * 64,
        judge_profile_version="v2",
        evidence_preprocessor_version="deck-evidence-v4",
        judge_invoker_version="deck-judge-invoker-v4",
        assessment_schema_versions={
            "blind_visual": "v4",
            "mechanical": "v1",
            "plan_realization": "v4",
        },
        adjudication_policy_hash="5" * 64,
    )


def _fixture() -> tuple[
    ProductionDeckManifestRepository,
    _Mutations,
    _Objects,
    BuildManifest,
]:
    manifest = _manifest()
    root = foundation_object_root(user_id=USER_ID, thread_id=THREAD_ID, build_id=BUILD_ID)
    manifest_path = f"{root}/manifest/manifest-r1.json"
    manifest_bytes = canonical_json_bytes(manifest)
    head = BaselineManifestHead(
        build_id=BUILD_ID,
        user_id=USER_ID,
        owner_thread_id=THREAD_ID,
        manifest_revision=1,
        manifest_object_path=manifest_path,
        manifest_hash=hashlib.sha256(manifest_bytes).hexdigest(),
        logical_artifact_id=manifest.logical_artifact_id,
        current_artifact_version_id=manifest.current_artifact_version_id,
        status="complete",
        format="pptx",
        updated_at=manifest.updated_at,
    )
    objects = _Objects(
        {
            manifest_path: manifest_bytes,
            str(manifest.format_extensions["deck"]["artifact_storage_object_path"]): ARTIFACT_BYTES,
        }
    )
    mutations = _Mutations(head)
    repository = ProductionDeckManifestRepository(
        mutation_store=mutations,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
    )
    return repository, mutations, objects, manifest


def test_factory_builds_verified_five_slide_request_from_safe_ids() -> None:
    repository, mutations, objects, _manifest_value = _fixture()
    factory = ProductionDeckDesignLiftRequestFactory(
        manifest_repository=repository,
        mutation_store=mutations,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
        instrument=cast(
            DeckQualityRuntimeInstrument,
            SimpleNamespace(lock=_lock()),
        ),
        canary_user_ids=frozenset({USER_ID}),
    )

    request = asyncio.run(
        factory.build_request(
            campaign_run_id="campaign-dq2-001",
            experiment_id="experiment-dq2-001",
            build_id=BUILD_ID,
            user_id=USER_ID,
            operation_id="operation-dq2-001",
            lease_owner="lease-owner-dq2-001",
            transaction_id=None,
        )
    )

    assert request.initial_artifact.verified is True
    assert request.initial_artifact.artifact_hash == ARTIFACT_HASH
    assert request.expected_manifest_revision == 1
    assert tuple(item.selector for item in request.source_authorizations) == (
        "deck-style:root",
        "slide:1",
        "slide:2",
        "slide:3",
        "slide:4",
        "slide:5",
    )
    assert request.source_authorizations[0].source_roles == ("deck_css",)
    assert request.source_authorizations[1].source_roles == (
        "body",
        "slide_css",
        "notes",
    )
    assert request.instrument_hash == canonical_sha256(_lock())
    assert request.lease_seconds == 120


def test_repository_rejects_noncanonical_or_tampered_manifest() -> None:
    repository, _mutations, objects, _manifest_value = _fixture()
    path = next(path for path in objects.values if path.endswith("manifest-r1.json"))
    objects.values[path] = objects.values[path] + b" "

    with pytest.raises(DeckDesignLiftProductionStorageError) as error:
        repository.load_verified_head(build_id=BUILD_ID, user_id=USER_ID)

    assert error.value.code == "manifest_hash_mismatch"


def test_factory_resume_uses_transaction_frozen_r1_not_current_head() -> None:
    repository, mutations, objects, manifest = _fixture()
    transaction = BuildMutationTransaction.prepare(
        build_id=BUILD_ID,
        user_id=USER_ID,
        operation_id="operation-dq2-001",
        expected_manifest_revision=1,
        lease_owner="lease-owner-dq2-001",
        lease_seconds=900,
        owner_thread_id=THREAD_ID,
        expected_artifact_version_id=ARTIFACT_ID,
        expected_artifact_hash=ARTIFACT_HASH,
        expected_component_versions={component.selector: component.current_version_id for component in manifest.components},
        authorized_selectors=["slide:1"],
        campaign_run_id="campaign-dq2-001",
        authorized_source_roles={"slide:1": ["body"]},
        repair_program_hash="9" * 64,
        initial_quality_run_id="quality_" + "8" * 64,
    )
    mutations.transaction = transaction
    current = _manifest(revision=2, artifact_id="artifact-candidate-001")
    current_path = mutations.head.manifest_object_path.replace("manifest-r1", "manifest-r2")
    current_bytes = canonical_json_bytes(current)
    mutations.head = mutations.head.model_copy(
        update={
            "manifest_revision": 2,
            "manifest_object_path": current_path,
            "manifest_hash": hashlib.sha256(current_bytes).hexdigest(),
            "current_artifact_version_id": current.current_artifact_version_id,
        }
    )
    objects.values[current_path] = current_bytes
    factory = ProductionDeckDesignLiftRequestFactory(
        manifest_repository=repository,
        mutation_store=mutations,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
        instrument=cast(
            DeckQualityRuntimeInstrument,
            SimpleNamespace(lock=_lock()),
        ),
        canary_user_ids=frozenset({USER_ID}),
    )

    request = asyncio.run(
        factory.build_request(
            campaign_run_id="campaign-dq2-001",
            experiment_id="experiment-dq2-001",
            build_id=BUILD_ID,
            user_id=USER_ID,
            operation_id="operation-dq2-001",
            lease_owner="lease-owner-dq2-001",
            transaction_id=transaction.transaction_id,
        )
    )

    assert request.expected_manifest_revision == 1
    assert request.initial_artifact.version_id == ARTIFACT_ID
    assert request.transaction_id == transaction.transaction_id


def test_canonical_manifest_source_path_maps_only_the_build_root() -> None:
    root = foundation_object_root(user_id=USER_ID, thread_id=THREAD_ID, build_id=BUILD_ID)
    mapped = canonical_manifest_source_path(
        f"/mnt/user-data/outputs/.builder/builds/{BUILD_ID}/components/c1/versions/v1/body.html",
        object_root=root,
        build_id=BUILD_ID,
        thread_id=THREAD_ID,
    )
    assert mapped == f"{root}/components/c1/versions/v1/body.html"

    production_mapped = canonical_manifest_source_path(
        f"/app/backend/.deer-flow/threads/{THREAD_ID}/user-data/outputs/.builder/builds/{BUILD_ID}/components/c1/versions/v1/body.html",
        object_root=root,
        build_id=BUILD_ID,
        thread_id=THREAD_ID,
    )
    assert production_mapped == mapped

    with pytest.raises(DeckDesignLiftProductionStorageError) as error:
        canonical_manifest_source_path(
            "/mnt/user-data/outputs/.builder/builds/other/components/c1/body.html",
            object_root=root,
            build_id=BUILD_ID,
            thread_id=THREAD_ID,
        )
    assert error.value.code == "source_path_invalid"


@pytest.mark.parametrize(
    "unsafe_path",
    (
        f"/app/backend/.deer-flow/threads/neighbor-thread/user-data/outputs/.builder/builds/{BUILD_ID}/components/c1/versions/v1/body.html",
        f"/app/backend/.deer-flow/threads/{THREAD_ID}/user-data/outputs/.builder/builds/neighbor-build/components/c1/versions/v1/body.html",
        f"/srv/app/backend/.deer-flow/threads/{THREAD_ID}/user-data/outputs/.builder/builds/{BUILD_ID}/components/c1/versions/v1/body.html",
        f"/app/backend/.deer-flow/threads/{THREAD_ID}/user-data/outputs/.builder/builds/{BUILD_ID}/components/c1/versions/../body.html",
        f"/app/backend/.deer-flow/threads/{THREAD_ID}/user-data/outputs/.builder/builds/{BUILD_ID}/components//c1/versions/v1/body.html",
    ),
)
def test_canonical_manifest_source_path_rejects_production_scope_drift(
    unsafe_path: str,
) -> None:
    root = foundation_object_root(
        user_id=USER_ID,
        thread_id=THREAD_ID,
        build_id=BUILD_ID,
    )

    with pytest.raises(DeckDesignLiftProductionStorageError) as error:
        canonical_manifest_source_path(
            unsafe_path,
            object_root=root,
            build_id=BUILD_ID,
            thread_id=THREAD_ID,
        )

    assert error.value.code == "source_path_invalid"
