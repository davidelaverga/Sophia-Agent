from __future__ import annotations

import json
import sys
from types import SimpleNamespace

import pytest

from scripts import apply_dq1_migrations as runner

VALID_DATABASE_URL = "postgresql://postgres.vlxnwmyvhchwbousrdzc:secret@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require"


@pytest.mark.parametrize(
    ("database_url", "reason"),
    (
        (None, "database_url_missing"),
        ("postgres://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require", "database_scheme_invalid"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require", "database_pooler_host_invalid"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require", "database_pooler_port_invalid"),
        ("postgresql://postgres.qtyqgvdkbhjfmnfkxyvm:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require", "database_project_ref_invalid"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require", "database_password_missing"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/other?sslmode=require", "database_name_invalid"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres", "database_sslmode_invalid"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=prefer", "database_sslmode_invalid"),
        ("postgresql://postgres.vlxnwmyvhchwbousrdzc:x@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require&options=x", "database_sslmode_invalid"),
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


def test_migration_allowlist_and_hashes_match_repository_files() -> None:
    assert tuple(runner.MIGRATION_SHA256) == (
        "2026_07_15_sophia_deck_quality_shadow_runs.sql",
        "2026_07_16_sophia_deck_quality_publications.sql",
        "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql",
        "2026_07_18_sophia_deck_quality_producer_failure_signals.sql",
        "2026_07_19_sophia_deck_quality_dispatch_intent_fence.sql",
    )

    loaded = runner._load_migrations()

    assert [filename for filename, _sql in loaded] == list(runner.MIGRATION_SHA256)
    assert all(not sql.lstrip().upper().startswith("BEGIN;") for _filename, sql in loaded)
    assert all(not sql.rstrip().upper().endswith("COMMIT;") for _filename, sql in loaded)


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

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[int] | None = None) -> None:
        self.connection.executions.append((sql, params))
        if sql in self.connection.fail_sql:
            raise FakeDatabaseError

    @staticmethod
    def fetchone() -> tuple[bool, ...]:
        return (True,) * 14


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
    def __init__(self, *, fail_sql: set[str] | None = None) -> None:
        self.executions: list[tuple[str, tuple[int] | None]] = []
        self.fail_sql = fail_sql or set()
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


def test_each_migration_gets_its_own_locked_transaction(capsys: pytest.CaptureFixture[str]) -> None:
    migrations = (("one.sql", "SELECT 1"), ("two.sql", "SELECT 2"))
    connection = FakeConnection()

    assert runner._apply_migrations(connection, migrations)

    assert connection.transactions_started == 2
    assert connection.transactions_committed == 2
    assert connection.transactions_rolled_back == 0
    assert connection.executions.count(("SELECT pg_catalog.pg_advisory_xact_lock(%s)", (runner.ADVISORY_LOCK_ID,))) == 2
    assert [item for item in connection.executions if item[0] in {"SELECT 1", "SELECT 2"}] == [
        ("SELECT 1", None),
        ("SELECT 2", None),
    ]
    events = [json.loads(line)["event"] for line in capsys.readouterr().out.splitlines()]
    assert events == ["migration_started", "migration_succeeded"] * 2


def test_first_failure_rolls_back_and_stops(capsys: pytest.CaptureFixture[str]) -> None:
    migrations = (("one.sql", "SELECT 1"), ("two.sql", "SELECT 2"), ("three.sql", "SELECT 3"))
    connection = FakeConnection(fail_sql={"SELECT 2"})

    assert not runner._apply_migrations(connection, migrations)

    assert connection.transactions_started == 2
    assert connection.transactions_committed == 1
    assert connection.transactions_rolled_back == 1
    assert all(sql != "SELECT 3" for sql, _params in connection.executions)
    failure = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert failure == {
        "error_type": "FakeDatabaseError",
        "event": "migration_failed",
        "filename": "two.sql",
        "sqlstate": "55000",
    }


def test_main_validates_sanity_then_uses_client_cursor(monkeypatch, capsys: pytest.CaptureFixture[str]) -> None:
    connection = FakeConnection()
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
    client_cursor = object()

    def connect(*args: object, **kwargs: object) -> FakeConnection:
        calls.append((args, kwargs))
        return connection

    monkeypatch.setenv("DATABASE_URL", VALID_DATABASE_URL)
    monkeypatch.setitem(sys.modules, "psycopg", SimpleNamespace(connect=connect, ClientCursor=client_cursor))

    assert runner.main() == 0

    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args == (VALID_DATABASE_URL,)
    assert kwargs == {
        "application_name": "sophia_dq1_migration_runner",
        "autocommit": True,
        "connect_timeout": 15,
        "cursor_factory": client_cursor,
    }
    assert connection.executions[0] == (runner._DATABASE_SANITY_SQL, None)
    assert connection.transactions_started == 5
    assert json.loads(capsys.readouterr().out.splitlines()[-1]) == {
        "event": "migration_run_succeeded",
        "migration_count": 5,
    }


def test_main_never_imports_driver_for_invalid_configuration(monkeypatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delitem(sys.modules, "psycopg", raising=False)

    assert runner.main() == 2

    assert json.loads(capsys.readouterr().out) == {
        "event": "migration_preflight_failed",
        "reason": "database_url_missing",
    }
