import { deriveExecutionOwnership } from "./execution-ownership.js";
import { ingestGenericOwnerLoss } from "./generic-owner-loss.js";
import { deriveRetainedGenericRecovery } from "./retained-generic-recovery.js";
import { z } from "zod";
import { verifyRetainedD02OwnerDeath } from "./retained-owner-verifier.js";
import { parseRetainedOwnerDeath } from "./retained-owner-death.js";
import { verifyRetainedD02ProviderSettlement } from "./retained-d02-provider.js";
import type { RetainedOwnerIngestion, RetainedProviderIngestion } from "./retained-ingestion.js";
import { deriveRetainedD02Recovery, recoveryAttemptAuditHash } from "./retained-d02-recovery.js";
import type { RecoveryAttemptIdentity } from "./recovery-attempt.js";
import { D02_DISPATCH_EVENT, deriveD02RecoveryJournal } from "./d02-recovery-journal.js";
import {
  TERMINAL_RUN_STATES,
  VoiceLabError,
  labError,
  type EvidenceRecord,
  type DurableArtifact,
  type LabError,
  type LabEvent,
  type OperationRecord,
  type OperationState,
  type RunRecord,
  type SuiteRecord,
  type SuiteEvidenceRecord,
} from "./domain.js";
import type { AuthAuditRecord, BrowserLease, ClaimedOperation, EventAppendInput, EventClaimGuard, EventPage, LedgerHealth, NewOperation, OperationAdmission, PrincipalProvisionCapabilityRotation, PrincipalProvisionClaim, PrincipalProvisionControlRecord, PrincipalProvisionPreparation, PrincipalProvisionReadiness, RetentionTombstone, RollingAdmissionFence, RollingAdmissionLimits, RollingAdmissionReservation, RollingAdmissionResult, RunPatch, VoiceLabLedger, WorkerHeartbeat } from "./ledger.js";
import { parseExactPrincipalProvisionReceipt } from './principal-provision-receipt.js';
import { deriveExecutionEpochCleanupProof, sameExecutionCleanupProof } from "./execution-cleanup.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { CallerPartitioner, type CallerPartitionKeyRing } from "./caller-partition.js";
import { RETAINED_RECOVERY_RETRY_MS, executionMatchesRecoveryAllocation } from "./recovery-control.js";
import { prepareGenericOwnerDispatch, consumeGenericOwnerDispatch, type PrepareGenericOwnerDispatch, type ConsumeGenericOwnerDispatch, type GenericOwnerDispatchResult } from "./generic-owner-dispatch.js";
import { deriveRecoveryBrowserBinding, projectRecoveryControlBinding, recoveryCapabilityAudit, recoveryInventoryCursor, recoverySettlementProof, validateRecoveryBrowserBinding, type RecoveryControlRecord } from "./recovery-control.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryVoiceLabLedger implements VoiceLabLedger {
  readonly #runs = new Map<string, RunRecord>();
  readonly #recoveryControls = new Map<string, RecoveryControlRecord>();
  readonly #recoveryScheduled = new Map<string, number>();
  readonly #operations = new Map<string, OperationRecord>();
  readonly #operationKeys = new Map<string, string>();
  readonly #events = new Map<string, LabEvent[]>();
  readonly #suites = new Map<string, SuiteRecord>();
  readonly #suiteKeys = new Map<string, string>();
  readonly #suiteEvidence = new Map<string, SuiteEvidenceRecord>();
  readonly #suiteEvidenceByManifest = new Map<string, string>();
  readonly #evidence = new Map<string, EvidenceRecord>();
  readonly #evidenceRevisions = new Map<string, EvidenceRecord>();
  readonly #artifacts = new Map<string, DurableArtifact>();
  readonly #browserLeases = new Map<string, BrowserLease>();
  readonly #workerHeartbeats = new Map<string, WorkerHeartbeat>();
  readonly #authAudit: AuthAuditRecord[] = [];
  readonly #principalProvisions = new Map<string, PrincipalProvisionControlRecord>();
  #nextAuthAuditId = 0;
  readonly #admissions = new Map<string, RollingAdmissionReservation>();
  readonly #retentionTombstones = new Map<string, RetentionTombstone & { expiresAt: Date }>();
  readonly #retentionKey = "voice-lab-memory-retention-test-key-0123456789";
  readonly #callerPartitions: CallerPartitioner;

  constructor(nodeEnv = process.env.NODE_ENV, keyRing: CallerPartitionKeyRing = { activeKeyId: "test-v1", keys: { "test-v1": "caller-partition-memory-secret-000000000001" } }) {
    if (nodeEnv !== "test") throw new VoiceLabError(labError("MEMORY_LEDGER_FORBIDDEN", "The memory ledger is test-only.", "internal"));
    this.#callerPartitions = new CallerPartitioner(keyRing);
  }

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<LedgerHealth> { return { ok: true, detail: "memory-test-only" }; }

  #runRequiresAdmission(run: RunRecord): boolean {
    return !TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete
      || this.#recoveryControls.get(run.id)?.liveCleanupComplete === false || this.#browserLeases.has(run.id);
  }
  async countActiveRuns(callerId?: string): Promise<number> {
    const partitions = callerId === undefined ? null : new Set(this.#callerPartitions.callerIds(callerId));
    const retained = [...this.#recoveryControls.values()].filter((control) => !this.#runs.has(control.binding.runId) && (!control.liveCleanupComplete || this.#browserLeases.has(control.binding.runId)) && (partitions === null || partitions.has(control.binding.callerPartitionId))).length;
    return retained + [...this.#runs.values()].filter((run) => this.#runRequiresAdmission(run) && (callerId === undefined || run.callerId === callerId)).length;
  }

  async listRecoveryControls(limit: number, afterRunId?: string): Promise<RecoveryControlRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw conflict("RECOVERY_LIMIT_INVALID", "Recovery listing limit is invalid.");
    const cursor = recoveryInventoryCursor(afterRunId);
    return clone([...this.#recoveryControls.values()]
      .filter((control) => (cursor === null || control.binding.runId > cursor)
        && (!control.liveCleanupComplete || !control.remotePurgeComplete || this.#browserLeases.has(control.binding.runId)))
      .sort((a, b) => a.binding.runId < b.binding.runId ? -1 : a.binding.runId > b.binding.runId ? 1 : 0)
      .slice(0, limit));
  }
  async recordRecoveryCapabilityAudit(runId: string, expectedVersion: number, jtiHash: string, argumentHash: string): Promise<void> {
    const control = this.#recoveryControls.get(runId);
    if (!control || control.contentPurgedAt === null || control.version !== expectedVersion) throw conflict("RECOVERY_VERSION_CONFLICT", "Retained recovery authorization requires the exact durable revision.");
    this.#authAudit.push(clone({ ...recoveryCapabilityAudit(control, jtiHash, argumentHash), id: ++this.#nextAuthAuditId }));
  }
  async scheduleRetainedRecovery(limit: number): Promise<RecoveryControlRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw conflict("RECOVERY_LIMIT_INVALID", "Recovery scheduling limit is invalid.");
    const now = Date.now();
    const selected = [...this.#recoveryControls.values()]
      .filter(c => c.contentPurgedAt !== null && (!c.liveCleanupComplete || !c.remotePurgeComplete || this.#browserLeases.has(c.binding.runId)))
      .filter(c => !this.#recoveryScheduled.has(c.binding.runId) || this.#recoveryScheduled.get(c.binding.runId)! <= now - RETAINED_RECOVERY_RETRY_MS)
      .sort((a, b) => (this.#recoveryScheduled.get(a.binding.runId) ?? 0) - (this.#recoveryScheduled.get(b.binding.runId) ?? 0)
        || a.binding.runId.localeCompare(b.binding.runId)).slice(0, limit);
    for (const control of selected) this.#recoveryScheduled.set(control.binding.runId, now);
    return clone(selected);
  }
  async preserveRecoveryExecutionOwnership(runId: string): Promise<RecoveryControlRecord> {
    const run = this.#runs.get(runId);
    const current = this.#recoveryControls.get(runId);
    const lease = this.#browserLeases.get(runId);
    if (!run || !current || current.contentPurgedAt !== null || !current.browserAllocationEver) throw conflict("RECOVERY_OWNERSHIP_UNAVAILABLE", "Ownership must be preserved before content deletion.");
    const ownership = deriveExecutionOwnership(run, this.#events.get(runId) ?? []);
    if (!executionMatchesRecoveryAllocation(current, ownership)) throw conflict("RECOVERY_LEASE_MISMATCH", "Ownership must match the durable allocation.");
    if (!lease || lease.expiresAt <= new Date() || sha256(lease.workerId) !== ownership.workerIdSha256 || lease.leaseEpoch !== ownership.browserLeaseEpoch) throw conflict("RECOVERY_LEASE_MISMATCH", "Ownership requires its exact live allocation lease.");
    if (current.executionOwnership) {
      if (canonicalRequestHash(current.executionOwnership) !== canonicalRequestHash(ownership)) throw conflict("RECOVERY_OWNERSHIP_CONFLICT", "Execution ownership is immutable.");
      return clone(current);
    }
    const updated = { ...current, version: current.version + 1, executionOwnership: ownership };
    this.#recoveryControls.set(runId, updated);
    return clone(updated);
  }
  async preserveRecoveryExecutionCleanup(runId: string): Promise<RecoveryControlRecord> {
    const run = this.#runs.get(runId);
    const current = this.#recoveryControls.get(runId);
    if (!run || !current || !current.browserAllocationEver || current.contentPurgedAt !== null) throw conflict("RECOVERY_EXECUTION_PROOF_UNAVAILABLE", "Execution proof must be preserved from its owning evidence before content deletion.");
    const proof = deriveExecutionEpochCleanupProof(run, this.#events.get(runId) ?? []);
    const lease = this.#browserLeases.get(runId);
    if (!proof.ready || !executionMatchesRecoveryAllocation(current, proof) || (lease && (proof.workerIdSha256 !== sha256(lease.workerId) || proof.browserLeaseEpoch !== lease.leaseEpoch))) throw conflict("RECOVERY_EXECUTION_PROOF_UNCONFIRMED", "Exact execution ownership and cleanup are not proven.");
    if (current.executionCleanupProof) {
      if (!sameExecutionCleanupProof(current.executionCleanupProof, proof)) throw conflict("RECOVERY_EXECUTION_PROOF_CONFLICT", "Preserved execution cleanup is immutable.");
      return clone(current);
    }
    const updated = { ...current, version: current.version + 1, executionCleanupProof: proof };
    this.#recoveryControls.set(runId, updated);
    return clone(updated);
  }
  async bindRecoveryBrowserContext(runId: string, workerId: string, leaseEpoch: number, driverBinding: unknown): Promise<RecoveryControlRecord> {
    const current = this.#recoveryControls.get(runId);
    const lease = this.#browserLeases.get(runId);
    if (!current || !this.#runs.has(runId) || current.contentPurgedAt !== null) throw conflict("RECOVERY_BINDING_UNAVAILABLE", "Recovery binding cannot be created after content deletion.");
    const binding = validateRecoveryBrowserBinding(current.binding, driverBinding);
    if (!current.browserAllocationBinding || canonicalRequestHash(current.browserAllocationBinding) !== canonicalRequestHash(binding)) throw conflict("RECOVERY_BINDING_CONFLICT", "Driver attestation must match the prior allocation intent.");
    if (!lease || lease.workerId !== workerId || lease.leaseEpoch !== leaseEpoch || lease.expiresAt <= new Date()
      || binding.browser_worker_id_sha256 !== sha256(workerId) || binding.browser_lease_epoch !== leaseEpoch) throw conflict("RECOVERY_LEASE_MISMATCH", "Recovery binding requires the exact live browser lease.");
    if (current.browserContextBinding) {
      if (canonicalRequestHash(current.browserContextBinding) !== canonicalRequestHash(binding)) throw conflict("RECOVERY_BINDING_CONFLICT", "Recovery browser binding is immutable.");
      return clone(current);
    }
    const updated = { ...current, version: current.version + 1, browserContextBinding: binding };
    this.#recoveryControls.set(runId, updated);
    return clone(updated);
  }
  async getRecoveryControl(runId: string): Promise<RecoveryControlRecord | null> {
    return clone(this.#recoveryControls.get(runId) ?? null);
  }
  async persistGenericOwnerLoss(input: import("./generic-owner-loss.js").GenericOwnerLossIngestion) {
    const control = this.#recoveryControls.get(input.runId);
    if (!control) throw new Error("GENERIC_OWNER_CONTROL_MISSING");
    const result = ingestGenericOwnerLoss(control, input, new Date());
    if (!result.replay) this.#recoveryControls.set(input.runId, clone({ ...control, version: result.version, genericOwnerLoss: result.proof }));
    return clone(result);
  }
  async prepareGenericOwnerDispatch(input: PrepareGenericOwnerDispatch): Promise<RecoveryControlRecord> {
    const current = this.#recoveryControls.get(input.runId);
    if (!current) throw new Error("GENERIC_DISPATCH_CONTROL_MISSING");
    const journal = prepareGenericOwnerDispatch(current, input, new Date());
    if (current.genericOwnerDispatch) return clone(current);
    for (const other of this.#recoveryControls.values()) {
      if (other.genericOwnerDispatch?.workerServiceIdSha256 === journal.workerServiceIdSha256
        && other.genericOwnerDispatch.workerIdSha256 === journal.workerIdSha256) throw new Error("GENERIC_DISPATCH_OWNER_ALREADY_CLAIMED");
    }
    const updated = { ...current, genericOwnerDispatch: journal, version: current.version + 1 };
    this.#recoveryControls.set(input.runId, updated);
    return clone(updated);
  }
  async consumeGenericOwnerDispatch(input: ConsumeGenericOwnerDispatch): Promise<GenericOwnerDispatchResult> {
    const current = this.#recoveryControls.get(input.runId);
    if (!current) throw new Error("GENERIC_DISPATCH_CONTROL_MISSING");
    const journal = consumeGenericOwnerDispatch(current, input, new Date());
    if (current.genericOwnerDispatch?.consumedAt !== null) return { dispatchAllowed: false, control: clone(current) };
    const updated = { ...current, genericOwnerDispatch: journal, version: current.version + 1 };
    this.#recoveryControls.set(input.runId, updated);
    return { dispatchAllowed: true, control: clone(updated) };
  }
  async persistRetainedD02OwnerDeath(input: RetainedOwnerIngestion) {
    z.string().uuid().parse(input.runId);
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.expectedVersion);
    const control = this.#recoveryControls.get(input.runId);
    if (!control) throw new Error("OWNER_CONTROL_UNAVAILABLE");
    const lease = this.#browserLeases.get(input.runId);
    if (lease && (sha256(lease.workerId) !== control.executionOwnership?.workerIdSha256
      || lease.leaseEpoch !== control.executionOwnership?.browserLeaseEpoch)) throw new Error("OWNER_LEASE_MISMATCH");
    const previous = control.d02OwnerDeath;
    if (previous && previous.signedReceiptSha256 !== canonicalRequestHash(input.receipt)) throw new Error("OWNER_DEATH_IMMUTABLE");
    const proof = parseRetainedOwnerDeath(verifyRetainedD02OwnerDeath({ ...input, control,
      acceptedAt: previous ? new Date(previous.acceptedAt) : new Date() }));
    if (previous) {
      if (canonicalRequestHash(previous) !== canonicalRequestHash(proof)) throw new Error("OWNER_DEATH_IMMUTABLE");
      return clone({ replay: true, version: control.version, proof });
    }
    if (control.version !== input.expectedVersion) throw new Error("OWNER_CONTROL_VERSION_CONFLICT");
    const updated = { ...control, d02OwnerDeath: proof, version: control.version + 1 };
    this.#recoveryControls.set(input.runId, clone(updated));
    return clone({ replay: false, version: updated.version, proof });
  }
  async persistRetainedD02ProviderSettlement(input: RetainedProviderIngestion) {
    z.string().uuid().parse(input.runId);
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.expectedVersion);
    const control = this.#recoveryControls.get(input.runId);
    if (!control) throw new Error("PROVIDER_CONTROL_UNAVAILABLE");
    const lease = this.#browserLeases.get(input.runId);
    if (lease && (sha256(lease.workerId) !== control.executionOwnership?.workerIdSha256
      || lease.leaseEpoch !== control.executionOwnership?.browserLeaseEpoch)) throw new Error("PROVIDER_LEASE_MISMATCH");
    const previous = control.d02ProviderSettlement;
    if (previous && previous.gatewayReceiptSha256 !== canonicalRequestHash(input.receipt)) throw new Error("PROVIDER_SETTLEMENT_IMMUTABLE");
    const proof = verifyRetainedD02ProviderSettlement(control, input.receipt, input.authority, new Date());
    if (previous) {
      if (canonicalRequestHash(previous) !== canonicalRequestHash(proof)) throw new Error("PROVIDER_SETTLEMENT_IMMUTABLE");
      return clone({ replay: true, version: control.version, proof });
    }
    if (control.version !== input.expectedVersion) throw new Error("PROVIDER_CONTROL_VERSION_CONFLICT");
    const updated = { ...control, d02ProviderSettlement: proof, version: control.version + 1 };
    this.#recoveryControls.set(input.runId, clone(updated));
    return clone({ replay: false, version: updated.version, proof });
  }
  async settleRecoveryControl(runId: string, expectedVersion: number, canonicalEvent: unknown, attempt?: RecoveryAttemptIdentity): Promise<RecoveryControlRecord> {
    const current = this.#recoveryControls.get(runId);
    if (!current) throw notFound("RECOVERY_CONTROL_NOT_FOUND", "Recovery control was not found.");
    if (current.contentPurgedAt === null) throw conflict("RECOVERY_CONTENT_NOT_PURGED", "Live-run settlement belongs to the existing execution path.");
    const proof = recoverySettlementProof(current.binding, canonicalEvent);
    const lease = this.#browserLeases.get(runId);
    let externalProof;
    if (current.browserAllocationEver && !current.executionCleanupProof?.ready && !current.d02RecoverySettlement && attempt && current.d02OwnerDeath && current.d02ProviderSettlement) {
      externalProof = deriveRetainedD02Recovery(current, canonicalEvent, attempt, new Date());
      if (!this.#authAudit.some(a => a.callerId === current.binding.callerPartitionId && a.action === "capability:session:recover" && a.outcome === "allowed" && a.argumentHash === recoveryAttemptAuditHash(current, attempt))) throw conflict("RECOVERY_ATTEMPT_AUDIT_MISSING", "Exact retained recovery attempt was not durably authorized.");
      if (lease && (sha256(lease.workerId) !== externalProof.workerIdSha256 || lease.leaseEpoch !== externalProof.browserLeaseEpoch)) throw conflict("RECOVERY_LEASE_MISMATCH", "Recovery must close only the original allocation.");
    }
    let genericProof;
    if (current.genericOwnerLoss && !current.genericRecoverySettlement && attempt) {
      genericProof = deriveRetainedGenericRecovery(current, canonicalEvent, attempt, new Date());
      if (!this.#authAudit.some(a => a.callerId === current.binding.callerPartitionId && a.action === "capability:session:recover" && a.outcome === "allowed" && a.argumentHash === recoveryAttemptAuditHash(current, attempt))) throw conflict("RECOVERY_ATTEMPT_AUDIT_MISSING", "Exact retained recovery attempt was not durably authorized.");
      if (lease && (sha256(lease.workerId) !== genericProof.workerIdSha256 || lease.leaseEpoch !== genericProof.browserLeaseEpoch)) throw conflict("RECOVERY_LEASE_MISMATCH", "Recovery must close only the original allocation.");
    }
    if (lease && !externalProof && !genericProof) throw conflict("RECOVERY_BROWSER_UNSETTLED", "Recovery cannot settle while a browser lease remains.");
    if (current.browserAllocationEver !== false && !current.executionCleanupProof?.ready && !current.d02RecoverySettlement && !current.genericRecoverySettlement && !externalProof && !genericProof) throw conflict("RECOVERY_EXECUTION_UNCONFIRMED", "Allocated browser execution must have an independently preserved cleanup proof.");
    if (current.lastSettlement?.fromVersion === expectedVersion && current.lastSettlement.eventSha256 === proof.eventSha256) return clone(current);
    if (current.version !== expectedVersion) throw conflict("RECOVERY_VERSION_CONFLICT", "Recovery control changed concurrently.");
    const settled: RecoveryControlRecord = {
      ...current, version: current.version + 1, liveCleanupComplete: true,
      remotePurgeComplete: current.remotePurgeComplete || proof.remotePurgeComplete,
      lastSettlement: { fromVersion: expectedVersion, eventSha256: proof.eventSha256, receiptSha256: proof.receiptSha256 },
      ...(externalProof ? { d02RecoverySettlement: externalProof } : {}),
      ...(genericProof ? { genericRecoverySettlement: genericProof } : {}),
    };
    if ((externalProof || genericProof) && lease) this.#browserLeases.delete(runId);
    this.#recoveryControls.set(runId, settled);
    if (settled.remotePurgeComplete && settled.retentionLookupHmac) {
      const tombstone = this.#retentionTombstones.get(settled.retentionLookupHmac);
      if (tombstone) this.#retentionTombstones.set(settled.retentionLookupHmac, { ...tombstone, remotePurgeStatus: "confirmed" });
    }
    return clone(settled);
  }
  async listExpiredRuns(now: Date, limit: number): Promise<RunRecord[]> { return clone([...this.#runs.values()].filter((run) => !TERMINAL_RUN_STATES.has(run.state) && run.expiresAt <= now).slice(0, limit)); }
  async listRunsNeedingRecovery(limit: number, afterRunId?: string): Promise<RunRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw conflict("RECOVERY_LIMIT_INVALID", "Recovery listing limit is invalid.");
    const cursor = recoveryInventoryCursor(afterRunId);
    return clone([...this.#runs.values()].filter((run) => {
      if (cursor !== null && run.id <= cursor) return false;
      if (run.cleanupComplete && this.#recoveryControls.get(run.id)?.liveCleanupComplete === true && !this.#browserLeases.has(run.id)) return false;
      if (TERMINAL_RUN_STATES.has(run.state)) return true;
      const operations = [...this.#operations.values()].filter((operation) => operation.runId === run.id);
      const terminalFailure = operations.some((operation) => operation.state === "failed" || operation.state === "timed_out");
      const liveOperation = operations.some((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state));
      return terminalFailure && !liveOperation;
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, limit));
  }
  async listRunsPendingEvidence(limit: number): Promise<RunRecord[]> {
    return clone([...this.#runs.values()].filter((run) => {
      const operations = [...this.#operations.values()].filter((operation) => operation.runId === run.id);
      const settledEnd = operations.some((operation) => operation.type === "end" && operation.state === "succeeded");
      const nonterminalOperation = operations.some((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state));
      if (run.state === "exporting") return !nonterminalOperation;
      if (!TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete) return false;
      if (run.terminalError === null && run.state === "completed" && run.scenarioId !== "V-S01" && run.scenarioId !== "V-S02" && !settledEnd) return false;
      const evidence = this.#evidence.get(run.id);
      const artifactBytes = [...this.#artifacts.values()]
        .filter((artifact) => artifact.runId === run.id)
        .reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
      // Published evidence is immutable. Once the per-run store is inside the
      // reserved headroom for its hard 8 MB trigger, a later maintenance pass
      // cannot safely publish another full revision. Keep the last verified
      // manifest available and prevent a retry loop from starving recovery of
      // unrelated runs.
      if (evidence !== undefined && artifactBytes >= 7_500_000) return false;
      return evidence === undefined || evidence.revisionSeq < run.latestCursor;
    }).sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime()).slice(0, limit));
  }
  async listRunsCertificationDue(now: Date, limit: number): Promise<RunRecord[]> {
    return clone([...this.#runs.values()].filter((run) => run.state === "pending_external_evidence" && run.expiresAt <= now).sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime()).slice(0, limit));
  }
  async listRunsRetentionDue(now: Date, limit: number): Promise<RunRecord[]> {
    return clone([...this.#runs.values()]
      .filter((run) => TERMINAL_RUN_STATES.has(run.state) && run.cleanupComplete && run.retentionPurgePending && run.retentionPurgeDueAt !== null && run.retentionPurgeDueAt <= now && run.evidencePurgedAt === null)
      .sort((left, right) => left.retentionPurgeDueAt!.getTime() - right.retentionPurgeDueAt!.getTime())
      .slice(0, limit));
  }

  async reserveRollingAdmission(reservation: RollingAdmissionReservation, limits: RollingAdmissionLimits): Promise<RollingAdmissionResult> {
    return this.#reserveRollingAdmission(reservation, limits);
  }

  #reserveRollingAdmission(reservation: RollingAdmissionReservation, limits: RollingAdmissionLimits): RollingAdmissionResult {
    validateRollingReservation(reservation);
    const reservationKeys = this.#callerPartitions.reservationKeys(reservation.reservationKey);
    const callerPartitions = new Set(this.#callerPartitions.callerIds(reservation.callerId));
    const prior = reservationKeys.map((key) => this.#admissions.get(key)).find((row): row is RollingAdmissionReservation => row !== undefined);
    if (prior) {
      assertSameRollingReservation(prior, reservation, callerPartitions);
      return rollingAdmissionResult([...this.#admissions.values()], prior, limits, true, callerPartitions);
    }
    const persisted = { ...reservation, reservationKey: reservationKeys[0]!, callerId: this.#callerPartitions.activeCallerId(reservation.callerId) };
    const cutoff = reservation.observedAt.getTime() - limits.windowSeconds * 1_000;
    const active = [...this.#admissions.values()].filter((row) => row.environment === reservation.environment && row.observedAt.getTime() > cutoff);
    assertRollingCapacity(active, persisted, limits, callerPartitions);
    this.#admissions.set(persisted.reservationKey, clone(persisted));
    return rollingAdmissionResult([...active, persisted], persisted, limits, false, callerPartitions);
  }

  async createRunWithOperation(run: RunRecord, operation: NewOperation, limits: { global: number; caller: number }, rolling?: RollingAdmissionFence): Promise<{ run: RunRecord; operation: OperationRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }> {
    const key = operationKey(operation);
    const existingId = this.#operationKeys.get(key);
    if (existingId) {
      const existing = this.#operations.get(existingId)!;
      assertSameRequest(existing, operation.requestHash);
      const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
      return { run: clone(this.#runs.get(existing.runId)!), operation: clone(existing), replay: true, ...(rollingAdmission ? { rollingAdmission } : {}) };
    }
    // Do not await between admission and insertion: the memory transaction must
    // remain atomic even when multiple callers submit starts in one tick.
    const active = [...this.#runs.values()].filter((candidate) => this.#runRequiresAdmission(candidate));
    const retained = [...this.#recoveryControls.values()].filter((control) => !this.#runs.has(control.binding.runId) && (!control.liveCleanupComplete || this.#browserLeases.has(control.binding.runId)));
    const partitions = new Set(this.#callerPartitions.callerIds(operation.callerId));
    if (active.length + retained.length >= limits.global || active.filter((candidate) => candidate.callerId === operation.callerId).length + retained.filter((control) => partitions.has(control.binding.callerPartitionId)).length >= limits.caller) throw conflict("CONCURRENCY_LIMIT", "Voice Lab concurrency limit is reached.");
    const binding = projectRecoveryControlBinding(run, this.#callerPartitions.activeCallerId(run.callerId));
    const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
    // A durable rolling reservation outlives the governed run/evidence bytes.
    // If its canonical operation has already been retention-purged, it is a
    // content-free replay tombstone, never authority to allocate a new run for
    // the same natural key without charging admission again.
    if (rollingAdmission?.replay) throw conflict("IDEMPOTENCY_RETENTION_EXPIRED", "The idempotent start receipt was retention-purged and cannot be replayed or reallocated.");
    if ([...this.#recoveryControls.values()].some((candidate) => candidate.binding.cleanupObligationId === run.cleanupObligationId || candidate.binding.runId === run.id || candidate.binding.testRunId === run.testRunId)) throw conflict("CLEANUP_OBLIGATION_CONFLICT", "Cleanup obligation is already bound to a run.");
    this.#recoveryControls.set(run.id, clone({ binding, browserAllocationEver: false, version: 1, liveCleanupComplete: run.cleanupComplete, retentionPurgeDueAt: run.retentionPurgeDueAt, remotePurgeComplete: run.retentionPurgeVerifiedAt !== null && !run.retentionPurgePending, contentPurgedAt: null }));
    this.#runs.set(run.id, clone(run));
    const record = newOperationRecord(operation);
    this.#operations.set(record.id, record);
    this.#operationKeys.set(key, record.id);
    return { run: clone(run), operation: clone(record), replay: false, ...(rollingAdmission ? { rollingAdmission } : {}) };
  }

  async getRun(runId: string): Promise<RunRecord | null> { return clone(this.#runs.get(runId) ?? null); }
  async getRetentionTombstone(runId: string, callerId: string): Promise<RetentionTombstone | null> {
    const value = this.#retentionTombstones.get(retentionHmac(this.#retentionKey, "lookup", `${runId}\u0000${callerId}`));
    return value && value.expiresAt > new Date() ? clone({ purgedAt: value.purgedAt, remotePurgeStatus: value.remotePurgeStatus }) : null;
  }

  async updateRun(runId: string, expectedVersion: number, patch: RunPatch): Promise<RunRecord> {
    const current = this.#runs.get(runId);
    if (!current) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    if (current.version !== expectedVersion) throw conflict("RUN_VERSION_CONFLICT", "Run changed concurrently.");
    const updated: RunRecord = {
      ...current,
      ...patch,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.#runs.set(runId, updated);
    const control = this.#recoveryControls.get(runId)!;
    this.#recoveryControls.set(runId, clone({
      ...control, version: control.version + 1,
      ...(patch.cleanupComplete !== undefined ? { liveCleanupComplete: patch.cleanupComplete } : {}),
      ...(patch.retentionPurgeDueAt !== undefined ? { retentionPurgeDueAt: patch.retentionPurgeDueAt } : {}),
      ...(patch.retentionPurgeVerifiedAt !== undefined || patch.retentionPurgePending !== undefined
        ? { remotePurgeComplete: updated.retentionPurgeVerifiedAt !== null && !updated.retentionPurgePending } : {}),
    }));
    return clone(updated);
  }

  async createOperation(operation: NewOperation, admission?: OperationAdmission, rolling?: RollingAdmissionFence): Promise<{ operation: OperationRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }> {
    const key = operationKey(operation);
    const existingId = this.#operationKeys.get(key);
    if (existingId) {
      const existing = this.#operations.get(existingId)!;
      assertSameRequest(existing, operation.requestHash);
      const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
      return { operation: clone(existing), replay: true, ...(rollingAdmission ? { rollingAdmission } : {}) };
    }
    if (!this.#runs.has(operation.runId)) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    if (hasD02OperationFence(this.#events.get(operation.runId) ?? [])) {
      throw conflict("D02_RUN_FROZEN", "The D02 browser-worker termination freeze forbids every new run operation.");
    }
    if (admission && (operation.type === "speak" || operation.type === "barge_in")) assertAdmission([...this.#operations.values()], operation, admission);
    const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
    const record = newOperationRecord(operation);
    this.#operations.set(record.id, record);
    this.#operationKeys.set(key, record.id);
    return { operation: clone(record), replay: false, ...(rollingAdmission ? { rollingAdmission } : {}) };
  }

  async getOperation(operationId: string): Promise<OperationRecord | null> { return clone(this.#operations.get(operationId) ?? null); }
  async listOperations(runId: string): Promise<OperationRecord[]> { return clone([...this.#operations.values()].filter((operation) => operation.runId === runId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())); }

  async claimNextOperation(workerId: string, leaseSeconds: number): Promise<ClaimedOperation | null> {
    const now = new Date();
    const candidate = [...this.#operations.values()]
      .filter((op) => op.state === "accepted" || op.state === "queued" || ((op.state === "leased" || op.state === "executing") && op.leaseExpiresAt !== null && op.leaseExpiresAt <= now))
      .filter((op) => !hasD02OperationFence(this.#events.get(op.runId) ?? []))
      .filter((op) => op.type === "start" || (() => { const lease = this.#browserLeases.get(op.runId); if (lease?.workerId === workerId && lease.expiresAt > now) return true; const run = this.#runs.get(op.runId); return op.type === "end" && run !== undefined && ["ending", "finalizing", "exporting"].includes(run.state); })())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!candidate) return null;
    candidate.state = "leased";
    candidate.leaseOwner = workerId;
    candidate.leaseEpoch += 1;
    candidate.leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    candidate.attemptCount += 1;
    candidate.updatedAt = now;
    return { operation: clone(candidate), run: clone(this.#runs.get(candidate.runId)!) };
  }

  async markOperationExecuting(operationId: string, workerId: string, leaseEpoch: number): Promise<OperationRecord> {
    const operation = ownedOperation(this.#operations, operationId, workerId, leaseEpoch);
    if (hasD02OperationFence(this.#events.get(operation.runId) ?? [])) throw conflict("D02_RUN_FROZEN", "The D02 browser-worker termination freeze forbids operation execution.");
    operation.state = "executing";
    operation.updatedAt = new Date();
    return clone(operation);
  }

  async heartbeatOperation(operationId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean> {
    try {
      const operation = ownedOperation(this.#operations, operationId, workerId, leaseEpoch);
      operation.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1_000);
      return true;
    } catch { return false; }
  }

  async finishOperation(operationId: string, workerId: string, leaseEpoch: number, state: Extract<OperationState, "succeeded" | "failed" | "timed_out" | "cancelled">, result: Record<string, unknown> | null, error: LabError | null): Promise<OperationRecord> {
    const operation = ownedOperation(this.#operations, operationId, workerId, leaseEpoch);
    operation.state = state;
    operation.result = clone(result);
    operation.error = clone(error);
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = new Date();
    return clone(operation);
  }

  async cancelPendingRunOperations(runId: string, exceptOperationId: string | null, error: LabError): Promise<OperationRecord[]> {
    const cancelled: OperationRecord[] = [];
    for (const operation of this.#operations.values()) {
      if (operation.runId !== runId || operation.id === exceptOperationId || !["queued", "leased", "executing"].includes(operation.state)) continue;
      operation.state = "cancelled";
      operation.result = null;
      operation.error = clone(error);
      operation.leaseOwner = null;
      operation.leaseExpiresAt = null;
      operation.updatedAt = new Date();
      cancelled.push(clone(operation));
    }
    return cancelled;
  }

  async claimEvent(runId: string, kind: string, source: LabEvent["source"], payload: Record<string, unknown>, dedupeKey: string, observedAt = new Date(), guard?: EventClaimGuard): Promise<{ event: LabEvent; replay: boolean }> {
    const run = this.#runs.get(runId);
    if (!run) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    const events = this.#events.get(runId) ?? [];
    const existing = events.find((event) => event.dedupeKey === dedupeKey);
    if (existing) {
      assertEventReplay(existing, kind, source, payload);
      if (kind === D02_DISPATCH_EVENT && guard && this.#recoveryControls.get(runId)?.d02Journal?.dispatchClaimSha256 !== payload.dispatch_claim_sha256) throw conflict("D02_JOURNAL_CONFLICT", "D02 dispatch replay lost retained authority.");
      return { event: clone(existing), replay: true };
    }
    guard?.({
      run: clone(run),
      events: clone(events),
      operations: clone([...this.#operations.values()].filter((operation) => operation.runId === runId)),
      browserLease: clone(this.#browserLeases.get(runId) ?? null),
      databaseNow: new Date(),
    });
    const event: LabEvent = { runId, seq: events.length + 1, kind, source, at: observedAt, payload: clone(payload), dedupeKey };
    if (kind === D02_DISPATCH_EVENT && guard) {
      const journal = deriveD02RecoveryJournal(run, events, event);
      const control = this.#recoveryControls.get(runId);
      if (!control || control.d02Journal) throw conflict("D02_JOURNAL_CONFLICT", "D02 dispatch journal cannot be replaced.");
      this.#recoveryControls.set(runId, clone({ ...control, version: control.version + 1, d02Journal: journal }));
    }
    events.push(event);
    this.#events.set(runId, events);
    run.latestCursor = event.seq;
    run.updatedAt = event.at;
    return { event: clone(event), replay: false };
  }

  async appendEvent(runId: string, kind: string, source: LabEvent["source"], payload: Record<string, unknown>, dedupeKey?: string, observedAt = new Date()): Promise<LabEvent> {
    if (dedupeKey) return (await this.claimEvent(runId, kind, source, payload, dedupeKey, observedAt)).event;
    const run = this.#runs.get(runId);
    if (!run) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    const events = this.#events.get(runId) ?? [];
    const event: LabEvent = { runId, seq: events.length + 1, kind, source, at: observedAt, payload: clone(payload), dedupeKey: null };
    events.push(event);
    this.#events.set(runId, events);
    run.latestCursor = event.seq;
    run.updatedAt = event.at;
    return clone(event);
  }

  async appendEvents(runId: string, inputs: EventAppendInput[]): Promise<LabEvent[]> {
    const run = this.#runs.get(runId);
    if (!run) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    const events = this.#events.get(runId) ?? [];
    const appended: LabEvent[] = [];
    for (const input of inputs) {
      const existing = input.dedupeKey
        ? events.find((event) => event.dedupeKey === input.dedupeKey)
        : undefined;
      if (existing) {
        assertEventReplay(existing, input.kind, input.source, input.payload);
        appended.push(existing);
        continue;
      }
      const event: LabEvent = {
        runId,
        seq: events.length + 1,
        kind: input.kind,
        source: input.source,
        at: input.observedAt ?? new Date(),
        payload: clone(input.payload),
        dedupeKey: input.dedupeKey ?? null,
      };
      events.push(event);
      appended.push(event);
    }
    this.#events.set(runId, events);
    const latest = events.at(-1);
    if (latest) {
      run.latestCursor = latest.seq;
      run.updatedAt = latest.at;
    }
    return clone(appended.sort((left, right) => left.seq - right.seq));
  }

  async listEvents(runId: string, after: number, limit: number): Promise<EventPage> {
    if (!this.#runs.has(runId)) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    const all = this.#events.get(runId) ?? [];
    return { events: clone(all.filter((event) => event.seq > after).slice(0, limit)), after, latest: all.at(-1)?.seq ?? 0 };
  }
  async findLatestEvent(runId: string, kinds: string[]): Promise<LabEvent | null> {
    const event = [...(this.#events.get(runId) ?? [])].reverse().find((candidate) => kinds.includes(candidate.kind));
    return clone(event ?? null);
  }

  async createSuite(suite: SuiteRecord, rolling?: RollingAdmissionFence): Promise<{ suite: SuiteRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }> {
    const key = `${suite.callerId}:${suite.idempotencyKey}`;
    const existingId = this.#suiteKeys.get(key);
    if (existingId) {
      const existing = this.#suites.get(existingId)!;
      if (existing.requestHash !== suite.requestHash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different arguments.");
      const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
      return { suite: clone(existing), replay: true, ...(rollingAdmission ? { rollingAdmission } : {}) };
    }
    const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
    if (rollingAdmission?.replay) throw conflict("IDEMPOTENCY_RETENTION_EXPIRED", "The idempotent suite receipt was retention-purged and cannot be replayed or reallocated.");
    this.#suites.set(suite.id, clone(suite));
    this.#suiteKeys.set(key, suite.id);
    return { suite: clone(suite), replay: false, ...(rollingAdmission ? { rollingAdmission } : {}) };
  }

  async getSuite(suiteId: string): Promise<SuiteRecord | null> { return clone(this.#suites.get(suiteId) ?? null); }
  async listRunnableSuites(limit: number): Promise<SuiteRecord[]> { return clone([...this.#suites.values()].filter((suite) => suite.state === "accepted" || suite.state === "running").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit)); }
  async listSuitesPendingEvidence(limit: number): Promise<SuiteRecord[]> { return clone([...this.#suites.values()].filter((suite) => ["completed", "failed", "cancelled"].includes(suite.state) && !this.#suiteEvidence.has(suite.id)).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()).slice(0, limit)); }
  async updateSuite(suiteId: string, state: SuiteRecord["state"], runIds?: string[], nextScenarioIndex?: number): Promise<SuiteRecord> {
    const suite = this.#suites.get(suiteId);
    if (!suite) throw notFound("SUITE_NOT_FOUND", "Suite run was not found.");
    suite.state = state;
    if (runIds !== undefined) suite.runIds = [...runIds];
    if (nextScenarioIndex !== undefined) suite.nextScenarioIndex = nextScenarioIndex;
    suite.updatedAt = new Date();
    return clone(suite);
  }

  async saveSuiteEvidence(evidence: SuiteEvidenceRecord): Promise<SuiteEvidenceRecord> {
    if (sha256(evidence.bytes) !== evidence.manifestSha256) throw conflict("SUITE_EVIDENCE_DIGEST_MISMATCH", "Suite evidence bytes do not match the declared SHA-256 digest.");
    if (!this.#suites.has(evidence.suiteId)) throw notFound("SUITE_NOT_FOUND", "Suite run was not found.");
    const existingSuite = this.#suiteEvidence.get(evidence.suiteId);
    const existingManifestSuite = this.#suiteEvidenceByManifest.get(evidence.manifestId);
    const existing = existingSuite ?? (existingManifestSuite ? this.#suiteEvidence.get(existingManifestSuite) : undefined);
    if (existing) {
      if (existing.suiteId !== evidence.suiteId || existing.manifestId !== evidence.manifestId || existing.manifestSha256 !== evidence.manifestSha256 || existing.schemaVersion !== evidence.schemaVersion || canonicalRequestHash(existing.artifactRefs) !== canonicalRequestHash(evidence.artifactRefs) || !Buffer.from(existing.bytes).equals(Buffer.from(evidence.bytes))) throw conflict("SUITE_EVIDENCE_CONFLICT", "Terminal suite evidence is immutable and was replayed with different content.");
      return clone(existing);
    }
    this.#suiteEvidence.set(evidence.suiteId, clone(evidence));
    this.#suiteEvidenceByManifest.set(evidence.manifestId, evidence.suiteId);
    return clone(evidence);
  }
  async getSuiteEvidence(suiteId: string): Promise<SuiteEvidenceRecord | null> { return clone(this.#suiteEvidence.get(suiteId) ?? null); }
  async getSuiteEvidenceByManifestId(manifestId: string): Promise<SuiteEvidenceRecord | null> {
    const suiteId = this.#suiteEvidenceByManifest.get(manifestId);
    return suiteId ? clone(this.#suiteEvidence.get(suiteId) ?? null) : null;
  }

  async saveEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord> {
    const priorRevision = this.#evidenceRevisions.get(evidence.manifestId);
    if (priorRevision && canonicalRequestHash(priorRevision) !== canonicalRequestHash(evidence)) throw conflict("EVIDENCE_REVISION_CONFLICT", "Evidence manifest revision is immutable and was replayed with different metadata.");
    this.#evidenceRevisions.set(evidence.manifestId, clone(evidence));
    const current = this.#evidence.get(evidence.runId);
    if (current && current.revisionSeq > evidence.revisionSeq) return clone(current);
    if (current && current.revisionSeq === evidence.revisionSeq && current.manifestId !== evidence.manifestId) throw conflict("EVIDENCE_REVISION_CONFLICT", "Evidence revision sequence was reused by a different manifest.");
    this.#evidence.set(evidence.runId, clone(evidence));
    return clone(evidence);
  }
  async getEvidence(runId: string): Promise<EvidenceRecord | null> { return clone(this.#evidence.get(runId) ?? null); }
  async saveArtifact(artifact: DurableArtifact): Promise<DurableArtifact> {
    assertArtifactDigest(artifact);
    const priorById = this.#artifacts.get(artifact.id);
    if (priorById) {
      assertArtifactReplay(priorById, artifact);
      return clone(priorById);
    }
    const priorByHash = [...this.#artifacts.values()].find((candidate) => candidate.runId === artifact.runId && candidate.sha256 === artifact.sha256);
    if (priorByHash) {
      assertArtifactReplay(priorByHash, artifact, false);
      return clone(priorByHash);
    }
    this.#artifacts.set(artifact.id, clone(artifact));
    return clone(artifact);
  }
  async getArtifact(artifactId: string): Promise<DurableArtifact | null> { return clone(this.#artifacts.get(artifactId) ?? null); }
  async listArtifacts(runId: string): Promise<DurableArtifact[]> { return clone([...this.#artifacts.values()].filter((artifact) => artifact.runId === runId).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())); }
  async deleteUnpublishedArtifacts(runId: string): Promise<number> {
    const run = this.#runs.get(runId);
    if (!run) throw notFound("RUN_NOT_FOUND", "Run was not found.");
    if (!TERMINAL_RUN_STATES.has(run.state) || this.#evidence.has(runId)) throw conflict("EVIDENCE_ORPHAN_PRUNE_FORBIDDEN", "Only unpublished artifacts for a terminal run may be pruned.");
    let deleted = 0;
    for (const [artifactId, artifact] of this.#artifacts) {
      if (artifact.runId !== runId) continue;
      this.#artifacts.delete(artifactId);
      deleted += 1;
    }
    return deleted;
  }

  async upsertBrowserLease(runId: string, workerId: string, leaseSeconds: number): Promise<BrowserLease> {
    if (!this.#runs.has(runId)) throw notFound("RUN_NOT_FOUND", "A retained recovery control cannot authorize a new browser allocation.");
    const prior = this.#browserLeases.get(runId);
    const now = new Date();
    if (prior && prior.workerId !== workerId && prior.expiresAt > now) throw conflict("BROWSER_ALREADY_LEASED", "Browser is owned by another live worker.");
    const lease = { runId, workerId, leaseEpoch: (prior?.leaseEpoch ?? 0) + 1, expiresAt: new Date(now.getTime() + leaseSeconds * 1_000), updatedAt: now };
    const control = this.#recoveryControls.get(runId)!;
    if (control.browserAllocationEver !== false) throw conflict("BROWSER_ALLOCATION_ALREADY_RESERVED", "An allocated execution cannot be replaced or reconstructed after lease loss.");
    if (control.browserAllocationBinding) throw conflict("BROWSER_ALLOCATION_ALREADY_RESERVED", "A browser allocation cannot be replaced or reconstructed.");
    const binding = deriveRecoveryBrowserBinding(runId, workerId, lease.leaseEpoch);
    this.#recoveryControls.set(runId, { ...control, version: control.version + 1, browserAllocationEver: true, browserAllocationBinding: binding });
    this.#browserLeases.set(runId, lease);
    return clone(lease);
  }
  async getBrowserLease(runId: string): Promise<BrowserLease | null> { return clone(this.#browserLeases.get(runId) ?? null); }

  async heartbeatBrowserLease(runId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean> {
    const lease = this.#browserLeases.get(runId);
    const now = new Date();
    if (!lease || lease.workerId !== workerId || lease.leaseEpoch !== leaseEpoch || lease.expiresAt <= now) return false;
    lease.expiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    lease.updatedAt = now;
    return true;
  }

  async releaseBrowserLease(runId: string, workerId: string, leaseEpoch: number): Promise<boolean> {
    const lease = this.#browserLeases.get(runId);
    if (lease?.workerId !== workerId || lease.leaseEpoch !== leaseEpoch) return false;
    this.#browserLeases.delete(runId);
    return true;
  }

  async reapExpiredBrowserLeases(now = new Date(), limit = 100, afterRunId?: string): Promise<BrowserLease[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("expired lease page limit must be between 1 and 100");
    const expired = [...this.#browserLeases.values()]
      .filter((lease) => lease.expiresAt <= now && (afterRunId === undefined || lease.runId > afterRunId))
      .sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
      .slice(0, limit);
    // Expiry revokes renewal, not the durable cleanup obligation. Keep the
    // exact receipt until proof-gated release/settlement explicitly removes it.
    return clone(expired);
  }

  async releaseRecoveredBrowserLease(runId: string): Promise<boolean> {
    const run = this.#runs.get(runId), lease = this.#browserLeases.get(runId), control = this.#recoveryControls.get(runId);
    if (!run || !lease || !control || lease.expiresAt > new Date() || run.scenarioId === "V-D02"
      || !TERMINAL_RUN_STATES.has(run.state) || control.contentPurgedAt !== null) return false;
    const proof = deriveExecutionEpochCleanupProof(run, this.#events.get(runId) ?? []);
    if (!proof.ready || !control.executionCleanupProof
      || !sameExecutionCleanupProof(control.executionCleanupProof, proof)
      || !executionMatchesRecoveryAllocation(control, proof)
      || proof.workerIdSha256 !== sha256(lease.workerId) || proof.browserLeaseEpoch !== lease.leaseEpoch) return false;
    this.#browserLeases.delete(runId);
    return true;
  }
  async heartbeatWorker(heartbeat: WorkerHeartbeat): Promise<void> { this.#workerHeartbeats.set(heartbeat.workerId, clone(heartbeat)); }
  async listLiveWorkers(since: Date): Promise<WorkerHeartbeat[]> { return clone([...this.#workerHeartbeats.values()].filter((heartbeat) => heartbeat.observedAt >= since)); }
  async recordAuthAudit(record: AuthAuditRecord): Promise<void> {
    const callerId = record.runId === null ? this.#callerPartitions.activeCallerId(record.callerId) : record.callerId;
    this.#authAudit.push(clone({ ...record, callerId, id: ++this.#nextAuthAuditId }));
  }
  async claimPrincipalProvision(preparation: PrincipalProvisionPreparation, leaseOwner: string, leaseSeconds: number, now: Date): Promise<PrincipalProvisionClaim> {
    const existing = this.#principalProvisions.get(preparation.requestHash);
    if (!existing) {
      // The lab owns exactly one dedicated product principal. A changed
      // request key or changed principal cannot open a second authority chain.
      const conflict = [...this.#principalProvisions.values()][0];
      if (conflict) return { disposition: 'conflict', record: clone(conflict) };
      const record: PrincipalProvisionControlRecord = {
        requestHash: preparation.requestHash,
        idempotencyKeyHash: preparation.idempotencyKeyHash,
        principalHash: preparation.principalHash,
        callerPartitionId: this.#callerPartitions.activeCallerId(preparation.callerId),
        issuedAt: preparation.issuedAt,
        testRunId: preparation.testRunId,
        cleanupObligationId: preparation.cleanupObligationId,
        capabilityJti: preparation.capabilityJti,
        capabilityNonce: preparation.capabilityNonce,
        capabilityHash: preparation.capabilityHash,
        providerExpiresAt: preparation.providerExpiresAt,
        environment: preparation.environment,
        expectedDeployment: clone(preparation.expectedDeployment),
        mcpBuild: preparation.mcpBuild,
        operatorSubjectHash: preparation.operatorSubjectHash,
        authAuditId: String(++this.#nextAuthAuditId),
        auditObservedAt: now,
        state: 'prepared',
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000),
        attemptCount: 1,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.#principalProvisions.set(record.requestHash, clone(record));
      return { disposition: 'claimed', record: clone(record) };
    }
    if (existing.principalHash !== preparation.principalHash) return { disposition: 'conflict', record: clone(existing) };
    if (existing.state === 'completed') return { disposition: 'completed', record: clone(existing) };
    if (existing.leaseOwner !== null && existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now) {
      return { disposition: 'pending', record: clone(existing) };
    }
    existing.leaseOwner = leaseOwner;
    existing.leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    existing.attemptCount += 1;
    existing.updatedAt = now;
    return { disposition: 'claimed', record: clone(existing) };
  }
  async rotatePrincipalProvisionCapability(requestHash: string, leaseOwner: string, rotation: PrincipalProvisionCapabilityRotation, now: Date): Promise<PrincipalProvisionControlRecord> {
    const existing = this.#principalProvisions.get(requestHash);
    if (!existing || existing.state !== 'prepared' || existing.leaseOwner !== leaseOwner) {
      throw new VoiceLabError(labError('PRINCIPAL_PROVISION_LEASE_LOST', 'Principal provision rotation no longer owns the durable lease.', 'internal'));
    }
    existing.issuedAt = rotation.issuedAt;
    existing.capabilityJti = rotation.capabilityJti;
    existing.capabilityNonce = rotation.capabilityNonce;
    existing.capabilityHash = rotation.capabilityHash;
    existing.providerExpiresAt = rotation.providerExpiresAt;
    existing.updatedAt = now;
    return clone(existing);
  }
  async finalizePrincipalProvision(requestHash: string, leaseOwner: string, receipt: Record<string, unknown>, audit: AuthAuditRecord, now: Date): Promise<PrincipalProvisionControlRecord> {
    const existing = this.#principalProvisions.get(requestHash);
    if (!existing) throw new VoiceLabError(labError('PRINCIPAL_PROVISION_PREPARE_MISSING', 'Principal provision prepare record is missing.', 'internal'));
    if (!parseExactPrincipalProvisionReceipt(existing, receipt)) {
      throw new VoiceLabError(labError('PRINCIPAL_PROVISION_RECEIPT_INVALID', 'Principal provision receipt does not match its durable prepare record.', 'internal'));
    }
    if (existing.state === 'completed') {
      if (canonicalRequestHash(existing.receipt) !== canonicalRequestHash(receipt)) throw new VoiceLabError(labError('PRINCIPAL_PROVISION_FINALIZE_CONFLICT', 'Principal provision receipt conflicts with its durable chain.', 'internal'));
      const durableAudit = this.#authAudit.find((record) => String(record.id) === existing.authAuditId);
      if (!durableAudit || durableAudit.runId !== null || durableAudit.action !== 'principal.provision'
        || durableAudit.outcome !== 'allowed' || durableAudit.argumentHash !== existing.requestHash
        || durableAudit.observedAt.toISOString() !== existing.auditObservedAt.toISOString()
        || durableAudit.callerId !== existing.callerPartitionId || durableAudit.capabilityJtiHash !== receipt.capability_jti_sha256
        || canonicalRequestHash(durableAudit.detail) !== canonicalRequestHash(receipt)) {
        throw new VoiceLabError(labError('PRINCIPAL_PROVISION_AUDIT_MISSING', 'The completed provision receipt has no exact durable audit row.', 'internal'));
      }
      return clone(existing);
    }
    if (
      existing.leaseOwner !== leaseOwner
      || audit.runId !== null
      || audit.argumentHash !== requestHash
      || audit.action !== 'principal.provision'
      || audit.outcome !== 'allowed'
      || String(audit.id) !== existing.authAuditId
      || audit.observedAt.toISOString() !== existing.auditObservedAt.toISOString()
      || sha256(audit.callerId) !== existing.operatorSubjectHash
      || !this.#callerPartitions.callerIds(audit.callerId).includes(existing.callerPartitionId)
      || audit.capabilityJtiHash !== receipt.capability_jti_sha256
      || canonicalRequestHash(audit.detail) !== canonicalRequestHash(receipt)
      || this.#authAudit.some((record) => String(record.id) === existing.authAuditId)
    ) {
      throw new VoiceLabError(labError('PRINCIPAL_PROVISION_LEASE_LOST', 'Principal provision finalize no longer owns the durable lease.', 'internal'));
    }
    existing.state = 'completed';
    existing.receipt = clone(receipt);
    existing.leaseOwner = null;
    existing.leaseExpiresAt = null;
    existing.updatedAt = now;
    this.#authAudit.push(clone({ ...audit, callerId: existing.callerPartitionId, id: existing.authAuditId }));
    return clone(existing);
  }
  async releasePrincipalProvision(requestHash: string, leaseOwner: string, now: Date): Promise<boolean> {
    const existing = this.#principalProvisions.get(requestHash);
    if (!existing || existing.state !== 'prepared' || existing.leaseOwner !== leaseOwner) return false;
    existing.leaseOwner = null;
    existing.leaseExpiresAt = null;
    existing.updatedAt = now;
    return true;
  }
  async getPrincipalProvisionReadiness(_now: Date): Promise<PrincipalProvisionReadiness> {
    const record = [...this.#principalProvisions.values()][0];
    if (!record) return { status: 'absent' };
    if (record.state === 'prepared') return { status: record.receipt === null ? 'prepared' : 'invalid' };
    const audit = this.#authAudit.find((candidate) => String(candidate.id) === record.authAuditId);
    const valid = parseExactPrincipalProvisionReceipt(record, record.receipt) !== null
      && record.leaseOwner === null
      && record.leaseExpiresAt === null
      && audit?.runId === null
      && audit.action === 'principal.provision'
      && audit.outcome === 'allowed'
      && audit.callerId === record.callerPartitionId
      && audit.capabilityJtiHash === (record.receipt as Record<string, unknown>).capability_jti_sha256
      && audit.argumentHash === record.requestHash
      && audit.observedAt.toISOString() === record.auditObservedAt.toISOString()
      && canonicalRequestHash(audit.detail) === canonicalRequestHash(record.receipt);
    return { status: valid ? 'completed' : 'invalid' };
  }
  async listAuthAudit(runId: string): Promise<AuthAuditRecord[]> { return clone(this.#authAudit.filter((record) => record.runId === runId)); }
  async listAuthAuditByArgumentHashes(callerId: string, argumentHashes: string[], since: Date): Promise<AuthAuditRecord[]> {
    const hashes = new Set(argumentHashes);
    const callers = new Set([callerId, ...this.#callerPartitions.callerIds(callerId)]);
    return clone(this.#authAudit.filter((record) => callers.has(record.callerId) && hashes.has(record.argumentHash) && record.observedAt >= since));
  }
  async listAuthAuditForCaller(callerId: string, since: Date, until: Date): Promise<AuthAuditRecord[]> {
    const callers = new Set([callerId, ...this.#callerPartitions.callerIds(callerId)]);
    return clone(this.#authAudit.filter((record) => callers.has(record.callerId) && record.observedAt >= since && record.observedAt <= until));
  }
  async purgeExpiredRetention(now: Date, limit: number): Promise<string[]> {
    const candidates = [...this.#runs.values()].filter((run) => {
      if (!TERMINAL_RUN_STATES.has(run.state) || run.evidencePurgedAt !== null) return false;
      const due = run.retentionPurgeDueAt ?? new Date(run.updatedAt.getTime() + run.capturePolicy.retentionHours * 3_600_000);
      return due <= now;
    }).slice(0, limit);
    for (const run of candidates) {
      this.#events.delete(run.id);
      this.#evidence.delete(run.id);
      for (const [manifestId, revision] of this.#evidenceRevisions) if (revision.runId === run.id) this.#evidenceRevisions.delete(manifestId);
      for (const [id, artifact] of this.#artifacts) if (artifact.runId === run.id) this.#artifacts.delete(id);
      for (const [id, operation] of this.#operations) if (operation.runId === run.id) { this.#operations.delete(id); this.#operationKeys.delete(operationKey(operation)); }
      for (let index = this.#authAudit.length - 1; index >= 0; index -= 1) if (this.#authAudit[index]?.runId === run.id) this.#authAudit.splice(index, 1);
      // Expiry removes content, not allocation authority or a live lease.
      const control = this.#recoveryControls.get(run.id)!;
      this.#recoveryControls.set(run.id, clone({ ...control, version: control.version + 1, contentPurgedAt: now, retentionLookupHmac: retentionHmac(this.#retentionKey, "lookup", `${run.id}\u0000${run.callerId}`) }));
      this.#retentionTombstones.set(retentionHmac(this.#retentionKey, "lookup", `${run.id}\u0000${run.callerId}`), { purgedAt: now, remotePurgeStatus: run.retentionPurgeVerifiedAt !== null && !run.retentionPurgePending ? "confirmed" : "unconfirmed", expiresAt: new Date(now.getTime() + 30 * 86_400_000) });
      this.#runs.delete(run.id);
      for (const suite of this.#suites.values()) suite.runIds = suite.runIds.filter((runId) => runId !== run.id);
    }
    for (const [id, suite] of this.#suites) if (["completed", "failed", "cancelled"].includes(suite.state) && suite.runIds.length === 0) { this.#suites.delete(id); this.#suiteKeys.delete(`${suite.callerId}:${suite.idempotencyKey}`); this.#suiteEvidence.delete(id); }
    for (const [key, admission] of this.#admissions) if (admission.observedAt < new Date(now.getTime() - 8 * 86_400_000)) this.#admissions.delete(key);
    for (const [key, tombstone] of this.#retentionTombstones) if (tombstone.expiresAt <= now) this.#retentionTombstones.delete(key);
    for (const [workerId, heartbeat] of this.#workerHeartbeats) if (heartbeat.observedAt < new Date(now.getTime() - 3_600_000)) this.#workerHeartbeats.delete(workerId);
    for (let index = this.#authAudit.length - 1; index >= 0; index -= 1) if (this.#authAudit[index]?.runId === null && this.#authAudit[index]!.observedAt < new Date(now.getTime() - 7 * 86_400_000)) this.#authAudit.splice(index, 1);
    return candidates.map((run) => run.id);
  }
}

function hasD02OperationFence(events: readonly LabEvent[]): boolean {
  return events.some((event) => event.source === "canonical" && (
    event.kind === "product.d02_browser_worker_termination_freeze_pending"
    || event.kind === "product.d02_gateway_browser_worker_termination_frozen"
    || event.kind === "product.d02_render_worker_dispatch_claimed"
  ));
}

function operationKey(operation: NewOperation): string { return operation.type === "start" ? `${operation.callerId}:start:${operation.idempotencyKey}` : `${operation.callerId}:${operation.runId}:${operation.type}:${operation.idempotencyKey}`; }
function newOperationRecord(operation: NewOperation): OperationRecord {
  const now = new Date();
  return { id: operation.id, runId: operation.runId, callerId: operation.callerId, type: operation.type, state: "queued", idempotencyKey: operation.idempotencyKey, requestHash: operation.requestHash, input: clone(operation.input), result: null, error: null, leaseOwner: null, leaseEpoch: 0, leaseExpiresAt: null, attemptCount: 0, createdAt: now, updatedAt: now };
}
function assertSameRequest(operation: OperationRecord, requestHash: string): void { if (operation.requestHash !== requestHash) throw conflict("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different arguments."); }
function conflict(code: string, message: string): VoiceLabError { return new VoiceLabError(labError(code, message, "conflict")); }
function assertEventReplay(existing: LabEvent, kind: string, source: LabEvent["source"], payload: Record<string, unknown>): void {
  if (existing.kind !== kind || existing.source !== source || canonicalRequestHash(existing.payload) !== canonicalRequestHash(payload)) throw conflict("DEDUPE_CONFLICT", "Event dedupe key was reused with different canonical evidence.");
}
function assertArtifactDigest(artifact: DurableArtifact): void {
  if (sha256(artifact.bytes) !== artifact.sha256) throw conflict("ARTIFACT_DIGEST_MISMATCH", "Artifact bytes do not match the declared SHA-256 digest.");
}
function assertArtifactReplay(existing: DurableArtifact, candidate: DurableArtifact, requireId = true): void {
  if ((requireId && existing.id !== candidate.id) || existing.runId !== candidate.runId || existing.kind !== candidate.kind || existing.contentType !== candidate.contentType || existing.sha256 !== candidate.sha256 || !Buffer.from(existing.bytes).equals(Buffer.from(candidate.bytes))) throw conflict("ARTIFACT_ID_CONFLICT", "Artifact identity or content hash is already bound to incompatible immutable evidence.");
}
function notFound(code: string, message: string): VoiceLabError { return new VoiceLabError(labError(code, message, "validation")); }
function ownedOperation(operations: Map<string, OperationRecord>, operationId: string, workerId: string, leaseEpoch: number): OperationRecord {
  const operation = operations.get(operationId);
  if (!operation) throw notFound("OPERATION_NOT_FOUND", "Operation was not found.");
  if (operation.leaseOwner !== workerId || operation.leaseEpoch !== leaseEpoch) throw conflict("LEASE_LOST", "Operation lease is no longer owned by this worker.");
  return operation;
}

function assertAdmission(operations: OperationRecord[], operation: NewOperation, admission: OperationAdmission): void {
  const prior = operations.filter((candidate) => candidate.runId === operation.runId && (candidate.type === "speak" || candidate.type === "barge_in") && candidate.state !== "failed" && candidate.state !== "cancelled" && candidate.state !== "timed_out");
  if (prior.length >= admission.maxUtterances) throw conflict("UTTERANCE_LIMIT", "Run utterance count limit is reached.");
  const latest = prior.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (latest && Date.now() - latest.createdAt.getTime() < admission.minIntervalMs) throw conflict("UTTERANCE_RATE_LIMIT", "Run utterance minimum interval has not elapsed.");
  const reservation = operation.input._admission as Record<string, unknown> | undefined;
  const duration = prior.reduce((sum, item) => sum + Number((item.input._admission as any)?.duration_ms ?? 0), 0) + Number(reservation?.duration_ms ?? 0);
  const bytes = prior.reduce((sum, item) => sum + Number((item.input._admission as any)?.bytes ?? 0), 0) + Number(reservation?.bytes ?? 0);
  if (duration > admission.maxTotalDurationMs) throw conflict("INJECTED_DURATION_LIMIT", "Run cumulative injected duration budget would be exceeded.");
  if (bytes > admission.maxTotalBytes) throw conflict("INJECTED_BYTES_LIMIT", "Run cumulative injected byte budget would be exceeded.");
}

const ROLLING_FIELDS = ["runStarts", "providerSeconds", "suites", "suiteChildren", "audioDurationMs", "audioBytes"] as const;
function validateRollingReservation(reservation: RollingAdmissionReservation): void {
  if (!/^[a-f0-9]{64}$/.test(reservation.reservationKey) || !/^[a-f0-9]{64}$/.test(reservation.requestHash) || Number.isNaN(reservation.observedAt.getTime())) throw conflict("ROLLING_ADMISSION_INVALID", "Rolling admission identity is invalid.");
  if (ROLLING_FIELDS.some((field) => !Number.isSafeInteger(reservation[field]) || reservation[field] < 0)) throw conflict("ROLLING_ADMISSION_INVALID", "Rolling admission counters must be bounded nonnegative integers.");
}
function assertSameRollingReservation(prior: RollingAdmissionReservation, candidate: RollingAdmissionReservation, callerPartitions: ReadonlySet<string>): void {
  if (prior.requestHash !== candidate.requestHash || !callerPartitions.has(prior.callerId) || prior.environment !== candidate.environment || prior.kind !== candidate.kind || ROLLING_FIELDS.some((field) => prior[field] !== candidate[field])) {
    throw conflict("IDEMPOTENCY_CONFLICT", "Rolling admission key was reused with different arguments.");
  }
}
function rollingUsage(rows: RollingAdmissionReservation[], callerIds?: ReadonlySet<string>): Record<typeof ROLLING_FIELDS[number], number> {
  const selected = callerIds === undefined ? rows : rows.filter((row) => callerIds.has(row.callerId));
  return Object.fromEntries(ROLLING_FIELDS.map((field) => [field, selected.reduce((sum, row) => sum + row[field], 0)])) as Record<typeof ROLLING_FIELDS[number], number>;
}
function assertRollingCapacity(rows: RollingAdmissionReservation[], candidate: RollingAdmissionReservation, limits: RollingAdmissionLimits, callerPartitions: ReadonlySet<string>): void {
  const global = rollingUsage([...rows, candidate]);
  const caller = rollingUsage([...rows, candidate], callerPartitions);
  for (const field of ROLLING_FIELDS) {
    const globalCap = limits.global[field], callerCap = limits.caller[field];
    if ((globalCap !== null && global[field] > globalCap) || (callerCap !== null && caller[field] > callerCap)) throw conflict(`ROLLING_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_LIMIT`, `Rolling ${field} admission budget would be exceeded.`);
  }
}
function rollingAdmissionResult(rows: RollingAdmissionReservation[], candidate: RollingAdmissionReservation, limits: RollingAdmissionLimits, replay: boolean, callerPartitions: ReadonlySet<string>): RollingAdmissionResult {
  const cutoff = candidate.observedAt.getTime() - limits.windowSeconds * 1_000;
  const active = rows.filter((row) => row.environment === candidate.environment && row.observedAt.getTime() > cutoff);
  const global = rollingUsage(active);
  const caller = rollingUsage(active, callerPartitions);
  const remaining = (cap: RollingAdmissionLimits["global"], used: ReturnType<typeof rollingUsage>) => Object.fromEntries(ROLLING_FIELDS.map((field) => { const limit = cap[field]; return [field, limit === null ? null : Math.max(0, limit - used[field])]; })) as unknown as RollingAdmissionLimits["global"];
  const oldest = active.reduce((value, row) => Math.min(value, row.observedAt.getTime()), candidate.observedAt.getTime());
  return { replay, resetAt: new Date(oldest + limits.windowSeconds * 1_000), remaining: { global: remaining(limits.global, global), caller: remaining(limits.caller, caller) } };
}
import { retentionHmac } from "./retention-identity.js";
