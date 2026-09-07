"""Do not admit memory into a voice context without a next-turn revocation fence."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.mark.parametrize("caller", ["voice_setup", "voice_dynamic_retrieval", "voice_direct_fallback", "voice_retrieval_tool"])
def test_governed_voice_context_refuses_retained_memory_until_fencing_exists(monkeypatch, caller):
    from deerflow.sophia import mem0_client
    from deerflow.sophia.memory_governance import flags, mem0_projection_adapter, observability, reader, service, store

    monkeypatch.setattr(flags, "memory_feature_flags_for_owner", lambda owner: SimpleNamespace(candidate_ledger_write=True, canonical_pool_read=True, governed_runtime_read=True))
    memory = SimpleNamespace(memory_id="canonical-id", canonical_content="SYNTHETIC RETAINED MEMORY", category="fact", score=0.9, content_revision=1, memory_governance_revision=1)
    governed = SimpleNamespace(memories=(memory,), receipt=SimpleNamespace(provider_status="ok", safe_reason_code=None, model_dump=lambda **kw: {}))
    fake_reader = MagicMock()
    fake_reader.retrieve.return_value = governed
    factory = MagicMock(return_value=fake_reader)
    monkeypatch.setattr(reader, "GovernedMemoryReader", factory)
    monkeypatch.setattr(store, "configured_memory_store", MagicMock())
    monkeypatch.setattr(mem0_projection_adapter, "Mem0ProjectionAdapter", MagicMock())
    monkeypatch.setattr(service.MemoryProviderContract, "from_environ", lambda: MagicMock())
    monkeypatch.setattr(observability, "emit_memory_event", MagicMock())
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "test-only-reference-key-32-characters")
    result = mem0_client.search_memories_with_diagnostics("owner", "synthetic query", caller=caller)
    assert result["memories"] == []
    assert result["provider_status"] == "unavailable"
    assert result["provider_reason"] == "long_lived_memory_context_disabled"
    assert result["cache_status"] == "disabled_governed"
    factory.assert_not_called()


def test_setup_does_not_treat_policy_unavailability_as_no_results(monkeypatch):
    from app.gateway import sophia_realtime_context as context

    monkeypatch.setattr(context, "memory_provider_status", lambda: {"available": True})
    monkeypatch.setattr(context, "search_memories_with_diagnostics", lambda **kw: {"memories": [], "provider_status": "unavailable", "provider_reason": "long_lived_memory_context_disabled"})
    memories, status, reason = context._search_realtime_memories(user_id="owner", query="query", context_mode="life", ritual=None, limit=4)
    assert memories == []
    assert status == "unavailable"
    assert reason == "long_lived_memory_context_disabled"


def test_dynamic_contract_preserves_policy_unavailability():
    from deerflow.sophia.tools.retrieve_memories_contract import retrieve_memories_for_realtime

    result = retrieve_memories_for_realtime(
        user_id="owner", query="synthetic query", provider_available_func=lambda: {"available": True}, search_func=lambda **kw: {"memories": [], "provider_status": "unavailable", "provider_reason": "long_lived_memory_context_disabled"}
    )
    assert result["status"] == "unavailable"
    assert result["memories"] == []
    assert result["provider_reason"] == "long_lived_memory_context_disabled"


@pytest.mark.parametrize("platform", ["voice", "ios_voice"])
@pytest.mark.parametrize("skip_expensive", [False, True])
def test_voice_entry_clears_carried_memory_before_empty_or_crisis_exit(monkeypatch, platform, skip_expensive):
    from deerflow.agents.sophia_agent.middlewares.mem0_memory import Mem0MemoryMiddleware
    from deerflow.sophia.memory_governance import flags

    monkeypatch.setattr(flags, "memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=True, governed_runtime_read=True))
    result = Mem0MemoryMiddleware("owner").before_agent(
        {"platform": platform, "messages": [], "skip_expensive": skip_expensive, "injected_memories": ["old"], "injected_memory_contents": ["SYNTHETIC OLD"], "system_prompt_blocks": ["keep", "<memories>old</memories>"]},
        SimpleNamespace(context={}),
    )
    assert result == {"injected_memories": [], "injected_memory_contents": [], "system_prompt_blocks": ["keep"]}
