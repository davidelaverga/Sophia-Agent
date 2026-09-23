import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonicalRequestHash, sha256 } from "./security.js";
import { validateRecoveryAllocationBinding, type RecoveryControlRecord } from "./recovery-control.js";
import { genericOwnerLossDispatchFromControl } from "./generic-owner-dispatch.js";
import { parseExecutionOwnership, type ExecutionOwnership } from "./execution-ownership.js";
import { renderInventoryInstanceId } from "./worker-identity.js";
import type { WorkerReceiptAuthority } from "./d02-worker-receipt.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const time = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const authorityId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const deployment = z.object({ frontend: sha, backend: sha, voice: sha }).strict();
const snapshot = z.object({
  serviceResponseSha256: hash, deployResponseSha256: hash, instanceResponseSha256: hash,
  instanceIdsSha256: z.array(hash).length(1), deployIdSha256: hash,
  deployStatus: z.literal("live"), instanceCreatedAt: time, observedAt: time,
  readinessResponseSha256: hash,
}).strict();

const seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Fields common to both fence generations. v1 and v2 differ only in the
 * original-owner presence precondition and v2's execution-ownership binding. */
const receiptBaseShape = {
  receiptId: z.string().uuid(), authority: z.literal("deployment_control"),
  issuer: authorityId, subject: authorityId, authorityKeyId: authorityId,
  audience: z.literal("sophia-voice-lab-service-owner-fence"),
  controlBindingSha256: hash, allocationBindingSha256: hash,
  workerServiceIdSha256: hash,
  // Exact source identity permits the verifier to establish service ownership
  // without trusting a caller-supplied service association. Never export it in
  // the compact retained proof or public evidence.
  allocatedWorkerId: z.string().regex(/^srv-[0-9a-z]{20}-[A-Za-z0-9_-]{5,96}$/),
  workerIdSha256: hash, browserLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedLabSha: sha, expectedLangGraphSha: sha, expectedRecoveryDeployment: deployment,
  dispatchClaimSha256: hash, actionRequestSha256: hash,
  actionAcceptedResponseSha256: hash, actionHttpStatus: z.literal(200),
  actionRequestedAt: time, actionAcceptedAt: time,
  before: snapshot, after: snapshot,
  providerCleanupProven: z.literal(false), liveResourcesZeroProven: z.literal(false),
  issuedAt: time, expiresAt: time,
  signatureAlgorithm: z.literal("ed25519-sha256-canonical-request-v1"),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).refine(value => Buffer.from(value, "base64url").toString("base64url") === value),
} as const;

type FenceTimes = { before: { observedAt: string; instanceCreatedAt: string }; after: { observedAt: string; instanceCreatedAt: string };
  actionRequestedAt: string; actionAcceptedAt: string; issuedAt: string; expiresAt: string };

/** v1 is collected and admitted by one unchanged generation. v2 is collected
 * against the deployed generation and can only be admitted after the receiver
 * that parses it is built and deployed, while the consumed one-shot dispatch
 * can never be collected again; its bounded window must cover that rebuild. */
export const SERVICE_FENCE_V1_VALIDITY_MS = 900_000;
export const SERVICE_FENCE_V2_VALIDITY_MS = 7_200_000;

/** Identical causal window for both generations; presence and the admission
 * validity bound differ. */
function refineFenceTimes(r: FenceTimes, ctx: z.RefinementCtx, maxValidityMs: number): void {
  const ordered = [r.before.observedAt, r.actionRequestedAt, r.actionAcceptedAt, r.after.observedAt, r.issuedAt, r.expiresAt].map(Date.parse);
  if (ordered.some((at, i) => i > 0 && at < ordered[i - 1]!)
    || Date.parse(r.actionRequestedAt) - Date.parse(r.before.observedAt) > 15_000
    || Date.parse(r.after.observedAt) - Date.parse(r.actionAcceptedAt) < 360_000
    || Date.parse(r.issuedAt) - Date.parse(r.after.observedAt) > 15_000
    || Date.parse(r.expiresAt) <= Date.parse(r.issuedAt)
    || Date.parse(r.expiresAt) - Date.parse(r.issuedAt) > maxValidityMs) {
    ctx.addIssue({ code: "custom", message: "Service fence causal time bounds invalid." });
  }
  if (Date.parse(r.before.instanceCreatedAt) > Date.parse(r.before.observedAt)
    || Date.parse(r.after.instanceCreatedAt) < Date.parse(r.actionRequestedAt)
    || Date.parse(r.after.instanceCreatedAt) > Date.parse(r.after.observedAt)) {
    ctx.addIssue({ code: "custom", message: "Service fence lacks a distinct post-action singleton replacement." });
  }
}

/** A different source claim from v1's exact original-owner restart. The source
 * must perform and record a whole-service restart after finding the allocated
 * owner already absent. No caller-authored inventory or elapsed timer alone
 * is authority. Admission uses the separate authenticated service-fence action. */
export const ServiceOwnerFenceReceiptSchema = z.object({
  schema: z.literal("sophia.voice-lab.service-owner-fence-receipt.v1"),
  ...receiptBaseShape,
}).strict().superRefine((r, ctx) => {
  refineFenceTimes(r, ctx, SERVICE_FENCE_V1_VALIDITY_MS);
  if (r.before.instanceIdsSha256[0] === r.workerIdSha256
    || r.after.instanceIdsSha256[0] === r.workerIdSha256
    // A Render restart replaces instances within the same deployment. The
    // deployment ID is provenance, not a process identity; require distinct
    // instance ownership and post-action creation instead.
    || r.before.instanceIdsSha256[0] === r.after.instanceIdsSha256[0]) {
    ctx.addIssue({ code: "custom", message: "Service fence lacks a distinct post-action singleton replacement." });
  }
});
export type ServiceOwnerFenceReceiptV1 = z.infer<typeof ServiceOwnerFenceReceiptSchema>;

/** v2 covers the case v1 cannot: the ORIGINAL allocated pod is still present
 * immediately before the prospective one-shot action, so its absence afterwards
 * is what the whole-service replacement establishes. Node restarting inside the
 * surviving pod is not that proof, so v2 additionally binds the exact execution
 * ownership (process, browser boot, epoch and acquisition ordinals) that the
 * replaced pod owned. It never attests a restart that already happened: the
 * dispatch claim, action request and post-action observations are all required
 * to follow the recorded ownership. */
export const ServiceOwnerFenceReceiptV2Schema = z.object({
  schema: z.literal("sophia.voice-lab.service-owner-fence-receipt.v2"),
  ...receiptBaseShape,
  executionOwnershipProofSha256: hash, executionEpochSha256: hash,
  processIdSha256: hash, browserBootIdSha256: hash,
  processAcquiredSeq: seq, runtimeAcquiredSeq: seq,
}).strict().superRefine((r, ctx) => {
  refineFenceTimes(r, ctx, SERVICE_FENCE_V2_VALIDITY_MS);
  if (r.runtimeAcquiredSeq <= r.processAcquiredSeq) {
    ctx.addIssue({ code: "custom", message: "Service fence execution acquisition order invalid." });
  }
  // Render's instance inventory omits the replica-set segment that the full
  // ownership identity carries, so the two hashes are NOT interchangeable.
  // Compare the inventory snapshots against the supported projection of the
  // original owner, never against the full identity hash.
  const inventoryId = renderInventoryInstanceId(r.allocatedWorkerId);
  if (inventoryId === null) {
    ctx.addIssue({ code: "custom", message: "Service fence v2 original owner has no supported Render inventory projection." });
    return;
  }
  const originalInventorySha256 = sha256(inventoryId);
  // The original owner must be OBSERVED PRESENT before the action and ABSENT
  // after it. This is the exact inversion of v1, and it establishes only that
  // the platform replaced the pod that owned this epoch.
  if (r.before.instanceIdsSha256[0] !== originalInventorySha256
    || r.after.instanceIdsSha256[0] === originalInventorySha256
    || r.before.instanceIdsSha256[0] === r.after.instanceIdsSha256[0]) {
    ctx.addIssue({ code: "custom", message: "Service fence v2 requires the original owner present before and replaced after." });
  }
});
export type ServiceOwnerFenceReceiptV2 = z.infer<typeof ServiceOwnerFenceReceiptV2Schema>;

/** The execution-ownership fields a v2 claim carries. */
type ExecutionOwnershipClaim = Pick<ServiceOwnerFenceReceiptV2,
  "executionOwnershipProofSha256" | "executionEpochSha256" | "processIdSha256" | "browserBootIdSha256"
  | "workerIdSha256" | "browserLeaseEpoch" | "processAcquiredSeq" | "runtimeAcquiredSeq">;

/** True only when a v2 claim names exactly the execution the control owns: one
 * epoch of this run's cleanup obligation, held by one worker lease. Admission,
 * the retained proof and the canonical termination all use this single join,
 * so the three checkpoints cannot drift apart. */
export function bindsExecutionOwnership(ownership: ExecutionOwnership, claim: ExecutionOwnershipClaim, control: RecoveryControlRecord): boolean {
  return ownership.proofSha256 === claim.executionOwnershipProofSha256
    && ownership.executionEpochSha256 === claim.executionEpochSha256
    && ownership.processIdSha256 === claim.processIdSha256
    && ownership.browserBootIdSha256 === claim.browserBootIdSha256
    && ownership.workerIdSha256 === claim.workerIdSha256
    && ownership.browserLeaseEpoch === claim.browserLeaseEpoch
    && ownership.processAcquiredSeq === claim.processAcquiredSeq
    && ownership.runtimeAcquiredSeq === claim.runtimeAcquiredSeq
    && ownership.runIdSha256 === sha256(control.binding.runId)
    && ownership.cleanupObligationIdSha256 === sha256(control.binding.cleanupObligationId);
}

export const AnyServiceOwnerFenceReceiptSchema = z.union([ServiceOwnerFenceReceiptSchema, ServiceOwnerFenceReceiptV2Schema]);
export type ServiceOwnerFenceReceipt = ServiceOwnerFenceReceiptV1 | ServiceOwnerFenceReceiptV2;

/** A verifier repair may be deployed after collection. Permit exactly one
 * deployment-configured immutable receipt to retain its observed Lab version.
 * This selects a pin only: signature, expiry, consumed dispatch, allocation,
 * product pins and independent canonical settlement are still verified. */
export function serviceFenceSourceLabSha(receipt: unknown, currentLabSha: string, approvedReceiptSha256?: string | null): string {
  sha.parse(currentLabSha);
  if (!approvedReceiptSha256) return currentLabSha;
  hash.parse(approvedReceiptSha256);
  if (canonicalRequestHash(receipt) !== approvedReceiptSha256) return currentLabSha;
  return AnyServiceOwnerFenceReceiptSchema.parse(receipt).expectedLabSha;
}

const retainedCommonShape = {
  controlBindingSha256: hash, allocationBindingSha256: hash, workerIdSha256: hash,
  browserLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workerServiceIdSha256: hash, dispatchClaimSha256: hash, signedReceiptSha256: hash, authorityPublicKeySha256: hash,
  expectedLabSha: sha, expectedLangGraphSha: sha, recoveryDeploymentSha256: hash, acceptedAt: time,
  providerCleanupProven: z.literal(false), liveResourcesZeroProven: z.literal(false), proofSha256: hash,
} as const;

const retainedSchemaV1 = z.object({
  schema: z.literal("sophia.voice-lab.verified-service-owner-fence.v1"),
  ...retainedCommonShape,
}).strict();

/** v2 retains the exact execution ownership the replaced pod held, so a later
 * cleanup evaluation can join this proof to one execution epoch and nothing
 * else. workerIdSha256 IS the original owner; the replacement pod's identity is
 * deliberately not retained here and must never be relabelled as the original. */
const retainedSchemaV2 = z.object({
  schema: z.literal("sophia.voice-lab.verified-service-owner-fence.v2"),
  ...retainedCommonShape,
  executionOwnershipProofSha256: hash, executionEpochSha256: hash,
  processIdSha256: hash, browserBootIdSha256: hash,
  processAcquiredSeq: seq, runtimeAcquiredSeq: seq,
}).strict();

const retainedSchema = z.union([retainedSchemaV1, retainedSchemaV2]);
export type VerifiedServiceOwnerFence = z.infer<typeof retainedSchema>;
export type VerifiedServiceOwnerFenceV2 = z.infer<typeof retainedSchemaV2>;

export function isVerifiedServiceOwnerFenceV2(value: VerifiedServiceOwnerFence): value is VerifiedServiceOwnerFenceV2 {
  return value.schema === "sophia.voice-lab.verified-service-owner-fence.v2";
}

/** Integrity and exact durable binding of an already accepted source proof.
 * Initial admission must independently verify the signed receipt below. */
export function parseVerifiedServiceOwnerFence(raw: unknown, control?: RecoveryControlRecord): VerifiedServiceOwnerFence {
  const value = retainedSchema.parse(raw);
  const { proofSha256, ...core } = value;
  if (canonicalRequestHash(core) !== proofSha256) throw new Error("SERVICE_FENCE_PROOF_INVALID");
  if (control) {
    const allocation = validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding);
    const dispatch = genericOwnerLossDispatchFromControl(control);
    if (control.binding.scenarioId === "V-D02" || !control.browserAllocationEver
      || value.controlBindingSha256 !== canonicalRequestHash(control.binding)
      || value.allocationBindingSha256 !== canonicalRequestHash(allocation)
      || value.workerIdSha256 !== allocation.browser_worker_id_sha256 || value.browserLeaseEpoch !== allocation.browser_lease_epoch
      || value.dispatchClaimSha256 !== dispatch.dispatchClaimSha256 || value.workerServiceIdSha256 !== dispatch.workerServiceIdSha256) throw new Error("SERVICE_FENCE_PROOF_BINDING_INVALID");
    if (isVerifiedServiceOwnerFenceV2(value)) {
      // The retained execution ownership must be the control's own, re-derived
      // and re-digested, never a caller-supplied projection.
      if (!control.executionOwnership) throw new Error("SERVICE_FENCE_PROOF_OWNERSHIP_MISSING");
      const ownership = parseExecutionOwnership(control.executionOwnership);
      if (!bindsExecutionOwnership(ownership, value, control)) throw new Error("SERVICE_FENCE_PROOF_OWNERSHIP_INVALID");
    }
  }
  return value;
}

export function verifyServiceOwnerFence(input: {
  control: RecoveryControlRecord; receipt: unknown; authority: WorkerReceiptAuthority;
  expectedWorkerServiceIdSha256: string; expectedLabSha: string; expectedLangGraphSha: string;
  expectedRecoveryDeployment: z.infer<typeof deployment>; acceptedAt: Date;
}) {
  if (Buffer.byteLength(JSON.stringify(input.receipt) ?? "") > 16384) throw new Error("SERVICE_FENCE_SIZE_INVALID");
  const r = AnyServiceOwnerFenceReceiptSchema.parse(input.receipt);
  const v2 = r.schema === "sophia.voice-lab.service-owner-fence-receipt.v2" ? r : null;
  const { signature, ...unsigned } = r;
  const key = createPublicKey({ key: Buffer.from(input.authority.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || r.issuer !== input.authority.issuer
    || r.subject !== input.authority.subject || r.authorityKeyId !== input.authority.key_id
    || !verify(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key, Buffer.from(signature, "base64url"))) throw new Error("SERVICE_FENCE_SIGNATURE_INVALID");
  const c = input.control;
  // Historical signature verification remains valid after settlement. The
  // atomic ingester separately forbids a first admission into settled control.
  if (c.binding.scenarioId === "V-D02" || !c.browserAllocationEver) throw new Error("SERVICE_FENCE_SCOPE_INVALID");
  const allocation = validateRecoveryAllocationBinding(c.binding, c.browserAllocationBinding);
  const dispatch = genericOwnerLossDispatchFromControl(c);
  if (r.receiptId !== c.genericOwnerDispatch!.requestId
    || r.allocationBindingSha256 !== canonicalRequestHash(allocation)
    || r.workerIdSha256 !== allocation.browser_worker_id_sha256
    || sha256(r.allocatedWorkerId) !== r.workerIdSha256
    || sha256(r.allocatedWorkerId.slice(0, 24)) !== r.workerServiceIdSha256
    || r.workerServiceIdSha256 !== hash.parse(input.expectedWorkerServiceIdSha256)
    || r.browserLeaseEpoch !== allocation.browser_lease_epoch) throw new Error("SERVICE_FENCE_ALLOCATION_INVALID");
  for (const field of ["controlBindingSha256", "allocationBindingSha256", "workerServiceIdSha256", "dispatchClaimSha256", "actionRequestSha256", "actionRequestedAt"] as const) {
    if (r[field] !== dispatch[field]) throw new Error("SERVICE_FENCE_DISPATCH_INVALID");
  }
  if (r.expectedLabSha !== input.expectedLabSha || r.expectedLangGraphSha !== input.expectedLangGraphSha
    || canonicalRequestHash(r.expectedRecoveryDeployment) !== canonicalRequestHash(deployment.parse(input.expectedRecoveryDeployment))) throw new Error("SERVICE_FENCE_RELEASE_INVALID");
  const accepted = input.acceptedAt.getTime();
  if (!Number.isFinite(accepted) || Date.parse(r.issuedAt) > accepted || Date.parse(r.expiresAt) <= accepted
    || Date.parse(r.actionRequestedAt) < Date.parse(c.binding.createdAt)) throw new Error("SERVICE_FENCE_TIME_INVALID");
  let ownership: ExecutionOwnership | null = null;
  if (v2) {
    // v2 admission requires the server's own retained execution ownership. A
    // receipt that names an epoch the control does not own is never admitted,
    // and a control without ownership cannot be settled by this path at all.
    if (!c.executionOwnership) throw new Error("SERVICE_FENCE_OWNERSHIP_MISSING");
    ownership = parseExecutionOwnership(c.executionOwnership);
    if (!bindsExecutionOwnership(ownership, v2, c)) throw new Error("SERVICE_FENCE_OWNERSHIP_INVALID");
  }
  const core = {
    schema: (v2 ? "sophia.voice-lab.verified-service-owner-fence.v2" : "sophia.voice-lab.verified-service-owner-fence.v1") as
      "sophia.voice-lab.verified-service-owner-fence.v1" | "sophia.voice-lab.verified-service-owner-fence.v2",
    controlBindingSha256: r.controlBindingSha256, allocationBindingSha256: r.allocationBindingSha256,
    workerIdSha256: r.workerIdSha256, browserLeaseEpoch: r.browserLeaseEpoch,
    workerServiceIdSha256: r.workerServiceIdSha256, dispatchClaimSha256: r.dispatchClaimSha256,
    signedReceiptSha256: canonicalRequestHash(r), authorityPublicKeySha256: sha256(Buffer.from(input.authority.public_key_spki_base64, "base64")),
    expectedLabSha: r.expectedLabSha, expectedLangGraphSha: r.expectedLangGraphSha,
    recoveryDeploymentSha256: canonicalRequestHash(r.expectedRecoveryDeployment), acceptedAt: input.acceptedAt.toISOString(),
    providerCleanupProven: false as const, liveResourcesZeroProven: false as const,
    ...(v2 && ownership ? {
      executionOwnershipProofSha256: ownership.proofSha256, executionEpochSha256: ownership.executionEpochSha256,
      processIdSha256: ownership.processIdSha256, browserBootIdSha256: ownership.browserBootIdSha256,
      processAcquiredSeq: ownership.processAcquiredSeq, runtimeAcquiredSeq: ownership.runtimeAcquiredSeq,
    } : {}),
  };
  return parseVerifiedServiceOwnerFence({ ...core, proofSha256: canonicalRequestHash(core) }, c);
}
