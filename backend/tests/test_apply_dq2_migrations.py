from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import apply_dq2_migrations as runner

VALID_DATABASE_URL = "postgresql://postgres.vlxnwmyvhchwbousrdzc:secret@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require"


@pytest.mark.parametrize(
    ("database_url", "reason"),
    (
        (None, "database_url_missing"),
        (
            "postgres://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require",
            "database_scheme_invalid",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require",
            "database_pooler_host_invalid",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require",
            "database_pooler_port_invalid",
        ),
        (
            "postgresql://postgres.qtyqgvdkbhjfmnfkxyvm:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require",
            "database_project_ref_invalid",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require",
            "database_password_missing",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/other?sslmode=require",
            "database_name_invalid",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres",
            "database_sslmode_invalid",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=prefer",
            "database_sslmode_invalid",
        ),
        (
            "postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require&options=x",
            "database_sslmode_invalid",
        ),
    ),
)
def test_database_url_validation_is_fail_closed(database_url: str | None, reason: str) -> None:
    with pytest.raises(runner.RunnerError, match=f"^{reason}$"):
        runner._validate_database_url(database_url)


def test_database_url_validation_accepts_only_the_fixed_target() -> None:
    assert runner._validate_database_url(VALID_DATABASE_URL) == VALID_DATABASE_URL
    assert runner.EXPECTED_PROJECT_REF == "vlxnwmyvhchwbousrdzc"
    assert runner.EXPECTED_POOLER_HOST == "aws-1-us-west-1.pooler.supabase.com"
    assert runner.EXPECTED_POOLER_PORT == 5432
    assert runner.ADVISORY_LOCK_ID == 4913762560351058


def test_migration_name_and_hash_match_the_repository_file() -> None:
    migration_path = Path(__file__).resolve().parents[1] / "migrations" / runner.MIGRATION_FILENAME
    raw = migration_path.read_bytes()

    assert runner.MIGRATION_FILENAME == "2026_07_20_sophia_build_mutation_transactions.sql"
    assert hashlib.sha256(raw).hexdigest() == runner.MIGRATION_SHA256

    filename, sql = runner._load_migration()
    assert filename == runner.MIGRATION_FILENAME
    assert not sql.lstrip().upper().startswith("BEGIN;")
    assert not sql.rstrip().upper().endswith("COMMIT;")


def test_migration_hash_mismatch_and_unreadable_file_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / runner.MIGRATION_FILENAME
    path.write_text("BEGIN;\nSELECT 1;\nCOMMIT;\n", encoding="utf-8")
    with pytest.raises(runner.RunnerError, match="^migration_file_hash_invalid$"):
        runner._load_migration(tmp_path)

    path.unlink()
    with pytest.raises(runner.RunnerError, match="^migration_file_unreadable$"):
        runner._load_migration(tmp_path)


def test_runner_accepts_no_arguments() -> None:
    runner._validate_arguments(())
    for argv in (("--resume",), (runner.MIGRATION_FILENAME,), ("--resume-at", runner.MIGRATION_FILENAME)):
        with pytest.raises(runner.RunnerError, match="^migration_argument_invalid$"):
            runner._validate_arguments(argv)


def test_transaction_wrapper_must_be_single_and_top_level() -> None:
    assert runner._strip_transaction_wrapper("-- header\nBEGIN;\nSELECT 1;\nCOMMIT;\n") == "SELECT 1;\n"

    invalid = (
        "SELECT 0;\nBEGIN;\nSELECT 1;\nCOMMIT;\n",
        "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n",
        "BEGIN;\nBEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;\n",
        "SELECT 1;\n",
    )
    for sql in invalid:
        with pytest.raises(runner.RunnerError):
            runner._strip_transaction_wrapper(sql)


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.last_sql = ""

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[int] | None = None) -> None:
        self.last_sql = sql
        self.connection.executions.append((sql, params))
        if sql in self.connection.fail_sql:
            raise FakeDatabaseError

    def fetchone(self) -> tuple[bool, ...]:
        return self.connection.sanity_row


class FakeTransaction:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    def __enter__(self) -> FakeTransaction:
        self.connection.transactions_started += 1
        return self

    def __exit__(self, exc_type: object, *_args: object) -> None:
        if exc_type is None:
            self.connection.transactions_committed += 1
        else:
            self.connection.transactions_rolled_back += 1
        return None


class FakeConnection:
    def __init__(
        self,
        *,
        fail_sql: set[str] | None = None,
        sanity_row: tuple[bool, ...] | None = None,
    ) -> None:
        self.executions: list[tuple[str, tuple[int] | None]] = []
        self.fail_sql = fail_sql or set()
        self.sanity_row = sanity_row or (True,) * runner._DATABASE_SANITY_FIELD_COUNT
        self.transactions_started = 0
        self.transactions_committed = 0
        self.transactions_rolled_back = 0

    def __enter__(self) -> FakeConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)


class FakeDatabaseError(Exception):
    sqlstate = "55000"
    diag = SimpleNamespace(message_primary="build_mutation_postflight_failed")


@pytest.mark.parametrize(
    ("message", "reason"),
    (
        ("FATAL: password authentication failed for user", "authentication_failed"),
        ("FATAL: Tenant or user not found", "pooler_identity_rejected"),
        ("could not translate host name", "dns_failed"),
        ("connection timed out", "network_timeout"),
        ("connection refused", "pooler_unavailable"),
        ("too many connections", "database_capacity_exhausted"),
        ("SSL error", "tls_failed"),
        ("opaque driver failure", "unknown"),
    ),
)
def test_connection_failures_emit_only_static_reason_codes(message: str, reason: str) -> None:
    assert runner._safe_connection_reason(RuntimeError(message)) == reason


@pytest.mark.parametrize(
    ("message", "reason"),
    (
        ("build_mutation_legacy_row_invalid", "build_mutation_legacy_row_invalid"),
        ("build_mutation_operation_id_conflict", "build_mutation_operation_id_conflict"),
        ("build_mutation_unexpected_rls_policy", "build_mutation_unexpected_rls_policy"),
        ("build_mutation_postflight_failed", "build_mutation_postflight_failed"),
        ("provider detail that must not be logged", "unknown"),
    ),
)
def test_migration_failures_emit_only_static_reason_codes(message: str, reason: str) -> None:
    error = RuntimeError("secret-bearing fallback")
    error.diag = SimpleNamespace(message_primary=message)  # type: ignore[attr-defined]

    assert runner._safe_migration_failure_reason(error) == reason


def test_migration_runs_sanity_and_sql_in_one_locked_transaction(capsys: pytest.CaptureFixture[str]) -> None:
    connection = FakeConnection()

    assert runner._apply_migration(connection, runner.MIGRATION_FILENAME, "SELECT 'migration'")

    assert connection.transactions_started == 1
    assert connection.transactions_committed == 1
    assert connection.transactions_rolled_back == 0
    assert connection.executions == [
        ("SET LOCAL lock_timeout = '15s'", None),
        ("SET LOCAL statement_timeout = '300s'", None),
        ("SET LOCAL idle_in_transaction_session_timeout = '300s'", None),
        ("SELECT pg_catalog.pg_advisory_xact_lock(%s)", (runner.ADVISORY_LOCK_ID,)),
        (runner._DATABASE_SANITY_SQL, None),
        ("SELECT 'migration'", None),
    ]
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events == [
        {"event": "migration_started", "filename": runner.MIGRATION_FILENAME},
        {"event": "migration_succeeded", "filename": runner.MIGRATION_FILENAME},
    ]


def test_database_sanity_failure_rolls_back_before_sql() -> None:
    connection = FakeConnection(sanity_row=(True,) * (runner._DATABASE_SANITY_FIELD_COUNT - 1) + (False,))

    with pytest.raises(runner.RunnerError, match="^database_identity_or_predecessor_invalid$"):
        runner._apply_migration(connection, runner.MIGRATION_FILENAME, "SELECT 'migration'")

    assert connection.transactions_started == 1
    assert connection.transactions_committed == 0
    assert connection.transactions_rolled_back == 1
    assert all(sql != "SELECT 'migration'" for sql, _params in connection.executions)


def test_migration_failure_rolls_back_and_is_sanitized(capsys: pytest.CaptureFixture[str]) -> None:
    connection = FakeConnection(fail_sql={"SELECT 'migration'"})

    assert not runner._apply_migration(connection, runner.MIGRATION_FILENAME, "SELECT 'migration'")

    assert connection.transactions_started == 1
    assert connection.transactions_committed == 0
    assert connection.transactions_rolled_back == 1
    failure = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert failure == {
        "error_type": "FakeDatabaseError",
        "event": "migration_failed",
        "filename": runner.MIGRATION_FILENAME,
        "reason": "build_mutation_postflight_failed",
        "sqlstate": "55000",
    }


def test_main_uses_client_cursor_and_locked_single_migration(monkeypatch, capsys: pytest.CaptureFixture[str]) -> None:
    connection = FakeConnection()
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
    client_cursor = object()

    def connect(*args: object, **kwargs: object) -> FakeConnection:
        calls.append((args, kwargs))
        return connection

    monkeypatch.setenv("DATABASE_URL", VALID_DATABASE_URL)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect, ClientCursor=client_cursor))

    assert runner.main() == 0

    assert calls == [
        (
            (VALID_DATABASE_URL,),
            {
                "application_name": "sophia_dq2_migration_runner",
                "autocommit": True,
                "connect_timeout": 15,
                "cursor_factory": client_cursor,
            },
        )
    ]
    assert connection.transactions_started == 1
    assert connection.executions[-2][0] == runner._DATABASE_SANITY_SQL
    final_event = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert final_event == {
        "event": "migration_run_succeeded",
        "filename": runner.MIGRATION_FILENAME,
        "migration_sha256": runner.MIGRATION_SHA256,
    }


def test_main_never_imports_driver_for_invalid_configuration(monkeypatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delitem(sys.modules, "psycopg", raising=False)

    assert runner.main() == 2

    assert json.loads(capsys.readouterr().out) == {
        "event": "migration_preflight_failed",
        "reason": "database_url_missing",
    }


def test_main_rejects_arguments_before_importing_driver(monkeypatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("DATABASE_URL", VALID_DATABASE_URL)
    monkeypatch.delitem(sys.modules, "psycopg", raising=False)

    assert runner.main(("--resume",)) == 2

    assert json.loads(capsys.readouterr().out) == {
        "event": "migration_preflight_failed",
        "reason": "migration_argument_invalid",
    }
