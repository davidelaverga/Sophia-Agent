import type { LabEvent, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";

export const PROCESS = "1".repeat(64);
export const BOOT = "2".repeat(64);
export const EPOCH = "3".repeat(64);
export const WORKER = "4".repeat(64);
export const PROVIDER_EVENT = "5".repeat(64);

export function event(run: RunRecord, seq: number, kind: string, source: LabEvent["source"], payload: Record<string, unknown>): LabEvent {
  return { runId: run.id, seq, kind, source, payload, at: new Date(seq * 1_000), dedupeKey: `${kind}:${seq}` };
}

export function ownership(run: RunRecord): LabEvent[] {
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

export function provider(run: RunRecord, seq = 3): LabEvent {
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

export function auth(run: RunRecord, seq = 4): LabEvent {
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

export function closed(run: RunRecord, seq = 5): LabEvent {
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

export function recovery(run: RunRecord, seq = 4): LabEvent {
  const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 };
  return event(run, seq, "cleanup.recovery", "canonical", {
    complete: true,
    http_status: 200,
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

export function completeExecutionCleanupFixture(run: RunRecord, workerId: string, leaseEpoch: number): LabEvent[] {
  const events = [...ownership(run), provider(run), auth(run), closed(run)];
  events[1]!.payload.worker_id_sha256 = sha256(workerId);
  events[1]!.payload.browser_lease_epoch = leaseEpoch;
  return events;
}

export const FENCE_PROOF = "6".repeat(64);
export const SIGNED_RECEIPT = "7".repeat(64);
export const AUTHORITY_KEY = "8".repeat(64);
export const OWNERSHIP_PROOF = "9".repeat(64);

/** The distinct canonical receipt persisted after a verified v2 service-owner
 * fence. Deliberately NOT cleanup.browser_context_closed. */
export function platformTerminated(run: RunRecord, seq = 5, overrides: Record<string, unknown> = {}): LabEvent {
  return event(run, seq, "cleanup.platform_execution_terminated", "canonical", {
    schema: "sophia_voice_lab_execution_epoch_platform_termination_v1",
    voice_lab_run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    process_id_sha256: PROCESS,
    browser_boot_id_sha256: BOOT,
    execution_epoch_sha256: EPOCH,
    original_worker_id_sha256: WORKER,
    browser_lease_epoch: 7,
    process_acquired_seq: 1,
    runtime_acquired_seq: 2,
    owner_replacement_observed: true,
    browser_context_closed_fabricated: false,
    provider_cleanup_proven: false,
    live_resources_zero_proven: false,
    service_owner_fence_proof_sha256: FENCE_PROOF,
    signed_receipt_sha256: SIGNED_RECEIPT,
    authority_public_key_sha256: AUTHORITY_KEY,
    execution_ownership_proof_sha256: OWNERSHIP_PROOF,
    ...overrides,
  });
}
