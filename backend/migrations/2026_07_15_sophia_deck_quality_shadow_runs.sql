-- DQ-1 durable canary-only rendered deck quality request/outbox.
--
-- This table is an internal observation record. It never owns or mutates the
-- accepted artifact. Raw prompts, rendered image bytes, creative/design plans,
-- memory, provider payloads, and exception text are deliberately absent.

BEGIN;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_safe_metrics_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_key TEXT;
    v_metric JSONB;
    v_count INTEGER := 0;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' OR pg_column_size(p_value) > 8192 THEN
        RETURN false;
    END IF;
    FOR v_key, v_metric IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
        v_count := v_count + 1;
        IF v_count > 64
           OR v_key !~ '^[a-z][a-z0-9_]{0,63}$'
           OR v_key ~ '(raw|prompt|image|plan|memory|credential|secret|authorization|provider_payload|exception)'
           OR (v_key ~ 'token' AND v_key !~ '(_tokens|_token_count)$')
           OR jsonb_typeof(v_metric) NOT IN ('number', 'boolean', 'null') THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_hash_map_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_key TEXT;
    v_hash JSONB;
    v_count INTEGER := 0;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' OR pg_column_size(p_value) > 4096 THEN
        RETURN false;
    END IF;
    FOR v_key, v_hash IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
        v_count := v_count + 1;
        IF v_count > 32
           OR v_key !~ '^[a-z][a-z0-9_.-]{0,63}$'
           OR jsonb_typeof(v_hash) <> 'string'
           OR (v_hash #>> '{}') !~ '^[0-9a-f]{64}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN v_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_version_map_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_key TEXT;
    v_version JSONB;
    v_text TEXT;
    v_count INTEGER := 0;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' OR pg_column_size(p_value) > 4096 THEN
        RETURN false;
    END IF;
    FOR v_key, v_version IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
        v_count := v_count + 1;
        v_text := v_version #>> '{}';
        IF v_count > 32
           OR v_key !~ '^[a-z][a-z0-9_.-]{0,63}$'
           OR jsonb_typeof(v_version) <> 'string'
           OR v_text !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN v_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_stage_hashes_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_key TEXT;
    v_hash JSONB;
    v_count INTEGER := 0;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' OR pg_column_size(p_value) > 4096 THEN
        RETURN false;
    END IF;
    FOR v_key, v_hash IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
        v_count := v_count + 1;
        IF v_count > 10
           OR v_key NOT IN (
               'run',
               'source_snapshot',
               'evidence_manifest',
               'assessment_a_visual',
               'assessment_a_call_intent',
               'assessment_b_mechanical',
               'assessment_c_plan_realization',
               'assessment_c_call_intent',
               'decision',
               'safe_metrics'
           )
           OR jsonb_typeof(v_hash) <> 'string'
           OR (v_hash #>> '{}') !~ '^[0-9a-f]{64}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_trace_ids_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_key TEXT;
    v_trace_id JSONB;
    v_text TEXT;
    v_count INTEGER := 0;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'object' OR pg_column_size(p_value) > 8192 THEN
        RETURN false;
    END IF;
    FOR v_key, v_trace_id IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
        v_count := v_count + 1;
        v_text := v_trace_id #>> '{}';
        IF v_count > 32
           OR v_key !~ '^[a-z][a-z0-9_]{0,63}_(trace|run)_id$'
           OR jsonb_typeof(v_trace_id) <> 'string'
           OR v_text !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_codes_valid(p_value TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_code TEXT;
    v_distinct_count INTEGER;
BEGIN
    IF p_value IS NULL OR cardinality(p_value) > 64 OR array_position(p_value, NULL) IS NOT NULL THEN
        RETURN false;
    END IF;
    FOREACH v_code IN ARRAY p_value
    LOOP
        IF v_code !~ '^[a-z][a-z0-9_]{0,127}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    SELECT count(DISTINCT code) INTO v_distinct_count FROM unnest(p_value) AS codes(code);
    IF v_distinct_count <> cardinality(p_value) THEN
        RETURN false;
    END IF;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_safe_path_segment(
    p_value TEXT,
    p_default TEXT
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
    SELECT COALESCE(
        NULLIF(
            left(
                btrim(
                    regexp_replace(
                        replace(replace(btrim(p_value), E'\\', '/'), '/', '_'),
                        '[^A-Za-z0-9._=-]+',
                        '_',
                        'g'
                    ),
                    ' ._'
                ),
                128
            ),
            ''
        ),
        p_default
    );
$$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_safe_trace_root_valid(
    p_value JSONB,
    p_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
    v_key TEXT;
    v_count INTEGER;
    v_material TEXT;
BEGIN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) <> 'object'
       OR pg_column_size(p_value) > 8192
       OR p_hash IS NULL
       OR p_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN false;
    END IF;
    SELECT count(*) INTO v_count FROM jsonb_object_keys(p_value);
    IF v_count <> 23 OR NOT (p_value ?& ARRAY[
        'schema_version', 'campaign_id', 'quality_run_id', 'build_id',
        'task_id', 'builder_run_id', 'parent_builder_run_id',
        'parent_builder_trace_id', 'logical_artifact_id', 'artifact_version_id',
        'manifest_revision', 'artifact_hash', 'rubric_version', 'rubric_hash',
        'judge_deployment', 'judge_provider', 'judge_model',
        'judge_profile_version', 'judge_plan_hash',
        'evidence_preprocessor_version', 'source_commit_sha',
        'gateway_deployed_sha', 'langgraph_deployed_sha'
    ]) OR p_value ->> 'schema_version' <> 'deck-quality-safe-trace-root/v2'
       OR jsonb_typeof(p_value -> 'manifest_revision') <> 'number'
       OR p_value ->> 'manifest_revision' !~ '^[1-9][0-9]*$' THEN
        RETURN false;
    END IF;
    FOREACH v_key IN ARRAY ARRAY[
        'campaign_id', 'quality_run_id', 'build_id', 'task_id',
        'builder_run_id', 'parent_builder_run_id', 'parent_builder_trace_id',
        'logical_artifact_id', 'artifact_version_id', 'rubric_version',
        'judge_deployment', 'judge_provider', 'judge_model',
        'judge_profile_version', 'evidence_preprocessor_version'
    ]
    LOOP
        IF jsonb_typeof(p_value -> v_key) <> 'string'
           OR p_value ->> v_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY[
        'artifact_hash', 'rubric_hash', 'judge_plan_hash'
    ]
    LOOP
        IF jsonb_typeof(p_value -> v_key) <> 'string'
           OR p_value ->> v_key !~ '^[0-9a-f]{64}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY[
        'source_commit_sha', 'gateway_deployed_sha', 'langgraph_deployed_sha'
    ]
    LOOP
        IF jsonb_typeof(p_value -> v_key) <> 'string'
           OR p_value ->> v_key !~ '^[0-9a-f]{40}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    IF p_value ->> 'builder_run_id' IS DISTINCT FROM
       p_value ->> 'parent_builder_run_id' THEN
        RETURN false;
    END IF;
    v_material := concat_ws(chr(31),
        p_value ->> 'schema_version', p_value ->> 'campaign_id',
        p_value ->> 'quality_run_id', p_value ->> 'build_id',
        p_value ->> 'task_id', p_value ->> 'builder_run_id',
        p_value ->> 'parent_builder_run_id',
        p_value ->> 'parent_builder_trace_id',
        p_value ->> 'logical_artifact_id', p_value ->> 'artifact_version_id',
        p_value ->> 'manifest_revision', p_value ->> 'artifact_hash',
        p_value ->> 'rubric_version', p_value ->> 'rubric_hash',
        p_value ->> 'judge_deployment', p_value ->> 'judge_provider',
        p_value ->> 'judge_model', p_value ->> 'judge_profile_version',
        p_value ->> 'judge_plan_hash',
        p_value ->> 'evidence_preprocessor_version',
        p_value ->> 'source_commit_sha', p_value ->> 'gateway_deployed_sha',
        p_value ->> 'langgraph_deployed_sha'
    );
    RETURN p_hash = encode(sha256(convert_to(v_material, 'UTF8')), 'hex');
END;
$$;

CREATE TABLE IF NOT EXISTS public.sophia_deck_quality_shadow_runs (
    quality_run_id                    TEXT PRIMARY KEY
                                              CHECK (quality_run_id ~ '^quality_[0-9a-f]{64}$'),
    campaign_id                       TEXT NOT NULL
                                              CHECK (campaign_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
    scope_kind                        TEXT NOT NULL DEFAULT 'canary'
                                              CHECK (scope_kind = 'canary'),
    instrument_schema_version         TEXT NOT NULL CHECK (char_length(instrument_schema_version) BETWEEN 1 AND 128),
    instrument_identity_hash          TEXT NOT NULL
                                              CHECK (instrument_identity_hash ~ '^[0-9a-f]{64}$'),
    rubric_version                    TEXT NOT NULL CHECK (char_length(rubric_version) BETWEEN 1 AND 128),
    rubric_hash                       TEXT NOT NULL CHECK (rubric_hash ~ '^[0-9a-f]{64}$'),
    prompt_hashes                     JSONB NOT NULL
                                              CHECK (public.sophia_deck_quality_hash_map_valid(prompt_hashes)),
    judge_plan_hash                   TEXT NOT NULL CHECK (judge_plan_hash ~ '^[0-9a-f]{64}$'),
    judge_profile_version             TEXT NOT NULL CHECK (char_length(judge_profile_version) BETWEEN 1 AND 128),
    evidence_preprocessor_version     TEXT NOT NULL CHECK (char_length(evidence_preprocessor_version) BETWEEN 1 AND 128),
    judge_invoker_version             TEXT NOT NULL CHECK (char_length(judge_invoker_version) BETWEEN 1 AND 128),
    assessment_schema_versions        JSONB NOT NULL
                                              CHECK (public.sophia_deck_quality_version_map_valid(assessment_schema_versions)),
    adjudication_policy_hash          TEXT NOT NULL CHECK (adjudication_policy_hash ~ '^[0-9a-f]{64}$'),

    user_id                            TEXT NOT NULL CHECK (
                                              char_length(user_id) BETWEEN 1 AND 256
                                              AND user_id = public.sophia_deck_quality_safe_path_segment(user_id, 'user')
                                          ),
    thread_id                          TEXT NOT NULL CHECK (
                                              char_length(thread_id) BETWEEN 1 AND 256
                                              AND thread_id = public.sophia_deck_quality_safe_path_segment(thread_id, 'thread')
                                          ),
    task_id                            TEXT CHECK (task_id IS NULL OR char_length(task_id) BETWEEN 1 AND 256),
    build_id                           TEXT NOT NULL CHECK (
                                              build_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                                              AND build_id = public.sophia_deck_quality_safe_path_segment(build_id, 'build')
                                          ),
    builder_run_id                     TEXT CHECK (builder_run_id IS NULL OR char_length(builder_run_id) BETWEEN 1 AND 256),
    parent_builder_trace_id            TEXT CHECK (
                                              parent_builder_trace_id IS NULL
                                              OR parent_builder_trace_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$'
                                          ),
    logical_artifact_id                TEXT NOT NULL CHECK (char_length(logical_artifact_id) BETWEEN 1 AND 256),
    artifact_version_id                TEXT NOT NULL CHECK (char_length(artifact_version_id) BETWEEN 1 AND 256),
    manifest_revision                  BIGINT NOT NULL CHECK (manifest_revision >= 1),
    artifact_hash                      TEXT NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
    input_manifest_object_path         TEXT NOT NULL CHECK (
                                              input_manifest_object_path LIKE '%.builder/builds/%/quality/%/input_bundle/manifest.json'
                                              AND char_length(input_manifest_object_path) <= 4096
                                          ),
    input_manifest_hash                TEXT NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    evidence_manifest_object_path      TEXT CHECK (
                                              evidence_manifest_object_path IS NULL
                                              OR (
                                                  evidence_manifest_object_path LIKE '%.builder/builds/%/quality/%/evidence_manifest.json'
                                                  AND char_length(evidence_manifest_object_path) <= 4096
                                              )
                                          ),
    evidence_manifest_hash             TEXT CHECK (
                                              evidence_manifest_hash IS NULL
                                              OR evidence_manifest_hash ~ '^[0-9a-f]{64}$'
                                          ),

    state                              TEXT NOT NULL DEFAULT 'pending'
                                              CHECK (state IN ('pending', 'running', 'retry_wait', 'finalizing', 'completed', 'failed', 'stale')),
    stage                              TEXT NOT NULL DEFAULT 'requested',
    stage_rank                         SMALLINT NOT NULL DEFAULT 0,
    attempt_count                      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts                       INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
    error_count                        INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
    next_attempt_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    run_deadline_at                    TIMESTAMPTZ NOT NULL,
    trace_deadline_at                  TIMESTAMPTZ NOT NULL,
    lease_owner                        TEXT,
    lease_epoch                        BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at                   TIMESTAMPTZ,
    claim_token                        TEXT CHECK (
                                              claim_token IS NULL
                                              OR claim_token ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
                                          ),
    claim_hash                         TEXT CHECK (
                                              claim_hash IS NULL
                                              OR claim_hash ~ '^[0-9a-f]{64}$'
                                          ),
    pending_terminal_state             TEXT CHECK (
                                              pending_terminal_state IS NULL
                                              OR pending_terminal_state IN ('failed', 'stale')
                                          ),
    terminal_trace_payload_hash        TEXT CHECK (
                                              terminal_trace_payload_hash IS NULL
                                              OR terminal_trace_payload_hash ~ '^[0-9a-f]{64}$'
                                          ),
    safe_trace_root_input               JSONB,
    safe_trace_root_input_hash          TEXT CHECK (
                                              safe_trace_root_input_hash IS NULL
                                              OR safe_trace_root_input_hash ~ '^[0-9a-f]{64}$'
                                          ),
    completion_owner                   TEXT CHECK (
                                              completion_owner IS NULL
                                              OR completion_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
                                          ),
    completion_token                   BIGINT CHECK (
                                              completion_token IS NULL OR completion_token >= 1
                                          ),
    last_error_code                    TEXT CHECK (
                                              last_error_code IS NULL OR last_error_code IN (
                                                  'judge_unavailable',
                                                  'coverage_error',
                                                  'structured_output_invalid',
                                                  'artifact_snapshot_stale',
                                                  'quality_persistence_error',
                                                  'shadow_dispatch_unavailable',
                                                  'run_deadline_exceeded',
                                                  'attempt_limit_exhausted'
                                              )
                                          ),
    last_error_stage                   TEXT CHECK (
                                              last_error_stage IS NULL OR last_error_stage ~ '^[a-z][a-z0-9_]{0,63}$'
                                          ),
    last_error_at                      TIMESTAMPTZ,
    decision_result                    TEXT CHECK (
                                              decision_result IS NULL OR decision_result IN (
                                                  'failed_to_judge',
                                                  'mechanically_invalid',
                                                  'needs_revision',
                                                  'needs_user_review',
                                                  'satisfied'
                                              )
                                          ),
    decision_failure_codes             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
                                              CHECK (public.sophia_deck_quality_codes_valid(decision_failure_codes)),
    decision_weighted_score            NUMERIC(8, 6)
                                              CHECK (decision_weighted_score IS NULL OR decision_weighted_score BETWEEN 0 AND 5),
    safe_metrics                       JSONB NOT NULL DEFAULT '{}'::JSONB
                                              CHECK (public.sophia_deck_quality_safe_metrics_valid(safe_metrics)),
    trace_ids                          JSONB NOT NULL DEFAULT '{}'::JSONB
                                              CHECK (public.sophia_deck_quality_trace_ids_valid(trace_ids)),
    stage_artifact_hashes               JSONB NOT NULL DEFAULT '{}'::JSONB
                                              CHECK (public.sophia_deck_quality_stage_hashes_valid(stage_artifact_hashes)),
    requested_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at                         TIMESTAMPTZ,
    updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at                        TIMESTAMPTZ,

    UNIQUE (artifact_version_id, campaign_id, instrument_identity_hash),
    CHECK (
        (stage = 'requested' AND stage_rank = 0)
        OR (stage = 'snapshot_loaded' AND stage_rank = 10)
        OR (stage = 'evidence_prepared' AND stage_rank = 20)
        OR (stage = 'blind_assessed' AND stage_rank = 30)
        OR (stage = 'mechanical_projected' AND stage_rank = 40)
        OR (stage = 'plan_realization_assessed' AND stage_rank = 50)
        OR (stage = 'adjudicated' AND stage_rank = 60)
        OR (stage = 'persisted_and_traced' AND stage_rank = 70)
    ),
    CHECK ((evidence_manifest_object_path IS NULL) = (evidence_manifest_hash IS NULL)),
    CHECK (
        input_manifest_object_path =
            'artifacts/' || public.sophia_deck_quality_safe_path_segment(user_id, 'user') ||
            '/' || public.sophia_deck_quality_safe_path_segment(thread_id, 'thread') ||
            '/foundation/.builder/builds/' || build_id || '/quality/' || quality_run_id ||
            '/input_bundle/manifest.json'
    ),
    CHECK (
        (stage_rank = 0 AND evidence_manifest_object_path IS NULL)
        OR (stage_rank >= 10 AND evidence_manifest_object_path IS NOT NULL)
    ),
    CHECK (
        (
            state = 'running'
            AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND claim_token IS NOT NULL
            AND claim_hash IS NOT NULL
        )
        OR (
            state = 'finalizing'
            AND (
                (
                    lease_owner IS NOT NULL
                    AND lease_expires_at IS NOT NULL
                    AND claim_token IS NOT NULL
                    AND claim_hash IS NOT NULL
                )
                OR (
                    lease_owner IS NULL
                    AND lease_expires_at IS NULL
                    AND claim_token IS NULL
                    AND claim_hash IS NULL
                )
            )
        )
        OR (
            state NOT IN ('running', 'finalizing')
            AND lease_owner IS NULL
            AND lease_expires_at IS NULL
            AND claim_token IS NULL
            AND claim_hash IS NULL
        )
    ),
    CHECK (
        (state IN ('completed', 'failed', 'stale') AND finished_at IS NOT NULL)
        OR (state NOT IN ('completed', 'failed', 'stale') AND finished_at IS NULL)
    ),
    CHECK (attempt_count <= max_attempts),
    CHECK (isfinite(run_deadline_at)),
    CHECK (run_deadline_at > requested_at),
    CHECK (run_deadline_at <= requested_at + interval '15 minutes'),
    CHECK (isfinite(trace_deadline_at)),
    CHECK (trace_deadline_at = run_deadline_at + interval '2 minutes'),
    CHECK (
        next_attempt_at <= CASE
            WHEN state = 'finalizing' THEN trace_deadline_at
            ELSE run_deadline_at
        END
    ),
    CHECK (
        lease_expires_at IS NULL
        OR lease_expires_at <= CASE
            WHEN state = 'finalizing' THEN trace_deadline_at
            ELSE run_deadline_at
        END
    ),
    CHECK ((completion_owner IS NULL) = (completion_token IS NULL)),
    CHECK ((safe_trace_root_input IS NULL) = (safe_trace_root_input_hash IS NULL)),
    CHECK (
        safe_trace_root_input IS NULL
        OR (
            public.sophia_deck_quality_safe_trace_root_valid(
                safe_trace_root_input, safe_trace_root_input_hash
            )
            AND safe_trace_root_input ->> 'campaign_id' = campaign_id
            AND safe_trace_root_input ->> 'quality_run_id' = quality_run_id
            AND safe_trace_root_input ->> 'build_id' = build_id
            AND safe_trace_root_input ->> 'task_id' = COALESCE(task_id, 'missing-task')
            AND safe_trace_root_input ->> 'builder_run_id' =
                COALESCE(builder_run_id, 'missing-builder-run')
            AND safe_trace_root_input ->> 'parent_builder_run_id' =
                COALESCE(builder_run_id, 'missing-builder-run')
            AND safe_trace_root_input ->> 'parent_builder_trace_id' =
                COALESCE(parent_builder_trace_id, 'missing-builder-trace')
            AND safe_trace_root_input ->> 'logical_artifact_id' = logical_artifact_id
            AND safe_trace_root_input ->> 'artifact_version_id' = artifact_version_id
            AND (safe_trace_root_input ->> 'manifest_revision')::BIGINT = manifest_revision
            AND safe_trace_root_input ->> 'artifact_hash' = artifact_hash
            AND safe_trace_root_input ->> 'rubric_version' = rubric_version
            AND safe_trace_root_input ->> 'rubric_hash' = rubric_hash
            AND safe_trace_root_input ->> 'judge_profile_version' = judge_profile_version
            AND safe_trace_root_input ->> 'judge_plan_hash' = judge_plan_hash
            AND safe_trace_root_input ->> 'evidence_preprocessor_version' =
                evidence_preprocessor_version
        )
    ),
    CHECK (terminal_trace_payload_hash IS NULL OR safe_trace_root_input IS NOT NULL),
    CHECK (
        (pending_terminal_state IS NULL AND terminal_trace_payload_hash IS NULL)
        OR (
            pending_terminal_state IS NOT NULL
            AND state IN ('finalizing', 'failed', 'stale')
            AND last_error_code IS NOT NULL
            AND last_error_stage IS NOT NULL
            AND last_error_at IS NOT NULL
            AND (
                state = 'finalizing'
                OR (
                    pending_terminal_state = state
                    AND terminal_trace_payload_hash IS NOT NULL
                    AND safe_trace_root_input IS NOT NULL
                )
            )
        )
    ),
    CHECK (
        (last_error_code IS NULL AND last_error_stage IS NULL AND last_error_at IS NULL)
        OR (last_error_code IS NOT NULL AND last_error_stage IS NOT NULL AND last_error_at IS NOT NULL)
    ),
    CHECK (
        (state = 'completed' AND completion_owner IS NOT NULL)
        OR (state <> 'completed' AND completion_owner IS NULL)
    ),
    CHECK (state <> 'completed' OR (decision_result IS NOT NULL AND stage = 'persisted_and_traced')),
    CHECK (
        state <> 'completed'
        OR (
            stage_artifact_hashes ? 'decision'
            AND stage_artifact_hashes ? 'safe_metrics'
            AND stage_artifact_hashes ? 'run'
        )
    ),
    CHECK (
        state <> 'finalizing'
        OR (
            pending_terminal_state IS NOT NULL
            AND (
                last_error_code NOT IN (
                    'run_deadline_exceeded', 'attempt_limit_exhausted'
                )
                OR (
                    last_error_code = 'run_deadline_exceeded'
                    AND last_error_stage = 'run_deadline'
                )
                OR (
                    last_error_code = 'attempt_limit_exhausted'
                    AND last_error_stage = 'attempt_limit'
                )
            )
        )
        OR (
            pending_terminal_state IS NULL
            AND
            stage = 'adjudicated'
            AND decision_result IS NOT NULL
            AND stage_artifact_hashes ? 'decision'
            AND stage_artifact_hashes ? 'safe_metrics'
            AND stage_artifact_hashes ? 'run'
            AND trace_ids ?& ARRAY[
                'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
                'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
                'mechanical_projection_run_id', 'plan_realization_run_id',
                'adjudicate_run_id', 'shadow_persist_run_id'
            ]
            AND trace_ids ->> 'quality_trace_id' = trace_ids ->> 'quality_root_run_id'
            AND safe_trace_root_input IS NOT NULL
        )
    ),
    CHECK (
        state NOT IN ('completed', 'failed', 'stale')
        OR (
            trace_ids ?& ARRAY[
                'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
                'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
                'mechanical_projection_run_id', 'plan_realization_run_id',
                'adjudicate_run_id', 'shadow_persist_run_id'
            ]
            AND trace_ids ->> 'quality_trace_id' = trace_ids ->> 'quality_root_run_id'
        )
    ),
    CHECK (
        state <> 'completed'
        OR (pending_terminal_state IS NULL AND safe_trace_root_input IS NOT NULL)
    ),
    CHECK (
        state NOT IN ('failed', 'stale')
        OR pending_terminal_state = state
    )
);

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_claim_ids_valid(
    p_value TEXT[]
) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    v_quality_run_id TEXT;
    v_distinct_count INTEGER;
BEGIN
    IF p_value IS NULL
       OR cardinality(p_value) > 2
       OR array_position(p_value, NULL) IS NOT NULL
       OR (cardinality(p_value) > 0 AND array_ndims(p_value) <> 1) THEN
        RETURN false;
    END IF;
    FOREACH v_quality_run_id IN ARRAY p_value
    LOOP
        IF v_quality_run_id !~ '^quality_[0-9a-f]{64}$' THEN
            RETURN false;
        END IF;
    END LOOP;
    SELECT count(DISTINCT quality_run_id)
      INTO v_distinct_count
      FROM unnest(p_value) AS quality_run_ids(quality_run_id);
    RETURN v_distinct_count = cardinality(p_value);
END;
$$;

-- One hour is intentionally much longer than the 15-second RPC timeout and
-- the single immediate same-token response-loss replay performed by workers.
CREATE TABLE IF NOT EXISTS public.sophia_deck_quality_shadow_claim_receipts (
    lease_owner      TEXT NOT NULL
                          CHECK (lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    claim_token      TEXT NOT NULL
                          CHECK (claim_token ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    claim_hash       TEXT NOT NULL CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
    lease_seconds    INTEGER NOT NULL CHECK (lease_seconds BETWEEN 15 AND 900),
    claim_limit      SMALLINT NOT NULL CHECK (claim_limit BETWEEN 1 AND 2),
    quality_run_ids  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
                          CHECK (public.sophia_deck_quality_claim_ids_valid(quality_run_ids))
                          CHECK (cardinality(quality_run_ids) <= claim_limit),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
    PRIMARY KEY (lease_owner, claim_token)
);

CREATE INDEX IF NOT EXISTS sophia_deck_quality_shadow_claim_receipt_cleanup_idx
    ON public.sophia_deck_quality_shadow_claim_receipts (
        created_at, lease_owner, claim_token
    );

CREATE INDEX IF NOT EXISTS sophia_deck_quality_shadow_claim_idx
    ON public.sophia_deck_quality_shadow_runs (next_attempt_at, requested_at, quality_run_id)
    WHERE state IN ('pending', 'running', 'retry_wait', 'finalizing');

CREATE INDEX IF NOT EXISTS sophia_deck_quality_shadow_linkage_idx
    ON public.sophia_deck_quality_shadow_runs (user_id, thread_id, task_id, build_id, artifact_version_id);

CREATE OR REPLACE FUNCTION public.sophia_request_deck_quality_shadow_run(
    p_quality_run_id TEXT,
    p_campaign_id TEXT,
    p_instrument_schema_version TEXT,
    p_instrument_identity_hash TEXT,
    p_rubric_version TEXT,
    p_rubric_hash TEXT,
    p_prompt_hashes JSONB,
    p_judge_plan_hash TEXT,
    p_judge_profile_version TEXT,
    p_evidence_preprocessor_version TEXT,
    p_judge_invoker_version TEXT,
    p_assessment_schema_versions JSONB,
    p_adjudication_policy_hash TEXT,
    p_user_id TEXT,
    p_thread_id TEXT,
    p_task_id TEXT,
    p_build_id TEXT,
    p_builder_run_id TEXT,
    p_parent_builder_trace_id TEXT,
    p_logical_artifact_id TEXT,
    p_artifact_version_id TEXT,
    p_manifest_revision BIGINT,
    p_artifact_hash TEXT,
    p_input_manifest_object_path TEXT,
    p_input_manifest_hash TEXT,
    p_max_attempts INTEGER,
    p_run_deadline_at TIMESTAMPTZ
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing public.sophia_deck_quality_shadow_runs%ROWTYPE;
    v_expected_path TEXT;
BEGIN
    IF p_quality_run_id IS NULL OR p_quality_run_id !~ '^quality_[0-9a-f]{64}$'
       OR p_campaign_id IS NULL OR p_campaign_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
       OR p_instrument_schema_version IS NULL OR btrim(p_instrument_schema_version) = ''
       OR p_instrument_identity_hash IS NULL OR p_instrument_identity_hash !~ '^[0-9a-f]{64}$'
       OR p_rubric_hash IS NULL OR p_rubric_hash !~ '^[0-9a-f]{64}$'
       OR p_judge_plan_hash IS NULL OR p_judge_plan_hash !~ '^[0-9a-f]{64}$'
       OR p_adjudication_policy_hash IS NULL OR p_adjudication_policy_hash !~ '^[0-9a-f]{64}$'
       OR p_artifact_hash IS NULL OR p_artifact_hash !~ '^[0-9a-f]{64}$'
       OR p_input_manifest_hash IS NULL OR p_input_manifest_hash !~ '^[0-9a-f]{64}$'
       OR p_manifest_revision IS NULL OR p_manifest_revision < 1
       OR p_user_id IS NULL OR char_length(p_user_id) NOT BETWEEN 1 AND 256
       OR p_user_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_user_id, 'user')
       OR p_thread_id IS NULL OR char_length(p_thread_id) NOT BETWEEN 1 AND 256
       OR p_thread_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_thread_id, 'thread')
       OR p_build_id IS NULL OR p_build_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
       OR p_build_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_build_id, 'build')
       OR p_logical_artifact_id IS NULL OR btrim(p_logical_artifact_id) = ''
       OR p_artifact_version_id IS NULL OR btrim(p_artifact_version_id) = ''
       OR p_rubric_version IS NULL OR btrim(p_rubric_version) = ''
       OR p_judge_profile_version IS NULL OR btrim(p_judge_profile_version) = ''
       OR p_evidence_preprocessor_version IS NULL OR btrim(p_evidence_preprocessor_version) = ''
       OR p_judge_invoker_version IS NULL OR btrim(p_judge_invoker_version) = ''
       OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100
       OR p_run_deadline_at IS NULL OR NOT isfinite(p_run_deadline_at)
       OR NOT public.sophia_deck_quality_hash_map_valid(p_prompt_hashes)
       OR NOT public.sophia_deck_quality_version_map_valid(p_assessment_schema_versions) THEN
        RAISE EXCEPTION 'deck_quality_request_invalid' USING ERRCODE = '22023';
    END IF;

    v_expected_path := 'artifacts/' ||
        public.sophia_deck_quality_safe_path_segment(p_user_id, 'user') || '/' ||
        public.sophia_deck_quality_safe_path_segment(p_thread_id, 'thread') ||
        '/foundation/.builder/builds/' || p_build_id || '/quality/' ||
        p_quality_run_id || '/input_bundle/manifest.json';
    IF p_input_manifest_object_path IS NULL
       OR p_input_manifest_object_path <> v_expected_path THEN
        RAISE EXCEPTION 'deck_quality_input_manifest_path_invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        p_artifact_version_id || chr(31) || p_campaign_id || chr(31) || p_instrument_identity_hash,
        0
    ));

    SELECT * INTO v_existing
      FROM public.sophia_deck_quality_shadow_runs
     WHERE artifact_version_id = p_artifact_version_id
       AND campaign_id = p_campaign_id
       AND instrument_identity_hash = p_instrument_identity_hash
     FOR UPDATE;

    IF FOUND THEN
        IF v_existing.quality_run_id IS DISTINCT FROM p_quality_run_id
           OR v_existing.user_id IS DISTINCT FROM p_user_id
           OR v_existing.thread_id IS DISTINCT FROM p_thread_id
           OR v_existing.task_id IS DISTINCT FROM p_task_id
           OR v_existing.build_id IS DISTINCT FROM p_build_id
           OR v_existing.builder_run_id IS DISTINCT FROM p_builder_run_id
           OR v_existing.parent_builder_trace_id IS DISTINCT FROM p_parent_builder_trace_id
           OR v_existing.logical_artifact_id IS DISTINCT FROM p_logical_artifact_id
           OR v_existing.manifest_revision IS DISTINCT FROM p_manifest_revision
           OR v_existing.artifact_hash IS DISTINCT FROM p_artifact_hash
           OR v_existing.input_manifest_object_path IS DISTINCT FROM p_input_manifest_object_path
           OR v_existing.input_manifest_hash IS DISTINCT FROM p_input_manifest_hash
           OR v_existing.max_attempts IS DISTINCT FROM p_max_attempts
           OR v_existing.run_deadline_at IS DISTINCT FROM p_run_deadline_at
           OR v_existing.instrument_schema_version IS DISTINCT FROM p_instrument_schema_version
           OR v_existing.rubric_version IS DISTINCT FROM p_rubric_version
           OR v_existing.rubric_hash IS DISTINCT FROM p_rubric_hash
           OR v_existing.prompt_hashes IS DISTINCT FROM p_prompt_hashes
           OR v_existing.judge_plan_hash IS DISTINCT FROM p_judge_plan_hash
           OR v_existing.judge_profile_version IS DISTINCT FROM p_judge_profile_version
           OR v_existing.evidence_preprocessor_version IS DISTINCT FROM p_evidence_preprocessor_version
           OR v_existing.judge_invoker_version IS DISTINCT FROM p_judge_invoker_version
           OR v_existing.assessment_schema_versions IS DISTINCT FROM p_assessment_schema_versions
           OR v_existing.adjudication_policy_hash IS DISTINCT FROM p_adjudication_policy_hash THEN
            RAISE EXCEPTION 'deck_quality_request_identity_conflict' USING ERRCODE = '23505';
        END IF;
        RETURN NEXT v_existing;
        RETURN;
    END IF;

    IF p_run_deadline_at <= statement_timestamp()
       OR p_run_deadline_at > statement_timestamp() + interval '15 minutes' THEN
        RAISE EXCEPTION 'deck_quality_run_deadline_invalid' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.sophia_deck_quality_shadow_runs (
        quality_run_id, campaign_id, instrument_schema_version, instrument_identity_hash,
        rubric_version, rubric_hash, prompt_hashes, judge_plan_hash,
        judge_profile_version, evidence_preprocessor_version,
        judge_invoker_version, assessment_schema_versions,
        adjudication_policy_hash, user_id, thread_id, task_id, build_id,
        builder_run_id, parent_builder_trace_id, logical_artifact_id,
        artifact_version_id, manifest_revision, artifact_hash,
        input_manifest_object_path, input_manifest_hash, max_attempts, run_deadline_at,
        trace_deadline_at
    ) VALUES (
        p_quality_run_id, p_campaign_id, p_instrument_schema_version, p_instrument_identity_hash,
        p_rubric_version, p_rubric_hash, p_prompt_hashes, p_judge_plan_hash,
        p_judge_profile_version, p_evidence_preprocessor_version,
        p_judge_invoker_version, p_assessment_schema_versions,
        p_adjudication_policy_hash, p_user_id, p_thread_id, p_task_id, p_build_id,
        p_builder_run_id, p_parent_builder_trace_id, p_logical_artifact_id,
        p_artifact_version_id, p_manifest_revision, p_artifact_hash,
        p_input_manifest_object_path, p_input_manifest_hash, p_max_attempts,
        p_run_deadline_at, p_run_deadline_at + interval '2 minutes'
    ) RETURNING * INTO v_existing;

    RETURN NEXT v_existing;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_claim_deck_quality_shadow_runs(
    p_lease_owner TEXT,
    p_claim_token TEXT,
    p_claim_hash TEXT,
    p_lease_seconds INTEGER DEFAULT 120,
    p_limit INTEGER DEFAULT 1
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_receipt public.sophia_deck_quality_shadow_claim_receipts%ROWTYPE;
    v_claimed_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF p_lease_owner IS NULL OR p_lease_owner !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
       OR p_claim_token IS NULL OR p_claim_token !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
       OR p_claim_hash IS NULL OR p_claim_hash !~ '^[0-9a-f]{64}$'
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 900
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 2 THEN
        RAISE EXCEPTION 'deck_quality_claim_invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        p_lease_owner || chr(31) || p_claim_token,
        2
    ));

    SELECT * INTO v_receipt
      FROM public.sophia_deck_quality_shadow_claim_receipts
     WHERE lease_owner = p_lease_owner
       AND claim_token = p_claim_token
     FOR UPDATE;

    IF FOUND THEN
        IF v_receipt.claim_hash IS DISTINCT FROM p_claim_hash
           OR v_receipt.lease_seconds IS DISTINCT FROM p_lease_seconds
           OR v_receipt.claim_limit IS DISTINCT FROM p_limit THEN
            RAISE EXCEPTION 'deck_quality_claim_conflict' USING ERRCODE = '23505';
        END IF;
        RETURN QUERY
        SELECT run.*
          FROM unnest(v_receipt.quality_run_ids) WITH ORDINALITY
                   AS receipt_run(quality_run_id, claim_order)
          JOIN public.sophia_deck_quality_shadow_runs AS run
            ON run.quality_run_id = receipt_run.quality_run_id
         WHERE run.state IN ('running', 'finalizing')
           AND run.lease_owner = p_lease_owner
           AND run.claim_token = p_claim_token
           AND run.claim_hash = p_claim_hash
           AND run.lease_expires_at > statement_timestamp()
         ORDER BY receipt_run.claim_order;
        RETURN;
    END IF;

    -- Bounded retention: receipts remain replayable for at least one hour,
    -- then at most 100 old rows are removed by each fresh-token poll.
    WITH expired_receipts AS (
        SELECT receipt.lease_owner, receipt.claim_token
          FROM public.sophia_deck_quality_shadow_claim_receipts AS receipt
         WHERE receipt.created_at < statement_timestamp() - interval '1 hour'
           AND (receipt.lease_owner, receipt.claim_token)
               IS DISTINCT FROM (p_lease_owner, p_claim_token)
         ORDER BY receipt.created_at, receipt.lease_owner, receipt.claim_token
         FOR UPDATE SKIP LOCKED
         LIMIT 100
    )
    DELETE FROM public.sophia_deck_quality_shadow_claim_receipts AS receipt
     USING expired_receipts
     WHERE receipt.lease_owner = expired_receipts.lease_owner
       AND receipt.claim_token = expired_receipts.claim_token;

    -- Deadline/max-attempt exhaustion is only a trace-pending precursor. SQL
    -- never creates an untraced terminal quality row.
    WITH trace_pending_candidates AS (
        SELECT run.quality_run_id
          FROM public.sophia_deck_quality_shadow_runs AS run
         WHERE run.state IN ('pending', 'retry_wait', 'running', 'finalizing')
           AND run.decision_result IS NULL
           AND run.pending_terminal_state IS NULL
           AND (
               run.state IN ('pending', 'retry_wait')
               OR run.lease_owner IS NULL
               OR run.lease_expires_at <= statement_timestamp()
           )
           AND (
               run.run_deadline_at <= statement_timestamp()
               OR (
                   run.attempt_count >= run.max_attempts
                   AND (
                       run.state IN ('pending', 'retry_wait')
                       OR (run.state = 'finalizing' AND run.lease_owner IS NULL)
                       OR run.lease_expires_at <= statement_timestamp()
                   )
               )
           )
         ORDER BY run.run_deadline_at, run.requested_at, run.quality_run_id
         FOR UPDATE SKIP LOCKED
         LIMIT 100
    )
    UPDATE public.sophia_deck_quality_shadow_runs AS run
       SET state = 'finalizing',
           next_attempt_at = LEAST(statement_timestamp(), run.trace_deadline_at),
           lease_owner = NULL,
           lease_expires_at = NULL,
           claim_token = NULL,
           claim_hash = NULL,
           pending_terminal_state = 'failed',
           terminal_trace_payload_hash = NULL,
           error_count = run.error_count + 1,
           last_error_code = CASE
               WHEN run.run_deadline_at <= statement_timestamp()
                   THEN 'run_deadline_exceeded'
               ELSE 'attempt_limit_exhausted'
           END,
           last_error_stage = CASE
               WHEN run.run_deadline_at <= statement_timestamp()
                   THEN 'run_deadline'
               ELSE 'attempt_limit'
           END,
           last_error_at = statement_timestamp(),
           finished_at = NULL,
           updated_at = statement_timestamp()
      FROM trace_pending_candidates
     WHERE run.quality_run_id = trace_pending_candidates.quality_run_id;

    WITH candidates AS (
        SELECT run.quality_run_id, run.next_attempt_at, run.requested_at,
               run.state = 'finalizing' AS is_finalizing
          FROM public.sophia_deck_quality_shadow_runs AS run
         WHERE (
                   (
                       run.state = 'finalizing'
                       AND run.next_attempt_at <= statement_timestamp()
                       AND (
                           run.lease_owner IS NULL
                           OR run.lease_expires_at <= statement_timestamp()
                       )
                       AND run.trace_deadline_at > statement_timestamp()
                       AND (
                           run.decision_result IS NOT NULL
                           OR run.pending_terminal_state IS NOT NULL
                       )
                   )
                   OR (
                       run.state IN ('pending', 'retry_wait')
                       AND run.next_attempt_at <= statement_timestamp()
                       AND run.attempt_count < run.max_attempts
                       AND run.run_deadline_at > statement_timestamp()
                   )
                   OR (
                       run.state = 'running'
                       AND run.lease_expires_at <= statement_timestamp()
                       AND run.attempt_count < run.max_attempts
                       AND run.run_deadline_at > statement_timestamp()
                   )
               )
         ORDER BY run.next_attempt_at, run.requested_at, run.quality_run_id
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
    ), claimed AS (
        UPDATE public.sophia_deck_quality_shadow_runs AS run
           SET state = CASE WHEN run.state = 'finalizing' THEN 'finalizing' ELSE 'running' END,
               lease_owner = p_lease_owner,
               lease_epoch = run.lease_epoch + 1,
               lease_expires_at = LEAST(
                   statement_timestamp() + make_interval(secs => p_lease_seconds),
                   CASE
                       WHEN candidates.is_finalizing
                           THEN run.trace_deadline_at
                       ELSE run.run_deadline_at
                   END
               ),
               attempt_count = CASE
                   WHEN candidates.is_finalizing THEN run.attempt_count
                   ELSE run.attempt_count + 1
               END,
               claim_token = p_claim_token,
               claim_hash = p_claim_hash,
               started_at = COALESCE(run.started_at, statement_timestamp()),
               updated_at = statement_timestamp()
          FROM candidates
         WHERE run.quality_run_id = candidates.quality_run_id
         RETURNING run.quality_run_id
    )
    SELECT COALESCE(
               array_agg(
                   claimed.quality_run_id
                   ORDER BY candidates.next_attempt_at, candidates.requested_at,
                            candidates.quality_run_id
               ),
               ARRAY[]::TEXT[]
           )
      INTO v_claimed_ids
      FROM claimed
      JOIN candidates USING (quality_run_id);

    INSERT INTO public.sophia_deck_quality_shadow_claim_receipts (
        lease_owner, claim_token, claim_hash, lease_seconds, claim_limit,
        quality_run_ids
    ) VALUES (
        p_lease_owner, p_claim_token, p_claim_hash, p_lease_seconds, p_limit,
        v_claimed_ids
    );

    RETURN QUERY
    SELECT run.*
      FROM unnest(v_claimed_ids) WITH ORDINALITY
               AS receipt_run(quality_run_id, claim_order)
      JOIN public.sophia_deck_quality_shadow_runs AS run
        ON run.quality_run_id = receipt_run.quality_run_id
     WHERE run.state IN ('running', 'finalizing')
       AND run.lease_owner = p_lease_owner
       AND run.claim_token = p_claim_token
       AND run.claim_hash = p_claim_hash
       AND run.lease_expires_at > statement_timestamp()
     ORDER BY receipt_run.claim_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_renew_deck_quality_shadow_lease(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 900 THEN
        RAISE EXCEPTION 'deck_quality_lease_duration_invalid' USING ERRCODE = '22023';
    END IF;
    UPDATE public.sophia_deck_quality_shadow_runs
       SET lease_expires_at = LEAST(
               statement_timestamp() + make_interval(secs => p_lease_seconds),
               CASE
                   WHEN state = 'finalizing'
                       THEN trace_deadline_at
                   ELSE run_deadline_at
               END
           ),
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
       AND state IN ('running', 'finalizing')
       AND lease_owner = p_lease_owner
       AND lease_epoch = p_lease_epoch
       AND lease_expires_at > statement_timestamp()
       AND (
           (state = 'running' AND run_deadline_at > statement_timestamp())
           OR (
               state = 'finalizing'
               AND trace_deadline_at > statement_timestamp()
           )
       )
     RETURNING * INTO v_run;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_release_deck_quality_shadow_lease(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    UPDATE public.sophia_deck_quality_shadow_runs
       SET state = CASE WHEN state = 'finalizing' THEN 'finalizing' ELSE 'pending' END,
           next_attempt_at = statement_timestamp(),
           lease_owner = NULL,
           lease_expires_at = NULL,
           claim_token = NULL,
           claim_hash = NULL,
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
       AND state IN ('running', 'finalizing')
       AND lease_owner = p_lease_owner
       AND lease_epoch = p_lease_epoch
       AND lease_expires_at > statement_timestamp()
     RETURNING * INTO v_run;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_retry_deck_quality_shadow_run(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_error_code TEXT,
    p_error_stage TEXT,
    p_delay_seconds INTEGER DEFAULT 30,
    p_max_attempts INTEGER DEFAULT 5
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    IF p_error_code IS NULL OR p_error_code NOT IN (
           'judge_unavailable', 'coverage_error', 'structured_output_invalid',
           'artifact_snapshot_stale', 'quality_persistence_error', 'shadow_dispatch_unavailable',
           'run_deadline_exceeded', 'attempt_limit_exhausted'
       )
       OR p_error_stage IS NULL OR p_error_stage !~ '^[a-z][a-z0-9_]{0,63}$'
       OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 0 AND 86400
       OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'deck_quality_retry_invalid' USING ERRCODE = '22023';
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET state = CASE
               WHEN state = 'finalizing' THEN 'finalizing'
               WHEN run_deadline_at <= statement_timestamp() THEN 'finalizing'
               WHEN attempt_count >= max_attempts THEN 'finalizing'
               ELSE 'retry_wait'
           END,
           next_attempt_at = CASE
               WHEN state = 'finalizing'
                    OR run_deadline_at <= statement_timestamp()
                    OR attempt_count >= max_attempts
                   THEN LEAST(
                       statement_timestamp() + make_interval(secs => p_delay_seconds),
                       trace_deadline_at
                   )
               ELSE LEAST(
                   statement_timestamp() + make_interval(secs => p_delay_seconds),
                   run_deadline_at
               )
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           claim_token = NULL,
           claim_hash = NULL,
           pending_terminal_state = CASE
               WHEN pending_terminal_state IS NOT NULL THEN pending_terminal_state
               WHEN run_deadline_at <= statement_timestamp()
                    OR attempt_count >= max_attempts THEN 'failed'
               ELSE NULL
           END,
           terminal_trace_payload_hash = CASE
               WHEN pending_terminal_state IS NOT NULL
                   THEN terminal_trace_payload_hash
               ELSE NULL
           END,
           error_count = CASE
               WHEN pending_terminal_state IS NOT NULL THEN error_count
               ELSE error_count + 1
           END,
           last_error_code = CASE
               WHEN pending_terminal_state IS NOT NULL THEN last_error_code
               WHEN run_deadline_at <= statement_timestamp() THEN 'run_deadline_exceeded'
               WHEN attempt_count >= max_attempts THEN 'attempt_limit_exhausted'
               ELSE p_error_code
           END,
           last_error_stage = CASE
               WHEN pending_terminal_state IS NOT NULL THEN last_error_stage
               WHEN run_deadline_at <= statement_timestamp() THEN 'run_deadline'
               WHEN attempt_count >= max_attempts THEN 'attempt_limit'
               ELSE p_error_stage
           END,
           last_error_at = CASE
               WHEN pending_terminal_state IS NOT NULL THEN last_error_at
               ELSE statement_timestamp()
           END,
           finished_at = NULL,
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
       AND state IN ('running', 'finalizing')
       AND lease_owner = p_lease_owner
       AND lease_epoch = p_lease_epoch
       AND lease_expires_at > statement_timestamp()
       AND max_attempts = p_max_attempts
     RETURNING * INTO v_run;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_prepare_deck_quality_shadow_failure_trace(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_terminal_state TEXT,
    p_error_code TEXT,
    p_error_stage TEXT,
    p_terminal_trace_payload_hash TEXT,
    p_safe_trace_root_input JSONB,
    p_safe_trace_root_input_hash TEXT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    IF p_terminal_state IS NULL OR p_terminal_state NOT IN ('failed', 'stale')
       OR p_error_code IS NULL OR p_error_code NOT IN (
           'judge_unavailable', 'coverage_error', 'structured_output_invalid',
           'artifact_snapshot_stale', 'quality_persistence_error',
           'shadow_dispatch_unavailable', 'run_deadline_exceeded',
           'attempt_limit_exhausted'
       )
       OR p_error_stage IS NULL
       OR p_error_stage !~ '^[a-z][a-z0-9_]{0,63}$'
       OR p_terminal_trace_payload_hash IS NULL
       OR p_terminal_trace_payload_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.sophia_deck_quality_safe_trace_root_valid(
           p_safe_trace_root_input, p_safe_trace_root_input_hash
       ) THEN
        RAISE EXCEPTION 'deck_quality_failure_trace_precursor_invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_run
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_run.state NOT IN ('running', 'finalizing')
       OR v_run.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_run.lease_epoch IS DISTINCT FROM p_lease_epoch
       OR v_run.lease_expires_at <= statement_timestamp()
       OR (
           v_run.state = 'running'
           AND v_run.run_deadline_at <= statement_timestamp()
       )
       OR (
           v_run.state = 'finalizing'
           AND v_run.trace_deadline_at <= statement_timestamp()
       ) THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;

    IF v_run.state = 'finalizing' THEN
        IF v_run.pending_terminal_state IS NOT NULL THEN
            IF v_run.pending_terminal_state IS DISTINCT FROM p_terminal_state
               OR v_run.last_error_code IS DISTINCT FROM p_error_code
               OR v_run.last_error_stage IS DISTINCT FROM p_error_stage
               OR (
                   v_run.terminal_trace_payload_hash IS NOT NULL
                   AND v_run.terminal_trace_payload_hash IS DISTINCT FROM
                       p_terminal_trace_payload_hash
               )
               OR (
                   v_run.safe_trace_root_input IS NOT NULL
                   AND (
                       v_run.safe_trace_root_input IS DISTINCT FROM
                           p_safe_trace_root_input
                       OR v_run.safe_trace_root_input_hash IS DISTINCT FROM
                           p_safe_trace_root_input_hash
                   )
               ) THEN
                RAISE EXCEPTION 'deck_quality_failure_trace_precursor_conflict'
                    USING ERRCODE = '23505';
            END IF;
            UPDATE public.sophia_deck_quality_shadow_runs
               SET terminal_trace_payload_hash = COALESCE(
                       terminal_trace_payload_hash,
                       p_terminal_trace_payload_hash
                   ),
                   safe_trace_root_input = COALESCE(
                       safe_trace_root_input,
                       p_safe_trace_root_input
                   ),
                   safe_trace_root_input_hash = COALESCE(
                       safe_trace_root_input_hash,
                       p_safe_trace_root_input_hash
                   ),
                   updated_at = statement_timestamp()
             WHERE quality_run_id = p_quality_run_id
             RETURNING * INTO v_run;
            RETURN NEXT v_run;
            RETURN;
        END IF;
        IF v_run.decision_result IS NULL
           OR v_run.safe_trace_root_input IS DISTINCT FROM p_safe_trace_root_input
           OR v_run.safe_trace_root_input_hash IS DISTINCT FROM
               p_safe_trace_root_input_hash THEN
            RAISE EXCEPTION 'deck_quality_failure_trace_precursor_conflict'
                USING ERRCODE = '23505';
        END IF;
        UPDATE public.sophia_deck_quality_shadow_runs
           SET pending_terminal_state = p_terminal_state,
               terminal_trace_payload_hash = p_terminal_trace_payload_hash,
               last_error_code = p_error_code,
               last_error_stage = p_error_stage,
               last_error_at = statement_timestamp(),
               error_count = error_count + 1,
               updated_at = statement_timestamp()
         WHERE quality_run_id = p_quality_run_id
         RETURNING * INTO v_run;
        RETURN NEXT v_run;
        RETURN;
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET state = 'finalizing',
           pending_terminal_state = p_terminal_state,
           terminal_trace_payload_hash = p_terminal_trace_payload_hash,
           safe_trace_root_input = p_safe_trace_root_input,
           safe_trace_root_input_hash = p_safe_trace_root_input_hash,
           last_error_code = p_error_code,
           last_error_stage = p_error_stage,
           last_error_at = statement_timestamp(),
           error_count = error_count + 1,
           next_attempt_at = statement_timestamp(),
           finished_at = NULL,
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
     RETURNING * INTO v_run;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_checkpoint_deck_quality_shadow_run(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_stage TEXT,
    p_safe_metrics JSONB DEFAULT '{}'::JSONB,
    p_trace_ids JSONB DEFAULT '{}'::JSONB,
    p_stage_artifact_hashes JSONB DEFAULT '{}'::JSONB,
    p_evidence_manifest_object_path TEXT DEFAULT NULL,
    p_evidence_manifest_hash TEXT DEFAULT NULL
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
    v_stage_rank SMALLINT;
    v_required_artifact_key TEXT;
    v_expected_evidence_path TEXT;
BEGIN
    v_stage_rank := CASE p_stage
        WHEN 'requested' THEN 0
        WHEN 'snapshot_loaded' THEN 10
        WHEN 'evidence_prepared' THEN 20
        WHEN 'blind_assessed' THEN 30
        WHEN 'mechanical_projected' THEN 40
        WHEN 'plan_realization_assessed' THEN 50
        WHEN 'adjudicated' THEN 60
        ELSE NULL
    END;
    v_required_artifact_key := CASE p_stage
        WHEN 'snapshot_loaded' THEN 'source_snapshot'
        WHEN 'evidence_prepared' THEN 'evidence_manifest'
        WHEN 'blind_assessed' THEN 'assessment_a_visual'
        WHEN 'mechanical_projected' THEN 'assessment_b_mechanical'
        WHEN 'plan_realization_assessed' THEN 'assessment_c_plan_realization'
        WHEN 'adjudicated' THEN 'decision'
        ELSE NULL
    END;
    IF v_stage_rank IS NULL
       OR NOT public.sophia_deck_quality_safe_metrics_valid(p_safe_metrics)
       OR NOT public.sophia_deck_quality_trace_ids_valid(p_trace_ids)
       OR NOT public.sophia_deck_quality_stage_hashes_valid(p_stage_artifact_hashes)
       OR (p_evidence_manifest_object_path IS NULL) <> (p_evidence_manifest_hash IS NULL)
       OR (
           p_stage = 'snapshot_loaded'
           AND (
               p_evidence_manifest_object_path IS NULL
               OR char_length(p_evidence_manifest_object_path) > 4096
               OR p_evidence_manifest_hash !~ '^[0-9a-f]{64}$'
           )
       )
       OR (
           p_stage <> 'snapshot_loaded'
           AND p_evidence_manifest_object_path IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'deck_quality_checkpoint_invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_run
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_run.state <> 'running'
       OR v_run.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_run.lease_epoch IS DISTINCT FROM p_lease_epoch
       OR v_run.lease_expires_at <= statement_timestamp()
       OR v_run.run_deadline_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    IF p_stage = 'snapshot_loaded' THEN
        v_expected_evidence_path := left(
            v_run.input_manifest_object_path,
            char_length(v_run.input_manifest_object_path) - char_length('/input_bundle/manifest.json')
        ) || '/evidence_manifest.json';
        IF p_evidence_manifest_object_path IS DISTINCT FROM v_expected_evidence_path THEN
            RAISE EXCEPTION 'deck_quality_evidence_manifest_path_invalid' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF v_stage_rank = v_run.stage_rank THEN
        IF p_stage <> v_run.stage
           OR NOT (v_run.safe_metrics @> p_safe_metrics)
           OR NOT (v_run.trace_ids @> p_trace_ids)
           OR NOT (v_run.stage_artifact_hashes @> p_stage_artifact_hashes)
           OR (
               p_stage = 'snapshot_loaded'
               AND (
                   v_run.evidence_manifest_object_path IS DISTINCT FROM p_evidence_manifest_object_path
                   OR v_run.evidence_manifest_hash IS DISTINCT FROM p_evidence_manifest_hash
               )
           ) THEN
            RAISE EXCEPTION 'deck_quality_checkpoint_replay_not_idempotent' USING ERRCODE = '23505';
        END IF;
        RETURN NEXT v_run;
        RETURN;
    END IF;
    IF v_stage_rank <> v_run.stage_rank + 10 THEN
        RAISE EXCEPTION 'deck_quality_stage_transition_invalid' USING ERRCODE = '22023';
    END IF;
    IF v_required_artifact_key IS NULL
       OR NOT (p_stage_artifact_hashes ? v_required_artifact_key) THEN
        RAISE EXCEPTION 'deck_quality_stage_artifact_hash_required' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_each_text(p_stage_artifact_hashes) AS incoming(key, value)
          JOIN jsonb_each_text(v_run.stage_artifact_hashes) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) THEN
        RAISE EXCEPTION 'deck_quality_stage_artifact_hash_conflict' USING ERRCODE = '23505';
    END IF;
    IF p_stage_artifact_hashes ? 'evidence_manifest'
       AND (
           v_run.evidence_manifest_hash IS NULL
           OR p_stage_artifact_hashes ->> 'evidence_manifest' <> v_run.evidence_manifest_hash
       ) THEN
        RAISE EXCEPTION 'deck_quality_evidence_manifest_hash_conflict' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_each(p_safe_metrics) AS incoming(key, value)
          JOIN jsonb_each(v_run.safe_metrics) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) OR EXISTS (
        SELECT 1
          FROM jsonb_each_text(p_trace_ids) AS incoming(key, value)
          JOIN jsonb_each_text(v_run.trace_ids) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) THEN
        RAISE EXCEPTION 'deck_quality_safe_metadata_conflict' USING ERRCODE = '23505';
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET stage = p_stage,
           stage_rank = v_stage_rank,
           safe_metrics = safe_metrics || p_safe_metrics,
           trace_ids = trace_ids || p_trace_ids,
           stage_artifact_hashes = stage_artifact_hashes || p_stage_artifact_hashes,
           evidence_manifest_object_path = CASE
               WHEN p_stage = 'snapshot_loaded' THEN p_evidence_manifest_object_path
               ELSE evidence_manifest_object_path
           END,
           evidence_manifest_hash = CASE
               WHEN p_stage = 'snapshot_loaded' THEN p_evidence_manifest_hash
               ELSE evidence_manifest_hash
           END,
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
     RETURNING * INTO v_run;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_prepare_deck_quality_shadow_completion(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_decision_result TEXT,
    p_decision_failure_codes TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_decision_weighted_score NUMERIC DEFAULT NULL,
    p_safe_metrics JSONB DEFAULT '{}'::JSONB,
    p_trace_ids JSONB DEFAULT '{}'::JSONB,
    p_stage_artifact_hashes JSONB DEFAULT '{}'::JSONB,
    p_safe_trace_root_input JSONB DEFAULT NULL,
    p_safe_trace_root_input_hash TEXT DEFAULT NULL
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    IF p_decision_result IS NULL OR p_decision_result NOT IN (
           'failed_to_judge', 'mechanically_invalid', 'needs_revision',
           'needs_user_review', 'satisfied'
       )
       OR NOT public.sophia_deck_quality_codes_valid(p_decision_failure_codes)
       OR NOT public.sophia_deck_quality_safe_metrics_valid(p_safe_metrics)
       OR NOT public.sophia_deck_quality_trace_ids_valid(p_trace_ids)
       OR NOT public.sophia_deck_quality_stage_hashes_valid(p_stage_artifact_hashes)
       OR NOT public.sophia_deck_quality_safe_trace_root_valid(
           p_safe_trace_root_input, p_safe_trace_root_input_hash
       )
       OR p_decision_weighted_score IS NOT NULL
          AND p_decision_weighted_score NOT BETWEEN 0 AND 5
       OR NOT (p_stage_artifact_hashes ? 'decision')
       OR NOT (p_stage_artifact_hashes ? 'safe_metrics')
       OR NOT (p_stage_artifact_hashes ? 'run')
       OR NOT (p_trace_ids ?& ARRAY[
           'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
           'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
           'mechanical_projection_run_id', 'plan_realization_run_id',
           'adjudicate_run_id', 'shadow_persist_run_id'
       ])
       OR p_trace_ids ->> 'quality_trace_id' <> p_trace_ids ->> 'quality_root_run_id' THEN
        RAISE EXCEPTION 'deck_quality_prepare_completion_invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_run
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_run.state NOT IN ('running', 'finalizing')
       OR v_run.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_run.lease_epoch IS DISTINCT FROM p_lease_epoch
       OR v_run.lease_expires_at <= statement_timestamp()
       OR (
           v_run.state = 'running'
           AND v_run.run_deadline_at <= statement_timestamp()
       )
       OR (
           v_run.state = 'finalizing'
           AND v_run.trace_deadline_at <= statement_timestamp()
       ) THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    IF v_run.stage <> 'adjudicated'
       OR v_run.stage_rank <> 60
       OR NOT (v_run.stage_artifact_hashes ? 'decision')
       OR v_run.stage_artifact_hashes ->> 'decision'
          <> p_stage_artifact_hashes ->> 'decision' THEN
        RAISE EXCEPTION 'deck_quality_prepare_before_adjudication' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_each_text(p_stage_artifact_hashes) AS incoming(key, value)
          JOIN jsonb_each_text(v_run.stage_artifact_hashes) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) THEN
        RAISE EXCEPTION 'deck_quality_stage_artifact_hash_conflict' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_each(p_safe_metrics) AS incoming(key, value)
          JOIN jsonb_each(v_run.safe_metrics) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) OR EXISTS (
        SELECT 1
          FROM jsonb_each_text(p_trace_ids) AS incoming(key, value)
          JOIN jsonb_each_text(v_run.trace_ids) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) THEN
        RAISE EXCEPTION 'deck_quality_safe_metadata_conflict' USING ERRCODE = '23505';
    END IF;

    IF v_run.state = 'finalizing' THEN
        IF v_run.decision_result IS DISTINCT FROM p_decision_result
           OR v_run.decision_failure_codes IS DISTINCT FROM p_decision_failure_codes
           OR v_run.decision_weighted_score IS DISTINCT FROM p_decision_weighted_score
           OR NOT (v_run.safe_metrics @> p_safe_metrics)
           OR NOT (v_run.trace_ids @> p_trace_ids)
           OR NOT (v_run.stage_artifact_hashes @> p_stage_artifact_hashes)
           OR v_run.safe_trace_root_input IS DISTINCT FROM p_safe_trace_root_input
           OR v_run.safe_trace_root_input_hash IS DISTINCT FROM
               p_safe_trace_root_input_hash THEN
            RAISE EXCEPTION 'deck_quality_prepare_completion_replay_not_idempotent'
                USING ERRCODE = '23505';
        END IF;
        RETURN NEXT v_run;
        RETURN;
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET state = 'finalizing',
           decision_result = p_decision_result,
           decision_failure_codes = p_decision_failure_codes,
           decision_weighted_score = p_decision_weighted_score,
           safe_metrics = safe_metrics || p_safe_metrics,
           trace_ids = trace_ids || p_trace_ids,
           stage_artifact_hashes = stage_artifact_hashes || p_stage_artifact_hashes,
           safe_trace_root_input = p_safe_trace_root_input,
           safe_trace_root_input_hash = p_safe_trace_root_input_hash,
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
     RETURNING * INTO v_run;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_complete_deck_quality_shadow_after_trace(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    SELECT * INTO v_run
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id
     FOR UPDATE;
    IF FOUND
       AND v_run.state = 'completed'
       AND v_run.stage = 'persisted_and_traced'
       AND v_run.completion_owner = p_lease_owner
       AND v_run.completion_token = p_lease_epoch THEN
        RETURN NEXT v_run;
        RETURN;
    END IF;
    IF NOT FOUND
       OR v_run.state <> 'finalizing'
       OR v_run.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_run.lease_epoch IS DISTINCT FROM p_lease_epoch
       OR v_run.lease_expires_at <= statement_timestamp()
       OR v_run.trace_deadline_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    IF v_run.stage <> 'adjudicated'
       OR v_run.decision_result IS NULL
       OR NOT (v_run.stage_artifact_hashes ? 'decision')
       OR NOT (v_run.stage_artifact_hashes ? 'safe_metrics')
       OR NOT (v_run.stage_artifact_hashes ? 'run') THEN
        RAISE EXCEPTION 'deck_quality_completion_not_prepared' USING ERRCODE = '22023';
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET state = 'completed',
           stage = 'persisted_and_traced',
           stage_rank = 70,
           lease_owner = NULL,
           lease_expires_at = NULL,
           claim_token = NULL,
           claim_hash = NULL,
           completion_owner = p_lease_owner,
           completion_token = p_lease_epoch,
           finished_at = statement_timestamp(),
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
     RETURNING * INTO v_run;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_finish_deck_quality_shadow_run(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_terminal_state TEXT,
    p_terminal_trace_payload_hash TEXT,
    p_decision_result TEXT DEFAULT NULL,
    p_decision_failure_codes TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_decision_weighted_score NUMERIC DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_error_stage TEXT DEFAULT NULL,
    p_safe_metrics JSONB DEFAULT '{}'::JSONB,
    p_trace_ids JSONB DEFAULT '{}'::JSONB,
    p_stage_artifact_hashes JSONB DEFAULT '{}'::JSONB
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    IF p_terminal_state IS NULL OR p_terminal_state NOT IN ('failed', 'stale')
       OR p_terminal_trace_payload_hash IS NULL
       OR p_terminal_trace_payload_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.sophia_deck_quality_codes_valid(p_decision_failure_codes)
       OR NOT public.sophia_deck_quality_safe_metrics_valid(p_safe_metrics)
       OR NOT public.sophia_deck_quality_trace_ids_valid(p_trace_ids)
       OR NOT (p_trace_ids ?& ARRAY[
           'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
           'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
           'mechanical_projection_run_id', 'plan_realization_run_id',
           'adjudicate_run_id', 'shadow_persist_run_id'
       ])
       OR p_trace_ids ->> 'quality_trace_id' <> p_trace_ids ->> 'quality_root_run_id'
       OR NOT public.sophia_deck_quality_stage_hashes_valid(p_stage_artifact_hashes)
       OR (p_decision_weighted_score IS NOT NULL AND p_decision_weighted_score NOT BETWEEN 0 AND 5)
       OR (p_decision_result IS NOT NULL AND p_decision_result NOT IN (
              'failed_to_judge', 'mechanically_invalid', 'needs_revision',
              'needs_user_review', 'satisfied'
          ))
       OR (p_terminal_state IN ('failed', 'stale') AND p_error_code IS NULL)
       OR (p_error_code IS NOT NULL AND p_error_code NOT IN (
              'judge_unavailable', 'coverage_error', 'structured_output_invalid',
              'artifact_snapshot_stale', 'quality_persistence_error', 'shadow_dispatch_unavailable',
              'run_deadline_exceeded', 'attempt_limit_exhausted'
          ))
       OR (p_error_stage IS NOT NULL AND p_error_stage !~ '^[a-z][a-z0-9_]{0,63}$') THEN
        RAISE EXCEPTION 'deck_quality_finish_invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_run
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_run.state <> 'finalizing'
       OR v_run.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_run.lease_epoch IS DISTINCT FROM p_lease_epoch
       OR v_run.lease_expires_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;
    IF v_run.pending_terminal_state IS DISTINCT FROM p_terminal_state
       OR v_run.terminal_trace_payload_hash IS DISTINCT FROM
           p_terminal_trace_payload_hash
       OR v_run.last_error_code IS DISTINCT FROM p_error_code
       OR v_run.last_error_stage IS DISTINCT FROM p_error_stage THEN
        RAISE EXCEPTION 'deck_quality_terminal_precursor_conflict' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_each_text(p_stage_artifact_hashes) AS incoming(key, value)
          JOIN jsonb_each_text(v_run.stage_artifact_hashes) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) THEN
        RAISE EXCEPTION 'deck_quality_stage_artifact_hash_conflict' USING ERRCODE = '23505';
    END IF;
    IF p_stage_artifact_hashes ? 'evidence_manifest'
       AND (
           v_run.evidence_manifest_hash IS NULL
           OR p_stage_artifact_hashes ->> 'evidence_manifest' <> v_run.evidence_manifest_hash
       ) THEN
        RAISE EXCEPTION 'deck_quality_evidence_manifest_hash_conflict' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_each(p_safe_metrics) AS incoming(key, value)
          JOIN jsonb_each(v_run.safe_metrics) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) OR EXISTS (
        SELECT 1
          FROM jsonb_each_text(p_trace_ids) AS incoming(key, value)
          JOIN jsonb_each_text(v_run.trace_ids) AS existing(key, value)
            ON existing.key = incoming.key
         WHERE existing.value <> incoming.value
    ) THEN
        RAISE EXCEPTION 'deck_quality_safe_metadata_conflict' USING ERRCODE = '23505';
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET state = p_terminal_state,
           next_attempt_at = LEAST(next_attempt_at, run_deadline_at),
           lease_owner = NULL,
           lease_expires_at = NULL,
           claim_token = NULL,
           claim_hash = NULL,
           decision_result = COALESCE(p_decision_result, decision_result),
           decision_failure_codes = CASE
               WHEN p_decision_result IS NULL THEN decision_failure_codes
               ELSE p_decision_failure_codes
           END,
           decision_weighted_score = COALESCE(
               p_decision_weighted_score,
               decision_weighted_score
           ),
           safe_metrics = safe_metrics || p_safe_metrics,
           trace_ids = trace_ids || p_trace_ids,
           stage_artifact_hashes = stage_artifact_hashes || p_stage_artifact_hashes,
           finished_at = statement_timestamp(),
           updated_at = statement_timestamp()
     WHERE quality_run_id = p_quality_run_id
     RETURNING * INTO v_run;
    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_get_deck_quality_shadow_run(
    p_quality_run_id TEXT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT *
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id;
$$;

REVOKE ALL ON TABLE public.sophia_deck_quality_shadow_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sophia_deck_quality_shadow_claim_receipts
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.sophia_deck_quality_safe_metrics_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_hash_map_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_version_map_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_stage_hashes_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_trace_ids_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_codes_valid(TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_safe_path_segment(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_safe_trace_root_valid(JSONB, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_deck_quality_claim_ids_valid(TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.sophia_request_deck_quality_shadow_run(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_request_deck_quality_shadow_run(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_claim_deck_quality_shadow_runs(TEXT, TEXT, TEXT, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_claim_deck_quality_shadow_runs(TEXT, TEXT, TEXT, INTEGER, INTEGER)
    TO service_role;

REVOKE ALL ON FUNCTION public.sophia_renew_deck_quality_shadow_lease(TEXT, TEXT, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_renew_deck_quality_shadow_lease(TEXT, TEXT, BIGINT, INTEGER)
    TO service_role;

REVOKE ALL ON FUNCTION public.sophia_release_deck_quality_shadow_lease(TEXT, TEXT, BIGINT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_release_deck_quality_shadow_lease(TEXT, TEXT, BIGINT)
    TO service_role;

REVOKE ALL ON FUNCTION public.sophia_retry_deck_quality_shadow_run(
    TEXT, TEXT, BIGINT, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_retry_deck_quality_shadow_run(
    TEXT, TEXT, BIGINT, TEXT, TEXT, INTEGER, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_prepare_deck_quality_shadow_failure_trace(
    TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_prepare_deck_quality_shadow_failure_trace(
    TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_checkpoint_deck_quality_shadow_run(
    TEXT, TEXT, BIGINT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_checkpoint_deck_quality_shadow_run(
    TEXT, TEXT, BIGINT, TEXT, JSONB, JSONB, JSONB, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_prepare_deck_quality_shadow_completion(
    TEXT, TEXT, BIGINT, TEXT, TEXT[], NUMERIC, JSONB, JSONB, JSONB, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_prepare_deck_quality_shadow_completion(
    TEXT, TEXT, BIGINT, TEXT, TEXT[], NUMERIC, JSONB, JSONB, JSONB, JSONB, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_complete_deck_quality_shadow_after_trace(
    TEXT, TEXT, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_complete_deck_quality_shadow_after_trace(
    TEXT, TEXT, BIGINT
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_finish_deck_quality_shadow_run(
    TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT[], NUMERIC, TEXT, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_finish_deck_quality_shadow_run(
    TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT[], NUMERIC, TEXT, TEXT, JSONB, JSONB, JSONB
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_get_deck_quality_shadow_run(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_get_deck_quality_shadow_run(TEXT)
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
