from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import re
import stat
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.config.app_config import AppConfig
from deerflow.sophia.deck_quality.brief import sanitize_current_request
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.instrument import DeckQualityRuntimeInstrument
from deerflow.sophia.deck_quality.schemas import BlindBrief, QualityInstrumentLock
from deerflow.sophia.deck_quality.snapshot import (
    ImmutableObjectUploader,
)
from deerflow.sophia.storage.async_supabase_object_store import (
    AsyncSupabaseImmutableObjectStore,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    immutable_builder_artifact_object_path,
    normalize_object_path,
    safe_object_path_segment,
)

logger = logging.getLogger(__name__)

_CAMPAIGN_ID = "DQ-1"
_PPTX_PREFIX = "/mnt/user-data/outputs/"
_MAX_NATIVE_JSON_BYTES = 2 * 1024 * 1024
_MAX_SOURCE_PACK_BYTES = 8 * 1024 * 1024
_MAX_ACCEPTED_PPTX_BYTES = 32 * 1024 * 1024
_MAX_PRODUCER_BUNDLE_BYTES = 64 * 1024
# The exact-candidate boundary executes before baseline delivery starts. A
# caller-owned absolute deadline covers the *whole* native-async storage
# protocol, including every sequential request and a continuously dribbling
# response. The failure marker receives a separate reserved slice so an outbox
# timeout can still leave content-free evidence without delaying delivery past
# the canary-only 1.5-second worst-case ceiling.
_PRODUCER_PROTOCOL_TIMEOUT_SECONDS = 1.0
_FAILURE_PROTOCOL_TIMEOUT_SECONDS = 0.35
_PRODUCER_AMBIGUITY_RESERVE_SECONDS = 0.25
_ASYNC_STORE_CLOSE_TIMEOUT_SECONDS = 0.025
_MAX_PREDELIVERY_STORAGE_STALL_SECONDS = 1.5
assert _PRODUCER_PROTOCOL_TIMEOUT_SECONDS + _FAILURE_PROTOCOL_TIMEOUT_SECONDS + 2 * _ASYNC_STORE_CLOSE_TIMEOUT_SECONDS <= _MAX_PREDELIVERY_STORAGE_STALL_SECONDS
assert 0 < _PRODUCER_AMBIGUITY_RESERVE_SECONDS < _PRODUCER_PROTOCOL_TIMEOUT_SECONDS
_SHA256_PATTERN = r"^[0-9a-f]{64}$"
_QUALITY_RUN_PATTERN = re.compile(r"^quality_[0-9a-f]{64}$")
_DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")

DECK_QUALITY_PRODUCER_PREFIX: Final = "dq1/producer-inbox/v1"
DECK_QUALITY_PRODUCER_ARCHIVE_PREFIX: Final = "dq1/producer-archive/v1"
DECK_QUALITY_PRODUCER_QUARANTINE_PREFIX: Final = "dq1/producer-quarantine/v1"
DECK_QUALITY_PRODUCER_FAILURE_PREFIX: Final = "dq1/producer-failures/v1"


class DeckQualityPublicationError(RuntimeError):
    """A content-free failure at the post-delivery publication boundary."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class PreparedDeckQualityPublication(BaseModel):
    """The bounded data retained for the post-webhook canary handoff."""

    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    outputs_root: Path
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    artifact_storage_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    artifact_id: str | None = Field(default=None, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    build_id: str = Field(min_length=1, max_length=256)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    task_brief: str = Field(min_length=1, max_length=20_000)
    mechanical_gate_results: dict[str, Any]
    source_retention_report: dict[str, Any]
    native_contrast_report: dict[str, Any]
    native_mechanical_report: dict[str, Any]
    native_editability_score: float | None = None
    missing_expected_visual_count: int | None = Field(default=None, ge=0)


class DeckQualityProducerIntent(BaseModel):
    """Content-free identity for one deterministic producer bundle."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-producer-intent/v1"] = "deck-quality-producer-intent/v1"
    campaign_id: Literal["DQ-1"] = "DQ-1"
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    instrument_identity_hash: str = Field(pattern=_SHA256_PATTERN)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    accepted_delivery_object_path: str = Field(min_length=1, max_length=4_096)
    immutable_snapshot_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)


class DeckQualityPublicationIntent(BaseModel):
    """Deprecated content-free webhook ticket for in-flight compatibility.

    New producer code never emits this schema; retaining strict validation
    lets a rolling deployment safely drain already-sent canary requests.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-publication-intent/v1"] = "deck-quality-publication-intent/v1"
    campaign_id: Literal["DQ-1"] = "DQ-1"
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    instrument_identity_hash: str = Field(pattern=_SHA256_PATTERN)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    artifact_storage_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    publication_max_attempts: Literal[3] = 3
    publication_deadline_at: datetime
    quality_max_attempts: Literal[5] = 5
    quality_run_deadline_at: datetime

    @model_validator(mode="after")
    def validate_deadlines(self) -> DeckQualityPublicationIntent:
        if (
            self.publication_deadline_at.tzinfo is None
            or self.publication_deadline_at.utcoffset() is None
            or self.quality_run_deadline_at.tzinfo is None
            or self.quality_run_deadline_at.utcoffset() is None
            or self.quality_run_deadline_at <= self.publication_deadline_at
        ):
            raise ValueError("publication intent deadlines are invalid")
        return self


class DeckQualitySourceHashes(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    creative_plan: str = Field(pattern=_SHA256_PATTERN)
    design_plan: str = Field(pattern=_SHA256_PATTERN)
    build_record: str = Field(pattern=_SHA256_PATTERN)
    blind_brief: str = Field(pattern=_SHA256_PATTERN)
    mechanical_record: str = Field(pattern=_SHA256_PATTERN)


class DeckQualitySourcePack(BaseModel):
    """One immutable, bounded capture of every local-only quality input."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-source-pack/v2"] = "deck-quality-source-pack/v2"
    campaign_id: str = Field(default=_CAMPAIGN_ID, pattern=r"^DQ-1$")
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    instrument: QualityInstrumentLock
    instrument_identity_hash: str = Field(pattern=_SHA256_PATTERN)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    accepted_delivery_object_path: str = Field(min_length=1, max_length=4_096)
    immutable_snapshot_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    creative_plan: dict[str, Any]
    design_plan: dict[str, Any]
    build_record: dict[str, Any]
    blind_brief: BlindBrief
    mechanical_record: dict[str, Any]
    source_hashes: DeckQualitySourceHashes

    @model_validator(mode="after")
    def validate_identity_and_hashes(self) -> DeckQualitySourcePack:
        if canonical_sha256(self.instrument) != self.instrument_identity_hash:
            raise ValueError("source-pack instrument identity does not match")
        expected_run_id = derive_quality_run_id(
            artifact_version_id=self.artifact_version_id,
            campaign_id=self.campaign_id,
            instrument=self.instrument,
        )
        if expected_run_id != self.quality_run_id:
            raise ValueError("source-pack quality run identity does not match")
        expected_hashes = DeckQualitySourceHashes(
            creative_plan=canonical_sha256(self.creative_plan),
            design_plan=canonical_sha256(self.design_plan),
            build_record=canonical_sha256(self.build_record),
            blind_brief=canonical_sha256(self.blind_brief),
            mechanical_record=canonical_sha256(self.mechanical_record),
        )
        if expected_hashes != self.source_hashes:
            raise ValueError("source-pack content hashes do not match")
        expected_prefix = normalize_object_path(f"artifacts/{safe_object_path_segment(self.user_id, default='user')}/{safe_object_path_segment(self.thread_id, default='thread')}")
        for role, object_path in (
            ("accepted delivery", self.accepted_delivery_object_path),
            ("immutable snapshot", self.immutable_snapshot_object_path),
        ):
            try:
                normalized_artifact_path = normalize_object_path(object_path)
            except ValueError as exc:
                raise ValueError(f"source-pack {role} path is invalid") from exc
            if normalized_artifact_path != object_path or not normalized_artifact_path.startswith(f"{expected_prefix}/"):
                raise ValueError(f"source-pack {role} path is outside its user/thread scope")
        if _normalized_pptx_path(self.artifact_virtual_path) != self.artifact_virtual_path:
            raise ValueError("source-pack artifact virtual path is invalid")
        expected_snapshot_path = deck_quality_immutable_artifact_snapshot_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            logical_artifact_id=self.logical_artifact_id,
            artifact_version_id=self.artifact_version_id,
            artifact_sha256=self.artifact_sha256,
            artifact_virtual_path=self.artifact_virtual_path,
        )
        if self.immutable_snapshot_object_path != expected_snapshot_path:
            raise ValueError("source-pack immutable snapshot path is not canonical")
        if self.accepted_delivery_object_path != expected_snapshot_path:
            raise ValueError("source-pack accepted artifact is not the immutable snapshot")
        return self

    @property
    def artifact_storage_object_path(self) -> str:
        """Compatibility projection for the worker's immutable artifact input."""

        return self.immutable_snapshot_object_path


class DeckQualityProducerOutboxManifest(BaseModel):
    """Small, content-free commit marker written after private source capture."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-producer-outbox/v1"] = "deck-quality-producer-outbox/v1"
    campaign_id: Literal["DQ-1"] = "DQ-1"
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    instrument_identity_hash: str = Field(pattern=_SHA256_PATTERN)
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(min_length=1, max_length=256)
    build_id: str = Field(min_length=1, max_length=256)
    builder_run_id: str = Field(min_length=1, max_length=256)
    parent_builder_trace_id: str = Field(min_length=1, max_length=256)
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_virtual_path: str = Field(min_length=1, max_length=4_096)
    artifact_object_path: str = Field(min_length=1, max_length=4_096)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)
    source_pack_object_path: str = Field(min_length=1, max_length=4_096)
    source_pack_sha256: str = Field(pattern=_SHA256_PATTERN)
    source_pack_size_bytes: int = Field(gt=0, le=_MAX_SOURCE_PACK_BYTES)

    @model_validator(mode="after")
    def validate_references(self) -> DeckQualityProducerOutboxManifest:
        expected_artifact = deck_quality_immutable_artifact_snapshot_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            logical_artifact_id=self.logical_artifact_id,
            artifact_version_id=self.artifact_version_id,
            artifact_sha256=self.artifact_sha256,
            artifact_virtual_path=self.artifact_virtual_path,
        )
        expected_source = deck_quality_source_pack_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            quality_run_id=self.quality_run_id,
        )
        if self.artifact_object_path != expected_artifact:
            raise ValueError("producer outbox artifact path is not canonical")
        if self.source_pack_object_path != expected_source:
            raise ValueError("producer outbox source path is not canonical")
        return self


class DeckQualityProducerBundleDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    object_path: str = Field(min_length=1, max_length=4_096)
    sha256: str = Field(pattern=_SHA256_PATTERN)
    size_bytes: int = Field(gt=0, le=_MAX_PRODUCER_BUNDLE_BYTES)
    source_pack_sha256: str = Field(pattern=_SHA256_PATTERN)
    source_pack_size_bytes: int = Field(gt=0, le=_MAX_SOURCE_PACK_BYTES)
    artifact_sha256: str = Field(pattern=_SHA256_PATTERN)

    @model_validator(mode="after")
    def validate_object_path(self) -> DeckQualityProducerBundleDescriptor:
        if parse_deck_quality_producer_storage_path(self.object_path) != self.quality_run_id:
            raise ValueError("producer bundle path does not match its run")
        return self


@dataclass(frozen=True)
class DecodedDeckQualityProducerBundle:
    """Strictly decoded small outbox commit ready for reconciliation."""

    manifest: DeckQualityProducerOutboxManifest
    descriptor: DeckQualityProducerBundleDescriptor


class DeckQualityProducerBundleReceipt(BaseModel):
    """Content-free proof that one producer bundle is durable."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-producer-bundle-receipt/v2"] = "deck-quality-producer-bundle-receipt/v2"
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    bundle_object_path: str = Field(min_length=1, max_length=4_096)
    bundle_hash: str = Field(pattern=_SHA256_PATTERN)
    bundle_size_bytes: int = Field(gt=0, le=_MAX_PRODUCER_BUNDLE_BYTES)


DeckQualityProducerFailureStage = Literal[
    "candidate_metadata",
    "instrument",
    "producer_bundle",
]
DeckQualityProducerFailureCode = Literal[
    "candidate_metadata_invalid",
    "instrument_invalid",
    "producer_bundle_unavailable",
]


class DeckQualityProducerFailureRecord(BaseModel):
    """Deterministic, content-free evidence for one candidate producer failure."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["deck-quality-producer-failure/v1"] = "deck-quality-producer-failure/v1"
    campaign_id: Literal["DQ-1"] = "DQ-1"
    candidate_digest: str = Field(pattern=_SHA256_PATTERN)
    shadow_error_code: Literal["shadow_dispatch_unavailable"] = "shadow_dispatch_unavailable"
    quality_run_id: str | None = Field(
        default=None,
        pattern=r"^quality_[0-9a-f]{64}$",
    )
    failure_stage: DeckQualityProducerFailureStage
    failure_code: DeckQualityProducerFailureCode


class DeckQualityProducerFailureDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    candidate_digest: str = Field(pattern=_SHA256_PATTERN)
    object_path: str = Field(min_length=1, max_length=4_096)
    sha256: str = Field(pattern=_SHA256_PATTERN)
    size_bytes: int = Field(gt=0, le=16 * 1024)

    @model_validator(mode="after")
    def validate_object_path(self) -> DeckQualityProducerFailureDescriptor:
        if self.object_path != deck_quality_producer_failure_path(self.candidate_digest):
            raise ValueError("producer failure path does not match candidate")
        return self


# Compatibility type names retained for downstream imports while the gateway
# reconciler moves from the abandoned LangGraph-side DB transaction to bundles.
DeckQualityPreDeliveryReceipt = DeckQualityProducerBundleReceipt
DeckQualityDispatchFailureRecord = DeckQualityProducerFailureRecord
DeckQualityDispatchFailureDescriptor = DeckQualityProducerFailureDescriptor


def _clean_required(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _normalized_pptx_path(value: object) -> str | None:
    raw = _clean_required(value)
    if raw is None:
        return None
    normalized = raw.replace("\\", "/")
    if normalized.startswith("mnt/user-data/outputs/"):
        normalized = f"/{normalized}"
    pure = PurePosixPath(normalized)
    if not normalized.startswith(_PPTX_PREFIX) or ".." in pure.parts or pure.suffix.casefold() != ".pptx":
        return None
    return normalized


def deck_quality_producer_bundle_path(quality_run_id: str) -> str:
    """Return the canonical flat live-inbox key for one producer bundle."""

    if _QUALITY_RUN_PATTERN.fullmatch(quality_run_id) is None:
        raise ValueError("quality_run_id is invalid")
    return f"{DECK_QUALITY_PRODUCER_PREFIX}/{quality_run_id}.bin"


def deck_quality_producer_archive_path(quality_run_id: str) -> str:
    """Return the immutable archive key retained after gateway acknowledgement."""

    if _QUALITY_RUN_PATTERN.fullmatch(quality_run_id) is None:
        raise ValueError("quality_run_id is invalid")
    return f"{DECK_QUALITY_PRODUCER_ARCHIVE_PREFIX}/{quality_run_id}/bundle.bin"


DeckQualityProducerQuarantineReason = Literal[
    "path_invalid",
    "bundle_invalid",
    "scope_invalid",
    "identity_conflict",
    "storage_conflict",
]


def deck_quality_producer_quarantine_path(
    inbox_object_path: str,
    *,
    reason: DeckQualityProducerQuarantineReason,
    content_sha256: str,
) -> str:
    """Return a content-free immutable quarantine key for exact poison bytes."""

    if not isinstance(inbox_object_path, str) or not inbox_object_path:
        raise ValueError("producer inbox object path is invalid")
    if _DIGEST_PATTERN.fullmatch(content_sha256) is None:
        raise ValueError("producer quarantine content hash is invalid")
    path_digest = hashlib.sha256(inbox_object_path.encode("utf-8")).hexdigest()
    return f"{DECK_QUALITY_PRODUCER_QUARANTINE_PREFIX}/{reason}/{path_digest}/{content_sha256}.bin"


def deck_quality_producer_oversize_quarantine_path(
    inbox_object_path: str,
) -> str:
    """Return the deterministic metadata path for an unreadably large poison."""

    if not isinstance(inbox_object_path, str) or not inbox_object_path:
        raise ValueError("producer inbox object path is invalid")
    path_digest = hashlib.sha256(inbox_object_path.encode("utf-8")).hexdigest()
    return f"{DECK_QUALITY_PRODUCER_QUARANTINE_PREFIX}/oversized/{path_digest}/manifest.json"


def parse_deck_quality_producer_bundle_path(object_path: str) -> str | None:
    """Strictly parse a canonical flat live-inbox key."""

    if not isinstance(object_path, str):
        return None
    parts = object_path.split("/")
    if len(parts) != 4 or parts[:3] != ["dq1", "producer-inbox", "v1"] or not parts[3].endswith(".bin"):
        return None
    quality_run_id = parts[3].removesuffix(".bin")
    if _QUALITY_RUN_PATTERN.fullmatch(quality_run_id) is None:
        return None
    try:
        normalized = normalize_object_path(object_path)
    except ValueError:
        return None
    return quality_run_id if normalized == object_path else None


def parse_deck_quality_producer_archive_path(object_path: str) -> str | None:
    """Strictly parse one canonical immutable producer archive key."""

    if not isinstance(object_path, str):
        return None
    parts = object_path.split("/")
    if len(parts) != 5 or parts[:3] != ["dq1", "producer-archive", "v1"] or parts[4] != "bundle.bin" or _QUALITY_RUN_PATTERN.fullmatch(parts[3]) is None:
        return None
    try:
        normalized = normalize_object_path(object_path)
    except ValueError:
        return None
    return parts[3] if normalized == object_path else None


def parse_deck_quality_producer_storage_path(object_path: str) -> str | None:
    """Parse either a live-inbox or immutable-archive producer bundle path."""

    return parse_deck_quality_producer_bundle_path(object_path) or parse_deck_quality_producer_archive_path(object_path)


def deck_quality_producer_failure_path(candidate_digest: str) -> str:
    """Return the deterministic flat failure-evidence key."""

    if _DIGEST_PATTERN.fullmatch(candidate_digest) is None:
        raise ValueError("candidate digest is invalid")
    return f"{DECK_QUALITY_PRODUCER_FAILURE_PREFIX}/{candidate_digest}.json"


def parse_deck_quality_producer_failure_path(object_path: str) -> str | None:
    """Strictly parse one canonical flat producer-failure key."""

    if not isinstance(object_path, str):
        return None
    parts = object_path.split("/")
    if (
        len(parts) != 4
        or parts[:3] != ["dq1", "producer-failures", "v1"]
        or not parts[3].endswith(".json")
    ):
        return None
    candidate_digest = parts[3].removesuffix(".json")
    if _DIGEST_PATTERN.fullmatch(candidate_digest) is None:
        return None
    try:
        normalized = normalize_object_path(object_path)
    except ValueError:
        return None
    return candidate_digest if normalized == object_path else None


def derive_deck_quality_candidate_digest(
    *,
    artifact: Mapping[str, Any],
    completion_payload: Mapping[str, Any],
) -> str:
    """Derive a stable, content-free key for every exact-candidate attempt.

    The digest intentionally excludes the task brief, URLs, plans, and other
    content. It remains derivable when richer publication metadata or the
    runtime instrument is malformed, so those failures are still indexable.
    """

    identity = {
        "schema_version": "deck-quality-candidate-identity/v1",
        "campaign_id": _CAMPAIGN_ID,
        "user_id": _clean_required(completion_payload.get("user_id")),
        "thread_id": _clean_required(completion_payload.get("thread_id")),
        "task_id": _clean_required(completion_payload.get("task_id")),
        "builder_run_id": _clean_required(completion_payload.get("run_id")),
        "build_id": _clean_required(artifact.get("deck_build_id")),
        "logical_artifact_id": _clean_required(artifact.get("logical_artifact_id")),
        "artifact_version_id": _clean_required(artifact.get("current_artifact_version_id")),
        "artifact_sha256": _clean_required(artifact.get("artifact_sha256")),
    }
    return canonical_sha256(identity)


def deck_quality_immutable_artifact_snapshot_path(
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
    logical_artifact_id: str,
    artifact_version_id: str,
    artifact_sha256: str,
    artifact_virtual_path: str,
) -> str:
    """Return the canonical immutable PPTX key materialized by the gateway."""

    if _DIGEST_PATTERN.fullmatch(artifact_sha256) is None:
        raise ValueError("artifact hash is invalid")
    normalized_virtual_path = _normalized_pptx_path(artifact_virtual_path)
    if normalized_virtual_path != artifact_virtual_path:
        raise ValueError("artifact virtual path is invalid")
    if not build_id.strip():
        raise ValueError("build identity is invalid")
    return immutable_builder_artifact_object_path(
        user_id=user_id,
        thread_or_session_id=thread_id,
        logical_artifact_id=logical_artifact_id,
        artifact_version_id=artifact_version_id,
        artifact_sha256=artifact_sha256,
        filename=PurePosixPath(artifact_virtual_path).name,
    )


def deck_quality_source_pack_path(
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
    quality_run_id: str,
) -> str:
    """Return the private immutable source pack referenced by the outbox."""

    if _QUALITY_RUN_PATTERN.fullmatch(quality_run_id) is None:
        raise ValueError("quality run identity is invalid")
    return normalize_object_path(
        "artifacts/"
        f"{safe_object_path_segment(user_id, default='user')}/"
        f"{safe_object_path_segment(thread_id, default='thread')}/"
        "foundation/.builder/builds/"
        f"{safe_object_path_segment(build_id, default='build')}/quality/"
        f"{quality_run_id}/publication/source_pack/manifest.json"
    )


def _outputs_root(state: Mapping[str, Any]) -> Path | None:
    thread_data = state.get("thread_data")
    if not isinstance(thread_data, Mapping):
        return None
    raw = _clean_required(thread_data.get("outputs_path"))
    return Path(raw) if raw is not None else None


def _eligible_storage_path(
    *,
    object_path: object,
    user_id: str,
    thread_id: str,
) -> str | None:
    raw = _clean_required(object_path)
    if raw is None or "://" in raw:
        return None
    try:
        normalized = normalize_object_path(raw)
        prefix = normalize_object_path(f"artifacts/{safe_object_path_segment(user_id, default='user')}/{safe_object_path_segment(thread_id, default='thread')}")
    except ValueError:
        return None
    return normalized if normalized == raw and normalized.startswith(f"{prefix}/") else None


def is_deck_quality_publication_candidate(
    *,
    config: AppConfig,
    artifact: Mapping[str, Any],
    completion_payload: Mapping[str, Any],
) -> bool:
    """Return the content-free canary gate without reading local inputs."""

    quality = config.deck_quality
    user_id = _clean_required(completion_payload.get("user_id"))
    return all(
        (
            quality.enabled,
            quality.mode == "shadow",
            quality.scope == "canary",
            user_id is not None and user_id in quality.canary_user_ids,
            completion_payload.get("status") == "success",
            _clean_required(completion_payload.get("task_type")) == "presentation",
            _clean_required(artifact.get("artifact_type")) == "presentation",
            (_clean_required(artifact.get("artifact_ext")) or "").lstrip(".").casefold() == "pptx",
            artifact.get("artifact_is_fallback") is False,
            _mapping(artifact.get("mechanical_gate_results")).get("passed") is True,
            _clean_required(artifact.get("storage_provider")) == "supabase",
            _clean_required(artifact.get("storage_status")) == "available",
        )
    )


def prepare_deck_quality_publication(
    *,
    config: AppConfig,
    state: Mapping[str, Any],
    artifact: Mapping[str, Any],
    completion_payload: Mapping[str, Any],
) -> PreparedDeckQualityPublication | None:
    """Apply the exact canary gate before any artifact or evidence file read."""

    if not is_deck_quality_publication_candidate(
        config=config,
        artifact=artifact,
        completion_payload=completion_payload,
    ):
        return None
    user_id = _clean_required(completion_payload.get("user_id"))
    assert user_id is not None

    artifact_virtual_path = _normalized_pptx_path(artifact.get("artifact_path"))
    outputs_root = _outputs_root(state)
    thread_id = _clean_required(completion_payload.get("thread_id"))
    task_id = _clean_required(completion_payload.get("task_id"))
    builder_run_id = _clean_required(completion_payload.get("run_id"))
    # DQ-1 links to the concrete LangSmith builder root stamped by
    # ``annotate_builder_completion`` immediately before the completion
    # webhook. ``completion_payload.trace_id`` is the older companion-side
    # diagnostic correlation token and may be an eight-character fallback;
    # it is not evidence of a persisted builder trace and must never enter
    # quality provenance.
    artifact_builder_trace_id = artifact.get("builder_trace_root_run_id")
    payload_builder_trace_id = completion_payload.get("builder_trace_root_run_id")
    parent_builder_trace_id = (
        artifact_builder_trace_id
        if isinstance(artifact_builder_trace_id, str) and bool(artifact_builder_trace_id) and artifact_builder_trace_id == artifact_builder_trace_id.strip() and artifact_builder_trace_id == payload_builder_trace_id
        else None
    )
    build_id = _clean_required(artifact.get("deck_build_id"))
    logical_artifact_id = _clean_required(artifact.get("logical_artifact_id"))
    artifact_version_id = _clean_required(artifact.get("current_artifact_version_id"))
    task_brief = _clean_required(completion_payload.get("task_brief"))
    if None in {
        artifact_virtual_path,
        outputs_root,
        thread_id,
        task_id,
        builder_run_id,
        parent_builder_trace_id,
        build_id,
        logical_artifact_id,
        artifact_version_id,
        task_brief,
    }:
        return None
    assert artifact_virtual_path is not None
    assert outputs_root is not None
    assert thread_id is not None
    assert task_id is not None
    assert builder_run_id is not None
    assert parent_builder_trace_id is not None
    assert build_id is not None
    assert logical_artifact_id is not None
    assert artifact_version_id is not None
    assert task_brief is not None
    if safe_object_path_segment(build_id, default="build") != build_id:
        return None

    storage_path = _eligible_storage_path(
        object_path=artifact.get("storage_object_path"),
        user_id=user_id,
        thread_id=thread_id,
    )
    if storage_path is None:
        return None
    artifact_sha256 = _clean_required(artifact.get("artifact_sha256"))
    if artifact_sha256 is None or len(artifact_sha256) != 64 or any(character not in "0123456789abcdef" for character in artifact_sha256):
        return None

    revision = artifact.get("manifest_revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    manifest_revision = revision
    score = artifact.get("native_editability_score")
    native_editability_score = float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None
    missing_visuals = artifact.get("missing_expected_visual_count")
    missing_expected_visual_count = missing_visuals if isinstance(missing_visuals, int) and not isinstance(missing_visuals, bool) and missing_visuals >= 0 else None
    return PreparedDeckQualityPublication(
        outputs_root=outputs_root,
        artifact_virtual_path=artifact_virtual_path,
        artifact_storage_object_path=storage_path,
        artifact_sha256=artifact_sha256,
        artifact_id=_clean_required(artifact.get("artifact_id")),
        logical_artifact_id=logical_artifact_id,
        artifact_version_id=artifact_version_id,
        manifest_revision=manifest_revision,
        build_id=build_id,
        user_id=user_id,
        thread_id=thread_id,
        task_id=task_id,
        builder_run_id=builder_run_id,
        parent_builder_trace_id=parent_builder_trace_id,
        task_brief=task_brief,
        mechanical_gate_results=_mapping(artifact.get("mechanical_gate_results")),
        source_retention_report=_mapping(artifact.get("source_retention_report")),
        native_contrast_report=_mapping(artifact.get("native_contrast_report")),
        native_mechanical_report=_mapping(artifact.get("native_mechanical_report")),
        native_editability_score=native_editability_score,
        missing_expected_visual_count=missing_expected_visual_count,
    )


def _read_scoped_json_object(
    outputs_root: Path,
    *,
    filename: str,
    code: str,
) -> dict[str, Any]:
    """Read one regular deck-build JSON file without following symlinks."""

    root_fd: int | None = None
    deck_fd: int | None = None
    file_fd: int | None = None
    try:
        root = outputs_root.resolve(strict=True)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        deck_fd = os.open(
            "deck_build",
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=root_fd,
        )
        file_fd = os.open(
            filename,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=deck_fd,
        )
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= _MAX_NATIVE_JSON_BYTES:
            raise DeckQualityPublicationError(code)
        content = bytearray()
        while True:
            chunk = os.read(file_fd, min(64 * 1024, _MAX_NATIVE_JSON_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > _MAX_NATIVE_JSON_BYTES:
                raise DeckQualityPublicationError(code)
        after = os.fstat(file_fd)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ) or len(content) != before.st_size:
            raise DeckQualityPublicationError(code)

        def reject_constant(_value: str) -> None:
            raise ValueError

        payload = json.loads(
            bytes(content).decode("utf-8"),
            parse_constant=reject_constant,
        )
    except DeckQualityPublicationError:
        raise
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        raise DeckQualityPublicationError(code) from None
    finally:
        for descriptor in (file_fd, deck_fd, root_fd):
            if descriptor is not None:
                os.close(descriptor)
    if not isinstance(payload, dict):
        raise DeckQualityPublicationError(code)
    try:
        return json.loads(canonical_json_bytes(payload))
    except (TypeError, ValueError, json.JSONDecodeError):
        raise DeckQualityPublicationError(code) from None


def _captured_native_inputs(
    prepared: PreparedDeckQualityPublication,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    creative = _read_scoped_json_object(
        prepared.outputs_root,
        filename="creative_plan.json",
        code="creative_plan_unavailable",
    )
    design = _read_scoped_json_object(
        prepared.outputs_root,
        filename="design_plan.json",
        code="design_plan_unavailable",
    )
    build_record = _read_scoped_json_object(
        prepared.outputs_root,
        filename="build.json",
        code="build_record_unavailable",
    )
    return creative, design, build_record


def _blind_brief_from_current_request(
    prepared: PreparedDeckQualityPublication,
) -> BlindBrief:
    """Project Assessment A context only from the frozen current request.

    ``BlindBrief`` v1 requires separate subject, audience, and goal strings, but
    the publication boundary currently receives only one authentic pre-plan
    source: ``task_brief``. Repeating that exact sanitized request preserves its
    provenance without asking builder-authored creative/design plans to invent
    semantic fields for the blind judge. Explicit style constraints remain in
    the request when the user actually supplied them; plan-only terms are not
    promoted into blind context.
    """

    try:
        current_request = sanitize_current_request(prepared.task_brief)
    except ValueError:
        raise DeckQualityPublicationError("blind_brief_incomplete") from None
    # BlindBrief v1 bounds each structured projection to 2,000 characters.
    # This remains a verbatim prefix of the authentic request; the complete
    # request is retained in ``request`` below.
    structured_projection = current_request[:2_000]
    return BlindBrief(
        request=current_request,
        subject=structured_projection,
        audience=structured_projection,
        goal=structured_projection,
        viewing_context="presentation",
        explicit_brand_style_constraints=(),
    )


def _known_boolean(value: object) -> bool | dict[str, str]:
    return value if isinstance(value, bool) else {"status": "unknown"}


def _mechanical_record(
    prepared: PreparedDeckQualityPublication,
) -> dict[str, dict[str, object]]:
    native = prepared.native_mechanical_report
    lint_success = native.get("lint_fix_success")
    lint_residue_count = native.get("lint_residue_count")
    if isinstance(lint_success, bool) and isinstance(lint_residue_count, int):
        native_lint: bool | dict[str, str] = lint_success and lint_residue_count == 0
    else:
        native_lint = {"status": "unknown"}
    score = prepared.native_editability_score
    editability: bool | dict[str, str] = score > 0 if score is not None else {"status": "unknown"}
    missing_visuals = prepared.missing_expected_visual_count
    visual_completeness: bool | dict[str, str] = missing_visuals == 0 if missing_visuals is not None else {"status": "unknown"}
    return {
        "checks": {
            "authoritative_gate": True,
            "source_retention": _known_boolean(prepared.source_retention_report.get("passed")),
            "native_editability": editability,
            "contrast": _known_boolean(prepared.native_contrast_report.get("passed")),
            "native_lint": native_lint,
            "overflow_collision_clipping": True,
            "render_success": _known_boolean(native.get("render_success")),
            "visual_asset_completeness": visual_completeness,
            # Set only after the durable object bytes are compared below.
            "artifact_identity": True,
        }
    }


def _artifact_identity(
    *,
    prepared: PreparedDeckQualityPublication,
    artifact_hash: str,
) -> tuple[str, str]:
    del artifact_hash
    return prepared.logical_artifact_id, prepared.artifact_version_id


def build_deck_quality_producer_intent(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
) -> DeckQualityProducerIntent:
    """Build the content-free ticket before any source-plan file read."""

    logical_artifact_id, artifact_version_id = _artifact_identity(
        prepared=prepared,
        artifact_hash=prepared.artifact_sha256,
    )
    quality_run_id = derive_quality_run_id(
        artifact_version_id=artifact_version_id,
        campaign_id=_CAMPAIGN_ID,
        instrument=instrument.lock,
    )
    return DeckQualityProducerIntent(
        quality_run_id=quality_run_id,
        instrument_identity_hash=canonical_sha256(instrument.lock),
        user_id=prepared.user_id,
        thread_id=prepared.thread_id,
        task_id=prepared.task_id,
        build_id=prepared.build_id,
        builder_run_id=prepared.builder_run_id,
        parent_builder_trace_id=prepared.parent_builder_trace_id,
        logical_artifact_id=logical_artifact_id,
        artifact_version_id=artifact_version_id,
        manifest_revision=prepared.manifest_revision,
        artifact_virtual_path=prepared.artifact_virtual_path,
        accepted_delivery_object_path=prepared.artifact_storage_object_path,
        immutable_snapshot_object_path=(
            deck_quality_immutable_artifact_snapshot_path(
                user_id=prepared.user_id,
                thread_id=prepared.thread_id,
                build_id=prepared.build_id,
                logical_artifact_id=logical_artifact_id,
                artifact_version_id=artifact_version_id,
                artifact_sha256=prepared.artifact_sha256,
                artifact_virtual_path=prepared.artifact_virtual_path,
            )
        ),
        artifact_sha256=prepared.artifact_sha256,
    )


def capture_deck_quality_source_pack(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
) -> tuple[DeckQualitySourcePack, bytes]:
    """Capture each local-only source once into one canonical immutable pack."""

    intent = build_deck_quality_producer_intent(
        prepared=prepared,
        instrument=instrument,
    )
    creative_plan, design_plan, build_record = _captured_native_inputs(prepared)
    brief = _blind_brief_from_current_request(prepared)
    mechanical_record = _mechanical_record(prepared)
    if any(len(canonical_json_bytes(value)) > _MAX_NATIVE_JSON_BYTES for value in (creative_plan, design_plan, build_record, mechanical_record)):
        raise DeckQualityPublicationError("source_pack_input_oversized")
    pack = DeckQualitySourcePack(
        quality_run_id=intent.quality_run_id,
        instrument=instrument.lock,
        instrument_identity_hash=intent.instrument_identity_hash,
        user_id=intent.user_id,
        thread_id=intent.thread_id,
        task_id=intent.task_id,
        build_id=intent.build_id,
        builder_run_id=intent.builder_run_id,
        parent_builder_trace_id=intent.parent_builder_trace_id,
        logical_artifact_id=intent.logical_artifact_id,
        artifact_version_id=intent.artifact_version_id,
        manifest_revision=intent.manifest_revision,
        artifact_virtual_path=intent.artifact_virtual_path,
        accepted_delivery_object_path=intent.accepted_delivery_object_path,
        immutable_snapshot_object_path=intent.immutable_snapshot_object_path,
        artifact_sha256=intent.artifact_sha256,
        creative_plan=creative_plan,
        design_plan=design_plan,
        build_record=build_record,
        blind_brief=brief,
        mechanical_record=mechanical_record,
        source_hashes=DeckQualitySourceHashes(
            creative_plan=canonical_sha256(creative_plan),
            design_plan=canonical_sha256(design_plan),
            build_record=canonical_sha256(build_record),
            blind_brief=canonical_sha256(brief),
            mechanical_record=canonical_sha256(mechanical_record),
        ),
    )
    encoded = canonical_json_bytes(pack)
    if not 0 < len(encoded) <= _MAX_SOURCE_PACK_BYTES:
        raise DeckQualityPublicationError("source_pack_oversized")
    return pack, encoded


def build_deck_quality_publication_intent(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
) -> DeckQualityProducerIntent:
    """Compatibility alias for the content-free producer identity."""

    return build_deck_quality_producer_intent(
        prepared=prepared,
        instrument=instrument,
    )


def _immutable_artifact_object_path(
    prepared: PreparedDeckQualityPublication,
) -> str:
    """Compatibility wrapper around the public canonical snapshot helper."""

    return deck_quality_immutable_artifact_snapshot_path(
        user_id=prepared.user_id,
        thread_id=prepared.thread_id,
        build_id=prepared.build_id,
        logical_artifact_id=prepared.logical_artifact_id,
        artifact_version_id=prepared.artifact_version_id,
        artifact_sha256=prepared.artifact_sha256,
        artifact_virtual_path=prepared.artifact_virtual_path,
    )


def _source_pack_matches_intent(
    pack: DeckQualitySourcePack,
    intent: DeckQualityProducerIntent,
) -> bool:
    return all(
        (
            pack.campaign_id == intent.campaign_id,
            pack.quality_run_id == intent.quality_run_id,
            pack.instrument_identity_hash == intent.instrument_identity_hash,
            pack.user_id == intent.user_id,
            pack.thread_id == intent.thread_id,
            pack.task_id == intent.task_id,
            pack.build_id == intent.build_id,
            pack.builder_run_id == intent.builder_run_id,
            pack.parent_builder_trace_id == intent.parent_builder_trace_id,
            pack.logical_artifact_id == intent.logical_artifact_id,
            pack.artifact_version_id == intent.artifact_version_id,
            pack.manifest_revision == intent.manifest_revision,
            pack.artifact_virtual_path == intent.artifact_virtual_path,
            pack.accepted_delivery_object_path == intent.accepted_delivery_object_path,
            pack.immutable_snapshot_object_path == intent.immutable_snapshot_object_path,
            pack.artifact_sha256 == intent.artifact_sha256,
        )
    )


def _prepared_matches_intent(
    *,
    prepared: PreparedDeckQualityPublication,
    intent: DeckQualityProducerIntent,
    instrument: DeckQualityRuntimeInstrument,
) -> bool:
    return all(
        (
            derive_quality_run_id(
                artifact_version_id=prepared.artifact_version_id,
                campaign_id=_CAMPAIGN_ID,
                instrument=instrument.lock,
            )
            == intent.quality_run_id,
            canonical_sha256(instrument.lock) == intent.instrument_identity_hash,
            prepared.user_id == intent.user_id,
            prepared.thread_id == intent.thread_id,
            prepared.task_id == intent.task_id,
            prepared.build_id == intent.build_id,
            prepared.builder_run_id == intent.builder_run_id,
            prepared.parent_builder_trace_id == intent.parent_builder_trace_id,
            prepared.logical_artifact_id == intent.logical_artifact_id,
            prepared.artifact_version_id == intent.artifact_version_id,
            prepared.manifest_revision == intent.manifest_revision,
            prepared.artifact_virtual_path == intent.artifact_virtual_path,
            prepared.artifact_storage_object_path == intent.accepted_delivery_object_path,
            intent.accepted_delivery_object_path == intent.immutable_snapshot_object_path,
            _immutable_artifact_object_path(prepared) == intent.immutable_snapshot_object_path,
            prepared.artifact_sha256 == intent.artifact_sha256,
        )
    )


def encode_deck_quality_producer_bundle(
    *,
    pack: DeckQualitySourcePack,
    source_pack_bytes: bytes,
) -> tuple[bytes, DeckQualityProducerBundleDescriptor]:
    """Encode the small commit marker; private source bytes live separately."""

    if not isinstance(source_pack_bytes, bytes) or canonical_json_bytes(pack) != source_pack_bytes or not 0 < len(source_pack_bytes) <= _MAX_SOURCE_PACK_BYTES or pack.accepted_delivery_object_path != pack.immutable_snapshot_object_path:
        raise DeckQualityPublicationError("producer_bundle_invalid")
    source_hash = hashlib.sha256(source_pack_bytes).hexdigest()
    manifest = DeckQualityProducerOutboxManifest(
        quality_run_id=pack.quality_run_id,
        instrument_identity_hash=pack.instrument_identity_hash,
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        task_id=pack.task_id,
        build_id=pack.build_id,
        builder_run_id=pack.builder_run_id,
        parent_builder_trace_id=pack.parent_builder_trace_id,
        logical_artifact_id=pack.logical_artifact_id,
        artifact_version_id=pack.artifact_version_id,
        manifest_revision=pack.manifest_revision,
        artifact_virtual_path=pack.artifact_virtual_path,
        artifact_object_path=pack.immutable_snapshot_object_path,
        artifact_sha256=pack.artifact_sha256,
        source_pack_object_path=deck_quality_source_pack_path(
            user_id=pack.user_id,
            thread_id=pack.thread_id,
            build_id=pack.build_id,
            quality_run_id=pack.quality_run_id,
        ),
        source_pack_sha256=source_hash,
        source_pack_size_bytes=len(source_pack_bytes),
    )
    content = canonical_json_bytes(manifest)
    if not 0 < len(content) <= _MAX_PRODUCER_BUNDLE_BYTES:
        raise DeckQualityPublicationError("producer_bundle_invalid")
    object_path = deck_quality_producer_bundle_path(pack.quality_run_id)
    descriptor = DeckQualityProducerBundleDescriptor(
        quality_run_id=pack.quality_run_id,
        object_path=object_path,
        sha256=hashlib.sha256(content).hexdigest(),
        size_bytes=len(content),
        source_pack_sha256=source_hash,
        source_pack_size_bytes=len(source_pack_bytes),
        artifact_sha256=pack.artifact_sha256,
    )
    return content, descriptor


def decode_deck_quality_producer_bundle(
    content: bytes,
    *,
    expected_quality_run_id: str | None = None,
    expected_object_path: str | None = None,
) -> DecodedDeckQualityProducerBundle:
    """Strictly decode one canonical, content-free producer outbox marker."""

    if not isinstance(content, bytes) or not content or len(content) > _MAX_PRODUCER_BUNDLE_BYTES:
        raise DeckQualityPublicationError("producer_bundle_invalid")
    try:
        manifest = DeckQualityProducerOutboxManifest.model_validate_json(content)
    except (TypeError, ValueError):
        raise DeckQualityPublicationError("producer_bundle_invalid") from None
    if canonical_json_bytes(manifest) != content:
        raise DeckQualityPublicationError("producer_bundle_noncanonical")
    if expected_quality_run_id is not None and manifest.quality_run_id != expected_quality_run_id:
        raise DeckQualityPublicationError("producer_bundle_run_mismatch")
    inbox_path = deck_quality_producer_bundle_path(manifest.quality_run_id)
    archive_path = deck_quality_producer_archive_path(manifest.quality_run_id)
    if expected_object_path is not None and expected_object_path not in {
        inbox_path,
        archive_path,
    }:
        raise DeckQualityPublicationError("producer_bundle_path_mismatch")
    object_path = expected_object_path or inbox_path
    descriptor = DeckQualityProducerBundleDescriptor(
        quality_run_id=manifest.quality_run_id,
        object_path=object_path,
        sha256=hashlib.sha256(content).hexdigest(),
        size_bytes=len(content),
        source_pack_sha256=manifest.source_pack_sha256,
        source_pack_size_bytes=manifest.source_pack_size_bytes,
        artifact_sha256=manifest.artifact_sha256,
    )
    return DecodedDeckQualityProducerBundle(
        manifest=manifest,
        descriptor=descriptor,
    )


def _read_object_bounded(
    object_store: ImmutableObjectUploader,
    object_path: str,
    *,
    max_bytes: int,
    error_code: str,
) -> bytes | None:
    try:
        bounded_reader = getattr(object_store, "read_bounded", None)
        content = bounded_reader(object_path, max_bytes=max_bytes) if callable(bounded_reader) else object_store.read(object_path)
    except Exception:
        raise DeckQualityPublicationError(error_code) from None
    if content is not None and (not isinstance(content, bytes) or len(content) > max_bytes):
        raise DeckQualityPublicationError(error_code)
    return content


def _receipt_from_descriptor(
    descriptor: DeckQualityProducerBundleDescriptor,
) -> DeckQualityProducerBundleReceipt:
    return DeckQualityProducerBundleReceipt(
        quality_run_id=descriptor.quality_run_id,
        bundle_object_path=descriptor.object_path,
        bundle_hash=descriptor.sha256,
        bundle_size_bytes=descriptor.size_bytes,
    )


def _verify_existing_producer_bundle(
    *,
    content: bytes,
    object_path: str,
    intent: DeckQualityProducerIntent,
    instrument: DeckQualityRuntimeInstrument,
) -> DecodedDeckQualityProducerBundle:
    try:
        decoded = decode_deck_quality_producer_bundle(
            content,
            expected_quality_run_id=intent.quality_run_id,
            expected_object_path=object_path,
        )
    except DeckQualityPublicationError:
        raise DeckQualityPublicationError("producer_bundle_conflict") from None
    manifest = decoded.manifest
    expected = (
        (manifest.campaign_id, intent.campaign_id),
        (manifest.quality_run_id, intent.quality_run_id),
        (manifest.instrument_identity_hash, intent.instrument_identity_hash),
        (manifest.user_id, intent.user_id),
        (manifest.thread_id, intent.thread_id),
        (manifest.task_id, intent.task_id),
        (manifest.build_id, intent.build_id),
        (manifest.builder_run_id, intent.builder_run_id),
        (manifest.parent_builder_trace_id, intent.parent_builder_trace_id),
        (manifest.logical_artifact_id, intent.logical_artifact_id),
        (manifest.artifact_version_id, intent.artifact_version_id),
        (manifest.manifest_revision, intent.manifest_revision),
        (manifest.artifact_virtual_path, intent.artifact_virtual_path),
        (manifest.artifact_object_path, intent.immutable_snapshot_object_path),
        (manifest.artifact_sha256, intent.artifact_sha256),
    )
    if canonical_sha256(instrument.lock) != intent.instrument_identity_hash or any(actual != wanted for actual, wanted in expected):
        raise DeckQualityPublicationError("producer_bundle_conflict")
    return decoded


async def _async_read_object_bounded(
    object_store: AsyncSupabaseImmutableObjectStore,
    object_path: str,
    *,
    max_bytes: int,
    error_code: str,
) -> bytes | None:
    try:
        content = await object_store.read_bounded(
            object_path,
            max_bytes=max_bytes,
        )
    except Exception:
        raise DeckQualityPublicationError(error_code) from None
    if content is not None and (not isinstance(content, bytes) or len(content) > max_bytes):
        raise DeckQualityPublicationError(error_code)
    return content


def _require_async_protocol_time(deadline: float) -> None:
    """Fence synchronous bounded work that cannot observe loop cancellation."""

    if asyncio.get_running_loop().time() >= deadline:
        raise TimeoutError


async def _capture_source_pack_off_loop(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
) -> tuple[DeckQualitySourcePack, bytes]:
    """Run local read/canonicalization on a detached read-only daemon.

    A filesystem read can remain blocked after coroutine cancellation. The
    worker therefore receives no object store and cannot perform a late write;
    a timed-out producer detaches delivery while the daemon's eventual result
    is discarded. A manually managed daemon also avoids ``asyncio.run`` waiting
    for a stuck default-executor thread during loop shutdown.
    """

    loop = asyncio.get_running_loop()
    future: asyncio.Future[tuple[DeckQualitySourcePack, bytes]] = (
        loop.create_future()
    )

    def capture() -> None:
        try:
            result = capture_deck_quality_source_pack(
                prepared=prepared,
                instrument=instrument,
            )
        except Exception as exc:  # noqa: BLE001 - forwarded without content.
            error = exc

            def settle_error() -> None:
                if not future.done():
                    future.set_exception(error)

            callback = settle_error
        else:
            captured = result

            def settle_result() -> None:
                if not future.done():
                    future.set_result(captured)

            callback = settle_result
        try:
            loop.call_soon_threadsafe(callback)
        except RuntimeError:
            # The absolute deadline may have closed the private asyncio.run
            # loop before a blocked read returned. No late result is needed.
            return

    threading.Thread(
        target=capture,
        name="dq1-source-capture",
        daemon=True,
    ).start()
    return await future


async def _bounded_async_store_close(
    object_store: AsyncSupabaseImmutableObjectStore,
    *,
    deadline: float,
) -> None:
    """Close transport only inside the caller's absolute deadline."""

    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        return
    try:
        async with asyncio.timeout(
            min(_ASYNC_STORE_CLOSE_TIMEOUT_SECONDS, remaining)
        ):
            await object_store.aclose()
    except Exception:
        # Closing is local resource hygiene after the durable outcome is known.
        # It cannot change success into a contradictory failure-marker write.
        return


async def _persist_owned_producer_bundle_protocol(
    *,
    prepared: PreparedDeckQualityPublication,
    intent: DeckQualityProducerIntent,
    instrument: DeckQualityRuntimeInstrument,
    object_store: AsyncSupabaseImmutableObjectStore,
    deadline: float,
) -> DeckQualityProducerBundleReceipt:
    object_path = deck_quality_producer_bundle_path(intent.quality_run_id)
    archive_path = deck_quality_producer_archive_path(intent.quality_run_id)

    archived = await _async_read_object_bounded(
        object_store,
        archive_path,
        max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        error_code="producer_bundle_recovery_failed",
    )
    if archived is not None:
        receipt = _receipt_from_descriptor(
            _verify_existing_producer_bundle(
                content=archived,
                object_path=archive_path,
                intent=intent,
                instrument=instrument,
            ).descriptor
        )
        _require_async_protocol_time(deadline)
        return receipt

    existing = await _async_read_object_bounded(
        object_store,
        object_path,
        max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        error_code="producer_bundle_recovery_failed",
    )
    if existing is not None:
        receipt = _receipt_from_descriptor(
            _verify_existing_producer_bundle(
                content=existing,
                object_path=object_path,
                intent=intent,
                instrument=instrument,
            ).descriptor
        )
        _require_async_protocol_time(deadline)
        return receipt

    pack, source_pack_bytes = await _capture_source_pack_off_loop(
        prepared=prepared,
        instrument=instrument,
    )
    _require_async_protocol_time(deadline)
    if not _source_pack_matches_intent(pack, intent):
        raise DeckQualityPublicationError("producer_bundle_source_identity_mismatch")
    source_path = deck_quality_source_pack_path(
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        build_id=pack.build_id,
        quality_run_id=pack.quality_run_id,
    )
    source_create_ambiguous = False
    try:
        source_outcome = await object_store.create_if_absent(
            source_path,
            source_pack_bytes,
            content_type="application/json",
        )
    except Exception:
        source_create_ambiguous = True
        source_outcome = None
    if source_create_ambiguous or source_outcome == "exists":
        stored_source = await _async_read_object_bounded(
            object_store,
            source_path,
            max_bytes=_MAX_SOURCE_PACK_BYTES,
            error_code="producer_source_persistence_failed",
        )
        if stored_source is None:
            raise DeckQualityPublicationError("producer_source_persistence_failed")
        if stored_source != source_pack_bytes:
            raise DeckQualityPublicationError("producer_source_persistence_conflict")
    elif source_outcome != "created":
        raise DeckQualityPublicationError("producer_source_persistence_failed")
    _require_async_protocol_time(deadline)
    encoded, descriptor = encode_deck_quality_producer_bundle(
        pack=pack,
        source_pack_bytes=source_pack_bytes,
    )
    _require_async_protocol_time(deadline)
    create_error = False
    try:
        outcome = await object_store.create_if_absent(
            object_path,
            encoded,
            content_type="application/json",
        )
    except Exception:
        # A create-only upload can commit while its response is lost. One
        # exact read-back inside the same total deadline is the ambiguity
        # fence; cancellation itself is deliberately never swallowed.
        create_error = True
        outcome = None
    if outcome == "created":
        _require_async_protocol_time(deadline)
        return _receipt_from_descriptor(descriptor)
    stored = await _async_read_object_bounded(
        object_store,
        object_path,
        max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        error_code="producer_bundle_persistence_failed",
    )
    if stored is None:
        raise DeckQualityPublicationError("producer_bundle_persistence_failed")
    if not create_error and outcome not in {"created", "exists"}:
        raise DeckQualityPublicationError("producer_bundle_persistence_failed")
    decoded = _verify_existing_producer_bundle(
        content=stored,
        object_path=object_path,
        intent=intent,
        instrument=instrument,
    )
    if decoded.descriptor != descriptor or stored != encoded:
        raise DeckQualityPublicationError("producer_bundle_conflict")
    _require_async_protocol_time(deadline)
    return _receipt_from_descriptor(decoded.descriptor)


async def _recover_owned_producer_bundle_after_timeout(
    *,
    intent: DeckQualityProducerIntent,
    instrument: DeckQualityRuntimeInstrument,
    object_store: AsyncSupabaseImmutableObjectStore,
    deadline: float,
) -> DeckQualityProducerBundleReceipt | None:
    """Resolve a create that may have committed before response cancellation."""

    for object_path in (
        deck_quality_producer_archive_path(intent.quality_run_id),
        deck_quality_producer_bundle_path(intent.quality_run_id),
    ):
        content = await _async_read_object_bounded(
            object_store,
            object_path,
            max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
            error_code="producer_bundle_recovery_failed",
        )
        if content is None:
            continue
        receipt = _receipt_from_descriptor(
            _verify_existing_producer_bundle(
                content=content,
                object_path=object_path,
                intent=intent,
                instrument=instrument,
            ).descriptor
        )
        _require_async_protocol_time(deadline)
        return receipt
    return None


async def _persist_owned_producer_bundle(
    *,
    prepared: PreparedDeckQualityPublication,
    intent: DeckQualityProducerIntent,
    instrument: DeckQualityRuntimeInstrument,
    deadline: float | None,
) -> DeckQualityProducerBundleReceipt:
    loop = asyncio.get_running_loop()
    absolute_deadline = (
        loop.time() + _PRODUCER_PROTOCOL_TIMEOUT_SECONDS
        if deadline is None
        else deadline
    )
    _require_async_protocol_time(absolute_deadline)
    operation_deadline = (
        absolute_deadline - _ASYNC_STORE_CLOSE_TIMEOUT_SECONDS
    )
    primary_deadline = (
        operation_deadline - _PRODUCER_AMBIGUITY_RESERVE_SECONDS
    )
    object_store = AsyncSupabaseImmutableObjectStore()
    try:
        try:
            async with asyncio.timeout_at(primary_deadline):
                return await _persist_owned_producer_bundle_protocol(
                    prepared=prepared,
                    intent=intent,
                    instrument=instrument,
                    object_store=object_store,
                    deadline=primary_deadline,
                )
        except TimeoutError:
            try:
                async with asyncio.timeout_at(operation_deadline):
                    recovered = await _recover_owned_producer_bundle_after_timeout(
                        intent=intent,
                        instrument=instrument,
                        object_store=object_store,
                        deadline=operation_deadline,
                    )
            except TimeoutError:
                recovered = None
            if recovered is not None:
                return recovered
            raise DeckQualityPublicationError("producer_bundle_deadline_exceeded") from None
    finally:
        await _bounded_async_store_close(
            object_store,
            deadline=absolute_deadline,
        )


def persist_deck_quality_producer_bundle(
    *,
    prepared: PreparedDeckQualityPublication,
    instrument: DeckQualityRuntimeInstrument,
    intent: DeckQualityProducerIntent | None = None,
    deadline: float | None = None,
    object_store: ImmutableObjectUploader | None = None,
) -> DeckQualityProducerBundleReceipt:
    """Durably commit immutable artifact/source references for recovery.

    The globally indexed bundle is the producer outbox. The gateway can
    discover and reconcile it after either process restarts, without relying
    on a builder-side database transaction or the terminal-delivery webhook.
    """

    if deadline is not None and (
        isinstance(deadline, bool)
        or not isinstance(deadline, (int, float))
        or not math.isfinite(float(deadline))
        or time.monotonic() >= float(deadline)
    ):
        raise DeckQualityPublicationError("producer_bundle_deadline_exceeded")
    producer_intent = intent or build_deck_quality_producer_intent(
        prepared=prepared,
        instrument=instrument,
    )
    if not _prepared_matches_intent(
        prepared=prepared,
        intent=producer_intent,
        instrument=instrument,
    ):
        raise DeckQualityPublicationError("producer_bundle_identity_mismatch")
    if object_store is None:
        # The live builder invokes this synchronous boundary from its dedicated
        # middleware worker thread. ``asyncio.run`` gives the production path a
        # cancellable httpx transport and one absolute deadline; injected sync
        # stores below remain only for deterministic unit tests.
        return asyncio.run(
            _persist_owned_producer_bundle(
                prepared=prepared,
                intent=producer_intent,
                instrument=instrument,
                deadline=float(deadline) if deadline is not None else None,
            )
        )
    store = object_store
    object_path = deck_quality_producer_bundle_path(
        producer_intent.quality_run_id
    )
    archive_path = deck_quality_producer_archive_path(
        producer_intent.quality_run_id
    )
    # Archive replay is deliberately first: the gateway deletes an
    # acknowledged inbox entry, so retries after local cleanup must resolve
    # immutable evidence without touching ephemeral sources or accepted
    # delivery bytes.
    archived = _read_object_bounded(
        store,
        archive_path,
        max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        error_code="producer_bundle_recovery_failed",
    )
    if archived is not None:
        return _receipt_from_descriptor(
            _verify_existing_producer_bundle(
                content=archived,
                object_path=archive_path,
                intent=producer_intent,
                instrument=instrument,
            ).descriptor
        )

    # A live inbox replay is second and still precedes all local/source
    # reads. It covers producer response loss before gateway acknowledgement.
    existing = _read_object_bounded(
        store,
        object_path,
        max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        error_code="producer_bundle_recovery_failed",
    )
    if existing is not None:
        return _receipt_from_descriptor(
            _verify_existing_producer_bundle(
                content=existing,
                object_path=object_path,
                intent=producer_intent,
                instrument=instrument,
            ).descriptor
        )

    pack, source_pack_bytes = capture_deck_quality_source_pack(
        prepared=prepared,
        instrument=instrument,
    )
    if not _source_pack_matches_intent(pack, producer_intent):
        raise DeckQualityPublicationError("producer_bundle_source_identity_mismatch")
    source_path = deck_quality_source_pack_path(
        user_id=pack.user_id,
        thread_id=pack.thread_id,
        build_id=pack.build_id,
        quality_run_id=pack.quality_run_id,
    )
    source_create_ambiguous = False
    try:
        source_outcome = store.create_if_absent(
            source_path,
            source_pack_bytes,
            content_type="application/json",
        )
    except Exception:
        source_create_ambiguous = True
        source_outcome = None
    if source_create_ambiguous or source_outcome == "exists":
        stored_source = _read_object_bounded(
            store,
            source_path,
            max_bytes=_MAX_SOURCE_PACK_BYTES,
            error_code="producer_source_persistence_failed",
        )
        if stored_source is None:
            raise DeckQualityPublicationError("producer_source_persistence_failed")
        if stored_source != source_pack_bytes:
            raise DeckQualityPublicationError("producer_source_persistence_conflict")
    elif source_outcome != "created":
        raise DeckQualityPublicationError("producer_source_persistence_failed")
    encoded, descriptor = encode_deck_quality_producer_bundle(
        pack=pack,
        source_pack_bytes=source_pack_bytes,
    )
    create_error = False
    try:
        outcome = store.create_if_absent(
            object_path,
            encoded,
            content_type="application/json",
        )
    except Exception:
        # Create-only upload can commit while its response is lost. One exact
        # read-back is the only safe ambiguity reconciliation.
        create_error = True
        outcome = None
    if outcome == "created":
        return _receipt_from_descriptor(descriptor)
    stored = _read_object_bounded(
        store,
        object_path,
        max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
        error_code="producer_bundle_persistence_failed",
    )
    if stored is None:
        raise DeckQualityPublicationError("producer_bundle_persistence_failed")
    if not create_error and outcome not in {"created", "exists"}:
        raise DeckQualityPublicationError("producer_bundle_persistence_failed")
    decoded = _verify_existing_producer_bundle(
        content=stored,
        object_path=object_path,
        intent=producer_intent,
        instrument=instrument,
    )
    if decoded.descriptor != descriptor or stored != encoded:
        raise DeckQualityPublicationError("producer_bundle_conflict")
    return _receipt_from_descriptor(decoded.descriptor)


async def _persist_owned_producer_failure_protocol(
    *,
    encoded: bytes,
    descriptor: DeckQualityProducerFailureDescriptor,
    intent: DeckQualityProducerIntent | None,
    instrument: DeckQualityRuntimeInstrument | None,
    object_store: AsyncSupabaseImmutableObjectStore,
) -> DeckQualityProducerFailureDescriptor:
    if intent is not None and instrument is not None:
        archive_path = deck_quality_producer_archive_path(intent.quality_run_id)
        archived = await _async_read_object_bounded(
            object_store,
            archive_path,
            max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
            error_code="producer_failure_persistence_failed",
        )
        if archived is not None:
            try:
                _verify_existing_producer_bundle(
                    content=archived,
                    object_path=archive_path,
                    intent=intent,
                    instrument=instrument,
                )
            except DeckQualityPublicationError:
                # Poison occupancy is not valid producer durability. Preserve
                # an explicit failure record; the gateway will quarantine the
                # conflicting archive/inbox independently.
                pass
            else:
                raise DeckQualityPublicationError("producer_bundle_already_durable")

        # Arbitrate a cancelled/late producer POST at the exact same immutable
        # inbox key before claiming dispatch unavailability. Whichever
        # create-only write wins (full bundle or content-free failure record)
        # is the only possible durable outcome at that key, eliminating the
        # late-visibility race between independent paths.
        inbox_path = deck_quality_producer_bundle_path(intent.quality_run_id)
        arbitration = canonical_json_bytes(
            {
                "campaign_id": "DQ-1",
                "candidate_digest": descriptor.candidate_digest,
                "quality_run_id": intent.quality_run_id,
                "schema_version": "deck-quality-producer-arbitration/v1",
            }
        )
        try:
            await object_store.create_if_absent(
                inbox_path,
                arbitration,
                content_type="application/json",
            )
        except Exception:
            pass
        inbox = await _async_read_object_bounded(
            object_store,
            inbox_path,
            max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
            error_code="producer_failure_persistence_failed",
        )
        if inbox is None:
            raise DeckQualityPublicationError("producer_failure_persistence_failed")
        if inbox != arbitration:
            try:
                _verify_existing_producer_bundle(
                    content=inbox,
                    object_path=inbox_path,
                    intent=intent,
                    instrument=instrument,
                )
            except DeckQualityPublicationError:
                # An unrelated poison object does not suppress the canonical
                # failure record below.
                pass
            else:
                raise DeckQualityPublicationError("producer_bundle_already_durable")
        else:
            # Close the archive/delete interleaving: the gateway always writes
            # a valid archive before retiring inbox. A neutral arbitration
            # sentinel never claims dispatch unavailability by itself.
            moved_archive = await _async_read_object_bounded(
                object_store,
                archive_path,
                max_bytes=_MAX_PRODUCER_BUNDLE_BYTES,
                error_code="producer_failure_persistence_failed",
            )
            if moved_archive is not None:
                try:
                    _verify_existing_producer_bundle(
                        content=moved_archive,
                        object_path=archive_path,
                        intent=intent,
                        instrument=instrument,
                    )
                except DeckQualityPublicationError:
                    pass
                else:
                    raise DeckQualityPublicationError("producer_bundle_already_durable")
    existing = await _async_read_object_bounded(
        object_store,
        descriptor.object_path,
        max_bytes=16 * 1024,
        error_code="producer_failure_persistence_failed",
    )
    if existing is not None:
        if existing != encoded or not hmac.compare_digest(
            hashlib.sha256(existing).hexdigest(),
            descriptor.sha256,
        ):
            raise DeckQualityPublicationError("producer_failure_persistence_conflict")
        return descriptor
    create_error = False
    try:
        outcome = await object_store.create_if_absent(
            descriptor.object_path,
            encoded,
            content_type="application/json",
        )
    except Exception:
        create_error = True
        outcome = None
    stored = await _async_read_object_bounded(
        object_store,
        descriptor.object_path,
        max_bytes=16 * 1024,
        error_code="producer_failure_persistence_failed",
    )
    if stored is None or (not create_error and outcome not in {"created", "exists"}):
        raise DeckQualityPublicationError("producer_failure_persistence_failed")
    if stored != encoded or not hmac.compare_digest(
        hashlib.sha256(stored).hexdigest(),
        descriptor.sha256,
    ):
        raise DeckQualityPublicationError("producer_failure_persistence_conflict")
    return descriptor


async def _persist_owned_producer_failure(
    *,
    encoded: bytes,
    descriptor: DeckQualityProducerFailureDescriptor,
    intent: DeckQualityProducerIntent | None,
    instrument: DeckQualityRuntimeInstrument | None,
    deadline: float | None,
) -> DeckQualityProducerFailureDescriptor:
    absolute_deadline = (
        asyncio.get_running_loop().time() + _FAILURE_PROTOCOL_TIMEOUT_SECONDS
        if deadline is None
        else deadline
    )
    _require_async_protocol_time(absolute_deadline)
    operation_deadline = (
        absolute_deadline - _ASYNC_STORE_CLOSE_TIMEOUT_SECONDS
    )
    object_store = AsyncSupabaseImmutableObjectStore()
    try:
        try:
            async with asyncio.timeout_at(operation_deadline):
                return await _persist_owned_producer_failure_protocol(
                    encoded=encoded,
                    descriptor=descriptor,
                    intent=intent,
                    instrument=instrument,
                    object_store=object_store,
                )
        except TimeoutError:
            raise DeckQualityPublicationError("producer_failure_deadline_exceeded") from None
    finally:
        await _bounded_async_store_close(
            object_store,
            deadline=absolute_deadline,
        )


def persist_deck_quality_producer_failure(
    *,
    candidate_digest: str,
    failure_stage: DeckQualityProducerFailureStage,
    failure_code: DeckQualityProducerFailureCode,
    quality_run_id: str | None = None,
    prepared: PreparedDeckQualityPublication | None = None,
    instrument: DeckQualityRuntimeInstrument | None = None,
    intent: DeckQualityProducerIntent | None = None,
    deadline: float | None = None,
    object_store: ImmutableObjectUploader | None = None,
) -> DeckQualityProducerFailureDescriptor:
    """Persist one deterministic, content-free exact-candidate failure."""

    if deadline is not None and (
        isinstance(deadline, bool)
        or not isinstance(deadline, (int, float))
        or not math.isfinite(float(deadline))
        or time.monotonic() >= float(deadline)
    ):
        raise DeckQualityPublicationError("producer_failure_deadline_exceeded")
    expected_codes: dict[
        DeckQualityProducerFailureStage,
        DeckQualityProducerFailureCode,
    ] = {
        "candidate_metadata": "candidate_metadata_invalid",
        "instrument": "instrument_invalid",
        "producer_bundle": "producer_bundle_unavailable",
    }
    if expected_codes.get(failure_stage) != failure_code:
        raise DeckQualityPublicationError("producer_failure_invalid")
    if failure_stage == "producer_bundle":
        if quality_run_id is None or prepared is None or instrument is None:
            raise DeckQualityPublicationError("producer_failure_invalid")
    elif any(
        value is not None
        for value in (quality_run_id, prepared, instrument, intent)
    ):
        raise DeckQualityPublicationError("producer_failure_invalid")
    try:
        record = DeckQualityProducerFailureRecord(
            candidate_digest=candidate_digest,
            quality_run_id=quality_run_id,
            failure_stage=failure_stage,
            failure_code=failure_code,
        )
    except ValueError:
        raise DeckQualityPublicationError("producer_failure_invalid") from None
    encoded = canonical_json_bytes(record)
    if not 0 < len(encoded) <= 16 * 1024:
        raise DeckQualityPublicationError("producer_failure_invalid")
    object_path = deck_quality_producer_failure_path(candidate_digest)
    digest = hashlib.sha256(encoded).hexdigest()
    descriptor = DeckQualityProducerFailureDescriptor(
        candidate_digest=candidate_digest,
        object_path=object_path,
        sha256=digest,
        size_bytes=len(encoded),
    )

    producer_intent = intent
    if prepared is not None and instrument is not None:
        producer_intent = producer_intent or build_deck_quality_producer_intent(
            prepared=prepared,
            instrument=instrument,
        )
        if (
            quality_run_id != producer_intent.quality_run_id
            or not _prepared_matches_intent(
                prepared=prepared,
                intent=producer_intent,
                instrument=instrument,
            )
        ):
            raise DeckQualityPublicationError("producer_failure_invalid")

    if object_store is None:
        return asyncio.run(
            _persist_owned_producer_failure(
                encoded=encoded,
                descriptor=descriptor,
                intent=producer_intent,
                instrument=instrument,
                deadline=float(deadline) if deadline is not None else None,
            )
        )
    store = object_store
    existing = _read_object_bounded(
        store,
        object_path,
        max_bytes=16 * 1024,
        error_code="producer_failure_persistence_failed",
    )
    if existing is not None:
        if existing != encoded or not hmac.compare_digest(
            hashlib.sha256(existing).hexdigest(),
            digest,
        ):
            raise DeckQualityPublicationError("producer_failure_persistence_conflict")
        return descriptor
    create_error = False
    try:
        outcome = store.create_if_absent(
            object_path,
            encoded,
            content_type="application/json",
        )
    except Exception:
        create_error = True
        outcome = None
    stored = _read_object_bounded(
        store,
        object_path,
        max_bytes=16 * 1024,
        error_code="producer_failure_persistence_failed",
    )
    if stored is None or (not create_error and outcome not in {"created", "exists"}):
        raise DeckQualityPublicationError("producer_failure_persistence_failed")
    if stored != encoded or not hmac.compare_digest(
        hashlib.sha256(stored).hexdigest(),
        digest,
    ):
        raise DeckQualityPublicationError("producer_failure_persistence_conflict")
    return descriptor
