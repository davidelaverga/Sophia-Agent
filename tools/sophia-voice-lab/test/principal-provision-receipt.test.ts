import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MemoryVoiceLabLedger } from '../src/memory-ledger.js';
import type { PrincipalProvisionPreparation } from '../src/ledger.js';
import type { PrincipalProvisionReceiptCore } from '../src/principal-provision-receipt.js';
import { canonicalRequestHash, sha256 } from '../src/security.js';

const CALLER = 'system.principal-provision-operator';
const NOW = new Date('2026-08-24T12:00:00.000Z');

function preparation(): PrincipalProvisionPreparation {
  return {
    requestHash: sha256('principal-request'),
    idempotencyKeyHash: sha256('principal-idempotency'),
    principalHash: sha256('principal'),
    callerId: CALLER,
    issuedAt: NOW,
    testRunId: randomUUID(),
    cleanupObligationId: randomUUID(),
    capabilityJti: '1'.repeat(32),
    capabilityNonce: '2'.repeat(32),
    capabilityHash: '3'.repeat(64),
    providerExpiresAt: new Date(NOW.getTime() + 600_000),
    environment: 'production',
    expectedDeployment: { frontend: 'a'.repeat(40), backend: 'b'.repeat(40), voice: 'c'.repeat(40) },
    mcpBuild: 'd'.repeat(40),
    operatorSubjectHash: sha256(CALLER),
  };
}

function receiptFor(record: Awaited<ReturnType<MemoryVoiceLabLedger['claimPrincipalProvision']>>['record']) {
  const core: PrincipalProvisionReceiptCore = {
    schema: 'sophia_voice_lab_principal_provision_receipt_v1',
    ok: true,
    provisioned: true,
    idempotency_key_sha256: record.idempotencyKeyHash,
    operator_request_sha256: record.requestHash,
    principal_id_sha256: record.principalHash,
    capability_sha256: record.capabilityHash,
    capability_jti_sha256: sha256(record.capabilityJti),
    test_run_id_sha256: sha256(record.testRunId),
    cleanup_obligation_id_sha256: sha256(record.cleanupObligationId),
    environment: record.environment,
    frontend_build: record.expectedDeployment.frontend,
    mcp_build: record.mcpBuild,
    expected_deployment: record.expectedDeployment,
    frontend_attempts: 1,
    frontend_reconciled: false,
    auth_audit_id: record.authAuditId,
    audit_observed_at: record.auditObservedAt.toISOString(),
    operator_subject_sha256: record.operatorSubjectHash,
  };
  return { ...core, idempotent_replay: false, receipt_sha256: canonicalRequestHash(core) };
}

function redigest(receipt: Record<string, unknown>): Record<string, unknown> {
  const { idempotent_replay: _replay, receipt_sha256: _digest, ...core } = receipt;
  return { ...core, idempotent_replay: false, receipt_sha256: canonicalRequestHash(core) };
}

describe('strict durable principal provision receipt', () => {
  it.each([
    ['schema', (receipt: Record<string, unknown>) => ({ ...receipt, schema: 'foreign' })],
    ['idempotency key', (receipt: Record<string, unknown>) => ({ ...receipt, idempotency_key_sha256: '0'.repeat(64) })],
    ['request', (receipt: Record<string, unknown>) => ({ ...receipt, operator_request_sha256: '0'.repeat(64) })],
    ['principal', (receipt: Record<string, unknown>) => ({ ...receipt, principal_id_sha256: '0'.repeat(64) })],
    ['capability', (receipt: Record<string, unknown>) => ({ ...receipt, capability_sha256: '0'.repeat(64) })],
    ['capability JTI', (receipt: Record<string, unknown>) => ({ ...receipt, capability_jti_sha256: '0'.repeat(64) })],
    ['test run', (receipt: Record<string, unknown>) => ({ ...receipt, test_run_id_sha256: '0'.repeat(64) })],
    ['cleanup', (receipt: Record<string, unknown>) => ({ ...receipt, cleanup_obligation_id_sha256: '0'.repeat(64) })],
    ['environment', (receipt: Record<string, unknown>) => ({ ...receipt, environment: 'staging' })],
    ['frontend build', (receipt: Record<string, unknown>) => ({ ...receipt, frontend_build: 'e'.repeat(40) })],
    ['MCP build', (receipt: Record<string, unknown>) => ({ ...receipt, mcp_build: 'e'.repeat(40) })],
    ['deployment', (receipt: Record<string, unknown>) => ({ ...receipt, expected_deployment: { frontend: 'e'.repeat(40), backend: 'b'.repeat(40), voice: 'c'.repeat(40) } })],
    ['attempt relation', (receipt: Record<string, unknown>) => ({ ...receipt, frontend_attempts: 0, frontend_reconciled: false })],
    ['audit identity', (receipt: Record<string, unknown>) => ({ ...receipt, auth_audit_id: '2' })],
    ['audit time', (receipt: Record<string, unknown>) => ({ ...receipt, audit_observed_at: '2026-08-24T12:00:01.000Z' })],
    ['operator', (receipt: Record<string, unknown>) => ({ ...receipt, operator_subject_sha256: '0'.repeat(64) })],
  ])('rejects a self-consistent %s drift before completing the control row', async (_label, drift) => {
    const ledger = new MemoryVoiceLabLedger('test');
    const owner = randomUUID();
    const claim = await ledger.claimPrincipalProvision(preparation(), owner, 30, NOW);
    const receipt = redigest(drift(receiptFor(claim.record) as unknown as Record<string, unknown>));
    await expect(ledger.finalizePrincipalProvision(claim.record.requestHash, owner, receipt, {
      id: claim.record.authAuditId,
      runId: null,
      callerId: CALLER,
      action: 'principal.provision',
      capabilityJtiHash: receipt.capability_jti_sha256 as string,
      argumentHash: claim.record.requestHash,
      outcome: 'allowed',
      detail: receipt,
      observedAt: claim.record.auditObservedAt,
    }, NOW)).rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_RECEIPT_INVALID' } });
    await expect(ledger.getPrincipalProvisionReadiness(NOW)).resolves.toEqual({ status: 'prepared' });
  });

  it('rejects a bad self-hash and completes only an exact receipt/audit pair', async () => {
    const ledger = new MemoryVoiceLabLedger('test');
    const owner = randomUUID();
    const claim = await ledger.claimPrincipalProvision(preparation(), owner, 30, NOW);
    const receipt = receiptFor(claim.record);
    const audit = {
      id: claim.record.authAuditId,
      runId: null,
      callerId: CALLER,
      action: 'principal.provision',
      capabilityJtiHash: receipt.capability_jti_sha256,
      argumentHash: claim.record.requestHash,
      outcome: 'allowed' as const,
      detail: receipt,
      observedAt: claim.record.auditObservedAt,
    };
    await expect(ledger.finalizePrincipalProvision(claim.record.requestHash, owner, {
      ...receipt,
      receipt_sha256: '0'.repeat(64),
    }, audit, NOW)).rejects.toMatchObject({ detail: { code: 'PRINCIPAL_PROVISION_RECEIPT_INVALID' } });
    await ledger.finalizePrincipalProvision(claim.record.requestHash, owner, receipt, audit, NOW);
    await expect(ledger.getPrincipalProvisionReadiness(NOW)).resolves.toEqual({ status: 'completed' });
  });
});
