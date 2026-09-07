"""Real PostgREST row shapes must decode without relaxing canonical authority."""

from uuid import UUID

import httpx
import pytest

from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore

MEMORY_ID = "11111111-1111-4111-8111-111111111111"


def pool_store(*, lifecycle="active", current_version=True):
    def transport(request):
        assert request.method == "GET"
        assert request.url.params["user_id"] == "eq.synthetic-owner"
        table = request.url.path.rsplit("/", 1)[-1]
        rows = {
            "sophia_memories": [{
                "memory_id": MEMORY_ID, "user_id": "synthetic-owner", "lifecycle": lifecycle,
                "user_tier": "subconscious", "current_content_revision": 2,
                "memory_governance_revision": 3, "created_at": "2026-09-07T00:00:00Z",
                "updated_at": "2026-09-07T00:01:00Z",
            }],
            "sophia_memory_versions": [{
                "memory_id": MEMORY_ID, "content_revision": 1,
                "canonical_content": "STALE SYNTHETIC CONTENT", "content_ref": "stale-ref",
                "category": "fact", "scope": "global",
            }] + ([{
                "memory_id": MEMORY_ID, "content_revision": 2,
                "canonical_content": "CURRENT SYNTHETIC EDIT", "content_ref": "current-ref",
                "category": "fact", "scope": "global",
            }] if current_version else []),
            "sophia_memory_provider_bindings": [],
        }
        return httpx.Response(200, json=rows[table])

    return SupabaseMemoryGovernanceStore(
        url="https://synthetic.invalid", service_role_key="synthetic-key",
        client=httpx.Client(transport=httpx.MockTransport(transport)),
    )


@pytest.mark.parametrize("lifecycle", ["active", "forgotten"])
def test_pool_maps_current_version_without_extra_database_join_key(lifecycle):
    rows = pool_store(lifecycle=lifecycle).list_pool(user_id="synthetic-owner", include_forgotten=True)
    assert len(rows) == 1
    assert rows[0].memory_id == UUID(MEMORY_ID)
    assert rows[0].canonical_content == "CURRENT SYNTHETIC EDIT"
    assert rows[0].current_content_revision == 2
    assert rows[0].memory_governance_revision == 3
    assert rows[0].lifecycle == lifecycle
    assert "content_revision" not in rows[0].model_dump()


def test_missing_current_version_never_substitutes_an_older_revision():
    with pytest.raises(MemoryGovernanceUnavailable, match="canonical_version_unavailable"):
        pool_store(current_version=False).list_pool(user_id="synthetic-owner")
