from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "2026_07_20_sophia_build_mutation_transactions.sql"


def test_mutation_migration_is_forward_idempotent_and_recovery_safe() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert sql.startswith("-- DQ-2 durable exact-canary mutation transaction substrate.")
    assert "CREATE TABLE IF NOT EXISTS public.sophia_build_mutation_transactions" in sql
    assert "ADD COLUMN IF NOT EXISTS created_at" in sql
    assert "sophia_build_mutation_operation_idx" in sql
    assert "user_id, build_id, operation_id" in sql
    assert "sophia_build_mutation_active_idx" in sql
    assert "sophia_build_mutation_recovery_idx" in sql
    assert "build_mutation_legacy_row_invalid" in sql
    assert "build_mutation_operation_id_conflict" in sql
    assert "transaction.transaction_payload -> 'campaign_run_id'" in sql
    assert "transaction.transaction_payload -> 'expected_component_versions'" in sql
    assert "transaction.transaction_payload -> 'expected_artifact_hash'" in sql
    assert "transaction.transaction_payload -> 'authorized_selectors'" in sql
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "FORCE ROW LEVEL SECURITY" in sql
    assert "build_mutation_unexpected_rls_policy" in sql
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "lease_expires_at <= clock_timestamp()" in sql
    assert "NOTIFY pgrst, 'reload schema';" in sql
    assert sql.rstrip().endswith("COMMIT;")


def test_mutation_rpcs_are_lease_status_cas_fenced_and_service_role_only() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    functions = (
        "sophia_create_build_mutation_transaction",
        "sophia_get_build_mutation_transaction",
        "sophia_get_build_mutation_transaction_by_operation",
        "sophia_acquire_build_mutation_lease",
        "sophia_renew_build_mutation_lease",
        "sophia_transition_build_mutation_transaction",
        "sophia_recover_build_mutation_transactions",
        "sophia_get_build_manifest_head",
        "sophia_commit_build_mutation_manifest",
    )

    for function in functions:
        assert f"CREATE OR REPLACE FUNCTION public.{function}" in sql
        assert f"ALTER FUNCTION public.{function}" in sql
        assert f"REVOKE ALL ON FUNCTION public.{function}" in sql
        assert f"GRANT EXECUTE ON FUNCTION public.{function}" in sql
    assert sql.count("SECURITY DEFINER") == 9
    assert sql.count("SET search_path = public, pg_temp") == 9
    assert sql.count("TO service_role;") == 9
    assert "GRANT SELECT ON TABLE public.sophia_build_mutation_transactions" not in sql
    assert ("REVOKE ALL ON TABLE public.sophia_build_mutation_transactions FROM PUBLIC;") in sql
    assert "DO $table_acl_convergence$" in sql
    assert "DO $function_acl_convergence$" in sql
    assert "pg_catalog.aclexplode" in sql

    assert "v_transaction.status IS DISTINCT FROM p_expected_status" in sql
    assert "v_transaction.lease_owner IS DISTINCT FROM p_lease_owner" in sql
    assert "v_transaction.lease_expires_at <= clock_timestamp()" in sql
    assert "transaction.status = p_expected_status" in sql
    assert "transaction.lease_owner = p_lease_owner" in sql
    assert "transaction.lease_expires_at > clock_timestamp()" in sql
    assert "p_expected_lease_expires_at TIMESTAMPTZ" in sql
    assert "transaction.lease_expires_at = p_expected_lease_expires_at" in sql
    assert "p_expected_status = 'prepared'" in sql
    assert "p_new_status IN ('staged', 'rolling_back', 'failed')" in sql
    assert "p_expected_status = 'staged'" in sql
    assert "p_new_status IN ('verified', 'rolling_back', 'failed')" in sql
    assert "p_expected_status = 'verified'" in sql
    assert "p_new_status IN ('committing', 'rolling_back', 'failed')" in sql
    assert "p_expected_status = 'committing'" in sql
    assert "p_new_status IN ('rolling_back', 'failed')" in sql
    assert "p_new_status IN ('committed', 'rolling_back', 'failed')" not in sql
    assert "p_expected_status = 'rolling_back'" in sql
    assert "p_new_status IN ('rolled_back', 'failed')" in sql
    assert "v_lease_expires_at > v_now + INTERVAL '900 seconds'" in sql
    assert sql.index("IF FOUND THEN") < sql.index("build_mutation_initial_lease_invalid")
    assert "build_mutation_staged_identity_invalid" in sql
    assert "p_transaction_payload -> 'staged_object_paths'" in sql
    assert "p_transaction_payload -> 'candidate_version_ids'" in sql


def test_mutation_rpc_requires_and_preserves_dq2_evidence_identity() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    for field in (
        "campaign_run_id",
        "authorized_source_roles",
        "repair_program_hash",
        "initial_quality_run_id",
        "candidate_quality_run_id",
        "comparison_hash",
    ):
        assert field in sql
    assert "build_mutation_dq2_evidence_invalid" in sql
    assert "build_mutation_source_role_invalid" in sql
    assert "build_mutation_identity_changed" in sql
    assert "build_mutation_comparison_required" in sql
    assert "p_new_status IN ('verified', 'committing', 'committed')" in sql
    assert "repair_program_hash', '')\n            !~ '^[0-9a-f]{64}$'" in sql
    assert "comparison_hash'\n                    !~ '^[0-9a-f]{64}$'" in sql


def test_operation_lookup_includes_terminal_transactions_by_exact_unique_identity() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    lookup = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_get_build_mutation_transaction_by_operation",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_acquire_build_mutation_lease",
        maxsplit=1,
    )[0]

    assert "transaction.build_id = p_build_id" in lookup
    assert "transaction.user_id = p_user_id" in lookup
    assert "transaction.operation_id = p_operation_id" in lookup
    assert "transaction.status" not in lookup


def test_recovery_claims_only_complete_dq2_evidence_rows() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    recovery = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_recover_build_mutation_transactions",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_get_build_manifest_head",
        maxsplit=1,
    )[0]

    for field in (
        "campaign_run_id",
        "owner_thread_id",
        "initial_quality_run_id",
        "repair_program_hash",
        "expected_artifact_version_id",
        "expected_artifact_hash",
        "expected_component_versions",
        "authorized_selectors",
        "authorized_source_roles",
        "gate_evidence",
    ):
        assert f"'{field}'" in recovery
    assert "transaction.status NOT IN ('verified', 'committing')" in recovery
    assert "candidate_quality_run_id" in recovery
    assert "comparison_hash" in recovery
    assert "count(DISTINCT selector.value #>> '{}')" in recovery
    assert "jsonb_object_keys(" in recovery
    assert "jsonb_each(" in recovery
    assert "'expected_component_versions'" in recovery
    assert "'authorized_source_roles'" in recovery
    assert recovery.count("? selector.value") == 2
    assert "jsonb_array_length(role.roles) = 0" in recovery
    assert "count(DISTINCT source_role.value #>> '{}')" in recovery
    assert "jsonb_typeof(component.version) <> 'string'" in recovery
    assert "jsonb_typeof(source_role.value)" in recovery


def test_atomic_commit_cas_updates_head_registry_outbox_and_transaction_together() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    function = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_commit_build_mutation_manifest",
        maxsplit=1,
    )[1].split("ALTER FUNCTION public.sophia_create_build_mutation_transaction", maxsplit=1)[0]

    assert "FOR UPDATE" in function
    assert "build_manifest_concurrent_modification" in function
    assert "expected_artifact_version_id" in function
    assert "candidate_version_ids" in function
    assert "UPDATE public.sophia_build_manifest_heads" in function
    assert "UPDATE public.sophia_build_registry" in function
    assert "build_registry_concurrent_modification" in function
    assert "INSERT INTO public.sophia_build_acceptance_outbox" in function
    assert "UPDATE public.sophia_build_mutation_transactions" in function
    assert "SET status = 'committed'" in function
    assert "build_mutation_manifest_commit_replay_conflict" in function
    assert "p_acceptance_payload ->> 'origin' IS DISTINCT FROM 'quality_repair'" in function
    assert "p_lease_expires_at TIMESTAMPTZ" in function
    assert "v_transaction.lease_expires_at IS DISTINCT FROM p_lease_expires_at" in function
    assert "transaction.lease_expires_at = p_lease_expires_at" in function
    assert "v_expected_manifest_object_path" in function
    assert "v_head.owner_thread_id IS DISTINCT FROM p_owner_thread_id" in function
    assert "v_registry.owner_thread_id IS DISTINCT FROM p_owner_thread_id" in function


def test_generic_transition_cannot_bypass_atomic_manifest_commit() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    transition = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_transition_build_mutation_transaction",
        maxsplit=1,
    )[1].split(
        "CREATE OR REPLACE FUNCTION public.sophia_recover_build_mutation_transactions",
        maxsplit=1,
    )[0]

    assert "p_expected_status = 'committing'" in transition
    assert "p_new_status IN ('rolling_back', 'failed')" in transition
    assert "p_new_status IN ('committed', 'rolling_back', 'failed')" not in transition
