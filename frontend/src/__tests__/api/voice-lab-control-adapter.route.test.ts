import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mintGatewayCapability,
  mintVoiceLabRunBinding,
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

import { POST } from '../../app/api/voice-lab/control/[action]/route';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';
const CAPABILITY_SECRET = 'capability-secret-at-least-thirty-two-bytes';
const SESSION_TOKEN = 'dedicated-session-token';

function grantClaims(overrides: Partial<VoiceLabCapabilityClaims> = {}): VoiceLabCapabilityClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-control-001',
    scenario_id: 'V-P01',
    scenario_version: 'vt00.scenarios.v1',
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
    jti: 'jti-control-001',
    nonce: 'nonce-control-001',
    ...overrides,
  };
}

function request(overrides: {
  contextClaims?: VoiceLabCapabilityClaims;
  bindingClaims?: VoiceLabCapabilityClaims;
  includeContext?: boolean;
  includeBinding?: boolean;
} = {}): NextRequest {
  const source = overrides.contextClaims ?? grantClaims();
  const verifiedFrontendGrant = { ...source };
  const contextToken = mintGatewayCapability(verifiedFrontendGrant);
  const binding = mintVoiceLabRunBinding(
    overrides.bindingClaims ?? source,
    SESSION_TOKEN,
    new Date(Date.now() + 3_600_000),
  );
  const cookies = [
    ...(overrides.includeContext === false ? [] : [`__Host-sophia-voice-lab-context=${contextToken}`]),
    ...(overrides.includeBinding === false ? [] : [`__Host-sophia-voice-lab-run-binding=${binding}`]),
  ];
  return new Request('https://www.sophia-ei.com/api/voice-lab/control/session-start', {
    method: 'POST',
    headers: { Cookie: cookies.join('; ') },
  }) as unknown as NextRequest;
}

describe('/api/voice-lab/control/[action] POST', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'true';
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'false';
    process.env.SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED = 'true';
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

  it.each([
    ['session-start', 'session-start'],
    ['voice-start', 'voice-start'],
  ])('authorizes the exact existing %s action from the run-bound server context', async (routeAction, expectedAction) => {
    const response = await POST(request(), { params: Promise.resolve({ action: routeAction }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const expectedReceipt = {
      ok: true,
      schema: 'sophia_voice_lab_control_adapter_v1',
      action: expectedAction,
      test_run_id: 'run-control-001',
      scenario_id: 'V-P01',
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      expected_deployment: { frontend: BUILD, backend: BUILD, voice: BUILD },
      ordinary_user_access: false,
    };
    await expect(response.clone().json()).resolves.toMatchObject(expectedReceipt);
    expect(JSON.parse(decodeURIComponent(
      response.headers.get('x-sophia-voice-lab-control-receipt') || '',
    ))).toMatchObject(expectedReceipt);
  });

  it('is default-disabled even for a valid synthetic principal and capability', async () => {
    delete process.env.SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED;
    const response = await POST(request(), { params: Promise.resolve({ action: 'session-start' }) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_control_adapter_disabled',
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing control capability', { includeContext: false }, 'voice_lab_capability_missing'],
    ['missing run binding', { includeBinding: false }, 'voice_lab_run_binding_missing'],
  ])('rejects %s', async (_label, requestOptions, expectedError) => {
    const response = await POST(request(requestOptions), { params: Promise.resolve({ action: 'session-start' }) });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: expectedError });
  });

  it('rejects cross-run binding and never returns an action', async () => {
    const response = await POST(request({
      bindingClaims: grantClaims({ test_run_id: 'run-control-other' }),
    }), { params: Promise.resolve({ action: 'voice-start' }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_run_binding_mismatch',
    });
  });

  it('rejects an unknown action and any body before product action dispatch', async () => {
    const unknown = await POST(request(), { params: Promise.resolve({ action: 'navigate' }) });
    expect(unknown.status).toBe(404);

    const bodyRequest = new Request('https://www.sophia-ei.com/api/voice-lab/control/session-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }) as unknown as NextRequest;
    const body = await POST(bodyRequest, { params: Promise.resolve({ action: 'session-start' }) });
    expect(body.status).toBe(400);
    await expect(body.json()).resolves.toEqual({
      ok: false,
      error: 'voice_lab_request_body_not_allowed',
    });
  });
});
