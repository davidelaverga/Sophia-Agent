from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import uuid
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from deerflow.sophia.deck_quality.idempotency import (
    canonical_sha256,
    derive_quality_run_id,
)
from deerflow.sophia.deck_quality.persistence import (
    QualityRunRequest,
    safe_trace_root_input_hash,
)
from deerflow.sophia.deck_quality.schemas import QualityInstrumentLock

_BACKEND = Path(__file__).resolve().parents[1]
_QUALITY_MIGRATION = (
    _BACKEND / "migrations" / "2026_07_15_sophia_deck_quality_shadow_runs.sql"
)
_PUBLICATION_MIGRATION = (
    _BACKEND / "migrations" / "2026_07_16_sophia_deck_quality_publications.sql"
)
_PUBLICATION_ATOMIC_MIGRATION = (
    _BACKEND
    / "migrations"
    / "2026_07_17_sophia_deck_quality_publication_atomic_convergence.sql"
)
_PRODUCER_FAILURE_MIGRATION = (
    _BACKEND
    / "migrations"
    / "2026_07_18_sophia_deck_quality_producer_failure_signals.sql"
)
_DISPATCH_INTENT_MIGRATION = (
    _BACKEND
    / "migrations"
    / "2026_07_19_sophia_deck_quality_dispatch_intent_fence.sql"
)
_TRACE_GRACE_RECOVERY_MIGRATION = (
    _BACKEND
    / "migrations"
    / "2026_07_21_sophia_deck_quality_trace_grace_recovery.sql"
)
_MIGRATIONS = (
    _QUALITY_MIGRATION,
    _PUBLICATION_MIGRATION,
    _PUBLICATION_ATOMIC_MIGRATION,
    _PRODUCER_FAILURE_MIGRATION,
    _DISPATCH_INTENT_MIGRATION,
    _TRACE_GRACE_RECOVERY_MIGRATION,
)
_POSTGRES_CONTAINER = os.getenv("DQ1_POSTGRES_CONTAINER")

pytestmark = pytest.mark.skipif(
    not _POSTGRES_CONTAINER,
    reason="set DQ1_POSTGRES_CONTAINER to a disposable PostgreSQL 16 container",
)


def _psql_command(database: str) -> list[str]:
    assert _POSTGRES_CONTAINER is not None
    return [
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


def _psql(
    database: str,
    sql: str,
    *,
    check: bool = True,
    script: bool = False,
) -> subprocess.CompletedProcess[str]:
    command = _psql_command(database)
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


def _postgres_database(migrations: tuple[Path, ...]) -> Iterator[str]:
    database = f"dq1_it_{uuid.uuid4().hex[:16]}"
    role_sql = """
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
"""
    _psql("postgres", role_sql)
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
        _psql("postgres", f'DROP DATABASE IF EXISTS "{database}"', check=False)


@pytest.fixture
def postgres_db() -> Iterator[str]:
    yield from _postgres_database(_MIGRATIONS)


@pytest.fixture
def postgres_db_through_dispatch_intent() -> Iterator[str]:
    yield from _postgres_database(_MIGRATIONS[:-1])


def _function_ddl(sql: str, name: str, next_name: str) -> str:
    marker = f"CREATE OR REPLACE FUNCTION public.{name}"
    next_marker = f"CREATE OR REPLACE FUNCTION public.{next_name}"
    start = sql.index(marker)
    end = sql.index(next_marker, start)
    return sql[start:end]


def _single_function_ddl(sql: str, name: str) -> str:
    marker = f"CREATE OR REPLACE FUNCTION public.{name}"
    start = sql.index(marker)
    end = sql.index("\n$$;", start) + len("\n$$;")
    return sql[start:end]


def _dispatch_catalog_snapshot(database: str) -> str:
    """Hash every target catalog row to prove an in-place replay is inert."""
    return _psql(
        database,
        """
WITH target AS (
    SELECT 'public.sophia_deck_quality_shadow_runs'::regclass AS oid
)
SELECT encode(sha256(convert_to(jsonb_build_object(
    'relation', (
        SELECT to_jsonb(relation) || jsonb_build_object('oid', relation.oid)
          FROM pg_class AS relation
         WHERE relation.oid = (SELECT oid FROM target)
    ),
    'type', (
        SELECT to_jsonb(type) || jsonb_build_object('oid', type.oid)
          FROM pg_type AS type
         WHERE type.oid = (
             SELECT relation.reltype
               FROM pg_class AS relation
              WHERE relation.oid = (SELECT oid FROM target)
         )
    ),
    'attributes', (
        SELECT jsonb_agg(
                   to_jsonb(attribute)
                   || jsonb_build_object('oid', attribute.attrelid)
                   ORDER BY attribute.attnum
               )
          FROM pg_attribute AS attribute
         WHERE attribute.attrelid = (SELECT oid FROM target)
           AND attribute.attnum > 0
    ),
    'defaults', COALESCE((
        SELECT jsonb_agg(to_jsonb(default_value) ORDER BY default_value.adnum)
          FROM pg_attrdef AS default_value
         WHERE default_value.adrelid = (SELECT oid FROM target)
    ), '[]'::jsonb),
    'constraints', COALESCE((
        SELECT jsonb_agg(
                   to_jsonb(constraint_definition)
                   || jsonb_build_object('oid', constraint_definition.oid)
                   ORDER BY constraint_definition.conname
               )
          FROM pg_constraint AS constraint_definition
         WHERE constraint_definition.conrelid = (SELECT oid FROM target)
    ), '[]'::jsonb),
    'indexes', COALESCE((
        SELECT jsonb_agg(
                   jsonb_build_array(
                       to_jsonb(index_definition),
                       to_jsonb(index_relation),
                       index_relation.oid
                   ) ORDER BY index_relation.relname
               )
          FROM pg_index AS index_definition
          JOIN pg_class AS index_relation
            ON index_relation.oid = index_definition.indexrelid
         WHERE index_definition.indrelid = (SELECT oid FROM target)
    ), '[]'::jsonb),
    'policies', COALESCE((
        SELECT jsonb_agg(to_jsonb(policy) ORDER BY policy.polname)
          FROM pg_policy AS policy
         WHERE policy.polrelid = (SELECT oid FROM target)
    ), '[]'::jsonb),
    'triggers', COALESCE((
        SELECT jsonb_agg(
                   to_jsonb(trigger) || jsonb_build_object('oid', trigger.oid)
                   ORDER BY trigger.tgname
               )
          FROM pg_trigger AS trigger
         WHERE trigger.tgrelid = (SELECT oid FROM target)
    ), '[]'::jsonb),
    'descriptions', COALESCE((
        SELECT jsonb_agg(to_jsonb(description) ORDER BY description.objsubid)
          FROM pg_description AS description
         WHERE description.classoid = 'pg_class'::regclass
           AND description.objoid = (SELECT oid FROM target)
    ), '[]'::jsonb),
    'routines', (
        SELECT jsonb_agg(
                   to_jsonb(procedure)
                   || jsonb_build_object(
                       'oid', procedure.oid,
                       'definition', pg_get_functiondef(procedure.oid),
                       'description', obj_description(procedure.oid, 'pg_proc')
                   ) ORDER BY procedure.proname, procedure.oid
               )
          FROM pg_proc AS procedure
         WHERE procedure.pronamespace = 'public'::regnamespace
           AND procedure.proname IN (
               'sophia_begin_deck_quality_shadow_dispatch',
               'sophia_resolve_deck_quality_shadow_dispatch',
               'sophia_list_unresolved_deck_quality_shadow_dispatches'
           )
    )
)::text, 'UTF8')), 'hex');
""",
    ).stdout.strip()


def _legacy_publication_contract_sql() -> str:
    """Reconstruct the exact immutable 07/16 deployed function pair."""
    sql = _PUBLICATION_MIGRATION.read_text(encoding="utf-8")
    source = _function_ddl(
        sql,
        "sophia_deck_quality_publication_source_path_valid",
        "sophia_deck_quality_publication_artifact_path_valid",
    )
    source = source.replace(
        "'publication/source_pack/manifest.json'",
        "'publication/source_pack/' || p_object_hash || '.json'",
    )
    assert "'publication/source_pack/' || p_object_hash || '.json'" in source

    request = _function_ddl(
        sql,
        "sophia_request_deck_quality_publication",
        "sophia_commit_deck_quality_publication_inputs",
    )
    if "v_publication.deadline_at IS DISTINCT FROM p_deadline_at" not in request:
        request = request.replace(
            "           OR v_publication.max_attempts IS DISTINCT FROM p_max_attempts\n"
            "           OR v_publication.quality_max_attempts IS DISTINCT FROM p_quality_max_attempts\n"
            "        THEN",
            "           OR v_publication.max_attempts IS DISTINCT FROM p_max_attempts\n"
            "           OR v_publication.deadline_at IS DISTINCT FROM p_deadline_at\n"
            "           OR v_publication.quality_max_attempts IS DISTINCT FROM p_quality_max_attempts\n"
            "           OR v_publication.quality_run_deadline_at IS DISTINCT FROM p_quality_run_deadline_at THEN",
        )
    assert "v_publication.deadline_at IS DISTINCT FROM p_deadline_at" in request
    assert (
        "v_publication.quality_run_deadline_at IS DISTINCT FROM p_quality_run_deadline_at"
        in request
    )

    return (
        source
        + request
        + """
DROP FUNCTION IF EXISTS public.sophia_request_ready_deck_quality_publication(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, TEXT, TEXT
);
GRANT EXECUTE ON FUNCTION public.sophia_request_deck_quality_publication(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ, INTEGER, TIMESTAMPTZ
) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_commit_deck_quality_publication_inputs(
    TEXT, TEXT, TEXT
) TO service_role;
"""
    )


@pytest.fixture
def legacy_publication_db() -> Iterator[str]:
    database = f"dq1_legacy_{uuid.uuid4().hex[:16]}"
    role_sql = """
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
"""
    _psql("postgres", role_sql)
    _psql("postgres", f'CREATE DATABASE "{database}"')
    try:
        for migration in (_QUALITY_MIGRATION, _PUBLICATION_MIGRATION):
            _psql(database, migration.read_text(), script=True)
        _psql(database, _legacy_publication_contract_sql(), script=True)
        fingerprint = _psql(
            database,
            """
SELECT
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
  ))),
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
  ))),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL;
""",
        ).stdout.strip()
        assert fingerprint == (
            "b90eaacc70f4c3b89848ee777414dbc2|"
            "41d85b6c276b381bafde8dd5c3a77bd7|t"
        )
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
        _psql("postgres", f'DROP DATABASE IF EXISTS "{database}"', check=False)


def _instrument() -> QualityInstrumentLock:
    return QualityInstrumentLock.model_validate(
        {
            "rubric_version": "deck-rubric-v2",
            "rubric_hash": "a" * 64,
            "prompt_hashes": {
                "blind_visual": "b" * 64,
                "plan_realization": "c" * 64,
                "large_deck": "d" * 64,
            },
            "judge_plan_hash": "e" * 64,
            "judge_profile_version": "v2",
            "evidence_preprocessor_version": "deck-evidence-v4",
            "judge_invoker_version": "deck-judge-invoker-v4",
            "assessment_schema_versions": {
                "blind_visual": "v4",
                "plan_realization": "v4",
            },
            "adjudication_policy_hash": "f" * 64,
        }
    )


def _request(
    suffix: str,
    *,
    artifact_hash: str = "0" * 64,
    input_manifest_hash: str = "1" * 64,
) -> QualityRunRequest:
    instrument = _instrument()
    artifact_version_id = f"artifact-version-{suffix}"
    quality_run_id = derive_quality_run_id(
        artifact_version_id=artifact_version_id,
        campaign_id="DQ-1",
        instrument=instrument,
    )
    return QualityRunRequest.model_validate(
        {
            "campaign_id": "DQ-1",
            "instrument": instrument,
            "user_id": "canary-user",
            "thread_id": "canary-thread",
            "task_id": f"task-{suffix}",
            "build_id": f"build-{suffix}",
            "builder_run_id": f"builder-{suffix}",
            "parent_builder_trace_id": f"builder-trace-{suffix}",
            "logical_artifact_id": f"artifact-{suffix}",
            "artifact_version_id": artifact_version_id,
            "manifest_revision": 1,
            "artifact_hash": artifact_hash,
            "input_manifest_object_path": (
                "artifacts/canary-user/canary-thread/foundation/.builder/builds/"
                f"build-{suffix}/quality/{quality_run_id}/input_bundle/manifest.json"
            ),
            "input_manifest_hash": input_manifest_hash,
            "max_attempts": 5,
            "run_deadline_at": datetime.now(UTC) + timedelta(minutes=10),
        }
    )


def _sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, Mapping):
        encoded = json.dumps(dict(value), sort_keys=True, separators=(",", ":"))
        return f"'{encoded.replace(chr(39), chr(39) * 2)}'::jsonb"
    if isinstance(value, datetime):
        value = value.isoformat()
    if isinstance(value, str):
        return f"'{value.replace(chr(39), chr(39) * 2)}'"
    raise TypeError(f"unsupported SQL literal type: {type(value).__name__}")


def _function_call(name: str, payload: Mapping[str, object]) -> str:
    arguments = ",\n".join(
        f"        {key} => {_sql_literal(value)}" for key, value in payload.items()
    )
    return f"public.{name}(\n{arguments}\n    )"


def _publication_payload(
    request: QualityRunRequest,
    *,
    deadline_at: datetime,
    include_source_pack: bool,
) -> dict[str, object]:
    payload = request.rpc_payload()
    publication_payload: dict[str, object] = {
        key: value
        for key, value in payload.items()
        if key
        not in {
            "p_input_manifest_object_path",
            "p_input_manifest_hash",
            "p_max_attempts",
            "p_run_deadline_at",
        }
    }
    publication_payload.update(
        {
            "p_artifact_object_path": (
                "artifacts/canary-user/canary-thread/decks/final.pptx"
            ),
            "p_max_attempts": 3,
            "p_deadline_at": deadline_at,
            "p_quality_max_attempts": 5,
            "p_quality_run_deadline_at": deadline_at + timedelta(minutes=12),
        }
    )
    if include_source_pack:
        publication_payload.update(
            {
                "p_source_pack_object_path": (
                    request.input_manifest_object_path.replace(
                        "input_bundle/manifest.json",
                        "publication/source_pack/manifest.json",
                    )
                ),
                "p_source_pack_hash": "4" * 64,
            }
        )
    return publication_payload


def _insert_quality(database: str, request: QualityRunRequest) -> str:
    call = _function_call(
        "sophia_request_deck_quality_shadow_run",
        request.rpc_payload(),
    )
    result = _psql(
        database,
        (
            "SELECT quality_run_id, artifact_hash, input_manifest_hash "
            f"FROM {call};"
        ),
    )
    row = result.stdout.strip().split("|")
    assert row == [
        request.quality_run_id,
        request.artifact_hash,
        request.input_manifest_hash,
    ]
    return request.quality_run_id


def _claim_hash(owner: str, token: str, lease_seconds: int, limit: int) -> str:
    return canonical_sha256(
        {
            "lease_owner": owner,
            "claim_token": token,
            "lease_seconds": lease_seconds,
            "limit": limit,
        }
    )


def _claim_sql(
    *,
    owner: str,
    token: str,
    lease_seconds: int = 120,
    limit: int = 1,
    columns: str = "quality_run_id",
) -> str:
    claim_hash = _claim_hash(owner, token, lease_seconds, limit)
    return (
        f"SELECT {columns} FROM public.sophia_claim_deck_quality_shadow_runs("
        f"{_sql_literal(owner)}, {_sql_literal(token)}, {_sql_literal(claim_hash)}, "
        f"{lease_seconds}, {limit});"
    )


def _safe_root(request: QualityRunRequest) -> dict[str, object]:
    return {
        "schema_version": "deck-quality-safe-trace-root/v2",
        "campaign_id": request.campaign_id,
        "quality_run_id": request.quality_run_id,
        "build_id": request.build_id,
        "task_id": request.task_id or "missing-task",
        "builder_run_id": request.builder_run_id or "missing-builder-run",
        "parent_builder_run_id": request.builder_run_id or "missing-builder-run",
        "parent_builder_trace_id": request.parent_builder_trace_id
        or "missing-builder-trace",
        "logical_artifact_id": request.logical_artifact_id,
        "artifact_version_id": request.artifact_version_id,
        "manifest_revision": request.manifest_revision,
        "artifact_hash": request.artifact_hash,
        "rubric_version": request.instrument.rubric_version,
        "rubric_hash": request.instrument.rubric_hash,
        "judge_deployment": "dq1-judge",
        "judge_provider": "anthropic",
        "judge_model": "claude-sonnet",
        "judge_profile_version": request.instrument.judge_profile_version,
        "judge_plan_hash": request.instrument.judge_plan_hash,
        "evidence_preprocessor_version": request.instrument.evidence_preprocessor_version,
        "source_commit_sha": "1" * 40,
        "gateway_deployed_sha": "2" * 40,
        "langgraph_deployed_sha": "3" * 40,
    }


def _trace_ids(suffix: str) -> dict[str, str]:
    root = f"root-{suffix}"
    return {
        "quality_trace_id": root,
        "quality_root_run_id": root,
        "dispatch_run_id": f"dispatch-{suffix}",
        "snapshot_run_id": f"snapshot-{suffix}",
        "evidence_run_id": f"evidence-{suffix}",
        "blind_visual_run_id": f"blind-{suffix}",
        "mechanical_projection_run_id": f"mechanical-{suffix}",
        "plan_realization_run_id": f"plan-{suffix}",
        "adjudicate_run_id": f"adjudicate-{suffix}",
        "shadow_persist_run_id": f"persist-{suffix}",
    }


def test_forward_atomic_publication_migration_upgrades_legacy_base_twice(
    legacy_publication_db: str,
) -> None:
    migration = _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8")
    _psql(legacy_publication_db, migration, script=True)
    first = _psql(
        legacy_publication_db,
        """
SELECT
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
  ))),
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
  ))),
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  )));
""",
    ).stdout.strip()
    assert first == (
        "fa5d31480d0954fa93e0fab57523b4d5|"
        "c99608b73c3c795fe36c8fa74b75362c|"
        "bd161aca30390438b913ee81ab0979e3"
    )

    _psql(legacy_publication_db, migration, script=True)
    rerun = _psql(
        legacy_publication_db,
        """
SELECT
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
  ))),
  has_function_privilege(
    'service_role',
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)',
    'EXECUTE'
  ),
  has_function_privilege(
    'service_role',
    'public.sophia_commit_deck_quality_publication_inputs(text,text,text)',
    'EXECUTE'
  ),
  has_function_privilege(
    'service_role',
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)',
    'EXECUTE'
  );
""",
    ).stdout.strip()
    assert rerun == "fa5d31480d0954fa93e0fab57523b4d5|f|f|t"


def test_forward_atomic_publication_postflight_rolls_back_drifted_first_apply(
    legacy_publication_db: str,
) -> None:
    migration = _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8")
    drifted = migration.replace(
        "'publication/source_pack/manifest.json'",
        "'publication/source_pack/drifted.json'",
        1,
    )
    assert drifted != migration
    before = _psql(
        legacy_publication_db,
        """
SELECT
  encode(sha256(convert_to(prosrc, 'UTF8')), 'hex'),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL,
  has_function_privilege(
    'service_role',
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)',
    'EXECUTE'
  )
FROM pg_proc
WHERE oid = to_regprocedure(
  'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
);
""",
    ).stdout.strip()
    assert before == (
        "ed3ab9d582ceccf766e3523082108c38aded2cf19c41c399c93eb7ee478acef6"
        "|t|t"
    )

    failed = _psql(
        legacy_publication_db,
        drifted,
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert (
        "deck_quality_publication_atomic_migration_postflight_failed"
        in failed.stderr
    )
    after = _psql(
        legacy_publication_db,
        """
SELECT
  encode(sha256(convert_to(prosrc, 'UTF8')), 'hex'),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL,
  has_function_privilege(
    'service_role',
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)',
    'EXECUTE'
  )
FROM pg_proc
WHERE oid = to_regprocedure(
  'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
);
""",
    ).stdout.strip()
    assert after == before


def test_forward_atomic_publication_migration_rejects_mixed_state_atomically(
    legacy_publication_db: str,
) -> None:
    delta = _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8")
    stable_source = _function_ddl(
        delta,
        "sophia_deck_quality_publication_source_path_valid",
        "sophia_request_deck_quality_publication",
    )
    _psql(legacy_publication_db, stable_source, script=True)
    before = _psql(
        legacy_publication_db,
        """
SELECT
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
  ))),
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
  ))),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL,
  has_function_privilege(
    'service_role',
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)',
    'EXECUTE'
  );
""",
    ).stdout.strip()
    assert before == (
        "fa5d31480d0954fa93e0fab57523b4d5|"
        "41d85b6c276b381bafde8dd5c3a77bd7|t|t"
    )

    failed = _psql(legacy_publication_db, delta, check=False, script=True)
    assert failed.returncode != 0
    assert "deck_quality_publication_atomic_migration_unknown_fingerprint" in failed.stderr
    after = _psql(
        legacy_publication_db,
        """
SELECT
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
  ))),
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
  ))),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL,
  has_function_privilege(
    'service_role',
    'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)',
    'EXECUTE'
  );
""",
    ).stdout.strip()
    assert after == before


def test_forward_atomic_publication_migration_rejects_mutated_commit_helper(
    legacy_publication_db: str,
) -> None:
    _psql(
        legacy_publication_db,
        """
CREATE OR REPLACE FUNCTION public.sophia_commit_deck_quality_publication_inputs(
    p_quality_run_id TEXT,
    p_source_pack_object_path TEXT,
    p_source_pack_hash TEXT
) RETURNS SETOF public.sophia_deck_quality_publications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RAISE EXCEPTION 'mutated_commit_must_never_run';
END;
$$;
""",
        script=True,
    )
    before = _psql(
        legacy_publication_db,
        """
SELECT
  encode(sha256(convert_to(prosrc, 'UTF8')), 'hex'),
  has_function_privilege(
    'service_role',
    'public.sophia_commit_deck_quality_publication_inputs(text,text,text)',
    'EXECUTE'
  )
FROM pg_proc
WHERE oid = to_regprocedure(
  'public.sophia_commit_deck_quality_publication_inputs(text,text,text)'
);
""",
    ).stdout.strip()
    assert before != (
        "a207aa72bf2b23ba9c76a4466f1dfb54cc714fc50c71c994f9ca962b01c697ee|t"
    )
    assert before.endswith("|t")

    failed = _psql(
        legacy_publication_db,
        _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )
    assert failed.returncode != 0
    assert "deck_quality_publication_atomic_migration_unknown_fingerprint" in failed.stderr
    after = _psql(
        legacy_publication_db,
        """
SELECT
  encode(sha256(convert_to(prosrc, 'UTF8')), 'hex'),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL
FROM pg_proc
WHERE oid = to_regprocedure(
  'public.sophia_commit_deck_quality_publication_inputs(text,text,text)'
);
""",
    ).stdout.strip()
    assert after == f"{before.removesuffix('|t')}|t"


def test_forward_atomic_publication_migration_rejects_unknown_commit_acl(
    legacy_publication_db: str,
) -> None:
    _psql(
        legacy_publication_db,
        """
GRANT EXECUTE ON FUNCTION public.sophia_commit_deck_quality_publication_inputs(
    TEXT, TEXT, TEXT
) TO authenticated;
""",
    )
    failed = _psql(
        legacy_publication_db,
        _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )
    assert failed.returncode != 0
    assert "deck_quality_publication_atomic_migration_unknown_fingerprint" in failed.stderr
    unchanged = _psql(
        legacy_publication_db,
        """
SELECT
  has_function_privilege(
    'authenticated',
    'public.sophia_commit_deck_quality_publication_inputs(text,text,text)',
    'EXECUTE'
  ),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL;
""",
    ).stdout.strip()
    assert unchanged == "t|t"


@pytest.mark.parametrize(
    ("mutation_sql", "proof_sql", "expected"),
    (
        pytest.param(
            """
ALTER TABLE public.sophia_deck_quality_publications
    ADD COLUMN dq1_unexpected_publication_column TEXT DEFAULT 'x';
""",
            """
SELECT column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'sophia_deck_quality_publications'
   AND column_name = 'dq1_unexpected_publication_column';
""",
            "'x'::text",
            id="extra-column",
        ),
        pytest.param(
            """
ALTER TABLE public.sophia_deck_quality_publications
    ADD CONSTRAINT dq1_unexpected_publication_constraint
    CHECK (quality_run_id IS NOT NULL) NOT VALID;
""",
            """
SELECT convalidated
  FROM pg_constraint
 WHERE conrelid = 'public.sophia_deck_quality_publications'::regclass
   AND conname = 'dq1_unexpected_publication_constraint';
""",
            "f",
            id="extra-constraint",
        ),
        pytest.param(
            """
CREATE INDEX dq1_unexpected_publication_index
    ON public.sophia_deck_quality_publications (quality_run_id);
""",
            "SELECT to_regclass('public.dq1_unexpected_publication_index') IS NOT NULL;",
            "t",
            id="extra-index",
        ),
        pytest.param(
            """
CREATE POLICY dq1_unexpected_publication_policy
    ON public.sophia_deck_quality_publications USING (true);
""",
            """
SELECT count(*)
  FROM pg_policy
 WHERE polrelid = 'public.sophia_deck_quality_publications'::regclass
   AND polname = 'dq1_unexpected_publication_policy';
""",
            "1",
            id="extra-policy",
        ),
        pytest.param(
            """
CREATE FUNCTION public.dq1_unexpected_publication_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RETURN NEW;
END;
$$;
CREATE TRIGGER dq1_unexpected_publication_trigger
    BEFORE INSERT ON public.sophia_deck_quality_publications
    FOR EACH ROW EXECUTE FUNCTION public.dq1_unexpected_publication_trigger();
""",
            """
SELECT count(*)
  FROM pg_trigger
 WHERE tgrelid = 'public.sophia_deck_quality_publications'::regclass
   AND tgname = 'dq1_unexpected_publication_trigger';
""",
            "1",
            id="extra-trigger",
        ),
        pytest.param(
            "GRANT SELECT ON public.sophia_deck_quality_publications TO authenticated;",
            """
SELECT has_table_privilege(
    'authenticated',
    'public.sophia_deck_quality_publications',
    'SELECT'
);
""",
            "t",
            id="table-acl",
        ),
        pytest.param(
            """
CREATE FUNCTION public.sophia_commit_deck_quality_publication_inputs(TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;
""",
            """
SELECT to_regprocedure(
    'public.sophia_commit_deck_quality_publication_inputs(text)'
) IS NOT NULL;
""",
            "t",
            id="same-name-overload",
        ),
    ),
)
def test_forward_atomic_publication_migration_rejects_extra_catalog_state(
    legacy_publication_db: str,
    mutation_sql: str,
    proof_sql: str,
    expected: str,
) -> None:
    _psql(legacy_publication_db, mutation_sql, script=True)

    failed = _psql(
        legacy_publication_db,
        _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert (
        "deck_quality_publication_atomic_migration_unknown_fingerprint"
        in failed.stderr
    )
    assert _psql(legacy_publication_db, proof_sql).stdout.strip() == expected


def test_forward_atomic_publication_migration_refuses_nonempty_legacy_table(
    legacy_publication_db: str,
) -> None:
    request = _request("legacy-nonempty", artifact_hash="2" * 64)
    deadline = datetime.now(UTC) + timedelta(minutes=2)
    payload = _publication_payload(
        request,
        deadline_at=deadline,
        include_source_pack=False,
    )
    inserted = _psql(
        legacy_publication_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            f"{_function_call('sophia_request_deck_quality_publication', payload)}; "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert inserted == "awaiting_inputs"

    failed = _psql(
        legacy_publication_db,
        _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )
    assert failed.returncode != 0
    assert (
        "deck_quality_publication_atomic_migration_legacy_rows_present"
        in failed.stderr
    )
    unchanged = _psql(
        legacy_publication_db,
        """
SELECT
  count(*),
  min(state),
  md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(
    'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
  ))),
  to_regprocedure(
    'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
  ) IS NULL
FROM public.sophia_deck_quality_publications;
""",
    ).stdout.strip()
    assert unchanged == "1|awaiting_inputs|b90eaacc70f4c3b89848ee777414dbc2|t"


def test_forward_atomic_publication_migration_revalidates_existing_v2_rows(
    postgres_db: str,
) -> None:
    request = _request("v2-invalid-source", artifact_hash="2" * 64)
    payload = _publication_payload(
        request,
        deadline_at=datetime.now(UTC) + timedelta(minutes=2),
        include_source_pack=True,
    )
    inserted = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            f"{_function_call('sophia_request_ready_deck_quality_publication', payload)}; "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert inserted == "pending"

    bad_source_path = str(payload["p_source_pack_object_path"]).replace(
        "publication/source_pack/manifest.json",
        f"publication/source_pack/{'4' * 64}.json",
    )
    _psql(
        postgres_db,
        """
CREATE OR REPLACE FUNCTION public.sophia_deck_quality_publication_source_path_valid(
    p_object_path TEXT,
    p_object_hash TEXT,
    p_user_id TEXT,
    p_thread_id TEXT,
    p_build_id TEXT,
    p_quality_run_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$ SELECT true; $$;
""",
        script=True,
    )
    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_publications "
            f"SET source_pack_object_path = {_sql_literal(bad_source_path)} "
            f"WHERE quality_run_id = {_sql_literal(request.quality_run_id)};"
        ),
    )
    delta = _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8")
    _psql(
        postgres_db,
        _single_function_ddl(
            delta,
            "sophia_deck_quality_publication_source_path_valid",
        ),
        script=True,
    )
    invalid_before = _psql(
        postgres_db,
        f"""
SELECT
  encode(sha256(convert_to(prosrc, 'UTF8')), 'hex'),
  public.sophia_deck_quality_publication_source_path_valid(
    source_pack_object_path, source_pack_hash, user_id, thread_id,
    build_id, quality_run_id
  )
FROM pg_proc, public.sophia_deck_quality_publications
WHERE pg_proc.oid = to_regprocedure(
  'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
)
  AND quality_run_id = {_sql_literal(request.quality_run_id)};
""",
    ).stdout.strip()
    assert invalid_before == (
        "9a068fb761d5bf36dd23516d9a40aa44372bddb96b664e745815ed07517e327d|f"
    )

    failed = _psql(postgres_db, delta, check=False, script=True)
    assert failed.returncode != 0
    assert (
        "deck_quality_publication_atomic_migration_existing_rows_invalid"
        in failed.stderr
    )
    unchanged = _psql(
        postgres_db,
        (
            "SELECT source_pack_object_path FROM "
            "public.sophia_deck_quality_publications WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    ).stdout.strip()
    assert unchanged == bad_source_path


def test_forward_atomic_publication_migration_requires_function_owner_executor(
    postgres_db: str,
) -> None:
    role = f"dq1_admin_{uuid.uuid4().hex[:12]}"
    _psql("postgres", f'CREATE ROLE "{role}" NOLOGIN SUPERUSER')
    try:
        failed = _psql(
            postgres_db,
            f'SET ROLE "{role}";\n'
            + _PUBLICATION_ATOMIC_MIGRATION.read_text(encoding="utf-8"),
            check=False,
            script=True,
        )
        assert failed.returncode != 0
        assert (
            "deck_quality_publication_atomic_migration_environment_invalid"
            in failed.stderr
        )
        unchanged = _psql(
            postgres_db,
            """
SELECT
  pg_get_userbyid(proowner),
  encode(sha256(convert_to(prosrc, 'UTF8')), 'hex')
FROM pg_proc
WHERE oid = to_regprocedure(
  'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
);
""",
        ).stdout.strip()
        assert unchanged == (
            "postgres|"
            "06efeaa941970eb7d86d52043ea5370662120a1970cffb20814d5bd90d1cc663"
        )
    finally:
        _psql("postgres", f'DROP ROLE IF EXISTS "{role}"', check=False)


def test_forward_atomic_publication_migration_converges_exact_set_role_acls(
    postgres_db: str,
) -> None:
    signatures = {
        "request": (
            "public.sophia_request_deck_quality_publication"
            "(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,"
            "text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,"
            "integer,timestamptz)"
        ),
        "commit": (
            "public.sophia_commit_deck_quality_publication_inputs(text,text,text)"
        ),
        "atomic": (
            "public.sophia_request_ready_deck_quality_publication"
            "(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,"
            "text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,"
            "integer,timestamptz,text,text)"
        ),
    }
    for role, expected in (
        ("anon", "anon|f|f|f"),
        ("authenticated", "authenticated|f|f|f"),
        ("service_role", "service_role|f|f|t"),
    ):
        acl = _psql(
            postgres_db,
            (
                f"SET ROLE {role}; SELECT current_user, "
                f"has_function_privilege(current_user, '{signatures['request']}', 'EXECUTE'), "
                f"has_function_privilege(current_user, '{signatures['commit']}', 'EXECUTE'), "
                f"has_function_privilege(current_user, '{signatures['atomic']}', 'EXECUTE'); "
                "RESET ROLE;"
            ),
        ).stdout.strip()
        assert acl == expected

    public_acl_count = _psql(
        postgres_db,
        f"""
SELECT count(*)
  FROM unnest(ARRAY[
      '{signatures['request']}'::regprocedure,
      '{signatures['commit']}'::regprocedure,
      '{signatures['atomic']}'::regprocedure
  ]) AS target(function_oid)
  JOIN pg_proc AS procedure ON procedure.oid = target.function_oid
  CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl
 WHERE acl.grantee = 0;
""",
    ).stdout.strip()
    assert public_acl_count == "0"


def test_dispatch_intent_migration_installs_exact_owned_service_role_contract(
    postgres_db_through_dispatch_intent: str,
) -> None:
    postgres_db = postgres_db_through_dispatch_intent
    signatures = (
        (
            "sophia_begin_deck_quality_shadow_dispatch",
            "public.sophia_begin_deck_quality_shadow_dispatch(text,text,bigint,text)",
        ),
        (
            "sophia_resolve_deck_quality_shadow_dispatch",
            "public.sophia_resolve_deck_quality_shadow_dispatch(text,text,text)",
        ),
        (
            "sophia_list_unresolved_deck_quality_shadow_dispatches",
            "public.sophia_list_unresolved_deck_quality_shadow_dispatches(integer)",
        ),
    )
    sql = _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8")
    expected_hashes: dict[str, str] = {}
    for name, _signature in signatures:
        ddl = _single_function_ddl(sql, name)
        body = ddl.split("AS $$", 1)[1].rsplit("$$;", 1)[0]
        expected_hashes[name] = hashlib.sha256(body.encode()).hexdigest()

    for name, signature in signatures:
        identity = _psql(
            postgres_db,
            f"""
SELECT
  procedure.proname,
  pg_get_userbyid(procedure.proowner),
  procedure.prosecdef,
  array_to_string(procedure.proconfig, ','),
  encode(sha256(convert_to(procedure.prosrc, 'UTF8')), 'hex')
FROM pg_proc AS procedure
WHERE procedure.oid = '{signature}'::regprocedure;
""",
        ).stdout.strip()
        assert identity == (
            f"{name}|postgres|t|search_path=public|{expected_hashes[name]}"
        )

        for role, expected in (
            ("anon", "f"),
            ("authenticated", "f"),
            ("service_role", "t"),
        ):
            privilege = _psql(
                postgres_db,
                (
                    f"SELECT has_function_privilege('{role}', "
                    f"'{signature}', 'EXECUTE');"
                ),
            ).stdout.strip()
            assert privilege == expected

    public_acl_count = _psql(
        postgres_db,
        """
SELECT count(*)
  FROM pg_proc AS procedure
  CROSS JOIN LATERAL aclexplode(
      COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
  ) AS acl
 WHERE procedure.oid IN (
     'public.sophia_begin_deck_quality_shadow_dispatch(text,text,bigint,text)'::regprocedure,
     'public.sophia_resolve_deck_quality_shadow_dispatch(text,text,text)'::regprocedure,
     'public.sophia_list_unresolved_deck_quality_shadow_dispatches(integer)'::regprocedure
 )
   AND acl.grantee = 0;
""",
    ).stdout.strip()
    assert public_acl_count == "0"

    before_replay = _dispatch_catalog_snapshot(postgres_db)
    assert len(before_replay) == 64
    _psql(
        postgres_db,
        _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8"),
        script=True,
    )
    assert _dispatch_catalog_snapshot(postgres_db) == before_replay


def test_trace_grace_recovery_rpc_is_owned_and_service_role_only(
    postgres_db: str,
) -> None:
    signature = (
        "public.sophia_recover_expired_deck_quality_shadow_runs(integer)"
    )
    identity = _psql(
        postgres_db,
        f"""
SELECT
  procedure.proname,
  pg_get_userbyid(procedure.proowner),
  procedure.prosecdef,
  array_to_string(procedure.proconfig, ',')
FROM pg_proc AS procedure
WHERE procedure.oid = '{signature}'::regprocedure;
""",
    ).stdout.strip()
    assert identity == (
        "sophia_recover_expired_deck_quality_shadow_runs|"
        "postgres|t|search_path=public"
    )

    privileges = _psql(
        postgres_db,
        f"""
SELECT
  has_function_privilege('anon', '{signature}', 'EXECUTE'),
  has_function_privilege('authenticated', '{signature}', 'EXECUTE'),
  has_function_privilege('service_role', '{signature}', 'EXECUTE'),
  has_table_privilege(
      'service_role',
      'public.sophia_deck_quality_shadow_runs',
      'SELECT'
  );
""",
    ).stdout.strip()
    assert privileges == "f|f|t|f"

    denied = _psql(
        postgres_db,
        (
            "SET ROLE anon; SELECT "
            "public.sophia_recover_expired_deck_quality_shadow_runs(1);"
        ),
        check=False,
    )
    assert denied.returncode != 0


def test_dispatch_intent_postflight_rolls_back_drifted_replay(
    postgres_db_through_dispatch_intent: str,
) -> None:
    postgres_db = postgres_db_through_dispatch_intent
    migration = _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8")
    drifted = migration.replace(
        "'shadow_dispatch_prelaunch'",
        "'shadow_dispatch_prelaunch_drifted'",
        1,
    )
    assert drifted != migration
    before = _dispatch_catalog_snapshot(postgres_db)

    failed = _psql(postgres_db, drifted, check=False, script=True)

    assert failed.returncode != 0
    assert "deck_quality_dispatch_intent_postflight_failed" in failed.stderr
    assert _dispatch_catalog_snapshot(postgres_db) == before


def test_dispatch_intent_migration_rejects_unknown_function_body_before_mutation(
    postgres_db: str,
) -> None:
    _psql(
        postgres_db,
        """
CREATE OR REPLACE FUNCTION public.sophia_resolve_deck_quality_shadow_dispatch(
    p_quality_run_id TEXT,
    p_dispatch_intent_token TEXT,
    p_dispatch_intent_status TEXT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT run.*
      FROM public.sophia_deck_quality_shadow_runs AS run
     WHERE false;
END;
$$;
""",
        script=True,
    )
    before = _psql(
        postgres_db,
        """
SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex')
FROM pg_proc
WHERE oid = 'public.sophia_resolve_deck_quality_shadow_dispatch(text,text,text)'::regprocedure;
""",
    ).stdout.strip()

    failed = _psql(
        postgres_db,
        _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert "deck_quality_dispatch_intent_unknown_fingerprint" in failed.stderr
    after = _psql(
        postgres_db,
        """
SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex')
FROM pg_proc
WHERE oid = 'public.sophia_resolve_deck_quality_shadow_dispatch(text,text,text)'::regprocedure;
""",
    ).stdout.strip()
    assert after == before


def test_dispatch_intent_migration_rejects_unknown_column_shape_before_mutation(
    postgres_db: str,
) -> None:
    _psql(
        postgres_db,
        """
ALTER TABLE public.sophia_deck_quality_shadow_runs
    ALTER COLUMN dispatch_intent_token SET DEFAULT 'tampered';
""",
    )

    failed = _psql(
        postgres_db,
        _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert "deck_quality_dispatch_intent_unknown_fingerprint" in failed.stderr
    default = _psql(
        postgres_db,
        """
SELECT pg_get_expr(definition.adbin, definition.adrelid)
  FROM pg_attribute AS attribute
  JOIN pg_attrdef AS definition
    ON definition.adrelid = attribute.attrelid
   AND definition.adnum = attribute.attnum
 WHERE attribute.attrelid = 'public.sophia_deck_quality_shadow_runs'::regclass
   AND attribute.attname = 'dispatch_intent_token';
""",
    ).stdout.strip()
    assert default == "'tampered'::text"


def test_dispatch_intent_migration_rejects_unknown_acl_before_mutation(
    postgres_db: str,
) -> None:
    signature = (
        "public.sophia_begin_deck_quality_shadow_dispatch"
        "(text,text,bigint,text)"
    )
    _psql(
        postgres_db,
        (
            "GRANT EXECUTE ON FUNCTION "
            f"{signature} TO authenticated;"
        ),
    )

    failed = _psql(
        postgres_db,
        _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert "deck_quality_dispatch_intent_unknown_fingerprint" in failed.stderr
    assert (
        _psql(
            postgres_db,
            (
                "SELECT has_function_privilege('authenticated', "
                f"'{signature}', 'EXECUTE');"
            ),
        ).stdout.strip()
        == "t"
    )


@pytest.mark.parametrize(
    ("mutation_sql", "proof_sql", "expected"),
    (
        pytest.param(
            """
ALTER TABLE public.sophia_deck_quality_shadow_runs
    ADD COLUMN dq1_unexpected_dispatch_column TEXT;
""",
            """
SELECT count(*)
  FROM pg_attribute
 WHERE attrelid = 'public.sophia_deck_quality_shadow_runs'::regclass
   AND attname = 'dq1_unexpected_dispatch_column'
   AND NOT attisdropped;
""",
            "1",
            id="extra-column",
        ),
        pytest.param(
            """
ALTER TABLE public.sophia_deck_quality_shadow_runs
    ADD CONSTRAINT dq1_unexpected_dispatch_constraint
    CHECK (quality_run_id IS NOT NULL) NOT VALID;
""",
            """
SELECT convalidated
  FROM pg_constraint
 WHERE conrelid = 'public.sophia_deck_quality_shadow_runs'::regclass
   AND conname = 'dq1_unexpected_dispatch_constraint';
""",
            "f",
            id="extra-constraint",
        ),
        pytest.param(
            """
CREATE INDEX dq1_unexpected_dispatch_index
    ON public.sophia_deck_quality_shadow_runs (quality_run_id);
""",
            "SELECT to_regclass('public.dq1_unexpected_dispatch_index') IS NOT NULL;",
            "t",
            id="extra-index",
        ),
        pytest.param(
            """
CREATE POLICY dq1_unexpected_dispatch_policy
    ON public.sophia_deck_quality_shadow_runs USING (true);
""",
            """
SELECT count(*)
  FROM pg_policy
 WHERE polrelid = 'public.sophia_deck_quality_shadow_runs'::regclass
   AND polname = 'dq1_unexpected_dispatch_policy';
""",
            "1",
            id="extra-policy",
        ),
        pytest.param(
            """
CREATE FUNCTION public.dq1_unexpected_dispatch_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RETURN NEW;
END;
$$;
CREATE TRIGGER dq1_unexpected_dispatch_trigger
    BEFORE INSERT ON public.sophia_deck_quality_shadow_runs
    FOR EACH ROW EXECUTE FUNCTION public.dq1_unexpected_dispatch_trigger();
""",
            """
SELECT count(*)
  FROM pg_trigger
 WHERE tgrelid = 'public.sophia_deck_quality_shadow_runs'::regclass
   AND tgname = 'dq1_unexpected_dispatch_trigger';
""",
            "1",
            id="extra-trigger",
        ),
        pytest.param(
            "GRANT SELECT ON public.sophia_deck_quality_shadow_runs TO authenticated;",
            """
SELECT has_table_privilege(
    'authenticated',
    'public.sophia_deck_quality_shadow_runs',
    'SELECT'
);
""",
            "t",
            id="table-acl",
        ),
        pytest.param(
            """
CREATE FUNCTION public.sophia_begin_deck_quality_shadow_dispatch(TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;
""",
            """
SELECT to_regprocedure(
    'public.sophia_begin_deck_quality_shadow_dispatch(text)'
) IS NOT NULL;
""",
            "t",
            id="same-name-overload",
        ),
    ),
)
def test_dispatch_intent_migration_rejects_extra_catalog_state_before_mutation(
    postgres_db: str,
    mutation_sql: str,
    proof_sql: str,
    expected: str,
) -> None:
    _psql(postgres_db, mutation_sql, script=True)

    failed = _psql(
        postgres_db,
        _DISPATCH_INTENT_MIGRATION.read_text(encoding="utf-8"),
        check=False,
        script=True,
    )

    assert failed.returncode != 0
    assert "deck_quality_dispatch_intent_unknown_fingerprint" in failed.stderr
    assert _psql(postgres_db, proof_sql).stdout.strip() == expected


@pytest.mark.parametrize(
    ("failure_stage", "new_dispatch_allowed"),
    (
        pytest.param(
            "shadow_dispatch_prelaunch",
            True,
            id="prelaunch-proof-allows-new-intent",
        ),
        pytest.param(
            "shadow_dispatch_launch",
            False,
            id="launch-ambiguity-retains-old-intent",
        ),
    ),
)
def test_real_postgres_dispatch_unavailable_replay_uses_stage_liveness_proof(
    postgres_db: str,
    failure_stage: str,
    new_dispatch_allowed: bool,
) -> None:
    request = _request(f"dispatch-stage-proof-{failure_stage}")
    _insert_quality(postgres_db, request)
    first_owner = f"{failure_stage}-owner-a"
    claimed = _psql(
        postgres_db,
        _claim_sql(
            owner=first_owner,
            token=f"{failure_stage}-claim-a",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert claimed == "1|1"

    first_intent = f"dq1-dispatch:{failure_stage}:a"
    initialized = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(first_owner)}, 1, "
            f"{_sql_literal(first_intent)}); "
            "SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(first_intent)}, 'unresolved'); RESET ROLE;"
        ),
    ).stdout.strip().splitlines()
    assert initialized == ["prepared", "unresolved"]

    _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            "public.sophia_retry_deck_quality_shadow_run("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(first_owner)}, 1, "
            f"'shadow_dispatch_unavailable', {_sql_literal(failure_stage)}, "
            "0, 5); RESET ROLE;"
        ),
    )
    second_owner = f"{failure_stage}-owner-b"
    reclaimed = _psql(
        postgres_db,
        _claim_sql(
            owner=second_owner,
            token=f"{failure_stage}-claim-b",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert reclaimed == "2|2"

    second_intent = f"dq1-dispatch:{failure_stage}:b"
    replay = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch, "
            "dispatch_intent_attempt_count, "
            "dispatch_recovery_proof_hash IS NOT NULL FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(second_owner)}, 2, "
            f"{_sql_literal(second_intent)}); RESET ROLE;"
        ),
    ).stdout.strip()

    if new_dispatch_allowed:
        assert replay == f"prepared|{second_intent}|2|2|t"
    else:
        assert replay == f"unresolved|{first_intent}|1|1|f"


def test_real_postgres_dispatch_intent_fences_ambiguity_and_allows_proven_recovery(
    postgres_db: str,
) -> None:
    request = _request("dispatch-ambiguous")
    _insert_quality(postgres_db, request)
    owner = "dispatch-owner-a"
    claimed = _psql(
        postgres_db,
        _claim_sql(
            owner=owner,
            token="dispatch-claim-a",
            columns="quality_run_id, lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert claimed == f"{request.quality_run_id}|1|1"

    intent = "dq1-dispatch:intent-a"
    prepared = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch, "
            "dispatch_intent_attempt_count FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, {_sql_literal(owner)}, 1, "
            f"{_sql_literal(intent)}); RESET ROLE;"
        ),
    ).stdout.strip()
    assert prepared == f"prepared|{intent}|1|1"

    replay = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, {_sql_literal(owner)}, 1, "
            "'dq1-dispatch:must-not-overwrite'); RESET ROLE;"
        ),
    ).stdout.strip()
    assert replay == f"prepared|{intent}"

    resolved = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, {_sql_literal(intent)}, "
            "'unresolved'); RESET ROLE;"
        ),
    ).stdout.strip()
    assert resolved == "unresolved"
    listed = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT quality_run_id, "
            "dispatch_intent_status FROM "
            "public.sophia_list_unresolved_deck_quality_shadow_dispatches(100); "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert listed == f"{request.quality_run_id}|unresolved"

    _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            "public.sophia_retry_deck_quality_shadow_run("
            f"{_sql_literal(request.quality_run_id)}, {_sql_literal(owner)}, 1, "
            "'shadow_dispatch_unavailable', 'shadow_dispatch_launch', 0, 5); "
            "RESET ROLE;"
        ),
    )
    second_owner = "dispatch-owner-b"
    second_claim = _psql(
        postgres_db,
        _claim_sql(
            owner=second_owner,
            token="dispatch-claim-b",
            columns="quality_run_id, lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert second_claim == f"{request.quality_run_id}|2|2"
    fenced = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(second_owner)}, 2, 'dq1-dispatch:intent-b'); "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert fenced == f"unresolved|{intent}|1"

    retry_request = _request("dispatch-graph-retry")
    _insert_quality(postgres_db, retry_request)
    retry_owner = "graph-retry-a"
    _psql(
        postgres_db,
        _claim_sql(owner=retry_owner, token="graph-retry-claim-a"),
    )
    _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(retry_request.quality_run_id)}, "
            f"{_sql_literal(retry_owner)}, 1, 'dq1-dispatch:graph-a'); "
            "SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(retry_request.quality_run_id)}, "
            "'dq1-dispatch:graph-a', 'confirmed'); "
            "SELECT state FROM public.sophia_retry_deck_quality_shadow_run("
            f"{_sql_literal(retry_request.quality_run_id)}, "
            f"{_sql_literal(retry_owner)}, 1, 'quality_persistence_error', "
            "'persist', 0, 5); RESET ROLE;"
        ),
    )
    retry_owner_b = "graph-retry-b"
    _psql(
        postgres_db,
        _claim_sql(owner=retry_owner_b, token="graph-retry-claim-b"),
    )
    graph_retry = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch, "
            "dispatch_intent_attempt_count FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(retry_request.quality_run_id)}, "
            f"{_sql_literal(retry_owner_b)}, 2, 'dq1-dispatch:graph-b'); "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert graph_retry == "prepared|dq1-dispatch:graph-b|2|2"

    cutover_request = _request("dispatch-cutover")
    _insert_quality(postgres_db, cutover_request)
    cutover_owner = "cutover-a"
    _psql(
        postgres_db,
        _claim_sql(owner=cutover_owner, token="cutover-claim-a"),
    )
    _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            "public.sophia_release_deck_quality_shadow_lease("
            f"{_sql_literal(cutover_request.quality_run_id)}, "
            f"{_sql_literal(cutover_owner)}, 1); RESET ROLE;"
        ),
    )
    cutover_owner_b = "cutover-b"
    _psql(
        postgres_db,
        _claim_sql(owner=cutover_owner_b, token="cutover-claim-b"),
    )
    cutover = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_epoch, dispatch_intent_attempt_count FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(cutover_request.quality_run_id)}, "
            f"{_sql_literal(cutover_owner_b)}, 2, 'dq1-dispatch:cutover'); "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert cutover == "unresolved|2|2"


def test_real_postgres_checkpoint_progress_authorizes_one_dispatch_replay(
    postgres_db: str,
) -> None:
    request = _request("dispatch-checkpoint-proof")
    _insert_quality(postgres_db, request)
    initial_owner = "checkpoint-proof-initial"
    claimed = _psql(
        postgres_db,
        _claim_sql(
            owner=initial_owner,
            token="checkpoint-proof-claim-1",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert claimed == "1|1"

    initial_intent = "dq1-dispatch:checkpoint-initial"
    _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(initial_owner)}, 1, "
            f"{_sql_literal(initial_intent)}); "
            "SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(initial_intent)}, 'confirmed'); RESET ROLE;"
        ),
    )

    evidence_path = request.input_manifest_object_path.replace(
        "/input_bundle/manifest.json",
        "/evidence_manifest.json",
    )
    checkpointed = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT stage, stage_rank FROM "
            "public.sophia_checkpoint_deck_quality_shadow_run("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(initial_owner)}, 1, 'snapshot_loaded', "
            "'{}'::jsonb, '{}'::jsonb, "
            "jsonb_build_object('source_snapshot', repeat('a', 64)), "
            f"{_sql_literal(evidence_path)}, {_sql_literal('b' * 64)}); "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert checkpointed == "snapshot_loaded|10"

    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs SET "
            "lease_expires_at = statement_timestamp() - interval '1 second' "
            "WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    )
    replay_owner = "checkpoint-proof-replay"
    reclaimed = _psql(
        postgres_db,
        _claim_sql(
            owner=replay_owner,
            token="checkpoint-proof-claim-2",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert reclaimed == "2|2"

    replay_intent = "dq1-dispatch:checkpoint-replay"
    replay = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch, "
            "dispatch_intent_attempt_count, dispatch_recovery_proof_hash "
            "FROM public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(replay_owner)}, 2, "
            f"{_sql_literal(replay_intent)}); "
            "SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(replay_intent)}, 'confirmed'); RESET ROLE;"
        ),
    ).stdout.strip().splitlines()
    replay_columns = replay[0].split("|")
    assert replay_columns[:4] == [
        "prepared",
        replay_intent,
        "2",
        "2",
    ]
    assert len(replay_columns[4]) == 64
    consumed_proof = replay_columns[4]
    assert replay[1] == "confirmed"

    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs SET "
            "lease_expires_at = statement_timestamp() - interval '1 second' "
            "WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    )
    fenced_owner = "checkpoint-proof-fenced"
    fenced_claim = _psql(
        postgres_db,
        _claim_sql(
            owner=fenced_owner,
            token="checkpoint-proof-claim-3",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert fenced_claim == "3|3"

    fenced = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch, "
            "dispatch_intent_attempt_count, dispatch_recovery_proof_hash "
            "FROM public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(fenced_owner)}, 3, "
            "'dq1-dispatch:checkpoint-must-not-launch'); RESET ROLE;"
        ),
    ).stdout.strip()
    assert fenced == f"confirmed|{replay_intent}|2|2|{consumed_proof}"


def test_real_postgres_dispatch_rejects_checkpoint_without_required_hash(
    postgres_db: str,
) -> None:
    request = _request("dispatch-invalid-checkpoint")
    _insert_quality(postgres_db, request)
    owner = "invalid-checkpoint-owner"
    _psql(
        postgres_db,
        _claim_sql(owner=owner, token="invalid-checkpoint-claim"),
    )
    evidence_path = request.input_manifest_object_path.replace(
        "/input_bundle/manifest.json",
        "/evidence_manifest.json",
    )
    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs SET "
            "stage = 'snapshot_loaded', stage_rank = 10, "
            f"evidence_manifest_object_path = {_sql_literal(evidence_path)}, "
            f"evidence_manifest_hash = {_sql_literal('b' * 64)}, "
            "stage_artifact_hashes = '{}'::jsonb WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    )

    rejected = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(owner)}, 1, "
            "'dq1-dispatch:invalid-checkpoint'); RESET ROLE;"
        ),
        check=False,
    )

    assert rejected.returncode != 0
    assert "deck_quality_dispatch_checkpoint_invalid" in rejected.stderr
    unchanged = _psql(
        postgres_db,
        (
            "SELECT dispatch_intent_status IS NULL, "
            "dispatch_recovery_proof_hash IS NULL FROM "
            "public.sophia_deck_quality_shadow_runs WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    ).stdout.strip()
    assert unchanged == "t|t"


def test_real_postgres_finalizing_recovery_proof_is_consumed_once(
    postgres_db: str,
) -> None:
    request = _request("dispatch-finalizing-proof")
    _insert_quality(postgres_db, request)
    initial_owner = "final-proof-initial"
    _psql(
        postgres_db,
        _claim_sql(owner=initial_owner, token="final-proof-claim-1"),
    )
    _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(initial_owner)}, 1, 'dq1-dispatch:initial'); "
            "SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            "'dq1-dispatch:initial', 'confirmed'); RESET ROLE;"
        ),
    )
    _psql(
        postgres_db,
        f"""
UPDATE public.sophia_deck_quality_shadow_runs
   SET state = 'finalizing',
       pending_terminal_state = 'failed',
       last_error_code = 'run_deadline_exceeded',
       last_error_stage = 'run_deadline',
       last_error_at = statement_timestamp(),
       error_count = error_count + 1,
       next_attempt_at = statement_timestamp(),
       lease_owner = NULL,
       lease_expires_at = NULL,
       claim_token = NULL,
       claim_hash = NULL,
       updated_at = statement_timestamp()
 WHERE quality_run_id = {_sql_literal(request.quality_run_id)};
""",
    )

    replay_owner = "final-proof-replay"
    claimed = _psql(
        postgres_db,
        _claim_sql(
            owner=replay_owner,
            token="final-proof-claim-2",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert claimed == "2|1"
    first = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch, "
            "dispatch_recovery_proof_hash IS NOT NULL FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(replay_owner)}, 2, 'dq1-dispatch:final-a'); "
            "SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            "'dq1-dispatch:final-a', 'confirmed'); RESET ROLE;"
        ),
    ).stdout.strip().splitlines()
    assert first == ["prepared|dq1-dispatch:final-a|2|t", "confirmed"]

    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs SET "
            "lease_expires_at = statement_timestamp() - interval '1 second' "
            "WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    )
    reclaimed_owner = "final-proof-reclaimed"
    reclaimed = _psql(
        postgres_db,
        _claim_sql(
            owner=reclaimed_owner,
            token="final-proof-claim-3",
            columns="lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert reclaimed == "3|1"
    fenced = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_intent_epoch FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(reclaimed_owner)}, 3, "
            "'dq1-dispatch:must-not-launch'); RESET ROLE;"
        ),
    ).stdout.strip()
    assert fenced == "confirmed|dq1-dispatch:final-a|2"

    unresolved = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status FROM "
            "public.sophia_resolve_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            "'dq1-dispatch:final-a', 'unresolved'); "
            "SELECT quality_run_id, dispatch_intent_status FROM "
            "public.sophia_list_unresolved_deck_quality_shadow_dispatches(100) "
            "WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)}; RESET ROLE;"
        ),
    ).stdout.strip().splitlines()
    assert unresolved == [
        "unresolved",
        f"{request.quality_run_id}|unresolved",
    ]

    root = _safe_root(request)
    root_hash = safe_trace_root_input_hash(root)
    terminal_hash = "7" * 64
    progressed = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT terminal_trace_payload_hash FROM "
            "public.sophia_prepare_deck_quality_shadow_failure_trace("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(reclaimed_owner)}, 3, 'failed', "
            "'run_deadline_exceeded', 'run_deadline', "
            f"{_sql_literal(terminal_hash)}, {_sql_literal(root)}, "
            f"{_sql_literal(root_hash)}); RESET ROLE;"
        ),
    ).stdout.strip()
    assert progressed == terminal_hash

    new_proof = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token, dispatch_recovery_proof_hash FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(reclaimed_owner)}, 3, "
            "'dq1-dispatch:final-b'); RESET ROLE;"
        ),
    ).stdout.strip().split("|")
    assert new_proof[:2] == ["prepared", "dq1-dispatch:final-b"]
    assert len(new_proof[2]) == 64

    exact_replay = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT dispatch_intent_status, "
            "dispatch_intent_token FROM "
            "public.sophia_begin_deck_quality_shadow_dispatch("
            f"{_sql_literal(request.quality_run_id)}, "
            f"{_sql_literal(reclaimed_owner)}, 3, "
            "'dq1-dispatch:must-not-overwrite-final-b'); RESET ROLE;"
        ),
    ).stdout.strip()
    assert exact_replay == "prepared|dq1-dispatch:final-b"


def test_real_postgres_acls_and_publication_preserve_exact_artifact_hash(
    postgres_db: str,
) -> None:
    acl = _psql(
        postgres_db,
        """
SELECT
  has_function_privilege('anon', 'public.sophia_claim_deck_quality_shadow_runs(text,text,text,integer,integer)', 'EXECUTE'),
  has_function_privilege('authenticated', 'public.sophia_claim_deck_quality_shadow_runs(text,text,text,integer,integer)', 'EXECUTE'),
  has_function_privilege('service_role', 'public.sophia_claim_deck_quality_shadow_runs(text,text,text,integer,integer)', 'EXECUTE'),
  has_function_privilege(
      'service_role',
      'public.sophia_request_deck_quality_shadow_run' ||
      '(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,' ||
      'text,text,text,text,text,text,text,bigint,text,text,text,integer,timestamptz)',
      'EXECUTE'
  ),
  has_table_privilege('service_role', 'public.sophia_deck_quality_shadow_runs', 'SELECT'),
  has_function_privilege('service_role', 'public.sophia_deck_quality_safe_trace_root_valid(jsonb,text)', 'EXECUTE'),
  has_function_privilege(
      'service_role',
      (SELECT oid FROM pg_proc WHERE proname = 'sophia_request_ready_deck_quality_publication'),
      'EXECUTE'
  ),
  has_function_privilege(
      'anon',
      (SELECT oid FROM pg_proc WHERE proname = 'sophia_request_ready_deck_quality_publication'),
      'EXECUTE'
  );
""",
    ).stdout.strip()
    assert acl == "f|f|t|f|f|f|t|f"

    request = _request(
        "publication",
        artifact_hash="2" * 64,
        input_manifest_hash="3" * 64,
    )
    publication_deadline = datetime.now(UTC) + timedelta(minutes=2)
    publication_payload = _publication_payload(
        request,
        deadline_at=publication_deadline,
        include_source_pack=True,
    )
    publication_call = _function_call(
        "sophia_request_ready_deck_quality_publication",
        publication_payload,
    )
    requested = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT quality_run_id, state, deadline_at "
            f"FROM {publication_call}; RESET ROLE;"
        ),
    ).stdout.strip()
    requested_id, requested_state, original_deadline = requested.split("|")
    assert (requested_id, requested_state) == (request.quality_run_id, "pending")

    source_hash = "4" * 64
    source_path = request.input_manifest_object_path.replace(
        "input_bundle/manifest.json",
        "publication/source_pack/manifest.json",
    )
    replay_payload = {
        **publication_payload,
        "p_deadline_at": publication_deadline + timedelta(seconds=15),
        "p_quality_run_deadline_at": publication_deadline
        + timedelta(minutes=12, seconds=15),
    }
    replay = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state, deadline_at FROM "
            f"{_function_call('sophia_request_ready_deck_quality_publication', replay_payload)}; "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert replay == f"pending|{original_deadline}"
    assert publication_payload["p_source_pack_object_path"] == source_path
    assert publication_payload["p_source_pack_hash"] == source_hash

    identity_conflict = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            f"{_function_call('sophia_request_ready_deck_quality_publication', {**replay_payload, 'p_artifact_hash': '9' * 64})}; "
            "RESET ROLE;"
        ),
        check=False,
    )
    assert identity_conflict.returncode != 0
    assert "deck_quality_publication_request_identity_conflict" in identity_conflict.stderr

    source_conflict = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            f"{_function_call('sophia_request_ready_deck_quality_publication', {**replay_payload, 'p_source_pack_hash': '8' * 64})}; "
            "RESET ROLE;"
        ),
        check=False,
    )
    assert source_conflict.returncode != 0
    assert "deck_quality_publication_inputs_conflict" in source_conflict.stderr
    unchanged = _psql(
        postgres_db,
        (
            "SELECT state, source_pack_hash, deadline_at FROM "
            "public.sophia_deck_quality_publications WHERE quality_run_id = "
            f"{_sql_literal(request.quality_run_id)};"
        ),
    ).stdout.strip()
    assert unchanged == f"pending|{'4' * 64}|{original_deadline}"

    owner = "publication-worker"
    token = "publication-claim-token"
    publication_claim_hash = _claim_hash(owner, token, 60, 1)
    claimed = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT quality_run_id, lease_epoch FROM "
            "public.sophia_claim_deck_quality_publications("
            f"{_sql_literal(owner)}, {_sql_literal(token)}, "
            f"{_sql_literal(publication_claim_hash)}, 60, 1); RESET ROLE;"
        ),
    ).stdout.strip().split("|")
    assert claimed == [request.quality_run_id, "1"]

    operation_token = "publication-promote-token"
    operation_arguments = {
        "input_manifest_object_path": request.input_manifest_object_path,
        "input_manifest_hash": request.input_manifest_hash,
    }
    operation_hash = canonical_sha256(
        {
            "kind": "promote",
            "quality_run_id": request.quality_run_id,
            "lease_owner": owner,
            "lease_epoch": 1,
            "arguments": operation_arguments,
        }
    )
    promoted = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            "public.sophia_promote_deck_quality_publication("
            f"{_sql_literal(request.quality_run_id)}, {_sql_literal(owner)}, 1, "
            f"{_sql_literal(operation_token)}, {_sql_literal(operation_hash)}, "
            f"{_sql_literal(request.input_manifest_object_path)}, "
            f"{_sql_literal(request.input_manifest_hash)}); RESET ROLE;"
        ),
    ).stdout.strip()
    assert promoted == "published"

    provenance = _psql(
        postgres_db,
        (
            "SELECT publication.artifact_hash, quality.artifact_hash, "
            "quality.input_manifest_hash, quality.trace_deadline_at - quality.run_deadline_at "
            "FROM public.sophia_deck_quality_publications publication "
            "JOIN public.sophia_deck_quality_shadow_runs quality USING (quality_run_id) "
            f"WHERE quality_run_id = {_sql_literal(request.quality_run_id)};"
        ),
    ).stdout.strip()
    assert provenance == f"{'2' * 64}|{'2' * 64}|{'3' * 64}|00:02:00"


def test_real_postgres_claim_receipts_replay_empty_and_nonempty_and_cleanup_bounded(
    postgres_db: str,
) -> None:
    empty_sql = _claim_sql(owner="receipt-worker", token="empty-token")
    assert _psql(postgres_db, empty_sql).stdout.strip() == ""
    request = _request("empty-replay")
    _insert_quality(postgres_db, request)
    assert _psql(postgres_db, empty_sql).stdout.strip() == ""

    fresh_sql = _claim_sql(owner="receipt-worker", token="fresh-token")
    first_id = _psql(postgres_db, fresh_sql).stdout.strip()
    assert first_id == request.quality_run_id
    assert _psql(postgres_db, fresh_sql).stdout.strip() == first_id
    assert (
        _psql(
            postgres_db,
            _claim_sql(owner="different-worker", token="different-token"),
        ).stdout.strip()
        == ""
    )

    conflict = _psql(
        postgres_db,
        _claim_sql(
            owner="receipt-worker",
            token="fresh-token",
            lease_seconds=121,
        ),
        check=False,
    )
    assert conflict.returncode != 0
    assert "deck_quality_claim_conflict" in conflict.stderr

    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs "
            "SET lease_expires_at = statement_timestamp() - interval '1 second' "
            f"WHERE quality_run_id = {_sql_literal(first_id)};"
        ),
    )
    assert _psql(postgres_db, fresh_sql).stdout.strip() == ""
    reclaimed = _psql(
        postgres_db,
        _claim_sql(
            owner="reclaim-worker",
            token="reclaim-token",
            columns="quality_run_id, lease_epoch",
        ),
    ).stdout.strip()
    assert reclaimed == f"{first_id}|2"

    _psql(
        postgres_db,
        """
INSERT INTO public.sophia_deck_quality_shadow_claim_receipts (
    lease_owner, claim_token, claim_hash, lease_seconds, claim_limit,
    quality_run_ids, created_at
)
SELECT
    'old-worker-' || lpad(series::text, 3, '0'),
    'old-token-' || lpad(series::text, 3, '0'),
    repeat('a', 64), 120, 1, ARRAY[]::text[],
    statement_timestamp() - interval '2 hours' + series * interval '1 microsecond'
FROM generate_series(1, 101) AS series;
""",
    )
    _psql(
        postgres_db,
        _claim_sql(owner="cleanup-worker", token="cleanup-token"),
    )
    cleanup = _psql(
        postgres_db,
        """
SELECT count(*), min(lease_owner), max(lease_owner)
FROM public.sophia_deck_quality_shadow_claim_receipts
WHERE lease_owner LIKE 'old-worker-%';
""",
    ).stdout.strip()
    assert cleanup == "1|old-worker-101|old-worker-101"
    index_definition = _psql(
        postgres_db,
        """
SELECT indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'sophia_deck_quality_shadow_claim_receipt_cleanup_idx';
""",
    ).stdout.strip()
    assert "(created_at, lease_owner, claim_token)" in index_definition


def test_real_postgres_batch_order_and_two_connections_never_duplicate_claims(
    postgres_db: str,
) -> None:
    for index in range(4):
        _insert_quality(
            postgres_db,
            _request(f"concurrent-{index}", artifact_hash=f"{index + 4:x}" * 64),
        )

    expected = _psql(
        postgres_db,
        """
SELECT quality_run_id FROM public.sophia_deck_quality_shadow_runs
ORDER BY next_attempt_at, requested_at, quality_run_id LIMIT 2;
""",
    ).stdout.strip().splitlines()
    batch_owner = "batch-worker"
    batch_token = "batch-token"
    batch = _psql(
        postgres_db,
        _claim_sql(
            owner=batch_owner,
            token=batch_token,
            limit=2,
        ),
    ).stdout.strip().splitlines()
    assert batch == expected
    assert len(batch) == 2
    assert len(set(batch)) == 2
    assert (
        _psql(
            postgres_db,
            _claim_sql(
                owner=batch_owner,
                token=batch_token,
                limit=2,
            ),
        ).stdout.strip().splitlines()
        == batch
    )
    receipt_order = _psql(
        postgres_db,
        (
            "SELECT array_to_string(quality_run_ids, ',') "
            "FROM public.sophia_deck_quality_shadow_claim_receipts "
            f"WHERE lease_owner = {_sql_literal(batch_owner)} "
            f"AND claim_token = {_sql_literal(batch_token)};"
        ),
    ).stdout.strip()
    assert receipt_order == ",".join(batch)

    claim_a = _claim_sql(owner="connection-a", token="connection-a-token")
    claim_b = _claim_sql(owner="connection-b", token="connection-b-token")
    process_a = subprocess.Popen(  # noqa: S603
        _psql_command(postgres_db) + ["-c", f"BEGIN; {claim_a} SELECT pg_sleep(1); COMMIT;"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    time.sleep(0.1)
    process_b = subprocess.Popen(  # noqa: S603
        _psql_command(postgres_db) + ["-c", claim_b],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    output_b, error_b = process_b.communicate(timeout=10)
    output_a, error_a = process_a.communicate(timeout=10)
    assert process_a.returncode == 0, error_a
    assert process_b.returncode == 0, error_b
    ids_a = [line for line in output_a.splitlines() if line.startswith("quality_")]
    ids_b = [line for line in output_b.splitlines() if line.startswith("quality_")]
    assert len(ids_a) == len(ids_b) == 1
    assert ids_a[0] != ids_b[0]
    assert set(batch + ids_a + ids_b) == {
        line
        for line in _psql(
            postgres_db,
            "SELECT quality_run_id FROM public.sophia_deck_quality_shadow_runs;",
        ).stdout.splitlines()
        if line
    }


def test_real_postgres_prepared_success_reclaims_after_run_deadline_with_exact_old_root(
    postgres_db: str,
) -> None:
    request = _request("success-reack", artifact_hash="b" * 64)
    run_id = _insert_quality(postgres_db, request)
    first_owner = "success-finalizer-a"
    first_claim = _psql(
        postgres_db,
        _claim_sql(
            owner=first_owner,
            token="success-first-token",
            columns="quality_run_id, lease_epoch, attempt_count",
        ),
    ).stdout.strip()
    assert first_claim == f"{run_id}|1|1"

    evidence_path = request.input_manifest_object_path.replace(
        "/input_bundle/manifest.json",
        "/evidence_manifest.json",
    )
    decision_hash = "9" * 64
    _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs "
            "SET stage = 'adjudicated', stage_rank = 60, "
            f"evidence_manifest_object_path = {_sql_literal(evidence_path)}, "
            f"evidence_manifest_hash = {_sql_literal('8' * 64)}, "
            "stage_artifact_hashes = jsonb_build_object("
            f"'decision', {_sql_literal(decision_hash)}) "
            f"WHERE quality_run_id = {_sql_literal(run_id)};"
        ),
    )

    persisted_root = _safe_root(request)
    persisted_root_hash = safe_trace_root_input_hash(persisted_root)
    trace_ids = _trace_ids("success-reack")
    safe_metrics = {"evaluated_slide_count": 5}
    stage_hashes = {
        "decision": decision_hash,
        "safe_metrics": "c" * 64,
        "run": "d" * 64,
    }

    def prepare_call(root: Mapping[str, object]) -> str:
        return (
            "public.sophia_prepare_deck_quality_shadow_completion("
            f"{_sql_literal(run_id)}, {_sql_literal(current_owner)}, {current_epoch}, "
            "'satisfied', ARRAY[]::text[], 4.5, "
            f"{_sql_literal(safe_metrics)}, {_sql_literal(trace_ids)}, "
            f"{_sql_literal(stage_hashes)}, {_sql_literal(root)}, "
            f"{_sql_literal(safe_trace_root_input_hash(root))})"
        )

    current_owner = first_owner
    current_epoch = 1
    first_prepared = _psql(
        postgres_db,
        (
            "SELECT state, safe_trace_root_input_hash, trace_ids::text, "
            f"attempt_count FROM {prepare_call(persisted_root)};"
        ),
    ).stdout.strip().split("|")
    assert first_prepared[0] == "finalizing"
    assert first_prepared[1] == persisted_root_hash
    persisted_trace_json = first_prepared[2]
    assert first_prepared[3] == "1"

    _psql(
        postgres_db,
        f"""
WITH stamp AS (SELECT statement_timestamp() AS now_at)
UPDATE public.sophia_deck_quality_shadow_runs AS run
SET requested_at = stamp.now_at - interval '10 minutes',
    run_deadline_at = stamp.now_at - interval '1 second',
    trace_deadline_at = stamp.now_at + interval '119 seconds',
    next_attempt_at = stamp.now_at - interval '1 second',
    lease_expires_at = stamp.now_at - interval '1 millisecond',
    updated_at = stamp.now_at
FROM stamp
WHERE run.quality_run_id = {_sql_literal(run_id)};
""",
    )

    second_owner = "success-finalizer-b"
    current_owner = second_owner
    current_epoch = 2
    second_claim = _psql(
        postgres_db,
        _claim_sql(
            owner=second_owner,
            token="success-second-token",
            columns=(
                "quality_run_id, lease_epoch, attempt_count, "
                "(run_deadline_at < statement_timestamp())::text, "
                "(statement_timestamp() <= trace_deadline_at)::text, "
                "safe_trace_root_input_hash, trace_ids::text"
            ),
        ),
    ).stdout.strip().split("|")
    assert second_claim[:6] == [
        run_id,
        "2",
        "1",
        "true",
        "true",
        persisted_root_hash,
    ]
    assert second_claim[6] == persisted_trace_json

    # A separate stale connection cannot ACK the old epoch after connection B
    # reclaims the prepared success.
    stale_process = subprocess.Popen(  # noqa: S603
        _psql_command(postgres_db)
        + [
            "-c",
            (
                "SELECT quality_run_id FROM "
                "public.sophia_complete_deck_quality_shadow_after_trace("
                f"{_sql_literal(run_id)}, {_sql_literal(first_owner)}, 1);"
            ),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    _stale_output, stale_error = stale_process.communicate(timeout=10)
    assert stale_process.returncode != 0
    assert "deck_quality_lease_stale" in stale_error

    changed_runtime_root = dict(persisted_root)
    changed_runtime_root["source_commit_sha"] = "4" * 40
    changed_runtime_root["gateway_deployed_sha"] = "5" * 40
    changed_runtime_root["langgraph_deployed_sha"] = "6" * 40
    changed_replay = _psql(
        postgres_db,
        f"SELECT quality_run_id FROM {prepare_call(changed_runtime_root)};",
        check=False,
    )
    assert changed_replay.returncode != 0
    assert "deck_quality_prepare_completion_replay_not_idempotent" in changed_replay.stderr

    exact_replay = _psql(
        postgres_db,
        (
            "SELECT state, safe_trace_root_input_hash, trace_ids::text, "
            "attempt_count, (run_deadline_at < statement_timestamp())::text, "
            f"(statement_timestamp() <= trace_deadline_at)::text "
            f"FROM {prepare_call(persisted_root)};"
        ),
    ).stdout.strip().split("|")
    assert exact_replay == [
        "finalizing",
        persisted_root_hash,
        persisted_trace_json,
        "1",
        "true",
        "true",
    ]

    completed = _psql(
        postgres_db,
        (
            "SELECT state, safe_trace_root_input_hash, trace_ids::text, "
            "attempt_count, completion_owner, completion_token "
            "FROM public.sophia_complete_deck_quality_shadow_after_trace("
            f"{_sql_literal(run_id)}, {_sql_literal(second_owner)}, 2);"
        ),
    ).stdout.strip().split("|")
    assert completed == [
        "completed",
        persisted_root_hash,
        persisted_trace_json,
        "1",
        second_owner,
        "2",
    ]


def test_real_postgres_deadline_grace_requires_ack_and_preserves_failure_precursor(
    postgres_db: str,
) -> None:
    request = _request("deadline")
    run_id = _insert_quality(postgres_db, request)
    _psql(
        postgres_db,
        f"""
WITH stamp AS (SELECT statement_timestamp() AS now_at)
UPDATE public.sophia_deck_quality_shadow_runs AS run
SET requested_at = stamp.now_at - interval '10 minutes',
    run_deadline_at = stamp.now_at - interval '1 second',
    trace_deadline_at = stamp.now_at + interval '119 seconds',
    next_attempt_at = stamp.now_at - interval '1 second',
    updated_at = stamp.now_at
FROM stamp
WHERE run.quality_run_id = {_sql_literal(run_id)};
""",
    )

    owner = "deadline-tracer"
    token = "deadline-token"
    precursor = _psql(
        postgres_db,
        _claim_sql(
            owner=owner,
            token=token,
            columns=(
                "quality_run_id, state, pending_terminal_state, "
                "last_error_code, last_error_stage, attempt_count, lease_epoch, "
                "(lease_expires_at > run_deadline_at)::text, "
                "(lease_expires_at <= trace_deadline_at)::text"
            ),
        ),
    ).stdout.strip().split("|")
    assert precursor == [
        run_id,
        "finalizing",
        "failed",
        "run_deadline_exceeded",
        "run_deadline",
        "0",
        "1",
        "true",
        "true",
    ]

    terminal_without_ack = _psql(
        postgres_db,
        (
            "UPDATE public.sophia_deck_quality_shadow_runs "
            "SET state = 'failed', finished_at = statement_timestamp() "
            f"WHERE quality_run_id = {_sql_literal(run_id)};"
        ),
        check=False,
    )
    assert terminal_without_ack.returncode != 0

    checkpoint_after_deadline = _psql(
        postgres_db,
        (
            "SELECT quality_run_id FROM public.sophia_checkpoint_deck_quality_shadow_run("
            f"{_sql_literal(run_id)}, {_sql_literal(owner)}, 1, 'snapshot_loaded', "
            "'{}'::jsonb, '{}'::jsonb, jsonb_build_object('source_snapshot', repeat('a', 64)), "
            f"{_sql_literal(request.input_manifest_object_path.replace('/input_bundle/manifest.json', '/evidence_manifest.json'))}, "
            f"{_sql_literal('a' * 64)});"
        ),
        check=False,
    )
    assert checkpoint_after_deadline.returncode != 0
    assert "deck_quality_lease_stale" in checkpoint_after_deadline.stderr

    root = _safe_root(request)
    root_hash = safe_trace_root_input_hash(root)
    payload_hash = "d" * 64
    prepare_payload = {
        "p_quality_run_id": run_id,
        "p_lease_owner": owner,
        "p_lease_epoch": 1,
        "p_terminal_state": "failed",
        "p_error_code": "run_deadline_exceeded",
        "p_error_stage": "run_deadline",
        "p_terminal_trace_payload_hash": payload_hash,
        "p_safe_trace_root_input": root,
        "p_safe_trace_root_input_hash": root_hash,
    }
    prepare_call = _function_call(
        "sophia_prepare_deck_quality_shadow_failure_trace",
        prepare_payload,
    )
    prepared = _psql(
        postgres_db,
        (
            "SELECT pending_terminal_state, terminal_trace_payload_hash, "
            f"safe_trace_root_input_hash, error_count FROM {prepare_call};"
        ),
    ).stdout.strip()
    assert prepared == f"failed|{payload_hash}|{root_hash}|1"
    assert (
        _psql(
            postgres_db,
            (
                "SELECT pending_terminal_state, terminal_trace_payload_hash, "
                f"safe_trace_root_input_hash, error_count FROM {prepare_call};"
            ),
        ).stdout.strip()
        == prepared
    )

    conflicting_prepare = dict(prepare_payload)
    conflicting_prepare["p_terminal_trace_payload_hash"] = "e" * 64
    conflict = _psql(
        postgres_db,
        f"SELECT quality_run_id FROM {_function_call('sophia_prepare_deck_quality_shadow_failure_trace', conflicting_prepare)};",
        check=False,
    )
    assert conflict.returncode != 0
    assert "deck_quality_failure_trace_precursor_conflict" in conflict.stderr

    released = _psql(
        postgres_db,
        (
            "SELECT pending_terminal_state, terminal_trace_payload_hash, "
            "safe_trace_root_input_hash, last_error_code, last_error_stage "
            "FROM public.sophia_release_deck_quality_shadow_lease("
            f"{_sql_literal(run_id)}, {_sql_literal(owner)}, 1);"
        ),
    ).stdout.strip()
    assert released == (
        f"failed|{payload_hash}|{root_hash}|run_deadline_exceeded|run_deadline"
    )

    retry_owner = "deadline-retry"
    retry_claim = _psql(
        postgres_db,
        _claim_sql(
            owner=retry_owner,
            token="deadline-retry-token",
            columns="quality_run_id, lease_epoch",
        ),
    ).stdout.strip()
    assert retry_claim == f"{run_id}|2"
    retried = _psql(
        postgres_db,
        (
            "SELECT pending_terminal_state, terminal_trace_payload_hash, "
            "safe_trace_root_input_hash, last_error_code, last_error_stage, error_count "
            "FROM public.sophia_retry_deck_quality_shadow_run("
            f"{_sql_literal(run_id)}, {_sql_literal(retry_owner)}, 2, "
            "'judge_unavailable', 'blind_assessed', 0, 5);"
        ),
    ).stdout.strip()
    assert retried == (
        f"failed|{payload_hash}|{root_hash}|run_deadline_exceeded|run_deadline|1"
    )

    final_owner = "deadline-final"
    final_claim = _psql(
        postgres_db,
        _claim_sql(
            owner=final_owner,
            token="deadline-final-token",
            columns="quality_run_id, lease_epoch",
        ),
    ).stdout.strip()
    assert final_claim == f"{run_id}|3"
    wrong_finish = _psql(
        postgres_db,
        (
            "SELECT quality_run_id FROM public.sophia_finish_deck_quality_shadow_run("
            f"{_sql_literal(run_id)}, {_sql_literal(final_owner)}, 3, 'failed', "
            f"{_sql_literal('e' * 64)}, NULL, ARRAY[]::text[], NULL, "
            "'run_deadline_exceeded', 'run_deadline', '{}'::jsonb, "
            f"{_sql_literal(_trace_ids('deadline'))}, '{{}}'::jsonb);"
        ),
        check=False,
    )
    assert wrong_finish.returncode != 0
    assert "deck_quality_terminal_precursor_conflict" in wrong_finish.stderr

    trace_ids = _trace_ids("deadline")
    finished = _psql(
        postgres_db,
        (
            "SELECT state, pending_terminal_state, terminal_trace_payload_hash, "
            "safe_trace_root_input_hash, last_error_code, last_error_stage, "
            "error_count, (finished_at IS NOT NULL)::text "
            "FROM public.sophia_finish_deck_quality_shadow_run("
            f"{_sql_literal(run_id)}, {_sql_literal(final_owner)}, 3, 'failed', "
            f"{_sql_literal(payload_hash)}, NULL, ARRAY[]::text[], NULL, "
            "'run_deadline_exceeded', 'run_deadline', '{}'::jsonb, "
            f"{_sql_literal(trace_ids)}, '{{}}'::jsonb);"
        ),
    ).stdout.strip()
    assert finished == (
        f"failed|failed|{payload_hash}|{root_hash}|run_deadline_exceeded|"
        "run_deadline|1|true"
    )
    assert (
        _psql(
            postgres_db,
            _claim_sql(owner="terminal-reclaim", token="terminal-reclaim-token"),
        ).stdout.strip()
        == ""
    )

    grace_request = _request("grace-expired", artifact_hash="a" * 64)
    grace_id = _insert_quality(postgres_db, grace_request)
    _psql(
        postgres_db,
        f"""
WITH stamp AS (SELECT statement_timestamp() AS now_at)
UPDATE public.sophia_deck_quality_shadow_runs AS run
SET requested_at = stamp.now_at - interval '10 minutes',
    run_deadline_at = stamp.now_at - interval '3 minutes',
    trace_deadline_at = stamp.now_at - interval '1 minute',
    next_attempt_at = stamp.now_at - interval '3 minutes',
    updated_at = stamp.now_at
FROM stamp
WHERE run.quality_run_id = {_sql_literal(grace_id)};
""",
    )
    assert (
        _psql(
            postgres_db,
            _claim_sql(owner="after-grace", token="after-grace-token"),
        ).stdout.strip()
        == ""
    )
    after_grace = _psql(
        postgres_db,
        (
            "SELECT state, pending_terminal_state, terminal_trace_payload_hash, "
            "safe_trace_root_input_hash, lease_owner, finished_at "
            "FROM public.sophia_deck_quality_shadow_runs "
            f"WHERE quality_run_id = {_sql_literal(grace_id)};"
        ),
    ).stdout.strip()
    assert after_grace == "finalizing|failed||||"

    _psql(
        postgres_db,
        f"""
UPDATE public.sophia_deck_quality_shadow_runs
SET lease_epoch = 1,
    dispatch_intent_epoch = 1,
    dispatch_intent_attempt_count = 0,
    dispatch_intent_token = 'dq1-dispatch:trace-grace-recovery',
    dispatch_intent_status = 'unresolved',
    dispatch_intent_at = statement_timestamp()
WHERE quality_run_id = {_sql_literal(grace_id)};
""",
    )
    unresolved_before = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT quality_run_id FROM "
            "public.sophia_list_unresolved_deck_quality_shadow_dispatches(100) "
            f"WHERE quality_run_id = {_sql_literal(grace_id)}; RESET ROLE;"
        ),
    ).stdout.strip()
    assert unresolved_before == grace_id

    recovered_count = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT "
            "public.sophia_recover_expired_deck_quality_shadow_runs(100); "
            "RESET ROLE;"
        ),
    ).stdout.strip()
    assert recovered_count == "1"
    recovered = _psql(
        postgres_db,
        (
            "SELECT state, pending_terminal_state, terminal_trace_payload_hash, "
            "safe_trace_root_input_hash, lease_owner, "
            "last_error_code, last_error_stage, "
            "finished_at >= trace_deadline_at "
            "FROM public.sophia_deck_quality_shadow_runs "
            f"WHERE quality_run_id = {_sql_literal(grace_id)};"
        ),
    ).stdout.strip()
    assert recovered == (
        "failed|failed||||run_deadline_exceeded|run_deadline|t"
    )
    assert (
        _psql(
            postgres_db,
            (
                "SET ROLE service_role; SELECT "
                "public.sophia_recover_expired_deck_quality_shadow_runs(100); "
                "SELECT quality_run_id FROM "
                "public.sophia_list_unresolved_deck_quality_shadow_dispatches(100) "
                f"WHERE quality_run_id = {_sql_literal(grace_id)}; RESET ROLE;"
            ),
        ).stdout.strip()
        == "0"
    )

    ordinary_terminal_incomplete = _psql(
        postgres_db,
        """
SELECT count(*) FROM public.sophia_deck_quality_shadow_runs
WHERE state IN ('completed', 'failed', 'stale')
  AND NOT (
      state IN ('failed', 'stale')
      AND finished_at >= trace_deadline_at
  )
  AND (
      safe_trace_root_input IS NULL
      OR safe_trace_root_input_hash IS NULL
      OR NOT (trace_ids ?& ARRAY[
          'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
          'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
          'mechanical_projection_run_id', 'plan_realization_run_id',
          'adjudicate_run_id', 'shadow_persist_run_id'
      ])
);
""",
    ).stdout.strip()
    assert ordinary_terminal_incomplete == "0"
    recovered_terminal_incomplete = _psql(
        postgres_db,
        """
SELECT count(*) FROM public.sophia_deck_quality_shadow_runs
WHERE state IN ('failed', 'stale')
  AND finished_at >= trace_deadline_at
  AND (
      safe_trace_root_input IS NULL
      OR safe_trace_root_input_hash IS NULL
      OR NOT (trace_ids ?& ARRAY[
          'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
          'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
          'mechanical_projection_run_id', 'plan_realization_run_id',
          'adjudicate_run_id', 'shadow_persist_run_id'
      ])
  );
""",
    ).stdout.strip()
    assert recovered_terminal_incomplete == "1"
