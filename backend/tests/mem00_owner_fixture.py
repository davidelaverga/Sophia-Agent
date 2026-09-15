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
    from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable

    def declare(owners):
        rows = {owner: OwnerMemoryAuthority(user_id=owner, authority_state=state, authority_epoch=1,
            authority_declared_at=datetime(2026,9,8,tzinfo=UTC)) for owner,state in owners.items()}
        def read(owner):
            if owner not in rows:
                raise MemoryGovernanceUnavailable("memory_owner_authority_unavailable")
            return rows[owner]
        authority = SimpleNamespace(get_owner_authority=read,
            get_contract=lambda: SimpleNamespace(contract_epoch=1,schema_version="mem00.v1",mode="enforced"))
        monkeypatch.setattr(owner_authority,"configured_memory_store",lambda:authority)
        return rows
    return declare
