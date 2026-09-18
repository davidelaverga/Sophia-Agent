"""Supabase-backed canonical MEM00 store.

All consent-changing operations call fixed SECURITY DEFINER RPCs.  The browser
never supplies an arbitrary owner directly to this class; Gateway first binds
the authenticated owner and rejects a mismatched path identity.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

import httpx

if TYPE_CHECKING:
    from deerflow.sophia.session_store import SessionRecord

    from .models import AuthorizedMemory

from .models import (
    CandidateRecord,
    CanonicalMemory,
    CommandReceipt,
    ExtractedCandidate,
    ExtractionRun,
    GovernanceReceipt,
    MemoryContract,
    OwnerMemoryAuthority,
    ProjectionLease,
    ProviderHit,
    SourceInvalidationReceipt,
    SourceRecoveryClaim,
    SourceRecoveryReceipt,
    UserGovernance,
)


class MemoryGovernanceUnavailable(RuntimeError):
    def __init__(self, reason: str = "governance_unavailable") -> None:
        self.reason = reason
        super().__init__(reason)


class MemoryOwnerUndeclared(MemoryGovernanceUnavailable):
    """A definite answer: this owner has no declared durable authority.

    Distinct from its parent, which means "we could not find out". The store
    answered, the schema was current, and the owner is simply not enrolled —
    `authority_state` is `'unknown'`, or there is no governance row at all.

    This is NOT permission to use a legacy or ungoverned memory lane; an
    undeclared owner still has no memory access whatsoever. It exists so that
    ordinary, non-memory code paths can tell "not enrolled" (every user before
    activation, and every new signup after it) apart from "the store is down",
    and degrade to memory-features-off for the former while still failing
    closed for the latter.

    It subclasses MemoryGovernanceUnavailable deliberately: every existing
    `except MemoryGovernanceUnavailable` keeps failing closed unchanged, and
    only a caller that opts into the narrower type behaves differently.
    """

    def __init__(self, reason: str = "memory_owner_undeclared") -> None:
        super().__init__(reason)


class MemoryGovernanceConflict(RuntimeError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class MemoryGovernanceConfigurationError(RuntimeError):
    pass


class SupabaseMemoryGovernanceStore:
    def __init__(
        self,
        *,
        url: str | None = None,
        service_role_key: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self._url = (url or os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
        self._service_role_key = (service_role_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if not self._url or not self._service_role_key:
            raise MemoryGovernanceConfigurationError("memory_governance_store_not_configured")
        self._client = client or httpx.Client(timeout=10.0)

    def _headers(self, *, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._service_role_key}",
            "apikey": self._service_role_key,
        }
        if prefer:
            headers["Prefer"] = prefer
            headers["Content-Type"] = "application/json"
        return headers

    def _request(
        self,
        method: str,
        resource: str,
        *,
        params: dict[str, str] | None = None,
        json_body: object | None = None,
        prefer: str | None = None,
    ) -> Any:
        try:
            response = self._client.request(
                method,
                f"{self._url}/rest/v1/{resource}",
                headers=self._headers(prefer=prefer),
                params=params,
                json=json_body,
            )
        except httpx.HTTPError as exc:
            raise MemoryGovernanceUnavailable("governance_transport_error") from exc
        if response.status_code in {409, 412}:
            raise MemoryGovernanceConflict("governance_revision_conflict")
        if response.status_code >= 400:
            # Provider/database bodies can contain identifiers or echoed input.
            # Preserve only the status class in application-visible errors.
            reason = f"governance_http_{response.status_code // 100}xx"
            if response.status_code in {400, 422}:
                raise MemoryGovernanceConflict(reason)
            raise MemoryGovernanceUnavailable(reason)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise MemoryGovernanceUnavailable("governance_invalid_json") from exc

    def _rpc(self, name: str, payload: dict[str, object]) -> Any:
        return self._request("POST", f"rpc/{name}", json_body=payload, prefer="return=representation")

    @staticmethod
    def _model(model: type[Any], value: Any) -> Any:
        """Normalize PostgREST's composite-return shapes and discard DB-only fields."""

        if isinstance(value, list):
            if len(value) != 1 or not isinstance(value[0], dict):
                raise MemoryGovernanceUnavailable("governance_rpc_shape_invalid")
            value = value[0]
        if not isinstance(value, dict):
            raise MemoryGovernanceUnavailable("governance_rpc_shape_invalid")
        fields = model.model_fields
        return model.model_validate({key: value[key] for key in fields if key in value})

    def get_contract(self) -> MemoryContract:
        rows = self._request(
            "GET",
            "sophia_memory_contract",
            params={"select": "contract_epoch,schema_version,mode,updated_at", "singleton": "eq.true", "limit": "1"},
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise MemoryGovernanceUnavailable("memory_contract_unavailable")
        return MemoryContract.model_validate(rows[0])

    def get_owner_authority(self, user_id: str) -> OwnerMemoryAuthority:
        # Missing rows/columns and old schemas are unavailable, never legacy.
        rows = self._request("GET", "sophia_memory_user_governance", params={
            "select": "user_id,authority_state,authority_epoch,authority_declared_at",
            "user_id": f"eq.{user_id}", "limit": "2",
        })
        if not isinstance(rows, list):
            # A non-list body means the request itself did not answer the
            # question: an error shape, or an old schema missing a column.
            raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable")
        if not rows:
            # The query succeeded against the current schema and this owner has
            # no governance row. That is a definite "not enrolled", not a
            # failure to find out — and still not legacy.
            raise MemoryOwnerUndeclared("memory_owner_undeclared")
        if len(rows) != 1:
            raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable")
        result = OwnerMemoryAuthority.model_validate(rows[0])
        if result.user_id != user_id:
            raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable")
        return result

    def get_user_governance(self, user_id: str) -> UserGovernance:
        rows = self._request(
            "GET",
            "sophia_memory_user_governance",
            params={
                "select": "user_id,user_catalog_generation,user_revocation_epoch,provider_subject",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise MemoryGovernanceUnavailable("memory_user_governance_unavailable")
        return UserGovernance.model_validate(rows[0])

    def source_extraction_runs(self, *, user_id: str, session_id: str) -> tuple[ExtractionRun, ...]:
        """Complete bounded keyset scan; apply_source_target CAS-checks this set."""
        result=[]
        after=""
        for _ in range(128):
            params={"select":",".join(ExtractionRun.model_fields),"user_id":f"eq.{user_id}","session_id":f"eq.{session_id}",
                "state":"neq.superseded","order":"extraction_run_id.asc","limit":"200"}
            if after:
                params["extraction_run_id"]=f"gt.{after}"
            rows=self._request("GET","sophia_memory_extraction_runs",params=params)
            if not isinstance(rows,list) or len(rows)>200:
                raise MemoryGovernanceUnavailable("memory_source_runs_unavailable")
            if not rows:
                return tuple(result)
            for row in rows:
                run=self._model(ExtractionRun,row)
                if run.user_id!=user_id or run.session_id!=session_id or run.state=="superseded" or str(run.extraction_run_id)<=after:
                    raise MemoryGovernanceUnavailable("memory_source_runs_unavailable")
                result.append(run)
                after=str(run.extraction_run_id)
                if len(result)>10000:
                    raise MemoryGovernanceUnavailable("memory_source_runs_budget_exhausted")
        raise MemoryGovernanceUnavailable("memory_source_runs_budget_exhausted")

    def apply_source_target(self, **payload: object) -> ExtractionRun | None:
        row=self._rpc("sophia_memory_apply_source_target",payload)
        if (not isinstance(row,dict) or not row.get("event_id") or row.get("source_manifest_ref")!=payload.get("p_target_manifest_ref")):
            raise MemoryGovernanceUnavailable("memory_source_target_receipt_invalid")
        if row.get("run") is None:
            return None
        run=self._model(ExtractionRun,row["run"])
        if (run.user_id,run.session_id,run.thread_id)!=(payload["p_user_id"],payload["p_session_id"],payload["p_thread_id"]):
            raise MemoryGovernanceUnavailable("memory_source_target_receipt_invalid")
        return run

    def source_extraction_run(self, *, user_id: str, extraction_run_id: UUID) -> ExtractionRun:
        rows=self._request("GET","sophia_memory_extraction_runs",params={"select":",".join(ExtractionRun.model_fields),
            "user_id":f"eq.{user_id}","extraction_run_id":f"eq.{extraction_run_id}","limit":"2"})
        run=self._model(ExtractionRun,rows)
        if run.user_id!=user_id or run.extraction_run_id!=extraction_run_id:
            raise MemoryGovernanceUnavailable("memory_source_run_scope_invalid")
        return run

    def apply_source_target_at_epoch(self, **payload: object):
        from .source_snapshot import EpochSourceTargetReceipt

        try:
            result = EpochSourceTargetReceipt.model_validate(self._rpc("sophia_memory_apply_source_target_at_epoch", payload))
            if (result.source_snapshot.model_dump(mode="json", by_alias=True) != payload["p_source_snapshot"]
                or result.source_manifest_ref != payload["p_target_manifest_ref"]
                or result.memory_clear_epoch != payload["p_expected_clear_epoch"]
                or (result.source_snapshot.owner_id, result.source_snapshot.session_id, result.source_snapshot.thread_id,
                    result.source_snapshot.transcript_revision) != (payload["p_user_id"], payload["p_session_id"], payload["p_thread_id"], payload["p_transcript_revision"])):
                raise ValueError("scope")
            return result
        except Exception:
            raise MemoryGovernanceUnavailable("memory_epoch_source_target_unavailable") from None

    def authorize_extraction_dispatch(self, **payload: object):
        return self._rpc("sophia_memory_authorize_extraction_dispatch", payload)

    def register_builder_handoff(self, **payload: object):
        return self._rpc("sophia_memory_register_builder_handoff", payload)

    def get_builder_handoff(self, **payload: object):
        return self._rpc("sophia_memory_get_builder_handoff", payload)

    def bind_builder_source_run(self, **payload: object):
        return self._rpc("sophia_memory_bind_builder_source_run", payload)

    def get_builder_source_run(self, **payload: object):
        return self._rpc("sophia_memory_get_builder_source_run", payload)

    def get_builder_source_run_for_handoff(self, **payload: object):
        return self._rpc("sophia_memory_get_builder_source_run_for_handoff", payload)

    def authorize_model_dispatch(self, **payload: object):
        return self._rpc("sophia_memory_authorize_model_dispatch", payload)

    def check_model_source_use(self, **payload: object):
        return self._rpc("sophia_memory_check_source_use", payload)

    def authorize_legacy_model_dispatch(self, **payload: object):
        return self._rpc("sophia_memory_authorize_legacy_model_dispatch", payload)

    def get_model_result(self, **payload: object):
        return self._rpc("sophia_memory_get_model_result", payload)

    def record_model_result(self, **payload: object):
        return self._rpc("sophia_memory_record_model_result", payload)

    def claim_source_recovery(self, *, user_id: str, lease_owner: str) -> SourceRecoveryClaim | None:
        raw = self._rpc("sophia_memory_claim_source_recovery", {"p_user_id": user_id, "p_lease_owner": lease_owner})
        if raw is None:
            return None
        try:
            claim = SourceRecoveryClaim.model_validate(raw)
            if (claim.user_id, claim.lease_owner) != (user_id, lease_owner) or claim.lease_expires_at <= datetime.now(UTC):
                raise ValueError
            return claim
        except Exception:
            raise MemoryGovernanceUnavailable("memory_recovery_claim_invalid") from None

    def complete_source_recovery(self, claim: SourceRecoveryClaim, *, outcome: str) -> SourceRecoveryReceipt:
        raw = self._rpc("sophia_memory_complete_source_recovery", {
            "p_user_id": claim.user_id, "p_session_id": claim.session_id, "p_sweep_id": str(claim.sweep_id),
            "p_lease_token": str(claim.lease_token), "p_lease_owner": claim.lease_owner, "p_outcome": outcome,
        })
        try:
            receipt = SourceRecoveryReceipt.model_validate(raw)
            if receipt.extraction_complete or (receipt.user_id, receipt.session_id, receipt.sweep_id, receipt.lease_token, receipt.outcome) != (
                claim.user_id, claim.session_id, claim.sweep_id, claim.lease_token, outcome,
            ):
                raise ValueError
            return receipt
        except Exception:
            raise MemoryGovernanceUnavailable("memory_recovery_receipt_invalid") from None

    def enqueue_extraction(self, **payload: object) -> ExtractionRun:
        row = self._rpc("sophia_memory_enqueue_extraction", payload)
        return self._model(ExtractionRun, row)

    def finalize_and_enqueue_extraction(self, **payload: object) -> ExtractionRun:
        row = self._rpc("sophia_memory_finalize_and_enqueue_extraction", payload)
        return self._model(ExtractionRun, row)

    def finalize_processed_session(self, *, session: SessionRecord, ended_at: str) -> None:
        """CAS-finalize a snapshot with no unprocessed visible messages.

        The extraction service reads the record before its transcript. A
        concurrent transcript replacement increments message_revision; progress
        and lifecycle changes are fenced independently. A miss is never success.
        New ranges still use the existing atomic finalization/enqueue RPC.
        """
        from deerflow.sophia.session_store import _to_db_status

        if session.status not in {"active", "open", "paused", "resumable", "ended"}:
            raise MemoryGovernanceConflict("memory_session_state_conflict")
        terminal_at = session.ended_at or ended_at
        rows = self._request(
            "PATCH",
            "sophia_sessions",
            params={
                "id": f"eq.{session.session_id}",
                "user_id": f"eq.{session.user_id}",
                "thread_id": f"eq.{session.thread_id}",
                "message_revision": f"eq.{session.message_revision}",
                "memory_processed_until_sequence": f"eq.{session.memory_processed_until_sequence}",
                "status": f"eq.{_to_db_status(session.status)}",
                "select": "id,status,ended_at",
            },
            json_body={"status": "ended", "ended_at": terminal_at, "updated_at": datetime.now(UTC).isoformat()},
            prefer="return=representation",
        )
        try:
            valid = (
                isinstance(rows, list)
                and len(rows) == 1
                and rows[0]["id"] == session.session_id
                and rows[0]["status"] == "ended"
                and datetime.fromisoformat(rows[0]["ended_at"]) == datetime.fromisoformat(terminal_at)
            )
        except (KeyError, TypeError, ValueError):
            valid = False
        if not valid:
            raise MemoryGovernanceConflict("memory_session_finalization_conflict")

    def claim_extraction(self, *, lease_owner: str, lease_seconds: int = 120) -> ExtractionRun | None:
        rows = self._rpc(
            "sophia_memory_claim_extraction",
            {"p_lease_owner": lease_owner, "p_lease_seconds": lease_seconds},
        )
        if not isinstance(rows, list) or not rows:
            return None
        return self._model(ExtractionRun, rows[0])

    def complete_extraction(
        self,
        run: ExtractionRun,
        *,
        input_manifest_ref: str,
        candidates: Iterable[ExtractedCandidate],
    ) -> ExtractionRun:
        if run.lease_token is None:
            raise MemoryGovernanceConflict("memory_extraction_lease_missing")
        payload = {
            "p_user_id": run.user_id,
            "p_extraction_run_id": str(run.extraction_run_id),
            "p_lease_token": str(run.lease_token),
            "p_input_manifest_ref": input_manifest_ref,
            "p_candidates": [candidate.model_dump(mode="json") for candidate in candidates],
        }
        return self._model(ExtractionRun, self._rpc("sophia_memory_complete_extraction", payload))

    def fail_extraction(
        self,
        run: ExtractionRun,
        *,
        error_code: str,
        retryable: bool = True,
    ) -> ExtractionRun:
        if run.lease_token is None:
            raise MemoryGovernanceConflict("memory_extraction_lease_missing")
        return self._model(
            ExtractionRun,
            self._rpc(
                "sophia_memory_fail_extraction",
                {
                    "p_user_id": run.user_id,
                    "p_extraction_run_id": str(run.extraction_run_id),
                    "p_lease_token": str(run.lease_token),
                    "p_error_code": error_code,
                    "p_retryable": retryable,
                },
            ),
        )

    def expire_candidates(self, *, limit: int = 500) -> int:
        # The C1 dependency-authority migration revoked the original
        # ``sophia_memory_expire_candidates`` from ``service_role`` and granted
        # this governed, source-aware replacement. That migration IS applied in
        # production, so the revoked function fails closed with 42501 on every
        # call; retention must use the governed RPC.
        result = self._rpc("sophia_memory_expire_governed_candidates", {"p_limit": limit})
        if isinstance(result, list) and len(result) == 1:
            result = result[0]
        if not isinstance(result, int):
            raise MemoryGovernanceUnavailable("candidate_expiry_result_invalid")
        return result

    def arm_fault(
        self,
        *,
        user_id: str,
        mode: str,
        ttl_seconds: int,
        audit_ref: str,
    ) -> dict[str, Any]:
        result = self._rpc(
            "sophia_memory_arm_fault",
            {
                "p_user_id": user_id,
                "p_mode": mode,
                "p_ttl_seconds": ttl_seconds,
                "p_audit_ref": audit_ref,
            },
        )
        if not isinstance(result, dict):
            raise MemoryGovernanceUnavailable("memory_fault_arm_result_invalid")
        return result

    def consume_fault(self, *, user_id: str, mode: str) -> bool:
        result = self._rpc(
            "sophia_memory_consume_fault",
            {"p_user_id": user_id, "p_mode": mode},
        )
        if not isinstance(result, bool):
            raise MemoryGovernanceUnavailable("memory_fault_consume_result_invalid")
        return result

    def clear_faults(self, *, user_id: str) -> int:
        result = self._rpc("sophia_memory_clear_faults", {"p_user_id": user_id})
        if not isinstance(result, int):
            raise MemoryGovernanceUnavailable("memory_fault_clear_result_invalid")
        return result

    def expire_projection_lease(self, lease: ProjectionLease) -> bool:
        if lease.lease_token is None:
            raise MemoryGovernanceConflict("memory_projection_lease_missing")
        result = self._rpc(
            "sophia_memory_expire_projection_lease",
            {
                "p_user_id": lease.user_id,
                "p_projection_job_id": str(lease.projection_job_id),
                "p_lease_token": str(lease.lease_token),
            },
        )
        if not isinstance(result, bool):
            raise MemoryGovernanceUnavailable("memory_projection_lease_expiry_result_invalid")
        return result

    def invalidate_source(self, **payload: object) -> SourceInvalidationReceipt:
        return self._model(
            SourceInvalidationReceipt,
            self._rpc("sophia_memory_invalidate_source", payload),
        )

    def list_candidates(
        self,
        *,
        user_id: str,
        session_id: str | None = None,
        state: str = "pending_review",
        limit: int = 200,
    ) -> tuple[CandidateRecord, ...]:
        params = {
            "select": "candidate_id,user_id,extraction_run_id,stable_ordinal,current_candidate_revision,review_state,canonical_memory_id,created_at",
            "user_id": f"eq.{user_id}",
            "review_state": f"eq.{state}",
            "order": "created_at.asc",
            "limit": str(min(max(limit, 1), 500)),
        }
        candidates = self._request("GET", "sophia_memory_candidates", params=params)
        rows = candidates if isinstance(candidates, list) else []
        if session_id is not None:
            source_rows = self._request(
                "GET",
                "sophia_memory_candidate_sources",
                params={"select": "candidate_id", "user_id": f"eq.{user_id}", "session_id": f"eq.{session_id}", "limit": "500"},
            )
            allowed = {str(row.get("candidate_id")) for row in (source_rows if isinstance(source_rows, list) else []) if isinstance(row, dict)}
            rows = [row for row in rows if str(row.get("candidate_id")) in allowed]
        ids = [str(row["candidate_id"]) for row in rows if isinstance(row, dict) and row.get("candidate_id")]
        versions = (
            self._request(
                "GET",
                "sophia_memory_candidate_versions",
                params={"select": "candidate_id,candidate_revision,proposed_content,content_ref,category,proposed_tier", "user_id": f"eq.{user_id}", "limit": "500"},
            )
            if ids
            else []
        )
        version_map = {(str(item.get("candidate_id")), int(item.get("candidate_revision") or 0)): item for item in (versions if isinstance(versions, list) else []) if isinstance(item, dict)}
        result: list[CandidateRecord] = []
        for row in rows:
            revision = int(row.get("current_candidate_revision") or 0)
            current = version_map.get((str(row.get("candidate_id")), revision), {})
            result.append(
                CandidateRecord.model_validate(
                    {
                        **row,
                        **{
                            "content": current.get("proposed_content"),
                            "content_ref": current.get("content_ref"),
                            "category": current.get("category"),
                            "proposed_tier": current.get("proposed_tier"),
                        },
                    }
                )
            )
        return tuple(result)

    def current_memory(self, *, user_id: str, memory_id: UUID):
        import json

        from .command_result import CurrentMemoryView

        raw = self._rpc("sophia_memory_current_view", {"p_user_id": user_id, "p_memory_id": str(memory_id)})
        try:
            if (not isinstance(raw, dict) or raw.get("provider_state_queried") is not False or raw.get("current_view_only") is not True
                    or len(json.dumps(raw).encode()) > 2 * 1024 * 1024):
                raise ValueError
            view = CurrentMemoryView.model_validate(raw)
            if view.owner_id != user_id or view.memory_id != memory_id:
                raise ValueError
            return view
        except Exception:
            raise MemoryGovernanceUnavailable("memory_current_view_unavailable") from None

    def source_boundary(self, *, user_id: str, session_id: str, thread_id: str):
        return self._rpc("sophia_memory_source_boundary", {"p_user_id": user_id, "p_session_id": session_id, "p_thread_id": thread_id})

    def accept_source_action(self, **payload):
        return self._rpc("sophia_memory_accept_source_action", payload)

    def source_action_status(self, *, user_id: str, command_key: str):
        return self._rpc("sophia_memory_lookup_source_action", {"p_user_id": user_id, "p_idempotency_key": command_key})

    def source_snapshot(self, *, user_id: str, session_id: str, thread_id: str):
        return self._rpc("sophia_memory_source_snapshot", {"p_user_id": user_id, "p_session_id": session_id, "p_thread_id": thread_id})

    def review_snapshot(self, payload: dict[str, object]) -> dict:
        result = self._rpc("sophia_memory_review_snapshot", payload)
        if not isinstance(result, dict):
            raise MemoryGovernanceUnavailable("memory_review_snapshot_invalid")
        return result

    def inventory_snapshot(self, payload: dict[str, object]) -> dict:
        result = self._rpc("sophia_memory_inventory_snapshot", payload)
        if not isinstance(result, dict):
            raise MemoryGovernanceUnavailable("memory_inventory_unavailable")
        return result

    def command_receipt(self, *, user_id: str, idempotency_key: str) -> CommandReceipt | None:
        raw = self._rpc("sophia_memory_lookup_command_receipt", {
            "p_user_id": user_id, "p_idempotency_key": idempotency_key})
        try:
            import json

            if (not isinstance(raw, dict) or set(raw) != {"schema", "owner_id", "command_key", "status", "historical_result_only", "receipt"}
                    or raw["schema"] != "mem00.command-status.v1" or raw["owner_id"] != user_id
                    or raw["command_key"] != idempotency_key or raw["historical_result_only"] is not True
                    or len(json.dumps(raw).encode()) > 65536):
                raise ValueError
            if raw["status"] == "not_found" and raw["receipt"] is None:
                return None
            if raw["status"] != "committed" or not isinstance(raw["receipt"], dict) or raw["receipt"].get("idempotent_replay") is not True:
                raise ValueError
            return CommandReceipt.model_validate(raw["receipt"])
        except Exception:
            raise MemoryGovernanceUnavailable("memory_command_receipt_unavailable") from None

    def approve_candidate(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_approve_candidate", payload))

    def reject_candidate(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_reject_candidate", payload))

    def manual_create(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_manual_create", payload))

    def edit(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_edit", payload))

    def forget(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_forget", payload))

    def restore(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_restore", payload))

    def tombstone(self, **payload: object) -> GovernanceReceipt:
        return self._model(GovernanceReceipt, self._rpc("sophia_memory_tombstone", payload))

    def pool_snapshot(self, *, user_id: str, include_forgotten: bool = False):
        from .inventory import read_complete_inventory

        try:
            return read_complete_inventory(owner_id=user_id, governance_store=self,
                view="saved" if include_forgotten else "active")
        except MemoryGovernanceConflict:
            raise MemoryGovernanceUnavailable("memory_inventory_snapshot_changed") from None

    def list_pool(self, *, user_id: str, include_forgotten: bool = False) -> tuple[CanonicalMemory, ...]:
        # Management snapshot only, not provider-hit authorization or model admission.
        snapshot = self.pool_snapshot(user_id=user_id, include_forgotten=include_forgotten)
        return tuple(CanonicalMemory(memory_id=item.id, user_id=user_id, lifecycle=item.state,
            user_tier=item.user_tier, current_content_revision=item.revision,
            memory_governance_revision=item.memory_governance_revision, canonical_content=item.content,
            category=item.category, scope=item.scope, projection_state="unavailable",
            created_at=item.created_at, updated_at=item.updated_at) for item in snapshot.records)

    def authorize_provider_hits(
        self, *, user_id: str, provider: str, environment: str, provider_project: str,
        provider_namespace: str, hits: Iterable[ProviderHit],
    ) -> tuple[tuple[CanonicalMemory, float | None], dict[str, int]]:
        """Exact one-snapshot resolution; final atomic prompt admission is still required."""
        import json
        import math

        hit_map = {}
        for hit in hits:
            if (not isinstance(hit.provider_memory_id, str) or not 1 <= len(hit.provider_memory_id) <= 512
                    or hit.provider_memory_id != hit.provider_memory_id.strip()
                    or (hit.score is not None and not math.isfinite(hit.score))):
                raise MemoryGovernanceUnavailable("memory_hit_selector_invalid")
            hit_map.setdefault(hit.provider_memory_id, hit.score)
            if len(hit_map) > 100:
                raise MemoryGovernanceUnavailable("memory_hit_selector_invalid")
        if not hit_map:
            return (), {}
        raw = self._rpc("sophia_memory_resolve_provider_hits", {
            "p_user_id": user_id, "p_provider": provider, "p_environment": environment,
            "p_provider_project": provider_project, "p_provider_namespace": provider_namespace,
            "p_provider_memory_ids": list(hit_map)})
        try:
            expected = {"schema": "mem00.hit-resolution.v1", "memory_contract_epoch": 1, "owner_id": user_id,
                "provider": provider, "environment": environment, "provider_project": provider_project,
                "provider_namespace": provider_namespace, "status": "available", "final_admission": False}
            if (len(json.dumps(raw).encode()) > 2 * 1024 * 1024
                    or not isinstance(raw, dict) or set(raw) != set(expected) | {"results"}
                    or any(raw.get(key) != value for key, value in expected.items())
                    or type(raw["memory_contract_epoch"]) is not int or raw["final_admission"] is not False
                    or not isinstance(raw["results"], list) or len(raw["results"]) != len(hit_map)):
                raise ValueError
            authorized, denials, seen_memories = [], {}, {}
            reasons = {"unmapped_provider_id", "inactive_projection", "stale_content_revision",
                "stale_memory_governance_revision", "unknown_status"}
            for provider_id, row in zip(hit_map, raw["results"], strict=True):
                if not isinstance(row, dict) or set(row) != {"provider_memory_id", "denial_reason", "memory"} or row["provider_memory_id"] != provider_id:
                    raise ValueError
                reason = row["denial_reason"]
                if reason is not None:
                    if reason not in reasons or row["memory"] is not None:
                        raise ValueError
                    denials[reason] = denials.get(reason, 0) + 1
                    continue
                item = row["memory"]
                if (not isinstance(item, dict) or item.get("user_id") != user_id or item.get("lifecycle") != "active"
                        or type(item.get("current_content_revision")) is not int or type(item.get("memory_governance_revision")) is not int
                        or item.get("projection_state") != "active" or not item.get("canonical_content") or not item.get("content_ref")
                        or not item.get("category") or not item.get("scope")):
                    raise ValueError
                memory = CanonicalMemory.model_validate(item)
                if memory.memory_id in seen_memories:
                    if seen_memories[memory.memory_id] != memory:
                        raise ValueError
                    # Input order is provider rank. Keep its first/best-ranked
                    # hit, not a second memory or a fabricated combined score.
                    continue
                seen_memories[memory.memory_id] = memory
                authorized.append((memory, hit_map[provider_id]))
            return tuple(authorized), denials
        except Exception:
            raise MemoryGovernanceUnavailable("memory_hit_resolution_unavailable") from None

    def hydrate_inclusions(self, *, user_id: str, inclusions: tuple, scope: str) -> tuple[AuthorizedMemory, ...]:
        """Hydrate exact current revisions, never a truncated owner-wide Pool.

        This read is NOT prompt admission. The caller must subsequently use
        record_prompt_admission to fence races, tombstones and provider bindings.
        Missing/duplicate/extra rows invalidate the whole retained context.
        """
        from .models import AuthorizedMemory
        from .retained_context import RetainedMemoryContext, encode_context_manifest

        # Reuse the strict structural validator before constructing any filter.
        encode_context_manifest(RetainedMemoryContext("validation-only", 0, inclusions))
        if not isinstance(user_id, str) or not user_id.strip() or not isinstance(scope, str) or not scope:
            raise MemoryGovernanceUnavailable("retained_context_selector_invalid")
        if not inclusions:
            return ()
        expected = {str(item.memory_id): item for item in inclusions}
        rows = self._request("GET", "sophia_memories", params={
            "select": "memory_id,user_id,lifecycle,current_content_revision,memory_governance_revision",
            "user_id": f"eq.{user_id}", "memory_id": "in.(" + ",".join(expected) + ")",
            "limit": str(len(expected) + 1),
        })
        fields = {"memory_id", "user_id", "lifecycle", "current_content_revision", "memory_governance_revision"}
        if not isinstance(rows, list) or len(rows) != len(expected):
            raise MemoryGovernanceUnavailable("retained_context_incomplete")
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != fields:
                raise MemoryGovernanceUnavailable("retained_context_row_invalid")
            item = expected.get(row["memory_id"])
            if item is None or row["memory_id"] in seen or row["user_id"] != user_id or row["lifecycle"] != "active":
                raise MemoryGovernanceUnavailable("retained_context_ineligible")
            if (type(row["current_content_revision"]) is not int or type(row["memory_governance_revision"]) is not int
                    or row["current_content_revision"] != item.content_revision or row["memory_governance_revision"] != item.governance_revision):
                raise MemoryGovernanceUnavailable("retained_context_revision_changed")
            seen.add(row["memory_id"])
        versions = self._request("GET", "sophia_memory_versions", params={
            "select": "memory_id,user_id,content_revision,canonical_content,content_ref,category,scope",
            "user_id": f"eq.{user_id}",
            "or": "(" + ",".join(f"and(memory_id.eq.{item.memory_id},content_revision.eq.{item.content_revision})" for item in inclusions) + ")",
            "limit": str(len(expected) + 1),
        })
        fields = {"memory_id", "user_id", "content_revision", "canonical_content", "content_ref", "category", "scope"}
        if not isinstance(versions, list) or len(versions) != len(expected):
            raise MemoryGovernanceUnavailable("retained_context_versions_incomplete")
        hydrated = {}
        for row in versions:
            if not isinstance(row, dict) or set(row) != fields:
                raise MemoryGovernanceUnavailable("retained_context_version_invalid")
            item = expected.get(row["memory_id"])
            if (item is None or row["memory_id"] in hydrated or row["user_id"] != user_id
                    or type(row["content_revision"]) is not int or row["content_revision"] != item.content_revision
                    or row["scope"] not in {scope, "global"}
                    or not isinstance(row["canonical_content"], str) or not row["canonical_content"]
                    or not isinstance(row["content_ref"], str) or not row["content_ref"]):
                raise MemoryGovernanceUnavailable("retained_context_version_ineligible")
            hydrated[row["memory_id"]] = AuthorizedMemory(
                memory_id=item.memory_id, content_revision=item.content_revision,
                memory_governance_revision=item.governance_revision,
                canonical_content=row["canonical_content"], category=row["category"], scope=row["scope"], score=None,
            )
        return tuple(hydrated[str(item.memory_id)] for item in inclusions)

    def record_prompt_admission(self, payload: dict[str, object]) -> UUID:
        result = self._rpc(
            "sophia_memory_record_prompt_admission",
            {
                "p_retrieval_request_id": payload["retrieval_request_id"],
                "p_user_id": payload["user_id"],
                "p_caller": payload["caller"],
                "p_scope": payload["scope"],
                "p_query_ref": payload["query_ref"],
                "p_provider": payload["provider"],
                "p_environment": payload["environment"],
                "p_provider_project": payload["provider_project"],
                "p_provider_namespace": payload["provider_namespace"],
                "p_provider_status": payload["provider_status"],
                "p_provider_hit_count": payload["provider_hit_count"],
                "p_catalog_generation_checked": payload["catalog_generation_checked"],
                "p_revocation_epoch_checked": payload["revocation_epoch_checked"],
                "p_authorized_manifest": payload["authorized_manifest"],
                "p_denial_counts": payload["denial_counts"],
                "p_outcome": payload["outcome"],
                "p_safe_reason_code": payload["safe_reason_code"],
                "p_latency_segments": payload["latency_segments"],
            },
        )
        if not isinstance(result, str):
            raise MemoryGovernanceUnavailable("prompt_admission_receipt_unavailable")
        return UUID(result)

    def claim_projection(self, *, lease_owner: str, lease_seconds: int = 120) -> ProjectionLease | None:
        rows = self._rpc("sophia_memory_claim_projection", {"p_lease_owner": lease_owner, "p_lease_seconds": lease_seconds})
        if not isinstance(rows, list) or not rows:
            return None
        return self._model(ProjectionLease, rows[0])

    def projection_binding_ids(self, lease: ProjectionLease) -> tuple[str, ...]:
        rows = self._request(
            "GET",
            "sophia_memory_provider_bindings",
            params={
                "select": "provider_memory_id",
                "user_id": f"eq.{lease.user_id}",
                "memory_id": f"eq.{lease.memory_id}",
                "provider": f"eq.{lease.provider}",
                "environment": f"eq.{lease.environment}",
                "provider_project": f"eq.{lease.provider_project}",
                "provider_namespace": f"eq.{lease.provider_namespace}",
                "binding_state": "neq.purged",
                "limit": "1000",
            },
        )
        return tuple(str(row["provider_memory_id"]) for row in (rows if isinstance(rows, list) else []) if isinstance(row, dict) and row.get("provider_memory_id"))

    def complete_projection(self, payload: dict[str, object]) -> dict[str, Any]:
        result = self._rpc("sophia_memory_complete_projection", payload)
        if not isinstance(result, dict):
            raise MemoryGovernanceUnavailable("projection_completion_invalid")
        return result


_STORE: SupabaseMemoryGovernanceStore | None = None
_STORE_LOCK = threading.Lock()


GOVERNANCE_ABSENT_ENV = "SOPHIA_MEMORY_GOVERNANCE_ABSENT"
_DEPLOYMENT_MARKERS = ("RENDER", "RENDER_SERVICE_ID", "RENDER_GIT_COMMIT", "VERCEL", "RAILWAY_ENVIRONMENT")
_DEPLOYED_ENV_NAMES = {"prod", "production", "staging", "stage"}


def memory_governance_deliberately_absent(environ=None) -> bool:
    """True only where an operator has DECLARED that MEM00 is not installed.

    An earlier version of this predicate answered from the absence of
    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. That was wrong in the direction
    that loses data integrity: missing credentials prove a missing *setting*,
    not the absence of durable governance records. A deploy that drops one of
    those variables would have silently selected all-off behaviour over a
    database still full of canonical rows -- skipping source invalidation on
    delete and serving recaps that were never bound to a canonical revision.

    So the answer now requires a positive declaration, and refuses it anywhere
    that looks like a deployment even if the declaration is present. It is for
    a local checkout or an isolated test runner and nothing else.
    """
    source = os.environ if environ is None else environ
    if (source.get(GOVERNANCE_ABSENT_ENV) or "").strip().lower() not in {"1", "true", "yes", "on"}:
        return False
    if any((source.get(name) or "").strip() for name in _DEPLOYMENT_MARKERS):
        return False
    named = (source.get("SOPHIA_ENV") or source.get("APP_ENV") or source.get("ENVIRONMENT") or "").strip().lower()
    return named not in _DEPLOYED_ENV_NAMES


def configured_memory_store() -> SupabaseMemoryGovernanceStore:
    global _STORE
    if _STORE is not None:
        return _STORE
    with _STORE_LOCK:
        if _STORE is None:
            _STORE = SupabaseMemoryGovernanceStore()
    return _STORE


def reset_memory_store_for_test() -> None:
    global _STORE
    with _STORE_LOCK:
        _STORE = None
