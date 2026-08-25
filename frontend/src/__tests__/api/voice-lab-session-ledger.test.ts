import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceLabCapabilityClaims } from '../../server/voice-lab/capability';

type Row = { token: string; expiresAt: Date; userAgent: string | null };
type GrantRow = {
  grant_fingerprint: string;
  principal_id: string;
  test_run_id: string;
  tombstone_kid: string;
  cleanup_obligation_id: string;
  issued_at: number;
  expires_at: Date;
  provider_expires_at: Date;
  retention_hours: number;
  jti_sha256: string;
  nonce_sha256: string;
  session_token_sha256: string;
  status: 'active' | 'revoked';
};
type CleanupObligationRow = {
  cleanup_obligation_id: string;
  state: 'open' | 'closed' | 'complete';
  lifecycle_phase: 'auth_provisional' | 'session_provisional' | 'finalized';
  retention_expires_at: Date;
  provider_expires_at: Date;
};

const database = vi.hoisted(() => {
  const rows: Row[] = [];
  const grants: GrantRow[] = [];
  const obligations: CleanupObligationRow[] = [];
  const faults = {
    suppressSessionInsert: false,
    suppressSessionDelete: false,
  };
  const preflight = {
    columns: [
      ['grant_fingerprint', 'bpchar', 'NO'],
      ['principal_id', 'text', 'NO'],
      ['test_run_id', 'text', 'NO'],
      ['tombstone_kid', 'text', 'NO'],
      ['cleanup_obligation_id', 'text', 'NO'],
      ['issued_at', 'int8', 'NO'],
      ['expires_at', 'timestamptz', 'NO'],
      ['provider_expires_at', 'timestamptz', 'NO'],
      ['retention_hours', 'int4', 'NO'],
      ['jti_sha256', 'bpchar', 'NO'],
      ['nonce_sha256', 'bpchar', 'NO'],
      ['session_token_sha256', 'bpchar', 'NO'],
      ['status', 'text', 'NO'],
      ['created_at', 'timestamptz', 'NO'],
      ['revoked_at', 'timestamptz', 'YES'],
    ].map(([column_name, udt_name, is_nullable]) => ({
      column_name,
      udt_name,
      is_nullable,
      column_default: column_name === 'created_at' ? 'now()' : null,
      character_maximum_length: udt_name === 'bpchar' ? 64 : null,
      is_generated: 'NEVER',
      is_identity: 'NO',
    })),
    indexes: [
      ['sophia_voice_lab_auth_grants_pkey', true, ['grant_fingerprint'], [0], null],
      ['sophia_voice_lab_auth_grants_principal_order_idx', false, ['principal_id', 'issued_at'], [0, 3], null],
      ['sophia_voice_lab_auth_grants_expiry_idx', false, ['expires_at'], [0], null],
      ['sophia_voice_lab_auth_grants_cleanup_obligation_idx', false, ['cleanup_obligation_id'], [0], null],
      ['sophia_voice_lab_auth_grants_tombstone_kid_expiry_idx', false, ['tombstone_kid', 'expires_at'], [0, 0], null],
      ['sophia_voice_lab_auth_grants_active_cleanup_idx', true, ['cleanup_obligation_id'], [0], "status = 'active'::text"],
    ].map(([indexname, indisunique, key_expressions, key_options, predicate]) => ({
      indexname,
      tablename: 'sophia_voice_lab_auth_grants',
      indisunique,
      indisvalid: true,
      indisready: true,
      index_relpersistence: 'p',
      amname: 'btree',
      indnkeyatts: (key_expressions as string[]).length,
      key_expressions,
      key_options,
      predicate,
      index_comment: null,
    })),
    constraints: [
      ['sophia_voice_lab_auth_grants_pkey', 'p', 'PRIMARY KEY (grant_fingerprint)'],
      ['sophia_voice_lab_auth_grants_grant_fingerprint_check', 'c', "CHECK (grant_fingerprint ~ '^[a-f0-9]{64}$'::text)"],
      ['sophia_voice_lab_auth_grants_tombstone_kid_check', 'c', "CHECK (tombstone_kid ~ '^[A-Za-z0-9._-]{1,32}$'::text)"],
      ['sophia_voice_lab_auth_grants_cleanup_obligation_check', 'c', "CHECK (cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text OR cleanup_obligation_id ~ '^hmac:[A-Za-z0-9._-]{1,32}:[a-f0-9]{64}$'::text)"],
      ['sophia_voice_lab_auth_grants_retention_hours_check', 'c', 'CHECK (retention_hours >= 1 AND retention_hours <= 168)'],
      ['sophia_voice_lab_auth_grants_jti_sha256_check', 'c', "CHECK (jti_sha256 ~ '^[a-f0-9]{64}$'::text)"],
      ['sophia_voice_lab_auth_grants_nonce_sha256_check', 'c', "CHECK (nonce_sha256 ~ '^[a-f0-9]{64}$'::text)"],
      ['sophia_voice_lab_auth_grants_session_token_sha256_check', 'c', "CHECK (session_token_sha256 ~ '^[a-f0-9]{64}$'::text)"],
      ['sophia_voice_lab_auth_grants_status_check', 'c', "CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text]))"],
    ].map(([conname, contype, definition]) => ({
      conname, contype, definition, convalidated: true,
    })),
    privileges: [{
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      owner_matches_control: true,
      owner_is_expected: true,
      relkind: 'r',
      relpersistence: 'p',
      relispartition: false,
      inheritance_free: true,
      rewrite_free: true,
      relrowsecurity: false,
      relforcerowsecurity: false,
      unexpected_acl: false,
      unexpected_column_acl: false,
    }],
    unsafeGrants: [] as Array<{ grantee: string; privilege_type: string }>,
    unsafeEffectiveTablePrivileges: [] as Array<{ role_name: string; table_name: string }>,
    metadata: [{
      table_comment: 'sophia.voice-lab.auth-ledger.v1 migration_sha256=42e6f2b3bf083675bcdd7b2f29c66b400c6fca9771b76f866e6c55f8513b514c',
    }],
    cleanupIndexes: [
      {
        indexname: 'sophia_sessions_voice_lab_cleanup_obligation_idx',
        tablename: 'sophia_sessions',
        indisunique: true,
        indisvalid: true,
        indisready: true,
        index_relpersistence: 'p',
        amname: 'btree',
        indnkeyatts: 1,
        key_expressions: ["metadata -> 'synthetic_voice_lab' ->> 'cleanup_obligation_id'"],
        key_options: [0],
        predicate: "metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true' AND metadata -> 'synthetic_voice_lab' ->> 'cleanup_obligation_id' IS NOT NULL",
        index_comment: 'sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 resource=sessions',
      },
      {
        indexname: 'artifact_registry_voice_lab_cleanup_obligation_idx',
        tablename: 'artifact_registry_records',
        indisunique: false,
        indisvalid: true,
        indisready: true,
        index_relpersistence: 'p',
        amname: 'btree',
        indnkeyatts: 2,
        key_expressions: ["record_payload ->> 'cleanup_obligation_id'", 'artifact_id'],
        key_options: [0, 0],
        predicate: "record_payload ->> 'synthetic_test' = 'true' AND record_payload ->> 'cleanup_obligation_id' IS NOT NULL",
        index_comment: 'sophia.voice-lab.cleanup-obligation-index.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 resource=artifacts',
      },
    ],
    cleanupTriggers: [
      ['sophia_voice_lab_cleanup_write_fence', 'sophia_sessions', 'sophia_voice_lab_cleanup_write_fence', 'cleanup-obligation-write-fence'],
      ['sophia_voice_lab_message_write_fence', 'sophia_session_messages', 'sophia_voice_lab_message_write_fence', 'cleanup-obligation-message-write-fence'],
      ['artifact_registry_voice_lab_cleanup_write_fence', 'artifact_registry_records', 'sophia_voice_lab_cleanup_write_fence', 'cleanup-obligation-write-fence'],
      ['sophia_voice_lab_auth_cleanup_write_fence', 'sophia_voice_lab_auth_grants', 'sophia_voice_lab_cleanup_write_fence', 'cleanup-obligation-write-fence'],
    ].map(([tgname, tablename, proname, commentKind]) => {
      const messageFence = proname === 'sophia_voice_lab_message_write_fence';
      return {
        tgname,
        tablename,
        tgenabled: 'O',
        trigger_definition: `CREATE TRIGGER ${tgname} BEFORE INSERT OR DELETE OR UPDATE ON ${tablename} FOR EACH ROW EXECUTE FUNCTION ${proname}()`,
        proname,
        prosecdef: true,
        provolatile: 'v',
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
        lanname: 'plpgsql',
        owner_matches_control: true,
        owner_is_expected: true,
        function_schema: 'public',
        function_is_public_identity: true,
        prosrc: messageFence ? [
          'pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944));',
          'synthetic transcript parent binding is immutable;',
          "obligation_phase not in ('session_provisional', 'finalizing');",
          'clock_timestamp() >= obligation_retention;',
          'synthetic transcript retention deletion is unavailable;',
        ].join(' ') : [
          'pg_advisory_xact_lock(hashtextextended(cleanup_id, 731944));',
          'clock_timestamp() >= retention_deadline;',
          'synthetic session signed binding is immutable;',
          'synthetic artifact signed binding is immutable;',
          'synthetic auth tombstone transition is invalid;',
          'synthetic auth tombstone deletion is invalid;',
        ].join(' '),
        function_comment: `sophia.voice-lab.${commentKind}.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44`,
      };
    }),
    unsafeFenceGrants: [] as Array<{ grantee: string; privilege_type: string }>,
    cleanupFunctions: [
      ['sophia_voice_lab_receipt_part', 'p_value text', 'sql', 'i', false, ['search_path=pg_catalog, public, pg_temp'], false, '6185006f17eaf4c24c241968d2c9f94baeea014088c20832c22c61c06853c4bd'],
      ['sophia_voice_lab_finalization_receipt_sha256', 'p_user_id text, p_session_id text, p_thread_id text, p_synthetic jsonb, p_expected_deployment jsonb, p_finalized_at text, p_retention_hours integer, p_retention_expires_at text, p_provider_expires_at text, p_message_revision bigint, p_message_count integer, p_transcript_sha256 text, p_started_at text, p_turn_count integer, p_capability_jti_sha256 text, p_object_path text', 'sql', 'i', false, ['search_path=pg_catalog, public, pg_temp'], false, '92b94e6c4c49d47968d179e81375b5825119d6ebd10e084214a99f4df47867ec'],
      ['sophia_finalize_voice_lab_session', 'p_user_id text, p_session_id text, p_expected_revision bigint, p_cleanup_obligation_id text, p_provider_expires_at text, p_retention_hours integer, p_expected_synthetic_binding jsonb, p_expected_deployment jsonb, p_message_metadata_base jsonb, p_canonical_transcript_sha256 text, p_canonical_transcript_json text, p_finalization_started_at text, p_turn_count integer, p_capability_jti_sha256 text, p_messages jsonb', 'plpgsql', 'v', true, ['search_path=pg_catalog, public, pg_temp'], true, '6c74d0646932e6cc32809f6d0c432f0b231dd9d89c7336fb92d8f6ff67c622c3'],
      ['sophia_purge_voice_lab_session', 'p_user_id text, p_session_id text, p_cleanup_obligation_id text, p_retention_expires_at text, p_provider_expires_at text', 'plpgsql', 'v', true, ['search_path=pg_catalog, public, pg_temp'], true, '1e001f8ff64cd06ec9cd2e78d509c1d290469ce7816b57ce6695b071ea48f3c3'],
      ['sophia_voice_lab_cleanup_write_fence', '', 'plpgsql', 'v', true, ['search_path=pg_catalog, public, pg_temp'], false, '4faacbb98b20ee4e955ae8343e55c163060f9963104c384dadb1263249d28fad'],
      ['sophia_voice_lab_message_write_fence', '', 'plpgsql', 'v', true, ['search_path=pg_catalog, public, pg_temp'], false, '11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3'],
    ].map(([
      proname, identity_arguments, lanname, provolatile, prosecdef, proconfig,
      service_can_execute, source_sha256,
    ]) => ({
      proname,
      identity_arguments,
      result_type: proname === 'sophia_finalize_voice_lab_session'
        ? 'jsonb'
        : proname === 'sophia_purge_voice_lab_session' ? 'boolean'
        : String(proname).endsWith('_write_fence') ? 'trigger' : 'text',
      pronargdefaults: 0,
      proargmodes: null,
      prokind: 'f',
      proretset: false,
      proisstrict: false,
      proleakproof: false,
      proparallel: lanname === 'sql' ? 's' : 'u',
      lanname,
      provolatile,
      prosecdef,
      proconfig,
      owner_matches_control: true,
      owner_is_expected: true,
      public_can_execute: false,
      anon_can_execute: false,
      authenticated_can_execute: false,
      service_can_execute,
      gateway_can_execute: false,
      runtime_can_execute: false,
      source_sha256,
      function_comment: null,
      unexpected_execute_acl: false,
      service_execute_grantable: false,
      gateway_execute_grantable: false,
      runtime_execute_grantable: false,
    })).concat(([
      ['sophia_voice_lab_d02_browser_settlement', 'p_metadata jsonb, p_provider_session_id text', 'jsonb', 'plpgsql', 's', false, true, 's', 'f3e3bc3c27e9d5e28f3e206ebd2230b419463ca117acc024356cec64149b5ffa', false, 'browser-settlement', 'owner-internal'],
      ['sophia_voice_lab_d02_canonical_json', 'p_value jsonb', 'text', 'plpgsql', 'i', false, true, 's', '070913f32577512228d6e87368a7291c378532bb03c181ff4e2fca7f2780cb06', false, 'canonical-json', 'owner-internal'],
      ['sophia_voice_lab_d02_continuity_authorize', 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_observed_at timestamp with time zone', 'jsonb', 'plpgsql', 'v', true, false, 'u', '14b4fc34cf9bf60c66e307c32e8943c1e421197a0633a4486fbf4392901acc56', true, 'continuity-authorize', 'gateway-execute'],
      ['sophia_voice_lab_d02_continuity_finalize', 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_product_service_boot_id_sha256 text, p_render_action_request_sha256 text, p_prior_observation_receipt_sha256 text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', '591c5cf7b4fd1af27a0acc9780e1cb95c99209d22c3910b03a0dd4f59881c8f8', true, 'continuity-finalize', 'gateway-execute-hmac'],
      ['sophia_voice_lab_d02_finalize_authority_ready', 'p_authority_key_id text, p_authority_secret_sha256 text', 'boolean', 'sql', 's', true, true, 's', 'ce3cfd8a1859c1e703927a3cc907628e6e147563029513354ae9e9ea932c5bf4', true, 'authority-ready', 'gateway-readback'],
      ['sophia_voice_lab_d02_finalize_proof_valid', 'p_authority_key_id text, p_domain text, p_parts jsonb, p_value jsonb, p_proof_sha256 text', 'boolean', 'plpgsql', 's', true, true, 'r', 'fd637099a2e026380dd1b4017b8a341811fb9cf6bc58c4ee41c077e8472f9c97', false, 'finalize-proof-valid', 'owner-internal'],
      ['sophia_voice_lab_d02_freeze_authorize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', '60d23be11556efb20fb0290c05be5987808ea978ed82a8b3b4bb9f46c175c020', true, 'freeze-authorize', 'gateway-execute'],
      ['sophia_voice_lab_d02_freeze_finalize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_freeze_binding jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', 'de3f91905416587285ee54f0f15a8fee7e99bece48999001e7ec9690539e5d4d', true, 'freeze-finalize', 'gateway-execute-hmac'],
      ['sophia_voice_lab_d02_hmac_sha256', 'p_key bytea, p_data bytea', 'bytea', 'plpgsql', 'i', false, true, 's', '03b16bf3f6ce33e09cbb9445f6afe8c343caeaf3fae11cfa526fa7ac641fd3c9', false, 'hmac-sha256', 'owner-internal'],
      ['sophia_voice_lab_d02_producer_open', 'p_cleanup_obligation_id text', 'boolean', 'plpgsql', 'v', true, false, 'u', '4db750471171dba20a1c71e3a6f73505efca17c93226820129b91c59f183e8a3', true, 'producer-open', 'gateway-readback'],
      ['sophia_voice_lab_d02_provider_freeze', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text', 'jsonb', 'plpgsql', 's', true, false, 'u', 'da2c68d664005bc5b630599d6297a3a233a61763975c63344986b6e1c628ac9c', true, 'provider-freeze', 'gateway-readback'],
      ['sophia_voice_lab_d02_register_capability_use', 'p_capability_jti_sha256 text, p_operation text, p_request_sha256 text, p_cleanup_obligation_id text, p_request_id_sha256 text', 'boolean', 'sql', 'v', false, false, 'u', 'b964d9481272417056bf53ed7f8864a67071bc0567f627477a4b73f4e6fd4b80', false, 'capability-use', 'owner-internal'],
      ['sophia_voice_lab_d02_register_capability_use_state', 'p_capability_jti_sha256 text, p_operation text, p_request_sha256 text, p_cleanup_obligation_id text, p_request_id_sha256 text', 'text', 'plpgsql', 'v', false, false, 'u', '810a45a17e5a3b934a6ef0b7cddb36ffe46ea83da6725d2f2839748b5253255c', false, 'capability-state', 'owner-internal'],
      ['sophia_voice_lab_d02_relay_begin', 'p_relay_id uuid, p_cleanup_obligation_id text, p_provider_session_id text, p_provider_connection_epoch integer, p_relay_kind text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_authority_key_id text, p_operation_proof_sha256 text', 'boolean', 'plpgsql', 'v', true, false, 'u', '7d5677b2c65e11531338bcc4af05672ad9fc3787986d0fa4365a7652029c3b6e', true, 'relay-begin', 'gateway-execute-hmac'],
      ['sophia_voice_lab_d02_relay_end', 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text', 'boolean', 'plpgsql', 'v', true, false, 'u', 'bf089f4e5e55667b9b7902ad5ec4afe5e7c27ceacf0fe9a9ee3ec8accb3f9774', true, 'relay-end', 'gateway-execute-hmac'],
      ['sophia_voice_lab_d02_relay_refresh', 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text', 'boolean', 'plpgsql', 'v', true, false, 'u', '8d6a271cc20516fd476ee56adad82e18094e4fdb4cb0aba467e1eeb83a3a1e0c', true, 'relay-refresh', 'gateway-execute-hmac'],
      ['sophia_voice_lab_d02_settlement_authorize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', '06980b6cd70094490d5461c00a22b738f83c5c6cd4b9ba0b6a56cc9d33ff84f9', true, 'settlement-authorize', 'gateway-execute'],
      ['sophia_voice_lab_d02_settlement_finalize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_provider_settlement_sha256 text, p_next_metadata jsonb, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', 'a96754002d924205727f17629fba51c3633b4543954a7e827c724467b88a0096', true, 'settlement-finalize', 'gateway-execute-hmac'],
      ['sophia_voice_lab_d02_sources_zero', 'p_cleanup_obligation_id text', 'boolean', 'sql', 's', true, false, 'u', '8c8dd393f5a61e9e0a3b165904b417065a877fd1f5b7485d2a7d8b064e669ccb', true, 'sources-zero', 'gateway-runtime-readback'],
      ['sophia_voice_lab_d02_voice_terminal_authorize', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text', 'jsonb', 'plpgsql', 'v', true, false, 'u', '9c094510a8ff27a0fd36ef94922b56746249d72284c5441e61787d5a76c278aa', true, 'voice-terminal-authorize', 'gateway-execute'],
      ['sophia_voice_lab_d02_voice_terminal_finalize', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text', 'jsonb', 'plpgsql', 'v', true, false, 'u', 'e62bc88c1142478da159500d241ce22e89d8cbbfbcbeb074556228de4d844d80', true, 'voice-terminal-finalize', 'gateway-execute-hmac'],
    ] as const).map(([
      proname, identity_arguments, result_type, lanname, provolatile,
      prosecdef, proisstrict, proparallel, source_sha256,
      gateway_can_execute, operation, exposure,
    ]) => ({
      proname,
      identity_arguments,
      result_type,
      pronargdefaults: 0,
      proargmodes: null,
      prokind: 'f',
      proretset: false,
      proisstrict,
      proleakproof: false,
      proparallel,
      lanname,
      provolatile,
      prosecdef,
      proconfig: ['search_path=pg_catalog, public, pg_temp'],
      owner_matches_control: true,
      owner_is_expected: true,
      public_can_execute: false,
      anon_can_execute: false,
      authenticated_can_execute: false,
      service_can_execute: false,
      gateway_can_execute,
      runtime_can_execute: proname === 'sophia_voice_lab_d02_sources_zero',
      source_sha256,
      function_comment:
        `sophia.voice-lab.d02-database-rpc.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 `
        + `operation=${operation} exposure=${exposure}`,
      unexpected_execute_acl: false,
      service_execute_grantable: false,
      gateway_execute_grantable: false,
      runtime_execute_grantable: false,
    }))),
    productColumns: [
      ['sophia_sessions', 'id', 'text', 'NO'],
      ['sophia_sessions', 'user_id', 'text', 'NO'],
      ['sophia_sessions', 'thread_id', 'text', 'NO'],
      ['sophia_sessions', 'run_id', 'text', 'YES'],
      ['sophia_sessions', 'mode', 'text', 'NO'],
      ['sophia_sessions', 'metadata', 'jsonb', 'NO'],
      ['sophia_sessions', 'status', 'text', 'NO'],
      ['sophia_sessions', 'ended_at', 'timestamptz', 'YES'],
      ['sophia_sessions', 'message_revision', 'int8', 'NO'],
      ['sophia_sessions', 'message_count', 'int4', 'NO'],
      ['sophia_sessions', 'transcript_available', 'bool', 'NO'],
      ['sophia_sessions', 'created_at', 'timestamptz', 'NO'],
      ['sophia_sessions', 'updated_at', 'timestamptz', 'NO'],
      ['sophia_session_messages', 'id', 'text', 'NO'],
      ['sophia_session_messages', 'message_id', 'text', 'NO'],
      ['sophia_session_messages', 'session_id', 'text', 'NO'],
      ['sophia_session_messages', 'user_id', 'text', 'NO'],
      ['sophia_session_messages', 'thread_id', 'text', 'NO'],
      ['sophia_session_messages', 'role', 'text', 'NO'],
      ['sophia_session_messages', 'content', 'text', 'NO'],
      ['sophia_session_messages', 'source', 'text', 'NO'],
      ['sophia_session_messages', 'final', 'bool', 'NO'],
      ['sophia_session_messages', 'approximate', 'bool', 'NO'],
      ['sophia_session_messages', 'turn_id', 'text', 'YES'],
      ['sophia_session_messages', 'provider_event_id', 'text', 'YES'],
      ['sophia_session_messages', 'sequence', 'int4', 'NO'],
      ['sophia_session_messages', 'created_at', 'timestamptz', 'NO'],
      ['sophia_session_messages', 'metadata', 'jsonb', 'NO'],
      ['artifact_registry_records', 'artifact_id', 'text', 'NO'],
      ['artifact_registry_records', 'record_payload', 'jsonb', 'NO'],
    ].map(([table_name, column_name, udt_name, is_nullable]) => ({
      table_name,
      column_name,
      udt_name,
      is_nullable,
      character_maximum_length: null,
      is_generated: 'NEVER',
      is_identity: 'NO',
      relkind: 'r',
      relpersistence: 'p',
      relrowsecurity: false,
      relforcerowsecurity: false,
    })),
    productPrivileges: [
      'sophia_sessions',
      'sophia_session_messages',
      'artifact_registry_records',
    ].map((table_name) => ({
      table_name,
      can_select: table_name === 'sophia_sessions',
      can_insert: false,
      can_update: table_name === 'sophia_sessions',
      can_delete: false,
      owner_matches_control: true,
      owner_is_expected: true,
      service_can_mutate: true,
      service_has_unsafe: false,
      anon_can_access: false,
      authenticated_can_access: false,
      relispartition: false,
      inheritance_free: true,
      rewrite_free: true,
      unexpected_acl: false,
      unexpected_column_acl: false,
    })),
    productUnsafeGrants: [] as Array<{
      table_name: string; grantee: string; privilege_type: string;
    }>,
    sessionMessagesForeignKey: [{
      oid: 1,
      conname: 'sophia_session_messages_session_id_fkey',
      convalidated: true,
      condeferrable: false,
      condeferred: false,
      definition: 'FOREIGN KEY (session_id) REFERENCES sophia_sessions(id) ON DELETE CASCADE',
    }],
    sessionMessagesForeignKeyTriggers: [
      ['sophia_session_messages', 'RI_FKey_check_ins'],
      ['sophia_session_messages', 'RI_FKey_check_upd'],
      ['sophia_sessions', 'RI_FKey_cascade_del'],
      ['sophia_sessions', 'RI_FKey_noaction_upd'],
    ].map(([tablename, proname]) => ({
      tablename,
      proname,
      tgenabled: 'O',
      tgisinternal: true,
    })),
    cleanupAdmissionsForeignKeyTriggers: [
      ['sophia_voice_lab_cleanup_admissions', 'RI_FKey_check_ins'],
      ['sophia_voice_lab_cleanup_admissions', 'RI_FKey_check_upd'],
      ['sophia_voice_lab_cleanup_obligations', 'RI_FKey_noaction_del'],
      ['sophia_voice_lab_cleanup_obligations', 'RI_FKey_noaction_upd'],
    ].map(([tablename, proname]) => ({
      tablename,
      proname,
      tgenabled: 'O',
      tgisinternal: true,
    })),
    productPrimaryKeys: [
      ['sophia_sessions', 'sophia_sessions_pkey', 'PRIMARY KEY (id)'],
      ['sophia_session_messages', 'sophia_session_messages_pkey', 'PRIMARY KEY (id)'],
      ['artifact_registry_records', 'artifact_registry_records_pkey', 'PRIMARY KEY (artifact_id)'],
    ].map(([tablename, conname, definition]) => ({
      tablename,
      conname,
      definition,
      convalidated: true,
      condeferrable: false,
      condeferred: false,
      indisunique: true,
      indisvalid: true,
      indisready: true,
      index_relpersistence: 'p',
      amname: 'btree',
    })),
    betterAuthSessionColumns: [
      ['id', 'text', 'NO'],
      ['expiresAt', 'timestamptz', 'NO'],
      ['token', 'text', 'NO'],
      ['createdAt', 'timestamptz', 'NO'],
      ['updatedAt', 'timestamptz', 'NO'],
      ['ipAddress', 'text', 'YES'],
      ['userAgent', 'text', 'YES'],
      ['userId', 'text', 'NO'],
    ].map(([column_name, udt_name, is_nullable]) => ({
      column_name,
      udt_name,
      is_nullable,
      character_maximum_length: null,
      is_generated: 'NEVER',
      is_identity: 'NO',
    })),
    betterAuthSessionIndexes: [
      ['session_pkey', true, ['id']],
      ['session_token_key', true, ['token']],
      ['session_userId_idx', false, ['"userId"']],
    ].map(([indexname, indisunique, key_expressions]) => ({
      indexname,
      tablename: 'session',
      indisunique,
      indisvalid: true,
      indisready: true,
      indnkeyatts: (key_expressions as string[]).length,
      index_relpersistence: 'p',
      amname: 'btree',
      key_expressions,
      key_options: (key_expressions as string[]).map(() => 0),
      predicate: null,
      index_comment: null,
    })),
    betterAuthSessionConstraints: [
      ['session_pkey', 'p', 'PRIMARY KEY (id)'],
      ['session_token_key', 'u', 'UNIQUE (token)'],
    ].map(([conname, contype, definition]) => ({
      conname,
      contype,
      definition,
      convalidated: true,
      condeferrable: false,
      condeferred: false,
    })),
    betterAuthSessionRelation: [{
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      owner_matches_control: true,
      owner_is_expected: true,
      relkind: 'r',
      relpersistence: 'p',
      relispartition: false,
      inheritance_free: true,
      rewrite_free: true,
      relrowsecurity: false,
      relforcerowsecurity: false,
      unexpected_acl: false,
      unexpected_column_acl: false,
      public_can_access: false,
      anon_can_access: false,
      authenticated_can_access: false,
      service_can_access: false,
    }],
    cleanupControlColumns: [
      ['sophia_voice_lab_cleanup_obligations', 'cleanup_obligation_id', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'state', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'lifecycle_phase', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'retention_expires_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'provider_expires_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'provider_settlement_sha256', 'text', 'YES'],
      ['sophia_voice_lab_cleanup_obligations', 'created_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'updated_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_obligations', 'closed_at', 'timestamptz', 'YES'],
      ['sophia_voice_lab_cleanup_obligations', 'live_cleanup_completed_at', 'timestamptz', 'YES'],
      ['sophia_voice_lab_cleanup_obligations', 'completed_at', 'timestamptz', 'YES'],
      ['sophia_voice_lab_cleanup_obligations', 'purge_after', 'timestamptz', 'YES'],
      ['sophia_voice_lab_cleanup_admissions', 'admission_id', 'uuid', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'cleanup_obligation_id', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'resource_kind', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'resource_id', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'status', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'lease_expires_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'resource_expires_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'created_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_admissions', 'updated_at', 'timestamptz', 'NO'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'cursor_name', 'text', 'NO'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'cursor_due_at', 'timestamptz', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'cursor_source', 'text', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'cursor_cleanup_obligation_id', 'text', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'cursor_admission_id', 'uuid', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'window_due_at', 'timestamptz', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'window_source', 'text', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'window_cleanup_obligation_id', 'text', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'window_admission_id', 'uuid', 'YES'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'updated_at', 'timestamptz', 'NO'],
    ].map(([table_name, column_name, udt_name, is_nullable]) => ({
      table_name,
      column_name,
      udt_name,
      is_nullable,
      column_default: ({
        'sophia_voice_lab_cleanup_obligations.state': "'open'::text",
        'sophia_voice_lab_cleanup_obligations.lifecycle_phase': "'auth_provisional'::text",
        'sophia_voice_lab_cleanup_obligations.created_at': 'clock_timestamp()',
        'sophia_voice_lab_cleanup_obligations.updated_at': 'clock_timestamp()',
        'sophia_voice_lab_cleanup_admissions.status': "'reserved'::text",
        'sophia_voice_lab_cleanup_admissions.created_at': 'clock_timestamp()',
        'sophia_voice_lab_cleanup_admissions.updated_at': 'clock_timestamp()',
        'sophia_voice_lab_cleanup_scan_cursors.updated_at': 'clock_timestamp()',
      } as Record<string, string>)[`${table_name}.${column_name}`] ?? null,
      character_maximum_length: null,
      is_generated: 'NEVER',
      is_identity: 'NO',
    })),
    cleanupControlIndexes: [
      ['sophia_voice_lab_cleanup_obligations_pkey', 'sophia_voice_lab_cleanup_obligations', true, ['cleanup_obligation_id'], [0], null],
      ['sophia_voice_lab_cleanup_obligations_purge_idx', 'sophia_voice_lab_cleanup_obligations', false, ['purge_after', 'cleanup_obligation_id'], [0, 0], "state = 'complete'::text"],
      ['sophia_voice_lab_cleanup_admissions_pkey', 'sophia_voice_lab_cleanup_admissions', true, ['admission_id'], [0], null],
      ['sophia_voice_lab_cleanup_admissions_obligation_idx', 'sophia_voice_lab_cleanup_admissions', false, ['cleanup_obligation_id', 'lease_expires_at', 'admission_id'], [0, 0, 0], null],
      ['sophia_voice_lab_cleanup_admissions_expiry_idx', 'sophia_voice_lab_cleanup_admissions', false, ['lease_expires_at', 'cleanup_obligation_id', 'admission_id'], [0, 0, 0], null],
      ['sophia_voice_lab_cleanup_admissions_single_provider_idx', 'sophia_voice_lab_cleanup_admissions', true, ['cleanup_obligation_id'], [0], "resource_kind = 'provider'::text"],
      ['sophia_voice_lab_cleanup_obligations_work_idx', 'sophia_voice_lab_cleanup_obligations', false, ["CASE WHEN state = 'closed'::text AND live_cleanup_completed_at IS NULL THEN closed_at WHEN state = 'closed'::text THEN retention_expires_at ELSE provider_expires_at END", 'cleanup_obligation_id'], [0, 0], "state <> 'complete'::text"],
      ['sophia_voice_lab_cleanup_scan_cursors_pkey', 'sophia_voice_lab_cleanup_scan_cursors', true, ['cursor_name'], [0], null],
    ].map(([indexname, tablename, indisunique, key_expressions, key_options, predicate]) => ({
      indexname,
      tablename,
      indisunique,
      indisvalid: true,
      indisready: true,
      index_relpersistence: 'p',
      amname: 'btree',
      indnkeyatts: (key_expressions as string[]).length,
      key_expressions,
      key_options,
      predicate,
      index_comment: null,
    })),
    cleanupControlConstraints: [
      ['sophia_voice_lab_cleanup_obligations', 'sophia_voice_lab_cleanup_obligations_pkey', 'p', 'PRIMARY KEY (cleanup_obligation_id)'],
      ['sophia_voice_lab_cleanup_obligations', 'sophia_voice_lab_cleanup_obligation_id_valid', 'c', "CHECK (cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)"],
      ['sophia_voice_lab_cleanup_obligations', 'sophia_voice_lab_cleanup_obligation_state_valid', 'c', "CHECK (state = ANY (ARRAY['open'::text, 'closed'::text, 'complete'::text]))"],
      ['sophia_voice_lab_cleanup_obligations', 'sophia_voice_lab_cleanup_obligation_phase_valid', 'c', "CHECK ((lifecycle_phase = ANY (ARRAY['auth_provisional'::text, 'session_provisional'::text, 'finalizing'::text, 'finalized'::text])) AND (lifecycle_phase <> 'auth_provisional'::text OR retention_expires_at = provider_expires_at) AND (lifecycle_phase <> 'finalizing'::text OR state = 'open'::text) AND (lifecycle_phase <> 'finalized'::text OR (state = ANY (ARRAY['closed'::text, 'complete'::text]))))"],
      ['sophia_voice_lab_cleanup_obligations', 'sophia_voice_lab_cleanup_obligation_lifecycle_valid', 'c', "CHECK (updated_at >= created_at AND provider_expires_at <= retention_expires_at AND (provider_settlement_sha256 IS NULL OR provider_settlement_sha256 ~ '^[a-f0-9]{64}$'::text) AND (live_cleanup_completed_at IS NULL OR updated_at >= live_cleanup_completed_at) AND (state = 'open'::text AND closed_at IS NULL AND live_cleanup_completed_at IS NULL AND completed_at IS NULL AND purge_after IS NULL OR state = 'closed'::text AND closed_at IS NOT NULL AND closed_at >= created_at AND (live_cleanup_completed_at IS NULL OR live_cleanup_completed_at >= closed_at) AND completed_at IS NULL AND purge_after IS NULL OR state = 'complete'::text AND closed_at IS NOT NULL AND live_cleanup_completed_at IS NOT NULL AND live_cleanup_completed_at >= closed_at AND completed_at IS NOT NULL AND completed_at >= live_cleanup_completed_at AND purge_after IS NOT NULL AND purge_after >= (retention_expires_at + '00:10:00'::interval)))"],
      ['sophia_voice_lab_cleanup_admissions', 'sophia_voice_lab_cleanup_admissions_pkey', 'p', 'PRIMARY KEY (admission_id)'],
      ['sophia_voice_lab_cleanup_admissions', 'sophia_voice_lab_cleanup_admissions_cleanup_obligation_id_fkey', 'f', 'FOREIGN KEY (cleanup_obligation_id) REFERENCES sophia_voice_lab_cleanup_obligations(cleanup_obligation_id)'],
      ['sophia_voice_lab_cleanup_admissions', 'sophia_voice_lab_cleanup_admission_kind_valid', 'c', "CHECK (resource_kind = ANY (ARRAY['session'::text, 'provider'::text, 'builder'::text]))"],
      ['sophia_voice_lab_cleanup_admissions', 'sophia_voice_lab_cleanup_admission_status_valid', 'c', "CHECK (status = ANY (ARRAY['reserved'::text, 'allocating'::text, 'credential_minted'::text, 'browser_active'::text, 'activation_aborted'::text, 'browser_closed'::text]))"],
      ['sophia_voice_lab_cleanup_admissions', 'sophia_voice_lab_cleanup_admission_resource_valid', 'c', "CHECK (length(resource_id) >= 1 AND length(resource_id) <= 256 AND resource_id !~ '[[:cntrl:]]'::text)"],
      ['sophia_voice_lab_cleanup_admissions', 'sophia_voice_lab_cleanup_admission_lease_valid', 'c', 'CHECK (lease_expires_at > created_at AND resource_expires_at >= lease_expires_at)'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'sophia_voice_lab_cleanup_scan_cursors_pkey', 'p', 'PRIMARY KEY (cursor_name)'],
      ['sophia_voice_lab_cleanup_scan_cursors', 'sophia_voice_lab_cleanup_scan_cursor_name_valid', 'c', "CHECK (cursor_name = ANY (ARRAY['work_v1'::text, 'complete_purge_v1'::text]))"],
      ['sophia_voice_lab_cleanup_scan_cursors', 'sophia_voice_lab_cleanup_scan_cursor_shape_valid', 'c', "CHECK (cursor_due_at IS NULL AND cursor_source IS NULL AND cursor_cleanup_obligation_id IS NULL AND cursor_admission_id IS NULL AND window_due_at IS NULL AND window_source IS NULL AND window_cleanup_obligation_id IS NULL AND window_admission_id IS NULL OR cursor_due_at IS NOT NULL AND window_due_at IS NOT NULL AND (cursor_source = ANY (ARRAY['obligation'::text, 'admission'::text, 'complete'::text])) AND (window_source = ANY (ARRAY['obligation'::text, 'admission'::text, 'complete'::text])) AND cursor_cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text AND window_cleanup_obligation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text AND (cursor_name = 'work_v1'::text AND cursor_source = 'obligation'::text AND cursor_admission_id IS NULL OR cursor_name = 'work_v1'::text AND cursor_source = 'admission'::text AND cursor_admission_id IS NOT NULL OR cursor_name = 'complete_purge_v1'::text AND cursor_source = 'complete'::text AND cursor_admission_id IS NULL) AND (cursor_name = 'work_v1'::text AND window_source = 'obligation'::text AND window_admission_id IS NULL OR cursor_name = 'work_v1'::text AND window_source = 'admission'::text AND window_admission_id IS NOT NULL OR cursor_name = 'complete_purge_v1'::text AND window_source = 'complete'::text AND window_admission_id IS NULL))"],
    ].map(([tablename, conname, contype, definition]) => ({
      tablename, conname, contype, definition, convalidated: true,
    })),
    cleanupControlPrivileges: [
      'sophia_voice_lab_cleanup_obligations',
      'sophia_voice_lab_cleanup_admissions',
      'sophia_voice_lab_cleanup_scan_cursors',
    ].map((table_name) => ({
      table_name,
      can_select: true,
      can_insert: table_name !== 'sophia_voice_lab_cleanup_scan_cursors',
      can_update: true,
      can_delete: table_name !== 'sophia_voice_lab_cleanup_scan_cursors',
      owner_matches_control: true,
      owner_is_expected: true,
      relkind: 'r',
      relpersistence: 'p',
      relispartition: false,
      inheritance_free: true,
      rewrite_free: true,
      relrowsecurity: false,
      relforcerowsecurity: false,
      service_can_access: false,
      unexpected_acl: false,
      unexpected_column_acl: false,
    })),
    cleanupControlUnsafeGrants: [] as Array<{
      table_name: string; grantee: string; privilege_type: string;
    }>,
    cleanupControlMetadata: [
      {
        table_name: 'sophia_voice_lab_cleanup_obligations',
        table_comment: 'sophia.voice-lab.cleanup-obligation-state.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 content=opaque-control-only',
      },
      {
        table_name: 'sophia_voice_lab_cleanup_admissions',
        table_comment: 'sophia.voice-lab.cleanup-admission-state.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 content=bounded-opaque-resource-locator-no-principal-run-secret',
      },
      {
        table_name: 'sophia_voice_lab_cleanup_scan_cursors',
        table_comment: 'sophia.voice-lab.cleanup-scan-cursor.v1 migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 content=opaque-control-keyset-only',
      },
    ],
    d02Columns: [
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'singleton', 'bool', 'NO', null, 'true'],
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'authority_key_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'authority_secret', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'installed_at', 'timestamptz', 'NO', null, 'clock_timestamp()'],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'capability_jti_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'operation', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'request_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'cleanup_obligation_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'termination_request_id_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'used_at', 'timestamptz', 'NO', null, 'clock_timestamp()'],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'relay_id', 'uuid', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'cleanup_obligation_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'provider_session_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'provider_connection_epoch', 'int4', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'relay_kind', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'owner_instance_id_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'expires_at', 'timestamptz', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'created_at', 'timestamptz', 'NO', null, 'clock_timestamp()'],
      ['sophia_voice_lab_d02_gateway_settlements', 'cleanup_obligation_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'termination_request_id_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'provider_session_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'provider_admission_id', 'uuid', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'freeze_request_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'freeze_capability_jti_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'freeze_binding', 'jsonb', 'NO', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'frozen_at', 'timestamptz', 'NO', null, 'clock_timestamp()'],
      ['sophia_voice_lab_d02_gateway_settlements', 'voice_terminal_receipt_sha256', 'bpchar', 'YES', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'voice_terminal_receipt', 'jsonb', 'YES', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'voice_terminal_at', 'timestamptz', 'YES', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'settlement_request_sha256', 'bpchar', 'YES', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'settlement_capability_jti_sha256', 'bpchar', 'YES', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'provider_settlement_sha256', 'bpchar', 'YES', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'receipt_sha256', 'bpchar', 'YES', 64, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'receipt', 'jsonb', 'YES', null, null],
      ['sophia_voice_lab_d02_gateway_settlements', 'settled_at', 'timestamptz', 'YES', null, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'cleanup_obligation_id', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'restart_request_id_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'phase', 'text', 'NO', null, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'request_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'capability_jti_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'product_service_boot_id_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'render_action_request_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'prior_observation_receipt_sha256', 'bpchar', 'YES', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'receipt_sha256', 'bpchar', 'NO', 64, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'receipt', 'jsonb', 'NO', null, null],
      ['sophia_voice_lab_d02_product_continuity_observations', 'observed_at', 'timestamptz', 'NO', null, 'clock_timestamp()'],
    ].map(([
      table_name, column_name, udt_name, is_nullable,
      character_maximum_length, column_default,
    ]) => ({
      table_name,
      column_name,
      udt_name,
      is_nullable,
      character_maximum_length,
      column_default,
      is_generated: 'NEVER',
      is_identity: 'NO',
    })),
    d02Relations: [
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'd02-database-finalize-authority.v1', 'owner-only-key-material-never-runtime-readable'],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'd02-gateway-capability-use.v1', 'opaque-replay-binding-only'],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'd02-gateway-relay-lease.v1', 'opaque-live-relay-authority-only'],
      ['sophia_voice_lab_d02_gateway_settlements', 'd02-gateway-settlement.v1', 'bounded-authority-receipt-no-raw-principal'],
      ['sophia_voice_lab_d02_product_continuity_observations', 'd02-product-continuity-observation.v1', 'hashed-product-projection-signed-receipt-only'],
    ].map(([table_name, kind, content]) => ({
      table_name,
      owner_name: 'postgres',
      relkind: 'r',
      relpersistence: 'p',
      relispartition: false,
      relrowsecurity: false,
      relforcerowsecurity: false,
      inheritance_free: true,
      rewrite_free: true,
      column_acl_free: true,
      table_comment: `sophia.voice-lab.${kind} migration_sha256=191ee955123259b821d5dd87b03579ce912f3467376b58316cbfac855ce83b44 content=${content}`,
    })),
    d02Acl: [] as Array<{
      table_name: string;
      grantee_name: string;
      privilege_type: string;
      is_grantable: boolean;
    }>,
    d02Constraints: [
      ['sophia_voice_lab_d02_gateway_capability_uses', 'sophia_voice_lab_d02_gateway_capabil_cleanup_obligation_id_fkey', 'f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509'],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'sophia_voice_lab_d02_gateway_capability_use_valid', 'c', '6920ab0aa1ace1259c5901074ee0c7e2ddbb35ff742eddcd7ec61f1014656bd7'],
      ['sophia_voice_lab_d02_gateway_capability_uses', 'sophia_voice_lab_d02_gateway_capability_uses_pkey', 'p', 'a961c742c7d3457dfcc14036010e5998f624e2de98038905fd2ac348805029b5'],
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'sophia_voice_lab_d02_gateway_finalize_authority_pkey', 'p', 'd004b3efcdc4a0108ecbe83c93408f63eebecc563529a3941a4c59667835f25b'],
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'sophia_voice_lab_d02_gateway_finalize_authority_shape', 'c', '72391c6f052baf8359f67736ea44dcdb5c6b5654413920529375ee84656b51e7'],
      ['sophia_voice_lab_d02_gateway_finalize_authority', 'sophia_voice_lab_d02_gateway_finalize_authority_singleton', 'c', '0a780c77dfabbc15def3d17957997d352de196c1233a0d25fccc97a40d2d6f41'],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'sophia_voice_lab_d02_gateway_relay_l_cleanup_obligation_id_fkey', 'f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509'],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'sophia_voice_lab_d02_gateway_relay_lease_valid', 'c', '9255a14b07341568705205a69256eba988d3bd8914538a3d208e0938a51f2323'],
      ['sophia_voice_lab_d02_gateway_relay_leases', 'sophia_voice_lab_d02_gateway_relay_leases_pkey', 'p', 'a31d33028f6a44ff6d3875c2f055f964eacd05ded31d5a6ddce3f187dfc07339'],
      ['sophia_voice_lab_d02_gateway_settlements', 'sophia_voice_lab_d02_gateway_settlem_cleanup_obligation_id_fkey', 'f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509'],
      ['sophia_voice_lab_d02_gateway_settlements', 'sophia_voice_lab_d02_gateway_settlement_binding_valid', 'c', '0a15d4341753469bd5a9e8a65e4f02ea6d7cba53860979eb3b1c45e2baad6208'],
      ['sophia_voice_lab_d02_gateway_settlements', 'sophia_voice_lab_d02_gateway_settlement_hashes_valid', 'c', '6a35b3db36ae129559ba5499ea558ed6400123e68ab1210c966044f2e2a6418f'],
      ['sophia_voice_lab_d02_gateway_settlements', 'sophia_voice_lab_d02_gateway_settlement_lifecycle_valid', 'c', '51543a623b2b5d5a5ceaff154cfd1c3aa9deafd601cf93c4da48b3dbd29a82b1'],
      ['sophia_voice_lab_d02_gateway_settlements', 'sophia_voice_lab_d02_gateway_settlements_pkey', 'p', 'f32df012404d69382bbd618d48e17658886c6d8a3f764ca63056f762ad35486e'],
      ['sophia_voice_lab_d02_product_continuity_observations', 'sophia_voice_lab_d02_product_continu_cleanup_obligation_id_fkey', 'f', 'e4374f2ba313fc85590728355940fa5d2270249cf2cda1b60d416a2df55a7509'],
      ['sophia_voice_lab_d02_product_continuity_observations', 'sophia_voice_lab_d02_product_continuity_hashes_valid', 'c', 'ebd2ddd7f2018bad52ea5cddc1112bd1d90cb52c40f28ea3943b52b3f011a683'],
      ['sophia_voice_lab_d02_product_continuity_observations', 'sophia_voice_lab_d02_product_continuity_observations_pkey', 'p', '22bfbe634350aecb7e6653b19040d9d4e66cdde7e258e9375a8bd870d888533f'],
      ['sophia_voice_lab_d02_product_continuity_observations', 'sophia_voice_lab_d02_product_continuity_receipt_valid', 'c', 'a2b49334beea375a3d4fa6749d527d33af113bfc04b76a385de7ec2da2e55ff1'],
      ['sophia_voice_lab_d02_product_continuity_observations', 'sophia_voice_lab_d02_product_continuity_shape_valid', 'c', 'c2a72e4ec1a177df28000e73c6ac8f98392b4f1f953ca560be8af28724d3283d'],
    ].map(([tablename, conname, contype, definition_sha256]) => ({
      tablename,
      conname,
      contype,
      definition: '',
      definition_sha256,
      convalidated: true,
      condeferrable: false,
      condeferred: false,
    })),
    d02Indexes: [
      ['sophia_voice_lab_d02_gateway_finalize_authority_pkey', 'sophia_voice_lab_d02_gateway_finalize_authority', true, ['singleton'], '', ['bool_ops'], ['']],
      ['sophia_voice_lab_d02_gateway_capability_uses_pkey', 'sophia_voice_lab_d02_gateway_capability_uses', true, ['capability_jti_sha256'], '', ['bpchar_ops'], ['default']],
      ['sophia_voice_lab_d02_gateway_relay_expiry_idx', 'sophia_voice_lab_d02_gateway_relay_leases', false, ['cleanup_obligation_id', 'expires_at', 'owner_instance_id_sha256', 'relay_id'], '', ['text_ops', 'timestamptz_ops', 'bpchar_ops', 'uuid_ops'], ['default', '', 'default', '']],
      ['sophia_voice_lab_d02_gateway_relay_leases_pkey', 'sophia_voice_lab_d02_gateway_relay_leases', true, ['relay_id'], '', ['uuid_ops'], ['']],
      ['sophia_voice_lab_d02_gateway_settlements_freeze_jti_idx', 'sophia_voice_lab_d02_gateway_settlements', true, ['freeze_capability_jti_sha256'], '', ['bpchar_ops'], ['default']],
      ['sophia_voice_lab_d02_gateway_settlements_pkey', 'sophia_voice_lab_d02_gateway_settlements', true, ['cleanup_obligation_id', 'termination_request_id_sha256'], '', ['text_ops', 'bpchar_ops'], ['default', 'default']],
      ['sophia_voice_lab_d02_gateway_settlements_settlement_jti_idx', 'sophia_voice_lab_d02_gateway_settlements', true, ['settlement_capability_jti_sha256'], 'settlement_capability_jti_sha256 IS NOT NULL', ['bpchar_ops'], ['default']],
      ['sophia_voice_lab_d02_product_continuity_observations_pkey', 'sophia_voice_lab_d02_product_continuity_observations', true, ['cleanup_obligation_id', 'restart_request_id_sha256', 'phase'], '', ['text_ops', 'bpchar_ops', 'text_ops'], ['default', 'default', 'default']],
      ['sophia_voice_lab_d02_product_continuity_one_restart_idx', 'sophia_voice_lab_d02_product_continuity_observations', true, ['cleanup_obligation_id'], "phase = 'before_api_restart'::text", ['text_ops'], ['default']],
    ].map(([
      indexname, tablename, indisunique, key_expressions, predicate,
      opclasses, collations,
    ]) => ({
      indexname,
      tablename,
      indisunique,
      indisvalid: true,
      indisready: true,
      indimmediate: true,
      indnkeyatts: (key_expressions as string[]).length,
      index_relpersistence: 'p',
      amname: 'btree',
      key_expressions,
      key_options: (key_expressions as string[]).map(() => 0),
      predicate,
      opclasses,
      collations,
      index_comment: null,
    })),
    d02ForeignKeyTriggers: [
      'sophia_voice_lab_d02_gateway_capability_uses.sophia_voice_lab_d02_gateway_capabil_cleanup_obligation_id_fkey',
      'sophia_voice_lab_d02_gateway_relay_leases.sophia_voice_lab_d02_gateway_relay_l_cleanup_obligation_id_fkey',
      'sophia_voice_lab_d02_gateway_settlements.sophia_voice_lab_d02_gateway_settlem_cleanup_obligation_id_fkey',
      'sophia_voice_lab_d02_product_continuity_observations.sophia_voice_lab_d02_product_continu_cleanup_obligation_id_fkey',
    ].flatMap((key) => {
      const [source_table, constraint_name] = key.split('.', 2);
      return [
        [source_table, 'RI_FKey_check_ins'],
        [source_table, 'RI_FKey_check_upd'],
        ['sophia_voice_lab_cleanup_obligations', 'RI_FKey_cascade_del'],
        ['sophia_voice_lab_cleanup_obligations', 'RI_FKey_noaction_upd'],
      ].map(([tablename, proname]) => ({
        source_table,
        constraint_name,
        tablename,
        proname,
        tgenabled: 'O',
        tgisinternal: true,
      }));
    }),
    d02NonInternalTriggers: [] as Array<{ table_name: string; trigger_name: string }>,
    d02Role: [{
      rolname: 'sophia_voice_lab_gateway',
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
      membership_contract_version: 'supabase_pg17.directional_membership.v1',
      membership_direction_attested: true,
      canonical_inbound_membership_count: 0,
      outbound_membership_count: 0,
      transitive_authority_free: true,
      public_schema_create_denied: true,
      future_function_public_execute_denied: true,
    }],
    d02EffectivePrivileges: [
      ['session', []],
      ['sophia_sessions', []],
      ['sophia_session_messages', []],
      ['artifact_registry_records', []],
      ['sophia_voice_lab_auth_grants', []],
      ['sophia_voice_lab_cleanup_obligations', []],
      ['sophia_voice_lab_cleanup_admissions', []],
      ['sophia_voice_lab_cleanup_scan_cursors', []],
      ['sophia_voice_lab_d02_gateway_settlements', []],
      ['sophia_voice_lab_d02_gateway_capability_uses', []],
      ['sophia_voice_lab_d02_gateway_relay_leases', []],
      ['sophia_voice_lab_d02_product_continuity_observations', []],
      ['sophia_voice_lab_d02_gateway_finalize_authority', []],
    ].flatMap(([table_name, allowed]) =>
      [
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN',
      ]
        .map((privilege_type) => ({
          table_name,
          privilege_type,
          permitted: (allowed as string[]).includes(privilege_type),
        }))),
    d02GlobalEffectivePrivileges: [{
      table_name: 'session',
      privilege_type: 'SELECT',
      table_permitted: false,
      column_permitted: false,
    }],
    d02GlobalFunctionAuthority: [
      ['sophia_voice_lab_d02_continuity_authorize', 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_observed_at timestamp with time zone'],
      ['sophia_voice_lab_d02_continuity_finalize', 'p_cleanup_obligation_id text, p_restart_request_id_sha256 text, p_phase text, p_request_sha256 text, p_capability_jti_sha256 text, p_product_service_boot_id_sha256 text, p_render_action_request_sha256 text, p_prior_observation_receipt_sha256 text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text'],
      ['sophia_voice_lab_d02_finalize_authority_ready', 'p_authority_key_id text, p_authority_secret_sha256 text'],
      ['sophia_voice_lab_d02_freeze_authorize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text'],
      ['sophia_voice_lab_d02_freeze_finalize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_freeze_binding jsonb, p_authority_key_id text, p_finalize_proof_sha256 text'],
      ['sophia_voice_lab_d02_producer_open', 'p_cleanup_obligation_id text'],
      ['sophia_voice_lab_d02_provider_freeze', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text'],
      ['sophia_voice_lab_d02_relay_begin', 'p_relay_id uuid, p_cleanup_obligation_id text, p_provider_session_id text, p_provider_connection_epoch integer, p_relay_kind text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_authority_key_id text, p_operation_proof_sha256 text'],
      ['sophia_voice_lab_d02_relay_end', 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text'],
      ['sophia_voice_lab_d02_relay_refresh', 'p_relay_id uuid, p_cleanup_obligation_id text, p_owner_instance_id_sha256 text, p_lease_seconds integer, p_operation_id_sha256 text, p_authority_key_id text, p_operation_proof_sha256 text'],
      ['sophia_voice_lab_d02_settlement_authorize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_request_sha256 text, p_capability_jti_sha256 text'],
      ['sophia_voice_lab_d02_settlement_finalize', 'p_cleanup_obligation_id text, p_termination_request_id_sha256 text, p_provider_session_id text, p_provider_admission_id uuid, p_request_sha256 text, p_capability_jti_sha256 text, p_provider_settlement_sha256 text, p_next_metadata jsonb, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text'],
      ['sophia_voice_lab_d02_sources_zero', 'p_cleanup_obligation_id text'],
      ['sophia_voice_lab_d02_voice_terminal_authorize', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text'],
      ['sophia_voice_lab_d02_voice_terminal_finalize', 'p_cleanup_obligation_id text, p_provider_admission_id uuid, p_provider_session_id text, p_receipt_sha256 text, p_receipt jsonb, p_authority_key_id text, p_finalize_proof_sha256 text'],
    ].map(([proname, identity_arguments]) => ({ proname, identity_arguments })),
    sessionSettings: [{
      session_user_name: 'better_auth_app',
      current_user_name: 'better_auth_app',
      current_role_name: 'better_auth_app',
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
      membership_contract_version: 'supabase_pg17.directional_membership.v1',
      membership_direction_attested: true,
      canonical_inbound_membership_count: 0,
      outbound_membership_count: 0,
      transitive_authority_free: true,
      public_schema_create_denied: true,
      session_replication_role: 'origin',
      search_path: 'pg_catalog,public,pg_temp',
      transaction_read_only: 'off',
      synchronous_commit: 'on',
      in_recovery: false,
    }],
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('voice_lab_d02_columns')) return { rows: preflight.d02Columns };
    if (sql.includes('voice_lab_d02_relations')) return { rows: preflight.d02Relations };
    if (sql.includes('voice_lab_d02_direct_acl')) return { rows: preflight.d02Acl };
    if (sql.includes('voice_lab_d02_constraints')) return { rows: preflight.d02Constraints };
    if (sql.includes('voice_lab_d02_indexes')) return { rows: preflight.d02Indexes };
    if (sql.includes('voice_lab_d02_fk_triggers')) {
      return { rows: preflight.d02ForeignKeyTriggers };
    }
    if (sql.includes('voice_lab_d02_noninternal_triggers')) {
      return { rows: preflight.d02NonInternalTriggers };
    }
    if (sql.includes('voice_lab_d02_gateway_role')) return { rows: preflight.d02Role };
    if (sql.includes('voice_lab_d02_effective_privileges')) {
      return { rows: preflight.d02EffectivePrivileges };
    }
    if (sql.includes('voice_lab_d02_global_effective_privileges')) {
      return { rows: preflight.d02GlobalEffectivePrivileges };
    }
    if (sql.includes('voice_lab_d02_global_function_authority')) {
      return { rows: preflight.d02GlobalFunctionAuthority };
    }
    if (sql.includes("current_setting('session_replication_role')")) {
      return { rows: preflight.sessionSettings };
    }
    if (sql.includes('voice_lab_cleanup_admissions_fk_triggers')) {
      return { rows: preflight.cleanupAdmissionsForeignKeyTriggers };
    }
    if (sql.includes('voice_lab_product_primary_keys')) {
      return { rows: preflight.productPrimaryKeys };
    }
    if (sql.includes('voice_lab_better_auth_session_columns')) {
      return { rows: preflight.betterAuthSessionColumns };
    }
    if (sql.includes('voice_lab_better_auth_session_indexes')) {
      return { rows: preflight.betterAuthSessionIndexes };
    }
    if (sql.includes('voice_lab_better_auth_session_key_constraints')) {
      return { rows: preflight.betterAuthSessionConstraints };
    }
    if (sql.includes('voice_lab_better_auth_session_relation')) {
      return { rows: preflight.betterAuthSessionRelation };
    }
    if (sql.includes('voice_lab_required_product_columns')) {
      return { rows: preflight.productColumns };
    }
    if (sql.includes('voice_lab_auth_ledger_columns')) {
      return { rows: preflight.columns };
    }
    if (sql.includes('voice_lab_cleanup_control_columns')) {
      return { rows: preflight.cleanupControlColumns };
    }
    if (sql.includes('voice_lab_product_table_privileges')) {
      return { rows: preflight.productPrivileges };
    }
    if (sql.includes('voice_lab_product_table_unsafe_grants')) {
      return { rows: preflight.productUnsafeGrants };
    }
    if (sql.includes('voice_lab_session_messages_fk_triggers')) {
      return { rows: preflight.sessionMessagesForeignKeyTriggers };
    }
    if (sql.includes('voice_lab_session_messages_fk')) {
      return { rows: preflight.sessionMessagesForeignKey };
    }
    if (sql.includes('FROM pg_indexes')) {
      return { rows: sql.includes('ANY($1::text[])')
        ? preflight.cleanupControlIndexes
        : preflight.indexes };
    }
    if (sql.includes('FROM pg_constraint')) {
      return { rows: sql.includes('c.relname AS tablename')
        ? preflight.cleanupControlConstraints
        : preflight.constraints };
    }
    if (sql.includes('CROSS JOIN unnest($1::text[])')) {
      return { rows: preflight.unsafeEffectiveTablePrivileges };
    }
    if (sql.includes('has_table_privilege')) {
      return { rows: sql.includes('FROM unnest')
        ? preflight.cleanupControlPrivileges
        : preflight.privileges };
    }
    if (sql.includes('FROM information_schema.table_privileges')) {
      return { rows: sql.includes('ANY($1::text[])')
        ? preflight.cleanupControlUnsafeGrants
        : preflight.unsafeGrants };
    }
    if (sql.includes('FROM pg_index i')) {
      if (params[0] === 'sophia_voice_lab_auth_grants') {
        return { rows: preflight.indexes };
      }
      return { rows: sql.includes('idx.relname = ANY')
        ? preflight.cleanupIndexes
        : preflight.cleanupControlIndexes };
    }
    if (sql.includes('FROM pg_trigger t')) return { rows: preflight.cleanupTriggers };
    if (sql.includes('FROM pg_proc p')) return { rows: preflight.cleanupFunctions };
    if (sql.includes('FROM information_schema.routine_privileges')) {
      return { rows: preflight.unsafeFenceGrants };
    }
    if (sql.includes('SELECT DISTINCT "tombstone_kid"')) {
      return { rows: [...new Set(grants.map((row) => row.tombstone_kid))].map((tombstone_kid) => ({ tombstone_kid })) };
    }
    if (sql.includes('obj_description')) {
      return { rows: sql.includes('c.relname AS table_name')
        ? preflight.cleanupControlMetadata
        : preflight.metadata };
    }
    if (sql.startsWith('SELECT "grant_fingerprint"')) {
      return { rows: grants.map((row) => ({ ...row })) };
    }
    if (sql.startsWith('SELECT "token"')) return { rows: rows.map((row) => ({ ...row })) };
    if (sql.startsWith('SELECT "userAgent"')) {
      return { rows: rows.map(({ userAgent }) => ({ userAgent })) };
    }
    if (sql.startsWith('DELETE FROM public."session"')) {
      if (faults.suppressSessionDelete) return { rows: [], rowCount: 0 };
      const token = params[1];
      const before = rows.length;
      if (typeof token === 'string') {
        const index = rows.findIndex((row) => row.token === token);
        if (index >= 0) rows.splice(index, 1);
      } else {
        rows.splice(0, rows.length);
      }
      const rowCount = before - rows.length;
      return { rows: [], rowCount };
    }
    if (sql.startsWith('DELETE FROM public."sophia_voice_lab_auth_grants"')) {
      const now = Date.now();
      let deleted = 0;
      for (let index = grants.length - 1; index >= 0; index -= 1) {
        if (grants[index].status === 'revoked' && grants[index].expires_at.getTime() <= now) {
          grants.splice(index, 1);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }
    if (sql.startsWith('UPDATE public."sophia_voice_lab_auth_grants"')) {
      let updated = 0;
      for (const row of grants) {
        const matches = sql.includes('"grant_fingerprint" = $2')
          ? row.grant_fingerprint === params[1]
          : params.length < 2 || row.test_run_id === params[1];
        if (row.status === 'active' && matches) {
          row.status = 'revoked';
          if (sql.includes('"principal_id" = $3')) {
            row.principal_id = params[2] as string;
            row.test_run_id = params[3] as string;
            row.cleanup_obligation_id = params[4] as string;
            row.jti_sha256 = params[5] as string;
            row.nonce_sha256 = params[5] as string;
            row.session_token_sha256 = params[5] as string;
          }
          updated += 1;
        }
      }
      return { rows: [], rowCount: updated };
    }
    if (sql.startsWith('UPDATE public."sophia_voice_lab_cleanup_obligations"')) {
      const obligation = obligations.find(
        (row) => row.cleanup_obligation_id === params[0],
      );
      if (
        !obligation
        || obligation.state !== 'open'
        || new Date(obligation.provider_expires_at).getTime()
          !== new Date(params[1] as Date).getTime()
      ) return { rows: [], rowCount: 0 };
      obligation.state = 'closed';
      return { rows: [{ state: 'closed' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO public."session"')) {
      if (faults.suppressSessionInsert) return { rows: [], rowCount: 0 };
      rows.push({
        expiresAt: params[1] as Date,
        token: params[2] as string,
        userAgent: params[5] as string,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO public."sophia_voice_lab_cleanup_obligations"')) {
      const cleanupObligationId = params[0] as string;
      const existing = obligations.find(
        (row) => row.cleanup_obligation_id === cleanupObligationId,
      );
      if (existing) return { rows: [], rowCount: 0 };
      const providerExpiresAt = params[1] as Date;
      const created: CleanupObligationRow = {
        cleanup_obligation_id: cleanupObligationId,
        state: 'open',
        lifecycle_phase: 'auth_provisional',
        retention_expires_at: providerExpiresAt,
        provider_expires_at: providerExpiresAt,
      };
      obligations.push(created);
      return { rows: [{ ...created }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT "state", "lifecycle_phase"')) {
      return {
        rows: obligations
          .filter((row) => row.cleanup_obligation_id === params[0])
          .map((row) => ({ ...row })),
      };
    }
    if (sql.startsWith('INSERT INTO public."sophia_voice_lab_auth_grants"')) {
      grants.push({
        grant_fingerprint: params[0] as string,
        principal_id: params[1] as string,
        test_run_id: params[2] as string,
        tombstone_kid: params[3] as string,
        cleanup_obligation_id: params[4] as string,
        issued_at: params[5] as number,
        expires_at: params[6] as Date,
        provider_expires_at: params[7] as Date,
        retention_hours: params[8] as number,
        jti_sha256: params[9] as string,
        nonce_sha256: params[10] as string,
        session_token_sha256: params[11] as string,
        status: 'active',
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  return {
    rows, grants, obligations, faults, preflight, query, client,
    connect: vi.fn(async () => client),
  };
});

vi.mock('../../server/better-auth/database', () => ({
  getBetterAuthDatabase: () => ({ connect: database.connect, query: database.query }),
}));

import {
  assertVoiceLabAuthLedgerReady,
  revokeVoiceLabSessions,
  rotateVoiceLabSession,
  VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256,
} from '../../server/voice-lab/session-ledger';

function claims(overrides: Partial<VoiceLabCapabilityClaims> = {}): VoiceLabCapabilityClaims {
  return {
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-001',
    synthetic: true,
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    allowed_ops: ['auth:session'],
    expected_deployment: { frontend: 'a'.repeat(40), backend: 'a'.repeat(40), voice: 'a'.repeat(40) },
    iat: 2_000_000_000,
    nbf: 2_000_000_000,
    exp: 2_000_000_120,
    jti: 'jti-001',
    nonce: 'nonce-001',
    ...overrides,
  };
}

describe('dedicated Voice Lab Better Auth session ledger', () => {
  beforeEach(() => {
    process.env.SOPHIA_VOICE_LAB_CAPABILITY_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID = 'v1';
    process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS = JSON.stringify({
      v1: 'auth-tombstone-secret-at-least-thirty-two-bytes',
    });
    database.rows.splice(0, database.rows.length);
    database.grants.splice(0, database.grants.length);
    database.obligations.splice(0, database.obligations.length);
    database.faults.suppressSessionInsert = false;
    database.faults.suppressSessionDelete = false;
    database.query.mockClear();
    database.connect.mockClear();
    database.client.release.mockClear();
    for (const row of database.preflight.columns) {
      row.character_maximum_length = row.udt_name === 'bpchar' ? 64 : null;
      row.is_generated = 'NEVER';
      row.is_identity = 'NO';
    }
    for (const row of database.preflight.cleanupControlColumns) {
      row.character_maximum_length = null;
      row.is_generated = 'NEVER';
      row.is_identity = 'NO';
    }
    for (const row of database.preflight.productColumns) {
      row.character_maximum_length = null;
      row.is_generated = 'NEVER';
      row.is_identity = 'NO';
      row.relkind = 'r';
      row.relpersistence = 'p';
      row.relrowsecurity = false;
      row.relforcerowsecurity = false;
    }
    for (const row of database.preflight.productPrivileges) {
      const sessions = row.table_name === 'sophia_sessions';
      row.can_select = sessions;
      row.can_insert = false;
      row.can_update = sessions;
      row.can_delete = false;
      row.service_can_mutate = true;
      row.service_has_unsafe = false;
      row.anon_can_access = false;
      row.authenticated_can_access = false;
      row.owner_matches_control = true;
      row.owner_is_expected = true;
      row.relispartition = false;
      row.inheritance_free = true;
      row.rewrite_free = true;
      row.unexpected_acl = false;
      row.unexpected_column_acl = false;
    }
    database.preflight.productUnsafeGrants.splice(
      0,
      database.preflight.productUnsafeGrants.length,
    );
    database.preflight.sessionMessagesForeignKey[0].convalidated = true;
    database.preflight.sessionMessagesForeignKey[0].condeferrable = false;
    database.preflight.sessionMessagesForeignKey[0].condeferred = false;
    database.preflight.sessionMessagesForeignKey[0].definition =
      'FOREIGN KEY (session_id) REFERENCES sophia_sessions(id) ON DELETE CASCADE';
    for (const row of database.preflight.sessionMessagesForeignKeyTriggers) {
      row.tgenabled = 'O';
      row.tgisinternal = true;
    }
    for (const row of database.preflight.cleanupAdmissionsForeignKeyTriggers) {
      row.tgenabled = 'O';
      row.tgisinternal = true;
    }
    for (const row of database.preflight.cleanupTriggers) {
      row.function_schema = 'public';
      row.function_is_public_identity = true;
    }
    for (const row of database.preflight.productPrimaryKeys) {
      row.convalidated = true;
      row.condeferrable = false;
      row.condeferred = false;
      row.indisunique = true;
      row.indisvalid = true;
      row.indisready = true;
      row.index_relpersistence = 'p';
      row.amname = 'btree';
    }
    for (const row of database.preflight.betterAuthSessionColumns) {
      row.character_maximum_length = null;
      row.is_generated = 'NEVER';
      row.is_identity = 'NO';
    }
    for (const row of database.preflight.cleanupControlPrivileges) {
      const cursor = row.table_name === 'sophia_voice_lab_cleanup_scan_cursors';
      row.can_select = true;
      row.can_insert = !cursor;
      row.can_update = true;
      row.can_delete = !cursor;
      row.owner_matches_control = true;
      row.owner_is_expected = true;
      row.relkind = 'r';
      row.relpersistence = 'p';
      row.relispartition = false;
      row.inheritance_free = true;
      row.rewrite_free = true;
      row.relrowsecurity = false;
      row.relforcerowsecurity = false;
      row.service_can_access = false;
      row.unexpected_acl = false;
      row.unexpected_column_acl = false;
    }
    database.preflight.betterAuthSessionRelation[0] = {
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      owner_matches_control: true,
      owner_is_expected: true,
      relkind: 'r',
      relpersistence: 'p',
      relispartition: false,
      inheritance_free: true,
      rewrite_free: true,
      relrowsecurity: false,
      relforcerowsecurity: false,
      unexpected_acl: false,
      unexpected_column_acl: false,
      public_can_access: false,
      anon_can_access: false,
      authenticated_can_access: false,
      service_can_access: false,
    };
    database.preflight.sessionSettings[0] = {
      session_user_name: 'better_auth_app',
      current_user_name: 'better_auth_app',
      current_role_name: 'better_auth_app',
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
      membership_contract_version: 'supabase_pg17.directional_membership.v1',
      membership_direction_attested: true,
      canonical_inbound_membership_count: 0,
      outbound_membership_count: 0,
      transitive_authority_free: true,
      public_schema_create_denied: true,
      session_replication_role: 'origin',
      search_path: 'pg_catalog,public,pg_temp',
      transaction_read_only: 'off',
      synchronous_commit: 'on',
      in_recovery: false,
    };
    database.preflight.privileges[0] = {
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
      owner_matches_control: true,
      owner_is_expected: true,
      relkind: 'r',
      relpersistence: 'p',
      relispartition: false,
      inheritance_free: true,
      rewrite_free: true,
      relrowsecurity: false,
      relforcerowsecurity: false,
      unexpected_acl: false,
      unexpected_column_acl: false,
    };
    database.preflight.unsafeGrants.splice(0, database.preflight.unsafeGrants.length);
    database.preflight.unsafeFenceGrants.splice(0, database.preflight.unsafeFenceGrants.length);
    database.preflight.metadata[0].table_comment =
      'sophia.voice-lab.auth-ledger.v1 migration_sha256=42e6f2b3bf083675bcdd7b2f29c66b400c6fca9771b76f866e6c55f8513b514c';
  });

  it('proves the exact operated ledger shape, indexes, constraints, and privileges', async () => {
    await expect(assertVoiceLabAuthLedgerReady()).resolves.toEqual({
      ready: true,
      table: 'sophia_voice_lab_auth_grants',
      migrationSha256: VOICE_LAB_AUTH_LEDGER_MIGRATION_SHA256,
      requiredPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    });
    const membershipQueries = database.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('supabase_pg17.directional_membership.v1'));
    expect(membershipQueries).toHaveLength(2);
    for (const sql of membershipQueries) {
      expect(sql).toContain("member_role.rolname = 'postgres'");
      expect(sql).toContain("grantor_role.rolname = 'supabase_admin'");
      expect(sql).toContain('membership.admin_option = true');
      expect(sql).toContain('membership.inherit_option = false');
      expect(sql).toContain('membership.set_option = false');
      expect(sql).toContain('WITH RECURSIVE inherited_roles');
    }
  });

  it('rejects every D02 catalog, authority-role, and least-ACL drift seam', async () => {
    const rejectsReadiness = async () => {
      await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
        code: 'voice_lab_auth_ledger_not_ready',
        status: 503,
      });
    };

    database.preflight.d02Columns[0].is_generated = 'ALWAYS';
    await rejectsReadiness();
    database.preflight.d02Columns[0].is_generated = 'NEVER';

    database.preflight.d02Relations[0].relpersistence = 'u';
    await rejectsReadiness();
    database.preflight.d02Relations[0].relpersistence = 'p';

    database.preflight.d02Relations.push({
      ...database.preflight.d02Relations[0],
      table_name: 'sophia_voice_lab_d02_unexpected_authority',
    });
    await rejectsReadiness();
    database.preflight.d02Relations.pop();

    database.preflight.d02Acl.push({
      table_name: 'sophia_voice_lab_d02_gateway_settlements',
      grantee_name: 'service_role',
      privilege_type: 'SELECT',
      is_grantable: false,
    });
    await rejectsReadiness();
    database.preflight.d02Acl.pop();

    const constraint = database.preflight.d02Constraints[0];
    const constraintSha256 = constraint.definition_sha256;
    constraint.definition_sha256 = '0'.repeat(64);
    await rejectsReadiness();
    constraint.definition_sha256 = constraintSha256;

    const index = database.preflight.d02Indexes[0];
    const opclass = index.opclasses[0];
    index.opclasses[0] = 'text_ops';
    await rejectsReadiness();
    index.opclasses[0] = opclass;

    database.preflight.d02ForeignKeyTriggers[0].tgenabled = 'D';
    await rejectsReadiness();
    database.preflight.d02ForeignKeyTriggers[0].tgenabled = 'O';

    database.preflight.d02NonInternalTriggers.push({
      table_name: 'sophia_voice_lab_d02_gateway_settlements',
      trigger_name: 'unexpected_d02_trigger',
    });
    await rejectsReadiness();
    database.preflight.d02NonInternalTriggers.pop();

    database.preflight.d02Role[0].rolsuper = true;
    await rejectsReadiness();
    database.preflight.d02Role[0].rolsuper = false;

    const forbidden = database.preflight.d02EffectivePrivileges.find(
      (row) => row.table_name === 'sophia_voice_lab_cleanup_scan_cursors'
        && row.privilege_type === 'SELECT',
    );
    expect(forbidden).toBeDefined();
    forbidden!.permitted = true;
    await rejectsReadiness();
    forbidden!.permitted = false;

    await expect(assertVoiceLabAuthLedgerReady()).resolves.toMatchObject({ ready: true });
  });

  it('rejects disabled trigger predicates, function-body drift, and extra overloads', async () => {
    database.preflight.privileges[0].relpersistence = 'u';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.privileges[0].relpersistence = 'p';

    const authIndex = database.preflight.indexes[2];
    authIndex.amname = 'hash';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    authIndex.amname = 'btree';

    const trigger = database.preflight.cleanupTriggers[0];
    const originalDefinition = trigger.trigger_definition;
    trigger.trigger_definition = originalDefinition.replace(
      'FOR EACH ROW',
      'FOR EACH ROW WHEN (false)',
    );
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    trigger.trigger_definition = originalDefinition;

    database.preflight.cleanupTriggers.push({
      ...trigger,
      tgname: 'unexpected_voice_lab_trigger',
      trigger_definition: trigger.trigger_definition.replace(
        trigger.tgname,
        'unexpected_voice_lab_trigger',
      ),
    });
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.cleanupTriggers.pop();

    const governedFunction = database.preflight.cleanupFunctions[0];
    const originalSourceSha256 = governedFunction.source_sha256;
    governedFunction.source_sha256 = '0'.repeat(64);
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    governedFunction.source_sha256 = originalSourceSha256;

    const originalResultType = governedFunction.result_type;
    governedFunction.result_type = 'integer';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    governedFunction.result_type = originalResultType;

    const originalParallel = governedFunction.proparallel;
    governedFunction.proparallel = 'u';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    governedFunction.proparallel = originalParallel;

    database.preflight.cleanupFunctions.push({
      ...governedFunction,
      identity_arguments: 'p_value integer',
    });
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.cleanupFunctions.pop();
  });

  it('rejects generated controls and drifted product evidence ownership', async () => {
    const authColumn = database.preflight.columns[0];
    authColumn.is_generated = 'ALWAYS';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    authColumn.is_generated = 'NEVER';

    const originalAuthColumnLength = authColumn.character_maximum_length;
    authColumn.character_maximum_length = 63;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    authColumn.character_maximum_length = originalAuthColumnLength;

    const controlColumn = database.preflight.cleanupControlColumns[0];
    controlColumn.is_identity = 'YES';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    controlColumn.is_identity = 'NO';

    const requiredProductColumn = database.preflight.productColumns.find(
      (row) => row.table_name === 'sophia_session_messages'
        && row.column_name === 'user_id',
    )!;
    const originalProductColumnType = requiredProductColumn.udt_name;
    requiredProductColumn.udt_name = 'int8';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    requiredProductColumn.udt_name = originalProductColumnType;

    requiredProductColumn.relpersistence = 'u';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    requiredProductColumn.relpersistence = 'p';

    const productPrivilege = database.preflight.productPrivileges[0];
    productPrivilege.service_can_mutate = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    productPrivilege.service_can_mutate = true;

    productPrivilege.owner_is_expected = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    productPrivilege.owner_is_expected = true;

    productPrivilege.can_select = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    productPrivilege.can_select = true;

    const foreignKey = database.preflight.sessionMessagesForeignKey[0];
    const originalForeignKeyDefinition = foreignKey.definition;
    foreignKey.definition = 'FOREIGN KEY (session_id) REFERENCES sophia_sessions(id)';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    foreignKey.definition = originalForeignKeyDefinition;

    const foreignKeyTrigger = database.preflight.sessionMessagesForeignKeyTriggers[0];
    foreignKeyTrigger.tgenabled = 'D';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    foreignKeyTrigger.tgenabled = 'O';
  });

  it('rejects unsafe checkout state and every newly governed relation seam', async () => {
    database.preflight.sessionSettings[0].session_replication_role = 'replica';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].session_replication_role = 'origin';

    database.preflight.sessionSettings[0].search_path = 'pg_catalog,public';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].search_path = 'pg_catalog,public,pg_temp';

    database.preflight.sessionSettings[0].current_user_name = 'postgres';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].current_user_name = 'better_auth_app';

    database.preflight.sessionSettings[0].rolsuper = true;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].rolsuper = false;

    database.preflight.sessionSettings[0].membership_direction_attested = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].membership_direction_attested = true;

    database.preflight.sessionSettings[0].membership_contract_version = 'stale.v0';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].membership_contract_version =
      'supabase_pg17.directional_membership.v1';

    database.preflight.sessionSettings[0].canonical_inbound_membership_count = 2;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].canonical_inbound_membership_count = Number.NaN;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].canonical_inbound_membership_count = 1;
    await expect(assertVoiceLabAuthLedgerReady()).resolves.toMatchObject({
      ready: true,
    });
    database.preflight.sessionSettings[0].canonical_inbound_membership_count = 0;

    database.preflight.sessionSettings[0].outbound_membership_count = 1;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].outbound_membership_count = 0;

    database.preflight.sessionSettings[0].transitive_authority_free = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].transitive_authority_free = true;

    database.preflight.d02Role[0].canonical_inbound_membership_count = 1;
    await expect(assertVoiceLabAuthLedgerReady()).resolves.toMatchObject({
      ready: true,
    });
    database.preflight.d02Role[0].canonical_inbound_membership_count = 0;
    database.preflight.d02Role[0].outbound_membership_count = 1;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.d02Role[0].outbound_membership_count = 0;

    database.preflight.sessionSettings[0].public_schema_create_denied = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.sessionSettings[0].public_schema_create_denied = true;

    const cursorRelation = database.preflight.cleanupControlPrivileges.find(
      (row) => row.table_name === 'sophia_voice_lab_cleanup_scan_cursors',
    )!;
    cursorRelation.rewrite_free = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    cursorRelation.rewrite_free = true;

    cursorRelation.service_can_access = true;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    cursorRelation.service_can_access = false;

    const trigger = database.preflight.cleanupTriggers[0];
    trigger.function_is_public_identity = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    trigger.function_is_public_identity = true;

    const admissionForeignKeyTrigger =
      database.preflight.cleanupAdmissionsForeignKeyTriggers[0];
    admissionForeignKeyTrigger.tgenabled = 'D';
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    admissionForeignKeyTrigger.tgenabled = 'O';

    const productPrimaryKey = database.preflight.productPrimaryKeys[1];
    productPrimaryKey.indisvalid = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    productPrimaryKey.indisvalid = true;

    database.preflight.betterAuthSessionRelation[0].rewrite_free = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    database.preflight.betterAuthSessionRelation[0].rewrite_free = true;
  });

  it('fails typed and closed on missing operator privileges or public grants', async () => {
    database.preflight.privileges[0].can_delete = false;
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });

    database.preflight.privileges[0].can_delete = true;
    database.preflight.unsafeGrants.push({ grantee: 'authenticated', privilege_type: 'SELECT' });
    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
  });

  it('fails closed when SELECT drifts back onto PUBLIC', async () => {
    database.preflight.unsafeGrants.push({ grantee: 'PUBLIC', privilege_type: 'SELECT' });

    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
  });

  it('rejects a lookalike table without the observed pinned migration identity', async () => {
    database.preflight.metadata[0].table_comment =
      'sophia.voice-lab.auth-ledger.v1 migration_sha256=' + '0'.repeat(64);

    await expect(assertVoiceLabAuthLedgerReady()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
  });

  it('converges a lost-response retry for the same JTI and nonce on one session', async () => {
    const grant = claims();
    const expiry = new Date(Date.now() + 3_600_000);
    const first = await rotateVoiceLabSession('voice-lab-user-1', grant, 'token-one', expiry);
    const retry = await rotateVoiceLabSession('voice-lab-user-1', grant, 'token-two', expiry);

    expect(first).toMatchObject({ token: 'token-one', idempotentReplay: false });
    expect(retry).toMatchObject({ token: 'token-one', idempotentReplay: true });
    expect(database.rows).toHaveLength(1);
    expect(database.query.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toHaveLength(6);
  });

  it('requires exact Better Auth insert and delete effects in the guarded transaction', async () => {
    const grant = claims();
    const expiry = new Date(Date.now() + 3_600_000);
    database.faults.suppressSessionInsert = true;
    await expect(
      rotateVoiceLabSession('voice-lab-user-1', grant, 'token-one', expiry),
    ).rejects.toMatchObject({
      code: 'voice_lab_auth_session_mutation_unconfirmed',
      status: 503,
    });
    expect(database.rows).toHaveLength(0);

    database.faults.suppressSessionInsert = false;
    database.obligations.splice(0, database.obligations.length);
    await rotateVoiceLabSession('voice-lab-user-1', grant, 'token-one', expiry);
    database.faults.suppressSessionDelete = true;
    await expect(
      revokeVoiceLabSessions('voice-lab-user-1', grant),
    ).rejects.toMatchObject({
      code: 'voice_lab_auth_session_mutation_unconfirmed',
      status: 503,
    });
    expect(database.rows).toHaveLength(1);
  });

  it('deletes and verifies exact expired lab sessions before creating a new run', async () => {
    const expired = new Date(Date.now() - 1_000);
    await rotateVoiceLabSession('voice-lab-user-1', claims(), 'token-expired', expired);

    const rotated = await rotateVoiceLabSession(
      'voice-lab-user-1',
      claims({
        test_run_id: 'run-002',
        iat: 2_000_000_001,
        nbf: 2_000_000_001,
        exp: 2_000_000_121,
        jti: 'jti-002',
        nonce: 'nonce-002',
      }),
      'token-current',
      new Date(Date.now() + 3_600_000),
    );

    expect(rotated).toMatchObject({
      token: 'token-current',
      idempotentReplay: false,
      expiredLabSessionsRevoked: 1,
    });
    expect(database.rows.map((row) => row.token)).toEqual(['token-current']);
    expect(database.grants.map((row) => row.status)).toEqual(['revoked', 'active']);
  });

  it('serializes grants and rejects an older valid grant without revoking the newer run', async () => {
    const expiry = new Date(Date.now() + 3_600_000);
    await rotateVoiceLabSession(
      'voice-lab-user-1',
      claims({ iat: 2_000_000_010, nbf: 2_000_000_010, exp: 2_000_000_130, test_run_id: 'run-new' }),
      'token-new',
      expiry,
    );

    await expect(rotateVoiceLabSession(
      'voice-lab-user-1',
      claims({ iat: 2_000_000_000, test_run_id: 'run-old' }),
      'token-old',
      expiry,
    )).rejects.toMatchObject({ code: 'voice_lab_stale_grant_rejected', status: 409 });
    expect(database.rows).toHaveLength(1);
    expect(database.rows[0].token).toBe('token-new');
  });

  it('rejects ambiguous distinct grants issued in the same second', async () => {
    const expiry = new Date(Date.now() + 3_600_000);
    await rotateVoiceLabSession('voice-lab-user-1', claims(), 'token-one', expiry);
    await expect(rotateVoiceLabSession(
      'voice-lab-user-1',
      claims({ test_run_id: 'run-002', jti: 'jti-002', nonce: 'nonce-002' }),
      'token-two',
      expiry,
    )).rejects.toMatchObject({ code: 'voice_lab_grant_order_conflict', status: 409 });
    expect(database.rows[0].token).toBe('token-one');
  });

  it('refuses to rotate or sweep a non-lab session on the dedicated identity', async () => {
    const ordinary = { token: 'ordinary-token', expiresAt: new Date(Date.now() + 3_600_000), userAgent: 'Safari' };
    database.rows.push(ordinary);

    await expect(rotateVoiceLabSession(
      'voice-lab-user-1',
      claims(),
      'lab-token',
      new Date(Date.now() + 3_600_000),
    )).rejects.toMatchObject({ code: 'voice_lab_dedicated_principal_session_conflict', status: 409 });
    database.grants.push({
      grant_fingerprint: 'f'.repeat(64),
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-001',
      tombstone_kid: 'v1',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      issued_at: 2_000_000_000,
      expires_at: new Date(Date.now() + 120_000),
      provider_expires_at: new Date('2033-05-18T04:03:20.000Z'),
      retention_hours: 24,
      jti_sha256: 'b'.repeat(64),
      nonce_sha256: 'c'.repeat(64),
      session_token_sha256: 'a'.repeat(64),
      status: 'active',
    });
    await expect(revokeVoiceLabSessions('voice-lab-user-1', claims())).rejects.toMatchObject({
      code: 'voice_lab_dedicated_principal_session_conflict',
      status: 409,
    });
    expect(database.rows).toEqual([ordinary]);
  });

  it('revokes every lab-marked session for the exact dedicated principal', async () => {
    const expiry = new Date(Date.now() + 3_600_000);
    await rotateVoiceLabSession('voice-lab-user-1', claims(), 'token-one', expiry);
    const revoked = await revokeVoiceLabSessions('voice-lab-user-1', claims());

    expect(revoked).toBe(1);
    expect(database.rows).toEqual([]);
    expect(database.grants[0].status).toBe('revoked');
    expect(database.grants[0].principal_id).toMatch(/^hmac:v1:[a-f0-9]{64}$/);
    expect(database.grants[0].principal_id).not.toContain('voice-lab-user-1');
    expect(database.grants[0].test_run_id).toMatch(/^hmac:v1:[a-f0-9]{64}$/);
    expect(database.grants[0].test_run_id).not.toContain('run-001');
    expect(database.grants[0].jti_sha256).toBe('0'.repeat(64));
    expect(database.grants[0].nonce_sha256).toBe('0'.repeat(64));
    expect(database.grants[0].session_token_sha256).toBe('0'.repeat(64));
  });

  it('rejects cleanup-to-replay even when the cleanup response is lost', async () => {
    const grant = claims();
    const expiry = new Date(Date.now() + 3_600_000);
    await rotateVoiceLabSession('voice-lab-user-1', grant, 'token-one', expiry);
    await revokeVoiceLabSessions('voice-lab-user-1', grant);

    await expect(rotateVoiceLabSession(
      'voice-lab-user-1',
      grant,
      'token-replayed-after-cleanup',
      expiry,
    )).rejects.toMatchObject({
      code: 'voice_lab_grant_replayed_after_cleanup',
      status: 409,
    });
    expect(database.rows).toEqual([]);
    expect(database.grants).toHaveLength(1);
  });

  it('allows a distinct same-second suite child only after exact prior cleanup', async () => {
    const first = claims();
    const second = claims({
      test_run_id: 'run-002',
      jti: 'jti-002',
      nonce: 'nonce-002',
      cleanup_obligation_id: '223e4567-e89b-42d3-a456-426614174000',
    });
    const expiry = new Date(Date.now() + 3_600_000);
    await rotateVoiceLabSession('voice-lab-user-1', first, 'token-one', expiry);
    await revokeVoiceLabSessions('voice-lab-user-1', first);
    const rotated = await rotateVoiceLabSession(
      'voice-lab-user-1',
      second,
      'token-two',
      expiry,
    );

    expect(rotated).toMatchObject({ token: 'token-two', idempotentReplay: false });
    expect(database.rows).toHaveLength(1);
    expect(database.grants.map((row) => row.status)).toEqual(['revoked', 'active']);
  });

  it('does not let delayed run-A cleanup revoke a newer active run-B session', async () => {
    const first = claims();
    const second = claims({
      iat: 2_000_000_001,
      nbf: 2_000_000_001,
      exp: 2_000_000_121,
      test_run_id: 'run-002',
      jti: 'jti-002',
      nonce: 'nonce-002',
      cleanup_obligation_id: '223e4567-e89b-42d3-a456-426614174000',
    });
    const expiry = new Date(Date.now() + 3_600_000);
    await rotateVoiceLabSession('voice-lab-user-1', first, 'token-one', expiry);
    await revokeVoiceLabSessions('voice-lab-user-1', first);
    await rotateVoiceLabSession('voice-lab-user-1', second, 'token-two', expiry);

    await expect(revokeVoiceLabSessions('voice-lab-user-1', first)).rejects.toMatchObject({
      code: 'voice_lab_auth_active_run_conflict',
      status: 409,
    });
    expect(database.rows.map((row) => row.token)).toEqual(['token-two']);
    expect(database.grants.find((row) => row.test_run_id === 'run-002')?.status).toBe('active');
  });
});
