"""A fresh governed lookup must never inherit an older prompt admission.

These tests cover agent entry, not the still-required per-model retention fence.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from langchain_core.messages import HumanMessage
from mem00_owner_fixture import declare_memory_owners

from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import BuilderMem0RetrievalMiddleware


@pytest.fixture(autouse=True)
def governed_owner(monkeypatch, declare_memory_owners):
    from deerflow.sophia.memory_governance import flags

    monkeypatch.setattr(flags, "memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=True, governed_runtime_read=True))
    declare_memory_owners({"owner": "governed"})
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-carried-proof-" * 3)


def carried_state():
    return {
        "user_id": "owner",
        "platform": "web",
        "messages": [HumanMessage(content="MEM00 fresh query")],
        "injected_memories": ["old-id"],
        "injected_memory_contents": ["MEM00 STALE"],
        "system_prompt_blocks": ["keep", "<memories>MEM00 STALE</memories>", "<memory>MEM00 STALE</memory>"],
    }


def assert_zero(update):
    assert update is not None
    assert update["injected_memories"] == []
    assert update["injected_memory_contents"] == []
    assert update["system_prompt_blocks"] == ["keep"]


@pytest.mark.parametrize("outcome", ["empty", "exception", "no_query", "crisis", "fresh"])
def test_text_entry_replaces_prior_admission(monkeypatch, outcome):
    from deerflow.agents.sophia_agent.middlewares import mem0_memory

    def search(**kwargs):
        if outcome == "exception":
            raise RuntimeError("synthetic unavailable")
        if outcome != "fresh":
            return []
        from deerflow.sophia.memory_governance.models import AuthorizedMemory
        from deerflow.sophia.memory_governance.refs import keyed_ref
        from deerflow.sophia.memory_governance.retrieval_provenance import issue_retrieval_proof, RETRIEVAL_PROOF_KEY
        item = AuthorizedMemory(memory_id=UUID(int=1), content_revision=1, memory_governance_revision=1, canonical_content="MEM00 CURRENT")
        receipt = SimpleNamespace(owner_ref=keyed_ref("owner", "owner"), provider_status="ok", prompt_admission_id=UUID(int=2),
            revocation_epoch_checked=1, authorized_memory_ids=(keyed_ref("memory-revision", f"{item.memory_id}:1:1"),))
        proof = issue_retrieval_proof(owner_id="owner", memories=(item,), receipt=receipt)
        return [{"id": str(item.memory_id), "content": item.canonical_content, RETRIEVAL_PROOF_KEY: proof}]

    monkeypatch.setattr(mem0_memory, "search_memories", search)
    state = carried_state()
    if outcome == "no_query":
        state["messages"] = []
    state["skip_expensive"] = outcome == "crisis"
    result = Mem0MemoryMiddleware("owner").before_agent(state, SimpleNamespace(context={}))
    assert "MEM00 STALE" in repr(state), "input state must not be mutated"
    if outcome == "fresh":
        assert result["injected_memories"] == [str(UUID(int=1))]
        assert "MEM00 CURRENT" in repr(result)
        assert "MEM00 STALE" not in repr(result)
        assert result["system_prompt_blocks"][0] == "keep"
    else:
        assert_zero(result)


@pytest.mark.anyio
@pytest.mark.parametrize("outcome", ["empty", "unavailable", "no_query", "fresh"])
async def test_builder_entry_replaces_prior_admission(monkeypatch, outcome):
    state = carried_state()
    if outcome == "no_query":
        state["messages"] = []
    middleware = BuilderMem0RetrievalMiddleware()
    search = AsyncMock(return_value=[{"id": "new-id", "content": "MEM00 CURRENT"}] if outcome == "fresh" else None if outcome == "unavailable" else [])
    monkeypatch.setattr(middleware, "_safe_search", search)
    result = await middleware.abefore_agent(state, SimpleNamespace(context={}))
    assert "MEM00 STALE" in repr(state), "input state must not be mutated"
    assert_zero(result)
    search.assert_not_called()


def test_sync_builder_cannot_reuse_old_memory_without_fresh_lookup():
    assert_zero(BuilderMem0RetrievalMiddleware().before_agent(carried_state(), SimpleNamespace(context={})))


def test_certification_diagnostic_imports_identity_owner(monkeypatch):
    # EI124: deployed diagnostics previously imported this from flags and failed
    # before any provider or product call. Pin the actual owning module.
    from deerflow.sophia.memory_governance.identity import memory_certification_principal

    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "mem00-synthetic-principal")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-distinct")
    assert memory_certification_principal() == "mem00-synthetic-principal"
