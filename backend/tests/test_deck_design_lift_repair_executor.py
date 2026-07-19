from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from pydantic import ValidationError

from deerflow.sophia.deck_design_lift.invoker import (
    DeckRepairInvocationMetrics,
    DeckRepairInvocationResult,
)
from deerflow.sophia.deck_design_lift.repair_executor import (
    MAX_REPAIR_RESULT_BYTES,
    DeckRepairInvokeOnceError,
    DurableDeckRepairExecutor,
    repair_invocation_object_paths,
)
from deerflow.sophia.deck_design_lift.runtime import (
    DeckRepairTraceCompletionPending,
    RepairInvocationRequest,
)
from deerflow.sophia.deck_design_lift.schemas import (
    DeckRepairCandidate,
    DeckRepairProgram,
    RepairRenderEvidence,
    SelectorRepair,
    SkillRef,
    SourceUpdate,
)
from deerflow.sophia.deck_quality.canonical import (
    canonical_json_bytes,
    canonical_sha256,
)
from deerflow.sophia.storage.supabase_artifact_store import ArtifactObjectSizeError

HASH = "a" * 64
OTHER_HASH = "b" * 64
PRIVATE_PROGRAM_TEXT = "PRIVATE_PROGRAM_INPUT_MUST_NOT_BE_PERSISTED"
PRIVATE_PROVIDER_PAYLOAD = "PRIVATE_PROVIDER_PAYLOAD_MUST_NOT_BE_PERSISTED"
SYNTHETIC_SECRET = "synthetic-secret-must-not-be-persisted"


def _run(awaitable):
    return asyncio.run(awaitable)


def _program() -> DeckRepairProgram:
    evidence = RepairRenderEvidence(
        selector="slide:1",
        path="renders/slide-1.png",
        sha256=HASH,
    )
    skill = SkillRef(
        path="skills/public/hands-on-deck/designing-slides.md",
        source_hash=HASH,
        excerpt_hash=OTHER_HASH,
    )
    payload: dict[str, Any] = {
        "schema_version": "sophia-deck-repair-program/v1",
        "build_id": "build-psi-001",
        "initial_quality_run_id": "quality-initial-001",
        "initial_manifest_revision": 1,
        "repair_attempt": 1,
        "plan_revision_allowed": False,
        "authorized_selectors": ("slide:1",),
        "authorized_source_roles": {"slide:1": ("body",)},
        "deck_instruction": PRIVATE_PROGRAM_TEXT,
        "selector_repairs": (
            SelectorRepair(
                selector="slide:1",
                failure_codes=("weak_subject_specificity",),
                render_evidence=(evidence,),
                instruction=PRIVATE_PROGRAM_TEXT,
                retained_content=("Preserve every factual claim.",),
            ),
        ),
        "must_preserve": ("Preserve every factual claim.",),
        "must_not": ("Do not add or remove slides.",),
        "skill_refs": (skill,),
        "expected_improvements": ("weak_subject_specificity",),
        "forbidden_regressions": ("content_fidelity_regression",),
        "rubric_version": "deck-quality-rubric-v1",
        "instrument_hash": HASH,
    }
    payload["program_hash"] = canonical_sha256(payload)
    return DeckRepairProgram.model_validate(payload)


def _request() -> RepairInvocationRequest:
    return RepairInvocationRequest(
        campaign_run_id="campaign-dq2-001",
        experiment_id="experiment-dq2-001",
        user_id="user-canary-001",
        thread_id="thread-canary-001",
        build_id="build-psi-001",
        operation_id="operation-dq2-001",
        transaction_id="transaction-dq2-001",
        initial_artifact_version_id="artifact-initial-001",
        program=_program(),
    )


def _candidate(*, content: str = "<section><h1>Repaired PSI</h1></section>") -> DeckRepairCandidate:
    return DeckRepairCandidate(
        source_updates=(
            SourceUpdate(
                selector="slide:1",
                source_role="body",
                expected_source_hash=HASH,
                content=content,
            ),
        ),
        rationale="Repair visual hierarchy while preserving all factual content.",
    )


def _metrics(**updates: object) -> DeckRepairInvocationMetrics:
    values: dict[str, object] = {
        "latency_ms": 1_234,
        "input_tokens": 2_000,
        "output_tokens": 500,
        "total_tokens": 2_500,
        "deployment_name": "openai-gpt-5-6-sol",
        "provider": "openai",
        "provider_model": "gpt-5.6-sol",
        "route_name": "deck.repair.executor",
        "profile_version": "v1",
        "plan_hash": HASH,
        "payload_hash": OTHER_HASH,
    }
    values.update(updates)
    return DeckRepairInvocationMetrics(**values)  # type: ignore[arg-type]


class RecordingAuthor:
    def __init__(
        self,
        *,
        candidate: DeckRepairCandidate | None = None,
        metrics: DeckRepairInvocationMetrics | None = None,
        error: BaseException | None = None,
        trace_error: Exception | None = None,
    ) -> None:
        self.result = DeckRepairInvocationResult(
            candidate=candidate or _candidate(),
            metrics=metrics or _metrics(),
        )
        self.error = error
        self.trace_error = trace_error
        self.calls: list[RepairInvocationRequest] = []
        self.trace_calls: list[
            tuple[RepairInvocationRequest, DeckRepairInvocationResult]
        ] = []
        self.private_provider_payload = PRIVATE_PROVIDER_PAYLOAD

    async def __call__(
        self,
        request: RepairInvocationRequest,
    ) -> DeckRepairInvocationResult:
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return self.result

    async def complete_success_trace(
        self,
        request: RepairInvocationRequest,
        result: DeckRepairInvocationResult,
    ) -> None:
        self.trace_calls.append((request, result))
        if self.trace_error is not None:
            raise self.trace_error


class InMemoryAsyncImmutableObjectStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.create_calls: list[tuple[str, bytes, str]] = []
        self.read_calls: list[tuple[str, int]] = []
        self.raise_before_create: set[str] = set()
        self.raise_after_create: set[str] = set()
        self.cancel_after_create: set[str] = set()

    async def read_bounded(
        self,
        object_path: str,
        *,
        max_bytes: int,
    ) -> bytes | None:
        self.read_calls.append((object_path, max_bytes))
        content = self.objects.get(object_path)
        if content is not None and len(content) > max_bytes:
            raise ArtifactObjectSizeError("oversized synthetic object")
        return content

    async def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> str:
        self.create_calls.append((object_path, content, content_type))
        if object_path in self.raise_before_create:
            raise RuntimeError("synthetic response loss before persistence")
        if object_path in self.objects:
            return "exists"
        self.objects[object_path] = content
        if object_path in self.cancel_after_create:
            raise asyncio.CancelledError
        if object_path in self.raise_after_create:
            raise RuntimeError("synthetic response loss after persistence")
        return "created"


def _assert_code(error: pytest.ExceptionInfo[DeckRepairInvokeOnceError], code: str) -> None:
    assert error.value.code == code
    assert str(error.value) == code


def test_success_persists_only_canonical_intent_structured_result_and_safe_metrics() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    author = RecordingAuthor()
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    candidate = _run(executor.invoke_once(request))

    assert candidate == _candidate()
    assert author.calls == [request]
    assert author.trace_calls == [(request, author.result)]
    assert paths.intent == ("artifacts/user-canary-001/thread-canary-001/foundation/.builder/builds/build-psi-001/deck_design_lift/transactions/transaction-dq2-001/repair_call/operation-dq2-001/intent.json")
    assert paths.result == paths.intent.replace("intent.json", "result.json")
    assert [call[0] for call in store.create_calls] == [paths.intent, paths.result]
    assert {call[2] for call in store.create_calls} == {"application/json"}

    intent_document = json.loads(store.objects[paths.intent])
    result_document = json.loads(store.objects[paths.result])
    assert set(intent_document) == {
        "identity",
        "initial_manifest_revision",
        "repair_attempt",
        "request_identity_hash",
        "schema_version",
    }
    assert set(result_document) == {
        "candidate",
        "candidate_hash",
        "identity",
        "intent_hash",
        "metrics",
        "schema_version",
    }
    assert set(result_document["metrics"]) == {
        "deployment_name",
        "input_tokens",
        "latency_ms",
        "output_tokens",
        "payload_hash",
        "plan_hash",
        "profile_version",
        "provider",
        "provider_model",
        "route_name",
        "total_tokens",
    }
    for content in store.objects.values():
        assert content == canonical_json_bytes(json.loads(content))
        assert PRIVATE_PROGRAM_TEXT.encode() not in content
        assert PRIVATE_PROVIDER_PAYLOAD.encode() not in content
        assert SYNTHETIC_SECRET.encode() not in content


def test_valid_result_replay_returns_without_a_second_author_call() -> None:
    request = _request()
    store = InMemoryAsyncImmutableObjectStore()
    first_author = RecordingAuthor()
    first = DurableDeckRepairExecutor(object_store=store, author=first_author)
    assert _run(first.invoke_once(request)) == _candidate()

    replay_author = RecordingAuthor(error=AssertionError("must not be called"))
    replay = DurableDeckRepairExecutor(object_store=store, author=replay_author)

    assert _run(replay.invoke_once(request)) == _candidate()
    assert len(first_author.calls) == 1
    assert replay_author.calls == []
    assert len(first_author.trace_calls) == 1
    assert len(replay_author.trace_calls) == 1
    assert len(store.create_calls) == 2


def test_result_is_durable_before_trace_completion_and_replay_never_calls_author() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()

    class PersistFirstAuthor(RecordingAuthor):
        async def complete_success_trace(
            self,
            request: RepairInvocationRequest,
            result: DeckRepairInvocationResult,
        ) -> None:
            assert paths.result in store.objects
            await super().complete_success_trace(request, result)

    first_author = PersistFirstAuthor(
        trace_error=RuntimeError("private trace transport failure")
    )
    first = DurableDeckRepairExecutor(object_store=store, author=first_author)

    with pytest.raises(DeckRepairTraceCompletionPending) as pending:
        _run(first.invoke_once(request))

    assert str(pending.value) == "repair success trace completion is pending"
    assert paths.result in store.objects
    assert first_author.calls == [request]
    assert len(first_author.trace_calls) == 1

    replay_author = RecordingAuthor(error=AssertionError("must not be called"))
    replay = DurableDeckRepairExecutor(object_store=store, author=replay_author)

    assert _run(replay.invoke_once(request)) == _candidate()
    assert replay_author.calls == []
    assert len(replay_author.trace_calls) == 1
    assert len(store.create_calls) == 2


def test_persisted_result_with_trace_conflict_never_reaches_candidate_or_provider() -> None:
    request = _request()
    store = InMemoryAsyncImmutableObjectStore()
    first_author = RecordingAuthor(trace_error=RuntimeError("terminal conflict"))

    with pytest.raises(DeckRepairTraceCompletionPending):
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=first_author,
            ).invoke_once(request)
        )

    replay_author = RecordingAuthor(
        error=AssertionError("must not be called"),
        trace_error=RuntimeError("terminal conflict"),
    )
    with pytest.raises(DeckRepairTraceCompletionPending):
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=replay_author,
            ).invoke_once(request)
        )

    assert first_author.calls == [request]
    assert replay_author.calls == []
    assert len(replay_author.trace_calls) == 1


def test_intent_create_response_loss_is_ambiguous_and_never_calls_author() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    store.raise_after_create.add(paths.intent)
    author = RecordingAuthor()
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    with pytest.raises(DeckRepairInvokeOnceError) as first:
        _run(executor.invoke_once(request))
    _assert_code(first, "invocation_ambiguous")
    assert author.calls == []

    store.raise_after_create.clear()
    with pytest.raises(DeckRepairInvokeOnceError) as replay:
        _run(executor.invoke_once(request))
    _assert_code(replay, "invocation_ambiguous")
    assert author.calls == []


def test_cancellation_after_intent_persistence_never_calls_author_on_replay() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    store.cancel_after_create.add(paths.intent)
    author = RecordingAuthor()
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    with pytest.raises(asyncio.CancelledError):
        _run(executor.invoke_once(request))
    assert author.calls == []

    store.cancel_after_create.clear()
    with pytest.raises(DeckRepairInvokeOnceError) as replay:
        _run(executor.invoke_once(request))
    _assert_code(replay, "invocation_ambiguous")
    assert author.calls == []


def test_cancellation_in_author_leaves_permanent_fence_and_no_second_call() -> None:
    request = _request()
    store = InMemoryAsyncImmutableObjectStore()
    cancelled_author = RecordingAuthor(error=asyncio.CancelledError())
    executor = DurableDeckRepairExecutor(object_store=store, author=cancelled_author)

    with pytest.raises(asyncio.CancelledError):
        _run(executor.invoke_once(request))
    assert len(cancelled_author.calls) == 1

    replay_author = RecordingAuthor()
    replay = DurableDeckRepairExecutor(object_store=store, author=replay_author)
    with pytest.raises(DeckRepairInvokeOnceError) as error:
        _run(replay.invoke_once(request))
    _assert_code(error, "invocation_ambiguous")
    assert replay_author.calls == []


def test_lost_result_create_response_is_reconciled_by_exact_readback() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    store.raise_after_create.add(paths.result)
    author = RecordingAuthor()
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    assert _run(executor.invoke_once(request)) == _candidate()
    assert len(author.calls) == 1

    store.raise_after_create.clear()
    assert _run(executor.invoke_once(request)) == _candidate()
    assert len(author.calls) == 1


def test_missing_result_after_one_author_call_is_ambiguous_and_never_retried() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    store.raise_before_create.add(paths.result)
    author = RecordingAuthor()
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    with pytest.raises(DeckRepairInvokeOnceError) as first:
        _run(executor.invoke_once(request))
    _assert_code(first, "result_persistence_ambiguous")
    assert len(author.calls) == 1

    store.raise_before_create.clear()
    with pytest.raises(DeckRepairInvokeOnceError) as replay:
        _run(executor.invoke_once(request))
    _assert_code(replay, "invocation_ambiguous")
    assert len(author.calls) == 1


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    (
        ("pretty", "intent_invalid"),
        ("conflict", "intent_conflict"),
    ),
)
def test_existing_intent_must_match_exact_canonical_bytes(
    mutation: str,
    expected_code: str,
) -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    assert (
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=RecordingAuthor(),
            ).invoke_once(request)
        )
        == _candidate()
    )
    document = json.loads(store.objects[paths.intent])
    if mutation == "pretty":
        store.objects[paths.intent] = json.dumps(document, indent=2).encode()
    else:
        document["identity"]["campaign_run_id"] = "campaign-dq2-999"
        document["request_identity_hash"] = canonical_sha256(
            {
                "identity": document["identity"],
                "initial_manifest_revision": document["initial_manifest_revision"],
                "repair_attempt": document["repair_attempt"],
            }
        )
        store.objects[paths.intent] = canonical_json_bytes(document)

    replay_author = RecordingAuthor()
    with pytest.raises(DeckRepairInvokeOnceError) as error:
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=replay_author,
            ).invoke_once(request)
        )
    _assert_code(error, expected_code)
    assert replay_author.calls == []


@pytest.mark.parametrize(
    ("replacement", "expected_code"),
    (
        (b"{", "result_invalid"),
        (b"x" * (MAX_REPAIR_RESULT_BYTES + 1), "result_oversize"),
    ),
)
def test_malformed_or_oversized_persisted_result_fails_closed_without_author(
    replacement: bytes,
    expected_code: str,
) -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    assert (
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=RecordingAuthor(),
            ).invoke_once(request)
        )
        == _candidate()
    )
    store.objects[paths.result] = replacement
    replay_author = RecordingAuthor()

    with pytest.raises(DeckRepairInvokeOnceError) as error:
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=replay_author,
            ).invoke_once(request)
        )
    _assert_code(error, expected_code)
    assert replay_author.calls == []


def test_canonical_result_with_conflicting_transaction_identity_fails_closed() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    assert (
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=RecordingAuthor(),
            ).invoke_once(request)
        )
        == _candidate()
    )
    document = json.loads(store.objects[paths.result])
    document["identity"]["transaction_id"] = "transaction-dq2-999"
    store.objects[paths.result] = canonical_json_bytes(document)
    replay_author = RecordingAuthor()

    with pytest.raises(DeckRepairInvokeOnceError) as error:
        _run(
            DurableDeckRepairExecutor(
                object_store=store,
                author=replay_author,
            ).invoke_once(request)
        )
    _assert_code(error, "result_conflict")
    assert replay_author.calls == []


def test_oversized_authored_candidate_is_not_persisted_or_retried() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    author = RecordingAuthor(
        candidate=_candidate(content="x" * MAX_REPAIR_RESULT_BYTES),
    )
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    with pytest.raises(DeckRepairInvokeOnceError) as first:
        _run(executor.invoke_once(request))
    _assert_code(first, "result_oversize")
    assert len(author.calls) == 1
    assert paths.result not in store.objects

    with pytest.raises(DeckRepairInvokeOnceError) as replay:
        _run(executor.invoke_once(request))
    _assert_code(replay, "invocation_ambiguous")
    assert len(author.calls) == 1


def test_unallowlisted_metric_identity_cannot_persist_secret_or_result() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    store = InMemoryAsyncImmutableObjectStore()
    author = RecordingAuthor(metrics=_metrics(provider=SYNTHETIC_SECRET))
    executor = DurableDeckRepairExecutor(object_store=store, author=author)

    with pytest.raises(DeckRepairInvokeOnceError) as error:
        _run(executor.invoke_once(request))
    _assert_code(error, "author_result_invalid")
    assert len(author.calls) == 1
    assert paths.result not in store.objects
    assert SYNTHETIC_SECRET.encode() not in store.objects[paths.intent]


def test_orphan_result_and_unsafe_path_identity_fail_before_author() -> None:
    request = _request()
    paths = repair_invocation_object_paths(request)
    orphaned = InMemoryAsyncImmutableObjectStore()
    orphaned.objects[paths.result] = b"{}"
    author = RecordingAuthor()
    with pytest.raises(DeckRepairInvokeOnceError) as orphan_error:
        _run(
            DurableDeckRepairExecutor(
                object_store=orphaned,
                author=author,
            ).invoke_once(request)
        )
    _assert_code(orphan_error, "result_invalid")
    assert author.calls == []

    unsafe = request.model_copy(update={"operation_id": "operation:unsafe"})
    with pytest.raises(DeckRepairInvokeOnceError) as scope_error:
        repair_invocation_object_paths(unsafe)
    _assert_code(scope_error, "invalid_request_scope")


def test_repair_request_freezes_canonical_thread_and_program_build_scope() -> None:
    values = _request().model_dump(mode="json")
    values["build_id"] = "build-other-001"
    with pytest.raises(ValidationError, match="frozen program"):
        RepairInvocationRequest.model_validate(values)

    values = _request().model_dump(mode="json")
    values["thread_id"] = "thread:unsafe"
    with pytest.raises(ValidationError, match="not canonical"):
        RepairInvocationRequest.model_validate(values)
