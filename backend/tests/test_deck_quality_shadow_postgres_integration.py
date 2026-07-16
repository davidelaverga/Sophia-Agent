from __future__ import annotations

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
_MIGRATIONS = (
    _BACKEND / "migrations" / "2026_07_15_sophia_deck_quality_shadow_runs.sql",
    _BACKEND / "migrations" / "2026_07_16_sophia_deck_quality_publications.sql",
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


@pytest.fixture
def postgres_db() -> Iterator[str]:
    database = f"dq1_it_{uuid.uuid4().hex[:16]}"
    role_sql = """
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
"""
    _psql("postgres", role_sql)
    _psql("postgres", f'CREATE DATABASE "{database}"')
    try:
        for migration in _MIGRATIONS:
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
  has_function_privilege('service_role', 'public.sophia_deck_quality_safe_trace_root_valid(jsonb,text)', 'EXECUTE');
""",
    ).stdout.strip()
    assert acl == "f|f|t|f|f|f"

    request = _request(
        "publication",
        artifact_hash="2" * 64,
        input_manifest_hash="3" * 64,
    )
    payload = request.rpc_payload()
    publication_deadline = datetime.now(UTC) + timedelta(minutes=2)
    publication_payload: dict[str, object] = {
        key: value
        for key, value in payload.items()
        if key not in {
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
            "p_deadline_at": publication_deadline,
            "p_quality_max_attempts": 5,
            "p_quality_run_deadline_at": publication_deadline
            + timedelta(minutes=12),
        }
    )
    publication_call = _function_call(
        "sophia_request_deck_quality_publication",
        publication_payload,
    )
    requested = _psql(
        postgres_db,
        f"SET ROLE service_role; SELECT quality_run_id, state FROM {publication_call}; RESET ROLE;",
    ).stdout.strip()
    assert requested == f"{request.quality_run_id}|awaiting_inputs"

    source_hash = "4" * 64
    source_path = request.input_manifest_object_path.replace(
        "input_bundle/manifest.json",
        f"publication/source_pack/{source_hash}.json",
    )
    committed = _psql(
        postgres_db,
        (
            "SET ROLE service_role; SELECT state FROM "
            "public.sophia_commit_deck_quality_publication_inputs("
            f"{_sql_literal(request.quality_run_id)}, {_sql_literal(source_path)}, "
            f"{_sql_literal(source_hash)}); RESET ROLE;"
        ),
    ).stdout.strip()
    assert committed == "pending"

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

    terminal_incomplete = _psql(
        postgres_db,
        """
SELECT count(*) FROM public.sophia_deck_quality_shadow_runs
WHERE state IN ('completed', 'failed', 'stale')
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
    assert terminal_incomplete == "0"
