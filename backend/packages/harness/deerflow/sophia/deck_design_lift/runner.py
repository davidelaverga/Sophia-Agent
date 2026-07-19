from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import partial
from typing import NoReturn

import anyio
from pydantic import ValidationError

from deerflow.config.app_config import get_app_config
from deerflow.config.deck_design_lift_config import audit_deck_design_lift_startup
from deerflow.models.route_resolver import ModelRouteResolver
from deerflow.sophia.build_manifest import BuildManifest, manifest_components_by_selector
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.candidate_compiler import (
    MAX_BASELINE_ASSET_BYTES,
    MAX_BASELINE_RENDER_BYTES,
    BaselineVisualAsset,
    DeckCandidateBaseline,
    DeckCandidateCompilationError,
    ProductionDeckCandidateCompiler,
    baseline_from_authenticated_snapshot,
)
from deerflow.sophia.deck_design_lift.graph import DeckDesignLiftGraphRuntime
from deerflow.sophia.deck_design_lift.invoker import DeckRepairModelInvoker
from deerflow.sophia.deck_design_lift.materializer import (
    DeckCandidateCompileRequest,
    DurableDeckCandidateMaterializer,
)
from deerflow.sophia.deck_design_lift.production_storage import (
    ProductionDeckDesignLiftRequestFactory,
    ProductionDeckManifestRepository,
    canonical_manifest_source_path,
    foundation_object_root,
)
from deerflow.sophia.deck_design_lift.quality_adapter import (
    AuthenticatedDeckQualitySnapshot,
    DurableDeckQualityEvidenceAdapter,
)
from deerflow.sophia.deck_design_lift.repair_author import ProductionDeckRepairAuthor
from deerflow.sophia.deck_design_lift.repair_context import (
    ProductionRepairAuthorContextLoader,
)
from deerflow.sophia.deck_design_lift.repair_executor import DurableDeckRepairExecutor
from deerflow.sophia.deck_design_lift.repair_tracing import (
    configured_deck_repair_trace_factory,
)
from deerflow.sophia.deck_design_lift.runtime import (
    BlindDeckJudgmentRequest,
    DeckDesignLiftRuntime,
)
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.instrument import (
    DeckQualityRuntimeInstrument,
    compile_runtime_instrument,
)
from deerflow.sophia.deck_quality.persistence import configured_deck_quality_run_store
from deerflow.sophia.deck_quality.schemas import MechanicalProjection
from deerflow.sophia.storage.async_supabase_object_store import (
    AsyncSupabaseImmutableObjectStore,
)
from deerflow.sophia.storage.build_mutation_store import (
    SupabaseBuildMutationStore,
    configured_build_mutation_store,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    SupabaseImmutableObjectStore,
    normalize_object_path,
    safe_object_path_segment,
)

_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_MAX_MECHANICAL_RECORD_BYTES = 4 * 1024 * 1024
_RUNTIME_CHECKPOINT_KEY = "deck_design_lift_runtime"
_RUNTIME_CHECKPOINT_SCHEMA = "sophia-deck-design-lift-checkpoint/v1"
_INITIAL_MANIFEST_REVISION = 1
_CANDIDATE_MANIFEST_REVISION = 2
_CANDIDATE_QUALITY_TIMEOUT_SECONDS = 420.0
_QUALITY_POLL_INTERVAL_SECONDS = 1.0


class DeckDesignLiftRunnerError(RuntimeError):
    """Content-free failure while composing or loading production DQ-2 state."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _fail(code: str) -> NoReturn:
    raise DeckDesignLiftRunnerError(code)


async def _run_sync[ValueT](
    function: Callable[..., ValueT],
    /,
    *args: object,
    **kwargs: object,
) -> ValueT:
    return await anyio.to_thread.run_sync(
        partial(function, *args, **kwargs),
        abandon_on_cancel=False,
    )


async def _close_configured_resources(
    async_resources: tuple[object, ...],
    sync_resources: tuple[object, ...],
) -> None:
    """Close one configured ownership set without abandoning later resources."""

    failed = False
    for resource in reversed(async_resources):
        close = getattr(resource, "aclose", None)
        if not callable(close):
            failed = True
            continue
        try:
            await close()
        except Exception:
            failed = True
    for resource in reversed(sync_resources):
        close = getattr(resource, "close", None)
        if not callable(close):
            failed = True
            continue
        try:
            await _run_sync(close)
        except Exception:
            failed = True
    if failed:
        raise DeckDesignLiftRunnerError("configured_runtime_cleanup_failed")


@dataclass(frozen=True, slots=True)
class ConfiguredDeckDesignLiftGraphRuntime(DeckDesignLiftGraphRuntime):
    """A graph runtime that owns and can close its configured service clients."""

    _async_resources: tuple[object, ...] = field(
        default=(),
        repr=False,
        compare=False,
    )
    _sync_resources: tuple[object, ...] = field(
        default=(),
        repr=False,
        compare=False,
    )

    async def aclose(self) -> None:
        await _close_configured_resources(
            self._async_resources,
            self._sync_resources,
        )


def _canonical_manifest(raw: bytes) -> BuildManifest:
    try:
        json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
        )
        manifest = BuildManifest.model_validate_json(raw)
        if canonical_json_bytes(manifest) != raw:
            raise ValueError
        manifest_components_by_selector(manifest)
        return manifest
    except (UnicodeError, ValidationError, ValueError):
        _fail("artifact_manifest_invalid")


def _artifact_object_root(artifact: BuildArtifactVersion) -> str:
    try:
        build_id = safe_object_path_segment(artifact.build_id, default="build")
        version_id = safe_object_path_segment(artifact.version_id, default="artifact")
        normalized = normalize_object_path(artifact.storage_object_path)
    except (TypeError, ValueError):
        _fail("artifact_storage_scope_invalid")
    if build_id != artifact.build_id or version_id != artifact.version_id or normalized != artifact.storage_object_path:
        _fail("artifact_storage_scope_invalid")
    marker = f"/foundation/.builder/builds/{build_id}/artifacts/{version_id}/"
    if normalized.count(marker) != 1 or not normalized.startswith("artifacts/"):
        _fail("artifact_storage_scope_invalid")
    prefix, filename = normalized.split(marker, 1)
    if not prefix or not filename or "/" in filename:
        _fail("artifact_storage_scope_invalid")
    return f"{prefix}/foundation/.builder/builds/{build_id}"


def _manifest_artifact(manifest: BuildManifest) -> BuildArtifactVersion:
    deck = manifest.format_extensions.get("deck")
    if not isinstance(deck, Mapping) or manifest.logical_artifact_id is None or manifest.current_artifact_version_id is None or manifest.deliverable_path is None:
        _fail("artifact_manifest_identity_invalid")
    artifact_hash = deck.get("current_pptx_hash")
    object_path = deck.get("artifact_storage_object_path")
    if not isinstance(artifact_hash, str) or len(artifact_hash) != 64 or any(character not in "0123456789abcdef" for character in artifact_hash) or not isinstance(object_path, str):
        _fail("artifact_manifest_identity_invalid")
    try:
        artifact = BuildArtifactVersion(
            version_id=manifest.current_artifact_version_id,
            build_id=manifest.build_id,
            logical_artifact_id=manifest.logical_artifact_id,
            manifest_revision=manifest.manifest_revision,
            artifact_path=manifest.deliverable_path,
            artifact_hash=artifact_hash,
            storage_object_path=object_path,
            verified=True,
            created_at=manifest.updated_at,
        )
        _artifact_object_root(artifact)
        return artifact
    except DeckDesignLiftRunnerError:
        raise
    except (TypeError, ValidationError, ValueError):
        _fail("artifact_manifest_identity_invalid")


def _validated_artifact_manifest(
    raw: bytes,
    artifact: BuildArtifactVersion,
) -> BuildManifest:
    manifest = _canonical_manifest(raw)
    deck = manifest.format_extensions.get("deck")
    if (
        manifest.build_id != artifact.build_id
        or manifest.manifest_revision != artifact.manifest_revision
        or manifest.logical_artifact_id != artifact.logical_artifact_id
        or manifest.current_artifact_version_id != artifact.version_id
        or manifest.deliverable_path != artifact.artifact_path
        or manifest.status != "complete"
        or manifest.format != "pptx"
        or not isinstance(deck, Mapping)
        or deck.get("current_pptx_hash") != artifact.artifact_hash
        or deck.get("artifact_storage_object_path") != artifact.storage_object_path
    ):
        _fail("artifact_manifest_identity_invalid")
    return manifest.model_copy(deep=True)


class ProductionArtifactManifestLoader:
    """Load the exact immutable manifest revision addressed by one artifact."""

    def __init__(self, *, object_store: AsyncSupabaseImmutableObjectStore) -> None:
        if not callable(getattr(object_store, "read_bounded", None)):
            raise ValueError("artifact manifest loader requires bounded object reads")
        self._objects = object_store

    async def load_for_artifact(self, artifact: BuildArtifactVersion) -> BuildManifest:
        if not isinstance(artifact, BuildArtifactVersion) or not artifact.verified:
            _fail("artifact_identity_invalid")
        object_root = await _run_sync(_artifact_object_root, artifact)
        manifest_path = f"{object_root}/manifest/manifest-r{artifact.manifest_revision}.json"
        try:
            raw = await self._objects.read_bounded(
                manifest_path,
                max_bytes=_MAX_MANIFEST_BYTES,
            )
        except Exception:
            _fail("artifact_manifest_unavailable")
        if not isinstance(raw, bytes) or not raw or len(raw) > _MAX_MANIFEST_BYTES:
            _fail("artifact_manifest_unavailable")
        return await _run_sync(_validated_artifact_manifest, raw, artifact)


def _candidate_mechanical_path(
    manifest: BuildManifest,
    artifact: BuildArtifactVersion,
) -> str:
    deck = manifest.format_extensions.get("deck")
    path = deck.get("mechanical_record_path") if isinstance(deck, Mapping) else None
    try:
        normalized_path = normalize_object_path(path) if isinstance(path, str) else ""
    except ValueError:
        normalized_path = ""
    expected_prefix = f"{_artifact_object_root(artifact)}/deck_design_lift/transactions/"
    if normalized_path != path or not normalized_path.startswith(expected_prefix) or not normalized_path.endswith("/candidate/records/mechanical.json"):
        _fail("candidate_mechanics_path_invalid")
    return normalized_path


def _candidate_mechanical_projection(raw: object) -> MechanicalProjection:
    try:
        payload = json.loads(raw.decode("utf-8")) if isinstance(raw, bytes) else None
        if not isinstance(payload, dict) or canonical_json_bytes(payload) != raw:
            raise ValueError
        if payload.get("schema_version") != "sophia-deck-candidate-mechanical/v1":
            raise ValueError
        projection = MechanicalProjection.model_validate(payload.get("projection"))
        authoritative = payload.get("authoritative_record")
        if not isinstance(authoritative, dict) or canonical_sha256(authoritative) != projection.authoritative_record_hash:
            raise ValueError
        return projection
    except Exception:
        _fail("candidate_mechanics_invalid")


class ProductionDeckMechanics:
    """Authenticate DQ-1 baseline mechanics and immutable candidate mechanics."""

    def __init__(
        self,
        *,
        quality_adapter: DurableDeckQualityEvidenceAdapter,
        manifests: ProductionArtifactManifestLoader,
        object_store: AsyncSupabaseImmutableObjectStore,
    ) -> None:
        if not callable(getattr(quality_adapter, "load_completed_mechanics", None)):
            raise ValueError("mechanics requires authenticated completed DQ-1 evidence")
        self._quality = quality_adapter
        self._manifests = manifests
        self._objects = object_store

    async def verify(
        self,
        *,
        artifact: BuildArtifactVersion,
        campaign_run_id: str,
        experiment_id: str,
    ) -> MechanicalProjection:
        del campaign_run_id, experiment_id
        if artifact.manifest_revision == _INITIAL_MANIFEST_REVISION:
            projection = await self._quality.load_completed_mechanics(artifact)
            if not isinstance(projection, MechanicalProjection):
                _fail("initial_mechanics_invalid")
            return projection
        if artifact.manifest_revision != _CANDIDATE_MANIFEST_REVISION:
            _fail("candidate_manifest_revision_invalid")
        manifest = await self._manifests.load_for_artifact(artifact)
        normalized_path = await _run_sync(
            _candidate_mechanical_path,
            manifest,
            artifact,
        )
        try:
            raw = await self._objects.read_bounded(
                normalized_path,
                max_bytes=_MAX_MECHANICAL_RECORD_BYTES,
            )
        except Exception:
            _fail("candidate_mechanics_invalid")
        return await _run_sync(_candidate_mechanical_projection, raw)


def _checkpoint_identity(
    transaction: BuildMutationTransaction,
    request: DeckCandidateCompileRequest,
) -> tuple[str, str]:
    value = transaction.gate_evidence.get(_RUNTIME_CHECKPOINT_KEY)
    if not isinstance(value, Mapping):
        _fail("candidate_baseline_checkpoint_invalid")
    campaign_run_id = value.get("campaign_run_id")
    experiment_id = value.get("experiment_id")
    if (
        value.get("schema_version") != _RUNTIME_CHECKPOINT_SCHEMA
        or not isinstance(campaign_run_id, str)
        or not isinstance(experiment_id, str)
        or transaction.transaction_id != request.transaction_id
        or transaction.operation_id != request.operation_id
        or transaction.build_id != request.build_id
        or transaction.user_id != request.user_id
        or transaction.owner_thread_id != request.thread_id
        or transaction.expected_manifest_revision != request.baseline_manifest.manifest_revision
        or transaction.expected_artifact_version_id != request.baseline_manifest.current_artifact_version_id
        or transaction.repair_program_hash != request.program.program_hash
        or transaction.initial_quality_run_id != request.program.initial_quality_run_id
    ):
        _fail("candidate_baseline_checkpoint_invalid")
    return campaign_run_id, experiment_id


def _verified_object_bytes(
    raw: object,
    *,
    expected_hash: str,
    expected_size: int,
) -> bytes:
    if not isinstance(raw, bytes) or len(raw) != expected_size or hashlib.sha256(raw).hexdigest() != expected_hash:
        _fail("candidate_baseline_object_invalid")
    return raw


async def _read_verified_object(
    objects: AsyncSupabaseImmutableObjectStore,
    *,
    path: str,
    expected_hash: str,
    expected_size: int,
    max_bytes: int,
) -> bytes:
    if expected_size < 1 or expected_size > max_bytes:
        _fail("candidate_baseline_object_invalid")
    try:
        raw = await objects.read_bounded(path, max_bytes=max_bytes)
    except Exception:
        _fail("candidate_baseline_object_unavailable")
    return await _run_sync(
        _verified_object_bytes,
        raw,
        expected_hash=expected_hash,
        expected_size=expected_size,
    )


@dataclass(frozen=True, slots=True)
class _BaselineAssetDescriptor:
    asset_id: str
    selector: str
    path: str


def _baseline_asset_descriptors(
    request: DeckCandidateCompileRequest,
    authenticated: AuthenticatedDeckQualitySnapshot,
) -> tuple[_BaselineAssetDescriptor, ...]:
    raw_assets = authenticated.evidence_bundle.snapshot.creative_plan.get("image_assets")
    if not isinstance(raw_assets, list):
        _fail("candidate_baseline_asset_inventory_invalid")
    if not raw_assets:
        return ()
    components = manifest_components_by_selector(request.baseline_manifest)
    object_root = foundation_object_root(
        user_id=request.user_id,
        thread_id=request.thread_id,
        build_id=request.build_id,
    )
    result: list[_BaselineAssetDescriptor] = []
    seen: set[tuple[str, str]] = set()
    for item in raw_assets:
        if not isinstance(item, Mapping):
            _fail("candidate_baseline_asset_inventory_invalid")
        asset_id = item.get("asset_id")
        selector = item.get("slide_selector")
        component = components.get(selector) if isinstance(selector, str) else None
        if not isinstance(asset_id, str) or not isinstance(selector, str) or component is None or len(component.asset_paths) != 1 or (asset_id, selector) in seen:
            _fail("candidate_baseline_asset_inventory_invalid")
        seen.add((asset_id, selector))
        result.append(
            _BaselineAssetDescriptor(
                asset_id=asset_id,
                selector=selector,
                path=canonical_manifest_source_path(
                    component.asset_paths[0],
                    object_root=object_root,
                    build_id=request.build_id,
                    thread_id=request.thread_id,
                ),
            )
        )
    return tuple(result)


def _baseline_visual_asset(
    descriptor: _BaselineAssetDescriptor,
    content: object,
) -> BaselineVisualAsset:
    if not isinstance(content, bytes) or not content:
        _fail("candidate_baseline_asset_invalid")
    try:
        return BaselineVisualAsset(
            asset_id=descriptor.asset_id,
            selector=descriptor.selector,
            content=content,
            sha256=hashlib.sha256(content).hexdigest(),
        )
    except Exception:
        _fail("candidate_baseline_asset_invalid")


async def _baseline_visual_assets(
    *,
    request: DeckCandidateCompileRequest,
    authenticated: AuthenticatedDeckQualitySnapshot,
    objects: AsyncSupabaseImmutableObjectStore,
) -> tuple[BaselineVisualAsset, ...]:
    descriptors = await _run_sync(
        _baseline_asset_descriptors,
        request,
        authenticated,
    )
    result: list[BaselineVisualAsset] = []
    for descriptor in descriptors:
        try:
            content = await objects.read_bounded(
                descriptor.path,
                max_bytes=MAX_BASELINE_ASSET_BYTES,
            )
            result.append(
                await _run_sync(
                    _baseline_visual_asset,
                    descriptor,
                    content,
                )
            )
        except DeckDesignLiftRunnerError:
            raise
        except Exception:
            _fail("candidate_baseline_asset_invalid")
    return tuple(result)


@dataclass(frozen=True, slots=True)
class _BaselineRenderDescriptor:
    selector: str
    path: str
    sha256: str
    size_bytes: int


def _baseline_identity(
    transaction: BuildMutationTransaction,
    request: DeckCandidateCompileRequest,
) -> tuple[str, str, BuildArtifactVersion]:
    campaign_run_id, experiment_id = _checkpoint_identity(transaction, request)
    return (
        campaign_run_id,
        experiment_id,
        _manifest_artifact(request.baseline_manifest),
    )


def _baseline_render_descriptors(
    authenticated: AuthenticatedDeckQualitySnapshot,
) -> tuple[_BaselineRenderDescriptor, ...]:
    records = {item.object_path: item for item in authenticated.evidence_manifest.objects}
    descriptors: list[_BaselineRenderDescriptor] = []
    for image in authenticated.evidence_bundle.snapshot.renders.slides:
        selector = str(image.selector)
        record = records.get(image.path)
        if record is None or record.role != "render" or record.media_type != "image/png" or record.sha256 != image.sha256:
            _fail("candidate_baseline_render_inventory_invalid")
        descriptors.append(
            _BaselineRenderDescriptor(
                selector=selector,
                path=image.path,
                sha256=image.sha256,
                size_bytes=record.size_bytes,
            )
        )
    return tuple(descriptors)


class ProductionDeckCandidateBaselineLoader:
    """Project authenticated revision-one DQ-1 evidence into compiler inputs."""

    def __init__(
        self,
        *,
        mutation_store: SupabaseBuildMutationStore,
        quality_adapter: DurableDeckQualityEvidenceAdapter,
        object_store: AsyncSupabaseImmutableObjectStore,
        instrument: DeckQualityRuntimeInstrument,
    ) -> None:
        self._mutations = mutation_store
        self._quality = quality_adapter
        self._objects = object_store
        self._instrument = instrument

    async def load(self, request: DeckCandidateCompileRequest) -> DeckCandidateBaseline:
        try:
            transaction = await _run_sync(
                self._mutations.load,
                transaction_id=request.transaction_id,
                user_id=request.user_id,
            )
        except Exception:
            raise DeckCandidateCompilationError("baseline_unavailable") from None
        if not isinstance(transaction, BuildMutationTransaction):
            raise DeckCandidateCompilationError("baseline_invalid")
        try:
            campaign_run_id, experiment_id, artifact = await _run_sync(
                _baseline_identity,
                transaction,
                request,
            )
            mechanics = await self._quality.load_completed_mechanics(artifact)
            authenticated = await self._quality.load_initial_snapshot(
                BlindDeckJudgmentRequest(
                    campaign_run_id=campaign_run_id,
                    experiment_id=experiment_id,
                    build_id=request.build_id,
                    artifact=artifact,
                    mechanics=mechanics,
                )
            )
            descriptors = await _run_sync(
                _baseline_render_descriptors,
                authenticated,
            )
            render_contents: dict[str, bytes] = {}
            for descriptor in descriptors:
                render_contents[descriptor.selector] = await _read_verified_object(
                    self._objects,
                    path=descriptor.path,
                    expected_hash=descriptor.sha256,
                    expected_size=descriptor.size_bytes,
                    max_bytes=MAX_BASELINE_RENDER_BYTES,
                )
            assets = await _baseline_visual_assets(
                request=request,
                authenticated=authenticated,
                objects=self._objects,
            )
            return await _run_sync(
                baseline_from_authenticated_snapshot,
                authenticated,
                instrument=self._instrument,
                render_contents=render_contents,
                visual_assets=assets,
            )
        except DeckCandidateCompilationError:
            raise
        except Exception:
            raise DeckCandidateCompilationError("baseline_invalid") from None


def configured_graph_runtime() -> ConfiguredDeckDesignLiftGraphRuntime:
    """Compose the fail-closed production DQ-2 graph from configured adapters."""

    config = get_app_config()
    dq2 = config.deck_design_lift
    if not dq2.enabled or dq2.mode != "production_canary":
        raise RuntimeError("DQ-2 graph cannot start while deck design lift is disabled")
    if not config.deck_quality.enabled:
        raise RuntimeError("DQ-2 graph requires enabled DQ-1 quality evidence")
    if dq2.canary_user_ids != config.deck_quality.canary_user_ids:
        raise RuntimeError("DQ-2 and DQ-1 require the same exact canary scope")

    instrument = compile_runtime_instrument(config)
    repair_plan = ModelRouteResolver(config).resolve(route_name=dq2.repair_route)
    audit_deck_design_lift_startup(
        dq2,
        judge_plan=instrument.plan,
        repair_plan=repair_plan,
        manifest_mode=config.build_foundation.manifest_mode,
        enforce_canary_user_ids=config.build_foundation.enforce_canary_user_ids,
        mutation_transactions_enabled=config.build_foundation.enable_mutation_transactions,
    )

    async_resources: list[object] = []
    sync_resources: list[object] = []
    try:
        mutation_store = configured_build_mutation_store(
            canary_user_ids=dq2.canary_user_ids,
        )
        if mutation_store is None:
            raise RuntimeError("DQ-2 durable mutation storage is not configured")
        sync_resources.append(mutation_store)

        quality_store = configured_deck_quality_run_store()
        if quality_store is None:
            raise RuntimeError("DQ-2 durable quality storage is not configured")
        async_resources.append(quality_store)

        sync_objects = SupabaseImmutableObjectStore()
        async_objects = AsyncSupabaseImmutableObjectStore()
        # Preserve the runtime's established ownership order: its reverse-order
        # close releases the quality store before the object store.
        async_resources.insert(0, async_objects)
        manifest_repository = ProductionDeckManifestRepository(
            mutation_store=mutation_store,
            object_store=sync_objects,
        )
        artifact_manifests = ProductionArtifactManifestLoader(object_store=async_objects)
        quality = DurableDeckQualityEvidenceAdapter(
            store=quality_store,
            objects=async_objects,
            instrument=instrument,
            manifests=artifact_manifests,
            clock=lambda: datetime.now(UTC),
            sleep=anyio.sleep,
            candidate_timeout_seconds=_CANDIDATE_QUALITY_TIMEOUT_SECONDS,
            poll_interval_seconds=_QUALITY_POLL_INTERVAL_SECONDS,
        )
        mechanics = ProductionDeckMechanics(
            quality_adapter=quality,
            manifests=artifact_manifests,
            object_store=async_objects,
        )
        context_loader = ProductionRepairAuthorContextLoader(
            manifest_repository=manifest_repository,
            mutation_store=mutation_store,
            object_store=async_objects,
            quality_adapter=quality,
        )
        repair_trace_factory = configured_deck_repair_trace_factory()
        sync_resources.append(repair_trace_factory)
        author = ProductionDeckRepairAuthor(
            context_loader=context_loader,
            invoker=DeckRepairModelInvoker(),
            plan=repair_plan,
            trace_factory=repair_trace_factory,
        )
        repair_executor = DurableDeckRepairExecutor(
            object_store=async_objects,
            author=author,
        )
        baseline_loader = ProductionDeckCandidateBaselineLoader(
            mutation_store=mutation_store,
            quality_adapter=quality,
            object_store=async_objects,
            instrument=instrument,
        )
        compiler = ProductionDeckCandidateCompiler(baseline_loader=baseline_loader)
        materializer = DurableDeckCandidateMaterializer(
            manifest_repository=manifest_repository,
            object_store=async_objects,
            compiler=compiler,
        )
        controller = DeckDesignLiftRuntime(
            mutation_store=mutation_store,
            manifest_store=manifest_repository,
            mechanics=mechanics,
            judge=quality,
            repair_executor=repair_executor,
            materializer=materializer,
            atomic_committer=mutation_store,
        )
        request_factory = ProductionDeckDesignLiftRequestFactory(
            manifest_repository=manifest_repository,
            mutation_store=mutation_store,
            object_store=sync_objects,
            instrument=instrument,
            canary_user_ids=dq2.canary_user_ids,
        )
        return ConfiguredDeckDesignLiftGraphRuntime(
            controller=controller,
            request_factory=request_factory,
            canary_user_ids=dq2.canary_user_ids,
            timeout_seconds=dq2.max_campaign_wall_clock_seconds,
            _async_resources=tuple(async_resources),
            _sync_resources=tuple(sync_resources),
        )
    except Exception:
        if async_resources or sync_resources:
            try:
                # The production factory is invoked by AnyIO's worker-thread API;
                # return to its event loop for native async client shutdown.
                anyio.from_thread.run(
                    _close_configured_resources,
                    tuple(async_resources),
                    tuple(sync_resources),
                )
            except Exception:
                raise DeckDesignLiftRunnerError("configured_runtime_cleanup_failed") from None
        raise


__all__ = [
    "ConfiguredDeckDesignLiftGraphRuntime",
    "DeckDesignLiftRunnerError",
    "ProductionArtifactManifestLoader",
    "ProductionDeckCandidateBaselineLoader",
    "ProductionDeckMechanics",
    "configured_graph_runtime",
]
