-- MEM00-C2 serving grants. PROPOSED — not approved, not applied.
--
-- The C1/C2 migrations deliberately revoke application execution as they go
-- ("Release grants require the complete approved batch; keep this stage
-- private.", "No partial application grant."). That batch is now complete in
-- production: all twelve files are applied and both epoch bodies are in place
-- as of 2026-09-17. This file is the reviewed forward delta those comments
-- defer to. It is the *activation* step for serving, and nothing else.
--
-- Scope, deliberately narrow:
--   * EXECUTE only, only to service_role, only on the 21 named functions below.
--   * No grant to anon or authenticated. No GRANT ALL. No schema-wide grant.
--   * No table or sequence grant of any kind. Measured 2026-09-17: service_role
--     already holds SELECT on every MEM00 table it reads, holds no INSERT or
--     UPDATE on the governance tables (writes go through SECURITY DEFINER
--     functions), and RLS is enabled on all of them. That is already correct,
--     so this file does not touch tables.
--
-- Each function below was confirmed to (a) exist in production, (b) currently
-- lack service_role EXECUTE, and (c) have a real non-test caller on the C2
-- text-pilot path. Granting by name rather than by signature is intentional:
-- it covers every overload of these exact names and avoids transcription drift
-- against a 17-argument signature. The assertion at the end fails the
-- transaction if the set granted is not exactly the set intended.
--
-- NOT included, on purpose:
--   * sophia_memory_arm_fault / consume_fault / clear_faults. These already
--     hold service_role EXECUTE, which is a separate least-privilege question
--     recorded in the release record. Revoking them is not bundled into an
--     activation grant.
--   * Anything for Voice Lab, identity, or bulk/restore/source-mutation
--     surfaces that C2 does not enable.

BEGIN;

DO $grants$
DECLARE
    target text;
    granted integer;
    names text[] := ARRAY[
        -- Source intake: ordinary text session accepts an owned source action.
        'sophia_memory_accept_source_action',          -- source_intake.py
        'sophia_memory_source_boundary',               -- source_intake.py
        'sophia_memory_lookup_source_action',          -- source_intake.py
        'sophia_memory_check_source_use',              -- source_use.py
        -- End of session: finalize the transcript and queue extraction.
        'sophia_memory_finalize_and_enqueue_extraction', -- extraction_service.py
        'sophia_memory_enqueue_extraction',              -- extraction_service.py
        'sophia_memory_apply_source_target_at_epoch',    -- extraction_service.py
        'sophia_memory_source_snapshot',                 -- source_snapshot.py
        -- Extraction dispatch: one-use authority per physical extractor call.
        'sophia_memory_authorize_extraction_dispatch',   -- extraction_dispatch.py
        -- Review and Pool reads.
        'sophia_memory_review_snapshot',                 -- review.py
        'sophia_memory_inventory_snapshot',              -- inventory.py
        -- Final model admission: the outgoing-request boundary.
        'sophia_memory_authorize_model_dispatch',        -- model dispatch guard
        'sophia_memory_authorize_legacy_model_dispatch', -- legacy_model_dispatch.py
        'sophia_memory_record_prompt_admission',         -- reader.py, retained_admission.py
        'sophia_memory_record_model_result',             -- model_result_provenance.py
        'sophia_memory_get_model_result',                -- model_result_provenance.py
        -- Source-only Builder handoff (personal memory stays excluded).
        'sophia_memory_bind_builder_source_run',            -- builder_source_binding.py
        'sophia_memory_register_builder_handoff',           -- builder_source_binding.py
        'sophia_memory_get_builder_handoff',                -- builder_source_binding.py
        'sophia_memory_get_builder_source_run',             -- builder_source_binding.py
        'sophia_memory_get_builder_source_run_for_handoff'  -- builder_provenance.py
    ];
BEGIN
    IF array_length(names, 1) <> 21 THEN
        RAISE EXCEPTION 'memory_serving_grant_manifest_changed';
    END IF;

    FOREACH target IN ARRAY names LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = target
        ) THEN
            -- A missing function means the schema is not the one this delta was
            -- reviewed against. Fail rather than grant a partial set.
            RAISE EXCEPTION 'memory_serving_grant_target_missing: %', target;
        END IF;

        EXECUTE format(
            'GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role',
            p.proname, pg_get_function_identity_arguments(p.oid)
        ) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = target;
    END LOOP;

    -- Post-assertion: exactly the intended set now holds service_role EXECUTE,
    -- and nothing was handed to anon or authenticated along the way.
    SELECT count(*) INTO granted
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(names)
      AND has_function_privilege('service_role', p.oid, 'EXECUTE');
    IF granted < 21 THEN
        RAISE EXCEPTION 'memory_serving_grant_incomplete: % of 21', granted;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY(names)
          AND (has_function_privilege('anon', p.oid, 'EXECUTE')
               OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) THEN
        RAISE EXCEPTION 'memory_serving_grant_leaked_to_browser_role';
    END IF;
END
$grants$;

NOTIFY pgrst,'reload schema';
COMMIT;
