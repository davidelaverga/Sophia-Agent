import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { validateRecoveryBrowserBinding } from "../src/recovery-control.js";
import { sha256 } from "../src/security.js";
import { deriveD02BrowserContextBinding } from "../src/worker.js";
import { testRun } from "./helpers.js";

async function fixture(leaseSeconds = 60) {
  const ledger = new MemoryVoiceLabLedger("test");
  const run = testRun({ scenarioId: "V-D02", state: "failed_harness", retentionPurgeDueAt: new Date(0) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const lease = await ledger.upsertBrowserLease(run.id, "original-worker", leaseSeconds);
  const binding = deriveD02BrowserContextBinding(run, lease.workerId, lease.leaseEpoch);
  return { ledger, run, lease, binding };
}

describe("durable D02 recovery browser ownership", () => {
  it("preserves pre-driver allocation intent through lease loss and content purge without fabricating attestation", async () => {
    const { ledger, run, lease, binding } = await fixture(0);
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ browserAllocationBinding: binding });
    expect((await ledger.getRecoveryControl(run.id))?.browserContextBinding).toBeUndefined();
    const lost = await ledger.reapExpiredBrowserLeases(new Date(lease.expiresAt.getTime() + 1));
    expect(lost).toEqual([lease]);
    await expect(ledger.upsertBrowserLease(run.id, "replacement-worker", 60)).rejects.toMatchObject({ detail: { code: "BROWSER_ALLOCATION_ALREADY_RESERVED" } });
    expect(await ledger.getBrowserLease(run.id)).toEqual(lease);
    await ledger.purgeExpiredRetention(new Date(), 10);
    const control = (await ledger.getRecoveryControl(run.id))!;
    expect(control.browserAllocationBinding).toEqual(binding);
    expect(control.browserContextBinding).toBeUndefined();
    expect(control.liveCleanupComplete).toBe(false);
    expect(await ledger.countActiveRuns()).toBe(1);
  });

  it("preserves the immutable driver-attested binding through content purge without raw worker identity", async () => {
    const { ledger, run, lease, binding } = await fixture();
    const saved = await ledger.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, binding);
    expect(await ledger.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, binding)).toEqual(saved);
    await ledger.appendEvent(run.id, "private", "product", { transcript: "PRIVATE_CONTENT" });
    await ledger.purgeExpiredRetention(new Date(), 10);
    expect(await ledger.getRun(run.id)).toBeNull();
    const control = (await ledger.getRecoveryControl(run.id))!;
    expect(control.browserContextBinding).toEqual(binding);
    expect(JSON.stringify(control)).not.toMatch(/original-worker|PRIVATE_CONTENT/);
    expect(validateRecoveryBrowserBinding(control.binding, control.browserContextBinding)).toEqual(binding);
    await expect(ledger.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, binding)).rejects.toMatchObject({ detail: { code: "RECOVERY_BINDING_UNAVAILABLE" } });
  });

  it.each(["voice_lab_run_id_sha256", "browser_worker_id_sha256", "browser_context_id_sha256", "browser_lease_epoch", "extra"])("rejects corrupted or unknown field %s", async field => {
    const { ledger, run, lease, binding } = await fixture();
    const changed = { ...binding, [field]: field === "browser_lease_epoch" ? 2 : "a".repeat(64) };
    await expect(ledger.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, changed)).rejects.toThrow();
    expect((await ledger.getRecoveryControl(run.id))?.browserContextBinding).toBeUndefined();
  });

  it("refuses a correctly derived foreign worker allocation against the current lease", async () => {
    const { ledger, run } = await fixture();
    const foreign = deriveD02BrowserContextBinding(run, "foreign-worker", 1);
    await expect(ledger.bindRecoveryBrowserContext(run.id, "foreign-worker", 1, foreign)).rejects.toMatchObject({ detail: { code: "RECOVERY_BINDING_CONFLICT" } });
  });

  it("never turns a D02 ownership binding into authority for another scenario", async () => {
    const { run, binding } = await fixture();
    expect(() => validateRecoveryBrowserBinding({ runId: run.id, scenarioId: "V-A01" }, binding)).toThrow();
  });
});
