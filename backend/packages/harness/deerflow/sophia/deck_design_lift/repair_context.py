"""Authenticated production context loading for the single DQ-2 repair call.

The repair model must never choose its own evidence, sources, assets, or skill
files.  This adapter starts from the frozen mutation transaction, follows its
immutable revision-one manifest and DQ-1 snapshot, and returns only the exact
objects authorized by the deterministic repair program.
"""

from __future__ import annotations

import hashlib
import inspect
import json
from collections.abc import Awaitable, Callable, Mapping
from functools import partial
from typing import Any, Protocol, cast

import anyio
from pydantic import ValidationError

from deerflow.sophia.build_manifest import (
    BuildManifest,
    manifest_components_by_selector,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.production_storage import (
    DeckDesignLiftProductionStorageError,
    ProductionDeckManifestRepository,
    canonical_manifest_source_path,
    foundation_object_root,
)
from deerflow.sophia.deck_design_lift.repair_author import (
    MAX_REPAIR_CONTEXT_IMAGE_BYTES,
    MAX_REPAIR_CONTEXT_SOURCE_BYTES,
    DeckRepairAuthorError,
    RepairAuthorContext,
    RepairAuthorContextIdentity,
    RepairBriefContext,
    RepairContextImage,
    RepairOwnedAssetContext,
    RepairPlanContext,
    RepairSkillExcerptContext,
    RepairSourceContext,
)
from deerflow.sophia.deck_design_lift.runtime import (
    BlindDeckJudgmentRequest,
    InitialRenderedJudgment,
    RepairInvocationRequest,
)
from deerflow.sophia.deck_design_lift.schemas import SkillRef
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.persistence import QualityRunRecord
from deerflow.sophia.deck_quality.schemas import MechanicalProjection, ShadowDecision
from deerflow.sophia.deck_quality.snapshot import (
    SnapshotEvidenceBundle,
    SnapshotEvidenceManifest,
)
from deerflow.sophia.storage.build_mutation_store import SupabaseBuildMutationStore
from deerflow.sophia.storage.supabase_artifact_store import SupabaseImmutableObjectStore

_RUNTIME_CHECKPOINT_KEY = "deck_design_lift_runtime"
_RUNTIME_CHECKPOINT_SCHEMA = "sophia-deck-design-lift-checkpoint/v1"
_EXPECTED_SELECTORS = tuple(f"slide:{index}" for index in range(1, 6))
_MAX_OWNED_ASSET_BYTES = 128 * 1024 * 1024


class LockedSkillExcerptLike(Protocol):
    """Structural view of the committed DQ-2 skill catalog entry."""

    ref: SkillRef
    text: str


class AuthenticatedDeckQualitySnapshotLike(Protocol):
    """Result shape returned by ``DurableDeckQualityEvidenceAdapter``."""

    row: QualityRunRecord
    manifest: BuildManifest
    evidence_manifest: SnapshotEvidenceManifest
    evidence_bundle: SnapshotEvidenceBundle
    mechanical: MechanicalProjection
    decision: ShadowDecision


class InitialDeckQualityEvidenceAdapter(Protocol):
    """Narrow production interface shared with the DQ-1 quality adapter."""

    @property
    def skill_excerpts(self) -> tuple[LockedSkillExcerptLike, ...]: ...

    def load_initial_snapshot(
        self,
        request: BlindDeckJudgmentRequest,
    ) -> Awaitable[AuthenticatedDeckQualitySnapshotLike]: ...


def _invalid() -> None:
    raise DeckRepairAuthorError("context_invalid")


def _unavailable() -> None:
    raise DeckRepairAuthorError("context_unavailable")


async def _run_sync[ValueT](
    function: Callable[..., ValueT],
    /,
    *args: Any,
    **kwargs: Any,
) -> ValueT:
    return await anyio.to_thread.run_sync(
        partial(function, *args, **kwargs),
        abandon_on_cancel=False,
    )


async def _call_maybe_async[ValueT](
    function: Callable[..., ValueT | Awaitable[ValueT]],
    /,
    *args: Any,
    **kwargs: Any,
) -> ValueT:
    if inspect.iscoroutinefunction(function):
        return await function(*args, **kwargs)
    value = await _run_sync(function, *args, **kwargs)
    if inspect.isawaitable(value):
        return await value
    return value


def _canonical_json_mapping(value: object) -> dict[str, Any]:
    try:
        encoded = canonical_json_bytes(value)
        normalized = json.loads(encoded.decode("utf-8"))
    except (TypeError, UnicodeError, ValueError):
        _invalid()
    if not isinstance(normalized, dict):
        _invalid()
    return normalized


def _deck_extension(manifest: BuildManifest) -> Mapping[str, Any]:
    value = manifest.format_extensions.get("deck")
    if not isinstance(value, Mapping):
        _invalid()
    return value


def _initial_artifact(
    manifest: BuildManifest,
    transaction: BuildMutationTransaction,
) -> BuildArtifactVersion:
    extension = _deck_extension(manifest)
    artifact_hash = extension.get("current_pptx_hash")
    storage_path = extension.get("artifact_storage_object_path")
    if (
        manifest.logical_artifact_id is None
        or manifest.current_artifact_version_id is None
        or manifest.current_artifact_version_id != transaction.expected_artifact_version_id
        or not isinstance(artifact_hash, str)
        or artifact_hash != transaction.expected_artifact_hash
        or not isinstance(storage_path, str)
    ):
        _invalid()
    try:
        return BuildArtifactVersion(
            version_id=manifest.current_artifact_version_id,
            build_id=manifest.build_id,
            logical_artifact_id=manifest.logical_artifact_id,
            manifest_revision=manifest.manifest_revision,
            artifact_path=manifest.deliverable_path or "/mnt/user-data/outputs/presentation.pptx",
            artifact_hash=artifact_hash,
            storage_object_path=storage_path,
            verified=True,
            created_at=manifest.updated_at,
        )
    except (TypeError, ValidationError, ValueError):
        _invalid()


def _checkpoint(
    transaction: BuildMutationTransaction,
    request: RepairInvocationRequest,
) -> tuple[InitialRenderedJudgment, MechanicalProjection]:
    value = transaction.gate_evidence.get(_RUNTIME_CHECKPOINT_KEY)
    if not isinstance(value, Mapping):
        _invalid()
    try:
        if value.get("schema_version") != _RUNTIME_CHECKPOINT_SCHEMA or value.get("campaign_run_id") != request.campaign_run_id or value.get("experiment_id") != request.experiment_id or value.get("owner_thread_id") != request.thread_id:
            _invalid()
        program = request.program.model_validate(value["repair_program"])
        initial = InitialRenderedJudgment.model_validate(value["initial_judgment"])
        mechanics = MechanicalProjection.model_validate(value["initial_mechanics"])
    except DeckRepairAuthorError:
        raise
    except (KeyError, TypeError, ValidationError, ValueError):
        _invalid()
    if (
        program != request.program
        or initial.evidence.quality_run_id != request.program.initial_quality_run_id
        or initial.evidence.artifact_version_id != request.initial_artifact_version_id
        or initial.evidence.verdict != "needs_revision"
        or initial.decision.result != "needs_revision"
        or mechanics.status != "passed"
        or initial.evidence.mechanics_passed is not True
    ):
        _invalid()
    return initial, mechanics


def _validate_transaction(
    transaction: BuildMutationTransaction,
    request: RepairInvocationRequest,
) -> None:
    program = request.program
    if (
        transaction.status != "prepared"
        or transaction.transaction_id != request.transaction_id
        or transaction.campaign_run_id != request.campaign_run_id
        or transaction.user_id != request.user_id
        or transaction.owner_thread_id != request.thread_id
        or transaction.build_id != request.build_id
        or transaction.operation_id != request.operation_id
        or transaction.expected_manifest_revision != program.initial_manifest_revision
        or transaction.expected_artifact_version_id != request.initial_artifact_version_id
        or transaction.repair_program_hash != program.program_hash
        or transaction.initial_quality_run_id != program.initial_quality_run_id
        or tuple(transaction.authorized_selectors) != tuple(program.authorized_selectors)
        or transaction.authorized_source_roles != {selector: list(program.authorized_source_roles[selector]) for selector in program.authorized_selectors}
    ):
        _invalid()


def _validate_quality_snapshot(
    *,
    authenticated: AuthenticatedDeckQualitySnapshotLike,
    request: RepairInvocationRequest,
    transaction: BuildMutationTransaction,
    manifest: BuildManifest,
    initial: InitialRenderedJudgment,
) -> None:
    row = authenticated.row
    evidence_manifest = authenticated.evidence_manifest
    bundle = authenticated.evidence_bundle
    snapshot = bundle.snapshot
    expected_hash = transaction.expected_artifact_hash
    if (
        not isinstance(row, QualityRunRecord)
        or row.quality_run_id != request.program.initial_quality_run_id
        or row.campaign_id != "DQ-1"
        or row.state != "completed"
        or row.decision_result != "needs_revision"
        or row.instrument_identity_hash != request.program.instrument_hash
        or row.rubric_version != request.program.rubric_version
        or row.user_id != request.user_id
        or row.thread_id != request.thread_id
        or row.build_id != request.build_id
        or row.artifact_version_id != request.initial_artifact_version_id
        or row.manifest_revision != request.program.initial_manifest_revision
        or row.artifact_hash != expected_hash
        or authenticated.decision != initial.decision
        or authenticated.mechanical.status != "passed"
        or authenticated.mechanical != MechanicalProjection.model_validate(transaction.gate_evidence[_RUNTIME_CHECKPOINT_KEY]["initial_mechanics"])
        or canonical_json_bytes(authenticated.manifest) != canonical_json_bytes(manifest)
        or evidence_manifest.quality_run_id != row.quality_run_id
        or evidence_manifest.snapshot_id != row.quality_run_id
        or evidence_manifest.build_id != request.build_id
        or evidence_manifest.user_id != request.user_id
        or evidence_manifest.thread_id != request.thread_id
        or evidence_manifest.artifact_version_id != request.initial_artifact_version_id
        or evidence_manifest.artifact_manifest_revision != request.program.initial_manifest_revision
        or snapshot.campaign_id != "DQ-1"
        or snapshot.build_id != request.build_id
        or snapshot.user_id != request.user_id
        or snapshot.logical_artifact_id != manifest.logical_artifact_id
        or snapshot.artifact_version_id != request.initial_artifact_version_id
        or snapshot.manifest_revision != request.program.initial_manifest_revision
        or snapshot.artifact_hash != expected_hash
        or snapshot.brief_hash != canonical_sha256(snapshot.brief)
        or snapshot.creative_plan_hash != canonical_sha256(snapshot.creative_plan)
        or snapshot.design_plan_hash != canonical_sha256(snapshot.design_plan)
        or snapshot.mechanical_record_hash != canonical_sha256(snapshot.mechanical_record)
        or snapshot.renders.expected_slide_count != 5
        or tuple(snapshot.renders.selectors) != _EXPECTED_SELECTORS
        or tuple(evidence_manifest.selectors) != _EXPECTED_SELECTORS
    ):
        _invalid()


async def _read_object(
    object_store: SupabaseImmutableObjectStore,
    object_path: str,
    *,
    max_bytes: int,
) -> bytes:
    try:
        raw = await _call_maybe_async(
            object_store.read_bounded,
            object_path,
            max_bytes=max_bytes,
        )
    except Exception:
        _unavailable()
    if not isinstance(raw, bytes) or not raw or len(raw) > max_bytes:
        _unavailable()
    return raw


async def _render_context(
    *,
    object_store: SupabaseImmutableObjectStore,
    artifact_version_id: str,
    selector: str,
    path: str,
    sha256: str,
    width: int,
    height: int,
) -> RepairContextImage:
    raw = await _read_object(
        object_store,
        path,
        max_bytes=MAX_REPAIR_CONTEXT_IMAGE_BYTES,
    )
    return await _run_sync(
        _verified_render_context,
        raw=raw,
        artifact_version_id=artifact_version_id,
        selector=selector,
        path=path,
        sha256=sha256,
        width=width,
        height=height,
    )


def _verified_render_context(
    *,
    raw: bytes,
    artifact_version_id: str,
    selector: str,
    path: str,
    sha256: str,
    width: int,
    height: int,
) -> RepairContextImage:
    if hashlib.sha256(raw).hexdigest() != sha256:
        _invalid()
    try:
        return RepairContextImage(
            artifact_version_id=artifact_version_id,
            selector=selector,
            path=path,
            sha256=sha256,
            width=width,
            height=height,
            png_bytes=raw,
        )
    except (TypeError, ValidationError, ValueError):
        _invalid()


async def _load_render_context(
    *,
    authenticated: AuthenticatedDeckQualitySnapshotLike,
    request: RepairInvocationRequest,
    object_store: SupabaseImmutableObjectStore,
) -> tuple[RepairContextImage, tuple[RepairContextImage, ...]]:
    evidence_manifest = authenticated.evidence_manifest
    renders = authenticated.evidence_bundle.snapshot.renders
    records = tuple(evidence_manifest.objects)
    contact_records = tuple(record for record in records if record.role == "contact_sheet")
    if len(contact_records) != 1:
        _invalid()
    contact_record = contact_records[0]
    contact = renders.contact_sheet
    if (
        contact.path != contact_record.object_path
        or contact.sha256 != contact_record.sha256
        or contact.media_type != "image/png"
        or contact_record.media_type != "image/png"
        or contact_record.size_bytes > MAX_REPAIR_CONTEXT_IMAGE_BYTES
        or evidence_manifest.render_hashes.get("contact-sheet") != contact.sha256
    ):
        _invalid()
    contact_context = await _render_context(
        object_store=object_store,
        artifact_version_id=request.initial_artifact_version_id,
        selector="contact-sheet",
        path=contact_record.object_path,
        sha256=contact_record.sha256,
        width=contact.width,
        height=contact.height,
    )

    images_by_selector = {str(image.selector): image for image in renders.slides}
    records_by_path = {record.object_path: record for record in records}
    requested_evidence = {(str(item.selector), item.path, item.sha256) for repair in request.program.selector_repairs for item in repair.render_evidence}
    contexts: list[RepairContextImage] = []
    for selector in _EXPECTED_SELECTORS:
        matches = tuple(item for item in requested_evidence if item[0] == selector)
        if not matches:
            continue
        if len(matches) != 1:
            _invalid()
        _, path, expected_hash = matches[0]
        image = images_by_selector.get(selector)
        record = records_by_path.get(path)
        if (
            image is None
            or record is None
            or record.role != "render"
            or record.media_type != "image/png"
            or image.path != path
            or image.sha256 != expected_hash
            or record.sha256 != expected_hash
            or record.size_bytes > MAX_REPAIR_CONTEXT_IMAGE_BYTES
            or evidence_manifest.render_hashes.get(selector) != expected_hash
        ):
            _invalid()
        contexts.append(
            await _render_context(
                object_store=object_store,
                artifact_version_id=request.initial_artifact_version_id,
                selector=selector,
                path=path,
                sha256=expected_hash,
                width=image.width,
                height=image.height,
            )
        )
    if {(str(item.selector), item.path, item.sha256) for item in contexts} != requested_evidence:
        _invalid()
    return contact_context, tuple(contexts)


async def _load_sources(
    *,
    request: RepairInvocationRequest,
    manifest: BuildManifest,
    manifest_hash: str,
    object_store: SupabaseImmutableObjectStore,
) -> tuple[RepairSourceContext, ...]:
    components, object_root = await _run_sync(
        _context_source_inventory,
        manifest,
        user_id=request.user_id,
        thread_id=request.thread_id,
        build_id=request.build_id,
    )
    contexts: list[RepairSourceContext] = []
    for selector in request.program.authorized_selectors:
        component = components.get(selector)
        if component is None:
            _invalid()
        for role in request.program.authorized_source_roles[selector]:
            source_path = component.source_roles.get(role)
            source_hash = component.source_hashes.get(role)
            if not isinstance(source_path, str) or not isinstance(source_hash, str):
                _invalid()
            try:
                durable_path = await _run_sync(
                    canonical_manifest_source_path,
                    source_path,
                    object_root=object_root,
                    build_id=request.build_id,
                )
            except DeckDesignLiftProductionStorageError:
                _invalid()
            raw = await _read_object(
                object_store,
                durable_path,
                max_bytes=MAX_REPAIR_CONTEXT_SOURCE_BYTES,
            )
            contexts.append(
                await _run_sync(
                    _verified_source_context,
                    raw=raw,
                    expected_hash=source_hash,
                    build_id=request.build_id,
                    manifest_revision=manifest.manifest_revision,
                    manifest_hash=manifest_hash,
                    selector=selector,
                    source_role=role,
                    component_version_id=component.current_version_id,
                    durable_path=durable_path,
                )
            )
    return tuple(contexts)


def _context_source_inventory(
    manifest: BuildManifest,
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
) -> tuple[dict[str, Any], str]:
    return (
        manifest_components_by_selector(manifest),
        foundation_object_root(
            user_id=user_id,
            thread_id=thread_id,
            build_id=build_id,
        ),
    )


def _verified_source_context(
    *,
    raw: bytes,
    expected_hash: str,
    build_id: str,
    manifest_revision: int,
    manifest_hash: str,
    selector: str,
    source_role: str,
    component_version_id: str,
    durable_path: str,
) -> RepairSourceContext:
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        _invalid()
    try:
        return RepairSourceContext(
            build_id=build_id,
            manifest_revision=manifest_revision,
            manifest_hash=manifest_hash,
            selector=selector,
            source_role=source_role,
            component_version_id=component_version_id,
            manifest_source_path=durable_path,
            manifest_source_hash=expected_hash,
            text=raw.decode("utf-8"),
        )
    except (UnicodeError, ValidationError, ValueError):
        _invalid()


def _planned_assets(
    creative_plan: Mapping[str, Any],
) -> dict[tuple[str, str], dict[str, Any]]:
    raw_assets = creative_plan.get("image_assets")
    if raw_assets is None:
        return {}
    if not isinstance(raw_assets, list):
        _invalid()
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for raw in raw_assets:
        if not isinstance(raw, Mapping):
            _invalid()
        normalized = _canonical_json_mapping(dict(raw))
        asset_id = normalized.get("asset_id")
        selector = normalized.get("slide_selector")
        if not isinstance(asset_id, str) or not isinstance(selector, str):
            _invalid()
        key = (selector, asset_id)
        if key in result:
            _invalid()
        result[key] = normalized
    return result


def _asset_media_type(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    _invalid()


async def _load_assets(
    *,
    request: RepairInvocationRequest,
    manifest: BuildManifest,
    manifest_hash: str,
    creative_plan: Mapping[str, Any],
    object_store: SupabaseImmutableObjectStore,
) -> tuple[RepairOwnedAssetContext, ...]:
    expected_assets = tuple((str(repair.selector), asset_id) for repair in request.program.selector_repairs for asset_id in repair.allowed_asset_changes)
    if not expected_assets:
        return ()
    if len(expected_assets) != len(set(expected_assets)):
        _invalid()
    components, plans, object_root = await _run_sync(
        _context_asset_inventory,
        manifest,
        creative_plan,
        user_id=request.user_id,
        thread_id=request.thread_id,
        build_id=request.build_id,
    )
    contexts: list[RepairOwnedAssetContext] = []
    for selector, asset_id in expected_assets:
        component = components.get(selector)
        plan = plans.get((selector, asset_id))
        if component is None or plan is None or len(component.asset_paths) != 1:
            _invalid()
        try:
            durable_path = await _run_sync(
                canonical_manifest_source_path,
                component.asset_paths[0],
                object_root=object_root,
                build_id=request.build_id,
            )
        except DeckDesignLiftProductionStorageError:
            _invalid()
        content = await _read_object(
            object_store,
            durable_path,
            max_bytes=_MAX_OWNED_ASSET_BYTES,
        )
        contexts.append(
            await _run_sync(
                _owned_asset_context,
                content=content,
                plan=plan,
                component_version_id=component.current_version_id,
                build_id=request.build_id,
                manifest_revision=manifest.manifest_revision,
                manifest_hash=manifest_hash,
                selector=selector,
                asset_id=asset_id,
                durable_path=durable_path,
            )
        )
    return tuple(contexts)


def _context_asset_inventory(
    manifest: BuildManifest,
    creative_plan: Mapping[str, Any],
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
) -> tuple[dict[str, Any], dict[tuple[str, str], dict[str, Any]], str]:
    return (
        manifest_components_by_selector(manifest),
        _planned_assets(creative_plan),
        foundation_object_root(
            user_id=user_id,
            thread_id=thread_id,
            build_id=build_id,
        ),
    )


def _owned_asset_context(
    *,
    content: bytes,
    plan: dict[str, Any],
    component_version_id: str,
    build_id: str,
    manifest_revision: int,
    manifest_hash: str,
    selector: str,
    asset_id: str,
    durable_path: str,
) -> RepairOwnedAssetContext:
    metadata = _canonical_json_mapping(
        {
            "schema_version": "sophia-repair-owned-asset-metadata/v1",
            "creative_plan_asset": plan,
            "component_version_id": component_version_id,
        }
    )
    try:
        return RepairOwnedAssetContext(
            build_id=build_id,
            manifest_revision=manifest_revision,
            manifest_hash=manifest_hash,
            selector=selector,
            asset_id=asset_id,
            current_path=durable_path,
            current_sha256=hashlib.sha256(content).hexdigest(),
            media_type=_asset_media_type(content),
            size_bytes=len(content),
            metadata=metadata,
            metadata_hash=canonical_sha256(metadata),
        )
    except (TypeError, ValidationError, ValueError):
        _invalid()


def _load_skill_excerpts(
    *,
    requested: tuple[SkillRef, ...],
    catalog: tuple[LockedSkillExcerptLike, ...],
) -> tuple[RepairSkillExcerptContext, ...]:
    indexed: dict[tuple[str, str, str], RepairSkillExcerptContext] = {}
    try:
        for item in catalog:
            ref = SkillRef.model_validate(item.ref.model_dump(mode="python"))
            context = RepairSkillExcerptContext(
                path=ref.path,
                source_hash=ref.source_hash,
                excerpt_hash=ref.excerpt_hash,
                excerpt=item.text,
            )
            key = (ref.path, ref.source_hash, ref.excerpt_hash)
            if key in indexed:
                _invalid()
            indexed[key] = context
    except DeckRepairAuthorError:
        raise
    except (AttributeError, TypeError, ValidationError, ValueError):
        _invalid()
    result: list[RepairSkillExcerptContext] = []
    for ref in requested:
        item = indexed.get((ref.path, ref.source_hash, ref.excerpt_hash))
        if item is None:
            _invalid()
        result.append(item)
    return tuple(result)


def _validated_transaction_checkpoint(
    transaction: BuildMutationTransaction,
    request: RepairInvocationRequest,
) -> tuple[InitialRenderedJudgment, MechanicalProjection]:
    _validate_transaction(transaction, request)
    return _checkpoint(transaction, request)


def _validated_manifest_context(
    verified: Any,
    *,
    request: RepairInvocationRequest,
    transaction: BuildMutationTransaction,
) -> tuple[BuildManifest, str, BuildArtifactVersion]:
    manifest = verified.manifest
    manifest_hash = hashlib.sha256(verified.manifest_bytes).hexdigest()
    if manifest_hash != verified.head.manifest_hash or manifest.manifest_revision != request.program.initial_manifest_revision or manifest.current_artifact_version_id != request.initial_artifact_version_id:
        _invalid()
    return manifest, manifest_hash, _initial_artifact(manifest, transaction)


def _quality_skill_catalog(
    quality_adapter: InitialDeckQualityEvidenceAdapter,
) -> tuple[LockedSkillExcerptLike, ...]:
    return tuple(quality_adapter.skill_excerpts)


def _repair_author_context(
    *,
    request: RepairInvocationRequest,
    manifest: BuildManifest,
    manifest_hash: str,
    snapshot: Any,
    contact_sheet: RepairContextImage,
    failing_renders: tuple[RepairContextImage, ...],
    authorized_sources: tuple[RepairSourceContext, ...],
    owned_assets: tuple[RepairOwnedAssetContext, ...],
    skill_excerpts: tuple[RepairSkillExcerptContext, ...],
) -> RepairAuthorContext:
    try:
        return RepairAuthorContext(
            identity=RepairAuthorContextIdentity(
                campaign_run_id=request.campaign_run_id,
                experiment_id=request.experiment_id,
                user_id=request.user_id,
                thread_id=request.thread_id,
                build_id=request.build_id,
                operation_id=request.operation_id,
                transaction_id=request.transaction_id,
                initial_artifact_version_id=request.initial_artifact_version_id,
                repair_program_hash=request.program.program_hash,
                manifest_revision=manifest.manifest_revision,
                manifest_hash=manifest_hash,
            ),
            brief=RepairBriefContext(
                artifact_version_id=request.initial_artifact_version_id,
                brief=snapshot.brief,
                brief_hash=snapshot.brief_hash,
            ),
            plans=(
                RepairPlanContext(
                    artifact_version_id=request.initial_artifact_version_id,
                    role="creative_plan",
                    content=cast(dict[str, Any], snapshot.creative_plan),
                    content_hash=snapshot.creative_plan_hash,
                ),
                RepairPlanContext(
                    artifact_version_id=request.initial_artifact_version_id,
                    role="design_plan",
                    content=cast(dict[str, Any], snapshot.design_plan),
                    content_hash=snapshot.design_plan_hash,
                ),
            ),
            contact_sheet=contact_sheet,
            failing_renders=failing_renders,
            authorized_sources=authorized_sources,
            owned_assets=owned_assets,
            skill_excerpts=skill_excerpts,
        )
    except (TypeError, ValidationError, ValueError):
        _invalid()


class ProductionRepairAuthorContextLoader:
    """Load one fail-closed, manifest-addressed context for a frozen repair."""

    def __init__(
        self,
        *,
        manifest_repository: ProductionDeckManifestRepository,
        mutation_store: SupabaseBuildMutationStore,
        object_store: SupabaseImmutableObjectStore,
        quality_adapter: InitialDeckQualityEvidenceAdapter,
    ) -> None:
        if not callable(getattr(manifest_repository, "load_verified_revision_for_transaction", None)):
            raise ValueError("repair context manifest repository is invalid")
        if not callable(getattr(mutation_store, "load", None)):
            raise ValueError("repair context mutation store is invalid")
        if not callable(getattr(object_store, "read_bounded", None)):
            raise ValueError("repair context object store is invalid")
        if not callable(getattr(quality_adapter, "load_initial_snapshot", None)):
            raise ValueError("repair context quality adapter is invalid")
        self._manifests = manifest_repository
        self._mutations = mutation_store
        self._objects = object_store
        self._quality = quality_adapter

    async def load(self, request: RepairInvocationRequest) -> RepairAuthorContext:
        if not isinstance(request, RepairInvocationRequest):
            _invalid()
        try:
            transaction = await _call_maybe_async(
                self._mutations.load,
                transaction_id=request.transaction_id,
                user_id=request.user_id,
            )
        except DeckRepairAuthorError:
            raise
        except Exception:
            _unavailable()
        if not isinstance(transaction, BuildMutationTransaction):
            _invalid()
        initial, mechanics = await _run_sync(
            _validated_transaction_checkpoint,
            transaction,
            request,
        )

        try:
            verified = await _call_maybe_async(
                self._manifests.load_verified_revision_for_transaction,
                transaction,
            )
        except DeckRepairAuthorError:
            raise
        except DeckDesignLiftProductionStorageError:
            _invalid()
        except Exception:
            _unavailable()
        manifest, manifest_hash, artifact = await _run_sync(
            _validated_manifest_context,
            verified,
            request=request,
            transaction=transaction,
        )

        blind_request = BlindDeckJudgmentRequest(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            build_id=request.build_id,
            artifact=artifact,
            mechanics=mechanics,
        )
        try:
            authenticated = await self._quality.load_initial_snapshot(blind_request)
        except DeckRepairAuthorError:
            raise
        except Exception:
            _unavailable()
        await _run_sync(
            _validate_quality_snapshot,
            authenticated=authenticated,
            request=request,
            transaction=transaction,
            manifest=manifest,
            initial=initial,
        )
        snapshot = authenticated.evidence_bundle.snapshot

        contact_sheet, failing_renders = await _load_render_context(
            authenticated=authenticated,
            request=request,
            object_store=self._objects,
        )
        authorized_sources = await _load_sources(
            request=request,
            manifest=manifest,
            manifest_hash=manifest_hash,
            object_store=self._objects,
        )
        owned_assets = await _load_assets(
            request=request,
            manifest=manifest,
            manifest_hash=manifest_hash,
            creative_plan=snapshot.creative_plan,
            object_store=self._objects,
        )
        try:
            skill_catalog = await _run_sync(
                _quality_skill_catalog,
                self._quality,
            )
        except Exception:
            _unavailable()
        skill_excerpts = await _run_sync(
            _load_skill_excerpts,
            requested=tuple(request.program.skill_refs),
            catalog=skill_catalog,
        )
        return await _run_sync(
            _repair_author_context,
            request=request,
            manifest=manifest,
            manifest_hash=manifest_hash,
            snapshot=snapshot,
            contact_sheet=contact_sheet,
            failing_renders=failing_renders,
            authorized_sources=authorized_sources,
            owned_assets=owned_assets,
            skill_excerpts=skill_excerpts,
        )


__all__ = [
    "AuthenticatedDeckQualitySnapshotLike",
    "InitialDeckQualityEvidenceAdapter",
    "LockedSkillExcerptLike",
    "ProductionRepairAuthorContextLoader",
]
