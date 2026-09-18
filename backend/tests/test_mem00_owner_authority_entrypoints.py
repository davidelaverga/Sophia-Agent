"""Durable authority contract with explicit owner declarations, never env inference."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from deerflow.sophia.memory_governance.models import OwnerMemoryAuthority


def store(state="governed", epoch=1, owner="owner"):
    authority = OwnerMemoryAuthority(user_id=owner,authority_state=state,authority_epoch=epoch,authority_declared_at=datetime.now(UTC))
    return SimpleNamespace(get_contract=lambda: SimpleNamespace(contract_epoch=1,schema_version="mem00.v1"),get_owner_authority=lambda _:authority)

@pytest.mark.parametrize("case", ["decohort", "all_off", "unknown", "outage"])
def test_actual_facade_denies_legacy_cache_and_provider_under_rollback(monkeypatch,case):
    from deerflow.sophia import mem0_client
    from deerflow.sophia.memory_governance import owner_authority

    authority = store("unknown" if case=="unknown" else "governed")
    if case=="outage":
        authority.get_owner_authority = Mock(side_effect=RuntimeError("PRIVATE_ERROR"))
    monkeypatch.setattr(owner_authority,"configured_memory_store",lambda:authority)
    for key in tuple(__import__("os").environ):
        if key.startswith("SOPHIA_MEMORY_") and not key.endswith("SECRET"):
            monkeypatch.delenv(key)
    if case=="decohort":
        monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS","other-owner")
    legacy = Mock(side_effect=AssertionError("legacy memory touched"))
    monkeypatch.setattr(mem0_client,"memory_provider_status",legacy)
    monkeypatch.setattr(mem0_client,"_cache",{"owner:recall:::10":[{"content":"UNAPPROVED_SYNTHETIC_CACHE"}]})
    result = mem0_client.search_memories_with_diagnostics("owner","recall")
    assert result["memories"] == [] and result["provider_status"] == "unavailable"
    # An undeclared owner reports the narrower reason; the denial itself, the
    # untouched legacy cache and the unused provider are identical either way.
    expected = {"decohort":"governed_runtime_disabled","all_off":"governed_runtime_disabled",
        "unknown":"memory_owner_undeclared","outage":"memory_owner_authority_unavailable"}[case]
    assert result["provider_reason"] == expected
    legacy.assert_not_called()


@pytest.mark.parametrize("state,expected", [("governed",410),("unknown",503)])
@pytest.mark.parametrize("path", ["/api/memory", "/api/memory/status", "/api/memory/config"])
def test_real_generic_http_routes_resolve_durable_authority_before_files(monkeypatch,state,expected,path):
    import asyncio

    from fastapi import FastAPI

    from app.gateway.auth import require_authenticated_user
    from app.gateway.routers import memory
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority,"configured_memory_store",lambda:store(state))
    forbidden = Mock(side_effect=AssertionError("generic filesystem touched"))
    for name in ("get_memory_data","reload_memory_data","get_memory_config"):
        monkeypatch.setattr(memory,name,forbidden)
    app = FastAPI()
    app.include_router(memory.router)
    app.dependency_overrides[require_authenticated_user] = lambda:"owner"
    async def request():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://synthetic") as client:
            return await client.get(path)
    assert asyncio.run(request()).status_code == expected
    forbidden.assert_not_called()


@pytest.mark.parametrize("state", ["governed","unknown"])
def test_identity_stays_neutral_without_environment_cutover(monkeypatch,state):
    from deerflow.agents.sophia_agent.middlewares import user_identity
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority,"configured_memory_store",lambda:store(state))
    forbidden = Mock(side_effect=AssertionError("unversioned identity path touched"))
    monkeypatch.setattr(user_identity,"safe_user_path",forbidden)
    result = user_identity.UserIdentityMiddleware("owner").before_agent({},SimpleNamespace(context={}))
    assert result == {"user_id":"owner"}
    forbidden.assert_not_called()


@pytest.mark.parametrize("state", ["governed","unknown"])
def test_legacy_writes_and_reconciliation_cannot_reopen(monkeypatch,state):
    from deerflow.sophia import mem0_client
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority,"configured_memory_store",lambda:store(state))
    forbidden = Mock(side_effect=AssertionError("legacy provider touched"))
    monkeypatch.setattr(mem0_client,"_get_client",forbidden)
    with pytest.raises(mem0_client.MemoryProviderUnavailableError):
        mem0_client.add_memories("owner",[{"role":"user","content":"SYNTHETIC_PENDING"}],"synthetic-session")
    assert mem0_client.reconcile_review_metadata_with_mem0("owner") == 0
    forbidden.assert_not_called()
