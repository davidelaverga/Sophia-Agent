import { describe, expect, it } from "vitest";

import type { LabEvent, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { deriveExecutionEpochCleanupProof } from "../src/worker.js";
import { testRun } from "./helpers.js";

import { ownership, provider, auth, closed, recovery, EPOCH, WORKER } from "./execution-cleanup-fixture.js";

describe("execution epoch terminal cleanup", () => {
  it("rejects a second runtime acquisition even before the selected process receipt", () => {
    const run = testRun();
    const events = [...ownership(run), provider(run), auth(run), closed(run)].map(event => ({ ...event, seq: event.seq + 2 }));
    expect(deriveExecutionEpochCleanupProof(run, events).ready).toBe(true);
    const earlierRuntime = { ...events[1]!, seq: 1 };
    expect(deriveExecutionEpochCleanupProof(run, [earlierRuntime, ...events])).toMatchObject({ ready: false, reason: "runtime_acquisition_count_invalid", proofSha256: null });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid event sequence %s", seq => {
    const run = testRun();
    const events = [...ownership(run), provider(run), auth(run), closed(run)];
    expect(deriveExecutionEpochCleanupProof(run, events).ready).toBe(true);
    events[0] = { ...events[0]!, seq };
    expect(deriveExecutionEpochCleanupProof(run, events)).toMatchObject({ ready: false, proofSha256: null });
  });

  it("rejects a colliding sequence even when the competing event is not selected", () => {
    const run = testRun();
    const events = [...ownership(run), provider(run), auth(run), closed(run)];
    const collision = { ...events[0]!, kind: "harness.startup_stage", source: "worker" as const };
    expect(deriveExecutionEpochCleanupProof(run, [...events, collision])).toMatchObject({ ready: false, reason: "execution_event_sequence_invalid", proofSha256: null });
  });

  it.each([0, 1, 2, 3, 4])("rejects a foreign event envelope at direct cleanup index %i", index => {
    const run = testRun();
    const events = [...ownership(run), provider(run), auth(run), closed(run)];
    expect(deriveExecutionEpochCleanupProof(run, events).ready).toBe(true);
    const transplanted = events.map((event, i) => i === index ? { ...event, runId: testRun().id } : event);
    expect(deriveExecutionEpochCleanupProof(run, transplanted)).toMatchObject({ ready: false, reason: "execution_event_run_binding_invalid", proofSha256: null });
  });

  it("rejects a foreign canonical recovery envelope despite matching receipt payload", () => {
    const run = testRun();
    const events = [...ownership(run), closed(run, 3), recovery(run, 4)];
    expect(deriveExecutionEpochCleanupProof(run, events).ready).toBe(true);
    events[3] = { ...events[3]!, runId: testRun().id };
    expect(deriveExecutionEpochCleanupProof(run, events)).toMatchObject({ ready: false, reason: "execution_event_run_binding_invalid", proofSha256: null });
  });

  it("proves provider and auth cleanup before exact owned process death", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), provider(run), auth(run), closed(run)]);
    expect(proof).toMatchObject({
      required: true,
      ready: true,
      reason: "direct_cleanup_before_process_death",
      executionEpochSha256: EPOCH,
      workerIdSha256: WORKER,
      browserLeaseEpoch: 7,
      eventSeqs: { processAcquired: 1, runtimeAcquired: 2, providerCleanup: 3, authCleanup: 4, processClosed: 5, recovery: null },
    });
    expect(proof.proofSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts authoritative provider and auth recovery only after process death", () => {
    const run = testRun();
    const proof = deriveExecutionEpochCleanupProof(run, [...ownership(run), closed(run, 3), recovery(run, 4)]);
    expect(proof).toMatchObject({ required: true, ready: true, reason: "authoritative_recovery_after_process_death", eventSeqs: { processClosed: 3, recovery: 4 } });
    expect(deriveExecutionEpochCleanupProof(run, [...ownership(run), recovery(run, 3), closed(run, 4)])).toMatchObject({ ready: false, reason: "provider_or_auth_cleanup_unconfirmed" });
  });

  it("rejects missing, reordered, duplicated, or cross-epoch cleanup evidence", () => {
    const run = testRun();
    const base = [...ownership(run), provider(run), auth(run), closed(run)];
    expect(deriveExecutionEpochCleanupProof(run, base.filter((candidate) => candidate.kind !== "cleanup.provider_transport_closed"))).toMatchObject({ ready: false, reason: "provider_or_auth_cleanup_unconfirmed" });
    expect(deriveExecutionEpochCleanupProof(run, [...ownership(run), auth(run, 3), provider(run, 4), closed(run)])).toMatchObject({ ready: false, reason: "provider_or_auth_cleanup_unconfirmed" });
    expect(deriveExecutionEpochCleanupProof(run, [...base, closed(run, 6)])).toMatchObject({ ready: false, reason: "process_death_proof_invalid" });
    const drifted = base.map((candidate) => candidate.kind === "cleanup.browser_context_closed" ? { ...candidate, payload: { ...candidate.payload, execution_epoch_sha256: "6".repeat(64) } } : candidate);
    expect(deriveExecutionEpochCleanupProof(run, drifted)).toMatchObject({ ready: false, reason: "process_death_proof_invalid" });
  });

  it("does not infer pre-allocation rejection from missing process evidence", () => {
    const proof = deriveExecutionEpochCleanupProof(testRun(), []);
    expect(proof).toEqual(expect.objectContaining({ required: true, ready: false, reason: "process_acquisition_evidence_missing" }));
  });
});
