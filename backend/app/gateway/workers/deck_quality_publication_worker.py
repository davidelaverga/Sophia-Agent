"""Bounded materializer for the durable DQ-1 publication outbox.

The worker reads only rows already admitted into the canary-only publication
outbox.  It verifies the row and immutable source pack before following the
pack's accepted-PPTX reference, reconstructs a short-lived local workspace,
freezes the v2 pre-render input manifest, and atomically promotes that manifest
through the publication store.  It never renders a preview or invokes a model.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import json
import logging
import os
import re
import socket
import tempfile
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol

from pydantic import ValidationError

from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationErrorCode,
    PublicationLease,
    PublicationRecord,
    PublicationRequest,
    PublicationState,
    SupabaseDeckQualityPublicationStore,
    configured_deck_quality_publication_store,
    expected_publication_source_pack_path,
)
from deerflow.sophia.deck_quality.publisher import (
    DECK_QUALITY_PRODUCER_FAILURE_PREFIX,
    DECK_QUALITY_PRODUCER_PREFIX,
    DeckQualityProducerOutboxManifest,
    DeckQualityProducerQuarantineReason,
    DeckQualitySourcePack,
    deck_quality_producer_archive_path,
    deck_quality_producer_oversize_quarantine_path,
    deck_quality_producer_quarantine_path,
    decode_deck_quality_producer_bundle,
    parse_deck_quality_producer_bundle_path,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock
from deerflow.sophia.deck_quality.snapshot import (
    ImmutableObjectUploader,
    PreRenderInputBundleDescriptor,
    SnapshotCompletionMetadata,
    SnapshotConflictError,
    SnapshotCoverageError,
    SnapshotMissingEvidenceError,
    SnapshotStaleError,
    SnapshotUploadError,
    freeze_and_upload_pre_render_input_bundle,
)
from deerflow.sophia.storage.async_supabase_object_store import (
    AsyncSupabaseImmutableObjectStore,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    ArtifactObjectSizeError,
)

logger = logging.getLogger(__name__)

_MAX_SOURCE_PACK_BYTES = 8 * 1024 * 1024
_MAX_ACCEPTED_PPTX_BYTES = 32 * 1024 * 1024
_MAX_NATIVE_JSON_BYTES = 2 * 1024 * 1024
_CLAIM_LIMIT_MAX = 2
_LEASE_SECONDS_MAX = 120
_READ_TIMEOUT_SECONDS = 15.0
_MATERIALIZE_TIMEOUT_SECONDS = 75.0
_PROCESS_TIMEOUT_SECONDS = 115.0
_MAX_PRODUCER_BUNDLE_BYTES = 64 * 1024
_PRODUCER_INBOX_PAGE_SIZE = 32
_PRODUCER_LIST_TIMEOUT_SECONDS = 5.0
_PRODUCER_RECONCILE_TIMEOUT_SECONDS = 15.0
_WORKER_RPC_TIMEOUT_SECONDS = 20.0
_WORKER_STOP_TIMEOUT_SECONDS = 5.0
_PRODUCER_REJECTION_PREFIX = "dq1/producer-rejections/v1"
_WORKER_ATTR = "_deck_quality_publication_worker"
_SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class DeckQualityPublicationWorkerStore(Protocol):
    async def probe(self) -> None: ...

    async def claim(
        self,
        *,
        lease_owner: str,
        claim_token: str,
        lease_seconds: int = 60,
        limit: int = 1,
    ) -> tuple[PublicationRecord, ...]: ...

    async def retry(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        error_code: PublicationErrorCode,
        error_stage: str,
        delay_seconds: int = 15,
    ) -> PublicationRecord: ...

    async def fail(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        error_code: PublicationErrorCode,
        error_stage: str,
    ) -> PublicationRecord: ...

    async def promote(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        input_manifest_object_path: str,
        input_manifest_hash: str,
    ) -> PublicationRecord: ...

    async def get(self, quality_run_id: str) -> PublicationRecord | None: ...

    async def request_ready(
        self,
        request: PublicationRequest,
        *,
        source_pack_object_path: str,
        source_pack_hash: str,
    ) -> PublicationRecord: ...

    async def aclose(self) -> None: ...


class BoundedPublicationObjectStore(ImmutableObjectUploader, Protocol):
    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None: ...

    def list_flat_page(
        self,
        prefix: str,
        *,
        limit: int,
    ) -> list[str]: ...

    def delete_if_present(
        self,
        object_path: str,
    ) -> Literal["deleted", "missing"]: ...


class _PublicationWorkError(RuntimeError):
    def __init__(
        self,
        code: PublicationErrorCode,
        *,
        stage: str,
        retryable: bool,
    ) -> None:
        self.code = code
        self.stage = stage
        self.retryable = retryable
        super().__init__(f"{code.value}:{stage}")


class _PermanentProducerBundleError(RuntimeError):
    """A deterministic immutable-bundle rejection safe to index forever."""

    def __init__(self, reason: DeckQualityProducerQuarantineReason) -> None:
        self.reason = reason
        super().__init__(reason)


class _OversizedProducerInboxError(RuntimeError):
    """An inbox object exceeded the strict producer evidence read ceiling."""


class _PermanentProducerObjectConflict(RuntimeError):
    """Observed immutable bytes differ from the exact producer candidate."""

    def __init__(self, *, object_path: str, content: bytes) -> None:
        self.object_path = object_path
        self.content = content
        super().__init__("producer_object_conflict")


@dataclass(frozen=True)
class PublicationCycleResult:
    producer_seen: int = 0
    producer_reconciled: int = 0
    producer_quarantined: int = 0
    producer_failed: int = 0
    producer_failure_evidence: int = 0
    claimed: int = 0
    published: int = 0
    failed: int = 0
    retry_scheduled: int = 0
    ambiguous: int = 0


def _default_owner() -> str:
    host = re.sub(r"[^A-Za-z0-9_.:-]", "-", socket.gethostname())[:64] or "gateway"
    return f"dq1-publication:{host}:{os.getpid()}"


def _default_claim_token() -> str:
    return f"dq1-pub-claim:{uuid.uuid4().hex}"


def _operation_token(
    kind: Literal["retry", "fail", "promote"],
    record: PublicationRecord,
) -> str:
    digest = canonical_sha256(
        {
            "kind": kind,
            "quality_run_id": record.quality_run_id,
            "lease_owner": record.lease_owner,
            "lease_epoch": record.lease_epoch,
            "claim_token": record.claim_token,
        }
    )
    return f"dq1-pub-{kind}:{digest}"


def _instrument_matches_config(
    config: DeckQualityConfig,
    instrument: QualityInstrumentLock,
) -> bool:
    # ``config.judge_profile_version`` is the routed profile *name* retained by
    # the campaign configuration (for example ``deck-visual-judge-v2``), while
    # the immutable instrument records the resolved profile's internal version
    # (``v2``). ``compile_runtime_instrument`` binds and validates both against
    # the exact route/plan before constructing this worker, so comparing those
    # unlike fields here would reject the canonical production instrument.
    return all(
        (
            config.rubric_version == instrument.rubric_version,
            config.evidence_preprocessor_version == instrument.evidence_preprocessor_version,
            config.judge_invoker_version == instrument.judge_invoker_version,
        )
    )


def _strict_source_pack(content: bytes) -> DeckQualitySourcePack:
    def reject_constant(_value: str) -> None:
        raise ValueError

    try:
        payload = json.loads(
            content.decode("utf-8"),
            parse_constant=reject_constant,
        )
        if not isinstance(payload, dict):
            raise ValueError
        pack = DeckQualitySourcePack.model_validate(payload)
    except (UnicodeDecodeError, ValueError, ValidationError, json.JSONDecodeError):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="source_pack",
            retryable=False,
        ) from None
    if canonical_json_bytes(pack) != content:
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="source_pack",
            retryable=False,
        )
    return pack


def _assert_row_before_source_read(
    *,
    record: PublicationRecord,
    config: DeckQualityConfig,
    instrument: QualityInstrumentLock,
    instrument_hash: str,
) -> None:
    exact_instrument = record.instrument_identity_hash == instrument_hash and record.instrument_lock() == instrument
    exact_scope = record.campaign_id == "DQ-1" and record.scope_kind == "canary" and record.user_id in config.canary_user_ids
    if not exact_scope or not exact_instrument:
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="row_identity",
            retryable=False,
        )
    if record.source_pack_object_path is None or record.source_pack_hash is None:
        raise _PublicationWorkError(
            PublicationErrorCode.INPUTS_UNAVAILABLE,
            stage="source_identity",
            retryable=True,
        )
    expected_source_path = expected_publication_source_pack_path(
        user_id=record.user_id,
        thread_id=record.thread_id,
        build_id=record.build_id,
        quality_run_id=record.quality_run_id,
    )
    if record.source_pack_object_path != expected_source_path:
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="source_identity",
            retryable=False,
        )


def _assert_pack_before_artifact_read(
    *,
    record: PublicationRecord,
    pack: DeckQualitySourcePack,
    instrument: QualityInstrumentLock,
) -> None:
    exact_values = (
        (pack.campaign_id, record.campaign_id),
        (pack.quality_run_id, record.quality_run_id),
        (pack.instrument_identity_hash, record.instrument_identity_hash),
        (pack.instrument, instrument),
        (pack.user_id, record.user_id),
        (pack.thread_id, record.thread_id),
        (pack.task_id, record.task_id),
        (pack.build_id, record.build_id),
        (pack.builder_run_id, record.builder_run_id),
        (pack.parent_builder_trace_id, record.parent_builder_trace_id),
        (pack.logical_artifact_id, record.logical_artifact_id),
        (pack.artifact_version_id, record.artifact_version_id),
        (pack.manifest_revision, record.manifest_revision),
        (pack.artifact_storage_object_path, record.artifact_object_path),
        (pack.artifact_sha256, record.artifact_hash),
    )
    if any(actual != expected for actual, expected in exact_values):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="source_identity",
            retryable=False,
        )


def _verify_source_pack_bytes(
    record: PublicationRecord,
    content: bytes,
) -> DeckQualitySourcePack:
    if record.source_pack_hash is None or not hmac.compare_digest(
        hashlib.sha256(content).hexdigest(),
        record.source_pack_hash,
    ):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="source_hash",
            retryable=False,
        )
    return _strict_source_pack(content)


def _verify_artifact_bytes(record: PublicationRecord, content: bytes) -> None:
    if not content or not hmac.compare_digest(
        hashlib.sha256(content).hexdigest(),
        record.artifact_hash,
    ):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
            stage="artifact_verify",
            retryable=False,
        )


def _source_pack_matches_outbox(
    *,
    pack: DeckQualitySourcePack,
    manifest: DeckQualityProducerOutboxManifest,
    instrument: QualityInstrumentLock,
    instrument_hash: str,
) -> bool:
    return all(
        (
            pack.campaign_id == manifest.campaign_id == "DQ-1",
            pack.quality_run_id == manifest.quality_run_id,
            pack.instrument == instrument,
            pack.instrument_identity_hash == manifest.instrument_identity_hash == instrument_hash,
            pack.user_id == manifest.user_id,
            pack.thread_id == manifest.thread_id,
            pack.task_id == manifest.task_id,
            pack.build_id == manifest.build_id,
            pack.builder_run_id == manifest.builder_run_id,
            pack.parent_builder_trace_id == manifest.parent_builder_trace_id,
            pack.logical_artifact_id == manifest.logical_artifact_id,
            pack.artifact_version_id == manifest.artifact_version_id,
            pack.manifest_revision == manifest.manifest_revision,
            pack.artifact_virtual_path == manifest.artifact_virtual_path,
            pack.accepted_delivery_object_path == manifest.artifact_object_path,
            pack.immutable_snapshot_object_path == manifest.artifact_object_path,
            pack.artifact_sha256 == manifest.artifact_sha256,
        )
    )


def _publication_request_from_source_pack(
    pack: DeckQualitySourcePack,
    *,
    requested_at: datetime,
) -> PublicationRequest:
    """Project one producer bundle into the RPC-only publication row."""

    deadline_at = requested_at + timedelta(seconds=170)
    return PublicationRequest(
        campaign_id=pack.campaign_id,
        instrument=pack.instrument,
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        task_id=pack.task_id,
        build_id=pack.build_id,
        builder_run_id=pack.builder_run_id,
        parent_builder_trace_id=pack.parent_builder_trace_id,
        logical_artifact_id=pack.logical_artifact_id,
        artifact_version_id=pack.artifact_version_id,
        manifest_revision=pack.manifest_revision,
        artifact_object_path=pack.immutable_snapshot_object_path,
        artifact_hash=pack.artifact_sha256,
        deadline_at=deadline_at,
        quality_run_deadline_at=deadline_at + timedelta(minutes=12),
    )


def _create_and_verify_producer_objects(
    *,
    pack: DeckQualitySourcePack,
    source_pack_bytes: bytes,
    object_store: BoundedPublicationObjectStore,
) -> tuple[str, str]:
    """Materialize the small source pack beside an immutable artifact."""

    source_path = expected_publication_source_pack_path(
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        build_id=pack.build_id,
        quality_run_id=pack.quality_run_id,
    )
    source_hash = hashlib.sha256(source_pack_bytes).hexdigest()
    objects = (
        (
            source_path,
            source_pack_bytes,
            "application/json",
            _MAX_SOURCE_PACK_BYTES,
            source_hash,
        ),
    )
    for object_path, content, content_type, max_bytes, expected_hash in objects:
        try:
            outcome = object_store.create_if_absent(
                object_path,
                content,
                content_type=content_type,
            )
        except Exception:
            # A create-only write can commit while its response is lost. The
            # exact byte/hash read below is the ambiguity fence; a true outage
            # still fails because no matching object can be observed.
            outcome = "ambiguous"
        stored = object_store.read_bounded(object_path, max_bytes=max_bytes)
        if (
            outcome not in {"created", "exists", "ambiguous"}
            or stored is None
            or len(stored) != len(content)
            or not hmac.compare_digest(
                hashlib.sha256(stored).hexdigest(),
                expected_hash,
            )
        ):
            raise RuntimeError("producer materialization conflict")
    return source_path, source_hash


def _assert_reconciled_producer_record(
    *,
    record: PublicationRecord,
    pack: DeckQualitySourcePack,
    source_path: str,
    source_hash: str,
    config: DeckQualityConfig,
    instrument: QualityInstrumentLock,
    instrument_hash: str,
) -> None:
    _assert_row_before_source_read(
        record=record,
        config=config,
        instrument=instrument,
        instrument_hash=instrument_hash,
    )
    _assert_pack_before_artifact_read(
        record=record,
        pack=pack,
        instrument=instrument,
    )
    if (
        record.source_pack_object_path != source_path
        or record.source_pack_hash != source_hash
        or record.artifact_object_path != pack.immutable_snapshot_object_path
        or record.artifact_hash != pack.artifact_sha256
        or record.state is PublicationState.AWAITING_INPUTS
    ):
        raise RuntimeError("producer publication reconciliation mismatch")


def _bounded_native_bytes(value: Mapping[str, Any], *, role: str) -> bytes:
    try:
        content = canonical_json_bytes(dict(value))
    except (TypeError, ValueError):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="source_pack",
            retryable=False,
        ) from None
    if not content or len(content) > _MAX_NATIVE_JSON_BYTES:
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
            stage=f"{role}_size",
            retryable=False,
        )
    return content


@dataclass(frozen=True)
class _PendingImmutableObject:
    object_path: str
    content: bytes
    content_type: str


class _CollectingImmutableObjectStore:
    """Capture deterministic snapshot uploads without performing network I/O."""

    def __init__(self) -> None:
        self._objects: dict[str, _PendingImmutableObject] = {}

    def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> Literal["created", "exists"]:
        existing = self._objects.get(object_path)
        if existing is not None:
            if existing.content != content:
                raise RuntimeError("local snapshot object conflict")
            return "exists"
        self._objects[object_path] = _PendingImmutableObject(
            object_path=object_path,
            content=content,
            content_type=content_type,
        )
        return "created"

    def read(self, object_path: str) -> bytes | None:
        existing = self._objects.get(object_path)
        return existing.content if existing is not None else None

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        content = self.read(object_path)
        if content is not None and len(content) > max_bytes:
            raise ArtifactObjectSizeError("captured object exceeds budget")
        return content

    def pending(self) -> tuple[_PendingImmutableObject, ...]:
        return tuple(self._objects.values())


def _materialize_and_freeze(
    *,
    record: PublicationRecord,
    pack: DeckQualitySourcePack,
    artifact_bytes: bytes,
    materialization_root: Path,
) -> tuple[PreRenderInputBundleDescriptor, tuple[_PendingImmutableObject, ...]]:
    creative_bytes = _bounded_native_bytes(pack.creative_plan, role="creative")
    design_bytes = _bounded_native_bytes(pack.design_plan, role="design")
    build_bytes = _bounded_native_bytes(pack.build_record, role="build")
    _bounded_native_bytes(pack.mechanical_record, role="mechanical")
    if len(canonical_json_bytes(pack.blind_brief)) > _MAX_NATIVE_JSON_BYTES:
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
            stage="brief_size",
            retryable=False,
        )

    materialization_root.mkdir(parents=True, exist_ok=True)
    captured_store = _CollectingImmutableObjectStore()
    try:
        with tempfile.TemporaryDirectory(
            prefix=f"{record.quality_run_id[:20]}-publication-",
            dir=materialization_root,
        ) as directory:
            outputs_root = Path(directory) / "outputs"
            relative_artifact = pack.artifact_virtual_path.removeprefix("/mnt/user-data/outputs/")
            pure_relative = PurePosixPath(relative_artifact)
            if not relative_artifact or ".." in pure_relative.parts or pure_relative.suffix.casefold() != ".pptx":
                raise _PublicationWorkError(
                    PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
                    stage="artifact_path",
                    retryable=False,
                )
            artifact_host_path = outputs_root.joinpath(*pure_relative.parts)
            deck_build = outputs_root / "deck_build"
            artifact_host_path.parent.mkdir(parents=True, exist_ok=True)
            deck_build.mkdir(parents=True, exist_ok=True)
            artifact_host_path.write_bytes(artifact_bytes)
            (deck_build / "creative_plan.json").write_bytes(creative_bytes)
            (deck_build / "design_plan.json").write_bytes(design_bytes)
            (deck_build / "build.json").write_bytes(build_bytes)

            metadata = SnapshotCompletionMetadata(
                quality_run_id=record.quality_run_id,
                build_id=record.build_id,
                user_id=record.user_id,
                thread_id=record.thread_id,
                task_id=record.task_id or "missing-task",
                builder_run_id=record.builder_run_id or "missing-builder-run",
                parent_builder_trace_id=(record.parent_builder_trace_id or "missing-builder-trace"),
                logical_artifact_id=record.logical_artifact_id,
                artifact_version_id=record.artifact_version_id,
                manifest_revision=record.manifest_revision,
                artifact_storage_object_path=record.artifact_object_path,
            )
            descriptor = freeze_and_upload_pre_render_input_bundle(
                metadata=metadata,
                outputs_root=outputs_root,
                artifact_virtual_path=pack.artifact_virtual_path,
                artifact_host_path=artifact_host_path,
                task_brief=pack.blind_brief,
                authoritative_mechanical=pack.mechanical_record,
                uploader=captured_store,
            )
    except _PublicationWorkError:
        raise
    except (SnapshotConflictError, SnapshotStaleError):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="input_snapshot",
            retryable=False,
        ) from None
    except (SnapshotCoverageError, SnapshotMissingEvidenceError, ValueError):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
            stage="input_snapshot",
            retryable=False,
        ) from None
    except SnapshotUploadError:
        raise _PublicationWorkError(
            PublicationErrorCode.PERSISTENCE_ERROR,
            stage="input_upload",
            retryable=True,
        ) from None
    except OSError:
        raise _PublicationWorkError(
            PublicationErrorCode.PERSISTENCE_ERROR,
            stage="materialize",
            retryable=True,
        ) from None

    if (
        descriptor.schema_version != "deck-quality-pre-render-input-descriptor/v2"
        or descriptor.revision != 2
        or descriptor.bundle_id != record.quality_run_id
        or descriptor.manifest_path != record.expected_input_manifest_object_path
        or descriptor.counts.content_object_count != 6
        or descriptor.counts.total_object_count != 7
    ):
        raise _PublicationWorkError(
            PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="input_manifest",
            retryable=False,
        )
    return descriptor, captured_store.pending()


class DeckQualityPublicationWorker:
    """Claim, verify, materialize, and promote at most two DQ-1 rows."""

    def __init__(
        self,
        *,
        config: DeckQualityConfig,
        instrument: QualityInstrumentLock,
        store: DeckQualityPublicationWorkerStore,
        object_store: BoundedPublicationObjectStore | AsyncSupabaseImmutableObjectStore,
        lease_owner: str | None = None,
        lease_seconds: int = _LEASE_SECONDS_MAX,
        claim_limit: int = _CLAIM_LIMIT_MAX,
        poll_seconds: float = 5.0,
        materialization_root: Path | None = None,
        claim_token_factory: Callable[[], str] = _default_claim_token,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not config.enabled or config.mode != "shadow" or config.scope != "canary" or not config.canary_user_ids:
            raise ValueError("deck quality publication worker requires enabled canary shadow configuration")
        if not _instrument_matches_config(config, instrument):
            raise ValueError("deck quality publication worker instrument does not match configuration")
        if not 15 <= lease_seconds <= _LEASE_SECONDS_MAX:
            raise ValueError("publication worker lease must be between 15 and 120 seconds")
        if not 1 <= claim_limit <= _CLAIM_LIMIT_MAX:
            raise ValueError("publication worker claim limit must be one or two")
        if poll_seconds <= 0:
            raise ValueError("publication worker polling interval must be positive")
        self._config = config
        self._instrument = instrument
        self._instrument_hash = canonical_sha256(instrument)
        self._store = store
        self._object_store = object_store
        self._lease_owner = lease_owner or _default_owner()
        self._lease_seconds = lease_seconds
        self._claim_limit = claim_limit
        self._poll_seconds = poll_seconds
        self._materialization_root = materialization_root or (Path(tempfile.gettempdir()) / "deerflow-dq1-publication")
        self._claim_token_factory = claim_token_factory
        self._clock = clock
        self._last_claim_token: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._started_at: datetime | None = None
        self._last_cycle_success_at: datetime | None = None
        self._last_cycle_error_at: datetime | None = None
        self._last_cycle_error_type: str | None = None
        self._consecutive_cycle_errors = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def readiness(self) -> dict[str, str]:
        """Return content-free live worker health, not a startup snapshot."""

        now = self._clock()
        if not self.running:
            return {"status": "degraded", "reason": "worker_not_running"}
        stale_after_seconds = max(30.0, self._poll_seconds * 4)
        if self._last_cycle_success_at is None:
            if self._last_cycle_error_type is not None:
                return {
                    "status": "degraded",
                    "reason": "cycle_failed",
                    "error_type": self._last_cycle_error_type,
                }
            if self._started_at is not None and (now - self._started_at).total_seconds() > stale_after_seconds:
                return {"status": "degraded", "reason": "heartbeat_stale"}
            return {"status": "starting", "reason": "awaiting_first_cycle"}
        heartbeat_age = (now - self._last_cycle_success_at).total_seconds()
        if self._consecutive_cycle_errors > 0:
            return {
                "status": "degraded",
                "reason": "cycle_failed",
                "error_type": self._last_cycle_error_type or "RuntimeError",
            }
        if heartbeat_age > stale_after_seconds:
            return {"status": "degraded", "reason": "heartbeat_stale"}
        return {
            "status": "ready",
            "last_success_at": self._last_cycle_success_at.isoformat(),
        }

    async def probe(self) -> None:
        probe = getattr(self._store, "probe", None)
        if not callable(probe):
            raise RuntimeError("publication persistence store is not probeable")
        async with asyncio.timeout(_WORKER_RPC_TIMEOUT_SECONDS):
            await probe()
        await self._producer_paths()
        await self._failure_evidence_paths()

    async def _object_call(
        self,
        method_name: str,
        *args: object,
        **kwargs: object,
    ) -> object:
        method = getattr(self._object_store, method_name, None)
        if not callable(method):
            raise RuntimeError(f"publication object store cannot {method_name}")
        if inspect.iscoroutinefunction(method):
            return await method(*args, **kwargs)
        # Sync stores are accepted only as deterministic test doubles. The
        # configured production factory below always installs the native
        # cancellable async transport.
        result = await asyncio.to_thread(method, *args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    async def _flat_paths(self, prefix: str) -> tuple[str, ...]:
        list_flat_page = getattr(self._object_store, "list_flat_page", None)
        if not callable(list_flat_page):
            raise RuntimeError("publication object store is not flat-page-listable")
        async with asyncio.timeout(_PRODUCER_LIST_TIMEOUT_SECONDS):
            paths = await self._object_call(
                "list_flat_page",
                prefix,
                limit=_PRODUCER_INBOX_PAGE_SIZE,
            )
        if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
            raise RuntimeError("producer inbox listing returned an invalid shape")
        if len(paths) > _PRODUCER_INBOX_PAGE_SIZE:
            raise RuntimeError("producer evidence listing exceeded its page")
        return tuple(sorted(paths))

    async def _producer_paths(self) -> tuple[str, ...]:
        return await self._flat_paths(DECK_QUALITY_PRODUCER_PREFIX)

    async def _failure_evidence_paths(self) -> tuple[str, ...]:
        producer_failures = await self._flat_paths(DECK_QUALITY_PRODUCER_FAILURE_PREFIX)
        gateway_rejections = await self._flat_paths(_PRODUCER_REJECTION_PREFIX)
        return (*producer_failures, *gateway_rejections)

    async def _write_exact_producer_object(
        self,
        *,
        object_path: str,
        content: bytes,
        content_type: str = "application/octet-stream",
        max_bytes: int = _MAX_PRODUCER_BUNDLE_BYTES,
    ) -> None:
        if not isinstance(content, bytes) or len(content) > max_bytes:
            raise RuntimeError("producer object is oversized")
        try:
            outcome = await self._object_call(
                "create_if_absent",
                object_path,
                content,
                content_type=content_type,
            )
        except Exception:
            outcome = "ambiguous"
        stored = await self._object_call(
            "read_bounded",
            object_path,
            max_bytes=max_bytes,
        )
        if not isinstance(stored, bytes):
            raise RuntimeError("producer object persistence unavailable")
        if stored != content:
            raise _PermanentProducerObjectConflict(
                object_path=object_path,
                content=stored,
            )
        if outcome not in {"created", "exists", "ambiguous"}:
            raise RuntimeError("producer object persistence failed")

    async def _retire_inbox(self, object_path: str) -> None:
        try:
            outcome = await self._object_call(
                "delete_if_present",
                object_path,
            )
        except Exception:
            outcome = "ambiguous"
        remaining = await self._object_call(
            "read_bounded",
            object_path,
            max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        )
        if outcome not in {"deleted", "missing", "ambiguous"}:
            raise RuntimeError("producer inbox deletion failed")
        if remaining is not None:
            if not isinstance(remaining, bytes):
                raise RuntimeError("producer inbox deletion verification failed")
            # Archive and DB convergence make replay safe. A still-visible
            # exact inbox after an ambiguous delete is transient, not poison.
            raise RuntimeError("producer inbox deletion remains unacknowledged")

    async def _read_producer_inbox(self, object_path: str) -> bytes:
        try:
            content = await self._object_call(
                "read_bounded",
                object_path,
                max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
            )
        except ArtifactObjectSizeError:
            raise _OversizedProducerInboxError from None
        except Exception:
            raise RuntimeError("producer inbox read failed") from None
        if content is None or not isinstance(content, bytes):
            raise RuntimeError("producer inbox object is unavailable")
        return content

    async def _quarantine_and_retire(
        self,
        *,
        object_path: str,
        content: bytes,
        reason: DeckQualityProducerQuarantineReason,
    ) -> None:
        quarantine_path = deck_quality_producer_quarantine_path(
            object_path,
            reason=reason,
            content_sha256=hashlib.sha256(content).hexdigest(),
        )
        await self._write_exact_producer_object(
            object_path=quarantine_path,
            content=content,
        )
        await self._write_rejection_evidence(
            inbox_path=object_path,
            reason=reason,
            observed_content=content,
        )
        await self._retire_inbox(object_path)

    async def _write_rejection_evidence(
        self,
        *,
        inbox_path: str,
        reason: str,
        observed_content: bytes | None = None,
        conflicting_path: str | None = None,
        conflicting_content: bytes | None = None,
    ) -> None:
        evidence = {
            "schema_version": "deck-quality-producer-rejection-evidence/v1",
            "reason": reason,
            "inbox_path_sha256": hashlib.sha256(inbox_path.encode("utf-8")).hexdigest(),
            "observed_content_sha256": (
                hashlib.sha256(observed_content).hexdigest()
                if observed_content is not None
                else None
            ),
            "observed_size_bytes": (
                len(observed_content) if observed_content is not None else None
            ),
            "conflicting_path_sha256": (
                hashlib.sha256(conflicting_path.encode("utf-8")).hexdigest()
                if conflicting_path is not None
                else None
            ),
            "conflicting_content_sha256": (
                hashlib.sha256(conflicting_content).hexdigest()
                if conflicting_content is not None
                else None
            ),
            "conflicting_size_bytes": (
                len(conflicting_content) if conflicting_content is not None else None
            ),
        }
        content = canonical_json_bytes(evidence)
        digest = hashlib.sha256(content).hexdigest()
        await self._write_exact_producer_object(
            object_path=f"{_PRODUCER_REJECTION_PREFIX}/{digest}.json",
            content=content,
            content_type="application/json",
            max_bytes=2 * 1024,
        )

    async def _quarantine_oversized_and_retire(self, object_path: str) -> None:
        manifest_path = deck_quality_producer_oversize_quarantine_path(object_path)
        manifest = canonical_json_bytes(
            {
                "schema_version": "deck-quality-producer-oversize-quarantine/v1",
                "reason": "producer_bundle_read_limit_exceeded",
                "inbox_path_sha256": hashlib.sha256(object_path.encode("utf-8")).hexdigest(),
                "read_limit_bytes": _MAX_PRODUCER_BUNDLE_BYTES,
            }
        )
        await self._write_exact_producer_object(
            object_path=manifest_path,
            content=manifest,
            content_type="application/json",
            max_bytes=2 * 1024,
        )
        await self._write_rejection_evidence(
            inbox_path=object_path,
            reason="producer_bundle_read_limit_exceeded",
        )
        await self._retire_inbox(object_path)

    async def _quarantine_conflict_and_retire(
        self,
        *,
        inbox_path: str,
        inbox_content: bytes,
        conflict: _PermanentProducerObjectConflict,
    ) -> None:
        # Preserve the small, content-free inbox marker itself, but never copy
        # a conflicting source pack or PPTX into quarantine. A mismatch can be
        # tens of megabytes and must not become a queue-poisoning upload. The
        # durable conflict evidence below records only hashes, path hashes, and
        # byte counts.
        inbox_digest = hashlib.sha256(inbox_content).hexdigest()
        quarantine_path = deck_quality_producer_quarantine_path(
            inbox_path,
            reason="storage_conflict",
            content_sha256=inbox_digest,
        )
        await self._write_exact_producer_object(
            object_path=quarantine_path,
            content=inbox_content,
        )
        await self._write_rejection_evidence(
            inbox_path=inbox_path,
            reason="storage_conflict",
            observed_content=inbox_content,
            conflicting_path=conflict.object_path,
            conflicting_content=conflict.content,
        )
        await self._retire_inbox(inbox_path)

    async def _reconcile_producer_bundle(
        self,
        *,
        object_path: str,
        quality_run_id: str,
        content: bytes,
    ) -> PublicationRecord:
        try:
            decoded = decode_deck_quality_producer_bundle(
                content,
                expected_quality_run_id=quality_run_id,
                expected_object_path=object_path,
            )
        except Exception:
            raise _PermanentProducerBundleError("bundle_invalid") from None
        manifest = decoded.manifest
        if manifest.campaign_id != "DQ-1" or manifest.user_id not in self._config.canary_user_ids or manifest.instrument_identity_hash != self._instrument_hash or manifest.quality_run_id != quality_run_id:
            raise _PermanentProducerBundleError("scope_invalid")

        # Replays check the immutable archive before following either private
        # reference.  A different byte sequence at the same run identity is a
        # permanent collision; an exact archive remains safe to converge after
        # a prior DB or inbox-delete response was lost.
        archive_path = deck_quality_producer_archive_path(quality_run_id)
        archived_content = await self._object_call(
            "read_bounded",
            archive_path,
            max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        )
        if archived_content is not None:
            if not isinstance(archived_content, bytes):
                raise RuntimeError("producer archive has an invalid shape")
            if not hmac.compare_digest(archived_content, content):
                raise _PermanentProducerObjectConflict(
                    object_path=archive_path,
                    content=archived_content,
                )

        source_content = await self._object_call(
            "read_bounded",
            manifest.source_pack_object_path,
            max_bytes=_MAX_SOURCE_PACK_BYTES,
        )
        if source_content is None:
            raise RuntimeError("producer source pack is unavailable")
        if not isinstance(source_content, bytes):
            raise RuntimeError("producer source pack has an invalid shape")
        if len(source_content) != manifest.source_pack_size_bytes or not hmac.compare_digest(
            hashlib.sha256(source_content).hexdigest(),
            manifest.source_pack_sha256,
        ):
            raise _PermanentProducerObjectConflict(
                object_path=manifest.source_pack_object_path,
                content=source_content,
            )
        try:
            pack = _strict_source_pack(source_content)
        except _PublicationWorkError:
            raise _PermanentProducerObjectConflict(
                object_path=manifest.source_pack_object_path,
                content=source_content,
            ) from None
        if not _source_pack_matches_outbox(
            pack=pack,
            manifest=manifest,
            instrument=self._instrument,
            instrument_hash=self._instrument_hash,
        ):
            raise _PermanentProducerObjectConflict(
                object_path=manifest.source_pack_object_path,
                content=source_content,
            )

        artifact_content = await self._object_call(
            "read_bounded",
            manifest.artifact_object_path,
            max_bytes=_MAX_ACCEPTED_PPTX_BYTES,
        )
        if artifact_content is None:
            raise RuntimeError("producer artifact is unavailable")
        if not isinstance(artifact_content, bytes):
            raise RuntimeError("producer artifact has an invalid shape")
        if not hmac.compare_digest(
            hashlib.sha256(artifact_content).hexdigest(),
            manifest.artifact_sha256,
        ):
            raise _PermanentProducerObjectConflict(
                object_path=manifest.artifact_object_path,
                content=artifact_content,
            )
        source_path = manifest.source_pack_object_path
        source_hash = manifest.source_pack_sha256
        request = _publication_request_from_source_pack(
            pack,
            requested_at=self._clock(),
        )
        try:
            record = await self._store.request_ready(
                request,
                source_pack_object_path=source_path,
                source_pack_hash=source_hash,
            )
        except Exception:
            # The transaction may commit while the response is lost. Replaying
            # the exact request is the first ambiguity recovery. If that also
            # fails, read the row: an exact committed row converges, a
            # mismatched row is permanent poison, and no observable row stays
            # retryable without retiring the inbox.
            try:
                record = await self._store.request_ready(
                    request,
                    source_pack_object_path=source_path,
                    source_pack_hash=source_hash,
                )
            except Exception:
                try:
                    record = await self._store.get(quality_run_id)
                except Exception:
                    raise RuntimeError("producer request-ready is ambiguous") from None
                if record is None:
                    raise RuntimeError("producer request-ready is uncommitted")
        try:
            _assert_reconciled_producer_record(
                record=record,
                pack=pack,
                source_path=source_path,
                source_hash=source_hash,
                config=self._config,
                instrument=self._instrument,
                instrument_hash=self._instrument_hash,
            )
        except (RuntimeError, _PublicationWorkError):
            raise _PermanentProducerBundleError("identity_conflict") from None

        if archived_content is None:
            await self._write_exact_producer_object(
                object_path=archive_path,
                content=content,
            )
        archived = decode_deck_quality_producer_bundle(
            content,
            expected_quality_run_id=quality_run_id,
            expected_object_path=archive_path,
        )
        if archived.manifest != manifest:
            raise _PermanentProducerBundleError("identity_conflict")
        await self._retire_inbox(object_path)
        return record

    async def _reconcile_producers(self) -> tuple[int, int, int, int]:
        paths = await self._producer_paths()
        reconciled = 0
        quarantined = 0
        failed = 0
        for object_path in paths:
            try:
                async with asyncio.timeout(_PRODUCER_RECONCILE_TIMEOUT_SECONDS):
                    content = await self._read_producer_inbox(object_path)
                    quality_run_id = parse_deck_quality_producer_bundle_path(object_path)
                    if quality_run_id is None:
                        raise _PermanentProducerBundleError("path_invalid")
                    await self._reconcile_producer_bundle(
                        object_path=object_path,
                        quality_run_id=quality_run_id,
                        content=content,
                    )
                reconciled += 1
                logger.info(
                    "DQ1 producer reconciled quality_run_id=%s contentExcluded=true",
                    quality_run_id,
                )
            except _OversizedProducerInboxError:
                try:
                    async with asyncio.timeout(_PRODUCER_RECONCILE_TIMEOUT_SECONDS):
                        await self._quarantine_oversized_and_retire(object_path)
                except Exception as quarantine_exc:
                    failed += 1
                    logger.error(
                        "DQ1 oversized producer quarantine failed error_type=%s contentExcluded=true",
                        quarantine_exc.__class__.__name__,
                        exc_info=False,
                    )
                else:
                    quarantined += 1
                    logger.error(
                        "DQ1 oversized producer permanently quarantined contentExcluded=true",
                        exc_info=False,
                    )
            except _PermanentProducerObjectConflict as exc:
                try:
                    async with asyncio.timeout(_PRODUCER_RECONCILE_TIMEOUT_SECONDS):
                        await self._quarantine_conflict_and_retire(
                            inbox_path=object_path,
                            inbox_content=content,
                            conflict=exc,
                        )
                except Exception as quarantine_exc:
                    failed += 1
                    logger.error(
                        "DQ1 producer conflict quarantine failed error_type=%s contentExcluded=true",
                        quarantine_exc.__class__.__name__,
                        exc_info=False,
                    )
                else:
                    quarantined += 1
                    logger.error(
                        "DQ1 producer immutable conflict quarantined contentExcluded=true",
                        exc_info=False,
                    )
            except _PermanentProducerBundleError as exc:
                try:
                    async with asyncio.timeout(_PRODUCER_RECONCILE_TIMEOUT_SECONDS):
                        await self._quarantine_and_retire(
                            object_path=object_path,
                            content=content,
                            reason=exc.reason,
                        )
                except Exception as quarantine_exc:
                    logger.error(
                        "DQ1 producer quarantine failed error_type=%s contentExcluded=true",
                        quarantine_exc.__class__.__name__,
                        exc_info=False,
                    )
                    failed += 1
                else:
                    quarantined += 1
                logger.error(
                    "DQ1 producer permanently rejected reason=%s contentExcluded=true",
                    exc.reason,
                    exc_info=False,
                )
            except Exception as exc:
                failed += 1
                logger.error(
                    "DQ1 producer reconciliation failed error_type=%s contentExcluded=true",
                    exc.__class__.__name__,
                    exc_info=False,
                )
        return len(paths), reconciled, quarantined, failed

    def _next_claim_token(self) -> str:
        token = self._claim_token_factory()
        if not isinstance(token, str) or _SAFE_TOKEN_RE.fullmatch(token) is None or token == self._last_claim_token:
            raise RuntimeError("publication claim token is invalid or reused")
        self._last_claim_token = token
        return token

    async def _claim(self, claim_token: str) -> tuple[PublicationRecord, ...]:
        arguments = {
            "lease_owner": self._lease_owner,
            "claim_token": claim_token,
            "lease_seconds": self._lease_seconds,
            "limit": self._claim_limit,
        }
        async with asyncio.timeout(_WORKER_RPC_TIMEOUT_SECONDS):
            try:
                return await self._store.claim(**arguments)
            except Exception:
                # The claim can commit while its response is lost. One replay
                # with the same token/hash is safe and cannot increment it.
                return await self._store.claim(**arguments)

    async def _read_bounded(
        self,
        *,
        object_path: str,
        max_bytes: int,
        stage: str,
    ) -> bytes:
        try:
            content = await asyncio.wait_for(
                self._object_call(
                    "read_bounded",
                    object_path,
                    max_bytes=max_bytes,
                ),
                timeout=_READ_TIMEOUT_SECONDS,
            )
        except ArtifactObjectSizeError:
            raise _PublicationWorkError(
                PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
                stage=f"{stage}_size",
                retryable=False,
            ) from None
        except TimeoutError:
            raise _PublicationWorkError(
                PublicationErrorCode.PERSISTENCE_ERROR,
                stage=stage,
                retryable=True,
            ) from None
        except Exception:
            raise _PublicationWorkError(
                PublicationErrorCode.PERSISTENCE_ERROR,
                stage=stage,
                retryable=True,
            ) from None
        if content is None:
            raise _PublicationWorkError(
                PublicationErrorCode.INPUTS_UNAVAILABLE,
                stage=stage,
                retryable=True,
            )
        if not content or len(content) > max_bytes:
            raise _PublicationWorkError(
                PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
                stage=f"{stage}_size",
                retryable=False,
            )
        return content

    async def _freeze(
        self,
        *,
        record: PublicationRecord,
        pack: DeckQualitySourcePack,
        artifact_bytes: bytes,
    ) -> PreRenderInputBundleDescriptor:
        try:
            async with asyncio.timeout(_MATERIALIZE_TIMEOUT_SECONDS):
                descriptor, pending = await asyncio.to_thread(
                    _materialize_and_freeze,
                    record=record,
                    pack=pack,
                    artifact_bytes=artifact_bytes,
                    materialization_root=self._materialization_root,
                )
                for item in pending:
                    # The accepted object is the same immutable primary that
                    # `_process` just read and hash-verified. Re-uploading it
                    # would duplicate tens of megabytes after delivery.
                    if item.object_path == record.artifact_object_path and item.content == artifact_bytes:
                        continue
                    await self._write_exact_producer_object(
                        object_path=item.object_path,
                        content=item.content,
                        content_type=item.content_type,
                        max_bytes=max(1, len(item.content)),
                    )
                return descriptor
        except TimeoutError:
            raise _PublicationWorkError(
                PublicationErrorCode.PERSISTENCE_ERROR,
                stage="materialize",
                retryable=True,
            ) from None

    @staticmethod
    def _published_matches(
        record: PublicationRecord | None,
        descriptor: PreRenderInputBundleDescriptor,
    ) -> bool:
        return bool(
            record is not None
            and record.state is PublicationState.PUBLISHED
            and record.quality_run_id == descriptor.bundle_id
            and record.input_manifest_object_path == descriptor.manifest_path
            and record.input_manifest_hash == descriptor.manifest_hash
        )

    async def _promote(
        self,
        *,
        record: PublicationRecord,
        descriptor: PreRenderInputBundleDescriptor,
    ) -> Literal["published", "failed", "ambiguous"]:
        lease = PublicationLease.from_record(record)
        token = _operation_token("promote", record)
        arguments = {
            "operation_token": token,
            "input_manifest_object_path": descriptor.manifest_path,
            "input_manifest_hash": descriptor.manifest_hash,
        }
        for _attempt in range(2):
            try:
                promoted = await self._store.promote(lease, **arguments)
            except Exception:
                try:
                    current = await self._store.get(record.quality_run_id)
                except Exception:
                    current = None
                if self._published_matches(current, descriptor):
                    return "published"
                continue
            if self._published_matches(promoted, descriptor):
                return "published"
            if promoted.state is PublicationState.FAILED:
                return "failed"
            return "ambiguous"
        try:
            current = await self._store.get(record.quality_run_id)
        except Exception:
            current = None
        return "published" if self._published_matches(current, descriptor) else "ambiguous"

    async def _transition_error(
        self,
        record: PublicationRecord,
        error: _PublicationWorkError,
    ) -> Literal["failed", "retry_scheduled", "ambiguous"]:
        try:
            async with asyncio.timeout(_WORKER_RPC_TIMEOUT_SECONDS):
                lease = PublicationLease.from_record(record)
                if error.retryable:
                    delay = min(120, 5 * (2 ** max(0, record.attempt_count - 1)))
                    transitioned = await self._store.retry(
                        lease,
                        operation_token=_operation_token("retry", record),
                        error_code=error.code,
                        error_stage=error.stage,
                        delay_seconds=delay,
                    )
                    if transitioned.state is PublicationState.FAILED:
                        return "failed"
                    if transitioned.state is PublicationState.RETRY_WAIT:
                        return "retry_scheduled"
                    return "ambiguous"
                transitioned = await self._store.fail(
                    lease,
                    operation_token=_operation_token("fail", record),
                    error_code=error.code,
                    error_stage=error.stage,
                )
        except Exception:
            return "ambiguous"
        return "failed" if transitioned.state is PublicationState.FAILED else "ambiguous"

    async def _process(self, record: PublicationRecord) -> str:
        try:
            async with asyncio.timeout(_PROCESS_TIMEOUT_SECONDS):
                if self._clock() >= record.deadline_at:
                    raise _PublicationWorkError(
                        PublicationErrorCode.DEADLINE_EXCEEDED,
                        stage="deadline",
                        retryable=False,
                    )
                _assert_row_before_source_read(
                    record=record,
                    config=self._config,
                    instrument=self._instrument,
                    instrument_hash=self._instrument_hash,
                )
                assert record.source_pack_object_path is not None
                source_bytes = await self._read_bounded(
                    object_path=record.source_pack_object_path,
                    max_bytes=_MAX_SOURCE_PACK_BYTES,
                    stage="source_read",
                )
                pack = _verify_source_pack_bytes(record, source_bytes)
                _assert_pack_before_artifact_read(
                    record=record,
                    pack=pack,
                    instrument=self._instrument,
                )
                artifact_bytes = await self._read_bounded(
                    object_path=record.artifact_object_path,
                    max_bytes=_MAX_ACCEPTED_PPTX_BYTES,
                    stage="artifact_read",
                )
                _verify_artifact_bytes(record, artifact_bytes)
                descriptor = await self._freeze(
                    record=record,
                    pack=pack,
                    artifact_bytes=artifact_bytes,
                )
                return await self._promote(record=record, descriptor=descriptor)
        except _PublicationWorkError as error:
            return await self._transition_error(record, error)
        except TimeoutError:
            return await self._transition_error(
                record,
                _PublicationWorkError(
                    PublicationErrorCode.PERSISTENCE_ERROR,
                    stage="worker_timeout",
                    retryable=True,
                ),
            )
        except Exception:
            return await self._transition_error(
                record,
                _PublicationWorkError(
                    PublicationErrorCode.PERSISTENCE_ERROR,
                    stage="worker",
                    retryable=True,
                ),
            )

    async def run_once(self) -> PublicationCycleResult:
        (
            producer_seen,
            producer_reconciled,
            producer_quarantined,
            producer_failed,
        ) = await self._reconcile_producers()
        producer_failure_evidence = len(await self._failure_evidence_paths())
        claim_token = self._next_claim_token()
        records = await self._claim(claim_token)
        if len(records) > self._claim_limit or len(records) > _CLAIM_LIMIT_MAX:
            raise RuntimeError("publication claim exceeded its bounded batch")
        expected_claim_hash = canonical_sha256(
            {
                "lease_owner": self._lease_owner,
                "claim_token": claim_token,
                "lease_seconds": self._lease_seconds,
                "limit": self._claim_limit,
            }
        )
        if any(
            record.state is not PublicationState.RUNNING
            or record.lease_owner != self._lease_owner
            or record.claim_token != claim_token
            or record.claim_hash != expected_claim_hash
            or record.lease_expires_at is None
            or record.lease_expires_at > record.deadline_at
            for record in records
        ):
            raise RuntimeError("publication claim returned an invalid replay fence")
        outcomes = await asyncio.gather(*(self._process(record) for record in records))
        counts = {
            "producer_seen": producer_seen,
            "producer_reconciled": producer_reconciled,
            "producer_quarantined": producer_quarantined,
            "producer_failed": producer_failed,
            "producer_failure_evidence": producer_failure_evidence,
            "claimed": len(records),
            "published": 0,
            "failed": 0,
            "retry_scheduled": 0,
            "ambiguous": 0,
        }
        for record, outcome in zip(records, outcomes, strict=True):
            counts[outcome] += 1
            logger.info(
                "DQ1 publication outcome quality_run_id=%s outcome=%s lease_epoch=%d contentExcluded=true",
                record.quality_run_id,
                outcome,
                record.lease_epoch,
            )
        return PublicationCycleResult(**counts)

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                cycle = await self.run_once()
                if cycle.producer_failed:
                    raise RuntimeError("producer reconciliation failed")
                if cycle.producer_quarantined or cycle.producer_failure_evidence:
                    raise RuntimeError("producer failure evidence is unresolved")
                self._last_cycle_success_at = self._clock()
                self._last_cycle_error_at = None
                self._last_cycle_error_type = None
                self._consecutive_cycle_errors = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._last_cycle_error_at = self._clock()
                self._last_cycle_error_type = exc.__class__.__name__
                self._consecutive_cycle_errors += 1
                logger.error(
                    "DQ1 publication worker cycle failed contentExcluded=true",
                    exc_info=False,
                )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll_seconds)
            except TimeoutError:
                continue

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._started_at = self._clock()
        self._last_cycle_success_at = None
        self._last_cycle_error_at = None
        self._last_cycle_error_type = None
        self._consecutive_cycle_errors = 0
        self._task = asyncio.create_task(
            self._run(),
            name="dq1-deck-quality-publication-worker",
        )

    async def stop(self) -> None:
        self._stop.set()
        task = self._task
        if task is not None and not task.done():
            task.cancel()
            try:
                async with asyncio.timeout(_WORKER_STOP_TIMEOUT_SECONDS):
                    await task
            except asyncio.CancelledError:
                pass
            except TimeoutError:
                logger.error(
                    "DQ1 publication worker stop timed out contentExcluded=true",
                    exc_info=False,
                )
        self._task = None
        for resource in (self._object_store, self._store):
            close = getattr(resource, "aclose", None)
            if callable(close):
                try:
                    async with asyncio.timeout(_WORKER_STOP_TIMEOUT_SECONDS):
                        if inspect.iscoroutinefunction(close):
                            result = close()
                        else:
                            result = await asyncio.to_thread(close)
                        if inspect.isawaitable(result):
                            await result
                except Exception:
                    logger.error(
                        "DQ1 publication worker resource close failed contentExcluded=true",
                        exc_info=False,
                    )


def build_configured_deck_quality_publication_worker(
    *,
    config: DeckQualityConfig,
    instrument: QualityInstrumentLock,
    store: SupabaseDeckQualityPublicationStore | None = None,
    object_store: (BoundedPublicationObjectStore | AsyncSupabaseImmutableObjectStore | None) = None,
) -> DeckQualityPublicationWorker | None:
    if not config.enabled:
        return None
    configured_store = store or configured_deck_quality_publication_store()
    if configured_store is None:
        raise RuntimeError("enabled DQ1 publication worker requires durable persistence")
    return DeckQualityPublicationWorker(
        config=config,
        instrument=instrument,
        store=configured_store,
        object_store=object_store or AsyncSupabaseImmutableObjectStore(),
    )


def install_deck_quality_publication_worker(
    app: Any,
    worker: DeckQualityPublicationWorker | None,
) -> None:
    setattr(app.state, _WORKER_ATTR, worker)


def get_deck_quality_publication_worker_or_none(
    app: Any,
) -> DeckQualityPublicationWorker | None:
    value = getattr(app.state, _WORKER_ATTR, None)
    return value if isinstance(value, DeckQualityPublicationWorker) else None


def get_deck_quality_publication_worker(app: Any) -> DeckQualityPublicationWorker:
    worker = get_deck_quality_publication_worker_or_none(app)
    if worker is None:
        raise RuntimeError("deck quality publication worker is not installed")
    return worker


async def start_deck_quality_publication_worker(
    worker: DeckQualityPublicationWorker | None,
) -> None:
    if worker is None:
        return
    await worker.probe()
    worker.start()


async def stop_deck_quality_publication_worker(
    worker: DeckQualityPublicationWorker | None,
) -> None:
    if worker is not None:
        await worker.stop()
