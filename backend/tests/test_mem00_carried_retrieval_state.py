"""A fresh governed lookup must never inherit an older prompt admission.

These tests cover agent entry, not the still-required per-model retention fence.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import HumanMessage

from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import BuilderMem0RetrievalMiddleware


@pytest.fixture(autouse=True)
def governed_owner(monkeypatch):
    from deerflow.sophia.memory_governance import flags

    monkeypatch.setattr(flags, "memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=True, governed_runtime_read=True))


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
        return [{"id": "new-id", "content": "MEM00 CURRENT"}] if outcome == "fresh" else []

    monkeypatch.setattr(mem0_memory, "search_memories", search)
    state = carried_state()
    if outcome == "no_query":
        state["messages"] = []
    state["skip_expensive"] = outcome == "crisis"
    result = Mem0MemoryMiddleware("owner").before_agent(state, SimpleNamespace(context={}))
    assert "MEM00 STALE" in repr(state), "input state must not be mutated"
    if outcome == "fresh":
        assert result["injected_memories"] == ["new-id"]
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
    if outcome == "fresh":
        assert result["injected_memories"] == ["new-id"]
        assert result["injected_memory_contents"] == ["MEM00 CURRENT"]
        assert "MEM00 STALE" not in repr(result)
        assert result["system_prompt_blocks"][0] == "keep"
    else:
        assert_zero(result)


def test_sync_builder_cannot_reuse_old_memory_without_fresh_lookup():
    assert_zero(BuilderMem0RetrievalMiddleware().before_agent(carried_state(), SimpleNamespace(context={})))


def test_certification_diagnostic_imports_identity_owner(monkeypatch):
    # EI124: deployed diagnostics previously imported this from flags and failed
    # before any provider or product call. Pin the actual owning module.
    from deerflow.sophia.memory_governance.identity import memory_certification_principal

    monkeypatch.setenv("SOPHIA_MEMORY_CERTIFICATION_PRINCIPAL", "mem00-synthetic-principal")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_TEST_PRINCIPAL", "voice-lab-distinct")
    assert memory_certification_principal() == "mem00-synthetic-principal"
