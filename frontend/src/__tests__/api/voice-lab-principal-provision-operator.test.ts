import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  loadPrincipalProvisionConfig,
  provisionVoiceLabPrincipal,
  VoiceLabPrincipalProvisionError,
} from '../../../scripts/provision-voice-lab-principal.mjs';

const FRONTEND = 'a'.repeat(40);
const BACKEND = 'b'.repeat(40);
const VOICE = 'c'.repeat(40);
const MCP = 'd'.repeat(40);
const BEARER = 'principal-provision-operator-bearer-000001';
const IDEMPOTENCY_KEY = 'vt00-principal-provision-candidate-001';

function env(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    SOPHIA_VOICE_LAB_PRINCIPAL_PROVISION_APPROVED: 'YES',
    SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'true',
    SOPHIA_VOICE_LAB_PROVISION_OPERATOR_BEARER_TOKEN: BEARER,
    SOPHIA_VOICE_LAB_PRINCIPAL_PROVISION_IDEMPOTENCY_KEY: IDEMPOTENCY_KEY,
    SOPHIA_VOICE_LAB_ENVIRONMENT: 'production',
    SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: FRONTEND,
    SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: BACKEND,
    SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: VOICE,
    SOPHIA_VOICE_LAB_EXPECTED_MCP_SHA: MCP,
    SOPHIA_VOICE_LAB_TARGET_MCP_URL: 'https://sophia-voice-lab-mcp.onrender.com',
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`;
  if (input && typeof input === 'object') {
    return `{${Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`).join(',')}}`;
  }
  return JSON.stringify(input);
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { idempotent_replay: idempotentReplay = false, ...coreOverrides } = overrides;
  const core = {
    schema: 'sophia_voice_lab_principal_provision_receipt_v1',
    ok: true,
    provisioned: true,
    idempotency_key_sha256: sha256(IDEMPOTENCY_KEY),
    operator_request_sha256: '1'.repeat(64),
    principal_id_sha256: '2'.repeat(64),
    capability_sha256: '3'.repeat(64),
    capability_jti_sha256: '4'.repeat(64),
    test_run_id_sha256: '5'.repeat(64),
    cleanup_obligation_id_sha256: '6'.repeat(64),
    environment: 'production',
    frontend_build: FRONTEND,
    mcp_build: MCP,
    expected_deployment: { frontend: FRONTEND, backend: BACKEND, voice: VOICE },
    frontend_attempts: 1,
    frontend_reconciled: false,
    auth_audit_id: '17',
    audit_observed_at: '2026-08-24T10:00:00.000Z',
    operator_subject_sha256: sha256('system.principal-provision-operator'),
    ...coreOverrides,
  };
  return {
    ...core,
    idempotent_replay: idempotentReplay,
    receipt_sha256: sha256(stableJson(core)),
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Voice Lab principal provisioning operator', () => {
  it('loads only a one-purpose MCP bearer and exact deployment/idempotency bindings', () => {
    const config = loadPrincipalProvisionConfig(env());

    expect(config).toEqual({
      mcpOrigin: 'https://sophia-voice-lab-mcp.onrender.com',
      operatorBearer: BEARER,
      environment: 'production',
      idempotencyKey: IDEMPOTENCY_KEY,
      expectedDeployment: { frontend: FRONTEND, backend: BACKEND, voice: VOICE },
      expectedMcpSha: MCP,
    });
    expect(config).not.toHaveProperty('secret');
    expect(config).not.toHaveProperty('principalId');
  });

  it('calls only the authenticated MCP endpoint with no body and returns a hash-only receipt', async () => {
    const config = loadPrincipalProvisionConfig(env());
    const fetchImpl = vi.fn().mockResolvedValue(response(receipt()));

    const result = await provisionVoiceLabPrincipal(config, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://sophia-voice-lab-mcp.onrender.com/internal/voice-lab/auth/provision');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(fetchImpl.mock.calls[0]![1]?.body).toBeUndefined();
    expect(fetchImpl.mock.calls[0]![1]?.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${BEARER}`,
      'X-Sophia-Voice-Lab-Idempotency-Key': IDEMPOTENCY_KEY,
    });
    expect(result).toMatchObject({ ok: true, frontend_build: FRONTEND, mcp_build: MCP, operator_attempts: 1 });
    expect(JSON.stringify(result)).not.toContain(BEARER);
    expect(JSON.stringify(result)).not.toContain('voice-lab-user');
  });

  it('retries response loss with the exact same scoped bearer and idempotency key', async () => {
    const config = loadPrincipalProvisionConfig(env());
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(response(receipt({ idempotent_replay: true })));

    const result = await provisionVoiceLabPrincipal(config, { fetchImpl });

    expect(result.operator_attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![1]?.headers).toEqual(fetchImpl.mock.calls[1]![1]?.headers);
    expect(fetchImpl.mock.calls[0]![1]?.body).toBeUndefined();
    expect(fetchImpl.mock.calls[1]![1]?.body).toBeUndefined();
  });

  it.each([
    ['missing approval', { SOPHIA_VOICE_LAB_PRINCIPAL_PROVISION_APPROVED: 'NO' }, 'principal_provision_approval_required'],
    ['closed gate', { SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' }, 'principal_provisioning_gate_closed'],
    ['missing scoped bearer', { SOPHIA_VOICE_LAB_PROVISION_OPERATOR_BEARER_TOKEN: '' }, 'operator_configuration_missing'],
    ['non-HTTPS MCP', { SOPHIA_VOICE_LAB_TARGET_MCP_URL: 'http://voice-lab.test' }, 'mcp_target_invalid'],
    ['unstable idempotency key', { SOPHIA_VOICE_LAB_PRINCIPAL_PROVISION_IDEMPOTENCY_KEY: 'short' }, 'operator_binding_invalid'],
    ['deployment drift', { SOPHIA_VOICE_LAB_EXPECTED_MCP_SHA: 'main' }, 'expected_deployment_invalid'],
  ])('fails %s before network access', (_label, override, code) => {
    expect(() => loadPrincipalProvisionConfig(env(override))).toThrowError(
      expect.objectContaining<Partial<VoiceLabPrincipalProvisionError>>({ code }),
    );
  });

  it('rejects a foreign build/idempotency receipt even when its self-digest is valid', async () => {
    const config = loadPrincipalProvisionConfig(env());
    const fetchImpl = vi.fn(async () => response(receipt({
      idempotency_key_sha256: sha256('foreign-intent'),
      mcp_build: 'e'.repeat(40),
    })));

    await expect(provisionVoiceLabPrincipal(config, { fetchImpl })).rejects.toMatchObject({
      code: 'principal_provision_response_invalid',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a typed authorization rejection', async () => {
    const config = loadPrincipalProvisionConfig(env());
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: false, error: 'UNAUTHORIZED' }, 401));

    await expect(provisionVoiceLabPrincipal(config, { fetchImpl })).rejects.toMatchObject({
      code: 'principal_provision_http_401_UNAUTHORIZED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry the durable singleton conflict as a transient failure', async () => {
    const config = loadPrincipalProvisionConfig(env());
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: false, error: 'PRINCIPAL_PROVISION_CHAIN_CONFLICT' }, 409));

    await expect(provisionVoiceLabPrincipal(config, { fetchImpl })).rejects.toMatchObject({
      code: 'principal_provision_http_409_PRINCIPAL_PROVISION_CHAIN_CONFLICT',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
