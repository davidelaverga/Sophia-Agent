import type { LabEvent, RunRecord } from "./domain.js";
import type { BrowserLease } from "./ledger.js";
import { deriveExecutionOwnership } from "./execution-ownership.js";
import { deriveExecutionEpochCleanupProof } from "./execution-cleanup.js";
import { deriveRecoveryAllocationFromOwnerHash, deriveRecoveryBrowserBinding, projectRecoveryControlBinding, recoverySettlementProof, type RecoveryControlRecord } from "./recovery-control.js";
import { sha256 } from "./security.js";

export interface HistoricalRecoverySource {
  run: RunRecord;
  callerPartitionId: string;
  events: LabEvent[];
  lease: BrowserLease | null;
}
export type RecoveryBackfillAssessment =
  | { ready: true; control: RecoveryControlRecord }
  | { ready: false; runIdSha256: string; reason: "historical_allocation_unknown" | "historical_identity_invalid" | "historical_event_binding_invalid" | "historical_d02_control_incomplete" | "historical_owner_binding_conflict" };

/** Read-only v3 assessment. It cannot authorize DDL, synthesize historical
 * nonallocation, recover erased identities, or certify a cached cleanup flag. */
export function assessHistoricalRecovery(source: HistoricalRecoverySource): RecoveryBackfillAssessment {
  const { run, events, lease } = source;
  const reject = (reason: Extract<RecoveryBackfillAssessment, { ready: false }>["reason"]): RecoveryBackfillAssessment => ({ ready: false, runIdSha256: sha256(run.id), reason });
  if (events.some(e => e.runId !== run.id) || (lease !== null && lease.runId !== run.id)) return reject("historical_event_binding_invalid");
  let binding;
  try { binding = projectRecoveryControlBinding(run, source.callerPartitionId); }
  catch { return reject("historical_identity_invalid"); }
  // D02 also needs independently retained freeze/dispatch/settlement authority;
  // generic recovery controls cannot substitute for that historical chain.
  if (run.scenarioId === "V-D02") return reject("historical_d02_control_incomplete");
  let ownership;
  try { ownership = deriveExecutionOwnership(run, events); } catch { /* Missing evidence is not ownership. */ }
  // Positive allocation evidence is sufficient to preserve an unresolved
  // obligation. Absence of these records is never nonallocation attestation.
  const allocated = lease !== null || ownership !== undefined || run.canonicalSessionId !== null
    || run.providerSessionId !== null || run.threadId !== null;
  if (!allocated) return reject("historical_allocation_unknown");
  if (lease && ownership && (sha256(lease.workerId) !== ownership.workerIdSha256 || lease.leaseEpoch !== ownership.browserLeaseEpoch)) return reject("historical_owner_binding_conflict");
  let allocation;
  try {
    allocation = lease ? deriveRecoveryBrowserBinding(run.id, lease.workerId, lease.leaseEpoch)
      : ownership ? deriveRecoveryAllocationFromOwnerHash(run.id, ownership.workerIdSha256, ownership.browserLeaseEpoch) : undefined;
  } catch { return reject("historical_owner_binding_conflict"); }
  const cleanup = deriveExecutionEpochCleanupProof(run, events);
  let remotePurgeComplete = false;
  let gatewayLiveZero = false;
  for (const event of events) {
    if (event.kind !== "cleanup.recovery") continue;
    if (cleanup.eventSeqs.processClosed === null || event.seq <= cleanup.eventSeqs.processClosed) continue;
    try {
      const proof = recoverySettlementProof(binding, event);
      gatewayLiveZero = true;
      remotePurgeComplete ||= proof.remotePurgeComplete;
    } catch { /* A malformed or foreign receipt is not settlement. */ }
  }
  const exactLease = lease === null || (cleanup.workerIdSha256 === sha256(lease.workerId) && cleanup.browserLeaseEpoch === lease.leaseEpoch);
  const control: RecoveryControlRecord = { binding, browserAllocationEver: true, version: 1,
    liveCleanupComplete: lease === null && cleanup.ready && gatewayLiveZero,
    remotePurgeComplete: lease === null && cleanup.ready && gatewayLiveZero && remotePurgeComplete,
    retentionPurgeDueAt: run.retentionPurgeDueAt, contentPurgedAt: null,
    ...(allocation ? { browserAllocationBinding: allocation } : {}),
    ...(ownership ? { executionOwnership: ownership } : {}),
    ...(cleanup.ready && exactLease ? { executionCleanupProof: cleanup } : {}) };
  return { ready: true, control };
}
