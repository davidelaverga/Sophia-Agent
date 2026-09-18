"""Durable authority contract with explicit owner declarations, never env inference."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from deerflow.sophia.memory_governance.models import OwnerMemoryAuthority
from deerflow.sophia.memory_governance.owner_authority import resolve_owner_authority, resolved_memory_flags_for_owner
from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore


def store(state="governed", epoch=1, owner="owner"):
    authority = OwnerMemoryAuthority(user_id=owner,authority_state=state,authority_epoch=epoch,authority_declared_at=datetime.now(UTC))
    return SimpleNamespace(get_contract=lambda: SimpleNamespace(contract_epoch=1,schema_version="mem00.v1"),get_owner_authority=lambda _:authority)


@pytest.mark.parametrize("environ", [{}, {"SOPHIA_MEMORY_COHORT_PRINCIPALS":"different-owner"}])
def test_governed_authority_survives_all_flags_off_and_decohort(environ):
    flags = resolved_memory_flags_for_owner("owner",store=store(),environ=environ)
    assert flags.canonical_pool_read and flags.candidate_ledger_read
    assert not flags.governed_runtime_read and not flags.candidate_ledger_write


def test_positive_governed_recall_requires_declared_authority_and_cohort():
    env = {"SOPHIA_MEMORY_COHORT_PRINCIPALS":"owner", **{"SOPHIA_MEMORY_"+key:"true" for key in (
        "CANDIDATE_LEDGER_WRITE","CANDIDATE_LEDGER_READ","CANONICAL_POOL_READ","PROVIDER_PROJECTION","GOVERNED_RUNTIME_READ")}}
    assert resolved_memory_flags_for_owner("owner",store=store(),environ=env).governed_runtime_read
    assert not resolved_memory_flags_for_owner("owner",store=store("legacy"),environ=env).any_enabled()


@pytest.mark.parametrize("authority", [store("unknown"),store(epoch=2),store(owner="other")])
def test_unknown_wrong_owner_or_incompatible_authority_never_becomes_legacy(authority):
    with pytest.raises(MemoryGovernanceUnavailable):
        resolved_memory_flags_for_owner("owner",store=authority,environ={})


def test_database_outage_is_not_a_pre_cutover_declaration():
    authority = store("legacy")
    authority.get_owner_authority = Mock(side_effect=RuntimeError("PRIVATE_DATABASE_BODY"))
    with pytest.raises(MemoryGovernanceUnavailable,match="^memory_owner_authority_unavailable$"):
        resolved_memory_flags_for_owner("owner",store=authority,environ={})


def test_legacy_resolution_is_not_cached_across_cutover():
    authority = store("legacy")
    assert resolve_owner_authority("owner",store=authority).authority_state == "legacy"
    authority.get_owner_authority = store().get_owner_authority
    assert resolve_owner_authority("owner",store=authority).authority_state == "governed"


# An absent row is a definite "this owner is not enrolled"; a wrong-shaped row or
# an old schema is a failure to find out. Both fail closed, and neither is ever
# legacy, but only the first is MemoryOwnerUndeclared -- which is what lets
# ordinary, non-memory paths keep working for users outside the pilot while a
# real outage still fails closed. See ordinary_path_memory_flags_for_owner.
@pytest.mark.parametrize("payload,status,reason", [
    ([],200,"^memory_owner_undeclared$"),
    ([{"user_id":"owner"}],200,"^memory_owner_authority_unavailable$"),
    ({"error":"OLD_SCHEMA_PRIVATE"},400,"^memory_owner_authority_unavailable$"),
])
def test_real_store_http_boundary_fails_closed_on_absence_or_old_schema(payload,status,reason):
    from deerflow.sophia.memory_governance.store import MemoryOwnerUndeclared

    def handle(request):
        if request.url.path.endswith("sophia_memory_contract"):
            return httpx.Response(200,json=[{"contract_epoch":1,"schema_version":"mem00.v1","mode":"enforced","updated_at":"2026-09-08T00:00:00Z"}])
        assert request.url.params["user_id"] == "eq.owner"
        assert "authority_state" in request.url.params["select"]
        return httpx.Response(status,json=payload)
    authority = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid",service_role_key="synthetic-key",client=httpx.Client(transport=httpx.MockTransport(handle)))
    # Fails closed either way: MemoryOwnerUndeclared is a MemoryGovernanceUnavailable.
    with pytest.raises(MemoryGovernanceUnavailable,match=reason) as raised:
        resolve_owner_authority("owner",store=authority)
    assert isinstance(raised.value, MemoryOwnerUndeclared) is (payload == [] and status == 200)
