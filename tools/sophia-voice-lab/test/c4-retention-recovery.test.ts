import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

// C4 release-blocking regressions. Content expiry must not settle resources.
// Keep these ordinary assertions: do not skip/xfail them to certify the release.
describe("C4 recovery survives content retention", () => {
  it("does not erase a contradictory outstanding lease even when a cached cleanup flag is true", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const now = new Date();
    const run = testRun({ state: "completed", cleanupComplete: true, retentionPurgeDueAt: new Date(now.getTime() - 1), retentionPurgeVerifiedAt: now });
    await ledger.createRunWithOperation(run, {
      id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start",
      idempotencyKey: randomUUID(), requestHash: sha256("contradictory-lease"), input: {},
    }, { global: 1, caller: 1 });
    const lease = await ledger.upsertBrowserLease(run.id, "unsettled-worker", 60);
    expect((await ledger.listRunsNeedingRecovery(10)).map((item) => item.id)).toContain(run.id);
    expect(await ledger.countActiveRuns()).toBe(1);
    expect(await ledger.countActiveRuns(run.callerId)).toBe(1);
    const replacement = testRun();
    await expect(ledger.createRunWithOperation(replacement, { id: randomUUID(), runId: replacement.id, callerId: replacement.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(replacement.id), input: {} }, { global: 1, caller: 1 })).rejects.toMatchObject({ detail: { code: "CONCURRENCY_LIMIT" } });
    await ledger.purgeExpiredRetention(now, 10);
    expect(await ledger.getBrowserLease(run.id)).toEqual(lease);
    expect(await ledger.countActiveRuns(run.callerId)).toBe(1);
    expect(await ledger.listRecoveryControls(10)).toHaveLength(1);
    const copy = (await ledger.listRecoveryControls(10))[0]!;
    copy.binding.principalId = "mutated";
    expect((await ledger.listRecoveryControls(10))[0]!.binding.principalId).toBe(run.principalId);
  });

  it.each(["failed_harness", "aborted_driver_restart", "expired"] as const)(
    "preserves an unresolved %s allocation while deleting retained content",
    async (state) => {
      const ledger = new MemoryVoiceLabLedger("test");
      const now = new Date();
      const run = testRun({ state, cleanupComplete: false, retentionPurgeDueAt: new Date(now.getTime() - 1), retentionPurgePending: true });
      await ledger.createRunWithOperation(run, {
        id: randomUUID(), runId: run.id, callerId: run.callerId,
        type: "start", idempotencyKey: randomUUID(), requestHash: sha256("retention-recovery-start"), input: {},
      }, { global: 1, caller: 1 });
      const lease = await ledger.upsertBrowserLease(run.id, "lost-worker", 60);
      await ledger.appendEvent(run.id, "transcript.input.final", "product", { text: "must expire" });
      const artifactId = randomUUID();
      const bytes = Buffer.from("must expire");
      await ledger.saveArtifact({ id: artifactId, runId: run.id, kind: "transcript", contentType: "text/plain", bytes, sha256: sha256(bytes), createdAt: now });
      expect(await ledger.countActiveRuns()).toBe(1);
      expect((await ledger.listRunsNeedingRecovery(10)).map((item) => item.id)).toContain(run.id);

      await ledger.purgeExpiredRetention(now, 10);

      expect(await ledger.getArtifact(artifactId)).toBeNull();
      expect(await ledger.getRun(run.id)).toBeNull();
      const controls = await ledger.listRecoveryControls(10);
      expect(controls).toContainEqual(expect.objectContaining({ binding: expect.objectContaining({ cleanupObligationId: run.cleanupObligationId }), liveCleanupComplete: false, contentPurgedAt: now }));
      expect(JSON.stringify(controls)).not.toContain("must expire");
      const replacement = testRun();
      await expect(ledger.createRunWithOperation(replacement, {
        id: randomUUID(), runId: replacement.id, callerId: replacement.callerId,
        type: "start", idempotencyKey: randomUUID(), requestHash: sha256("replacement"), input: {},
      }, { global: 1, caller: 1 })).rejects.toMatchObject({ detail: { code: "CONCURRENCY_LIMIT" } });
      expect.soft(await ledger.countActiveRuns(), "expiry is not authoritative resource settlement").toBe(1);
      expect.soft(await ledger.getBrowserLease(run.id), "the exact unsettled lease must remain discoverable").toEqual(lease);
      expect.soft((await ledger.listRecoveryControls(10)).map((item) => item.binding.cleanupObligationId), "the worker's content-independent recovery inventory must survive transcript deletion").toContain(run.cleanupObligationId);
    },
  );

  it("keeps remote retention recovery discoverable after a local hard purge", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const now = new Date();
    const run = testRun({ state: "completed", cleanupComplete: true, retentionPurgeDueAt: new Date(now.getTime() - 1), retentionPurgePending: true });
    await ledger.createRunWithOperation(run, {
      id: randomUUID(), runId: run.id, callerId: run.callerId,
      type: "start", idempotencyKey: randomUUID(), requestHash: sha256("retention-remote-start"), input: {},
    }, { global: 1, caller: 1 });
    expect((await ledger.listRunsRetentionDue(now, 10)).map((item) => item.id)).toContain(run.id);
    await ledger.purgeExpiredRetention(now, 10);
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "unconfirmed" });
    expect(await ledger.listRecoveryControls(10)).toContainEqual(expect.objectContaining({ binding: expect.objectContaining({ cleanupObligationId: run.cleanupObligationId }), liveCleanupComplete: true, remotePurgeComplete: false, contentPurgedAt: now }));
    expect((await ledger.listRecoveryControls(10)).map((item) => item.binding.cleanupObligationId)).toContain(run.cleanupObligationId);
  });
});
