"""Real HTTP-store Pool must enumerate one exact-current inventory, not capped joins."""

import json

import httpx
import pytest
from mem00_owner_fixture import declare_memory_owners

from deerflow.sophia.memory_governance.store import MemoryGovernanceUnavailable, SupabaseMemoryGovernanceStore


def pool_page(start, *, count=1005, view="active", fault="none"):
    rows = [{
        "kind": "memory", "id": f"10000000-0000-4000-8000-{n:012d}", "revision": 2, "state": "active",
        "reviewable": False, "session_id": None, "extraction_run_id": None, "source_manifest_ref": None,
        "content": f"CURRENT_SYNTHETIC_{n}", "category": "fact", "memory_governance_revision": 3,
        "user_tier": "none", "scope": "global", "created_at": "2026-09-09T00:00:00Z", "updated_at": None,
        "content_disposition": "current_canonical_text"} for n in range(start + 1, min(start + 200, count) + 1)]
    complete = start + len(rows) == count
    value = {"schema": "mem00.inventory.v1", "memory_contract_epoch": 1, "owner_id": "pool-owner",
        "scope": "current_saved_and_candidate_state", "view": view, "status": "available", "snapshot_id": "a"*32,
        "after_key": f"memory:10000000-0000-4000-8000-{start:012d}" if start else None,
        "summary": {"canonical_records": count, "candidate_records": 0, "reviewable_pending": 0,
            "withheld_candidates": 0, "unavailable_review_sources": 0, "unfinished_extraction_runs": 0},
        "total_count": count, "records": rows, "next_after_key": None if complete else "memory:"+rows[-1]["id"],
        "enumeration_complete": complete, "historical_versions_included": False, "source_transcripts_included": False,
        "provider_state_queried": False, "extraction_complete": False}
    if start and fault == "changed":
        value["status"] = "snapshot_changed"
    if start and fault == "partial":
        value["records"] = []
    if start and fault == "owner":
        value["owner_id"] = "wrong-owner"
    if start and fault == "old_version":
        value["records"][0]["content"] = None
    return value


@pytest.mark.parametrize("fault", ["none", "changed", "partial", "owner", "old_version", "outage"])
def test_pool_complete_or_zero_with_no_capped_table_reads(monkeypatch, fault):
    monkeypatch.setenv("SOPHIA_MEMORY_REFERENCE_HMAC_SECRET", "r"*32)
    calls = []
    def transport(request):
        name = request.url.path.rsplit("/", 1)[1]
        if name == "sophia_memory_contract":
            return httpx.Response(200, json=[{"contract_epoch": 1, "schema_version": "mem00.v1", "mode": "enforced",
                "updated_at": "2026-09-09T00:00:00Z"}])
        if name == "sophia_memory_user_governance":
            assert request.url.params["user_id"] == "eq.pool-owner"
            return httpx.Response(200, json=[{"user_id": "pool-owner", "authority_state": "governed", "authority_epoch": 1,
                "authority_declared_at": "2026-09-09T00:00:00Z"}])
        assert name == "sophia_memory_inventory_snapshot", "capped_pool_join_used"
        body = json.loads(request.content)
        assert body["p_user_id"] == "pool-owner" and body["p_view"] == "active" and body["p_page_size"] == 200
        start = 0 if body["p_after_key"] is None else int(body["p_after_key"][-12:])
        assert body["p_snapshot_id"] == ("a"*32 if start else None)
        calls.append(start)
        if start and fault == "outage":
            return httpx.Response(503, text="PRIVATE_UPSTREAM_FAILURE")
        return httpx.Response(200, json=pool_page(start, fault=fault))
    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://synthetic.invalid", service_role_key="synthetic", client=client)
        if fault == "none":
            result = store.list_pool(user_id="pool-owner")
            assert len(result) == 1005 and len(calls) == 6
            assert result[-1].canonical_content == "CURRENT_SYNTHETIC_1005"
            assert all(item.current_content_revision == 2 and item.projection_state == "unavailable" for item in result)
        else:
            with pytest.raises(MemoryGovernanceUnavailable):
                store.list_pool(user_id="pool-owner")
            assert calls == [0, 200]
