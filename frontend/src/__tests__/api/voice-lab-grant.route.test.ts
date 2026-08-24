import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  signVoiceLabCapability,
  type VoiceLabCapabilityClaims,
  VoiceLabCapabilityError,
} from '../../server/voice-lab/capability';

const ensureBetterAuthSchemaMock = vi.fn();
const makeSignatureMock = vi.fn();
const findUserByEmailMock = vi.fn();
const rotateVoiceLabSessionMock = vi.fn();
const assertVoiceLabAuthLedgerReadyMock = vi.fn();
const assertVoiceLabRetentionAdmissionReadyMock = vi.fn();

vi.mock('better-auth/crypto', () => ({
  makeSignature: (...args: unknown[]) => makeSignatureMock(...args),
}));

vi.mock('../../server/better-auth/migrations', () => ({
  ensureBetterAuthSchema: (...args: unknown[]) => ensureBetterAuthSchemaMock(...args),
}));

vi.mock('../../server/voice-lab/session-ledger', () => ({
  assertVoiceLabAuthLedgerReady: (...args: unknown[]) => assertVoiceLabAuthLedgerReadyMock(...args),
  rotateVoiceLabSession: (...args: unknown[]) => rotateVoiceLabSessionMock(...args),
}));

vi.mock('../../server/voice-lab/retention-admission', () => ({
  assertVoiceLabRetentionAdmissionReady: (...args: unknown[]) => (
    assertVoiceLabRetentionAdmissionReadyMock(...args)
  ),
}));

vi.mock('../../server/better-auth/config', () => ({
  auth: {
    $context: Promise.resolve({
      secret: 'better-auth-secret',
      authCookies: {
        sessionToken: {
          name: 'better-auth.session_token',
          attributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
        },
      },
      internalAdapter: {
        findUserByEmail: (...args: unknown[]) => findUserByEmailMock(...args),
      },
    }),
  },
}));

import { POST } from '../../app/api/voice-lab/auth/grant/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';
const CAPABILITY_SECRET = 'capability-secret-at-least-thirty-two-bytes';

function grantToken(overrides: Partial<VoiceLabCapabilityClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signVoiceLabCapability({
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
    allowed_ops: ['auth:session', 'session:create', 'session:read', 'voice:start', 'session:finalize'],
    expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
    iat: now,
    nbf: now,
    exp: now + 120,
    jti: 'jti-001',
    nonce: 'nonce-001',
    ...overrides,
  }, GRANT_SECRET);
}

function request(token?: string, body?: string): NextRequest {
  return new Request('https://www.sophia-ei.com/api/voice-lab/auth/grant', {
    method: 'POST',
    headers: token ? { 'X-Sophia-Voice-Lab-Capability': token } : undefined,
    body,
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/auth/grant POST', () => {
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
    process.env.SOPHIA_VOICE_LAB_SESSION_TTL_SECONDS = '3600';
    process.env.VERCEL_GIT_COMMIT_SHA = BUILD;
    ensureBetterAuthSchemaMock.mockResolvedValue(undefined);
    assertVoiceLabAuthLedgerReadyMock.mockResolvedValue({
      ready: true,
      migrationSha256: '9a0987a52699a513cc19cc3f944c88113d591ce35924df6e297f051cede1eb45',
    });
    assertVoiceLabRetentionAdmissionReadyMock.mockResolvedValue(undefined);
    makeSignatureMock.mockResolvedValue('signed-session');
    findUserByEmailMock.mockResolvedValue({
      user: { id: 'voice-lab-user-1', email: 'voice-lab@example.com', name: 'Voice Lab' },
    });
    rotateVoiceLabSessionMock.mockImplementation(
      async (_principalId, _grant, token, expiresAt) => ({
        token,
        expiresAt,
        idempotentReplay: false,
        expiredLabSessionsRevoked: 0,
      }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates only the pre-provisioned dedicated principal session and two HttpOnly cookies', async () => {
    const token = grantToken();
    const response = await POST(request(token));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      test_run_id: 'run-001',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(JSON.stringify(payload)).not.toContain(token);
    expect(findUserByEmailMock).toHaveBeenCalledWith('voice-lab@example.com');
    expect(rotateVoiceLabSessionMock).toHaveBeenCalledWith(
      'voice-lab-user-1',
      expect.objectContaining({ test_run_id: 'run-001', jti: 'jti-001', nonce: 'nonce-001' }),
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.any(Date),
    );
    expect(makeSignatureMock).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      'better-auth-secret',
    );
    const cookies = response.headers.getSetCookie().join('\n');
    expect(cookies).toContain('.signed-session');
    expect(cookies).toContain('__Host-sophia-voice-lab-context=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('SameSite=strict');
    expect(cookies).not.toContain('Domain=');
    for (const name of [
      '__Host-sophia-voice-lab-context=',
      '__Host-sophia-voice-lab-run-binding=',
    ]) {
      const cookie = response.headers.getSetCookie().find((value) => value.startsWith(name));
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).not.toContain('Domain=');
    }
    const sessionCookie = response.headers.getSetCookie().find(
      (value) => value.startsWith('better-auth.session_token='),
    );
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=strict');
    expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).not.toContain('Domain=');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('echoes only the exact cleanup obligation bound by the verified signed grant', async () => {
    const cleanupObligationId = '223e4567-e89b-42d3-a456-426614174111';
    const response = await POST(request(grantToken({ cleanup_obligation_id: cleanupObligationId })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      test_run_id: 'run-001',
      cleanup_obligation_id: cleanupObligationId,
    });
    expect(rotateVoiceLabSessionMock).toHaveBeenCalledWith(
      'voice-lab-user-1',
      expect.objectContaining({ cleanup_obligation_id: cleanupObligationId }),
      expect.any(String),
      expect.any(Date),
    );
  });

  it('carries the exact V-D02 browser ownership binding into the grant receipt and session ledger input', async () => {
    const ownership = {
      voice_lab_run_id_sha256: 'd'.repeat(64),
      browser_worker_id_sha256: 'e'.repeat(64),
      browser_lease_epoch: 4,
      browser_context_id_sha256: 'f'.repeat(64),
    };
    const response = await POST(request(grantToken({
      scenario_id: 'V-D02',
      scenario_version: 'vt00.scenarios.v1',
      ...ownership,
    })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(ownership);
    expect(rotateVoiceLabSessionMock).toHaveBeenCalledWith(
      'voice-lab-user-1',
      expect.objectContaining({ scenario_id: 'V-D02', ...ownership }),
      expect.any(String),
      expect.any(Date),
    );
  });

  it('makes replayed grants idempotent so response loss cannot orphan auth', async () => {
    rotateVoiceLabSessionMock.mockImplementation(
      async (_principalId, _grant, sessionToken, expiresAt) => ({
        token: sessionToken,
        expiresAt,
        idempotentReplay: rotateVoiceLabSessionMock.mock.calls.length > 1,
        expiredLabSessionsRevoked: 0,
      }),
    );
    const token = grantToken();

    const first = await POST(request(token));
    const retry = await POST(request(token));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const firstAuthCookie = first.headers.getSetCookie().find((cookie) => cookie.startsWith('better-auth.session_token='));
    const retryAuthCookie = retry.headers.getSetCookie().find((cookie) => cookie.startsWith('better-auth.session_token='));
    expect(retryAuthCookie).toBe(firstAuthCookie);
    await expect(retry.json()).resolves.toMatchObject({
      prior_session_cleanup_verified: true,
      expired_lab_sessions_revoked: 0,
      no_prior_conflicting_session: true,
      auth_session_state: 'idempotent_replay',
      idempotent_replay: true,
    });
    expect(rotateVoiceLabSessionMock.mock.calls[0][2]).toBe(rotateVoiceLabSessionMock.mock.calls[1][2]);
  });

  it('surfaces ledger ordering conflicts without setting authentication cookies', async () => {
    rotateVoiceLabSessionMock.mockRejectedValueOnce(
      new VoiceLabCapabilityError('voice_lab_stale_grant_rejected', 409),
    );

    const response = await POST(request(grantToken()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_stale_grant_rejected',
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('fails closed before principal or session work when the operated ledger is not ready', async () => {
    assertVoiceLabAuthLedgerReadyMock.mockRejectedValue(
      new VoiceLabCapabilityError('voice_lab_auth_ledger_not_ready', 503),
    );

    const response = await POST(request(grantToken()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_auth_ledger_not_ready',
    });
    expect(findUserByEmailMock).not.toHaveBeenCalled();
    expect(rotateVoiceLabSessionMock).not.toHaveBeenCalled();
  });

  it('keeps dedicated authentication valid beyond the short capability lifetime', async () => {
    const response = await POST(request(grantToken()));
    const cookies = response.headers.getSetCookie();
    const authCookie = cookies.find((cookie) => cookie.startsWith('better-auth.session_token='));
    const capabilityCookie = cookies.find((cookie) => cookie.startsWith('__Host-sophia-voice-lab-context='));

    expect(response.status).toBe(200);
    expect(authCookie).toContain('Max-Age=3600');
    expect(capabilityCookie).toContain('Max-Age=120');
    expect(Number((await response.json()).session_expires_at)).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 3000,
    );
  });

  it('rejects an out-of-bounds dedicated session lifetime before session creation', async () => {
    process.env.SOPHIA_VOICE_LAB_SESSION_TTL_SECONDS = '1799';
    const response = await POST(request(grantToken()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'voice_lab_configuration_invalid' });
    expect(rotateVoiceLabSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', () => { process.env.SOPHIA_VOICE_LAB_ENABLED = 'false'; }, 404, 'voice_lab_disabled'],
    ['kill switched', () => { process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true'; }, 403, 'voice_lab_kill_switch_active'],
    ['missing capability', () => undefined, 401, 'voice_lab_capability_missing'],
  ])('rejects %s without touching Better Auth', async (_label, arrange, status, code) => {
    arrange();
    const response = await POST(request());
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, error: code });
    expect(ensureBetterAuthSchemaMock).not.toHaveBeenCalled();
    expect(rotateVoiceLabSessionMock).not.toHaveBeenCalled();
  });

  it('rejects caller-selected request bodies', async () => {
    const response = await POST(request(grantToken(), JSON.stringify({ email: 'ordinary@example.com' })));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'voice_lab_request_body_not_allowed' });
    expect(ensureBetterAuthSchemaMock).not.toHaveBeenCalled();
  });

  it('fails typed and closed when the exact principal is absent', async () => {
    findUserByEmailMock.mockResolvedValue(null);
    const response = await POST(request(grantToken()));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'voice_lab_test_principal_not_provisioned' });
    expect(rotateVoiceLabSessionMock).not.toHaveBeenCalled();
  });

  it('fails typed and closed when the configured email resolves to another user id', async () => {
    findUserByEmailMock.mockResolvedValue({
      user: { id: 'ordinary-user', email: 'voice-lab@example.com', name: 'Wrong user' },
    });
    const response = await POST(request(grantToken()));
    expect(response.status).toBe(403);
    expect(rotateVoiceLabSessionMock).not.toHaveBeenCalled();
  });
});
