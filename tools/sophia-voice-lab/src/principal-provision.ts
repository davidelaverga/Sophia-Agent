import { randomBytes, randomUUID } from 'node:crypto';

import type { VoiceLabConfig } from './config.js';
import { VoiceLabError, labError, type DeploymentIdentity, type LabError } from './domain.js';
import type { PrincipalProvisionControlRecord, PrincipalProvisionPreparation, VoiceLabLedger } from './ledger.js';
import {
  parseExactPrincipalProvisionReceipt,
  PRINCIPAL_PROVISION_RECEIPT_SCHEMA,
  type PrincipalProvisionReceipt,
  type PrincipalProvisionReceiptCore,
} from './principal-provision-receipt.js';
import { CapabilityCodec, canonicalRequestHash, resolveAllowedOriginPath, sha256 } from './security.js';

export { PRINCIPAL_PROVISION_RECEIPT_SCHEMA } from './principal-provision-receipt.js';
export type { PrincipalProvisionReceipt } from './principal-provision-receipt.js';

export const PRINCIPAL_PROVISION_PATH = '/internal/voice-lab/auth/provision';
export const PRINCIPAL_PROVISION_IDEMPOTENCY_HEADER = 'x-sophia-voice-lab-idempotency-key';
const FRONTEND_RESULT_SCHEMA = 'sophia_voice_lab_principal_provision_result_v1';
const PRINCIPAL_PROVISION_ACTION = 'principal.provision';
const FRONTEND_RESPONSE_LIMIT_BYTES = 4_096;
const FRONTEND_TIMEOUT_MS = 10_000;
const CLAIM_LEASE_SECONDS = 30;
const CLAIM_WAIT_MS = 35_000;
const CLAIM_POLL_MS = 25;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const FRONTEND_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface FrontendProvisionResult {
  schema: typeof FRONTEND_RESULT_SCHEMA;
  ok: true;
  provisioned: true;
  principal_id_sha256: string;
  capability_sha256: string;
  capability_jti_sha256: string;
  test_run_id_sha256: string;
  cleanup_obligation_id_sha256: string;
  environment: string;
  frontend_build: string;
  expected_deployment: DeploymentIdentity;
}

const FRONTEND_RESULT_KEYS = new Set([
  'schema', 'ok', 'provisioned', 'principal_id_sha256', 'capability_sha256',
  'capability_jti_sha256', 'test_run_id_sha256', 'cleanup_obligation_id_sha256',
  'environment', 'frontend_build', 'expected_deployment',
]);
function error(code: string, message: string, category: LabError['category'] = 'internal'): VoiceLabError {
  return new VoiceLabError(labError(code, message, category));
}

function exactDeployment(value: unknown, expected: DeploymentIdentity): value is DeploymentIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const deployment = value as Partial<DeploymentIdentity>;
  return Object.keys(deployment).sort().join(',') === 'backend,frontend,voice'
    && SHA40.test(deployment.frontend || '')
    && SHA40.test(deployment.backend || '')
    && SHA40.test(deployment.voice || '')
    && deployment.frontend === expected.frontend
    && deployment.backend === expected.backend
    && deployment.voice === expected.voice;
}

function parseStoredReceipt(
  record: PrincipalProvisionControlRecord,
  expected: {
    argumentHash: string;
    idempotencyKeySha256: string;
    principalIdSha256: string;
    callerId: string;
    config: VoiceLabConfig;
  },
): PrincipalProvisionReceipt | null {
  const candidate = parseExactPrincipalProvisionReceipt(record, record.receipt);
  if (
    record.state !== 'completed'
    || !candidate
  ) return null;
  if (
    record.requestHash !== expected.argumentHash
    || record.idempotencyKeyHash !== expected.idempotencyKeySha256
    || record.principalHash !== expected.principalIdSha256
    || record.environment !== expected.config.environment
    || record.mcpBuild !== expected.config.serviceVersion
    || record.operatorSubjectHash !== sha256(expected.callerId)
    || !exactDeployment(record.expectedDeployment, expected.config.readinessTarget!.expectedDeployment)
  ) return null;
  return { ...candidate, idempotent_replay: true };
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const declared = Number(response.headers.get('content-length') || 0);
  if (contentType !== 'application/json' || (Number.isFinite(declared) && declared > FRONTEND_RESPONSE_LIMIT_BYTES)) {
    throw error('PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID', 'The frontend provisioning response was not a bounded JSON document.');
  }
  if (!response.body) throw error('PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID', 'The frontend provisioning response body was absent.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > FRONTEND_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw error('PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID', 'The frontend provisioning response exceeded its byte limit.');
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    throw error('PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID', 'The frontend provisioning response was malformed.');
  }
}

function parseFrontendResult(
  value: unknown,
  expected: {
    principalIdSha256: string;
    capabilitySha256: string;
    capabilityJtiSha256: string;
    testRunIdSha256: string;
    cleanupObligationIdSha256: string;
    environment: string;
    deployment: DeploymentIdentity;
  },
): FrontendProvisionResult {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some((key) => !FRONTEND_RESULT_KEYS.has(key))
    || Object.keys(value).length !== FRONTEND_RESULT_KEYS.size
  ) throw error('PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID', 'The frontend provisioning response contract was invalid.');
  const result = value as unknown as FrontendProvisionResult;
  if (
    result.schema !== FRONTEND_RESULT_SCHEMA
    || result.ok !== true
    || result.provisioned !== true
    || result.principal_id_sha256 !== expected.principalIdSha256
    || result.capability_sha256 !== expected.capabilitySha256
    || result.capability_jti_sha256 !== expected.capabilityJtiSha256
    || result.test_run_id_sha256 !== expected.testRunIdSha256
    || result.cleanup_obligation_id_sha256 !== expected.cleanupObligationIdSha256
    || result.environment !== expected.environment
    || result.frontend_build !== expected.deployment.frontend
    || !exactDeployment(result.expected_deployment, expected.deployment)
  ) throw error('PRINCIPAL_PROVISION_FRONTEND_RESPONSE_INVALID', 'The frontend provisioning response binding was invalid.');
  return result;
}

async function callFrontend(
  config: VoiceLabConfig,
  capability: { token: string; tokenHash: string; claims: { jti: string; test_run_id: string; cleanup_obligation_id: string } },
  fetchImpl: typeof fetch,
): Promise<{ result: FrontendProvisionResult; attempts: number }> {
  const target = config.readinessTarget;
  if (!target) throw error('PRINCIPAL_PROVISION_TARGET_UNAVAILABLE', 'The exact provisioning target is not configured.');
  let endpoint: URL;
  try {
    endpoint = resolveAllowedOriginPath(target.frontendUrl, config.authProvisionPath, config.allowedOrigins);
  } catch {
    throw error('PRINCIPAL_PROVISION_TARGET_UNAVAILABLE', 'The frontend provisioning target is not an exact same-origin path.');
  }
  const expected = {
    principalIdSha256: sha256(config.principalId),
    capabilitySha256: capability.tokenHash,
    capabilityJtiSha256: sha256(capability.claims.jti),
    testRunIdSha256: sha256(capability.claims.test_run_id),
    cleanupObligationIdSha256: sha256(capability.claims.cleanup_obligation_id),
    environment: config.environment,
    deployment: target.expectedDeployment,
  };
  let lastError: VoiceLabError | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(FRONTEND_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          'X-Sophia-Voice-Lab-Capability': capability.token,
        },
      });
      const payload = await boundedJson(response);
      if (!response.ok) {
        const rejection = error('PRINCIPAL_PROVISION_FRONTEND_REJECTED', 'The frontend rejected the provisioning request.', response.status === 401 || response.status === 403 ? 'authorization' : 'internal');
        if (response.status >= 500 && attempt === 1) {
          lastError = rejection;
          continue;
        }
        throw rejection;
      }
      return { result: parseFrontendResult(payload, expected), attempts: attempt };
    } catch (caught) {
      const failure = caught instanceof VoiceLabError
        ? caught
        : error('PRINCIPAL_PROVISION_FRONTEND_UNAVAILABLE', 'The frontend provisioning result was unavailable.');
      if (failure.detail.code === 'PRINCIPAL_PROVISION_FRONTEND_REJECTED') throw failure;
      lastError = failure;
      if (attempt === 1) continue;
    }
  }
  throw lastError ?? error('PRINCIPAL_PROVISION_FRONTEND_UNAVAILABLE', 'The frontend provisioning result was unavailable.');
}

type StoredCapabilityInputs = Pick<PrincipalProvisionControlRecord,
  'testRunId' | 'cleanupObligationId' | 'environment' | 'providerExpiresAt' | 'expectedDeployment' | 'issuedAt' | 'capabilityJti' | 'capabilityNonce'>;

function mintPreparedCapability(config: VoiceLabConfig, record: StoredCapabilityInputs) {
  return new CapabilityCodec(config.grantSecret, config.capabilityIssuer, config.capabilityTtlSeconds).mint({
    aud: 'sophia-voice-lab-frontend',
    sub: config.principalId,
    principal_id: config.principalId,
    test_run_id: record.testRunId,
    cleanup_obligation_id: record.cleanupObligationId,
    synthetic: true,
    environment: record.environment,
    retention_hours: 24,
    provider_expires_at: record.providerExpiresAt.toISOString(),
    allowed_ops: ['auth:provision'],
    expected_deployment: record.expectedDeployment,
  }, record.issuedAt, { jti: record.capabilityJti, nonce: record.capabilityNonce });
}

const READINESS_KEYS = new Set([
  'schema', 'ok', 'ready', 'provisioned', 'principal_record_present', 'principal_record_provisioned',
  'provider_account_provisioned', 'provider_account_count', 'active_session_count', 'auth_ledger_ready',
  'voice_lab_enabled', 'kill_switch_engaged', 'provisioning_enabled', 'control_adapter_enabled',
  'auth_ledger_migration_sha256', 'frontend_build', 'test_run_id', 'cleanup_obligation_id', 'environment',
  'expected_deployment', 'deployment_identity', 'capability_jti_sha256', 'principal_id_sha256',
]);

async function reconcileExpiredCapability(
  config: VoiceLabConfig,
  record: PrincipalProvisionControlRecord,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<{ state: 'provisioned' | 'unprovisioned'; frontendBuild: string }> {
  const target = config.readinessTarget!;
  let endpoint: URL;
  try {
    endpoint = resolveAllowedOriginPath(target.frontendUrl, config.authReadinessPath, config.allowedOrigins);
  } catch {
    throw error('PRINCIPAL_PROVISION_TARGET_UNAVAILABLE', 'The frontend readiness target is not an exact same-origin path.');
  }
  const readiness = new CapabilityCodec(config.grantSecret, config.capabilityIssuer, config.capabilityTtlSeconds).mint({
    aud: 'sophia-voice-lab-frontend',
    sub: config.principalId,
    principal_id: config.principalId,
    test_run_id: record.testRunId,
    cleanup_obligation_id: record.cleanupObligationId,
    synthetic: true,
    environment: config.environment,
    retention_hours: 24,
    provider_expires_at: new Date(now.getTime() + 10 * 60 * 1_000).toISOString(),
    allowed_ops: ['auth:readiness'],
    expected_deployment: target.expectedDeployment,
  }, now);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(FRONTEND_TIMEOUT_MS),
      headers: { accept: 'application/json', 'X-Sophia-Voice-Lab-Capability': readiness.token },
    });
  } catch {
    throw error('PRINCIPAL_PROVISION_RECONCILIATION_UNAVAILABLE', 'The expired provision capability could not be reconciled.');
  }
  const payload = await boundedJson(response);
  if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== READINESS_KEYS.size || Object.keys(payload).some((key) => !READINESS_KEYS.has(key))) {
    throw error('PRINCIPAL_PROVISION_RECONCILIATION_INVALID', 'The expired provision capability received no exact readiness state.');
  }
  const value = payload as Record<string, unknown>;
  const deployment = value.expected_deployment;
  const identity = value.deployment_identity;
  const common = value.schema === 'sophia_voice_lab_auth_readiness_v1' && value.ok === true
    && value.auth_ledger_ready === true && typeof value.auth_ledger_migration_sha256 === 'string' && SHA256.test(value.auth_ledger_migration_sha256)
    && value.frontend_build === target.expectedDeployment.frontend
    && value.test_run_id === record.testRunId && value.cleanup_obligation_id === record.cleanupObligationId
    && value.environment === config.environment && value.principal_id_sha256 === sha256(config.principalId)
    && value.capability_jti_sha256 === sha256(readiness.claims.jti)
    && exactDeployment(deployment, target.expectedDeployment)
    && identity && typeof identity === 'object' && !Array.isArray(identity)
    && Object.keys(identity).length === 1 && (identity as Record<string, unknown>).frontend === target.expectedDeployment.frontend
    && typeof value.principal_record_present === 'boolean' && typeof value.principal_record_provisioned === 'boolean'
    && typeof value.voice_lab_enabled === 'boolean'
    && value.kill_switch_engaged === true && value.provisioning_enabled === true
    && value.control_adapter_enabled === false
    && Number.isInteger(value.provider_account_count) && Number(value.provider_account_count) >= 0
    && Number.isInteger(value.active_session_count) && Number(value.active_session_count) >= 0;
  const provisioned = common && value.ready === true && value.provisioned === true
    && value.principal_record_present === true && value.principal_record_provisioned === true
    && value.provider_account_provisioned === true && value.provider_account_count === 1 && value.active_session_count === 0;
  const unprovisioned = common && value.ready === false && value.provisioned === false
    && value.provider_account_provisioned === false && value.provider_account_count === 0 && value.active_session_count === 0
    && value.principal_record_present === false && value.principal_record_provisioned === false;
  if (!provisioned && !unprovisioned) throw error('PRINCIPAL_PROVISION_RECONCILIATION_INVALID', 'The expired provision capability received a drifted readiness state.');
  return { state: provisioned ? 'provisioned' : 'unprovisioned', frontendBuild: target.expectedDeployment.frontend };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function principalProvisionArgumentBinding(config: VoiceLabConfig, idempotencyKey: string): {
  argumentHash: string;
  idempotencyKeySha256: string;
  principalIdSha256: string;
} {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw error('PRINCIPAL_PROVISION_IDEMPOTENCY_INVALID', 'A bounded stable provisioning idempotency key is required.', 'validation');
  }
  const target = config.readinessTarget;
  if (!target) throw error('PRINCIPAL_PROVISION_TARGET_UNAVAILABLE', 'The exact provisioning target is not configured.');
  if (!FRONTEND_SAFE_ID.test(config.principalId) || !FRONTEND_SAFE_ID.test(config.environment) || config.capabilityIssuer !== 'sophia-voice-lab') {
    throw error('PRINCIPAL_PROVISION_BINDING_INVALID', 'Provisioning configuration cannot satisfy the exact frontend claim grammar.');
  }
  let provisionEndpoint: URL;
  try {
    provisionEndpoint = resolveAllowedOriginPath(target.frontendUrl, config.authProvisionPath, config.allowedOrigins);
    resolveAllowedOriginPath(target.frontendUrl, config.authReadinessPath, config.allowedOrigins);
  } catch {
    throw error('PRINCIPAL_PROVISION_TARGET_UNAVAILABLE', 'Provisioning requires exact same-origin frontend paths.');
  }
  const idempotencyKeySha256 = sha256(idempotencyKey);
  const principalIdSha256 = sha256(config.principalId);
  return {
    argumentHash: canonicalRequestHash({
      schema: 'sophia_voice_lab_principal_provision_request_v1',
      idempotency_key_sha256: idempotencyKeySha256,
      principal_id_sha256: principalIdSha256,
      frontend_origin: provisionEndpoint.origin,
      frontend_path: provisionEndpoint.pathname,
      expected_deployment: target.expectedDeployment,
      environment: config.environment,
      mcp_build: config.serviceVersion,
    }),
    idempotencyKeySha256,
    principalIdSha256,
  };
}

export async function provisionVoiceLabPrincipal(
  config: VoiceLabConfig,
  ledger: VoiceLabLedger,
  callerId: string,
  idempotencyKey: string,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<PrincipalProvisionReceipt> {
  if (!config.provisioningEnabled) throw error('PRINCIPAL_PROVISION_DISABLED', 'Principal provisioning is disabled.', 'authorization');
  if (!config.killSwitch) throw error('PRINCIPAL_PROVISION_KILL_SWITCH_REQUIRED', 'Principal provisioning requires the execution kill switch.', 'authorization');
  const target = config.readinessTarget;
  if (!target) throw error('PRINCIPAL_PROVISION_TARGET_UNAVAILABLE', 'The exact provisioning target is not configured.');
  const binding = principalProvisionArgumentBinding(config, idempotencyKey);
  if (await ledger.countActiveRuns() !== 0) {
    throw error('PRINCIPAL_PROVISION_ACTIVE_RUN_CONFLICT', 'Principal provisioning requires zero active Voice Lab runs.', 'conflict');
  }
  const issuedAt = options.now ?? new Date();
  const preparationInputs = {
    requestHash: binding.argumentHash,
    idempotencyKeyHash: binding.idempotencyKeySha256,
    principalHash: binding.principalIdSha256,
    callerId,
    issuedAt,
    testRunId: randomUUID(),
    cleanupObligationId: randomUUID(),
    capabilityJti: randomBytes(16).toString('hex'),
    capabilityNonce: randomBytes(16).toString('hex'),
    providerExpiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1_000),
    environment: config.environment,
    expectedDeployment: { ...target.expectedDeployment },
    mcpBuild: config.serviceVersion,
    operatorSubjectHash: sha256(callerId),
  };
  const candidateCapability = mintPreparedCapability(config, preparationInputs);
  const preparation: PrincipalProvisionPreparation = { ...preparationInputs, capabilityHash: candidateCapability.tokenHash };
  const leaseOwner = randomUUID();
  const deadline = Date.now() + CLAIM_WAIT_MS;
  let claim = await ledger.claimPrincipalProvision(preparation, leaseOwner, CLAIM_LEASE_SECONDS, new Date());
  while (claim.disposition === 'pending' && Date.now() < deadline) {
    await sleep(CLAIM_POLL_MS);
    claim = await ledger.claimPrincipalProvision(preparation, leaseOwner, CLAIM_LEASE_SECONDS, new Date());
  }
  if (claim.disposition === 'conflict') {
    throw error('PRINCIPAL_PROVISION_CHAIN_CONFLICT', 'The singleton principal provisioning chain is already bound to another request.', 'conflict');
  }
  if (claim.disposition === 'pending') {
    throw error('PRINCIPAL_PROVISION_IN_PROGRESS', 'The singleton principal provisioning chain is still owned by another request.', 'conflict');
  }
  if (claim.disposition === 'completed') {
    const durable = await ledger.getPrincipalProvisionReadiness(new Date());
    if (durable.status !== 'completed') throw error('PRINCIPAL_PROVISION_AUDIT_MISSING', 'The completed provision receipt has no exact durable audit row.');
    const replay = parseStoredReceipt(claim.record, { ...binding, callerId, config });
    if (!replay) throw error('PRINCIPAL_PROVISION_RECEIPT_INVALID', 'The durable principal provisioning receipt failed its exact binding.');
    return replay;
  }

  let record = claim.record;
  let minted = mintPreparedCapability(config, record);
  let frontend: { result: Pick<FrontendProvisionResult, 'frontend_build'>; attempts: number; reconciled: boolean };
  try {
    const current = options.now ?? new Date();
    const cannotReplay = minted.tokenHash !== record.capabilityHash || minted.claims.exp <= Math.floor(current.getTime() / 1_000);
    if (cannotReplay) {
      const reconciled = await reconcileExpiredCapability(config, record, options.fetchImpl ?? globalThis.fetch, current);
      if (reconciled.state === 'provisioned') {
        frontend = { result: { frontend_build: reconciled.frontendBuild }, attempts: 0, reconciled: true };
      } else {
        const rotationInputs = {
          ...record,
          issuedAt: current,
          capabilityJti: randomBytes(16).toString('hex'),
          capabilityNonce: randomBytes(16).toString('hex'),
          providerExpiresAt: new Date(current.getTime() + 10 * 60 * 1_000),
        };
        const rotated = mintPreparedCapability(config, rotationInputs);
        record = await ledger.rotatePrincipalProvisionCapability(binding.argumentHash, leaseOwner, {
          issuedAt: rotationInputs.issuedAt,
          capabilityJti: rotationInputs.capabilityJti,
          capabilityNonce: rotationInputs.capabilityNonce,
          capabilityHash: rotated.tokenHash,
          providerExpiresAt: rotationInputs.providerExpiresAt,
        }, new Date());
        minted = mintPreparedCapability(config, record);
        const result = await callFrontend(config, minted, options.fetchImpl ?? globalThis.fetch);
        frontend = { ...result, reconciled: false };
      }
    } else {
      const result = await callFrontend(config, minted, options.fetchImpl ?? globalThis.fetch);
      frontend = { ...result, reconciled: false };
    }
  } catch (caught) {
    await ledger.releasePrincipalProvision(binding.argumentHash, leaseOwner, new Date()).catch(() => undefined);
    throw caught;
  }
  const core: PrincipalProvisionReceiptCore = {
    schema: PRINCIPAL_PROVISION_RECEIPT_SCHEMA,
    ok: true,
    provisioned: true,
    idempotency_key_sha256: binding.idempotencyKeySha256,
    operator_request_sha256: binding.argumentHash,
    principal_id_sha256: binding.principalIdSha256,
    capability_sha256: record.capabilityHash,
    capability_jti_sha256: sha256(record.capabilityJti),
    test_run_id_sha256: sha256(record.testRunId),
    cleanup_obligation_id_sha256: sha256(record.cleanupObligationId),
    environment: config.environment,
    frontend_build: frontend.result.frontend_build,
    mcp_build: config.serviceVersion,
    expected_deployment: { ...target.expectedDeployment },
    frontend_attempts: frontend.attempts,
    frontend_reconciled: frontend.reconciled,
    auth_audit_id: record.authAuditId,
    audit_observed_at: record.auditObservedAt.toISOString(),
    operator_subject_sha256: record.operatorSubjectHash,
  };
  const receipt: PrincipalProvisionReceipt = {
    ...core,
    idempotent_replay: false,
    receipt_sha256: canonicalRequestHash(core),
  };
  try {
    await ledger.finalizePrincipalProvision(binding.argumentHash, leaseOwner, receipt as unknown as Record<string, unknown>, {
      id: record.authAuditId,
      runId: null,
      callerId,
      action: PRINCIPAL_PROVISION_ACTION,
      capabilityJtiHash: receipt.capability_jti_sha256,
      argumentHash: binding.argumentHash,
      outcome: 'allowed',
      detail: receipt as unknown as Record<string, unknown>,
      observedAt: record.auditObservedAt,
    }, new Date());
  } catch (caught) {
    await ledger.releasePrincipalProvision(binding.argumentHash, leaseOwner, new Date()).catch(() => undefined);
    throw caught;
  }
  return receipt;
}
