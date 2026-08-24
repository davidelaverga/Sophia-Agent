import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signVoiceLabCapability, VoiceLabCapabilityError, type VoiceLabCapabilityClaims } from '../../server/voice-lab/capability';

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  createUser: vi.fn(),
  findAccount: vi.fn(),
  findAccounts: vi.fn(),
  listSessions: vi.fn(),
  createAccount: vi.fn(),
  createSession: vi.fn(),
  assertRetentionAdmission: vi.fn(),
  ensurePrincipal: vi.fn(),
}));

vi.mock('../../server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => mocks.ensureSchema(...args),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: {
        findUserByEmail: (...args: unknown[]) => mocks.findUserByEmail(...args),
        findUserById: (...args: unknown[]) => mocks.findUserById(...args),
        createUser: (...args: unknown[]) => mocks.createUser(...args),
        findAccount: (...args: unknown[]) => mocks.findAccount(...args),
        findAccounts: (...args: unknown[]) => mocks.findAccounts(...args),
        listSessions: (...args: unknown[]) => mocks.listSessions(...args),
        createAccount: (...args: unknown[]) => mocks.createAccount(...args),
        createSession: (...args: unknown[]) => mocks.createSession(...args),
      },
    }),
  },
}));

vi.mock('../../server/voice-lab/retention-admission', () => ({
  assertVoiceLabRetentionAdmissionReady: (...args: unknown[]) => (
    mocks.assertRetentionAdmission(...args)
  ),
}));

vi.mock('../../server/voice-lab/principal-provision-store', () => ({
  ensureDedicatedVoiceLabPrincipal: (...args: unknown[]) => mocks.ensurePrincipal(...args),
}));

import { POST } from '../../app/api/voice-lab/auth/provision/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function token(overrides: Partial<VoiceLabCapabilityClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signVoiceLabCapability({
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'provision-run-001',
    synthetic: true,
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    allowed_ops: ['auth:provision'],
    expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: 'jti-provision-001',
    nonce: 'nonce-provision-001',
    ...overrides,
  }, SECRET);
}

function request(capability?: string, body?: string): NextRequest {
  return new Request('https://www.sophia-ei.com/api/voice-lab/auth/provision', {
    method: 'POST',
    headers: capability ? { 'X-Sophia-Voice-Lab-Capability': capability } : undefined,
    body,
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/auth/provision POST', () => {
  const originalEnv = { ...process.env };
  const exactUser = { id: 'voice-lab-user-1', email: 'voice-lab@example.com', name: 'Sophia Voice Lab', emailVerified: true };
  const exactAccount = {
    userId: 'voice-lab-user-1',
    providerId: 'sophia-voice-lab',
    accountId: 'voice-lab:voice-lab-user-1',
    scope: 'synthetic-voice-lab-only',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, {
      SOPHIA_VOICE_LAB_ENABLED: 'true',
      SOPHIA_VOICE_LAB_KILL_SWITCH: 'true',
      SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'true',
      SOPHIA_VOICE_LAB_TEST_PRINCIPAL: 'voice-lab-user-1',
      SOPHIA_VOICE_LAB_TEST_EMAIL: 'voice-lab@example.com',
      SOPHIA_VOICE_LAB_TEST_NAME: 'Sophia Voice Lab',
      SOPHIA_VOICE_LAB_ENVIRONMENT: 'production',
      SOPHIA_VOICE_LAB_GRANT_SECRET: SECRET,
      VERCEL_GIT_COMMIT_SHA: BUILD,
    });
    mocks.ensureSchema.mockResolvedValue(undefined);
    mocks.findUserByEmail.mockResolvedValue(null);
    mocks.findUserById.mockResolvedValue(null);
    mocks.createUser.mockResolvedValue(exactUser);
    mocks.findAccount.mockResolvedValue(null);
    mocks.findAccounts.mockResolvedValue([exactAccount]);
    mocks.findAccounts.mockResolvedValueOnce([]);
    mocks.listSessions.mockResolvedValue([]);
    mocks.createAccount.mockResolvedValue(exactAccount);
    mocks.assertRetentionAdmission.mockResolvedValue(undefined);
    mocks.ensurePrincipal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates only the configured deterministic user and provider account without a session', async () => {
    const capability = token();
    const response = await POST(request(capability));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schema: 'sophia_voice_lab_principal_provision_result_v1',
      ok: true,
      provisioned: true,
      principal_id_sha256: sha256('voice-lab-user-1'),
      capability_sha256: sha256(capability),
      capability_jti_sha256: sha256('jti-provision-001'),
      test_run_id_sha256: sha256('provision-run-001'),
      cleanup_obligation_id_sha256: sha256('123e4567-e89b-42d3-a456-426614174000'),
      environment: 'production',
      frontend_build: BUILD,
      expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    });
    expect(mocks.ensurePrincipal).toHaveBeenCalledWith({
      principalId: 'voice-lab-user-1',
      email: 'voice-lab@example.com',
      name: 'Sophia Voice Lab',
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  it('is idempotent when the exact dedicated records already exist', async () => {
    mocks.findUserByEmail.mockResolvedValue({ user: exactUser });
    mocks.findUserById.mockResolvedValue(exactUser);
    mocks.findAccount.mockResolvedValue(exactAccount);
    mocks.findAccounts.mockReset().mockResolvedValue([exactAccount]);
    const response = await POST(request(token()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ provisioned: true });
    expect(mocks.ensurePrincipal).toHaveBeenCalledTimes(1);
  });

  it('permits only the separately enabled signed provisioning operation under kill switch', async () => {
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';

    const response = await POST(request(token()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, provisioned: true });
    expect(mocks.ensurePrincipal).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'voice-lab-user-1',
      email: 'voice-lab@example.com',
    }));
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['provisioning flag off', () => { process.env.SOPHIA_VOICE_LAB_PROVISIONING_ENABLED = 'false'; }, token(), 404, 'voice_lab_provisioning_disabled'],
    ['kill switch open', () => { process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'false'; }, token(), 403, 'voice_lab_provisioning_kill_switch_required'],
    ['missing capability', () => undefined, undefined, 401, 'voice_lab_capability_missing'],
    ['wrong operation', () => undefined, token({ allowed_ops: ['auth:session'] }), 403, 'voice_lab_capability_operation_denied'],
  ])('rejects %s before database mutation', async (_label, arrange, capability, status, code) => {
    arrange();
    const response = await POST(request(capability));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, error: code });
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.ensurePrincipal).not.toHaveBeenCalled();
  });

  it('conflicts when the configured email belongs to another identity', async () => {
    mocks.ensurePrincipal.mockRejectedValue(new VoiceLabCapabilityError('voice_lab_principal_conflict', 409));
    const response = await POST(request(token()));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'voice_lab_principal_conflict' });
    expect(mocks.ensurePrincipal).toHaveBeenCalledTimes(1);
  });

  it('conflicts when the deterministic account id points at another user', async () => {
    mocks.ensurePrincipal.mockRejectedValue(new VoiceLabCapabilityError('voice_lab_provider_account_conflict', 409));
    const response = await POST(request(token()));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'voice_lab_provider_account_conflict' });
    expect(mocks.ensurePrincipal).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['broader provider scope', [{ ...exactAccount, scope: 'openid profile' }], []],
    ['extra ordinary account', [exactAccount, { ...exactAccount, providerId: 'credential', accountId: 'ordinary' }], []],
    ['active Better Auth session', [exactAccount], [{ id: 'active-session' }]],
  ])('rejects %s as non-dedicated state', async (_label, accounts, sessions) => {
    const code = sessions.length === 0
      ? 'voice_lab_provider_account_conflict'
      : 'voice_lab_principal_active_session_conflict';
    mocks.ensurePrincipal.mockRejectedValue(new VoiceLabCapabilityError(code, 409));

    const response = await POST(request(token()));

    expect(response.status).toBe(409);
    expect(mocks.ensurePrincipal).toHaveBeenCalledTimes(1);
  });

  it('rejects all caller-supplied identity data in the request body', async () => {
    const response = await POST(request(token(), JSON.stringify({ email: 'ordinary@example.com' })));
    expect(response.status).toBe(400);
    expect(mocks.ensureSchema).not.toHaveBeenCalled();
    expect(mocks.ensurePrincipal).not.toHaveBeenCalled();
  });
});
