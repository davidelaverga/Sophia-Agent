import pytest


@pytest.fixture
def declare_memory_owners(monkeypatch):
    """Explicit per-test durable declarations; NOT an autouse legacy bypass.

    Unit tests that replace DB I/O must name their intended owner/state. Unknown
    owners still fail closed. SQL and HTTP authority tests use their real seams.
    """
    from datetime import UTC, datetime
    from types import SimpleNamespace

    from deerflow.sophia.memory_governance import owner_authority
    from deerflow.sophia.memory_governance.models import OwnerMemoryAuthority
    from deerflow.sophia.memory_governance.store import MemoryOwnerUndeclared

    def declare(owners):
        rows = {owner: OwnerMemoryAuthority(user_id=owner, authority_state=state, authority_epoch=1,
            authority_declared_at=datetime(2026,9,8,tzinfo=UTC)) for owner,state in owners.items()}
        def read(owner):
            if owner not in rows:
                # This stub IS a reachable store, so an owner it does not hold is
                # undeclared, not unreachable. SupabaseMemoryGovernanceStore
                # raises MemoryOwnerUndeclared on a successful zero-row read;
                # raising the broad error here made every unnamed owner look like
                # an outage and hid the ordinary non-cohort path.
                raise MemoryOwnerUndeclared("memory_owner_undeclared")
            return rows[owner]
        authority = SimpleNamespace(get_owner_authority=read,
            get_contract=lambda: SimpleNamespace(contract_epoch=1,schema_version="mem00.v1",mode="enforced"))
        monkeypatch.setattr(owner_authority,"configured_memory_store",lambda:authority)
        return rows
    return declare


@pytest.fixture
def ordinary_memory_owner(monkeypatch):
    """A reachable store in which every owner is undeclared.

    This is production's shape for any user outside the pilot: the store answers,
    the schema is current, and the owner simply has no durable declaration. Use
    it for tests about ordinary non-memory behaviour, so they exercise the
    supported non-cohort path instead of the store-outage branch they hit when no
    store is configured at all.

    It declares nobody and weakens nothing: an undeclared owner still gets no
    governed lane and no legacy lane.
    """
    from types import SimpleNamespace

    from deerflow.sophia.memory_governance import owner_authority
    from deerflow.sophia.memory_governance.store import MemoryOwnerUndeclared

    def read(owner):  # noqa: ARG001 - signature mirrors the real store
        raise MemoryOwnerUndeclared("memory_owner_undeclared")

    store = SimpleNamespace(
        get_owner_authority=read,
        get_contract=lambda: SimpleNamespace(contract_epoch=1, schema_version="mem00.v1", mode="enforced"),
    )
    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: store)
    return store
