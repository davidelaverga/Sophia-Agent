from __future__ import annotations

import hashlib
import threading
from types import SimpleNamespace
from typing import Any

import anyio
import pytest

from deerflow.sophia.build_manifest import BuildManifest
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift import runner as runner_module
from deerflow.sophia.deck_design_lift.graph import DeckDesignLiftGraphRuntime
from deerflow.sophia.deck_design_lift.runner import (
    ConfiguredDeckDesignLiftGraphRuntime,
    DeckDesignLiftRunnerError,
    ProductionArtifactManifestLoader,
    ProductionDeckCandidateBaselineLoader,
    ProductionDeckMechanics,
)
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.schemas import MechanicalCheck, MechanicalProjection

USER_ID = "user_canary_01"
THREAD_ID = "thread_canary_01"
BUILD_ID = "build_psi_01"
INITIAL_ARTIFACT_ID = "artifact_initial_01"
CANDIDATE_ARTIFACT_ID = "artifact_candidate_01"
TRANSACTION_ID = "transaction_psi_01"
OPERATION_ID = "operation_psi_01"
INITIAL_QUALITY_RUN_ID = "quality_initial_01"
CAMPAIGN_RUN_ID = "campaign_psi_01"
EXPERIMENT_ID = "experiment_psi_01"


class _AsyncObjects:
    def __init__(self, values: dict[str, bytes] | None = None) -> None:
        self.values = values or {}
        self.reads: list[tuple[str, int]] = []

    async def read_bounded(self, path: str, *, max_bytes: int) -> bytes | None:
        self.reads.append((path, max_bytes))
        return self.values.get(path)


def _object_root() -> str:
    return f"artifacts/{USER_ID}/{THREAD_ID}/foundation/.builder/builds/{BUILD_ID}"


def _manifest(
    *,
    revision: int,
    artifact_id: str,
    artifact_hash: str = "a" * 64,
    extra_deck: dict[str, Any] | None = None,
) -> BuildManifest:
    artifact_path = f"/mnt/user-data/outputs/.builder/builds/{BUILD_ID}/artifacts/{artifact_id}/candidate.pptx"
    storage_path = f"{_object_root()}/artifacts/{artifact_id}/candidate.pptx"
    return BuildManifest(
        manifest_revision=revision,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        format="pptx",
        status="complete",
        logical_artifact_id="logical_psi_01",
        current_artifact_version_id=artifact_id,
        deliverable_path=artifact_path,
        components=[],
        format_extensions={
            "deck": {
                "current_pptx_hash": artifact_hash,
                "artifact_storage_object_path": storage_path,
                **(extra_deck or {}),
            }
        },
        created_at="2026-07-20T00:00:00+00:00",
        updated_at="2026-07-20T00:00:00+00:00",
    )


def _artifact(manifest: BuildManifest) -> BuildArtifactVersion:
    deck = manifest.format_extensions["deck"]
    return BuildArtifactVersion(
        version_id=str(manifest.current_artifact_version_id),
        build_id=manifest.build_id,
        logical_artifact_id=str(manifest.logical_artifact_id),
        manifest_revision=manifest.manifest_revision,
        artifact_path=str(manifest.deliverable_path),
        artifact_hash=deck["current_pptx_hash"],
        storage_object_path=deck["artifact_storage_object_path"],
        verified=True,
        created_at=manifest.updated_at,
    )


def _mechanics(authoritative: dict[str, Any] | None = None) -> MechanicalProjection:
    record = authoritative or {"checks": {"passed": True}}
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
    return MechanicalProjection(
        status="passed",
        checks=tuple(MechanicalCheck(check_id=check_id, status="passed") for check_id in check_ids),
        authoritative_record_hash=canonical_sha256(record),
    )


def _patch_configured_runtime_prelude(
    monkeypatch: pytest.MonkeyPatch,
    *,
    mutation_store: object,
    quality_store: object,
) -> None:
    canaries = frozenset({USER_ID})
    dq2 = SimpleNamespace(
        enabled=True,
        mode="production_canary",
        canary_user_ids=canaries,
        repair_route="deck.repair.executor",
        max_campaign_wall_clock_seconds=900,
    )
    config = SimpleNamespace(
        deck_design_lift=dq2,
        deck_quality=SimpleNamespace(enabled=True, canary_user_ids=canaries),
        build_foundation=SimpleNamespace(
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=canaries,
            enable_mutation_transactions=True,
        ),
    )
    instrument = SimpleNamespace(plan=object())
    repair_plan = object()

    monkeypatch.setattr(runner_module, "get_app_config", lambda: config)
    monkeypatch.setattr(
        runner_module,
        "compile_runtime_instrument",
        lambda value: instrument if value is config else None,
    )
    monkeypatch.setattr(
        runner_module,
        "ModelRouteResolver",
        lambda value: SimpleNamespace(resolve=lambda *, route_name: repair_plan if value is config and route_name == dq2.repair_route else None),
    )
    monkeypatch.setattr(
        runner_module,
        "audit_deck_design_lift_startup",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        runner_module,
        "configured_build_mutation_store",
        lambda *, canary_user_ids: mutation_store if canary_user_ids == canaries else None,
    )
    monkeypatch.setattr(
        runner_module,
        "configured_deck_quality_run_store",
        lambda: quality_store,
    )


@pytest.mark.anyio
async def test_artifact_manifest_loader_reads_exact_immutable_revision() -> None:
    manifest = _manifest(revision=1, artifact_id=INITIAL_ARTIFACT_ID)
    artifact = _artifact(manifest)
    manifest_path = f"{_object_root()}/manifest/manifest-r1.json"
    objects = _AsyncObjects({manifest_path: canonical_json_bytes(manifest)})

    loaded = await ProductionArtifactManifestLoader(
        object_store=objects,  # type: ignore[arg-type]
    ).load_for_artifact(artifact)

    assert loaded == manifest
    assert loaded is not manifest
    assert objects.reads == [(manifest_path, 4 * 1024 * 1024)]


@pytest.mark.anyio
async def test_artifact_manifest_loader_rejects_noncanonical_or_escaped_identity() -> None:
    manifest = _manifest(revision=1, artifact_id=INITIAL_ARTIFACT_ID)
    artifact = _artifact(manifest)
    manifest_path = f"{_object_root()}/manifest/manifest-r1.json"
    objects = _AsyncObjects({manifest_path: canonical_json_bytes(manifest) + b"\n"})
    loader = ProductionArtifactManifestLoader(object_store=objects)  # type: ignore[arg-type]

    with pytest.raises(DeckDesignLiftRunnerError) as malformed:
        await loader.load_for_artifact(artifact)
    assert malformed.value.code == "artifact_manifest_invalid"

    escaped = artifact.model_copy(update={"storage_object_path": "artifacts/other/location/candidate.pptx"})
    with pytest.raises(DeckDesignLiftRunnerError) as scope:
        await loader.load_for_artifact(escaped)
    assert scope.value.code == "artifact_storage_scope_invalid"


@pytest.mark.anyio
async def test_mechanics_uses_completed_dq1_for_initial_and_materializer_record_for_candidate() -> None:
    initial_projection = _mechanics({"initial": True})
    candidate_record = {"checks": {"candidate": True}}
    candidate_projection = _mechanics(candidate_record)
    mechanical_path = f"{_object_root()}/deck_design_lift/transactions/{TRANSACTION_ID}/candidate/records/mechanical.json"
    candidate_manifest = _manifest(
        revision=2,
        artifact_id=CANDIDATE_ARTIFACT_ID,
        extra_deck={"mechanical_record_path": mechanical_path},
    )
    payload = {
        "schema_version": "sophia-deck-candidate-mechanical/v1",
        "projection": candidate_projection.model_dump(mode="json"),
        "authoritative_record": candidate_record,
    }

    class _Quality:
        calls: list[BuildArtifactVersion] = []

        async def load_completed_mechanics(
            self,
            artifact: BuildArtifactVersion,
        ) -> MechanicalProjection:
            self.calls.append(artifact)
            return initial_projection

    class _Manifests:
        async def load_for_artifact(self, artifact: BuildArtifactVersion) -> BuildManifest:
            assert artifact == _artifact(candidate_manifest)
            return candidate_manifest

    quality = _Quality()
    objects = _AsyncObjects({mechanical_path: canonical_json_bytes(payload)})
    mechanics = ProductionDeckMechanics(
        quality_adapter=quality,  # type: ignore[arg-type]
        manifests=_Manifests(),  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
    )

    initial_manifest = _manifest(revision=1, artifact_id=INITIAL_ARTIFACT_ID)
    assert (
        await mechanics.verify(
            artifact=_artifact(initial_manifest),
            campaign_run_id=CAMPAIGN_RUN_ID,
            experiment_id=EXPERIMENT_ID,
        )
        == initial_projection
    )
    assert (
        await mechanics.verify(
            artifact=_artifact(candidate_manifest),
            campaign_run_id=CAMPAIGN_RUN_ID,
            experiment_id=EXPERIMENT_ID,
        )
        == candidate_projection
    )
    assert quality.calls == [_artifact(initial_manifest)]
    assert objects.reads == [(mechanical_path, 4 * 1024 * 1024)]


@pytest.mark.anyio
async def test_candidate_mechanics_rejects_authoritative_hash_drift() -> None:
    record = {"checks": {"candidate": True}}
    projection = _mechanics(record)
    mechanical_path = f"{_object_root()}/deck_design_lift/transactions/{TRANSACTION_ID}/candidate/records/mechanical.json"
    manifest = _manifest(
        revision=2,
        artifact_id=CANDIDATE_ARTIFACT_ID,
        extra_deck={"mechanical_record_path": mechanical_path},
    )

    class _Quality:
        async def load_completed_mechanics(self, _artifact: BuildArtifactVersion) -> None:
            raise AssertionError

    class _Manifests:
        async def load_for_artifact(self, _artifact: BuildArtifactVersion) -> BuildManifest:
            return manifest

    objects = _AsyncObjects(
        {
            mechanical_path: canonical_json_bytes(
                {
                    "schema_version": "sophia-deck-candidate-mechanical/v1",
                    "projection": projection.model_dump(mode="json"),
                    "authoritative_record": {"checks": {"tampered": True}},
                }
            )
        }
    )
    mechanics = ProductionDeckMechanics(
        quality_adapter=_Quality(),  # type: ignore[arg-type]
        manifests=_Manifests(),  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
    )

    with pytest.raises(DeckDesignLiftRunnerError) as error:
        await mechanics.verify(
            artifact=_artifact(manifest),
            campaign_run_id=CAMPAIGN_RUN_ID,
            experiment_id=EXPERIMENT_ID,
        )
    assert error.value.code == "candidate_mechanics_invalid"


@pytest.mark.anyio
async def test_candidate_baseline_loader_uses_checkpoint_identity_and_verified_render_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = _manifest(revision=1, artifact_id=INITIAL_ARTIFACT_ID)
    program = SimpleNamespace(
        program_hash="b" * 64,
        initial_quality_run_id=INITIAL_QUALITY_RUN_ID,
    )
    transaction = BuildMutationTransaction.model_construct(
        transaction_id=TRANSACTION_ID,
        build_id=BUILD_ID,
        user_id=USER_ID,
        operation_id=OPERATION_ID,
        owner_thread_id=THREAD_ID,
        expected_manifest_revision=1,
        expected_artifact_version_id=INITIAL_ARTIFACT_ID,
        repair_program_hash=program.program_hash,
        initial_quality_run_id=INITIAL_QUALITY_RUN_ID,
        gate_evidence={
            "deck_design_lift_runtime": {
                "schema_version": "sophia-deck-design-lift-checkpoint/v1",
                "campaign_run_id": CAMPAIGN_RUN_ID,
                "experiment_id": EXPERIMENT_ID,
            }
        },
    )
    request = SimpleNamespace(
        transaction_id=TRANSACTION_ID,
        operation_id=OPERATION_ID,
        build_id=BUILD_ID,
        user_id=USER_ID,
        thread_id=THREAD_ID,
        baseline_manifest=manifest,
        program=program,
    )
    render_bytes = b"verified-render"
    render_hash = hashlib.sha256(render_bytes).hexdigest()
    render_path = "artifacts/quality/renders/slide-0001.png"
    record = SimpleNamespace(
        object_path=render_path,
        role="render",
        media_type="image/png",
        sha256=render_hash,
        size_bytes=len(render_bytes),
    )
    image = SimpleNamespace(
        selector="slide:1",
        path=render_path,
        sha256=render_hash,
    )
    authenticated = SimpleNamespace(
        evidence_manifest=SimpleNamespace(objects=(record,)),
        evidence_bundle=SimpleNamespace(
            snapshot=SimpleNamespace(
                renders=SimpleNamespace(slides=(image,)),
                creative_plan={"image_assets": []},
            )
        ),
    )
    projection = _mechanics({"initial": True})
    mutation_entered = threading.Event()
    mutation_release = threading.Event()
    mutation_threads: list[int] = []

    class _Mutations:
        def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction:
            assert (transaction_id, user_id) == (TRANSACTION_ID, USER_ID)
            mutation_threads.append(threading.get_ident())
            mutation_entered.set()
            assert mutation_release.wait(timeout=2)
            return transaction

    class _Quality:
        requests: list[Any] = []

        async def load_completed_mechanics(
            self,
            artifact: BuildArtifactVersion,
        ) -> MechanicalProjection:
            assert artifact == _artifact(manifest)
            return projection

        async def load_initial_snapshot(self, blind_request: Any) -> Any:
            self.requests.append(blind_request)
            return authenticated

    sentinel = object()
    projected: dict[str, Any] = {}

    def project(authenticated_value: Any, **kwargs: Any) -> object:
        projected.update(authenticated=authenticated_value, **kwargs)
        return sentinel

    monkeypatch.setattr(runner_module, "baseline_from_authenticated_snapshot", project)
    objects = _AsyncObjects({render_path: render_bytes})
    quality = _Quality()
    loader = ProductionDeckCandidateBaselineLoader(
        mutation_store=_Mutations(),  # type: ignore[arg-type]
        quality_adapter=quality,  # type: ignore[arg-type]
        object_store=objects,  # type: ignore[arg-type]
        instrument=SimpleNamespace(lock=object()),  # type: ignore[arg-type]
    )

    loaded: list[object] = []

    async def load_baseline() -> None:
        loaded.append(await loader.load(request))  # type: ignore[arg-type]

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(load_baseline)
        while not mutation_entered.is_set():
            await anyio.sleep(0)
        # The coroutine remains responsive while the synchronous Supabase RPC
        # is blocked in its worker thread.
        await anyio.sleep(0)
        assert loaded == []
        mutation_release.set()

    assert loaded == [sentinel]
    assert mutation_threads == [mutation_threads[0]]
    assert mutation_threads[0] != threading.get_ident()
    assert len(quality.requests) == 1
    blind_request = quality.requests[0]
    assert blind_request.campaign_run_id == CAMPAIGN_RUN_ID
    assert blind_request.experiment_id == EXPERIMENT_ID
    assert blind_request.mechanics == projection
    assert projected["authenticated"] is authenticated
    assert projected["render_contents"] == {"slide:1": render_bytes}
    assert projected["visual_assets"] == ()


@pytest.mark.anyio
async def test_configured_graph_runtime_closes_created_resources_after_intermediate_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    event_loop_thread = threading.get_ident()
    calls: list[tuple[str, int]] = []

    class _MutationStore:
        def close(self) -> None:
            calls.append(("mutation", threading.get_ident()))

    class _QualityStore:
        async def aclose(self) -> None:
            calls.append(("quality", threading.get_ident()))

    mutation_store = _MutationStore()
    quality_store = _QualityStore()
    _patch_configured_runtime_prelude(
        monkeypatch,
        mutation_store=mutation_store,
        quality_store=quality_store,
    )
    monkeypatch.setattr(runner_module, "SupabaseImmutableObjectStore", object)

    def fail_async_object_store() -> None:
        raise RuntimeError("intermediate construction failed")

    monkeypatch.setattr(
        runner_module,
        "AsyncSupabaseImmutableObjectStore",
        fail_async_object_store,
    )

    with pytest.raises(RuntimeError, match="intermediate construction failed"):
        await anyio.to_thread.run_sync(runner_module.configured_graph_runtime)

    assert [name for name, _thread in calls] == ["quality", "mutation"]
    assert calls[0][1] == event_loop_thread
    assert calls[1][1] != event_loop_thread


@pytest.mark.anyio
async def test_configured_graph_runtime_cleanup_attempts_every_resource_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    event_loop_thread = threading.get_ident()
    calls: list[tuple[str, int]] = []

    class _SyncResource:
        def __init__(self, name: str) -> None:
            self.name = name

        def close(self) -> None:
            calls.append((self.name, threading.get_ident()))

    class _AsyncResource:
        def __init__(self, name: str, *, fail: bool = False) -> None:
            self.name = name
            self.fail = fail

        async def aclose(self) -> None:
            calls.append((self.name, threading.get_ident()))
            if self.fail:
                raise RuntimeError("close failed")

    mutation_store = _SyncResource("mutation")
    quality_store = _AsyncResource("quality")
    async_objects = _AsyncResource("objects", fail=True)
    trace_factory = _SyncResource("trace")
    _patch_configured_runtime_prelude(
        monkeypatch,
        mutation_store=mutation_store,
        quality_store=quality_store,
    )
    monkeypatch.setattr(runner_module, "SupabaseImmutableObjectStore", object)
    monkeypatch.setattr(
        runner_module,
        "AsyncSupabaseImmutableObjectStore",
        lambda: async_objects,
    )
    monkeypatch.setattr(
        runner_module,
        "configured_deck_repair_trace_factory",
        lambda: trace_factory,
    )

    def node(*_args: Any, **_kwargs: Any) -> object:
        return object()

    for name in (
        "ProductionDeckManifestRepository",
        "ProductionArtifactManifestLoader",
        "DurableDeckQualityEvidenceAdapter",
        "ProductionDeckMechanics",
        "ProductionRepairAuthorContextLoader",
    ):
        monkeypatch.setattr(runner_module, name, node)
    monkeypatch.setattr(runner_module, "DeckRepairModelInvoker", object)

    def fail_author(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("late construction failed")

    monkeypatch.setattr(runner_module, "ProductionDeckRepairAuthor", fail_author)

    with pytest.raises(DeckDesignLiftRunnerError) as error:
        await anyio.to_thread.run_sync(runner_module.configured_graph_runtime)

    assert error.value.code == "configured_runtime_cleanup_failed"
    assert [name for name, _thread in calls] == [
        "quality",
        "objects",
        "trace",
        "mutation",
    ]
    assert all(thread == event_loop_thread for _name, thread in calls[:2])
    assert all(thread != event_loop_thread for _name, thread in calls[2:])
    assert {name: [item[0] for item in calls].count(name) for name, _thread in calls} == {
        "quality": 1,
        "objects": 1,
        "trace": 1,
        "mutation": 1,
    }


def test_configured_graph_runtime_wires_one_exact_canary_composition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    canaries = frozenset({USER_ID})
    dq2 = SimpleNamespace(
        enabled=True,
        mode="production_canary",
        canary_user_ids=canaries,
        repair_route="deck.repair.executor",
        max_campaign_wall_clock_seconds=900,
    )
    config = SimpleNamespace(
        deck_design_lift=dq2,
        deck_quality=SimpleNamespace(enabled=True, canary_user_ids=canaries),
        build_foundation=SimpleNamespace(
            manifest_mode="canary_enforce",
            enforce_canary_user_ids=canaries,
            enable_mutation_transactions=True,
        ),
    )
    judge_plan = SimpleNamespace(route_name="deck.judge.visual")
    repair_plan = SimpleNamespace(route_name="deck.repair.executor")
    instrument = SimpleNamespace(plan=judge_plan)
    created: dict[str, list[SimpleNamespace]] = {}

    def factory(name: str):
        def build(*args: Any, **kwargs: Any) -> SimpleNamespace:
            node = SimpleNamespace(name=name, args=args, kwargs=kwargs)
            created.setdefault(name, []).append(node)
            return node

        return build

    class _Resolver:
        def __init__(self, value: object) -> None:
            assert value is config

        def resolve(self, *, route_name: str) -> object:
            assert route_name == "deck.repair.executor"
            return repair_plan

    audits: list[dict[str, Any]] = []
    mutation_store = SimpleNamespace(name="mutations")
    quality_store = SimpleNamespace(name="quality-store")
    sync_objects = SimpleNamespace(name="sync-objects")
    async_objects = SimpleNamespace(name="async-objects")
    repair_trace_factory = SimpleNamespace(name="repair-trace-factory")

    monkeypatch.setattr(runner_module, "get_app_config", lambda: config)
    monkeypatch.setattr(runner_module, "compile_runtime_instrument", lambda value: instrument)
    monkeypatch.setattr(runner_module, "ModelRouteResolver", _Resolver)
    monkeypatch.setattr(
        runner_module,
        "audit_deck_design_lift_startup",
        lambda value, **kwargs: audits.append({"config": value, **kwargs}),
    )
    monkeypatch.setattr(
        runner_module,
        "configured_build_mutation_store",
        lambda *, canary_user_ids: (mutation_store if canary_user_ids == canaries else None),
    )
    monkeypatch.setattr(
        runner_module,
        "configured_deck_quality_run_store",
        lambda: quality_store,
    )
    monkeypatch.setattr(runner_module, "SupabaseImmutableObjectStore", lambda: sync_objects)
    monkeypatch.setattr(
        runner_module,
        "AsyncSupabaseImmutableObjectStore",
        lambda: async_objects,
    )
    monkeypatch.setattr(
        runner_module,
        "configured_deck_repair_trace_factory",
        lambda: repair_trace_factory,
    )
    for name in (
        "ProductionDeckManifestRepository",
        "ProductionArtifactManifestLoader",
        "DurableDeckQualityEvidenceAdapter",
        "ProductionDeckMechanics",
        "ProductionRepairAuthorContextLoader",
        "ProductionDeckRepairAuthor",
        "DurableDeckRepairExecutor",
        "ProductionDeckCandidateBaselineLoader",
        "ProductionDeckCandidateCompiler",
        "DurableDeckCandidateMaterializer",
        "DeckDesignLiftRuntime",
        "ProductionDeckDesignLiftRequestFactory",
    ):
        monkeypatch.setattr(runner_module, name, factory(name))
    monkeypatch.setattr(runner_module, "DeckRepairModelInvoker", factory("DeckRepairModelInvoker"))

    runtime = runner_module.configured_graph_runtime()

    assert isinstance(runtime, DeckDesignLiftGraphRuntime)
    assert runtime.canary_user_ids == canaries
    assert runtime.timeout_seconds == 900
    assert audits == [
        {
            "config": dq2,
            "judge_plan": judge_plan,
            "repair_plan": repair_plan,
            "manifest_mode": "canary_enforce",
            "enforce_canary_user_ids": canaries,
            "mutation_transactions_enabled": True,
        }
    ]
    quality_kwargs = created["DurableDeckQualityEvidenceAdapter"][0].kwargs
    assert quality_kwargs["store"] is quality_store
    assert quality_kwargs["objects"] is async_objects
    assert quality_kwargs["candidate_timeout_seconds"] == 420.0
    assert quality_kwargs["poll_interval_seconds"] == 1.0
    context_kwargs = created["ProductionRepairAuthorContextLoader"][0].kwargs
    assert context_kwargs["object_store"] is async_objects
    materializer_kwargs = created["DurableDeckCandidateMaterializer"][0].kwargs
    assert materializer_kwargs["object_store"] is async_objects
    author_kwargs = created["ProductionDeckRepairAuthor"][0].kwargs
    assert author_kwargs["trace_factory"] is repair_trace_factory
    controller_kwargs = created["DeckDesignLiftRuntime"][0].kwargs
    assert controller_kwargs["mutation_store"] is mutation_store
    assert controller_kwargs["atomic_committer"] is mutation_store
    assert runtime.controller is created["DeckDesignLiftRuntime"][0]
    assert runtime.request_factory is created["ProductionDeckDesignLiftRequestFactory"][0]
    assert runtime._sync_resources == (mutation_store, repair_trace_factory)


def test_configured_graph_runtime_fails_closed_on_scope_or_storage_drift(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dq2 = SimpleNamespace(
        enabled=True,
        mode="production_canary",
        canary_user_ids=frozenset({USER_ID}),
        repair_route="deck.repair.executor",
        max_campaign_wall_clock_seconds=900,
    )
    config = SimpleNamespace(
        deck_design_lift=dq2,
        deck_quality=SimpleNamespace(
            enabled=True,
            canary_user_ids=frozenset({"different-user"}),
        ),
    )
    monkeypatch.setattr(runner_module, "get_app_config", lambda: config)
    with pytest.raises(RuntimeError, match="same exact canary scope"):
        runner_module.configured_graph_runtime()

    config.deck_quality.canary_user_ids = dq2.canary_user_ids
    config.build_foundation = SimpleNamespace(
        manifest_mode="canary_enforce",
        enforce_canary_user_ids=dq2.canary_user_ids,
        enable_mutation_transactions=True,
    )
    instrument = SimpleNamespace(plan=object())
    monkeypatch.setattr(runner_module, "compile_runtime_instrument", lambda _value: instrument)
    monkeypatch.setattr(
        runner_module,
        "ModelRouteResolver",
        lambda _value: SimpleNamespace(resolve=lambda **_kwargs: object()),
    )
    monkeypatch.setattr(runner_module, "audit_deck_design_lift_startup", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner_module, "configured_build_mutation_store", lambda **_kwargs: None)
    with pytest.raises(RuntimeError, match="mutation storage"):
        runner_module.configured_graph_runtime()


@pytest.mark.anyio
async def test_configured_runtime_closes_all_owned_clients_in_reverse_order() -> None:
    calls: list[str] = []

    class _AsyncResource:
        def __init__(self, name: str) -> None:
            self.name = name

        async def aclose(self) -> None:
            calls.append(self.name)

    class _SyncResource:
        def close(self) -> None:
            calls.append("sync")

    runtime = ConfiguredDeckDesignLiftGraphRuntime(
        controller=object(),
        request_factory=object(),
        canary_user_ids=frozenset({USER_ID}),
        _async_resources=(
            _AsyncResource("async-first"),
            _AsyncResource("async-second"),
        ),
        _sync_resources=(_SyncResource(),),
    )

    await runtime.aclose()

    assert calls == ["async-second", "async-first", "sync"]
