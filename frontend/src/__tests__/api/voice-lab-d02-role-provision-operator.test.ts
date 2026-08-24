import { describe, expect, it } from 'vitest';

import {
  loadD02RoleProvisionConfig,
  provisionVoiceLabD02Role,
  VoiceLabD02RoleProvisionError,
} from '../../../scripts/provision-voice-lab-d02-role.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const OWNER_DSN =
  `postgresql://postgres:owner-only-password@db.${PROJECT_REF}.supabase.co:5432/postgres`;
const ROLE_PASSWORD = 'd02-role-password-with-more-than-thirty-two-bytes';

function env(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SOPHIA_VOICE_LAB_D02_ROLE_PROVISION_APPROVED: 'YES',
    SOPHIA_VOICE_LAB_ENVIRONMENT: 'production',
    SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL: OWNER_DSN,
    SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD: ROLE_PASSWORD,
    BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF: PROJECT_REF,
    ...overrides,
  };
}

const exactRole = Object.freeze({
  rolname: 'sophia_voice_lab_gateway',
  rolsuper: false,
  rolinherit: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolcanlogin: true,
  rolreplication: false,
  rolbypassrls: false,
  rolconnlimit: -1,
  password_no_expiry: true,
  membership_free: true,
  supabase_pg17_creator_membership_only: false,
  public_schema_create_denied: true,
});

const supabasePg17PreparedRole = Object.freeze({
  ...exactRole,
  membership_free: false,
  supabase_pg17_creator_membership_only: true,
});

type QueryCall = { text: string; values: unknown[] };
type QueryRows = { rows: Array<Record<string, unknown>> };

class FakeClient {
  readonly calls: QueryCall[] = [];
  released = false;
  preMigration = true;

  constructor(
    private readonly roleResponses: Array<Array<Record<string, unknown>>>,
    private readonly authority = {
      application_schema_count: 3,
      cross_schema_authority_denied: true,
      public_raw_authority_denied: true,
      public_effective_routine_authority_denied: true,
      future_direct_authority_denied: true,
    },
    private readonly identity = {
      session_user_name: 'postgres',
      current_user_name: 'postgres',
      database_name: 'postgres',
      writable: true,
      scram_passwords: true,
      primary_server: true,
    },
  ) {}

  async query(statement: string, values: unknown[] = []): Promise<QueryRows> {
    this.calls.push({ text: statement, values });
    if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
      return { rows: [] };
    }
    if (statement.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (statement.includes('voice_lab_d02_role_owner_identity')) {
      return { rows: [this.identity] };
    }
    if (statement.includes('voice_lab_d02_role_pre_migration_footprint')) {
      return { rows: [{ pre_migration: this.preMigration }] };
    }
    if (statement.includes('voice_lab_d02_role_catalog')) {
      const rows = this.roleResponses.shift();
      if (!rows) throw new Error('unexpected role catalog query');
      return { rows };
    }
    if (statement.includes('voice_lab_d02_role_password_bind')) {
      return { rows: [{ configured: true }] };
    }
    if (statement.includes('$voice_lab_d02_role_create$')) return { rows: [] };
    if (statement.includes('voice_lab_d02_role_password_clear')) {
      return { rows: [{ cleared: true }] };
    }
    if (statement.includes('$voice_lab_d02_role_acl$')) return { rows: [] };
    if (statement.includes('voice_lab_d02_role_authority_attestation')) {
      return { rows: [this.authority] };
    }
    throw new Error('unexpected query');
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  ended = false;

  constructor(readonly client: FakeClient) {}

  async connect(): Promise<FakeClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const safeGatewayIdentity = Object.freeze({
  session_user_name: 'sophia_voice_lab_gateway',
  current_user_name: 'sophia_voice_lab_gateway',
  database_name: 'postgres',
  replication_origin: true,
  writable: true,
  durable_commit: true,
  primary_server: true,
});

class FakeGatewayClient {
  readonly calls: QueryCall[] = [];
  released = false;

  constructor(
    private readonly identity: Record<string, unknown> = safeGatewayIdentity,
  ) {}

  async query(statement: string, values: unknown[] = []): Promise<QueryRows> {
    this.calls.push({ text: statement, values });
    if (!statement.includes('voice_lab_d02_role_login_attestation')) {
      throw new Error('unexpected Gateway login query');
    }
    return { rows: [this.identity] };
  }

  release(): void {
    this.released = true;
  }
}

class FakeGatewayPool {
  ended = false;

  constructor(readonly client = new FakeGatewayClient()) {}

  async connect(): Promise<FakeGatewayClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

describe('Voice Lab D02 database-role provisioning operator', () => {
  it('creates the fixed SCRAM login with a transaction-local parameter and proves zero authority', async () => {
    const config = loadD02RoleProvisionConfig(env());
    const client = new FakeClient([[], [{ ...exactRole }]]);
    const pool = new FakePool(client);
    const gatewayPool = new FakeGatewayPool();

    const result = await provisionVoiceLabD02Role(config, {
      pool,
      gatewayPoolFactory: () => gatewayPool,
    });

    expect(result).toMatchObject({
      ok: true,
      role: 'sophia_voice_lab_gateway',
      created: true,
      credential_action: 'created',
      application_schema_count: 3,
      authority_attested: true,
      login_attested: true,
    });
    expect(client.calls.map(({ text }) => text)).toContain('BEGIN');
    expect(client.calls.map(({ text }) => text)).toContain('COMMIT');
    expect(client.calls.map(({ text }) => text)).not.toContain('ROLLBACK');

    const passwordBind = client.calls.find(({ text }) =>
      text.includes('voice_lab_d02_role_password_bind'));
    expect(passwordBind).toBeDefined();
    expect(passwordBind.values).toEqual([
      'sophia.voice_lab_d02_gateway_password',
      ROLE_PASSWORD,
    ]);
    expect(client.calls.filter(({ values }) => values.includes(ROLE_PASSWORD))).toHaveLength(1);
    expect(client.calls.every(({ text }) => !text.includes(ROLE_PASSWORD))).toBe(true);

    const sql = client.calls.map(({ text }) => text).join('\n');
    expect(sql).toContain('CREATE ROLE sophia_voice_lab_gateway LOGIN NOINHERIT');
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM sophia_voice_lab_gateway');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON SCHEMA %I');
    expect(sql).toContain('has_any_column_privilege');
    expect(sql).toContain('has_sequence_privilege');
    expect(sql).toContain('has_function_privilege');
    expect(sql).toContain('acl.grantee = 0');
    expect(sql).toContain("acl.privilege_type = 'EXECUTE'");
    expect(sql).toContain('acl.grantee = pg_catalog.to_regrole($1)');
    expect(sql).toContain('voice_lab_d02_role_pre_migration_footprint');
    expect(sql).toContain('membership.member = role.oid');
    expect(sql).toContain('membership.roleid = role.oid');
    expect(sql).toContain("grantor_role.rolname = 'supabase_admin'");
    expect(sql).toContain('membership.admin_option = true');
    expect(sql).toContain('membership.inherit_option = false');
    expect(sql).toContain('membership.set_option = false');
    expect(sql).not.toContain('ALTER ROLE');
    expect(gatewayPool.client.calls[0]?.text).toContain(
      'voice_lab_d02_role_login_attestation',
    );
    expect(gatewayPool.client.calls[0]?.text).not.toContain('SET ROLE');
    expect(new URL(config.gatewayDsn).username).toBe('sophia_voice_lab_gateway');
    expect(new URL(config.gatewayDsn).password).not.toBe('owner-only-password');
    expect(JSON.stringify(result)).not.toContain(ROLE_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(OWNER_DSN);
    expect(client.released).toBe(true);
    expect(pool.ended).toBe(true);
    expect(gatewayPool.client.released).toBe(true);
    expect(gatewayPool.ended).toBe(true);
  });

  it('is idempotent and preserves the credential of an already-exact role', async () => {
    const client = new FakeClient([[{ ...exactRole }], [{ ...exactRole }]]);
    const pool = new FakePool(client);
    const gatewayPool = new FakeGatewayPool();

    const result = await provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env()),
      {
        pool,
        gatewayPoolFactory: () => gatewayPool,
      },
    );

    expect(result).toMatchObject({
      created: false,
      credential_action: 'preserved',
    });
    expect(client.calls.some(({ text }) => text.includes('password_bind'))).toBe(false);
    expect(client.calls.some(({ text }) => text.includes('$voice_lab_d02_role_create$'))).toBe(false);
    expect(client.calls.flatMap(({ values }) => values)).not.toContain(ROLE_PASSWORD);
    expect(gatewayPool.client.calls).toHaveLength(1);
  });

  it('commits only the exact Supabase PostgreSQL 17 creator edge in explicit support-preparation mode', async () => {
    const client = new FakeClient([[], [{ ...supabasePg17PreparedRole }]]);
    const pool = new FakePool(client);
    const gatewayPool = new FakeGatewayPool();
    const config = loadD02RoleProvisionConfig(env({
      SOPHIA_VOICE_LAB_D02_SUPABASE_SUPPORT_PREPARE_APPROVED: 'YES',
    }));

    const result = await provisionVoiceLabD02Role(config, {
      pool,
      gatewayPoolFactory: () => gatewayPool,
    });

    expect(result).toMatchObject({
      ok: false,
      created: true,
      authority_attested: true,
      login_attested: true,
      membership_attested: false,
      support_required: true,
      support_action: 'remove_supabase_pg17_creator_membership',
    });
    expect(client.calls.map(({ text }) => text)).toContain('COMMIT');
    expect(client.calls.map(({ text }) => text)).not.toContain('ROLLBACK');
    expect(JSON.stringify(result)).not.toContain(ROLE_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(OWNER_DSN);
  });

  it('does not accept the Supabase PostgreSQL 17 creator edge without explicit support preparation', async () => {
    const client = new FakeClient([[{ ...supabasePg17PreparedRole }]]);

    await expect(provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env()),
      {
        pool: new FakePool(client),
        gatewayPoolFactory: () => new FakeGatewayPool(),
      },
    )).rejects.toMatchObject({ code: 'd02_role_catalog_drift' });

    expect(client.calls.map(({ text }) => text)).toContain('ROLLBACK');
    expect(client.calls.flatMap(({ values }) => values)).not.toContain(ROLE_PASSWORD);
  });

  it('rejects any non-exact membership even in support-preparation mode', async () => {
    const client = new FakeClient([[
      {
        ...supabasePg17PreparedRole,
        supabase_pg17_creator_membership_only: false,
      },
    ]]);

    await expect(provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env({
        SOPHIA_VOICE_LAB_D02_SUPABASE_SUPPORT_PREPARE_APPROVED: 'YES',
      })),
      {
        pool: new FakePool(client),
        gatewayPoolFactory: () => new FakeGatewayPool(),
      },
    )).rejects.toMatchObject({ code: 'd02_role_catalog_drift' });

    expect(client.calls.map(({ text }) => text)).toContain('ROLLBACK');
  });

  it('rejects attribute or either-direction membership drift before sending the password', async () => {
    const drifted = { ...exactRole, rolinherit: true, membership_free: false };
    const client = new FakeClient([[drifted]]);
    const pool = new FakePool(client);

    await expect(provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env()),
      {
        pool,
        gatewayPoolFactory: () => new FakeGatewayPool(),
      },
    )).rejects.toMatchObject({ code: 'd02_role_catalog_drift' });

    expect(client.calls.map(({ text }) => text)).toContain('ROLLBACK');
    expect(client.calls.some(({ text }) => text.includes('$voice_lab_d02_role_acl$'))).toBe(false);
    expect(client.calls.flatMap(({ values }) => values)).not.toContain(ROLE_PASSWORD);
  });

  it('fails closed when PUBLIC or another path leaves effective cross-schema authority', async () => {
    const client = new FakeClient(
      [[{ ...exactRole }], [{ ...exactRole }]],
      {
        application_schema_count: 4,
        cross_schema_authority_denied: false,
        public_raw_authority_denied: true,
        public_effective_routine_authority_denied: true,
        future_direct_authority_denied: true,
      },
    );

    await expect(provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env()),
      {
        pool: new FakePool(client),
        gatewayPoolFactory: () => new FakeGatewayPool(),
      },
    )).rejects.toMatchObject({ code: 'd02_role_authority_drift' });
    expect(client.calls.map(({ text }) => text)).toContain('ROLLBACK');
  });

  it('rejects a PUBLIC-executable public function for prospective and reused roles', async () => {
    const lanes: Array<Array<Record<string, unknown>>> = [
      [],
      [{ ...exactRole }],
    ];

    for (const roleRowsBeforeDdl of lanes) {
      const client = new FakeClient(
        [roleRowsBeforeDdl],
        {
          application_schema_count: 4,
          cross_schema_authority_denied: true,
          public_raw_authority_denied: true,
          public_effective_routine_authority_denied: false,
          future_direct_authority_denied: true,
        },
      );

      await expect(provisionVoiceLabD02Role(
        loadD02RoleProvisionConfig(env()),
        {
          pool: new FakePool(client),
          gatewayPoolFactory: () => new FakeGatewayPool(),
        },
      )).rejects.toMatchObject({ code: 'd02_role_authority_drift' });

      const authorityCall = client.calls.find(({ text }) =>
        text.includes('voice_lab_d02_role_authority_attestation'));
      expect(authorityCall?.text).toContain("namespace.nspname = 'public'");
      expect(authorityCall?.text).toContain('has_function_privilege');
      expect(authorityCall?.text).toContain('acl.grantee = 0');
      expect(authorityCall?.text).toContain("acl.privilege_type = 'EXECUTE'");
      expect(client.calls.map(({ text }) => text)).toContain('ROLLBACK');
      expect(client.calls.some(({ text }) => text.includes('role_password_bind'))).toBe(false);
      expect(client.calls.some(({ text }) => text.includes('$voice_lab_d02_role_create$')))
        .toBe(false);
      expect(client.calls.flatMap(({ values }) => values)).not.toContain(ROLE_PASSWORD);
    }
  });

  it('fails typed when the supplied password cannot open an exact Gateway session', async () => {
    const client = new FakeClient([[{ ...exactRole }], [{ ...exactRole }]]);
    let gatewayPoolEnded = false;
    const gatewayPool = {
      async connect() {
        throw new Error(`password authentication failed ${ROLE_PASSWORD} ${OWNER_DSN}`);
      },
      async end() {
        gatewayPoolEnded = true;
      },
    };

    await expect(provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env()),
      {
        pool: new FakePool(client),
        gatewayPoolFactory: () => gatewayPool,
      },
    )).rejects.toMatchObject({ code: 'd02_role_login_attestation_failed' });

    expect(client.calls.map(({ text }) => text)).toContain('COMMIT');
    expect(client.calls.map(({ text }) => text)).not.toContain('ROLLBACK');
    expect(gatewayPoolEnded).toBe(true);
  });

  it('refuses to mutate the role after any D02 schema footprint exists', async () => {
    const client = new FakeClient([]);
    client.preMigration = false;

    await expect(provisionVoiceLabD02Role(
      loadD02RoleProvisionConfig(env()),
      {
        pool: new FakePool(client),
        gatewayPoolFactory: () => new FakeGatewayPool(),
      },
    )).rejects.toMatchObject({ code: 'd02_role_schema_already_present' });

    expect(client.calls.map(({ text }) => text)).toContain('ROLLBACK');
    expect(client.calls.some(({ text }) => text.includes('role_password_bind'))).toBe(false);
    expect(client.calls.some(({ text }) => text.includes('$voice_lab_d02_role_acl$'))).toBe(false);
  });

  it.each([
    ['approval', { SOPHIA_VOICE_LAB_D02_ROLE_PROVISION_APPROVED: 'NO' }, 'd02_role_provision_approval_required'],
    ['environment', { SOPHIA_VOICE_LAB_ENVIRONMENT: 'preview' }, 'd02_role_environment_invalid'],
    ['owner DSN', { SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL: 'postgresql://postgres:secret@localhost/postgres' }, 'd02_role_owner_target_invalid'],
    ['project', { BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF: 'foreignprojectref123' }, 'd02_role_owner_target_invalid'],
    ['short password', { SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD: 'short' }, 'd02_role_password_invalid'],
    ['reused owner password', { SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD: 'owner-only-password' }, 'd02_role_password_invalid'],
    ['support preparation', { SOPHIA_VOICE_LAB_D02_SUPABASE_SUPPORT_PREPARE_APPROVED: 'NO' }, 'd02_role_supabase_support_preparation_invalid'],
  ])('rejects invalid %s before database access', (_label, override, code) => {
    expect(() => loadD02RoleProvisionConfig(env(override))).toThrowError(
      expect.objectContaining<Partial<VoiceLabD02RoleProvisionError>>({ code }),
    );
  });

  it('sanitizes unexpected database errors instead of echoing a DSN or password', async () => {
    const pool = {
      async connect() {
        throw new Error(`${OWNER_DSN} ${ROLE_PASSWORD}`);
      },
      async end() {},
    };

    let rejection: unknown;
    try {
      await provisionVoiceLabD02Role(
        loadD02RoleProvisionConfig(env()),
        { pool },
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(VoiceLabD02RoleProvisionError);
    const typed = rejection as VoiceLabD02RoleProvisionError;
    expect(typed.code).toBe('d02_role_database_operation_failed');
    expect(typed.message).not.toContain(OWNER_DSN);
    expect(typed.message).not.toContain(ROLE_PASSWORD);
  });
});
