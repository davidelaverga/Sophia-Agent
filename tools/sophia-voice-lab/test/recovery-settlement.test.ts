import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";

async function fixture(withExecutionProof = true) {
  const ledger = new MemoryVoiceLabLedger("test");
  const now = new Date();
  const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(now.getTime() - 1), retentionPurgePending: true });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256("settlement"), input: {} }, { global: 1, caller: 1 });
  const lease = await ledger.upsertBrowserLease(run.id, "original-worker", 60);
  if (withExecutionProof) {
    for (const event of completeExecutionCleanupFixture(run, lease.workerId, lease.leaseEpoch)) await ledger.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey ?? undefined);
    await ledger.preserveRecoveryExecutionCleanup(run.id);
  }
  await ledger.purgeExpiredRetention(now, 10);
  const control = (await ledger.getRecoveryControl(run.id))!;
  const event = {
    kind: "cleanup.recovery", source: "canonical", payload: {
      http_status: 200, complete: true, retention_purged: true,
      receipt: {
        test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
        complete: true, live_cleanup_complete: true, live_resources_zero: true,
        retention_purged: true, retention_purge_pending: false, retention_maintenance_complete: true,
        components: {
          canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" },
          builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 },
        },
        receipt: { storage: "postgres", object_path: "synthetic/receipt", sha256: "a".repeat(64) },
        extra_content: "MUST_NOT_BE_RETAINED",
      },
    },
  };
  return { ledger, run, lease, control, event };
}

describe("post-retention recovery settlement CAS", () => {
  it("does not accept lease deletion as process-death proof after retention", async () => {
    const { ledger, run, lease, control, event } = await fixture(false);
    await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
    await expect(ledger.settleRecoveryControl(run.id, control.version, event)).rejects.toMatchObject({ detail: { code: "RECOVERY_EXECUTION_UNCONFIRMED" } });
    expect((await ledger.getRecoveryControl(run.id))?.liveCleanupComplete).toBe(false);
  });
  it.each(["completed", "already_terminal", "not_found"])("requires lease release and exact durable zero for %s, then settles once", async (status) => {
    const { ledger, run, lease, control, event } = await fixture();
    event.payload.receipt.components.canonical_session.status = status;
    event.payload.receipt.components.voice_provider.status = status;
    event.payload.receipt.components.auth_sessions.status = status;
    await expect(ledger.settleRecoveryControl(run.id, control.version, event)).rejects.toMatchObject({ detail: { code: "RECOVERY_BROWSER_UNSETTLED" } });
    expect(await ledger.releaseBrowserLease(run.id, "foreign-worker", lease.leaseEpoch)).toBe(false);
    expect(await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
    const result = await ledger.settleRecoveryControl(run.id, control.version, event);
    expect(result).toMatchObject({ version: control.version + 1, liveCleanupComplete: true, remotePurgeComplete: true });
    expect(await ledger.settleRecoveryControl(run.id, control.version, event)).toEqual(result);
    expect(await ledger.countActiveRuns()).toBe(0);
    expect(await ledger.listRecoveryControls(10)).toEqual([]);
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "confirmed" });
    expect(await ledger.getRun(run.id)).toBeNull();
    await expect(ledger.upsertBrowserLease(run.id, "replacement", 60)).rejects.toMatchObject({ detail: { code: "RUN_NOT_FOUND" } });
    expect(await ledger.listArtifacts(run.id)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_BE_RETAINED");
  });

  it("rejects stale non-identical settlement instead of overwriting a newer revision", async () => {
    const { ledger, run, lease, control, event } = await fixture();
    await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
    const settled = await ledger.settleRecoveryControl(run.id, control.version, event);
    event.payload.receipt.receipt.sha256 = "b".repeat(64);
    await expect(ledger.settleRecoveryControl(run.id, control.version, event)).rejects.toMatchObject({ detail: { code: "RECOVERY_VERSION_CONFLICT" } });
    expect(await ledger.getRecoveryControl(run.id)).toEqual(settled);
  });

  it("retains remote-purge work after live zero, then settles it without reopening live allocation", async () => {
    const { ledger, run, lease, control, event } = await fixture();
    await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
    event.payload.retention_purged = false;
    event.payload.receipt.retention_purged = false;
    event.payload.receipt.retention_purge_pending = true;
    event.payload.receipt.retention_maintenance_complete = false;
    const live = await ledger.settleRecoveryControl(run.id, control.version, event);
    expect(live).toMatchObject({ liveCleanupComplete: true, remotePurgeComplete: false });
    expect(await ledger.countActiveRuns()).toBe(0);
    expect(await ledger.listRecoveryControls(10)).toHaveLength(1);
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "unconfirmed" });
    event.payload.retention_purged = true;
    event.payload.receipt.retention_purged = true;
    event.payload.receipt.retention_purge_pending = false;
    event.payload.receipt.retention_maintenance_complete = true;
    await ledger.settleRecoveryControl(run.id, live.version, event);
    expect(await ledger.listRecoveryControls(10)).toEqual([]);
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "confirmed" });
  });

  it.each(["wrong-run", "wrong-obligation", "wrong-source", "provider-pending", "builder-unknown", "missing-durable-receipt"])("rejects %s proof without settlement", async (fault) => {
    const { ledger, run, lease, control, event } = await fixture();
    await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
    if (fault === "wrong-run") event.payload.receipt.test_run_id = randomUUID();
    if (fault === "wrong-obligation") event.payload.receipt.cleanup_obligation_id_sha256 = "b".repeat(64);
    if (fault === "wrong-source") event.source = "worker";
    if (fault === "provider-pending") event.payload.receipt.components.voice_provider.status = "pending";
    if (fault === "builder-unknown") event.payload.receipt.components.builder.authoritative_zero_tasks = false;
    if (fault === "missing-durable-receipt") event.payload.receipt.receipt.sha256 = "";
    await expect(ledger.settleRecoveryControl(run.id, control.version, event)).rejects.toThrow();
    expect(await ledger.getRecoveryControl(run.id)).toEqual(control);
    expect(await ledger.countActiveRuns()).toBe(1);
  });
});
