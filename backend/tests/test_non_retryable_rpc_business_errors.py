from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import httpx
import psycopg
import pytest

from deerflow.sophia.deck_quality.persistence import (
    DeckQualityPersistenceConfig,
    DeckQualityPersistenceRpcError,
    SupabaseDeckQualityRunRpcClient,
)
from deerflow.sophia.memory_governance.store import (
    MemoryGovernanceConflict,
    MemoryGovernanceUnavailable,
    SupabaseMemoryGovernanceStore,
)
from deerflow.sophia.rpc_business_errors import (
    _FORMER_40001_MESSAGES,
    store_error_status,
)

MIGRATIONS = Path(__file__).parents[1] / "migrations"
MIGRATION = MIGRATIONS / "2026_09_24_non_retryable_rpc_business_errors.sql"
EXPLICIT_40001 = re.compile(r"ERRCODE\s*=\s*'40001'", re.IGNORECASE)
FUNCTION = re.compile(r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z0-9_]+)", re.IGNORECASE)


def _reviewed_business_errors() -> tuple[set[str], set[str]]:
    names: set[str] = set()
    messages: set[str] = set()
    for migration in MIGRATIONS.glob("*.sql"):
        if migration == MIGRATION:
            continue
        sql = migration.read_text()
        functions = list(FUNCTION.finditer(sql))
        for match in EXPLICIT_40001.finditer(sql):
            owner = next((f for f in reversed(functions) if f.start() < match.start()), None)
            assert owner is not None, f"unowned 40001 in {migration.name}"
            names.add(owner.group(1))
            before = sql[max(0, match.start() - 180) : match.start()]
            after = sql[match.end() : match.end() + 140]
            message = re.search(r"MESSAGE\s*=\s*'([^']+)'", after, re.IGNORECASE)
            if message is None:
                message = re.search(r"RAISE\s+EXCEPTION\s+'([^']+)'\s+USING\s*$", before, re.IGNORECASE)
            assert message is not None, f"unmapped 40001 message in {migration.name}"
            messages.add(message.group(1))
    return names, messages


def test_migration_covers_every_explicit_business_error_and_preserves_messages() -> None:
    sql = MIGRATION.read_text()
    allowlist = sql.split("target_names text[] := ARRAY[", 1)[1].split("];", 1)[0]
    names = set(re.findall(r"'([a-z][a-z0-9_]+)'", allowlist))
    reviewed_names, reviewed_messages = _reviewed_business_errors()
    assert names == reviewed_names
    assert _FORMER_40001_MESSAGES == reviewed_messages
    assert "pg_catalog.pg_get_functiondef(p.oid) ~* target_pattern" in sql
    assert "RAISE EXCEPTION 'explicit 40001 remains in a public PL/pgSQL function'" in sql
    assert "ERRCODE = ''P0001''" in sql


def test_only_exact_reviewed_p0001_messages_keep_previous_store_status() -> None:
    legacy = httpx.Response(400, json={"code": "P0001", "message": "memory_extraction_dispatch_ineligible"})
    assert store_error_status(legacy) == 500
    assert store_error_status(httpx.Response(400, json={"code": "P0001", "message": "unrelated"})) == 400
    assert store_error_status(httpx.Response(400, json={"code": "22023", "message": "memory_extraction_dispatch_ineligible"})) == 400
    assert store_error_status(httpx.Response(400, text="not JSON")) == 400


def test_memory_store_keeps_legacy_fail_closed_error_class() -> None:
    def respond(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "P0001", "message": "memory_extraction_dispatch_ineligible"})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="test", client=client)
        with pytest.raises(MemoryGovernanceUnavailable, match="governance_http_5xx"):
            store._rpc("sophia_memory_authorize_extraction_dispatch", {})

    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(400, json={"code": "P0001", "message": "unrelated"}))) as client:
        store = SupabaseMemoryGovernanceStore(url="https://example.invalid", service_role_key="test", client=client)
        with pytest.raises(MemoryGovernanceConflict, match="governance_http_4xx"):
            store._rpc("unrelated", {})


def test_deck_quality_store_keeps_legacy_rpc_status() -> None:
    async def exercise() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _: httpx.Response(400, json={"code": "P0001", "message": "deck_quality_lease_stale"})
        )) as client:
            store = SupabaseDeckQualityRunRpcClient(
                DeckQualityPersistenceConfig(url="https://example.invalid", service_role_key="test"), client=client
            )
            with pytest.raises(DeckQualityPersistenceRpcError) as error:
                await store.call("sophia_renew_deck_quality_shadow_lease", {})
            assert error.value.status_code == 500

    asyncio.run(exercise())


def test_migration_removes_explicit_40001_from_installed_functions() -> None:
    """Optional disposable-Postgres contract; never targets an ordinary DB."""

    dsn = os.getenv("TEST_POSTGRES_DSN")
    if not dsn:
        pytest.skip("TEST_POSTGRES_DSN is not configured")
    with psycopg.connect(dsn) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database()")
            database = cursor.fetchone()[0]
            if not (database.endswith("_test") or database.startswith("test_")):
                pytest.skip("requires a disposable test database")
            cursor.execute("""
                CREATE OR REPLACE FUNCTION public.sophia_memory_authorize_extraction_dispatch(
                    text, uuid, uuid, uuid, text, text
                ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
                BEGIN
                    RAISE EXCEPTION 'memory_extraction_dispatch_ineligible' USING ERRCODE='40001';
                END $fn$
            """)
            cursor.execute("""
                CREATE OR REPLACE FUNCTION public.unreviewed_business_error_test()
                RETURNS void LANGUAGE plpgsql AS $fn$
                BEGIN
                    RAISE EXCEPTION 'unreviewed' USING ERRCODE='40001';
                END $fn$
            """)
            sql = MIGRATION.read_text()
            sql = re.sub(r"(?m)^BEGIN;\s*", "", sql, count=1)
            sql = re.sub(r"(?m)^COMMIT;\s*$", "", sql, count=1)
            cursor.execute("SAVEPOINT check_unreviewed_function")
            with pytest.raises(psycopg.Error, match="unreviewed explicit 40001 function"):
                cursor.execute(sql)
            cursor.execute("ROLLBACK TO SAVEPOINT check_unreviewed_function")
            cursor.execute("DROP FUNCTION public.unreviewed_business_error_test()")
            cursor.execute(sql)
            cursor.execute("""
                SELECT pg_get_functiondef(oid), prosecdef
                  FROM pg_proc
                 WHERE oid = 'public.sophia_memory_authorize_extraction_dispatch(text,uuid,uuid,uuid,text,text)'::regprocedure
            """)
            definition, security_definer = cursor.fetchone()
            assert not EXPLICIT_40001.search(definition)
            assert "ERRCODE = 'P0001'" in definition
            assert security_definer
            cursor.execute("SAVEPOINT check_business_error")
            with pytest.raises(psycopg.Error) as error:
                cursor.execute("""
                    SELECT public.sophia_memory_authorize_extraction_dispatch(
                        'test', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'test', 'test'
                    )
                """)
            assert error.value.sqlstate == "P0001"
            assert error.value.diag.message_primary == "memory_extraction_dispatch_ineligible"
            cursor.execute("ROLLBACK TO SAVEPOINT check_business_error")
        connection.rollback()
