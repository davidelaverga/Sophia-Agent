import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mintVoiceLabRunBinding,
  signVoiceLabCapability,
  type VoiceLabCapabilityClaims,
} from '../../server/voice-lab/capability';

const ensureBetterAuthSchemaMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('../../server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => ensureBetterAuthSchemaMock(...args),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => getSessionMock(...args),
    },
  },
}));

import { POST } from '../../app/api/voice-lab/auth/continue/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';
const CAPABILITY_SECRET = 'capability-secret-at-least-thirty-two-bytes';
const SESSION_TOKEN = 'dedicated-session-token';

function claims(
  operation: string,
  overrides: Partial<VoiceLabCapabilityClaims> = {},
): VoiceLabCapabilityClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-continuity-001',
    synthetic: true,
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    allowed_ops: [operation],
    expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: `jti-${operation}`,
    nonce: `nonce-${operation}`,
    ...overrides,
  };
}

function request(
  grantClaims: VoiceLabCapabilityClaims,
  bindingClaims: VoiceLabCapabilityClaims = claims('auth:session'),
): NextRequest {
  const binding = mintVoiceLabRunBinding(
    bindingClaims,
    SESSION_TOKEN,
    new Date(Date.now() + 3_600_000),
  );
  return new Request('https://www.sophia-ei.com/api/voice-lab/auth/continue', {
    method: 'POST',
    headers: {
      'X-Sophia-Voice-Lab-Capability': signVoiceLabCapability(grantClaims, GRANT_SECRET),
      Cookie: [
        `better-auth.session_token=${SESSION_TOKEN}`,
        `__Host-sophia-voice-lab-run-binding=${binding}`,
      ].join('; '),
    },
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/auth/continue POST', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'true';
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'false';
    process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL = 'voice-lab-user-1';
    process.env.SOPHIA_VOICE_LAB_TEST_EMAIL = 'voice-lab@example.com';
    process.env.SOPHIA_VOICE_LAB_ENVIRONMENT = 'production';
    process.env.SOPHIA_VOICE_LAB_GRANT_SECRET = GRANT_SECRET;
    process.env.SOPHIA_VOICE_LAB_CAPABILITY_SECRET = CAPABILITY_SECRET;
    process.env.VERCEL_GIT_COMMIT_SHA = BUILD;
    ensureBetterAuthSchemaMock.mockResolvedValue(undefined);
    getSessionMock.mockResolvedValue({
      session: { token: SESSION_TOKEN },
      user: { id: 'voice-lab-user-1', email: 'voice-lab@example.com' },
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('renews only the short run-bound session capability while the long auth session continues', async () => {
    const response = await POST(request(claims('session:continue')));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      test_run_id: 'run-continuity-001',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      session_preserved: true,
      allowed_ops: ['session:create', 'session:read', 'session:finalize'],
    });
    const cookies = response.headers.getSetCookie().join('\n');
    expect(cookies).toContain('__Host-sophia-voice-lab-context=');
    expect(cookies).not.toContain('better-auth.session_token=');
    expect(cookies).not.toContain('__Host-sophia-voice-lab-run-binding=');
  });

  it('echoes the exact cleanup obligation from the verified continuation grant', async () => {
    const cleanupObligationId = '223e4567-e89b-42d3-a456-426614174111';
    const grantClaims = claims('session:continue', { cleanup_obligation_id: cleanupObligationId });
    const bindingClaims = claims('auth:session', { cleanup_obligation_id: cleanupObligationId });

    const response = await POST(request(grantClaims, bindingClaims));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      test_run_id: 'run-continuity-001',
      cleanup_obligation_id: cleanupObligationId,
    });
  });

  it('requires exact V-D02 browser ownership equality across continuation and preserves it', async () => {
    const ownership = {
      voice_lab_run_id_sha256: 'd'.repeat(64),
      browser_worker_id_sha256: 'e'.repeat(64),
      browser_lease_epoch: 5,
      browser_context_id_sha256: 'f'.repeat(64),
    };
    const grantClaims = claims('session:continue', {
      scenario_id: 'V-D02',
      scenario_version: 'vt00.scenarios.v1',
      ...ownership,
    });
    const bindingClaims = claims('auth:session', {
      scenario_id: 'V-D02',
      scenario_version: 'vt00.scenarios.v1',
      ...ownership,
    });

    const response = await POST(request(grantClaims, bindingClaims));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(ownership);

    const mismatch = await POST(request(
      { ...grantClaims, browser_context_id_sha256: 'a'.repeat(64) },
      bindingClaims,
    ));
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_run_binding_mismatch',
    });
    expect(mismatch.headers.getSetCookie()).toEqual([]);
  });

  it('rejects continuation when the kill switch is engaged', async () => {
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';
    const response = await POST(request(claims('session:continue')));
    expect(response.status).toBe(403);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong-run continuation before rotating the context cookie', async () => {
    const response = await POST(request(
      claims('session:continue', { test_run_id: 'run-A' }),
      claims('auth:session', { test_run_id: 'run-B' }),
    ));
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    [
      'scenario id',
      { scenario_id: 'scenario-A' },
      { scenario_id: 'scenario-B' },
    ],
    [
      'scenario version',
      { scenario_id: 'scenario-A', scenario_version: 'v2' },
      { scenario_id: 'scenario-A', scenario_version: 'v1' },
    ],
    [
      'backend deployment',
      { expected_deployment: { frontend: BUILD, backend: 'b'.repeat(40), voice: BUILD } },
      { expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD } },
    ],
    [
      'voice deployment',
      { expected_deployment: { frontend: BUILD, backend: BUILD, voice: 'b'.repeat(40) } },
      { expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD } },
    ],
  ])('rejects changed %s before rotating the context cookie', async (
    _label,
    grantOverrides,
    bindingOverrides,
  ) => {
    const response = await POST(request(
      claims('session:continue', grantOverrides),
      claims('auth:session', bindingOverrides),
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_run_binding_mismatch',
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
