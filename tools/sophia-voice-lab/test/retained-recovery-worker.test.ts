import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, it, expect, vi } from "vitest";
import type { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";

async function fixture(options: { d02?: boolean; allocated?: boolean; missingProof?: boolean; keepLease?: boolean; attemptDrift?: string } = {}) {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const run = testRun({ scenarioId: options.d02 ? "V-D02" : "V-A01", state: "failed_harness", retentionPurgeDueAt: new Date(0), retentionPurgePending: true });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  if (options.allocated || options.d02) {
    const lease = await ledger.upsertBrowserLease(run.id, "original-worker", 60);
    if (!options.missingProof) {
      for (const event of completeExecutionCleanupFixture(run, lease.workerId, lease.leaseEpoch)) await ledger.appendEvent(run.id, event.kind, event.source, event.payload);
      await ledger.preserveRecoveryExecutionCleanup(run.id);
    }
    if (!options.keepLease) await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
  }
  await ledger.purgeExpiredRetention(new Date(), 10);
  const control = (await ledger.getRecoveryControl(run.id))!;
  const audit = vi.spyOn(ledger, "recordRecoveryCapabilityAudit");
  const event = { kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, http_status: 200, retention_purged: true, receipt: {
    test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), complete: true, live_cleanup_complete: true, live_resources_zero: true,
    retention_purged: true, retention_purge_pending: false, retention_maintenance_complete: true,
    components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" }, builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } },
    receipt: { storage: "postgres", object_path: "synthetic/receipt", sha256: "a".repeat(64) },
  } } };
  const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
  const recover = vi.fn(async (binding, token: string) => {
    expect(audit).toHaveBeenCalledTimes(1);
    expect(binding).toEqual({ id: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, target: { gatewayUrl: run.target.gatewayUrl } });
    const d02 = options.d02 ? control.browserAllocationBinding : undefined;
    const claims = codec.verify(token, { audience: "sophia-voice-lab-recovery", operation: "session:recover", principalId: run.principalId, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, environment: run.environment, retentionHours: run.capturePolicy.retentionHours, providerExpiresAt: run.expiresAt.toISOString(), expectedDeployment: run.target.expectedDeployment, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion,
      ...(d02 ? { voiceLabRunIdSha256: d02.voice_lab_run_id_sha256, browserWorkerIdSha256: d02.browser_worker_id_sha256, browserLeaseEpoch: d02.browser_lease_epoch, browserContextIdSha256: d02.browser_context_id_sha256 } : {}) });
    expect(claims.allowed_ops).toEqual(["session:recover"]);
    const identity = recoveryAttemptIdentity(claims);
    Object.assign(event.payload.receipt, { recovery_id: identity.recoveryId, attempt_id: identity.attemptId,
      attempt_issued_at: identity.issuedAt, recovered_at: new Date().toISOString() },
    options.attemptDrift === "old_attempt" ? { attempt_id: sha256("old-attempt") } :
    options.attemptDrift === "wrong_recovery" ? { recovery_id: sha256("different-recovery") } :
    options.attemptDrift === "old_issuance" ? { attempt_issued_at: identity.issuedAt - 1 } :
    options.attemptDrift === "old_observation" ? { recovered_at: new Date((identity.issuedAt - 1) * 1000).toISOString() } :
    options.attemptDrift === "future_observation" ? { recovered_at: new Date(Date.now() + 60_000).toISOString() } :
    options.attemptDrift === "missing_attempt" ? { attempt_id: undefined } : {});
    return { events: [event], artifacts: [] };
  });
  const driver = { recover, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const settle = vi.spyOn(ledger, "settleRecoveryControl");
  const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));
  return { ledger, worker, run, event, audit, recover, control, settle };
}

describe("worker recovery after hard content deletion", () => {
  it.each(["scheduleRetainedRecovery", "listExpiredRuns", "listRunsNeedingRecovery", "listRunsPendingEvidence", "listRunnableSuites"] as const)("still checks expired leases when %s is unavailable", async method => {
    const { ledger, worker, run } = await fixture();
    vi.spyOn(ledger, method).mockRejectedValue(new Error("injected independent maintenance outage"));
    const reap = vi.spyOn(ledger, "reapExpiredBrowserLeases");
    await expect(worker.maintainSessions()).resolves.toBeUndefined();
    expect(reap).toHaveBeenCalledTimes(1);
    if (method === "scheduleRetainedRecovery") {
      expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false, remotePurgeComplete: false });
      expect(await ledger.countActiveRuns()).toBe(1);
    }
  });
  it.each(["listing", "transition", "retention_listing", "local_purge"])("continues authoritative recovery after maintenance %s fails", async failure => {
    const { ledger, worker, run, recover } = await fixture();
    const listing = vi.spyOn(ledger, "listRunsCertificationDue");
    const purge = vi.spyOn(ledger, "purgeExpiredRetention");
    if (failure === "listing") listing.mockRejectedValueOnce(new Error("certification listing unavailable"));
    else if (failure === "retention_listing") vi.spyOn(ledger, "listRunsRetentionDue").mockRejectedValueOnce(new Error("retention listing unavailable"));
    else if (failure === "local_purge") purge.mockRejectedValueOnce(new Error("local purge unavailable"));
    else {
      listing.mockResolvedValueOnce([testRun({ state: "pending_external_evidence", expiresAt: new Date(0) })]);
      vi.spyOn(ledger, "updateRun").mockRejectedValueOnce(new Error("certification transition unavailable"));
    }
    await worker.maintainSessions();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: true, remotePurgeComplete: true });
  });
  it.each(["old_attempt", "wrong_recovery", "old_issuance", "old_observation", "future_observation", "missing_attempt"])("rejects a same-run receipt with %s without settling", async attemptDrift => {
    const { ledger, worker, run, recover } = await fixture({ attemptDrift });
    await worker.maintainSessions();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false, remotePurgeComplete: false });
    expect(await ledger.countActiveRuns()).toBe(1);
  });
  it.each([false, true])("audits and settles exact-bound recovery without allocating, D02=%s", async d02 => {
    const { ledger, worker, run, recover } = await fixture({ d02 });
    await worker.maintainSessions();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(await ledger.listArtifacts(run.id)).toEqual([]);
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: true, remotePurgeComplete: true });
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "confirmed" });
  });
  it("does not settle allocated execution lacking an independent process proof", async () => {
    const { ledger, worker, run, recover, settle } = await fixture({ allocated: true, missingProof: true });
    await worker.maintainSessions();
    expect(recover).toHaveBeenCalledTimes(1);
    await expect(recover.mock.results[0]!.value).resolves.toMatchObject({ events: [{ payload: { complete: true } }] });
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(settle.mock.results[0]!.value).rejects.toMatchObject({ detail: { code: "RECOVERY_EXECUTION_UNCONFIRMED" } });
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false, remotePurgeComplete: false });
    expect(await ledger.countActiveRuns()).toBe(1);
  });
  it("settles non-D02 allocated execution only after preserved process cleanup and lease release", async () => {
    const { ledger, worker, run, recover, settle } = await fixture({ allocated: true });
    await worker.maintainSessions();
    await expect(recover.mock.results[0]!.value).resolves.toMatchObject({ events: [{ payload: { complete: true } }] });
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(settle.mock.results[0]!.value).resolves.toMatchObject({ liveCleanupComplete: true, executionCleanupProof: { ready: true } });
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    expect(await ledger.countActiveRuns()).toBe(0);
    expect(await ledger.getRun(run.id)).toBeNull();
  });
  it("never dispatches when the durable authorization audit fails", async () => {
    const { worker, audit, recover } = await fixture();
    audit.mockRejectedValueOnce(new Error("audit unavailable"));
    await worker.maintainSessions();
    expect(recover).not.toHaveBeenCalled();
  });
  it("does not settle while an owned browser lease remains even with preserved process proof", async () => {
    const { ledger, worker, run, recover, settle } = await fixture({ allocated: true, keepLease: true });
    await worker.maintainSessions();
    expect(recover).toHaveBeenCalledTimes(1);
    await expect(recover.mock.results[0]!.value).resolves.toMatchObject({ events: [{ payload: { complete: true } }] });
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(settle.mock.results[0]!.value).rejects.toMatchObject({ detail: { code: "RECOVERY_BROWSER_UNSETTLED" } });
    expect(await ledger.getBrowserLease(run.id)).not.toBeNull();
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false, remotePurgeComplete: false });
  });
  it("refuses a cross-run cleanup receipt without rewriting control truth", async () => {
    const { ledger, worker, run, event } = await fixture();
    event.payload.receipt.test_run_id = randomUUID();
    await worker.maintainSessions();
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false, remotePurgeComplete: false });
  });
});
