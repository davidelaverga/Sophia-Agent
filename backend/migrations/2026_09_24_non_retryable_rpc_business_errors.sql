-- Replace deterministic business-rule SQLSTATE 40001 errors in the installed
-- Sophia RPC definitions.  PostgREST retries 40001 as a serialization failure;
-- these explicit RAISE statements cannot succeed on transaction retry.
-- This migration does not change native PostgreSQL serialization failures.
-- Apply only after independent review and production authorization.
BEGIN;

DO $non_retryable_rpc_errors$
DECLARE
    target_names text[] := ARRAY[
        'sophia_begin_deck_quality_shadow_dispatch',
        'sophia_checkpoint_deck_quality_shadow_run',
        'sophia_commit_build_manifest',
        'sophia_commit_build_mutation_manifest',
        'sophia_complete_deck_quality_shadow_after_trace',
        'sophia_fail_deck_quality_publication',
        'sophia_finish_deck_quality_shadow_run',
        'sophia_memory_accept_source_action',
        'sophia_memory_apply_source_target',
        'sophia_memory_apply_source_target_at_epoch',
        'sophia_memory_approve_candidate',
        'sophia_memory_assert_candidate_source',
        'sophia_memory_assert_recorded_model_sources',
        'sophia_memory_authorize_extraction_dispatch',
        'sophia_memory_authorize_legacy_model_dispatch',
        'sophia_memory_authorize_model_dispatch',
        'sophia_memory_bind_builder_source_run',
        'sophia_memory_check_source_use',
        'sophia_memory_complete_extraction',
        'sophia_memory_complete_extraction_pre_c1',
        'sophia_memory_complete_extraction_pre_decision_fence',
        'sophia_memory_complete_projection',
        'sophia_memory_complete_source_recovery',
        'sophia_memory_edit',
        'sophia_memory_fail_extraction',
        'sophia_memory_finalize_and_enqueue_extraction',
        'sophia_memory_forget',
        'sophia_memory_manual_create',
        'sophia_memory_manual_create_at_epoch',
        'sophia_memory_record_model_result',
        'sophia_memory_record_prompt_admission',
        'sophia_memory_register_builder_handoff',
        'sophia_memory_reject_candidate',
        'sophia_memory_restore',
        'sophia_memory_tombstone',
        'sophia_prepare_deck_quality_shadow_completion',
        'sophia_prepare_deck_quality_shadow_failure_trace',
        'sophia_promote_deck_quality_publication',
        'sophia_release_deck_quality_shadow_lease',
        'sophia_renew_build_mutation_lease',
        'sophia_renew_deck_quality_publication_lease',
        'sophia_renew_deck_quality_shadow_lease',
        'sophia_resolve_deck_quality_producer_failure_signal',
        'sophia_resolve_deck_quality_shadow_dispatch',
        'sophia_retry_deck_quality_publication',
        'sophia_retry_deck_quality_shadow_run',
        'sophia_transition_build_mutation_transaction'
    ];
    target_pattern constant text := 'ERRCODE[[:space:]]*=[[:space:]]*''40001''';
    function_record record;
    definition text;
    unexpected text[];
BEGIN
    -- A changed production function set requires review, not a broad rewrite.
    SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
      INTO unexpected
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
     WHERE n.nspname = 'public' AND l.lanname = 'plpgsql' AND p.prokind = 'f'
       AND pg_catalog.pg_get_functiondef(p.oid) ~* target_pattern
       AND p.proname <> ALL(target_names);
    IF unexpected IS NOT NULL THEN
        RAISE EXCEPTION 'unreviewed explicit 40001 function(s): %', unexpected;
    END IF;

    IF pg_catalog.to_regprocedure(
        'public.sophia_memory_authorize_extraction_dispatch(text,uuid,uuid,uuid,text,text)'
    ) IS NULL THEN
        RAISE EXCEPTION 'expected extraction-dispatch RPC is absent';
    END IF;

    FOR function_record IN
        SELECT p.oid, p.oid::regprocedure AS signature
          FROM pg_catalog.pg_proc AS p
          JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
         WHERE n.nspname = 'public' AND l.lanname = 'plpgsql' AND p.prokind = 'f'
           AND p.proname = ANY(target_names)
           AND pg_catalog.pg_get_functiondef(p.oid) ~* target_pattern
         ORDER BY p.oid
    LOOP
        definition := pg_catalog.pg_get_functiondef(function_record.oid);
        -- CREATE OR REPLACE keeps the function identity, owner and grants.
        -- Only the explicit SQLSTATE changes; messages and body stay intact.
        EXECUTE pg_catalog.regexp_replace(
            definition, target_pattern, 'ERRCODE = ''P0001''', 'gi'
        );
    END LOOP;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc AS p
          JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
         WHERE n.nspname = 'public' AND l.lanname = 'plpgsql' AND p.prokind = 'f'
           AND pg_catalog.pg_get_functiondef(p.oid) ~* target_pattern
    ) THEN
        RAISE EXCEPTION 'explicit 40001 remains in a public PL/pgSQL function';
    END IF;
END $non_retryable_rpc_errors$;

COMMIT;
