import { describe, expect, it } from "vitest";
import { assessHistoricalRecovery } from "../src/recovery-backfill.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";
import { sha256 } from "../src/security.js";
import { deriveRecoveryBrowserBinding } from "../src/recovery-control.js";

const callerPartitionId = `cp1:test:${"a".repeat(64)}`;
describe("read-only historical recovery backfill assessment", () => {
  it("does not convert missing history or cached cleanup into allocation-free proof", () => {
    const run = testRun({ state: "completed", cleanupComplete: true });
    expect(assessHistoricalRecovery({ run, callerPartitionId, events: [], lease: null })).toEqual({ ready: false, runIdSha256: sha256(run.id), reason: "historical_allocation_unknown" });
  });
  it("preserves a known allocation without inventing ownership or cleanup", () => {
    const run = testRun({ cleanupComplete: true, providerSessionId: "private-provider-id" });
    const result = assessHistoricalRecovery({ run, callerPartitionId, events: [], lease: null });
    expect(result).toMatchObject({ ready: true, control: { browserAllocationEver: true, liveCleanupComplete: false, remotePurgeComplete: false } });
    expect(JSON.stringify(result)).not.toContain("private-provider-id");
    if (result.ready) {
      expect(result.control.executionOwnership).toBeUndefined();
      expect(result.control.browserAllocationBinding).toBeUndefined();
    }
  });
  it("projects exact process history without treating direct process cleanup as Gateway zero", () => {
    const run = testRun({ cleanupComplete: true });
    const events = completeExecutionCleanupFixture(run, "owner", 1).map((e, i) => ({ ...e, runId: run.id, seq: i + 1, at: new Date() }));
    const before = JSON.stringify({ run, events });
    const result = assessHistoricalRecovery({ run, callerPartitionId, events, lease: null });
    expect(result).toMatchObject({ ready: true, control: { browserAllocationEver: true, liveCleanupComplete: false, remotePurgeComplete: false, executionCleanupProof: { ready: true }, executionOwnership: { workerIdSha256: sha256("owner") } } });
    expect(JSON.stringify({ run, events })).toBe(before);
    expect(JSON.stringify(result)).not.toContain('"owner"');
    if (result.ready) expect(result.control.browserAllocationBinding).toEqual(deriveRecoveryBrowserBinding(run.id, "owner", 1));
  });
  it("retains an expired lease reservation without inventing process acquisition", () => {
    const run = testRun();
    const lease = { runId: run.id, workerId: "historical-owner", leaseEpoch: 7, expiresAt: new Date(0), updatedAt: new Date(0) };
    const result = assessHistoricalRecovery({ run, callerPartitionId, events: [], lease });
    expect(result).toMatchObject({ ready: true, control: { browserAllocationBinding: deriveRecoveryBrowserBinding(run.id, lease.workerId, 7), liveCleanupComplete: false } });
    if (result.ready) {
      expect(result.control.executionOwnership).toBeUndefined();
      expect(result.control.executionCleanupProof).toBeUndefined();
      expect(result.control.browserContextBinding).toBeUndefined();
    }
  });
  it.each(["worker", "epoch"])("rejects contradictory historical %s ownership", drift => {
    const run = testRun();
    const events = completeExecutionCleanupFixture(run, "owner", 1);
    const lease = { runId: run.id, workerId: drift === "worker" ? "other-owner" : "owner", leaseEpoch: drift === "epoch" ? 2 : 1, expiresAt: new Date(0), updatedAt: new Date(0) };
    expect(assessHistoricalRecovery({ run, callerPartitionId, events, lease })).toMatchObject({ ready: false, reason: "historical_owner_binding_conflict" });
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])("rejects invalid retained lease epoch %s", leaseEpoch => {
    const run = testRun();
    const lease = { runId: run.id, workerId: "historical-owner", leaseEpoch, expiresAt: new Date(0), updatedAt: new Date(0) };
    expect(assessHistoricalRecovery({ run, callerPartitionId, events: [], lease })).toMatchObject({ ready: false, reason: "historical_owner_binding_conflict" });
  });
  it("joins matching lease and process evidence without certifying provider cleanup", () => {
    const run = testRun();
    const events = completeExecutionCleanupFixture(run, "historical-owner", 7);
    const lease = { runId: run.id, workerId: "historical-owner", leaseEpoch: 7, expiresAt: new Date(0), updatedAt: new Date(0) };
    expect(assessHistoricalRecovery({ run, callerPartitionId, events, lease })).toMatchObject({ ready: true, control: {
      browserAllocationBinding: deriveRecoveryBrowserBinding(run.id, lease.workerId, 7),
      executionOwnership: { workerIdSha256: sha256(lease.workerId), browserLeaseEpoch: 7 },
      executionCleanupProof: { ready: true }, liveCleanupComplete: false, remotePurgeComplete: false,
    } });
  });
  it("refuses cross-run history and malformed identity without returning private input", () => {
    const run = testRun();
    const foreign = testRun();
    const events = completeExecutionCleanupFixture(foreign, "owner", 1).map((e, i) => ({ ...e, runId: foreign.id, seq: i + 1, at: new Date() }));
    expect(assessHistoricalRecovery({ run, callerPartitionId, events, lease: null })).toMatchObject({ ready: false, reason: "historical_event_binding_invalid" });
    expect(assessHistoricalRecovery({ run, callerPartitionId: "raw-private-subject", events: [], lease: null })).toMatchObject({ ready: false, reason: "historical_identity_invalid" });
  });
  it("refuses to replace retained D02 control authority with a generic plan", () => {
    const run = testRun({ scenarioId: "V-D02", providerSessionId: "known-allocation" });
    expect(assessHistoricalRecovery({ run, callerPartitionId, events: [], lease: null })).toMatchObject({ ready: false, reason: "historical_d02_control_incomplete" });
  });
});
