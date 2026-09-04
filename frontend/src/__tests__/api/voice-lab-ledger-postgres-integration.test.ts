import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_URL?.trim();
const describeRealPostgres = databaseUrl ? describe : describe.skip;
const cleanupId = '11111111-1111-4111-8111-111111111111';
const alternateCleanupId = '22222222-2222-4222-8222-222222222222';
const sessionAdmissionId = '33333333-3333-4333-8333-333333333333';
const runtimeCleanupId = '44444444-4444-4444-8444-444444444444';
const runtimeAdmissionId = '55555555-5555-4555-8555-555555555555';
const runtimeRelayId = '66666666-6666-4666-8666-666666666666';
const runnerPath = resolve(process.cwd(), 'scripts/migrate-voice-lab-auth-ledger.mjs');
const finalizeAuthorityKeyId = 'd02-db-finalize-test-v1';
const finalizeAuthoritySecret = ' test-only-d02-finalize-secret-0000000000000000 ';

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function assertDedicatedTestDatabase(raw: string): void {
  const parsed = new URL(raw);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (
    database !== 'voice_lab_test'
    || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== 'YES'
  ) {
    throw new Error(
      'Voice Lab ledger integration requires exact database voice_lab_test '
        + 'and SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES.',
    );
  }
}

async function resetProductObjects(client: Pool | PoolClient): Promise<void> {
  await client.query(`
    ALTER ROLE postgres IN DATABASE voice_lab_test RESET session_replication_role;
    DROP TABLE IF EXISTS public.voice_lab_auth_grants_shadow CASCADE;
    DROP TABLE IF EXISTS public.sophia_session_messages CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_auth_grants CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_d02_product_continuity_observations CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_d02_gateway_relay_leases CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_d02_gateway_capability_uses CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_d02_gateway_settlements CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_d02_gateway_finalize_authority CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_cleanup_scan_cursors CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_cleanup_admissions CASCADE;
    DROP TABLE IF EXISTS public.sophia_voice_lab_cleanup_obligations CASCADE;
    DROP TABLE IF EXISTS public.artifact_registry_records CASCADE;
    DROP TABLE IF EXISTS public.sophia_sessions CASCADE;
    DROP TABLE IF EXISTS public."session" CASCADE;
    DROP FUNCTION IF EXISTS public.sophia_finalize_voice_lab_session CASCADE;
    DROP FUNCTION IF EXISTS public.sophia_purge_voice_lab_session CASCADE;
    DROP FUNCTION IF EXISTS public.sophia_voice_lab_finalization_receipt_sha256 CASCADE;
    DROP FUNCTION IF EXISTS public.sophia_voice_lab_receipt_part CASCADE;
    DROP FUNCTION IF EXISTS public.sophia_voice_lab_message_write_fence() CASCADE;
    DROP FUNCTION IF EXISTS public.sophia_voice_lab_cleanup_write_fence() CASCADE;
    DO $drop_d02_functions$
    DECLARE
      function_row record;
    BEGIN
      FOR function_row IN
        SELECT procedure.oid::regprocedure AS identity
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure.proname LIKE 'sophia_voice_lab_d02_%'
      LOOP
        EXECUTE format('DROP FUNCTION %s CASCADE', function_row.identity);
      END LOOP;
    END
    $drop_d02_functions$;
    DROP ROLE IF EXISTS voice_lab_membership_probe;
    DROP ROLE IF EXISTS voice_lab_foreign_owner;
    DO $drop_runtime_roles$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sophia_voice_lab_gateway') THEN
        DROP OWNED BY sophia_voice_lab_gateway;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'better_auth_app') THEN
        DROP OWNED BY better_auth_app;
      END IF;
    END
    $drop_runtime_roles$;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, sophia_voice_lab_gateway;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres
      REVOKE EXECUTE ON FUNCTIONS FROM sophia_voice_lab_gateway;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres
      REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, sophia_voice_lab_gateway;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres
      REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, sophia_voice_lab_gateway;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, sophia_voice_lab_gateway;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, sophia_voice_lab_gateway;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres
      GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
  `);
}

async function createProductPrerequisites(client: Pool | PoolClient): Promise<void> {
  await client.query(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'better_auth_app') THEN
        CREATE ROLE better_auth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOINHERIT NOREPLICATION NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'sophia_voice_lab_gateway'
      ) THEN
        CREATE ROLE sophia_voice_lab_gateway LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOINHERIT NOREPLICATION NOBYPASSRLS;
      END IF;
    END
    $roles$;
    ALTER ROLE better_auth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
    ALTER ROLE sophia_voice_lab_gateway LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
    DO $clear_runtime_memberships$
    DECLARE
      membership_row record;
    BEGIN
      FOR membership_row IN
        SELECT granted.rolname AS granted_role, member.rolname AS member_role
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
         WHERE granted.rolname IN ('better_auth_app', 'sophia_voice_lab_gateway')
            OR member.rolname IN ('better_auth_app', 'sophia_voice_lab_gateway')
      LOOP
        EXECUTE format(
          'REVOKE %I FROM %I',
          membership_row.granted_role,
          membership_row.member_role
        );
      END LOOP;
    END
    $clear_runtime_memberships$;
    REVOKE CREATE ON SCHEMA public
      FROM better_auth_app, sophia_voice_lab_gateway;
    CREATE TABLE public."session" (
      id text PRIMARY KEY,
      "userId" text NOT NULL,
      token text NOT NULL UNIQUE,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "ipAddress" text,
      "userAgent" text
    );
    CREATE INDEX "session_userId_idx" ON public."session" ("userId");
    GRANT SELECT, INSERT, UPDATE, DELETE ON public."session"
      TO better_auth_app;
    CREATE TABLE public.sophia_sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      thread_id text NOT NULL,
      run_id text,
      mode text NOT NULL DEFAULT 'voice',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'active',
      ended_at timestamptz,
      message_revision bigint NOT NULL DEFAULT 0,
      message_count integer NOT NULL DEFAULT 0,
      transcript_available boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.sophia_session_messages (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL REFERENCES public.sophia_sessions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      thread_id text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      source text NOT NULL DEFAULT 'text',
      final boolean NOT NULL DEFAULT true,
      approximate boolean NOT NULL DEFAULT false,
      turn_id text,
      provider_event_id text,
      sequence integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE public.artifact_registry_records (
      artifact_id text PRIMARY KEY,
      record_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    REVOKE ALL ON TABLE public.sophia_sessions
      FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON TABLE public.sophia_session_messages
      FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON TABLE public.artifact_registry_records
      FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sophia_sessions
      TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sophia_session_messages
      TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.artifact_registry_records
      TO service_role;
  `);
}

async function runOperatorMigration(
  mode: '--apply' | 'preflight',
  options: {
    finalizeKeyId?: string;
    finalizeSecret?: string;
    rotate?: boolean;
    rotationApproved?: boolean;
    killSwitch?: boolean;
  } = {},
): Promise<string> {
  const args = mode === '--apply'
    ? [runnerPath, '--apply', ...(options.rotate ? ['--rotate-d02-finalize-authority'] : [])]
    : [runnerPath];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_DATABASE_URL: databaseUrl,
      SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL: databaseUrl,
      SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED: 'YES',
      BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF: '',
      SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_KEY_ID:
        options.finalizeKeyId ?? finalizeAuthorityKeyId,
      SOPHIA_VOICE_LAB_D02_DATABASE_FINALIZE_HMAC_SECRET:
        options.finalizeSecret ?? finalizeAuthoritySecret,
      SOPHIA_VOICE_LAB_KILL_SWITCH: options.killSwitch ? 'true' : 'false',
      SOPHIA_VOICE_LAB_D02_FINALIZE_AUTHORITY_ROTATION_APPROVED:
        options.rotationApproved ? 'YES' : '',
    },
    timeout: 60_000,
    maxBuffer: 1_000_000,
  });
  return stdout;
}

async function runtimeReadinessAsBetterAuthApp(
  override?: URL,
): Promise<unknown> {
  const runtimeUrl = override ?? new URL(databaseUrl!);
  if (!override) {
    runtimeUrl.username = 'better_auth_app';
    runtimeUrl.password = '';
  }
  const original = {
    betterAuthUrl: process.env.BETTER_AUTH_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    tombstoneKid: process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID,
    tombstoneKeys: process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS,
  };
  process.env.BETTER_AUTH_DATABASE_URL = runtimeUrl.toString();
  process.env.DATABASE_URL = runtimeUrl.toString();
  process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID = 'v1';
  process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS = JSON.stringify({
    v1: 'runtime-readiness-test-key-material-0000000000000000',
  });
  delete globalThis.__sophiaBetterAuthPool;
  try {
    const { assertVoiceLabAuthLedgerReady } = await import(
      '../../server/voice-lab/session-ledger'
    );
    return await assertVoiceLabAuthLedgerReady();
  } finally {
    await globalThis.__sophiaBetterAuthPool?.end();
    delete globalThis.__sophiaBetterAuthPool;
    if (original.betterAuthUrl === undefined) delete process.env.BETTER_AUTH_DATABASE_URL;
    else process.env.BETTER_AUTH_DATABASE_URL = original.betterAuthUrl;
    if (original.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original.databaseUrl;
    if (original.tombstoneKid === undefined) {
      delete process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID;
    } else process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID = original.tombstoneKid;
    if (original.tombstoneKeys === undefined) {
      delete process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS;
    } else process.env.SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS = original.tombstoneKeys;
  }
}

describeRealPostgres('Voice Lab auth-ledger and cleanup-index real Postgres contract', () => {
  let pool: Pool;

  beforeAll(async () => {
    assertDedicatedTestDatabase(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await resetProductObjects(pool);
    await createProductPrerequisites(pool);
    const defaultFunctionAcl = await pool.query<{ policy_installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_default_acl defaults
         WHERE defaults.defaclrole = to_regrole('postgres')
           AND defaults.defaclnamespace = 0
           AND defaults.defaclobjtype = 'f'
           AND (
             SELECT count(*) = 1 AND bool_and(
               acl.grantor = to_regrole('postgres')
               AND acl.grantee = to_regrole('postgres')
               AND acl.privilege_type = 'EXECUTE'
               AND acl.is_grantable = false
             ) FROM aclexplode(defaults.defaclacl) acl
           )
           AND NOT EXISTS (
             SELECT 1 FROM pg_default_acl additive
              WHERE additive.defaclrole = defaults.defaclrole
                AND additive.defaclobjtype = 'f'
                AND additive.defaclnamespace = to_regnamespace('public')
           )
      ) AS policy_installed
    `);
    expect(defaultFunctionAcl.rows).toEqual([{ policy_installed: false }]);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await resetProductObjects(pool);
    await pool.end();
  }, 30_000);

  it('rejects a partial D02 function footprint before fresh DDL', async () => {
    await pool.query(`
      CREATE FUNCTION public.sophia_voice_lab_d02_hmac_sha256(text)
      RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1'
    `);
    await expect(runOperatorMigration('--apply')).rejects.toThrow(
      'Voice Lab D02 schema is partial or unrecognized',
    );
    const presence = await pool.query<{ d02_table_count: string }>(`
      SELECT count(*)::text AS d02_table_count
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND starts_with(relation.relname, 'sophia_voice_lab_d02_')
         AND relation.relkind IN ('r', 'p')
    `);
    expect(presence.rows).toEqual([{ d02_table_count: '0' }]);
    await pool.query(
      'DROP FUNCTION public.sophia_voice_lab_d02_hmac_sha256(text)',
    );
    await expect(runOperatorMigration('--apply', {
      rotate: true,
      rotationApproved: true,
      killSwitch: true,
      finalizeKeyId: 'd02-db-finalize-fresh-rotation-probe',
      finalizeSecret: 'fresh-rotation-probe-secret-0000000000000000000000',
    })).rejects.toThrow(
      'D02 finalize-authority rotation requires an existing current schema',
    );
  });

  it('atomically applies, preflights, uses both exact indexes, and rejects a signed rebind', async () => {
    const applyOutput = await runOperatorMigration('--apply');
    expect(applyOutput).toContain('mode=apply');
    expect(applyOutput).toContain('ready=true');
    const defaultFunctionAcl = await pool.query<{ policy_installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_default_acl defaults
         WHERE defaults.defaclrole = to_regrole('postgres')
           AND defaults.defaclnamespace = 0
           AND defaults.defaclobjtype = 'f'
           AND (
             SELECT count(*) = 1 AND bool_and(
               acl.grantor = to_regrole('postgres')
               AND acl.grantee = to_regrole('postgres')
               AND acl.privilege_type = 'EXECUTE'
               AND acl.is_grantable = false
             ) FROM aclexplode(defaults.defaclacl) acl
           )
           AND NOT EXISTS (
             SELECT 1 FROM pg_default_acl additive
              WHERE additive.defaclrole = defaults.defaclrole
                AND additive.defaclobjtype = 'f'
                AND additive.defaclnamespace = to_regnamespace('public')
           )
      ) AS policy_installed
    `);
    expect(defaultFunctionAcl.rows).toEqual([{ policy_installed: true }]);
    const preflightOutput = await runOperatorMigration('preflight');
    expect(preflightOutput).toContain('mode=preflight');
    expect(preflightOutput).toContain('ready=true');

    await expect(pool.query(
      `INSERT INTO public.sophia_sessions (
         id, user_id, thread_id, mode, metadata, status
       ) VALUES (
         'ordinary-session-probe', 'ordinary-user', 'ordinary-thread',
         'voice', '{}'::jsonb, 'active'
       )`,
    )).resolves.toBeDefined();
    await expect(pool.query(
      `UPDATE public.sophia_sessions
          SET metadata = '{"ordinary_probe":true}'::jsonb
        WHERE id = 'ordinary-session-probe'`,
    )).resolves.toBeDefined();
    await expect(pool.query(
      `DELETE FROM public.sophia_sessions
        WHERE id = 'ordinary-session-probe'`,
    )).resolves.toBeDefined();
    await expect(pool.query(
      `INSERT INTO public.artifact_registry_records (
         artifact_id, record_payload
       ) VALUES ('ordinary-artifact-probe', '{}'::jsonb)`,
    )).resolves.toBeDefined();
    await expect(pool.query(
      `UPDATE public.artifact_registry_records
          SET record_payload = '{"ordinary_probe":true}'::jsonb
        WHERE artifact_id = 'ordinary-artifact-probe'`,
    )).resolves.toBeDefined();
    await expect(pool.query(
      `DELETE FROM public.artifact_registry_records
        WHERE artifact_id = 'ordinary-artifact-probe'`,
    )).resolves.toBeDefined();

    const hmacVector = await pool.query<{ digest: string }>(`
      SELECT encode(public.sophia_voice_lab_d02_hmac_sha256(
        convert_to('key', 'UTF8'),
        convert_to('The quick brown fox jumps over the lazy dog', 'UTF8')
      ), 'hex') AS digest
    `);
    expect(hmacVector.rows).toEqual([{
      digest: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    }]);
    const proofParts = ['cleanup-id', 'request-id'];
    const proofValue = { a: 'alpha', z: 1 };
    const canonicalValue = JSON.stringify(proofValue);
    const valueSha256 = createHash('sha256').update(canonicalValue).digest('hex');
    const proofCore = JSON.stringify({
      authority_key_id: finalizeAuthorityKeyId,
      domain: 'freeze_finalize_v1',
      parts: proofParts,
      value_sha256: valueSha256,
    });
    const proof = createHmac('sha256', finalizeAuthoritySecret)
      .update(proofCore)
      .digest('hex');
    const proofVectors = await pool.query<{
      valid: boolean;
      wrong_domain: boolean;
      wrong_key_id: boolean;
      changed_part: boolean;
      changed_value: boolean;
      unicode_part: boolean;
    }>(`
      SELECT
        public.sophia_voice_lab_d02_finalize_proof_valid(
          $1, 'freeze_finalize_v1', $2::jsonb, $3::jsonb, $4
        ) AS valid,
        public.sophia_voice_lab_d02_finalize_proof_valid(
          $1, 'settlement_finalize_v1', $2::jsonb, $3::jsonb, $4
        ) AS wrong_domain,
        public.sophia_voice_lab_d02_finalize_proof_valid(
          'wrong-key-id', 'freeze_finalize_v1', $2::jsonb, $3::jsonb, $4
        ) AS wrong_key_id,
        public.sophia_voice_lab_d02_finalize_proof_valid(
          $1, 'freeze_finalize_v1', '["cleanup-id","changed"]'::jsonb,
          $3::jsonb, $4
        ) AS changed_part,
        public.sophia_voice_lab_d02_finalize_proof_valid(
          $1, 'freeze_finalize_v1', $2::jsonb, '{"a":"changed","z":1}'::jsonb, $4
        ) AS changed_value,
        public.sophia_voice_lab_d02_finalize_proof_valid(
          $1, 'freeze_finalize_v1', '["é"]'::jsonb, $3::jsonb, $4
        ) AS unicode_part
    `, [finalizeAuthorityKeyId, JSON.stringify(proofParts), canonicalValue, proof]);
    expect(proofVectors.rows).toEqual([{
      valid: true,
      wrong_domain: false,
      wrong_key_id: false,
      changed_part: false,
      changed_value: false,
      unicode_part: false,
    }]);

    const gatewayUrl = new URL(databaseUrl!);
    gatewayUrl.username = 'sophia_voice_lab_gateway';
    gatewayUrl.password = '';
    const gatewayPool = new Pool({ connectionString: gatewayUrl.toString(), max: 1 });
    try {
      const gatewayIdentity = await gatewayPool.query<{
        session_user_name: string;
        current_user_name: string;
        authority_ready: boolean;
      }>(`
        SELECT session_user::text AS session_user_name,
               current_user::text AS current_user_name,
               public.sophia_voice_lab_d02_finalize_authority_ready(
                 $1,
                 $2
               ) AS authority_ready
      `, [
        finalizeAuthorityKeyId,
        createHash('sha256').update(finalizeAuthoritySecret).digest('hex'),
      ]);
      expect(gatewayIdentity.rows).toEqual([{
        session_user_name: 'sophia_voice_lab_gateway',
        current_user_name: 'sophia_voice_lab_gateway',
        authority_ready: true,
      }]);
      await expect(
        gatewayPool.query('SELECT token FROM public."session" LIMIT 1'),
      ).rejects.toThrow(/permission denied/i);
      await expect(gatewayPool.query(`
        SELECT public.sophia_voice_lab_d02_hmac_sha256(
          convert_to('key', 'UTF8'), convert_to('data', 'UTF8')
        )
      `)).rejects.toThrow(/permission denied/i);
    } finally {
      await gatewayPool.end();
    }

    const ownerAsGatewayUrl = new URL(databaseUrl!);
    ownerAsGatewayUrl.searchParams.set(
      'options',
      '-c role=sophia_voice_lab_gateway',
    );
    const ownerAsGateway = new Pool({
      connectionString: ownerAsGatewayUrl.toString(),
      max: 1,
    });
    try {
      const identity = await ownerAsGateway.query<{
        session_user_name: string;
        current_user_name: string;
      }>(`
        SELECT session_user::text AS session_user_name,
               current_user::text AS current_user_name
      `);
      expect(identity.rows).toEqual([{
        session_user_name: 'postgres',
        current_user_name: 'sophia_voice_lab_gateway',
      }]);
    } finally {
      await ownerAsGateway.end();
    }

    await pool.query(`
      CREATE TABLE public.voice_lab_future_acl_probe (secret text);
      GRANT SELECT (secret) ON public.voice_lab_future_acl_probe
        TO sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway has raw public relation authority',
    );
    await pool.query('DROP TABLE public.voice_lab_future_acl_probe');

    await pool.query(`
      CREATE TABLE public.voice_lab_future_maintain_probe (secret text);
      GRANT MAINTAIN ON public.voice_lab_future_maintain_probe
        TO sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway has raw public relation authority',
    );
    await pool.query('DROP TABLE public.voice_lab_future_maintain_probe');

    await pool.query(`
      CREATE VIEW public.voice_lab_future_view_probe AS SELECT id FROM public."session";
      GRANT SELECT ON public.voice_lab_future_view_probe TO sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway has raw public relation authority',
    );
    await pool.query('DROP VIEW public.voice_lab_future_view_probe');

    await pool.query(`
      CREATE SEQUENCE public.voice_lab_future_sequence_probe;
      GRANT USAGE ON SEQUENCE public.voice_lab_future_sequence_probe
        TO sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway has raw public relation authority',
    );
    await pool.query('DROP SEQUENCE public.voice_lab_future_sequence_probe');

    await pool.query(`
      CREATE FUNCTION public.voice_lab_unexpected_gateway_probe()
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS 'SELECT true';
      GRANT EXECUTE ON FUNCTION public.voice_lab_unexpected_gateway_probe() TO PUBLIC
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway effective function authority drifted',
    );
    await pool.query('DROP FUNCTION public.voice_lab_unexpected_gateway_probe()');

    await pool.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres
        GRANT EXECUTE ON FUNCTIONS TO service_role;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO service_role
    `);
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');
    await pool.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres
        REVOKE EXECUTE ON FUNCTIONS FROM service_role;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        REVOKE EXECUTE ON FUNCTIONS FROM service_role
    `);

    await pool.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway database role is missing or overprivileged',
    );
    await pool.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        REVOKE EXECUTE ON FUNCTIONS FROM sophia_voice_lab_gateway
    `);
    await pool.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres
        GRANT SELECT ON TABLES TO sophia_voice_lab_gateway;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT USAGE ON SEQUENCES TO sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway database role is missing or overprivileged',
    );
    await pool.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres
        REVOKE SELECT ON TABLES FROM sophia_voice_lab_gateway;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        REVOKE USAGE ON SEQUENCES FROM sophia_voice_lab_gateway
    `);
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    const ownerSetRoleUrl = new URL(databaseUrl!);
    ownerSetRoleUrl.searchParams.set('options', '-c role=better_auth_app');
    await expect(runtimeReadinessAsBetterAuthApp(ownerSetRoleUrl)).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });

    const runtimePrivileges = await pool.query<{
      auth_crud: boolean;
      obligations_crud: boolean;
      admissions_crud: boolean;
      cursor_select_update: boolean;
      cursor_insert_delete: boolean;
      session_select_update: boolean;
      session_insert_delete: boolean;
      sources_zero_execute: boolean;
      other_d02_execute: boolean;
      d02_raw_access: boolean;
      other_product_access: boolean;
    }>(`
      SELECT
        has_table_privilege('better_auth_app',
          'public.sophia_voice_lab_auth_grants', 'SELECT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_auth_grants', 'INSERT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_auth_grants', 'UPDATE')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_auth_grants', 'DELETE')
          AS auth_crud,
        has_table_privilege('better_auth_app',
          'public.sophia_voice_lab_cleanup_obligations', 'SELECT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_obligations', 'INSERT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_obligations', 'UPDATE')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_obligations', 'DELETE')
          AS obligations_crud,
        has_table_privilege('better_auth_app',
          'public.sophia_voice_lab_cleanup_admissions', 'SELECT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_admissions', 'INSERT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_admissions', 'UPDATE')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_admissions', 'DELETE')
          AS admissions_crud,
        has_table_privilege('better_auth_app',
          'public.sophia_voice_lab_cleanup_scan_cursors', 'SELECT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_scan_cursors', 'UPDATE')
          AS cursor_select_update,
        has_table_privilege('better_auth_app',
          'public.sophia_voice_lab_cleanup_scan_cursors', 'INSERT')
          OR has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_cleanup_scan_cursors', 'DELETE')
          AS cursor_insert_delete,
        has_table_privilege('better_auth_app',
          'public.sophia_sessions', 'SELECT')
          AND has_table_privilege('better_auth_app',
            'public.sophia_sessions', 'UPDATE')
          AS session_select_update,
        has_table_privilege('better_auth_app',
          'public.sophia_sessions', 'INSERT')
          OR has_table_privilege('better_auth_app',
            'public.sophia_sessions', 'DELETE')
          AS session_insert_delete,
        has_function_privilege('better_auth_app',
          'public.sophia_voice_lab_d02_sources_zero(text)', 'EXECUTE')
          AS sources_zero_execute,
        has_function_privilege('better_auth_app',
          'public.sophia_voice_lab_d02_producer_open(text)', 'EXECUTE')
          AS other_d02_execute,
        has_table_privilege('better_auth_app',
          'public.sophia_voice_lab_d02_gateway_settlements', 'SELECT')
          OR has_table_privilege('better_auth_app',
            'public.sophia_voice_lab_d02_gateway_relay_leases', 'SELECT')
          AS d02_raw_access,
        has_table_privilege('better_auth_app',
          'public.sophia_session_messages', 'SELECT')
          OR has_table_privilege('better_auth_app',
            'public.artifact_registry_records', 'SELECT')
          AS other_product_access
    `);
    expect(runtimePrivileges.rows).toEqual([{
      auth_crud: true,
      obligations_crud: true,
      admissions_crud: true,
      cursor_select_update: true,
      cursor_insert_delete: false,
      session_select_update: true,
      session_insert_delete: false,
      sources_zero_execute: true,
      other_d02_execute: false,
      d02_raw_access: false,
      other_product_access: false,
    }]);
    await expect(runtimeReadinessAsBetterAuthApp()).resolves.toMatchObject({
      ready: true,
      table: 'sophia_voice_lab_auth_grants',
    });

    const restrictedRuntimeUrl = new URL(databaseUrl!);
    restrictedRuntimeUrl.username = 'better_auth_app';
    restrictedRuntimeUrl.password = '';
    const restrictedRuntime = new Pool({
      connectionString: restrictedRuntimeUrl.toString(),
      max: 1,
    });
    try {
      const runtimeIdentity = await restrictedRuntime.query<{
        session_user_name: string;
        current_user_name: string;
      }>(`
        SELECT session_user::text AS session_user_name,
               current_user::text AS current_user_name
      `);
      expect(runtimeIdentity.rows).toEqual([{
        session_user_name: 'better_auth_app',
        current_user_name: 'better_auth_app',
      }]);
      await restrictedRuntime.query(
        `INSERT INTO public.sophia_voice_lab_cleanup_obligations (
           cleanup_obligation_id, retention_expires_at, provider_expires_at
         ) VALUES (
           $1, clock_timestamp() + interval '2 hours',
           clock_timestamp() + interval '2 hours'
         )`,
        [runtimeCleanupId],
      );
      await restrictedRuntime.query(
        `INSERT INTO public.sophia_voice_lab_cleanup_admissions (
           admission_id, cleanup_obligation_id, resource_kind, resource_id,
           status, lease_expires_at, resource_expires_at
         ) VALUES (
           $1, $2, 'builder', 'restricted-runtime-builder', 'reserved',
           clock_timestamp() + interval '5 minutes',
           clock_timestamp() + interval '30 minutes'
         )`,
        [runtimeAdmissionId, runtimeCleanupId],
      );
      const reserved = await restrictedRuntime.query(
        `SELECT admission.status
           FROM public.sophia_voice_lab_cleanup_admissions admission
           JOIN public.sophia_voice_lab_cleanup_obligations obligation
             ON obligation.cleanup_obligation_id = admission.cleanup_obligation_id
          WHERE admission.admission_id = $1
            AND obligation.cleanup_obligation_id = $2
          FOR UPDATE OF obligation, admission`,
        [runtimeAdmissionId, runtimeCleanupId],
      );
      expect(reserved.rows).toEqual([{ status: 'reserved' }]);
      await restrictedRuntime.query(
        `UPDATE public.sophia_voice_lab_cleanup_admissions
            SET status = 'allocating', updated_at = clock_timestamp()
          WHERE admission_id = $1`,
        [runtimeAdmissionId],
      );
      const cursorUpdate = await restrictedRuntime.query(
        `UPDATE public.sophia_voice_lab_cleanup_scan_cursors
            SET updated_at = clock_timestamp()
          WHERE cursor_name = 'work_v1'
        RETURNING cursor_name`,
      );
      expect(cursorUpdate.rows).toEqual([{ cursor_name: 'work_v1' }]);

      await pool.query(
        `INSERT INTO public.sophia_voice_lab_d02_gateway_relay_leases (
           relay_id, cleanup_obligation_id, provider_session_id,
           provider_connection_epoch, relay_kind, owner_instance_id_sha256,
           expires_at
         ) VALUES (
           $1, $2, 'restricted-runtime-provider', 1, 'event_stream',
           repeat('7', 64), clock_timestamp() + interval '5 minutes'
         )`,
        [runtimeRelayId, runtimeCleanupId],
      );
      await expect(
        restrictedRuntime.query(
          'SELECT public.sophia_voice_lab_d02_sources_zero($1) AS sources_zero',
          [runtimeCleanupId],
        ),
      ).resolves.toMatchObject({ rows: [{ sources_zero: false }] });
      await expect(
        restrictedRuntime.query(
          'SELECT 1 FROM public.sophia_voice_lab_d02_gateway_relay_leases LIMIT 1',
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        restrictedRuntime.query(
          'SELECT public.sophia_voice_lab_d02_producer_open($1)',
          [runtimeCleanupId],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        restrictedRuntime.query(
          'SELECT 1 FROM public.sophia_session_messages LIMIT 1',
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        restrictedRuntime.query(
          'SELECT 1 FROM public.artifact_registry_records LIMIT 1',
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        restrictedRuntime.query(
          `INSERT INTO public.sophia_voice_lab_cleanup_scan_cursors (cursor_name)
           VALUES ('work_v1')`,
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        restrictedRuntime.query(
          `DELETE FROM public.sophia_voice_lab_cleanup_scan_cursors
            WHERE cursor_name = 'work_v1'`,
        ),
      ).rejects.toThrow(/permission denied/i);

      await pool.query(
        `DELETE FROM public.sophia_voice_lab_d02_gateway_relay_leases
          WHERE relay_id = $1`,
        [runtimeRelayId],
      );
      await expect(
        restrictedRuntime.query(
          'SELECT public.sophia_voice_lab_d02_sources_zero($1) AS sources_zero',
          [runtimeCleanupId],
        ),
      ).resolves.toMatchObject({ rows: [{ sources_zero: true }] });
      await restrictedRuntime.query(
        `DELETE FROM public.sophia_voice_lab_cleanup_admissions
          WHERE admission_id = $1`,
        [runtimeAdmissionId],
      );
      await restrictedRuntime.query(
        `UPDATE public.sophia_voice_lab_cleanup_obligations
            SET state = 'closed', lifecycle_phase = 'finalized',
                closed_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE cleanup_obligation_id = $1`,
        [runtimeCleanupId],
      );
      await restrictedRuntime.query(
        `WITH observed AS (SELECT clock_timestamp() AS observed_at)
         UPDATE public.sophia_voice_lab_cleanup_obligations obligation
            SET state = 'complete',
                live_cleanup_completed_at = observed.observed_at,
                completed_at = observed.observed_at,
                purge_after = obligation.retention_expires_at
                  + interval '10 minutes',
                updated_at = observed.observed_at
           FROM observed
          WHERE obligation.cleanup_obligation_id = $1`,
        [runtimeCleanupId],
      );
      const deleted = await restrictedRuntime.query(
        `DELETE FROM public.sophia_voice_lab_cleanup_obligations
          WHERE cleanup_obligation_id = $1
        RETURNING cleanup_obligation_id`,
        [runtimeCleanupId],
      );
      expect(deleted.rows).toEqual([{
        cleanup_obligation_id: runtimeCleanupId,
      }]);
    } finally {
      await restrictedRuntime.end();
    }

    await pool.query(`CREATE ROLE voice_lab_membership_probe NOLOGIN`);
    await pool.query(
      `GRANT sophia_voice_lab_gateway TO voice_lab_membership_probe`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab D02 Gateway database role is missing or overprivileged',
    );
    await expect(runtimeReadinessAsBetterAuthApp()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    await pool.query(
      `REVOKE sophia_voice_lab_gateway FROM voice_lab_membership_probe`,
    );

    await pool.query(`GRANT better_auth_app TO voice_lab_membership_probe`);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab runtime database role is missing or overprivileged',
    );
    await expect(runtimeReadinessAsBetterAuthApp()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    await pool.query(`REVOKE better_auth_app FROM voice_lab_membership_probe`);
    await pool.query(`DROP ROLE voice_lab_membership_probe`);
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(`GRANT service_role TO better_auth_app`);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab runtime database role is missing or overprivileged',
    );
    await pool.query(`REVOKE service_role FROM better_auth_app`);

    await pool.query(`GRANT CREATE ON SCHEMA public TO better_auth_app`);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab runtime database role is missing or overprivileged',
    );
    await pool.query(`REVOKE CREATE ON SCHEMA public FROM better_auth_app`);

    await pool.query(
      `GRANT INSERT ON public.sophia_voice_lab_cleanup_scan_cursors
         TO better_auth_app`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab cleanup control table privileges are invalid',
    );
    await expect(runtimeReadinessAsBetterAuthApp()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    await pool.query(
      `REVOKE INSERT ON public.sophia_voice_lab_cleanup_scan_cursors
         FROM better_auth_app`,
    );

    await pool.query(
      `REVOKE DELETE ON public.sophia_voice_lab_cleanup_admissions
         FROM better_auth_app`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab cleanup control table privileges are invalid',
    );
    await pool.query(
      `GRANT DELETE ON public.sophia_voice_lab_cleanup_admissions
         TO better_auth_app`,
    );

    await pool.query(
      `GRANT SELECT ON public.sophia_session_messages TO better_auth_app`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab product table privileges are invalid',
    );
    await expect(runtimeReadinessAsBetterAuthApp()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    await pool.query(
      `REVOKE SELECT ON public.sophia_session_messages FROM better_auth_app`,
    );

    await pool.query(
      `GRANT EXECUTE ON FUNCTION
         public.sophia_voice_lab_d02_producer_open(text)
         TO better_auth_app`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab governed function sophia_voice_lab_d02_producer_open drifted',
    );
    await expect(runtimeReadinessAsBetterAuthApp()).rejects.toMatchObject({
      code: 'voice_lab_auth_ledger_not_ready',
      status: 503,
    });
    await pool.query(
      `REVOKE EXECUTE ON FUNCTION
         public.sophia_voice_lab_d02_producer_open(text)
         FROM better_auth_app`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `DELETE FROM public.sophia_voice_lab_cleanup_scan_cursors
        WHERE cursor_name = 'complete_purge_v1'`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab cleanup scan cursor seed set drifted',
    );
    await pool.query(
      `INSERT INTO public.sophia_voice_lab_cleanup_scan_cursors (cursor_name)
       VALUES ('complete_purge_v1')`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `ALTER TABLE public.sophia_voice_lab_auth_grants
         ALTER COLUMN grant_fingerprint TYPE character(63)`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab auth-ledger table column shape is invalid',
    );
    await pool.query(
      `ALTER TABLE public.sophia_voice_lab_auth_grants
         ALTER COLUMN grant_fingerprint TYPE character(64)`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(`CREATE ROLE voice_lab_foreign_owner NOLOGIN`);
    await pool.query(`
      DO $owner_transfer$
      DECLARE
        table_name text;
        function_row record;
      BEGIN
        FOREACH table_name IN ARRAY ARRAY[
          'sophia_voice_lab_auth_grants',
          'sophia_voice_lab_cleanup_obligations',
          'sophia_voice_lab_cleanup_admissions',
          'sophia_voice_lab_cleanup_scan_cursors',
          'sophia_sessions',
          'sophia_session_messages',
          'artifact_registry_records'
        ] LOOP
          EXECUTE format(
            'ALTER TABLE public.%I OWNER TO voice_lab_foreign_owner',
            table_name
          );
        END LOOP;
        FOR function_row IN
          SELECT proc.oid::regprocedure AS identity
            FROM pg_proc proc
            JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
           WHERE namespace.nspname = 'public'
             AND proc.proname = ANY(ARRAY[
               'sophia_voice_lab_receipt_part',
               'sophia_voice_lab_finalization_receipt_sha256',
               'sophia_finalize_voice_lab_session',
               'sophia_purge_voice_lab_session',
               'sophia_voice_lab_cleanup_write_fence',
               'sophia_voice_lab_message_write_fence'
             ])
        LOOP
          EXECUTE format(
            'ALTER FUNCTION %s OWNER TO voice_lab_foreign_owner',
            function_row.identity
          );
        END LOOP;
      END
      $owner_transfer$;
    `);
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab auth-ledger operator role lacks required privileges',
    );
    await pool.query(`
      DO $owner_restore$
      DECLARE
        table_name text;
        function_row record;
      BEGIN
        FOREACH table_name IN ARRAY ARRAY[
          'sophia_voice_lab_auth_grants',
          'sophia_voice_lab_cleanup_obligations',
          'sophia_voice_lab_cleanup_admissions',
          'sophia_voice_lab_cleanup_scan_cursors',
          'sophia_sessions',
          'sophia_session_messages',
          'artifact_registry_records'
        ] LOOP
          EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', table_name);
        END LOOP;
        FOR function_row IN
          SELECT proc.oid::regprocedure AS identity
            FROM pg_proc proc
            JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
           WHERE namespace.nspname = 'public'
             AND proc.proname = ANY(ARRAY[
               'sophia_voice_lab_receipt_part',
               'sophia_voice_lab_finalization_receipt_sha256',
               'sophia_finalize_voice_lab_session',
               'sophia_purge_voice_lab_session',
               'sophia_voice_lab_cleanup_write_fence',
               'sophia_voice_lab_message_write_fence'
             ])
        LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', function_row.identity);
        END LOOP;
      END
      $owner_restore$;
      DROP ROLE voice_lab_foreign_owner;
    `);
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    const providerExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const authExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const expectedDeployment = {
      backend: 'a'.repeat(40),
      voice: 'b'.repeat(40),
      frontend: 'c'.repeat(40),
    };
    const authToken = 'voice-lab-test-session-token';
    await pool.query(
      `INSERT INTO public."session" (
         id, "userId", token, "expiresAt", "userAgent"
       ) VALUES (
         'better-auth-session-one', 'voice-lab-principal', $1,
         $2, 'sophia-voice-lab/test'
       )`,
      [authToken, authExpiresAt],
    );
    await pool.query(
      `INSERT INTO public.sophia_voice_lab_cleanup_obligations (
         cleanup_obligation_id, state, lifecycle_phase,
         retention_expires_at, provider_expires_at
       ) VALUES ($1, 'open', 'auth_provisional', $2, $2)`,
      [cleanupId, providerExpiresAt],
    );
    await pool.query(
      `INSERT INTO public.sophia_voice_lab_auth_grants (
         grant_fingerprint, principal_id, test_run_id, tombstone_kid,
         cleanup_obligation_id, issued_at, expires_at, provider_expires_at,
         retention_hours, jti_sha256, nonce_sha256, session_token_sha256,
         status
       ) VALUES (
         repeat('1', 64), 'voice-lab-principal', 'run-one', 'v1', $1,
         1, $2, $3, 24,
         repeat('2', 64), repeat('3', 64),
         encode(sha256(convert_to($4, 'UTF8')), 'hex'), 'active'
       )`,
      [cleanupId, authExpiresAt, providerExpiresAt, authToken],
    );
    await pool.query(
      `INSERT INTO public.sophia_voice_lab_cleanup_admissions (
         admission_id, cleanup_obligation_id, resource_kind, resource_id,
         status, lease_expires_at, resource_expires_at
       ) VALUES (
         $1, $2, 'session', 'thread-one', 'reserved',
         clock_timestamp() + interval '60 seconds', $3
       )`,
      [sessionAdmissionId, cleanupId, providerExpiresAt],
    );
    await pool.query(
      `INSERT INTO public.sophia_sessions (
         id, user_id, thread_id, run_id, mode, metadata, status, ended_at
       ) VALUES ($1, 'voice-lab-principal', 'thread-one', 'run-one',
                 'voice', $2::jsonb, 'active', NULL)`,
      [
        'session-one',
        JSON.stringify({
          synthetic_voice_lab: {
            synthetic: true,
            cleanup_obligation_id: cleanupId,
            cleanup_admission_id: sessionAdmissionId,
            principal_id: 'voice-lab-principal',
            test_run_id: 'run-one',
            scenario_id: 'V-A01',
            scenario_version: '1.0.0',
            environment: 'test',
            retention_hours: 24,
            provider_expires_at: providerExpiresAt,
          },
          expected_deployment: expectedDeployment,
          memory_retrieval_disabled: true,
          inactivity_finalization_disabled: true,
          offline_pipeline_disabled: true,
          memory_learning_disabled: true,
          ordinary_analytics_disabled: true,
          ordinary_projects_disabled: true,
          shared_spaces_disabled: true,
        }),
      ],
    );
    const runtimeSessionUrl = new URL(databaseUrl!);
    runtimeSessionUrl.username = 'better_auth_app';
    runtimeSessionUrl.password = '';
    const runtimeSessionPool = new Pool({
      connectionString: runtimeSessionUrl.toString(),
      max: 1,
    });
    const runtimeSessionClient = await runtimeSessionPool.connect();
    try {
      await runtimeSessionClient.query('BEGIN');
      const lockedSession = await runtimeSessionClient.query<{
        cleanup_obligation_id: string;
        synthetic: boolean;
      }>(
        `SELECT obligation.cleanup_obligation_id,
                session.metadata -> 'synthetic_voice_lab' -> 'synthetic'
                  AS synthetic
           FROM public.sophia_sessions session
           JOIN public.sophia_voice_lab_cleanup_obligations obligation
             ON obligation.cleanup_obligation_id =
                session.metadata -> 'synthetic_voice_lab'
                  ->> 'cleanup_obligation_id'
          WHERE session.id = 'session-one'
          FOR UPDATE OF obligation, session`,
      );
      expect(lockedSession.rows).toEqual([{
        cleanup_obligation_id: cleanupId,
        synthetic: true,
      }]);
      const updatedSession = await runtimeSessionClient.query<{
        runtime_acl_probe: boolean;
        updated_at: Date;
      }>(
        `UPDATE public.sophia_sessions
            SET metadata = jsonb_set(
                  metadata, '{runtime_acl_probe}', 'true'::jsonb, true
                ),
                updated_at = date_trunc('milliseconds', clock_timestamp())
          WHERE id = 'session-one'
        RETURNING metadata -> 'runtime_acl_probe' AS runtime_acl_probe,
                  updated_at`,
      );
      expect(updatedSession.rows).toHaveLength(1);
      expect(updatedSession.rows[0].runtime_acl_probe).toBe(true);
      expect(updatedSession.rows[0].updated_at).toBeInstanceOf(Date);

      await runtimeSessionClient.query('SAVEPOINT signed_binding_probe');
      await expect(
        runtimeSessionClient.query(
          `UPDATE public.sophia_sessions
              SET metadata = jsonb_set(
                    metadata,
                    '{synthetic_voice_lab,cleanup_obligation_id}',
                    to_jsonb($1::text)
                  )
            WHERE id = 'session-one'`,
          [alternateCleanupId],
        ),
      ).rejects.toThrow('synthetic session signed binding is immutable');
      await runtimeSessionClient.query('ROLLBACK TO SAVEPOINT signed_binding_probe');
      await runtimeSessionClient.query('ROLLBACK');
    } finally {
      runtimeSessionClient.release();
      await runtimeSessionPool.end();
    }
    const promoted = await pool.query(
      `SELECT metadata -> 'synthetic_voice_lab' ->> 'retention_expires_at'
              AS retention_expires_at
         FROM public.sophia_sessions WHERE id = 'session-one'`,
    );
    const retentionExpiresAt = promoted.rows[0].retention_expires_at as string;
    await pool.query(
      `INSERT INTO public.artifact_registry_records (artifact_id, record_payload)
       VALUES ($1, $2::jsonb)`,
      [
        'artifact-one',
        JSON.stringify({
          synthetic_test: true,
          cleanup_obligation_id: cleanupId,
          user_id: 'voice-lab-principal',
          test_principal_id: 'voice-lab-principal',
          test_run_id: 'run-one',
          scenario_id: 'V-A01',
          scenario_version: '1.0.0',
          environment: 'test',
          retention_hours: 24,
          retention_anchor: 'finalized_at',
          retention_anchor_at: '2100-01-01T00:00:00.000Z',
          retention_expires_at: retentionExpiresAt,
          provider_expires_at: providerExpiresAt,
          deployment_identity: expectedDeployment,
        }),
      ],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const sessionPlan = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM public.sophia_sessions
          WHERE metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true'
            AND metadata -> 'synthetic_voice_lab' ->> 'cleanup_obligation_id' = $1
          LIMIT 2`,
        [cleanupId],
      );
      const artifactPlan = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT * FROM public.artifact_registry_records
          WHERE record_payload ->> 'synthetic_test' = 'true'
            AND record_payload ->> 'cleanup_obligation_id' = $1
          ORDER BY artifact_id ASC
          LIMIT 1001`,
        [cleanupId],
      );
      expect(JSON.stringify(sessionPlan.rows)).toContain(
        'sophia_sessions_voice_lab_cleanup_obligation_idx',
      );
      expect(JSON.stringify(artifactPlan.rows)).toContain(
        'artifact_registry_voice_lab_cleanup_obligation_idx',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await expect(
      pool.query(
        `UPDATE public.sophia_sessions
            SET metadata = jsonb_set(
              metadata,
              '{synthetic_voice_lab,cleanup_obligation_id}',
              to_jsonb($1::text)
            )
          WHERE id = 'session-one'`,
        [alternateCleanupId],
      ),
    ).rejects.toThrow('synthetic session signed binding is immutable');
    await expect(
      pool.query(
        `UPDATE public.artifact_registry_records
            SET record_payload = jsonb_set(
              record_payload,
              '{cleanup_obligation_id}',
              to_jsonb($1::text)
            )
          WHERE artifact_id = 'artifact-one'`,
        [alternateCleanupId],
      ),
    ).rejects.toThrow('synthetic artifact signed binding is immutable');

    await pool.query(
      `CREATE TRIGGER unexpected_voice_lab_trigger
       BEFORE INSERT OR UPDATE OR DELETE ON public.sophia_sessions
       FOR EACH ROW EXECUTE FUNCTION public.sophia_voice_lab_cleanup_write_fence()`,
    );
    await expect(
      runOperatorMigration('preflight'),
    ).rejects.toThrow('Voice Lab cleanup write-fence trigger set drifted');
    await pool.query(
      `DROP TRIGGER unexpected_voice_lab_trigger ON public.sophia_sessions`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `ALTER TABLE public.sophia_session_messages ENABLE ROW LEVEL SECURITY;
       ALTER TABLE public.sophia_session_messages FORCE ROW LEVEL SECURITY`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab product table sophia_session_messages required columns drifted',
    );
    await pool.query(
      `ALTER TABLE public.sophia_session_messages NO FORCE ROW LEVEL SECURITY;
       ALTER TABLE public.sophia_session_messages DISABLE ROW LEVEL SECURITY`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    const foreignKeyTrigger = await pool.query<{
      tablename: string;
      tgname: string;
    }>(
      `SELECT child.relname AS tablename, trigger.tgname
         FROM pg_trigger trigger
         JOIN pg_class child ON child.oid = trigger.tgrelid
        WHERE trigger.tgconstraint = (
          SELECT fk.oid FROM pg_constraint fk
           WHERE fk.conname = 'sophia_session_messages_session_id_fkey'
             AND fk.conrelid = 'public.sophia_session_messages'::regclass
        )
        ORDER BY child.relname, trigger.tgname
        LIMIT 1`,
    );
    expect(foreignKeyTrigger.rows).toHaveLength(1);
    const triggerTable = quoteIdentifier(foreignKeyTrigger.rows[0].tablename);
    const triggerName = quoteIdentifier(foreignKeyTrigger.rows[0].tgname);
    await pool.query(
      `ALTER TABLE public.${triggerTable} DISABLE TRIGGER ${triggerName}`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab transcript parent foreign-key triggers drifted',
    );
    await pool.query(
      `ALTER TABLE public.${triggerTable} ENABLE TRIGGER ${triggerName}`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    const admissionForeignKeyTrigger = await pool.query<{
      tablename: string;
      tgname: string;
    }>(
      `SELECT relation.relname AS tablename, trigger.tgname
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
        WHERE trigger.tgconstraint = (
          SELECT fk.oid FROM pg_constraint fk
           WHERE fk.conname =
                 'sophia_voice_lab_cleanup_admissions_cleanup_obligation_id_fkey'
             AND fk.conrelid =
                 'public.sophia_voice_lab_cleanup_admissions'::regclass
        )
        ORDER BY relation.relname, trigger.tgname
        LIMIT 1`,
    );
    expect(admissionForeignKeyTrigger.rows).toHaveLength(1);
    const admissionTriggerTable = quoteIdentifier(
      admissionForeignKeyTrigger.rows[0].tablename,
    );
    const admissionTriggerName = quoteIdentifier(
      admissionForeignKeyTrigger.rows[0].tgname,
    );
    await pool.query(
      `ALTER TABLE public.${admissionTriggerTable}
       DISABLE TRIGGER ${admissionTriggerName}`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab cleanup admission foreign-key triggers drifted',
    );
    await pool.query(
      `ALTER TABLE public.${admissionTriggerTable}
       ENABLE TRIGGER ${admissionTriggerName}`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `CREATE TABLE public.voice_lab_auth_grants_shadow ()
       INHERITS (public.sophia_voice_lab_auth_grants)`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab auth-ledger operator role lacks required privileges',
    );
    await pool.query(`DROP TABLE public.voice_lab_auth_grants_shadow`);
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `CREATE RULE voice_lab_session_insert_bypass AS
       ON INSERT TO public."session" DO INSTEAD NOTHING`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab Better Auth session relation drifted',
    );
    await pool.query(
      `DROP RULE voice_lab_session_insert_bypass ON public."session"`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `CREATE TRIGGER unexpected_voice_lab_control_trigger
       BEFORE UPDATE ON public.sophia_voice_lab_cleanup_obligations
       FOR EACH ROW EXECUTE FUNCTION public.sophia_voice_lab_cleanup_write_fence()`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab cleanup write-fence trigger set drifted',
    );
    await pool.query(
      `DROP TRIGGER unexpected_voice_lab_control_trigger
       ON public.sophia_voice_lab_cleanup_obligations`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `ALTER TABLE public.artifact_registry_records
       DROP CONSTRAINT artifact_registry_records_pkey`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab product primary-key set drifted',
    );
    await pool.query(
      `ALTER TABLE public.artifact_registry_records
       ADD CONSTRAINT artifact_registry_records_pkey PRIMARY KEY (artifact_id)`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `ALTER TABLE public."session" DROP CONSTRAINT session_token_key`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab Better Auth session index set drifted',
    );
    await pool.query(
      `ALTER TABLE public."session"
       ADD CONSTRAINT session_token_key UNIQUE (token)`,
    );
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    await pool.query(
      `ALTER ROLE postgres IN DATABASE voice_lab_test
       SET session_replication_role = 'replica'`,
    );
    try {
      await expect(runOperatorMigration('preflight')).rejects.toThrow(
        'Voice Lab database session settings are unsafe',
      );
    } finally {
      await pool.query(
        `ALTER ROLE postgres IN DATABASE voice_lab_test
         RESET session_replication_role`,
      );
    }
    await expect(runOperatorMigration('preflight')).resolves.toContain('ready=true');

    const rotatedKeyId = 'd02-db-finalize-test-v2';
    const rotatedSecret = 'rotated-test-only-d02-finalize-secret-000000000000';
    await expect(runOperatorMigration('--apply', {
      rotate: true,
      rotationApproved: true,
      killSwitch: true,
    })).rejects.toThrow(
      'D02 finalize-authority rotation requires a distinct key id and a quiescent D02 plane',
    );
    await expect(runOperatorMigration('--apply', {
      rotate: true,
      rotationApproved: true,
      killSwitch: true,
      finalizeKeyId: rotatedKeyId,
    })).rejects.toThrow(
      'D02 finalize-authority rotation requires a distinct key id and a quiescent D02 plane',
    );
    await expect(runOperatorMigration('--apply', {
      rotate: true,
      finalizeKeyId: rotatedKeyId,
      finalizeSecret: rotatedSecret,
    })).rejects.toThrow(
      'D02 finalize-authority rotation requires the kill switch and explicit maintenance approval',
    );
    const rotatedOutput = await runOperatorMigration('--apply', {
      rotate: true,
      rotationApproved: true,
      killSwitch: true,
      finalizeKeyId: rotatedKeyId,
      finalizeSecret: rotatedSecret,
    });
    expect(rotatedOutput).toContain(
      `finalize_authority_rotated_from=${finalizeAuthorityKeyId}`,
    );
    expect(rotatedOutput).toContain(`finalize_authority_rotated_to=${rotatedKeyId}`);
    const restoredOutput = await runOperatorMigration('--apply', {
      rotate: true,
      rotationApproved: true,
      killSwitch: true,
      finalizeKeyId: finalizeAuthorityKeyId,
      finalizeSecret: finalizeAuthoritySecret,
    });
    expect(restoredOutput).toContain(`finalize_authority_rotated_from=${rotatedKeyId}`);
    expect(restoredOutput).toContain(
      `finalize_authority_rotated_to=${finalizeAuthorityKeyId}`,
    );

    await pool.query(
      `ALTER TABLE public.sophia_session_messages DROP COLUMN user_id`,
    );
    await expect(runOperatorMigration('preflight')).rejects.toThrow(
      'Voice Lab product table sophia_session_messages required columns drifted',
    );
  }, 90_000);
});
