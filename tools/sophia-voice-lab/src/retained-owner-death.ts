import { z } from "zod";
import { canonicalRequestHash } from "./security.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime().refine(v => new Date(v).toISOString() === v);
const core = z.object({
  schema: z.literal("sophia.voice-lab.verified-d02-owner-death.v1"),
  controlBindingSha256: hash, ownershipProofSha256: hash, dispatchJournalProofSha256: hash,
  signedReceiptSha256: hash, authorityKeyId: z.string().min(1).max(160),
  authorityPublicKeySha256: hash, executionEpochSha256: hash, workerIdSha256: hash,
  browserLeaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  terminationRequestIdSha256: hash, settledAt: timestamp, acceptedAt: timestamp,
  actionAcceptedResponseSha256: hash, actionSettledSnapshotSha256: hash,
  lossEventSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), lossObservedAt: timestamp,
  providerCleanupProven: z.literal(false), liveResourcesZeroProven: z.literal(false),
}).strict().refine(v => Date.parse(v.settledAt) <= Date.parse(v.acceptedAt));
export type RetainedOwnerDeath = z.infer<typeof core> & { proofSha256: string };

/** Storage integrity only, never a substitute for checking the signed source. */
export function parseRetainedOwnerDeath(input: unknown): RetainedOwnerDeath {
  const { proofSha256, ...fields } = z.object({ proofSha256: hash }).passthrough().parse(input);
  const parsed = core.parse(fields);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("OWNER_DEATH_DIGEST_INVALID");
  return { ...parsed, proofSha256 };
}
