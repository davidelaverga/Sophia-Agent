"""Canonical inventory rows decode without reintroducing old owner-wide joins."""

from contextlib import contextmanager
from uuid import UUID

import httpx
import pytest
from test_mem00_complete_pool import pool_page

from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

MEMORY_ID = "10000000-0000-4000-8000-000000000001"


@contextmanager
def pool_store(*, lifecycle="active", current_version=True):
    def transport(request):
        table = request.url.path.rsplit("/", 1)[-1]
        if table == "sophia_memory_contract":
            return httpx.Response(200, json=[{"contract_epoch": 1, "schema_version": "mem00.v1", "mode": "enforced",
                "updated_at": "2026-09-09T00:00:00Z"}])
        if table == "sophia_memory_user_governance":
            return httpx.Response(200, json=[{"user_id": "pool-owner", "authority_state": "governed", "authority_epoch": 1,
                "authority_declared_at": "2026-09-09T00:00:00Z"}])
        assert table == "sophia_memory_inventory_snapshot"
        page = pool_page(0, count=1, view="saved")
        page["records"][0].update(state=lifecycle, content="CURRENT SYNTHETIC EDIT")
        if not current_version:
            page.update(status="unavailable", records=[], total_count=None, summary=None, enumeration_complete=False)
        return httpx.Response(200, json=page)
    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        yield SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)


@pytest.mark.parametrize("lifecycle", ["active", "forgotten"])
def test_pool_maps_current_version_without_extra_database_join_key(lifecycle):
    with pool_store(lifecycle=lifecycle) as store:
        rows = store.list_pool(user_id="pool-owner", include_forgotten=True)
    assert len(rows) == 1 and rows[0].memory_id == UUID(MEMORY_ID)
    assert rows[0].canonical_content == "CURRENT SYNTHETIC EDIT"
    assert rows[0].current_content_revision == 2 and rows[0].memory_governance_revision == 3
    assert rows[0].lifecycle == lifecycle and rows[0].projection_state == "unavailable"
    assert "content_revision" not in rows[0].model_dump()


def test_missing_current_version_never_substitutes_an_older_revision():
    with pool_store(current_version=False) as store, pytest.raises(MemoryGovernanceUnavailable):
        store.list_pool(user_id="pool-owner", include_forgotten=True)
