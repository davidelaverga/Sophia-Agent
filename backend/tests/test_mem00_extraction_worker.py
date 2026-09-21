from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name
from mem00_source_snapshot_fixture import source_snapshot_fixture

from deerflow.sophia.extraction import _PIPELINE_MODEL
from deerflow.sophia.memory_governance.extraction_input import capture_context, extraction_input_ref
from deerflow.sophia.memory_governance.extraction_service import (
    MemoryExtractionService,
    _manifest_ref,
    _serialize,
)
from deerflow.sophia.memory_governance.faults import InjectedExtractionClaimantCrash
from deerflow.sophia.memory_governance.models import ExtractionRun, MemoryContract, OwnerMemoryAuthority, SourceRecoveryClaim
from deerflow.sophia.memory_governance.source_target import dependencies
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord


@pytest.fixture(autouse=True)
def _memory_ref_secret(monkeypatch: pytest.MonkeyPatch, declare_memory_owners) -> None:  # noqa: F811 - pytest fixture request
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "m" * 32)
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "owner-1")
    monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE", "true")
    declare_memory_owners({"owner-1": "governed"})


def _message(sequence: int, *, content: str = "synthetic transcript text") -> SessionMessageRecord:
    return SessionMessageRecord(
        message_id=f"message-{sequence}",
        session_id="session-1",
        thread_id="thread-1",
        role="user" if sequence % 2 else "assistant",
        content=content,
        sequence=sequence,
        memory_source_version=str(UUID(int=sequence)),
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

    def read_memory_source_messages(self, user_id: str, session_id: str, *, expected_revision: int) -> list[SessionMessageRecord]:
        assert expected_revision == self.record.message_revision
        return self.list_messages(user_id, session_id)

    def list_sessions(self, user_id: str) -> list[SessionRecord]:
        assert user_id == "owner-1"
        return [self.record]


def _run(sessions: _Sessions, *, state: str = "leased") -> ExtractionRun:
    selected = sessions.messages[1:]
    context = capture_context(context_mode=sessions.record.context_mode, session_date="2026-01-01")
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
        extractor_model=_PIPELINE_MODEL,
        extractor_prompt_version="mem0_extraction.md:v1",
        source_dependencies=dependencies(selected),
        extractor_input_context=context,
        extractor_input_ref=extraction_input_ref(owner_id="owner-1", session_id="session-1", messages=_serialize(selected), context=context, model=_PIPELINE_MODEL),
        state=state,
        memory_clear_epoch=0,
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
        self.target_failure = None
        self.recovery_claimed = False
        self.recovery_outcome = None
        self.recovery_expiry = datetime.now(UTC) + timedelta(minutes=5)

    def claim_source_recovery(self, *, user_id, lease_owner):
        if self.recovery_claimed:
            return None
        self.recovery_claimed = True
        return SourceRecoveryClaim(user_id=user_id, session_id="session-1", sweep_id=uuid4(), lease_token=uuid4(), lease_owner=lease_owner, lease_expires_at=self.recovery_expiry)

    def complete_source_recovery(self, claim, *, outcome):
        self.recovery_outcome = outcome

    def source_extraction_runs(self, *, user_id, session_id):
        assert (user_id, session_id) == ("owner-1", "session-1")
        first = [_message(1)]
        context = capture_context(context_mode="life", session_date="2026-01-01")
        previous = ExtractionRun(
            extraction_run_id=UUID(int=999),
            user_id=user_id,
            session_id=session_id,
            thread_id="thread-1",
            transcript_revision=7,
            sequence_start=1,
            sequence_end=1,
            state="succeeded_zero",
            terminal_candidate_count=0,
            memory_clear_epoch=0,
            extractor_contract_version="mem00.extract.v1",
            extractor_model=_PIPELINE_MODEL,
            extractor_prompt_version="mem0_extraction.md:v1",
            extractor_input_context=context,
            extractor_input_ref=extraction_input_ref(owner_id=user_id, session_id=session_id, messages=_serialize(first), context=context, model=_PIPELINE_MODEL),
            source_dependencies=dependencies(first),
            input_manifest_ref=_manifest_ref(user_id=user_id, session_id=session_id, transcript_revision=7, messages=first),
        )
        return (previous,) + ((self.completed_result,) if self.completed_result and self.completed_result.state != "superseded" else ())

    def source_snapshot(self, *, user_id, session_id, thread_id):
        assert (user_id, session_id, thread_id) == ("owner-1", "session-1", "thread-1")
        return source_snapshot_fixture(self.sessions.record, self.sessions.messages, epoch=0)

    def apply_source_target_at_epoch(self, **payload):
        if self.target_failure:
            raise self.target_failure
        selected = payload["p_next_range"]
        observed = {**payload, **({"p_sequence_start": selected["sequence_start"], "p_sequence_end": selected["sequence_end"], "p_input_manifest_ref": selected["input_manifest_ref"]} if selected else {})}
        if payload["p_ended_at"] is None:
            self.enqueued = observed
        else:
            self.finalized = observed
        return SimpleNamespace(run=self.enqueue_result if selected else None)

    def apply_source_target(self, **payload):
        raise AssertionError("legacy source target must not be called")

    def get_owner_authority(self, owner):
        assert owner == "owner-1"
        return OwnerMemoryAuthority(user_id=owner, authority_state="governed", authority_epoch=1, authority_declared_at=datetime.now(UTC))

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

    def authorize_extraction_dispatch(self, **payload):
        from mem00_dispatch_fixture import dispatch_receipt

        return dispatch_receipt(payload, session_id="session-1", thread_id="thread-1")

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
    store.sessions = sessions
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


def test_parent_revision_alone_does_not_invalidate_unchanged_input() -> None:
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
    assert called
    assert store.completed[1] == store.completed[0].input_manifest_ref
    assert store.completed_result.state == "succeeded_nonzero"
    assert store.enqueued["p_next_range"] is None


def test_replacement_enqueue_failure_keeps_stale_run_retryable() -> None:
    sessions = _Sessions(revision=8)
    run_sessions = _Sessions(revision=7)
    store = _Governance(_run(run_sessions))
    sessions.messages[1] = sessions.messages[1].model_copy(update={"content": "SYNTHETIC-CORRECTED", "memory_source_version": str(uuid4())})
    store.target_failure = MemoryGovernanceUnavailable("memory_source_runs_changed")

    with pytest.raises(MemoryGovernanceUnavailable, match="memory_source_runs_changed"):
        _service(store, sessions, lambda *_: []).run_once()

    assert store.completed is None
    assert store.failed[1:] == ("memory_extraction_worker_failed", True)


def test_source_realign_without_new_run_never_reports_replacement_queued(monkeypatch):
    from unittest.mock import Mock

    sessions = _Sessions()
    store = _Governance(_run(sessions))
    service = _service(store, sessions, Mock(side_effect=AssertionError("ineligible source reached model")))
    sessions.messages[1] = sessions.messages[1].model_copy(update={"content": "SYNTHETIC-CHANGED", "memory_source_version": str(uuid4())})
    monkeypatch.setattr(service, "enqueue_finalized_session", Mock(return_value=None))
    event = Mock()
    monkeypatch.setattr("deerflow.sophia.memory_governance.extraction_service.emit_memory_event", event)
    # Realignment that produced no replacement did no work. It used to report
    # True, which the worker reads as "work happened" and therefore skips its
    # poll delay -- see the bounded-failure regression below.
    assert service.run_once() is False
    assert store.completed is None
    assert event.call_args.args == ("memory.extraction.source_realigned",)
    assert event.call_args.kwargs["outcome"] == "no_current_run"


def test_source_realign_without_new_run_records_a_bounded_failure(monkeypatch):
    """A realignment that cannot progress must consume the retry budget.

    Regression for the 2026-09-21 outage. When a run's source could not be
    realigned and no replacement was queued, this path returned True without
    recording a failure. ``MemoryGovernanceWorker._run`` treats a True result
    as work and skips its poll delay entirely, so the claim/realign cycle ran
    with no pause; because ``fail_extraction`` was never reached, the run stayed
    leased, ``sophia_memory_claim_extraction`` re-leased it on the very next
    iteration, and the eight-attempt budget was never consulted. One run held
    that loop for fourteen hours and saturated the PostgREST connection pool,
    which in turn fail-closed the gateway and langgraph startup probes.
    """

    from unittest.mock import Mock

    sessions = _Sessions()
    store = _Governance(_run(sessions))
    service = _service(store, sessions, Mock(side_effect=AssertionError("ineligible source reached model")))
    sessions.messages[1] = sessions.messages[1].model_copy(update={"content": "SYNTHETIC-CHANGED", "memory_source_version": str(uuid4())})
    monkeypatch.setattr(service, "enqueue_finalized_session", Mock(return_value=None))

    assert service.run_once() is False
    assert store.completed is None
    # Durably failed, so the existing backoff and attempt budget bound the run
    # instead of it remaining leased and immediately re-claimable.
    assert store.failed[1:] == ("memory_extraction_source_realignment_unavailable", True)


@pytest.mark.parametrize("epoch", [None, 1])
def test_claimed_run_without_current_epoch_never_constructs_sdk(monkeypatch, epoch):
    from unittest.mock import Mock

    from deerflow.sophia import extraction

    sessions = _Sessions()
    store = _Governance(_run(sessions).model_copy(update={"memory_clear_epoch": epoch}))
    sdk = Mock(side_effect=AssertionError("epoch changed before SDK construction"))
    monkeypatch.setattr(extraction.anthropic, "Anthropic", sdk)
    with pytest.raises(MemoryGovernanceUnavailable, match="source_epoch_changed"):
        _service(store, sessions, None).run_once()
    sdk.assert_not_called()
    assert store.completed is None and store.failed[2] is True


def test_successful_zero_candidate_run_is_terminal_and_range_bound() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions))
    assert _service(store, sessions, lambda *_: []).run_once()
    assert store.completed[2] == ()


def test_real_extractor_parse_failure_retries_without_advancing_cursor(monkeypatch) -> None:
    from types import SimpleNamespace
    from unittest.mock import Mock

    from deerflow.sophia import extraction

    monkeypatch.setattr(extraction, "_load_template", lambda: "Extract {transcript}")
    sessions = _Sessions()
    store = _Governance(_run(sessions))
    client = Mock()
    client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(text="not JSON")], stop_reason="end_turn")
    monkeypatch.setattr(extraction.anthropic, "Anthropic", lambda **kwargs: client)
    with pytest.raises(extraction.MemoryWriteError):
        _service(store, sessions, None).run_once()
    assert store.completed is None
    assert store.failed[1:] == ("memory_extraction_worker_failed", True)
    assert sessions.record.memory_processed_until_sequence == 1


@pytest.mark.parametrize("boundary", ["source_read", "model_return"])
def test_worker_rechecks_disabled_producer_before_model_and_commit(monkeypatch, boundary):
    from unittest.mock import Mock

    sessions = _Sessions()
    store = _Governance(_run(sessions))

    def disable():
        monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE", "false")

    def source(*_):
        if boundary == "source_read":
            disable()
        return sessions.messages

    def extract(*_):
        disable()
        return [{"content": "synthetic candidate"}]

    monkeypatch.setattr(sessions, "list_messages", source)
    extractor = Mock(side_effect=extract)
    with pytest.raises(MemoryGovernanceUnavailable, match="memory_extraction_disabled"):
        _service(store, sessions, extractor).run_once()
    assert extractor.call_count == (boundary == "model_return")
    assert store.completed is None and store.failed[2] is True
    assert sessions.record.memory_processed_until_sequence == 1


def test_queued_model_pin_matches_actual_extractor_model() -> None:
    from deerflow.sophia.extraction import _PIPELINE_MODEL

    sessions = _Sessions()
    store = _Governance(_run(sessions))
    _service(store, sessions, None).enqueue_finalized_session(user_id="owner-1", session_id="session-1")
    assert store.enqueued["p_extractor_model"] == _PIPELINE_MODEL


@pytest.mark.parametrize("entry", ["enqueue", "finalize", "worker"])
def test_extraction_denies_incomplete_source_before_any_success(monkeypatch, entry):
    from unittest.mock import Mock

    from deerflow.sophia.session_store import SessionEvidenceIntegrityError

    sessions = _Sessions()
    store = _Governance(_run(sessions))
    complete_source = Mock(side_effect=SessionEvidenceIntegrityError("memory_source_budget_exhausted"))
    monkeypatch.setattr(sessions, "read_memory_source_messages", complete_source)
    extractor = Mock(return_value=[])
    service = _service(store, sessions, extractor)
    with pytest.raises(MemoryGovernanceUnavailable, match="memory_source_snapshot_read_unavailable"):
        if entry == "enqueue":
            service.enqueue_finalized_session(user_id="owner-1", session_id="session-1")
        elif entry == "finalize":
            service.finalize_and_enqueue_session(user_id="owner-1", session_id="session-1", ended_at="2026-09-09T00:00:00Z")
        else:
            service.run_once()
    complete_source.assert_called_once_with("owner-1", "session-1", expected_revision=7)
    extractor.assert_not_called()
    assert store.enqueued is None and store.finalized is None and store.completed is None
    if entry == "worker":
        assert store.failed[1:] == ("memory_extraction_worker_failed", True)


def test_restart_recovery_idempotently_enqueues_unprocessed_ended_session() -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions, state="queued"))

    recovered = _service(store, sessions, lambda *_: []).recover_finalized_sessions(
        user_ids=("owner-1",),
    )

    assert recovered == 1
    assert store.recovery_outcome == "target_checked"
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


def test_slow_source_cannot_report_a_successful_expired_recovery_claim(monkeypatch) -> None:
    sessions = _Sessions()
    store = _Governance(_run(sessions, state="queued"))

    class AfterSourceRead:
        @staticmethod
        def now(zone):
            return store.recovery_expiry + timedelta(seconds=1)

    monkeypatch.setattr("deerflow.sophia.memory_governance.extraction_service.datetime", AfterSourceRead)
    assert _service(store, sessions, lambda *_: []).recover_finalized_sessions(user_ids=("owner-1",), limit=1) == 1
    assert store.recovery_outcome == "retryable_failure"


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


@pytest.mark.parametrize("case", ["unknown", "legacy", "missing", "outage", "wrong_owner", "off", "decohort"])
@pytest.mark.parametrize("operation", ["claim", "enqueue", "recover"])
def test_owner_authority_denial_precedes_source_and_keeps_claim_retryable(monkeypatch, case, operation):
    from unittest.mock import Mock

    sessions = _Sessions()
    store = _Governance(_run(sessions))
    authority = store.get_owner_authority("owner-1")
    if case in {"unknown", "legacy"}:
        authority = authority.model_copy(update={"authority_state": case})
    if case == "wrong_owner":
        authority = authority.model_copy(update={"user_id": "different-owner"})
    store.get_owner_authority = Mock(return_value=None if case == "missing" else authority)
    if case == "outage":
        store.get_owner_authority.side_effect = RuntimeError("PRIVATE_DATABASE_ERROR")
    if case == "off":
        monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE", "false")
    if case == "decohort":
        monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "different-owner")
    source = Mock(side_effect=AssertionError("source read before authority"))
    for name in ("get", "list_messages", "list_sessions"):
        monkeypatch.setattr(sessions, name, source)
    extractor = Mock(side_effect=AssertionError("model before authority"))
    service = _service(store, sessions, extractor)
    with pytest.raises(MemoryGovernanceUnavailable):
        if operation == "claim":
            service.run_once()
        elif operation == "enqueue":
            service.enqueue_finalized_session(user_id="owner-1", session_id="session-1")
        else:
            service.recover_finalized_sessions(user_ids=("owner-1",))
    source.assert_not_called()
    extractor.assert_not_called()
    assert store.completed is None and store.enqueued is None and store.finalized is None
    assert (store.failed is not None) == (operation == "claim")
    if store.failed:
        assert store.failed[2] is True
    assert sessions.record.memory_processed_until_sequence == 1
