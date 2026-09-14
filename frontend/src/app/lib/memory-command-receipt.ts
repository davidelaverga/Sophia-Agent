import { z } from 'zod';

// Explicit allowlist: provider text and arbitrary upstream diagnostics must not
// become browser receipt state. A receipt describes history, never eligibility.
const revision = z.number().int().safe().positive();
export const governanceReceiptSchema = z.object({
  event_id: z.string().uuid(),
  operation_id: z.string().min(1).max(200).nullable().optional(),
  event_type: z.string().min(1).max(100).nullable().optional(),
  resulting_lifecycle: z.enum(['active', 'forgotten', 'tombstoned']).nullable().optional(),
  candidate_id: z.string().min(1).nullable().optional(),
  memory_id: z.string().uuid().nullable().optional(),
  content_revision: revision.nullable().optional(),
  memory_governance_revision: revision.nullable().optional(),
  user_catalog_generation: z.number().int().safe().nonnegative(),
  user_revocation_epoch: z.number().int().safe().nonnegative(),
  idempotent_replay: z.boolean(),
  tombstone_id: z.string().uuid().nullable().optional(),
  status: z.enum(['accepted_and_fenced']).nullable().optional(),
  // Original fence-time obligation, not a current provider-cleanup attestation.
  provider_purge: z.literal('purge_pending').nullable().optional(),
});

export const commandReceiptSchema = governanceReceiptSchema.extend({
  operation_id: z.string().min(1).max(200),
  event_type: z.string().min(1).max(100),
  resulting_lifecycle: z.enum(['active', 'forgotten', 'tombstoned']).nullable().optional(),
});

export type GovernanceReceipt = z.infer<typeof governanceReceiptSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type ReviewReceiptReference = {
  candidate_id: string;
  idempotency_key: string;
  receipt: GovernanceReceipt;
};

export const commandStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('committed'), historical_result_only: z.literal(true), receipt: commandReceiptSchema }),
  z.object({ status: z.literal('not_found'), historical_result_only: z.literal(true), receipt: z.null().optional() }),
]);

export const reviewCommandReferenceSchema = z.object({
  candidateId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(200),
  action: z.enum(['approve', 'discard']),
});
export type ReviewCommandReference = z.infer<typeof reviewCommandReferenceSchema>;

// Validate on rehydration as well: old persisted drafts are not authority.
export function readPersistedReviewReferences(value: unknown): Record<string, ReviewCommandReference[]> {
  const parsed = z.object({ commandReferences: z.record(z.string().min(1).max(200), z.array(reviewCommandReferenceSchema)) }).safeParse(value);
  return parsed.success ? parsed.data.commandReferences : {};
}
