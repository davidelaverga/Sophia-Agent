from __future__ import annotations

import copy
import itertools
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import anyio
import httpx
import pytest
from pydantic import ValidationError

from deerflow.sophia.deck_quality.idempotency import canonical_sha256, derive_quality_run_id
from deerflow.sophia.deck_quality.persistence import (
    STAGE_RANK,
    DeckQualityPersistenceConfig,
    DeckQualityPersistenceConfigurationError,
    DeckQualityPersistenceProtocolError,
    DeckQualityPersistenceRpcError,
    QualityRunDecision,
    QualityRunErrorCode,
    QualityRunLease,
    QualityRunRecord,
    QualityRunRequest,
    QualityRunStage,
    QualityRunTerminalState,
    SupabaseDeckQualityRunRpcClient,
    SupabaseDeckQualityRunStore,
    persisted_decision_weighted_score,
    safe_trace_root_input_hash,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock
from deerflow.sophia.storage.supabase_artifact_store import safe_object_path_segment

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "2026_07_15_sophia_deck_quality_shadow_runs.sql"
TEST_NOW = datetime.now(UTC).replace(microsecond=0)
_CLAIM_SEQUENCE = itertools.count(1)


def test_weighted_score_projection_matches_float_transport_and_database_scale() -> None:
    exact = Decimal("2.00000049999999999")

    assert float(exact) == 2.0000005
    assert persisted_decision_weighted_score(exact) == Decimal("2.000001")
    assert persisted_decision_weighted_score(Decimal(7) / Decimal(3)) == Decimal("2.333333")


def _instrument() -> QualityInstrumentLock:
    return QualityInstrumentLock.model_validate(
        {
            "rubric_version": "deck-rubric-v2",
            "rubric_hash": "a" * 64,
            "prompt_hashes": {
                "blind_visual": "b" * 64,
                "plan_realization": "c" * 64,
                "large_deck": "d" * 64,
            },
            "judge_plan_hash": "e" * 64,
            "judge_profile_version": "v2",
            "evidence_preprocessor_version": "deck-evidence-v4",
            "judge_invoker_version": "deck-judge-invoker-v4",
            "assessment_schema_versions": {"blind_visual": "v4", "plan_realization": "v4"},
            "adjudication_policy_hash": "f" * 64,
        }
    )


def _request(**overrides: object) -> QualityRunRequest:
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
        "artifact_hash": "0" * 64,
        "input_manifest_hash": "1" * 64,
        "max_attempts": 5,
        "run_deadline_at": TEST_NOW + timedelta(minutes=14),
    }
    values.update(overrides)
    quality_run_id = derive_quality_run_id(
        artifact_version_id=str(values["artifact_version_id"]),
        campaign_id=str(values["campaign_id"]),
        instrument=values["instrument"],  # type: ignore[arg-type]
    )
    values.setdefault(
        "input_manifest_object_path",
        (
            f"artifacts/{safe_object_path_segment(values['user_id'], default='user')}/"
            f"{safe_object_path_segment(values['thread_id'], default='thread')}/foundation/"
            f".builder/builds/{values['build_id']}/quality/{quality_run_id}/input_bundle/manifest.json"
        ),
    )
    return QualityRunRequest.model_validate(values)


async def _claim(
    store: SupabaseDeckQualityRunStore,
    *,
    lease_owner: str,
    lease_seconds: int = 120,
    limit: int = 1,
    claim_token: str | None = None,
) -> tuple[QualityRunRecord, ...]:
    return await store.claim(
        lease_owner=lease_owner,
        claim_token=claim_token or f"test-quality-claim:{next(_CLAIM_SEQUENCE)}",
        lease_seconds=lease_seconds,
        limit=limit,
    )


async def _ack_failure(
    store: SupabaseDeckQualityRunStore,
    record: QualityRunRecord,
    *,
    error_code: QualityRunErrorCode,
    error_stage: str,
    terminal_state: QualityRunTerminalState = QualityRunTerminalState.FAILED,
    payload_hash: str = "d" * 64,
) -> QualityRunRecord:
    lease = QualityRunLease.from_record(record)
    prepared = await store.prepare_failure_trace(
        lease,
        terminal_state=terminal_state,
        error_code=error_code,
        error_stage=error_stage,
        terminal_trace_payload_hash=payload_hash,
        safe_trace_root_input=_trace_root(record),
    )
    assert prepared.state == "finalizing"
    assert prepared.finished_at is None
    trace_ids = (
        prepared.trace_ids
        if set(_trace_ids()).issubset(prepared.trace_ids)
        else _trace_ids(f"terminal-{record.lease_epoch}")
    )
    return await store.finish(
        lease,
        terminal_state=terminal_state,
        terminal_trace_payload_hash=payload_hash,
        error_code=error_code,
        error_stage=error_stage,
        safe_metrics=prepared.safe_metrics,
        trace_ids=trace_ids,
        stage_artifact_hashes=prepared.stage_artifact_hashes,
    )


def _evidence_path(record: object) -> str:
    input_path = str(getattr(record, "input_manifest_object_path"))
    return input_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"


def _trace_ids(suffix: str = "1") -> dict[str, str]:
    root_id = f"root-{suffix}"
    return {
        "quality_trace_id": root_id,
        "quality_root_run_id": root_id,
        "dispatch_run_id": f"dispatch-{suffix}",
        "snapshot_run_id": f"snapshot-{suffix}",
        "evidence_run_id": f"evidence-{suffix}",
        "blind_visual_run_id": f"blind-{suffix}",
        "mechanical_projection_run_id": f"mechanical-{suffix}",
        "plan_realization_run_id": f"plan-{suffix}",
        "adjudicate_run_id": f"adjudicate-{suffix}",
        "shadow_persist_run_id": f"persist-{suffix}",
    }


def _trace_root(record: QualityRunRecord) -> dict[str, object]:
    return {
        "schema_version": "deck-quality-safe-trace-root/v2",
        "campaign_id": record.campaign_id,
        "quality_run_id": record.quality_run_id,
        "build_id": record.build_id,
        "task_id": record.task_id or "missing-task",
        "builder_run_id": record.builder_run_id or "missing-builder-run",
        "parent_builder_run_id": record.builder_run_id or "missing-builder-run",
        "parent_builder_trace_id": record.parent_builder_trace_id or "missing-builder-trace",
        "logical_artifact_id": record.logical_artifact_id,
        "artifact_version_id": record.artifact_version_id,
        "manifest_revision": record.manifest_revision,
        "artifact_hash": record.artifact_hash,
        "rubric_version": record.rubric_version,
        "rubric_hash": record.rubric_hash,
        "judge_deployment": "dq1-judge",
        "judge_provider": "anthropic",
        "judge_model": "claude-sonnet",
        "judge_profile_version": record.judge_profile_version,
        "judge_plan_hash": record.judge_plan_hash,
        "evidence_preprocessor_version": record.evidence_preprocessor_version,
        "source_commit_sha": "1" * 40,
        "gateway_deployed_sha": "2" * 40,
        "langgraph_deployed_sha": "3" * 40,
    }


class _FakeRpc:
    """Small transactional RPC model shared across simulated process restarts."""

    def __init__(self) -> None:
        self.now = datetime.now(UTC).replace(microsecond=0)
        self.rows: dict[str, dict[str, object]] = {}
        self.request_fingerprints: dict[str, dict[str, object]] = {}
        self.claim_receipts: dict[tuple[str, str], dict[str, object]] = {}

    def advance(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)

    async def call(self, operation: str, payload: Mapping[str, object]) -> object:
        handler = getattr(self, operation)
        return handler(dict(payload))

    def _copy(self, row: dict[str, object]) -> dict[str, object]:
        return copy.deepcopy(row)

    def _require_lease(
        self,
        payload: dict[str, object],
        *,
        running_only: bool = False,
    ) -> dict[str, object]:
        row = self.rows[str(payload["p_quality_run_id"])]
        allowed_states = {"running"} if running_only else {"running", "finalizing"}
        horizon = (
            row["trace_deadline_at"]
            if row["state"] == "finalizing"
            else row["run_deadline_at"]
        )
        if not (
            row["state"] in allowed_states
            and row["lease_owner"] == payload["p_lease_owner"]
            and row["lease_epoch"] == payload["p_lease_epoch"]
            and row["lease_expires_at"] > self.now  # type: ignore[operator]
            and horizon > self.now  # type: ignore[operator]
        ):
            raise DeckQualityPersistenceRpcError("lease", status_code=409)
        return row

    def _prepare_trace_pending_rows(self, *, limit: int = 100) -> None:
        due: list[dict[str, object]] = []
        for row in self.rows.values():
            if row["state"] not in {"pending", "retry_wait", "running", "finalizing"}:
                continue
            if row["decision_result"] is not None or row["pending_terminal_state"] is not None:
                continue
            deadline_expired = row["run_deadline_at"] <= self.now  # type: ignore[operator]
            attempt_exhausted = int(row["attempt_count"]) >= int(row["max_attempts"])
            reclaimable = (
                row["state"] in {"pending", "retry_wait"}
                or row["lease_owner"] is None
                or (
                    row["lease_expires_at"] is not None and row["lease_expires_at"] <= self.now  # type: ignore[operator]
                )
            )
            if deadline_expired or (attempt_exhausted and reclaimable):
                due.append(row)
        due.sort(key=lambda row: (row["run_deadline_at"], row["requested_at"], row["quality_run_id"]))
        for row in due[:limit]:
            deadline_expired = row["run_deadline_at"] <= self.now  # type: ignore[operator]
            row.update(
                state="finalizing",
                next_attempt_at=min(self.now, row["trace_deadline_at"]),  # type: ignore[arg-type]
                lease_owner=None,
                lease_expires_at=None,
                claim_token=None,
                claim_hash=None,
                pending_terminal_state=QualityRunTerminalState.FAILED.value,
                terminal_trace_payload_hash=None,
                error_count=int(row["error_count"]) + 1,
                last_error_code=(QualityRunErrorCode.RUN_DEADLINE_EXCEEDED.value if deadline_expired else QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED.value),
                last_error_stage="run_deadline" if deadline_expired else "attempt_limit",
                last_error_at=self.now,
                finished_at=None,
                updated_at=self.now,
            )

    def sophia_request_deck_quality_shadow_run(self, payload: dict[str, object]) -> list[dict[str, object]]:
        unique = (
            payload["p_artifact_version_id"],
            payload["p_campaign_id"],
            payload["p_instrument_identity_hash"],
        )
        for run_id, fingerprint in self.request_fingerprints.items():
            existing_unique = (
                fingerprint["p_artifact_version_id"],
                fingerprint["p_campaign_id"],
                fingerprint["p_instrument_identity_hash"],
            )
            if existing_unique != unique:
                continue
            if fingerprint != payload:
                raise DeckQualityPersistenceRpcError(
                    "sophia_request_deck_quality_shadow_run",
                    status_code=409,
                )
            return [self._copy(self.rows[run_id])]

        deadline = datetime.fromisoformat(str(payload["p_run_deadline_at"]))
        if deadline <= self.now:
            raise DeckQualityPersistenceRpcError(
                "sophia_request_deck_quality_shadow_run",
                status_code=400,
            )
        run_id = str(payload["p_quality_run_id"])
        row: dict[str, object] = {
            "quality_run_id": run_id,
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
            "artifact_hash": payload["p_artifact_hash"],
            "input_manifest_object_path": payload["p_input_manifest_object_path"],
            "input_manifest_hash": payload["p_input_manifest_hash"],
            "evidence_manifest_object_path": None,
            "evidence_manifest_hash": None,
            "state": "pending",
            "stage": "requested",
            "stage_rank": 0,
            "attempt_count": 0,
            "max_attempts": payload["p_max_attempts"],
            "error_count": 0,
            "next_attempt_at": self.now,
            "run_deadline_at": deadline,
            "trace_deadline_at": deadline + timedelta(minutes=2),
            "lease_owner": None,
            "lease_epoch": 0,
            "lease_expires_at": None,
            "claim_token": None,
            "claim_hash": None,
            "dispatch_intent_epoch": None,
            "dispatch_intent_attempt_count": None,
            "dispatch_intent_token": None,
            "dispatch_intent_status": None,
            "dispatch_recovery_proof_hash": None,
            "dispatch_intent_at": None,
            "dispatch_resolved_at": None,
            "pending_terminal_state": None,
            "terminal_trace_payload_hash": None,
            "safe_trace_root_input": None,
            "safe_trace_root_input_hash": None,
            "completion_owner": None,
            "completion_token": None,
            "last_error_code": None,
            "last_error_stage": None,
            "last_error_at": None,
            "decision_result": None,
            "decision_failure_codes": [],
            "decision_weighted_score": None,
            "safe_metrics": {},
            "trace_ids": {},
            "stage_artifact_hashes": {},
            "requested_at": self.now,
            "started_at": None,
            "updated_at": self.now,
            "finished_at": None,
        }
        self.rows[run_id] = row
        self.request_fingerprints[run_id] = copy.deepcopy(payload)
        return [self._copy(row)]

    def sophia_claim_deck_quality_shadow_runs(self, payload: dict[str, object]) -> list[dict[str, object]]:
        limit = int(payload["p_limit"])
        owner = str(payload["p_lease_owner"])
        token = str(payload["p_claim_token"])
        claim_hash = str(payload["p_claim_hash"])
        lease_seconds = int(payload["p_lease_seconds"])
        if not 1 <= limit <= 2:
            raise DeckQualityPersistenceRpcError(
                "sophia_claim_deck_quality_shadow_runs",
                status_code=400,
            )
        receipt_key = (owner, token)
        receipt = self.claim_receipts.get(receipt_key)
        if receipt is not None:
            if (
                receipt["claim_hash"] != claim_hash
                or receipt["lease_seconds"] != lease_seconds
                or receipt["limit"] != limit
            ):
                raise DeckQualityPersistenceRpcError(
                    "sophia_claim_deck_quality_shadow_runs",
                    status_code=409,
                )
            replayed: list[dict[str, object]] = []
            for run_id in receipt["quality_run_ids"]:  # type: ignore[union-attr]
                row = self.rows[str(run_id)]
                if (
                    row["state"] in {"running", "finalizing"}
                    and row["lease_owner"] == owner
                    and row["claim_token"] == token
                    and row["claim_hash"] == claim_hash
                    and row["lease_expires_at"] > self.now  # type: ignore[operator]
                ):
                    replayed.append(self._copy(row))
            return replayed

        expired_receipts = sorted(
            (
                (key, value)
                for key, value in self.claim_receipts.items()
                if value["created_at"] < self.now - timedelta(hours=1)  # type: ignore[operator]
                and key != receipt_key
            ),
            key=lambda item: (item[1]["created_at"], *item[0]),
        )
        for key, _receipt in expired_receipts[:100]:
            del self.claim_receipts[key]

        self._prepare_trace_pending_rows()
        eligible = [
            row
            for row in self.rows.values()
            if (
                (
                    row["state"] == "finalizing"
                    and row["next_attempt_at"] <= self.now  # type: ignore[operator]
                    and (
                        row["lease_owner"] is None
                        or row["lease_expires_at"] <= self.now  # type: ignore[operator]
                    )
                    and row["trace_deadline_at"] > self.now  # type: ignore[operator]
                    and (
                        row["decision_result"] is not None
                        or row["pending_terminal_state"] is not None
                    )
                )
                or (
                    row["state"] in {"pending", "retry_wait"}
                    and row["next_attempt_at"] <= self.now  # type: ignore[operator]
                    and int(row["attempt_count"]) < int(row["max_attempts"])
                    and row["run_deadline_at"] > self.now  # type: ignore[operator]
                )
                or (
                    row["state"] == "running"
                    and row["lease_expires_at"] <= self.now  # type: ignore[operator]
                    and int(row["attempt_count"]) < int(row["max_attempts"])
                    and row["run_deadline_at"] > self.now  # type: ignore[operator]
                )
            )
        ]
        eligible.sort(key=lambda row: (row["next_attempt_at"], row["requested_at"], row["quality_run_id"]))
        claimed: list[dict[str, object]] = []
        for row in eligible[:limit]:
            finalizing = row["state"] == "finalizing"
            row["state"] = "finalizing" if row["state"] == "finalizing" else "running"
            row["lease_owner"] = owner
            row["lease_epoch"] = int(row["lease_epoch"]) + 1
            row["lease_expires_at"] = min(
                self.now + timedelta(seconds=lease_seconds),
                (
                        row["trace_deadline_at"]
                    if finalizing
                    else row["run_deadline_at"]
                ),
            )
            if not finalizing:
                row["attempt_count"] = int(row["attempt_count"]) + 1
            row["claim_token"] = token
            row["claim_hash"] = claim_hash
            row["started_at"] = row["started_at"] or self.now
            row["updated_at"] = self.now
            claimed.append(self._copy(row))
        self.claim_receipts[receipt_key] = {
            "claim_hash": claim_hash,
            "lease_seconds": lease_seconds,
            "limit": limit,
            "quality_run_ids": [row["quality_run_id"] for row in claimed],
            "created_at": self.now,
        }
        return claimed

    def sophia_renew_deck_quality_shadow_lease(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        row["lease_expires_at"] = min(
            self.now + timedelta(seconds=int(payload["p_lease_seconds"])),
            (
                row["trace_deadline_at"]
                if row["state"] == "finalizing"
                else row["run_deadline_at"]
            ),
        )
        row["updated_at"] = self.now
        return [self._copy(row)]

    def sophia_begin_deck_quality_shadow_dispatch(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        row.update(
            dispatch_intent_epoch=row["lease_epoch"],
            dispatch_intent_attempt_count=row["attempt_count"],
            dispatch_intent_token=payload["p_dispatch_intent_token"],
            dispatch_intent_status="prepared",
            dispatch_recovery_proof_hash=None,
            dispatch_intent_at=self.now,
            dispatch_resolved_at=None,
        )
        return [self._copy(row)]

    def sophia_resolve_deck_quality_shadow_dispatch(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self.rows[str(payload["p_quality_run_id"])]
        if row["dispatch_intent_token"] != payload["p_dispatch_intent_token"]:
            raise DeckQualityPersistenceRpcError(
                "sophia_resolve_deck_quality_shadow_dispatch",
                status_code=409,
            )
        status = str(payload["p_dispatch_intent_status"])
        row["dispatch_intent_status"] = status
        row["dispatch_resolved_at"] = (
            self.now if status in {"confirmed", "reconciled"} else None
        )
        return [self._copy(row)]

    def sophia_recover_expired_deck_quality_shadow_runs(
        self,
        payload: dict[str, object],
    ) -> int:
        limit = int(payload["p_limit"])
        if not 1 <= limit <= 100:
            raise DeckQualityPersistenceRpcError(
                "sophia_recover_expired_deck_quality_shadow_runs",
                status_code=400,
            )
        eligible = sorted(
            (
                row
                for row in self.rows.values()
                if row["state"] == "finalizing"
                and row["trace_deadline_at"] <= self.now  # type: ignore[operator]
                and (
                    row["lease_expires_at"] is None
                    or row["lease_expires_at"] <= self.now  # type: ignore[operator]
                )
                and (
                    row["pending_terminal_state"] in {"failed", "stale"}
                    or (
                        row["pending_terminal_state"] is None
                        and row["decision_result"] is not None
                        and row["stage"] == "adjudicated"
                        and {"decision", "safe_metrics", "run"}.issubset(
                            row["stage_artifact_hashes"]  # type: ignore[arg-type]
                        )
                    )
                )
            ),
            key=lambda row: (
                row["trace_deadline_at"],
                row["requested_at"],
                row["quality_run_id"],
            ),
        )
        for row in eligible[:limit]:
            precursor = row["pending_terminal_state"] is not None
            terminal_state = row["pending_terminal_state"] or "failed"
            row.update(
                state=terminal_state,
                pending_terminal_state=terminal_state,
                next_attempt_at=min(
                    row["next_attempt_at"],
                    row["run_deadline_at"],
                ),
                lease_owner=None,
                lease_expires_at=None,
                claim_token=None,
                claim_hash=None,
                error_count=int(row["error_count"]) + int(not precursor),
                last_error_code=(
                    row["last_error_code"]
                    if precursor
                    else QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR.value
                ),
                last_error_stage=(
                    row["last_error_stage"]
                    if precursor
                    else "trace_deadline"
                ),
                last_error_at=(
                    row["last_error_at"] if precursor else self.now
                ),
                finished_at=self.now,
                updated_at=self.now,
            )
        return min(len(eligible), limit)

    def sophia_list_unresolved_deck_quality_shadow_dispatches(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        limit = int(payload["p_limit"])
        return [
            {
                "quality_run_id": row["quality_run_id"],
                "dispatch_intent_status": row["dispatch_intent_status"],
            }
            for row in self.rows.values()
            if row["state"] not in {"completed", "failed", "stale"}
            and row["dispatch_intent_status"]
            in {"prepared", "unresolved", "reconciled"}
        ][:limit]

    def sophia_release_deck_quality_shadow_lease(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        released_state = "finalizing" if row["state"] == "finalizing" else "pending"
        row.update(
            state=released_state,
            next_attempt_at=self.now,
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            updated_at=self.now,
        )
        return [self._copy(row)]

    def sophia_retry_deck_quality_shadow_run(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        if int(row["max_attempts"]) != int(payload["p_max_attempts"]):
            raise DeckQualityPersistenceRpcError(
                "sophia_retry_deck_quality_shadow_run",
                status_code=409,
            )
        precursor = row["pending_terminal_state"] is not None
        deadline = row["run_deadline_at"] <= self.now  # type: ignore[operator]
        exhausted = int(row["attempt_count"]) >= int(row["max_attempts"])
        terminalizing = precursor or deadline or exhausted
        retry_state = "finalizing" if row["state"] == "finalizing" else "retry_wait"
        row.update(
            state="finalizing" if terminalizing else retry_state,
            next_attempt_at=min(
                self.now + timedelta(seconds=int(payload["p_delay_seconds"])),
                row["trace_deadline_at"] if terminalizing else row["run_deadline_at"],  # type: ignore[type-var]
            ),
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            pending_terminal_state=(
                row["pending_terminal_state"]
                if precursor
                else QualityRunTerminalState.FAILED.value if terminalizing else None
            ),
            terminal_trace_payload_hash=(
                row["terminal_trace_payload_hash"] if precursor else None
            ),
            error_count=int(row["error_count"]) + (0 if precursor else 1),
            last_error_code=(
                row["last_error_code"]
                if precursor
                else QualityRunErrorCode.RUN_DEADLINE_EXCEEDED.value
                if deadline
                else QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED.value
                if exhausted
                else payload["p_error_code"]
            ),
            last_error_stage=(
                row["last_error_stage"]
                if precursor
                else "run_deadline"
                if deadline
                else "attempt_limit"
                if exhausted
                else payload["p_error_stage"]
            ),
            last_error_at=row["last_error_at"] if precursor else self.now,
            finished_at=None,
            updated_at=self.now,
        )
        return [self._copy(row)]

    def sophia_prepare_deck_quality_shadow_failure_trace(
        self,
        payload: dict[str, object],
    ) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        root = payload["p_safe_trace_root_input"]
        root_hash = payload["p_safe_trace_root_input_hash"]
        if safe_trace_root_input_hash(root) != root_hash:  # type: ignore[arg-type]
            raise DeckQualityPersistenceRpcError(
                "sophia_prepare_deck_quality_shadow_failure_trace",
                status_code=400,
            )
        if row["state"] == "finalizing" and row["pending_terminal_state"] is not None:
            expected = (
                row["pending_terminal_state"],
                row["last_error_code"],
                row["last_error_stage"],
            )
            incoming = (
                payload["p_terminal_state"],
                payload["p_error_code"],
                payload["p_error_stage"],
            )
            if expected != incoming or row["terminal_trace_payload_hash"] not in {
                None,
                payload["p_terminal_trace_payload_hash"],
            }:
                raise DeckQualityPersistenceRpcError(
                    "sophia_prepare_deck_quality_shadow_failure_trace",
                    status_code=409,
                )
            if row["safe_trace_root_input"] is not None and row["safe_trace_root_input"] != root:
                raise DeckQualityPersistenceRpcError(
                    "sophia_prepare_deck_quality_shadow_failure_trace",
                    status_code=409,
                )
        elif row["state"] == "finalizing" and (
            row["decision_result"] is None
            or row["safe_trace_root_input"] != root
            or row["safe_trace_root_input_hash"] != root_hash
        ):
            raise DeckQualityPersistenceRpcError(
                "sophia_prepare_deck_quality_shadow_failure_trace",
                status_code=409,
            )
        row.update(
            state="finalizing",
            pending_terminal_state=payload["p_terminal_state"],
            terminal_trace_payload_hash=payload["p_terminal_trace_payload_hash"],
            safe_trace_root_input=root,
            safe_trace_root_input_hash=root_hash,
            last_error_code=payload["p_error_code"],
            last_error_stage=payload["p_error_stage"],
            last_error_at=row["last_error_at"] or self.now,
            error_count=int(row["error_count"])
            + int(row["pending_terminal_state"] is None),
            updated_at=self.now,
        )
        return [self._copy(row)]

    def sophia_prepare_deck_quality_shadow_completion(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        incoming_hashes = payload["p_stage_artifact_hashes"]
        if (
            row["stage"] != "adjudicated"
            or not {"decision", "safe_metrics", "run"}.issubset(incoming_hashes)  # type: ignore[arg-type]
            or row["stage_artifact_hashes"].get("decision") != incoming_hashes["decision"]  # type: ignore[union-attr,index]
        ):
            raise DeckQualityPersistenceRpcError(
                "sophia_prepare_deck_quality_shadow_completion",
                status_code=400,
            )
        for existing, incoming in (
            (row["safe_metrics"], payload["p_safe_metrics"]),
            (row["trace_ids"], payload["p_trace_ids"]),
            (row["stage_artifact_hashes"], incoming_hashes),
        ):
            for key, value in incoming.items():  # type: ignore[union-attr]
                if key in existing and existing[key] != value:  # type: ignore[operator,index]
                    raise DeckQualityPersistenceRpcError(
                        "sophia_prepare_deck_quality_shadow_completion",
                        status_code=409,
                    )
        if row["state"] == "finalizing":
            if (
                row["decision_result"] != payload["p_decision_result"]
                or row["decision_failure_codes"] != payload["p_decision_failure_codes"]
                or row["decision_weighted_score"] != payload["p_decision_weighted_score"]
                or any(
                    any(existing.get(key) != value for key, value in incoming.items())  # type: ignore[union-attr]
                    for existing, incoming in (
                        (row["safe_metrics"], payload["p_safe_metrics"]),
                        (row["trace_ids"], payload["p_trace_ids"]),
                        (row["stage_artifact_hashes"], incoming_hashes),
                    )
                )
                or row["safe_trace_root_input"]
                != payload["p_safe_trace_root_input"]
                or row["safe_trace_root_input_hash"]
                != payload["p_safe_trace_root_input_hash"]
            ):
                raise DeckQualityPersistenceRpcError(
                    "sophia_prepare_deck_quality_shadow_completion",
                    status_code=409,
                )
            return [self._copy(row)]
        row.update(
            state="finalizing",
            decision_result=payload["p_decision_result"],
            decision_failure_codes=payload["p_decision_failure_codes"],
            decision_weighted_score=payload["p_decision_weighted_score"],
            safe_metrics={**row["safe_metrics"], **payload["p_safe_metrics"]},  # type: ignore[dict-item]
            trace_ids={**row["trace_ids"], **payload["p_trace_ids"]},  # type: ignore[dict-item]
            stage_artifact_hashes={**row["stage_artifact_hashes"], **incoming_hashes},  # type: ignore[dict-item]
            safe_trace_root_input=payload["p_safe_trace_root_input"],
            safe_trace_root_input_hash=payload["p_safe_trace_root_input_hash"],
            updated_at=self.now,
        )
        return [self._copy(row)]

    def sophia_complete_deck_quality_shadow_after_trace(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self.rows[str(payload["p_quality_run_id"])]
        if row["state"] == "completed" and row["stage"] == "persisted_and_traced" and row["completion_owner"] == payload["p_lease_owner"] and row["completion_token"] == payload["p_lease_epoch"]:
            return [self._copy(row)]
        row = self._require_lease(payload)
        if row["state"] != "finalizing":
            raise DeckQualityPersistenceRpcError(
                "sophia_complete_deck_quality_shadow_after_trace",
                status_code=400,
            )
        row.update(
            state="completed",
            stage="persisted_and_traced",
            stage_rank=70,
            lease_owner=None,
            lease_expires_at=None,
            claim_token=None,
            claim_hash=None,
            completion_owner=payload["p_lease_owner"],
            completion_token=payload["p_lease_epoch"],
            finished_at=self.now,
            updated_at=self.now,
        )
        return [self._copy(row)]

    def sophia_checkpoint_deck_quality_shadow_run(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        stage = QualityRunStage(str(payload["p_stage"]))
        incoming_metrics = payload["p_safe_metrics"]
        incoming_traces = payload["p_trace_ids"]
        incoming_hashes = payload["p_stage_artifact_hashes"]
        evidence_path = payload["p_evidence_manifest_object_path"]
        evidence_hash = payload["p_evidence_manifest_hash"]
        new_rank = STAGE_RANK[stage]
        current_rank = int(row["stage_rank"])
        if stage is QualityRunStage.SNAPSHOT_LOADED:
            expected_path = str(row["input_manifest_object_path"]).removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"
            if not isinstance(evidence_path, str) or evidence_path != expected_path or not isinstance(evidence_hash, str) or len(evidence_hash) != 64:
                raise DeckQualityPersistenceRpcError(
                    "sophia_checkpoint_deck_quality_shadow_run",
                    status_code=400,
                )
        elif evidence_path is not None or evidence_hash is not None:
            raise DeckQualityPersistenceRpcError(
                "sophia_checkpoint_deck_quality_shadow_run",
                status_code=400,
            )
        if new_rank == current_rank:
            maps = (
                (row["safe_metrics"], incoming_metrics),
                (row["trace_ids"], incoming_traces),
                (row["stage_artifact_hashes"], incoming_hashes),
            )
            if (
                stage.value != row["stage"]
                or any(
                    any(
                        key not in existing or existing[key] != value  # type: ignore[operator,index]
                        for key, value in incoming.items()  # type: ignore[union-attr]
                    )
                    for existing, incoming in maps
                )
                or (stage is QualityRunStage.SNAPSHOT_LOADED and (row["evidence_manifest_object_path"] != evidence_path or row["evidence_manifest_hash"] != evidence_hash))
            ):
                raise DeckQualityPersistenceRpcError(
                    "sophia_checkpoint_deck_quality_shadow_run",
                    status_code=409,
                )
            return [self._copy(row)]
        if new_rank != current_rank + 10:
            raise DeckQualityPersistenceRpcError(
                "sophia_checkpoint_deck_quality_shadow_run",
                status_code=400,
            )
        required_hash = {
            QualityRunStage.SNAPSHOT_LOADED: "source_snapshot",
            QualityRunStage.EVIDENCE_PREPARED: "evidence_manifest",
            QualityRunStage.BLIND_ASSESSED: "assessment_a_visual",
            QualityRunStage.MECHANICAL_PROJECTED: "assessment_b_mechanical",
            QualityRunStage.PLAN_REALIZATION_ASSESSED: "assessment_c_plan_realization",
            QualityRunStage.ADJUDICATED: "decision",
        }.get(stage)
        if required_hash is None or required_hash not in incoming_hashes:  # type: ignore[operator]
            raise DeckQualityPersistenceRpcError(
                "sophia_checkpoint_deck_quality_shadow_run",
                status_code=400,
            )
        if (
            incoming_hashes.get("evidence_manifest") is not None  # type: ignore[union-attr]
            and (
                row["evidence_manifest_hash"] is None or incoming_hashes["evidence_manifest"] != row["evidence_manifest_hash"]  # type: ignore[index]
            )
        ):
            raise DeckQualityPersistenceRpcError(
                "sophia_checkpoint_deck_quality_shadow_run",
                status_code=409,
            )
        for key, digest in incoming_hashes.items():  # type: ignore[union-attr]
            existing = row["stage_artifact_hashes"].get(key)  # type: ignore[union-attr]
            if existing is not None and existing != digest:
                raise DeckQualityPersistenceRpcError(
                    "sophia_checkpoint_deck_quality_shadow_run",
                    status_code=409,
                )
        for existing, incoming in (
            (row["safe_metrics"], incoming_metrics),
            (row["trace_ids"], incoming_traces),
        ):
            for key, value in incoming.items():  # type: ignore[union-attr]
                if key in existing and existing[key] != value:  # type: ignore[operator,index]
                    raise DeckQualityPersistenceRpcError(
                        "sophia_checkpoint_deck_quality_shadow_run",
                        status_code=409,
                    )
        row["stage"] = stage.value
        row["stage_rank"] = new_rank
        row["safe_metrics"] = {**row["safe_metrics"], **incoming_metrics}  # type: ignore[dict-item]
        row["trace_ids"] = {**row["trace_ids"], **incoming_traces}  # type: ignore[dict-item]
        row["stage_artifact_hashes"] = {
            **row["stage_artifact_hashes"],  # type: ignore[dict-item]
            **incoming_hashes,  # type: ignore[dict-item]
        }
        if stage is QualityRunStage.SNAPSHOT_LOADED:
            row["evidence_manifest_object_path"] = evidence_path
            row["evidence_manifest_hash"] = evidence_hash
        row["updated_at"] = self.now
        return [self._copy(row)]

    def sophia_finish_deck_quality_shadow_run(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self._require_lease(payload)
        terminal_state = str(payload["p_terminal_state"])
        if (
            terminal_state == "completed"
            or row["state"] != "finalizing"
            or row["pending_terminal_state"] != terminal_state
            or row["terminal_trace_payload_hash"]
            != payload["p_terminal_trace_payload_hash"]
            or row["last_error_code"] != payload["p_error_code"]
            or row["last_error_stage"] != payload["p_error_stage"]
        ):
            raise DeckQualityPersistenceRpcError(
                "sophia_finish_deck_quality_shadow_run",
                status_code=400,
            )
        incoming_hashes = payload["p_stage_artifact_hashes"]
        if (
            incoming_hashes.get("evidence_manifest") is not None  # type: ignore[union-attr]
            and (
                row["evidence_manifest_hash"] is None or incoming_hashes["evidence_manifest"] != row["evidence_manifest_hash"]  # type: ignore[index]
            )
        ):
            raise DeckQualityPersistenceRpcError(
                "sophia_finish_deck_quality_shadow_run",
                status_code=409,
            )
        for key, digest in incoming_hashes.items():  # type: ignore[union-attr]
            existing = row["stage_artifact_hashes"].get(key)  # type: ignore[union-attr]
            if existing is not None and existing != digest:
                raise DeckQualityPersistenceRpcError(
                    "sophia_finish_deck_quality_shadow_run",
                    status_code=409,
                )
        for existing, incoming in (
            (row["safe_metrics"], payload["p_safe_metrics"]),
            (row["trace_ids"], payload["p_trace_ids"]),
        ):
            for key, value in incoming.items():  # type: ignore[union-attr]
                if key in existing and existing[key] != value:  # type: ignore[operator,index]
                    raise DeckQualityPersistenceRpcError(
                        "sophia_finish_deck_quality_shadow_run",
                        status_code=409,
                    )
        row["state"] = terminal_state
        row["next_attempt_at"] = min(row["next_attempt_at"], row["run_deadline_at"])  # type: ignore[arg-type]
        row["lease_owner"] = None
        row["lease_expires_at"] = None
        row["claim_token"] = None
        row["claim_hash"] = None
        if payload["p_decision_result"] is not None:
            row["decision_result"] = payload["p_decision_result"]
            row["decision_failure_codes"] = payload["p_decision_failure_codes"]
            row["decision_weighted_score"] = payload["p_decision_weighted_score"]
        row["safe_metrics"] = {**row["safe_metrics"], **payload["p_safe_metrics"]}  # type: ignore[dict-item]
        row["trace_ids"] = {**row["trace_ids"], **payload["p_trace_ids"]}  # type: ignore[dict-item]
        row["stage_artifact_hashes"] = {
            **row["stage_artifact_hashes"],  # type: ignore[dict-item]
            **incoming_hashes,  # type: ignore[dict-item]
        }
        row["finished_at"] = self.now
        row["updated_at"] = self.now
        return [self._copy(row)]

    def sophia_get_deck_quality_shadow_run(self, payload: dict[str, object]) -> list[dict[str, object]]:
        row = self.rows.get(str(payload["p_quality_run_id"]))
        return [self._copy(row)] if row else []


def test_migration_is_additive_private_epoch_fenced_and_skip_locked() -> None:
    sql = " ".join(MIGRATION.read_text(encoding="utf-8").split())

    assert "CREATE TABLE IF NOT EXISTS public.sophia_deck_quality_shadow_runs" in sql
    assert "UNIQUE (artifact_version_id, campaign_id, instrument_identity_hash)" in sql
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "lease_epoch = run.lease_epoch + 1" in sql
    assert "v_stage_rank <> v_run.stage_rank + 10" in sql
    assert "deck_quality_checkpoint_replay_not_idempotent" in sql
    assert "deck_quality_stage_artifact_hash_required" in sql
    assert "input_manifest_object_path TEXT NOT NULL" in sql
    assert "input_manifest_hash TEXT NOT NULL" in sql
    assert "thread_id TEXT NOT NULL CHECK ( char_length(thread_id) BETWEEN 1 AND 256" in sql
    assert "max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100)" in sql
    assert "run_deadline_at TIMESTAMPTZ NOT NULL" in sql
    assert "CHECK (attempt_count <= max_attempts)" in sql
    assert "CHECK (run_deadline_at > requested_at)" in sql
    assert "CHECK (isfinite(run_deadline_at))" in sql
    assert "CHECK (run_deadline_at <= requested_at + interval '15 minutes')" in sql
    assert "trace_deadline_at TIMESTAMPTZ NOT NULL" in sql
    assert "trace_deadline_at = run_deadline_at + interval '2 minutes'" in sql
    assert "WHEN state = 'finalizing' THEN trace_deadline_at" in sql
    assert "pending_terminal_state" in sql
    assert "terminal_trace_payload_hash" in sql
    assert "safe_trace_root_input" in sql
    assert "sophia_prepare_deck_quality_shadow_failure_trace" in sql
    assert "CREATE OR REPLACE FUNCTION public.sophia_deck_quality_safe_path_segment" in sql
    assert "public.sophia_deck_quality_safe_path_segment(user_id, 'user')" in sql
    assert "public.sophia_deck_quality_safe_path_segment(thread_id, 'thread')" in sql
    assert "public.sophia_deck_quality_safe_path_segment(build_id, 'build')" in sql
    assert "p_user_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_user_id, 'user')" in sql
    assert "p_thread_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_thread_id, 'thread')" in sql
    assert "p_build_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_build_id, 'build')" in sql
    assert "NOT isfinite(p_run_deadline_at)" in sql
    assert "p_run_deadline_at > statement_timestamp() + interval '15 minutes'" in sql
    assert "p_input_manifest_object_path <> v_expected_path" in sql
    assert "evidence_manifest_object_path TEXT CHECK" in sql
    assert "evidence_manifest_hash TEXT CHECK" in sql
    assert "(evidence_manifest_object_path IS NULL) = (evidence_manifest_hash IS NULL)" in sql
    assert "stage_rank = 0 AND evidence_manifest_object_path IS NULL" in sql
    assert "stage_rank >= 10 AND evidence_manifest_object_path IS NOT NULL" in sql
    assert "deck_quality_evidence_manifest_path_invalid" in sql
    assert "WHEN p_stage = 'snapshot_loaded' THEN p_evidence_manifest_object_path" in sql
    assert "stage_artifact_hashes JSONB NOT NULL DEFAULT '{}'::JSONB" in sql
    assert "deck_quality_stage_artifact_hash_conflict" in sql
    assert "deck_quality_prepare_completion_replay_not_idempotent" in sql
    assert "deck_quality_completion_not_prepared" in sql
    assert "state = 'finalizing'" in sql
    assert "run.state = 'finalizing'" in sql
    assert "run.attempt_count >= run.max_attempts" in sql
    assert "run.attempt_count < run.max_attempts" in sql
    assert "run.run_deadline_at <= statement_timestamp()" in sql
    assert "run.run_deadline_at > statement_timestamp()" in sql
    assert "attempt_limit_exhausted" in sql
    assert "run_deadline_exceeded" in sql
    assert "completion_owner = p_lease_owner" in sql
    assert "completion_token = p_lease_epoch" in sql
    assert "v_run.completion_owner = p_lease_owner" in sql
    assert "v_run.completion_token = p_lease_epoch" in sql
    assert "? 'safe_metrics'" in sql
    assert "? 'run'" in sql
    assert "scope_kind = 'canary'" in sql
    assert "REVOKE ALL ON TABLE public.sophia_deck_quality_shadow_runs FROM PUBLIC, anon, authenticated, service_role;" in sql
    assert "REVOKE ALL ON FUNCTION public.sophia_deck_quality_safe_path_segment(TEXT, TEXT)" in sql
    assert "GRANT SELECT" not in sql
    for rpc in (
        "sophia_request_deck_quality_shadow_run",
        "sophia_claim_deck_quality_shadow_runs",
        "sophia_renew_deck_quality_shadow_lease",
        "sophia_release_deck_quality_shadow_lease",
        "sophia_retry_deck_quality_shadow_run",
        "sophia_checkpoint_deck_quality_shadow_run",
        "sophia_prepare_deck_quality_shadow_completion",
        "sophia_complete_deck_quality_shadow_after_trace",
        "sophia_finish_deck_quality_shadow_run",
        "sophia_get_deck_quality_shadow_run",
    ):
        assert f"CREATE OR REPLACE FUNCTION public.{rpc}" in sql
        assert f"GRANT EXECUTE ON FUNCTION public.{rpc}" in sql

    table_definition = sql.split(
        "CREATE TABLE IF NOT EXISTS public.sophia_deck_quality_shadow_runs (",
        maxsplit=1,
    )[1].split("CREATE INDEX", maxsplit=1)[0]
    for prohibited_column in (
        "raw_prompt",
        "image_bytes",
        "creative_plan JSONB",
        "design_plan JSONB",
        "memory JSONB",
        "provider_payload",
        "exception_text",
    ):
        assert prohibited_column not in table_definition


def test_request_is_idempotent_across_restart_and_input_manifest_identity_is_immutable() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        request = _request()
        first_store = SupabaseDeckQualityRunStore(rpc)
        first = await first_store.request(request)
        duplicate = await first_store.request(request)

        restarted_store = SupabaseDeckQualityRunStore(rpc)
        after_restart = await restarted_store.request(request)

        assert first == duplicate == after_restart
        assert len(rpc.rows) == 1
        assert first.quality_run_id == request.quality_run_id
        assert first.instrument_identity_hash == request.instrument_identity_hash
        assert first.input_manifest_hash == "1" * 64
        assert first.artifact_hash == "0" * 64
        assert first.thread_id == request.thread_id
        assert first.max_attempts == request.max_attempts
        assert first.run_deadline_at == request.run_deadline_at
        assert first.evidence_manifest_object_path is None
        assert first.evidence_manifest_hash is None

        conflicting = _request(input_manifest_hash="2" * 64)
        with pytest.raises(DeckQualityPersistenceRpcError) as exc_info:
            await restarted_store.request(conflicting)
        assert exc_info.value.status_code == 409
        assert rpc.rows[first.quality_run_id]["input_manifest_hash"] == "1" * 64
        assert rpc.rows[first.quality_run_id]["evidence_manifest_hash"] is None

        with pytest.raises(DeckQualityPersistenceRpcError) as artifact_conflict:
            await restarted_store.request(_request(artifact_hash="9" * 64))
        assert artifact_conflict.value.status_code == 409
        assert rpc.rows[first.quality_run_id]["artifact_hash"] == "0" * 64

        for identity_drift in (
            _request(thread_id="other-thread"),
            _request(user_id="other-user"),
            _request(build_id="build-2"),
            _request(max_attempts=request.max_attempts + 1),
            _request(run_deadline_at=request.run_deadline_at + timedelta(minutes=1)),
        ):
            with pytest.raises(DeckQualityPersistenceRpcError) as drift_info:
                await restarted_store.request(identity_drift)
            assert drift_info.value.status_code == 409

    anyio.run(scenario)


def test_claim_empty_receipt_replays_empty_after_work_arrives_and_fresh_token_claims() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        owner = "receipt-worker"
        empty_token = "empty-receipt-token"

        assert await _claim(
            store,
            lease_owner=owner,
            claim_token=empty_token,
        ) == ()
        await store.request(_request())

        # A lost empty response must remain empty for the exact token even if
        # work appears before the dispatcher replays the ambiguous request.
        assert await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner=owner,
            claim_token=empty_token,
        ) == ()
        fresh = await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner=owner,
            claim_token="fresh-after-empty-token",
        )
        assert len(fresh) == 1
        assert fresh[0].claim_token == "fresh-after-empty-token"

    anyio.run(scenario)


def test_claim_nonempty_receipt_replays_exact_args_and_expires_closed() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(_request())
        owner = "receipt-worker"
        token = "nonempty-receipt-token"

        first = await _claim(
            store,
            lease_owner=owner,
            lease_seconds=30,
            claim_token=token,
        )
        assert len(first) == 1
        rpc.advance(10)
        assert await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner=owner,
            lease_seconds=30,
            claim_token=token,
        ) == first

        with pytest.raises(DeckQualityPersistenceRpcError) as exc_info:
            await _claim(
                store,
                lease_owner=owner,
                lease_seconds=31,
                claim_token=token,
            )
        assert exc_info.value.status_code == 409

        rpc.advance(21)
        assert await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner=owner,
            lease_seconds=30,
            claim_token=token,
        ) == ()
        reclaimed = await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner="receipt-reclaimer",
            claim_token="fresh-reclaim-token",
        )
        assert len(reclaimed) == 1
        assert reclaimed[0].lease_epoch == first[0].lease_epoch + 1

    anyio.run(scenario)


def test_claim_contract_rejects_oversize_duplicate_and_out_of_order_responses() -> None:
    class _ResponseRpc:
        def __init__(self, response: list[dict[str, object]]) -> None:
            self.response = response

        async def call(self, _operation: str, _payload: Mapping[str, object]) -> object:
            return copy.deepcopy(self.response)

    async def scenario() -> None:
        with pytest.raises(DeckQualityPersistenceProtocolError, match="response shape"):
            await _claim(
                SupabaseDeckQualityRunStore(_ResponseRpc([{}, {}, {}])),
                lease_owner="shape-worker",
                limit=2,
                claim_token="oversize-token",
            )

        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        for suffix in ("a", "b"):
            await store.request(
                _request(
                    artifact_version_id=f"artifact-version-order-{suffix}",
                    artifact_hash=suffix * 64,
                )
            )
        owner = "ordered-worker"
        token = "ordered-token"
        claimed = await _claim(
            store,
            lease_owner=owner,
            limit=2,
            claim_token=token,
        )
        assert len(claimed) == 2
        rows = [copy.deepcopy(rpc.rows[record.quality_run_id]) for record in claimed]

        with pytest.raises(DeckQualityPersistenceProtocolError, match="duplicate leases"):
            await _claim(
                SupabaseDeckQualityRunStore(_ResponseRpc([rows[0], rows[0]])),
                lease_owner=owner,
                limit=2,
                claim_token=token,
            )
        with pytest.raises(DeckQualityPersistenceProtocolError, match="out of order"):
            await _claim(
                SupabaseDeckQualityRunStore(_ResponseRpc(list(reversed(rows)))),
                lease_owner=owner,
                limit=2,
                claim_token=token,
            )

        expected_hash = canonical_sha256(
            {
                "lease_owner": owner,
                "claim_token": token,
                "lease_seconds": 120,
                "limit": 2,
            }
        )
        assert all(record.claim_hash == expected_hash for record in claimed)
        assert [record.quality_run_id for record in claimed] == sorted(
            record.quality_run_id for record in claimed
        )

    anyio.run(scenario)


def test_claim_receipt_cleanup_is_index_ordered_and_bounded_to_one_hundred() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        old_created_at = rpc.now - timedelta(hours=2)
        for index in range(150):
            rpc.claim_receipts[(f"old-worker-{index:03d}", f"old-token-{index:03d}")] = {
                "claim_hash": f"{index:064x}",
                "lease_seconds": 120,
                "limit": 1,
                "quality_run_ids": [],
                "created_at": old_created_at + timedelta(microseconds=index),
            }

        assert await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner="cleanup-worker",
            claim_token="cleanup-fresh-token",
        ) == ()
        remaining_old = sorted(
            key for key in rpc.claim_receipts if key[0].startswith("old-worker-")
        )
        assert len(remaining_old) == 50
        assert remaining_old[0] == ("old-worker-100", "old-token-100")
        assert ("cleanup-worker", "cleanup-fresh-token") in rpc.claim_receipts

    anyio.run(scenario)


def test_request_and_record_reject_cross_scope_input_paths_before_consumption() -> None:
    with pytest.raises(ValidationError, match="exact immutable scope"):
        _request(input_manifest_object_path=("prefix/artifacts/canary-user/canary-thread/foundation/.builder/builds/build-1/quality/quality_" + "0" * 64 + "/input_bundle/manifest.json"))

    for field, collision in (
        ("user_id", " /canary user/ "),
        ("thread_id", r"team\thread"),
        ("build_id", "build_"),
    ):
        with pytest.raises(ValidationError, match="identity is not canonical"):
            _request(**{field: collision})

    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(_request())
        invalid = copy.deepcopy(rpc.rows[requested.quality_run_id])
        invalid["thread_id"] = "other-thread"

        class _CrossScopeRpc:
            async def call(self, _operation: str, _payload: Mapping[str, object]) -> object:
                return [invalid]

        with pytest.raises(DeckQualityPersistenceProtocolError):
            await SupabaseDeckQualityRunStore(_CrossScopeRpc()).get(requested.quality_run_id)

    anyio.run(scenario)


def test_snapshot_loaded_atomically_binds_evidence_and_replay_is_fenced() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(_request())
        claimed = (await _claim(store, lease_owner="snapshot-worker"))[0]
        lease = QualityRunLease.from_record(claimed)
        evidence_path = requested.input_manifest_object_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"

        with pytest.raises(ValueError, match="requires the immutable evidence"):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.SNAPSHOT_LOADED,
                stage_artifact_hashes={"source_snapshot": "2" * 64},
            )
        assert rpc.rows[requested.quality_run_id]["stage"] == "requested"
        assert rpc.rows[requested.quality_run_id]["evidence_manifest_hash"] is None

        checkpointed = await store.checkpoint(
            lease,
            stage=QualityRunStage.SNAPSHOT_LOADED,
            stage_artifact_hashes={"source_snapshot": "2" * 64},
            evidence_manifest_object_path=evidence_path,
            evidence_manifest_hash="3" * 64,
        )
        assert checkpointed.stage is QualityRunStage.SNAPSHOT_LOADED
        assert checkpointed.evidence_manifest_object_path == evidence_path
        assert checkpointed.evidence_manifest_hash == "3" * 64

        replayed = await SupabaseDeckQualityRunStore(rpc).checkpoint(
            lease,
            stage=QualityRunStage.SNAPSHOT_LOADED,
            stage_artifact_hashes={"source_snapshot": "2" * 64},
            evidence_manifest_object_path=evidence_path,
            evidence_manifest_hash="3" * 64,
        )
        assert replayed == checkpointed

        with pytest.raises(DeckQualityPersistenceRpcError) as exc_info:
            await store.checkpoint(
                lease,
                stage=QualityRunStage.SNAPSHOT_LOADED,
                stage_artifact_hashes={"source_snapshot": "2" * 64},
                evidence_manifest_object_path=evidence_path,
                evidence_manifest_hash="4" * 64,
            )
        assert exc_info.value.status_code == 409
        assert rpc.rows[requested.quality_run_id]["evidence_manifest_hash"] == "3" * 64

        with pytest.raises(ValueError, match="only be bound"):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.EVIDENCE_PREPARED,
                stage_artifact_hashes={"evidence_manifest": "3" * 64},
                evidence_manifest_object_path=evidence_path,
                evidence_manifest_hash="3" * 64,
            )

    anyio.run(scenario)


def test_record_requires_paired_evidence_exactly_from_snapshot_loaded() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(_request())

        before_snapshot = copy.deepcopy(rpc.rows[requested.quality_run_id])
        before_snapshot["evidence_manifest_object_path"] = requested.input_manifest_object_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"
        before_snapshot["evidence_manifest_hash"] = "3" * 64

        after_snapshot = copy.deepcopy(rpc.rows[requested.quality_run_id])
        after_snapshot.update(stage="snapshot_loaded", stage_rank=10)

        for invalid in (before_snapshot, after_snapshot):

            class _InvalidRpc:
                async def call(
                    self,
                    _operation: str,
                    _payload: Mapping[str, object],
                ) -> object:
                    return [invalid]

            with pytest.raises(DeckQualityPersistenceProtocolError):
                await SupabaseDeckQualityRunStore(_InvalidRpc()).get(requested.quality_run_id)

    anyio.run(scenario)


def test_expired_lease_is_reclaimed_after_restart_and_old_epoch_is_fenced() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(_request())
        first_claim = (await _claim(store, lease_owner="gateway-a", lease_seconds=30))[0]
        old_lease = QualityRunLease.from_record(first_claim)
        assert first_claim.attempt_count == 1

        rpc.advance(31)
        restarted_store = SupabaseDeckQualityRunStore(rpc)
        reclaimed = (await _claim(restarted_store, lease_owner="gateway-b", lease_seconds=30))[0]
        new_lease = QualityRunLease.from_record(reclaimed)

        assert reclaimed.quality_run_id == requested.quality_run_id
        assert reclaimed.attempt_count == 2
        assert new_lease.epoch == old_lease.epoch + 1
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.renew(old_lease)
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.checkpoint(
                old_lease,
                stage=QualityRunStage.EVIDENCE_PREPARED,
                stage_artifact_hashes={"evidence_manifest": "1" * 64},
            )
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.release(old_lease)

        checkpoint = await restarted_store.checkpoint(
            new_lease,
            stage=QualityRunStage.SNAPSHOT_LOADED,
            safe_metrics={"slide_count": 5, "coverage_complete": True},
            trace_ids={"quality_root_trace_id": "trace-2"},
            stage_artifact_hashes={"source_snapshot": "2" * 64},
            evidence_manifest_object_path=_evidence_path(reclaimed),
            evidence_manifest_hash="1" * 64,
        )
        assert checkpoint.stage is QualityRunStage.SNAPSHOT_LOADED
        assert checkpoint.safe_metrics["slide_count"] == 5

    anyio.run(scenario)


def test_crashed_final_attempt_is_terminalized_once_and_never_reclaimed() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(_request(max_attempts=2))

        first = (await _claim(store, lease_owner="crash-a", lease_seconds=15))[0]
        rpc.advance(15)
        second = (await _claim(store, lease_owner="crash-b", lease_seconds=15))[0]
        second_lease = QualityRunLease.from_record(second)

        assert first.attempt_count == 1
        assert second.attempt_count == second.max_attempts == 2
        assert second.lease_epoch == first.lease_epoch + 1
        assert await _claim(store, lease_owner="must-not-steal-live-final") == ()
        assert (await store.get(requested.quality_run_id)).state == "running"

        rpc.advance(15)
        trace_claim = await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner="terminal-tracer",
        )
        assert len(trace_claim) == 1
        precursor = trace_claim[0]
        assert precursor.state == "finalizing"
        assert precursor.pending_terminal_state == "failed"
        assert precursor.terminal_trace_payload_hash is None
        assert precursor.finished_at is None
        assert precursor.attempt_count == precursor.max_attempts == 2
        terminal = await _ack_failure(
            store,
            precursor,
            error_code=QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED,
            error_stage="attempt_limit",
        )
        assert terminal.state == "failed"
        assert terminal.attempt_count == terminal.max_attempts == 2
        assert terminal.last_error_code is QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED
        assert terminal.last_error_stage == "attempt_limit"
        assert terminal.error_count == 1
        assert terminal.lease_owner is None
        assert terminal.finished_at == rpc.now
        assert await _claim(store, lease_owner="still-terminal") == ()
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.renew(second_lease)

    anyio.run(scenario)


def test_deadline_reaper_terminalizes_pending_retry_and_running_rows_without_reclaim() -> None:
    async def scenario() -> None:
        pending_rpc = _FakeRpc()
        pending_store = SupabaseDeckQualityRunStore(pending_rpc)
        await pending_store.request(_request(run_deadline_at=pending_rpc.now + timedelta(seconds=10)))
        pending_rpc.advance(10)
        pending_claim = await _claim(pending_store, lease_owner="deadline-pending")
        assert len(pending_claim) == 1
        assert pending_claim[0].state == "finalizing"
        assert pending_claim[0].attempt_count == 0
        pending_terminal = await _ack_failure(
            pending_store,
            pending_claim[0],
            error_code=QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
            error_stage="run_deadline",
        )
        assert pending_terminal.state == "failed"
        assert pending_terminal.attempt_count == 0
        assert pending_terminal.last_error_code is QualityRunErrorCode.RUN_DEADLINE_EXCEEDED

        retry_rpc = _FakeRpc()
        retry_store = SupabaseDeckQualityRunStore(retry_rpc)
        await retry_store.request(
            _request(
                artifact_version_id="artifact-version-retry-deadline",
                max_attempts=3,
                run_deadline_at=retry_rpc.now + timedelta(seconds=40),
            )
        )
        retry_claim = (await _claim(retry_store, lease_owner="deadline-retry", lease_seconds=15))[0]
        retry_wait = await retry_store.retry(
            QualityRunLease.from_record(retry_claim),
            error_code=QualityRunErrorCode.JUDGE_UNAVAILABLE,
            error_stage="blind_assessed",
            delay_seconds=30,
            max_attempts=3,
        )
        assert retry_wait.state == "retry_wait"
        retry_rpc.advance(40)
        retry_trace_claim = await _claim(retry_store, lease_owner="deadline-retry-reclaim")
        assert len(retry_trace_claim) == 1
        retry_terminal = await _ack_failure(
            retry_store,
            retry_trace_claim[0],
            error_code=QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
            error_stage="run_deadline",
            payload_hash="e" * 64,
        )
        assert retry_terminal.state == "failed"
        assert retry_terminal.last_error_code is QualityRunErrorCode.RUN_DEADLINE_EXCEEDED
        assert retry_terminal.error_count == 2

        running_rpc = _FakeRpc()
        running_store = SupabaseDeckQualityRunStore(running_rpc)
        await running_store.request(
            _request(
                artifact_version_id="artifact-version-running-deadline",
                run_deadline_at=running_rpc.now + timedelta(seconds=20),
            )
        )
        running = (await _claim(running_store, lease_owner="deadline-running", lease_seconds=120))[0]
        running_lease = QualityRunLease.from_record(running)
        assert running.lease_expires_at == running.run_deadline_at
        renewed = await running_store.renew(running_lease, lease_seconds=120)
        assert renewed.lease_expires_at == renewed.run_deadline_at
        running_rpc.advance(20)
        running_trace_claim = await _claim(running_store, lease_owner="deadline-running-reclaim")
        assert len(running_trace_claim) == 1
        assert running_trace_claim[0].lease_expires_at > running_trace_claim[0].run_deadline_at
        running_terminal = await _ack_failure(
            running_store,
            running_trace_claim[0],
            error_code=QualityRunErrorCode.RUN_DEADLINE_EXCEEDED,
            error_stage="run_deadline",
            payload_hash="f" * 64,
        )
        assert running_terminal.state == "failed"
        assert running_terminal.last_error_code is QualityRunErrorCode.RUN_DEADLINE_EXCEEDED
        assert await _claim(running_store, lease_owner="deadline-terminal") == ()
        with pytest.raises(DeckQualityPersistenceRpcError):
            await running_store.release(running_lease)

    anyio.run(scenario)


def test_trace_grace_recovery_terminalizes_precursor_and_is_idempotent() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(
            _request(
                artifact_version_id="artifact-version-expired-trace-grace",
                run_deadline_at=rpc.now + timedelta(seconds=10),
            )
        )
        rpc.advance(11)
        rpc._prepare_trace_pending_rows()
        precursor_row = rpc.rows[requested.quality_run_id]
        precursor_row.update(
            lease_epoch=1,
            dispatch_intent_epoch=1,
            dispatch_intent_attempt_count=0,
            dispatch_intent_token="dq1-dispatch:expired-precursor",
            dispatch_intent_status="unresolved",
            dispatch_intent_at=rpc.now,
        )
        precursor = QualityRunRecord.model_validate(precursor_row)
        assert precursor.state == "finalizing"
        assert precursor.pending_terminal_state == "failed"
        assert precursor.finished_at is None
        assert await store.unresolved_dispatches() == (
            requested.quality_run_id,
        )

        rpc.advance(120)
        assert await _claim(store, lease_owner="after-trace-grace") == ()
        assert await store.recover_expired_finalizing() == 1
        recovered = await store.get(requested.quality_run_id)
        assert recovered is not None
        assert recovered.state == "failed"
        assert recovered.pending_terminal_state == "failed"
        assert recovered.last_error_code is QualityRunErrorCode.RUN_DEADLINE_EXCEEDED
        assert recovered.terminal_trace_payload_hash is None
        assert recovered.safe_trace_root_input is None
        assert recovered.lease_owner is None
        assert recovered.finished_at is not None
        assert recovered.finished_at >= recovered.trace_deadline_at
        assert recovered.next_attempt_at == recovered.run_deadline_at
        assert recovered.dispatch_intent_status == "unresolved"
        assert await store.unresolved_dispatches() == ()
        assert await store.recover_expired_finalizing() == 0

    anyio.run(scenario)


def test_record_trace_grace_exception_is_narrow_and_hash_remains_root_bound() -> None:
    rpc = _FakeRpc()
    requested = anyio.run(
        SupabaseDeckQualityRunStore(rpc).request,
        _request(
            artifact_version_id="artifact-version-model-trace-grace",
            run_deadline_at=rpc.now + timedelta(seconds=10),
        ),
    )
    row = copy.deepcopy(rpc.rows[requested.quality_run_id])
    row.update(
        state="failed",
        pending_terminal_state="failed",
        error_count=1,
        last_error_code=QualityRunErrorCode.RUN_DEADLINE_EXCEEDED.value,
        last_error_stage="run_deadline",
        last_error_at=row["run_deadline_at"],
        finished_at=row["run_deadline_at"],
        next_attempt_at=row["run_deadline_at"],
    )

    with pytest.raises(ValidationError, match="trace payload hash"):
        QualityRunRecord.model_validate(row)

    row["finished_at"] = row["trace_deadline_at"]
    with pytest.raises(ValidationError, match="trace payload hash"):
        QualityRunRecord.model_validate(row)

    row["updated_at"] = row["trace_deadline_at"]
    recovered = QualityRunRecord.model_validate(row)
    assert recovered.state == "failed"

    row["terminal_trace_payload_hash"] = "a" * 64
    with pytest.raises(ValidationError, match="safe root binding"):
        QualityRunRecord.model_validate(row)


def test_recovery_preserves_three_finalizing_evidence_shapes_and_respects_limit() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        expired: list[QualityRunRecord] = []
        for suffix in ("attempt", "coverage", "prepared"):
            expired.append(
                await store.request(
                    _request(
                        artifact_version_id=f"artifact-version-recovery-{suffix}",
                        artifact_hash={
                            "attempt": "a",
                            "coverage": "b",
                            "prepared": "c",
                        }[suffix]
                        * 64,
                        run_deadline_at=rpc.now + timedelta(seconds=10),
                    )
                )
            )
        live = await store.request(
            _request(
                artifact_version_id="artifact-version-recovery-live",
                artifact_hash="d" * 64,
                run_deadline_at=rpc.now + timedelta(minutes=10),
            )
        )

        for index, record in enumerate((*expired, live), start=1):
            row = rpc.rows[record.quality_run_id]
            row.update(
                state="finalizing",
                attempt_count=min(index, int(row["max_attempts"])),
                next_attempt_at=row["trace_deadline_at"],
                lease_owner=None,
                lease_epoch=index,
                lease_expires_at=None,
                claim_token=None,
                claim_hash=None,
                dispatch_intent_epoch=index,
                dispatch_intent_attempt_count=min(
                    index,
                    int(row["max_attempts"]),
                ),
                dispatch_intent_token=f"dq1-dispatch:recovery-{index}",
                dispatch_intent_status="unresolved",
                dispatch_recovery_proof_hash=f"{index:064x}",
                dispatch_intent_at=rpc.now,
                dispatch_resolved_at=None,
                started_at=rpc.now,
                updated_at=rpc.now,
            )

        attempt_row = rpc.rows[expired[0].quality_run_id]
        attempt_row.update(
            pending_terminal_state="failed",
            error_count=1,
            last_error_code=QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED.value,
            last_error_stage="attempt_limit",
            last_error_at=rpc.now,
        )

        coverage_row = rpc.rows[expired[1].quality_run_id]
        coverage_path = _evidence_path(expired[1])
        coverage_row.update(
            stage="snapshot_loaded",
            stage_rank=10,
            evidence_manifest_object_path=coverage_path,
            evidence_manifest_hash="4" * 64,
            pending_terminal_state="failed",
            error_count=2,
            last_error_code=QualityRunErrorCode.COVERAGE_ERROR.value,
            last_error_stage="snapshot_loaded",
            last_error_at=rpc.now,
            safe_metrics={"source_count": 5},
            trace_ids={"dispatch_run_id": "dispatch-coverage"},
            stage_artifact_hashes={"source_snapshot": "5" * 64},
        )

        prepared_row = rpc.rows[expired[2].quality_run_id]
        prepared_path = _evidence_path(expired[2])
        root = _trace_root(expired[2])
        prepared_row.update(
            stage="adjudicated",
            stage_rank=60,
            evidence_manifest_object_path=prepared_path,
            evidence_manifest_hash="6" * 64,
            pending_terminal_state=None,
            decision_result=QualityRunDecision.FAILED_TO_JUDGE.value,
            decision_failure_codes=["cost_admission_rejected"],
            decision_weighted_score=Decimal("1.5"),
            safe_metrics={"judge_calls": 0},
            trace_ids=_trace_ids("prepared-recovery"),
            stage_artifact_hashes={
                "source_snapshot": "7" * 64,
                "evidence_manifest": "6" * 64,
                "assessment_a_visual": "8" * 64,
                "assessment_b_mechanical": "9" * 64,
                "assessment_c_plan_realization": "a" * 64,
                "decision": "b" * 64,
                "safe_metrics": "c" * 64,
                "run": "d" * 64,
            },
            safe_trace_root_input=root,
            safe_trace_root_input_hash=safe_trace_root_input_hash(root),
            error_count=2,
            last_error_code=QualityRunErrorCode.JUDGE_UNAVAILABLE.value,
            last_error_stage="blind_assessed",
            last_error_at=rpc.now,
        )

        live_row = rpc.rows[live.quality_run_id]
        live_row.update(
            pending_terminal_state="failed",
            error_count=1,
            last_error_code=QualityRunErrorCode.JUDGE_UNAVAILABLE.value,
            last_error_stage="blind_assessed",
            last_error_at=rpc.now,
        )

        for record in (*expired, live):
            QualityRunRecord.model_validate(rpc.rows[record.quality_run_id])

        preserved_fields = (
            "stage",
            "stage_rank",
            "dispatch_intent_epoch",
            "dispatch_intent_attempt_count",
            "dispatch_intent_token",
            "dispatch_intent_status",
            "dispatch_recovery_proof_hash",
            "dispatch_intent_at",
            "dispatch_resolved_at",
            "decision_result",
            "decision_failure_codes",
            "decision_weighted_score",
            "safe_metrics",
            "trace_ids",
            "stage_artifact_hashes",
            "evidence_manifest_object_path",
            "evidence_manifest_hash",
            "safe_trace_root_input",
            "safe_trace_root_input_hash",
            "terminal_trace_payload_hash",
        )
        before = {
            record.quality_run_id: {
                field: copy.deepcopy(rpc.rows[record.quality_run_id][field])
                for field in preserved_fields
            }
            for record in expired
        }

        rpc.advance(131)
        assert await store.recover_expired_finalizing(limit=2) == 2
        assert await store.recover_expired_finalizing(limit=2) == 1
        assert await store.recover_expired_finalizing(limit=2) == 0

        for record in expired:
            recovered = await store.get(record.quality_run_id)
            assert recovered is not None
            assert recovered.state == "failed"
            assert recovered.finished_at == rpc.now
            assert {
                field: copy.deepcopy(rpc.rows[record.quality_run_id][field])
                for field in preserved_fields
            } == before[record.quality_run_id]
        prepared = await store.get(expired[2].quality_run_id)
        assert prepared is not None
        assert prepared.last_error_code is QualityRunErrorCode.QUALITY_PERSISTENCE_ERROR
        assert prepared.last_error_stage == "trace_deadline"
        assert prepared.error_count == 3
        assert rpc.rows[expired[0].quality_run_id]["last_error_code"] == (
            QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED.value
        )
        assert rpc.rows[expired[1].quality_run_id]["last_error_code"] == (
            QualityRunErrorCode.COVERAGE_ERROR.value
        )

        untouched = await store.get(live.quality_run_id)
        assert untouched is not None
        assert untouched.state == "finalizing"
        assert untouched.finished_at is None
        assert await store.unresolved_dispatches() == (live.quality_run_id,)

        with pytest.raises(ValueError, match="recovery limit"):
            await store.recover_expired_finalizing(limit=0)
        with pytest.raises(ValueError, match="recovery limit"):
            await store.recover_expired_finalizing(limit=101)

    anyio.run(scenario)


def test_recovery_scalar_response_is_exact_and_bounded() -> None:
    class _ResponseRpc:
        def __init__(self, response: object) -> None:
            self.response = response
            self.calls: list[tuple[str, Mapping[str, object]]] = []

        async def call(
            self,
            operation: str,
            payload: Mapping[str, object],
        ) -> object:
            self.calls.append((operation, payload))
            return self.response

    async def scenario() -> None:
        rpc = _ResponseRpc(2)
        store = SupabaseDeckQualityRunStore(rpc)
        assert await store.recover_expired_finalizing(limit=3) == 2
        assert rpc.calls == [
            (
                "sophia_recover_expired_deck_quality_shadow_runs",
                {"p_limit": 3},
            )
        ]

        for invalid in (True, -1, 4, "2", [2], None):
            with pytest.raises(
                DeckQualityPersistenceProtocolError,
                match="recovery response",
            ):
                await SupabaseDeckQualityRunStore(
                    _ResponseRpc(invalid)
                ).recover_expired_finalizing(limit=3)

    anyio.run(scenario)


def test_expired_finalizing_row_obeys_deadline_and_attempt_cap_instead_of_reclaiming() -> None:
    async def terminalize(
        *,
        deadline_seconds: int,
        advance_seconds: int,
        max_attempts: int,
    ) -> QualityRunRecord:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(
            _request(
                artifact_version_id=f"artifact-finalizing-{deadline_seconds}-{max_attempts}",
                max_attempts=max_attempts,
                run_deadline_at=rpc.now + timedelta(seconds=deadline_seconds),
            )
        )
        claimed = (await _claim(store, lease_owner="finalizing-crash", lease_seconds=15))[0]
        row = rpc.rows[requested.quality_run_id]
        trace_root = _trace_root(claimed)
        row.update(
            state="finalizing",
            stage="adjudicated",
            stage_rank=60,
            evidence_manifest_object_path=_evidence_path(claimed),
            evidence_manifest_hash="1" * 64,
            decision_result=QualityRunDecision.SATISFIED.value,
            trace_ids=_trace_ids("terminal-reaper"),
            stage_artifact_hashes={
                "decision": "9" * 64,
                "safe_metrics": "b" * 64,
                "run": "a" * 64,
            },
            safe_trace_root_input=trace_root,
            safe_trace_root_input_hash=safe_trace_root_input_hash(trace_root),
        )
        assert await _claim(store, lease_owner="must-not-steal-live-finalizing") == ()
        rpc.advance(advance_seconds)
        terminal_claim = await _claim(store, lease_owner="trace-finalizing")
        assert len(terminal_claim) == 1
        expected_code = (
            QualityRunErrorCode.RUN_DEADLINE_EXCEEDED
            if rpc.now >= terminal_claim[0].run_deadline_at
            else QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED
        )
        result = await _ack_failure(
            store,
            terminal_claim[0],
            error_code=expected_code,
            error_stage=(
                "run_deadline"
                if expected_code is QualityRunErrorCode.RUN_DEADLINE_EXCEEDED
                else "attempt_limit"
            ),
            payload_hash="c" * 64,
        )
        assert result.state == "failed"
        assert result.lease_owner is None
        assert await _claim(store, lease_owner="still-not-reclaimable") == ()
        return result

    async def scenario() -> None:
        deadline_terminal = await terminalize(
            deadline_seconds=15,
            advance_seconds=15,
            max_attempts=3,
        )
        assert deadline_terminal.last_error_code is QualityRunErrorCode.RUN_DEADLINE_EXCEEDED

        attempt_terminal = await terminalize(
            deadline_seconds=60,
            advance_seconds=15,
            max_attempts=1,
        )
        assert attempt_terminal.last_error_code is QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED

    anyio.run(scenario)


def test_success_requires_prepared_row_then_separate_trace_acked_completion() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(_request())
        claimed = (await _claim(store, lease_owner="dispatcher-1"))[0]
        lease = QualityRunLease.from_record(claimed)

        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.EVIDENCE_PREPARED,
                stage_artifact_hashes={"evidence_manifest": "1" * 64},
            )
        await store.checkpoint(
            lease,
            stage=QualityRunStage.SNAPSHOT_LOADED,
            stage_artifact_hashes={"source_snapshot": "2" * 64},
            evidence_manifest_object_path=_evidence_path(claimed),
            evidence_manifest_hash="1" * 64,
        )
        await store.checkpoint(
            lease,
            stage=QualityRunStage.EVIDENCE_PREPARED,
            stage_artifact_hashes={"evidence_manifest": "1" * 64},
        )
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.SNAPSHOT_LOADED,
                stage_artifact_hashes={"source_snapshot": "2" * 64},
                evidence_manifest_object_path=_evidence_path(claimed),
                evidence_manifest_hash="1" * 64,
            )
        await store.checkpoint(
            lease,
            stage=QualityRunStage.BLIND_ASSESSED,
            stage_artifact_hashes={"assessment_a_visual": "3" * 64},
        )
        await store.checkpoint(
            lease,
            stage=QualityRunStage.MECHANICAL_PROJECTED,
            stage_artifact_hashes={"assessment_b_mechanical": "4" * 64},
        )
        # Conditional-C short circuits still persist a deterministic skipped
        # assessment record, so resume can prove the stage was intentional.
        await store.checkpoint(
            lease,
            stage=QualityRunStage.PLAN_REALIZATION_ASSESSED,
            safe_metrics={"assessment_c_skipped": True},
            stage_artifact_hashes={"assessment_c_plan_realization": "5" * 64},
        )
        await store.checkpoint(
            lease,
            stage=QualityRunStage.ADJUDICATED,
            safe_metrics={"judge_cost_usd": Decimal("0.388175")},
            trace_ids={"adjudication_run_id": "run-60"},
            stage_artifact_hashes={"decision": "9" * 64},
        )
        with pytest.raises(ValueError, match="prepare_completion"):
            await store.finish(
                lease,
                terminal_state=QualityRunTerminalState.COMPLETED,
                terminal_trace_payload_hash="a" * 64,
                decision_result=QualityRunDecision.NEEDS_REVISION,
                stage_artifact_hashes={"decision": "8" * 64},
            )
        with pytest.raises(ValueError, match="incomplete"):
            await store.prepare_completion(
                lease,
                decision_result=QualityRunDecision.NEEDS_REVISION,
                safe_metrics={"evaluated_slide_count": 5},
                trace_ids={"quality_trace_id": "root-1"},
                stage_artifact_hashes={
                    "decision": "9" * 64,
                    "safe_metrics": "b" * 64,
                    "run": "a" * 64,
                },
                safe_trace_root_input=_trace_root(claimed),
            )
        prepared = await store.prepare_completion(
            lease,
            decision_result=QualityRunDecision.NEEDS_REVISION,
            decision_failure_codes=("weak_signature_realization",),
            decision_weighted_score=Decimal("3.4"),
            safe_metrics={"evaluated_slide_count": 5},
            trace_ids=_trace_ids(),
            stage_artifact_hashes={
                "decision": "9" * 64,
                "safe_metrics": "b" * 64,
                "run": "a" * 64,
            },
            safe_trace_root_input=_trace_root(claimed),
        )
        replayed = await store.prepare_completion(
            lease,
            decision_result=QualityRunDecision.NEEDS_REVISION,
            decision_failure_codes=("weak_signature_realization",),
            decision_weighted_score=Decimal("3.4"),
            safe_metrics={"evaluated_slide_count": 5},
            trace_ids=_trace_ids(),
            stage_artifact_hashes={
                "decision": "9" * 64,
                "safe_metrics": "b" * 64,
                "run": "a" * 64,
            },
            safe_trace_root_input=_trace_root(claimed),
        )

        assert prepared == replayed
        assert prepared.state == "finalizing"
        assert prepared.stage is QualityRunStage.ADJUDICATED
        assert prepared.finished_at is None
        assert QualityRunLease.from_record(prepared) == lease
        assert await _claim(store, lease_owner="dispatcher-too-early") == ()

        finished = await store.complete_after_trace(lease)
        lost_response_replay = await store.complete_after_trace(lease)

        assert finished.state == "completed"
        assert lost_response_replay == finished
        assert finished.completion_owner == lease.owner
        assert finished.completion_token == lease.epoch
        assert finished.stage is QualityRunStage.PERSISTED_AND_TRACED
        assert finished.decision_result is QualityRunDecision.NEEDS_REVISION
        assert finished.stage_artifact_hashes["run"] == "a" * 64
        assert await _claim(store, lease_owner="dispatcher-2") == ()
        assert await SupabaseDeckQualityRunStore(rpc).get(finished.quality_run_id) == finished

        for forged_replay in (
            QualityRunLease(
                quality_run_id=lease.quality_run_id,
                owner="dispatcher-other",
                epoch=lease.epoch,
            ),
            QualityRunLease(
                quality_run_id=lease.quality_run_id,
                owner=lease.owner,
                epoch=lease.epoch + 1,
            ),
        ):
            with pytest.raises(DeckQualityPersistenceRpcError) as replay_info:
                await store.complete_after_trace(forged_replay)
            assert replay_info.value.status_code == 409

    anyio.run(scenario)


def test_prepared_success_crosses_run_deadline_and_reacks_exact_persisted_root() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(
            _request(run_deadline_at=rpc.now + timedelta(seconds=40))
        )
        claimed = (await _claim(store, lease_owner="finalizer-a", lease_seconds=30))[0]
        old_lease = QualityRunLease.from_record(claimed)
        evidence_path = claimed.input_manifest_object_path.removesuffix("/input_bundle/manifest.json") + "/evidence_manifest.json"
        for stage, key, digest in (
            (QualityRunStage.SNAPSHOT_LOADED, "source_snapshot", "2" * 64),
            (QualityRunStage.EVIDENCE_PREPARED, "evidence_manifest", "1" * 64),
            (QualityRunStage.BLIND_ASSESSED, "assessment_a_visual", "3" * 64),
            (QualityRunStage.MECHANICAL_PROJECTED, "assessment_b_mechanical", "4" * 64),
            (QualityRunStage.PLAN_REALIZATION_ASSESSED, "assessment_c_plan_realization", "5" * 64),
            (QualityRunStage.ADJUDICATED, "decision", "9" * 64),
        ):
            if stage is QualityRunStage.SNAPSHOT_LOADED:
                await store.checkpoint(
                    old_lease,
                    stage=stage,
                    stage_artifact_hashes={key: digest},
                    evidence_manifest_object_path=evidence_path,
                    evidence_manifest_hash="1" * 64,
                )
            else:
                await store.checkpoint(
                    old_lease,
                    stage=stage,
                    stage_artifact_hashes={key: digest},
                )
        prepared = await store.prepare_completion(
            old_lease,
            decision_result=QualityRunDecision.SATISFIED,
            decision_weighted_score=Decimal("4.5"),
            safe_metrics={"evaluated_slide_count": 5},
            trace_ids=_trace_ids("resume"),
            stage_artifact_hashes={
                "decision": "9" * 64,
                "safe_metrics": "b" * 64,
                "run": "a" * 64,
            },
            safe_trace_root_input=_trace_root(claimed),
        )
        assert prepared.state == "finalizing"

        rpc.advance(41)
        restarted = SupabaseDeckQualityRunStore(rpc)
        reclaimed = (await _claim(restarted, lease_owner="finalizer-b", lease_seconds=30))[0]
        new_lease = QualityRunLease.from_record(reclaimed)
        assert reclaimed.state == "finalizing"
        assert reclaimed.stage is QualityRunStage.ADJUDICATED
        assert reclaimed.decision_result is QualityRunDecision.SATISFIED
        assert rpc.now > reclaimed.run_deadline_at
        assert rpc.now < reclaimed.trace_deadline_at
        assert reclaimed.attempt_count == prepared.attempt_count
        assert new_lease.epoch == old_lease.epoch + 1
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.complete_after_trace(old_lease)

        replay_arguments = {
            "decision_result": QualityRunDecision.SATISFIED,
            "decision_weighted_score": Decimal("4.5"),
            "safe_metrics": {"evaluated_slide_count": 5},
            "trace_ids": _trace_ids("resume"),
            "stage_artifact_hashes": {
                "decision": "9" * 64,
                "safe_metrics": "b" * 64,
                "run": "a" * 64,
            },
        }
        changed_runtime_root = _trace_root(reclaimed)
        changed_runtime_root["gateway_deployed_sha"] = "4" * 40
        with pytest.raises(DeckQualityPersistenceRpcError) as changed_root:
            await restarted.prepare_completion(
                new_lease,
                **replay_arguments,
                safe_trace_root_input=changed_runtime_root,
            )
        assert changed_root.value.status_code == 409

        persisted_root = prepared.safe_trace_root_input
        assert persisted_root is not None
        replayed = await restarted.prepare_completion(
            new_lease,
            **replay_arguments,
            safe_trace_root_input=persisted_root,
        )
        assert replayed.state == "finalizing"
        assert replayed.safe_trace_root_input == persisted_root
        assert replayed.safe_trace_root_input_hash == prepared.safe_trace_root_input_hash
        assert (await restarted.complete_after_trace(new_lease)).state == "completed"

    anyio.run(scenario)


def test_stage_artifact_hashes_merge_idempotently_and_reject_changed_objects() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(_request())
        claimed = (await _claim(store, lease_owner="resume-worker"))[0]
        lease = QualityRunLease.from_record(claimed)
        first_hash = "1" * 64

        await store.checkpoint(
            lease,
            stage=QualityRunStage.SNAPSHOT_LOADED,
            stage_artifact_hashes={"source_snapshot": "2" * 64},
            evidence_manifest_object_path=_evidence_path(claimed),
            evidence_manifest_hash=first_hash,
        )
        first = await store.checkpoint(
            lease,
            stage=QualityRunStage.EVIDENCE_PREPARED,
            stage_artifact_hashes={"evidence_manifest": first_hash},
        )
        replayed = await store.checkpoint(
            lease,
            stage=QualityRunStage.EVIDENCE_PREPARED,
            stage_artifact_hashes={"evidence_manifest": first_hash},
        )
        with pytest.raises(DeckQualityPersistenceRpcError):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.EVIDENCE_PREPARED,
                safe_metrics={"late_metric": 1},
                stage_artifact_hashes={"evidence_manifest": first_hash},
            )
        merged = await store.checkpoint(
            lease,
            stage=QualityRunStage.BLIND_ASSESSED,
            stage_artifact_hashes={"assessment_a_visual": "7" * 64},
        )

        assert first.stage_artifact_hashes == replayed.stage_artifact_hashes
        assert merged.stage_artifact_hashes == {
            "source_snapshot": "2" * 64,
            "evidence_manifest": first_hash,
            "assessment_a_visual": "7" * 64,
        }
        with pytest.raises(DeckQualityPersistenceRpcError) as exc_info:
            await store.checkpoint(
                lease,
                stage=QualityRunStage.BLIND_ASSESSED,
                stage_artifact_hashes={
                    "assessment_a_visual": "7" * 64,
                    "evidence_manifest": "8" * 64,
                },
            )
        assert exc_info.value.status_code == 409

    anyio.run(scenario)


def test_retry_backoff_survives_restart_and_exhaustion_fails_closed() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(_request(max_attempts=2))
        first = (await _claim(store, lease_owner="dispatcher-a"))[0]
        with pytest.raises(DeckQualityPersistenceRpcError) as drift_info:
            await store.retry(
                QualityRunLease.from_record(first),
                error_code=QualityRunErrorCode.JUDGE_UNAVAILABLE,
                error_stage="blind_assessed",
                delay_seconds=30,
                max_attempts=3,
            )
        assert drift_info.value.status_code == 409
        assert (await store.get(first.quality_run_id)).state == "running"

        retried = await store.retry(
            QualityRunLease.from_record(first),
            error_code=QualityRunErrorCode.JUDGE_UNAVAILABLE,
            error_stage="blind_assessed",
            delay_seconds=30,
            max_attempts=2,
        )
        assert retried.state == "retry_wait"
        assert await _claim(store, lease_owner="too-early") == ()

        rpc.advance(30)
        restarted = SupabaseDeckQualityRunStore(rpc)
        second = (await _claim(restarted, lease_owner="dispatcher-b"))[0]
        exhausted = await restarted.retry(
            QualityRunLease.from_record(second),
            error_code=QualityRunErrorCode.STRUCTURED_OUTPUT_INVALID,
            error_stage="blind_assessed",
            delay_seconds=0,
            max_attempts=2,
        )
        assert exhausted.state == "finalizing"
        assert exhausted.finished_at is None
        assert exhausted.error_count == 2
        assert exhausted.last_error_code is QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED
        assert exhausted.last_error_stage == "attempt_limit"
        terminal_claim = await _claim(
            SupabaseDeckQualityRunStore(rpc),
            lease_owner="dispatcher-c",
        )
        assert len(terminal_claim) == 1
        terminal = await _ack_failure(
            restarted,
            terminal_claim[0],
            error_code=QualityRunErrorCode.ATTEMPT_LIMIT_EXHAUSTED,
            error_stage="attempt_limit",
            payload_hash="b" * 64,
        )
        assert terminal.state == "failed"
        assert terminal.finished_at is not None

    anyio.run(scenario)


def test_release_makes_work_immediately_claimable_with_a_new_epoch() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(_request())
        first = (await _claim(store, lease_owner="dispatcher-a"))[0]
        released = await store.release(QualityRunLease.from_record(first))
        second = (
            await _claim(
                SupabaseDeckQualityRunStore(rpc),
                lease_owner="dispatcher-b",
            )
        )[0]

        assert released.state == "pending"
        assert released.lease_owner is None
        assert second.lease_epoch == first.lease_epoch + 1

    anyio.run(scenario)


@pytest.mark.parametrize("operation", ["get", "claim"])
def test_get_and_claim_reject_unexpected_fields_without_echoing_them(operation: str) -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        normal = SupabaseDeckQualityRunStore(rpc)
        record = await normal.request(_request())
        row = copy.deepcopy(rpc.rows[record.quality_run_id])
        row["raw_prompt"] = "never-log-this-private-value"
        if operation == "claim":
            row.update(
                state="running",
                lease_owner="malicious-worker",
                lease_epoch=1,
                lease_expires_at=rpc.now + timedelta(seconds=120),
                attempt_count=1,
                started_at=rpc.now,
            )

        class _UnexpectedFieldRpc:
            async def call(self, _operation: str, _payload: Mapping[str, object]) -> object:
                return [row]

        store = SupabaseDeckQualityRunStore(_UnexpectedFieldRpc())
        with pytest.raises(DeckQualityPersistenceProtocolError) as exc_info:
            if operation == "get":
                await store.get(record.quality_run_id)
            else:
                await _claim(store, lease_owner="malicious-worker")
        assert "never-log-this-private-value" not in str(exc_info.value)
        assert exc_info.value.__cause__ is None

    anyio.run(scenario)


def test_safe_payload_validation_rejects_raw_or_string_metrics_before_rpc() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        await store.request(_request())
        claimed = (await _claim(store, lease_owner="dispatcher"))[0]
        lease = QualityRunLease.from_record(claimed)

        with pytest.raises(ValueError, match="metric key"):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.SNAPSHOT_LOADED,
                safe_metrics={"raw_prompt": 1},
            )
        with pytest.raises(ValueError, match="only numeric"):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.SNAPSHOT_LOADED,
                safe_metrics={"provider_name": "private-provider"},
            )
        with pytest.raises(ValueError, match="trace ID"):
            await store.checkpoint(
                lease,
                stage=QualityRunStage.SNAPSHOT_LOADED,
                trace_ids={"trace": "private value with spaces"},
            )

    anyio.run(scenario)


def test_dispatch_intent_store_contract_is_content_free_and_exact_token_bound() -> None:
    async def scenario() -> None:
        rpc = _FakeRpc()
        store = SupabaseDeckQualityRunStore(rpc)
        requested = await store.request(_request())
        claimed = (await _claim(store, lease_owner="dispatch-store"))[0]
        lease = QualityRunLease.from_record(claimed)
        intent_token = "dq1-dispatch:store-contract"

        begun = await store.begin_dispatch(
            lease,
            intent_token=intent_token,
        )
        assert begun.dispatch_intent_status == "prepared"
        assert begun.dispatch_intent_token == intent_token
        assert begun.dispatch_intent_epoch == lease.epoch
        assert begun.dispatch_recovery_proof_hash is None
        assert await store.unresolved_dispatches() == (
            requested.quality_run_id,
        )

        confirmed = await store.resolve_dispatch(
            quality_run_id=requested.quality_run_id,
            intent_token=intent_token,
            status="confirmed",
        )
        assert confirmed.dispatch_intent_status == "confirmed"
        assert confirmed.dispatch_resolved_at == rpc.now
        assert await store.unresolved_dispatches() == ()

        with pytest.raises(ValueError, match="intent token"):
            await store.begin_dispatch(lease, intent_token="not valid")

    anyio.run(scenario)


def test_http_rpc_failure_never_includes_response_body_or_service_key() -> None:
    async def scenario() -> None:
        secret_body = "provider-private-response"
        service_key = "service-role-super-secret"

        async def handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["authorization"] == f"Bearer {service_key}"
            assert request.headers["apikey"] == service_key
            return httpx.Response(500, request=request, json={"message": secret_body})

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        rpc = SupabaseDeckQualityRunRpcClient(
            DeckQualityPersistenceConfig(
                url="https://example.supabase.co",
                service_role_key=service_key,
            ),
            client=http,
        )
        with pytest.raises(DeckQualityPersistenceRpcError) as exc_info:
            await rpc.call("sophia_get_deck_quality_shadow_run", {"p_quality_run_id": "quality_id"})
        rendered = str(exc_info.value)
        assert "status=500" in rendered
        assert secret_body not in rendered
        assert service_key not in rendered
        await http.aclose()

    anyio.run(scenario)


def test_configuration_requires_service_role_pair_and_never_accepts_legacy_key(monkeypatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_KEY", "legacy-key")
    assert DeckQualityPersistenceConfig.from_env() is None

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    with pytest.raises(DeckQualityPersistenceConfigurationError):
        DeckQualityPersistenceConfig.from_env()


def test_request_rejects_input_manifest_path_drift_before_enqueue() -> None:
    with pytest.raises(ValidationError, match="exact immutable scope"):
        _request(input_manifest_object_path=("other/.builder/builds/build-1/quality/wrong/input_bundle/manifest.json"))


def test_deadline_must_be_timezone_aware_and_future_when_inserted() -> None:
    with pytest.raises(ValidationError, match="timezone-aware"):
        _request(run_deadline_at=datetime(2026, 7, 16, 13, 0))
    with pytest.raises(ValidationError, match="fifteen-minute request horizon"):
        _request(run_deadline_at=TEST_NOW + timedelta(hours=1))

    async def scenario() -> None:
        rpc = _FakeRpc()
        request = _request(run_deadline_at=rpc.now)
        with pytest.raises(DeckQualityPersistenceRpcError) as exc_info:
            await SupabaseDeckQualityRunStore(rpc).request(request)
        assert exc_info.value.status_code == 400
        assert rpc.rows == {}

    anyio.run(scenario)
