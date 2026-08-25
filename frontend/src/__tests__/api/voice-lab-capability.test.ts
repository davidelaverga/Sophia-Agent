import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serverContext = vi.hoisted(() => ({
  cookies: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: serverContext.cookies }));
vi.mock('@/server/better-auth', () => ({ getSession: serverContext.getSession }));

import goldenVector from '../../../../testdata/voice_lab_capability_v1.json';

import {
  assertNoVoiceLabRequestBody,
  assertVoiceLabEnabled,
  getVoiceLabControlGates,
  getVoiceLabSyntheticIsolationPolicy,
  isVoiceLabRuntimeEnabled,
  mintGatewayCapability,
  resolveVoiceLabSyntheticIsolationPolicy,
  signVoiceLabCapability,
  verifyFrontendCapability,
  verifyFrontendGrant,
  verifyVoiceLabCapability,
  type VoiceLabCapabilityClaims,
  VoiceLabCapabilityError,
} from '../../server/voice-lab/capability';

const BUILD = '41a9b127af780bbe9d88acf34566a6aaf443e6b0';
const OTHER_BUILD = 'a793100008f7ccb5a25e9e018f896e7ec9dc2a3d';
const GRANT_SECRET = 'grant-secret-that-is-at-least-thirty-two-bytes';
const CAPABILITY_SECRET = 'capability-secret-at-least-thirty-two-bytes';
const NOW = 1_800_000_000;

function claims(overrides: Partial<VoiceLabCapabilityClaims> = {}): VoiceLabCapabilityClaims {
  return {
    v: 1,
    iss: 'sophia-voice-lab',
    aud: 'sophia-voice-lab-frontend',
    sub: 'voice-lab-user-1',
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-001',
    scenario_id: 'vt00-realtime-001',
    scenario_version: 'v1',
    synthetic: true,
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    allowed_ops: ['auth:session', 'session:create', 'session:read', 'voice:start', 'session:finalize'],
    expected_deployment: {
      frontend: BUILD,
      backend: BUILD,
      voice: BUILD,
    },
    iat: NOW,
    nbf: NOW,
    exp: NOW + 120,
    jti: 'jti-001',
    nonce: 'nonce-001',
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string) {
  try {
    operation();
    throw new Error('expected operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(VoiceLabCapabilityError);
    expect(error).toMatchObject({ code });
  }
}

describe('voice lab capability contract', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    serverContext.cookies.mockReset();
    serverContext.cookies.mockResolvedValue({
      get: () => undefined,
      has: () => false,
    });
    serverContext.getSession.mockReset();
    serverContext.getSession.mockResolvedValue(null);
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'true';
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'false';
    process.env.SOPHIA_VOICE_LAB_PROVISIONING_ENABLED = 'false';
    process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL = 'voice-lab-user-1';
    process.env.SOPHIA_VOICE_LAB_TEST_EMAIL = 'voice-lab@example.com';
    process.env.SOPHIA_VOICE_LAB_ENVIRONMENT = 'production';
    process.env.SOPHIA_VOICE_LAB_GRANT_SECRET = GRANT_SECRET;
    process.env.SOPHIA_VOICE_LAB_CAPABILITY_SECRET = CAPABILITY_SECRET;
    process.env.VERCEL_GIT_COMMIT_SHA = BUILD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts an inbound server stream only when the wire length is explicitly zero', () => {
    const serverWrappedEmptyRequest = new Request('https://www.sophia-ei.com/control', {
      method: 'POST',
      headers: { 'content-length': '0' },
      body: new ReadableStream(),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect(serverWrappedEmptyRequest.body).not.toBeNull();
    expect(() => assertNoVoiceLabRequestBody(serverWrappedEmptyRequest)).not.toThrow();
  });

  it('rejects nonzero and transfer-encoded control request bodies', () => {
    expectCode(
      () => assertNoVoiceLabRequestBody(new Request('https://www.sophia-ei.com/control', {
        method: 'POST',
        headers: { 'content-length': '1' },
        body: 'x',
      })),
      'voice_lab_request_body_not_allowed',
    );
    expectCode(
      () => assertNoVoiceLabRequestBody(new Request('https://www.sophia-ei.com/control', {
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked' },
        body: 'x',
      })),
      'voice_lab_request_body_not_allowed',
    );
  });

  it('accepts a valid short-lived grant and mints a narrower gateway token', () => {
    const grant = signVoiceLabCapability(claims(), GRANT_SECRET);
    const verified = verifyFrontendGrant(grant, NOW);
    const gateway = mintGatewayCapability(verified, NOW);

    expect(verified.test_run_id).toBe('run-001');
    const gatewayClaims = verifyVoiceLabCapability(
      gateway,
      CAPABILITY_SECRET,
      {
        audience: 'sophia-voice-gateway',
        issuer: 'sophia-frontend',
        requiredOperation: 'voice:start',
        principalId: 'voice-lab-user-1',
        environment: 'production',
        expectedFrontendBuild: BUILD,
      },
      NOW,
    );
    expect(gatewayClaims.allowed_ops).toEqual([
      'session:create',
      'session:read',
      'voice:start',
      'session:finalize',
    ]);
    expect(gatewayClaims.expected_deployment).toEqual({ frontend: BUILD, backend: BUILD, voice: BUILD });
  });

  it('preserves the complete positive-epoch V-D02 ownership quartet and rejects partial or foreign-scenario claims', () => {
    const ownership = {
      voice_lab_run_id_sha256: 'd'.repeat(64),
      browser_worker_id_sha256: 'e'.repeat(64),
      browser_lease_epoch: 9,
      browser_context_id_sha256: 'f'.repeat(64),
    };
    const d02 = claims({
      scenario_id: 'V-D02',
      scenario_version: 'vt00.scenarios.v1',
      ...ownership,
    });
    const verified = verifyFrontendGrant(signVoiceLabCapability(d02, GRANT_SECRET), NOW);
    expect(verified).toMatchObject(ownership);
    const gateway = mintGatewayCapability(verified, NOW);
    expect(verifyVoiceLabCapability(gateway, CAPABILITY_SECRET, {
      audience: 'sophia-voice-gateway',
      issuer: 'sophia-frontend',
      requiredOperation: 'session:create',
      principalId: 'voice-lab-user-1',
      environment: 'production',
      expectedFrontendBuild: BUILD,
    }, NOW)).toMatchObject(ownership);

    for (const malformed of [
      { ...d02, browser_context_id_sha256: undefined },
      { ...d02, browser_lease_epoch: 0 },
      { ...d02, scenario_id: 'V-A01' },
    ]) {
      expectCode(
        () => verifyFrontendGrant(signVoiceLabCapability(malformed, GRANT_SECRET), NOW),
        'voice_lab_capability_malformed',
      );
    }
    expectCode(
      () => verifyFrontendGrant(signVoiceLabCapability(claims({ scenario_id: 'V-D02' }), GRANT_SECRET), NOW),
      'voice_lab_capability_malformed',
    );
  });

  it('authors an exact content-free analytics exclusion from the HttpOnly lab context', () => {
    const grant = verifyFrontendGrant(
      signVoiceLabCapability(claims(), GRANT_SECRET),
      NOW,
    );
    const gateway = mintGatewayCapability(grant, NOW);

    expect(resolveVoiceLabSyntheticIsolationPolicy(gateway, NOW)).toEqual({
      schema: 'sophia_synthetic_isolation_policy_v1',
      source: 'verified_voice_lab_context',
      synthetic: true,
      ordinary_product_analytics_excluded: true,
      ordinary_error_reporting_excluded: true,
      sink_allocation_allowed: false,
      reason: 'synthetic_isolation_policy',
    });
  });

  it('allows ordinary analytics only with no lab cookies and fails closed on drift', () => {
    expect(resolveVoiceLabSyntheticIsolationPolicy(null, NOW, false)).toEqual({
      schema: 'sophia_synthetic_isolation_policy_v1',
      source: 'ordinary_request',
      synthetic: false,
      ordinary_product_analytics_excluded: false,
      ordinary_error_reporting_excluded: false,
      sink_allocation_allowed: true,
      reason: null,
    });
    expect(resolveVoiceLabSyntheticIsolationPolicy(null, NOW, true)).toMatchObject({
      source: 'unverified_voice_lab_context_fail_closed',
      sink_allocation_allowed: false,
    });
    expect(resolveVoiceLabSyntheticIsolationPolicy('malformed', NOW, false)).toMatchObject({
      source: 'unverified_voice_lab_context_fail_closed',
      sink_allocation_allowed: false,
    });
  });

  it('keeps a marker-free dedicated Better-Auth identity excluded from browser sinks', async () => {
    serverContext.getSession.mockResolvedValue({
      user: { id: 'voice-lab-user-1' },
    });
    await expect(getVoiceLabSyntheticIsolationPolicy()).resolves.toMatchObject({
      source: 'unverified_voice_lab_context_fail_closed',
      synthetic: true,
      ordinary_product_analytics_excluded: true,
      ordinary_error_reporting_excluded: true,
      sink_allocation_allowed: false,
    });
  });

  it('preserves a marker-free ordinary identity and fails closed on identity lookup outage', async () => {
    serverContext.getSession.mockResolvedValue({ user: { id: 'ordinary-user-1' } });
    await expect(getVoiceLabSyntheticIsolationPolicy()).resolves.toMatchObject({
      source: 'ordinary_request',
      synthetic: false,
      sink_allocation_allowed: true,
    });

    serverContext.getSession.mockRejectedValue(new Error('better-auth unavailable'));
    await expect(getVoiceLabSyntheticIsolationPolicy()).resolves.toMatchObject({
      source: 'unverified_voice_lab_context_fail_closed',
      synthetic: true,
      sink_allocation_allowed: false,
    });
  });

  it('preserves trace:fault authority only for an explicitly authorized V-L01 grant', () => {
    const authorized = verifyFrontendGrant(signVoiceLabCapability(claims({
      scenario_id: 'V-L01',
      scenario_version: 'vt00.scenarios.v1',
      allowed_ops: [
        'auth:session',
        'session:create',
        'session:read',
        'voice:start',
        'session:finalize',
        'trace:fault',
      ],
    }), GRANT_SECRET), NOW);
    const gateway = mintGatewayCapability(authorized, NOW);
    const gatewayClaims = verifyVoiceLabCapability(gateway, CAPABILITY_SECRET, {
      audience: 'sophia-voice-gateway',
      issuer: 'sophia-frontend',
      requiredOperation: 'trace:fault',
      principalId: 'voice-lab-user-1',
      environment: 'production',
      expectedFrontendBuild: BUILD,
    }, NOW);
    expect(gatewayClaims.allowed_ops).toContain('trace:fault');

    const missingFaultAuthority = verifyFrontendGrant(signVoiceLabCapability(claims({
      scenario_id: 'V-L01',
      scenario_version: 'vt00.scenarios.v1',
    }), GRANT_SECRET), NOW);
    expectCode(
      () => mintGatewayCapability(missingFaultAuthority, NOW),
      'voice_lab_capability_operation_denied',
    );
  });

  it('consumes the shared cross-language HMAC golden vector and malformed cases', () => {
    const payload = goldenVector.payload as VoiceLabCapabilityClaims;
    expect(signVoiceLabCapability(payload, goldenVector.secret)).toBe(goldenVector.token);
    expect(verifyVoiceLabCapability(
      goldenVector.token,
      goldenVector.secret,
      {
        audience: 'sophia-voice-runtime',
        issuer: 'sophia-gateway',
        requiredOperation: 'session:create',
        principalId: 'voice-lab-user-1',
        environment: 'production',
        expectedFrontendBuild: BUILD,
      },
      goldenVector.now_seconds,
    ).test_run_id).toBe('golden-run-001');

    expectCode(
      () => verifyVoiceLabCapability(
        goldenVector.malformed.invalid_signature,
        goldenVector.secret,
        {
          audience: 'sophia-voice-runtime', issuer: 'sophia-gateway', requiredOperation: 'session:create',
          principalId: 'voice-lab-user-1', environment: 'production', expectedFrontendBuild: BUILD,
        },
        goldenVector.now_seconds,
      ),
      'voice_lab_capability_invalid_signature',
    );
    expectCode(
      () => verifyVoiceLabCapability(
        goldenVector.malformed.noncanonical_base64,
        goldenVector.secret,
        {
          audience: 'sophia-voice-runtime', issuer: 'sophia-gateway', requiredOperation: 'session:create',
          principalId: 'voice-lab-user-1', environment: 'production', expectedFrontendBuild: BUILD,
        },
        goldenVector.now_seconds,
      ),
      'voice_lab_capability_invalid_signature',
    );
    for (const token of [goldenVector.malformed.non_object_payload, goldenVector.malformed.three_parts]) {
      expectCode(
        () => verifyVoiceLabCapability(
          token,
          goldenVector.secret,
          {
            audience: 'sophia-voice-runtime', issuer: 'sophia-gateway', requiredOperation: 'session:create',
            principalId: 'voice-lab-user-1', environment: 'production', expectedFrontendBuild: BUILD,
          },
          goldenVector.now_seconds,
        ),
        'voice_lab_capability_malformed',
      );
    }
    for (const malformed of goldenVector.strict_malformed_claims) {
      const malformedClaims = {
        ...goldenVector.payload,
        ...malformed.overrides,
      } as unknown as VoiceLabCapabilityClaims;
      expectCode(
        () => verifyVoiceLabCapability(
          signVoiceLabCapability(malformedClaims, goldenVector.secret),
          goldenVector.secret,
          {
            audience: 'sophia-voice-runtime', issuer: 'sophia-gateway', requiredOperation: 'session:create',
            principalId: 'voice-lab-user-1', environment: 'production', expectedFrontendBuild: BUILD,
          },
          goldenVector.now_seconds,
        ),
        malformed.expected_code,
      );
    }
  });

  it('defaults disabled and kill-switched unless both controls are explicitly opened', () => {
    delete process.env.SOPHIA_VOICE_LAB_ENABLED;
    expectCode(() => assertVoiceLabEnabled(), 'voice_lab_disabled');

    process.env.SOPHIA_VOICE_LAB_ENABLED = 'true';
    delete process.env.SOPHIA_VOICE_LAB_KILL_SWITCH;
    expectCode(() => assertVoiceLabEnabled(), 'voice_lab_kill_switch_active');
  });

  it.each([
    ['exact true', 'true', true],
    ['normalized true', ' TrUe ', true],
    ['explicit false', 'false', false],
    ['numeric truthy text', '1', false],
    ['hostile text', 'enabled', false],
    ['missing', undefined, false],
  ] as const)('projects %s as the exact runtime enablement boolean', (_label, configured, expected) => {
    if (configured === undefined) delete process.env.SOPHIA_VOICE_LAB_ENABLED;
    else process.env.SOPHIA_VOICE_LAB_ENABLED = configured;

    expect(isVoiceLabRuntimeEnabled()).toBe(expected);
    expect(getVoiceLabControlGates().voiceLabEnabled).toBe(expected);
    if (expected) expect(() => assertVoiceLabEnabled()).not.toThrow();
    else expectCode(() => assertVoiceLabEnabled(), 'voice_lab_disabled');
  });

  it('blocks new session/voice authority under kill but permits signed inspect, finalization, cleanup, and provisioning', () => {
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';
    const finalizeToken = signVoiceLabCapability(
      claims({ allowed_ops: ['session:finalize'] }),
      GRANT_SECRET,
    );
    const cleanupToken = signVoiceLabCapability(
      claims({ allowed_ops: ['session:cleanup'] }),
      GRANT_SECRET,
    );
    const readToken = signVoiceLabCapability(
      claims({ allowed_ops: ['session:read'] }),
      GRANT_SECRET,
    );
    const provisionToken = signVoiceLabCapability(
      claims({ allowed_ops: ['auth:provision'] }),
      GRANT_SECRET,
    );

    expectCode(() => verifyFrontendGrant(signVoiceLabCapability(claims(), GRANT_SECRET), NOW), 'voice_lab_kill_switch_active');
    expectCode(() => assertVoiceLabEnabled(), 'voice_lab_kill_switch_active');
    expect(verifyFrontendCapability(finalizeToken, 'session:finalize', NOW).test_run_id).toBe('run-001');
    expect(verifyFrontendCapability(cleanupToken, 'session:cleanup', NOW).test_run_id).toBe('run-001');
    expect(verifyFrontendCapability(readToken, 'session:read', NOW).test_run_id).toBe('run-001');
    expect(verifyFrontendCapability(provisionToken, 'auth:provision', NOW).test_run_id).toBe('run-001');
  });

  it('requires an enabled lab even for cleanup operations', () => {
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'false';
    const cleanupToken = signVoiceLabCapability(
      claims({ allowed_ops: ['session:cleanup'] }),
      GRANT_SECRET,
    );
    expectCode(() => verifyFrontendCapability(cleanupToken, 'session:cleanup', NOW), 'voice_lab_disabled');
  });

  it('permits only signed provisioning and readiness while disabled and kill-switched', () => {
    process.env.SOPHIA_VOICE_LAB_ENABLED = 'false';
    process.env.SOPHIA_VOICE_LAB_KILL_SWITCH = 'true';
    const provisionToken = signVoiceLabCapability(
      claims({ allowed_ops: ['auth:provision'] }),
      GRANT_SECRET,
    );
    const readinessToken = signVoiceLabCapability(
      claims({ allowed_ops: ['auth:readiness'] }),
      GRANT_SECRET,
    );

    expect(verifyFrontendCapability(provisionToken, 'auth:provision', NOW).test_run_id).toBe('run-001');
    expect(verifyFrontendCapability(readinessToken, 'auth:readiness', NOW).test_run_id).toBe('run-001');
    expectCode(
      () => verifyFrontendGrant(signVoiceLabCapability(claims(), GRANT_SECRET), NOW),
      'voice_lab_disabled',
    );
  });

  it.each([
    ['missing', undefined, 'voice_lab_capability_missing'],
    ['malformed', 'not-a-compact-token', 'voice_lab_capability_malformed'],
    ['invalid signature', `${signVoiceLabCapability(claims(), GRANT_SECRET)}x`, 'voice_lab_capability_invalid_signature'],
    [
      'expired',
      signVoiceLabCapability(claims({ iat: NOW - 120, nbf: NOW - 120, exp: NOW - 1 }), GRANT_SECRET),
      'voice_lab_capability_expired_or_not_yet_valid',
    ],
    ['wrong audience', signVoiceLabCapability(claims({ aud: 'some-other-service' }), GRANT_SECRET), 'voice_lab_capability_wrong_audience'],
    ['wrong principal', signVoiceLabCapability(claims({ sub: 'ordinary-user', principal_id: 'ordinary-user' }), GRANT_SECRET), 'voice_lab_capability_wrong_principal'],
    ['wrong environment', signVoiceLabCapability(claims({ environment: 'staging' }), GRANT_SECRET), 'voice_lab_capability_wrong_environment'],
    ['missing operation', signVoiceLabCapability(claims({ allowed_ops: ['voice:start'] }), GRANT_SECRET), 'voice_lab_capability_operation_denied'],
    ['missing nonce', signVoiceLabCapability(claims({ nonce: '' }), GRANT_SECRET), 'voice_lab_capability_malformed'],
    [
      'deployment mismatch',
      signVoiceLabCapability(claims({ expected_deployment: { frontend: OTHER_BUILD, backend: BUILD, voice: BUILD } }), GRANT_SECRET),
      'voice_lab_capability_deployment_mismatch',
    ],
    ['overlong lifetime', signVoiceLabCapability(claims({ exp: NOW + 301 }), GRANT_SECRET), 'voice_lab_capability_invalid_lifetime'],
  ])('rejects %s before session creation', (_label, token, expectedCode) => {
    expectCode(() => verifyFrontendGrant(token, NOW), expectedCode);
  });

  it('rejects signatures made with another secret without returning secret material', () => {
    const token = signVoiceLabCapability(claims(), 'another-secret-that-is-at-least-thirty-two-bytes');
    expectCode(() => verifyFrontendGrant(token, NOW), 'voice_lab_capability_invalid_signature');
  });

  it.each(['not-a-number', '0', '301', '1.5'])(
    'fails closed for invalid configured capability TTL %s',
    (configuredTtl) => {
      process.env.SOPHIA_VOICE_LAB_MAX_TTL_SECONDS = configuredTtl;
      const token = signVoiceLabCapability(claims(), GRANT_SECRET);
      expectCode(() => verifyFrontendGrant(token, NOW), 'voice_lab_configuration_invalid');
    },
  );
});
