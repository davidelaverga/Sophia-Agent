import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { VoiceLabLedger } from "../src/ledger.js";
import { sha256 } from "../src/security.js";
import { labError } from "../src/domain.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";

export async function verifyPreservedExecutionCleanup(ledger: VoiceLabLedger) {
  const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(0) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const lease = await ledger.upsertBrowserLease(run.id, "execution-proof-owner", 60);
  const reserved = (await ledger.getRecoveryControl(run.id))!.browserAllocationBinding;
  expect(reserved).toBeDefined();
  const events = completeExecutionCleanupFixture(run, lease.workerId, lease.leaseEpoch);
  for (const event of events.slice(0, -1)) await ledger.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey ?? undefined);
  const owned = await ledger.preserveRecoveryExecutionOwnership(run.id);
  expect(owned.executionOwnership).toMatchObject({ workerIdSha256: sha256(lease.workerId), browserLeaseEpoch: lease.leaseEpoch });
  expect(await ledger.preserveRecoveryExecutionOwnership(run.id)).toEqual(owned);
  expect(await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
  await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).rejects.toMatchObject({ detail: { code: "RECOVERY_EXECUTION_PROOF_UNCONFIRMED" } });
  expect((await ledger.getRecoveryControl(run.id))?.executionCleanupProof).toBeUndefined();
  const death = events.at(-1)!;
  await ledger.appendEvent(run.id, death.kind, death.source, { ...death.payload, irrelevant_content: "MUST_NOT_RETAIN" }, death.dedupeKey ?? undefined);
  const saved = await ledger.preserveRecoveryExecutionCleanup(run.id);
  expect(saved.executionCleanupProof).toMatchObject({ required: true, ready: true, workerIdSha256: sha256(lease.workerId), browserLeaseEpoch: lease.leaseEpoch });
  expect(await ledger.preserveRecoveryExecutionCleanup(run.id)).toEqual(saved);
  expect(JSON.stringify(saved)).not.toMatch(/MUST_NOT_RETAIN|execution-proof-owner/);
  // This fixture simulates receipts only: it never starts external resources.
  const fresh = (await ledger.getRun(run.id))!;
  await ledger.updateRun(run.id, fresh.version, { cleanupComplete: true });
  await ledger.purgeExpiredRetention(new Date(), 10);
  expect(await ledger.getRun(run.id)).toBeNull();
  expect((await ledger.getRecoveryControl(run.id))?.executionCleanupProof).toEqual(saved.executionCleanupProof);
  expect((await ledger.getRecoveryControl(run.id))?.executionOwnership).toEqual(owned.executionOwnership);
  expect((await ledger.getRecoveryControl(run.id))?.browserAllocationBinding).toEqual(reserved);
  await expect(ledger.preserveRecoveryExecutionOwnership(run.id)).rejects.toMatchObject({ detail: { code: "RECOVERY_OWNERSHIP_UNAVAILABLE" } });
  await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).rejects.toMatchObject({ detail: { code: "RECOVERY_EXECUTION_PROOF_UNAVAILABLE" } });
  expect(await ledger.countActiveRuns()).toBe(0);
  await verifyReleasedLeaseOwnerFence(ledger);
}

async function verifyReleasedLeaseOwnerFence(ledger: VoiceLabLedger) {
  for (const drift of ["worker", "lease_epoch"] as const) {
    const run = testRun({ state: "failed_harness" });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 100, caller: 100 });
    await ledger.cancelPendingRunOperations(run.id, null, labError("TEST_FIXTURE_COMPLETE", "Ledger-only ownership test does not dispatch a start.", "harness"));
    const lease = await ledger.upsertBrowserLease(run.id, "reserved-execution-owner", 60);
    expect(await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
    const before = await ledger.getRecoveryControl(run.id);
    const events = completeExecutionCleanupFixture(run, drift === "worker" ? "different-owner" : lease.workerId, drift === "lease_epoch" ? lease.leaseEpoch + 1 : lease.leaseEpoch);
    for (const event of events) await ledger.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey ?? undefined);
    await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).rejects.toMatchObject({ detail: { code: "RECOVERY_EXECUTION_PROOF_UNCONFIRMED" } });
    expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
    // Fixture teardown only: these negative runs never launch resources.
    const fresh = (await ledger.getRun(run.id))!;
    await ledger.updateRun(run.id, fresh.version, { cleanupComplete: true });
  }
}
