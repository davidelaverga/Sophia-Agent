import { z } from "zod";
import type { RunRecord } from "./domain.js";
import type { ExecutionEpochCleanupProof } from "./execution-cleanup.js";
import type { ExecutionOwnership } from "./execution-ownership.js";
import type { D02RecoveryJournal } from "./d02-recovery-journal.js";
import type { RetainedOwnerDeath } from "./retained-owner-death.js";
import type { RetainedD02ProviderSettlement } from "./retained-d02-provider.js";
import type { RetainedD02Recovery } from "./retained-d02-recovery.js";
import type { AuthAuditRecord } from "./ledger.js";
import type { GenericOwnerDispatchJournal } from "./generic-owner-dispatch.js";
import type { VerifiedGenericOwnerLoss } from "./generic-owner-loss.js";
import type { RetainedGenericRecovery } from "./retained-generic-recovery.js";
import { canonicalRequestHash, sha256 } from "./security.js";

const uuid = z.string().uuid();
export const RETAINED_RECOVERY_RETRY_MS = 30_000;
/** Exact Gateway terminal vocabulary, shared by transport and durable settlement. */
export function isTerminalRecoveryComponentStatus(status: unknown): boolean {
  return status === "completed" || status === "already_terminal" || status === "not_found";
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().datetime().refine((value) => new Date(value).toISOString() === value);
const gatewayOrigin = z.string().max(512).url().refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && value === url.origin && !url.username && !url.password;
});

/** Immutable authorization inputs only. This is not a run/evidence snapshot or
 * an authorization grant. Persistent allocation and exact settlement must be
 * stored separately; neither content expiry nor this record proves live zero. */
export const RecoveryControlBindingSchema = z.object({
  schema: z.literal("sophia.voice-lab.recovery-control.v1"),
  runId: uuid,
  testRunId: uuid,
  cleanupObligationId: uuid,
  callerPartitionId: z.string().regex(/^cp1:[A-Za-z0-9_-]{1,32}:[a-f0-9]{64}$/),
  principalId: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
  environment: z.enum(["production", "staging"]),
  scenarioId: z.string().regex(/^V-[A-Z][0-9]{2}$/).nullable(),
  scenarioVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).nullable(),
  gatewayOrigin,
  expectedDeployment: z.object({ frontend: sha, backend: sha, voice: sha }).strict(),
  createdAt: timestamp,
  providerExpiresAt: timestamp,
  retentionHours: z.number().int().min(1).max(168),
}).strict().superRefine((binding, ctx) => {
  const created = Date.parse(binding.createdAt);
  const expires = Date.parse(binding.providerExpiresAt);
  if (expires < created || expires > created + binding.retentionHours * 3_600_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["providerExpiresAt"], message: "Provider deadline exceeds immutable retention ceiling" });
  }
});

export type RecoveryControlBinding = z.infer<typeof RecoveryControlBindingSchema>;

/** A keyset cursor is an identity, not an offset into a mutable backlog. */
export function recoveryInventoryCursor(afterRunId?: string): string | null {
  return afterRunId === undefined ? null : uuid.parse(afterRunId).toLowerCase();
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const browserBindingSchema = z.object({
  voice_lab_run_id_sha256: digest,
  browser_worker_id_sha256: digest,
  browser_lease_epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  browser_context_id_sha256: digest,
}).strict();
export type RecoveryBrowserBinding = z.infer<typeof browserBindingSchema>;

export function deriveRecoveryBrowserBinding(runId: string, workerId: string, leaseEpoch: number): RecoveryBrowserBinding {
  uuid.parse(runId);
  if (!workerId || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) throw new Error("Invalid recovery browser allocation");
  return deriveRecoveryAllocationFromOwnerHash(runId, sha256(workerId), leaseEpoch);
}

/** Hash-only projection of an evidenced owner, never proof of driver launch. */
export function deriveRecoveryAllocationFromOwnerHash(runId: string, workerHash: string, leaseEpoch: number): RecoveryBrowserBinding {
  uuid.parse(runId);
  digest.parse(workerHash);
  if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) throw new Error("Invalid recovery browser allocation");
  const allocationHash = recoveryBrowserAllocationHash(runId, workerHash, leaseEpoch);
  return { voice_lab_run_id_sha256: sha256(runId), browser_worker_id_sha256: workerHash, browser_lease_epoch: leaseEpoch, browser_context_id_sha256: allocationHash };
}

function recoveryBrowserAllocationHash(runId: string, workerHash: string, leaseEpoch: number): string {
  const hex = sha256(`browser-context-allocation:${workerHash}:${leaseEpoch}:${runId}`).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join("");
  return sha256(`${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`);
}

/** Validate the existing deterministic allocation recipe using hashes only.
 * Validation is not driver attestation; persistence additionally requires the
 * exact current lease and the worker's successful driver attestation path. */
export function validateRecoveryBrowserBinding(binding: Pick<RecoveryControlBinding, "runId" | "scenarioId">, input: unknown): RecoveryBrowserBinding {
  if (binding.scenarioId !== "V-D02") throw new Error("Recovery browser run binding mismatch");
  return validateRecoveryAllocationBinding(binding, input);
}

/** Reservation identity exists before any driver launch, for every scenario.
 * It is not the attested browser-context capability used by V-D02. */
export function validateRecoveryAllocationBinding(binding: Pick<RecoveryControlBinding, "runId">, input: unknown): RecoveryBrowserBinding {
  const parsed = browserBindingSchema.parse(input);
  if (parsed.voice_lab_run_id_sha256 !== sha256(binding.runId)) throw new Error("Recovery browser run binding mismatch");
  if (parsed.browser_context_id_sha256 !== recoveryBrowserAllocationHash(binding.runId, parsed.browser_worker_id_sha256, parsed.browser_lease_epoch)) throw new Error("Recovery browser allocation binding mismatch");
  return parsed;
}

export interface RecoveryControlRecord {
  binding: RecoveryControlBinding;
  /** Monotonic allocator history; lease deletion never resets this fact. */
  browserAllocationEver: boolean;
  genericOwnerDispatch?: GenericOwnerDispatchJournal;
  genericOwnerLoss?: VerifiedGenericOwnerLoss;
  genericRecoverySettlement?: RetainedGenericRecovery;
  executionOwnership?: ExecutionOwnership;
  d02Journal?: D02RecoveryJournal;
  d02OwnerDeath?: RetainedOwnerDeath;
  d02ProviderSettlement?: RetainedD02ProviderSettlement;
  d02RecoverySettlement?: RetainedD02Recovery;
  executionCleanupProof?: ExecutionEpochCleanupProof;
  /** Reserved atomically with the lease, before driver start; NOT attestation. */
  browserAllocationBinding?: RecoveryBrowserBinding;
  browserContextBinding?: RecoveryBrowserBinding;
  version: number;
  liveCleanupComplete: boolean;
  retentionPurgeDueAt: Date | null;
  remotePurgeComplete: boolean;
  contentPurgedAt: Date | null;
  retentionLookupHmac?: string;
  lastSettlement?: { fromVersion: number; eventSha256: string; receiptSha256: string };
}

/** The durable reservation remains authoritative after the ephemeral lease is
 * released or reaped. A valid event chain for a different owner cannot settle it. */
export function executionMatchesRecoveryAllocation(control: RecoveryControlRecord, execution: {
  workerIdSha256: string | null; browserLeaseEpoch: number | null; executionEpochSha256: string | null;
}): boolean {
  if (!control.browserAllocationEver || !control.browserAllocationBinding) return false;
  try {
    const allocation = validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding);
    return allocation.browser_worker_id_sha256 === execution.workerIdSha256
      && allocation.browser_lease_epoch === execution.browserLeaseEpoch
      && (!control.executionOwnership || (
        control.executionOwnership.workerIdSha256 === execution.workerIdSha256
        && control.executionOwnership.browserLeaseEpoch === execution.browserLeaseEpoch
        && control.executionOwnership.executionEpochSha256 === execution.executionEpochSha256));
  } catch { return false; }
}

export function recoveryCapabilityAudit(control: RecoveryControlRecord, jtiHash: string, argumentHash: string): AuthAuditRecord {
  digest.parse(jtiHash); digest.parse(argumentHash);
  return { runId: null, callerId: control.binding.callerPartitionId, action: "capability:session:recover", capabilityJtiHash: jtiHash, argumentHash, outcome: "allowed", observedAt: new Date(), detail: {
    schema: "sophia.voice-lab.retained-recovery-audit.v1", operation: "session:recover",
    run_id_sha256: sha256(control.binding.runId), test_run_id_sha256: sha256(control.binding.testRunId), cleanup_obligation_id_sha256: sha256(control.binding.cleanupObligationId),
    control_version: control.version, expected_deployment: control.binding.expectedDeployment,
  } };
}

/** Validate a canonical recovery response before storing only its hashes. A
 * transport success or disappearance of the raw run cannot constitute cleanup.
 * The caller must separately prove that no browser allocation remains. */
export function recoverySettlementProof(binding: RecoveryControlBinding, input: unknown) {
  const object = z.record(z.string(), z.unknown());
  const event = z.object({ kind: z.literal("cleanup.recovery"), source: z.literal("canonical"), payload: object }).passthrough().parse(input);
  if (Buffer.byteLength(JSON.stringify(event.payload)) > 65536) throw new Error("Recovery receipt exceeds size bound");
  const payload = z.object({ complete: z.literal(true), http_status: z.literal(200), receipt: object }).passthrough().parse(event.payload);
  const receipt = z.object({
    test_run_id: z.literal(binding.testRunId),
    cleanup_obligation_id_sha256: z.literal(sha256(binding.cleanupObligationId)),
    complete: z.literal(true), live_cleanup_complete: z.literal(true), live_resources_zero: z.literal(true),
    components: z.object({
      canonical_session: object, voice_provider: object, auth_sessions: object, builder: object,
    }).passthrough(),
    receipt: z.object({ storage: z.string().min(1).max(80), object_path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
  }).passthrough().parse(payload.receipt);
  for (const component of [receipt.components.canonical_session, receipt.components.voice_provider, receipt.components.auth_sessions]) {
    // Matches Gateway's terminal component vocabulary. `not_found` is accepted
    // only inside the exact-bound durable live-zero receipt checked above.
    if (!isTerminalRecoveryComponentStatus(component.status)) throw new Error("Recovery component is not authoritatively terminal");
  }
  const builder = receipt.components.builder;
  const nested = object.optional().parse(builder.receipt) ?? {};
  if (builder.status !== "completed" || (builder.cleanup_complete ?? nested.cleanup_complete) !== true
    || (builder.discovery_complete ?? nested.discovery_complete) !== true
    || (builder.authoritative_zero_tasks ?? nested.authoritative_zero_tasks) !== true
    || !Number.isSafeInteger(builder.discovered_task_count ?? nested.discovered_task_count)
    || Number(builder.discovered_task_count ?? nested.discovered_task_count) < 0) throw new Error("Builder zero-resource discovery is unproven");
  return {
    eventSha256: canonicalRequestHash(event.payload), receiptSha256: receipt.receipt.sha256,
    remotePurgeComplete: event.payload.retention_purged === true && receipt.retention_purged === true
      && receipt.retention_purge_pending === false && receipt.retention_maintenance_complete === true,
  };
}

export function projectRecoveryControlBinding(run: RunRecord, callerPartitionId: string): RecoveryControlBinding {
  const gateway = new URL(run.target.gatewayUrl);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== "/") {
    throw new Error("Recovery Gateway must be a credential-free origin");
  }
  // Enumerate every field, including nested deployment keys. Never spread a run
  // or caller-supplied object into durable control state.
  return RecoveryControlBindingSchema.parse({
    schema: "sophia.voice-lab.recovery-control.v1",
    runId: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId,
    callerPartitionId, principalId: run.principalId, environment: run.environment,
    scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion,
    gatewayOrigin: gateway.origin,
    expectedDeployment: {
      frontend: run.target.expectedDeployment.frontend,
      backend: run.target.expectedDeployment.backend,
      voice: run.target.expectedDeployment.voice,
    },
    createdAt: run.createdAt.toISOString(), providerExpiresAt: run.expiresAt.toISOString(),
    retentionHours: run.capturePolicy.retentionHours,
  });
}

export function decodeRecoveryControlBinding(serialized: string): RecoveryControlBinding {
  if (Buffer.byteLength(serialized, "utf8") > 4096) throw new Error("Recovery control binding exceeds size bound");
  return RecoveryControlBindingSchema.parse(JSON.parse(serialized));
}

/** Explicit transport projection prevents a full run from crossing the async
 * recovery boundary. It does not mint or replace the exact recovery capability. */
export function recoveryTransportBinding(binding: Pick<RecoveryControlBinding, "runId" | "testRunId" | "cleanupObligationId" | "gatewayOrigin">) {
  return { id: binding.runId, testRunId: binding.testRunId, cleanupObligationId: binding.cleanupObligationId, target: { gatewayUrl: binding.gatewayOrigin } };
}
