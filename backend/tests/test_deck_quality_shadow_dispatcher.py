from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

import app.gateway.workers.deck_quality_dispatcher as dispatcher_module
from app.gateway.workers.deck_quality_dispatcher import DeckQualityDispatcher
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.canonical import canonical_sha256
from deerflow.sophia.deck_quality.persistence import (
    QualityRunDecision,
    QualityRunErrorCode,
    QualityRunLease,
    QualityRunRecord,
    QualityRunStage,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock


def _instrument() -> QualityInstrumentLock:
    return QualityInstrumentLock(
        rubric_version="deck-rubric-v2",
        rubric_hash="a" * 64,
        prompt_hashes={"blind_visual": "b" * 64, "plan_realization": "c" * 64},
        judge_plan_hash="d" * 64,
        judge_profile_version="v1",
        evidence_preprocessor_version="deck-evidence-v2",
        judge_invoker_version="deck-judge-invoker-v4",
        assessment_schema_versions={"blind_visual": "v4", "mechanical": "v1", "plan_realization": "v4"},
        adjudication_policy_hash="e" * 64,
    )


def _record(
    *,
    user_id: str = "canary-user",
    state: str = "running",
    lease_epoch: int = 1,
    attempt_count: int = 1,
    last_error_code: QualityRunErrorCode | None = None,
    last_error_stage: str | None = None,
    last_error_at: datetime | None = None,
    dispatch_intent_status: str | None = None,
    dispatch_intent_epoch: int | None = None,
    dispatch_intent_attempt_count: int | None = None,
    dispatch_intent_token: str | None = None,
    dispatch_recovery_proof_hash: str | None = None,
    dispatch_intent_at: datetime | None = None,
    dispatch_resolved_at: datetime | None = None,
    instrument: QualityInstrumentLock | None = None,
) -> QualityRunRecord:
    lock = instrument or _instrument()
    from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id

    quality_run_id = derive_quality_run_id(
        artifact_version_id="artifact-version-1",
        campaign_id="DQ-1",
        instrument=lock,
    )
    now = datetime.now(UTC)
    if dispatch_intent_status is not None:
        dispatch_intent_epoch = dispatch_intent_epoch or lease_epoch
        dispatch_intent_attempt_count = (
            dispatch_intent_attempt_count
            if dispatch_intent_attempt_count is not None
            else attempt_count
        )
        dispatch_intent_token = dispatch_intent_token or "dq1-dispatch:prior"
        dispatch_intent_at = dispatch_intent_at or now - timedelta(seconds=5)
        if dispatch_intent_status in {"confirmed", "reconciled"}:
            dispatch_resolved_at = dispatch_resolved_at or now - timedelta(
                seconds=4
            )
    return QualityRunRecord.model_validate(
        {
            "quality_run_id": quality_run_id,
            "campaign_id": "DQ-1",
            "scope_kind": "canary",
            "instrument_schema_version": lock.schema_version,
            "instrument_identity_hash": canonical_sha256(lock),
            "rubric_version": lock.rubric_version,
            "rubric_hash": lock.rubric_hash,
            "prompt_hashes": lock.prompt_hashes,
            "judge_plan_hash": lock.judge_plan_hash,
            "judge_profile_version": lock.judge_profile_version,
            "evidence_preprocessor_version": lock.evidence_preprocessor_version,
            "judge_invoker_version": lock.judge_invoker_version,
            "assessment_schema_versions": lock.assessment_schema_versions,
            "adjudication_policy_hash": lock.adjudication_policy_hash,
            "user_id": user_id,
            "thread_id": "thread",
            "task_id": "task-1",
            "build_id": "build-1",
            "builder_run_id": "builder-run-1",
            "parent_builder_trace_id": "builder-trace-1",
            "logical_artifact_id": "logical-1",
            "artifact_version_id": "artifact-version-1",
            "manifest_revision": 1,
            "artifact_hash": "9" * 64,
            "input_manifest_object_path": (f"artifacts/{user_id}/thread/foundation/.builder/builds/build-1/quality/{quality_run_id}/input_bundle/manifest.json"),
            "input_manifest_hash": "f" * 64,
            "evidence_manifest_object_path": None,
            "evidence_manifest_hash": None,
            "state": state,
            "stage": QualityRunStage.REQUESTED,
            "stage_rank": 0,
            "attempt_count": attempt_count,
            "max_attempts": 5,
            "error_count": 0,
            "next_attempt_at": now,
            "run_deadline_at": now + timedelta(minutes=15),
            "trace_deadline_at": now + timedelta(minutes=17),
            "lease_owner": "worker-1" if state == "running" else None,
            "lease_epoch": lease_epoch,
            "lease_expires_at": now + timedelta(minutes=10) if state == "running" else None,
            "claim_token": "claim-1" if state == "running" else None,
            "claim_hash": "8" * 64 if state == "running" else None,
            "dispatch_intent_epoch": dispatch_intent_epoch,
            "dispatch_intent_attempt_count": dispatch_intent_attempt_count,
            "dispatch_intent_token": dispatch_intent_token,
            "dispatch_intent_status": dispatch_intent_status,
            "dispatch_recovery_proof_hash": dispatch_recovery_proof_hash,
            "dispatch_intent_at": dispatch_intent_at,
            "dispatch_resolved_at": dispatch_resolved_at,
            "completion_owner": None,
            "completion_token": None,
            "last_error_code": last_error_code,
            "last_error_stage": last_error_stage,
            "last_error_at": last_error_at,
            "safe_metrics": {},
            "trace_ids": {},
            "stage_artifact_hashes": {},
            "requested_at": now,
            "started_at": now if state == "running" else None,
            "updated_at": now,
            "finished_at": None,
        }
    )


def _matching_metadata(
    record: QualityRunRecord,
    *,
    lease_owner: str = "worker-1",
    lease_epoch: int = 1,
    intent_token: str = "dq1-dispatch:test",
    preflight_error: str | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "dq1_quality_run_id": record.quality_run_id,
        "dq1_dispatch_fence": canonical_sha256(
            {
                "graph_id": "sophia_deck_quality_shadow",
                "quality_run_id": record.quality_run_id,
                "schema_version": "dq1-dispatch-fence/v1",
            }
        ),
        "dq1_dispatch_intent_token": intent_token,
        "dq1_lease_owner": lease_owner,
        "dq1_lease_epoch": lease_epoch,
    }
    if preflight_error is not None:
        metadata["dq1_dispatch_preflight_error"] = preflight_error
    return metadata


def _recovery_proof_hash(record: QualityRunRecord) -> str | None:
    error_code = (
        record.last_error_code.value
        if record.last_error_code is not None
        else None
    )
    if (
        record.state == "finalizing"
        and record.pending_terminal_state is not None
        and error_code is not None
        and error_code != QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE.value
        and record.last_error_stage is not None
        and record.last_error_at is not None
    ):
        return canonical_sha256(
            {
                "proof_kind": "pending_terminal",
                "pending_terminal_state": record.pending_terminal_state,
                "terminal_trace_payload_hash": (
                    record.terminal_trace_payload_hash
                ),
                "last_error_code": error_code,
                "last_error_stage": record.last_error_stage,
                "last_error_at": record.last_error_at.isoformat(),
                "safe_trace_root_input_hash": (
                    record.safe_trace_root_input_hash
                ),
            }
        )
    if (
        record.state == "finalizing"
        and record.pending_terminal_state is None
        and record.decision_result is not None
        and "decision" in record.stage_artifact_hashes
        and record.safe_trace_root_input_hash is not None
    ):
        return canonical_sha256(
            {
                "proof_kind": "prepared_success",
                "decision_result": record.decision_result.value,
                "decision_stage_hash": record.stage_artifact_hashes[
                    "decision"
                ],
                "safe_trace_root_input_hash": (
                    record.safe_trace_root_input_hash
                ),
            }
        )
    resumable_error = (
        error_code is not None
        and error_code != QualityRunErrorCode.SHADOW_DISPATCH_UNAVAILABLE.value
        and record.last_error_stage is not None
        and record.last_error_at is not None
    )
    stage_artifact_key = {
        QualityRunStage.SNAPSHOT_LOADED: "source_snapshot",
        QualityRunStage.EVIDENCE_PREPARED: "evidence_manifest",
        QualityRunStage.BLIND_ASSESSED: "assessment_a_visual",
        QualityRunStage.MECHANICAL_PROJECTED: "assessment_b_mechanical",
        QualityRunStage.PLAN_REALIZATION_ASSESSED: (
            "assessment_c_plan_realization"
        ),
        QualityRunStage.ADJUDICATED: "decision",
    }.get(record.stage)
    checkpoint_proven = (
        record.stage_rank > 0
        and stage_artifact_key is not None
        and stage_artifact_key in record.stage_artifact_hashes
    )
    if record.stage_rank > 0 and not checkpoint_proven:
        raise RuntimeError("deck quality dispatch checkpoint is invalid")
    if checkpoint_proven or resumable_error:
        return canonical_sha256(
            {
                "proof_kind": "resumable_progress",
                "stage": record.stage.value,
                "stage_rank": record.stage_rank,
                "stage_artifact_key": (
                    stage_artifact_key if checkpoint_proven else None
                ),
                "stage_artifact_hash": (
                    record.stage_artifact_hashes[stage_artifact_key]
                    if checkpoint_proven and stage_artifact_key is not None
                    else None
                ),
                "last_error_code": error_code if resumable_error else None,
                "last_error_stage": (
                    record.last_error_stage if resumable_error else None
                ),
                "last_error_at": (
                    record.last_error_at.isoformat()
                    if resumable_error and record.last_error_at is not None
                    else None
                ),
            }
        )
    return None


@pytest.fixture(autouse=True)
def _make_dispatch_reconciliation_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        dispatcher_module,
        "_RECONCILIATION_INTERVAL_SECONDS",
        0.0,
    )


class FakeStore:
    def __init__(
        self,
        records: tuple[QualityRunRecord, ...],
        *,
        lose_first_claim_response: bool = False,
        begin_error: Exception | None = None,
        resolve_error: Exception | None = None,
    ) -> None:
        self.records = records
        self.lose_first_claim_response = lose_first_claim_response
        self.begin_error = begin_error
        self.resolve_error = resolve_error
        self.claim_calls: list[dict[str, Any]] = []
        self.retries: list[dict[str, Any]] = []
        self.begin_calls: list[dict[str, Any]] = []
        self.resolve_calls: list[dict[str, Any]] = []
        self.finishes: list[dict[str, Any]] = []
        self.probe_count = 0
        self.closed = False
        self.current = {
            record.quality_run_id: record
            for record in records
        }
        self.get_calls: list[str] = []

    async def probe(self) -> None:
        self.probe_count += 1

    async def aclose(self) -> None:
        self.closed = True

    async def claim(self, **kwargs: Any) -> tuple[QualityRunRecord, ...]:
        self.claim_calls.append(dict(kwargs))
        if self.lose_first_claim_response:
            self.lose_first_claim_response = False
            raise httpx.ReadTimeout("ambiguous claim response")
        owner = kwargs["lease_owner"]
        from deerflow.sophia.deck_quality.canonical import canonical_sha256

        claim_hash = canonical_sha256(
            {
                "lease_owner": owner,
                "claim_token": kwargs["claim_token"],
                "lease_seconds": kwargs["lease_seconds"],
                "limit": kwargs["limit"],
            }
        )
        claimed = tuple(
            record.model_copy(
                update={
                    "lease_owner": owner,
                    "claim_token": kwargs["claim_token"],
                    "claim_hash": claim_hash,
                }
            )
            for record in self.records
        )
        self.records = ()
        self.current.update(
            {record.quality_run_id: record for record in claimed}
        )
        return claimed

    async def begin_dispatch(
        self,
        lease: QualityRunLease,
        *,
        intent_token: str,
    ) -> QualityRunRecord:
        self.begin_calls.append(
            {"lease": lease, "intent_token": intent_token}
        )
        if self.begin_error is not None:
            raise self.begin_error
        record = self.current[lease.quality_run_id]
        recovery_proof_hash = _recovery_proof_hash(record)
        recovery_proven = (
            recovery_proof_hash is not None
            and record.dispatch_recovery_proof_hash
            != recovery_proof_hash
        )
        if (
            record.dispatch_intent_status is None
            and (record.attempt_count == 1 or recovery_proven)
        ) or (
            record.dispatch_intent_status is not None and recovery_proven
        ):
            record = record.model_copy(
                update={
                    "dispatch_intent_epoch": lease.epoch,
                    "dispatch_intent_attempt_count": record.attempt_count,
                    "dispatch_intent_token": intent_token,
                    "dispatch_intent_status": "prepared",
                    "dispatch_recovery_proof_hash": recovery_proof_hash,
                    "dispatch_intent_at": datetime.now(UTC),
                    "dispatch_resolved_at": None,
                }
            )
            self.current[lease.quality_run_id] = record
        elif record.dispatch_intent_status is None:
            record = record.model_copy(
                update={
                    "dispatch_intent_epoch": lease.epoch,
                    "dispatch_intent_attempt_count": record.attempt_count,
                    "dispatch_intent_token": intent_token,
                    "dispatch_intent_status": "unresolved",
                    "dispatch_recovery_proof_hash": recovery_proof_hash,
                    "dispatch_intent_at": datetime.now(UTC),
                    "dispatch_resolved_at": None,
                }
            )
            self.current[lease.quality_run_id] = record
        return record

    async def resolve_dispatch(
        self,
        *,
        quality_run_id: str,
        intent_token: str,
        status: str,
    ) -> QualityRunRecord:
        self.resolve_calls.append(
            {
                "quality_run_id": quality_run_id,
                "intent_token": intent_token,
                "status": status,
            }
        )
        if self.resolve_error is not None:
            raise self.resolve_error
        record = self.current[quality_run_id]
        if record.dispatch_intent_token != intent_token:
            raise RuntimeError("dispatch intent conflict")
        current_status = record.dispatch_intent_status
        if current_status == "reconciled" or status == "reconciled":
            resolved_status = "reconciled"
        else:
            resolved_status = status
        resolved_at = (
            record.dispatch_resolved_at or datetime.now(UTC)
            if resolved_status in {"confirmed", "reconciled"}
            else None
        )
        record = record.model_copy(
            update={
                "dispatch_intent_status": resolved_status,
                "dispatch_resolved_at": resolved_at,
            }
        )
        self.current[quality_run_id] = record
        return record

    async def unresolved_dispatches(self, *, limit: int = 100) -> tuple[str, ...]:
        unresolved = tuple(
            record.quality_run_id
            for record in self.current.values()
            if record.state not in {"completed", "failed", "stale"}
            and record.dispatch_intent_status
            in {"prepared", "unresolved", "reconciled"}
        )
        return unresolved[:limit]

    async def retry(self, lease: QualityRunLease, **kwargs: Any) -> QualityRunRecord:
        self.retries.append({"lease": lease, **kwargs})
        current = self.current[lease.quality_run_id]
        preserve_terminal_error = (
            current.state == "finalizing"
            and current.pending_terminal_state is not None
        )
        retried = current.model_copy(
            update={
                "state": (
                    "finalizing"
                    if current.state == "finalizing"
                    else "retry_wait"
                ),
                "lease_owner": None,
                "lease_expires_at": None,
                "claim_token": None,
                "claim_hash": None,
                "last_error_code": (
                    current.last_error_code
                    if preserve_terminal_error
                    else kwargs["error_code"]
                ),
                "last_error_stage": (
                    current.last_error_stage
                    if preserve_terminal_error
                    else kwargs["error_stage"]
                ),
                "last_error_at": (
                    current.last_error_at
                    if preserve_terminal_error
                    else datetime.now(UTC)
                ),
            }
        )
        self.current[lease.quality_run_id] = retried
        return retried

    async def get(self, quality_run_id: str) -> QualityRunRecord | None:
        self.get_calls.append(quality_run_id)
        return self.current.get(quality_run_id)

    async def finish(self, lease: QualityRunLease, **kwargs: Any) -> QualityRunRecord:
        self.finishes.append({"lease": lease, **kwargs})
        finished = self.current[lease.quality_run_id].model_copy(
            update={
                "state": "failed",
                "lease_owner": None,
                "lease_expires_at": None,
                "claim_token": None,
                "claim_hash": None,
                "finished_at": datetime.now(UTC),
                "last_error_code": kwargs["error_code"],
                "last_error_stage": kwargs["error_stage"],
            }
        )
        self.current[lease.quality_run_id] = finished
        return finished


class FakeThreads:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return {"thread_id": kwargs["thread_id"]}


class FakeRuns:
    def __init__(
        self,
        *,
        error: Exception | None = None,
        list_error: Exception | None = None,
        listed: list[Any] | None = None,
        commit_on_error: bool = False,
        list_lag_calls: int = 0,
        list_factory: Callable[[], list[Any]] | None = None,
        committed_list_builder: Callable[[dict[str, Any]], list[Any]] | None = None,
    ) -> None:
        self.error = error
        self.list_error = list_error
        self.listed = listed or []
        self.commit_on_error = commit_on_error
        self.list_lag_calls = list_lag_calls
        self.list_factory = list_factory
        self.committed_list_builder = committed_list_builder
        self.committed_metadata: dict[str, Any] | None = None
        self.create_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.list_calls: list[tuple[str, int, tuple[str, ...]]] = []

    async def create(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self.create_calls.append((args, kwargs))
        if self.error:
            if self.commit_on_error:
                self.committed_metadata = dict(kwargs["metadata"])
            raise self.error
        return {"run_id": "run-1"}

    async def list(
        self,
        thread_id: str,
        *,
        limit: int,
        select: list[str],
    ) -> list[Any]:
        self.list_calls.append((thread_id, limit, tuple(select)))
        if self.list_error is not None:
            raise self.list_error
        if self.list_factory is not None:
            return self.list_factory()
        if (
            self.committed_metadata is not None
            and len(self.list_calls) > self.list_lag_calls
        ):
            if self.committed_list_builder is not None:
                return self.committed_list_builder(self.committed_metadata)
            return [{"metadata": self.committed_metadata}]
        return self.listed


def _dispatcher(
    store: Any,
    runs: FakeRuns,
    *,
    instrument: QualityInstrumentLock | None = None,
    thread_error: Exception | None = None,
    claim_token_factory: Any | None = None,
    poll_seconds: float = 5.0,
) -> DeckQualityDispatcher:
    client = SimpleNamespace(threads=FakeThreads(error=thread_error), runs=runs)
    return DeckQualityDispatcher(
        config=DeckQualityConfig(
            enabled=True,
            mode="shadow",
            canary_user_ids={"canary-user"},
            max_quality_cost_usd=Decimal("0.60"),
        ),
        instrument=instrument or _instrument(),
        store=store,
        langgraph_url="http://langgraph.internal",
        gateway_deployed_sha="1" * 40,
        lease_owner="worker-1",
        poll_seconds=poll_seconds,
        **(
            {"claim_token_factory": claim_token_factory}
            if claim_token_factory is not None
            else {}
        ),
        client=client,
    )


async def _wait_for_readiness(
    dispatcher: DeckQualityDispatcher,
    *,
    status: str,
    reason: str | None = None,
) -> dict[str, object]:
    for _attempt in range(100):
        readiness = dispatcher.readiness()
        if readiness.get("status") == status and (
            reason is None or readiness.get("reason") == reason
        ):
            return readiness
        await asyncio.sleep(0.005)
    raise AssertionError(f"dispatcher readiness did not converge: {dispatcher.readiness()!r}")


@pytest.mark.anyio
async def test_dispatches_one_safe_deterministic_quality_run() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.dispatched == 1
    assert not store.retries and not store.finishes
    assert runs.create_calls[0][0] == (record.quality_run_id, "sophia_deck_quality_shadow")
    kwargs = runs.create_calls[0][1]
    assert kwargs["input"] == {
        "quality_run_id": record.quality_run_id,
        "lease_owner": "worker-1",
        "lease_epoch": 1,
        "gateway_deployed_sha": "1" * 40,
    }
    assert kwargs["context"] == kwargs["input"]
    assert kwargs["metadata"] == _matching_metadata(
        record,
        intent_token=store.begin_calls[0]["intent_token"],
    )
    assert kwargs["multitask_strategy"] == "enqueue"
    assert kwargs["durability"] == "sync"
    assert "user_id" not in str(kwargs)


@pytest.mark.anyio
async def test_probe_and_stop_cover_persistence_lifecycle() -> None:
    store = FakeStore(())
    dispatcher = _dispatcher(store, FakeRuns())

    await dispatcher.probe()
    await dispatcher.stop()

    assert store.probe_count == 1
    assert store.closed is True


@pytest.mark.anyio
async def test_claim_response_loss_replays_exact_token_then_next_cycle_is_fresh() -> None:
    tokens = iter(("quality-claim:first", "quality-claim:second"))
    runs = FakeRuns()
    store = FakeStore(
        (_record(),),
        lose_first_claim_response=True,
    )
    dispatcher = _dispatcher(
        store,
        runs,
        claim_token_factory=lambda: next(tokens),
    )

    first = await dispatcher.run_once()
    second = await dispatcher.run_once()

    assert first.claimed == 1
    assert second.claimed == 0
    assert len(runs.create_calls) == 1
    assert len(store.claim_calls) == 3
    assert store.claim_calls[0] == store.claim_calls[1]
    assert store.claim_calls[0] == {
        "lease_owner": "worker-1",
        "claim_token": "quality-claim:first",
        "lease_seconds": 600,
        "limit": 2,
    }
    assert store.claim_calls[2]["claim_token"] == "quality-claim:second"
    assert store.claim_calls[2]["claim_token"] != store.claim_calls[1]["claim_token"]


@pytest.mark.anyio
async def test_dispatcher_rejects_reused_claim_token_between_cycles() -> None:
    store = FakeStore(())
    dispatcher = _dispatcher(
        store,
        FakeRuns(),
        claim_token_factory=lambda: "quality-claim:reused",
    )

    assert (await dispatcher.run_once()).claimed == 0
    with pytest.raises(RuntimeError, match="claim token factory"):
        await dispatcher.run_once()
    assert len(store.claim_calls) == 1


@pytest.mark.anyio
async def test_hands_forged_noncanary_to_langgraph_for_safe_failure_trace() -> None:
    store = FakeStore((_record(user_id="ordinary-user"),))
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.rejected == 1
    assert len(runs.create_calls) == 1
    _args, kwargs = runs.create_calls[0]
    assert kwargs["input"]["dispatch_preflight_error"] == "scope_mismatch"
    assert kwargs["metadata"]["dq1_dispatch_preflight_error"] == "scope_mismatch"
    assert not store.finishes


@pytest.mark.anyio
async def test_hands_instrument_drift_to_langgraph_for_safe_failure_trace() -> None:
    drift = _instrument().model_copy(update={"rubric_hash": "9" * 64})
    store = FakeStore((_record(instrument=drift),))
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.rejected == 1
    assert len(runs.create_calls) == 1
    _args, kwargs = runs.create_calls[0]
    assert kwargs["input"]["dispatch_preflight_error"] == "instrument_mismatch"
    assert kwargs["metadata"]["dq1_dispatch_preflight_error"] == "instrument_mismatch"
    assert not store.finishes


@pytest.mark.anyio
async def test_non_timeout_create_failure_schedules_causal_retry_without_relaunch() -> None:
    store = FakeStore((_record(),))
    runs = FakeRuns(error=RuntimeError("response body must not escape"))

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == 1
    assert result.retry_scheduled == 1
    assert result.launch_fenced == 1
    assert len(store.retries) == 1
    assert store.retries[0]["error_code"].value == "shadow_dispatch_unavailable"
    assert store.retries[0]["error_stage"] == "shadow_dispatch_launch"
    assert len(runs.create_calls) == 1


@pytest.mark.anyio
async def test_ambiguous_timeout_reconciles_matching_lease_run() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns(
        error=httpx.ReadTimeout("ambiguous"),
        commit_on_error=True,
    )

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert result.launch_fenced == 1
    assert not store.retries


@pytest.mark.anyio
async def test_response_loss_and_list_lag_reconcile_without_second_create() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns(
        error=httpx.ReadTimeout("ambiguous"),
        commit_on_error=True,
        list_lag_calls=2,
    )

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert len(runs.create_calls) == 1
    assert len(runs.list_calls) == 3
    assert runs.committed_metadata == _matching_metadata(
        record,
        intent_token=store.begin_calls[0]["intent_token"],
    )
    assert not store.retries

    dispatcher = _dispatcher(store, runs, poll_seconds=0.01)
    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(
            dispatcher,
            status="degraded",
            reason="dispatch_outcomes_unresolved",
        )
    finally:
        await dispatcher.stop()
    assert readiness["counts"]["launch_fenced"] == 1


@pytest.mark.anyio
async def test_non_timeout_exception_reconciles_matching_current_epoch() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns(
        error=RuntimeError("opaque SDK failure"),
        commit_on_error=True,
    )

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert runs.list_calls == [(record.quality_run_id, 100, ("metadata",))]
    assert not store.retries


@pytest.mark.anyio
async def test_timeout_without_visible_match_schedules_causal_retry() -> None:
    store = FakeStore((_record(),))
    runs = FakeRuns(error=httpx.ReadTimeout("ambiguous"), listed=[])

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == 1
    assert result.retry_scheduled == 1
    assert result.launch_fenced == 1
    assert len(store.retries) == 1
    assert store.retries[0]["error_stage"] == "shadow_dispatch_launch"


@pytest.mark.anyio
async def test_later_epoch_reconciles_late_commit_without_second_create() -> None:
    first_record = _record()
    store = FakeStore((first_record,))
    runs = FakeRuns(
        error=httpx.ReadTimeout("ambiguous"),
        commit_on_error=True,
        list_lag_calls=dispatcher_module._RECONCILIATION_ATTEMPTS,
    )
    dispatcher = _dispatcher(store, runs)

    first = await dispatcher.run_once()
    assert first.ambiguous == first.retry_scheduled == first.launch_fenced == 1
    assert len(runs.create_calls) == 1
    assert len(store.retries) == 1

    retried = store.current[first_record.quality_run_id]
    second_record = retried.model_copy(
        update={
            "state": "running",
            "lease_owner": "worker-1",
            "lease_epoch": 2,
            "lease_expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "claim_token": "claim-2",
            "claim_hash": "7" * 64,
            "attempt_count": 2,
        }
    )
    store.records = (second_record,)
    store.current[second_record.quality_run_id] = second_record

    second = await dispatcher.run_once()

    assert second.reconciled == 1
    assert second.dispatched == second.ambiguous == second.retry_scheduled == 0
    assert second.launch_fenced == 1
    assert len(runs.create_calls) == 1
    assert len(store.retries) == 1
    assert len(runs.list_calls) == dispatcher_module._RECONCILIATION_ATTEMPTS + 1


@pytest.mark.anyio
async def test_pre_call_crash_gap_is_fenced_and_never_launches_later_epoch() -> None:
    record = _record(lease_epoch=2, attempt_count=2)
    store = FakeStore((record,))
    runs = FakeRuns(listed=[])
    dispatcher = _dispatcher(store, runs, poll_seconds=0.01)

    result = await dispatcher.run_once()

    assert result.ambiguous == result.retry_scheduled == result.launch_fenced == 1
    assert not runs.create_calls
    assert store.retries[0]["error_stage"] == "shadow_dispatch_fence"

    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(
            dispatcher,
            status="degraded",
            reason="dispatch_outcomes_unresolved",
        )
    finally:
        await dispatcher.stop()

    assert readiness["counts"] == {
        "unresolved": 1,
        "ambiguous": 1,
        "retry_scheduled": 1,
        "rejected": 0,
        "launch_fenced": 1,
    }


@pytest.mark.anyio
async def test_graph_persistence_retry_launches_one_new_current_epoch_run() -> None:
    record = _record(
        lease_epoch=2,
        attempt_count=2,
        last_error_code=QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR,
        last_error_stage="persist",
        last_error_at=datetime.now(UTC),
        dispatch_intent_status="confirmed",
        dispatch_intent_epoch=1,
        dispatch_intent_attempt_count=1,
        dispatch_intent_token="dq1-dispatch:prior-confirmed",
    )
    store = FakeStore((record,))
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.dispatched == 1
    assert len(runs.create_calls) == 1
    assert store.begin_calls[0]["intent_token"] != "dq1-dispatch:prior-confirmed"
    assert store.current[record.quality_run_id].dispatch_intent_status == "confirmed"


@pytest.mark.anyio
async def test_finalizing_trace_replay_launches_one_current_epoch_run() -> None:
    record = _record(
        lease_epoch=2,
        attempt_count=1,
        dispatch_intent_status="confirmed",
        dispatch_intent_epoch=1,
        dispatch_intent_attempt_count=1,
        dispatch_intent_token="dq1-dispatch:prior-finalizing",
    ).model_copy(
        update={
            "state": "finalizing",
            "pending_terminal_state": "failed",
            "last_error_code": QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
            "last_error_stage": "run_deadline",
            "last_error_at": datetime.now(UTC),
        }
    )
    store = FakeStore((record,))
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.dispatched == 1
    assert len(runs.create_calls) == 1
    assert store.current[record.quality_run_id].dispatch_intent_status == "confirmed"


@pytest.mark.anyio
async def test_checkpoint_progress_permits_one_replay_then_fences_reclaim() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns()
    dispatcher = _dispatcher(store, runs)

    initial = await dispatcher.run_once()

    assert initial.dispatched == 1
    assert len(runs.create_calls) == 1
    consumed = store.current[record.quality_run_id]
    evidence_path = consumed.input_manifest_object_path.replace(
        "/input_bundle/manifest.json",
        "/evidence_manifest.json",
    )
    checkpointed = QualityRunRecord.model_validate(
        {
            **consumed.model_dump(),
            "stage": QualityRunStage.SNAPSHOT_LOADED,
            "stage_rank": 10,
            "stage_artifact_hashes": {"source_snapshot": "a" * 64},
            "evidence_manifest_object_path": evidence_path,
            "evidence_manifest_hash": "b" * 64,
            "lease_epoch": 2,
            "attempt_count": 2,
            "lease_owner": "worker-1",
            "lease_expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "claim_token": "checkpoint-claim-2",
            "claim_hash": "c" * 64,
        }
    )
    store.current[record.quality_run_id] = checkpointed
    store.records = (checkpointed,)
    runs.listed = [{"metadata": runs.create_calls[0][1]["metadata"]}]

    replay = await dispatcher.run_once()

    assert replay.dispatched == 1
    assert len(runs.create_calls) == 2
    replayed = store.current[record.quality_run_id]
    assert replayed.dispatch_recovery_proof_hash == _recovery_proof_hash(
        replayed
    )

    reclaimed = QualityRunRecord.model_validate(
        {
            **replayed.model_dump(),
            "lease_epoch": 3,
            "attempt_count": 3,
            "lease_owner": "worker-1",
            "lease_expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "claim_token": "checkpoint-claim-3",
            "claim_hash": "d" * 64,
        }
    )
    store.current[record.quality_run_id] = reclaimed
    store.records = (reclaimed,)
    runs.listed = [
        {"metadata": create_call[1]["metadata"]}
        for create_call in runs.create_calls
    ]

    fenced = await dispatcher.run_once()

    assert fenced.reconciled == fenced.launch_fenced == 1
    assert fenced.ambiguous == fenced.retry_scheduled == 0
    assert len(runs.create_calls) == 2
    assert (
        store.current[record.quality_run_id].dispatch_intent_status
        == "reconciled"
    )


@pytest.mark.anyio
async def test_finalizing_replay_consumes_proof_until_graph_progress() -> None:
    record = _record(
        lease_epoch=2,
        attempt_count=1,
        dispatch_intent_status="confirmed",
        dispatch_intent_epoch=1,
        dispatch_intent_attempt_count=1,
        dispatch_intent_token="dq1-dispatch:initial",
    ).model_copy(
        update={
            "state": "finalizing",
            "pending_terminal_state": "failed",
            "last_error_code": QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
            "last_error_stage": "run_deadline",
            "last_error_at": datetime.now(UTC),
        }
    )
    store = FakeStore((record,))
    runs = FakeRuns()
    dispatcher = _dispatcher(store, runs, poll_seconds=0.01)

    first = await dispatcher.run_once()

    assert first.dispatched == 1
    assert len(runs.create_calls) == 1
    consumed = store.current[record.quality_run_id]
    assert consumed.dispatch_recovery_proof_hash == _recovery_proof_hash(
        consumed
    )

    reclaimed = consumed.model_copy(
        update={
            "lease_epoch": 3,
            "lease_owner": "worker-1",
            "lease_expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "claim_token": "claim-3",
            "claim_hash": "7" * 64,
        }
    )
    store.current[record.quality_run_id] = reclaimed
    store.records = (reclaimed,)

    second = await dispatcher.run_once()

    assert second.ambiguous == second.retry_scheduled == 1
    assert second.launch_fenced == 1
    assert len(runs.create_calls) == 1
    assert (
        store.current[record.quality_run_id].dispatch_intent_status
        == "unresolved"
    )

    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(
            dispatcher,
            status="degraded",
            reason="dispatch_outcomes_unresolved",
        )
    finally:
        await dispatcher.stop()
    assert readiness["counts"]["launch_fenced"] == 1

    stalled = store.current[record.quality_run_id]
    progressed = stalled.model_copy(
        update={
            "terminal_trace_payload_hash": "4" * 64,
            "safe_trace_root_input_hash": "5" * 64,
            "lease_epoch": 4,
            "lease_owner": "worker-1",
            "lease_expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "claim_token": "claim-4",
            "claim_hash": "6" * 64,
        }
    )
    store.current[record.quality_run_id] = progressed
    store.records = (progressed,)

    third = await _dispatcher(store, runs).run_once()

    assert third.dispatched == 1
    assert len(runs.create_calls) == 2
    assert (
        store.current[record.quality_run_id].dispatch_recovery_proof_hash
        == _recovery_proof_hash(progressed)
    )


@pytest.mark.anyio
async def test_prepared_success_replay_consumes_its_graph_proof() -> None:
    record = _record(
        lease_epoch=2,
        attempt_count=1,
        dispatch_intent_status="confirmed",
        dispatch_intent_epoch=1,
        dispatch_intent_attempt_count=1,
        dispatch_intent_token="dq1-dispatch:initial-success",
    ).model_copy(
        update={
            "state": "finalizing",
            "stage": QualityRunStage.ADJUDICATED,
            "stage_rank": 60,
            "decision_result": QualityRunDecision.SATISFIED,
            "stage_artifact_hashes": {
                "decision": "4" * 64,
                "safe_metrics": "5" * 64,
                "run": "6" * 64,
            },
            "safe_trace_root_input_hash": "7" * 64,
        }
    )
    store = FakeStore((record,))
    runs = FakeRuns()
    dispatcher = _dispatcher(store, runs)

    first = await dispatcher.run_once()

    assert first.dispatched == 1
    consumed = store.current[record.quality_run_id]
    assert consumed.dispatch_recovery_proof_hash == _recovery_proof_hash(
        consumed
    )

    reclaimed = consumed.model_copy(
        update={
            "lease_epoch": 3,
            "lease_owner": "worker-1",
            "lease_expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "claim_token": "claim-success-3",
            "claim_hash": "8" * 64,
        }
    )
    store.current[record.quality_run_id] = reclaimed
    store.records = (reclaimed,)

    second = await dispatcher.run_once()

    assert second.ambiguous == second.retry_scheduled == 1
    assert second.launch_fenced == 1
    assert len(runs.create_calls) == 1


@pytest.mark.anyio
async def test_fenced_replay_keeps_lease_when_unresolved_write_fails() -> None:
    record = _record(
        lease_epoch=3,
        attempt_count=1,
        dispatch_intent_status="confirmed",
        dispatch_intent_epoch=2,
        dispatch_intent_attempt_count=1,
        dispatch_intent_token="dq1-dispatch:consumed-finalizing",
    ).model_copy(
        update={
            "state": "finalizing",
            "pending_terminal_state": "failed",
            "last_error_code": QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
            "last_error_stage": "run_deadline",
            "last_error_at": datetime.now(UTC),
        }
    )
    record = record.model_copy(
        update={"dispatch_recovery_proof_hash": _recovery_proof_hash(record)}
    )
    store = FakeStore(
        (record,),
        resolve_error=RuntimeError("opaque persistence failure"),
    )
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == result.launch_fenced == 1
    assert result.retry_scheduled == 0
    assert not runs.create_calls
    assert not store.retries
    assert store.current[record.quality_run_id].state == "finalizing"
    assert store.current[record.quality_run_id].lease_owner == "worker-1"


@pytest.mark.anyio
async def test_confirm_response_persistence_failure_never_revokes_graph_lease() -> None:
    record = _record()
    store = FakeStore(
        (record,),
        resolve_error=RuntimeError("opaque persistence failure"),
    )
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == result.launch_fenced == 1
    assert result.retry_scheduled == 0
    assert len(runs.create_calls) == 1
    assert not store.retries
    assert store.current[record.quality_run_id].state == "running"


@pytest.mark.anyio
async def test_reconciliation_list_failure_remains_ambiguous_and_content_free(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "provider-response-body-secret"
    store = FakeStore((_record(),))
    runs = FakeRuns(
        error=RuntimeError(secret),
        list_error=RuntimeError(secret),
    )

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == 1
    assert result.retry_scheduled == 1
    assert len(store.retries) == 1
    assert secret not in caplog.text


@pytest.mark.anyio
async def test_begin_dispatch_response_loss_replays_exact_token_before_launch() -> None:
    store = FakeStore((_record(),))
    original_begin = store.begin_dispatch
    response_count = 0

    async def lose_first_response(
        lease: QualityRunLease,
        *,
        intent_token: str,
    ) -> QualityRunRecord:
        nonlocal response_count
        begun = await original_begin(lease, intent_token=intent_token)
        response_count += 1
        if response_count == 1:
            raise httpx.ReadTimeout("synthetic committed begin response loss")
        return begun

    store.begin_dispatch = lose_first_response  # type: ignore[method-assign]
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert result.dispatched == 1
    assert result.ambiguous == result.launch_fenced == 0
    assert len(store.begin_calls) == 2
    assert (
        store.begin_calls[0]["intent_token"]
        == store.begin_calls[1]["intent_token"]
    )
    assert len(runs.create_calls) == 1
    assert not store.get_calls
    assert not store.retries


@pytest.mark.anyio
async def test_begin_dispatch_double_failure_reads_back_before_prelaunch_retry() -> None:
    store = FakeStore((_record(),))
    attempts = 0

    async def fail_before_commit(
        _lease: QualityRunLease,
        *,
        intent_token: str,
    ) -> QualityRunRecord:
        nonlocal attempts
        attempts += 1
        assert intent_token.startswith("dq1-dispatch:")
        raise httpx.ConnectError("synthetic begin request did not commit")

    store.begin_dispatch = fail_before_commit  # type: ignore[method-assign]
    runs = FakeRuns()

    result = await _dispatcher(store, runs).run_once()

    assert attempts == 2
    assert result.ambiguous == result.retry_scheduled == 1
    assert not runs.create_calls
    assert store.get_calls == [next(iter(store.current))]
    assert store.retries[0]["error_stage"] == "shadow_dispatch_prelaunch"


@pytest.mark.anyio
async def test_thread_create_response_loss_replays_idempotently_before_run() -> None:
    store = FakeStore((_record(),))
    runs = FakeRuns()
    dispatcher = _dispatcher(store, runs)
    threads = dispatcher._client.threads
    original_create = threads.create
    response_count = 0

    async def lose_first_response(**kwargs: Any) -> dict[str, Any]:
        nonlocal response_count
        created = await original_create(**kwargs)
        response_count += 1
        if response_count == 1:
            raise httpx.ReadTimeout("synthetic committed thread response loss")
        return created

    threads.create = lose_first_response

    result = await dispatcher.run_once()

    assert result.dispatched == 1
    assert result.ambiguous == result.launch_fenced == 0
    assert len(threads.calls) == 2
    assert threads.calls[0] == threads.calls[1]
    assert threads.calls[0]["if_exists"] == "do_nothing"
    assert len(runs.create_calls) == 1
    assert not store.retries


@pytest.mark.anyio
async def test_thread_create_exception_also_reconciles_without_run_recreate() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns(
        list_factory=lambda: [
            {
                "metadata": _matching_metadata(
                    record,
                    intent_token=(
                        store.current[record.quality_run_id].dispatch_intent_token
                        or "missing"
                    ),
                )
            }
        ]
    )

    result = await _dispatcher(
        store,
        runs,
        thread_error=RuntimeError("opaque thread create failure"),
    ).run_once()

    assert result.reconciled == 1
    assert not runs.create_calls
    assert not store.retries


@pytest.mark.anyio
async def test_thread_create_failure_persists_prelaunch_fence_without_run_create() -> None:
    store = FakeStore((_record(),))
    runs = FakeRuns(listed=[])

    result = await _dispatcher(
        store,
        runs,
        thread_error=RuntimeError("opaque thread create failure"),
    ).run_once()

    assert result.ambiguous == result.retry_scheduled == result.launch_fenced == 1
    assert not runs.create_calls
    assert store.retries[0]["error_stage"] == "shadow_dispatch_prelaunch"


@pytest.mark.anyio
async def test_reconciliation_scans_beyond_twenty_and_requires_exact_epoch() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns(
        error=RuntimeError("ambiguous"),
        commit_on_error=True,
        committed_list_builder=lambda metadata: [
            {
                "metadata": {
                    **metadata,
                    "dq1_lease_epoch": 2,
                }
            }
            for _index in range(99)
        ]
        + [{"metadata": metadata}],
    )

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert runs.list_calls == [(record.quality_run_id, 100, ("metadata",))]


def test_quality_record_fixture_is_nonterminal_and_hash_consistent() -> None:
    record = _record()
    assert record.decision_result is None
    assert record.decision_weighted_score is None
    assert QualityRunDecision.NEEDS_REVISION.value == "needs_revision"


@pytest.mark.anyio
@pytest.mark.parametrize("records", [(), (_record(),)], ids=["zero-work", "dispatched"])
async def test_healthy_zero_work_and_dispatched_cycles_are_ready(
    records: tuple[QualityRunRecord, ...],
) -> None:
    dispatcher = _dispatcher(
        FakeStore(records),
        FakeRuns(),
        poll_seconds=0.01,
    )
    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(dispatcher, status="ready")
    finally:
        await dispatcher.stop()

    assert "counts" not in readiness


@pytest.mark.anyio
async def test_ambiguous_retry_readiness_stays_degraded_across_empty_poll() -> None:
    record = _record()
    store = FakeStore((record,))
    runs = FakeRuns(error=httpx.ReadTimeout("ambiguous"), listed=[])
    dispatcher = _dispatcher(store, runs, poll_seconds=0.01)

    first = await dispatcher.run_once()
    assert first.ambiguous == first.retry_scheduled == 1
    store.records = ()
    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(
            dispatcher,
            status="degraded",
            reason="dispatch_outcomes_unresolved",
        )
        await asyncio.sleep(0.03)
        assert dispatcher.readiness() == readiness
    finally:
        await dispatcher.stop()

    assert readiness["counts"] == {
        "unresolved": 1,
        "ambiguous": 1,
        "retry_scheduled": 1,
        "rejected": 0,
        "launch_fenced": 1,
    }
    assert record.quality_run_id not in repr(readiness)


@pytest.mark.anyio
async def test_terminal_row_resolution_clears_latched_ambiguity() -> None:
    record = _record()
    store = FakeStore((record,))
    dispatcher = _dispatcher(
        store,
        FakeRuns(error=httpx.ReadTimeout("ambiguous"), listed=[]),
        poll_seconds=0.01,
    )

    await dispatcher.run_once()
    store.records = ()
    store.current[record.quality_run_id] = record.model_copy(
        update={"state": "failed"}
    )
    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(dispatcher, status="ready")
    finally:
        await dispatcher.stop()

    assert readiness["status"] == "ready"
    assert store.get_calls == [record.quality_run_id]


@pytest.mark.anyio
async def test_rejected_dispatch_latches_content_free_degraded_readiness() -> None:
    record = _record(user_id="ordinary-user")
    store = FakeStore((record,))
    dispatcher = _dispatcher(store, FakeRuns(), poll_seconds=0.01)

    first = await dispatcher.run_once()
    assert first.rejected == 1
    store.records = ()
    dispatcher.start()
    try:
        readiness = await _wait_for_readiness(
            dispatcher,
            status="degraded",
            reason="dispatch_outcomes_unresolved",
        )
    finally:
        await dispatcher.stop()

    assert readiness["counts"] == {
        "unresolved": 1,
        "ambiguous": 0,
        "retry_scheduled": 0,
        "rejected": 1,
        "launch_fenced": 0,
    }
    assert record.quality_run_id not in repr(readiness)
    assert record.user_id not in repr(readiness)


@pytest.mark.anyio
async def test_stop_cancels_sync_blocking_claim_without_event_loop_hang() -> None:
    claim_started = threading.Event()
    release_claim = threading.Event()

    class _BlockingSyncStore:
        closed = False

        def claim(self, **_kwargs: Any) -> tuple[QualityRunRecord, ...]:
            claim_started.set()
            release_claim.wait(timeout=5.0)
            return ()

        def aclose(self) -> None:
            self.closed = True

    store = _BlockingSyncStore()
    dispatcher = _dispatcher(store, FakeRuns(), poll_seconds=60.0)
    dispatcher.start()
    try:
        for _attempt in range(100):
            if claim_started.is_set():
                break
            await asyncio.sleep(0.005)
        assert claim_started.is_set()
        started = time.monotonic()
        await asyncio.wait_for(dispatcher.stop(), timeout=0.5)
        assert time.monotonic() - started < 0.25
        assert store.closed is True
        assert dispatcher.running is False
    finally:
        release_claim.set()
        await asyncio.sleep(0.02)


@pytest.mark.anyio
async def test_stop_bounds_sync_blocking_resource_close(monkeypatch) -> None:
    close_started = threading.Event()
    release_close = threading.Event()

    class _BlockingCloseStore(FakeStore):
        def aclose(self) -> None:
            close_started.set()
            release_close.wait(timeout=5.0)
            self.closed = True

    monkeypatch.setattr(
        dispatcher_module,
        "_WORKER_STOP_TIMEOUT_SECONDS",
        0.05,
    )
    store = _BlockingCloseStore(())
    dispatcher = _dispatcher(store, FakeRuns())
    stop_task = asyncio.create_task(dispatcher.stop())
    try:
        for _attempt in range(100):
            if close_started.is_set():
                break
            await asyncio.sleep(0.002)
        assert close_started.is_set()
        await asyncio.wait_for(stop_task, timeout=0.2)
        assert store.closed is False
    finally:
        release_close.set()
        await asyncio.sleep(0.02)
