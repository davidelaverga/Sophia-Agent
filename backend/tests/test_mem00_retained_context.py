"""Decision-only tests. Runtime integration and rotation are separate gates."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest

from deerflow.sophia.memory_governance.retained_context import MemoryInclusion, RetainedMemoryContext, RevocationDelta, context_transition, decode_context_manifest, encode_context_manifest, observe_context_transition, read_revocation_deltas

OWN = "hmac-sha256:owner:test-owner"
A, B = UUID(int=1), UUID(int=2)
CONTEXT = RetainedMemoryContext(OWN, 3, (MemoryInclusion(A, 1, 1),))


def decide(**kwargs):
    return context_transition(**{"context": CONTEXT, "owner_ref": OWN, "current_epoch": 3, **kwargs})


@pytest.mark.parametrize("epoch", [None, -1, True, "3"])
def test_unavailable_or_malformed_governance_never_continues(epoch):
    assert decide(current_epoch=epoch).action == "zero_memory"


def test_owner_change_is_not_a_context_refresh():
    assert decide(owner_ref="different-owner").action == "zero_memory"


def test_epoch_regression_is_not_continuation():
    assert decide(current_epoch=2).action == "zero_memory"


def test_missing_manifest_requires_rotation_even_at_epoch_zero():
    assert decide(context=None, current_epoch=0).action == "rotate"


def test_addition_without_revocation_does_not_rotate():
    assert decide().action == "continue"


def test_included_memory_change_rotates_before_next_input():
    result = decide(current_epoch=4, deltas=(RevocationDelta(OWN, 4, A),), delta_complete=True)
    assert result.action == "rotate"
    assert result.reason == "included_memory_revoked"


def test_unrelated_revocation_refreshes_epoch_without_reconnect():
    result = decide(current_epoch=4, deltas=(RevocationDelta(OWN, 4, B),), delta_complete=True)
    assert result.action == "continue"
    assert result.next_epoch == 4


@pytest.mark.parametrize(
    "complete,deltas",
    [
        (False, (RevocationDelta(OWN, 4, B),)),
        (True, ()),
        (True, (RevocationDelta("wrong-owner", 4, B),)),
        (True, (RevocationDelta(OWN, 4, None),)),
        (True, (RevocationDelta(OWN, 3, B),)),
        (True, (RevocationDelta(OWN, 4, B), RevocationDelta(OWN, 4, B))),
    ],
)
def test_unprovable_delta_requires_conservative_rotation(complete, deltas):
    assert decide(current_epoch=4, deltas=deltas, delta_complete=complete).action == "rotate"


def test_missing_intermediate_epoch_cannot_be_hidden_by_latest_event():
    assert decide(current_epoch=5, deltas=(RevocationDelta(OWN, 5, B),), delta_complete=True).action == "rotate"


@pytest.mark.parametrize(
    "inclusions",
    [
        (MemoryInclusion(A, 1, 1), MemoryInclusion(A, 2, 2)),
        (MemoryInclusion(A, 0, 1),),
        (MemoryInclusion(A, 1, True),),
        (MemoryInclusion("not-a-uuid", 1, 1),),
    ],
)
def test_bad_inclusion_manifest_is_never_trusted(inclusions):
    assert decide(context=replace(CONTEXT, inclusions=inclusions)).action == "rotate"


def test_huge_epoch_gap_is_bounded_and_fail_closed():
    assert decide(current_epoch=10**20, deltas=(), delta_complete=True).action == "rotate"


def test_contradictory_delta_at_same_epoch_does_not_continue():
    assert decide(deltas=(RevocationDelta(OWN, 4, A),)).action == "rotate"


@pytest.mark.parametrize("context", [{}, RetainedMemoryContext(OWN, 3, None)])
def test_unvalidated_context_shape_requires_rebuild(context):
    assert decide(context=context).action == "rotate"


def event(event_id=1, **fields):
    return {"event_id": str(UUID(int=event_id)), "user_id": "test-owner", "memory_id": str(A), "event_type": "memory_edited", "user_revocation_epoch": 4, **fields}


class DeltaStore:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.requests = []

    def _request(self, method, table, *, params):
        assert method == "GET"
        assert table == "sophia_memory_governance_events"
        assert params["user_id"] == "eq.test-owner"
        assert params["and"] == "(user_revocation_epoch.gt.3,user_revocation_epoch.lte.4)"
        assert set(params["select"].split(",")) == set(event())
        self.requests.append(params)
        return next(self.pages)


def read(store, **kwargs):
    return read_revocation_deltas(store, user_id="test-owner", owner_ref=OWN, after_epoch=3, through_epoch=4, **kwargs)


def test_short_delta_pages_require_empty_page_and_owner_keyset():
    store = DeltaStore([[event()], [event(2, event_type="memory_restored")], []])
    assert read(store) == (RevocationDelta(OWN, 4, A),)
    assert len(store.requests) == 3
    assert store.requests[1]["event_id"] == f"gt.{UUID(int=1)}"
    assert store.requests[2]["event_id"] == f"gt.{UUID(int=2)}"


@pytest.mark.parametrize("kind", ["memory_source_action_accepted", "model_dispatch_authorized", "model_result_observed",
    "builder_source_handoff_recorded", "builder_source_run_bound"])
def test_source_and_model_observations_preserve_exact_revocation_delta(kind):
    rows = [[event(memory_id=str(B), event_type="memory_tombstoned"), event(2, event_type=kind, memory_id=None)], []]
    deltas = read(DeltaStore(rows))
    assert deltas == (RevocationDelta(OWN, 4, B),)
    assert decide(current_epoch=4, deltas=deltas, delta_complete=True).action == "continue"
    assert decide(context=RetainedMemoryContext(OWN, 3, ()), current_epoch=4, deltas=deltas, delta_complete=True).action == "continue"


@pytest.mark.parametrize("kind", ["memory_source_action_accepted", "model_dispatch_authorized", "model_result_observed",
    "builder_source_handoff_recorded", "builder_source_run_bound"])
def test_nonrevoking_observations_cannot_fill_missing_revocation_epoch(kind):
    deltas = read(DeltaStore([[event(event_type=kind, memory_id=None)], []]))
    assert deltas == ()
    assert decide(current_epoch=4, deltas=deltas, delta_complete=True).action == "rotate"
    assert decide(context=RetainedMemoryContext(OWN, 3, ()), current_epoch=4, deltas=deltas, delta_complete=True).action == "rotate"


@pytest.mark.parametrize(
    "pages,reason",
    [
        ([[event(user_id="wrong-owner")]], "row_invalid"),
        ([[event(content="must-never-be-selected")]], "row_invalid"),
        ([[event(event_type="unknown_future_policy")]], "event_unknown"),
        ([[event(user_revocation_epoch=5)]], "epoch_invalid"),
        ([[event(user_revocation_epoch=True)]], "epoch_invalid"),
        ([[event()], [event()]], "not_advancing"),
        ([{}], "page_invalid"),
    ],
)
def test_delta_reader_refuses_uncertainty(pages, reason):
    with pytest.raises(ValueError, match=reason):
        read(DeltaStore(pages))


def test_delta_page_cap_does_not_return_partial_success():
    with pytest.raises(ValueError, match="page_cap"):
        read(DeltaStore([[event()]]), max_pages=1)


def test_deletion_receipt_with_missing_memory_id_forces_rotation():
    deltas = read(DeltaStore([[event(memory_id=None, event_type="memory_tombstoned")], []]))
    assert decide(current_epoch=4, deltas=deltas, delta_complete=True).action == "rotate"


def observation_store():
    store = DeltaStore([[event(memory_id=str(B))], []])
    store.get_contract = Mock(return_value=SimpleNamespace(mode="enforced", schema_version="mem00.v1", contract_epoch=1))
    store.get_user_governance = Mock(return_value=SimpleNamespace(user_id="test-owner", user_revocation_epoch=4, provider_subject="pinned-subject"))
    return store


def observe(store):
    return observe_context_transition(store, user_id="test-owner", owner_ref=OWN, context=CONTEXT)


def test_observation_rereads_owner_epoch_after_complete_scan():
    store = observation_store()
    assert observe(store).reason == "unrelated_revocation"
    assert store.get_user_governance.call_count == 2
    store.get_user_governance.assert_called_with("test-owner")


def test_racing_revocation_cannot_use_a_complete_but_old_delta():
    store = observation_store()
    store.get_user_governance.side_effect = [SimpleNamespace(user_id="test-owner", user_revocation_epoch=n, provider_subject="pinned-subject") for n in (4, 5)]
    assert observe(store).action == "zero_memory"


@pytest.mark.parametrize("fault", ["contract", "owner", "clock_outage", "second_clock_outage"])
def test_observation_unavailable_is_not_a_clean_context(fault):
    store = observation_store()
    if fault == "contract":
        store.get_contract.return_value.mode = "disabled"
    elif fault == "owner":
        store.get_user_governance.return_value.user_id = "wrong-owner"
    elif fault == "clock_outage":
        store.get_user_governance.side_effect = RuntimeError("synthetic DB outage")
    else:
        store.get_user_governance.side_effect = [store.get_user_governance.return_value, RuntimeError("synthetic DB outage")]
    assert observe(store).action == "zero_memory"


def test_delta_outage_requires_rebuild_not_native_continuation():
    store = observation_store()
    store._request = Mock(side_effect=RuntimeError("synthetic delta outage"))
    assert observe(store).action == "rotate"


def test_checkpoint_roundtrip_is_content_free_and_revision_exact():
    value = encode_context_manifest(CONTEXT)
    assert decode_context_manifest(value) == CONTEXT
    assert set(value["inclusions"][0]) == {"memory_id", "content_revision", "governance_revision"}


@pytest.mark.parametrize(
    "change",
    [
        {"plaintext": "forbidden"},
        {"schema": "unknown"},
        {"owner_ref": None},
        {"revocation_epoch": True},
        {"inclusions": None},
        {"inclusions": [{"memory_id": str(A), "content_revision": 1, "governance_revision": 1, "content": "forbidden"}]},
        {"inclusions": [{"memory_id": "bad", "content_revision": 1, "governance_revision": 1}]},
        {"inclusions": [{"memory_id": str(A), "content_revision": 1, "governance_revision": False}]},
    ],
)
def test_untrusted_checkpoint_shape_is_not_adopted(change):
    assert decode_context_manifest(encode_context_manifest(CONTEXT) | change) is None


def test_encoder_rejects_duplicate_or_unbounded_inclusions():
    with pytest.raises(ValueError, match="invalid_context_manifest"):
        encode_context_manifest(replace(CONTEXT, inclusions=CONTEXT.inclusions * 2))
    with pytest.raises(ValueError, match="invalid_context_manifest"):
        encode_context_manifest(replace(CONTEXT, inclusions=tuple(MemoryInclusion(UUID(int=n), 1, 1) for n in range(1, 102))))
