import { z } from 'zod';

// Source recording is not memory approval or proof of current eligibility.
export const sourceUuid = z.string().regex(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/);
export const sourceActionKey = z.string().regex(/^[A-Za-z0-9_-]{8,200}$/);
// References to canonical association commands, not filenames or read permission.
// Absence means no selection; a present empty/malformed list must not downgrade.
export const sourceAttachmentKeysSchema = z.array(sourceActionKey).min(1).max(16)
  .refine(keys => new Set(keys).size === keys.length);
const epoch = z.number().int().safe().nonnegative();
export const sourceActionSchema = z.strictObject({
  thread_id: sourceUuid,
  message_id: sourceActionKey,
  command_key: sourceActionKey,
  expected_clear_epoch: epoch,
  // Never normalize an old request into a different logical action here.
  content: z.string().min(1).max(1048576).refine(value => value === value.trim()
    && !value.includes('\u0000') && new TextEncoder().encode(value).byteLength <= 1048576),
});
export const sourceBoundarySchema = z.strictObject({
  schema: z.literal('mem00.source-boundary.v1'),
  owner_id: z.string().min(1), session_id: sourceUuid, thread_id: sourceUuid,
  memory_clear_epoch: epoch, transcript_revision: epoch,
});
export const sourceProfileSchema = z.strictObject({
  schema: z.literal('mem00.source-profile.v1'), owner_id: z.string().min(1),
  session_id: sourceUuid, thread_id: sourceUuid, authority: z.enum(['governed', 'legacy']),
  boundary: sourceBoundarySchema.nullable(), observation_only: z.literal(true),
}).refine(value => value.authority === 'legacy' ? value.boundary === null
  : value.boundary !== null && value.boundary.owner_id === value.owner_id
    && value.boundary.session_id === value.session_id && value.boundary.thread_id === value.thread_id);
export const sourceActionReceiptSchema = z.strictObject({
  schema: z.literal('mem00.source-action.v1'),
  owner_id: z.string().min(1), session_id: sourceUuid, thread_id: sourceUuid,
  command_key: sourceActionKey, event_id: sourceUuid, message_id: sourceActionKey,
  source_row_id: sourceUuid, source_version: sourceUuid,
  sequence: z.number().int().safe().positive(),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/).refine(value => Number.isFinite(Date.parse(value))),
  memory_clear_epoch: epoch, transcript_revision: z.number().int().safe().positive(),
  content_ref: z.string().regex(/^hmac-sha256:source-action-content:[a-f0-9]{64}$/),
  historical_result_only: z.literal(true), idempotent_replay: z.boolean(),
  status: z.literal('source_recorded'), memory_approval: z.literal('not_granted'),
  current_extraction_eligibility: z.literal('not_verified_in_this_response'),
});
export const sourceActionStatusSchema = z.strictObject({
  schema: z.literal('mem00.source-action-status.v1'),
  owner_id: z.string().min(1), command_key: sourceActionKey,
  status: z.enum(['committed', 'not_found']), historical_result_only: z.literal(true),
  receipt: sourceActionReceiptSchema.nullable(),
}).refine(value => value.status === 'not_found' ? value.receipt === null
  : value.receipt !== null && value.receipt.owner_id === value.owner_id
    && value.receipt.command_key === value.command_key && value.receipt.idempotent_replay === true);

export type SourceAction = z.infer<typeof sourceActionSchema>;
export type SourceActionReceipt = z.infer<typeof sourceActionReceiptSchema>;
export type SourceProfile = z.infer<typeof sourceProfileSchema>;
