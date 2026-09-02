"""Canonical user-facing MEM00 operations.

Every method binds one authenticated owner, computes a keyed request digest,
and delegates the atomic state transition to the database authority.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from .faults import MemoryFaultController
from .flags import memory_feature_flags_for_owner
from .identity import assert_not_voice_lab_principal
from .models import GovernanceReceipt, PrivacyReceipt, SourceInvalidationReceipt
from .refs import keyed_ref, request_digest
from .store import (
    MemoryGovernanceUnavailable,
    SupabaseMemoryGovernanceStore,
    configured_memory_store,
)


class MemoryProviderConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class MemoryProviderContract:
    provider: str
    environment: str
    project: str
    contract_epoch: int = 1

    @classmethod
    def from_environ(cls) -> MemoryProviderContract:
        provider = (os.getenv("SOPHIA_MEMORY_PROVIDER") or "mem0").strip()
        environment = (os.getenv("SOPHIA_MEMORY_PROVIDER_ENVIRONMENT") or os.getenv("SOPHIA_ENV") or os.getenv("ENVIRONMENT") or "").strip()
        project = (os.getenv("SOPHIA_MEMORY_PROVIDER_PROJECT") or "").strip()
        epoch_text = (os.getenv("SOPHIA_MEMORY_SUPPORTED_CONTRACT_EPOCH") or "1").strip()
        if provider != "mem0" or not environment or not project:
            raise MemoryProviderConfigurationError("memory_provider_contract_not_pinned")
        try:
            epoch = int(epoch_text)
        except ValueError as exc:
            raise MemoryProviderConfigurationError("memory_contract_epoch_invalid") from exc
        if epoch < 1:
            raise MemoryProviderConfigurationError("memory_contract_epoch_invalid")
        return cls(provider=provider, environment=environment, project=project, contract_epoch=epoch)


class CanonicalMemoryService:
    def __init__(
        self,
        *,
        owner_id: str,
        store: SupabaseMemoryGovernanceStore | None = None,
        provider: MemoryProviderContract | None = None,
    ) -> None:
        normalized_owner = owner_id.strip()
        if not normalized_owner:
            raise ValueError("memory_owner_invalid")
        assert_not_voice_lab_principal(normalized_owner)
        self.owner_id = normalized_owner
        self.store = store or configured_memory_store()
        self.provider = provider or MemoryProviderContract.from_environ()

    @staticmethod
    def _stable_payload(operation: str, payload: dict[str, Any]) -> bytes:
        return json.dumps(
            {"operation": operation, **payload},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode()

    def _digest(self, operation: str, payload: dict[str, Any]) -> str:
        return request_digest(self._stable_payload(operation, payload))

    def content_ref(self, content: str) -> str:
        return keyed_ref("canonical-content", content)

    def _assert_supported_contract(self) -> None:
        contract = self.store.get_contract()
        if contract.contract_epoch != self.provider.contract_epoch or contract.schema_version != "mem00.v1" or contract.mode not in {"shadow", "enforced"}:
            raise MemoryGovernanceUnavailable("memory_contract_not_active")

    def invalidate_source_session(
        self,
        *,
        session_id: str,
        current_transcript_revision: int | None,
        detach_source: bool,
        idempotency_key: str,
        safe_reason_code: str,
        actor_kind: str = "user",
    ) -> SourceInvalidationReceipt:
        self._assert_supported_contract()
        digest_payload = {
            "session_id": session_id,
            "current_transcript_revision": current_transcript_revision,
            "detach_source": detach_source,
            "safe_reason_code": safe_reason_code,
        }
        return self.store.invalidate_source(
            p_user_id=self.owner_id,
            p_session_id=session_id,
            p_current_transcript_revision=current_transcript_revision,
            p_detach_source=detach_source,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("invalidate_source_session", digest_payload),
            p_safe_reason_code=safe_reason_code,
        )

    def list_pool(self, *, include_forgotten: bool = False, limit: int = 500):
        self._assert_supported_contract()
        return self.store.list_pool(user_id=self.owner_id, include_forgotten=include_forgotten, limit=limit)

    def approve_candidate(
        self,
        *,
        candidate_id: UUID,
        expected_candidate_revision: int,
        reviewed_content: str,
        category: str,
        scope: str,
        user_tier: str,
        idempotency_key: str,
        actor_kind: str = "user",
    ) -> GovernanceReceipt:
        self._assert_supported_contract()
        content_ref = self.content_ref(reviewed_content)
        digest_payload = {
            "candidate_id": str(candidate_id),
            "expected_candidate_revision": expected_candidate_revision,
            "reviewed_content_ref": content_ref,
            "category": category,
            "scope": scope,
            "user_tier": user_tier,
        }
        return self.store.approve_candidate(
            p_user_id=self.owner_id,
            p_candidate_id=str(candidate_id),
            p_expected_candidate_revision=expected_candidate_revision,
            p_reviewed_content=reviewed_content,
            p_reviewed_content_ref=content_ref,
            p_category=category,
            p_scope=scope,
            p_user_tier=user_tier,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("approve_candidate", digest_payload),
            p_provider=self.provider.provider,
            p_environment=self.provider.environment,
            p_provider_project=self.provider.project,
        )

    def reject_candidate(
        self,
        *,
        candidate_id: UUID,
        expected_candidate_revision: int,
        idempotency_key: str,
        actor_kind: str = "user",
    ) -> GovernanceReceipt:
        self._assert_supported_contract()
        digest_payload = {
            "candidate_id": str(candidate_id),
            "expected_candidate_revision": expected_candidate_revision,
        }
        return self.store.reject_candidate(
            p_user_id=self.owner_id,
            p_candidate_id=str(candidate_id),
            p_expected_candidate_revision=expected_candidate_revision,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("reject_candidate", digest_payload),
        )

    def manual_create(
        self,
        *,
        content: str,
        category: str,
        scope: str,
        user_tier: str,
        idempotency_key: str,
        actor_kind: str = "user",
    ) -> GovernanceReceipt:
        self._assert_supported_contract()
        content_ref = self.content_ref(content)
        digest_payload = {
            "content_ref": content_ref,
            "category": category,
            "scope": scope,
            "user_tier": user_tier,
        }
        return self.store.manual_create(
            p_user_id=self.owner_id,
            p_canonical_content=content,
            p_content_ref=content_ref,
            p_category=category,
            p_scope=scope,
            p_user_tier=user_tier,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("manual_create", digest_payload),
            p_provider=self.provider.provider,
            p_environment=self.provider.environment,
            p_provider_project=self.provider.project,
        )

    def import_approved_legacy(
        self,
        *,
        provider_memory_id: str,
        approval_evidence_ref: str,
        content: str,
        category: str,
        scope: str,
        user_tier: str,
        idempotency_key: str,
    ) -> GovernanceReceipt:
        """Import one exact legacy ID only after authoritative user evidence.

        The raw provider ID is reduced to a keyed reference before it reaches
        durable receipts. Provider metadata alone is never accepted here.
        """

        normalized_provider_id = provider_memory_id.strip()
        if not normalized_provider_id:
            raise ValueError("legacy_provider_id_invalid")
        if not approval_evidence_ref.startswith("hmac-sha256:"):
            raise ValueError("legacy_approval_evidence_invalid")
        self._assert_supported_contract()
        content_ref = self.content_ref(content)
        provider_id_ref = keyed_ref("legacy-provider-id", normalized_provider_id)
        digest_payload = {
            "provider_id_ref": provider_id_ref,
            "approval_evidence_ref": approval_evidence_ref,
            "content_ref": content_ref,
            "category": category,
            "scope": scope,
            "user_tier": user_tier,
        }
        return self.store.manual_create(
            p_user_id=self.owner_id,
            p_canonical_content=content,
            p_content_ref=content_ref,
            p_category=category,
            p_scope=scope,
            p_user_tier=user_tier,
            p_actor_kind="legacy_import",
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("import_approved_legacy", digest_payload),
            p_provider=self.provider.provider,
            p_environment=self.provider.environment,
            p_provider_project=self.provider.project,
        )

    def edit(
        self,
        *,
        memory_id: UUID,
        expected_content_revision: int,
        expected_governance_revision: int,
        content: str,
        category: str,
        scope: str,
        user_tier: str,
        idempotency_key: str,
        actor_kind: str = "user",
    ) -> GovernanceReceipt:
        self._assert_supported_contract()
        content_ref = self.content_ref(content)
        digest_payload = {
            "memory_id": str(memory_id),
            "expected_content_revision": expected_content_revision,
            "expected_governance_revision": expected_governance_revision,
            "content_ref": content_ref,
            "category": category,
            "scope": scope,
            "user_tier": user_tier,
        }
        return self.store.edit(
            p_user_id=self.owner_id,
            p_memory_id=str(memory_id),
            p_expected_content_revision=expected_content_revision,
            p_expected_governance_revision=expected_governance_revision,
            p_canonical_content=content,
            p_content_ref=content_ref,
            p_category=category,
            p_scope=scope,
            p_user_tier=user_tier,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("edit", digest_payload),
            p_provider=self.provider.provider,
            p_environment=self.provider.environment,
            p_provider_project=self.provider.project,
        )

    def forget(
        self,
        *,
        memory_id: UUID,
        expected_governance_revision: int,
        idempotency_key: str,
        actor_kind: str = "user",
    ) -> GovernanceReceipt:
        self._assert_supported_contract()
        digest_payload = {
            "memory_id": str(memory_id),
            "expected_governance_revision": expected_governance_revision,
        }
        return self.store.forget(
            p_user_id=self.owner_id,
            p_memory_id=str(memory_id),
            p_expected_governance_revision=expected_governance_revision,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("forget", digest_payload),
        )

    def restore(
        self,
        *,
        memory_id: UUID,
        expected_governance_revision: int,
        idempotency_key: str,
    ) -> GovernanceReceipt:
        self._assert_supported_contract()
        digest_payload = {
            "memory_id": str(memory_id),
            "expected_governance_revision": expected_governance_revision,
        }
        return self.store.restore(
            p_user_id=self.owner_id,
            p_memory_id=str(memory_id),
            p_expected_governance_revision=expected_governance_revision,
            p_actor_kind="user",
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("restore", digest_payload),
            p_provider=self.provider.provider,
            p_environment=self.provider.environment,
            p_provider_project=self.provider.project,
        )

    def permanently_delete(
        self,
        *,
        memory_id: UUID,
        expected_governance_revision: int,
        idempotency_key: str,
        actor_kind: str = "user",
    ) -> PrivacyReceipt:
        self._assert_supported_contract()
        retain_warm_cache = bool(
            memory_feature_flags_for_owner(self.owner_id).memory_fault_injection
            and MemoryFaultController(store=self.store).consume(
                owner_id=self.owner_id,
                mode="cache_retained_through_tombstone",
            )
        )
        digest_payload = {
            "memory_id": str(memory_id),
            "expected_governance_revision": expected_governance_revision,
        }
        receipt = self.store.tombstone(
            p_user_id=self.owner_id,
            p_memory_id=str(memory_id),
            p_expected_governance_revision=expected_governance_revision,
            p_actor_kind=actor_kind,
            p_idempotency_key=idempotency_key,
            p_request_digest=self._digest("permanent_delete", digest_payload),
        )
        return PrivacyReceipt(
            status="accepted_and_fenced",
            canonical_memory_fence="committed",
            provider_purge=receipt.provider_purge or "purge_pending",
            source_transcript="not_deleted",
            derived_artifacts="invalidation_required",
            cache_invalidation=(
                "revocation_epoch_advanced_cache_retained_for_fault_recheck"
                if retain_warm_cache
                else "revocation_epoch_advanced"
            ),
            receipt=receipt,
        )
