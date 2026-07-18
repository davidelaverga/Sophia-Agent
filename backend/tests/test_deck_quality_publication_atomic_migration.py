from __future__ import annotations

from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql"
)


def _function_block(sql: str, name: str, next_name: str) -> str:
    return sql.split(
        f"CREATE OR REPLACE FUNCTION public.{name}", maxsplit=1
    )[1].split(f"CREATE OR REPLACE FUNCTION public.{next_name}", maxsplit=1)[0]


def test_forward_atomic_publication_migration_is_fail_closed_and_idempotent() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")

    assert sql.startswith("-- DQ-1 publication request/input convergence.")
    assert "BEGIN;" in sql
    assert "LOCK TABLE public.sophia_deck_quality_publications\n    IN ACCESS EXCLUSIVE MODE;" in sql
    assert "deck_quality_publication_atomic_migration_unknown_fingerprint" in sql
    assert "deck_quality_publication_atomic_migration_environment_invalid" in sql
    assert "v_server_major NOT IN (15, 16, 17)" in sql
    assert sql.count("COALESCE(attribute.attstattarget, -1)") == 2
    assert sql.count(
        "d588b45201221b60a38b2c4254af121ad1c3c2ce27c50d899c8d47bf8f868795"
    ) == 2
    assert "DO $migration_postflight$" in sql
    assert (
        "deck_quality_publication_atomic_migration_postflight_failed" in sql
    )
    assert "deck_quality_publication_atomic_migration_legacy_rows_present" in sql
    assert "SELECT 1 FROM public.sophia_deck_quality_publications LIMIT 1" in sql
    assert all(
        fingerprint in sql
        for fingerprint in (
            "ed3ab9d582ceccf766e3523082108c38aded2cf19c41c399c93eb7ee478acef6",
            "b2a7ac118a4ef5830be233bfd55270b5887d2094dea2890ead1b786d9572484c",
            "a207aa72bf2b23ba9c76a4466f1dfb54cc714fc50c71c994f9ca962b01c697ee",
            "9a068fb761d5bf36dd23516d9a40aa44372bddb96b664e745815ed07517e327d",
            "bc31483a47c8cd4b71c0d6c7d71ffc9cd9041beee79ac68c75e68ed3a18793c0",
            "06efeaa941970eb7d86d52043ea5370662120a1970cffb20814d5bd90d1cc663",
        )
    )
    assert all(
        fingerprint in sql
        for fingerprint in (
            "cc7129153cc85a265e920560063fe632d7f59bfb3dc665af068d876685cb3757",
            "396d5e8ed627d13fc9b02a63357a2c29ced78a2aa6f47ba350f09e608d1a7c18",
            "76fe211b6b94233fa3f2651b867811ebe43087d31eacc47ff03fbb54c9bc68db",
            "55bcf4bd3539f941ea689a257d97b4145fd92641ab1025ffb0ac3c34131bd770",
            "6d64b6757765ff52e46c79c05f728948edb06ef00663b78bb0011adc3546ace6",
            "968a2fb40085a5ce0761d0eb5ec589a874a2c1ed5ee7420b5807b23b9efb987e",
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
        assert catalog in sql
    assert "v_named_routine_count = 3" in sql
    assert sql.count("v_named_routine_count = 4") >= 2
    assert sql.count("pg_catalog.pg_get_functiondef(procedure.oid)") >= 2
    assert sql.count("pg_catalog.aclexplode(procedure.proacl)") >= 2
    assert sql.count("pg_catalog.to_jsonb(procedure)") >= 2
    assert "v_ready_oid IS NULL" in sql
    assert "v_commit_attributes_valid" in sql
    assert "v_commit_acl_owner_service" in sql
    assert "v_commit_acl_owner_only" in sql
    assert "v_source_owner = v_commit_owner" in sql
    assert "v_source_owner = v_executor_owner" in sql
    assert "NOT v_is_legacy AND NOT v_is_v2" in sql
    assert "deck_quality_publication_atomic_migration_existing_rows_invalid" in sql
    assert "publication.source_pack_object_path IS NOT NULL" in sql
    assert "sophia_deck_quality_publication_source_path_valid(" in sql
    assert "NOTIFY pgrst, 'reload schema';" in sql
    assert sql.rstrip().endswith("COMMIT;")


def test_forward_atomic_publication_migration_installs_only_atomic_request_acl() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    source = _function_block(
        sql,
        "sophia_deck_quality_publication_source_path_valid",
        "sophia_request_deck_quality_publication",
    )
    request = _function_block(
        sql,
        "sophia_request_deck_quality_publication",
        "sophia_request_ready_deck_quality_publication",
    )
    ready = sql.split(
        "CREATE OR REPLACE FUNCTION public.sophia_request_ready_deck_quality_publication",
        maxsplit=1,
    )[1].split("REVOKE ALL ON FUNCTION", maxsplit=1)[0]

    assert "publication/source_pack/manifest.json" in source
    assert "p_object_hash || '.json'" not in source
    assert "v_publication.deadline_at IS DISTINCT" not in request
    assert "v_publication.quality_run_deadline_at IS DISTINCT" not in request
    assert "sophia_request_deck_quality_publication(" in ready
    assert "sophia_commit_deck_quality_publication_inputs(" in ready
    assert "COMMIT" not in ready

    for name in (
        "sophia_request_deck_quality_publication",
        "sophia_commit_deck_quality_publication_inputs",
        "sophia_request_ready_deck_quality_publication",
    ):
        revoke = f"REVOKE ALL ON FUNCTION public.{name}"
        assert revoke in sql
        assert "FROM PUBLIC, anon, authenticated, service_role;" in sql.split(
            revoke, maxsplit=1
        )[1].split(";", maxsplit=1)[0] + ";"

    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_request_deck_quality_publication"
        not in sql
    )
    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_commit_deck_quality_publication_inputs"
        not in sql
    )
    assert (
        "GRANT EXECUTE ON FUNCTION public.sophia_request_ready_deck_quality_publication"
        in sql
    )
    assert sql.count("TO service_role;") == 1
