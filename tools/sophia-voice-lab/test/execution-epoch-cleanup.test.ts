import { describe, expect, it } from "vitest";

import type { LabEvent, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { deriveExecutionEpochCleanupProof } from "../src/worker.js";
import { testRun } from "./helpers.js";

const PROCESS = "1".repeat(64);
const BOOT = "2".repeat(64);
const EPOCH = "3".repeat(64);
const WORKER = "4".repeat(64);
const PROVIDER_EVENT = "5".repeat(64);

function event(run: RunRecord, seq: number, kind: string, source: LabEvent["source"], payload: Record<string, unknown>): LabEvent {
  return { runId: run.id, seq, kind, source, payload, at: new Date(seq * 1_000), dedupeKey: `${kind}:${seq}` };
}

function ownership(run: RunRecord): LabEvent[] {
  return [
    event(run, 1, "harness.browser_process_acquired", "browser", {
      schema: "sophia_voice_lab_browser_process_ownership_v1",
      voice_lab_run_id_sha256: sha256(run.id),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      process_id_sha256: PROCESS,
      browser_boot_id_sha256: BOOT,
      execution_epoch_sha256: EPOCH,
      started_at: new Date(0).toISOString(),
      one_process_per_run: true,
      raw_process_id_excluded: true,
    }),
    event(run, 2, "harness.browser_runtime_acquired", "canonical", {
      worker_id_sha256: WORKER,
      browser_lease_epoch: 7,
      operation_id: "operation-1",
      engine: "chromium",
      version: "151",
      service_version: "a".repeat(40),
      acquired_at: new Date(2_000).toISOString(),
    }),
  ];
}

function provider(run: RunRecord, seq = 3): LabEvent {
  return event(run, seq, "cleanup.provider_transport_closed", "canonical", {
    schema: "sophia_voice_lab_execution_epoch_provider_cleanup_v1",
    voice_lab_run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    process_id_sha256: PROCESS,
    browser_boot_id_sha256: BOOT,
    execution_epoch_sha256: EPOCH,
    provider_stage: "closed",
    provider_event_sha256: PROVIDER_EVENT,
    exact_product_binding_validated: true,
    raw_process_and_provider_identifiers_excluded: true,
  });
}

function auth(run: RunRecord, seq = 4): LabEvent {
  return event(run, seq, "auth.session_cleanup", "canonical", {
    cleanup_proof_schema: "sophia_voice_lab_execution_epoch_auth_cleanup_v1",
    voice_lab_run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    process_id_sha256: PROCESS,
    browser_boot_id_sha256: BOOT,
    execution_epoch_sha256: EPOCH,
    session_revoked: true,
    cookies_cleared: true,
  });
}

function closed(run: RunRecord, seq = 5): LabEvent {
  return event(run, seq, "cleanup.browser_context_closed", "browser", {
    schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1",
    voice_lab_run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    reason: "normal_end",
    close_resolved: true,
    browser_registry_absent: true,
    browser_process_close_resolved: true,
    browser_process_disconnected: true,
    process_id_sha256: PROCESS,
    browser_boot_id_sha256: BOOT,
    execution_epoch_sha256: EPOCH,
    raw_process_id_excluded: true,
  });
}

function recovery(run: RunRecord, seq = 4): LabEvent {
  const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 };
  return event(run, seq, "cleanup.recovery", "canonical", {
    complete: true,
    receipt: {
      complete: true,
      live_cleanup_complete: true,
      live_resources_zero: true,
      test_run_id: run.testRunId,
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      components: {
        canonical_session: { status: "completed" },
        voice_provider: { status: "completed" },
        builder,
        auth_sessions: { status: "completed" },
      },
    },
  });
}

describe("execution epoch terminal cleanup", () => {
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

  it("does not impose an execution-epoch proof on a pre-allocation rejection", () => {
    const proof = deriveExecutionEpochCleanupProof(testRun(), []);
    expect(proof).toEqual(expect.objectContaining({ required: false, ready: true, reason: "browser_process_not_allocated" }));
  });
});
