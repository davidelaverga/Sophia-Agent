"""Canonical re-admission tests; these do not certify retained-message provenance."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest

from deerflow.sophia.memory_governance.models import AuthorizedMemory
from deerflow.sophia.memory_governance.refs import keyed_ref
from deerflow.sophia.memory_governance.retained_admission import readmit_retained_context
from deerflow.sophia.memory_governance.retained_context import MemoryInclusion, RetainedMemoryContext
from deerflow.sophia.memory_governance.service import MemoryProviderContract

A, B = UUID(int=1), UUID(int=2)


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "s" * 32)
    monkeypatch.setenv("SOPHIA_MEMORY_LANGSMITH_EXPORT", "false")
    context = RetainedMemoryContext(keyed_ref("owner", "owner"), 3, (MemoryInclusion(A, 2, 4),))
    clock = SimpleNamespace(user_id="owner", user_revocation_epoch=3, user_catalog_generation=6, provider_subject="synthetic-namespace")
    canonical = AuthorizedMemory(memory_id=A, content_revision=2, memory_governance_revision=4, canonical_content="Canonical synthetic value", category="fact", scope="global", score=None)
    store = Mock()
    store.get_contract.return_value = SimpleNamespace(schema_version="mem00.v1", mode="enforced", contract_epoch=1)
    store.get_user_governance.return_value = clock
    store.hydrate_inclusions.return_value = (canonical,)
    store.record_prompt_admission.return_value = UUID(int=9)
    adapter = Mock()
    adapter.search_ids.return_value = ()
    return SimpleNamespace(context=context, clock=clock, canonical=canonical, store=store, adapter=adapter)


def run(env, **overrides):
    return readmit_retained_context(**{
        "store": env.store, "adapter": env.adapter,
        "provider": MemoryProviderContract("mem0", "production", "existing-project"),
        "service_name": "test", "owner_id": "owner", "context": env.context,
        "scope": "text", "caller": "text_model_boundary", "query": "Synthetic query", **overrides,
    })


def test_current_retention_requires_fresh_provider_canonical_and_atomic_receipt(setup):
    result = run(setup)
    assert result.transition.action == "continue"
    assert result.context == setup.context
    assert result.memories == (setup.canonical,)
    assert result.prompt_admission_id == UUID(int=9)
    setup.adapter.search_ids.assert_called_once_with(query="Synthetic query", provider_subject="synthetic-namespace", limit=1,
        metadata_filter={"sophia_managed": True, "memory_contract_epoch": 1, "environment": "production", "provider_namespace": "synthetic-namespace"})
    payload = setup.store.record_prompt_admission.call_args.args[0]
    assert payload["authorized_manifest"] == [{"memory_id": str(A), "content_revision": 2, "memory_governance_revision": 4}]
    assert payload["provider_hit_count"] == 0
    assert payload["catalog_generation_checked"] == 6
    assert payload["revocation_epoch_checked"] == 3
    assert "Synthetic query" not in str(payload)
    assert "Canonical synthetic value" not in str(payload)


@pytest.mark.parametrize("dependency", ["get_contract", "get_user_governance", "hydrate_inclusions", "record_prompt_admission"])
def test_any_database_failure_returns_zero_text_and_no_continuation(setup, dependency):
    getattr(setup.store, dependency).side_effect = RuntimeError("sensitive exception detail")
    result = run(setup)
    assert result.transition.action == "zero_memory"
    assert result.memories == () and result.context is None and result.prompt_admission_id is None
    assert "sensitive" not in str(result)


def test_provider_outage_cannot_reuse_previously_authorized_text(setup):
    setup.adapter.search_ids.side_effect = RuntimeError("private transport failure")
    result = run(setup)
    assert result.transition.reason == "provider_unavailable"
    assert not result.memories
    setup.store.hydrate_inclusions.assert_not_called()
    setup.store.record_prompt_admission.assert_not_called()


@pytest.mark.parametrize("kind", ["absent", "wrong_owner", "malformed"])
def test_unbound_or_wrong_owner_manifest_never_calls_provider_or_admits(setup, kind):
    context = {"absent": None, "wrong_owner": replace(setup.context, owner_ref="wrong-owner"), "malformed": {}}[kind]
    result = run(setup, context=context)
    assert result.transition.action != "continue"
    assert not result.memories
    setup.adapter.search_ids.assert_not_called()
    setup.store.record_prompt_admission.assert_not_called()


@pytest.mark.parametrize("memory,expected", [(A, "rotate"), (B, "continue")])
def test_revocation_delta_only_rotates_intersecting_context(setup, memory, expected):
    setup.clock.user_revocation_epoch = 4
    setup.store._request.side_effect = [[{"event_id": str(UUID(int=4)), "user_id": "owner", "memory_id": str(memory), "event_type": "memory_edited", "user_revocation_epoch": 4}], []]
    result = run(setup)
    assert result.transition.action == expected
    if expected == "continue":
        assert result.context.revocation_epoch == 4
        assert result.memories == (setup.canonical,)
    else:
        assert not result.memories
        setup.store.record_prompt_admission.assert_not_called()


def test_unprovable_delta_does_not_continue(setup):
    setup.clock.user_revocation_epoch = 4
    setup.store._request.return_value = []
    result = run(setup)
    assert result.transition.action == "rotate"
    assert not result.memories
    setup.store.record_prompt_admission.assert_not_called()


def test_concurrent_epoch_change_after_hydration_denies_before_rpc(setup):
    changed = SimpleNamespace(**{**vars(setup.clock), "user_revocation_epoch": 4})
    setup.store.get_user_governance.side_effect = [setup.clock, setup.clock, setup.clock, changed]
    result = run(setup)
    assert result.transition.reason == "governance_changed_during_check"
    assert not result.memories
    setup.store.record_prompt_admission.assert_not_called()


def test_atomic_rpc_conflict_after_reads_denies_all_text(setup):
    setup.store.record_prompt_admission.side_effect = RuntimeError("memory_prompt_admission_denied")
    result = run(setup)
    assert result.transition.action == "zero_memory"
    assert not result.memories


def test_missing_receipt_is_not_success(setup):
    setup.store.record_prompt_admission.return_value = None
    result = run(setup)
    assert result.transition.reason == "prompt_admission_receipt_invalid"
    assert not result.memories


def test_partial_hydration_cannot_mint_a_complete_retention_receipt(setup):
    setup.store.hydrate_inclusions.return_value = ()
    result = run(setup)
    assert result.transition.reason == "retained_hydration_incomplete"
    setup.store.record_prompt_admission.assert_not_called()


def test_contract_change_during_hydration_denies_admission(setup):
    setup.store.get_contract.side_effect = [setup.store.get_contract.return_value, SimpleNamespace(mode="shadow", schema_version="mem00.v1", contract_epoch=1)]
    result = run(setup)
    assert result.transition.reason == "contract_not_enforced"
    setup.store.record_prompt_admission.assert_not_called()


def test_empty_inclusions_still_require_governance_provider_and_admission(setup):
    setup.store.hydrate_inclusions.return_value = ()
    result = run(setup, context=replace(setup.context, inclusions=()))
    assert result.transition.action == "continue"
    assert not result.memories
    assert result.prompt_admission_id == UUID(int=9)
    setup.adapter.search_ids.assert_called_once()
    assert setup.store.record_prompt_admission.call_args.args[0]["authorized_manifest"] == []


def test_missing_reference_secret_fails_closed_without_network(setup, monkeypatch):
    monkeypatch.delenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET")
    result = run(setup)
    assert result.transition.action == "zero_memory"
    setup.store.get_contract.assert_not_called()
    setup.adapter.search_ids.assert_not_called()
