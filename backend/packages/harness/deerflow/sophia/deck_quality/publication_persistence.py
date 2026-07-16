from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal, Protocol, Self, runtime_checkable

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.persistence import (
    DeckQualityPersistenceConfig,
    DeckQualityPersistenceProtocolError,
    DeckQualityPersistenceRpcError,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock
from deerflow.sophia.storage.supabase_artifact_store import (
    normalize_object_path,
    safe_object_path_segment,
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAP_KEY_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_VERSION_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
_WORKER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_OPERATION_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SAFE_STAGE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_QUALITY_RUN_ID_RE = re.compile(r"^quality_[0-9a-f]{64}$")
_PUBLICATION_HORIZON = timedelta(minutes=3)
_QUALITY_DEADLINE_OFFSET = timedelta(minutes=12)


class PublicationState(StrEnum):
    AWAITING_INPUTS = "awaiting_inputs"
    PENDING = "pending"
    RUNNING = "running"
    RETRY_WAIT = "retry_wait"
    PUBLISHED = "published"
    FAILED = "failed"


class PublicationErrorCode(StrEnum):
    INPUTS_UNAVAILABLE = "publication_inputs_unavailable"
    ARTIFACT_VERIFICATION_FAILED = "publication_artifact_verification_failed"
    ARTIFACT_SNAPSHOT_STALE = "publication_artifact_snapshot_stale"
    PERSISTENCE_ERROR = "publication_persistence_error"
    DEADLINE_EXCEEDED = "publication_deadline_exceeded"
    ATTEMPT_LIMIT_EXHAUSTED = "publication_attempt_limit_exhausted"


class PublicationOperationKind(StrEnum):
    RENEW = "renew"
    RETRY = "retry"
    FAIL = "fail"
    PROMOTE = "promote"


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _aware_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("publication timestamp must be timezone-aware")
    return value


def _validate_instrument(instrument: QualityInstrumentLock) -> None:
    scalar_versions = (
        instrument.schema_version,
        instrument.rubric_version,
        instrument.judge_profile_version,
        instrument.evidence_preprocessor_version,
        instrument.judge_invoker_version,
    )
    if any(_VERSION_VALUE_RE.fullmatch(version) is None for version in scalar_versions):
        raise ValueError("instrument scalar version is invalid")
    if not instrument.prompt_hashes or not instrument.assessment_schema_versions:
        raise ValueError("instrument hash and version maps cannot be empty")
    if any(_MAP_KEY_RE.fullmatch(key) is None for key in instrument.prompt_hashes):
        raise ValueError("instrument prompt hash key is invalid")
    if any(_MAP_KEY_RE.fullmatch(key) is None or _VERSION_VALUE_RE.fullmatch(version) is None for key, version in instrument.assessment_schema_versions.items()):
        raise ValueError("instrument assessment schema version is invalid")


def expected_publication_input_manifest_path(
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
    quality_run_id: str,
) -> str:
    return (
        f"artifacts/{safe_object_path_segment(user_id, default='user')}/"
        f"{safe_object_path_segment(thread_id, default='thread')}/foundation/"
        ".builder/builds/"
        f"{safe_object_path_segment(build_id, default='build')}/quality/"
        f"{quality_run_id}/input_bundle/manifest.json"
    )


def expected_publication_source_pack_path(
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
    quality_run_id: str,
    source_pack_hash: str,
) -> str:
    if _SHA256_RE.fullmatch(source_pack_hash) is None:
        raise ValueError("source-pack hash is invalid")
    manifest_path = expected_publication_input_manifest_path(
        user_id=user_id,
        thread_id=thread_id,
        build_id=build_id,
        quality_run_id=quality_run_id,
    )
    return manifest_path.removesuffix("input_bundle/manifest.json") + (f"publication/source_pack/{source_pack_hash}.json")


def _artifact_scope_prefix(*, user_id: str, thread_id: str) -> str:
    return f"artifacts/{safe_object_path_segment(user_id, default='user')}/{safe_object_path_segment(thread_id, default='thread')}/"


def _validate_artifact_object_path(
    object_path: str,
    *,
    user_id: str,
    thread_id: str,
) -> None:
    try:
        normalized = normalize_object_path(object_path)
    except ValueError as exc:
        raise ValueError("accepted PPTX path is not a canonical object path") from exc
    prefix = _artifact_scope_prefix(user_id=user_id, thread_id=thread_id)
    if normalized != object_path or not normalized.startswith(prefix) or not normalized.lower().endswith(".pptx"):
        raise ValueError("accepted PPTX path does not match the exact user/thread scope")


class PublicationRequest(_FrozenModel):
    campaign_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    instrument: QualityInstrumentLock
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str | None = Field(default=None, min_length=1, max_length=256)
    build_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    builder_run_id: str | None = Field(default=None, min_length=1, max_length=256)
    parent_builder_trace_id: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$",
    )
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_object_path: str = Field(min_length=1, max_length=4096)
    artifact_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    max_attempts: Literal[3] = 3
    deadline_at: datetime
    quality_max_attempts: Literal[5] = 5
    quality_run_deadline_at: datetime

    @field_validator("deadline_at", "quality_run_deadline_at")
    @classmethod
    def validate_timestamps(cls, value: datetime) -> datetime:
        return _aware_datetime(value)

    @property
    def quality_run_id(self) -> str:
        return derive_quality_run_id(
            artifact_version_id=self.artifact_version_id,
            campaign_id=self.campaign_id,
            instrument=self.instrument,
        )

    @property
    def instrument_identity_hash(self) -> str:
        return canonical_sha256(self.instrument)

    @property
    def input_manifest_object_path(self) -> str:
        return expected_publication_input_manifest_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            quality_run_id=self.quality_run_id,
        )

    def source_pack_object_path(self, source_pack_hash: str) -> str:
        return expected_publication_source_pack_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            quality_run_id=self.quality_run_id,
            source_pack_hash=source_pack_hash,
        )

    @model_validator(mode="after")
    def validate_identity_and_bounds(self) -> Self:
        _validate_instrument(self.instrument)
        identity_segments = (
            (self.user_id, "user"),
            (self.thread_id, "thread"),
            (self.build_id, "build"),
        )
        if any(safe_object_path_segment(value, default=default) != value for value, default in identity_segments):
            raise ValueError("publication identity is not canonical for durable object paths")
        if self.deadline_at > datetime.now(UTC) + _PUBLICATION_HORIZON:
            raise ValueError("publication deadline exceeds the three-minute request horizon")
        if self.quality_run_deadline_at - self.deadline_at != _QUALITY_DEADLINE_OFFSET:
            raise ValueError("quality-run deadline must be exactly twelve minutes after the publication deadline")
        _validate_artifact_object_path(
            self.artifact_object_path,
            user_id=self.user_id,
            thread_id=self.thread_id,
        )
        return self

    def rpc_payload(self) -> dict[str, object]:
        instrument = self.instrument
        return {
            "p_quality_run_id": self.quality_run_id,
            "p_campaign_id": self.campaign_id,
            "p_instrument_schema_version": instrument.schema_version,
            "p_instrument_identity_hash": self.instrument_identity_hash,
            "p_rubric_version": instrument.rubric_version,
            "p_rubric_hash": instrument.rubric_hash,
            "p_prompt_hashes": dict(instrument.prompt_hashes),
            "p_judge_plan_hash": instrument.judge_plan_hash,
            "p_judge_profile_version": instrument.judge_profile_version,
            "p_evidence_preprocessor_version": instrument.evidence_preprocessor_version,
            "p_judge_invoker_version": instrument.judge_invoker_version,
            "p_assessment_schema_versions": dict(instrument.assessment_schema_versions),
            "p_adjudication_policy_hash": instrument.adjudication_policy_hash,
            "p_user_id": self.user_id,
            "p_thread_id": self.thread_id,
            "p_task_id": self.task_id,
            "p_build_id": self.build_id,
            "p_builder_run_id": self.builder_run_id,
            "p_parent_builder_trace_id": self.parent_builder_trace_id,
            "p_logical_artifact_id": self.logical_artifact_id,
            "p_artifact_version_id": self.artifact_version_id,
            "p_manifest_revision": self.manifest_revision,
            "p_artifact_object_path": self.artifact_object_path,
            "p_artifact_hash": self.artifact_hash,
            "p_max_attempts": self.max_attempts,
            "p_deadline_at": self.deadline_at.isoformat(),
            "p_quality_max_attempts": self.quality_max_attempts,
            "p_quality_run_deadline_at": self.quality_run_deadline_at.isoformat(),
        }


class PublicationRecord(_FrozenModel):
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    campaign_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    scope_kind: Literal["canary"]
    instrument_schema_version: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
    instrument_identity_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    rubric_version: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
    rubric_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt_hashes: dict[str, str]
    judge_plan_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    judge_profile_version: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
    evidence_preprocessor_version: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
    judge_invoker_version: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
    assessment_schema_versions: dict[str, str]
    adjudication_policy_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str | None = Field(default=None, min_length=1, max_length=256)
    build_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    builder_run_id: str | None = Field(default=None, min_length=1, max_length=256)
    parent_builder_trace_id: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$",
    )
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_object_path: str = Field(min_length=1, max_length=4096)
    artifact_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_pack_object_path: str | None = Field(default=None, min_length=1, max_length=4096)
    source_pack_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    input_manifest_object_path: str | None = Field(default=None, min_length=1, max_length=4096)
    input_manifest_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    state: PublicationState
    attempt_count: int = Field(ge=0, le=3)
    max_attempts: Literal[3]
    error_count: int = Field(ge=0)
    next_attempt_at: datetime
    deadline_at: datetime
    quality_max_attempts: Literal[5]
    quality_run_deadline_at: datetime
    lease_owner: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
    )
    lease_epoch: int = Field(ge=0)
    lease_expires_at: datetime | None = None
    claim_token: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
    )
    claim_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    last_operation_kind: PublicationOperationKind | None = None
    last_operation_token: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
    )
    last_operation_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    last_error_code: PublicationErrorCode | None = None
    last_error_stage: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_]{0,63}$")
    last_error_at: datetime | None = None
    requested_at: datetime
    started_at: datetime | None = None
    updated_at: datetime
    finished_at: datetime | None = None

    @field_validator(
        "next_attempt_at",
        "deadline_at",
        "quality_run_deadline_at",
        "lease_expires_at",
        "last_error_at",
        "requested_at",
        "started_at",
        "updated_at",
        "finished_at",
    )
    @classmethod
    def validate_timestamps(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _aware_datetime(value)

    @field_validator("prompt_hashes")
    @classmethod
    def validate_prompt_hashes(cls, value: dict[str, str]) -> dict[str, str]:
        if not value or len(value) > 32:
            raise ValueError("prompt hashes are missing or oversized")
        if any(_MAP_KEY_RE.fullmatch(key) is None or _SHA256_RE.fullmatch(digest) is None for key, digest in value.items()):
            raise ValueError("prompt hash map is invalid")
        return value

    @field_validator("assessment_schema_versions")
    @classmethod
    def validate_assessment_versions(cls, value: dict[str, str]) -> dict[str, str]:
        if not value or len(value) > 32:
            raise ValueError("assessment schema versions are missing or oversized")
        if any(_MAP_KEY_RE.fullmatch(key) is None or _VERSION_VALUE_RE.fullmatch(version) is None for key, version in value.items()):
            raise ValueError("assessment schema version map is invalid")
        return value

    @model_validator(mode="after")
    def validate_identity_and_state(self) -> Self:
        instrument = self.instrument_lock()
        _validate_instrument(instrument)
        if canonical_sha256(instrument) != self.instrument_identity_hash:
            raise ValueError("publication instrument hash is inconsistent")
        expected_run_id = derive_quality_run_id(
            artifact_version_id=self.artifact_version_id,
            campaign_id=self.campaign_id,
            instrument=instrument,
        )
        if expected_run_id != self.quality_run_id:
            raise ValueError("publication quality-run ID is inconsistent")
        identity_segments = (
            (self.user_id, "user"),
            (self.thread_id, "thread"),
            (self.build_id, "build"),
        )
        if any(safe_object_path_segment(value, default=default) != value for value, default in identity_segments):
            raise ValueError("publication identity is not canonical")
        try:
            _validate_artifact_object_path(
                self.artifact_object_path,
                user_id=self.user_id,
                thread_id=self.thread_id,
            )
        except ValueError:
            raise ValueError("publication artifact scope is inconsistent") from None
        if self.deadline_at <= self.requested_at:
            raise ValueError("publication deadline must follow its request")
        if self.deadline_at > self.requested_at + _PUBLICATION_HORIZON:
            raise ValueError("publication deadline exceeds its three-minute request horizon")
        if self.quality_run_deadline_at - self.deadline_at != _QUALITY_DEADLINE_OFFSET:
            raise ValueError("quality-run deadline does not preserve the fifteen-minute intent horizon")
        if self.next_attempt_at > self.deadline_at:
            raise ValueError("publication next attempt exceeds its deadline")
        if self.lease_expires_at is not None and self.lease_expires_at > self.deadline_at:
            raise ValueError("publication lease exceeds its deadline")
        lease_shape = self.lease_owner is not None and self.lease_expires_at is not None
        if (self.lease_owner is None) != (self.lease_expires_at is None):
            raise ValueError("publication lease shape is inconsistent")
        if self.state is PublicationState.RUNNING and not lease_shape:
            raise ValueError("running publication is missing its lease")
        if self.state is PublicationState.RUNNING and self.lease_epoch < 1:
            raise ValueError("running publication is missing its lease epoch")
        if self.state is not PublicationState.RUNNING and lease_shape:
            raise ValueError("non-running publication cannot hold a lease")
        if (self.claim_token is None) != (self.claim_hash is None):
            raise ValueError("publication claim replay fence is incomplete")
        if self.state is PublicationState.RUNNING and self.claim_token is None:
            raise ValueError("running publication is missing its claim replay fence")
        if self.state is not PublicationState.RUNNING and self.claim_token is not None:
            raise ValueError("non-running publication cannot retain a claim replay fence")
        operation_fields = (
            self.last_operation_kind,
            self.last_operation_token,
            self.last_operation_hash,
        )
        if any(value is None for value in operation_fields) and any(value is not None for value in operation_fields):
            raise ValueError("publication operation replay fence is incomplete")
        error_fields = (
            self.last_error_code,
            self.last_error_stage,
            self.last_error_at,
        )
        if any(value is None for value in error_fields) and any(value is not None for value in error_fields):
            raise ValueError("publication safe error identity is incomplete")
        source_present = self.source_pack_object_path is not None and self.source_pack_hash is not None
        if (self.source_pack_object_path is None) != (self.source_pack_hash is None):
            raise ValueError("publication source-pack identity is incomplete")
        manifest_present = self.input_manifest_object_path is not None and self.input_manifest_hash is not None
        if (self.input_manifest_object_path is None) != (self.input_manifest_hash is None):
            raise ValueError("publication input-manifest identity is incomplete")
        if self.state is PublicationState.AWAITING_INPUTS and source_present:
            raise ValueError("awaiting publication cannot already have inputs")
        if (
            self.state
            in {
                PublicationState.PENDING,
                PublicationState.RUNNING,
                PublicationState.RETRY_WAIT,
                PublicationState.PUBLISHED,
            }
            and not source_present
        ):
            raise ValueError("publication state requires an immutable source pack")
        terminal = self.state in {PublicationState.PUBLISHED, PublicationState.FAILED}
        if terminal != (self.finished_at is not None):
            raise ValueError("publication terminal timestamp is inconsistent")
        if self.state is PublicationState.FAILED and self.last_error_code is None:
            raise ValueError("failed publication is missing its safe error identity")
        if self.state is PublicationState.PUBLISHED and self.last_operation_kind is not PublicationOperationKind.PROMOTE:
            raise ValueError("published publication is missing its promotion replay fence")
        if (self.state is PublicationState.PUBLISHED) != manifest_present:
            raise ValueError("publication output-manifest state is inconsistent")
        expected_manifest = self.expected_input_manifest_object_path
        if self.input_manifest_object_path is not None and self.input_manifest_object_path != expected_manifest:
            raise ValueError("publication input manifest scope is inconsistent")
        if self.source_pack_object_path is not None:
            expected_source = expected_publication_source_pack_path(
                user_id=self.user_id,
                thread_id=self.thread_id,
                build_id=self.build_id,
                quality_run_id=self.quality_run_id,
                source_pack_hash=self.source_pack_hash or "",
            )
            if self.source_pack_object_path != expected_source:
                raise ValueError("publication source-pack scope is inconsistent")
        return self

    @property
    def expected_input_manifest_object_path(self) -> str:
        return expected_publication_input_manifest_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            quality_run_id=self.quality_run_id,
        )

    def instrument_lock(self) -> QualityInstrumentLock:
        return QualityInstrumentLock.model_validate(
            {
                "schema_version": self.instrument_schema_version,
                "rubric_version": self.rubric_version,
                "rubric_hash": self.rubric_hash,
                "prompt_hashes": self.prompt_hashes,
                "judge_plan_hash": self.judge_plan_hash,
                "judge_profile_version": self.judge_profile_version,
                "evidence_preprocessor_version": self.evidence_preprocessor_version,
                "judge_invoker_version": self.judge_invoker_version,
                "assessment_schema_versions": self.assessment_schema_versions,
                "adjudication_policy_hash": self.adjudication_policy_hash,
            }
        )


class PublicationLease(_FrozenModel):
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    owner: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
    epoch: int = Field(ge=1)

    @classmethod
    def from_record(cls, record: PublicationRecord) -> PublicationLease:
        if record.state is not PublicationState.RUNNING or record.lease_owner is None:
            raise ValueError("publication record does not hold a live lease")
        return cls(quality_run_id=record.quality_run_id, owner=record.lease_owner, epoch=record.lease_epoch)

    def rpc_payload(self) -> dict[str, object]:
        return {
            "p_quality_run_id": self.quality_run_id,
            "p_lease_owner": self.owner,
            "p_lease_epoch": self.epoch,
        }


def _operation_payload(
    *,
    kind: PublicationOperationKind,
    token: str,
    lease: PublicationLease,
    arguments: Mapping[str, object],
) -> dict[str, object]:
    if _OPERATION_TOKEN_RE.fullmatch(token) is None:
        raise ValueError("publication operation token is invalid")
    fingerprint = canonical_sha256(
        {
            "kind": kind,
            "quality_run_id": lease.quality_run_id,
            "lease_owner": lease.owner,
            "lease_epoch": lease.epoch,
            "arguments": dict(arguments),
        }
    )
    return {
        "p_operation_token": token,
        "p_operation_hash": fingerprint,
    }


@runtime_checkable
class DeckQualityPublicationRpcClient(Protocol):
    async def call(self, operation: str, payload: Mapping[str, object]) -> object: ...


class SupabaseDeckQualityPublicationRpcClient:
    def __init__(
        self,
        config: DeckQualityPersistenceConfig,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config
        self._client = client or httpx.AsyncClient(timeout=15.0)
        self._owns_client = client is None

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
            "Content-Type": "application/json",
        }

    async def call(self, operation: str, payload: Mapping[str, object]) -> object:
        try:
            response = await self._client.post(
                f"{self._config.url}/rest/v1/rpc/{operation}",
                headers=self._headers(),
                json=dict(payload),
            )
        except httpx.HTTPError:
            raise DeckQualityPersistenceRpcError(operation) from None
        if response.status_code >= 400:
            raise DeckQualityPersistenceRpcError(operation, status_code=response.status_code) from None
        if not response.content:
            raise DeckQualityPersistenceProtocolError(f"deck quality publication RPC returned no record operation={operation}")
        try:
            return response.json()
        except ValueError:
            raise DeckQualityPersistenceProtocolError(f"deck quality publication RPC returned invalid JSON operation={operation}") from None

    async def probe(self) -> None:
        required = {
            "/rpc/sophia_request_deck_quality_publication",
            "/rpc/sophia_commit_deck_quality_publication_inputs",
            "/rpc/sophia_claim_deck_quality_publications",
            "/rpc/sophia_renew_deck_quality_publication_lease",
            "/rpc/sophia_retry_deck_quality_publication",
            "/rpc/sophia_fail_deck_quality_publication",
            "/rpc/sophia_promote_deck_quality_publication",
            "/rpc/sophia_get_deck_quality_publication",
        }
        try:
            response = await self._client.get(
                f"{self._config.url}/rest/v1/",
                headers={**self._headers(), "Accept": "application/openapi+json"},
            )
        except httpx.HTTPError:
            raise DeckQualityPersistenceRpcError("publication_probe") from None
        if response.status_code >= 400:
            raise DeckQualityPersistenceRpcError(
                "publication_probe",
                status_code=response.status_code,
            ) from None
        try:
            paths = set(response.json()["paths"])
        except (ValueError, KeyError, TypeError):
            raise DeckQualityPersistenceProtocolError("deck quality publication OpenAPI probe was invalid") from None
        if not required.issubset(paths):
            raise DeckQualityPersistenceProtocolError("deck quality publication OpenAPI probe is missing required RPCs")

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


class SupabaseDeckQualityPublicationStore:
    """Service-role-only durable DQ-1 publication outbox API."""

    def __init__(self, rpc_client: DeckQualityPublicationRpcClient) -> None:
        self._rpc = rpc_client

    async def probe(self) -> None:
        probe = getattr(self._rpc, "probe", None)
        if probe is None:
            raise DeckQualityPersistenceProtocolError("deck quality publication RPC client does not support readiness probing")
        await probe()

    async def aclose(self) -> None:
        close = getattr(self._rpc, "aclose", None)
        if close is not None:
            await close()

    async def _records(
        self,
        operation: str,
        payload: Mapping[str, object],
        *,
        maximum: int,
    ) -> tuple[PublicationRecord, ...]:
        raw = await self._rpc.call(operation, payload)
        if not isinstance(raw, list) or len(raw) > maximum:
            raise DeckQualityPersistenceProtocolError(f"deck quality publication response shape invalid operation={operation}")
        records: list[PublicationRecord] = []
        for item in raw:
            if not isinstance(item, dict):
                raise DeckQualityPersistenceProtocolError(f"deck quality publication record invalid operation={operation}")
            try:
                records.append(PublicationRecord.model_validate(item))
            except (TypeError, ValueError):
                raise DeckQualityPersistenceProtocolError(f"deck quality publication record failed validation operation={operation}") from None
        return tuple(records)

    async def _one(self, operation: str, payload: Mapping[str, object]) -> PublicationRecord:
        records = await self._records(operation, payload, maximum=1)
        if len(records) != 1:
            raise DeckQualityPersistenceProtocolError(f"deck quality publication returned no record operation={operation}")
        return records[0]

    async def request(self, request: PublicationRequest) -> PublicationRecord:
        return await self._one("sophia_request_deck_quality_publication", request.rpc_payload())

    async def commit_inputs(
        self,
        publication: PublicationRecord,
        *,
        source_pack_object_path: str,
        source_pack_hash: str,
    ) -> PublicationRecord:
        if _SHA256_RE.fullmatch(source_pack_hash) is None:
            raise ValueError("source-pack hash is invalid")
        expected_source = expected_publication_source_pack_path(
            user_id=publication.user_id,
            thread_id=publication.thread_id,
            build_id=publication.build_id,
            quality_run_id=publication.quality_run_id,
            source_pack_hash=source_pack_hash,
        )
        if source_pack_object_path != expected_source:
            raise ValueError("source-pack path does not match the exact publication scope")
        return await self._one(
            "sophia_commit_deck_quality_publication_inputs",
            {
                "p_quality_run_id": publication.quality_run_id,
                "p_source_pack_object_path": source_pack_object_path,
                "p_source_pack_hash": source_pack_hash,
            },
        )

    async def claim(
        self,
        *,
        lease_owner: str,
        claim_token: str,
        lease_seconds: int = 60,
        limit: int = 1,
    ) -> tuple[PublicationRecord, ...]:
        if _WORKER_ID_RE.fullmatch(lease_owner) is None:
            raise ValueError("lease owner is invalid")
        if _OPERATION_TOKEN_RE.fullmatch(claim_token) is None:
            raise ValueError("claim token is invalid")
        if not 15 <= lease_seconds <= 180:
            raise ValueError("publication lease duration must be between 15 and 180 seconds")
        if not 1 <= limit <= 2:
            raise ValueError("claim limit must be between 1 and 2")
        claim_hash = canonical_sha256(
            {
                "lease_owner": lease_owner,
                "claim_token": claim_token,
                "lease_seconds": lease_seconds,
                "limit": limit,
            }
        )
        records = await self._records(
            "sophia_claim_deck_quality_publications",
            {
                "p_lease_owner": lease_owner,
                "p_claim_token": claim_token,
                "p_claim_hash": claim_hash,
                "p_lease_seconds": lease_seconds,
                "p_limit": limit,
            },
            maximum=limit,
        )
        received_at = datetime.now(UTC)
        if any(
            record.state is not PublicationState.RUNNING
            or record.lease_owner != lease_owner
            or record.lease_epoch < 1
            or record.lease_expires_at is None
            or record.lease_expires_at <= received_at
            or record.claim_token != claim_token
            or record.claim_hash != claim_hash
            for record in records
        ):
            raise DeckQualityPersistenceProtocolError("deck quality publication claim returned an invalid lease")
        quality_run_ids = [record.quality_run_id for record in records]
        if len(set(quality_run_ids)) != len(quality_run_ids):
            raise DeckQualityPersistenceProtocolError("deck quality publication claim returned duplicate leases")
        expected_order = sorted(
            records,
            key=lambda record: (
                record.next_attempt_at,
                record.requested_at,
                record.quality_run_id,
            ),
        )
        if list(records) != expected_order:
            raise DeckQualityPersistenceProtocolError("deck quality publication claim returned leases out of order")
        return records

    async def renew(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        lease_seconds: int = 60,
    ) -> PublicationRecord:
        if not 15 <= lease_seconds <= 180:
            raise ValueError("publication lease duration must be between 15 and 180 seconds")
        arguments = {"lease_seconds": lease_seconds}
        return await self._one(
            "sophia_renew_deck_quality_publication_lease",
            {
                **lease.rpc_payload(),
                **_operation_payload(
                    kind=PublicationOperationKind.RENEW,
                    token=operation_token,
                    lease=lease,
                    arguments=arguments,
                ),
                "p_lease_seconds": lease_seconds,
            },
        )

    async def retry(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        error_code: PublicationErrorCode,
        error_stage: str,
        delay_seconds: int = 15,
    ) -> PublicationRecord:
        if _SAFE_STAGE_RE.fullmatch(error_stage) is None:
            raise ValueError("publication error stage is invalid")
        if not 0 <= delay_seconds <= 180:
            raise ValueError("publication retry delay must be between 0 and 180 seconds")
        arguments = {
            "error_code": error_code.value,
            "error_stage": error_stage,
            "delay_seconds": delay_seconds,
        }
        return await self._one(
            "sophia_retry_deck_quality_publication",
            {
                **lease.rpc_payload(),
                **_operation_payload(
                    kind=PublicationOperationKind.RETRY,
                    token=operation_token,
                    lease=lease,
                    arguments=arguments,
                ),
                "p_error_code": error_code.value,
                "p_error_stage": error_stage,
                "p_delay_seconds": delay_seconds,
            },
        )

    async def fail(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        error_code: PublicationErrorCode,
        error_stage: str,
    ) -> PublicationRecord:
        if _SAFE_STAGE_RE.fullmatch(error_stage) is None:
            raise ValueError("publication error stage is invalid")
        arguments = {"error_code": error_code.value, "error_stage": error_stage}
        return await self._one(
            "sophia_fail_deck_quality_publication",
            {
                **lease.rpc_payload(),
                **_operation_payload(
                    kind=PublicationOperationKind.FAIL,
                    token=operation_token,
                    lease=lease,
                    arguments=arguments,
                ),
                "p_error_code": error_code.value,
                "p_error_stage": error_stage,
            },
        )

    async def promote(
        self,
        lease: PublicationLease,
        *,
        operation_token: str,
        input_manifest_object_path: str,
        input_manifest_hash: str,
    ) -> PublicationRecord:
        if _SHA256_RE.fullmatch(input_manifest_hash) is None:
            raise ValueError("input-manifest hash is invalid")
        if not input_manifest_object_path.endswith(f"/quality/{lease.quality_run_id}/input_bundle/manifest.json"):
            raise ValueError("input-manifest path does not match the immutable quality run")
        arguments = {
            "input_manifest_object_path": input_manifest_object_path,
            "input_manifest_hash": input_manifest_hash,
        }
        return await self._one(
            "sophia_promote_deck_quality_publication",
            {
                **lease.rpc_payload(),
                **_operation_payload(
                    kind=PublicationOperationKind.PROMOTE,
                    token=operation_token,
                    lease=lease,
                    arguments=arguments,
                ),
                "p_input_manifest_object_path": input_manifest_object_path,
                "p_input_manifest_hash": input_manifest_hash,
            },
        )

    async def get(self, quality_run_id: str) -> PublicationRecord | None:
        if _QUALITY_RUN_ID_RE.fullmatch(quality_run_id) is None:
            raise ValueError("quality-run ID is invalid")
        records = await self._records(
            "sophia_get_deck_quality_publication",
            {"p_quality_run_id": quality_run_id},
            maximum=1,
        )
        return records[0] if records else None


def configured_deck_quality_publication_store() -> SupabaseDeckQualityPublicationStore | None:
    config = DeckQualityPersistenceConfig.from_env()
    if config is None:
        return None
    return SupabaseDeckQualityPublicationStore(SupabaseDeckQualityPublicationRpcClient(config))
