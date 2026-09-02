"""Durable transcript-range extraction and candidate-ledger worker."""

from __future__ import annotations

import json
from collections.abc import Callable

from deerflow.sophia.extraction import extract_session_memories
from deerflow.sophia.session_store import (
    SessionMessageRecord,
    SessionStore,
    canonical_visible_messages,
)

from .identity import assert_not_voice_lab_principal
from .models import CandidateSource, ExtractedCandidate, ExtractionRun
from .observability import emit_memory_event
from .refs import keyed_ref, request_digest
from .store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

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
    ) -> None:
        self.governance_store = governance_store
        self.session_store = session_store
        self.lease_owner = lease_owner
        self.service_name = service_name
        self.extractor = extractor or self._extract

    def _assert_supported_contract(self) -> None:
        contract = self.governance_store.get_contract()
        if contract.contract_epoch != 1 or contract.schema_version != "mem00.v1" or contract.mode not in {"shadow", "enforced"}:
            raise MemoryGovernanceUnavailable("memory_contract_not_active")

    @staticmethod
    def _extract(user_id: str, session_id: str, messages: list[dict], metadata: dict) -> list[dict]:
        return extract_session_memories(
            user_id,
            session_id,
            messages,
            metadata,
            require_memory_write=False,
            candidate_only=True,
        )

    def _finalized_extraction_payload(self, *, user_id: str, session_id: str) -> dict[str, object] | None:
        assert_not_voice_lab_principal(user_id)
        self._assert_supported_contract()
        session = self.session_store.get(user_id, session_id)
        if session is None:
            return None
        visible = canonical_visible_messages(self.session_store.list_messages(user_id, session_id))
        last_processed = max(0, int(session.memory_processed_until_sequence or 0))
        selected = [message for message in visible if message.sequence > last_processed]
        if not selected:
            return None
        sequence_start = selected[0].sequence
        sequence_end = selected[-1].sequence
        manifest_ref = _manifest_ref(
            user_id=user_id,
            session_id=session_id,
            transcript_revision=session.message_revision,
            messages=selected,
        )
        idempotency_key = keyed_ref(
            "extraction-range",
            f"{user_id}:{session_id}:{session.message_revision}:{sequence_start}:{sequence_end}:mem00.extract.v1",
        )
        digest = request_digest(
            json.dumps(
                {
                    "idempotency_key": idempotency_key,
                    "manifest_ref": manifest_ref,
                    "thread_id": session.thread_id,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        )
        return {
            "p_user_id": user_id,
            "p_idempotency_key": idempotency_key,
            "p_request_digest": digest,
            "p_session_id": session_id,
            "p_thread_id": session.thread_id,
            "p_modality": session.mode or "text",
            "p_transcript_revision": session.message_revision,
            "p_sequence_start": sequence_start,
            "p_sequence_end": sequence_end,
            "p_input_manifest_ref": manifest_ref,
            "p_extractor_contract_version": "mem00.extract.v1",
            "p_extractor_model": "claude-3-5-haiku-20241022",
            "p_extractor_prompt_version": "mem0_extraction.md:v1",
        }

    def enqueue_finalized_session(self, *, user_id: str, session_id: str) -> ExtractionRun | None:
        payload = self._finalized_extraction_payload(user_id=user_id, session_id=session_id)
        if payload is None:
            return None
        return self.governance_store.enqueue_extraction(**payload)

    def finalize_and_enqueue_session(
        self,
        *,
        user_id: str,
        session_id: str,
        ended_at: str,
    ) -> ExtractionRun | None:
        """Atomically mark the persisted session ended and enqueue its exact range."""

        payload = self._finalized_extraction_payload(user_id=user_id, session_id=session_id)
        if payload is None:
            return None
        return self.governance_store.finalize_and_enqueue_extraction(
            p_ended_at=ended_at,
            **payload,
        )

    def recover_finalized_sessions(self, *, user_ids: tuple[str, ...], limit: int = 100) -> int:
        """Idempotently restore missing work for ended cohort sessions after restart."""

        recovered = 0
        for user_id in user_ids:
            assert_not_voice_lab_principal(user_id)
            for session in self.session_store.list_sessions(user_id):
                if recovered >= limit:
                    return recovered
                if session.status != "ended":
                    continue
                run = self.enqueue_finalized_session(
                    user_id=user_id,
                    session_id=session.session_id,
                )
                if run is not None:
                    recovered += 1
        return recovered

    def run_once(self) -> bool:
        self._assert_supported_contract()
        run = self.governance_store.claim_extraction(lease_owner=self.lease_owner)
        if run is None:
            return False
        replacement: ExtractionRun | None = None
        try:
            session = self.session_store.get(run.user_id, run.session_id)
            visible = canonical_visible_messages(self.session_store.list_messages(run.user_id, run.session_id))
            selected = [message for message in visible if run.sequence_start <= message.sequence <= run.sequence_end]
            current_ref = _manifest_ref(
                user_id=run.user_id,
                session_id=run.session_id,
                transcript_revision=session.message_revision if session else -1,
                messages=selected,
            )
            if session is None or session.message_revision != run.transcript_revision:
                current_ref = keyed_ref("transcript-manifest", "stale-or-missing-session")
            if session is not None and current_ref != run.input_manifest_ref:
                # Queue the revised range before superseding this run. If the
                # worker dies between these operations, the leased run remains
                # retryable and the replacement enqueue is idempotent.
                replacement = self.enqueue_finalized_session(
                    user_id=run.user_id,
                    session_id=run.session_id,
                )
                if replacement is None:
                    raise MemoryGovernanceUnavailable("memory_replacement_extraction_unavailable")
            serialized = _serialize(selected)
            raw = (
                self.extractor(
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
            completed = self.governance_store.complete_extraction(run, input_manifest_ref=current_ref, candidates=candidates)
        except Exception:
            self.governance_store.fail_extraction(run, error_code="memory_extraction_worker_failed", retryable=True)
            raise
        emit_memory_event(
            "memory.extraction.completed",
            service=self.service_name,
            outcome=completed.state,
            extraction_run_ref=keyed_ref("extraction-run", str(run.extraction_run_id)),
            candidate_count=completed.terminal_candidate_count or 0,
        )
        if replacement is not None:
            emit_memory_event(
                "memory.extraction.replacement_queued",
                service=self.service_name,
                outcome="queued",
                extraction_run_ref=keyed_ref("extraction-run", str(replacement.extraction_run_id)),
                superseded_run_ref=keyed_ref("extraction-run", str(run.extraction_run_id)),
            )
        return True
