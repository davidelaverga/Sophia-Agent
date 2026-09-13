import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { validateRecoveryAllocationBinding, validateRecoveryBrowserBinding } from "../src/recovery-control.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { verifyBrowserAllocationOnce } from "./browser-allocation-once-helper.js";

it("never allocates a replacement execution after releasing or reaping the original lease", async () => {
  await verifyBrowserAllocationOnce(new MemoryVoiceLabLedger("test"));
});

it("retains generic reservation ownership after pre-acquisition crash and content purge without attesting a browser or cleanup", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const run = testRun({ scenarioId: "V-A01", state: "failed_harness", retentionPurgeDueAt: new Date(0) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const lease = await ledger.upsertBrowserLease(run.id, "lost-before-acquisition", 60);
  const reserved = (await ledger.getRecoveryControl(run.id))!;
  expect(validateRecoveryAllocationBinding(reserved.binding, reserved.browserAllocationBinding)).toEqual(reserved.browserAllocationBinding);
  expect(() => validateRecoveryBrowserBinding(reserved.binding, reserved.browserAllocationBinding)).toThrow();
  await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
  await ledger.purgeExpiredRetention(new Date(), 10);
  const retained = (await ledger.getRecoveryControl(run.id))!;
  expect(await ledger.getRun(run.id)).toBeNull();
  expect(retained.browserAllocationBinding).toEqual(reserved.browserAllocationBinding);
  expect(retained.executionOwnership).toBeUndefined();
  expect(retained.browserContextBinding).toBeUndefined();
  expect(retained.executionCleanupProof).toBeUndefined();
  expect(retained.liveCleanupComplete).toBe(false);
  expect(await ledger.countActiveRuns()).toBe(1);
  expect(JSON.stringify(retained)).not.toContain("lost-before-acquisition");
});
