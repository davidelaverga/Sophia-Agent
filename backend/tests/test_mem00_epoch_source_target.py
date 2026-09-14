"""Epoch partition preparation: not an SQL admission or release certificate."""

from copy import deepcopy
from unittest.mock import Mock
from uuid import UUID

import pytest
from mem00_owner_fixture import declare_memory_owners
from pydantic import ValidationError
from test_mem00_source_target import messages, run, source

from deerflow.sophia.extraction import _PIPELINE_MODEL
from deerflow.sophia.memory_governance.source_snapshot import EpochSourceTargetReceipt, SourceSnapshot, read_snapshot_source_messages, read_source_snapshot
from deerflow.sophia.memory_governance.source_target import build_source_target_at_epoch
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore


@pytest.fixture(autouse=True)
def refs(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)


def snapshot_dict(items, epoch=1):
    return {"schema": "mem00.source-snapshot.v1", "snapshot_id": "mem00-source-snapshot-" + "a" * 32,
        "owner_id": "owner", "session_id": "session", "thread_id": "thread", "transcript_revision": 1,
        "memory_clear_epoch": epoch, "context_mode": "life", "status": "ended", "ended_at": None,
        "sources": [{"message_id": m.message_id, "sequence": m.sequence, "source_version": m.memory_source_version,
            "acceptance_epoch": epoch, "accepted_version": m.memory_source_version, "eligibility": "eligible"} for m in items]}


def plan(items, snapshot, runs=(), **kwargs):
    return build_source_target_at_epoch(session=source(), messages=items, runs=runs, extractor_model=_PIPELINE_MODEL,
        snapshot=SourceSnapshot.model_validate(snapshot), **kwargs)


def test_new_statements_do_not_share_model_range_with_old_or_late_edited_source():
    items = messages(5); snapshot = snapshot_dict(items)
    for index in [0, 1]:
        snapshot["sources"][index].update(acceptance_epoch=0, accepted_version=None, eligibility="before_clear")
    snapshot["sources"][3].update(accepted_version=str(UUID(int=99)), eligibility="accepted_version_changed")
    previous = run(items[:2], memory_clear_epoch=0, extractor_input_context=None, extractor_input_ref=None, source_dependencies=None)
    payload = plan(items, snapshot, (previous,))
    assert (payload["p_next_range"]["sequence_start"], payload["p_next_range"]["sequence_end"]) == (3, 3)
    assert payload["p_reused_runs"] == []
    assert len(payload["p_observed_runs"]) == 1
    assert payload["p_expected_clear_epoch"] == 1
    assert payload["p_source_snapshot"] == snapshot
    assert "SYNTHETIC-" not in str(payload)
    current = run(items[2:3], memory_clear_epoch=1)
    next_payload = plan(items, snapshot, (previous, current))
    assert (next_payload["p_next_range"]["sequence_start"], next_payload["p_next_range"]["sequence_end"]) == (5, 5)
    assert len(next_payload["p_reused_runs"]) == 1


def test_all_excluded_is_a_partition_not_proof_of_successful_zero():
    items = messages(2); snapshot = snapshot_dict(items)
    for row in snapshot["sources"]:
        row.update(acceptance_epoch=0, accepted_version=None, eligibility="before_clear")
    payload = plan(items, snapshot)
    assert payload["p_next_range"] is None
    assert len(payload["p_source_snapshot"]["sources"]) == 2
    assert "extraction_complete" not in payload


@pytest.mark.parametrize("epoch", [None, -1, True, 2, "1"])
def test_missing_or_invalid_run_epoch_is_not_silently_historical(epoch):
    items = messages(2)
    with pytest.raises(MemoryGovernanceUnavailable, match="run_epoch_unproven"):
        plan(items, snapshot_dict(items), (run(items, memory_clear_epoch=epoch),))


def test_current_epoch_unproven_historical_input_still_denies():
    items = messages(2)
    with pytest.raises(MemoryGovernanceUnavailable, match="historical_input_unproven"):
        plan(items, snapshot_dict(items), (run(items, memory_clear_epoch=1, extractor_input_ref=None),))


@pytest.mark.parametrize("field,value", [("owner_id", "wrong"), ("session_id", "wrong"), ("thread_id", "wrong"),
    ("transcript_revision", 2), ("status", "active"), ("context_mode", "work"), ("ended_at", "2026-09-09T00:00:00Z")])
def test_snapshot_scope_must_match_the_complete_reader(field, value):
    items = messages(2); snapshot = snapshot_dict(items); snapshot[field] = value
    with pytest.raises(MemoryGovernanceUnavailable, match="snapshot_scope_changed"):
        plan(items, snapshot)


@pytest.mark.parametrize("change", ["omitted", "duplicate", "version", "wrong_thread", "wrong_session"])
def test_full_reader_mismatch_is_unavailable_not_harmless_exclusion(change):
    items = messages(2); snapshot = snapshot_dict(items)
    if change == "omitted": items.pop()
    elif change == "duplicate": items.append(items[0])
    elif change == "version": items[0] = items[0].model_copy(update={"memory_source_version": str(UUID(int=99))})
    elif change == "wrong_thread": items[0] = items[0].model_copy(update={"thread_id": "wrong"})
    else: items[0] = items[0].model_copy(update={"session_id": "wrong"})
    with pytest.raises(MemoryGovernanceUnavailable, match="snapshot_versions_changed"):
        plan(items, snapshot)


@pytest.mark.parametrize("field,value", [("acceptance_epoch", 2), ("acceptance_epoch", True), ("acceptance_epoch", "1"),
    ("source_version", "unknown"), ("sequence", True), ("sequence", 0), ("eligibility", "before_clear"),
    ("accepted_version", None), ("accepted_version", str(UUID(int=99))), ("unexpected_content", "secret")])
def test_partition_rejects_unproven_types_scope_and_extra_fields(field, value):
    snapshot = snapshot_dict(messages(1)); snapshot["sources"][0][field] = value
    with pytest.raises(ValidationError): SourceSnapshot.model_validate(snapshot)


@pytest.mark.parametrize("change", ["duplicate_id", "duplicate_sequence", "reordered", "bad_epoch", "extra_text", "bad_timestamp"])
def test_snapshot_rejects_malformed_envelopes(change):
    snapshot = snapshot_dict(messages(2))
    if change == "duplicate_id": snapshot["sources"][1]["message_id"] = snapshot["sources"][0]["message_id"]
    elif change == "duplicate_sequence": snapshot["sources"][1]["sequence"] = 1
    elif change == "reordered": snapshot["sources"].reverse()
    elif change == "bad_epoch": snapshot["memory_clear_epoch"] = True
    elif change == "extra_text": snapshot["content"] = "secret"
    else: snapshot["ended_at"] = "2026-09-09T00:00:00"
    with pytest.raises(ValidationError): SourceSnapshot.model_validate(snapshot)


def test_snapshot_model_copy_cannot_bypass_partition_validation():
    items = messages(1)
    snapshot = SourceSnapshot.model_validate(snapshot_dict(items)).model_copy(update={"memory_clear_epoch": 2})
    with pytest.raises(MemoryGovernanceUnavailable, match="snapshot_unavailable"):
        build_source_target_at_epoch(session=source(), messages=items, runs=(), extractor_model=_PIPELINE_MODEL, snapshot=snapshot)


@pytest.mark.parametrize("database,record", [("active", "open"), ("resumable", "paused"), ("ended", "ended")])
def test_actual_session_store_status_mapping_is_preserved(database, record):
    items = messages(1); value = snapshot_dict(items); value["status"] = database
    snapshot = SourceSnapshot.model_validate(value)
    session = source().model_copy(update={"status": record})
    assert build_source_target_at_epoch(session=session, messages=items, runs=(), extractor_model=_PIPELINE_MODEL, snapshot=snapshot)["p_next_range"]


def test_sql_microseconds_match_the_actual_session_reader_millisecond_projection():
    items = messages(1); value = snapshot_dict(items); value["ended_at"] = "2026-09-09T08:40:00.123456+00:00"
    snapshot = SourceSnapshot.model_validate(value)
    session = source().model_copy(update={"ended_at": "2026-09-09T08:40:00.123Z"})
    result = build_source_target_at_epoch(session=session, messages=items, runs=(), extractor_model=_PIPELINE_MODEL, snapshot=snapshot)
    assert result["p_source_snapshot"]["ended_at"] == "2026-09-09T08:40:00.123456+00:00"


def test_epoch_and_complete_partition_are_bound_into_original_command_identity():
    items = messages(2); first = snapshot_dict(items, epoch=1); second = snapshot_dict(items, epoch=2)
    assert plan(items, first)["p_idempotency_key"] != plan(items, second)["p_idempotency_key"]
    changed = deepcopy(first); changed["snapshot_id"] = "mem00-source-snapshot-" + "b" * 32
    assert plan(items, first)["p_request_digest"] != plan(items, changed)["p_request_digest"]


def test_reader_uses_fixed_rpc_and_sanitizes_failure():
    store = object.__new__(SupabaseMemoryGovernanceStore); store._rpc = Mock(return_value=snapshot_dict(messages(1)))
    assert read_source_snapshot(store=store, session=source()).memory_clear_epoch == 1
    store._rpc.assert_called_once_with("sophia_memory_source_snapshot", {"p_user_id": "owner", "p_session_id": "session", "p_thread_id": "thread"})
    store._rpc.side_effect = RuntimeError("SYNTHETIC secret database error")
    with pytest.raises(MemoryGovernanceUnavailable, match="^memory_source_snapshot_unavailable$"):
        read_source_snapshot(store=store, session=source())


def target_receipt():
    items = messages(1); snapshot = snapshot_dict(items)
    return {"schema": "mem00.source-target-at-epoch.v1", "event_id": str(UUID(int=10)),
        "run": {**run(items, memory_clear_epoch=1).model_dump(mode="json", by_alias=True), "sql_internal_column": "SYNTHETIC INTERNAL"},
        "invalidated_count": 0, "source_manifest_ref": "hmac-sha256:transcript-manifest:" + "a" * 64,
        "idempotent_replay": False, "historical_result_only": True, "memory_clear_epoch": 1,
        "source_snapshot": snapshot, "source_target": deepcopy(snapshot), "extractor_contract_version": "mem00.extract.v1"}


def test_complete_sql_run_is_projected_before_typed_receipt_serialization():
    value = EpochSourceTargetReceipt.model_validate(target_receipt()).model_dump(mode="json", by_alias=True)
    assert "sql_internal_column" not in value["run"]
    assert "SYNTHETIC INTERNAL" not in str(value)
    assert value["run"]["memory_clear_epoch"] == 1


@pytest.mark.parametrize("change", ["numeric_historical", "string_replay", "wrong_epoch", "wrong_run_owner", "unknown_run_epoch",
    "changed_partition", "wrong_source_manifest", "wrong_schema", "unknown_property", "negative_count"])
def test_target_receipt_rejects_malformed_or_wrong_scope(change):
    value = target_receipt()
    if change == "numeric_historical": value["historical_result_only"] = 1
    elif change == "string_replay": value["idempotent_replay"] = "true"
    elif change == "wrong_epoch": value["memory_clear_epoch"] = 0
    elif change == "wrong_run_owner": value["run"]["user_id"] = "other"
    elif change == "unknown_run_epoch": value["run"].pop("memory_clear_epoch")
    elif change == "changed_partition": value["source_target"]["sources"].pop()
    elif change == "wrong_source_manifest": value["source_manifest_ref"] = "not-proof"
    elif change == "wrong_schema": value["schema"] = "old"
    elif change == "unknown_property": value["content"] = "SYNTHETIC INTERNAL"
    else: value["invalidated_count"] = -1
    with pytest.raises(ValidationError): EpochSourceTargetReceipt.model_validate(value)


def test_fixed_epoch_rpc_receipt_binding_and_no_fallback():
    value = target_receipt(); items = messages(1)
    payload = plan(items, snapshot_dict(items)); payload["p_target_manifest_ref"] = value["source_manifest_ref"]
    store = object.__new__(SupabaseMemoryGovernanceStore); store._rpc = Mock(return_value=value)
    assert store.apply_source_target_at_epoch(**payload).event_id == value["event_id"]
    store._rpc.assert_called_once_with("sophia_memory_apply_source_target_at_epoch", payload)
    with pytest.raises(MemoryGovernanceUnavailable, match="epoch_source_target_unavailable"):
        store.apply_source_target_at_epoch(**{**payload, "p_expected_clear_epoch": 2})
    store._rpc.side_effect = RuntimeError("SYNTHETIC PRIVATE ERROR")
    with pytest.raises(MemoryGovernanceUnavailable, match="^memory_epoch_source_target_unavailable$"):
        store.apply_source_target_at_epoch(**payload)
    assert all(call.args[0] == "sophia_memory_apply_source_target_at_epoch" for call in store._rpc.call_args_list)


def test_complete_source_occurrences_are_not_display_deduplicated():
    from deerflow.sophia.session_store import canonical_visible_messages

    items = [message.model_copy(update={"content": "SYNTHETIC SAME WORDS", "created_at": "2026-09-09T00:00:00.000Z",
        "provider_event_id": "same-provider-reference", "turn_id": "same-turn-reference"}) for message in messages(2)]
    assert len(canonical_visible_messages(items)) == 1  # Existing display contract remains unchanged.
    sessions = Mock(); sessions.read_memory_source_messages.return_value = items
    result = read_snapshot_source_messages(session_store=sessions, session=source(), snapshot=SourceSnapshot.model_validate(snapshot_dict(items)))
    assert result == items
    sessions.read_memory_source_messages.assert_called_once_with("owner", "session", expected_revision=1)
    sessions.list_messages.assert_not_called()


def test_snapshot_reader_uses_exact_sql_visibility_without_rewriting_text():
    items = messages(5)
    items[0] = items[0].model_copy(update={"content": "\t"})
    items[1] = items[1].model_copy(update={"content": "   "})
    items[2] = items[2].model_copy(update={"final": False})
    items[3] = items[3].model_copy(update={"role": "tool"})
    selected = [items[0], items[4]]
    sessions = Mock(); sessions.read_memory_source_messages.return_value = items
    assert read_snapshot_source_messages(session_store=sessions, session=source(), snapshot=SourceSnapshot.model_validate(snapshot_dict(selected))) == selected


def test_snapshot_reader_outage_never_becomes_empty_or_falls_back():
    sessions = Mock(); sessions.read_memory_source_messages.side_effect = RuntimeError("SYNTHETIC PRIVATE FAILURE")
    with pytest.raises(MemoryGovernanceUnavailable, match="^memory_source_snapshot_read_unavailable$"):
        read_snapshot_source_messages(session_store=sessions, session=source(), snapshot=SourceSnapshot.model_validate(snapshot_dict([])))
    sessions.list_messages.assert_not_called()
