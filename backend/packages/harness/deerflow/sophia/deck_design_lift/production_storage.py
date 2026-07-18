"""Fail-closed production storage and request assembly for DQ-2.

The registered graph accepts only correlation identifiers.  This module turns
those identifiers into one verified baseline request by following the durable
manifest head (or the frozen baseline of a resumed mutation), verifying every
immutable byte it reads, and deriving the complete source authorization
inventory from the manifest rather than from graph input.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import partial
from typing import Any, NoReturn

import anyio
from pydantic import ValidationError

from deerflow.sophia.build_manifest import (
    DECK_STYLE_ROOT_SELECTOR,
    BuildManifest,
    manifest_components_by_selector,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.build_versions import BuildArtifactVersion
from deerflow.sophia.deck_design_lift.materializer import BaselineManifestHead
from deerflow.sophia.deck_design_lift.runtime import (
    DQ2_RENEWABLE_LEASE_SECONDS,
    DeckDesignLiftRequest,
)
from deerflow.sophia.deck_design_lift.schemas import SelectorSourceAuthorization
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.instrument import DeckQualityRuntimeInstrument
from deerflow.sophia.storage.build_mutation_store import SupabaseBuildMutationStore
from deerflow.sophia.storage.supabase_artifact_store import (
    SupabaseImmutableObjectStore,
    normalize_object_path,
    safe_object_path_segment,
)

MAX_PRODUCTION_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_PRODUCTION_PPTX_BYTES = 100 * 1024 * 1024
_WRITABLE_SLIDE_ROLES = ("body", "slide_css", "notes")


class DeckDesignLiftProductionStorageError(RuntimeError):
    """Content-free production adapter failure safe for graph diagnostics."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _fail(code: str) -> NoReturn:
    raise DeckDesignLiftProductionStorageError(code)


def _reject_json_constant(_value: str) -> NoReturn:
    raise ValueError


def _canonical_manifest(raw: bytes) -> BuildManifest:
    try:
        json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        manifest = BuildManifest.model_validate_json(raw)
        if canonical_json_bytes(manifest) != raw:
            raise ValueError
    except (UnicodeError, ValueError, ValidationError):
        _fail("manifest_invalid")
    return manifest


def _canonical_segment(value: str, *, default: str) -> str:
    if safe_object_path_segment(value, default=default) != value:
        _fail("scope_invalid")
    return value


def foundation_object_root(*, user_id: str, thread_id: str, build_id: str) -> str:
    """Return the canonical private object root for one enforced build."""

    return normalize_object_path(f"artifacts/{_canonical_segment(user_id, default='user')}/{_canonical_segment(thread_id, default='thread')}/foundation/.builder/builds/{_canonical_segment(build_id, default='build')}")


def canonical_manifest_source_path(
    source_path: str,
    *,
    object_root: str,
    build_id: str,
) -> str:
    """Map an immutable local foundation source to its uploaded object key."""

    if not isinstance(source_path, str) or not source_path.strip() or "\x00" in source_path or "\\" in source_path:
        _fail("source_path_invalid")
    local_prefixes = (
        f"/mnt/user-data/outputs/.builder/builds/{build_id}/",
        f".builder/builds/{build_id}/",
    )
    relative: str | None = None
    for prefix in local_prefixes:
        if source_path.startswith(prefix):
            relative = source_path.removeprefix(prefix)
            break
    if relative is not None:
        try:
            return normalize_object_path(f"{object_root}/{relative}")
        except ValueError:
            _fail("source_path_invalid")
    try:
        normalized = normalize_object_path(source_path)
    except ValueError:
        _fail("source_path_invalid")
    if not normalized.startswith(f"{object_root}/"):
        _fail("source_path_invalid")
    return normalized


@dataclass(frozen=True, slots=True)
class VerifiedManifestRevision:
    head: BaselineManifestHead
    manifest: BuildManifest
    manifest_bytes: bytes


class ProductionDeckManifestRepository:
    """Read-only manifest repository backed by mutation RPCs and object storage."""

    def __init__(
        self,
        *,
        mutation_store: SupabaseBuildMutationStore,
        object_store: SupabaseImmutableObjectStore,
    ) -> None:
        self._mutations = mutation_store
        self._objects = object_store

    def load_manifest_head(self, *, build_id: str, user_id: str) -> BaselineManifestHead:
        try:
            raw = self._mutations.load_manifest_head(build_id=build_id, user_id=user_id)
            return BaselineManifestHead.model_validate(raw.model_dump(mode="json"))
        except DeckDesignLiftProductionStorageError:
            raise
        except Exception:
            _fail("manifest_head_unavailable")

    def _read_manifest(
        self,
        *,
        object_path: str,
        expected_hash: str | None,
    ) -> tuple[BuildManifest, bytes]:
        try:
            raw = self._objects.read_bounded(
                object_path,
                max_bytes=MAX_PRODUCTION_MANIFEST_BYTES,
            )
        except Exception:
            _fail("manifest_unavailable")
        if not isinstance(raw, bytes) or not raw:
            _fail("manifest_missing")
        digest = hashlib.sha256(raw).hexdigest()
        if expected_hash is not None and digest != expected_hash:
            _fail("manifest_hash_mismatch")
        return _canonical_manifest(raw), raw

    @staticmethod
    def _validate_manifest_identity(
        manifest: BuildManifest,
        *,
        build_id: str,
        user_id: str,
        thread_id: str,
        revision: int,
    ) -> None:
        if (
            manifest.build_id != build_id
            or manifest.user_id != user_id
            or manifest.thread_id != thread_id
            or manifest.manifest_revision != revision
            or manifest.status != "complete"
            or manifest.format != "pptx"
            or manifest.logical_artifact_id is None
            or manifest.current_artifact_version_id is None
        ):
            _fail("manifest_identity_mismatch")
        try:
            components = manifest_components_by_selector(manifest)
        except ValueError:
            _fail("manifest_invalid")
        if DECK_STYLE_ROOT_SELECTOR not in components:
            _fail("manifest_source_inventory_missing")
        slides = tuple(component for component in manifest.components if component.type == "slide")
        if len(slides) != 5 or tuple(component.selector for component in slides) != tuple(f"slide:{index}" for index in range(1, 6)):
            _fail("campaign_slide_count_mismatch")

    def load_verified_head(self, *, build_id: str, user_id: str) -> VerifiedManifestRevision:
        head = self.load_manifest_head(build_id=build_id, user_id=user_id)
        manifest, raw = self._read_manifest(
            object_path=head.manifest_object_path,
            expected_hash=head.manifest_hash,
        )
        self._validate_manifest_identity(
            manifest,
            build_id=build_id,
            user_id=user_id,
            thread_id=head.owner_thread_id,
            revision=head.manifest_revision,
        )
        if head.current_artifact_version_id != manifest.current_artifact_version_id or head.logical_artifact_id != manifest.logical_artifact_id or head.status != manifest.status or head.format != manifest.format:
            _fail("manifest_head_mismatch")
        return VerifiedManifestRevision(head=head, manifest=manifest, manifest_bytes=raw)

    def load_verified_revision_for_transaction(
        self,
        transaction: BuildMutationTransaction,
    ) -> VerifiedManifestRevision:
        if transaction.owner_thread_id is None:
            _fail("transaction_scope_invalid")
        root = foundation_object_root(
            user_id=transaction.user_id,
            thread_id=transaction.owner_thread_id,
            build_id=transaction.build_id,
        )
        object_path = f"{root}/manifest/manifest-r{transaction.expected_manifest_revision}.json"
        manifest, raw = self._read_manifest(object_path=object_path, expected_hash=None)
        self._validate_manifest_identity(
            manifest,
            build_id=transaction.build_id,
            user_id=transaction.user_id,
            thread_id=transaction.owner_thread_id,
            revision=transaction.expected_manifest_revision,
        )
        if (
            manifest.current_artifact_version_id != transaction.expected_artifact_version_id
            or _manifest_artifact_hash(manifest) != transaction.expected_artifact_hash
            or {component.selector: component.current_version_id for component in manifest.components} != transaction.expected_component_versions
        ):
            _fail("transaction_baseline_mismatch")
        head = BaselineManifestHead(
            build_id=manifest.build_id,
            user_id=manifest.user_id,
            owner_thread_id=manifest.thread_id,
            manifest_revision=manifest.manifest_revision,
            manifest_object_path=object_path,
            manifest_hash=hashlib.sha256(raw).hexdigest(),
            logical_artifact_id=manifest.logical_artifact_id,
            current_artifact_version_id=manifest.current_artifact_version_id,
            status=manifest.status,
            format=manifest.format,
            updated_at=manifest.updated_at,
        )
        return VerifiedManifestRevision(head=head, manifest=manifest, manifest_bytes=raw)

    def load(self, *, build_id: str, user_id: str) -> BuildManifest:
        return self.load_verified_head(build_id=build_id, user_id=user_id).manifest

    def create(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        _fail("read_only_manifest_repository")

    def save_cas(self, *_args: Any, **_kwargs: Any) -> NoReturn:
        _fail("read_only_manifest_repository")


def _deck_extension(manifest: BuildManifest) -> Mapping[str, Any]:
    value = manifest.format_extensions.get("deck")
    if not isinstance(value, Mapping):
        _fail("artifact_metadata_missing")
    return value


def _manifest_artifact_hash(manifest: BuildManifest) -> str:
    value = _deck_extension(manifest).get("current_pptx_hash")
    if not isinstance(value, str) or len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
        _fail("artifact_metadata_invalid")
    return value


def _manifest_artifact_storage_path(manifest: BuildManifest) -> str:
    value = _deck_extension(manifest).get("artifact_storage_object_path")
    if not isinstance(value, str):
        _fail("artifact_metadata_invalid")
    try:
        normalized = normalize_object_path(value)
    except ValueError:
        _fail("artifact_metadata_invalid")
    root = foundation_object_root(
        user_id=manifest.user_id,
        thread_id=manifest.thread_id,
        build_id=manifest.build_id,
    )
    expected_prefix = f"{root}/artifacts/{manifest.current_artifact_version_id}/"
    if normalized != value or not normalized.startswith(expected_prefix):
        _fail("artifact_metadata_invalid")
    return normalized


def _source_authorizations(manifest: BuildManifest) -> tuple[SelectorSourceAuthorization, ...]:
    authorizations: list[SelectorSourceAuthorization] = []
    for component in manifest.components:
        if component.selector == DECK_STYLE_ROOT_SELECTOR:
            roles = ("deck_css",) if "deck_css" in component.source_roles else ()
        elif component.type == "slide":
            roles = tuple(role for role in _WRITABLE_SLIDE_ROLES if role in component.source_roles)
        else:
            continue
        if not roles:
            _fail("manifest_source_inventory_missing")
        for role in roles:
            digest = component.source_hashes.get(role)
            if not isinstance(digest, str) or len(digest) != 64:
                _fail("manifest_source_inventory_invalid")
        authorizations.append(
            SelectorSourceAuthorization(
                selector=component.selector,
                source_roles=roles,
                owned_asset_ids=(),
            )
        )
    if tuple(item.selector for item in authorizations) != (
        DECK_STYLE_ROOT_SELECTOR,
        "slide:1",
        "slide:2",
        "slide:3",
        "slide:4",
        "slide:5",
    ):
        _fail("manifest_source_inventory_invalid")
    return tuple(authorizations)


class ProductionDeckDesignLiftRequestFactory:
    """Construct the full runtime request from safe graph identifiers only."""

    def __init__(
        self,
        *,
        manifest_repository: ProductionDeckManifestRepository,
        mutation_store: SupabaseBuildMutationStore,
        object_store: SupabaseImmutableObjectStore,
        instrument: DeckQualityRuntimeInstrument,
        canary_user_ids: frozenset[str],
    ) -> None:
        if not canary_user_ids:
            raise ValueError("DQ-2 request factory requires an exact canary set")
        self._manifests = manifest_repository
        self._mutations = mutation_store
        self._objects = object_store
        self._instrument = instrument
        self._canary_user_ids = canary_user_ids

    def _verified_artifact(self, manifest: BuildManifest) -> BuildArtifactVersion:
        artifact_hash = _manifest_artifact_hash(manifest)
        storage_path = _manifest_artifact_storage_path(manifest)
        try:
            artifact_bytes = self._objects.read_bounded(
                storage_path,
                max_bytes=MAX_PRODUCTION_PPTX_BYTES,
            )
        except Exception:
            _fail("artifact_unavailable")
        if not isinstance(artifact_bytes, bytes) or not artifact_bytes.startswith(b"PK\x03\x04") or hashlib.sha256(artifact_bytes).hexdigest() != artifact_hash:
            _fail("artifact_verification_failed")
        return BuildArtifactVersion(
            version_id=str(manifest.current_artifact_version_id),
            build_id=manifest.build_id,
            logical_artifact_id=str(manifest.logical_artifact_id),
            manifest_revision=manifest.manifest_revision,
            artifact_path=manifest.deliverable_path or "/mnt/user-data/outputs/presentation.pptx",
            artifact_hash=artifact_hash,
            storage_object_path=storage_path,
            verified=True,
            created_at=manifest.updated_at,
        )

    async def build_request(
        self,
        *,
        campaign_run_id: str,
        experiment_id: str,
        build_id: str,
        user_id: str,
        operation_id: str,
        lease_owner: str,
        transaction_id: str | None,
    ) -> DeckDesignLiftRequest:
        if user_id not in self._canary_user_ids:
            _fail("canary_scope_mismatch")
        if transaction_id is None:
            verified = await anyio.to_thread.run_sync(
                partial(
                    self._manifests.load_verified_head,
                    build_id=build_id,
                    user_id=user_id,
                )
            )
            if verified.manifest.manifest_revision != 1:
                _fail("fresh_baseline_required")
        else:
            try:
                transaction = await anyio.to_thread.run_sync(
                    partial(
                        self._mutations.load,
                        transaction_id=transaction_id,
                        user_id=user_id,
                    )
                )
            except Exception:
                _fail("transaction_unavailable")
            if transaction.build_id != build_id or transaction.campaign_run_id != campaign_run_id or transaction.operation_id != operation_id:
                _fail("transaction_scope_mismatch")
            verified = await anyio.to_thread.run_sync(
                self._manifests.load_verified_revision_for_transaction,
                transaction,
            )
        manifest = verified.manifest
        instrument_hash = canonical_sha256(self._instrument.lock)
        initial_artifact = await anyio.to_thread.run_sync(
            self._verified_artifact,
            manifest,
        )
        return DeckDesignLiftRequest(
            campaign_run_id=campaign_run_id,
            experiment_id=experiment_id,
            build_id=build_id,
            user_id=user_id,
            operation_id=operation_id,
            lease_owner=lease_owner,
            expected_manifest_revision=manifest.manifest_revision,
            initial_artifact=initial_artifact,
            source_authorizations=_source_authorizations(manifest),
            rubric_version=self._instrument.lock.rubric_version,
            instrument_hash=instrument_hash,
            plan_revision_allowed=False,
            additional_must_preserve=(
                "Exactly five slides in the original order.",
                "Every PSI motivation-control claim and operational closing question from the blind brief.",
            ),
            additional_must_not=("Do not turn the PSI control-loop mechanism into generic decorative containers.",),
            transaction_id=transaction_id,
            lease_seconds=DQ2_RENEWABLE_LEASE_SECONDS,
        )


__all__ = [
    "DeckDesignLiftProductionStorageError",
    "ProductionDeckDesignLiftRequestFactory",
    "ProductionDeckManifestRepository",
    "VerifiedManifestRevision",
    "canonical_manifest_source_path",
    "foundation_object_root",
]
