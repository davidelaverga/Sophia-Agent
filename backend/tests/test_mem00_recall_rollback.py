"""A recall shutdown must preserve canonical ownership and deny legacy caches."""

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def canonical_review_only(monkeypatch):
    for key in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ"):
        monkeypatch.setenv(f"SOPHIA_MEMORY_{key}", "true")
    for key in ("PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ", "FAULT_INJECTION"):
        monkeypatch.setenv(f"SOPHIA_MEMORY_{key}", "false")
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "rollback-owner")


@pytest.mark.parametrize("warm_cache", [False, True])
def test_recall_shutdown_never_reads_legacy_cache_or_provider(canonical_review_only, monkeypatch, warm_cache):
    from deerflow.sophia import mem0_client

    monkeypatch.setattr(mem0_client, "_cache", {})
    if warm_cache:
        mem0_client._cache["rollback-owner:recall:::10"] = [{"content": "UNAPPROVED SYNTHETIC SENTINEL"}]
    legacy = MagicMock(side_effect=AssertionError("legacy provider must not be touched"))
    monkeypatch.setattr(mem0_client, "memory_provider_status", legacy)
    result = mem0_client.search_memories_with_diagnostics("rollback-owner", "recall")
    assert result["memories"] == []
    assert result["provider_status"] == "unavailable"
    assert result["provider_reason"] == "governed_runtime_disabled"
    legacy.assert_not_called()


def test_generic_memory_stays_quarantined_during_recall_shutdown(canonical_review_only):
    from fastapi import HTTPException

    from app.gateway.routers.memory import _reject_when_mem00_owns_sophia_memory

    with pytest.raises(HTTPException) as denied:
        _reject_when_mem00_owns_sophia_memory("rollback-owner")
    assert denied.value.status_code == 410
    _reject_when_mem00_owns_sophia_memory("non-cohort-owner")


def test_voice_fastcache_cannot_reopen_when_recall_is_disabled(canonical_review_only, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares import mem0_memory

    monkeypatch.setattr(mem0_memory, "_VOICE_FASTCACHE", {})
    middleware = mem0_memory.Mem0MemoryMiddleware("rollback-owner")
    args = dict(thread_id="rollback-thread", platform="voice", context_mode="life", categories=[], query="okay", turn_count=1)
    middleware._store_voice_results(**args, results=[{"id": "legacy", "content": "UNAPPROVED SYNTHETIC SENTINEL"}])
    assert mem0_memory._VOICE_FASTCACHE == {}
    mem0_memory._VOICE_FASTCACHE[("rollback-thread", "life", ())] = {
        "stored_at": mem0_memory.time.monotonic(),
        "turn_count": 1,
        "query": "okay",
        "query_tokens": set(),
        "content_tokens": set(),
        "results": [{"id": "legacy", "content": "UNAPPROVED SYNTHETIC SENTINEL"}],
    }
    assert middleware._maybe_reuse_voice_results(**args) is None


def test_recall_shutdown_clears_carried_memory_state_before_any_early_exit(canonical_review_only):
    from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware

    result = Mem0MemoryMiddleware("rollback-owner").before_agent(
        {
            "messages": [],
            "skip_expensive": True,
            "injected_memories": ["stale"],
            "injected_memory_contents": ["UNAPPROVED SYNTHETIC SENTINEL"],
            "system_prompt_blocks": ["keep unrelated context", "<memories>stale</memories>"],
        },
        SimpleNamespace(context={}),
    )
    assert result == {
        "injected_memories": [],
        "injected_memory_contents": [],
        "system_prompt_blocks": ["keep unrelated context"],
    }


@pytest.mark.parametrize("async_hook", [False, True])
def test_builder_shutdown_clears_carried_memory_on_empty_query(canonical_review_only, async_hook):
    from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import BuilderMem0RetrievalMiddleware

    middleware = BuilderMem0RetrievalMiddleware()
    state = {
        "user_id": "rollback-owner",
        "messages": [],
        "injected_memories": ["stale"],
        "injected_memory_contents": ["UNAPPROVED SYNTHETIC SENTINEL"],
        "system_prompt_blocks": ["keep build instructions", "<memory>stale</memory>"],
    }
    runtime = SimpleNamespace(context={})
    result = asyncio.run(middleware.abefore_agent(state, runtime)) if async_hook else middleware.before_agent(state, runtime)
    assert result == {
        "injected_memories": [],
        "injected_memory_contents": [],
        "system_prompt_blocks": ["keep build instructions"],
    }
