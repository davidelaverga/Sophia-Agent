import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.hoisted(() => vi.fn());

vi.mock('../../server/better-auth/database', () => ({
  getBetterAuthDatabase: () => ({ connect: connectMock }),
}));

import {
  ensureDedicatedVoiceLabPrincipal,
  readDedicatedVoiceLabPrincipalState,
  type DedicatedVoiceLabPrincipal,
} from '../../server/voice-lab/principal-provision-store';

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
};

type AccountRow = {
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

type State = { users: UserRow[]; accounts: AccountRow[]; sessions: Array<{ id: string; userId: string }> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

class FakeDatabase {
  state: State;
  readonly statements: string[] = [];
  failAccountInsert = false;
  pauseFirstEmptyAccountRead = false;
  readonly emptyAccountRead = deferred();
  readonly resumeEmptyAccountRead = deferred();
  #paused = false;
  #tail = Promise.resolve();

  constructor(state: Partial<State> = {}) {
    this.state = structuredClone({ users: [], accounts: [], sessions: [], ...state });
  }

  connect = async (): Promise<PoolClient> => new FakeClient(this) as unknown as PoolClient;

  async acquire(client: FakeClient): Promise<void> {
    const previous = this.#tail;
    const release = deferred();
    this.#tail = release.promise;
    await previous;
    client.releaseLock = release.resolve;
    client.transaction = structuredClone(this.state);
  }

  async maybePauseEmptyAccountRead(rows: AccountRow[]): Promise<void> {
    if (!this.pauseFirstEmptyAccountRead || this.#paused || rows.length !== 0) return;
    this.#paused = true;
    this.emptyAccountRead.resolve();
    await this.resumeEmptyAccountRead.promise;
  }
}

class FakeClient {
  transaction: State | null = null;
  releaseLock: (() => void) | null = null;

  constructor(readonly database: FakeDatabase) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const compact = sql.replace(/\s+/g, ' ').trim();
    const lower = compact.toLowerCase();
    this.database.statements.push(compact);
    if (lower === 'begin') return { rows: [] };
    if (lower.includes('pg_advisory_xact_lock')) {
      await this.database.acquire(this);
      return { rows: [] };
    }
    if (!this.transaction) throw new Error('query outside locked transaction');
    if (lower.startsWith('select "id", "name", "email"')) {
      const [principalId, email] = params as [string, string];
      return { rows: this.transaction.users.filter((row) => row.id === principalId || row.email.toLowerCase() === email.toLowerCase()) as T[] };
    }
    if (lower.startsWith('insert into public."user"')) {
      const [id, name, email] = params as [string, string, string];
      if (!this.transaction.users.some((row) => row.id === id || row.email === email)) {
        this.transaction.users.push({ id, name, email, emailVerified: true, image: null });
      }
      return { rows: [] };
    }
    if (lower.startsWith('select "id" from public."session"')) {
      const [principalId] = params as [string];
      return { rows: this.transaction.sessions.filter((row) => row.userId === principalId) as T[] };
    }
    if (lower.startsWith('select "id", "accountid"')) {
      const [principalId, primaryId, providerId, providerAccountId] = params as [string, string, string, string];
      const rows = this.transaction.accounts.filter((row) => row.userId === principalId
        || row.id === primaryId
        || (row.providerId === providerId && row.accountId === providerAccountId));
      await this.database.maybePauseEmptyAccountRead(rows);
      return { rows: rows as T[] };
    }
    if (lower.startsWith('insert into public."account"')) {
      if (this.database.failAccountInsert) throw new Error('injected account insert failure');
      const [id, accountId, providerId, userId, scope] = params as [string, string, string, string, string];
      if (!this.transaction.accounts.some((row) => row.id === id)) {
        this.transaction.accounts.push({
          id,
          accountId,
          providerId,
          userId,
          accessToken: null,
          refreshToken: null,
          idToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scope,
          password: null,
        });
      }
      return { rows: [] };
    }
    if (lower === 'commit') {
      this.database.state = structuredClone(this.transaction);
      this.transaction = null;
      this.releaseLock?.();
      this.releaseLock = null;
      return { rows: [] };
    }
    if (lower === 'rollback') {
      this.transaction = null;
      this.releaseLock?.();
      this.releaseLock = null;
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${compact}`);
  }

  release(): void {
    this.releaseLock?.();
    this.releaseLock = null;
  }
}

const expected: DedicatedVoiceLabPrincipal = {
  principalId: 'voice-lab-user-1',
  email: 'voice-lab@example.com',
  name: 'Sophia Voice Lab',
};

function exactUser(): UserRow {
  return { id: expected.principalId, email: expected.email, name: expected.name, emailVerified: true, image: null };
}

function accountId(): string {
  return `voice-lab-account-${createHash('sha256').update(expected.principalId).digest('hex').slice(0, 32)}`;
}

function exactAccount(patch: Partial<AccountRow> = {}): AccountRow {
  return {
    id: accountId(),
    accountId: `voice-lab:${expected.principalId}`,
    providerId: 'sophia-voice-lab',
    userId: expected.principalId,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: 'synthetic-voice-lab-only',
    password: null,
    ...patch,
  };
}

describe('dedicated Voice Lab principal transaction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes concurrent ambiguous retries and commits one deterministic account', async () => {
    const database = new FakeDatabase({ users: [exactUser()] });
    database.pauseFirstEmptyAccountRead = true;
    connectMock.mockImplementation(database.connect);

    const first = ensureDedicatedVoiceLabPrincipal(expected);
    await database.emptyAccountRead.promise;
    const second = ensureDedicatedVoiceLabPrincipal(expected);
    await Promise.resolve();
    database.resumeEmptyAccountRead.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    expect(database.state.accounts).toEqual([exactAccount()]);
    expect(database.statements.filter((sql) => sql.startsWith('INSERT INTO public."account"'))).toHaveLength(1);
    expect(database.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(2);
    expect(database.statements.filter((sql) => sql.includes('pg_advisory_xact_lock(hashtextextended($1, $2))'))).toHaveLength(2);
    expect(database.statements.filter((sql) => sql === 'COMMIT')).toHaveLength(2);
    expect(database.statements.filter((sql) => sql === 'ROLLBACK')).toHaveLength(0);
  });

  it('rolls back user creation when account creation fails and a later retry recovers', async () => {
    const database = new FakeDatabase();
    database.failAccountInsert = true;
    connectMock.mockImplementation(database.connect);

    await expect(ensureDedicatedVoiceLabPrincipal(expected)).rejects.toThrow('injected account insert failure');
    expect(database.state).toEqual({ users: [], accounts: [], sessions: [] });
    expect(database.statements).toContain('ROLLBACK');
    expect(database.statements).not.toContain('COMMIT');

    database.failAccountInsert = false;
    await expect(ensureDedicatedVoiceLabPrincipal(expected)).resolves.toBeUndefined();
    expect(database.state.users).toEqual([exactUser()]);
    expect(database.state.accounts).toEqual([exactAccount()]);
  });

  it.each([
    ['random primary identity', { id: 'random-account-id' }],
    ['access token', { accessToken: 'secret' }],
    ['refresh token', { refreshToken: 'secret' }],
    ['ID token', { idToken: 'secret' }],
    ['password', { password: 'secret' }],
    ['access token expiry', { accessTokenExpiresAt: new Date('2030-01-01T00:00:00.000Z') }],
    ['refresh token expiry', { refreshTokenExpiresAt: new Date('2030-01-01T00:00:00.000Z') }],
  ] as const)('rejects %s drift in both read and mutation paths', async (_label, patch) => {
    const database = new FakeDatabase({ users: [exactUser()], accounts: [exactAccount(patch)] });
    connectMock.mockImplementation(database.connect);

    await expect(readDedicatedVoiceLabPrincipalState(expected)).resolves.toMatchObject({
      principalRecordProvisioned: true,
      providerAccountProvisioned: false,
      provisioned: false,
    });
    await expect(ensureDedicatedVoiceLabPrincipal(expected)).rejects.toMatchObject({
      code: 'voice_lab_provider_account_conflict',
      status: 409,
    });
  });
});
