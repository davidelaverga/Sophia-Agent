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
import json
import logging
import os
import re
import socket
import tempfile
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol

from pydantic import ValidationError

from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationErrorCode,
    PublicationLease,
    PublicationRecord,
    PublicationState,
    SupabaseDeckQualityPublicationStore,
    configured_deck_quality_publication_store,
    expected_publication_source_pack_path,
)
from deerflow.sophia.deck_quality.publisher import DeckQualitySourcePack
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
from deerflow.sophia.storage.supabase_artifact_store import (
    ArtifactObjectSizeError,
    SupabaseImmutableObjectStore,
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

    async def aclose(self) -> None: ...


class BoundedPublicationObjectStore(ImmutableObjectUploader, Protocol):
    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None: ...


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


@dataclass(frozen=True)
class PublicationCycleResult:
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
            config.evidence_preprocessor_version
            == instrument.evidence_preprocessor_version,
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
    exact_instrument = (
        record.instrument_identity_hash == instrument_hash
        and record.instrument_lock() == instrument
    )
    exact_scope = (
        record.campaign_id == "DQ-1"
        and record.scope_kind == "canary"
        and record.user_id in config.canary_user_ids
    )
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
        source_pack_hash=record.source_pack_hash,
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


def _materialize_and_freeze(
    *,
    record: PublicationRecord,
    pack: DeckQualitySourcePack,
    artifact_bytes: bytes,
    object_store: BoundedPublicationObjectStore,
    materialization_root: Path,
) -> PreRenderInputBundleDescriptor:
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
    try:
        with tempfile.TemporaryDirectory(
            prefix=f"{record.quality_run_id[:20]}-publication-",
            dir=materialization_root,
        ) as directory:
            outputs_root = Path(directory) / "outputs"
            relative_artifact = pack.artifact_virtual_path.removeprefix(
                "/mnt/user-data/outputs/"
            )
            pure_relative = PurePosixPath(relative_artifact)
            if (
                not relative_artifact
                or ".." in pure_relative.parts
                or pure_relative.suffix.casefold() != ".pptx"
            ):
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
                parent_builder_trace_id=(
                    record.parent_builder_trace_id or "missing-builder-trace"
                ),
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
                uploader=object_store,
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
    return descriptor


class DeckQualityPublicationWorker:
    """Claim, verify, materialize, and promote at most two DQ-1 rows."""

    def __init__(
        self,
        *,
        config: DeckQualityConfig,
        instrument: QualityInstrumentLock,
        store: DeckQualityPublicationWorkerStore,
        object_store: BoundedPublicationObjectStore,
        lease_owner: str | None = None,
        lease_seconds: int = _LEASE_SECONDS_MAX,
        claim_limit: int = _CLAIM_LIMIT_MAX,
        poll_seconds: float = 5.0,
        materialization_root: Path | None = None,
        claim_token_factory: Callable[[], str] = _default_claim_token,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if (
            not config.enabled
            or config.mode != "shadow"
            or config.scope != "canary"
            or not config.canary_user_ids
        ):
            raise ValueError(
                "deck quality publication worker requires enabled canary shadow configuration"
            )
        if not _instrument_matches_config(config, instrument):
            raise ValueError(
                "deck quality publication worker instrument does not match configuration"
            )
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
        self._materialization_root = materialization_root or (
            Path(tempfile.gettempdir()) / "deerflow-dq1-publication"
        )
        self._claim_token_factory = claim_token_factory
        self._clock = clock
        self._last_claim_token: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def probe(self) -> None:
        probe = getattr(self._store, "probe", None)
        if not callable(probe):
            raise RuntimeError("publication persistence store is not probeable")
        await probe()

    def _next_claim_token(self) -> str:
        token = self._claim_token_factory()
        if (
            not isinstance(token, str)
            or _SAFE_TOKEN_RE.fullmatch(token) is None
            or token == self._last_claim_token
        ):
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
        try:
            return await self._store.claim(**arguments)
        except Exception:
            # The claim can commit while its response is lost. One replay with
            # the same token/hash is safe and cannot increment the attempt.
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
                asyncio.to_thread(
                    self._object_store.read_bounded,
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
            return await asyncio.wait_for(
                asyncio.to_thread(
                    _materialize_and_freeze,
                    record=record,
                    pack=pack,
                    artifact_bytes=artifact_bytes,
                    object_store=self._object_store,
                    materialization_root=self._materialization_root,
                ),
                timeout=_MATERIALIZE_TIMEOUT_SECONDS,
            )
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
        lease = PublicationLease.from_record(record)
        if error.retryable:
            delay = min(120, 5 * (2 ** max(0, record.attempt_count - 1)))
            try:
                transitioned = await self._store.retry(
                    lease,
                    operation_token=_operation_token("retry", record),
                    error_code=error.code,
                    error_stage=error.stage,
                    delay_seconds=delay,
                )
            except Exception:
                return "ambiguous"
            if transitioned.state is PublicationState.FAILED:
                return "failed"
            if transitioned.state is PublicationState.RETRY_WAIT:
                return "retry_scheduled"
            return "ambiguous"
        try:
            transitioned = await self._store.fail(
                lease,
                operation_token=_operation_token("fail", record),
                error_code=error.code,
                error_stage=error.stage,
            )
        except Exception:
            return "ambiguous"
        return (
            "failed"
            if transitioned.state is PublicationState.FAILED
            else "ambiguous"
        )

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
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
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
        self._task = asyncio.create_task(
            self._run(),
            name="dq1-deck-quality-publication-worker",
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
        self._task = None
        close = getattr(self._store, "aclose", None)
        if callable(close):
            await close()


def build_configured_deck_quality_publication_worker(
    *,
    config: DeckQualityConfig,
    instrument: QualityInstrumentLock,
    store: SupabaseDeckQualityPublicationStore | None = None,
    object_store: SupabaseImmutableObjectStore | None = None,
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
        object_store=object_store or SupabaseImmutableObjectStore(),
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
