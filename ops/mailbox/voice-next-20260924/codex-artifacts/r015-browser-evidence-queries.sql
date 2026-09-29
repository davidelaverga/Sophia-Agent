-- Read-only, content-free evidence for the user's new supervised browser pass.
-- No owner IDs, message text, receipt payloads or secrets are selected.

WITH s AS (
  SELECT id, user_id, thread_id, message_revision
  FROM public.sophia_sessions
  WHERE id='ac600ec5-d485-4804-ac49-399688558089'
    AND thread_id='01a0eed8-b725-7743-9d34-e12ed0a84e24'
), r AS (
  SELECT s.thread_id, s.message_revision, e.user_id, e.source_session_id,
         e.source_intake_receipt rc
  FROM public.sophia_memory_governance_events e
  JOIN s ON s.id=e.source_session_id AND s.user_id=e.user_id
  WHERE e.event_type='memory_source_action_accepted'
)
SELECT r.thread_id, r.rc->>'created_at' AS receipt_created_at,
       (r.rc->>'sequence')::bigint AS receipt_seq,
       r.message_revision-(r.rc->>'transcript_revision')::bigint AS revisions_since_intake,
       (r.rc->>'memory_clear_epoch')::bigint AS receipt_epoch,
       m.id IS NOT NULL AS row_exists,
       m.memory_source_version::text=r.rc->>'source_version' AS version_equal,
       m.sequence=(r.rc->>'sequence')::bigint AS sequence_equal,
       m.created_at=(r.rc->>'created_at')::timestamptz AS created_at_equal,
       m.created_at=date_trunc('milliseconds',(r.rc->>'created_at')::timestamptz) AS created_at_ms_truncated,
       m.memory_source_acceptance_epoch=(r.rc->>'memory_clear_epoch')::bigint AS epoch_equal,
       m.source, m.final,
       m.metadata='{"redaction_level":"none"}'::jsonb AS metadata_unchanged,
       m.thread_id=r.rc->>'thread_id' AS thread_equal,
       (SELECT count(*) FROM public.sophia_session_messages x
        WHERE x.user_id=r.user_id AND x.session_id=r.source_session_id
          AND x.message_id=r.rc->>'message_id') AS rows_with_message_id
FROM r
LEFT JOIN public.sophia_session_messages m ON m.id=r.rc->>'source_row_id'
ORDER BY (r.rc->>'created_at')::timestamptz;

SELECT 'source_action_receipts' AS evidence, count(*) AS row_count
FROM public.sophia_memory_governance_events e
WHERE e.source_session_id='ac600ec5-d485-4804-ac49-399688558089'
  AND e.event_type='memory_source_action_accepted'
UNION ALL
SELECT 'builder_handoff_receipts', count(*)
FROM public.sophia_memory_governance_events e
WHERE e.builder_source_receipt->>'schema'='mem00.builder-source-handoff-receipt.v1'
  AND e.builder_source_receipt->'request'->>'parent_thread_id'='01a0eed8-b725-7743-9d34-e12ed0a84e24'
UNION ALL
SELECT 'builder_child_run_bindings', count(*)
FROM public.sophia_memory_governance_events e
WHERE e.builder_source_receipt->>'schema'='mem00.builder-source-run.v1'
  AND e.builder_source_receipt->>'parent_thread_id'='01a0eed8-b725-7743-9d34-e12ed0a84e24'
UNION ALL
SELECT 'build_registry_records', count(*)
FROM public.sophia_build_registry
WHERE owner_thread_id='01a0eed8-b725-7743-9d34-e12ed0a84e24'
UNION ALL
SELECT 'builder_artifact_records', count(*)
FROM public.artifact_registry_records
WHERE source='builder' AND (
  thread_id='01a0eed8-b725-7743-9d34-e12ed0a84e24'
  OR parent_thread_id='01a0eed8-b725-7743-9d34-e12ed0a84e24'
);

-- If handoffs/bindings exist, IDs + fixed schema + timestamps only:
SELECT e.event_type,
       e.builder_source_receipt->>'schema' AS receipt_schema,
       e.builder_source_receipt->>'child_thread_id' AS child_thread_id,
       e.builder_source_receipt->>'child_run_id' AS child_run_id,
       coalesce(e.builder_source_receipt->>'parent_run_id',
                e.builder_source_receipt->'request'->>'parent_run_id') AS parent_run_id,
       e.builder_source_receipt->>'accepted_at' AS accepted_at
FROM public.sophia_memory_governance_events e
WHERE (e.builder_source_receipt->>'parent_thread_id'='01a0eed8-b725-7743-9d34-e12ed0a84e24'
       OR e.builder_source_receipt->'request'->>'parent_thread_id'='01a0eed8-b725-7743-9d34-e12ed0a84e24')
  AND e.builder_source_receipt->>'schema' IN (
    'mem00.builder-source-handoff-receipt.v1','mem00.builder-source-run.v1'
  );

-- Handoff RPC identity/grant inspection only; never invoke these mutating RPCs.
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role_execute,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
  'sophia_memory_register_builder_handoff',
  'sophia_memory_get_builder_handoff',
  'sophia_memory_bind_builder_source_run',
  'sophia_memory_get_builder_source_run_for_handoff'
)
ORDER BY p.proname;

-- Candidate prompt-admission metadata in the supervised pass's bounded window.
-- These records are owner/time scoped, not inherently tied to a specific run;
-- correlate their IDs with existing log refs before treating one as its handoff.
SELECT p.prompt_admission_id, p.created_at, p.caller, p.scope,
       p.provider_status, p.outcome, p.safe_reason_code,
       p.availability_context IS NOT NULL AS availability_context_present,
       jsonb_array_length(p.authorized_manifest) AS authorized_count,
       p.catalog_generation_checked=g.user_catalog_generation AS catalog_equal_now,
       p.revocation_epoch_checked=g.user_revocation_epoch AS revocation_equal_now
FROM public.sophia_memory_prompt_admissions p
JOIN public.sophia_sessions s ON s.user_id=p.user_id
JOIN public.sophia_memory_user_governance g ON g.user_id=p.user_id
WHERE s.id='ac600ec5-d485-4804-ac49-399688558089'
  AND s.thread_id='01a0eed8-b725-7743-9d34-e12ed0a84e24'
  AND p.created_at >= '2026-09-29T20:27:14Z'::timestamptz
  AND p.created_at <= '2026-09-29T20:28:04Z'::timestamptz
ORDER BY p.created_at;
