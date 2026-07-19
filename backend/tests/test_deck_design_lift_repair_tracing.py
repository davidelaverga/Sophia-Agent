from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid5

import pytest
from langsmith.utils import LangSmithNotFoundError
from pydantic import ValidationError

from deerflow.sophia.deck_design_lift import repair_tracing as tracing_module
from deerflow.sophia.deck_design_lift.repair_tracing import (
    SafeDeckRepairTrace,
    SafeDeckRepairTraceEmissionError,
    SafeDeckRepairTraceInput,
    SafeDeckRepairTraceOutput,
    configured_deck_repair_trace_factory,
    derive_deck_repair_trace_run_id,
)

_PROJECT_NAMESPACE = UUID("19ddae6a-a8fd-5a49-aea5-77ceaf9876b0")
_PROJECT_NAME = "Sophia"
_PROJECT_ID = UUID("7dd40980-665a-4f4a-95c3-582e6270b707")
_WORKSPACE_ID = UUID("26b7385f-8e69-4a13-b4da-49873ae46191")


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
        self.project_attempts: list[str] = []
        self.flush_attempts: list[float | None] = []
        self.stored_runs: dict[UUID, SimpleNamespace] = {}
        self.commit_then_fail_create = False
        self.commit_then_fail_update = False
        self.fail_create = False
        self.fail_update = False
        self.fail_read = False
        self.fail_flush = False
        self.transient_read_failures = 0
        self.terminal_stale_reads = 0
        self.project_id = _PROJECT_ID
        self.project_name = _PROJECT_NAME
        self.closed = False

    def read_project(self, *, project_name: str) -> SimpleNamespace:
        self.project_attempts.append(project_name)
        return SimpleNamespace(id=self.project_id, name=self.project_name)

    def read_run(
        self,
        run_id: UUID,
        *,
        load_child_runs: bool = False,
    ) -> SimpleNamespace:
        assert load_child_runs is False
        normalized = UUID(str(run_id))
        self.read_attempts.append(normalized)
        if self.fail_read:
            raise RuntimeError("Traceback: Authorization Bearer private-secret raw-context")
        if self.transient_read_failures:
            self.transient_read_failures -= 1
            raise RuntimeError("private transient read response")
        if normalized not in self.stored_runs:
            raise LangSmithNotFoundError("private lookup response")
        remote = deepcopy(self.stored_runs[normalized])
        if self.terminal_stale_reads and remote.end_time is not None:
            self.terminal_stale_reads -= 1
            remote.outputs = None
            remote.error = None
            remote.end_time = None
        return remote

    def create_run(
        self,
        name: str,
        inputs: dict[str, Any],
        run_type: str,
        *,
        project_name: str,
        **kwargs: Any,
    ) -> None:
        attempt = {
            "name": name,
            "inputs": deepcopy(inputs),
            "run_type": run_type,
            "project_name": project_name,
            **deepcopy(kwargs),
        }
        self.create_attempts.append(attempt)
        if self.fail_create:
            raise RuntimeError("Authorization: Bearer private-secret https://signed.example/raw")
        run_id = UUID(str(kwargs["id"]))
        self.stored_runs[run_id] = SimpleNamespace(
            id=run_id,
            name=name,
            run_type=run_type,
            trace_id=UUID(str(kwargs["trace_id"])),
            parent_run_id=kwargs.get("parent_run_id"),
            start_time=kwargs.get("start_time"),
            dotted_order=kwargs.get("dotted_order"),
            session_id=self.project_id,
            inputs=deepcopy(inputs),
            outputs=None,
            error=None,
            end_time=None,
            extra=deepcopy(kwargs.get("extra")),
            tags=deepcopy(kwargs.get("tags")),
            attachments=deepcopy(kwargs.get("attachments")),
            events=deepcopy(kwargs.get("events")),
        )
        if self.commit_then_fail_create:
            self.commit_then_fail_create = False
            raise RuntimeError("private committed-create response with secret")

    def update_run(self, run_id: UUID, **kwargs: Any) -> None:
        attempt = {"run_id": UUID(str(run_id)), **deepcopy(kwargs)}
        self.update_attempts.append(attempt)
        if self.fail_update:
            raise RuntimeError("Traceback: provider response sk-proj-private")
        remote = self.stored_runs[UUID(str(run_id))]
        remote.outputs = deepcopy(kwargs.get("outputs"))
        remote.error = kwargs.get("error")
        remote.end_time = kwargs.get("end_time")
        if kwargs.get("attachments"):
            remote.attachments = deepcopy(kwargs["attachments"])
        if kwargs.get("events"):
            remote.events = deepcopy(kwargs["events"])
        if self.commit_then_fail_update:
            self.commit_then_fail_update = False
            raise RuntimeError("private committed-update response with raw candidate")

    def flush(self, timeout: float | None = None) -> None:
        self.flush_attempts.append(timeout)
        if self.fail_flush:
            raise RuntimeError("Bearer private-secret from flush")

    def close(self) -> None:
        self.closed = True


def _trace_input(**overrides: Any) -> SafeDeckRepairTraceInput:
    values: dict[str, Any] = {
        "campaign_run_id": "campaign-dq2-001",
        "experiment_id": "experiment-dq2-001",
        "build_id": "build-psi-001",
        "user_id": "user-canary-001",
        "operation_id": "operation-dq2-001",
        "transaction_id": "transaction-dq2-001",
        "initial_quality_run_id": "quality-initial-001",
        "program_hash": "a" * 64,
        "payload_hash": "b" * 64,
        "plan_hash": "c" * 64,
    }
    values.update(overrides)
    return SafeDeckRepairTraceInput.model_validate(values)


def _success_output(**overrides: Any) -> SafeDeckRepairTraceOutput:
    values: dict[str, Any] = {
        "status": "completed",
        "latency_ms": 875,
        "input_tokens": 1_200,
        "output_tokens": 300,
        "total_tokens": 1_500,
    }
    values.update(overrides)
    return SafeDeckRepairTraceOutput.model_validate(values)


def _trace(
    client: CapturingClient,
    trace_input: SafeDeckRepairTraceInput | None = None,
) -> SafeDeckRepairTrace:
    return SafeDeckRepairTrace(
        trace_input or _trace_input(),
        client=client,
        project_name=_PROJECT_NAME,
        expected_project_id=_PROJECT_ID,
    )


def _serialized_trace_surfaces(client: CapturingClient) -> str:
    surfaces = {
        "create": [
            {
                "inputs": item.get("inputs"),
                "extra": item.get("extra"),
                "tags": item.get("tags"),
                "attachments": item.get("attachments"),
                "events": item.get("events"),
            }
            for item in client.create_attempts
        ],
        "update": [
            {
                "outputs": item.get("outputs"),
                "error": item.get("error"),
                "attachments": item.get("attachments"),
                "events": item.get("events"),
            }
            for item in client.update_attempts
        ],
    }
    return repr(surfaces).lower()


def test_success_trace_emits_only_exact_ids_hashes_and_metrics() -> None:
    client = CapturingClient()
    trace_input = _trace_input()
    trace = _trace(client, trace_input)

    trace.finish(_success_output())

    assert trace.already_terminal is True
    assert trace.run_id == str(derive_deck_repair_trace_run_id(trace_input))
    assert len(client.create_attempts) == len(client.update_attempts) == 1
    create = client.create_attempts[0]
    assert set(create) == {
        "attachments",
        "dangerously_allow_filesystem",
        "dotted_order",
        "events",
        "extra",
        "id",
        "inputs",
        "name",
        "parent_run_id",
        "project_name",
        "run_type",
        "start_time",
        "tags",
        "trace_id",
    }
    assert create["dotted_order"] == (
        create["start_time"].strftime("%Y%m%dT%H%M%S%fZ")
        + str(create["id"])
    )
    assert set(create["inputs"]) == {
        "schema_version",
        "campaign_run_id",
        "experiment_id",
        "build_id",
        "user_id",
        "operation_id",
        "transaction_id",
        "initial_quality_run_id",
        "program_hash",
        "payload_hash",
        "plan_hash",
    }
    metadata = create["extra"]["metadata"]
    assert set(metadata) == {*set(create["inputs"]), "operation", "ls_run_depth"}
    assert metadata["operation"] == "deck.repair.author"
    assert metadata["ls_run_depth"] == 0
    assert create["attachments"] == {}
    assert create["events"] == []
    assert create["dangerously_allow_filesystem"] is False
    update = client.update_attempts[0]
    assert set(update) == {
        "attachments",
        "dangerously_allow_filesystem",
        "end_time",
        "error",
        "events",
        "outputs",
        "run_id",
    }
    assert update["error"] is None
    assert set(update["outputs"]) == {
        "schema_version",
        "status",
        "invoke_attempt_count",
        "latency_ms",
        "input_tokens",
        "output_tokens",
        "total_tokens",
    }
    serialized = _serialized_trace_surfaces(client)
    for forbidden in (
        "api_key",
        "authorization",
        "base64",
        "bearer ",
        "candidate_content",
        "context",
        "creative_plan",
        "data:image",
        "design_plan",
        "exception_text",
        "http://",
        "https://",
        "messages",
        "provider_payload",
        "raw_candidate",
        "runtime",
        "secret",
        "serialized",
        "source_text",
        "traceback",
    ):
        assert forbidden not in serialized


def test_failure_trace_uses_only_controlled_code_and_partial_safe_metrics() -> None:
    client = CapturingClient()
    trace = _trace(client)
    output = SafeDeckRepairTraceOutput(
        status="error",
        latency_ms=3_000,
        input_tokens=1_200,
        error_code="repair_unavailable",
    )

    trace.finish(output)

    update = client.update_attempts[0]
    assert update["outputs"] == output.model_dump(mode="json", exclude_none=True)
    assert update["error"] == "dq2_repair_failure:repair_unavailable"
    assert "exception" not in _serialized_trace_surfaces(client)
    assert "private" not in _serialized_trace_surfaces(client)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("context", {"brief": "raw user request"}),
        ("sources", ["<section>private</section>"]),
        ("artifact_path", "/tmp/private/render.png"),
        ("messages", [{"content": "raw prompt"}]),
        ("candidate", {"content": "model output"}),
        ("provider_payload", {"input": "raw"}),
        ("secret", "lsv2_sk_private"),
        ("exception_text", "Traceback: private body"),
    ],
)
def test_trace_models_reject_every_non_whitelisted_content_surface(
    field: str,
    value: Any,
) -> None:
    values = _trace_input().model_dump(mode="python")
    values[field] = value

    with pytest.raises(ValidationError):
        SafeDeckRepairTraceInput.model_validate(values)

    output = _success_output().model_dump(mode="python")
    output[field] = value
    with pytest.raises(ValidationError):
        SafeDeckRepairTraceOutput.model_validate(output)


@pytest.mark.parametrize(
    "unsafe_value",
    [
        "/private/source.html",
        "https://storage.example/render.png?signature=secret",
        "Bearer provider-secret",
        "data:image/png;base64,aGVsbG8=",
        "Traceback: RuntimeError private-provider-body",
        "RuntimeError-private-provider-body",
        "lsv2_sk_private-provider-key",
        "A" * 100,
    ],
)
def test_trace_rejects_raw_content_hidden_in_identifier_fields(
    unsafe_value: str,
) -> None:
    with pytest.raises(ValidationError):
        _trace_input(experiment_id=unsafe_value)


def test_create_and_update_commit_then_error_are_reconciled_idempotently() -> None:
    client = CapturingClient()
    client.commit_then_fail_create = True
    client.commit_then_fail_update = True
    trace_input = _trace_input()
    output = _success_output()

    first = _trace(client, trace_input)
    first.finish(output)
    second = _trace(client, trace_input)

    assert second.already_terminal is True
    second.finish(output)
    assert len(client.stored_runs) == 1
    assert len(client.create_attempts) == 1
    assert len(client.update_attempts) == 1
    assert client.stored_runs[derive_deck_repair_trace_run_id(trace_input)].outputs == output.model_dump(
        mode="json",
        exclude_none=True,
    )

    with pytest.raises(SafeDeckRepairTraceEmissionError, match="conflicts"):
        _trace(client, trace_input).finish(_success_output(latency_ms=876))


def test_terminal_readback_retries_exact_pending_and_transient_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tracing_module,
        "_TERMINAL_READBACK_DELAYS_SECONDS",
        (0.0, 0.0, 0.0, 0.0),
    )
    client = CapturingClient()
    trace = _trace(client)
    client.terminal_stale_reads = 2
    client.transient_read_failures = 1

    trace.finish(_success_output())

    assert trace.already_terminal is True
    assert len(client.update_attempts) == 1
    assert client.terminal_stale_reads == 0
    assert client.transient_read_failures == 0


def test_terminal_readback_exhaustion_keeps_one_update_and_fails_safely(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tracing_module,
        "_TERMINAL_READBACK_DELAYS_SECONDS",
        (0.0, 0.0, 0.0),
    )
    client = CapturingClient()
    trace = _trace(client)
    client.terminal_stale_reads = 10

    with pytest.raises(SafeDeckRepairTraceEmissionError, match="readback"):
        trace.finish(_success_output())

    assert len(client.update_attempts) == 1
    assert client.terminal_stale_reads == 7
    assert client.stored_runs[derive_deck_repair_trace_run_id(_trace_input())].end_time is not None


def test_open_existing_missing_trace_fails_without_creating() -> None:
    client = CapturingClient()

    with pytest.raises(SafeDeckRepairTraceEmissionError, match="pre-admitted"):
        SafeDeckRepairTrace(
            _trace_input(),
            client=client,
            project_name=_PROJECT_NAME,
            expected_project_id=_PROJECT_ID,
            require_existing=True,
        )

    assert client.create_attempts == []
    assert client.update_attempts == []


@pytest.mark.parametrize("stage", ["create", "read", "update", "flush"])
def test_raw_sdk_failures_are_discarded_and_fail_closed(stage: str) -> None:
    client = CapturingClient()
    if stage == "create":
        client.fail_create = True

        def action() -> object:
            return _trace(client)

    elif stage == "read":
        client.fail_read = True

        def action() -> object:
            return _trace(client)

    else:
        trace = _trace(client)
        if stage == "update":
            client.fail_update = True
        else:
            client.fail_flush = True

        def action() -> object:
            return trace.finish(_success_output())

    with pytest.raises(SafeDeckRepairTraceEmissionError) as error:
        action()

    serialized = str(error.value).lower()
    for forbidden in (
        "authorization",
        "bearer",
        "context",
        "https://",
        "private-secret",
        "provider response",
        "sk-proj",
        "traceback",
    ):
        assert forbidden not in serialized


def test_remote_project_identity_and_runtime_metadata_fail_closed() -> None:
    client = CapturingClient()
    client.project_id = uuid5(_PROJECT_NAMESPACE, "wrong-project")
    with pytest.raises(SafeDeckRepairTraceEmissionError, match="project validation"):
        _trace(client)

    client = CapturingClient()
    client._omit_traced_runtime_info = False
    with pytest.raises(TypeError, match="runtime metadata"):
        _trace(client)

    client = CapturingClient()
    client.tracing_queue = object()
    with pytest.raises(TypeError, match="buffered"):
        _trace(client)


def test_remote_root_ordering_identity_is_required() -> None:
    client = CapturingClient()
    trace_input = _trace_input()
    _trace(client, trace_input)
    run_id = derive_deck_repair_trace_run_id(trace_input)
    client.stored_runs[run_id].dotted_order = f"wrong.{run_id}"

    with pytest.raises(SafeDeckRepairTraceEmissionError, match="remote state"):
        _trace(client, trace_input)


def test_configured_factory_requires_explicit_eu_client_and_project_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    client = CapturingClient()

    def build_client(**kwargs: Any) -> CapturingClient:
        captured.update(kwargs)
        return client

    monkeypatch.setattr(tracing_module, "LangSmithClient", build_client)
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_sk_private-not-traced")
    monkeypatch.setenv("LANGSMITH_PROJECT", _PROJECT_NAME)
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", str(_WORKSPACE_ID))
    monkeypatch.setenv("LANGSMITH_PROJECT_UUID", str(_PROJECT_ID))

    factory = configured_deck_repair_trace_factory()
    trace = factory(_trace_input())
    trace.finish(_success_output())
    factory.close()

    assert captured == {
        "api_url": "https://eu.api.smith.langchain.com",
        "api_key": "lsv2_sk_private-not-traced",
        "workspace_id": str(_WORKSPACE_ID),
        "timeout_ms": 15_000,
        "auto_batch_tracing": False,
        "omit_traced_runtime_info": True,
    }
    assert client.closed is True
    assert "lsv2_sk_private-not-traced" not in _serialized_trace_surfaces(client)


@pytest.mark.parametrize(
    ("name", "value", "match"),
    [
        ("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com", "EU endpoint"),
        ("LANGSMITH_ENDPOINT", "", "LANGSMITH_ENDPOINT"),
        ("LANGSMITH_API_KEY", "", "LANGSMITH_API_KEY"),
        ("LANGSMITH_PROJECT", "", "LANGSMITH_PROJECT"),
        ("LANGSMITH_WORKSPACE_ID", "", "WORKSPACE_ID"),
        ("LANGSMITH_PROJECT_UUID", "", "PROJECT_UUID"),
        ("LANGSMITH_WORKSPACE_ID", "not-a-uuid", "workspace and project UUIDs"),
        ("LANGSMITH_PROJECT_UUID", "not-a-uuid", "workspace and project UUIDs"),
    ],
)
def test_configured_factory_fails_closed_on_missing_or_ambiguous_env(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
    match: str,
) -> None:
    created = False

    def build_client(**_kwargs: Any) -> CapturingClient:
        nonlocal created
        created = True
        return CapturingClient()

    monkeypatch.setattr(tracing_module, "LangSmithClient", build_client)
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_sk_private")
    monkeypatch.setenv("LANGSMITH_PROJECT", _PROJECT_NAME)
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", str(_WORKSPACE_ID))
    monkeypatch.setenv("LANGSMITH_PROJECT_UUID", str(_PROJECT_ID))
    monkeypatch.setenv(name, value)

    with pytest.raises(RuntimeError, match=match):
        configured_deck_repair_trace_factory()

    assert created is False


@pytest.mark.parametrize(
    ("name", "identity"),
    (
        ("LANGSMITH_WORKSPACE_ID", "26B7385F-8E69-4A13-B4DA-49873AE46191"),
        ("LANGSMITH_WORKSPACE_ID", "26b7385f8e694a13b4da49873ae46191"),
        ("LANGSMITH_WORKSPACE_ID", "{26b7385f-8e69-4a13-b4da-49873ae46191}"),
        ("LANGSMITH_PROJECT_UUID", "7DD40980-665A-4F4A-95C3-582E6270B707"),
        ("LANGSMITH_PROJECT_UUID", "7dd40980665a4f4a95c3582e6270b707"),
        ("LANGSMITH_PROJECT_UUID", "{7dd40980-665a-4f4a-95c3-582e6270b707}"),
    ),
)
def test_configured_factory_rejects_noncanonical_trace_identity_before_client_creation(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    identity: str,
) -> None:
    created = False

    def build_client(**_kwargs: Any) -> CapturingClient:
        nonlocal created
        created = True
        return CapturingClient()

    monkeypatch.setattr(tracing_module, "LangSmithClient", build_client)
    monkeypatch.setenv("LANGSMITH_ENDPOINT", "https://eu.api.smith.langchain.com")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2_sk_private")
    monkeypatch.setenv("LANGSMITH_PROJECT", _PROJECT_NAME)
    monkeypatch.setenv("LANGSMITH_WORKSPACE_ID", str(_WORKSPACE_ID))
    monkeypatch.setenv("LANGSMITH_PROJECT_UUID", str(_PROJECT_ID))
    monkeypatch.setenv(name, identity)

    with pytest.raises(RuntimeError, match="canonical workspace and project UUIDs"):
        configured_deck_repair_trace_factory()

    assert created is False
