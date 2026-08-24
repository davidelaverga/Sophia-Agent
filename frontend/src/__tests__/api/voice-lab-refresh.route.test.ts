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

import { POST } from '../../app/api/voice-lab/auth/refresh/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';
const CAPABILITY_SECRET = 'capability-secret-at-least-thirty-two-bytes';

function finalizationClaims(overrides: Partial<VoiceLabCapabilityClaims> = {}): VoiceLabCapabilityClaims {
  const now = Math.floor(Date.now() / 1000);
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
    allowed_ops: ['session:finalize'],
    expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: 'jti-refresh-001',
    nonce: 'nonce-refresh-001',
    ...overrides,
  };
}

function finalizationGrant(overrides: Partial<VoiceLabCapabilityClaims> = {}): string {
  return signVoiceLabCapability(finalizationClaims(overrides), GRANT_SECRET);
}

function request(
  token?: string,
  body?: string,
  bindingClaims: VoiceLabCapabilityClaims = finalizationClaims(),
): NextRequest {
  const binding = mintVoiceLabRunBinding(
    bindingClaims,
    'opaque-http-only-session',
    new Date(Date.now() + 3_600_000),
  );
  return new Request('https://www.sophia-ei.com/api/voice-lab/auth/refresh', {
    method: 'POST',
    headers: {
      ...(token ? { 'X-Sophia-Voice-Lab-Capability': token } : {}),
      Cookie: [
        'better-auth.session_token=opaque-http-only-session',
        `__Host-sophia-voice-lab-run-binding=${binding}`,
      ].join('; '),
    },
    body,
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/auth/refresh POST', () => {
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
      session: { token: 'opaque-http-only-session' },
      user: { id: 'voice-lab-user-1', email: 'voice-lab@example.com', name: 'Voice Lab' },
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rotates only the HttpOnly finalization capability for the authenticated exact principal', async () => {
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';
    const response = await POST(request(finalizationGrant()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      test_run_id: 'run-001',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      allowed_ops: ['session:finalize'],
    });
    const sessionHeaders = getSessionMock.mock.calls[0][0].headers as Headers;
    expect(sessionHeaders.get('cookie')).toContain('better-auth.session_token=');
    const cookies = response.headers.getSetCookie().join('\n');
    expect(cookies).toContain('__Host-sophia-voice-lab-context=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('SameSite=strict');
    expect(cookies).not.toContain('better-auth.session_token=');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('echoes only the cleanup obligation bound by the signed grant and run cookie', async () => {
    const cleanupObligationId = '123e4567-e89b-42d3-a456-426614174099';
    const claims = finalizationClaims({ cleanup_obligation_id: cleanupObligationId });
    const response = await POST(request(
      signVoiceLabCapability(claims, GRANT_SECRET),
      undefined,
      claims,
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cleanup_obligation_id: cleanupObligationId,
    });
  });

  it.each([
    ['missing capability', undefined, 'voice_lab_capability_missing', 401],
    [
      'wrong operation',
      finalizationGrant({ allowed_ops: ['voice:start'] }),
      'voice_lab_capability_operation_denied',
      403,
    ],
  ])('rejects %s before reading the authenticated session', async (_label, token, code, status) => {
    const response = await POST(request(token));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, error: code });
    expect(ensureBetterAuthSchemaMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('rejects an ordinary authenticated user without rotating the cookie', async () => {
    getSessionMock.mockResolvedValue({
      session: { token: 'ordinary-session' },
      user: { id: 'ordinary-user', email: 'ordinary@example.com' },
    });
    const response = await POST(request(finalizationGrant()));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_authenticated_principal_required',
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('rejects a run-A grant against a browser session bound to run B', async () => {
    const response = await POST(request(
      finalizationGrant({ test_run_id: 'run-A' }),
      undefined,
      finalizationClaims({ test_run_id: 'run-B' }),
    ));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_run_binding_mismatch',
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('rejects caller-controlled bodies before session lookup', async () => {
    const response = await POST(request(finalizationGrant(), JSON.stringify({ principal_id: 'ordinary-user' })));
    expect(response.status).toBe(400);
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});
