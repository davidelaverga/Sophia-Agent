import { afterEach, expect, it, vi } from "vitest";

import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { deriveRecoveryBrowserBinding } from "../src/recovery-control.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";
import { recoveryAttemptAuditHash } from "../src/retained-d02-recovery.js";
import { derivePlatformExecutionTermination, PLATFORM_EXECUTION_TERMINATION_KIND } from "../src/platform-execution-termination.js";
import { verifyServiceOwnerFence } from "../src/service-owner-fence.js";
import { renderInventoryInstanceId } from "../src/worker-identity.js";
import { testRun } from "./helpers.js";
import { signedV2FenceReceipt } from "./service-owner-fence-fixture.js";
import type { RunRecord } from "../src/domain.js";

afterEach(() => { vi.useRealTimers(); });

const SERVICE_ID = "srv-0123456789abcdefghij";
const OWNER_ID = `${SERVICE_ID}-65566bc6c7-2gj6p`;

/** Seed the real obligation through actual ledger APIs only. */
async function seedRealObligation() {
  const ledger = new MemoryVoiceLabLedger("test");
  const run: RunRecord = testRun();
  await ledger.createRunWithOperation(run, {
    id: crypto.randomUUID(), runId: run.id, callerId: run.callerId, type: "start_voice_run",
    idempotencyKey: crypto.randomUUID(), requestHash: sha256("request"), input: {},
  } as never, { global: 10, caller: 10 });

  // Real lease reservation creates the durable allocation binding.
  const lease = await ledger.upsertBrowserLease(run.id, OWNER_ID, 600);
  expect(lease.leaseEpoch).toBe(1);
  // bindRecoveryBrowserContext is the V-D02 driver attestation and is
  // deliberately NOT used here: upsertBrowserLease already created this
  // obligation's durable allocation binding.
  expect((await ledger.getRecoveryControl(run.id))!.browserAllocationBinding)
    .toEqual(deriveRecoveryBrowserBinding(run.id, OWNER_ID, lease.leaseEpoch));

  // Real acquisition events, appended through the ledger under test.
  const acquired = await ledger.appendEvent(run.id, "harness.browser_process_acquired", "browser", {
    schema: "sophia_voice_lab_browser_process_ownership_v1", voice_lab_run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), process_id_sha256: "a".repeat(64),
    browser_boot_id_sha256: "b".repeat(64), execution_epoch_sha256: "c".repeat(64),
    one_process_per_run: true, raw_process_id_excluded: true });
  const runtime = await ledger.appendEvent(run.id, "harness.browser_runtime_acquired", "canonical", {
    worker_id_sha256: sha256(OWNER_ID), browser_lease_epoch: lease.leaseEpoch });

  const owned = await ledger.preserveRecoveryExecutionOwnership(run.id);
  expect(owned.executionOwnership!.executionEpochSha256).toBe("c".repeat(64));
  expect(owned.executionOwnership!.processAcquiredSeq).toBe(acquired.seq);
  expect(owned.executionOwnership!.runtimeAcquiredSeq).toBe(runtime.seq);
  return { ledger, run, lease, ownership: owned.executionOwnership! };
}

/** Gateway-authored recovery receipt: external product transport, validated by
 * the real evaluator and the real retained-recovery derivation. */
function gatewayRecoveryReceipt(run: RunRecord, attempt: ReturnType<typeof recoveryAttemptIdentity>) {
  const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 };
  return { complete: true, http_status: 200, receipt: { complete: true, live_cleanup_complete: true, live_resources_zero: true,
    test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    recovery_id: attempt.recoveryId, attempt_id: attempt.attemptId, attempt_issued_at: attempt.issuedAt,
    recovered_at: new Date(attempt.issuedAt * 1000 + 500).toISOString(),
    // Durable export object the settlement binds to.
    receipt: { storage: "voice-lab-evidence", object_path: `runs/${run.id}/recovery.json`, sha256: sha256("export") },
    components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, builder, auth_sessions: { status: "completed" } } } };
}

async function ingestFence(ledger: MemoryVoiceLabLedger, run: RunRecord, ownership: unknown) {
  // Real dispatch prepare/consume through the ledger under test.
  let control = (await ledger.getRecoveryControl(run.id))!;
  control = await ledger.prepareGenericOwnerDispatch({ runId: run.id, expectedVersion: control.version,
    requestId: run.id, workerServiceId: SERVICE_ID } as never);
  const consumed = await ledger.consumeGenericOwnerDispatch({ runId: run.id, expectedVersion: control.version,
    preparedProofSha256: control.genericOwnerDispatch!.proofSha256 } as never);
  control = consumed.control ?? consumed;
  const actionRequestedAt = new Date(control.genericOwnerDispatch!.consumedAt!);
  // The receipt's causal window requires >=360s between acceptance and the
  // post-action observation; advance the clock rather than weaken the bound.
  vi.setSystemTime(new Date(actionRequestedAt.getTime() + 362_000));
  const signed = signedV2FenceReceipt({ control, ownership: ownership as never, allocatedWorkerId: OWNER_ID, serviceId: SERVICE_ID, actionRequestedAt });
  const result = await ledger.persistGenericOwnerLoss({ runId: run.id, expectedVersion: control.version,
    receipt: signed.receipt, authority: signed.authority, expectedWorkerServiceIdSha256: sha256(SERVICE_ID),
    expectedRecoveryDeployment: signed.expectedRecoveryDeployment, expectedLabSha: signed.expectedLabSha,
    expectedLangGraphSha: signed.expectedLangGraphSha } as never);
  const persisted = (await ledger.getRecoveryControl(run.id))!;
  const termination = derivePlatformExecutionTermination(persisted, persisted.genericOwnerLoss as never);
  const event = await ledger.appendEvent(run.id, PLATFORM_EXECUTION_TERMINATION_KIND, "canonical", termination.payload, termination.dedupeKey);
  return { result, signed, termination, event, verify: verifyServiceOwnerFence };
}

it("releases the lease and preserves the proof only through the real recovery chain", async () => {
  const { ledger, run, lease, ownership } = await seedRealObligation();
  expect(renderInventoryInstanceId(OWNER_ID)).toBe(`${SERVICE_ID}-2gj6p`);

  // No browser close can ever exist for this epoch.
  await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).rejects.toThrow(/Exact execution ownership and cleanup are not proven/);

  const { event: termination } = await ingestFence(ledger, run, ownership);
  expect(termination.kind).toBe(PLATFORM_EXECUTION_TERMINATION_KIND);

  // Owner loss alone must not let the proof be preserved.
  await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).rejects.toThrow(/Exact execution ownership and cleanup are not proven/);

  const attempt = recoveryAttemptIdentity({ cleanup_obligation_id: run.cleanupObligationId,
    jti: "1".repeat(32), nonce: "2".repeat(32), iat: Math.ceil(Date.now() / 1000) + 1 });
  // The Gateway recovery is observed after the attempt was issued.
  vi.setSystemTime(new Date(attempt.issuedAt * 1000 + 2_000));
  const canonicalEvent = await ledger.appendEvent(run.id, "cleanup.recovery", "canonical", gatewayRecoveryReceipt(run, attempt));

  // Now the real evaluator settles, and the proof becomes preservable.
  const preserved = await ledger.preserveRecoveryExecutionCleanup(run.id);
  expect(preserved.executionCleanupProof!.ready).toBe(true);
  expect(preserved.executionCleanupProof!.reason).toBe("authoritative_platform_fence_after_owner_loss");
  expect(preserved.executionCleanupProof!.eventSeqs.processClosed).toBeNull();
  expect(preserved.executionCleanupProof!.eventSeqs.platformTerminated).toBe(termination.seq);

  // Exact retry is immutable.
  expect(canonicalRequestHash((await ledger.preserveRecoveryExecutionCleanup(run.id)).executionCleanupProof!))
    .toBe(canonicalRequestHash(preserved.executionCleanupProof!));

  // Durable export revision, then content purge deletes events but not the proof.
  const exported = await ledger.appendEvent(run.id, "evidence.publication_revision", "worker",
    { publication_revision_sha256: sha256("revision"), purpose: "recovery" }, `evidence:${run.id}:publication:recovery`);
  expect(await ledger.appendEvent(run.id, "evidence.publication_revision", "worker",
    { publication_revision_sha256: sha256("revision"), purpose: "recovery" }, `evidence:${run.id}:publication:recovery`))
    .toMatchObject({ seq: exported.seq });

  const terminal = (await ledger.getRun(run.id))!;
  await ledger.updateRun(run.id, terminal.version, { state: "product_failed", retentionPurgeDueAt: new Date(Date.now() - 1000) } as never);
  expect(await ledger.purgeExpiredRetention(new Date(), 10)).toContain(run.id);
  const purged = (await ledger.getRecoveryControl(run.id))!;
  expect(purged.contentPurgedAt).not.toBeNull();
  expect(canonicalRequestHash(purged.executionCleanupProof!)).toBe(canonicalRequestHash(preserved.executionCleanupProof!));

  // Exact lease CAS release through settlement.
  expect(await ledger.getBrowserLease(run.id)).not.toBeNull();
  await ledger.recordRecoveryCapabilityAudit(run.id, purged.version, sha256("jti"),
    recoveryAttemptAuditHash(purged, attempt));
  const audited = (await ledger.getRecoveryControl(run.id))!;
  const settled = await ledger.settleRecoveryControl(run.id, audited.version, canonicalEvent, attempt);
  expect(settled.liveCleanupComplete).toBe(true);
  expect(settled.genericRecoverySettlement).toBeDefined();
  expect(await ledger.getBrowserLease(run.id)).toBeNull();

  // Exact retry stays immutable and releases nothing further.
  const again = await ledger.settleRecoveryControl(run.id, audited.version, canonicalEvent, attempt);
  expect(canonicalRequestHash(again)).toBe(canonicalRequestHash(settled));
});

it("cannot release on a wrong epoch or without downstream cleanup", async () => {
  const { ledger, run, ownership } = await seedRealObligation();
  await ingestFence(ledger, run, ownership);

  // Missing downstream cleanup: no preserved proof, so settlement is refused.
  const control = (await ledger.getRecoveryControl(run.id))!;
  await expect(ledger.settleRecoveryControl(run.id, control.version, { kind: "cleanup.recovery" }, undefined as never)).rejects.toThrow();
  expect(await ledger.getBrowserLease(run.id)).not.toBeNull();

  // A termination for a different execution epoch never settles this one.
  const persisted = (await ledger.getRecoveryControl(run.id))!;
  const termination = derivePlatformExecutionTermination(persisted, persisted.genericOwnerLoss as never);
  await ledger.appendEvent(run.id, PLATFORM_EXECUTION_TERMINATION_KIND, "canonical",
    { ...termination.payload, execution_epoch_sha256: "f".repeat(64) }, `${termination.dedupeKey}:other`);
  await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).rejects.toThrow(/Exact execution ownership and cleanup are not proven/);
  expect(await ledger.getBrowserLease(run.id)).not.toBeNull();
});
