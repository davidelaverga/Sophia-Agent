import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ERROR = /^[A-Za-z0-9_]{1,100}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROVISION_PATH = '/internal/voice-lab/auth/provision';
const RECEIPT_SCHEMA = 'sophia_voice_lab_principal_provision_receipt_v1';
const RESPONSE_LIMIT_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 15_000;
const OPERATOR_SUBJECT = 'system.principal-provision-operator';
const AUDIT_ID = /^[1-9][0-9]{0,18}$/;
const RESPONSE_KEYS = new Set([
  'schema', 'ok', 'provisioned', 'idempotency_key_sha256', 'operator_request_sha256',
  'principal_id_sha256', 'capability_sha256', 'capability_jti_sha256',
  'test_run_id_sha256', 'cleanup_obligation_id_sha256', 'environment', 'frontend_build',
  'mcp_build', 'expected_deployment', 'frontend_attempts', 'frontend_reconciled', 'idempotent_replay',
  'auth_audit_id', 'audit_observed_at', 'operator_subject_sha256', 'receipt_sha256',
]);

export class VoiceLabPrincipalProvisionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceLabPrincipalProvisionError';
    this.code = code;
  }
}

function fail(code) {
  throw new VoiceLabPrincipalProvisionError(code);
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) fail('operator_configuration_missing');
  return value;
}

function exactHttpsOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('mcp_target_invalid');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.origin !== raw.replace(/\/$/, '')
  ) fail('mcp_target_invalid');
  return url.origin;
}

export function loadPrincipalProvisionConfig(env = process.env) {
  if (env.SOPHIA_VOICE_LAB_PRINCIPAL_PROVISION_APPROVED !== 'YES') {
    fail('principal_provision_approval_required');
  }
  if (env.SOPHIA_VOICE_LAB_PROVISIONING_ENABLED?.trim().toLowerCase() !== 'true') {
    fail('principal_provisioning_gate_closed');
  }
  const operatorBearer = required(env, 'SOPHIA_VOICE_LAB_PROVISION_OPERATOR_BEARER_TOKEN');
  if (Buffer.byteLength(operatorBearer, 'utf8') < 32 || Buffer.byteLength(operatorBearer, 'utf8') > 512) {
    fail('principal_provision_authority_invalid');
  }
  const environment = required(env, 'SOPHIA_VOICE_LAB_ENVIRONMENT');
  const idempotencyKey = required(env, 'SOPHIA_VOICE_LAB_PRINCIPAL_PROVISION_IDEMPOTENCY_KEY');
  if (environment !== 'production' || !SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
    fail('operator_binding_invalid');
  }
  const expectedDeployment = {
    frontend: required(env, 'SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA'),
    backend: required(env, 'SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA'),
    voice: required(env, 'SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA'),
  };
  const expectedMcpSha = required(env, 'SOPHIA_VOICE_LAB_EXPECTED_MCP_SHA');
  if ([...Object.values(expectedDeployment), expectedMcpSha].some((value) => !SHA1.test(value))) {
    fail('expected_deployment_invalid');
  }
  return Object.freeze({
    mcpOrigin: exactHttpsOrigin(required(env, 'SOPHIA_VOICE_LAB_TARGET_MCP_URL')),
    operatorBearer,
    environment,
    idempotencyKey,
    expectedDeployment: Object.freeze(expectedDeployment),
    expectedMcpSha,
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(input) {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`;
  if (input && typeof input === 'object') {
    return `{${Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`).join(',')}}`;
  }
  return JSON.stringify(input);
}

function receiptCore(receipt) {
  const { idempotent_replay: _replay, receipt_sha256: _digest, ...core } = receipt;
  return core;
}

async function boundedJson(response) {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const declared = Number(response.headers.get('content-length') || 0);
  if (contentType !== 'application/json' || (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) || !response.body) {
    fail('principal_provision_response_invalid');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      fail('principal_provision_response_invalid');
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    fail('principal_provision_response_invalid');
  }
}

function exactDeployment(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'backend,frontend,voice'
    && value.frontend === expected.frontend
    && value.backend === expected.backend
    && value.voice === expected.voice;
}

function validateSuccess(payload, config) {
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || Object.keys(payload).some((key) => !RESPONSE_KEYS.has(key))
    || Object.keys(payload).length !== RESPONSE_KEYS.size
    || payload.schema !== RECEIPT_SCHEMA
    || payload.ok !== true
    || payload.provisioned !== true
    || typeof payload.idempotent_replay !== 'boolean'
    || payload.idempotency_key_sha256 !== sha256(config.idempotencyKey)
    || !SHA256.test(payload.operator_request_sha256)
    || !SHA256.test(payload.principal_id_sha256)
    || !SHA256.test(payload.capability_sha256)
    || !SHA256.test(payload.capability_jti_sha256)
    || !SHA256.test(payload.test_run_id_sha256)
    || !SHA256.test(payload.cleanup_obligation_id_sha256)
    || payload.environment !== config.environment
    || payload.frontend_build !== config.expectedDeployment.frontend
    || payload.mcp_build !== config.expectedMcpSha
    || !exactDeployment(payload.expected_deployment, config.expectedDeployment)
    || !Number.isInteger(payload.frontend_attempts)
    || payload.frontend_attempts < 0
    || payload.frontend_attempts > 2
    || typeof payload.frontend_reconciled !== 'boolean'
    || (payload.frontend_reconciled ? payload.frontend_attempts !== 0 : payload.frontend_attempts < 1)
    || !AUDIT_ID.test(payload.auth_audit_id)
    || typeof payload.audit_observed_at !== 'string'
    || Number.isNaN(Date.parse(payload.audit_observed_at))
    || new Date(payload.audit_observed_at).toISOString() !== payload.audit_observed_at
    || payload.operator_subject_sha256 !== sha256(OPERATOR_SUBJECT)
    || !SHA256.test(payload.receipt_sha256)
    || payload.receipt_sha256 !== sha256(stableJson(receiptCore(payload)))
  ) fail('principal_provision_response_invalid');
  return payload;
}

function safeRemoteError(payload) {
  return payload && typeof payload === 'object' && SAFE_ERROR.test(payload.error)
    ? payload.error
    : 'remote_rejected';
}

export async function provisionVoiceLabPrincipal(config, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('operator_fetch_unavailable');
  const endpoint = new URL(PROVISION_PATH, config.mcpOrigin).toString();
  let lastError = 'principal_provision_ambiguous';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.operatorBearer}`,
          'X-Sophia-Voice-Lab-Idempotency-Key': config.idempotencyKey,
        },
      });
      const payload = await boundedJson(response);
      if (!response.ok) {
        const remote = safeRemoteError(payload);
        if (response.status >= 500 && attempt === 1) {
          lastError = remote;
          continue;
        }
        fail(`principal_provision_http_${response.status}_${remote}`);
      }
      const receipt = validateSuccess(payload, config);
      return Object.freeze({ ...receipt, operator_attempts: attempt });
    } catch (error) {
      if (error instanceof VoiceLabPrincipalProvisionError) {
        if (error.code === 'principal_provision_response_invalid' && attempt === 1) {
          lastError = error.code;
          continue;
        }
        throw error;
      }
      lastError = 'principal_provision_transport_ambiguous';
      if (attempt === 1) continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  fail(lastError);
}

export async function main(env = process.env) {
  const result = await provisionVoiceLabPrincipal(loadPrincipalProvisionConfig(env));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof VoiceLabPrincipalProvisionError
      ? error.code
      : 'principal_provision_operator_failed';
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  });
}
