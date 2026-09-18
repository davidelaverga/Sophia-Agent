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

import json
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


def _roll_back_every_flag(monkeypatch):
    for name in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ",
                 "PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ", "COHORT_PRINCIPALS"):
        monkeypatch.delenv("SOPHIA_MEMORY_" + name, raising=False)


def test_rolled_back_flags_plus_an_outage_must_not_degrade(monkeypatch):
    """The combined case. This test previously asserted the opposite.

    It read: with every feature flag off, an unreachable store yields all-off
    flags. That was wrong, and it was wrong in the direction that loses data
    integrity rather than availability. Rolled-back flags say nothing about
    whether canonical rows exist -- the rows outlive the flag that produced
    them -- so degrading here would skip canonical source invalidation and
    recap cleanup on delete, and would let a local recap be served without
    binding it to a canonical source revision.

    Only two things may select all-off flags now: a definite
    MemoryOwnerUndeclared, or a deployment with no governance store at all.
    """
    from deerflow.sophia.memory_governance.owner_authority import ordinary_path_memory_flags_for_owner
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    _roll_back_every_flag(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://synthetic.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "synthetic")
    _use(monkeypatch, _DownStore())
    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("anyone")

    # ... and the same with the flags back on, which always raised.
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("anyone")


def test_missing_credentials_do_not_degrade_an_existing_protected_recap(pilot_env, monkeypatch, recaps):
    """Missing settings are not an absence of durable records.

    This is the production-shaped hazard: a deploy drops SUPABASE_URL or
    SUPABASE_SERVICE_ROLE_KEY while the feature flags happen to be rolled back.
    The database still holds every canonical row. An earlier version of the
    helper read that as "there is no MEM00 here" and returned all-off flags,
    which would have served a governed owner's local recap without binding it to
    a canonical revision, and skipped source invalidation on delete.

    Exercised against an already-written protected recap rather than against the
    helper alone, because the helper's answer is only interesting for what the
    routes do with it.
    """
    from fastapi import HTTPException

    from app.gateway.routers import sessions as sessions_router
    from deerflow.sophia.memory_governance.owner_authority import ordinary_path_memory_flags_for_owner
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    # A governed owner writes a recap while everything is healthy. The revision
    # binding is the real one -- the write refuses without it -- so what the
    # read below rejects is a recap that WAS properly bound.
    _use(monkeypatch, _StubStore("governed"))
    revision = ("rev-1", "synthetic-thread")
    monkeypatch.setattr(recaps.router, "_recap_source_revision", lambda *_: revision)
    recaps.router._write_session_recap("governed-pilot-owner", "synthetic-session",
                                       {"session_id": "synthetic-session",
                                        "thread_id": "synthetic-thread", "turn_count": 3})
    path = recaps.router._get_session_recap_path("governed-pilot-owner", "synthetic-session")
    assert path.exists()
    assert recaps.router._read_session_recap("governed-pilot-owner", "synthetic-session") is not None

    # Then the credentials go missing and the flags are rolled back.
    _roll_back_every_flag(monkeypatch)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SOPHIA_MEMORY_GOVERNANCE_ABSENT", raising=False)
    _use(monkeypatch, _DownStore())

    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("governed-pilot-owner")
    # The protected recap is not served...
    assert recaps.router._read_session_recap("governed-pilot-owner", "synthetic-session") is None
    assert path.exists(), "and it is not deleted either"
    # ...and the session delete is refused rather than skipping invalidation.
    with pytest.raises(HTTPException) as raised:
        sessions_router._cleanup_memory_session_recap("governed-pilot-owner", "synthetic-session")
    assert raised.value.status_code == 503
    with pytest.raises(MemoryGovernanceUnavailable):
        sessions_router._invalidate_memory_source_before_delete(
            "governed-pilot-owner",
            SimpleNamespace(session_id="synthetic-session", message_revision=1))


def test_the_absent_declaration_is_explicit_and_refused_in_a_deployment(monkeypatch):
    """The only remaining way to select all-off without an undeclared owner.

    It takes a positive operator declaration, and it is refused anywhere that
    looks like a deployment even when the declaration is present -- so it cannot
    be reached by a dropped setting, only by someone saying MEM00 is not
    installed here.
    """
    from deerflow.sophia.memory_governance.store import (
        GOVERNANCE_ABSENT_ENV,
        memory_governance_deliberately_absent,
    )

    for name in (GOVERNANCE_ABSENT_ENV, "RENDER", "RENDER_SERVICE_ID", "RENDER_GIT_COMMIT",
                 "VERCEL", "RAILWAY_ENVIRONMENT", "SOPHIA_ENV", "APP_ENV", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)

    assert memory_governance_deliberately_absent() is False, "silence is not a declaration"
    monkeypatch.setenv(GOVERNANCE_ABSENT_ENV, "true")
    assert memory_governance_deliberately_absent() is True

    for name, value in [("RENDER", "true"), ("RENDER_SERVICE_ID", "srv-1"),
                        ("RENDER_GIT_COMMIT", "abc123"), ("VERCEL", "1"),
                        ("RAILWAY_ENVIRONMENT", "production"), ("SOPHIA_ENV", "production"),
                        ("APP_ENV", "staging"), ("ENVIRONMENT", "prod")]:
        monkeypatch.setenv(name, value)
        assert memory_governance_deliberately_absent() is False, name
        monkeypatch.delenv(name)

    # And it answers from settings alone, never by reaching a store.
    assert memory_governance_deliberately_absent({GOVERNANCE_ABSENT_ENV: "yes"}) is True
    assert memory_governance_deliberately_absent({GOVERNANCE_ABSENT_ENV: "maybe"}) is False


def test_the_declared_local_case_still_degrades(monkeypatch):
    """A local checkout with MEM00 genuinely absent keeps the pre-MEM00 product."""
    from deerflow.sophia.memory_governance.owner_authority import ordinary_path_memory_flags_for_owner
    from deerflow.sophia.memory_governance.store import GOVERNANCE_ABSENT_ENV

    _roll_back_every_flag(monkeypatch)
    for name in ("RENDER", "RENDER_SERVICE_ID", "RENDER_GIT_COMMIT", "VERCEL",
                 "RAILWAY_ENVIRONMENT", "SOPHIA_ENV", "APP_ENV", "ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(GOVERNANCE_ABSENT_ENV, "true")
    _use(monkeypatch, _DownStore())
    assert ordinary_path_memory_flags_for_owner("anyone").candidate_ledger_write is False


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


def _roll_back_every_flag(monkeypatch):
    for name in ("CANDIDATE_LEDGER_WRITE", "CANDIDATE_LEDGER_READ", "CANONICAL_POOL_READ",
                 "PROVIDER_PROJECTION", "GOVERNED_RUNTIME_READ", "COHORT_PRINCIPALS"):
        monkeypatch.delenv("SOPHIA_MEMORY_" + name, raising=False)


def test_rolled_back_flags_plus_an_outage_must_not_degrade(monkeypatch):
    """The combined case. This test previously asserted the opposite.

    It read: with every feature flag off, an unreachable store yields all-off
    flags. That was wrong, and it was wrong in the direction that loses data
    integrity rather than availability. Rolled-back flags say nothing about
    whether canonical rows exist -- the rows outlive the flag that produced
    them -- so degrading here would skip canonical source invalidation and
    recap cleanup on delete, and would let a local recap be served without
    binding it to a canonical source revision.

    Only two things may select all-off flags now: a definite
    MemoryOwnerUndeclared, or a deployment with no governance store at all.
    """
    from deerflow.sophia.memory_governance.owner_authority import ordinary_path_memory_flags_for_owner
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    _roll_back_every_flag(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://synthetic.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "synthetic")
    _use(monkeypatch, _DownStore())
    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("anyone")

    # ... and the same with the flags back on, which always raised.
    for key, value in PILOT_ENV.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(MemoryGovernanceUnavailable):
        ordinary_path_memory_flags_for_owner("anyone")


# --- what the combined case actually protects --------------------------------
#
# The flags helper above is only a helper. These exercise the two behaviours a
# wrong answer there would have produced.


@pytest.fixture
def recaps(monkeypatch, tmp_path):
    """A real on-disk recap directory, wired into the gateway's helpers."""
    from app.gateway.routers import sophia as router

    users = tmp_path / "users"
    users.mkdir()
    monkeypatch.setattr(router, "USERS_DIR", users)
    monkeypatch.setenv("SUPABASE_URL", "https://synthetic.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "synthetic")
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "synthetic-runtime-key-" * 3)
    return SimpleNamespace(router=router, users=users)


def test_a_rolled_back_outage_never_serves_an_unvalidated_local_recap(pilot_env, monkeypatch, recaps):
    """The read half of the combined case.

    With a definitely-undeclared owner the local file IS the recap and is served
    as-is -- there is no canonical source to bind it to. With the store merely
    unreachable, the same file must not be served, because whether a canonical
    binding exists is exactly what could not be determined.
    """
    _use(monkeypatch, _StubStore("unknown"))
    recaps.router._write_session_recap("ordinary-production-user", "synthetic-session",
                                       {"session_id": "synthetic-session", "turn_count": 3})
    assert recaps.router._read_session_recap("ordinary-production-user", "synthetic-session") is not None

    _roll_back_every_flag(monkeypatch)
    _use(monkeypatch, _DownStore())
    assert recaps.router._read_session_recap("ordinary-production-user", "synthetic-session") is None


def test_a_rolled_back_outage_refuses_the_delete_rather_than_skipping_invalidation(pilot_env, monkeypatch):
    """The deletion half. Canonical rows outlive the flag that produced them."""
    from fastapi import HTTPException

    from app.gateway.routers import sessions as router

    invalidations = []
    monkeypatch.setattr(
        "deerflow.sophia.memory_governance.service.CanonicalMemoryService",
        lambda **kwargs: SimpleNamespace(
            invalidate_source_session=lambda **inner: invalidations.append(inner)))

    record = SimpleNamespace(session_id="synthetic-session", message_revision=1)
    _roll_back_every_flag(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://synthetic.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "synthetic")
    _use(monkeypatch, _DownStore())
    with pytest.raises(Exception) as raised:
        router._invalidate_memory_source_before_delete("ordinary-production-user", record)
    assert not isinstance(raised.value, HTTPException), "this must not become a silent skip"
    assert invalidations == [], "nothing was invalidated, and the delete did not proceed"

    # A definitely-undeclared owner has no canonical source, so there is genuinely
    # nothing to fence and the delete proceeds.
    _use(monkeypatch, _StubStore("unknown"))
    assert router._invalidate_memory_source_before_delete("ordinary-production-user", record) is None
    assert invalidations == []


# --- ordinary recap cleanup: create -> delete -> read/retry -------------------


def test_ordinary_recap_is_created_deleted_and_stays_deleted(pilot_env, monkeypatch, recaps):
    """An undeclared owner's recap must not survive the session's deletion.

    `_write_session_recap` works for these owners now, so they have a local
    recap; the cleanup helper used to delete one only when `canonical_pool_read`
    was true, which is never true for them. The file would have outlived the
    session it was derived from.
    """
    from app.gateway.routers import sessions as sessions_router

    _use(monkeypatch, _StubStore("unknown"))
    recaps.router._write_session_recap("ordinary-production-user", "synthetic-session",
                                       {"session_id": "synthetic-session", "turn_count": 3})
    path = recaps.router._get_session_recap_path("ordinary-production-user", "synthetic-session")
    assert path.exists()

    sessions_router._cleanup_memory_session_recap("ordinary-production-user", "synthetic-session")
    assert not path.exists()
    assert recaps.router._read_session_recap("ordinary-production-user", "synthetic-session") is None

    # Retry after the file is already gone: idempotent, not an error.
    sessions_router._cleanup_memory_session_recap("ordinary-production-user", "synthetic-session")
    assert recaps.router._read_session_recap("ordinary-production-user", "synthetic-session") is None


def test_governed_recap_cleanup_keeps_its_receipt(pilot_env, monkeypatch, recaps):
    """The governed branch is unchanged: file removed AND the receipt emitted."""
    from app.gateway.routers import sessions as sessions_router

    events = []
    monkeypatch.setattr("deerflow.sophia.memory_governance.observability.emit_memory_event",
                        lambda name, **fields: events.append(name))
    _use(monkeypatch, _StubStore("governed"))
    path = recaps.router._get_session_recap_path("governed-pilot-owner", "synthetic-session")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")

    sessions_router._cleanup_memory_session_recap("governed-pilot-owner", "synthetic-session")
    assert not path.exists()
    assert events == ["memory.session.recap_cleanup"]


def test_recap_cleanup_still_503s_on_an_outage(pilot_env, monkeypatch, recaps):
    from fastapi import HTTPException

    from app.gateway.routers import sessions as sessions_router

    _use(monkeypatch, _DownStore())
    with pytest.raises(HTTPException) as raised:
        sessions_router._cleanup_memory_session_recap("ordinary-production-user", "synthetic-session")
    assert raised.value.status_code == 503


# --- the synthetic Builder exception, and its limits -------------------------


def test_a_complete_synthetic_admission_does_not_need_a_legacy_declaration(pilot_env, monkeypatch):
    """MEM00 refuses to declare the Voice Lab principal, on purpose.

    `require_legacy_memory_lane` in the ordinary Builder dispatch therefore
    refused every synthetic run, withdrawing Voice Lab's own Builder path. A
    complete synthetic admission is exempt because
    `synthetic_builder_projection` marks those runs memory_retrieval_excluded
    and memory_learning_excluded -- the unversioned lane the gate protects is
    structurally absent from them.

    The exemption is the COMPLETE admission, not the word "synthetic": an
    incomplete one is still refused, and an ordinary undeclared owner still
    gets no Builder.
    """
    from deerflow.sophia.memory_governance.owner_authority import require_legacy_memory_lane
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
    from deerflow.sophia.synthetic_builder import (
        SyntheticBuilderContextError,
        normalize_synthetic_builder_context,
        synthetic_builder_projection,
    )

    _use(monkeypatch, _StubStore("unknown"))
    # Unchanged: an ordinary undeclared owner has no legacy lane.
    with pytest.raises(MemoryGovernanceUnavailable):
        require_legacy_memory_lane("ordinary-production-user")

    # A bare claim is not an admission.
    with pytest.raises(SyntheticBuilderContextError):
        normalize_synthetic_builder_context({"synthetic": True}, require_complete=True)

    # And a complete one carries the exclusions that make the exemption safe.
    import hashlib
    import uuid
    from datetime import timedelta

    anchor = datetime.now(UTC).replace(microsecond=0)
    admission = {
        "synthetic": True, "test_run_id": "voice-lab-run-1", "principal_id": "voice-lab-test",
        "scenario_id": "builder-presentation", "scenario_version": "1.0", "environment": "production",
        "cleanup_obligation_id": str(uuid.UUID(
            hex=hashlib.sha256(b"voice-lab-run-1").hexdigest()[:32], version=4)),
        "provider_expires_at": (anchor + timedelta(minutes=30)).isoformat(
            timespec="milliseconds").replace("+00:00", "Z"),
        "retention_hours": 1, "retention_anchor": "builder_task_created_at_provisional",
        "retention_anchor_at": anchor.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "retention_expires_at": (anchor + timedelta(hours=1)).isoformat(
            timespec="milliseconds").replace("+00:00", "Z"),
        "deployment_identity": {"frontend_deployment_id": "f-1", "voice_deployment_id": "v-1"},
    }
    context = normalize_synthetic_builder_context(admission, require_complete=True)
    assert context["isolation_status"] == "isolated"
    projection = synthetic_builder_projection(context)
    assert projection["memory_retrieval_excluded"] is True
    assert projection["memory_learning_excluded"] is True


def test_an_undeclared_owner_dispatches_the_builder_source_only(pilot_env, monkeypatch, tmp_path):
    """The Builder restriction on non-pilot accounts, closed.

    `require_legacy_memory_lane` outside a governed run refused every owner
    without a durable pre-cutover declaration -- that is, every ordinary account
    -- so the Builder was a pilot-only feature by accident. It is now dispatched
    for a definitely-undeclared owner, and what makes that safe is stated by the
    assertions rather than assumed:

      * no declaration is minted: the owner is still undeclared afterwards;
      * no memory is inherited: `_resolve_memory_snippets` returns nothing even
        with injected memory sitting in state;
      * the owner is the trusted runtime one, not the model's argument.
    """
    import asyncio

    from langchain_core.messages import HumanMessage

    from deerflow.sophia.memory_governance.owner_authority import (
        owner_is_definitely_undeclared,
        require_legacy_memory_lane,
    )
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable
    from deerflow.sophia.tools import start_builder_task as module
    from test_start_builder_task import _make_fake_sdk_client, _make_runtime

    _use(monkeypatch, _StubStore("unknown"))
    assert owner_is_definitely_undeclared("ordinary-production-user") is True
    # Unchanged: they have no legacy lane, and dispatch does not give them one.
    with pytest.raises(MemoryGovernanceUnavailable):
        require_legacy_memory_lane("ordinary-production-user")

    # Memory-shaped state is present and must not reach the brief.
    state = {
        "user_id": "ordinary-production-user",
        "messages": [HumanMessage("Write me a short report on the migration.")],
        "injected_memory_contents": ["SYNTHETIC_MEMORY_MUST_NOT_ENTER"],
        "injected_memories": ["SYNTHETIC_MEMORY_MUST_NOT_ENTER"],
    }
    assert module._resolve_memory_snippets(state, owner_id="ordinary-production-user") == []

    fake_client, captured = _make_fake_sdk_client(thread_id="ord-1", run_id="run-ord")
    monkeypatch.setattr("langgraph_sdk.get_client", lambda url=None: fake_client)
    asyncio.run(module.start_builder_task.coroutine(
        description="Write me a short report on the migration.",
        task_type="document",
        # The model's own argument names somebody else; the trusted runtime
        # owner is what dispatch must use.
        user_id="someone-else",
        runtime=_make_runtime(state),
    ))

    run_input = captured["run_kwargs"]["input"]
    delegation = run_input["delegation_context"]
    assert delegation["task"] == "Write me a short report on the migration."
    assert delegation["relevant_memories"] == [], "source-only: nothing carried in"
    # The trusted runtime owner won over the model's argument.
    assert captured["run_kwargs"]["config"]["configurable"]["user_id"] == "ordinary-production-user"
    assert "SYNTHETIC_MEMORY_MUST_NOT_ENTER" not in json.dumps(captured, default=str)
    assert "someone-else" not in json.dumps(captured, default=str)
    # And still undeclared: dispatching did not enrol anybody.
    assert owner_is_definitely_undeclared("ordinary-production-user") is True
