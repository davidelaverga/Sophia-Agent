import { z } from "zod";
import type { RecoveryControlRecord } from "./recovery-control.js";
import { recoverySettlementProof } from "./recovery-control.js";
import { parseRetainedOwnerDeath } from "./retained-owner-death.js";
import { parseRetainedD02ProviderSettlement } from "./retained-d02-provider.js";
import { parseExecutionOwnership } from "./execution-ownership.js";
import { assertRecoveryAttemptReceipt, type RecoveryAttemptIdentity } from "./recovery-attempt.js";
import { canonicalRequestHash } from "./security.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const coreSchema = z.object({ schema: z.literal("sophia.voice-lab.retained-d02-recovery.v1"),
  controlBindingSha256: hash, ownerDeathProofSha256: hash, providerProofSha256: hash,
  executionOwnershipProofSha256: hash, workerIdSha256: hash, browserLeaseEpoch: z.number().int().positive(),
  canonicalEventSha256: hash, canonicalReceiptSha256: hash, attemptId: hash,
  recoveredAt: z.string().datetime({ offset: true }), ready: z.literal(true),
}).strict();
export type RetainedD02Recovery = z.infer<typeof coreSchema> & { proofSha256: string };
export function parseRetainedD02Recovery(input: unknown): RetainedD02Recovery {
  const { proofSha256, ...core } = z.object({ proofSha256: hash }).passthrough().parse(input);
  const parsed = coreSchema.parse(core);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("D02_RECOVERY_DIGEST_INVALID");
  return { ...parsed, proofSha256 };
}
export function recoveryAttemptAuditHash(control: RecoveryControlRecord, attempt: RecoveryAttemptIdentity) {
  return canonicalRequestHash({ binding: control.binding, operation: "session:recover", control_version: control.version, attempt });
}

/** Requires trusted stored signature verifications AND the current authenticated
 * canonical attempt. Caller must atomically verify its prior capability audit,
 * exact lease ownership and CAS before persisting this result/releasing a lease. */
export function deriveRetainedD02Recovery(control: RecoveryControlRecord, event: unknown, attempt: RecoveryAttemptIdentity, now: Date): RetainedD02Recovery {
  const owner = parseRetainedOwnerDeath(control.d02OwnerDeath);
  const provider = parseRetainedD02ProviderSettlement(control.d02ProviderSettlement);
  const execution = parseExecutionOwnership(control.executionOwnership);
  if (control.binding.scenarioId !== "V-D02" || !control.browserAllocationEver
    || owner.controlBindingSha256 !== canonicalRequestHash(control.binding)
    || owner.ownershipProofSha256 !== execution.proofSha256
    || provider.ownerDeathProofSha256 !== owner.proofSha256) throw new Error("D02_RECOVERY_AUTHORITY_MISMATCH");
  assertRecoveryAttemptReceipt(event, attempt, now);
  // The current capability must have been minted after the independent facts.
  if (attempt.issuedAt * 1000 < Math.max(Date.parse(owner.acceptedAt), Date.parse(provider.observedAt))) throw new Error("D02_RECOVERY_ATTEMPT_PREDATES_AUTHORITY");
  const canonical = recoverySettlementProof(control.binding, event);
  const receipt = z.object({ payload: z.object({ receipt: z.object({ recovered_at: z.string() }).passthrough() }).passthrough() }).passthrough().parse(event).payload.receipt;
  const core = coreSchema.parse({ schema: "sophia.voice-lab.retained-d02-recovery.v1",
    controlBindingSha256: canonicalRequestHash(control.binding), ownerDeathProofSha256: owner.proofSha256,
    providerProofSha256: provider.proofSha256, executionOwnershipProofSha256: execution.proofSha256,
    workerIdSha256: execution.workerIdSha256, browserLeaseEpoch: execution.browserLeaseEpoch,
    canonicalEventSha256: canonical.eventSha256, canonicalReceiptSha256: canonical.receiptSha256,
    attemptId: attempt.attemptId, recoveredAt: receipt.recovered_at, ready: true });
  return { ...core, proofSha256: canonicalRequestHash(core) };
}
