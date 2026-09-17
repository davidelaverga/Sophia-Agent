-- MEM00-C2 serving grants. PROPOSED — not approved, not applied.
--
-- The C1/C2 migrations revoke application execution as they go, on purpose,
-- deferring grants to a reviewed delta once the whole batch is applied
-- ("Release grants require the complete approved batch; keep this stage
-- private."). That batch is complete in production as of 2026-09-17, so this is
-- the delta those comments point at. Application remains pending the
-- coordinated release decision; this file is reviewed, not authorized.
--
-- Scope, deliberately narrow:
--   * EXECUTE only, only to service_role, only on the 21 frozen signatures.
--   * Nothing to anon or authenticated. No GRANT ALL. No schema-wide grant.
--   * No table or sequence grant. Measured 2026-09-17: service_role already
--     holds SELECT on every MEM00 table the store reads, holds no INSERT or
--     UPDATE on the governance tables (writes go through SECURITY DEFINER
--     functions), and RLS is enabled on all of them.
--
-- Signatures below are FROZEN as reviewed. They are matched with
-- to_regprocedure, so any change to an argument list, or the appearance of a
-- second overload, aborts the transaction instead of silently granting against
-- a definition nobody reviewed. A previous draft looked functions up by name
-- only and asserted `granted < 21`; that established neither the signature
-- contract nor the exact privilege set, and its dynamic
-- `EXECUTE ... FROM pg_proc` was a single-row statement rather than an overload
-- loop. Both are corrected here.
--
-- NOT included, on purpose: sophia_memory_arm_fault / consume_fault /
-- clear_faults already hold service_role EXECUTE. That is a separate
-- least-privilege question and is not bundled into an activation grant.

BEGIN;

DO $grants$
DECLARE
    rec           record;
    target        regprocedure;
    actual_args   text;
    overloads     integer;
    before_set    text[];
    after_set     text[];
    expected_set  text[];
    -- (function name, exact reviewed argument TYPE list)
    -- Types, not names: regprocedure resolution rejects argument names.
    frozen CONSTANT text[][] := ARRAY[
        -- Source intake: an ordinary text session records an owned source action.
        ['sophia_memory_accept_source_action', 'text, text, text, text, uuid, text, bigint, text, text, text'],
        ['sophia_memory_source_boundary', 'text, text, text'],
        ['sophia_memory_lookup_source_action', 'text, text'],
        ['sophia_memory_check_source_use', 'text, jsonb, jsonb'],
        -- End of session: finalize the transcript and queue extraction.
        ['sophia_memory_finalize_and_enqueue_extraction', 'text, text, text, timestamp with time zone, text, text, text, bigint, bigint, bigint, text, text, text, text'],
        ['sophia_memory_enqueue_extraction', 'text, text, text, text, text, text, bigint, bigint, bigint, text, text, text, text'],
        ['sophia_memory_apply_source_target_at_epoch', 'text, text, text, bigint, text, jsonb, jsonb, jsonb, text, text, text, text, timestamp with time zone, text, text, bigint, jsonb'],
        ['sophia_memory_source_snapshot', 'text, text, text'],
        -- Extraction dispatch: one-use authority per physical extractor call.
        ['sophia_memory_authorize_extraction_dispatch', 'text, uuid, uuid, uuid, text, text'],
        -- Review and Pool reads.
        ['sophia_memory_review_snapshot', 'text, text, bigint, text, jsonb, text, uuid, integer'],
        ['sophia_memory_inventory_snapshot', 'text, text, text, text, integer'],
        -- Final model admission: the outgoing-request boundary.
        ['sophia_memory_authorize_model_dispatch', 'text, jsonb'],
        ['sophia_memory_authorize_legacy_model_dispatch', 'text, jsonb'],
        ['sophia_memory_record_prompt_admission', 'uuid, text, text, text, text, text, text, text, text, text, integer, bigint, bigint, jsonb, jsonb, text, text, jsonb'],
        ['sophia_memory_record_model_result', 'text, jsonb'],
        ['sophia_memory_get_model_result', 'text, uuid'],
        -- Source-only Builder handoff. Personal memory stays excluded.
        ['sophia_memory_bind_builder_source_run', 'text, uuid, uuid, uuid, text'],
        ['sophia_memory_register_builder_handoff', 'text, jsonb'],
        ['sophia_memory_get_builder_handoff', 'text, uuid'],
        ['sophia_memory_get_builder_source_run', 'text, uuid'],
        ['sophia_memory_get_builder_source_run_for_handoff', 'text, uuid']
    ];
BEGIN
    IF array_length(frozen, 1) <> 21 THEN
        RAISE EXCEPTION 'memory_serving_grant_manifest_changed: % entries', array_length(frozen, 1);
    END IF;

    -- Exact privilege set, before. Every MEM00 function service_role can already
    -- execute; used to prove this delta adds precisely the intended 21 and
    -- removes nothing.
    SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{}')
      INTO before_set
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'sophia\_memory%'
       AND has_function_privilege('service_role', p.oid, 'EXECUTE');

    FOR i IN 1 .. array_length(frozen, 1) LOOP
        -- Exact-signature resolution. NULL means the reviewed signature is not
        -- what the database has: renamed, re-argumented, or absent.
        target := to_regprocedure(format('public.%I(%s)', frozen[i][1], frozen[i][2]));
        IF target IS NULL THEN
            RAISE EXCEPTION 'memory_serving_grant_signature_drift: public.%(%)', frozen[i][1], frozen[i][2];
        END IF;

        -- A second overload means the reviewed signature is no longer the only
        -- callable definition of that name; granting one of several is not the
        -- contract that was reviewed.
        SELECT count(*) INTO overloads
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = frozen[i][1];
        IF overloads <> 1 THEN
            RAISE EXCEPTION 'memory_serving_grant_overload_drift: % has % definitions', frozen[i][1], overloads;
        END IF;

        -- Belt and braces: the resolved object's own identity string must equal
        -- the reviewed one, so an implicit-cast match cannot slip through.
        SELECT (SELECT string_agg(format_type(t, null), ', ' ORDER BY ord)
                  FROM unnest(p.proargtypes) WITH ORDINALITY u(t, ord))
          INTO actual_args FROM pg_proc p WHERE p.oid = target;
        IF actual_args IS DISTINCT FROM frozen[i][2] THEN
            RAISE EXCEPTION 'memory_serving_grant_signature_drift: % resolved to (%)', frozen[i][1], actual_args;
        END IF;

        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', target::text);
    END LOOP;

    -- Exact intended privilege set, after: before_set plus exactly the 21.
    SELECT coalesce(array_agg(x ORDER BY x), '{}') INTO expected_set FROM (
        SELECT unnest(before_set) AS x
        UNION
        SELECT to_regprocedure(format('public.%I(%s)', frozen[i][1], frozen[i][2]))::text
          FROM generate_subscripts(frozen, 1) AS i
    ) s;

    SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{}')
      INTO after_set
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'sophia\_memory%'
       AND has_function_privilege('service_role', p.oid, 'EXECUTE');

    IF after_set IS DISTINCT FROM expected_set THEN
        RAISE EXCEPTION 'memory_serving_grant_set_mismatch: % granted, % expected',
            array_length(after_set, 1), array_length(expected_set, 1);
    END IF;

    -- No browser role may execute any MEM00 function, including the ones this
    -- delta touches and the ones it does not.
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname LIKE 'sophia\_memory%'
           AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) THEN
        RAISE EXCEPTION 'memory_serving_grant_leaked_to_browser_role';
    END IF;
END
$grants$;

NOTIFY pgrst,'reload schema';
COMMIT;
