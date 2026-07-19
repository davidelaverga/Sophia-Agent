from __future__ import annotations

import hashlib
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "2026_07_21_sophia_deck_quality_trace_grace_recovery.sql"
)
HISTORICAL_MIGRATIONS = {
    "2026_07_15_sophia_deck_quality_shadow_runs.sql":
        "328f10ae75f2f1b0f39523621621abe3802ddf98d660a1c70b69c3b5b64c0dfb",
    "2026_07_16_sophia_deck_quality_publications.sql":
        "52fc6d563bd85bb35ae2c92ffcd9b0a261e896ceeef3dcc8b751cf46557c1635",
    "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql":
        "f2fb0817f7d7d6d2b42a63ba135a0e46cf521c68c1a5c2b06af2b2367e611d08",
    "2026_07_18_sophia_deck_quality_producer_failure_signals.sql":
        "b52191c224d803e3d7d1ceed8b48b8b7857b0c3d148178c8622ae91a6bd81e66",
    "2026_07_19_sophia_deck_quality_dispatch_intent_fence.sql":
        "7be71d13814d5c9c9753286aeb840dd1d92b406e936a14a265af1bb5d8d1b761",
}


def test_trace_grace_recovery_migration_is_forward_only_and_fail_closed() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert sql.startswith("-- DQ-1 durable trace-grace recovery.")
    assert sql.rstrip().endswith("COMMIT;")
    assert (
        "LOCK TABLE public.sophia_deck_quality_shadow_runs\n"
        "        IN ACCESS EXCLUSIVE MODE;"
    ) in sql
    assert "deck_quality_trace_grace_recovery_environment_invalid" in sql
    assert "deck_quality_trace_grace_recovery_unknown_fingerprint" in sql
    assert "deck_quality_trace_grace_recovery_postflight_failed" in sql
    assert "v_server_major NOT IN (15, 16, 17)" in sql
    assert "__RECOVERY_SOURCE_HASH__" not in sql
    assert "__TARGET_CONSTRAINTS_HASH__" not in sql
    assert sql.count("DROP CONSTRAINT") == 2
    assert (
        "DROP CONSTRAINT "
        "sophia_deck_quality_shadow_terminal_precursor_new_write"
    ) in sql
    assert (
        "DROP CONSTRAINT "
        "sophia_deck_quality_shadow_terminal_trace_new_write"
    ) in sql
    assert "ADD COLUMN" not in sql
    assert "NOTIFY pgrst, 'reload schema';" in sql


def test_recovery_rpc_is_bounded_locked_and_only_recovers_expired_eligible_rows() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert (
        "CREATE OR REPLACE FUNCTION public."
        "sophia_recover_expired_deck_quality_shadow_runs("
    ) in sql
    assert "p_limit INTEGER DEFAULT 100" in sql
    assert ") RETURNS INTEGER" in sql
    assert "p_limit NOT BETWEEN 1 AND 100" in sql
    assert "deck_quality_trace_grace_recovery_limit_invalid" in sql
    assert "run.state = 'finalizing'" in sql
    assert "run.trace_deadline_at <= v_now" in sql
    assert "run.lease_expires_at IS NULL" in sql
    assert "run.lease_expires_at <= v_now" in sql
    assert "run.pending_terminal_state IN ('failed', 'stale')" in sql
    assert "run.pending_terminal_state IS NULL" in sql
    assert "run.stage = 'adjudicated'" in sql
    assert "run.stage_rank = 60" in sql
    assert "run.decision_result IS NOT NULL" in sql
    for artifact in ("decision", "safe_metrics", "run"):
        assert f"run.stage_artifact_hashes ? '{artifact}'" in sql
    assert (
        "ORDER BY run.trace_deadline_at,\n"
        "                  run.requested_at,\n"
        "                  run.quality_run_id"
    ) in sql
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "LIMIT p_limit" in sql


def test_recovery_update_changes_only_lifecycle_and_preserves_evidence_and_dispatch() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    update = sql.split(
        "UPDATE public.sophia_deck_quality_shadow_runs AS run",
        maxsplit=1,
    )[1].split("RETURNING run.quality_run_id", maxsplit=1)[0]

    for assignment in (
        "state = COALESCE(run.pending_terminal_state, 'failed')",
        "pending_terminal_state = COALESCE(",
        "error_count = run.error_count + CASE",
        "last_error_code = CASE",
        "THEN 'quality_persistence_error'",
        "last_error_stage = CASE",
        "THEN 'trace_deadline'",
        "next_attempt_at = LEAST(",
        "lease_owner = NULL",
        "lease_expires_at = NULL",
        "claim_token = NULL",
        "claim_hash = NULL",
        "finished_at = v_now",
        "updated_at = v_now",
    ):
        assert assignment in update
    assert "eligible.prepared_success" in update
    assert "synthesize_error" not in update
    for preserved in (
        "decision_result =",
        "decision_failure_codes =",
        "safe_metrics =",
        "trace_ids =",
        "stage_artifact_hashes =",
        "terminal_trace_payload_hash =",
        "safe_trace_root_input =",
        "dispatch_intent_status =",
        "dispatch_resolved_at =",
    ):
        assert preserved not in update


def test_constraint_exception_is_only_for_derived_post_grace_failure_shape() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    constraints = sql.split(
        "-- The only exception to normal trace completeness",
        maxsplit=1,
    )[1].split("CREATE OR REPLACE FUNCTION", maxsplit=1)[0]

    assert constraints.count("state IN ('failed', 'stale')") == 2
    assert constraints.count("pending_terminal_state = state") == 2
    assert constraints.count("finished_at >= trace_deadline_at") == 2
    assert constraints.count("finished_at = updated_at") == 2
    assert constraints.count("terminal_trace_payload_hash IS NULL") == 3
    assert constraints.count("safe_trace_root_input IS NOT NULL") == 4
    assert "state = 'completed'" not in constraints
    assert "NOT VALID" in constraints


def test_recovery_rpc_is_exactly_service_role_only() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    signature = (
        "sophia_recover_expired_deck_quality_shadow_runs(INTEGER)"
    )

    assert "SECURITY DEFINER" in sql
    assert "SET search_path = public" in sql
    assert f"ALTER FUNCTION public.{signature}\n    OWNER TO postgres;" in sql
    assert (
        f"REVOKE ALL ON FUNCTION public.{signature}\n"
        "    FROM PUBLIC, anon, authenticated, service_role;"
    ) in sql
    assert (
        f"GRANT EXECUTE ON FUNCTION public.{signature}\n"
        "    TO service_role;"
    ) in sql
    assert "procedure.prosecdef" in sql
    assert "procedure.proconfig = ARRAY['search_path=public']::TEXT[]" in sql
    assert sql.count("FROM pg_catalog.aclexplode(procedure.proacl) AS acl") == 4


def test_historical_dq1_migrations_remain_byte_identical() -> None:
    migration_dir = Path(__file__).resolve().parents[1] / "migrations"
    observed = {
        name: hashlib.sha256((migration_dir / name).read_bytes()).hexdigest()
        for name in HISTORICAL_MIGRATIONS
    }
    assert observed == HISTORICAL_MIGRATIONS
