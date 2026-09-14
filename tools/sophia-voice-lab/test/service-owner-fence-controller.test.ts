import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { collectServiceOwnerFence, type ServiceOwnerFenceCheckpoint } from "../scripts/external-attestations/service-owner-fence-controller.js";
import { initializeAuthorityFiles } from "../scripts/external-attestations/crypto.js";
import { GENERIC_RECOVERY_ORIGIN } from "../scripts/external-attestations/generic-worker-preflight.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch } from "../src/generic-owner-dispatch.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { openServiceOwnerFenceJournal } from "../scripts/external-attestations/service-owner-fence-journal.js";
import { runCli } from "../scripts/external-attestations/cli.js";
import { ingestGenericOwnerLoss } from "../src/generic-owner-loss.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(mode: "ok" | "lost" | "open-after" = "ok") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vt00-service-fence-")); dirs.push(dir);
  const keys = { external_mcp_client: path.join(dir, "client.key"), deployment_control: path.join(dir, "deploy.key"), platform_plugin: path.join(dir, "platform.key") };
  const initialized = await initializeAuthorityFiles({ publicConfigPath: path.join(dir, "public.json"), transportTokensPath: path.join(dir, "tokens.json"), privateKeyPaths: keys,
    keyIds: { external_mcp_client: "test-client-key", deployment_control: "test-deploy-key", platform_plugin: "test-platform-key" } });
  const run = testRun(); let clock = run.createdAt.getTime() + 10000;
  const now = () => new Date(clock);
  const serviceId = "srv-0123456789abcdefghij";
  const allocatedWorkerId = `${serviceId}-retired-owner`;
  let control: RecoveryControlRecord = { binding: projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`), version: 2,
    browserAllocationEver: true, browserAllocationBinding: deriveRecoveryBrowserBinding(run.id, allocatedWorkerId, 1),
    liveCleanupComplete: false, remotePurgeComplete: false, contentPurgedAt: now(), retentionPurgeDueAt: null };
  let posts = 0, restartedAt: Date | null = null;
  const entries: ServiceOwnerFenceCheckpoint[] = [];
  const expectedRecoveryDeployment = { frontend: "1".repeat(40), backend: "2".repeat(40), voice: "3".repeat(40) };
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname.endsWith("owner-dispatch")) {
      const body = JSON.parse(String(init?.body)); let dispatchAllowed = false;
      if (body.action === "prepare") { control.genericOwnerDispatch = prepareGenericOwnerDispatch(control, { ...body, workerServiceId: serviceId }, now()); control.version++; }
      if (body.action === "consume") { dispatchAllowed = control.genericOwnerDispatch?.consumedAt === null; control.genericOwnerDispatch = consumeGenericOwnerDispatch(control, body, now()); if (dispatchAllowed) control.version++; }
      if (body.action === "ingest_service_fence") {
        const result = ingestGenericOwnerLoss(control, { ...body, authority: initialized.publicConfig.deployment_control,
          expectedWorkerServiceIdSha256: sha256(serviceId), expectedLabSha: "d".repeat(40), expectedLangGraphSha: "e".repeat(40), expectedRecoveryDeployment }, now());
        control.genericOwnerLoss = result.proof; control.version = result.version;
      }
      if (!["inspect", "prepare", "consume", "ingest_service_fence"].includes(body.action)) throw new Error("Unexpected mutation");
      return json({ control, dispatchAllowed, workerServiceId: serviceId });
    }
    const owner = restartedAt ? `${serviceId}-replacement-owner` : `${serviceId}-current-owner`;
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname === "/readyz") {
      const gate = { valid: true, open: false, voice_lab_enabled: false, voice_lab_kill_switch_engaged: true, voice_lab_mutation_ready: false };
      return json({ version: "d".repeat(40), execution: "kill_switch_engaged", active_runs: 1, mutation_ready: false, product_mutation_gates_open: false,
        components: { database: { ready: true }, browser_worker: { runtime_ready: true, live_workers: 1, execution_gate_settled: true, observed_kill_switch_engaged: true,
          heartbeat_attestation: { service_version: "d".repeat(40), repository_candidate_sha: "d".repeat(40), worker_instance_id_sha256: sha256(owner), observed_at: now().toISOString() } },
          test_auth: { ok: true, frontend_kill_switch_engaged: !(restartedAt && mode === "open-after"), mutation_gate_order_safe: true },
          target_environment: { builds: { frontend: { observed: expectedRecoveryDeployment.frontend }, backend: { observed: expectedRecoveryDeployment.backend, product_mutation_gate: gate },
            voice: { observed: expectedRecoveryDeployment.voice, product_mutation_gate: gate }, langgraph: { observed: "e".repeat(40) } } } } });
    }
    expect(url.origin).toBe("https://api.render.com");
    if (init?.method === "POST") {
      expect(url.pathname).toBe(`/v1/services/${serviceId}/restart`);
      expect(control.genericOwnerDispatch?.consumedAt).not.toBeNull();
      if (entries.length) expect(entries.at(-1)?.phase).toBe("consumed");
      posts++; restartedAt = now();
      if (mode === "lost") throw new Error("synthetic lost response");
      return json({ restarted: true });
    }
    const createdAt = (restartedAt ?? run.createdAt).toISOString();
    if (url.pathname.endsWith("/instances")) return json([{ id: owner, createdAt }]);
    if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: restartedAt ? "dep-abcdefghij0123456789" : "dep-0123456789abcdefghij", status: "live", createdAt, updatedAt: createdAt, finishedAt: createdAt } }]);
    return json({ id: serviceId, name: "sophia-voice-lab-worker", type: "background_worker" });
  };
  const input = { runId: run.id, requestId: run.id, workerServiceId: serviceId, allocatedWorkerId, voiceLabOrigin: GENERIC_RECOVERY_ORIGIN,
    expectedLabSha: "d".repeat(40), expectedLangGraphSha: "e".repeat(40), expectedRecoveryDeployment,
    renderBearer: "test-render-source-only", deploymentBearer: "test-deployment-source-only", publicConfig: initialized.publicConfig, privateKeyPath: keys.deployment_control,
    checkpoint: async (entry: ServiceOwnerFenceCheckpoint) => { entries.push(structuredClone(entry)); },
    fetchImpl, now, sleep: async (ms: number) => { clock += ms; }, intervalMs: 10000, timeoutMs: 400000 };
  return { input, entries, posts: () => posts, control: () => control, resume: () => Object.fromEntries(entries.map(e => [e.phase, e.value])) };
}

it("collects one source-owned service-fence receipt after the overlap bound, without settling", async () => {
  const f = await fixture();
  const result = await collectServiceOwnerFence(f.input);
  expect(result.status).toBe("receipt_collected"); expect(f.posts()).toBe(1);
  expect(result.receipt).toMatchObject({ providerCleanupProven: false, liveResourcesZeroProven: false });
  expect(Date.parse(result.receipt!.after.observedAt) - Date.parse(result.receipt!.actionAcceptedAt)).toBeGreaterThanOrEqual(360000);
  expect(f.entries.map(e => e.phase)).toEqual(["prepared", "consumed", "accepted", "receipt"]);
  expect((await collectServiceOwnerFence({ ...f.input, resume: f.resume() })).receipt).toEqual(result.receipt);
  expect(f.posts()).toBe(1); expect(f.control().liveCleanupComplete).toBe(false);
});
it("never redispatches a lost response or creates an accepted receipt from absence", async () => {
  const f = await fixture("lost");
  expect((await collectServiceOwnerFence(f.input)).status).toBe("unconfirmed");
  expect((await collectServiceOwnerFence({ ...f.input, resume: f.resume() })).status).toBe("unconfirmed");
  expect(f.posts()).toBe(1); expect(f.entries.map(e => e.phase)).toEqual(["prepared", "consumed"]);
});
it("rejects an opened replacement gate and altered resume scope", async () => {
  const f = await fixture("open-after");
  await expect(collectServiceOwnerFence(f.input)).rejects.toThrow();
  expect(f.posts()).toBe(1);
  await expect(collectServiceOwnerFence({ ...f.input, expectedLabSha: "f".repeat(40), resume: f.resume() })).rejects.toThrow(/scope/);
  expect(f.posts()).toBe(1); expect(f.entries.some(e => e.phase === "receipt")).toBe(false);
});
it("does not restart if consumed checkpoint persistence fails", async () => {
  const f = await fixture();
  await expect(collectServiceOwnerFence({ ...f.input, checkpoint: async entry => {
    if (entry.phase === "consumed") throw new Error("synthetic disk failure");
    await f.input.checkpoint(entry);
  } })).rejects.toThrow(/disk failure/);
  expect(f.posts()).toBe(0);
  expect((await collectServiceOwnerFence({ ...f.input, resume: f.resume() })).status).toBe("unconfirmed");
  expect(f.posts()).toBe(0);
});

it("resumes from authenticated real disk checkpoints and rejects wrong keys or altered bytes", async () => {
  const f = await fixture();
  const directory = path.join(path.dirname(f.input.privateKeyPath), "journal"); await mkdir(directory, { mode: 0o700 });
  const macKey = await readFile(f.input.privateKeyPath);
  const options = { directory, inputSha256: sha256("exact-test-input"), macKey, resume: false };
  const journal = await openServiceOwnerFenceJournal(options);
  const result = await collectServiceOwnerFence({ ...f.input, checkpoint: async entry => { await journal.checkpoint(entry); await f.input.checkpoint(entry); } });
  const restarted = await openServiceOwnerFenceJournal({ ...options, resume: true });
  expect((await collectServiceOwnerFence({ ...f.input, resume: restarted.resume, checkpoint: restarted.checkpoint })).receipt).toEqual(result.receipt);
  expect(f.posts()).toBe(1);
  const files = (await readdir(directory)).filter(n => !n.startsWith(".")); expect(files).toHaveLength(5);
  for (const name of files) expect((await stat(path.join(directory, name))).mode & 0o077).toBe(0);
  await expect(openServiceOwnerFenceJournal({ ...options, resume: true, macKey: Buffer.alloc(64, 3) })).rejects.toThrow(/authentication/);
  await expect(openServiceOwnerFenceJournal({ ...options, resume: true, inputSha256: sha256("changed-input") })).rejects.toThrow(/scope/);
  const filename = path.join(directory, "003-service-owner-fence.json");
  const changed = JSON.parse(await readFile(filename, "utf8")); changed.payload.httpStatus = 201;
  await writeFile(filename, JSON.stringify(changed), { mode: 0o600 });
  await expect(openServiceOwnerFenceJournal({ ...options, resume: true })).rejects.toThrow(/authentication/);
});

it("allows only one competing disk append and poisons the losing writer", async () => {
  const f = await fixture(); await collectServiceOwnerFence(f.input);
  const directory = path.join(path.dirname(f.input.privateKeyPath), "race"); await mkdir(directory, { mode: 0o700 });
  const options = { directory, inputSha256: sha256("race-scope"), macKey: await readFile(f.input.privateKeyPath), resume: false };
  const first = await openServiceOwnerFenceJournal(options);
  const second = await openServiceOwnerFenceJournal({ ...options, resume: true });
  const entry = f.entries[0]!;
  const results = await Promise.allSettled([first.checkpoint(entry), second.checkpoint(entry)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const loser = results[0]!.status === "rejected" ? first : second;
  await expect(loser.checkpoint(entry)).rejects.toThrow(/fresh resume/);
  expect((await openServiceOwnerFenceJournal({ ...options, resume: true })).resume?.prepared).toEqual(entry.value);
});

it("runs secure CLI collection and journal publication end-to-end without repeating the restart", async () => {
  const f = await fixture();
  const dir = path.dirname(f.input.privateKeyPath);
  const bundle = path.join(dir, "cli-journal"); await mkdir(bundle, { mode: 0o700 });
  const { runId, requestId, workerServiceId, allocatedWorkerId, voiceLabOrigin, expectedLabSha, expectedLangGraphSha, expectedRecoveryDeployment } = f.input;
  const inputPath = path.join(dir, "input.json"), renderPath = path.join(dir, "render.json");
  await writeFile(inputPath, JSON.stringify({ runId, requestId, workerServiceId, allocatedWorkerId, voiceLabOrigin,
    expectedLabSha, expectedLangGraphSha, expectedRecoveryDeployment }), { mode: 0o600 });
  await writeFile(renderPath, JSON.stringify({ bearer_token: "synthetic-render-token-00000000000000000000" }), { mode: 0o600 });
  const args = ["--input", inputPath, "--public-config", path.join(dir, "public.json"), "--transport-tokens", path.join(dir, "tokens.json"),
    "--deployment-key", f.input.privateKeyPath, "--bundle-dir", bundle];
  const output: string[] = [];
  const runtime = { serviceOwnerFence: { fetchImpl: f.input.fetchImpl, sleep: f.input.sleep, now: f.input.now } };
  const collected = await runCli(["collect-service-owner-fence", ...args, "--render-token", renderPath], line => output.push(line), runtime);
  expect(collected, output.join("\n")).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "receipt_collected", durable_recovery_ingested: false });
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: "ingested", durable_recovery_ingested: true, cleanup_proven: false });
  f.control().liveCleanupComplete = true;
  expect(await runCli(["publish-service-owner-fence", ...args], line => output.push(line), runtime)).toBe(0);
  expect(f.posts()).toBe(1);
  expect(output.join("\n")).not.toContain(allocatedWorkerId);
  expect(output.join("\n")).not.toContain("synthetic-render-token");
  expect(output.join("\n")).not.toContain("PRIVATE KEY");
});
