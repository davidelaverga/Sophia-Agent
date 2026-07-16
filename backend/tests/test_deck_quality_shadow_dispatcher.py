from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from app.gateway.workers.deck_quality_dispatcher import DeckQualityDispatcher
from deerflow.config.deck_quality_config import DeckQualityConfig
from deerflow.sophia.deck_quality.persistence import (
    QualityRunDecision,
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
    instrument: QualityInstrumentLock | None = None,
) -> QualityRunRecord:
    lock = instrument or _instrument()
    from deerflow.sophia.deck_quality.canonical import canonical_sha256
    from deerflow.sophia.deck_quality.idempotency import derive_quality_run_id

    quality_run_id = derive_quality_run_id(
        artifact_version_id="artifact-version-1",
        campaign_id="DQ-1",
        instrument=lock,
    )
    now = datetime.now(UTC)
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
            "attempt_count": 1,
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
            "completion_owner": None,
            "completion_token": None,
            "safe_metrics": {},
            "trace_ids": {},
            "stage_artifact_hashes": {},
            "requested_at": now,
            "started_at": now if state == "running" else None,
            "updated_at": now,
            "finished_at": None,
        }
    )


class FakeStore:
    def __init__(
        self,
        records: tuple[QualityRunRecord, ...],
        *,
        lose_first_claim_response: bool = False,
    ) -> None:
        self.records = records
        self.lose_first_claim_response = lose_first_claim_response
        self.claim_calls: list[dict[str, Any]] = []
        self.retries: list[dict[str, Any]] = []
        self.finishes: list[dict[str, Any]] = []
        self.probe_count = 0
        self.closed = False

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
        return tuple(
            record.model_copy(
                update={
                    "lease_owner": owner,
                    "claim_token": kwargs["claim_token"],
                    "claim_hash": claim_hash,
                }
            )
            for record in self.records
        )

    async def retry(self, lease: QualityRunLease, **kwargs: Any) -> QualityRunRecord:
        self.retries.append({"lease": lease, **kwargs})
        return self.records[0].model_copy(
            update={
                "state": "retry_wait",
                "lease_owner": None,
                "lease_expires_at": None,
                "claim_token": None,
                "claim_hash": None,
            }
        )

    async def finish(self, lease: QualityRunLease, **kwargs: Any) -> QualityRunRecord:
        self.finishes.append({"lease": lease, **kwargs})
        return self.records[0].model_copy(
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
    ) -> None:
        self.error = error
        self.list_error = list_error
        self.listed = listed or []
        self.create_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.list_calls: list[tuple[str, int, tuple[str, ...]]] = []

    async def create(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self.create_calls.append((args, kwargs))
        if self.error:
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
        return self.listed


def _dispatcher(
    store: FakeStore,
    runs: FakeRuns,
    *,
    instrument: QualityInstrumentLock | None = None,
    thread_error: Exception | None = None,
    claim_token_factory: Any | None = None,
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
        **(
            {"claim_token_factory": claim_token_factory}
            if claim_token_factory is not None
            else {}
        ),
        client=client,
    )


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
    store = FakeStore(
        (_record(),),
        lose_first_claim_response=True,
    )
    dispatcher = _dispatcher(
        store,
        FakeRuns(),
        claim_token_factory=lambda: next(tokens),
    )

    first = await dispatcher.run_once()
    second = await dispatcher.run_once()

    assert first.claimed == second.claimed == 1
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
async def test_non_timeout_create_failure_stays_ambiguous_without_relaunch() -> None:
    store = FakeStore((_record(),))
    runs = FakeRuns(error=RuntimeError("response body must not escape"))

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == 1
    assert not store.retries
    assert len(runs.create_calls) == 1


@pytest.mark.anyio
async def test_ambiguous_timeout_reconciles_matching_lease_run() -> None:
    record = _record()
    listed = [
        {
            "metadata": {
                "dq1_quality_run_id": record.quality_run_id,
                "dq1_lease_owner": "worker-1",
                "dq1_lease_epoch": 1,
            }
        }
    ]
    store = FakeStore((record,))
    runs = FakeRuns(error=httpx.ReadTimeout("ambiguous"), listed=listed)

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert not store.retries


@pytest.mark.anyio
async def test_non_timeout_exception_reconciles_matching_current_epoch() -> None:
    record = _record()
    listed = [
        {
            "metadata": {
                "dq1_quality_run_id": record.quality_run_id,
                "dq1_lease_owner": "worker-1",
                "dq1_lease_epoch": 1,
            }
        }
    ]
    store = FakeStore((record,))
    runs = FakeRuns(error=RuntimeError("opaque SDK failure"), listed=listed)

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert runs.list_calls == [(record.quality_run_id, 100, ("metadata",))]
    assert not store.retries


@pytest.mark.anyio
async def test_timeout_without_visible_match_remains_ambiguous() -> None:
    store = FakeStore((_record(),))
    runs = FakeRuns(error=httpx.ReadTimeout("ambiguous"), listed=[])

    result = await _dispatcher(store, runs).run_once()

    assert result.ambiguous == 1
    assert not store.retries


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
    assert not store.retries
    assert secret not in caplog.text


@pytest.mark.anyio
async def test_thread_create_exception_also_reconciles_without_run_recreate() -> None:
    record = _record()
    listed = [
        {
            "metadata": {
                "dq1_quality_run_id": record.quality_run_id,
                "dq1_lease_owner": "worker-1",
                "dq1_lease_epoch": 1,
            }
        }
    ]
    store = FakeStore((record,))
    runs = FakeRuns(listed=listed)

    result = await _dispatcher(
        store,
        runs,
        thread_error=RuntimeError("opaque thread create failure"),
    ).run_once()

    assert result.reconciled == 1
    assert not runs.create_calls
    assert not store.retries


@pytest.mark.anyio
async def test_reconciliation_scans_beyond_twenty_and_requires_exact_epoch() -> None:
    record = _record()
    wrong_epoch = {
        "metadata": {
            "dq1_quality_run_id": record.quality_run_id,
            "dq1_lease_owner": "worker-1",
            "dq1_lease_epoch": 2,
        }
    }
    exact = {
        "metadata": {
            "dq1_quality_run_id": record.quality_run_id,
            "dq1_lease_owner": "worker-1",
            "dq1_lease_epoch": 1,
        }
    }
    listed = [wrong_epoch for _index in range(99)] + [exact]
    store = FakeStore((record,))
    runs = FakeRuns(error=RuntimeError("ambiguous"), listed=listed)

    result = await _dispatcher(store, runs).run_once()

    assert result.reconciled == 1
    assert runs.list_calls == [(record.quality_run_id, 100, ("metadata",))]


def test_quality_record_fixture_is_nonterminal_and_hash_consistent() -> None:
    record = _record()
    assert record.decision_result is None
    assert record.decision_weighted_score is None
    assert QualityRunDecision.NEEDS_REVISION.value == "needs_revision"
