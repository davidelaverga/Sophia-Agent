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
import type { AuthAuditRecord, BrowserLease, ClaimedOperation, EventClaimGuard, EventPage, LedgerHealth, NewOperation, OperationAdmission, PrincipalProvisionCapabilityRotation, PrincipalProvisionClaim, PrincipalProvisionControlRecord, PrincipalProvisionPreparation, PrincipalProvisionReadiness, RetentionTombstone, RollingAdmissionFence, RollingAdmissionLimits, RollingAdmissionReservation, RollingAdmissionResult, RunPatch, VoiceLabLedger, WorkerHeartbeat } from "./ledger.js";
import { parseExactPrincipalProvisionReceipt } from './principal-provision-receipt.js';
import { canonicalRequestHash, sha256 } from "./security.js";
import { CallerPartitioner, type CallerPartitionKeyRing } from "./caller-partition.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryVoiceLabLedger implements VoiceLabLedger {
  readonly #runs = new Map<string, RunRecord>();
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

  async countActiveRuns(callerId?: string): Promise<number> {
    return [...this.#runs.values()].filter((run) => (!TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete) && (callerId === undefined || run.callerId === callerId)).length;
  }
  async listExpiredRuns(now: Date, limit: number): Promise<RunRecord[]> { return clone([...this.#runs.values()].filter((run) => !TERMINAL_RUN_STATES.has(run.state) && run.expiresAt <= now).slice(0, limit)); }
  async listRunsNeedingRecovery(limit: number): Promise<RunRecord[]> { return clone([...this.#runs.values()].filter((run) => TERMINAL_RUN_STATES.has(run.state) && !run.cleanupComplete).slice(0, limit)); }
  async listRunsPendingEvidence(limit: number): Promise<RunRecord[]> {
    return clone([...this.#runs.values()].filter((run) => {
      const operations = [...this.#operations.values()].filter((operation) => operation.runId === run.id);
      const settledEnd = operations.some((operation) => operation.type === "end" && operation.state === "succeeded");
      const nonterminalOperation = operations.some((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state));
      if (run.state === "exporting") return !nonterminalOperation;
      if (!TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete) return false;
      if (run.terminalError === null && run.state === "completed" && run.scenarioId !== "V-S01" && run.scenarioId !== "V-S02" && !settledEnd) return false;
      const evidence = this.#evidence.get(run.id);
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
    const active = [...this.#runs.values()].filter((candidate) => !TERMINAL_RUN_STATES.has(candidate.state) || !candidate.cleanupComplete);
    if (active.length >= limits.global || active.filter((candidate) => candidate.callerId === operation.callerId).length >= limits.caller) throw conflict("CONCURRENCY_LIMIT", "Voice Lab concurrency limit is reached.");
    const rollingAdmission = rolling ? this.#reserveRollingAdmission(rolling.reservation, rolling.limits) : undefined;
    // A durable rolling reservation outlives the governed run/evidence bytes.
    // If its canonical operation has already been retention-purged, it is a
    // content-free replay tombstone, never authority to allocate a new run for
    // the same natural key without charging admission again.
    if (rollingAdmission?.replay) throw conflict("IDEMPOTENCY_RETENTION_EXPIRED", "The idempotent start receipt was retention-purged and cannot be replayed or reallocated.");
    if ([...this.#runs.values()].some((candidate) => candidate.cleanupObligationId === run.cleanupObligationId)) throw conflict("CLEANUP_OBLIGATION_CONFLICT", "Cleanup obligation is already bound to a different run.");
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
    const prior = this.#browserLeases.get(runId);
    const now = new Date();
    if (prior && prior.workerId !== workerId && prior.expiresAt > now) throw conflict("BROWSER_ALREADY_LEASED", "Browser is owned by another live worker.");
    const lease = { runId, workerId, leaseEpoch: (prior?.leaseEpoch ?? 0) + 1, expiresAt: new Date(now.getTime() + leaseSeconds * 1_000), updatedAt: now };
    this.#browserLeases.set(runId, lease);
    return clone(lease);
  }
  async getBrowserLease(runId: string): Promise<BrowserLease | null> { return clone(this.#browserLeases.get(runId) ?? null); }

  async heartbeatBrowserLease(runId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean> {
    const lease = this.#browserLeases.get(runId);
    if (!lease || lease.workerId !== workerId || lease.leaseEpoch !== leaseEpoch) return false;
    const now = new Date();
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

  async reapExpiredBrowserLeases(now = new Date()): Promise<BrowserLease[]> {
    const expired = [...this.#browserLeases.values()].filter((lease) => lease.expiresAt <= now);
    for (const lease of expired) this.#browserLeases.delete(lease.runId);
    return clone(expired);
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
      this.#browserLeases.delete(run.id);
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
function retentionHmac(key: string, domain: string, value: string): string { return createHmac("sha256", key).update(`sophia-voice-lab-retention-v1\n${domain}\n${value}`).digest("hex"); }

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
function rollingUsage(rows: RollingAdmissionReservation[], callerIds?: ReadonlySet<string>): RollingAdmissionLimits["global"] {
  const selected = callerIds === undefined ? rows : rows.filter((row) => callerIds.has(row.callerId));
  return Object.fromEntries(ROLLING_FIELDS.map((field) => [field, selected.reduce((sum, row) => sum + row[field], 0)])) as unknown as RollingAdmissionLimits["global"];
}
function assertRollingCapacity(rows: RollingAdmissionReservation[], candidate: RollingAdmissionReservation, limits: RollingAdmissionLimits, callerPartitions: ReadonlySet<string>): void {
  const global = rollingUsage([...rows, candidate]);
  const caller = rollingUsage([...rows, candidate], callerPartitions);
  for (const field of ROLLING_FIELDS) {
    if (global[field] > limits.global[field] || caller[field] > limits.caller[field]) throw conflict(`ROLLING_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_LIMIT`, `Rolling ${field} admission budget would be exceeded.`);
  }
}
function rollingAdmissionResult(rows: RollingAdmissionReservation[], candidate: RollingAdmissionReservation, limits: RollingAdmissionLimits, replay: boolean, callerPartitions: ReadonlySet<string>): RollingAdmissionResult {
  const cutoff = candidate.observedAt.getTime() - limits.windowSeconds * 1_000;
  const active = rows.filter((row) => row.environment === candidate.environment && row.observedAt.getTime() > cutoff);
  const global = rollingUsage(active);
  const caller = rollingUsage(active, callerPartitions);
  const remaining = (cap: RollingAdmissionLimits["global"], used: RollingAdmissionLimits["global"]) => Object.fromEntries(ROLLING_FIELDS.map((field) => [field, Math.max(0, cap[field] - used[field])])) as unknown as RollingAdmissionLimits["global"];
  const oldest = active.reduce((value, row) => Math.min(value, row.observedAt.getTime()), candidate.observedAt.getTime());
  return { replay, resetAt: new Date(oldest + limits.windowSeconds * 1_000), remaining: { global: remaining(limits.global, global), caller: remaining(limits.caller, caller) } };
}
import { createHmac } from "node:crypto";
