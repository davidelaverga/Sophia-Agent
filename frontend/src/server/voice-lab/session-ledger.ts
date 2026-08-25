import { createHash, createHmac, randomUUID } from 'node:crypto';

import type {
  PoolClient,
  QueryConfigValues,
  QueryResult,
  QueryResultRow,
} from 'pg';

import { getBetterAuthDatabase } from '@/server/better-auth/database';
import {
  type VoiceLabCapabilityClaims,
  VoiceLabCapabilityError,
} from '@/server/voice-lab/capability';

const MARKER_PREFIX = 'sophia-voice-lab-session-v1.';
const AUTH_LEDGER_TABLE = 'sophia_voice_lab_auth_grants';
const AUTH_TOMBSTONE_DOMAIN = 'sophia-voice-lab-auth-tombstone-v1';
const REDACTED_SHA256 = '0'.repeat(64);
const EXPECTED_DATABASE_OWNER_ROLE = 'postgres';
const EXPECTED_RUNTIME_DATABASE_ROLE = 'better_auth_app';
const ROLE_MEMBERSHIP_CONTRACT_VERSION =
  'supabase_pg17.directional_membership.v1';

function roleMembershipAttestationSql(): string {
  return `
    '${ROLE_MEMBERSHIP_CONTRACT_VERSION}' AS membership_contract_version,
    (
      SELECT count(*) <= 1
         AND count(*) FILTER (
           WHERE NOT (
             membership.roleid = role.oid
             AND member_role.rolname = 'postgres'
             AND grantor_role.rolname = 'supabase_admin'
             AND membership.admin_option = true
             AND membership.inherit_option = false
             AND membership.set_option = false
           )
         ) = 0
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles member_role
          ON member_role.oid = membership.member
        JOIN pg_catalog.pg_roles grantor_role
          ON grantor_role.oid = membership.grantor
       WHERE membership.member = role.oid
          OR membership.roleid = role.oid
    ) AS membership_direction_attested,
    (
      SELECT count(*)
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles member_role
          ON member_role.oid = membership.member
        JOIN pg_catalog.pg_roles grantor_role
          ON grantor_role.oid = membership.grantor
       WHERE membership.roleid = role.oid
         AND member_role.rolname = 'postgres'
         AND grantor_role.rolname = 'supabase_admin'
         AND membership.admin_option = true
         AND membership.inherit_option = false
         AND membership.set_option = false
    ) AS canonical_inbound_membership_count,
    (
      SELECT count(*) FROM pg_catalog.pg_auth_members membership
       WHERE membership.member = role.oid
    ) AS outbound_membership_count,
    NOT EXISTS (
      WITH RECURSIVE inherited_roles(role_oid) AS (
        SELECT membership.roleid
          FROM pg_catalog.pg_auth_members membership
         WHERE membership.member = role.oid
        UNION
        SELECT membership.roleid
          FROM pg_catalog.pg_auth_members membership
          JOIN inherited_roles inherited
            ON membership.member = inherited.role_oid
      )
      SELECT 1 FROM inherited_roles
    ) AS transitive_authority_free`;
}
export const VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256 =
  '42e6f2b3bf083675bcdd7b2f29c66b400c6fca9771b76f866e6c55f8513b514c';
export const VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256 =
  '191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44';
const EXPECTED_AUTH_LEDGER_TABLE_COMMENT =
  `sophia.voice-lab.auth-ledger.v1 migration_sha256=${VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256}`;
const EXPECTED_AUTH_LEDGER_COLUMNS = new Map<string, readonly [string, 'YES' | 'NO']>([
  ['grant_fingerprint', ['bpchar', 'NO']],
  ['principal_id', ['text', 'NO']],
  ['test_run_id', ['text', 'NO']],
  ['tombstone_kid', ['text', 'NO']],
  ['cleanup_obligation_id', ['text', 'NO']],
  ['issued_at', ['int8', 'NO']],
  ['expires_at', ['timestamptz', 'NO']],
  ['provider_expires_at', ['timestamptz', 'NO']],
  ['retention_hours', ['int4', 'NO']],
  ['jti_sha256', ['bpchar', 'NO']],
  ['nonce_sha256', ['bpchar', 'NO']],
  ['session_token_sha256', ['bpchar', 'NO']],
  ['status', ['text', 'NO']],
  ['created_at', ['timestamptz', 'NO']],
  ['revoked_at', ['timestamptz', 'YES']],
]);
const EXPECTED_AUTH_LEDGER_DEFAULTS = new Map([
  ['created_at', 'now()'],
]);
const EXPECTED_AUTH_LEDGER_INDEXES = new Map([
  ['sophia_voice_lab_auth_grants_pkey', { table: AUTH_LEDGER_TABLE, unique: true, expressions: ['grant_fingerprint'], options: [0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_principal_order_idx', { table: AUTH_LEDGER_TABLE, unique: false, expressions: ['principal_id', 'issued_at'], options: [0, 3], predicate: '' }],
  ['sophia_voice_lab_auth_grants_expiry_idx', { table: AUTH_LEDGER_TABLE, unique: false, expressions: ['expires_at'], options: [0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_cleanup_obligation_idx', { table: AUTH_LEDGER_TABLE, unique: false, expressions: ['cleanup_obligation_id'], options: [0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_tombstone_kid_expiry_idx', { table: AUTH_LEDGER_TABLE, unique: false, expressions: ['tombstone_kid', 'expires_at'], options: [0, 0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_active_cleanup_idx', { table: AUTH_LEDGER_TABLE, unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: "status='active'" }],
]);
const EXPECTED_AUTH_LEDGER_CONSTRAINTS = new Map([
  ['sophia_voice_lab_auth_grants_pkey', ['p', 'PRIMARY KEY (grant_fingerprint)']],
  ['sophia_voice_lab_auth_grants_grant_fingerprint_check', ['c', "CHECK (grant_fingerprint ~ '^[a-f0-9]{64}$'::text)"]],
  ['sophia_voice_lab_auth_grants_tombstone_kid_check', ['c', "CHECK (tombstone_kid ~ '^[A-Za-z0-9._-]{1,32}$'::text)"]],
  ['sophia_voice_lab_auth_grants_cleanup_obligation_check', ['c', "CHECK (cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text OR cleanup_obligation_id ~ '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'::text)"]],
  ['sophia_voice_lab_auth_grants_retention_hours_check', ['c', 'CHECK (retention_hours >= 1 AND retention_hours <= 168)']],
  ['sophia_voice_lab_auth_grants_jti_sha256_check', ['c', "CHECK (jti_sha256 ~ '^[a-f0-9]{64}$'::text)"]],
  ['sophia_voice_lab_auth_grants_nonce_sha256_check', ['c', "CHECK (nonce_sha256 ~ '^[a-f0-9]{64}$'::text)"]],
  ['sophia_voice_lab_auth_grants_session_token_sha256_check', ['c', "CHECK (session_token_sha256 ~ '^[a-f0-9]{64}$'::text)"]],
  ['sophia_voice_lab_auth_grants_status_check', ['c', "CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text]))"]],
]);
const EXPECTED_PRODUCT_CLEANUP_INDEXES = new Map([
  ['sophia_sessions_voice_lab_cleanup_obligation_idx', {
    table: 'sophia_sessions',
    unique: true,
    keyCount: 1,
    expressions: ["metadata->'synthetic_voice_lab'->>'cleanup_obligation_id'"],
    options: [0],
    predicate: "metadata->'synthetic_voice_lab'->>'synthetic'='true'andmetadata->'synthetic_voice_lab'->>'cleanup_obligation_id'isnotnull",
    comment: `sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} resource=sessions`,
  }],
  ['artifact_registry_voice_lab_cleanup_obligation_idx', {
    table: 'artifact_registry_records',
    unique: false,
    keyCount: 2,
    expressions: ["record_payload->>'cleanup_obligation_id'", 'artifact_id'],
    options: [0, 0],
    predicate: "record_payload->>'synthetic_test'='true'andrecord_payload->>'cleanup_obligation_id'isnotnull",
    comment: `sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} resource=artifacts`,
  }],
]);
const EXPECTED_PRODUCT_CLEANUP_TRIGGERS = new Map([
  ['sophia_voice_lab_cleanup_write_fence', {
    table: 'sophia_sessions',
    functionName: 'sophia_voice_lab_cleanup_write_fence',
    commentKind: 'cleanup-obligation-write-fence',
    definition: 'CREATE TRIGGER sophia_voice_lab_cleanup_write_fence BEFORE INSERT OR DELETE OR UPDATE ON sophia_sessions FOR EACH ROW EXECUTE FUNCTION sophia_voice_lab_cleanup_write_fence()',
  }],
  ['sophia_voice_lab_message_write_fence', {
    table: 'sophia_session_messages',
    functionName: 'sophia_voice_lab_message_write_fence',
    commentKind: 'cleanup-obligation-message-write-fence',
    definition: 'CREATE TRIGGER sophia_voice_lab_message_write_fence BEFORE INSERT OR DELETE OR UPDATE ON sophia_session_messages FOR EACH ROW EXECUTE FUNCTION sophia_voice_lab_message_write_fence()',
  }],
  ['artifact_registry_voice_lab_cleanup_write_fence', {
    table: 'artifact_registry_records',
    functionName: 'sophia_voice_lab_cleanup_write_fence',
    commentKind: 'cleanup-obligation-write-fence',
    definition: 'CREATE TRIGGER artifact_registry_voice_lab_cleanup_write_fence BEFORE INSERT OR DELETE OR UPDATE ON artifact_registry_records FOR EACH ROW EXECUTE FUNCTION sophia_voice_lab_cleanup_write_fence()',
  }],
  ['sophia_voice_lab_auth_cleanup_write_fence', {
    table: 'sophia_voice_lab_auth_grants',
    functionName: 'sophia_voice_lab_cleanup_write_fence',
    commentKind: 'cleanup-obligation-write-fence',
    definition: 'CREATE TRIGGER sophia_voice_lab_auth_cleanup_write_fence BEFORE INSERT OR DELETE OR UPDATE ON sophia_voice_lab_auth_grants FOR EACH ROW EXECUTE FUNCTION sophia_voice_lab_cleanup_write_fence()',
  }],
]);
const EXPECTED_REQUIRED_PRODUCT_COLUMNS = new Map([
  ['sophia_sessions', new Map([
    ['id', ['text', 'NO']], ['user_id', ['text', 'NO']],
    ['thread_id', ['text', 'NO']], ['run_id', ['text', 'YES']],
    ['mode', ['text', 'NO']], ['metadata', ['jsonb', 'NO']],
    ['status', ['text', 'NO']], ['ended_at', ['timestamptz', 'YES']],
    ['message_revision', ['int8', 'NO']], ['message_count', ['int4', 'NO']],
    ['transcript_available', ['bool', 'NO']],
    ['created_at', ['timestamptz', 'NO']], ['updated_at', ['timestamptz', 'NO']],
  ])],
  ['sophia_session_messages', new Map([
    ['id', ['text', 'NO']], ['message_id', ['text', 'NO']],
    ['session_id', ['text', 'NO']], ['user_id', ['text', 'NO']],
    ['thread_id', ['text', 'NO']], ['role', ['text', 'NO']],
    ['content', ['text', 'NO']], ['source', ['text', 'NO']],
    ['final', ['bool', 'NO']], ['approximate', ['bool', 'NO']],
    ['turn_id', ['text', 'YES']], ['provider_event_id', ['text', 'YES']],
    ['sequence', ['int4', 'NO']], ['created_at', ['timestamptz', 'NO']],
    ['metadata', ['jsonb', 'NO']],
  ])],
  ['artifact_registry_records', new Map([
    ['artifact_id', ['text', 'NO']], ['record_payload', ['jsonb', 'NO']],
  ])],
] as const);
const EXPECTED_PRODUCT_TABLES = [...EXPECTED_REQUIRED_PRODUCT_COLUMNS.keys()];
const EXPECTED_SESSION_MESSAGES_FK = {
  definition: 'FOREIGN KEY (session_id) REFERENCES sophia_sessions(id) ON DELETE CASCADE',
  triggers: new Set([
    'sophia_session_messages.RI_FKey_check_ins',
    'sophia_session_messages.RI_FKey_check_upd',
    'sophia_sessions.RI_FKey_cascade_del',
    'sophia_sessions.RI_FKey_noaction_upd',
  ]),
};
const EXPECTED_CLEANUP_ADMISSIONS_FK = {
  triggers: new Set([
    'sophia_voice_lab_cleanup_admissions.RI_FKey_check_ins',
    'sophia_voice_lab_cleanup_admissions.RI_FKey_check_upd',
    'sophia_voice_lab_cleanup_obligations.RI_FKey_noaction_del',
    'sophia_voice_lab_cleanup_obligations.RI_FKey_noaction_upd',
  ]),
};
const EXPECTED_PRODUCT_PRIMARY_KEYS = new Map([
  ['sophia_sessions.sophia_sessions_pkey', 'PRIMARY KEY (id)'],
  ['sophia_session_messages.sophia_session_messages_pkey', 'PRIMARY KEY (id)'],
  ['artifact_registry_records.artifact_registry_records_pkey', 'PRIMARY KEY (artifact_id)'],
]);
const EXPECTED_BETTER_AUTH_SESSION_COLUMNS = new Map<
  string,
  readonly [string, 'YES' | 'NO']
>([
  ['id', ['text', 'NO']],
  ['expiresAt', ['timestamptz', 'NO']],
  ['token', ['text', 'NO']],
  ['createdAt', ['timestamptz', 'NO']],
  ['updatedAt', ['timestamptz', 'NO']],
  ['ipAddress', ['text', 'YES']],
  ['userAgent', ['text', 'YES']],
  ['userId', ['text', 'NO']],
]);
const EXPECTED_BETTER_AUTH_SESSION_INDEXES = new Map([
  ['session_pkey', { unique: true, expressions: ['id'], options: [0] }],
  ['session_token_key', { unique: true, expressions: ['token'], options: [0] }],
  ['session_userId_idx', { unique: false, expressions: ['"userid"'], options: [0] }],
] as const);
const EXPECTED_BETTER_AUTH_SESSION_KEY_CONSTRAINTS = new Map([
  ['session_pkey', ['p', 'PRIMARY KEY (id)']],
  ['session_token_key', ['u', 'UNIQUE (token)']],
] as const);
const EXPECTED_CLEANUP_CONTROL_COLUMNS = new Map([
  ['sophia_voice_lab_cleanup_obligations', new Map([
    ['cleanup_obligation_id', ['text', 'NO']], ['state', ['text', 'NO']],
    ['lifecycle_phase', ['text', 'NO']],
    ['retention_expires_at', ['timestamptz', 'NO']],
    ['provider_expires_at', ['timestamptz', 'NO']],
    ['provider_settlement_sha256', ['text', 'YES']],
    ['created_at', ['timestamptz', 'NO']],
    ['updated_at', ['timestamptz', 'NO']], ['closed_at', ['timestamptz', 'YES']],
    ['live_cleanup_completed_at', ['timestamptz', 'YES']],
    ['completed_at', ['timestamptz', 'YES']], ['purge_after', ['timestamptz', 'YES']],
  ])],
  ['sophia_voice_lab_cleanup_admissions', new Map([
    ['admission_id', ['uuid', 'NO']], ['cleanup_obligation_id', ['text', 'NO']],
    ['resource_kind', ['text', 'NO']], ['resource_id', ['text', 'NO']],
    ['status', ['text', 'NO']],
    ['lease_expires_at', ['timestamptz', 'NO']],
    ['resource_expires_at', ['timestamptz', 'NO']],
    ['created_at', ['timestamptz', 'NO']],
    ['updated_at', ['timestamptz', 'NO']],
  ])],
  ['sophia_voice_lab_cleanup_scan_cursors', new Map([
    ['cursor_name', ['text', 'NO']],
    ['cursor_due_at', ['timestamptz', 'YES']],
    ['cursor_source', ['text', 'YES']],
    ['cursor_cleanup_obligation_id', ['text', 'YES']],
    ['cursor_admission_id', ['uuid', 'YES']],
    ['window_due_at', ['timestamptz', 'YES']],
    ['window_source', ['text', 'YES']],
    ['window_cleanup_obligation_id', ['text', 'YES']],
    ['window_admission_id', ['uuid', 'YES']],
    ['updated_at', ['timestamptz', 'NO']],
  ])],
] as const);
const EXPECTED_CLEANUP_CONTROL_DEFAULTS = new Map([
  ['sophia_voice_lab_cleanup_obligations.state', "'open'"],
  ['sophia_voice_lab_cleanup_obligations.lifecycle_phase', "'auth_provisional'"],
  ['sophia_voice_lab_cleanup_obligations.created_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_obligations.updated_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_admissions.status', "'reserved'"],
  ['sophia_voice_lab_cleanup_admissions.created_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_admissions.updated_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_scan_cursors.updated_at', 'clock_timestamp()'],
]);
const EXPECTED_RUNTIME_CLEANUP_CONTROL_PRIVILEGES = new Map([
  ['sophia_voice_lab_cleanup_obligations', {
    select: true, insert: true, update: true, delete: true,
  }],
  ['sophia_voice_lab_cleanup_admissions', {
    select: true, insert: true, update: true, delete: true,
  }],
  ['sophia_voice_lab_cleanup_scan_cursors', {
    select: true, insert: false, update: true, delete: false,
  }],
] as const);
const EXPECTED_RUNTIME_PRODUCT_PRIVILEGES = new Map([
  ['sophia_sessions', {
    select: true, insert: false, update: true, delete: false,
  }],
  ['sophia_session_messages', {
    select: false, insert: false, update: false, delete: false,
  }],
  ['artifact_registry_records', {
    select: false, insert: false, update: false, delete: false,
  }],
] as const);
const EXPECTED_CLEANUP_CONTROL_INDEXES = new Map([
  ['sophia_voice_lab_cleanup_obligations_pkey', { table: 'sophia_voice_lab_cleanup_obligations', unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: '' }],
  ['sophia_voice_lab_cleanup_obligations_purge_idx', { table: 'sophia_voice_lab_cleanup_obligations', unique: false, expressions: ['purge_after', 'cleanup_obligation_id'], options: [0, 0], predicate: "state='complete'" }],
  ['sophia_voice_lab_cleanup_admissions_pkey', { table: 'sophia_voice_lab_cleanup_admissions', unique: true, expressions: ['admission_id'], options: [0], predicate: '' }],
  ['sophia_voice_lab_cleanup_admissions_obligation_idx', { table: 'sophia_voice_lab_cleanup_admissions', unique: false, expressions: ['cleanup_obligation_id', 'lease_expires_at', 'admission_id'], options: [0, 0, 0], predicate: '' }],
  ['sophia_voice_lab_cleanup_admissions_expiry_idx', { table: 'sophia_voice_lab_cleanup_admissions', unique: false, expressions: ['lease_expires_at', 'cleanup_obligation_id', 'admission_id'], options: [0, 0, 0], predicate: '' }],
  ['sophia_voice_lab_cleanup_admissions_single_provider_idx', { table: 'sophia_voice_lab_cleanup_admissions', unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: "resource_kind='provider'" }],
  ['sophia_voice_lab_cleanup_obligations_work_idx', { table: 'sophia_voice_lab_cleanup_obligations', unique: false, expressions: ["casewhenstate='closed'andlive_cleanup_completed_atisnullthenclosed_atwhenstate='closed'thenretention_expires_atelseprovider_expires_atend", 'cleanup_obligation_id'], options: [0, 0], predicate: "state<>'complete'" }],
  ['sophia_voice_lab_cleanup_scan_cursors_pkey', { table: 'sophia_voice_lab_cleanup_scan_cursors', unique: true, expressions: ['cursor_name'], options: [0], predicate: '' }],
]);
const EXPECTED_CLEANUP_CONTROL_CONSTRAINTS = new Map([
  ['sophia_voice_lab_cleanup_obligations.sophia_voice_lab_cleanup_obligations_pkey', ['p', 'PRIMARY KEY (cleanup_obligation_id)']],
  ['sophia_voice_lab_cleanup_obligations.sophia_voice_lab_cleanup_obligation_id_valid', ['c', "CHECK (cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)"]],
  ['sophia_voice_lab_cleanup_obligations.sophia_voice_lab_cleanup_obligation_state_valid', ['c', "CHECK (state = ANY (ARRAY['open'::text, 'closed'::text, 'complete'::text]))"]],
  ['sophia_voice_lab_cleanup_obligations.sophia_voice_lab_cleanup_obligation_phase_valid', ['c', "CHECK ((lifecycle_phase = ANY (ARRAY['auth_provisional'::text, 'session_provisional'::text, 'finalizing'::text, 'finalized'::text])) AND (lifecycle_phase <> 'auth_provisional'::text OR retention_expires_at = provider_expires_at) AND (lifecycle_phase <> 'finalizing'::text OR state = 'open'::text) AND (lifecycle_phase <> 'finalized'::text OR (state = ANY (ARRAY['closed'::text, 'complete'::text]))))"]],
  ['sophia_voice_lab_cleanup_obligations.sophia_voice_lab_cleanup_obligation_lifecycle_valid', ['c', "CHECK (updated_at >= created_at AND provider_expires_at <= retention_expires_at AND (provider_settlement_sha256 IS NULL OR provider_settlement_sha256 ~ '^[a-f0-9]{64}$'::text) AND (live_cleanup_completed_at IS NULL OR updated_at >= live_cleanup_completed_at) AND (state = 'open'::text AND closed_at IS NULL AND live_cleanup_completed_at IS NULL AND completed_at IS NULL AND purge_after IS NULL OR state = 'closed'::text AND closed_at IS NOT NULL AND closed_at >= created_at AND (live_cleanup_completed_at IS NULL OR live_cleanup_completed_at >= closed_at) AND completed_at IS NULL AND purge_after IS NULL OR state = 'complete'::text AND closed_at IS NOT NULL AND live_cleanup_completed_at IS NOT NULL AND live_cleanup_completed_at >= closed_at AND completed_at IS NOT NULL AND completed_at >= live_cleanup_completed_at AND purge_after IS NOT NULL AND purge_after >= (retention_expires_at + '00:10:00'::interval)))"]],
  ['sophia_voice_lab_cleanup_admissions.sophia_voice_lab_cleanup_admissions_pkey', ['p', 'PRIMARY KEY (admission_id)']],
  ['sophia_voice_lab_cleanup_admissions.sophia_voice_lab_cleanup_admissions_cleanup_obligation_id_fkey', ['f', 'FOREIGN KEY (cleanup_obligation_id) REFERENCES sophia_voice_lab_cleanup_obligations(cleanup_obligation_id)']],
  ['sophia_voice_lab_cleanup_admissions.sophia_voice_lab_cleanup_admission_kind_valid', ['c', "CHECK (resource_kind = ANY (ARRAY['session'::text, 'provider'::text, 'builder'::text]))"]],
  ['sophia_voice_lab_cleanup_admissions.sophia_voice_lab_cleanup_admission_status_valid', ['c', "CHECK (status = ANY (ARRAY['reserved'::text, 'allocating'::text, 'credential_minted'::text, 'browser_active'::text, 'activation_aborted'::text, 'browser_closed'::text]))"]],
  ['sophia_voice_lab_cleanup_admissions.sophia_voice_lab_cleanup_admission_resource_valid', ['c', "CHECK (length(resource_id) >= 1 AND length(resource_id) <= 256 AND resource_id !~ '[[:cntrl:]]'::text)"]],
  ['sophia_voice_lab_cleanup_admissions.sophia_voice_lab_cleanup_admission_lease_valid', ['c', 'CHECK (lease_expires_at > created_at AND resource_expires_at >= lease_expires_at)']],
  ['sophia_voice_lab_cleanup_scan_cursors.sophia_voice_lab_cleanup_scan_cursors_pkey', ['p', 'PRIMARY KEY (cursor_name)']],
  ['sophia_voice_lab_cleanup_scan_cursors.sophia_voice_lab_cleanup_scan_cursor_name_valid', ['c', "CHECK (cursor_name = ANY (ARRAY['work_v1'::text, 'complete_purge_v1'::text]))"]],
  ['sophia_voice_lab_cleanup_scan_cursors.sophia_voice_lab_cleanup_scan_cursor_shape_valid', ['c', "CHECK (cursor_due_at IS NULL AND cursor_source IS NULL AND cursor_cleanup_obligation_id IS NULL AND cursor_admission_id IS NULL AND window_due_at IS NULL AND window_source IS NULL AND window_cleanup_obligation_id IS NULL AND window_admission_id IS NULL OR cursor_due_at IS NOT NULL AND window_due_at IS NOT NULL AND (cursor_source = ANY (ARRAY['obligation'::text, 'admission'::text, 'complete'::text])) AND (window_source = ANY (ARRAY['obligation'::text, 'admission'::text, 'complete'::text])) AND cursor_cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text AND window_cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text AND (cursor_name = 'work_v1'::text AND cursor_source = 'obligation'::text AND cursor_admission_id IS NULL OR cursor_name = 'work_v1'::text AND cursor_source = 'admission'::text AND cursor_admission_id IS NOT NULL OR cursor_name = 'complete_purge_v1'::text AND cursor_source = 'complete'::text AND cursor_admission_id IS NULL) AND (cursor_name = 'work_v1'::text AND window_source = 'obligation'::text AND window_admission_id IS NULL OR cursor_name = 'work_v1'::text AND window_source = 'admission'::text AND window_admission_id IS NOT NULL OR cursor_name = 'complete_purge_v1'::text AND window_source = 'complete'::text AND window_admission_id IS NULL))"]],
]);
const EXPECTED_D02_DATABASE_ROLE = 'sophia_voice_lab_gateway';
const EXPECTED_D02_COLUMNS = new Map([
  ['sophia_voice_lab_d02_gateway_finalize_authority', new Map([
    ['singleton', ['bool', 'NO', null, 'true']],
    ['authority_key_id', ['text', 'NO', null, '']],
    ['authority_secret', ['text', 'NO', null, '']],
    ['installed_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
  ['sophia_voice_lab_d02_gateway_capability_uses', new Map([
    ['capability_jti_sha256', ['bpchar', 'NO', 64, '']],
    ['operation', ['text', 'NO', null, '']],
    ['request_sha256', ['bpchar', 'NO', 64, '']],
    ['cleanup_obligation_id', ['text', 'NO', null, '']],
    ['termination_request_id_sha256', ['bpchar', 'NO', 64, '']],
    ['used_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
  ['sophia_voice_lab_d02_gateway_relay_leases', new Map([
    ['relay_id', ['uuid', 'NO', null, '']],
    ['cleanup_obligation_id', ['text', 'NO', null, '']],
    ['provider_session_id', ['text', 'NO', null, '']],
    ['provider_connection_epoch', ['int4', 'NO', null, '']],
    ['relay_kind', ['text', 'NO', null, '']],
    ['owner_instance_id_sha256', ['bpchar', 'NO', 64, '']],
    ['expires_at', ['timestamptz', 'NO', null, '']],
    ['created_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
  ['sophia_voice_lab_d02_gateway_settlements', new Map([
    ['cleanup_obligation_id', ['text', 'NO', null, '']],
    ['termination_request_id_sha256', ['bpchar', 'NO', 64, '']],
    ['provider_session_id', ['text', 'NO', null, '']],
    ['provider_admission_id', ['uuid', 'NO', null, '']],
    ['freeze_request_sha256', ['bpchar', 'NO', 64, '']],
    ['freeze_capability_jti_sha256', ['bpchar', 'NO', 64, '']],
    ['freeze_binding', ['jsonb', 'NO', null, '']],
    ['frozen_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
    ['voice_terminal_receipt_sha256', ['bpchar', 'YES', 64, '']],
    ['voice_terminal_receipt', ['jsonb', 'YES', null, '']],
    ['voice_terminal_at', ['timestamptz', 'YES', null, '']],
    ['settlement_request_sha256', ['bpchar', 'YES', 64, '']],
    ['settlement_capability_jti_sha256', ['bpchar', 'YES', 64, '']],
    ['provider_settlement_sha256', ['bpchar', 'YES', 64, '']],
    ['receipt_sha256', ['bpchar', 'YES', 64, '']],
    ['receipt', ['jsonb', 'YES', null, '']],
    ['settled_at', ['timestamptz', 'YES', null, '']],
  ])],
  ['sophia_voice_lab_d02_product_continuity_observations', new Map([
    ['cleanup_obligation_id', ['text', 'NO', null, '']],
    ['restart_request_id_sha256', ['bpchar', 'NO', 64, '']],
    ['phase', ['text', 'NO', null, '']],
    ['request_sha256', ['bpchar', 'NO', 64, '']],
    ['capability_jti_sha256', ['bpchar', 'NO', 64, '']],
    ['product_service_boot_id_sha256', ['bpchar', 'NO', 64, '']],
    ['render_action_request_sha256', ['bpchar', 'NO', 64, '']],
    ['prior_observation_receipt_sha256', ['bpchar', 'YES', 64, '']],
    ['receipt_sha256', ['bpchar', 'NO', 64, '']],
    ['receipt', ['jsonb', 'NO', null, '']],
    ['observed_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
] as const);
const EXPECTED_D02_CONSTRAINTS = new Map([
  ['sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capabil_cleanup_obligation_id_fkey', ['f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509']],
  ['sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capability_use_valid', ['c', '6920ab0aa1ace1259c5901074ee0c7e2ddbb35ff742eddcd7ec61f1014656bd7']],
  ['sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capability_uses_pkey', ['p', 'a961c742c7d3457dfcc14036010e5998f624e2de98038905fd2ac348805029b5']],
  ['sophia_voice_lab_d02_gateway_finalize_authority.sophia_voice_lab_d02_gateway_finalize_authority_pkey', ['p', 'd004b3efcdc4a0108ecbe83c93408f63eebecc563529a3941a4c59667835f25b']],
  ['sophia_voice_lab_d02_gateway_finalize_authority.sophia_voice_lab_d02_gateway_finalize_authority_shape', ['c', '72391c6f052baf8359f67736ea44dcdb5c6b5654413920529375ee84656b51e7']],
  ['sophia_voice_lab_d02_gateway_finalize_authority.sophia_voice_lab_d02_gateway_finalize_authority_singleton', ['c', '0a780c77dfabbc15def3d17957997d352de196c1233a0d25fccc97a40d2d6f41']],
  ['sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_l_cleanup_obligation_id_fkey', ['f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509']],
  ['sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_lease_valid', ['c', '9255a14b07341568705205a69256eba988d3bd8914538a3d208e0938a51f2323']],
  ['sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_leases_pkey', ['p', 'a31d33028f6a44ff6d3875c2f055f964eacd05ded31d5a6ddce3f187dfc07339']],
  ['sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlem_cleanup_obligation_id_fkey', ['f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509']],
  ['sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlement_binding_valid', ['c', '0a15d4341753469bd5a9e8a65e4f02ea6d7cba53860979eb3b1c45e2baad6208']],
  ['sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlement_hashes_valid', ['c', '6a35b3db36ae129559ba5499ea558ed6400123e68ab1210c966044f2e2a6418f']],
  ['sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlement_lifecycle_valid', ['c', '51543a623b2b5d5a5ceaff154cfd1c3aa9deafd601cf93c4da48b3dbd29a82b1']],
  ['sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlements_pkey', ['p', 'f32df012404d69382bbd618d48e17658886c6d8a3f764ca63056f762ad35486e']],
  ['sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continu_cleanup_obligation_id_fkey', ['f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509']],
  ['sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_hashes_valid', ['c', 'ebd2ddd7f2018bad52ea5cddc1112bd1d90cb52c40f28ea3943b52b3f011a683']],
  ['sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_observations_pkey', ['p', '22bfbe634350aecb7e6653b19040d9d4e66cdde7e258e9375a8bd870d888533f']],
  ['sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_receipt_valid', ['c', 'a2b49334beea375a3d4fa6749d527d33af113bfc04b76a385de7ec2da2e55ff1']],
  ['sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continuity_shape_valid', ['c', 'c2a72e4ec1a177df28000e73c6ac8f98392b4f1f953ca560be8af28724d3283d']],
] as const);
const EXPECTED_D02_INDEXES = new Map([
  ['sophia_voice_lab_d02_gateway_capability_uses_pkey', { table: 'sophia_voice_lab_d02_gateway_capability_uses', unique: true, expressions: ['capability_jti_sha256'], options: [0], predicate: '', opclasses: ['bpchar_ops'], collations: ['default'] }],
  ['sophia_voice_lab_d02_gateway_finalize_authority_pkey', { table: 'sophia_voice_lab_d02_gateway_finalize_authority', unique: true, expressions: ['singleton'], options: [0], predicate: '', opclasses: ['bool_ops'], collations: [''] }],
  ['sophia_voice_lab_d02_gateway_relay_expiry_idx', { table: 'sophia_voice_lab_d02_gateway_relay_leases', unique: false, expressions: ['cleanup_obligation_id', 'expires_at', 'owner_instance_id_sha256', 'relay_id'], options: [0, 0, 0, 0], predicate: '', opclasses: ['text_ops', 'timestamptz_ops', 'bpchar_ops', 'uuid_ops'], collations: ['default', '', 'default', ''] }],
  ['sophia_voice_lab_d02_gateway_relay_leases_pkey', { table: 'sophia_voice_lab_d02_gateway_relay_leases', unique: true, expressions: ['relay_id'], options: [0], predicate: '', opclasses: ['uuid_ops'], collations: [''] }],
  ['sophia_voice_lab_d02_gateway_settlements_freeze_jti_idx', { table: 'sophia_voice_lab_d02_gateway_settlements', unique: true, expressions: ['freeze_capability_jti_sha256'], options: [0], predicate: '', opclasses: ['bpchar_ops'], collations: ['default'] }],
  ['sophia_voice_lab_d02_gateway_settlements_pkey', { table: 'sophia_voice_lab_d02_gateway_settlements', unique: true, expressions: ['cleanup_obligation_id', 'termination_request_id_sha256'], options: [0, 0], predicate: '', opclasses: ['text_ops', 'bpchar_ops'], collations: ['default', 'default'] }],
  ['sophia_voice_lab_d02_gateway_settlements_settlement_jti_idx', { table: 'sophia_voice_lab_d02_gateway_settlements', unique: true, expressions: ['settlement_capability_jti_sha256'], options: [0], predicate: 'settlement_capability_jti_sha256isnotnull', opclasses: ['bpchar_ops'], collations: ['default'] }],
  ['sophia_voice_lab_d02_product_continuity_observations_pkey', { table: 'sophia_voice_lab_d02_product_continuity_observations', unique: true, expressions: ['cleanup_obligation_id', 'restart_request_id_sha256', 'phase'], options: [0, 0, 0], predicate: '', opclasses: ['text_ops', 'bpchar_ops', 'text_ops'], collations: ['default', 'default', 'default'] }],
  ['sophia_voice_lab_d02_product_continuity_one_restart_idx', { table: 'sophia_voice_lab_d02_product_continuity_observations', unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: "phase='before_api_restart'", opclasses: ['text_ops'], collations: ['default'] }],
] as const);
const EXPECTED_D02_COMMENTS = new Map([
  ['sophia_voice_lab_d02_gateway_settlements', `sophia.voice-lab.d02-gateway-settlement.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=bounded-authority-receipt-no-raw-principal`],
  ['sophia_voice_lab_d02_gateway_capability_uses', `sophia.voice-lab.d02-gateway-capability-use.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-replay-binding-only`],
  ['sophia_voice_lab_d02_gateway_relay_leases', `sophia.voice-lab.d02-gateway-relay-lease.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-live-relay-authority-only`],
  ['sophia_voice_lab_d02_product_continuity_observations', `sophia.voice-lab.d02-product-continuity-observation.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=hashed-product-projection-signed-receipt-only`],
  ['sophia_voice_lab_d02_gateway_finalize_authority', `sophia.voice-lab.d02-database-finalize-authority.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=owner-only-key-material-never-runtime-readable`],
] as const);
const EXPECTED_D02_GATEWAY_PRIVILEGES = new Map(
  [...EXPECTED_D02_COLUMNS.keys()].map((table) => [table, new Set<string>()]),
);
const EXPECTED_D02_GATEWAY_EFFECTIVE_PRIVILEGES = new Map([
  ['session', new Set<string>()],
  ['sophia_sessions', new Set<string>()],
  ['sophia_session_messages', new Set<string>()],
  ['artifact_registry_records', new Set<string>()],
  [AUTH_LEDGER_TABLE, new Set<string>()],
  ['sophia_voice_lab_cleanup_obligations', new Set<string>()],
  ['sophia_voice_lab_cleanup_admissions', new Set<string>()],
  ['sophia_voice_lab_cleanup_scan_cursors', new Set<string>()],
  ...EXPECTED_D02_GATEWAY_PRIVILEGES,
] as const);
const EXPECTED_CLEANUP_FUNCTIONS = new Map([
  ['sophia_voice_lab_receipt_part', {
    sourceSha256: '6185006f17eaf4c24c241968d2c9f94baeea014088c20832c22c61c06853c4bd',
    args: 'p_value text', language: 'sql', volatility: 'i', securityDefiner: false,
    result: 'text', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 's',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
    gatewayExecute: false,
  }],
  ['sophia_voice_lab_finalization_receipt_sha256', {
    sourceSha256: '92b94e6c4c49d47968d179e81375b5825119d6ebd10e084214a99f4df47867ec',
    args: 'p_user_id text, p_session_id text, p_thread_id text, p_synthetic jsonb, p_expected_deployment jsonb, p_finalized_at text, p_retention_hours integer, p_retention_expires_at text, p_provider_expires_at text, p_message_revision bigint, p_message_count integer, p_transcript_sha256 text, p_started_at text, p_turn_count integer, p_capability_jti_sha256 text, p_object_path text',
    language: 'sql', volatility: 'i', securityDefiner: false,
    result: 'text', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 's',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
    gatewayExecute: false,
  }],
  ['sophia_finalize_voice_lab_session', {
    sourceSha256: '6c74d0646932e6cc32809f6d0c432f0b231dd9d89c7336fb92d8f6ff67c622c3',
    args: 'p_user_id text, p_session_id text, p_expected_revision bigint, p_cleanup_obligation_id text, p_provider_expires_at text, p_retention_hours integer, p_expected_synthetic_binding jsonb, p_expected_deployment jsonb, p_message_metadata_base jsonb, p_canonical_transcript_sha256 text, p_canonical_transcript_json text, p_finalization_started_at text, p_turn_count integer, p_capability_jti_sha256 text, p_messages jsonb',
    language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'jsonb', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: true,
    gatewayExecute: false,
  }],
  ['sophia_purge_voice_lab_session', {
    sourceSha256: '1e001f8ff64cd06ec9cd2e78d509c1d290469ce7816b57ce6695b071ea48f3c3',
    args: 'p_user_id text, p_session_id text, p_cleanup_obligation_id text, p_retention_expires_at text, p_provider_expires_at text',
    language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'boolean', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: true,
    gatewayExecute: false,
  }],
  ['sophia_voice_lab_cleanup_write_fence', {
    sourceSha256: '4faacbb98b20ee4e955ae8343e55c163060f9963104c384dadb1263249d28fad',
    args: '', language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'trigger', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
    gatewayExecute: false,
  }],
  ['sophia_voice_lab_message_write_fence', {
    sourceSha256: '11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3',
    args: '', language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'trigger', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
    gatewayExecute: false,
  }],
]);

type D02FunctionSpec = readonly [
  name: string,
  sourceSha256: string,
  args: string,
  result: string,
  language: 'sql' | 'plpgsql',
  volatility: 'i' | 's' | 'v',
  securityDefiner: boolean,
  strict: boolean,
  parallel: 's' | 'r' | 'u',
  gatewayExecute: boolean,
  operation: string,
  exposure: string,
];
const EXPECTED_D02_FUNCTIONS = new Map(
  ([
    ['sophia_voice_lab_d02_browser_settlement', 'f3e3bc3c27e9d5e28f3e206ebd2230b419463ca117acc024356cec64149b5ffa', 'p_metadata jsonb, p_provider_session_id text', 'jsonb', 'plpgsql', 's', false, true, 's', false, 'browser-settlement', 'owner-internal'],
    ['sophia_voice_lab_d02_canonical_json', '070913f32577512228d6e87368a7291c378532bb03c181ff4e2fca7f2780cb06', 'p_value jsonb', 'text', 'plpgsql', 'i', false, true, 's', false, 'canonical-json', 'owner-internal'],
    ['sophia_voice_lab_d02_continuity_authorize', '14b4fc34cf9bf60c66e307c32e8943c1e421197a0633a4486fbf4392901acc56', 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_observed_at timestamp with time zone', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'continuity-authorize', 'gateway-execute'],
    ['sophia_voice_lab_d02_continuity_finalize', '591c5cf7b4fd1af27a0acc9780e1cb95c99209d22c3910b03a0dd4f59881c8f8', 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_product_service_boot_id_sha256 text, p_render_action_request_sha256 text, p_prior_observation_receipt_sha256 text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'continuity-finalize', 'gateway-execute-hmac'],
    ['sophia_voice_lab_d02_finalize_authority_ready', 'ce3cfd8a1859c1e703927a3cc907628e6e147563029513354ae9e9ea932c5bf4', 'p_authority_key_id text, p_authority_secret_sha256 text', 'boolean', 'sql', 's', true, true, 's', true, 'authority-ready', 'gateway-readback'],
    ['sophia_voice_lab_d02_finalize_proof_valid', 'fd637099a2e026380dd1b4017b8a341811fb9cf6bc58c4ee41c077e8472f9c97', 'p_authority_key_id text, p_domain text, p_parts jsonb, p_value jsonb, p_proof_sha256 text', 'boolean', 'plpgsql', 's', true, true, 'r', false, 'finalize-proof-valid', 'owner-internal'],
    ['sophia_voice_lab_d02_freeze_authorize', '60d23be11556efb20fb0290c05be5987808ea978ed82a8b3b4bb9f46c175c020', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'freeze-authorize', 'gateway-execute'],
    ['sophia_voice_lab_d02_freeze_finalize', 'de3f91905416587285ee54f0f15a8fee7e99bece48999001e7ec9690539e5d4d', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_freeze_binding jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'freeze-finalize', 'gateway-execute-hmac'],
    ['sophia_voice_lab_d02_hmac_sha256', '03b16bf3f6ce33e09cbb9445f6afe8c343caeaf3fae11cfa526fa7ac641fd3c9', 'p_key bytea, p_data bytea', 'bytea', 'plpgsql', 'i', false, true, 's', false, 'hmac-sha256', 'owner-internal'],
    ['sophia_voice_lab_d02_producer_open', '4db750471171dba20a1c71e3a6f73505efca17c93226820129b91c59f183e8a3', 'p_cleanup_obligation_id text', 'boolean', 'plpgsql', 'v', true, false, 'u', true, 'producer-open', 'gateway-readback'],
    ['sophia_voice_lab_d02_provider_freeze', 'da2c68d664005bc5b630599d6297a3a233a61763975c63344986b6e1c628ac9c', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text', 'jsonb', 'plpgsql', 's', true, false, 'u', true, 'provider-freeze', 'gateway-readback'],
    ['sophia_voice_lab_d02_register_capability_use', 'b964d9481272417056bf53ed7f8864a67071bc0567f627477a4b73f4e6fd4b80', 'p_capability_jti_sha256 text, p_operation text, p_request_sha256 text, p_cleanup_obligation_id text, p_request_id_sha256 text', 'boolean', 'sql', 'v', false, false, 'u', false, 'capability-use', 'owner-internal'],
    ['sophia_voice_lab_d02_register_capability_use_state', '810a45a17e5a3b934a6ef0b7cddb36ffe46ea83da6725d2f2839748b5253255c', 'p_capability_jti_sha256 text, p_operation text, p_request_sha256 text, p_cleanup_obligation_id text, p_request_id_sha256 text', 'text', 'plpgsql', 'v', false, false, 'u', false, 'capability-state', 'owner-internal'],
    ['sophia_voice_lab_d02_relay_begin', '7d5677b2c65e11531338bcc4af05672ad9fc3787986d0fa4365a7652029c3b6e', 'p_relay_id uuid, p_cleanup_obligation_id text, p_provider_session_id text, p_provider_connection_epoch integer, p_relay_kind text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_authority_key_id text, p_operation_proof_sha256 text', 'boolean', 'plpgsql', 'v', true, false, 'u', true, 'relay-begin', 'gateway-execute-hmac'],
    ['sophia_voice_lab_d02_relay_end', 'bf089f4e5e55667b9b7902ad5ec4afe5e7c27ceacf0fe9a9ee3ec8accb3f9774', 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text', 'boolean', 'plpgsql', 'v', true, false, 'u', true, 'relay-end', 'gateway-execute-hmac'],
    ['sophia_voice_lab_d02_relay_refresh', '8d6a271cc20516fd476ee56adad82e18094e4fdb4cb0aba467e1eeb83a3a1e0c', 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text', 'boolean', 'plpgsql', 'v', true, false, 'u', true, 'relay-refresh', 'gateway-execute-hmac'],
    ['sophia_voice_lab_d02_settlement_authorize', '06980b6cd70094490d5461c00a22b738f83c5c6cd4b9ba0b6a56cc9d33ff84f9', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'settlement-authorize', 'gateway-execute'],
    ['sophia_voice_lab_d02_settlement_finalize', 'a96754002d924205727f17629fba51c3633b4543954a7e827c724467b88a0096', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_provider_settlement_sha256 text, p_next_metadata jsonb, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'settlement-finalize', 'gateway-execute-hmac'],
    ['sophia_voice_lab_d02_sources_zero', '8c8dd393f5a61e9e0a3b165904b417065a877fd1f5b7485d2a7d8b064e669ccb', 'p_cleanup_obligation_id text', 'boolean', 'sql', 's', true, false, 'u', true, 'sources-zero', 'gateway-runtime-readback'],
    ['sophia_voice_lab_d02_voice_terminal_authorize', '9c094510a8ff27a0fd36ef94922b56746249d72284c5441e61787d5a76c278aa', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'voice-terminal-authorize', 'gateway-execute'],
    ['sophia_voice_lab_d02_voice_terminal_finalize', 'e62bc88c1142478da159500d241ce22e89d8cbbfbcbeb074556228de4d844d80', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', true, 'voice-terminal-finalize', 'gateway-execute-hmac'],
  ] satisfies readonly D02FunctionSpec[]).map(([
    name, sourceSha256, args, result, language, volatility, securityDefiner,
    strict, parallel, gatewayExecute, operation, exposure,
  ]) => [name, {
    sourceSha256, args, result, language, volatility, securityDefiner,
    kind: 'f', returnsSet: false, strict, leakproof: false, parallel,
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
    gatewayExecute,
    runtimeExecute: name === 'sophia_voice_lab_d02_sources_zero',
    comment:
      `sophia.voice-lab.d02-database-rpc.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} `
      + `operation=${operation} exposure=${exposure}`,
  }]),
);
const EXPECTED_GOVERNED_FUNCTIONS = new Map([
  ...EXPECTED_CLEANUP_FUNCTIONS,
  ...EXPECTED_D02_FUNCTIONS,
]);

type StoredGrantMarker = {
  v: 1;
  principal_id: string;
  test_run_id: string;
  tombstone_kid: string;
  cleanup_obligation_id: string;
  provider_expires_at: string;
  retention_hours: number;
  issued_at: number;
  jti_sha256: string;
  nonce_sha256: string;
};

type SessionRow = {
  token: string;
  expiresAt: Date;
  userAgent: string | null;
};

type GrantLedgerRow = {
  grant_fingerprint: string;
  test_run_id: string;
  tombstone_kid: string;
  cleanup_obligation_id: string;
  issued_at: string | number;
  expires_at: Date;
  provider_expires_at: Date;
  retention_hours: number;
  jti_sha256: string;
  nonce_sha256: string;
  session_token_sha256: string;
  status: 'active' | 'revoked';
};

export type RotatedVoiceLabSession = {
  token: string;
  expiresAt: Date;
  idempotentReplay: boolean;
  expiredLabSessionsRevoked: number;
};

export type VoiceLabAuthLedgerReadiness = {
  ready: true;
  table: typeof AUTH_LEDGER_TABLE;
  migrationSha256: typeof VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256;
  requiredPrivileges: readonly ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
};

type AuthLedgerColumnRow = {
  column_name: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: string | number | null;
  is_generated: string;
  is_identity: string;
};

type AuthLedgerIndexRow = ProductCleanupIndexRow;
type AuthLedgerConstraintRow = {
  conname: string;
  contype: string;
  convalidated: boolean;
  definition: string;
};
type AuthLedgerPrivilegeRow = {
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  owner_matches_control: boolean;
  owner_is_expected: boolean;
  relkind: string;
  relpersistence: string;
  relispartition: boolean;
  inheritance_free: boolean;
  rewrite_free: boolean;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  unexpected_acl: boolean;
  unexpected_column_acl: boolean;
};
type AuthLedgerMetadataRow = { table_comment: string | null };
type ProductCleanupIndexRow = {
  indexname: string;
  tablename: string;
  indisunique: boolean;
  indisvalid: boolean;
  indisready: boolean;
  indnkeyatts: string | number;
  index_relpersistence: string;
  amname: string;
  key_expressions: string[];
  key_options: Array<string | number>;
  predicate: string | null;
  index_comment: string | null;
};
type LiveTombstoneKidRow = { tombstone_kid: string };
type ProductCleanupTriggerRow = {
  tgname: string;
  tablename: string;
  tgenabled: string;
  trigger_definition: string;
  proname: string;
  prosecdef: boolean;
  provolatile: string;
  proconfig: string[] | null;
  lanname: string;
  owner_matches_control: boolean;
  owner_is_expected: boolean;
  function_schema: string;
  function_is_public_identity: boolean;
  prosrc: string;
  function_comment: string | null;
};
type CleanupFunctionRow = {
  proname: string;
  identity_arguments: string;
  result_type: string;
  pronargdefaults: string | number;
  proargmodes: string[] | null;
  prokind: string;
  proretset: boolean;
  proisstrict: boolean;
  proleakproof: boolean;
  proparallel: string;
  lanname: string;
  provolatile: string;
  prosecdef: boolean;
  proconfig: string[] | null;
  owner_matches_control: boolean;
  owner_is_expected: boolean;
  public_can_execute: boolean;
  anon_can_execute: boolean;
  authenticated_can_execute: boolean;
  service_can_execute: boolean;
  gateway_can_execute: boolean;
  runtime_can_execute: boolean;
  unexpected_execute_acl: boolean;
  service_execute_grantable: boolean;
  gateway_execute_grantable: boolean;
  runtime_execute_grantable: boolean;
  source_sha256: string;
  function_comment: string | null;
};
type CleanupControlColumnRow = AuthLedgerColumnRow & { table_name: string };
type CleanupControlPrivilegeRow = AuthLedgerPrivilegeRow & {
  table_name: string;
  service_can_access: boolean;
};
type ProductRequiredColumnRow = Omit<AuthLedgerColumnRow, 'column_default'> & {
  table_name: string;
  relkind: string;
  relpersistence: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
};
type ProductPrivilegeRow = {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  service_can_mutate: boolean;
  service_has_unsafe: boolean;
  anon_can_access: boolean;
  authenticated_can_access: boolean;
  owner_matches_control: boolean;
  owner_is_expected: boolean;
  relispartition: boolean;
  inheritance_free: boolean;
  rewrite_free: boolean;
  unexpected_acl: boolean;
  unexpected_column_acl: boolean;
};
type SessionMessagesForeignKeyRow = {
  oid: string | number;
  conname: string;
  convalidated: boolean;
  condeferrable: boolean;
  condeferred: boolean;
  definition: string;
};
type SessionMessagesForeignKeyTriggerRow = {
  tablename: string;
  tgenabled: string;
  tgisinternal: boolean;
  proname: string;
};
type ProductPrimaryKeyRow = {
  tablename: string;
  conname: string;
  convalidated: boolean;
  condeferrable: boolean;
  condeferred: boolean;
  definition: string;
  indisunique: boolean;
  indisvalid: boolean;
  indisready: boolean;
  index_relpersistence: string;
  amname: string;
};
type BetterAuthSessionColumnRow = Omit<AuthLedgerColumnRow, 'column_default'>;
type BetterAuthSessionConstraintRow = {
  conname: string;
  contype: string;
  convalidated: boolean;
  condeferrable: boolean;
  condeferred: boolean;
  definition: string;
};
type BetterAuthSessionRelationRow = {
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  owner_matches_control: boolean;
  owner_is_expected: boolean;
  relkind: string;
  relpersistence: string;
  relispartition: boolean;
  inheritance_free: boolean;
  rewrite_free: boolean;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  unexpected_acl: boolean;
  unexpected_column_acl: boolean;
  public_can_access: boolean;
  anon_can_access: boolean;
  authenticated_can_access: boolean;
  service_can_access: boolean;
};
type D02RelationRow = {
  table_name: string;
  owner_name: string;
  relkind: string;
  relpersistence: string;
  relispartition: boolean;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  inheritance_free: boolean;
  rewrite_free: boolean;
  column_acl_free: boolean;
  table_comment: string | null;
};
type D02ConstraintRow = AuthLedgerConstraintRow & {
  tablename: string;
  condeferrable: boolean;
  condeferred: boolean;
  definition_sha256: string;
};
type D02IndexRow = ProductCleanupIndexRow & {
  indimmediate: boolean;
  opclasses: string[];
  collations: string[];
};
type D02ForeignKeyTriggerRow = SessionMessagesForeignKeyTriggerRow & {
  source_table: string;
  constraint_name: string;
};

function ledgerNotReady(): VoiceLabCapabilityError {
  return new VoiceLabCapabilityError('voice_lab_auth_ledger_not_ready', 503);
}

function normalizeIndexExpression(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/::text/g, '')
    .replace(/[()\s]/g, '');
}

function normalizeColumnDefault(value: string | null | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/::(?:text|character varying)/g, '')
    .replace(/\s/g, '');
}

function normalizeConstraintDefinition(value: string | null | undefined): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Read-only production preflight for the separately operated migration.
 * This never creates or alters schema and intentionally runs before every
 * grant exchange/readiness probe so a cold or drifted deployment fails closed.
 */
async function lockVoiceLabGovernedRelations(client: PoolClient): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('sophia-voice-lab-schema-v1', 731945))",
  );
  await client.query(
    `LOCK TABLE
       public."session",
       public."sophia_voice_lab_auth_grants",
       public."sophia_voice_lab_cleanup_obligations"
     IN ACCESS SHARE MODE`,
  );
}

async function assertVoiceLabAuthLedgerReadyOnClient(
  client: PoolClient,
): Promise<VoiceLabAuthLedgerReadiness> {
  try {
    const tombstoneKeyring = authTombstoneKeyring();
    let queryTail = Promise.resolve();
    const pool = {
      query<
        Row extends QueryResultRow = QueryResultRow,
        Values extends unknown[] = unknown[],
      >(
        queryText: string,
        values?: QueryConfigValues<Values>,
      ): Promise<QueryResult<Row>> {
        const result = queryTail.then(() =>
          client.query<Row, Values>(queryText, values),
        );
        queryTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    };
    const [
      columns,
      indexes,
      constraints,
      privileges,
      unsafeGrants,
      unsafeEffectiveTablePrivileges,
      metadata,
      productCleanupIndexes,
      productCleanupTriggers,
      cleanupFunctions,
      unsafeCleanupFenceGrants,
      liveTombstoneKids,
      productColumns,
      productPrivileges,
      productUnsafeGrants,
      sessionMessagesForeignKey,
      sessionMessagesForeignKeyTriggers,
      cleanupAdmissionsForeignKeyTriggers,
      productPrimaryKeys,
      betterAuthSessionColumns,
      betterAuthSessionIndexes,
      betterAuthSessionConstraints,
      betterAuthSessionRelation,
      cleanupControlColumns,
      cleanupControlIndexes,
      cleanupControlConstraints,
      cleanupControlPrivileges,
      cleanupControlUnsafeGrants,
      cleanupControlMetadata,
      d02Columns,
      d02Relations,
      d02Acl,
      d02Constraints,
      d02Indexes,
      d02ForeignKeyTriggers,
      d02NonInternalTriggers,
      d02Role,
      d02GlobalFunctionAuthority,
      d02EffectivePrivileges,
      d02GlobalEffectivePrivileges,
      sessionSettings,
    ] = await Promise.all([
      pool.query<AuthLedgerColumnRow>(
        `SELECT /* voice_lab_auth_ledger_columns */
                attribute.attname AS column_name,
                type.typname AS udt_name,
                CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END
                  AS is_nullable,
                pg_get_expr(default_value.adbin, default_value.adrelid)
                  AS column_default,
                CASE
                  WHEN type.typname IN ('bpchar', 'varchar')
                       AND attribute.atttypmod >= 4
                    THEN attribute.atttypmod - 4
                  ELSE NULL
                END AS character_maximum_length,
                CASE WHEN attribute.attgenerated = '' THEN 'NEVER' ELSE 'ALWAYS' END
                  AS is_generated,
                CASE WHEN attribute.attidentity = '' THEN 'NO' ELSE 'YES' END
                  AS is_identity
           FROM pg_attribute attribute
           JOIN pg_class relation ON relation.oid = attribute.attrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_type type ON type.oid = attribute.atttypid
           LEFT JOIN pg_attrdef default_value
             ON default_value.adrelid = attribute.attrelid
            AND default_value.adnum = attribute.attnum
          WHERE namespace.nspname = 'public' AND relation.relname = $1
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
          ORDER BY attribute.attnum`,
        [AUTH_LEDGER_TABLE],
      ),
      pool.query<AuthLedgerIndexRow>(
        `SELECT idx.relname AS indexname, tbl.relname AS tablename,
                i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts,
                idx.relpersistence AS index_relpersistence, am.amname,
                ARRAY(
                  SELECT pg_get_indexdef(i.indexrelid, key_position, true)
                    FROM generate_series(1, i.indnkeyatts) AS key_position
                   ORDER BY key_position
                ) AS key_expressions,
                ARRAY(
                  SELECT (i.indoption::smallint[])[key_position]
                    FROM generate_series(0, i.indnkeyatts - 1) AS key_position
                   ORDER BY key_position
                ) AS key_options,
                pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
                NULL::text AS index_comment
           FROM pg_index i
           JOIN pg_class idx ON idx.oid = i.indexrelid
           JOIN pg_class tbl ON tbl.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
           JOIN pg_am am ON am.oid = idx.relam
          WHERE ns.nspname = 'public' AND tbl.relname = $1`,
        [AUTH_LEDGER_TABLE],
      ),
      pool.query<AuthLedgerConstraintRow>(
        `SELECT conname, contype, convalidated,
                pg_get_constraintdef(oid, true) AS definition
           FROM pg_constraint
          WHERE conrelid = to_regclass($1)`,
        [`public.${AUTH_LEDGER_TABLE}`],
      ),
      pool.query<AuthLedgerPrivilegeRow>(
        `SELECT
           has_table_privilege(current_user, $1, 'SELECT') AS can_select,
           has_table_privilege(current_user, $1, 'INSERT') AS can_insert,
           has_table_privilege(current_user, $1, 'UPDATE') AS can_update,
           has_table_privilege(current_user, $1, 'DELETE') AS can_delete,
           c.relowner = control.relowner AS owner_matches_control,
           pg_get_userbyid(c.relowner) = '${EXPECTED_DATABASE_OWNER_ROLE}'
             AS owner_is_expected,
           c.relkind, c.relpersistence, c.relispartition,
           NOT EXISTS (
             SELECT 1 FROM pg_inherits inheritance
              WHERE inheritance.inhparent = c.oid OR inheritance.inhrelid = c.oid
           ) AS inheritance_free,
           NOT EXISTS (
             SELECT 1 FROM pg_rewrite rewrite
              WHERE rewrite.ev_class = c.oid
           ) AS rewrite_free,
           c.relrowsecurity, c.relforcerowsecurity,
           EXISTS (
             SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
              WHERE acl.grantee <> c.relowner
                AND NOT (
                  acl.grantee = to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}')
                  AND acl.privilege_type = ANY(
                    ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                  )
                  AND NOT acl.is_grantable
                )
           ) AS unexpected_acl,
           EXISTS (
             SELECT 1 FROM pg_attribute a,
                  LATERAL aclexplode(a.attacl) acl
              WHERE a.attrelid = c.oid AND a.attnum > 0
                AND NOT a.attisdropped AND acl.grantee <> c.relowner
           ) AS unexpected_column_acl
          FROM pg_class c
          JOIN pg_class control ON control.oid =
               'public.sophia_voice_lab_cleanup_obligations'::regclass
         WHERE c.oid = $1::regclass`,
        [`public.${AUTH_LEDGER_TABLE}`],
      ),
      pool.query<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type
           FROM information_schema.table_privileges
          WHERE table_schema = 'public' AND table_name = $1
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
        [AUTH_LEDGER_TABLE],
      ),
      pool.query<{ role_name: string; table_name: string }>(
        `SELECT role_name, table_name
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) role_name
           CROSS JOIN unnest($1::text[]) table_name
          WHERE to_regrole(role_name) IS NOT NULL
            AND (
              has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'SELECT')
              OR has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'INSERT')
              OR has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'UPDATE')
              OR has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'DELETE')
              OR has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'TRUNCATE')
              OR has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'REFERENCES')
              OR has_table_privilege(to_regrole(role_name), format('public.%I', table_name), 'TRIGGER')
            )`,
        [[AUTH_LEDGER_TABLE, ...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<AuthLedgerMetadataRow>(
        `SELECT obj_description(to_regclass($1), 'pg_class') AS table_comment`,
        [`public.${AUTH_LEDGER_TABLE}`],
      ),
      pool.query<ProductCleanupIndexRow>(
        `SELECT idx.relname AS indexname,
                tbl.relname AS tablename,
                i.indisunique,
                i.indisvalid,
                i.indisready,
                i.indnkeyatts,
                idx.relpersistence AS index_relpersistence,
                am.amname,
                ARRAY(
                  SELECT pg_get_indexdef(i.indexrelid, key_position, true)
                    FROM generate_series(1, i.indnkeyatts) AS key_position
                   ORDER BY key_position
                ) AS key_expressions,
                ARRAY(
                  SELECT (i.indoption::smallint[])[key_position]
                    FROM generate_series(0, i.indnkeyatts - 1) AS key_position
                   ORDER BY key_position
                ) AS key_options,
                pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
                obj_description(i.indexrelid, 'pg_class') AS index_comment
           FROM pg_index i
           JOIN pg_class idx ON idx.oid = i.indexrelid
           JOIN pg_class tbl ON tbl.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
           JOIN pg_am am ON am.oid = idx.relam
          WHERE ns.nspname = 'public' AND idx.relname = ANY($1::text[])`,
        [[...EXPECTED_PRODUCT_CLEANUP_INDEXES.keys()]],
      ),
      pool.query<ProductCleanupTriggerRow>(
        `SELECT t.tgname, c.relname AS tablename, t.tgenabled,
                pg_get_triggerdef(t.oid, true) AS trigger_definition,
                p.proname, p.prosecdef, p.provolatile, p.proconfig,
                l.lanname, pn.nspname AS function_schema,
                p.oid = to_regprocedure(format('public.%I()', p.proname))
                  AS function_is_public_identity,
                p.proowner = owner_table.relowner AS owner_matches_control,
                pg_get_userbyid(p.proowner) = '${EXPECTED_DATABASE_OWNER_ROLE}'
                  AS owner_is_expected,
                p.prosrc,
                obj_description(p.oid, 'pg_proc') AS function_comment
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_namespace pn ON pn.oid = p.pronamespace
           JOIN pg_language l ON l.oid = p.prolang
           JOIN pg_class owner_table ON owner_table.oid =
                'public.sophia_voice_lab_cleanup_obligations'::regclass
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND n.nspname = 'public'
            AND c.relname = ANY($1::text[])`,
        [[...new Set(
          [
            ...[...EXPECTED_PRODUCT_CLEANUP_TRIGGERS.values()].map(
              (contract) => contract.table,
            ),
            ...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys(),
            'session',
          ],
        )]],
      ),
      pool.query<CleanupFunctionRow>(
        `SELECT p.proname,
                pg_get_function_identity_arguments(p.oid) AS identity_arguments,
                pg_get_function_result(p.oid) AS result_type,
                p.pronargdefaults, p.proargmodes,
                p.prokind, p.proretset, p.proisstrict, p.proleakproof, p.proparallel,
                l.lanname, p.provolatile, p.prosecdef, p.proconfig,
                p.proowner = owner_table.relowner AS owner_matches_control,
                pg_get_userbyid(p.proowner) = '${EXPECTED_DATABASE_OWNER_ROLE}'
                  AS owner_is_expected,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                ) AS public_can_execute,
                CASE WHEN to_regrole('anon') IS NULL THEN false
                     ELSE has_function_privilege(
                       to_regrole('anon'), p.oid, 'EXECUTE'
                     ) END AS anon_can_execute,
                CASE WHEN to_regrole('authenticated') IS NULL THEN false
                     ELSE has_function_privilege(
                       to_regrole('authenticated'), p.oid, 'EXECUTE'
                     ) END AS authenticated_can_execute,
                CASE WHEN to_regrole('service_role') IS NULL THEN false
                     ELSE has_function_privilege(
                       to_regrole('service_role'), p.oid, 'EXECUTE'
                     ) END AS service_can_execute,
                CASE WHEN to_regrole('${EXPECTED_D02_DATABASE_ROLE}') IS NULL
                     THEN false ELSE has_function_privilege(
                       to_regrole('${EXPECTED_D02_DATABASE_ROLE}'),
                       p.oid, 'EXECUTE'
                     ) END AS gateway_can_execute,
                has_function_privilege(current_user, p.oid, 'EXECUTE')
                  AS runtime_can_execute,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                   WHERE acl.privilege_type = 'EXECUTE'
                     AND acl.grantee <> p.proowner
                     AND NOT (
                       (
                         p.proname IN (
                           'sophia_finalize_voice_lab_session',
                           'sophia_purge_voice_lab_session'
                         )
                         AND acl.grantee = to_regrole('service_role')
                       )
                       OR (
                         p.proname = ANY($2::text[])
                         AND acl.grantee =
                           to_regrole('${EXPECTED_D02_DATABASE_ROLE}')
                       )
                       OR (
                         p.proname = 'sophia_voice_lab_d02_sources_zero'
                         AND acl.grantee = current_user::regrole
                       )
                     )
                ) AS unexpected_execute_acl,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                   WHERE acl.privilege_type = 'EXECUTE'
                     AND acl.grantee = to_regrole('service_role')
                     AND acl.is_grantable
                ) AS service_execute_grantable,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                   WHERE acl.privilege_type = 'EXECUTE'
                     AND acl.grantee = to_regrole('${EXPECTED_D02_DATABASE_ROLE}')
                     AND acl.is_grantable
                ) AS gateway_execute_grantable,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                   WHERE acl.privilege_type = 'EXECUTE'
                     AND acl.grantee = current_user::regrole
                     AND acl.is_grantable
                ) AS runtime_execute_grantable,
                encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS source_sha256,
                obj_description(p.oid, 'pg_proc') AS function_comment
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_language l ON l.oid = p.prolang
           JOIN pg_class owner_table ON owner_table.oid =
                'public.sophia_voice_lab_cleanup_obligations'::regclass
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
        [
          [...EXPECTED_GOVERNED_FUNCTIONS.keys()],
          [...EXPECTED_D02_FUNCTIONS]
            .filter(([, contract]) => contract.gatewayExecute)
            .map(([name]) => name),
        ],
      ),
      pool.query<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type
           FROM information_schema.routine_privileges
          WHERE specific_schema = 'public'
            AND routine_name = 'sophia_voice_lab_cleanup_write_fence'
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
      ),
      pool.query<LiveTombstoneKidRow>(
        `SELECT DISTINCT "tombstone_kid"
           FROM public."sophia_voice_lab_auth_grants"
          WHERE "expires_at" > NOW()`,
      ),
      pool.query<ProductRequiredColumnRow>(
        `SELECT /* voice_lab_required_product_columns */
                tbl.relname AS table_name,
                attribute.attname AS column_name,
                type.typname AS udt_name,
                CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END
                  AS is_nullable,
                CASE
                  WHEN type.typname IN ('bpchar', 'varchar')
                       AND attribute.atttypmod >= 4
                    THEN attribute.atttypmod - 4
                  ELSE NULL
                END AS character_maximum_length,
                CASE WHEN attribute.attgenerated = '' THEN 'NEVER' ELSE 'ALWAYS' END
                  AS is_generated,
                CASE WHEN attribute.attidentity = '' THEN 'NO' ELSE 'YES' END
                  AS is_identity,
                tbl.relkind, tbl.relpersistence,
                tbl.relrowsecurity, tbl.relforcerowsecurity
           FROM pg_attribute attribute
           JOIN pg_class tbl ON tbl.oid = attribute.attrelid
           JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
           JOIN pg_type type ON type.oid = attribute.atttypid
          WHERE ns.nspname = 'public'
            AND tbl.relname = ANY($1::text[])
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
          ORDER BY tbl.relname, attribute.attnum`,
        [EXPECTED_PRODUCT_TABLES],
      ),
      pool.query<ProductPrivilegeRow>(
        `SELECT /* voice_lab_product_table_privileges */ table_name,
                has_table_privilege(current_user, format('public.%I', table_name), 'SELECT') AS can_select,
                has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS can_insert,
                has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS can_update,
                has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS can_delete,
                CASE WHEN to_regrole('service_role') IS NULL THEN false
                     ELSE has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'SELECT')
                       AND has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'INSERT')
                       AND has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'UPDATE')
                       AND has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'DELETE')
                END AS service_can_mutate,
                CASE WHEN to_regrole('service_role') IS NULL THEN true
                     ELSE has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'TRUNCATE')
                       OR has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'REFERENCES')
                       OR has_table_privilege(to_regrole('service_role'), format('public.%I', table_name), 'TRIGGER')
                END AS service_has_unsafe,
                CASE WHEN to_regrole('anon') IS NULL THEN false
                     ELSE has_table_privilege(to_regrole('anon'), format('public.%I', table_name), 'SELECT')
                       OR has_table_privilege(to_regrole('anon'), format('public.%I', table_name), 'INSERT')
                       OR has_table_privilege(to_regrole('anon'), format('public.%I', table_name), 'UPDATE')
                       OR has_table_privilege(to_regrole('anon'), format('public.%I', table_name), 'DELETE')
                END AS anon_can_access,
                CASE WHEN to_regrole('authenticated') IS NULL THEN false
                     ELSE has_table_privilege(to_regrole('authenticated'), format('public.%I', table_name), 'SELECT')
                       OR has_table_privilege(to_regrole('authenticated'), format('public.%I', table_name), 'INSERT')
                       OR has_table_privilege(to_regrole('authenticated'), format('public.%I', table_name), 'UPDATE')
                       OR has_table_privilege(to_regrole('authenticated'), format('public.%I', table_name), 'DELETE')
                END AS authenticated_can_access,
                tbl.relowner = control.relowner AS owner_matches_control,
                pg_get_userbyid(tbl.relowner) = '${EXPECTED_DATABASE_OWNER_ROLE}'
                  AS owner_is_expected,
                tbl.relispartition,
                NOT EXISTS (
                  SELECT 1 FROM pg_inherits inheritance
                   WHERE inheritance.inhparent = tbl.oid OR inheritance.inhrelid = tbl.oid
                ) AS inheritance_free,
                NOT EXISTS (
                  SELECT 1 FROM pg_rewrite rewrite
                   WHERE rewrite.ev_class = tbl.oid
                ) AS rewrite_free,
                EXISTS (
                  SELECT 1 FROM aclexplode(COALESCE(tbl.relacl, acldefault('r', tbl.relowner))) acl
                   WHERE acl.grantee <> tbl.relowner
                     AND (
                       acl.is_grantable
                       OR NOT (
                       (
                         acl.grantee = to_regrole('service_role')
                         AND acl.privilege_type = ANY(
                           ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                         )
                       )
                       OR (
                         table_name = 'sophia_sessions'
                         AND acl.grantee = current_user::regrole
                         AND acl.privilege_type = ANY(
                           ARRAY['SELECT', 'UPDATE']
                         )
                       )
                     )
                     )
                ) AS unexpected_acl,
                EXISTS (
                  SELECT 1 FROM pg_attribute attr,
                       LATERAL aclexplode(attr.attacl) acl
                   WHERE attr.attrelid = tbl.oid AND attr.attnum > 0
                     AND NOT attr.attisdropped AND acl.grantee <> tbl.relowner
                ) AS unexpected_column_acl
           FROM unnest($1::text[]) AS table_name
           JOIN pg_class tbl ON tbl.oid = format('public.%I', table_name)::regclass
           JOIN pg_class control ON control.oid =
                'public.sophia_voice_lab_cleanup_obligations'::regclass`,
        [EXPECTED_PRODUCT_TABLES],
      ),
      pool.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `SELECT /* voice_lab_product_table_unsafe_grants */ table_name, grantee, privilege_type
           FROM information_schema.table_privileges
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
        [EXPECTED_PRODUCT_TABLES],
      ),
      pool.query<SessionMessagesForeignKeyRow>(
        `SELECT /* voice_lab_session_messages_fk */ fk.oid, fk.conname,
                fk.convalidated, fk.condeferrable, fk.condeferred,
                pg_get_constraintdef(fk.oid, true) AS definition
           FROM pg_constraint fk
          WHERE fk.conrelid = 'public.sophia_session_messages'::regclass
            AND fk.confrelid = 'public.sophia_sessions'::regclass
            AND fk.contype = 'f'`,
      ),
      pool.query<SessionMessagesForeignKeyTriggerRow>(
        `SELECT /* voice_lab_session_messages_fk_triggers */
                child.relname AS tablename, trigger.tgenabled,
                trigger.tgisinternal, proc.proname
           FROM pg_trigger trigger
           JOIN pg_class child ON child.oid = trigger.tgrelid
           JOIN pg_proc proc ON proc.oid = trigger.tgfoid
          WHERE trigger.tgconstraint IN (
            SELECT fk.oid FROM pg_constraint fk
             WHERE fk.conrelid = 'public.sophia_session_messages'::regclass
               AND fk.confrelid = 'public.sophia_sessions'::regclass
               AND fk.contype = 'f'
          )`,
      ),
      pool.query<SessionMessagesForeignKeyTriggerRow>(
        `SELECT /* voice_lab_cleanup_admissions_fk_triggers */
                relation.relname AS tablename, trigger.tgenabled,
                trigger.tgisinternal, proc.proname
           FROM pg_trigger trigger
           JOIN pg_class relation ON relation.oid = trigger.tgrelid
           JOIN pg_proc proc ON proc.oid = trigger.tgfoid
          WHERE trigger.tgconstraint = (
            SELECT fk.oid FROM pg_constraint fk
             WHERE fk.conrelid =
                   'public.sophia_voice_lab_cleanup_admissions'::regclass
               AND fk.confrelid =
                   'public.sophia_voice_lab_cleanup_obligations'::regclass
               AND fk.conname =
                   'sophia_voice_lab_cleanup_admissions_cleanup_obligation_id_fkey'
               AND fk.contype = 'f'
          )`,
      ),
      pool.query<ProductPrimaryKeyRow>(
        `SELECT /* voice_lab_product_primary_keys */
                relation.relname AS tablename, constraint_row.conname,
                constraint_row.convalidated, constraint_row.condeferrable,
                constraint_row.condeferred,
                pg_get_constraintdef(constraint_row.oid, true) AS definition,
                index_row.indisunique, index_row.indisvalid, index_row.indisready,
                index_relation.relpersistence AS index_relpersistence,
                access_method.amname
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_index index_row ON index_row.indexrelid = constraint_row.conindid
           JOIN pg_class index_relation ON index_relation.oid = constraint_row.conindid
           JOIN pg_am access_method ON access_method.oid = index_relation.relam
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
            AND constraint_row.contype = 'p'`,
        [EXPECTED_PRODUCT_TABLES],
      ),
      pool.query<BetterAuthSessionColumnRow>(
        `SELECT /* voice_lab_better_auth_session_columns */
                attribute.attname AS column_name,
                type.typname AS udt_name,
                CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END
                  AS is_nullable,
                CASE
                  WHEN type.typname IN ('bpchar', 'varchar')
                       AND attribute.atttypmod >= 4
                    THEN attribute.atttypmod - 4
                  ELSE NULL
                END AS character_maximum_length,
                CASE WHEN attribute.attgenerated = '' THEN 'NEVER' ELSE 'ALWAYS' END
                  AS is_generated,
                CASE WHEN attribute.attidentity = '' THEN 'NO' ELSE 'YES' END
                  AS is_identity
           FROM pg_attribute attribute
           JOIN pg_class relation ON relation.oid = attribute.attrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_type type ON type.oid = attribute.atttypid
          WHERE namespace.nspname = 'public' AND relation.relname = 'session'
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
          ORDER BY attribute.attnum`,
      ),
      pool.query<ProductCleanupIndexRow>(
        `SELECT /* voice_lab_better_auth_session_indexes */
                idx.relname AS indexname, tbl.relname AS tablename,
                i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts,
                idx.relpersistence AS index_relpersistence, am.amname,
                ARRAY(
                  SELECT pg_get_indexdef(i.indexrelid, key_position, true)
                    FROM generate_series(1, i.indnkeyatts) AS key_position
                   ORDER BY key_position
                ) AS key_expressions,
                ARRAY(
                  SELECT (i.indoption::smallint[])[key_position]
                    FROM generate_series(0, i.indnkeyatts - 1) AS key_position
                   ORDER BY key_position
                ) AS key_options,
                pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
                NULL::text AS index_comment
           FROM pg_index i
           JOIN pg_class idx ON idx.oid = i.indexrelid
           JOIN pg_class tbl ON tbl.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
           JOIN pg_am am ON am.oid = idx.relam
          WHERE ns.nspname = 'public' AND tbl.relname = 'session'
            AND idx.relname = ANY($1::text[])`,
        [[...EXPECTED_BETTER_AUTH_SESSION_INDEXES.keys()]],
      ),
      pool.query<BetterAuthSessionConstraintRow>(
        `SELECT /* voice_lab_better_auth_session_key_constraints */
                conname, contype, convalidated, condeferrable, condeferred,
                pg_get_constraintdef(oid, true) AS definition
           FROM pg_constraint
          WHERE conrelid = 'public."session"'::regclass
            AND contype = ANY(ARRAY['p'::"char", 'u'::"char"])
          ORDER BY conname`,
      ),
      pool.query<BetterAuthSessionRelationRow>(
        `SELECT /* voice_lab_better_auth_session_relation */
                has_table_privilege(current_user, 'public."session"', 'SELECT')
                  AS can_select,
                has_table_privilege(current_user, 'public."session"', 'INSERT')
                  AS can_insert,
                has_table_privilege(current_user, 'public."session"', 'UPDATE')
                  AS can_update,
                has_table_privilege(current_user, 'public."session"', 'DELETE')
                  AS can_delete,
                relation.relowner = control.relowner AS owner_matches_control,
                pg_get_userbyid(relation.relowner) = '${EXPECTED_DATABASE_OWNER_ROLE}'
                  AS owner_is_expected,
                relation.relkind, relation.relpersistence,
                relation.relispartition,
                NOT EXISTS (
                  SELECT 1 FROM pg_inherits inheritance
                   WHERE inheritance.inhparent = relation.oid
                      OR inheritance.inhrelid = relation.oid
                ) AS inheritance_free,
                NOT EXISTS (
                  SELECT 1 FROM pg_rewrite rewrite
                   WHERE rewrite.ev_class = relation.oid
                ) AS rewrite_free,
                relation.relrowsecurity, relation.relforcerowsecurity,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(
                      COALESCE(relation.relacl, acldefault('r', relation.relowner))
                    ) acl
                   WHERE acl.grantee <> relation.relowner
                     AND NOT (
                       acl.grantee = ANY(ARRAY[
                         current_user::regrole,
                         to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}')
                       ])
                       AND acl.privilege_type = ANY(
                         ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                       )
                       AND NOT acl.is_grantable
                     )
                ) AS unexpected_acl,
                EXISTS (
                  SELECT 1 FROM pg_attribute attribute,
                       LATERAL aclexplode(attribute.attacl) acl
                   WHERE attribute.attrelid = relation.oid
                     AND attribute.attnum > 0 AND NOT attribute.attisdropped
                ) AS unexpected_column_acl,
                EXISTS (
                  SELECT 1
                    FROM aclexplode(
                      COALESCE(relation.relacl, acldefault('r', relation.relowner))
                    ) acl
                   WHERE acl.grantee = 0
                     AND acl.privilege_type = ANY(
                       ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                     )
                ) AS public_can_access,
                CASE WHEN to_regrole('anon') IS NULL THEN false ELSE
                  has_table_privilege(to_regrole('anon'), 'public."session"', 'SELECT')
                  OR has_table_privilege(to_regrole('anon'), 'public."session"', 'INSERT')
                  OR has_table_privilege(to_regrole('anon'), 'public."session"', 'UPDATE')
                  OR has_table_privilege(to_regrole('anon'), 'public."session"', 'DELETE')
                END AS anon_can_access,
                CASE WHEN to_regrole('authenticated') IS NULL THEN false ELSE
                  has_table_privilege(to_regrole('authenticated'), 'public."session"', 'SELECT')
                  OR has_table_privilege(to_regrole('authenticated'), 'public."session"', 'INSERT')
                  OR has_table_privilege(to_regrole('authenticated'), 'public."session"', 'UPDATE')
                  OR has_table_privilege(to_regrole('authenticated'), 'public."session"', 'DELETE')
                END AS authenticated_can_access,
                CASE WHEN to_regrole('service_role') IS NULL THEN false ELSE
                  has_table_privilege(to_regrole('service_role'), 'public."session"', 'SELECT')
                  OR has_table_privilege(to_regrole('service_role'), 'public."session"', 'INSERT')
                  OR has_table_privilege(to_regrole('service_role'), 'public."session"', 'UPDATE')
                  OR has_table_privilege(to_regrole('service_role'), 'public."session"', 'DELETE')
                END AS service_can_access
           FROM pg_class relation
           JOIN pg_class control ON control.oid =
                'public.sophia_voice_lab_cleanup_obligations'::regclass
          WHERE relation.oid = 'public."session"'::regclass`,
      ),
      pool.query<CleanupControlColumnRow>(
        `SELECT /* voice_lab_cleanup_control_columns */
                relation.relname AS table_name,
                attribute.attname AS column_name,
                type.typname AS udt_name,
                CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END
                  AS is_nullable,
                pg_get_expr(default_value.adbin, default_value.adrelid)
                  AS column_default,
                CASE
                  WHEN type.typname IN ('bpchar', 'varchar')
                       AND attribute.atttypmod >= 4
                    THEN attribute.atttypmod - 4
                  ELSE NULL
                END AS character_maximum_length,
                CASE WHEN attribute.attgenerated = '' THEN 'NEVER' ELSE 'ALWAYS' END
                  AS is_generated,
                CASE WHEN attribute.attidentity = '' THEN 'NO' ELSE 'YES' END
                  AS is_identity
           FROM pg_attribute attribute
           JOIN pg_class relation ON relation.oid = attribute.attrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_type type ON type.oid = attribute.atttypid
           LEFT JOIN pg_attrdef default_value
             ON default_value.adrelid = attribute.attrelid
            AND default_value.adnum = attribute.attnum
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
          ORDER BY relation.relname, attribute.attnum`,
        [[...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<ProductCleanupIndexRow>(
        `SELECT idx.relname AS indexname, tbl.relname AS tablename,
                i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts,
                idx.relpersistence AS index_relpersistence, am.amname,
                ARRAY(
                  SELECT pg_get_indexdef(i.indexrelid, key_position, true)
                    FROM generate_series(1, i.indnkeyatts) AS key_position
                   ORDER BY key_position
                ) AS key_expressions,
                ARRAY(
                  SELECT (i.indoption::smallint[])[key_position]
                    FROM generate_series(0, i.indnkeyatts - 1) AS key_position
                   ORDER BY key_position
                ) AS key_options,
                pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
                NULL::text AS index_comment
           FROM pg_index i
           JOIN pg_class idx ON idx.oid = i.indexrelid
           JOIN pg_class tbl ON tbl.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
           JOIN pg_am am ON am.oid = idx.relam
          WHERE ns.nspname = 'public' AND tbl.relname = ANY($1::text[])`,
        [[...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<(AuthLedgerConstraintRow & { tablename: string })>(
        `SELECT c.relname AS tablename, con.conname, con.contype,
                con.convalidated, pg_get_constraintdef(con.oid, true) AS definition
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<CleanupControlPrivilegeRow>(
        `SELECT table_name,
                has_table_privilege(current_user, format('public.%I', table_name), 'SELECT') AS can_select,
                has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS can_insert,
                has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS can_update,
                has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS can_delete,
                c.relowner = control.relowner AS owner_matches_control,
                pg_get_userbyid(c.relowner) = '${EXPECTED_DATABASE_OWNER_ROLE}'
                  AS owner_is_expected,
                c.relkind, c.relpersistence, c.relispartition,
                NOT EXISTS (
                  SELECT 1 FROM pg_inherits inheritance
                   WHERE inheritance.inhparent = c.oid OR inheritance.inhrelid = c.oid
                ) AS inheritance_free,
                NOT EXISTS (
                  SELECT 1 FROM pg_rewrite rewrite
                   WHERE rewrite.ev_class = c.oid
                ) AS rewrite_free,
                c.relrowsecurity, c.relforcerowsecurity,
                CASE WHEN to_regrole('service_role') IS NULL THEN false ELSE
                  has_table_privilege(to_regrole('service_role'), c.oid, 'SELECT')
                  OR has_table_privilege(to_regrole('service_role'), c.oid, 'INSERT')
                  OR has_table_privilege(to_regrole('service_role'), c.oid, 'UPDATE')
                  OR has_table_privilege(to_regrole('service_role'), c.oid, 'DELETE')
                  OR has_table_privilege(to_regrole('service_role'), c.oid, 'TRUNCATE')
                  OR has_table_privilege(to_regrole('service_role'), c.oid, 'REFERENCES')
                  OR has_table_privilege(to_regrole('service_role'), c.oid, 'TRIGGER')
                END AS service_can_access,
                EXISTS (
                  SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
                   WHERE acl.grantee <> c.relowner
                     AND (
                       acl.is_grantable
                       OR NOT (
                       acl.grantee = current_user::regrole
                       AND (
                         (
                           table_name = 'sophia_voice_lab_cleanup_obligations'
                           AND acl.privilege_type = ANY(
                             ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                           )
                         )
                         OR (
                           table_name = 'sophia_voice_lab_cleanup_admissions'
                           AND acl.privilege_type = ANY(
                             ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
                           )
                         )
                         OR (
                           table_name = 'sophia_voice_lab_cleanup_scan_cursors'
                           AND acl.privilege_type = ANY(
                             ARRAY['SELECT', 'UPDATE']
                           )
                         )
                       )
                     )
                     )
                ) AS unexpected_acl,
                EXISTS (
                  SELECT 1 FROM pg_attribute a,
                       LATERAL aclexplode(a.attacl) acl
                   WHERE a.attrelid = c.oid AND a.attnum > 0
                     AND NOT a.attisdropped AND acl.grantee <> c.relowner
                ) AS unexpected_column_acl
           FROM unnest($1::text[]) AS table_name
           JOIN pg_class c ON c.oid = format('public.%I', table_name)::regclass
           JOIN pg_class control ON control.oid =
                'public.sophia_voice_lab_cleanup_obligations'::regclass`,
        [[...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `SELECT table_name, grantee, privilege_type
           FROM information_schema.table_privileges
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])
            AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
        [[...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<{ table_name: string; table_comment: string | null }>(
        `SELECT c.relname AS table_name,
                obj_description(c.oid, 'pg_class') AS table_comment
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...EXPECTED_CLEANUP_CONTROL_COLUMNS.keys()]],
      ),
      pool.query<CleanupControlColumnRow>(
        `SELECT /* voice_lab_d02_columns */ relation.relname AS table_name,
                attribute.attname AS column_name, type.typname AS udt_name,
                CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END
                  AS is_nullable,
                pg_get_expr(default_value.adbin, default_value.adrelid, true)
                  AS column_default,
                CASE
                  WHEN type.typname IN ('bpchar', 'varchar')
                       AND attribute.atttypmod >= 4
                    THEN attribute.atttypmod - 4
                  ELSE NULL
                END AS character_maximum_length,
                CASE WHEN attribute.attgenerated = '' THEN 'NEVER' ELSE 'ALWAYS' END
                  AS is_generated,
                CASE WHEN attribute.attidentity = '' THEN 'NO' ELSE 'YES' END
                  AS is_identity
           FROM pg_attribute attribute
           JOIN pg_class relation ON relation.oid = attribute.attrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           JOIN pg_type type ON type.oid = attribute.atttypid
           LEFT JOIN pg_attrdef default_value
             ON default_value.adrelid = relation.oid
            AND default_value.adnum = attribute.attnum
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
            AND attribute.attnum > 0 AND NOT attribute.attisdropped
          ORDER BY relation.relname, attribute.attnum`,
        [[...EXPECTED_D02_COLUMNS.keys()]],
      ),
      pool.query<D02RelationRow>(
        `SELECT /* voice_lab_d02_relations */ relation.relname AS table_name,
                pg_get_userbyid(relation.relowner) AS owner_name,
                relation.relkind, relation.relpersistence,
                relation.relispartition, relation.relrowsecurity,
                relation.relforcerowsecurity,
                NOT EXISTS (
                  SELECT 1 FROM pg_inherits inheritance
                   WHERE inheritance.inhparent = relation.oid
                      OR inheritance.inhrelid = relation.oid
                ) AS inheritance_free,
                NOT EXISTS (
                  SELECT 1 FROM pg_rewrite rewrite
                   WHERE rewrite.ev_class = relation.oid
                ) AS rewrite_free,
                NOT EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                   WHERE attribute.attrelid = relation.oid
                     AND attribute.attnum > 0 AND NOT attribute.attisdropped
                     AND attribute.attacl IS NOT NULL
                ) AS column_acl_free,
                obj_description(relation.oid, 'pg_class') AS table_comment
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND starts_with(relation.relname, 'sophia_voice_lab_d02_')
            AND relation.relkind <> 'i'
          ORDER BY relation.relname`,
      ),
      pool.query<{
        table_name: string;
        grantee_name: string | null;
        privilege_type: string;
        is_grantable: boolean;
      }>(
        `SELECT /* voice_lab_d02_direct_acl */ relation.relname AS table_name,
                grantee_role.rolname AS grantee_name,
                acl.privilege_type, acl.is_grantable
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           CROSS JOIN LATERAL aclexplode(
             COALESCE(relation.relacl, acldefault('r', relation.relowner))
           ) acl
           LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
            AND acl.grantee <> relation.relowner
          ORDER BY relation.relname, grantee_role.rolname, acl.privilege_type`,
        [[...EXPECTED_D02_COLUMNS.keys()]],
      ),
      pool.query<D02ConstraintRow>(
        `SELECT /* voice_lab_d02_constraints */ relation.relname AS tablename,
                constraint_row.conname, constraint_row.contype,
                constraint_row.convalidated, constraint_row.condeferrable,
                constraint_row.condeferred,
                pg_get_constraintdef(constraint_row.oid, true) AS definition,
                encode(sha256(convert_to(
                  regexp_replace(
                    btrim(pg_get_constraintdef(constraint_row.oid, true)),
                    E'\\\\s+', ' ', 'g'
                  ), 'UTF8'
                )), 'hex') AS definition_sha256
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
          ORDER BY relation.relname, constraint_row.conname`,
        [[...EXPECTED_D02_COLUMNS.keys()]],
      ),
      pool.query<D02IndexRow>(
        `SELECT /* voice_lab_d02_indexes */
                table_relation.relname AS tablename,
                index_relation.relname AS indexname,
                index_row.indisunique, index_row.indisvalid,
                index_row.indisready, index_row.indimmediate,
                index_row.indnkeyatts,
                index_relation.relpersistence AS index_relpersistence,
                access_method.amname,
                ARRAY(
                  SELECT pg_get_indexdef(index_row.indexrelid, position, true)
                    FROM generate_series(1, index_row.indnkeyatts) position
                   ORDER BY position
                ) AS key_expressions,
                ARRAY(
                  SELECT (index_row.indoption::smallint[])[position]
                    FROM generate_series(0, index_row.indnkeyatts - 1) position
                   ORDER BY position
                ) AS key_options,
                pg_get_expr(index_row.indpred, index_row.indrelid, true)
                  AS predicate,
                ARRAY(
                  SELECT operator_class.opcname
                    FROM unnest(index_row.indclass::oid[]) WITH ORDINALITY
                         item(oid, position)
                    JOIN pg_opclass operator_class ON operator_class.oid = item.oid
                   ORDER BY item.position
                )::text[] AS opclasses,
                ARRAY(
                  SELECT COALESCE(collation_row.collname, '')
                    FROM unnest(index_row.indcollation::oid[]) WITH ORDINALITY
                         item(oid, position)
                    LEFT JOIN pg_collation collation_row
                      ON collation_row.oid = item.oid
                   ORDER BY item.position
                )::text[] AS collations,
                NULL::text AS index_comment
           FROM pg_index index_row
           JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
           JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
           JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
           JOIN pg_am access_method ON access_method.oid = index_relation.relam
          WHERE namespace.nspname = 'public'
            AND table_relation.relname = ANY($1::text[])
          ORDER BY table_relation.relname, index_relation.relname`,
        [[...EXPECTED_D02_COLUMNS.keys()]],
      ),
      pool.query<D02ForeignKeyTriggerRow>(
        `SELECT /* voice_lab_d02_fk_triggers */
                source.relname AS source_table,
                constraint_row.conname AS constraint_name,
                target.relname AS tablename, procedure.proname,
                trigger_row.tgenabled, trigger_row.tgisinternal
           FROM pg_trigger trigger_row
           JOIN pg_constraint constraint_row
             ON constraint_row.oid = trigger_row.tgconstraint
           JOIN pg_class source ON source.oid = constraint_row.conrelid
           JOIN pg_class target ON target.oid = trigger_row.tgrelid
           JOIN pg_proc procedure ON procedure.oid = trigger_row.tgfoid
          WHERE source.relname = ANY($1::text[])
            AND constraint_row.contype = 'f'
          ORDER BY source.relname, constraint_row.conname,
                   target.relname, procedure.proname`,
        [[...EXPECTED_D02_COLUMNS.keys()]],
      ),
      pool.query<{ table_name: string; trigger_name: string }>(
        `SELECT /* voice_lab_d02_noninternal_triggers */
                relation.relname AS table_name, trigger_row.tgname AS trigger_name
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY($1::text[])
            AND NOT trigger_row.tgisinternal`,
        [[...EXPECTED_D02_COLUMNS.keys()]],
      ),
      pool.query<{
        rolname: string;
        rolsuper: boolean;
        rolinherit: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolcanlogin: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        membership_contract_version: string;
        membership_direction_attested: boolean;
        canonical_inbound_membership_count: string | number;
        outbound_membership_count: string | number;
        transitive_authority_free: boolean;
        public_schema_create_denied: boolean;
        future_function_public_execute_denied: boolean;
      }>(
        `SELECT /* voice_lab_d02_gateway_role */ role.rolname,
                role.rolsuper, role.rolinherit, role.rolcreaterole,
                role.rolcreatedb, role.rolcanlogin, role.rolreplication,
                role.rolbypassrls,
                ${roleMembershipAttestationSql()},
                NOT has_schema_privilege(role.oid, 'public', 'CREATE')
                  AS public_schema_create_denied,
                EXISTS (
                  SELECT 1
                    FROM pg_default_acl defaults
                   WHERE defaults.defaclrole = to_regrole('postgres')
                     AND defaults.defaclnamespace = 0
                     AND defaults.defaclobjtype = 'f'
                     AND EXISTS (
                       SELECT 1 FROM aclexplode(defaults.defaclacl) acl
                        WHERE acl.grantor = to_regrole('postgres')
                          AND acl.grantee = to_regrole('postgres')
                          AND acl.privilege_type = 'EXECUTE'
                          AND acl.is_grantable = false
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM aclexplode(defaults.defaclacl) acl
                        WHERE acl.grantee IN (
                          0, to_regrole('sophia_voice_lab_gateway')
                        )
                     )
                     AND NOT EXISTS (
                       SELECT 1
                         FROM pg_default_acl additive
                         CROSS JOIN LATERAL aclexplode(
                           additive.defaclacl
                         ) additive_acl
                        WHERE additive.defaclrole = defaults.defaclrole
                          AND additive.defaclobjtype = 'f'
                          AND additive.defaclnamespace = to_regnamespace('public')
                          AND additive_acl.grantee IN (
                            0, to_regrole('sophia_voice_lab_gateway')
                          )
                     )
                     AND NOT EXISTS (
                       SELECT 1
                         FROM pg_default_acl future_defaults
                         CROSS JOIN LATERAL aclexplode(
                           future_defaults.defaclacl
                         ) future_acl
                        WHERE future_defaults.defaclrole = defaults.defaclrole
                          AND future_defaults.defaclobjtype IN ('r', 'S')
                          AND future_defaults.defaclnamespace IN (
                            0, to_regnamespace('public')
                          )
                          AND future_acl.grantee IN (
                            0, to_regrole('sophia_voice_lab_gateway')
                          )
                     )
                ) AS future_function_public_execute_denied
           FROM pg_roles role
          WHERE role.rolname = $1`,
        [EXPECTED_D02_DATABASE_ROLE],
      ),
      pool.query<{ proname: string; identity_arguments: string }>(
        `SELECT /* voice_lab_d02_global_function_authority */
                procedure.proname,
                pg_get_function_identity_arguments(procedure.oid)
                  AS identity_arguments
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'public'
           AND NOT EXISTS (
             SELECT 1
               FROM pg_depend dependency
              WHERE dependency.classid = 'pg_proc'::regclass
                AND dependency.objid = procedure.oid
                AND dependency.deptype = 'e'
           )
           AND CASE WHEN to_regrole($1) IS NULL THEN false ELSE
             has_function_privilege(to_regrole($1), procedure.oid, 'EXECUTE')
           END
          ORDER BY procedure.proname, identity_arguments`,
        [EXPECTED_D02_DATABASE_ROLE],
      ),
      pool.query<{
        table_name: string;
        privilege_type: string;
        permitted: boolean;
      }>(
        `SELECT /* voice_lab_d02_effective_privileges */ table_name,
                privilege_type,
                CASE WHEN to_regrole($1) IS NULL THEN false ELSE
                  has_table_privilege(
                    to_regrole($1), format('public.%I', table_name), privilege_type
                  )
                END AS permitted
           FROM unnest($2::text[]) table_name
           CROSS JOIN unnest(
             ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                   'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
           ) privilege_type
          ORDER BY table_name, privilege_type`,
        [
          EXPECTED_D02_DATABASE_ROLE,
          [...EXPECTED_D02_GATEWAY_EFFECTIVE_PRIVILEGES.keys()],
        ],
      ),
      pool.query<{
        table_name: string;
        privilege_type: string;
        table_permitted: boolean;
        column_permitted: boolean;
      }>(
        `(SELECT /* voice_lab_d02_global_effective_privileges */
                relation.relname AS table_name, privilege_type,
                CASE WHEN to_regrole($1) IS NULL THEN false ELSE
                  has_table_privilege(
                    to_regrole($1), relation.oid, privilege_type
                  )
                END AS table_permitted,
                CASE WHEN to_regrole($1) IS NULL THEN false
                     WHEN privilege_type = ANY(
                       ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
                     ) THEN has_any_column_privilege(
                       to_regrole($1), relation.oid, privilege_type
                     ) ELSE false END AS column_permitted
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
           CROSS JOIN unnest(
             ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                   'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
           ) privilege_type
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        ) UNION ALL (
          SELECT relation.relname AS table_name, privilege_type,
                 CASE WHEN to_regrole($1) IS NULL THEN false ELSE
                   has_sequence_privilege(
                     to_regrole($1), relation.oid, privilege_type
                   )
                 END AS table_permitted,
                 false AS column_permitted
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) privilege_type
           WHERE namespace.nspname = 'public' AND relation.relkind = 'S'
        ) ORDER BY table_name, privilege_type`,
        [EXPECTED_D02_DATABASE_ROLE],
      ),
      pool.query<{
        session_user_name: string;
        current_user_name: string;
        current_role_name: string;
        rolsuper: boolean;
        rolinherit: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolcanlogin: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        membership_contract_version: string;
        membership_direction_attested: boolean;
        canonical_inbound_membership_count: string | number;
        outbound_membership_count: string | number;
        transitive_authority_free: boolean;
        public_schema_create_denied: boolean;
        session_replication_role: string;
        search_path: string;
        transaction_read_only: string;
        synchronous_commit: string;
        in_recovery: boolean;
      }>(
        `SELECT session_user::text AS session_user_name,
                current_user::text AS current_user_name,
                current_role::text AS current_role_name,
                role.rolsuper, role.rolinherit, role.rolcreaterole,
                role.rolcreatedb, role.rolcanlogin, role.rolreplication,
                role.rolbypassrls,
                ${roleMembershipAttestationSql()},
                NOT has_schema_privilege(role.oid, 'public', 'CREATE')
                  AS public_schema_create_denied,
                current_setting('session_replication_role')
                AS session_replication_role,
                current_setting('search_path') AS search_path,
                current_setting('transaction_read_only') AS transaction_read_only,
                current_setting('synchronous_commit') AS synchronous_commit,
                pg_is_in_recovery() AS in_recovery
           FROM pg_roles role
          WHERE role.rolname = current_user`,
      ),
    ]);

    const runtimeCanonicalInboundCount = Number(
      sessionSettings.rows[0]?.canonical_inbound_membership_count,
    );
    if (
      sessionSettings.rows.length !== 1
      || sessionSettings.rows[0].session_user_name !== EXPECTED_RUNTIME_DATABASE_ROLE
      || sessionSettings.rows[0].current_user_name !== EXPECTED_RUNTIME_DATABASE_ROLE
      || sessionSettings.rows[0].current_role_name !== EXPECTED_RUNTIME_DATABASE_ROLE
      || sessionSettings.rows[0].rolsuper !== false
      || sessionSettings.rows[0].rolinherit !== false
      || sessionSettings.rows[0].rolcreaterole !== false
      || sessionSettings.rows[0].rolcreatedb !== false
      || sessionSettings.rows[0].rolcanlogin !== true
      || sessionSettings.rows[0].rolreplication !== false
      || sessionSettings.rows[0].rolbypassrls !== false
      || sessionSettings.rows[0].membership_contract_version
        !== ROLE_MEMBERSHIP_CONTRACT_VERSION
      || sessionSettings.rows[0].membership_direction_attested !== true
      || !Number.isInteger(runtimeCanonicalInboundCount)
      || runtimeCanonicalInboundCount < 0
      || runtimeCanonicalInboundCount > 1
      || Number(sessionSettings.rows[0].outbound_membership_count) !== 0
      || sessionSettings.rows[0].transitive_authority_free !== true
      || sessionSettings.rows[0].public_schema_create_denied !== true
      || sessionSettings.rows[0].session_replication_role !== 'origin'
      || sessionSettings.rows[0].search_path.replace(/\s/g, '')
        !== 'pg_catalog,public,pg_temp'
      || sessionSettings.rows[0].transaction_read_only !== 'off'
      || sessionSettings.rows[0].synchronous_commit === 'off'
      || sessionSettings.rows[0].in_recovery !== false
    ) throw ledgerNotReady();

    if (columns.rows.length !== EXPECTED_AUTH_LEDGER_COLUMNS.size) throw ledgerNotReady();
    for (const column of columns.rows) {
      const expected = EXPECTED_AUTH_LEDGER_COLUMNS.get(column.column_name);
      if (
        !expected
        || column.udt_name !== expected[0]
        || column.is_nullable !== expected[1]
        || (expected[0] === 'bpchar'
          ? Number(column.character_maximum_length) !== 64
          : column.character_maximum_length !== null)
        || column.is_generated !== 'NEVER'
        || column.is_identity !== 'NO'
        || normalizeColumnDefault(column.column_default) !== normalizeColumnDefault(
          EXPECTED_AUTH_LEDGER_DEFAULTS.get(column.column_name),
        )
      ) throw ledgerNotReady();
    }

    const actualIndexes = new Map(indexes.rows.map((row) => [row.indexname, row]));
    if (actualIndexes.size !== EXPECTED_AUTH_LEDGER_INDEXES.size) throw ledgerNotReady();
    for (const [name, expected] of EXPECTED_AUTH_LEDGER_INDEXES) {
      const row = actualIndexes.get(name);
      if (
        !row
        || row.tablename !== expected.table
        || row.indisunique !== expected.unique
        || row.indisvalid !== true
        || row.indisready !== true
        || row.index_relpersistence !== 'p'
        || row.amname !== 'btree'
        || Number(row.indnkeyatts) !== expected.expressions.length
        || row.key_expressions.length !== expected.expressions.length
        || row.key_expressions.some(
          (value, index) => normalizeIndexExpression(value) !== expected.expressions[index],
        )
        || !Array.isArray(row.key_options)
        || row.key_options.length !== expected.options.length
        || row.key_options.some(
          (value, index) => Number(value) !== expected.options[index],
        )
        || normalizeIndexExpression(row.predicate) !== expected.predicate
      ) throw ledgerNotReady();
    }
    const cleanupIndexes = new Map(
      productCleanupIndexes.rows.map((row) => [row.indexname, row]),
    );
    for (const [name, expected] of EXPECTED_PRODUCT_CLEANUP_INDEXES) {
      const actual = cleanupIndexes.get(name);
      if (
        !actual
        || actual.tablename !== expected.table
        || actual.indisunique !== expected.unique
        || actual.indisvalid !== true
        || actual.indisready !== true
        || actual.index_relpersistence !== 'p'
        || actual.amname !== 'btree'
        || Number(actual.indnkeyatts) !== expected.keyCount
        || actual.index_comment !== expected.comment
        || actual.key_expressions.length !== expected.expressions.length
        || actual.key_expressions.some(
          (value, index) => normalizeIndexExpression(value) !== expected.expressions[index],
        )
        || !Array.isArray(actual.key_options)
        || actual.key_options.length !== expected.options.length
        || actual.key_options.some(
          (value, index) => Number(value) !== expected.options[index],
        )
        || normalizeIndexExpression(actual.predicate) !== expected.predicate
      ) throw ledgerNotReady();
    }
    if (productCleanupTriggers.rows.length !== EXPECTED_PRODUCT_CLEANUP_TRIGGERS.size) {
      throw ledgerNotReady();
    }
    const cleanupTriggers = new Map(
      productCleanupTriggers.rows.map((row) => [row.tgname, row]),
    );
    for (const [name, expected] of EXPECTED_PRODUCT_CLEANUP_TRIGGERS) {
      const row = cleanupTriggers.get(name);
      const expectedComment = `sophia.voice-lab.${expected.commentKind}.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256}`;
      const sourceIsExactEnough = expected.functionName === 'sophia_voice_lab_message_write_fence'
        ? row?.prosrc.includes('synthetic transcript parent binding is immutable')
          && row.prosrc.includes("obligation_phase not in ('session_provisional', 'finalizing')")
          && row.prosrc.includes('clock_timestamp() >= obligation_retention')
          && row.prosrc.includes('synthetic transcript retention deletion is unavailable')
        : row?.prosrc.includes('clock_timestamp() >= retention_deadline')
          && row.prosrc.includes('synthetic session signed binding is immutable')
          && row.prosrc.includes('synthetic artifact signed binding is immutable')
          && row.prosrc.includes('synthetic auth tombstone transition is invalid')
          && row.prosrc.includes('synthetic auth tombstone deletion is invalid');
      if (
        !row
        || row.tablename !== expected.table
        || row.tgenabled !== 'O'
        || row.proname !== expected.functionName
        || row.function_schema !== 'public'
        || row.function_is_public_identity !== true
        || row.prosecdef !== true
        || row.provolatile !== 'v'
        || row.lanname !== 'plpgsql'
        || row.owner_matches_control !== true
        || row.owner_is_expected !== true
        || !Array.isArray(row.proconfig)
        || row.proconfig.length !== 1
        || row.proconfig[0] !== 'search_path=pg_catalog, public, pg_temp'
        || row.function_comment !== expectedComment
        || row.trigger_definition !== expected.definition
        || !row.prosrc.includes('pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944))')
        || !sourceIsExactEnough
      ) throw ledgerNotReady();
    }
    const functionRows = new Map(cleanupFunctions.rows.map((row) => [row.proname, row]));
    if (
      cleanupFunctions.rows.length !== EXPECTED_GOVERNED_FUNCTIONS.size
      || functionRows.size !== EXPECTED_GOVERNED_FUNCTIONS.size
    ) throw ledgerNotReady();
    for (const [name, expected] of EXPECTED_GOVERNED_FUNCTIONS) {
      const row = functionRows.get(name);
      if (
        !row
        || row.identity_arguments.replace(/\s+/g, ' ').trim() !== expected.args
        || row.result_type.replace(/\s+/g, ' ').trim() !== expected.result
        || Number(row.pronargdefaults) !== 0
        || row.proargmodes !== null
        || row.prokind !== expected.kind
        || row.proretset !== expected.returnsSet
        || row.proisstrict !== expected.strict
        || row.proleakproof !== expected.leakproof
        || row.proparallel !== expected.parallel
        || row.lanname !== expected.language
        || row.provolatile !== expected.volatility
        || row.prosecdef !== expected.securityDefiner
        || row.owner_matches_control !== true
        || row.owner_is_expected !== true
        || JSON.stringify(row.proconfig || []) !== JSON.stringify(expected.config)
        || row.public_can_execute !== false
        || row.anon_can_execute !== false
        || row.authenticated_can_execute !== false
        || row.service_can_execute !== expected.serviceExecute
        || row.gateway_can_execute !== expected.gatewayExecute
        || row.runtime_can_execute
          !== ('runtimeExecute' in expected && expected.runtimeExecute === true)
        || row.source_sha256 !== expected.sourceSha256
        || ('comment' in expected && row.function_comment !== expected.comment)
        || row.unexpected_execute_acl !== false
        || row.service_execute_grantable !== false
        || row.gateway_execute_grantable !== false
        || row.runtime_execute_grantable !== false
      ) throw ledgerNotReady();
    }
    if (constraints.rows.length !== EXPECTED_AUTH_LEDGER_CONSTRAINTS.size) {
      throw ledgerNotReady();
    }
    for (const row of constraints.rows) {
      const expected = EXPECTED_AUTH_LEDGER_CONSTRAINTS.get(row.conname);
      if (
        !expected
        || row.contype !== expected[0]
        || row.convalidated !== true
        || normalizeConstraintDefinition(row.definition)
          !== normalizeConstraintDefinition(expected[1])
      ) throw ledgerNotReady();
    }

    for (const [table, expectedColumns] of EXPECTED_REQUIRED_PRODUCT_COLUMNS) {
      const actualColumns = productColumns.rows.filter(
        (row) => row.table_name === table,
      );
      for (const [columnName, expected] of expectedColumns) {
        const row = actualColumns.find(
          (candidate) => candidate.column_name === columnName,
        );
        if (
          !row
          || row.udt_name !== expected[0]
          || row.is_nullable !== expected[1]
          || row.character_maximum_length !== null
          || row.is_generated !== 'NEVER'
          || row.is_identity !== 'NO'
          || row.relkind !== 'r'
          || row.relpersistence !== 'p'
          || row.relrowsecurity !== false
          || row.relforcerowsecurity !== false
        ) throw ledgerNotReady();
      }
    }
    const productPrivilegeRows = new Map(
      productPrivileges.rows.map((row) => [row.table_name, row]),
    );
    if (
      productPrivileges.rows.length !== EXPECTED_PRODUCT_TABLES.length
      || productPrivilegeRows.size !== EXPECTED_PRODUCT_TABLES.length
      || EXPECTED_PRODUCT_TABLES.some((table) => {
        const row = productPrivilegeRows.get(table);
        const expected = EXPECTED_RUNTIME_PRODUCT_PRIVILEGES.get(table);
        return !row
          || !expected
          || row.can_select !== expected.select
          || row.can_insert !== expected.insert
          || row.can_update !== expected.update
          || row.can_delete !== expected.delete
          || row.service_can_mutate !== true
          || row.service_has_unsafe !== false
          || row.anon_can_access !== false
          || row.authenticated_can_access !== false
          || row.owner_matches_control !== true
          || row.owner_is_expected !== true
          || row.relispartition !== false
          || row.inheritance_free !== true
          || row.rewrite_free !== true
          || row.unexpected_acl !== false
          || row.unexpected_column_acl !== false;
      })
      || productUnsafeGrants.rows.length > 0
    ) throw ledgerNotReady();
    if (
      sessionMessagesForeignKey.rows.length !== 1
      || sessionMessagesForeignKey.rows[0].conname
        !== 'sophia_session_messages_session_id_fkey'
      || sessionMessagesForeignKey.rows[0].convalidated !== true
      || sessionMessagesForeignKey.rows[0].condeferrable !== false
      || sessionMessagesForeignKey.rows[0].condeferred !== false
      || normalizeConstraintDefinition(sessionMessagesForeignKey.rows[0].definition)
        !== normalizeConstraintDefinition(EXPECTED_SESSION_MESSAGES_FK.definition)
    ) throw ledgerNotReady();
    const foreignKeyTriggers = new Set(
      sessionMessagesForeignKeyTriggers.rows.map(
        (row) => `${row.tablename}.${row.proname}`,
      ),
    );
    if (
      sessionMessagesForeignKeyTriggers.rows.length
        !== EXPECTED_SESSION_MESSAGES_FK.triggers.size
      || foreignKeyTriggers.size !== EXPECTED_SESSION_MESSAGES_FK.triggers.size
      || [...EXPECTED_SESSION_MESSAGES_FK.triggers].some(
        (triggerName) => !foreignKeyTriggers.has(triggerName),
      )
      || sessionMessagesForeignKeyTriggers.rows.some(
        (row) => row.tgenabled !== 'O' || row.tgisinternal !== true,
      )
    ) throw ledgerNotReady();

    const cleanupAdmissionForeignKeyTriggers = new Set(
      cleanupAdmissionsForeignKeyTriggers.rows.map(
        (row) => `${row.tablename}.${row.proname}`,
      ),
    );
    if (
      cleanupAdmissionsForeignKeyTriggers.rows.length
        !== EXPECTED_CLEANUP_ADMISSIONS_FK.triggers.size
      || cleanupAdmissionForeignKeyTriggers.size
        !== EXPECTED_CLEANUP_ADMISSIONS_FK.triggers.size
      || [...EXPECTED_CLEANUP_ADMISSIONS_FK.triggers].some(
        (triggerName) => !cleanupAdmissionForeignKeyTriggers.has(triggerName),
      )
      || cleanupAdmissionsForeignKeyTriggers.rows.some(
        (row) => row.tgenabled !== 'O' || row.tgisinternal !== true,
      )
    ) throw ledgerNotReady();

    const primaryKeys = new Map(
      productPrimaryKeys.rows.map((row) => [`${row.tablename}.${row.conname}`, row]),
    );
    if (
      productPrimaryKeys.rows.length !== EXPECTED_PRODUCT_PRIMARY_KEYS.size
      || primaryKeys.size !== EXPECTED_PRODUCT_PRIMARY_KEYS.size
    ) throw ledgerNotReady();
    for (const [name, expectedDefinition] of EXPECTED_PRODUCT_PRIMARY_KEYS) {
      const row = primaryKeys.get(name);
      if (
        !row
        || row.convalidated !== true
        || row.condeferrable !== false
        || row.condeferred !== false
        || normalizeConstraintDefinition(row.definition)
          !== normalizeConstraintDefinition(expectedDefinition)
        || row.indisunique !== true
        || row.indisvalid !== true
        || row.indisready !== true
        || row.index_relpersistence !== 'p'
        || row.amname !== 'btree'
      ) throw ledgerNotReady();
    }

    if (betterAuthSessionColumns.rows.length !== EXPECTED_BETTER_AUTH_SESSION_COLUMNS.size) {
      throw ledgerNotReady();
    }
    for (const column of betterAuthSessionColumns.rows) {
      const expected = EXPECTED_BETTER_AUTH_SESSION_COLUMNS.get(column.column_name);
      if (
        !expected
        || column.udt_name !== expected[0]
        || column.is_nullable !== expected[1]
        || column.character_maximum_length !== null
        || column.is_generated !== 'NEVER'
        || column.is_identity !== 'NO'
      ) throw ledgerNotReady();
    }
    const betterAuthIndexes = new Map(
      betterAuthSessionIndexes.rows.map((row) => [row.indexname, row]),
    );
    if (
      betterAuthSessionIndexes.rows.length !== EXPECTED_BETTER_AUTH_SESSION_INDEXES.size
      || betterAuthIndexes.size !== EXPECTED_BETTER_AUTH_SESSION_INDEXES.size
    ) throw ledgerNotReady();
    for (const [name, expected] of EXPECTED_BETTER_AUTH_SESSION_INDEXES) {
      const row = betterAuthIndexes.get(name);
      if (
        !row
        || row.tablename !== 'session'
        || row.indisunique !== expected.unique
        || row.indisvalid !== true
        || row.indisready !== true
        || row.index_relpersistence !== 'p'
        || row.amname !== 'btree'
        || Number(row.indnkeyatts) !== expected.expressions.length
        || row.key_expressions.length !== expected.expressions.length
        || row.key_expressions.some(
          (value, index) => normalizeIndexExpression(value) !== expected.expressions[index],
        )
        || row.key_options.length !== expected.options.length
        || row.key_options.some(
          (value, index) => Number(value) !== expected.options[index],
        )
        || normalizeIndexExpression(row.predicate) !== ''
      ) throw ledgerNotReady();
    }
    const betterAuthConstraints = new Map(
      betterAuthSessionConstraints.rows.map((row) => [row.conname, row]),
    );
    if (
      betterAuthSessionConstraints.rows.length
        !== EXPECTED_BETTER_AUTH_SESSION_KEY_CONSTRAINTS.size
      || betterAuthConstraints.size !== EXPECTED_BETTER_AUTH_SESSION_KEY_CONSTRAINTS.size
    ) throw ledgerNotReady();
    for (const [name, expected] of EXPECTED_BETTER_AUTH_SESSION_KEY_CONSTRAINTS) {
      const row = betterAuthConstraints.get(name);
      if (
        !row
        || row.contype !== expected[0]
        || row.convalidated !== true
        || row.condeferrable !== false
        || row.condeferred !== false
        || normalizeConstraintDefinition(row.definition)
          !== normalizeConstraintDefinition(expected[1])
      ) throw ledgerNotReady();
    }
    const sessionRelation = betterAuthSessionRelation.rows[0];
    if (
      betterAuthSessionRelation.rows.length !== 1
      || sessionRelation.can_select !== true
      || sessionRelation.can_insert !== true
      || sessionRelation.can_update !== true
      || sessionRelation.can_delete !== true
      || sessionRelation.owner_matches_control !== true
      || sessionRelation.owner_is_expected !== true
      || sessionRelation.relkind !== 'r'
      || sessionRelation.relpersistence !== 'p'
      || sessionRelation.relispartition !== false
      || sessionRelation.inheritance_free !== true
      || sessionRelation.rewrite_free !== true
      || sessionRelation.relrowsecurity !== false
      || sessionRelation.relforcerowsecurity !== false
      || sessionRelation.unexpected_acl !== false
      || sessionRelation.unexpected_column_acl !== false
      || sessionRelation.public_can_access !== false
      || sessionRelation.anon_can_access !== false
      || sessionRelation.authenticated_can_access !== false
      || sessionRelation.service_can_access !== false
    ) throw ledgerNotReady();

    for (const [table, expectedColumns] of EXPECTED_CLEANUP_CONTROL_COLUMNS) {
      const actualColumns = cleanupControlColumns.rows.filter(
        (row) => row.table_name === table,
      );
      if (
        actualColumns.length !== expectedColumns.size
        || actualColumns.some((row) => {
          const expected = expectedColumns.get(row.column_name);
          return !expected
            || row.udt_name !== expected[0]
            || row.is_nullable !== expected[1]
            || row.character_maximum_length !== null
            || row.is_generated !== 'NEVER'
            || row.is_identity !== 'NO'
            || normalizeColumnDefault(row.column_default) !== normalizeColumnDefault(
              EXPECTED_CLEANUP_CONTROL_DEFAULTS.get(`${table}.${row.column_name}`),
            );
        })
      ) throw ledgerNotReady();
    }
    const controlIndexes = new Map(
      cleanupControlIndexes.rows.map((row) => [row.indexname, row]),
    );
    if (controlIndexes.size !== EXPECTED_CLEANUP_CONTROL_INDEXES.size) {
      throw ledgerNotReady();
    }
    for (const [name, expected] of EXPECTED_CLEANUP_CONTROL_INDEXES) {
      const row = controlIndexes.get(name);
      if (
        !row
        || row.tablename !== expected.table
        || row.indisunique !== expected.unique
        || row.indisvalid !== true
        || row.indisready !== true
        || row.index_relpersistence !== 'p'
        || row.amname !== 'btree'
        || Number(row.indnkeyatts) !== expected.expressions.length
        || row.key_expressions.length !== expected.expressions.length
        || row.key_expressions.some(
          (value, index) => normalizeIndexExpression(value) !== expected.expressions[index],
        )
        || !Array.isArray(row.key_options)
        || row.key_options.length !== expected.options.length
        || row.key_options.some(
          (value, index) => Number(value) !== expected.options[index],
        )
        || normalizeIndexExpression(row.predicate) !== expected.predicate
      ) throw ledgerNotReady();
    }
    const controlConstraints = new Map(
      cleanupControlConstraints.rows.map((row) => [`${row.tablename}.${row.conname}`, row]),
    );
    if (controlConstraints.size !== EXPECTED_CLEANUP_CONTROL_CONSTRAINTS.size) {
      throw ledgerNotReady();
    }
    for (const [name, expected] of EXPECTED_CLEANUP_CONTROL_CONSTRAINTS) {
      const row = controlConstraints.get(name);
      if (
        !row
        || row.contype !== expected[0]
        || row.convalidated !== true
        || normalizeConstraintDefinition(row.definition)
          !== normalizeConstraintDefinition(expected[1])
      ) throw ledgerNotReady();
    }
    const controlComments = new Map(
      cleanupControlMetadata.rows.map((row) => [row.table_name, row.table_comment]),
    );
    const controlPrivileges = new Map(
      cleanupControlPrivileges.rows.map((row) => [row.table_name, row]),
    );
    if (
      controlPrivileges.size !== EXPECTED_RUNTIME_CLEANUP_CONTROL_PRIVILEGES.size
      || [...EXPECTED_RUNTIME_CLEANUP_CONTROL_PRIVILEGES].some(([table, expected]) => {
        const row = controlPrivileges.get(table);
        return !row
          || row.can_select !== expected.select
          || row.can_insert !== expected.insert
          || row.can_update !== expected.update
          || row.can_delete !== expected.delete
          || row.owner_matches_control !== true
          || row.owner_is_expected !== true
          || row.relkind !== 'r'
          || row.relpersistence !== 'p'
          || row.relispartition !== false
          || row.inheritance_free !== true
          || row.rewrite_free !== true
          || row.relrowsecurity !== false
          || row.relforcerowsecurity !== false
          || row.service_can_access !== false
          || row.unexpected_acl !== false
          || row.unexpected_column_acl !== false;
      })
      || cleanupControlUnsafeGrants.rows.length > 0
      || controlComments.get('sophia_voice_lab_cleanup_obligations')
        !== `sophia.voice-lab.cleanup-obligation-state.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-control-only`
      || controlComments.get('sophia_voice_lab_cleanup_admissions')
        !== `sophia.voice-lab.cleanup-admission-state.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=bounded-opaque-resource-locator-no-principal-run-secret`
      || controlComments.get('sophia_voice_lab_cleanup_scan_cursors')
        !== `sophia.voice-lab.cleanup-scan-cursor.v1 migration_sha256=${VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-control-keyset-only`
    ) throw ledgerNotReady();

    if (
      d02Columns.rows.length
        !== [...EXPECTED_D02_COLUMNS.values()]
          .reduce((count, columns) => count + columns.size, 0)
      || [...EXPECTED_D02_COLUMNS].some(([table, expectedColumns]) => {
        const actualColumns = d02Columns.rows.filter((row) => row.table_name === table);
        return actualColumns.length !== expectedColumns.size
          || actualColumns.some((row) => {
            const expected = expectedColumns.get(row.column_name);
            return !expected
              || row.udt_name !== expected[0]
              || row.is_nullable !== expected[1]
              || (expected[2] === null
                ? row.character_maximum_length !== null
                : Number(row.character_maximum_length) !== expected[2])
              || normalizeColumnDefault(row.column_default)
                !== normalizeColumnDefault(
                  typeof expected[3] === 'string' ? expected[3] : null,
                )
              || row.is_generated !== 'NEVER'
              || row.is_identity !== 'NO';
          });
      })
    ) throw ledgerNotReady();

    const d02RelationMap = new Map(
      d02Relations.rows.map((row) => [row.table_name, row]),
    );
    if (
      d02Relations.rows.length !== EXPECTED_D02_COLUMNS.size
      || d02RelationMap.size !== EXPECTED_D02_COLUMNS.size
      || [...EXPECTED_D02_COLUMNS.keys()].some((table) => {
        const row = d02RelationMap.get(table);
        return !row
          || row.owner_name !== EXPECTED_DATABASE_OWNER_ROLE
          || row.relkind !== 'r'
          || row.relpersistence !== 'p'
          || row.relispartition !== false
          || row.relrowsecurity !== false
          || row.relforcerowsecurity !== false
          || row.inheritance_free !== true
          || row.rewrite_free !== true
          || row.column_acl_free !== true
          || row.table_comment !== EXPECTED_D02_COMMENTS.get(table);
      })
    ) throw ledgerNotReady();

    const actualD02Acl = new Set(
      d02Acl.rows.map((row) => [
        row.table_name,
        row.grantee_name ?? 'PUBLIC',
        row.privilege_type,
        row.is_grantable ? 'grantable' : 'plain',
      ].join('\u0000')),
    );
    const expectedD02Acl = new Set(
      [...EXPECTED_D02_GATEWAY_PRIVILEGES].flatMap(([table, privileges]) =>
        [...privileges].map((privilege) => [
          table,
          EXPECTED_D02_DATABASE_ROLE,
          privilege,
          'plain',
        ].join('\u0000'))),
    );
    if (
      actualD02Acl.size !== expectedD02Acl.size
      || [...actualD02Acl].some((entry) => !expectedD02Acl.has(entry))
    ) throw ledgerNotReady();

    const actualD02Constraints = new Map(
      d02Constraints.rows.map((row) => [`${row.tablename}.${row.conname}`, row]),
    );
    if (
      d02Constraints.rows.length !== EXPECTED_D02_CONSTRAINTS.size
      || actualD02Constraints.size !== EXPECTED_D02_CONSTRAINTS.size
    ) throw ledgerNotReady();
    for (const [name, expected] of EXPECTED_D02_CONSTRAINTS) {
      const row = actualD02Constraints.get(name);
      if (
        !row
        || row.contype !== expected[0]
        || row.convalidated !== true
        || row.condeferrable !== false
        || row.condeferred !== false
        || row.definition_sha256 !== expected[1]
      ) throw ledgerNotReady();
    }

    const actualD02Indexes = new Map(
      d02Indexes.rows.map((row) => [row.indexname, row]),
    );
    if (
      d02Indexes.rows.length !== EXPECTED_D02_INDEXES.size
      || actualD02Indexes.size !== EXPECTED_D02_INDEXES.size
    ) throw ledgerNotReady();
    for (const [name, expected] of EXPECTED_D02_INDEXES) {
      const row = actualD02Indexes.get(name);
      if (
        !row
        || row.tablename !== expected.table
        || row.indisunique !== expected.unique
        || row.indisvalid !== true
        || row.indisready !== true
        || row.indimmediate !== true
        || row.index_relpersistence !== 'p'
        || row.amname !== 'btree'
        || Number(row.indnkeyatts) !== expected.expressions.length
        || row.key_expressions.length !== expected.expressions.length
        || row.key_expressions.some(
          (value, index) => normalizeIndexExpression(value) !== expected.expressions[index],
        )
        || row.key_options.length !== expected.options.length
        || row.key_options.some(
          (value, index) => Number(value) !== expected.options[index],
        )
        || normalizeIndexExpression(row.predicate) !== expected.predicate
        || JSON.stringify(row.opclasses) !== JSON.stringify(expected.opclasses)
        || JSON.stringify(row.collations) !== JSON.stringify(expected.collations)
      ) throw ledgerNotReady();
    }

    const expectedD02ForeignKeys = [...EXPECTED_D02_CONSTRAINTS]
      .filter(([, expected]) => expected[0] === 'f');
    if (d02ForeignKeyTriggers.rows.length !== expectedD02ForeignKeys.length * 4) {
      throw ledgerNotReady();
    }
    for (const [key] of expectedD02ForeignKeys) {
      const [source, constraintName] = key.split('.', 2);
      const rows = d02ForeignKeyTriggers.rows.filter(
        (row) => row.source_table === source && row.constraint_name === constraintName,
      );
      const actualShapes = new Set(
        rows.map((row) => `${row.tablename}.${row.proname}`),
      );
      const expectedShapes = new Set([
        `${source}.RI_FKey_check_ins`,
        `${source}.RI_FKey_check_upd`,
        'sophia_voice_lab_cleanup_obligations.RI_FKey_cascade_del',
        'sophia_voice_lab_cleanup_obligations.RI_FKey_noaction_upd',
      ]);
      if (
        rows.length !== 4
        || actualShapes.size !== expectedShapes.size
        || [...expectedShapes].some((shape) => !actualShapes.has(shape))
        || rows.some((row) => row.tgenabled !== 'O' || row.tgisinternal !== true)
      ) throw ledgerNotReady();
    }
    if (d02NonInternalTriggers.rows.length !== 0) throw ledgerNotReady();

    const gatewayRole = d02Role.rows[0];
    const gatewayCanonicalInboundCount = Number(
      gatewayRole?.canonical_inbound_membership_count,
    );
    if (
      d02Role.rows.length !== 1
      || gatewayRole.rolname !== EXPECTED_D02_DATABASE_ROLE
      || gatewayRole.rolsuper !== false
      || gatewayRole.rolinherit !== false
      || gatewayRole.rolcreaterole !== false
      || gatewayRole.rolcreatedb !== false
      || gatewayRole.rolcanlogin !== true
      || gatewayRole.rolreplication !== false
      || gatewayRole.rolbypassrls !== false
      || gatewayRole.membership_contract_version !== ROLE_MEMBERSHIP_CONTRACT_VERSION
      || gatewayRole.membership_direction_attested !== true
      || !Number.isInteger(gatewayCanonicalInboundCount)
      || gatewayCanonicalInboundCount < 0
      || gatewayCanonicalInboundCount > 1
      || Number(gatewayRole.outbound_membership_count) !== 0
      || gatewayRole.transitive_authority_free !== true
      || gatewayRole.public_schema_create_denied !== true
      || gatewayRole.future_function_public_execute_denied !== true
    ) throw ledgerNotReady();
    const actualEffectivePrivileges = new Map<string, Set<string>>(
      [...EXPECTED_D02_GATEWAY_EFFECTIVE_PRIVILEGES.keys()].map(
        (table) => [table, new Set<string>()],
      ),
    );
    for (const row of d02EffectivePrivileges.rows) {
      if (row.permitted) actualEffectivePrivileges.get(row.table_name)?.add(row.privilege_type);
    }
    if (
      d02EffectivePrivileges.rows.length
        !== EXPECTED_D02_GATEWAY_EFFECTIVE_PRIVILEGES.size * 8
      || [...EXPECTED_D02_GATEWAY_EFFECTIVE_PRIVILEGES].some(([table, expected]) => {
        const actual = actualEffectivePrivileges.get(table);
        return !actual
          || actual.size !== expected.size
          || [...actual].some((privilege) => !expected.has(privilege));
      })
    ) throw ledgerNotReady();
    if (
      d02GlobalEffectivePrivileges.rows.length === 0
      || d02GlobalEffectivePrivileges.rows.some(
        (row) => row.table_permitted === true || row.column_permitted === true,
      )
    ) throw ledgerNotReady();
    const actualD02FunctionAuthority = new Set(
      d02GlobalFunctionAuthority.rows.map(
        (row) => `${row.proname}(${row.identity_arguments.replace(/\s+/g, ' ').trim()})`,
      ),
    );
    const expectedD02FunctionAuthority = new Set(
      [...EXPECTED_D02_FUNCTIONS]
        .filter(([, contract]) => contract.gatewayExecute)
        .map(([name, contract]) => `${name}(${contract.args})`),
    );
    if (
      actualD02FunctionAuthority.size !== expectedD02FunctionAuthority.size
      || [...actualD02FunctionAuthority].some(
        (identity) => !expectedD02FunctionAuthority.has(identity),
      )
    ) throw ledgerNotReady();

    const access = privileges.rows[0];
    if (
      !access?.can_select
      || !access.can_insert
      || !access.can_update
      || !access.can_delete
      || access.owner_matches_control !== true
      || access.owner_is_expected !== true
      || access.relkind !== 'r'
      || access.relpersistence !== 'p'
      || access.relispartition !== false
      || access.inheritance_free !== true
      || access.rewrite_free !== true
      || access.relrowsecurity !== false
      || access.relforcerowsecurity !== false
      || access.unexpected_acl !== false
      || access.unexpected_column_acl !== false
      || unsafeGrants.rows.length > 0
      || unsafeEffectiveTablePrivileges.rows.length > 0
      || metadata.rows[0]?.table_comment !== EXPECTED_AUTH_LEDGER_TABLE_COMMENT
      || unsafeCleanupFenceGrants.rows.length > 0
      || liveTombstoneKids.rows.some(
        (row) => !tombstoneKeyring.keys.has(row.tombstone_kid),
      )
    ) throw ledgerNotReady();

    return {
      ready: true,
      table: AUTH_LEDGER_TABLE,
      migrationSha256: VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256,
      requiredPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    };
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) throw error;
    throw ledgerNotReady();
  }
}

async function assertVoiceLabAuthLedgerReadyInTransaction(
  client: PoolClient,
): Promise<VoiceLabAuthLedgerReadiness> {
  try {
    await lockVoiceLabGovernedRelations(client);
    return await assertVoiceLabAuthLedgerReadyOnClient(client);
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) throw error;
    throw ledgerNotReady();
  }
}

export async function assertVoiceLabAuthLedgerReady(): Promise<VoiceLabAuthLedgerReadiness> {
  const pool = getBetterAuthDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const readiness = await assertVoiceLabAuthLedgerReadyInTransaction(client);
    await client.query('COMMIT');
    return readiness;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof VoiceLabCapabilityError) throw error;
    throw ledgerNotReady();
  } finally {
    client.release();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type AuthTombstoneKeyring = {
  activeKid: string;
  keys: Map<string, string>;
};

function parseUniqueStringKeyring(encoded: string): Array<[string, string]> {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/.test(encoded[cursor] || '')) cursor += 1;
  };
  const readString = (): string => {
    skipWhitespace();
    if (encoded[cursor] !== '"') throw new Error('invalid keyring');
    const start = cursor;
    cursor += 1;
    while (cursor < encoded.length) {
      const char = encoded[cursor];
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (char === '"') {
        const parsed = JSON.parse(encoded.slice(start, cursor)) as unknown;
        if (typeof parsed !== 'string') throw new Error('invalid keyring');
        return parsed;
      }
    }
    throw new Error('invalid keyring');
  };
  skipWhitespace();
  if (encoded[cursor] !== '{') throw new Error('invalid keyring');
  cursor += 1;
  skipWhitespace();
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  if (encoded[cursor] === '}') cursor += 1;
  else {
    while (cursor < encoded.length) {
      const kid = readString();
      if (seen.has(kid)) throw new Error('duplicate keyring kid');
      seen.add(kid);
      skipWhitespace();
      if (encoded[cursor] !== ':') throw new Error('invalid keyring');
      cursor += 1;
      const secret = readString();
      entries.push([kid, secret]);
      skipWhitespace();
      if (encoded[cursor] === '}') {
        cursor += 1;
        break;
      }
      if (encoded[cursor] !== ',') throw new Error('invalid keyring');
      cursor += 1;
    }
  }
  skipWhitespace();
  if (cursor !== encoded.length) throw new Error('invalid keyring');
  return entries;
}

function authTombstoneKeyring(): AuthTombstoneKeyring {
  const activeKid = (
    process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID || 'v1'
  ).trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(activeKid)) throw ledgerNotReady();
  let entries: Array<[string, string]>;
  const encoded = (process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS || '').trim();
  if (process.env.NODE_ENV === 'production' && !encoded) throw ledgerNotReady();
  if (encoded) {
    try {
      entries = parseUniqueStringKeyring(encoded).map(([kid, secret]) => [
        kid,
        secret.trim(),
      ]);
    } catch {
      throw ledgerNotReady();
    }
  } else {
    entries = [[
      activeKid,
      (process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_SECRET || '').trim(),
    ]];
  }
  if (entries.length < 1 || entries.length > 4) throw ledgerNotReady();
  const keys = new Map<string, string>();
  for (const [kid, secret] of entries) {
    if (
      !/^[A-Za-z0-9._-]{1,32}$/.test(kid)
      || keys.has(kid)
      || Buffer.byteLength(secret, 'utf8') < 32
    ) throw ledgerNotReady();
    keys.set(kid, secret);
  }
  if (!keys.has(activeKid) || new Set(keys.values()).size !== keys.size) {
    throw ledgerNotReady();
  }
  for (const secret of keys.values()) {
    for (const name of [
      'SOPHIA_VOICE_LAB_CAPABILITY_SECRET',
      'SOPHIA_VOICE_LAB_GRANT_SECRET',
      'SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET',
    ]) {
      const other = (process.env[name] || '').trim();
      if (other && other === secret) throw ledgerNotReady();
    }
  }
  return { activeKid, keys };
}

function hmacTombstone(
  kind: 'principal' | 'run' | 'cleanup' | 'grant',
  value: string,
  kid?: string,
): string {
  const keyring = authTombstoneKeyring();
  const selectedKid = kid ?? keyring.activeKid;
  const secret = keyring.keys.get(selectedKid);
  if (!secret) throw ledgerNotReady();
  return createHmac('sha256', secret)
    .update(`${AUTH_TOMBSTONE_DOMAIN}\0${selectedKid}\0${kind}\0${value}`, 'utf8')
    .digest('hex');
}

function tombstonedIdentity(
  kind: 'principal' | 'run' | 'cleanup',
  value: string,
  kid?: string,
): string {
  const selectedKid = kid ?? authTombstoneKeyring().activeKid;
  return `hmac:${selectedKid}:${hmacTombstone(kind, value, selectedKid)}`;
}

function tombstonedIdentityCandidates(
  kind: 'principal' | 'run' | 'cleanup',
  value: string,
): string[] {
  return [...authTombstoneKeyring().keys.keys()]
    .sort()
    .map((kid) => tombstonedIdentity(kind, value, kid));
}

function markerFor(grant: VoiceLabCapabilityClaims): StoredGrantMarker {
  return {
    v: 1,
    principal_id: grant.principal_id,
    test_run_id: grant.test_run_id,
    tombstone_kid: authTombstoneKeyring().activeKid,
    cleanup_obligation_id: grant.cleanup_obligation_id,
    provider_expires_at: grant.provider_expires_at,
    retention_hours: grant.retention_hours,
    issued_at: grant.iat,
    jti_sha256: sha256(grant.jti),
    nonce_sha256: sha256(grant.nonce),
  };
}

function fingerprintFor(marker: StoredGrantMarker, kid?: string): string {
  return hmacTombstone('grant', [
    marker.principal_id,
    marker.test_run_id,
    marker.cleanup_obligation_id,
    marker.provider_expires_at,
    String(marker.retention_hours),
    marker.jti_sha256,
    marker.nonce_sha256,
  ].join('\0'), kid);
}

function fingerprintCandidates(marker: StoredGrantMarker): string[] {
  return [...authTombstoneKeyring().keys.keys()]
    .sort()
    .map((kid) => fingerprintFor(marker, kid));
}

function serializeMarker(marker: StoredGrantMarker): string {
  return MARKER_PREFIX + Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url');
}

function parseMarker(value: string | null): StoredGrantMarker | null {
  if (!value?.startsWith(MARKER_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(MARKER_PREFIX.length), 'base64url').toString('utf8'),
    ) as Partial<StoredGrantMarker>;
    if (
      parsed.v !== 1
      || typeof parsed.principal_id !== 'string'
      || typeof parsed.test_run_id !== 'string'
      || typeof parsed.tombstone_kid !== 'string'
      || !/^[A-Za-z0-9._-]{1,32}$/.test(parsed.tombstone_kid)
      || typeof parsed.cleanup_obligation_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.cleanup_obligation_id)
      || typeof parsed.provider_expires_at !== 'string'
      || Number.isNaN(new Date(parsed.provider_expires_at).getTime())
      || !Number.isInteger(parsed.retention_hours)
      || (parsed.retention_hours ?? 0) < 1
      || (parsed.retention_hours ?? 0) > 168
      || !Number.isInteger(parsed.issued_at)
      || !/^[a-f0-9]{64}$/.test(parsed.jti_sha256 || '')
      || !/^[a-f0-9]{64}$/.test(parsed.nonce_sha256 || '')
    ) return null;
    return parsed as StoredGrantMarker;
  } catch {
    return null;
  }
}

function sameGrant(left: StoredGrantMarker, right: StoredGrantMarker): boolean {
  return left.principal_id === right.principal_id
    && left.test_run_id === right.test_run_id
    && left.cleanup_obligation_id === right.cleanup_obligation_id
    && left.provider_expires_at === right.provider_expires_at
    && left.retention_hours === right.retention_hours
    && left.issued_at === right.issued_at
    && left.jti_sha256 === right.jti_sha256
    && left.nonce_sha256 === right.nonce_sha256;
}

function markerMatchesLedger(
  marker: StoredGrantMarker,
  row: GrantLedgerRow,
  rawToken: string,
): boolean {
  return row.status === 'active'
    && row.test_run_id === marker.test_run_id
    && row.tombstone_kid === marker.tombstone_kid
    && row.cleanup_obligation_id === marker.cleanup_obligation_id
    && new Date(row.provider_expires_at).toISOString() === marker.provider_expires_at
    && Number(row.retention_hours) === marker.retention_hours
    && Number(row.issued_at) === marker.issued_at
    && row.jti_sha256 === marker.jti_sha256
    && row.nonce_sha256 === marker.nonce_sha256
    && row.session_token_sha256 === sha256(rawToken);
}

export async function rotateVoiceLabSession(
  principalId: string,
  grant: VoiceLabCapabilityClaims,
  rawSessionToken: string,
  expiresAt: Date,
): Promise<RotatedVoiceLabSession> {
  const pool = getBetterAuthDatabase();
  const client = await pool.connect();
  const incoming = markerFor(grant);
  const keyring = authTombstoneKeyring();
  const fingerprint = fingerprintFor(incoming, keyring.activeKid);
  const incomingFingerprints = fingerprintCandidates(incoming);
  const principalCandidates = [
    principalId,
    ...tombstonedIdentityCandidates('principal', principalId),
  ];
  const cleanupCandidates = [
    incoming.cleanup_obligation_id,
    ...tombstonedIdentityCandidates('cleanup', incoming.cleanup_obligation_id),
  ];
  const providerExpiresAt = new Date(grant.provider_expires_at);
  try {
    await client.query('BEGIN');
    await assertVoiceLabAuthLedgerReadyInTransaction(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 731941))',
      [principalId],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 731944))',
      [incoming.cleanup_obligation_id],
    );
    const existingObligation = (await client.query<{
      state: string;
      lifecycle_phase: string;
      retention_expires_at: Date;
      provider_expires_at: Date;
    }>(
      'SELECT "state", "lifecycle_phase", "retention_expires_at", "provider_expires_at" '
        + 'FROM public."sophia_voice_lab_cleanup_obligations" '
        + 'WHERE "cleanup_obligation_id" = $1 FOR UPDATE',
      [incoming.cleanup_obligation_id],
    )).rows[0];
    const ledgerResult = await client.query<GrantLedgerRow>(
      'SELECT "grant_fingerprint", "test_run_id", "tombstone_kid", "cleanup_obligation_id", "issued_at", "expires_at", "provider_expires_at", "retention_hours", '
        + '"jti_sha256", "nonce_sha256", "session_token_sha256", "status" '
        + 'FROM public."sophia_voice_lab_auth_grants" '
        + 'WHERE "principal_id" = ANY($1::text[]) '
        + 'OR "grant_fingerprint" = ANY($2::bpchar[]) '
        + 'OR "cleanup_obligation_id" = ANY($3::text[]) FOR UPDATE',
      [
        principalCandidates,
        incomingFingerprints,
        cleanupCandidates,
      ],
    );
    const result = await client.query<SessionRow>(
      'SELECT "token", "expiresAt", "userAgent" FROM public."session" '
        + 'WHERE "userId" = $1 FOR UPDATE',
      [principalId],
    );
    const now = Date.now();
    const parsedAllRows = result.rows.map((row) => ({ row, marker: parseMarker(row.userAgent) }));
    if (parsedAllRows.some(({ marker }) => marker === null || marker.principal_id !== principalId)) {
      throw new VoiceLabCapabilityError(
        'voice_lab_dedicated_principal_session_conflict',
        409,
      );
    }
    const expiredRows = parsedAllRows.filter(
      ({ row }) => new Date(row.expiresAt).getTime() <= now,
    );
    if (expiredRows.some(({ row, marker }) => (
      marker === null
      || !ledgerResult.rows.some((ledger) => markerMatchesLedger(marker, ledger, row.token))
    ))) {
      throw new VoiceLabCapabilityError('voice_lab_auth_ledger_binding_mismatch', 409);
    }
    let expiredLabSessionsRevoked = 0;
    const expiredFingerprints = new Set<string>();
    for (const { row, marker } of expiredRows) {
      if (marker === null) continue;
      const markerFingerprints = new Set(fingerprintCandidates(marker));
      const ledger = ledgerResult.rows.find(
        (candidate) => markerFingerprints.has(candidate.grant_fingerprint),
      );
      if (!ledger) {
        throw new VoiceLabCapabilityError('voice_lab_expired_session_cleanup_unconfirmed', 503);
      }
      const expiredFingerprint = ledger.grant_fingerprint;
      const tombstoneKid = ledger.tombstone_kid;
      const deleted = await client.query(
        'DELETE FROM public."session" WHERE "userId" = $1 AND "token" = $2',
        [principalId, row.token],
      );
      if ((deleted.rowCount || 0) !== 1) {
        throw new VoiceLabCapabilityError('voice_lab_expired_session_cleanup_unconfirmed', 503);
      }
      const revoked = await client.query(
        'UPDATE public."sophia_voice_lab_auth_grants" SET "status" = \'revoked\', '
          + '"revoked_at" = COALESCE("revoked_at", NOW()), '
          + '"principal_id" = $3, "test_run_id" = $4, "cleanup_obligation_id" = $5, '
          + '"jti_sha256" = $6, "nonce_sha256" = $6, "session_token_sha256" = $6 '
          + 'WHERE "principal_id" = $1 AND "grant_fingerprint" = $2 '
          + 'AND "tombstone_kid" = $7 AND "status" = \'active\'',
        [
          principalId,
          expiredFingerprint,
          tombstonedIdentity('principal', principalId, tombstoneKid),
          tombstonedIdentity('run', marker.test_run_id, tombstoneKid),
          tombstonedIdentity('cleanup', marker.cleanup_obligation_id, tombstoneKid),
          REDACTED_SHA256,
          tombstoneKid,
        ],
      );
      if ((revoked.rowCount || 0) !== 1) {
        throw new VoiceLabCapabilityError('voice_lab_expired_session_cleanup_unconfirmed', 503);
      }
      expiredFingerprints.add(expiredFingerprint);
      expiredLabSessionsRevoked += 1;
    }
    const parsedRows = parsedAllRows.filter(
      ({ row }) => new Date(row.expiresAt).getTime() > now,
    );
    const effectiveLedgerRows = ledgerResult.rows.map((row) => (
      expiredFingerprints.has(row.grant_fingerprint)
        ? { ...row, status: 'revoked' as const }
        : row
    ));

    const priorGrant = effectiveLedgerRows.find(
      (row) => incomingFingerprints.includes(row.grant_fingerprint),
    );
    if (priorGrant?.status === 'revoked') {
      throw new VoiceLabCapabilityError('voice_lab_grant_replayed_after_cleanup', 409);
    }
    const replay = parsedRows.find(({ row, marker }) => (
      marker
      && sameGrant(marker, incoming)
      && sha256(row.token) === priorGrant?.session_token_sha256
    ));
    if (priorGrant?.status === 'active' && replay) {
      if (
        !existingObligation
        || existingObligation.state !== 'open'
        || !['auth_provisional', 'session_provisional'].includes(
          existingObligation.lifecycle_phase,
        )
        || new Date(existingObligation.provider_expires_at).getTime()
          !== providerExpiresAt.getTime()
        || new Date(existingObligation.retention_expires_at).getTime()
          < providerExpiresAt.getTime()
      ) {
        throw new VoiceLabCapabilityError('voice_lab_cleanup_obligation_closed', 409);
      }
      await client.query('COMMIT');
      return {
        token: replay.row.token,
        expiresAt: new Date(replay.row.expiresAt),
        idempotentReplay: true,
        expiredLabSessionsRevoked,
      };
    }
    if (priorGrant) {
      throw new VoiceLabCapabilityError(
        'voice_lab_grant_replay_without_live_session',
        409,
      );
    }

    const currentIssuedAt = effectiveLedgerRows
      .map((row) => Number(row.issued_at))
      .sort((left, right) => right - left)[0];
    if (currentIssuedAt !== undefined && incoming.issued_at < currentIssuedAt) {
      throw new VoiceLabCapabilityError('voice_lab_stale_grant_rejected', 409);
    }
    const sameSecondActiveGrant = effectiveLedgerRows.some(
      (row) => Number(row.issued_at) === incoming.issued_at && row.status === 'active',
    );
    if (
      currentIssuedAt !== undefined
      && incoming.issued_at === currentIssuedAt
      && sameSecondActiveGrant
    ) {
      throw new VoiceLabCapabilityError('voice_lab_grant_order_conflict', 409);
    }
    if (effectiveLedgerRows.some((row) => row.status === 'active') || parsedRows.length > 0) {
      throw new VoiceLabCapabilityError('voice_lab_auth_active_run_conflict', 409);
    }

    const nowDate = new Date();
    const insertedObligation = existingObligation ? null : await client.query<{
      state: string;
      lifecycle_phase: string;
      retention_expires_at: Date;
      provider_expires_at: Date;
    }>(
      'INSERT INTO public."sophia_voice_lab_cleanup_obligations" '
        + '("cleanup_obligation_id", "state", "lifecycle_phase", "retention_expires_at", "provider_expires_at") '
        + 'VALUES ($1, \'open\', \'auth_provisional\', $2, $2) '
        + 'ON CONFLICT ("cleanup_obligation_id") DO NOTHING RETURNING '
        + '"state", "lifecycle_phase", "retention_expires_at", "provider_expires_at"',
      [incoming.cleanup_obligation_id, providerExpiresAt],
    );
    const lockedObligation = existingObligation ?? insertedObligation?.rows[0];
    if (
      !lockedObligation
      || lockedObligation.state !== 'open'
      || lockedObligation.lifecycle_phase !== 'auth_provisional'
      || new Date(lockedObligation.retention_expires_at).getTime()
        !== providerExpiresAt.getTime()
      || new Date(lockedObligation.provider_expires_at).getTime()
        !== providerExpiresAt.getTime()
    ) {
      throw new VoiceLabCapabilityError('voice_lab_cleanup_obligation_closed', 409);
    }
    const insertedSession = await client.query(
      'INSERT INTO public."session" '
        + '("id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId") '
        + 'VALUES ($1, $2, $3, $4, $4, $5, $6, $7)',
      [
        randomUUID(),
        expiresAt,
        rawSessionToken,
        nowDate,
        '',
        serializeMarker(incoming),
        principalId,
      ],
    );
    if (insertedSession.rowCount !== 1) {
      throw new VoiceLabCapabilityError('voice_lab_auth_session_mutation_unconfirmed', 503);
    }
    await client.query(
      'DELETE FROM public."sophia_voice_lab_auth_grants" '
        + 'WHERE "status" = \'revoked\' AND "expires_at" <= NOW()',
    );
    const insertedGrant = await client.query(
      'INSERT INTO public."sophia_voice_lab_auth_grants" '
        + '("grant_fingerprint", "principal_id", "test_run_id", "tombstone_kid", "cleanup_obligation_id", "issued_at", '
        + '"expires_at", "provider_expires_at", "retention_hours", "jti_sha256", "nonce_sha256", "session_token_sha256", "status") '
        + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, \'active\')',
      [
        fingerprint,
        principalId,
        incoming.test_run_id,
        keyring.activeKid,
        incoming.cleanup_obligation_id,
        incoming.issued_at,
        new Date(grant.exp * 1000),
        providerExpiresAt,
        grant.retention_hours,
        incoming.jti_sha256,
        incoming.nonce_sha256,
        sha256(rawSessionToken),
      ],
    );
    if (insertedGrant.rowCount !== 1) {
      throw new VoiceLabCapabilityError('voice_lab_auth_session_mutation_unconfirmed', 503);
    }
    await client.query('COMMIT');
    return {
      token: rawSessionToken,
      expiresAt,
      idempotentReplay: false,
      expiredLabSessionsRevoked,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeVoiceLabSessions(
  principalId: string,
  grant: VoiceLabCapabilityClaims,
): Promise<number> {
  const pool = getBetterAuthDatabase();
  const client = await pool.connect();
  const marker = markerFor(grant);
  const fingerprints = fingerprintCandidates(marker);
  const principalCandidates = [
    principalId,
    ...tombstonedIdentityCandidates('principal', principalId),
  ];
  const runCandidates = [
    grant.test_run_id,
    ...tombstonedIdentityCandidates('run', grant.test_run_id),
  ];
  const cleanupCandidates = [
    grant.cleanup_obligation_id,
    ...tombstonedIdentityCandidates('cleanup', grant.cleanup_obligation_id),
  ];
  try {
    await client.query('BEGIN');
    await assertVoiceLabAuthLedgerReadyInTransaction(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 731941))',
      [principalId],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 731944))',
      [grant.cleanup_obligation_id],
    );
    const obligationRows = await client.query<{
      state: 'open' | 'closed' | 'complete';
      lifecycle_phase: 'auth_provisional' | 'session_provisional' | 'finalized';
      retention_expires_at: Date;
      provider_expires_at: Date;
    }>(
      'SELECT "state", "lifecycle_phase", "retention_expires_at", "provider_expires_at" '
        + 'FROM public."sophia_voice_lab_cleanup_obligations" '
        + 'WHERE "cleanup_obligation_id" = $1 FOR UPDATE',
      [grant.cleanup_obligation_id],
    );
    const obligation = obligationRows.rows[0];
    const providerExpiresAt = new Date(grant.provider_expires_at);
    const grantRows = await client.query<GrantLedgerRow>(
      'SELECT "grant_fingerprint", "test_run_id", "tombstone_kid", "cleanup_obligation_id", "issued_at", "expires_at", "provider_expires_at", "retention_hours", '
        + '"jti_sha256", "nonce_sha256", "session_token_sha256", "status" '
        + 'FROM public."sophia_voice_lab_auth_grants" '
        + 'WHERE "principal_id" = ANY($1::text[]) '
        + 'OR "grant_fingerprint" = ANY($2::bpchar[]) '
        + 'OR "cleanup_obligation_id" = ANY($3::text[]) FOR UPDATE',
      [
        principalCandidates,
        fingerprints,
        cleanupCandidates,
      ],
    );
    const exactGrantRows = grantRows.rows.filter(
      (row) => fingerprints.includes(row.grant_fingerprint)
        && runCandidates.includes(row.test_run_id)
        && cleanupCandidates.includes(row.cleanup_obligation_id),
    );
    const result = await client.query<SessionRow>(
      'SELECT "token", "expiresAt", "userAgent" FROM public."session" '
        + 'WHERE "userId" = $1 FOR UPDATE',
      [principalId],
    );
    const parsed = result.rows.map((row) => ({ row, marker: parseMarker(row.userAgent) }));
    if (parsed.some(({ marker }) => marker === null)) {
      throw new VoiceLabCapabilityError(
        'voice_lab_dedicated_principal_session_conflict',
        409,
      );
    }
    if (exactGrantRows.length === 0) {
      throw new VoiceLabCapabilityError('voice_lab_auth_run_not_found', 409);
    }
    if (
      grantRows.rows.some(
        (row) => row.status === 'active' && !fingerprints.includes(row.grant_fingerprint),
      )
      || parsed.some(({ marker }) => marker?.principal_id !== principalId
      || marker?.test_run_id !== grant.test_run_id
      || marker?.cleanup_obligation_id !== grant.cleanup_obligation_id)
    ) {
      throw new VoiceLabCapabilityError('voice_lab_auth_active_run_conflict', 409);
    }
    if (parsed.some(({ row, marker }) => (
      marker !== null
      && !exactGrantRows.some((ledger) => markerMatchesLedger(marker, ledger, row.token))
    ))) {
      throw new VoiceLabCapabilityError('voice_lab_auth_ledger_binding_mismatch', 409);
    }
    if (
      obligationRows.rows.length !== 1
      || Number.isNaN(providerExpiresAt.getTime())
      || new Date(obligation.provider_expires_at).getTime() !== providerExpiresAt.getTime()
      || obligation.state === 'complete'
    ) {
      throw new VoiceLabCapabilityError('voice_lab_cleanup_obligation_closed', 409);
    }
    if (obligation.state === 'open') {
      const closed = await client.query(
        'UPDATE public."sophia_voice_lab_cleanup_obligations" '
          + 'SET "state" = \'closed\', "closed_at" = clock_timestamp(), '
          + '"updated_at" = clock_timestamp() '
          + 'WHERE "cleanup_obligation_id" = $1 AND "state" = \'open\' '
          + 'AND "lifecycle_phase" IN (\'auth_provisional\', \'session_provisional\') '
          + 'AND "provider_expires_at" = $2 RETURNING "state"',
        [grant.cleanup_obligation_id, providerExpiresAt],
      );
      if (closed.rowCount !== 1) {
        throw new VoiceLabCapabilityError('voice_lab_cleanup_obligation_closed', 409);
      }
    } else if (obligation.state !== 'closed') {
      throw new VoiceLabCapabilityError('voice_lab_cleanup_obligation_closed', 409);
    }
    for (const row of exactGrantRows.filter((candidate) => candidate.status === 'active')) {
      const revoked = await client.query(
        'UPDATE public."sophia_voice_lab_auth_grants" SET "status" = \'revoked\', '
          + '"revoked_at" = COALESCE("revoked_at", NOW()), '
          + '"principal_id" = $3, "test_run_id" = $4, "cleanup_obligation_id" = $5, '
          + '"jti_sha256" = $6, "nonce_sha256" = $6, "session_token_sha256" = $6 '
          + 'WHERE "principal_id" = $1 AND "grant_fingerprint" = $2 '
          + 'AND "tombstone_kid" = $7 AND "status" = \'active\'',
        [
          principalId,
          row.grant_fingerprint,
          tombstonedIdentity('principal', principalId, row.tombstone_kid),
          tombstonedIdentity('run', grant.test_run_id, row.tombstone_kid),
          tombstonedIdentity('cleanup', grant.cleanup_obligation_id, row.tombstone_kid),
          REDACTED_SHA256,
          row.tombstone_kid,
        ],
      );
      if ((revoked.rowCount || 0) !== 1) {
        throw new VoiceLabCapabilityError('voice_lab_auth_ledger_binding_mismatch', 409);
      }
    }
    let deletedCount = 0;
    for (const { row } of parsed) {
      const deleted = await client.query(
        'DELETE FROM public."session" WHERE "userId" = $1 AND "token" = $2',
        [principalId, row.token],
      );
      if (deleted.rowCount !== 1) {
        throw new VoiceLabCapabilityError(
          'voice_lab_auth_session_mutation_unconfirmed',
          503,
        );
      }
      deletedCount += 1;
    }
    await client.query(
      'DELETE FROM public."sophia_voice_lab_auth_grants" '
        + 'WHERE "status" = \'revoked\' AND "expires_at" <= NOW()',
    );
    await client.query('COMMIT');
    return deletedCount;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
