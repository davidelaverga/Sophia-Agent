import { expect, it, vi } from "vitest";
import { readGenericWorkerPreflight, GENERIC_RECOVERY_ORIGIN } from "../scripts/external-attestations/generic-worker-preflight.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

function fixture() {
  const now = new Date();
  const before = new Date(now.getTime() - 60_000).toISOString();
  const run = testRun();
  const owner = "render-original-owner";
  const serviceId = "srv-0123456789abcdefghij";
  const labSha = "d".repeat(40), langgraphSha = "e".repeat(40);
  const control: RecoveryControlRecord = { binding: projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`),
    browserAllocationEver: true, browserAllocationBinding: deriveRecoveryBrowserBinding(run.id, owner, 1), version: 2,
    liveCleanupComplete: false, remotePurgeComplete: false, retentionPurgeDueAt: null, contentPurgedAt: now };
  const closed = { valid: true, open: false, voice_lab_enabled: false, voice_lab_kill_switch_engaged: true, voice_lab_mutation_ready: false };
  const ready = { version: labSha, execution: "kill_switch_engaged", active_runs: 1, mutation_ready: false, product_mutation_gates_open: false,
    components: { database: { ready: true }, browser_worker: { runtime_ready: true, live_workers: 1, execution_gate_settled: true, observed_kill_switch_engaged: true,
      heartbeat_attestation: { service_version: labSha, repository_candidate_sha: labSha, worker_instance_id_sha256: sha256(owner), observed_at: now.toISOString() } },
      test_auth: { ok: true, frontend_kill_switch_engaged: true, mutation_gate_order_safe: true },
      target_environment: { builds: { frontend: { observed: run.target.expectedDeployment.frontend }, backend: { observed: run.target.expectedDeployment.backend, product_mutation_gate: { ...closed } }, voice: { observed: run.target.expectedDeployment.voice, product_mutation_gate: { ...closed } }, langgraph: { observed: langgraphSha } } } } };
  const instances: unknown[] = [{ instance: { id: owner, createdAt: before } }];
  const fetchImpl = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(raw instanceof Request ? raw.url : raw.toString());
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.redirect).toBe("error");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin === GENERIC_RECOVERY_ORIGIN && url.pathname === "/readyz") {
      expect((init?.headers as Record<string, string>)?.authorization).toBeUndefined();
      return json(ready, 503);
    }
    if (url.origin !== "https://api.render.com") throw new Error("Unexpected origin");
    if (url.pathname.endsWith("/instances")) return json(instances);
    if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: "dep-0123456789abcdefghij", status: "live", createdAt: before, startedAt: before, updatedAt: before, finishedAt: before } }]);
    return json({ service: { id: serviceId, name: "sophia-voice-lab-worker", type: "background_worker" } });
  });
  const input = { control, workerServiceId: serviceId, voiceLabOrigin: GENERIC_RECOVERY_ORIGIN,
    expectedLabSha: labSha, expectedLangGraphSha: langgraphSha, renderBearer: "test-render-private-token", fetchImpl: fetchImpl as typeof fetch, now: () => now };
  return { input, ready, instances, fetchImpl };
}

it("joins exact closed deployment and singleton owner without provider mutation", async () => {
  const { input, fetchImpl } = fixture();
  const proof = await readGenericWorkerPreflight(input);
  expect(proof.before.instanceIdsSha256).toEqual([input.control.browserAllocationBinding!.browser_worker_id_sha256]);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(proof)).not.toMatch(/test-render-private-token|render-original-owner/);
});

it.each(["frontend", "gateway", "voice", "worker", "admission", "database", "heartbeat", "deployment"] as const)("refuses %s preflight drift", async drift => {
  const { input, ready, fetchImpl } = fixture();
  if (drift === "frontend") ready.components.test_auth.frontend_kill_switch_engaged = false;
  if (drift === "gateway") ready.components.target_environment.builds.backend.product_mutation_gate.open = true;
  if (drift === "voice") ready.components.target_environment.builds.voice.product_mutation_gate.voice_lab_kill_switch_engaged = false;
  if (drift === "worker") ready.components.browser_worker.observed_kill_switch_engaged = false;
  if (drift === "admission") ready.active_runs = 2;
  if (drift === "database") ready.components.database.ready = false;
  if (drift === "heartbeat") ready.components.browser_worker.heartbeat_attestation.observed_at = new Date(0).toISOString();
  if (drift === "deployment") ready.components.target_environment.builds.langgraph.observed = "f".repeat(40);
  await expect(readGenericWorkerPreflight(input)).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(["foreign", "extra", "malformed"] as const)("refuses %s Render owner inventory", async drift => {
  const { input, instances } = fixture();
  if (drift === "foreign") instances[0] = { instance: { id: "foreign-owner", createdAt: new Date(0).toISOString() } };
  if (drift === "extra") instances.push({ instance: { id: "extra-owner", createdAt: new Date(0).toISOString() } });
  if (drift === "malformed") instances.push({ instance: { id: "invalid!" } });
  await expect(readGenericWorkerPreflight(input)).rejects.toThrow();
});

it("rejects foreign credential destinations before fetching", async () => {
  const { input, fetchImpl } = fixture();
  await expect(readGenericWorkerPreflight({ ...input, voiceLabOrigin: "https://foreign.invalid" })).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
