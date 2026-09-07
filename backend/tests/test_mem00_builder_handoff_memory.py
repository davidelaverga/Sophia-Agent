"""Unversioned handoff snippets must not become a Builder admission."""

from types import SimpleNamespace

import pytest

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware


@pytest.fixture
def governed(monkeypatch):
    from deerflow.sophia.memory_governance import flags

    monkeypatch.setattr(flags, "memory_feature_flags_for_owner", lambda owner: SimpleNamespace(canonical_pool_read=owner == "owner"))


def test_governed_receiver_drops_unversioned_delegation_and_old_brief(governed):
    middleware = BuilderTaskMiddleware(user_id="owner")
    # The production factory must bind this from authenticated configuration,
    # never from a delegation's claimed parent_user_id or input state.
    state = {
        "user_id": "spoofed-noncohort",
        "delegation_context": {"parent_user_id": "spoofed-noncohort", "task": "Create a concise slide deck", "task_type": "presentation", "relevant_memories": ["Prefers concise slide headlines MEM00 STALE"]},
        "system_prompt_blocks": ["keep", "<builder_briefing><memories>MEM00 OLD BRIEF</memories></builder_briefing>"],
    }
    result = middleware.before_agent(state, SimpleNamespace(context={}, config={}))
    assert "MEM00 STALE" not in repr(result)
    assert "MEM00 OLD BRIEF" not in repr(result)
    assert result["delegation_context"]["relevant_memories"] == []
    assert result["system_prompt_blocks"][0] == "keep"
    assert "MEM00 STALE" in repr(state), "do not mutate input state"


def test_governed_receiver_clears_old_brief_even_without_delegation(governed):
    middleware = BuilderTaskMiddleware(user_id="owner")
    result = middleware.before_agent({"system_prompt_blocks": ["keep", "<builder_briefing>MEM00 OLD</builder_briefing>"]}, SimpleNamespace(context={}, config={}))
    assert result is not None
    assert result["system_prompt_blocks"] == ["keep"]


@pytest.mark.parametrize("failure", ["missing_owner", "flag_error"])
def test_uncertain_handoff_configuration_does_not_inherit(monkeypatch, failure):
    from deerflow.sophia.memory_governance import flags
    from deerflow.sophia.memory_governance.context_state import allows_unversioned_builder_handoff

    monkeypatch.setattr(flags, "memory_feature_flags", lambda: SimpleNamespace(any_enabled=lambda: True))

    def unavailable(owner):
        raise flags.MemoryFlagConfigurationError("synthetic invalid flags")

    monkeypatch.setattr(flags, "memory_feature_flags_for_owner", unavailable)
    assert not allows_unversioned_builder_handoff(None if failure == "missing_owner" else "owner")


def test_explicit_noncohort_owner_preserves_legacy_inheritance(governed):
    from deerflow.sophia.tools.start_builder_task import _resolve_memory_snippets

    state = {"injected_memory_contents": ["MEM00 legacy compatibility"]}
    assert _resolve_memory_snippets(state, owner_id="noncohort") == state["injected_memory_contents"]
    assert _resolve_memory_snippets(state, owner_id="owner") == []


def test_factory_binds_receiver_to_server_owner():
    from deerflow.agents.sophia_agent.builder_middlewares import build_builder_middleware_chain

    (receiver,) = [item for item in build_builder_middleware_chain("owner") if isinstance(item, BuilderTaskMiddleware)]
    assert receiver._memory_owner_id == "owner"
