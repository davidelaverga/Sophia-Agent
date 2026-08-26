import { z } from "zod";

export const CONTRACT_VERSION = "sophia.voice-lab.v1" as const;
export const SCENARIO_CATALOG_VERSION = "vt00.scenarios.v1" as const;

export const RUN_STATES = [
  "reserved",
  "validating_target",
  "browser_queued",
  "browser_leased",
  "authenticating",
  "opening_app",
  "ready",
  "active",
  "ending",
  "finalizing",
  "exporting",
  "pending_external_evidence",
  "completed",
  "product_failed",
  "invalid_test",
  "inconclusive_provider",
  "failed_harness",
  "authorization_failed",
  "deployment_mismatch",
  "aborted_driver_restart",
  "expired",
  "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = new Set<RunState>([
  "pending_external_evidence",
  "completed",
  "product_failed",
  "invalid_test",
  "inconclusive_provider",
  "failed_harness",
  "authorization_failed",
  "deployment_mismatch",
  "aborted_driver_restart",
  "expired",
  "cancelled",
]);

export const OPERATION_TYPES = [
  "start",
  "speak",
  "barge_in",
  "force_socket_rotation",
  "end",
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_STATES = [
  "accepted",
  "queued",
  "leased",
  "executing",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const VERDICTS = ["pending", "pass", "fail", "inconclusive", "unavailable"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Verdicts {
  harness: Verdict;
  product: Verdict;
  provider: Verdict;
  auth: Verdict;
  evidence: Verdict;
}

export interface DeploymentIdentity {
  frontend: string;
  backend: string;
  voice: string;
}

export interface DeploymentDependencies {
  langgraph: string;
}

export interface TargetSpec {
  frontendUrl: string;
  gatewayUrl: string;
  voiceUrl: string;
  langgraphUrl: string;
  expectedDeployment: DeploymentIdentity;
  expectedDependencies: DeploymentDependencies;
}

export interface CapturePolicy {
  rawAudio: boolean;
  screenshot: boolean;
  video: boolean;
  retentionHours: number;
}

export interface RunRecord {
  id: string;
  callerId: string;
  principalId: string;
  testRunId: string;
  /** Opaque UUIDv4 used only by authenticated cleanup/recovery planes. */
  cleanupObligationId: string;
  environment: "production" | "staging";
  scenarioId: string | null;
  scenarioVersion: string | null;
  state: RunState;
  version: number;
  target: TargetSpec;
  observedDeployment: Partial<DeploymentIdentity>;
  capturePolicy: CapturePolicy;
  verdicts: Verdicts;
  canonicalSessionId: string | null;
  threadId: string | null;
  providerSessionId: string | null;
  traceId: string | null;
  providerEpoch: number | null;
  turnId: string | null;
  latestCursor: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  cleanupComplete: boolean;
  /** Gateway-authoritative expiry for retained product and lab evidence. */
  retentionPurgeDueAt: Date | null;
  /** True while an upstream/local retention purge obligation remains. */
  retentionPurgePending: boolean;
  /** Set only after Gateway proves the exact-run product evidence purge. */
  retentionPurgeVerifiedAt: Date | null;
  evidencePurgedAt: Date | null;
  terminalError: LabError | null;
}

export interface OperationRecord {
  id: string;
  runId: string;
  callerId: string;
  type: OperationType;
  state: OperationState;
  idempotencyKey: string;
  requestHash: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: LabError | null;
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LabEvent {
  runId: string;
  seq: number;
  kind: string;
  source: "mcp" | "worker" | "browser" | "product" | "canonical" | "provider";
  at: Date;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
}

export interface SuiteRecord {
  id: string;
  callerId: string;
  idempotencyKey: string;
  requestHash: string;
  state: "accepted" | "running" | "completed" | "failed" | "cancelled";
  scenarioIds: string[];
  runIds: string[];
  definition: {
    environment: "production" | "staging";
    target: TargetSpec;
    scenarios: Array<{ id: string; version: string | null; support: "supported" | "typed_unsupported"; unavailableReason: string | null }>;
    capturePolicy: CapturePolicy;
  };
  nextScenarioIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvidenceRecord {
  runId: string;
  manifestId: string;
  manifestSha256: string;
  schemaVersion: string;
  revisionSeq: number;
  artifactRefs: EvidenceRef[];
  createdAt: Date;
}

/**
 * Immutable, content-addressed aggregate evidence for a terminal suite. Suite
 * evidence is deliberately separate from run artifacts so a suite cancelled
 * before its first child still has a durable, caller-owned terminal receipt.
 */
export interface SuiteEvidenceRecord {
  suiteId: string;
  manifestId: string;
  manifestSha256: string;
  schemaVersion: string;
  bytes: Buffer;
  artifactRefs: EvidenceRef[];
  createdAt: Date;
}

export interface DurableArtifact {
  id: string;
  runId: string;
  kind: string;
  contentType: string;
  sha256: string;
  bytes: Buffer;
  createdAt: Date;
}

export interface EvidenceRef {
  kind: string;
  resource_id: string;
  sha256: string;
  content_type?: string;
  byte_length?: number;
  expires_at?: string;
}

export interface LabWarning {
  code: string;
  message: string;
}

export interface LabError {
  code: string;
  message: string;
  retryable: boolean;
  category:
    | "authorization"
    | "validation"
    | "conflict"
    | "deployment"
    | "harness"
    | "product"
    | "provider"
    | "evidence"
    | "internal";
  details?: Record<string, unknown>;
}

export interface LabEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  test_run_id: string | null;
  run_id: string | null;
  operation_id: string | null;
  suite_run_id: string | null;
  status: "ok" | "accepted" | "running" | "completed" | "failed" | "timeout" | "unavailable";
  event_cursor: number | null;
  deployment_identity: {
    expected: Partial<DeploymentIdentity>;
    observed: Partial<DeploymentIdentity>;
  };
  session_id: string | null;
  thread_id: string | null;
  provider_session_id: string | null;
  trace_id: string | null;
  provider_connection_epoch: number | null;
  turn_id: string | null;
  evidence_references: EvidenceRef[];
  retryability: "retryable" | "not_retryable" | "unknown";
  error_class: string | null;
  observed_at: string;
  // The nested fields retain the richer join and cursor context while the
  // literal top-level fields above remain stable for independent clients.
  cursor: { after: number | null; latest: number | null };
  deployment: {
    expected: Partial<DeploymentIdentity>;
    observed: Partial<DeploymentIdentity>;
  };
  joins: {
    test_run_id: string | null;
    canonical_session_id: string | null;
    thread_id: string | null;
    provider_session_id: string | null;
    trace_id: string | null;
    provider_connection_epoch: number | null;
    turn_id: string | null;
    availability: {
      canonical_session: "available" | "not_yet_observed" | "owning_contract_unavailable";
      thread: "available" | "not_yet_observed" | "owning_contract_unavailable";
      provider_session: "available" | "not_yet_observed" | "owning_contract_unavailable";
      trace: "available" | "trace_unavailable";
      provider_epoch: "available" | "not_yet_observed" | "owning_contract_unavailable";
      turn: "available" | "not_yet_observed" | "owning_contract_unavailable";
    };
  };
  verdicts: Verdicts | null;
  warnings: LabWarning[];
  error: LabError | null;
  data: T;
}

export class VoiceLabError extends Error {
  readonly detail: LabError;

  constructor(detail: LabError) {
    super(detail.message);
    this.name = "VoiceLabError";
    this.detail = detail;
  }
}

export const Sha40Schema = z.string().regex(/^[a-f0-9]{40}$/i, "expected an exact 40-character commit SHA");
export const DeploymentSchema = z.object({
  frontend: Sha40Schema,
  backend: Sha40Schema,
  voice: Sha40Schema,
}).strict();

export const DeploymentDependenciesSchema = z.object({
  langgraph: Sha40Schema,
}).strict();

export const TargetSchema = z.object({
  frontend_url: z.string().url().max(512),
  gateway_url: z.string().url().max(512),
  voice_url: z.string().url().max(512),
  langgraph_url: z.string().url().max(512),
  expected_deployment: DeploymentSchema,
  expected_dependencies: DeploymentDependenciesSchema,
}).strict();

export const IdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const RunIdSchema = z.string().uuid();
export const SuiteIdSchema = z.string().uuid();

export const CapturePolicySchema = z.object({
  raw_audio: z.boolean().default(false),
  screenshot: z.boolean().default(true),
  video: z.boolean().default(false),
  retention_hours: z.number().int().min(1).max(168).default(24),
}).strict();

export function initialVerdicts(): Verdicts {
  return { harness: "pending", product: "pending", provider: "pending", auth: "pending", evidence: "pending" };
}

export function labError(
  code: string,
  message: string,
  category: LabError["category"],
  retryable = false,
  details?: Record<string, unknown>,
): LabError {
  return {
    code,
    message,
    category,
    retryable,
    ...(details === undefined ? {} : { details: postgresJsonSafe(details) }),
  };
}

/** PostgreSQL jsonb rejects U+0000 even when it is validly JSON-escaped. */
function postgresJsonSafe<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/g, "\uFFFD") as T;
  if (Array.isArray(value)) return value.map((item) => postgresJsonSafe(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, postgresJsonSafe(item)]),
    ) as T;
  }
  return value;
}
