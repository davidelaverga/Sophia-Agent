import type { DeploymentIdentity } from './domain.js';
import type { PrincipalProvisionControlRecord } from './ledger.js';
import { canonicalRequestHash, sha256 } from './security.js';

export const PRINCIPAL_PROVISION_RECEIPT_SCHEMA = 'sophia_voice_lab_principal_provision_receipt_v1';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const AUDIT_ID = /^[1-9][0-9]{0,18}$/;
const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface PrincipalProvisionReceiptCore {
  schema: typeof PRINCIPAL_PROVISION_RECEIPT_SCHEMA;
  ok: true;
  provisioned: true;
  idempotency_key_sha256: string;
  operator_request_sha256: string;
  principal_id_sha256: string;
  capability_sha256: string;
  capability_jti_sha256: string;
  test_run_id_sha256: string;
  cleanup_obligation_id_sha256: string;
  environment: string;
  frontend_build: string;
  mcp_build: string;
  expected_deployment: DeploymentIdentity;
  frontend_attempts: number;
  frontend_reconciled: boolean;
  auth_audit_id: string;
  audit_observed_at: string;
  operator_subject_sha256: string;
}

export interface PrincipalProvisionReceipt extends PrincipalProvisionReceiptCore {
  idempotent_replay: boolean;
  receipt_sha256: string;
}

const RECEIPT_KEYS = new Set([
  'schema', 'ok', 'provisioned', 'idempotency_key_sha256', 'operator_request_sha256',
  'principal_id_sha256', 'capability_sha256', 'capability_jti_sha256',
  'test_run_id_sha256', 'cleanup_obligation_id_sha256', 'environment', 'frontend_build', 'mcp_build',
  'expected_deployment', 'frontend_attempts', 'frontend_reconciled', 'auth_audit_id', 'audit_observed_at',
  'operator_subject_sha256', 'idempotent_replay', 'receipt_sha256',
]);

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

export function principalProvisionReceiptCore(
  receipt: PrincipalProvisionReceipt,
): PrincipalProvisionReceiptCore {
  const { idempotent_replay: _replay, receipt_sha256: _digest, ...core } = receipt;
  return core;
}

/** Validate every immutable receipt field against its durable prepare row. */
export function parseExactPrincipalProvisionReceipt(
  record: PrincipalProvisionControlRecord,
  value: unknown,
): PrincipalProvisionReceipt | null {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== RECEIPT_KEYS.size
    || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))
  ) return null;
  const receipt = value as PrincipalProvisionReceipt;
  if (
    receipt.schema !== PRINCIPAL_PROVISION_RECEIPT_SCHEMA
    || receipt.ok !== true
    || receipt.provisioned !== true
    || receipt.idempotent_replay !== false
    || receipt.idempotency_key_sha256 !== record.idempotencyKeyHash
    || receipt.operator_request_sha256 !== record.requestHash
    || receipt.principal_id_sha256 !== record.principalHash
    || receipt.capability_sha256 !== record.capabilityHash
    || receipt.capability_jti_sha256 !== sha256(record.capabilityJti)
    || receipt.test_run_id_sha256 !== sha256(record.testRunId)
    || receipt.cleanup_obligation_id_sha256 !== sha256(record.cleanupObligationId)
    || receipt.environment !== record.environment
    || (receipt.environment !== 'production' && receipt.environment !== 'staging')
    || !exactDeployment(record.expectedDeployment, record.expectedDeployment)
    || receipt.frontend_build !== record.expectedDeployment.frontend
    || receipt.mcp_build !== record.mcpBuild
    || !SHA40.test(receipt.mcp_build)
    || !exactDeployment(receipt.expected_deployment, record.expectedDeployment)
    || !Number.isInteger(receipt.frontend_attempts)
    || receipt.frontend_attempts < 0
    || receipt.frontend_attempts > 2
    || typeof receipt.frontend_reconciled !== 'boolean'
    || (receipt.frontend_reconciled ? receipt.frontend_attempts !== 0 : receipt.frontend_attempts < 1)
    || receipt.auth_audit_id !== record.authAuditId
    || receipt.audit_observed_at !== record.auditObservedAt.toISOString()
    || receipt.operator_subject_sha256 !== record.operatorSubjectHash
    || !AUDIT_ID.test(receipt.auth_audit_id)
    || !UTC_MILLIS.test(receipt.audit_observed_at)
    || new Date(receipt.audit_observed_at).toISOString() !== receipt.audit_observed_at
    || !SHA256.test(receipt.idempotency_key_sha256)
    || !SHA256.test(receipt.operator_request_sha256)
    || !SHA256.test(receipt.principal_id_sha256)
    || !SHA256.test(receipt.capability_sha256)
    || !SHA256.test(receipt.capability_jti_sha256)
    || !SHA256.test(receipt.test_run_id_sha256)
    || !SHA256.test(receipt.cleanup_obligation_id_sha256)
    || !SHA256.test(receipt.operator_subject_sha256)
    || !SHA256.test(receipt.receipt_sha256)
    || receipt.receipt_sha256 !== canonicalRequestHash(principalProvisionReceiptCore(receipt))
  ) return null;
  return receipt;
}
