-- Transaction-level MEM00 contract assertions for a disposable PostgreSQL database.
-- The harness must install the production migration and a minimal sophia_sessions
-- fixture table before executing this file. No statement targets production.

DO $test$
DECLARE
    run public.sophia_memory_extraction_runs;
    replay public.sophia_memory_extraction_runs;
    candidate_id UUID;
    approved JSONB;
    approved_replay JSONB;
    edited JSONB;
    forgotten JSONB;
    restored JSONB;
    deleted JSONB;
    target_memory_id UUID;
BEGIN
    INSERT INTO public.sophia_sessions(id, user_id, message_revision)
    VALUES ('session-authority', 'owner-authority', 7);

    run := public.sophia_memory_enqueue_extraction(
        'owner-authority', 'enqueue-authority', 'digest-authority',
        'session-authority', 'thread-authority', 'text', 7, 1, 2,
        'hmac-sha256:manifest:authority', 'mem00.extract.v1',
        'synthetic-model', 'synthetic-prompt'
    );
    replay := public.sophia_memory_enqueue_extraction(
        'owner-authority', 'enqueue-authority', 'digest-authority',
        'session-authority', 'thread-authority', 'text', 7, 1, 2,
        'hmac-sha256:manifest:authority', 'mem00.extract.v1',
        'synthetic-model', 'synthetic-prompt'
    );
    IF run.extraction_run_id <> replay.extraction_run_id THEN
        RAISE EXCEPTION 'duplicate enqueue created a second run';
    END IF;

    SELECT * INTO STRICT run FROM public.sophia_memory_claim_extraction('claimant-a', 120);
    run := public.sophia_memory_complete_extraction(
        'owner-authority', run.extraction_run_id, run.lease_token,
        'hmac-sha256:manifest:authority',
        '[{"content":"SYNTHETIC-CANDIDATE-A","content_ref":"hmac-sha256:candidate:a","category":"fact","proposed_tier":"none","sources":[{"message_id":"message-1","sequence":1}]}]'::jsonb
    );
    IF run.state <> 'succeeded_nonzero' OR run.terminal_candidate_count <> 1 THEN
        RAISE EXCEPTION 'candidate batch did not commit atomically';
    END IF;
    IF EXISTS (SELECT 1 FROM public.sophia_memories WHERE user_id = 'owner-authority')
       OR EXISTS (SELECT 1 FROM public.sophia_memory_projection_jobs WHERE user_id = 'owner-authority') THEN
        RAISE EXCEPTION 'pending candidate escaped canonical authority';
    END IF;

    SELECT candidate.candidate_id INTO STRICT candidate_id
      FROM public.sophia_memory_candidates candidate
     WHERE candidate.user_id = 'owner-authority';
    approved := public.sophia_memory_approve_candidate(
        'owner-authority', candidate_id, 1,
        'SYNTHETIC-CANONICAL-EDITED', 'hmac-sha256:canonical:edited',
        'fact', 'global', 'none', 'user', 'approve-authority',
        'digest-approve-authority', 'mem0', 'production', 'existing-project'
    );
    approved_replay := public.sophia_memory_approve_candidate(
        'owner-authority', candidate_id, 1,
        'SYNTHETIC-CANONICAL-EDITED', 'hmac-sha256:canonical:edited',
        'fact', 'global', 'none', 'user', 'approve-authority',
        'digest-approve-authority', 'mem0', 'production', 'existing-project'
    );
    IF approved->>'memory_id' <> approved_replay->>'memory_id'
       OR approved_replay->>'idempotent_replay' <> 'true' THEN
        RAISE EXCEPTION 'approval replay is not idempotent';
    END IF;
    target_memory_id := (approved->>'memory_id')::uuid;
    IF (SELECT count(*) FROM public.sophia_memories WHERE user_id = 'owner-authority') <> 1
       OR (SELECT count(*) FROM public.sophia_memory_projection_jobs WHERE user_id = 'owner-authority') <> 1 THEN
        RAISE EXCEPTION 'approval cardinality mismatch';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.sophia_memory_candidate_versions
         WHERE user_id = 'owner-authority' AND proposed_content IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'approved candidate plaintext was not scrubbed';
    END IF;

    BEGIN
        PERFORM public.sophia_memory_approve_candidate(
            'wrong-owner', candidate_id, 1, 'CROSS-OWNER', 'hmac-sha256:bad:x',
            'fact', 'global', 'none', 'user', 'cross-owner', 'digest-cross-owner',
            'mem0', 'production', 'existing-project'
        );
        RAISE EXCEPTION 'cross-owner approval unexpectedly succeeded';
    EXCEPTION WHEN no_data_found THEN
        NULL;
    END;

    edited := public.sophia_memory_edit(
        'owner-authority', target_memory_id, 1, 1,
        'SYNTHETIC-CANONICAL-V2', 'hmac-sha256:canonical:v2',
        'fact', 'global', 'none', 'user', 'edit-authority', 'digest-edit-authority',
        'mem0', 'production', 'existing-project'
    );
    IF edited->>'content_revision' <> '2' OR edited->>'memory_governance_revision' <> '2' THEN
        RAISE EXCEPTION 'canonical edit revisions did not advance';
    END IF;
    forgotten := public.sophia_memory_forget(
        'owner-authority', target_memory_id, 2, 'user', 'forget-authority', 'digest-forget-authority'
    );
    IF forgotten->>'provider_purge' <> 'purge_pending' THEN
        RAISE EXCEPTION 'forget did not report purge pending';
    END IF;
    restored := public.sophia_memory_restore(
        'owner-authority', target_memory_id, 3, 'user', 'restore-authority', 'digest-restore-authority',
        'mem0', 'production', 'existing-project'
    );
    deleted := public.sophia_memory_tombstone(
        'owner-authority', target_memory_id, 4, 'user', 'delete-authority', 'digest-delete-authority'
    );
    IF deleted->>'status' <> 'accepted_and_fenced' THEN
        RAISE EXCEPTION 'tombstone fence did not commit';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.sophia_memory_versions
         WHERE user_id = 'owner-authority'
           AND (canonical_content IS NOT NULL OR content_ref IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'tombstone left canonical plaintext or content refs';
    END IF;
    IF (
        SELECT lifecycle FROM public.sophia_memories
         WHERE sophia_memories.memory_id = target_memory_id
    ) <> 'tombstoned' THEN
        RAISE EXCEPTION 'tombstone lifecycle is not monotonic';
    END IF;
END
$test$;

DO $test$
DECLARE
    run public.sophia_memory_extraction_runs;
    expired INTEGER;
BEGIN
    INSERT INTO public.sophia_sessions(id, user_id, message_revision)
    VALUES ('session-expiry', 'owner-expiry', 1);
    run := public.sophia_memory_enqueue_extraction(
        'owner-expiry', 'enqueue-expiry', 'digest-expiry',
        'session-expiry', 'thread-expiry', 'text', 1, 1, 1,
        'hmac-sha256:manifest:expiry', 'mem00.extract.v1',
        'synthetic-model', 'synthetic-prompt'
    );
    SELECT * INTO STRICT run FROM public.sophia_memory_claim_extraction('claimant-expiry', 120);
    run := public.sophia_memory_complete_extraction(
        'owner-expiry', run.extraction_run_id, run.lease_token,
        'hmac-sha256:manifest:expiry',
        '[{"content":"SYNTHETIC-EXPIRING-CANDIDATE","content_ref":"hmac-sha256:candidate:expiry","category":"fact","sources":[{"message_id":"message-expiry","sequence":1}]}]'::jsonb
    );
    UPDATE public.sophia_memory_candidates
       SET created_at = now() - interval '31 days'
     WHERE user_id = 'owner-expiry';
    expired := public.sophia_memory_expire_candidates(50);
    IF expired <> 1 THEN
        RAISE EXCEPTION 'candidate expiry did not select exactly one row';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.sophia_memory_candidate_versions
         WHERE user_id = 'owner-expiry'
           AND (proposed_content IS NOT NULL OR content_ref IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'expired candidate plaintext was not scrubbed';
    END IF;
END
$test$;

DO $test$
BEGIN
    IF has_table_privilege('anon', 'public.sophia_memories', 'SELECT')
       OR has_table_privilege('authenticated', 'public.sophia_memories', 'SELECT')
       OR has_table_privilege('authenticated', 'public.sophia_memory_candidates', 'INSERT') THEN
        RAISE EXCEPTION 'browser role retained direct memory-table access';
    END IF;
    IF NOT has_table_privilege('service_role', 'public.sophia_memories', 'SELECT') THEN
        RAISE EXCEPTION 'service role lacks canonical read privilege';
    END IF;
    IF has_table_privilege('anon', 'public.sophia_memory_certification_cleanup_v', 'SELECT')
       OR has_table_privilege('authenticated', 'public.sophia_memory_retrieval_authorization_v', 'SELECT') THEN
        RAISE EXCEPTION 'browser role retained operational-view access';
    END IF;
    IF NOT has_table_privilege('service_role', 'public.sophia_memory_certification_cleanup_v', 'SELECT') THEN
        RAISE EXCEPTION 'service role lacks certification cleanup view access';
    END IF;
    IF has_table_privilege('authenticated', 'public.sophia_memory_fault_settings', 'SELECT')
       OR has_function_privilege('authenticated', 'public.sophia_memory_arm_fault(text,text,integer,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'browser role retained fault-plane access';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.sophia_memory_arm_fault(text,text,integer,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'service role lacks fault-plane control';
    END IF;
END
$test$;

DO $test$
DECLARE
    receipt JSONB;
    cleared INTEGER;
BEGIN
    receipt := public.sophia_memory_arm_fault(
        'owner-authority', 'provider_timeout_before_effect', 60,
        'hmac-sha256:fault-operation:synthetic'
    );
    IF receipt->>'remaining_uses' <> '1'
       OR NOT public.sophia_memory_consume_fault(
           'owner-authority', 'provider_timeout_before_effect'
       )
       OR public.sophia_memory_consume_fault(
           'owner-authority', 'provider_timeout_before_effect'
       ) THEN
        RAISE EXCEPTION 'fault setting was not exactly one-shot';
    END IF;
    PERFORM public.sophia_memory_arm_fault(
        'owner-authority', 'langsmith_unavailable', 60,
        'hmac-sha256:fault-operation:cleanup'
    );
    cleared := public.sophia_memory_clear_faults('owner-authority');
    IF cleared < 1 OR EXISTS (
           SELECT 1 FROM public.sophia_memory_fault_settings
            WHERE user_id = 'owner-authority'
              AND remaining_uses > 0 AND cleared_at IS NULL AND expires_at > now()
       ) THEN
        RAISE EXCEPTION 'fault cleanup did not reach terminal zero';
    END IF;
END
$test$;

DO $test$
DECLARE
    run public.sophia_memory_extraction_runs;
    replay public.sophia_memory_extraction_runs;
BEGIN
    INSERT INTO public.sophia_sessions(
        id, user_id, thread_id, mode, status, message_revision,
        memory_processed_until_sequence
    ) VALUES (
        'session-atomic-finalize', 'owner-atomic-finalize', 'thread-atomic-finalize',
        'text', 'active', 3, 0
    );
    INSERT INTO public.sophia_session_messages(
        id, message_id, session_id, user_id, thread_id, role, content,
        final, sequence
    ) VALUES
        ('atomic-message-1', 'atomic-message-1', 'session-atomic-finalize',
         'owner-atomic-finalize', 'thread-atomic-finalize', 'user',
         'SYNTHETIC-ATOMIC-ONE', true, 1),
        ('atomic-message-2', 'atomic-message-2', 'session-atomic-finalize',
         'owner-atomic-finalize', 'thread-atomic-finalize', 'assistant',
         'SYNTHETIC-ATOMIC-TWO', true, 2);

    run := public.sophia_memory_finalize_and_enqueue_extraction(
        'owner-atomic-finalize', 'session-atomic-finalize', 'thread-atomic-finalize',
        '2026-09-02T19:00:00+00:00'::timestamptz,
        'atomic-finalize-key', 'atomic-finalize-digest', 'text', 3, 1, 2,
        'hmac-sha256:manifest:atomic-finalize', 'mem00.extract.v1',
        'synthetic-model', 'synthetic-prompt'
    );
    replay := public.sophia_memory_finalize_and_enqueue_extraction(
        'owner-atomic-finalize', 'session-atomic-finalize', 'thread-atomic-finalize',
        '2026-09-02T19:05:00+00:00'::timestamptz,
        'atomic-finalize-key', 'atomic-finalize-digest', 'text', 3, 1, 2,
        'hmac-sha256:manifest:atomic-finalize', 'mem00.extract.v1',
        'synthetic-model', 'synthetic-prompt'
    );
    IF run.extraction_run_id <> replay.extraction_run_id THEN
        RAISE EXCEPTION 'atomic finalization replay created a second extraction run';
    END IF;
    IF (SELECT status FROM public.sophia_sessions WHERE id = 'session-atomic-finalize') <> 'ended'
       OR (SELECT ended_at FROM public.sophia_sessions WHERE id = 'session-atomic-finalize')
          <> '2026-09-02T19:00:00+00:00'::timestamptz THEN
        RAISE EXCEPTION 'session finalization and extraction enqueue did not commit together';
    END IF;

    BEGIN
        PERFORM public.sophia_memory_finalize_and_enqueue_extraction(
            'owner-atomic-finalize', 'session-atomic-finalize', 'thread-atomic-finalize',
            '2026-09-02T19:00:00+00:00'::timestamptz,
            'atomic-finalize-bad-range', 'atomic-finalize-bad-range-digest',
            'text', 3, 2, 2, 'hmac-sha256:manifest:bad-range',
            'mem00.extract.v1', 'synthetic-model', 'synthetic-prompt'
        );
        RAISE EXCEPTION 'mismatched durable range unexpectedly finalized';
    EXCEPTION WHEN serialization_failure THEN
        NULL;
    END;
END
$test$;

DO $test$
DECLARE
    first_create JSONB;
    second_create JSONB;
    late_create JSONB;
    first_lease RECORD;
    second_lease RECORD;
    late_lease RECORD;
    second_completion JSONB;
    late_completion JSONB;
    governance public.sophia_memory_user_governance;
    admission_id UUID;
BEGIN
    DELETE FROM public.sophia_memory_projection_jobs;

    first_create := public.sophia_memory_manual_create(
        'owner-projection', 'SYNTHETIC-PROJECTION-A', 'hmac-sha256:projection:a',
        'fact', 'work', 'none', 'user', 'create-projection-a', 'digest-projection-a',
        'mem0', 'production', 'existing-project'
    );
    second_create := public.sophia_memory_manual_create(
        'owner-projection', 'SYNTHETIC-PROJECTION-B', 'hmac-sha256:projection:b',
        'fact', 'global', 'none', 'user', 'create-projection-b', 'digest-projection-b',
        'mem0', 'production', 'existing-project'
    );
    SELECT * INTO STRICT first_lease FROM public.sophia_memory_claim_projection('projection-claimant-a', 120);
    PERFORM public.sophia_memory_complete_projection(
        'owner-projection', first_lease.projection_job_id, first_lease.lease_token,
        'active', '["provider-collision-id"]'::jsonb, true,
        'created', NULL, 'projection_verified'
    );
    SELECT * INTO STRICT governance
      FROM public.sophia_memory_user_governance
     WHERE user_id = 'owner-projection';
    admission_id := public.sophia_memory_record_prompt_admission(
        gen_random_uuid(), 'owner-projection', 'text', 'work',
        'hmac-sha256:query:projection', 'mem0', 'production',
        'existing-project', governance.provider_subject, 'ok', 1,
        governance.user_catalog_generation, governance.user_revocation_epoch,
        jsonb_build_array(jsonb_build_object(
            'memory_id', first_create->>'memory_id',
            'content_revision', 1,
            'memory_governance_revision', 1
        )), '{}'::jsonb, 'authorized', NULL, '{"provider_ms":1}'::jsonb
    );
    IF admission_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.sophia_memory_prompt_admissions
         WHERE prompt_admission_id = admission_id
    ) THEN
        RAISE EXCEPTION 'atomic prompt admission was not recorded';
    END IF;
    BEGIN
        PERFORM public.sophia_memory_record_prompt_admission(
            gen_random_uuid(), 'owner-projection', 'builder_context', 'life',
            'hmac-sha256:query:wrong-scope', 'mem0', 'production',
            'existing-project', governance.provider_subject, 'ok', 1,
            governance.user_catalog_generation, governance.user_revocation_epoch,
            jsonb_build_array(jsonb_build_object(
                'memory_id', first_create->>'memory_id',
                'content_revision', 1,
                'memory_governance_revision', 1
            )), '{"scope_denied":1}'::jsonb, 'authorized', NULL, '{}'::jsonb
        );
        RAISE EXCEPTION 'wrong-scope prompt admission unexpectedly succeeded';
    EXCEPTION WHEN serialization_failure THEN
        NULL;
    END;
    SELECT * INTO STRICT second_lease FROM public.sophia_memory_claim_projection('projection-claimant-b', 120);
    second_completion := public.sophia_memory_complete_projection(
        'owner-projection', second_lease.projection_job_id, second_lease.lease_token,
        'active', '["provider-collision-id"]'::jsonb, true,
        'created', NULL, 'projection_verified'
    );
    IF second_completion->>'state' <> 'orphaned'
       OR (SELECT count(*) FROM public.sophia_memory_provider_bindings
            WHERE user_id = 'owner-projection'
              AND provider_memory_id = 'provider-collision-id'
              AND binding_state = 'reconciliation_hold'
              AND metadata_verification_state = 'conflict') <> 2 THEN
        RAISE EXCEPTION 'provider ID collision did not hold both bindings';
    END IF;
    BEGIN
        PERFORM public.sophia_memory_record_prompt_admission(
            gen_random_uuid(), 'owner-projection', 'text', 'work',
            'hmac-sha256:query:held', 'mem0', 'production',
            'existing-project', governance.provider_subject, 'ok', 1,
            governance.user_catalog_generation, governance.user_revocation_epoch,
            jsonb_build_array(jsonb_build_object(
                'memory_id', first_create->>'memory_id',
                'content_revision', 1,
                'memory_governance_revision', 1
            )), '{}'::jsonb, 'authorized', NULL, '{}'::jsonb
        );
        RAISE EXCEPTION 'prompt admission accepted a held binding';
    EXCEPTION WHEN serialization_failure THEN
        NULL;
    END;

    DELETE FROM public.sophia_memory_projection_jobs;
    late_create := public.sophia_memory_manual_create(
        'owner-late', 'SYNTHETIC-LATE-PROJECTION', 'hmac-sha256:projection:late',
        'fact', 'global', 'none', 'user', 'create-late', 'digest-create-late',
        'mem0', 'production', 'existing-project'
    );
    SELECT * INTO STRICT late_lease FROM public.sophia_memory_claim_projection('projection-claimant-late', 120);
    PERFORM public.sophia_memory_tombstone(
        'owner-late', (late_create->>'memory_id')::uuid, 1,
        'user', 'delete-late', 'digest-delete-late'
    );
    late_completion := public.sophia_memory_complete_projection(
        'owner-late', late_lease.projection_job_id, late_lease.lease_token,
        'active', '["provider-late-id"]'::jsonb, true,
        'created_after_tombstone', NULL, 'late_projection_fenced'
    );
    IF late_completion->>'eligible' <> 'false'
       OR NOT EXISTS (
           SELECT 1 FROM public.sophia_memory_provider_bindings
            WHERE user_id = 'owner-late'
              AND provider_memory_id = 'provider-late-id'
              AND binding_state = 'orphaned'
       )
       OR NOT EXISTS (
           SELECT 1 FROM public.sophia_memory_projection_jobs
            WHERE user_id = 'owner-late'
              AND operation = 'purge_binding'
              AND state = 'purge_queued'
       ) THEN
        RAISE EXCEPTION 'late provider success escaped tombstone fencing';
    END IF;
END
$test$;
