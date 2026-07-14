-- Read-only production-target verification plus a rolled-back RPC probe.

WITH expected(table_name) AS (
    VALUES
        ('telegram_user_bindings'),
        ('sophia_sessions'),
        ('sophia_session_messages'),
        ('artifact_registry_records'),
        ('sophia_build_manifest_heads'),
        ('sophia_build_registry'),
        ('sophia_build_operation_events'),
        ('sophia_build_acceptance_outbox'),
        ('sophia_build_mutation_transactions'),
        ('user'),
        ('session'),
        ('account'),
        ('verification')
), present AS (
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
)
SELECT
    count(*) FILTER (WHERE present.table_name IS NOT NULL) AS present_count,
    array_agg(expected.table_name ORDER BY expected.table_name)
        FILTER (WHERE present.table_name IS NULL) AS missing_tables
FROM expected
LEFT JOIN present USING (table_name);

SELECT
    to_regprocedure(
        'public.sophia_commit_build_manifest(text,text,text,bigint,text,text,text,text,text,text,text,jsonb)'
    ) IS NOT NULL AS commit_manifest_rpc_present,
    to_regprocedure(
        'public.sophia_append_build_event(text,text,text,text,timestamptz,jsonb)'
    ) IS NOT NULL AS append_event_rpc_present;

SELECT
    id,
    public = false AS private,
    file_size_limit,
    allowed_mime_types
FROM storage.buckets
WHERE id = 'sophia-builder-artifacts';

SELECT
    count(*) = 4 AS service_role_bucket_policies_present
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname LIKE 'sophia_builder_artifacts_service_role_%';

SELECT
    has_table_privilege('service_role', 'public.sophia_build_operation_events', 'SELECT')
        AS service_role_event_replay,
    has_function_privilege(
        'service_role',
        'public.sophia_append_build_event(text,text,text,text,timestamptz,jsonb)',
        'EXECUTE'
    ) AS service_role_append_rpc,
    NOT has_table_privilege('anon', 'public.sophia_sessions', 'SELECT')
        AS anon_sessions_denied,
    NOT has_table_privilege('authenticated', 'public.artifact_registry_records', 'SELECT')
        AS authenticated_artifacts_denied,
    NOT has_table_privilege('service_role', 'public."user"', 'SELECT')
        AS service_role_better_auth_denied,
    has_table_privilege('better_auth_app', 'public."user"', 'SELECT')
        AS better_auth_user_read,
    has_table_privilege('better_auth_app', 'public."session"', 'INSERT')
        AS better_auth_session_write,
    NOT has_table_privilege(
        'better_auth_app',
        'public.sophia_build_operation_events',
        'SELECT'
    ) AS better_auth_builder_events_denied;

BEGIN;
SET LOCAL ROLE service_role;
SELECT public.sophia_append_build_event(
    'migration-readiness-probe',
    'migration-readiness-probe-event',
    'migration-readiness-probe-user',
    'migration.readiness',
    now(),
    '{"probe":true}'::jsonb
);
SELECT count(*) = 1 AS append_and_replay_probe_ok
FROM public.sophia_build_operation_events
WHERE build_id = 'migration-readiness-probe'
  AND event_id = 'migration-readiness-probe-event';
ROLLBACK;
