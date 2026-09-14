import { canonicalRequestHash, sha256 } from "../../src/security.js";
import type { RenderWorkerSnapshot } from "./render-worker-controller.js";

/** Read-only candidate observation, NOT an owner-loss or settlement receipt.
 * In particular this cannot be passed to either retained recovery verifier.
 * A separately authenticated, allocation-bound ingestion contract is required
 * before a controller can use this observation to reconcile durable ownership.
 */
export function observeRetiredWorker(input: {
  serviceId: string;
  allocatedWorkerSha256: string;
  allocatedAt: Date;
  snapshot: RenderWorkerSnapshot;
  observedAt: Date;
  now: Date;
}) {
  const fail = (): never => { throw new Error("RETIRED_WORKER_OBSERVATION_INVALID"); };
  const { snapshot: s } = input;
  const allocated = input.allocatedAt.getTime();
  const observed = input.observedAt.getTime();
  const now = input.now.getTime();
  const started = Date.parse(s.deployStartedAt);
  const settled = s.deploySettledAt === null ? NaN : Date.parse(s.deploySettledAt);
  // This wait is a conservative observation bound, not proof that a process
  // died. It covers Render's documented 60s overlap plus 300s shutdown maximum.
  if (![allocated, observed, now, started, settled].every(Number.isFinite)
    || allocated > started || started > settled || settled + 360_000 > observed
    || observed > now || now - observed > 15_000) fail();
  if (!/^srv-[0-9a-z]{20}$/.test(input.serviceId) || s.serviceId !== input.serviceId
    || s.serviceName !== "sophia-voice-lab-worker" || s.serviceType !== "background_worker"
    || !/^dep-[0-9a-z]{20}$/.test(s.deployId) || s.deployStatus !== "live"
    || !/^[a-f0-9]{64}$/.test(input.allocatedWorkerSha256)
    || ![s.serviceResponseSha256, s.deployResponseSha256, s.instanceResponseSha256, s.instanceSetSha256]
      .every(value => /^[a-f0-9]{64}$/.test(value))) fail();
  if (s.instanceIds.length !== 1 || s.instanceCreatedAt.length !== 1) fail();
  const owner = s.instanceIds[0]!;
  const created = s.instanceCreatedAt[0]!.getTime();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(owner) || sha256(owner) === input.allocatedWorkerSha256
    || !Number.isFinite(created) || created < started || created > settled
    || s.instanceSetSha256 !== canonicalRequestHash([sha256(owner)])) fail();
  return {
    schema: "sophia.voice-lab.retired-worker-observation.v1" as const,
    workerServiceIdSha256: sha256(input.serviceId),
    allocatedWorkerSha256: input.allocatedWorkerSha256,
    replacementWorkerSha256: sha256(owner),
    deployIdSha256: sha256(s.deployId),
    serviceResponseSha256: s.serviceResponseSha256,
    deployResponseSha256: s.deployResponseSha256,
    instanceResponseSha256: s.instanceResponseSha256,
    observedAt: input.observedAt.toISOString(),
    ownerAbsentFromObservedInventory: true as const,
    ownerDeathProven: false as const,
    providerCleanupProven: false as const,
    liveResourcesZeroProven: false as const,
  };
}
