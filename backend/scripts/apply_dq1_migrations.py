"""Apply the fixed DQ-1 production migration chain to its one allowed project."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

EXPECTED_PROJECT_REF = "vlxnwmyvhchwbousrdzc"
EXPECTED_POOLER_HOST = "aws-1-us-west-1.pooler.supabase.com"
EXPECTED_POOLER_PORT = 5432
ADVISORY_LOCK_ID = 4913762560351058
MIGRATION_SHA256 = {
    "2026_07_15_sophia_deck_quality_shadow_runs.sql": ("328f10ae75f2f1b0f39523621621abe3802ddf98d660a1c70b69c3b5b64c0dfb"),
    "2026_07_16_sophia_deck_quality_publications.sql": ("52fc6d563bd85bb35ae2c92ffcd9b0a261e896ceeef3dcc8b751cf46557c1635"),
    "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql": ("d2439af5768f5fb14f174a0e77ea4cc39ba3ed44c6c932f9de08d109debb5162"),
    "2026_07_18_sophia_deck_quality_producer_failure_signals.sql": ("4594e48cbbc12454b1b1d50ce66d0c73aa2b5b1093f3c9e18020802c3e13c556"),
    "2026_07_19_sophia_deck_quality_dispatch_intent_fence.sql": ("955a975c578d755cb655afdfd2437d8bf0eb4246fc48e34fc8bc905a5286f4b5"),
}

_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
_BEGIN_LINE = re.compile(r"[ \t]*BEGIN[ \t]*;[ \t]*(?:--[^\r\n]*)?", re.IGNORECASE)
_COMMIT_LINE = re.compile(r"[ \t]*COMMIT[ \t]*;[ \t]*(?:--[^\r\n]*)?", re.IGNORECASE)
_COMMENTS_ONLY = re.compile(r"(?:\s|--[^\r\n]*(?:\r?\n|$)|/\*.*?\*/)*", re.DOTALL)
_SQLSTATE = re.compile(r"[0-9A-Z]{5}")

_SAFE_MIGRATION_FAILURE_REASONS = {
    "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql": frozenset(
        {
            "deck_quality_publication_atomic_migration_environment_invalid",
            "deck_quality_publication_atomic_migration_unknown_fingerprint",
            "deck_quality_publication_atomic_migration_legacy_rows_present",
            "deck_quality_publication_atomic_migration_existing_rows_invalid",
            "deck_quality_publication_atomic_migration_postflight_failed",
        }
    ),
}

_DATABASE_SANITY_SQL = """
SELECT
    current_database() = 'postgres',
    current_user = 'postgres',
    session_user = 'postgres',
    current_schema() = 'public',
    current_setting('ssl', true) = 'on',
    pg_catalog.to_regnamespace('public') IS NOT NULL,
    pg_catalog.to_regrole('anon') IS NOT NULL,
    pg_catalog.to_regrole('authenticated') IS NOT NULL,
    pg_catalog.to_regrole('service_role') IS NOT NULL,
    pg_catalog.to_regclass('public.sophia_build_registry') IS NOT NULL,
    pg_catalog.to_regclass('public.sophia_build_operation_events') IS NOT NULL,
    pg_catalog.to_regprocedure(
        'public.sophia_commit_build_manifest(text,text,text,bigint,text,text,text,text,text,text,text,jsonb)'
    ) IS NOT NULL,
    pg_catalog.to_regprocedure(
        'public.sophia_append_build_event(text,text,text,text,timestamptz,jsonb)'
    ) IS NOT NULL,
    pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
"""


class RunnerError(RuntimeError):
    """A failure safe to identify by its static reason code."""


def _log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True, separators=(",", ":")), flush=True)


def _validate_database_url(database_url: str | None) -> str:
    if not database_url:
        raise RunnerError("database_url_missing")
    try:
        parsed = urlsplit(database_url)
        port = parsed.port
        username = unquote(parsed.username or "")
        password = unquote(parsed.password or "")
        query = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    except (UnicodeError, ValueError) as exc:
        raise RunnerError("database_url_invalid") from exc

    if parsed.scheme != "postgresql":
        raise RunnerError("database_scheme_invalid")
    if parsed.hostname != EXPECTED_POOLER_HOST:
        raise RunnerError("database_pooler_host_invalid")
    if port != EXPECTED_POOLER_PORT:
        raise RunnerError("database_pooler_port_invalid")
    if username != f"postgres.{EXPECTED_PROJECT_REF}":
        raise RunnerError("database_project_ref_invalid")
    if not password:
        raise RunnerError("database_password_missing")
    if unquote(parsed.path) != "/postgres" or parsed.fragment:
        raise RunnerError("database_name_invalid")
    if query != [("sslmode", "require")]:
        raise RunnerError("database_sslmode_invalid")
    return database_url


def _strip_transaction_wrapper(sql: str) -> str:
    lines = sql.splitlines(keepends=True)
    begin = [index for index, line in enumerate(lines) if _BEGIN_LINE.fullmatch(line.rstrip("\r\n"))]
    commit = [index for index, line in enumerate(lines) if _COMMIT_LINE.fullmatch(line.rstrip("\r\n"))]
    if len(begin) != 1 or len(commit) != 1 or begin[0] >= commit[0]:
        raise RunnerError("migration_transaction_wrapper_invalid")

    before = "".join(lines[: begin[0]])
    after = "".join(lines[commit[0] + 1 :])
    if _COMMENTS_ONLY.fullmatch(before) is None or _COMMENTS_ONLY.fullmatch(after) is None:
        raise RunnerError("migration_transaction_wrapper_not_top_level")

    body = "".join(lines[begin[0] + 1 : commit[0]])
    if not body.strip():
        raise RunnerError("migration_body_empty")
    return body


def _load_migrations(migrations_dir: Path = _MIGRATIONS_DIR) -> tuple[tuple[str, str], ...]:
    loaded: list[tuple[str, str]] = []
    for filename, expected_hash in MIGRATION_SHA256.items():
        path = migrations_dir / filename
        try:
            raw = path.read_bytes()
            sql = raw.decode("utf-8")
        except (OSError, UnicodeError) as exc:
            raise RunnerError("migration_file_unreadable") from exc
        if hashlib.sha256(raw).hexdigest() != expected_hash:
            raise RunnerError("migration_file_hash_invalid")
        loaded.append((filename, _strip_transaction_wrapper(sql)))
    return tuple(loaded)


def _safe_sqlstate(exc: BaseException) -> str:
    value = getattr(exc, "sqlstate", None)
    return value if isinstance(value, str) and _SQLSTATE.fullmatch(value) else "unknown"


def _safe_migration_failure_reason(filename: str, exc: BaseException) -> str:
    """Return only an explicitly allowlisted static migration failure code."""

    diagnostic = getattr(exc, "diag", None)
    message = getattr(diagnostic, "message_primary", None)
    allowed = _SAFE_MIGRATION_FAILURE_REASONS.get(filename, frozenset())
    return message if isinstance(message, str) and message in allowed else "unknown"


def _safe_connection_reason(exc: BaseException) -> str:
    """Reduce driver/network detail to a static, non-secret operator code."""

    message = str(exc).casefold()
    classifiers = (
        (("password authentication failed", "authentication failed"), "authentication_failed"),
        (("tenant or user not found", "project or user not found"), "pooler_identity_rejected"),
        (("no pg_hba.conf entry",), "connection_policy_rejected"),
        (
            (
                "could not translate host name",
                "name or service not known",
                "temporary failure in name resolution",
            ),
            "dns_failed",
        ),
        (("connection timed out", "timeout expired", "operation timed out"), "network_timeout"),
        (
            ("connection refused", "server closed the connection unexpectedly"),
            "pooler_unavailable",
        ),
        (
            ("remaining connection slots are reserved", "too many connections"),
            "database_capacity_exhausted",
        ),
        (("certificate verify failed", "ssl error", "tls"), "tls_failed"),
    )
    for markers, reason in classifiers:
        if any(marker in message for marker in markers):
            return reason
    return "unknown"


def _database_sanity_check(connection: Any) -> None:
    with connection.cursor() as cursor:
        cursor.execute(_DATABASE_SANITY_SQL)
        row = cursor.fetchone()
    if not row or len(row) != 14 or not all(value is True for value in row):
        raise RunnerError("database_identity_or_schema_invalid")


def _apply_migrations(connection: Any, migrations: tuple[tuple[str, str], ...]) -> bool:
    for filename, sql in migrations:
        _log("migration_started", filename=filename)
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("SET LOCAL lock_timeout = '15s'")
                    cursor.execute("SET LOCAL statement_timeout = '300s'")
                    cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '300s'")
                    cursor.execute(
                        "SELECT pg_catalog.pg_advisory_xact_lock(%s)",
                        (ADVISORY_LOCK_ID,),
                    )
                    cursor.execute(sql)
        except Exception as exc:
            _log(
                "migration_failed",
                error_type=type(exc).__name__,
                filename=filename,
                reason=_safe_migration_failure_reason(filename, exc),
                sqlstate=_safe_sqlstate(exc),
            )
            return False
        _log("migration_succeeded", filename=filename)
    return True


def main() -> int:
    try:
        database_url = _validate_database_url(os.environ.get("DATABASE_URL"))
        migrations = _load_migrations()
    except RunnerError as exc:
        _log("migration_preflight_failed", reason=exc.args[0])
        return 2

    try:
        import psycopg
    except ImportError:
        _log("migration_preflight_failed", reason="psycopg_unavailable")
        return 2

    try:
        with psycopg.connect(
            database_url,
            application_name="sophia_dq1_migration_runner",
            autocommit=True,
            connect_timeout=15,
            cursor_factory=psycopg.ClientCursor,
        ) as connection:
            _database_sanity_check(connection)
            if not _apply_migrations(connection, migrations):
                return 1
    except RunnerError as exc:
        _log("database_sanity_failed", reason=exc.args[0])
        return 2
    except Exception as exc:
        _log(
            "database_connection_failed",
            error_type=type(exc).__name__,
            reason=_safe_connection_reason(exc),
            sqlstate=_safe_sqlstate(exc),
        )
        return 1

    _log("migration_run_succeeded", migration_count=len(migrations))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
