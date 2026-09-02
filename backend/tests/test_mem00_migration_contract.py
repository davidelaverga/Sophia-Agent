from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "2026_09_02_mem00_durable_memory_governance.sql"


def test_mem00_schema_is_additive_default_disabled_and_browser_denied() -> None:
    sql = MIGRATION.read_text()
    assert "VALUES (true, 1, 'mem00.v1', 'disabled')" in sql
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "REVOKE ALL ON TABLE" in sql
    assert "FROM PUBLIC, anon, authenticated" in sql


def test_mem00_all_governance_mutations_and_workers_are_rpc_backed() -> None:
    sql = MIGRATION.read_text()
    for name in (
        "sophia_memory_enqueue_extraction",
        "sophia_memory_finalize_and_enqueue_extraction",
        "sophia_memory_invalidate_source",
        "sophia_memory_complete_extraction",
        "sophia_memory_fail_extraction",
        "sophia_memory_expire_candidates",
        "sophia_memory_approve_candidate",
        "sophia_memory_reject_candidate",
        "sophia_memory_manual_create",
        "sophia_memory_edit",
        "sophia_memory_forget",
        "sophia_memory_restore",
        "sophia_memory_tombstone",
        "sophia_memory_claim_projection",
        "sophia_memory_complete_projection",
        "sophia_memory_record_prompt_admission",
    ):
        assert f"CREATE OR REPLACE FUNCTION public.{name}" in sql
        assert f"REVOKE ALL ON FUNCTION public.{name}" in sql


def test_session_end_and_exact_extraction_enqueue_share_one_database_transaction() -> None:
    sql = MIGRATION.read_text()
    section = sql[sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_finalize_and_enqueue_extraction") : sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_claim_extraction")]
    assert "FROM public.sophia_sessions" in section
    assert "FOR UPDATE" in section
    assert "message_revision <> p_transcript_revision" in section
    assert "durable_sequence_start <> p_sequence_start" in section
    assert "durable_sequence_end <> p_sequence_end" in section
    assert "SET status = 'ended'" in section
    assert "public.sophia_memory_enqueue_extraction(" in section


def test_tombstone_scrubs_plaintext_and_advances_revocation_before_purge() -> None:
    sql = MIGRATION.read_text()
    tombstone = sql[sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_tombstone") :]
    scrub = tombstone.index("SET canonical_content = NULL")
    fence = tombstone.index("user_revocation_epoch = user_revocation_epoch + 1")
    purge = tombstone.index("'purge_binding', 'purge_queued'")
    assert scrub < purge
    assert fence < purge


def test_source_invalidation_scrubs_only_unapproved_candidates_and_detaches_manifests() -> None:
    sql = MIGRATION.read_text()
    section = sql[sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_invalidate_source") : sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_enqueue_extraction")]
    assert "candidate.review_state = 'pending_review'" in section
    assert "SET review_state = 'expired'" in section
    assert "SET proposed_content = NULL, content_ref = NULL" in section
    assert "source_link_manifest = rewritten.retained_manifest" in section
    assert "UPDATE public.sophia_memories" not in section


def test_provider_id_collisions_enter_reconciliation_hold() -> None:
    sql = MIGRATION.read_text()
    completion = sql[sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_complete_projection") :]
    assert "provider_id_collision" in completion
    assert "binding_state = 'reconciliation_hold'" in completion
    assert "metadata_verification_state = 'conflict'" in completion


def test_prompt_admission_rechecks_governance_and_exact_projection_atomically() -> None:
    sql = MIGRATION.read_text()
    admission = sql[sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_record_prompt_admission") : sql.index("CREATE OR REPLACE FUNCTION public.sophia_memory_expire_candidates")]
    assert "FOR SHARE" in admission
    assert "user_catalog_generation <> p_catalog_generation_checked" in admission
    assert "user_revocation_epoch <> p_revocation_epoch_checked" in admission
    assert "memory.lifecycle = 'active'" in admission
    assert "binding.binding_state = 'eligible'" in admission
    assert "binding.metadata_verification_state = 'verified'" in admission
    assert "NOT EXISTS" in admission
    assert "sophia_memory_tombstones" in admission
    assert admission.index("memory_prompt_admission_denied") < admission.index("INSERT INTO public.sophia_memory_prompt_admissions")
