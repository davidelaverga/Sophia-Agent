"""Non-cohort behaviour of the ordinary paths under a REAL configured store.

The 41 failures this candidate adds to `tests/test_extraction.py`,
`tests/test_gateway_sophia.py`, `tests/test_sophia_middlewares.py` and
`tests/test_voice_lab_route_isolation.py` have been read as a fixture gap: the
tests set up no durable owner, so `resolve_owner_authority` fails closed.

That reading only holds if the sole way to reach `MemoryGovernanceUnavailable`
is an absent store. This module removes that ambiguity. Here the store IS
configured, IS reachable and DOES return a row — the row simply has the
`authority_state='unknown'` that `2026_09_08_mem00_c1_owner_authority.sql` gives
every pre-existing user by column default. That is exactly the state of every
production user who has not been explicitly declared.
"""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest


class _StubStore:
    """A healthy store. The owner row exists; its authority is undeclared."""

    def __init__(self, authority_state="unknown"):
        self.authority_state = authority_state

    def get_contract(self):
        return SimpleNamespace(schema_version="mem00.v1", contract_epoch=1, mode="enforced")

    def get_owner_authority(self, user_id):
        if self.authority_state == "unknown":
            # Mirrors SupabaseMemoryGovernanceStore.get_owner_authority, whose
            # own comment is "Missing rows/columns and old schemas are
            # unavailable, never legacy." An 'unknown' row fails the
            # resolver's authority_state check the same way.
            return SimpleNamespace(
                user_id=user_id, authority_state="unknown",
                authority_epoch=None, authority_declared_at=None,
            )
        return SimpleNamespace(
            user_id=user_id, authority_state=self.authority_state,
            authority_epoch=1, authority_declared_at=datetime.now(UTC),
        )


@pytest.fixture
def undeclared_owner(monkeypatch):
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: _StubStore("unknown"))
    return "ordinary-production-user"


@pytest.fixture
def declared_legacy_owner(monkeypatch):
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: _StubStore("legacy"))
    return "declared-legacy-user"


def test_undeclared_owner_is_unavailable_not_legacy(undeclared_owner):
    """The resolver refuses to read an undeclared row as pre-cutover."""
    from deerflow.sophia.memory_governance.owner_authority import resolve_owner_authority
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    with pytest.raises(MemoryGovernanceUnavailable):
        resolve_owner_authority(undeclared_owner)


def test_session_state_middleware_raises_for_an_undeclared_owner(undeclared_owner):
    """Turn 0 of an ordinary session for a user who was never declared.

    `SessionStateMiddleware.before_agent` calls
    `memory_feature_flags_for_owner(...).candidate_ledger_write` without a
    guard, so the resolver's fail-closed error leaves the middleware and
    reaches the agent turn.
    """
    from deerflow.agents.sophia_agent.middlewares import session_state as mod
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    middleware = mod.SessionStateMiddleware(undeclared_owner)
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)
    with pytest.raises(MemoryGovernanceUnavailable):
        middleware.before_agent({"messages": [], "turn_count": 0}, runtime)


def test_session_state_middleware_is_fine_for_a_declared_legacy_owner(declared_legacy_owner):
    """The same call succeeds once the owner has actually been declared.

    This isolates the cause: it is the undeclared authority, not the absence of
    a store and not the middleware's own inputs.
    """
    from deerflow.agents.sophia_agent.middlewares import session_state as mod

    middleware = mod.SessionStateMiddleware(declared_legacy_owner)
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)
    assert middleware.before_agent({"messages": [], "turn_count": 0}, runtime) is None


def test_offline_finalization_raises_for_an_undeclared_owner(undeclared_owner):
    """The End-session / extraction path has the same unguarded call."""
    import inspect

    from deerflow.sophia import offline_pipeline

    source = inspect.getsource(offline_pipeline.run_offline_pipeline)
    assert "memory_feature_flags_for_owner(user_id)" in source
    # The call is not inside a try block that would convert it into a
    # degraded-but-working finalization.
    call_line = next(
        index for index, line in enumerate(source.splitlines())
        if "memory_flags = memory_feature_flags_for_owner(user_id)" in line
    )
    preceding = source.splitlines()[:call_line]
    open_try = sum(1 for line in preceding if line.strip() == "try:")
    assert open_try == 0, "guarded after all — re-read the non-cohort conclusion"
