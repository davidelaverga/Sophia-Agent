from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from deerflow.sophia.memory_governance.extraction_service import (
    MemoryExtractionService,
    _manifest_ref,
)
from deerflow.sophia.memory_governance.faults import InjectedExtractionClaimantCrash
from deerflow.sophia.memory_governance.models import ExtractionRun, MemoryContract
from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord


@pytest.fixture(autouse=True)
def _memory_ref_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "m" * 32)


def _message(sequence: int, *, content: str = "synthetic transcript text") -> SessionMessageRecord:
    return SessionMessageRecord(
        message_id=f"message-{sequence}",
        session_id="session-1",
        thread_id="thread-1",
        role="user" if sequence % 2 else "assistant",
        content=content,
        sequence=sequence,
    )


class _Sessions:
    def __init__(self, *, revision: int = 7, messages: list[SessionMessageRecord] | None = None) -> None:
        self.record = SessionRecord(
            session_id="session-1",
            thread_id="thread-1",
            user_id="owner-1",
            status="ended",
            mode="text",
            message_revision=revision,
            memory_processed_until_sequence=1,
        )
        self.messages = messages or [_message(1), _message(2), _message(3)]

    def get(self, user_id: str, session_id: str) -> SessionRecord | None:
        assert (user_id, session_id) == ("owner-1", "session-1")
        return self.record

    def list_messages(self, user_id: str, session_id: str) -> list[SessionMessageRecord]:
        assert (user_id, session_id) == ("owner-1", "session-1")
        return self.messages

    def list_sessions(self, user_id: str) -> list[SessionRecord]:
        assert user_id == "owner-1"
        return [self.record]


def _run(sessions: _Sessions, *, state: str = "leased") -> ExtractionRun:
    selected = sessions.messages[1:]
    return ExtractionRun(
        extraction_run_id=uuid4(),
        user_id="owner-1",
        session_id="session-1",
        thread_id="thread-1",
        transcript_revision=7,
        sequence_start=2,
        sequence_end=3,
        input_manifest_ref=_manifest_ref(
            user_id="owner-1",
            session_id="session-1",
            transcript_revision=7,
            messages=selected,
        ),
        extractor_contract_version="mem00.extract.v1",
        state=state,
        lease_token=uuid4(),
    )


class _Governance:
    def __init__(self, run: ExtractionRun | None = None) -> None:
        self.run = run
        self.enqueue_result = run
        self.enqueued = None
        self.finalized = None
        self.completed = None
        self.completed_result = None
        self.failed = None

    def get_contract(self):
        return MemoryContract(
            contract_epoch=1,
            schema_version="mem00.v1",
            mode="shadow",
            updated_at=datetime.now(UTC),
        )

    def enqueue_extraction(self, **payload):
        self.enqueued = payload
        return self.enqueue_result

    def finalize_and_enqueue_extraction(self, **payload):
        self.finalized = payload
        return self.enqueue_result

    def claim_extraction(self, *, lease_owner: str):
        assert lease_owner == "claimant-1"
        claimed, self.run = self.run, None
        return claimed

    def complete_extraction(self, run, *, input_manifest_ref, candidates):
        self.completed = (run, input_manifest_ref, tuple(candidates))
        state = "superseded" if input_manifest_ref != run.input_manifest_ref else "succeeded_nonzero" if candidates else "succeeded_zero"
        self.completed_result = run.model_copy(
            update={
                "state": state,
                "terminal_candidate_count": len(candidates),
            }
        )
        return self.completed_result

    def fail_extraction(self, run, *, error_code: str, retryable: bool):
        self.failed = (run, error_code, retryable)
        return run.model_copy(update={"state": "retry_wait", "error_code": error_code})


def _service(store: _Governance, sessions: _Sessions, extractor):
    return MemoryExtractionService(
        governance_store=store,
        session_store=sessions,
        lease_owner="claimant-1",
        service_name="test",
        extractor=extractor,
    )


def test_finalization_enqueues_one_exact_unprocessed_transcript_range() -> None:
    sessions = _Sessions()
    run = _run(sessions, state="queued")
    store = _Governance(run)
    result = _service(store, sessions, lambda *_: []).enqueue_finalized_session(
        user_id="owner-1",
        session_id="session-1",
    )
    assert result == run
    assert store.enqueued["p_transcript_revision"] == 7
    assert store.enqueued["p_sequence_start"] == 2
    assert store.enqueued["p_sequence_end"] == 3
    assert store.enqueued["p_input_manifest_ref"] == run.input_manifest_ref


def test_finalization_marks_ended_and_enqueues_in_one_store_call() -> None:
    sessions = _Sessions()
    run = _run(sessions, state="queued")
    store = _Governance(run)

    result = _service(store, sessions, lambda *_: []).finalize_and_enqueue_session(
        user_id="owner-1",
        session_id="session-1",
        ended_at="2026-09-02T19:00:00+00:00",
    )

    assert result == run
    assert store.enqueued is None
    assert store.finalized["p_ended_at"] == "2026-09-02T19:00:00+00:00"
    assert store.finalized["p_transcript_revision"] == 7
    assert store.finalized["p_sequence_start"] == 2
    assert store.finalized["p_sequence_end"] == 3
    assert store.finalized["p_input_manifest_ref"] == run.input_manifest_ref


def test_extraction_commits_one_atomic_batch_with_exact_sources() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions))
    service = _service(
        store,
        sessions,
        lambda *_: [{"content": "synthetic candidate", "category": "fact", "confidence": 0.8}],
    )
    assert service.run_once()
    candidates = store.completed[2]
    assert len(candidates) == 1
    assert [(source.message_id, source.sequence, source.transcript_revision) for source in candidates[0].sources] == [
        ("message-2", 2, 7),
        ("message-3", 3, 7),
    ]


def test_stale_transcript_revision_never_calls_extractor_and_completes_as_superseded_input() -> None:
    sessions = _Sessions(revision=8)
    run_sessions = _Sessions(revision=7)
    run = _run(run_sessions)
    store = _Governance(run)
    called = False

    def extractor(*_):
        nonlocal called
        called = True
        return [{"content": "must not publish"}]

    assert _service(store, sessions, extractor).run_once()
    assert not called
    assert store.completed[1] != store.completed[0].input_manifest_ref
    assert store.completed[2] == ()
    assert store.completed_result.state == "superseded"
    assert store.enqueued["p_transcript_revision"] == 8
    assert store.enqueued["p_sequence_start"] == 2
    assert store.enqueued["p_sequence_end"] == 3
    assert store.enqueued["p_input_manifest_ref"] != run.input_manifest_ref


def test_replacement_enqueue_failure_keeps_stale_run_retryable() -> None:
    sessions = _Sessions(revision=8)
    run_sessions = _Sessions(revision=7)
    store = _Governance(_run(run_sessions))
    store.enqueue_result = None

    with pytest.raises(Exception, match="memory_replacement_extraction_unavailable"):
        _service(store, sessions, lambda *_: []).run_once()

    assert store.completed is None
    assert store.failed[1:] == ("memory_extraction_worker_failed", True)


def test_successful_zero_candidate_run_is_terminal_and_range_bound() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions))
    assert _service(store, sessions, lambda *_: []).run_once()
    assert store.completed[2] == ()


def test_restart_recovery_idempotently_enqueues_unprocessed_ended_session() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions, state="queued"))

    recovered = _service(store, sessions, lambda *_: []).recover_finalized_sessions(
        user_ids=("owner-1",),
    )

    assert recovered == 1
    assert store.enqueued["p_session_id"] == "session-1"
    assert store.enqueued["p_sequence_start"] == 2
    assert store.enqueued["p_sequence_end"] == 3


def test_extractor_failure_returns_durable_run_to_retry_state() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions))

    def fail(*_):
        raise RuntimeError("synthetic extractor failure")

    with pytest.raises(RuntimeError, match="synthetic extractor failure"):
        _service(store, sessions, fail).run_once()
    assert store.failed[1:] == ("memory_extraction_worker_failed", True)


def test_injected_claimant_crash_leaves_the_durable_lease_for_expiry_recovery() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions))

    class Faults:
        def consume(self, *, owner_id, mode):
            assert owner_id == "owner-1"
            assert mode == "extraction_claimant_crash"
            return True

    service = MemoryExtractionService(
        governance_store=store,
        session_store=sessions,
        lease_owner="claimant-1",
        service_name="test",
        extractor=lambda *_: [],
        faults=Faults(),
    )
    with pytest.raises(
        InjectedExtractionClaimantCrash,
        match="memory_extraction_claimant_crash_injected",
    ):
        service.run_once()
    assert store.completed is None
    assert store.failed is None


def test_disabled_contract_refuses_extraction_before_claim_or_model() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions))
    store.get_contract = lambda: MemoryContract(
        contract_epoch=1,
        schema_version="mem00.v1",
        mode="disabled",
        updated_at=datetime.now(UTC),
    )
    called = False

    def extractor(*_):
        nonlocal called
        called = True
        return []

    with pytest.raises(Exception, match="memory_contract_not_active"):
        _service(store, sessions, extractor).run_once()
    assert not called
    assert store.run is not None
