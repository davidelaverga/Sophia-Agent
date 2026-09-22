import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";

import type { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabService } from "../src/service.js";
import { VoiceLabWorker } from "../src/worker.js";
import { CapabilityCodec, canonicalRequestHash, sha256 } from "../src/security.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";
import { derivePlatformExecutionTermination, PLATFORM_EXECUTION_TERMINATION_KIND } from "../src/platform-execution-termination.js";
import { renderInventoryInstanceId } from "../src/worker-identity.js";
import { signedV2FenceReceipt } from "./service-owner-fence-fixture.js";
import { testConfig, testRun } from "./helpers.js";

const SERVICE_ID = "srv-0123456789abcdefghij";
/** The pod that owned the execution epoch, now replaced by the platform. */
const FOREIGN_OWNER = `${SERVICE_ID}-65566bc6c7-2gj6p`;

/** Ordinary unpurged terminal run holding a FOREIGN browser lease. */
async function seedTerminalObligation() {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const run = testRun({ scenarioId: "V-A01", state: "product_failed",
    terminalError: { code: "PRODUCT_FAILED", message: "synthetic", category: "product", retryable: false } as never });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start",
    idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} } as never, { global: 1, caller: 1 });

  // Short TTL: the replaced pod stops heartbeating, so its lease expires.
  const lease = await ledger.upsertBrowserLease(run.id, FOREIGN_OWNER, 60);
  await ledger.appendEvent(run.id, "harness.browser_process_acquired", "browser", {
    schema: "sophia_voice_lab_browser_process_ownership_v1", voice_lab_run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), process_id_sha256: "a".repeat(64),
    browser_boot_id_sha256: "b".repeat(64), execution_epoch_sha256: "c".repeat(64),
    one_process_per_run: true, raw_process_id_excluded: true });
  await ledger.appendEvent(run.id, "harness.browser_runtime_acquired", "canonical", {
    worker_id_sha256: sha256(FOREIGN_OWNER), browser_lease_epoch: lease.leaseEpoch });
  const owned = await ledger.preserveRecoveryExecutionOwnership(run.id);
  return { ledger, config, run, lease, ownership: owned.executionOwnership! };
}

/** Admit a signed v2 fence through the real ledger and the production writer. */
async function admitFence(ledger: MemoryVoiceLabLedger, runId: string, ownership: unknown) {
  let control = (await ledger.getRecoveryControl(runId))!;
  control = await ledger.prepareGenericOwnerDispatch({ runId, expectedVersion: control.version,
    requestId: runId, workerServiceId: SERVICE_ID } as never);
  const consumed = await ledger.consumeGenericOwnerDispatch({ runId, expectedVersion: control.version,
    preparedProofSha256: control.genericOwnerDispatch!.proofSha256 } as never);
  control = (consumed as { control?: unknown }).control as never ?? consumed as never;
  const actionRequestedAt = new Date(control.genericOwnerDispatch!.consumedAt!);
  vi.setSystemTime(new Date(actionRequestedAt.getTime() + 362_000));
  const signed = signedV2FenceReceipt({ control, ownership: ownership as never, allocatedWorkerId: FOREIGN_OWNER, serviceId: SERVICE_ID, actionRequestedAt });
  await ledger.persistGenericOwnerLoss({ runId, expectedVersion: control.version, receipt: signed.receipt,
    authority: signed.authority, expectedWorkerServiceIdSha256: sha256(SERVICE_ID),
    expectedRecoveryDeployment: signed.expectedRecoveryDeployment, expectedLabSha: signed.expectedLabSha,
    expectedLangGraphSha: signed.expectedLangGraphSha } as never);
  const persisted = (await ledger.getRecoveryControl(runId))!;
  const termination = derivePlatformExecutionTermination(persisted, persisted.genericOwnerLoss as never);
  return ledger.appendEvent(runId, PLATFORM_EXECUTION_TERMINATION_KIND, "canonical", termination.payload, termination.dedupeKey);
}

it("lets the worker recover, release the foreign lease and export the manifest", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { ledger, config, run, ownership } = await seedTerminalObligation();
    expect(renderInventoryInstanceId(FOREIGN_OWNER)).toBe(`${SERVICE_ID}-2gj6p`);
    const termination = await admitFence(ledger, run.id, ownership);

    const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
    // ONLY the external Gateway recovery transport is mocked. The worker
    // decides when to call it and authors every durable event itself.
    const recover = vi.fn(async (_binding: unknown, token: string) => {
      const claims = codec.verify(token, { audience: "sophia-voice-lab-recovery", operation: "session:recover",
        principalId: run.principalId, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId,
        environment: run.environment, retentionHours: run.capturePolicy.retentionHours,
        providerExpiresAt: run.expiresAt.toISOString(), expectedDeployment: run.target.expectedDeployment,
        scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion });
      const identity = recoveryAttemptIdentity(claims);
      const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 };
      return { events: [{ kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, http_status: 200, receipt: {
        test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
        complete: true, live_cleanup_complete: true, live_resources_zero: true,
        recovery_id: identity.recoveryId, attempt_id: identity.attemptId, attempt_issued_at: identity.issuedAt,
        recovered_at: new Date().toISOString(),
        receipt: { storage: "postgres", object_path: `runs/${run.id}/recovery`, sha256: sha256("gateway-recovery-object") },
        components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" },
          auth_sessions: { status: "completed" }, builder } } } }],
        // A real recovery returns its canonical receipt artifact.
        artifacts: [{ id: randomUUID(), kind: "canonical_receipt", contentType: "application/json",
          bytes: Buffer.from(JSON.stringify({ recovery_id: identity.recoveryId })) }] };
    });
    const driver = { recover, hasSession: () => false, close: async () => undefined } as unknown as VoiceBrowserDriver;
    const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));

    const held = await ledger.getBrowserLease(run.id);
    expect(held).not.toBeNull();
    expect(held!.workerId).toBe(FOREIGN_OWNER);
    expect(held!.expiresAt.getTime()).toBeLessThan(Date.now());
    await worker.maintainSessions();

    // The WORKER performed recovery and authored the cleanup event.
    expect(recover).toHaveBeenCalled();
    const events = (await ledger.listEvents(run.id, 0, 500)).events;
    const cleanup = events.filter(event => event.kind === "cleanup.recovery");
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]!.source).toBe("canonical");
    expect(cleanup[0]!.seq).toBeGreaterThan(termination.seq);

    // Foreign lease released by the worker, not by the test.
    expect(await ledger.getBrowserLease(run.id)).toBeNull();

    // Preserved proof came from the platform fence, with no browser close.
    const control = (await ledger.getRecoveryControl(run.id))!;
    expect(control.executionCleanupProof!.ready).toBe(true);
    expect(control.executionCleanupProof!.reason).toBe("authoritative_platform_fence_after_owner_loss");
    expect(control.executionCleanupProof!.eventSeqs.processClosed).toBeNull();
    expect(control.executionCleanupProof!.eventSeqs.platformTerminated).toBe(termination.seq);
    expect(events.some(event => event.kind === "cleanup.browser_context_closed")).toBe(false);

    const settled = (await ledger.getRun(run.id))!;
    expect(settled.cleanupComplete).toBe(true);

    // Worker-saved manifest/artifacts, retrieved through the REAL service export.
    const evidence = (await ledger.getEvidence(run.id))!;
    expect(evidence.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const service = new VoiceLabService(ledger, config, async () => []);
    const exported = await service.exportVoiceEvidence(
      { subject: run.callerId, scopes: new Set(["voice_lab:read"]) } as never, { run_id: run.id });
    expect(exported.status).toBe("completed");
    expect(exported.data).toMatchObject({ cleanup_complete: true, evidence_state: "available",
      manifest_id: evidence.manifestId, manifest_sha256: evidence.manifestSha256 });

    // The publication revision is worker-authored, not test-appended.
    const published = events.filter(event => event.kind === "evidence.publication_revision");
    expect(published.length).toBeGreaterThanOrEqual(1);
    expect(published.every(event => event.source === "worker")).toBe(true);

    const artifacts = await ledger.listArtifacts(run.id);
    // The Gateway recovery's canonical receipt is durably stored by the worker.
    const receipt = artifacts.find(artifact => artifact.kind === "canonical_receipt");
    expect(receipt).toBeDefined();
    expect(receipt!.sha256).toBe(sha256(Buffer.from(receipt!.bytes)));

    // The worker's manifest commits to that artifact by id and hash.
    const manifest = artifacts.find(artifact => artifact.kind === "manifest_attachment");
    expect(manifest).toBeDefined();
    expect(manifest!.sha256).toBe(sha256(Buffer.from(manifest!.bytes)));
    const manifestText = Buffer.from(manifest!.bytes).toString("utf8");
    expect(manifestText).toContain(receipt!.id);
    expect(manifestText).toContain(receipt!.sha256);
    expect(canonicalRequestHash(exported.data)).toEqual(expect.any(String));
  } finally { vi.useRealTimers(); }
});
