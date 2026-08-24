import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { getBetterAuthDatabase } from '@/server/better-auth/database';
import { VoiceLabCapabilityError } from '@/server/voice-lab/capability';

const PROVIDER_ID = 'sophia-voice-lab';
const PROVIDER_SCOPE = 'synthetic-voice-lab-only';
const PRINCIPAL_LOCK_NAMESPACE = 731941;

type PrincipalUserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
};

type PrincipalAccountRow = {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
};

export type DedicatedVoiceLabPrincipal = {
  principalId: string;
  email: string;
  name: string;
};

export type DedicatedVoiceLabPrincipalState = {
  principalRecordPresent: boolean;
  principalRecordProvisioned: boolean;
  providerAccountProvisioned: boolean;
  providerAccountCount: number;
  activeSessionCount: number;
  provisioned: boolean;
};

function deterministicAccountId(principalId: string): string {
  const digest = createHash('sha256').update(principalId, 'utf8').digest('hex');
  return `voice-lab-account-${digest.slice(0, 32)}`;
}

function exactUser(row: PrincipalUserRow, expected: DedicatedVoiceLabPrincipal): boolean {
  return row.id === expected.principalId
    && row.email === expected.email
    && row.name === expected.name
    && row.emailVerified === true
    && row.image === null;
}

function exactAccount(
  row: PrincipalAccountRow,
  expected: DedicatedVoiceLabPrincipal,
  primaryAccountId: string,
  providerAccountId: string,
): boolean {
  return row.id === primaryAccountId
    && row.userId === expected.principalId
    && row.providerId === PROVIDER_ID
    && row.accountId === providerAccountId
    && row.scope === PROVIDER_SCOPE
    && row.accessToken === null
    && row.refreshToken === null
    && row.idToken === null
    && row.accessTokenExpiresAt === null
    && row.refreshTokenExpiresAt === null
    && row.password === null;
}

async function readUsers(
  client: PoolClient,
  expected: DedicatedVoiceLabPrincipal,
): Promise<PrincipalUserRow[]> {
  const result = await client.query<PrincipalUserRow>(
    'SELECT "id", "name", "email", "emailVerified", "image" '
      + 'FROM public."user" WHERE "id" = $1 OR lower("email") = lower($2) '
      + 'ORDER BY "id" FOR UPDATE',
    [expected.principalId, expected.email],
  );
  return result.rows;
}

async function readAccounts(
  client: PoolClient,
  expected: DedicatedVoiceLabPrincipal,
  primaryAccountId: string,
  providerAccountId: string,
): Promise<PrincipalAccountRow[]> {
  const result = await client.query<PrincipalAccountRow>(
    'SELECT "id", "accountId", "providerId", "userId", "accessToken", "refreshToken", '
      + '"idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password" '
      + 'FROM public."account" WHERE "userId" = $1 OR "id" = $2 '
      + 'OR ("providerId" = $3 AND "accountId" = $4) ORDER BY "id" FOR UPDATE',
    [expected.principalId, primaryAccountId, PROVIDER_ID, providerAccountId],
  );
  return result.rows;
}

async function assertNoActiveSessions(client: PoolClient, principalId: string): Promise<void> {
  const activeSessionCount = await countActiveSessions(client, principalId);
  if (activeSessionCount !== 0) {
    throw new VoiceLabCapabilityError('voice_lab_principal_active_session_conflict', 409);
  }
}

async function countActiveSessions(client: PoolClient, principalId: string): Promise<number> {
  const result = await client.query<{ id: string }>(
    'SELECT "id" FROM public."session" '
      + 'WHERE "userId" = $1 AND "expiresAt" > clock_timestamp() FOR UPDATE',
    [principalId],
  );
  return result.rows.length;
}

async function readState(
  client: PoolClient,
  expected: DedicatedVoiceLabPrincipal,
  primaryAccountId: string,
  providerAccountId: string,
): Promise<DedicatedVoiceLabPrincipalState> {
  const users = await readUsers(client, expected);
  const accounts = await readAccounts(client, expected, primaryAccountId, providerAccountId);
  const activeSessionCount = await countActiveSessions(client, expected.principalId);
  const principalRecordProvisioned = users.length === 1
    && Boolean(users[0] && exactUser(users[0], expected));
  const providerAccountProvisioned = accounts.length === 1
    && Boolean(accounts[0] && exactAccount(accounts[0], expected, primaryAccountId, providerAccountId));
  return {
    principalRecordPresent: users.length !== 0,
    principalRecordProvisioned,
    providerAccountProvisioned,
    providerAccountCount: accounts.length,
    activeSessionCount,
    provisioned: principalRecordProvisioned
      && providerAccountProvisioned
      && activeSessionCount === 0,
  };
}

/**
 * Establish the one dedicated Better Auth identity on one database connection.
 * The same principal-scoped advisory lock is used by Voice Lab session rotation,
 * so no session can appear between the zero-session proof and commit. The
 * deterministic account primary key is an additional database uniqueness fence
 * for ambiguous retries even though Better Auth has no provider/account index.
 */
export async function ensureDedicatedVoiceLabPrincipal(
  expected: DedicatedVoiceLabPrincipal,
): Promise<void> {
  const pool = getBetterAuthDatabase();
  const client = await pool.connect();
  const providerAccountId = `voice-lab:${expected.principalId}`;
  const primaryAccountId = deterministicAccountId(expected.principalId);
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
      [expected.principalId, PRINCIPAL_LOCK_NAMESPACE],
    );

    let users = await readUsers(client, expected);
    if (users.length === 0) {
      await client.query(
        'INSERT INTO public."user" '
          + '("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") '
          + 'VALUES ($1, $2, $3, true, null, clock_timestamp(), clock_timestamp()) '
          + 'ON CONFLICT DO NOTHING',
        [expected.principalId, expected.name, expected.email],
      );
      users = await readUsers(client, expected);
    }
    if (users.length !== 1 || !users[0] || !exactUser(users[0], expected)) {
      throw new VoiceLabCapabilityError('voice_lab_principal_conflict', 409);
    }

    await assertNoActiveSessions(client, expected.principalId);
    let accounts = await readAccounts(client, expected, primaryAccountId, providerAccountId);
    if (accounts.length === 0) {
      await client.query(
        'INSERT INTO public."account" '
          + '("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", '
          + '"accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt") '
          + 'VALUES ($1, $2, $3, $4, null, null, null, null, null, $5, null, clock_timestamp(), clock_timestamp()) '
          + 'ON CONFLICT ("id") DO NOTHING',
        [primaryAccountId, providerAccountId, PROVIDER_ID, expected.principalId, PROVIDER_SCOPE],
      );
      accounts = await readAccounts(client, expected, primaryAccountId, providerAccountId);
    }
    if (
      accounts.length !== 1
      || !accounts[0]
      || !exactAccount(accounts[0], expected, primaryAccountId, providerAccountId)
    ) {
      throw new VoiceLabCapabilityError('voice_lab_provider_account_conflict', 409);
    }

    // Re-check under the same transaction and principal lock after every write.
    const finalUsers = await readUsers(client, expected);
    const finalAccounts = await readAccounts(client, expected, primaryAccountId, providerAccountId);
    await assertNoActiveSessions(client, expected.principalId);
    if (
      finalUsers.length !== 1
      || !finalUsers[0]
      || !exactUser(finalUsers[0], expected)
      || finalAccounts.length !== 1
      || !finalAccounts[0]
      || !exactAccount(finalAccounts[0], expected, primaryAccountId, providerAccountId)
    ) {
      throw new VoiceLabCapabilityError('voice_lab_principal_conflict', 409);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Read the exact dedicated-principal state from one serialized DB snapshot. */
export async function readDedicatedVoiceLabPrincipalState(
  expected: DedicatedVoiceLabPrincipal,
): Promise<DedicatedVoiceLabPrincipalState> {
  const pool = getBetterAuthDatabase();
  const client = await pool.connect();
  const providerAccountId = `voice-lab:${expected.principalId}`;
  const primaryAccountId = deterministicAccountId(expected.principalId);
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
      [expected.principalId, PRINCIPAL_LOCK_NAMESPACE],
    );
    const state = await readState(client, expected, primaryAccountId, providerAccountId);
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
