"""At-least-once desired-state projection claimant with tombstone fencing."""

from __future__ import annotations

from .mem0_projection_adapter import Mem0ContractError, Mem0ProjectionAdapter
from .models import ProjectionLease
from .observability import emit_memory_event
from .refs import keyed_ref
from .store import (
    MemoryGovernanceConflict,
    MemoryGovernanceUnavailable,
    SupabaseMemoryGovernanceStore,
)


class MemoryProjectionReconciler:
    def __init__(
        self,
        *,
        store: SupabaseMemoryGovernanceStore,
        adapter: Mem0ProjectionAdapter,
        lease_owner: str,
        service_name: str,
    ) -> None:
        self.store = store
        self.adapter = adapter
        self.lease_owner = lease_owner
        self.service_name = service_name

    def _assert_supported_contract(self) -> None:
        contract = self.store.get_contract()
        if contract.contract_epoch != 1 or contract.schema_version != "mem00.v1" or contract.mode not in {"shadow", "enforced"}:
            raise MemoryGovernanceUnavailable("memory_contract_not_active")

    @staticmethod
    def _metadata(lease: ProjectionLease) -> dict[str, object]:
        return {
            "sophia_managed": True,
            "memory_contract_epoch": 1,
            "environment": lease.environment,
            "provider_namespace": lease.provider_namespace,
            "canonical_memory_id": str(lease.memory_id),
            "canonical_revision": lease.desired_content_revision,
            "memory_governance_revision": lease.desired_governance_revision,
            "projection_operation_id": lease.projection_operation_id,
        }

    def _complete(
        self,
        lease: ProjectionLease,
        *,
        state: str,
        provider_ids: tuple[str, ...] = (),
        metadata_verified: bool = False,
        result_class: str,
        error_class: str | None = None,
        reason: str,
    ) -> dict[str, object]:
        return self.store.complete_projection(
            {
                "p_user_id": lease.user_id,
                "p_projection_job_id": str(lease.projection_job_id),
                "p_lease_token": str(lease.lease_token),
                "p_result_state": state,
                "p_provider_ids": list(provider_ids),
                "p_metadata_verified": metadata_verified,
                "p_provider_result_class": result_class,
                "p_provider_error_class": error_class,
                "p_safe_reason_code": reason,
            }
        )

    def run_once(self) -> bool:
        self._assert_supported_contract()
        lease = self.store.claim_projection(lease_owner=self.lease_owner)
        if lease is None:
            return False
        try:
            if lease.operation == "purge_binding":
                provider_ids = self.store.projection_binding_ids(lease)
                if provider_ids:
                    self.adapter.delete_ids(
                        provider_ids,
                        provider_subject=lease.provider_namespace,
                    )
                self._complete(
                    lease,
                    state="purged",
                    provider_ids=provider_ids,
                    metadata_verified=True,
                    result_class="purge_verified",
                    reason="provider_rows_absent",
                )
            elif lease.operation == "project_revision":
                if not lease.canonical_content:
                    self._complete(
                        lease,
                        state="stale",
                        result_class="canonical_state_changed",
                        reason="canonical_state_changed_before_call",
                    )
                else:
                    metadata = self._metadata(lease)
                    existing = self.adapter.find_by_operation_marker(
                        provider_subject=lease.provider_namespace,
                        projection_operation_id=lease.projection_operation_id,
                        expected_metadata=metadata,
                    )
                    if existing:
                        provider_ids = existing
                        result_class = "ambiguous_reconciled"
                    else:
                        result = self.adapter.project_revision(
                            canonical_content=lease.canonical_content,
                            provider_subject=lease.provider_namespace,
                            metadata=metadata,
                        )
                        provider_ids = result.provider_ids
                        result_class = "direct_write_verified"
                    self._complete(
                        lease,
                        state="active",
                        provider_ids=provider_ids,
                        metadata_verified=True,
                        result_class=result_class,
                        reason="provider_metadata_verified",
                    )
            else:
                self._complete(
                    lease,
                    state="failed_terminal",
                    result_class="unsupported_operation",
                    reason="projection_operation_unsupported",
                )
        except Mem0ContractError as exc:
            state = "ambiguous" if exc.ambiguous_effect else ("failed_retryable" if exc.retryable else "failed_terminal")
            try:
                self._complete(
                    lease,
                    state=state,
                    provider_ids=exc.provider_ids,
                    result_class="provider_error",
                    error_class=exc.reason,
                    reason=exc.reason,
                )
            except MemoryGovernanceConflict:
                # A late completion is deliberately fenced. Returned IDs were
                # supplied to the CAS path when it was still valid; an expired
                # lease is reclaimed and reconciled by operation marker.
                pass
        emit_memory_event(
            "memory.projection.job",
            service=self.service_name,
            outcome="completed",
            operation=lease.operation,
            projection_job_ref=keyed_ref("projection-job", str(lease.projection_job_id)),
        )
        return True
