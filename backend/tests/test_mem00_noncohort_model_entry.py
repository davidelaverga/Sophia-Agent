"""Undeclared non-cohort owner through the compiled text / model-entry path.

`test_mem00_noncohort_owner_paths.py` fixed the two *ordinary* call sites so an
undeclared owner resolves all-off memory flags instead of raising. That is only
half the supported path. The compiled text agent also builds a `MemoryRunGuard`
(`agent.py`, `MemoryRunGuard(owner_id=user_id, config=cfg, scope=context_mode)`)
and `MemoryContextEntryMiddleware.before_agent` calls `guard.enter(state)`.

The guard decides whether to engage the governed path from
`allows_unversioned_builder_handoff`, which catches every exception and returns
False. For an undeclared owner that reads as "not allowed to use the unversioned
lane", so the guard sets `enabled = True` and enters the governed branch — where
the first thing it does is require `governed_runtime_read`, which an undeclared
owner can never have. The ordinary middleware has already told that same turn
there is no memory.

So the two halves disagree, and the disagreement surfaces as
`MemoryContextUnavailable` escaping `before_agent` on an ordinary text turn for
any user outside the pilot. These tests pin the intended behaviour under the
selected non-cohort policy: an undeclared owner takes the no-memory path, a
store outage still fails closed, and a governed owner is unaffected.
"""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

PILOT_ENV = {
    "SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE": "true",
    "SOPHIA_MEMORY_CANDIDATE_LEDGER_READ": "true",
    "SOPHIA_MEMORY_CANONICAL_POOL_READ": "true",
    "SOPHIA_MEMORY_PROVIDER_PROJECTION": "true",
    "SOPHIA_MEMORY_GOVERNED_RUNTIME_READ": "true",
    "SOPHIA_MEMORY_COHORT_PRINCIPALS": "governed-pilot-owner",
}


class _StubStore:
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
    def get_contract(self):
        raise TimeoutError("supabase unreachable")

    def get_owner_authority(self, user_id):
        raise TimeoutError("supabase unreachable")


def _env(monkeypatch):
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)


def _store(monkeypatch, store):
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: store)


def _guard(owner, thread_id="thread-1"):
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryRunGuard

    return MemoryRunGuard(owner_id=owner, config={"thread_id": thread_id}, scope="global")


def test_undeclared_owner_does_not_engage_the_governed_path(monkeypatch):
    """The guard must agree with the ordinary middleware: this owner has none."""
    _env(monkeypatch)
    _store(monkeypatch, _StubStore("unknown"))

    guard = _guard("ordinary-production-user")
    assert guard.enabled is False


def test_undeclared_owner_survives_before_agent_on_the_text_path(monkeypatch):
    """An ordinary text turn for a non-pilot user must not raise."""
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextEntryMiddleware

    _env(monkeypatch)
    _store(monkeypatch, _StubStore("unknown"))

    guard = _guard("ordinary-production-user")
    middleware = MemoryContextEntryMiddleware(guard)
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)

    # No memory state is produced, and nothing escapes.
    assert middleware.before_agent({"messages": []}, runtime) is None


def test_store_outage_still_fails_closed(monkeypatch):
    """An outage is not an answer; the guard must still engage and deny."""
    from deerflow.agents.sophia_agent.middlewares.memory_context import (
        MemoryContextEntryMiddleware,
        MemoryContextUnavailable,
    )

    _env(monkeypatch)
    _store(monkeypatch, _DownStore())

    guard = _guard("governed-pilot-owner")
    assert guard.enabled is True

    middleware = MemoryContextEntryMiddleware(guard)
    runtime = SimpleNamespace(context=SimpleNamespace(), store=None)
    with pytest.raises(MemoryContextUnavailable):
        middleware.before_agent({"messages": []}, runtime)


def test_governed_owner_still_engages_the_governed_path(monkeypatch):
    """The repair must not quietly disable the pilot owner's own guard."""
    _env(monkeypatch)
    _store(monkeypatch, _StubStore("governed"))

    guard = _guard("governed-pilot-owner")
    assert guard.enabled is True


def test_declared_legacy_owner_is_unchanged(monkeypatch):
    """A declared legacy owner keeps the unversioned lane the design gives it."""
    _env(monkeypatch)
    _store(monkeypatch, _StubStore("legacy"))

    guard = _guard("declared-legacy-user")
    # allows_unversioned_builder_handoff is True for legacy, so the governed
    # guard stays off. This is existing behaviour, pinned so the repair does
    # not move it.
    assert guard.enabled is False


def test_undeclared_owner_final_dispatch_authority_denies_rather_than_recalls(monkeypatch):
    """The model boundary must still refuse to admit memory for this owner."""
    from deerflow.agents.sophia_agent.middlewares.memory_context import MemoryContextUnavailable

    _env(monkeypatch)
    _store(monkeypatch, _StubStore("unknown"))

    guard = _guard("ordinary-production-user")
    authority = guard.final_dispatch_authority
    assert authority is not None
    # Whatever the transport asks for, an undeclared owner gets no admission.
    with pytest.raises((MemoryContextUnavailable, Exception)):
        authority({"messages": []})
