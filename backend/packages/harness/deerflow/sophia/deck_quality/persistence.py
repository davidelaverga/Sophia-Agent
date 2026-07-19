from __future__ import annotations

import hashlib
import math
import os
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal, Protocol, Self, runtime_checkable

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock
from deerflow.sophia.storage.supabase_artifact_store import safe_object_path_segment

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAP_KEY_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_VERSION_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")
_WORKER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_CLAIM_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SAFE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_TRACE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}_(?:trace|run)_id$")
_TRACE_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$")
_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,127}$")
_FORBIDDEN_METRIC_KEY_RE = re.compile(r"raw|prompt|image|plan|memory|credential|secret|authorization|provider_payload|exception")
_SAFE_USAGE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*(?:_tokens|_token_count)$")
_STAGE_ARTIFACT_KEYS = frozenset(
    {
        "run",
        "source_snapshot",
        "evidence_manifest",
        "assessment_a_visual",
        "assessment_a_call_intent",
        "assessment_b_mechanical",
        "assessment_c_plan_realization",
        "assessment_c_call_intent",
        "decision",
        "safe_metrics",
    }
)
REQUIRED_TRACE_ID_KEYS = frozenset(
    {
        "quality_trace_id",
        "quality_root_run_id",
        "dispatch_run_id",
        "snapshot_run_id",
        "evidence_run_id",
        "blind_visual_run_id",
        "mechanical_projection_run_id",
        "plan_realization_run_id",
        "adjudicate_run_id",
        "shadow_persist_run_id",
    }
)
_QUALITY_RUN_HORIZON = timedelta(minutes=15)
_TRACE_TERMINAL_GRACE = timedelta(minutes=2)
_SAFE_TRACE_ROOT_KEYS = (
    "schema_version",
    "campaign_id",
    "quality_run_id",
    "build_id",
    "task_id",
    "builder_run_id",
    "parent_builder_run_id",
    "parent_builder_trace_id",
    "logical_artifact_id",
    "artifact_version_id",
    "manifest_revision",
    "artifact_hash",
    "rubric_version",
    "rubric_hash",
    "judge_deployment",
    "judge_provider",
    "judge_model",
    "judge_profile_version",
    "judge_plan_hash",
    "evidence_preprocessor_version",
    "source_commit_sha",
    "gateway_deployed_sha",
    "langgraph_deployed_sha",
)


class DeckQualityPersistenceError(RuntimeError):
    """A fail-closed persistence boundary error with no response payload."""


class DeckQualityPersistenceConfigurationError(DeckQualityPersistenceError):
    pass


class DeckQualityPersistenceProtocolError(DeckQualityPersistenceError):
    pass


class DeckQualityPersistenceRpcError(DeckQualityPersistenceError):
    def __init__(self, operation: str, *, status_code: int | None = None) -> None:
        suffix = f" status={status_code}" if status_code is not None else ""
        super().__init__(f"deck quality persistence RPC failed operation={operation}{suffix}")
        self.operation = operation
        self.status_code = status_code


class QualityRunStage(StrEnum):
    REQUESTED = "requested"
    SNAPSHOT_LOADED = "snapshot_loaded"
    EVIDENCE_PREPARED = "evidence_prepared"
    BLIND_ASSESSED = "blind_assessed"
    MECHANICAL_PROJECTED = "mechanical_projected"
    PLAN_REALIZATION_ASSESSED = "plan_realization_assessed"
    ADJUDICATED = "adjudicated"
    PERSISTED_AND_TRACED = "persisted_and_traced"


STAGE_RANK: dict[QualityRunStage, int] = {
    QualityRunStage.REQUESTED: 0,
    QualityRunStage.SNAPSHOT_LOADED: 10,
    QualityRunStage.EVIDENCE_PREPARED: 20,
    QualityRunStage.BLIND_ASSESSED: 30,
    QualityRunStage.MECHANICAL_PROJECTED: 40,
    QualityRunStage.PLAN_REALIZATION_ASSESSED: 50,
    QualityRunStage.ADJUDICATED: 60,
    QualityRunStage.PERSISTED_AND_TRACED: 70,
}

STAGE_ARTIFACT_KEY: dict[QualityRunStage, str] = {
    QualityRunStage.SNAPSHOT_LOADED: "source_snapshot",
    QualityRunStage.EVIDENCE_PREPARED: "evidence_manifest",
    QualityRunStage.BLIND_ASSESSED: "assessment_a_visual",
    QualityRunStage.MECHANICAL_PROJECTED: "assessment_b_mechanical",
    QualityRunStage.PLAN_REALIZATION_ASSESSED: "assessment_c_plan_realization",
    QualityRunStage.ADJUDICATED: "decision",
}


class QualityRunTerminalState(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"
    STALE = "stale"


class QualityRunErrorCode(StrEnum):
    JUDGE_UNAVAILABLE = "judge_unavailable"
    COVERAGE_ERROR = "coverage_error"
    STRUCTURED_OUTPUT_INVALID = "structured_output_invalid"
    ARTIFACT_SNAPSHOT_STALE = "artifact_snapshot_stale"
    QUALITY_PERSISTENCE_ERROR = "quality_persistence_error"
    SHADOW_DISPATCH_UNAVAILABLE = "shadow_dispatch_unavailable"
    RUN_DEADLINE_EXCEEDED = "run_deadline_exceeded"
    ATTEMPT_LIMIT_EXHAUSTED = "attempt_limit_exhausted"


class QualityRunDecision(StrEnum):
    FAILED_TO_JUDGE = "failed_to_judge"
    MECHANICALLY_INVALID = "mechanically_invalid"
    NEEDS_REVISION = "needs_revision"
    NEEDS_USER_REVIEW = "needs_user_review"
    SATISFIED = "satisfied"


QualityRunState = Literal[
    "pending",
    "running",
    "retry_wait",
    "finalizing",
    "completed",
    "failed",
    "stale",
]
DispatchIntentStatus = Literal["prepared", "unresolved", "confirmed", "reconciled"]


def _instrument_identity_hash(instrument: QualityInstrumentLock) -> str:
    return canonical_sha256(instrument)


def _safe_metrics(value: Mapping[str, object] | None) -> dict[str, int | float | bool | None]:
    result: dict[str, int | float | bool | None] = {}
    for key, metric in dict(value or {}).items():
        forbidden_token_key = isinstance(key, str) and "token" in key and _SAFE_USAGE_KEY_RE.fullmatch(key) is None
        if not isinstance(key, str) or _SAFE_KEY_RE.fullmatch(key) is None or _FORBIDDEN_METRIC_KEY_RE.search(key) is not None or forbidden_token_key:
            raise ValueError("safe metric key is not permitted")
        if metric is None or isinstance(metric, bool):
            result[key] = metric
        elif isinstance(metric, int):
            result[key] = metric
        elif isinstance(metric, (float, Decimal)):
            number = float(metric)
            if not math.isfinite(number):
                raise ValueError("safe metric values must be finite")
            result[key] = number
        else:
            raise ValueError("safe metrics may contain only numeric, boolean, or null values")
    if len(result) > 64:
        raise ValueError("safe metrics exceed the bounded key count")
    return result


def _safe_trace_ids(value: Mapping[str, object] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, trace_id in dict(value or {}).items():
        if not isinstance(key, str) or _TRACE_KEY_RE.fullmatch(key) is None or not isinstance(trace_id, str) or _TRACE_VALUE_RE.fullmatch(trace_id) is None:
            raise ValueError("trace ID map is not permitted")
        result[key] = trace_id
    if len(result) > 32:
        raise ValueError("trace ID map exceeds the bounded key count")
    return result


def _completion_trace_ids(value: Mapping[str, object] | None) -> dict[str, str]:
    result = _safe_trace_ids(value)
    if not REQUIRED_TRACE_ID_KEYS.issubset(result):
        raise ValueError("completion trace ID map is incomplete")
    if result["quality_trace_id"] != result["quality_root_run_id"]:
        raise ValueError("completion trace root IDs do not match")
    return result


def _safe_trace_root_input(value: Mapping[str, object] | None) -> dict[str, object] | None:
    if value is None:
        return None
    from deerflow.sophia.deck_quality.tracing import SafeQualityTraceRootInput

    root = SafeQualityTraceRootInput.model_validate(dict(value))
    return root.model_dump(mode="json")


def safe_trace_root_input_hash(value: Mapping[str, object]) -> str:
    """Hash the exact safe root fields in a PostgreSQL-reproducible order."""

    root = _safe_trace_root_input(value)
    assert root is not None
    material = "\x1f".join(str(root[key]) for key in _SAFE_TRACE_ROOT_KEYS)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _safe_stage_artifact_hashes(value: Mapping[str, object] | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, digest in dict(value or {}).items():
        if key not in _STAGE_ARTIFACT_KEYS or not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None:
            raise ValueError("stage artifact hash map is not permitted")
        result[key] = digest
    return result


def _safe_codes(values: Sequence[str] | None) -> tuple[str, ...]:
    result = tuple(values or ())
    if len(result) > 64 or any(_CODE_RE.fullmatch(value) is None for value in result):
        raise ValueError("decision failure codes are not permitted")
    if len(set(result)) != len(result):
        raise ValueError("decision failure codes must be unique")
    return result


def _safe_error_stage(value: str) -> str:
    if _SAFE_KEY_RE.fullmatch(value) is None:
        raise ValueError("error stage is not permitted")
    return value


def _expected_input_manifest_path(
    *,
    user_id: str,
    thread_id: str,
    build_id: str,
    quality_run_id: str,
) -> str:
    return (
        f"artifacts/{safe_object_path_segment(user_id, default='user')}/"
        f"{safe_object_path_segment(thread_id, default='thread')}/foundation/"
        f".builder/builds/{safe_object_path_segment(build_id, default='build')}/"
        f"quality/{quality_run_id}/input_bundle/manifest.json"
    )


def _aware_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("quality run timestamp must be timezone-aware")
    return value


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class QualityRunRequest(_FrozenModel):
    campaign_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    instrument: QualityInstrumentLock
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str | None = Field(default=None, min_length=1, max_length=256)
    build_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    builder_run_id: str | None = Field(default=None, min_length=1, max_length=256)
    parent_builder_trace_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$")
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    input_manifest_object_path: str = Field(min_length=1, max_length=4096)
    input_manifest_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    max_attempts: int = Field(ge=1, le=100)
    run_deadline_at: datetime

    @field_validator("run_deadline_at")
    @classmethod
    def validate_run_deadline(cls, value: datetime) -> datetime:
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
        return _instrument_identity_hash(self.instrument)

    @model_validator(mode="after")
    def require_internal_immutable_input_manifest(self) -> Self:
        if not self.instrument.prompt_hashes or not self.instrument.assessment_schema_versions:
            raise ValueError("instrument hash and version maps cannot be empty")
        if any(_MAP_KEY_RE.fullmatch(key) is None for key in self.instrument.prompt_hashes):
            raise ValueError("instrument prompt hash key is invalid")
        if any(_MAP_KEY_RE.fullmatch(key) is None or _VERSION_VALUE_RE.fullmatch(version) is None for key, version in self.instrument.assessment_schema_versions.items()):
            raise ValueError("instrument assessment schema version is invalid")
        identity_segments = (
            (self.user_id, "user"),
            (self.thread_id, "thread"),
            (self.build_id, "build"),
        )
        if any(safe_object_path_segment(value, default=default) != value for value, default in identity_segments):
            raise ValueError("quality run identity is not canonical for durable object paths")
        if self.run_deadline_at > datetime.now(UTC) + _QUALITY_RUN_HORIZON:
            raise ValueError("quality run deadline exceeds the fifteen-minute request horizon")
        expected_path = _expected_input_manifest_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            quality_run_id=self.quality_run_id,
        )
        if self.input_manifest_object_path != expected_path:
            raise ValueError("input manifest path does not match the exact immutable scope")
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
            "p_artifact_hash": self.artifact_hash,
            "p_input_manifest_object_path": self.input_manifest_object_path,
            "p_input_manifest_hash": self.input_manifest_hash,
            "p_max_attempts": self.max_attempts,
            "p_run_deadline_at": self.run_deadline_at.isoformat(),
        }


class QualityRunRecord(_FrozenModel):
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    campaign_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    scope_kind: Literal["canary"]
    instrument_schema_version: str = Field(min_length=1, max_length=128)
    instrument_identity_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    rubric_version: str = Field(min_length=1, max_length=128)
    rubric_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt_hashes: dict[str, str]
    judge_plan_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    judge_profile_version: str = Field(min_length=1, max_length=128)
    evidence_preprocessor_version: str = Field(min_length=1, max_length=128)
    judge_invoker_version: str = Field(min_length=1, max_length=128)
    assessment_schema_versions: dict[str, str]
    adjudication_policy_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    user_id: str = Field(min_length=1, max_length=256)
    thread_id: str = Field(min_length=1, max_length=256)
    task_id: str | None = Field(default=None, min_length=1, max_length=256)
    build_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    builder_run_id: str | None = Field(default=None, min_length=1, max_length=256)
    parent_builder_trace_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$")
    logical_artifact_id: str = Field(min_length=1, max_length=256)
    artifact_version_id: str = Field(min_length=1, max_length=256)
    manifest_revision: int = Field(ge=1)
    artifact_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    input_manifest_object_path: str = Field(min_length=1, max_length=4096)
    input_manifest_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    evidence_manifest_object_path: str | None = Field(default=None, min_length=1, max_length=4096)
    evidence_manifest_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    state: QualityRunState
    stage: QualityRunStage
    stage_rank: int = Field(ge=0, le=70)
    attempt_count: int = Field(ge=0)
    max_attempts: int = Field(ge=1, le=100)
    error_count: int = Field(ge=0)
    next_attempt_at: datetime
    run_deadline_at: datetime
    trace_deadline_at: datetime
    lease_owner: str | None = Field(default=None, max_length=128)
    lease_epoch: int = Field(ge=0)
    lease_expires_at: datetime | None = None
    claim_token: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
    )
    claim_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    dispatch_intent_epoch: int | None = Field(default=None, ge=1)
    dispatch_intent_attempt_count: int | None = Field(default=None, ge=0)
    dispatch_intent_token: str | None = Field(
        default=None,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
    )
    dispatch_intent_status: DispatchIntentStatus | None = None
    dispatch_recovery_proof_hash: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    dispatch_intent_at: datetime | None = None
    dispatch_resolved_at: datetime | None = None
    pending_terminal_state: Literal["failed", "stale"] | None = None
    terminal_trace_payload_hash: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    safe_trace_root_input: dict[str, object] | None = None
    safe_trace_root_input_hash: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    completion_owner: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
    completion_token: int | None = Field(default=None, ge=1)
    last_error_code: QualityRunErrorCode | None = None
    last_error_stage: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_]{0,63}$")
    last_error_at: datetime | None = None
    decision_result: QualityRunDecision | None = None
    decision_failure_codes: tuple[str, ...] = ()
    decision_weighted_score: Decimal | None = Field(default=None, ge=0, le=5)
    safe_metrics: dict[str, Any]
    trace_ids: dict[str, str]
    stage_artifact_hashes: dict[str, str]
    requested_at: datetime
    started_at: datetime | None = None
    updated_at: datetime
    finished_at: datetime | None = None

    @field_validator(
        "next_attempt_at",
        "run_deadline_at",
        "trace_deadline_at",
        "lease_expires_at",
        "dispatch_intent_at",
        "dispatch_resolved_at",
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
        for key, digest in value.items():
            if _MAP_KEY_RE.fullmatch(key) is None or _SHA256_RE.fullmatch(digest) is None:
                raise ValueError("prompt hash map is invalid")
        return value

    @field_validator("assessment_schema_versions")
    @classmethod
    def validate_assessment_versions(cls, value: dict[str, str]) -> dict[str, str]:
        if not value or len(value) > 32:
            raise ValueError("assessment schema versions are missing or oversized")
        for key, version in value.items():
            if _MAP_KEY_RE.fullmatch(key) is None or not isinstance(version, str) or _VERSION_VALUE_RE.fullmatch(version) is None:
                raise ValueError("assessment schema version map is invalid")
        return value

    @field_validator("safe_metrics")
    @classmethod
    def validate_safe_metrics(cls, value: dict[str, Any]) -> dict[str, int | float | bool | None]:
        return _safe_metrics(value)

    @field_validator("trace_ids")
    @classmethod
    def validate_trace_ids(cls, value: dict[str, str]) -> dict[str, str]:
        return _safe_trace_ids(value)

    @field_validator("stage_artifact_hashes")
    @classmethod
    def validate_stage_artifact_hashes(cls, value: dict[str, str]) -> dict[str, str]:
        return _safe_stage_artifact_hashes(value)

    @field_validator("safe_trace_root_input")
    @classmethod
    def validate_safe_trace_root_input(
        cls,
        value: dict[str, object] | None,
    ) -> dict[str, object] | None:
        return _safe_trace_root_input(value)

    @field_validator("decision_failure_codes")
    @classmethod
    def validate_failure_codes(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return _safe_codes(value)

    @model_validator(mode="after")
    def validate_identity_and_state(self) -> Self:
        identity_segments = (
            (self.user_id, "user"),
            (self.thread_id, "thread"),
            (self.build_id, "build"),
        )
        if any(safe_object_path_segment(value, default=default) != value for value, default in identity_segments):
            raise ValueError("quality run identity is not canonical")
        if STAGE_RANK[self.stage] != self.stage_rank:
            raise ValueError("quality run stage rank is inconsistent")
        if self.attempt_count > self.max_attempts:
            raise ValueError("quality run attempt count exceeds its persisted cap")
        trace_pending = self.state == "finalizing" and self.pending_terminal_state is not None
        if self.run_deadline_at <= self.requested_at:
            raise ValueError("quality run deadline must follow its request")
        if self.run_deadline_at > self.requested_at + _QUALITY_RUN_HORIZON:
            raise ValueError("quality run deadline exceeds its fifteen-minute request horizon")
        if self.trace_deadline_at != self.run_deadline_at + _TRACE_TERMINAL_GRACE:
            raise ValueError("quality run trace-terminal grace horizon is inconsistent")
        lease_horizon = self.trace_deadline_at if self.state == "finalizing" else self.run_deadline_at
        if self.next_attempt_at > lease_horizon:
            raise ValueError("quality run next attempt exceeds its deadline")
        if self.lease_expires_at is not None and self.lease_expires_at > lease_horizon:
            raise ValueError("quality run lease exceeds its deadline")
        leased = self.lease_owner is not None and self.lease_expires_at is not None
        if (self.lease_owner is None) != (self.lease_expires_at is None):
            raise ValueError("quality run lease shape is inconsistent")
        if self.state == "running" and not leased:
            raise ValueError("running quality run is missing its lease")
        if leased and self.lease_epoch < 1:
            raise ValueError("leased quality run is missing its lease epoch")
        if self.state not in {"running", "finalizing"} and leased:
            raise ValueError("non-running quality run cannot hold a lease")
        if (self.claim_token is None) != (self.claim_hash is None):
            raise ValueError("quality run claim replay fence is incomplete")
        if leased != (self.claim_token is not None):
            raise ValueError("quality run lease and claim replay fence disagree")
        dispatch_fields = (
            self.dispatch_intent_epoch,
            self.dispatch_intent_attempt_count,
            self.dispatch_intent_token,
            self.dispatch_recovery_proof_hash,
            self.dispatch_intent_at,
        )
        if self.dispatch_intent_status is None:
            if any(value is not None for value in dispatch_fields) or self.dispatch_resolved_at is not None:
                raise ValueError("quality run dispatch intent shape is inconsistent")
        else:
            if any(
                value is None
                for value in (
                    self.dispatch_intent_epoch,
                    self.dispatch_intent_attempt_count,
                    self.dispatch_intent_token,
                    self.dispatch_intent_at,
                )
            ):
                raise ValueError("quality run dispatch intent is incomplete")
            assert self.dispatch_intent_epoch is not None
            assert self.dispatch_intent_attempt_count is not None
            assert self.dispatch_intent_at is not None
            if self.dispatch_intent_epoch > self.lease_epoch:
                raise ValueError("quality run dispatch intent exceeds the lease epoch")
            if self.dispatch_intent_attempt_count > self.max_attempts:
                raise ValueError("quality run dispatch intent exceeds the attempt cap")
            if self.dispatch_intent_status in {"confirmed", "reconciled"}:
                if self.dispatch_resolved_at is None or self.dispatch_resolved_at < self.dispatch_intent_at:
                    raise ValueError("confirmed quality dispatch is missing its resolution")
            elif self.dispatch_resolved_at is not None:
                raise ValueError("unconfirmed quality dispatch has a resolution timestamp")
        terminal = self.state in {"completed", "failed", "stale"}
        if terminal != (self.finished_at is not None):
            raise ValueError("quality run terminal timestamp is inconsistent")
        trace_grace_recovered = (
            self.state in {"failed", "stale"}
            and self.finished_at is not None
            and self.finished_at >= self.trace_deadline_at
            and self.finished_at == self.updated_at
        )
        if (self.completion_owner is None) != (self.completion_token is None):
            raise ValueError("quality run completion fence is incomplete")
        if self.state == "completed" and self.completion_owner is None:
            raise ValueError("completed quality run is missing its completion fence")
        if self.state != "completed" and self.completion_owner is not None:
            raise ValueError("non-completed quality run cannot have a completion fence")
        if self.pending_terminal_state is None:
            if self.terminal_trace_payload_hash is not None:
                raise ValueError("quality run terminal trace hash lacks its precursor")
            if self.state in {"failed", "stale"}:
                raise ValueError("terminal quality failure is missing its immutable precursor")
        else:
            if self.state not in {"finalizing", "failed", "stale"}:
                raise ValueError("quality run terminal precursor is attached to an invalid state")
            if self.last_error_code is None or self.last_error_stage is None or self.last_error_at is None:
                raise ValueError("quality run terminal precursor is missing its safe error identity")
            if self.state in {"failed", "stale"}:
                if self.pending_terminal_state != self.state:
                    raise ValueError("quality run terminal state conflicts with its precursor")
                if (
                    self.terminal_trace_payload_hash is None
                    and not trace_grace_recovered
                ):
                    raise ValueError("terminal quality failure is missing its trace payload hash")
        if (self.safe_trace_root_input is None) != (self.safe_trace_root_input_hash is None):
            raise ValueError("quality run safe trace root binding is incomplete")
        if self.safe_trace_root_input is not None:
            if safe_trace_root_input_hash(self.safe_trace_root_input) != self.safe_trace_root_input_hash:
                raise ValueError("quality run safe trace root hash is inconsistent")
            root = self.safe_trace_root_input
            expected_root_identity = {
                "campaign_id": self.campaign_id,
                "quality_run_id": self.quality_run_id,
                "build_id": self.build_id,
                "task_id": self.task_id or "missing-task",
                "builder_run_id": self.builder_run_id or "missing-builder-run",
                "parent_builder_run_id": self.builder_run_id or "missing-builder-run",
                "parent_builder_trace_id": self.parent_builder_trace_id or "missing-builder-trace",
                "logical_artifact_id": self.logical_artifact_id,
                "artifact_version_id": self.artifact_version_id,
                "manifest_revision": self.manifest_revision,
                "artifact_hash": self.artifact_hash,
                "rubric_version": self.rubric_version,
                "rubric_hash": self.rubric_hash,
                "judge_profile_version": self.judge_profile_version,
                "judge_plan_hash": self.judge_plan_hash,
                "evidence_preprocessor_version": self.evidence_preprocessor_version,
            }
            if any(root.get(key) != expected for key, expected in expected_root_identity.items()):
                raise ValueError("quality run safe trace root identity is inconsistent")
        if (
            self.state in {"completed", "failed", "stale"}
            and self.safe_trace_root_input is None
            and not trace_grace_recovered
        ):
            raise ValueError("terminal quality run is missing its safe trace root binding")
        if self.state == "finalizing" and not trace_pending and self.safe_trace_root_input is None:
            raise ValueError("prepared quality completion is missing its safe trace root binding")
        if (
            self.terminal_trace_payload_hash is not None
            and self.safe_trace_root_input is None
        ):
            raise ValueError("prepared terminal trace is missing its safe root binding")
        if self.state in {"finalizing", "completed"} and not trace_pending:
            if self.decision_result is None:
                raise ValueError("successful quality run is missing its decision")
            if not {"decision", "safe_metrics", "run"}.issubset(self.stage_artifact_hashes):
                raise ValueError("successful quality run is missing prepared artifacts")
            _completion_trace_ids(self.trace_ids)
        if self.state == "finalizing" and not trace_pending:
            if self.stage is not QualityRunStage.ADJUDICATED:
                raise ValueError("finalizing quality run is not durably adjudicated")
        if trace_pending:
            expected_stage = {
                QualityRunErrorCode.RUN_DEADLINE_EXCEEDED: "run_deadline",
                QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED: "attempt_limit",
            }.get(self.last_error_code)
            if expected_stage is not None and self.last_error_stage != expected_stage:
                raise ValueError("trace-pending quality run has inconsistent terminal precursor")
        if self.state == "completed" and self.stage is not QualityRunStage.PERSISTED_AND_TRACED:
            raise ValueError("completed quality run is not persisted and traced")
        if terminal and not trace_grace_recovered:
            _completion_trace_ids(self.trace_ids)
        expected_input_path = _expected_input_manifest_path(
            user_id=self.user_id,
            thread_id=self.thread_id,
            build_id=self.build_id,
            quality_run_id=self.quality_run_id,
        )
        if self.input_manifest_object_path != expected_input_path:
            raise ValueError("quality run input manifest scope is inconsistent")
        evidence_fields_present = self.evidence_manifest_object_path is not None and self.evidence_manifest_hash is not None
        if (self.evidence_manifest_object_path is None) != (self.evidence_manifest_hash is None):
            raise ValueError("quality run evidence manifest identity is incomplete")
        if self.stage_rank >= STAGE_RANK[QualityRunStage.SNAPSHOT_LOADED] and not evidence_fields_present:
            raise ValueError("quality run evidence manifest is required from snapshot_loaded")
        if self.stage_rank < STAGE_RANK[QualityRunStage.SNAPSHOT_LOADED] and evidence_fields_present:
            raise ValueError("quality run evidence manifest cannot precede snapshot_loaded")
        if self.evidence_manifest_object_path is not None:
            expected_evidence_path = self.input_manifest_object_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"
            if self.evidence_manifest_object_path != expected_evidence_path:
                raise ValueError("quality run evidence manifest identity is inconsistent")
        recorded_manifest_hash = self.stage_artifact_hashes.get("evidence_manifest")
        if recorded_manifest_hash is not None and (self.evidence_manifest_hash is None or recorded_manifest_hash != self.evidence_manifest_hash):
            raise ValueError("quality run evidence manifest hash checkpoint is inconsistent")

        instrument = self.instrument_lock()
        if _instrument_identity_hash(instrument) != self.instrument_identity_hash:
            raise ValueError("quality run instrument hash is inconsistent")
        expected_run_id = derive_quality_run_id(
            artifact_version_id=self.artifact_version_id,
            campaign_id=self.campaign_id,
            instrument=instrument,
        )
        if expected_run_id != self.quality_run_id:
            raise ValueError("quality run ID is inconsistent")
        return self

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


class QualityRunLease(_FrozenModel):
    quality_run_id: str = Field(pattern=r"^quality_[0-9a-f]{64}$")
    owner: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
    epoch: int = Field(ge=1)

    @classmethod
    def from_record(cls, record: QualityRunRecord) -> QualityRunLease:
        if record.state not in {"running", "finalizing"} or record.lease_owner is None:
            raise ValueError("quality run record does not hold a live lease")
        return cls(quality_run_id=record.quality_run_id, owner=record.lease_owner, epoch=record.lease_epoch)

    def rpc_payload(self) -> dict[str, object]:
        return {
            "p_quality_run_id": self.quality_run_id,
            "p_lease_owner": self.owner,
            "p_lease_epoch": self.epoch,
        }


@runtime_checkable
class DeckQualityRunRpcClient(Protocol):
    async def call(self, operation: str, payload: Mapping[str, object]) -> object: ...


class SupabaseDeckQualityRunRpcClient:
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
            raise DeckQualityPersistenceProtocolError(f"deck quality persistence RPC returned no record operation={operation}")
        try:
            return response.json()
        except ValueError:
            raise DeckQualityPersistenceProtocolError(f"deck quality persistence RPC returned invalid JSON operation={operation}") from None

    async def probe(self) -> None:
        required = {
            "/rpc/sophia_claim_deck_quality_shadow_runs",
            "/rpc/sophia_begin_deck_quality_shadow_dispatch",
            "/rpc/sophia_resolve_deck_quality_shadow_dispatch",
            "/rpc/sophia_recover_expired_deck_quality_shadow_runs",
            "/rpc/sophia_list_unresolved_deck_quality_shadow_dispatches",
            "/rpc/sophia_renew_deck_quality_shadow_lease",
            "/rpc/sophia_release_deck_quality_shadow_lease",
            "/rpc/sophia_retry_deck_quality_shadow_run",
            "/rpc/sophia_checkpoint_deck_quality_shadow_run",
            "/rpc/sophia_prepare_deck_quality_shadow_failure_trace",
            "/rpc/sophia_prepare_deck_quality_shadow_completion",
            "/rpc/sophia_complete_deck_quality_shadow_after_trace",
            "/rpc/sophia_finish_deck_quality_shadow_run",
            "/rpc/sophia_get_deck_quality_shadow_run",
        }
        try:
            response = await self._client.get(
                f"{self._config.url}/rest/v1/",
                headers={**self._headers(), "Accept": "application/openapi+json"},
            )
        except httpx.HTTPError:
            raise DeckQualityPersistenceRpcError("probe") from None
        if response.status_code >= 400:
            raise DeckQualityPersistenceRpcError("probe", status_code=response.status_code) from None
        try:
            document = response.json()
            paths = set(document["paths"])
        except (ValueError, KeyError, TypeError):
            raise DeckQualityPersistenceProtocolError("deck quality persistence OpenAPI probe was invalid") from None
        if not required.issubset(paths):
            raise DeckQualityPersistenceProtocolError("deck quality persistence OpenAPI probe is missing required RPCs")

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


class SupabaseDeckQualityRunStore:
    """Service-role-only durable DQ-1 request, lease, and run-record API."""

    def __init__(self, rpc_client: DeckQualityRunRpcClient) -> None:
        self._rpc = rpc_client

    async def probe(self) -> None:
        probe = getattr(self._rpc, "probe", None)
        if probe is None:
            raise DeckQualityPersistenceProtocolError("deck quality persistence RPC client does not support readiness probing")
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
    ) -> tuple[QualityRunRecord, ...]:
        raw = await self._rpc.call(operation, payload)
        if not isinstance(raw, list) or len(raw) > maximum:
            raise DeckQualityPersistenceProtocolError(f"deck quality persistence response shape invalid operation={operation}")
        records: list[QualityRunRecord] = []
        for item in raw:
            if not isinstance(item, dict):
                raise DeckQualityPersistenceProtocolError(f"deck quality persistence record invalid operation={operation}")
            try:
                records.append(QualityRunRecord.model_validate(item))
            except (TypeError, ValueError):
                # Pydantic errors include the rejected input. Do not chain them
                # across this boundary where a caller might log the exception.
                raise DeckQualityPersistenceProtocolError(f"deck quality persistence record failed validation operation={operation}") from None
        return tuple(records)

    async def _one(self, operation: str, payload: Mapping[str, object]) -> QualityRunRecord:
        records = await self._records(operation, payload, maximum=1)
        if len(records) != 1:
            raise DeckQualityPersistenceProtocolError(f"deck quality persistence returned no record operation={operation}")
        return records[0]

    async def request(self, request: QualityRunRequest) -> QualityRunRecord:
        return await self._one("sophia_request_deck_quality_shadow_run", request.rpc_payload())

    async def claim(
        self,
        *,
        lease_owner: str,
        claim_token: str,
        lease_seconds: int = 120,
        limit: int = 1,
    ) -> tuple[QualityRunRecord, ...]:
        if _WORKER_ID_RE.fullmatch(lease_owner) is None:
            raise ValueError("lease owner is invalid")
        if _CLAIM_TOKEN_RE.fullmatch(claim_token) is None:
            raise ValueError("claim token is invalid")
        if not 15 <= lease_seconds <= 900:
            raise ValueError("lease duration must be between 15 and 900 seconds")
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
            "sophia_claim_deck_quality_shadow_runs",
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
            record.state not in {"running", "finalizing"}
            or record.lease_owner != lease_owner
            or record.lease_epoch < 1
            or record.lease_expires_at is None
            or record.lease_expires_at <= received_at
            or record.claim_token != claim_token
            or record.claim_hash != claim_hash
            for record in records
        ):
            raise DeckQualityPersistenceProtocolError("deck quality persistence claim returned an unleased record")
        quality_run_ids = [record.quality_run_id for record in records]
        if len(set(quality_run_ids)) != len(quality_run_ids):
            raise DeckQualityPersistenceProtocolError("deck quality persistence claim returned duplicate leases")
        expected_order = sorted(
            records,
            key=lambda record: (
                record.next_attempt_at,
                record.requested_at,
                record.quality_run_id,
            ),
        )
        if list(records) != expected_order:
            raise DeckQualityPersistenceProtocolError("deck quality persistence claim returned leases out of order")
        return records

    async def renew(self, lease: QualityRunLease, *, lease_seconds: int = 120) -> QualityRunRecord:
        if not 15 <= lease_seconds <= 900:
            raise ValueError("lease duration must be between 15 and 900 seconds")
        return await self._one(
            "sophia_renew_deck_quality_shadow_lease",
            {**lease.rpc_payload(), "p_lease_seconds": lease_seconds},
        )

    async def begin_dispatch(
        self,
        lease: QualityRunLease,
        *,
        intent_token: str,
    ) -> QualityRunRecord:
        if _CLAIM_TOKEN_RE.fullmatch(intent_token) is None:
            raise ValueError("dispatch intent token is invalid")
        return await self._one(
            "sophia_begin_deck_quality_shadow_dispatch",
            {
                **lease.rpc_payload(),
                "p_dispatch_intent_token": intent_token,
            },
        )

    async def resolve_dispatch(
        self,
        *,
        quality_run_id: str,
        intent_token: str,
        status: Literal["unresolved", "confirmed", "reconciled"],
    ) -> QualityRunRecord:
        if _CLAIM_TOKEN_RE.fullmatch(intent_token) is None:
            raise ValueError("dispatch intent token is invalid")
        if status not in {"unresolved", "confirmed", "reconciled"}:
            raise ValueError("dispatch intent resolution is invalid")
        return await self._one(
            "sophia_resolve_deck_quality_shadow_dispatch",
            {
                "p_quality_run_id": quality_run_id,
                "p_dispatch_intent_token": intent_token,
                "p_dispatch_intent_status": status,
            },
        )

    async def unresolved_dispatches(self, *, limit: int = 100) -> tuple[str, ...]:
        if not 1 <= limit <= 100:
            raise ValueError("unresolved dispatch limit is invalid")
        raw = await self._rpc.call(
            "sophia_list_unresolved_deck_quality_shadow_dispatches",
            {"p_limit": limit},
        )
        if not isinstance(raw, list) or len(raw) > limit:
            raise DeckQualityPersistenceProtocolError(
                "deck quality unresolved dispatch response shape is invalid"
            )
        quality_run_ids: list[str] = []
        for item in raw:
            if (
                not isinstance(item, dict)
                or set(item) != {"quality_run_id", "dispatch_intent_status"}
                or not isinstance(item["quality_run_id"], str)
                or re.fullmatch(r"quality_[0-9a-f]{64}", item["quality_run_id"])
                is None
                or item["dispatch_intent_status"]
                not in {"prepared", "unresolved", "reconciled", "confirmed"}
            ):
                raise DeckQualityPersistenceProtocolError(
                    "deck quality unresolved dispatch record is invalid"
                )
            quality_run_ids.append(item["quality_run_id"])
        if len(set(quality_run_ids)) != len(quality_run_ids):
            raise DeckQualityPersistenceProtocolError(
                "deck quality unresolved dispatch response contains duplicates"
            )
        return tuple(quality_run_ids)

    async def recover_expired_finalizing(self, *, limit: int = 100) -> int:
        if not 1 <= limit <= 100:
            raise ValueError("expired quality recovery limit is invalid")
        raw = await self._rpc.call(
            "sophia_recover_expired_deck_quality_shadow_runs",
            {"p_limit": limit},
        )
        if (
            isinstance(raw, bool)
            or not isinstance(raw, int)
            or not 0 <= raw <= limit
        ):
            raise DeckQualityPersistenceProtocolError(
                "deck quality expired recovery response is invalid"
            )
        return raw

    async def release(self, lease: QualityRunLease) -> QualityRunRecord:
        return await self._one("sophia_release_deck_quality_shadow_lease", lease.rpc_payload())

    async def retry(
        self,
        lease: QualityRunLease,
        *,
        error_code: QualityRunErrorCode,
        error_stage: str,
        delay_seconds: int = 30,
        max_attempts: int = 5,
    ) -> QualityRunRecord:
        if not 0 <= delay_seconds <= 86400:
            raise ValueError("retry delay must be between 0 and 86400 seconds")
        if not 1 <= max_attempts <= 100:
            raise ValueError("maximum attempts must be between 1 and 100")
        return await self._one(
            "sophia_retry_deck_quality_shadow_run",
            {
                **lease.rpc_payload(),
                "p_error_code": error_code.value,
                "p_error_stage": _safe_error_stage(error_stage),
                "p_delay_seconds": delay_seconds,
                "p_max_attempts": max_attempts,
            },
        )

    async def checkpoint(
        self,
        lease: QualityRunLease,
        *,
        stage: QualityRunStage,
        safe_metrics: Mapping[str, object] | None = None,
        trace_ids: Mapping[str, object] | None = None,
        stage_artifact_hashes: Mapping[str, object] | None = None,
        evidence_manifest_object_path: str | None = None,
        evidence_manifest_hash: str | None = None,
    ) -> QualityRunRecord:
        metrics = _safe_metrics(safe_metrics)
        traces = _safe_trace_ids(trace_ids)
        artifact_hashes = _safe_stage_artifact_hashes(stage_artifact_hashes)
        required_artifact = STAGE_ARTIFACT_KEY.get(stage)
        if required_artifact is None or required_artifact not in artifact_hashes:
            raise ValueError("checkpoint requires the durable artifact hash for its exact stage")
        if stage is QualityRunStage.SNAPSHOT_LOADED:
            if evidence_manifest_object_path is None or evidence_manifest_hash is None:
                raise ValueError("snapshot_loaded checkpoint requires the immutable evidence manifest identity")
            if len(evidence_manifest_object_path) > 4096 or not evidence_manifest_object_path.endswith(f"/quality/{lease.quality_run_id}/evidence_manifest.json"):
                raise ValueError("evidence manifest path does not match the immutable quality run")
            if _SHA256_RE.fullmatch(evidence_manifest_hash) is None:
                raise ValueError("evidence manifest hash is invalid")
        elif evidence_manifest_object_path is not None or evidence_manifest_hash is not None:
            raise ValueError("evidence manifest identity may only be bound at snapshot_loaded")
        return await self._one(
            "sophia_checkpoint_deck_quality_shadow_run",
            {
                **lease.rpc_payload(),
                "p_stage": stage.value,
                "p_safe_metrics": metrics,
                "p_trace_ids": traces,
                "p_stage_artifact_hashes": artifact_hashes,
                "p_evidence_manifest_object_path": evidence_manifest_object_path,
                "p_evidence_manifest_hash": evidence_manifest_hash,
            },
        )

    async def finish(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        terminal_trace_payload_hash: str,
        decision_result: QualityRunDecision | None = None,
        decision_failure_codes: Sequence[str] = (),
        decision_weighted_score: Decimal | float | None = None,
        error_code: QualityRunErrorCode | None = None,
        error_stage: str | None = None,
        safe_metrics: Mapping[str, object] | None = None,
        trace_ids: Mapping[str, object] | None = None,
        stage_artifact_hashes: Mapping[str, object] | None = None,
    ) -> QualityRunRecord:
        if terminal_state is QualityRunTerminalState.COMPLETED:
            raise ValueError("completed quality runs require prepare_completion and complete_after_trace")
        if terminal_state in {QualityRunTerminalState.FAILED, QualityRunTerminalState.STALE} and error_code is None:
            raise ValueError("failed or stale quality runs require a safe error code")
        if _SHA256_RE.fullmatch(terminal_trace_payload_hash) is None:
            raise ValueError("terminal trace payload hash is invalid")
        score = None if decision_weighted_score is None else float(decision_weighted_score)
        if score is not None and (not math.isfinite(score) or not 0 <= score <= 5):
            raise ValueError("decision weighted score must be finite and between 0 and 5")
        return await self._one(
            "sophia_finish_deck_quality_shadow_run",
            {
                **lease.rpc_payload(),
                "p_terminal_state": terminal_state.value,
                "p_terminal_trace_payload_hash": terminal_trace_payload_hash,
                "p_decision_result": decision_result.value if decision_result else None,
                "p_decision_failure_codes": list(_safe_codes(decision_failure_codes)),
                "p_decision_weighted_score": score,
                "p_error_code": error_code.value if error_code else None,
                "p_error_stage": _safe_error_stage(error_stage) if error_stage else None,
                "p_safe_metrics": _safe_metrics(safe_metrics),
                "p_trace_ids": _completion_trace_ids(trace_ids),
                "p_stage_artifact_hashes": _safe_stage_artifact_hashes(stage_artifact_hashes),
            },
        )

    async def prepare_failure_trace(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        error_code: QualityRunErrorCode,
        error_stage: str,
        terminal_trace_payload_hash: str,
        safe_trace_root_input: Mapping[str, object],
    ) -> QualityRunRecord:
        """Persist the immutable safe failure-trace precursor before emission."""

        if terminal_state not in {
            QualityRunTerminalState.FAILED,
            QualityRunTerminalState.STALE,
        }:
            raise ValueError("failure trace precursor requires failed or stale state")
        if _SHA256_RE.fullmatch(terminal_trace_payload_hash) is None:
            raise ValueError("terminal trace payload hash is invalid")
        root_input = _safe_trace_root_input(safe_trace_root_input)
        assert root_input is not None
        return await self._one(
            "sophia_prepare_deck_quality_shadow_failure_trace",
            {
                **lease.rpc_payload(),
                "p_terminal_state": terminal_state.value,
                "p_error_code": error_code.value,
                "p_error_stage": _safe_error_stage(error_stage),
                "p_terminal_trace_payload_hash": terminal_trace_payload_hash,
                "p_safe_trace_root_input": root_input,
                "p_safe_trace_root_input_hash": safe_trace_root_input_hash(root_input),
            },
        )

    async def prepare_completion(
        self,
        lease: QualityRunLease,
        *,
        decision_result: QualityRunDecision,
        decision_failure_codes: Sequence[str] = (),
        decision_weighted_score: Decimal | float | None = None,
        safe_metrics: Mapping[str, object],
        trace_ids: Mapping[str, object],
        stage_artifact_hashes: Mapping[str, object],
        safe_trace_root_input: Mapping[str, object],
    ) -> QualityRunRecord:
        """Durably prepare a successful result while retaining the fenced lease."""

        score = None if decision_weighted_score is None else float(decision_weighted_score)
        if score is not None and (not math.isfinite(score) or not 0 <= score <= 5):
            raise ValueError("decision weighted score must be finite and between 0 and 5")
        artifact_hashes = _safe_stage_artifact_hashes(stage_artifact_hashes)
        if not {"decision", "safe_metrics", "run"}.issubset(artifact_hashes):
            raise ValueError("prepared completion requires decision, safe_metrics, and run hashes")
        root_input = _safe_trace_root_input(safe_trace_root_input)
        assert root_input is not None
        return await self._one(
            "sophia_prepare_deck_quality_shadow_completion",
            {
                **lease.rpc_payload(),
                "p_decision_result": decision_result.value,
                "p_decision_failure_codes": list(_safe_codes(decision_failure_codes)),
                "p_decision_weighted_score": score,
                "p_safe_metrics": _safe_metrics(safe_metrics),
                "p_trace_ids": _completion_trace_ids(trace_ids),
                "p_stage_artifact_hashes": artifact_hashes,
                "p_safe_trace_root_input": root_input,
                "p_safe_trace_root_input_hash": safe_trace_root_input_hash(root_input),
            },
        )

    async def complete_after_trace(self, lease: QualityRunLease) -> QualityRunRecord:
        """Commit completion only after the caller has remotely ACKed the safe trace."""

        return await self._one(
            "sophia_complete_deck_quality_shadow_after_trace",
            lease.rpc_payload(),
        )

    async def get(self, quality_run_id: str) -> QualityRunRecord | None:
        if re.fullmatch(r"quality_[0-9a-f]{64}", quality_run_id) is None:
            raise ValueError("quality run ID is invalid")
        records = await self._records(
            "sophia_get_deck_quality_shadow_run",
            {"p_quality_run_id": quality_run_id},
            maximum=1,
        )
        return records[0] if records else None


class DeckQualityPersistenceConfig(_FrozenModel):
    url: str = Field(min_length=1)
    service_role_key: str = Field(min_length=1)

    @field_validator("url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        if not normalized.startswith(("https://", "http://")):
            raise ValueError("Supabase URL must be HTTP(S)")
        return normalized

    @classmethod
    def from_env(cls) -> DeckQualityPersistenceConfig | None:
        url = (os.getenv("SUPABASE_URL") or "").strip()
        service_role_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if not url and not service_role_key:
            return None
        if not url or not service_role_key:
            raise DeckQualityPersistenceConfigurationError("durable deck quality persistence requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        return cls(url=url, service_role_key=service_role_key)


def configured_deck_quality_run_store() -> SupabaseDeckQualityRunStore | None:
    config = DeckQualityPersistenceConfig.from_env()
    if config is None:
        return None
    return SupabaseDeckQualityRunStore(SupabaseDeckQualityRunRpcClient(config))
