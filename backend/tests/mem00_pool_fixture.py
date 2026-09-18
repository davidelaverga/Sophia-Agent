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
