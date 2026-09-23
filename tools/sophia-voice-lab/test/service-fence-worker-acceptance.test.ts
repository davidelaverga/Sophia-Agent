import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";

import type { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabService } from "../src/service.js";
import { VoiceLabWorker } from "../src/worker.js";
import { deriveExecutionEpochCleanupProof } from "../src/execution-cleanup.js";
import { CapabilityCodec, canonicalRequestHash, sha256 } from "../src/security.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";
import { derivePlatformExecutionTermination, PLATFORM_EXECUTION_TERMINATION_KIND } from "../src/platform-execution-termination.js";
import { renderInventoryInstanceId } from "../src/worker-identity.js";
import { signedV2FenceReceipt } from "./service-owner-fence-fixture.js";
import { initializeAuthorityFiles } from "../scripts/external-attestations/crypto.js";
import { runCli } from "../scripts/external-attestations/cli.js";
import { GENERIC_RECOVERY_ORIGIN } from "../scripts/external-attestations/generic-worker-preflight.js";
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

/** A complete, authoritative Gateway recovery receipt for this run. */
function gatewayRecoveryEvent(run: ReturnType<typeof testRun>, identity: { recoveryId: string; attemptId: string; issuedAt: string }) {
  const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 };
  return { kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, http_status: 200, receipt: {
    test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    complete: true, live_cleanup_complete: true, live_resources_zero: true,
    recovery_id: identity.recoveryId, attempt_id: identity.attemptId, attempt_issued_at: identity.issuedAt,
    recovered_at: new Date().toISOString(),
    receipt: { storage: "postgres", object_path: `runs/${run.id}/recovery`, sha256: sha256("gateway-recovery-object") },
    components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" },
      auth_sessions: { status: "completed" }, builder } } } };
}

/** The replacement worker, with ONLY the external Gateway recovery transport
 * mocked. The worker decides when to call it and authors every durable event. */
function replacementWorker(ledger: MemoryVoiceLabLedger, config: ReturnType<typeof testConfig>, run: ReturnType<typeof testRun>) {
  const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
  const recover = vi.fn(async (_binding: unknown, token: string) => {
    const claims = codec.verify(token, { audience: "sophia-voice-lab-recovery", operation: "session:recover",
      principalId: run.principalId, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId,
      environment: run.environment, retentionHours: run.capturePolicy.retentionHours,
      providerExpiresAt: run.expiresAt.toISOString(), expectedDeployment: run.target.expectedDeployment,
      scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion });
    return { events: [gatewayRecoveryEvent(run, recoveryAttemptIdentity(claims))],
      // A real recovery returns its canonical receipt artifact.
      artifacts: [{ id: randomUUID(), kind: "canonical_receipt", contentType: "application/json",
        bytes: Buffer.from(JSON.stringify({ recovery_id: recoveryAttemptIdentity(claims).recoveryId })) }] };
  });
  const driver = { recover, hasSession: () => false, close: async () => undefined } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));
  return { worker, recover };
}

it("lets the worker recover, release the foreign lease and export the manifest", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { ledger, config, run, ownership } = await seedTerminalObligation();
    expect(renderInventoryInstanceId(FOREIGN_OWNER)).toBe(`${SERVICE_ID}-2gj6p`);
    const termination = await admitFence(ledger, run.id, ownership);

    const { worker, recover } = replacementWorker(ledger, config, run);

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

it("recovers again after the platform termination even when an earlier recovery already completed", async () => {
  // The present run's exact shape: Gateway recovery completed (seq296) BEFORE
  // the platform termination can exist. The execution proof requires a
  // recovery AFTER the termination, so that earlier receipt must not be taken
  // as current or the proof stays provider_or_auth_cleanup_unconfirmed forever.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { ledger, config, run, ownership } = await seedTerminalObligation();
    const earlier = await ledger.appendEvent(run.id, "cleanup.recovery", "canonical",
      gatewayRecoveryEvent(run, { recoveryId: randomUUID(), attemptId: randomUUID(), issuedAt: new Date().toISOString() }).payload);
    const termination = await admitFence(ledger, run.id, ownership);
    expect(termination.seq).toBeGreaterThan(earlier.seq);

    const { worker, recover } = replacementWorker(ledger, config, run);
    await worker.maintainSessions();

    expect(recover).toHaveBeenCalledTimes(1);
    const cleanup = (await ledger.listEvents(run.id, 0, 500)).events.filter(event => event.kind === "cleanup.recovery");
    expect(cleanup).toHaveLength(2);
    expect(cleanup.at(-1)!.seq).toBeGreaterThan(termination.seq);
    const control = (await ledger.getRecoveryControl(run.id))!;
    expect(control.executionCleanupProof).toMatchObject({ ready: true, reason: "authoritative_platform_fence_after_owner_loss" });
    expect(control.executionCleanupProof!.eventSeqs).toMatchObject({ platformTerminated: termination.seq, recovery: cleanup.at(-1)!.seq, processClosed: null });
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    expect((await ledger.getRun(run.id))!.cleanupComplete).toBe(true);

    // Once the post-termination recovery exists it is current: no repeat.
    await worker.maintainSessions();
    expect(recover).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

// ---- C016: the present run's actual retired-owner sequence, end to end ------
// Real MemoryVoiceLabLedger + VoiceLabService dispatch + operator CLI collector
// and publisher + real VoiceLabWorker. Only the Render API, the MCP /readyz
// observation and the external Gateway recovery transport are modelled. The
// deployed generation's prepare/consume code is byte-identical to this tree's
// (generic-owner-dispatch, ledgers), so the service serves it directly; only
// v2 ingestion is refused until the receiver upgrade, exactly as 7d4 would.
const scratchDirs: string[] = [];
afterEach(async () => { for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("settles the present run via an explicit absent-mode fence before any purge", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { ledger, config, run, lease, ownership: _ownership } = await seedTerminalObligation();
    // The third run's real shape: a complete Gateway recovery already exists.
    const earlier = await ledger.appendEvent(run.id, "cleanup.recovery", "canonical",
      gatewayRecoveryEvent(run, { recoveryId: randomUUID(), attemptId: randomUUID(), issuedAt: new Date().toISOString() }).payload);
    const dir = await mkdtemp(path.join(os.tmpdir(), "vt00-retired-owner-")); scratchDirs.push(dir);
    const keys = { external_mcp_client: path.join(dir, "client.key"), deployment_control: path.join(dir, "deploy.key"), platform_plugin: path.join(dir, "platform.key") };
    const initialized = await initializeAuthorityFiles({ publicConfigPath: path.join(dir, "public.json"), transportTokensPath: path.join(dir, "tokens.json"), privateKeyPaths: keys,
      keyIds: { external_mcp_client: "client-key-test", deployment_control: "deploy-key-test", platform_plugin: "platform-key-test" } });
    const authority = initialized.publicConfig.deployment_control;
    config.attestationAuthorities.deployment_control = { issuer: authority.issuer, subject: authority.subject, keyId: authority.key_id, publicKeySpkiBase64: authority.public_key_spki_base64 };
    config.genericRecoveryWorkerServiceId = SERVICE_ID;
    config.readinessTarget = run.target;
    const DEPLOYED = config.serviceVersion, UPGRADED = "ab".repeat(20);
    const service = new VoiceLabService(ledger, config, async () => []);
    const caller = { subject: authority.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" } as never;

    // Pods: the ORIGINAL (booted gate-open), A (same-SHA closure deploy), B (the collector's restart).
    const pods = { original: { full: FOREIGN_OWNER, gateClosed: false }, a: { full: `${SERVICE_ID}-5566778899-a1b2c`, gateClosed: true }, b: { full: `${SERVICE_ID}-77ffaa1122-9kd2f`, gateClosed: true } };
    let live = pods.original; let liveCreatedAt = new Date(Date.now() - 600_000);
    let receiverUpgraded = false; let restarts = 0;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const fetchImpl: typeof fetch = async (raw, init) => {
      const url = new URL(raw instanceof Request ? raw.url : raw.toString());
      if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname.endsWith("owner-dispatch")) {
        const body = JSON.parse(String(init?.body));
        if (body.action === "ingest_service_fence" && !receiverUpgraded) return json({ error: "deployed generation cannot parse v2" }, 400);
        return json(await service.genericOwnerDispatch(caller, body));
      }
      const inventory = renderInventoryInstanceId(live.full)!;
      if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname === "/readyz") {
        const gate = { valid: true, open: false, voice_lab_enabled: false, voice_lab_kill_switch_engaged: true, voice_lab_mutation_ready: false };
        return json({ version: DEPLOYED, execution: "kill_switch_engaged", active_runs: 1, mutation_ready: false, product_mutation_gates_open: false,
          components: { database: { ready: true }, browser_worker: { runtime_ready: true, live_workers: 1, execution_gate_settled: live.gateClosed, observed_kill_switch_engaged: live.gateClosed,
            heartbeat_attestation: { service_version: DEPLOYED, repository_candidate_sha: DEPLOYED, worker_instance_id_sha256: sha256(live.full),
              render_inventory_instance_id_sha256: sha256(inventory), observed_at: new Date().toISOString() } },
            test_auth: { ok: true, frontend_kill_switch_engaged: true, mutation_gate_order_safe: true },
            target_environment: { builds: { frontend: { observed: run.target.expectedDeployment.frontend }, backend: { observed: run.target.expectedDeployment.backend, product_mutation_gate: gate },
              voice: { observed: run.target.expectedDeployment.voice, product_mutation_gate: gate }, langgraph: { observed: run.target.expectedDependencies.langgraph } } } } });
      }
      if (url.origin !== "https://api.render.com") throw new Error(`Unexpected origin ${url.origin}`);
      if (init?.method === "POST") { restarts++; live = pods.b; liveCreatedAt = new Date(); return json({ restarted: true }); }
      const createdAt = liveCreatedAt.toISOString();
      if (url.pathname.endsWith("/instances")) return json([{ id: inventory, createdAt }]);
      if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: live === pods.b ? "dep-abcdefghij0123456789" : "dep-0123456789abcdefghij", status: "live", createdAt, updatedAt: createdAt, finishedAt: createdAt } }]);
      return json({ id: SERVICE_ID, name: "sophia-voice-lab-worker", type: "background_worker" });
    };
    const runtime = { serviceOwnerFence: { fetchImpl, now: () => new Date(), sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms); } } };
    const requestId = randomUUID();
    const writeInput = async (name: string, preAction?: "absent") => {
      const inputPath = path.join(dir, `${name}.json`); const bundle = path.join(dir, `${name}-journal`);
      await mkdir(bundle, { mode: 0o700 });
      await writeFile(inputPath, JSON.stringify({ runId: run.id, requestId, workerServiceId: SERVICE_ID, allocatedWorkerId: FOREIGN_OWNER,
        voiceLabOrigin: GENERIC_RECOVERY_ORIGIN, generation: "v2", ...(preAction ? { originalOwnerPreAction: preAction } : {}),
        expectedLabSha: DEPLOYED, expectedLangGraphSha: run.target.expectedDependencies.langgraph, expectedRecoveryDeployment: run.target.expectedDeployment }), { mode: 0o600 });
      return ["--input", inputPath, "--public-config", path.join(dir, "public.json"), "--transport-tokens", path.join(dir, "tokens.json"), "--deployment-key", keys.deployment_control, "--bundle-dir", bundle];
    };
    await writeFile(path.join(dir, "render.json"), JSON.stringify({ bearer_token: "synthetic-render-token-00000000000000000000" }), { mode: 0o600 });
    const renderArgs = ["--render-token", path.join(dir, "render.json")];
    const output: string[] = [];

    // 1. The original still owns the pod with its gate open: the present-mode collector stops before any mutation.
    expect(await runCli(["collect-service-owner-fence", ...await writeInput("present"), ...renderArgs], line => output.push(line), runtime)).not.toBe(0);
    expect(output.at(-1)).toMatch(/execution_gate_settled|observed_kill_switch_engaged/);
    expect(restarts).toBe(0);
    expect((await ledger.getRecoveryControl(run.id))!.genericOwnerDispatch).toBeUndefined();

    // 2. The supported same-SHA closure deploy replaces the original; the new pod attests a closed gate.
    live = pods.a; liveCreatedAt = new Date();
    vi.setSystemTime(Date.now() + 5_000);

    // 3. Explicit absent-mode collection against the deployed generation's prepare/consume (same requestId, fresh journal).
    const absentArgs = await writeInput("absent", "absent");
    expect(await runCli(["collect-service-owner-fence", ...absentArgs, ...renderArgs], line => output.push(line), runtime), output.join("\n")).toBe(0);
    const collected = JSON.parse(output.at(-1)!);
    expect(restarts).toBe(1);
    // The deployed generation cannot admit a v2 receipt at all.
    expect(await runCli(["publish-service-owner-fence", ...absentArgs], line => output.push(line), runtime)).not.toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "unconfirmed", durable_recovery_ingested: false });
    expect((await ledger.getRecoveryControl(run.id))!.genericOwnerLoss).toBeUndefined();

    // 4. Only then is the receiver upgraded, with the exact immutable receipt hash approved.
    receiverUpgraded = true; config.serviceVersion = UPGRADED; config.genericRecoveryReceiptSha256 = collected.receipt_sha256;
    expect(await runCli(["publish-service-owner-fence", ...absentArgs], line => output.push(line), runtime), output.join("\n")).toBe(0);
    const control = (await ledger.getRecoveryControl(run.id))!;
    expect(control.genericOwnerLoss).toMatchObject({ schema: "sophia.voice-lab.verified-service-owner-fence.v2", originalOwnerPreAction: "absent", expectedLabSha: DEPLOYED });
    let events = (await ledger.listEvents(run.id, 0, 500)).events;
    const terminations = events.filter(event => event.kind === "cleanup.platform_execution_terminated");
    expect(terminations).toHaveLength(1);
    expect(terminations[0]!.payload).toMatchObject({ original_owner_pre_action: "absent", browser_context_closed_fabricated: false });
    expect(terminations[0]!.seq).toBeGreaterThan(earlier.seq);

    // 5. The upgraded worker recovers afresh after the termination, releases the exact foreign lease and settles, before any purge.
    expect((await ledger.getBrowserLease(run.id))!).toMatchObject({ workerId: FOREIGN_OWNER, leaseEpoch: lease.leaseEpoch });
    const { worker, recover } = replacementWorker(ledger, config, run);
    await worker.maintainSessions();
    expect(recover).toHaveBeenCalledTimes(1);
    events = (await ledger.listEvents(run.id, 0, 500)).events;
    const recoveries = events.filter(event => event.kind === "cleanup.recovery");
    expect(recoveries.at(-1)!.seq).toBeGreaterThan(terminations[0]!.seq);
    const settled = (await ledger.getRecoveryControl(run.id))!;
    expect(settled.executionCleanupProof).toMatchObject({ ready: true, reason: "authoritative_platform_fence_after_owner_loss" });
    expect(settled.contentPurgedAt).toBeNull();
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    expect((await ledger.getRun(run.id))!.cleanupComplete).toBe(true);
    expect(events.some(event => event.kind === "cleanup.browser_context_closed")).toBe(false);

    // 6. Replayed publication is immutable: one termination, one restart, no second recovery.
    expect(await runCli(["publish-service-owner-fence", ...absentArgs], line => output.push(line), runtime)).toBe(0);
    await worker.maintainSessions();
    expect((await ledger.listEvents(run.id, 0, 500)).events.filter(event => event.kind === "cleanup.platform_execution_terminated")).toHaveLength(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(restarts).toBe(1);
  } finally { vi.useRealTimers(); }
});

it("keeps a platform-fenced settlement stable when a later retention recovery arrives", async () => {
  // C018: post-termination recovery settles the epoch; a later legitimate
  // authoritative recovery (as a retention pass performs) must not regress
  // readiness, move the preserved digest, or break the pre-deletion preserve.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { ledger, config, run, ownership } = await seedTerminalObligation();
    const termination = await admitFence(ledger, run.id, ownership);
    const { worker } = replacementWorker(ledger, config, run);
    await worker.maintainSessions();
    const preserved = (await ledger.getRecoveryControl(run.id))!.executionCleanupProof!;
    expect(preserved).toMatchObject({ ready: true, reason: "authoritative_platform_fence_after_owner_loss" });
    expect(await ledger.getBrowserLease(run.id)).toBeNull();

    // The later retention recovery's canonical Gateway receipt.
    const later = await ledger.appendEvent(run.id, "cleanup.recovery", "canonical",
      gatewayRecoveryEvent(run, { recoveryId: randomUUID(), attemptId: randomUUID(), issuedAt: new Date().toISOString() }).payload);
    const events = (await ledger.listEvents(run.id, 0, 500)).events;
    expect(events.filter(event => event.kind === "cleanup.recovery" && event.seq > termination.seq)).toHaveLength(2);
    const rederived = deriveExecutionEpochCleanupProof((await ledger.getRun(run.id))!, events);
    expect(rederived).toMatchObject({ ready: true, reason: "authoritative_platform_fence_after_owner_loss", proofSha256: preserved.proofSha256 });
    expect(rederived.eventSeqs.recovery).toBe(preserved.eventSeqs.recovery);
    expect(rederived.eventSeqs.recovery).toBeLessThan(later.seq);
    expect(rederived.eventSeqs).toMatchObject({ platformTerminated: termination.seq, processClosed: null });
    // The ledger's own pre-deletion preservation recomputes and compares the digest.
    await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).resolves.toMatchObject({ executionCleanupProof: preserved });
    // Settlement and the released lease stay as they were.
    await worker.maintainSessions();
    expect((await ledger.getRun(run.id))!.cleanupComplete).toBe(true);
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    expect((await ledger.getRecoveryControl(run.id))!.executionCleanupProof).toEqual(preserved);
  } finally { vi.useRealTimers(); }
});
