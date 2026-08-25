import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { resolveDatabaseTls } from '../src/server/better-auth/database-tls.mjs';
import { transactionBody } from './voice-lab-migration-contract.mjs';

const EXPECTED_MIGRATION_SHA256 = '42e6f2b3bf083675bcdd7b2f29c66b400c6fca9771b76f866e6c55f8513b514c';
const EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256 = '191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44';
const RECOGNIZED_PRIOR_MIGRATION_SHA256 =
  '42e6f2b3bf083675bcdd7b2f29c66b400c6fca9771b76f866e6c55f8513b514c';
const RECOGNIZED_PRIOR_CLEANUP_INDEX_MIGRATION_SHA256 =
  '45983a3244852f3d8edadcdff2201c691f1721d3943181de0626307c9e90cdd4';
const AUTH_HASH_PLACEHOLDER = '__SOPHIA_VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256__';
const CLEANUP_HASH_PLACEHOLDER = '__SOPHIA_VOICE_LAB_CLEANUP_INDEX_MIGRATION_SHA256__';
const TABLE = 'sophia_voice_lab_auth_grants';
const EXPECTED_DATABASE_OWNER_ROLE = 'postgres';
const EXPECTED_RUNTIME_DATABASE_ROLE = 'better_auth_app';
const ROLE_MEMBERSHIP_CONTRACT_VERSION =
  'supabase_pg17.directional_membership.v1';

function roleMembershipAttestationSql() {
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
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const AUTH_MIGRATION_PATH = resolve(
  scriptRoot,
  '../../backend/migrations/2026_08_23_voice_lab_auth_grant_ledger.sql',
);
const CLEANUP_MIGRATION_PATH = resolve(
  scriptRoot,
  '../../backend/migrations/2026_08_23_voice_lab_cleanup_obligation_indexes.sql',
);
const EXPECTED_TABLE_COMMENT =
  `sophia.voice-lab.auth-ledger.v1 migration_sha256=${EXPECTED_MIGRATION_SHA256}`;
const EXPECTED_COLUMNS = new Map([
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
const EXPECTED_COLUMN_DEFAULTS = new Map([
  ['created_at', 'now()'],
]);
const EXPECTED_INDEXES = new Map([
  ['sophia_voice_lab_auth_grants_pkey', { table: TABLE, unique: true, expressions: ['grant_fingerprint'], options: [0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_principal_order_idx', { table: TABLE, unique: false, expressions: ['principal_id', 'issued_at'], options: [0, 3], predicate: '' }],
  ['sophia_voice_lab_auth_grants_expiry_idx', { table: TABLE, unique: false, expressions: ['expires_at'], options: [0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_cleanup_obligation_idx', { table: TABLE, unique: false, expressions: ['cleanup_obligation_id'], options: [0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_tombstone_kid_expiry_idx', { table: TABLE, unique: false, expressions: ['tombstone_kid', 'expires_at'], options: [0, 0], predicate: '' }],
  ['sophia_voice_lab_auth_grants_active_cleanup_idx', { table: TABLE, unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: "status='active'" }],
]);
const EXPECTED_AUTH_CONSTRAINTS = new Map([
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
const CLEANUP_INDEX_CONTRACTS = new Map([
  ['sophia_sessions_voice_lab_cleanup_obligation_idx', {
    table: 'sophia_sessions',
    unique: true,
    keyCount: 1,
    expressions: ["metadata->'synthetic_voice_lab'->>'cleanup_obligation_id'"],
    options: [0],
    predicate: "metadata->'synthetic_voice_lab'->>'synthetic'='true'andmetadata->'synthetic_voice_lab'->>'cleanup_obligation_id'isnotnull",
    comment: `sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} resource=sessions`,
  }],
  ['artifact_registry_voice_lab_cleanup_obligation_idx', {
    table: 'artifact_registry_records',
    unique: false,
    keyCount: 2,
    expressions: ["record_payload->>'cleanup_obligation_id'", 'artifact_id'],
    options: [0, 0],
    predicate: "record_payload->>'synthetic_test'='true'andrecord_payload->>'cleanup_obligation_id'isnotnull",
    comment: `sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} resource=artifacts`,
  }],
]);
const CLEANUP_TRIGGER_CONTRACTS = new Map([
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
const REQUIRED_PRODUCT_COLUMNS = new Map([
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
]);
const PRODUCT_TABLES = [...REQUIRED_PRODUCT_COLUMNS.keys()];
const RUNTIME_PRODUCT_TABLE_PRIVILEGES = new Map([
  ['sophia_sessions', {
    select: true, insert: false, update: true, delete: false,
  }],
  ['sophia_session_messages', {
    select: false, insert: false, update: false, delete: false,
  }],
  ['artifact_registry_records', {
    select: false, insert: false, update: false, delete: false,
  }],
]);
const SESSION_MESSAGES_FK = {
  definition: 'FOREIGN KEY (session_id) REFERENCES sophia_sessions(id) ON DELETE CASCADE',
  triggers: new Set([
    'sophia_session_messages.RI_FKey_check_ins',
    'sophia_session_messages.RI_FKey_check_upd',
    'sophia_sessions.RI_FKey_cascade_del',
    'sophia_sessions.RI_FKey_noaction_upd',
  ]),
};
const CLEANUP_ADMISSIONS_FK = {
  triggers: new Set([
    'sophia_voice_lab_cleanup_admissions.RI_FKey_check_ins',
    'sophia_voice_lab_cleanup_admissions.RI_FKey_check_upd',
    'sophia_voice_lab_cleanup_obligations.RI_FKey_noaction_del',
    'sophia_voice_lab_cleanup_obligations.RI_FKey_noaction_upd',
  ]),
};
const PRODUCT_PRIMARY_KEYS = new Map([
  ['sophia_sessions.sophia_sessions_pkey', 'PRIMARY KEY (id)'],
  ['sophia_session_messages.sophia_session_messages_pkey', 'PRIMARY KEY (id)'],
  ['artifact_registry_records.artifact_registry_records_pkey', 'PRIMARY KEY (artifact_id)'],
]);
const BETTER_AUTH_SESSION_COLUMNS = new Map([
  ['id', ['text', 'NO']],
  ['expiresAt', ['timestamptz', 'NO']],
  ['token', ['text', 'NO']],
  ['createdAt', ['timestamptz', 'NO']],
  ['updatedAt', ['timestamptz', 'NO']],
  ['ipAddress', ['text', 'YES']],
  ['userAgent', ['text', 'YES']],
  ['userId', ['text', 'NO']],
]);
const BETTER_AUTH_SESSION_INDEXES = new Map([
  ['session_pkey', { unique: true, expressions: ['id'], options: [0] }],
  ['session_token_key', { unique: true, expressions: ['token'], options: [0] }],
  ['session_userId_idx', { unique: false, expressions: ['"userid"'], options: [0] }],
]);
const BETTER_AUTH_SESSION_KEY_CONSTRAINTS = new Map([
  ['session_pkey', ['p', 'PRIMARY KEY (id)']],
  ['session_token_key', ['u', 'UNIQUE (token)']],
]);
const CLEANUP_CONTROL_COLUMNS = new Map([
  ['sophia_voice_lab_cleanup_obligations', new Map([
    ['cleanup_obligation_id', ['text', 'NO']],
    ['state', ['text', 'NO']],
    ['lifecycle_phase', ['text', 'NO']],
    ['retention_expires_at', ['timestamptz', 'NO']],
    ['provider_expires_at', ['timestamptz', 'NO']],
    ['provider_settlement_sha256', ['text', 'YES']],
    ['created_at', ['timestamptz', 'NO']],
    ['updated_at', ['timestamptz', 'NO']],
    ['closed_at', ['timestamptz', 'YES']],
    ['live_cleanup_completed_at', ['timestamptz', 'YES']],
    ['completed_at', ['timestamptz', 'YES']],
    ['purge_after', ['timestamptz', 'YES']],
  ])],
  ['sophia_voice_lab_cleanup_admissions', new Map([
    ['admission_id', ['uuid', 'NO']],
    ['cleanup_obligation_id', ['text', 'NO']],
    ['resource_kind', ['text', 'NO']],
    ['resource_id', ['text', 'NO']],
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
]);
const RUNTIME_CLEANUP_CONTROL_PRIVILEGES = new Map([
  ['sophia_voice_lab_cleanup_obligations', {
    select: true, insert: true, update: true, delete: true,
  }],
  ['sophia_voice_lab_cleanup_admissions', {
    select: true, insert: true, update: true, delete: true,
  }],
  ['sophia_voice_lab_cleanup_scan_cursors', {
    select: true, insert: false, update: true, delete: false,
  }],
]);
const CLEANUP_CONTROL_DEFAULTS = new Map([
  ['sophia_voice_lab_cleanup_obligations.state', "'open'"],
  ['sophia_voice_lab_cleanup_obligations.lifecycle_phase', "'auth_provisional'"],
  ['sophia_voice_lab_cleanup_obligations.created_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_obligations.updated_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_admissions.status', "'reserved'"],
  ['sophia_voice_lab_cleanup_admissions.created_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_admissions.updated_at', 'clock_timestamp()'],
  ['sophia_voice_lab_cleanup_scan_cursors.updated_at', 'clock_timestamp()'],
]);
const CLEANUP_CONTROL_INDEXES = new Map([
  ['sophia_voice_lab_cleanup_obligations_pkey', { table: 'sophia_voice_lab_cleanup_obligations', unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: '' }],
  ['sophia_voice_lab_cleanup_obligations_purge_idx', { table: 'sophia_voice_lab_cleanup_obligations', unique: false, expressions: ['purge_after', 'cleanup_obligation_id'], options: [0, 0], predicate: "state='complete'" }],
  ['sophia_voice_lab_cleanup_admissions_pkey', { table: 'sophia_voice_lab_cleanup_admissions', unique: true, expressions: ['admission_id'], options: [0], predicate: '' }],
  ['sophia_voice_lab_cleanup_admissions_obligation_idx', { table: 'sophia_voice_lab_cleanup_admissions', unique: false, expressions: ['cleanup_obligation_id', 'lease_expires_at', 'admission_id'], options: [0, 0, 0], predicate: '' }],
  ['sophia_voice_lab_cleanup_admissions_expiry_idx', { table: 'sophia_voice_lab_cleanup_admissions', unique: false, expressions: ['lease_expires_at', 'cleanup_obligation_id', 'admission_id'], options: [0, 0, 0], predicate: '' }],
  ['sophia_voice_lab_cleanup_admissions_single_provider_idx', { table: 'sophia_voice_lab_cleanup_admissions', unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: "resource_kind='provider'" }],
  ['sophia_voice_lab_cleanup_obligations_work_idx', { table: 'sophia_voice_lab_cleanup_obligations', unique: false, expressions: ["casewhenstate='closed'andlive_cleanup_completed_atisnullthenclosed_atwhenstate='closed'thenretention_expires_atelseprovider_expires_atend", 'cleanup_obligation_id'], options: [0, 0], predicate: "state<>'complete'" }],
  ['sophia_voice_lab_cleanup_scan_cursors_pkey', { table: 'sophia_voice_lab_cleanup_scan_cursors', unique: true, expressions: ['cursor_name'], options: [0], predicate: '' }],
]);
const CLEANUP_CONTROL_CONSTRAINTS = new Map([
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
const D02_DATABASE_ROLE = 'sophia_voice_lab_gateway';
const D02_FINALIZE_KEY_ID_ENV =
  'SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID';
const D02_FINALIZE_SECRET_ENV =
  'SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET';
let expectedD02FinalizeAuthority = null;
const D02_COLUMNS = new Map([
  ['sophia_voice_lab_d02_gateway_finalize_authority', new Map([
    ['singleton', ['bool', 'NO', null, 'true']],
    ['authority_key_id', ['text', 'NO', null, '']],
    ['authority_secret', ['text', 'NO', null, '']],
    ['installed_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
  ['sophia_voice_lab_d02_gateway_capability_uses', new Map([
    ['capability_jti_sha256', ['bpchar', 'NO', 64, '']], ['operation', ['text', 'NO', null, '']],
    ['request_sha256', ['bpchar', 'NO', 64, '']], ['cleanup_obligation_id', ['text', 'NO', null, '']],
    ['termination_request_id_sha256', ['bpchar', 'NO', 64, '']], ['used_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
  ['sophia_voice_lab_d02_gateway_relay_leases', new Map([
    ['relay_id', ['uuid', 'NO', null, '']], ['cleanup_obligation_id', ['text', 'NO', null, '']],
    ['provider_session_id', ['text', 'NO', null, '']], ['provider_connection_epoch', ['int4', 'NO', null, '']],
    ['relay_kind', ['text', 'NO', null, '']], ['owner_instance_id_sha256', ['bpchar', 'NO', 64, '']],
    ['expires_at', ['timestamptz', 'NO', null, '']], ['created_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
  ['sophia_voice_lab_d02_gateway_settlements', new Map([
    ['cleanup_obligation_id', ['text', 'NO', null, '']], ['termination_request_id_sha256', ['bpchar', 'NO', 64, '']],
    ['provider_session_id', ['text', 'NO', null, '']], ['provider_admission_id', ['uuid', 'NO', null, '']],
    ['freeze_request_sha256', ['bpchar', 'NO', 64, '']], ['freeze_capability_jti_sha256', ['bpchar', 'NO', 64, '']],
    ['freeze_binding', ['jsonb', 'NO', null, '']], ['frozen_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
    ['voice_terminal_receipt_sha256', ['bpchar', 'YES', 64, '']], ['voice_terminal_receipt', ['jsonb', 'YES', null, '']],
    ['voice_terminal_at', ['timestamptz', 'YES', null, '']], ['settlement_request_sha256', ['bpchar', 'YES', 64, '']],
    ['settlement_capability_jti_sha256', ['bpchar', 'YES', 64, '']], ['provider_settlement_sha256', ['bpchar', 'YES', 64, '']],
    ['receipt_sha256', ['bpchar', 'YES', 64, '']], ['receipt', ['jsonb', 'YES', null, '']],
    ['settled_at', ['timestamptz', 'YES', null, '']],
  ])],
  ['sophia_voice_lab_d02_product_continuity_observations', new Map([
    ['cleanup_obligation_id', ['text', 'NO', null, '']], ['restart_request_id_sha256', ['bpchar', 'NO', 64, '']],
    ['phase', ['text', 'NO', null, '']], ['request_sha256', ['bpchar', 'NO', 64, '']],
    ['capability_jti_sha256', ['bpchar', 'NO', 64, '']], ['product_service_boot_id_sha256', ['bpchar', 'NO', 64, '']],
    ['render_action_request_sha256', ['bpchar', 'NO', 64, '']], ['prior_observation_receipt_sha256', ['bpchar', 'YES', 64, '']],
    ['receipt_sha256', ['bpchar', 'NO', 64, '']], ['receipt', ['jsonb', 'NO', null, '']],
    ['observed_at', ['timestamptz', 'NO', null, 'clock_timestamp()']],
  ])],
]);
const D02_CONSTRAINTS = new Map([
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
]);
const D02_INDEXES = new Map([
  ['sophia_voice_lab_d02_gateway_capability_uses_pkey', { table: 'sophia_voice_lab_d02_gateway_capability_uses', unique: true, expressions: ['capability_jti_sha256'], options: [0], predicate: '', opclasses: ['bpchar_ops'], collations: ['default'] }],
  ['sophia_voice_lab_d02_gateway_finalize_authority_pkey', { table: 'sophia_voice_lab_d02_gateway_finalize_authority', unique: true, expressions: ['singleton'], options: [0], predicate: '', opclasses: ['bool_ops'], collations: [''] }],
  ['sophia_voice_lab_d02_gateway_relay_expiry_idx', { table: 'sophia_voice_lab_d02_gateway_relay_leases', unique: false, expressions: ['cleanup_obligation_id', 'expires_at', 'owner_instance_id_sha256', 'relay_id'], options: [0, 0, 0, 0], predicate: '', opclasses: ['text_ops', 'timestamptz_ops', 'bpchar_ops', 'uuid_ops'], collations: ['default', '', 'default', ''] }],
  ['sophia_voice_lab_d02_gateway_relay_leases_pkey', { table: 'sophia_voice_lab_d02_gateway_relay_leases', unique: true, expressions: ['relay_id'], options: [0], predicate: '', opclasses: ['uuid_ops'], collations: [''] }],
  ['sophia_voice_lab_d02_gateway_settlements_freeze_jti_idx', { table: 'sophia_voice_lab_d02_gateway_settlements', unique: true, expressions: ['freeze_capability_jti_sha256'], options: [0], predicate: '', opclasses: ['bpchar_ops'], collations: ['default'] }],
  ['sophia_voice_lab_d02_gateway_settlements_pkey', { table: 'sophia_voice_lab_d02_gateway_settlements', unique: true, expressions: ['cleanup_obligation_id', 'termination_request_id_sha256'], options: [0, 0], predicate: '', opclasses: ['text_ops', 'bpchar_ops'], collations: ['default', 'default'] }],
  ['sophia_voice_lab_d02_gateway_settlements_settlement_jti_idx', { table: 'sophia_voice_lab_d02_gateway_settlements', unique: true, expressions: ['settlement_capability_jti_sha256'], options: [0], predicate: 'settlement_capability_jti_sha256isnotnull', opclasses: ['bpchar_ops'], collations: ['default'] }],
  ['sophia_voice_lab_d02_product_continuity_observations_pkey', { table: 'sophia_voice_lab_d02_product_continuity_observations', unique: true, expressions: ['cleanup_obligation_id', 'restart_request_id_sha256', 'phase'], options: [0, 0, 0], predicate: '', opclasses: ['text_ops', 'bpchar_ops', 'text_ops'], collations: ['default', 'default', 'default'] }],
  ['sophia_voice_lab_d02_product_continuity_one_restart_idx', { table: 'sophia_voice_lab_d02_product_continuity_observations', unique: true, expressions: ['cleanup_obligation_id'], options: [0], predicate: "phase='before_api_restart'", opclasses: ['text_ops'], collations: ['default'] }],
]);
const D02_COMMENTS = new Map([
  ['sophia_voice_lab_d02_gateway_settlements', `sophia.voice-lab.d02-gateway-settlement.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=bounded-authority-receipt-no-raw-principal`],
  ['sophia_voice_lab_d02_gateway_capability_uses', `sophia.voice-lab.d02-gateway-capability-use.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-replay-binding-only`],
  ['sophia_voice_lab_d02_gateway_relay_leases', `sophia.voice-lab.d02-gateway-relay-lease.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-live-relay-authority-only`],
  ['sophia_voice_lab_d02_product_continuity_observations', `sophia.voice-lab.d02-product-continuity-observation.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=hashed-product-projection-signed-receipt-only`],
  ['sophia_voice_lab_d02_gateway_finalize_authority', `sophia.voice-lab.d02-database-finalize-authority.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=owner-only-key-material-never-runtime-readable`],
]);
const D02_GATEWAY_PRIVILEGES = new Map(
  [...D02_COLUMNS.keys()].map((table) => [table, new Set()]),
);
const D02_GATEWAY_EFFECTIVE_PRIVILEGES = new Map([
  ['session', new Set()],
  ['sophia_sessions', new Set()],
  ['sophia_session_messages', new Set()],
  ['artifact_registry_records', new Set()],
  [TABLE, new Set()],
  ['sophia_voice_lab_cleanup_obligations', new Set()],
  ['sophia_voice_lab_cleanup_admissions', new Set()],
  ['sophia_voice_lab_cleanup_scan_cursors', new Set()],
  ...D02_GATEWAY_PRIVILEGES,
]);
const CLEANUP_FUNCTION_CONTRACTS = new Map([
  ['sophia_voice_lab_receipt_part', {
    sourceSha256: '6185006f17eaf4c24c241968d2c9f94baeea014088c20832c22c61c06853c4bd',
    args: 'p_value text', language: 'sql', volatility: 'i', securityDefiner: false,
    result: 'text', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 's',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
  }],
  ['sophia_voice_lab_finalization_receipt_sha256', {
    sourceSha256: '92b94e6c4c49d47968d179e81375b5825119d6ebd10e084214a99f4df47867ec',
    args: 'p_user_id text, p_session_id text, p_thread_id text, p_synthetic jsonb, p_expected_deployment jsonb, p_finalized_at text, p_retention_hours integer, p_retention_expires_at text, p_provider_expires_at text, p_message_revision bigint, p_message_count integer, p_transcript_sha256 text, p_started_at text, p_turn_count integer, p_capability_jti_sha256 text, p_object_path text',
    language: 'sql', volatility: 'i', securityDefiner: false,
    result: 'text', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 's',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
  }],
  ['sophia_finalize_voice_lab_session', {
    sourceSha256: '6c74d0646932e6cc32809f6d0c432f0b231dd9d89c7336fb92d8f6ff67c622c3',
    args: 'p_user_id text, p_session_id text, p_expected_revision bigint, p_cleanup_obligation_id text, p_provider_expires_at text, p_retention_hours integer, p_expected_synthetic_binding jsonb, p_expected_deployment jsonb, p_message_metadata_base jsonb, p_canonical_transcript_sha256 text, p_canonical_transcript_json text, p_finalization_started_at text, p_turn_count integer, p_capability_jti_sha256 text, p_messages jsonb',
    language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'jsonb', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: true,
  }],
  ['sophia_purge_voice_lab_session', {
    sourceSha256: '1e001f8ff64cd06ec9cd2e78d509c1d290469ce7816b57ce6695b071ea48f3c3',
    args: 'p_user_id text, p_session_id text, p_cleanup_obligation_id text, p_retention_expires_at text, p_provider_expires_at text',
    language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'boolean', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: true,
  }],
  ['sophia_voice_lab_cleanup_write_fence', {
    sourceSha256: '4faacbb98b20ee4e955ae8343e55c163060f9963104c384dadb1263249d28fad',
    args: '', language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'trigger', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
  }],
  ['sophia_voice_lab_message_write_fence', {
    sourceSha256: '11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3',
    args: '', language: 'plpgsql', volatility: 'v', securityDefiner: true,
    result: 'trigger', kind: 'f', returnsSet: false, strict: false,
    leakproof: false, parallel: 'u',
    config: ['search_path=pg_catalog, public, pg_temp'], serviceExecute: false,
  }],
]);

function d02FunctionContract({
  sourceSha256,
  args,
  result,
  language = 'plpgsql',
  volatility = 'v',
  securityDefiner = true,
  strict = false,
  parallel = 'u',
  gatewayExecute,
  runtimeExecute = false,
  operation,
  exposure,
}) {
  return {
    sourceSha256,
    args,
    language,
    volatility,
    securityDefiner,
    result,
    kind: 'f',
    returnsSet: false,
    strict,
    leakproof: false,
    parallel,
    config: ['search_path=pg_catalog, public, pg_temp'],
    serviceExecute: false,
    gatewayExecute,
    runtimeExecute,
    comment:
      `sophia.voice-lab.d02-database-rpc.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} `
      + `operation=${operation} exposure=${exposure}`,
  };
}

const D02_FUNCTION_CONTRACTS = new Map([
  ['sophia_voice_lab_d02_browser_settlement', d02FunctionContract({
    sourceSha256: 'f3e3bc3c27e9d5e28f3e206ebd2230b419463ca117acc024356cec64149b5ffa',
    args: 'p_metadata jsonb, p_provider_session_id text', result: 'jsonb',
    volatility: 's', securityDefiner: false, strict: true, parallel: 's',
    gatewayExecute: false, operation: 'browser-settlement', exposure: 'owner-internal',
  })],
  ['sophia_voice_lab_d02_canonical_json', d02FunctionContract({
    sourceSha256: '070913f32577512228d6e87368a7291c378532bb03c181ff4e2fca7f2780cb06',
    args: 'p_value jsonb', result: 'text', volatility: 'i',
    securityDefiner: false, strict: true, parallel: 's', gatewayExecute: false,
    operation: 'canonical-json', exposure: 'owner-internal',
  })],
  ['sophia_voice_lab_d02_continuity_authorize', d02FunctionContract({
    sourceSha256: '14b4fc34cf9bf60c66e307c32e8943c1e421197a0633a4486fbf4392901acc56',
    args: 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_observed_at timestamp with time zone',
    result: 'jsonb', gatewayExecute: true, operation: 'continuity-authorize',
    exposure: 'gateway-execute',
  })],
  ['sophia_voice_lab_d02_continuity_finalize', d02FunctionContract({
    sourceSha256: '591c5cf7b4fd1af27a0acc9780e1cb95c99209d22c3910b03a0dd4f59881c8f8',
    args: 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_product_service_boot_id_sha256 text, p_render_action_request_sha256 text, p_prior_observation_receipt_sha256 text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text',
    result: 'jsonb', gatewayExecute: true, operation: 'continuity-finalize',
    exposure: 'gateway-execute-hmac',
  })],
  ['sophia_voice_lab_d02_finalize_authority_ready', d02FunctionContract({
    sourceSha256: 'ce3cfd8a1859c1e703927a3cc907628e6e147563029513354ae9e9ea932c5bf4',
    args: 'p_authority_key_id text, p_authority_secret_sha256 text',
    result: 'boolean', language: 'sql', volatility: 's', strict: true,
    parallel: 's', gatewayExecute: true, operation: 'authority-ready',
    exposure: 'gateway-readback',
  })],
  ['sophia_voice_lab_d02_finalize_proof_valid', d02FunctionContract({
    sourceSha256: 'fd637099a2e026380dd1b4017b8a341811fb9cf6bc58c4ee41c077e8472f9c97',
    args: 'p_authority_key_id text, p_domain text, p_parts jsonb, p_value jsonb, p_proof_sha256 text',
    result: 'boolean', volatility: 's', strict: true, parallel: 'r',
    gatewayExecute: false, operation: 'finalize-proof-valid', exposure: 'owner-internal',
  })],
  ['sophia_voice_lab_d02_freeze_authorize', d02FunctionContract({
    sourceSha256: '60d23be11556efb20fb0290c05be5987808ea978ed82a8b3b4bb9f46c175c020',
    args: 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text',
    result: 'jsonb', gatewayExecute: true, operation: 'freeze-authorize',
    exposure: 'gateway-execute',
  })],
  ['sophia_voice_lab_d02_freeze_finalize', d02FunctionContract({
    sourceSha256: 'de3f91905416587285ee54f0f15a8fee7e99bece48999001e7ec9690539e5d4d',
    args: 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_freeze_binding jsonb, p_authority_key_id text, p_finalize_proof_sha256 text',
    result: 'jsonb', gatewayExecute: true, operation: 'freeze-finalize',
    exposure: 'gateway-execute-hmac',
  })],
  ['sophia_voice_lab_d02_hmac_sha256', d02FunctionContract({
    sourceSha256: '03b16bf3f6ce33e09cbb9445f6afe8c343caeaf3fae11cfa526fa7ac641fd3c9',
    args: 'p_key bytea, p_data bytea', result: 'bytea', volatility: 'i',
    securityDefiner: false, strict: true, parallel: 's', gatewayExecute: false,
    operation: 'hmac-sha256', exposure: 'owner-internal',
  })],
  ['sophia_voice_lab_d02_producer_open', d02FunctionContract({
    sourceSha256: '4db750471171dba20a1c71e3a6f73505efca17c93226820129b91c59f183e8a3',
    args: 'p_cleanup_obligation_id text', result: 'boolean', gatewayExecute: true,
    operation: 'producer-open', exposure: 'gateway-readback',
  })],
  ['sophia_voice_lab_d02_provider_freeze', d02FunctionContract({
    sourceSha256: 'da2c68d664005bc5b630599d6297a3a233a61763975c63344986b6e1c628ac9c',
    args: 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text',
    result: 'jsonb', volatility: 's', gatewayExecute: true,
    operation: 'provider-freeze', exposure: 'gateway-readback',
  })],
  ['sophia_voice_lab_d02_register_capability_use', d02FunctionContract({
    sourceSha256: 'b964d9481272417056bf53ed7f8864a67071bc0567f627477a4b73f4e6fd4b80',
    args: 'p_capability_jti_sha256 text, p_operation text, p_request_sha256 text, p_cleanup_obligation_id text, p_request_id_sha256 text',
    result: 'boolean', language: 'sql', securityDefiner: false,
    gatewayExecute: false, operation: 'capability-use', exposure: 'owner-internal',
  })],
  ['sophia_voice_lab_d02_register_capability_use_state', d02FunctionContract({
    sourceSha256: '810a45a17e5a3b934a6ef0b7cddb36ffe46ea83da6725d2f2839748b5253255c',
    args: 'p_capability_jti_sha256 text, p_operation text, p_request_sha256 text, p_cleanup_obligation_id text, p_request_id_sha256 text',
    result: 'text', securityDefiner: false, gatewayExecute: false,
    operation: 'capability-state', exposure: 'owner-internal',
  })],
  ['sophia_voice_lab_d02_relay_begin', d02FunctionContract({
    sourceSha256: '7d5677b2c65e11531338bcc4af05672ad9fc3787986d0fa4365a7652029c3b6e',
    args: 'p_relay_id uuid, p_cleanup_obligation_id text, p_provider_session_id text, p_provider_connection_epoch integer, p_relay_kind text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_authority_key_id text, p_operation_proof_sha256 text',
    result: 'boolean', gatewayExecute: true, operation: 'relay-begin',
    exposure: 'gateway-execute-hmac',
  })],
  ['sophia_voice_lab_d02_relay_end', d02FunctionContract({
    sourceSha256: 'bf089f4e5e55667b9b7902ad5ec4afe5e7c27ceacf0fe9a9ee3ec8accb3f9774',
    args: 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text',
    result: 'boolean', gatewayExecute: true, operation: 'relay-end',
    exposure: 'gateway-execute-hmac',
  })],
  ['sophia_voice_lab_d02_relay_refresh', d02FunctionContract({
    sourceSha256: '8d6a271cc20516fd476ee56adad82e18094e4fdb4cb0aba467e1eeb83a3a1e0c',
    args: 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text',
    result: 'boolean', gatewayExecute: true, operation: 'relay-refresh',
    exposure: 'gateway-execute-hmac',
  })],
  ['sophia_voice_lab_d02_settlement_authorize', d02FunctionContract({
    sourceSha256: '06980b6cd70094490d5461c00a22b738f83c5c6cd4b9ba0b6a56cc9d33ff84f9',
    args: 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text',
    result: 'jsonb', gatewayExecute: true, operation: 'settlement-authorize',
    exposure: 'gateway-execute',
  })],
  ['sophia_voice_lab_d02_settlement_finalize', d02FunctionContract({
    sourceSha256: 'a96754002d924205727f17629fba51c3633b4543954a7e827c724467b88a0096',
    args: 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_provider_settlement_sha256 text, p_next_metadata jsonb, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text',
    result: 'jsonb', gatewayExecute: true, operation: 'settlement-finalize',
    exposure: 'gateway-execute-hmac',
  })],
  ['sophia_voice_lab_d02_sources_zero', d02FunctionContract({
    sourceSha256: '8c8dd393f5a61e9e0a3b165904b417065a877fd1f5b7485d2a7d8b064e669ccb',
    args: 'p_cleanup_obligation_id text', result: 'boolean', language: 'sql',
    volatility: 's', gatewayExecute: true, runtimeExecute: true,
    operation: 'sources-zero',
    exposure: 'gateway-runtime-readback',
  })],
  ['sophia_voice_lab_d02_voice_terminal_authorize', d02FunctionContract({
    sourceSha256: '9c094510a8ff27a0fd36ef94922b56746249d72284c5441e61787d5a76c278aa',
    args: 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text',
    result: 'jsonb', gatewayExecute: true, operation: 'voice-terminal-authorize',
    exposure: 'gateway-execute',
  })],
  ['sophia_voice_lab_d02_voice_terminal_finalize', d02FunctionContract({
    sourceSha256: 'e62bc88c1142478da159500d241ce22e89d8cbbfbcbeb074556228de4d844d80',
    args: 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text',
    result: 'jsonb', gatewayExecute: true, operation: 'voice-terminal-finalize',
    exposure: 'gateway-execute-hmac',
  })],
]);
const GOVERNED_FUNCTION_CONTRACTS = new Map([
  ...CLEANUP_FUNCTION_CONTRACTS,
  ...D02_FUNCTION_CONTRACTS,
]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadD02FinalizeAuthority() {
  const keyIdRaw = process.env[D02_FINALIZE_KEY_ID_ENV];
  const secret = process.env[D02_FINALIZE_SECRET_ENV];
  const keyId = keyIdRaw?.trim();
  if (
    !keyId
    || keyIdRaw !== keyId
    || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)
  ) {
    throw new Error(`Invalid required environment variable: ${D02_FINALIZE_KEY_ID_ENV}`);
  }
  if (
    typeof secret !== 'string'
    || secret.length < 32
    || secret.length > 256
    || !/^[\x20-\x7e]+$/.test(secret)
    || Buffer.byteLength(secret, 'utf8') !== secret.length
  ) {
    throw new Error(`Invalid required environment variable: ${D02_FINALIZE_SECRET_ENV}`);
  }
  return {
    keyId,
    secret,
    secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
  };
}

function projectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const direct = parsed.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/)?.[1];
  if (direct) return direct;
  if (parsed.hostname.toLowerCase().includes('.pooler.supabase.')) {
    return decodeURIComponent(parsed.username).split('.').at(-1)?.toLowerCase() ?? null;
  }
  return null;
}

function databaseIdentity(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const ref = projectRef(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (ref) return `supabase:${ref}:${database}`;
  const protocol = parsed.protocol === 'postgresql:' ? 'postgres:' : parsed.protocol;
  return `${protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${database}`;
}

function approvedDedicatedTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  return process.env.NODE_ENV === 'test'
    && process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED === 'YES'
    && database === 'voice_lab_test';
}

async function loadPinnedMigration(
  path,
  expectedHash,
  placeholder,
  label,
  expectedOccurrences = 1,
) {
  const template = await readFile(path, 'utf8');
  const actual = createHash('sha256').update(template, 'utf8').digest('hex');
  if (actual !== expectedHash) {
    throw new Error(`${label} migration hash mismatch; refusing database access.`);
  }
  if (template.split(placeholder).length !== expectedOccurrences + 1) {
    throw new Error(`${label} migration metadata placeholder is not exact.`);
  }
  return template.replaceAll(placeholder, expectedHash);
}

function normalizeExpression(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/::text/g, '')
    .replace(/[()\s]/g, '');
}

function normalizeDefault(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/::(?:text|character varying)/g, '')
    .replace(/\s/g, '');
}

function normalizeConstraint(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function assertD02Catalog(
  client,
  { allowFinalizeAuthorityValueMismatch = false } = {},
) {
  const tableNames = [...D02_COLUMNS.keys()];
  const columns = await client.query(
    `SELECT /* voice_lab_d02_columns */ relation.relname AS table_name,
            attribute.attname AS column_name, type.typname AS udt_name,
            CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
            pg_get_expr(default_value.adbin, default_value.adrelid, true)
              AS column_default,
            CASE
              WHEN type.typname IN ('bpchar', 'varchar') AND attribute.atttypmod >= 4
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
    [tableNames],
  );
  const expectedColumnCount = [...D02_COLUMNS.values()].reduce(
    (count, expectedColumns) => count + expectedColumns.size,
    0,
  );
  if (
    columns.rows.length !== expectedColumnCount
    || [...D02_COLUMNS].some(([table, expectedColumns]) => {
      const actualColumns = columns.rows.filter((row) => row.table_name === table);
      return actualColumns.length !== expectedColumns.size
        || actualColumns.some((row) => {
          const expected = expectedColumns.get(row.column_name);
          return !expected
            || row.udt_name !== expected[0]
            || row.is_nullable !== expected[1]
            || (expected[2] === null
              ? row.character_maximum_length !== null
              : Number(row.character_maximum_length) !== expected[2])
            || normalizeDefault(row.column_default) !== normalizeDefault(expected[3])
            || row.is_generated !== 'NEVER'
            || row.is_identity !== 'NO';
        });
    })
  ) throw new Error('Voice Lab D02 column catalog drifted.');

  const relations = await client.query(
    `SELECT /* voice_lab_d02_relations */ relation.relname AS table_name,
            pg_get_userbyid(relation.relowner) AS owner_name,
            relation.relkind, relation.relpersistence, relation.relispartition,
            relation.relrowsecurity, relation.relforcerowsecurity,
            NOT EXISTS (
              SELECT 1 FROM pg_inherits inheritance
               WHERE inheritance.inhparent = relation.oid
                  OR inheritance.inhrelid = relation.oid
            ) AS inheritance_free,
            NOT EXISTS (
              SELECT 1 FROM pg_rewrite rewrite WHERE rewrite.ev_class = relation.oid
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
  );
  const relationMap = new Map(relations.rows.map((row) => [row.table_name, row]));
  if (
    relations.rows.length !== D02_COLUMNS.size
    || relationMap.size !== D02_COLUMNS.size
    || tableNames.some((table) => {
      const row = relationMap.get(table);
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
        || row.table_comment !== D02_COMMENTS.get(table);
    })
  ) throw new Error('Voice Lab D02 relation catalog drifted.');

  const acl = await client.query(
    `SELECT /* voice_lab_d02_direct_acl */ relation.relname AS table_name,
            grantee_role.rolname AS grantee_name,
            item.privilege_type, item.is_grantable
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) item
       LEFT JOIN pg_roles grantee_role ON grantee_role.oid = item.grantee
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND item.grantee <> relation.relowner
      ORDER BY relation.relname, grantee_role.rolname, item.privilege_type`,
    [tableNames],
  );
  const actualAcl = new Set(acl.rows.map((row) => [
    row.table_name,
    row.grantee_name ?? 'PUBLIC',
    row.privilege_type,
    row.is_grantable ? 'grantable' : 'plain',
  ].join('\u0000')));
  const expectedAcl = new Set(
    [...D02_GATEWAY_PRIVILEGES].flatMap(([table, privileges]) =>
      [...privileges].map((privilege) => [
        table, D02_DATABASE_ROLE, privilege, 'plain',
      ].join('\u0000'))),
  );
  if (
    actualAcl.size !== expectedAcl.size
    || [...actualAcl].some((entry) => !expectedAcl.has(entry))
  ) throw new Error('Voice Lab D02 direct ACL drifted.');

  const constraints = await client.query(
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
    [tableNames],
  );
  const constraintMap = new Map(
    constraints.rows.map((row) => [`${row.tablename}.${row.conname}`, row]),
  );
  if (
    constraints.rows.length !== D02_CONSTRAINTS.size
    || constraintMap.size !== D02_CONSTRAINTS.size
  ) throw new Error('Voice Lab D02 constraint set drifted.');
  for (const [name, expected] of D02_CONSTRAINTS) {
    const row = constraintMap.get(name);
    if (
      !row
      || row.contype !== expected[0]
      || row.convalidated !== true
      || row.condeferrable !== false
      || row.condeferred !== false
      || row.definition_sha256 !== expected[1]
    ) throw new Error(`Voice Lab D02 constraint ${name} drifted.`);
  }

  const indexes = await client.query(
    `SELECT /* voice_lab_d02_indexes */ table_relation.relname AS tablename,
            index_relation.relname AS indexname,
            index_row.indisunique, index_row.indisvalid, index_row.indisready,
            index_row.indimmediate, index_row.indnkeyatts,
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
            pg_get_expr(index_row.indpred, index_row.indrelid, true) AS predicate,
            ARRAY(
              SELECT operator_class.opcname
                FROM unnest(index_row.indclass::oid[]) WITH ORDINALITY item(oid, position)
                JOIN pg_opclass operator_class ON operator_class.oid = item.oid
               ORDER BY item.position
            )::text[] AS opclasses,
            ARRAY(
              SELECT COALESCE(collation_row.collname, '')
                FROM unnest(index_row.indcollation::oid[]) WITH ORDINALITY item(oid, position)
                LEFT JOIN pg_collation collation_row ON collation_row.oid = item.oid
               ORDER BY item.position
            )::text[] AS collations
       FROM pg_index index_row
       JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = 'public'
        AND table_relation.relname = ANY($1::text[])
      ORDER BY table_relation.relname, index_relation.relname`,
    [tableNames],
  );
  const indexMap = new Map(indexes.rows.map((row) => [row.indexname, row]));
  if (indexes.rows.length !== D02_INDEXES.size || indexMap.size !== D02_INDEXES.size) {
    throw new Error('Voice Lab D02 index set drifted.');
  }
  for (const [name, expected] of D02_INDEXES) {
    const row = indexMap.get(name);
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
        (value, index) => normalizeExpression(value) !== expected.expressions[index],
      )
      || row.key_options.length !== expected.options.length
      || row.key_options.some((value, index) => Number(value) !== expected.options[index])
      || normalizeExpression(row.predicate) !== expected.predicate
      || JSON.stringify(row.opclasses) !== JSON.stringify(expected.opclasses)
      || JSON.stringify(row.collations) !== JSON.stringify(expected.collations)
    ) throw new Error(`Voice Lab D02 index ${name} drifted.`);
  }

  const foreignKeyTriggers = await client.query(
    `SELECT /* voice_lab_d02_fk_triggers */ source.relname AS source_table,
            constraint_row.conname AS constraint_name,
            target.relname AS tablename, procedure.proname,
            trigger_row.tgenabled, trigger_row.tgisinternal
       FROM pg_trigger trigger_row
       JOIN pg_constraint constraint_row ON constraint_row.oid = trigger_row.tgconstraint
       JOIN pg_class source ON source.oid = constraint_row.conrelid
       JOIN pg_class target ON target.oid = trigger_row.tgrelid
       JOIN pg_proc procedure ON procedure.oid = trigger_row.tgfoid
      WHERE source.relname = ANY($1::text[])
        AND constraint_row.contype = 'f'
      ORDER BY source.relname, constraint_row.conname,
               target.relname, procedure.proname`,
    [tableNames],
  );
  const expectedForeignKeys = [...D02_CONSTRAINTS]
    .filter(([, expected]) => expected[0] === 'f');
  if (foreignKeyTriggers.rows.length !== expectedForeignKeys.length * 4) {
    throw new Error('Voice Lab D02 foreign-key trigger cardinality drifted.');
  }
  for (const [key] of expectedForeignKeys) {
    const [source, constraintName] = key.split('.', 2);
    const rows = foreignKeyTriggers.rows.filter(
      (row) => row.source_table === source && row.constraint_name === constraintName,
    );
    const actualShapes = new Set(rows.map((row) => `${row.tablename}.${row.proname}`));
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
    ) throw new Error(`Voice Lab D02 foreign-key triggers for ${key} drifted.`);
  }
  const nonInternalTriggers = await client.query(
    `SELECT /* voice_lab_d02_noninternal_triggers */ relation.relname, trigger_row.tgname
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND NOT trigger_row.tgisinternal`,
    [tableNames],
  );
  if (nonInternalTriggers.rows.length !== 0) {
    throw new Error('Voice Lab D02 noninternal trigger set drifted.');
  }

  if (!expectedD02FinalizeAuthority) {
    throw new Error('Voice Lab D02 finalize authority expectation is unavailable.');
  }
  const authority = await client.query(
    `SELECT /* voice_lab_d02_finalize_authority */ count(*) = 1 AS exact_cardinality,
            bool_and(singleton) AS singleton_exact,
            min(authority_key_id) AS authority_key_id,
            min(encode(sha256(convert_to(authority_secret, 'UTF8')), 'hex'))
              AS authority_secret_sha256,
            bool_and(installed_at <= clock_timestamp()) AS installed
       FROM public.sophia_voice_lab_d02_gateway_finalize_authority`,
  );
  const authorityRow = authority.rows[0];
  if (
    authority.rows.length !== 1
    || authorityRow?.exact_cardinality !== true
    || authorityRow?.singleton_exact !== true
    || (!allowFinalizeAuthorityValueMismatch
      && authorityRow?.authority_key_id !== expectedD02FinalizeAuthority.keyId)
    || (!allowFinalizeAuthorityValueMismatch
      && authorityRow?.authority_secret_sha256
        !== expectedD02FinalizeAuthority.secretSha256)
    || authorityRow?.installed !== true
  ) throw new Error('Voice Lab D02 finalize authority drifted.');

  const roleResult = await client.query(
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
       FROM pg_roles role WHERE role.rolname = $1`,
    [D02_DATABASE_ROLE],
  );
  const role = roleResult.rows[0];
  const canonicalInboundCount = Number(role?.canonical_inbound_membership_count);
  if (
    roleResult.rows.length !== 1
    || role.rolname !== D02_DATABASE_ROLE
    || role.rolsuper !== false
    || role.rolinherit !== false
    || role.rolcreaterole !== false
    || role.rolcreatedb !== false
    || role.rolcanlogin !== true
    || role.rolreplication !== false
    || role.rolbypassrls !== false
    || role.membership_contract_version !== ROLE_MEMBERSHIP_CONTRACT_VERSION
    || role.membership_direction_attested !== true
    || !Number.isInteger(canonicalInboundCount)
    || canonicalInboundCount < 0
    || canonicalInboundCount > 1
    || Number(role.outbound_membership_count) !== 0
    || role.transitive_authority_free !== true
    || role.public_schema_create_denied !== true
    || role.future_function_public_execute_denied !== true
  ) throw new Error('Voice Lab D02 Gateway database role is missing or overprivileged.');

  const effective = await client.query(
    `SELECT /* voice_lab_d02_effective_privileges */ table_name, privilege_type,
            has_table_privilege(
              to_regrole($1), format('public.%I', table_name), privilege_type
            ) AS permitted
       FROM unnest($2::text[]) table_name
       CROSS JOIN unnest(
         ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
               'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
       ) privilege_type
      ORDER BY table_name, privilege_type`,
    [D02_DATABASE_ROLE, [...D02_GATEWAY_EFFECTIVE_PRIVILEGES.keys()]],
  );
  const actualEffective = new Map(
    [...D02_GATEWAY_EFFECTIVE_PRIVILEGES.keys()].map((table) => [table, new Set()]),
  );
  for (const row of effective.rows) {
    if (row.permitted) actualEffective.get(row.table_name)?.add(row.privilege_type);
  }
  if (
    effective.rows.length !== D02_GATEWAY_EFFECTIVE_PRIVILEGES.size * 8
    || [...D02_GATEWAY_EFFECTIVE_PRIVILEGES].some(([table, expected]) => {
      const actual = actualEffective.get(table);
      return !actual
        || actual.size !== expected.size
      || [...actual].some((privilege) => !expected.has(privilege));
    })
  ) throw new Error('Voice Lab D02 Gateway effective ACL drifted.');

  const globalEffective = await client.query(
    `(SELECT /* voice_lab_d02_global_effective_privileges */
            relation.relname AS table_name, privilege_type,
            has_table_privilege(
              to_regrole($1), relation.oid, privilege_type
            ) AS table_permitted,
            CASE WHEN privilege_type = ANY(
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
        AND NOT EXISTS (
          SELECT 1
            FROM pg_depend dependency
           WHERE dependency.classid = 'pg_class'::regclass
             AND dependency.objid = relation.oid
             AND dependency.deptype = 'e'
        )
    ) UNION ALL (
      SELECT relation.relname AS table_name, privilege_type,
             has_sequence_privilege(
               to_regrole($1), relation.oid, privilege_type
             ) AS table_permitted,
             false AS column_permitted
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) privilege_type
       WHERE namespace.nspname = 'public' AND relation.relkind = 'S'
         AND NOT EXISTS (
           SELECT 1
             FROM pg_depend dependency
            WHERE dependency.classid = 'pg_class'::regclass
              AND dependency.objid = relation.oid
              AND dependency.deptype = 'e'
         )
    ) ORDER BY table_name, privilege_type`,
    [D02_DATABASE_ROLE],
  );
  if (
    globalEffective.rows.length === 0
    || globalEffective.rows.some(
      (row) => row.table_permitted === true || row.column_permitted === true,
    )
  ) throw new Error('Voice Lab D02 Gateway has raw public relation authority.');

  const globalFunctions = await client.query(
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
        AND has_function_privilege(to_regrole($1), procedure.oid, 'EXECUTE')
      ORDER BY procedure.proname, identity_arguments`,
    [D02_DATABASE_ROLE],
  );
  const actualFunctionAuthority = new Set(
    globalFunctions.rows.map(
      (row) => `${row.proname}(${row.identity_arguments.replace(/\s+/g, ' ').trim()})`,
    ),
  );
  const expectedFunctionAuthority = new Set(
    [...D02_FUNCTION_CONTRACTS]
      .filter(([, contract]) => contract.gatewayExecute)
      .map(([name, contract]) => `${name}(${contract.args})`),
  );
  if (
    actualFunctionAuthority.size !== expectedFunctionAuthority.size
    || [...actualFunctionAuthority].some(
      (identity) => !expectedFunctionAuthority.has(identity),
    )
  ) throw new Error('Voice Lab D02 Gateway effective function authority drifted.');
}

async function preflight(
  rawClient,
  { allowFinalizeAuthorityValueMismatch = false } = {},
) {
  let queryTail = Promise.resolve();
  const client = {
    query(...args) {
      const result = queryTail.then(async () => {
        try {
          return await rawClient.query(...args);
        } catch (error) {
          const queryText = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          const label = typeof queryText === 'string'
            ? queryText.match(/\/\*\s*([a-z0-9_]+)\s*\*\//i)?.[1]
            : undefined;
          if (label && error instanceof Error) error.message += ` [query=${label}]`;
          throw error;
        }
      });
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
    cleanupIndexes,
    cleanupTriggers,
    cleanupFunctions,
    unsafeFenceGrants,
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
    cleanupScanCursors,
    runtimeRole,
    sessionSettings,
  ] = await Promise.all([
    client.query(
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
      [TABLE],
    ),
    client.query(
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
              pg_get_expr(i.indpred, i.indrelid, true) AS predicate
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
         JOIN pg_am am ON am.oid = idx.relam
        WHERE ns.nspname = 'public' AND tbl.relname = $1`,
      [TABLE],
    ),
    client.query(
      `SELECT conname, contype, convalidated,
              pg_get_constraintdef(oid, true) AS definition
         FROM pg_constraint
        WHERE conrelid = to_regclass($1)`,
      [`public.${TABLE}`],
    ),
    client.query(
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
      [`public.${TABLE}`],
    ),
    client.query(
      `SELECT grantee, privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = $1
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
      [TABLE],
    ),
    client.query(
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
      [[TABLE, ...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
      `SELECT obj_description(to_regclass($1), 'pg_class') AS table_comment`,
      [`public.${TABLE}`],
    ),
    client.query(
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
      [[...CLEANUP_INDEX_CONTRACTS.keys()]],
    ),
    client.query(
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
          ...[...CLEANUP_TRIGGER_CONTRACTS.values()]
            .map((contract) => contract.table),
              ...CLEANUP_CONTROL_COLUMNS.keys(),
              'session',
        ],
      )]],
    ),
    client.query(
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
              CASE WHEN to_regrole('${D02_DATABASE_ROLE}') IS NULL THEN false
                   ELSE has_function_privilege(
                     to_regrole('${D02_DATABASE_ROLE}'), p.oid, 'EXECUTE'
                   ) END AS gateway_can_execute,
              CASE WHEN to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}') IS NULL
                   THEN false ELSE has_function_privilege(
                     to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                     p.oid, 'EXECUTE'
                   ) END AS runtime_can_execute,
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
                       AND acl.grantee = to_regrole('${D02_DATABASE_ROLE}')
                     )
                     OR (
                       p.proname = 'sophia_voice_lab_d02_sources_zero'
                       AND acl.grantee =
                         to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}')
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
                   AND acl.grantee = to_regrole('${D02_DATABASE_ROLE}')
                   AND acl.is_grantable
              ) AS gateway_execute_grantable,
              EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE acl.privilege_type = 'EXECUTE'
                   AND acl.grantee =
                     to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}')
                   AND acl.is_grantable
              ) AS runtime_execute_grantable,
              p.prosrc,
              encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS source_sha256,
              obj_description(p.oid, 'pg_proc') AS function_comment
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         JOIN pg_class owner_table ON owner_table.oid =
              'public.sophia_voice_lab_cleanup_obligations'::regclass
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [
        [...GOVERNED_FUNCTION_CONTRACTS.keys()],
        [...D02_FUNCTION_CONTRACTS]
          .filter(([, contract]) => contract.gatewayExecute)
          .map(([name]) => name),
      ],
    ),
    client.query(
      `SELECT grantee, privilege_type
         FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name = 'sophia_voice_lab_cleanup_write_fence'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
    ),
    client.query(
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
      [PRODUCT_TABLES],
    ),
    client.query(
      `SELECT /* voice_lab_product_table_privileges */ table_name,
              has_table_privilege(current_user, format('public.%I', table_name), 'SELECT') AS can_select,
              has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS can_delete,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'SELECT'
              ) AS runtime_can_select,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'INSERT'
              ) AS runtime_can_insert,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'UPDATE'
              ) AS runtime_can_update,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'DELETE'
              ) AS runtime_can_delete,
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
                       AND acl.grantee =
                         to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}')
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
      [PRODUCT_TABLES],
    ),
    client.query(
      `SELECT /* voice_lab_product_table_unsafe_grants */ table_name, grantee, privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
      [PRODUCT_TABLES],
    ),
    client.query(
      `SELECT /* voice_lab_session_messages_fk */ fk.oid, fk.conname,
              fk.convalidated, fk.condeferrable, fk.condeferred,
              pg_get_constraintdef(fk.oid, true) AS definition
         FROM pg_constraint fk
        WHERE fk.conrelid = 'public.sophia_session_messages'::regclass
          AND fk.confrelid = 'public.sophia_sessions'::regclass
          AND fk.contype = 'f'`,
    ),
    client.query(
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
    client.query(
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
    client.query(
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
      [PRODUCT_TABLES],
    ),
    client.query(
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
    client.query(
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
              pg_get_expr(i.indpred, i.indrelid, true) AS predicate
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
         JOIN pg_am am ON am.oid = idx.relam
        WHERE ns.nspname = 'public' AND tbl.relname = 'session'
          AND idx.relname = ANY($1::text[])`,
      [[...BETTER_AUTH_SESSION_INDEXES.keys()]],
    ),
    client.query(
      `SELECT /* voice_lab_better_auth_session_key_constraints */
              conname, contype, convalidated, condeferrable, condeferred,
              pg_get_constraintdef(oid, true) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public."session"'::regclass
          AND contype = ANY(ARRAY['p'::"char", 'u'::"char"])
        ORDER BY conname`,
    ),
    client.query(
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
    client.query(
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
      [[...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
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
              pg_get_expr(i.indpred, i.indrelid, true) AS predicate
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
         JOIN pg_am am ON am.oid = idx.relam
        WHERE ns.nspname = 'public' AND tbl.relname = ANY($1::text[])`,
      [[...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
      `SELECT c.relname AS tablename, con.conname, con.contype,
              con.convalidated, pg_get_constraintdef(con.oid, true) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [[...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
      `SELECT table_name,
              has_table_privilege(current_user, format('public.%I', table_name), 'SELECT') AS can_select,
              has_table_privilege(current_user, format('public.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege(current_user, format('public.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege(current_user, format('public.%I', table_name), 'DELETE') AS can_delete,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'SELECT'
              ) AS runtime_can_select,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'INSERT'
              ) AS runtime_can_insert,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'UPDATE'
              ) AS runtime_can_update,
              has_table_privilege(
                to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}'),
                format('public.%I', table_name), 'DELETE'
              ) AS runtime_can_delete,
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
                     acl.grantee =
                       to_regrole('${EXPECTED_RUNTIME_DATABASE_ROLE}')
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
      [[...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
      `SELECT table_name, grantee, privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND grantee IN ('PUBLIC', 'anon', 'authenticated')`,
      [[...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
      `SELECT c.relname AS tablename,
              obj_description(c.oid, 'pg_class') AS table_comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [[...CLEANUP_CONTROL_COLUMNS.keys()]],
    ),
    client.query(
      `SELECT cursor_name
         FROM public.sophia_voice_lab_cleanup_scan_cursors
        ORDER BY cursor_name`,
    ),
    client.query(
      `SELECT role.rolname, role.rolsuper, role.rolinherit,
              role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
              role.rolreplication, role.rolbypassrls,
              ${roleMembershipAttestationSql()},
              NOT has_schema_privilege(role.oid, 'public', 'CREATE')
                AS public_schema_create_denied
         FROM pg_roles role
        WHERE role.rolname = $1`,
      [EXPECTED_RUNTIME_DATABASE_ROLE],
    ),
    client.query(
      `SELECT session_user::text AS session_user_name,
              current_user::text AS current_user_name,
              current_role::text AS current_role_name,
              current_setting('session_replication_role')
              AS session_replication_role,
              current_setting('search_path') AS search_path,
              current_setting('transaction_read_only') AS transaction_read_only,
              current_setting('synchronous_commit') AS synchronous_commit,
              pg_is_in_recovery() AS in_recovery`,
    ),
  ]);

  const runtimeCanonicalInboundCount = Number(
    runtimeRole.rows[0]?.canonical_inbound_membership_count,
  );
  if (
    runtimeRole.rows.length !== 1
    || runtimeRole.rows[0].rolname !== EXPECTED_RUNTIME_DATABASE_ROLE
    || runtimeRole.rows[0].rolsuper !== false
    || runtimeRole.rows[0].rolinherit !== false
    || runtimeRole.rows[0].rolcreaterole !== false
    || runtimeRole.rows[0].rolcreatedb !== false
    || runtimeRole.rows[0].rolcanlogin !== true
    || runtimeRole.rows[0].rolreplication !== false
    || runtimeRole.rows[0].rolbypassrls !== false
    || runtimeRole.rows[0].membership_contract_version
      !== ROLE_MEMBERSHIP_CONTRACT_VERSION
    || runtimeRole.rows[0].membership_direction_attested !== true
    || !Number.isInteger(runtimeCanonicalInboundCount)
    || runtimeCanonicalInboundCount < 0
    || runtimeCanonicalInboundCount > 1
    || Number(runtimeRole.rows[0].outbound_membership_count) !== 0
    || runtimeRole.rows[0].transitive_authority_free !== true
    || runtimeRole.rows[0].public_schema_create_denied !== true
  ) {
    throw new Error('Voice Lab runtime database role is missing or overprivileged.');
  }

  if (
    sessionSettings.rows.length !== 1
    || sessionSettings.rows[0].session_user_name !== EXPECTED_DATABASE_OWNER_ROLE
    || sessionSettings.rows[0].current_user_name !== EXPECTED_DATABASE_OWNER_ROLE
    || sessionSettings.rows[0].current_role_name !== EXPECTED_DATABASE_OWNER_ROLE
    || sessionSettings.rows[0].session_replication_role !== 'origin'
    || sessionSettings.rows[0].search_path.replace(/\s/g, '')
      !== 'pg_catalog,public,pg_temp'
    || sessionSettings.rows[0].transaction_read_only !== 'off'
    || sessionSettings.rows[0].synchronous_commit === 'off'
    || sessionSettings.rows[0].in_recovery !== false
  ) {
    throw new Error('Voice Lab database session settings are unsafe.');
  }

  if (columns.rows.length !== EXPECTED_COLUMNS.size) {
    throw new Error('Voice Lab auth-ledger table column set is not exact.');
  }
  for (const row of columns.rows) {
    const expected = EXPECTED_COLUMNS.get(row.column_name);
    if (
      !expected
      || row.udt_name !== expected[0]
      || row.is_nullable !== expected[1]
      || (expected[0] === 'bpchar'
        ? Number(row.character_maximum_length) !== 64
        : row.character_maximum_length !== null)
      || row.is_generated !== 'NEVER'
      || row.is_identity !== 'NO'
      || normalizeDefault(row.column_default)
        !== normalizeDefault(EXPECTED_COLUMN_DEFAULTS.get(row.column_name))
    ) {
      throw new Error('Voice Lab auth-ledger table column shape is invalid.');
    }
  }
  const actualIndexes = new Map(indexes.rows.map((row) => [row.indexname, row]));
  if (actualIndexes.size !== EXPECTED_INDEXES.size) {
    throw new Error('Voice Lab auth-ledger index set drifted.');
  }
  for (const [name, expected] of EXPECTED_INDEXES) {
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
        (value, index) => normalizeExpression(value) !== expected.expressions[index],
      )
      || !Array.isArray(row.key_options)
      || row.key_options.length !== expected.options.length
      || row.key_options.some(
        (value, index) => Number(value) !== expected.options[index],
      )
      || normalizeExpression(row.predicate) !== expected.predicate
    ) {
      throw new Error(`Voice Lab auth-ledger index ${name} drifted.`);
    }
  }
  if (constraints.rows.length !== EXPECTED_AUTH_CONSTRAINTS.size) {
    throw new Error('Voice Lab auth-ledger constraint set drifted.');
  }
  for (const row of constraints.rows) {
    const expected = EXPECTED_AUTH_CONSTRAINTS.get(row.conname);
    if (
      !expected
      || row.contype !== expected[0]
      || row.convalidated !== true
      || normalizeConstraint(row.definition) !== normalizeConstraint(expected[1])
    ) {
      throw new Error('Voice Lab auth-ledger constraint definition drifted.');
    }
  }
  const access = privileges.rows[0];
  if (
    !access?.can_select || !access.can_insert || !access.can_update || !access.can_delete
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
  ) {
    throw new Error('Voice Lab auth-ledger operator role lacks required privileges.');
  }
  if (unsafeGrants.rows.length > 0 || unsafeEffectiveTablePrivileges.rows.length > 0) {
    throw new Error('Voice Lab auth-ledger table has unsafe public/client-role grants.');
  }
  if (metadata.rows[0]?.table_comment !== EXPECTED_TABLE_COMMENT) {
    throw new Error('Voice Lab auth-ledger migration identity is missing or mismatched.');
  }
  const actualCleanupIndexes = new Map(
    cleanupIndexes.rows.map((row) => [row.indexname, row]),
  );
  for (const [name, expected] of CLEANUP_INDEX_CONTRACTS) {
    const actual = actualCleanupIndexes.get(name);
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
        (value, index) => normalizeExpression(value) !== expected.expressions[index],
      )
      || !Array.isArray(actual.key_options)
      || actual.key_options.length !== expected.options.length
      || actual.key_options.some(
        (value, index) => Number(value) !== expected.options[index],
      )
      || normalizeExpression(actual.predicate) !== expected.predicate
    ) {
      throw new Error(`Voice Lab product cleanup index ${name} drifted.`);
    }
  }
  if (cleanupTriggers.rows.length !== CLEANUP_TRIGGER_CONTRACTS.size) {
    throw new Error('Voice Lab cleanup write-fence trigger set drifted.');
  }
  const triggerRows = new Map(cleanupTriggers.rows.map((row) => [row.tgname, row]));
  for (const [name, expected] of CLEANUP_TRIGGER_CONTRACTS) {
    const row = triggerRows.get(name);
    const expectedComment = `sophia.voice-lab.${expected.commentKind}.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256}`;
    const sourceIsExactEnough = expected.functionName === 'sophia_voice_lab_message_write_fence'
      ? String(row?.prosrc).includes('synthetic transcript parent binding is immutable')
        && String(row?.prosrc).includes("obligation_phase not in ('session_provisional', 'finalizing')")
        && String(row?.prosrc).includes('clock_timestamp() >= obligation_retention')
        && String(row?.prosrc).includes('synthetic transcript retention deletion is unavailable')
      : String(row?.prosrc).includes('clock_timestamp() >= retention_deadline')
        && String(row?.prosrc).includes('synthetic session signed binding is immutable')
        && String(row?.prosrc).includes('synthetic artifact signed binding is immutable')
        && String(row?.prosrc).includes('synthetic auth tombstone transition is invalid')
        && String(row?.prosrc).includes('synthetic auth tombstone deletion is invalid');
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
      || !String(row.prosrc).includes('pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944))')
      || !sourceIsExactEnough
    ) {
      throw new Error(`Voice Lab cleanup write fence ${name} drifted.`);
    }
  }
  if (unsafeFenceGrants.rows.length > 0) {
    throw new Error('Voice Lab cleanup write-fence function has unsafe grants.');
  }
  const functionRows = new Map(cleanupFunctions.rows.map((row) => [row.proname, row]));
  if (
    cleanupFunctions.rows.length !== GOVERNED_FUNCTION_CONTRACTS.size
    || functionRows.size !== GOVERNED_FUNCTION_CONTRACTS.size
  ) {
    throw new Error('Voice Lab governed function set is incomplete or overloaded.');
  }
  for (const [name, expected] of GOVERNED_FUNCTION_CONTRACTS) {
    const row = functionRows.get(name);
    if (
      !row
      || String(row.identity_arguments).replace(/\s+/g, ' ').trim() !== expected.args
      || String(row.result_type).replace(/\s+/g, ' ').trim() !== expected.result
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
      || row.gateway_can_execute !== (expected.gatewayExecute ?? false)
      || row.runtime_can_execute !== (expected.runtimeExecute ?? false)
      || row.source_sha256 !== expected.sourceSha256
      || (expected.comment !== undefined && row.function_comment !== expected.comment)
      || row.unexpected_execute_acl !== false
      || row.service_execute_grantable !== false
      || row.gateway_execute_grantable !== false
      || row.runtime_execute_grantable !== false
    ) {
      throw new Error(`Voice Lab governed function ${name} drifted.`);
    }
  }
  for (const [table, expectedColumns] of REQUIRED_PRODUCT_COLUMNS) {
    const actualColumns = productColumns.rows.filter((row) => row.table_name === table);
    for (const [columnName, expected] of expectedColumns) {
      const row = actualColumns.find((candidate) => candidate.column_name === columnName);
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
      ) {
        throw new Error(`Voice Lab product table ${table} required columns drifted.`);
      }
    }
  }
  if (
    productPrivileges.rows.length !== PRODUCT_TABLES.length
    || productPrivileges.rows.some((row) => (
      !PRODUCT_TABLES.includes(row.table_name)
      || !RUNTIME_PRODUCT_TABLE_PRIVILEGES.has(row.table_name)
      || row.can_select !== true
      || row.can_insert !== true
      || row.can_update !== true
      || row.can_delete !== true
      || row.runtime_can_select
        !== RUNTIME_PRODUCT_TABLE_PRIVILEGES.get(row.table_name).select
      || row.runtime_can_insert
        !== RUNTIME_PRODUCT_TABLE_PRIVILEGES.get(row.table_name).insert
      || row.runtime_can_update
        !== RUNTIME_PRODUCT_TABLE_PRIVILEGES.get(row.table_name).update
      || row.runtime_can_delete
        !== RUNTIME_PRODUCT_TABLE_PRIVILEGES.get(row.table_name).delete
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
      || row.unexpected_column_acl !== false
    ))
    || productUnsafeGrants.rows.length > 0
  ) {
    throw new Error('Voice Lab product table privileges are invalid.');
  }
  if (
    sessionMessagesForeignKey.rows.length !== 1
    || sessionMessagesForeignKey.rows[0].conname
      !== 'sophia_session_messages_session_id_fkey'
    || sessionMessagesForeignKey.rows[0].convalidated !== true
    || sessionMessagesForeignKey.rows[0].condeferrable !== false
    || sessionMessagesForeignKey.rows[0].condeferred !== false
    || normalizeConstraint(sessionMessagesForeignKey.rows[0].definition)
      !== normalizeConstraint(SESSION_MESSAGES_FK.definition)
  ) {
    throw new Error('Voice Lab transcript parent foreign key drifted.');
  }
  const actualForeignKeyTriggers = new Set(
    sessionMessagesForeignKeyTriggers.rows.map(
      (row) => `${row.tablename}.${row.proname}`,
    ),
  );
  if (
    sessionMessagesForeignKeyTriggers.rows.length !== SESSION_MESSAGES_FK.triggers.size
    || actualForeignKeyTriggers.size !== SESSION_MESSAGES_FK.triggers.size
    || [...SESSION_MESSAGES_FK.triggers].some(
      (triggerName) => !actualForeignKeyTriggers.has(triggerName),
    )
    || sessionMessagesForeignKeyTriggers.rows.some(
      (row) => row.tgenabled !== 'O' || row.tgisinternal !== true,
    )
  ) {
    throw new Error('Voice Lab transcript parent foreign-key triggers drifted.');
  }
  const cleanupAdmissionForeignKeyTriggers = new Set(
    cleanupAdmissionsForeignKeyTriggers.rows.map(
      (row) => `${row.tablename}.${row.proname}`,
    ),
  );
  if (
    cleanupAdmissionsForeignKeyTriggers.rows.length !== CLEANUP_ADMISSIONS_FK.triggers.size
    || cleanupAdmissionForeignKeyTriggers.size !== CLEANUP_ADMISSIONS_FK.triggers.size
    || [...CLEANUP_ADMISSIONS_FK.triggers].some(
      (triggerName) => !cleanupAdmissionForeignKeyTriggers.has(triggerName),
    )
    || cleanupAdmissionsForeignKeyTriggers.rows.some(
      (row) => row.tgenabled !== 'O' || row.tgisinternal !== true,
    )
  ) {
    throw new Error('Voice Lab cleanup admission foreign-key triggers drifted.');
  }
  const primaryKeys = new Map(
    productPrimaryKeys.rows.map((row) => [`${row.tablename}.${row.conname}`, row]),
  );
  if (
    productPrimaryKeys.rows.length !== PRODUCT_PRIMARY_KEYS.size
    || primaryKeys.size !== PRODUCT_PRIMARY_KEYS.size
  ) {
    throw new Error('Voice Lab product primary-key set drifted.');
  }
  for (const [name, expectedDefinition] of PRODUCT_PRIMARY_KEYS) {
    const row = primaryKeys.get(name);
    if (
      !row
      || row.convalidated !== true
      || row.condeferrable !== false
      || row.condeferred !== false
      || normalizeConstraint(row.definition) !== normalizeConstraint(expectedDefinition)
      || row.indisunique !== true
      || row.indisvalid !== true
      || row.indisready !== true
      || row.index_relpersistence !== 'p'
      || row.amname !== 'btree'
    ) throw new Error(`Voice Lab product primary key ${name} drifted.`);
  }
  if (betterAuthSessionColumns.rows.length !== BETTER_AUTH_SESSION_COLUMNS.size) {
    throw new Error('Voice Lab Better Auth session column set drifted.');
  }
  for (const row of betterAuthSessionColumns.rows) {
    const expected = BETTER_AUTH_SESSION_COLUMNS.get(row.column_name);
    if (
      !expected
      || row.udt_name !== expected[0]
      || row.is_nullable !== expected[1]
      || row.character_maximum_length !== null
      || row.is_generated !== 'NEVER'
      || row.is_identity !== 'NO'
    ) throw new Error('Voice Lab Better Auth session column shape drifted.');
  }
  const betterAuthIndexes = new Map(
    betterAuthSessionIndexes.rows.map((row) => [row.indexname, row]),
  );
  if (
    betterAuthSessionIndexes.rows.length !== BETTER_AUTH_SESSION_INDEXES.size
    || betterAuthIndexes.size !== BETTER_AUTH_SESSION_INDEXES.size
  ) throw new Error('Voice Lab Better Auth session index set drifted.');
  for (const [name, expected] of BETTER_AUTH_SESSION_INDEXES) {
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
        (value, index) => normalizeExpression(value) !== expected.expressions[index],
      )
      || row.key_options.length !== expected.options.length
      || row.key_options.some(
        (value, index) => Number(value) !== expected.options[index],
      )
      || normalizeExpression(row.predicate) !== ''
    ) throw new Error(`Voice Lab Better Auth session index ${name} drifted.`);
  }
  const betterAuthConstraints = new Map(
    betterAuthSessionConstraints.rows.map((row) => [row.conname, row]),
  );
  if (
    betterAuthSessionConstraints.rows.length !== BETTER_AUTH_SESSION_KEY_CONSTRAINTS.size
    || betterAuthConstraints.size !== BETTER_AUTH_SESSION_KEY_CONSTRAINTS.size
  ) throw new Error('Voice Lab Better Auth session key constraint set drifted.');
  for (const [name, expected] of BETTER_AUTH_SESSION_KEY_CONSTRAINTS) {
    const row = betterAuthConstraints.get(name);
    if (
      !row
      || row.contype !== expected[0]
      || row.convalidated !== true
      || row.condeferrable !== false
      || row.condeferred !== false
      || normalizeConstraint(row.definition) !== normalizeConstraint(expected[1])
    ) throw new Error(`Voice Lab Better Auth session constraint ${name} drifted.`);
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
  ) throw new Error('Voice Lab Better Auth session relation drifted.');
  for (const [table, expectedColumns] of CLEANUP_CONTROL_COLUMNS) {
    const actualColumns = cleanupControlColumns.rows.filter((row) => row.table_name === table);
    if (actualColumns.length !== expectedColumns.size || actualColumns.some((row) => {
      const expected = expectedColumns.get(row.column_name);
      return !expected
        || row.udt_name !== expected[0]
        || row.is_nullable !== expected[1]
        || row.character_maximum_length !== null
        || row.is_generated !== 'NEVER'
        || row.is_identity !== 'NO'
        || normalizeDefault(row.column_default) !== normalizeDefault(
          CLEANUP_CONTROL_DEFAULTS.get(`${table}.${row.column_name}`),
        );
    })) {
      throw new Error(`Voice Lab cleanup control table ${table} columns drifted.`);
    }
  }
  const actualControlIndexes = new Map(
    cleanupControlIndexes.rows.map((row) => [row.indexname, row]),
  );
  if (actualControlIndexes.size !== CLEANUP_CONTROL_INDEXES.size) {
    throw new Error('Voice Lab cleanup control index set drifted.');
  }
  for (const [name, expected] of CLEANUP_CONTROL_INDEXES) {
    const row = actualControlIndexes.get(name);
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
        (value, index) => normalizeExpression(value) !== expected.expressions[index],
      )
      || !Array.isArray(row.key_options)
      || row.key_options.length !== expected.options.length
      || row.key_options.some(
        (value, index) => Number(value) !== expected.options[index],
      )
      || normalizeExpression(row.predicate) !== expected.predicate
    ) {
      throw new Error(`Voice Lab cleanup control index ${name} drifted.`);
    }
  }
  const actualControlConstraints = new Map(
    cleanupControlConstraints.rows.map((row) => [`${row.tablename}.${row.conname}`, row]),
  );
  if (actualControlConstraints.size !== CLEANUP_CONTROL_CONSTRAINTS.size) {
    throw new Error('Voice Lab cleanup control constraint set drifted.');
  }
  for (const [name, expected] of CLEANUP_CONTROL_CONSTRAINTS) {
    const row = actualControlConstraints.get(name);
    if (
      !row
      || row.contype !== expected[0]
      || row.convalidated !== true
      || normalizeConstraint(row.definition) !== normalizeConstraint(expected[1])
    ) {
      throw new Error(`Voice Lab cleanup control constraint ${name} drifted.`);
    }
  }
  if (
    cleanupControlPrivileges.rows.length !== CLEANUP_CONTROL_COLUMNS.size
    || cleanupControlPrivileges.rows.some((row) => (
      !RUNTIME_CLEANUP_CONTROL_PRIVILEGES.has(row.table_name)
      || row.can_select !== true || row.can_insert !== true
      || row.can_update !== true || row.can_delete !== true
      || row.runtime_can_select
        !== RUNTIME_CLEANUP_CONTROL_PRIVILEGES.get(row.table_name).select
      || row.runtime_can_insert
        !== RUNTIME_CLEANUP_CONTROL_PRIVILEGES.get(row.table_name).insert
      || row.runtime_can_update
        !== RUNTIME_CLEANUP_CONTROL_PRIVILEGES.get(row.table_name).update
      || row.runtime_can_delete
        !== RUNTIME_CLEANUP_CONTROL_PRIVILEGES.get(row.table_name).delete
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
      || row.unexpected_column_acl !== false
    ))
    || cleanupControlUnsafeGrants.rows.length > 0
  ) {
    throw new Error('Voice Lab cleanup control table privileges are invalid.');
  }
  const controlComments = new Map(
    cleanupControlMetadata.rows.map((row) => [row.tablename, row.table_comment]),
  );
  if (
    controlComments.get('sophia_voice_lab_cleanup_obligations')
      !== `sophia.voice-lab.cleanup-obligation-state.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-control-only`
    || controlComments.get('sophia_voice_lab_cleanup_admissions')
      !== `sophia.voice-lab.cleanup-admission-state.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=bounded-opaque-resource-locator-no-principal-run-secret`
    || controlComments.get('sophia_voice_lab_cleanup_scan_cursors')
      !== `sophia.voice-lab.cleanup-scan-cursor.v1 migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-control-keyset-only`
  ) {
    throw new Error('Voice Lab cleanup control table identity drifted.');
  }
  if (
    cleanupScanCursors.rows.length !== 2
    || cleanupScanCursors.rows[0]?.cursor_name !== 'complete_purge_v1'
    || cleanupScanCursors.rows[1]?.cursor_name !== 'work_v1'
  ) {
    throw new Error('Voice Lab cleanup scan cursor seed set drifted.');
  }
  await assertD02Catalog(client, { allowFinalizeAuthorityValueMismatch });
}

async function assertD02GatewayRoleReady(client) {
  const result = await client.query(
    `SELECT role.rolname, role.rolsuper, role.rolinherit,
            role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
            role.rolreplication, role.rolbypassrls,
            ${roleMembershipAttestationSql()},
            NOT has_schema_privilege(role.oid, 'public', 'CREATE')
              AS public_schema_create_denied
       FROM pg_roles role
      WHERE role.rolname = $1`,
    [D02_DATABASE_ROLE],
  );
  const role = result.rows[0];
  const canonicalInboundCount = Number(role?.canonical_inbound_membership_count);
  if (
    result.rows.length !== 1
    || role.rolname !== D02_DATABASE_ROLE
    || role.rolsuper !== false
    || role.rolinherit !== false
    || role.rolcreaterole !== false
    || role.rolcreatedb !== false
    || role.rolcanlogin !== true
    || role.rolreplication !== false
    || role.rolbypassrls !== false
    || role.membership_contract_version !== ROLE_MEMBERSHIP_CONTRACT_VERSION
    || role.membership_direction_attested !== true
    || !Number.isInteger(canonicalInboundCount)
    || canonicalInboundCount < 0
    || canonicalInboundCount > 1
    || Number(role.outbound_membership_count) !== 0
    || role.transitive_authority_free !== true
    || role.public_schema_create_denied !== true
  ) throw new Error('Voice Lab D02 Gateway database role is missing or overprivileged.');
  const rawAuthority = await client.query(
    `SELECT relation.relname
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND (
          relation.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
            has_table_privilege(
              to_regrole($1), relation.oid,
              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
            )
            OR has_any_column_privilege(
              to_regrole($1), relation.oid,
              'SELECT,INSERT,UPDATE,REFERENCES'
            )
          )
          OR relation.relkind = 'S' AND has_sequence_privilege(
            to_regrole($1), relation.oid, 'USAGE,SELECT,UPDATE'
          )
        )
      LIMIT 1`,
    [D02_DATABASE_ROLE],
  );
  if (rawAuthority.rows.length !== 0) {
    throw new Error('Voice Lab D02 Gateway raw authority must be removed before DDL.');
  }
}

async function assertD02FinalizeAuthorityRotationReady(client) {
  if (
    (process.env.SOPHIA_VOICE_LAB_KILL_SWITCH || '').trim().toLowerCase() !== 'true'
    || process.env.SOPHIA_VOICE_LAB_D02_FINALIZE_AUTHORITY_ROTATION_APPROVED !== 'YES'
  ) {
    throw new Error(
      'D02 finalize-authority rotation requires the kill switch and explicit maintenance approval.',
    );
  }
  const result = await client.query(
    `SELECT authority.authority_key_id AS prior_key_id,
            encode(sha256(convert_to(authority.authority_secret, 'UTF8')), 'hex')
              AS prior_secret_sha256,
            NOT EXISTS (
              SELECT 1 FROM public.sophia_voice_lab_d02_gateway_relay_leases
            ) AS relays_zero,
            NOT EXISTS (
              SELECT 1 FROM public.sophia_voice_lab_d02_gateway_settlements
               WHERE receipt IS NULL
            ) AS unsettled_freezes_zero,
            NOT EXISTS (
              SELECT 1
                FROM public.sophia_voice_lab_d02_product_continuity_observations before_row
               WHERE before_row.phase = 'before_api_restart'
                 AND NOT EXISTS (
                   SELECT 1
                     FROM public.sophia_voice_lab_d02_product_continuity_observations after_row
                    WHERE after_row.cleanup_obligation_id = before_row.cleanup_obligation_id
                      AND after_row.restart_request_id_sha256 = before_row.restart_request_id_sha256
                      AND after_row.phase = 'after_api_restart'
                 )
            ) AS pending_continuity_zero
       FROM public.sophia_voice_lab_d02_gateway_finalize_authority authority
      WHERE authority.singleton`,
  );
  const state = result.rows[0];
  if (
    result.rows.length !== 1
    || state.prior_key_id === expectedD02FinalizeAuthority.keyId
    || state.prior_secret_sha256 === expectedD02FinalizeAuthority.secretSha256
    || state.relays_zero !== true
    || state.unsettled_freezes_zero !== true
    || state.pending_continuity_zero !== true
  ) {
    throw new Error(
      'D02 finalize-authority rotation requires a distinct key id and a quiescent D02 plane.',
    );
  }
  return state.prior_key_id;
}

async function assertFreshOrExactlyCurrentShape(
  client,
  { allowFinalizeAuthorityRotation = false } = {},
) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('sophia-voice-lab-schema-v1', 731945))",
  );
  await assertD02GatewayRoleReady(client);
  await client.query(
    `LOCK TABLE
       public."session",
       public.sophia_sessions,
       public.sophia_session_messages,
       public.artifact_registry_records
     IN ACCESS EXCLUSIVE MODE`,
  );
  const presence = await client.query(
    `SELECT
       to_regclass('public.sophia_voice_lab_auth_grants') IS NOT NULL AS auth_exists,
       to_regclass('public.sophia_voice_lab_cleanup_obligations') IS NOT NULL AS obligations_exist,
       to_regclass('public.sophia_voice_lab_cleanup_admissions') IS NOT NULL AS admissions_exist,
       to_regclass('public.sophia_voice_lab_cleanup_scan_cursors') IS NOT NULL AS cursors_exist,
       to_regclass('public.sophia_voice_lab_d02_gateway_settlements') IS NOT NULL AS d02_settlements_exist,
       to_regclass('public.sophia_voice_lab_d02_gateway_capability_uses') IS NOT NULL AS d02_capability_uses_exist,
       to_regclass('public.sophia_voice_lab_d02_gateway_relay_leases') IS NOT NULL AS d02_relay_leases_exist,
       to_regclass('public.sophia_voice_lab_d02_product_continuity_observations') IS NOT NULL AS d02_continuity_exist,
       to_regclass('public.sophia_voice_lab_d02_gateway_finalize_authority') IS NOT NULL AS d02_finalize_authority_exist`,
  );
  const row = presence.rows[0];
  const coreExists = [row?.auth_exists, row?.obligations_exist, row?.admissions_exist];
  const d02Exists = [
    row?.d02_settlements_exist,
    row?.d02_capability_uses_exist,
    row?.d02_relay_leases_exist,
    row?.d02_continuity_exist,
    row?.d02_finalize_authority_exist,
  ];
  const d02AllExist = d02Exists.every((value) => value === true);
  const d02AllAbsent = d02Exists.every((value) => value === false);
  const footprint = await client.query(
    `SELECT
       NOT EXISTS (
         SELECT 1
           FROM pg_class object
           JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
          WHERE namespace.nspname = 'public' AND object.relname LIKE '%voice_lab%'
         UNION ALL
         SELECT 1
           FROM pg_proc object
           JOIN pg_namespace namespace ON namespace.oid = object.pronamespace
          WHERE namespace.nspname = 'public' AND object.proname LIKE '%voice_lab%'
         UNION ALL
         SELECT 1
           FROM pg_trigger object
           JOIN pg_class relation ON relation.oid = object.tgrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND object.tgname LIKE '%voice_lab%'
         UNION ALL
         SELECT 1
           FROM pg_constraint object
           JOIN pg_namespace namespace ON namespace.oid = object.connamespace
          WHERE namespace.nspname = 'public' AND object.conname LIKE '%voice_lab%'
         UNION ALL
         SELECT 1
           FROM pg_rewrite object
           JOIN pg_class relation ON relation.oid = object.ev_class
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND object.rulename LIKE '%voice_lab%'
       ) AS fresh_footprint_free,
       NOT EXISTS (
         SELECT 1
           FROM pg_class object
           JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
          WHERE namespace.nspname = 'public'
            AND starts_with(object.relname, 'sophia_voice_lab_d02_')
         UNION ALL
         SELECT 1
           FROM pg_proc object
           JOIN pg_namespace namespace ON namespace.oid = object.pronamespace
          WHERE namespace.nspname = 'public'
            AND starts_with(object.proname, 'sophia_voice_lab_d02_')
         UNION ALL
         SELECT 1
           FROM pg_trigger object
           JOIN pg_class relation ON relation.oid = object.tgrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND starts_with(object.tgname, 'sophia_voice_lab_d02_')
         UNION ALL
         SELECT 1
           FROM pg_constraint object
           JOIN pg_namespace namespace ON namespace.oid = object.connamespace
          WHERE namespace.nspname = 'public'
            AND starts_with(object.conname, 'sophia_voice_lab_d02_')
         UNION ALL
         SELECT 1
           FROM pg_rewrite object
           JOIN pg_class relation ON relation.oid = object.ev_class
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND starts_with(object.rulename, 'sophia_voice_lab_d02_')
       ) AS d02_footprint_free`,
  );
  const footprintRow = footprint.rows[0];
  if (d02AllAbsent && footprintRow?.d02_footprint_free !== true) {
    throw new Error('Voice Lab D02 schema is partial or unrecognized; refusing migration.');
  }
  if (
    coreExists.every((value) => value === false)
    && row?.cursors_exist === false
    && d02AllAbsent
  ) {
    if (allowFinalizeAuthorityRotation) {
      throw new Error('D02 finalize-authority rotation requires an existing current schema.');
    }
    if (footprintRow?.fresh_footprint_free !== true) {
      throw new Error('Voice Lab schema is partial or unrecognized; refusing migration.');
    }
    return;
  }
  if (!coreExists.every((value) => value === true)) {
    throw new Error('Voice Lab schema is partial or unrecognized; refusing migration.');
  }
  if (!d02AllExist && !d02AllAbsent) {
    throw new Error('Voice Lab D02 schema is partial or unrecognized; refusing migration.');
  }
  if (row?.cursors_exist === true) {
    if (d02AllExist) {
      await client.query(
        `LOCK TABLE
           public.sophia_voice_lab_auth_grants,
           public.sophia_voice_lab_cleanup_obligations,
           public.sophia_voice_lab_cleanup_admissions,
           public.sophia_voice_lab_cleanup_scan_cursors,
           public.sophia_voice_lab_d02_gateway_settlements,
           public.sophia_voice_lab_d02_gateway_capability_uses,
           public.sophia_voice_lab_d02_gateway_relay_leases,
           public.sophia_voice_lab_d02_product_continuity_observations,
           public.sophia_voice_lab_d02_gateway_finalize_authority,
           public."session",
           public.sophia_sessions,
           public.sophia_session_messages,
           public.artifact_registry_records
         IN ACCESS EXCLUSIVE MODE`,
      );
    } else {
      await client.query(
        `LOCK TABLE
           public.sophia_voice_lab_auth_grants,
           public.sophia_voice_lab_cleanup_obligations,
           public.sophia_voice_lab_cleanup_admissions,
           public.sophia_voice_lab_cleanup_scan_cursors,
           public."session",
           public.sophia_sessions,
           public.sophia_session_messages,
           public.artifact_registry_records
         IN ACCESS EXCLUSIVE MODE`,
      );
    }
    if (d02AllExist) {
      if (allowFinalizeAuthorityRotation) {
        try {
          await preflight(client, { allowFinalizeAuthorityValueMismatch: true });
        } catch (currentShapeError) {
          throw currentShapeError;
        }
        return assertD02FinalizeAuthorityRotationReady(client);
      }
      await preflight(client);
      return;
    }
    try {
      await preflight(client);
      return;
    } catch {
      // Only the single pinned predecessor may enter the upgrade transaction.
      // Its entire Voice Lab footprint must be empty while the governed tables
      // are locked, so no legacy reserved producer can still be allocating.
    }
  } else {
    await client.query(
      `LOCK TABLE
         public.sophia_voice_lab_auth_grants,
         public.sophia_voice_lab_cleanup_obligations,
         public.sophia_voice_lab_cleanup_admissions,
         public."session",
         public.sophia_sessions,
         public.sophia_session_messages,
         public.artifact_registry_records
      IN ACCESS EXCLUSIVE MODE`,
    );
  }
  if (row?.cursors_exist !== true || !d02AllAbsent) {
    throw new Error('Voice Lab schema is not the exact recognized predecessor.');
  }
  if (allowFinalizeAuthorityRotation) {
    throw new Error('D02 finalize-authority rotation cannot enter an upgrade lane.');
  }
  const prior = await client.query(
    `SELECT
       obj_description(
         'public.sophia_voice_lab_auth_grants'::regclass, 'pg_class'
       ) AS auth_comment,
       obj_description(
         'public.sophia_voice_lab_cleanup_obligations'::regclass, 'pg_class'
       ) AS obligations_comment,
       obj_description(
         'public.sophia_voice_lab_cleanup_admissions'::regclass, 'pg_class'
       ) AS admissions_comment,
       obj_description(
         'public.sophia_voice_lab_cleanup_scan_cursors'::regclass, 'pg_class'
       ) AS cursors_comment,
       NOT EXISTS (
         SELECT 1 FROM public.sophia_voice_lab_auth_grants
       ) AS auth_empty,
       NOT EXISTS (
         SELECT 1 FROM public.sophia_voice_lab_cleanup_obligations
       ) AS obligations_empty,
       NOT EXISTS (
         SELECT 1 FROM public.sophia_voice_lab_cleanup_admissions
       ) AS admissions_empty,
       (
         SELECT count(*) = 2
            AND array_agg(cursor_name ORDER BY cursor_name)
                = ARRAY['complete_purge_v1'::text, 'work_v1'::text]
            AND bool_and(
              cursor_due_at IS NULL
              AND cursor_source IS NULL
              AND cursor_cleanup_obligation_id IS NULL
              AND cursor_admission_id IS NULL
              AND window_due_at IS NULL
              AND window_source IS NULL
              AND window_cleanup_obligation_id IS NULL
              AND window_admission_id IS NULL
            )
           FROM public.sophia_voice_lab_cleanup_scan_cursors
       ) AS cursors_exact,
       NOT EXISTS (
         SELECT 1 FROM public.sophia_sessions
          WHERE metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true'
       ) AS sessions_empty,
       NOT EXISTS (
         SELECT 1 FROM public.sophia_session_messages AS message
          JOIN public.sophia_sessions AS session ON session.id = message.session_id
         WHERE session.metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true'
       ) AS messages_empty,
       NOT EXISTS (
         SELECT 1 FROM public.artifact_registry_records
          WHERE record_payload ->> 'synthetic_test' = 'true'
       ) AS artifacts_empty`,
  );
  const legacy = prior.rows[0];
  const priorAuthComment =
    `sophia.voice-lab.auth-ledger.v1 migration_sha256=${RECOGNIZED_PRIOR_MIGRATION_SHA256}`;
  const priorObligationsComment =
    `sophia.voice-lab.cleanup-obligation-state.v1 migration_sha256=${RECOGNIZED_PRIOR_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-control-only`;
  const priorAdmissionsComment =
    `sophia.voice-lab.cleanup-admission-state.v1 migration_sha256=${RECOGNIZED_PRIOR_CLEANUP_INDEX_MIGRATION_SHA256} content=bounded-opaque-resource-locator-no-principal-run-secret`;
  const priorCursorsComment =
    `sophia.voice-lab.cleanup-scan-cursor.v1 migration_sha256=${RECOGNIZED_PRIOR_CLEANUP_INDEX_MIGRATION_SHA256} content=opaque-control-keyset-only`;
  if (
    legacy?.auth_comment === priorAuthComment
    && row?.cursors_exist === true
    && d02AllAbsent
    && legacy?.obligations_comment === priorObligationsComment
    && legacy?.admissions_comment === priorAdmissionsComment
    && legacy?.cursors_comment === priorCursorsComment
    && legacy?.auth_empty === true
    && legacy?.obligations_empty === true
    && legacy?.admissions_empty === true
    && legacy?.cursors_exact === true
    && legacy?.sessions_empty === true
    && legacy?.messages_empty === true
    && legacy?.artifacts_empty === true
  ) return;
  throw new Error(
    'Voice Lab prior schema is not the exact quiescent recognized predecessor; '
      + 'remove all legacy grants, admissions, obligations, sessions, messages, and artifacts.',
  );
}

async function runLockedPreflight(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('sophia-voice-lab-schema-v1', 731945))",
    );
    await client.query(
      `LOCK TABLE
         public."session",
         public.sophia_voice_lab_auth_grants,
         public.sophia_voice_lab_cleanup_obligations,
         public.sophia_voice_lab_cleanup_admissions,
         public.sophia_voice_lab_cleanup_scan_cursors,
         public.sophia_voice_lab_d02_gateway_settlements,
         public.sophia_voice_lab_d02_gateway_capability_uses,
         public.sophia_voice_lab_d02_gateway_relay_leases,
         public.sophia_voice_lab_d02_product_continuity_observations,
         public.sophia_voice_lab_d02_gateway_finalize_authority,
         public.sophia_sessions,
         public.sophia_session_messages,
         public.artifact_registry_records
       IN ACCESS SHARE MODE`,
    );
    await preflight(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log(
    'Usage: node migrate-voice-lab-auth-ledger.mjs '
      + '[--apply [--rotate-d02-finalize-authority] | --verify-file-only]',
  );
  process.exit(0);
}
if ([...args].some((arg) => ![
  '--apply', '--verify-file-only', '--rotate-d02-finalize-authority',
].includes(arg))) {
  throw new Error('Unknown migration argument.');
}
if (
  args.has('--rotate-d02-finalize-authority')
  && !args.has('--apply')
) throw new Error('D02 finalize-authority rotation requires --apply.');

const [authSql, cleanupSql] = await Promise.all([
  loadPinnedMigration(
    AUTH_MIGRATION_PATH,
    EXPECTED_MIGRATION_SHA256,
    AUTH_HASH_PLACEHOLDER,
    'Voice Lab auth-ledger',
  ),
  loadPinnedMigration(
    CLEANUP_MIGRATION_PATH,
    EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256,
    CLEANUP_HASH_PLACEHOLDER,
    'Voice Lab cleanup-index',
    33,
  ),
]);
if (args.has('--verify-file-only')) {
  transactionBody(authSql, 'Voice Lab auth-ledger');
  transactionBody(cleanupSql, 'Voice Lab cleanup-index');
  console.log(
    `voice_lab_auth_ledger migration_sha256=${EXPECTED_MIGRATION_SHA256} `
      + `cleanup_index_migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} `
      + 'files_verified=true wrappers_verified=true',
  );
  process.exit(0);
}

expectedD02FinalizeAuthority = loadD02FinalizeAuthority();

const runtimeDatabaseUrl = process.env.BETTER_AUTH_DATABASE_URL;
const databaseUrl = process.env.SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL;
if (!runtimeDatabaseUrl || !databaseUrl) {
  throw new Error(
    'Voice Lab migration requires the restricted BETTER_AUTH_DATABASE_URL and '
      + 'a separate SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL owner DSN.',
  );
}
if (databaseIdentity(runtimeDatabaseUrl) !== databaseIdentity(databaseUrl)) {
  throw new Error(
    'Voice Lab runtime and migration database URLs must identify the same database.',
  );
}
if (!approvedDedicatedTestDatabase(databaseUrl)) {
  const expectedProjectRef = required('BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF').toLowerCase();
  if (projectRef(databaseUrl) !== expectedProjectRef) {
    throw new Error('Voice Lab auth-ledger migration target does not match the expected project.');
  }
}

const tls = resolveDatabaseTls({
  databaseUrl,
  modeRaw: process.env.BETTER_AUTH_DATABASE_SSL_MODE,
  caPemRaw: process.env.BETTER_AUTH_DATABASE_SSL_CA,
  environmentRaw:
    process.env.SOPHIA_VOICE_LAB_ENVIRONMENT ?? process.env.NODE_ENV,
});
const pool = new Pool({
  connectionString: tls.connectionString,
  max: 1,
  options: '-c search_path=pg_catalog,public,pg_temp',
  ...(tls.ssl === undefined ? {} : { ssl: tls.ssl }),
});
try {
  let rotatedFinalizeAuthorityFrom;
  if (args.has('--apply')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config(
                  'sophia.voice_lab_d02_finalize_hmac_key_id', $1, true
                ) IS NOT NULL
                AND set_config(
                  'sophia.voice_lab_d02_finalize_hmac_secret', $2, true
                ) IS NOT NULL AS configured`,
        [
          expectedD02FinalizeAuthority.keyId,
          expectedD02FinalizeAuthority.secret,
        ],
      );
      rotatedFinalizeAuthorityFrom = await assertFreshOrExactlyCurrentShape(client, {
        allowFinalizeAuthorityRotation: args.has('--rotate-d02-finalize-authority'),
      });
      await client.query(transactionBody(authSql, 'Voice Lab auth-ledger'));
      await client.query(transactionBody(cleanupSql, 'Voice Lab cleanup-index'));
      await preflight(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  await runLockedPreflight(pool);
  console.log(
    `voice_lab_auth_ledger mode=${args.has('--apply') ? 'apply' : 'preflight'} `
      + `migration_sha256=${EXPECTED_MIGRATION_SHA256} `
      + `cleanup_index_migration_sha256=${EXPECTED_CLEANUP_INDEX_MIGRATION_SHA256} ready=true`
      + (rotatedFinalizeAuthorityFrom
        ? ` finalize_authority_rotated_from=${rotatedFinalizeAuthorityFrom}`
          + ` finalize_authority_rotated_to=${expectedD02FinalizeAuthority.keyId}`
        : ''),
  );
} finally {
  await pool.end();
}
