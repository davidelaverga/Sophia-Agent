import { z } from "zod";
import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { RecoveryControlBindingSchema, validateRecoveryAllocationBinding, type RecoveryControlRecord } from "../../src/recovery-control.js";
import { readRenderWorkerSnapshot } from "./render-worker-controller.js";

export const GENERIC_RECOVERY_ORIGIN = "https://sophia-voice-lab-mcp.onrender.com";
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const RecoveryProductDeploymentSchema = z.object({ frontend: sha, backend: sha, voice: sha }).strict();
const closedProductGate = z.object({ valid: z.literal(true), open: z.literal(false), voice_lab_enabled: z.literal(false), voice_lab_kill_switch_engaged: z.literal(true), voice_lab_mutation_ready: z.literal(false) }).passthrough();
const build = z.object({ observed: sha }).passthrough();
const readinessSchema = z.object({
  version: sha, execution: z.literal("kill_switch_engaged"), active_runs: z.literal(1), mutation_ready: z.literal(false), product_mutation_gates_open: z.literal(false),
  components: z.object({
    database: z.object({ ready: z.literal(true) }).passthrough(),
    browser_worker: z.object({ runtime_ready: z.literal(true), live_workers: z.literal(1), execution_gate_settled: z.literal(true), observed_kill_switch_engaged: z.literal(true),
      heartbeat_attestation: z.object({ service_version: sha, repository_candidate_sha: sha, worker_instance_id_sha256: z.string().regex(/^[a-f0-9]{64}$/), observed_at: z.string().datetime() }).passthrough(),
    }).passthrough(),
    test_auth: z.object({ ok: z.literal(true), frontend_kill_switch_engaged: z.literal(true), mutation_gate_order_safe: z.literal(true) }).passthrough(),
    target_environment: z.object({ builds: z.object({
      frontend: build, backend: build.extend({ product_mutation_gate: closedProductGate }), voice: build.extend({ product_mutation_gate: closedProductGate }), langgraph: build,
    }).passthrough() }).passthrough(),
  }).passthrough(),
}).passthrough();

export function genericRecoveryOrigin(raw: string, allowHttpForTest = false): string {
  const url = new URL(raw);
  if (url.origin !== raw || url.username || url.password || (raw !== GENERIC_RECOVERY_ORIGIN && !(allowHttpForTest && url.protocol === "http:" && url.hostname === "127.0.0.1"))) throw new Error("Generic recovery origin is not the exact authorized service.");
  return raw;
}

/** Independent read-only source checks. This grants neither a provider restart
 * nor cleanup. Exactly one outstanding run is required until batch-owner
 * reconciliation has its own explicit, independently verified scope. */
export type GenericWorkerPreflightInput = {
  control: RecoveryControlRecord; workerServiceId: string; voiceLabOrigin: string;
  expectedLabSha: string; expectedLangGraphSha: string; renderBearer: string;
  expectedRecoveryDeployment?: z.infer<typeof RecoveryProductDeploymentSchema>;
  fetchImpl?: typeof fetch; allowHttpForTest?: boolean; now?: () => Date;
};
export async function readGenericWorkerPreflight(input: GenericWorkerPreflightInput) { return readPreflight(input); }
export async function readGenericWorkerReplacementPreflight(input: GenericWorkerPreflightInput, replacementHash: string) {
  z.string().regex(/^[a-f0-9]{64}$/).parse(replacementHash);
  if (replacementHash === input.control.browserAllocationBinding?.browser_worker_id_sha256) throw new Error("Replacement owner did not change.");
  return readPreflight(input, replacementHash);
}
/** Read-only preflight for a separate service-wide fence. The durable original
 * owner is already retired, so current closed readiness must join the exact
 * provider inventory, not be relabeled as the original owner. */
export async function readServiceOwnerFencePreflight(input: GenericWorkerPreflightInput & { allocatedWorkerId: string }) {
  assertServiceFenceAllocation(input);
  const result = await readPreflight(input, undefined, true);
  return { ...result, schema: "sophia.voice-lab.service-owner-fence-preflight.v1" as const };
}
/** v2 absent mode: the ORIGINAL allocated owner is already gone before the
 * prospective action and every gate is closed. The retired-owner contract
 * applies (the live heartbeat is not the original; the Render singleton joins
 * the heartbeat's own projection), with that projection REQUIRED so the caller
 * can compare the singleton against the original's projection. */
export async function readServiceOwnerFenceV2AbsentPreflight(input: GenericWorkerPreflightInput & { allocatedWorkerId: string }) {
  assertServiceFenceAllocation(input);
  const result = await readPreflight(input, undefined, true, "required");
  return { ...result, schema: "sophia.voice-lab.service-owner-fence-preflight.v2-absent" as const };
}
/** The allocated owner id must be this service's exact allocation, and the
 * current recovery deployment must be pinned explicitly. */
function assertServiceFenceAllocation(input: GenericWorkerPreflightInput & { allocatedWorkerId: string }): void {
  const allocation = validateRecoveryAllocationBinding(input.control.binding, input.control.browserAllocationBinding);
  if (!/^srv-[0-9a-z]{20}-[A-Za-z0-9_-]{5,96}$/.test(input.allocatedWorkerId)
    || input.allocatedWorkerId.slice(0, 24) !== input.workerServiceId
    || sha256(input.allocatedWorkerId) !== allocation.browser_worker_id_sha256) throw new Error("Service fence original owner does not match the exact service allocation.");
  if (!input.expectedRecoveryDeployment) throw new Error("Service fence requires explicit current recovery deployment pins.");
}
/** v2 service fence: the ORIGINAL allocated owner must still be the live
 * singleton immediately before the prospective one-shot action. It therefore
 * uses the original-owner comparison (heartbeat identity AND the Render
 * inventory singleton must both be the allocation's own worker), which is the
 * exact inversion of the v1 retired-owner contract above. */
export async function readServiceOwnerFenceV2Preflight(input: GenericWorkerPreflightInput & { allocatedWorkerId: string }) {
  assertServiceFenceAllocation(input);
  // Original owner still current (heartbeat identity), but Render's inventory
  // snapshot is compared through the supported projection, not the full hash.
  const result = await readPreflight(input, undefined, false, "required");
  return { ...result, schema: "sophia.voice-lab.service-owner-fence-preflight.v2" as const };
}
async function readPreflight(input: GenericWorkerPreflightInput, replacementHash?: string, retiredServiceOwner = false,
  inventoryProjection: "off" | "optional" | "required" = retiredServiceOwner ? "optional" : "off") {
  const origin = genericRecoveryOrigin(input.voiceLabOrigin, input.allowHttpForTest);
  const fetchImpl = input.fetchImpl ?? fetch;
  const binding = RecoveryControlBindingSchema.parse(input.control.binding);
  // Recovery can run on a repaired release. Never rewrite the original run's
  // immutable target to make its historical evidence appear current.
  const recoveryDeployment = RecoveryProductDeploymentSchema.parse(input.expectedRecoveryDeployment ?? binding.expectedDeployment);
  if (binding.scenarioId === "V-D02" || !input.control.browserAllocationEver || input.control.liveCleanupComplete) throw new Error("Generic recovery scope is not outstanding.");
  const allocation = validateRecoveryAllocationBinding(binding, input.control.browserAllocationBinding);
  z.string().regex(/^srv-[0-9a-z]{20}$/).parse(input.workerServiceId);
  sha.parse(input.expectedLabSha); sha.parse(input.expectedLangGraphSha);
  const response = await fetchImpl(new URL("/readyz", origin), { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (response.status !== 200 && response.status !== 503) throw new Error("Generic recovery readiness observation unavailable.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 262144) throw new Error("Generic recovery readiness exceeds byte bound.");
  const ready = readinessSchema.parse(JSON.parse(bytes.toString("utf8")));
  const observedAt = (input.now ?? (() => new Date()))();
  const heartbeat = ready.components.browser_worker.heartbeat_attestation;
  const expectedOwnerHash = retiredServiceOwner ? heartbeat.worker_instance_id_sha256 : replacementHash ?? allocation.browser_worker_id_sha256;
  if (retiredServiceOwner && expectedOwnerHash === allocation.browser_worker_id_sha256) throw new Error("Service fence original owner is still current; use the original-owner contract.");
  const age = observedAt.getTime() - Date.parse(heartbeat.observed_at);
  if (!Number.isFinite(age) || age < 0 || age > 15_000 || ready.version !== input.expectedLabSha
    || heartbeat.service_version !== input.expectedLabSha || heartbeat.repository_candidate_sha !== input.expectedLabSha
    || heartbeat.worker_instance_id_sha256 !== expectedOwnerHash) throw new Error("Generic recovery live worker identity is stale or mismatched.");
  const builds = ready.components.target_environment.builds;
  if (builds.frontend.observed !== recoveryDeployment.frontend || builds.backend.observed !== recoveryDeployment.backend
    || builds.voice.observed !== recoveryDeployment.voice || builds.langgraph.observed !== input.expectedLangGraphSha) throw new Error("Generic recovery product deployment mismatch.");
  const worker = await readRenderWorkerSnapshot({ render_api_origin: "https://api.render.com", render_worker_service_id: input.workerServiceId }, input.renderBearer, fetchImpl, null);
  // Only the retired-service fence uses the distinct inventory projection.
  // Original-owner contracts retain their exact historical owner comparison.
  // v1's retired-owner contract may fall back when the worker predates the
  // projection; the v2 original-owner contract must not, because the full
  // ownership hash and the inventory hash are different strings for one pod.
  if (inventoryProjection === "required" && heartbeat.render_inventory_instance_id_sha256 == null) throw new Error("Generic recovery requires the supported Render inventory identity projection.");
  const inventoryHash = inventoryProjection !== "off" && heartbeat.render_inventory_instance_id_sha256 != null
    ? z.string().regex(/^[a-f0-9]{64}$/).parse(heartbeat.render_inventory_instance_id_sha256) : expectedOwnerHash;
  if (worker.deployStatus !== "live" || worker.deploySettledAt === null || worker.instanceIds.length !== 1
    || sha256(worker.instanceIds[0]!) !== inventoryHash) throw new Error("Generic recovery Render owner is not the exact singleton.");
  const completedAt = (input.now ?? (() => new Date()))();
  if (completedAt.getTime() < observedAt.getTime() || completedAt.getTime() - Date.parse(heartbeat.observed_at) > 15_000
    || worker.instanceCreatedAt[0]!.getTime() > completedAt.getTime()) throw new Error("Generic recovery preflight expired or has future instance evidence.");
  return {
    schema: "sophia.voice-lab.generic-worker-preflight.v1" as const,
    controlBindingSha256: canonicalRequestHash(binding), allocationBindingSha256: canonicalRequestHash(allocation),
    expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha,
    expectedRecoveryDeployment: recoveryDeployment,
    readinessResponseSha256: sha256(bytes), workerServiceIdSha256: sha256(input.workerServiceId),
    before: { serviceResponseSha256: worker.serviceResponseSha256, deployResponseSha256: worker.deployResponseSha256, instanceResponseSha256: worker.instanceResponseSha256,
      instanceIdsSha256: worker.instanceIds.map(sha256), deployIdSha256: sha256(worker.deployId), deployStatus: "live" as const,
      instanceCreatedAt: worker.instanceCreatedAt[0]!.toISOString(), observedAt: completedAt.toISOString() },
  };
}
