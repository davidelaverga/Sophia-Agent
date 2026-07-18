from __future__ import annotations

import hashlib
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "2026_07_18_sophia_deck_quality_producer_failure_signals.sql"
)
HISTORICAL_MIGRATIONS = {
    "2026_07_15_sophia_deck_quality_shadow_runs.sql":
        "328f10ae75f2f1b0f39523621621abe3802ddf98d660a1c70b69c3b5b64c0dfb",
    "2026_07_16_sophia_deck_quality_publications.sql":
        "52fc6d563bd85bb35ae2c92ffcd9b0a261e896ceeef3dcc8b751cf46557c1635",
    "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql":
        "f2fb0817f7d7d6d2b42a63ba135a0e46cf521c68c1a5c2b06af2b2367e611d08",
}


def test_forward_failure_signal_migration_is_independent_and_service_role_only() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert sql.startswith(
        "-- DQ-1 independent producer double-storage-failure evidence."
    )
    guard_end = sql.index("$migration_guard$;")
    assert guard_end < sql.index("CREATE TABLE IF NOT EXISTS")
    assert guard_end < sql.index("COMMENT ON TABLE")
    assert guard_end < sql.index("CREATE OR REPLACE FUNCTION")
    assert "deck_quality_producer_failure_signal_unknown_fingerprint" in sql
    assert "v_server_major NOT IN (15, 16, 17)" in sql
    assert sql.count("COALESCE(attribute.attstattarget, -1)") == 2
    assert sql.count("'REFERENCES', 'TRIGGER', 'MAINTAIN'") == 2
    assert "v_named_routine_count <> 3" in sql
    assert "v_columns_hash" in sql
    assert "v_constraints_hash" in sql
    assert "v_table_acl_valid" in sql
    assert "v_record_attributes_valid" in sql
    assert "v_record_acl_valid" in sql
    assert "pg_catalog.pg_get_functiondef" in sql
    assert "CREATE EXTENSION" not in sql
    assert "digest(" not in sql
    assert "pg_catalog.sha256(" in sql
    assert "pg_catalog.convert_to(" in sql
    assert "pg_catalog.encode(" in sql
    assert "CREATE TABLE IF NOT EXISTS public.sophia_deck_quality_producer_failure_signals" in sql
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "FORCE ROW LEVEL SECURITY" in sql
    assert "shadow_dispatch_unavailable" in sql
    assert "v_outcome := 'replayed'" in sql
    assert "v_outcome := 'conflict'" in sql
    assert "resolved_at = NULL" in sql
    assert "canonical_recovery_verified" in sql
    assert "operator_acknowledged" in sql
    assert sql.count("OWNER TO postgres;") == 4
    assert "ALTER TABLE public.sophia_deck_quality_producer_failure_signals\n    OWNER TO postgres;" in sql
    assert "DO $postflight$" in sql
    assert "deck_quality_producer_failure_signal_postflight_failed" in sql
    assert sql.index("DO $postflight$") < sql.index("NOTIFY pgrst")
    for fingerprint_check in (
        "INTO v_table_attributes_valid",
        "INTO v_table_type_valid",
        "INTO v_table_acl_valid",
        "INTO v_columns_hash",
        "INTO v_constraints_hash",
        "INTO v_index_valid",
        "INTO v_auxiliary_state_valid",
    ):
        assert sql.count(fingerprint_check) >= 2
    assert sql.count(
        "4fb4251c38655d0139ba3d3a75ba7db1aa657e5c1c274c9395945bebf147c0a2"
    ) >= 2
    assert sql.count(
        "2f1cd1671dd620f82f2d9abcbde720e388a54643769bb3ad4c623ceee8ee101f"
    ) >= 2
    postflight = sql.split("DO $postflight$", maxsplit=1)[1]
    assert (
        "pg_catalog.obj_description(\n"
        "                     procedure.oid, 'pg_proc'\n"
        "                 ) IS NULL"
        in postflight
    )
    assert "NOTIFY pgrst, 'reload schema';" in sql
    assert sql.rstrip().endswith("COMMIT;")
    assert sql.count("TO service_role;") == 3
    assert "TO anon;" not in sql
    assert "TO authenticated;" not in sql
    assert "TO PUBLIC;" not in sql


def test_historical_campaign_migrations_remain_byte_identical() -> None:
    migration_dir = Path(__file__).resolve().parents[1] / "migrations"
    observed = {
        name: hashlib.sha256((migration_dir / name).read_bytes()).hexdigest()
        for name in HISTORICAL_MIGRATIONS
    }
    assert observed == HISTORICAL_MIGRATIONS
