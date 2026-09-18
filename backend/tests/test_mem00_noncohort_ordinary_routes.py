"""Ordinary session routes for an owner nobody has declared.

Ending a session, finalizing an idle one, and reading or cleaning up an owned
session's recap are product surfaces that predate MEM00. They are not memory
features, and they must not stop working for the majority of accounts, which
are undeclared by the schema's own `NOT NULL DEFAULT 'unknown'`.

The three properties pinned here are the ones that make that safe:

  * a definitely-undeclared owner takes the pre-MEM00 local path;
  * a store outage is NOT undeclared -- it still fails closed, and never turns
    into a successful empty answer;
  * a governed owner's atomic finalization, source invalidation, deletion and
    cleanup requirements are exactly what they were.

The dedicated memory endpoints are deliberately not touched by any of this:
`_memory_flags` is unchanged and still answers 503 for an undeclared owner.
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
            return SimpleNamespace(user_id=user_id, authority_state="unknown",
                                   authority_epoch=None, authority_declared_at=None)
        return SimpleNamespace(user_id=user_id, authority_state=self.authority_state,
                               authority_epoch=1, authority_declared_at=datetime.now(UTC))


class _DownStore:
    def get_contract(self):
        raise TimeoutError("supabase unreachable")

    def get_owner_authority(self, user_id):
        raise TimeoutError("supabase unreachable")


@pytest.fixture
def pilot_env(monkeypatch):
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)


def _use(monkeypatch, store):
    from deerflow.sophia.memory_governance import owner_authority

    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: store)


# --- the gateway's two flag helpers are deliberately different ---------------


def test_dedicated_memory_endpoints_stay_protected(pilot_env, monkeypatch):
    """`_memory_flags` must keep answering 503 for an undeclared owner."""
    from fastapi import HTTPException

    from app.gateway.routers.sophia import _memory_flags

    _use(monkeypatch, _StubStore("unknown"))
    with pytest.raises(HTTPException) as raised:
        _memory_flags("ordinary-production-user")
    assert raised.value.status_code == 503


def test_ordinary_session_flags_degrade_for_an_undeclared_owner(pilot_env, monkeypatch):
    from app.gateway.routers.sophia import _ordinary_session_flags

    _use(monkeypatch, _StubStore("unknown"))
    flags = _ordinary_session_flags("ordinary-production-user")
    assert flags.candidate_ledger_read is False
    assert flags.candidate_ledger_write is False
    assert flags.canonical_pool_read is False
    assert flags.governed_runtime_read is False


def test_ordinary_session_flags_still_503_on_a_store_outage(pilot_env, monkeypatch):
    """Unavailability must never be reported as "this owner has no memory"."""
    from fastapi import HTTPException

    from app.gateway.routers.sophia import _ordinary_session_flags

    _use(monkeypatch, _DownStore())
    with pytest.raises(HTTPException) as raised:
        _ordinary_session_flags("ordinary-production-user")
    assert raised.value.status_code == 503


def test_ordinary_session_flags_leave_a_governed_owner_unchanged(pilot_env, monkeypatch):
    from app.gateway.routers.sophia import _memory_flags, _ordinary_session_flags

    _use(monkeypatch, _StubStore("governed"))
    assert _ordinary_session_flags("governed-pilot-owner") == _memory_flags("governed-pilot-owner")
    assert _ordinary_session_flags("governed-pilot-owner").candidate_ledger_write is True


# --- recap: ordinary session information, and no endless processing ---------


def _recap_body(session_id="synthetic-session", artifacts=None):
    from app.gateway.routers.sophia import SessionEndRequest

    return SessionEndRequest(session_id=session_id, thread_id="synthetic-thread",
                             turn_count=4, recap_artifacts=artifacts)


def test_recap_for_an_owner_with_no_extraction_lane_is_terminal(pilot_env, monkeypatch):
    """No ledger and no provider write means nothing is coming. Say so."""
    from app.gateway.routers.sophia import _build_session_recap_payload

    _use(monkeypatch, _StubStore("unknown"))
    payload = _build_session_recap_payload(_recap_body(), "2026-09-18T00:00:00Z",
                                           extraction_lane_open=False)
    assert payload["status"] != "processing"
    # The ordinary session information is still all there.
    assert payload["session_id"] == "synthetic-session"
    assert payload["turn_count"] == 4
    assert payload["ended_at"] == "2026-09-18T00:00:00Z"
    # Empty dict, not None: the recap page discards a null envelope entirely.
    assert payload["recap_artifacts"] == {}


def test_recap_for_an_owner_with_a_lane_still_waits(pilot_env, monkeypatch):
    """A legacy or governed owner's recap keeps its existing behaviour."""
    from app.gateway.routers.sophia import _build_session_recap_payload

    _use(monkeypatch, _StubStore("legacy"))
    payload = _build_session_recap_payload(_recap_body(), "2026-09-18T00:00:00Z",
                                           extraction_lane_open=True)
    assert payload["status"] == "processing"
    assert payload["recap_artifacts"] is None


def test_extraction_lane_is_closed_only_for_a_definitely_undeclared_owner(pilot_env, monkeypatch):
    from app.gateway.routers.sophia import _owner_has_no_extraction_lane

    _use(monkeypatch, _StubStore("unknown"))
    assert _owner_has_no_extraction_lane("ordinary-production-user") is True
    _use(monkeypatch, _StubStore("legacy"))
    assert _owner_has_no_extraction_lane("declared-legacy-user") is False
    _use(monkeypatch, _StubStore("governed"))
    assert _owner_has_no_extraction_lane("governed-pilot-owner") is False
    # An outage is not a closed lane; it must not silence extraction.
    _use(monkeypatch, _DownStore())
    assert _owner_has_no_extraction_lane("ordinary-production-user") is False


# --- realtime context: neutral, not a fall-through --------------------------


@pytest.fixture
def realtime(monkeypatch, tmp_path):
    """A user whose identity.md and handoff file both exist on disk."""
    from app.gateway import sophia_realtime_context as module

    users = tmp_path / "users"
    for owner in ("ordinary-production-user", "declared-legacy-user", "governed-pilot-owner"):
        (users / owner / "handoffs").mkdir(parents=True)
        (users / owner / "identity.md").write_text("PRIVATE_IDENTITY_TEXT", encoding="utf-8")
        (users / owner / "handoffs" / "latest.md").write_text("PRIVATE_HANDOFF_TEXT", encoding="utf-8")
    monkeypatch.setattr(module, "USERS_DIR", users)
    monkeypatch.setattr(module, "memory_provider_status",
                        lambda: {"available": False, "provider_reason": "missing_api_key"})
    return module


def test_realtime_context_for_an_undeclared_owner_is_neutral(pilot_env, monkeypatch, realtime):
    """Not an outage, and not the legacy lane either."""
    _use(monkeypatch, _StubStore("unknown"))
    result = realtime.build_sophia_realtime_context(user_id="ordinary-production-user")
    payload = result.model_dump_json()
    # The unversioned identity/handoff lane belongs to a DECLARED legacy owner.
    assert "PRIVATE_IDENTITY_TEXT" not in payload
    assert "PRIVATE_HANDOFF_TEXT" not in payload
    assert result.diagnostics["identity_file_status"] == "withheld_undeclared_owner"
    assert result.diagnostics["handoff_file_status"] == "withheld_undeclared_owner"


def test_realtime_context_for_a_declared_legacy_owner_is_unchanged(pilot_env, monkeypatch, realtime):
    _use(monkeypatch, _StubStore("legacy"))
    result = realtime.build_sophia_realtime_context(user_id="declared-legacy-user")
    assert result.diagnostics["identity_file_status"] == "present"


def test_realtime_context_for_a_contained_governed_owner_is_unchanged(pilot_env, monkeypatch, realtime):
    _use(monkeypatch, _StubStore("governed"))
    result = realtime.build_sophia_realtime_context(user_id="governed-pilot-owner")
    payload = result.model_dump_json()
    assert "PRIVATE_IDENTITY_TEXT" not in payload
    assert result.diagnostics["identity_file_status"] == "quarantined_mem00"


def test_realtime_context_still_fails_on_a_store_outage(pilot_env, monkeypatch, realtime):
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    _use(monkeypatch, _DownStore())
    with pytest.raises(MemoryGovernanceUnavailable):
        realtime.build_sophia_realtime_context(user_id="ordinary-production-user")


# --- the governed override must survive the ordinary helper ------------------


def test_ordinary_flags_keep_the_governed_ledger_override_with_env_off(monkeypatch):
    """A governed owner keeps ledger routing even with every env flag off.

    `resolved_memory_flags_for_owner` forces `candidate_ledger_read` and
    `canonical_pool_read` True for a governed owner regardless of the
    environment -- canonical management stays routed to the ledger when recall
    is off. An earlier version of `ordinary_path_memory_flags_for_owner`
    short-circuited on `memory_feature_flags().any_enabled()` BEFORE resolving,
    which stripped that from every governed owner in exactly the environment
    the gateway tests run in. Ordering is the whole property here.
    """
    from deerflow.sophia.memory_governance.owner_authority import (
        ordinary_path_memory_flags_for_owner,
        resolved_memory_flags_for_owner,
    )

    for name in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ",
                 "PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ", "COHORT_PRINCIPALS"):
        monkeypatch.delenv("SOPHIA_MEMORY_" + name, raising=False)
    _use(monkeypatch, _StubStore("governed"))
    flags = ordinary_path_memory_flags_for_owner("governed-pilot-owner")
    assert flags.candidate_ledger_read is True
    assert flags.canonical_pool_read is True
    assert flags == resolved_memory_flags_for_owner("governed-pilot-owner")


def test_ordinary_flags_degrade_only_when_mem00_is_off_everywhere(monkeypatch):
    """With MEM00 entirely off there is no store to require; with it on, an
    outage still raises rather than reading as "this owner has no memory"."""
    from deerflow.sophia.memory_governance.owner_authority import ordinary_path_memory_flags_for_owner
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    for name in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ",
                 "PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ", "COHORT_PRINCIPALS"):
        monkeypatch.delenv("SOPHIA_MEMORY_" + name, raising=False)
    _use(monkeypatch, _DownStore())
    assert ordinary_path_memory_flags_for_owner("anyone").candidate_ledger_write is False

    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("anyone")
