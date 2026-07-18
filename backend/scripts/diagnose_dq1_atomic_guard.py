"""Classify the DQ-1 atomic-convergence guard without exposing catalog data."""

from __future__ import annotations

import json
import os
from typing import Any

try:
    from scripts.apply_dq1_migrations import (
        RunnerError,
        _safe_connection_reason,
        _safe_sqlstate,
        _validate_database_url,
    )
except ModuleNotFoundError:
    from apply_dq1_migrations import (  # type: ignore[no-redef]
        RunnerError,
        _safe_connection_reason,
        _safe_sqlstate,
        _validate_database_url,
    )

_BASIC_PROBE_SQL = """
SELECT
    current_user = 'postgres'
        AND pg_catalog.to_regrole('anon') IS NOT NULL
        AND pg_catalog.to_regrole('authenticated') IS NOT NULL
        AND pg_catalog.to_regrole('service_role') IS NOT NULL,
    current_setting('server_version_num')::INTEGER BETWEEN 160000 AND 169999,
    pg_catalog.to_regclass('public.sophia_deck_quality_publications') IS NOT NULL,
    pg_catalog.to_regprocedure(
        'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
    ) IS NOT NULL,
    pg_catalog.to_regprocedure(
        'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
    ) IS NOT NULL,
    pg_catalog.to_regprocedure(
        'public.sophia_commit_deck_quality_publication_inputs(text,text,text)'
    ) IS NOT NULL,
    pg_catalog.to_regprocedure(
        'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
    ) IS NOT NULL,
    (
        SELECT count(*)
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.pronamespace = 'public'::REGNAMESPACE
           AND procedure.proname = ANY (ARRAY[
               'sophia_deck_quality_publication_source_path_valid',
               'sophia_request_deck_quality_publication',
               'sophia_commit_deck_quality_publication_inputs',
               'sophia_request_ready_deck_quality_publication'
           ]::TEXT[])
    )
"""

_LEGACY_DETAIL_PROBE_SQL = """
SELECT
    EXISTS (SELECT 1 FROM public.sophia_deck_quality_publications LIMIT 1),
    (
        SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   procedure.prosrc, 'UTF8'
               )), 'hex') =
               'ed3ab9d582ceccf766e3523082108c38aded2cf19c41c399c93eb7ee478acef6'
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = pg_catalog.to_regprocedure(
             'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
         )
    ),
    (
        SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   procedure.prosrc, 'UTF8'
               )), 'hex') =
               'b2a7ac118a4ef5830be233bfd55270b5887d2094dea2890ead1b786d9572484c'
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = pg_catalog.to_regprocedure(
             'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
         )
    ),
    (
        SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   procedure.prosrc, 'UTF8'
               )), 'hex') =
               'a207aa72bf2b23ba9c76a4466f1dfb54cc714fc50c71c994f9ca962b01c697ee'
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = pg_catalog.to_regprocedure(
             'public.sophia_commit_deck_quality_publication_inputs(text,text,text)'
         )
    )
"""


def _log(event: str, **fields: object) -> None:
    print(
        json.dumps({"event": event, **fields}, sort_keys=True, separators=(",", ":")),
        flush=True,
    )


def _classify_basic(row: tuple[Any, ...]) -> str | None:
    if len(row) != 8:
        return "probe_shape_invalid"
    environment_valid, pg16, table, source, request, commit, ready, routine_count = row
    if environment_valid is not True:
        return "environment_invalid"
    if table is not True:
        return "publication_table_missing"
    if source is not True or request is not True or commit is not True:
        return "required_split_routine_missing"
    if routine_count not in (3, 4):
        return "unexpected_target_routine_count"
    if routine_count == 3 and ready is True:
        return "unexpected_target_routine_count"
    if routine_count == 4 and ready is not True:
        return "unexpected_target_routine_count"
    if pg16 is not True:
        return "postgres_major_not_16"
    return None


def _classify_legacy_detail(row: tuple[Any, ...]) -> str:
    if len(row) != 4:
        return "probe_shape_invalid"
    rows_present, source_hash, request_hash, commit_hash = row
    if rows_present is True:
        return "legacy_rows_present"
    if not all(value is True for value in (source_hash, request_hash, commit_hash)):
        return "legacy_prosrc_mismatch"
    return "deep_table_or_routine_catalog_mismatch"


def main() -> int:
    try:
        database_url = _validate_database_url(os.environ.get("DATABASE_URL"))
    except RunnerError as exc:
        _log("atomic_guard_diagnostic_failed", reason=exc.args[0])
        return 2

    try:
        import psycopg
    except ImportError:
        _log("atomic_guard_diagnostic_failed", reason="psycopg_unavailable")
        return 2

    try:
        with psycopg.connect(
            database_url,
            application_name="sophia_dq1_atomic_guard_diagnostic",
            autocommit=True,
            connect_timeout=15,
            cursor_factory=psycopg.ClientCursor,
        ) as connection:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION READ ONLY")
                    cursor.execute("SET LOCAL statement_timeout = '30s'")
                    cursor.execute(_BASIC_PROBE_SQL)
                    basic = cursor.fetchone()
                    reason = _classify_basic(basic or ())
                    if reason is None:
                        if basic is not None and basic[7] == 3:
                            cursor.execute(_LEGACY_DETAIL_PROBE_SQL)
                            reason = _classify_legacy_detail(cursor.fetchone() or ())
                        else:
                            reason = "v2_catalog_mismatch"
    except Exception as exc:
        _log(
            "atomic_guard_diagnostic_failed",
            error_type=type(exc).__name__,
            reason=_safe_connection_reason(exc),
            sqlstate=_safe_sqlstate(exc),
        )
        return 1

    _log("atomic_guard_diagnostic_succeeded", reason=reason)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
