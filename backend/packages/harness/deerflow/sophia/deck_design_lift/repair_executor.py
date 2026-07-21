"""Durable invoke-once fence for the single DQ-2 repair author call.

The provider has no documented idempotency key.  Consequently, a durable
intent without a durable canonical result is permanently ambiguous: a retry
may not issue another author call.  This module stores only request identity
hashes, the structured repair candidate, and allowlisted invocation metrics.
Private prompts and raw provider request/response payloads never cross this
boundary.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Annotated, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.sophia.deck_design_lift.invoker import (
    DeckRepairInvocationMetrics,
    DeckRepairInvocationResult,
)
from deerflow.sophia.deck_design_lift.runtime import (
    DeckRepairTraceCompletionPending,
    RepairInvocationRequest,
)
from deerflow.sophia.deck_design_lift.schemas import DeckRepairCandidate
from deerflow.sophia.deck_quality.canonical import (
    canonical_json_bytes,
    canonical_sha256,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    ArtifactObjectSizeError,
    normalize_object_path,
    safe_object_path_segment,
)

MAX_REPAIR_INTENT_BYTES = 16 * 1024
MAX_REPAIR_RESULT_BYTES = 512 * 1024
MAX_REPAIR_INPUT_TOKENS = 2_000_000
MAX_REPAIR_OUTPUT_TOKENS = 24_000
MAX_REPAIR_LATENCY_MS = 15 * 60 * 1_000

_JSON_CONTENT_TYPE = "application/json"
_CORRELATION_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9:_-]*$"
_STORAGE_SEGMENT_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._=-]*$"
_SHA256_PATTERN = r"^[0-9a-f]{64}$"

CorrelationId = Annotated[
    str,
    Field(min_length=8, max_length=128, pattern=_CORRELATION_PATTERN),
]
StorageSegment = Annotated[
    str,
    Field(min_length=1, max_length=128, pattern=_STORAGE_SEGMENT_PATTERN),
]
Sha256 = Annotated[str, Field(pattern=_SHA256_PATTERN)]

RepairInvokeOnceErrorCode = Literal[
    "invalid_request_scope",
    "storage_unavailable",
    "intent_oversize",
    "intent_invalid",
    "intent_conflict",
    "invocation_ambiguous",
    "author_failed",
    "author_result_invalid",
    "result_oversize",
    "result_invalid",
    "result_conflict",
    "result_persistence_ambiguous",
]


class DeckRepairInvokeOnceError(RuntimeError):
    """Content-free terminal failure at the repair invoke-once boundary."""

    def __init__(self, code: RepairInvokeOnceErrorCode) -> None:
        self.code = code
        super().__init__(code)


class AsyncImmutableObjectStore(Protocol):
    """The bounded create-only subset required by the repair fence."""

    async def read_bounded(
        self,
        object_path: str,
        *,
        max_bytes: int,
    ) -> bytes | None: ...

    async def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> Literal["created", "exists"]: ...


class DeckRepairAuthor(Protocol):
    async def __call__(
        self,
        request: RepairInvocationRequest,
    ) -> DeckRepairInvocationResult: ...

    async def complete_success_trace(
        self,
        request: RepairInvocationRequest,
        result: DeckRepairInvocationResult,
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class RepairInvocationObjectPaths:
    intent: str
    result: str


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _RepairInvocationIdentity(_StrictFrozenModel):
    campaign_run_id: CorrelationId
    experiment_id: CorrelationId
    user_id: StorageSegment
    thread_id: StorageSegment
    build_id: StorageSegment
    operation_id: StorageSegment
    transaction_id: StorageSegment
    initial_artifact_version_id: CorrelationId
    repair_program_hash: Sha256


class _RepairInvocationIntent(_StrictFrozenModel):
    schema_version: Literal["sophia-deck-repair-call-intent/v1"] = "sophia-deck-repair-call-intent/v1"
    identity: _RepairInvocationIdentity
    initial_manifest_revision: int = Field(ge=1)
    repair_attempt: Literal[1] = 1
    request_identity_hash: Sha256

    @model_validator(mode="after")
    def validate_request_identity_hash(self) -> _RepairInvocationIntent:
        expected = canonical_sha256(
            {
                "identity": self.identity,
                "initial_manifest_revision": self.initial_manifest_revision,
                "repair_attempt": self.repair_attempt,
            }
        )
        if self.request_identity_hash != expected:
            raise ValueError("repair intent identity hash mismatch")
        return self


class _PersistedRepairMetrics(_StrictFrozenModel):
    latency_ms: int = Field(ge=0, le=MAX_REPAIR_LATENCY_MS)
    input_tokens: int = Field(ge=0, le=MAX_REPAIR_INPUT_TOKENS)
    output_tokens: int = Field(ge=0, le=MAX_REPAIR_OUTPUT_TOKENS)
    total_tokens: int = Field(ge=0, le=MAX_REPAIR_INPUT_TOKENS + MAX_REPAIR_OUTPUT_TOKENS)
    deployment_name: Literal["openai-gpt-5-6-sol"]
    provider: Literal["openai"]
    provider_model: Literal["gpt-5.6-sol"]
    route_name: Literal["deck.repair.executor"]
    profile_version: Literal["v1"]
    plan_hash: Sha256
    payload_hash: Sha256

    @model_validator(mode="after")
    def validate_usage_sum(self) -> _PersistedRepairMetrics:
        if self.total_tokens != self.input_tokens + self.output_tokens:
            raise ValueError("repair invocation token totals disagree")
        return self


class _RepairInvocationResultArtifact(_StrictFrozenModel):
    schema_version: Literal["sophia-deck-repair-call-result/v1"] = "sophia-deck-repair-call-result/v1"
    identity: _RepairInvocationIdentity
    intent_hash: Sha256
    candidate: DeckRepairCandidate
    candidate_hash: Sha256
    metrics: _PersistedRepairMetrics

    @model_validator(mode="after")
    def validate_candidate_hash(self) -> _RepairInvocationResultArtifact:
        if self.candidate_hash != canonical_sha256(self.candidate):
            raise ValueError("repair candidate hash mismatch")
        return self


def _reject_json_constant(_value: str) -> None:
    raise ValueError


def _parse_canonical[ModelT: BaseModel](
    raw: bytes,
    model: type[ModelT],
    *,
    invalid_code: RepairInvokeOnceErrorCode,
) -> ModelT:
    try:
        json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        parsed = model.model_validate_json(raw)
        if canonical_json_bytes(parsed) != raw:
            raise ValueError
        return parsed
    except Exception:
        raise DeckRepairInvokeOnceError(invalid_code) from None


def _require_path_segment(value: str) -> str:
    if safe_object_path_segment(value, default="invalid") != value:
        raise DeckRepairInvokeOnceError("invalid_request_scope")
    return value


def repair_invocation_object_paths(
    request: RepairInvocationRequest,
) -> RepairInvocationObjectPaths:
    """Return the only object paths admitted for this transaction repair."""

    if not isinstance(request, RepairInvocationRequest):
        raise DeckRepairInvokeOnceError("invalid_request_scope")
    if request.build_id != request.program.build_id:
        raise DeckRepairInvokeOnceError("invalid_request_scope")
    user_id = _require_path_segment(request.user_id)
    thread_id = _require_path_segment(request.thread_id)
    build_id = _require_path_segment(request.build_id)
    transaction_id = _require_path_segment(request.transaction_id)
    operation_id = _require_path_segment(request.operation_id)
    root = normalize_object_path(f"artifacts/{user_id}/{thread_id}/foundation/.builder/builds/{build_id}/deck_design_lift/transactions/{transaction_id}/repair_call/{operation_id}")
    return RepairInvocationObjectPaths(
        intent=f"{root}/intent.json",
        result=f"{root}/result.json",
    )


def _request_identity(request: RepairInvocationRequest) -> _RepairInvocationIdentity:
    try:
        return _RepairInvocationIdentity(
            campaign_run_id=request.campaign_run_id,
            experiment_id=request.experiment_id,
            user_id=request.user_id,
            thread_id=request.thread_id,
            build_id=request.build_id,
            operation_id=request.operation_id,
            transaction_id=request.transaction_id,
            initial_artifact_version_id=request.initial_artifact_version_id,
            repair_program_hash=request.program.program_hash,
        )
    except Exception:
        raise DeckRepairInvokeOnceError("invalid_request_scope") from None


def _request_intent(request: RepairInvocationRequest) -> _RepairInvocationIntent:
    identity = _request_identity(request)
    payload = {
        "identity": identity,
        "initial_manifest_revision": request.program.initial_manifest_revision,
        "repair_attempt": request.program.repair_attempt,
    }
    return _RepairInvocationIntent(
        **payload,
        request_identity_hash=canonical_sha256(payload),
    )


def _persisted_metrics(
    metrics: DeckRepairInvocationMetrics,
) -> _PersistedRepairMetrics:
    if not isinstance(metrics, DeckRepairInvocationMetrics):
        raise DeckRepairInvokeOnceError("author_result_invalid")
    try:
        return _PersistedRepairMetrics(
            latency_ms=metrics.latency_ms,
            input_tokens=metrics.input_tokens,
            output_tokens=metrics.output_tokens,
            total_tokens=metrics.total_tokens,
            deployment_name=metrics.deployment_name,
            provider=metrics.provider,
            provider_model=metrics.provider_model,
            route_name=metrics.route_name,
            profile_version=metrics.profile_version,
            plan_hash=metrics.plan_hash,
            payload_hash=metrics.payload_hash,
        )
    except DeckRepairInvokeOnceError:
        raise
    except Exception:
        raise DeckRepairInvokeOnceError("author_result_invalid") from None


def _result_artifact(
    *,
    result: DeckRepairInvocationResult,
    identity: _RepairInvocationIdentity,
    intent_hash: str,
) -> _RepairInvocationResultArtifact:
    if not isinstance(result, DeckRepairInvocationResult) or not isinstance(
        result.candidate,
        DeckRepairCandidate,
    ):
        raise DeckRepairInvokeOnceError("author_result_invalid")
    try:
        return _RepairInvocationResultArtifact(
            identity=identity,
            intent_hash=intent_hash,
            candidate=result.candidate,
            candidate_hash=canonical_sha256(result.candidate),
            metrics=_persisted_metrics(result.metrics),
        )
    except DeckRepairInvokeOnceError:
        raise
    except Exception:
        raise DeckRepairInvokeOnceError("author_result_invalid") from None


def _invocation_result(
    artifact: _RepairInvocationResultArtifact,
) -> DeckRepairInvocationResult:
    """Rehydrate only the exact allowlisted result persisted by the fence."""

    try:
        metrics = DeckRepairInvocationMetrics(
            **artifact.metrics.model_dump(mode="python")
        )
        return DeckRepairInvocationResult(
            candidate=artifact.candidate,
            metrics=metrics,
        )
    except Exception:
        raise DeckRepairInvokeOnceError("result_invalid") from None


class DurableDeckRepairExecutor:
    """Object-store-backed, transaction-scoped one-call repair executor."""

    def __init__(
        self,
        *,
        object_store: AsyncImmutableObjectStore,
        author: DeckRepairAuthor,
    ) -> None:
        if not callable(getattr(object_store, "read_bounded", None)) or not callable(getattr(object_store, "create_if_absent", None)):
            raise ValueError("repair executor requires an async immutable object store")
        if not callable(author) or not callable(
            getattr(author, "complete_success_trace", None)
        ):
            raise ValueError("repair executor requires one repair author")
        self._objects = object_store
        self._author = author

    async def _read(
        self,
        object_path: str,
        *,
        max_bytes: int,
        oversize_code: RepairInvokeOnceErrorCode,
    ) -> bytes | None:
        try:
            raw = await self._objects.read_bounded(
                object_path,
                max_bytes=max_bytes,
            )
        except ArtifactObjectSizeError:
            raise DeckRepairInvokeOnceError(oversize_code) from None
        except Exception:
            raise DeckRepairInvokeOnceError("storage_unavailable") from None
        if raw is not None and not isinstance(raw, bytes):
            raise DeckRepairInvokeOnceError("storage_unavailable")
        return raw

    async def _read_intent(self, path: str) -> bytes | None:
        return await self._read(
            path,
            max_bytes=MAX_REPAIR_INTENT_BYTES,
            oversize_code="intent_oversize",
        )

    async def _read_result(self, path: str) -> bytes | None:
        return await self._read(
            path,
            max_bytes=MAX_REPAIR_RESULT_BYTES,
            oversize_code="result_oversize",
        )

    @staticmethod
    def _verify_intent(
        raw: bytes,
        *,
        expected: _RepairInvocationIntent,
        expected_bytes: bytes,
    ) -> None:
        parsed = _parse_canonical(
            raw,
            _RepairInvocationIntent,
            invalid_code="intent_invalid",
        )
        if parsed != expected or raw != expected_bytes:
            raise DeckRepairInvokeOnceError("intent_conflict")

    @staticmethod
    def _verify_result(
        raw: bytes,
        *,
        identity: _RepairInvocationIdentity,
        intent_hash: str,
        expected_bytes: bytes | None = None,
    ) -> _RepairInvocationResultArtifact:
        parsed = _parse_canonical(
            raw,
            _RepairInvocationResultArtifact,
            invalid_code="result_invalid",
        )
        if parsed.identity != identity or parsed.intent_hash != intent_hash or (expected_bytes is not None and raw != expected_bytes):
            raise DeckRepairInvokeOnceError("result_conflict")
        return parsed

    async def _load_valid_result(
        self,
        path: str,
        *,
        identity: _RepairInvocationIdentity,
        intent_hash: str,
        expected_bytes: bytes | None = None,
    ) -> _RepairInvocationResultArtifact | None:
        raw = await self._read_result(path)
        if raw is None:
            return None
        return self._verify_result(
            raw,
            identity=identity,
            intent_hash=intent_hash,
            expected_bytes=expected_bytes,
        )

    async def _complete_persisted_result(
        self,
        request: RepairInvocationRequest,
        artifact: _RepairInvocationResultArtifact,
    ) -> DeckRepairCandidate:
        result = _invocation_result(artifact)
        try:
            await self._author.complete_success_trace(request, result)
        except Exception:
            # The result is already exact and durable.  Preserve the prepared
            # transaction so recovery can retry this trace-only boundary while
            # the invoke-once provider fence remains consumed.
            raise DeckRepairTraceCompletionPending(
                "repair success trace completion is pending"
            ) from None
        return artifact.candidate

    async def invoke_once(
        self,
        request: RepairInvocationRequest,
    ) -> DeckRepairCandidate:
        paths = repair_invocation_object_paths(request)
        intent = _request_intent(request)
        intent_bytes = canonical_json_bytes(intent)
        if len(intent_bytes) > MAX_REPAIR_INTENT_BYTES:
            raise DeckRepairInvokeOnceError("intent_oversize")
        intent_hash = hashlib.sha256(intent_bytes).hexdigest()

        existing_intent = await self._read_intent(paths.intent)
        if existing_intent is not None:
            self._verify_intent(
                existing_intent,
                expected=intent,
                expected_bytes=intent_bytes,
            )
            persisted = await self._load_valid_result(
                paths.result,
                identity=intent.identity,
                intent_hash=intent_hash,
            )
            if persisted is not None:
                return await self._complete_persisted_result(request, persisted)
            raise DeckRepairInvokeOnceError("invocation_ambiguous")

        # A result can never safely stand alone.  Check before claiming the
        # intent so a corrupt/orphaned result cannot be hidden by a new write.
        if await self._read_result(paths.result) is not None:
            raise DeckRepairInvokeOnceError("result_invalid")

        try:
            outcome = await self._objects.create_if_absent(
                paths.intent,
                intent_bytes,
                content_type=_JSON_CONTENT_TYPE,
            )
        except Exception:
            # A lost create response may mean another worker owns the fence.
            # Even exact readback is therefore ambiguous and cannot authorize
            # a provider call.
            observed = await self._read_intent(paths.intent)
            if observed is not None:
                self._verify_intent(
                    observed,
                    expected=intent,
                    expected_bytes=intent_bytes,
                )
                raise DeckRepairInvokeOnceError("invocation_ambiguous") from None
            raise DeckRepairInvokeOnceError("storage_unavailable") from None
        if outcome not in {"created", "exists"}:
            raise DeckRepairInvokeOnceError("storage_unavailable")

        observed_intent = await self._read_intent(paths.intent)
        if observed_intent is None:
            raise DeckRepairInvokeOnceError("storage_unavailable")
        self._verify_intent(
            observed_intent,
            expected=intent,
            expected_bytes=intent_bytes,
        )
        if outcome == "exists":
            persisted = await self._load_valid_result(
                paths.result,
                identity=intent.identity,
                intent_hash=intent_hash,
            )
            if persisted is not None:
                return await self._complete_persisted_result(request, persisted)
            raise DeckRepairInvokeOnceError("invocation_ambiguous")

        try:
            authored = await self._author(request)
        except Exception:
            raise DeckRepairInvokeOnceError("author_failed") from None
        artifact = _result_artifact(
            result=authored,
            identity=intent.identity,
            intent_hash=intent_hash,
        )
        result_bytes = canonical_json_bytes(artifact)
        if len(result_bytes) > MAX_REPAIR_RESULT_BYTES:
            raise DeckRepairInvokeOnceError("result_oversize")

        try:
            result_outcome = await self._objects.create_if_absent(
                paths.result,
                result_bytes,
                content_type=_JSON_CONTENT_TYPE,
            )
        except Exception:
            # Reconcile a lost upload acknowledgement.  Exact readback is a
            # completed result; absence is permanently fenced and ambiguous.
            persisted = await self._load_valid_result(
                paths.result,
                identity=intent.identity,
                intent_hash=intent_hash,
                expected_bytes=result_bytes,
            )
            if persisted is not None:
                return await self._complete_persisted_result(request, persisted)
            raise DeckRepairInvokeOnceError("result_persistence_ambiguous") from None
        if result_outcome not in {"created", "exists"}:
            raise DeckRepairInvokeOnceError("result_persistence_ambiguous")

        persisted = await self._load_valid_result(
            paths.result,
            identity=intent.identity,
            intent_hash=intent_hash,
            expected_bytes=result_bytes,
        )
        if persisted is None:
            raise DeckRepairInvokeOnceError("result_persistence_ambiguous")
        return await self._complete_persisted_result(request, persisted)


__all__ = [
    "AsyncImmutableObjectStore",
    "DeckRepairAuthor",
    "DeckRepairInvokeOnceError",
    "DurableDeckRepairExecutor",
    "MAX_REPAIR_INTENT_BYTES",
    "MAX_REPAIR_RESULT_BYTES",
    "RepairInvocationObjectPaths",
    "repair_invocation_object_paths",
]
