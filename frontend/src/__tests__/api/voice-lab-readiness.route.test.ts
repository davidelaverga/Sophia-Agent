import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  signVoiceLabCapability,
  type VoiceLabCapabilityClaims,
} from '../../server/voice-lab/capability';

const ensureBetterAuthSchemaMock = vi.fn();
const findUserByEmailMock = vi.fn();
const findUserByIdMock = vi.fn();
const findAccountsMock = vi.fn();
const listSessionsMock = vi.fn();
const assertVoiceLabAuthLedgerReadyMock = vi.fn();
const readPrincipalStateMock = vi.fn();

vi.mock('../../server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => ensureBetterAuthSchemaMock(...args),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: {
        findUserByEmail: (...args: unknown[]) => findUserByEmailMock(...args),
        findUserById: (...args: unknown[]) => findUserByIdMock(...args),
        findAccounts: (...args: unknown[]) => findAccountsMock(...args),
        listSessions: (...args: unknown[]) => listSessionsMock(...args),
      },
    }),
  },
}));

vi.mock('../../server/voice-lab/session-ledger', () => ({
  assertVoiceLabAuthLedgerReady: (...args: unknown[]) => assertVoiceLabAuthLedgerReadyMock(...args),
}));

vi.mock('../../server/voice-lab/principal-provision-store', () => ({
  readDedicatedVoiceLabPrincipalState: (...args: unknown[]) => readPrincipalStateMock(...args),
}));

import { POST } from '../../app/api/voice-lab/auth/readiness/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';

function readinessGrant(overrides: Partial<VoiceLabCapabilityClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signVoiceLabCapability({
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'readiness-001',
    synthetic: true,
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    allowed_ops: ['auth:readiness'],
    expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: 'jti-readiness-001',
    nonce: 'nonce-readiness-001',
    ...overrides,
  }, GRANT_SECRET);
}

function request(token?: string): NextRequest {
  return new Request('https://www.sophia-ei.com/api/voice-lab/auth/readiness', {
    method: 'POST',
    headers: token ? { 'X-Sophia-Voice-Lab-Capability': token } : undefined,
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/auth/readiness POST', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'true';
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';
    process.env.SOPHIA_VOICE_LAB_PROVISIONING_ENABLED = 'true';
    process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL = 'voice-lab-user-1';
    process.env.SOPHIA_VOICE_LAB_TEST_EMAIL = 'voice-lab@example.com';
    process.env.SOPHIA_VOICE_LAB_TEST_NAME = 'Sophia Voice Lab';
    process.env.SOPHIA_VOICE_LAB_ENVIRONMENT = 'production';
    process.env.SOPHIA_VOICE_LAB_GRANT_SECRET = GRANT_SECRET;
    process.env.VERCEL_GIT_COMMIT_SHA = BUILD;
    ensureBetterAuthSchemaMock.mockResolvedValue(undefined);
    assertVoiceLabAuthLedgerReadyMock.mockResolvedValue({
      ready: true,
      migrationSha256: '9a0987a52699a513cc19cc3f944c88113d591ce35924df6e297f051cede1eb45',
    });
    const user = { id: 'voice-lab-user-1', email: 'voice-lab@example.com', name: 'Sophia Voice Lab', emailVerified: true };
    findUserByEmailMock.mockResolvedValue({ user });
    findUserByIdMock.mockResolvedValue(user);
    findAccountsMock.mockResolvedValue([{
      userId: 'voice-lab-user-1',
      providerId: 'sophia-voice-lab',
      accountId: 'voice-lab:voice-lab-user-1',
      scope: 'synthetic-voice-lab-only',
    }]);
    listSessionsMock.mockResolvedValue([]);
    readPrincipalStateMock.mockResolvedValue({
      principalRecordPresent: true,
      principalRecordProvisioned: true,
      providerAccountProvisioned: true,
      providerAccountCount: 1,
      activeSessionCount: 0,
      provisioned: true,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports safe provisioned readiness under the kill switch without creating a session or cookie', async () => {
    const response = await POST(request(readinessGrant()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      schema: 'sophia_voice_lab_auth_readiness_v1',
      ok: true,
      ready: true,
      provisioned: true,
      principal_record_present: true,
      principal_record_provisioned: true,
      provider_account_provisioned: true,
      provider_account_count: 1,
      active_session_count: 0,
      voice_lab_enabled: true,
      kill_switch_engaged: true,
      provisioning_enabled: true,
      auth_ledger_ready: true,
      auth_ledger_migration_sha256: '9a0987a52699a513cc19cc3f944c88113d591ce35924df6e297f051cede1eb45',
      frontend_build: BUILD,
      test_run_id: 'readiness-001',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      environment: 'production',
      expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
      deployment_identity: { frontend: BUILD },
    });
    expect(payload.principal_id_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.capability_jti_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('voice-lab-user-1');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reports signed readiness while the mutation plane remains disabled', async () => {
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'false';
    process.env.SOPHIA_VOICE_LAB_PROVISIONING_ENABLED = 'false';

    const response = await POST(request(readinessGrant()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ready: true,
      provisioned: true,
      voice_lab_enabled: false,
    });
  });

  it.each([
    ['exact true', 'true', true],
    ['normalized true', ' TRUE ', true],
    ['false', 'false', false],
    ['hostile truthy text', '1', false],
    ['missing', undefined, false],
  ] as const)('signs %s enablement as a strict boolean', async (_label, configured, expected) => {
    if (configured === undefined) delete process.env.SOPHIA_VOICE_LAB_ENABLED;
    else process.env.SOPHIA_VOICE_LAB_ENABLED = configured;

    const response = await POST(request(readinessGrant()));
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.voice_lab_enabled).toBe(expected);
    expect(typeof payload.voice_lab_enabled).toBe('boolean');
  });

  it('returns a safe not-provisioned result without provisioning', async () => {
    readPrincipalStateMock.mockResolvedValue({
      principalRecordPresent: false,
      principalRecordProvisioned: false,
      providerAccountProvisioned: false,
      providerAccountCount: 0,
      activeSessionCount: 0,
      provisioned: false,
    });
    const response = await POST(request(readinessGrant()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: false, provisioned: false });
  });

  it.each([
    ['wrong user name', { principalRecordProvisioned: false, provisioned: false }],
    ['unverified user', { principalRecordProvisioned: false, provisioned: false }],
    ['broader provider scope', { providerAccountProvisioned: false, provisioned: false }],
    ['extra ordinary account', { providerAccountProvisioned: false, providerAccountCount: 2, provisioned: false }],
    ['credential-bearing account', { providerAccountProvisioned: false, provisioned: false }],
    ['random account primary id', { providerAccountProvisioned: false, provisioned: false }],
    ['active session', { activeSessionCount: 1, provisioned: false }],
  ])('does not certify %s as dedicated readiness', async (_label, patch) => {
    readPrincipalStateMock.mockResolvedValue({
      principalRecordPresent: true,
      principalRecordProvisioned: true,
      providerAccountProvisioned: true,
      providerAccountCount: 1,
      activeSessionCount: 0,
      provisioned: true,
      ...patch,
    });
    const response = await POST(request(readinessGrant()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ready: false, provisioned: false });
  });

  it('returns typed non-readiness before Better Auth lookup when ledger shape drifts', async () => {
    assertVoiceLabAuthLedgerReadyMock.mockRejectedValue(
      new (await import('../../server/voice-lab/capability')).VoiceLabCapabilityError(
        'voice_lab_auth_ledger_not_ready',
        503,
      ),
    );

    const response = await POST(request(readinessGrant()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_auth_ledger_not_ready',
    });
    expect(readPrincipalStateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 401, 'voice_lab_capability_missing'],
    [
      'wrong audience',
      readinessGrant({ aud: 'sophia-voice-gateway' }),
      403,
      'voice_lab_capability_wrong_audience',
    ],
    [
      'wrong build',
      readinessGrant({
        expected_deployment: { frontend: 'b'.repeat(40), backend: BUILD, voice: BUILD },
      }),
      409,
      'voice_lab_capability_deployment_mismatch',
    ],
  ])('rejects %s before Better Auth lookup', async (_label, token, status, code) => {
    const response = await POST(request(token));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, error: code });
    expect(readPrincipalStateMock).not.toHaveBeenCalled();
  });

  it.each(['missing', 'garbage'])('rejects %s phase-gate configuration before DB state lookup', async (mode) => {
    if (mode === 'missing') delete process.env.SOPHIA_VOICE_LAB_KILL_SWITCH;
    else process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'engaged';

    const response = await POST(request(readinessGrant()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'voice_lab_configuration_invalid' });
    expect(readPrincipalStateMock).not.toHaveBeenCalled();
  });
});
