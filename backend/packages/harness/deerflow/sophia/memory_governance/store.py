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

from .models import (
    CandidateRecord,
    CanonicalMemory,
    ExtractedCandidate,
    ExtractionRun,
    GovernanceReceipt,
    MemoryContract,
    ProjectionLease,
    ProviderHit,
    SourceInvalidationReceipt,
    UserGovernance,
)


class MemoryGovernanceUnavailable(RuntimeError):
    def __init__(self, reason: str = "governance_unavailable") -> None:
        self.reason = reason
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
        result = self._rpc("sophia_memory_expire_candidates", {"p_limit": limit})
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

    def list_pool(
        self,
        *,
        user_id: str,
        include_forgotten: bool = False,
        limit: int = 500,
    ) -> tuple[CanonicalMemory, ...]:
        lifecycles = "in.(active,forgotten)" if include_forgotten else "eq.active"
        rows = self._request(
            "GET",
            "sophia_memories",
            params={
                "select": "memory_id,user_id,lifecycle,user_tier,current_content_revision,memory_governance_revision,created_at,updated_at",
                "user_id": f"eq.{user_id}",
                "lifecycle": lifecycles,
                "order": "updated_at.desc",
                "limit": str(min(max(limit, 1), 500)),
            },
        )
        base_rows = rows if isinstance(rows, list) else []
        versions = (
            self._request(
                "GET",
                "sophia_memory_versions",
                params={"select": "memory_id,content_revision,canonical_content,content_ref,category,scope", "user_id": f"eq.{user_id}", "limit": "1000"},
            )
            if base_rows
            else []
        )
        version_map = {(str(item.get("memory_id")), int(item.get("content_revision") or 0)): item for item in (versions if isinstance(versions, list) else []) if isinstance(item, dict)}
        bindings = (
            self._request(
                "GET",
                "sophia_memory_provider_bindings",
                params={"select": "memory_id,binding_state", "user_id": f"eq.{user_id}", "limit": "1000"},
            )
            if base_rows
            else []
        )
        binding_states: dict[str, set[str]] = {}
        for item in bindings if isinstance(bindings, list) else []:
            if isinstance(item, dict):
                binding_states.setdefault(str(item.get("memory_id")), set()).add(str(item.get("binding_state")))
        result: list[CanonicalMemory] = []
        for row in base_rows:
            key = (str(row.get("memory_id")), int(row.get("current_content_revision") or 0))
            version = version_map.get(key, {})
            states = binding_states.get(key[0], set())
            projection_state = "active" if "eligible" in states else ("stale" if states else "absent")
            result.append(CanonicalMemory.model_validate({**row, **version, "projection_state": projection_state}))
        return tuple(result)

    def authorize_provider_hits(
        self,
        *,
        user_id: str,
        provider: str,
        environment: str,
        provider_project: str,
        provider_namespace: str,
        hits: Iterable[ProviderHit],
    ) -> tuple[tuple[CanonicalMemory, float | None], dict[str, int]]:
        hit_map = {hit.provider_memory_id: hit.score for hit in hits}
        denials: dict[str, int] = {}
        if not hit_map:
            return (), denials
        rows = self._request(
            "GET",
            "sophia_memory_provider_bindings",
            params={
                "select": "provider_memory_id,memory_id,canonical_content_revision,memory_governance_revision,binding_state,metadata_verification_state",
                "user_id": f"eq.{user_id}",
                "provider": f"eq.{provider}",
                "environment": f"eq.{environment}",
                "provider_project": f"eq.{provider_project}",
                "provider_namespace": f"eq.{provider_namespace}",
                "limit": "1000",
            },
        )
        candidates = [row for row in (rows if isinstance(rows, list) else []) if isinstance(row, dict) and str(row.get("provider_memory_id")) in hit_map]
        by_provider: dict[str, list[dict[str, Any]]] = {}
        for row in candidates:
            by_provider.setdefault(str(row["provider_memory_id"]), []).append(row)
        eligible_bindings: list[dict[str, Any]] = []
        for provider_id in hit_map:
            matched = by_provider.get(provider_id, [])
            if not matched:
                denials["unmapped_provider_id"] = denials.get("unmapped_provider_id", 0) + 1
            elif len(matched) != 1:
                denials["inactive_projection"] = denials.get("inactive_projection", 0) + 1
            elif matched[0].get("binding_state") != "eligible" or matched[0].get("metadata_verification_state") != "verified":
                denials["inactive_projection"] = denials.get("inactive_projection", 0) + 1
            else:
                eligible_bindings.append(matched[0])
        memories = {memory.memory_id: memory for memory in self.list_pool(user_id=user_id)}
        authorized: list[tuple[CanonicalMemory, float | None]] = []
        for binding in eligible_bindings:
            memory = memories.get(UUID(str(binding["memory_id"])))
            if memory is None or memory.lifecycle != "active":
                denials["inactive_projection"] = denials.get("inactive_projection", 0) + 1
                continue
            if memory.current_content_revision != int(binding["canonical_content_revision"]):
                denials["stale_content_revision"] = denials.get("stale_content_revision", 0) + 1
                continue
            if memory.memory_governance_revision != int(binding["memory_governance_revision"]):
                denials["stale_memory_governance_revision"] = denials.get("stale_memory_governance_revision", 0) + 1
                continue
            if not memory.canonical_content:
                denials["unknown_status"] = denials.get("unknown_status", 0) + 1
                continue
            authorized.append((memory, hit_map[str(binding["provider_memory_id"])]))
        return tuple(authorized), denials

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
