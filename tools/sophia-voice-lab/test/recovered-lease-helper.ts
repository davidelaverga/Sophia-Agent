import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { VoiceLabLedger } from "../src/ledger.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture, recovery } from "./execution-cleanup-fixture.js";

export async function verifyRecoveredLeaseRelease(ledger: VoiceLabLedger) {
  for (const mode of ["recovered", "live_lease", "nonterminal", "d02", "missing_proof", "foreign_owner", "missing_death"] as const) {
    const run = testRun({ state: mode === "nonterminal" ? "active" : "failed_harness", ...(mode === "d02" ? { scenarioId: "V-D02" } : {}) });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 100, caller: 100 });
    const lease = await ledger.upsertBrowserLease(run.id, "old-process", mode === "live_lease" ? 60 : 0);
    const all = completeExecutionCleanupFixture(run, mode === "foreign_owner" ? "foreign-process" : lease.workerId, lease.leaseEpoch);
    // Simulate process death followed by a separately authoritative provider/auth recovery.
    const events = [all[0]!, all[1]!, ...(mode === "missing_death" ? [] : [all[4]!]), recovery(run, 6)];
    for (const e of events) await ledger.appendEvent(run.id, e.kind, e.source, e.payload, e.dedupeKey ?? undefined);
    expect(await ledger.releaseRecoveredBrowserLease(run.id)).toBe(false);
    if (mode !== "missing_proof" && mode !== "foreign_owner" && mode !== "missing_death") await ledger.preserveRecoveryExecutionCleanup(run.id);
    const released = await ledger.releaseRecoveredBrowserLease(run.id);
    expect(released).toBe(mode === "recovered");
    if (released) {
      expect(await ledger.getBrowserLease(run.id)).toBeNull();
      expect((await ledger.getRecoveryControl(run.id))?.executionCleanupProof?.ready).toBe(true);
      expect(await ledger.releaseRecoveredBrowserLease(run.id)).toBe(false);
    } else {
      expect(await ledger.getBrowserLease(run.id)).toEqual(lease);
    }
    // Ledger-only fixture teardown; no browser or provider was allocated.
    await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
    const fresh = (await ledger.getRun(run.id))!;
    await ledger.updateRun(run.id, fresh.version, { state: "failed_harness", cleanupComplete: true });
  }
}
