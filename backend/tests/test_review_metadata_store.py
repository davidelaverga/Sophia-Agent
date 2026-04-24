from __future__ import annotations

import json
from unittest.mock import patch


def test_apply_review_metadata_overlays_promotes_unresolved_entry(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Needs review",
            metadata={"status": "pending_review", "category": "fact"},
            session_id="sess_1",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "m1", "memory": "Needs review", "metadata": None, "categories": []}],
        )

        assert overlaid[0]["metadata"]["status"] == "pending_review"
        assert overlaid[0]["category"] == "fact"

        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"][0]["memory_id"] == "m1"


def test_remove_review_metadata_by_memory_id(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="m1",
            content="Needs review",
            metadata={"status": "pending_review"},
            sync_state="manual",
        )

        removed = store.remove_review_metadata("user1", memory_id="m1")

        assert removed is True
        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"] == []


def test_apply_review_metadata_overlays_appends_local_only_entries(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Unmatched pending review memory",
            metadata={"status": "pending_review", "category": "fact"},
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays("user1", [])

        assert len(overlaid) == 1
        assert overlaid[0]["id"].startswith("local:")
        assert overlaid[0]["metadata"]["status"] == "pending_review"


def test_reconcile_review_metadata_entries_matches_equivalent_real_memory(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="User has an investor pitch scheduled for 2026-04-07.",
            metadata={"status": "pending_review", "category": "fact"},
            sync_state="local_only",
        )

        reconciled = store.reconcile_review_metadata_entries(
            "user1",
            [{"id": "mem_1", "memory": "User has an investor pitch scheduled for April 7, 2026.", "metadata": None}],
        )
        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "mem_1", "memory": "User has an investor pitch scheduled for April 7, 2026.", "metadata": None}],
        )

        assert reconciled == 1
        assert len(overlaid) == 1
        assert overlaid[0]["id"] == "mem_1"
        assert overlaid[0]["metadata"]["status"] == "pending_review"

        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"][0]["memory_id"] == "mem_1"


def test_reconcile_review_metadata_entries_upgrades_local_placeholder_id(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="local:placeholder-hash",
            content="User wants to protect quiet mornings for deep work.",
            metadata={"status": "discarded", "category": "preference"},
            session_id="sess_1",
            sync_state="manual",
        )

        reconciled = store.reconcile_review_metadata_entries(
            "user1",
            [{
                "id": "mem_real_1",
                "memory": "User wants to protect quiet mornings for focused work.",
                "metadata": None,
                "categories": ["preference"],
            }],
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{
                "id": "mem_real_1",
                "memory": "User wants to protect quiet mornings for focused work.",
                "metadata": None,
                "categories": ["preference"],
            }],
        )

        assert reconciled == 1
        assert len(overlaid) == 1
        assert overlaid[0]["id"] == "mem_real_1"
        assert overlaid[0]["metadata"]["status"] == "discarded"

        saved = json.loads((tmp_path / "user1" / "memories" / "review_metadata.json").read_text(encoding="utf-8"))
        assert saved["entries"][0]["memory_id"] == "mem_real_1"


def test_apply_review_metadata_overlays_replaces_memory_text_with_local_edit(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="mem_1",
            content="Updated local memory text",
            metadata={"status": "approved", "category": "ritual_context"},
            sync_state="manual",
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "mem_1", "memory": "Original remote memory text", "metadata": {"status": "approved"}}],
        )

        assert len(overlaid) == 1
        assert overlaid[0]["memory"] == "Updated local memory text"
        assert overlaid[0]["content"] == "Updated local memory text"
        assert overlaid[0]["metadata"]["category"] == "ritual_context"


def test_apply_review_metadata_overlays_deduplicates_local_only_entries_with_same_hash(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            content="Repeated local memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_1",
            sync_state="local_only",
        )
        store.upsert_review_metadata(
            "user1",
            content="Repeated local memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_2",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays("user1", [])

        assert len(overlaid) == 1
        assert overlaid[0]["id"].startswith("local:")
        assert overlaid[0]["memory"] == "Repeated local memory"


def test_apply_review_metadata_overlays_suppresses_unresolved_sibling_once_real_memory_exists(tmp_path):
    import deerflow.sophia.review_metadata_store as store

    with patch.object(store, "USERS_DIR", tmp_path):
        store.upsert_review_metadata(
            "user1",
            memory_id="mem_1",
            content="Repeated memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_1",
            sync_state="reconciled",
        )
        store.upsert_review_metadata(
            "user1",
            content="Repeated memory",
            metadata={"status": "approved", "category": "fact"},
            session_id="sess_2",
            sync_state="local_only",
        )

        overlaid = store.apply_review_metadata_overlays(
            "user1",
            [{"id": "mem_1", "memory": "Repeated memory", "metadata": {"status": "approved"}}],
        )

        assert len(overlaid) == 1
        assert overlaid[0]["id"] == "mem_1"