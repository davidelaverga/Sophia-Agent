import { z } from "zod";
import { recoverySettlementProof, type RecoveryControlRecord } from "./recovery-control.js";
import { parseVerifiedGenericOwnerLoss } from "./generic-owner-loss.js";
import { assertRecoveryAttemptReceipt, type RecoveryAttemptIdentity } from "./recovery-attempt.js";
import { canonicalRequestHash } from "./security.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const coreSchema = z.object({
  schema: z.literal("sophia.voice-lab.retained-generic-recovery.v1"),
  controlBindingSha256: hash, ownerLossProofSha256: hash,
  workerIdSha256: hash, browserLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canonicalEventSha256: hash, canonicalReceiptSha256: hash, attemptId: hash,
  recoveredAt: z.string().datetime({ offset: true }), ready: z.literal(true),
}).strict();
export type RetainedGenericRecovery = z.infer<typeof coreSchema> & { proofSha256: string };

export function parseRetainedGenericRecovery(raw: unknown, control?: RecoveryControlRecord): RetainedGenericRecovery {
  const { proofSha256, ...core } = z.object({ proofSha256: hash }).passthrough().parse(raw);
  const parsed = coreSchema.parse(core);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("GENERIC_RECOVERY_PROOF_INVALID");
  if (control) {
    const owner = parseVerifiedGenericOwnerLoss(control.genericOwnerLoss, control);
    if (parsed.controlBindingSha256 !== canonicalRequestHash(control.binding)
      || parsed.ownerLossProofSha256 !== owner.proofSha256 || parsed.workerIdSha256 !== owner.workerIdSha256
      || parsed.browserLeaseEpoch !== owner.browserLeaseEpoch) throw new Error("GENERIC_RECOVERY_BINDING_INVALID");
  }
  return { ...parsed, proofSha256 };
}

/** Does not manufacture provider closure. It joins verified worker loss with
 * the existing authenticated canonical response, which must independently
 * prove session/provider/auth terminal states and authoritative Builder zero.
 * The ledger must also verify the durable exact-attempt audit, lease and CAS. */
export function deriveRetainedGenericRecovery(control: RecoveryControlRecord, event: unknown, attempt: RecoveryAttemptIdentity, now: Date): RetainedGenericRecovery {
  if (control.binding.scenarioId === "V-D02" || control.contentPurgedAt === null) throw new Error("GENERIC_RECOVERY_SCOPE_INVALID");
  const owner = parseVerifiedGenericOwnerLoss(control.genericOwnerLoss, control);
  const issuedAt = attempt.issuedAt * 1000;
  if (issuedAt < Date.parse(owner.acceptedAt)) throw new Error("GENERIC_RECOVERY_ATTEMPT_PREDATES_AUTHORITY");
  if (!Number.isFinite(now.getTime()) || issuedAt > now.getTime() + 30000 || now.getTime() - issuedAt > 300000) throw new Error("GENERIC_RECOVERY_ATTEMPT_NOT_CURRENT");
  assertRecoveryAttemptReceipt(event, attempt, now);
  const canonical = recoverySettlementProof(control.binding, event);
  const recoveredAt = z.object({ payload: z.object({ receipt: z.object({ recovered_at: z.string() }).passthrough() }).passthrough() }).passthrough().parse(event).payload.receipt.recovered_at;
  const core = coreSchema.parse({ schema: "sophia.voice-lab.retained-generic-recovery.v1",
    controlBindingSha256: canonicalRequestHash(control.binding), ownerLossProofSha256: owner.proofSha256,
    workerIdSha256: owner.workerIdSha256, browserLeaseEpoch: owner.browserLeaseEpoch,
    canonicalEventSha256: canonical.eventSha256, canonicalReceiptSha256: canonical.receiptSha256,
    attemptId: attempt.attemptId, recoveredAt, ready: true });
  return { ...core, proofSha256: canonicalRequestHash(core) };
}
