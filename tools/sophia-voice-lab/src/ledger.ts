import type {
  EvidenceRecord,
  DeploymentIdentity,
  DurableArtifact,
  LabError,
  LabEvent,
  OperationRecord,
  OperationState,
  OperationType,
  RunRecord,
  RunState,
  SuiteRecord,
  SuiteEvidenceRecord,
  Verdicts,
} from "./domain.js";
import type { WorkerHeartbeatAttestation } from "./worker-heartbeat.js";

export interface NewOperation {
  id: string;
  runId: string;
  callerId: string;
  type: OperationType;
  idempotencyKey: string;
  requestHash: string;
  input: Record<string, unknown>;
}

export interface OperationAdmission {
  maxUtterances: number;
  maxTotalDurationMs: number;
  maxTotalBytes: number;
  minIntervalMs: number;
}

export interface RollingAdmissionReservation {
  reservationKey: string;
  requestHash: string;
  callerId: string;
  environment: "production" | "staging";
  kind: "run" | "suite" | "audio";
  runStarts: number;
  providerSeconds: number;
  suites: number;
  suiteChildren: number;
  audioDurationMs: number;
  audioBytes: number;
  observedAt: Date;
}

export interface RollingAdmissionLimits {
  windowSeconds: number;
  global: { runStarts: number; providerSeconds: number; suites: number; suiteChildren: number; audioDurationMs: number; audioBytes: number };
  caller: { runStarts: number; providerSeconds: number; suites: number; suiteChildren: number; audioDurationMs: number; audioBytes: number };
}

export interface RollingAdmissionResult {
  replay: boolean;
  resetAt: Date;
  remaining: { global: RollingAdmissionLimits["global"]; caller: RollingAdmissionLimits["caller"] };
}

export interface RollingAdmissionFence {
  reservation: RollingAdmissionReservation;
  limits: RollingAdmissionLimits;
}

export interface ClaimedOperation {
  operation: OperationRecord;
  run: RunRecord;
}

export interface EventPage {
  events: LabEvent[];
  after: number;
  latest: number;
}

export interface LedgerHealth {
  ok: boolean;
  detail: string;
}
export interface RetentionTombstone { purgedAt: Date; remotePurgeStatus: "confirmed" | "unconfirmed"; }

export interface RunPatch {
  state?: RunState;
  observedDeployment?: RunRecord["observedDeployment"];
  verdicts?: Verdicts;
  canonicalSessionId?: string | null;
  threadId?: string | null;
  providerSessionId?: string | null;
  traceId?: string | null;
  providerEpoch?: number | null;
  turnId?: string | null;
  terminalError?: LabError | null;
  cleanupComplete?: boolean;
  retentionPurgeDueAt?: Date | null;
  retentionPurgePending?: boolean;
  retentionPurgeVerifiedAt?: Date | null;
}

export interface BrowserLease {
  runId: string;
  workerId: string;
  leaseEpoch: number;
  expiresAt: Date;
  /** Durable acquisition/heartbeat timestamp used for D02 continuity. */
  updatedAt: Date;
}

/** Snapshot protected by the same durable run/event claim barrier. The guard
 * runs only for a new claim; an exact existing claim is replayed byte-for-byte
 * even after the governed run has subsequently become terminal. */
export interface EventClaimSnapshot {
  run: RunRecord;
  events: readonly LabEvent[];
  operations: readonly OperationRecord[];
  browserLease: BrowserLease | null;
  databaseNow: Date;
}
export type EventClaimGuard = (snapshot: EventClaimSnapshot) => void;

export interface WorkerHeartbeat {
  workerId: string;
  serviceVersion: string;
  browserReady: boolean;
  observedAt: Date;
  attestation: WorkerHeartbeatAttestation | null;
  detail: Record<string, unknown>;
}

export interface AuthAuditRecord {
  id?: number | string;
  runId: string | null;
  callerId: string;
  action: string;
  capabilityJtiHash?: string | null;
  argumentHash: string;
  outcome: "allowed" | "denied";
  detail: Record<string, unknown>;
  observedAt: Date;
}

export interface PrincipalProvisionPreparation {
  requestHash: string;
  idempotencyKeyHash: string;
  principalHash: string;
  callerId: string;
  issuedAt: Date;
  testRunId: string;
  cleanupObligationId: string;
  capabilityJti: string;
  capabilityNonce: string;
  capabilityHash: string;
  providerExpiresAt: Date;
  environment: 'production' | 'staging';
  expectedDeployment: DeploymentIdentity;
  mcpBuild: string;
  operatorSubjectHash: string;
}

export interface PrincipalProvisionControlRecord extends Omit<PrincipalProvisionPreparation, 'callerId'> {
  callerPartitionId: string;
  /** Reserved from the database auth_audit identity sequence at prepare time. */
  authAuditId: string;
  /** Database-authored timestamp which the eventual immutable audit row must use. */
  auditObservedAt: Date;
  state: 'prepared' | 'completed';
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  receipt: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PrincipalProvisionClaim = {
  disposition: 'claimed' | 'pending' | 'completed' | 'conflict';
  record: PrincipalProvisionControlRecord;
};

export interface PrincipalProvisionCapabilityRotation {
  issuedAt: Date;
  capabilityJti: string;
  capabilityNonce: string;
  capabilityHash: string;
  providerExpiresAt: Date;
}

export interface PrincipalProvisionReadiness {
  status: 'absent' | 'prepared' | 'completed' | 'invalid';
}

export interface VoiceLabLedger {
  initialize(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<LedgerHealth>;
  countActiveRuns(callerId?: string): Promise<number>;
  listExpiredRuns(now: Date, limit: number): Promise<RunRecord[]>;
  listRunsNeedingRecovery(limit: number): Promise<RunRecord[]>;
  listRunsPendingEvidence(limit: number): Promise<RunRecord[]>;
  listRunsCertificationDue(now: Date, limit: number): Promise<RunRecord[]>;
  listRunsRetentionDue(now: Date, limit: number): Promise<RunRecord[]>;
  reserveRollingAdmission(reservation: RollingAdmissionReservation, limits: RollingAdmissionLimits): Promise<RollingAdmissionResult>;
  createRunWithOperation(run: RunRecord, operation: NewOperation, limits: { global: number; caller: number }, rolling?: RollingAdmissionFence): Promise<{ run: RunRecord; operation: OperationRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }>;
  getRun(runId: string): Promise<RunRecord | null>;
  getRetentionTombstone(runId: string, callerId: string): Promise<RetentionTombstone | null>;
  updateRun(runId: string, expectedVersion: number, patch: RunPatch): Promise<RunRecord>;
  createOperation(operation: NewOperation, admission?: OperationAdmission, rolling?: RollingAdmissionFence): Promise<{ operation: OperationRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }>;
  getOperation(operationId: string): Promise<OperationRecord | null>;
  listOperations(runId: string): Promise<OperationRecord[]>;
  claimNextOperation(workerId: string, leaseSeconds: number): Promise<ClaimedOperation | null>;
  markOperationExecuting(operationId: string, workerId: string, leaseEpoch: number): Promise<OperationRecord>;
  heartbeatOperation(operationId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean>;
  finishOperation(operationId: string, workerId: string, leaseEpoch: number, state: Extract<OperationState, "succeeded" | "failed" | "timed_out" | "cancelled">, result: Record<string, unknown> | null, error: LabError | null): Promise<OperationRecord>;
  cancelPendingRunOperations(runId: string, exceptOperationId: string | null, error: LabError): Promise<OperationRecord[]>;
  claimEvent(runId: string, kind: string, source: LabEvent["source"], payload: Record<string, unknown>, dedupeKey: string, observedAt?: Date, guard?: EventClaimGuard): Promise<{ event: LabEvent; replay: boolean }>;
  appendEvent(runId: string, kind: string, source: LabEvent["source"], payload: Record<string, unknown>, dedupeKey?: string, observedAt?: Date): Promise<LabEvent>;
  listEvents(runId: string, after: number, limit: number): Promise<EventPage>;
  findLatestEvent(runId: string, kinds: string[]): Promise<LabEvent | null>;
  createSuite(suite: SuiteRecord, rolling?: RollingAdmissionFence): Promise<{ suite: SuiteRecord; replay: boolean; rollingAdmission?: RollingAdmissionResult }>;
  getSuite(suiteId: string): Promise<SuiteRecord | null>;
  listRunnableSuites(limit: number): Promise<SuiteRecord[]>;
  listSuitesPendingEvidence(limit: number): Promise<SuiteRecord[]>;
  updateSuite(suiteId: string, state: SuiteRecord["state"], runIds?: string[], nextScenarioIndex?: number): Promise<SuiteRecord>;
  saveSuiteEvidence(evidence: SuiteEvidenceRecord): Promise<SuiteEvidenceRecord>;
  getSuiteEvidence(suiteId: string): Promise<SuiteEvidenceRecord | null>;
  getSuiteEvidenceByManifestId(manifestId: string): Promise<SuiteEvidenceRecord | null>;
  saveEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord>;
  getEvidence(runId: string): Promise<EvidenceRecord | null>;
  saveArtifact(artifact: DurableArtifact): Promise<DurableArtifact>;
  getArtifact(artifactId: string): Promise<DurableArtifact | null>;
  listArtifacts(runId: string): Promise<DurableArtifact[]>;
  deleteUnpublishedArtifacts(runId: string): Promise<number>;
  upsertBrowserLease(runId: string, workerId: string, leaseSeconds: number): Promise<BrowserLease>;
  getBrowserLease(runId: string): Promise<BrowserLease | null>;
  heartbeatBrowserLease(runId: string, workerId: string, leaseEpoch: number, leaseSeconds: number): Promise<boolean>;
  releaseBrowserLease(runId: string, workerId: string, leaseEpoch: number): Promise<boolean>;
  reapExpiredBrowserLeases(now?: Date): Promise<BrowserLease[]>;
  heartbeatWorker(heartbeat: WorkerHeartbeat): Promise<void>;
  listLiveWorkers(since: Date): Promise<WorkerHeartbeat[]>;
  recordAuthAudit(record: AuthAuditRecord): Promise<void>;
  claimPrincipalProvision(preparation: PrincipalProvisionPreparation, leaseOwner: string, leaseSeconds: number, now: Date): Promise<PrincipalProvisionClaim>;
  rotatePrincipalProvisionCapability(requestHash: string, leaseOwner: string, rotation: PrincipalProvisionCapabilityRotation, now: Date): Promise<PrincipalProvisionControlRecord>;
  finalizePrincipalProvision(requestHash: string, leaseOwner: string, receipt: Record<string, unknown>, audit: AuthAuditRecord, now: Date): Promise<PrincipalProvisionControlRecord>;
  releasePrincipalProvision(requestHash: string, leaseOwner: string, now: Date): Promise<boolean>;
  getPrincipalProvisionReadiness(now: Date): Promise<PrincipalProvisionReadiness>;
  listAuthAudit(runId: string): Promise<AuthAuditRecord[]>;
  listAuthAuditByArgumentHashes(callerId: string, argumentHashes: string[], since: Date): Promise<AuthAuditRecord[]>;
  listAuthAuditForCaller(callerId: string, since: Date, until: Date): Promise<AuthAuditRecord[]>;
  purgeExpiredRetention(now: Date, limit: number): Promise<string[]>;
}
