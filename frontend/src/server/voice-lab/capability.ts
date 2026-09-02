import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';

import {
  SYNTHETIC_ISOLATION_POLICY_SCHEMA,
  VOICE_LAB_CONTEXT_COOKIE_NAME,
  VOICE_LAB_RUN_BINDING_COOKIE_NAME,
  type SyntheticIsolationPolicy,
} from '@/app/lib/synthetic-isolation-policy';
import { isVoiceLabOrdinaryProductContext } from '@/server/voice-lab/ordinary-route-isolation';

export const VOICE_LAB_CAPABILITY_HEADER = 'X-Sophia-Voice-Lab-Capability';
export const VOICE_LAB_CONTEXT_COOKIE = VOICE_LAB_CONTEXT_COOKIE_NAME;
export const VOICE_LAB_RUN_BINDING_COOKIE = VOICE_LAB_RUN_BINDING_COOKIE_NAME;
export const VOICE_LAB_FRONTEND_AUDIENCE = 'sophia-voice-lab-frontend';
export const VOICE_LAB_GATEWAY_AUDIENCE = 'sophia-voice-gateway';
export const VOICE_LAB_RUNTIME_AUDIENCE = 'sophia-voice-runtime';

const VOICE_LAB_GRANT_ISSUER = 'sophia-voice-lab';
const VOICE_LAB_FRONTEND_ISSUER = 'sophia-frontend';
const VOICE_LAB_RUN_BINDING_AUDIENCE = 'sophia-voice-lab-run-binding';
const DEFAULT_MAX_TTL_SECONDS = 300;
const DEFAULT_SESSION_TTL_SECONDS = 3600;
const MIN_SESSION_TTL_SECONDS = 1800;
const MAX_SESSION_TTL_SECONDS = 7200;
const MAX_CLOCK_SKEW_SECONDS = 10;
const MIN_RETENTION_HOURS = 1;
const MAX_RETENTION_HOURS = 168;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CLEANUP_OBLIGATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type VoiceLabExpectedDeployment = {
  frontend: string;
  backend: string;
  voice: string;
};

export type VoiceLabD02OwnershipClaims = {
  voice_lab_run_id_sha256: string;
  browser_worker_id_sha256: string;
  browser_lease_epoch: number;
  browser_context_id_sha256: string;
};

export type VoiceLabCapabilityClaims = {
  v: 1;
  iss: string;
  aud: string;
  sub: string;
  principal_id: string;
  test_run_id: string;
  scenario_id?: string;
  scenario_version?: string;
  voice_lab_run_id_sha256?: string;
  browser_worker_id_sha256?: string;
  browser_lease_epoch?: number;
  browser_context_id_sha256?: string;
  synthetic: true;
  environment: string;
  retention_hours: number;
  cleanup_obligation_id: string;
  provider_expires_at: string;
  allowed_ops: string[];
  expected_deployment: VoiceLabExpectedDeployment;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  nonce: string;
};

export type VoiceLabRunBindingClaims = {
  v: 1;
  iss: typeof VOICE_LAB_FRONTEND_ISSUER;
  aud: typeof VOICE_LAB_RUN_BINDING_AUDIENCE;
  principal_id: string;
  test_run_id: string;
  scenario_id?: string;
  scenario_version?: string;
  voice_lab_run_id_sha256?: string;
  browser_worker_id_sha256?: string;
  browser_lease_epoch?: number;
  browser_context_id_sha256?: string;
  environment: string;
  retention_hours: number;
  cleanup_obligation_id: string;
  provider_expires_at: string;
  expected_deployment: VoiceLabExpectedDeployment;
  session_token_sha256: string;
  grant_jti_sha256: string;
  grant_nonce_sha256: string;
  frontend_build: string;
  iat: number;
  exp: number;
};

type VoiceLabTokenExpectations = {
  audience: string;
  issuer: string;
  requiredOperation: string;
  principalId: string;
  environment: string;
  expectedFrontendBuild?: string;
};

export class VoiceLabCapabilityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'VoiceLabCapabilityError';
    this.code = code;
    this.status = status;
  }
}

/** Reject body-bearing control requests without parsing or buffering their payload. */
export async function assertNoVoiceLabRequestBody(request: Request): Promise<void> {
  const contentLength = request.headers.get('content-length');
  if (
    request.headers.has('transfer-encoding')
    || (contentLength !== null && contentLength.trim() !== '0')
  ) {
    throw new VoiceLabCapabilityError('voice_lab_request_body_not_allowed', 400);
  }
  if (request.body === null || contentLength?.trim() === '0') return;

  // Vercel strips Content-Length: 0 before constructing the NextRequest and
  // still exposes an empty stream. Peek only for a first byte so normalized
  // empty POSTs pass while any payload fails before parsing or allocation.
  const reader = request.body.getReader();
  try {
    const first = await reader.read();
    if (!first.done) {
      await reader.cancel();
      throw new VoiceLabCapabilityError('voice_lab_request_body_not_allowed', 400);
    }
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) throw error;
    await reader.cancel().catch(() => undefined);
    throw new VoiceLabCapabilityError('voice_lab_request_body_not_allowed', 400);
  } finally {
    reader.releaseLock();
  }
}

function requiredConfig(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new VoiceLabCapabilityError('voice_lab_configuration_missing', 503);
  }
  return value;
}

function requiredSecret(name: string): string {
  const value = requiredConfig(name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
  }
  return value;
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/** Mirror the runtime admission predicate exactly for signed readiness evidence. */
export function isVoiceLabRuntimeEnabled(): boolean {
  return isTrue(process.env.SOPHIA_VOICE_LAB_ENABLED);
}

function strictBooleanConfig(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
}

/** Exact phase evidence consumed by the signed readiness/provision boundary. */
export function getVoiceLabControlGates(): {
  voiceLabEnabled: boolean;
  killSwitchEngaged: boolean;
  provisioningEnabled: boolean;
  controlAdapterEnabled: boolean;
} {
  return {
    voiceLabEnabled: isVoiceLabRuntimeEnabled(),
    killSwitchEngaged: strictBooleanConfig('SOPHIA_VOICE_LAB_KILL_SWITCH'),
    provisioningEnabled: strictBooleanConfig('SOPHIA_VOICE_LAB_PROVISIONING_ENABLED'),
    controlAdapterEnabled: isTrue(process.env.SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED),
  };
}

export function assertVoiceLabEnabled(): void {
  if (!isVoiceLabRuntimeEnabled()) {
    throw new VoiceLabCapabilityError('voice_lab_disabled', 404);
  }
  if (process.env.SOPHIA_VOICE_LAB_KILL_SWITCH?.trim().toLowerCase() !== 'false') {
    throw new VoiceLabCapabilityError('voice_lab_kill_switch_active', 403);
  }
}

function assertVoiceLabOperationAllowed(requiredOperation: string): void {
  const disabledSafeOperation = requiredOperation === 'auth:provision'
    || requiredOperation === 'auth:readiness';
  if (
    !isVoiceLabRuntimeEnabled()
    && !disabledSafeOperation
  ) {
    throw new VoiceLabCapabilityError('voice_lab_disabled', 404);
  }
  const killSafeOperation = requiredOperation === 'session:finalize'
    || requiredOperation === 'session:cleanup'
    || requiredOperation === 'session:read'
    || requiredOperation === 'auth:provision'
    || requiredOperation === 'auth:readiness';
  if (
    !killSafeOperation
    && process.env.SOPHIA_VOICE_LAB_KILL_SWITCH?.trim().toLowerCase() !== 'false'
  ) {
    throw new VoiceLabCapabilityError('voice_lab_kill_switch_active', 403);
  }
}

export function getVoiceLabPrincipalConfig(): { principalId: string; email: string; environment: string } {
  const principalId = requiredConfig('SOPHIA_VOICE_LAB_TEST_PRINCIPAL');
  const email = requiredConfig('SOPHIA_VOICE_LAB_TEST_EMAIL').toLowerCase();
  const environment = requiredConfig('SOPHIA_VOICE_LAB_ENVIRONMENT');
  if (!SAFE_ID_PATTERN.test(principalId) || !email.includes('@') || !SAFE_ID_PATTERN.test(environment)) {
    throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
  }
  return { principalId, email, environment };
}

export function getCurrentFrontendBuild(): string {
  const value = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.SOPHIA_DEPLOYMENT_SHA || '').trim();
  if (!SHA_PATTERN.test(value)) {
    throw new VoiceLabCapabilityError('voice_lab_deployment_identity_unavailable', 503);
  }
  return value;
}

export function getVoiceLabSessionTtlSeconds(): number {
  const configured = process.env.SOPHIA_VOICE_LAB_SESSION_TTL_SECONDS?.trim();
  const value = configured ? Number(configured) : DEFAULT_SESSION_TTL_SECONDS;
  if (!Number.isInteger(value) || value < MIN_SESSION_TTL_SECONDS || value > MAX_SESSION_TTL_SECONDS) {
    throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
  }
  return value;
}

function getVoiceLabCapabilityMaxTtlSeconds(): number {
  const configured = process.env.SOPHIA_VOICE_LAB_MAX_TTL_SECONDS?.trim();
  const value = configured ? Number(configured) : DEFAULT_MAX_TTL_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_TTL_SECONDS) {
    throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
  }
  return value;
}

function encodeBase64Url(value: unknown): string {
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8').toString('base64url');
  }
  const bytes = value as { readonly length: number; readonly [index: number]: number };
  return Buffer.from(Array.from({ length: bytes.length }, (_unused, index) => bytes[index])).toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || encodeBase64Url(decoded) !== value) {
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  return decoded;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
}

function isCanonicalUtcMillis(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

const D02_OWNERSHIP_KEYS = [
  'voice_lab_run_id_sha256',
  'browser_worker_id_sha256',
  'browser_lease_epoch',
  'browser_context_id_sha256',
] as const;

type D02OwnershipCarrier = Partial<VoiceLabD02OwnershipClaims> & {
  scenario_id?: string;
};

function hasValidD02OwnershipClaims(value: D02OwnershipCarrier): boolean {
  const present = D02_OWNERSHIP_KEYS.filter((key) => value[key] !== undefined);
  if (value.scenario_id !== 'V-D02') return present.length === 0;
  return present.length === D02_OWNERSHIP_KEYS.length
    && SHA256_PATTERN.test(value.voice_lab_run_id_sha256 || '')
    && SHA256_PATTERN.test(value.browser_worker_id_sha256 || '')
    && Number.isSafeInteger(value.browser_lease_epoch)
    && Number(value.browser_lease_epoch) > 0
    && SHA256_PATTERN.test(value.browser_context_id_sha256 || '');
}

export function projectVoiceLabD02OwnershipClaims(
  claims: VoiceLabCapabilityClaims,
): VoiceLabD02OwnershipClaims | null {
  if (!hasValidD02OwnershipClaims(claims)) {
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  if (claims.scenario_id !== 'V-D02') return null;
  return {
    voice_lab_run_id_sha256: claims.voice_lab_run_id_sha256,
    browser_worker_id_sha256: claims.browser_worker_id_sha256,
    browser_lease_epoch: claims.browser_lease_epoch,
    browser_context_id_sha256: claims.browser_context_id_sha256,
  };
}

function parseClaims(value: unknown): VoiceLabCapabilityClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  const claims = value as Partial<VoiceLabCapabilityClaims>;
  const allowedClaimKeys = new Set([
    'v', 'iss', 'aud', 'sub', 'principal_id', 'test_run_id', 'scenario_id',
    'scenario_version', 'voice_lab_run_id_sha256', 'browser_worker_id_sha256',
    'browser_lease_epoch', 'browser_context_id_sha256', 'synthetic', 'environment', 'allowed_ops',
    'retention_hours', 'cleanup_obligation_id', 'provider_expires_at', 'expected_deployment', 'iat', 'nbf', 'exp', 'jti', 'nonce',
  ]);
  const deployment = claims.expected_deployment;
  const allowedOps = claims.allowed_ops;
  const validScenario = claims.scenario_id === undefined || assertSafeId(claims.scenario_id);
  const validScenarioVersion = claims.scenario_version === undefined || assertSafeId(claims.scenario_version);
  if (
    claims.v !== 1
    || !assertSafeId(claims.iss)
    || !assertSafeId(claims.aud)
    || !assertSafeId(claims.sub)
    || !assertSafeId(claims.principal_id)
    || !assertSafeId(claims.test_run_id)
    || !validScenario
    || !validScenarioVersion
    || !hasValidD02OwnershipClaims(claims)
    || claims.synthetic !== true
    || Object.keys(claims).some((key) => !allowedClaimKeys.has(key))
    || !assertSafeId(claims.environment)
    || !Number.isInteger(claims.retention_hours)
    || (claims.retention_hours ?? 0) < MIN_RETENTION_HOURS
    || (claims.retention_hours ?? 0) > MAX_RETENTION_HOURS
    || !CLEANUP_OBLIGATION_ID_PATTERN.test(claims.cleanup_obligation_id || '')
    || !isCanonicalUtcMillis(claims.provider_expires_at)
    || !Array.isArray(allowedOps)
    || allowedOps.length === 0
    || allowedOps.length > 16
    || allowedOps.some((op) => !assertSafeId(op))
    || new Set(allowedOps).size !== allowedOps.length
    || !deployment
    || typeof deployment !== 'object'
    || Array.isArray(deployment)
    || Object.keys(deployment).length !== 3
    || Object.keys(deployment).some((key) => !['frontend', 'backend', 'voice'].includes(key))
    || !SHA_PATTERN.test(deployment.frontend)
    || !SHA_PATTERN.test(deployment.backend)
    || !SHA_PATTERN.test(deployment.voice)
    || !Number.isInteger(claims.iat)
    || !Number.isInteger(claims.nbf)
    || !Number.isInteger(claims.exp)
    || !assertSafeId(claims.jti)
    || !assertSafeId(claims.nonce)
  ) {
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  return claims as VoiceLabCapabilityClaims;
}

export function signVoiceLabCapability(
  claims: VoiceLabCapabilityClaims,
  secret: string,
): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new VoiceLabCapabilityError('voice_lab_configuration_invalid', 503);
  }
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(payload, 'ascii').digest();
  return `${payload}.${encodeBase64Url(signature)}`;
}

function parseRunBindingClaims(value: unknown): VoiceLabRunBindingClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_malformed', 401);
  }
  const claims = value as Partial<VoiceLabRunBindingClaims>;
  const allowedClaimKeys = new Set([
    'v', 'iss', 'aud', 'principal_id', 'test_run_id', 'scenario_id',
    'scenario_version', 'voice_lab_run_id_sha256', 'browser_worker_id_sha256',
    'browser_lease_epoch', 'browser_context_id_sha256', 'environment', 'retention_hours', 'cleanup_obligation_id', 'provider_expires_at', 'expected_deployment',
    'session_token_sha256', 'grant_jti_sha256', 'grant_nonce_sha256',
    'frontend_build', 'iat', 'exp',
  ]);
  const deployment = claims.expected_deployment;
  if (
    claims.v !== 1
    || claims.iss !== VOICE_LAB_FRONTEND_ISSUER
    || claims.aud !== VOICE_LAB_RUN_BINDING_AUDIENCE
    || Object.keys(claims).some((key) => !allowedClaimKeys.has(key))
    || !assertSafeId(claims.principal_id)
    || !assertSafeId(claims.test_run_id)
    || (claims.scenario_id !== undefined && !assertSafeId(claims.scenario_id))
    || (claims.scenario_version !== undefined && !assertSafeId(claims.scenario_version))
    || !hasValidD02OwnershipClaims(claims)
    || !assertSafeId(claims.environment)
    || !Number.isInteger(claims.retention_hours)
    || (claims.retention_hours ?? 0) < MIN_RETENTION_HOURS
    || (claims.retention_hours ?? 0) > MAX_RETENTION_HOURS
    || !CLEANUP_OBLIGATION_ID_PATTERN.test(claims.cleanup_obligation_id || '')
    || !isCanonicalUtcMillis(claims.provider_expires_at)
    || !deployment
    || typeof deployment !== 'object'
    || Array.isArray(deployment)
    || Object.keys(deployment).length !== 3
    || Object.keys(deployment).some((key) => !['frontend', 'backend', 'voice'].includes(key))
    || !SHA_PATTERN.test(deployment.frontend || '')
    || !SHA_PATTERN.test(deployment.backend || '')
    || !SHA_PATTERN.test(deployment.voice || '')
    || !SHA256_PATTERN.test(claims.session_token_sha256 || '')
    || !SHA256_PATTERN.test(claims.grant_jti_sha256 || '')
    || !SHA256_PATTERN.test(claims.grant_nonce_sha256 || '')
    || !SHA_PATTERN.test(claims.frontend_build || '')
    || !Number.isInteger(claims.iat)
    || !Number.isInteger(claims.exp)
  ) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_malformed', 401);
  }
  return claims as VoiceLabRunBindingClaims;
}

export function mintVoiceLabRunBinding(
  grant: VoiceLabCapabilityClaims,
  sessionToken: string,
  sessionExpiresAt: Date,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const claims: VoiceLabRunBindingClaims = {
    v: 1,
    iss: VOICE_LAB_FRONTEND_ISSUER,
    aud: VOICE_LAB_RUN_BINDING_AUDIENCE,
    principal_id: grant.principal_id,
    test_run_id: grant.test_run_id,
    ...(grant.scenario_id ? { scenario_id: grant.scenario_id } : {}),
    ...(grant.scenario_version ? { scenario_version: grant.scenario_version } : {}),
    ...(projectVoiceLabD02OwnershipClaims(grant) ?? {}),
    environment: grant.environment,
    retention_hours: grant.retention_hours,
    cleanup_obligation_id: grant.cleanup_obligation_id,
    provider_expires_at: grant.provider_expires_at,
    expected_deployment: { ...grant.expected_deployment },
    session_token_sha256: sha256(sessionToken),
    grant_jti_sha256: sha256(grant.jti),
    grant_nonce_sha256: sha256(grant.nonce),
    frontend_build: grant.expected_deployment.frontend,
    iat: nowSeconds,
    exp: Math.floor(sessionExpiresAt.getTime() / 1000),
  };
  if (
    claims.exp <= nowSeconds
    || claims.exp - claims.iat > MAX_SESSION_TTL_SECONDS + MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_invalid_lifetime', 503);
  }
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = createHmac(
    'sha256',
    requiredSecret('SOPHIA_VOICE_LAB_CAPABILITY_SECRET'),
  ).update(payload, 'ascii').digest();
  return `${payload}.${encodeBase64Url(signature)}`;
}

export function verifyVoiceLabRunBinding(
  token: string | null | undefined,
  grant: VoiceLabCapabilityClaims,
  sessionToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VoiceLabRunBindingClaims {
  if (!token) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_missing', 401);
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_malformed', 401);
  }
  const [payload, signatureText] = parts;
  const suppliedSignature = Uint8Array.from(decodeBase64Url(signatureText));
  const expectedSignature = Uint8Array.from(createHmac(
    'sha256',
    requiredSecret('SOPHIA_VOICE_LAB_CAPABILITY_SECRET'),
  ).update(payload, 'ascii').digest());
  if (
    suppliedSignature.length !== expectedSignature.length
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_invalid_signature', 401);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(payload).toString('utf8'));
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      throw error;
    }
    throw new VoiceLabCapabilityError('voice_lab_run_binding_malformed', 401);
  }
  const binding = parseRunBindingClaims(decoded);
  if (
    binding.exp <= nowSeconds
    || binding.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS
    || binding.exp - binding.iat > MAX_SESSION_TTL_SECONDS + MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_expired', 401);
  }
  const config = getVoiceLabPrincipalConfig();
  if (
    binding.principal_id !== config.principalId
    || binding.principal_id !== grant.principal_id
    || binding.test_run_id !== grant.test_run_id
    || binding.scenario_id !== grant.scenario_id
    || binding.scenario_version !== grant.scenario_version
    || binding.voice_lab_run_id_sha256 !== grant.voice_lab_run_id_sha256
    || binding.browser_worker_id_sha256 !== grant.browser_worker_id_sha256
    || binding.browser_lease_epoch !== grant.browser_lease_epoch
    || binding.browser_context_id_sha256 !== grant.browser_context_id_sha256
    || binding.environment !== config.environment
    || binding.environment !== grant.environment
    || binding.retention_hours !== grant.retention_hours
    || binding.cleanup_obligation_id !== grant.cleanup_obligation_id
    || binding.provider_expires_at !== grant.provider_expires_at
    || binding.frontend_build !== getCurrentFrontendBuild()
    || binding.frontend_build !== grant.expected_deployment.frontend
    || binding.expected_deployment.frontend !== grant.expected_deployment.frontend
    || binding.expected_deployment.backend !== grant.expected_deployment.backend
    || binding.expected_deployment.voice !== grant.expected_deployment.voice
    || binding.session_token_sha256 !== sha256(sessionToken)
  ) {
    throw new VoiceLabCapabilityError('voice_lab_run_binding_mismatch', 409);
  }
  return binding;
}

export function verifyVoiceLabCapability(
  token: string | null | undefined,
  secret: string,
  expectations: VoiceLabTokenExpectations,
  nowSeconds = Math.floor(Date.now() / 1000),
): VoiceLabCapabilityClaims {
  if (!token) {
    throw new VoiceLabCapabilityError('voice_lab_capability_missing', 401);
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  const [payload, signatureText] = parts;
  const suppliedSignature = decodeBase64Url(signatureText);
  const expectedSignature = createHmac('sha256', secret).update(payload, 'ascii').digest();
  const suppliedSignatureBytes = Uint8Array.from(suppliedSignature);
  const expectedSignatureBytes = Uint8Array.from(expectedSignature);
  if (
    suppliedSignatureBytes.length !== expectedSignatureBytes.length
    || !timingSafeEqual(suppliedSignatureBytes, expectedSignatureBytes)
  ) {
    throw new VoiceLabCapabilityError('voice_lab_capability_invalid_signature', 401);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(payload).toString('utf8'));
  } catch (error) {
    if (error instanceof VoiceLabCapabilityError) {
      throw error;
    }
    throw new VoiceLabCapabilityError('voice_lab_capability_malformed', 401);
  }
  const claims = parseClaims(decoded);
  const maxTtl = getVoiceLabCapabilityMaxTtlSeconds();

  if (
    claims.exp <= claims.iat
    || claims.nbf >= claims.exp
    || claims.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS
    || claims.exp - claims.iat > maxTtl
    || claims.nbf < claims.iat - MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new VoiceLabCapabilityError('voice_lab_capability_invalid_lifetime', 401);
  }
  if (claims.exp <= nowSeconds || claims.nbf > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
    throw new VoiceLabCapabilityError('voice_lab_capability_expired_or_not_yet_valid', 401);
  }
  if (claims.iss !== expectations.issuer || claims.aud !== expectations.audience) {
    throw new VoiceLabCapabilityError('voice_lab_capability_wrong_audience', 403);
  }
  if (
    claims.sub !== expectations.principalId
    || claims.principal_id !== expectations.principalId
    || claims.sub !== claims.principal_id
  ) {
    throw new VoiceLabCapabilityError('voice_lab_capability_wrong_principal', 403);
  }
  if (claims.environment !== expectations.environment) {
    throw new VoiceLabCapabilityError('voice_lab_capability_wrong_environment', 403);
  }
  if (!claims.allowed_ops.includes(expectations.requiredOperation)) {
    throw new VoiceLabCapabilityError('voice_lab_capability_operation_denied', 403);
  }
  if (expectations.expectedFrontendBuild && claims.expected_deployment.frontend !== expectations.expectedFrontendBuild) {
    throw new VoiceLabCapabilityError('voice_lab_capability_deployment_mismatch', 409);
  }
  return claims;
}

export function verifyFrontendCapability(
  token: string | null | undefined,
  requiredOperation: 'auth:session' | 'auth:provision' | 'auth:readiness' | 'session:create' | 'session:read' | 'session:continue' | 'session:finalize' | 'session:cleanup',
  nowSeconds = Math.floor(Date.now() / 1000),
): VoiceLabCapabilityClaims {
  assertVoiceLabOperationAllowed(requiredOperation);
  const config = getVoiceLabPrincipalConfig();
  return verifyVoiceLabCapability(
    token,
    requiredSecret('SOPHIA_VOICE_LAB_GRANT_SECRET'),
    {
      audience: VOICE_LAB_FRONTEND_AUDIENCE,
      issuer: VOICE_LAB_GRANT_ISSUER,
      requiredOperation,
      principalId: config.principalId,
      environment: config.environment,
      expectedFrontendBuild: getCurrentFrontendBuild(),
    },
    nowSeconds,
  );
}

export function verifyFrontendGrant(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): VoiceLabCapabilityClaims {
  return verifyFrontendCapability(token, 'auth:session', nowSeconds);
}

export function verifyVoiceLabControlCapability(
  token: string | null | undefined,
  requiredOperation: 'session:create' | 'voice:start',
  nowSeconds = Math.floor(Date.now() / 1000),
): VoiceLabCapabilityClaims {
  assertVoiceLabOperationAllowed(requiredOperation);
  const config = getVoiceLabPrincipalConfig();
  return verifyVoiceLabCapability(
    token,
    requiredSecret('SOPHIA_VOICE_LAB_CAPABILITY_SECRET'),
    {
      audience: VOICE_LAB_GATEWAY_AUDIENCE,
      issuer: VOICE_LAB_FRONTEND_ISSUER,
      requiredOperation,
      principalId: config.principalId,
      environment: config.environment,
      expectedFrontendBuild: getCurrentFrontendBuild(),
    },
    nowSeconds,
  );
}

export function assertVoiceLabControlAdapterEnabled(): void {
  if (process.env.SOPHIA_VOICE_LAB_CONTROL_ADAPTER_ENABLED?.trim().toLowerCase() !== 'true') {
    throw new VoiceLabCapabilityError('voice_lab_control_adapter_disabled', 404);
  }
}

const ORDINARY_ANALYTICS_POLICY: SyntheticIsolationPolicy = {
  schema: SYNTHETIC_ISOLATION_POLICY_SCHEMA,
  source: 'ordinary_request',
  synthetic: false,
  ordinary_product_analytics_excluded: false,
  ordinary_error_reporting_excluded: false,
  sink_allocation_allowed: true,
  reason: null,
};

function excludedAnalyticsPolicy(
  source: 'verified_voice_lab_context' | 'unverified_voice_lab_context_fail_closed',
): SyntheticIsolationPolicy {
  return {
    schema: SYNTHETIC_ISOLATION_POLICY_SCHEMA,
    source,
    synthetic: true,
    ordinary_product_analytics_excluded: true,
    ordinary_error_reporting_excluded: true,
    sink_allocation_allowed: false,
    reason: 'synthetic_isolation_policy',
  };
}

/** Resolve a content-free server-authored analytics policy from the HttpOnly context. */
export function resolveVoiceLabSyntheticIsolationPolicy(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  runBindingPresent = false,
): SyntheticIsolationPolicy {
  if (!token) {
    return runBindingPresent
      ? excludedAnalyticsPolicy('unverified_voice_lab_context_fail_closed')
      : { ...ORDINARY_ANALYTICS_POLICY };
  }
  try {
    const config = getVoiceLabPrincipalConfig();
    verifyVoiceLabCapability(
      token,
      requiredSecret('SOPHIA_VOICE_LAB_CAPABILITY_SECRET'),
      {
        audience: VOICE_LAB_GATEWAY_AUDIENCE,
        issuer: VOICE_LAB_FRONTEND_ISSUER,
        requiredOperation: 'session:read',
        principalId: config.principalId,
        environment: config.environment,
        expectedFrontendBuild: getCurrentFrontendBuild(),
      },
      nowSeconds,
    );
    return excludedAnalyticsPolicy('verified_voice_lab_context');
  } catch {
    // Cookie presence is itself enough to fail closed. This prevents a stale,
    // drifted, or malformed imported browser state from entering an ordinary
    // analytics/Sentry sink while cleanup is still being established.
    return excludedAnalyticsPolicy('unverified_voice_lab_context_fail_closed');
  }
}

export async function getVoiceLabSyntheticIsolationPolicy(): Promise<SyntheticIsolationPolicy> {
  const cookieStore = await cookies();
  const markerPolicy = resolveVoiceLabSyntheticIsolationPolicy(
    cookieStore.get(VOICE_LAB_CONTEXT_COOKIE)?.value,
    Math.floor(Date.now() / 1000),
    Boolean(cookieStore.get(VOICE_LAB_RUN_BINDING_COOKIE)?.value),
  );
  if (!markerPolicy.sink_allocation_allowed) return markerPolicy;

  // The dedicated Better-Auth principal is an independent server-authored
  // isolation signal.  Marker cookies are deliberately not the sole fence:
  // imported/cleared state must not reclassify a lab identity as ordinary.
  if (await isVoiceLabOrdinaryProductContext()) {
    return excludedAnalyticsPolicy('unverified_voice_lab_context_fail_closed');
  }
  return markerPolicy;
}

export function mintGatewayCapability(
  grant: VoiceLabCapabilityClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const operations: GatewayCapabilityOperation[] = [
    'session:create',
    'session:read',
    'voice:start',
    'session:finalize',
  ];
  // V-L01 is the only governed trace-outage scenario. Preserve its explicit
  // fault authority across the HttpOnly frontend -> Gateway exchange; never
  // infer fault authority for an ordinary or differently scoped run.
  if (grant.scenario_id === 'V-L01') {
    operations.push('trace:fault');
  }
  return mintGatewayCapabilityForOperations(
    grant,
    operations,
    nowSeconds,
  );
}

type GatewayCapabilityOperation =
  | 'session:create'
  | 'session:read'
  | 'voice:start'
  | 'session:finalize'
  | 'trace:fault';

function mintGatewayCapabilityForOperations(
  grant: VoiceLabCapabilityClaims,
  operations: GatewayCapabilityOperation[],
  nowSeconds: number,
  authorizationOperation?: 'session:continue',
): string {
  const authorizationSatisfied = authorizationOperation
    ? grant.allowed_ops.includes(authorizationOperation)
    : operations.every((operation) => grant.allowed_ops.includes(operation));
  if (!authorizationSatisfied) {
    throw new VoiceLabCapabilityError('voice_lab_capability_operation_denied', 403);
  }
  const claims: VoiceLabCapabilityClaims = {
    ...grant,
    iss: VOICE_LAB_FRONTEND_ISSUER,
    aud: VOICE_LAB_GATEWAY_AUDIENCE,
    allowed_ops: operations,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: Math.min(grant.exp, nowSeconds + DEFAULT_MAX_TTL_SECONDS),
    jti: randomUUID(),
  };
  return signVoiceLabCapability(claims, requiredSecret('SOPHIA_VOICE_LAB_CAPABILITY_SECRET'));
}

export function mintGatewayFinalizationCapability(
  grant: VoiceLabCapabilityClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return mintGatewayCapabilityForOperations(grant, ['session:finalize'], nowSeconds);
}

export function mintGatewayContinuationCapability(
  grant: VoiceLabCapabilityClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return mintGatewayCapabilityForOperations(
    grant,
    ['session:create', 'session:read', 'session:finalize'],
    nowSeconds,
    'session:continue',
  );
}

async function getVoiceLabGatewayCapability(
  userId: string,
  requiredOperation: 'session:create' | 'session:read' | 'voice:start' | 'session:finalize',
): Promise<string | null> {
  const configuredPrincipal = process.env.SOPHIA_VOICE_LAB_TEST_PRINCIPAL?.trim();
  const cookieStore = await cookies();
  const token = cookieStore.get(VOICE_LAB_CONTEXT_COOKIE)?.value;

  if (!configuredPrincipal && !token) {
    return null;
  }
  if (userId !== configuredPrincipal) {
    if (token) {
      throw new VoiceLabCapabilityError('voice_lab_capability_wrong_principal', 403);
    }
    return null;
  }

  assertVoiceLabOperationAllowed(requiredOperation);
  const config = getVoiceLabPrincipalConfig();
  verifyVoiceLabCapability(
    token,
    requiredSecret('SOPHIA_VOICE_LAB_CAPABILITY_SECRET'),
    {
      audience: VOICE_LAB_GATEWAY_AUDIENCE,
      issuer: VOICE_LAB_FRONTEND_ISSUER,
      requiredOperation,
      principalId: config.principalId,
      environment: config.environment,
      expectedFrontendBuild: getCurrentFrontendBuild(),
    },
  );
  return token ?? null;
}

export async function getVoiceLabConnectCapability(userId: string): Promise<string | null> {
  return getVoiceLabGatewayCapability(userId, 'voice:start');
}

export async function getVoiceLabSessionCreateCapability(userId: string): Promise<string | null> {
  return getVoiceLabGatewayCapability(userId, 'session:create');
}

export async function getVoiceLabSessionReadCapability(userId: string): Promise<string | null> {
  return getVoiceLabGatewayCapability(userId, 'session:read');
}

export async function getVoiceLabEndSessionCapability(userId: string): Promise<string | null> {
  return getVoiceLabGatewayCapability(userId, 'session:finalize');
}
