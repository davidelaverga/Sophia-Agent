"""Non-cohort behaviour of the ordinary paths under a REAL configured store.

`2026_09_08_mem00_c1_owner_authority.sql` adds `authority_state` as
`NOT NULL DEFAULT 'unknown'`, and no application code ever calls
`sophia_memory_declare_owner_authority`. Every account is therefore undeclared
until an operator declares it, including every new signup after activation.

These tests pin the boundary that follows from that. The store here is
configured, reachable and returns a row; the row is simply undeclared. That is
production's actual state for a non-pilot user, and it must be distinguishable
from a store that is down — degrading on a real outage would drop the guard for
a governed owner exactly when it matters.
"""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

PILOT_ENV = {
    "SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE": "true",
    "SOPHIA_MEMORY_COHORT_PRINCIPALS": "governed-pilot-owner",
}


class _StubStore:
    """A healthy store whose owner row carries the given authority state."""

    def __init__(self, authority_state="unknown"):
        self.authority_state = authority_state

    def get_contract(self):
        return SimpleNamespace(schema_version="mem00.v1", contract_epoch=1, mode="enforced")

    def get_owner_authority(self, user_id):
        if self.authority_state == "unknown":
            return SimpleNamespace(
                user_id=user_id, authority_state="unknown",
                authority_epoch=None, authority_declared_at=None,
            )
        return SimpleNamespace(
            user_id=user_id, authority_state=self.authority_state,
            authority_epoch=1, authority_declared_at=datetime.now(UTC),
        )


class _DownStore:
    """The store cannot answer: a transport or schema failure, not an answer."""

    def get_contract(self):
        raise TimeoutError("supabase unreachable")

    def get_owner_authority(self, user_id):
        raise TimeoutError("supabase unreachable")


def _use(monkeypatch, store):
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: store)


# --- the resolver tells "not enrolled" apart from "cannot find out" ----------


def test_undeclared_owner_raises_the_narrow_undeclared_error(monkeypatch):
    from deerflow.sophia.memory_governance.owner_authority import resolve_owner_authority
    from deerflow.sophia.memory_governance.store import (
        MemoryGovernanceUnavailable,
        MemoryOwnerUndeclared,
    )

    _use(monkeypatch, _StubStore("unknown"))
    with pytest.raises(MemoryOwnerUndeclared):
        resolve_owner_authority("ordinary-production-user")
    # Still fails closed for every caller that does not opt into the narrow type.
    assert issubclass(MemoryOwnerUndeclared, MemoryGovernanceUnavailable)


def test_store_failure_is_still_the_broad_unavailable_error(monkeypatch):
    from deerflow.sophia.memory_governance.owner_authority import resolve_owner_authority
    from deerflow.sophia.memory_governance.store import (
        MemoryGovernanceUnavailable,
        MemoryOwnerUndeclared,
    )

    _use(monkeypatch, _DownStore())
    with pytest.raises(MemoryGovernanceUnavailable) as raised:
        resolve_owner_authority("governed-pilot-owner")
    assert not isinstance(raised.value, MemoryOwnerUndeclared)


def test_undeclared_owner_is_never_treated_as_legacy(monkeypatch):
    """The whole point of the distinction: it grants no memory access at all."""
    from deerflow.sophia.memory_governance.owner_authority import legacy_memory_lane_allowed

    _use(monkeypatch, _StubStore("unknown"))
    assert legacy_memory_lane_allowed("ordinary-production-user") is False


# --- ordinary paths degrade for an undeclared owner, fail closed on an outage -


def test_ordinary_flags_are_all_off_for_an_undeclared_owner(monkeypatch):
    from deerflow.sophia.memory_governance.owner_authority import (
        ordinary_path_memory_flags_for_owner,
    )

    _use(monkeypatch, _StubStore("unknown"))
    flags = ordinary_path_memory_flags_for_owner("ordinary-production-user", environ=PILOT_ENV)
    assert flags.any_enabled() is False


def test_ordinary_flags_still_fail_closed_when_the_store_is_down(monkeypatch):
    from deerflow.sophia.memory_governance.owner_authority import (
        ordinary_path_memory_flags_for_owner,
    )
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    _use(monkeypatch, _DownStore())
    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("governed-pilot-owner", environ=PILOT_ENV)


def test_ordinary_flags_do_not_require_a_store_when_no_feature_is_enabled(monkeypatch):
    """A deployment with MEM00 switched off has no authority to guard."""
    from deerflow.sophia.memory_governance.owner_authority import (
        ordinary_path_memory_flags_for_owner,
    )

    _use(monkeypatch, _DownStore())
    assert ordinary_path_memory_flags_for_owner("anyone", environ={}).any_enabled() is False


def test_governed_owner_still_resolves_normally(monkeypatch):
    from deerflow.sophia.memory_governance.owner_authority import (
        ordinary_path_memory_flags_for_owner,
    )

    _use(monkeypatch, _StubStore("governed"))
    flags = ordinary_path_memory_flags_for_owner("governed-pilot-owner", environ=PILOT_ENV)
    assert flags.candidate_ledger_write is True


# --- the two ordinary call sites no longer break for an undeclared owner -----


def test_session_state_middleware_survives_an_undeclared_owner(monkeypatch):
    """Turn 0 of an ordinary session for a user who was never declared."""
    from deerflow.agents.sophia_agent.middlewares import session_state as mod

    _use(monkeypatch, _StubStore("unknown"))
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)
    middleware = mod.SessionStateMiddleware("ordinary-production-user")
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)
    # No handoff file exists for this synthetic user, so the pre-MEM00 path
    # reaches its ordinary "no handoff" exit instead of raising.
    assert middleware.before_agent({"messages": [], "turn_count": 0}, runtime) is None


def test_session_state_middleware_still_fails_closed_on_a_store_outage(monkeypatch):
    from deerflow.agents.sophia_agent.middlewares import session_state as mod
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    _use(monkeypatch, _DownStore())
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)
    middleware = mod.SessionStateMiddleware("governed-pilot-owner")
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)
    with pytest.raises(MemoryGovernanceUnavailable):
        middleware.before_agent({"messages": [], "turn_count": 0}, runtime)


def test_offline_finalization_uses_the_ordinary_path_resolver():
    """End-session finalization must not use the raising resolver."""
    import inspect

    from deerflow.sophia import offline_pipeline

    source = inspect.getsource(offline_pipeline.run_offline_pipeline)
    assert "ordinary_path_memory_flags_for_owner(user_id)" in source
    assert "memory_flags = memory_feature_flags_for_owner(user_id)" not in source
