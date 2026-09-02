"""Fail-closed, canonical-text-only governed memory retrieval."""

from __future__ import annotations

import time
from uuid import UUID, uuid4

from .mem0_projection_adapter import Mem0ContractError, Mem0ProjectionAdapter
from .models import (
    AuthorizedMemory,
    GovernedMemoryContext,
    RetrievalReceipt,
)
from .observability import emit_memory_event
from .refs import keyed_ref
from .service import MemoryProviderContract
from .store import SupabaseMemoryGovernanceStore


class GovernedMemoryReader:
    def __init__(
        self,
        *,
        store: SupabaseMemoryGovernanceStore,
        adapter: Mem0ProjectionAdapter,
        provider: MemoryProviderContract,
        service_name: str,
    ) -> None:
        self.store = store
        self.adapter = adapter
        self.provider = provider
        self.service_name = service_name

    def _empty(
        self,
        *,
        request_id: UUID,
        owner_id: str,
        query: str,
        provider_status: str,
        reason: str,
        elapsed_ms: int,
    ) -> GovernedMemoryContext:
        receipt = RetrievalReceipt(
            retrieval_request_id=request_id,
            owner_ref=keyed_ref("owner", owner_id),
            query_ref=keyed_ref("query", query),
            provider_status=provider_status,
            provider_hit_count=0,
            catalog_generation_checked=0,
            revocation_epoch_checked=0,
            authorized_memory_ids=(),
            denial_counts_by_reason={reason: 1},
            latency_segments={"total_ms": elapsed_ms},
            safe_reason_code=reason,
        )
        emit_memory_event(
            "memory.retrieval.denied",
            service=self.service_name,
            outcome="zero_memory",
            retrieval_request_ref=keyed_ref("retrieval", str(request_id)),
            owner_ref=receipt.owner_ref,
            query_ref=receipt.query_ref,
            provider_status=provider_status,
            safe_reason_code=reason,
        )
        return GovernedMemoryContext(memories=(), context_text="", receipt=receipt)

    def retrieve(
        self,
        *,
        owner_id: str,
        caller: str,
        scope: str,
        query: str,
        limit: int = 8,
        overfetch_factor: int = 4,
    ) -> GovernedMemoryContext:
        started = time.monotonic()
        request_id = uuid4()
        try:
            contract = self.store.get_contract()
            if contract.contract_epoch != self.provider.contract_epoch or contract.schema_version != "mem00.v1" or contract.mode != "enforced":
                return self._empty(
                    request_id=request_id,
                    owner_id=owner_id,
                    query=query,
                    provider_status="disabled",
                    reason="contract_not_enforced",
                    elapsed_ms=int((time.monotonic() - started) * 1000),
                )
            before = self.store.get_user_governance(owner_id)
        except Exception:
            return self._empty(
                request_id=request_id,
                owner_id=owner_id,
                query=query,
                provider_status="not_called",
                reason="governance_unavailable",
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )

        provider_started = time.monotonic()
        try:
            hits = self.adapter.search_ids(
                query=query,
                provider_subject=before.provider_subject,
                metadata_filter={
                    "sophia_managed": True,
                    "memory_contract_epoch": self.provider.contract_epoch,
                    "environment": self.provider.environment,
                    "provider_namespace": before.provider_subject,
                },
                limit=min(100, max(limit, 1) * max(overfetch_factor, 1)),
            )
        except Mem0ContractError:
            return self._empty(
                request_id=request_id,
                owner_id=owner_id,
                query=query,
                provider_status="unavailable",
                reason="provider_unavailable",
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
        provider_ms = int((time.monotonic() - provider_started) * 1000)

        governance_started = time.monotonic()
        try:
            authorized, denials = self.store.authorize_provider_hits(
                user_id=owner_id,
                provider=self.provider.provider,
                environment=self.provider.environment,
                provider_project=self.provider.project,
                provider_namespace=before.provider_subject,
                hits=hits,
            )
            authorized = tuple((memory, score) for memory, score in authorized if memory.scope == scope or memory.scope == "global")[: max(limit, 0)]
            after = self.store.get_user_governance(owner_id)
            if after.user_revocation_epoch != before.user_revocation_epoch or after.user_catalog_generation != before.user_catalog_generation:
                authorized, retry_denials = self.store.authorize_provider_hits(
                    user_id=owner_id,
                    provider=self.provider.provider,
                    environment=self.provider.environment,
                    provider_project=self.provider.project,
                    provider_namespace=after.provider_subject,
                    hits=hits,
                )
                denials.update(retry_denials)
                authorized = tuple((memory, score) for memory, score in authorized if memory.scope == scope or memory.scope == "global")[: max(limit, 0)]
            canonical = tuple(
                AuthorizedMemory(
                    memory_id=memory.memory_id,
                    content_revision=memory.current_content_revision,
                    memory_governance_revision=memory.memory_governance_revision,
                    canonical_content=memory.canonical_content or "",
                    category=memory.category,
                    scope=memory.scope,
                    score=score,
                )
                for memory, score in authorized
                if memory.canonical_content
            )
            manifest = [
                {
                    "memory_id": str(item.memory_id),
                    "content_revision": item.content_revision,
                    "memory_governance_revision": item.memory_governance_revision,
                }
                for item in canonical
            ]
            query_ref = keyed_ref("query", query)
            prompt_id = self.store.record_prompt_admission(
                {
                    "retrieval_request_id": str(request_id),
                    "user_id": owner_id,
                    "caller": caller,
                    "scope": scope,
                    "query_ref": query_ref,
                    "provider": self.provider.provider,
                    "environment": self.provider.environment,
                    "provider_project": self.provider.project,
                    "provider_namespace": after.provider_subject,
                    "provider_status": "ok",
                    "provider_hit_count": len(hits),
                    "catalog_generation_checked": after.user_catalog_generation,
                    "revocation_epoch_checked": after.user_revocation_epoch,
                    "authorized_manifest": manifest,
                    "denial_counts": denials,
                    "outcome": "authorized" if canonical else "zero_memory",
                    "safe_reason_code": None if canonical else "no_authorized_hits",
                    "latency_segments": {"provider_ms": provider_ms},
                }
            )
        except Exception:
            return self._empty(
                request_id=request_id,
                owner_id=owner_id,
                query=query,
                provider_status="ok",
                reason="governance_unavailable_after_search",
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )

        context_text = "\n".join(f"- {item.canonical_content}" for item in canonical)
        receipt = RetrievalReceipt(
            retrieval_request_id=request_id,
            prompt_admission_id=prompt_id,
            owner_ref=keyed_ref("owner", owner_id),
            query_ref=query_ref,
            provider_status="ok",
            provider_hit_count=len(hits),
            catalog_generation_checked=after.user_catalog_generation,
            revocation_epoch_checked=after.user_revocation_epoch,
            authorized_memory_ids=tuple(
                keyed_ref(
                    "memory-revision",
                    f"{item.memory_id}:{item.content_revision}:{item.memory_governance_revision}",
                )
                for item in canonical
            ),
            denial_counts_by_reason=denials,
            latency_segments={
                "provider_ms": provider_ms,
                "governance_ms": int((time.monotonic() - governance_started) * 1000),
                "total_ms": int((time.monotonic() - started) * 1000),
            },
            safe_reason_code=None if canonical else "no_authorized_hits",
        )
        emit_memory_event(
            "memory.prompt.admission",
            service=self.service_name,
            outcome="authorized" if canonical else "zero_memory",
            retrieval_request_ref=keyed_ref("retrieval", str(request_id)),
            owner_ref=receipt.owner_ref,
            query_ref=receipt.query_ref,
            authorized_count=len(canonical),
            provider_hit_count=len(hits),
        )
        return GovernedMemoryContext(memories=canonical, context_text=context_text, receipt=receipt)
