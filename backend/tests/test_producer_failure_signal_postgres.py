from __future__ import annotations

import hashlib
import os
import subprocess
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_MIGRATIONS = (
    _BACKEND / "migrations" / "2026_07_15_sophia_deck_quality_shadow_runs.sql",
    _BACKEND / "migrations" / "2026_07_16_sophia_deck_quality_publications.sql",
    _BACKEND
    / "migrations"
    / "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql",
    _BACKEND
    / "migrations"
    / "2026_07_18_sophia_deck_quality_producer_failure_signals.sql",
)
_BASE_MIGRATIONS = _MIGRATIONS[:-1]
_SIGNAL_MIGRATION = _MIGRATIONS[-1]
_POSTGRES_CONTAINER = os.getenv("DQ1_POSTGRES_CONTAINER")

pytestmark = pytest.mark.skipif(
    not _POSTGRES_CONTAINER,
    reason="set DQ1_POSTGRES_CONTAINER to a disposable PostgreSQL 16 container",
)


def _psql(
    database: str,
    sql: str,
    *,
    check: bool = True,
    script: bool = False,
) -> subprocess.CompletedProcess[str]:
    assert _POSTGRES_CONTAINER is not None
    command = [
        "docker",
        "exec",
        "-i",
        _POSTGRES_CONTAINER,
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        database,
        "-At",
        "-F",
        "|",
    ]
    if not script:
        command.extend(("-c", sql))
    completed = subprocess.run(  # noqa: S603
        command,
        input=sql if script else None,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if check and completed.returncode != 0:
        raise AssertionError(
            f"psql failed rc={completed.returncode}\n"
            f"stdout={completed.stdout}\nstderr={completed.stderr}"
        )
    return completed


@contextmanager
def _postgres_database(
    *, prefix: str, migrations: tuple[Path, ...]
) -> Iterator[str]:
    database = f"{prefix}_{uuid.uuid4().hex[:16]}"
    _psql(
        "postgres",
        """
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
""",
    )
    _psql("postgres", f'CREATE DATABASE "{database}"')
    try:
        for migration in migrations:
            _psql(database, migration.read_text(), script=True)
        yield database
    finally:
        _psql(
            "postgres",
            (
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                f"WHERE datname = '{database}' AND pid <> pg_backend_pid();"
            ),
            check=False,
        )
        _psql(
            "postgres",
            f'DROP DATABASE IF EXISTS "{database}"',
            check=False,
        )


@pytest.fixture
def postgres_db() -> Iterator[str]:
    with _postgres_database(
        prefix="dq1_signal", migrations=_MIGRATIONS
    ) as database:
        # The forward migration is safe to replay after response loss.
        _psql(database, _SIGNAL_MIGRATION.read_text(), script=True)
        yield database


@pytest.fixture
def postgres_base_db() -> Iterator[str]:
    with _postgres_database(
        prefix="dq1_signal_guard", migrations=_BASE_MIGRATIONS
    ) as database:
        yield database


def _signal_hash(
    *,
    candidate_digest: str,
    stage: str,
    upstream_code: str,
    quality_run_id: str | None,
) -> str:
    material = "\x1f".join(
        (
            "deck-quality-producer-failure-signal/v1",
            "DQ-1",
            candidate_digest,
            "canary-user",
            "shadow_dispatch_unavailable",
            stage,
            upstream_code,
            quality_run_id or "",
        )
    )
    return hashlib.sha256(material.encode()).hexdigest()


def _record_call(
    *,
    candidate_digest: str,
    stage: str,
    upstream_code: str,
    quality_run_id: str | None,
    signal_hash: str,
) -> str:
    run_sql = "NULL" if quality_run_id is None else f"'{quality_run_id}'"
    return f"""
SELECT outcome, candidate_digest, signal_hash, persisted_count,
       unresolved_count, conflict_count,
       COALESCE(oldest_unresolved_at::TEXT, '')
  FROM public.sophia_record_deck_quality_producer_failure_signal(
    'deck-quality-producer-failure-signal/v1',
    'DQ-1',
    '{candidate_digest}',
    'canary-user',
    'shadow_dispatch_unavailable',
    '{stage}',
    '{upstream_code}',
    {run_sql},
    '{signal_hash}'
  )
"""


def test_real_postgres_signal_replay_conflict_resolution_and_acls(
    postgres_db: str,
) -> None:
    candidate = "a" * 64
    quality_run_id = "quality_" + "b" * 64
    original_hash = _signal_hash(
        candidate_digest=candidate,
        stage="producer_bundle",
        upstream_code="producer_bundle_unavailable",
        quality_run_id=quality_run_id,
    )
    record = _record_call(
        candidate_digest=candidate,
        stage="producer_bundle",
        upstream_code="producer_bundle_unavailable",
        quality_run_id=quality_run_id,
        signal_hash=original_hash,
    )
    first = _psql(
        postgres_db,
        f"SET ROLE service_role; {record}; RESET ROLE;",
    ).stdout.strip()
    replay = _psql(
        postgres_db,
        f"SET ROLE service_role; {record}; RESET ROLE;",
    ).stdout.strip()
    assert first.startswith(f"created|{candidate}|{original_hash}|1|1|0|")
    assert replay.startswith(f"replayed|{candidate}|{original_hash}|1|1|0|")

    conflicting_hash = _signal_hash(
        candidate_digest=candidate,
        stage="instrument",
        upstream_code="instrument_invalid",
        quality_run_id=None,
    )
    conflict = _record_call(
        candidate_digest=candidate,
        stage="instrument",
        upstream_code="instrument_invalid",
        quality_run_id=None,
        signal_hash=conflicting_hash,
    )
    conflicted = _psql(
        postgres_db,
        f"SET ROLE service_role; {conflict}; RESET ROLE;",
    ).stdout.strip()
    assert conflicted.startswith(
        f"conflict|{candidate}|{original_hash}|1|1|1|"
    )

    resolution_code = "operator_acknowledged"
    resolution_hash = hashlib.sha256(
        "\x1f".join(
            (candidate, original_hash, resolution_code)
        ).encode()
    ).hexdigest()
    resolved = _psql(
        postgres_db,
        f"""
SET ROLE service_role;
SELECT persisted_count, unresolved_count, conflict_count,
       COALESCE(oldest_unresolved_at::TEXT, '')
  FROM public.sophia_resolve_deck_quality_producer_failure_signal(
    '{candidate}', '{original_hash}', '{resolution_code}', '{resolution_hash}'
  );
RESET ROLE;
""",
    ).stdout.strip()
    assert resolved == "1|0|1|"

    # A delayed identical producer retry cannot undo explicit resolution.
    late_replay = _psql(
        postgres_db,
        f"SET ROLE service_role; {record}; RESET ROLE;",
    ).stdout.strip()
    assert late_replay.startswith(
        f"replayed|{candidate}|{original_hash}|1|0|1|"
    )
    # A new semantic conflict is durably fenced and reopens readiness.
    reopened = _psql(
        postgres_db,
        f"SET ROLE service_role; {conflict}; RESET ROLE;",
    ).stdout.strip()
    assert reopened.startswith(
        f"conflict|{candidate}|{original_hash}|1|1|2|"
    )

    acl = _psql(
        postgres_db,
        """
SELECT
  has_function_privilege('anon',
    'public.sophia_record_deck_quality_producer_failure_signal(text,text,text,text,text,text,text,text,text)',
    'EXECUTE'),
  has_function_privilege('authenticated',
    'public.sophia_record_deck_quality_producer_failure_signal(text,text,text,text,text,text,text,text,text)',
    'EXECUTE'),
  has_function_privilege('service_role',
    'public.sophia_record_deck_quality_producer_failure_signal(text,text,text,text,text,text,text,text,text)',
    'EXECUTE'),
  has_table_privilege('service_role',
    'public.sophia_deck_quality_producer_failure_signals', 'SELECT');
""",
    ).stdout.strip()
    assert acl == "f|f|t|f"

    exact_surface = _psql(
        postgres_db,
        """
SELECT
  to_regprocedure(
    'public.sophia_record_deck_quality_producer_failure_signal(text,text,text,text,text,text,text,text,text)'
  ) IS NOT NULL
  AND to_regprocedure(
    'public.sophia_get_deck_quality_producer_failure_readiness()'
  ) IS NOT NULL
  AND to_regprocedure(
    'public.sophia_resolve_deck_quality_producer_failure_signal(text,text,text,text)'
  ) IS NOT NULL,
  (
    SELECT count(*) = 3
       AND bool_and(procedure.proowner = 'postgres'::REGROLE)
       AND bool_and(procedure.prosecdef)
       AND bool_and(
         procedure.proconfig = ARRAY['search_path=public']::TEXT[]
       )
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.pronamespace = 'public'::REGNAMESPACE
       AND procedure.proname LIKE 'sophia%producer_failure%'
  ),
  (
    SELECT count(*) = 6
       AND count(*) FILTER (
         WHERE acl.grantee = procedure.proowner
           AND acl.grantor = procedure.proowner
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable
       ) = 3
       AND count(*) FILTER (
         WHERE acl.grantee = 'service_role'::REGROLE
           AND acl.grantor = procedure.proowner
           AND acl.privilege_type = 'EXECUTE'
           AND NOT acl.is_grantable
       ) = 3
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
     WHERE procedure.pronamespace = 'public'::REGNAMESPACE
       AND procedure.proname LIKE 'sophia%producer_failure%'
  ),
  (
    SELECT relation.relowner = 'postgres'::REGROLE
       AND relation.relrowsecurity
       AND relation.relforcerowsecurity
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid =
       'public.sophia_deck_quality_producer_failure_signals'::REGCLASS
  );
""",
    ).stdout.strip()
    assert exact_surface == "t|t|t|t"


def test_real_postgres_invalid_hash_has_no_side_effect(postgres_db: str) -> None:
    candidate = "c" * 64
    invalid = _record_call(
        candidate_digest=candidate,
        stage="instrument",
        upstream_code="instrument_invalid",
        quality_run_id=None,
        signal_hash="d" * 64,
    )
    failed = _psql(
        postgres_db,
        f"SET ROLE service_role; {invalid}; RESET ROLE;",
        check=False,
    )
    assert failed.returncode != 0
    assert "deck_quality_producer_failure_signal_hash_invalid" in failed.stderr
    count = _psql(
        postgres_db,
        "SELECT count(*) FROM public.sophia_deck_quality_producer_failure_signals;",
    ).stdout.strip()
    assert count == "0"


def test_real_postgres_signal_migration_requires_no_pgcrypto(
    postgres_base_db: str,
) -> None:
    before = _psql(
        postgres_base_db,
        "SELECT count(*) FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'",
    ).stdout.strip()
    assert before == "0"

    _psql(postgres_base_db, _SIGNAL_MIGRATION.read_text(), script=True)
    after = _psql(
        postgres_base_db,
        "SELECT count(*) FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'",
    ).stdout.strip()
    assert after == "0"

    candidate = "e" * 64
    signal_hash = _signal_hash(
        candidate_digest=candidate,
        stage="instrument",
        upstream_code="instrument_invalid",
        quality_run_id=None,
    )
    recorded = _psql(
        postgres_base_db,
        "SET ROLE service_role; "
        + _record_call(
            candidate_digest=candidate,
            stage="instrument",
            upstream_code="instrument_invalid",
            quality_run_id=None,
            signal_hash=signal_hash,
        )
        + "; RESET ROLE;",
    ).stdout.strip()
    assert recorded.startswith(f"created|{candidate}|{signal_hash}|1|1|0|")


@pytest.mark.parametrize(
    ("needle", "replacement"),
    (
        pytest.param(
            "conflict_count INTEGER NOT NULL DEFAULT 0,",
            "conflict_count INTEGER NOT NULL DEFAULT 1,",
            id="column-default",
        ),
        pytest.param(
            "-- Recompute the complete table/type/catalog fingerprint plus the installed",
            """COMMENT ON FUNCTION
    public.sophia_get_deck_quality_producer_failure_readiness()
    IS 'drifted-first-apply';

-- Recompute the complete table/type/catalog fingerprint plus the installed""",
            id="function-comment",
        ),
    ),
)
def test_real_postgres_signal_postflight_rolls_back_drifted_first_apply(
    postgres_base_db: str,
    needle: str,
    replacement: str,
) -> None:
    migration = _SIGNAL_MIGRATION.read_text(encoding="utf-8")
    drifted = migration.replace(
        needle,
        replacement,
        1,
    )
    assert migration.count(needle) == 1
    assert drifted != migration
    absent_sql = """
SELECT
  to_regclass('public.sophia_deck_quality_producer_failure_signals') IS NULL,
  count(*)
FROM pg_catalog.pg_proc AS procedure
WHERE procedure.pronamespace = 'public'::REGNAMESPACE
  AND procedure.proname = ANY (ARRAY[
    'sophia_record_deck_quality_producer_failure_signal',
    'sophia_get_deck_quality_producer_failure_readiness',
    'sophia_resolve_deck_quality_producer_failure_signal'
  ]::TEXT[])
"""
    assert _psql(postgres_base_db, absent_sql).stdout.strip() == "t|0"

    failed = _psql(
        postgres_base_db,
        drifted,
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert (
        "deck_quality_producer_failure_signal_postflight_failed"
        in failed.stderr
    )
    assert _psql(postgres_base_db, absent_sql).stdout.strip() == "t|0"


def test_real_postgres_signal_migration_ignores_extensions_pgcrypto(
    postgres_base_db: str,
) -> None:
    _psql(
        postgres_base_db,
        "CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions;",
    )
    _psql(postgres_base_db, _SIGNAL_MIGRATION.read_text(), script=True)
    extension_schema = _psql(
        postgres_base_db,
        """
SELECT namespace.nspname
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = extension.extnamespace
 WHERE extension.extname = 'pgcrypto'
""",
    ).stdout.strip()
    assert extension_schema == "extensions"


def test_real_postgres_wrong_table_comment_is_rejected_untouched(
    postgres_base_db: str,
) -> None:
    _psql(postgres_base_db, _SIGNAL_MIGRATION.read_text(), script=True)
    _psql(
        postgres_base_db,
        """
COMMENT ON TABLE public.sophia_deck_quality_producer_failure_signals IS
  'foreign-object-with-matching-columns'
""",
    )

    failed = _psql(
        postgres_base_db,
        _SIGNAL_MIGRATION.read_text(),
        check=False,
        script=True,
    )
    assert failed.returncode != 0
    assert "deck_quality_producer_failure_signal_unknown_fingerprint" in failed.stderr
    comment = _psql(
        postgres_base_db,
        """
SELECT pg_catalog.obj_description(
  'public.sophia_deck_quality_producer_failure_signals'::REGCLASS,
  'pg_class'
)
""",
    ).stdout.strip()
    assert comment == "foreign-object-with-matching-columns"


def test_real_postgres_tampered_function_body_is_rejected_untouched(
    postgres_base_db: str,
) -> None:
    _psql(postgres_base_db, _SIGNAL_MIGRATION.read_text(), script=True)
    _psql(
        postgres_base_db,
        """
CREATE OR REPLACE FUNCTION
  public.sophia_get_deck_quality_producer_failure_readiness()
RETURNS TABLE (
  persisted_count BIGINT,
  unresolved_count BIGINT,
  conflict_count BIGINT,
  oldest_unresolved_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 0::BIGINT, 0::BIGINT, 0::BIGINT, NULL::TIMESTAMPTZ
$$
""",
    )
    hash_sql = """
SELECT pg_catalog.encode(
  pg_catalog.sha256(pg_catalog.convert_to(procedure.prosrc, 'UTF8')),
  'hex'
)
  FROM pg_catalog.pg_proc AS procedure
 WHERE procedure.oid = to_regprocedure(
   'public.sophia_get_deck_quality_producer_failure_readiness()'
 )
"""
    tampered_hash = _psql(postgres_base_db, hash_sql).stdout.strip()
    assert tampered_hash != (
        "153d835eb5a88673f2de06650781732d132a13f071bb743ad83a16a337b2717d"
    )

    failed = _psql(
        postgres_base_db,
        _SIGNAL_MIGRATION.read_text(),
        check=False,
        script=True,
    )
    assert failed.returncode != 0
    assert "deck_quality_producer_failure_signal_unknown_fingerprint" in failed.stderr
    assert _psql(postgres_base_db, hash_sql).stdout.strip() == tampered_hash


def test_real_postgres_tampered_function_acl_is_rejected_untouched(
    postgres_base_db: str,
) -> None:
    _psql(postgres_base_db, _SIGNAL_MIGRATION.read_text(), script=True)
    function_identity = (
        "public.sophia_resolve_deck_quality_producer_failure_signal"
        "(text,text,text,text)"
    )
    _psql(
        postgres_base_db,
        f"GRANT EXECUTE ON FUNCTION {function_identity} TO anon",
    )

    failed = _psql(
        postgres_base_db,
        _SIGNAL_MIGRATION.read_text(),
        check=False,
        script=True,
    )
    assert failed.returncode != 0
    assert "deck_quality_producer_failure_signal_unknown_fingerprint" in failed.stderr
    anon_still_has_execute = _psql(
        postgres_base_db,
        "SELECT has_function_privilege("
        f"'anon', '{function_identity}', 'EXECUTE')",
    ).stdout.strip()
    assert anon_still_has_execute == "t"
