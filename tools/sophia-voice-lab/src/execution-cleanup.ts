import type { RunRecord } from "./domain.js";
import { z } from "zod";
import { canonicalRequestHash, sha256 } from "./security.js";
import { isTerminalRecoveryComponentStatus } from "./recovery-control.js";
import { executionEventSequencesValid } from "./execution-ownership.js";

function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

export function parsePreservedExecutionCleanupProof(input: unknown): ExecutionEpochCleanupProof {
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  return z.object({ required: z.literal(true), ready: z.literal(true),
    reason: z.enum(["direct_cleanup_before_process_death", "authoritative_recovery_after_process_death", "authoritative_platform_fence_after_owner_loss"]),
    executionEpochSha256: hash, workerIdSha256: hash, browserLeaseEpoch: seq, proofSha256: hash,
    eventSeqs: z.object({ processAcquired: seq, runtimeAcquired: seq, providerCleanup: seq.nullable(), authCleanup: seq.nullable(), processClosed: seq.nullable(), platformTerminated: seq.nullable().optional(), recovery: seq.nullable() }).strict()
      .refine(value => value.processClosed !== null || (value.platformTerminated ?? null) !== null),
  }).strict().parse(input);
}

/** Immutable-proof identity. A proof preserved before the platform-fence path
 * (deployed 7d4 and earlier) has no eventSeqs.platformTerminated key, while the
 * current derivation emits null for the same close-path run; its proofSha256 is
 * identical because the hashed core omits that ordinal off the fence path.
 * Absent and null are therefore the same identity. Every other field, and a
 * non-null fence ordinal, stays bound exactly. */
export function sameExecutionCleanupProof(preserved: ExecutionEpochCleanupProof, derived: ExecutionEpochCleanupProof): boolean {
  const identity = (proof: ExecutionEpochCleanupProof) => {
    const { platformTerminated, ...seqs } = proof.eventSeqs;
    return canonicalRequestHash({ ...proof, eventSeqs: platformTerminated == null ? seqs : { ...seqs, platformTerminated } });
  };
  return identity(preserved) === identity(derived);
}

export function recoveryComponentComplete(events: import("./domain.js").LabEvent[], component: "canonical_session" | "voice_provider" | "builder" | "auth_sessions"): boolean {
  return events.some((event) => {
    if (event.kind !== "cleanup.recovery" || event.source !== "canonical" || event.payload.complete !== true) return false;
    const receipt = event.payload.receipt as Record<string, unknown> | undefined;
    const components = receipt?.components as Record<string, Record<string, unknown>> | undefined;
    const status = components?.[component]?.status;
    return receipt?.complete === true && (component === "builder" ? status === "completed" : isTerminalRecoveryComponentStatus(status));
  });
}

export function authoritativeLiveCleanupComplete(events: Array<{ kind: string; source?: string; payload: Record<string, unknown> }>, run?: Pick<RunRecord, "testRunId" | "cleanupObligationId">): boolean {
  if (!run) return false;
  return events.some((event) => {
    if (event.kind !== "cleanup.recovery" || event.source !== "canonical" || event.payload.complete !== true || event.payload.http_status !== 200) return false;
    const receipt = event.payload.receipt as Record<string, unknown> | undefined;
    if (receipt?.test_run_id !== run.testRunId || receipt.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)) return false;
    const components = receipt?.components as Record<string, unknown> | undefined;
    if (!["canonical_session", "voice_provider", "auth_sessions"].every(component => isTerminalRecoveryComponentStatus((components?.[component] as Record<string, unknown> | undefined)?.status))) return false;
    const builder = components?.builder as Record<string, unknown> | undefined;
    const builderReceipt = builder?.receipt && typeof builder.receipt === "object" ? builder.receipt as Record<string, unknown> : {};
    return receipt?.complete === true && receipt?.live_cleanup_complete === true && receipt?.live_resources_zero === true && builder?.status === "completed" && (builder?.cleanup_complete ?? builderReceipt.cleanup_complete) === true && (builder?.discovery_complete ?? builderReceipt.discovery_complete) === true && (builder?.authoritative_zero_tasks ?? builderReceipt.authoritative_zero_tasks) === true && Number.isInteger(builder?.discovered_task_count ?? builderReceipt.discovered_task_count) && Number(builder?.discovered_task_count ?? builderReceipt.discovered_task_count) >= 0;
  });
}

export function authCleanupConfirmed(event: { kind: string; payload: Record<string, unknown> }): boolean {
  if (event.kind !== "auth.session_cleanup") return false;
  if (event.payload.session_revoked === true && event.payload.cookies_cleared === true) return true;
  const receipt = event.payload.receipt as Record<string, unknown> | undefined;
  return event.payload.confirmed === true && receipt?.session_revoked === true && receipt?.cookies_cleared === true;
}

export type ExecutionEpochCleanupProof = {
  required: boolean;
  ready: boolean;
  reason: string;
  executionEpochSha256: string | null;
  workerIdSha256: string | null;
  browserLeaseEpoch: number | null;
  proofSha256: string | null;
  eventSeqs: {
    processAcquired: number | null;
    runtimeAcquired: number | null;
    providerCleanup: number | null;
    authCleanup: number | null;
    processClosed: number | null;
    platformTerminated?: number | null | undefined;
    recovery: number | null;
  };
};

/**
 * Join the run-owned Chromium process, its worker lease, and the exact provider,
 * auth-session, and process-death receipts before the lease can be released.
 * A recovery receipt is an allowed cleanup source only when it follows proven
 * process death and authoritatively reports both provider and auth components.
 */
export function deriveExecutionEpochCleanupProof(
  run: Pick<RunRecord, "id" | "testRunId" | "cleanupObligationId">,
  events: import("./domain.js").LabEvent[],
): ExecutionEpochCleanupProof {
  const emptySeqs = { processAcquired: null, runtimeAcquired: null, providerCleanup: null, authCleanup: null, processClosed: null, platformTerminated: null, recovery: null };
  const acquisitions = events.filter((event) => event.kind === "harness.browser_process_acquired" && event.source === "browser");
  const fail = (reason: string, partial: Partial<ExecutionEpochCleanupProof> = {}): ExecutionEpochCleanupProof => ({
    required: true,
    ready: false,
    reason,
    executionEpochSha256: null,
    workerIdSha256: null,
    browserLeaseEpoch: null,
    proofSha256: null,
    eventSeqs: emptySeqs,
    ...partial,
  });
  // Missing retained evidence is not an allocation-free receipt. Pre-resource
  // scenarios have their separate admission/zero-allocation certification path.
  if (events.some(event => event.runId !== run.id)) return fail("execution_event_run_binding_invalid");
  // Every selected receipt is addressed by sequence in the durable proof. A
  // duplicate or non-ledger ordinal makes that address ambiguous, even when
  // the competing event would otherwise be filtered out of this projection.
  if (!executionEventSequencesValid(events)) return fail("execution_event_sequence_invalid");
  if (acquisitions.length === 0) return fail("process_acquisition_evidence_missing");
  if (acquisitions.length !== 1) return fail("process_acquisition_count_invalid");
  const acquired = acquisitions[0]!;
  const ap = acquired.payload;
  const runHash = sha256(run.id);
  const cleanupHash = sha256(run.cleanupObligationId);
  if (ap.schema !== "sophia_voice_lab_browser_process_ownership_v1"
    || ap.voice_lab_run_id_sha256 !== runHash || ap.cleanup_obligation_id_sha256 !== cleanupHash
    || !isSha256(ap.process_id_sha256) || !isSha256(ap.browser_boot_id_sha256) || !isSha256(ap.execution_epoch_sha256)
    || ap.one_process_per_run !== true || ap.raw_process_id_excluded !== true) return fail("process_acquisition_binding_invalid");
  const epoch = String(ap.execution_epoch_sha256);
  const processId = String(ap.process_id_sha256);
  const bootId = String(ap.browser_boot_id_sha256);
  const runtimes = events.filter((event) => event.kind === "harness.browser_runtime_acquired" && event.source === "canonical");
  if (runtimes.length !== 1) return fail("runtime_acquisition_count_invalid", { executionEpochSha256: epoch, eventSeqs: { ...emptySeqs, processAcquired: acquired.seq } });
  const runtime = runtimes[0]!;
  if (runtime.seq <= acquired.seq) return fail("runtime_acquisition_order_invalid", { executionEpochSha256: epoch, eventSeqs: { ...emptySeqs, processAcquired: acquired.seq, runtimeAcquired: runtime.seq } });
  const workerId = runtime.payload.worker_id_sha256;
  const leaseEpoch = runtime.payload.browser_lease_epoch;
  if (!isSha256(workerId) || !Number.isSafeInteger(leaseEpoch) || Number(leaseEpoch) < 1) return fail("runtime_lease_binding_invalid", { executionEpochSha256: epoch, eventSeqs: { ...emptySeqs, processAcquired: acquired.seq, runtimeAcquired: runtime.seq } });

  const sameEpoch = (payload: Record<string, unknown>) => payload.voice_lab_run_id_sha256 === runHash
    && payload.cleanup_obligation_id_sha256 === cleanupHash
    && payload.process_id_sha256 === processId
    && payload.browser_boot_id_sha256 === bootId
    && payload.execution_epoch_sha256 === epoch;
  const closes = events.filter((event) => event.kind === "cleanup.browser_context_closed" && event.source === "browser"
    && event.seq > runtime.seq && event.payload.schema === "sophia_voice_lab_execution_epoch_browser_cleanup_v1"
    && sameEpoch(event.payload) && event.payload.close_resolved === true && event.payload.browser_registry_absent === true
    && event.payload.browser_process_close_resolved === true && event.payload.browser_process_disconnected === true
    && event.payload.raw_process_id_excluded === true);
  // A browser-authored close is still the only direct proof. When the owning
  // pod is gone the browser can never author one, so a SEPARATE canonical
  // platform-termination receipt may stand in its place. It is never
  // synthesised from, nor relabelled as, cleanup.browser_context_closed: it is
  // persisted only after the server verifies a signed v2 service-owner-fence
  // whose whole-service replacement removed the pod that owned this epoch.
  const platformTerminations = closes.length === 0 ? events.filter((event) => event.kind === "cleanup.platform_execution_terminated"
    && event.source === "canonical" && event.seq > runtime.seq
    && event.payload.schema === "sophia_voice_lab_execution_epoch_platform_termination_v1"
    && sameEpoch(event.payload)
    && event.payload.original_worker_id_sha256 === workerId
    && event.payload.browser_lease_epoch === leaseEpoch
    && event.payload.process_acquired_seq === acquired.seq
    && event.payload.runtime_acquired_seq === runtime.seq
    && event.payload.owner_replacement_observed === true
    && event.payload.browser_context_closed_fabricated === false
    && event.payload.provider_cleanup_proven === false
    && event.payload.live_resources_zero_proven === false
    && isSha256(event.payload.service_owner_fence_proof_sha256)
    && isSha256(event.payload.signed_receipt_sha256)
    && isSha256(event.payload.authority_public_key_sha256)
    && isSha256(event.payload.execution_ownership_proof_sha256)) : [];
  if (closes.length !== 1 && platformTerminations.length !== 1) return fail("process_death_proof_invalid", { executionEpochSha256: epoch, workerIdSha256: workerId, browserLeaseEpoch: Number(leaseEpoch), eventSeqs: { ...emptySeqs, processAcquired: acquired.seq, runtimeAcquired: runtime.seq, platformTerminated: platformTerminations[0]?.seq ?? null } });
  const terminated = platformTerminations[0] ?? null;
  const closed = closes[0] ?? terminated!;
  const providers = events.filter((event) => event.kind === "cleanup.provider_transport_closed" && event.source === "canonical"
    && event.seq > runtime.seq && event.seq < closed.seq
    && event.payload.schema === "sophia_voice_lab_execution_epoch_provider_cleanup_v1" && sameEpoch(event.payload)
    && ["closed", "ended"].includes(String(event.payload.provider_stage))
    && isSha256(event.payload.provider_event_sha256) && event.payload.exact_product_binding_validated === true
    && event.payload.raw_process_and_provider_identifiers_excluded === true);
  const auth = events.filter((event) => event.kind === "auth.session_cleanup" && event.source === "canonical"
    && event.seq > runtime.seq && event.seq < closed.seq
    && event.payload.cleanup_proof_schema === "sophia_voice_lab_execution_epoch_auth_cleanup_v1"
    && sameEpoch(event.payload) && authCleanupConfirmed(event));
  // The direct path proves cleanup BEFORE process death; a platform fence only
  // proves the owner died, so it can never satisfy it.
  const direct = terminated === null && providers.length === 1 && auth.length === 1 && providers[0]!.seq < auth[0]!.seq;
  const recoveries = events.filter((event) => {
    if (event.kind !== "cleanup.recovery" || event.seq <= closed.seq) return false;
    const receipt = event.payload.receipt as Record<string, unknown> | undefined;
    return receipt?.test_run_id === run.testRunId && receipt.cleanup_obligation_id_sha256 === cleanupHash
      && authoritativeLiveCleanupComplete([event], run) && recoveryComponentComplete([event], "voice_provider") && recoveryComponentComplete([event], "auth_sessions");
  });
  // Recovery is repeatable (e.g. a later retention recovery), so any number of
  // authoritative receipts after the close may exist. The EARLIEST one is the
  // settlement anchor: a preserved proof is compared by digest at lease release
  // and in manifests, so later receipts must never move it, and every proof
  // that was ready with exactly one recovery keeps its identical digest.
  const settlingRecovery = earliestBySeq(recoveries);
  const closeSeqs = { processClosed: terminated ? null : closed.seq, platformTerminated: terminated ? terminated.seq : null };
  if (!direct && !settlingRecovery) return fail("provider_or_auth_cleanup_unconfirmed", {
    executionEpochSha256: epoch,
    workerIdSha256: workerId,
    browserLeaseEpoch: Number(leaseEpoch),
    eventSeqs: { ...emptySeqs, processAcquired: acquired.seq, runtimeAcquired: runtime.seq, providerCleanup: providers[0]?.seq ?? null, authCleanup: auth[0]?.seq ?? null, ...closeSeqs, recovery: null },
  });
  const eventSeqs = {
    processAcquired: acquired.seq,
    runtimeAcquired: runtime.seq,
    providerCleanup: providers[0]?.seq ?? null,
    authCleanup: auth[0]?.seq ?? null,
    ...closeSeqs,
    recovery: settlingRecovery?.seq ?? null,
  };
  const cleanupPath = terminated ? "platform_fence" : direct ? "direct" : "recovery";
  // Digest compatibility: a run settled by a browser close must hash exactly as
  // it did before the platform-fence path existed, so the new ordinal is part
  // of the hashed core ONLY on the fence path. Never widen this object for a
  // path that could already have produced a preserved proof.
  const hashedSeqs = terminated
    ? eventSeqs
    : { processAcquired: eventSeqs.processAcquired, runtimeAcquired: eventSeqs.runtimeAcquired,
        providerCleanup: eventSeqs.providerCleanup, authCleanup: eventSeqs.authCleanup,
        processClosed: eventSeqs.processClosed, recovery: eventSeqs.recovery };
  const proofCore = { run_id_sha256: runHash, cleanup_obligation_id_sha256: cleanupHash, process_id_sha256: processId, browser_boot_id_sha256: bootId, execution_epoch_sha256: epoch, worker_id_sha256: workerId, browser_lease_epoch: Number(leaseEpoch), cleanup_path: cleanupPath, event_seqs: hashedSeqs };
  const reason = terminated ? "authoritative_platform_fence_after_owner_loss" : direct ? "direct_cleanup_before_process_death" : "authoritative_recovery_after_process_death";
  return { required: true, ready: true, reason, executionEpochSha256: epoch, workerIdSha256: workerId, browserLeaseEpoch: Number(leaseEpoch), proofSha256: canonicalRequestHash(proofCore), eventSeqs };
}

/** The lowest-sequence event, independent of array order. */
function earliestBySeq<T extends { seq: number }>(events: readonly T[]): T | null {
  return events.reduce<T | null>((earliest, event) => (earliest === null || event.seq < earliest.seq ? event : earliest), null);
}
