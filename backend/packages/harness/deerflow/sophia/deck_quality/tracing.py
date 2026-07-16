from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from math import isfinite
from typing import Annotated, Any, Literal
from uuid import UUID, uuid5

from langsmith.run_trees import RunTree
from langsmith.utils import LangSmithNotFoundError
from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.sophia.deck_quality.schemas import Sha256

QualityTraceOperation = Literal[
    "deck.quality.shadow.dispatch",
    "deck.quality.snapshot",
    "deck.quality.evidence",
    "deck.judge.blind_visual",
    "deck.quality.mechanical_projection",
    "deck.judge.plan_realization",
    "deck.quality.adjudicate",
    "deck.quality.shadow.persist",
]
REQUIRED_QUALITY_TRACE_OPERATIONS: tuple[QualityTraceOperation, ...] = (
    "deck.quality.shadow.dispatch",
    "deck.quality.snapshot",
    "deck.quality.evidence",
    "deck.judge.blind_visual",
    "deck.quality.mechanical_projection",
    "deck.judge.plan_realization",
    "deck.quality.adjudicate",
    "deck.quality.shadow.persist",
)
QualityErrorCode = Literal[
    "judge_unavailable",
    "coverage_error",
    "structured_output_invalid",
    "artifact_snapshot_stale",
    "quality_persistence_error",
    "shadow_dispatch_unavailable",
    "run_deadline_exceeded",
    "attempt_limit_exhausted",
]
QualitySkipCode = Literal[
    "upstream_error",
    "coverage_incomplete",
    "mechanically_invalid",
]
QualityTerminalStatus = Literal["completed", "skipped", "error"]
ShadowResult = Literal[
    "failed_to_judge",
    "mechanically_invalid",
    "needs_revision",
    "needs_user_review",
    "satisfied",
]
SafeIdentifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    ),
]
SafeCode = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-z][a-z0-9_]*$")]
GitCommitSha = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]

_TRACE_ID_NAMESPACE = UUID("f082aa48-2eca-51cb-9518-f0edee23f609")
_JUDGE_OPERATIONS = frozenset(
    {
        "deck.judge.blind_visual",
        "deck.judge.plan_realization",
    }
)
_ZERO_SELECTOR_INPUT_OPERATIONS = frozenset(
    {
        "deck.quality.shadow.dispatch",
        "deck.quality.snapshot",
        "deck.quality.adjudicate",
        "deck.quality.shadow.persist",
    }
)
_SELECTOR_OUTPUT_OPERATIONS = frozenset(
    {
        "deck.quality.evidence",
        "deck.judge.blind_visual",
        "deck.quality.mechanical_projection",
        "deck.judge.plan_realization",
    }
)
_FAILURE_CODE_OPERATIONS = frozenset(
    {
        "deck.judge.blind_visual",
        "deck.quality.mechanical_projection",
        "deck.judge.plan_realization",
        "deck.quality.adjudicate",
    }
)
_RESULT_OPERATIONS = frozenset(
    {
        "deck.quality.adjudicate",
        "deck.quality.shadow.persist",
    }
)
_EXPECTED_ERROR_STAGE: dict[QualityTraceOperation, str] = {
    "deck.quality.shadow.dispatch": "shadow_dispatch",
    "deck.quality.snapshot": "snapshot",
    "deck.quality.evidence": "evidence",
    "deck.judge.blind_visual": "blind_visual",
    "deck.quality.mechanical_projection": "mechanical_projection",
    "deck.judge.plan_realization": "plan_realization",
    "deck.quality.adjudicate": "adjudicate",
    "deck.quality.shadow.persist": "shadow_persist",
}
_ALLOWED_ERROR_CODES: dict[QualityTraceOperation, frozenset[str]] = {
    "deck.quality.shadow.dispatch": frozenset(
        {
            "shadow_dispatch_unavailable",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.quality.snapshot": frozenset(
        {
            "artifact_snapshot_stale",
            "coverage_error",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.quality.evidence": frozenset(
        {
            "coverage_error",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.judge.blind_visual": frozenset(
        {
            "judge_unavailable",
            "structured_output_invalid",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.quality.mechanical_projection": frozenset(
        {
            "coverage_error",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.judge.plan_realization": frozenset(
        {
            "judge_unavailable",
            "structured_output_invalid",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.quality.adjudicate": frozenset(
        {
            "coverage_error",
            "structured_output_invalid",
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
    "deck.quality.shadow.persist": frozenset(
        {
            "quality_persistence_error",
            "run_deadline_exceeded",
            "attempt_limit_exhausted",
        }
    ),
}
_ALLOWED_SKIP_CODES: dict[QualityTraceOperation, frozenset[str]] = {
    "deck.quality.shadow.dispatch": frozenset(),
    "deck.quality.snapshot": frozenset({"upstream_error"}),
    "deck.quality.evidence": frozenset({"upstream_error"}),
    "deck.judge.blind_visual": frozenset({"upstream_error", "coverage_incomplete"}),
    "deck.quality.mechanical_projection": frozenset({"upstream_error", "coverage_incomplete"}),
    "deck.judge.plan_realization": frozenset({"upstream_error", "coverage_incomplete", "mechanically_invalid"}),
    "deck.quality.adjudicate": frozenset({"upstream_error"}),
    "deck.quality.shadow.persist": frozenset(),
}

_FORBIDDEN_FIELD_NAMES = frozenset(
    {
        "api_key",
        "attachments",
        "auth",
        "authorization",
        "base64",
        "credential",
        "credentials",
        "creative_plan",
        "design_plan",
        "exception",
        "exception_text",
        "html",
        "image",
        "images",
        "memory",
        "message",
        "messages",
        "path",
        "prompt",
        "provider_reasoning",
        "raw_exception",
        "reasoning",
        "secret",
        "signed_url",
        "token",
        "url",
        "user_memory",
    }
)
_FORBIDDEN_VALUE_MARKERS = (
    "api-key",
    "api_key",
    "authorization",
    "base64",
    "bearer ",
    "basic ",
    "creative plan",
    "creative_plan",
    "data:image",
    "exception:",
    "file://",
    "gs://",
    "http://",
    "https://",
    "s3://",
    "signature=",
    "signed-url",
    "signed_url",
    "traceback",
    "user memory",
    "user_memory",
    "x-amz-",
    "x-goog-",
)
_PATH_PREFIX = re.compile(r"^(?:/|\.{1,2}/|~/|[A-Za-z]:[\\/])")
_BASE64_BLOB = re.compile(r"^[A-Za-z0-9+/_-]{80,}={0,2}$")
_CREDENTIAL_TOKEN = re.compile(
    r"^(?:sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|eyj[a-z0-9_-]{10,}\.)",
    re.IGNORECASE,
)
_EXCEPTION_TEXT = re.compile(
    r"(?:^|[._-])(?:[a-z]+error|exception)(?:$|[._:-])",
    re.IGNORECASE,
)


def _reject_unsafe_trace_value(value: Any, *, field_name: str | None = None) -> None:
    if isinstance(value, BaseModel):
        _reject_unsafe_trace_value(value.model_dump(mode="python"), field_name=field_name)
        return
    if isinstance(value, Mapping):
        for raw_key, item in value.items():
            key = str(raw_key).lower()
            if key in _FORBIDDEN_FIELD_NAMES or key.endswith(("_path", "_url", "_authorization", "_token")):
                raise ValueError("unsafe content field is forbidden in quality traces")
            _reject_unsafe_trace_value(item, field_name=key)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in value:
            _reject_unsafe_trace_value(item, field_name=field_name)
        return
    if isinstance(value, (bytes, bytearray, memoryview)):
        raise ValueError("binary content is forbidden in quality traces")
    if not isinstance(value, str):
        return

    lowered = value.lower()
    if any(marker in lowered for marker in _FORBIDDEN_VALUE_MARKERS):
        raise ValueError("unsafe content value is forbidden in quality traces")
    if _CREDENTIAL_TOKEN.search(value) or (field_name not in {"error_code", "skip_code"} and _EXCEPTION_TEXT.search(value)):
        raise ValueError("credential or exception content is forbidden in quality traces")
    if field_name != "schema_version" and (_PATH_PREFIX.search(value) or "\\" in value):
        raise ValueError("filesystem paths are forbidden in quality traces")
    if field_name not in {
        "artifact_hash",
        "decision_hash",
        "input_hash",
        "judge_plan_hash",
        "output_hash",
        "prompt_hash",
        "rubric_hash",
    } and _BASE64_BLOB.fullmatch(value):
        raise ValueError("base64-like content is forbidden in quality traces")


class _SafeTraceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    @model_validator(mode="before")
    @classmethod
    def reject_unsafe_content(cls, value: Any) -> Any:
        _reject_unsafe_trace_value(value)
        return value


class SafeQualityTraceRootInput(_SafeTraceModel):
    """Only non-content identifiers, commit SHAs, and instrument hashes."""

    schema_version: Literal["deck-quality-safe-trace-root/v2"] = "deck-quality-safe-trace-root/v2"
    campaign_id: SafeIdentifier
    quality_run_id: SafeIdentifier
    build_id: SafeIdentifier
    task_id: SafeIdentifier
    builder_run_id: SafeIdentifier
    parent_builder_run_id: SafeIdentifier
    parent_builder_trace_id: SafeIdentifier
    logical_artifact_id: SafeIdentifier
    artifact_version_id: SafeIdentifier
    manifest_revision: int = Field(ge=1)
    artifact_hash: Sha256
    rubric_version: SafeIdentifier
    rubric_hash: Sha256
    judge_deployment: SafeIdentifier
    judge_provider: SafeIdentifier
    judge_model: SafeIdentifier
    judge_profile_version: SafeIdentifier
    judge_plan_hash: Sha256
    evidence_preprocessor_version: SafeIdentifier
    source_commit_sha: GitCommitSha
    gateway_deployed_sha: GitCommitSha
    langgraph_deployed_sha: GitCommitSha

    @model_validator(mode="after")
    def require_explicit_builder_linkage(self) -> SafeQualityTraceRootInput:
        if self.builder_run_id != self.parent_builder_run_id:
            raise ValueError("builder linkage must reference the same completed builder run")
        return self


class SafeQualityTraceCorrelationMetadata(_SafeTraceModel):
    """The complete whitelist for LangSmith ``extra.metadata``."""

    schema_version: Literal["deck-quality-safe-trace-metadata/v1"] = "deck-quality-safe-trace-metadata/v1"
    campaign_id: SafeIdentifier
    quality_run_id: SafeIdentifier
    build_id: SafeIdentifier
    task_id: SafeIdentifier
    builder_run_id: SafeIdentifier
    parent_builder_trace_id: SafeIdentifier
    artifact_version_id: SafeIdentifier
    rubric_version: SafeIdentifier
    judge_model: SafeIdentifier
    source_commit_sha: GitCommitSha
    gateway_deployed_sha: GitCommitSha
    langgraph_deployed_sha: GitCommitSha
    operation: QualityTraceOperation | None = None


class SafeQualityTraceOperationInput(_SafeTraceModel):
    """Hash/count-only input contract for one manually emitted quality span."""

    schema_version: Literal["deck-quality-safe-trace-operation-input/v2"] = "deck-quality-safe-trace-operation-input/v2"
    operation: QualityTraceOperation
    quality_run_id: SafeIdentifier
    artifact_version_id: SafeIdentifier
    input_hash: Sha256
    rubric_hash: Sha256
    prompt_hash: Sha256 | None = None
    judge_plan_hash: Sha256 | None = None
    expected_selector_count: int = Field(ge=0, le=500)
    rendered_selector_count: int = Field(ge=0, le=500)

    @model_validator(mode="after")
    def restrict_fields_by_operation(self) -> SafeQualityTraceOperationInput:
        is_judge = self.operation in _JUDGE_OPERATIONS
        if is_judge and (self.prompt_hash is None or self.judge_plan_hash is None):
            raise ValueError("judge operations require prompt and judge-plan hashes")
        if not is_judge and (self.prompt_hash is not None or self.judge_plan_hash is not None):
            raise ValueError("non-judge operations cannot carry judge hashes")
        if self.operation in _ZERO_SELECTOR_INPUT_OPERATIONS and (self.expected_selector_count != 0 or self.rendered_selector_count != 0):
            raise ValueError("this operation cannot carry selector counts")
        return self


class SafeCriterionScore(_SafeTraceModel):
    criterion_id: SafeCode
    applicable: bool
    score: int | None = Field(default=None, ge=1, le=5)

    @model_validator(mode="after")
    def align_applicability(self) -> SafeCriterionScore:
        if self.applicable != (self.score is not None):
            raise ValueError("safe criterion score must align score with applicability")
        return self


class SafeQualityTraceError(_SafeTraceModel):
    error_code: QualityErrorCode
    stage: SafeCode
    retryable: bool = False


BoundedCriterionScores = Annotated[tuple[SafeCriterionScore, ...], Field(max_length=32)]
BoundedFailureCodes = Annotated[tuple[SafeCode, ...], Field(max_length=64)]


class SafeQualityTraceOperationOutput(_SafeTraceModel):
    """Content-free terminal output with operation-specific field semantics."""

    schema_version: Literal["deck-quality-safe-trace-operation-output/v2"] = "deck-quality-safe-trace-operation-output/v2"
    operation: QualityTraceOperation
    status: QualityTerminalStatus
    output_hash: Sha256 | None = None
    latency_ms: int = Field(ge=0)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    evaluated_selector_count: int = Field(default=0, ge=0, le=500)
    criterion_scores: BoundedCriterionScores = ()
    failure_codes: BoundedFailureCodes = ()
    shadow_result: ShadowResult | None = None
    error: SafeQualityTraceError | None = None
    skip_code: QualitySkipCode | None = None

    @model_validator(mode="after")
    def align_status_and_operation(self) -> SafeQualityTraceOperationOutput:
        if self.status == "completed":
            if self.output_hash is None:
                raise ValueError("completed operations require an output hash")
            if self.error is not None or self.skip_code is not None:
                raise ValueError("completed operations cannot carry error or skip status")
        elif self.status == "error":
            if self.error is None:
                raise ValueError("safe error outputs require a controlled error code")
            if self.output_hash is not None or self.skip_code is not None:
                raise ValueError("error operations cannot carry output or skip status")
        else:
            if self.skip_code is None:
                raise ValueError("skipped operations require a controlled skip code")
            if self.output_hash is not None or self.error is not None:
                raise ValueError("skipped operations cannot carry output or error status")

        criterion_ids = tuple(item.criterion_id for item in self.criterion_scores)
        if len(set(criterion_ids)) != len(criterion_ids):
            raise ValueError("safe criterion scores must be unique")
        if len(set(self.failure_codes)) != len(self.failure_codes):
            raise ValueError("safe failure codes must be unique")

        token_values = (self.input_tokens, self.output_tokens, self.total_tokens)
        has_any_token = any(value is not None for value in token_values)
        if self.status == "completed" and self.operation in _JUDGE_OPERATIONS:
            if any(value is None for value in token_values):
                raise ValueError("completed judge operations require complete token counts")
            if self.total_tokens != self.input_tokens + self.output_tokens:  # type: ignore[operator]
                raise ValueError("judge token counts must add to the total")
            if not self.criterion_scores:
                raise ValueError("completed judge operations require criterion scores")
        elif has_any_token:
            raise ValueError("only completed judge operations can carry token counts")

        if self.operation not in _JUDGE_OPERATIONS and self.criterion_scores:
            raise ValueError("only judge operations can carry criterion scores")
        if self.operation not in _FAILURE_CODE_OPERATIONS and self.failure_codes:
            raise ValueError("this operation cannot carry failure codes")
        if self.operation not in _SELECTOR_OUTPUT_OPERATIONS and self.evaluated_selector_count != 0:
            raise ValueError("this operation cannot carry evaluated selector counts")
        if self.status != "completed" and (self.evaluated_selector_count != 0 or self.criterion_scores or self.failure_codes):
            raise ValueError("non-completed operations cannot carry evaluation results")

        if self.status == "completed" and self.operation in _RESULT_OPERATIONS:
            if self.shadow_result is None:
                raise ValueError("adjudication and persistence require a shadow result")
        elif self.shadow_result is not None:
            raise ValueError("this operation cannot carry a shadow result")

        if self.error is not None:
            if self.error.stage != _EXPECTED_ERROR_STAGE[self.operation]:
                raise ValueError("controlled error stage does not match the operation")
            if self.error.error_code not in _ALLOWED_ERROR_CODES[self.operation]:
                raise ValueError("controlled error code is invalid for the operation")
        if self.skip_code is not None and self.skip_code not in _ALLOWED_SKIP_CODES[self.operation]:
            raise ValueError("controlled skip code is invalid for the operation")
        return self


class SafeQualityTraceOperationTerminal(_SafeTraceModel):
    operation: QualityTraceOperation
    status: QualityTerminalStatus
    error_code: QualityErrorCode | None = None
    skip_code: QualitySkipCode | None = None

    @model_validator(mode="after")
    def align_terminal_status(self) -> SafeQualityTraceOperationTerminal:
        if self.status == "completed" and (self.error_code is not None or self.skip_code is not None):
            raise ValueError("completed terminal summaries cannot carry error or skip codes")
        if self.status == "error" and (self.error_code is None or self.skip_code is not None):
            raise ValueError("error terminal summaries require only an error code")
        if self.status == "skipped" and (self.skip_code is None or self.error_code is not None):
            raise ValueError("skipped terminal summaries require only a skip code")
        return self

    @classmethod
    def from_output(cls, output: SafeQualityTraceOperationOutput) -> SafeQualityTraceOperationTerminal:
        return cls(
            operation=output.operation,
            status=output.status,
            error_code=output.error.error_code if output.error is not None else None,
            skip_code=output.skip_code,
        )


ExactOperationTerminals = Annotated[
    tuple[SafeQualityTraceOperationTerminal, ...],
    Field(min_length=len(REQUIRED_QUALITY_TRACE_OPERATIONS), max_length=len(REQUIRED_QUALITY_TRACE_OPERATIONS)),
]


class SafeQualityTraceRootOutput(_SafeTraceModel):
    schema_version: Literal["deck-quality-safe-trace-root-output/v2"] = "deck-quality-safe-trace-root-output/v2"
    shadow_result: ShadowResult
    decision_hash: Sha256
    operation_count: Literal[8] = 8
    operation_terminals: ExactOperationTerminals
    total_latency_ms: int = Field(ge=0)
    error_code: QualityErrorCode | None = None

    @model_validator(mode="after")
    def require_exact_terminal_coverage(self) -> SafeQualityTraceRootOutput:
        operations = tuple(item.operation for item in self.operation_terminals)
        if operations != REQUIRED_QUALITY_TRACE_OPERATIONS:
            raise ValueError("root output requires the ordered terminal status of all eight operations")
        errors = tuple(item.error_code for item in self.operation_terminals if item.status == "error")
        has_skips = any(item.status == "skipped" for item in self.operation_terminals)
        if errors:
            if self.shadow_result != "failed_to_judge" or self.error_code not in errors:
                raise ValueError("operation errors require a matching failed-to-judge root error")
        elif self.shadow_result == "failed_to_judge" or self.error_code is not None:
            raise ValueError("failed-to-judge roots require an operation error")
        if has_skips and not errors and self.shadow_result != "mechanically_invalid":
            raise ValueError("skip-only traces must terminate as mechanically invalid")
        return self


class SafeQualityTraceOperationRunIdentity(_SafeTraceModel):
    operation: QualityTraceOperation
    run_id: UUID


ExactOperationRunIdentities = Annotated[
    tuple[SafeQualityTraceOperationRunIdentity, ...],
    Field(min_length=len(REQUIRED_QUALITY_TRACE_OPERATIONS), max_length=len(REQUIRED_QUALITY_TRACE_OPERATIONS)),
]


class SafeQualityTraceRunIdentity(_SafeTraceModel):
    """Persistable deterministic LangSmith run IDs for restart-safe retries."""

    schema_version: Literal["deck-quality-safe-trace-run-identity/v1"] = "deck-quality-safe-trace-run-identity/v1"
    root_run_id: UUID
    operation_run_ids: ExactOperationRunIdentities

    @model_validator(mode="after")
    def require_exact_identity_coverage(self) -> SafeQualityTraceRunIdentity:
        operations = tuple(item.operation for item in self.operation_run_ids)
        if operations != REQUIRED_QUALITY_TRACE_OPERATIONS:
            raise ValueError("run identity requires the ordered IDs of all eight operations")
        ids = (self.root_run_id, *(item.run_id for item in self.operation_run_ids))
        if len(set(ids)) != len(ids):
            raise ValueError("safe quality trace run IDs must be unique")
        return self

    def operation_run_id(self, operation: QualityTraceOperation) -> UUID:
        return next(item.run_id for item in self.operation_run_ids if item.operation == operation)


def derive_quality_trace_run_identity(root_input: SafeQualityTraceRootInput) -> SafeQualityTraceRunIdentity:
    if type(root_input) is not SafeQualityTraceRootInput:
        raise TypeError("SafeQualityTraceRootInput instance required")
    root_run_id = uuid5(
        _TRACE_ID_NAMESPACE,
        "\x1f".join(
            (
                root_input.campaign_id,
                root_input.quality_run_id,
                root_input.artifact_version_id,
            )
        ),
    )
    return SafeQualityTraceRunIdentity(
        root_run_id=root_run_id,
        operation_run_ids=tuple(
            SafeQualityTraceOperationRunIdentity(
                operation=operation,
                run_id=uuid5(root_run_id, operation),
            )
            for operation in REQUIRED_QUALITY_TRACE_OPERATIONS
        ),
    )


class SafeQualityTraceEmissionError(RuntimeError):
    """A content-free signal that the safe trace could not be emitted."""


DEFAULT_QUALITY_TRACE_FLUSH_TIMEOUT_SECONDS = 15.0
MAX_QUALITY_TRACE_FLUSH_TIMEOUT_SECONDS = 30.0


def sanitize_quality_trace_error(
    error: BaseException,
    *,
    stage: SafeCode,
    error_code: QualityErrorCode | None = None,
    retryable: bool | None = None,
) -> SafeQualityTraceError:
    """Classify an exception without retaining its message, repr, args, or cause."""

    code = error_code
    if code is None:
        code = "structured_output_invalid" if isinstance(error, (TypeError, ValueError)) else "judge_unavailable"
    if retryable is None:
        retryable = isinstance(error, TimeoutError)
    return SafeQualityTraceError(error_code=code, stage=stage, retryable=retryable)


def _safe_model_dump(value: _SafeTraceModel, expected_type: type[_SafeTraceModel]) -> dict[str, Any]:
    if type(value) is not expected_type:
        raise TypeError(f"{expected_type.__name__} instance required")
    payload = value.model_dump(mode="json", exclude_none=True)
    _reject_unsafe_trace_value(payload)
    return payload


def _correlation_metadata(
    root_input: SafeQualityTraceRootInput,
    *,
    operation: QualityTraceOperation | None = None,
) -> dict[str, Any]:
    metadata = SafeQualityTraceCorrelationMetadata(
        campaign_id=root_input.campaign_id,
        quality_run_id=root_input.quality_run_id,
        build_id=root_input.build_id,
        task_id=root_input.task_id,
        builder_run_id=root_input.builder_run_id,
        parent_builder_trace_id=root_input.parent_builder_trace_id,
        artifact_version_id=root_input.artifact_version_id,
        rubric_version=root_input.rubric_version,
        judge_model=root_input.judge_model,
        source_commit_sha=root_input.source_commit_sha,
        gateway_deployed_sha=root_input.gateway_deployed_sha,
        langgraph_deployed_sha=root_input.langgraph_deployed_sha,
        operation=operation,
    )
    return _safe_model_dump(metadata, SafeQualityTraceCorrelationMetadata)


def _native_failure(error_code: QualityErrorCode | None) -> str | None:
    return f"dq1_failure:{error_code}" if error_code is not None else None


@dataclass(frozen=True)
class _ExpectedRemoteRun:
    run_id: UUID
    name: str
    trace_id: UUID
    parent_run_id: UUID | None
    inputs: dict[str, Any]
    metadata: dict[str, Any]
    tags: tuple[str, ...]


def _required_trace_client(client: object) -> object:
    if client is None:
        raise TypeError("an explicit LangSmith client is required")
    required_methods = ("create_run", "flush", "read_project", "read_run", "update_run")
    if any(not callable(getattr(client, method, None)) for method in required_methods):
        raise TypeError("an explicit LangSmith client with read, write, and flush support is required")
    if getattr(client, "_omit_traced_runtime_info", None) is not True:
        raise TypeError("the quality trace client must disable SDK runtime metadata")
    buffered_surfaces = (
        getattr(client, "tracing_queue", None),
        getattr(client, "compressed_traces", None),
        getattr(client, "_process_buffered_run_ops", None),
        getattr(client, "_pyo3_client", None),
    )
    if any(surface is not None and surface is not False for surface in buffered_surfaces):
        raise TypeError("the quality trace client must disable buffered tracing")
    return client


def _validated_flush_timeout(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("quality trace flush timeout must be a number")
    timeout = float(value)
    if not isfinite(timeout) or timeout <= 0 or timeout > MAX_QUALITY_TRACE_FLUSH_TIMEOUT_SECONDS:
        raise ValueError("quality trace flush timeout must be within the bounded range")
    return timeout


def _safe_remote_id(value: object) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


class SafeQualityOperationSpan:
    def __init__(
        self,
        *,
        operation: QualityTraceOperation,
        run: RunTree,
        owner_trace_id: str,
        finish_remote: Callable[[RunTree, dict[str, Any], str | None], None],
        mark_finished: Callable[[SafeQualityTraceOperationOutput], None],
    ) -> None:
        self._operation = operation
        self._run = run
        self._owner_trace_id = owner_trace_id
        self._finish_remote = finish_remote
        self._mark_finished = mark_finished
        self._closed = False
        self._pending_payload: dict[str, Any] | None = None
        self._pending_native_error: str | None = None

    @property
    def run_id(self) -> str:
        return str(self._run.id)

    @property
    def trace_id(self) -> str:
        return str(self._run.trace_id)

    @property
    def parent_run_id(self) -> str | None:
        value = self._run.parent_run_id
        return str(value) if value is not None else None

    def finish(self, output: SafeQualityTraceOperationOutput) -> None:
        if self._closed:
            raise SafeQualityTraceEmissionError("safe quality operation span is already closed")
        if self.trace_id != self._owner_trace_id:
            raise SafeQualityTraceEmissionError("safe quality operation span has an invalid trace root")
        if output.operation != self._operation:
            raise SafeQualityTraceEmissionError("safe quality operation output has a mismatched operation")
        payload = _safe_model_dump(output, SafeQualityTraceOperationOutput)
        native_error = _native_failure(output.error.error_code if output.error is not None else None)
        if self._pending_payload is None:
            self._pending_payload = payload
            self._pending_native_error = native_error
        elif payload != self._pending_payload or native_error != self._pending_native_error:
            raise SafeQualityTraceEmissionError("safe quality operation retry payload changed")
        self._finish_remote(self._run, payload, native_error)
        self._closed = True
        self._mark_finished(output)


class SafeQualityTrace:
    """Manual LangSmith trace tree that never accepts model-facing content."""

    def __init__(
        self,
        root_input: SafeQualityTraceRootInput,
        *,
        client: object,
        project_name: SafeIdentifier,
        flush_timeout_seconds: float = DEFAULT_QUALITY_TRACE_FLUSH_TIMEOUT_SECONDS,
    ) -> None:
        payload = _safe_model_dump(root_input, SafeQualityTraceRootInput)
        _reject_unsafe_trace_value(project_name, field_name="project_name")
        if not isinstance(project_name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", project_name):
            raise ValueError("project name must be a safe identifier")
        self._client = _required_trace_client(client)
        self._project_name = project_name
        self._flush_timeout_seconds = _validated_flush_timeout(flush_timeout_seconds)
        self._project_id = self._read_and_validate_project()
        self._root_input = root_input
        self._run_identity = derive_quality_trace_run_identity(root_input)
        root_metadata = _correlation_metadata(root_input)
        self._root = RunTree(
            id=self._run_identity.root_run_id,
            name="deck.quality.shadow",
            run_type="chain",
            inputs=payload,
            extra={"metadata": root_metadata},
            tags=["sophia_deck_quality", "dq1_safe_trace"],
            project_name=project_name,
            ls_client=self._client,
            attachments={},
            dangerously_allow_filesystem=False,
            replicas=[],
        )
        self._closed = False
        self._operation_keys: set[QualityTraceOperation] = set()
        self._finished_outputs: dict[QualityTraceOperation, SafeQualityTraceOperationOutput] = {}
        self._expected_runs: dict[UUID, _ExpectedRemoteRun] = {}
        self._expected_outputs: dict[UUID, tuple[dict[str, Any], str | None]] = {}
        self._locally_created_run_ids: set[UUID] = set()
        self._pending_root_payload: dict[str, Any] | None = None
        self._pending_root_native_error: str | None = None
        if self._root.parent_run_id is not None:
            raise SafeQualityTraceEmissionError("safe quality trace unexpectedly has a parent run")
        if self._root.replicas or self._root.attachments or self._root.extra != {"metadata": root_metadata}:
            raise SafeQualityTraceEmissionError("safe quality trace SDK construction violated the safe boundary")
        root_expected = _ExpectedRemoteRun(
            run_id=self._run_identity.root_run_id,
            name="deck.quality.shadow",
            trace_id=self._run_identity.root_run_id,
            parent_run_id=None,
            inputs=payload,
            metadata=root_metadata,
            tags=("sophia_deck_quality", "dq1_safe_trace"),
        )
        self._expected_runs[root_expected.run_id] = root_expected
        self._root_was_complete = self._ensure_remote_run(self._root, root_expected)

    def _read_and_validate_project(self) -> UUID:
        project: object | None = None
        read_failed = False
        try:
            project = self._client.read_project(project_name=self._project_name)
        except Exception:
            read_failed = True
        if read_failed:
            raise SafeQualityTraceEmissionError("safe quality trace project validation failed") from None
        project_id = _safe_remote_id(getattr(project, "id", None))
        project_matches = project_id is not None and getattr(project, "name", None) == self._project_name
        del project
        if not project_matches or project_id is None:
            raise SafeQualityTraceEmissionError("safe quality trace project validation failed") from None
        return project_id

    def _read_remote_run(self, run_id: UUID) -> object | None:
        remote: object | None = None
        read_failed = False
        try:
            remote = self._client.read_run(run_id, load_child_runs=False)
        except LangSmithNotFoundError:
            return None
        except Exception:
            read_failed = True
        if read_failed:
            raise SafeQualityTraceEmissionError("safe quality trace remote read failed") from None
        return remote

    def _validate_remote_structure(self, remote: object, expected: _ExpectedRemoteRun) -> bool | None:
        try:
            extra = getattr(remote, "extra", None)
            metadata = extra.get("metadata") if isinstance(extra, Mapping) else None
            raw_outputs = getattr(remote, "outputs", None)
            ended = getattr(remote, "end_time", None) is not None
            open_outputs = raw_outputs is None or raw_outputs == {}
            valid = (
                _safe_remote_id(getattr(remote, "id", None)) == expected.run_id
                and getattr(remote, "name", None) == expected.name
                and getattr(remote, "run_type", None) == "chain"
                and _safe_remote_id(getattr(remote, "trace_id", None)) == expected.trace_id
                and ((_safe_remote_id(getattr(remote, "parent_run_id", None)) == expected.parent_run_id) if expected.parent_run_id is not None else getattr(remote, "parent_run_id", None) is None)
                and _safe_remote_id(getattr(remote, "session_id", None)) == self._project_id
                and getattr(remote, "inputs", None) == expected.inputs
                and metadata == expected.metadata
                and tuple(getattr(remote, "tags", None) or ()) == expected.tags
                and not getattr(remote, "attachments", None)
                and not getattr(remote, "events", None)
                and not (not ended and (not open_outputs or getattr(remote, "error", None) is not None))
                and not (ended and raw_outputs is None)
            )
        except Exception:
            valid = False
            ended = False
        return ended if valid else None

    def _ensure_remote_run(
        self,
        run: RunTree,
        expected: _ExpectedRemoteRun,
        *,
        allow_create: bool = True,
    ) -> bool:
        remote = self._read_remote_run(expected.run_id)
        if remote is not None:
            remote_state = self._validate_remote_structure(remote, expected)
            del remote
            if remote_state is None:
                raise SafeQualityTraceEmissionError("safe quality trace remote state is invalid") from None
            return remote_state
        if not allow_create:
            raise SafeQualityTraceEmissionError("safe quality trace remote state is missing") from None
        post_failed = False
        try:
            run.post()
        except Exception:
            post_failed = True
        if post_failed:
            remote = self._read_remote_run(expected.run_id)
            if remote is None:
                message = "safe quality trace creation failed" if expected.parent_run_id is None else "safe quality operation trace creation failed"
                raise SafeQualityTraceEmissionError(message) from None
            remote_state = self._validate_remote_structure(remote, expected)
            del remote
            if remote_state is None:
                raise SafeQualityTraceEmissionError("safe quality trace remote state is invalid") from None
            return remote_state
        self._locally_created_run_ids.add(expected.run_id)
        return False

    def _finish_remote_run(self, run: RunTree, outputs: dict[str, Any], native_error: str | None) -> None:
        run_id = UUID(str(run.id))
        expected = self._expected_runs[run_id]
        desired = (outputs, native_error)
        prior = self._expected_outputs.get(run_id)
        if prior is not None and prior != desired:
            raise SafeQualityTraceEmissionError("safe quality trace retry payload changed")
        self._expected_outputs[run_id] = desired

        if run_id not in self._locally_created_run_ids:
            remote = self._read_remote_run(run_id)
            if remote is None:
                raise SafeQualityTraceEmissionError("safe quality trace remote state is missing") from None
            remote_state = self._validate_remote_structure(remote, expected)
            terminal_matches = getattr(remote, "outputs", None) == outputs and getattr(remote, "error", None) == native_error
            del remote
            if remote_state is None:
                raise SafeQualityTraceEmissionError("safe quality trace remote state is invalid") from None
            if remote_state:
                if not terminal_matches:
                    raise SafeQualityTraceEmissionError("safe quality trace remote terminal state is invalid") from None
                return

        update_failed = False
        try:
            self._client.update_run(
                run_id=run_id,
                outputs=outputs,
                error=native_error,
                end_time=datetime.now(UTC),
            )
        except Exception:
            update_failed = True
        if update_failed:
            remote = self._read_remote_run(run_id)
            message = "safe quality trace update failed" if expected.parent_run_id is None else "safe quality operation trace update failed"
            if remote is None:
                raise SafeQualityTraceEmissionError(message) from None
            remote_state = self._validate_remote_structure(remote, expected)
            terminal_matches = getattr(remote, "outputs", None) == outputs and getattr(remote, "error", None) == native_error
            del remote
            if remote_state is not True:
                raise SafeQualityTraceEmissionError(message) from None
            if not terminal_matches:
                raise SafeQualityTraceEmissionError(message) from None

    def _flush_and_verify(self) -> None:
        flush_failed = False
        try:
            self._client.flush(timeout=self._flush_timeout_seconds)
        except Exception:
            flush_failed = True
        if flush_failed:
            raise SafeQualityTraceEmissionError("safe quality trace flush failed") from None
        if set(self._expected_runs) != {
            self._run_identity.root_run_id,
            *(item.run_id for item in self._run_identity.operation_run_ids),
        }:
            raise SafeQualityTraceEmissionError("safe quality trace readback coverage is invalid")
        if set(self._expected_outputs) != set(self._expected_runs):
            raise SafeQualityTraceEmissionError("safe quality trace readback coverage is invalid")
        for run_id, expected in self._expected_runs.items():
            remote = self._read_remote_run(run_id)
            if remote is None:
                raise SafeQualityTraceEmissionError("safe quality trace remote state is missing") from None
            remote_state = self._validate_remote_structure(remote, expected)
            outputs, native_error = self._expected_outputs[run_id]
            terminal_matches = getattr(remote, "outputs", None) == outputs and getattr(remote, "error", None) == native_error
            del remote
            if remote_state is not True:
                raise SafeQualityTraceEmissionError("safe quality trace remote state is invalid") from None
            if not terminal_matches:
                raise SafeQualityTraceEmissionError("safe quality trace remote terminal state is invalid") from None

    @property
    def run_id(self) -> str:
        return str(self._root.id)

    @property
    def trace_id(self) -> str:
        return str(self._root.trace_id)

    @property
    def parent_run_id(self) -> str | None:
        value = self._root.parent_run_id
        return str(value) if value is not None else None

    @property
    def run_identity(self) -> SafeQualityTraceRunIdentity:
        return self._run_identity

    @property
    def operation_terminals(self) -> ExactOperationTerminals:
        if set(self._finished_outputs) != set(REQUIRED_QUALITY_TRACE_OPERATIONS):
            raise SafeQualityTraceEmissionError("safe quality trace does not have exact terminal coverage")
        return tuple(SafeQualityTraceOperationTerminal.from_output(self._finished_outputs[operation]) for operation in REQUIRED_QUALITY_TRACE_OPERATIONS)

    def start_operation(self, operation_input: SafeQualityTraceOperationInput) -> SafeQualityOperationSpan:
        if self._closed:
            raise SafeQualityTraceEmissionError("safe quality trace is already closed")
        payload = _safe_model_dump(operation_input, SafeQualityTraceOperationInput)
        if operation_input.quality_run_id != self._root_input.quality_run_id:
            raise SafeQualityTraceEmissionError("safe quality operation has a mismatched quality run")
        if operation_input.artifact_version_id != self._root_input.artifact_version_id:
            raise SafeQualityTraceEmissionError("safe quality operation has a mismatched artifact version")
        if operation_input.rubric_hash != self._root_input.rubric_hash:
            raise SafeQualityTraceEmissionError("safe quality operation has a mismatched rubric")
        operation = operation_input.operation
        if operation in self._operation_keys:
            raise SafeQualityTraceEmissionError("safe quality operation is duplicated")
        child_metadata = _correlation_metadata(self._root_input, operation=operation)
        child = self._root.create_child(
            name=operation,
            run_type="chain",
            run_id=self._run_identity.operation_run_id(operation),
            inputs=payload,
            extra={"metadata": child_metadata},
            tags=["sophia_deck_quality_operation", "dq1_safe_trace"],
            attachments={},
        )
        if child.parent_run_id != self._root.id or child.trace_id != self._root.trace_id:
            raise SafeQualityTraceEmissionError("safe quality operation linkage is invalid")
        if child.replicas or child.attachments or child.extra != {"metadata": child_metadata}:
            raise SafeQualityTraceEmissionError("safe quality operation SDK construction violated the safe boundary")
        expected = _ExpectedRemoteRun(
            run_id=self._run_identity.operation_run_id(operation),
            name=operation,
            trace_id=self._run_identity.root_run_id,
            parent_run_id=self._run_identity.root_run_id,
            inputs=payload,
            metadata=child_metadata,
            tags=("sophia_deck_quality_operation", "dq1_safe_trace"),
        )
        self._expected_runs[expected.run_id] = expected
        remote_complete = self._ensure_remote_run(
            child,
            expected,
            allow_create=not self._root_was_complete,
        )
        if self._root_was_complete and not remote_complete:
            raise SafeQualityTraceEmissionError("safe quality trace completed root has an incomplete operation")
        self._operation_keys.add(operation)
        return SafeQualityOperationSpan(
            operation=operation,
            run=child,
            owner_trace_id=self.trace_id,
            finish_remote=self._finish_remote_run,
            mark_finished=lambda output: self._finished_outputs.__setitem__(operation, output),
        )

    def finish(self, output: SafeQualityTraceRootOutput) -> None:
        if self._closed:
            raise SafeQualityTraceEmissionError("safe quality trace is already closed")
        if self._operation_keys != set(REQUIRED_QUALITY_TRACE_OPERATIONS):
            raise SafeQualityTraceEmissionError("safe quality trace does not cover all eight operations")
        if set(self._finished_outputs) != self._operation_keys:
            raise SafeQualityTraceEmissionError("safe quality trace has an unfinished operation")
        if output.operation_terminals != self.operation_terminals:
            raise SafeQualityTraceEmissionError("safe quality trace terminal summary does not match its operations")
        for operation in _RESULT_OPERATIONS:
            operation_output = self._finished_outputs[operation]
            if operation_output.status == "completed" and operation_output.shadow_result != output.shadow_result:
                raise SafeQualityTraceEmissionError("safe quality trace result does not match terminal operations")
        payload = _safe_model_dump(output, SafeQualityTraceRootOutput)
        native_error = _native_failure(output.error_code)
        if self._pending_root_payload is None:
            self._pending_root_payload = payload
            self._pending_root_native_error = native_error
        elif payload != self._pending_root_payload or native_error != self._pending_root_native_error:
            raise SafeQualityTraceEmissionError("safe quality trace retry payload changed")
        self._finish_remote_run(self._root, payload, native_error)
        self._flush_and_verify()
        self._closed = True
