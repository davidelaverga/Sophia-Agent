from __future__ import annotations

from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "2026_07_19_sophia_deck_quality_dispatch_intent_fence.sql"
)


def test_dispatch_intent_migration_is_forward_only_and_fail_closed() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert sql.startswith("-- DQ-1 durable launch-intent fence.")
    assert "BEGIN;" in sql
    assert "ADD COLUMN IF NOT EXISTS dispatch_intent_epoch BIGINT" in sql
    assert "ADD COLUMN IF NOT EXISTS dispatch_recovery_proof_hash TEXT" in sql
    assert "sophia_deck_quality_dispatch_intent_shape" in sql
    assert "deck_quality_dispatch_intent_unknown_fingerprint" in sql
    assert "deck_quality_dispatch_intent_environment_invalid" in sql
    assert "deck_quality_dispatch_intent_postflight_failed" in sql
    assert (
        "LOCK TABLE public.sophia_deck_quality_shadow_runs\n"
        "        IN ACCESS EXCLUSIVE MODE;"
    ) in sql
    assert all(
        fingerprint in sql
        for fingerprint in (
            "b94d81cab3cd8c3b5d52688d25d13140db436c5e84919bb42837efc7d4b7c7af",
            "072ca06532205ef065af9490c3dd3213385504eb3998e2534a939967853e4222",
            "5e1910787719dab7c6990a09561f777697ddd29e30f71a344bbeead60a4eb7b4",
            "025892f2c4330b247df11a1eeac457ed8b60e16d27286b141a9d293a600519af",
            "a42f81cd3a9d32172fd1d24325bab0ddcfd243302af9270b397e3137552a0958",
            "290ed9b9ca68d4ac8d7e36f63c877fc7a0b5e3a6edc61cf3bb9b598e0b67bdab",
            "11debe47e11932b2c4ec0fbe84adb5599f8a76b69122b51dae4ea7216621bbcb",
        )
    )
    for catalog in (
        "pg_catalog.pg_attribute",
        "pg_catalog.pg_attrdef",
        "pg_catalog.pg_constraint",
        "pg_catalog.pg_index",
        "pg_catalog.pg_policy",
        "pg_catalog.pg_trigger",
        "pg_catalog.pg_rewrite",
        "pg_catalog.pg_inherits",
        "pg_catalog.pg_publication_rel",
        "pg_catalog.pg_description",
    ):
        assert sql.count(catalog) >= 2
    assert "v_named_routine_count = 0" in sql
    assert sql.count("v_named_routine_count = 3") >= 2
    assert sql.count("pg_catalog.pg_get_functiondef(procedure.oid)") >= 2
    assert "v_run.attempt_count = 1 OR v_recovery_proven" in sql
    assert "v_run.last_error_code <> 'shadow_dispatch_unavailable'" in sql
    assert "v_safe_prelaunch_replay BOOLEAN" in sql
    assert "v_run.last_error_stage = 'shadow_dispatch_prelaunch'" in sql
    assert "'proof_kind', 'dispatch_prelaunch'" in sql
    assert "v_recovery_proof_hash IS NOT NULL" in sql
    assert (
        "v_run.dispatch_recovery_proof_hash IS DISTINCT FROM"
        in sql
    )
    assert "'proof_kind', 'pending_terminal'" in sql
    assert "'proof_kind', 'prepared_success'" in sql
    assert "'proof_kind', 'resumable_progress'" in sql
    assert "WHEN 'snapshot_loaded' THEN 'source_snapshot'" in sql
    assert "WHEN 'evidence_prepared' THEN 'evidence_manifest'" in sql
    assert "WHEN 'adjudicated' THEN 'decision'" in sql
    assert "v_run.stage_artifact_hashes ? v_stage_artifact_key" in sql
    assert "deck_quality_dispatch_checkpoint_invalid" in sql
    assert "'stage_artifact_key', CASE" in sql
    assert "'stage_artifact_hash', CASE" in sql
    assert "'stage_artifact_hashes', v_run.stage_artifact_hashes" not in sql
    assert "'decision_stage_hash', v_run.stage_artifact_hashes ->> 'decision'" in sql
    assert "dispatch_intent_status = 'unresolved'" in sql
    assert "dispatch_intent_status = 'prepared'" in sql
    assert "FOR UPDATE;" in sql
    assert "NOTIFY pgrst, 'reload schema';" in sql
    assert sql.rstrip().endswith("COMMIT;")


def test_dispatch_intent_rpcs_are_exact_token_fenced_and_service_role_only() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    signatures = (
        "sophia_begin_deck_quality_shadow_dispatch(TEXT, TEXT, BIGINT, TEXT)",
        "sophia_resolve_deck_quality_shadow_dispatch(TEXT, TEXT, TEXT)",
        "sophia_list_unresolved_deck_quality_shadow_dispatches(INTEGER)",
    )

    assert "dispatch_intent_token = p_dispatch_intent_token" in sql
    assert "dispatch_intent_status IN (\n           'prepared', 'unresolved', 'confirmed', 'reconciled'" in sql
    assert "SECURITY DEFINER" in sql
    assert sql.count("SET search_path = public") == 3
    for signature in signatures:
        assert f"ALTER FUNCTION public.{signature}\n    OWNER TO postgres;" in sql
        assert (
            f"REVOKE ALL ON FUNCTION public.{signature}\n"
            "    FROM PUBLIC, anon, authenticated, service_role;"
        ) in sql
        assert (
            f"GRANT EXECUTE ON FUNCTION public.{signature}\n"
            "    TO service_role;"
        ) in sql
