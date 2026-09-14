import { describe, expect, it } from "vitest";
import { observeRetiredWorker } from "../scripts/external-attestations/retired-worker-observation.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import type { RenderWorkerSnapshot } from "../scripts/external-attestations/render-worker-controller.js";

function fixture() {
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 14) + seconds * 1000);
  const snapshot: RenderWorkerSnapshot = {
    serviceId: "srv-0123456789abcdefghij", serviceName: "sophia-voice-lab-worker", serviceType: "background_worker",
    serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"), instanceResponseSha256: sha256("instances"),
    deployId: "dep-0123456789abcdefghij", deployStatus: "live",
    deployStartedAt: at(10).toISOString(), deploySettledAt: at(30).toISOString(),
    instanceIds: ["replacement-owner"], instanceCreatedAt: [at(20)],
    instanceSetSha256: canonicalRequestHash([sha256("replacement-owner")]),
  };
  return { serviceId: snapshot.serviceId, allocatedWorkerSha256: sha256("original-owner"),
    allocatedAt: at(0), snapshot, observedAt: at(400), now: at(401) };
}

describe("retired worker inventory observation is not cleanup authority", () => {
  it("records bounded absence without granting death, provider closure or settlement", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    expect(observeRetiredWorker(input)).toMatchObject({ ownerAbsentFromObservedInventory: true,
      ownerDeathProven: false, providerCleanupProven: false, liveResourcesZeroProven: false });
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(observeRetiredWorker(input))).not.toContain("replacement-owner");
  });
  it.each(["original-present", "multiple", "empty", "missing-age", "old-replacement", "future-age", "wrong-set", "wrong-service", "unsettled", "malformed-hash"])("rejects %s", kind => {
    const input = fixture(); const s = input.snapshot;
    if (kind === "original-present") s.instanceIds = ["original-owner"];
    if (kind === "multiple") s.instanceIds.push("other-owner");
    if (kind === "empty") s.instanceIds = [];
    if (kind === "missing-age") s.instanceCreatedAt = [];
    if (kind === "old-replacement") s.instanceCreatedAt = [input.allocatedAt];
    if (kind === "future-age") s.instanceCreatedAt = [input.now];
    if (kind === "wrong-set") s.instanceSetSha256 = sha256("wrong");
    if (kind === "wrong-service") s.serviceId = "srv-abcdefghij0123456789";
    if (kind === "unsettled") s.deploySettledAt = null;
    if (kind === "malformed-hash") s.instanceResponseSha256 = "missing";
    expect(() => observeRetiredWorker(input)).toThrow("RETIRED_WORKER_OBSERVATION_INVALID");
  });
  it.each(["overlap", "stale", "future", "invalid-date", "allocation-after-deploy"])("rejects timing: %s", kind => {
    const input = fixture();
    if (kind === "overlap") input.observedAt = new Date(Date.parse(input.snapshot.deploySettledAt!) + 359999);
    if (kind === "stale") input.now = new Date(input.observedAt.getTime() + 15001);
    if (kind === "future") input.observedAt = new Date(input.now.getTime() + 1);
    if (kind === "invalid-date") input.allocatedAt = new Date(NaN);
    if (kind === "allocation-after-deploy") input.allocatedAt = input.now;
    expect(() => observeRetiredWorker(input)).toThrow("RETIRED_WORKER_OBSERVATION_INVALID");
  });
});
