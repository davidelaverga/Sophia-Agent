import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonicalRequestHash, sha256 } from "./security.js";
import { RecoveryControlBindingSchema, validateRecoveryAllocationBinding, type RecoveryControlRecord } from "./recovery-control.js";
import type { WorkerReceiptAuthority } from "./d02-worker-receipt.js";
import { genericOwnerLossDispatchFromControl } from "./generic-owner-dispatch.js";
import { parseVerifiedServiceOwnerFence, verifyServiceOwnerFence, type VerifiedServiceOwnerFence } from "./service-owner-fence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const authorityId = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const snapshot = z.object({
  serviceResponseSha256: hash, deployResponseSha256: hash, instanceResponseSha256: hash,
  instanceIdsSha256: z.array(hash).length(1),
  deployIdSha256: hash, deployStatus: z.literal("live"),
  instanceCreatedAt: time, observedAt: time,
}).strict();

/** Independent platform-source contract. No provider, auth or browser-context
 * cleanup assertion is accepted here. A source controller and atomic durable
 * dispatch ingestion must supply the verified claim before this can settle
 * anything; this parser is not an HTTP endpoint or permission to restart. */
export const GenericOwnerLossReceiptSchema = z.object({
  schema: z.literal("sophia.voice-lab.generic-owner-loss-receipt.v1"),
  receiptId: z.string().uuid(),
  authority: z.literal("deployment_control"),
  issuer: authorityId, subject: authorityId, authorityKeyId: authorityId,
  audience: z.literal("sophia-voice-lab-generic-owner-loss"),
  controlBindingSha256: hash, allocationBindingSha256: hash,
  expectedLabSha: z.string().regex(/^[a-f0-9]{40}$/), expectedLangGraphSha: z.string().regex(/^[a-f0-9]{40}$/),
  workerServiceIdSha256: hash, workerIdSha256: hash,
  browserLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  dispatchClaimSha256: hash, actionRequestSha256: hash,
  actionAcceptedResponseSha256: hash, actionHttpStatus: z.literal(200),
  actionRequestedAt: time, actionAcceptedAt: time,
  before: snapshot, after: snapshot,
  providerCleanupProven: z.literal(false), liveResourcesZeroProven: z.literal(false),
  issuedAt: time, expiresAt: time,
  signatureAlgorithm: z.literal("ed25519-sha256-canonical-request-v1"),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).refine(value => Buffer.from(value, "base64url").toString("base64url") === value),
}).strict().superRefine((value, ctx) => {
  const ordered = [value.before.observedAt, value.actionRequestedAt, value.actionAcceptedAt, value.after.observedAt, value.issuedAt, value.expiresAt].map(Date.parse);
  if (ordered.some((at, i) => i > 0 && at < ordered[i - 1]!)
    || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 900_000
    || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) ctx.addIssue({ code: "custom", message: "Owner-loss receipt time bounds are invalid." });
  if (value.before.instanceIdsSha256[0] !== value.workerIdSha256
    || value.after.instanceIdsSha256[0] === value.workerIdSha256
    || Date.parse(value.before.instanceCreatedAt) > Date.parse(value.before.observedAt)
    || Date.parse(value.after.instanceCreatedAt) < Date.parse(value.actionRequestedAt)
    || Date.parse(value.after.instanceCreatedAt) > Date.parse(value.after.observedAt)) ctx.addIssue({ code: "custom", message: "Owner-loss receipt does not prove exact singleton replacement." });
});
export type GenericOwnerLossReceipt = z.infer<typeof GenericOwnerLossReceiptSchema>;

const verifiedSchema = z.object({
  schema: z.literal("sophia.voice-lab.verified-generic-owner-loss.v1"),
  controlBindingSha256: hash, allocationBindingSha256: hash, workerIdSha256: hash,
  browserLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  signedReceiptSha256: hash, dispatchClaimSha256: hash, authorityPublicKeySha256: hash,
  expectedLabSha: z.string().regex(/^[a-f0-9]{40}$/), expectedLangGraphSha: z.string().regex(/^[a-f0-9]{40}$/),
  workerServiceIdSha256: hash, acceptedAt: time,
  providerCleanupProven: z.literal(false), liveResourcesZeroProven: z.literal(false), proofSha256: hash,
}).strict();
export type VerifiedGenericOwnerLoss = z.infer<typeof verifiedSchema> | VerifiedServiceOwnerFence;

export function parseVerifiedGenericOwnerLoss(raw: unknown, control?: RecoveryControlRecord): VerifiedGenericOwnerLoss {
  if (raw && typeof raw === "object" && "schema" in raw
    && (raw.schema === "sophia.voice-lab.verified-service-owner-fence.v1"
      || raw.schema === "sophia.voice-lab.verified-service-owner-fence.v2")) return parseVerifiedServiceOwnerFence(raw, control);
  const value = verifiedSchema.parse(raw);
  const { proofSha256, ...core } = value;
  if (canonicalRequestHash(core) !== proofSha256) throw new Error("GENERIC_OWNER_PROOF_INVALID");
  if (control) {
    const dispatch = genericOwnerLossDispatchFromControl(control);
    const allocation = validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding);
    if (control.binding.scenarioId === "V-D02" || !control.browserAllocationEver
      || value.controlBindingSha256 !== canonicalRequestHash(control.binding)
      || value.allocationBindingSha256 !== canonicalRequestHash(allocation)
      || value.dispatchClaimSha256 !== dispatch.dispatchClaimSha256
      || value.workerServiceIdSha256 !== dispatch.workerServiceIdSha256
      || value.workerIdSha256 !== allocation.browser_worker_id_sha256
      || value.browserLeaseEpoch !== allocation.browser_lease_epoch) throw new Error("GENERIC_OWNER_PROOF_BINDING_INVALID");
  }
  return value;
}

export type GenericOwnerLossIngestion = Omit<Parameters<typeof verifyGenericOwnerLoss>[0], "control" | "acceptedAt"> & {
  runId: string; expectedVersion: number;
};

/** Called inside the ledger's row lock / synchronous critical section. Replay
 * re-verifies the original signed bytes at their immutable acceptance time. */
export function ingestGenericOwnerLoss(control: RecoveryControlRecord, input: GenericOwnerLossIngestion, now: Date) {
  z.string().uuid().parse(input.runId);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(input.expectedVersion);
  if (control.binding.runId !== input.runId) throw new Error("GENERIC_OWNER_CONTROL_MISMATCH");
  const previous = control.genericOwnerLoss ? parseVerifiedGenericOwnerLoss(control.genericOwnerLoss, control) : undefined;
  if (!previous && control.liveCleanupComplete) throw new Error("GENERIC_OWNER_ALREADY_SETTLED");
  if (previous && previous.signedReceiptSha256 !== canonicalRequestHash(input.receipt)) throw new Error("GENERIC_OWNER_RECEIPT_IMMUTABLE");
  const proof = parseVerifiedGenericOwnerLoss(verifyGenericOwnerLoss({ ...input, control,
    acceptedAt: previous ? new Date(previous.acceptedAt) : now }), control);
  if (previous) {
    if (canonicalRequestHash(previous) !== canonicalRequestHash(proof)) throw new Error("GENERIC_OWNER_RECEIPT_IMMUTABLE");
    return { replay: true, version: control.version, proof };
  }
  if (control.version !== input.expectedVersion) throw new Error("GENERIC_OWNER_VERSION_CONFLICT");
  return { replay: false, version: control.version + 1, proof };
}

export function verifyGenericOwnerLoss(input: {
  control: RecoveryControlRecord; receipt: unknown;
  authority: WorkerReceiptAuthority; expectedWorkerServiceIdSha256: string; acceptedAt: Date;
  expectedLabSha: string; expectedLangGraphSha: string;
  expectedRecoveryDeployment?: { frontend: string; backend: string; voice: string };
}) {
  if (input.receipt && typeof input.receipt === "object" && "schema" in input.receipt
    && (input.receipt.schema === "sophia.voice-lab.service-owner-fence-receipt.v1"
      || input.receipt.schema === "sophia.voice-lab.service-owner-fence-receipt.v2")) {
    if (!input.expectedRecoveryDeployment) throw new Error("SERVICE_FENCE_RECOVERY_RELEASE_REQUIRED");
    return verifyServiceOwnerFence({ ...input, expectedRecoveryDeployment: input.expectedRecoveryDeployment });
  }
  if (Buffer.byteLength(JSON.stringify(input.receipt) ?? "") > 16384) throw new Error("GENERIC_OWNER_RECEIPT_SIZE_INVALID");
  const receipt = GenericOwnerLossReceiptSchema.parse(input.receipt);
  if (receipt.expectedLabSha !== input.expectedLabSha || receipt.expectedLangGraphSha !== input.expectedLangGraphSha) throw new Error("GENERIC_OWNER_RELEASE_MISMATCH");
  const { signature, ...unsigned } = receipt;
  const key = createPublicKey({ key: Buffer.from(input.authority.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || receipt.issuer !== input.authority.issuer
    || receipt.subject !== input.authority.subject || receipt.authorityKeyId !== input.authority.key_id
    || !verify(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key, Buffer.from(signature, "base64url"))) throw new Error("GENERIC_OWNER_SIGNATURE_INVALID");
  const binding = RecoveryControlBindingSchema.parse(input.control.binding);
  if (binding.scenarioId === "V-D02" || !input.control.browserAllocationEver) throw new Error("GENERIC_OWNER_AUTHORITY_INVALID");
  const allocation = validateRecoveryAllocationBinding(binding, input.control.browserAllocationBinding);
  const controlHash = canonicalRequestHash(binding);
  const allocationHash = canonicalRequestHash(allocation);
  const dispatch = genericOwnerLossDispatchFromControl(input.control);
  if (receipt.receiptId !== input.control.genericOwnerDispatch!.requestId) throw new Error("GENERIC_OWNER_REQUEST_MISMATCH");
  if (receipt.controlBindingSha256 !== controlHash || receipt.allocationBindingSha256 !== allocationHash
    || receipt.workerIdSha256 !== allocation.browser_worker_id_sha256
    || receipt.browserLeaseEpoch !== allocation.browser_lease_epoch
    || receipt.workerServiceIdSha256 !== hash.parse(input.expectedWorkerServiceIdSha256)) throw new Error("GENERIC_OWNER_BINDING_MISMATCH");
  for (const field of ["controlBindingSha256", "allocationBindingSha256", "workerServiceIdSha256", "dispatchClaimSha256", "actionRequestSha256", "actionRequestedAt"] as const) {
    if (receipt[field] !== dispatch[field]) throw new Error("GENERIC_OWNER_DISPATCH_MISMATCH");
  }
  const acceptedAt = input.acceptedAt.getTime();
  if (!Number.isFinite(acceptedAt) || Date.parse(receipt.issuedAt) > acceptedAt || Date.parse(receipt.expiresAt) <= acceptedAt
    || Date.parse(receipt.actionRequestedAt) < Date.parse(binding.createdAt)) throw new Error("GENERIC_OWNER_RECEIPT_TIME_INVALID");
  const proof = {
    schema: "sophia.voice-lab.verified-generic-owner-loss.v1" as const,
    controlBindingSha256: controlHash, allocationBindingSha256: allocationHash,
    workerIdSha256: receipt.workerIdSha256, browserLeaseEpoch: receipt.browserLeaseEpoch,
    signedReceiptSha256: canonicalRequestHash(receipt), dispatchClaimSha256: receipt.dispatchClaimSha256,
    authorityPublicKeySha256: sha256(Buffer.from(input.authority.public_key_spki_base64, "base64")),
    expectedLabSha: receipt.expectedLabSha, expectedLangGraphSha: receipt.expectedLangGraphSha,
    workerServiceIdSha256: receipt.workerServiceIdSha256,
    acceptedAt: input.acceptedAt.toISOString(),
    providerCleanupProven: false as const, liveResourcesZeroProven: false as const,
  };
  return { ...proof, proofSha256: canonicalRequestHash(proof) };
}
