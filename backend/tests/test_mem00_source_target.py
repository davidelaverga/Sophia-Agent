"""Actual producer target planning, without watermark or candidate-state inference."""

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest
from mem00_owner_fixture import declare_memory_owners
from mem00_source_snapshot_fixture import source_snapshot_fixture

from deerflow.sophia.extraction import _PIPELINE_MODEL
from deerflow.sophia.memory_governance.extraction_input import capture_context, extraction_input_ref
from deerflow.sophia.memory_governance.extraction_service import MemoryExtractionService, _manifest_ref, _serialize
from deerflow.sophia.memory_governance.models import ExtractionRun, MemoryContract, OwnerMemoryAuthority
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.source_target import build_source_target, dependencies
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
from deerflow.sophia.session_store import SessionMessageRecord, SessionRecord


def messages(count):
    return [SessionMessageRecord(message_id=f"message-{n}",session_id="session",thread_id="thread",role="user",content=f"SYNTHETIC-{n}",
        sequence=n,memory_source_version=str(UUID(int=n))) for n in range(1,count+1)]


def source(revision=1):
    return SessionRecord(user_id="owner",session_id="session",thread_id="thread",message_revision=revision,memory_processed_until_sequence=1000,status="ended")


def run(items,revision=1,**updates):
    context=capture_context(context_mode="life",session_date="2026-09-09")
    return ExtractionRun(extraction_run_id=uuid4(),user_id="owner",session_id="session",thread_id="thread",transcript_revision=revision,
        sequence_start=items[0].sequence,sequence_end=items[-1].sequence,state="succeeded_nonzero",terminal_candidate_count=2,
        extractor_contract_version="mem00.extract.v1",extractor_model=_PIPELINE_MODEL,extractor_prompt_version="mem0_extraction.md:v1",
        extractor_input_context=context,extractor_input_ref=extraction_input_ref(owner_id="owner",session_id="session",messages=_serialize(items),context=context,model=_PIPELINE_MODEL),
        source_dependencies=dependencies(items),input_manifest_ref=_manifest_ref(user_id="owner",session_id="session",transcript_revision=revision,messages=items)).model_copy(update=updates)


@pytest.fixture(autouse=True)
def refs(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET","s"*32)


def test_actual_producer_queues_correction_below_watermark(monkeypatch,declare_memory_owners):
    original=messages(12)
    history=(run(original[:10],memory_clear_epoch=0),run(original[10:],memory_clear_epoch=0))
    current=list(original)
    current[2]=current[2].model_copy(update={"content":"SYNTHETIC-CORRECTION","memory_source_version":str(uuid4())})
    sessions=MagicMock();sessions.get.return_value=source(2);sessions.read_memory_source_messages.return_value=current
    sessions.list_messages.side_effect=AssertionError("capped source")
    store=MagicMock();store.source_extraction_runs.return_value=history;store.apply_source_target_at_epoch.return_value=SimpleNamespace(run=None)
    store.source_snapshot.return_value=source_snapshot_fixture(source(2),current,epoch=0)
    store.apply_source_target.side_effect=AssertionError("legacy target")
    store.get_owner_authority.return_value=OwnerMemoryAuthority(user_id="owner",authority_state="governed",authority_epoch=1,authority_declared_at="2026-09-09T00:00:00Z")
    store.get_contract.return_value=MemoryContract(contract_epoch=1,schema_version="mem00.v1",mode="enforced",updated_at="2026-09-09T00:00:00Z")
    declare_memory_owners({"owner":"governed"});monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS","owner");monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE","true")
    service=MemoryExtractionService(governance_store=store,session_store=sessions,lease_owner="test",service_name="test")
    service.finalize_and_enqueue_session(user_id="owner",session_id="session",ended_at="2026-09-09T00:00:00Z")
    payload=store.apply_source_target_at_epoch.call_args.kwargs
    assert (payload["p_next_range"]["sequence_start"],payload["p_next_range"]["sequence_end"])==(1,10)
    assert [w["extraction_run_id"] for w in payload["p_reused_runs"]]==[str(history[1].extraction_run_id)]
    assert payload["p_ended_at"]=="2026-09-09T00:00:00Z"
    assert "SYNTHETIC-" not in str(payload)
    store.finalize_processed_session.assert_not_called();store.finalize_and_enqueue_extraction.assert_not_called()


def test_append_reuses_entire_unchanged_original_input():
    current=messages(12);previous=run(current[:10])
    payload=build_source_target(session=source(2),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)
    assert payload["p_reused_runs"][0]["extraction_run_id"]==str(previous.extraction_run_id)
    assert payload["p_next_range"]["sequence_start"]==11 and payload["p_next_range"]["sequence_end"]==12


def test_same_source_reuses_reviewed_batch_instead_of_reproposing():
    current=messages(10);previous=run(current)
    payload=build_source_target(session=source(2),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)
    assert payload["p_next_range"] is None and len(payload["p_reused_runs"])==1


def test_source_target_new_receipt_domain_does_not_reextract_proven_input():
    import json

    current=messages(10);previous=run(current)
    payload=build_source_target(session=source(2),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)
    encoded=json.dumps({key:value for key,value in payload.items() if key not in {"p_idempotency_key","p_request_digest"}},
        sort_keys=True,separators=(",",":"))
    assert payload["p_idempotency_key"]==keyed_ref("source-target-v2",encoded)
    assert payload["p_idempotency_key"]!=keyed_ref("source-target",encoded)
    assert payload["p_next_range"] is None
    assert payload["p_reused_runs"][0]["extraction_run_id"]==str(previous.extraction_run_id)


def test_first_uncovered_range_stops_before_reused_context():
    current=messages(10);previous=run(current[3:6])
    payload=build_source_target(session=source(2),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)
    assert (payload["p_next_range"]["sequence_start"],payload["p_next_range"]["sequence_end"])==(1,3)


def test_unproven_watermark_has_no_authority():
    payload=build_source_target(session=source(),messages=messages(10),runs=(),extractor_model=_PIPELINE_MODEL)
    assert payload["p_next_range"]["sequence_start"]==1


def test_historical_batch_without_database_dependencies_is_not_bootstrapped():
    current=messages(10);previous=run(current,source_dependencies=None)
    with pytest.raises(MemoryGovernanceUnavailable,match="memory_historical_input_unproven"):
        build_source_target(session=source(2),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)


def test_missing_database_versions_never_becomes_empty_success():
    current=messages(1);current[0]=current[0].model_copy(update={"memory_source_version":None})
    with pytest.raises(MemoryGovernanceUnavailable,match="memory_source_versions_unavailable"):
        build_source_target(session=source(),messages=current,runs=(),extractor_model=_PIPELINE_MODEL)


def test_wrong_owner_run_is_not_a_coverage_witness():
    current=messages(1)
    with pytest.raises(MemoryGovernanceUnavailable,match="memory_source_run_scope_invalid"):
        build_source_target(session=source(),messages=current,runs=(run(current,user_id="other"),),extractor_model=_PIPELINE_MODEL)


def test_historical_transcript_only_proof_cannot_certify_full_prompt_input():
    current=messages(1)
    previous=run(current,extractor_input_context=None,extractor_input_ref=None)
    with pytest.raises(MemoryGovernanceUnavailable,match="memory_historical_input_unproven"):
        build_source_target(session=source(),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)


def test_changed_session_context_reextracts_without_a_higher_sequence():
    current=messages(2);previous=run(current)
    changed=source().model_copy(update={"context_mode":"work"})
    payload=build_source_target(session=changed,messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)
    assert not payload["p_reused_runs"]
    assert payload["p_next_range"]["sequence_start"]==1
    assert payload["p_next_range"]["extractor_input_context"]["context_mode"]=="work"


def test_reuse_preserves_original_date_instead_of_recapturing_today():
    current=messages(1);previous=run(current)
    context=previous.extractor_input_context.model_copy(update={"session_date":"2026-01-01"})
    previous=previous.model_copy(update={"extractor_input_context":context,"extractor_input_ref":extraction_input_ref(
        owner_id="owner",session_id="session",messages=_serialize(current),context=context,model=_PIPELINE_MODEL)})
    payload=build_source_target(session=source(2),messages=current,runs=(previous,),extractor_model=_PIPELINE_MODEL)
    assert payload["p_next_range"] is None
    assert payload["p_reused_runs"][0]["extractor_input_context"]["session_date"]=="2026-01-01"
