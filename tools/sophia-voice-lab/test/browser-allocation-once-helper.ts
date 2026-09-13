import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { VoiceLabLedger } from "../src/ledger.js";
import { labError } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { deriveRecoveryBrowserBinding } from "../src/recovery-control.js";

export async function verifyBrowserAllocationOnce(ledger: VoiceLabLedger) {
  for (const scenarioId of ["V-A01", "V-N01", "V-D02"] as const) {
    for (const removal of ["release", "reap"] as const) {
      // Synthetic ledger-only fixture; never allocates an external process.
      const run = testRun({ scenarioId, state: "completed", cleanupComplete: true });
      await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 50, caller: 50 });
      await ledger.cancelPendingRunOperations(run.id, null, labError("SYNTHETIC_FIXTURE_COMPLETE", "Ledger-only fixture has no executable operation.", "harness"));
      const lease = await ledger.upsertBrowserLease(run.id, "original-owner", removal === "reap" ? 0 : 60);
      const reserved = await ledger.getRecoveryControl(run.id);
      expect(reserved?.browserAllocationBinding).toEqual(deriveRecoveryBrowserBinding(run.id, lease.workerId, lease.leaseEpoch));
      expect(reserved?.browserContextBinding).toBeUndefined();
      expect(reserved?.executionOwnership).toBeUndefined();
      expect(reserved?.executionCleanupProof).toBeUndefined();
      if (scenarioId !== "V-D02") {
        await expect(ledger.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, reserved!.browserAllocationBinding)).rejects.toThrow();
        expect(await ledger.getRecoveryControl(run.id)).toEqual(reserved);
      }
      if (removal === "release") await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
      else await ledger.reapExpiredBrowserLeases(new Date(lease.expiresAt.getTime() + 1));
      const control = await ledger.getRecoveryControl(run.id);
      expect(await ledger.getBrowserLease(run.id)).toEqual(removal === "reap" ? lease : null);
      for (const owner of ["original-owner", "replacement-owner"]) {
        // A retained foreign lease can additionally trip the existing ownership
        // fence when database/host clocks differ. Neither rejection may mutate
        // allocation history or the receipt.
        await expect(ledger.upsertBrowserLease(run.id, owner, 60)).rejects.toMatchObject({ detail: { code: owner === "original-owner" || removal === "release" ? "BROWSER_ALLOCATION_ALREADY_RESERVED" : expect.stringMatching(/^(BROWSER_ALLOCATION_ALREADY_RESERVED|BROWSER_ALREADY_LEASED)$/) } });
        expect(await ledger.getBrowserLease(run.id)).toEqual(removal === "reap" ? lease : null);
        expect(await ledger.getRecoveryControl(run.id)).toEqual(control);
      }
      // Ledger-only fixture teardown: no real browser/process was allocated.
      if (removal === "reap") expect(await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
    }
  }
}
