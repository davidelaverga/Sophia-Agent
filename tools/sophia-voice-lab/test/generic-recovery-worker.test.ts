import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import type { AudioResolver } from "../src/audio.js";
import { PlaywrightVoiceDriver } from "../src/browser-driver.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabWorker } from "../src/worker.js";
import { CapabilityCodec, canonicalRequestHash, sha256 } from "../src/security.js";
import { genericOwnerLossDispatchFromControl } from "../src/generic-owner-dispatch.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";
import { recoveryAttemptAuditHash } from "../src/retained-d02-recovery.js";
import { combinedRecoveryFixture } from "./retained-d02-recovery-helper.js";
import { testConfig, testRun } from "./helpers.js";

afterEach(() => vi.useRealTimers());

it.each(["complete", "provider_pending", "auth_pending", "builder_unknown", "wrong_attempt", "lost_response"])(
  "runs generic retained cleanup through real worker/transport without allocating: %s", async mode => {
    const initialTime = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(initialTime);
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
    const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(0), retentionPurgePending: true });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start",
      idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
    const owner = "generic-original-worker";
    const lease = await ledger.upsertBrowserLease(run.id, owner, 60);
    await ledger.releaseBrowserLease(run.id, owner, lease.leaseEpoch);
    const initial = (await ledger.getRecoveryControl(run.id))!;
    const prepared = await ledger.prepareGenericOwnerDispatch({ runId: run.id, requestId: randomUUID(), expectedVersion: initial.version, workerServiceId: "srv-0123456789abcdefghij" });
    const consumed = await ledger.consumeGenericOwnerDispatch({ runId: run.id, expectedVersion: prepared.version, preparedProofSha256: prepared.genericOwnerDispatch!.proofSha256 });
    await ledger.purgeExpiredRetention(new Date(), 10);
    const control = (await ledger.getRecoveryControl(run.id))!;
    const dispatch = genericOwnerLossDispatchFromControl(control);
    const pair = generateKeyPairSync("ed25519");
    const authority = { issuer: "test-deployment-controller", subject: "test-deployment-operator", key_id: "test-deployment-key",
      public_key_spki_base64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
    const now = new Date().toISOString();
    const snapshot = { serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"), instanceResponseSha256: sha256("inventory"), deployIdSha256: sha256("deploy-id"), deployStatus: "live" };
    const unsigned = { schema: "sophia.voice-lab.generic-owner-loss-receipt.v1", receiptId: consumed.control.genericOwnerDispatch!.requestId,
      authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id,
      audience: "sophia-voice-lab-generic-owner-loss", ...dispatch,
      expectedLabSha: config.serviceVersion, expectedLangGraphSha: run.target.expectedDependencies.langgraph,
      workerIdSha256: sha256(owner), browserLeaseEpoch: lease.leaseEpoch,
      actionAcceptedResponseSha256: sha256("accepted"), actionHttpStatus: 200, actionAcceptedAt: now,
      before: { ...snapshot, instanceIdsSha256: [sha256(owner)], instanceCreatedAt: control.binding.createdAt, observedAt: now },
      after: { ...snapshot, instanceIdsSha256: [sha256("replacement")], instanceCreatedAt: now, observedAt: now },
      providerCleanupProven: false, liveResourcesZeroProven: false, issuedAt: now, expiresAt: new Date(initialTime + 60000).toISOString(),
      signatureAlgorithm: "ed25519-sha256-canonical-request-v1" };
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), pair.privateKey).toString("base64url") };
    await ledger.persistGenericOwnerLoss({ runId: run.id, expectedVersion: control.version, receipt, authority,
      expectedWorkerServiceIdSha256: dispatch.workerServiceIdSha256, expectedLabSha: unsigned.expectedLabSha, expectedLangGraphSha: unsigned.expectedLangGraphSha });
    const retained = (await ledger.getRecoveryControl(run.id))!;
    vi.setSystemTime(initialTime + 2000);
    const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
    let currentMode = mode;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${control.binding.gatewayOrigin}${config.recoveryPathPrefix}/${run.testRunId}/recover`);
      expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Sophia-Voice-Lab-Recovery-Auth")).toBe(config.recoveryInternalSecret);
      const claims = codec.verify(headers.get("X-Sophia-Voice-Lab-Capability")!, { audience: "sophia-voice-lab-recovery", operation: "session:recover",
        principalId: run.principalId, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, environment: run.environment,
        retentionHours: run.capturePolicy.retentionHours, providerExpiresAt: run.expiresAt.toISOString(), expectedDeployment: run.target.expectedDeployment,
        scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion });
      expect(claims.allowed_ops).toEqual(["session:recover"]);
      expect(claims.browser_context_id_sha256).toBeUndefined();
      const attempt = recoveryAttemptIdentity(claims);
      const audits = await ledger.listAuthAuditByArgumentHashes(retained.binding.callerPartitionId, [recoveryAttemptAuditHash(retained, attempt)], new Date(0));
      expect(audits.some(a => a.capabilityJtiHash === sha256(claims.jti) && a.outcome === "allowed")).toBe(true);
      if (currentMode === "lost_response") throw new Error("Synthetic Gateway response loss");
      const { event } = combinedRecoveryFixture(retained, claims.iat);
      const body = { ...event.payload.receipt, ok: true, cleanup_obligation_id: run.cleanupObligationId,
        recovery_id: attempt.recoveryId, attempt_id: attempt.attemptId, attempt_issued_at: claims.iat, recovered_at: new Date().toISOString() };
      if (currentMode === "provider_pending") body.components.voice_provider.status = "pending";
      if (currentMode === "auth_pending") body.components.auth_sessions.status = "pending";
      if (currentMode === "builder_unknown") body.components.builder.authoritative_zero_tasks = false;
      if (currentMode === "wrong_attempt") body.attempt_id = sha256("older-attempt");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const launch = vi.fn(async () => { throw new Error("RECOVERY_MUST_NOT_LAUNCH"); });
    const driver = new PlaywrightVoiceDriver(config, fetchImpl, launch, undefined, launch);
    const start = vi.spyOn(driver, "start"), allocate = vi.spyOn(ledger, "upsertBrowserLease");
    const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));
    await worker.maintainSessions();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Surface test-spy assertion failures that the real transport correctly
    // classifies as unavailable, rather than hiding them as product failures.
    if (mode === "lost_response") await expect(fetchImpl.mock.results[0]!.value).rejects.toThrow("Synthetic Gateway response loss");
    else await fetchImpl.mock.results[0]!.value;
    if (mode !== "complete") {
      expect(await ledger.getRecoveryControl(run.id)).toEqual(retained);
      expect(await ledger.countActiveRuns()).toBe(1);
      currentMode = "complete"; vi.setSystemTime(initialTime + 34000);
      await worker.maintainSessions();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await fetchImpl.mock.results[1]!.value;
    }
    expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: true, remotePurgeComplete: true,
      genericRecoverySettlement: { ready: true, ownerLossProofSha256: retained.genericOwnerLoss!.proofSha256 } });
    expect(await ledger.countActiveRuns()).toBe(0);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(await ledger.listArtifacts(run.id)).toEqual([]);
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "confirmed" });
    expect(start).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
    await driver.close();
  },
);
