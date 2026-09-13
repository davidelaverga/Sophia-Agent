import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { deriveExecutionOwnership, parseExecutionOwnership } from "../src/execution-ownership.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";

describe("independent execution ownership", () => {
  it("rejects sequence collisions outside the selected acquisition pair", () => {
    const run = testRun();
    const events = completeExecutionCleanupFixture(run, "owner", 1).slice(0, 2);
    expect(deriveExecutionOwnership(run, events)).toBeDefined();
    const collision = { ...events[0]!, kind: "harness.startup_stage", source: "worker" as const };
    expect(() => deriveExecutionOwnership(run, [...events, collision])).toThrow("Execution ownership event sequence invalid");
  });

  it.each([0, 1])("rejects a foreign event envelope at acquisition index %i", index => {
    const run = testRun();
    const events = completeExecutionCleanupFixture(run, "owner", 1).slice(0, 2);
    expect(deriveExecutionOwnership(run, events)).toBeDefined();
    const transplanted = events.map((event, i) => i === index ? { ...event, runId: randomUUID() } : event);
    expect(() => deriveExecutionOwnership(run, transplanted)).toThrow("Execution ownership event run binding mismatch");
  });

  it("retains exact ownership after content deletion without claiming process death", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(0) });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
    const lease = await ledger.upsertBrowserLease(run.id, "lost-owner", 60);
    await expect(ledger.preserveRecoveryExecutionOwnership(run.id)).rejects.toThrow();
    for (const event of completeExecutionCleanupFixture(run, lease.workerId, lease.leaseEpoch).slice(0, 2)) await ledger.appendEvent(run.id, event.kind, event.source, { ...event.payload, transcript: "MUST_EXPIRE" });
    const saved = await ledger.preserveRecoveryExecutionOwnership(run.id);
    await ledger.reapExpiredBrowserLeases(new Date(lease.expiresAt.getTime() + 1));
    expect(await ledger.preserveRecoveryExecutionOwnership(run.id)).toEqual(saved);
    // Explicit removal still invalidates a new lease-bound write; expiry alone
    // preserves the immutable historical receipt rather than deleting it.
    await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
    await expect(ledger.preserveRecoveryExecutionOwnership(run.id)).rejects.toMatchObject({ detail: { code: "RECOVERY_LEASE_MISMATCH" } });
    await ledger.purgeExpiredRetention(new Date(), 10);
    const retained = await ledger.getRecoveryControl(run.id);
    expect(retained?.executionOwnership).toEqual(saved.executionOwnership);
    expect(retained?.executionCleanupProof).toBeUndefined();
    expect(retained?.liveCleanupComplete).toBe(false);
    expect(await ledger.countActiveRuns()).toBe(1);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(JSON.stringify(retained)).not.toMatch(/MUST_EXPIRE|lost-owner/);
  });

  it("rejects foreign, duplicate, reordered and tampered ownership", () => {
    const run = testRun();
    const events = completeExecutionCleanupFixture(run, "owner", 1).slice(0, 2).map((event, i) => ({ ...event, runId: run.id, seq: i + 1, at: new Date() }));
    const saved = deriveExecutionOwnership(run, events);
    expect(parseExecutionOwnership(saved)).toEqual(saved);
    expect(() => deriveExecutionOwnership({ ...run, id: randomUUID() }, events)).toThrow();
    expect(() => deriveExecutionOwnership(run, [...events, events[0]!])).toThrow();
    expect(() => deriveExecutionOwnership(run, events.map(e => ({ ...e, seq: 3 - e.seq })))).toThrow();
    expect(() => parseExecutionOwnership({ ...saved, workerIdSha256: "f".repeat(64) })).toThrow();
    expect(() => parseExecutionOwnership({ ...saved, transcript: "forbidden" })).toThrow();
  });
});
