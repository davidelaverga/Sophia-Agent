from __future__ import annotations

import hashlib
import hmac
import re
import tempfile
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from functools import partial
from pathlib import Path, PurePosixPath
from typing import Any, Literal, Protocol, TypedDict

import anyio
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.sophia.deck_quality.adjudicator import adjudicate_shadow_result
from deerflow.sophia.deck_quality.canonical import canonical_json_bytes, canonical_sha256
from deerflow.sophia.deck_quality.cost import (
    SOL_LONG_CONTEXT_INPUT_THRESHOLD,
    SOL_LONG_INPUT_USD_PER_MILLION,
    SOL_LONG_OUTPUT_USD_PER_MILLION,
    SOL_MAX_OUTPUT_TOKENS,
    SOL_PRICING_VERSION,
    SOL_STANDARD_INPUT_USD_PER_MILLION,
    SOL_STANDARD_OUTPUT_USD_PER_MILLION,
    exact_sol_preflight_admitted,
    sol_cost_usd,
    validate_sol_plan_locks,
)
from deerflow.sophia.deck_quality.evidence import (
    brief_scoped_criteria,
    prepare_blind_visual_evidence,
    prepare_plan_realization_evidence,
    prove_coverage,
)
from deerflow.sophia.deck_quality.instrument import DeckQualityRuntimeInstrument
from deerflow.sophia.deck_quality.invoker import (
    MultimodalStructuredModelInvoker,
    QualityInputTokenCount,
    QualityInvocationMetrics,
)
from deerflow.sophia.deck_quality.mechanical import project_mechanical_truth
from deerflow.sophia.deck_quality.messages import (
    DirectEvidenceBudgetError,
    build_blind_visual_messages,
    build_plan_realization_messages,
    validate_blind_visual_direct_evidence,
    validate_plan_realization_direct_evidence,
)
from deerflow.sophia.deck_quality.persistence import (
    STAGE_ARTIFACT_KEY,
    STAGE_RANK,
    QualityRunDecision,
    QualityRunErrorCode,
    QualityRunLease,
    QualityRunRecord,
    QualityRunStage,
    QualityRunTerminalState,
    persisted_decision_weighted_score,
)
from deerflow.sophia.deck_quality.persistence import (
    safe_trace_root_input_hash as compute_safe_trace_root_input_hash,
)
from deerflow.sophia.deck_quality.plan import derive_plan_realization_inputs
from deerflow.sophia.deck_quality.schemas import (
    BlindVisualAssessment,
    MechanicalProjection,
    PlanRealizationAssessment,
    QualityError,
    Sha256,
    ShadowDecision,
)
from deerflow.sophia.deck_quality.snapshot import (
    ImmutableObjectUploader,
    LoadedEvidenceSnapshot,
    PreRenderInputBundleCounts,
    PreRenderInputBundleDescriptor,
    SnapshotConflictError,
    SnapshotCounts,
    SnapshotCoverageError,
    SnapshotDescriptor,
    SnapshotEvidenceManifest,
    SnapshotMissingEvidenceError,
    SnapshotRunIdentity,
    SnapshotStaleError,
    SnapshotUploadError,
    ensure_committed_render_source,
    freeze_and_upload_evidence_snapshot,
    load_evidence_snapshot,
    load_pre_render_input_bundle,
    verify_evidence_manifest_identity,
)
from deerflow.sophia.deck_quality.tracing import (
    REQUIRED_QUALITY_TRACE_OPERATIONS,
    QualityTraceOperation,
    SafeCriterionScore,
    SafeQualityTraceError,
    SafeQualityTraceOperationInput,
    SafeQualityTraceOperationOutput,
    SafeQualityTraceRootInput,
    SafeQualityTraceRootOutput,
    derive_quality_trace_run_identity,
)
from deerflow.sophia.observability import langsmith_tracing_disabled

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,127}$")
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_MAX_IMMUTABLE_JSON_BYTES = 4 * 1024 * 1024


class DeckQualityGraphError(RuntimeError):
    """Content-free graph failure suitable for durable retry classification."""

    def __init__(
        self,
        code: QualityRunErrorCode,
        *,
        stage: str,
        retryable: bool,
    ) -> None:
        self.code = code
        self.stage = stage
        self.retryable = retryable
        super().__init__(f"{code.value}:{stage}")


class DeckQualityGraphTraceRetry(DeckQualityGraphError):
    def __init__(self) -> None:
        super().__init__(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )


class DeckQualityRunStore(Protocol):
    async def renew(
        self,
        lease: QualityRunLease,
        *,
        lease_seconds: int = 120,
    ) -> QualityRunRecord: ...

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
    ) -> QualityRunRecord: ...

    async def finish(
        self,
        lease: QualityRunLease,
        *,
        terminal_state: QualityRunTerminalState,
        decision_result: QualityRunDecision | None = None,
        decision_failure_codes: tuple[str, ...] = (),
        decision_weighted_score: Decimal | float | None = None,
        error_code: QualityRunErrorCode | None = None,
        error_stage: str | None = None,
        safe_metrics: Mapping[str, object] | None = None,
        trace_ids: Mapping[str, object] | None = None,
        stage_artifact_hashes: Mapping[str, object] | None = None,
    ) -> QualityRunRecord: ...

    async def prepare_completion(
        self,
        lease: QualityRunLease,
        *,
        decision_result: QualityRunDecision,
        decision_failure_codes: tuple[str, ...] = (),
        decision_weighted_score: Decimal | float | None = None,
        safe_metrics: Mapping[str, object],
        trace_ids: Mapping[str, object],
        stage_artifact_hashes: Mapping[str, object],
        safe_trace_root_input: Mapping[str, object],
    ) -> QualityRunRecord: ...

    async def complete_after_trace(
        self,
        lease: QualityRunLease,
    ) -> QualityRunRecord: ...

    async def get(self, quality_run_id: str) -> QualityRunRecord | None: ...


class QualityTrace(Protocol):
    @property
    def operation_terminals(self) -> tuple[Any, ...]: ...

    def start_operation(self, operation_input: SafeQualityTraceOperationInput) -> Any: ...

    def finish(self, output: SafeQualityTraceRootOutput) -> None: ...


TraceFactory = Callable[[SafeQualityTraceRootInput], QualityTrace]


@dataclass(frozen=True)
class DeckQualityGraphRuntime:
    """Process-local dependencies. None of these objects enters graph state."""

    instrument: DeckQualityRuntimeInstrument
    store: DeckQualityRunStore
    objects: ImmutableObjectUploader
    canary_user_ids: frozenset[str]
    source_commit_sha: str
    gateway_deployed_sha: str
    langgraph_deployed_sha: str
    trace_factory: TraceFactory
    max_quality_calls: int = 2
    max_quality_cost_usd: Decimal = Decimal("0.60")
    pricing_version: str = SOL_PRICING_VERSION
    long_context_input_threshold: int = SOL_LONG_CONTEXT_INPUT_THRESHOLD
    standard_input_usd_per_million: Decimal = SOL_STANDARD_INPUT_USD_PER_MILLION
    standard_output_usd_per_million: Decimal = SOL_STANDARD_OUTPUT_USD_PER_MILLION
    long_input_usd_per_million: Decimal = SOL_LONG_INPUT_USD_PER_MILLION
    long_output_usd_per_million: Decimal = SOL_LONG_OUTPUT_USD_PER_MILLION
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    invoker: MultimodalStructuredModelInvoker = field(default_factory=MultimodalStructuredModelInvoker)
    materialization_root: Path = Path(tempfile.gettempdir()) / "deerflow-dq1"
    lease_seconds: int = 300
    timeout_seconds: int = 300

    def __post_init__(self) -> None:
        if not self.canary_user_ids:
            raise ValueError("deck quality graph requires an explicit canary set")
        if any(
            _GIT_SHA_RE.fullmatch(value) is None
            for value in (
                self.source_commit_sha,
                self.gateway_deployed_sha,
                self.langgraph_deployed_sha,
            )
        ):
            raise ValueError("deck quality graph requires exact 40-character deployed SHAs")
        if not 15 <= self.lease_seconds <= 900:
            raise ValueError("deck quality lease duration is invalid")
        if not 1 <= self.timeout_seconds <= 300:
            raise ValueError("deck quality timeout is invalid")
        if self.max_quality_calls != 2:
            raise ValueError("deck quality call ceiling is not locked to two")
        if self.max_quality_cost_usd != Decimal("0.60"):
            raise ValueError("deck quality cost ceiling is not locked")
        if self.pricing_version != SOL_PRICING_VERSION:
            raise ValueError("deck quality pricing version is not locked")
        if self.long_context_input_threshold != SOL_LONG_CONTEXT_INPUT_THRESHOLD:
            raise ValueError("deck quality long-context threshold is not locked")
        if (
            self.standard_input_usd_per_million != SOL_STANDARD_INPUT_USD_PER_MILLION
            or self.standard_output_usd_per_million != SOL_STANDARD_OUTPUT_USD_PER_MILLION
            or self.long_input_usd_per_million != SOL_LONG_INPUT_USD_PER_MILLION
            or self.long_output_usd_per_million != SOL_LONG_OUTPUT_USD_PER_MILLION
        ):
            raise ValueError("deck quality pricing rates are not locked")
        validate_sol_plan_locks(self.instrument.plan)


class DeckQualityShadowGraphState(TypedDict, total=False):
    """Only safe identifiers, hashes, counts, statuses, metrics, and lease fields."""

    campaign_id: str
    quality_run_id: str
    build_id: str
    user_id: str
    task_id: str
    builder_run_id: str
    parent_builder_trace_id: str
    logical_artifact_id: str
    artifact_version_id: str
    manifest_revision: int
    lease_owner: str
    lease_epoch: int
    gateway_deployed_sha: str
    stage: str
    stage_rank: int
    stage_artifact_hashes: dict[str, str]
    slide_count: int
    visible_text_slide_count: int
    evidence_object_count: int
    assessment_a_status: str
    assessment_c_status: str
    decision_result: str
    decision_hash: str
    decision_failure_codes: tuple[str, ...]
    safe_metrics: dict[str, int | float | bool | None]
    trace_ids: dict[str, str]
    terminal_state: str


class _FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _PersistedInputTokenCount(_FrozenModel):
    input_tokens: int = Field(ge=0, strict=True)
    payload_hash: Sha256

    @classmethod
    def from_count(cls, value: QualityInputTokenCount) -> _PersistedInputTokenCount:
        return cls(
            input_tokens=value.input_tokens,
            payload_hash=value.payload_hash,
        )

    def as_invocation_count(self) -> QualityInputTokenCount:
        return QualityInputTokenCount(
            input_tokens=self.input_tokens,
            payload_hash=self.payload_hash,
        )


class _PersistedInvocationMetrics(_FrozenModel):
    latency_ms: int = Field(ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    deployment_name: str
    provider: str
    provider_model: str
    route_name: str
    profile_version: str
    plan_hash: Sha256
    preflight_input_tokens: int = Field(ge=0)
    preflight_payload_hash: Sha256
    pricing_version: str
    input_usd_per_million: Decimal = Field(gt=0)
    output_usd_per_million: Decimal = Field(gt=0)
    cost_usd: Decimal = Field(ge=0)

    @classmethod
    def from_invocation(
        cls,
        value: QualityInvocationMetrics,
        runtime: DeckQualityGraphRuntime,
    ) -> _PersistedInvocationMetrics:
        if (
            type(value.input_tokens) is not int
            or type(value.output_tokens) is not int
            or type(value.total_tokens) is not int
            or type(value.preflight_input_tokens) is not int
            or value.total_tokens != value.input_tokens + value.output_tokens
            or value.preflight_input_tokens != value.input_tokens
            or _SHA256_RE.fullmatch(value.preflight_payload_hash) is None
            or value.output_tokens > SOL_MAX_OUTPUT_TOKENS
        ):
            raise ValueError("provider usage is missing or inconsistent")
        long_context = value.input_tokens > SOL_LONG_CONTEXT_INPUT_THRESHOLD
        input_rate = SOL_LONG_INPUT_USD_PER_MILLION if long_context else SOL_STANDARD_INPUT_USD_PER_MILLION
        output_rate = SOL_LONG_OUTPUT_USD_PER_MILLION if long_context else SOL_STANDARD_OUTPUT_USD_PER_MILLION
        cost = sol_cost_usd(
            input_tokens=value.input_tokens,
            output_tokens=value.output_tokens,
        )
        return cls(
            **value.__dict__,
            pricing_version=runtime.pricing_version,
            input_usd_per_million=input_rate,
            output_usd_per_million=output_rate,
            cost_usd=cost,
        )


class _ControlledFailure(_FrozenModel):
    error_code: Literal["judge_unavailable", "structured_output_invalid"]
    retryable: bool = False


class _ProviderCallIntent(_FrozenModel):
    schema_version: Literal["deck-quality-provider-call-intent/v2"] = "deck-quality-provider-call-intent/v2"
    quality_run_id: str
    operation: Literal["assessment_a", "assessment_c"]
    input_hash: Sha256
    preflight_payload_hash: Sha256
    nonce_hash: Sha256


@dataclass(frozen=True)
class _ProviderCallFence:
    should_call: bool
    artifact_hash: str


class _AssessmentAArtifact(_FrozenModel):
    schema_version: Literal["deck-quality-assessment-a-stage/v2"] = "deck-quality-assessment-a-stage/v2"
    input_hash: Sha256
    status: Literal["completed", "error"]
    provider_call_made: bool
    provider_call_ambiguous: bool = False
    cost_admission_rejected: bool = False
    call_intent_hash: Sha256 | None = None
    preflight: _PersistedInputTokenCount | None = None
    plan_preflight: _PersistedInputTokenCount | None = None
    assessment: BlindVisualAssessment | None = None
    metrics: _PersistedInvocationMetrics | None = None
    failure: _ControlledFailure | None = None

    @model_validator(mode="after")
    def align_status(self) -> _AssessmentAArtifact:
        if self.status == "completed" and (self.assessment is None or self.metrics is None or self.failure is not None):
            raise ValueError("completed assessment A artifact is incomplete")
        if self.status == "error" and (self.assessment is not None or self.failure is None):
            raise ValueError("failed assessment A artifact is invalid")
        if self.provider_call_made and (self.provider_call_ambiguous or self.call_intent_hash is None):
            raise ValueError("made assessment A calls require an unambiguous durable intent")
        if self.provider_call_ambiguous and (self.provider_call_made or self.call_intent_hash is None):
            raise ValueError("ambiguous assessment A calls require only a durable intent")
        if self.status == "completed" and not self.provider_call_made:
            raise ValueError("completed assessment A requires a provider call")
        if (self.provider_call_made or self.provider_call_ambiguous) and (self.preflight is None or self.plan_preflight is None):
            raise ValueError("assessment A calls require both exact preflights")
        if self.metrics is not None and (self.preflight is None or self.metrics.preflight_input_tokens != self.preflight.input_tokens or self.metrics.preflight_payload_hash != self.preflight.payload_hash):
            raise ValueError("assessment A usage does not match its preflight")
        if self.cost_admission_rejected and (self.status != "error" or self.provider_call_made or self.provider_call_ambiguous or self.preflight is None or self.plan_preflight is None):
            raise ValueError("assessment A cost rejection is inconsistent")
        return self


class _MechanicalArtifact(_FrozenModel):
    schema_version: Literal["deck-quality-mechanical-stage/v1"] = "deck-quality-mechanical-stage/v1"
    input_hash: Sha256
    projection: MechanicalProjection


class _AssessmentCArtifact(_FrozenModel):
    schema_version: Literal["deck-quality-assessment-c-stage/v2"] = "deck-quality-assessment-c-stage/v2"
    input_hash: Sha256
    status: Literal["completed", "skipped", "error"]
    provider_call_made: bool
    provider_call_ambiguous: bool = False
    cost_admission_rejected: bool = False
    call_intent_hash: Sha256 | None = None
    preflight: _PersistedInputTokenCount | None = None
    assessment: PlanRealizationAssessment | None = None
    metrics: _PersistedInvocationMetrics | None = None
    skip_code: (
        Literal[
            "upstream_error",
            "coverage_incomplete",
            "mechanically_invalid",
        ]
        | None
    ) = None
    failure: _ControlledFailure | None = None

    @model_validator(mode="after")
    def align_status(self) -> _AssessmentCArtifact:
        if self.status == "completed" and (self.assessment is None or self.metrics is None or self.skip_code is not None or self.failure is not None):
            raise ValueError("completed assessment C artifact is incomplete")
        if self.status == "skipped" and (self.assessment is not None or self.metrics is not None or self.skip_code is None or self.failure is not None or self.provider_call_made):
            raise ValueError("skipped assessment C artifact is invalid")
        if self.status == "error" and (self.assessment is not None or self.skip_code is not None or self.failure is None):
            raise ValueError("failed assessment C artifact is invalid")
        if self.provider_call_made and (self.provider_call_ambiguous or self.call_intent_hash is None):
            raise ValueError("made assessment C calls require an unambiguous durable intent")
        if self.provider_call_ambiguous and (self.provider_call_made or self.call_intent_hash is None):
            raise ValueError("ambiguous assessment C calls require only a durable intent")
        if self.status == "completed" and not self.provider_call_made:
            raise ValueError("completed assessment C requires a provider call")
        if self.status == "skipped" and self.call_intent_hash is not None:
            raise ValueError("skipped assessment C cannot have a provider-call intent")
        if (self.provider_call_made or self.provider_call_ambiguous) and self.preflight is None:
            raise ValueError("assessment C calls require an exact preflight")
        if self.metrics is not None and (self.preflight is None or self.metrics.preflight_input_tokens != self.preflight.input_tokens or self.metrics.preflight_payload_hash != self.preflight.payload_hash):
            raise ValueError("assessment C usage does not match its preflight")
        if self.cost_admission_rejected and (self.status != "error" or self.provider_call_made or self.provider_call_ambiguous or self.preflight is None):
            raise ValueError("assessment C cost rejection is inconsistent")
        return self


class _SafeMetricsArtifact(_FrozenModel):
    schema_version: Literal["deck-quality-safe-metrics/v1"] = "deck-quality-safe-metrics/v1"
    quality_run_id: str
    values: dict[str, int | float | bool | None]


class _PreparedRunArtifact(_FrozenModel):
    schema_version: Literal["deck-quality-shadow-run/v2"] = "deck-quality-shadow-run/v2"
    quality_run_id: str
    campaign_id: str
    completion_protocol_state: Literal["prepared_awaiting_trace_ack"] = "prepared_awaiting_trace_ack"
    decision_result: str
    decision_hash: Sha256
    safe_metrics_hash: Sha256
    safe_trace_root_input_hash: Sha256
    trace_ids: dict[str, str]
    stage_artifact_hashes: dict[str, Sha256]


class _TerminalFailureTraceArtifact(_FrozenModel):
    """Content-free deterministic decision record for a pre-adjudication failure."""

    schema_version: Literal["deck-quality-terminal-failure-trace/v1"] = "deck-quality-terminal-failure-trace/v1"
    quality_run_id: str
    terminal_state: Literal["failed", "stale"]
    error_code: str
    error_stage: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    error_operation: QualityTraceOperation
    durable_stage: str
    durable_stage_rank: int = Field(ge=0)
    instrument_identity_hash: Sha256
    input_manifest_hash: Sha256
    evidence_manifest_hash: Sha256 | None = None
    safe_trace_root_input_hash: Sha256
    stage_artifact_hashes: dict[str, Sha256]


_STAGE_FILENAMES: dict[str, str] = {
    "source_snapshot": "source_snapshot.json",
    "assessment_a_visual": "assessment_a_visual.json",
    "assessment_a_call_intent": "assessment_a_call_intent.json",
    "assessment_b_mechanical": "assessment_b_mechanical.json",
    "assessment_c_plan_realization": "assessment_c_plan_realization.json",
    "assessment_c_call_intent": "assessment_c_call_intent.json",
    "decision": "decision.json",
    "safe_metrics": "safe_metrics.json",
    "run": "run.json",
}


class _BoundedEvidenceReader:
    """Permit exactly one read of each immutable snapshot object.

    The manifest was already verified to construct the descriptor, so it is
    served from the preloaded bytes.  Every other source object may be fetched
    once.  This makes an accidental recursive materialization fail closed
    instead of multiplying raw reads and provider preparation work.
    """

    def __init__(
        self,
        delegate: ImmutableObjectUploader,
        *,
        allowed_paths: frozenset[str],
        manifest_path: str,
        manifest_bytes: bytes,
    ) -> None:
        self._delegate = delegate
        self._allowed_paths = allowed_paths
        self._manifest_path = manifest_path
        self._manifest_bytes = manifest_bytes
        self._read_paths: set[str] = set()

    def _claim(self, object_path: str) -> bytes | None:
        if object_path not in self._allowed_paths or object_path in self._read_paths:
            raise RuntimeError("snapshot reader exceeded its immutable object bound")
        self._read_paths.add(object_path)
        if object_path == self._manifest_path:
            return self._manifest_bytes
        return self._delegate.read(object_path)

    def read(self, object_path: str) -> bytes | None:
        return self._claim(object_path)

    def read_bounded(self, object_path: str, *, max_bytes: int) -> bytes | None:
        if object_path not in self._allowed_paths or object_path in self._read_paths:
            raise RuntimeError("snapshot reader exceeded its immutable object bound")
        self._read_paths.add(object_path)
        if object_path == self._manifest_path:
            content = self._manifest_bytes
        else:
            read_bounded = getattr(self._delegate, "read_bounded", None)
            content = read_bounded(object_path, max_bytes=max_bytes) if callable(read_bounded) else self._delegate.read(object_path)
        if content is not None and len(content) > max_bytes:
            raise RuntimeError("snapshot reader exceeded its immutable byte bound")
        return content

    def assert_complete(self) -> None:
        if self._read_paths != self._allowed_paths:
            raise RuntimeError("snapshot reader did not consume the complete evidence set")

    @property
    def read_count(self) -> int:
        return len(self._read_paths)


def _lease(state: DeckQualityShadowGraphState) -> QualityRunLease:
    return QualityRunLease(
        quality_run_id=state["quality_run_id"],
        owner=state["lease_owner"],
        epoch=state["lease_epoch"],
    )


def _assert_safe_identity(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
) -> None:
    _assert_row_scope(runtime, row)
    expected = {
        "campaign_id": row.campaign_id,
        "quality_run_id": row.quality_run_id,
        "build_id": row.build_id,
        "user_id": row.user_id,
        "logical_artifact_id": row.logical_artifact_id,
        "artifact_version_id": row.artifact_version_id,
        "manifest_revision": row.manifest_revision,
    }
    if any(state.get(key) != value for key, value in expected.items()):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="identity",
            retryable=False,
        )
    if state.get("gateway_deployed_sha") != runtime.gateway_deployed_sha:
        raise DeckQualityGraphError(
            QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
            stage="scope",
            retryable=False,
        )


def _assert_row_scope(
    runtime: DeckQualityGraphRuntime,
    row: QualityRunRecord,
) -> None:
    if row.scope_kind != "canary" or row.campaign_id != "DQ-1" or row.user_id not in runtime.canary_user_ids:
        raise DeckQualityGraphError(
            QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
            stage="scope",
            retryable=False,
        )
    if row.instrument_identity_hash != canonical_sha256(runtime.instrument.lock):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="instrument",
            retryable=False,
        )


async def _bootstrap_dispatch_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    """Expand the gateway's four-field envelope from the claimed durable row."""

    if state.get("gateway_deployed_sha") != runtime.gateway_deployed_sha:
        raise DeckQualityGraphError(
            QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE,
            stage="shadow_dispatch",
            retryable=False,
        )
    try:
        lease = _lease(state)
        row = await runtime.store.renew(
            lease,
            lease_seconds=runtime.lease_seconds,
        )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_dispatch",
            retryable=True,
        ) from None
    if row.quality_run_id != lease.quality_run_id or row.lease_owner != lease.owner or row.lease_epoch != lease.epoch:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_dispatch",
            retryable=True,
        )
    _assert_row_scope(runtime, row)
    supplied_identity = {
        "campaign_id": row.campaign_id,
        "build_id": row.build_id,
        "user_id": row.user_id,
        "logical_artifact_id": row.logical_artifact_id,
        "artifact_version_id": row.artifact_version_id,
        "manifest_revision": row.manifest_revision,
    }
    if any(key in state and state[key] != value for key, value in supplied_identity.items()):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="shadow_dispatch",
            retryable=False,
        )
    return {
        "campaign_id": row.campaign_id,
        "quality_run_id": row.quality_run_id,
        "build_id": row.build_id,
        "user_id": row.user_id,
        "task_id": row.task_id or "missing-task",
        "builder_run_id": row.builder_run_id or "missing-builder-run",
        "parent_builder_trace_id": row.parent_builder_trace_id or "missing-builder-trace",
        "logical_artifact_id": row.logical_artifact_id,
        "artifact_version_id": row.artifact_version_id,
        "manifest_revision": row.manifest_revision,
        "lease_owner": lease.owner,
        "lease_epoch": lease.epoch,
        "gateway_deployed_sha": runtime.gateway_deployed_sha,
        **_state_delta(row),
    }


async def _renew(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> QualityRunRecord:
    try:
        row = await runtime.store.renew(
            _lease(state),
            lease_seconds=runtime.lease_seconds,
        )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="lease",
            retryable=True,
        ) from None
    _assert_safe_identity(runtime, state, row)
    if row.lease_owner != state["lease_owner"] or row.lease_epoch != state["lease_epoch"]:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="lease",
            retryable=True,
        )
    return row


def _quality_root(row: QualityRunRecord) -> str:
    manifest_path = row.evidence_manifest_object_path
    if manifest_path is None:
        manifest_path = row.input_manifest_object_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"
    path = PurePosixPath(manifest_path)
    if path.name != "evidence_manifest.json":
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        )
    return path.parent.as_posix()


def _stage_path(row: QualityRunRecord, key: str) -> str:
    return f"{_quality_root(row)}/{_STAGE_FILENAMES[key]}"


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _snapshot_run_identity(row: QualityRunRecord) -> SnapshotRunIdentity:
    return SnapshotRunIdentity(
        campaign_id=row.campaign_id,
        quality_run_id=row.quality_run_id,
        user_id=row.user_id,
        thread_id=row.thread_id,
        task_id=row.task_id or "missing-task",
        build_id=row.build_id,
        builder_run_id=row.builder_run_id or "missing-builder-run",
        parent_builder_trace_id=row.parent_builder_trace_id or "missing-builder-trace",
        logical_artifact_id=row.logical_artifact_id,
        artifact_version_id=row.artifact_version_id,
        manifest_revision=row.manifest_revision,
        input_manifest_object_path=row.input_manifest_object_path,
        input_manifest_hash=row.input_manifest_hash,
    )


def _read_runtime_object_bounded(
    objects: ImmutableObjectUploader,
    object_path: str,
) -> bytes | None:
    read_bounded = getattr(objects, "read_bounded", None)
    content = read_bounded(object_path, max_bytes=_MAX_IMMUTABLE_JSON_BYTES) if callable(read_bounded) else objects.read(object_path)
    if content is not None and len(content) > _MAX_IMMUTABLE_JSON_BYTES:
        raise RuntimeError("immutable JSON object exceeds its byte budget")
    return content


async def _read_object(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    object_path: str,
) -> bytes:
    # Recheck exact current canary membership and renew the epoch-fenced lease
    # immediately before crossing the raw immutable-object boundary.
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    try:
        with langsmith_tracing_disabled():
            content = await anyio.to_thread.run_sync(
                _read_runtime_object_bounded,
                runtime.objects,
                object_path,
            )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="immutable_read",
            retryable=True,
        ) from None
    if not content:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="immutable_read",
            retryable=True,
        )
    return content


async def _read_optional_object(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    object_path: str,
) -> bytes | None:
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    try:
        with langsmith_tracing_disabled():
            return await anyio.to_thread.run_sync(
                _read_runtime_object_bounded,
                runtime.objects,
                object_path,
            )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="immutable_read",
            retryable=True,
        ) from None


async def _recover_uncheckpointed_stage[ModelT: BaseModel](
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    key: str,
    model_type: type[ModelT],
    input_hash: str,
) -> ModelT | None:
    content = await _read_optional_object(
        runtime,
        state,
        row,
        _stage_path(row, key),
    )
    if content is None:
        return None
    artifact = _parse_canonical(content, model_type)
    if getattr(artifact, "input_hash", None) != input_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="orphan_stage_verify",
            retryable=False,
        )
    return artifact


async def _write_immutable(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    object_path: str,
    content: bytes,
) -> str:
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    try:
        with langsmith_tracing_disabled():
            outcome = await anyio.to_thread.run_sync(
                partial(
                    runtime.objects.create_if_absent,
                    object_path,
                    content,
                    content_type="application/json",
                )
            )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="immutable_write",
            retryable=True,
        ) from None
    if outcome == "exists":
        existing = await _read_object(runtime, state, row, object_path)
        if not hmac.compare_digest(_sha256(existing), _sha256(content)):
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="immutable_conflict",
                retryable=False,
            )
    elif outcome != "created":
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="immutable_write",
            retryable=True,
        )
    return _sha256(content)


def _parse_canonical[ModelT: BaseModel](
    content: bytes,
    model_type: type[ModelT],
) -> ModelT:
    try:
        value = model_type.model_validate_json(content)
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="stage_verify",
            retryable=False,
        ) from None
    if canonical_json_bytes(value) != content:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="stage_verify",
            retryable=False,
        )
    return value


async def _read_stage[ModelT: BaseModel](
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    key: str,
    model_type: type[ModelT],
) -> ModelT:
    expected_hash = row.stage_artifact_hashes.get(key)
    if expected_hash is None or _SHA256_RE.fullmatch(expected_hash) is None:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="stage_verify",
            retryable=False,
        )
    content = await _read_object(runtime, state, row, _stage_path(row, key))
    if not hmac.compare_digest(_sha256(content), expected_hash):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="stage_verify",
            retryable=False,
        )
    return _parse_canonical(content, model_type)


async def _checkpoint(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    *,
    stage: QualityRunStage,
    artifact_hash: str,
    safe_metrics: Mapping[str, object] | None = None,
    additional_artifact_hashes: Mapping[str, str] | None = None,
    evidence_manifest_object_path: str | None = None,
    evidence_manifest_hash: str | None = None,
) -> QualityRunRecord:
    await _renew(runtime, state)
    key = STAGE_ARTIFACT_KEY[stage]
    try:
        checkpointed = await runtime.store.checkpoint(
            _lease(state),
            stage=stage,
            safe_metrics=safe_metrics,
            stage_artifact_hashes={
                key: artifact_hash,
                **dict(additional_artifact_hashes or {}),
            },
            evidence_manifest_object_path=evidence_manifest_object_path,
            evidence_manifest_hash=evidence_manifest_hash,
        )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="checkpoint",
            retryable=True,
        ) from None
    _assert_safe_identity(runtime, state, checkpointed)
    if checkpointed.stage_rank < STAGE_RANK[stage]:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="checkpoint",
            retryable=True,
        )
    return checkpointed


def _state_delta(row: QualityRunRecord) -> DeckQualityShadowGraphState:
    return {
        "stage": row.stage.value,
        "stage_rank": row.stage_rank,
        "stage_artifact_hashes": dict(row.stage_artifact_hashes),
        "safe_metrics": dict(row.safe_metrics),
        "trace_ids": dict(row.trace_ids),
    }


async def _descriptor_from_manifest(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
) -> SnapshotDescriptor:
    if row.evidence_manifest_object_path is None or row.evidence_manifest_hash is None:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="snapshot",
            retryable=True,
        )
    manifest_bytes = await _read_object(
        runtime,
        state,
        row,
        row.evidence_manifest_object_path,
    )
    if not hmac.compare_digest(_sha256(manifest_bytes), row.evidence_manifest_hash):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        )
    manifest = _parse_canonical(manifest_bytes, SnapshotEvidenceManifest)
    try:
        verify_evidence_manifest_identity(manifest, _snapshot_run_identity(row))
    except SnapshotStaleError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        ) from None
    return SnapshotDescriptor(
        snapshot_id=row.quality_run_id,
        snapshot_path=row.evidence_manifest_object_path,
        snapshot_hash=row.evidence_manifest_hash,
        counts=SnapshotCounts(
            slide_count=len(manifest.selectors),
            visible_text_slide_count=len(manifest.selectors),
            evidence_object_count=len(manifest.objects) + 4,
        ),
    )


def _descriptor_from_evidence_manifest_bytes(
    row: QualityRunRecord,
    *,
    object_path: str,
    content: bytes,
) -> SnapshotDescriptor:
    manifest = _parse_canonical(content, SnapshotEvidenceManifest)
    try:
        verify_evidence_manifest_identity(manifest, _snapshot_run_identity(row))
    except SnapshotStaleError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        ) from None
    if (
        manifest.quality_run_id != row.quality_run_id
        or manifest.snapshot_id != row.quality_run_id
        or manifest.build_id != row.build_id
        or manifest.artifact_manifest_revision != row.manifest_revision
        or object_path != _quality_root(row) + "/evidence_manifest.json"
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        )
    return SnapshotDescriptor(
        snapshot_id=row.quality_run_id,
        snapshot_path=object_path,
        snapshot_hash=_sha256(content),
        counts=SnapshotCounts(
            slide_count=len(manifest.selectors),
            visible_text_slide_count=len(manifest.selectors),
            evidence_object_count=len(manifest.objects) + 4,
        ),
    )


async def _ensure_evidence_snapshot(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
) -> QualityRunRecord:
    """Materialize render evidence and atomically bind its manifest to the row."""

    if row.stage_rank >= STAGE_RANK[QualityRunStage.SNAPSHOT_LOADED]:
        if row.evidence_manifest_object_path is None or row.evidence_manifest_hash is None:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="snapshot",
                retryable=True,
            )
        return row

    evidence_path = _quality_root(row) + "/evidence_manifest.json"
    existing_manifest = await _read_optional_object(
        runtime,
        state,
        row,
        evidence_path,
    )
    if existing_manifest is not None:
        descriptor = _descriptor_from_evidence_manifest_bytes(
            row,
            object_path=evidence_path,
            content=existing_manifest,
        )
    else:
        input_descriptor = PreRenderInputBundleDescriptor(
            bundle_id=row.quality_run_id,
            manifest_path=row.input_manifest_object_path,
            manifest_hash=row.input_manifest_hash,
            counts=PreRenderInputBundleCounts(),
        )
        _assert_safe_identity(runtime, state, row)
        await _renew(runtime, state)
        runtime.materialization_root.mkdir(parents=True, exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(
                prefix=f"{row.quality_run_id[:20]}-render-",
                dir=runtime.materialization_root,
            ) as directory:
                with langsmith_tracing_disabled():
                    loaded_input = await anyio.to_thread.run_sync(
                        partial(
                            load_pre_render_input_bundle,
                            descriptor=input_descriptor,
                            expected_identity=_snapshot_run_identity(row),
                            reader=runtime.objects,
                            materialization_root=Path(directory),
                        )
                    )
                    render_source = await anyio.to_thread.run_sync(
                        partial(
                            ensure_committed_render_source,
                            loaded_input=loaded_input,
                            uploader=runtime.objects,
                        )
                    )
                    descriptor = await anyio.to_thread.run_sync(
                        partial(
                            freeze_and_upload_evidence_snapshot,
                            metadata=loaded_input.metadata,
                            outputs_root=loaded_input.outputs_root,
                            artifact_virtual_path=loaded_input.artifact_virtual_path,
                            artifact_host_path=loaded_input.artifact_host_path,
                            task_brief=loaded_input.brief,
                            authoritative_mechanical=loaded_input.mechanical_record,
                            uploader=runtime.objects,
                            render_source=render_source,
                        )
                    )
        except (SnapshotConflictError, SnapshotStaleError):
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="snapshot",
                retryable=False,
            ) from None
        except (SnapshotCoverageError, SnapshotMissingEvidenceError):
            raise DeckQualityGraphError(
                QualityRunErrorCode.COVERAGE_ERROR,
                stage="snapshot",
                retryable=False,
            ) from None
        except SnapshotUploadError:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="snapshot",
                retryable=True,
            ) from None
        except Exception:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="snapshot",
                retryable=True,
            ) from None
        if descriptor.snapshot_path != evidence_path:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="snapshot",
                retryable=False,
            )

    descriptor_bytes = canonical_json_bytes(descriptor)
    persisted_hash = await _write_immutable(
        runtime,
        state,
        row,
        object_path=_stage_path(row, "source_snapshot"),
        content=descriptor_bytes,
    )
    return await _checkpoint(
        runtime,
        state,
        stage=QualityRunStage.SNAPSHOT_LOADED,
        artifact_hash=persisted_hash,
        evidence_manifest_object_path=descriptor.snapshot_path,
        evidence_manifest_hash=descriptor.snapshot_hash,
    )


async def _load_descriptor(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
) -> SnapshotDescriptor:
    if row.stage_rank < STAGE_RANK[QualityRunStage.SNAPSHOT_LOADED]:
        return await _descriptor_from_manifest(runtime, state, row)
    return await _read_stage(
        runtime,
        state,
        row,
        key="source_snapshot",
        model_type=SnapshotDescriptor,
    )


async def _bounded_descriptor_reader(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
) -> tuple[SnapshotDescriptor, _BoundedEvidenceReader]:
    evidence_manifest_path = row.evidence_manifest_object_path
    evidence_manifest_hash = row.evidence_manifest_hash
    if evidence_manifest_path is None or evidence_manifest_hash is None:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="snapshot",
            retryable=True,
        )
    manifest_bytes = await _read_object(
        runtime,
        state,
        row,
        evidence_manifest_path,
    )
    if not hmac.compare_digest(_sha256(manifest_bytes), evidence_manifest_hash):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        )
    manifest = _parse_canonical(manifest_bytes, SnapshotEvidenceManifest)
    try:
        verify_evidence_manifest_identity(manifest, _snapshot_run_identity(row))
    except SnapshotStaleError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        ) from None
    derived = SnapshotDescriptor(
        snapshot_id=row.quality_run_id,
        snapshot_path=evidence_manifest_path,
        snapshot_hash=evidence_manifest_hash,
        counts=SnapshotCounts(
            slide_count=len(manifest.selectors),
            visible_text_slide_count=len(manifest.selectors),
            evidence_object_count=len(manifest.objects) + 4,
        ),
    )
    if row.stage_rank >= STAGE_RANK[QualityRunStage.SNAPSHOT_LOADED]:
        descriptor = await _read_stage(
            runtime,
            state,
            row,
            key="source_snapshot",
            model_type=SnapshotDescriptor,
        )
        if descriptor != derived:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="snapshot",
                retryable=False,
            )
    else:
        descriptor = derived
    allowed_paths = frozenset(
        {
            evidence_manifest_path,
            manifest.evidence_bundle_path,
            manifest.artifact.storage_object_path,
            manifest.render_source.manifest_path,
            manifest.render_source.pdf.object_path,
            *(record.object_path for record in manifest.objects),
        }
    )
    if len(allowed_paths) != descriptor.counts.evidence_object_count:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        )
    return descriptor, _BoundedEvidenceReader(
        runtime.objects,
        allowed_paths=allowed_paths,
        manifest_path=evidence_manifest_path,
        manifest_bytes=manifest_bytes,
    )


@asynccontextmanager
async def _loaded_snapshot(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    descriptor: SnapshotDescriptor | None = None,
    existing: LoadedEvidenceSnapshot | None = None,
    reader: ImmutableObjectUploader | None = None,
) -> AsyncIterator[LoadedEvidenceSnapshot]:
    if existing is not None:
        yield existing
        return
    descriptor = descriptor or await _load_descriptor(runtime, state, row)
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    runtime.materialization_root.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(
            prefix=f"{row.quality_run_id[:20]}-",
            dir=runtime.materialization_root,
        ) as directory:
            with langsmith_tracing_disabled():
                loaded = await anyio.to_thread.run_sync(
                    partial(
                        load_evidence_snapshot,
                        descriptor=descriptor,
                        expected_identity=_snapshot_run_identity(row),
                        reader=reader or runtime.objects,
                        materialization_root=Path(directory),
                    )
                )
            if (
                loaded.snapshot.user_id != row.user_id
                or loaded.snapshot.build_id != row.build_id
                or loaded.snapshot.artifact_version_id != row.artifact_version_id
                or loaded.snapshot.artifact_hash != row.artifact_hash
                or loaded.snapshot.logical_artifact_id != row.logical_artifact_id
                or loaded.snapshot.manifest_revision != row.manifest_revision
            ):
                raise DeckQualityGraphError(
                    QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                    stage="snapshot",
                    retryable=False,
                )
            yield loaded
    except DeckQualityGraphError:
        raise
    except (SnapshotConflictError, SnapshotStaleError):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        ) from None
    except SnapshotCoverageError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.COVERAGE_ERROR,
            stage="snapshot",
            retryable=False,
        ) from None
    except SnapshotUploadError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="snapshot",
            retryable=True,
        ) from None
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="snapshot",
            retryable=True,
        ) from None


def _blind_input_hash(
    loaded: LoadedEvidenceSnapshot,
    runtime: DeckQualityGraphRuntime,
) -> str:
    return canonical_sha256(
        {
            "evidence_bundle_hash": loaded.manifest.evidence_bundle_hash,
            "rubric_hash": runtime.instrument.blind_rubric.rubric_hash,
            "prompt_hash": runtime.instrument.prompts.blind_visual.sha256,
            "judge_plan_hash": runtime.instrument.plan.plan_hash,
        }
    )


def _mechanical_input_hash(loaded: LoadedEvidenceSnapshot) -> str:
    return canonical_sha256(
        {
            "mechanical_record_hash": loaded.snapshot.mechanical_record_hash,
            "artifact_hash": loaded.snapshot.artifact_hash,
        }
    )


def _plan_input_hash(
    loaded: LoadedEvidenceSnapshot,
    runtime: DeckQualityGraphRuntime,
) -> str:
    return canonical_sha256(
        {
            "evidence_bundle_hash": loaded.manifest.evidence_bundle_hash,
            "rubric_hash": runtime.instrument.plan_rubric.rubric_hash,
            "prompt_hash": runtime.instrument.prompts.plan_realization.sha256,
            "judge_plan_hash": runtime.instrument.plan.plan_hash,
        }
    )


def _controlled_invocation_failure(error: Exception) -> _ControlledFailure:
    code = getattr(error, "code", None)
    if code not in {"judge_unavailable", "structured_output_invalid"}:
        code = "structured_output_invalid" if isinstance(error, (TypeError, ValueError)) else "judge_unavailable"
    return _ControlledFailure(error_code=code, retryable=False)


def _budget_allows_preflights(
    runtime: DeckQualityGraphRuntime,
    *,
    input_token_counts: tuple[int, ...],
    spent_usd: Decimal,
) -> bool:
    """Use exact provider counts and worst-case outputs before any inference."""

    return exact_sol_preflight_admitted(
        input_token_counts=input_token_counts,
        spent_usd=spent_usd,
        max_calls=runtime.max_quality_calls,
        cost_cap_usd=runtime.max_quality_cost_usd,
    )


def _build_plan_messages(
    runtime: DeckQualityGraphRuntime,
    loaded: LoadedEvidenceSnapshot,
) -> list[Any]:
    plan_inputs = derive_plan_realization_inputs(
        creative_plan=loaded.snapshot.creative_plan,
        design_plan=loaded.snapshot.design_plan,
        selectors=tuple(str(item) for item in loaded.snapshot.renders.selectors),
        explicit_style_constraints=loaded.snapshot.brief.explicit_brand_style_constraints,
    )
    evidence = prepare_plan_realization_evidence(
        loaded.snapshot,
        rubric=runtime.instrument.plan_rubric,
        subject_materials=plan_inputs.subject_materials,
        signature=plan_inputs.signature,
        rhythm=plan_inputs.rhythm,
        commitments=plan_inputs.commitments,
        explicit_style_constraints=plan_inputs.explicit_style_constraints,
    )
    return build_plan_realization_messages(
        evidence,
        runtime.instrument.prompts.plan_realization,
    )


def _remaining_timeout_seconds(
    runtime: DeckQualityGraphRuntime,
    row: QualityRunRecord,
) -> int:
    started_at = row.started_at or row.requested_at
    elapsed = max(0.0, (runtime.clock() - started_at).total_seconds())
    remaining = int(runtime.timeout_seconds - elapsed)
    if remaining < 1:
        raise TimeoutError
    return remaining


def _provider_call_intent(
    row: QualityRunRecord,
    *,
    operation: Literal["assessment_a", "assessment_c"],
    input_hash: str,
    preflight_payload_hash: str,
) -> _ProviderCallIntent:
    return _ProviderCallIntent(
        quality_run_id=row.quality_run_id,
        operation=operation,
        input_hash=input_hash,
        preflight_payload_hash=preflight_payload_hash,
        nonce_hash=canonical_sha256(
            {
                "quality_run_id": row.quality_run_id,
                "operation": operation,
                "input_hash": input_hash,
                "preflight_payload_hash": preflight_payload_hash,
            }
        ),
    )


async def _prepare_provider_call_intent(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    operation: Literal["assessment_a", "assessment_c"],
    input_hash: str,
    preflight_payload_hash: str,
) -> _ProviderCallFence:
    """Return a durable fence and whether this process owns the new call.

    An intent without a canonical result is deliberately ambiguous: the
    provider may have billed and returned immediately before process death.
    Because Responses has no documented idempotency guarantee, a restart must
    never issue that call again.
    """

    key = f"{operation}_call_intent"
    intent = _provider_call_intent(
        row,
        operation=operation,
        input_hash=input_hash,
        preflight_payload_hash=preflight_payload_hash,
    )
    content = canonical_json_bytes(intent)
    expected_hash = _sha256(content)
    existing = await _read_optional_object(
        runtime,
        state,
        row,
        _stage_path(row, key),
    )
    if existing is not None:
        parsed = _parse_canonical(existing, _ProviderCallIntent)
        if parsed != intent or _sha256(existing) != expected_hash:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="provider_call_intent",
                retryable=False,
            )
        recorded_hash = row.stage_artifact_hashes.get(key)
        if recorded_hash is not None and recorded_hash != expected_hash:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="provider_call_intent",
                retryable=False,
            )
        return _ProviderCallFence(
            should_call=False,
            artifact_hash=expected_hash,
        )
    persisted_hash = await _write_immutable(
        runtime,
        state,
        row,
        object_path=_stage_path(row, key),
        content=content,
    )
    return _ProviderCallFence(
        should_call=True,
        artifact_hash=persisted_hash,
    )


async def _load_snapshot_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    row = await _renew(runtime, state)
    descriptor = await _load_descriptor(runtime, state, row)
    async with _loaded_snapshot(
        runtime,
        state,
        row,
        descriptor=descriptor,
    ) as loaded:
        if loaded.descriptor != descriptor:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="snapshot",
                retryable=False,
            )
    descriptor_bytes = canonical_json_bytes(descriptor)
    descriptor_hash = _sha256(descriptor_bytes)
    if row.stage_rank < STAGE_RANK[QualityRunStage.SNAPSHOT_LOADED]:
        persisted_hash = await _write_immutable(
            runtime,
            state,
            row,
            object_path=_stage_path(row, "source_snapshot"),
            content=descriptor_bytes,
        )
        row = await _checkpoint(
            runtime,
            state,
            stage=QualityRunStage.SNAPSHOT_LOADED,
            artifact_hash=persisted_hash,
        )
    elif row.stage_artifact_hashes.get("source_snapshot") != descriptor_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="snapshot",
            retryable=False,
        )
    return {
        **_state_delta(row),
        "slide_count": descriptor.counts.slide_count,
        "visible_text_slide_count": descriptor.counts.visible_text_slide_count,
        "evidence_object_count": descriptor.counts.evidence_object_count,
    }


async def _prepare_evidence_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    row = await _renew(runtime, state)
    async with _loaded_snapshot(runtime, state, row) as loaded:
        _validate_complete_direct_evidence(runtime, loaded)
    # The snapshot freezer writes the canonical evidence manifest last as its
    # commit marker. This node verifies it before the exact-adjacent checkpoint.
    if row.stage_rank < STAGE_RANK[QualityRunStage.EVIDENCE_PREPARED]:
        row = await _checkpoint(
            runtime,
            state,
            stage=QualityRunStage.EVIDENCE_PREPARED,
            artifact_hash=row.evidence_manifest_hash,
        )
    elif row.stage_artifact_hashes.get("evidence_manifest") != row.evidence_manifest_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="evidence",
            retryable=False,
        )
    return _state_delta(row)


def _validate_complete_direct_evidence(
    runtime: DeckQualityGraphRuntime,
    loaded: LoadedEvidenceSnapshot,
) -> None:
    """Validate A and C's complete direct payloads before either call intent."""

    try:
        blind = prepare_blind_visual_evidence(
            loaded.snapshot,
            runtime.instrument.blind_rubric,
        )
        validate_blind_visual_direct_evidence(blind)
        plan_inputs = derive_plan_realization_inputs(
            creative_plan=loaded.snapshot.creative_plan,
            design_plan=loaded.snapshot.design_plan,
            selectors=tuple(str(item) for item in loaded.snapshot.renders.selectors),
            explicit_style_constraints=loaded.snapshot.brief.explicit_brand_style_constraints,
        )
        plan = prepare_plan_realization_evidence(
            loaded.snapshot,
            rubric=runtime.instrument.plan_rubric,
            subject_materials=plan_inputs.subject_materials,
            signature=plan_inputs.signature,
            rhythm=plan_inputs.rhythm,
            commitments=plan_inputs.commitments,
            explicit_style_constraints=plan_inputs.explicit_style_constraints,
        )
        validate_plan_realization_direct_evidence(plan)
    except DirectEvidenceBudgetError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.COVERAGE_ERROR,
            stage="evidence_budget",
            retryable=False,
        ) from None


async def _assessment_a(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    loaded: LoadedEvidenceSnapshot | None = None,
) -> _AssessmentAArtifact:
    if loaded is None:
        async with _loaded_snapshot(runtime, state, row) as owned_snapshot:
            return await _assessment_a(
                runtime,
                state,
                row,
                loaded=owned_snapshot,
            )
    input_hash = _blind_input_hash(loaded, runtime)
    if row.stage_rank >= STAGE_RANK[QualityRunStage.BLIND_ASSESSED]:
        artifact = await _read_stage(
            runtime,
            state,
            row,
            key="assessment_a_visual",
            model_type=_AssessmentAArtifact,
        )
        if artifact.input_hash != input_hash or (artifact.call_intent_hash is not None and row.stage_artifact_hashes.get("assessment_a_call_intent") != artifact.call_intent_hash):
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="assessment_a",
                retryable=False,
            )
        return artifact
    recovered = await _recover_uncheckpointed_stage(
        runtime,
        state,
        row,
        key="assessment_a_visual",
        model_type=_AssessmentAArtifact,
        input_hash=input_hash,
    )
    if recovered is not None:
        return recovered
    evidence = prepare_blind_visual_evidence(
        loaded.snapshot,
        runtime.instrument.blind_rubric,
    )
    try:
        messages = build_blind_visual_messages(
            evidence,
            runtime.instrument.prompts.blind_visual,
        )
        plan_messages = _build_plan_messages(runtime, loaded)
    except DirectEvidenceBudgetError:
        raise DeckQualityGraphError(
            QualityRunErrorCode.COVERAGE_ERROR,
            stage="evidence_budget",
            retryable=False,
        ) from None
    try:
        blind_request = runtime.invoker.prepare_request(
            plan=runtime.instrument.plan,
            schema=BlindVisualAssessment,
            messages=messages,
            campaign_id=row.campaign_id,
            canary_user_id=row.user_id,
        )
        plan_request = runtime.invoker.prepare_request(
            plan=runtime.instrument.plan,
            schema=PlanRealizationAssessment,
            messages=plan_messages,
            campaign_id=row.campaign_id,
            canary_user_id=row.user_id,
        )
    except Exception as error:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            failure=_controlled_invocation_failure(error),
        )
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    try:
        remaining_timeout = _remaining_timeout_seconds(runtime, row)
    except TimeoutError:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            failure=_ControlledFailure(
                error_code="judge_unavailable",
                retryable=False,
            ),
        )
    try:
        blind_count = await runtime.invoker.count_input_tokens(
            request=blind_request,
            timeout_seconds=remaining_timeout,
        )
        if blind_count.payload_hash != blind_request.payload_hash:
            raise ValueError
        preflight = _PersistedInputTokenCount.from_count(blind_count)
    except Exception as error:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            failure=_controlled_invocation_failure(error),
        )
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    try:
        remaining_timeout = _remaining_timeout_seconds(runtime, row)
        plan_count = await runtime.invoker.count_input_tokens(
            request=plan_request,
            timeout_seconds=remaining_timeout,
        )
        if plan_count.payload_hash != plan_request.payload_hash:
            raise ValueError
        plan_preflight = _PersistedInputTokenCount.from_count(plan_count)
    except Exception as error:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            preflight=preflight,
            failure=_controlled_invocation_failure(error),
        )
    if not _budget_allows_preflights(
        runtime,
        input_token_counts=(
            preflight.input_tokens,
            plan_preflight.input_tokens,
        ),
        spent_usd=Decimal("0"),
    ):
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            cost_admission_rejected=True,
            preflight=preflight,
            plan_preflight=plan_preflight,
            failure=_ControlledFailure(
                error_code="judge_unavailable",
                retryable=False,
            ),
        )
    _assert_safe_identity(runtime, state, row)
    await _renew(runtime, state)
    try:
        remaining_timeout = _remaining_timeout_seconds(runtime, row)
    except TimeoutError:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            preflight=preflight,
            plan_preflight=plan_preflight,
            failure=_ControlledFailure(
                error_code="judge_unavailable",
                retryable=False,
            ),
        )
    fence = await _prepare_provider_call_intent(
        runtime,
        state,
        row,
        operation="assessment_a",
        input_hash=input_hash,
        preflight_payload_hash=preflight.payload_hash,
    )
    if not fence.should_call:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=False,
            provider_call_ambiguous=True,
            call_intent_hash=fence.artifact_hash,
            preflight=preflight,
            plan_preflight=plan_preflight,
            failure=_ControlledFailure(
                error_code="judge_unavailable",
                retryable=False,
            ),
        )
    try:
        result = await runtime.invoker.invoke(
            request=blind_request,
            plan=runtime.instrument.plan,
            timeout_seconds=remaining_timeout,
            preflight=preflight.as_invocation_count(),
        )
    except Exception as error:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=True,
            call_intent_hash=fence.artifact_hash,
            preflight=preflight,
            plan_preflight=plan_preflight,
            failure=_controlled_invocation_failure(error),
        )
    try:
        metrics = _PersistedInvocationMetrics.from_invocation(
            result.metrics,
            runtime,
        )
    except Exception as error:
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=True,
            call_intent_hash=fence.artifact_hash,
            preflight=preflight,
            plan_preflight=plan_preflight,
            failure=_controlled_invocation_failure(error),
        )
    if not _budget_allows_preflights(
        runtime,
        input_token_counts=(plan_preflight.input_tokens,),
        spent_usd=metrics.cost_usd,
    ):
        return _AssessmentAArtifact(
            input_hash=input_hash,
            status="error",
            provider_call_made=True,
            call_intent_hash=fence.artifact_hash,
            preflight=preflight,
            plan_preflight=plan_preflight,
            metrics=metrics,
            failure=_ControlledFailure(
                error_code="structured_output_invalid",
                retryable=False,
            ),
        )
    return _AssessmentAArtifact(
        input_hash=input_hash,
        status="completed",
        provider_call_made=True,
        call_intent_hash=fence.artifact_hash,
        preflight=preflight,
        plan_preflight=plan_preflight,
        assessment=result.parsed,
        metrics=metrics,
    )


async def _assess_blind_visual_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    row = await _renew(runtime, state)
    artifact = await _assessment_a(runtime, state, row)
    if row.stage_rank < STAGE_RANK[QualityRunStage.BLIND_ASSESSED]:
        artifact_hash = await _write_immutable(
            runtime,
            state,
            row,
            object_path=_stage_path(row, "assessment_a_visual"),
            content=canonical_json_bytes(artifact),
        )
        row = await _checkpoint(
            runtime,
            state,
            stage=QualityRunStage.BLIND_ASSESSED,
            artifact_hash=artifact_hash,
            additional_artifact_hashes=({"assessment_a_call_intent": artifact.call_intent_hash} if artifact.call_intent_hash is not None else None),
        )
    return {**_state_delta(row), "assessment_a_status": artifact.status}


async def _mechanical(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    loaded: LoadedEvidenceSnapshot | None = None,
) -> _MechanicalArtifact:
    if loaded is None:
        async with _loaded_snapshot(runtime, state, row) as owned_snapshot:
            return await _mechanical(
                runtime,
                state,
                row,
                loaded=owned_snapshot,
            )
    input_hash = _mechanical_input_hash(loaded)
    if row.stage_rank >= STAGE_RANK[QualityRunStage.MECHANICAL_PROJECTED]:
        artifact = await _read_stage(
            runtime,
            state,
            row,
            key="assessment_b_mechanical",
            model_type=_MechanicalArtifact,
        )
        if artifact.input_hash != input_hash:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="mechanical_projection",
                retryable=False,
            )
        return artifact
    return _MechanicalArtifact(
        input_hash=input_hash,
        projection=project_mechanical_truth(loaded.snapshot),
    )


async def _project_mechanical_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    row = await _renew(runtime, state)
    # The A artifact is re-read and verified before B. This enforces the locked
    # invariant even when a process restarts between the two nodes.
    async with _loaded_snapshot(runtime, state, row) as loaded:
        await _assessment_a(runtime, state, row, loaded=loaded)
        artifact = await _mechanical(runtime, state, row, loaded=loaded)
    if row.stage_rank < STAGE_RANK[QualityRunStage.MECHANICAL_PROJECTED]:
        artifact_hash = await _write_immutable(
            runtime,
            state,
            row,
            object_path=_stage_path(row, "assessment_b_mechanical"),
            content=canonical_json_bytes(artifact),
        )
        row = await _checkpoint(
            runtime,
            state,
            stage=QualityRunStage.MECHANICAL_PROJECTED,
            artifact_hash=artifact_hash,
        )
    return _state_delta(row)


async def _assessment_c(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    loaded: LoadedEvidenceSnapshot | None = None,
    visual_stage: _AssessmentAArtifact | None = None,
    mechanical_stage: _MechanicalArtifact | None = None,
) -> _AssessmentCArtifact:
    async with _loaded_snapshot(runtime, state, row, existing=loaded) as loaded:
        if visual_stage is None:
            visual_stage = await _assessment_a(
                runtime,
                state,
                row,
                loaded=loaded,
            )
        if mechanical_stage is None:
            mechanical_stage = await _mechanical(
                runtime,
                state,
                row,
                loaded=loaded,
            )
        input_hash = _plan_input_hash(loaded, runtime)
        if row.stage_rank >= STAGE_RANK[QualityRunStage.PLAN_REALIZATION_ASSESSED]:
            artifact = await _read_stage(
                runtime,
                state,
                row,
                key="assessment_c_plan_realization",
                model_type=_AssessmentCArtifact,
            )
            if artifact.input_hash != input_hash or (artifact.call_intent_hash is not None and row.stage_artifact_hashes.get("assessment_c_call_intent") != artifact.call_intent_hash):
                raise DeckQualityGraphError(
                    QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                    stage="assessment_c",
                    retryable=False,
                )
            return artifact
        recovered = await _recover_uncheckpointed_stage(
            runtime,
            state,
            row,
            key="assessment_c_plan_realization",
            model_type=_AssessmentCArtifact,
            input_hash=input_hash,
        )
        if recovered is not None:
            return recovered
        visual = visual_stage.assessment
        coverage = prove_coverage(loaded.snapshot, visual)
        if visual_stage.status == "error":
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="skipped",
                provider_call_made=False,
                skip_code="upstream_error",
            )
        if not coverage.complete:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="skipped",
                provider_call_made=False,
                skip_code="coverage_incomplete",
            )
        if mechanical_stage.projection.status != "passed":
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="skipped",
                provider_call_made=False,
                skip_code="mechanically_invalid",
            )
        preflight = visual_stage.plan_preflight
        spent_usd = visual_stage.metrics.cost_usd if visual_stage.metrics is not None else Decimal("0")
        if preflight is None or not _budget_allows_preflights(
            runtime,
            input_token_counts=((preflight.input_tokens,) if preflight is not None else ()),
            spent_usd=spent_usd,
        ):
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=False,
                cost_admission_rejected=True,
                preflight=preflight,
                failure=_ControlledFailure(
                    error_code="judge_unavailable",
                    retryable=False,
                ),
            )
        try:
            messages = _build_plan_messages(runtime, loaded)
        except DirectEvidenceBudgetError:
            raise DeckQualityGraphError(
                QualityRunErrorCode.COVERAGE_ERROR,
                stage="evidence_budget",
                retryable=False,
            ) from None
        try:
            plan_request = runtime.invoker.prepare_request(
                plan=runtime.instrument.plan,
                schema=PlanRealizationAssessment,
                messages=messages,
                campaign_id=row.campaign_id,
                canary_user_id=row.user_id,
            )
            if plan_request.payload_hash != preflight.payload_hash:
                raise ValueError
        except Exception as error:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=False,
                preflight=preflight,
                failure=_controlled_invocation_failure(error),
            )
        _assert_safe_identity(runtime, state, row)
        await _renew(runtime, state)
        try:
            remaining_timeout = _remaining_timeout_seconds(runtime, row)
        except TimeoutError:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=False,
                preflight=preflight,
                failure=_ControlledFailure(
                    error_code="judge_unavailable",
                    retryable=False,
                ),
            )
        fence = await _prepare_provider_call_intent(
            runtime,
            state,
            row,
            operation="assessment_c",
            input_hash=input_hash,
            preflight_payload_hash=preflight.payload_hash,
        )
        if not fence.should_call:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=False,
                provider_call_ambiguous=True,
                call_intent_hash=fence.artifact_hash,
                preflight=preflight,
                failure=_ControlledFailure(
                    error_code="judge_unavailable",
                    retryable=False,
                ),
            )
        try:
            result = await runtime.invoker.invoke(
                request=plan_request,
                plan=runtime.instrument.plan,
                timeout_seconds=remaining_timeout,
                preflight=preflight.as_invocation_count(),
            )
        except Exception as error:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=True,
                call_intent_hash=fence.artifact_hash,
                preflight=preflight,
                failure=_controlled_invocation_failure(error),
            )
        try:
            metrics = _PersistedInvocationMetrics.from_invocation(
                result.metrics,
                runtime,
            )
        except Exception as error:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=True,
                call_intent_hash=fence.artifact_hash,
                preflight=preflight,
                failure=_controlled_invocation_failure(error),
            )
        if spent_usd + metrics.cost_usd > runtime.max_quality_cost_usd:
            return _AssessmentCArtifact(
                input_hash=input_hash,
                status="error",
                provider_call_made=True,
                call_intent_hash=fence.artifact_hash,
                preflight=preflight,
                metrics=metrics,
                failure=_ControlledFailure(
                    error_code="structured_output_invalid",
                    retryable=False,
                ),
            )
        return _AssessmentCArtifact(
            input_hash=input_hash,
            status="completed",
            provider_call_made=True,
            call_intent_hash=fence.artifact_hash,
            preflight=preflight,
            assessment=result.parsed,
            metrics=metrics,
        )


async def _assess_or_skip_plan_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    row = await _renew(runtime, state)
    artifact = await _assessment_c(runtime, state, row)
    if row.stage_rank < STAGE_RANK[QualityRunStage.PLAN_REALIZATION_ASSESSED]:
        artifact_hash = await _write_immutable(
            runtime,
            state,
            row,
            object_path=_stage_path(row, "assessment_c_plan_realization"),
            content=canonical_json_bytes(artifact),
        )
        row = await _checkpoint(
            runtime,
            state,
            stage=QualityRunStage.PLAN_REALIZATION_ASSESSED,
            artifact_hash=artifact_hash,
            additional_artifact_hashes=({"assessment_c_call_intent": artifact.call_intent_hash} if artifact.call_intent_hash is not None else None),
        )
    return {**_state_delta(row), "assessment_c_status": artifact.status}


async def _decision(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    loaded: LoadedEvidenceSnapshot | None = None,
    visual_stage: _AssessmentAArtifact | None = None,
    mechanical_stage: _MechanicalArtifact | None = None,
    plan_stage: _AssessmentCArtifact | None = None,
) -> ShadowDecision:
    if row.stage_rank >= STAGE_RANK[QualityRunStage.ADJUDICATED]:
        return await _read_stage(
            runtime,
            state,
            row,
            key="decision",
            model_type=ShadowDecision,
        )
    async with _loaded_snapshot(runtime, state, row, existing=loaded) as loaded:
        if visual_stage is None:
            visual_stage = await _assessment_a(
                runtime,
                state,
                row,
                loaded=loaded,
            )
        if mechanical_stage is None:
            mechanical_stage = await _mechanical(
                runtime,
                state,
                row,
                loaded=loaded,
            )
        if plan_stage is None:
            plan_stage = await _assessment_c(
                runtime,
                state,
                row,
                loaded=loaded,
                visual_stage=visual_stage,
                mechanical_stage=mechanical_stage,
            )
        plan_inputs = derive_plan_realization_inputs(
            creative_plan=loaded.snapshot.creative_plan,
            design_plan=loaded.snapshot.design_plan,
            selectors=tuple(str(item) for item in loaded.snapshot.renders.selectors),
            explicit_style_constraints=loaded.snapshot.brief.explicit_brand_style_constraints,
        )
        errors: list[QualityError] = []
        for stage_name, failure in (
            ("assessment_a", visual_stage.failure),
            ("assessment_c", plan_stage.failure),
        ):
            if failure is not None:
                errors.append(
                    QualityError(
                        code=failure.error_code,
                        stage=stage_name,
                        retryable=failure.retryable,
                    )
                )
        return adjudicate_shadow_result(
            coverage=prove_coverage(loaded.snapshot, visual_stage.assessment),
            visual=visual_stage.assessment,
            mechanical=mechanical_stage.projection,
            plan=plan_stage.assessment,
            criteria=brief_scoped_criteria(
                runtime.instrument.all_criteria,
                loaded.snapshot.brief,
            ),
            expected_plan_commitment_ids=tuple(item.commitment_id for item in plan_inputs.commitments),
            rubric_hash=runtime.instrument.blind_rubric.rubric_hash,
            policy=runtime.instrument.policy,
            machinery_errors=tuple(errors),
        )


async def _adjudicate_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    row = await _renew(runtime, state)
    decision = await _decision(runtime, state, row)
    decision_hash = canonical_sha256(decision)
    if row.stage_rank < STAGE_RANK[QualityRunStage.ADJUDICATED]:
        artifact_hash = await _write_immutable(
            runtime,
            state,
            row,
            object_path=_stage_path(row, "decision"),
            content=canonical_json_bytes(decision),
        )
        row = await _checkpoint(
            runtime,
            state,
            stage=QualityRunStage.ADJUDICATED,
            artifact_hash=artifact_hash,
        )
    elif row.stage_artifact_hashes.get("decision") != decision_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="adjudicate",
            retryable=False,
        )
    return {
        **_state_delta(row),
        "decision_result": decision.result,
        "decision_hash": decision_hash,
        "decision_failure_codes": decision.failure_codes,
    }


def _safe_scores(
    assessment: BlindVisualAssessment | PlanRealizationAssessment,
) -> tuple[SafeCriterionScore, ...]:
    return tuple(
        SafeCriterionScore(
            criterion_id=item.criterion_id,
            applicable=item.applicable,
            score=item.score,
        )
        for item in assessment.criterion_scores
    )


def _safe_failure_codes(values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(value for value in dict.fromkeys(values) if _SAFE_CODE_RE.fullmatch(value) is not None)[:64]


def _safe_metrics(
    runtime: DeckQualityGraphRuntime,
    row: QualityRunRecord,
    visual: _AssessmentAArtifact,
    plan: _AssessmentCArtifact,
    *,
    slide_count: int,
    coverage_complete: bool,
) -> dict[str, int | float | bool | None]:
    a = visual.metrics
    c = plan.metrics
    a_preflight = visual.preflight
    c_preflight = visual.plan_preflight or plan.preflight
    total_cost = (a.cost_usd if a else Decimal("0")) + (c.cost_usd if c else Decimal("0"))
    return {
        "slide_count": slide_count,
        "coverage_complete": coverage_complete,
        "judge_call_count": int(visual.provider_call_made) + int(plan.provider_call_made),
        "assessment_a_preflight_input_tokens": (a_preflight.input_tokens if a_preflight else None),
        "assessment_c_preflight_input_tokens": (c_preflight.input_tokens if c_preflight else None),
        "assessment_a_latency_ms": a.latency_ms if a else None,
        "assessment_a_input_tokens": a.input_tokens if a else None,
        "assessment_a_output_tokens": a.output_tokens if a else None,
        "assessment_a_total_tokens": a.total_tokens if a else None,
        "assessment_c_latency_ms": c.latency_ms if c else None,
        "assessment_c_input_tokens": c.input_tokens if c else None,
        "assessment_c_output_tokens": c.output_tokens if c else None,
        "assessment_c_total_tokens": c.total_tokens if c else None,
        "total_latency_ms": (a.latency_ms if a else 0) + (c.latency_ms if c else 0),
        "total_input_tokens": (a.input_tokens or 0 if a else 0) + (c.input_tokens or 0 if c else 0),
        "total_output_tokens": (a.output_tokens or 0 if a else 0) + (c.output_tokens or 0 if c else 0),
        "total_tokens": (a.total_tokens or 0 if a else 0) + (c.total_tokens or 0 if c else 0),
        "assessment_a_completed": visual.status == "completed",
        "assessment_c_completed": plan.status == "completed",
        "assessment_c_skipped": plan.status == "skipped",
        "quality_cost_usd": float(total_cost),
        "quality_cost_cap_usd": float(runtime.max_quality_cost_usd),
        "max_output_tokens": SOL_MAX_OUTPUT_TOKENS,
        "max_quality_calls": runtime.max_quality_calls,
        "quality_cost_within_cap": total_cost <= runtime.max_quality_cost_usd,
        "quality_cost_admission_rejected": (visual.cost_admission_rejected or plan.cost_admission_rejected),
        "provider_usage_missing": (visual.provider_call_made and a is None) or (plan.provider_call_made and c is None),
        "pricing_long_context_threshold": runtime.long_context_input_threshold,
    }


def _safe_trace_root_input(
    runtime: DeckQualityGraphRuntime,
    row: QualityRunRecord,
    *,
    artifact_hash: str,
) -> SafeQualityTraceRootInput:
    return SafeQualityTraceRootInput(
        campaign_id=row.campaign_id,
        quality_run_id=row.quality_run_id,
        build_id=row.build_id,
        task_id=row.task_id or "missing-task",
        builder_run_id=row.builder_run_id or "missing-builder-run",
        parent_builder_run_id=row.builder_run_id or "missing-builder-run",
        parent_builder_trace_id=row.parent_builder_trace_id or "missing-builder-trace",
        logical_artifact_id=row.logical_artifact_id,
        artifact_version_id=row.artifact_version_id,
        manifest_revision=row.manifest_revision,
        artifact_hash=artifact_hash,
        rubric_version=row.rubric_version,
        rubric_hash=row.rubric_hash,
        judge_deployment=runtime.instrument.plan.deployment_name,
        judge_provider=runtime.instrument.plan.provider,
        judge_model=runtime.instrument.plan.provider_model,
        judge_profile_version=row.judge_profile_version,
        judge_plan_hash=row.judge_plan_hash,
        evidence_preprocessor_version=row.evidence_preprocessor_version,
        source_commit_sha=runtime.source_commit_sha,
        gateway_deployed_sha=runtime.gateway_deployed_sha,
        langgraph_deployed_sha=runtime.langgraph_deployed_sha,
    )


def serialize_safe_trace_root_input(
    root_input: SafeQualityTraceRootInput,
) -> dict[str, object]:
    """Return the exact JSON object accepted by the durable root binding."""

    return root_input.model_dump(mode="json")


def _persisted_safe_trace_root_input(
    row: QualityRunRecord,
) -> SafeQualityTraceRootInput:
    raw_root = row.safe_trace_root_input
    persisted_hash = row.safe_trace_root_input_hash
    if raw_root is None or persisted_hash is None:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="safe_trace_root",
            retryable=True,
        )
    try:
        root_input = SafeQualityTraceRootInput.model_validate(raw_root)
        calculated_hash = compute_safe_trace_root_input_hash(serialize_safe_trace_root_input(root_input))
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="safe_trace_root",
            retryable=True,
        ) from None
    expected_identity: dict[str, object] = {
        "campaign_id": row.campaign_id,
        "quality_run_id": row.quality_run_id,
        "build_id": row.build_id,
        "task_id": row.task_id or "missing-task",
        "builder_run_id": row.builder_run_id or "missing-builder-run",
        "parent_builder_run_id": row.builder_run_id or "missing-builder-run",
        "parent_builder_trace_id": row.parent_builder_trace_id or "missing-builder-trace",
        "logical_artifact_id": row.logical_artifact_id,
        "artifact_version_id": row.artifact_version_id,
        "manifest_revision": row.manifest_revision,
        "artifact_hash": row.artifact_hash,
        "rubric_version": row.rubric_version,
        "rubric_hash": row.rubric_hash,
        "judge_profile_version": row.judge_profile_version,
        "judge_plan_hash": row.judge_plan_hash,
        "evidence_preprocessor_version": row.evidence_preprocessor_version,
    }
    root_payload = serialize_safe_trace_root_input(root_input)
    if not hmac.compare_digest(calculated_hash, persisted_hash) or any(root_payload.get(key) != value for key, value in expected_identity.items()):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="safe_trace_root",
            retryable=True,
        )
    return root_input


def safe_trace_root_input_for_record(
    runtime: DeckQualityGraphRuntime,
    row: QualityRunRecord,
) -> SafeQualityTraceRootInput:
    """Use a durable root once bound; consult deploy-local SHAs only pre-bind."""

    if row.safe_trace_root_input is not None or row.safe_trace_root_input_hash is not None:
        return _persisted_safe_trace_root_input(row)
    return _safe_trace_root_input(
        runtime,
        row,
        artifact_hash=row.artifact_hash,
    )


def _trace_ids(root_input: SafeQualityTraceRootInput) -> dict[str, str]:
    identity = derive_quality_trace_run_identity(root_input)
    names = {
        "deck.quality.shadow.dispatch": "dispatch_run_id",
        "deck.quality.snapshot": "snapshot_run_id",
        "deck.quality.evidence": "evidence_run_id",
        "deck.judge.blind_visual": "blind_visual_run_id",
        "deck.quality.mechanical_projection": "mechanical_projection_run_id",
        "deck.judge.plan_realization": "plan_realization_run_id",
        "deck.quality.adjudicate": "adjudicate_run_id",
        "deck.quality.shadow.persist": "shadow_persist_run_id",
    }
    result = {
        "quality_trace_id": str(identity.root_run_id),
        "quality_root_run_id": str(identity.root_run_id),
    }
    for operation, key in names.items():
        result[key] = str(identity.operation_run_id(operation))  # type: ignore[arg-type]
    return result


def _operation_input(
    *,
    operation: QualityTraceOperation,
    row: QualityRunRecord,
    input_hash: str,
    expected_count: int = 0,
    rendered_count: int = 0,
    prompt_hash: str | None = None,
) -> SafeQualityTraceOperationInput:
    is_judge = operation in {
        "deck.judge.blind_visual",
        "deck.judge.plan_realization",
    }
    return SafeQualityTraceOperationInput(
        operation=operation,
        quality_run_id=row.quality_run_id,
        artifact_version_id=row.artifact_version_id,
        input_hash=input_hash,
        rubric_hash=row.rubric_hash,
        prompt_hash=prompt_hash if is_judge else None,
        judge_plan_hash=row.judge_plan_hash if is_judge else None,
        expected_selector_count=expected_count,
        rendered_selector_count=rendered_count,
    )


def _judge_output(
    *,
    operation: Literal["deck.judge.blind_visual", "deck.judge.plan_realization"],
    artifact_hash: str,
    stage: _AssessmentAArtifact | _AssessmentCArtifact,
) -> SafeQualityTraceOperationOutput:
    if stage.status == "skipped":
        assert isinstance(stage, _AssessmentCArtifact)
        return SafeQualityTraceOperationOutput(
            operation=operation,
            status="skipped",
            latency_ms=0,
            skip_code=stage.skip_code,
        )
    if stage.status == "error":
        assert stage.failure is not None
        safe_stage = "blind_visual" if operation == "deck.judge.blind_visual" else "plan_realization"
        return SafeQualityTraceOperationOutput(
            operation=operation,
            status="error",
            latency_ms=0,
            error=SafeQualityTraceError(
                error_code=stage.failure.error_code,
                stage=safe_stage,
                retryable=stage.failure.retryable,
            ),
        )
    assert stage.metrics is not None and stage.assessment is not None
    metrics = stage.metrics
    if metrics.input_tokens is None or metrics.output_tokens is None or metrics.total_tokens is None:
        raise DeckQualityGraphTraceRetry()
    failure_codes = stage.assessment.deck_failure_codes if isinstance(stage.assessment, BlindVisualAssessment) else stage.assessment.failure_codes
    return SafeQualityTraceOperationOutput(
        operation=operation,
        status="completed",
        output_hash=artifact_hash,
        latency_ms=metrics.latency_ms,
        input_tokens=metrics.input_tokens,
        output_tokens=metrics.output_tokens,
        total_tokens=metrics.total_tokens,
        evaluated_selector_count=len(stage.assessment.evaluated_selectors),
        criterion_scores=_safe_scores(stage.assessment),
        failure_codes=_safe_failure_codes(failure_codes),
    )


def _emit_safe_trace(
    runtime: DeckQualityGraphRuntime,
    *,
    root_input: SafeQualityTraceRootInput,
    operation_inputs: Mapping[QualityTraceOperation, SafeQualityTraceOperationInput],
    operation_outputs: Mapping[QualityTraceOperation, SafeQualityTraceOperationOutput],
    shadow_result: str,
    decision_hash: str,
    total_latency_ms: int,
) -> None:
    try:
        trace = runtime.trace_factory(root_input)
        for operation in REQUIRED_QUALITY_TRACE_OPERATIONS:
            span = trace.start_operation(operation_inputs[operation])
            span.finish(operation_outputs[operation])
        error_codes = tuple(output.error.error_code for output in operation_outputs.values() if output.error is not None)
        trace.finish(
            SafeQualityTraceRootOutput(
                shadow_result=shadow_result,
                decision_hash=decision_hash,
                operation_terminals=trace.operation_terminals,
                total_latency_ms=total_latency_ms,
                error_code=error_codes[0] if error_codes else None,
            )
        )
    except DeckQualityGraphTraceRetry:
        raise
    except Exception:
        raise DeckQualityGraphTraceRetry() from None


_TRACE_OPERATION_INDEX = {operation: index for index, operation in enumerate(REQUIRED_QUALITY_TRACE_OPERATIONS)}
_NEXT_OPERATION_BY_STAGE: dict[QualityRunStage, QualityTraceOperation] = {
    QualityRunStage.REQUESTED: "deck.quality.snapshot",
    QualityRunStage.SNAPSHOT_LOADED: "deck.quality.evidence",
    QualityRunStage.EVIDENCE_PREPARED: "deck.judge.blind_visual",
    QualityRunStage.BLIND_ASSESSED: "deck.quality.mechanical_projection",
    QualityRunStage.MECHANICAL_PROJECTED: "deck.judge.plan_realization",
    QualityRunStage.PLAN_REALIZATION_ASSESSED: "deck.quality.adjudicate",
    QualityRunStage.ADJUDICATED: "deck.quality.shadow.persist",
    QualityRunStage.PERSISTED_AND_TRACED: "deck.quality.shadow.persist",
}


def _failure_trace_operation(
    row: QualityRunRecord,
    error: DeckQualityGraphError,
) -> QualityTraceOperation:
    stage = error.stage
    explicit: QualityTraceOperation | None = None
    if error.code is QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE or stage in {
        "shadow_dispatch",
        "scope",
        "instrument",
        "identity",
    }:
        explicit = "deck.quality.shadow.dispatch"
    elif stage in {"snapshot", "immutable_read", "orphan_stage_verify", "stage_verify", "immutable_conflict"}:
        explicit = "deck.quality.snapshot"
    elif stage in {"evidence", "evidence_budget"}:
        explicit = "deck.quality.evidence"
    elif stage in {"assessment_a", "blind_visual", "provider_call_intent_a"}:
        explicit = "deck.judge.blind_visual"
    elif stage == "mechanical_projection":
        explicit = "deck.quality.mechanical_projection"
    elif stage in {"assessment_c", "plan_realization", "provider_call_intent_c"}:
        explicit = "deck.judge.plan_realization"
    elif stage == "adjudicate":
        explicit = "deck.quality.adjudicate"
    elif stage in {"shadow_persist", "runner_terminal_read"}:
        explicit = "deck.quality.shadow.persist"

    durable_next = _NEXT_OPERATION_BY_STAGE[row.stage]
    if explicit is None:
        return durable_next
    # Never claim that a non-durable operation before the failure completed.
    # A stale verification may legitimately move the failure earlier than the
    # row's apparent stage, but never later than the next durable operation.
    if _TRACE_OPERATION_INDEX[explicit] > _TRACE_OPERATION_INDEX[durable_next]:
        return durable_next
    return explicit


def _failure_trace_input_hash(
    row: QualityRunRecord,
    *,
    operation: QualityTraceOperation,
    error_code: str,
) -> str:
    return canonical_sha256(
        {
            "quality_run_id": row.quality_run_id,
            "artifact_version_id": row.artifact_version_id,
            "input_manifest_hash": row.input_manifest_hash,
            "durable_stage": row.stage.value,
            "operation": operation,
            "terminal_error_code": error_code,
        }
    )


def derive_terminal_failure_trace_payload_hash(
    row: QualityRunRecord,
    *,
    root_input: SafeQualityTraceRootInput,
    error: DeckQualityGraphError,
    terminal_state: QualityRunTerminalState,
) -> str:
    """Derive the immutable content-free failure payload bound before tracing."""

    root_input_hash = compute_safe_trace_root_input_hash(serialize_safe_trace_root_input(root_input))
    return canonical_sha256(
        _TerminalFailureTraceArtifact(
            quality_run_id=row.quality_run_id,
            terminal_state=terminal_state.value,
            error_code=error.code.value,
            error_stage=error.stage,
            error_operation=_failure_trace_operation(row, error),
            durable_stage=row.stage.value,
            durable_stage_rank=row.stage_rank,
            instrument_identity_hash=row.instrument_identity_hash,
            input_manifest_hash=row.input_manifest_hash,
            evidence_manifest_hash=row.evidence_manifest_hash,
            safe_trace_root_input_hash=root_input_hash,
            stage_artifact_hashes=row.stage_artifact_hashes,
        )
    )


async def emit_terminal_failure_trace(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
    *,
    error: DeckQualityGraphError,
    terminal_state: QualityRunTerminalState,
) -> dict[str, str]:
    """Remotely ACK one exact content-free trace before failure terminalization.

    IDs and payloads are derived solely from durable identity, stage hashes, and
    controlled codes. A crash after the remote ACK replays the same run IDs and
    payloads before the epoch-fenced terminal update.
    """

    try:
        failure_operation = _failure_trace_operation(row, error)
        failure_index = _TRACE_OPERATION_INDEX[failure_operation]
        error_code = error.code.value
        root_input = _persisted_safe_trace_root_input(row)
        failure_hash = derive_terminal_failure_trace_payload_hash(
            row,
            root_input=root_input,
            error=error,
            terminal_state=terminal_state,
        )
        if row.state != "finalizing" or row.pending_terminal_state != terminal_state.value or row.last_error_code is not error.code or row.last_error_stage != error.stage or row.terminal_trace_payload_hash != failure_hash:
            raise DeckQualityGraphTraceRetry()
        trace_ids = _trace_ids(root_input)

        descriptor: SnapshotDescriptor | None = None
        visual: _AssessmentAArtifact | None = None
        mechanical: _MechanicalArtifact | None = None
        plan: _AssessmentCArtifact | None = None
        decision: ShadowDecision | None = None
        if failure_index > _TRACE_OPERATION_INDEX["deck.quality.snapshot"]:
            descriptor = await _read_stage(
                runtime,
                state,
                row,
                key="source_snapshot",
                model_type=SnapshotDescriptor,
            )
        if failure_index > _TRACE_OPERATION_INDEX["deck.judge.blind_visual"]:
            visual = await _read_stage(
                runtime,
                state,
                row,
                key="assessment_a_visual",
                model_type=_AssessmentAArtifact,
            )
        if failure_index > _TRACE_OPERATION_INDEX["deck.quality.mechanical_projection"]:
            mechanical = await _read_stage(
                runtime,
                state,
                row,
                key="assessment_b_mechanical",
                model_type=_MechanicalArtifact,
            )
        if failure_index > _TRACE_OPERATION_INDEX["deck.judge.plan_realization"]:
            plan = await _read_stage(
                runtime,
                state,
                row,
                key="assessment_c_plan_realization",
                model_type=_AssessmentCArtifact,
            )
        if failure_index > _TRACE_OPERATION_INDEX["deck.quality.adjudicate"]:
            decision = await _read_stage(
                runtime,
                state,
                row,
                key="decision",
                model_type=ShadowDecision,
            )

        selector_count = descriptor.counts.slide_count if descriptor is not None else 0
        operation_inputs: dict[QualityTraceOperation, SafeQualityTraceOperationInput] = {}
        for operation in REQUIRED_QUALITY_TRACE_OPERATIONS:
            prompt_hash = None
            if operation == "deck.judge.blind_visual":
                prompt_hash = row.prompt_hashes["blind_visual"]
            elif operation == "deck.judge.plan_realization":
                prompt_hash = row.prompt_hashes["plan_realization"]
            input_hash = _failure_trace_input_hash(
                row,
                operation=operation,
                error_code=error_code,
            )
            if operation == "deck.judge.blind_visual" and visual is not None:
                input_hash = visual.input_hash
            elif operation == "deck.quality.mechanical_projection" and mechanical is not None:
                input_hash = mechanical.input_hash
            elif operation == "deck.judge.plan_realization" and plan is not None:
                input_hash = plan.input_hash
            operation_inputs[operation] = _operation_input(
                operation=operation,
                row=row,
                input_hash=input_hash,
                expected_count=(selector_count if operation not in {"deck.quality.shadow.dispatch", "deck.quality.snapshot", "deck.quality.adjudicate", "deck.quality.shadow.persist"} else 0),
                rendered_count=(selector_count if operation not in {"deck.quality.shadow.dispatch", "deck.quality.snapshot", "deck.quality.adjudicate", "deck.quality.shadow.persist"} else 0),
                prompt_hash=prompt_hash,
            )

        completed_outputs: dict[QualityTraceOperation, SafeQualityTraceOperationOutput] = {
            "deck.quality.shadow.dispatch": SafeQualityTraceOperationOutput(
                operation="deck.quality.shadow.dispatch",
                status="completed",
                output_hash=canonical_sha256(
                    {
                        "quality_run_id": row.quality_run_id,
                        "instrument_identity_hash": row.instrument_identity_hash,
                        "artifact_version_id": row.artifact_version_id,
                    }
                ),
                latency_ms=0,
            )
        }
        if descriptor is not None:
            completed_outputs["deck.quality.snapshot"] = SafeQualityTraceOperationOutput(
                operation="deck.quality.snapshot",
                status="completed",
                output_hash=row.stage_artifact_hashes["source_snapshot"],
                latency_ms=0,
            )
        if descriptor is not None and failure_index > _TRACE_OPERATION_INDEX["deck.quality.evidence"]:
            completed_outputs["deck.quality.evidence"] = SafeQualityTraceOperationOutput(
                operation="deck.quality.evidence",
                status="completed",
                output_hash=row.stage_artifact_hashes["evidence_manifest"],
                latency_ms=0,
                evaluated_selector_count=selector_count,
            )
        if visual is not None:
            completed_outputs["deck.judge.blind_visual"] = _judge_output(
                operation="deck.judge.blind_visual",
                artifact_hash=row.stage_artifact_hashes["assessment_a_visual"],
                stage=visual,
            )
        if mechanical is not None:
            mechanical_failures = tuple(code for check in mechanical.projection.checks for code in check.failure_codes)
            completed_outputs["deck.quality.mechanical_projection"] = SafeQualityTraceOperationOutput(
                operation="deck.quality.mechanical_projection",
                status="completed",
                output_hash=row.stage_artifact_hashes["assessment_b_mechanical"],
                latency_ms=0,
                evaluated_selector_count=selector_count,
                failure_codes=_safe_failure_codes(mechanical_failures),
            )
        if plan is not None:
            completed_outputs["deck.judge.plan_realization"] = _judge_output(
                operation="deck.judge.plan_realization",
                artifact_hash=row.stage_artifact_hashes["assessment_c_plan_realization"],
                stage=plan,
            )
        if decision is not None:
            completed_outputs["deck.quality.adjudicate"] = SafeQualityTraceOperationOutput(
                operation="deck.quality.adjudicate",
                status="completed",
                output_hash=row.stage_artifact_hashes["decision"],
                latency_ms=0,
                failure_codes=_safe_failure_codes(decision.failure_codes),
                shadow_result=decision.result,
            )

        operation_outputs: dict[QualityTraceOperation, SafeQualityTraceOperationOutput] = {}
        for operation in REQUIRED_QUALITY_TRACE_OPERATIONS:
            index = _TRACE_OPERATION_INDEX[operation]
            if index < failure_index:
                operation_outputs[operation] = completed_outputs[operation]
            elif index == failure_index:
                operation_outputs[operation] = SafeQualityTraceOperationOutput(
                    operation=operation,
                    status="error",
                    latency_ms=0,
                    error=SafeQualityTraceError(
                        error_code=error_code,
                        stage={
                            "deck.quality.shadow.dispatch": "shadow_dispatch",
                            "deck.quality.snapshot": "snapshot",
                            "deck.quality.evidence": "evidence",
                            "deck.judge.blind_visual": "blind_visual",
                            "deck.quality.mechanical_projection": "mechanical_projection",
                            "deck.judge.plan_realization": "plan_realization",
                            "deck.quality.adjudicate": "adjudicate",
                            "deck.quality.shadow.persist": "shadow_persist",
                        }[operation],
                        retryable=False,
                    ),
                )
            elif operation == "deck.quality.shadow.persist":
                operation_outputs[operation] = SafeQualityTraceOperationOutput(
                    operation=operation,
                    status="completed",
                    output_hash=failure_hash,
                    latency_ms=0,
                    shadow_result="failed_to_judge",
                )
            else:
                operation_outputs[operation] = SafeQualityTraceOperationOutput(
                    operation=operation,
                    status="skipped",
                    latency_ms=0,
                    skip_code="upstream_error",
                )

        await anyio.to_thread.run_sync(
            partial(
                _emit_safe_trace,
                runtime,
                root_input=root_input,
                operation_inputs=operation_inputs,
                operation_outputs=operation_outputs,
                shadow_result="failed_to_judge",
                decision_hash=failure_hash,
                total_latency_ms=0,
            )
        )
        return trace_ids
    except DeckQualityGraphTraceRetry:
        raise
    except Exception:
        raise DeckQualityGraphTraceRetry() from None


def _success_trace_operations(
    row: QualityRunRecord,
    *,
    hashes: Mapping[str, str],
    visual: _AssessmentAArtifact,
    mechanical: _MechanicalArtifact,
    plan: _AssessmentCArtifact,
    decision: ShadowDecision,
    decision_hash: str,
    run_hash: str,
    selector_count: int,
    coverage_complete: bool,
) -> tuple[
    dict[QualityTraceOperation, SafeQualityTraceOperationInput],
    dict[QualityTraceOperation, SafeQualityTraceOperationOutput],
]:
    """Build the one canonical safe success payload for first emit and replay."""

    if row.evidence_manifest_hash is None:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    dispatch_hash = canonical_sha256(
        {
            "quality_run_id": row.quality_run_id,
            "instrument_identity_hash": row.instrument_identity_hash,
            "artifact_version_id": row.artifact_version_id,
        }
    )
    adjudicate_input_hash = canonical_sha256(
        {
            "assessment_a_visual": hashes["assessment_a_visual"],
            "assessment_b_mechanical": hashes["assessment_b_mechanical"],
            "assessment_c_plan_realization": hashes[
                "assessment_c_plan_realization"
            ],
            "policy_hash": row.adjudication_policy_hash,
        }
    )
    operation_inputs: dict[
        QualityTraceOperation, SafeQualityTraceOperationInput
    ] = {
        "deck.quality.shadow.dispatch": _operation_input(
            operation="deck.quality.shadow.dispatch",
            row=row,
            input_hash=dispatch_hash,
        ),
        "deck.quality.snapshot": _operation_input(
            operation="deck.quality.snapshot",
            row=row,
            input_hash=row.evidence_manifest_hash,
        ),
        "deck.quality.evidence": _operation_input(
            operation="deck.quality.evidence",
            row=row,
            input_hash=hashes["source_snapshot"],
            expected_count=selector_count,
            rendered_count=selector_count,
        ),
        "deck.judge.blind_visual": _operation_input(
            operation="deck.judge.blind_visual",
            row=row,
            input_hash=visual.input_hash,
            expected_count=selector_count,
            rendered_count=selector_count,
            prompt_hash=row.prompt_hashes["blind_visual"],
        ),
        "deck.quality.mechanical_projection": _operation_input(
            operation="deck.quality.mechanical_projection",
            row=row,
            input_hash=mechanical.input_hash,
            expected_count=selector_count,
            rendered_count=selector_count,
        ),
        "deck.judge.plan_realization": _operation_input(
            operation="deck.judge.plan_realization",
            row=row,
            input_hash=plan.input_hash,
            expected_count=selector_count,
            rendered_count=selector_count,
            prompt_hash=row.prompt_hashes["plan_realization"],
        ),
        "deck.quality.adjudicate": _operation_input(
            operation="deck.quality.adjudicate",
            row=row,
            input_hash=adjudicate_input_hash,
        ),
        "deck.quality.shadow.persist": _operation_input(
            operation="deck.quality.shadow.persist",
            row=row,
            input_hash=decision_hash,
        ),
    }
    mechanical_failures = tuple(
        code
        for check in mechanical.projection.checks
        for code in check.failure_codes
    )
    evidence_trace_output = (
        SafeQualityTraceOperationOutput(
            operation="deck.quality.evidence",
            status="error",
            latency_ms=0,
            error=SafeQualityTraceError(
                error_code="coverage_error",
                stage="evidence",
                retryable=False,
            ),
        )
        if visual.status == "completed" and not coverage_complete
        else SafeQualityTraceOperationOutput(
            operation="deck.quality.evidence",
            status="completed",
            output_hash=hashes["evidence_manifest"],
            latency_ms=0,
            evaluated_selector_count=selector_count,
        )
    )
    mechanical_trace_output = (
        SafeQualityTraceOperationOutput(
            operation="deck.quality.mechanical_projection",
            status="error",
            latency_ms=0,
            error=SafeQualityTraceError(
                error_code="coverage_error",
                stage="mechanical_projection",
                retryable=False,
            ),
        )
        if mechanical.projection.status == "incomplete"
        else SafeQualityTraceOperationOutput(
            operation="deck.quality.mechanical_projection",
            status="completed",
            output_hash=hashes["assessment_b_mechanical"],
            latency_ms=0,
            evaluated_selector_count=selector_count,
            failure_codes=_safe_failure_codes(mechanical_failures),
        )
    )
    operation_outputs: dict[
        QualityTraceOperation, SafeQualityTraceOperationOutput
    ] = {
        "deck.quality.shadow.dispatch": SafeQualityTraceOperationOutput(
            operation="deck.quality.shadow.dispatch",
            status="completed",
            output_hash=dispatch_hash,
            latency_ms=0,
        ),
        "deck.quality.snapshot": SafeQualityTraceOperationOutput(
            operation="deck.quality.snapshot",
            status="completed",
            output_hash=hashes["source_snapshot"],
            latency_ms=0,
        ),
        "deck.quality.evidence": evidence_trace_output,
        "deck.judge.blind_visual": _judge_output(
            operation="deck.judge.blind_visual",
            artifact_hash=hashes["assessment_a_visual"],
            stage=visual,
        ),
        "deck.quality.mechanical_projection": mechanical_trace_output,
        "deck.judge.plan_realization": _judge_output(
            operation="deck.judge.plan_realization",
            artifact_hash=hashes["assessment_c_plan_realization"],
            stage=plan,
        ),
        "deck.quality.adjudicate": SafeQualityTraceOperationOutput(
            operation="deck.quality.adjudicate",
            status="completed",
            output_hash=decision_hash,
            latency_ms=0,
            failure_codes=_safe_failure_codes(decision.failure_codes),
            shadow_result=decision.result,
        ),
        "deck.quality.shadow.persist": SafeQualityTraceOperationOutput(
            operation="deck.quality.shadow.persist",
            status="completed",
            output_hash=run_hash,
            latency_ms=0,
            shadow_result=decision.result,
        ),
    }
    return operation_inputs, operation_outputs


async def replay_prepared_completion_trace(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    row: QualityRunRecord,
) -> QualityRunRecord:
    """ACK a prepared success without re-entering raw evidence or judge work."""

    if (
        row.state != "finalizing"
        or row.pending_terminal_state is not None
        or row.stage is not QualityRunStage.ADJUDICATED
        or row.decision_result is None
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    root_input = _persisted_safe_trace_root_input(row)
    trace_ids = _trace_ids(root_input)
    hashes = dict(row.stage_artifact_hashes)
    required_hashes = {
        "source_snapshot",
        "evidence_manifest",
        "assessment_a_visual",
        "assessment_b_mechanical",
        "assessment_c_plan_realization",
        "decision",
        "safe_metrics",
        "run",
    }
    if not required_hashes.issubset(hashes) or any(
        row.trace_ids.get(key) != value for key, value in trace_ids.items()
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )

    # These are bounded immutable stage records only. In particular, this path
    # never loads the evidence bundle, render images, brief, or creative plans.
    visual = await _read_stage(
        runtime,
        state,
        row,
        key="assessment_a_visual",
        model_type=_AssessmentAArtifact,
    )
    mechanical = await _read_stage(
        runtime,
        state,
        row,
        key="assessment_b_mechanical",
        model_type=_MechanicalArtifact,
    )
    plan = await _read_stage(
        runtime,
        state,
        row,
        key="assessment_c_plan_realization",
        model_type=_AssessmentCArtifact,
    )
    decision = await _read_stage(
        runtime,
        state,
        row,
        key="decision",
        model_type=ShadowDecision,
    )
    safe_metrics_artifact = await _read_stage(
        runtime,
        state,
        row,
        key="safe_metrics",
        model_type=_SafeMetricsArtifact,
    )
    run_artifact = await _read_stage(
        runtime,
        state,
        row,
        key="run",
        model_type=_PreparedRunArtifact,
    )

    decision_hash = canonical_sha256(decision)
    root_input_hash = compute_safe_trace_root_input_hash(
        serialize_safe_trace_root_input(root_input)
    )
    expected_run_hashes = {
        key: value for key, value in hashes.items() if key != "run"
    }
    if (
        safe_metrics_artifact.quality_run_id != row.quality_run_id
        or safe_metrics_artifact.values != row.safe_metrics
        or run_artifact.quality_run_id != row.quality_run_id
        or run_artifact.campaign_id != row.campaign_id
        or run_artifact.decision_result != decision.result
        or run_artifact.decision_hash != decision_hash
        or run_artifact.safe_metrics_hash != hashes["safe_metrics"]
        or run_artifact.safe_trace_root_input_hash != root_input_hash
        or run_artifact.trace_ids != trace_ids
        or run_artifact.stage_artifact_hashes != expected_run_hashes
        or row.decision_result is not QualityRunDecision(decision.result)
        or row.decision_failure_codes
        != _safe_failure_codes(decision.failure_codes)
        or row.decision_weighted_score
        != persisted_decision_weighted_score(decision.weighted_score)
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="stage_verify",
            retryable=False,
        )

    selector_count = row.safe_metrics.get("slide_count")
    coverage_complete = row.safe_metrics.get("coverage_complete")
    total_latency_ms = row.safe_metrics.get("total_latency_ms")
    if (
        not isinstance(selector_count, int)
        or isinstance(selector_count, bool)
        or selector_count < 1
        or not isinstance(coverage_complete, bool)
        or not isinstance(total_latency_ms, int)
        or isinstance(total_latency_ms, bool)
        or total_latency_ms < 0
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    operation_inputs, operation_outputs = _success_trace_operations(
        row,
        hashes=hashes,
        visual=visual,
        mechanical=mechanical,
        plan=plan,
        decision=decision,
        decision_hash=decision_hash,
        run_hash=hashes["run"],
        selector_count=selector_count,
        coverage_complete=coverage_complete,
    )
    await _renew(runtime, state)
    await anyio.to_thread.run_sync(
        partial(
            _emit_safe_trace,
            runtime,
            root_input=root_input,
            operation_inputs=operation_inputs,
            operation_outputs=operation_outputs,
            shadow_result=decision.result,
            decision_hash=decision_hash,
            total_latency_ms=total_latency_ms,
        )
    )
    await _renew(runtime, state)
    try:
        finished = await runtime.store.complete_after_trace(_lease(state))
    except Exception:
        try:
            finished = await runtime.store.get(row.quality_run_id)
        except Exception:
            finished = None
        if finished is None:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="shadow_persist",
                retryable=True,
            ) from None
    if (
        finished.state != "completed"
        or finished.stage is not QualityRunStage.PERSISTED_AND_TRACED
        or finished.decision_result is not QualityRunDecision(decision.result)
        or finished.safe_trace_root_input != row.safe_trace_root_input
        or finished.safe_trace_root_input_hash != row.safe_trace_root_input_hash
        or any(
            finished.trace_ids.get(key) != value
            for key, value in trace_ids.items()
        )
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    return finished


async def _persist_and_trace_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
    *,
    current_row: QualityRunRecord | None = None,
    loaded_snapshot: LoadedEvidenceSnapshot | None = None,
    visual_stage: _AssessmentAArtifact | None = None,
    mechanical_stage: _MechanicalArtifact | None = None,
    plan_stage: _AssessmentCArtifact | None = None,
    shadow_decision: ShadowDecision | None = None,
) -> DeckQualityShadowGraphState:
    row = current_row or await _renew(runtime, state)
    async with _loaded_snapshot(
        runtime,
        state,
        row,
        existing=loaded_snapshot,
    ) as loaded:
        visual = visual_stage or await _assessment_a(
            runtime,
            state,
            row,
            loaded=loaded,
        )
        mechanical = mechanical_stage or await _mechanical(
            runtime,
            state,
            row,
            loaded=loaded,
        )
        plan = plan_stage or await _assessment_c(
            runtime,
            state,
            row,
            loaded=loaded,
            visual_stage=visual,
            mechanical_stage=mechanical,
        )
        decision = shadow_decision or await _decision(
            runtime,
            state,
            row,
            loaded=loaded,
            visual_stage=visual,
            mechanical_stage=mechanical,
            plan_stage=plan,
        )
        descriptor = loaded.descriptor
        coverage = prove_coverage(loaded.snapshot, visual.assessment)
    decision_hash = canonical_sha256(decision)
    # Prepared rows already contain the terminal artifact hashes. Exclude them
    # from the immutable run payload so replay cannot become self-referential.
    hashes = {key: value for key, value in row.stage_artifact_hashes.items() if key not in {"safe_metrics", "run"}}
    required = {
        "source_snapshot",
        "evidence_manifest",
        "assessment_a_visual",
        "assessment_b_mechanical",
        "assessment_c_plan_realization",
        "decision",
    }
    if not required.issubset(hashes):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    if hashes["decision"] != decision_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="shadow_persist",
            retryable=False,
        )
    metrics = _safe_metrics(
        runtime,
        row,
        visual,
        plan,
        slide_count=descriptor.counts.slide_count,
        coverage_complete=coverage.complete,
    )
    root_input = safe_trace_root_input_for_record(runtime, row)
    root_payload = serialize_safe_trace_root_input(root_input)
    root_input_hash = compute_safe_trace_root_input_hash(root_payload)
    trace_ids = _trace_ids(root_input)
    safe_metrics_artifact = _SafeMetricsArtifact(
        quality_run_id=row.quality_run_id,
        values=metrics,
    )
    safe_metrics_bytes = canonical_json_bytes(safe_metrics_artifact)
    safe_metrics_hash = _sha256(safe_metrics_bytes)
    run_artifact = _PreparedRunArtifact(
        quality_run_id=row.quality_run_id,
        campaign_id=row.campaign_id,
        decision_result=decision.result,
        decision_hash=decision_hash,
        safe_metrics_hash=safe_metrics_hash,
        safe_trace_root_input_hash=root_input_hash,
        trace_ids=trace_ids,
        stage_artifact_hashes={
            **hashes,
            "safe_metrics": safe_metrics_hash,
        },
    )
    run_bytes = canonical_json_bytes(run_artifact)
    run_hash = _sha256(run_bytes)
    selector_count = descriptor.counts.slide_count
    operation_inputs, operation_outputs = _success_trace_operations(
        row,
        hashes=hashes,
        visual=visual,
        mechanical=mechanical,
        plan=plan,
        decision=decision,
        decision_hash=decision_hash,
        run_hash=run_hash,
        selector_count=selector_count,
        coverage_complete=coverage.complete,
    )
    # Terminal ordering is locked: write the immutable preparation artifacts,
    # durably enter the reclaimable finalizing state, remotely ACK the exact
    # safe trace, and only then commit the separate epoch-fenced completion.
    persisted_metrics_hash = await _write_immutable(
        runtime,
        state,
        row,
        object_path=_stage_path(row, "safe_metrics"),
        content=safe_metrics_bytes,
    )
    if persisted_metrics_hash != safe_metrics_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="shadow_persist",
            retryable=False,
        )
    persisted_run_hash = await _write_immutable(
        runtime,
        state,
        row,
        object_path=_stage_path(row, "run"),
        content=run_bytes,
    )
    if persisted_run_hash != run_hash:
        raise DeckQualityGraphError(
            QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
            stage="shadow_persist",
            retryable=False,
        )
    final_hashes = {
        **hashes,
        "safe_metrics": safe_metrics_hash,
        "run": run_hash,
    }
    await _renew(runtime, state)
    try:
        prepared = await runtime.store.prepare_completion(
            _lease(state),
            decision_result=QualityRunDecision(decision.result),
            decision_failure_codes=_safe_failure_codes(decision.failure_codes),
            decision_weighted_score=decision.weighted_score,
            safe_metrics=metrics,
            trace_ids=trace_ids,
            stage_artifact_hashes=final_hashes,
            safe_trace_root_input=root_payload,
        )
    except Exception:
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        ) from None
    prepared_root_input = _persisted_safe_trace_root_input(prepared)
    if (
        prepared.state != "finalizing"
        or prepared.stage is not QualityRunStage.ADJUDICATED
        or prepared.lease_owner != state["lease_owner"]
        or prepared.lease_epoch != state["lease_epoch"]
        or prepared.decision_result != QualityRunDecision(decision.result)
        or prepared.stage_artifact_hashes.get("run") != run_hash
        or prepared.stage_artifact_hashes.get("safe_metrics") != safe_metrics_hash
        or prepared.safe_trace_root_input_hash != root_input_hash
        or prepared_root_input != root_input
        or any(prepared.trace_ids.get(key) != value for key, value in trace_ids.items())
    ):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    # The prepared row is the sole source of the remote root. This assignment
    # is intentional even on the first attempt so trace emission and reclaim
    # always follow the same persisted-root path.
    root_input = prepared_root_input

    await _renew(runtime, state)
    await anyio.to_thread.run_sync(
        partial(
            _emit_safe_trace,
            runtime,
            root_input=root_input,
            operation_inputs=operation_inputs,
            operation_outputs=operation_outputs,
            shadow_result=decision.result,
            decision_hash=decision_hash,
            total_latency_ms=int(metrics["total_latency_ms"] or 0),
        )
    )
    await _renew(runtime, state)
    try:
        finished = await runtime.store.complete_after_trace(_lease(state))
    except Exception:
        try:
            finished = await runtime.store.get(row.quality_run_id)
        except Exception:
            finished = None
        if finished is None:
            raise DeckQualityGraphError(
                QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
                stage="shadow_persist",
                retryable=True,
            ) from None
    if finished.state != "completed" or finished.stage is not QualityRunStage.PERSISTED_AND_TRACED or finished.decision_result != QualityRunDecision(decision.result):
        raise DeckQualityGraphError(
            QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
            stage="shadow_persist",
            retryable=True,
        )
    return {
        **_state_delta(finished),
        "decision_result": decision.result,
        "decision_hash": decision_hash,
        "decision_failure_codes": _safe_failure_codes(decision.failure_codes),
        "safe_metrics": metrics,
        "trace_ids": trace_ids,
        "terminal_state": finished.state,
    }


async def _run_quality_pipeline_node(
    runtime: DeckQualityGraphRuntime,
    state: DeckQualityShadowGraphState,
) -> DeckQualityShadowGraphState:
    """Execute all durable stages with one verified evidence materialization."""

    row = await _renew(runtime, state)
    row = await _ensure_evidence_snapshot(runtime, state, row)
    descriptor, bounded_reader = await _bounded_descriptor_reader(
        runtime,
        state,
        row,
    )
    async with _loaded_snapshot(
        runtime,
        state,
        row,
        descriptor=descriptor,
        reader=bounded_reader,
    ) as loaded:
        bounded_reader.assert_complete()
        if loaded.descriptor != descriptor:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="snapshot",
                retryable=False,
            )

        descriptor_hash = _sha256(canonical_json_bytes(descriptor))
        if row.stage_artifact_hashes.get("source_snapshot") != descriptor_hash:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="snapshot",
                retryable=False,
            )

        # Both direct payloads are checked before the first durable call
        # intent. There is no selector truncation or unimplemented large-deck
        # fallback in this campaign.
        _validate_complete_direct_evidence(runtime, loaded)
        if row.stage_rank < STAGE_RANK[QualityRunStage.EVIDENCE_PREPARED]:
            row = await _checkpoint(
                runtime,
                state,
                stage=QualityRunStage.EVIDENCE_PREPARED,
                artifact_hash=row.evidence_manifest_hash,
            )
        elif row.stage_artifact_hashes.get("evidence_manifest") != row.evidence_manifest_hash:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="evidence",
                retryable=False,
            )

        visual = await _assessment_a(
            runtime,
            state,
            row,
            loaded=loaded,
        )
        if row.stage_rank < STAGE_RANK[QualityRunStage.BLIND_ASSESSED]:
            visual_hash = await _write_immutable(
                runtime,
                state,
                row,
                object_path=_stage_path(row, "assessment_a_visual"),
                content=canonical_json_bytes(visual),
            )
            row = await _checkpoint(
                runtime,
                state,
                stage=QualityRunStage.BLIND_ASSESSED,
                artifact_hash=visual_hash,
                additional_artifact_hashes=({"assessment_a_call_intent": visual.call_intent_hash} if visual.call_intent_hash is not None else None),
            )

        mechanical = await _mechanical(
            runtime,
            state,
            row,
            loaded=loaded,
        )
        if row.stage_rank < STAGE_RANK[QualityRunStage.MECHANICAL_PROJECTED]:
            mechanical_hash = await _write_immutable(
                runtime,
                state,
                row,
                object_path=_stage_path(row, "assessment_b_mechanical"),
                content=canonical_json_bytes(mechanical),
            )
            row = await _checkpoint(
                runtime,
                state,
                stage=QualityRunStage.MECHANICAL_PROJECTED,
                artifact_hash=mechanical_hash,
            )

        plan = await _assessment_c(
            runtime,
            state,
            row,
            loaded=loaded,
            visual_stage=visual,
            mechanical_stage=mechanical,
        )
        if row.stage_rank < STAGE_RANK[QualityRunStage.PLAN_REALIZATION_ASSESSED]:
            plan_hash = await _write_immutable(
                runtime,
                state,
                row,
                object_path=_stage_path(row, "assessment_c_plan_realization"),
                content=canonical_json_bytes(plan),
            )
            row = await _checkpoint(
                runtime,
                state,
                stage=QualityRunStage.PLAN_REALIZATION_ASSESSED,
                artifact_hash=plan_hash,
                additional_artifact_hashes=({"assessment_c_call_intent": plan.call_intent_hash} if plan.call_intent_hash is not None else None),
            )

        decision = await _decision(
            runtime,
            state,
            row,
            loaded=loaded,
            visual_stage=visual,
            mechanical_stage=mechanical,
            plan_stage=plan,
        )
        decision_hash = canonical_sha256(decision)
        if row.stage_rank < STAGE_RANK[QualityRunStage.ADJUDICATED]:
            persisted_decision_hash = await _write_immutable(
                runtime,
                state,
                row,
                object_path=_stage_path(row, "decision"),
                content=canonical_json_bytes(decision),
            )
            row = await _checkpoint(
                runtime,
                state,
                stage=QualityRunStage.ADJUDICATED,
                artifact_hash=persisted_decision_hash,
            )
        elif row.stage_artifact_hashes.get("decision") != decision_hash:
            raise DeckQualityGraphError(
                QualityRunErrorCode.ARTIFACT_SNAPSHOT_STALE,
                stage="adjudicate",
                retryable=False,
            )

        return await _persist_and_trace_node(
            runtime,
            state,
            current_row=row,
            loaded_snapshot=loaded,
            visual_stage=visual,
            mechanical_stage=mechanical,
            plan_stage=plan,
            shadow_decision=decision,
        )


def compile_deck_quality_shadow_graph(runtime: DeckQualityGraphRuntime) -> Any:
    """Compile the explicit restart-safe DQ-1 stage graph."""

    builder = StateGraph(DeckQualityShadowGraphState)
    builder.add_node(
        "bootstrap_dispatch",
        partial(_bootstrap_dispatch_node, runtime),
    )
    builder.add_node(
        "run_quality_pipeline",
        partial(_run_quality_pipeline_node, runtime),
    )
    builder.add_edge(START, "bootstrap_dispatch")
    builder.add_edge("bootstrap_dispatch", "run_quality_pipeline")
    builder.add_edge("run_quality_pipeline", END)
    return builder.compile()


def make_deck_quality_shadow_graph(config: RunnableConfig) -> Any:
    """LangGraph registration factory using only process-local configured dependencies."""

    del config
    from deerflow.sophia.deck_quality.runner import (
        compile_registered_deck_quality_shadow_graph,
        configured_graph_runtime,
    )

    return compile_registered_deck_quality_shadow_graph(configured_graph_runtime())


__all__ = [
    "DeckQualityGraphError",
    "DeckQualityGraphRuntime",
    "DeckQualityGraphTraceRetry",
    "DeckQualityShadowGraphState",
    "compile_deck_quality_shadow_graph",
    "derive_terminal_failure_trace_payload_hash",
    "emit_terminal_failure_trace",
    "make_deck_quality_shadow_graph",
    "replay_prepared_completion_trace",
    "safe_trace_root_input_for_record",
    "serialize_safe_trace_root_input",
]
