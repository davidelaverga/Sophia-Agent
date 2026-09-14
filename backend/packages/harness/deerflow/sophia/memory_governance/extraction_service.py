"""Durable transcript-range extraction and candidate-ledger worker."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime

from deerflow.sophia.extraction import _PIPELINE_MODEL, extract_session_memories
from deerflow.sophia.session_store import (
    SessionMessageRecord,
    SessionStore,
)

from .faults import InjectedExtractionClaimantCrash, MemoryFaultController
from .identity import assert_not_voice_lab_principal
from .models import CandidateSource, ExtractedCandidate, ExtractionRun
from .observability import emit_memory_event
from .owner_authority import require_candidate_extraction
from .refs import keyed_ref
from .store import MemoryGovernanceConflict, MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

Extractor = Callable[[str, str, list[dict], dict], list[dict]]


def _serialize(messages: list[SessionMessageRecord]) -> list[dict]:
    return [
        {
            "role": message.role,
            "content": message.content,
            "sequence": message.sequence,
            "message_id": message.message_id,
            "metadata": {
                "sequence": message.sequence,
                "message_id": message.message_id,
                "created_at": message.created_at,
                "source": message.source,
            },
        }
        for message in messages
    ]


def _manifest_ref(*, user_id: str, session_id: str, transcript_revision: int, messages: list[SessionMessageRecord]) -> str:
    payload = json.dumps(
        {
            "user_id": user_id,
            "session_id": session_id,
            "transcript_revision": transcript_revision,
            "messages": [
                {
                    "message_id": message.message_id,
                    "sequence": message.sequence,
                    "role": message.role,
                    "content": message.content,
                    "final": message.final,
                    "redaction_level": message.redaction_level,
                }
                for message in messages
            ],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return keyed_ref("transcript-manifest", payload)


class MemoryExtractionService:
    def __init__(
        self,
        *,
        governance_store: SupabaseMemoryGovernanceStore,
        session_store: SessionStore,
        lease_owner: str,
        service_name: str,
        extractor: Extractor | None = None,
        faults: MemoryFaultController | None = None,
    ) -> None:
        self.governance_store = governance_store
        self.session_store = session_store
        self.lease_owner = lease_owner
        self.service_name = service_name
        self.extractor = extractor
        self.faults = faults

    def _assert_supported_contract(self) -> None:
        contract = self.governance_store.get_contract()
        if contract.contract_epoch != 1 or contract.schema_version != "mem00.v1" or contract.mode not in {"shadow", "enforced"}:
            raise MemoryGovernanceUnavailable("memory_contract_not_active")

    @staticmethod
    def _extract(user_id: str, session_id: str, messages: list[dict], metadata: dict, *, dispatch_authority=None) -> list[dict]:
        return extract_session_memories(
            user_id,
            session_id,
            messages,
            metadata,
            require_memory_write=False,
            candidate_only=True,
            dispatch_authority=dispatch_authority,
        )

    def _finalized_extraction_payload(self, *, user_id: str, session_id: str, finalize_ended_at: str | None = None) -> dict[str, object] | None:
        assert_not_voice_lab_principal(user_id)
        self._assert_supported_contract()
        require_candidate_extraction(user_id, store=self.governance_store)
        session = self.session_store.get(user_id, session_id)
        if session is None:
            if finalize_ended_at is not None:
                raise MemoryGovernanceConflict("memory_session_not_found")
            return None
        if session.user_id != user_id or session.session_id != session_id:
            raise MemoryGovernanceConflict("memory_session_scope_conflict")
        from .source_snapshot import read_snapshot_source_messages, read_source_snapshot
        from .source_target import build_source_target_at_epoch

        snapshot = read_source_snapshot(store=self.governance_store, session=session)
        visible = read_snapshot_source_messages(session_store=self.session_store, session=session, snapshot=snapshot)

        runs=self.governance_store.source_extraction_runs(user_id=user_id,session_id=session_id)
        require_candidate_extraction(user_id,store=self.governance_store)
        return build_source_target_at_epoch(session=session,messages=visible,runs=runs,extractor_model=_PIPELINE_MODEL,snapshot=snapshot,ended_at=finalize_ended_at)

    def enqueue_finalized_session(self, *, user_id: str, session_id: str) -> ExtractionRun | None:
        payload = self._finalized_extraction_payload(user_id=user_id, session_id=session_id)
        if payload is None:
            return None
        return self.governance_store.apply_source_target_at_epoch(**payload).run

    def finalize_and_enqueue_session(
        self,
        *,
        user_id: str,
        session_id: str,
        ended_at: str,
    ) -> ExtractionRun | None:
        """Durably end and align. None means no new run, NOT successful zero.

        Canonical review independently reports current source exclusions and
        extraction coverage; a historical target receipt never certifies them.
        """

        payload = self._finalized_extraction_payload(user_id=user_id, session_id=session_id, finalize_ended_at=ended_at)
        if payload is None:
            return None
        return self.governance_store.apply_source_target_at_epoch(**payload).run

    def recover_finalized_sessions(self, *, user_ids: tuple[str, ...], limit: int = 100) -> int:
        """Check bounded durable recovery claims; return checked, not extracted, count."""

        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("memory_recovery_limit_invalid")
        checked = 0
        for user_id in user_ids:
            assert_not_voice_lab_principal(user_id)
            require_candidate_extraction(user_id, store=self.governance_store)
            while checked < limit:
                claim = self.governance_store.claim_source_recovery(user_id=user_id, lease_owner=self.lease_owner)
                if claim is None:
                    break
                try:
                    session = self.session_store.get(user_id, claim.session_id)
                    if session is None or session.status != "ended":
                        outcome = "source_ineligible"
                    else:
                        self.enqueue_finalized_session(user_id=user_id, session_id=claim.session_id)
                        outcome = "target_checked"
                except Exception:
                    # Preserve a durable failure without a raw body or a false
                    # successful-zero result. Continue the sweep, then revisit.
                    outcome = "retryable_failure"
                if claim.lease_expires_at <= datetime.now(UTC):
                    outcome = "retryable_failure"
                self.governance_store.complete_source_recovery(claim, outcome=outcome)
                checked += 1
        return checked

    def run_once(self) -> bool:
        self._assert_supported_contract()
        run = self.governance_store.claim_extraction(lease_owner=self.lease_owner)
        if run is None:
            return False
        try:
            assert_not_voice_lab_principal(run.user_id)
            require_candidate_extraction(run.user_id, store=self.governance_store)
            if self.faults is not None and self.faults.consume(
                owner_id=run.user_id,
                mode="extraction_claimant_crash",
            ):
                raise InjectedExtractionClaimantCrash("memory_extraction_claimant_crash_injected")
            session = self.session_store.get(run.user_id, run.session_id)
            if session is not None and (session.user_id != run.user_id or session.session_id != run.session_id):
                raise MemoryGovernanceConflict("memory_session_scope_conflict")
            from .source_snapshot import read_snapshot_source_messages, read_source_snapshot

            if session is None:
                raise MemoryGovernanceUnavailable("memory_extraction_source_unavailable")
            snapshot = read_source_snapshot(store=self.governance_store, session=session)
            if type(run.memory_clear_epoch) is not int or run.memory_clear_epoch != snapshot.memory_clear_epoch:
                raise MemoryGovernanceUnavailable("memory_extraction_source_epoch_changed")
            visible = read_snapshot_source_messages(session_store=self.session_store, session=session, snapshot=snapshot)
            selected = [message for message in visible if run.sequence_start <= message.sequence <= run.sequence_end]
            from .extraction_input import context_is_current, extraction_input_ref
            from .source_target import dependencies

            if run.extractor_input_context is None or run.extractor_input_ref is None or run.source_dependencies is None:
                raise MemoryGovernanceUnavailable("memory_historical_input_unproven")

            current_ref = _manifest_ref(
                user_id=run.user_id,
                session_id=run.session_id,
                transcript_revision=run.transcript_revision,
                messages=selected,
            )
            if session is None or (run.source_dependencies is not None and dependencies(selected)!=run.source_dependencies):
                current_ref = keyed_ref("transcript-manifest", "stale-or-missing-session")
            eligible = {row.sequence for row in snapshot.sources if row.eligibility == "eligible"}
            if any(message.sequence not in eligible for message in selected):
                current_ref = keyed_ref("transcript-manifest", "ineligible-source-occurrence")
            if session is not None and (not context_is_current(run.extractor_input_context,context_mode=session.context_mode)
                or extraction_input_ref(owner_id=run.user_id,session_id=run.session_id,messages=_serialize(selected),context=run.extractor_input_context,model=_PIPELINE_MODEL)!=run.extractor_input_ref):
                current_ref = keyed_ref("transcript-manifest", "stale-extractor-input")
            if session is not None and current_ref != run.input_manifest_ref:
                # Alignment invalidates the obsolete lease and queues the first
                # changed range in one transaction. Never complete that old lease.
                replacement = self.enqueue_finalized_session(
                    user_id=run.user_id,
                    session_id=run.session_id,
                )
                emit_memory_event("memory.extraction.source_realigned",service=self.service_name,
                    outcome="current_run_present" if replacement is not None else "no_current_run",
                    fault_owner_id=run.user_id,extraction_run_ref=keyed_ref("extraction-run",str(run.extraction_run_id)))
                return True
            serialized = _serialize(selected)
            require_candidate_extraction(run.user_id, store=self.governance_store)
            from .extraction_dispatch import ExtractionDispatchAuthority

            dispatch = ExtractionDispatchAuthority(run=run, store=self.governance_store)
            def invoke_extractor(owner, session_id, messages, metadata):
                if self.extractor is None:
                    return self._extract(owner, session_id, messages, metadata, dispatch_authority=dispatch)
                # Custom/injected extractors also require current SQL authority.
                dispatch.admit(owner_id=owner, session_id=session_id, extractor_input_ref=run.extractor_input_ref)
                return self.extractor(owner, session_id, messages, metadata)
            raw = (
                invoke_extractor(
                    run.user_id,
                    run.session_id,
                    serialized,
                    {
                        "thread_id": run.thread_id,
                        "sequence_start": run.sequence_start,
                        "sequence_end": run.sequence_end,
                        "extraction_run_id": str(run.extraction_run_id),
                        "platform": session.platform if session else "unknown",
                        "context_mode": session.context_mode if session else "unknown",
                        "session_date": run.extractor_input_context.session_date,
                        "extractor_input_ref": run.extractor_input_ref,
                    },
                )
                if current_ref == run.input_manifest_ref
                else []
            )
            default_sources = tuple(
                CandidateSource(
                    session_id=run.session_id,
                    message_id=message.message_id,
                    sequence=message.sequence,
                    transcript_revision=run.transcript_revision,
                )
                for message in selected
            )
            candidates = tuple(
                ExtractedCandidate(
                    content=str(item.get("content") or "").strip(),
                    content_ref=keyed_ref("candidate-content", str(item.get("content") or "").strip()),
                    category=str(item.get("category") or "fact"),
                    confidence=float(item.get("confidence", 0.5)),
                    importance=float(item.get("importance", 0.5)),
                    proposed_tier="none",
                    sources=default_sources,
                )
                for item in raw
                if isinstance(item, dict) and str(item.get("content") or "").strip()
            )
            require_candidate_extraction(run.user_id, store=self.governance_store)
            completed = self.governance_store.complete_extraction(run, input_manifest_ref=current_ref, candidates=candidates)
        except InjectedExtractionClaimantCrash:
            # Leave the durable lease untouched so another claimant can resume
            # only after its fence expires, exactly as with process death.
            raise
        except Exception:
            self.governance_store.fail_extraction(run, error_code="memory_extraction_worker_failed", retryable=True)
            raise
        emit_memory_event(
            "memory.extraction.completed",
            service=self.service_name,
            outcome=completed.state,
            fault_owner_id=run.user_id,
            extraction_run_ref=keyed_ref("extraction-run", str(run.extraction_run_id)),
            candidate_count=completed.terminal_candidate_count or 0,
        )
        if completed.state in {"succeeded_zero","succeeded_nonzero"}:
            try:
                self.enqueue_finalized_session(user_id=run.user_id,session_id=run.session_id)
            except Exception:
                # Publication is already committed. Bounded durable recovery
                # retries target alignment; do not rewrite this run as failed.
                emit_memory_event("memory.extraction.recovery_pending",service=self.service_name,outcome="source_alignment_unavailable",
                    fault_owner_id=run.user_id,extraction_run_ref=keyed_ref("extraction-run",str(run.extraction_run_id)))
        return True
