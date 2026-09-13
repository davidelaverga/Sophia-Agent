import { mkdtemp, rm, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { initializeAuthorityFiles } from "../scripts/external-attestations/crypto.js";
import { executeGenericWorkerTermination, type GenericWorkerControllerCheckpoint } from "../scripts/external-attestations/generic-worker-controller.js";
import { GENERIC_RECOVERY_ORIGIN } from "../scripts/external-attestations/generic-worker-preflight.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabService } from "../src/service.js";
import { sha256 } from "../src/security.js";
import { openGenericWorkerJournal } from "../scripts/external-attestations/generic-worker-journal.js";
import { readSecureJson, writeNewSecureJson } from "../scripts/external-attestations/secure-files.js";
import { runCli } from "../scripts/external-attestations/cli.js";
import { testConfig, testRun } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(mode: "ok" | "lost-response" | "open-after" | "lost-ingestion-response" = "ok") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vt00-generic-source-")); directories.push(directory);
  const keys = { external_mcp_client: path.join(directory, "client.key"), deployment_control: path.join(directory, "deploy.key"), platform_plugin: path.join(directory, "platform.key") };
  const initialized = await initializeAuthorityFiles({ publicConfigPath: path.join(directory, "public.json"), transportTokensPath: path.join(directory, "tokens.json"), privateKeyPaths: keys,
    keyIds: { external_mcp_client: "client-key-test", deployment_control: "deploy-key-test", platform_plugin: "platform-key-test" } });
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true", SOPHIA_VOICE_LAB_GENERIC_RECOVERY_WORKER_SERVICE_ID: "srv-0123456789abcdefghij" });
  const ledger = new MemoryVoiceLabLedger("test");
  const service = new VoiceLabService(ledger, config, async () => []);
  const run = testRun({ state: "failed_harness" });
  config.readinessTarget = run.target;
  const deploymentAuthority = initialized.publicConfig.deployment_control;
  config.attestationAuthorities.deployment_control = { issuer: deploymentAuthority.issuer, subject: deploymentAuthority.subject,
    keyId: deploymentAuthority.key_id, publicKeySpkiBase64: deploymentAuthority.public_key_spki_base64 };
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const originalOwner = "render-source-owner";
  const lease = await ledger.upsertBrowserLease(run.id, originalOwner, 60);
  await ledger.releaseBrowserLease(run.id, originalOwner, lease.leaseEpoch);
  const oldAt = new Date(Date.now() - 60000).toISOString();
  let replacementAt: string | null = null;
  let renderPosts = 0;
  let ingestionResponseLost = false;
  const entries: GenericWorkerControllerCheckpoint[] = [];
  const fetchImpl = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const owner = replacementAt ? "render-source-replacement" : originalOwner;
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname.endsWith("/owner-dispatch")) {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer source-deployment-credential");
      const body = JSON.parse(String(init?.body));
      const result = await service.genericOwnerDispatch({ subject: config.attestationAuthorities.deployment_control.subject,
        scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" }, body);
      if (body.action === "ingest_owner_loss" && mode === "lost-ingestion-response" && !ingestionResponseLost) {
        ingestionResponseLost = true; throw new Error("Synthetic lost committed ingestion response");
      }
      return json(result);
    }
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname === "/readyz") {
      const gate = { valid: true, open: false, voice_lab_enabled: false, voice_lab_kill_switch_engaged: true, voice_lab_mutation_ready: false };
      return json({ version: config.serviceVersion, execution: "kill_switch_engaged", active_runs: 1, mutation_ready: false, product_mutation_gates_open: false,
        components: { database: { ready: true }, browser_worker: { runtime_ready: true, live_workers: 1, execution_gate_settled: true, observed_kill_switch_engaged: true,
          heartbeat_attestation: { service_version: config.serviceVersion, repository_candidate_sha: config.serviceVersion, worker_instance_id_sha256: sha256(owner), observed_at: new Date().toISOString() } },
          test_auth: { ok: true, frontend_kill_switch_engaged: !(replacementAt && mode === "open-after"), mutation_gate_order_safe: true },
          target_environment: { builds: { frontend: { observed: run.target.expectedDeployment.frontend }, backend: { observed: run.target.expectedDeployment.backend, product_mutation_gate: gate },
            voice: { observed: run.target.expectedDeployment.voice, product_mutation_gate: gate }, langgraph: { observed: "d".repeat(40) } } } } }, 503);
    }
    if (url.origin !== "https://api.render.com") throw new Error("Unexpected source origin");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer source-render-credential");
    if (method === "POST") {
      expect(url.pathname).toBe(`/v1/services/${config.genericRecoveryWorkerServiceId}/restart`);
      renderPosts++;
      expect(entries.at(-1)?.phase).toBe("consumed");
      replacementAt = new Date().toISOString();
      if (mode === "lost-response") throw new Error("Synthetic lost provider response");
      return json({ accepted: true });
    }
    if (url.pathname.endsWith("/instances")) return json([{ instance: { id: owner, createdAt: replacementAt ?? oldAt } }]);
    if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: "dep-0123456789abcdefghij", status: "live", createdAt: replacementAt ?? oldAt, startedAt: replacementAt ?? oldAt, updatedAt: replacementAt ?? oldAt, finishedAt: replacementAt ?? oldAt } }]);
    return json({ service: { id: config.genericRecoveryWorkerServiceId, name: "sophia-voice-lab-worker", type: "background_worker" } });
  });
  const input = { runId: run.id, requestId: randomUUID(), workerServiceId: config.genericRecoveryWorkerServiceId!, voiceLabOrigin: GENERIC_RECOVERY_ORIGIN,
    expectedLabSha: config.serviceVersion, expectedLangGraphSha: "d".repeat(40), renderBearer: "source-render-credential", deploymentBearer: "source-deployment-credential",
    publicConfig: initialized.publicConfig, privateKeyPath: keys.deployment_control, checkpoint: async (entry: GenericWorkerControllerCheckpoint) => { entries.push(structuredClone(entry)); },
    fetchImpl: fetchImpl as typeof fetch, timeoutMs: 1000, intervalMs: 100, sleep: async () => undefined };
  const resume = () => Object.fromEntries(entries.map(entry => [entry.phase, entry.value]));
  return { input, entries, resume, ledger, directory, renderPosts: () => renderPosts };
}

it("consumes the durable claim, restarts once, checks replacement gates and signs owner-loss only", async () => {
  const f = await fixture();
  const result = await executeGenericWorkerTermination(f.input);
  expect(result.status).toBe("owner_loss_verified");
  expect(result.receipt).toMatchObject({ providerCleanupProven: false, liveResourcesZeroProven: false });
  expect(f.renderPosts()).toBe(1);
  expect(f.entries.map(entry => entry.phase)).toEqual(["prepared", "consumed", "accepted", "receipt"]);
  const replay = await executeGenericWorkerTermination({ ...f.input, resume: f.resume() });
  expect(replay.receipt).toEqual(result.receipt);
  expect(f.renderPosts()).toBe(1);
  expect((await f.ledger.getRecoveryControl(f.input.runId))?.liveCleanupComplete).toBe(false);
});

it("keeps a lost dispatch response observation-only and never fabricates an accepted receipt", async () => {
  const f = await fixture("lost-response");
  expect(await executeGenericWorkerTermination(f.input)).toMatchObject({ status: "unconfirmed", receipt: null, replacementObserved: true });
  expect(await executeGenericWorkerTermination({ ...f.input, resume: f.resume() })).toMatchObject({ status: "unconfirmed", receipt: null });
  expect(f.renderPosts()).toBe(1);
  expect(f.entries.some(entry => entry.phase === "receipt")).toBe(false);
});

it("replays a lost committed ingestion response without restarting or changing its proof", async () => {
  const f = await fixture("lost-ingestion-response");
  await expect(executeGenericWorkerTermination(f.input)).rejects.toThrow(/lost committed/);
  const committed = (await f.ledger.getRecoveryControl(f.input.runId))!;
  expect(committed.genericOwnerLoss).toBeDefined();
  expect(f.entries.at(-1)?.phase).toBe("receipt");
  const replay = await executeGenericWorkerTermination({ ...f.input, resume: f.resume() });
  expect(replay.proof).toEqual(committed.genericOwnerLoss);
  expect(await f.ledger.getRecoveryControl(f.input.runId)).toEqual(committed);
  expect(f.renderPosts()).toBe(1);
  expect(committed.liveCleanupComplete).toBe(false);
});

it("refuses to sign when a product gate opens after the one-shot restart", async () => {
  const f = await fixture("open-after");
  await expect(executeGenericWorkerTermination(f.input)).rejects.toThrow();
  expect(f.renderPosts()).toBe(1);
  expect(f.entries.some(entry => entry.phase === "receipt")).toBe(false);
  await expect(executeGenericWorkerTermination({ ...f.input, resume: f.resume() })).rejects.toThrow();
  expect(f.renderPosts()).toBe(1);
});

it("does not dispatch when the prepared source checkpoint cannot be persisted", async () => {
  const f = await fixture();
  await expect(executeGenericWorkerTermination({ ...f.input, checkpoint: async () => { throw new Error("synthetic checkpoint failure"); } })).rejects.toThrow();
  expect(f.renderPosts()).toBe(0);
  expect((await f.ledger.getRecoveryControl(f.input.runId))?.genericOwnerDispatch?.consumedAt).toBeNull();
  expect((await executeGenericWorkerTermination(f.input)).status).toBe("owner_loss_verified");
  expect(f.renderPosts()).toBe(1);
});

it("does not redispatch after consumption succeeds but the local checkpoint fails", async () => {
  const f = await fixture();
  await expect(executeGenericWorkerTermination({ ...f.input, checkpoint: async entry => {
    if (entry.phase === "consumed") throw new Error("synthetic consumed checkpoint failure");
    await f.input.checkpoint(entry);
  } })).rejects.toThrow();
  expect(f.renderPosts()).toBe(0);
  expect((await f.ledger.getRecoveryControl(f.input.runId))?.genericOwnerDispatch?.consumedAt).not.toBeNull();
  expect(await executeGenericWorkerTermination({ ...f.input, resume: f.resume() })).toMatchObject({ status: "unconfirmed", receipt: null });
  expect(f.renderPosts()).toBe(0);
});

it("rejects changed release identity on completed source replay", async () => {
  const f = await fixture();
  await executeGenericWorkerTermination(f.input);
  await expect(executeGenericWorkerTermination({ ...f.input, resume: f.resume(), expectedLabSha: "f".repeat(40) })).rejects.toThrow(/RELEASE_MISMATCH/);
  expect(f.renderPosts()).toBe(1);
});

it("rejects missing or wrong authority custody before preparing or consuming a restart", async () => {
  const f = await fixture();
  for (const key of ["missing.key", "client.key"]) {
    await expect(executeGenericWorkerTermination({ ...f.input, privateKeyPath: path.join(path.dirname(f.input.privateKeyPath), key) })).rejects.toThrow();
    expect(f.renderPosts()).toBe(0);
    expect(f.entries).toEqual([]);
    expect((await f.ledger.getRecoveryControl(f.input.runId))?.genericOwnerDispatch).toBeUndefined();
  }
});

it("resumes immutable disk checkpoints after an interruption before consumption", async () => {
  const f = await fixture();
  const directory = path.join(f.directory, "journal"); await mkdir(directory, { mode: 0o700 });
  const settings = { directory, inputSha256: sha256("fixed-controller-input"), macKey: Buffer.alloc(32, 1) };
  const first = await openGenericWorkerJournal({ ...settings, resume: false });
  await expect(executeGenericWorkerTermination({ ...f.input, checkpoint: async entry => {
    await first.checkpoint(entry); throw new Error("synthetic process interruption");
  } })).rejects.toThrow();
  expect(f.renderPosts()).toBe(0);
  const second = await openGenericWorkerJournal({ ...settings, resume: true });
  const result = await executeGenericWorkerTermination({ ...f.input, resume: second.resume, checkpoint: async entry => {
    await second.checkpoint(entry); await f.input.checkpoint(entry);
  } });
  expect(result.status).toBe("owner_loss_verified");
  const third = await openGenericWorkerJournal({ ...settings, resume: true });
  expect((await executeGenericWorkerTermination({ ...f.input, resume: third.resume, checkpoint: third.checkpoint })).receipt).toEqual(result.receipt);
  expect(f.renderPosts()).toBe(1);
});

it("rejects disk checkpoint tampering, scope/key drift, gaps and unintended restart of a bundle", async () => {
  const f = await fixture();
  const directory = path.join(f.directory, "journal"); await mkdir(directory, { mode: 0o700 });
  const settings = { directory, inputSha256: sha256("fixed-controller-input"), macKey: Buffer.alloc(32, 1) };
  await openGenericWorkerJournal({ ...settings, resume: false });
  await expect(openGenericWorkerJournal({ ...settings, resume: false })).rejects.toThrow();
  await expect(openGenericWorkerJournal({ ...settings, resume: true, inputSha256: sha256("changed") })).rejects.toThrow();
  await expect(openGenericWorkerJournal({ ...settings, resume: true, macKey: Buffer.alloc(32, 2) })).rejects.toThrow();
  const target = path.join(directory, "000-generic-worker.json");
  const original = await readFile(target);
  const changed = JSON.parse(original.toString()); changed.payload.inputSha256 = sha256("forged");
  await writeFile(target, JSON.stringify(changed));
  await expect(openGenericWorkerJournal({ ...settings, resume: true })).rejects.toThrow();
  await writeFile(target, original);
  await rename(target, path.join(directory, "001-generic-worker.json"));
  await expect(openGenericWorkerJournal({ ...settings, resume: true })).rejects.toThrow();
  expect(f.renderPosts()).toBe(0);
});

it("allows only one concurrent exclusive journal creator", async () => {
  const f = await fixture();
  const directory = path.join(f.directory, "journal"); await mkdir(directory, { mode: 0o700 });
  const settings = { directory, inputSha256: sha256("fixed-controller-input"), macKey: Buffer.alloc(32, 1), resume: false };
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => openGenericWorkerJournal(settings)));
  expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect((await openGenericWorkerJournal({ ...settings, resume: true })).resume).toBeUndefined();
});

it.each(["ok", "lost-response"] as const)("runs and replays the CLI with private credentials (%s)", async mode => {
  const f = await fixture(mode);
  const bundle = path.join(f.directory, "bundle"); await mkdir(bundle, { mode: 0o700 });
  const inputPath = path.join(f.directory, "input.json"), renderPath = path.join(f.directory, "render.json");
  const { runId, requestId, workerServiceId, voiceLabOrigin, expectedLabSha, expectedLangGraphSha } = f.input;
  await writeNewSecureJson(inputPath, { runId, requestId, workerServiceId, voiceLabOrigin, expectedLabSha, expectedLangGraphSha });
  const renderToken = "synthetic-render-credential-1234567890";
  await writeNewSecureJson(renderPath, { bearer_token: renderToken });
  const tokens = await readSecureJson(path.join(f.directory, "tokens.json")) as Record<string, string>;
  const args = ["generic-render-worker-loss", "--input", inputPath, "--public-config", path.join(f.directory, "public.json"),
    "--transport-tokens", path.join(f.directory, "tokens.json"), "--deployment-key", f.input.privateKeyPath,
    "--render-token", renderPath, "--bundle-dir", bundle];
  const output: string[] = [];
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    if (url.pathname.endsWith("/restart") && init?.method === "POST") {
      const persisted = await readSecureJson(path.join(bundle, "002-generic-worker.json")) as { phase: string; payload: unknown };
      expect(persisted.phase).toBe("consumed");
      f.entries.push({ phase: "consumed", value: persisted.payload } as GenericWorkerControllerCheckpoint);
    }
    const headers = { ...init?.headers } as Record<string, string>;
    if (headers.authorization) {
      expect(headers.authorization).toBe(`Bearer ${url.origin === GENERIC_RECOVERY_ORIGIN ? tokens.deployment_control : renderToken}`);
      headers.authorization = `Bearer ${url.origin === GENERIC_RECOVERY_ORIGIN ? f.input.deploymentBearer : f.input.renderBearer}`;
    }
    return f.input.fetchImpl(raw, { ...init, headers });
  };
  const exitCode = mode === "ok" ? 0 : 2;
  expect(await runCli(args, line => output.push(line), { genericWorkerTermination: { fetchImpl } })).toBe(exitCode);
  expect(await runCli([...args, "--resume", "true"], line => output.push(line), { genericWorkerTermination: { fetchImpl } })).toBe(exitCode);
  expect(f.renderPosts()).toBe(1);
  const status = mode === "ok" ? "owner_loss_verified" : "unconfirmed";
  expect(output.map(line => JSON.parse(line).status)).toEqual([status, status]);
  for (const secret of [renderToken, ...Object.values(tokens)]) expect(output.join("\n")).not.toContain(secret);
  expect((await f.ledger.getRecoveryControl(runId))?.liveCleanupComplete).toBe(false);
});
