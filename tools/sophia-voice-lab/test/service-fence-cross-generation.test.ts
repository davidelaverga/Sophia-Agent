import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";

import { collectServiceOwnerFence, type ServiceOwnerFenceCheckpoint } from "../scripts/external-attestations/service-owner-fence-controller.js";
import { runCli } from "../scripts/external-attestations/cli.js";
import { initializeAuthorityFiles } from "../scripts/external-attestations/crypto.js";
import { GENERIC_RECOVERY_ORIGIN } from "../scripts/external-attestations/generic-worker-preflight.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch } from "../src/generic-owner-dispatch.js";
import { ingestGenericOwnerLoss } from "../src/generic-owner-loss.js";
import { AnyServiceOwnerFenceReceiptSchema, serviceFenceSourceLabSha } from "../src/service-owner-fence.js";
import { derivePlatformExecutionTermination } from "../src/platform-execution-termination.js";
import { deriveExecutionOwnership } from "../src/execution-ownership.js";
import { renderInventoryInstanceId } from "../src/worker-identity.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import type { LabEvent } from "../src/domain.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Deployed generation the receipt is collected against, and the upgraded
 * receiver generation that must still admit that exact immutable receipt. */
const DEPLOYED_LAB_SHA = "d".repeat(40);
const UPGRADED_LAB_SHA = "ab".repeat(20);
const LANGGRAPH_SHA = "e".repeat(40);

/** The receiver's owner-dispatch endpoint as the fixture's fetch sees it. It
 * shares the fixture's control object, so tests that mutate f.control() act on
 * the same record the receiver serves. */
type FixtureReceiver = {
  control: RecoveryControlRecord; serviceId: string; now: () => Date; authority: unknown;
  expectedRecoveryDeployment: { frontend: string; backend: string; voice: string };
  // Null while the deployed generation serves; set when the receiver is
  // upgraded with the exact approved receipt hash, mirroring production config.
  approvedReceiptSha256: string | null;
  failTerminationAppend: boolean;
  // Mirrors service.ts: the proof is persisted first, then the canonical
  // platform-termination event is appended under its durable dedupe key.
  terminations: Map<string, Record<string, unknown>>;
};

function receiverOwnerDispatch(receiver: FixtureReceiver, body: Record<string, unknown> & { action: string }): Response {
  const { control, serviceId, now } = receiver;
  let dispatchAllowed = false;
  if (body.action === "prepare") { control.genericOwnerDispatch = prepareGenericOwnerDispatch(control, { ...body, workerServiceId: serviceId } as never, now()); control.version++; }
  if (body.action === "consume") { dispatchAllowed = control.genericOwnerDispatch?.consumedAt === null; control.genericOwnerDispatch = consumeGenericOwnerDispatch(control, body as never, now()); if (dispatchAllowed) control.version++; }
  if (body.action === "ingest_service_fence") {
    // The deployed generation cannot parse a v2 receipt at all.
    if (receiver.approvedReceiptSha256 === null) return new Response("{}", { status: 400 });
    const result = ingestGenericOwnerLoss(control, { ...body, authority: receiver.authority,
      expectedWorkerServiceIdSha256: sha256(serviceId), expectedRecoveryDeployment: receiver.expectedRecoveryDeployment, expectedLangGraphSha: LANGGRAPH_SHA,
      expectedLabSha: serviceFenceSourceLabSha(body.receipt, UPGRADED_LAB_SHA, receiver.approvedReceiptSha256) } as never, now());
    control.genericOwnerLoss = result.proof; control.version = result.version;
    if (receiver.failTerminationAppend) { receiver.failTerminationAppend = false; return new Response("{}", { status: 500 }); }
    const termination = derivePlatformExecutionTermination(control, result.proof as never);
    receiver.terminations.set(termination.dedupeKey, termination.payload);
  }
  if (!["inspect", "prepare", "consume", "ingest_service_fence"].includes(body.action)) throw new Error("Unexpected mutation");
  return new Response(JSON.stringify({ control, dispatchAllowed, workerServiceId: serviceId }), { status: 200 });
}

async function crossGenerationFixture(options: { retired?: boolean; preActionInventoryId?: string; failTerminationAppendOnce?: boolean; preActionGateOpen?: boolean; staleHeartbeat?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vt00-cross-gen-")); dirs.push(dir);
  const keys = { external_mcp_client: path.join(dir, "client.key"), deployment_control: path.join(dir, "deploy.key"), platform_plugin: path.join(dir, "platform.key") };
  const initialized = await initializeAuthorityFiles({ publicConfigPath: path.join(dir, "public.json"), transportTokensPath: path.join(dir, "tokens.json"), privateKeyPaths: keys,
    keyIds: { external_mcp_client: "test-client-key", deployment_control: "test-deploy-key", platform_plugin: "test-platform-key" } });
  const run = testRun(); let clock = run.createdAt.getTime() + 10_000;
  const now = () => new Date(clock);
  const serviceId = "srv-0123456789abcdefghij";
  // Real Render shape; its inventory projection drops the replica-set segment.
  const allocatedWorkerId = `${serviceId}-65566bc6c7-2gj6p`;
  const originalInventoryId = renderInventoryInstanceId(allocatedWorkerId)!;

  let control: RecoveryControlRecord = { binding: projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`), version: 2,
    browserAllocationEver: true, browserAllocationBinding: deriveRecoveryBrowserBinding(run.id, allocatedWorkerId, 1),
    liveCleanupComplete: false, remotePurgeComplete: false, contentPurgedAt: now(), retentionPurgeDueAt: null };

  const acquisition: LabEvent[] = [
    { runId: run.id, seq: 1, kind: "harness.browser_process_acquired", source: "browser", at: now(), dedupeKey: null, payload: {
      schema: "sophia_voice_lab_browser_process_ownership_v1", voice_lab_run_id_sha256: sha256(run.id),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), process_id_sha256: "a".repeat(64),
      browser_boot_id_sha256: "b".repeat(64), execution_epoch_sha256: "c".repeat(64),
      one_process_per_run: true, raw_process_id_excluded: true } },
    { runId: run.id, seq: 2, kind: "harness.browser_runtime_acquired", source: "canonical", at: now(), dedupeKey: null, payload: {
      worker_id_sha256: sha256(allocatedWorkerId), browser_lease_epoch: 1 } },
  ];
  control.executionOwnership = deriveExecutionOwnership(run, acquisition);

  let restartedAt: Date | null = null;
  let restarts = 0;
  const entries: ServiceOwnerFenceCheckpoint[] = [];
  const expectedRecoveryDeployment = { frontend: "1".repeat(40), backend: "2".repeat(40), voice: "3".repeat(40) };
  const receiver: FixtureReceiver = { control, serviceId, now, authority: initialized.publicConfig.deployment_control, expectedRecoveryDeployment,
    approvedReceiptSha256: null, failTerminationAppend: options.failTerminationAppendOnce === true, terminations: new Map() };
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname.endsWith("owner-dispatch")) return receiverOwnerDispatch(receiver, JSON.parse(String(init?.body)));
    // Three pods: the ORIGINAL owner; replacement A, the supported same-SHA
    // closure deploy that already retired it (retired); and replacement B,
    // produced by this collector's own one-shot restart.
    const { inventory: liveInventoryId, full: liveFullId } = restartedAt !== null
      ? { inventory: `${serviceId}-9kd2f`, full: `${serviceId}-77ffaa1122-9kd2f` }
      : options.retired
        ? { inventory: options.preActionInventoryId ?? `${serviceId}-a1b2c`, full: `${serviceId}-5566778899-a1b2c` }
        : { inventory: options.preActionInventoryId ?? originalInventoryId, full: allocatedWorkerId };
    // The original pod booted with its execution gate open; only a new pod can close it.
    const gateClosed = !(options.preActionGateOpen === true && restartedAt === null);
    const heartbeatAt = options.staleHeartbeat === true ? new Date(now().getTime() - 60_000) : now();
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname === "/readyz") {
      const gate = { valid: true, open: false, voice_lab_enabled: false, voice_lab_kill_switch_engaged: true, voice_lab_mutation_ready: false };
      return json({ version: DEPLOYED_LAB_SHA, execution: "kill_switch_engaged", active_runs: 1, mutation_ready: false, product_mutation_gates_open: false,
        components: { database: { ready: true }, browser_worker: { runtime_ready: true, live_workers: 1, execution_gate_settled: gateClosed, observed_kill_switch_engaged: gateClosed,
          heartbeat_attestation: { service_version: DEPLOYED_LAB_SHA, repository_candidate_sha: DEPLOYED_LAB_SHA,
            worker_instance_id_sha256: sha256(liveFullId), render_inventory_instance_id_sha256: sha256(liveInventoryId), observed_at: heartbeatAt.toISOString() } },
          test_auth: { ok: true, frontend_kill_switch_engaged: true, mutation_gate_order_safe: true },
          target_environment: { builds: { frontend: { observed: expectedRecoveryDeployment.frontend }, backend: { observed: expectedRecoveryDeployment.backend, product_mutation_gate: gate },
            voice: { observed: expectedRecoveryDeployment.voice, product_mutation_gate: gate }, langgraph: { observed: LANGGRAPH_SHA } } } } });
    }
    expect(url.origin).toBe("https://api.render.com");
    if (init?.method === "POST") { restarts++; restartedAt = now(); return json({ restarted: true }); }
    const createdAt = (restartedAt ?? run.createdAt).toISOString();
    if (url.pathname.endsWith("/instances")) return json([{ id: liveInventoryId, createdAt }]);
    if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: restartedAt ? "dep-abcdefghij0123456789" : "dep-0123456789abcdefghij", status: "live", createdAt, updatedAt: createdAt, finishedAt: createdAt } }]);
    return json({ id: serviceId, name: "sophia-voice-lab-worker", type: "background_worker" });
  };

  const input = { runId: run.id, requestId: run.id, workerServiceId: serviceId, allocatedWorkerId, voiceLabOrigin: GENERIC_RECOVERY_ORIGIN,
    generation: "v2" as const, expectedLabSha: DEPLOYED_LAB_SHA, expectedLangGraphSha: LANGGRAPH_SHA, expectedRecoveryDeployment,
    renderBearer: "test-render-source-only", deploymentBearer: "test-deployment-source-only",
    publicConfig: initialized.publicConfig, privateKeyPath: keys.deployment_control,
    checkpoint: async (entry: ServiceOwnerFenceCheckpoint) => { entries.push(structuredClone(entry)); },
    fetchImpl, now, sleep: async (ms: number) => { clock += ms; }, intervalMs: 10_000, timeoutMs: 400_000 };
  return { input, run, serviceId, allocatedWorkerId, originalInventoryId, initialized,
    expectedRecoveryDeployment, control: () => control, entries, restarts: () => restarts, terminations: () => receiver.terminations.size,
    advance: (ms: number) => { clock += ms; },
    upgradeReceiver: (approvedReceiptSha256: string) => { receiver.approvedReceiptSha256 = approvedReceiptSha256; } };
}

/** Writes the operator's secure CLI inputs exactly as production supplies them. */
async function cliFiles(f: Awaited<ReturnType<typeof crossGenerationFixture>>) {
  const dir = path.dirname(f.input.privateKeyPath);
  const bundle = path.join(dir, "cli-journal"); await mkdir(bundle, { mode: 0o700 });
  const { runId, requestId, workerServiceId, allocatedWorkerId, voiceLabOrigin, generation, expectedLabSha, expectedLangGraphSha, expectedRecoveryDeployment } = f.input;
  const { originalOwnerPreAction } = f.input as { originalOwnerPreAction?: "present" | "absent" };
  const inputPath = path.join(dir, "input.json"), renderPath = path.join(dir, "render.json");
  await writeFile(inputPath, JSON.stringify({ runId, requestId, workerServiceId, allocatedWorkerId, voiceLabOrigin, generation,
    ...(originalOwnerPreAction ? { originalOwnerPreAction } : {}), expectedLabSha, expectedLangGraphSha, expectedRecoveryDeployment }), { mode: 0o600 });
  await writeFile(renderPath, JSON.stringify({ bearer_token: "synthetic-render-token-00000000000000000000" }), { mode: 0o600 });
  const args = ["--input", inputPath, "--public-config", path.join(dir, "public.json"), "--transport-tokens", path.join(dir, "tokens.json"),
    "--deployment-key", f.input.privateKeyPath, "--bundle-dir", bundle];
  const runtime = { serviceOwnerFence: { fetchImpl: f.input.fetchImpl, sleep: f.input.sleep, now: f.input.now } };
  return { args, renderPath, runtime };
}

it("collects a v2 receipt against the deployed generation and admits it after upgrade", async () => {
  const f = await crossGenerationFixture();

  // 1. Collect BEFORE any worker deployment, while the original pod is present.
  const collected = await collectServiceOwnerFence(f.input as never);
  expect(collected.status).toBe("receipt_collected");
  const receipt = collected.receipt as Record<string, unknown>;
  expect(receipt.schema).toBe("sophia.voice-lab.service-owner-fence-receipt.v2");
  expect(receipt.expectedLabSha).toBe(DEPLOYED_LAB_SHA);
  expect(receipt.executionEpochSha256).toBe(f.control().executionOwnership!.executionEpochSha256);
  // Pre-action snapshot is the ORIGINAL owner's inventory projection.
  expect((receipt.before as { instanceIdsSha256: string[] }).instanceIdsSha256[0]).toBe(sha256(f.originalInventoryId));
  expect((receipt.after as { instanceIdsSha256: string[] }).instanceIdsSha256[0]).not.toBe(sha256(f.originalInventoryId));

  // 2. The receiver is upgraded. Admission inputs mirror the production call.
  const approved = canonicalRequestHash(receipt);
  const ingest = (labSha: string, approvedHash: string | null) => ingestGenericOwnerLoss(f.control() as never, {
    runId: f.run.id, expectedVersion: f.control().version, receipt,
    authority: f.initialized.publicConfig.deployment_control, expectedWorkerServiceIdSha256: sha256(f.serviceId),
    expectedRecoveryDeployment: f.expectedRecoveryDeployment, expectedLangGraphSha: LANGGRAPH_SHA,
    expectedLabSha: serviceFenceSourceLabSha(receipt, labSha, approvedHash),
  } as never, new Date(Date.parse(receipt.issuedAt as string) + 1_000));

  // Without the exact approved hash the upgraded receiver refuses: no broad
  // version waiver exists, and the old run's target is never rewritten.
  expect(() => ingest(UPGRADED_LAB_SHA, null)).toThrow();
  expect(() => ingest(UPGRADED_LAB_SHA, "f".repeat(64))).toThrow();

  // With the exact immutable receipt hash the existing exception admits it.
  const admitted = ingest(UPGRADED_LAB_SHA, approved);
  expect(admitted.replay).toBe(false);
  expect(admitted.proof.schema).toBe("sophia.voice-lab.verified-service-owner-fence.v2");
  expect(admitted.proof.expectedLabSha).toBe(DEPLOYED_LAB_SHA);

  // 3. Immutable replay across the same upgraded receiver.
  const control = f.control();
  control.genericOwnerLoss = admitted.proof;
  control.version = admitted.version;
  const replayed = ingest(UPGRADED_LAB_SHA, approved);
  expect(replayed.replay).toBe(true);
  expect(canonicalRequestHash(replayed.proof)).toBe(canonicalRequestHash(admitted.proof));
});

it("refuses a v2 collection without retained ownership before any provider mutation", async () => {
  const f = await crossGenerationFixture();
  let restarts = 0;
  const guarded: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    if (url.origin === "https://api.render.com" && init?.method === "POST") restarts++;
    return f.input.fetchImpl(raw as never, init as never);
  };
  delete (f.control() as { executionOwnership?: unknown }).executionOwnership;
  await expect(collectServiceOwnerFence({ ...f.input, fetchImpl: guarded } as never)).rejects.toThrow();
  // The single provider mutation must never have been attempted.
  expect(restarts).toBe(0);
  expect(f.entries.map(entry => entry.phase)).not.toContain("consumed");
  expect(f.entries.map(entry => entry.phase)).not.toContain("accepted");
});

it("binds generation and ownership into the journal scope", async () => {
  const a = await crossGenerationFixture();
  await collectServiceOwnerFence(a.input as never);
  const v2Scope = (a.entries.find(entry => entry.phase === "prepared")!.value as { scopeSha256: string }).scopeSha256;

  const b = await crossGenerationFixture();
  await collectServiceOwnerFence({ ...b.input, generation: "v1" } as never).catch(() => undefined);
  const v1Prepared = b.entries.find(entry => entry.phase === "prepared");
  if (v1Prepared) expect((v1Prepared.value as { scopeSha256: string }).scopeSha256).not.toBe(v2Scope);

  // A resume carrying another generation's scope is refused.
  await expect(collectServiceOwnerFence({ ...a.input, generation: "v1",
    resume: { prepared: { ...(a.entries.find(e => e.phase === "prepared")!.value as object) } } } as never)).rejects.toThrow(/resume scope mismatch/);
});

it("keeps the historical v1 resume scope hash unchanged", async () => {
  const f = await crossGenerationFixture({ retired: true });
  const control = f.control();
  const legacyScope = canonicalRequestHash({ runId: f.run.id, requestId: f.run.id, workerServiceId: f.serviceId,
    allocatedWorkerIdSha256: sha256(f.allocatedWorkerId), controlBindingSha256: canonicalRequestHash(control.binding),
    allocationBindingSha256: canonicalRequestHash(control.browserAllocationBinding), expectedLabSha: DEPLOYED_LAB_SHA,
    expectedLangGraphSha: LANGGRAPH_SHA, expectedRecoveryDeployment: f.expectedRecoveryDeployment,
    authority: f.initialized.publicConfig.deployment_control });
  await collectServiceOwnerFence({ ...f.input, generation: "v1" } as never).catch(() => undefined);
  const prepared = f.entries.find(entry => entry.phase === "prepared");
  expect(prepared).toBeDefined();
  expect((prepared!.value as { scopeSha256: string }).scopeSha256).toBe(legacyScope);
});

const WRONG = [
  ["another run", (o: Record<string, unknown>) => ({ ...o, runIdSha256: sha256("other-run") })],
  ["another obligation", (o: Record<string, unknown>) => ({ ...o, cleanupObligationIdSha256: sha256("other-obligation") })],
  ["another owner", (o: Record<string, unknown>) => ({ ...o, workerIdSha256: sha256("srv-0123456789abcdefghij-aaaaaaaaaa-zzzzz") })],
  ["another lease epoch", (o: Record<string, unknown>) => ({ ...o, browserLeaseEpoch: 2 })],
] as const;

it.each(WRONG)("refuses a validly re-digested ownership proof for %s before any mutation", async (_label, mutate) => {
  const f = await crossGenerationFixture();
  let restarts = 0;
  const guarded: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    if (url.origin === "https://api.render.com" && init?.method === "POST") restarts++;
    return f.input.fetchImpl(raw as never, init as never);
  };
  const { proofSha256: _old, ...core } = f.control().executionOwnership as unknown as Record<string, unknown>;
  const drifted = mutate(core);
  // Re-digest so the proof is internally valid: only the BINDING is wrong.
  f.control().executionOwnership = { ...drifted, proofSha256: canonicalRequestHash(drifted) } as never;
  await expect(collectServiceOwnerFence({ ...f.input, fetchImpl: guarded } as never)).rejects.toThrow(/does not bind this run allocation/);
  expect(restarts).toBe(0);
  expect(f.entries.map(entry => entry.phase)).not.toContain("consumed");
});

it("collects v2 through the operator CLI and publishes it to the upgraded receiver", async () => {
  // The production route is the CLI, not the library call: the input file must
  // be able to select v2, and the publisher must carry the control's retained
  // execution ownership or it can never verify a v2 receipt.
  const f = await crossGenerationFixture();
  const { args, renderPath, runtime } = await cliFiles(f);
  const output: string[] = [];
  const collected = await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime);
  expect(collected, output.join("\n")).toBe(0);
  const summary = JSON.parse(output.at(-1)!);
  expect(summary).toMatchObject({ status: "receipt_collected", durable_recovery_ingested: false, cleanup_proven: false });
  expect(f.restarts()).toBe(1);

  // Upgrade the receiver with exactly the printed immutable receipt hash.
  f.upgradeReceiver(summary.receipt_sha256);
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime), output.join("\n")).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "ingested", durable_recovery_ingested: true, cleanup_proven: false });
  const stored = f.control().genericOwnerLoss as { schema: string; expectedLabSha: string };
  expect(stored.schema).toBe("sophia.voice-lab.verified-service-owner-fence.v2");
  expect(stored.expectedLabSha).toBe(DEPLOYED_LAB_SHA);
  // Exact replay publishes nothing new and never repeats the restart.
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).toBe(0);
  expect(f.restarts()).toBe(1);
  expect(output.join("\n")).not.toContain(f.allocatedWorkerId);
  expect(output.join("\n")).not.toContain("synthetic-render-token");
});

it("refuses before any mutation when the live inventory is not the original owner's projection", async () => {
  // Heartbeat full identity is the original owner and the heartbeat projection
  // agrees with Render, but neither equals the supported projection of the
  // allocated id. The signed receipt would be refused AFTER the one-shot
  // restart, so the collector must refuse before preparing it.
  const f = await crossGenerationFixture({ preActionInventoryId: "srv-0123456789abcdefghij-zzzzz" });
  await expect(collectServiceOwnerFence(f.input as never)).rejects.toThrow(/inventory projection/);
  expect(f.restarts()).toBe(0);
  expect(f.control().genericOwnerDispatch).toBeUndefined();
  expect(f.entries).toHaveLength(0);
});

it("admits the v2 receipt after a realistic receiver rebuild between collection and publication", async () => {
  // The ordering is fixed: collect against the deployed generation, THEN build
  // and deploy the receiver that can parse v2, THEN publish. A render build has
  // been observed to take ~22 minutes after a clone retry, and the consumed
  // one-shot dispatch can never be collected again, so the signed validity
  // window must cover the rebuild or the run becomes unsettleable.
  const f = await crossGenerationFixture();
  const { args, renderPath, runtime } = await cliFiles(f);
  const output: string[] = [];
  expect(await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime), output.join("\n")).toBe(0);
  const summary = JSON.parse(output.at(-1)!);
  f.advance(30 * 60_000);
  f.upgradeReceiver(summary.receipt_sha256);
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime), output.join("\n")).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "ingested", durable_recovery_ingested: true, cleanup_proven: false });
  expect(f.restarts()).toBe(1);
});

it("still refuses a v2 receipt once its bounded validity has elapsed", async () => {
  const f = await crossGenerationFixture();
  const { args, renderPath, runtime } = await cliFiles(f);
  const output: string[] = [];
  expect(await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime)).toBe(0);
  const summary = JSON.parse(output.at(-1)!);
  f.advance(2 * 60 * 60_000 + 1_000);
  f.upgradeReceiver(summary.receipt_sha256);
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).not.toBe(0);
  expect(f.control().genericOwnerLoss).toBeUndefined();
  expect(f.restarts()).toBe(1);
});

it("never reports a v2 publication settled while the canonical termination may be missing", async () => {
  // The receiver persists the proof and THEN appends the platform-termination
  // event. If that append fails, the proof is visible but the only event the
  // cleanup evaluator accepts is absent. The publisher must not call that
  // ingested, and a later publication must replay ingestion so the idempotent
  // receiver writes the event.
  const f = await crossGenerationFixture({ failTerminationAppendOnce: true });
  const { args, renderPath, runtime } = await cliFiles(f);
  const output: string[] = [];
  expect(await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime)).toBe(0);
  f.upgradeReceiver(JSON.parse(output.at(-1)!).receipt_sha256);

  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).not.toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "unconfirmed", durable_recovery_ingested: false });
  expect(f.terminations()).toBe(0);

  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime), output.join("\n")).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "ingested", durable_recovery_ingested: true, cleanup_proven: false });
  expect(f.terminations()).toBe(1);
  // Further replays are immutable and never add a second settlement.
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).toBe(0);
  expect(f.terminations()).toBe(1);
  expect(f.restarts()).toBe(1);
});

it("replays v2 ingestion even after independent settlement when the termination is still missing", async () => {
  // C007: the proof persisted, the termination append failed, then an
  // independent recovery settled the control (liveCleanupComplete). A settled
  // flag is not evidence the canonical termination exists, so the publisher
  // must still replay the immutable ingestion that writes it.
  const f = await crossGenerationFixture({ failTerminationAppendOnce: true });
  const { args, renderPath, runtime } = await cliFiles(f);
  const output: string[] = [];
  expect(await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime)).toBe(0);
  f.upgradeReceiver(JSON.parse(output.at(-1)!).receipt_sha256);
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).not.toBe(0);
  expect(f.terminations()).toBe(0);
  const proof = structuredClone(f.control().genericOwnerLoss);

  f.control().liveCleanupComplete = true;
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime), output.join("\n")).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "ingested", durable_recovery_ingested: true, cleanup_proven: false });
  expect(f.terminations()).toBe(1);

  // A fully completed retry stays harmless: same proof, one termination, one restart.
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).toBe(0);
  expect(f.terminations()).toBe(1);
  expect(f.control().genericOwnerLoss).toEqual(proof);
  expect(f.restarts()).toBe(1);
});

// ---- C016: explicit original-owner-absent v2 mode ----------------------------

/** Counts provider restarts; every refusal below must happen before one. */
function guardRestarts(f: Awaited<ReturnType<typeof crossGenerationFixture>>) {
  let restarts = 0;
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    if (url.origin === "https://api.render.com" && init?.method === "POST") restarts++;
    return f.input.fetchImpl(raw as never, init as never);
  };
  return { fetchImpl, restarts: () => restarts };
}

it("collects an explicit absent-mode v2 receipt and publishes a truthful proof and termination", async () => {
  const f = await crossGenerationFixture({ retired: true });
  (f.input as Record<string, unknown>).originalOwnerPreAction = "absent";
  const { args, renderPath, runtime } = await cliFiles(f);
  const output: string[] = [];
  expect(await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime), output.join("\n")).toBe(0);
  f.upgradeReceiver(JSON.parse(output.at(-1)!).receipt_sha256);
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime), output.join("\n")).toBe(0);
  expect(f.control().genericOwnerLoss).toMatchObject({ schema: "sophia.voice-lab.verified-service-owner-fence.v2", originalOwnerPreAction: "absent" });
  expect(f.terminations()).toBe(1);
  const termination = derivePlatformExecutionTermination(f.control(), f.control().genericOwnerLoss as never);
  expect(termination.payload).toMatchObject({ original_owner_pre_action: "absent", owner_replacement_observed: true,
    browser_context_closed_fabricated: false, provider_cleanup_proven: false, live_resources_zero_proven: false });
  expect(f.restarts()).toBe(1);
});

it.each([
  // The present-mode preflight requires the heartbeat to be the original owner.
  ["present mode while the original is already absent", { retired: true }, "present", /live worker identity is stale or mismatched/],
  ["absent mode while the original is still present", {}, "absent", /original owner is still current/],
  ["absent mode while the live inventory is the original's projection", { retired: true, preActionInventoryId: "srv-0123456789abcdefghij-2gj6p" }, "absent", /still present/],
  ["absent mode with the execution gate open", { retired: true, preActionGateOpen: true }, "absent", /execution_gate_settled|observed_kill_switch_engaged/],
  ["absent mode with a stale heartbeat", { retired: true, staleHeartbeat: true }, "absent", /stale or mismatched/],
] as const)("refuses %s before any mutation", async (_label, options, preAction, message) => {
  const f = await crossGenerationFixture(options);
  const guard = guardRestarts(f);
  await expect(collectServiceOwnerFence({ ...f.input, originalOwnerPreAction: preAction, fetchImpl: guard.fetchImpl } as never)).rejects.toThrow(message);
  expect(guard.restarts()).toBe(0);
  expect(f.control().genericOwnerDispatch).toBeUndefined();
  expect(f.entries).toHaveLength(0);
});

it("refuses absent mode with missing or drifted execution ownership before any mutation", async () => {
  for (const drift of ["missing", "another-owner"] as const) {
    const f = await crossGenerationFixture({ retired: true });
    const guard = guardRestarts(f);
    if (drift === "missing") delete (f.control() as { executionOwnership?: unknown }).executionOwnership;
    else {
      const { proofSha256: _old, ...core } = f.control().executionOwnership as unknown as Record<string, unknown>;
      const drifted = { ...core, workerIdSha256: sha256("srv-0123456789abcdefghij-aaaaaaaaaa-zzzzz") };
      f.control().executionOwnership = { ...drifted, proofSha256: canonicalRequestHash(drifted) } as never;
    }
    await expect(collectServiceOwnerFence({ ...f.input, originalOwnerPreAction: "absent", fetchImpl: guard.fetchImpl } as never)).rejects.toThrow();
    expect(guard.restarts()).toBe(0);
    expect(f.entries.map(entry => entry.phase)).not.toContain("consumed");
  }
});

it("never selects absent mode implicitly and binds it into the signed receipt and journal scope", async () => {
  const f = await crossGenerationFixture({ retired: true });
  await expect(collectServiceOwnerFence({ ...f.input, generation: "v1", originalOwnerPreAction: "absent" } as never)).rejects.toThrow(/exists only for v2/);
  const absent = await crossGenerationFixture({ retired: true });
  const collected = await collectServiceOwnerFence({ ...absent.input, originalOwnerPreAction: "absent" } as never);
  const receipt = collected.receipt as Record<string, unknown> & { before: { instanceIdsSha256: string[] }; after: { instanceIdsSha256: string[] } };
  expect(receipt).toMatchObject({ schema: "sophia.voice-lab.service-owner-fence-receipt.v2", originalOwnerPreAction: "absent" });
  // Truthful pre-state: the original was already absent, and the action produced a further distinct singleton.
  expect(receipt.before.instanceIdsSha256[0]).not.toBe(sha256(absent.originalInventoryId));
  expect(receipt.after.instanceIdsSha256[0]).not.toBe(sha256(absent.originalInventoryId));
  expect(receipt.after.instanceIdsSha256[0]).not.toBe(receipt.before.instanceIdsSha256[0]);
  expect(absent.restarts()).toBe(1);
  // Flipping the signed claim either breaks the schema's pre-state rule or the signature.
  const { originalOwnerPreAction: _claim, ...asPresent } = receipt;
  expect(() => AnyServiceOwnerFenceReceiptSchema.parse(asPresent)).toThrow(/original owner present before/);
  // The mode is part of the journal scope, so an absent journal cannot be resumed as present.
  const scope = (absent.entries.find(entry => entry.phase === "prepared")!.value as { scopeSha256: string }).scopeSha256;
  const present = await crossGenerationFixture();
  await collectServiceOwnerFence(present.input as never);
  expect((present.entries.find(entry => entry.phase === "prepared")!.value as { scopeSha256: string }).scopeSha256).not.toBe(scope);
  await expect(collectServiceOwnerFence({ ...absent.input, resume: Object.fromEntries(absent.entries.map(entry => [entry.phase, entry.value])) } as never))
    .rejects.toThrow(/scope mismatch|not the original owner/);
});
