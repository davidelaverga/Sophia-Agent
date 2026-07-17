from __future__ import annotations

import copy
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path

import anyio
import pytest
from pydantic import ValidationError

from deerflow.sophia.deck_quality.persistence import (
    DeckQualityPersistenceProtocolError,
    DeckQualityPersistenceRpcError,
)
from deerflow.sophia.deck_quality.publication_persistence import (
    PublicationErrorCode,
    PublicationLease,
    PublicationRequest,
    PublicationState,
    SupabaseDeckQualityPublicationStore,
    expected_publication_source_pack_path,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "2026_07_16_sophia_deck_quality_publications.sql"
ATOMIC_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql"
)
SHADOW_MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "2026_07_15_sophia_deck_quality_shadow_runs.sql"


def _instrument() -> QualityInstrumentLock:
    return QualityInstrumentLock.model_validate(
        {
            "rubric_version": "deck-rubric-v2",
            "rubric_hash": "a" * 64,
            "prompt_hashes": {
                "blind_visual": "b" * 64,
                "plan_realization": "c" * 64,
            },
            "judge_plan_hash": "d" * 64,
            "judge_profile_version": "v2",
            "evidence_preprocessor_version": "deck-evidence-v4",
            "judge_invoker_version": "deck-judge-invoker-v4",
            "assessment_schema_versions": {
                "blind_visual": "v4",
                "plan_realization": "v4",
            },
            "adjudication_policy_hash": "e" * 64,
        }
    )


def _request(
    *,
    now: datetime | None = None,
    **overrides: object,
) -> PublicationRequest:
    now = now or datetime.now(UTC).replace(microsecond=0)
    values: dict[str, object] = {
        "campaign_id": "DQ-1",
        "instrument": _instrument(),
        "user_id": "canary-user",
        "thread_id": "canary-thread",
        "task_id": "task-1",
        "build_id": "build-1",
        "builder_run_id": "builder-run-1",
        "parent_builder_trace_id": "019f675a-dcc1-7053-80dc-c6f572fb4d87",
        "logical_artifact_id": "artifact-1",
        "artifact_version_id": "artifact-version-1",
        "manifest_revision": 3,
        "artifact_object_path": "artifacts/canary-user/canary-thread/artifact-1/deck.pptx",
        "artifact_hash": "1" * 64,
        "deadline_at": now + timedelta(minutes=3),
        "quality_run_deadline_at": now + timedelta(minutes=15),
    }
    values.update(overrides)
    return PublicationRequest.model_validate(values)


class _FakeRpc:
    """Transactional model for persistence and response-loss replay tests."""

    def __init__(self) -> None:
        self.now = datetime.now(UTC).replace(microsecond=0)
        self.row: dict[str, object] | None = None
        self.request_payload: dict[str, object] | None = None
        self.quality_requests: list[dict[str, object]] = []
        self.claim_receipts: dict[tuple[str, str], dict[str, object]] = {}
        self.synthetic_due_rows = 0
        self.synthetic_terminalized = 0

    def advance(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)

    def _copy(self) -> list[dict[str, object]]:
        return [] if self.row is None else [copy.deepcopy(self.row)]

    def _require_row(self, payload: dict[str, object]) -> dict[str, object]:
        if self.row is None or self.row["quality_run_id"] != payload["p_quality_run_id"]:
            raise DeckQualityPersistenceRpcError("not_found", status_code=404)
        return self.row

    @staticmethod
    def _replay(
        row: dict[str, object],
        payload: dict[str, object],
        *,
        kind: str,
    ) -> bool:
        if row["last_operation_token"] != payload["p_operation_token"]:
            return False
        if row["last_operation_kind"] != kind or row["last_operation_hash"] != payload["p_operation_hash"]:
            raise DeckQualityPersistenceRpcError("operation_conflict", status_code=409)
        return True

    def _require_lease(self, payload: dict[str, object]) -> dict[str, object]:
        row = self._require_row(payload)
        if not (
            row["state"] == "running" and row["lease_owner"] == payload["p_lease_owner"] and row["lease_epoch"] == payload["p_lease_epoch"] and row["lease_expires_at"] > self.now  # type: ignore[operator]
        ):
            raise DeckQualityPersistenceRpcError("lease_stale", status_code=409)
        return row

    async def call(self, operation: str, payload: Mapping[str, object]) -> object:
        return getattr(self, operation)(dict(payload))

    def sophia_request_deck_quality_publication(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        if self.request_payload is not None:
            immutable_keys = set(payload) - {
                "p_deadline_at",
                "p_quality_run_deadline_at",
            }
            if immutable_keys != set(self.request_payload) - {
                "p_deadline_at",
                "p_quality_run_deadline_at",
            } or any(
                self.request_payload[key] != payload[key]
                for key in immutable_keys
            ):
                raise DeckQualityPersistenceRpcError("request_conflict", status_code=409)
            return self._copy()
        self.request_payload = copy.deepcopy(payload)
        self.row = {
            "quality_run_id": payload["p_quality_run_id"],
            "campaign_id": payload["p_campaign_id"],
            "scope_kind": "canary",
            "instrument_schema_version": payload["p_instrument_schema_version"],
            "instrument_identity_hash": payload["p_instrument_identity_hash"],
            "rubric_version": payload["p_rubric_version"],
            "rubric_hash": payload["p_rubric_hash"],
            "prompt_hashes": payload["p_prompt_hashes"],
            "judge_plan_hash": payload["p_judge_plan_hash"],
            "judge_profile_version": payload["p_judge_profile_version"],
            "evidence_preprocessor_version": payload["p_evidence_preprocessor_version"],
            "judge_invoker_version": payload["p_judge_invoker_version"],
            "assessment_schema_versions": payload["p_assessment_schema_versions"],
            "adjudication_policy_hash": payload["p_adjudication_policy_hash"],
            "user_id": payload["p_user_id"],
            "thread_id": payload["p_thread_id"],
            "task_id": payload["p_task_id"],
            "build_id": payload["p_build_id"],
            "builder_run_id": payload["p_builder_run_id"],
            "parent_builder_trace_id": payload["p_parent_builder_trace_id"],
            "logical_artifact_id": payload["p_logical_artifact_id"],
            "artifact_version_id": payload["p_artifact_version_id"],
            "manifest_revision": payload["p_manifest_revision"],
            "artifact_object_path": payload["p_artifact_object_path"],
            "artifact_hash": payload["p_artifact_hash"],
            "source_pack_object_path": None,
            "source_pack_hash": None,
            "input_manifest_object_path": None,
            "input_manifest_hash": None,
            "state": "awaiting_inputs",
            "attempt_count": 0,
            "max_attempts": payload["p_max_attempts"],
            "error_count": 0,
            "next_attempt_at": self.now,
            "deadline_at": datetime.fromisoformat(str(payload["p_deadline_at"])),
            "quality_max_attempts": payload["p_quality_max_attempts"],
            "quality_run_deadline_at": datetime.fromisoformat(str(payload["p_quality_run_deadline_at"])),
            "lease_owner": None,
            "lease_epoch": 0,
            "lease_expires_at": None,
            "claim_token": None,
            "claim_hash": None,
            "last_operation_kind": None,
            "last_operation_token": None,
            "last_operation_hash": None,
            "last_error_code": None,
            "last_error_stage": None,
            "last_error_at": None,
            "requested_at": self.now,
            "started_at": None,
            "updated_at": self.now,
            "finished_at": None,
        }
        return self._copy()

    def sophia_request_ready_deck_quality_publication(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        source_path = payload.pop("p_source_pack_object_path")
        source_hash = payload.pop("p_source_pack_hash")
        requested = self.sophia_request_deck_quality_publication(payload)
        assert len(requested) == 1
        return self.sophia_commit_deck_quality_publication_inputs(
            {
                "p_quality_run_id": payload["p_quality_run_id"],
                "p_source_pack_object_path": source_path,
                "p_source_pack_hash": source_hash,
            }
        )

    def sophia_commit_deck_quality_publication_inputs(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_row(payload)
        if row["state"] != "awaiting_inputs":
            if row["source_pack_object_path"] == payload["p_source_pack_object_path"] and row["source_pack_hash"] == payload["p_source_pack_hash"]:
                return self._copy()
            raise DeckQualityPersistenceRpcError("inputs_conflict", status_code=409)
        row.update(
            state="pending",
            source_pack_object_path=payload["p_source_pack_object_path"],
            source_pack_hash=payload["p_source_pack_hash"],
            next_attempt_at=self.now,
            updated_at=self.now,
        )
        return self._copy()

    def sophia_claim_deck_quality_publications(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        receipt_key = (str(payload["p_lease_owner"]), str(payload["p_claim_token"]))
        receipt = self.claim_receipts.get(receipt_key)
        if receipt is not None:
            if any(
                receipt[key] != payload[payload_key]
                for key, payload_key in (
                    ("claim_hash", "p_claim_hash"),
                    ("lease_seconds", "p_lease_seconds"),
                    ("claim_limit", "p_limit"),
                )
            ):
                raise DeckQualityPersistenceRpcError("claim_conflict", status_code=409)
            if self.row is None or self.row["quality_run_id"] not in receipt["quality_run_ids"]:
                return []
            row = self.row
            live_replay = (
                row["state"] == "running" and row["lease_owner"] == payload["p_lease_owner"] and row["claim_token"] == payload["p_claim_token"] and row["claim_hash"] == payload["p_claim_hash"] and row["lease_expires_at"] > self.now  # type: ignore[operator]
            )
            return self._copy() if live_replay else []

        reaper_budget = 100
        synthetic_reaped = min(reaper_budget, self.synthetic_due_rows)
        self.synthetic_due_rows -= synthetic_reaped
        self.synthetic_terminalized += synthetic_reaped
        reaper_budget -= synthetic_reaped

        row = self.row
        if row is not None and reaper_budget and row["state"] in {"awaiting_inputs", "pending", "running", "retry_wait"}:
            deadline_expired = row["deadline_at"] <= self.now  # type: ignore[operator]
            attempt_exhausted = int(row["attempt_count"]) >= int(row["max_attempts"])
            reclaimable = row["state"] != "running" or row["lease_expires_at"] <= self.now  # type: ignore[operator]
            if deadline_expired or (attempt_exhausted and reclaimable):
                row.update(
                    state="failed",
                    error_count=int(row["error_count"]) + 1,
                    lease_owner=None,
                    lease_expires_at=None,
                    claim_token=None,
                    claim_hash=None,
                    last_error_code=(PublicationErrorCode.DEADLINE_EXCEEDED.value if deadline_expired else PublicationErrorCode.ATTEMPT_LIMIT_EXHAUSTED.value),
                    last_error_stage="claim",
                    last_error_at=self.now,
                    finished_at=self.now,
                    updated_at=self.now,
                )

        claimed_ids: list[str] = []
        if row is None:
            self.claim_receipts[receipt_key] = {
                "claim_hash": payload["p_claim_hash"],
                "lease_seconds": payload["p_lease_seconds"],
                "claim_limit": payload["p_limit"],
                "quality_run_ids": claimed_ids,
            }
            return []
        reclaimable = row["state"] in {"pending", "retry_wait"} or (
            row["state"] == "running" and row["lease_expires_at"] <= self.now  # type: ignore[operator]
        )
        if (
            not reclaimable
            or row["next_attempt_at"] > self.now  # type: ignore[operator]
            or int(row["attempt_count"]) >= int(row["max_attempts"])
            or row["deadline_at"] <= self.now  # type: ignore[operator]
        ):
            result: list[dict[str, object]] = []
        else:
            row.update(
                state="running",
                attempt_count=int(row["attempt_count"]) + 1,
                lease_owner=payload["p_lease_owner"],
                lease_epoch=int(row["lease_epoch"]) + 1,
                lease_expires_at=min(
                    self.now + timedelta(seconds=int(payload["p_lease_seconds"])),
                    row["deadline_at"],  # type: ignore[type-var]
                ),
                claim_token=payload["p_claim_token"],
                claim_hash=payload["p_claim_hash"],
                last_operation_kind=None,
                last_operation_token=None,
                last_operation_hash=None,
                started_at=row["started_at"] or self.now,
                updated_at=self.now,
            )
            claimed_ids.append(str(row["quality_run_id"]))
            result = self._copy()
        self.claim_receipts[receipt_key] = {
            "claim_hash": payload["p_claim_hash"],
            "lease_seconds": payload["p_lease_seconds"],
            "claim_limit": payload["p_limit"],
            "quality_run_ids": claimed_ids,
        }
        return result

    def sophia_renew_deck_quality_publication_lease(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_row(payload)
        if self._replay(row, payload, kind="renew"):
            return self._copy()
        row = self._require_lease(payload)
        row.update(
            lease_expires_at=min(
                self.now + timedelta(seconds=int(payload["p_lease_seconds"])),
                row["deadline_at"],  # type: ignore[type-var]
            ),
            last_operation_kind="renew",
            last_operation_token=payload["p_operation_token"],
            last_operation_hash=payload["p_operation_hash"],
            updated_at=self.now,
        )
        return self._copy()

    def sophia_retry_deck_quality_publication(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_row(payload)
        if self._replay(row, payload, kind="retry"):
            return self._copy()
        row = self._require_lease(payload)
        exhausted = int(row["attempt_count"]) >= int(row["max_attempts"])
        row.update(
            state="failed" if exhausted else "retry_wait",
            error_count=int(row["error_count"]) + 1,
            next_attempt_at=min(
                self.now + timedelta(seconds=int(payload["p_delay_seconds"])),
                row["deadline_at"],  # type: ignore[type-var]
            ),
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            last_operation_kind="retry",
            last_operation_token=payload["p_operation_token"],
            last_operation_hash=payload["p_operation_hash"],
            last_error_code=(PublicationErrorCode.ATTEMPT_LIMIT_EXHAUSTED.value if exhausted else payload["p_error_code"]),
            last_error_stage=payload["p_error_stage"],
            last_error_at=self.now,
            finished_at=self.now if exhausted else None,
            updated_at=self.now,
        )
        return self._copy()

    def sophia_promote_deck_quality_publication(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_row(payload)
        if self._replay(row, payload, kind="promote"):
            return self._copy()
        row = self._require_lease(payload)
        self.quality_requests.append(
            {
                "quality_run_id": row["quality_run_id"],
                "artifact_hash": row["artifact_hash"],
                "input_manifest_object_path": payload["p_input_manifest_object_path"],
                "input_manifest_hash": payload["p_input_manifest_hash"],
                "max_attempts": row["quality_max_attempts"],
                "run_deadline_at": row["quality_run_deadline_at"],
            }
        )
        row.update(
            state="published",
            input_manifest_object_path=payload["p_input_manifest_object_path"],
            input_manifest_hash=payload["p_input_manifest_hash"],
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            last_operation_kind="promote",
            last_operation_token=payload["p_operation_token"],
            last_operation_hash=payload["p_operation_hash"],
            finished_at=self.now,
            updated_at=self.now,
        )
        return self._copy()

    def sophia_fail_deck_quality_publication(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_row(payload)
        if self._replay(row, payload, kind="fail"):
            return self._copy()
        row = self._require_lease(payload)
        row.update(
            state="failed",
            error_count=int(row["error_count"]) + 1,
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            last_operation_kind="fail",
            last_operation_token=payload["p_operation_token"],
            last_operation_hash=payload["p_operation_hash"],
            last_error_code=payload["p_error_code"],
            last_error_stage=payload["p_error_stage"],
            last_error_at=self.now,
            finished_at=self.now,
            updated_at=self.now,
        )
        return self._copy()

    def sophia_get_deck_quality_publication(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        if self.row is None or self.row["quality_run_id"] != payload["p_quality_run_id"]:
            return []
        return self._copy()


def test_request_locks_exact_identity_paths_and_separate_deadlines() -> None:
    request = _request()

    assert request.max_attempts == 3
    assert request.quality_max_attempts == 5
    assert request.quality_run_deadline_at > request.deadline_at
    assert request.input_manifest_object_path.endswith(f"/quality/{request.quality_run_id}/input_bundle/manifest.json")
    assert request.source_pack_object_path == expected_publication_source_pack_path(
        user_id=request.user_id,
        thread_id=request.thread_id,
        build_id=request.build_id,
        quality_run_id=request.quality_run_id,
    )
    with pytest.raises(ValidationError, match="identity is not canonical"):
        _request(build_id="build_")
    for field, collision in (
        ("user_id", "canary/user"),
        ("thread_id", "canary/thread"),
        ("build_id", "build_"),
    ):
        with pytest.raises(ValidationError, match="identity is not canonical"):
            _request(**{field: collision})
    payload = request.rpc_payload()
    assert payload["p_artifact_object_path"] == request.artifact_object_path
    assert payload["p_artifact_hash"] == request.artifact_hash
    assert "p_preview" not in payload

    with pytest.raises(ValidationError, match="exact user/thread scope"):
        _request(artifact_object_path="artifacts/ordinary-user/thread/deck.pptx")
    with pytest.raises(ValidationError, match="exact user/thread scope"):
        _request(artifact_object_path=("artifacts/canary-user/canary-thread//artifact-1/deck.pptx"))
    with pytest.raises(ValidationError, match="exactly twelve minutes"):
        _request(
            now=request.deadline_at - timedelta(minutes=3),
            quality_run_deadline_at=request.deadline_at
            + timedelta(minutes=11, seconds=59),
        )
    far_deadline = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=1)
    with pytest.raises(ValidationError, match="three-minute request horizon"):
        _request(
            deadline_at=far_deadline,
            quality_run_deadline_at=far_deadline + timedelta(minutes=12),
        )
    with pytest.raises(ValidationError):
        _request(max_attempts=4)


def test_request_ready_is_atomic_and_replays_without_resetting_deadline_or_state() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityPublicationStore(rpc)
        request = _request(now=rpc.now)
        source_hash = "2" * 64

        ready = await store.request_ready(
            request,
            source_pack_object_path=request.source_pack_object_path,
            source_pack_hash=source_hash,
        )
        assert ready.state is PublicationState.PENDING
        assert ready.source_pack_object_path == request.source_pack_object_path
        assert ready.source_pack_hash == source_hash
        original_deadline = ready.deadline_at

        assert rpc.row is not None
        rpc.row["state"] = "retry_wait"
        replay_request = request.model_copy(
            update={
                "deadline_at": request.deadline_at + timedelta(seconds=1),
                "quality_run_deadline_at": (
                    request.quality_run_deadline_at + timedelta(seconds=1)
                ),
            }
        )
        replay = await store.request_ready(
            replay_request,
            source_pack_object_path=request.source_pack_object_path,
            source_pack_hash=source_hash,
        )
        assert replay.state is PublicationState.RETRY_WAIT
        assert replay.deadline_at == original_deadline

        with pytest.raises(ValueError, match="source-pack path"):
            await store.request_ready(
                request,
                source_pack_object_path=request.input_manifest_object_path,
                source_pack_hash=source_hash,
            )

    anyio.run(scenario)


def test_exact_replay_from_request_through_atomic_promotion() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityPublicationStore(rpc)
        request = _request(now=rpc.now)

        awaiting = await store.request(request)
        assert awaiting.state is PublicationState.AWAITING_INPUTS
        assert await store.request(request) == awaiting

        source_hash = "2" * 64
        source_path = request.source_pack_object_path
        with pytest.raises(ValueError, match="source-pack path"):
            await store.commit_inputs(
                awaiting,
                source_pack_object_path=request.input_manifest_object_path,
                source_pack_hash=source_hash,
            )
        pending = await store.commit_inputs(
            awaiting,
            source_pack_object_path=source_path,
            source_pack_hash=source_hash,
        )
        assert pending.state is PublicationState.PENDING
        assert (
            await store.commit_inputs(
                pending,
                source_pack_object_path=source_path,
                source_pack_hash=source_hash,
            )
            == pending
        )

        claimed = (
            await store.claim(
                lease_owner="publisher-1",
                claim_token="claim-1",
                lease_seconds=60,
            )
        )[0]
        replayed_claim = (
            await store.claim(
                lease_owner="publisher-1",
                claim_token="claim-1",
                lease_seconds=60,
            )
        )[0]
        assert replayed_claim == claimed
        assert replayed_claim.attempt_count == 1
        assert replayed_claim.lease_epoch == 1
        with pytest.raises(DeckQualityPersistenceRpcError, match="claim_conflict"):
            await store.claim(
                lease_owner="publisher-1",
                claim_token="claim-1",
                lease_seconds=90,
            )

        lease = PublicationLease.from_record(claimed)
        renewed = await store.renew(
            lease,
            operation_token="renew-1",
            lease_seconds=90,
        )
        replayed_renewal = await store.renew(
            lease,
            operation_token="renew-1",
            lease_seconds=90,
        )
        assert replayed_renewal == renewed

        published = await store.promote(
            lease,
            operation_token="promote-1",
            input_manifest_object_path=request.input_manifest_object_path,
            input_manifest_hash=source_hash,
        )
        lost_response_replay = await store.promote(
            lease,
            operation_token="promote-1",
            input_manifest_object_path=request.input_manifest_object_path,
            input_manifest_hash=source_hash,
        )
        assert published.state is PublicationState.PUBLISHED
        assert lost_response_replay == published
        assert published.source_pack_object_path != published.input_manifest_object_path
        assert published.source_pack_hash == published.input_manifest_hash
        assert len(rpc.quality_requests) == 1
        assert rpc.quality_requests[0]["artifact_hash"] == request.artifact_hash
        assert rpc.quality_requests[0]["artifact_hash"] != source_hash
        assert rpc.quality_requests[0]["max_attempts"] == 5
        assert rpc.quality_requests[0]["run_deadline_at"] == request.quality_run_deadline_at
        assert await store.get(request.quality_run_id) == published

    anyio.run(scenario)


def test_claim_receipt_is_concurrent_empty_and_delayed_replay_safe() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityPublicationStore(rpc)

        assert await store.claim(lease_owner="publisher-1", claim_token="empty-claim") == ()
        request = _request(now=rpc.now)
        awaiting = await store.request(request)
        pending = await store.commit_inputs(
            awaiting,
            source_pack_object_path=request.source_pack_object_path,
            source_pack_hash="2" * 64,
        )
        assert await store.claim(lease_owner="publisher-1", claim_token="empty-claim") == ()
        assert pending.attempt_count == 0
        assert rpc.row is not None and rpc.row["attempt_count"] == 0

        results: list[tuple[object, ...]] = []

        async def same_token_claim() -> None:
            results.append(
                await store.claim(
                    lease_owner="publisher-1",
                    claim_token="concurrent-claim",
                    lease_seconds=60,
                )
            )

        async with anyio.create_task_group() as task_group:
            task_group.start_soon(same_token_claim)
            task_group.start_soon(same_token_claim)

        assert len(results) == 2
        assert results[0] == results[1]
        assert results[0][0].attempt_count == 1  # type: ignore[union-attr]
        assert rpc.row["attempt_count"] == 1

        rpc.advance(61)
        assert (
            await store.claim(
                lease_owner="publisher-1",
                claim_token="concurrent-claim",
                lease_seconds=60,
            )
            == ()
        )
        assert rpc.row["attempt_count"] == 1
        reclaimed = (
            await store.claim(
                lease_owner="publisher-1",
                claim_token="next-allocation",
                lease_seconds=60,
            )
        )[0]
        assert reclaimed.attempt_count == 2

    anyio.run(scenario)


def test_fresh_claim_reaper_is_capped_at_one_hundred_total_rows() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        rpc.synthetic_due_rows = 101
        store = SupabaseDeckQualityPublicationStore(rpc)

        assert await store.claim(lease_owner="publisher-1", claim_token="reap-1") == ()
        assert rpc.synthetic_terminalized == 100
        assert rpc.synthetic_due_rows == 1

        # Receipt replay does not run maintenance or allocate a different batch.
        assert await store.claim(lease_owner="publisher-1", claim_token="reap-1") == ()
        assert rpc.synthetic_terminalized == 100
        assert rpc.synthetic_due_rows == 1

        assert await store.claim(lease_owner="publisher-1", claim_token="reap-2") == ()
        assert rpc.synthetic_terminalized == 101
        assert rpc.synthetic_due_rows == 0

    anyio.run(scenario)


def test_claim_rejects_duplicate_out_of_order_and_oversized_rpc_results() -> None:
    async def claimed_row(artifact_version_id: str) -> dict[str, object]:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityPublicationStore(rpc)
        request = _request(now=rpc.now, artifact_version_id=artifact_version_id)
        awaiting = await store.request(request)
        await store.commit_inputs(
            awaiting,
            source_pack_object_path=request.source_pack_object_path,
            source_pack_hash="2" * 64,
        )
        record = (
            await store.claim(
                lease_owner="publisher-1",
                claim_token="claim-two",
                lease_seconds=60,
                limit=2,
            )
        )[0]
        return record.model_dump(mode="python")

    async def scenario() -> None:
        first = await claimed_row("artifact-version-1")
        second = await claimed_row("artifact-version-2")
        assert isinstance(first["next_attempt_at"], datetime)
        second["next_attempt_at"] = first["next_attempt_at"] + timedelta(seconds=1)

        class _ForgedClaimRpc:
            def __init__(self, rows: list[dict[str, object]]) -> None:
                self.rows = rows

            async def call(self, operation: str, payload: Mapping[str, object]) -> object:
                return copy.deepcopy(self.rows)

        kwargs = {
            "lease_owner": "publisher-1",
            "claim_token": "claim-two",
            "lease_seconds": 60,
            "limit": 2,
        }
        with pytest.raises(DeckQualityPersistenceProtocolError, match="duplicate leases"):
            await SupabaseDeckQualityPublicationStore(_ForgedClaimRpc([first, first])).claim(**kwargs)
        with pytest.raises(DeckQualityPersistenceProtocolError, match="out of order"):
            await SupabaseDeckQualityPublicationStore(_ForgedClaimRpc([second, first])).claim(**kwargs)
        with pytest.raises(DeckQualityPersistenceProtocolError, match="response shape"):
            await SupabaseDeckQualityPublicationStore(_ForgedClaimRpc([first, first, first])).claim(**kwargs)
        expired = copy.deepcopy(first)
        expired["lease_expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
        with pytest.raises(DeckQualityPersistenceProtocolError, match="invalid lease"):
            await SupabaseDeckQualityPublicationStore(_ForgedClaimRpc([expired])).claim(**kwargs)
        with pytest.raises(ValueError, match="between 1 and 2"):
            await SupabaseDeckQualityPublicationStore(_ForgedClaimRpc([])).claim(
                lease_owner="publisher-1",
                claim_token="too-wide",
                limit=3,
            )

    anyio.run(scenario)


def test_retry_is_fenced_and_third_attempt_fails_closed() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityPublicationStore(rpc)
        request = _request(now=rpc.now)
        record = await store.request(request)
        record = await store.commit_inputs(
            record,
            source_pack_object_path=request.source_pack_object_path,
            source_pack_hash="2" * 64,
        )

        for attempt in range(1, 4):
            claimed = (
                await store.claim(
                    lease_owner="publisher-1",
                    claim_token=f"claim-{attempt}",
                    lease_seconds=60,
                )
            )[0]
            assert claimed.attempt_count == attempt
            lease = PublicationLease.from_record(claimed)
            record = await store.retry(
                lease,
                operation_token=f"retry-{attempt}",
                error_code=PublicationErrorCode.PERSISTENCE_ERROR,
                error_stage="upload",
                delay_seconds=0,
            )

        assert record.state is PublicationState.FAILED
        assert record.last_error_code is PublicationErrorCode.ATTEMPT_LIMIT_EXHAUSTED
        assert record.finished_at is not None
        assert (
            await store.retry(
                lease,
                operation_token="retry-3",
                error_code=PublicationErrorCode.PERSISTENCE_ERROR,
                error_stage="upload",
                delay_seconds=0,
            )
            == record
        )
        assert (
            await store.claim(
                lease_owner="publisher-2",
                claim_token="claim-after-terminal",
            )
            == ()
        )

    anyio.run(scenario)


def test_explicit_failure_replay_rejects_token_reuse_with_changed_arguments() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityPublicationStore(rpc)
        request = _request(now=rpc.now)
        record = await store.request(request)
        record = await store.commit_inputs(
            record,
            source_pack_object_path=request.source_pack_object_path,
            source_pack_hash="2" * 64,
        )
        claimed = (
            await store.claim(
                lease_owner="publisher-1",
                claim_token="claim-fail",
            )
        )[0]
        lease = PublicationLease.from_record(claimed)
        failed = await store.fail(
            lease,
            operation_token="fail-1",
            error_code=PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
            error_stage="verify_artifact",
        )
        assert failed.state is PublicationState.FAILED
        assert (
            await store.fail(
                lease,
                operation_token="fail-1",
                error_code=PublicationErrorCode.ARTIFACT_VERIFICATION_FAILED,
                error_stage="verify_artifact",
            )
            == failed
        )
        with pytest.raises(DeckQualityPersistenceRpcError, match="operation_conflict"):
            await store.fail(
                lease,
                operation_token="fail-1",
                error_code=PublicationErrorCode.ARTIFACT_SNAPSHOT_STALE,
                error_stage="verify_artifact",
            )

    anyio.run(scenario)


def test_response_validation_rejects_preview_or_content_fields() -> None:
    rpc = _FakeRpc()
    request = _request(now=rpc.now)
    rpc.sophia_request_deck_quality_publication(request.rpc_payload())
    assert rpc.row is not None
    forged = copy.deepcopy(rpc.row)
    forged["preview_object_path"] = "forbidden"

    class _ForgedRpc:
        async def call(self, operation: str, payload: Mapping[str, object]) -> object:
            return [forged]

    async def scenario() -> None:
        with pytest.raises(DeckQualityPersistenceProtocolError, match="failed validation"):
            await SupabaseDeckQualityPublicationStore(_ForgedRpc()).get(request.quality_run_id)

    anyio.run(scenario)


def test_migration_locks_rpc_only_atomic_publication_contract() -> None:
    sql = MIGRATION.read_text()
    atomic_sql = ATOMIC_MIGRATION.read_text()
    shadow_sql = SHADOW_MIGRATION.read_text()
    lower = sql.lower()

    assert "preview" not in lower
    assert "source_pack_object_path" in sql
    assert "artifact_object_path" in sql
    assert "artifact_hash" in sql
    assert "check (max_attempts = 3)" in lower
    assert "check (quality_max_attempts = 5)" in lower
    assert all(f"'{state.value}'" in sql for state in PublicationState)
    assert "p_claim_token" in sql
    assert "p_operation_token" in sql
    assert "p_operation_hash" in sql
    claim = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_claim_deck_quality_publications",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_renew_deck_quality_publication_lease",
        maxsplit=1,
    )[0]
    assert "p_limit NOT BETWEEN 1 AND 2" in claim
    assert "pg_advisory_xact_lock" in claim
    assert "sophia_deck_quality_publication_claim_receipts" in claim
    assert "WITH ORDINALITY" in claim
    assert "ARRAY[]::TEXT[]" in claim
    assert claim.count("LIMIT 100") == 2
    assert "created_at < statement_timestamp() - interval '1 hour'" in claim
    assert "FOR UPDATE SKIP LOCKED" in claim
    assert "FOR UPDATE SKIP LOCKED\n         LIMIT 100" in claim
    assert "terminal_candidates" in claim
    assert "quality_run_ids" in claim
    source_validator = atomic_sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_deck_quality_publication_source_path_valid",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_request_deck_quality_publication",
        maxsplit=1,
    )[0]
    assert "p_object_path = replace(" in source_validator
    assert "publication/source_pack/manifest.json" in source_validator
    assert "p_object_hash || '.json'" not in source_validator
    assert "p_object_path IN" not in source_validator
    request = atomic_sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_request_deck_quality_publication",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_request_ready_deck_quality_publication",
        maxsplit=1,
    )[0]
    assert "v_publication.deadline_at IS DISTINCT" not in request
    assert "v_publication.quality_run_deadline_at IS DISTINCT" not in request
    request_ready = atomic_sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_request_ready_deck_quality_publication",
        maxsplit=1,
    )[1].split(
        "REVOKE ALL ON FUNCTION",
        maxsplit=1,
    )[0]
    assert "sophia_request_deck_quality_publication(" in request_ready
    assert "sophia_commit_deck_quality_publication_inputs(" in request_ready
    assert "COMMIT" not in request_ready
    promote = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_promote_deck_quality_publication",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_get_deck_quality_publication",
        maxsplit=1,
    )[0]
    assert "FOR UPDATE" in promote
    assert "public.sophia_request_deck_quality_shadow_run(" in promote
    quality_request = promote.split(
        "public.sophia_request_deck_quality_shadow_run(",
        maxsplit=1,
    )[1].split(");", maxsplit=1)[0]
    assert "v_publication.artifact_hash" in quality_request
    assert quality_request.index("v_publication.artifact_hash") < quality_request.index(
        "p_input_manifest_hash"
    )
    assert "SET state = 'published'" in promote
    assert promote.index("public.sophia_request_deck_quality_shadow_run(") < promote.index("SET state = 'published'")
    assert "REVOKE ALL ON TABLE public.sophia_deck_quality_publications" in sql
    assert "REVOKE ALL ON TABLE public.sophia_deck_quality_publication_claim_receipts" in sql
    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_request_deck_quality_publication("
        not in atomic_sql
    )
    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_commit_deck_quality_publication_inputs("
        not in atomic_sql
    )
    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_request_ready_deck_quality_publication("
        in atomic_sql
    )
    assert "PRIMARY KEY (lease_owner, claim_token)" in sql
    assert "claim_limit BETWEEN 1 AND 2" in sql
    assert "isfinite(deadline_at)" in sql
    assert "deadline_at <= requested_at + interval '3 minutes'" in sql
    assert "quality_run_deadline_at = deadline_at + interval '12 minutes'" in sql
    assert "sophia_deck_quality_shadow_deadline_horizon_new_write" in sql
    assert "sophia_deck_quality_shadow_safe_identity_new_write" in sql
    assert "sophia_deck_quality_shadow_artifact_hash_new_write" in sql
    assert "sophia_deck_quality_shadow_claim_receipts" in sql
    assert "sophia_prepare_deck_quality_shadow_failure_trace" in sql
    assert "trace_deadline_at = run_deadline_at + interval '2 minutes'" in sql
    assert "GRANT EXECUTE ON FUNCTION public.sophia_request_deck_quality_shadow_run" in shadow_sql
    assert "REVOKE ALL ON FUNCTION public.sophia_request_deck_quality_shadow_run" in sql
    assert "GRANT EXECUTE ON FUNCTION public.sophia_request_deck_quality_shadow_run" not in sql
    for operation in (
        "request",
        "request_ready",
        "commit",
        "claim",
        "renew",
        "retry",
        "fail",
        "promote",
        "get",
    ):
        assert (
            f"sophia_{operation}_deck_quality_publication" in sql
            or f"sophia_{operation}_deck_quality_publication" in atomic_sql
            or (
                operation == "claim"
                and "sophia_claim_deck_quality_publications" in sql
            )
        )
