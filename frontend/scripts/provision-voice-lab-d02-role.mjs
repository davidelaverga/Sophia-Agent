import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

const D02_ROLE = 'sophia_voice_lab_gateway';
const OWNER_ROLE = 'postgres';
const PASSWORD_GUC = 'sophia.voice_lab_d02_gateway_password';
const ADVISORY_LOCK_SQL = `SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('sophia-voice-lab-d02-role-v1', 731946)
)`;

const SUPABASE_PLATFORM_SCHEMA_NAMES = `
  'auth', 'extensions', 'graphql', 'graphql_public', 'net', 'pgbouncer',
  'realtime', 'storage', 'supabase_functions', 'vault'`;

const APPLICATION_SCHEMAS = `
  SELECT namespace.oid, namespace.nspname
    FROM pg_catalog.pg_namespace namespace
   WHERE namespace.nspname <> 'public'
     AND namespace.nspname <> 'information_schema'
     AND namespace.nspname !~ '^pg_'
     AND namespace.nspname NOT IN (${SUPABASE_PLATFORM_SCHEMA_NAMES})
     AND (
       NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_extension extension_row
          WHERE extension_row.extnamespace = namespace.oid
       )
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.pg_class relation
          WHERE relation.relnamespace = namespace.oid
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND NOT EXISTS (
              SELECT 1
                FROM pg_catalog.pg_depend dependency
               WHERE dependency.classid =
                     pg_catalog.to_regclass('pg_catalog.pg_class')
                 AND dependency.objid = relation.oid
                 AND dependency.deptype = 'e'
            )
       )
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.pg_proc procedure
          WHERE procedure.pronamespace = namespace.oid
            AND NOT EXISTS (
              SELECT 1
                FROM pg_catalog.pg_depend dependency
               WHERE dependency.classid =
                     pg_catalog.to_regclass('pg_catalog.pg_proc')
                 AND dependency.objid = procedure.oid
                 AND dependency.deptype = 'e'
            )
       )
     )`;

const SUPABASE_PLATFORM_SCHEMAS = `
  SELECT namespace.oid, namespace.nspname
    FROM pg_catalog.pg_namespace namespace
   WHERE namespace.nspname IN (${SUPABASE_PLATFORM_SCHEMA_NAMES})`;

const ROLE_CATALOG_SQL = `
  SELECT /* voice_lab_d02_role_catalog */
         role.rolname, role.rolsuper, role.rolinherit,
         role.rolcreaterole, role.rolcreatedb, role.rolcanlogin,
         role.rolreplication, role.rolbypassrls, role.rolconnlimit,
         role.rolvaliduntil IS NULL AS password_no_expiry,
         NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_auth_members membership
            WHERE membership.member = role.oid
               OR membership.roleid = role.oid
         ) AS membership_free,
         COALESCE((
           SELECT count(*) = 1
              AND bool_and(
                membership.roleid = role.oid
                AND member_role.rolname = 'postgres'
                AND grantor_role.rolname = 'supabase_admin'
                AND membership.admin_option = true
                AND membership.inherit_option = false
                AND membership.set_option = false
              )
             FROM pg_catalog.pg_auth_members membership
             JOIN pg_catalog.pg_roles member_role
               ON member_role.oid = membership.member
             JOIN pg_catalog.pg_roles grantor_role
               ON grantor_role.oid = membership.grantor
            WHERE membership.member = role.oid
               OR membership.roleid = role.oid
         ), false) AS supabase_pg17_creator_membership_only,
         NOT pg_catalog.has_schema_privilege(role.oid, 'public', 'CREATE')
           AS public_schema_create_denied
    FROM pg_catalog.pg_roles role
   WHERE role.rolname = $1`;

const CREATE_ROLE_SQL = `
  DO $voice_lab_d02_role_create$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname = 'sophia_voice_lab_gateway'
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE ROLE sophia_voice_lab_gateway LOGIN NOINHERIT '
        || 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '
        || 'CONNECTION LIMIT -1 PASSWORD %L',
        pg_catalog.current_setting('sophia.voice_lab_d02_gateway_password')
      );
    END IF;
  END
  $voice_lab_d02_role_create$`;

const REVOKE_PUBLIC_APPLICATION_ROUTINE_AUTHORITY_SQL = `
  DO $voice_lab_d02_public_routine_acl$
  DECLARE
    routine_row record;
  BEGIN
    FOR routine_row IN
      SELECT namespace.nspname,
             procedure.proname,
             pg_catalog.pg_get_function_identity_arguments(procedure.oid)
               AS identity_arguments
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.proowner = pg_catalog.to_regrole('postgres')
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_depend dependency
            WHERE dependency.classid =
                  pg_catalog.to_regclass('pg_catalog.pg_proc')
              AND dependency.objid = procedure.oid
              AND dependency.deptype = 'e'
         )
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.aclexplode(
               COALESCE(
                 procedure.proacl,
                 pg_catalog.acldefault('f', procedure.proowner)
               )
             ) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         )
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON ROUTINE %I.%I(%s) FROM PUBLIC',
        routine_row.nspname,
        routine_row.proname,
        routine_row.identity_arguments
      );
    END LOOP;
  END
  $voice_lab_d02_public_routine_acl$`;

const REVOKE_DIRECT_AUTHORITY_SQL = `
  DO $voice_lab_d02_role_acl$
  DECLARE
    schema_row record;
    relation_row record;
    column_acl_row record;
    routine_row record;
  BEGIN
    REVOKE CREATE ON SCHEMA public FROM sophia_voice_lab_gateway;

    FOR schema_row IN
      SELECT application_schema.oid, application_schema.nspname
        FROM (${APPLICATION_SCHEMAS}) application_schema
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = application_schema.oid
       WHERE namespace.nspowner = pg_catalog.to_regrole('postgres')
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM sophia_voice_lab_gateway',
        schema_row.nspname
      );
    END LOOP;

    FOR relation_row IN
      WITH application_schemas AS (${APPLICATION_SCHEMAS})
      SELECT namespace.nspname, relation.relname, relation.relkind
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
       WHERE (
         namespace.nspname = 'public'
         OR namespace.oid IN (SELECT oid FROM application_schemas)
       )
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND relation.relowner = pg_catalog.to_regrole('postgres')
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_depend dependency
            WHERE dependency.classid =
                  pg_catalog.to_regclass('pg_catalog.pg_class')
              AND dependency.objid = relation.oid
              AND dependency.deptype = 'e'
         )
    LOOP
      IF relation_row.relkind = 'S' THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I '
          || 'FROM sophia_voice_lab_gateway',
          relation_row.nspname,
          relation_row.relname
        );
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %I.%I '
          || 'FROM sophia_voice_lab_gateway',
          relation_row.nspname,
          relation_row.relname
        );
      END IF;
    END LOOP;

    FOR column_acl_row IN
      WITH application_schemas AS (${APPLICATION_SCHEMAS})
      SELECT namespace.nspname, relation.relname, attribute.attname,
             acl.privilege_type
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = relation.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
       WHERE (
         namespace.nspname = 'public'
         OR namespace.oid IN (SELECT oid FROM application_schemas)
       )
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND relation.relowner = pg_catalog.to_regrole('postgres')
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl.grantee = pg_catalog.to_regrole('sophia_voice_lab_gateway')
         AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE %s (%I) ON TABLE %I.%I FROM sophia_voice_lab_gateway',
        column_acl_row.privilege_type,
        column_acl_row.attname,
        column_acl_row.nspname,
        column_acl_row.relname
      );
    END LOOP;

    FOR routine_row IN
      WITH application_schemas AS (${APPLICATION_SCHEMAS})
      SELECT namespace.nspname, procedure.proname, procedure.prokind,
             pg_catalog.pg_get_function_identity_arguments(procedure.oid)
               AS identity_arguments
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = procedure.pronamespace
       WHERE (
         namespace.nspname = 'public'
         OR namespace.oid IN (SELECT oid FROM application_schemas)
       )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_depend dependency
            WHERE dependency.classid =
                  pg_catalog.to_regclass('pg_catalog.pg_proc')
              AND dependency.objid = procedure.oid
              AND dependency.deptype = 'e'
         )
         AND procedure.proowner = pg_catalog.to_regrole('postgres')
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON %s %I.%I(%s) '
        || 'FROM sophia_voice_lab_gateway',
        CASE WHEN routine_row.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
        routine_row.nspname,
        routine_row.proname,
        routine_row.identity_arguments
      );
    END LOOP;
  END
  $voice_lab_d02_role_acl$`;

const AUTHORITY_ATTESTATION_SQL = `
  WITH application_schemas AS (${APPLICATION_SCHEMAS}),
  platform_schemas AS (${SUPABASE_PLATFORM_SCHEMAS}),
  platform_schema_authority AS (
    SELECT schema_row.oid
      FROM platform_schemas schema_row
     WHERE pg_catalog.has_schema_privilege(
             pg_catalog.to_regrole($1), schema_row.oid, 'USAGE,CREATE'
           )
  ),
  cross_schema_authority AS (
    SELECT schema_row.oid
      FROM application_schemas schema_row
     WHERE pg_catalog.has_schema_privilege(
             pg_catalog.to_regrole($1), schema_row.oid, 'USAGE,CREATE'
           )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_class relation
           WHERE relation.relnamespace = schema_row.oid
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (
               pg_catalog.has_table_privilege(
                 pg_catalog.to_regrole($1), relation.oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
               )
               OR pg_catalog.has_any_column_privilege(
                 pg_catalog.to_regrole($1), relation.oid,
                 'SELECT,INSERT,UPDATE,REFERENCES'
               )
             )
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_class sequence_row
           WHERE sequence_row.relnamespace = schema_row.oid
             AND sequence_row.relkind = 'S'
             AND pg_catalog.has_sequence_privilege(
               pg_catalog.to_regrole($1), sequence_row.oid,
               'USAGE,SELECT,UPDATE'
             )
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_proc procedure
           WHERE procedure.pronamespace = schema_row.oid
             AND pg_catalog.has_function_privilege(
               pg_catalog.to_regrole($1), procedure.oid, 'EXECUTE'
             )
        )
  ),
  public_raw_authority AS (
    SELECT relation.oid
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND (
         relation.relkind IN ('r', 'p', 'v', 'm', 'f') AND (
           pg_catalog.has_table_privilege(
             pg_catalog.to_regrole($1), relation.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           )
           OR pg_catalog.has_any_column_privilege(
             pg_catalog.to_regrole($1), relation.oid,
             'SELECT,INSERT,UPDATE,REFERENCES'
           )
         )
         OR relation.relkind = 'S'
            AND pg_catalog.has_sequence_privilege(
              pg_catalog.to_regrole($1), relation.oid, 'USAGE,SELECT,UPDATE'
            )
       )
  ),
  public_effective_routine_authority AS (
    SELECT 1
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_depend dependency
          WHERE dependency.classid =
                pg_catalog.to_regclass('pg_catalog.pg_proc')
            AND dependency.objid = procedure.oid
            AND dependency.deptype = 'e'
       )
       AND (
         (
           pg_catalog.to_regrole($1) IS NOT NULL
           AND pg_catalog.has_function_privilege(
             pg_catalog.to_regrole($1), procedure.oid, 'EXECUTE'
           )
         )
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.aclexplode(
               COALESCE(
                 procedure.proacl,
                 pg_catalog.acldefault('f', procedure.proowner)
               )
             ) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         )
       )
  ),
  future_direct_authority AS (
    SELECT 1
      FROM pg_catalog.pg_default_acl defaults
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
     WHERE acl.grantee = pg_catalog.to_regrole($1)
  )
  SELECT /* voice_lab_d02_role_authority_attestation */
         (SELECT count(*)::integer FROM application_schemas)
           AS application_schema_count,
         (SELECT count(*)::integer FROM platform_schemas)
           AS platform_schema_count,
         NOT EXISTS (SELECT 1 FROM platform_schema_authority)
           AS platform_schema_authority_denied,
         NOT EXISTS (SELECT 1 FROM cross_schema_authority)
           AS cross_schema_authority_denied,
         NOT EXISTS (SELECT 1 FROM public_raw_authority)
           AS public_raw_authority_denied,
         NOT EXISTS (SELECT 1 FROM public_effective_routine_authority)
           AS public_effective_routine_authority_denied,
         NOT EXISTS (SELECT 1 FROM future_direct_authority)
           AS future_direct_authority_denied`;

export class VoiceLabD02RoleProvisionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceLabD02RoleProvisionError';
    this.code = code;
  }
}

function fail(code) {
  throw new VoiceLabD02RoleProvisionError(code);
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail('d02_role_operator_configuration_missing');
  }
  return value;
}

function projectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const direct = hostname.match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/)?.[1];
  if (direct) return direct;
  if (hostname.includes('.pooler.supabase.')) {
    return decodeURIComponent(parsed.username).split('.').at(-1)?.toLowerCase() ?? null;
  }
  return null;
}

function sslConfig(databaseUrl, modeRaw) {
  const parsed = new URL(databaseUrl);
  const mode = modeRaw?.trim().toLowerCase() ?? 'auto';
  const queryMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  if (mode === 'disable' || queryMode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'require') return { rejectUnauthorized: true };
  if (queryMode === 'require' || queryMode === 'verify-ca' || queryMode === 'verify-full') {
    return parsed.hostname.includes('supabase.')
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true };
  }
  return parsed.hostname.includes('supabase.')
    ? { rejectUnauthorized: false }
    : undefined;
}

export function loadD02RoleProvisionConfig(env = process.env) {
  if (env.SOPHIA_VOICE_LAB_D02_ROLE_PROVISION_APPROVED !== 'YES') {
    fail('d02_role_provision_approval_required');
  }
  if (env.SOPHIA_VOICE_LAB_ENVIRONMENT !== 'production') {
    fail('d02_role_environment_invalid');
  }
  const ownerDsn = required(env, 'SOPHIA_VOICE_LAB_AUTH_MIGRATION_DATABASE_URL');
  const password = required(env, 'SOPHIA_VOICE_LAB_D02_GATEWAY_DATABASE_PASSWORD');
  const expectedProjectRefRaw = required(
    env,
    'BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF',
  );
  const expectedProjectRef = expectedProjectRefRaw.toLowerCase();
  const supportPreparationRaw =
    env.SOPHIA_VOICE_LAB_D02_SUPABASE_SUPPORT_PREPARE_APPROVED;
  if (supportPreparationRaw && supportPreparationRaw !== 'YES') {
    fail('d02_role_supabase_support_preparation_invalid');
  }
  let parsed;
  let ownerPassword;
  let expectedDatabase;
  try {
    parsed = new URL(ownerDsn);
    ownerPassword = decodeURIComponent(parsed.password);
    expectedDatabase = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    fail('d02_role_owner_target_invalid');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname
    || !parsed.username
    || !parsed.password
    || !parsed.pathname.replace(/^\/+/, '')
    || parsed.hash
    || expectedProjectRefRaw !== expectedProjectRef
    || !/^[a-z0-9]{10,64}$/.test(expectedProjectRef)
    || projectRef(ownerDsn) !== expectedProjectRef
  ) {
    fail('d02_role_owner_target_invalid');
  }
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (
    passwordBytes < 32
    || passwordBytes > 1_024
    || password.includes('\0')
    || password === ownerPassword
  ) {
    fail('d02_role_password_invalid');
  }
  return Object.freeze({
    ownerDsn,
    expectedDatabase,
    password,
    gatewayDsn: (() => {
      const gatewayUrl = new URL(ownerDsn);
      gatewayUrl.username = gatewayUrl.hostname.toLowerCase().includes('.pooler.supabase.')
        ? `${D02_ROLE}.${expectedProjectRef}`
        : D02_ROLE;
      gatewayUrl.password = password;
      return gatewayUrl.toString();
    })(),
    ssl: sslConfig(ownerDsn, env.BETTER_AUTH_DATABASE_SSL_MODE),
    supportPreparationApproved: supportPreparationRaw === 'YES',
  });
}

function exactRole(row, { allowSupabasePg17CreatorMembership = false } = {}) {
  return row
    && row.rolname === D02_ROLE
    && row.rolsuper === false
    && row.rolinherit === false
    && row.rolcreaterole === false
    && row.rolcreatedb === false
    && row.rolcanlogin === true
    && row.rolreplication === false
    && row.rolbypassrls === false
    && Number(row.rolconnlimit) === -1
    && row.password_no_expiry === true
    && (
      row.membership_free === true
      || (
        allowSupabasePg17CreatorMembership
        && row.supabase_pg17_creator_membership_only === true
      )
    )
    && row.public_schema_create_denied === true;
}

async function roleRows(client) {
  const result = await client.query(ROLE_CATALOG_SQL, [D02_ROLE]);
  return result.rows;
}

function exactAuthority(result) {
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || !Number.isInteger(Number(row.application_schema_count))
    || Number(row.application_schema_count) < 0
    || !Number.isInteger(Number(row.platform_schema_count))
    || Number(row.platform_schema_count) < 0
    || row.platform_schema_authority_denied !== true
    || row.cross_schema_authority_denied !== true
    || row.public_raw_authority_denied !== true
    || row.public_effective_routine_authority_denied !== true
    || row.future_direct_authority_denied !== true
  ) {
    fail('d02_role_authority_drift');
  }
  return row;
}

function defaultPool(config) {
  return new Pool({
    connectionString: config.ownerDsn,
    max: 1,
    options: '-c search_path=pg_catalog -c statement_timeout=30000',
    ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
  });
}

function defaultGatewayPool(config) {
  return new Pool({
    connectionString: config.gatewayDsn,
    max: 1,
    connectionTimeoutMillis: 10_000,
    options: '-c search_path=pg_catalog,public,pg_temp -c statement_timeout=10000',
    ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
  });
}

async function attestGatewayLogin(config, gatewayPoolFactory) {
  const gatewayPool = gatewayPoolFactory(config);
  let gatewayClient;
  try {
    gatewayClient = await gatewayPool.connect();
    const result = await gatewayClient.query(`
      SELECT /* voice_lab_d02_role_login_attestation */
             session_user AS session_user_name,
             current_user AS current_user_name,
             pg_catalog.current_database() AS database_name,
             pg_catalog.current_setting('session_replication_role') = 'origin'
               AS replication_origin,
             pg_catalog.current_setting('transaction_read_only') = 'off'
               AS writable,
             pg_catalog.current_setting('synchronous_commit') <> 'off'
               AS durable_commit,
             NOT pg_catalog.pg_is_in_recovery() AS primary_server`);
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || row.session_user_name !== D02_ROLE
      || row.current_user_name !== D02_ROLE
      || row.database_name !== config.expectedDatabase
      || row.replication_origin !== true
      || row.writable !== true
      || row.durable_commit !== true
      || row.primary_server !== true
    ) {
      fail('d02_role_login_attestation_failed');
    }
  } catch (error) {
    if (error instanceof VoiceLabD02RoleProvisionError) throw error;
    fail('d02_role_login_attestation_failed');
  } finally {
    gatewayClient?.release();
    await gatewayPool.end().catch(() => undefined);
  }
}

export async function provisionVoiceLabD02Role(
  config,
  {
    pool = defaultPool(config),
    gatewayPoolFactory = defaultGatewayPool,
  } = {},
) {
  let client;
  let committed = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(ADVISORY_LOCK_SQL);
    const identity = await client.query(`
      SELECT /* voice_lab_d02_role_owner_identity */
             session_user AS session_user_name,
             current_user AS current_user_name,
             pg_catalog.current_database() AS database_name,
             pg_catalog.current_setting('transaction_read_only') = 'off'
               AS writable,
             pg_catalog.current_setting('password_encryption') = 'scram-sha-256'
               AS scram_passwords,
             NOT pg_catalog.pg_is_in_recovery() AS primary_server`);
    const target = identity.rows[0];
    if (
      identity.rows.length !== 1
      || target.session_user_name !== OWNER_ROLE
      || target.current_user_name !== OWNER_ROLE
      || target.database_name !== config.expectedDatabase
      || target.writable !== true
      || target.scram_passwords !== true
      || target.primary_server !== true
    ) {
      fail('d02_role_owner_identity_invalid');
    }
    const footprint = await client.query(`
      SELECT /* voice_lab_d02_role_pre_migration_footprint */
             NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_class relation
                 JOIN pg_catalog.pg_namespace namespace
                   ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND relation.relname LIKE 'sophia_voice_lab_d02_%'
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_proc procedure
                 JOIN pg_catalog.pg_namespace namespace
                   ON namespace.oid = procedure.pronamespace
                WHERE namespace.nspname = 'public'
                  AND procedure.proname LIKE 'sophia_voice_lab_d02_%'
             ) AS pre_migration`);
    if (
      footprint.rows.length !== 1
      || footprint.rows[0].pre_migration !== true
    ) {
      fail('d02_role_schema_already_present');
    }

    const before = await roleRows(client);
    const supportPreparation = config.supportPreparationApproved === true;
    if (
      before.length > 1
      || (
        before.length === 1
        && !exactRole(before[0], {
          allowSupabasePg17CreatorMembership: supportPreparation,
        })
      )
    ) {
      fail('d02_role_catalog_drift');
    }
    const created = before.length === 0;
    if (supportPreparation) {
      await client.query(REVOKE_PUBLIC_APPLICATION_ROUTINE_AUTHORITY_SQL);
    }
    exactAuthority(await client.query(AUTHORITY_ATTESTATION_SQL, [D02_ROLE]));
    if (created) {
      const configured = await client.query(
        `SELECT /* voice_lab_d02_role_password_bind */
                pg_catalog.set_config($1, $2, true) = $2 AS configured`,
        [PASSWORD_GUC, config.password],
      );
      if (configured.rows.length !== 1 || configured.rows[0].configured !== true) {
        fail('d02_role_password_bind_failed');
      }
      await client.query(CREATE_ROLE_SQL);
      const cleared = await client.query(
        `SELECT /* voice_lab_d02_role_password_clear */
                pg_catalog.set_config($1, '', true) = '' AS cleared`,
        [PASSWORD_GUC],
      );
      if (cleared.rows.length !== 1 || cleared.rows[0].cleared !== true) {
        fail('d02_role_password_clear_failed');
      }
    }

    await client.query(REVOKE_DIRECT_AUTHORITY_SQL);
    const after = await roleRows(client);
    if (
      after.length !== 1
      || !exactRole(after[0], {
        allowSupabasePg17CreatorMembership: supportPreparation,
      })
    ) {
      fail('d02_role_catalog_drift');
    }
    const authority = exactAuthority(
      await client.query(AUTHORITY_ATTESTATION_SQL, [D02_ROLE]),
    );
    await client.query('COMMIT');
    committed = true;
    await attestGatewayLogin(config, gatewayPoolFactory);
    const supportRequired = after[0].membership_free !== true;
    return Object.freeze({
      ok: !supportRequired,
      role: D02_ROLE,
      role_sha256: createHash('sha256').update(D02_ROLE).digest('hex'),
      database_sha256: createHash('sha256').update(target.database_name).digest('hex'),
      created,
      credential_action: created ? 'created' : 'preserved',
      application_schema_count: Number(authority.application_schema_count),
      platform_schema_count: Number(authority.platform_schema_count),
      platform_schema_authority_denied: true,
      authority_attested: true,
      login_attested: true,
      membership_attested: !supportRequired,
      support_required: supportRequired,
      support_action: supportRequired
        ? 'remove_supabase_pg17_creator_membership'
        : null,
    });
  } catch (error) {
    if (client && !committed) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof VoiceLabD02RoleProvisionError) throw error;
    fail('d02_role_database_operation_failed');
  } finally {
    client?.release();
    await pool.end().catch(() => undefined);
  }
}

export async function main(env = process.env) {
  const result = await provisionVoiceLabD02Role(loadD02RoleProvisionConfig(env));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.support_required === true) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: 'd02_role_argument_invalid' })}\n`);
    process.exitCode = 1;
  } else {
    main().catch((error) => {
      const code = error instanceof VoiceLabD02RoleProvisionError
        ? error.code
        : 'd02_role_operator_failed';
      process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
      process.exitCode = 1;
    });
  }
}
