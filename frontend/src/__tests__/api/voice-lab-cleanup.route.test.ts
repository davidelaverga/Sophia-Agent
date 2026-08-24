import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mintVoiceLabRunBinding,
  signVoiceLabCapability,
  type VoiceLabCapabilityClaims,
} from '../../server/voice-lab/capability';

const ensureBetterAuthSchemaMock = vi.fn();
const getSessionMock = vi.fn();
const revokeVoiceLabSessionsMock = vi.fn();

vi.mock('../../server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => ensureBetterAuthSchemaMock(...args),
}));

vi.mock('../../server/voice-lab/session-ledger', () => ({
  revokeVoiceLabSessions: (...args: unknown[]) => revokeVoiceLabSessionsMock(...args),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => getSessionMock(...args),
    },
    $context: Promise.resolve({
      authCookies: {
        sessionToken: {
          name: 'better-auth.session_token',
          attributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
        },
        sessionData: {
          name: 'better-auth.session_data',
          attributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
        },
        dontRememberToken: {
          name: 'better-auth.dont_remember',
          attributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
        },
      },
    }),
  },
}));

import { POST } from '../../app/api/voice-lab/auth/cleanup/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';
const CAPABILITY_SECRET = 'capability-secret-at-least-thirty-two-bytes';

function cleanupClaims(overrides: Partial<VoiceLabCapabilityClaims> = {}): VoiceLabCapabilityClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-cleanup-001',
    synthetic: true,
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    allowed_ops: ['session:cleanup'],
    expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: 'jti-cleanup-001',
    nonce: 'nonce-cleanup-001',
    ...overrides,
  };
}

function cleanupGrant(overrides: Partial<VoiceLabCapabilityClaims> = {}): string {
  return signVoiceLabCapability(cleanupClaims(overrides), GRANT_SECRET);
}

function request(
  token?: string,
  bindingClaims: VoiceLabCapabilityClaims = cleanupClaims(),
): NextRequest {
  const binding = mintVoiceLabRunBinding(
    bindingClaims,
    'raw-current-session-token',
    new Date(Date.now() + 3_600_000),
  );
  return new Request('https://www.sophia-ei.com/api/voice-lab/auth/cleanup', {
    method: 'POST',
    headers: {
      ...(token ? { 'X-Sophia-Voice-Lab-Capability': token } : {}),
      Cookie: [
        'better-auth.session_token=signed-token',
        'better-auth.session_data.0=chunk-zero',
        '__Host-sophia-voice-lab-context=opaque-capability',
        `__Host-sophia-voice-lab-run-binding=${binding}`,
        'sophia-backend-token=opaque-backend-token',
      ].join('; '),
    },
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/auth/cleanup POST', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'true';
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';
    process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL = 'voice-lab-user-1';
    process.env.SOPHIA_VOICE_LAB_TEST_EMAIL = 'voice-lab@example.com';
    process.env.SOPHIA_VOICE_LAB_ENVIRONMENT = 'production';
    process.env.SOPHIA_VOICE_LAB_GRANT_SECRET = GRANT_SECRET;
    process.env.SOPHIA_VOICE_LAB_CAPABILITY_SECRET = CAPABILITY_SECRET;
    process.env.VERCEL_GIT_COMMIT_SHA = BUILD;
    ensureBetterAuthSchemaMock.mockResolvedValue(undefined);
    revokeVoiceLabSessionsMock.mockResolvedValue(1);
    getSessionMock.mockResolvedValue({
      session: { token: 'raw-current-session-token' },
      user: { id: 'voice-lab-user-1', email: 'voice-lab@example.com', name: 'Voice Lab' },
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('revokes only the current exact-principal session and clears all synthetic auth cookies under kill switch', async () => {
    const token = cleanupGrant();
    const response = await POST(request(token));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      session_revoked: true,
      test_run_id: 'run-cleanup-001',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      cookies_cleared: true,
      revoked_scope: 'dedicated_principal',
      revoked_session_count: 1,
    });
    expect(JSON.stringify(payload)).not.toContain('raw-current-session-token');
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(revokeVoiceLabSessionsMock).toHaveBeenCalledWith(
      'voice-lab-user-1',
      expect.objectContaining({ test_run_id: 'run-cleanup-001' }),
    );
    const cookies = response.headers.getSetCookie().join('\n');
    expect(cookies).toContain('better-auth.session_token=;');
    expect(cookies).toContain('better-auth.session_data.0=;');
    expect(cookies).toContain('__Host-sophia-voice-lab-context=;');
    expect(cookies).toContain('__Host-sophia-voice-lab-run-binding=;');
    expect(cookies).toContain('sophia-backend-token=;');
    expect(cookies.match(/Max-Age=0/g)?.length).toBeGreaterThanOrEqual(4);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('echoes the exact cleanup obligation from the verified cleanup grant', async () => {
    const cleanupObligationId = '223e4567-e89b-42d3-a456-426614174111';
    const response = await POST(request(
      cleanupGrant({ cleanup_obligation_id: cleanupObligationId }),
      cleanupClaims({ cleanup_obligation_id: cleanupObligationId }),
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      test_run_id: 'run-cleanup-001',
      cleanup_obligation_id: cleanupObligationId,
    });
    expect(revokeVoiceLabSessionsMock).toHaveBeenCalledWith(
      'voice-lab-user-1',
      expect.objectContaining({ cleanup_obligation_id: cleanupObligationId }),
    );
  });

  it('rejects cross-run cleanup before sweeping any dedicated sessions', async () => {
    const response = await POST(request(
      cleanupGrant({ test_run_id: 'run-A' }),
      cleanupClaims({ test_run_id: 'run-B' }),
    ));
    expect(response.status).toBe(409);
    expect(revokeVoiceLabSessionsMock).not.toHaveBeenCalled();
  });

  it('cannot revoke an ordinary authenticated user session', async () => {
    getSessionMock.mockResolvedValue({
      session: { token: 'ordinary-session-token' },
      user: { id: 'ordinary-user', email: 'ordinary@example.com' },
    });
    const response = await POST(request(cleanupGrant()));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_authenticated_principal_required',
    });
    expect(revokeVoiceLabSessionsMock).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('rejects missing cleanup grants before reading or deleting any session', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(revokeVoiceLabSessionsMock).not.toHaveBeenCalled();
  });
});
