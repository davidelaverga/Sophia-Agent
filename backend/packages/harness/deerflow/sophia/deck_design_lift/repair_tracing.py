"""Content-free LangSmith trace for the single DQ-2 repair invocation.

The repair provider boundary is deliberately untraced because its request and
response contain private deck material.  This module emits one separate manual
LangSmith run containing only frozen correlation identifiers, canonical hashes,
and bounded invocation metrics.  Deterministic run identity plus strict remote
readback makes create/update retries safe without ever accepting model-facing
content.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from math import isfinite
from typing import Annotated, Any, Literal, Protocol
from urllib.parse import urlsplit
from uuid import UUID, uuid5

from langsmith import Client as LangSmithClient
from langsmith.utils import LangSmithNotFoundError
from pydantic import BaseModel, ConfigDict, Field, model_validator

from deerflow.sophia.deck_design_lift.runtime import RepairInvocationRequest

_EU_LANGSMITH_ENDPOINT = "https://eu.api.smith.langchain.com"
_TRACE_NAME = "deck.repair.author"
_TRACE_TAGS = ("sophia_deck_design_lift", "dq2_safe_repair_trace")
_TRACE_ID_NAMESPACE = UUID("8071714f-74eb-54f8-b2d8-d64926548197")
_MAX_INPUT_TOKENS = 2_000_000
_MAX_OUTPUT_TOKENS = 12_000
_MAX_LATENCY_MS = 15 * 60 * 1_000
_DEFAULT_FLUSH_TIMEOUT_SECONDS = 15.0
_MAX_FLUSH_TIMEOUT_SECONDS = 30.0

SafeIdentifier = Annotated[
    str,
    Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
RepairTraceErrorCode = Literal["repair_unavailable", "candidate_invalid"]

_FORBIDDEN_FIELD_NAMES = frozenset(
    {
        "api_key",
        "attachments",
        "authorization",
        "candidate",
        "candidate_content",
        "context",
        "credential",
        "credentials",
        "exception",
        "exception_text",
        "html",
        "image",
        "images",
        "message",
        "messages",
        "output",
        "path",
        "prompt",
        "provider_payload",
        "raw_exception",
        "secret",
        "source",
        "sources",
        "token",
        "url",
    }
)
_FORBIDDEN_VALUE_MARKERS = (
    "api-key",
    "api_key",
    "authorization",
    "base64",
    "bearer ",
    "candidate_content",
    "data:image",
    "exception:",
    "file://",
    "gs://",
    "http://",
    "https://",
    "provider_payload",
    "s3://",
    "signature=",
    "signed_url",
    "traceback",
    "x-amz-",
    "x-goog-",
)
_PATH_PREFIX = re.compile(r"^(?:/|\.{1,2}/|~/|[A-Za-z]:[\\/])")
_BASE64_BLOB = re.compile(r"^[A-Za-z0-9+/_-]{80,}={0,2}$")
_CREDENTIAL_TOKEN = re.compile(
    r"^(?:lsv2_sk_|sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|eyj[a-z0-9_-]{10,}\.)",
    re.IGNORECASE,
)
_EXCEPTION_TEXT = re.compile(
    r"(?:^|[._-])(?:[a-z]+error|exception)(?:$|[._:-])",
    re.IGNORECASE,
)


def _reject_unsafe_trace_value(
    value: Any,
    *,
    field_name: str | None = None,
) -> None:
    if isinstance(value, BaseModel):
        _reject_unsafe_trace_value(
            value.model_dump(mode="python"),
            field_name=field_name,
        )
        return
    if isinstance(value, Mapping):
        for raw_key, item in value.items():
            key = str(raw_key).lower()
            if key in _FORBIDDEN_FIELD_NAMES or key.endswith(
                (
                    "_authorization",
                    "_credential",
                    "_message",
                    "_path",
                    "_prompt",
                    "_secret",
                    "_source",
                    "_token",
                    "_url",
                )
            ):
                raise ValueError("unsafe field is forbidden in DQ-2 repair traces")
            _reject_unsafe_trace_value(item, field_name=key)
        return
    if isinstance(value, Sequence) and not isinstance(
        value,
        (str, bytes, bytearray),
    ):
        for item in value:
            _reject_unsafe_trace_value(item, field_name=field_name)
        return
    if isinstance(value, (bytes, bytearray, memoryview)):
        raise ValueError("binary content is forbidden in DQ-2 repair traces")
    if not isinstance(value, str):
        return

    lowered = value.lower()
    if any(marker in lowered for marker in _FORBIDDEN_VALUE_MARKERS):
        raise ValueError("unsafe value is forbidden in DQ-2 repair traces")
    if _CREDENTIAL_TOKEN.search(value) or (field_name != "error_code" and _EXCEPTION_TEXT.search(value)):
        raise ValueError("credential or exception content is forbidden in DQ-2 repair traces")
    if field_name != "schema_version" and (_PATH_PREFIX.search(value) or "\\" in value):
        raise ValueError("filesystem paths are forbidden in DQ-2 repair traces")
    if field_name not in {"payload_hash", "plan_hash", "program_hash"} and _BASE64_BLOB.fullmatch(value):
        raise ValueError("base64-like content is forbidden in DQ-2 repair traces")


class _SafeTraceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    @model_validator(mode="before")
    @classmethod
    def reject_unsafe_content(cls, value: Any) -> Any:
        _reject_unsafe_trace_value(value)
        return value


class SafeDeckRepairTraceInput(_SafeTraceModel):
    """The exact input whitelist for the manual repair trace."""

    schema_version: Literal["deck-repair-safe-trace-input/v1"] = "deck-repair-safe-trace-input/v1"
    campaign_run_id: SafeIdentifier
    experiment_id: SafeIdentifier
    build_id: SafeIdentifier
    user_id: SafeIdentifier
    operation_id: SafeIdentifier
    transaction_id: SafeIdentifier
    initial_quality_run_id: SafeIdentifier
    program_hash: Sha256
    payload_hash: Sha256
    plan_hash: Sha256


class SafeDeckRepairTraceMetadata(_SafeTraceModel):
    """The exact metadata whitelist used for production trace correlation."""

    schema_version: Literal["deck-repair-safe-trace-metadata/v1"] = "deck-repair-safe-trace-metadata/v1"
    operation: Literal["deck.repair.author"] = "deck.repair.author"
    ls_run_depth: Literal[0] = 0
    campaign_run_id: SafeIdentifier
    experiment_id: SafeIdentifier
    build_id: SafeIdentifier
    user_id: SafeIdentifier
    operation_id: SafeIdentifier
    transaction_id: SafeIdentifier
    initial_quality_run_id: SafeIdentifier
    program_hash: Sha256
    payload_hash: Sha256
    plan_hash: Sha256


class SafeDeckRepairTraceOutput(_SafeTraceModel):
    """Hash-free terminal metrics; no model output crosses this surface."""

    schema_version: Literal["deck-repair-safe-trace-output/v1"] = "deck-repair-safe-trace-output/v1"
    status: Literal["completed", "error"]
    invoke_attempt_count: Literal[1] = 1
    latency_ms: int = Field(ge=0, le=_MAX_LATENCY_MS)
    input_tokens: int = Field(ge=0, le=_MAX_INPUT_TOKENS)
    output_tokens: int | None = Field(default=None, ge=0, le=_MAX_OUTPUT_TOKENS)
    total_tokens: int | None = Field(
        default=None,
        ge=0,
        le=_MAX_INPUT_TOKENS + _MAX_OUTPUT_TOKENS,
    )
    error_code: RepairTraceErrorCode | None = None

    @model_validator(mode="after")
    def align_terminal_metrics(self) -> SafeDeckRepairTraceOutput:
        if self.status == "completed":
            if self.output_tokens is None or self.total_tokens is None or self.total_tokens != self.input_tokens + self.output_tokens or self.error_code is not None:
                raise ValueError("completed repair traces require exact token metrics")
        elif self.output_tokens is not None or self.total_tokens is not None or self.error_code is None:
            raise ValueError("failed repair traces require only a controlled error code")
        return self


class SafeDeckRepairTraceEmissionError(RuntimeError):
    """Content-free signal that the repair trace could not be proven durable."""


class DeckRepairTraceSpan(Protocol):
    @property
    def already_terminal(self) -> bool: ...

    def finish(self, output: SafeDeckRepairTraceOutput) -> None: ...


class DeckRepairTraceFactory(Protocol):
    def __call__(
        self,
        trace_input: SafeDeckRepairTraceInput,
    ) -> DeckRepairTraceSpan: ...


def safe_deck_repair_trace_input(
    *,
    request: RepairInvocationRequest,
    payload_hash: str,
    plan_hash: str,
) -> SafeDeckRepairTraceInput:
    """Project a repair request onto the non-content trace whitelist."""

    if not isinstance(request, RepairInvocationRequest):
        raise TypeError("RepairInvocationRequest instance required")
    return SafeDeckRepairTraceInput(
        campaign_run_id=request.campaign_run_id,
        experiment_id=request.experiment_id,
        build_id=request.build_id,
        user_id=request.user_id,
        operation_id=request.operation_id,
        transaction_id=request.transaction_id,
        initial_quality_run_id=request.program.initial_quality_run_id,
        program_hash=request.program.program_hash,
        payload_hash=payload_hash,
        plan_hash=plan_hash,
    )


def derive_deck_repair_trace_run_id(
    trace_input: SafeDeckRepairTraceInput,
) -> UUID:
    if type(trace_input) is not SafeDeckRepairTraceInput:
        raise TypeError("SafeDeckRepairTraceInput instance required")
    identity = "\x1f".join(
        (
            trace_input.campaign_run_id,
            trace_input.experiment_id,
            trace_input.build_id,
            trace_input.user_id,
            trace_input.operation_id,
            trace_input.transaction_id,
            trace_input.initial_quality_run_id,
            trace_input.program_hash,
            trace_input.payload_hash,
            trace_input.plan_hash,
        )
    )
    return uuid5(_TRACE_ID_NAMESPACE, identity)


def _root_dotted_order(*, start_time: datetime, run_id: UUID) -> str:
    """Return LangSmith's canonical root-run ordering key."""

    if not isinstance(start_time, datetime) or start_time.tzinfo is None or start_time.utcoffset() is None or not isinstance(run_id, UUID):
        raise TypeError("safe repair trace ordering identity is invalid")
    normalized = start_time.astimezone(UTC)
    return normalized.strftime("%Y%m%dT%H%M%S%fZ") + str(run_id)


def _safe_model_dump(
    value: _SafeTraceModel,
    expected_type: type[_SafeTraceModel],
) -> dict[str, Any]:
    if type(value) is not expected_type:
        raise TypeError(f"{expected_type.__name__} instance required")
    payload = value.model_dump(mode="json", exclude_none=True)
    _reject_unsafe_trace_value(payload)
    return payload


def _trace_metadata(trace_input: SafeDeckRepairTraceInput) -> dict[str, Any]:
    metadata = SafeDeckRepairTraceMetadata(
        ls_run_depth=0,
        campaign_run_id=trace_input.campaign_run_id,
        experiment_id=trace_input.experiment_id,
        build_id=trace_input.build_id,
        user_id=trace_input.user_id,
        operation_id=trace_input.operation_id,
        transaction_id=trace_input.transaction_id,
        initial_quality_run_id=trace_input.initial_quality_run_id,
        program_hash=trace_input.program_hash,
        payload_hash=trace_input.payload_hash,
        plan_hash=trace_input.plan_hash,
    )
    return _safe_model_dump(metadata, SafeDeckRepairTraceMetadata)


def _required_trace_client(client: object) -> object:
    if client is None:
        raise TypeError("an explicit LangSmith client is required")
    required = ("create_run", "flush", "read_project", "read_run", "update_run")
    if any(not callable(getattr(client, method, None)) for method in required):
        raise TypeError("repair tracing requires an explicit read/write LangSmith client")
    if getattr(client, "_omit_traced_runtime_info", None) is not True:
        raise TypeError("repair trace client must disable SDK runtime metadata")
    buffered_surfaces = (
        getattr(client, "tracing_queue", None),
        getattr(client, "compressed_traces", None),
        getattr(client, "_process_buffered_run_ops", None),
        getattr(client, "_pyo3_client", None),
    )
    if any(value is not None and value is not False for value in buffered_surfaces):
        raise TypeError("repair trace client must disable buffered tracing")
    return client


def _validated_flush_timeout(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("repair trace flush timeout must be numeric")
    timeout = float(value)
    if not isfinite(timeout) or timeout <= 0 or timeout > _MAX_FLUSH_TIMEOUT_SECONDS:
        raise ValueError("repair trace flush timeout is outside its bounded range")
    return timeout


def _safe_remote_uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


class SafeDeckRepairTrace:
    """One deterministic manual LangSmith span with exact readback."""

    def __init__(
        self,
        trace_input: SafeDeckRepairTraceInput,
        *,
        client: object,
        project_name: SafeIdentifier,
        expected_project_id: UUID | None = None,
        flush_timeout_seconds: float = _DEFAULT_FLUSH_TIMEOUT_SECONDS,
    ) -> None:
        self._input = _safe_model_dump(trace_input, SafeDeckRepairTraceInput)
        _reject_unsafe_trace_value(project_name, field_name="project_name")
        if not isinstance(project_name, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", project_name) is None:
            raise ValueError("repair trace project must be a safe identifier")
        if expected_project_id is not None and not isinstance(expected_project_id, UUID):
            raise TypeError("expected project identity must be a UUID")
        self._client = _required_trace_client(client)
        self._project_name = project_name
        self._flush_timeout_seconds = _validated_flush_timeout(flush_timeout_seconds)
        self._project_id = self._read_project(expected_project_id)
        self._run_id = derive_deck_repair_trace_run_id(trace_input)
        self._metadata = _trace_metadata(trace_input)
        self._pending_output: dict[str, Any] | None = None
        self._pending_error: str | None = None
        remote = self._read_remote()
        if remote is None:
            self._create_remote()
            remote = self._read_remote()
            if remote is None:
                raise SafeDeckRepairTraceEmissionError("safe repair trace creation was not durable")
        self._already_terminal = self._validate_remote(remote)

    @property
    def already_terminal(self) -> bool:
        return self._already_terminal

    @property
    def run_id(self) -> str:
        return str(self._run_id)

    def _read_project(self, expected_project_id: UUID | None) -> UUID:
        project: object | None = None
        try:
            project = self._client.read_project(project_name=self._project_name)
        except Exception:
            pass
        project_id = _safe_remote_uuid(getattr(project, "id", None))
        if project_id is None or getattr(project, "name", None) != self._project_name or (expected_project_id is not None and project_id != expected_project_id):
            raise SafeDeckRepairTraceEmissionError("safe repair trace project validation failed") from None
        return project_id

    def _read_remote(self) -> object | None:
        try:
            return self._client.read_run(
                self._run_id,
                load_child_runs=False,
            )
        except LangSmithNotFoundError:
            return None
        except Exception:
            raise SafeDeckRepairTraceEmissionError("safe repair trace remote read failed") from None

    def _validate_remote(self, remote: object) -> bool:
        try:
            extra = getattr(remote, "extra", None)
            outputs = getattr(remote, "outputs", None)
            remote_start_time = getattr(remote, "start_time", None)
            ended = getattr(remote, "end_time", None) is not None
            terminal_valid = False
            if ended and isinstance(outputs, Mapping):
                parsed_output = SafeDeckRepairTraceOutput.model_validate(outputs)
                terminal_valid = _safe_model_dump(
                    parsed_output,
                    SafeDeckRepairTraceOutput,
                ) == outputs and getattr(remote, "error", None) == self._native_error(parsed_output)
            valid = (
                _safe_remote_uuid(getattr(remote, "id", None)) == self._run_id
                and getattr(remote, "name", None) == _TRACE_NAME
                and getattr(remote, "run_type", None) == "chain"
                and _safe_remote_uuid(getattr(remote, "trace_id", None)) == self._run_id
                and getattr(remote, "parent_run_id", None) is None
                and getattr(remote, "dotted_order", None)
                == _root_dotted_order(
                    start_time=remote_start_time,
                    run_id=self._run_id,
                )
                and _safe_remote_uuid(getattr(remote, "session_id", None)) == self._project_id
                and getattr(remote, "inputs", None) == self._input
                and extra == {"metadata": self._metadata}
                and tuple(getattr(remote, "tags", None) or ()) == _TRACE_TAGS
                and not getattr(remote, "attachments", None)
                and not getattr(remote, "events", None)
                and ((not ended and outputs in (None, {}) and getattr(remote, "error", None) is None) or terminal_valid)
            )
        except Exception:
            valid = False
            ended = False
        if not valid:
            raise SafeDeckRepairTraceEmissionError("safe repair trace remote state is invalid") from None
        return ended

    def _create_remote(self) -> None:
        failed = False
        start_time = datetime.now(UTC)
        try:
            self._client.create_run(
                name=_TRACE_NAME,
                inputs=self._input,
                run_type="chain",
                project_name=self._project_name,
                id=self._run_id,
                trace_id=self._run_id,
                parent_run_id=None,
                start_time=start_time,
                dotted_order=_root_dotted_order(
                    start_time=start_time,
                    run_id=self._run_id,
                ),
                extra={"metadata": self._metadata},
                tags=list(_TRACE_TAGS),
                attachments={},
                events=[],
                dangerously_allow_filesystem=False,
            )
        except Exception:
            failed = True
        remote = self._read_remote()
        if remote is None:
            raise SafeDeckRepairTraceEmissionError("safe repair trace creation failed") from None
        self._validate_remote(remote)
        if failed:
            return

    @staticmethod
    def _native_error(output: SafeDeckRepairTraceOutput) -> str | None:
        if output.error_code is None:
            return None
        return f"dq2_repair_failure:{output.error_code}"

    def _terminal_matches(
        self,
        remote: object,
        *,
        output: dict[str, Any],
        native_error: str | None,
    ) -> bool:
        return self._validate_remote(remote) and getattr(remote, "outputs", None) == output and getattr(remote, "error", None) == native_error

    def _flush(self) -> None:
        try:
            self._client.flush(timeout=self._flush_timeout_seconds)
        except Exception:
            raise SafeDeckRepairTraceEmissionError("safe repair trace flush failed") from None

    def finish(self, output: SafeDeckRepairTraceOutput) -> None:
        payload = _safe_model_dump(output, SafeDeckRepairTraceOutput)
        native_error = self._native_error(output)
        if self._pending_output is None:
            self._pending_output = payload
            self._pending_error = native_error
        elif payload != self._pending_output or native_error != self._pending_error:
            raise SafeDeckRepairTraceEmissionError("safe repair trace retry payload changed")

        if self._already_terminal:
            remote = self._read_remote()
            if remote is None or not self._terminal_matches(
                remote,
                output=payload,
                native_error=native_error,
            ):
                raise SafeDeckRepairTraceEmissionError("safe repair trace terminal state conflicts") from None
            self._flush()
            return

        update_failed = False
        try:
            self._client.update_run(
                self._run_id,
                outputs=payload,
                error=native_error,
                end_time=datetime.now(UTC),
                events=[],
                attachments={},
                dangerously_allow_filesystem=False,
            )
        except Exception:
            update_failed = True
        remote = self._read_remote()
        if remote is None or not self._terminal_matches(
            remote,
            output=payload,
            native_error=native_error,
        ):
            message = "safe repair trace update failed" if update_failed else "safe repair trace terminal readback failed"
            raise SafeDeckRepairTraceEmissionError(message) from None
        self._flush()
        remote = self._read_remote()
        if remote is None or not self._terminal_matches(
            remote,
            output=payload,
            native_error=native_error,
        ):
            raise SafeDeckRepairTraceEmissionError("safe repair trace terminal verification failed") from None
        self._already_terminal = True


def _required_env(name: str) -> str:
    value = (os.getenv(name) or "").strip().strip('"').strip("'").strip()
    if not value:
        raise RuntimeError(f"DQ-2 safe repair tracing requires explicit {name}")
    return value


class ConfiguredDeckRepairTraceFactory:
    """Own one explicit EU, non-batching LangSmith client."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        project_name: str,
        workspace_id: str,
        expected_project_id: UUID,
    ) -> None:
        if endpoint != _EU_LANGSMITH_ENDPOINT:
            raise ValueError("DQ-2 safe repair tracing requires the EU endpoint")
        try:
            parsed_workspace_id = UUID(workspace_id)
        except (AttributeError, TypeError, ValueError):
            raise ValueError("DQ-2 safe repair tracing requires an exact workspace UUID") from None
        if str(parsed_workspace_id) != workspace_id or not isinstance(expected_project_id, UUID):
            raise ValueError("DQ-2 safe repair tracing requires exact workspace and project UUIDs")
        try:
            self._client = LangSmithClient(
                api_url=endpoint,
                api_key=api_key,
                workspace_id=workspace_id,
                timeout_ms=15_000,
                auto_batch_tracing=False,
                omit_traced_runtime_info=True,
            )
        except Exception:
            raise RuntimeError("DQ-2 safe repair LangSmith client configuration is invalid") from None
        self._project_name = project_name
        self._expected_project_id = expected_project_id

    def __call__(
        self,
        trace_input: SafeDeckRepairTraceInput,
    ) -> SafeDeckRepairTrace:
        return SafeDeckRepairTrace(
            trace_input,
            client=self._client,
            project_name=self._project_name,
            expected_project_id=self._expected_project_id,
        )

    def close(self) -> None:
        self._client.close()


def configured_deck_repair_trace_factory() -> ConfiguredDeckRepairTraceFactory:
    """Build the production trace factory without any ambient env fallback."""

    endpoint = _required_env("LANGSMITH_ENDPOINT")
    parsed = urlsplit(endpoint)
    if endpoint != _EU_LANGSMITH_ENDPOINT or parsed.scheme != "https" or parsed.netloc != "eu.api.smith.langchain.com" or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise RuntimeError("DQ-2 safe repair tracing requires the explicit EU endpoint")
    raw_workspace_id = _required_env("LANGSMITH_WORKSPACE_ID")
    raw_project_id = _required_env("LANGSMITH_PROJECT_UUID")
    try:
        workspace_id = UUID(raw_workspace_id)
        expected_project_id = UUID(raw_project_id)
    except ValueError:
        raise RuntimeError("DQ-2 safe repair tracing requires valid workspace and project UUIDs") from None
    if str(workspace_id) != raw_workspace_id or str(expected_project_id) != raw_project_id:
        raise RuntimeError("DQ-2 safe repair tracing requires canonical workspace and project UUIDs")
    return ConfiguredDeckRepairTraceFactory(
        endpoint=endpoint,
        api_key=_required_env("LANGSMITH_API_KEY"),
        project_name=_required_env("LANGSMITH_PROJECT"),
        workspace_id=str(workspace_id),
        expected_project_id=expected_project_id,
    )


__all__ = [
    "ConfiguredDeckRepairTraceFactory",
    "DeckRepairTraceFactory",
    "DeckRepairTraceSpan",
    "SafeDeckRepairTrace",
    "SafeDeckRepairTraceEmissionError",
    "SafeDeckRepairTraceInput",
    "SafeDeckRepairTraceMetadata",
    "SafeDeckRepairTraceOutput",
    "configured_deck_repair_trace_factory",
    "derive_deck_repair_trace_run_id",
    "safe_deck_repair_trace_input",
]
