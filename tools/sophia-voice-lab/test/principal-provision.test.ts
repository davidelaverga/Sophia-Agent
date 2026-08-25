import type { Server as HttpServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApp, createWebBootIdentity, listen, probeTestAuth } from '../src/http-server.js';
import { VoiceLabError, labError } from '../src/domain.js';
import type { VoiceLabLedger } from '../src/ledger.js';
import { MemoryVoiceLabLedger } from '../src/memory-ledger.js';
import { PRINCIPAL_PROVISION_PATH, provisionVoiceLabPrincipal } from '../src/principal-provision.js';
import { canonicalRequestHash, sha256 } from '../src/security.js';
import { VoiceLabService } from '../src/service.js';
import { SHA, SHA_B, SHA_C, SHA_D, testConfig, testWorkerHeartbeat } from './helpers.js';

const IDEMPOTENCY_KEY = 'vt00-principal-provision-candidate-001';
const MIGRATION_SHA = '9'.repeat(64);
const nativeFetch = globalThis.fetch;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function claimsFrom(init?: RequestInit): Record<string, unknown> {
  const headers = init?.headers as Record<string, string> | undefined;
  const token = headers?.['X-Sophia-Voice-Lab-Capability'];
  if (!token) throw new Error('missing capability');
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function frontendProvisionResult(config: ReturnType<typeof testConfig>, init?: RequestInit, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const headers = init?.headers as Record<string, string>;
  const token = headers['X-Sophia-Voice-Lab-Capability']!;
  const claims = claimsFrom(init);
  return {
    schema: 'sophia_voice_lab_principal_provision_result_v1',
    ok: true,
    provisioned: true,
    principal_id_sha256: sha256(config.principalId),
    capability_sha256: sha256(token),
    capability_jti_sha256: sha256(String(claims.jti)),
    test_run_id_sha256: sha256(String(claims.test_run_id)),
    cleanup_obligation_id_sha256: sha256(String(claims.cleanup_obligation_id)),
    environment: config.environment,
    frontend_build: config.readinessTarget!.expectedDeployment.frontend,
    expected_deployment: config.readinessTarget!.expectedDeployment,
    ...overrides,
  };
}

function targetConfig(overrides: Record<string, string | undefined> = {}) {
  return testConfig({
    SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: 'http://frontend.test',
    SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: 'http://gateway.test',
    SOPHIA_VOICE_LAB_TARGET_VOICE_URL: 'http://voice.test',
    SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: 'http://langgraph.test',
    SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA,
    SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B,
    SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C,
    SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    SOPHIA_VOICE_LAB_KILL_SWITCH: 'true',
    SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'true',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

async function start(config: ReturnType<typeof testConfig>, ledger = new MemoryVoiceLabLedger('test')): Promise<{ server: HttpServer; ledger: MemoryVoiceLabLedger; url: string }> {
  const service = new VoiceLabService(ledger, config, async () => []);
  const webBoot = createWebBootIdentity(config, 'principal-readiness-test-web-boot', 'principal-readiness-test-web-instance', new Date(0));
  const app = createHttpApp(config, service, ledger, { authenticate: vi.fn(async () => ({ subject: 'ordinary', scopes: new Set(['voice_lab:read']) })) }, undefined, undefined, webBoot);
  const server = await listen(app, 0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return { server, ledger, url: `http://127.0.0.1:${address.port}` };
}

describe('durable principal provisioning boundary', () => {
  const servers: HttpServer[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('mints internally, retries the same capability after response loss, audits before success, and durably replays', async () => {
    const config = targetConfig();
    const seenTokens: string[] = [];
    const frontendFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>)['X-Sophia-Voice-Lab-Capability']!;
      seenTokens.push(token);
      expect(init?.body).toBeUndefined();
      if (seenTokens.length === 1) throw new TypeError('response lost');
      return json(frontendProvisionResult(config, init));
    });
    vi.stubGlobal('fetch', frontendFetch);
    const harness = await start(config);
    servers.push(harness.server);
    const headers = {
      authorization: `Bearer ${config.provisionOperatorBearerToken}`,
      'X-Sophia-Voice-Lab-Idempotency-Key': IDEMPOTENCY_KEY,
    };

    const first = await nativeFetch(`${harness.url}${PRINCIPAL_PROVISION_PATH}`, { method: 'POST', headers });
    const receipt = await first.json() as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('pragma')).toBe('no-cache');
    expect(receipt).toMatchObject({
      schema: 'sophia_voice_lab_principal_provision_receipt_v1',
      ok: true,
      provisioned: true,
      idempotent_replay: false,
      idempotency_key_sha256: sha256(IDEMPOTENCY_KEY),
      environment: 'production',
      frontend_build: SHA,
      mcp_build: SHA,
      expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
      frontend_attempts: 2,
    });
    expect(seenTokens).toHaveLength(2);
    expect(seenTokens[0]).toBe(seenTokens[1]);
    const audits = await harness.ledger.listAuthAuditByArgumentHashes('system.principal-provision-operator', [String(receipt.operator_request_sha256)], new Date(0));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      runId: null,
      action: 'principal.provision',
      outcome: 'allowed',
      capabilityJtiHash: receipt.capability_jti_sha256,
      detail: receipt,
    });
    const serialized = JSON.stringify({ receipt, audits });
    expect(serialized).not.toContain(config.grantSecret);
    expect(serialized).not.toContain(config.provisionOperatorBearerToken!);
    expect(serialized).not.toContain(config.principalId);
    expect(serialized).not.toContain(seenTokens[0]!);

    const replayResponse = await nativeFetch(`${harness.url}${PRINCIPAL_PROVISION_PATH}`, { method: 'POST', headers });
    const replay = await replayResponse.json() as Record<string, unknown>;
    expect(replayResponse.status).toBe(200);
    expect(replay).toEqual({ ...receipt, idempotent_replay: true });
    expect(frontendFetch).toHaveBeenCalledTimes(2);

    const conflict = await nativeFetch(`${harness.url}${PRINCIPAL_PROVISION_PATH}`, {
      method: 'POST',
      headers: { ...headers, 'X-Sophia-Voice-Lab-Idempotency-Key': `${IDEMPOTENCY_KEY}-different` },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ ok: false, error: 'PRINCIPAL_PROVISION_CHAIN_CONFLICT' });
    expect(frontendFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects foreign credentials, bodies, an open kill switch, and a closed provisioning gate before frontend mutation', async () => {
    const frontendFetch = vi.fn();
    vi.stubGlobal('fetch', frontendFetch);

    for (const [overrides, request, status] of [
      [{}, { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong-wrong', 'X-Sophia-Voice-Lab-Idempotency-Key': IDEMPOTENCY_KEY }, 401],
      [{}, { authorization: '', 'X-Sophia-Voice-Lab-Idempotency-Key': IDEMPOTENCY_KEY, body: '{}' }, 400],
      [{ SOPHIA_VOICE_LAB_KILL_SWITCH: 'false' }, { authorization: '', 'X-Sophia-Voice-Lab-Idempotency-Key': IDEMPOTENCY_KEY }, 409],
      [{ SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' }, { authorization: '', 'X-Sophia-Voice-LAB-Idempotency-Key': IDEMPOTENCY_KEY }, 404],
    ] as const) {
      const config = targetConfig(overrides);
      const harness = await start(config);
      servers.push(harness.server);
      const headers: Record<string, string> = { ...request };
      const body = headers.body;
      delete headers.body;
      if (headers.authorization === '') headers.authorization = `Bearer ${config.provisionOperatorBearerToken}`;
      const response = await nativeFetch(`${harness.url}${PRINCIPAL_PROVISION_PATH}`, {
        method: 'POST',
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        ...(body ? { body } : {}),
      });
      expect(response.status).toBe(status);
    }
    expect(frontendFetch).not.toHaveBeenCalled();
  });

  it('fails closed and records a denial when the frontend receipt has a foreign build', async () => {
    const config = targetConfig();
    const frontendFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => json(frontendProvisionResult(config, init, { frontend_build: 'f'.repeat(40) })));
    vi.stubGlobal('fetch', frontendFetch);
    const harness = await start(config);
    servers.push(harness.server);
    const response = await nativeFetch(`${harness.url}${PRINCIPAL_PROVISION_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.provisionOperatorBearerToken}`, 'X-Sophia-Voice-Lab-Idempotency-Key': IDEMPOTENCY_KEY },
    });

    expect(response.status).toBe(503);
    expect(frontendFetch).toHaveBeenCalledTimes(2);
    const audits = await harness.ledger.listAuthAudit(null as unknown as string);
    expect(audits.some((audit) => audit.action === 'principal.provision' && audit.outcome === 'allowed')).toBe(false);
    expect(audits).toContainEqual(expect.objectContaining({ action: 'principal.provision', outcome: 'denied', detail: expect.objectContaining({ error_class: 'PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID' }) }));
  });

  it('serializes concurrent same-key calls into one frontend mutation and one audit receipt', async () => {
    const config = targetConfig();
    const ledger = new MemoryVoiceLabLedger('test');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const frontendFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      started();
      await blocked;
      return json(frontendProvisionResult(config, init));
    });
    const first = provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch });
    await entered;
    const second = provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch });
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(frontendFetch).toHaveBeenCalledTimes(1);
    expect(left.receipt_sha256).toBe(right.receipt_sha256);
    expect([left.idempotent_replay, right.idempotent_replay].sort()).toEqual([false, true]);
    expect(await ledger.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'completed' });
    const audits = await ledger.listAuthAuditByArgumentHashes('system.principal-provision-operator', [left.operator_request_sha256], new Date(0));
    expect(audits.filter((audit) => audit.outcome === 'allowed')).toHaveLength(1);
  });

  it('rejects every different request or principal after the global singleton is prepared', async () => {
    const config = targetConfig();
    const ledger = new MemoryVoiceLabLedger('test');
    const frontendFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => json(frontendProvisionResult(config, init)));
    await provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch });

    await expect(provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', `${IDEMPOTENCY_KEY}-different`, { fetchImpl: frontendFetch }))
      .rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_CHAIN_CONFLICT', category: 'conflict' } });
    const foreignPrincipal = targetConfig({ SOPHIA_VOICE_LAB_PRINCIPAL_ID: 'voice-lab-user-drifted' });
    await expect(provisionVoiceLabPrincipal(foreignPrincipal, ledger, 'system.principal-provision-operator', `${IDEMPOTENCY_KEY}-foreign`, { fetchImpl: frontendFetch }))
      .rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_CHAIN_CONFLICT', category: 'conflict' } });
    expect(frontendFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps prepare incomplete on finalize/audit failure and retries the byte-identical capability', async () => {
    const config = targetConfig();
    const durable = new MemoryVoiceLabLedger('test');
    let failFinalize = true;
    const ledger = new Proxy(durable, {
      get(target, property) {
        if (property === 'finalizePrincipalProvision') return async (...args: Parameters<VoiceLabLedger['finalizePrincipalProvision']>) => {
          if (failFinalize) {
            failFinalize = false;
            throw new VoiceLabError(labError('TEST_AUDIT_INSERT_FAILED', 'simulated transactional audit failure', 'internal'));
          }
          return target.finalizePrincipalProvision(...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as VoiceLabLedger;
    const tokens: string[] = [];
    const frontendFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      tokens.push((init?.headers as Record<string, string>)['X-Sophia-Voice-Lab-Capability']!);
      return json(frontendProvisionResult(config, init));
    });

    await expect(provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch })).rejects.toMatchObject({ detail: { code: 'TEST_AUDIT_INSERT_FAILED' } });
    expect(await durable.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'prepared' });
    expect((await durable.listAuthAuditByArgumentHashes('system.principal-provision-operator', [], new Date(0)))).toHaveLength(0);
    const receipt = await provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch });

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(receipt.idempotent_replay).toBe(false);
    expect(await durable.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'completed' });
  });

  it('reconciles a frontend commit after the pinned capability TTL without a second provision POST', async () => {
    const config = targetConfig({ SOPHIA_VOICE_LAB_CAPABILITY_TTL_SECONDS: '30' });
    const durable = new MemoryVoiceLabLedger('test');
    let failFinalize = true;
    const ledger = new Proxy(durable, {
      get(target, property) {
        if (property === 'finalizePrincipalProvision') return async (...args: Parameters<VoiceLabLedger['finalizePrincipalProvision']>) => {
          if (failFinalize) { failFinalize = false; throw new VoiceLabError(labError('TEST_PROCESS_CRASH', 'simulated crash', 'internal')); }
          return target.finalizePrincipalProvision(...args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as VoiceLabLedger;
    const provisionTokens: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const claims = claimsFrom(init);
      if ((claims.allowed_ops as string[]).includes('auth:readiness')) return json(readinessPayload(config, init, true));
      provisionTokens.push((init?.headers as Record<string, string>)['X-Sophia-Voice-Lab-Capability']!);
      return json(frontendProvisionResult(config, init));
    });
    const started = new Date('2026-08-24T10:00:00.000Z');
    await expect(provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl, now: started })).rejects.toMatchObject({ detail: { code: 'TEST_PROCESS_CRASH' } });

    const receipt = await provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl, now: new Date(started.getTime() + 31_000) });

    expect(provisionTokens).toHaveLength(1);
    expect(receipt).toMatchObject({ frontend_reconciled: true, frontend_attempts: 0, capability_sha256: sha256(provisionTokens[0]!) });
    expect(await durable.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'completed' });
  });

  it('lease-fences capability rotation after TTL only when readiness proves clean absence', async () => {
    const config = targetConfig({ SOPHIA_VOICE_LAB_CAPABILITY_TTL_SECONDS: '30' });
    const ledger = new MemoryVoiceLabLedger('test');
    const started = new Date('2026-08-24T10:00:00.000Z');
    const oldTokens: string[] = [];
    const failedFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      oldTokens.push((init?.headers as Record<string, string>)['X-Sophia-Voice-Lab-Capability']!);
      throw new TypeError('frontend unavailable before mutation');
    });
    await expect(provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: failedFetch, now: started }))
      .rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_FRONTEND_UNAVAILABLE' } });
    expect(oldTokens).toHaveLength(2);
    expect(oldTokens[0]).toBe(oldTokens[1]);

    const newTokens: string[] = [];
    const recoveryFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const claims = claimsFrom(init);
      if ((claims.allowed_ops as string[]).includes('auth:readiness')) return json(readinessPayload(config, init, false));
      newTokens.push((init?.headers as Record<string, string>)['X-Sophia-Voice-Lab-Capability']!);
      return json(frontendProvisionResult(config, init));
    });
    const receipt = await provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, {
      fetchImpl: recoveryFetch,
      now: new Date(started.getTime() + 31_000),
    });

    expect(newTokens).toHaveLength(1);
    expect(newTokens[0]).not.toBe(oldTokens[0]);
    expect(receipt).toMatchObject({ capability_sha256: sha256(newTokens[0]!), frontend_reconciled: false, frontend_attempts: 1 });
  });

  it('replays a completed safe receipt after grant-secret rotation without reminting', async () => {
    const config = targetConfig();
    const ledger = new MemoryVoiceLabLedger('test');
    const frontendFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => json(frontendProvisionResult(config, init)));
    const first = await provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch });
    const rotated = targetConfig({ SOPHIA_VOICE_LAB_GRANT_SECRET: 'rotated-grant-secret-000000000000000001' });

    const replay = await provisionVoiceLabPrincipal(rotated, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch });

    expect(replay).toEqual({ ...first, idempotent_replay: true });
    expect(frontendFetch).toHaveBeenCalledTimes(1);
  });

  it('validates same-origin paths before reserving the permanent singleton', async () => {
    const ledger = new MemoryVoiceLabLedger('test');
    const invalid = targetConfig({ SOPHIA_VOICE_LAB_AUTH_PROVISION_PATH: 'https://attacker.invalid/collect' });
    const frontendFetch = vi.fn();
    await expect(provisionVoiceLabPrincipal(invalid, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch }))
      .rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_TARGET_UNAVAILABLE' } });
    expect(await ledger.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'absent' });

    const corrected = targetConfig();
    frontendFetch.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => json(frontendProvisionResult(corrected, init)));
    await expect(provisionVoiceLabPrincipal(corrected, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch })).resolves.toMatchObject({ ok: true });
  });

  it('validates the exact frontend principal and issuer grammar before reserving the singleton', async () => {
    for (const invalid of [
      targetConfig({ SOPHIA_VOICE_LAB_PRINCIPAL_ID: 'voice lab user' }),
      targetConfig({ SOPHIA_VOICE_LAB_CAPABILITY_ISSUER: 'foreign-issuer' }),
    ]) {
      const ledger = new MemoryVoiceLabLedger('test');
      const frontendFetch = vi.fn();
      await expect(provisionVoiceLabPrincipal(invalid, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch }))
        .rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_BINDING_INVALID' } });
      expect(await ledger.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'absent' });
      expect(frontendFetch).not.toHaveBeenCalled();
      const corrected = targetConfig();
      frontendFetch.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => json(frontendProvisionResult(corrected, init)));
      await expect(provisionVoiceLabPrincipal(corrected, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch })).resolves.toMatchObject({ ok: true });
    }
  });

  it('rejects active lab runs before durable claim or frontend mutation', async () => {
    const config = targetConfig();
    const ledger = new MemoryVoiceLabLedger('test');
    vi.spyOn(ledger, 'countActiveRuns').mockResolvedValue(1);
    const frontendFetch = vi.fn();

    await expect(provisionVoiceLabPrincipal(config, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, { fetchImpl: frontendFetch }))
      .rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_ACTIVE_RUN_CONFLICT', category: 'conflict' } });
    expect(await ledger.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'absent' });
    expect(frontendFetch).not.toHaveBeenCalled();
  });
});

function readinessPayload(config: ReturnType<typeof testConfig>, init?: RequestInit, provisioned = false, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const claims = claimsFrom(init);
  return {
    schema: 'sophia_voice_lab_auth_readiness_v1',
    ok: true,
    ready: provisioned,
    provisioned,
    principal_record_present: provisioned,
    principal_record_provisioned: provisioned,
    provider_account_provisioned: provisioned,
    provider_account_count: provisioned ? 1 : 0,
    active_session_count: 0,
    voice_lab_enabled: !config.killSwitch,
    kill_switch_engaged: config.killSwitch,
    provisioning_enabled: config.provisioningEnabled,
    auth_ledger_ready: true,
    auth_ledger_migration_sha256: MIGRATION_SHA,
    frontend_build: SHA,
    test_run_id: claims.test_run_id,
    cleanup_obligation_id: claims.cleanup_obligation_id,
    environment: 'production',
    expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
    deployment_identity: { frontend: SHA },
    capability_jti_sha256: sha256(String(claims.jti)),
    principal_id_sha256: sha256(config.principalId),
    ...overrides,
  };
}

function readinessFetch(
  config: ReturnType<typeof testConfig>,
  mode: 'unprovisioned' | 'provisioned' | 'foreign' | 'malformed',
  overrides: Record<string, unknown> = {},
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.pathname === '/api/app-version') return json({ build_id: SHA });
    if (url.pathname === '/version' && url.origin === 'http://gateway.test') return json({ commit_sha: SHA_B });
    if (url.pathname === '/version' && url.origin === 'http://voice.test') return json({ commit_sha: SHA_C });
    if (url.pathname === '/version' && url.origin === 'http://langgraph.test') return json({ commit_sha: SHA_D });
    if (url.pathname === '/ok' && url.origin === 'http://langgraph.test') return json({ ok: true });
    if (url.pathname === '/ready') {
      const productMutationGatesOpen = !config.killSwitch;
      return json(url.origin === 'http://gateway.test' ? {
        ok: true,
        voice_lab_enabled: productMutationGatesOpen,
        voice_lab_kill_switch_engaged: !productMutationGatesOpen,
        voice_lab_protected_plane_ready: true,
        voice_lab_admission_ready: true,
        voice_lab_mutation_ready: productMutationGatesOpen,
      } : {
        ok: true,
        voice_lab_enabled: productMutationGatesOpen,
        voice_lab_kill_switch_engaged: !productMutationGatesOpen,
        voice_lab_mutation_ready: productMutationGatesOpen,
      });
    }
    if (url.pathname === '/api/voice-lab/auth/readiness') {
      if (mode === 'malformed') return json({ ok: true, ready: false });
      return json(readinessPayload(config, init, mode === 'provisioned', {
        ...(mode === 'foreign' ? { frontend_build: 'f'.repeat(40) } : {}),
        ...overrides,
      }));
    }
    throw new Error(`unexpected target ${url}`);
  });
}

describe('principal bootstrap readiness', () => {
  it('recognizes only the exact signed unprovisioned readiness shape', async () => {
    for (const [mode, status] of [
      ['unprovisioned', 'provisioning_required'],
      ['provisioned', 'verified'],
      ['foreign', 'unverified'],
      ['malformed', 'unverified'],
    ] as const) {
      const config = mode === 'provisioned' || mode === 'foreign'
        ? targetConfig({ SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' })
        : targetConfig();
      vi.stubGlobal('fetch', readinessFetch(config, mode));
      await expect(probeTestAuth(config)).resolves.toMatchObject({ status, ok: mode === 'provisioned' });
      vi.unstubAllGlobals();
    }
  });

  it('keeps the signed cross-region readiness probe bounded at fifteen seconds', async () => {
    const config = targetConfig({ SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', readinessFetch(config, 'provisioned'));

    await expect(probeTestAuth(config)).resolves.toMatchObject({ ok: true, status: 'verified' });
    expect(timeout).toHaveBeenCalledWith(15_000);
    vi.unstubAllGlobals();
  });

  it.each([
    ['closed bootstrap while disabled', true, true, 'unprovisioned', false, 'provisioning_required', false],
    ['closed provisioned while disabled', true, false, 'provisioned', false, 'verified', false],
    ['closed provisioned while enabled', true, false, 'provisioned', true, 'verified', true],
    ['open provisioned while enabled', false, false, 'provisioned', true, 'verified', true],
    ['open provisioned while disabled', false, false, 'provisioned', false, 'unverified', null],
  ] as const)('enforces frontend enablement for %s', async (_label, mcpWebEngaged, provisioningEnabled, mode, frontendEnabled, status, observedEnabled) => {
    const config = targetConfig({
      SOPHIA_VOICE_LAB_KILL_SWITCH: String(mcpWebEngaged),
      SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: String(provisioningEnabled),
    });
    vi.stubGlobal('fetch', readinessFetch(config, mode, { voice_lab_enabled: frontendEnabled }));

    await expect(probeTestAuth(config)).resolves.toMatchObject({
      ok: status === 'verified',
      status,
      frontend_voice_lab_enabled: observedEnabled,
    });
    vi.unstubAllGlobals();
  });

  it('does not send a signed readiness capability to an absolute or foreign path', async () => {
    const config = targetConfig({ SOPHIA_VOICE_LAB_AUTH_READINESS_PATH: 'https://attacker.invalid/collect' });
    const targetFetch = vi.fn();
    vi.stubGlobal('fetch', targetFetch);

    await expect(probeTestAuth(config)).resolves.toMatchObject({ ok: false, status: 'unavailable' });
    expect(targetFetch).not.toHaveBeenCalled();
  });

  it('does not classify a partial principal record as clean bootstrap absence', async () => {
    const config = targetConfig();
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => json(readinessPayload(config, init, false, {
      principal_record_present: true,
      principal_record_provisioned: true,
    }))));
    await expect(probeTestAuth(config)).resolves.toMatchObject({ ok: false, status: 'unverified' });
  });

  it('requires zero active lab runs for the bounded provisioning-required health state', async () => {
    const config = targetConfig();
    const ledger = new MemoryVoiceLabLedger('test');
    await ledger.heartbeatWorker(testWorkerHeartbeat(config));
    vi.spyOn(ledger, 'countActiveRuns').mockResolvedValue(1);
    vi.stubGlobal('fetch', readinessFetch(config, 'unprovisioned'));
    const harness = await start(config, ledger);
    const response = await nativeFetch(`${harness.url}/readyz`);
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: 'not_ready', active_runs: 1, mutation_ready: false });
  });

  it.each([
    ['frontend gate open', true, false, 'unverified'],
    ['MCP web gate open', false, true, 'provisioning_required'],
  ] as const)('requires bootstrap true/true when the %s', async (_label, mcpWebEngaged, frontendEngaged, authStatus) => {
    const config = targetConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: String(mcpWebEngaged) });
    const ledger = new MemoryVoiceLabLedger('test');
    await ledger.heartbeatWorker(testWorkerHeartbeat(config));
    vi.stubGlobal('fetch', readinessFetch(config, 'unprovisioned', { kill_switch_engaged: frontendEngaged }));
    const harness = await start(config, ledger);
    const response = await nativeFetch(`${harness.url}/readyz`);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      status: 'not_ready',
      mutation_ready: false,
      components: {
        test_auth: {
          status: authStatus,
          frontend_kill_switch_engaged: frontendEngaged ? true : null,
          mcp_web_kill_switch_engaged: mcpWebEngaged,
          mutation_gate_order_safe: false,
        },
      },
    });
    vi.unstubAllGlobals();
  });

  it.each([
    ['exact bootstrap', {}, 'unprovisioned', 200, 'provisioning_required'],
    ['kill switch open', { SOPHIA_VOICE_LAB_KILL_SWITCH: 'false' }, 'unprovisioned', 503, 'not_ready'],
    ['provisioning disabled', { SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' }, 'unprovisioned', 503, 'not_ready'],
    ['foreign deployment', {}, 'foreign', 503, 'not_ready'],
    ['malformed response', {}, 'malformed', 503, 'not_ready'],
    ['provisioned but gate still open', {}, 'provisioned', 503, 'not_ready'],
    ['frontend committed without local audit', { SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' }, 'provisioned', 503, 'not_ready'],
    ['normal ready under kill switch after gate closes', { SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' }, 'provisioned', 200, 'ready'],
    ['campaign-open ready after both gates close', { SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false', SOPHIA_VOICE_LAB_KILL_SWITCH: 'false' }, 'provisioned', 200, 'ready'],
  ] as const)('%s returns only the allowed health state', async (_label, overrides, mode, httpStatus, status) => {
    const config = targetConfig(overrides);
    const ledger = new MemoryVoiceLabLedger('test');
    await ledger.heartbeatWorker(testWorkerHeartbeat(config));
    if (status === 'ready') {
      const provisionConfig = targetConfig();
      await provisionVoiceLabPrincipal(provisionConfig, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, {
        fetchImpl: async (_input, init) => json(frontendProvisionResult(provisionConfig, init)),
      });
    }
    vi.stubGlobal('fetch', readinessFetch(config, mode));
    const harness = await start(config, ledger);
    const response = await nativeFetch(`${harness.url}/readyz`);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));

    expect(response.status).toBe(httpStatus);
    expect(payload.status).toBe(status);
    if (status === 'provisioning_required') {
      expect(payload).toMatchObject({ execution: 'kill_switch_engaged', mutation_ready: false });
    }
    if (_label === 'normal ready under kill switch after gate closes') {
      expect(payload).toMatchObject({ execution: 'kill_switch_engaged', mutation_ready: false });
    }
    if (_label === 'campaign-open ready after both gates close') {
      expect(payload).toMatchObject({ execution: 'enabled', mutation_ready: true });
    }
    vi.unstubAllGlobals();
  });

  it.each([
    ['same-state engaged', true, true, 200, 'ready', false, true],
    ['ordered opening transition', true, false, 200, 'ready', false, true],
    ['ordered closing transition', true, false, 200, 'ready', false, true],
    ['same-state open', false, false, 200, 'ready', true, true],
    ['inverse-order drift', false, true, 503, 'not_ready', false, false],
  ] as const)('reports independently validated gates for %s', async (_label, mcpWebEngaged, frontendEngaged, httpStatus, status, mutationReady, gateOrderSafe) => {
    const config = targetConfig({
      SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false',
      SOPHIA_VOICE_LAB_KILL_SWITCH: String(mcpWebEngaged),
    });
    const ledger = new MemoryVoiceLabLedger('test');
    await ledger.heartbeatWorker(testWorkerHeartbeat(config));
    const provisionConfig = targetConfig();
    await provisionVoiceLabPrincipal(provisionConfig, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, {
      fetchImpl: async (_input, init) => json(frontendProvisionResult(provisionConfig, init)),
    });
    vi.stubGlobal('fetch', readinessFetch(config, 'provisioned', { kill_switch_engaged: frontendEngaged }));
    const harness = await start(config, ledger);
    const response = await nativeFetch(`${harness.url}/readyz`);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));

    expect(response.status).toBe(httpStatus);
    expect(payload).toMatchObject({
      status,
      execution: mcpWebEngaged ? 'kill_switch_engaged' : 'enabled',
      mutation_ready: mutationReady,
      components: {
        test_auth: {
          ok: true,
          status: 'verified',
          frontend_kill_switch_engaged: frontendEngaged,
          mcp_web_kill_switch_engaged: mcpWebEngaged,
          mutation_gate_order_safe: gateOrderSafe,
        },
      },
    });
    vi.unstubAllGlobals();
  });

  it.each([
    ['non-boolean frontend enablement', { voice_lab_enabled: 'true' }],
    ['missing frontend enablement', { voice_lab_enabled: undefined }],
    ['non-boolean frontend gate', { kill_switch_engaged: 'false' }],
    ['reopened provisioning gate', { provisioning_enabled: true }],
    ['active frontend session', { active_session_count: 1 }],
    ['unexpected response field', { unexpected: 'hostile' }],
  ])('does not certify normal readiness with %s', async (_label, remotePatch) => {
    const config = targetConfig({ SOPHIA_VOICE_LAB_PROVISIONING_ENABLED: 'false' });
    const ledger = new MemoryVoiceLabLedger('test');
    await ledger.heartbeatWorker(testWorkerHeartbeat(config));
    const provisionConfig = targetConfig();
    await provisionVoiceLabPrincipal(provisionConfig, ledger, 'system.principal-provision-operator', IDEMPOTENCY_KEY, {
      fetchImpl: async (_input, init) => json(frontendProvisionResult(provisionConfig, init)),
    });
    vi.stubGlobal('fetch', readinessFetch(config, 'provisioned', remotePatch));
    const harness = await start(config, ledger);
    const response = await nativeFetch(`${harness.url}/readyz`);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      status: 'not_ready',
      mutation_ready: false,
      components: {
        test_auth: {
          ok: false,
          status: 'unverified',
          frontend_kill_switch_engaged: null,
          mcp_web_kill_switch_engaged: true,
          mutation_gate_order_safe: false,
        },
      },
    });
  });
});
