"""Durable, pointer-free materialization of one DQ-2 deck candidate.

The materializer owns no compiler implementation and no mutable manifest
pointer.  It validates the frozen baseline, resolves compact source roles,
invokes an injected deterministic compiler, and writes a self-verifying graph
of immutable candidate objects.  A restart either reconstructs that graph or
repeats create-only writes with exact-byte reconciliation.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import re
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from deerflow.sophia.build_manifest import (
    DECK_STYLE_ROOT_SELECTOR,
    BuildComponent,
    BuildManifest,
    component_dependency_closure,
    manifest_components_by_selector,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.build_versions import BuildArtifactVersion, BuildComponentVersion
from deerflow.sophia.deck_design_lift.runtime import StagedDeckCandidate
from deerflow.sophia.deck_design_lift.schemas import (
    ContentPreservationProof,
    DeckRepairCandidate,
    DeckRepairProgram,
    LocalityProof,
)
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.schemas import MechanicalProjection
from deerflow.sophia.storage.supabase_artifact_store import (
    normalize_object_path,
    safe_object_path_segment,
)

MAX_BASELINE_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_COMPACT_SOURCE_BYTES = 2_000_000
MAX_TOTAL_COMPACT_SOURCE_BYTES = 64 * 1024 * 1024
MAX_PPTX_BYTES = 100 * 1024 * 1024
MAX_JSON_RECORD_BYTES = 4 * 1024 * 1024
MAX_STAGE_RECORD_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_COMPONENTS = 500

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SLIDE_SELECTOR_RE = re.compile(r"^slide:[1-9][0-9]*$")
_COMPACT_ROLES = frozenset({"body", "slide_css", "notes", "assembled", "deck_css"})
_SLIDE_ROLES = frozenset({"body", "slide_css", "notes", "assembled"})
_ROLE_FILENAMES = {
    "body": "body.html",
    "slide_css": "slide.css",
    "notes": "notes.txt",
    "assembled": "assembled.html",
    "deck_css": "deck.css",
}
_ROLE_CONTENT_TYPES = {
    "body": "text/html; charset=utf-8",
    "slide_css": "text/css; charset=utf-8",
    "notes": "text/plain; charset=utf-8",
    "assembled": "text/html; charset=utf-8",
    "deck_css": "text/css; charset=utf-8",
}
_PRODUCTION_THREAD_SOURCE_ROOT = "/app/backend/.deer-flow/threads"
_PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
_JSON_CONTENT_TYPE = "application/json"
_FORBIDDEN_RECORD_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "bearer",
        "credential",
        "credentials",
        "messages",
        "password",
        "prompt",
        "prompt_body",
        "provider_request",
        "provider_response",
        "raw_error",
        "raw_request",
        "raw_response",
        "request_body",
        "response_body",
        "secret",
        "token",
    }
)

MaterializationErrorCode = Literal[
    "invalid_scope",
    "stale_manifest",
    "manifest_missing",
    "manifest_invalid",
    "manifest_hash_mismatch",
    "source_path_invalid",
    "source_missing",
    "source_invalid",
    "source_hash_mismatch",
    "candidate_writes_invalid",
    "candidate_write_hash_mismatch",
    "unsupported_candidate_change",
    "compiler_failed",
    "compiler_result_invalid",
    "proof_invalid",
    "storage_unavailable",
    "immutable_conflict",
    "staged_record_missing",
    "staged_record_invalid",
]


class DeckCandidateMaterializationError(RuntimeError):
    """A content-free materialization failure safe to persist or trace."""

    def __init__(self, code: MaterializationErrorCode) -> None:
        self.code = code
        super().__init__(code)


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BaselineManifestHead(_StrictFrozenModel):
    build_id: str = Field(min_length=1, max_length=512)
    user_id: str = Field(min_length=1, max_length=256)
    owner_thread_id: str = Field(min_length=1, max_length=128)
    manifest_revision: int = Field(ge=1)
    manifest_object_path: str = Field(min_length=1, max_length=4_096)
    manifest_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    logical_artifact_id: str | None = None
    current_artifact_version_id: str | None = None
    status: str = Field(min_length=1, max_length=128)
    format: str = Field(min_length=1, max_length=128)
    updated_at: str = Field(min_length=1, max_length=128)


class DeckCandidateSource(_StrictFrozenModel):
    selector: str
    source_role: str
    object_path: str = Field(min_length=1, max_length=4_096)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    content: bytes = Field(max_length=MAX_COMPACT_SOURCE_BYTES)
    model_authored: bool
    component_version_changed: bool


class DerivedDeckSource(_StrictFrozenModel):
    selector: str
    source_role: Literal["assembled"]
    content: str = Field(min_length=1, max_length=MAX_COMPACT_SOURCE_BYTES)


class DeckCandidateCompileRequest(_StrictFrozenModel):
    transaction_id: str
    operation_id: str
    build_id: str
    user_id: str
    thread_id: str
    candidate_manifest_revision: int = Field(ge=2)
    artifact_version_id: str
    candidate_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    baseline_manifest: BuildManifest
    program: DeckRepairProgram
    sources: tuple[DeckCandidateSource, ...]
    derived_source_targets: tuple[tuple[str, Literal["assembled"]], ...] = ()


class DeckCandidateCompilation(_StrictFrozenModel):
    """Verified compiler output; production compilation is injected."""

    pptx_bytes: bytes = Field(min_length=4, max_length=MAX_PPTX_BYTES)
    derived_sources: tuple[DerivedDeckSource, ...] = ()
    build_record: dict[str, Any]
    creative_plan_record: dict[str, Any]
    design_plan_record: dict[str, Any]
    mechanical_record: dict[str, Any]
    mechanical: MechanicalProjection
    native_record: dict[str, Any]
    render_collateral_record: dict[str, Any]
    locality: LocalityProof
    content: ContentPreservationProof
    dq1_publication_metadata: dict[str, Any]


class BaselineManifestRepository(Protocol):
    def load_manifest_head(
        self,
        *,
        build_id: str,
        user_id: str,
    ) -> BaselineManifestHead | Awaitable[BaselineManifestHead]: ...


class ImmutableObjectStore(Protocol):
    def read_bounded(
        self,
        object_path: str,
        *,
        max_bytes: int,
    ) -> bytes | None | Awaitable[bytes | None]: ...

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> Literal["created", "exists"] | Awaitable[Literal["created", "exists"]]: ...


class DeckCandidateCompiler(Protocol):
    def compile(
        self,
        request: DeckCandidateCompileRequest,
    ) -> DeckCandidateCompilation | Awaitable[DeckCandidateCompilation]: ...


class _ImmutableObjectDescriptor(_StrictFrozenModel):
    path: str = Field(min_length=1, max_length=4_096)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(ge=0, le=MAX_PPTX_BYTES)
    content_type: str = Field(min_length=1, max_length=256)
    kind: Literal[
        "source",
        "component_record",
        "artifact",
        "artifact_record",
        "build_record",
        "creative_plan",
        "design_plan",
        "mechanical",
        "native",
        "render_collateral",
        "locality",
        "content",
        "dq1_publication",
        "manifest",
    ]


class _CandidateStageRecord(_StrictFrozenModel):
    schema_version: Literal["sophia-deck-candidate-stage/v1"] = "sophia-deck-candidate-stage/v1"
    transaction_identity_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    candidate_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    program_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    baseline_manifest_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    object_root: str = Field(min_length=1, max_length=4_096)
    manifest_object_path: str = Field(min_length=1, max_length=4_096)
    manifest_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    artifact_record_path: str = Field(min_length=1, max_length=4_096)
    locality_record_path: str = Field(min_length=1, max_length=4_096)
    content_record_path: str = Field(min_length=1, max_length=4_096)
    candidate_version_ids: tuple[str, ...]
    objects: tuple[_ImmutableObjectDescriptor, ...]

    @model_validator(mode="after")
    def require_unique_inventory(self) -> _CandidateStageRecord:
        paths = tuple(item.path for item in self.objects)
        if not paths or len(paths) != len(set(paths)):
            raise ValueError("candidate object inventory is empty or ambiguous")
        if not self.candidate_version_ids or len(self.candidate_version_ids) != len(set(self.candidate_version_ids)):
            raise ValueError("candidate version inventory is empty or ambiguous")
        return self


@dataclass(frozen=True, slots=True)
class _BaselineSource:
    component: BuildComponent
    selector: str
    source_role: str
    object_path: str
    content: bytes
    source_hash: str


@dataclass(frozen=True, slots=True)
class _BaselineState:
    head: BaselineManifestHead
    manifest: BuildManifest
    manifest_bytes: bytes
    sources: dict[tuple[str, str], _BaselineSource]
    object_root: str


@dataclass(frozen=True, slots=True)
class _PendingObject:
    path: str
    content: bytes
    content_type: str
    kind: str

    def descriptor(self) -> _ImmutableObjectDescriptor:
        return _ImmutableObjectDescriptor(
            path=self.path,
            sha256=_sha256(self.content),
            size_bytes=len(self.content),
            content_type=self.content_type,
            kind=self.kind,
        )


async def _maybe_await[ValueT](value: ValueT | Awaitable[ValueT]) -> ValueT:
    if inspect.isawaitable(value):
        return await value
    return value


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _manifest_bytes(manifest: BuildManifest) -> bytes:
    return json.dumps(
        manifest.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _reject_json_constant(_value: str) -> None:
    raise ValueError


def _parse_manifest(raw: bytes) -> BuildManifest:
    try:
        json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        manifest = BuildManifest.model_validate_json(raw)
        if _manifest_bytes(manifest) != raw:
            raise ValueError
        return manifest
    except Exception:
        raise DeckCandidateMaterializationError("manifest_invalid") from None


def _parse_canonical_model[ModelT: BaseModel](raw: bytes, model: type[ModelT]) -> ModelT:
    try:
        json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        parsed = model.model_validate_json(raw)
        if canonical_json_bytes(parsed) != raw:
            raise ValueError
        return parsed
    except Exception:
        raise DeckCandidateMaterializationError("staged_record_invalid") from None


def _stable_id(prefix: str, payload: object) -> str:
    return f"{prefix}_{canonical_sha256(payload)[:24]}"


def _require_segment(value: str, *, default: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 or safe_object_path_segment(value, default=default) != value:
        raise DeckCandidateMaterializationError("invalid_scope")
    return value


def _object_root(transaction: BuildMutationTransaction) -> str:
    user_id = _require_segment(transaction.user_id, default="user")
    thread_id = _require_segment(transaction.owner_thread_id or "", default="thread")
    build_id = _require_segment(transaction.build_id, default="build")
    return normalize_object_path(f"artifacts/{user_id}/{thread_id}/foundation/.builder/builds/{build_id}")


def _transaction_root(transaction: BuildMutationTransaction) -> str:
    transaction_id = _require_segment(transaction.transaction_id, default="transaction")
    return f"{_object_root(transaction)}/deck_design_lift/transactions/{transaction_id}/candidate"


def _stage_record_path(transaction: BuildMutationTransaction) -> str:
    return f"{_transaction_root(transaction)}/materialization.json"


def _rollback_record_path(transaction: BuildMutationTransaction) -> str:
    return f"{_transaction_root(transaction)}/rollback.json"


def _transaction_identity(transaction: BuildMutationTransaction) -> dict[str, object]:
    return {
        "schema_version": "sophia-deck-candidate-transaction-identity/v1",
        "transaction_id": transaction.transaction_id,
        "build_id": transaction.build_id,
        "user_id": transaction.user_id,
        "operation_id": transaction.operation_id,
        "owner_thread_id": transaction.owner_thread_id,
        "expected_manifest_revision": transaction.expected_manifest_revision,
        "expected_artifact_version_id": transaction.expected_artifact_version_id,
        "expected_artifact_hash": transaction.expected_artifact_hash,
        "expected_component_versions": transaction.expected_component_versions,
        "authorized_selectors": transaction.authorized_selectors,
        "authorized_source_roles": transaction.authorized_source_roles,
        "campaign_run_id": transaction.campaign_run_id,
        "repair_program_hash": transaction.repair_program_hash,
        "initial_quality_run_id": transaction.initial_quality_run_id,
    }


def _transaction_identity_hash(transaction: BuildMutationTransaction) -> str:
    return canonical_sha256(_transaction_identity(transaction))


def _candidate_identity_hash(
    transaction: BuildMutationTransaction,
    program: DeckRepairProgram,
    candidate: DeckRepairCandidate,
    baseline_manifest_hash: str,
) -> str:
    return canonical_sha256(
        {
            "schema_version": "sophia-deck-candidate-identity/v1",
            "transaction_identity_hash": _transaction_identity_hash(transaction),
            "program_hash": program.program_hash,
            "candidate": candidate,
            "baseline_manifest_hash": baseline_manifest_hash,
        }
    )


def _head_from_value(value: object) -> BaselineManifestHead:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    try:
        return BaselineManifestHead.model_validate(value)
    except (TypeError, ValidationError, ValueError):
        raise DeckCandidateMaterializationError("stale_manifest") from None


def _require_canonical_object_path(path: str) -> str:
    if not isinstance(path, str) or not path or len(path) > 4_096 or "\\" in path:
        raise DeckCandidateMaterializationError("source_path_invalid")
    try:
        normalized = normalize_object_path(path)
    except ValueError:
        raise DeckCandidateMaterializationError("source_path_invalid") from None
    if normalized != path:
        raise DeckCandidateMaterializationError("source_path_invalid")
    return normalized


def _map_source_path(
    path: str,
    *,
    object_root: str,
    build_id: str,
    thread_id: str,
) -> str:
    if not isinstance(path, str) or not path or len(path) > 4_096 or "\\" in path:
        raise DeckCandidateMaterializationError("source_path_invalid")
    canonical_prefix = f"{object_root}/"
    if path.startswith(canonical_prefix):
        return _require_canonical_object_path(path)

    admitted_prefixes = (
        f"/mnt/user-data/outputs/.builder/builds/{build_id}/",
        (f"{_PRODUCTION_THREAD_SOURCE_ROOT}/{thread_id}/user-data/outputs/.builder/builds/{build_id}/"),
    )
    source_prefix = next(
        (prefix for prefix in admitted_prefixes if path.startswith(prefix)),
        None,
    )
    if source_prefix is None:
        raise DeckCandidateMaterializationError("source_path_invalid")
    suffix = path[len(source_prefix) :]
    parts = suffix.split("/")
    if not suffix or any(part in {"", ".", ".."} for part in parts):
        raise DeckCandidateMaterializationError("source_path_invalid")
    mapped = f"{object_root}/{suffix}"
    return _require_canonical_object_path(mapped)


def _program_scope_is_exact(
    transaction: BuildMutationTransaction,
    program: DeckRepairProgram,
) -> bool:
    return bool(
        transaction.repair_program_hash == program.program_hash
        and transaction.build_id == program.build_id
        and transaction.expected_manifest_revision == program.initial_manifest_revision
        and transaction.initial_quality_run_id == program.initial_quality_run_id
        and transaction.authorized_selectors == list(program.authorized_selectors)
        and transaction.authorized_source_roles == {selector: list(roles) for selector, roles in program.authorized_source_roles.items()}
        and program.repair_attempt == 1
    )


def _candidate_targets(
    transaction: BuildMutationTransaction,
    program: DeckRepairProgram,
    candidate: DeckRepairCandidate,
) -> dict[tuple[str, str], str]:
    if not _program_scope_is_exact(transaction, program):
        raise DeckCandidateMaterializationError("invalid_scope")
    if candidate.creative_plan_patch is not None or candidate.design_plan_patch is not None or candidate.asset_updates:
        raise DeckCandidateMaterializationError("unsupported_candidate_change")
    expected = {(selector, role) for selector in program.authorized_selectors for role in program.authorized_source_roles[selector]}
    updates: dict[tuple[str, str], str] = {}
    for update in candidate.source_updates:
        key = (update.selector, update.source_role)
        if key in updates:
            raise DeckCandidateMaterializationError("candidate_writes_invalid")
        try:
            encoded = update.content.encode("utf-8")
        except UnicodeError:
            raise DeckCandidateMaterializationError("candidate_writes_invalid") from None
        if len(encoded) > MAX_COMPACT_SOURCE_BYTES or b"\x00" in encoded:
            raise DeckCandidateMaterializationError("candidate_writes_invalid")
        updates[key] = update.content
    if not expected or set(updates) != expected:
        raise DeckCandidateMaterializationError("candidate_writes_invalid")
    return updates


def _validate_manifest_shape(
    manifest: BuildManifest,
    transaction: BuildMutationTransaction,
    head: BaselineManifestHead,
    object_root: str,
) -> dict[str, BuildComponent]:
    expected_manifest_path = f"{object_root}/manifest/manifest-r{transaction.expected_manifest_revision}.json"
    deck = manifest.format_extensions.get("deck")
    try:
        components = manifest_components_by_selector(manifest)
    except ValueError:
        raise DeckCandidateMaterializationError("manifest_invalid") from None
    invalid = (
        manifest.build_id != transaction.build_id
        or manifest.user_id != transaction.user_id
        or manifest.thread_id != transaction.owner_thread_id
        or manifest.manifest_revision != transaction.expected_manifest_revision
        or manifest.format != "pptx"
        or manifest.status != "complete"
        or manifest.logical_artifact_id is None
        or manifest.current_artifact_version_id != transaction.expected_artifact_version_id
        or head.build_id != transaction.build_id
        or head.user_id != transaction.user_id
        or head.owner_thread_id != transaction.owner_thread_id
        or head.manifest_revision != transaction.expected_manifest_revision
        or head.manifest_object_path != expected_manifest_path
        or head.current_artifact_version_id != transaction.expected_artifact_version_id
        or head.logical_artifact_id != manifest.logical_artifact_id
        or head.status != manifest.status
        or head.format != manifest.format
        or not isinstance(deck, dict)
        or deck.get("current_pptx_hash") != transaction.expected_artifact_hash
        or deck.get("artifact_storage_object_path") != f"{object_root}/artifacts/{transaction.expected_artifact_version_id}/" + str(deck.get("artifact_storage_object_path", "")).rsplit("/", 1)[-1]
        or len(components) < 2
        or len(components) > MAX_MANIFEST_COMPONENTS
        or set(components) != set(transaction.expected_component_versions)
        or any(components[selector].current_version_id != version_id for selector, version_id in transaction.expected_component_versions.items())
    )
    if invalid:
        raise DeckCandidateMaterializationError("stale_manifest")
    root = components.get(DECK_STYLE_ROOT_SELECTOR)
    slides = [component for component in manifest.components if _SLIDE_SELECTOR_RE.fullmatch(component.selector)]
    if root is None or root.type != "deck_style" or root.shared_dependencies or set(root.source_roles) != {"deck_css"} or not slides or len(slides) != len(manifest.components) - 1:
        raise DeckCandidateMaterializationError("manifest_invalid")
    for component in slides:
        if component.type != "slide" or set(component.source_roles) != _SLIDE_ROLES or component.shared_dependencies != [DECK_STYLE_ROOT_SELECTOR]:
            raise DeckCandidateMaterializationError("manifest_invalid")
    return components


def _validate_record_key(key: str, value: object) -> None:
    normalized = key.casefold().replace("-", "_")
    if normalized in _FORBIDDEN_RECORD_KEYS:
        if normalized.endswith(("_hash", "_path")):
            return
        raise DeckCandidateMaterializationError("compiler_result_invalid")
    if any(marker in normalized for marker in ("api_key", "password", "credential", "raw_error")):
        raise DeckCandidateMaterializationError("compiler_result_invalid")
    _validate_safe_json(value)


def _validate_safe_json(value: object) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise DeckCandidateMaterializationError("compiler_result_invalid")
        return
    if isinstance(value, list):
        for item in value:
            _validate_safe_json(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise DeckCandidateMaterializationError("compiler_result_invalid")
            _validate_record_key(key, item)
        return
    raise DeckCandidateMaterializationError("compiler_result_invalid")


def _safe_record(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise DeckCandidateMaterializationError("compiler_result_invalid")
    payload = dict(value)
    _validate_safe_json(payload)
    encoded = canonical_json_bytes(payload)
    if not encoded or len(encoded) > MAX_JSON_RECORD_BYTES:
        raise DeckCandidateMaterializationError("compiler_result_invalid")
    try:
        normalized = json.loads(encoded.decode("utf-8"), parse_constant=_reject_json_constant)
    except (UnicodeError, ValueError):
        raise DeckCandidateMaterializationError("compiler_result_invalid") from None
    if not isinstance(normalized, dict):
        raise DeckCandidateMaterializationError("compiler_result_invalid")
    return normalized


def _require_record_identity(
    record: Mapping[str, Any],
    *,
    transaction: BuildMutationTransaction,
    artifact_version_id: str,
    candidate_revision: int,
) -> dict[str, Any]:
    normalized = _safe_record(record)
    expected = {
        "build_id": transaction.build_id,
        "transaction_id": transaction.transaction_id,
        "artifact_version_id": artifact_version_id,
        "manifest_revision": candidate_revision,
    }
    if any(normalized.get(key) != value for key, value in expected.items()):
        raise DeckCandidateMaterializationError("compiler_result_invalid")
    return normalized


class DurableDeckCandidateMaterializer:
    """Materialize and reconstruct immutable DQ-2 candidates."""

    def __init__(
        self,
        *,
        manifest_repository: BaselineManifestRepository,
        object_store: ImmutableObjectStore,
        compiler: DeckCandidateCompiler,
    ) -> None:
        self._manifests = manifest_repository
        self._objects = object_store
        self._compiler = compiler

    async def _read(self, path: str, *, max_bytes: int) -> bytes | None:
        try:
            value = await _maybe_await(self._objects.read_bounded(path, max_bytes=max_bytes))
        except Exception:
            raise DeckCandidateMaterializationError("storage_unavailable") from None
        if value is not None and (not isinstance(value, bytes) or len(value) > max_bytes):
            raise DeckCandidateMaterializationError("storage_unavailable")
        return value

    async def _put_verified(self, pending: _PendingObject) -> None:
        _require_canonical_object_path(pending.path)
        try:
            outcome = await _maybe_await(
                self._objects.create_if_absent(
                    pending.path,
                    pending.content,
                    content_type=pending.content_type,
                )
            )
        except Exception:
            raise DeckCandidateMaterializationError("storage_unavailable") from None
        if outcome not in {"created", "exists"}:
            raise DeckCandidateMaterializationError("storage_unavailable")
        if pending.kind == "artifact":
            read_limit = MAX_PPTX_BYTES
        elif pending.kind == "source":
            read_limit = MAX_COMPACT_SOURCE_BYTES
        else:
            read_limit = MAX_JSON_RECORD_BYTES
        try:
            stored = await self._read(pending.path, max_bytes=read_limit)
        except DeckCandidateMaterializationError:
            if outcome == "exists":
                raise DeckCandidateMaterializationError("immutable_conflict") from None
            raise
        if stored is None:
            raise DeckCandidateMaterializationError("storage_unavailable")
        if stored != pending.content:
            raise DeckCandidateMaterializationError("immutable_conflict")

    async def _load_baseline(
        self,
        *,
        transaction: BuildMutationTransaction,
    ) -> _BaselineState:
        object_root = _object_root(transaction)
        try:
            raw_head = await _maybe_await(
                self._manifests.load_manifest_head(
                    build_id=transaction.build_id,
                    user_id=transaction.user_id,
                )
            )
        except DeckCandidateMaterializationError:
            raise
        except Exception:
            raise DeckCandidateMaterializationError("storage_unavailable") from None
        head = _head_from_value(raw_head)
        expected_path = f"{object_root}/manifest/manifest-r{transaction.expected_manifest_revision}.json"
        if head.manifest_object_path != expected_path or head.manifest_hash is None:
            raise DeckCandidateMaterializationError("stale_manifest")
        raw_manifest = await self._read(expected_path, max_bytes=MAX_BASELINE_MANIFEST_BYTES)
        if raw_manifest is None:
            raise DeckCandidateMaterializationError("manifest_missing")
        if _sha256(raw_manifest) != head.manifest_hash:
            raise DeckCandidateMaterializationError("manifest_hash_mismatch")
        manifest = _parse_manifest(raw_manifest)
        components = _validate_manifest_shape(manifest, transaction, head, object_root)

        sources: dict[tuple[str, str], _BaselineSource] = {}
        seen_paths: set[str] = set()
        total_bytes = 0
        for component in manifest.components:
            for role in sorted(component.source_roles):
                if role not in _COMPACT_ROLES:
                    raise DeckCandidateMaterializationError("manifest_invalid")
                expected_hash = component.source_hashes.get(role)
                if not isinstance(expected_hash, str) or _SHA256_RE.fullmatch(expected_hash) is None:
                    raise DeckCandidateMaterializationError("manifest_invalid")
                path = _map_source_path(
                    component.source_roles[role],
                    object_root=object_root,
                    build_id=transaction.build_id,
                    thread_id=str(transaction.owner_thread_id),
                )
                if path in seen_paths:
                    raise DeckCandidateMaterializationError("source_path_invalid")
                seen_paths.add(path)
                raw = await self._read(path, max_bytes=MAX_COMPACT_SOURCE_BYTES)
                if raw is None:
                    raise DeckCandidateMaterializationError("source_missing")
                try:
                    raw.decode("utf-8")
                except UnicodeError:
                    raise DeckCandidateMaterializationError("source_invalid") from None
                if b"\x00" in raw:
                    raise DeckCandidateMaterializationError("source_invalid")
                total_bytes += len(raw)
                if total_bytes > MAX_TOTAL_COMPACT_SOURCE_BYTES:
                    raise DeckCandidateMaterializationError("source_invalid")
                if _sha256(raw) != expected_hash:
                    raise DeckCandidateMaterializationError("source_hash_mismatch")
                sources[(component.selector, role)] = _BaselineSource(
                    component=components[component.selector],
                    selector=component.selector,
                    source_role=role,
                    object_path=path,
                    content=raw,
                    source_hash=expected_hash,
                )
        root_hash = sources[(DECK_STYLE_ROOT_SELECTOR, "deck_css")].source_hash
        for component in manifest.components:
            unknown_hashes = set(component.source_hashes) - _COMPACT_ROLES
            if unknown_hashes:
                raise DeckCandidateMaterializationError("manifest_invalid")
            if component.selector != DECK_STYLE_ROOT_SELECTOR:
                dependency_hash = component.source_hashes.get("deck_css")
                if dependency_hash is not None and dependency_hash != root_hash:
                    raise DeckCandidateMaterializationError("source_hash_mismatch")
        return _BaselineState(
            head=head,
            manifest=manifest,
            manifest_bytes=raw_manifest,
            sources=sources,
            object_root=object_root,
        )

    @staticmethod
    def _version_ids(
        *,
        transaction: BuildMutationTransaction,
        candidate_hash: str,
        changed_selectors: set[str],
        manifest: BuildManifest,
    ) -> tuple[str, dict[str, tuple[str, str]]]:
        artifact_id = _stable_id(
            "artifact_version",
            {
                "transaction_id": transaction.transaction_id,
                "candidate_hash": candidate_hash,
                "kind": "pptx",
            },
        )
        component_ids: dict[str, tuple[str, str]] = {}
        for component in manifest.components:
            if component.selector not in changed_selectors:
                continue
            source_id = _stable_id(
                "source_version",
                {
                    "transaction_id": transaction.transaction_id,
                    "candidate_hash": candidate_hash,
                    "selector": component.selector,
                },
            )
            component_id = _stable_id(
                "component_version",
                {
                    "transaction_id": transaction.transaction_id,
                    "source_version_id": source_id,
                    "selector": component.selector,
                },
            )
            component_ids[component.selector] = (component_id, source_id)
        return artifact_id, component_ids

    @staticmethod
    def _candidate_source_path(
        *,
        baseline: _BaselineState,
        component: BuildComponent,
        component_version_id: str,
        role: str,
    ) -> str:
        if safe_object_path_segment(component.id, default="component") != component.id:
            raise DeckCandidateMaterializationError("manifest_invalid")
        return f"{baseline.object_root}/components/{component.id}/versions/{component_version_id}/{_ROLE_FILENAMES[role]}"

    def _compile_request(
        self,
        *,
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
        baseline: _BaselineState,
        candidate_hash: str,
        updates: dict[tuple[str, str], str],
        artifact_version_id: str,
        component_version_ids: dict[str, tuple[str, str]],
    ) -> DeckCandidateCompileRequest:
        sources: list[DeckCandidateSource] = []
        derived_targets: list[tuple[str, Literal["assembled"]]] = []
        shared_style_changed = (DECK_STYLE_ROOT_SELECTOR, "deck_css") in updates
        for component in baseline.manifest.components:
            changed = component.selector in component_version_ids
            for role in sorted(component.source_roles):
                source = baseline.sources[(component.selector, role)]
                content = updates.get((component.selector, role), source.content.decode("utf-8")).encode("utf-8")
                object_path = source.object_path
                if changed:
                    object_path = self._candidate_source_path(
                        baseline=baseline,
                        component=component,
                        component_version_id=component_version_ids[component.selector][0],
                        role=role,
                    )
                sources.append(
                    DeckCandidateSource(
                        selector=component.selector,
                        source_role=role,
                        object_path=object_path,
                        source_hash=_sha256(content),
                        content=content,
                        model_authored=(component.selector, role) in updates,
                        component_version_changed=changed,
                    )
                )
            changed_roles = {role for selector, role in updates if selector == component.selector}
            if component.selector != DECK_STYLE_ROOT_SELECTOR and (shared_style_changed or changed_roles.intersection({"body", "slide_css"})):
                derived_targets.append((component.selector, "assembled"))
        return DeckCandidateCompileRequest(
            transaction_id=transaction.transaction_id,
            operation_id=transaction.operation_id,
            build_id=transaction.build_id,
            user_id=transaction.user_id,
            thread_id=str(transaction.owner_thread_id),
            candidate_manifest_revision=transaction.expected_manifest_revision + 1,
            artifact_version_id=artifact_version_id,
            candidate_hash=candidate_hash,
            baseline_manifest=baseline.manifest,
            program=program,
            sources=tuple(sources),
            derived_source_targets=tuple(derived_targets),
        )

    @staticmethod
    def _validate_compilation(
        compilation: DeckCandidateCompilation,
        *,
        request: DeckCandidateCompileRequest,
        transaction: BuildMutationTransaction,
        changed_selectors: set[str],
    ) -> dict[str, dict[str, Any]]:
        if not compilation.pptx_bytes.startswith(b"PK\x03\x04"):
            raise DeckCandidateMaterializationError("compiler_result_invalid")
        if compilation.mechanical.status != "passed":
            raise DeckCandidateMaterializationError("proof_invalid")
        mechanical_record = _safe_record(compilation.mechanical_record)
        if canonical_sha256(mechanical_record) != compilation.mechanical.authoritative_record_hash:
            raise DeckCandidateMaterializationError("proof_invalid")
        slide_selectors = tuple(component.selector for component in request.baseline_manifest.components if component.selector != DECK_STYLE_ROOT_SELECTOR)
        expected_unchanged = set(transaction.expected_component_versions) - changed_selectors
        locality = compilation.locality
        shared_changed = DECK_STYLE_ROOT_SELECTOR in changed_selectors
        if (
            tuple(locality.authorized_selectors) != tuple(request.program.authorized_selectors)
            or set(locality.changed_component_versions) != changed_selectors
            or set(locality.unchanged_component_versions) != expected_unchanged
            or locality.unexpected_changes
            or locality.shared_dependency_changed != shared_changed
            or not locality.native_inventory_preserved
            or not locality.render_collateral_within_tolerance
        ):
            raise DeckCandidateMaterializationError("proof_invalid")
        content = compilation.content
        if not (
            content.brief_preserved
            and content.initial_slide_count == len(slide_selectors)
            and content.candidate_slide_count == len(slide_selectors)
            and content.required_content_preserved
            and content.factual_content_preserved
            and content.native_editability_preserved
        ):
            raise DeckCandidateMaterializationError("proof_invalid")
        native = _require_record_identity(
            compilation.native_record,
            transaction=transaction,
            artifact_version_id=request.artifact_version_id,
            candidate_revision=request.candidate_manifest_revision,
        )
        if native.get("verified") is not True or native.get("native_editable") is not True or native.get("full_slide_picture_count") != 0 or native.get("slide_count") != len(slide_selectors):
            raise DeckCandidateMaterializationError("proof_invalid")
        render = _require_record_identity(
            compilation.render_collateral_record,
            transaction=transaction,
            artifact_version_id=request.artifact_version_id,
            candidate_revision=request.candidate_manifest_revision,
        )
        if render.get("verified") is not True or render.get("within_tolerance") is not True or tuple(render.get("expected_selectors", ())) != slide_selectors or tuple(render.get("rendered_selectors", ())) != slide_selectors:
            raise DeckCandidateMaterializationError("proof_invalid")
        derived = {(item.selector, item.source_role): item for item in compilation.derived_sources}
        if len(derived) != len(compilation.derived_sources) or set(derived) != set(request.derived_source_targets):
            raise DeckCandidateMaterializationError("compiler_result_invalid")
        records = {
            "build": _require_record_identity(
                compilation.build_record,
                transaction=transaction,
                artifact_version_id=request.artifact_version_id,
                candidate_revision=request.candidate_manifest_revision,
            ),
            "creative_plan": _require_record_identity(
                compilation.creative_plan_record,
                transaction=transaction,
                artifact_version_id=request.artifact_version_id,
                candidate_revision=request.candidate_manifest_revision,
            ),
            "design_plan": _require_record_identity(
                compilation.design_plan_record,
                transaction=transaction,
                artifact_version_id=request.artifact_version_id,
                candidate_revision=request.candidate_manifest_revision,
            ),
            "mechanical_record": mechanical_record,
            "native": native,
            "render": render,
            "publication": _require_record_identity(
                compilation.dq1_publication_metadata,
                transaction=transaction,
                artifact_version_id=request.artifact_version_id,
                candidate_revision=request.candidate_manifest_revision,
            ),
        }
        if records["build"].get("slide_count") != len(slide_selectors) or records["creative_plan"].get("plan_revision_changed") is not False or records["design_plan"].get("plan_revision_changed") is not False:
            raise DeckCandidateMaterializationError("proof_invalid")
        return records

    @staticmethod
    def _record_paths(transaction: BuildMutationTransaction) -> dict[str, str]:
        root = _transaction_root(transaction)
        return {
            "build": f"{root}/records/build.json",
            "creative_plan": f"{root}/records/creative_plan.json",
            "design_plan": f"{root}/records/design_plan.json",
            "mechanical": f"{root}/records/mechanical.json",
            "native": f"{root}/records/native.json",
            "render": f"{root}/records/render_collateral.json",
            "locality": f"{root}/records/locality.json",
            "content": f"{root}/records/content.json",
            "publication": f"{root}/records/dq1_publication.json",
        }

    def _materialized_objects(
        self,
        *,
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
        baseline: _BaselineState,
        request: DeckCandidateCompileRequest,
        compilation: DeckCandidateCompilation,
        records: dict[str, dict[str, Any]],
        component_version_ids: dict[str, tuple[str, str]],
    ) -> tuple[list[_PendingObject], BuildArtifactVersion, BuildManifest, tuple[str, ...]]:
        source_values = {(item.selector, item.source_role): item for item in request.sources}
        for derived in compilation.derived_sources:
            key = (derived.selector, derived.source_role)
            existing = source_values[key]
            content = derived.content.encode("utf-8")
            source_values[key] = existing.model_copy(update={"content": content, "source_hash": _sha256(content)})

        pending: list[_PendingObject] = []
        candidate_components: list[BuildComponent] = []
        candidate_ids: list[str] = [request.artifact_version_id]
        candidate_deck_css_hash = source_values[(DECK_STYLE_ROOT_SELECTOR, "deck_css")].source_hash
        for component in baseline.manifest.components:
            version_pair = component_version_ids.get(component.selector)
            if version_pair is None:
                canonical_roles = {role: baseline.sources[(component.selector, role)].object_path for role in sorted(component.source_roles)}
                candidate_components.append(
                    component.model_copy(
                        update={
                            "source_path": canonical_roles.get("body") or canonical_roles.get("deck_css") or next(iter(canonical_roles.values())),
                            "source_roles": canonical_roles,
                        },
                        deep=True,
                    )
                )
                continue
            component_version_id, source_version_id = version_pair
            candidate_ids.extend((component_version_id, source_version_id))
            roles: dict[str, str] = {}
            hashes: dict[str, str] = {}
            source_paths: list[str] = []
            for role in sorted(component.source_roles):
                source = source_values[(component.selector, role)]
                roles[role] = source.object_path
                hashes[role] = source.source_hash
                source_paths.append(source.object_path)
                pending.append(
                    _PendingObject(
                        path=source.object_path,
                        content=source.content,
                        content_type=_ROLE_CONTENT_TYPES[role],
                        kind="source",
                    )
                )
            if DECK_STYLE_ROOT_SELECTOR in component.shared_dependencies:
                hashes["deck_css"] = candidate_deck_css_hash
            resolved_hash = hashes.get("assembled") or hashes.get("deck_css")
            component_version = BuildComponentVersion(
                version_id=component_version_id,
                component_id=component.id,
                selector=component.selector,
                source_version_id=source_version_id,
                source_paths=source_paths,
                source_hashes=hashes,
                source_roles=roles,
                asset_version_ids=[],
                resolved_output_hash=resolved_hash,
                authored_by="quality_repair",
                instruction_hash=program.program_hash,
                transaction_id=transaction.transaction_id,
                created_at=baseline.manifest.updated_at,
            )
            component_record_path = f"{baseline.object_root}/components/{component.id}/versions/{component_version_id}/component.json"
            pending.append(
                _PendingObject(
                    path=component_record_path,
                    content=canonical_json_bytes(component_version),
                    content_type=_JSON_CONTENT_TYPE,
                    kind="component_record",
                )
            )
            provenance = dict(component.provenance)
            provenance.update(
                {
                    "authored_by": "quality_repair",
                    "source_version_id": source_version_id,
                    "transaction_id": transaction.transaction_id,
                    "repair_program_hash": program.program_hash,
                    "component_version_record_path": component_record_path,
                }
            )
            gate_results = dict(component.gate_results)
            gate_results.update(
                {
                    "mechanical_passed": True,
                    "source_retention_passed": True,
                }
            )
            candidate_components.append(
                component.model_copy(
                    update={
                        "source_path": roles.get("body") or roles.get("deck_css") or source_paths[0],
                        "source_roles": roles,
                        "source_hashes": hashes,
                        "gate_results": gate_results,
                        "current_version_id": component_version_id,
                        "provenance": provenance,
                    },
                    deep=True,
                )
            )

        artifact_path = f"{baseline.object_root}/artifacts/{request.artifact_version_id}/candidate.pptx"
        artifact_hash = _sha256(compilation.pptx_bytes)
        artifact = BuildArtifactVersion(
            version_id=request.artifact_version_id,
            build_id=transaction.build_id,
            logical_artifact_id=str(baseline.manifest.logical_artifact_id),
            manifest_revision=request.candidate_manifest_revision,
            artifact_path=(f"/mnt/user-data/outputs/.builder/builds/{transaction.build_id}/artifacts/{request.artifact_version_id}/candidate.pptx"),
            artifact_hash=artifact_hash,
            storage_object_path=artifact_path,
            verified=True,
            created_at=baseline.manifest.updated_at,
        )
        artifact_record_path = f"{baseline.object_root}/artifacts/{request.artifact_version_id}/version.json"
        pending.extend(
            [
                _PendingObject(
                    path=artifact_path,
                    content=compilation.pptx_bytes,
                    content_type=_PPTX_CONTENT_TYPE,
                    kind="artifact",
                ),
                _PendingObject(
                    path=artifact_record_path,
                    content=canonical_json_bytes(artifact),
                    content_type=_JSON_CONTENT_TYPE,
                    kind="artifact_record",
                ),
            ]
        )

        record_paths = self._record_paths(transaction)
        mechanical_payload = {
            "schema_version": "sophia-deck-candidate-mechanical/v1",
            "projection": compilation.mechanical.model_dump(mode="json"),
            "authoritative_record": records["mechanical_record"],
        }
        record_payloads: tuple[tuple[str, object, str], ...] = (
            ("build", records["build"], "build_record"),
            ("creative_plan", records["creative_plan"], "creative_plan"),
            ("design_plan", records["design_plan"], "design_plan"),
            ("mechanical", mechanical_payload, "mechanical"),
            ("native", records["native"], "native"),
            ("render", records["render"], "render_collateral"),
            ("locality", compilation.locality, "locality"),
            ("content", compilation.content, "content"),
            ("publication", records["publication"], "dq1_publication"),
        )
        for key, payload, kind in record_payloads:
            pending.append(
                _PendingObject(
                    path=record_paths[key],
                    content=canonical_json_bytes(payload),
                    content_type=_JSON_CONTENT_TYPE,
                    kind=kind,
                )
            )

        extension = dict(baseline.manifest.format_extensions)
        deck_extension = dict(extension.get("deck") or {})
        deck_extension.update(
            {
                "current_pptx_hash": artifact_hash,
                "artifact_storage_object_path": artifact_path,
                "source_bundle_path": f"{baseline.object_root}/components",
                "deck_build_path": record_paths["build"],
                "creative_plan_path": record_paths["creative_plan"],
                "design_plan_path": record_paths["design_plan"],
                "mechanical_record_path": record_paths["mechanical"],
                "native_record_path": record_paths["native"],
                "render_collateral_path": record_paths["render"],
                "locality_record_path": record_paths["locality"],
                "content_record_path": record_paths["content"],
                "dq1_publication_metadata_path": record_paths["publication"],
                "quality_repair_transaction_id": transaction.transaction_id,
                "repair_program_hash": program.program_hash,
            }
        )
        extension["deck"] = deck_extension
        candidate_manifest = baseline.manifest.model_copy(
            update={
                "manifest_revision": request.candidate_manifest_revision,
                "current_artifact_version_id": request.artifact_version_id,
                "deliverable_path": artifact.artifact_path,
                "components": candidate_components,
                "format_extensions": extension,
                "updated_at": baseline.manifest.updated_at,
            },
            deep=True,
        )
        manifest_path = f"{baseline.object_root}/manifest/manifest-r{request.candidate_manifest_revision}.json"
        pending.append(
            _PendingObject(
                path=manifest_path,
                content=_manifest_bytes(candidate_manifest),
                content_type=_JSON_CONTENT_TYPE,
                kind="manifest",
            )
        )
        return pending, artifact, candidate_manifest, tuple(candidate_ids)

    async def stage(
        self,
        *,
        transaction: BuildMutationTransaction,
        program: DeckRepairProgram,
        candidate: DeckRepairCandidate,
    ) -> StagedDeckCandidate:
        updates = _candidate_targets(transaction, program, candidate)
        baseline = await self._load_baseline(transaction=transaction)
        for update in candidate.source_updates:
            source = baseline.sources.get((update.selector, update.source_role))
            if source is None:
                raise DeckCandidateMaterializationError("candidate_writes_invalid")
            if update.expected_source_hash != source.source_hash:
                raise DeckCandidateMaterializationError("candidate_write_hash_mismatch")

        candidate_hash = _candidate_identity_hash(
            transaction,
            program,
            candidate,
            baseline.head.manifest_hash,
        )
        existing_stage = await self._read(
            _stage_record_path(transaction),
            max_bytes=MAX_STAGE_RECORD_BYTES,
        )
        if existing_stage is not None:
            record = _parse_canonical_model(existing_stage, _CandidateStageRecord)
            if record.candidate_hash != candidate_hash or record.program_hash != program.program_hash or record.baseline_manifest_hash != baseline.head.manifest_hash:
                raise DeckCandidateMaterializationError("immutable_conflict")
            return await self._load_from_record(transaction=transaction, record=record)

        try:
            changed_selectors = set(
                component_dependency_closure(
                    baseline.manifest,
                    {selector for selector, _role in updates},
                )
            )
        except ValueError:
            raise DeckCandidateMaterializationError("manifest_invalid") from None
        artifact_id, component_ids = self._version_ids(
            transaction=transaction,
            candidate_hash=candidate_hash,
            changed_selectors=changed_selectors,
            manifest=baseline.manifest,
        )
        compile_request = self._compile_request(
            transaction=transaction,
            program=program,
            baseline=baseline,
            candidate_hash=candidate_hash,
            updates=updates,
            artifact_version_id=artifact_id,
            component_version_ids=component_ids,
        )
        try:
            raw_compilation = await _maybe_await(self._compiler.compile(compile_request))
            compilation = raw_compilation if isinstance(raw_compilation, DeckCandidateCompilation) else DeckCandidateCompilation.model_validate(raw_compilation)
        except DeckCandidateMaterializationError:
            raise
        except Exception:
            raise DeckCandidateMaterializationError("compiler_failed") from None
        records = self._validate_compilation(
            compilation,
            request=compile_request,
            transaction=transaction,
            changed_selectors=changed_selectors,
        )
        pending, _artifact, candidate_manifest, candidate_ids = self._materialized_objects(
            transaction=transaction,
            program=program,
            baseline=baseline,
            request=compile_request,
            compilation=compilation,
            records=records,
            component_version_ids=component_ids,
        )
        descriptors = tuple(item.descriptor() for item in pending)
        record_paths = self._record_paths(transaction)
        manifest_pending = next(item for item in pending if item.kind == "manifest")
        artifact_record = next(item for item in pending if item.kind == "artifact_record")
        stage_record = _CandidateStageRecord(
            transaction_identity_hash=_transaction_identity_hash(transaction),
            candidate_hash=candidate_hash,
            program_hash=program.program_hash,
            baseline_manifest_hash=baseline.head.manifest_hash,
            object_root=baseline.object_root,
            manifest_object_path=manifest_pending.path,
            manifest_hash=_sha256(manifest_pending.content),
            artifact_record_path=artifact_record.path,
            locality_record_path=record_paths["locality"],
            content_record_path=record_paths["content"],
            candidate_version_ids=candidate_ids,
            objects=descriptors,
        )
        for item in pending:
            await self._put_verified(item)
        await self._put_verified(
            _PendingObject(
                path=_stage_record_path(transaction),
                content=canonical_json_bytes(stage_record),
                content_type=_JSON_CONTENT_TYPE,
                kind="build_record",
            )
        )
        if _manifest_bytes(candidate_manifest) != manifest_pending.content:
            raise DeckCandidateMaterializationError("compiler_result_invalid")
        return await self._load_from_record(transaction=transaction, record=stage_record)

    @staticmethod
    def _descriptor_limit(descriptor: _ImmutableObjectDescriptor) -> int:
        if descriptor.kind == "artifact":
            return MAX_PPTX_BYTES
        if descriptor.kind == "source":
            return MAX_COMPACT_SOURCE_BYTES
        return MAX_JSON_RECORD_BYTES

    async def _verified_descriptor_bytes(
        self,
        descriptor: _ImmutableObjectDescriptor,
        *,
        object_root: str,
    ) -> bytes:
        if not descriptor.path.startswith(f"{object_root}/"):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        _require_canonical_object_path(descriptor.path)
        limit = self._descriptor_limit(descriptor)
        if descriptor.size_bytes > limit:
            raise DeckCandidateMaterializationError("staged_record_invalid")
        raw = await self._read(descriptor.path, max_bytes=limit)
        if raw is None:
            raise DeckCandidateMaterializationError("staged_record_missing")
        if len(raw) != descriptor.size_bytes or _sha256(raw) != descriptor.sha256:
            raise DeckCandidateMaterializationError("staged_record_invalid")
        return raw

    async def _load_from_record(
        self,
        *,
        transaction: BuildMutationTransaction,
        record: _CandidateStageRecord,
    ) -> StagedDeckCandidate:
        object_root = _object_root(transaction)
        if (
            record.transaction_identity_hash != _transaction_identity_hash(transaction)
            or record.program_hash != transaction.repair_program_hash
            or record.object_root != object_root
            or record.manifest_object_path != f"{object_root}/manifest/manifest-r{transaction.expected_manifest_revision + 1}.json"
        ):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        by_kind: dict[str, list[tuple[_ImmutableObjectDescriptor, bytes]]] = {}
        for descriptor in record.objects:
            raw = await self._verified_descriptor_bytes(descriptor, object_root=object_root)
            by_kind.setdefault(descriptor.kind, []).append((descriptor, raw))
        singleton_kinds = {
            "artifact",
            "artifact_record",
            "build_record",
            "creative_plan",
            "design_plan",
            "mechanical",
            "native",
            "render_collateral",
            "locality",
            "content",
            "dq1_publication",
            "manifest",
        }
        if any(len(by_kind.get(kind, ())) != 1 for kind in singleton_kinds):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        if not by_kind.get("source") or not by_kind.get("component_record"):
            raise DeckCandidateMaterializationError("staged_record_invalid")

        artifact = _parse_canonical_model(
            by_kind["artifact_record"][0][1],
            BuildArtifactVersion,
        )
        artifact_descriptor, artifact_bytes = by_kind["artifact"][0]
        if (
            record.artifact_record_path != by_kind["artifact_record"][0][0].path
            or artifact.storage_object_path != artifact_descriptor.path
            or artifact.artifact_hash != _sha256(artifact_bytes)
            or artifact.version_id not in record.candidate_version_ids
            or artifact.build_id != transaction.build_id
            or artifact.manifest_revision != transaction.expected_manifest_revision + 1
            or not artifact.verified
            or not artifact_bytes.startswith(b"PK\x03\x04")
        ):
            raise DeckCandidateMaterializationError("staged_record_invalid")

        manifest_descriptor, manifest_raw = by_kind["manifest"][0]
        if manifest_descriptor.path != record.manifest_object_path or manifest_descriptor.sha256 != record.manifest_hash:
            raise DeckCandidateMaterializationError("staged_record_invalid")
        candidate_manifest = _parse_manifest(manifest_raw)
        try:
            components = manifest_components_by_selector(candidate_manifest)
        except ValueError:
            raise DeckCandidateMaterializationError("staged_record_invalid") from None
        for component in candidate_manifest.components:
            if not component.source_roles:
                raise DeckCandidateMaterializationError("staged_record_invalid")
            for role, path in component.source_roles.items():
                if role not in _COMPACT_ROLES or not path.startswith(f"{object_root}/") or _SHA256_RE.fullmatch(component.source_hashes.get(role, "")) is None:
                    raise DeckCandidateMaterializationError("staged_record_invalid")
                try:
                    _require_canonical_object_path(path)
                except DeckCandidateMaterializationError:
                    raise DeckCandidateMaterializationError("staged_record_invalid") from None
        candidate_versions = {selector: component.current_version_id for selector, component in components.items()}
        if set(candidate_versions) != set(transaction.expected_component_versions):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        changed = {selector for selector, version_id in candidate_versions.items() if transaction.expected_component_versions[selector] != version_id}
        try:
            expected_changed = set(
                component_dependency_closure(
                    candidate_manifest,
                    transaction.authorized_selectors,
                )
            )
        except ValueError:
            raise DeckCandidateMaterializationError("staged_record_invalid") from None
        if not changed or changed != expected_changed:
            raise DeckCandidateMaterializationError("staged_record_invalid")

        component_records: dict[str, BuildComponentVersion] = {}
        for descriptor, raw in by_kind["component_record"]:
            version = _parse_canonical_model(raw, BuildComponentVersion)
            if version.selector in component_records:
                raise DeckCandidateMaterializationError("staged_record_invalid")
            expected_path = f"{object_root}/components/{version.component_id}/versions/{version.version_id}/component.json"
            if descriptor.path != expected_path:
                raise DeckCandidateMaterializationError("staged_record_invalid")
            component_records[version.selector] = version
        if set(component_records) != changed:
            raise DeckCandidateMaterializationError("staged_record_invalid")
        source_descriptors = {descriptor.path: descriptor for descriptor, _raw in by_kind["source"]}
        source_paths: set[str] = set()
        derived_version_ids: set[str] = {artifact.version_id}
        for selector, version in component_records.items():
            component = components[selector]
            if (
                version.version_id != component.current_version_id
                or version.component_id != component.id
                or version.source_roles != component.source_roles
                or version.source_hashes != component.source_hashes
                or version.authored_by != "quality_repair"
                or version.transaction_id != transaction.transaction_id
            ):
                raise DeckCandidateMaterializationError("staged_record_invalid")
            derived_version_ids.update((version.version_id, version.source_version_id))
            for role, path in version.source_roles.items():
                descriptor = source_descriptors.get(path)
                if descriptor is None or descriptor.sha256 != version.source_hashes.get(role):
                    raise DeckCandidateMaterializationError("staged_record_invalid")
                source_paths.add(path)
        if set(source_descriptors) != source_paths or set(record.candidate_version_ids) != derived_version_ids:
            raise DeckCandidateMaterializationError("staged_record_invalid")

        mechanical_payload = self._parse_canonical_dict(by_kind["mechanical"][0][1])
        try:
            mechanical = MechanicalProjection.model_validate(mechanical_payload["projection"])
            authoritative = mechanical_payload["authoritative_record"]
        except (KeyError, TypeError, ValidationError, ValueError):
            raise DeckCandidateMaterializationError("staged_record_invalid") from None
        if mechanical.status != "passed" or canonical_sha256(authoritative) != mechanical.authoritative_record_hash:
            raise DeckCandidateMaterializationError("staged_record_invalid")
        locality = _parse_canonical_model(by_kind["locality"][0][1], LocalityProof)
        content = _parse_canonical_model(by_kind["content"][0][1], ContentPreservationProof)
        slide_selectors = tuple(component.selector for component in candidate_manifest.components if component.selector != DECK_STYLE_ROOT_SELECTOR)
        if (
            record.locality_record_path != by_kind["locality"][0][0].path
            or record.content_record_path != by_kind["content"][0][0].path
            or set(locality.changed_component_versions) != changed
            or set(locality.unchanged_component_versions) != set(transaction.expected_component_versions) - changed
            or tuple(locality.authorized_selectors) != tuple(transaction.authorized_selectors)
            or locality.unexpected_changes
            or locality.shared_dependency_changed != (DECK_STYLE_ROOT_SELECTOR in changed)
            or not locality.native_inventory_preserved
            or not locality.render_collateral_within_tolerance
            or not content.brief_preserved
            or content.initial_slide_count != len(slide_selectors)
            or content.candidate_slide_count != len(slide_selectors)
            or not content.required_content_preserved
            or not content.factual_content_preserved
            or not content.native_editability_preserved
        ):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        loaded_records: dict[str, dict[str, Any]] = {}
        for kind in (
            "build_record",
            "creative_plan",
            "design_plan",
            "native",
            "render_collateral",
            "dq1_publication",
        ):
            payload = self._parse_canonical_dict(by_kind[kind][0][1])
            loaded_records[kind] = payload
            expected = {
                "build_id": transaction.build_id,
                "transaction_id": transaction.transaction_id,
                "artifact_version_id": artifact.version_id,
                "manifest_revision": transaction.expected_manifest_revision + 1,
            }
            if any(payload.get(key) != value for key, value in expected.items()):
                raise DeckCandidateMaterializationError("staged_record_invalid")
        if (
            loaded_records["build_record"].get("slide_count") != len(slide_selectors)
            or loaded_records["creative_plan"].get("plan_revision_changed") is not False
            or loaded_records["design_plan"].get("plan_revision_changed") is not False
            or loaded_records["native"].get("verified") is not True
            or loaded_records["native"].get("native_editable") is not True
            or loaded_records["native"].get("full_slide_picture_count") != 0
            or loaded_records["native"].get("slide_count") != len(slide_selectors)
            or loaded_records["render_collateral"].get("verified") is not True
            or loaded_records["render_collateral"].get("within_tolerance") is not True
            or tuple(loaded_records["render_collateral"].get("expected_selectors", ())) != slide_selectors
            or tuple(loaded_records["render_collateral"].get("rendered_selectors", ())) != slide_selectors
        ):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        deck = candidate_manifest.format_extensions.get("deck")
        if (
            candidate_manifest.build_id != transaction.build_id
            or candidate_manifest.user_id != transaction.user_id
            or candidate_manifest.thread_id != transaction.owner_thread_id
            or candidate_manifest.manifest_revision != transaction.expected_manifest_revision + 1
            or candidate_manifest.current_artifact_version_id != artifact.version_id
            or not isinstance(deck, dict)
            or deck.get("current_pptx_hash") != artifact.artifact_hash
            or deck.get("artifact_storage_object_path") != artifact.storage_object_path
        ):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        staged_paths = tuple(item.path for item in record.objects) + (_stage_record_path(transaction),)
        staged = StagedDeckCandidate(
            artifact=artifact,
            candidate_manifest=candidate_manifest,
            manifest_object_path=record.manifest_object_path,
            manifest_hash=record.manifest_hash,
            staged_object_paths=staged_paths,
            candidate_version_ids=record.candidate_version_ids,
            locality=locality,
            content=content,
        )
        if transaction.candidate_manifest_object_path is not None and (
            transaction.candidate_manifest_object_path != staged.manifest_object_path
            or transaction.candidate_manifest_hash != staged.manifest_hash
            or transaction.candidate_artifact_version_id != staged.artifact.version_id
            or transaction.candidate_artifact_hash != staged.artifact.artifact_hash
            or transaction.staged_object_paths != list(staged.staged_object_paths)
            or transaction.candidate_version_ids != list(staged.candidate_version_ids)
        ):
            raise DeckCandidateMaterializationError("staged_record_invalid")
        return staged

    @staticmethod
    def _parse_canonical_dict(raw: bytes) -> dict[str, Any]:
        try:
            value = json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
            if not isinstance(value, dict) or canonical_json_bytes(value) != raw:
                raise ValueError
            _validate_safe_json(value)
            return value
        except DeckCandidateMaterializationError:
            raise
        except Exception:
            raise DeckCandidateMaterializationError("staged_record_invalid") from None

    async def load_staged(
        self,
        *,
        transaction: BuildMutationTransaction,
    ) -> StagedDeckCandidate:
        raw = await self._read(
            _stage_record_path(transaction),
            max_bytes=MAX_STAGE_RECORD_BYTES,
        )
        if raw is None:
            raise DeckCandidateMaterializationError("staged_record_missing")
        record = _parse_canonical_model(raw, _CandidateStageRecord)
        return await self._load_from_record(transaction=transaction, record=record)

    async def rollback(
        self,
        *,
        transaction: BuildMutationTransaction,
    ) -> None:
        payload = {
            "schema_version": "sophia-deck-candidate-rollback/v1",
            "transaction_identity_hash": _transaction_identity_hash(transaction),
            "action": "retain_immutable_candidate_objects_for_gc",
            "current_pointer_moved": False,
        }
        await self._put_verified(
            _PendingObject(
                path=_rollback_record_path(transaction),
                content=canonical_json_bytes(payload),
                content_type=_JSON_CONTENT_TYPE,
                kind="build_record",
            )
        )
