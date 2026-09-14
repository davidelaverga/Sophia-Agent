from copy import deepcopy
from types import SimpleNamespace
from uuid import UUID

import pytest

from deerflow.sophia.memory_governance import source_dependencies as dependencies
from deerflow.sophia.memory_governance.source_input_provenance import SourceInputWitness
from deerflow.sophia.memory_governance.source_use import SourceUseObservation
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore


@pytest.fixture
def scope():
    sources = [SourceInputWitness(schema="mem00.recorded-input-source.v1", owner_id="owner", session_id=str(UUID(int=1)),
        thread_id=str(UUID(int=2)), command_key="command-" + str(n), event_id=str(UUID(int=10+n)),
        message_id="message-" + str(n), source_row_id=str(UUID(int=20+n)), source_version=str(UUID(int=30+n)),
        sequence=n, memory_clear_epoch=n-1, content_ref="hmac-sha256:source-action-content:" + "a" * 64) for n in (1, 2)]
    root = sources[-1]
    raw = {"schema": "mem00.source-use-check.v1", "owner_id": "owner", "thread_id": root.thread_id,
        "current_source_event_id": root.event_id, "memory_clear_epoch": 1,
        "source_dependencies": [item.model_dump(mode="json", by_alias=True) for item in sources],
        "source_use_status": "current", "memory_approval": "not_granted", "extraction_eligibility": "unchanged", "final_dispatch_permission": False}
    return root, sources, raw


@pytest.mark.parametrize("fault", ["healthy", "outage", "owner", "thread", "event", "epoch", "epoch_type", "sources", "extra", "permission", "permission_zero", "approval", "extraction", "status"])
def test_cross_clear_use_requires_exact_current_read_with_no_memory_permission(scope, fault):
    root, sources, raw = scope
    before = deepcopy(sources)
    calls = []
    def check(**kwargs):
        calls.append(kwargs)
        value = deepcopy(raw)
        if fault == "outage":
            raise RuntimeError("SYNTHETIC DATABASE ERROR")
        field_values = {"owner": ("owner_id", "other"), "thread": ("thread_id", str(UUID(int=99))),
            "event": ("current_source_event_id", str(UUID(int=99))), "epoch": ("memory_clear_epoch", 2),
            "epoch_type": ("memory_clear_epoch", True), "sources": ("source_dependencies", raw["source_dependencies"][:1]),
            "extra": ("plaintext", "SYNTHETIC"), "permission": ("final_dispatch_permission", True),
            "permission_zero": ("final_dispatch_permission", 0), "approval": ("memory_approval", "granted"),
            "extraction": ("extraction_eligibility", "eligible"), "status": ("source_use_status", "unknown")}
        if fault in field_values:
            key, value_ = field_values[fault]
            value[key] = value_
        return value
    store = SimpleNamespace(check_model_source_use=check)
    def invoke():
        return dependencies.recheck_model_source_dependencies(owner_id="owner", current_witness=root, values=sources, store=store)
    if fault == "healthy":
        assert invoke() == SourceUseObservation.model_validate(raw)
    else:
        with pytest.raises(MemoryGovernanceUnavailable):
            invoke()
    assert len(calls) == 1 and calls[0] == {"p_user_id": "owner", "p_current_source": root.model_dump(mode="json", by_alias=True), "p_sources": raw["source_dependencies"]}
    assert sources == before and sources[0].memory_clear_epoch == 0


@pytest.mark.parametrize("fault", ["root_missing", "future", "cross_session", "wrong_thread", "wrong_owner", "duplicate", "changed_root", "mutated_root", "float_root"])
def test_unbound_or_cross_session_old_sources_refuse_before_rpc(scope, fault):
    root, sources, raw = scope
    calls = []
    def check(**kwargs):
        calls.append(kwargs)
        return raw
    if fault == "root_missing":
        sources = sources[:1]
    if fault == "future":
        sources[0].memory_clear_epoch = 2
    if fault == "cross_session":
        sources[0].session_id = str(UUID(int=99))
    if fault == "wrong_thread":
        sources[0].thread_id = str(UUID(int=99))
    if fault == "wrong_owner":
        sources[0].owner_id = "other"
    if fault == "duplicate":
        sources += sources[:1]
    if fault == "changed_root":
        root = root.model_copy(update={"event_id": str(UUID(int=99))})
    if fault == "mutated_root":
        root.memory_clear_epoch = True
    if fault == "float_root":
        root.memory_clear_epoch = 1.0
    with pytest.raises((ValueError, MemoryGovernanceUnavailable)):
        dependencies.recheck_model_source_dependencies(owner_id="owner", current_witness=root, values=sources, store=SimpleNamespace(check_model_source_use=check))
    assert not calls


@pytest.mark.parametrize("root_present", [False, True])
def test_no_new_current_action_or_same_epoch_keeps_strict_existing_check(scope, monkeypatch, root_present):
    root, sources, _ = scope
    sources[0].memory_clear_epoch = root.memory_clear_epoch
    calls = []
    monkeypatch.setattr(dependencies, "recheck_source_dependencies", lambda **kwargs: calls.append(kwargs))
    store = SimpleNamespace()
    dependencies.recheck_model_source_dependencies(owner_id="owner", current_witness=root if root_present else None, values=sources, store=store)
    assert calls == [{"owner_id": "owner", "values": tuple(sources), "store": store}]


def test_source_use_store_has_only_exact_read_rpc(scope):
    root, sources, _ = scope
    store = object.__new__(SupabaseMemoryGovernanceStore)
    calls = []
    store._rpc = lambda *args: calls.append(args)
    payload = {"p_user_id": "owner", "p_current_source": root.model_dump(mode="json", by_alias=True),
        "p_sources": [item.model_dump(mode="json", by_alias=True) for item in sources]}
    store.check_model_source_use(**payload)
    assert calls == [("sophia_memory_check_source_use", payload)]
