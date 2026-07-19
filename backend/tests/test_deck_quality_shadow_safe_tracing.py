from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid5

import pytest
from langsmith.run_helpers import tracing_context
from langsmith.utils import LangSmithNotFoundError
from pydantic import ValidationError

from deerflow.sophia.deck_quality.tracing import (
    REQUIRED_QUALITY_TRACE_OPERATIONS,
    SafeCriterionScore,
    SafeQualityTrace,
    SafeQualityTraceEmissionError,
    SafeQualityTraceError,
    SafeQualityTraceOperationInput,
    SafeQualityTraceOperationOutput,
    SafeQualityTraceOperationTerminal,
    SafeQualityTraceRootInput,
    SafeQualityTraceRootOutput,
    derive_quality_trace_run_identity,
    sanitize_quality_trace_error,
)

_SOURCE_COMMIT = "f05efb3adce121fb0af009407b7fc53ba6e98312"
_GATEWAY_COMMIT = "7092042d7092042d7092042d7092042d7092042d"
_LANGGRAPH_COMMIT = "8d41e5a28d41e5a28d41e5a28d41e5a28d41e5a2"
_JUDGE_OPERATIONS = {"deck.judge.blind_visual", "deck.judge.plan_realization"}
_ZERO_SELECTOR_INPUT_OPERATIONS = {
    "deck.quality.shadow.dispatch",
    "deck.quality.snapshot",
    "deck.quality.adjudicate",
    "deck.quality.shadow.persist",
}
_SELECTOR_OUTPUT_OPERATIONS = {
    "deck.quality.evidence",
    "deck.judge.blind_visual",
    "deck.quality.mechanical_projection",
    "deck.judge.plan_realization",
}
_RESULT_OPERATIONS = {"deck.quality.adjudicate", "deck.quality.shadow.persist"}
_PROJECT_NAMESPACE = UUID("d1a7d713-7fcf-5308-9e10-a878f870a1ac")


class CapturingClient:
    def __init__(self) -> None:
        self._omit_traced_runtime_info = True
        self._process_buffered_run_ops = None
        self._pyo3_client = None
        self.compressed_traces = None
        self.tracing_queue = None
        self.create_attempts: list[dict[str, Any]] = []
        self.update_attempts: list[dict[str, Any]] = []
        self.read_attempts: list[UUID] = []
        self.list_attempts: list[tuple[UUID, ...]] = []
        self.project_attempts: list[str] = []
        self.flush_attempts: list[float | None] = []
        self.stored_runs: dict[UUID, SimpleNamespace] = {}
        self.fail_create_once_for: set[str] = set()
        self.fail_update_once_for: set[str] = set()
        self.commit_then_fail_create_once_for: set[str] = set()
        self.commit_then_fail_update_once_for: set[str] = set()
        self.missing_projects: set[str] = set()
        self.flush_error: BaseException | None = None
        self.on_flush: Any = None
        self.on_list: Any = None

    @staticmethod
    def project_id(project_name: str) -> UUID:
        return uuid5(_PROJECT_NAMESPACE, project_name)

    def read_project(self, *, project_name: str) -> SimpleNamespace:
        self.project_attempts.append(project_name)
        if project_name in self.missing_projects:
            raise LangSmithNotFoundError("private project lookup response")
        return SimpleNamespace(id=self.project_id(project_name), name=project_name)

    def read_run(self, run_id: UUID, *, load_child_runs: bool = False) -> SimpleNamespace:
        assert load_child_runs is False
        normalized = UUID(str(run_id))
        self.read_attempts.append(normalized)
        if normalized not in self.stored_runs:
            raise LangSmithNotFoundError("private run lookup response")
        return deepcopy(self.stored_runs[normalized])

    def list_runs(
        self,
        *,
        project_id: UUID,
        run_ids: tuple[UUID, ...],
        select: tuple[str, ...],
        limit: int,
    ) -> Any:
        assert isinstance(project_id, UUID)
        assert {"id", "inputs", "outputs", "extra", "s3_urls"}.issubset(select)
        normalized = tuple(UUID(str(run_id)) for run_id in run_ids)
        assert limit == len(normalized)
        self.list_attempts.append(normalized)
        if self.on_list is not None:
            self.on_list(self)
        return iter(deepcopy(self.stored_runs[run_id]) for run_id in normalized if run_id in self.stored_runs)

    def create_run(self, **kwargs: Any) -> None:
        self.create_attempts.append(dict(kwargs))
        name = str(kwargs["name"])
        if name in self.fail_create_once_for:
            self.fail_create_once_for.remove(name)
            raise RuntimeError("Authorization: Bearer secret https://signed.example/private")
        commit_then_fail = name in self.commit_then_fail_create_once_for
        self.commit_then_fail_create_once_for.discard(name)
        run_id = UUID(str(kwargs["id"]))
        if run_id in self.stored_runs:
            raise RuntimeError("private duplicate payload")
        project_name = str(kwargs["session_name"])
        self.stored_runs[run_id] = SimpleNamespace(
            id=run_id,
            name=name,
            run_type=kwargs["run_type"],
            trace_id=UUID(str(kwargs["trace_id"])),
            parent_run_id=(UUID(str(kwargs["parent_run_id"])) if kwargs.get("parent_run_id") is not None else None),
            session_id=self.project_id(project_name),
            inputs=deepcopy(kwargs["inputs"]),
            outputs=deepcopy(kwargs.get("outputs")),
            error=kwargs.get("error"),
            end_time=kwargs.get("end_time"),
            extra=deepcopy(kwargs.get("extra")),
            tags=deepcopy(kwargs.get("tags")),
            attachments=deepcopy(kwargs.get("attachments")),
            events=deepcopy(kwargs.get("events")),
        )
        if commit_then_fail:
            raise RuntimeError("private response after committed create")

    def update_run(self, **kwargs: Any) -> None:
        self.update_attempts.append(dict(kwargs))
        run_id = UUID(str(kwargs["run_id"]))
        remote = self.stored_runs[run_id]
        name = str(kwargs.get("name", remote.name))
        if name in self.fail_update_once_for:
            self.fail_update_once_for.remove(name)
            raise RuntimeError("Traceback: provider credential sk-proj-private")
        commit_then_fail = name in self.commit_then_fail_update_once_for
        self.commit_then_fail_update_once_for.discard(name)
        remote.name = name
        remote.run_type = kwargs.get("run_type", remote.run_type)
        if kwargs.get("trace_id") is not None:
            remote.trace_id = UUID(str(kwargs["trace_id"]))
        if "parent_run_id" in kwargs:
            remote.parent_run_id = UUID(str(kwargs["parent_run_id"])) if kwargs["parent_run_id"] is not None else None
        remote.inputs = deepcopy(kwargs["inputs"]) if kwargs.get("inputs") is not None else remote.inputs
        remote.outputs = deepcopy(kwargs.get("outputs"))
        remote.error = kwargs.get("error")
        remote.end_time = kwargs.get("end_time")
        if kwargs.get("extra") is not None:
            remote.extra = deepcopy(kwargs["extra"])
        if kwargs.get("tags") is not None:
            remote.tags = deepcopy(kwargs["tags"])
        if kwargs.get("attachments") is not None:
            remote.attachments = deepcopy(kwargs["attachments"])
        if kwargs.get("events") is not None:
            remote.events = deepcopy(kwargs["events"])
        if commit_then_fail:
            raise RuntimeError("private response after committed update")

    def flush(self, timeout: float | None = None) -> None:
        self.flush_attempts.append(timeout)
        if self.flush_error is not None:
            raise self.flush_error
        if self.on_flush is not None:
            self.on_flush(self)


def _trace(
    root_input: SafeQualityTraceRootInput,
    client: CapturingClient,
    *,
    project_name: str = "dq1-canary",
    flush_timeout_seconds: float = 15.0,
) -> SafeQualityTrace:
    return SafeQualityTrace(
        root_input,
        client=client,
        project_name=project_name,
        flush_timeout_seconds=flush_timeout_seconds,
    )


def _update_name(client: CapturingClient, attempt: dict[str, Any]) -> str:
    return str(client.stored_runs[UUID(str(attempt["run_id"]))].name)


def _root_values(**overrides: Any) -> dict[str, Any]:
    builder_run_id = "019f675a-dcc1-7053-80dc-c6f572fb4d87"
    values: dict[str, Any] = {
        "campaign_id": "DQ-1",
        "quality_run_id": f"quality_{'1' * 64}",
        "build_id": "build_01KXKNNQ5Z9N198VCMJPDWSBJ0",
        "task_id": "019f675a-dcbd-7df0-a8ec-5371ee7315f2",
        "builder_run_id": builder_run_id,
        "parent_builder_run_id": builder_run_id,
        "parent_builder_trace_id": "019f675a-dcc1-7053-80dc-c6f572fb4d87",
        "logical_artifact_id": "artifact_6726b07cedb246eb14a5eabf",
        "artifact_version_id": "artifact_version_01KXKNV1DJ7B4ABS00FN20G1SK",
        "manifest_revision": 1,
        "artifact_hash": "2" * 64,
        "rubric_version": "deck-rubric-v2",
        "rubric_hash": "3" * 64,
        "judge_deployment": "openai-gpt-5.6-sol",
        "judge_provider": "openai",
        "judge_model": "gpt-5.6-sol",
        "judge_profile_version": "deck-visual-judge-v1",
        "judge_plan_hash": "4" * 64,
        "evidence_preprocessor_version": "deck-evidence-v2",
        "source_commit_sha": _SOURCE_COMMIT,
        "gateway_deployed_sha": _GATEWAY_COMMIT,
        "langgraph_deployed_sha": _LANGGRAPH_COMMIT,
    }
    values.update(overrides)
    return values


def _operation_input(operation: str, **overrides: Any) -> SafeQualityTraceOperationInput:
    selector_count = 0 if operation in _ZERO_SELECTOR_INPUT_OPERATIONS else 5
    values: dict[str, Any] = {
        "operation": operation,
        "quality_run_id": f"quality_{'1' * 64}",
        "artifact_version_id": "artifact_version_01KXKNV1DJ7B4ABS00FN20G1SK",
        "input_hash": "6" * 64,
        "rubric_hash": "3" * 64,
        "prompt_hash": "7" * 64 if operation in _JUDGE_OPERATIONS else None,
        "judge_plan_hash": "4" * 64 if operation in _JUDGE_OPERATIONS else None,
        "expected_selector_count": selector_count,
        "rendered_selector_count": selector_count,
    }
    values.update(overrides)
    return SafeQualityTraceOperationInput.model_validate(values)


def _completed_output(
    operation: str,
    *,
    shadow_result: str = "needs_revision",
) -> SafeQualityTraceOperationOutput:
    values: dict[str, Any] = {
        "operation": operation,
        "status": "completed",
        "output_hash": "8" * 64,
        "latency_ms": 125,
        "evaluated_selector_count": 5 if operation in _SELECTOR_OUTPUT_OPERATIONS else 0,
        "shadow_result": shadow_result if operation in _RESULT_OPERATIONS else None,
    }
    if operation in _JUDGE_OPERATIONS:
        values.update(
            {
                "input_tokens": 50,
                "output_tokens": 10,
                "total_tokens": 60,
                "criterion_scores": (
                    SafeCriterionScore(
                        criterion_id=("visual_hierarchy" if operation == "deck.judge.blind_visual" else "signature_realization"),
                        applicable=True,
                        score=4,
                    ),
                ),
            }
        )
    return SafeQualityTraceOperationOutput.model_validate(values)


def _emit_completed_trace(
    trace: SafeQualityTrace,
    *,
    shadow_result: str = "needs_revision",
    overrides: dict[str, SafeQualityTraceOperationOutput] | None = None,
) -> dict[str, SafeQualityTraceOperationOutput]:
    outputs: dict[str, SafeQualityTraceOperationOutput] = {}
    for operation in REQUIRED_QUALITY_TRACE_OPERATIONS:
        span = trace.start_operation(_operation_input(operation))
        output = (overrides or {}).get(operation) or _completed_output(
            operation,
            shadow_result=shadow_result,
        )
        span.finish(output)
        outputs[operation] = output
    return outputs


def _root_output(
    trace: SafeQualityTrace,
    *,
    shadow_result: str = "needs_revision",
    error_code: str | None = None,
) -> SafeQualityTraceRootOutput:
    return SafeQualityTraceRootOutput.model_validate(
        {
            "shadow_result": shadow_result,
            "decision_hash": "9" * 64,
            "operation_terminals": trace.operation_terminals,
            "total_latency_ms": 1_000,
            "error_code": error_code,
        }
    )


def _assert_safe_sdk_payload(payload: dict[str, Any]) -> None:
    assert payload.get("attachments", {}) == {}
    assert payload.get("events", []) == []
    assert payload.get("replicas", []) == []
    native_error = payload.get("error")
    assert native_error is None or native_error in {
        "dq1_failure:judge_unavailable",
        "dq1_failure:coverage_error",
        "dq1_failure:structured_output_invalid",
        "dq1_failure:artifact_snapshot_stale",
        "dq1_failure:quality_persistence_error",
        "dq1_failure:shadow_dispatch_unavailable",
        "dq1_failure:run_deadline_exceeded",
        "dq1_failure:attempt_limit_exhausted",
    }
    content_surfaces = {
        "inputs": payload.get("inputs"),
        "outputs": payload.get("outputs"),
        "extra": payload.get("extra"),
        "serialized": payload.get("serialized"),
        "tags": payload.get("tags"),
    }
    serialized = repr(content_surfaces).lower()
    for forbidden in (
        "api_key",
        "authorization",
        "base64",
        "bearer ",
        "creative_plan",
        "data:image",
        "exception_text",
        "http://",
        "https://",
        "signed_url",
        "traceback",
        "user_memory",
    ):
        assert forbidden not in serialized


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("base64", "aGVsbG8="),
        ("creative_plan", {"signature": "private"}),
        ("user_memory", "private preference"),
        ("artifact_path", "/tmp/private/render.png"),
        ("signed_url", "https://storage.example/render.png?signature=secret"),
        ("authorization", "Bearer secret"),
        ("exception_text", "Traceback: private provider response"),
        ("brief", "raw user request"),
    ],
)
def test_safe_trace_root_rejects_all_content_fields(field: str, value: Any) -> None:
    values = _root_values()
    values[field] = value

    with pytest.raises(ValidationError):
        SafeQualityTraceRootInput.model_validate(values)


@pytest.mark.parametrize(
    "unsafe_value",
    [
        "data:image/png;base64,aGVsbG8=",
        "https://storage.example/render.png?X-Amz-Signature=secret",
        "/private/render.png",
        "Bearer provider-secret",
        "creative_plan",
        "user_memory",
        "Traceback: RuntimeError private-provider-body",
        "RuntimeError-private-provider-body",
        "sk-proj-private-provider-key",
        "eyJhbGciOiJIUzI1NiJ9.private.signature",
        "A" * 100,
    ],
)
def test_safe_trace_root_rejects_content_in_whitelisted_string_fields(unsafe_value: str) -> None:
    with pytest.raises(ValidationError):
        SafeQualityTraceRootInput.model_validate(_root_values(judge_model=unsafe_value))


def test_git_commit_shas_are_distinct_from_content_sha256_hashes() -> None:
    root = SafeQualityTraceRootInput.model_validate(_root_values())

    assert root.source_commit_sha == _SOURCE_COMMIT
    assert root.gateway_deployed_sha == _GATEWAY_COMMIT
    assert root.langgraph_deployed_sha == _LANGGRAPH_COMMIT
    with pytest.raises(ValidationError):
        SafeQualityTraceRootInput.model_validate(_root_values(source_commit_sha="a" * 64))
    with pytest.raises(ValidationError):
        SafeQualityTraceRootInput.model_validate(_root_values(artifact_hash="a" * 40))


def test_safe_trace_models_are_strict_extra_forbid_and_require_builder_linkage() -> None:
    with pytest.raises(ValidationError):
        SafeQualityTraceOperationOutput.model_validate(
            {
                "operation": "deck.quality.snapshot",
                "status": "completed",
                "output_hash": "8" * 64,
                "latency_ms": "12",
                "raw_output": "private",
            }
        )
    with pytest.raises(ValidationError, match="same completed builder run"):
        SafeQualityTraceRootInput.model_validate(_root_values(parent_builder_run_id="different-builder-run"))


def test_output_tuples_are_bounded() -> None:
    scores = tuple(SafeCriterionScore(criterion_id=f"criterion_{index}", applicable=True, score=3) for index in range(33))
    with pytest.raises(ValidationError):
        SafeQualityTraceOperationOutput(
            operation="deck.judge.blind_visual",
            status="completed",
            output_hash="8" * 64,
            latency_ms=1,
            input_tokens=1,
            output_tokens=1,
            total_tokens=2,
            criterion_scores=scores,
        )
    with pytest.raises(ValidationError):
        SafeQualityTraceOperationOutput(
            operation="deck.quality.adjudicate",
            status="completed",
            output_hash="8" * 64,
            latency_ms=1,
            failure_codes=tuple(f"failure_{index}" for index in range(65)),
            shadow_result="needs_revision",
        )


def test_sanitized_exception_retains_only_controlled_codes() -> None:
    provider_error = TimeoutError("Traceback: Authorization: Bearer secret; signed URL https://example.test/private")

    safe = sanitize_quality_trace_error(provider_error, stage="blind_visual")
    coverage = sanitize_quality_trace_error(
        ValueError("private values"),
        stage="evidence",
        error_code="coverage_error",
    )

    assert safe.model_dump(mode="json") == {
        "error_code": "judge_unavailable",
        "stage": "blind_visual",
        "retryable": True,
    }
    assert coverage.error_code == "coverage_error"
    assert "secret" not in repr(safe)
    assert "example.test" not in repr(safe)


@pytest.mark.parametrize(
    "values",
    [
        {
            "operation": "deck.quality.snapshot",
            "prompt_hash": "7" * 64,
        },
        {
            "operation": "deck.judge.blind_visual",
            "prompt_hash": None,
        },
        {
            "operation": "deck.quality.shadow.dispatch",
            "expected_selector_count": 1,
        },
    ],
)
def test_operation_inputs_reject_semantically_invalid_fields(values: dict[str, Any]) -> None:
    operation = str(values.pop("operation"))
    with pytest.raises(ValidationError):
        _operation_input(operation, **values)


@pytest.mark.parametrize(
    "values",
    [
        {"operation": "deck.quality.snapshot", "input_tokens": 1},
        {
            "operation": "deck.quality.snapshot",
            "criterion_scores": (SafeCriterionScore(criterion_id="visual_hierarchy", applicable=True, score=4),),
        },
        {"operation": "deck.quality.snapshot", "failure_codes": ("weak_close",)},
        {"operation": "deck.quality.snapshot", "evaluated_selector_count": 1},
        {"operation": "deck.quality.snapshot", "shadow_result": "needs_revision"},
        {
            "operation": "deck.judge.blind_visual",
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 3,
            "criterion_scores": (SafeCriterionScore(criterion_id="visual_hierarchy", applicable=True, score=4),),
        },
    ],
)
def test_operation_outputs_reject_semantically_invalid_fields(values: dict[str, Any]) -> None:
    base: dict[str, Any] = {
        "status": "completed",
        "output_hash": "8" * 64,
        "latency_ms": 1,
    }
    base.update(values)
    with pytest.raises(ValidationError):
        SafeQualityTraceOperationOutput.model_validate(base)


def test_error_and_skip_policies_are_operation_specific() -> None:
    with pytest.raises(ValidationError, match="skip code is invalid"):
        SafeQualityTraceOperationOutput(
            operation="deck.quality.shadow.dispatch",
            status="skipped",
            latency_ms=1,
            skip_code="upstream_error",
        )
    with pytest.raises(ValidationError, match="stage does not match"):
        SafeQualityTraceOperationOutput(
            operation="deck.judge.blind_visual",
            status="error",
            latency_ms=1,
            error=SafeQualityTraceError(
                error_code="judge_unavailable",
                stage="plan_realization",
            ),
        )
    with pytest.raises(ValidationError, match="invalid for the operation"):
        SafeQualityTraceOperationOutput(
            operation="deck.quality.snapshot",
            status="error",
            latency_ms=1,
            error=SafeQualityTraceError(
                error_code="judge_unavailable",
                stage="snapshot",
            ),
        )


def test_full_new_emission_uses_safe_sdk_surfaces_and_exact_remote_readback() -> None:
    primary = CapturingClient()
    ambient_replica = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())

    with tracing_context(
        replicas=[{"client": ambient_replica, "project_name": "ambient-private-replica"}],
        metadata={"ambient_private_metadata": "must-not-propagate"},
    ):
        trace = SafeQualityTrace(root_input, client=primary, project_name="dq1-canary")
        _emit_completed_trace(trace)
        trace.finish(_root_output(trace))

    assert ambient_replica.create_attempts == []
    assert ambient_replica.update_attempts == []
    assert len(primary.create_attempts) == 1 + len(REQUIRED_QUALITY_TRACE_OPERATIONS)
    assert len(primary.update_attempts) == 1 + len(REQUIRED_QUALITY_TRACE_OPERATIONS)
    assert all(payload["replicas"] == [] for payload in primary.create_attempts)
    assert all(payload["attachments"] == {} for payload in primary.create_attempts)
    assert all(payload["dangerously_allow_filesystem"] is False for payload in primary.create_attempts)

    root_create = primary.create_attempts[0]
    child_creates = primary.create_attempts[1:]
    root_metadata = root_create["extra"]["metadata"]
    expected_metadata_keys = {
        "schema_version",
        "campaign_id",
        "quality_run_id",
        "build_id",
        "task_id",
        "builder_run_id",
        "parent_builder_trace_id",
        "artifact_version_id",
        "rubric_version",
        "judge_model",
        "source_commit_sha",
        "gateway_deployed_sha",
        "langgraph_deployed_sha",
    }
    assert set(root_metadata) == expected_metadata_keys
    assert root_metadata["gateway_deployed_sha"] == _GATEWAY_COMMIT
    assert root_metadata["langgraph_deployed_sha"] == _LANGGRAPH_COMMIT
    assert "operation" not in root_metadata
    assert all(set(payload["extra"]["metadata"]) == expected_metadata_keys | {"operation"} for payload in child_creates)
    assert {payload["extra"]["metadata"]["operation"] for payload in child_creates} == set(REQUIRED_QUALITY_TRACE_OPERATIONS)
    assert root_create.get("parent_run_id") is None
    assert all(payload["parent_run_id"] == root_create["id"] for payload in child_creates)
    assert all(payload["trace_id"] == root_create["trace_id"] for payload in primary.create_attempts)
    assert all("ambient_private_metadata" not in repr(payload) for payload in primary.create_attempts)
    assert all("ambient_private_metadata" not in repr(payload) for payload in primary.update_attempts)
    for payload in (*primary.create_attempts, *primary.update_attempts):
        _assert_safe_sdk_payload(payload)
    identity = derive_quality_trace_run_identity(root_input)
    expected_ids = [identity.root_run_id, *(item.run_id for item in identity.operation_run_ids)]
    assert primary.project_attempts == ["dq1-canary"]
    assert primary.flush_attempts == [15.0]
    assert primary.read_attempts == []
    assert primary.list_attempts == [tuple(expected_ids), tuple(expected_ids)]
    assert set(primary.stored_runs) == set(expected_ids)
    assert all(primary.stored_runs[run_id].end_time is not None for run_id in expected_ids)
    assert all(set(payload) == {"run_id", "outputs", "error", "end_time"} for payload in primary.update_attempts)


def test_full_completed_trace_replay_performs_no_duplicate_writes() -> None:
    client = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    first = _trace(root_input, client)
    _emit_completed_trace(first)
    first.finish(_root_output(first))
    initial_create_count = len(client.create_attempts)
    initial_update_count = len(client.update_attempts)

    replay = _trace(root_input, client)
    _emit_completed_trace(replay)
    replay.finish(_root_output(replay))

    assert len(client.create_attempts) == initial_create_count == 9
    assert len(client.update_attempts) == initial_update_count == 9
    assert client.flush_attempts == [15.0, 15.0]
    identity = derive_quality_trace_run_identity(root_input)
    expected_ids = {identity.root_run_id, *(item.run_id for item in identity.operation_run_ids)}
    assert set(client.stored_runs) == expected_ids
    assert client.read_attempts == []
    assert len(client.list_attempts) == 4


def test_full_trace_accepts_only_langsmith_server_run_depth_and_replays() -> None:
    client = CapturingClient()

    def inject_run_depth(current: CapturingClient) -> None:
        for remote in current.stored_runs.values():
            remote.extra["metadata"]["ls_run_depth"] = 0 if remote.parent_run_id is None else 1

    client.on_flush = inject_run_depth
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    first = _trace(root_input, client)
    _emit_completed_trace(first)
    first.finish(_root_output(first))

    replay = _trace(root_input, client)
    _emit_completed_trace(replay)
    replay.finish(_root_output(replay))

    assert len(client.create_attempts) == 9
    assert len(client.update_attempts) == 9
    assert client.flush_attempts == [15.0, 15.0]


@pytest.mark.parametrize("mutation", ["wrong_depth", "unexpected_key"])
def test_langsmith_server_metadata_enrichment_stays_fail_closed(
    mutation: str,
) -> None:
    client = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    identity = derive_quality_trace_run_identity(root_input)

    def mutate_remote(current: CapturingClient) -> None:
        for remote in current.stored_runs.values():
            remote.extra["metadata"]["ls_run_depth"] = 0 if remote.parent_run_id is None else 1
        root_metadata = current.stored_runs[identity.root_run_id].extra["metadata"]
        if mutation == "wrong_depth":
            root_metadata["ls_run_depth"] = 1
        else:
            root_metadata["unexpected_remote_field"] = "unsafe"

    client.on_flush = mutate_remote
    trace = _trace(root_input, client)
    _emit_completed_trace(trace)

    with pytest.raises(
        SafeQualityTraceEmissionError,
        match="safe quality trace remote state is invalid",
    ):
        trace.finish(_root_output(trace))


def test_partial_prior_trace_is_reconciled_without_duplicate_create_or_update() -> None:
    client = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    interrupted = _trace(root_input, client)
    for operation in REQUIRED_QUALITY_TRACE_OPERATIONS[:3]:
        interrupted.start_operation(_operation_input(operation)).finish(_completed_output(operation))
    interrupted.start_operation(_operation_input(REQUIRED_QUALITY_TRACE_OPERATIONS[3]))

    resumed = _trace(root_input, client)
    _emit_completed_trace(resumed)
    resumed.finish(_root_output(resumed))

    assert len(client.create_attempts) == 9
    assert len(client.update_attempts) == 9
    created_ids = [UUID(str(attempt["id"])) for attempt in client.create_attempts]
    updated_ids = [UUID(str(attempt["run_id"])) for attempt in client.update_attempts]
    assert len(created_ids) == len(set(created_ids)) == 9
    assert len(updated_ids) == len(set(updated_ids)) == 9


def test_ambiguous_committed_create_and_update_are_reconciled_by_readback() -> None:
    client = CapturingClient()
    client.commit_then_fail_create_once_for.add("deck.quality.shadow")
    client.commit_then_fail_update_once_for.add("deck.quality.snapshot")
    trace = _trace(SafeQualityTraceRootInput.model_validate(_root_values()), client)

    _emit_completed_trace(trace)
    trace.finish(_root_output(trace))

    assert len(client.create_attempts) == 9
    assert len(client.update_attempts) == 9
    assert len(client.stored_runs) == 9


@pytest.mark.parametrize(
    "flush_error",
    [
        RuntimeError("Authorization: Bearer private flush response"),
        TimeoutError("private queue state"),
    ],
    ids=["failure", "timeout"],
)
def test_flush_failure_or_timeout_fails_closed_without_remote_details(flush_error: BaseException) -> None:
    client = CapturingClient()
    trace = _trace(
        SafeQualityTraceRootInput.model_validate(_root_values()),
        client,
        flush_timeout_seconds=0.25,
    )
    _emit_completed_trace(trace)
    client.flush_error = flush_error

    with pytest.raises(SafeQualityTraceEmissionError) as raised:
        trace.finish(_root_output(trace))

    assert str(raised.value) == "safe quality trace flush failed"
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert "private" not in str(raised.value).lower()
    assert client.flush_attempts == [0.25]


def test_missing_operation_in_post_flush_readback_fails_closed() -> None:
    client = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    identity = derive_quality_trace_run_identity(root_input)
    missing_id = identity.operation_run_id("deck.quality.evidence")
    client.on_flush = lambda current: current.stored_runs.pop(missing_id)
    trace = _trace(root_input, client, flush_timeout_seconds=0.01)
    _emit_completed_trace(trace)

    with pytest.raises(SafeQualityTraceEmissionError) as raised:
        trace.finish(_root_output(trace))

    assert str(raised.value) == "safe quality trace remote state is missing"
    assert raised.value.__cause__ is None
    assert "evidence" not in str(raised.value)


def test_post_flush_batch_read_retries_one_incomplete_projection() -> None:
    client = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    identity = derive_quality_trace_run_identity(root_input)
    delayed_id = identity.operation_run_id("deck.quality.evidence")
    delayed: SimpleNamespace | None = None

    def delay_once(current: CapturingClient) -> None:
        nonlocal delayed
        if len(current.list_attempts) == 2:
            delayed = current.stored_runs.pop(delayed_id)
        elif delayed is not None:
            current.stored_runs[delayed_id] = delayed
            delayed = None

    client.on_list = delay_once
    trace = _trace(root_input, client, flush_timeout_seconds=0.25)
    _emit_completed_trace(trace)
    trace.finish(_root_output(trace))

    assert len(client.list_attempts) == 3
    assert client.read_attempts == []


@pytest.mark.parametrize("mutation", ["project", "tree", "output"])
def test_mismatched_post_flush_readback_fails_closed(mutation: str) -> None:
    client = CapturingClient()
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    identity = derive_quality_trace_run_identity(root_input)
    operation_id = identity.operation_run_id("deck.quality.snapshot")

    def mutate_remote(current: CapturingClient) -> None:
        remote = current.stored_runs[operation_id]
        if mutation == "project":
            remote.session_id = current.project_id("wrong-project")
        elif mutation == "tree":
            remote.parent_run_id = UUID("00000000-0000-0000-0000-000000000001")
        else:
            remote.outputs = {"schema_version": "mismatched"}

    client.on_flush = mutate_remote
    trace = _trace(root_input, client)
    _emit_completed_trace(trace)

    with pytest.raises(SafeQualityTraceEmissionError) as raised:
        trace.finish(_root_output(trace))

    assert str(raised.value) in {
        "safe quality trace remote state is invalid",
        "safe quality trace remote terminal state is invalid",
    }
    assert raised.value.__cause__ is None
    assert "wrong-project" not in str(raised.value)


def test_trace_requires_explicit_capable_client_and_existing_exact_project() -> None:
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    with pytest.raises(TypeError, match="project_name"):
        SafeQualityTrace(root_input, client=CapturingClient())  # type: ignore[call-arg]
    with pytest.raises(TypeError, match="client"):
        SafeQualityTrace(root_input, project_name="dq1-canary")  # type: ignore[call-arg]
    with pytest.raises(TypeError, match="explicit LangSmith client"):
        SafeQualityTrace(root_input, client=None, project_name="dq1-canary")  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="read, write, and flush"):
        SafeQualityTrace(root_input, client=object(), project_name="dq1-canary")
    runtime_metadata_client = CapturingClient()
    runtime_metadata_client._omit_traced_runtime_info = False
    with pytest.raises(TypeError, match="disable SDK runtime metadata"):
        _trace(root_input, runtime_metadata_client)
    buffered_client = CapturingClient()
    buffered_client.tracing_queue = object()
    with pytest.raises(TypeError, match="disable buffered tracing"):
        _trace(root_input, buffered_client)

    client = CapturingClient()
    client.missing_projects.add("dq1-canary")
    with pytest.raises(SafeQualityTraceEmissionError) as raised:
        _trace(root_input, client)
    assert str(raised.value) == "safe quality trace project validation failed"
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None


@pytest.mark.parametrize("timeout", [0, -1, 30.1, float("inf"), float("nan")])
def test_trace_rejects_unbounded_or_invalid_flush_timeout(timeout: float) -> None:
    with pytest.raises(ValueError, match="bounded range"):
        _trace(
            SafeQualityTraceRootInput.model_validate(_root_values()),
            CapturingClient(),
            flush_timeout_seconds=timeout,
        )


def test_trace_requires_exact_ordered_eight_operation_terminal_coverage() -> None:
    client = CapturingClient()
    trace = _trace(SafeQualityTraceRootInput.model_validate(_root_values()), client)
    for operation in REQUIRED_QUALITY_TRACE_OPERATIONS[:-1]:
        span = trace.start_operation(_operation_input(operation))
        span.finish(_completed_output(operation))

    with pytest.raises(SafeQualityTraceEmissionError, match="exact terminal coverage"):
        _ = trace.operation_terminals

    synthetic_terminals = tuple(SafeQualityTraceOperationTerminal(operation=operation, status="completed") for operation in REQUIRED_QUALITY_TRACE_OPERATIONS)
    root_output = SafeQualityTraceRootOutput(
        shadow_result="needs_revision",
        decision_hash="9" * 64,
        operation_terminals=synthetic_terminals,
        total_latency_ms=1,
    )
    with pytest.raises(SafeQualityTraceEmissionError, match="all eight operations"):
        trace.finish(root_output)

    with pytest.raises(ValidationError, match="ordered terminal status"):
        SafeQualityTraceRootOutput(
            shadow_result="needs_revision",
            decision_hash="9" * 64,
            operation_terminals=tuple(reversed(synthetic_terminals)),
            total_latency_ms=1,
        )


def test_valid_skip_only_trace_terminates_as_mechanically_invalid() -> None:
    client = CapturingClient()
    trace = _trace(SafeQualityTraceRootInput.model_validate(_root_values()), client)
    skipped_plan = SafeQualityTraceOperationOutput(
        operation="deck.judge.plan_realization",
        status="skipped",
        latency_ms=1,
        skip_code="mechanically_invalid",
    )
    _emit_completed_trace(
        trace,
        shadow_result="mechanically_invalid",
        overrides={"deck.judge.plan_realization": skipped_plan},
    )
    output = _root_output(trace, shadow_result="mechanically_invalid")
    trace.finish(output)

    assert output.operation_count == 8
    assert tuple(item.status for item in output.operation_terminals).count("skipped") == 1
    assert all(payload.get("error") is None for payload in client.update_attempts)


def test_native_langsmith_error_status_contains_only_controlled_codes() -> None:
    client = CapturingClient()
    trace = _trace(SafeQualityTraceRootInput.model_validate(_root_values()), client)
    blind_error = SafeQualityTraceOperationOutput(
        operation="deck.judge.blind_visual",
        status="error",
        latency_ms=8,
        error=SafeQualityTraceError(
            error_code="judge_unavailable",
            stage="blind_visual",
            retryable=True,
        ),
    )
    _emit_completed_trace(
        trace,
        shadow_result="failed_to_judge",
        overrides={"deck.judge.blind_visual": blind_error},
    )
    trace.finish(
        _root_output(
            trace,
            shadow_result="failed_to_judge",
            error_code="judge_unavailable",
        )
    )

    blind_patch = next(payload for payload in client.update_attempts if _update_name(client, payload) == "deck.judge.blind_visual")
    root_patch = next(payload for payload in client.update_attempts if _update_name(client, payload) == "deck.quality.shadow")
    assert blind_patch["error"] == "dq1_failure:judge_unavailable"
    assert root_patch["error"] == "dq1_failure:judge_unavailable"
    assert blind_patch["outputs"]["error"] == {
        "error_code": "judge_unavailable",
        "stage": "blind_visual",
        "retryable": True,
    }
    assert "private" not in repr(blind_patch).lower()


def test_run_ids_are_deterministic_unique_and_persistable_across_restarts() -> None:
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())
    identity = derive_quality_trace_run_identity(root_input)
    persisted = identity.model_dump(mode="json")
    first = _trace(root_input, CapturingClient(), project_name="first-project")
    second = _trace(root_input, CapturingClient(), project_name="second-project")
    first_span = first.start_operation(_operation_input("deck.quality.snapshot"))
    second_span = second.start_operation(_operation_input("deck.quality.snapshot"))

    assert first.run_id == second.run_id == persisted["root_run_id"]
    assert first_span.run_id == second_span.run_id
    assert first_span.run_id == str(identity.operation_run_id("deck.quality.snapshot"))
    all_ids = [persisted["root_run_id"], *(item["run_id"] for item in persisted["operation_run_ids"])]
    assert len(all_ids) == len(set(all_ids)) == 9

    changed = derive_quality_trace_run_identity(SafeQualityTraceRootInput.model_validate(_root_values(quality_run_id=f"quality_{'a' * 64}")))
    assert changed.root_run_id != identity.root_run_id


def test_trace_rejects_raw_dicts_mismatched_identity_and_duplicate_operations() -> None:
    root_input = SafeQualityTraceRootInput.model_validate(_root_values())

    with pytest.raises(TypeError, match="SafeQualityTraceRootInput instance required"):
        SafeQualityTrace(  # type: ignore[arg-type]
            root_input.model_dump(),
            client=CapturingClient(),
            project_name="dq1-canary",
        )

    trace = _trace(root_input, CapturingClient())
    with pytest.raises(SafeQualityTraceEmissionError, match="mismatched quality run"):
        trace.start_operation(
            _operation_input(
                "deck.quality.snapshot",
                quality_run_id=f"quality_{'a' * 64}",
            )
        )

    valid = _operation_input("deck.quality.snapshot")
    trace.start_operation(valid)
    with pytest.raises(SafeQualityTraceEmissionError, match="duplicated"):
        trace.start_operation(valid)


def test_trace_cannot_close_with_an_unfinished_child() -> None:
    trace = _trace(SafeQualityTraceRootInput.model_validate(_root_values()), CapturingClient())
    for operation in REQUIRED_QUALITY_TRACE_OPERATIONS:
        span = trace.start_operation(_operation_input(operation))
        if operation != "deck.quality.snapshot":
            span.finish(_completed_output(operation))

    synthetic_terminals = tuple(SafeQualityTraceOperationTerminal(operation=operation, status="completed") for operation in REQUIRED_QUALITY_TRACE_OPERATIONS)
    with pytest.raises(SafeQualityTraceEmissionError, match="unfinished operation"):
        trace.finish(
            SafeQualityTraceRootOutput(
                shadow_result="needs_revision",
                decision_hash="9" * 64,
                operation_terminals=synthetic_terminals,
                total_latency_ms=10,
            )
        )


def test_sdk_create_and_update_failures_are_isolated_and_retryable() -> None:
    client = CapturingClient()
    client.fail_create_once_for.add("deck.quality.snapshot")
    trace = _trace(SafeQualityTraceRootInput.model_validate(_root_values()), client)
    operation_input = _operation_input("deck.quality.snapshot")

    with pytest.raises(SafeQualityTraceEmissionError) as create_failure:
        trace.start_operation(operation_input)
    assert str(create_failure.value) == "safe quality operation trace creation failed"
    assert create_failure.value.__cause__ is None
    assert create_failure.value.__context__ is None

    span = trace.start_operation(operation_input)
    create_ids = [str(item["id"]) for item in client.create_attempts if item["name"] == operation_input.operation]
    assert len(create_ids) == 2
    assert create_ids[0] == create_ids[1] == span.run_id

    client.fail_update_once_for.add("deck.quality.snapshot")
    output = _completed_output("deck.quality.snapshot")
    with pytest.raises(SafeQualityTraceEmissionError) as update_failure:
        span.finish(output)
    assert str(update_failure.value) == "safe quality operation trace update failed"
    assert update_failure.value.__cause__ is None
    assert update_failure.value.__context__ is None

    span.finish(output)
    assert len([item for item in client.update_attempts if _update_name(client, item) == operation_input.operation]) == 2


def test_langsmith_root_sdk_failure_does_not_escape_provider_exception_text() -> None:
    client = CapturingClient()
    client.fail_create_once_for.add("deck.quality.shadow")

    with pytest.raises(SafeQualityTraceEmissionError) as raised:
        SafeQualityTrace(
            SafeQualityTraceRootInput.model_validate(_root_values()),
            client=client,
            project_name="dq1-canary",
        )

    assert str(raised.value) == "safe quality trace creation failed"
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
